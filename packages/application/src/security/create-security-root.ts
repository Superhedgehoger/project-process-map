import { createHash } from "node:crypto";
import { eventTopic, type DomainEvent, type OutboxMessage } from "../../../domain/src/events.ts";
import type { PrincipalId, TenantId } from "../../../domain/src/identity.ts";
import { isProjectManager } from "../../../domain/src/project-access.ts";
import type { SecurityDomain, SecurityGrant } from "../../../domain/src/security-access.ts";
import { ApplicationError } from "../errors.ts";
import type { CommandScope, Persistence } from "../ports/persistence.ts";
import { assertProjectSecurityStable, canAccessProjectObject } from "../access/project-security.ts";

export type CreateSecurityRootCommand = Readonly<{
  tenantId: TenantId;
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  principalId: PrincipalId;
  projectId: string;
  nodeId: string;
  securityDomainId: string;
  expectedNodeVersion: number;
  reason: string;
  occurredAtUtc: string;
}>;

export type SecurityRootView = Readonly<{
  securityDomainId: string;
  rootNodeId: string;
  permissionVersion: number;
  creatorCapability: "manage_access";
  nodeVersion: number;
  securityEpoch: number;
}>;

export type CreateSecurityRootResult = Readonly<{ value: SecurityRootView; replayed: boolean }>;
export type CreateSecurityRootFailurePoint = "after_domain" | "after_grant" | "after_node" | "after_event" | "after_outbox" | "after_receipt";

export class CreateSecurityRootHandler {
  readonly #persistence: Persistence;

  constructor(persistence: Persistence) {
    this.#persistence = persistence;
  }

