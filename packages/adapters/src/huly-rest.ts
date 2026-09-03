import { createHash, randomUUID } from "node:crypto";
import type {
  BlobScanState,
  AttachFileProjection,
  CollaborationTaskStatus,
  CreateTaskProjection,
  ExternalBlobProjectionPort,
  StoredAssetContent,
  TaskFileProjectionPort,
  TaskFileProjectionRecord,
  TaskProjectionPort,
  TaskProjectionRecord,
} from "../../application/src/ports/integrations.ts";
import { IntegrationCallError } from "../../application/src/ports/integrations.ts";
import { externalReference, type ExternalReference } from "../../domain/src/external-reference.ts";

const HULY_IDS = {
  issueClass: "tracker:class:Issue",
  projectClass: "tracker:class:Project",
  taskTypeClass: "task:class:TaskType",
  attachmentClass: "attachment:class:Attachment",
  noParent: "tracker:ids:NoParent",
  txSpace: "core:space:Tx",
  spaceSpace: "core:space:Space",
  txCreateDoc: "core:class:TxCreateDoc",
  txUpdateDoc: "core:class:TxUpdateDoc",
  txRemoveDoc: "core:class:TxRemoveDoc",
} as const;

type JsonObject = Record<string, unknown>;

export type HulyRestConfig = {
  transactionEndpoint: string;
  fileEndpoint: string;
  workspaceId: string;
  projectId: string;
  actorToken: string;
  taskTypeId?: string;
  statusIds?: Partial<Record<CollaborationTaskStatus, string>>;
  blobScanState?: BlobScanState;
  requestTimeoutMilliseconds?: number;
};

class HulyRestConnection {
  readonly transactionEndpoint: string;
  readonly fileEndpoint: string;
  readonly config: HulyRestConfig;

  constructor(config: HulyRestConfig) {
    this.config = config;
    this.transactionEndpoint = config.transactionEndpoint.replace(/\/$/, "").replace(/^ws/, "http");
    this.fileEndpoint = config.fileEndpoint.replace(/\/$/, "");
  }

  async health(): Promise<"ok" | "degraded"> {
    try {
      await this.account();
      return "ok";
    } catch {
      return "degraded";
    }
  }

  async account(): Promise<JsonObject> {
    const result = await this.requestJson(`${this.transactionEndpoint}/api/v1/account/${encodeURIComponent(this.config.workspaceId)}`);
    if (!isObject(result)) throw new Error("HULY_ACCOUNT_RESPONSE_INVALID");
    return result;
  }

  async actorId(): Promise<string> {
    const account = await this.account();
    const socialIds = account.socialIds;
    if (!Array.isArray(socialIds) || typeof socialIds[0] !== "string") throw new Error("HULY_ACCOUNT_HAS_NO_SOCIAL_ID");
    return socialIds[0];
  }

  async findOne(classId: string, query: JsonObject): Promise<JsonObject | undefined> {
    const parameters = new URLSearchParams({ class: classId, query: JSON.stringify(query), options: JSON.stringify({ limit: 1 }) });
    const result = await this.requestJson(`${this.transactionEndpoint}/api/v1/find-all/${encodeURIComponent(this.config.workspaceId)}?${parameters}`);
    const values = Array.isArray(result)
      ? result
      : isObject(result) && Array.isArray(result.value)
        ? result.value
        : undefined;
    if (values === undefined) throw new Error("HULY_FIND_RESPONSE_INVALID");
    return values[0] as JsonObject | undefined;
  }

  async tx(transaction: JsonObject): Promise<JsonObject> {
    const result = await this.requestJson(
      `${this.transactionEndpoint}/api/v1/tx/${encodeURIComponent(this.config.workspaceId)}`,
      { method: "POST", body: JSON.stringify(transaction) },
    );
    if (!isObject(result)) throw new Error("HULY_TX_RESPONSE_INVALID");
    return result;
  }

