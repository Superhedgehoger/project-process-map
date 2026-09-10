import { createHash } from "node:crypto";
import { eventTopic, type DomainEvent, type OutboxMessage } from "../../domain/src/events.ts";
import type { PrincipalId, TenantId } from "../../domain/src/identity.ts";
import { isProjectManager } from "../../domain/src/project-access.ts";
import type { ProjectNode } from "../../domain/src/project-structure.ts";
import { canAccessProjectObjectDuringMigration, assertProjectSecurityStable } from "./access/project-security.ts";
import { ApplicationError } from "./errors.ts";
import type { CommandScope, Persistence, TransactionContext } from "./ports/persistence.ts";

export type CreateNodeCommand = Readonly<{
  tenantId: TenantId;
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  principalId: PrincipalId;
  projectId: string;
  nodeId: string;
  parentId: string | null;
  title: string;
  kind?: ProjectNode["kind"];
  securityDomainId: string | null;
  occurredAtUtc: string;
}>;

export type NodeCreatedPayload = Readonly<{
  nodeId: string;
  parentId: string | null;
  title: string;
  kind: ProjectNode["kind"];
}>;

export type CreateNodeResult = Readonly<{
  node: ProjectNode;
  event: DomainEvent<NodeCreatedPayload>;
  outbox: OutboxMessage;
  replayed: boolean;
}>;

export type CreateNodeFailurePoint = "after_aggregate" | "after_event" | "after_outbox" | "after_idempotency";

