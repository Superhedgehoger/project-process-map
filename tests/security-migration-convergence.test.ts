import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import { HULY_IDS, HulyRestCollaborationEpochReadinessAdapter, type HulyRestConfig } from "../packages/adapters/src/huly-rest.ts";
import { ApplicationError } from "../packages/application/src/errors.ts";
import { BeginSecurityMigrationVerificationHandler } from "../packages/application/src/security/begin-security-migration-verification.ts";
import {
  CommitSecurityMigrationHandler,
} from "../packages/application/src/security/commit-security-migration.ts";
import { ExecuteSecurityMigrationBatchHandler } from "../packages/application/src/security/execute-security-migration-batch.ts";
import {
  RollbackSecurityMigrationHandler,
} from "../packages/application/src/security/rollback-security-migration.ts";
import {
  collectSecurityMigrationManifest,
  computeSecurityMigrationManifestDigest,
} from "../packages/application/src/security/security-migration-manifest.ts";
import { SecurityMigrationInventoryReader } from "../packages/application/src/security/build-security-migration-inventory.ts";
import {
  createTestMemoryBundle,
  createTestSqliteBundle,
  getTestReadinessHarness,
} from "./helpers/test-persistence-bundle.ts";
import type { TestReadinessHarness } from "../packages/adapters/src/security-migration-coordinator.ts";
import type { VerifyMigrationReadiness } from "../packages/application/src/security/security-migration-coordinator.ts";
import type {
  Persistence,
  SecurityMigrationReadinessEvidenceRecord,
} from "../packages/application/src/ports/persistence.ts";
import type {
  ExternalCollaborationEpochReadinessPort,
  EpochReadinessScope,
  SecurityMigrationReadinessEvidence,
} from "../packages/application/src/ports/integrations.ts";
import type { Asset } from "../packages/domain/src/assets.ts";
import { externalReference } from "../packages/domain/src/external-reference.ts";
import { principalId, tenantId, type TenantId } from "../packages/domain/src/identity.ts";
import type { ProjectNode } from "../packages/domain/src/project-structure.ts";
import {
  checkpointSecurityMigration,
  effectiveSecurityDomains,
  transitionSecurityMigration,
  type SecurityDomainMigration,
} from "../packages/domain/src/security-migration.ts";
import type { ProductTask } from "../packages/domain/src/tasks.ts";

const tenant = tenantId("tenant-convergence");
const projectId = "project-convergence";
const sourceDomainId = "domain-source";
const targetDomainId = "domain-target";
const managerPrincipal = principalId("principal-manager");
const regularPrincipal = principalId("principal-regular");

function makeReadinessEvidence(
  challenge: SecurityMigrationReadinessEvidenceRecord,
  overrides: Partial<SecurityMigrationReadinessEvidence> = {},
): SecurityMigrationReadinessEvidence {
  return {
    evidenceId: challenge.evidenceId,
    nonce: challenge.nonce,
    tenantId: challenge.tenantId,
    projectId: challenge.projectId,
    migrationId: challenge.migrationId,
    purpose: challenge.purpose,
    sourceSecurityDomainId: challenge.sourceSecurityDomainId,
    targetSecurityDomainId: challenge.targetSecurityDomainId,
    sourceSecurityEpoch: challenge.sourceSecurityEpoch,
    targetSecurityEpoch: challenge.targetSecurityEpoch,
    manifestDigest: challenge.manifestDigest,
    itemCount: challenge.itemCount,

    expiresAtUtc: challenge.expiresAtUtc,
    consumedAtUtc: null,
    verifiedAtUtc: challenge.issuedAtUtc,
    provider: "huly",
    converged: true,
    channels: { issue: "converged", attachment: "converged", blob: "converged" },
    ...overrides,
  };
}

const makeRecordVerifiedEvidenceParams = makeReadinessEvidence;

function makeCommitHandler(
  persistence: Persistence,
  readinessPort?: ExternalCollaborationEpochReadinessPort,
  verifyMigrationReadiness?: VerifyMigrationReadiness,
): CommitSecurityMigrationHandler {
  let verify = verifyMigrationReadiness;
  if (verify === undefined && readinessPort !== undefined) {
    const harness = getTestReadinessHarness(persistence);
    if (harness !== undefined) {
      verify = harness.createVerificationOperation(readinessPort);
    }
  }
  return new CommitSecurityMigrationHandler(
    persistence,
    verify ?? (() => {
      throw new ApplicationError("HULY_ADAPTER_NOT_CONFIGURED", "Collaboration epoch readiness adapter is not configured");
    }),
  );
}

function makeRollbackHandler(
  persistence: Persistence,
  readinessPort?: ExternalCollaborationEpochReadinessPort,
  verifyMigrationReadiness?: VerifyMigrationReadiness,
): RollbackSecurityMigrationHandler {
  let verify = verifyMigrationReadiness;
  if (verify === undefined && readinessPort !== undefined) {
    const harness = getTestReadinessHarness(persistence);
    if (harness !== undefined) {
      verify = harness.createVerificationOperation(readinessPort);
    }
  }
  return new RollbackSecurityMigrationHandler(
    persistence,
    verify,
  );
}

async function issueAndCertifyChallenge(
  persistence: Persistence,
  tenantId: TenantId,
  migrationId: string,
  purpose: "commit" | "rollback" = "commit",
  evidenceOverrides: Partial<SecurityMigrationReadinessEvidence> = {},
): Promise<SecurityMigrationReadinessEvidenceRecord> {
  const harness = getTestReadinessHarness(persistence);
  if (harness === undefined) throw new Error("Test harness not initialized for persistence");
  const challenge = await harness.issueChallenge(tenantId, { migrationId, purpose });
  const evidence = makeReadinessEvidence(challenge, evidenceOverrides);
  return await harness.recordVerifiedEvidence(tenantId, {
    evidenceId: challenge.evidenceId,
    nonce: challenge.nonce,
    tenantId: challenge.tenantId,
    projectId: challenge.projectId,
    migrationId: challenge.migrationId,
    purpose: challenge.purpose,
    sourceSecurityDomainId: challenge.sourceSecurityDomainId,
    targetSecurityDomainId: challenge.targetSecurityDomainId,
    sourceSecurityEpoch: challenge.sourceSecurityEpoch,
    targetSecurityEpoch: challenge.targetSecurityEpoch,
    manifestDigest: challenge.manifestDigest,
    itemCount: challenge.itemCount,
    provider: evidence.provider,
    converged: evidence.converged,
    issuedAtUtc: challenge.issuedAtUtc,
    expiresAtUtc: challenge.expiresAtUtc,
    channels: evidence.channels,
    reason: evidence.reason,
  });
}

type Fixture = Readonly<{
  name: "memory" | "sqlite";
  persistence: Persistence;
  path: string | null;
  cleanup(): Promise<void>;
  testHarness: TestReadinessHarness;
}>;

async function fixture(
  name: "memory" | "sqlite",
  options?: { now?: () => Date; verifier?: ExternalCollaborationEpochReadinessPort },
): Promise<Fixture> {
  if (name === "memory") {
    const bundle = createTestMemoryBundle(options);
    return {
      name,
      persistence: bundle.persistence,
      path: null,
      cleanup: async () => await bundle.persistence.close(),
      testHarness: bundle.testHarness,
    };
  }
  const directory = await mkdtemp(join(tmpdir(), "ppm-convergence-"));
  const path = join(directory, "convergence.sqlite");
  const bundle = createTestSqliteBundle({
    path,
    busyTimeoutMilliseconds: 5_000,
    ...(options?.now ? { now: options.now } : {}),
    ...(options?.verifier ? { verifier: options.verifier } : {}),
  });
  return {
    name,
    persistence: bundle.persistence,
    path,
    cleanup: async () => {
      await bundle.persistence.close();
      await rm(directory, { recursive: true, force: true });
    },
    testHarness: bundle.testHarness,
  };
}

class TestEpochReadinessAdapter implements ExternalCollaborationEpochReadinessPort {
  converged = true;
  channels: { issue: "converged" | "not_converged"; attachment: "converged" | "not_converged"; blob: "converged" | "not_converged" } = {
    issue: "converged",
    attachment: "converged",
    blob: "converged",
  };
  simulatedError: Error | null = null;
  lastScope: EpochReadinessScope | null = null;
  evidenceIdOverride?: string;
  nonceOverride?: string;
  manifestDigestOverride?: string;
  expiresAtUtcOverride?: string;
  verifiedAtUtcOverride?: string;
  targetEpochOverride?: number;

  async checkEpochReadiness(scope: EpochReadinessScope): Promise<SecurityMigrationReadinessEvidence> {
    this.lastScope = scope;
    if (this.simulatedError !== null) throw this.simulatedError;
    return {
      evidenceId: this.evidenceIdOverride ?? scope.evidenceId,
      nonce: this.nonceOverride ?? scope.nonce,
      tenantId: scope.tenantId,
      migrationId: scope.migrationId,
      purpose: scope.purpose,
      projectId: scope.projectId,
      manifestDigest: this.manifestDigestOverride ?? scope.manifestDigest,
      sourceSecurityDomainId: scope.sourceSecurityDomainId,
      targetSecurityDomainId: scope.targetSecurityDomainId,
      sourceSecurityEpoch: scope.sourceSecurityEpoch,
      targetSecurityEpoch: this.targetEpochOverride ?? scope.targetSecurityEpoch,
      provider: "huly",
      converged: this.converged,
      channels: { ...this.channels },
      verifiedAtUtc: this.verifiedAtUtcOverride ?? scope.issuedAtUtc ?? "2026-09-11T03:59:00.000Z",
      expiresAtUtc: this.expiresAtUtcOverride ?? scope.expiresAtUtc,
      consumedAtUtc: null,
      itemCount: scope.itemCount,
      ...(this.converged ? {} : { reason: "channels not converged" }),
    };
  }
}

function node(id = "root", parentId: string | null = null, domain: string | null = sourceDomainId, epoch = 1): ProjectNode {
  return {
    tenantId: tenant,
    id,
    projectId,
    parentId,
    title: id,
    kind: "work_package",
    securityDomainId: domain,
    securityEpoch: epoch,
    version: 1,
    deletedAtUtc: null,
  };
}

function task(id = "task-1", ownerNodeId = "root", domain: string | null = sourceDomainId, epoch = 1): ProductTask {
  return {
    tenantId: tenant,
    id,
    projectId,
    ownerNodeId,
    securityDomainId: domain,
    securityEpoch: epoch,
    title: id,
    assigneePrincipalId: null,
    requiresAcceptance: false,
    reviewerPrincipalId: null,
    executionState: "todo",
    reviewState: "not_required",
    version: 1,
    deletedAtUtc: null,
  };
}

function asset(id = "asset-1", ownerNodeId = "root", domain: string | null = sourceDomainId, epoch = 1): Asset {
  return {
    tenantId: tenant,
    id,
    projectId,
    ownerNodeId,
    securityDomainId: domain,
    securityEpoch: epoch,
    uploaderPrincipalId: managerPrincipal,
    displayName: "asset.txt",
    contentType: "text/plain",
    size: 1,
    sha256: "c".repeat(64),
    lifecycleState: "available",
    failureCode: null,
    version: 1,
    deletedAtUtc: null,
  };
}

async function setupBaseline(persistence: Persistence, options: { withBindings?: boolean } = {}): Promise<void> {
  await persistence.transaction(tenant, async (tx) => {
    await tx.principals.insert({
      tenantId: tenant,
      id: managerPrincipal,
      kind: "user",
      status: "active",
      version: 1,
      createdAtUtc: "2026-09-11T00:00:00.000Z",
      updatedAtUtc: "2026-09-11T00:00:00.000Z",
    });
    await tx.principals.insert({
      tenantId: tenant,
      id: regularPrincipal,
      kind: "user",
      status: "active",
      version: 1,
      createdAtUtc: "2026-09-11T00:00:00.000Z",
      updatedAtUtc: "2026-09-11T00:00:00.000Z",
    });
    await tx.memberships.insert({
      tenantId: tenant,
      projectId,
      principalId: managerPrincipal,
      role: "project_manager",
      status: "active",
      securityDomainIds: [],
      version: 1,
      createdAtUtc: "2026-09-11T00:00:00.000Z",
      updatedAtUtc: "2026-09-11T00:00:00.000Z",
    });
    await tx.memberships.insert({
      tenantId: tenant,
      projectId,
      principalId: regularPrincipal,
      role: "member",
      status: "active",
      securityDomainIds: [],
      version: 1,
      createdAtUtc: "2026-09-11T00:00:00.000Z",
      updatedAtUtc: "2026-09-11T00:00:00.000Z",
    });
    await tx.nodes.insert(node("root", null, sourceDomainId, 1));
    await tx.nodes.insert(node("target-root", null, targetDomainId, 2));
    await tx.nodes.insert(node("child", "root", sourceDomainId, 1));
    await tx.tasks.insert(task("task-1", "child", sourceDomainId, 1));
    await tx.assets.insert(asset("asset-1", "child", sourceDomainId, 1));
    await tx.securityDomains.insert({
      tenantId: tenant,
      id: sourceDomainId,
      projectId,
      rootNodeId: "root",
      parentSecurityDomainId: null,
      permissionVersion: 1,
      version: 1,
      createdByPrincipalId: managerPrincipal,
      createdAtUtc: "2026-09-11T00:00:00.000Z",
      deletedAtUtc: null,
    });
    await tx.securityDomains.insert({
      tenantId: tenant,
      id: targetDomainId,
      projectId,
      rootNodeId: "target-root",
      parentSecurityDomainId: null,
      permissionVersion: 1,
      version: 1,
      createdByPrincipalId: managerPrincipal,
      createdAtUtc: "2026-09-11T00:00:00.000Z",
      deletedAtUtc: null,
    });
    await tx.securityGrants.insert({
      tenantId: tenant,
      id: "grant-source-manager",
      securityDomainId: sourceDomainId,
      principalId: managerPrincipal,
      capability: "manage_access",
      status: "active",
      expiresAtUtc: null,
      grantedByPrincipalId: managerPrincipal,
      reason: "setup",
      version: 1,
      createdAtUtc: "2026-09-11T00:00:00.000Z",
      updatedAtUtc: "2026-09-11T00:00:00.000Z",
    });
    await tx.securityGrants.insert({
      tenantId: tenant,
      id: "grant-target-manager",
      securityDomainId: targetDomainId,
      principalId: managerPrincipal,
      capability: "manage_access",
      status: "active",
      expiresAtUtc: null,
      grantedByPrincipalId: managerPrincipal,
      reason: "setup",
      version: 1,
      createdAtUtc: "2026-09-11T00:00:00.000Z",
      updatedAtUtc: "2026-09-11T00:00:00.000Z",
    });

    if (options.withBindings) {
      await tx.externalBindings.insert({
        tenantId: tenant,
        id: "binding:collaboration:task:task-1",
        ownerType: "task",
        ownerId: "task-1",
        role: "collaboration_projection",
        reference: externalReference("huly", "task", "issue-task-1"),
        desiredVersion: 1,
        observedVersion: 1,
        syncWatermark: "wm-1",
        syncState: "synced",
        lastError: null,
        version: 1,
        updatedAtUtc: "2026-09-11T00:00:00.000Z",
      });
      await tx.externalBindings.insert({
        tenantId: tenant,
        id: "binding:collaboration:asset:asset-1",
        ownerType: "asset",
        ownerId: "asset-1",
        role: "collaboration_projection",
        reference: externalReference("huly", "attachment", "att-asset-1"),
        desiredVersion: 1,
        observedVersion: 1,
        syncWatermark: "wm-2",
        syncState: "synced",
        lastError: null,
        version: 1,
        updatedAtUtc: "2026-09-11T00:00:00.000Z",
      });
      await tx.externalBindings.insert({
        tenantId: tenant,
        id: "binding:blob:asset:asset-1",
        ownerType: "asset",
        ownerId: "asset-1",
        role: "blob_replica",
        reference: externalReference("huly", "blob", "blob-asset-1"),
        desiredVersion: 1,
        observedVersion: 1,
        syncWatermark: null,
        syncState: "synced",
        lastError: null,
        version: 1,
        updatedAtUtc: "2026-09-11T00:00:00.000Z",
      });
    }
  });
}

async function prepareVerifyingMigration(
  persistence: Persistence,
  options: { withBindings?: boolean; target?: string | null } = {},
): Promise<SecurityDomainMigration> {
  await setupBaseline(persistence, options);
  const planned: SecurityDomainMigration = {
    tenantId: tenant,
    id: "mig-test",
    projectId,
    rootNodeId: "root",
    sourceSecurityDomainId: sourceDomainId,
    targetSecurityDomainId: options.target !== undefined ? options.target : targetDomainId,
    hierarchyRevision: 1,
    sourceSecurityEpoch: 1,
    targetSecurityEpoch: 2,
    state: "planned",
    cursor: null,
    totalItems: 4,
    migratedItems: 0,
    failure: null,
    nextAttemptAtUtc: null,
    deadlineAtUtc: "2026-09-12T00:00:00.000Z",
    version: 1,
    createdAtUtc: "2026-09-11T00:00:00.000Z",
    updatedAtUtc: "2026-09-11T00:00:00.000Z",
  };
  await persistence.transaction(tenant, async (tx) => {
    await tx.securityMigrations.insert(planned);
    const active = transitionSecurityMigration(planned, "active", "2026-09-11T01:00:00.000Z");
    await tx.securityMigrations.saveProgressPreservingPlan(active.id, active, planned.version);
  });
  const batchHandler = new ExecuteSecurityMigrationBatchHandler(persistence);
  await batchHandler.execute({
    tenantId: tenant,
    migrationId: planned.id,
    expectedMigrationVersion: 2,
    batchSize: 10,
    occurredAtUtc: "2026-09-11T02:00:00.000Z",
  });
  const verifyHandler = new BeginSecurityMigrationVerificationHandler(persistence);
  await verifyHandler.execute({
    tenantId: tenant,
    migrationId: planned.id,
    expectedMigrationVersion: 3,
    occurredAtUtc: "2026-09-11T03:00:00.000Z",
  });
  const verifying = await persistence.read(tenant, async (tx) => await tx.securityMigrations.get(planned.id));
  assert.equal(verifying?.state, "verifying");
  assert.equal(verifying?.version, 4);
  return verifying as SecurityDomainMigration;
}

