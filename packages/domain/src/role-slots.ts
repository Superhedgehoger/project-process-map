import type { PrincipalId, TenantId } from "./identity.ts";
import { isCanonicalUtcTimestamp } from "./security-access.ts";

export type TemplateRoleSlot = Readonly<{
  tenantId: TenantId;
  projectId: string;
  slotKey: string;
  sourceTemplateVersionId: string;
  name: string;
  description: string | null;
  createdAtUtc: string;
}>;

export type ProjectRoleBinding = Readonly<{
  tenantId: TenantId;
  projectId: string;
  slotKey: string;
  principalIds: readonly PrincipalId[];
  version: number;
  updatedAtUtc: string;
  updatedByPrincipalId: PrincipalId;
}>;

export const roleBindingEventSchemas = {
  assigned: {
    eventType: "project-map.role-binding.assigned",
    schemaVersion: 1,
    requiredPayloadFields: ["projectId", "slotKey", "principalIds", "version"],
    optionalPayloadFields: [],
  },
} as const;

export type RoleSlotsInitializedPayload = Readonly<{
  projectId: string;
  sourceTemplateVersionId: string;
  slotKeys: readonly string[];
}>;

export const roleSlotEventSchemas = {
  initialized: {
    eventType: "project-map.role-slots.initialized",
    schemaVersion: 1,
    requiredPayloadFields: ["projectId", "sourceTemplateVersionId", "slotKeys"],
    optionalPayloadFields: [],
  },
} as const;


export function compareExactStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function normalizeCandidateIds(candidateIds: readonly PrincipalId[]): readonly PrincipalId[] {
  const distinct = Array.from(new Set(candidateIds));
  return distinct.sort(compareExactStrings);
}

export function assertValidSlotKey(slotKey: string): void {
  if (typeof slotKey !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(slotKey)) {
    throw new Error(`INVALID_ROLE_SLOT_KEY:${slotKey}`);
  }
}

export function assertCanonicalProjectRoleBinding(
  binding: ProjectRoleBinding,
  expectedScope?: {
    tenantId?: TenantId | undefined;
    projectId?: string | undefined;
    slotKey?: string | undefined;
  },
): void {
  if (typeof binding !== "object" || binding === null) {
    throw new Error("ROLE_BINDING_RECORD_CORRUPT: record is not an object");
  }
  if (expectedScope?.tenantId !== undefined && binding.tenantId !== expectedScope.tenantId) {
    throw new Error(`ROLE_BINDING_RECORD_CORRUPT: tenantId discriminator drift: expected ${expectedScope.tenantId}, got ${binding.tenantId}`);
  }
  if (expectedScope?.projectId !== undefined && binding.projectId !== expectedScope.projectId) {
    throw new Error(`ROLE_BINDING_RECORD_CORRUPT: projectId discriminator drift: expected ${expectedScope.projectId}, got ${binding.projectId}`);
  }
  if (expectedScope?.slotKey !== undefined && binding.slotKey !== expectedScope.slotKey) {
    throw new Error(`ROLE_BINDING_RECORD_CORRUPT: slotKey discriminator drift: expected ${expectedScope.slotKey}, got ${binding.slotKey}`);
  }
  if (typeof binding.tenantId !== "string" || binding.tenantId.trim() !== binding.tenantId || binding.tenantId.length === 0) {
    throw new Error("ROLE_BINDING_RECORD_CORRUPT: invalid tenantId");
  }
  if (typeof binding.projectId !== "string" || binding.projectId.trim() !== binding.projectId || binding.projectId.length === 0) {
    throw new Error("ROLE_BINDING_RECORD_CORRUPT: invalid projectId");
  }
  try {
    assertValidSlotKey(binding.slotKey);
  } catch {
    throw new Error(`ROLE_BINDING_RECORD_CORRUPT: invalid slotKey: ${binding.slotKey}`);
  }
  if (!Number.isInteger(binding.version) || binding.version <= 0) {
    throw new Error(`ROLE_BINDING_RECORD_CORRUPT: version must be a positive integer, got ${binding.version}`);
  }
  if (!isCanonicalUtcTimestamp(binding.updatedAtUtc)) {
    throw new Error(`ROLE_BINDING_RECORD_CORRUPT: invalid updatedAtUtc: ${binding.updatedAtUtc}`);
  }
  if (typeof binding.updatedByPrincipalId !== "string" || binding.updatedByPrincipalId.trim() !== binding.updatedByPrincipalId || binding.updatedByPrincipalId.length === 0) {
    throw new Error("ROLE_BINDING_RECORD_CORRUPT: invalid updatedByPrincipalId");
  }
  if (!Array.isArray(binding.principalIds)) {
    throw new Error("ROLE_BINDING_RECORD_CORRUPT: principalIds must be an array");
  }
  let prevId: string | null = null;
  for (const id of binding.principalIds) {
    if (typeof id !== "string" || id.trim() !== id || id.length === 0) {
      throw new Error("ROLE_BINDING_RECORD_CORRUPT: candidate principalId must be non-empty and non-padded");
    }
    if (prevId !== null) {
      const cmp = compareExactStrings(prevId, id);
      if (cmp === 0) {
        throw new Error(`ROLE_BINDING_RECORD_CORRUPT: duplicate candidate principalId: ${id}`);
      }
      if (cmp > 0) {
        throw new Error(`ROLE_BINDING_RECORD_CORRUPT: candidate principalIds not in deterministic order: ${prevId} preceded ${id}`);
      }
    }
    prevId = id;
  }
}

