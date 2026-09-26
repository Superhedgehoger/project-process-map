import { createHash } from "node:crypto";
import type { ExternalReference } from "../../../domain/src/external-reference.ts";
import type { TenantId } from "../../../domain/src/identity.ts";
import type { SecurityDomainMigration } from "../../../domain/src/security-migration.ts";
import type { SecurityMigrationManifestItem, SecurityMigrationManifestSnapshot, TransactionContext } from "../ports/persistence.ts";
import { buildResumableSecurityMigrationInventory } from "./build-security-migration-inventory.ts";

export type { SecurityMigrationManifestItem };

export type SecurityMigrationManifestInput = Readonly<{
  tenantId: TenantId;
  projectId: string;
  migrationId: string;
  sourceSecurityDomainId: string | null;
  targetSecurityDomainId: string | null;
  sourceSecurityEpoch: number;
  targetSecurityEpoch: number;
  items: readonly SecurityMigrationManifestItem[];
}>;

export function computeSecurityMigrationManifestDigest(manifest: SecurityMigrationManifestInput): string {
  const sortedItems = [...manifest.items].sort((left, right) => {
    return left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
  });

  const payload = {
    tenantId: manifest.tenantId,
    projectId: manifest.projectId,
    migrationId: manifest.migrationId,
    sourceSecurityDomainId: manifest.sourceSecurityDomainId,
    targetSecurityDomainId: manifest.targetSecurityDomainId,
    sourceSecurityEpoch: manifest.sourceSecurityEpoch,
    targetSecurityEpoch: manifest.targetSecurityEpoch,
    itemCount: sortedItems.length,
    items: sortedItems.map((item) => ({
      kind: item.kind,
      id: item.id,
      ownerNodeId: item.ownerNodeId,
      version: item.version,
      securityDomainId: item.securityDomainId,
      securityEpoch: item.securityEpoch,
      externalReference: item.externalReference ? {
        provider: item.externalReference.provider,
        kind: item.externalReference.kind,
        externalId: item.externalReference.externalId,
        schemaVersion: item.externalReference.schemaVersion,
      } : null,
      bindingVersion: item.bindingVersion ?? null,
      desiredVersion: item.desiredVersion ?? null,
      observedVersion: item.observedVersion ?? null,
      syncState: item.syncState ?? null,
      syncWatermark: item.syncWatermark ?? null,
      externalAttachmentReference: item.externalAttachmentReference ? {
        provider: item.externalAttachmentReference.provider,
        kind: item.externalAttachmentReference.kind,
        externalId: item.externalAttachmentReference.externalId,
        schemaVersion: item.externalAttachmentReference.schemaVersion,
      } : null,
      attachmentBindingVersion: item.attachmentBindingVersion ?? null,
      attachmentDesiredVersion: item.attachmentDesiredVersion ?? null,
      attachmentObservedVersion: item.attachmentObservedVersion ?? null,
      attachmentSyncState: item.attachmentSyncState ?? null,
      attachmentSyncWatermark: item.attachmentSyncWatermark ?? null,
      externalBlobReference: item.externalBlobReference ? {
        provider: item.externalBlobReference.provider,
        kind: item.externalBlobReference.kind,
        externalId: item.externalBlobReference.externalId,
        schemaVersion: item.externalBlobReference.schemaVersion,
      } : null,
      blobBindingVersion: item.blobBindingVersion ?? null,
      blobDesiredVersion: item.blobDesiredVersion ?? null,
      blobObservedVersion: item.blobObservedVersion ?? null,
      blobSyncState: item.blobSyncState ?? null,
      blobSyncWatermark: item.blobSyncWatermark ?? null,
      externalIssueId: item.externalIssueId ?? null,
    })),
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function collectSecurityMigrationManifest(
  transaction: TransactionContext,
  migration: SecurityDomainMigration,
): Promise<SecurityMigrationManifestInput> {
  const inventory = await buildResumableSecurityMigrationInventory(
    transaction,
    {
      tenantId: migration.tenantId,
      projectId: migration.projectId,
      rootNodeId: migration.rootNodeId,
      sourceSecurityDomainId: migration.sourceSecurityDomainId,
      sourceSecurityEpoch: migration.sourceSecurityEpoch,
    },
    {
      cursor: migration.cursor,
      migratedItems: migration.migratedItems,
      targetSecurityDomainId: migration.targetSecurityDomainId,
      targetSecurityEpoch: migration.targetSecurityEpoch,
    },
  );

  const manifestItems: SecurityMigrationManifestItem[] = [];

  for (const item of inventory.items) {
    if (item.kind === "node") {
      manifestItems.push({
        kind: "node",
        id: item.id,
        ownerNodeId: item.ownerNodeId,
        version: item.version,
        securityDomainId: item.securityDomainId,
        securityEpoch: item.securityEpoch,
      });
    } else if (item.kind === "task") {
      const binding = await transaction.externalBindings.getByOwner("task", item.id, "collaboration_projection");
      manifestItems.push({
        kind: "task",
        id: item.id,
        ownerNodeId: item.ownerNodeId,
        version: item.version,
        securityDomainId: item.securityDomainId,
        securityEpoch: item.securityEpoch,
        externalReference: binding?.reference ?? null,
        bindingVersion: binding?.version,
        desiredVersion: binding?.desiredVersion,
        observedVersion: binding?.observedVersion,
        syncState: binding?.syncState,
        syncWatermark: binding?.syncWatermark,
      });
    } else if (item.kind === "asset") {
      const attachmentBinding = await transaction.externalBindings.getByOwner("asset", item.id, "collaboration_projection");
      const blobBinding = await transaction.externalBindings.getByOwner("asset", item.id, "blob_replica");
      manifestItems.push({
        kind: "asset",
        id: item.id,
        ownerNodeId: item.ownerNodeId,
        version: item.version,
        securityDomainId: item.securityDomainId,
        securityEpoch: item.securityEpoch,
        externalAttachmentReference: attachmentBinding?.reference ?? null,
        attachmentBindingVersion: attachmentBinding?.version,
        attachmentDesiredVersion: attachmentBinding?.desiredVersion,
        attachmentObservedVersion: attachmentBinding?.observedVersion,
        attachmentSyncState: attachmentBinding?.syncState,
        attachmentSyncWatermark: attachmentBinding?.syncWatermark,
        externalBlobReference: blobBinding?.reference ?? null,
        blobBindingVersion: blobBinding?.version,
        blobDesiredVersion: blobBinding?.desiredVersion,
        blobObservedVersion: blobBinding?.observedVersion,
        blobSyncState: blobBinding?.syncState,
        blobSyncWatermark: blobBinding?.syncWatermark,
      });
    } else if (item.kind === "deliverable") {
      manifestItems.push({
        kind: "deliverable",
        id: item.id,
        ownerNodeId: item.ownerNodeId,
        version: item.version,
        securityDomainId: item.securityDomainId,
        securityEpoch: item.securityEpoch,
      });
    }
  }

  manifestItems.sort(compareManifestItems);

  return {
    tenantId: migration.tenantId,
    projectId: migration.projectId,
    migrationId: migration.id,
    sourceSecurityDomainId: migration.sourceSecurityDomainId,
    targetSecurityDomainId: migration.targetSecurityDomainId,
    sourceSecurityEpoch: migration.sourceSecurityEpoch,
    targetSecurityEpoch: migration.targetSecurityEpoch,
    items: manifestItems,
  };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && !v.includes("\u0000");
}

function isPositiveInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
}

function isNonNegativeInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function isIsoUtcTimestamp(v: unknown): v is string {
  if (typeof v !== "string" || !v.endsWith("Z")) return false;
  const t = Date.parse(v);
  return !Number.isNaN(t) && new Date(t).toISOString() === v;
}

function validateExternalReferenceShape(ref: unknown, context: string): ExternalReference {
  if (!ref || typeof ref !== "object") {
    throw new Error(`SECURITY_MIGRATION_MANIFEST_MISMATCH: ${context} externalReference must be an object`);
  }
  const r = ref as Record<string, unknown>;
  if (!isNonEmptyString(r.provider)) {
    throw new Error(`SECURITY_MIGRATION_MANIFEST_MISMATCH: ${context} externalReference provider must be non-empty string`);
  }
  if (!isNonEmptyString(r.kind)) {
    throw new Error(`SECURITY_MIGRATION_MANIFEST_MISMATCH: ${context} externalReference kind must be non-empty string`);
  }
  if (!isNonEmptyString(r.externalId)) {
    throw new Error(`SECURITY_MIGRATION_MANIFEST_MISMATCH: ${context} externalReference externalId must be non-empty string`);
  }
  if (!isPositiveInteger(r.schemaVersion)) {
    throw new Error(`SECURITY_MIGRATION_MANIFEST_MISMATCH: ${context} externalReference schemaVersion must be positive integer`);
  }
  return {
    provider: r.provider,
    kind: r.kind,
    externalId: r.externalId,
    schemaVersion: r.schemaVersion as 1,
  };
}

const VALID_SYNC_STATES = new Set(["pending", "synced", "failed", "deleting", "deleted"]);
function isSyncState(v: unknown): v is string {
  return typeof v === "string" && VALID_SYNC_STATES.has(v);
}

export function compareManifestItems(left: SecurityMigrationManifestItem, right: SecurityMigrationManifestItem): number {
  return left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
}

export function validateCanonicalManifestItem(item: unknown): SecurityMigrationManifestItem {
  if (!item || typeof item !== "object") {
    throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: manifest item must be an object");
  }
  const it = item as Record<string, unknown>;
  if (it.kind !== "node" && it.kind !== "task" && it.kind !== "asset" && it.kind !== "deliverable") {
    throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: manifest item kind must be node, task, asset, or deliverable");
  }
  if (!isNonEmptyString(it.id)) {
    throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: manifest item id must be non-empty string");
  }
  if (!isNonEmptyString(it.ownerNodeId)) {
    throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: manifest item ownerNodeId must be non-empty string");
  }
  if (!isPositiveInteger(it.version)) {
    throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: manifest item version must be positive integer");
  }
  if (it.securityDomainId !== null && it.securityDomainId !== undefined) {
    if (!isNonEmptyString(it.securityDomainId)) {
      throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: manifest item securityDomainId must be non-empty string or null");
    }
  }
  if (!isPositiveInteger(it.securityEpoch)) {
    throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: manifest item securityEpoch must be positive integer");
  }

  if (it.kind === "node") {
    const forbiddenKeys = [
      "externalReference", "bindingVersion", "desiredVersion", "observedVersion", "syncState", "syncWatermark",
      "externalAttachmentReference", "attachmentBindingVersion", "attachmentDesiredVersion", "attachmentObservedVersion", "attachmentSyncState", "attachmentSyncWatermark",
      "externalBlobReference", "blobBindingVersion", "blobDesiredVersion", "blobObservedVersion", "blobSyncState", "blobSyncWatermark",
      "externalIssueId",
    ];
    for (const key of forbiddenKeys) {
      if (it[key] !== undefined && it[key] !== null) {
        throw new Error(`SECURITY_MIGRATION_MANIFEST_MISMATCH: node item cannot have ${key}`);
      }
    }
  } else if (it.kind === "task") {
    const forbiddenKeys = [
      "externalAttachmentReference", "attachmentBindingVersion", "attachmentDesiredVersion", "attachmentObservedVersion", "attachmentSyncState", "attachmentSyncWatermark",
      "externalBlobReference", "blobBindingVersion", "blobDesiredVersion", "blobObservedVersion", "blobSyncState", "blobSyncWatermark",
      "externalIssueId",
    ];
    for (const key of forbiddenKeys) {
      if (it[key] !== undefined && it[key] !== null) {
        throw new Error(`SECURITY_MIGRATION_MANIFEST_MISMATCH: task item cannot have ${key}`);
      }
    }
    if (it.externalReference !== undefined && it.externalReference !== null) {
      validateExternalReferenceShape(it.externalReference, "task");
      if (it.bindingVersion !== undefined && it.bindingVersion !== null && !isPositiveInteger(it.bindingVersion)) {
        throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: task bindingVersion must be positive integer");
      }
      if (it.desiredVersion !== undefined && it.desiredVersion !== null && !isPositiveInteger(it.desiredVersion)) {
        throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: task desiredVersion must be positive integer");
      }
      if (it.observedVersion !== undefined && it.observedVersion !== null && !isNonNegativeInteger(it.observedVersion)) {
        throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: task observedVersion must be non-negative integer or null");
      }
      if (it.syncState !== undefined && it.syncState !== null && !isSyncState(it.syncState)) {
        throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: task syncState is invalid enum");
      }
      if (it.syncWatermark !== undefined && it.syncWatermark !== null && typeof it.syncWatermark !== "string") {
        throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: task syncWatermark must be string or null");
      }
    } else {
      if (it.bindingVersion !== undefined && it.bindingVersion !== null) {
        throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: task bindingVersion without externalReference");
      }
    }
  } else if (it.kind === "asset") {
    const forbiddenKeys = [
      "externalReference", "bindingVersion", "desiredVersion", "observedVersion", "syncState", "syncWatermark",
    ];
    for (const key of forbiddenKeys) {
      if (it[key] !== undefined && it[key] !== null) {
        throw new Error(`SECURITY_MIGRATION_MANIFEST_MISMATCH: asset item cannot have ${key}`);
      }
    }
    if (it.externalAttachmentReference !== undefined && it.externalAttachmentReference !== null) {
      validateExternalReferenceShape(it.externalAttachmentReference, "asset attachment");
      if (it.attachmentBindingVersion !== undefined && it.attachmentBindingVersion !== null && !isPositiveInteger(it.attachmentBindingVersion)) {
        throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: asset attachmentBindingVersion must be positive integer");
      }
      if (it.attachmentDesiredVersion !== undefined && it.attachmentDesiredVersion !== null && !isPositiveInteger(it.attachmentDesiredVersion)) {
        throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: asset attachmentDesiredVersion must be positive integer");
      }
      if (it.attachmentObservedVersion !== undefined && it.attachmentObservedVersion !== null && !isNonNegativeInteger(it.attachmentObservedVersion)) {
        throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: asset attachmentObservedVersion must be non-negative integer or null");
      }
      if (it.attachmentSyncState !== undefined && it.attachmentSyncState !== null && !isSyncState(it.attachmentSyncState)) {
        throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: asset attachmentSyncState is invalid enum");
      }
      if (it.attachmentSyncWatermark !== undefined && it.attachmentSyncWatermark !== null && typeof it.attachmentSyncWatermark !== "string") {
        throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: asset attachmentSyncWatermark must be string or null");
      }
    }
    if (it.externalBlobReference !== undefined && it.externalBlobReference !== null) {
      validateExternalReferenceShape(it.externalBlobReference, "asset blob");
      if (it.blobBindingVersion !== undefined && it.blobBindingVersion !== null && !isPositiveInteger(it.blobBindingVersion)) {
        throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: asset blobBindingVersion must be positive integer");
      }
      if (it.blobDesiredVersion !== undefined && it.blobDesiredVersion !== null && !isPositiveInteger(it.blobDesiredVersion)) {
        throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: asset blobDesiredVersion must be positive integer");
      }
      if (it.blobObservedVersion !== undefined && it.blobObservedVersion !== null && !isNonNegativeInteger(it.blobObservedVersion)) {
        throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: asset blobObservedVersion must be non-negative integer or null");
      }
      if (it.blobSyncState !== undefined && it.blobSyncState !== null && !isSyncState(it.blobSyncState)) {
        throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: asset blobSyncState is invalid enum");
      }
      if (it.blobSyncWatermark !== undefined && it.blobSyncWatermark !== null && typeof it.blobSyncWatermark !== "string") {
        throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: asset blobSyncWatermark must be string or null");
      }
    }
    if (it.externalIssueId !== undefined && it.externalIssueId !== null && !isNonEmptyString(it.externalIssueId)) {
      throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: asset externalIssueId must be non-empty string or null");
    }
  } else if (it.kind === "deliverable") {
    const forbiddenKeys = [
      "externalReference", "bindingVersion", "desiredVersion", "observedVersion", "syncState", "syncWatermark",
      "externalAttachmentReference", "attachmentBindingVersion", "attachmentDesiredVersion", "attachmentObservedVersion", "attachmentSyncState", "attachmentSyncWatermark",
      "externalBlobReference", "blobBindingVersion", "blobDesiredVersion", "blobObservedVersion", "blobSyncState", "blobSyncWatermark",
      "externalIssueId",
    ];
    for (const key of forbiddenKeys) {
      if (it[key] !== undefined && it[key] !== null) {
        throw new Error(`SECURITY_MIGRATION_MANIFEST_MISMATCH: deliverable item cannot have ${key}`);
      }
    }
  }

  return it as unknown as SecurityMigrationManifestItem;
}

export function validateCanonicalSnapshotItems(
  snapshot: SecurityMigrationManifestSnapshot,
  envelope?: {
    tenantId?: TenantId | undefined;
    projectId?: string | undefined;
    migrationId?: string | undefined;
    sourceSecurityDomainId?: string | null | undefined;
    targetSecurityDomainId?: string | null | undefined;
    sourceSecurityEpoch?: number | undefined;
    targetSecurityEpoch?: number | undefined;
  } | undefined,
): void {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: snapshot must be an object");
  }
  if (!isNonEmptyString(snapshot.tenantId)) {
    throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: invalid tenantId");
  }
  if (!isNonEmptyString(snapshot.migrationId)) {
    throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: invalid migrationId");
  }
  if (!isNonNegativeInteger(snapshot.itemCount)) {
    throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: invalid itemCount");
  }
  if (!Array.isArray(snapshot.items)) {
    throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: items must be an array");
  }
  if (snapshot.itemCount !== snapshot.items.length) {
    throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: itemCount mismatch");
  }
  if (!isIsoUtcTimestamp(snapshot.createdAtUtc)) {
    throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: invalid createdAtUtc");
  }
  if (envelope?.tenantId !== undefined && snapshot.tenantId !== envelope.tenantId) {
    throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: tenantId mismatch");
  }
  if (envelope?.migrationId !== undefined && snapshot.migrationId !== envelope.migrationId) {
    throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: migrationId mismatch");
  }

  const seen = new Set<string>();
  for (let i = 0; i < snapshot.items.length; i++) {
    const item = validateCanonicalManifestItem(snapshot.items[i]);
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) {
      throw new Error(`SECURITY_MIGRATION_MANIFEST_MISMATCH: duplicate item ${key}`);
    }
    seen.add(key);

    if (i > 0) {
      const prev = snapshot.items[i - 1];
      if (compareManifestItems(prev, item) >= 0) {
        throw new Error(`SECURITY_MIGRATION_MANIFEST_MISMATCH: non-canonical ordering at item ${i}: ${prev.kind}:${prev.id} vs ${item.kind}:${item.id}`);
      }
    }
  }

  if (seen.size !== snapshot.itemCount) {
    throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: unique item count mismatch");
  }

  const env = {
    tenantId: snapshot.tenantId,
    projectId: envelope?.projectId ?? snapshot.projectId,
    migrationId: snapshot.migrationId,
    sourceSecurityDomainId: envelope?.sourceSecurityDomainId !== undefined ? envelope.sourceSecurityDomainId : (snapshot.sourceSecurityDomainId ?? null),
    targetSecurityDomainId: envelope?.targetSecurityDomainId !== undefined ? envelope.targetSecurityDomainId : (snapshot.targetSecurityDomainId ?? null),
    sourceSecurityEpoch: envelope?.sourceSecurityEpoch ?? snapshot.sourceSecurityEpoch,
    targetSecurityEpoch: envelope?.targetSecurityEpoch ?? snapshot.targetSecurityEpoch,
  };

  if (env.projectId !== undefined && env.sourceSecurityEpoch !== undefined && env.targetSecurityEpoch !== undefined) {
    const computedDigest = computeSecurityMigrationManifestDigest({
      tenantId: env.tenantId,
      projectId: env.projectId,
      migrationId: env.migrationId,
      sourceSecurityDomainId: env.sourceSecurityDomainId,
      targetSecurityDomainId: env.targetSecurityDomainId,
      sourceSecurityEpoch: env.sourceSecurityEpoch,
      targetSecurityEpoch: env.targetSecurityEpoch,
      items: snapshot.items,
    });

    if (computedDigest !== snapshot.manifestDigest) {
      throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH: manifestDigest mismatch");
    }
  }
}

