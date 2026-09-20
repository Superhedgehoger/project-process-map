import { createHash } from "node:crypto";
import {
  assertCanonicalProjectRoleSlotAuditEntry,
  assertCanonicalProjectRoleSlotSnapshot,
  assertCanonicalTemplateRoleSlot,
  assertValidSlotKey,
  compareExactStrings,
  type ProjectRoleSlotAuditEntry,
  type ProjectRoleSlotSnapshot,
  type RoleSlotsInitializedPayload,
  type TemplateRoleSlot,
} from "../../../domain/src/role-slots.ts";
import type { DomainEvent, OutboxMessage } from "../../../domain/src/events.ts";
import type { TenantId } from "../../../domain/src/identity.ts";
import { isCanonicalUtcTimestamp } from "../../../domain/src/security-access.ts";
import { ApplicationError } from "../errors.ts";
import type {
  InitializeProjectRoleSlotsCommand,
  InitializeProjectRoleSlotsFailurePoint,
  InitializeProjectRoleSlotsResult,
  Persistence,
  TemplateRoleSlotInit,
} from "../ports/persistence.ts";

export async function executeInitializeProjectRoleSlots(
  persistence: Persistence,
  command: InitializeProjectRoleSlotsCommand,
  failurePoint?: InitializeProjectRoleSlotsFailurePoint,
): Promise<InitializeProjectRoleSlotsResult> {
  return await persistence.executeInitializeProjectRoleSlots(command, failurePoint);
}

export class InitializeProjectRoleSlotsHandler {
  readonly #persistence: Persistence;

  constructor(persistence: Persistence) {
    this.#persistence = persistence;
  }

