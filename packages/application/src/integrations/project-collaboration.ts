import { createHash } from "node:crypto";
import type { Asset } from "../../../domain/src/assets.ts";
import type { BackgroundJob } from "../../../domain/src/events.ts";
import type { ExternalBinding, ExternalReference } from "../../../domain/src/external-reference.ts";
import { advanceIntegrationOperation, type IntegrationOperation } from "../../../domain/src/integration-operations.ts";
import { taskLifecycle, type ProductTask } from "../../../domain/src/tasks.ts";
import type {
  AssetContentPort,
  CollaborationTaskStatus,
  ExternalBlobProjectionPort,
  IntegrationCallError,
  TaskFileProjectionPort,
  TaskProjectionPort,
} from "../ports/integrations.ts";
import type { Persistence, TransactionContext } from "../ports/persistence.ts";

export type CollaborationProjectionDependencies = Readonly<{
  persistence: Persistence;
  assetContent: AssetContentPort;
  tasks: TaskProjectionPort;
  blobs: ExternalBlobProjectionPort;
  taskFiles: TaskFileProjectionPort;
  now?: () => Date;
}>;

type OperationContext = Readonly<{
  operation: IntegrationOperation;
  attempt: number;
}>;

/**
 * Projects product-owned facts into an optional collaboration provider.
 * Each external call is outside the local transaction and uses deterministic
 * request IDs. Durable operation steps make ambiguous and partial outcomes
 * safe to reconcile after a process crash.
 */
export class CollaborationProjectionProcessor {
  readonly #dependencies: CollaborationProjectionDependencies;

  constructor(dependencies: CollaborationProjectionDependencies) {
    this.#dependencies = dependencies;
  }

  async process(job: BackgroundJob): Promise<void> {
    if (job.jobType === "collaboration.task.project") {
      await this.projectTask(job);
      return;
    }
    if (job.jobType === "collaboration.asset.project") {
      await this.projectAsset(job);
      return;
    }
    throw new Error(`UNSUPPORTED_JOB_TYPE:${job.jobType}`);
  }

