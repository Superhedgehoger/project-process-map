import { createHash, randomUUID } from "node:crypto";
import type { PrincipalId, TenantId } from "../../../domain/src/identity.ts";
import { isProjectManager } from "../../../domain/src/project-access.ts";
import {
  transitionSecurityMigration,
  type SecurityMigrationAuditEntry,
} from "../../../domain/src/security-migration.ts";
import { canAccessProjectObjectDuringMigration } from "../access/project-security.ts";
import { ApplicationError } from "../errors.ts";
import type {
  CommandScope,
  Persistence,
  RollbackSecurityMigrationResult,
  SecurityMigrationReadinessEvidenceRecord,
} from "../ports/persistence.ts";
import type { VerifyMigrationReadiness } from "./security-migration-coordinator.ts";

export type RollbackSecurityMigrationCommand = Readonly<{
  tenantId: TenantId;
  migrationId: string;
  expectedMigrationVersion: number;
  actorPrincipalId: PrincipalId;
  reason: string;
  occurredAtUtc: string;
  idempotencyKey?: string;
}>;

export type { RollbackSecurityMigrationResult } from "../ports/persistence.ts";

export class RollbackSecurityMigrationHandler {
  readonly #persistence: Persistence;
  readonly #verifyMigrationReadiness?: VerifyMigrationReadiness | undefined;

  constructor(
    persistence: Persistence,
    verifyMigrationReadiness?: VerifyMigrationReadiness | undefined,
  ) {
    this.#persistence = persistence;
    this.#verifyMigrationReadiness = verifyMigrationReadiness;
  }

