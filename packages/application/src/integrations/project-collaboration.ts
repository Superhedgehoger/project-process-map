import { createHash, randomUUID } from "node:crypto";
import type { Asset } from "../../../domain/src/assets.ts";
import type { BackgroundJob } from "../../../domain/src/events.ts";
import type { ExternalBinding, ExternalReference } from "../../../domain/src/external-reference.ts";
import { advanceIntegrationOperation, type IntegrationOperation } from "../../../domain/src/integration-operations.ts";
import type { SecurityDomainMigration } from "../../../domain/src/security-migration.ts";
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
  freezeDeferMilliseconds?: number;
  fenceDurationMilliseconds?: number;
}>;

export type CollaborationProjectionResult = Readonly<{ outcome: "deferred"; availableAtUtc: string }>;

type OperationContext = Readonly<{
  operation: IntegrationOperation;
  attempt: number;
}>;

type FenceLease = Readonly<{ id: string; token: string }>;

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

  async process(job: BackgroundJob): Promise<void | CollaborationProjectionResult> {
    if (job.jobType === "collaboration.task.project") {
      return await this.projectTask(job);
    }
    if (job.jobType === "collaboration.asset.project") {
      return await this.projectAsset(job);
    }
    throw new Error(`UNSUPPORTED_JOB_TYPE:${job.jobType}`);
  }

  private async projectTask(job: BackgroundJob): Promise<void | CollaborationProjectionResult> {
    const taskId = requiredPayloadString(job, "taskId");
    const desiredVersion = requiredPayloadVersion(job);
    const operationId = `op:${job.id}`;

    const prepared = await this.#dependencies.persistence.transaction(job.tenantId, async (transaction) => {
      const task = await transaction.tasks.get(taskId);
      if (task === undefined) throw new Error("TASK_NOT_FOUND");
      if (!await collaborationProjectionAllowed(transaction, task)) return { deferred: true as const };
      const binding = await transaction.externalBindings.getByOwner("task", taskId, "collaboration_projection");
      if (binding?.syncState === "synced" && binding.desiredVersion >= desiredVersion) return { done: true as const };
      const lease = await this.acquireFence(transaction, job, task.projectId, task.ownerNodeId, "task", taskId, operationId);
      if (lease === undefined) return { deferred: true as const };
      const operation = await prepareOperation(transaction, job, operationId, "task", taskId, "create_task", this.nowUtc(), lease.token);
      if (operation === undefined) {
        await transaction.outboundProjectionFences.release(lease.id, lease.token);
        return { done: true as const };
      }
      return { done: false as const, task, operation, binding, lease };
    });
    if ("deferred" in prepared) return this.deferredResult();
    if (prepared.done) return;

    const scopeValid = await this.#dependencies.persistence.transaction(job.tenantId, async (transaction) => {
      const task = await transaction.tasks.get(taskId);
      if (task === undefined || !await collaborationProjectionAllowed(transaction, task)) return false;
      const durationMs = this.#dependencies.fenceDurationMilliseconds ?? 30_000;
      const expiresAtUtc = new Date(Date.parse(this.nowUtc()) + durationMs).toISOString();
      return await transaction.outboundProjectionFences.renew(prepared.lease.id, prepared.lease.token, expiresAtUtc);
    });
    if (!scopeValid) return this.deferredResult();

    try {
      const record = await this.#dependencies.tasks.create({
        requestId: prepared.operation.operation.externalRequestId,
        title: prepared.task.title,
        status: collaborationStatus(prepared.task),
      });
      await this.#dependencies.persistence.transaction(job.tenantId, async (transaction) => {
        const completed = await completeOperation(
          transaction,
          operationId,
          "task_created",
          record.reference,
          record.syncWatermark,
          this.nowUtc(),
          prepared.lease.token,
        );
        if (!completed) return;
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
        await transaction.outboundProjectionFences.release(prepared.lease.id, prepared.lease.token);
      });
    } catch (error) {
      await this.recordFailure(job, operationId, "create_task", error, prepared.lease);
      throw error;
    }
  }

  private async projectAsset(job: BackgroundJob): Promise<void | CollaborationProjectionResult> {
    const assetId = requiredPayloadString(job, "assetId");
    const taskId = requiredPayloadString(job, "taskId");
    const desiredVersion = requiredPayloadVersion(job);
    const operationId = `op:${job.id}`;
    const prepared = await this.#dependencies.persistence.transaction(job.tenantId, async (transaction) => {
      const asset = await transaction.assets.get(assetId);
      if (asset === undefined) throw new Error("ASSET_NOT_FOUND");
      if (asset.lifecycleState !== "available" || asset.deletedAtUtc !== null) throw new Error("ASSET_NOT_AVAILABLE");
      if (!await assetProjectionAllowed(transaction, asset, taskId)) return { deferred: true as const };
      const projection = await transaction.externalBindings.getByOwner("asset", assetId, "collaboration_projection");
      if (projection?.syncState === "synced" && projection.desiredVersion >= desiredVersion) return { done: true as const };
      const localContent = await transaction.externalBindings.getByOwner("asset", assetId, "blob_replica");
      if (localContent === undefined || localContent.syncState !== "synced") throw new Error("ASSET_CONTENT_BINDING_NOT_READY");
      const taskProjection = await transaction.externalBindings.getByOwner("task", taskId, "collaboration_projection");
      if (taskProjection === undefined || taskProjection.syncState !== "synced") throw new Error("TASK_PROJECTION_NOT_READY");
      const lease = await this.acquireFence(transaction, job, asset.projectId, asset.ownerNodeId, "asset", assetId, operationId);
      if (lease === undefined) return { deferred: true as const };
      const operation = await prepareOperation(transaction, job, operationId, "asset", assetId, "upload_blob", this.nowUtc(), lease.token);
      if (operation === undefined) {
        await transaction.outboundProjectionFences.release(lease.id, lease.token);
        return { done: true as const };
      }
      return { done: false as const, asset, localContent, taskProjection, projection, operation, lease };
    });
    if ("deferred" in prepared) return this.deferredResult();
    if (prepared.done) return;

    let blobReference = prepared.operation.operation.externalReference;
    let blobCheckpointNeeded = blobReference === null;
    try {
      let exists = false;
      if (blobReference !== null) {
        exists = await this.#dependencies.blobs.exists(blobReference as ExternalReference);
      }
      if (blobReference === null || !exists) {
        blobCheckpointNeeded = true;
        const bytes = await this.#dependencies.assetContent.read(prepared.localContent.reference);
        verifyContent(prepared.asset, bytes);

        const putValid = await this.#dependencies.persistence.transaction(job.tenantId, async (transaction) => {
          const asset = await transaction.assets.get(assetId);
          if (asset === undefined || !await assetProjectionAllowed(transaction, asset, taskId)) return false;
          const durationMs = this.#dependencies.fenceDurationMilliseconds ?? 30_000;
          const expiresAtUtc = new Date(Date.parse(this.nowUtc()) + durationMs).toISOString();
          return await transaction.outboundProjectionFences.renew(prepared.lease.id, prepared.lease.token, expiresAtUtc);
        });
        if (!putValid) return this.deferredResult();

        const stored = await this.#dependencies.blobs.put({
          requestId: `${prepared.operation.operation.externalRequestId}:blob`,
          contentType: prepared.asset.contentType,
          bytes,
          sha256: prepared.asset.sha256,
        });
        blobReference = stored.reference;
      }
      if (blobCheckpointNeeded) {
        const checkpointed = await this.#dependencies.persistence.transaction(job.tenantId, async (transaction) => {
          return await checkpointOperation(
            transaction,
            operationId,
            "attach_file",
            blobReference as ExternalReference,
            this.nowUtc(),
            prepared.lease.token,
          );
        });
        if (!checkpointed) return this.deferredResult();
      }
    } catch (error) {
      await this.recordFailure(job, operationId, "upload_blob", error, prepared.lease);
      throw error;
    }

    const attachValid = await this.#dependencies.persistence.transaction(job.tenantId, async (transaction) => {
      const asset = await transaction.assets.get(assetId);
      if (asset === undefined || !await assetProjectionAllowed(transaction, asset, taskId)) return false;
      const durationMs = this.#dependencies.fenceDurationMilliseconds ?? 30_000;
      const expiresAtUtc = new Date(Date.parse(this.nowUtc()) + durationMs).toISOString();
      return await transaction.outboundProjectionFences.renew(prepared.lease.id, prepared.lease.token, expiresAtUtc);
    });
    if (!attachValid) return this.deferredResult();

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
        const completed = await completeOperation(
          transaction,
          operationId,
          "file_attached",
          attachment.reference,
          attachment.syncWatermark,
          this.nowUtc(),
          prepared.lease.token,
        );
        if (!completed) return;
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
        await transaction.outboundProjectionFences.release(prepared.lease.id, prepared.lease.token);
      });
    } catch (error) {
      await this.recordFailure(job, operationId, "attach_file", error, prepared.lease);
      throw error;
    }
  }

  private async acquireFence(
    transaction: TransactionContext,
    job: BackgroundJob,
    projectId: string,
    ownerNodeId: string,
    subjectType: "task" | "asset",
    subjectId: string,
    _operationId: string,
  ): Promise<FenceLease | undefined> {
    const fenceId = `fence:${subjectType}:${subjectId}`;
    const token = randomUUID();
    const createdAtUtc = this.nowUtc();
    const durationMs = this.#dependencies.fenceDurationMilliseconds ?? 30_000;
    const expiresAtUtc = new Date(Date.parse(createdAtUtc) + durationMs).toISOString();
    const acquired = await transaction.outboundProjectionFences.acquire({
      tenantId: job.tenantId,
      id: fenceId,
      projectId,
      ownerNodeId,
      token,
      expiresAtUtc,
      createdAtUtc,
    });
    if (!acquired) return undefined;
    return { id: fenceId, token };
  }

  private async recordFailure(
    job: BackgroundJob,
    operationId: string,
    step: string,
    cause: unknown,
    lease?: FenceLease,
  ): Promise<void> {
    await this.#dependencies.persistence.transaction(job.tenantId, async (transaction) => {
      const operation = await transaction.integrationOperations.get(operationId);
      if (operation === undefined || operation.state === "completed" || operation.state === "compensated") return;
      if (lease !== undefined && operation.leaseToken !== undefined && operation.leaseToken !== null && operation.leaseToken !== lease.token) {
        return;
      }
      const retryable = isRetryable(cause);
      const updated = advanceIntegrationOperation(operation, {
        state: retryable ? "retryable" : "recovery_required",
        currentStep: step,
        occurredAtUtc: this.nowUtc(),
        nextAttemptAtUtc: retryable ? this.nowUtc() : null,
        lastError: errorMessage(cause),
        leaseToken: lease?.token ?? null,
      });
      await transaction.integrationOperations.update(updated, operation.version);
      await appendStep(transaction, updated, step, "failed", errorCode(cause), this.nowUtc());
      if (lease !== undefined) {
        if (retryable) {
          const durationMs = this.#dependencies.fenceDurationMilliseconds ?? 30_000;
          const expiresAtUtc = new Date(Date.parse(this.nowUtc()) + durationMs).toISOString();
          await transaction.outboundProjectionFences.renew(lease.id, lease.token, expiresAtUtc);
        } else {
          await transaction.outboundProjectionFences.release(lease.id, lease.token);
        }
      }
    });
  }

  private nowUtc(): string {
    return (this.#dependencies.now ?? (() => new Date()))().toISOString();
  }

  private deferredResult(): CollaborationProjectionResult {
    return {
      outcome: "deferred",
      availableAtUtc: new Date(Date.parse(this.nowUtc()) + (this.#dependencies.freezeDeferMilliseconds ?? 30_000)).toISOString(),
    };
  }
}

async function assetProjectionAllowed(transaction: TransactionContext, asset: Asset, taskId: string): Promise<boolean> {
  const task = await transaction.tasks.get(taskId);
  if (task === undefined || task.deletedAtUtc !== null || task.projectId !== asset.projectId
    || task.ownerNodeId !== asset.ownerNodeId || task.securityDomainId !== asset.securityDomainId
    || task.securityEpoch !== asset.securityEpoch) return false;
  const bindings = await transaction.assets.listBindings("task", task.id);
  if (!bindings.some((binding) => binding.assetId === asset.id && binding.invalidatedAtUtc === null)) return false;
  return await collaborationProjectionAllowed(transaction, asset);
}

async function collaborationProjectionAllowed(
  transaction: TransactionContext,
  object: Pick<ProductTask | Asset, "projectId" | "ownerNodeId" | "securityDomainId" | "securityEpoch" | "deletedAtUtc">,
): Promise<boolean> {
  if (object.deletedAtUtc !== null || !Number.isSafeInteger(object.securityEpoch) || object.securityEpoch <= 0) return false;

  const ownerPath = await authoritativePath(transaction, object.projectId, object.ownerNodeId);
  if (ownerPath === undefined) return false;

  const ownerNode = await transaction.nodes.get(object.ownerNodeId);
  if (ownerNode === undefined || ownerNode.projectId !== object.projectId || ownerNode.deletedAtUtc !== null) return false;
  if (ownerNode.securityDomainId !== object.securityDomainId) return false;

  if (object.securityDomainId !== null) {
    const domain = await transaction.securityDomains.get(object.securityDomainId);
    if (domain === undefined || domain.projectId !== object.projectId || domain.deletedAtUtc !== null
      || domain.parentSecurityDomainId !== null) return false;

    const formalRoot = await transaction.nodes.get(domain.rootNodeId);
    if (formalRoot === undefined || formalRoot.projectId !== object.projectId || formalRoot.deletedAtUtc !== null) return false;
    if (!ownerPath.has(formalRoot.id)) return false;
    if (formalRoot.securityDomainId !== domain.id) return false;
    if (!Number.isSafeInteger(formalRoot.securityEpoch) || formalRoot.securityEpoch <= 0) return false;
    if (object.securityEpoch !== formalRoot.securityEpoch || ownerNode.securityEpoch !== formalRoot.securityEpoch) return false;

    let currentNodeId: string | null = object.ownerNodeId;
    let reachedFormalRoot = false;
    const visited = new Set<string>();
    while (currentNodeId !== null) {
      if (visited.has(currentNodeId)) return false;
      visited.add(currentNodeId);
      const node = await transaction.nodes.get(currentNodeId);
      if (node === undefined || node.projectId !== object.projectId || node.deletedAtUtc !== null) return false;
      if (node.securityDomainId !== domain.id) return false;
      if (node.securityEpoch !== formalRoot.securityEpoch) return false;
      if (currentNodeId === formalRoot.id) {
        reachedFormalRoot = true;
        break;
      }
      currentNodeId = node.parentId;
    }
    if (!reachedFormalRoot) return false;
  } else {
    if (ownerNode.securityEpoch !== object.securityEpoch) return false;
    for (const nodeId of ownerPath) {
      const node = await transaction.nodes.get(nodeId);
      if (node === undefined || node.securityDomainId !== null) return false;
    }
  }

  const open = (await transaction.securityMigrations.listRecoverable())
    .filter((migration) => migration.projectId === object.projectId
      && ["active", "verifying", "retryable", "recovery_required"].includes(migration.state));
  let relevant = 0;
  for (const migration of open) {
    const root = await transaction.nodes.get(migration.rootNodeId);
    if (root === undefined || root.projectId !== object.projectId || root.deletedAtUtc !== null) return false;
    if (!await validMigrationDomain(transaction, migration.sourceSecurityDomainId, object.projectId, migration.sourceSecurityEpoch, migration)
      || !await validMigrationDomain(transaction, migration.targetSecurityDomainId, object.projectId, migration.targetSecurityEpoch, migration)) return false;
    if (!Number.isSafeInteger(migration.sourceSecurityEpoch) || migration.sourceSecurityEpoch <= 0
      || !Number.isSafeInteger(migration.targetSecurityEpoch) || migration.targetSecurityEpoch <= 0) return false;
    if (!ownerPath.has(root.id)) continue;
    relevant += 1;
    const source = object.securityDomainId === migration.sourceSecurityDomainId
      && object.securityEpoch === migration.sourceSecurityEpoch;
    const target = object.securityDomainId === migration.targetSecurityDomainId
      && object.securityEpoch === migration.targetSecurityEpoch;
    if (!source && !target) return false;
  }
  if (relevant > 0) return false;

  return true;
}

async function validMigrationDomain(
  transaction: TransactionContext,
  securityDomainId: string | null,
  projectId: string,
  expectedEpoch: number,
  migration?: SecurityDomainMigration,
): Promise<boolean> {
  if (securityDomainId === null) return true;
  const domain = await transaction.securityDomains.get(securityDomainId);
  if (domain === undefined || domain.projectId !== projectId || domain.deletedAtUtc !== null
    || domain.parentSecurityDomainId !== null) return false;
  const root = await transaction.nodes.get(domain.rootNodeId);
  if (root === undefined || root.projectId !== projectId || root.deletedAtUtc !== null) return false;
  if (migration !== undefined && domain.rootNodeId === migration.rootNodeId) {
    const isSource = root.securityDomainId === migration.sourceSecurityDomainId && root.securityEpoch === migration.sourceSecurityEpoch;
    const isTarget = root.securityDomainId === migration.targetSecurityDomainId && root.securityEpoch === migration.targetSecurityEpoch;
    if (!isSource && !isTarget) return false;
    return true;
  }
  if (root.securityDomainId !== domain.id || root.securityEpoch !== expectedEpoch) return false;
  return true;
}

async function authoritativePath(
  transaction: TransactionContext,
  projectId: string,
  ownerNodeId: string,
): Promise<Set<string> | undefined> {
  const path = new Set<string>();
  let currentId: string | null = ownerNodeId;
  while (currentId !== null) {
    if (path.has(currentId)) return undefined;
    path.add(currentId);
    const current = await transaction.nodes.get(currentId);
    if (current === undefined || current.projectId !== projectId || current.deletedAtUtc !== null) return undefined;
    if (!Number.isSafeInteger(current.securityEpoch) || current.securityEpoch <= 0) return undefined;
    if (current.securityDomainId !== null) {
      const domain = await transaction.securityDomains.get(current.securityDomainId);
      if (domain === undefined || domain.projectId !== projectId || domain.deletedAtUtc !== null
        || domain.parentSecurityDomainId !== null) return undefined;
    }
    currentId = current.parentId;
  }
  return path;
}


async function prepareOperation(
  transaction: TransactionContext,
  job: BackgroundJob,
  operationId: string,
  subjectType: "task" | "asset",
  subjectId: string,
  firstStep: string,
  nowUtc: string,
  leaseToken: string,
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
      leaseToken,
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
    leaseToken,
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
  leaseToken: string,
): Promise<boolean> {
  const operation = await requiredOperation(transaction, operationId);
  if (operation.leaseToken !== undefined && operation.leaseToken !== null && operation.leaseToken !== leaseToken) {
    return false;
  }
  const updated = advanceIntegrationOperation(operation, {
    state: "running",
    currentStep: nextStep,
    occurredAtUtc: nowUtc,
    externalReference: reference,
    leaseToken,
  });
  await transaction.integrationOperations.update(updated, operation.version);
  await appendStep(transaction, updated, "upload_blob", "succeeded", null, nowUtc);
  return true;
}

async function completeOperation(
  transaction: TransactionContext,
  operationId: string,
  step: string,
  reference: ExternalReference,
  syncWatermark: string,
  nowUtc: string,
  leaseToken: string,
): Promise<boolean> {
  const operation = await requiredOperation(transaction, operationId);
  if (operation.state === "completed") return true;
  if (operation.leaseToken !== undefined && operation.leaseToken !== null && operation.leaseToken !== leaseToken) {
    return false;
  }
  const completed = advanceIntegrationOperation(operation, {
    state: "completed",
    currentStep: step,
    occurredAtUtc: nowUtc,
    externalReference: reference,
    expectedSyncWatermark: syncWatermark,
    leaseToken,
  });
  await transaction.integrationOperations.update(completed, operation.version);
  await appendStep(transaction, completed, step === "task_created" ? "create_task" : "attach_file", "succeeded", null, nowUtc);
  return true;
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
