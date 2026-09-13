import type { TenantId } from "../../../domain/src/identity.ts";
import { transitionSecurityMigration } from "../../../domain/src/security-migration.ts";
import { ApplicationError } from "../errors.ts";
import type { Persistence } from "../ports/persistence.ts";
import { buildResumableSecurityMigrationInventory } from "./build-security-migration-inventory.ts";
import {
  collectSecurityMigrationManifest,
  computeSecurityMigrationManifestDigest,
} from "./security-migration-manifest.ts";

export type BeginSecurityMigrationVerificationCommand = Readonly<{
  tenantId: TenantId;
  migrationId: string;
  expectedMigrationVersion: number;
  occurredAtUtc: string;
}>;

export type SecurityMigrationVerificationResult = Readonly<{
  migrationId: string;
  state: "verifying";
  cursor: string;
  migratedItems: number;
  totalItems: number;
  migrationVersion: number;
}>;

export class BeginSecurityMigrationVerificationHandler {
  readonly #persistence: Persistence;

  constructor(persistence: Persistence) {
    this.#persistence = persistence;
  }

  async execute(command: BeginSecurityMigrationVerificationCommand): Promise<SecurityMigrationVerificationResult> {
    validate(command);
    return await this.#persistence.transaction(command.tenantId, async (transaction) => {
      const migration = await transaction.securityMigrations.get(command.migrationId);
      if (migration === undefined) throw new ApplicationError(
        "SECURITY_MIGRATION_NOT_FOUND", "Security migration not found",
      );
      if (migration.version !== command.expectedMigrationVersion) throw new ApplicationError(
        "SECURITY_MIGRATION_VERSION_CONFLICT", "Security migration version conflict",
      );
      if (migration.state !== "active") invalid();

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
      const lastCursor = inventory.items.at(-1)?.cursor;
      if (inventory.totalItems === 0 || migration.totalItems !== inventory.totalItems
        || migration.migratedItems !== migration.totalItems || migration.cursor === null
        || migration.cursor !== lastCursor) invalid();

      const verifying = transitionSecurityMigration(migration, "verifying", command.occurredAtUtc);
      const manifest = await collectSecurityMigrationManifest(transaction, migration);
      const manifestDigest = computeSecurityMigrationManifestDigest(manifest);
      await transaction.securityMigrations.saveManifestSnapshot({
        tenantId: command.tenantId,
        projectId: migration.projectId,
        migrationId: migration.id,
        sourceSecurityDomainId: migration.sourceSecurityDomainId,
        targetSecurityDomainId: migration.targetSecurityDomainId,
        sourceSecurityEpoch: migration.sourceSecurityEpoch,
        targetSecurityEpoch: migration.targetSecurityEpoch,
        manifestDigest,
        itemCount: manifest.items.length,
        items: manifest.items,
        createdAtUtc: command.occurredAtUtc,
      });
      await transaction.securityMigrations.saveProgressPreservingPlan(migration.id, verifying, migration.version);
      return {
        migrationId: verifying.id,
        state: "verifying",
        cursor: verifying.cursor as string,
        migratedItems: verifying.migratedItems,
        totalItems: verifying.totalItems,
        migrationVersion: verifying.version,
      };
    });
  }
}

function validate(command: BeginSecurityMigrationVerificationCommand): void {
  if (command.migrationId.trim().length === 0
    || !Number.isSafeInteger(command.expectedMigrationVersion) || command.expectedMigrationVersion <= 0
    || !command.occurredAtUtc.endsWith("Z") || Number.isNaN(Date.parse(command.occurredAtUtc))) {
    throw new ApplicationError("VALIDATION_FAILED", "Security migration verification command is invalid");
  }
}

function invalid(): never {
  throw new ApplicationError(
    "SECURITY_MIGRATION_VERIFICATION_INVALID", "Security migration is not ready for verification",
  );
}
