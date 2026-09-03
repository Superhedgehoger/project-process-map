import { createHash } from "node:crypto";
import type {
  AttachFileAtAuthority,
  BlobAdapter,
  BlobObject,
  CreateTaskAtAuthority,
  TaskAdapter,
  TaskAuthorityRecord,
  TaskFileAdapter,
  TaskFileAuthorityRecord,
  UploadBlob,
} from "../../application/src/ports/integrations.ts";

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class InMemoryTaskAdapter implements TaskAdapter {
  readonly #tasks = new Map<string, TaskAuthorityRecord>();
  readonly #authorityKeys = new Map<string, { fingerprint: string; authorityRef: string }>();

  async health(): Promise<"ok"> {
    return "ok";
  }

  async create(task: CreateTaskAtAuthority): Promise<TaskAuthorityRecord> {
    const payloadFingerprint = fingerprint({ title: task.title, status: task.status });
    const previous = this.#authorityKeys.get(task.authorityKey);
    if (previous !== undefined) {
      if (previous.fingerprint !== payloadFingerprint) throw new Error("AUTHORITY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
      const replay = this.#tasks.get(previous.authorityRef);
      if (replay === undefined) throw new Error("AUTHORITY_RECORD_COMPENSATED");
      return structuredClone(replay);
    }
    const authorityRef = `task-authority:${task.authorityKey}`;
    const created: TaskAuthorityRecord = {
      authorityRef,
      title: task.title,
      status: task.status,
      syncWatermark: "1",
    };
    this.#tasks.set(authorityRef, structuredClone(created));
    this.#authorityKeys.set(task.authorityKey, { fingerprint: payloadFingerprint, authorityRef });
    return structuredClone(created);
  }

  async get(authorityRef: string): Promise<TaskAuthorityRecord | undefined> {
    const task = this.#tasks.get(authorityRef);
    return task ? structuredClone(task) : undefined;
  }

  async remove(authorityRef: string): Promise<void> {
    this.#tasks.delete(authorityRef);
    for (const [key, value] of this.#authorityKeys) {
      if (value.authorityRef === authorityRef) this.#authorityKeys.delete(key);
    }
  }
}

export class InMemoryBlobAdapter implements BlobAdapter {
  readonly #blobs = new Map<string, BlobObject>();
  readonly #authorityKeys = new Map<string, { fingerprint: string; authorityRef: string }>();

  async health(): Promise<"ok"> {
    return "ok";
  }

  async upload(blob: UploadBlob): Promise<BlobObject> {
    const payloadFingerprint = fingerprint({ contentType: blob.contentType, size: blob.bytes.byteLength, sha256: blob.sha256 });
    const previous = this.#authorityKeys.get(blob.authorityKey);
    if (previous !== undefined) {
      if (previous.fingerprint !== payloadFingerprint) throw new Error("AUTHORITY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
      const replay = this.#blobs.get(previous.authorityRef);
      if (replay === undefined) throw new Error("AUTHORITY_RECORD_COMPENSATED");
      return structuredClone(replay);
    }
    const authorityRef = `blob-authority:${blob.authorityKey}`;
    const created: BlobObject = {
      authorityRef,
      contentType: blob.contentType,
      size: blob.bytes.byteLength,
      sha256: blob.sha256,
      scanState: "available",
    };
    this.#blobs.set(authorityRef, structuredClone(created));
    this.#authorityKeys.set(blob.authorityKey, { fingerprint: payloadFingerprint, authorityRef });
    return structuredClone(created);
  }

  async get(authorityRef: string): Promise<BlobObject | undefined> {
    const blob = this.#blobs.get(authorityRef);
    return blob ? structuredClone(blob) : undefined;
  }

  async remove(authorityRef: string): Promise<void> {
    this.#blobs.delete(authorityRef);
    for (const [key, value] of this.#authorityKeys) {
      if (value.authorityRef === authorityRef) this.#authorityKeys.delete(key);
    }
  }
}

export class InMemoryTaskFileAdapter implements TaskFileAdapter {
  readonly #files = new Map<string, TaskFileAuthorityRecord>();
  readonly #authorityKeys = new Map<string, { fingerprint: string; authorityRef: string }>();

  async health(): Promise<"ok"> {
    return "ok";
  }

  async attach(file: AttachFileAtAuthority): Promise<TaskFileAuthorityRecord> {
    const payloadFingerprint = fingerprint(file);
    const previous = this.#authorityKeys.get(file.authorityKey);
    if (previous !== undefined) {
      if (previous.fingerprint !== payloadFingerprint) throw new Error("AUTHORITY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
      const replay = this.#files.get(previous.authorityRef);
      if (replay === undefined) throw new Error("AUTHORITY_RECORD_COMPENSATED");
      return structuredClone(replay);
    }
    const authorityRef = `file-authority:${file.authorityKey}`;
    const created: TaskFileAuthorityRecord = { ...file, authorityRef, syncWatermark: "1" };
    this.#files.set(authorityRef, structuredClone(created));
    this.#authorityKeys.set(file.authorityKey, { fingerprint: payloadFingerprint, authorityRef });
    return structuredClone(created);
  }

  async get(authorityRef: string): Promise<TaskFileAuthorityRecord | undefined> {
    const file = this.#files.get(authorityRef);
    return file ? structuredClone(file) : undefined;
  }

  async remove(authorityRef: string): Promise<void> {
    this.#files.delete(authorityRef);
    for (const [key, value] of this.#authorityKeys) {
      if (value.authorityRef === authorityRef) this.#authorityKeys.delete(key);
    }
  }
}

/** @deprecated Use InMemoryBlobAdapter and InMemoryTaskFileAdapter. */
export const InMemoryFileAdapter = InMemoryTaskFileAdapter;
