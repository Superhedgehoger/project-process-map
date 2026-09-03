export type ExternalReference = Readonly<{
  provider: string;
  kind: string;
  externalId: string;
  schemaVersion: 1;
}>;

export function externalReference(provider: string, kind: string, externalId: string): ExternalReference {
  for (const [name, value] of Object.entries({ provider, kind, externalId })) {
    if (value.trim().length === 0) throw new Error(`${name} is required`);
  }
  return { provider, kind, externalId, schemaVersion: 1 };
}

export function externalReferenceKey(reference: ExternalReference): string {
  return `${reference.provider}\u0000${reference.kind}\u0000${reference.externalId}\u0000${reference.schemaVersion}`;
}

export type ExternalBinding = Readonly<{
  tenantId: import("./identity.ts").TenantId;
  id: string;
  ownerType: "task" | "asset" | "asset_binding";
  ownerId: string;
  role: "collaboration_projection" | "blob_replica";
  reference: ExternalReference;
  desiredVersion: number;
  observedVersion: number | null;
  syncWatermark: string | null;
  syncState: "pending" | "synced" | "failed" | "deleting" | "deleted";
  lastError: string | null;
  version: number;
  updatedAtUtc: string;
}>;