  private async projectTask(job: BackgroundJob): Promise<void> {
    const taskId = requiredPayloadString(job, "taskId");
    const desiredVersion = requiredPayloadVersion(job);
    const operationId = `op:${job.id}`;
    const nowUtc = this.nowUtc();
    const prepared = await this.#dependencies.persistence.transaction(job.tenantId, async (transaction) => {
      const task = await transaction.tasks.get(taskId);
      if (task === undefined) throw new Error("TASK_NOT_FOUND");
      const binding = await transaction.externalBindings.getByOwner("task", taskId, "collaboration_projection");
      if (binding?.syncState === "synced" && binding.desiredVersion >= desiredVersion) return { done: true as const };
      const operation = await prepareOperation(transaction, job, operationId, "task", taskId, "create_task", nowUtc);
      if (operation === undefined) return { done: true as const };
      return { done: false as const, task, operation, binding };
    });
    if (prepared.done) return;

    try {
      const record = await this.#dependencies.tasks.create({
        requestId: prepared.operation.operation.externalRequestId,
        title: prepared.task.title,
        status: collaborationStatus(prepared.task),
      });
      await this.#dependencies.persistence.transaction(job.tenantId, async (transaction) => {
        await saveProjectionBinding(transaction, {
          tenantId: job.tenantId,
          id: `binding:collaboration:task:${taskId}`,
          ownerType: "task",
          ownerId: taskId,
          role: "collaboration_projection",
          reference: record.reference,
          desiredVersion,
          observedVersion: desiredVersion,
          syncWatermark: record.syncWatermark,
          syncState: "synced",
          lastError: null,
          version: 1,
          updatedAtUtc: this.nowUtc(),
        }, prepared.binding);
        await completeOperation(transaction, operationId, "task_created", record.reference, record.syncWatermark, this.nowUtc());
      });
    } catch (error) {
      await this.recordFailure(job, operationId, "create_task", error);
      throw error;
    }
  }

  private async projectAsset(job: BackgroundJob): Promise<void> {
    const assetId = requiredPayloadString(job, "assetId");
    const taskId = requiredPayloadString(job, "taskId");
    const desiredVersion = requiredPayloadVersion(job);
    const operationId = `op:${job.id}`;
    const prepared = await this.#dependencies.persistence.transaction(job.tenantId, async (transaction) => {
      const asset = await transaction.assets.get(assetId);
      if (asset === undefined) throw new Error("ASSET_NOT_FOUND");
      if (asset.lifecycleState !== "available" || asset.deletedAtUtc !== null) throw new Error("ASSET_NOT_AVAILABLE");
      const projection = await transaction.externalBindings.getByOwner("asset", assetId, "collaboration_projection");
      if (projection?.syncState === "synced" && projection.desiredVersion >= desiredVersion) return { done: true as const };
      const localContent = await transaction.externalBindings.getByOwner("asset", assetId, "blob_replica");
      if (localContent === undefined || localContent.syncState !== "synced") throw new Error("ASSET_CONTENT_BINDING_NOT_READY");
      const taskProjection = await transaction.externalBindings.getByOwner("task", taskId, "collaboration_projection");
      if (taskProjection === undefined || taskProjection.syncState !== "synced") throw new Error("TASK_PROJECTION_NOT_READY");
      const operation = await prepareOperation(transaction, job, operationId, "asset", assetId, "upload_blob", this.nowUtc());
      if (operation === undefined) return { done: true as const };
      return { done: false as const, asset, localContent, taskProjection, projection, operation };
    });
    if (prepared.done) return;

    let blobReference = prepared.operation.operation.externalReference;
    let blobCheckpointNeeded = blobReference === null;
    try {
      if (blobReference === null || !await this.#dependencies.blobs.exists(blobReference)) {
        blobCheckpointNeeded = true;
        const bytes = await this.#dependencies.assetContent.read(prepared.localContent.reference);
        verifyContent(prepared.asset, bytes);
        const stored = await this.#dependencies.blobs.put({
          requestId: `${prepared.operation.operation.externalRequestId}:blob`,
          contentType: prepared.asset.contentType,
          bytes,
          sha256: prepared.asset.sha256,
        });
        blobReference = stored.reference;
      }
      if (blobCheckpointNeeded) {
        await this.#dependencies.persistence.transaction(job.tenantId, async (transaction) => {
          await checkpointOperation(transaction, operationId, "attach_file", blobReference as ExternalReference, this.nowUtc());
        });
      }
    } catch (error) {
      await this.recordFailure(job, operationId, "upload_blob", error);
      throw error;
    }

    try {
      const attachment = await this.#dependencies.taskFiles.attach({
        requestId: `${prepared.operation.operation.externalRequestId}:attachment`,
        taskReference: prepared.taskProjection.reference,
        blobReference,
        name: prepared.asset.displayName,
        contentType: prepared.asset.contentType,
        size: prepared.asset.size,
      });
      await this.#dependencies.persistence.transaction(job.tenantId, async (transaction) => {
        await saveProjectionBinding(transaction, {
          tenantId: job.tenantId,
          id: `binding:collaboration:asset:${assetId}`,
          ownerType: "asset",
          ownerId: assetId,
          role: "collaboration_projection",
          reference: attachment.reference,
          desiredVersion,
          observedVersion: desiredVersion,
          syncWatermark: attachment.syncWatermark,
          syncState: "synced",
          lastError: null,
          version: 1,
          updatedAtUtc: this.nowUtc(),
        }, prepared.projection);
        await completeOperation(transaction, operationId, "file_attached", attachment.reference, attachment.syncWatermark, this.nowUtc());
      });
    } catch (error) {
      await this.recordFailure(job, operationId, "attach_file", error);
      throw error;
    }
  }

  private async recordFailure(job: BackgroundJob, operationId: string, step: string, cause: unknown): Promise<void> {
    await this.#dependencies.persistence.transaction(job.tenantId, async (transaction) => {
      const operation = await transaction.integrationOperations.get(operationId);
      if (operation === undefined || operation.state === "completed" || operation.state === "compensated") return;
      const retryable = isRetryable(cause);
      const updated = advanceIntegrationOperation(operation, {
        state: retryable ? "retryable" : "recovery_required",
        currentStep: step,
        occurredAtUtc: this.nowUtc(),
        nextAttemptAtUtc: retryable ? this.nowUtc() : null,
        lastError: errorMessage(cause),
      });
      await transaction.integrationOperations.update(updated, operation.version);
      await appendStep(transaction, updated, step, "failed", errorCode(cause), this.nowUtc());
    });
  }

  private nowUtc(): string {
    return (this.#dependencies.now ?? (() => new Date()))().toISOString();
  }
}

async function prepareOperation(
  transaction: TransactionContext,
  job: BackgroundJob,
  operationId: string,
  subjectType: "task" | "asset",
  subjectId: string,
  firstStep: string,
  nowUtc: string,
): Promise<OperationContext | undefined> {
  let operation = await transaction.integrationOperations.get(operationId);
  if (operation?.state === "completed" || operation?.state === "compensated") return undefined;
  if (operation === undefined) {
    operation = {
      tenantId: job.tenantId,
      id: operationId,
      operationType: job.jobType as "collaboration.task.project" | "collaboration.asset.project",
      subjectType,
      subjectId,
      fingerprint: createHash("sha256").update(JSON.stringify(job.payload)).digest("hex"),
      state: "planned",
      currentStep: firstStep,
      attempts: 0,
      externalRequestId: job.id,
      externalReference: null,
      expectedSyncWatermark: null,
      nextAttemptAtUtc: null,
      deadlineAtUtc: new Date(Date.parse(job.createdAtUtc) + 24 * 60 * 60_000).toISOString(),
      lastError: null,
      version: 1,
      createdAtUtc: nowUtc,
      updatedAtUtc: nowUtc,
    };
    await transaction.integrationOperations.insert(operation);
  }
  const currentStep = operation.externalReference === null ? firstStep : operation.currentStep;
  const running = advanceIntegrationOperation(operation, {
    state: "running",
    currentStep,
    occurredAtUtc: nowUtc,
    incrementAttempt: true,
  });
  await transaction.integrationOperations.update(running, operation.version);
  await appendStep(transaction, running, currentStep, "started", null, nowUtc);
  return { operation: running, attempt: running.attempts };
}

