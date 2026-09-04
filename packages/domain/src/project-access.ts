import type { PrincipalId, TenantId } from "./identity.ts";

export type ProjectMembership = Readonly<{
  tenantId: TenantId;
  projectId: string;
  principalId: PrincipalId;
  role: "project_manager" | "member";
  status: "active" | "revoked";
  /** Empty means public project content only; sensitive domains require an explicit grant. */
  securityDomainIds: readonly string[];
  version: number;
  createdAtUtc: string;
  updatedAtUtc: string;
}>;

export function canAccessSecurityDomain(
  membership: ProjectMembership | undefined,
  securityDomainId: string | null,
): membership is ProjectMembership {
  if (membership?.status !== "active") return false;
  return securityDomainId === null || membership.securityDomainIds.includes(securityDomainId);
}

export function isProjectManager(membership: ProjectMembership | undefined): boolean {
  return membership?.status === "active" && membership.role === "project_manager";
}
