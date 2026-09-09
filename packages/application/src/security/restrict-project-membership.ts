import { createHash } from "node:crypto";
import { eventTopic, type DomainEvent, type OutboxMessage } from "../../../domain/src/events.ts";
import type { PrincipalId, TenantId } from "../../../domain/src/identity.ts";
import {
  isProjectManager,
  projectMembershipRestrictionEventSchemas,
  type ProjectMembership,
  type ProjectMembershipRestrictionAction,
  type ProjectMembershipSecurityAuditEntry,
} from "../../../domain/src/project-access.ts";
import { isCanonicalUtcTimestamp, type SecurityDomain } from "../../../domain/src/security-access.ts";
import { assertProjectSecurityStable } from "../access/project-security.ts";
import { ApplicationError } from "../errors.ts";
import type { CommandScope, Persistence, TransactionContext } from "../ports/persistence.ts";

export type RestrictProjectMembershipCommand = Readonly<{
  tenantId: TenantId;
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  principalId: PrincipalId;
  projectId: string;
  targetPrincipalId: PrincipalId;
  action: "demote" | "revoke";
  expectedMembershipVersion: number;
  reason: string;
  occurredAtUtc: string;
}>;

export type ProjectMembershipRestrictionView = Readonly<{
  targetPrincipalId: PrincipalId;
  role: ProjectMembership["role"];
  status: ProjectMembership["status"];
  membershipVersion: number;
}>;

export type RestrictProjectMembershipResult = Readonly<{
  value: ProjectMembershipRestrictionView;
  replayed: boolean;
}>;

export type RestrictProjectMembershipFailurePoint =
  | "after_state"
  | "after_audit"
  | "after_event"
  | "after_outbox"
  | "after_receipt";

export class RestrictProjectMembershipHandler {
  readonly #persistence: Persistence;

  constructor(persistence: Persistence) {
    this.#persistence = persistence;
  }

  async execute(
    command: RestrictProjectMembershipCommand,
    failurePoint?: RestrictProjectMembershipFailurePoint,
  ): Promise<RestrictProjectMembershipResult> {
    validate(command);
    const scope: CommandScope = {
      principalId: command.principalId,
      operation: "restrict_project_membership",
      idempotencyKey: command.idempotencyKey,
    };
    const fingerprint = hash({
      projectId: command.projectId,
      targetPrincipalId: command.targetPrincipalId,
      action: command.action,
      expectedMembershipVersion: command.expectedMembershipVersion,
      reason: command.reason.trim(),
    });

    return await this.#persistence.transaction(command.tenantId, async (transaction) => {
      const authorizationAtUtc = new Date().toISOString();
      await authorize(transaction, command);
      await assertProjectSecurityStable(transaction, command.projectId);
      const current = await requiredTarget(transaction, command);
      const previousReceipt = await transaction.receipts.get<ProjectMembershipRestrictionView>(scope);
      if (previousReceipt !== undefined) {
        if (previousReceipt.fingerprint !== fingerprint) throw new ApplicationError(
          "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
          "The idempotency key was already used with a different payload",
        );
        if (current.principalId !== previousReceipt.result.targetPrincipalId
          || current.role !== previousReceipt.result.role
          || current.status !== previousReceipt.result.status
          || current.version !== previousReceipt.result.membershipVersion) {
          throw new ApplicationError("PROJECT_MEMBERSHIP_VERSION_CONFLICT", "Project membership version conflict");
        }
        return { value: structuredClone(previousReceipt.result), replayed: true };
      }
      if (current.status !== "active") throw new ApplicationError(
        "PROJECT_MEMBERSHIP_TARGET_INELIGIBLE", "The target principal is not eligible",
      );
      if (current.version !== command.expectedMembershipVersion) throw new ApplicationError(
        "PROJECT_MEMBERSHIP_VERSION_CONFLICT", "Project membership version conflict",
      );
      const updated = apply(command, current);
      let affectedDomains: SecurityDomain[];
      try {
        affectedDomains = await transaction.memberships.restrictWithSecurityDomains(
          updated, command.expectedMembershipVersion, authorizationAtUtc,
        );
      } catch (error) {
        throw stablePersistenceError(error);
      }
      inject(failurePoint, "after_state");
      await transaction.membershipSecurityAudits.append(auditFor(command, current, updated));
      inject(failurePoint, "after_audit");
      const events = await appendEvents(transaction, command, updated, affectedDomains);
      inject(failurePoint, "after_event");
      for (const event of events) await transaction.outbox.enqueue(outboxFor(event));
      inject(failurePoint, "after_outbox");
      const value = view(updated);
      await transaction.receipts.insert({ scope, fingerprint, result: value, createdAtUtc: command.occurredAtUtc });
      inject(failurePoint, "after_receipt");
      return { value, replayed: false };
    });
  }
}

