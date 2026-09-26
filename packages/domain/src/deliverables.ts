import type { PrincipalId, TenantId } from "./identity.ts";
import { isCanonicalUtcTimestamp } from "./security-access.ts";

export type DeliverableStatus = "pending" | "submitted" | "accepted" | "waived" | "evidence_due";
export type EvidenceSourceType = "file" | "process_record";

export type DeliverableRequirement = Readonly<{
  tenantId: TenantId;
  id: string;
  projectId: string;
  ownerNodeId: string;
  securityDomainId: string | null;
  securityEpoch: number;
  requirementKey: string;
  title: string;
  description: string | null;
  required: boolean;
  acceptedSourceTypes: readonly EvidenceSourceType[];
  minCount: number;
  reviewerPrincipalId: PrincipalId;
  status: DeliverableStatus;
  acceptedByPrincipalId: PrincipalId | null;
  acceptedAtUtc: string | null;
  acceptedReason: string | null;
  waivedByPrincipalId: PrincipalId | null;
  waivedAtUtc: string | null;
  waivedReason: string | null;
  version: number;
  createdAtUtc: string;
  updatedAtUtc: string;
  deletedAtUtc: string | null;
}>;

export type EvidenceLink = Readonly<{
  tenantId: TenantId;
  id: string;
  requirementId: string;
  sourceType: EvidenceSourceType;
  sourceId: string;
  submittedByPrincipalId: PrincipalId;
  linkedAtUtc: string;
  version: number;
}>;

export type DeliverableAction = "initialized" | "submitted" | "accepted" | "waived";

export type DeliverableActionRecord = Readonly<{
  tenantId: TenantId;
  id: string;
  requirementId: string;
  action: DeliverableAction;
  actorPrincipalId: PrincipalId;
  occurredAtUtc: string;
  reason: string | null;
  evidenceCount: number;
  evidenceIds: readonly string[];
}>;

export function assertValidRequirementKey(requirementKey: string): void {
  if (typeof requirementKey !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(requirementKey)) {
    throw new Error(`INVALID_DELIVERABLE_KEY:${requirementKey}`);
  }
}