test("TC-SEC-002K verifying migration atomically advances to committed when epoch readiness and fences pass", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      const migration = await prepareVerifyingMigration(current.persistence, { withBindings: true });
      const readinessPort = new TestEpochReadinessAdapter();
      const handler = makeCommitHandler(current.persistence, readinessPort);

      const result = await handler.execute({
        tenantId: tenant,
        migrationId: migration.id,
        expectedMigrationVersion: migration.version,
        actorPrincipalId: managerPrincipal,
        occurredAtUtc: "2026-09-11T04:00:00.000Z",
        idempotencyKey: "commit-1",
      });

      assert.equal(result.migrationId, migration.id, name);
      assert.equal(result.state, "committed", name);
      assert.equal(result.migrationVersion, migration.version + 1, name);

      const stored = await current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(migration.id));
      assert.equal(stored?.state, "committed", name);
      assert.equal(stored?.version, migration.version + 1, name);
      assert.deepEqual(effectiveSecurityDomains(stored as SecurityDomainMigration), [targetDomainId], name);

      const audits = await current.persistence.read(tenant, async (tx) =>
        await tx.securityMigrationAudits.listByMigration(migration.id));
      assert.equal(audits.length, 1, name);
      assert.equal(audits[0]?.action, "committed", name);
      assert.equal(audits[0]?.actorPrincipalId, managerPrincipal, name);
      assert.equal(audits[0]?.targetSecurityEpoch, 2, name);

      // Replay returns cached receipt
      const replay = await handler.execute({
        tenantId: tenant,
        migrationId: migration.id,
        expectedMigrationVersion: migration.version,
        actorPrincipalId: managerPrincipal,
        occurredAtUtc: "2026-09-11T04:00:00.000Z",
        idempotencyKey: "commit-1",
      });
      assert.deepEqual(replay, { ...result, replayed: true }, name);
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002K direct persistence attempt to jump to committed or rolled_back is rejected (terminal bypass forbidden)", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      const migration = await prepareVerifyingMigration(current.persistence);

      await current.persistence.transaction(tenant, async (tx) => {
        // Attempting to jump directly to committed via generic saveProgressPreservingPlan
        await assert.rejects(
          tx.securityMigrations.saveProgressPreservingPlan(
            migration.id,
            { ...migration, state: "committed", version: migration.version + 1 },
            migration.version,
          ),
          (err: unknown) => err instanceof Error && err.message === "SECURITY_MIGRATION_TERMINAL_BYPASS_FORBIDDEN",
          `${name}:saveProgress_committed_forbidden`,
        );

        // Attempting to jump directly to rolled_back via generic saveProgressPreservingPlan
        await assert.rejects(
          tx.securityMigrations.saveProgressPreservingPlan(
            migration.id,
            { ...migration, state: "rolled_back", version: migration.version + 1 },
            migration.version,
          ),
          (err: unknown) => err instanceof Error && err.message === "SECURITY_MIGRATION_TERMINAL_BYPASS_FORBIDDEN",
          `${name}:saveProgress_rolled_back_forbidden`,
        );
      });
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002K commitWithReadinessEvidence rejects unissued, unverified, expired, replayed, or mismatched evidence fail-closed", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      const migration = await prepareVerifyingMigration(current.persistence, { withBindings: true });

      const manifest = await current.persistence.read(tenant, async (tx) => {
        return await collectSecurityMigrationManifest(tx, migration);
      });
      const validDigest = computeSecurityMigrationManifestDigest(manifest);

      const harness = current.testHarness;

      // Case A: Missing/unissued evidence ID
      await current.persistence.transaction(tenant, async (tx) => {
        await assert.rejects(
          tx.securityMigrations.commitWithReadinessEvidence({
            migrationId: migration.id,
            expectedVersion: migration.version,
            actorPrincipalId: managerPrincipal,
            occurredAtUtc: "2026-09-11T04:00:00.000Z",
            evidenceId: "unissued-evidence-id",
          }),
          (err: unknown) => err instanceof Error && err.message === "SECURITY_MIGRATION_EVIDENCE_NOT_FOUND",
          `${name}:missing_evidence`,
        );
      });

      // Case B: Issued but unverified challenge
      const unverifiedChallenge = await harness.issueChallenge(tenant, {
        migrationId: migration.id,
        purpose: "commit",
      });
      await current.persistence.transaction(tenant, async (tx) => {
        await assert.rejects(
          tx.securityMigrations.commitWithReadinessEvidence({
            migrationId: migration.id,
            expectedVersion: migration.version,
            actorPrincipalId: managerPrincipal,
            occurredAtUtc: "2026-09-11T04:00:00.000Z",
            evidenceId: unverifiedChallenge.evidenceId,
          }),
          (err: unknown) => err instanceof Error && err.message === "SECURITY_MIGRATION_EVIDENCE_NOT_VERIFIED",
          `${name}:unverified_evidence`,
        );
      });

      // Case C: Expired challenge
      const expiredChallenge = await harness.issueChallenge(tenant, {
        migrationId: migration.id,
        purpose: "commit",
        ttlMilliseconds: 10,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      await assert.rejects(
        harness.recordVerifiedEvidence(tenant, {
          evidenceId: expiredChallenge.evidenceId,
          nonce: expiredChallenge.nonce,
          tenantId: expiredChallenge.tenantId,
          projectId: expiredChallenge.projectId,
          migrationId: expiredChallenge.migrationId,
          purpose: expiredChallenge.purpose,
          sourceSecurityDomainId: expiredChallenge.sourceSecurityDomainId,
          targetSecurityDomainId: expiredChallenge.targetSecurityDomainId,
          sourceSecurityEpoch: expiredChallenge.sourceSecurityEpoch,
          targetSecurityEpoch: expiredChallenge.targetSecurityEpoch,
          manifestDigest: expiredChallenge.manifestDigest,
          itemCount: expiredChallenge.itemCount,
          issuedAtUtc: expiredChallenge.issuedAtUtc,
          expiresAtUtc: expiredChallenge.expiresAtUtc,
          provider: "huly",
          converged: true,
          channels: { issue: "converged", attachment: "converged", blob: "converged" },
        }),
        (err: unknown) => err instanceof Error && (err.message === "SECURITY_MIGRATION_EVIDENCE_EXPIRED" || err.message.includes("expired")),
        `${name}:record_expired_evidence`,
      );

      // Case D: Tampered nonce in recordVerifiedEvidence
      const tamperChallenge = await harness.issueChallenge(tenant, {
        migrationId: migration.id,
        purpose: "commit",
      });
      await assert.rejects(
        harness.recordVerifiedEvidence(tenant, {
          evidenceId: tamperChallenge.evidenceId,
          nonce: "tampered-nonce",
          tenantId: tamperChallenge.tenantId,
          projectId: tamperChallenge.projectId,
          migrationId: tamperChallenge.migrationId,
          purpose: tamperChallenge.purpose,
          sourceSecurityDomainId: tamperChallenge.sourceSecurityDomainId,
          targetSecurityDomainId: tamperChallenge.targetSecurityDomainId,
          sourceSecurityEpoch: tamperChallenge.sourceSecurityEpoch,
          targetSecurityEpoch: tamperChallenge.targetSecurityEpoch,
          manifestDigest: tamperChallenge.manifestDigest,
          itemCount: tamperChallenge.itemCount,
          issuedAtUtc: tamperChallenge.issuedAtUtc,
          expiresAtUtc: tamperChallenge.expiresAtUtc,
          provider: "huly",
          converged: true,
          channels: { issue: "converged", attachment: "converged", blob: "converged" },
        }),
        (err: unknown) => err instanceof Error && (err.message === "SECURITY_MIGRATION_EVIDENCE_INVALID" || err.message.includes("challenge binding")),
        `${name}:tampered_nonce`,
      );

      // Case E: Wrong purpose (rollback challenge attempted on commit)
      const rollbackChallenge = await harness.issueChallenge(tenant, {
        migrationId: migration.id,
        purpose: "rollback",
      });
      await harness.recordVerifiedEvidence(tenant, {
        evidenceId: rollbackChallenge.evidenceId,
        nonce: rollbackChallenge.nonce,
        tenantId: rollbackChallenge.tenantId,
        projectId: rollbackChallenge.projectId,
        migrationId: rollbackChallenge.migrationId,
        purpose: rollbackChallenge.purpose,
        sourceSecurityDomainId: rollbackChallenge.sourceSecurityDomainId,
        targetSecurityDomainId: rollbackChallenge.targetSecurityDomainId,
        sourceSecurityEpoch: rollbackChallenge.sourceSecurityEpoch,
        targetSecurityEpoch: rollbackChallenge.targetSecurityEpoch,
        manifestDigest: rollbackChallenge.manifestDigest,
        itemCount: rollbackChallenge.itemCount,
        issuedAtUtc: rollbackChallenge.issuedAtUtc,
        expiresAtUtc: rollbackChallenge.expiresAtUtc,
        provider: "huly",
        converged: true,
        channels: { issue: "converged", attachment: "converged", blob: "converged" },
      });
      await current.persistence.transaction(tenant, async (tx) => {
        await assert.rejects(
          tx.securityMigrations.commitWithReadinessEvidence({
            migrationId: migration.id,
            expectedVersion: migration.version,
            actorPrincipalId: managerPrincipal,
            occurredAtUtc: "2026-09-11T04:00:00.000Z",
            evidenceId: rollbackChallenge.evidenceId,
          }),
          (err: unknown) => err instanceof Error && err.message === "SECURITY_MIGRATION_EVIDENCE_INVALID",
          `${name}:wrong_purpose`,
        );
      });

      // Case F: Unconverged channels
      const unconvergedChallenge = await harness.issueChallenge(tenant, {
        migrationId: migration.id,
        purpose: "commit",
      });
      await harness.recordVerifiedEvidence(tenant, {
        evidenceId: unconvergedChallenge.evidenceId,
        nonce: unconvergedChallenge.nonce,
        tenantId: unconvergedChallenge.tenantId,
        projectId: unconvergedChallenge.projectId,
        migrationId: unconvergedChallenge.migrationId,
        purpose: unconvergedChallenge.purpose,
        sourceSecurityDomainId: unconvergedChallenge.sourceSecurityDomainId,
        targetSecurityDomainId: unconvergedChallenge.targetSecurityDomainId,
        sourceSecurityEpoch: unconvergedChallenge.sourceSecurityEpoch,
        targetSecurityEpoch: unconvergedChallenge.targetSecurityEpoch,
        manifestDigest: unconvergedChallenge.manifestDigest,
        itemCount: unconvergedChallenge.itemCount,
        issuedAtUtc: unconvergedChallenge.issuedAtUtc,
        expiresAtUtc: unconvergedChallenge.expiresAtUtc,
        provider: "huly",
        converged: false,
        channels: { issue: "not_converged", attachment: "converged", blob: "converged" },
      });
      await current.persistence.transaction(tenant, async (tx) => {
        await assert.rejects(
          tx.securityMigrations.commitWithReadinessEvidence({
            migrationId: migration.id,
            expectedVersion: migration.version,
            actorPrincipalId: managerPrincipal,
            occurredAtUtc: "2026-09-11T04:00:00.000Z",
            evidenceId: unconvergedChallenge.evidenceId,
          }),
          (err: unknown) => err instanceof Error && err.message === "SECURITY_MIGRATION_CONVERGENCE_NOT_READY",
          `${name}:unconverged_evidence`,
        );
      });

      // Case G: Valid challenge, verified, successfully committed, then replayed
      const validChallenge = await harness.issueChallenge(tenant, {
        migrationId: migration.id,
        purpose: "commit",
      });
      await harness.recordVerifiedEvidence(tenant, {
        evidenceId: validChallenge.evidenceId,
        nonce: validChallenge.nonce,
        tenantId: validChallenge.tenantId,
        projectId: validChallenge.projectId,
        migrationId: validChallenge.migrationId,
        purpose: validChallenge.purpose,
        sourceSecurityDomainId: validChallenge.sourceSecurityDomainId,
        targetSecurityDomainId: validChallenge.targetSecurityDomainId,
        sourceSecurityEpoch: validChallenge.sourceSecurityEpoch,
        targetSecurityEpoch: validChallenge.targetSecurityEpoch,
        manifestDigest: validChallenge.manifestDigest,
        itemCount: validChallenge.itemCount,
        issuedAtUtc: validChallenge.issuedAtUtc,
        expiresAtUtc: validChallenge.expiresAtUtc,
        provider: "huly",
        converged: true,
        channels: { issue: "converged", attachment: "converged", blob: "converged" },
      });

      const commitRes = await current.persistence.transaction(tenant, async (tx) => {
        return await tx.securityMigrations.commitWithReadinessEvidence({
          migrationId: migration.id,
          expectedVersion: migration.version,
          actorPrincipalId: managerPrincipal,
          occurredAtUtc: "2026-09-11T04:00:00.000Z",
          evidenceId: validChallenge.evidenceId,
        });
      });
      assert.equal(commitRes.state, "committed");

      // Attempting to reuse the consumed evidence ID
      await current.persistence.transaction(tenant, async (tx) => {
        await assert.rejects(
          tx.securityMigrations.commitWithReadinessEvidence({
            migrationId: migration.id,
            expectedVersion: migration.version,
            actorPrincipalId: managerPrincipal,
            occurredAtUtc: "2026-09-11T04:01:00.000Z",
            evidenceId: validChallenge.evidenceId,
          }),
          (err: unknown) => err instanceof Error && (
            err.message === "SECURITY_MIGRATION_VERSION_CONFLICT"
            || err.message === "SECURITY_MIGRATION_COMMIT_INVALID"
            || err.message === "SECURITY_MIGRATION_EVIDENCE_NOT_VERIFIED"
            || err.message === "SECURITY_MIGRATION_EVIDENCE_REPLAYED"
          ),
          `${name}:replayed_evidence`,
        );
      });
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002K TOCTOU race condition: item modified between external check and commit fails closed", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      const migration = await prepareVerifyingMigration(current.persistence, { withBindings: true });

      // Step 1: Issue server challenge and record verified evidence matching initial manifest
      const challenge = await issueAndCertifyChallenge(current.persistence, tenant, migration.id, "commit");

      // Step 2: Concurrently, before commit, an object version/state changes in DB
      await current.persistence.transaction(tenant, async (tx) => {
        const task1 = await tx.tasks.get("task-1");
        assert.ok(task1);
        await tx.tasks.savePreservingSecurityOwnership(task1.id, {
          ...task1,
          title: "task-1-concurrently-modified",
          version: task1.version + 1,
        }, task1.version);
      });

      // Step 3: Now commit is attempted with the evidence that matched earlier manifest
      await current.persistence.transaction(tenant, async (tx) => {
        await assert.rejects(
          tx.securityMigrations.commitWithReadinessEvidence({
            migrationId: migration.id,
            expectedVersion: migration.version,
            actorPrincipalId: managerPrincipal,
            occurredAtUtc: "2026-09-11T04:00:00.000Z",
            evidenceId: challenge.evidenceId,
          }),
          (err: unknown) => err instanceof Error && err.message === "SECURITY_MIGRATION_MANIFEST_MISMATCH",
          `${name}:toctou_manifest_mismatch`,
        );
      });

      // Migration must still be in verifying state (fail-closed)
      const stored = await current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(migration.id));
      assert.equal(stored?.state, "verifying", name);
      assert.equal(stored?.version, migration.version, name);
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002K HulyRestCollaborationEpochReadinessAdapter fail-closed on null reference, wrong provider, missing entity", async () => {
  const config: HulyRestConfig = {
    transactionEndpoint: "http://huly.test/api/v1/tx/workspace-1",
    fileEndpoint: "http://huly.test/api/v1/files/workspace-1",
    workspaceId: "workspace-1",
    projectId: "huly-project-1",
    actorToken: "actor-token",
    requestTimeoutMilliseconds: 1000,
  };
  const adapter = new HulyRestCollaborationEpochReadinessAdapter(config);

  const baseScope: EpochReadinessScope = {
    tenantId: tenant,
    projectId: "huly-project-1",
    migrationId: "mig-1",
    evidenceId: "evidence-base-1",
    purpose: "commit",
    manifestDigest: "digest-1",
    sourceSecurityDomainId: "d-src",
    targetSecurityDomainId: "d-tgt",
    sourceSecurityEpoch: 1,
    targetSecurityEpoch: 2,
    nonce: "nonce-1",
    expiresAtUtc: "2026-09-11T05:00:00.000Z",
    itemCount: 0,
    tasks: [],
    assets: [],
  };

  // Case 1: Task with null external reference
  const nullTaskRes = await adapter.checkEpochReadiness({
    ...baseScope,
    tasks: [{ taskId: "t-1", externalReference: null }],
  });
  assert.equal(nullTaskRes.converged, false);
  assert.equal(nullTaskRes.channels.issue, "not_converged");
  assert.match(nullTaskRes.reason ?? "", /Null external reference/);

  // Case 2: Task with wrong provider
  const wrongProviderRes = await adapter.checkEpochReadiness({
    ...baseScope,
    tasks: [{ taskId: "t-1", externalReference: externalReference("github", "task", "123") }],
  });
  assert.equal(wrongProviderRes.converged, false);
  assert.equal(wrongProviderRes.channels.issue, "not_converged");
  assert.match(wrongProviderRes.reason ?? "", /Invalid external reference/);

  // Case 3: Asset with null attachment reference
  const nullAttRes = await adapter.checkEpochReadiness({
    ...baseScope,
    assets: [{ assetId: "a-1", externalAttachmentReference: null, externalBlobReference: externalReference("huly", "blob", "b-1") }],
  });
  assert.equal(nullAttRes.converged, false);
  assert.equal(nullAttRes.channels.attachment, "not_converged");

  // Case 4: Asset with null blob reference
  const nullBlobRes = await adapter.checkEpochReadiness({
    ...baseScope,
    assets: [{ assetId: "a-1", externalAttachmentReference: externalReference("huly", "attachment", "att-1"), externalBlobReference: null }],
  });
  assert.equal(nullBlobRes.converged, false);
  assert.equal(nullBlobRes.channels.blob, "not_converged");
});