async function authorize(
  transaction: TransactionContext,
  command: RestrictProjectMembershipCommand,
): Promise<void> {
  const principal = await transaction.principals.get(command.principalId);
  const membership = await transaction.memberships.get(command.projectId, command.principalId);
  if (principal?.status !== "active" || principal.kind !== "user" || !isProjectManager(membership)) {
    throw new ApplicationError("NODE_NOT_FOUND", "Project membership not found");
  }
}

async function requiredTarget(
  transaction: TransactionContext,
  command: RestrictProjectMembershipCommand,
): Promise<ProjectMembership> {
  const principal = await transaction.principals.get(command.targetPrincipalId);
  const membership = await transaction.memberships.get(command.projectId, command.targetPrincipalId);
  if (principal?.status !== "active" || principal.kind !== "user" || membership === undefined) {
    throw new ApplicationError("PROJECT_MEMBERSHIP_TARGET_INELIGIBLE", "The target principal is not eligible");
  }
  return membership;
}

function apply(command: RestrictProjectMembershipCommand, current: ProjectMembership): ProjectMembership {
  if (command.action === "demote" && current.role !== "project_manager") throw new ApplicationError(
    "PROJECT_MEMBERSHIP_TRANSITION_INVALID", "Only an active project manager can be demoted",
  );
  return {
    ...current,
    role: command.action === "demote" ? "member" : current.role,
    status: command.action === "revoke" ? "revoked" : current.status,
    version: current.version + 1,
    updatedAtUtc: command.occurredAtUtc,
  };
}

function auditFor(
  command: RestrictProjectMembershipCommand,
  previous: ProjectMembership,
  membership: ProjectMembership,
): ProjectMembershipSecurityAuditEntry {
  const action: ProjectMembershipRestrictionAction = command.action === "demote" ? "demoted" : "revoked";
  return {
    tenantId: command.tenantId,
    id: `audit:${command.commandId}`,
    projectId: command.projectId,
    actorPrincipalId: command.principalId,
    targetPrincipalId: command.targetPrincipalId,
    action,
    previousRole: previous.role,
    role: membership.role,
    previousStatus: previous.status,
    status: membership.status,
    occurredAtUtc: command.occurredAtUtc,
  };
}

async function appendEvents(
  transaction: TransactionContext,
  command: RestrictProjectMembershipCommand,
  membership: ProjectMembership,
  affectedDomains: SecurityDomain[],
): Promise<DomainEvent[]> {
  const action: ProjectMembershipRestrictionAction = command.action === "demote" ? "demoted" : "revoked";
  const domains = [...affectedDomains].sort((left, right) => left.id.localeCompare(right.id));
  if (domains.length === 0) {
    const event = eventFor(command, membership, action, null, null, 1, await transaction.sequences.next(command.projectId));
    await transaction.events.append(event);
    return [event];
  }
  const events: DomainEvent[] = [];
  for (const domain of domains) {
    const root = await transaction.nodes.get(domain.rootNodeId);
    if (root === undefined || root.projectId !== command.projectId || root.securityDomainId !== domain.id) {
      throw new ApplicationError("NODE_NOT_FOUND", "Security domain not found");
    }
    const event = eventFor(
      command, membership, action, domain, domain.permissionVersion, root.securityEpoch,
      await transaction.sequences.next(command.projectId),
    );
    await transaction.events.append(event);
    events.push(event);
  }
  return events;
}