export function assertCanonicalTemplateRoleSlot(
  slot: TemplateRoleSlot,
  expectedScope?: {
    tenantId?: TenantId | undefined;
    projectId?: string | undefined;
    slotKey?: string | undefined;
  },
): void {
  if (typeof slot !== "object" || slot === null) {
    throw new Error("ROLE_SLOT_RECORD_CORRUPT: record is not an object");
  }
  if (expectedScope?.tenantId !== undefined && slot.tenantId !== expectedScope.tenantId) {
    throw new Error(`ROLE_SLOT_RECORD_CORRUPT: tenantId discriminator drift: expected ${expectedScope.tenantId}, got ${slot.tenantId}`);
  }
  if (expectedScope?.projectId !== undefined && slot.projectId !== expectedScope.projectId) {
    throw new Error(`ROLE_SLOT_RECORD_CORRUPT: projectId discriminator drift: expected ${expectedScope.projectId}, got ${slot.projectId}`);
  }
  if (expectedScope?.slotKey !== undefined && slot.slotKey !== expectedScope.slotKey) {
    throw new Error(`ROLE_SLOT_RECORD_CORRUPT: slotKey discriminator drift: expected ${expectedScope.slotKey}, got ${slot.slotKey}`);
  }
  if (typeof slot.tenantId !== "string" || slot.tenantId.trim() !== slot.tenantId || slot.tenantId.length === 0) {
    throw new Error("ROLE_SLOT_RECORD_CORRUPT: invalid tenantId");
  }
  if (typeof slot.projectId !== "string" || slot.projectId.trim() !== slot.projectId || slot.projectId.length === 0) {
    throw new Error("ROLE_SLOT_RECORD_CORRUPT: invalid projectId");
  }
  try {
    assertValidSlotKey(slot.slotKey);
  } catch {
    throw new Error(`ROLE_SLOT_RECORD_CORRUPT: invalid slotKey: ${slot.slotKey}`);
  }
  if (typeof slot.sourceTemplateVersionId !== "string" || slot.sourceTemplateVersionId.trim() !== slot.sourceTemplateVersionId || slot.sourceTemplateVersionId.length === 0) {
    throw new Error("ROLE_SLOT_RECORD_CORRUPT: invalid sourceTemplateVersionId");
  }
  if (typeof slot.name !== "string" || slot.name.trim() !== slot.name || slot.name.length === 0) {
    throw new Error("ROLE_SLOT_RECORD_CORRUPT: invalid name");
  }
  if (slot.description !== null && (typeof slot.description !== "string" || slot.description.trim() !== slot.description)) {
    throw new Error("ROLE_SLOT_RECORD_CORRUPT: invalid description");
  }
  if (!isCanonicalUtcTimestamp(slot.createdAtUtc)) {
    throw new Error(`ROLE_SLOT_RECORD_CORRUPT: invalid createdAtUtc: ${slot.createdAtUtc}`);
  }
}

export type ProjectRoleSlotSnapshot = Readonly<{
  tenantId: TenantId;
  projectId: string;
  sourceTemplateVersionId: string;
  createdAtUtc: string;
  createdByPrincipalId: PrincipalId;
}>;

export function assertCanonicalProjectRoleSlotSnapshot(
  snapshot: ProjectRoleSlotSnapshot,
  expectedScope?: {
    tenantId?: TenantId | undefined;
    projectId?: string | undefined;
  },
): void {
  if (typeof snapshot !== "object" || snapshot === null) {
    throw new Error("ROLE_SLOT_RECORD_CORRUPT: snapshot record is not an object");
  }
  if (expectedScope?.tenantId !== undefined && snapshot.tenantId !== expectedScope.tenantId) {
    throw new Error(`ROLE_SLOT_RECORD_CORRUPT: tenantId discriminator drift: expected ${expectedScope.tenantId}, got ${snapshot.tenantId}`);
  }
  if (expectedScope?.projectId !== undefined && snapshot.projectId !== expectedScope.projectId) {
    throw new Error(`ROLE_SLOT_RECORD_CORRUPT: projectId discriminator drift: expected ${expectedScope.projectId}, got ${snapshot.projectId}`);
  }
  if (typeof snapshot.tenantId !== "string" || snapshot.tenantId.trim() !== snapshot.tenantId || snapshot.tenantId.length === 0) {
    throw new Error("ROLE_SLOT_RECORD_CORRUPT: invalid tenantId");
  }
  if (typeof snapshot.projectId !== "string" || snapshot.projectId.trim() !== snapshot.projectId || snapshot.projectId.length === 0) {
    throw new Error("ROLE_SLOT_RECORD_CORRUPT: invalid projectId");
  }
  if (typeof snapshot.sourceTemplateVersionId !== "string" || snapshot.sourceTemplateVersionId.trim() !== snapshot.sourceTemplateVersionId || snapshot.sourceTemplateVersionId.length === 0) {
    throw new Error("ROLE_SLOT_RECORD_CORRUPT: invalid sourceTemplateVersionId");
  }
  if (!isCanonicalUtcTimestamp(snapshot.createdAtUtc)) {
    throw new Error(`ROLE_SLOT_RECORD_CORRUPT: invalid createdAtUtc: ${snapshot.createdAtUtc}`);
  }
  if (typeof snapshot.createdByPrincipalId !== "string" || snapshot.createdByPrincipalId.trim() !== snapshot.createdByPrincipalId || snapshot.createdByPrincipalId.length === 0) {
    throw new Error("ROLE_SLOT_RECORD_CORRUPT: invalid createdByPrincipalId");
  }
}