  async upload(blobId: string, contentType: string, bytes: Uint8Array): Promise<string> {
    const form = new FormData();
    form.append("file", new File([bytes.slice().buffer as ArrayBuffer], blobId, { type: contentType }));
    const result = await this.requestJson(
      `${this.fileEndpoint}/${encodeURIComponent(this.config.workspaceId)}`,
      { method: "POST", body: form },
      false,
    );
    if (!Array.isArray(result) || !isObject(result[0]) || typeof result[0].id !== "string") {
      throw new Error("HULY_FILE_UPLOAD_RESPONSE_INVALID");
    }
    return result[0].id;
  }

  async blobExists(blobId: string): Promise<boolean> {
    const response = await this.fetchResponse(this.fileUrl(blobId), { method: "HEAD", headers: this.authHeaders(false) }, true);
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`HULY_FILE_HEAD_FAILED:${response.status}`);
    return true;
  }

  async removeBlob(blobId: string): Promise<void> {
    const response = await this.fetchResponse(this.fileUrl(blobId), { method: "DELETE", headers: this.authHeaders(false) }, true);
    if (response.status === 404) return;
    if (!response.ok) throw new Error(`HULY_FILE_DELETE_FAILED:${response.status}`);
  }

  createTx(actorId: string, objectClass: string, objectSpace: string, objectId: string, attributes: JsonObject): JsonObject {
    return {
      _id: randomId(),
      _class: HULY_IDS.txCreateDoc,
      space: HULY_IDS.txSpace,
      objectId,
      objectClass,
      objectSpace,
      modifiedOn: Date.now(),
      modifiedBy: actorId,
      createdBy: actorId,
      attributes,
    };
  }

  collectionTx(transaction: JsonObject, attachedTo: string, attachedToClass: string, collection: string): JsonObject {
    return { ...transaction, attachedTo, attachedToClass, collection };
  }

  removeTx(actorId: string, objectClass: string, objectSpace: string, objectId: string): JsonObject {
    return {
      _id: randomId(),
      _class: HULY_IDS.txRemoveDoc,
      space: HULY_IDS.txSpace,
      objectId,
      objectClass,
      objectSpace,
      modifiedOn: Date.now(),
      modifiedBy: actorId,
    };
  }

  private fileUrl(blobId: string): string {
    const workspace = encodeURIComponent(this.config.workspaceId);
    const file = encodeURIComponent(blobId);
    return `${this.fileEndpoint}/${workspace}/${file}?file=${file}&workspace=${workspace}`;
  }

  private authHeaders(json: boolean): HeadersInit {
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      authorization: `Bearer ${this.config.actorToken}`,
    };
  }

  private async requestJson(url: string, init: RequestInit = {}, json = true): Promise<unknown> {
    const response = await this.fetchResponse(url, { ...init, headers: { ...this.authHeaders(json), ...init.headers } });
    const result: unknown = await response.json();
    if (isObject(result) && result.error !== undefined) throw new Error(`HULY_RESPONSE_ERROR:${JSON.stringify(result.error)}`);
    return result;
  }

  private async fetchResponse(url: string, init: RequestInit, allowNotFound = false): Promise<Response> {
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMilliseconds ?? 10_000);
    const signal = init.signal == null ? timeout : AbortSignal.any([init.signal, timeout]);
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal });
    } catch (error) {
      const timedOut = timeout.aborted;
      throw new IntegrationCallError(
        timedOut ? "HULY_REQUEST_TIMEOUT" : "HULY_NETWORK_FAILURE",
        timedOut ? "Huly request exceeded its deadline" : errorMessage(error),
        { retryable: true, outcome: "ambiguous" },
      );
    }
    if (!response.ok && !(allowNotFound && response.status === 404)) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new IntegrationCallError(
        `HULY_HTTP_${response.status}`,
        `Huly request failed with HTTP ${response.status}`,
        { retryable, outcome: "known_failed" },
      );
    }
    return response;
  }
}

export class HulyRestTaskProjectionAdapter implements TaskProjectionPort {
  readonly #connection: HulyRestConnection;

  constructor(config: HulyRestConfig) {
    this.#connection = new HulyRestConnection(config);
  }

  async health(): Promise<"ok" | "degraded"> {
    return await this.#connection.health();
  }

