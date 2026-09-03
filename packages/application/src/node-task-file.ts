import { createHash } from "node:crypto";
import type {
  BlobAdapter,
  BlobScanState,
  TaskAdapter,
  TaskAuthorityStatus,
  TaskFileAdapter,
} from "../../adapters/src/ports.ts";
import {
  type AnyDomainEvent,
  type EventEnvelope,
  InMemoryTransactionalStore,
  type OutboxMessage,
  type ProjectNode,
} from "../../domain/src/outbox.ts";

const TASK_MAPPING = "node_task_mapping";
const FILE_METADATA = "task_file_metadata";
const SAGA = "node_task_file_saga";
const inFlightByStore = new WeakMap<InMemoryTransactionalStore, Map<string, Promise<unknown>>>();

export type TaskMapping = {
  id: string;
  projectId: string;
  ownerNodeId: string;
  securityDomainId: string | null;
  authorityRef: string;
  syncWatermark: string;
  version: number;
};

export type FileMetadata = {
  id: string;
  projectId: string;
  ownerObjectType: "task";
  ownerObjectId: string;
  ownerNodeId: string;
  securityDomainId: string | null;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  scanState: BlobScanState;
  blobAuthorityRef: string;
  fileAuthorityRef: string;
  syncWatermark: string;
  version: number;
};

type SagaStatus = "started" | "blob_uploaded" | "authority_created" | "completed" | "retryable" | "compensated" | "recovery_required";

export type IntegrationSaga = {
  id: string;
  operation: "create_task" | "attach_task_file";
  fingerprint: string;
  status: SagaStatus;
  projectId: string;
  actorId: string;
  authorityRef?: string;
  blobAuthorityRef?: string;
  failure?: string | undefined;
};

export type CreateTaskCommand = {
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  actorId: string;
  projectId: string;
  nodeId: string;
  taskId: string;
  title: string;
  status: TaskAuthorityStatus;
  occurredAtUtc: string;
};

export type AttachTaskFileCommand = {
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  actorId: string;
  projectId: string;
  taskId: string;
  fileId: string;
  name: string;
  contentType: string;
  bytes: Uint8Array;
  sha256: string;
  occurredAtUtc: string;
};

export type TaskView = {
  id: string;
  nodeId: string;
  title: string;
  status: TaskAuthorityStatus;
  version: number;
};

export type FileView = {
  id: string;
  taskId: string;
  nodeId: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  scanState: BlobScanState;
  version: number;
};

export type CommandResult<T> = { value: T; replayed: boolean };
export type NodeDetail = { node: ProjectNode; tasks: Array<TaskView & { files: FileView[] }> };
export type LocalFailurePoint = "after_projection" | "after_event" | "after_outbox";

type TaskLinkedEvent = EventEnvelope<
  "task_mapping",
  "project-map.task.linked.v1",
  null,
  Omit<TaskMapping, "authorityRef">
>;

type FileAttachedEvent = EventEnvelope<
  "file_metadata",
  "project-map.file.attached.v1",
  null,
  Omit<FileMetadata, "blobAuthorityRef" | "fileAuthorityRef">
>;

export class ApplicationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ApplicationError";
    this.code = code;
  }
}

function required(name: string, value: string): void {
  if (value.trim().length === 0) throw new ApplicationError("VALIDATION_FAILED", `${name} is required`);
}

