import type { TenantId } from "./identity.ts";

export type SecurityDomainMigrationState = "planned" | "active" | "verifying" | "committed" | "retryable" | "recovery_required" | "rolled_back";

export type SecurityDomainMigration = Readonly<{
  tenantId: TenantId;
  id: string;
  projectId: string;
  rootNodeId: string;
  sourceSecurityDomainId: string | null;
  targetSecurityDomainId: string | null;
  hierarchyRevision: number;
  sourceSecurityEpoch: number;
  targetSecurityEpoch: number;
  state: SecurityDomainMigrationState;
  cursor: string | null;
  totalItems: number;
  migratedItems: number;
  failure: string | null;
  nextAttemptAtUtc: string | null;
  deadlineAtUtc: string;
  version: number;
  createdAtUtc: string;
  updatedAtUtc: string;
}>;

export function effectiveSecurityDomains(migration: SecurityDomainMigration): ReadonlyArray<string | null> {
  if (["active", "verifying", "retryable", "recovery_required"].includes(migration.state)) {
    return migration.sourceSecurityDomainId === migration.targetSecurityDomainId
      ? [migration.sourceSecurityDomainId]
      : [migration.sourceSecurityDomainId, migration.targetSecurityDomainId];
  }
  return [migration.state === "committed" ? migration.targetSecurityDomainId : migration.sourceSecurityDomainId];
}

export function transitionSecurityMigration(
  migration: SecurityDomainMigration,
  target: SecurityDomainMigrationState,
  occurredAtUtc: string,
  failure: string | null = null,
): SecurityDomainMigration {
  const allowed: Record<SecurityDomainMigrationState, readonly SecurityDomainMigrationState[]> = {
    planned: ["active", "rolled_back"],
    active: ["verifying", "retryable", "recovery_required"],
    verifying: ["committed", "retryable", "recovery_required"],
    retryable: ["active", "verifying", "recovery_required"],
    recovery_required: ["active", "verifying", "rolled_back"],
    committed: [],
    rolled_back: [],
  };
  if (!allowed[migration.state].includes(target)) throw new Error(`SECURITY_MIGRATION_TRANSITION_INVALID:${migration.state}:${target}`);
  if ((target === "retryable" || target === "recovery_required") && (failure === null || failure.trim().length === 0)) {
    throw new Error("SECURITY_MIGRATION_FAILURE_REQUIRED");
  }
  assertUtc(occurredAtUtc);
  return {
    ...migration,
    state: target,
    failure,
    nextAttemptAtUtc: target === "retryable" ? occurredAtUtc : null,
    version: migration.version + 1,
    updatedAtUtc: occurredAtUtc,
  };
}

export function checkpointSecurityMigration(
  migration: SecurityDomainMigration,
  checkpoint: Readonly<{ cursor: string; migratedItems: number; occurredAtUtc: string }>,
): SecurityDomainMigration {
  if (migration.state !== "active") throw new Error("SECURITY_MIGRATION_CHECKPOINT_FORBIDDEN");
  if (checkpoint.cursor.trim().length === 0) throw new Error("SECURITY_MIGRATION_CURSOR_REQUIRED");
  if (!Number.isSafeInteger(checkpoint.migratedItems)
    || checkpoint.migratedItems < migration.migratedItems
    || checkpoint.migratedItems > migration.totalItems) throw new Error("SECURITY_MIGRATION_PROGRESS_INVALID");
  assertUtc(checkpoint.occurredAtUtc);
  return {
    ...migration,
    cursor: checkpoint.cursor,
    migratedItems: checkpoint.migratedItems,
    version: migration.version + 1,
    updatedAtUtc: checkpoint.occurredAtUtc,
  };
}

function assertUtc(value: string): void {
  if (!value.endsWith("Z") || Number.isNaN(Date.parse(value))) throw new Error("INVALID_UTC_TIMESTAMP");
}
