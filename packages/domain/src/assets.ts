import type { PrincipalId, TenantId } from "./identity.ts";

export type AssetLifecycleState = "initiated" | "uploading" | "scanning" | "available" | "quarantined" | "failed" | "deleted";
export type AssetTargetType = "project_node" | "task" | "blocker" | "record" | "deliverable" | "decision";

export type Asset = Readonly<{
  tenantId: TenantId;
  id: string;
  projectId: string;
  ownerNodeId: string;
  securityDomainId: string | null;
  securityEpoch: number;
  uploaderPrincipalId: PrincipalId;
  displayName: string;
  contentType: string;
  size: number;
  sha256: string;
  lifecycleState: AssetLifecycleState;
  failureCode: string | null;
  version: number;
  deletedAtUtc: string | null;
}>;

export type AssetBinding = Readonly<{
  tenantId: TenantId;
  id: string;
  assetId: string;
  targetType: AssetTargetType;
  targetId: string;
  purpose: "attachment" | "evidence";
  version: number;
  invalidatedAtUtc: string | null;
}>;

export function transitionAsset(
  asset: Asset,
  target: AssetLifecycleState,
  options: Readonly<{ failureCode?: string | null; occurredAtUtc?: string }> = {},
): Asset {
  const allowed: Record<AssetLifecycleState, readonly AssetLifecycleState[]> = {
    initiated: ["uploading", "failed", "deleted"],
    uploading: ["scanning", "failed", "deleted"],
    scanning: ["available", "quarantined", "failed", "deleted"],
    available: ["deleted"],
    quarantined: ["deleted"],
    failed: ["uploading", "deleted"],
    deleted: [],
  };
  if (!allowed[asset.lifecycleState].includes(target)) throw new Error(`ASSET_TRANSITION_INVALID:${asset.lifecycleState}:${target}`);
  const failureCode = options.failureCode ?? null;
  if (target === "failed" && (failureCode === null || failureCode.trim().length === 0)) throw new Error("ASSET_FAILURE_CODE_REQUIRED");
  if (target === "deleted" && (options.occurredAtUtc === undefined || Number.isNaN(Date.parse(options.occurredAtUtc)))) {
    throw new Error("ASSET_DELETION_TIME_REQUIRED");
  }
  return {
    ...asset,
    lifecycleState: target,
    failureCode: target === "failed" ? failureCode : null,
    version: asset.version + 1,
    deletedAtUtc: target === "deleted" ? options.occurredAtUtc ?? null : asset.deletedAtUtc,
  };
}

export function assertAssetDownloadable(asset: Asset): void {
  if (asset.lifecycleState !== "available" || asset.deletedAtUtc !== null) throw new Error("ASSET_NOT_AVAILABLE");
}
