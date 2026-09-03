import type { ExternalReference } from "../../../domain/src/external-reference.ts";
import type { TenantId } from "../../../domain/src/identity.ts";

/**
 * Application-owned ports for optional external collaboration providers.
 *
 * Implementations may use Huly or another provider, but callers must never
 * depend on provider SDK types or treat these records as product authority.
 */
export type CollaborationTaskStatus = "todo" | "in_progress" | "completed" | "canceled";

export type { ExternalReference } from "../../../domain/src/external-reference.ts";

export type TaskProjectionRecord = {
  reference: ExternalReference;
  title: string;
  status: CollaborationTaskStatus;
  syncWatermark: string;
};

export type CreateTaskProjection = {
  requestId: string;
  title: string;
  status: CollaborationTaskStatus;
};

export type BlobScanState = "scanning" | "available" | "quarantined" | "failed";

export type ExternalBlobObject = {
  reference: ExternalReference;
  contentType: string;
  size: number;
  sha256: string;
  scanState: BlobScanState;
};

export type UploadBlobProjection = {
  requestId: string;
  contentType: string;
  bytes: Uint8Array;
  sha256: string;
};

export type TaskFileProjectionRecord = {
  reference: ExternalReference;
  taskReference: ExternalReference;
  blobReference: ExternalReference;
  name: string;
  contentType: string;
  size: number;
  syncWatermark: string;
};

export type AttachFileProjection = {
  requestId: string;
  taskReference: ExternalReference;
  blobReference: ExternalReference;
  name: string;
  contentType: string;
  size: number;
};

export interface TaskProjectionPort {
  health(): Promise<"ok" | "degraded">;
  create(task: CreateTaskProjection): Promise<TaskProjectionRecord>;
  get(reference: ExternalReference): Promise<TaskProjectionRecord | undefined>;
  remove(reference: ExternalReference, expectedSyncWatermark: string): Promise<void>;
}

export interface BlobStoragePort {
  health(): Promise<"ok" | "degraded">;
  upload(blob: UploadBlobProjection): Promise<ExternalBlobObject>;
  get(reference: ExternalReference): Promise<ExternalBlobObject | undefined>;
  remove(reference: ExternalReference): Promise<void>;
}

export type PutAssetContent = Readonly<{
  tenantId: TenantId;
  requestId: string;
  contentType: string;
  bytes: Uint8Array;
  sha256: string;
}>;

export type StoredAssetContent = Readonly<{
  reference: ExternalReference;
  contentType: string;
  size: number;
  sha256: string;
  scanState: BlobScanState;
}>;

export interface AssetContentPort {
  put(content: PutAssetContent): Promise<StoredAssetContent>;
  get(reference: ExternalReference): Promise<StoredAssetContent | undefined>;
  remove(reference: ExternalReference): Promise<void>;
}

export interface TaskFileProjectionPort {
  health(): Promise<"ok" | "degraded">;
  attach(file: AttachFileProjection): Promise<TaskFileProjectionRecord>;
  get(reference: ExternalReference): Promise<TaskFileProjectionRecord | undefined>;
  remove(reference: ExternalReference, expectedSyncWatermark: string): Promise<void>;
}

/*
 * Transitional Phase 0 contract. Existing synchronous orchestration is kept
 * buildable while its persisted Task/Asset projection data is migrated. No new
 * use case may consume these aliases; they are removed by ARCH-GATE-01.
 */
export type TaskAuthorityStatus = CollaborationTaskStatus;
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
export type UploadBlob = {
  authorityKey: string;
  contentType: string;
  bytes: Uint8Array;
  sha256: string;
};
export type BlobObject = {
  authorityRef: string;
  contentType: string;
  size: number;
  sha256: string;
  scanState: BlobScanState;
};
export type AttachFileAtAuthority = {
  authorityKey: string;
  taskAuthorityRef: string;
  blobAuthorityRef: string;
  name: string;
  contentType: string;
  size: number;
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
