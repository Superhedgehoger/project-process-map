import { createHash, randomUUID } from "node:crypto";
import type {
  AttachFileAtAuthority,
  BlobAdapter,
  BlobObject,
  BlobScanState,
  CreateTaskAtAuthority,
  TaskAdapter,
  TaskAuthorityRecord,
  TaskAuthorityStatus,
  TaskFileAdapter,
  TaskFileAuthorityRecord,
  UploadBlob,
} from "./ports.ts";

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
  statusIds?: Partial<Record<TaskAuthorityStatus, string>>;
  blobScanState?: BlobScanState;
};

type TaskRef = { issueId: string };
type BlobRef = { blobId: string; contentType: string; size: number; sha256: string; scanState: BlobScanState };
type FileRef = { attachmentId: string; issueId: string; blobAuthorityRef: string };

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
    const response = await fetch(this.fileUrl(blobId), { method: "HEAD", headers: this.authHeaders(false) });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`HULY_FILE_HEAD_FAILED:${response.status}`);
    return true;
  }

  async removeBlob(blobId: string): Promise<void> {
    const response = await fetch(this.fileUrl(blobId), { method: "DELETE", headers: this.authHeaders(false) });
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
    const response = await fetch(url, { ...init, headers: { ...this.authHeaders(json), ...init.headers } });
    if (!response.ok) throw new Error(`HULY_REQUEST_FAILED:${response.status}`);
    const result: unknown = await response.json();
    if (isObject(result) && result.error !== undefined) throw new Error(`HULY_RESPONSE_ERROR:${JSON.stringify(result.error)}`);
    return result;
  }
}

export class HulyRestTaskAdapter implements TaskAdapter {
  readonly #connection: HulyRestConnection;

  constructor(config: HulyRestConfig) {
    this.#connection = new HulyRestConnection(config);
  }

  async health(): Promise<"ok" | "degraded"> {
    return await this.#connection.health();
  }