function validateUtc(value: string): void {
  if (!value.endsWith("Z") || Number.isNaN(Date.parse(value))) {
    throw new ApplicationError("VALIDATION_FAILED", "occurredAtUtc must be a valid UTC timestamp");
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function commandKey(actorId: string, operation: IntegrationSaga["operation"], idempotencyKey: string): string {
  return `${actorId}\u0000${operation}\u0000${idempotencyKey}`;
}

function authorityKey(sagaId: string): string {
  return createHash("sha256").update(sagaId).digest("base64url");
}

function injectFailure(expected: LocalFailurePoint | undefined, actual: LocalFailurePoint): void {
  if (expected === actual) throw new Error(`Injected failure: ${actual}`);
}

function eventOutbox<TEvent extends AnyDomainEvent>(event: TEvent): OutboxMessage<TEvent> {
  return { id: `outbox:${event.eventId}`, eventId: event.eventId, topic: event.eventType, payload: event };
}

export class NodeTaskFileService {
  readonly #inFlight: Map<string, Promise<unknown>>;
  readonly store: InMemoryTransactionalStore;
  readonly taskAdapter: TaskAdapter;
  readonly blobAdapter: BlobAdapter;
  readonly taskFileAdapter: TaskFileAdapter;

  constructor(
    store: InMemoryTransactionalStore,
    taskAdapter: TaskAdapter,
    blobAdapter: BlobAdapter,
    taskFileAdapter: TaskFileAdapter,
  ) {
    this.store = store;
    this.taskAdapter = taskAdapter;
    this.blobAdapter = blobAdapter;
    this.taskFileAdapter = taskFileAdapter;
    const inFlight = inFlightByStore.get(store) ?? new Map<string, Promise<unknown>>();
    inFlightByStore.set(store, inFlight);
    this.#inFlight = inFlight;
  }

  async createTask(command: CreateTaskCommand, failurePoint?: LocalFailurePoint): Promise<CommandResult<TaskView>> {
    const key = commandKey(command.actorId, "create_task", command.idempotencyKey);
    return await this.runExclusive(key, async () => await this.createTaskOnce(command, key, failurePoint));
  }

  async attachTaskFile(command: AttachTaskFileCommand, failurePoint?: LocalFailurePoint): Promise<CommandResult<FileView>> {
    const key = commandKey(command.actorId, "attach_task_file", command.idempotencyKey);
    return await this.runExclusive(key, async () => await this.attachTaskFileOnce(command, key, failurePoint));
  }

  async getNodeDetail(nodeId: string): Promise<NodeDetail> {
    const node = this.store.getNode(nodeId);
    if (node === undefined) throw new ApplicationError("NODE_NOT_FOUND", `Node not found: ${nodeId}`);
    const mappings = this.store.listProjections<TaskMapping>(TASK_MAPPING).filter((mapping) => mapping.ownerNodeId === nodeId);
    const files = this.store.listProjections<FileMetadata>(FILE_METADATA);
    const tasks = await Promise.all(mappings.map(async (mapping): Promise<TaskView & { files: FileView[] }> => {
      const authority = await this.taskAdapter.get(mapping.authorityRef);
      if (authority === undefined) throw new ApplicationError("TASK_AUTHORITY_UNAVAILABLE", `Task authority unavailable: ${mapping.id}`);
      return {
        id: mapping.id,
        nodeId: mapping.ownerNodeId,
        title: authority.title,
        status: authority.status,
        version: mapping.version,
        files: files.filter((file) => file.ownerObjectId === mapping.id).map(toFileView),
      };
    }));
    return { node, tasks };
  }

  private async createTaskOnce(
    command: CreateTaskCommand,
    key: string,
    failurePoint: LocalFailurePoint | undefined,
  ): Promise<CommandResult<TaskView>> {
    validateTaskCommand(command);
    const fingerprint = hash({
      projectId: command.projectId,
      nodeId: command.nodeId,
      taskId: command.taskId,
      title: command.title,
      status: command.status,
    });
    const replay = this.readReplay<TaskView>(key, fingerprint);
    if (replay !== undefined) return { value: replay, replayed: true };
    const node = this.requireTaskNode(command.nodeId, command.projectId);
    const saga = this.beginSaga(key, "create_task", fingerprint, command.projectId, command.actorId);
    if (saga.status === "recovery_required") throw new ApplicationError("SAGA_RECOVERY_REQUIRED", saga.failure ?? "Saga recovery required");

    let authority = saga.authorityRef === undefined ? undefined : await this.taskAdapter.get(saga.authorityRef);
    try {
      authority ??= await this.taskAdapter.create({
        authorityKey: authorityKey(key),
        title: command.title,
        status: command.status,
      });
      this.updateSaga(key, { ...saga, status: "authority_created", authorityRef: authority.authorityRef, failure: undefined });
    } catch (error) {
      this.updateSaga(key, { ...saga, status: "retryable", failure: errorMessage(error) });
      throw error;
    }

    const mapping: TaskMapping = {
      id: command.taskId,
      projectId: command.projectId,
      ownerNodeId: node.id,
      securityDomainId: node.securityDomainId,
      authorityRef: authority.authorityRef,
      syncWatermark: authority.syncWatermark,
      version: 1,
    };
    const value: TaskView = {
      id: mapping.id,
      nodeId: mapping.ownerNodeId,
      title: authority.title,
      status: authority.status,
      version: mapping.version,
    };

    try {
      this.store.transaction((transaction) => {
        if (transaction.getProjection<TaskMapping>(TASK_MAPPING, mapping.id) !== undefined) {
          throw new ApplicationError("TASK_ALREADY_EXISTS", `Task already exists: ${mapping.id}`);
        }
        transaction.putProjection(TASK_MAPPING, mapping.id, mapping);
        injectFailure(failurePoint, "after_projection");
        const event = taskLinkedEvent(command, mapping, transaction.nextProjectSequence(command.projectId));
        transaction.appendEvent(event);
        injectFailure(failurePoint, "after_event");
        transaction.enqueue(eventOutbox(event));
        injectFailure(failurePoint, "after_outbox");
        transaction.putCommand(key, { fingerprint, result: value });
        transaction.setProjection(SAGA, key, { ...saga, status: "completed", authorityRef: authority.authorityRef });
      });
    } catch (error) {
      await this.compensateTask(key, saga, authority.authorityRef, error);
      throw error;
    }
    return { value, replayed: false };
  }

  private async attachTaskFileOnce(
    command: AttachTaskFileCommand,
    key: string,
    failurePoint: LocalFailurePoint | undefined,
  ): Promise<CommandResult<FileView>> {
    validateFileCommand(command);
    const actualSha = createHash("sha256").update(command.bytes).digest("hex");
    if (actualSha !== command.sha256) throw new ApplicationError("FILE_HASH_MISMATCH", "sha256 does not match file bytes");
    const fingerprint = hash({
      projectId: command.projectId,
      taskId: command.taskId,
      fileId: command.fileId,
      name: command.name,
      contentType: command.contentType,
      size: command.bytes.byteLength,
      sha256: command.sha256,
    });
    const replay = this.readReplay<FileView>(key, fingerprint);
    if (replay !== undefined) return { value: replay, replayed: true };
    const mapping = this.store.getProjection<TaskMapping>(TASK_MAPPING, command.taskId);
    if (mapping === undefined) throw new ApplicationError("TASK_NOT_FOUND", `Task not found: ${command.taskId}`);
    if (mapping.projectId !== command.projectId) throw new ApplicationError("PROJECT_MISMATCH", "Task belongs to a different project");
    const node = this.requireTaskNode(mapping.ownerNodeId, command.projectId);
    if (node.securityDomainId !== mapping.securityDomainId) throw new ApplicationError("SECURITY_DOMAIN_MISMATCH", "Task security domain is stale");
    const saga = this.beginSaga(key, "attach_task_file", fingerprint, command.projectId, command.actorId);
    if (saga.status === "recovery_required") throw new ApplicationError("SAGA_RECOVERY_REQUIRED", saga.failure ?? "Saga recovery required");

    let blob = saga.blobAuthorityRef === undefined ? undefined : await this.blobAdapter.get(saga.blobAuthorityRef);
    try {
      blob ??= await this.blobAdapter.upload({
        authorityKey: authorityKey(`${key}:blob`),
        contentType: command.contentType,
        bytes: command.bytes,
        sha256: command.sha256,
      });
      this.updateSaga(key, { ...saga, status: "blob_uploaded", blobAuthorityRef: blob.authorityRef, failure: undefined });
    } catch (error) {
      this.updateSaga(key, { ...saga, status: "retryable", failure: errorMessage(error) });
      throw error;
    }

    let attachment = saga.authorityRef === undefined ? undefined : await this.taskFileAdapter.get(saga.authorityRef);
    try {
      attachment ??= await this.taskFileAdapter.attach({
        authorityKey: authorityKey(`${key}:attachment`),
        taskAuthorityRef: mapping.authorityRef,
        blobAuthorityRef: blob.authorityRef,
        name: command.name,
        contentType: command.contentType,
        size: blob.size,
      });
      this.updateSaga(key, {
        ...saga,
        status: "authority_created",
        authorityRef: attachment.authorityRef,
        blobAuthorityRef: blob.authorityRef,
        failure: undefined,
      });
    } catch (error) {
      this.updateSaga(key, { ...saga, status: "blob_uploaded", blobAuthorityRef: blob.authorityRef, failure: errorMessage(error) });
      throw error;
    }

    const metadata: FileMetadata = {
      id: command.fileId,
      projectId: command.projectId,
      ownerObjectType: "task",
      ownerObjectId: mapping.id,
      ownerNodeId: mapping.ownerNodeId,
      securityDomainId: mapping.securityDomainId,
      name: command.name,
      contentType: command.contentType,
      size: blob.size,
      sha256: blob.sha256,
      scanState: blob.scanState,
      blobAuthorityRef: blob.authorityRef,
      fileAuthorityRef: attachment.authorityRef,
      syncWatermark: attachment.syncWatermark,
      version: 1,
    };
    const value = toFileView(metadata);

    try {
      this.store.transaction((transaction) => {
        if (transaction.getProjection<FileMetadata>(FILE_METADATA, metadata.id) !== undefined) {
          throw new ApplicationError("FILE_ALREADY_EXISTS", `File already exists: ${metadata.id}`);
        }
        transaction.putProjection(FILE_METADATA, metadata.id, metadata);
        injectFailure(failurePoint, "after_projection");
        const event = fileAttachedEvent(command, metadata, transaction.nextProjectSequence(command.projectId));
        transaction.appendEvent(event);
        injectFailure(failurePoint, "after_event");
        transaction.enqueue(eventOutbox(event));
        injectFailure(failurePoint, "after_outbox");
        transaction.putCommand(key, { fingerprint, result: value });
        transaction.setProjection(SAGA, key, {
          ...saga,
          status: "completed",
          authorityRef: attachment.authorityRef,
          blobAuthorityRef: blob.authorityRef,
        });
      });
    } catch (error) {
      await this.compensateFile(key, saga, attachment.authorityRef, blob.authorityRef, error);
      throw error;
    }
    return { value, replayed: false };
  }

  private requireTaskNode(nodeId: string, projectId: string): ProjectNode {
    const node = this.store.getNode(nodeId);
    if (node === undefined) throw new ApplicationError("NODE_NOT_FOUND", `Node not found: ${nodeId}`);
    if (node.projectId !== projectId) throw new ApplicationError("PROJECT_MISMATCH", "Node belongs to a different project");
    if (node.kind === "milestone") throw new ApplicationError("MILESTONE_TASK_FORBIDDEN", "Milestones cannot contain tasks");
    return node;
  }

  private beginSaga(
    id: string,
    operation: IntegrationSaga["operation"],
    fingerprint: string,
    projectId: string,
    actorId: string,
  ): IntegrationSaga {
    return this.store.transaction((transaction) => {
      const previous = transaction.getProjection<IntegrationSaga>(SAGA, id);
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint) throw new ApplicationError("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", "Idempotency key was reused with different payload");
        return structuredClone(previous);
      }
      const saga: IntegrationSaga = { id, operation, fingerprint, status: "started", projectId, actorId };
      transaction.putProjection(SAGA, id, saga);
      return saga;
    });
  }

  private readReplay<T>(key: string, fingerprint: string): T | undefined {
    return this.store.transaction((transaction) => {
      const previous = transaction.getCommand<T>(key);
      if (previous === undefined) return undefined;
      if (previous.fingerprint !== fingerprint) throw new ApplicationError("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", "Idempotency key was reused with different payload");
      return structuredClone(previous.result);
    });
  }

  private updateSaga(key: string, saga: IntegrationSaga): void {
    this.store.transaction((transaction) => transaction.setProjection(SAGA, key, saga));
  }

  private async compensateTask(key: string, saga: IntegrationSaga, authorityRef: string, cause: unknown): Promise<void> {
    try {
      await this.taskAdapter.remove(authorityRef);
      this.updateSaga(key, { ...saga, status: "compensated", failure: errorMessage(cause) });
    } catch (compensationError) {
      this.updateSaga(key, {
        ...saga,
        status: "recovery_required",
        authorityRef,
        failure: `${errorMessage(cause)}; compensation: ${errorMessage(compensationError)}`,
      });
    }
  }

  private async compensateFile(
    key: string,
    saga: IntegrationSaga,
    authorityRef: string,
    blobAuthorityRef: string,
    cause: unknown,
  ): Promise<void> {
    try {
      await this.taskFileAdapter.remove(authorityRef);
      await this.blobAdapter.remove(blobAuthorityRef);
      this.updateSaga(key, { ...saga, status: "compensated", failure: errorMessage(cause) });
    } catch (compensationError) {
      this.updateSaga(key, {
        ...saga,
        status: "recovery_required",
        authorityRef,
        blobAuthorityRef,
        failure: `${errorMessage(cause)}; compensation: ${errorMessage(compensationError)}`,
      });
    }
  }

  private async runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.#inFlight.get(key);
    if (existing !== undefined) await existing;
    const promise = operation();
    this.#inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.#inFlight.get(key) === promise) this.#inFlight.delete(key);
    }
  }
}

