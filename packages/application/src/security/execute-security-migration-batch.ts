import type { TenantId } from "../../../domain/src/identity.ts";
import { checkpointSecurityMigration } from "../../../domain/src/security-migration.ts";
import { ApplicationError } from "../errors.ts";
import type { Persistence } from "../ports/persistence.ts";
import {
  buildResumableSecurityMigrationInventory,
  type SecurityMigrationInventoryItem,
} from "./build-security-migration-inventory.ts";

export const maximumSecurityMigrationBatchSize = 100;

export type ExecuteSecurityMigrationBatchCommand = Readonly<{
  tenantId: TenantId;
  migrationId: string;
  expectedMigrationVersion: number;
  batchSize: number;
  occurredAtUtc: string;
}>;

export type SecurityMigrationBatchResult = Readonly<{
  migrationId: string;
  processedItems: readonly Readonly<{
    kind: SecurityMigrationInventoryItem["kind"];
    id: string;
    cursor: string;
    version: number;
  }>[];
  cursor: string | null;
  migratedItems: number;
  totalItems: number;
  migrationVersion: number;
  complete: boolean;
}>;

export type ExecuteSecurityMigrationBatchFailurePoint = "after_first_object" | "before_checkpoint";

export class ExecuteSecurityMigrationBatchHandler {
  readonly #persistence: Persistence;

  constructor(persistence: Persistence) {
    this.#persistence = persistence;
  }

  async execute(
    command: ExecuteSecurityMigrationBatchCommand,
    failurePoint?: ExecuteSecurityMigrationBatchFailurePoint,
  ): Promise<SecurityMigrationBatchResult> {
    validate(command);
    return await this.#persistence.transaction(command.tenantId, async (transaction) => {
      const migration = await transaction.securityMigrations.get(command.migrationId);
      if (migration === undefined) throw new ApplicationError(
        "SECURITY_MIGRATION_NOT_FOUND", "Security migration not found",
      );
      if (migration.version !== command.expectedMigrationVersion) throw new ApplicationError(
        "SECURITY_MIGRATION_VERSION_CONFLICT", "Security migration version conflict",
      );
      if (migration.state !== "active") throw new ApplicationError(
        "SECURITY_MIGRATION_BATCH_INVALID", "Security migration is not active",
      );

      const inventory = await buildResumableSecurityMigrationInventory(transaction, {
        tenantId: command.tenantId,
        projectId: migration.projectId,
        rootNodeId: migration.rootNodeId,
        sourceSecurityDomainId: migration.sourceSecurityDomainId,
        sourceSecurityEpoch: migration.sourceSecurityEpoch,
      }, {
        cursor: migration.cursor,
        migratedItems: migration.migratedItems,
        targetSecurityDomainId: migration.targetSecurityDomainId,
        targetSecurityEpoch: migration.targetSecurityEpoch,
      });
      if (inventory.totalItems !== migration.totalItems) throw new ApplicationError(
        "SECURITY_MIGRATION_BATCH_INVALID", "Security migration inventory no longer matches its plan",
      );

      const selected = inventory.items.slice(migration.migratedItems, migration.migratedItems + command.batchSize);
      if (selected.length === 0) return resultFor(migration.id, [], migration.cursor, migration.migratedItems,
        migration.totalItems, migration.version);

      const processed: Array<{ kind: SecurityMigrationInventoryItem["kind"]; id: string; cursor: string; version: number }> = [];
      for (const [index, current] of selected.entries()) {
        const updated = current.kind === "node"
          ? await transaction.nodes.migrateSecurityOwnership(migration.id, current.id, current.version)
          : current.kind === "task"
            ? await transaction.tasks.migrateSecurityOwnership(migration.id, current.id, current.version)
            : await transaction.assets.migrateSecurityOwnership(migration.id, current.id, current.version);
        processed.push({ kind: current.kind, id: current.id, cursor: current.cursor, version: updated.version });
        if (failurePoint === "after_first_object" && index === 0) throw new Error("INJECTED_FAILURE:after_first_object");
      }
      if (failurePoint === "before_checkpoint") throw new Error("INJECTED_FAILURE:before_checkpoint");

      const last = selected.at(-1) as SecurityMigrationInventoryItem;
      const checkpoint = checkpointSecurityMigration(migration, {
        cursor: last.cursor,
        migratedItems: migration.migratedItems + selected.length,
        occurredAtUtc: command.occurredAtUtc,
      });
      await transaction.securityMigrations.saveProgressPreservingPlan(migration.id, checkpoint, migration.version);
      return resultFor(checkpoint.id, processed, checkpoint.cursor, checkpoint.migratedItems,
        checkpoint.totalItems, checkpoint.version);
    });
  }
}

function resultFor(
  migrationId: string,
  processedItems: SecurityMigrationBatchResult["processedItems"],
  cursor: string | null,
  migratedItems: number,
  totalItems: number,
  migrationVersion: number,
): SecurityMigrationBatchResult {
  return {
    migrationId,
    processedItems,
    cursor,
    migratedItems,
    totalItems,
    migrationVersion,
    complete: migratedItems === totalItems,
  };
}

function validate(command: ExecuteSecurityMigrationBatchCommand): void {
  if (command.migrationId.trim().length === 0
    || !Number.isSafeInteger(command.expectedMigrationVersion) || command.expectedMigrationVersion <= 0
    || !Number.isSafeInteger(command.batchSize) || command.batchSize <= 0
    || command.batchSize > maximumSecurityMigrationBatchSize
    || !command.occurredAtUtc.endsWith("Z") || Number.isNaN(Date.parse(command.occurredAtUtc))) {
    throw new ApplicationError("VALIDATION_FAILED", "Security migration batch command is invalid");
  }
}
