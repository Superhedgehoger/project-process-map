export type TaskStatus = "todo" | "in_progress" | "submitted" | "completed" | "canceled";
export type TaskAuthorityStatus = Exclude<TaskStatus, "submitted">;

export type TaskAuthorityRecord = {
  authorityRef: string;
  title: string;
  status: TaskAuthorityStatus;
  syncWatermark: string;
};

export type CreateTaskAtAuthority = {
  authorityKey: string;
  title: string;
  status: TaskAuthorityStatus;
};

export type BlobScanState = "scanning" | "available" | "quarantined" | "failed";

export type BlobObject = {
  authorityRef: string;
  contentType: string;
  size: number;
  sha256: string;
  scanState: BlobScanState;
};

export type UploadBlob = {
  authorityKey: string;
  contentType: string;
  bytes: Uint8Array;
  sha256: string;
};

export type TaskFileAuthorityRecord = {
  authorityRef: string;
  taskAuthorityRef: string;
  blobAuthorityRef: string;
  name: string;
  contentType: string;
  size: number;
  syncWatermark: string;
};

export type AttachFileAtAuthority = {
  authorityKey: string;
  taskAuthorityRef: string;
  blobAuthorityRef: string;
  name: string;
  contentType: string;
  size: number;
};

export interface TaskAdapter {
  health(): Promise<"ok" | "degraded">;
  create(task: CreateTaskAtAuthority): Promise<TaskAuthorityRecord>;
  get(authorityRef: string): Promise<TaskAuthorityRecord | undefined>;
  remove(authorityRef: string): Promise<void>;
}

export interface BlobAdapter {
  health(): Promise<"ok" | "degraded">;
  upload(blob: UploadBlob): Promise<BlobObject>;
  get(authorityRef: string): Promise<BlobObject | undefined>;
  remove(authorityRef: string): Promise<void>;
}

export interface TaskFileAdapter {
  health(): Promise<"ok" | "degraded">;
  attach(file: AttachFileAtAuthority): Promise<TaskFileAuthorityRecord>;
  get(authorityRef: string): Promise<TaskFileAuthorityRecord | undefined>;
  remove(authorityRef: string): Promise<void>;
}
