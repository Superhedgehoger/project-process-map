import type { PrincipalId, TenantId } from "./identity.ts";

export type ProjectMembership = Readonly<{
  tenantId: TenantId;
  projectId: string;
  principalId: PrincipalId;
  role: "project_manager" | "member";
  status: "active" | "revoked";
  /** @deprecated Compatibility for pre-v4 domains only. Formal SecurityDomain rows use SecurityGrant. */
  securityDomainIds: readonly string[];
  version: number;
  createdAtUtc: string;
  updatedAtUtc: string;
}>;

export function isProjectManager(membership: ProjectMembership | undefined): boolean {
  return membership?.status === "active" && membership.role === "project_manager";
}