test("TC-SEC-002K commit fails closed on unconverged external replicas or ambiguous errors", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      const migration = await prepareVerifyingMigration(current.persistence, { withBindings: true });
      const readinessPort = new TestEpochReadinessAdapter();

      // Case 1: External replica not converged
      readinessPort.converged = false;
      readinessPort.channels.issue = "not_converged";
      const handler = makeCommitHandler(current.persistence, readinessPort);
      await assert.rejects(
        handler.execute({
          tenantId: tenant,
          migrationId: migration.id,
          expectedMigrationVersion: migration.version,
          actorPrincipalId: managerPrincipal,
          occurredAtUtc: "2026-09-11T04:00:00.000Z",
        }),
        (err: unknown) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_CONVERGENCE_NOT_READY",
        `${name}:unconverged`,
      );

      // Case 2: Ambiguous network error from external port
      readinessPort.converged = true;
      readinessPort.channels.issue = "converged";
      readinessPort.simulatedError = new Error("NETWORK_TIMEOUT");
      await assert.rejects(
        handler.execute({
          tenantId: tenant,
          migrationId: migration.id,
          expectedMigrationVersion: migration.version,
          actorPrincipalId: managerPrincipal,
          occurredAtUtc: "2026-09-11T04:00:00.000Z",
        }),
        (err: unknown) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_CONVERGENCE_NOT_READY",
        `${name}:network_error`,
      );
      readinessPort.simulatedError = null;

      // State remains verifying and no automatic rollback occurred
      const stored = await current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(migration.id));
      assert.equal(stored?.state, "verifying", name);
      assert.equal(stored?.version, migration.version, name);

      const unaffectedNode = await current.persistence.read(tenant, async (tx) => await tx.nodes.get("child"));
      assert.equal(unaffectedNode?.securityDomainId, targetDomainId, name);
      assert.equal(unaffectedNode?.securityEpoch, 2, name);

      const audits = await current.persistence.read(tenant, async (tx) =>
        await tx.securityMigrationAudits.listByMigration(migration.id));
      assert.equal(audits.length, 0, `${name}:no_auto_rollback_audit`);
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002K commit fails closed when outbound fences or unresolved operations are active in scope (deterministic clock)", async () => {
  const fixedNow = new Date("2026-09-11T04:00:00.000Z");
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name, { now: () => fixedNow });
    try {
      const migration = await prepareVerifyingMigration(current.persistence, { withBindings: true });
      const readinessPort = new TestEpochReadinessAdapter();
      const handler = makeCommitHandler(current.persistence, readinessPort);

      // Inject active outbound fence in scope
      await current.persistence.transaction(tenant, async (tx) => {
        await tx.outboundProjectionFences.acquire({
          tenantId: tenant,
          id: "fence:task:task-1",
          projectId,
          ownerNodeId: "child",
          token: "fence-tok-1",
          expiresAtUtc: "2026-09-11T05:00:00.000Z",
          createdAtUtc: "2026-09-11T03:30:00.000Z",
        });
      });

      await assert.rejects(
        handler.execute({
          tenantId: tenant,
          migrationId: migration.id,
          expectedMigrationVersion: migration.version,
          actorPrincipalId: managerPrincipal,
          occurredAtUtc: "2026-09-11T04:00:00.000Z",
        }),
        (err: unknown) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE",
        `${name}:active_fence`,
      );

      // Release fence
      await current.persistence.transaction(tenant, async (tx) => {
        await tx.outboundProjectionFences.release("fence:task:task-1", "fence-tok-1");
      });

      // Inject unresolved operation in scope
      await current.persistence.transaction(tenant, async (tx) => {
        await tx.integrationOperations.insert({
          tenantId: tenant,
          id: "op:task:task-1",
          operationType: "collaboration.task.project",
          subjectType: "task",
          subjectId: "task-1",
          fingerprint: "fp",
          state: "running",
          currentStep: "create_task",
          attempts: 1,
          externalRequestId: "req-1",
          externalReference: null,
          expectedSyncWatermark: null,
          nextAttemptAtUtc: null,
          deadlineAtUtc: "2026-09-12T00:00:00.000Z",
          lastError: null,
          leaseToken: "tok",
          version: 1,
          createdAtUtc: "2026-09-11T03:30:00.000Z",
          updatedAtUtc: "2026-09-11T03:30:00.000Z",
        });
      });

      await assert.rejects(
        handler.execute({
          tenantId: tenant,
          migrationId: migration.id,
          expectedMigrationVersion: migration.version,
          actorPrincipalId: managerPrincipal,
          occurredAtUtc: "2026-09-11T04:00:00.000Z",
        }),
        (err: unknown) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE",
        `${name}:unresolved_op`,
      );

      const stored = await current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(migration.id));
      assert.equal(stored?.state, "verifying", name);
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002K rollback with external check failure transitions migration to recovery_required without corrupting domain state", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      const migration = await prepareVerifyingMigration(current.persistence, { withBindings: true });
      const readinessPort = new TestEpochReadinessAdapter();
      // External check reports not converged at source epoch
      readinessPort.converged = false;
      readinessPort.channels.issue = "not_converged";

      const rollbackHandler = makeRollbackHandler(current.persistence, readinessPort);

      await assert.rejects(
        rollbackHandler.execute({
          tenantId: tenant,
          migrationId: migration.id,
          expectedMigrationVersion: migration.version,
          actorPrincipalId: managerPrincipal,
          reason: "Rollback requested but external channel unconverged",
          occurredAtUtc: "2026-09-11T05:00:00.000Z",
        }),
        (err: unknown) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_CONVERGENCE_NOT_READY",
        `${name}:rollback_fail_closed`,
      );

      // Migration must have transitioned to recovery_required with an explicit audit entry
      const stored = await current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(migration.id));
      assert.equal(stored?.state, "recovery_required", name);
      assert.equal(stored?.version, migration.version + 1, name);

      const audits = await current.persistence.read(tenant, async (tx) =>
        await tx.securityMigrationAudits.listByMigration(migration.id));
      assert.equal(audits.length, 1, name);
      assert.equal(audits[0]?.action, "recovery_required", name);
      assert.match(audits[0]?.reason ?? "", /Rollback external epoch readiness check failed/, name);

      // Objects were NOT reverted to source: domain state not corrupted
      const childNode = await current.persistence.read(tenant, async (tx) => await tx.nodes.get("child"));
      const task1 = await current.persistence.read(tenant, async (tx) => await tx.tasks.get("task-1"));
      const asset1 = await current.persistence.read(tenant, async (tx) => await tx.assets.get("asset-1"));
      assert.equal(childNode?.securityDomainId, targetDomainId, name);
      assert.equal(childNode?.securityEpoch, 2, name);
      assert.equal(task1?.securityDomainId, targetDomainId, name);
      assert.equal(task1?.securityEpoch, 2, name);
      assert.equal(asset1?.securityDomainId, targetDomainId, name);
      assert.equal(asset1?.securityEpoch, 2, name);
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002K controlled rollback restores objects to source domain and epoch in reverse inventory order with complete audit", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      const migration = await prepareVerifyingMigration(current.persistence, { withBindings: true });
      const rollbackHandler = makeRollbackHandler(current.persistence, new TestEpochReadinessAdapter());

      // Verify before rollback: objects are at target domain and epoch 2
      const beforeNodes = await current.persistence.read(tenant, async (tx) => await tx.nodes.get("child"));
      const beforeTasks = await current.persistence.read(tenant, async (tx) => await tx.tasks.get("task-1"));
      const beforeAssets = await current.persistence.read(tenant, async (tx) => await tx.assets.get("asset-1"));
      assert.equal(beforeNodes?.securityDomainId, targetDomainId);
      assert.equal(beforeNodes?.securityEpoch, 2);
      assert.equal(beforeTasks?.securityDomainId, targetDomainId);
      assert.equal(beforeTasks?.securityEpoch, 2);
      assert.equal(beforeAssets?.securityDomainId, targetDomainId);
      assert.equal(beforeAssets?.securityEpoch, 2);

      const result = await rollbackHandler.execute({
        tenantId: tenant,
        migrationId: migration.id,
        expectedMigrationVersion: migration.version,
        actorPrincipalId: managerPrincipal,
        reason: "External convergence failure requires rollback",
        occurredAtUtc: "2026-09-11T05:00:00.000Z",
        idempotencyKey: "rollback-1",
      });

      assert.deepEqual(result, {
        migrationId: migration.id,
        state: "rolled_back",
        migrationVersion: migration.version + 1,
        rolledBackItems: 4,
        occurredAtUtc: "2026-09-11T05:00:00.000Z",
      }, name);

      // After rollback: objects are back to sourceDomainId and epoch 1!
      const afterNodes = await current.persistence.read(tenant, async (tx) => await tx.nodes.get("child"));
      const afterTasks = await current.persistence.read(tenant, async (tx) => await tx.tasks.get("task-1"));
      const afterAssets = await current.persistence.read(tenant, async (tx) => await tx.assets.get("asset-1"));
      assert.equal(afterNodes?.securityDomainId, sourceDomainId, name);
      assert.equal(afterNodes?.securityEpoch, 1, name);
      assert.equal(afterTasks?.securityDomainId, sourceDomainId, name);
      assert.equal(afterTasks?.securityEpoch, 1, name);
      assert.equal(afterAssets?.securityDomainId, sourceDomainId, name);
      assert.equal(afterAssets?.securityEpoch, 1, name);

      // Migration is rolled_back
      const stored = await current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(migration.id));
      assert.equal(stored?.state, "rolled_back", name);
      assert.equal(stored?.version, migration.version + 1, name);

      // Audit entry recorded
      const audits = await current.persistence.read(tenant, async (tx) =>
        await tx.securityMigrationAudits.listByMigration(migration.id));
      assert.equal(audits.length, 1, name);
      assert.equal(audits[0]?.action, "rolled_back", name);
      assert.equal(audits[0]?.actorPrincipalId, managerPrincipal, name);
      assert.equal(audits[0]?.reason, "External convergence failure requires rollback", name);
      assert.equal(audits[0]?.migratedItems, 4, name);

      // Cannot rollback a rolled_back or committed migration
      await assert.rejects(
        rollbackHandler.execute({
          tenantId: tenant,
          migrationId: migration.id,
          expectedMigrationVersion: migration.version + 1,
          actorPrincipalId: managerPrincipal,
          reason: "retry",
          occurredAtUtc: "2026-09-11T05:01:00.000Z",
        }),
        (err: unknown) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_ROLLBACK_INVALID",
        `${name}:already_rolled_back`,
      );
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002K two real SQLite connections in WAL mode enforce atomicity, anti-replay, and TOCTOU manifest consistency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-sqlite-wal-concurrency-"));
  const dbPath = join(directory, "concurrency.sqlite");

  const conn1 = createTestSqliteBundle({ path: dbPath, busyTimeoutMilliseconds: 10_000 }).persistence;
  const conn2 = createTestSqliteBundle({ path: dbPath, busyTimeoutMilliseconds: 10_000 }).persistence;

  try {
    const migration = await prepareVerifyingMigration(conn1, { withBindings: true });

    // Both connections see verifying migration
    const readOnConn2 = await conn2.read(tenant, async (tx) => await tx.securityMigrations.get(migration.id));
    assert.equal(readOnConn2?.state, "verifying");

    const manifest = await conn1.read(tenant, async (tx) => await collectSecurityMigrationManifest(tx, migration));
    const digest = computeSecurityMigrationManifestDigest(manifest);

    const challenge1 = await issueAndCertifyChallenge(conn1, tenant, migration.id, "commit");

    // Conn 1 commits with evidence
    const commit1 = await conn1.transaction(tenant, async (tx) => {
      return await tx.securityMigrations.commitWithReadinessEvidence({
        migrationId: migration.id,
        expectedVersion: migration.version,
        actorPrincipalId: managerPrincipal,
        occurredAtUtc: "2026-09-11T04:00:00.000Z",
        evidenceId: challenge1.evidenceId,
      });
    });
    assert.equal(commit1.state, "committed");

    // Conn 2 concurrently attempts to reuse/replay the same evidence
    await conn2.transaction(tenant, async (tx) => {
      await assert.rejects(
        tx.securityMigrations.commitWithReadinessEvidence({
          migrationId: migration.id,
          expectedVersion: migration.version, // Stale version after Conn 1 committed
          actorPrincipalId: managerPrincipal,
          occurredAtUtc: "2026-09-11T04:00:00.000Z",
          evidenceId: challenge1.evidenceId,
        }),
        (err: unknown) => err instanceof Error && (
          err.message === "SECURITY_MIGRATION_VERSION_CONFLICT"
          || err.message === "SECURITY_MIGRATION_EVIDENCE_REPLAYED"
          || err.message === "SECURITY_MIGRATION_EVIDENCE_NOT_VERIFIED"
          || err.message === "SECURITY_MIGRATION_COMMIT_INVALID"
        ),
        "conn2:replay_rejected",
      );
    });

    // Test TOCTOU across connections:
    // Create another verifying migration on conn1
    const planned2: SecurityDomainMigration = {
      tenantId: tenant,
      id: "mig-toctou-2",
      projectId,
      rootNodeId: "wal-node",
      sourceSecurityDomainId: targetDomainId,
      targetSecurityDomainId: sourceDomainId,
      hierarchyRevision: 1,
      sourceSecurityEpoch: 2,
      targetSecurityEpoch: 3,
      state: "planned",
      cursor: null,
      totalItems: 2,
      migratedItems: 0,
      failure: null,
      nextAttemptAtUtc: null,
      deadlineAtUtc: "2026-09-12T00:00:00.000Z",
      version: 1,
      createdAtUtc: "2026-09-11T00:00:00.000Z",
      updatedAtUtc: "2026-09-11T00:00:00.000Z",
    };
    await conn1.transaction(tenant, async (tx) => {
      await tx.nodes.insert(node("wal-node", null, targetDomainId, 2));
      await tx.tasks.insert(task("wal-task", "wal-node", targetDomainId, 2));
      await tx.securityMigrations.insert(planned2);
      const active2 = transitionSecurityMigration(planned2, "active", "2026-09-11T01:00:00.000Z");
      await tx.securityMigrations.saveProgressPreservingPlan(planned2.id, active2, 1);
      await tx.nodes.migrateSecurityOwnership(planned2.id, "wal-node", 1);
      await tx.tasks.migrateSecurityOwnership(planned2.id, "wal-task", 1);
      const checkpoint2 = checkpointSecurityMigration(active2, {
        cursor: JSON.stringify(["wal-node", "task", "wal-task"]),
        migratedItems: 2,
        occurredAtUtc: "2026-09-11T01:30:00.000Z",
      });
      await tx.securityMigrations.saveProgressPreservingPlan(planned2.id, checkpoint2, 2);
      const verifying2 = transitionSecurityMigration(checkpoint2, "verifying", "2026-09-11T02:00:00.000Z");
      const manifestSnap2 = await collectSecurityMigrationManifest(tx, checkpoint2);
      await tx.securityMigrations.saveManifestSnapshot({
        tenantId: tenant,
        migrationId: planned2.id,
        manifestDigest: computeSecurityMigrationManifestDigest(manifestSnap2),
        itemCount: manifestSnap2.items.length,
        items: manifestSnap2.items,
        createdAtUtc: "2026-09-11T02:00:00.000Z",
      });
      await tx.securityMigrations.saveProgressPreservingPlan(planned2.id, verifying2, 3);
    });

    // conn1 prepares evidence for mig-toctou-2
    const manifest2 = await conn1.read(tenant, async (tx) => {
      const mig = await tx.securityMigrations.get("mig-toctou-2");
      return await collectSecurityMigrationManifest(tx, mig!);
    });
    const digest2 = computeSecurityMigrationManifestDigest(manifest2);
    const challenge2 = await issueAndCertifyChallenge(conn1, tenant, "mig-toctou-2", "commit");

    // Conn 2 mutates the task version in the background
    await conn2.transaction(tenant, async (tx) => {
      const taskTarget = await tx.tasks.get("wal-task");
      assert.ok(taskTarget);
      await tx.tasks.savePreservingSecurityOwnership(taskTarget.id, {
        ...taskTarget,
        title: "mutated-by-conn2",
        version: taskTarget.version + 1,
      }, taskTarget.version);
    });

    // Conn 1 attempts commit with challenge2 -> TOCTOU manifest mismatch!
    await conn1.transaction(tenant, async (tx) => {
      await assert.rejects(
        tx.securityMigrations.commitWithReadinessEvidence({
          migrationId: "mig-toctou-2",
          expectedVersion: 4,
          actorPrincipalId: managerPrincipal,
          occurredAtUtc: "2026-09-11T04:00:00.000Z",
          evidenceId: challenge2.evidenceId,
        }),
        (err: unknown) => err instanceof Error && err.message === "SECURITY_MIGRATION_MANIFEST_MISMATCH",
        "conn1:toctou_manifest_mismatch_detected",
      );
    });
  } finally {
    await conn1.close();
    await conn2.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TC-SEC-002K unauthorized actor or non-manager is rejected from commit and rollback", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      const migration = await prepareVerifyingMigration(current.persistence);
      const commitHandler = makeCommitHandler(current.persistence, new TestEpochReadinessAdapter());
      const rollbackHandler = makeRollbackHandler(current.persistence);

      // Non-manager actor
      await assert.rejects(
        commitHandler.execute({
          tenantId: tenant,
          migrationId: migration.id,
          expectedMigrationVersion: migration.version,
          actorPrincipalId: regularPrincipal,
          occurredAtUtc: "2026-09-11T04:00:00.000Z",
        }),
        (err: unknown) => err instanceof ApplicationError && err.code === "NODE_NOT_FOUND",
        `${name}:commit_unauthorized`,
      );

      await assert.rejects(
        rollbackHandler.execute({
          tenantId: tenant,
          migrationId: migration.id,
          expectedMigrationVersion: migration.version,
          actorPrincipalId: regularPrincipal,
          reason: "test",
          occurredAtUtc: "2026-09-11T04:00:00.000Z",
        }),
        (err: unknown) => err instanceof ApplicationError && err.code === "NODE_NOT_FOUND",
        `${name}:rollback_unauthorized`,
      );
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002K SQLite migration_json corruption matrix", async () => {
  const current = await fixture("sqlite");
  try {
    const migration = await prepareVerifyingMigration(current.persistence);
    const db = new DatabaseSync(current.path!);
    const originalJson = JSON.parse(JSON.stringify(migration));

    // Subcase 1: Malformed JSON
    db.prepare("UPDATE security_domain_migrations SET migration_json = '{invalid_json' WHERE migration_id = ?").run(migration.id);
    await assert.rejects(
      current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(migration.id)),
      (err: unknown) => err instanceof Error && err.message.includes("SECURITY_MIGRATION_RECORD_CORRUPT: malformed migration_json"),
      "malformed_json_rejected",
    );

    // Subcase 2: Non-object JSON
    db.prepare("UPDATE security_domain_migrations SET migration_json = '\"just_a_string\"' WHERE migration_id = ?").run(migration.id);
    await assert.rejects(
      current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(migration.id)),
      (err: unknown) => err instanceof Error && err.message.includes("SECURITY_MIGRATION_RECORD_CORRUPT: migration_json is not an object"),
      "non_object_json_rejected",
    );

    // Subcase 3: Missing required field
    const missingField = { ...originalJson };
    delete missingField.rootNodeId;
    db.prepare("UPDATE security_domain_migrations SET migration_json = ? WHERE migration_id = ?").run(JSON.stringify(missingField), migration.id);
    await assert.rejects(
      current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(migration.id)),
      (err: unknown) => err instanceof Error && err.message.includes("SECURITY_MIGRATION_RECORD_CORRUPT: missing required fields"),
      "missing_required_field_rejected",
    );

    // Subcase 4: Illegal migration state in JSON
    const illegalState = { ...originalJson, state: "corrupted_state" };
    db.prepare("UPDATE security_domain_migrations SET migration_json = ? WHERE migration_id = ?").run(JSON.stringify(illegalState), migration.id);
    await assert.rejects(
      current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(migration.id)),
      (err: unknown) => err instanceof Error && err.message.includes("SECURITY_MIGRATION_RECORD_CORRUPT: illegal migration state"),
      "illegal_state_rejected",
    );

    // Subcase 5: Non-integer counter in JSON
    const floatCounter = { ...originalJson, totalItems: 2.5 };
    db.prepare("UPDATE security_domain_migrations SET migration_json = ? WHERE migration_id = ?").run(JSON.stringify(floatCounter), migration.id);
    await assert.rejects(
      current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(migration.id)),
      (err: unknown) => err instanceof Error && err.message.includes("SECURITY_MIGRATION_RECORD_CORRUPT: non-integer or negative counters"),
      "non_integer_counter_rejected",
    );

    // Subcase 6: Negative counter in JSON
    const negativeCounter = { ...originalJson, migratedItems: -1 };
    db.prepare("UPDATE security_domain_migrations SET migration_json = ? WHERE migration_id = ?").run(JSON.stringify(negativeCounter), migration.id);
    await assert.rejects(
      current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(migration.id)),
      (err: unknown) => err instanceof Error && err.message.includes("SECURITY_MIGRATION_RECORD_CORRUPT: non-integer or negative counters"),
      "negative_counter_rejected",
    );

    // Subcase 7: migrated_items > total_items
    const excessMigrated = { ...originalJson, migratedItems: 10, totalItems: 4 };
    db.prepare("UPDATE security_domain_migrations SET migration_json = ? WHERE migration_id = ?").run(JSON.stringify(excessMigrated), migration.id);
    await assert.rejects(
      current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(migration.id)),
      (err: unknown) => err instanceof Error && err.message.includes("SECURITY_MIGRATION_RECORD_CORRUPT: migrated items exceeds total items"),
      "migrated_exceeds_total_rejected",
    );

    // Subcase 8: Backwards timestamp (updatedAtUtc < createdAtUtc)
    const backwardsTs = {
      ...originalJson,
      createdAtUtc: "2026-09-11T12:00:00.000Z",
      updatedAtUtc: "2026-09-11T10:00:00.000Z",
    };
    db.prepare("UPDATE security_domain_migrations SET migration_json = ? WHERE migration_id = ?").run(JSON.stringify(backwardsTs), migration.id);
    await assert.rejects(
      current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(migration.id)),
      (err: unknown) => err instanceof Error && err.message.includes("SECURITY_MIGRATION_RECORD_CORRUPT: updatedAtUtc precedes createdAtUtc"),
      "backwards_timestamp_rejected",
    );

    // Subcase 9: Relational column mismatch state -> SECURITY_MIGRATION_PERSISTENCE_INCONSISTENT
    db.prepare("UPDATE security_domain_migrations SET migration_json = ? WHERE migration_id = ?").run(JSON.stringify(originalJson), migration.id);
    db.prepare("UPDATE security_domain_migrations SET state = 'active' WHERE migration_id = ?").run(migration.id);
    await assert.rejects(
      current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(migration.id)),
      (err: unknown) => err instanceof Error && err.message === "SECURITY_MIGRATION_PERSISTENCE_INCONSISTENT",
      "relational_state_mismatch_rejected",
    );

    // Subcase 10: Relational column mismatch version -> SECURITY_MIGRATION_PERSISTENCE_INCONSISTENT
    db.prepare("UPDATE security_domain_migrations SET state = ?, version = 999 WHERE migration_id = ?").run(originalJson.state, migration.id);
    await assert.rejects(
      current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(migration.id)),
      (err: unknown) => err instanceof Error && err.message === "SECURITY_MIGRATION_PERSISTENCE_INCONSISTENT",
      "relational_version_mismatch_rejected",
    );

    // Subcase 11: Relational column mismatch total_items -> SECURITY_MIGRATION_PERSISTENCE_INCONSISTENT
    db.prepare("UPDATE security_domain_migrations SET version = ?, total_items = 999 WHERE migration_id = ?").run(originalJson.version, migration.id);
    await assert.rejects(
      current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(migration.id)),
      (err: unknown) => err instanceof Error && err.message === "SECURITY_MIGRATION_PERSISTENCE_INCONSISTENT",
      "relational_total_items_mismatch_rejected",
    );
  } finally {
    await current.cleanup();
  }
});

