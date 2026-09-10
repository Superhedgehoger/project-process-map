import { createHash } from "node:crypto";
import { assertAssetDownloadable, type Asset } from "../../../domain/src/assets.ts";
import type { ExternalBinding } from "../../../domain/src/external-reference.ts";
import type { PrincipalId, TenantId } from "../../../domain/src/identity.ts";
import { canViewProjectObjectDuringMigration } from "../access/project-security.ts";
import { ApplicationError } from "../errors.ts";
import type { AssetContentPort, StoredAssetContent } from "../ports/integrations.ts";
import type { Persistence, TransactionContext } from "../ports/persistence.ts";

export type DownloadAssetContentQuery = Readonly<{
  tenantId: TenantId;
  principalId: PrincipalId;
  assetId: string;
}>;

export type DownloadedAssetContent = Readonly<{
  contentType: string;
  bytes: Uint8Array;
}>;

type AuthorizedSnapshot = Readonly<{
  asset: Asset;
  replica: ExternalBinding;
}>;

const minimalFailure = () => new ApplicationError("NOT_FOUND", "Asset content not found");

export class DownloadAssetContentHandler {
  readonly #persistence: Persistence;
  readonly #content: AssetContentPort;

  constructor(persistence: Persistence, content: AssetContentPort) {
    this.#persistence = persistence;
    this.#content = content;
  }

  async execute(query: DownloadAssetContentQuery): Promise<DownloadedAssetContent> {
    try {
      const before = await this.#persistence.read(query.tenantId, async (transaction) => (
        await authorizedSnapshot(transaction, query)
      ));
      if (!await this.#content.ownsReference(query.tenantId, before.replica.reference)) throw minimalFailure();
      const metadataBefore = await this.#content.get(before.replica.reference);
      assertContentMetadata(before.asset, before.replica, metadataBefore);
      const bytes = await this.#content.read(before.replica.reference);
      assertContentBytes(before.asset, bytes);
      const metadataAfter = await this.#content.get(before.replica.reference);
      assertContentMetadata(before.asset, before.replica, metadataAfter);
      if (!sameMetadata(metadataBefore, metadataAfter)) throw minimalFailure();
      await this.#persistence.read(query.tenantId, async (transaction) => {
        const after = await authorizedSnapshot(transaction, query);
        if (!sameAssetSnapshot(before.asset, after.asset) || !sameReplicaSnapshot(before.replica, after.replica)) {
          throw minimalFailure();
        }
      });
      return { contentType: controlledContentType(before.asset.contentType), bytes };
    } catch {
      throw minimalFailure();
    }
  }
}

async function authorizedSnapshot(
  transaction: TransactionContext,
  query: DownloadAssetContentQuery,
): Promise<AuthorizedSnapshot> {
  const asset = await transaction.assets.get(query.assetId);
  if (asset === undefined || asset.tenantId !== query.tenantId) throw minimalFailure();
  assertAssetDownloadable(asset);
  const owner = await transaction.nodes.get(asset.ownerNodeId);
  if (owner === undefined || owner.projectId !== asset.projectId || owner.deletedAtUtc !== null) throw minimalFailure();
  const membership = await transaction.memberships.get(asset.projectId, query.principalId);
  if (!await canViewProjectObjectDuringMigration(
    transaction,
    membership,
    query.principalId,
    {
      projectId: asset.projectId,
      ownerNodeId: asset.ownerNodeId,
      securityDomainId: asset.securityDomainId,
      securityEpoch: asset.securityEpoch,
    },
    new Date().toISOString(),
  )) throw minimalFailure();
  const replica = await transaction.externalBindings.getByOwner("asset", asset.id, "blob_replica");
  if (replica === undefined || replica.tenantId !== query.tenantId || replica.ownerId !== asset.id
    || replica.ownerType !== "asset" || replica.role !== "blob_replica" || replica.syncState !== "synced"
    || replica.observedVersion === null || replica.desiredVersion !== replica.observedVersion) throw minimalFailure();
  return { asset, replica };
}

function assertContentMetadata(
  asset: Asset,
  replica: ExternalBinding,
  content: StoredAssetContent | undefined,
): asserts content is StoredAssetContent {
  if (content === undefined || content.scanState !== "available" || content.contentType !== asset.contentType
    || content.size !== asset.size || content.sha256 !== asset.sha256
    || content.reference.provider !== replica.reference.provider || content.reference.kind !== replica.reference.kind
    || content.reference.externalId !== replica.reference.externalId
    || content.reference.schemaVersion !== replica.reference.schemaVersion) throw minimalFailure();
}

function assertContentBytes(asset: Asset, bytes: Uint8Array): void {
  if (bytes.byteLength !== asset.size || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
    throw minimalFailure();
  }
}

function sameMetadata(left: StoredAssetContent, right: StoredAssetContent): boolean {
  return left.contentType === right.contentType && left.size === right.size && left.sha256 === right.sha256
    && left.scanState === right.scanState;
}

function sameAssetSnapshot(left: Asset, right: Asset): boolean {
  return left.tenantId === right.tenantId && left.id === right.id && left.projectId === right.projectId
    && left.ownerNodeId === right.ownerNodeId && left.securityDomainId === right.securityDomainId
    && left.securityEpoch === right.securityEpoch && left.contentType === right.contentType && left.size === right.size
    && left.sha256 === right.sha256 && left.lifecycleState === right.lifecycleState
    && left.deletedAtUtc === right.deletedAtUtc && left.version === right.version;
}

function sameReplicaSnapshot(left: ExternalBinding, right: ExternalBinding): boolean {
  return left.tenantId === right.tenantId && left.id === right.id && left.ownerType === right.ownerType
    && left.ownerId === right.ownerId && left.role === right.role
    && left.reference.provider === right.reference.provider && left.reference.kind === right.reference.kind
    && left.reference.externalId === right.reference.externalId
    && left.reference.schemaVersion === right.reference.schemaVersion && left.desiredVersion === right.desiredVersion
    && left.observedVersion === right.observedVersion && left.syncState === right.syncState
    && left.syncWatermark === right.syncWatermark && left.lastError === right.lastError
    && left.version === right.version && left.updatedAtUtc === right.updatedAtUtc;
}

function controlledContentType(value: string): string {
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value) ? value : "application/octet-stream";
}
