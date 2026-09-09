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

export type ProjectMembershipRestrictionAction = "demoted" | "revoked";

export const projectMembershipRestrictionEventSchemas = {
  demoted: {
    eventType: "project-map.project-membership.demoted",
    schemaVersion: 1,
    requiredPayloadFields: ["action"],
    optionalPayloadFields: ["permissionVersion"],
  },
  revoked: {
    eventType: "project-map.project-membership.revoked",
    schemaVersion: 1,
    requiredPayloadFields: ["action"],
    optionalPayloadFields: ["permissionVersion"],
  },
} as const;

export type ProjectMembershipSecurityAuditEntry = Readonly<{
  tenantId: TenantId;
  id: string;
  projectId: string;
  actorPrincipalId: PrincipalId;
  targetPrincipalId: PrincipalId;
  action: ProjectMembershipRestrictionAction;
  previousRole: ProjectMembership["role"];
  role: ProjectMembership["role"];
  previousStatus: ProjectMembership["status"];
  status: ProjectMembership["status"];
  occurredAtUtc: string;
}>;

export function isProjectManager(membership: ProjectMembership | undefined): boolean {
  return membership?.status === "active" && membership.role === "project_manager";
}