export function assertCanonicalDeliverableRequirement(
  requirement: DeliverableRequirement,
  expectedScope?: {
    tenantId?: TenantId | undefined;
    projectId?: string | undefined;
    ownerNodeId?: string | undefined;
    id?: string | undefined;
  },
): void {
  if (typeof requirement !== "object" || requirement === null) {
    throw new Error("DELIVERABLE_RECORD_CORRUPT: record is not an object");
  }
  if (expectedScope?.tenantId !== undefined && requirement.tenantId !== expectedScope.tenantId) {
    throw new Error(`DELIVERABLE_RECORD_CORRUPT: tenantId drift: expected ${expectedScope.tenantId}, got ${requirement.tenantId}`);
  }
  if (expectedScope?.projectId !== undefined && requirement.projectId !== expectedScope.projectId) {
    throw new Error(`DELIVERABLE_RECORD_CORRUPT: projectId drift: expected ${expectedScope.projectId}, got ${requirement.projectId}`);
  }
  if (expectedScope?.ownerNodeId !== undefined && requirement.ownerNodeId !== expectedScope.ownerNodeId) {
    throw new Error(`DELIVERABLE_RECORD_CORRUPT: ownerNodeId drift: expected ${expectedScope.ownerNodeId}, got ${requirement.ownerNodeId}`);
  }
  if (expectedScope?.id !== undefined && requirement.id !== expectedScope.id) {
    throw new Error(`DELIVERABLE_RECORD_CORRUPT: id drift: expected ${expectedScope.id}, got ${requirement.id}`);
  }

  if (typeof requirement.tenantId !== "string" || requirement.tenantId.trim() !== requirement.tenantId || requirement.tenantId.length === 0) {
    throw new Error("DELIVERABLE_RECORD_CORRUPT: invalid tenantId");
  }
  if (typeof requirement.id !== "string" || requirement.id.trim() !== requirement.id || requirement.id.length === 0) {
    throw new Error("DELIVERABLE_RECORD_CORRUPT: invalid id");
  }
  if (typeof requirement.projectId !== "string" || requirement.projectId.trim() !== requirement.projectId || requirement.projectId.length === 0) {
    throw new Error("DELIVERABLE_RECORD_CORRUPT: invalid projectId");
  }
  if (typeof requirement.ownerNodeId !== "string" || requirement.ownerNodeId.trim() !== requirement.ownerNodeId || requirement.ownerNodeId.length === 0) {
    throw new Error("DELIVERABLE_RECORD_CORRUPT: invalid ownerNodeId");
  }
  try {
    assertValidRequirementKey(requirement.requirementKey);
  } catch {
    throw new Error(`DELIVERABLE_RECORD_CORRUPT: invalid requirementKey: ${requirement.requirementKey}`);
  }
  if (typeof requirement.title !== "string" || requirement.title.trim().length === 0) {
    throw new Error("DELIVERABLE_RECORD_CORRUPT: invalid title");
  }
  if (requirement.description !== null && typeof requirement.description !== "string") {
    throw new Error("DELIVERABLE_RECORD_CORRUPT: invalid description");
  }
  if (typeof requirement.required !== "boolean") {
    throw new Error("DELIVERABLE_RECORD_CORRUPT: required must be boolean");
  }
  if (!Array.isArray(requirement.acceptedSourceTypes) || requirement.acceptedSourceTypes.length === 0) {
    throw new Error("DELIVERABLE_RECORD_CORRUPT: acceptedSourceTypes must be a non-empty array");
  }
  for (const st of requirement.acceptedSourceTypes) {
    if (st !== "file" && st !== "process_record") {
      throw new Error(`DELIVERABLE_RECORD_CORRUPT: invalid source type ${st}`);
    }
  }
  if (!Number.isSafeInteger(requirement.minCount) || requirement.minCount <= 0) {
    throw new Error("DELIVERABLE_RECORD_CORRUPT: minCount must be positive integer");
  }
  if (typeof requirement.reviewerPrincipalId !== "string" || requirement.reviewerPrincipalId.trim() !== requirement.reviewerPrincipalId || requirement.reviewerPrincipalId.length === 0) {
    throw new Error("DELIVERABLE_RECORD_CORRUPT: invalid reviewerPrincipalId");
  }
  const validStatuses: DeliverableStatus[] = ["pending", "submitted", "accepted", "waived", "evidence_due"];
  if (!validStatuses.includes(requirement.status)) {
    throw new Error(`DELIVERABLE_RECORD_CORRUPT: invalid status ${requirement.status}`);
  }
  if (!Number.isSafeInteger(requirement.version) || requirement.version <= 0) {
    throw new Error("DELIVERABLE_RECORD_CORRUPT: version must be positive integer");
  }
  if (!Number.isSafeInteger(requirement.securityEpoch) || requirement.securityEpoch <= 0) {
    throw new Error("DELIVERABLE_RECORD_CORRUPT: securityEpoch must be positive integer");
  }
  if (requirement.securityDomainId !== null
    && (typeof requirement.securityDomainId !== "string" || requirement.securityDomainId.trim().length === 0)) {
    throw new Error("DELIVERABLE_RECORD_CORRUPT: securityDomainId must be a non-empty string or null");
  }
  if (!isCanonicalUtcTimestamp(requirement.createdAtUtc) || !isCanonicalUtcTimestamp(requirement.updatedAtUtc)) {
    throw new Error("DELIVERABLE_RECORD_CORRUPT: invalid timestamp");
  }
  if (requirement.deletedAtUtc !== null && !isCanonicalUtcTimestamp(requirement.deletedAtUtc)) {
    throw new Error("DELIVERABLE_RECORD_CORRUPT: deletedAtUtc must be a canonical UTC timestamp");
  }
  if (requirement.status === "accepted") {
    if (requirement.acceptedByPrincipalId === null) {
      throw new Error("DELIVERABLE_RECORD_CORRUPT: accepted status requires acceptedByPrincipalId");
    }
    if (typeof requirement.acceptedAtUtc !== "string" || !isCanonicalUtcTimestamp(requirement.acceptedAtUtc)) {
      throw new Error("DELIVERABLE_RECORD_CORRUPT: accepted status requires a valid acceptedAtUtc");
    }
    if (requirement.waivedByPrincipalId !== null || requirement.waivedAtUtc !== null || requirement.waivedReason !== null) {
      throw new Error("DELIVERABLE_RECORD_CORRUPT: accepted status must not carry waiver fields");
    }
  }
  if (requirement.status === "waived") {
    if (requirement.waivedByPrincipalId === null) {
      throw new Error("DELIVERABLE_RECORD_CORRUPT: waived status requires waivedByPrincipalId");
    }
    if (typeof requirement.waivedAtUtc !== "string" || !isCanonicalUtcTimestamp(requirement.waivedAtUtc)) {
      throw new Error("DELIVERABLE_RECORD_CORRUPT: waived status requires a valid waivedAtUtc");
    }
    if (typeof requirement.waivedReason !== "string" || requirement.waivedReason.trim() !== requirement.waivedReason || requirement.waivedReason.length === 0) {
      throw new Error("DELIVERABLE_RECORD_CORRUPT: waived status requires a non-empty waivedReason");
    }
    if (requirement.acceptedByPrincipalId !== null || requirement.acceptedAtUtc !== null || requirement.acceptedReason !== null) {
      throw new Error("DELIVERABLE_RECORD_CORRUPT: waived status must not carry acceptance fields");
    }
  }
  if (requirement.status === "pending" || requirement.status === "submitted" || requirement.status === "evidence_due") {
    if (requirement.acceptedByPrincipalId !== null || requirement.acceptedAtUtc !== null || requirement.acceptedReason !== null) {
      throw new Error("DELIVERABLE_RECORD_CORRUPT: non-terminal status must not carry acceptance fields");
    }
    if (requirement.waivedByPrincipalId !== null || requirement.waivedAtUtc !== null || requirement.waivedReason !== null) {
      throw new Error("DELIVERABLE_RECORD_CORRUPT: non-terminal status must not carry waiver fields");
    }
  }
  assertNullableCanonicalPrincipal(requirement.acceptedByPrincipalId, "acceptedByPrincipalId");
  assertNullableCanonicalTimestamp(requirement.acceptedAtUtc, "acceptedAtUtc");
  assertNullableCanonicalReason(requirement.acceptedReason, "acceptedReason");
  assertNullableCanonicalPrincipal(requirement.waivedByPrincipalId, "waivedByPrincipalId");
  assertNullableCanonicalTimestamp(requirement.waivedAtUtc, "waivedAtUtc");
  assertNullableCanonicalReason(requirement.waivedReason, "waivedReason");
}

