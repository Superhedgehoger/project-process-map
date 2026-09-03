import { createHash } from "node:crypto";
import { transitionAsset, type Asset, type AssetBinding } from "../../../domain/src/assets.ts";
import { eventTopic, type BackgroundJob, type DomainEvent, type OutboxMessage } from "../../../domain/src/events.ts";
import type { ExternalBinding } from "../../../domain/src/external-reference.ts";
import type { PrincipalId, TenantId } from "../../../domain/src/identity.ts";
import { advanceIntegrationOperation, type IntegrationOperation } from "../../../domain/src/integration-operations.ts";
import type { AssetContentPort, StoredAssetContent } from "../ports/integrations.ts";
import type { CommandScope, Persistence, TransactionContext } from "../ports/persistence.ts";

export type AttachTaskAssetCommand = Readonly<{
  tenantId: TenantId;
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  principalId: PrincipalId;
  projectId: string;
  taskId: string;
  assetId: string;
  displayName: string;
  contentType: string;
  bytes: Uint8Array;
  sha256: string;
  occurredAtUtc: string;
  deadlineAtUtc: string;
}>;

export type AssetView = Readonly<{
  id: string;
  taskId: string;
  nodeId: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  lifecycleState: Asset["lifecycleState"];
  scanState: "scanning" | "available" | "quarantined" | "failed";
  version: number;
}>;

export type AttachTaskAssetResult = Readonly<{ value: AssetView; replayed: boolean }>;

export class AttachTaskAssetHandler {
  readonly #persistence: Persistence;
  readonly #content: AssetContentPort;
  readonly #scheduleCollaborationProjection: boolean;

  constructor(
    persistence: Persistence,
    content: AssetContentPort,
    options: Readonly<{ scheduleCollaborationProjection: boolean }> = { scheduleCollaborationProjection: false },
  ) {
    this.#persistence = persistence;
    this.#content = content;
    this.#scheduleCollaborationProjection = options.scheduleCollaborationProjection;
  }

  async execute(command: AttachTaskAssetCommand): Promise<AttachTaskAssetResult> {
    validate(command);
    const actualHash = createHash("sha256").update(command.bytes).digest("hex");
    if (actualHash !== command.sha256) throw new Error("ASSET_CONTENT_HASH_MISMATCH");
    const scope: CommandScope = {
      principalId: command.principalId,
      operation: "attach_task_asset",
      idempotencyKey: command.idempotencyKey,
    };
    const fingerprint = hash({
      projectId: command.projectId,
      taskId: command.taskId,
      assetId: command.assetId,
      displayName: command.displayName,
      contentType: command.contentType,
      size: command.bytes.byteLength,
      sha256: command.sha256,
    });
    const operationId = `op:asset-ingest:${hash(`${command.tenantId}\u0000${command.principalId}\u0000${command.idempotencyKey}`).slice(0, 32)}`;

    const initialized = await this.#persistence.transaction(command.tenantId, async (transaction) => {
      const replay = await readReplay(transaction, scope, fingerprint);
      if (replay !== undefined) return { replay };
      const previousOperation = await transaction.integrationOperations.get(operationId);
      if (previousOperation !== undefined) {
        if (previousOperation.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
        return { replay: undefined };
      }
      const task = await transaction.tasks.get(command.taskId);
      if (task === undefined) throw new Error("TASK_NOT_FOUND");
      if (task.projectId !== command.projectId) throw new Error("PROJECT_MISMATCH");
      if (task.deletedAtUtc !== null) throw new Error("TASK_DELETED");
      if (await transaction.assets.get(command.assetId) !== undefined) throw new Error("ASSET_ALREADY_EXISTS");
      const asset: Asset = {
        tenantId: command.tenantId,
        id: command.assetId,
        projectId: command.projectId,
        ownerNodeId: task.ownerNodeId,
        securityDomainId: task.securityDomainId,
        securityEpoch: task.securityEpoch,
        uploaderPrincipalId: command.principalId,
        displayName: command.displayName,
        contentType: command.contentType,
        size: command.bytes.byteLength,
        sha256: command.sha256,
        lifecycleState: "initiated",
        failureCode: null,
        version: 1,
        deletedAtUtc: null,
      };
      const operation: IntegrationOperation = {
        tenantId: command.tenantId,
        id: operationId,
        operationType: "asset.ingest",
        subjectType: "asset",
        subjectId: asset.id,
        fingerprint,
        state: "planned",
        currentStep: "store_content",
        attempts: 0,
        externalRequestId: operationId,
        externalReference: null,
        expectedSyncWatermark: null,
        nextAttemptAtUtc: null,
        deadlineAtUtc: command.deadlineAtUtc,
        lastError: null,
        version: 1,
        createdAtUtc: command.occurredAtUtc,
        updatedAtUtc: command.occurredAtUtc,
      };
      await transaction.assets.insert(asset);
      await transaction.integrationOperations.insert(operation);
      await appendEvent(transaction, command, asset, "project-map.asset.initiated", `evt:asset-initiated:${operationId}`, {
        assetId: asset.id,
        taskId: command.taskId,
        nodeId: asset.ownerNodeId,
        size: asset.size,
        sha256: asset.sha256,
      });
      return { replay: undefined };
    });
    if (initialized.replay !== undefined) return { value: initialized.replay, replayed: true };