  async create(task: CreateTaskAtAuthority): Promise<TaskAuthorityRecord> {
    const issueId = deterministicId(`task:${task.authorityKey}`);
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

  async get(authorityRef: string): Promise<TaskAuthorityRecord | undefined> {
    const { issueId } = decodeRef<TaskRef>(authorityRef, "huly-task");
    const issue = await this.#connection.findOne(HULY_IDS.issueClass, { _id: issueId });
    return issue === undefined ? undefined : this.toRecord(issue, issueId);
  }

  async remove(authorityRef: string): Promise<void> {
    const { issueId } = decodeRef<TaskRef>(authorityRef, "huly-task");
    const issue = await this.#connection.findOne(HULY_IDS.issueClass, { _id: issueId });
    if (issue === undefined) return;
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

  private statusId(status: TaskAuthorityStatus, project: JsonObject): string {
    const configured = this.#connection.config.statusIds?.[status];
    if (configured !== undefined) return configured;
    if (status === "todo" && typeof project.defaultIssueStatus === "string") return project.defaultIssueStatus;
    const defaults: Record<TaskAuthorityStatus, string> = {
      todo: "tracker:status:Todo",
      in_progress: "tracker:status:InProgress",
      completed: "tracker:status:Done",
      canceled: "tracker:status:Canceled",
    };
    return defaults[status];
  }

  private toRecord(issue: JsonObject, issueId: string, expected?: CreateTaskAtAuthority): TaskAuthorityRecord {
    if (typeof issue.title !== "string" || typeof issue.status !== "string") throw new Error("HULY_TASK_RESPONSE_INVALID");
    if (expected !== undefined && issue.title !== expected.title) throw new Error("HULY_DETERMINISTIC_ID_CONFLICT");
    return {
      authorityRef: encodeRef("huly-task", { issueId }),
      title: issue.title,
      status: this.fromStatusId(issue.status, expected?.status),
      syncWatermark: String(issue.modifiedOn ?? "0"),
    };
  }

  private fromStatusId(statusId: string, expected?: TaskAuthorityStatus): TaskAuthorityStatus {
    for (const [status, configured] of Object.entries(this.#connection.config.statusIds ?? {})) {
      if (configured === statusId) return status as TaskAuthorityStatus;
    }
    if (statusId.endsWith(":Todo") || statusId.endsWith(":Backlog")) return "todo";
    if (statusId.endsWith(":InProgress") || statusId.endsWith(":Coding") || statusId.endsWith(":UnderReview")) return "in_progress";
    if (statusId.endsWith(":Done")) return "completed";
    if (statusId.endsWith(":Canceled")) return "canceled";
    if (expected !== undefined) return expected;
    throw new Error(`HULY_TASK_STATUS_UNMAPPED:${statusId}`);
  }
}

export async function resolveHulyActorId(config: HulyRestConfig): Promise<string> {
  return await new HulyRestConnection(config).actorId();
}

export class HulyRestBlobAdapter implements BlobAdapter {
  readonly #connection: HulyRestConnection;

  constructor(config: HulyRestConfig) {
    this.#connection = new HulyRestConnection(config);
  }

  async health(): Promise<"ok" | "degraded"> {
    return await this.#connection.health();
  }

  async upload(blob: UploadBlob): Promise<BlobObject> {
    const blobId = deterministicId(`blob:${blob.authorityKey}`);
    const reference: BlobRef = {
      blobId,
      contentType: blob.contentType,
      size: blob.bytes.byteLength,
      sha256: blob.sha256,
      scanState: this.#connection.config.blobScanState ?? "scanning",
    };
    if (!await this.#connection.blobExists(blobId)) {
      const uploadedId = await this.#connection.upload(blobId, blob.contentType, blob.bytes);
      if (uploadedId !== blobId) throw new Error("HULY_BLOB_ID_MISMATCH");
    }
    return { authorityRef: encodeRef("huly-blob", reference), ...withoutBlobId(reference) };
  }

  async get(authorityRef: string): Promise<BlobObject | undefined> {
    const reference = decodeRef<BlobRef>(authorityRef, "huly-blob");
    if (!await this.#connection.blobExists(reference.blobId)) return undefined;
    return { authorityRef, ...withoutBlobId(reference) };
  }

  async remove(authorityRef: string): Promise<void> {
    const { blobId } = decodeRef<BlobRef>(authorityRef, "huly-blob");
    await this.#connection.removeBlob(blobId);
  }
}

export class HulyRestTaskFileAdapter implements TaskFileAdapter {
  readonly #connection: HulyRestConnection;

  constructor(config: HulyRestConfig) {
    this.#connection = new HulyRestConnection(config);
  }

  async health(): Promise<"ok" | "degraded"> {
    return await this.#connection.health();
  }

  async attach(file: AttachFileAtAuthority): Promise<TaskFileAuthorityRecord> {
    const { issueId } = decodeRef<TaskRef>(file.taskAuthorityRef, "huly-task");
    const { blobId } = decodeRef<BlobRef>(file.blobAuthorityRef, "huly-blob");
    const attachmentId = deterministicId(`attachment:${file.authorityKey}`);
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

  async get(authorityRef: string): Promise<TaskFileAuthorityRecord | undefined> {
    const { attachmentId, issueId, blobAuthorityRef } = decodeRef<FileRef>(authorityRef, "huly-attachment");
    const attachment = await this.#connection.findOne(HULY_IDS.attachmentClass, { _id: attachmentId });
    return attachment === undefined ? undefined : this.toRecord(attachment, attachmentId, issueId, undefined, blobAuthorityRef);
  }

  async remove(authorityRef: string): Promise<void> {
    const { attachmentId, issueId } = decodeRef<FileRef>(authorityRef, "huly-attachment");
    const attachment = await this.#connection.findOne(HULY_IDS.attachmentClass, { _id: attachmentId });
    if (attachment === undefined) return;
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
    expected?: AttachFileAtAuthority,
    knownBlobAuthorityRef?: string,
  ): TaskFileAuthorityRecord {
    if (typeof attachment.file !== "string" || typeof attachment.name !== "string" || typeof attachment.type !== "string" || typeof attachment.size !== "number") {
      throw new Error("HULY_ATTACHMENT_RESPONSE_INVALID");
    }
    if (expected !== undefined && (attachment.name !== expected.name || attachment.file !== decodeRef<BlobRef>(expected.blobAuthorityRef, "huly-blob").blobId)) {
      throw new Error("HULY_DETERMINISTIC_ID_CONFLICT");
    }
    const blobAuthorityRef = expected?.blobAuthorityRef ?? knownBlobAuthorityRef ?? encodeRef("huly-blob", {
      blobId: attachment.file,
      contentType: attachment.type,
      size: attachment.size,
      sha256: "unknown",
      scanState: "scanning",
    });
    return {
      authorityRef: encodeRef("huly-attachment", { attachmentId, issueId, blobAuthorityRef }),
      taskAuthorityRef: encodeRef("huly-task", { issueId }),
      blobAuthorityRef,
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

function encodeRef(prefix: string, value: JsonObject): string {
  return `${prefix}:${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

function decodeRef<T extends JsonObject>(value: string, prefix: string): T {
  if (!value.startsWith(`${prefix}:`)) throw new Error(`INVALID_AUTHORITY_REF:${prefix}`);
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value.slice(prefix.length + 1), "base64url").toString("utf8"));
    if (!isObject(decoded)) throw new Error("not an object");
    return decoded as T;
  } catch {
    throw new Error(`INVALID_AUTHORITY_REF:${prefix}`);
  }
}

function withoutBlobId(reference: BlobRef): Omit<BlobRef, "blobId"> {
  const { blobId: _blobId, ...value } = reference;
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