export function assertCanonicalEvidenceLink(
  link: EvidenceLink,
  expectedScope?: {
    tenantId?: TenantId | undefined;
    requirementId?: string | undefined;
  },
): void {
  if (typeof link !== "object" || link === null) {
    throw new Error("EVIDENCE_LINK_RECORD_CORRUPT: record is not an object");
  }
  if (expectedScope?.tenantId !== undefined && link.tenantId !== expectedScope.tenantId) {
    throw new Error(`EVIDENCE_LINK_RECORD_CORRUPT: tenantId drift: expected ${expectedScope.tenantId}, got ${link.tenantId}`);
  }
  if (expectedScope?.requirementId !== undefined && link.requirementId !== expectedScope.requirementId) {
    throw new Error(`EVIDENCE_LINK_RECORD_CORRUPT: requirementId drift: expected ${expectedScope.requirementId}, got ${link.requirementId}`);
  }
  if (typeof link.tenantId !== "string" || link.tenantId.trim() !== link.tenantId || link.tenantId.length === 0) {
    throw new Error("EVIDENCE_LINK_RECORD_CORRUPT: invalid tenantId");
  }
  if (typeof link.id !== "string" || link.id.trim() !== link.id || link.id.length === 0) {
    throw new Error("EVIDENCE_LINK_RECORD_CORRUPT: invalid id");
  }
  if (typeof link.requirementId !== "string" || link.requirementId.trim() !== link.requirementId || link.requirementId.length === 0) {
    throw new Error("EVIDENCE_LINK_RECORD_CORRUPT: invalid requirementId");
  }
  if (link.sourceType !== "file" && link.sourceType !== "process_record") {
    throw new Error(`EVIDENCE_LINK_RECORD_CORRUPT: invalid sourceType ${link.sourceType}`);
  }
  if (typeof link.sourceId !== "string" || link.sourceId.trim() !== link.sourceId || link.sourceId.length === 0) {
    throw new Error("EVIDENCE_LINK_RECORD_CORRUPT: invalid sourceId");
  }
  if (typeof link.submittedByPrincipalId !== "string" || link.submittedByPrincipalId.trim() !== link.submittedByPrincipalId || link.submittedByPrincipalId.length === 0) {
    throw new Error("EVIDENCE_LINK_RECORD_CORRUPT: invalid submittedByPrincipalId");
  }
  if (!isCanonicalUtcTimestamp(link.linkedAtUtc)) {
    throw new Error("EVIDENCE_LINK_RECORD_CORRUPT: invalid linkedAtUtc");
  }
  if (!Number.isSafeInteger(link.version) || link.version <= 0) {
    throw new Error("EVIDENCE_LINK_RECORD_CORRUPT: version must be positive integer");
  }
}

