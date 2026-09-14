import type { PrincipalId, TenantId } from "./identity.ts";

export type ProjectNode = Readonly<{
  tenantId: TenantId;
  id: string;
  projectId: string;
  parentId: string | null;
  leaderPrincipalId: PrincipalId | null;
  title: string;
  kind: "stage" | "work_package" | "milestone";
  securityDomainId: string | null;
  securityEpoch: number;
  version: number;
  deletedAtUtc: string | null;
}>;

export type ProjectRelationKind = "predecessor" | "related";

export function assertWritableRelationKind(value: string): asserts value is ProjectRelationKind {
  if (value === "parent-child") throw new Error("PARENT_CHILD_RELATION_IS_DERIVED");
  if (value !== "predecessor" && value !== "related") throw new Error(`UNKNOWN_RELATION_KIND:${value}`);
}

export function isNodeLeader(node: ProjectNode, principalId: PrincipalId | null | undefined): boolean {
  if (principalId === null || principalId === undefined) return false;
  return node.leaderPrincipalId !== null && node.leaderPrincipalId === principalId;
}

export const nodeEventSchemas = {
  created: {
    eventType: "project-map.node.created",
    schemaVersion: 1,
    requiredPayloadFields: ["nodeId", "parentId", "title", "kind"],
    optionalPayloadFields: [],
  },
  leaderAssigned: {
    eventType: "project-map.node.leader_assigned",
    schemaVersion: 1,
    requiredPayloadFields: ["nodeId", "previousLeaderPrincipalId", "leaderPrincipalId"],
    optionalPayloadFields: [],
  },
} as const;
