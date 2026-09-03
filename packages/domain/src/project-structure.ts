import type { TenantId } from "./identity.ts";

export type ProjectNode = Readonly<{
  tenantId: TenantId;
  id: string;
  projectId: string;
  parentId: string | null;
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