  async execute(command: RollbackSecurityMigrationCommand): Promise<RollbackSecurityMigrationResult> {
    validate(command);
    const fingerprint = hash({
      migrationId: command.migrationId,
      expectedVersion: command.expectedMigrationVersion,
      reason: command.reason.trim(),
      occurredAtUtc: command.occurredAtUtc,
    });

    // Check idempotency early if key provided
    if (command.idempotencyKey !== undefined) {
      const scope: CommandScope = {
        principalId: command.actorPrincipalId,
        operation: "rollback_security_migration",
        idempotencyKey: command.idempotencyKey,
      };
      const existing = await this.#persistence.read(command.tenantId, async (tx) => {
        return await tx.receipts.get<RollbackSecurityMigrationResult>(scope);
      });
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new ApplicationError("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", "Idempotency key reused with different payload");
        }
        await this.#reauthorizeActor(command.tenantId, command.migrationId, command.actorPrincipalId);
        return { ...structuredClone(existing.result), replayed: true };
      }
    }

    // Step 1: Pre-read scope and verify actor authority against trusted persistence clock before calling coordinator
    await this.#reauthorizeActor(command.tenantId, command.migrationId, command.actorPrincipalId);

    const migration = await this.#persistence.read(command.tenantId, async (tx) => {
      const currentMigration = await tx.securityMigrations.get(command.migrationId);
      if (currentMigration === undefined) {
        throw new ApplicationError("SECURITY_MIGRATION_NOT_FOUND", "Security migration not found");
      }
      if (currentMigration.version !== command.expectedMigrationVersion) {
        throw new ApplicationError("SECURITY_MIGRATION_VERSION_CONFLICT", "Security migration version conflict");
      }
      if (!["planned", "active", "verifying", "retryable", "recovery_required"].includes(currentMigration.state)) {
        throw new ApplicationError("SECURITY_MIGRATION_ROLLBACK_INVALID", `Cannot rollback migration in ${currentMigration.state} state`);
      }
      return currentMigration;
    });

    // Step 2: Handle rollback readiness through composition-injected narrow operation
    let rollbackEvidenceId: string | undefined;

    if (migration.migratedItems > 0) {
      if (this.#verifyMigrationReadiness === undefined) {
        throw new ApplicationError(
          "HULY_ADAPTER_NOT_CONFIGURED",
          "Readiness verifier is mandatory to roll back a migration with migrated items",
        );
      }

      let certified: { evidenceId: string };
      try {
        certified = await this.#verifyMigrationReadiness({
          tenantId: command.tenantId,
          migrationId: command.migrationId,
          purpose: "rollback",
        });
        rollbackEvidenceId = certified.evidenceId;
      } catch (error) {
        const failureReason = error instanceof Error ? error.message : String(error);
        await this.#persistence.transaction(command.tenantId, async (tx) => {
          const current = await tx.securityMigrations.get(command.migrationId);
          if (current === undefined || current.version !== command.expectedMigrationVersion) {
            throw new ApplicationError("SECURITY_MIGRATION_VERSION_CONFLICT", "Security migration version conflict");
          }
          if (current.state !== "recovery_required") {
            const recoveryRequired = transitionSecurityMigration(
              current,
              "recovery_required",
              command.occurredAtUtc,
              `Rollback external readiness guard failed: ${failureReason}`,
            );
            await tx.securityMigrations.saveProgressPreservingPlan(
              current.id,
              recoveryRequired,
              current.version,
            );

            const audit: SecurityMigrationAuditEntry = {
              tenantId: command.tenantId,
              auditId: randomUUID(),
              migrationId: recoveryRequired.id,
              projectId: recoveryRequired.projectId,
              action: "recovery_required",
              actorPrincipalId: command.actorPrincipalId,
              reason: `Rollback external epoch readiness check failed: ${failureReason}`,
              sourceSecurityDomainId: recoveryRequired.sourceSecurityDomainId,
              targetSecurityDomainId: recoveryRequired.targetSecurityDomainId,
              sourceSecurityEpoch: recoveryRequired.sourceSecurityEpoch,
              targetSecurityEpoch: recoveryRequired.targetSecurityEpoch,
              migratedItems: recoveryRequired.migratedItems,
              occurredAtUtc: command.occurredAtUtc,
            };
            await tx.securityMigrationAudits.append(audit);
          }
        });

        const isManifestMismatch = (error instanceof ApplicationError && (error.code === "SECURITY_MIGRATION_MANIFEST_MISMATCH" || (error.code as string) === "SECURITY_MIGRATION_MANIFEST_SNAPSHOT_NOT_FOUND"))
          || failureReason.includes("SECURITY_MIGRATION_MANIFEST_SNAPSHOT_NOT_FOUND")
          || failureReason.includes("SECURITY_MIGRATION_MANIFEST_MISMATCH");
        const errCode = isManifestMismatch
          ? "SECURITY_MIGRATION_MANIFEST_MISMATCH"
          : "SECURITY_MIGRATION_CONVERGENCE_NOT_READY";

        throw new ApplicationError(
          errCode,
          `Rollback failed closed into recovery_required: ${failureReason}`,
        );
      }
    }

    // Step 3: Atomic rollback within transaction boundary accepting evidenceId
    try {
      return await this.#persistence.transaction(command.tenantId, async (tx) => {
        return await tx.securityMigrations.rollbackWithAudit({
          migrationId: command.migrationId,
          expectedVersion: command.expectedMigrationVersion,
          evidenceId: rollbackEvidenceId,
          actorPrincipalId: command.actorPrincipalId,
          reason: command.reason.trim(),
          occurredAtUtc: command.occurredAtUtc,
          idempotencyKey: command.idempotencyKey,
        });
      });
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : String(error);
      if (error instanceof ApplicationError && error.code === "NODE_NOT_FOUND") {
        throw error;
      }
      if (failureReason === "SECURITY_MIGRATION_VERSION_CONFLICT" || failureReason === "NODE_NOT_FOUND") {
        if (error instanceof ApplicationError) throw error;
        throw new ApplicationError(failureReason as any, failureReason);
      }

      // If rollback failed at the write boundary after readiness verification (e.g. fence active or manifest mismatch),
      // transition migration to recovery_required fail-closed
      await this.#persistence.transaction(command.tenantId, async (tx) => {
        const current = await tx.securityMigrations.get(command.migrationId);
        if (current && current.state !== "recovery_required" && current.state !== "rolled_back") {
          const recoveryRequired = transitionSecurityMigration(
            current,
            "recovery_required",
            command.occurredAtUtc,
            `Rollback write boundary failed: ${failureReason}`,
          );
          await tx.securityMigrations.saveProgressPreservingPlan(
            current.id,
            recoveryRequired,
            current.version,
          );
          const audit: SecurityMigrationAuditEntry = {
            tenantId: command.tenantId,
            auditId: randomUUID(),
            migrationId: recoveryRequired.id,
            projectId: recoveryRequired.projectId,
            action: "recovery_required",
            actorPrincipalId: command.actorPrincipalId,
            reason: `Rollback write boundary failed: ${failureReason}`,
            sourceSecurityDomainId: recoveryRequired.sourceSecurityDomainId,
            targetSecurityDomainId: recoveryRequired.targetSecurityDomainId,
            sourceSecurityEpoch: recoveryRequired.sourceSecurityEpoch,
            targetSecurityEpoch: recoveryRequired.targetSecurityEpoch,
            migratedItems: recoveryRequired.migratedItems,
            occurredAtUtc: command.occurredAtUtc,
          };
          await tx.securityMigrationAudits.append(audit);
        }
      });

      if (error instanceof ApplicationError) throw error;
      if (error instanceof Error) {
        throw new ApplicationError(error.message as any, error.message);
      }
      throw error;
    }
  }

  async #reauthorizeActor(
    tenantId: TenantId,
    migrationId: string,
    actorPrincipalId: PrincipalId,
  ): Promise<void> {
    const trustedNowUtc = this.#persistence.nowUtc();
    await this.#persistence.read(tenantId, async (tx) => {
      const currentMigration = await tx.securityMigrations.get(migrationId);
      if (currentMigration === undefined) {
        throw new ApplicationError("SECURITY_MIGRATION_NOT_FOUND", "Security migration not found");
      }
      const principal = await tx.principals.get(actorPrincipalId);
      if (principal?.status !== "active") {
        throw new ApplicationError("NODE_NOT_FOUND", "Node not found");
      }
      const membership = await tx.memberships.get(currentMigration.projectId, actorPrincipalId);
      if (membership?.status !== "active" || !isProjectManager(membership)) {
        throw new ApplicationError("NODE_NOT_FOUND", "Node not found");
      }
      const rootNode = await tx.nodes.get(currentMigration.rootNodeId);
      if (rootNode === undefined || rootNode.projectId !== currentMigration.projectId || rootNode.deletedAtUtc !== null) {
        throw new ApplicationError("NODE_NOT_FOUND", "Node not found");
      }
      const authorized = await canAccessProjectObjectDuringMigration(
        tx,
        membership,
        actorPrincipalId,
        {
          projectId: currentMigration.projectId,
          ownerNodeId: rootNode.id,
          securityDomainId: rootNode.securityDomainId,
          securityEpoch: rootNode.securityEpoch,
        },
        "manage_access",
        trustedNowUtc,
      );
      if (!authorized) {
        throw new ApplicationError("NODE_NOT_FOUND", "Node not found");
      }
    });
  }
}

function validate(command: RollbackSecurityMigrationCommand): void {
  if (
    command.migrationId.trim().length === 0
    || !Number.isSafeInteger(command.expectedMigrationVersion)
    || command.expectedMigrationVersion <= 0
    || command.reason.trim().length === 0
    || !command.occurredAtUtc.endsWith("Z")
    || Number.isNaN(Date.parse(command.occurredAtUtc))
  ) {
    throw new ApplicationError("VALIDATION_FAILED", "Rollback security migration command is invalid");
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
