import type { ExternalReference } from "./external-reference.ts";
import type { TenantId } from "./identity.ts";

export type IntegrationOperationType = "asset.ingest" | "collaboration.task.project" | "collaboration.asset.project" | "blob.delete";
export type IntegrationOperationState = "planned" | "running" | "retryable" | "completed" | "compensated" | "recovery_required";

export type IntegrationOperation = Readonly<{
  tenantId: TenantId;
  id: string;
  operationType: IntegrationOperationType;
  subjectType: "task" | "asset";
  subjectId: string;
  fingerprint: string;
  state: IntegrationOperationState;
  currentStep: string;
  attempts: number;
  externalRequestId: string;
  externalReference: ExternalReference | null;
  expectedSyncWatermark: string | null;
  nextAttemptAtUtc: string | null;
  deadlineAtUtc: string;
  lastError: string | null;
  version: number;
  createdAtUtc: string;
  updatedAtUtc: string;
}>;

export type IntegrationStepAttempt = Readonly<{
  tenantId: TenantId;
  operationId: string;
  sequence: number;
  step: string;
  attempt: number;
  outcome: "started" | "succeeded" | "failed" | "compensated";
  externalRequestId: string;
  errorCode: string | null;
  occurredAtUtc: string;
}>;

export function advanceIntegrationOperation(
  operation: IntegrationOperation,
  change: Readonly<{
    state: IntegrationOperationState;
    currentStep: string;
    occurredAtUtc: string;
    externalReference?: ExternalReference | null;
    expectedSyncWatermark?: string | null;
    nextAttemptAtUtc?: string | null;
    lastError?: string | null;
    incrementAttempt?: boolean;
  }>,
): IntegrationOperation {
  if (operation.state === "completed" || operation.state === "compensated") throw new Error("INTEGRATION_OPERATION_IS_TERMINAL");
  const allowed: Record<IntegrationOperationState, readonly IntegrationOperationState[]> = {
    planned: ["running", "recovery_required"],
    running: ["running", "retryable", "completed", "compensated", "recovery_required"],
    retryable: ["running", "retryable", "recovery_required"],
    recovery_required: ["retryable", "compensated"],
    completed: [],
    compensated: [],
  };
  if (!allowed[operation.state].includes(change.state)) {
    throw new Error(`INTEGRATION_OPERATION_TRANSITION_INVALID:${operation.state}:${change.state}`);
  }
  if ((change.state === "retryable" || change.state === "recovery_required") && !change.lastError?.trim()) {
    throw new Error("INTEGRATION_OPERATION_ERROR_REQUIRED");
  }
  return {
    ...operation,
    state: change.state,
    currentStep: change.currentStep,
    attempts: operation.attempts + (change.incrementAttempt === true ? 1 : 0),
    externalReference: change.externalReference === undefined ? operation.externalReference : change.externalReference,
    expectedSyncWatermark: change.expectedSyncWatermark === undefined ? operation.expectedSyncWatermark : change.expectedSyncWatermark,
    nextAttemptAtUtc: change.nextAttemptAtUtc === undefined ? operation.nextAttemptAtUtc : change.nextAttemptAtUtc,
    lastError: change.lastError === undefined ? null : change.lastError,
    version: operation.version + 1,
    updatedAtUtc: change.occurredAtUtc,
  };
}