function validateTaskCommand(command: CreateTaskCommand): void {
  for (const [name, value] of Object.entries({
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId,
    actorId: command.actorId,
    projectId: command.projectId,
    nodeId: command.nodeId,
    taskId: command.taskId,
    title: command.title,
  })) required(name, value);
  validateUtc(command.occurredAtUtc);
}

function validateFileCommand(command: AttachTaskFileCommand): void {
  for (const [name, value] of Object.entries({
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId,
    actorId: command.actorId,
    projectId: command.projectId,
    taskId: command.taskId,
    fileId: command.fileId,
    name: command.name,
    contentType: command.contentType,
    sha256: command.sha256,
  })) required(name, value);
  if (command.bytes.byteLength === 0) throw new ApplicationError("VALIDATION_FAILED", "file bytes are required");
  validateUtc(command.occurredAtUtc);
}

function taskLinkedEvent(command: CreateTaskCommand, mapping: TaskMapping, projectSequence: number): TaskLinkedEvent {
  const { authorityRef: _authorityRef, ...after } = mapping;
  return {
    eventId: `evt:${command.commandId}`,
    projectId: command.projectId,
    projectSequence,
    aggregateType: "task_mapping",
    aggregateId: mapping.id,
    aggregateVersion: mapping.version,
    eventType: "project-map.task.linked.v1",
    actorId: command.actorId,
    occurredAtUtc: command.occurredAtUtc,
    correlationId: command.correlationId,
    causationId: command.commandId,
    originalSecurityDomainId: mapping.securityDomainId,
    before: null,
    after,
    schemaVersion: 1,
  };
}

function fileAttachedEvent(command: AttachTaskFileCommand, metadata: FileMetadata, projectSequence: number): FileAttachedEvent {
  const { blobAuthorityRef: _blobAuthorityRef, fileAuthorityRef: _fileAuthorityRef, ...after } = metadata;
  return {
    eventId: `evt:${command.commandId}`,
    projectId: command.projectId,
    projectSequence,
    aggregateType: "file_metadata",
    aggregateId: metadata.id,
    aggregateVersion: metadata.version,
    eventType: "project-map.file.attached.v1",
    actorId: command.actorId,
    occurredAtUtc: command.occurredAtUtc,
    correlationId: command.correlationId,
    causationId: command.commandId,
    originalSecurityDomainId: metadata.securityDomainId,
    before: null,
    after,
    schemaVersion: 1,
  };
}

function toFileView(metadata: FileMetadata): FileView {
  return {
    id: metadata.id,
    taskId: metadata.ownerObjectId,
    nodeId: metadata.ownerNodeId,
    name: metadata.name,
    contentType: metadata.contentType,
    size: metadata.size,
    sha256: metadata.sha256,
    scanState: metadata.scanState,
    version: metadata.version,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