test("TC-SEC-002K HulyRestCollaborationEpochReadinessAdapter real HTTP probes for all channel checks", async () => {
  let issueDocs: Array<Record<string, unknown>> = [];
  let attachmentDocs: Array<Record<string, unknown>> = [];
  let blobResponseStatus = 200;
  let blobResponseHeaders: Record<string, string> = {};

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const auth = new Headers(init.headers).get("authorization");
      assert.equal(auth, "Bearer secret-actor-token");

      if (url.pathname.startsWith("/api/v1/find-all/")) {
        const classId = url.searchParams.get("class");
        if (classId === HULY_IDS.issueClass) {
          return new Response(JSON.stringify(issueDocs), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (classId === HULY_IDS.attachmentClass) {
          return new Response(JSON.stringify(attachmentDocs), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.pathname.startsWith("/files/")) {
        if (blobResponseStatus === 302) {
          if (init.redirect === "error") {
            throw new TypeError("fetch failed: redirect mode is error");
          }
          return new Response(null, {
            status: 302,
            headers: blobResponseHeaders,
          });
        }
        return new Response(null, {
          status: blobResponseStatus,
          headers: blobResponseHeaders,
        });
      }

      return new Response("Not Found", { status: 404 });
    };

    const config: HulyRestConfig = {
      transactionEndpoint: "https://huly.test",
      fileEndpoint: "https://huly.test/files",
      workspaceId: "test-ws",
      projectId: "huly-proj-1",
      actorToken: "secret-actor-token",
      requestTimeoutMilliseconds: 2000,
    };
    const adapter = new HulyRestCollaborationEpochReadinessAdapter(config);

    const baseScope: EpochReadinessScope = {
      tenantId: tenant,
      projectId: "huly-proj-1",
      migrationId: "mig-probe-1",
      evidenceId: "evidence-probe-1",
      purpose: "commit",
      manifestDigest: "digest-probe-1",
      sourceSecurityDomainId: "domain-src",
      targetSecurityDomainId: "domain-tgt",
      sourceSecurityEpoch: 1,
      targetSecurityEpoch: 2,
      nonce: "nonce-probe-1",
      expiresAtUtc: "2026-09-11T05:00:00.000Z",
      itemCount: 2,
      tasks: [{ taskId: "t-1", externalReference: externalReference("huly", "task", "issue-1") }],
      assets: [{
        assetId: "a-1",
        externalAttachmentReference: externalReference("huly", "attachment", "att-1"),
        externalBlobReference: externalReference("huly", "blob", "blob-1"),
        externalIssueId: "issue-1",
      }],
    };

    // Probe 1: Wrong issue class
    issueDocs = [{ _id: "issue-1", _class: "tracker:class:Other", space: "huly-proj-1", securityEpoch: 2 }];
    attachmentDocs = [{ _id: "att-1", _class: HULY_IDS.attachmentClass, space: "huly-proj-1", attachedTo: "issue-1", file: "blob-1" }];
    blobResponseStatus = 200;
    const res1 = await adapter.checkEpochReadiness(baseScope);
    assert.equal(res1.converged, false);
    assert.equal(res1.channels.issue, "not_converged");
    assert.match(res1.reason ?? "", /Huly issue class mismatch/);

    // Probe 2: Wrong issue space
    issueDocs = [{ _id: "issue-1", _class: HULY_IDS.issueClass, space: "wrong-space", securityEpoch: 2 }];
    const res2 = await adapter.checkEpochReadiness(baseScope);
    assert.equal(res2.converged, false);
    assert.equal(res2.channels.issue, "not_converged");
    assert.match(res2.reason ?? "", /Huly issue space mismatch/);

    // Probe 3: Non-string issue space
    issueDocs = [{ _id: "issue-1", _class: HULY_IDS.issueClass, space: 12345 as unknown as string, securityEpoch: 2 }];
    const res3 = await adapter.checkEpochReadiness(baseScope);
    assert.equal(res3.converged, false);
    assert.equal(res3.channels.issue, "not_converged");
    assert.match(res3.reason ?? "", /Huly issue space mismatch/);

    // Probe 4: Native Huly issue missing securityEpoch (Architectural Blocker)
    issueDocs = [{ _id: "issue-1", _class: HULY_IDS.issueClass, space: "huly-proj-1" }];
    const res4 = await adapter.checkEpochReadiness(baseScope);
    assert.equal(res4.converged, false);
    assert.equal(res4.channels.issue, "not_converged");
    assert.match(res4.reason ?? "", /^HULY_EPOCH_CONVERGENCE_UNSUPPORTED: Current Huly REST API does not observe migration securityEpoch or domain ACL/);

    // Probe 5: Wrong issue epoch
    issueDocs = [{ _id: "issue-1", _class: HULY_IDS.issueClass, space: "huly-proj-1", securityEpoch: 99 }];
    const res5 = await adapter.checkEpochReadiness(baseScope);
    assert.equal(res5.converged, false);
    assert.equal(res5.channels.issue, "not_converged");
    assert.match(res5.reason ?? "", /Huly issue epoch mismatch/);

    // Probe 6: Wrong attachment class
    issueDocs = [{ _id: "issue-1", _class: HULY_IDS.issueClass, space: "huly-proj-1", securityEpoch: 2 }];
    attachmentDocs = [{ _id: "att-1", _class: "other:Attachment", space: "huly-proj-1", attachedTo: "issue-1", file: "blob-1" }];
    const res6 = await adapter.checkEpochReadiness(baseScope);
    assert.equal(res6.converged, false);
    assert.equal(res6.channels.attachment, "not_converged");
    assert.match(res6.reason ?? "", /Huly attachment class mismatch/);

    // Probe 7: Wrong attachment space
    attachmentDocs = [{ _id: "att-1", _class: HULY_IDS.attachmentClass, space: "wrong-space", attachedTo: "issue-1", file: "blob-1" }];
    const res7 = await adapter.checkEpochReadiness(baseScope);
    assert.equal(res7.converged, false);
    assert.equal(res7.channels.attachment, "not_converged");
    assert.match(res7.reason ?? "", /Huly attachment space mismatch/);

    // Probe 8: Wrong attachment attachedTo
    attachmentDocs = [{ _id: "att-1", _class: HULY_IDS.attachmentClass, space: "huly-proj-1", attachedTo: "wrong-issue", file: "blob-1" }];
    const res8 = await adapter.checkEpochReadiness(baseScope);
    assert.equal(res8.converged, false);
    assert.equal(res8.channels.attachment, "not_converged");
    assert.match(res8.reason ?? "", /Huly attachment attachedTo mismatch/);

    // Probe 9: Wrong attachment file
    attachmentDocs = [{ _id: "att-1", _class: HULY_IDS.attachmentClass, space: "huly-proj-1", attachedTo: "issue-1", file: "wrong-blob" }];
    const res9 = await adapter.checkEpochReadiness(baseScope);
    assert.equal(res9.converged, false);
    assert.equal(res9.channels.attachment, "not_converged");
    assert.match(res9.reason ?? "", /Huly attachment file mismatch/);

    // Probe 10: Blob 302 redirect rejected fail-closed
    attachmentDocs = [{ _id: "att-1", _class: HULY_IDS.attachmentClass, space: "huly-proj-1", attachedTo: "issue-1", file: "blob-1" }];
    blobResponseStatus = 302;
    blobResponseHeaders = { location: "http://storage.example.com/blob-1" };
    const res10 = await adapter.checkEpochReadiness(baseScope);
    assert.equal(res10.converged, false);
    assert.equal(res10.channels.blob, "not_converged");
    assert.match(res10.reason ?? "", /Huly blob not found/);

    // Probe 11: Blob 404
    blobResponseStatus = 404;
    blobResponseHeaders = {};
    const res11 = await adapter.checkEpochReadiness(baseScope);
    assert.equal(res11.converged, false);
    assert.equal(res11.channels.blob, "not_converged");
    assert.match(res11.reason ?? "", /Huly blob not found/);

    // Probe 12: Real Huly cannot observe securityEpoch -> fail-closed with HULY_EPOCH_CONVERGENCE_UNSUPPORTED
    blobResponseStatus = 200;
    blobResponseHeaders = {};
    const res12 = await adapter.checkEpochReadiness(baseScope);
    assert.equal(res12.converged, false);
    assert.equal(res12.channels.issue, "not_converged");
    assert.equal(res12.channels.attachment, "converged");
    assert.equal(res12.channels.blob, "converged");
    assert.match(res12.reason ?? "", /^HULY_EPOCH_CONVERGENCE_UNSUPPORTED: Current Huly REST API does not observe migration securityEpoch or domain ACL; external convergence cannot be verified/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TC-SEC-002K TOCTOU actor revocation, binding drift, and receipt replay re-authorization", async () => {
  // Case 1: Actor membership/principal revoked before commit
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      const mig = await prepareVerifyingMigration(current.persistence, { withBindings: true });
      const readinessPort = new TestEpochReadinessAdapter();
      const commitHandler = makeCommitHandler(current.persistence, readinessPort);

      // Suspend actor principal right before commit execution
      await current.persistence.transaction(tenant, async (tx) => {
        const principal = await tx.principals.get(managerPrincipal);
        assert.ok(principal);
        await tx.principals.update({
          ...principal,
          status: "revoked",
          version: principal.version + 1,
        }, principal.version);
      });

      await assert.rejects(
        commitHandler.execute({
          tenantId: tenant,
          migrationId: mig.id,
          expectedMigrationVersion: mig.version,
          actorPrincipalId: managerPrincipal,
          occurredAtUtc: "2026-09-11T04:00:00.000Z",
        }),
        (err: unknown) => err instanceof ApplicationError && err.code === "NODE_NOT_FOUND",
        `${name}:actor_revoked_rejected`,
      );

      // Verify migration remains in verifying state (fail-closed)
      const stored = await current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(mig.id));
      assert.equal(stored?.state, "verifying", name);
    } finally {
      await current.cleanup();
    }
  }

  // Case 2: Root node deleted before commit (verified on SQLite persistent storage)
  {
    const current = await fixture("sqlite");
    try {
      const mig = await prepareVerifyingMigration(current.persistence, { withBindings: true });
      const readinessPort = new TestEpochReadinessAdapter();
      const commitHandler = makeCommitHandler(current.persistence, readinessPort);

      // Mark root node as deleted directly in database
      const db = new DatabaseSync(current.path!);
      db.prepare("UPDATE project_nodes SET deleted_at_utc = '2026-09-11T03:55:00.000Z' WHERE node_id = 'root'").run();

      await assert.rejects(
        commitHandler.execute({
          tenantId: tenant,
          migrationId: mig.id,
          expectedMigrationVersion: mig.version,
          actorPrincipalId: managerPrincipal,
          occurredAtUtc: "2026-09-11T04:00:00.000Z",
        }),
        (err: unknown) => err instanceof ApplicationError && err.code === "NODE_NOT_FOUND",
        "sqlite:root_deleted_rejected",
      );

      // Migration remains in verifying state
      const stored = await current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(mig.id));
      assert.equal(stored?.state, "verifying");
    } finally {
      await current.cleanup();
    }
  }

  // Case 3: Binding syncState drift
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      const mig = await prepareVerifyingMigration(current.persistence, { withBindings: true });

      // Issue challenge and record verified evidence with valid snapshot digest
      const challenge = await issueAndCertifyChallenge(current.persistence, tenant, mig.id, "commit");

      // Now tamper with binding syncState in background
      await current.persistence.transaction(tenant, async (tx) => {
        const binding = await tx.externalBindings.getByOwner("task", "task-1", "collaboration_projection");
        assert.ok(binding);
        await tx.externalBindings.update({
          ...binding,
          syncState: "failed",
          version: binding.version + 1,
        }, binding.version);
      });

      // Commit attempt must fail with SECURITY_MIGRATION_MANIFEST_MISMATCH
      await current.persistence.transaction(tenant, async (tx) => {
        await assert.rejects(
          tx.securityMigrations.commitWithReadinessEvidence({
            migrationId: mig.id,
            expectedVersion: mig.version,
            actorPrincipalId: managerPrincipal,
            occurredAtUtc: "2026-09-11T04:00:00.000Z",
            evidenceId: challenge.evidenceId,
          }),
          (err: unknown) => err instanceof Error && err.message === "SECURITY_MIGRATION_MANIFEST_MISMATCH",
          `${name}:binding_drift_rejected`,
        );
      });
    } finally {
      await current.cleanup();
    }
  }

  // Case 4: Receipt replay re-authorization check rejecting demoted actor
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      const mig = await prepareVerifyingMigration(current.persistence, { withBindings: true });
      const readinessPort = new TestEpochReadinessAdapter();
      const commitHandler = makeCommitHandler(current.persistence, readinessPort);

      // First commit with idempotency key succeeds
      const firstResult = await commitHandler.execute({
        tenantId: tenant,
        migrationId: mig.id,
        expectedMigrationVersion: mig.version,
        actorPrincipalId: managerPrincipal,
        occurredAtUtc: "2026-09-11T04:00:00.000Z",
        idempotencyKey: "idem-receipt-reauth-test",
      });
      assert.equal(firstResult.state, "committed");

      // Suspend manager actor's principal
      await current.persistence.transaction(tenant, async (tx) => {
        const principal = await tx.principals.get(managerPrincipal);
        assert.ok(principal);
        await tx.principals.update({
          ...principal,
          status: "revoked",
          version: principal.version + 1,
        }, principal.version);
      });

      // Replay with the same idempotency key must NOT blindly return cached receipt;
      // it must re-authorize the actor and fail with NODE_NOT_FOUND!
      await assert.rejects(
        commitHandler.execute({
          tenantId: tenant,
          migrationId: mig.id,
          expectedMigrationVersion: mig.version,
          actorPrincipalId: managerPrincipal,
          occurredAtUtc: "2026-09-11T04:00:00.000Z",
          idempotencyKey: "idem-receipt-reauth-test",
        }),
        (err: unknown) => err instanceof ApplicationError && err.code === "NODE_NOT_FOUND",
        `${name}:receipt_replay_reauth_rejected`,
      );
    } finally {
      await current.cleanup();
    }
  }

  // Case 5: Grant expiry replay rejected under trusted persistence clock
  for (const name of ["memory", "sqlite"] as const) {
    let testClockTime = new Date("2026-09-11T03:00:00.000Z");
    const current = await fixture(name, { now: () => testClockTime });
    try {
      const mig = await prepareVerifyingMigration(current.persistence, { withBindings: true });
      const expiringManager = principalId("principal-expiring-mgr");

      // Set up expiring manager with security grants expiring at 03:30:00.000Z
      await current.persistence.transaction(tenant, async (tx) => {
        await tx.principals.insert({
          tenantId: tenant,
          id: expiringManager,
          kind: "user",
          status: "active",
          version: 1,
          createdAtUtc: "2026-09-11T00:00:00.000Z",
          updatedAtUtc: "2026-09-11T00:00:00.000Z",
        });
        await tx.memberships.insert({
          tenantId: tenant,
          projectId,
          principalId: expiringManager,
          role: "project_manager",
          status: "active",
          securityDomainIds: [],
          version: 1,
          createdAtUtc: "2026-09-11T00:00:00.000Z",
          updatedAtUtc: "2026-09-11T00:00:00.000Z",
        });
        await tx.securityGrants.insert({
          tenantId: tenant,
          id: "grant-source-expiring",
          securityDomainId: sourceDomainId,
          principalId: expiringManager,
          capability: "manage_access",
          status: "active",
          expiresAtUtc: "2026-09-11T03:30:00.000Z",
          grantedByPrincipalId: managerPrincipal,
          reason: "temp grant",
          version: 1,
          createdAtUtc: "2026-09-11T00:00:00.000Z",
          updatedAtUtc: "2026-09-11T00:00:00.000Z",
        });
        await tx.securityGrants.insert({
          tenantId: tenant,
          id: "grant-target-expiring",
          securityDomainId: targetDomainId,
          principalId: expiringManager,
          capability: "manage_access",
          status: "active",
          expiresAtUtc: "2026-09-11T03:30:00.000Z",
          grantedByPrincipalId: managerPrincipal,
          reason: "temp grant",
          version: 1,
          createdAtUtc: "2026-09-11T00:00:00.000Z",
          updatedAtUtc: "2026-09-11T00:00:00.000Z",
        });
      });

      const readinessPort = new TestEpochReadinessAdapter();
      const commitHandler = makeCommitHandler(current.persistence, readinessPort);

      // First commit with idempotency key succeeds while grant is active at 03:00:00.000Z
      const firstResult = await commitHandler.execute({
        tenantId: tenant,
        migrationId: mig.id,
        expectedMigrationVersion: mig.version,
        actorPrincipalId: expiringManager,
        occurredAtUtc: "2026-09-11T03:00:00.000Z",
        idempotencyKey: "idem-grant-expiry-test",
      });
      assert.equal(firstResult.state, "committed");

      // Advance persistence clock past grant expiry (to 04:00:00.000Z)
      testClockTime = new Date("2026-09-11T04:00:00.000Z");

      // Replay with original occurredAtUtc (which was within validity window) MUST still be rejected
      // because actor re-authorization evaluates against persistence.nowUtc(), not occurredAtUtc!
      await assert.rejects(
        commitHandler.execute({
          tenantId: tenant,
          migrationId: mig.id,
          expectedMigrationVersion: mig.version,
          actorPrincipalId: expiringManager,
          occurredAtUtc: "2026-09-11T03:00:00.000Z",
          idempotencyKey: "idem-grant-expiry-test",
        }),
        (err: unknown) => err instanceof ApplicationError && err.code === "NODE_NOT_FOUND",
        `${name}:grant_expired_replay_rejected`,
      );
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002K Rollback safety matrix: mandatory verifier, reverse-order multi-level restore, and commit/rollback race", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      // Subcase 1: Mandatory verifier when migratedItems > 0
      const mig1 = await prepareVerifyingMigration(current.persistence, { withBindings: true });
      assert.ok(mig1.migratedItems > 0, "has migrated items");

      // Rollback handler instantiated WITHOUT readinessPort must throw HULY_ADAPTER_NOT_CONFIGURED
      const handlerWithoutVerifier = new RollbackSecurityMigrationHandler(current.persistence);
      await assert.rejects(
        handlerWithoutVerifier.execute({
          tenantId: tenant,
          migrationId: mig1.id,
          expectedMigrationVersion: mig1.version,
          actorPrincipalId: managerPrincipal,
          reason: "testing unconfigured verifier",
          occurredAtUtc: "2026-09-11T04:00:00.000Z",
        }),
        (err: unknown) => err instanceof ApplicationError && err.code === "HULY_ADAPTER_NOT_CONFIGURED",
        `${name}:mandatory_verifier_handler_check`,
      );

      // Persistence direct rollback without evidenceId must throw SECURITY_MIGRATION_EVIDENCE_REQUIRED
      await current.persistence.transaction(tenant, async (tx) => {
        await assert.rejects(
          tx.securityMigrations.rollbackWithAudit({
            migrationId: mig1.id,
            expectedVersion: mig1.version,
            actorPrincipalId: managerPrincipal,
            reason: "direct attempt without evidence",
            occurredAtUtc: "2026-09-11T04:00:00.000Z",
          }),
          (err: unknown) => err instanceof Error && err.message === "SECURITY_MIGRATION_EVIDENCE_REQUIRED",
          `${name}:mandatory_verifier_persistence_check`,
        );
      });
    } finally {
      await current.cleanup();
    }
  }

  // Subcase 2: Reverse-order multi-level hierarchy restoration (grandchild -> child -> root)
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await setupBaseline(current.persistence);
      await current.persistence.transaction(tenant, async (tx) => {
        await tx.nodes.insert(node("child-1", "root", sourceDomainId, 1));
        await tx.nodes.insert(node("grandchild-1", "child-1", sourceDomainId, 1));
        await tx.tasks.insert(task("task-gc", "grandchild-1", sourceDomainId, 1));
        await tx.assets.insert(asset("asset-gc", "grandchild-1", sourceDomainId, 1));
      });

      const invReader = new SecurityMigrationInventoryReader(current.persistence);
      const inv = await invReader.build({
        tenantId: tenant,
        projectId,
        rootNodeId: "root",
        sourceSecurityDomainId: sourceDomainId,
        sourceSecurityEpoch: 1,
      });

      const multiLevelMig: SecurityDomainMigration = {
        tenantId: tenant,
        id: "mig-multilevel",
        projectId,
        rootNodeId: "root",
        sourceSecurityDomainId: sourceDomainId,
        targetSecurityDomainId: targetDomainId,
        hierarchyRevision: 1,
        sourceSecurityEpoch: 1,
        targetSecurityEpoch: 2,
        state: "planned",
        cursor: null,
        totalItems: inv.totalItems,
        migratedItems: 0,
        failure: null,
        nextAttemptAtUtc: null,
        deadlineAtUtc: "2026-09-12T00:00:00.000Z",
        version: 1,
        createdAtUtc: "2026-09-11T00:00:00.000Z",
        updatedAtUtc: "2026-09-11T00:00:00.000Z",
      };

      await current.persistence.transaction(tenant, async (tx) => {
        await tx.securityMigrations.insert(multiLevelMig);
        const active = transitionSecurityMigration(multiLevelMig, "active", "2026-09-11T01:00:00.000Z");
        await tx.securityMigrations.saveProgressPreservingPlan(active.id, active, multiLevelMig.version);
      });

      const batchHandler = new ExecuteSecurityMigrationBatchHandler(current.persistence);
      await batchHandler.execute({
        tenantId: tenant,
        migrationId: multiLevelMig.id,
        expectedMigrationVersion: 2,
        batchSize: 50,
        occurredAtUtc: "2026-09-11T02:00:00.000Z",
      });

      const verifyHandler = new BeginSecurityMigrationVerificationHandler(current.persistence);
      await verifyHandler.execute({
        tenantId: tenant,
        migrationId: multiLevelMig.id,
        expectedMigrationVersion: 3,
        occurredAtUtc: "2026-09-11T03:00:00.000Z",
      });

      // Verify all objects are in targetDomainId and epoch 2
      await current.persistence.read(tenant, async (tx) => {
        const gcNode = await tx.nodes.get("grandchild-1");
        const cNode = await tx.nodes.get("child-1");
        const rNode = await tx.nodes.get("root");
        const gcTask = await tx.tasks.get("task-gc");
        const gcAsset = await tx.assets.get("asset-gc");
        assert.equal(gcNode?.securityDomainId, targetDomainId);
        assert.equal(cNode?.securityDomainId, targetDomainId);
        assert.equal(rNode?.securityDomainId, targetDomainId);
        assert.equal(gcTask?.securityDomainId, targetDomainId);
        assert.equal(gcAsset?.securityDomainId, targetDomainId);
      });

      // Execute rollback with verifier
      const readinessPort = new TestEpochReadinessAdapter();
      const rollbackHandler = makeRollbackHandler(current.persistence, readinessPort);

      const rollbackResult = await rollbackHandler.execute({
        tenantId: tenant,
        migrationId: multiLevelMig.id,
        expectedMigrationVersion: 4,
        actorPrincipalId: managerPrincipal,
        reason: "multi-level reverse rollback test",
        occurredAtUtc: "2026-09-11T04:00:00.000Z",
      });

      assert.equal(rollbackResult.state, "rolled_back");

      // Verify all objects cleanly restored to sourceDomainId and source epoch 1
      await current.persistence.read(tenant, async (tx) => {
        const gcNode = await tx.nodes.get("grandchild-1");
        const cNode = await tx.nodes.get("child-1");
        const rNode = await tx.nodes.get("root");
        const gcTask = await tx.tasks.get("task-gc");
        const gcAsset = await tx.assets.get("asset-gc");
        assert.equal(gcNode?.securityDomainId, sourceDomainId);
        assert.equal(gcNode?.securityEpoch, 1);
        assert.equal(cNode?.securityDomainId, sourceDomainId);
        assert.equal(cNode?.securityEpoch, 1);
        assert.equal(rNode?.securityDomainId, sourceDomainId);
        assert.equal(rNode?.securityEpoch, 1);
        assert.equal(gcTask?.securityDomainId, sourceDomainId);
        assert.equal(gcTask?.securityEpoch, 1);
        assert.equal(gcAsset?.securityDomainId, sourceDomainId);
        assert.equal(gcAsset?.securityEpoch, 1);
      });
    } finally {
      await current.cleanup();
    }
  }

  // Subcase 3: Commit vs Rollback concurrency race
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      const mig = await prepareVerifyingMigration(current.persistence, { withBindings: true });
      const readinessPort = new TestEpochReadinessAdapter();
      const commitHandler = makeCommitHandler(current.persistence, readinessPort);
      const rollbackHandler = makeRollbackHandler(current.persistence, readinessPort);

      // Fire commit and rollback concurrently on the same verifying migration version
      const results = await Promise.allSettled([
        commitHandler.execute({
          tenantId: tenant,
          migrationId: mig.id,
          expectedMigrationVersion: mig.version,
          actorPrincipalId: managerPrincipal,
          occurredAtUtc: "2026-09-11T04:00:00.000Z",
        }),
        rollbackHandler.execute({
          tenantId: tenant,
          migrationId: mig.id,
          expectedMigrationVersion: mig.version,
          actorPrincipalId: managerPrincipal,
          reason: "concurrent race",
          occurredAtUtc: "2026-09-11T04:00:00.000Z",
        }),
      ]);

      const fulfilled = results.filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

      assert.equal(fulfilled.length, 1, `${name}: exactly one operation must succeed`);
      assert.equal(rejected.length, 1, `${name}: exactly one operation must be rejected`);
      const winner = fulfilled[0];
      const loser = rejected[0];
      assert.ok(winner !== undefined, `${name}: winner must be defined`);
      assert.ok(loser !== undefined, `${name}: loser must be defined`);
      assert.ok(
        winner.value.state === "committed" || winner.value.state === "rolled_back",
        `${name}: winner reached terminal state`,
      );
      assert.ok(
        loser.reason instanceof ApplicationError && (
          loser.reason.code === "SECURITY_MIGRATION_VERSION_CONFLICT"
          || loser.reason.code === "SECURITY_MIGRATION_ROLLBACK_INVALID"
          || loser.reason.code === "SECURITY_MIGRATION_COMMIT_INVALID"
        ),
        `${name}: loser failed with version conflict`,
      );
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002K Capability absence probe, unforgeable coordinator, and mandatory field validation", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      const migration = await prepareVerifyingMigration(current.persistence);

      // Probe 1: Public generic Persistence has no challenge/evidence capability or methods
      assert.equal((current.persistence as any).issueReadinessChallenge, undefined, `${name}:persistence_no_issue_method`);
      assert.equal((current.persistence as any).recordVerifiedEvidence, undefined, `${name}:persistence_no_record_method`);
      assert.equal((current.persistence as any).createSecurityMigrationVerificationCapability, undefined, `${name}:persistence_no_factory`);

      // Probe 2: Public generic tx.securityMigrations has no challenge/evidence capability or methods
      await current.persistence.read(tenant, async (tx) => {
        assert.equal((tx.securityMigrations as any).issueReadinessChallenge, undefined, `${name}:tx_no_issue_method`);
        assert.equal((tx.securityMigrations as any).recordVerifiedEvidence, undefined, `${name}:tx_no_record_method`);
        assert.equal((tx.securityMigrations as any).createSecurityMigrationVerificationCapability, undefined, `${name}:tx_no_factory`);
      });

      // Probe 3: Arbitrary caller holding only generic Persistence cannot self-certify or attach a verifier
      const arbitraryCaller: Persistence = current.persistence;
      assert.equal((arbitraryCaller as any).verifyMigrationReadiness, undefined, `${name}:no_persistence_verifyMigrationReadiness`);
      assert.equal((arbitraryCaller as any).kBackendSecret, undefined, `${name}:no_persistence_kBackendSecret`);
      assert.equal((arbitraryCaller as any).registerVerificationBackend, undefined, `${name}:no_persistence_register`);
      assert.equal((arbitraryCaller as any).createSecurityMigrationCoordinator, undefined, `${name}:no_persistence_coordinator`);

      const harness = current.testHarness;

      // Probe 4: Invalid challenge purpose rejected
      await assert.rejects(
        harness.issueChallenge(tenant, {
          migrationId: migration.id,
          purpose: "tampered" as any,
        }),
        (err: unknown) => err instanceof Error,
        `${name}:invalid_purpose_rejected`,
      );

      // Issue real challenge via test harness
      const challenge = await harness.issueChallenge(tenant, {
        migrationId: migration.id,
        purpose: "commit",
      });
      assert.equal(challenge.status, "issued");
      assert.equal(challenge.purpose, "commit");

      // Probe 5: Provider allowlist strictly enforced (only "huly" allowed)
      const untrustedVerifier: ExternalCollaborationEpochReadinessPort = {
        async checkEpochReadiness(scope) {
          return makeReadinessEvidence(scope as any, { provider: "untrusted_adapter" });
        },
      };
      const untrustedOp = harness.createVerificationOperation(untrustedVerifier);
      await assert.rejects(
        untrustedOp({ tenantId: tenant, migrationId: migration.id, purpose: "commit" }),
        (err: unknown) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_EVIDENCE_INVALID",
        `${name}:untrusted_provider_rejected`,
      );

      // Probe 6: Purpose mismatch between evidence and challenge rejected
      const mismatchPurposeVerifier: ExternalCollaborationEpochReadinessPort = {
        async checkEpochReadiness(scope) {
          return makeReadinessEvidence(scope as any, { purpose: "rollback" });
        },
      };
      const mismatchPurposeOp = harness.createVerificationOperation(mismatchPurposeVerifier);
      await assert.rejects(
        mismatchPurposeOp({ tenantId: tenant, migrationId: migration.id, purpose: "commit" }),
        (err: unknown) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_EVIDENCE_INVALID",
        `${name}:purpose_mismatch_rejected`,
      );

      // Probe 7: Verifier timestamp predating challenge issuance rejected
      const predatingVerifier: ExternalCollaborationEpochReadinessPort = {
        async checkEpochReadiness(scope) {
          return makeReadinessEvidence(scope as any, { verifiedAtUtc: "2020-01-01T00:00:00.000Z" });
        },
      };
      const predatingOp = harness.createVerificationOperation(predatingVerifier);
      await assert.rejects(
        predatingOp({ tenantId: tenant, migrationId: migration.id, purpose: "commit" }),
        (err: unknown) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_EVIDENCE_INVALID",
        `${name}:predating_verified_at_rejected`,
      );

      // Probe 8: Verifier timestamp in the future rejected
      const futureVerifier: ExternalCollaborationEpochReadinessPort = {
        async checkEpochReadiness(scope) {
          return makeReadinessEvidence(scope as any, { verifiedAtUtc: "2099-01-01T00:00:00.000Z" });
        },
      };
      const futureOp = harness.createVerificationOperation(futureVerifier);
      await assert.rejects(
        futureOp({ tenantId: tenant, migrationId: migration.id, purpose: "commit" }),
        (err: unknown) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_EVIDENCE_INVALID",
        `${name}:future_verified_at_rejected`,
      );

      // Probe 9: Challenge binding fields tampering rejected
      const bindingFields = [
        "nonce",
        "tenantId",
        "projectId",
        "migrationId",
        "sourceSecurityDomainId",
        "targetSecurityDomainId",
        "sourceSecurityEpoch",
        "targetSecurityEpoch",
        "manifestDigest",
        "itemCount",
        "expiresAtUtc",
      ] as const;

      for (const field of bindingFields) {
        const tamperedVerifier: ExternalCollaborationEpochReadinessPort = {
          async checkEpochReadiness(scope) {
            return makeReadinessEvidence(scope as any, {
              [field]: field.includes("Epoch") || field === "itemCount" ? 9999 : "tampered_value",
            } as any);
          },
        };
        const tamperedOp = harness.createVerificationOperation(tamperedVerifier);
        await assert.rejects(
          tamperedOp({ tenantId: tenant, migrationId: migration.id, purpose: "commit" }),
          (err: unknown) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_EVIDENCE_INVALID",
          `${name}:tampered_${field}_rejected`,
        );
      }

      // Probe 10: Successful verification transitions challenge to verified and returns evidence
      const validVerifier: ExternalCollaborationEpochReadinessPort = {
        async checkEpochReadiness(scope) {
          return makeReadinessEvidence(scope as any);
        },
      };
      const validOp = harness.createVerificationOperation(validVerifier);
      const certified = await validOp({ tenantId: tenant, migrationId: migration.id, purpose: "commit" });
      assert.equal(certified.record?.status, "verified");

      // Probe 11: Attempting to re-verify already verified challenge rejected
      assert.ok(certified.record);
      await assert.rejects(
        harness.recordVerifiedEvidence(tenant, {
          evidenceId: certified.record.evidenceId,
          nonce: certified.record.nonce,
          tenantId: certified.record.tenantId,
          projectId: certified.record.projectId,
          migrationId: certified.record.migrationId,
          purpose: certified.record.purpose,
          sourceSecurityDomainId: certified.record.sourceSecurityDomainId,
          targetSecurityDomainId: certified.record.targetSecurityDomainId,
          sourceSecurityEpoch: certified.record.sourceSecurityEpoch,
          targetSecurityEpoch: certified.record.targetSecurityEpoch,
          manifestDigest: certified.record.manifestDigest,
          itemCount: certified.record.itemCount,
          issuedAtUtc: certified.record.issuedAtUtc,
          expiresAtUtc: certified.record.expiresAtUtc,
          provider: "huly",
          converged: true,
          channels: { issue: "converged", attachment: "converged", blob: "converged" },
        }),
        (err: unknown) => err instanceof Error && err.message === "SECURITY_MIGRATION_EVIDENCE_ALREADY_VERIFIED",
        `${name}:already_verified_rejected`,
      );
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002K saveManifestSnapshot write-once immutability and missing snapshot rejection during rollback", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      const migration = await prepareVerifyingMigration(current.persistence);
      const snapshot = await current.persistence.read(tenant, async (tx) => {
        return await tx.securityMigrations.getManifestSnapshot(migration.id);
      });
      assert.ok(snapshot);

      // Replay identical snapshot -> succeeds
      await current.persistence.transaction(tenant, async (tx) => {
        await tx.securityMigrations.saveManifestSnapshot(snapshot);
      });

      // Different manifestDigest -> throws SECURITY_MIGRATION_SNAPSHOT_IMMUTABLE
      await current.persistence.transaction(tenant, async (tx) => {
        await assert.rejects(
          tx.securityMigrations.saveManifestSnapshot({
            ...snapshot,
            manifestDigest: "0".repeat(64),
          }),
          (err: unknown) => err instanceof Error && err.message === "SECURITY_MIGRATION_SNAPSHOT_IMMUTABLE",
          `${name}:different_digest_rejected`,
        );
      });

      // Different itemCount -> throws SECURITY_MIGRATION_SNAPSHOT_IMMUTABLE
      await current.persistence.transaction(tenant, async (tx) => {
        await assert.rejects(
          tx.securityMigrations.saveManifestSnapshot({
            ...snapshot,
            itemCount: snapshot.itemCount + 1,
          }),
          (err: unknown) => err instanceof Error && err.message === "SECURITY_MIGRATION_SNAPSHOT_IMMUTABLE",
          `${name}:different_item_count_rejected`,
        );
      });
    } finally {
      await current.cleanup();
    }

    // Now test rollback rejection when snapshot is missing
    {
      const currentSnap = await fixture(name);
      try {
        await setupBaseline(currentSnap.persistence);
        const plannedNoSnap: SecurityDomainMigration = {
          tenantId: tenant,
          id: "mig-no-snapshot",
          projectId,
          rootNodeId: "root",
          sourceSecurityDomainId: sourceDomainId,
          targetSecurityDomainId: targetDomainId,
          hierarchyRevision: 1,
          sourceSecurityEpoch: 1,
          targetSecurityEpoch: 2,
          state: "planned",
          cursor: null,
          totalItems: 1,
          migratedItems: 0,
          failure: null,
          nextAttemptAtUtc: null,
          deadlineAtUtc: "2026-09-12T00:00:00.000Z",
          version: 1,
          createdAtUtc: "2026-09-11T00:00:00.000Z",
          updatedAtUtc: "2026-09-11T00:00:00.000Z",
        };
        await currentSnap.persistence.transaction(tenant, async (tx) => {
          await tx.securityMigrations.insert(plannedNoSnap);
          const active = transitionSecurityMigration(plannedNoSnap, "active", "2026-09-11T01:00:00.000Z");
          await tx.securityMigrations.saveProgressPreservingPlan(active.id, active, plannedNoSnap.version);
          const checkpointed = checkpointSecurityMigration(active, {
            cursor: JSON.stringify(["root"]),
            migratedItems: 1,
            occurredAtUtc: "2026-09-11T01:30:00.000Z",
          });
          await tx.securityMigrations.saveProgressPreservingPlan(checkpointed.id, checkpointed, active.version);
        });

        const readinessPort = new TestEpochReadinessAdapter();
        const rollbackHandler = makeRollbackHandler(currentSnap.persistence, readinessPort);
        await assert.rejects(
          rollbackHandler.execute({
            tenantId: tenant,
            migrationId: plannedNoSnap.id,
            expectedMigrationVersion: 3,
            actorPrincipalId: managerPrincipal,
            reason: "rollback with missing snapshot",
            occurredAtUtc: "2026-09-11T04:00:00.000Z",
          }),
          (err: unknown) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_MANIFEST_MISMATCH",
          `${name}:rollback_missing_snapshot_rejected`,
        );
      } finally {
        await currentSnap.cleanup();
      }
    }
  }
});