  execute(
    command: InitializeProjectRoleSlotsCommand,
    failurePoint?: InitializeProjectRoleSlotsFailurePoint,
  ): Promise<InitializeProjectRoleSlotsResult> {
    return executeInitializeProjectRoleSlots(this.#persistence, command, failurePoint);
  }
}


export function validateInitializeProjectRoleSlots(
  command: InitializeProjectRoleSlotsCommand,
): void {
  if (typeof command.tenantId !== "string" || command.tenantId.trim().length === 0) {
    throw new Error("tenantId must be a non-empty string");
  }
  if (typeof command.commandId !== "string" || command.commandId.trim().length === 0) {
    throw new Error("commandId must be a non-empty string");
  }
  if (typeof command.idempotencyKey !== "string" || command.idempotencyKey.trim().length === 0) {
    throw new Error("idempotencyKey must be a non-empty string");
  }
  if (typeof command.principalId !== "string" || command.principalId.trim().length === 0) {
    throw new Error("principalId must be a non-empty string");
  }
  if (typeof command.projectId !== "string" || command.projectId.trim().length === 0) {
    throw new Error("projectId must be a non-empty string");
  }
  if (
    typeof command.sourceTemplateVersionId !== "string" ||
    command.sourceTemplateVersionId.trim().length === 0
  ) {
    throw new Error("sourceTemplateVersionId must be a non-empty string");
  }
  if (!isCanonicalUtcTimestamp(command.occurredAtUtc)) {
    throw new Error("occurredAtUtc must be a valid canonical UTC timestamp");
  }
  if (!Array.isArray(command.slots)) {
    throw new Error("slots must be an array");
  }

  const seenKeys = new Set<string>();
  for (const slot of command.slots) {
    if (typeof slot !== "object" || slot === null) {
      throw new Error("Slot entry must be an object");
    }
    try {
      assertValidSlotKey(slot.slotKey);
    } catch {
      throw new ApplicationError("INVALID_ROLE_SLOT", `Invalid slot key: ${slot.slotKey}`);
    }
    if (seenKeys.has(slot.slotKey)) {
      throw new ApplicationError("INVALID_ROLE_SLOT", `Duplicate slotKey in initialization: ${slot.slotKey}`);
    }
    seenKeys.add(slot.slotKey);

    if (typeof slot.name !== "string" || slot.name.trim().length === 0) {
      throw new Error(`Slot ${slot.slotKey} name must be a non-empty string`);
    }
    if (
      slot.description !== undefined &&
      slot.description !== null &&
      typeof slot.description !== "string"
    ) {
      throw new Error(`Slot ${slot.slotKey} description must be a string or null`);
    }
  }
}

export function hashInitializeRoleSlotsPayload(
  command: InitializeProjectRoleSlotsCommand,
): string {
  const normalizedSlots = [...command.slots]
    .map((s) => ({
      slotKey: s.slotKey,
      name: s.name,
      description: s.description ?? null,
    }))
    .sort((a, b) => compareExactStrings(a.slotKey, b.slotKey));

  return createHash("sha256")
    .update(
      JSON.stringify({
        tenantId: command.tenantId,
        projectId: command.projectId,
        sourceTemplateVersionId: command.sourceTemplateVersionId,
        slots: normalizedSlots,
      }),
    )
    .digest("hex");
}

export function areRoleSlotsIdentical(
  existingSlots: readonly TemplateRoleSlot[],
  incomingSlots: readonly TemplateRoleSlotInit[],
): boolean {
  if (existingSlots.length !== incomingSlots.length) return false;
  const sortedExisting = [...existingSlots].sort((a, b) => compareExactStrings(a.slotKey, b.slotKey));
  const sortedIncoming = [...incomingSlots].sort((a, b) => compareExactStrings(a.slotKey, b.slotKey));

  for (let i = 0; i < sortedExisting.length; i++) {
    const ex = sortedExisting[i];
    const inc = sortedIncoming[i];
    if (!ex || !inc) return false;
    if (ex.slotKey !== inc.slotKey) return false;
    if (ex.name !== inc.name) return false;
    if ((ex.description ?? null) !== (inc.description ?? null)) return false;
  }
  return true;
}

export function injectRoleSlotFailure(
  expected: InitializeProjectRoleSlotsFailurePoint | undefined,
  actual: InitializeProjectRoleSlotsFailurePoint,
): void {
  if (expected === actual) throw new Error(`Injected failure: ${actual}`);
}

export function assertCoherentRoleSlotsInitializationRecords(params: {
  tenantId: TenantId;
  projectId: string;
  sourceTemplateVersionId?: string;
  snapshot: ProjectRoleSlotSnapshot;
  slots: readonly TemplateRoleSlot[];
  audit: ProjectRoleSlotAuditEntry;
  event: DomainEvent<RoleSlotsInitializedPayload>;
  outbox: OutboxMessage;
}): void {
  const { tenantId, projectId, snapshot, slots, audit, event, outbox } = params;

  // 1. Snapshot validation
  if (typeof snapshot !== "object" || snapshot === null) {
    throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", "Snapshot record is not an object");
  }
  try {
    assertCanonicalProjectRoleSlotSnapshot(snapshot, { tenantId, projectId });
  } catch (err) {
    throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", err instanceof Error ? err.message : String(err));
  }
  if (
    params.sourceTemplateVersionId !== undefined &&
    snapshot.sourceTemplateVersionId !== params.sourceTemplateVersionId
  ) {
    throw new ApplicationError(
      "ROLE_SLOT_RECORD_CORRUPT",
      `Snapshot sourceTemplateVersionId mismatch: expected ${params.sourceTemplateVersionId}, got ${snapshot.sourceTemplateVersionId}`,
    );
  }

  // 2. Slots validation
  if (!Array.isArray(slots)) {
    throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", "Slots must be an array");
  }
  let prevKey: string | null = null;
  for (const slot of slots) {
    if (typeof slot !== "object" || slot === null) {
      throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", "Slot record is not an object");
    }
    try {
      assertCanonicalTemplateRoleSlot(slot, { tenantId, projectId, slotKey: slot.slotKey });
    } catch (err) {
      throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", err instanceof Error ? err.message : String(err));
    }
    if (slot.sourceTemplateVersionId !== snapshot.sourceTemplateVersionId) {
      throw new ApplicationError(
        "ROLE_SLOT_RECORD_CORRUPT",
        `Slot ${slot.slotKey} sourceTemplateVersionId mismatch with snapshot`,
      );
    }
    if (slot.createdAtUtc !== snapshot.createdAtUtc) {
      throw new ApplicationError(
        "ROLE_SLOT_RECORD_CORRUPT",
        `Slot ${slot.slotKey} createdAtUtc mismatch with snapshot`,
      );
    }
    if (prevKey !== null) {
      const cmp = compareExactStrings(prevKey, slot.slotKey);
      if (cmp >= 0) {
        throw new ApplicationError(
          "ROLE_SLOT_RECORD_CORRUPT",
          `Slots not strictly and deterministically ordered: ${prevKey} preceded ${slot.slotKey}`,
        );
      }
    }
    prevKey = slot.slotKey;
  }

  const expectedSlotKeys = slots.map((s) => s.slotKey);

  // 3. Audit validation
  if (typeof audit !== "object" || audit === null) {
    throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", "Audit record is not an object");
  }
  try {
    assertCanonicalProjectRoleSlotAuditEntry(audit, { tenantId, projectId });
  } catch (err) {
    throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", err instanceof Error ? err.message : String(err));
  }
  if (audit.action !== "initialized") {
    throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", `Audit action mismatch: expected initialized, got ${audit.action}`);
  }
  if (audit.sourceTemplateVersionId !== snapshot.sourceTemplateVersionId) {
    throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", "Audit sourceTemplateVersionId mismatch with snapshot");
  }
  if (audit.occurredAtUtc !== snapshot.createdAtUtc) {
    throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", "Audit occurredAtUtc mismatch with snapshot createdAtUtc");
  }
  if (audit.actorPrincipalId !== snapshot.createdByPrincipalId) {
    throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", "Audit actorPrincipalId mismatch with snapshot createdByPrincipalId");
  }
  if (
    audit.slotKeys.length !== expectedSlotKeys.length ||
    !audit.slotKeys.every((k, idx) => k === expectedSlotKeys[idx])
  ) {
    throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", "Audit slotKeys mismatch with slots");
  }

  // 4. Event validation
  if (!event || typeof event !== "object") {
    throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", "Event missing or not an object");
  }
  if (
    event.tenantId !== tenantId ||
    event.projectId !== projectId ||
    event.aggregateType !== "project_role_slots" ||
    event.aggregateId !== projectId ||
    event.aggregateVersion !== 1 ||
    event.eventType !== "project-map.role-slots.initialized" ||
    event.schemaVersion !== 1 ||
    event.actorPrincipalId !== snapshot.createdByPrincipalId ||
    event.occurredAtUtc !== snapshot.createdAtUtc ||
    !Number.isInteger(event.projectSequence) ||
    event.projectSequence <= 0 ||
    !event.payload ||
    typeof event.payload !== "object" ||
    event.payload.projectId !== projectId ||
    event.payload.sourceTemplateVersionId !== snapshot.sourceTemplateVersionId ||
    !Array.isArray(event.payload.slotKeys) ||
    event.payload.slotKeys.length !== expectedSlotKeys.length ||
    !event.payload.slotKeys.every((k: string, idx: number) => k === expectedSlotKeys[idx])
  ) {
    throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", "Event invalid or divergent from snapshot/slots");
  }

  // 5. Outbox validation
  if (!outbox || typeof outbox !== "object") {
    throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", "Outbox missing or not an object");
  }
  if (
    outbox.tenantId !== tenantId ||
    outbox.id !== `outbox:${event.eventId}` ||
    outbox.eventId !== event.eventId ||
    outbox.topic !== "project-map.role-slots.initialized.v1" ||
    outbox.createdAtUtc !== snapshot.createdAtUtc ||
    JSON.stringify(outbox.payload) !== JSON.stringify(event)
  ) {
    throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", "Outbox invalid or divergent from event");
  }
}