export type ProjectRoleSlotAuditAction = "initialized";

export type ProjectRoleSlotAuditEntry = Readonly<{
  tenantId: TenantId;
  id: string;
  projectId: string;
  actorPrincipalId: PrincipalId;
  sourceTemplateVersionId: string;
  action: ProjectRoleSlotAuditAction;
  slotKeys: readonly string[];
  occurredAtUtc: string;
}>;

export function assertCanonicalProjectRoleSlotAuditEntry(
  entry: ProjectRoleSlotAuditEntry,
  expectedScope?: {
    tenantId?: TenantId | undefined;
    projectId?: string | undefined;
  },
): void {
  if (typeof entry !== "object" || entry === null) {
    throw new Error("ROLE_SLOT_AUDIT_RECORD_CORRUPT: record is not an object");
  }
  if (expectedScope?.tenantId !== undefined && entry.tenantId !== expectedScope.tenantId) {
    throw new Error(`ROLE_SLOT_AUDIT_RECORD_CORRUPT: tenantId discriminator drift: expected ${expectedScope.tenantId}, got ${entry.tenantId}`);
  }
  if (expectedScope?.projectId !== undefined && entry.projectId !== expectedScope.projectId) {
    throw new Error(`ROLE_SLOT_AUDIT_RECORD_CORRUPT: projectId discriminator drift: expected ${expectedScope.projectId}, got ${entry.projectId}`);
  }
  if (typeof entry.tenantId !== "string" || entry.tenantId.trim() !== entry.tenantId || entry.tenantId.length === 0) {
    throw new Error("ROLE_SLOT_AUDIT_RECORD_CORRUPT: invalid tenantId");
  }
  if (typeof entry.id !== "string" || entry.id.trim() !== entry.id || entry.id.length === 0) {
    throw new Error("ROLE_SLOT_AUDIT_RECORD_CORRUPT: invalid id");
  }
  if (typeof entry.projectId !== "string" || entry.projectId.trim() !== entry.projectId || entry.projectId.length === 0) {
    throw new Error("ROLE_SLOT_AUDIT_RECORD_CORRUPT: invalid projectId");
  }
  if (typeof entry.actorPrincipalId !== "string" || entry.actorPrincipalId.trim() !== entry.actorPrincipalId || entry.actorPrincipalId.length === 0) {
    throw new Error("ROLE_SLOT_AUDIT_RECORD_CORRUPT: invalid actorPrincipalId");
  }
  if (typeof entry.sourceTemplateVersionId !== "string" || entry.sourceTemplateVersionId.trim() !== entry.sourceTemplateVersionId || entry.sourceTemplateVersionId.length === 0) {
    throw new Error("ROLE_SLOT_AUDIT_RECORD_CORRUPT: invalid sourceTemplateVersionId");
  }
  if (entry.action !== "initialized") {
    throw new Error(`ROLE_SLOT_AUDIT_RECORD_CORRUPT: invalid action ${entry.action}`);
  }
  if (!Array.isArray(entry.slotKeys)) {
    throw new Error("ROLE_SLOT_AUDIT_RECORD_CORRUPT: slotKeys must be an array");
  }
  let prevKey: string | null = null;
  for (const key of entry.slotKeys) {
    try {
      assertValidSlotKey(key);
    } catch {
      throw new Error(`ROLE_SLOT_AUDIT_RECORD_CORRUPT: invalid slotKey ${key}`);
    }
    if (prevKey !== null) {
      const cmp = compareExactStrings(prevKey, key);
      if (cmp === 0) {
        throw new Error(`ROLE_SLOT_AUDIT_RECORD_CORRUPT: duplicate slotKey: ${key}`);
      }
      if (cmp > 0) {
        throw new Error(`ROLE_SLOT_AUDIT_RECORD_CORRUPT: slotKeys not in deterministic order: ${prevKey} preceded ${key}`);
      }
    }
    prevKey = key;
  }
  if (!isCanonicalUtcTimestamp(entry.occurredAtUtc)) {
    throw new Error(`ROLE_SLOT_AUDIT_RECORD_CORRUPT: invalid occurredAtUtc: ${entry.occurredAtUtc}`);
  }
}


