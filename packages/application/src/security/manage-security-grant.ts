import { createHash } from "node:crypto";
import { eventTopic, type DomainEvent, type OutboxMessage } from "../../../domain/src/events.ts";
import type { PrincipalId, TenantId } from "../../../domain/src/identity.ts";
import { isProjectManager } from "../../../domain/src/project-access.ts";
import type {
  SecurityCapability,
  SecurityDomain,
  SecurityGrant,
  SecurityGrantAuditAction,
  SecurityGrantAuditEntry,
} from "../../../domain/src/security-access.ts";
import { isCanonicalUtcTimestamp } from "../../../domain/src/security-access.ts";
import { assertProjectSecurityStable, canAccessProjectObject } from "../access/project-security.ts";
import { ApplicationError } from "../errors.ts";
import type { CommandScope, Persistence, TransactionContext } from "../ports/persistence.ts";

export type ManageSecurityGrantCommand = Readonly<{
  tenantId: TenantId;
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  principalId: PrincipalId;
  projectId: string;
  securityDomainId: string;
  targetPrincipalId: PrincipalId;
  action: "set" | "revoke";
  capability: SecurityCapability | null;
  expiresAtUtc: string | null;
  expectedGrantVersion: number | null;
  expectedDomainVersion: number;
  reason: string;
  occurredAtUtc: string;
}>;

export type SecurityGrantView = Readonly<{
  securityDomainId: string;
  targetPrincipalId: PrincipalId;
  capability: SecurityCapability;
  status: SecurityGrant["status"];
  expiresAtUtc: string | null;
  grantVersion: number;
  permissionVersion: number;
  domainVersion: number;
}>;

export type ManageSecurityGrantResult = Readonly<{ value: SecurityGrantView; replayed: boolean }>;
export type ManageSecurityGrantFailurePoint = "after_state" | "after_audit" | "after_event" | "after_outbox" | "after_receipt";

export class ManageSecurityGrantHandler {
  readonly #persistence: Persistence;

  constructor(persistence: Persistence) {
    this.#persistence = persistence;
  }

  async execute(
    command: ManageSecurityGrantCommand,
    failurePoint?: ManageSecurityGrantFailurePoint,
  ): Promise<ManageSecurityGrantResult> {
    validate(command);
    const scope: CommandScope = {
      principalId: command.principalId,
      operation: "manage_security_grant",
      idempotencyKey: command.idempotencyKey,
    };
    const fingerprint = hash({
      projectId: command.projectId,
      securityDomainId: command.securityDomainId,
      targetPrincipalId: command.targetPrincipalId,
      action: command.action,
      capability: command.capability,
      expiresAtUtc: command.expiresAtUtc,
      expectedGrantVersion: command.expectedGrantVersion,
      expectedDomainVersion: command.expectedDomainVersion,
      reason: command.reason.trim(),
    });

    return await this.#persistence.transaction(command.tenantId, async (transaction) => {
      const authorizationAtUtc = new Date().toISOString();
      const authorization = await authorizedDomain(transaction, command, authorizationAtUtc);
      const domain = authorization.domain;
      await assertProjectSecurityStable(transaction, command.projectId);
      await assertEligibleTarget(transaction, command);
      const previousReceipt = await transaction.receipts.get<SecurityGrantView>(scope);
      if (previousReceipt !== undefined) {
        if (previousReceipt.fingerprint !== fingerprint) throw new ApplicationError(
          "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
          "The idempotency key was already used with a different payload",
        );
        return { value: structuredClone(previousReceipt.result), replayed: true };
      }
      if (command.action === "set" && command.expiresAtUtc !== null
        && Date.parse(command.expiresAtUtc) <= Date.parse(authorizationAtUtc)) {
        throw new ApplicationError("VALIDATION_FAILED", "expiresAtUtc must be in the future");
      }
      if (domain.version !== command.expectedDomainVersion) throw new ApplicationError(
        "SECURITY_DOMAIN_VERSION_CONFLICT", "Security domain version conflict",
      );
      const current = await transaction.securityGrants.get(domain.id, command.targetPrincipalId);
      assertGrantVersion(current, command.expectedGrantVersion);
      if (command.action === "revoke" && current === undefined) throw new ApplicationError(
        "SECURITY_GRANT_VERSION_CONFLICT", "Security grant does not exist",
      );
      const updatedGrant = apply(command, current);
      const updatedDomain: SecurityDomain = {
        ...domain,
        permissionVersion: domain.permissionVersion + 1,
        version: domain.version + 1,
      };
      try {
        await transaction.securityGrants.saveWithDomainVersion(
          updatedGrant, command.expectedGrantVersion, updatedDomain, domain.version,
        );
      } catch (error) {
        throw stablePersistenceError(error);
      }
      inject(failurePoint, "after_state");
      const audit = auditFor(command, current, updatedGrant, updatedDomain.permissionVersion);
      await transaction.securityGrantAudits.append(audit);
      inject(failurePoint, "after_audit");
      const event = await appendEvent(
        transaction, command, updatedDomain, authorization.securityEpoch, audit.action,
      );
      inject(failurePoint, "after_event");
      await transaction.outbox.enqueue(outboxFor(event));
      inject(failurePoint, "after_outbox");
      const value = view(updatedGrant, updatedDomain);
      await transaction.receipts.insert({ scope, fingerprint, result: value, createdAtUtc: command.occurredAtUtc });
      inject(failurePoint, "after_receipt");
      return { value, replayed: false };
    });
  }
}