test("TC-SEC-002K saveManifestSnapshot and getManifestSnapshot strictly reject corrupted, non-canonical, or malformed snapshot items matrix", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      const migration = await prepareVerifyingMigration(current.persistence, { withBindings: true });
      const validSnapshot = await current.persistence.read(tenant, async (tx) => {
        return await tx.securityMigrations.getManifestSnapshot(migration.id);
      });
      assert.ok(validSnapshot);
      assert.ok(validSnapshot.items.length >= 2, "Expected multiple items to test ordering");

      // Matrix of corruptions to apply to snapshot items
      const corruptions: Array<{ label: string; mutator: (items: readonly any[]) => any[] }> = [
        // 1. Corrupt ownerNodeId (empty string)
        {
          label: "corrupt_ownerNodeId_empty",
          mutator: (items) => {
            const copy: any[] = structuredClone(items as any[]);
            copy[0].ownerNodeId = "";
            return copy;
          },
        },
        // 2. Corrupt ownerNodeId (wrong type)
        {
          label: "corrupt_ownerNodeId_type",
          mutator: (items) => {
            const copy: any[] = structuredClone(items as any[]);
            copy[0].ownerNodeId = 12345;
            return copy;
          },
        },
        // 3. Corrupt version (zero)
        {
          label: "corrupt_version_zero",
          mutator: (items) => {
            const copy: any[] = structuredClone(items as any[]);
            copy[0].version = 0;
            return copy;
          },
        },
        // 4. Corrupt version (negative)
        {
          label: "corrupt_version_negative",
          mutator: (items) => {
            const copy: any[] = structuredClone(items as any[]);
            copy[0].version = -1;
            return copy;
          },
        },
        // 5. Corrupt securityEpoch (zero)
        {
          label: "corrupt_securityEpoch_zero",
          mutator: (items) => {
            const copy: any[] = structuredClone(items as any[]);
            copy[0].securityEpoch = 0;
            return copy;
          },
        },
        // 6. Corrupt securityEpoch (negative)
        {
          label: "corrupt_securityEpoch_negative",
          mutator: (items) => {
            const copy: any[] = structuredClone(items as any[]);
            copy[0].securityEpoch = -2;
            return copy;
          },
        },
        // 7. Corrupt task externalReference (missing provider)
        {
          label: "corrupt_task_ext_ref_missing_provider",
          mutator: (items) => {
            const copy: any[] = structuredClone(items as any[]);
            const taskItem = copy.find((it: any) => it.kind === "task");
            if (taskItem) {
              taskItem.externalReference = { kind: "task", externalId: "ext-1", schemaVersion: 1 };
            }
            return copy;
          },
        },
        // 8. Corrupt task externalReference (schemaVersion 0)
        {
          label: "corrupt_task_ext_ref_schema_version_zero",
          mutator: (items) => {
            const copy: any[] = structuredClone(items as any[]);
            const taskItem = copy.find((it: any) => it.kind === "task");
            if (taskItem) {
              taskItem.externalReference = { provider: "huly", kind: "task", externalId: "ext-1", schemaVersion: 0 };
            }
            return copy;
          },
        },
        // 9. Corrupt task bindingVersion (negative)
        {
          label: "corrupt_task_binding_version_negative",
          mutator: (items) => {
            const copy: any[] = structuredClone(items as any[]);
            const taskItem = copy.find((it: any) => it.kind === "task");
            if (taskItem) {
              taskItem.bindingVersion = -1;
            }
            return copy;
          },
        },
        // 10. Corrupt task syncState (invalid enum)
        {
          label: "corrupt_task_sync_state_invalid_enum",
          mutator: (items) => {
            const copy: any[] = structuredClone(items as any[]);
            const taskItem = copy.find((it: any) => it.kind === "task");
            if (taskItem) {
              taskItem.syncState = "bogus_state";
            }
            return copy;
          },
        },
        // 11. Forbidden key on node (externalReference on node)
        {
          label: "corrupt_node_forbidden_external_ref",
          mutator: (items) => {
            const copy: any[] = structuredClone(items as any[]);
            const nodeItem = copy.find((it: any) => it.kind === "node");
            if (nodeItem) {
              nodeItem.externalReference = { provider: "huly", kind: "node", externalId: "ext-n", schemaVersion: 1 };
            }
            return copy;
          },
        },
        // 12. Non-canonical ordering (swap first two items)
        {
          label: "corrupt_non_canonical_ordering",
          mutator: (items) => {
            const copy: any[] = structuredClone(items as any[]);
            if (copy.length >= 2) {
              const temp = copy[0];
              copy[0] = copy[1];
              copy[1] = temp;
            }
            return copy;
          },
        },
        // 13. Duplicate item (duplicate kind + id)
        {
          label: "corrupt_duplicate_item",
          mutator: (items) => {
            const copy: any[] = structuredClone(items as any[]);
            copy.push(structuredClone(copy[0]));
            return copy;
          },
        },
      ];

      for (const { label, mutator } of corruptions) {
        const corruptedItems = mutator(validSnapshot.items);
        await current.persistence.transaction(tenant, async (tx) => {
          await assert.rejects(
            tx.securityMigrations.saveManifestSnapshot({
              ...validSnapshot,
              migrationId: `mig-corrupt-${label}`,
              itemCount: corruptedItems.length,
              items: corruptedItems,
            }),
            (err: unknown) => err instanceof Error && err.message.includes("SECURITY_MIGRATION_MANIFEST_MISMATCH"),
            `${name}:${label}`,
          );
        });
      }
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002K Verifier response cross-scope mismatch matrix on commit and rollback", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      const migration = await prepareVerifyingMigration(current.persistence, { withBindings: true });

      const harness = current.testHarness;
      const fieldsToTamper = [
        { key: "tenantId", value: tenantId("other-tenant") },
        { key: "projectId", value: "other-project" },
        { key: "migrationId", value: "other-migration" },
        { key: "purpose", value: "rollback" as const },
        { key: "sourceSecurityDomainId", value: "wrong-domain" },
        { key: "targetSecurityDomainId", value: "wrong-domain" },
        { key: "sourceSecurityEpoch", value: 99 },
        { key: "targetSecurityEpoch", value: 99 },
        { key: "manifestDigest", value: "0".repeat(64) },
        { key: "itemCount", value: 999 },
        { key: "nonce", value: "tampered-nonce" },
        { key: "expiresAtUtc", value: "2099-01-01T00:00:00.000Z" },
      ] as const;

      for (const tamper of fieldsToTamper) {
        const badVerifier: ExternalCollaborationEpochReadinessPort = {
          async checkEpochReadiness(scope) {
            const base = makeReadinessEvidence(scope as any);
            return {
              ...base,
              [tamper.key]: tamper.value,
            };
          },
        };
        const badOp = harness.createVerificationOperation(badVerifier);
        await assert.rejects(
          badOp({ tenantId: tenant, migrationId: migration.id, purpose: "commit" }),
          (err: unknown) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_EVIDENCE_INVALID",
          `${name}:verifier_tampered_${tamper.key}`,
        );
      }

      // Handler verifier response mismatch checks on Commit
      class MismatchingVerifier implements ExternalCollaborationEpochReadinessPort {
        readonly tamperField: string;
        readonly tamperValue: any;
        constructor(tamperField: string, tamperValue: any) {
          this.tamperField = tamperField;
          this.tamperValue = tamperValue;
        }
        async checkEpochReadiness(scope: EpochReadinessScope): Promise<SecurityMigrationReadinessEvidence> {
          const base: SecurityMigrationReadinessEvidence = {
            evidenceId: scope.evidenceId,
            nonce: scope.nonce,
    tenantId: scope.tenantId,
            purpose: scope.purpose,
            migrationId: scope.migrationId,
            projectId: scope.projectId,
            manifestDigest: scope.manifestDigest,
            sourceSecurityDomainId: scope.sourceSecurityDomainId,
            targetSecurityDomainId: scope.targetSecurityDomainId,
            sourceSecurityEpoch: scope.sourceSecurityEpoch,
            targetSecurityEpoch: scope.targetSecurityEpoch,
            provider: "huly",
            converged: true,
            channels: { issue: "converged", attachment: "converged", blob: "converged" },
            verifiedAtUtc: "2026-09-11T03:59:00.000Z",
            expiresAtUtc: scope.expiresAtUtc,
            consumedAtUtc: null,
            itemCount: scope.itemCount,
          };
          (base as any)[this.tamperField] = this.tamperValue;
          return base;
        }
      }

      const handlerTamperMatrix = [
        { field: "manifestDigest", value: "tampered_digest" },
        { field: "itemCount", value: 999 },
        { field: "tenantId", value: tenantId("other-tenant") },
        { field: "projectId", value: "other-project" },
        { field: "migrationId", value: "other-migration" },
        { field: "sourceSecurityDomainId", value: "other-domain" },
        { field: "targetSecurityDomainId", value: "other-domain" },
        { field: "sourceSecurityEpoch", value: 99 },
        { field: "targetSecurityEpoch", value: 99 },
        { field: "nonce", value: "other-nonce" },
        { field: "expiresAtUtc", value: "2099-01-01T00:00:00.000Z" },
      ];

      for (const t of handlerTamperMatrix) {
        const port = new MismatchingVerifier(t.field, t.value);
        const commitHandler = makeCommitHandler(current.persistence, port);
        await assert.rejects(
          commitHandler.execute({
            tenantId: tenant,
            migrationId: migration.id,
            expectedMigrationVersion: migration.version,
            actorPrincipalId: managerPrincipal,
            occurredAtUtc: "2026-09-11T04:00:00.000Z",
          }),
          (err: unknown) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_EVIDENCE_INVALID",
          `${name}:commit_handler_verifier_tampered_${t.field}`,
        );
      }

      // Handler verifier response mismatch on Rollback -> transitions to recovery_required
      const rollbackPort = new MismatchingVerifier("targetSecurityEpoch", 999);
      const rollbackHandler = makeRollbackHandler(current.persistence, rollbackPort);
      await assert.rejects(
        rollbackHandler.execute({
          tenantId: tenant,
          migrationId: migration.id,
          expectedMigrationVersion: migration.version,
          actorPrincipalId: managerPrincipal,
          reason: "testing rollback verifier mismatch",
          occurredAtUtc: "2026-09-11T04:00:00.000Z",
        }),
        (err: unknown) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_CONVERGENCE_NOT_READY",
        `${name}:rollback_handler_tampered_targetSecurityEpoch`,
      );

      // Verify rollback failed closed into recovery_required
      const stateAfter = await current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(migration.id));
      assert.equal(stateAfter?.state, "recovery_required");
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002K Held-provider races: actor revocation, binding drift, fence appearance, inventory drift during verification", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    // (a) External verifier holds challenge while actor role is revoked
    {
      const current = await fixture(name);
      try {
        const mig = await prepareVerifyingMigration(current.persistence, { withBindings: true });
        const slowPort: ExternalCollaborationEpochReadinessPort = {
          async checkEpochReadiness(scope: EpochReadinessScope): Promise<SecurityMigrationReadinessEvidence> {
            // Concurrently revoke actor principal during verification
            await current.persistence.transaction(tenant, async (tx) => {
              const p = await tx.principals.get(managerPrincipal);
              assert.ok(p);
              await tx.principals.update({
                ...p,
                status: "revoked",
                version: p.version + 1,
              }, p.version);
            });
            return makeReadinessEvidence(scope as any);
          },
        };

        const commitHandler = makeCommitHandler(current.persistence, slowPort);
        await assert.rejects(
          commitHandler.execute({
            tenantId: tenant,
            migrationId: mig.id,
            expectedMigrationVersion: mig.version,
            actorPrincipalId: managerPrincipal,
            occurredAtUtc: "2026-09-11T04:00:00.000Z",
          }),
          (err: unknown) => err instanceof ApplicationError && (err.code === "NODE_NOT_FOUND" || err.code === "SECURITY_MIGRATION_VERSION_CONFLICT"),
          `${name}:held_provider_actor_revoked`,
        );
      } finally {
        await current.cleanup();
      }
    }

    // (b) External verifier holds challenge while external binding drifts
    {
      const current = await fixture(name);
      try {
        const mig = await prepareVerifyingMigration(current.persistence, { withBindings: true });
        const slowPort: ExternalCollaborationEpochReadinessPort = {
          async checkEpochReadiness(scope: EpochReadinessScope): Promise<SecurityMigrationReadinessEvidence> {
            // Concurrently tamper with an external binding syncState
            await current.persistence.transaction(tenant, async (tx) => {
              const b = await tx.externalBindings.getByOwner("task", "task-1", "collaboration_projection");
              assert.ok(b);
              await tx.externalBindings.update({ ...b, syncState: "failed", version: b.version + 1 }, b.version);
            });
            return makeReadinessEvidence(scope as any);
          },
        };

        const commitHandler = makeCommitHandler(current.persistence, slowPort);
        await assert.rejects(
          commitHandler.execute({
            tenantId: tenant,
            migrationId: mig.id,
            expectedMigrationVersion: mig.version,
            actorPrincipalId: managerPrincipal,
            occurredAtUtc: "2026-09-11T04:00:00.000Z",
          }),
          (err: unknown) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_MANIFEST_MISMATCH",
          `${name}:held_provider_binding_drift`,
        );
      } finally {
        await current.cleanup();
      }
    }

    // (c) External verifier holds challenge while an active fence appears
    {
      const current = await fixture(name, { now: () => new Date("2026-09-11T04:00:00.000Z") });
      try {
        const mig = await prepareVerifyingMigration(current.persistence, { withBindings: true });
        const slowPort: ExternalCollaborationEpochReadinessPort = {
          async checkEpochReadiness(scope: EpochReadinessScope): Promise<SecurityMigrationReadinessEvidence> {
            // Concurrently register an active fence
            await current.persistence.transaction(tenant, async (tx) => {
              await tx.outboundProjectionFences.acquire({
                tenantId: tenant,
                id: "fence:task:task-1",
                projectId,
                ownerNodeId: "child",
                token: "fence-tok-1",
                expiresAtUtc: "2026-09-11T05:00:00.000Z",
                createdAtUtc: "2026-09-11T03:30:00.000Z",
              });
            });
            return makeReadinessEvidence(scope as any);
          },
        };

        const commitHandler = makeCommitHandler(current.persistence, slowPort);
        await assert.rejects(
          commitHandler.execute({
            tenantId: tenant,
            migrationId: mig.id,
            expectedMigrationVersion: mig.version,
            actorPrincipalId: managerPrincipal,
            occurredAtUtc: "2026-09-11T04:00:00.000Z",
          }),
          (err: unknown) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE",
          `${name}:held_provider_fence_active`,
        );
      } finally {
        await current.cleanup();
      }
    }

    // (d) External verifier holds challenge while inventory drifts (new task inserted)
    {
      const current = await fixture(name);
      try {
        const mig = await prepareVerifyingMigration(current.persistence, { withBindings: true });
        const slowPort: ExternalCollaborationEpochReadinessPort = {
          async checkEpochReadiness(scope: EpochReadinessScope): Promise<SecurityMigrationReadinessEvidence> {
            // Concurrently insert a new task into the root node hierarchy
            await current.persistence.transaction(tenant, async (tx) => {
              await tx.tasks.insert(task("task-new-drift", "root", sourceDomainId, 1));
            });
            return makeReadinessEvidence(scope as any);
          },
        };

        const commitHandler = makeCommitHandler(current.persistence, slowPort);
        await assert.rejects(
          commitHandler.execute({
            tenantId: tenant,
            migrationId: mig.id,
            expectedMigrationVersion: mig.version,
            actorPrincipalId: managerPrincipal,
            occurredAtUtc: "2026-09-11T04:00:00.000Z",
          }),
          (err: unknown) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_MANIFEST_MISMATCH",
          `${name}:held_provider_inventory_drift`,
        );
      } finally {
        await current.cleanup();
      }
    }

    // --- HELD-PROVIDER ROLLBACK RACES ---
    // (e) External verifier holds rollback challenge while actor role is revoked
    {
      const current = await fixture(name);
      try {
        const mig = await prepareVerifyingMigration(current.persistence, { withBindings: true });
        const slowPort: ExternalCollaborationEpochReadinessPort = {
          async checkEpochReadiness(scope: EpochReadinessScope): Promise<SecurityMigrationReadinessEvidence> {
            await current.persistence.transaction(tenant, async (tx) => {
              const p = await tx.principals.get(managerPrincipal);
              assert.ok(p);
              await tx.principals.update({ ...p, status: "revoked", version: p.version + 1 }, p.version);
            });
            return makeReadinessEvidence(scope as any);
          },
        };

        const rollbackHandler = makeRollbackHandler(current.persistence, slowPort);
        await assert.rejects(
          rollbackHandler.execute({
            tenantId: tenant,
            migrationId: mig.id,
            expectedMigrationVersion: mig.version,
            actorPrincipalId: managerPrincipal,
            reason: "held provider actor revoked",
            occurredAtUtc: "2026-09-11T04:00:00.000Z",
          }),
          (err: unknown) => err instanceof ApplicationError && err.code === "NODE_NOT_FOUND",
          `${name}:rollback_held_provider_actor_revoked`,
        );
      } finally {
        await current.cleanup();
      }
    }

    // (f) External verifier holds rollback challenge while binding drifts -> fail-closed to recovery_required
    {
      const current = await fixture(name);
      try {
        const mig = await prepareVerifyingMigration(current.persistence, { withBindings: true });
        const slowPort: ExternalCollaborationEpochReadinessPort = {
          async checkEpochReadiness(scope: EpochReadinessScope): Promise<SecurityMigrationReadinessEvidence> {
            await current.persistence.transaction(tenant, async (tx) => {
              const b = await tx.externalBindings.getByOwner("task", "task-1", "collaboration_projection");
              assert.ok(b);
              await tx.externalBindings.update({ ...b, syncState: "failed", version: b.version + 1 }, b.version);
            });
            return makeReadinessEvidence(scope as any);
          },
        };

        const rollbackHandler = makeRollbackHandler(current.persistence, slowPort);
        await assert.rejects(
          rollbackHandler.execute({
            tenantId: tenant,
            migrationId: mig.id,
            expectedMigrationVersion: mig.version,
            actorPrincipalId: managerPrincipal,
            reason: "held provider binding drift",
            occurredAtUtc: "2026-09-11T04:00:00.000Z",
          }),
          (err: unknown) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_MANIFEST_MISMATCH",
          `${name}:rollback_held_provider_binding_drift`,
        );

        const stateAfter = await current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(mig.id));
        assert.equal(stateAfter?.state, "recovery_required", `${name}:binding_drift_recovery_required`);
      } finally {
        await current.cleanup();
      }
    }

    // (g) External verifier holds rollback challenge while active fence appears -> fail-closed to recovery_required
    {
      const current = await fixture(name, { now: () => new Date("2026-09-11T04:00:00.000Z") });
      try {
        const mig = await prepareVerifyingMigration(current.persistence, { withBindings: true });
        const slowPort: ExternalCollaborationEpochReadinessPort = {
          async checkEpochReadiness(scope: EpochReadinessScope): Promise<SecurityMigrationReadinessEvidence> {
            await current.persistence.transaction(tenant, async (tx) => {
              await tx.outboundProjectionFences.acquire({
                tenantId: tenant,
                id: "fence:task:task-1",
                projectId,
                ownerNodeId: "child",
                token: "fence-tok-1",
                expiresAtUtc: "2026-09-11T05:00:00.000Z",
                createdAtUtc: "2026-09-11T03:30:00.000Z",
              });
            });
            return makeReadinessEvidence(scope as any);
          },
        };

        const rollbackHandler = makeRollbackHandler(current.persistence, slowPort);
        await assert.rejects(
          rollbackHandler.execute({
            tenantId: tenant,
            migrationId: mig.id,
            expectedMigrationVersion: mig.version,
            actorPrincipalId: managerPrincipal,
            reason: "held provider fence appearance",
            occurredAtUtc: "2026-09-11T04:00:00.000Z",
          }),
          (err: unknown) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE",
          `${name}:rollback_held_provider_fence_active`,
        );

        const stateAfter = await current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(mig.id));
        assert.equal(stateAfter?.state, "recovery_required", `${name}:fence_active_recovery_required`);
      } finally {
        await current.cleanup();
      }
    }

    // (g2) External verifier holds rollback challenge while unresolved integration operation appears in migration scope -> fail-closed to recovery_required
    {
      const current = await fixture(name, { now: () => new Date("2026-09-11T04:00:00.000Z") });
      try {
        const mig = await prepareVerifyingMigration(current.persistence, { withBindings: true });
        const slowPort: ExternalCollaborationEpochReadinessPort = {
          async checkEpochReadiness(scope: EpochReadinessScope): Promise<SecurityMigrationReadinessEvidence> {
            await current.persistence.transaction(tenant, async (tx) => {
              await tx.integrationOperations.insert({
                tenantId: tenant,
                id: "op-unresolved-rollback-race",
                operationType: "collaboration.task.project",
                subjectType: "task",
                subjectId: "task-1",
                fingerprint: "fp-race-1",
                state: "retryable",
                currentStep: "issue.sync",
                attempts: 1,
                externalRequestId: "req-race-1",
                externalReference: null,
                expectedSyncWatermark: null,
                nextAttemptAtUtc: "2026-09-11T05:00:00.000Z",
                deadlineAtUtc: "2026-09-11T06:00:00.000Z",
                lastError: "transient network failure",
                version: 1,
                createdAtUtc: "2026-09-11T03:59:00.000Z",
                updatedAtUtc: "2026-09-11T03:59:00.000Z",
              });
            });
            return makeReadinessEvidence(scope as any);
          },
        };

        const rollbackHandler = makeRollbackHandler(current.persistence, slowPort);
        await assert.rejects(
          rollbackHandler.execute({
            tenantId: tenant,
            migrationId: mig.id,
            expectedMigrationVersion: mig.version,
            actorPrincipalId: managerPrincipal,
            reason: "held provider unresolved operation appearance",
            occurredAtUtc: "2026-09-11T04:00:00.000Z",
          }),
          (err: unknown) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE",
          `${name}:rollback_held_provider_unresolved_op_fence_active`,
        );

        const stateAfter = await current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(mig.id));
        assert.equal(stateAfter?.state, "recovery_required", `${name}:unresolved_op_recovery_required`);
      } finally {
        await current.cleanup();
      }
    }

    // (h) External verifier holds rollback challenge while inventory drifts -> fail-closed to recovery_required
    {
      const current = await fixture(name);
      try {
        const mig = await prepareVerifyingMigration(current.persistence, { withBindings: true });
        const slowPort: ExternalCollaborationEpochReadinessPort = {
          async checkEpochReadiness(scope: EpochReadinessScope): Promise<SecurityMigrationReadinessEvidence> {
            await current.persistence.transaction(tenant, async (tx) => {
              await tx.tasks.insert(task("task-new-drift", "root", sourceDomainId, 1));
            });
            return makeReadinessEvidence(scope as any);
          },
        };

        const rollbackHandler = makeRollbackHandler(current.persistence, slowPort);
        await assert.rejects(
          rollbackHandler.execute({
            tenantId: tenant,
            migrationId: mig.id,
            expectedMigrationVersion: mig.version,
            actorPrincipalId: managerPrincipal,
            reason: "held provider inventory drift",
            occurredAtUtc: "2026-09-11T04:00:00.000Z",
          }),
          (err: unknown) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_MANIFEST_MISMATCH",
          `${name}:rollback_held_provider_inventory_drift`,
        );

        const stateAfter = await current.persistence.read(tenant, async (tx) => await tx.securityMigrations.get(mig.id));
        assert.equal(stateAfter?.state, "recovery_required", `${name}:inventory_drift_recovery_required`);
      } finally {
        await current.cleanup();
      }
    }
  }
});

