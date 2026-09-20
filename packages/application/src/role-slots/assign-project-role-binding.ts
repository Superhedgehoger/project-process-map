import { createHash } from "node:crypto";
import type { PrincipalId, TenantId } from "../../../domain/src/identity.ts";
import { isCanonicalUtcTimestamp } from "../../../domain/src/security-access.ts";
import { assertValidSlotKey, normalizeCandidateIds } from "../../../domain/src/role-slots.ts";
import { ApplicationError } from "../errors.ts";
import type {
  AssignProjectRoleBindingCommand,
  AssignProjectRoleBindingFailurePoint,
  AssignProjectRoleBindingResult,
  Persistence,
  TransactionContext,
} from "../ports/persistence.ts";

export async function executeAssignProjectRoleBinding(
  persistence: Persistence,
  command: AssignProjectRoleBindingCommand,
  failurePoint?: AssignProjectRoleBindingFailurePoint,
): Promise<AssignProjectRoleBindingResult> {
  return await persistence.executeAssignProjectRoleBinding(command, failurePoint);
}

export class AssignProjectRoleBindingHandler {
  readonly #persistence: Persistence;

  constructor(persistence: Persistence) {
    this.#persistence = persistence;
  }

  execute(
    command: AssignProjectRoleBindingCommand,
    failurePoint?: AssignProjectRoleBindingFailurePoint,
  ): Promise<AssignProjectRoleBindingResult> {
    return executeAssignProjectRoleBinding(this.#persistence, command, failurePoint);
  }
}

export function validateAssignProjectRoleBinding(command: AssignProjectRoleBindingCommand): void {
  for (const [name, value] of Object.entries({
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId,
    principalId: command.principalId,
    projectId: command.projectId,
    slotKey: command.slotKey,
  })) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${name} is required`);
    }
  }

  if (
    typeof command.expectedVersion !== "number" ||
    !Number.isInteger(command.expectedVersion) ||
    command.expectedVersion < 0
  ) {
    throw new Error("expectedVersion must be an integer >= 0");
  }

  if (!isCanonicalUtcTimestamp(command.occurredAtUtc)) {
    throw new Error("occurredAtUtc must be a valid canonical UTC timestamp");
  }

  try {
    assertValidSlotKey(command.slotKey);
  } catch (error) {
    throw new ApplicationError("INVALID_ROLE_SLOT", `Invalid role slot key: ${command.slotKey}`);
  }

  if (!Array.isArray(command.principalIds)) {
    throw new Error("principalIds must be an array");
  }

  for (const candidateId of command.principalIds) {
    if (typeof candidateId !== "string" || candidateId.trim().length === 0) {
      throw new ApplicationError("INVALID_ROLE_BINDING_CANDIDATE", "Candidate principalId must be non-empty string");
    }
  }
}

export function hashRoleBindingPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function injectRoleBindingFailure(
  expected: AssignProjectRoleBindingFailurePoint | undefined,
  actual: AssignProjectRoleBindingFailurePoint,
): void {
  if (expected === actual) throw new Error(`Injected failure: ${actual}`);
}


export async function assertEligibleRoleBindingCandidate(
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
    throw new ApplicationError("INVALID_ROLE_BINDING_CANDIDATE", `Candidate is not eligible: ${candidatePrincipalId}`);
  }
}