  async execute(
    command: CreateSecurityRootCommand,
    failurePoint?: CreateSecurityRootFailurePoint,
  ): Promise<CreateSecurityRootResult> {
    validate(command);
    const scope: CommandScope = {
      principalId: command.principalId,
      operation: "create_security_root",
      idempotencyKey: command.idempotencyKey,
    };
    const fingerprint = hash({
      projectId: command.projectId,
      nodeId: command.nodeId,
      securityDomainId: command.securityDomainId,
      expectedNodeVersion: command.expectedNodeVersion,
      reason: command.reason.trim(),
    });

    return await this.#persistence.transaction(command.tenantId, async (transaction) => {
      const membership = await transaction.memberships.get(command.projectId, command.principalId);
      const principal = await transaction.principals.get(command.principalId);
      if (!isProjectManager(membership) || principal?.status !== "active") {
        throw new ApplicationError("NODE_NOT_FOUND", "Node not found");
      }
      const node = await transaction.nodes.get(command.nodeId);
      if (node === undefined || node.projectId !== command.projectId || node.deletedAtUtc !== null) {
        throw new ApplicationError("NODE_NOT_FOUND", "Node not found");
      }
      const authorizationAtUtc = new Date().toISOString();
      if (node.securityDomainId !== null && !await canAccessProjectObject(
        transaction, membership, command.principalId, command.projectId,
        node.securityDomainId, "manage_access", authorizationAtUtc,
      )) throw new ApplicationError("NODE_NOT_FOUND", "Node not found");
      await assertProjectSecurityStable(transaction, command.projectId);

      const previous = await transaction.receipts.get<SecurityRootView>(scope);
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint) throw new ApplicationError(
          "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
          "The idempotency key was already used with a different payload",
        );
        return { value: structuredClone(previous.result), replayed: true };
      }
      if (node.version !== command.expectedNodeVersion) throw new ApplicationError("NODE_VERSION_CONFLICT", "Node version conflict");
      if (node.securityDomainId !== null || await transaction.securityDomains.getByRoot(command.projectId, node.id) !== undefined) {
        throw new ApplicationError("NODE_ALREADY_SENSITIVE", "Node is already a security root or belongs to a security domain");
      }
      if (await transaction.securityDomains.get(command.securityDomainId) !== undefined) {
        throw new ApplicationError("SECURITY_DOMAIN_ALREADY_EXISTS", "Security domain already exists");
      }
      const projectNodes = await transaction.nodes.listByProject(command.projectId);
      const hasDescendant = projectNodes.some((candidate) => candidate.parentId === node.id);
      const hasTask = (await transaction.tasks.listByNode(node.id)).length > 0;
      if (hasDescendant || hasTask || await transaction.assets.hasForNode(node.id)) {
        throw new ApplicationError(
          "SECURITY_ROOT_REQUIRES_EMPTY_LEAF",
          "This phase only supports making an empty leaf node sensitive",
        );
      }
      if (
        await transaction.nodes.hasSecurityDomainReference(command.securityDomainId)
        || await transaction.tasks.hasSecurityDomainReference(command.securityDomainId)
        || await transaction.assets.hasSecurityDomainReference(command.securityDomainId)
      ) {
        throw new ApplicationError("SECURITY_DOMAIN_ID_IN_USE", "Security domain ID is already referenced by legacy data");
      }

      const domain: SecurityDomain = {
        tenantId: command.tenantId,
        id: command.securityDomainId,
        projectId: command.projectId,
        rootNodeId: node.id,
        parentSecurityDomainId: null,
        permissionVersion: 1,
        version: 1,
        createdByPrincipalId: command.principalId,
        createdAtUtc: command.occurredAtUtc,
        deletedAtUtc: null,
      };
      const grant: SecurityGrant = {
        tenantId: command.tenantId,
        id: `grant:${command.securityDomainId}:${command.principalId}`,
        securityDomainId: command.securityDomainId,
        principalId: command.principalId,
        capability: "manage_access",
        status: "active",
        expiresAtUtc: null,
        grantedByPrincipalId: command.principalId,
        reason: command.reason.trim(),
        version: 1,
        createdAtUtc: command.occurredAtUtc,
        updatedAtUtc: command.occurredAtUtc,
      };
      await transaction.securityDomains.insert(domain);
      inject(failurePoint, "after_domain");
      await transaction.securityGrants.insert(grant);
      inject(failurePoint, "after_grant");
      const updatedNode = await transaction.nodes.assignSecurityDomain(
        node.id, command.projectId, domain.id, node.version,
      );
      inject(failurePoint, "after_node");

      const event: DomainEvent = {
        tenantId: command.tenantId,
        eventId: `evt:${command.commandId}`,
        projectId: command.projectId,
        projectSequence: await transaction.sequences.next(command.projectId),
        aggregateType: "security_domain",
        aggregateId: domain.id,
        aggregateVersion: domain.version,
        eventType: "project-map.security-domain.created",
        schemaVersion: 1,
        actorPrincipalId: command.principalId,
        occurredAtUtc: command.occurredAtUtc,
        correlationId: command.correlationId,
        causationId: command.commandId,
        originalSecurityDomainId: domain.id,
        originalSecurityEpoch: updatedNode.securityEpoch,
        payload: {
          securityDomainId: domain.id,
          rootNodeId: domain.rootNodeId,
          permissionVersion: domain.permissionVersion,
        },
      };
      await transaction.events.append(event);
      inject(failurePoint, "after_event");
      await transaction.outbox.enqueue(outboxFor(event));
      inject(failurePoint, "after_outbox");
      const value: SecurityRootView = {
        securityDomainId: domain.id,
        rootNodeId: domain.rootNodeId,
        permissionVersion: domain.permissionVersion,
        creatorCapability: "manage_access",
        nodeVersion: updatedNode.version,
        securityEpoch: updatedNode.securityEpoch,
      };
      await transaction.receipts.insert({ scope, fingerprint, result: value, createdAtUtc: command.occurredAtUtc });
      inject(failurePoint, "after_receipt");
      return { value, replayed: false };
    });
  }
}

function outboxFor(event: DomainEvent): OutboxMessage {
  return {
    tenantId: event.tenantId,
    id: `outbox:${event.eventId}`,
    eventId: event.eventId,
    topic: eventTopic(event),
    payload: event,
    state: "pending",
    availableAtUtc: event.occurredAtUtc,
    attempts: 0,
    maxAttempts: 8,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAtUtc: null,
    lastError: null,
    publishedAtUtc: null,
    createdAtUtc: event.occurredAtUtc,
  };
}

function validate(command: CreateSecurityRootCommand): void {
  for (const [name, value] of Object.entries({
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId,
    principalId: command.principalId,
    projectId: command.projectId,
    nodeId: command.nodeId,
    securityDomainId: command.securityDomainId,
    reason: command.reason,
  })) if (String(value).trim().length === 0) throw new ApplicationError("VALIDATION_FAILED", `${name} is required`);
  if (!Number.isSafeInteger(command.expectedNodeVersion) || command.expectedNodeVersion <= 0) {
    throw new ApplicationError("VALIDATION_FAILED", "expectedNodeVersion must be a positive integer");
  }
  if (!command.occurredAtUtc.endsWith("Z") || Number.isNaN(Date.parse(command.occurredAtUtc))) {
    throw new ApplicationError("VALIDATION_FAILED", "occurredAtUtc must be UTC");
  }
}

function inject(expected: CreateSecurityRootFailurePoint | undefined, actual: CreateSecurityRootFailurePoint): void {
  if (expected === actual) throw new Error(`Injected failure: ${actual}`);
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