function eventFor(
  command: RestrictProjectMembershipCommand,
  membership: ProjectMembership,
  action: ProjectMembershipRestrictionAction,
  domain: SecurityDomain | null,
  permissionVersion: number | null,
  securityEpoch: number,
  projectSequence: number,
): DomainEvent {
  const suffix = domain === null ? "" : `:${hash(domain.id).slice(0, 16)}`;
  return {
    tenantId: command.tenantId,
    eventId: `evt:${command.commandId}${suffix}`,
    projectId: command.projectId,
    projectSequence,
    aggregateType: domain === null ? "project_membership" : "security_domain",
    aggregateId: domain?.id ?? `project-membership:${hash([command.projectId, membership.principalId])}`,
    aggregateVersion: domain?.version ?? membership.version,
    eventType: projectMembershipRestrictionEventSchemas[action].eventType,
    schemaVersion: projectMembershipRestrictionEventSchemas[action].schemaVersion,
    actorPrincipalId: command.principalId,
    occurredAtUtc: command.occurredAtUtc,
    correlationId: command.correlationId,
    causationId: command.commandId,
    originalSecurityDomainId: domain?.id ?? null,
    originalSecurityEpoch: securityEpoch,
    payload: permissionVersion === null ? { action } : { action, permissionVersion },
  };
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

function view(membership: ProjectMembership): ProjectMembershipRestrictionView {
  return {
    targetPrincipalId: membership.principalId,
    role: membership.role,
    status: membership.status,
    membershipVersion: membership.version,
  };
}

function validate(command: RestrictProjectMembershipCommand): void {
  for (const [name, value] of Object.entries({
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId,
    principalId: command.principalId,
    projectId: command.projectId,
    targetPrincipalId: command.targetPrincipalId,
    reason: command.reason,
  })) if (String(value).trim().length === 0) throw new ApplicationError("VALIDATION_FAILED", `${name} is required`);
  if (!Number.isSafeInteger(command.expectedMembershipVersion) || command.expectedMembershipVersion <= 0) {
    throw new ApplicationError("VALIDATION_FAILED", "expectedMembershipVersion must be a positive integer");
  }
  if (command.action !== "demote" && command.action !== "revoke") {
    throw new ApplicationError("VALIDATION_FAILED", "action must be demote or revoke");
  }
  if (!isCanonicalUtcTimestamp(command.occurredAtUtc)) {
    throw new ApplicationError("VALIDATION_FAILED", "occurredAtUtc must be canonical UTC");
  }
}

function inject(
  expected: RestrictProjectMembershipFailurePoint | undefined,
  actual: RestrictProjectMembershipFailurePoint,
): void {
  if (expected === actual) throw new Error(`Injected failure: ${actual}`);
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stablePersistenceError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const stable = new Set([
    "PROJECT_MEMBERSHIP_VERSION_CONFLICT",
    "PROJECT_MEMBERSHIP_TRANSITION_INVALID",
    "PROJECT_MEMBERSHIP_TARGET_INELIGIBLE",
    "SECURITY_DOMAIN_LAST_ADMINISTRATOR",
  ]);
  if (stable.has(error.message)) return new ApplicationError(
    error.message as "PROJECT_MEMBERSHIP_VERSION_CONFLICT"
      | "PROJECT_MEMBERSHIP_TRANSITION_INVALID"
      | "PROJECT_MEMBERSHIP_TARGET_INELIGIBLE"
      | "SECURITY_DOMAIN_LAST_ADMINISTRATOR",
    error.message,
  );
  return error;
}