export function assertCanonicalDeliverableActionRecord(
  record: DeliverableActionRecord,
  expectedScope?: {
    tenantId?: TenantId | undefined;
    requirementId?: string | undefined;
  },
): void {
  if (typeof record !== "object" || record === null) {
    throw new Error("DELIVERABLE_ACTION_RECORD_CORRUPT: record is not an object");
  }
  if (expectedScope?.tenantId !== undefined && record.tenantId !== expectedScope.tenantId) {
    throw new Error(`DELIVERABLE_ACTION_RECORD_CORRUPT: tenantId drift: expected ${expectedScope.tenantId}, got ${record.tenantId}`);
  }
  if (expectedScope?.requirementId !== undefined && record.requirementId !== expectedScope.requirementId) {
    throw new Error(`DELIVERABLE_ACTION_RECORD_CORRUPT: requirementId drift: expected ${expectedScope.requirementId}, got ${record.requirementId}`);
  }
  const validActions: DeliverableAction[] = ["initialized", "submitted", "accepted", "waived"];
  if (!validActions.includes(record.action)) {
    throw new Error(`DELIVERABLE_ACTION_RECORD_CORRUPT: invalid action ${record.action}`);
  }
  if (typeof record.tenantId !== "string" || record.tenantId.trim() !== record.tenantId || record.tenantId.length === 0) {
    throw new Error("DELIVERABLE_ACTION_RECORD_CORRUPT: invalid tenantId");
  }
  if (typeof record.id !== "string" || record.id.trim() !== record.id || record.id.length === 0) {
    throw new Error("DELIVERABLE_ACTION_RECORD_CORRUPT: invalid id");
  }
  if (typeof record.requirementId !== "string" || record.requirementId.trim() !== record.requirementId || record.requirementId.length === 0) {
    throw new Error("DELIVERABLE_ACTION_RECORD_CORRUPT: invalid requirementId");
  }
  if (typeof record.actorPrincipalId !== "string" || record.actorPrincipalId.trim() !== record.actorPrincipalId || record.actorPrincipalId.length === 0) {
    throw new Error("DELIVERABLE_ACTION_RECORD_CORRUPT: invalid actorPrincipalId");
  }
  if (!isCanonicalUtcTimestamp(record.occurredAtUtc)) {
    throw new Error("DELIVERABLE_ACTION_RECORD_CORRUPT: invalid occurredAtUtc");
  }
  if (!Number.isSafeInteger(record.evidenceCount) || record.evidenceCount < 0) {
    throw new Error("DELIVERABLE_ACTION_RECORD_CORRUPT: evidenceCount must be non-negative integer");
  }
  if (!Array.isArray(record.evidenceIds)) {
    throw new Error("DELIVERABLE_ACTION_RECORD_CORRUPT: evidenceIds must be array");
  }
  const evidenceIds = record.evidenceIds as readonly unknown[];
  if (evidenceIds.some((id) => typeof id !== "string" || id.trim() !== id || id.length === 0)) {
    throw new Error("DELIVERABLE_ACTION_RECORD_CORRUPT: evidenceIds must contain canonical non-empty strings");
  }
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw new Error("DELIVERABLE_ACTION_RECORD_CORRUPT: evidenceIds must be unique");
  }
  if (record.evidenceCount !== evidenceIds.length) {
    throw new Error("DELIVERABLE_ACTION_RECORD_CORRUPT: evidenceCount must match evidenceIds length");
  }
  if (record.reason !== null && (typeof record.reason !== "string" || record.reason.trim() !== record.reason || record.reason.length === 0)) {
    throw new Error("DELIVERABLE_ACTION_RECORD_CORRUPT: reason must be a canonical non-empty string or null");
  }
  if (record.action === "submitted") {
    if (record.reason !== null || record.evidenceCount === 0) {
      throw new Error("DELIVERABLE_ACTION_RECORD_CORRUPT: submitted action requires evidence and no reason");
    }
  } else if (record.evidenceCount !== 0) {
    throw new Error("DELIVERABLE_ACTION_RECORD_CORRUPT: only submitted action may carry evidence IDs");
  }
  if (record.action === "initialized" && record.reason !== null) {
    throw new Error("DELIVERABLE_ACTION_RECORD_CORRUPT: initialized action must not carry a reason");
  }
  if (record.action === "waived" && record.reason === null) {
    throw new Error("DELIVERABLE_ACTION_RECORD_CORRUPT: waived action requires a reason");
  }
}

function assertNullableCanonicalPrincipal(value: unknown, field: string): void {
  if (value !== null && (typeof value !== "string" || value.trim() !== value || value.length === 0)) {
    throw new Error(`DELIVERABLE_RECORD_CORRUPT: ${field} must be a canonical non-empty string or null`);
  }
}

