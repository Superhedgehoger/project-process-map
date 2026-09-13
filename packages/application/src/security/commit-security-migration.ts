import { createHash } from "node:crypto";
import type { PrincipalId, TenantId } from "../../../domain/src/identity.ts";
import { isProjectManager } from "../../../domain/src/project-access.ts";
import { canAccessProjectObjectDuringMigration } from "../access/project-security.ts";
import { ApplicationError } from "../errors.ts";
import type {
  CommandScope,
  CommitSecurityMigrationResult,
  Persistence,
} from "../ports/persistence.ts";
import type { VerifyMigrationReadiness } from "./security-migration-coordinator.ts";

export type CommitSecurityMigrationCommand = Readonly<{
  tenantId: TenantId;
  migrationId: string;
  expectedMigrationVersion: number;
  actorPrincipalId: PrincipalId;
  occurredAtUtc: string;
  idempotencyKey?: string;
}>;

export type { CommitSecurityMigrationResult } from "../ports/persistence.ts";

export class CommitSecurityMigrationHandler {
  readonly #persistence: Persistence;
  readonly #verifyMigrationReadiness: VerifyMigrationReadiness;

  constructor(
    persistence: Persistence,
    verifyMigrationReadiness: VerifyMigrationReadiness,
  ) {
    this.#persistence = persistence;
    this.#verifyMigrationReadiness = verifyMigrationReadiness;
  }

  async execute(command: CommitSecurityMigrationCommand): Promise<CommitSecurityMigrationResult> {
    validate(command);
    const fingerprint = hash({
      migrationId: command.migrationId,
      expectedVersion: command.expectedMigrationVersion,
      occurredAtUtc: command.occurredAtUtc,
    });

    // Check idempotency early if key provided
    if (command.idempotencyKey !== undefined) {
      const scope: CommandScope = {
        principalId: command.actorPrincipalId,
        operation: "commit_security_migration",
        idempotencyKey: command.idempotencyKey,
      };
      const existing = await this.#persistence.read(command.tenantId, async (tx) => {
        return await tx.receipts.get<CommitSecurityMigrationResult>(scope);
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

    await this.#persistence.read(command.tenantId, async (tx) => {
      const currentMigration = await tx.securityMigrations.get(command.migrationId);
      if (currentMigration === undefined) {
        throw new ApplicationError("SECURITY_MIGRATION_NOT_FOUND", "Security migration not found");
      }
      if (currentMigration.version !== command.expectedMigrationVersion) {
        throw new ApplicationError("SECURITY_MIGRATION_VERSION_CONFLICT", "Security migration version conflict");
      }
      if (currentMigration.state !== "verifying") {
        throw new ApplicationError("SECURITY_MIGRATION_COMMIT_INVALID", "Security migration is not ready to commit");
      }
    });

    // Step 2: Coordinate verification through injected narrow operation
    const certified = await this.#verifyMigrationReadiness({
      tenantId: command.tenantId,
      migrationId: command.migrationId,
      purpose: "commit",
    });

    // Step 3: Atomic commit within transaction boundary accepting ONLY certified evidenceId
    try {
      return await this.#persistence.transaction(command.tenantId, async (tx) => {
        return await tx.securityMigrations.commitWithReadinessEvidence({
          migrationId: command.migrationId,
          expectedVersion: command.expectedMigrationVersion,
          evidenceId: certified.evidenceId,
          actorPrincipalId: command.actorPrincipalId,
          occurredAtUtc: command.occurredAtUtc,
          idempotencyKey: command.idempotencyKey,
        });
      });
    } catch (error) {
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
      const migration = await tx.securityMigrations.get(migrationId);
      if (migration === undefined) {
        throw new ApplicationError("SECURITY_MIGRATION_NOT_FOUND", "Security migration not found");
      }
      const principal = await tx.principals.get(actorPrincipalId);
      if (principal?.status !== "active") {
        throw new ApplicationError("NODE_NOT_FOUND", "Node not found");
      }
      const membership = await tx.memberships.get(migration.projectId, actorPrincipalId);
      if (membership?.status !== "active" || !isProjectManager(membership)) {
        throw new ApplicationError("NODE_NOT_FOUND", "Node not found");
      }
      const rootNode = await tx.nodes.get(migration.rootNodeId);
      if (rootNode === undefined || rootNode.projectId !== migration.projectId || rootNode.deletedAtUtc !== null) {
        throw new ApplicationError("NODE_NOT_FOUND", "Node not found");
      }
      const authorized = await canAccessProjectObjectDuringMigration(
        tx,
        membership,
        actorPrincipalId,
        {
          projectId: migration.projectId,
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

function validate(command: CommitSecurityMigrationCommand): void {
  if (
    command.migrationId.trim().length === 0
    || !Number.isSafeInteger(command.expectedMigrationVersion)
    || command.expectedMigrationVersion <= 0
    || !command.occurredAtUtc.endsWith("Z")
    || Number.isNaN(Date.parse(command.occurredAtUtc))
  ) {
    throw new ApplicationError("VALIDATION_FAILED", "Commit security migration command is invalid");
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