test("TC-SEC-002K Rollback with two independent SQLite WAL connections and process restart persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-sqlite-rollback-restart-"));
  const dbPath = join(directory, "rollback-restart.sqlite");

  const conn1 = createTestSqliteBundle({ path: dbPath, busyTimeoutMilliseconds: 10_000 }).persistence;
  const conn2 = createTestSqliteBundle({ path: dbPath, busyTimeoutMilliseconds: 10_000 }).persistence;

  try {
    const migration = await prepareVerifyingMigration(conn1, { withBindings: true });

    // Both connections see verifying migration
    const readOnConn2 = await conn2.read(tenant, async (tx) => await tx.securityMigrations.get(migration.id));
    assert.equal(readOnConn2?.state, "verifying");

    // Execute rollback via conn1
    const readinessPort = new TestEpochReadinessAdapter();
    const rollbackHandler = makeRollbackHandler(conn1, readinessPort);
    const rollbackRes = await rollbackHandler.execute({
      tenantId: tenant,
      migrationId: migration.id,
      expectedMigrationVersion: migration.version,
      actorPrincipalId: managerPrincipal,
      reason: "WAL 2-connection restart rollback test",
      occurredAtUtc: "2026-09-11T04:00:00.000Z",
    });
    assert.equal(rollbackRes.state, "rolled_back");

    // Connection 2 immediately sees rolled_back state before close
    const readConn2After = await conn2.read(tenant, async (tx) => await tx.securityMigrations.get(migration.id));
    assert.equal(readConn2After?.state, "rolled_back");

    // Simulate complete process restart: close both connections
    await conn1.close();
    await conn2.close();

    // Check SQLite db directly and with conn3
    const db = new DatabaseSync(dbPath);
    const evidenceRows = db.prepare("SELECT * FROM security_migration_readiness_evidence WHERE migration_id = ?").all(migration.id) as any[];
    assert.ok(evidenceRows.length > 0);
    const rollbackEvidenceRow = evidenceRows.find((r) => r.purpose === "rollback");
    assert.ok(rollbackEvidenceRow);
    assert.equal(rollbackEvidenceRow.status, "consumed");
    assert.ok(rollbackEvidenceRow.consumed_at_utc !== null);

    const conn3 = createTestSqliteBundle({ path: dbPath, busyTimeoutMilliseconds: 10_000 }).persistence;
    try {
      await conn3.read(tenant, async (tx) => {
        // 1. Migration state survived restart
        const persistedMig = await tx.securityMigrations.get(migration.id);
        assert.ok(persistedMig);
        assert.equal(persistedMig.state, "rolled_back");
        assert.equal(persistedMig.version, migration.version + 1);

        // 2. Snapshot survived restart
        const snapshot = await tx.securityMigrations.getManifestSnapshot(migration.id);
        assert.ok(snapshot);
        assert.equal(snapshot.itemCount, 4);

        // 3. Readiness evidence survived restart and is consumed
        const evidenceRecord = await tx.securityMigrations.getReadinessEvidence(rollbackEvidenceRow.evidence_id);
        assert.ok(evidenceRecord);
        assert.equal(evidenceRecord.status, "consumed");
        assert.ok(evidenceRecord.consumedAtUtc !== null);

        // 4. Domain objects restored to source domain and epoch 1
        const rootNode = await tx.nodes.get("root");
        const childNode = await tx.nodes.get("child");
        const task1 = await tx.tasks.get("task-1");
        const asset1 = await tx.assets.get("asset-1");
        assert.equal(rootNode?.securityDomainId, sourceDomainId);
        assert.equal(rootNode?.securityEpoch, 1);
        assert.equal(childNode?.securityDomainId, sourceDomainId);
        assert.equal(childNode?.securityEpoch, 1);
        assert.equal(task1?.securityDomainId, sourceDomainId);
        assert.equal(task1?.securityEpoch, 1);
        assert.equal(asset1?.securityDomainId, sourceDomainId);
        assert.equal(asset1?.securityEpoch, 1);

        // 5. Audit entry survived restart
        const audits = await tx.securityMigrationAudits.listByMigration(migration.id);
        const rollbackAudit = audits.find((a) => a.action === "rolled_back");
        assert.ok(rollbackAudit);
        assert.equal(rollbackAudit.sourceSecurityDomainId, sourceDomainId);
        assert.equal(rollbackAudit.targetSecurityDomainId, targetDomainId);
      });

      // 6. Outbox event survived restart
      const outbox = await conn3.listOutbox(tenant);
      const rollbackEvent = outbox.find((e) => e.topic.includes("security-migration.rolled_back"));
      assert.ok(rollbackEvent);
    } finally {
      await conn3.close();
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TC-SEC-002K Write-boundary failure injection on commit and rollback preserves atomicity (zero partial mutation)", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      // --- SUBCASE 1: COMMIT WRITE-BOUNDARY FAILURE INJECTION ---
      const migration = await prepareVerifyingMigration(current.persistence, { withBindings: true });
      const challenge = await issueAndCertifyChallenge(current.persistence, tenant, migration.id, "commit");

      // Attempt transaction where commit succeeds locally but error is thrown before boundary commit completes
      await assert.rejects(
        current.persistence.transaction(tenant, async (tx) => {
          await tx.securityMigrations.commitWithReadinessEvidence({
            migrationId: migration.id,
            expectedVersion: migration.version,
            actorPrincipalId: managerPrincipal,
            occurredAtUtc: "2026-09-11T04:00:00.000Z",
            evidenceId: challenge.evidenceId,
          });
          // Inject simulated database / network write failure
          throw new Error("SIMULATED_COMMIT_TRANSACTION_FAILURE");
        }),
        (err: unknown) => err instanceof Error && err.message === "SIMULATED_COMMIT_TRANSACTION_FAILURE",
        `${name}:commit_failure_injected`,
      );

      // Verify ZERO partial state persisted for commit:
      await current.persistence.read(tenant, async (tx) => {
        // 1. Migration remains in verifying state, not committed
        const migAfter = await tx.securityMigrations.get(migration.id);
        assert.equal(migAfter?.state, "verifying");
        assert.equal(migAfter?.version, migration.version);

        // 2. Evidence remains verified, NOT consumed
        const evidenceAfter = await tx.securityMigrations.getReadinessEvidence(challenge.evidenceId);
        assert.equal(evidenceAfter?.status, "verified");
        assert.equal(evidenceAfter?.consumedAtUtc, null);

        // 3. No committed audit log entry
        const audits = await tx.securityMigrationAudits.listByMigration(migration.id);
        const commitAudit = audits.find((a) => a.action === "committed");
        assert.equal(commitAudit, undefined);
      });

      if (name === "sqlite") {
        const db = new DatabaseSync(current.path!);
        const outboxRows = db.prepare("SELECT * FROM outbox_messages").all() as any[];
        assert.equal(outboxRows.find((e) => e.topic?.includes("security-migration.committed")), undefined);
        db.close();
      }
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002K Write-boundary failure injection on rollback preserves atomicity (zero partial mutation)", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      const rollbackMig = await prepareVerifyingMigration(current.persistence, { withBindings: true });
      const rollbackChallenge = await issueAndCertifyChallenge(current.persistence, tenant, rollbackMig.id, "rollback");

      // Attempt transaction where rollback succeeds locally but error is thrown before boundary commit completes
      await assert.rejects(
        current.persistence.transaction(tenant, async (tx) => {
          await tx.securityMigrations.rollbackWithAudit({
            migrationId: rollbackMig.id,
            expectedVersion: rollbackMig.version,
            actorPrincipalId: managerPrincipal,
            reason: "testing rollback write boundary failure injection",
            occurredAtUtc: "2026-09-11T04:00:00.000Z",
            evidenceId: rollbackChallenge.evidenceId,
          });
          // Inject simulated database / network write failure
          throw new Error("SIMULATED_ROLLBACK_TRANSACTION_FAILURE");
        }),
        (err: unknown) => err instanceof Error && err.message === "SIMULATED_ROLLBACK_TRANSACTION_FAILURE",
        `${name}:rollback_failure_injected`,
      );

      // Verify ZERO partial state persisted for rollback:
      await current.persistence.read(tenant, async (tx) => {
        // 1. Migration remains in verifying state, not rolled_back
        const migAfter = await tx.securityMigrations.get(rollbackMig.id);
        assert.equal(migAfter?.state, "verifying");
        assert.equal(migAfter?.version, rollbackMig.version);

        // 2. Evidence remains verified, NOT consumed
        const evidenceAfter = await tx.securityMigrations.getReadinessEvidence(rollbackChallenge.evidenceId);
        assert.equal(evidenceAfter?.status, "verified");
        assert.equal(evidenceAfter?.consumedAtUtc, null);

        // 3. Objects NOT rolled back (remain at target domain and epoch 2)
        const childNode = await tx.nodes.get("child");
        const task1 = await tx.tasks.get("task-1");
        const asset1 = await tx.assets.get("asset-1");
        assert.equal(childNode?.securityDomainId, targetDomainId);
        assert.equal(childNode?.securityEpoch, 2);
        assert.equal(task1?.securityDomainId, targetDomainId);
        assert.equal(task1?.securityEpoch, 2);
        assert.equal(asset1?.securityDomainId, targetDomainId);
        assert.equal(asset1?.securityEpoch, 2);

        // 4. No rolled_back audit entry
        const audits = await tx.securityMigrationAudits.listByMigration(rollbackMig.id);
        const rollbackAudit = audits.find((a) => a.action === "rolled_back");
        assert.equal(rollbackAudit, undefined);
      });

      if (name === "sqlite") {
        const db = new DatabaseSync(current.path!);
        const outboxRows = db.prepare("SELECT * FROM outbox_messages").all() as any[];
        assert.equal(outboxRows.find((e) => e.topic?.includes("security-migration.rolled_back")), undefined);
        db.close();
      }
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002K SQLite manifest snapshot and readiness evidence corruption and relational inconsistency matrix", async () => {
  const current = await fixture("sqlite");
  try {
    const migration = await prepareVerifyingMigration(current.persistence, { withBindings: true });
    const challenge = await issueAndCertifyChallenge(current.persistence, tenant, migration.id, "commit");

    const db = new DatabaseSync(current.path!);

    // --- MANIFEST SNAPSHOT CORRUPTION & INCONSISTENCY ---
    // 1. Corrupt snapshot JSON
    const origSnapshotRow = db.prepare("SELECT * FROM security_migration_manifest_snapshots WHERE migration_id = ?").get(migration.id) as any;
    assert.ok(origSnapshotRow);
    db.prepare("UPDATE security_migration_manifest_snapshots SET snapshot_json = '{malformed' WHERE migration_id = ?").run(migration.id);
    await assert.rejects(
      current.persistence.read(tenant, async (tx) => await tx.securityMigrations.getManifestSnapshot(migration.id)),
      (err: unknown) => err instanceof Error && err.message.includes("SECURITY_MIGRATION_RECORD_CORRUPT: malformed snapshot_json"),
      "snapshot_corrupt_json",
    );

    // 2. Relational manifest_digest mismatch with JSON
    db.prepare("UPDATE security_migration_manifest_snapshots SET snapshot_json = ?, manifest_digest = 'tampered-digest' WHERE migration_id = ?").run(origSnapshotRow.snapshot_json, migration.id);
    await assert.rejects(
      current.persistence.read(tenant, async (tx) => await tx.securityMigrations.getManifestSnapshot(migration.id)),
      (err: unknown) => err instanceof Error && err.message === "SECURITY_MIGRATION_PERSISTENCE_INCONSISTENT",
      "snapshot_relational_digest_mismatch",
    );

    // 3. Relational item_count mismatch with JSON
    db.prepare("UPDATE security_migration_manifest_snapshots SET manifest_digest = ?, item_count = 9999 WHERE migration_id = ?").run(origSnapshotRow.manifest_digest, migration.id);
    await assert.rejects(
      current.persistence.read(tenant, async (tx) => await tx.securityMigrations.getManifestSnapshot(migration.id)),
      (err: unknown) => err instanceof Error && err.message === "SECURITY_MIGRATION_PERSISTENCE_INCONSISTENT",
      "snapshot_relational_item_count_mismatch",
    );

    // 3b. Duplicate snapshot substitution rejection (Finding 5)
    const validSnapshot = JSON.parse(origSnapshotRow.snapshot_json);
    const duplicatedItems = [
      ...validSnapshot.items.filter((i: any) => i.kind !== "asset"),
      { kind: "task", id: "task-1" },
    ];
    const duplicateSnapshotJson = JSON.stringify({
      ...validSnapshot,
      items: duplicatedItems,
    });
    db.prepare("UPDATE security_migration_manifest_snapshots SET snapshot_json = ?, manifest_digest = ?, item_count = ? WHERE migration_id = ?").run(
      duplicateSnapshotJson,
      origSnapshotRow.manifest_digest,
      origSnapshotRow.item_count,
      migration.id,
    );
    await assert.rejects(
      current.persistence.read(tenant, async (tx) => await tx.securityMigrations.getManifestSnapshot(migration.id)),
      (err: unknown) => err instanceof Error && (
        err.message.includes("SECURITY_MIGRATION_MANIFEST_MISMATCH")
        || (err as any).code === "SECURITY_MIGRATION_MANIFEST_MISMATCH"
      ),
      "snapshot_duplicate_item_rejected",
    );
    await assert.rejects(
      current.persistence.transaction(tenant, async (tx) => {
        return await tx.securityMigrations.commitWithReadinessEvidence({
          migrationId: migration.id,
          expectedVersion: migration.version,
          actorPrincipalId: managerPrincipal,
          occurredAtUtc: "2026-09-11T04:00:00.000Z",
          evidenceId: challenge.evidenceId,
        });
      }),
      (err: unknown) => err instanceof Error && (
        err.message.includes("SECURITY_MIGRATION_MANIFEST_MISMATCH")
        || (err as any).code === "SECURITY_MIGRATION_MANIFEST_MISMATCH"
      ),
      "commit_duplicate_item_snapshot_rejected",
    );

    // Restore snapshot row
    db.prepare("UPDATE security_migration_manifest_snapshots SET snapshot_json = ?, manifest_digest = ?, item_count = ? WHERE migration_id = ?").run(
      origSnapshotRow.snapshot_json,
      origSnapshotRow.manifest_digest,
      origSnapshotRow.item_count,
      migration.id,
    );

    // --- READINESS EVIDENCE CORRUPTION & INCONSISTENCY ---
    // 4. Corrupt evidence JSON
    const origEvidenceRow = db.prepare("SELECT * FROM security_migration_readiness_evidence WHERE evidence_id = ?").get(challenge.evidenceId) as any;
    assert.ok(origEvidenceRow);
    db.prepare("UPDATE security_migration_readiness_evidence SET evidence_json = '{malformed' WHERE evidence_id = ?").run(challenge.evidenceId);
    await assert.rejects(
      current.persistence.read(tenant, async (tx) => await tx.securityMigrations.getReadinessEvidence(challenge.evidenceId)),
      (err: unknown) => err instanceof Error && err.message.includes("SECURITY_MIGRATION_RECORD_CORRUPT: malformed evidence_json"),
      "evidence_corrupt_json",
    );

    // 5. Relational status mismatch with JSON
    db.prepare("UPDATE security_migration_readiness_evidence SET evidence_json = ?, status = 'consumed' WHERE evidence_id = ?").run(origEvidenceRow.evidence_json, challenge.evidenceId);
    await assert.rejects(
      current.persistence.read(tenant, async (tx) => await tx.securityMigrations.getReadinessEvidence(challenge.evidenceId)),
      (err: unknown) => err instanceof Error && err.message === "SECURITY_MIGRATION_PERSISTENCE_INCONSISTENT",
      "evidence_relational_status_mismatch",
    );

    // 6. Relational manifest_digest mismatch with JSON
    db.prepare("UPDATE security_migration_readiness_evidence SET status = ?, manifest_digest = 'tampered' WHERE evidence_id = ?").run(origEvidenceRow.status, challenge.evidenceId);
    await assert.rejects(
      current.persistence.read(tenant, async (tx) => await tx.securityMigrations.getReadinessEvidence(challenge.evidenceId)),
      (err: unknown) => err instanceof Error && err.message === "SECURITY_MIGRATION_PERSISTENCE_INCONSISTENT",
      "evidence_relational_digest_mismatch",
    );

    // 7. Relational source_security_epoch mismatch with JSON
    db.prepare("UPDATE security_migration_readiness_evidence SET manifest_digest = ?, source_security_epoch = 999 WHERE evidence_id = ?").run(origEvidenceRow.manifest_digest, challenge.evidenceId);
    await assert.rejects(
      current.persistence.read(tenant, async (tx) => await tx.securityMigrations.getReadinessEvidence(challenge.evidenceId)),
      (err: unknown) => err instanceof Error && err.message === "SECURITY_MIGRATION_PERSISTENCE_INCONSISTENT",
      "evidence_relational_source_epoch_mismatch",
    );

    // 8. Relational target_security_epoch mismatch with JSON
    db.prepare("UPDATE security_migration_readiness_evidence SET source_security_epoch = ?, target_security_epoch = 999 WHERE evidence_id = ?").run(origEvidenceRow.source_security_epoch, challenge.evidenceId);
    await assert.rejects(
      current.persistence.read(tenant, async (tx) => await tx.securityMigrations.getReadinessEvidence(challenge.evidenceId)),
      (err: unknown) => err instanceof Error && err.message === "SECURITY_MIGRATION_PERSISTENCE_INCONSISTENT",
      "evidence_relational_target_epoch_mismatch",
    );
  } finally {
    await current.cleanup();
  }
});

