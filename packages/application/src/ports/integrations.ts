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
  read(reference: ExternalReference): Promise<Uint8Array>;
  remove(reference: ExternalReference): Promise<void>;
}

export interface ExternalBlobProjectionPort {
  health(): Promise<"ok" | "degraded">;
  put(content: Omit<PutAssetContent, "tenantId">): Promise<StoredAssetContent>;
  exists(reference: ExternalReference): Promise<boolean>;
  remove(reference: ExternalReference): Promise<void>;
}

export class IntegrationCallError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly outcome: "known_failed" | "ambiguous";

  constructor(code: string, message: string, options: Readonly<{ retryable: boolean; outcome: "known_failed" | "ambiguous" }>) {
    super(message);
    this.name = "IntegrationCallError";
    this.code = code;
    this.retryable = options.retryable;
    this.outcome = options.outcome;
  }
}

export interface TaskFileProjectionPort {
  health(): Promise<"ok" | "degraded">;
  attach(file: AttachFileProjection): Promise<TaskFileProjectionRecord>;
  get(reference: ExternalReference): Promise<TaskFileProjectionRecord | undefined>;
  remove(reference: ExternalReference, expectedSyncWatermark: string): Promise<void>;
}
