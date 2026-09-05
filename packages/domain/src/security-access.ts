import type { PrincipalId, TenantId } from "./identity.ts";

export type SecurityCapability = "view" | "contribute" | "edit" | "manage_access";

export type SecurityDomain = Readonly<{
  tenantId: TenantId;
  id: string;
  projectId: string;
  rootNodeId: string;
  parentSecurityDomainId: string | null;
  permissionVersion: number;
  version: number;
  createdByPrincipalId: PrincipalId;
  createdAtUtc: string;
  deletedAtUtc: string | null;
}>;

export type SecurityGrant = Readonly<{
  tenantId: TenantId;
  id: string;
  securityDomainId: string;
  principalId: PrincipalId;
  capability: SecurityCapability;
  status: "active" | "revoked";
  expiresAtUtc: string | null;
  grantedByPrincipalId: PrincipalId;
  reason: string;
  version: number;
  createdAtUtc: string;
  updatedAtUtc: string;
}>;

const capabilityRank: Record<SecurityCapability, number> = {
  view: 1,
  contribute: 2,
  edit: 3,
  manage_access: 4,
};

export function grantAllows(
  grant: SecurityGrant | undefined,
  required: SecurityCapability,
  atUtc: string,
): boolean {
  if (grant?.status !== "active") return false;
  const evaluatedAt = Date.parse(atUtc);
  if (Number.isNaN(evaluatedAt)) return false;
  if (grant.expiresAtUtc !== null) {
    const expiresAt = Date.parse(grant.expiresAtUtc);
    if (Number.isNaN(expiresAt) || expiresAt <= evaluatedAt) return false;
  }
  return capabilityRank[grant.capability] >= capabilityRank[required];
}