async function checkpointOperation(
  transaction: TransactionContext,
  operationId: string,
  nextStep: string,
  reference: ExternalReference,
  nowUtc: string,
): Promise<void> {
  const operation = await requiredOperation(transaction, operationId);
  const updated = advanceIntegrationOperation(operation, {
    state: "running",
    currentStep: nextStep,
    occurredAtUtc: nowUtc,
    externalReference: reference,
  });
  await transaction.integrationOperations.update(updated, operation.version);
  await appendStep(transaction, updated, "upload_blob", "succeeded", null, nowUtc);
}

async function completeOperation(
  transaction: TransactionContext,
  operationId: string,
  step: string,
  reference: ExternalReference,
  syncWatermark: string,
  nowUtc: string,
): Promise<void> {
  const operation = await requiredOperation(transaction, operationId);
  if (operation.state === "completed") return;
  const completed = advanceIntegrationOperation(operation, {
    state: "completed",
    currentStep: step,
    occurredAtUtc: nowUtc,
    externalReference: reference,
    expectedSyncWatermark: syncWatermark,
  });
  await transaction.integrationOperations.update(completed, operation.version);
  await appendStep(transaction, completed, step === "task_created" ? "create_task" : "attach_file", "succeeded", null, nowUtc);
}

async function appendStep(
  transaction: TransactionContext,
  operation: IntegrationOperation,
  step: string,
  outcome: "started" | "succeeded" | "failed" | "compensated",
  error: string | null,
  nowUtc: string,
): Promise<void> {
  const steps = await transaction.integrationOperations.listSteps(operation.id);
  await transaction.integrationOperations.appendStep({
    tenantId: operation.tenantId,
    operationId: operation.id,
    sequence: steps.length + 1,
    step,
    attempt: operation.attempts,
    outcome,
    externalRequestId: operation.externalRequestId,
    errorCode: error,
    occurredAtUtc: nowUtc,
  });
}

async function saveProjectionBinding(
  transaction: TransactionContext,
  target: ExternalBinding,
  prior: ExternalBinding | undefined,
): Promise<void> {
  const current = prior ?? await transaction.externalBindings.getByOwner(target.ownerType, target.ownerId, target.role);
  if (current === undefined) {
    await transaction.externalBindings.insert(target);
    return;
  }
  if (current.reference.provider !== target.reference.provider || current.reference.kind !== target.reference.kind
    || current.reference.externalId !== target.reference.externalId) throw new Error("EXTERNAL_PROJECTION_REFERENCE_CONFLICT");
  if (current.syncState === "synced" && current.desiredVersion >= target.desiredVersion) return;
  await transaction.externalBindings.update({ ...target, id: current.id, version: current.version + 1 }, current.version);
}

async function requiredOperation(transaction: TransactionContext, operationId: string): Promise<IntegrationOperation> {
  const operation = await transaction.integrationOperations.get(operationId);
  if (operation === undefined) throw new Error("INTEGRATION_OPERATION_NOT_FOUND");
  return operation;
}

function collaborationStatus(task: ProductTask): CollaborationTaskStatus {
  const lifecycle = taskLifecycle(task);
  if (lifecycle === "completed" || lifecycle === "promoted") return "completed";
  if (lifecycle === "canceled") return "canceled";
  if (lifecycle === "in_progress" || lifecycle === "pending_review") return "in_progress";
  return "todo";
}

function verifyContent(asset: Asset, bytes: Uint8Array): void {
  if (bytes.byteLength !== asset.size) throw new Error("ASSET_CONTENT_SIZE_MISMATCH");
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("ASSET_CONTENT_HASH_MISMATCH");
}

function requiredPayloadString(job: BackgroundJob, field: string): string {
  const value = job.payload[field];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`JOB_PAYLOAD_INVALID:${field}`);
  return value;
}

function requiredPayloadVersion(job: BackgroundJob): number {
  const value = job.payload.desiredVersion;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("JOB_PAYLOAD_INVALID:desiredVersion");
  return value;
}

function isRetryable(error: unknown): boolean {
  return error instanceof Error && "retryable" in error && (error as IntegrationCallError).retryable === true;
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? String((error as { code: string }).code)
    : error instanceof Error ? error.message.split(":", 1)[0] ?? "INTEGRATION_FAILURE" : "INTEGRATION_FAILURE";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