async function authorizedDomain(
  transaction: TransactionContext,
  command: ManageSecurityGrantCommand,
  authorizationAtUtc: string,
): Promise<Readonly<{ domain: SecurityDomain; securityEpoch: number }>> {
  const principal = await transaction.principals.get(command.principalId);
  const membership = await transaction.memberships.get(command.projectId, command.principalId);
  const domain = await transaction.securityDomains.get(command.securityDomainId);
  const rootNode = domain === undefined ? undefined : await transaction.nodes.get(domain.rootNodeId);
  if (principal?.status !== "active" || principal.kind !== "user" || !isProjectManager(membership)
    || domain === undefined || domain.projectId !== command.projectId
    || domain.deletedAtUtc !== null || domain.parentSecurityDomainId !== null
    || rootNode === undefined || rootNode.projectId !== command.projectId
    || rootNode.securityDomainId !== domain.id
    || !await canAccessProjectObject(
      transaction, membership, command.principalId, command.projectId,
      command.securityDomainId, "manage_access", authorizationAtUtc,
    )) throw new ApplicationError("NODE_NOT_FOUND", "Security domain not found");
  return { domain, securityEpoch: rootNode.securityEpoch };
}

async function assertEligibleTarget(
  transaction: TransactionContext,
  command: ManageSecurityGrantCommand,
): Promise<void> {
  const principal = await transaction.principals.get(command.targetPrincipalId);
  const membership = await transaction.memberships.get(command.projectId, command.targetPrincipalId);
  if (principal?.status !== "active" || principal.kind !== "user"
    || membership?.status !== "active" || membership.projectId !== command.projectId) {
    throw new ApplicationError("SECURITY_GRANT_TARGET_INELIGIBLE", "The target principal is not eligible");
  }
}

function assertGrantVersion(grant: SecurityGrant | undefined, expected: number | null): void {
  if (expected === null ? grant !== undefined : grant?.version !== expected) {
    throw new ApplicationError("SECURITY_GRANT_VERSION_CONFLICT", "Security grant version conflict");
  }
}

function apply(command: ManageSecurityGrantCommand, current: SecurityGrant | undefined): SecurityGrant {
  const capability = command.action === "set" ? command.capability : current?.capability;
  if (capability === null || capability === undefined) throw new ApplicationError("VALIDATION_FAILED", "capability is required");
  return {
    tenantId: command.tenantId,
    id: current?.id ?? `grant:${command.securityDomainId}:${command.targetPrincipalId}`,
    securityDomainId: command.securityDomainId,
    principalId: command.targetPrincipalId,
    capability,
    status: command.action === "revoke" ? "revoked" : "active",
    expiresAtUtc: command.action === "revoke" ? current?.expiresAtUtc ?? null : command.expiresAtUtc,
    grantedByPrincipalId: command.principalId,
    reason: command.reason.trim(),
    version: (current?.version ?? 0) + 1,
    createdAtUtc: current?.createdAtUtc ?? command.occurredAtUtc,
    updatedAtUtc: command.occurredAtUtc,
  };
}