export async function executeCreateNode(
  persistence: Persistence,
  command: CreateNodeCommand,
  failurePoint?: CreateNodeFailurePoint,
): Promise<CreateNodeResult> {
  validate(command);
  if (command.securityDomainId !== null) {
    throw new ApplicationError(
      "SECURITY_DOMAIN_ASSIGNMENT_REQUIRES_COMMAND",
      "A sensitive root must be created through the security-domain command",
    );
  }
  const scope: CommandScope = {
    principalId: command.principalId,
    operation: "create_node",
    idempotencyKey: command.idempotencyKey,
  };
  const fingerprint = hash({
    projectId: command.projectId,
    nodeId: command.nodeId,
    parentId: command.parentId,
    title: command.title,
    kind: command.kind ?? "work_package",
    securityDomainId: command.securityDomainId,
  });

  return await persistence.transaction(command.tenantId, async (transaction) => {
    const inheritance = await resolveInheritance(transaction, command, new Date().toISOString());
    const previous = await transaction.receipts.get<Omit<CreateNodeResult, "replayed">>(scope);
    if (previous !== undefined) {
      if (previous.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
      if (previous.result.node.securityDomainId !== inheritance.securityDomainId
        || previous.result.node.securityEpoch !== inheritance.securityEpoch) {
        throw new ApplicationError("PARENT_NODE_NOT_FOUND", "Parent node not found");
      }
      return { ...structuredClone(previous.result), replayed: true };
    }
    if (await transaction.nodes.get(command.nodeId) !== undefined) throw new Error(`Aggregate already exists: ${command.nodeId}`);
    const projectSequence = await transaction.sequences.next(command.projectId);
    const node: ProjectNode = {
      tenantId: command.tenantId,
      id: command.nodeId,
      projectId: command.projectId,
      parentId: command.parentId,
      title: command.title,
      kind: command.kind ?? "work_package",
      securityDomainId: inheritance.securityDomainId,
      securityEpoch: inheritance.securityEpoch,
      version: 1,
      deletedAtUtc: null,
    };
    await transaction.nodes.insert(node);
    inject(failurePoint, "after_aggregate");
    const event: DomainEvent<NodeCreatedPayload> = {
      tenantId: command.tenantId,
      eventId: `evt:${command.commandId}`,
      projectId: command.projectId,
      projectSequence,
      aggregateType: "project_node",
      aggregateId: node.id,
      aggregateVersion: node.version,
      eventType: "project-map.node.created",
      schemaVersion: 1,
      actorPrincipalId: command.principalId,
      occurredAtUtc: command.occurredAtUtc,
      correlationId: command.correlationId,
      causationId: command.commandId,
      originalSecurityDomainId: node.securityDomainId,
      originalSecurityEpoch: node.securityEpoch,
      payload: { nodeId: node.id, parentId: node.parentId, title: node.title, kind: node.kind },
    };
    await transaction.events.append(event);
    inject(failurePoint, "after_event");
    const outbox: OutboxMessage = {
      tenantId: command.tenantId,
      id: `outbox:${event.eventId}`,
      eventId: event.eventId,
      topic: eventTopic(event),
      payload: event,
      state: "pending",
      availableAtUtc: command.occurredAtUtc,
      attempts: 0,
      maxAttempts: 8,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAtUtc: null,
      lastError: null,
      publishedAtUtc: null,
      createdAtUtc: command.occurredAtUtc,
    };
    await transaction.outbox.enqueue(outbox);
    inject(failurePoint, "after_outbox");
    const result = { node, event, outbox };
    await transaction.receipts.insert({ scope, fingerprint, result, createdAtUtc: command.occurredAtUtc });
    inject(failurePoint, "after_idempotency");
    return { ...result, replayed: false };
  });
}

async function resolveInheritance(
  transaction: TransactionContext,
  command: CreateNodeCommand,
  authorizationAtUtc: string,
): Promise<Readonly<{ securityDomainId: string | null; securityEpoch: number }>> {
  if (command.parentId === null) {
    await assertProjectSecurityStable(transaction, command.projectId);
    return { securityDomainId: null, securityEpoch: 1 };
  }
  const parent = await transaction.nodes.get(command.parentId);
  if (parent === undefined || parent.projectId !== command.projectId || parent.deletedAtUtc !== null) {
    throw new ApplicationError("PARENT_NODE_NOT_FOUND", "Parent node not found");
  }
  if (parent.securityDomainId === null) {
    await assertProjectSecurityStable(transaction, command.projectId);
    return { securityDomainId: null, securityEpoch: 1 };
  }

  const principal = await transaction.principals.get(command.principalId);
  const membership = await transaction.memberships.get(command.projectId, command.principalId);
  const domain = await transaction.securityDomains.get(parent.securityDomainId);
  const root = domain === undefined ? undefined : await transaction.nodes.get(domain.rootNodeId);
  if (principal?.status !== "active" || principal.kind !== "user" || !isProjectManager(membership)
    || domain === undefined || domain.projectId !== command.projectId || domain.deletedAtUtc !== null
    || domain.parentSecurityDomainId !== null || root === undefined || root.projectId !== command.projectId
    || root.deletedAtUtc !== null || root.securityDomainId !== domain.id
    || parent.securityEpoch !== root.securityEpoch
    || !await canAccessProjectObjectDuringMigration(
      transaction, membership, command.principalId, {
        projectId: command.projectId,
        ownerNodeId: parent.id,
        securityDomainId: parent.securityDomainId,
        securityEpoch: parent.securityEpoch,
      }, "edit", authorizationAtUtc,
    )) {
    throw new ApplicationError("PARENT_NODE_NOT_FOUND", "Parent node not found");
  }
  await assertProjectSecurityStable(transaction, command.projectId);
  return { securityDomainId: domain.id, securityEpoch: parent.securityEpoch };
}

function validate(command: CreateNodeCommand): void {
  for (const [name, value] of Object.entries({
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId,
    principalId: command.principalId,
    projectId: command.projectId,
    nodeId: command.nodeId,
    title: command.title,
  })) if (String(value).trim().length === 0) throw new Error(`${name} is required`);
  if (!command.occurredAtUtc.endsWith("Z") || Number.isNaN(Date.parse(command.occurredAtUtc))) {
    throw new Error("occurredAtUtc must be a valid UTC timestamp");
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function inject(expected: CreateNodeFailurePoint | undefined, actual: CreateNodeFailurePoint): void {
  if (expected === actual) throw new Error(`Injected failure: ${actual}`);
}