    let stored: StoredAssetContent;
    try {
      stored = await this.#content.put({
        tenantId: command.tenantId,
        requestId: operationId,
        contentType: command.contentType,
        bytes: command.bytes,
        sha256: command.sha256,
      });
    } catch (error) {
      await this.recordFailure(command, operationId, error);
      throw error;
    }

    return await this.#persistence.transaction(command.tenantId, async (transaction) => {
      const replay = await readReplay(transaction, scope, fingerprint);
      if (replay !== undefined) return { value: replay, replayed: true };
      let asset = await requiredAsset(transaction, command.assetId);
      let operation = await requiredOperation(transaction, operationId);
      if (operation.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
      if (asset.lifecycleState === "failed" || asset.lifecycleState === "initiated") {
        const uploading = transitionAsset(asset, "uploading");
        await transaction.assets.update(uploading, asset.version);
        asset = uploading;
      }
      if (asset.lifecycleState === "uploading") {
        const scanning = transitionAsset(asset, "scanning");
        await transaction.assets.update(scanning, asset.version);
        asset = scanning;
      }
      if (asset.lifecycleState === "scanning" && stored.scanState !== "scanning") {
        const target = stored.scanState === "available" ? "available" : stored.scanState === "quarantined" ? "quarantined" : "failed";
        const updated = transitionAsset(asset, target, target === "failed" ? { failureCode: "CONTENT_SCAN_FAILED" } : {});
        await transaction.assets.update(updated, asset.version);
        asset = updated;
      }
      const priorReplica = await transaction.externalBindings.getByOwner("asset", asset.id, "blob_replica");
      if (priorReplica === undefined) {
        const replica: ExternalBinding = {
          tenantId: command.tenantId,
          id: `binding:blob:${asset.id}`,
          ownerType: "asset",
          ownerId: asset.id,
          role: "blob_replica",
          reference: stored.reference,
          desiredVersion: asset.version,
          observedVersion: asset.version,
          syncWatermark: null,
          syncState: "synced",
          lastError: null,
          version: 1,
          updatedAtUtc: command.occurredAtUtc,
        };
        await transaction.externalBindings.insert(replica);
      } else if (JSON.stringify(priorReplica.reference) !== JSON.stringify(stored.reference)) {
        throw new Error("ASSET_REPLICA_REFERENCE_CONFLICT");
      }
      const bindings = await transaction.assets.listBindings("task", command.taskId);
      if (!bindings.some((binding) => binding.assetId === asset.id)) {
        const binding: AssetBinding = {
          tenantId: command.tenantId,
          id: `asset-binding:${asset.id}:task:${command.taskId}`,
          assetId: asset.id,
          targetType: "task",
          targetId: command.taskId,
          purpose: "attachment",
          version: 1,
          invalidatedAtUtc: null,
        };
        await transaction.assets.insertBinding(binding);
      }
      operation = advanceIntegrationOperation(operation, {
        state: "completed",
        currentStep: "content_stored",
        occurredAtUtc: command.occurredAtUtc,
        externalReference: stored.reference,
        incrementAttempt: true,
      });
      await transaction.integrationOperations.update(operation, operation.version - 1);
      const steps = await transaction.integrationOperations.listSteps(operationId);
      await transaction.integrationOperations.appendStep({
        tenantId: command.tenantId,
        operationId,
        sequence: steps.length + 1,
        step: "store_content",
        attempt: operation.attempts,
        outcome: "succeeded",
        externalRequestId: operation.externalRequestId,
        errorCode: null,
        occurredAtUtc: command.occurredAtUtc,
      });
      await appendEvent(transaction, command, asset, "project-map.asset.attached", `evt:${command.commandId}`, {
        assetId: asset.id,
        taskId: command.taskId,
        nodeId: asset.ownerNodeId,
        lifecycleState: asset.lifecycleState,
      });
      if (this.#scheduleCollaborationProjection && asset.lifecycleState === "available") {
        await transaction.jobs.schedule(projectionJob(command, asset));
      }
      const value = toAssetView(asset, command.taskId);
      await transaction.receipts.insert({ scope, fingerprint, result: value, createdAtUtc: command.occurredAtUtc });
      return { value, replayed: false };
    });
  }

  private async recordFailure(command: AttachTaskAssetCommand, operationId: string, cause: unknown): Promise<void> {
    await this.#persistence.transaction(command.tenantId, async (transaction) => {
      let asset = await requiredAsset(transaction, command.assetId);
      const operation = await requiredOperation(transaction, operationId);
      if (operation.state === "completed") return;
      if (asset.lifecycleState === "initiated" || asset.lifecycleState === "failed") {
        const uploading = transitionAsset(asset, "uploading");
        await transaction.assets.update(uploading, asset.version);
        asset = uploading;
      }
      if (asset.lifecycleState === "uploading") {
        const failed = transitionAsset(asset, "failed", { failureCode: "CONTENT_STORE_FAILED" });
        await transaction.assets.update(failed, asset.version);
      }
      const updated = advanceIntegrationOperation(operation, {
        state: "retryable",
        currentStep: "store_content",
        occurredAtUtc: command.occurredAtUtc,
        nextAttemptAtUtc: command.occurredAtUtc,
        lastError: errorMessage(cause),
        incrementAttempt: true,
      });
      await transaction.integrationOperations.update(updated, operation.version);
      const steps = await transaction.integrationOperations.listSteps(operationId);
      await transaction.integrationOperations.appendStep({
        tenantId: command.tenantId,
        operationId,
        sequence: steps.length + 1,
        step: "store_content",
        attempt: updated.attempts,
        outcome: "failed",
        externalRequestId: operation.externalRequestId,
        errorCode: "CONTENT_STORE_FAILED",
        occurredAtUtc: command.occurredAtUtc,
      });
    });
  }
}

