import { createHash } from "node:crypto";
import type { PrincipalId, TenantId } from "../../domain/src/identity.ts";
import { isProjectManager } from "../../domain/src/project-access.ts";
import { canAccessProjectObjectDuringMigration, assertProjectSecurityStable } from "./access/project-security.ts";
import { ApplicationError } from "./errors.ts";
import type {
  AssignNodeLeaderCommand,
  AssignNodeLeaderFailurePoint,
  AssignNodeLeaderResult,
  CreateNodeCommand,
  CreateNodeFailurePoint,
  CreateNodeResult,
  Persistence,
  TransactionContext,
} from "./ports/persistence.ts";

export type {
  AssignNodeLeaderCommand,
  AssignNodeLeaderFailurePoint,
  AssignNodeLeaderResult,
  CreateNodeCommand,
  CreateNodeFailurePoint,
  CreateNodeResult,
  NodeCreatedPayload,
  NodeLeaderAssignedPayload,
} from "./ports/persistence.ts";

export async function executeCreateNode(
  persistence: Persistence,
  command: CreateNodeCommand,
  failurePoint?: CreateNodeFailurePoint,
): Promise<CreateNodeResult> {
  return await persistence.executeCreateNode(command, failurePoint);
}

export async function executeAssignNodeLeader(
  persistence: Persistence,
  command: AssignNodeLeaderCommand,
  failurePoint?: AssignNodeLeaderFailurePoint,
): Promise<AssignNodeLeaderResult> {
  return await persistence.executeAssignNodeLeader(command, failurePoint);
}

export class CreateNodeHandler {
  readonly #persistence: Persistence;

  constructor(persistence: Persistence) {
    this.#persistence = persistence;
  }

  execute(command: CreateNodeCommand, failurePoint?: CreateNodeFailurePoint): Promise<CreateNodeResult> {
    return executeCreateNode(this.#persistence, command, failurePoint);
  }
}

export class AssignNodeLeaderHandler {
  readonly #persistence: Persistence;

  constructor(persistence: Persistence) {
    this.#persistence = persistence;
  }

  execute(command: AssignNodeLeaderCommand, failurePoint?: AssignNodeLeaderFailurePoint): Promise<AssignNodeLeaderResult> {
    return executeAssignNodeLeader(this.#persistence, command, failurePoint);
  }
}

export async function resolveInheritance(
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

export function validate(command: CreateNodeCommand): void {
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

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function inject(
  expected: CreateNodeFailurePoint | AssignNodeLeaderFailurePoint | undefined,
  actual: CreateNodeFailurePoint | AssignNodeLeaderFailurePoint,
): void {
  if (expected === actual) throw new Error(`Injected failure: ${actual}`);
}

export async function assertEligibleNodeLeader(
  transaction: TransactionContext,
  tenantId: TenantId,
  projectId: string,
  candidatePrincipalId: PrincipalId,
): Promise<void> {
  const principal = await transaction.principals.get(candidatePrincipalId);
  const membership = await transaction.memberships.get(projectId, candidatePrincipalId);
  if (
    principal === undefined ||
    principal.tenantId !== tenantId ||
    principal.status !== "active" ||
    principal.kind !== "user" ||
    membership === undefined ||
    membership.tenantId !== tenantId ||
    membership.projectId !== projectId ||
    membership.status !== "active"
  ) {
    throw new ApplicationError("INVALID_NODE_LEADER", "INVALID_NODE_LEADER");
  }
}

export function validateAssignLeader(command: AssignNodeLeaderCommand): void {
  for (const [name, value] of Object.entries({
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId,
    principalId: command.principalId,
    projectId: command.projectId,
    nodeId: command.nodeId,
  })) if (String(value).trim().length === 0) throw new Error(`${name} is required`);
  if (!command.occurredAtUtc.endsWith("Z") || Number.isNaN(Date.parse(command.occurredAtUtc))) {
    throw new Error("occurredAtUtc must be a valid UTC timestamp");
  }
  if (!Number.isInteger(command.expectedVersion) || command.expectedVersion <= 0) {
    throw new Error("expectedVersion must be a positive integer");
  }
}