function assertNullableCanonicalTimestamp(value: unknown, field: string): void {
  if (value !== null && (typeof value !== "string" || !isCanonicalUtcTimestamp(value))) {
    throw new Error(`DELIVERABLE_RECORD_CORRUPT: ${field} must be a canonical UTC timestamp or null`);
  }
}

function assertNullableCanonicalReason(value: unknown, field: string): void {
  if (value !== null && (typeof value !== "string" || value.trim() !== value || value.length === 0)) {
    throw new Error(`DELIVERABLE_RECORD_CORRUPT: ${field} must be a canonical non-empty string or null`);
  }
}

export function submitDeliverable(
  requirement: DeliverableRequirement,
  options: Readonly<{ occurredAtUtc: string }>,
): DeliverableRequirement {
  if (requirement.status === "accepted" || requirement.status === "waived") {
    throw new Error("DELIVERABLE_IS_TERMINAL");
  }
  if (requirement.status === "submitted") {
    throw new Error("DELIVERABLE_ALREADY_SUBMITTED");
  }
  if (requirement.status !== "pending" && requirement.status !== "evidence_due") {
    throw new Error(`DELIVERABLE_SUBMIT_TRANSITION_INVALID:${requirement.status}`);
  }
  return {
    ...requirement,
    status: "submitted",
    version: requirement.version + 1,
    updatedAtUtc: options.occurredAtUtc,
  };
}

export function acceptDeliverable(
  requirement: DeliverableRequirement,
  options: Readonly<{
    acceptedByPrincipalId: PrincipalId;
    occurredAtUtc: string;
    acceptedReason?: string | null | undefined;
  }>,
): DeliverableRequirement {
  if (requirement.status === "accepted") {
    throw new Error("DELIVERABLE_ALREADY_ACCEPTED");
  }
  if (requirement.status === "waived") {
    throw new Error("DELIVERABLE_IS_TERMINAL");
  }
  if (requirement.status !== "submitted") {
    throw new Error(`DELIVERABLE_ACCEPT_TRANSITION_INVALID:${requirement.status}`);
  }
  return {
    ...requirement,
    status: "accepted",
    acceptedByPrincipalId: options.acceptedByPrincipalId,
    acceptedAtUtc: options.occurredAtUtc,
    acceptedReason: options.acceptedReason?.trim() || null,
    version: requirement.version + 1,
    updatedAtUtc: options.occurredAtUtc,
  };
}

export function waiveDeliverable(
  requirement: DeliverableRequirement,
  options: Readonly<{
    waivedByPrincipalId: PrincipalId;
    occurredAtUtc: string;
    reason: string;
  }>,
): DeliverableRequirement {
  if (requirement.status === "accepted") {
    throw new Error("DELIVERABLE_ALREADY_ACCEPTED");
  }
  if (requirement.status === "waived") {
    throw new Error("DELIVERABLE_ALREADY_WAIVED");
  }
  const trimmedReason = options.reason.trim();
  if (trimmedReason.length === 0) {
    throw new Error("WAIVER_REASON_REQUIRED");
  }
  return {
    ...requirement,
    status: "waived",
    waivedByPrincipalId: options.waivedByPrincipalId,
    waivedAtUtc: options.occurredAtUtc,
    waivedReason: trimmedReason,
    version: requirement.version + 1,
    updatedAtUtc: options.occurredAtUtc,
  };
}

export const deliverableEventSchemas = {
  initialized: {
    eventType: "project-map.deliverable.initialized",
    schemaVersion: 1,
    requiredPayloadFields: [
      "deliverableId",
      "projectId",
      "nodeId",
      "requirementKey",
      "minCount",
      "reviewerPrincipalId",
      "required",
    ],
    optionalPayloadFields: ["description"],
  },
  submitted: {
    eventType: "project-map.deliverable.submitted",
    schemaVersion: 1,
    requiredPayloadFields: ["deliverableId", "projectId", "nodeId", "evidenceCount", "evidenceIds"],
    optionalPayloadFields: [],
  },
  accepted: {
    eventType: "project-map.deliverable.accepted",
    schemaVersion: 1,
    requiredPayloadFields: ["deliverableId", "projectId", "nodeId", "acceptedByPrincipalId"],
    optionalPayloadFields: ["acceptedReason"],
  },
  waived: {
    eventType: "project-map.deliverable.waived",
    schemaVersion: 1,
    requiredPayloadFields: ["deliverableId", "projectId", "nodeId", "waivedByPrincipalId", "waivedReason"],
    optionalPayloadFields: [],
  },
} as const;