function auditFor(
  command: ManageSecurityGrantCommand,
  previous: SecurityGrant | undefined,
  grant: SecurityGrant,
  permissionVersion: number,
): SecurityGrantAuditEntry {
  const action: SecurityGrantAuditAction = grant.status === "revoked" ? "revoked" : previous === undefined ? "granted" : "changed";
  return {
    tenantId: command.tenantId,
    id: `audit:${command.commandId}`,
    projectId: command.projectId,
    securityDomainId: command.securityDomainId,
    actorPrincipalId: command.principalId,
    targetPrincipalId: command.targetPrincipalId,
    action,
    previousCapability: previous?.capability ?? null,
    capability: grant.capability,
    previousStatus: previous?.status ?? null,
    status: grant.status,
    permissionVersion,
    occurredAtUtc: command.occurredAtUtc,
  };
}

async function appendEvent(
  transaction: TransactionContext,
  command: ManageSecurityGrantCommand,
  domain: SecurityDomain,
  securityEpoch: number,
  action: SecurityGrantAuditAction,
): Promise<DomainEvent> {
  const event: DomainEvent = {
    tenantId: command.tenantId,
    eventId: `evt:${command.commandId}`,
    projectId: command.projectId,
    projectSequence: await transaction.sequences.next(command.projectId),
    aggregateType: "security_domain",
    aggregateId: domain.id,
    aggregateVersion: domain.version,
    eventType: `project-map.security-grant.${action}`,
    schemaVersion: 1,
    actorPrincipalId: command.principalId,
    occurredAtUtc: command.occurredAtUtc,
    correlationId: command.correlationId,
    causationId: command.commandId,
    originalSecurityDomainId: domain.id,
    originalSecurityEpoch: securityEpoch,
    payload: { action, permissionVersion: domain.permissionVersion },
  };
  await transaction.events.append(event);
  return event;
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

function view(grant: SecurityGrant, domain: SecurityDomain): SecurityGrantView {
  return {
    securityDomainId: domain.id,
    targetPrincipalId: grant.principalId,
    capability: grant.capability,
    status: grant.status,
    expiresAtUtc: grant.expiresAtUtc,
    grantVersion: grant.version,
    permissionVersion: domain.permissionVersion,
    domainVersion: domain.version,
  };
}

function validate(command: ManageSecurityGrantCommand): void {
  for (const [name, value] of Object.entries({
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId,
    principalId: command.principalId,
    projectId: command.projectId,
    securityDomainId: command.securityDomainId,
    targetPrincipalId: command.targetPrincipalId,
    reason: command.reason,
  })) if (String(value).trim().length === 0) throw new ApplicationError("VALIDATION_FAILED", `${name} is required`);
  if (!Number.isSafeInteger(command.expectedDomainVersion) || command.expectedDomainVersion <= 0) {
    throw new ApplicationError("VALIDATION_FAILED", "expectedDomainVersion must be a positive integer");
  }
  if (command.expectedGrantVersion !== null
    && (!Number.isSafeInteger(command.expectedGrantVersion) || command.expectedGrantVersion <= 0)) {
    throw new ApplicationError("VALIDATION_FAILED", "expectedGrantVersion must be null or a positive integer");
  }
  if (command.action === "set" && command.capability === null) throw new ApplicationError("VALIDATION_FAILED", "capability is required");
  if (command.action === "revoke" && (command.capability !== null || command.expiresAtUtc !== null)) {
    throw new ApplicationError("VALIDATION_FAILED", "revoke does not accept capability or expiry");
  }
  if (command.expiresAtUtc !== null
    && !isCanonicalUtcTimestamp(command.expiresAtUtc)) {
    throw new ApplicationError("VALIDATION_FAILED", "expiresAtUtc must be UTC");
  }
  if (!command.occurredAtUtc.endsWith("Z") || Number.isNaN(Date.parse(command.occurredAtUtc))) {
    throw new ApplicationError("VALIDATION_FAILED", "occurredAtUtc must be UTC");
  }
}

function inject(expected: ManageSecurityGrantFailurePoint | undefined, actual: ManageSecurityGrantFailurePoint): void {
  if (expected === actual) throw new Error(`Injected failure: ${actual}`);
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stablePersistenceError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  if (error.message === "SECURITY_DOMAIN_LAST_ADMINISTRATOR") return new ApplicationError(
    "SECURITY_DOMAIN_LAST_ADMINISTRATOR", "A security domain must retain a permanent administrator",
  );
  if (error.message === "SECURITY_GRANT_VERSION_CONFLICT") return new ApplicationError(
    "SECURITY_GRANT_VERSION_CONFLICT", "Security grant version conflict",
  );
  if (error.message === "SECURITY_DOMAIN_VERSION_CONFLICT") return new ApplicationError(
    "SECURITY_DOMAIN_VERSION_CONFLICT", "Security domain version conflict",
  );
  return error;
}