test("TC-SEC-002K Two independent SQLite WAL connections commit vs rollback terminal race with process restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-sqlite-race-restart-"));
  const dbPath = join(directory, "race-restart.sqlite");

  const conn1 = createTestSqliteBundle({ path: dbPath, busyTimeoutMilliseconds: 10_000 }).persistence;
  const conn2 = createTestSqliteBundle({ path: dbPath, busyTimeoutMilliseconds: 10_000 }).persistence;

  try {
    const migration = await prepareVerifyingMigration(conn1, { withBindings: true });

    const port1 = new TestEpochReadinessAdapter();
    const port2 = new TestEpochReadinessAdapter();
    const commitHandler = makeCommitHandler(conn1, port1);
    const rollbackHandler = makeRollbackHandler(conn2, port2);

    // Concurrently fire commit on conn1 and rollback on conn2
    const results = await Promise.allSettled([
      commitHandler.execute({
        tenantId: tenant,
        migrationId: migration.id,
        expectedMigrationVersion: migration.version,
        actorPrincipalId: managerPrincipal,
        occurredAtUtc: "2026-09-11T04:00:00.000Z",
      }),
      rollbackHandler.execute({
        tenantId: tenant,
        migrationId: migration.id,
        expectedMigrationVersion: migration.version,
        actorPrincipalId: managerPrincipal,
        reason: "racing rollback",
        occurredAtUtc: "2026-09-11T04:00:00.000Z",
      }),
    ]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    assert.equal(fulfilled.length, 1, "exactly one terminal operation succeeds");
    assert.equal(rejected.length, 1, "exactly one terminal operation is rejected");

    const winner = fulfilled[0]!.value;
    const loser = rejected[0]!.reason;
    assert.ok(winner.state === "committed" || winner.state === "rolled_back");
    assert.ok(
      loser instanceof ApplicationError && (
        loser.code === "SECURITY_MIGRATION_VERSION_CONFLICT"
        || loser.code === "SECURITY_MIGRATION_ROLLBACK_INVALID"
        || loser.code === "SECURITY_MIGRATION_COMMIT_INVALID"
      ),
    );

    // Close both active connections to simulate complete process restart
    await conn1.close();
    await conn2.close();

    // Verify winner state after restart
    const conn3 = createTestSqliteBundle({ path: dbPath, busyTimeoutMilliseconds: 10_000 }).persistence;
    try {
      await conn3.read(tenant, async (tx) => {
        const persistedMig = await tx.securityMigrations.get(migration.id);
        assert.ok(persistedMig);
        assert.equal(persistedMig.state, winner.state);
        assert.equal(persistedMig.version, migration.version + 1);

        const audits = await tx.securityMigrationAudits.listByMigration(migration.id);
        const winningAudit = audits.find((a) => a.action === winner.state);
        assert.ok(winningAudit);

        const rootNode = await tx.nodes.get("root");
        if (winner.state === "committed") {
          assert.equal(rootNode?.securityDomainId, targetDomainId);
          assert.equal(rootNode?.securityEpoch, 2);
        } else {
          assert.equal(rootNode?.securityDomainId, sourceDomainId);
          assert.equal(rootNode?.securityEpoch, 1);
        }
      });

      const outbox = await conn3.listOutbox(tenant);
      const expectedTopic = winner.state === "committed"
        ? "security-migration.committed"
        : "security-migration.rolled_back";
      assert.ok(outbox.some((e) => e.topic.includes(expectedTopic)));
    } finally {
      await conn3.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