  async create(task: CreateTaskProjection): Promise<TaskProjectionRecord> {
    const issueId = deterministicId(`task:${task.requestId}`);
    const existing = await this.#connection.findOne(HULY_IDS.issueClass, { _id: issueId });
    if (existing !== undefined) return this.toRecord(existing, issueId, task);

    const project = await this.#connection.findOne(HULY_IDS.projectClass, { _id: this.#connection.config.projectId });
    if (project === undefined) throw new Error("HULY_PROJECT_NOT_FOUND");
    const actorId = await this.#connection.actorId();
    const status = this.statusId(task.status, project);
    const kind = await this.taskTypeId(project);
    const sequenceResult = await this.#connection.tx({
      _id: randomId(),
      _class: HULY_IDS.txUpdateDoc,
      space: HULY_IDS.txSpace,
      objectId: this.#connection.config.projectId,
      objectClass: HULY_IDS.projectClass,
      objectSpace: HULY_IDS.spaceSpace,
      modifiedOn: Date.now(),
      modifiedBy: actorId,
      operations: { $inc: { sequence: 1 } },
      retrieve: true,
    });
    const updatedProject = sequenceResult.object;
    if (!isObject(updatedProject) || typeof updatedProject.sequence !== "number") throw new Error("HULY_PROJECT_SEQUENCE_RESPONSE_INVALID");
    if (typeof project.identifier !== "string") throw new Error("HULY_PROJECT_IDENTIFIER_MISSING");
    const number = updatedProject.sequence;
    const transaction = this.#connection.collectionTx(
      this.#connection.createTx(actorId, HULY_IDS.issueClass, this.#connection.config.projectId, issueId, {
        title: task.title,
        description: null,
        assignee: null,
        component: null,
        milestone: null,
        number,
        status,
        priority: 0,
        rank: "",
        comments: 0,
        subIssues: 0,
        dueDate: null,
        parents: [],
        reportedTime: 0,
        remainingTime: 0,
        estimation: 0,
        reports: 0,
        relations: [],
        childInfo: [],
        kind,
        identifier: `${project.identifier}-${number}`,
      }),
      HULY_IDS.noParent,
      HULY_IDS.issueClass,
      "subIssues",
    );
    try {
      await this.#connection.tx(transaction);
    } catch (error) {
      const reconciled = await this.#connection.findOne(HULY_IDS.issueClass, { _id: issueId });
      if (reconciled === undefined) throw error;
      return this.toRecord(reconciled, issueId, task);
    }
    const created = await this.#connection.findOne(HULY_IDS.issueClass, { _id: issueId });
    if (created === undefined) throw new Error("HULY_TASK_CREATE_NOT_VISIBLE");
    return this.toRecord(created, issueId, task);
  }

  async get(reference: ExternalReference): Promise<TaskProjectionRecord | undefined> {
    const issueId = hulyId(reference, "task");
    const issue = await this.#connection.findOne(HULY_IDS.issueClass, { _id: issueId });
    return issue === undefined ? undefined : this.toRecord(issue, issueId);
  }

  async remove(reference: ExternalReference, expectedSyncWatermark: string): Promise<void> {
    const issueId = hulyId(reference, "task");
    const issue = await this.#connection.findOne(HULY_IDS.issueClass, { _id: issueId });
    if (issue === undefined) return;
    if (String(issue.modifiedOn ?? "0") !== expectedSyncWatermark) throw new Error("HULY_SYNC_WATERMARK_CONFLICT");
    const actorId = await this.#connection.actorId();
    await this.#connection.tx(this.#connection.collectionTx(
      this.#connection.removeTx(actorId, HULY_IDS.issueClass, this.#connection.config.projectId, issueId),
      HULY_IDS.noParent,
      HULY_IDS.issueClass,
      "subIssues",
    ));
  }

  private async taskTypeId(project: JsonObject): Promise<string> {
    if (this.#connection.config.taskTypeId !== undefined) return this.#connection.config.taskTypeId;
    if (typeof project.type !== "string") throw new Error("HULY_PROJECT_TYPE_MISSING");
    const taskType = await this.#connection.findOne(HULY_IDS.taskTypeClass, { parent: project.type, kind: { $in: ["task", "both"] } });
    if (taskType === undefined || typeof taskType._id !== "string") throw new Error("HULY_TASK_TYPE_NOT_FOUND");
    return taskType._id;
  }

  private statusId(status: CollaborationTaskStatus, project: JsonObject): string {
    const configured = this.#connection.config.statusIds?.[status];
    if (configured !== undefined) return configured;
    if (status === "todo" && typeof project.defaultIssueStatus === "string") return project.defaultIssueStatus;
    const defaults: Record<CollaborationTaskStatus, string> = {
      todo: "tracker:status:Todo",
      in_progress: "tracker:status:InProgress",
      completed: "tracker:status:Done",
      canceled: "tracker:status:Canceled",
    };
    return defaults[status];
  }

  private toRecord(issue: JsonObject, issueId: string, expected?: CreateTaskProjection): TaskProjectionRecord {
    if (typeof issue.title !== "string" || typeof issue.status !== "string") throw new Error("HULY_TASK_RESPONSE_INVALID");
    if (expected !== undefined && issue.title !== expected.title) throw new Error("HULY_DETERMINISTIC_ID_CONFLICT");
    return {
      reference: externalReference("huly", "task", issueId),
      title: issue.title,
      status: this.fromStatusId(issue.status),
      syncWatermark: String(issue.modifiedOn ?? "0"),
    };
  }

  private fromStatusId(statusId: string): CollaborationTaskStatus {
    for (const [status, configured] of Object.entries(this.#connection.config.statusIds ?? {})) {
      if (configured === statusId) return status as CollaborationTaskStatus;
    }
    if (statusId.endsWith(":Todo") || statusId.endsWith(":Backlog")) return "todo";
    if (statusId.endsWith(":InProgress") || statusId.endsWith(":Coding") || statusId.endsWith(":UnderReview")) return "in_progress";
    if (statusId.endsWith(":Done")) return "completed";
    if (statusId.endsWith(":Canceled")) return "canceled";
    throw new Error(`HULY_TASK_STATUS_UNMAPPED:${statusId}`);
  }
}

export async function resolveHulyActorId(config: HulyRestConfig): Promise<string> {
  return await new HulyRestConnection(config).actorId();
}

export class HulyRestBlobProjectionAdapter implements ExternalBlobProjectionPort {
  readonly #connection: HulyRestConnection;

  constructor(config: HulyRestConfig) {
    this.#connection = new HulyRestConnection(config);
  }

  async health(): Promise<"ok" | "degraded"> {
    return await this.#connection.health();
  }

  async put(blob: Omit<import("../../application/src/ports/integrations.ts").PutAssetContent, "tenantId">): Promise<StoredAssetContent> {
    const blobId = deterministicId(`blob:${blob.requestId}`);
    const reference = externalReference("huly", "blob", blobId);
    if (!await this.#connection.blobExists(blobId)) {
      const uploadedId = await this.#connection.upload(blobId, blob.contentType, blob.bytes);
      if (uploadedId !== blobId) throw new Error("HULY_BLOB_ID_MISMATCH");
    }
    return {
      reference,
      contentType: blob.contentType,
      size: blob.bytes.byteLength,
      sha256: blob.sha256,
      scanState: this.#connection.config.blobScanState ?? "scanning",
    };
  }

  async exists(reference: ExternalReference): Promise<boolean> {
    return await this.#connection.blobExists(hulyId(reference, "blob"));
  }

  async remove(reference: ExternalReference): Promise<void> {
    await this.#connection.removeBlob(hulyId(reference, "blob"));
  }
}

export class HulyRestTaskFileProjectionAdapter implements TaskFileProjectionPort {
  readonly #connection: HulyRestConnection;

  constructor(config: HulyRestConfig) {
    this.#connection = new HulyRestConnection(config);
  }

  async health(): Promise<"ok" | "degraded"> {
    return await this.#connection.health();
  }

  async attach(file: AttachFileProjection): Promise<TaskFileProjectionRecord> {
    const issueId = hulyId(file.taskReference, "task");
    const blobId = hulyId(file.blobReference, "blob");
    const attachmentId = deterministicId(`attachment:${file.requestId}`);
    const existing = await this.#connection.findOne(HULY_IDS.attachmentClass, { _id: attachmentId });
    if (existing !== undefined) return this.toRecord(existing, attachmentId, issueId, file);
    const issue = await this.#connection.findOne(HULY_IDS.issueClass, { _id: issueId });
    if (issue === undefined) throw new Error("HULY_TASK_NOT_FOUND");
    const actorId = await this.#connection.actorId();
    const transaction = this.#connection.collectionTx(
      this.#connection.createTx(actorId, HULY_IDS.attachmentClass, this.#connection.config.projectId, attachmentId, {
        name: file.name,
        file: blobId,
        type: file.contentType,
        size: file.size,
        lastModified: Date.now(),
        metadata: {},
      }),
      issueId,
      HULY_IDS.issueClass,
      "attachments",
    );
    try {
      await this.#connection.tx(transaction);
    } catch (error) {
      const reconciled = await this.#connection.findOne(HULY_IDS.attachmentClass, { _id: attachmentId });
      if (reconciled === undefined) throw error;
      return this.toRecord(reconciled, attachmentId, issueId, file);
    }
    const created = await this.#connection.findOne(HULY_IDS.attachmentClass, { _id: attachmentId });
    if (created === undefined) throw new Error("HULY_ATTACHMENT_CREATE_NOT_VISIBLE");
    return this.toRecord(created, attachmentId, issueId, file);
  }

  async get(reference: ExternalReference): Promise<TaskFileProjectionRecord | undefined> {
    const attachmentId = hulyId(reference, "attachment");
    const attachment = await this.#connection.findOne(HULY_IDS.attachmentClass, { _id: attachmentId });
    if (attachment === undefined) return undefined;
    if (typeof attachment.attachedTo !== "string") throw new Error("HULY_ATTACHMENT_PARENT_INVALID");
    return this.toRecord(attachment, attachmentId, attachment.attachedTo);
  }

  async remove(reference: ExternalReference, expectedSyncWatermark: string): Promise<void> {
    const attachmentId = hulyId(reference, "attachment");
    const attachment = await this.#connection.findOne(HULY_IDS.attachmentClass, { _id: attachmentId });
    if (attachment === undefined) return;
    if (String(attachment.modifiedOn ?? "0") !== expectedSyncWatermark) throw new Error("HULY_SYNC_WATERMARK_CONFLICT");
    if (typeof attachment.attachedTo !== "string") throw new Error("HULY_ATTACHMENT_PARENT_INVALID");
    const issueId = attachment.attachedTo;
    const actorId = await this.#connection.actorId();
    await this.#connection.tx(this.#connection.collectionTx(
      this.#connection.removeTx(actorId, HULY_IDS.attachmentClass, this.#connection.config.projectId, attachmentId),
      issueId,
      HULY_IDS.issueClass,
      "attachments",
    ));
  }

  private toRecord(
    attachment: JsonObject,
    attachmentId: string,
    issueId: string,
    expected?: AttachFileProjection,
  ): TaskFileProjectionRecord {
    if (typeof attachment.file !== "string" || typeof attachment.name !== "string" || typeof attachment.type !== "string" || typeof attachment.size !== "number") {
      throw new Error("HULY_ATTACHMENT_RESPONSE_INVALID");
    }
    if (expected !== undefined && (attachment.name !== expected.name || attachment.file !== hulyId(expected.blobReference, "blob"))) {
      throw new Error("HULY_DETERMINISTIC_ID_CONFLICT");
    }
    return {
      reference: externalReference("huly", "attachment", attachmentId),
      taskReference: externalReference("huly", "task", issueId),
      blobReference: externalReference("huly", "blob", attachment.file),
      name: attachment.name,
      contentType: attachment.type,
      size: attachment.size,
      syncWatermark: String(attachment.modifiedOn ?? "0"),
    };
  }
}

function deterministicId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

function randomId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 24);
}

function hulyId(reference: ExternalReference, kind: "task" | "blob" | "attachment"): string {
  if (reference.provider !== "huly" || reference.kind !== kind || reference.schemaVersion !== 1 || reference.externalId.trim().length === 0) {
    throw new Error(`HULY_EXTERNAL_REFERENCE_INVALID:${kind}`);
  }
  return reference.externalId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