export function assertManifestMatchesSnapshot(
  liveManifest: SecurityMigrationManifestInput,
  snapshot: SecurityMigrationManifestSnapshot,
): void {
  if (liveManifest.items.length !== snapshot.itemCount || snapshot.items.length !== snapshot.itemCount) {
    throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH");
  }
  const liveDigest = computeSecurityMigrationManifestDigest(liveManifest);
  if (liveDigest !== snapshot.manifestDigest) {
    throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH");
  }

  const snapshotMap = new Map<string, SecurityMigrationManifestItem>();
  for (const snapItem of snapshot.items) {
    const key = `${snapItem.kind}:${snapItem.id}`;
    if (snapshotMap.has(key)) {
      throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH");
    }
    snapshotMap.set(key, snapItem);
  }

  if (snapshotMap.size !== liveManifest.items.length) {
    throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH");
  }

  const visitedKeys = new Set<string>();

  for (const liveItem of liveManifest.items) {
    const key = `${liveItem.kind}:${liveItem.id}`;
    if (visitedKeys.has(key)) {
      throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH");
    }
    visitedKeys.add(key);

    const snapItem = snapshotMap.get(key);
    if (snapItem === undefined) {
      throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH");
    }

    if (
      liveItem.version !== snapItem.version
      || liveItem.securityDomainId !== snapItem.securityDomainId
      || liveItem.securityEpoch !== snapItem.securityEpoch
      || liveItem.ownerNodeId !== snapItem.ownerNodeId
      || JSON.stringify(liveItem.externalReference ?? null) !== JSON.stringify(snapItem.externalReference ?? null)
      || liveItem.bindingVersion !== snapItem.bindingVersion
      || liveItem.desiredVersion !== snapItem.desiredVersion
      || liveItem.observedVersion !== snapItem.observedVersion
      || liveItem.syncState !== snapItem.syncState
      || liveItem.syncWatermark !== snapItem.syncWatermark
      || JSON.stringify(liveItem.externalAttachmentReference ?? null) !== JSON.stringify(snapItem.externalAttachmentReference ?? null)
      || liveItem.attachmentBindingVersion !== snapItem.attachmentBindingVersion
      || liveItem.attachmentDesiredVersion !== snapItem.attachmentDesiredVersion
      || liveItem.attachmentObservedVersion !== snapItem.attachmentObservedVersion
      || liveItem.attachmentSyncState !== snapItem.attachmentSyncState
      || liveItem.attachmentSyncWatermark !== snapItem.attachmentSyncWatermark
      || JSON.stringify(liveItem.externalBlobReference ?? null) !== JSON.stringify(snapItem.externalBlobReference ?? null)
      || liveItem.blobBindingVersion !== snapItem.blobBindingVersion
      || liveItem.blobDesiredVersion !== snapItem.blobDesiredVersion
      || liveItem.blobObservedVersion !== snapItem.blobObservedVersion
      || liveItem.blobSyncState !== snapItem.blobSyncState
      || liveItem.blobSyncWatermark !== snapItem.blobSyncWatermark
      || (liveItem.externalIssueId ?? null) !== (snapItem.externalIssueId ?? null)
    ) {
      throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH");
    }
  }

  if (visitedKeys.size !== snapshotMap.size) {
    throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH");
  }
}

