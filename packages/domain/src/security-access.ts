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

export type SecurityGrantAuditAction = "granted" | "changed" | "revoked";

export type SecurityGrantAuditEntry = Readonly<{
  tenantId: TenantId;
  id: string;
  projectId: string;
  securityDomainId: string;
  actorPrincipalId: PrincipalId;
  targetPrincipalId: PrincipalId;
  action: SecurityGrantAuditAction;
  previousCapability: SecurityCapability | null;
  capability: SecurityCapability;
  previousStatus: SecurityGrant["status"] | null;
  status: SecurityGrant["status"];
  permissionVersion: number;
  occurredAtUtc: string;
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

export function isPermanentSecurityAdministrator(grant: SecurityGrant): boolean {
  return grant.status === "active" && grant.capability === "manage_access" && grant.expiresAtUtc === null;
}