export async function listTaskAssets(
  persistence: Persistence,
  tenantId: TenantId,
  taskId: string,
): Promise<AssetView[]> {
  return await persistence.read(tenantId, async (transaction) => {
    const bindings = await transaction.assets.listBindings("task", taskId);
    const assets = await Promise.all(bindings.map(async (binding) => await transaction.assets.get(binding.assetId)));
    return assets.filter((asset): asset is Asset => asset !== undefined).map((asset) => toAssetView(asset, taskId));
  });
}

function toAssetView(asset: Asset, taskId: string): AssetView {
  return {
    id: asset.id,
    taskId,
    nodeId: asset.ownerNodeId,
    name: asset.displayName,
    contentType: asset.contentType,
    size: asset.size,
    sha256: asset.sha256,
    lifecycleState: asset.lifecycleState,
    scanState: asset.lifecycleState === "available" ? "available"
      : asset.lifecycleState === "quarantined" ? "quarantined"
      : asset.lifecycleState === "scanning" ? "scanning" : "failed",
    version: asset.version,
  };
}

async function readReplay(
  transaction: TransactionContext,
  scope: CommandScope,
  fingerprint: string,
): Promise<AssetView | undefined> {
  const previous = await transaction.receipts.get<AssetView>(scope);
  if (previous === undefined) return undefined;
  if (previous.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
  return structuredClone(previous.result);
}

async function requiredAsset(transaction: TransactionContext, assetId: string): Promise<Asset> {
  const asset = await transaction.assets.get(assetId);
  if (asset === undefined) throw new Error("ASSET_NOT_FOUND");
  return asset;
}

async function requiredOperation(transaction: TransactionContext, operationId: string): Promise<IntegrationOperation> {
  const operation = await transaction.integrationOperations.get(operationId);
  if (operation === undefined) throw new Error("INTEGRATION_OPERATION_NOT_FOUND");
  return operation;
}

async function appendEvent(
  transaction: TransactionContext,
  command: AttachTaskAssetCommand,
  asset: Asset,
  eventType: string,
  eventId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const event: DomainEvent = {
    tenantId: command.tenantId,
    eventId,
    projectId: command.projectId,
    projectSequence: await transaction.sequences.next(command.projectId),
    aggregateType: "asset",
    aggregateId: asset.id,
    aggregateVersion: asset.version,
    eventType,
    schemaVersion: 1,
    actorPrincipalId: command.principalId,
    occurredAtUtc: command.occurredAtUtc,
    correlationId: command.correlationId,
    causationId: command.commandId,
    originalSecurityDomainId: asset.securityDomainId,
    originalSecurityEpoch: asset.securityEpoch,
    payload,
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

function projectionJob(command: AttachTaskAssetCommand, asset: Asset): BackgroundJob {
  return {
    tenantId: command.tenantId,
    id: `job:collaboration-asset:${asset.id}:v${asset.version}`,
    jobType: "collaboration.asset.project",
    dedupeKey: `${asset.id}:v${asset.version}`,
    payload: { assetId: asset.id, taskId: command.taskId, desiredVersion: asset.version, correlationId: command.correlationId },
    state: "pending",
    priority: 40,
    availableAtUtc: command.occurredAtUtc,
    attempts: 0,
    maxAttempts: 8,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAtUtc: null,
    lastError: null,
    completedAtUtc: null,
    createdAtUtc: command.occurredAtUtc,
  };
}

function validate(command: AttachTaskAssetCommand): void {
  for (const [name, value] of Object.entries({
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId,
    principalId: command.principalId,
    projectId: command.projectId,
    taskId: command.taskId,
    assetId: command.assetId,
    displayName: command.displayName,
    contentType: command.contentType,
    sha256: command.sha256,
  })) if (String(value).trim().length === 0) throw new Error(`${name} is required`);
  if (command.bytes.byteLength === 0) throw new Error("ASSET_CONTENT_REQUIRED");
  if (Number.isNaN(Date.parse(command.occurredAtUtc)) || Number.isNaN(Date.parse(command.deadlineAtUtc))) throw new Error("INVALID_TIMESTAMP");
  if (Date.parse(command.deadlineAtUtc) <= Date.parse(command.occurredAtUtc)) throw new Error("INVALID_OPERATION_DEADLINE");
}

function hash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
