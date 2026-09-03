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
  version: number;
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
  return { ...migration, state: target, failure, version: migration.version + 1 };
}

