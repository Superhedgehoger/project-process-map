import { createHash } from "node:crypto";
import { eventTopic, type DomainEvent, type OutboxMessage } from "../../../domain/src/events.ts";
import type { PrincipalId, TenantId } from "../../../domain/src/identity.ts";
import { advanceIntegrationOperation, type IntegrationOperation } from "../../../domain/src/integration-operations.ts";
import type { CommandScope, Persistence, TransactionContext } from "../ports/persistence.ts";

export type RecoveryOperationView = Readonly<{
  id: string;
  operationType: IntegrationOperation["operationType"];
  subjectType: IntegrationOperation["subjectType"];
  subjectId: string;
  state: IntegrationOperation["state"];
  currentStep: string;
  attempts: number;
  hasExternalCheckpoint: boolean;
  version: number;
  updatedAtUtc: string;
}>;

export interface IntegrationRecoveryAuthorizer {
  canRecover(tenantId: TenantId, principalId: PrincipalId): Promise<boolean>;
}

export type RetryIntegrationCommand = Readonly<{
  tenantId: TenantId;
  principalId: PrincipalId;
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  operationId: string;
  expectedVersion: number;
  reason: string;
  occurredAtUtc: string;
}>;

export class IntegrationRecoveryService {
  readonly #persistence: Persistence;
  readonly #authorizer: IntegrationRecoveryAuthorizer;

  constructor(persistence: Persistence, authorizer: IntegrationRecoveryAuthorizer) {
    this.#persistence = persistence;
    this.#authorizer = authorizer;
  }

  async list(tenantId: TenantId, principalId: PrincipalId): Promise<RecoveryOperationView[]> {
    await this.assertAuthorized(tenantId, principalId);
    return await this.#persistence.read(tenantId, async (transaction) => (
      await transaction.integrationOperations.listRecoverable()
    ).map(toView));
  }

  async retry(command: RetryIntegrationCommand): Promise<{ value: RecoveryOperationView; replayed: boolean }> {
    await this.assertAuthorized(command.tenantId, command.principalId);
    validate(command);
    const scope: CommandScope = {
      principalId: command.principalId,
      operation: "retry_integration_operation",
      idempotencyKey: command.idempotencyKey,
    };
    const fingerprint = createHash("sha256").update(JSON.stringify({
      operationId: command.operationId,
      expectedVersion: command.expectedVersion,
      reason: command.reason,
    })).digest("hex");
    return await this.#persistence.transaction(command.tenantId, async (transaction) => {
      const receipt = await transaction.receipts.get<RecoveryOperationView>(scope);
      if (receipt !== undefined) {
        if (receipt.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
        return { value: receipt.result, replayed: true };
      }
      const operation = await transaction.integrationOperations.get(command.operationId);
      if (operation === undefined) throw new Error("INTEGRATION_OPERATION_NOT_FOUND");
      if (operation.version !== command.expectedVersion) throw new Error("INTEGRATION_OPERATION_VERSION_CONFLICT");
      if (operation.state !== "retryable" && operation.state !== "recovery_required") throw new Error("INTEGRATION_OPERATION_NOT_RECOVERABLE");
      if (operation.operationType !== "collaboration.task.project" && operation.operationType !== "collaboration.asset.project") {
        throw new Error("INTEGRATION_OPERATION_REQUIRES_SPECIALIZED_RECOVERY");
      }
      if (!await transaction.jobs.rescheduleDeadLetter(operation.externalRequestId, command.occurredAtUtc)) {
        throw new Error("INTEGRATION_RECOVERY_JOB_NOT_DEAD_LETTER");
      }
      const updated = advanceIntegrationOperation(operation, {
        state: "retryable",
        currentStep: operation.currentStep,
        occurredAtUtc: command.occurredAtUtc,
        nextAttemptAtUtc: command.occurredAtUtc,
        lastError: operation.lastError ?? command.reason,
      });
      await transaction.integrationOperations.update(updated, operation.version);
      await appendRecoveryEvent(transaction, command, updated);
      const value = toView(updated);
      await transaction.receipts.insert({ scope, fingerprint, result: value, createdAtUtc: command.occurredAtUtc });
      return { value, replayed: false };
    });
  }

  private async assertAuthorized(tenantId: TenantId, principalId: PrincipalId): Promise<void> {
    if (!await this.#authorizer.canRecover(tenantId, principalId)) throw new Error("FORBIDDEN");
  }
}

async function appendRecoveryEvent(
  transaction: TransactionContext,
  command: RetryIntegrationCommand,
  operation: IntegrationOperation,
): Promise<void> {
  const projectId = await projectForOperation(transaction, operation);
  const event: DomainEvent = {
    tenantId: command.tenantId,
    eventId: `evt:${command.commandId}`,
    projectId,
    projectSequence: await transaction.sequences.next(projectId),
    aggregateType: "integration_operation",
    aggregateId: operation.id,
    aggregateVersion: operation.version,
    eventType: "project-map.integration.recovery-requested",
    schemaVersion: 1,
    actorPrincipalId: command.principalId,
    occurredAtUtc: command.occurredAtUtc,
    correlationId: command.correlationId,
    causationId: command.commandId,
    originalSecurityDomainId: null,
    originalSecurityEpoch: 1,
    payload: { operationId: operation.id, operationType: operation.operationType, reason: command.reason },
  };
  await transaction.events.append(event);
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
}

async function projectForOperation(transaction: TransactionContext, operation: IntegrationOperation): Promise<string> {
  if (operation.subjectType === "task") {
    const task = await transaction.tasks.get(operation.subjectId);
    if (task === undefined) throw new Error("TASK_NOT_FOUND");
    return task.projectId;
  }
  const asset = await transaction.assets.get(operation.subjectId);
  if (asset === undefined) throw new Error("ASSET_NOT_FOUND");
  return asset.projectId;
}

function toView(operation: IntegrationOperation): RecoveryOperationView {
  return {
    id: operation.id,
    operationType: operation.operationType,
    subjectType: operation.subjectType,
    subjectId: operation.subjectId,
    state: operation.state,
    currentStep: operation.currentStep,
    attempts: operation.attempts,
    hasExternalCheckpoint: operation.externalReference !== null,
    version: operation.version,
    updatedAtUtc: operation.updatedAtUtc,
  };
}

function validate(command: RetryIntegrationCommand): void {
  for (const [name, value] of Object.entries({
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId,
    operationId: command.operationId,
    reason: command.reason,
  })) if (String(value).trim().length === 0) throw new Error(`${name} is required`);
  if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion <= 0) throw new Error("expectedVersion must be positive");
  if (!command.occurredAtUtc.endsWith("Z") || Number.isNaN(Date.parse(command.occurredAtUtc))) throw new Error("occurredAtUtc must be UTC");
}
