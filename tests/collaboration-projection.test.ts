import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runWorkerCycle } from "../apps/worker/src/worker.ts";
import { AttachTaskAssetHandler } from "../packages/application/src/assets/attach-task-asset.ts";
import { executeCreateNode } from "../packages/application/src/create-node.ts";
import { CollaborationProjectionProcessor } from "../packages/application/src/integrations/project-collaboration.ts";
import {
  IntegrationCallError,
  type AttachFileProjection,
  type ExternalBlobProjectionPort,
  type ExternalCollaborationEpochReadinessPort,
  type SecurityMigrationReadinessEvidence,
  type StoredAssetContent,
  type TaskFileProjectionPort,
  type TaskProjectionPort,
  type TaskProjectionRecord,
} from "../packages/application/src/ports/integrations.ts";
import {
  collectSecurityMigrationManifest,
  computeSecurityMigrationManifestDigest,
} from "../packages/application/src/security/security-migration-manifest.ts";
import { CreateTaskHandler } from "../packages/application/src/tasks/create-task.ts";
import { MemoryAssetContent } from "../packages/adapters/src/memory/asset-content.ts";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import { CommitSecurityMigrationHandler } from "../packages/application/src/security/commit-security-migration.ts";
import { RollbackSecurityMigrationHandler } from "../packages/application/src/security/rollback-security-migration.ts";
import {
  type Persistence,
  type TransactionContext,
} from "../packages/application/src/ports/persistence.ts";
import { externalReference, externalReferenceKey, type ExternalReference } from "../packages/domain/src/external-reference.ts";
import type { BackgroundJob } from "../packages/domain/src/events.ts";
import { principalId, tenantId, type PrincipalId, type TenantId } from "../packages/domain/src/identity.ts";
import { checkpointSecurityMigration, transitionSecurityMigration, type SecurityDomainMigration } from "../packages/domain/src/security-migration.ts";
import { grantProjectMembership as grantProjectMembershipBase } from "./support/project-membership.ts";

async function grantProjectMembership(
  persistence: Persistence,
  tenantId: TenantId,
  projectId: string,
  principalId: PrincipalId,
  options: Parameters<typeof grantProjectMembershipBase>[4] = {},
): Promise<void> {
  return await grantProjectMembershipBase(persistence, tenantId, projectId, principalId, {
    role: "project_manager",
    ...options,
  });
}

const tenant = tenantId("tenant-collaboration-projection");
const principal = principalId("principal-collaboration-projection");
const now = new Date("2026-09-04T03:00:00.000Z");

const testReadinessAdapter: ExternalCollaborationEpochReadinessPort = {
  async checkEpochReadiness(scope) {
    return {
      evidenceId: scope.evidenceId,
      nonce: scope.nonce,
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      migrationId: scope.migrationId,
      purpose: scope.purpose,
      sourceSecurityDomainId: scope.sourceSecurityDomainId,
      targetSecurityDomainId: scope.targetSecurityDomainId,
      sourceSecurityEpoch: scope.sourceSecurityEpoch,
      targetSecurityEpoch: scope.targetSecurityEpoch,
      manifestDigest: scope.manifestDigest,
      itemCount: scope.itemCount,
      expiresAtUtc: scope.expiresAtUtc,
      consumedAtUtc: null,
      verifiedAtUtc: scope.issuedAtUtc ?? new Date().toISOString(),
      provider: "huly",
      converged: true,
      channels: { issue: "converged", attachment: "converged", blob: "converged" },
    };
  },
};

async function commitMigrationForTest(
  persistence: Persistence,
  tenantId: TenantId,
  migrationId: string,
  occurredAtUtc: string = now.toISOString(),
): Promise<void> {
  await persistence.transaction(tenantId, async (tx) => {
    const existing = await tx.securityMigrations.getManifestSnapshot(migrationId);
    if (!existing) {
      const migration = await tx.securityMigrations.get(migrationId);
      assert.ok(migration);
      const manifest = await collectSecurityMigrationManifest(tx, migration);
      const digest = computeSecurityMigrationManifestDigest(manifest);
      await tx.securityMigrations.saveManifestSnapshot({
        tenantId: migration.tenantId,
        projectId: migration.projectId,
        migrationId: migration.id,
        sourceSecurityDomainId: migration.sourceSecurityDomainId,
        targetSecurityDomainId: migration.targetSecurityDomainId,
        sourceSecurityEpoch: migration.sourceSecurityEpoch,
        targetSecurityEpoch: migration.targetSecurityEpoch,
        manifestDigest: digest,
        itemCount: manifest.items.length,
        items: manifest.items,
        createdAtUtc: occurredAtUtc,
      });
    }
  });

  const verifyMigrationReadiness = (persistence as any).verifyMigrationReadiness;
  const handler = new CommitSecurityMigrationHandler(persistence, verifyMigrationReadiness);
  const migration = await persistence.read(tenantId, async (tx) => await tx.securityMigrations.get(migrationId));
  assert.ok(migration, `Migration ${migrationId} not found`);
  await handler.execute({
    tenantId,
    migrationId,
    expectedMigrationVersion: migration.version,
    actorPrincipalId: principal,
    occurredAtUtc,
  });
}

async function rollbackMigrationForTest(
  persistence: Persistence,
  tenantId: TenantId,
  migrationId: string,
  occurredAtUtc: string = now.toISOString(),
): Promise<void> {
  const migration = await persistence.read(tenantId, async (tx) => await tx.securityMigrations.get(migrationId));
  assert.ok(migration, `Migration ${migrationId} not found`);
  if (migration.migratedItems > 0) {
    await persistence.transaction(tenantId, async (tx) => {
      const existing = await tx.securityMigrations.getManifestSnapshot(migrationId);
      if (!existing) {
        const manifest = await collectSecurityMigrationManifest(tx, migration);
        const digest = computeSecurityMigrationManifestDigest(manifest);
        await tx.securityMigrations.saveManifestSnapshot({
          tenantId: migration.tenantId,
          projectId: migration.projectId,
          migrationId: migration.id,
          sourceSecurityDomainId: migration.sourceSecurityDomainId,
          targetSecurityDomainId: migration.targetSecurityDomainId,
          sourceSecurityEpoch: migration.sourceSecurityEpoch,
          targetSecurityEpoch: migration.targetSecurityEpoch,
          manifestDigest: digest,
          itemCount: manifest.items.length,
          items: manifest.items,
          createdAtUtc: occurredAtUtc,
        });
      }
    });
  }

  const verifyMigrationReadiness = (persistence as any).verifyMigrationReadiness;
  const handler = new RollbackSecurityMigrationHandler(persistence, verifyMigrationReadiness);
  await handler.execute({
    tenantId,
    migrationId,
    expectedMigrationVersion: migration.version,
    actorPrincipalId: principal,
    reason: "test rollback",
    occurredAtUtc,
  });
}

async function createTestPersistence(
  type: "memory" | "sqlite",
  clock: () => Date = () => now,
): Promise<{
  persistence: MemoryPersistence | SqlitePersistence;
  cleanup: () => Promise<void>;
  sqlitePath?: string;
}> {
  if (type === "memory") {
    const persistence = new MemoryPersistence({ now: clock, verifier: testReadinessAdapter });
    return {
      persistence,
      cleanup: async () => { await persistence.close(); },
    };
  }
  const dir = await mkdtemp(join(tmpdir(), "ppm-projection-test-"));
  const sqlitePath = join(dir, "projection.sqlite");
  const persistence = new SqlitePersistence({ path: sqlitePath, now: clock, verifier: testReadinessAdapter });
  return {
    persistence,
    sqlitePath,
    cleanup: async () => {
      await persistence.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function getJobs(persistence: Persistence, tenantIdVal: TenantId = tenant): Promise<BackgroundJob[]> {
  if (persistence instanceof MemoryPersistence) {
    return [...persistence.snapshot().jobs.values()].filter((j) => j.tenantId === tenantIdVal);
  }
  if (persistence instanceof SqlitePersistence) {
    return await persistence.listJobs(tenantIdVal);
  }
  return [];
}

async function insertDomain(
  transaction: TransactionContext,
  domainId: string,
  rootNodeId = "node-1",
  projectId = "project-1",
): Promise<void> {
  await transaction.securityDomains.insert({
    tenantId: tenant,
    id: domainId,
    projectId,
    rootNodeId,
    parentSecurityDomainId: null,
    permissionVersion: 1,
    version: 1,
    createdByPrincipalId: principal,
    createdAtUtc: now.toISOString(),
    deletedAtUtc: null,
  });
  if (await transaction.securityGrants.get(domainId, principal) === undefined) {
    await transaction.securityGrants.insert({
      tenantId: tenant,
      id: `grant:${domainId}:${principal}`,
      securityDomainId: domainId,
      principalId: principal,
      capability: "manage_access",
      status: "active",
      expiresAtUtc: null,
      grantedByPrincipalId: principal,
      reason: "test manager grant",
      version: 1,
      createdAtUtc: now.toISOString(),
      updatedAtUtc: now.toISOString(),
    });
  }
}

async function insertTargetDomain(
  transaction: TransactionContext,
  domainId = "domain-target",
  rootNodeId = "target-root",
  projectId = "project-1",
  epoch = 2,
): Promise<void> {
  await transaction.nodes.insert({
    tenantId: tenant,
    id: rootNodeId,
    projectId,
    parentId: null,
    leaderPrincipalId: null,
    title: "target root",
    kind: "work_package",
    securityDomainId: domainId,
    securityEpoch: epoch,
    version: 1,
    deletedAtUtc: null,
  });
  await transaction.securityDomains.insert({
    tenantId: tenant,
    id: domainId,
    projectId,
    rootNodeId,
    parentSecurityDomainId: null,
    permissionVersion: 1,
    version: 1,
    createdByPrincipalId: principal,
    createdAtUtc: now.toISOString(),
    deletedAtUtc: null,
  });
  if (await transaction.securityGrants.get(domainId, principal) === undefined) {
    await transaction.securityGrants.insert({
      tenantId: tenant,
      id: `grant:${domainId}:${principal}`,
      securityDomainId: domainId,
      principalId: principal,
      capability: "manage_access",
      status: "active",
      expiresAtUtc: null,
      grantedByPrincipalId: principal,
      reason: "test manager grant",
      version: 1,
      createdAtUtc: now.toISOString(),
      updatedAtUtc: now.toISOString(),
    });
  }
}

function migrationPlan(
  suffix: string,
  rootNodeId = "node-1",
  sourceSecurityDomainId: string | null = null,
  targetSecurityDomainId: string | null = "domain-target",
  sourceSecurityEpoch = 1,
  targetSecurityEpoch = 2,
  totalItems = 1,
): SecurityDomainMigration {
  return {
    tenantId: tenant,
    id: `migration-${suffix}`,
    projectId: "project-1",
    rootNodeId,
    sourceSecurityDomainId,
    targetSecurityDomainId,
    hierarchyRevision: 1,
    sourceSecurityEpoch,
    targetSecurityEpoch,
    state: "planned",
    cursor: null,
    totalItems,
    migratedItems: 0,
    failure: null,
    nextAttemptAtUtc: null,
    deadlineAtUtc: "2026-09-05T03:00:00.000Z",
    version: 1,
    createdAtUtc: now.toISOString(),
    updatedAtUtc: now.toISOString(),
  };
}

test("TC-SEC-002J an open in-scope migration durably defers Task and Asset without Huly calls, operations or failure budget in Memory and SQLite", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    for (const state of ["active", "verifying", "retryable", "recovery_required"] as const) {
      const fixture = await createTestPersistence(name);
      const tasks = new CountingTaskProjection();
      const blobs = new FakeBlobProjection();
      const files = new FailsOnceTaskFileProjection();
      const content = new MemoryAssetContent();
      try {
        await grantProjectMembership(fixture.persistence, tenant, "project-1", principal);
        await executeCreateNode(fixture.persistence, {
          tenantId: tenant, commandId: `node-${state}`, idempotencyKey: `node-${state}`,
          correlationId: state, principalId: principal, projectId: "project-1", nodeId: "node-1",
          parentId: null, title: "sensitive root", securityDomainId: null, occurredAtUtc: now.toISOString(),
        });
        await new CreateTaskHandler(fixture.persistence, { scheduleCollaborationProjection: true }).execute({
          tenantId: tenant, commandId: `task-${state}`, idempotencyKey: `task-${state}`,
          correlationId: state, principalId: principal, projectId: "project-1", nodeId: "node-1",
          taskId: "task-1", title: "must not leak", assigneePrincipalId: null, requiresAcceptance: false,
          reviewerPrincipalId: null, occurredAtUtc: now.toISOString(),
        });
        const bytes = new TextEncoder().encode("sensitive asset payload");
        await new AttachTaskAssetHandler(fixture.persistence, content, { scheduleCollaborationProjection: true }).execute({
          tenantId: tenant, commandId: `asset-${state}`, idempotencyKey: `asset-${state}`,
          correlationId: state, principalId: principal, projectId: "project-1", taskId: "task-1",
          assetId: "asset-1", displayName: "sensitive.txt", contentType: "text/plain",
          bytes, sha256: createHash("sha256").update(bytes).digest("hex"),
          occurredAtUtc: now.toISOString(), deadlineAtUtc: new Date(now.getTime() + 60_000).toISOString(),
        });

        await fixture.persistence.transaction(tenant, async (transaction) => {
          await insertDomain(transaction, "domain-target", "node-1");
          const planned = migrationPlan(state);
          await transaction.securityMigrations.insert(planned);
          let current = transitionSecurityMigration(planned, "active", now.toISOString());
          await transaction.securityMigrations.saveProgressPreservingPlan(planned.id, current, planned.version);
          if (state === "verifying") {
            const next = transitionSecurityMigration(current, "verifying", now.toISOString());
            await transaction.securityMigrations.saveProgressPreservingPlan(planned.id, next, current.version);
            current = next;
          }
          if (state === "retryable" || state === "recovery_required") {
            const next = transitionSecurityMigration(current, state, now.toISOString(), state);
            await transaction.securityMigrations.saveProgressPreservingPlan(planned.id, next, current.version);
          }
        });

        const processor = new CollaborationProjectionProcessor({
          persistence: fixture.persistence, assetContent: content, tasks, blobs,
          taskFiles: files, now: () => now,
        });
        await runWorkerCycle({
          outbox: fixture.persistence.outboxConsumer, jobs: fixture.persistence.jobConsumer,
          processJob: async (job) => await processor.process(job),
        }, { workerId: `worker-${state}`, now: () => now });

        const jobs = await getJobs(fixture.persistence);
        const taskJob = jobs.find((j) => j.jobType === "collaboration.task.project");
        const assetJob = jobs.find((j) => j.jobType === "collaboration.asset.project");

        assert.equal(tasks.createCalls, 0, `${name}:${state}:task_createCalls`);
        assert.equal(blobs.putCalls, 0, `${name}:${state}:blobs_putCalls`);
        assert.equal(files.attachCalls, 0, `${name}:${state}:files_attachCalls`);

        assert.equal(taskJob?.state, "pending", `${name}:${state}:task_job_state`);
        assert.equal(taskJob?.attempts, 0, `${name}:${state}:task_job_attempts`);
        assert.equal(taskJob?.lastError, null, `${name}:${state}:task_job_lastError`);

        assert.equal(assetJob?.state, "pending", `${name}:${state}:asset_job_state`);
        assert.equal(assetJob?.attempts, 0, `${name}:${state}:asset_job_attempts`);
        assert.equal(assetJob?.lastError, null, `${name}:${state}:asset_job_lastError`);

        assert.equal(await fixture.persistence.read(tenant, async (tx) => await tx.integrationOperations.get(`op:${taskJob?.id}`)), undefined, `${name}:${state}:task_op`);
        assert.equal(await fixture.persistence.read(tenant, async (tx) => await tx.integrationOperations.get(`op:${assetJob?.id}`)), undefined, `${name}:${state}:asset_op`);
      } finally {
        await fixture.cleanup();
      }
    }
  }
});

test("TC-SEC-002J source, target and outside scope behavior during open migration in Memory and SQLite", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const fixture = await createTestPersistence(name);
    const tasks = new CountingTaskProjection();
    const blobs = new FakeBlobProjection();
    const files = new FailsOnceTaskFileProjection();
    const content = new MemoryAssetContent();
    try {
      await grantProjectMembership(fixture.persistence, tenant, "project-1", principal);
      await executeCreateNode(fixture.persistence, {
        tenantId: tenant, commandId: "node-source-cmd", idempotencyKey: "node-source-cmd",
        correlationId: "scope-test", principalId: principal, projectId: "project-1", nodeId: "node-1",
        parentId: null, title: "migration root", securityDomainId: null, occurredAtUtc: now.toISOString(),
      });
      await executeCreateNode(fixture.persistence, {
        tenantId: tenant, commandId: "node-outside-cmd", idempotencyKey: "node-outside-cmd",
        correlationId: "scope-test", principalId: principal, projectId: "project-1", nodeId: "node-outside",
        parentId: null, title: "outside root", securityDomainId: null, occurredAtUtc: now.toISOString(),
      });

      // 1. Task in source scope (under node-1, epoch 1)
      await new CreateTaskHandler(fixture.persistence, { scheduleCollaborationProjection: true }).execute({
        tenantId: tenant, commandId: "task-source-cmd", idempotencyKey: "task-source-cmd",
        correlationId: "scope-test", principalId: principal, projectId: "project-1", nodeId: "node-1",
        taskId: "task-source", title: "source task", assigneePrincipalId: null, requiresAcceptance: false,
        reviewerPrincipalId: null, occurredAtUtc: now.toISOString(),
      });

      // 2. Task in outside scope (under node-outside, epoch 1)
      await new CreateTaskHandler(fixture.persistence, { scheduleCollaborationProjection: true }).execute({
        tenantId: tenant, commandId: "task-outside-cmd", idempotencyKey: "task-outside-cmd",
        correlationId: "scope-test", principalId: principal, projectId: "project-1", nodeId: "node-outside",
        taskId: "task-outside", title: "outside task", assigneePrincipalId: null, requiresAcceptance: false,
        reviewerPrincipalId: null, occurredAtUtc: now.toISOString(),
      });

      // Setup active migration and formal domains
      await fixture.persistence.transaction(tenant, async (transaction) => {
        await insertDomain(transaction, "domain-target", "node-1");
        const planned = migrationPlan("scope", "node-1", null, "domain-target", 1, 2);
        await transaction.securityMigrations.insert(planned);
        const active = transitionSecurityMigration(planned, "active", now.toISOString());
        await transaction.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
      });

      const processor = new CollaborationProjectionProcessor({
        persistence: fixture.persistence, assetContent: content, tasks, blobs,
        taskFiles: files, now: () => now,
      });

      // Process outside task job -> SUCCEEDS!
      const jobs = await getJobs(fixture.persistence);
      const outsideJob = jobs.find((j) => j.payload.taskId === "task-outside")!;
      const sourceJob = jobs.find((j) => j.payload.taskId === "task-source")!;

      const outsideResult = await processor.process(outsideJob);
      assert.equal(outsideResult, undefined, `${name}:outside_result`);
      assert.equal(tasks.createCalls, 1, `${name}:outside_task_created`);

      // Process source task job -> DEFERS!
      const sourceResult = await processor.process(sourceJob);
      assert.equal(sourceResult?.outcome, "deferred", `${name}:source_deferred`);
      assert.equal(tasks.createCalls, 1, `${name}:source_task_not_created`);

      // 3. Task in target scope (under node-1, migrated to domain-target epoch 2)
      await fixture.persistence.transaction(tenant, async (transaction) => {
        await transaction.tasks.migrateSecurityOwnership("migration-scope", "task-source", 1);
      });
      // While migration is active, target scope ALSO defers!
      const targetResult = await processor.process(sourceJob);
      assert.equal(targetResult?.outcome, "deferred", `${name}:target_scope_deferred`);
      assert.equal(tasks.createCalls, 1, `${name}:target_task_not_created`);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-SEC-002J planned and terminal migration states allow projection in Memory and SQLite", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    for (const testState of ["planned", "committed", "rolled_back"] as const) {
      const fixture = await createTestPersistence(name);
      const tasks = new CountingTaskProjection();
      const content = new MemoryAssetContent();
      try {
        await grantProjectMembership(fixture.persistence, tenant, "project-1", principal);
        await executeCreateNode(fixture.persistence, {
          tenantId: tenant, commandId: `node-${testState}`, idempotencyKey: `node-${testState}`,
          correlationId: testState, principalId: principal, projectId: "project-1", nodeId: "node-1",
          parentId: null, title: "migration node", securityDomainId: null, occurredAtUtc: now.toISOString(),
        });
        await new CreateTaskHandler(fixture.persistence, { scheduleCollaborationProjection: true }).execute({
          tenantId: tenant, commandId: `task-${testState}`, idempotencyKey: `task-${testState}`,
          correlationId: testState, principalId: principal, projectId: "project-1", nodeId: "node-1",
          taskId: "task-1", title: "lifecycle task", assigneePrincipalId: null, requiresAcceptance: false,
          reviewerPrincipalId: null, occurredAtUtc: now.toISOString(),
        });

        await fixture.persistence.transaction(tenant, async (transaction) => {
          await insertDomain(transaction, "domain-target", "node-1");
          const planned = migrationPlan(testState, "node-1", null, "domain-target", 1, 2, 2);
          await transaction.securityMigrations.insert(planned);
          if (testState === "committed") {
            const active = transitionSecurityMigration(planned, "active", now.toISOString());
            await transaction.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
            await transaction.nodes.migrateSecurityOwnership(planned.id, "node-1", 1);
            await transaction.tasks.migrateSecurityOwnership(planned.id, "task-1", 1);
            const checkpoint = checkpointSecurityMigration(active, {
              cursor: JSON.stringify(["node-1", "task", "task-1"]),
              migratedItems: 2,
              occurredAtUtc: now.toISOString(),
            });
            await transaction.securityMigrations.saveProgressPreservingPlan(planned.id, checkpoint, active.version);
            const verifying = transitionSecurityMigration(checkpoint, "verifying", now.toISOString());
            await transaction.securityMigrations.saveProgressPreservingPlan(planned.id, verifying, checkpoint.version);
          }
        });

        if (testState === "committed") {
          await commitMigrationForTest(fixture.persistence, tenant, `migration-${testState}`, now.toISOString());
        } else if (testState === "rolled_back") {
          await rollbackMigrationForTest(fixture.persistence, tenant, `migration-${testState}`, now.toISOString());
        }

        const processor = new CollaborationProjectionProcessor({
          persistence: fixture.persistence, assetContent: content, tasks,
          blobs: new FakeBlobProjection(), taskFiles: new FailsOnceTaskFileProjection(), now: () => now,
        });
        const [job] = await getJobs(fixture.persistence);
        assert.ok(job);
        const result = await processor.process(job);
        assert.equal(result, undefined, `${name}:${testState}:result_completed`);
        assert.equal(tasks.createCalls, 1, `${name}:${testState}:calls`);

        const binding = await fixture.persistence.read(tenant, async (tx) => await tx.externalBindings.getByOwner("task", "task-1", "collaboration_projection"));
        assert.equal(binding?.syncState, "synced", `${name}:${testState}:binding`);
      } finally {
        await fixture.cleanup();
      }
    }
  }
});


test("TC-SEC-002J durable expiring outbound fence token/CAS semantics, planned-to-active refusal, restart and stale expiry in Memory and SQLite", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    let currentTime = now;
    const fixture = await createTestPersistence(name, () => currentTime);
    try {
      await grantProjectMembership(fixture.persistence, tenant, "project-1", principal);
      await executeCreateNode(fixture.persistence, {
        tenantId: tenant, commandId: "fence-node", idempotencyKey: "fence-node",
        correlationId: "fence", principalId: principal, projectId: "project-1", nodeId: "node-1",
        parentId: null, title: "fence root", securityDomainId: null, occurredAtUtc: now.toISOString(),
      });

      await fixture.persistence.transaction(tenant, async (transaction) => {
        await insertDomain(transaction, "domain-target", "node-1");
        await transaction.securityMigrations.insert(migrationPlan("fence-test"));
      });

      // 1. Acquire active fence
      const expiresAtUtc = new Date(now.getTime() + 30_000).toISOString();
      await fixture.persistence.transaction(tenant, async (transaction) => {
        const acquired = await transaction.outboundProjectionFences.acquire({
          tenantId: tenant,
          id: "fence:task:task-1",
          projectId: "project-1",
          ownerNodeId: "node-1",
          token: "token-alpha",
          expiresAtUtc,
          createdAtUtc: now.toISOString(),
        });
        assert.equal(acquired, true);
      });

      // 2. Migration transition to active MUST REFUSE while fence is active
      await assert.rejects(
        fixture.persistence.transaction(tenant, async (transaction) => {
          const planned = await transaction.securityMigrations.get("migration-fence-test");
          assert.ok(planned);
          const active = transitionSecurityMigration(planned, "active", now.toISOString());
          await transaction.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
        }),
        /SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE/,
        `${name}:refused_active_with_fence`,
      );

      // 3. In SQLite: Restart preserves fence and refuses migration
      if (name === "sqlite" && fixture.sqlitePath) {
        await fixture.persistence.close();
        const reopened = new SqlitePersistence({ path: fixture.sqlitePath, now: () => currentTime });
        try {
          await assert.rejects(
            reopened.transaction(tenant, async (transaction) => {
              const planned = await transaction.securityMigrations.get("migration-fence-test");
              assert.ok(planned);
              const active = transitionSecurityMigration(planned, "active", now.toISOString());
              await transaction.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
            }),
            /SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE/,
            "sqlite:reopened_refused_active",
          );
        } finally {
          await reopened.close();
        }
        // Reopen original for remainder of test
        const restored = new SqlitePersistence({ path: fixture.sqlitePath, now: () => currentTime });
        (fixture as { persistence: Persistence }).persistence = restored;
      }

      // 4. Release with wrong token fails and fence remains
      await fixture.persistence.transaction(tenant, async (transaction) => {
        const released = await transaction.outboundProjectionFences.release("fence:task:task-1", "wrong-token");
        assert.equal(released, false, `${name}:wrong_token_release`);
      });

      // 5. Stale fence expiry: when time is past fence expiry, planned -> active SUCCEEDS
      currentTime = new Date(now.getTime() + 31_000);
      const pastTime = currentTime.toISOString();
      await fixture.persistence.transaction(tenant, async (transaction) => {
        const planned = await transaction.securityMigrations.get("migration-fence-test");
        assert.ok(planned);
        const active = transitionSecurityMigration(planned, "active", pastTime);
        await transaction.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
      });

      const updatedMigration = await fixture.persistence.read(tenant, async (tx) => await tx.securityMigrations.get("migration-fence-test"));
      assert.equal(updatedMigration?.state, "active", `${name}:migration_active_after_fence_expiry`);

      // 6. Overwrite expired fence with new token
      await fixture.persistence.transaction(tenant, async (transaction) => {
        const acquired = await transaction.outboundProjectionFences.acquire({
          tenantId: tenant,
          id: "fence:task:task-1",
          projectId: "project-1",
          ownerNodeId: "node-1",
          token: "token-beta",
          expiresAtUtc: new Date(now.getTime() + 60_000).toISOString(),
          createdAtUtc: pastTime,
        });
        assert.equal(acquired, true, `${name}:overwrite_expired_fence`);
        const released = await transaction.outboundProjectionFences.release("fence:task:task-1", "token-beta");
        assert.equal(released, true, `${name}:correct_token_release`);
      });
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-SEC-002J defer preserves previous attempts and lastError without consuming failure budget in Memory and SQLite", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const fixture = await createTestPersistence(name);
    const content = new MemoryAssetContent();
    const failingTasks: TaskProjectionPort = {
      health: async () => "ok",
      create: async () => {
        throw new IntegrationCallError("HULY_HTTP_504", "gateway timeout", { retryable: true, outcome: "known_failed" });
      },
      get: async () => undefined,
      remove: async () => {},
    };
    try {
      await grantProjectMembership(fixture.persistence, tenant, "project-1", principal);
      await executeCreateNode(fixture.persistence, {
        tenantId: tenant, commandId: "err-node", idempotencyKey: "err-node",
        correlationId: "preserve", principalId: principal, projectId: "project-1", nodeId: "node-1",
        parentId: null, title: "node", securityDomainId: null, occurredAtUtc: now.toISOString(),
      });
      await new CreateTaskHandler(fixture.persistence, { scheduleCollaborationProjection: true }).execute({
        tenantId: tenant, commandId: "err-task", idempotencyKey: "err-task",
        correlationId: "preserve", principalId: principal, projectId: "project-1", nodeId: "node-1",
        taskId: "task-1", title: "will fail first", assigneePrincipalId: null, requiresAcceptance: false,
        reviewerPrincipalId: null, occurredAtUtc: now.toISOString(),
      });

      // Run cycle that fails with 504 -> attempts becomes 1, lastError set
      const failingProcessor = new CollaborationProjectionProcessor({
        persistence: fixture.persistence, assetContent: content, tasks: failingTasks,
        blobs: new FakeBlobProjection(), taskFiles: new FailsOnceTaskFileProjection(), now: () => now,
      });
      await runWorkerCycle({
        outbox: fixture.persistence.outboxConsumer, jobs: fixture.persistence.jobConsumer,
        processJob: async (job) => await failingProcessor.process(job),
      }, { workerId: "worker-failing", now: () => now });

      const [initialJob] = await getJobs(fixture.persistence);
      assert.equal(initialJob?.attempts, 1, `${name}:attempts_after_failure`);
      assert.match(String(initialJob?.lastError), /gateway timeout/, `${name}:last_error_after_failure`);

      // Verify migration activation refuses while operation is unresolved/fence held
      await fixture.persistence.transaction(tenant, async (transaction) => {
        await insertDomain(transaction, "domain-target", "node-1");
        const planned = migrationPlan("preserve");
        await transaction.securityMigrations.insert(planned);
      });
      await assert.rejects(
        fixture.persistence.transaction(tenant, async (transaction) => {
          const planned = await transaction.securityMigrations.get("migration-preserve");
          assert.ok(planned);
          const active = transitionSecurityMigration(planned, "active", now.toISOString());
          await transaction.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
        }),
        /SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE/,
        `${name}:refuses_activation_with_unresolved_op`,
      );

      // Reconcile/compensate prior operation and release fence so migration can activate
      await fixture.persistence.transaction(tenant, async (transaction) => {
        const op = await transaction.integrationOperations.get(`op:${initialJob?.id}`);
        if (op) {
          await transaction.integrationOperations.update({
            ...op,
            state: "compensated",
            version: op.version + 1,
          }, op.version);
        }
        if (op?.leaseToken) {
          await transaction.outboundProjectionFences.release("fence:task:task-1", op.leaseToken);
        }
        const planned = await transaction.securityMigrations.get("migration-preserve");
        assert.ok(planned);
        const active = transitionSecurityMigration(planned, "active", now.toISOString());
        await transaction.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
      });

      // Run worker cycle on the job when available
      const nextTime = new Date(now.getTime() + 10_000);
      const deferProcessor = new CollaborationProjectionProcessor({
        persistence: fixture.persistence, assetContent: content, tasks: new CountingTaskProjection(),
        blobs: new FakeBlobProjection(), taskFiles: new FailsOnceTaskFileProjection(), now: () => nextTime,
      });
      await runWorkerCycle({
        outbox: fixture.persistence.outboxConsumer, jobs: fixture.persistence.jobConsumer,
        processJob: async (job) => await deferProcessor.process(job),
      }, { workerId: "worker-defer", now: () => nextTime });

      // Check job in DB: attempts is STILL 1 (not 0, not 2), and lastError is preserved!
      const [deferredJob] = await getJobs(fixture.persistence);
      assert.equal(deferredJob?.state, "pending", `${name}:deferred_state`);
      assert.equal(deferredJob?.attempts, 1, `${name}:preserved_attempts`);
      assert.match(String(deferredJob?.lastError), /gateway timeout/, `${name}:preserved_last_error`);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-SEC-002J strengthened formal domain validation fails closed", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    for (const scenario of [
      "corrupt-epoch",
      "drifted-epoch",
      "nested-domain",
      "invalid-migration-root",
      "missing-formal-root",
      "deleted-formal-root",
      "cross-project-formal-root",
      "unrelated-formal-root",
      "wrong-domain-on-root",
      "wrong-epoch-on-root",
      "corrupt-ancestor-cycle",
      "corrupt-ancestor-deleted",
      "corrupt-ancestor-cross-project",
    ] as const) {
      const fixture = await createTestPersistence(name);
      const tasks = new CountingTaskProjection();
      const content = new MemoryAssetContent();
      try {
        await grantProjectMembership(fixture.persistence, tenant, "project-1", principal);
        await fixture.persistence.transaction(tenant, async (transaction) => {
          await transaction.nodes.insert({
            tenantId: tenant,
            id: "node-1",
            projectId: "project-1",
            parentId: null,
            leaderPrincipalId: null,
            title: "node",
            kind: "work_package",
            securityDomainId: null,
            securityEpoch: 1,
            version: 1,
            deletedAtUtc: null,
          });

          let taskDomain: string | null = null;
          let taskEpoch = 1;
          let taskOwnerNodeId = "node-1";

          if (scenario === "corrupt-epoch") {
            taskEpoch = 0; // Invalid epoch <= 0
          } else if (scenario === "drifted-epoch") {
            taskEpoch = 5; // Drifted from owner node
          } else if (scenario === "nested-domain") {
            // Nested security domain (fail closed)
            await insertDomain(transaction, "parent-domain", "node-1");
            await transaction.nodes.insert({
              tenantId: tenant,
              id: "node-2",
              projectId: "project-1",
              parentId: "node-1",
              leaderPrincipalId: null,
              title: "nested node",
              kind: "work_package",
              securityDomainId: "nested-domain",
              securityEpoch: 1,
              version: 1,
              deletedAtUtc: null,
            });
            await transaction.securityDomains.insert({
              tenantId: tenant,
              id: "nested-domain",
              projectId: "project-1",
              rootNodeId: "node-2",
              parentSecurityDomainId: "parent-domain",
              permissionVersion: 1,
              version: 1,
              createdByPrincipalId: principal,
              createdAtUtc: now.toISOString(),
              deletedAtUtc: null,
            });
            taskDomain = "nested-domain";
            taskOwnerNodeId = "node-2";
          } else if (scenario === "invalid-migration-root") {
            await transaction.nodes.insert({
              tenantId: tenant,
              id: "node-deleted",
              projectId: "project-1",
              parentId: null,
              leaderPrincipalId: null,
              title: "deleted root",
              kind: "work_package",
              securityDomainId: null,
              securityEpoch: 1,
              version: 1,
              deletedAtUtc: now.toISOString(),
            });
            await insertDomain(transaction, "domain-target", "node-1");
            const planned = migrationPlan("invalid-root", "node-deleted");
            await transaction.securityMigrations.insert(planned);
            const active = transitionSecurityMigration(planned, "active", now.toISOString());
            await transaction.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
          } else if (scenario === "missing-formal-root") {
            if (name === "sqlite") {
              await assert.rejects(
                transaction.securityDomains.insert({
                  tenantId: tenant, id: "missing-domain", projectId: "project-1", rootNodeId: "node-nonexistent",
                  parentSecurityDomainId: null, permissionVersion: 1, version: 1, createdByPrincipalId: principal,
                  createdAtUtc: now.toISOString(), deletedAtUtc: null,
                }),
                /FOREIGN KEY constraint failed|constraint failed/i,
              );
              return;
            }
            await transaction.securityDomains.insert({
              tenantId: tenant, id: "missing-domain", projectId: "project-1", rootNodeId: "node-nonexistent",
              parentSecurityDomainId: null, permissionVersion: 1, version: 1, createdByPrincipalId: principal,
              createdAtUtc: now.toISOString(), deletedAtUtc: null,
            });
            taskDomain = "missing-domain";
          } else if (scenario === "deleted-formal-root") {
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-del-root", projectId: "project-1", parentId: null,
              leaderPrincipalId: null,
              title: "del root", kind: "work_package", securityDomainId: "del-domain", securityEpoch: 1,
              version: 1, deletedAtUtc: now.toISOString(),
            });
            await transaction.securityDomains.insert({
              tenantId: tenant, id: "del-domain", projectId: "project-1", rootNodeId: "node-del-root",
              parentSecurityDomainId: null, permissionVersion: 1, version: 1, createdByPrincipalId: principal,
              createdAtUtc: now.toISOString(), deletedAtUtc: null,
            });
            taskDomain = "del-domain";
            taskOwnerNodeId = "node-del-root";
          } else if (scenario === "cross-project-formal-root") {
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-other-proj", projectId: "project-other", parentId: null,
              leaderPrincipalId: null,
              title: "other proj node", kind: "work_package", securityDomainId: "cross-domain", securityEpoch: 1,
              version: 1, deletedAtUtc: null,
            });
            await transaction.securityDomains.insert({
              tenantId: tenant, id: "cross-domain", projectId: "project-1", rootNodeId: "node-other-proj",
              parentSecurityDomainId: null, permissionVersion: 1, version: 1, createdByPrincipalId: principal,
              createdAtUtc: now.toISOString(), deletedAtUtc: null,
            });
            taskDomain = "cross-domain";
          } else if (scenario === "unrelated-formal-root") {
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-unrelated-root", projectId: "project-1", parentId: null,
              leaderPrincipalId: null,
              title: "unrelated root", kind: "work_package", securityDomainId: "unrelated-domain", securityEpoch: 1,
              version: 1, deletedAtUtc: null,
            });
            await transaction.securityDomains.insert({
              tenantId: tenant, id: "unrelated-domain", projectId: "project-1", rootNodeId: "node-unrelated-root",
              parentSecurityDomainId: null, permissionVersion: 1, version: 1, createdByPrincipalId: principal,
              createdAtUtc: now.toISOString(), deletedAtUtc: null,
            });
            taskDomain = "unrelated-domain";
            taskOwnerNodeId = "node-1"; // node-1 is not node-unrelated-root
          } else if (scenario === "wrong-domain-on-root") {
            await transaction.securityDomains.insert({
              tenantId: tenant, id: "wrong-domain", projectId: "project-1", rootNodeId: "node-1",
              parentSecurityDomainId: null, permissionVersion: 1, version: 1, createdByPrincipalId: principal,
              createdAtUtc: now.toISOString(), deletedAtUtc: null,
            });
            taskDomain = "wrong-domain";
            taskOwnerNodeId = "node-1"; // node-1 has securityDomainId: null
          } else if (scenario === "wrong-epoch-on-root") {
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-epoch-root", projectId: "project-1", parentId: null,
              leaderPrincipalId: null,
              title: "epoch root", kind: "work_package", securityDomainId: "epoch-domain", securityEpoch: 3,
              version: 1, deletedAtUtc: null,
            });
            await transaction.securityDomains.insert({
              tenantId: tenant, id: "epoch-domain", projectId: "project-1", rootNodeId: "node-epoch-root",
              parentSecurityDomainId: null, permissionVersion: 1, version: 1, createdByPrincipalId: principal,
              createdAtUtc: now.toISOString(), deletedAtUtc: null,
            });
            taskDomain = "epoch-domain";
            taskOwnerNodeId = "node-epoch-root";
            taskEpoch = 1; // Object epoch 1 != root epoch 3
          } else if (scenario === "corrupt-ancestor-cycle") {
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-cycle-a", projectId: "project-1", parentId: "node-cycle-b",
              leaderPrincipalId: null,
              title: "cycle a", kind: "work_package", securityDomainId: null, securityEpoch: 1,
              version: 1, deletedAtUtc: null,
            });
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-cycle-b", projectId: "project-1", parentId: "node-cycle-a",
              leaderPrincipalId: null,
              title: "cycle b", kind: "work_package", securityDomainId: null, securityEpoch: 1,
              version: 1, deletedAtUtc: null,
            });
            taskOwnerNodeId = "node-cycle-a";
          } else if (scenario === "corrupt-ancestor-deleted") {
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-parent-del", projectId: "project-1", parentId: null,
              leaderPrincipalId: null,
              title: "parent del", kind: "work_package", securityDomainId: null, securityEpoch: 1,
              version: 1, deletedAtUtc: now.toISOString(),
            });
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-child-live", projectId: "project-1", parentId: "node-parent-del",
              leaderPrincipalId: null,
              title: "child live", kind: "work_package", securityDomainId: null, securityEpoch: 1,
              version: 1, deletedAtUtc: null,
            });
            taskOwnerNodeId = "node-child-live";
          } else if (scenario === "corrupt-ancestor-cross-project") {
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-parent-other", projectId: "project-other", parentId: null,
              leaderPrincipalId: null,
              title: "parent other", kind: "work_package", securityDomainId: null, securityEpoch: 1,
              version: 1, deletedAtUtc: null,
            });
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-child-proj1", projectId: "project-1", parentId: "node-parent-other",
              leaderPrincipalId: null,
              title: "child proj1", kind: "work_package", securityDomainId: null, securityEpoch: 1,
              version: 1, deletedAtUtc: null,
            });
            taskOwnerNodeId = "node-child-proj1";
          }

          await transaction.tasks.insert({
            tenantId: tenant,
            id: "task-1",
            projectId: "project-1",
            ownerNodeId: taskOwnerNodeId,
            title: "task",
            executionState: "todo",
            reviewState: "not_required",
            assigneePrincipalId: null,
            reviewerPrincipalId: null,
            requiresAcceptance: false,
            securityDomainId: taskDomain,
            securityEpoch: taskEpoch,
            version: 1,
            deletedAtUtc: null,
          });

          await transaction.jobs.schedule({
            tenantId: tenant,
            id: "job-task-1",
            jobType: "collaboration.task.project",
            dedupeKey: "job-task-1",
            payload: { taskId: "task-1", desiredVersion: 1 },
            state: "pending",
            priority: 1,
            availableAtUtc: now.toISOString(),
            attempts: 0,
            maxAttempts: 5,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAtUtc: null,
            lastError: null,
            completedAtUtc: null,
            createdAtUtc: now.toISOString(),
          });
        });

        const processor = new CollaborationProjectionProcessor({
          persistence: fixture.persistence, assetContent: content, tasks,
          blobs: new FakeBlobProjection(), taskFiles: new FailsOnceTaskFileProjection(), now: () => now,
        });

        const [job] = await getJobs(fixture.persistence);
        if (scenario === "missing-formal-root" && name === "sqlite") {
          assert.equal(job, undefined);
          return;
        }
        assert.ok(job);
        const result = await processor.process(job);
        assert.equal(result?.outcome, "deferred", `${name}:${scenario}:defers`);
        assert.equal(tasks.createCalls, 0, `${name}:${scenario}:zero_calls`);
      } finally {
        await fixture.cleanup();
      }
    }
  }
});

test("TC-SEC-002J intermediate formal-domain continuity fails closed for public-middle, other-domain-middle, and mismatched-epoch for Task and Asset", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    for (const scenario of ["public-middle", "other-domain-middle", "mismatched-epoch-middle"] as const) {
      const fixture = await createTestPersistence(name);
      const tasks = new CountingTaskProjection();
      const blobs = new FakeBlobProjection();
      const files = new FailsOnceTaskFileProjection();
      const content = new MemoryAssetContent();
      try {
        await grantProjectMembership(fixture.persistence, tenant, "project-1", principal);

        await fixture.persistence.transaction(tenant, async (transaction) => {
          await transaction.nodes.insert({
            tenantId: tenant, id: "node-root", projectId: "project-1", parentId: null,
            leaderPrincipalId: null,
            title: "formal root", kind: "work_package", securityDomainId: "domain-formal", securityEpoch: 2,
            version: 1, deletedAtUtc: null,
          });

          await insertDomain(transaction, "domain-formal", "node-root");
          if (scenario === "other-domain-middle") {
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-other-root", projectId: "project-1", parentId: null,
              leaderPrincipalId: null,
              title: "other root", kind: "work_package", securityDomainId: "domain-other", securityEpoch: 2,
              version: 1, deletedAtUtc: null,
            });
            await insertDomain(transaction, "domain-other", "node-other-root");
          }

          let midDomain: string | null = null;
          let midEpoch = 2;
          if (scenario === "public-middle") {
            midDomain = null;
            midEpoch = 2;
          } else if (scenario === "other-domain-middle") {
            midDomain = "domain-other";
            midEpoch = 2;
          } else if (scenario === "mismatched-epoch-middle") {
            midDomain = "domain-formal";
            midEpoch = 1; // Mismatched from formal-root epoch 2
          }

          await transaction.nodes.insert({
            tenantId: tenant, id: "node-mid", projectId: "project-1", parentId: "node-root",
            leaderPrincipalId: null,
            title: "middle node", kind: "work_package", securityDomainId: midDomain, securityEpoch: midEpoch,
            version: 1, deletedAtUtc: null,
          });

          await transaction.nodes.insert({
            tenantId: tenant, id: "node-leaf", projectId: "project-1", parentId: "node-mid",
            leaderPrincipalId: null,
            title: "leaf node", kind: "work_package", securityDomainId: "domain-formal", securityEpoch: 2,
            version: 1, deletedAtUtc: null,
          });

          await transaction.tasks.insert({
            tenantId: tenant, id: "task-leaf", projectId: "project-1", ownerNodeId: "node-leaf",
            title: "leaf task", executionState: "todo", reviewState: "not_required",
            assigneePrincipalId: null, reviewerPrincipalId: null, requiresAcceptance: false,
            securityDomainId: "domain-formal", securityEpoch: 2, version: 1, deletedAtUtc: null,
          });

          await transaction.externalBindings.insert({
            tenantId: tenant, id: "binding:collaboration:task:task-leaf",
            ownerType: "task", ownerId: "task-leaf", role: "collaboration_projection",
            reference: externalReference("huly", "issue", "huly-task-leaf"),
            desiredVersion: 1, observedVersion: 1, syncWatermark: "wm-1", syncState: "synced",
            lastError: null, version: 1, updatedAtUtc: now.toISOString(),
          });

          const bytes = new TextEncoder().encode("continuity test content");
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          const storedContent = await content.put({
            tenantId: tenant,
            requestId: "req-leaf-content",
            contentType: "text/plain",
            bytes,
            sha256,
          });

          await transaction.assets.insert({
            tenantId: tenant, id: "asset-leaf", projectId: "project-1", ownerNodeId: "node-leaf",
            uploaderPrincipalId: principal, failureCode: null,
            displayName: "leaf.txt", contentType: "text/plain", size: bytes.byteLength, sha256,
            lifecycleState: "available", securityDomainId: "domain-formal", securityEpoch: 2,
            version: 1, deletedAtUtc: null,
          });

          await transaction.assets.insertBinding({
            tenantId: tenant, id: "binding:asset-leaf:task-leaf", assetId: "asset-leaf",
            targetType: "task", targetId: "task-leaf", purpose: "attachment",
            version: 1, invalidatedAtUtc: null,
          });

          await transaction.externalBindings.insert({
            tenantId: tenant, id: "binding:blob:asset-leaf",
            ownerType: "asset", ownerId: "asset-leaf", role: "blob_replica",
            reference: storedContent.reference,
            desiredVersion: 1, observedVersion: 1, syncWatermark: "wm-1", syncState: "synced",
            lastError: null, version: 1, updatedAtUtc: now.toISOString(),
          });

          await transaction.jobs.schedule({
            tenantId: tenant, id: "job-task-leaf", jobType: "collaboration.task.project",
            dedupeKey: "job-task-leaf", payload: { taskId: "task-leaf", desiredVersion: 1 },
            state: "pending", priority: 1, availableAtUtc: now.toISOString(),
            attempts: 0, maxAttempts: 5, leaseOwner: null, leaseToken: null,
            leaseExpiresAtUtc: null, lastError: null, completedAtUtc: null, createdAtUtc: now.toISOString(),
          });

          await transaction.jobs.schedule({
            tenantId: tenant, id: "job-asset-leaf", jobType: "collaboration.asset.project",
            dedupeKey: "job-asset-leaf", payload: { assetId: "asset-leaf", taskId: "task-leaf", desiredVersion: 1 },
            state: "pending", priority: 1, availableAtUtc: now.toISOString(),
            attempts: 0, maxAttempts: 5, leaseOwner: null, leaseToken: null,
            leaseExpiresAtUtc: null, lastError: null, completedAtUtc: null, createdAtUtc: now.toISOString(),
          });
        });

        const processor = new CollaborationProjectionProcessor({
          persistence: fixture.persistence, assetContent: content, tasks, blobs,
          taskFiles: files, now: () => now,
        });

        const jobs = await getJobs(fixture.persistence);
        const taskJob = jobs.find((j) => j.id === "job-task-leaf")!;
        const assetJob = jobs.find((j) => j.id === "job-asset-leaf")!;

        const taskResult = await processor.process(taskJob);
        assert.equal(taskResult?.outcome, "deferred", `${name}:${scenario}:task_deferred`);
        assert.equal(tasks.createCalls, 0, `${name}:${scenario}:zero_task_calls`);

        const assetResult = await processor.process(assetJob);
        assert.equal(assetResult?.outcome, "deferred", `${name}:${scenario}:asset_deferred`);
        assert.equal(blobs.putCalls, 0, `${name}:${scenario}:zero_blob_calls`);
        assert.equal(files.attachCalls, 0, `${name}:${scenario}:zero_file_calls`);
      } finally {
        await fixture.cleanup();
      }
    }
  }
});

test("TC-SEC-002J cross-project retryable operation does not block disjoint project migration in Memory and SQLite", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const fixture = await createTestPersistence(name);
    try {
      await grantProjectMembership(fixture.persistence, tenant, "project-A", principal);
      await grantProjectMembership(fixture.persistence, tenant, "project-B", principal);

      // Setup Project A with a planned migration ready to activate
      await fixture.persistence.transaction(tenant, async (transaction) => {
        await transaction.nodes.insert({
          tenantId: tenant, id: "node-A", projectId: "project-A", parentId: null,
          leaderPrincipalId: null,
          title: "node A", kind: "work_package", securityDomainId: null, securityEpoch: 1,
          version: 1, deletedAtUtc: null,
        });
        await transaction.nodes.insert({
          tenantId: tenant, id: "node-A2", projectId: "project-A", parentId: null,
          leaderPrincipalId: null,
          title: "node A2", kind: "work_package", securityDomainId: null, securityEpoch: 1,
          version: 1, deletedAtUtc: null,
        });
        await transaction.nodes.insert({
          tenantId: tenant, id: "node-A3", projectId: "project-A", parentId: null,
          leaderPrincipalId: null,
          title: "node A3", kind: "work_package", securityDomainId: null, securityEpoch: 1,
          version: 1, deletedAtUtc: null,
        });
        await insertDomain(transaction, "domain-A-target", "node-A", "project-A");
        const plannedA = {
          ...migrationPlan("migration-A", "node-A", null, "domain-A-target", 1, 2),
          projectId: "project-A",
        };
        await transaction.securityMigrations.insert(plannedA);
      });

      // Setup Project B with a Task and retryable operation
      await fixture.persistence.transaction(tenant, async (transaction) => {
        await transaction.nodes.insert({
          tenantId: tenant, id: "node-B", projectId: "project-B", parentId: null,
          leaderPrincipalId: null,
          title: "node B", kind: "work_package", securityDomainId: null, securityEpoch: 1,
          version: 1, deletedAtUtc: null,
        });
        await transaction.tasks.insert({
          tenantId: tenant, id: "task-B", projectId: "project-B", ownerNodeId: "node-B",
          title: "task B", executionState: "todo", reviewState: "not_required",
          assigneePrincipalId: null, reviewerPrincipalId: null, requiresAcceptance: false,
          securityDomainId: null, securityEpoch: 1, version: 1, deletedAtUtc: null,
        });
        await transaction.integrationOperations.insert({
          tenantId: tenant,
          id: "op:job-task-B",
          operationType: "collaboration.task.project",
          subjectType: "task",
          subjectId: "task-B",
          fingerprint: "fp-task-B",
          state: "retryable",
          currentStep: "create_task",
          attempts: 1,
          externalRequestId: "job-task-B",
          externalReference: null,
          expectedSyncWatermark: null,
          nextAttemptAtUtc: now.toISOString(),
          deadlineAtUtc: new Date(now.getTime() + 86400_000).toISOString(),
          lastError: "504 Gateway Timeout",
          version: 1,
          createdAtUtc: now.toISOString(),
          updatedAtUtc: now.toISOString(),
        });
      });

      // Activation of Project A migration MUST SUCCEED (not blocked by Project B's retryable task operation!)
      await fixture.persistence.transaction(tenant, async (transaction) => {
        const plannedA = await transaction.securityMigrations.get("migration-migration-A");
        assert.ok(plannedA);
        const activeA = transitionSecurityMigration(plannedA, "active", now.toISOString());
        await transaction.securityMigrations.saveProgressPreservingPlan(plannedA.id, activeA, plannedA.version);
      });

      // Now test with Asset: add Project B asset retryable operation
      await fixture.persistence.transaction(tenant, async (transaction) => {
        await transaction.assets.insert({
          tenantId: tenant, id: "asset-B", projectId: "project-B", ownerNodeId: "node-B",
          uploaderPrincipalId: principal, failureCode: null,
          displayName: "asset-B.txt", contentType: "text/plain", size: 10, sha256: "0".repeat(64),
          lifecycleState: "available", securityDomainId: null, securityEpoch: 1,
          version: 1, deletedAtUtc: null,
        });
        await transaction.integrationOperations.insert({
          tenantId: tenant,
          id: "op:job-asset-B",
          operationType: "collaboration.asset.project",
          subjectType: "asset",
          subjectId: "asset-B",
          fingerprint: "fp-asset-B",
          state: "retryable",
          currentStep: "upload_blob",
          attempts: 1,
          externalRequestId: "job-asset-B",
          externalReference: null,
          expectedSyncWatermark: null,
          nextAttemptAtUtc: now.toISOString(),
          deadlineAtUtc: new Date(now.getTime() + 86400_000).toISOString(),
          lastError: "504 Gateway Timeout",
          version: 1,
          createdAtUtc: now.toISOString(),
          updatedAtUtc: now.toISOString(),
        });
      });

      // Setup another planned migration in Project A
      await fixture.persistence.transaction(tenant, async (transaction) => {
        await insertDomain(transaction, "domain-A2-target", "node-A2", "project-A");
        const plannedA2 = {
          ...migrationPlan("migration-A2", "node-A2", null, "domain-A2-target", 1, 2),
          projectId: "project-A",
        };
        await transaction.securityMigrations.insert(plannedA2);
        const activeA2 = transitionSecurityMigration(plannedA2, "active", now.toISOString());
        // Still succeeds!
        await transaction.securityMigrations.saveProgressPreservingPlan(plannedA2.id, activeA2, plannedA2.version);
      });

      // But if an unresolved operation has a MISSING or CORRUPT subject, it MUST fail closed and block!
      await fixture.persistence.transaction(tenant, async (transaction) => {
        await transaction.integrationOperations.insert({
          tenantId: tenant,
          id: "op:job-corrupt",
          operationType: "collaboration.task.project",
          subjectType: "task",
          subjectId: "task-nonexistent",
          fingerprint: "fp-corrupt",
          state: "retryable",
          currentStep: "create_task",
          attempts: 1,
          externalRequestId: "job-corrupt",
          externalReference: null,
          expectedSyncWatermark: null,
          nextAttemptAtUtc: now.toISOString(),
          deadlineAtUtc: new Date(now.getTime() + 86400_000).toISOString(),
          lastError: "some error",
          version: 1,
          createdAtUtc: now.toISOString(),
          updatedAtUtc: now.toISOString(),
        });
        await insertDomain(transaction, "domain-A3-target", "node-A3", "project-A");
        const plannedA3 = {
          ...migrationPlan("migration-A3", "node-A3", null, "domain-A3-target", 1, 2),
          projectId: "project-A",
        };
        await transaction.securityMigrations.insert(plannedA3);
      });

      // Now activating migration-A3 MUST FAIL CLOSED because the operation subject is missing/corrupt!
      await assert.rejects(
        fixture.persistence.transaction(tenant, async (transaction) => {
          const plannedA3 = await transaction.securityMigrations.get("migration-migration-A3");
          assert.ok(plannedA3);
          const activeA3 = transitionSecurityMigration(plannedA3, "active", now.toISOString());
          await transaction.securityMigrations.saveProgressPreservingPlan(plannedA3.id, activeA3, plannedA3.version);
        }),
        /SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE/,
        `${name}:missing_subject_fails_closed`,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-SEC-002J invalid/unsupported subject type blocks planned->active migration in Memory and SQLite", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const fixture = await createTestPersistence(name);
    try {
      await grantProjectMembership(fixture.persistence, tenant, "project-A", principal);

      await fixture.persistence.transaction(tenant, async (transaction) => {
        await transaction.nodes.insert({
          tenantId: tenant, id: "node-A", projectId: "project-A", parentId: null,
          leaderPrincipalId: null,
          title: "node A", kind: "work_package", securityDomainId: null, securityEpoch: 1,
          version: 1, deletedAtUtc: null,
        });
        await insertDomain(transaction, "domain-A-target", "node-A", "project-A");
        const plannedA = {
          ...migrationPlan("migration-A", "node-A", null, "domain-A-target", 1, 2),
          projectId: "project-A",
        };
        await transaction.securityMigrations.insert(plannedA);
      });

      // Insert an unresolved operation with invalid/unsupported subjectType: "custom"
      if (name === "memory") {
        await fixture.persistence.transaction(tenant, async (transaction) => {
          await transaction.integrationOperations.insert({
            tenantId: tenant,
            id: "op:invalid-subject-type",
            operationType: "collaboration.task.project",
            subjectType: "custom" as any,
            subjectId: "custom-1",
            fingerprint: "fp-custom",
            state: "retryable",
            currentStep: "create_task",
            attempts: 1,
            externalRequestId: "req-custom",
            externalReference: null,
            expectedSyncWatermark: null,
            nextAttemptAtUtc: now.toISOString(),
            deadlineAtUtc: new Date(now.getTime() + 86400_000).toISOString(),
            lastError: "some error",
            version: 1,
            createdAtUtc: now.toISOString(),
            updatedAtUtc: now.toISOString(),
          });
        });
      } else {
        const db = new DatabaseSync(fixture.sqlitePath!);
        try {
          const opJson = JSON.stringify({
            tenantId: tenant,
            id: "op:invalid-subject-type",
            operationType: "collaboration.task.project",
            subjectType: "custom",
            subjectId: "custom-1",
            fingerprint: "fp-custom",
            state: "retryable",
            currentStep: "create_task",
            attempts: 1,
            externalRequestId: "req-custom",
            externalReference: null,
            expectedSyncWatermark: null,
            nextAttemptAtUtc: now.toISOString(),
            deadlineAtUtc: new Date(now.getTime() + 86400_000).toISOString(),
            lastError: "some error",
            version: 1,
            createdAtUtc: now.toISOString(),
            updatedAtUtc: now.toISOString(),
          });
          db.prepare(`
            INSERT INTO integration_operations (
              tenant_id, operation_id, operation_type, subject_type, subject_id, state, version, operation_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(tenant, "op:invalid-subject-type", "collaboration.task.project", "custom", "custom-1", "retryable", 1, opJson);
        } finally {
          db.close();
        }
      }

      // Transitioning migration to active MUST fail closed with SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE
      await assert.rejects(
        fixture.persistence.transaction(tenant, async (transaction) => {
          const plannedA = await transaction.securityMigrations.get("migration-migration-A");
          assert.ok(plannedA);
          const activeA = transitionSecurityMigration(plannedA, "active", now.toISOString());
          await transaction.securityMigrations.saveProgressPreservingPlan(plannedA.id, activeA, plannedA.version);
        }),
        /SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE/,
        `${name}:invalid_subject_type_must_block`,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-SEC-002J SQLite relational vs operation_json drift and parse corruption blocks activation", async () => {
  const fixture = await createTestPersistence("sqlite");
  try {
    await grantProjectMembership(fixture.persistence, tenant, "project-A", principal);

    await fixture.persistence.transaction(tenant, async (transaction) => {
      await transaction.nodes.insert({
        tenantId: tenant, id: "node-A", projectId: "project-A", parentId: null,
        leaderPrincipalId: null,
        title: "node A", kind: "work_package", securityDomainId: null, securityEpoch: 1,
        version: 1, deletedAtUtc: null,
      });
      await insertDomain(transaction, "domain-A-target", "node-A", "project-A");
      const plannedA = {
        ...migrationPlan("migration-A", "node-A", null, "domain-A-target", 1, 2),
        projectId: "project-A",
      };
      await transaction.securityMigrations.insert(plannedA);
      await transaction.tasks.insert({
        tenantId: tenant, id: "task-A", projectId: "project-A", ownerNodeId: "node-A",
        title: "task A", executionState: "todo", reviewState: "not_required",
        assigneePrincipalId: null, reviewerPrincipalId: null, requiresAcceptance: false,
        securityDomainId: null, securityEpoch: 1, version: 1, deletedAtUtc: null,
      });
    });

    const baseValidOp = {
      tenantId: tenant,
      id: "op:drift-test",
      operationType: "collaboration.task.project",
      subjectType: "task",
      subjectId: "task-A",
      fingerprint: "fp-task-A",
      state: "retryable",
      currentStep: "create_task",
      attempts: 1,
      externalRequestId: "req-drift",
      externalReference: null,
      expectedSyncWatermark: null,
      nextAttemptAtUtc: now.toISOString(),
      deadlineAtUtc: new Date(now.getTime() + 86400_000).toISOString(),
      lastError: "some error",
      version: 1,
      createdAtUtc: now.toISOString(),
      updatedAtUtc: now.toISOString(),
    };

    const scenarios: Array<{
      name: string;
      relational: {
        operationId: string;
        operationType: string;
        subjectType: string;
        subjectId: string;
        state: string;
        version: number;
      };
      operationJson: string;
    }> = [
      {
        name: "relational subject_type (task) vs operation_json subjectType (asset) drift",
        relational: { operationId: "op:drift-test", operationType: "collaboration.task.project", subjectType: "task", subjectId: "task-A", state: "retryable", version: 1 },
        operationJson: JSON.stringify({ ...baseValidOp, subjectType: "asset" }),
      },
      {
        name: "relational operation_type (collaboration.task.project) vs operation_json operationType (collaboration.asset.project) drift",
        relational: { operationId: "op:drift-test", operationType: "collaboration.task.project", subjectType: "task", subjectId: "task-A", state: "retryable", version: 1 },
        operationJson: JSON.stringify({ ...baseValidOp, operationType: "collaboration.asset.project" }),
      },
      {
        name: "relational state (retryable) vs operation_json state (running) drift",
        relational: { operationId: "op:drift-test", operationType: "collaboration.task.project", subjectType: "task", subjectId: "task-A", state: "retryable", version: 1 },
        operationJson: JSON.stringify({ ...baseValidOp, state: "running" }),
      },
      {
        name: "relational subject_id (task-A) vs operation_json subjectId (task-other) drift",
        relational: { operationId: "op:drift-test", operationType: "collaboration.task.project", subjectType: "task", subjectId: "task-A", state: "retryable", version: 1 },
        operationJson: JSON.stringify({ ...baseValidOp, subjectId: "task-other" }),
      },
      {
        name: "relational version (1) vs operation_json version (2) drift",
        relational: { operationId: "op:drift-test", operationType: "collaboration.task.project", subjectType: "task", subjectId: "task-A", state: "retryable", version: 1 },
        operationJson: JSON.stringify({ ...baseValidOp, version: 2 }),
      },
      {
        name: "relational tenant_id vs operation_json tenantId drift",
        relational: { operationId: "op:drift-test", operationType: "collaboration.task.project", subjectType: "task", subjectId: "task-A", state: "retryable", version: 1 },
        operationJson: JSON.stringify({ ...baseValidOp, tenantId: "other-tenant" }),
      },
      {
        name: "operation_json parse corruption (malformed JSON syntax)",
        relational: { operationId: "op:drift-test", operationType: "collaboration.task.project", subjectType: "task", subjectId: "task-A", state: "retryable", version: 1 },
        operationJson: "{\ninvalid json corrupt",
      },
      {
        name: "operation_json invalid shape (scalar number instead of object)",
        relational: { operationId: "op:drift-test", operationType: "collaboration.task.project", subjectType: "task", subjectId: "task-A", state: "retryable", version: 1 },
        operationJson: "42",
      },
    ];

    for (const scenario of scenarios) {
      const db = new DatabaseSync(fixture.sqlitePath!);
      try {
        db.prepare(`DELETE FROM integration_operations WHERE tenant_id = ? AND operation_id = ?`)
          .run(tenant, scenario.relational.operationId);
        db.prepare(`
          INSERT INTO integration_operations (
            tenant_id, operation_id, operation_type, subject_type, subject_id, state, version, operation_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          tenant,
          scenario.relational.operationId,
          scenario.relational.operationType,
          scenario.relational.subjectType,
          scenario.relational.subjectId,
          scenario.relational.state,
          scenario.relational.version,
          scenario.operationJson,
        );
      } finally {
        db.close();
      }

      await assert.rejects(
        fixture.persistence.transaction(tenant, async (transaction) => {
          const plannedA = await transaction.securityMigrations.get("migration-migration-A");
          assert.ok(plannedA);
          const activeA = transitionSecurityMigration(plannedA, "active", now.toISOString());
          await transaction.securityMigrations.saveProgressPreservingPlan(plannedA.id, activeA, plannedA.version);
        }),
        /SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE/,
        `scenario:${scenario.name} must block activation`,
      );
    }

    // After removing the corrupted row, activation succeeds cleanly
    const dbClean = new DatabaseSync(fixture.sqlitePath!);
    try {
      dbClean.prepare(`DELETE FROM integration_operations WHERE tenant_id = ? AND operation_id = ?`)
        .run(tenant, "op:drift-test");
    } finally {
      dbClean.close();
    }

    await fixture.persistence.transaction(tenant, async (transaction) => {
      const plannedA = await transaction.securityMigrations.get("migration-migration-A");
      assert.ok(plannedA);
      const activeA = transitionSecurityMigration(plannedA, "active", now.toISOString());
      await transaction.securityMigrations.saveProgressPreservingPlan(plannedA.id, activeA, plannedA.version);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("TC-SEC-002J SQLite state-prefilter bypass regression: terminal vs nonterminal drift, enums and consistent terminal operations", async () => {
  const fixture = await createTestPersistence("sqlite");
  try {
    await grantProjectMembership(fixture.persistence, tenant, "project-A", principal);

    await fixture.persistence.transaction(tenant, async (transaction) => {
      await transaction.nodes.insert({
        tenantId: tenant, id: "node-A", projectId: "project-A", parentId: null,
        leaderPrincipalId: null,
        title: "node A", kind: "work_package", securityDomainId: null, securityEpoch: 1,
        version: 1, deletedAtUtc: null,
      });
      await insertDomain(transaction, "domain-A-target", "node-A", "project-A");
      const plannedA = {
        ...migrationPlan("migration-A", "node-A", null, "domain-A-target", 1, 2),
        projectId: "project-A",
      };
      await transaction.securityMigrations.insert(plannedA);
      await transaction.tasks.insert({
        tenantId: tenant, id: "task-A", projectId: "project-A", ownerNodeId: "node-A",
        title: "task A", executionState: "todo", reviewState: "not_required",
        assigneePrincipalId: null, reviewerPrincipalId: null, requiresAcceptance: false,
        securityDomainId: null, securityEpoch: 1, version: 1, deletedAtUtc: null,
      });
    });

    const baseOp = {
      tenantId: tenant,
      id: "op:state-test",
      operationType: "collaboration.task.project",
      subjectType: "task",
      subjectId: "task-A",
      fingerprint: "fp-task-A",
      currentStep: "create_task",
      attempts: 1,
      externalRequestId: "req-state",
      externalReference: null,
      expectedSyncWatermark: null,
      nextAttemptAtUtc: now.toISOString(),
      deadlineAtUtc: new Date(now.getTime() + 86400_000).toISOString(),
      lastError: "some error",
      version: 1,
      createdAtUtc: now.toISOString(),
      updatedAtUtc: now.toISOString(),
    };

    // 1. Relational completed vs JSON nonterminal (retryable, running, recovery_required)
    // 2. Relational compensated vs JSON nonterminal (retryable, running, recovery_required)
    // 3. Inverse terminal/nonterminal drift (relational nonterminal vs JSON terminal)
    // 4. Invalid relational or JSON state enum
    const failureScenarios: Array<{
      name: string;
      relationalState: string;
      jsonState: string;
    }> = [
      // relational completed vs JSON nonterminal
      { name: "relational completed vs JSON retryable", relationalState: "completed", jsonState: "retryable" },
      { name: "relational completed vs JSON running", relationalState: "completed", jsonState: "running" },
      { name: "relational completed vs JSON recovery_required", relationalState: "completed", jsonState: "recovery_required" },

      // relational compensated vs JSON nonterminal
      { name: "relational compensated vs JSON retryable", relationalState: "compensated", jsonState: "retryable" },
      { name: "relational compensated vs JSON running", relationalState: "compensated", jsonState: "running" },
      { name: "relational compensated vs JSON recovery_required", relationalState: "compensated", jsonState: "recovery_required" },

      // inverse terminal/nonterminal drift: relational nonterminal vs JSON terminal
      { name: "relational retryable vs JSON completed", relationalState: "retryable", jsonState: "completed" },
      { name: "relational running vs JSON completed", relationalState: "running", jsonState: "completed" },
      { name: "relational recovery_required vs JSON completed", relationalState: "recovery_required", jsonState: "completed" },
      { name: "relational retryable vs JSON compensated", relationalState: "retryable", jsonState: "compensated" },
      { name: "relational running vs JSON compensated", relationalState: "running", jsonState: "compensated" },
      { name: "relational recovery_required vs JSON compensated", relationalState: "recovery_required", jsonState: "compensated" },

      // invalid relational or JSON state enum
      { name: "invalid relational state enum vs completed JSON", relationalState: "invalid_state", jsonState: "completed" },
      { name: "completed relational state vs invalid JSON state enum", relationalState: "completed", jsonState: "invalid_state" },
      { name: "invalid relational state enum vs retryable JSON", relationalState: "invalid_state", jsonState: "retryable" },
      { name: "retryable relational state vs invalid JSON state enum", relationalState: "retryable", jsonState: "invalid_state" },
      { name: "invalid relational state enum vs invalid JSON state enum", relationalState: "bogus", jsonState: "bogus" },
    ];

    for (const scenario of failureScenarios) {
      const db = new DatabaseSync(fixture.sqlitePath!);
      try {
        db.prepare(`DELETE FROM integration_operations WHERE tenant_id = ? AND operation_id = ?`)
          .run(tenant, "op:state-test");
        db.prepare(`
          INSERT INTO integration_operations (
            tenant_id, operation_id, operation_type, subject_type, subject_id, state, version, operation_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          tenant,
          "op:state-test",
          "collaboration.task.project",
          "task",
          "task-A",
          scenario.relationalState,
          1,
          JSON.stringify({ ...baseOp, state: scenario.jsonState }),
        );
      } finally {
        db.close();
      }

      await assert.rejects(
        fixture.persistence.transaction(tenant, async (transaction) => {
          const plannedA = await transaction.securityMigrations.get("migration-migration-A");
          assert.ok(plannedA);
          const activeA = transitionSecurityMigration(plannedA, "active", now.toISOString());
          await transaction.securityMigrations.saveProgressPreservingPlan(plannedA.id, activeA, plannedA.version);
        }),
        /SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE/,
        `scenario:${scenario.name} must block activation`,
      );
    }

    // 5. Consistent completed collaboration operation allows activation
    const dbCompleted = new DatabaseSync(fixture.sqlitePath!);
    try {
      dbCompleted.prepare(`DELETE FROM integration_operations WHERE tenant_id = ? AND operation_id = ?`)
        .run(tenant, "op:state-test");
      dbCompleted.prepare(`
        INSERT INTO integration_operations (
          tenant_id, operation_id, operation_type, subject_type, subject_id, state, version, operation_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tenant,
        "op:state-test",
        "collaboration.task.project",
        "task",
        "task-A",
        "completed",
        1,
        JSON.stringify({ ...baseOp, state: "completed" }),
      );
    } finally {
      dbCompleted.close();
    }

    await fixture.persistence.transaction(tenant, async (transaction) => {
      const plannedA = await transaction.securityMigrations.get("migration-migration-A");
      assert.ok(plannedA);
      const activeA = transitionSecurityMigration(plannedA, "active", now.toISOString());
      await transaction.securityMigrations.saveProgressPreservingPlan(plannedA.id, activeA, plannedA.version);
    });

    // Reset migration to planned version for the compensated test
    const dbReset = new DatabaseSync(fixture.sqlitePath!);
    try {
      dbReset.prepare(`DELETE FROM security_domain_migrations WHERE tenant_id = ? AND migration_id = ?`)
        .run(tenant, "migration-migration-A");
      dbReset.prepare(`DELETE FROM integration_operations WHERE tenant_id = ? AND operation_id = ?`)
        .run(tenant, "op:state-test");
    } finally {
      dbReset.close();
    }

    await fixture.persistence.transaction(tenant, async (transaction) => {
      const plannedA = {
        ...migrationPlan("migration-A", "node-A", null, "domain-A-target", 1, 2),
        projectId: "project-A",
      };
      await transaction.securityMigrations.insert(plannedA);
    });

    // 6. Consistent compensated collaboration operation allows activation
    const dbCompensated = new DatabaseSync(fixture.sqlitePath!);
    try {
      dbCompensated.prepare(`
        INSERT INTO integration_operations (
          tenant_id, operation_id, operation_type, subject_type, subject_id, state, version, operation_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tenant,
        "op:state-test",
        "collaboration.task.project",
        "task",
        "task-A",
        "compensated",
        1,
        JSON.stringify({ ...baseOp, state: "compensated" }),
      );
    } finally {
      dbCompensated.close();
    }

    await fixture.persistence.transaction(tenant, async (transaction) => {
      const plannedA = await transaction.securityMigrations.get("migration-migration-A");
      assert.ok(plannedA);
      const activeA = transitionSecurityMigration(plannedA, "active", now.toISOString());
      await transaction.securityMigrations.saveProgressPreservingPlan(plannedA.id, activeA, plannedA.version);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("TC-SEC-002J missing, deleted, or corrupt subjects block activation in Memory and SQLite", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const fixture = await createTestPersistence(name);
    try {
      await grantProjectMembership(fixture.persistence, tenant, "project-A", principal);

      await fixture.persistence.transaction(tenant, async (transaction) => {
        await transaction.nodes.insert({
          tenantId: tenant, id: "node-A", projectId: "project-A", parentId: null,
          leaderPrincipalId: null,
          title: "node A", kind: "work_package", securityDomainId: null, securityEpoch: 1,
          version: 1, deletedAtUtc: null,
        });
        await insertDomain(transaction, "domain-A-target", "node-A", "project-A");
        const plannedA = {
          ...migrationPlan("migration-A", "node-A", null, "domain-A-target", 1, 2),
          projectId: "project-A",
        };
        await transaction.securityMigrations.insert(plannedA);
      });

      // Case 1: Missing asset subject
      await fixture.persistence.transaction(tenant, async (transaction) => {
        await transaction.integrationOperations.insert({
          tenantId: tenant,
          id: "op:missing-asset",
          operationType: "collaboration.asset.project",
          subjectType: "asset",
          subjectId: "asset-nonexistent",
          fingerprint: "fp-missing-asset",
          state: "retryable",
          currentStep: "upload_blob",
          attempts: 1,
          externalRequestId: "req-missing-asset",
          externalReference: null,
          expectedSyncWatermark: null,
          nextAttemptAtUtc: now.toISOString(),
          deadlineAtUtc: new Date(now.getTime() + 86400_000).toISOString(),
          lastError: "error",
          version: 1,
          createdAtUtc: now.toISOString(),
          updatedAtUtc: now.toISOString(),
        });
      });

      await assert.rejects(
        fixture.persistence.transaction(tenant, async (transaction) => {
          const plannedA = await transaction.securityMigrations.get("migration-migration-A");
          assert.ok(plannedA);
          const activeA = transitionSecurityMigration(plannedA, "active", now.toISOString());
          await transaction.securityMigrations.saveProgressPreservingPlan(plannedA.id, activeA, plannedA.version);
        }),
        /SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE/,
        `${name}:missing_asset_subject_fails_closed`,
      );

      // Clean up Case 1 op
      if (name === "memory") {
        (fixture.persistence as MemoryPersistence).snapshot().operations.delete(`${tenant}:op:missing-asset`);
      } else {
        const db = new DatabaseSync(fixture.sqlitePath!);
        try {
          db.prepare(`DELETE FROM integration_operations WHERE tenant_id = ? AND operation_id = ?`).run(tenant, "op:missing-asset");
        } finally {
          db.close();
        }
      }

      // Case 2: Deleted task subject
      await fixture.persistence.transaction(tenant, async (transaction) => {
        await transaction.tasks.insert({
          tenantId: tenant, id: "task-deleted", projectId: "project-A", ownerNodeId: "node-A",
          title: "task deleted", executionState: "todo", reviewState: "not_required",
          assigneePrincipalId: null, reviewerPrincipalId: null, requiresAcceptance: false,
          securityDomainId: null, securityEpoch: 1, version: 1, deletedAtUtc: now.toISOString(),
        });
        await transaction.integrationOperations.insert({
          tenantId: tenant,
          id: "op:deleted-task",
          operationType: "collaboration.task.project",
          subjectType: "task",
          subjectId: "task-deleted",
          fingerprint: "fp-deleted-task",
          state: "retryable",
          currentStep: "create_task",
          attempts: 1,
          externalRequestId: "req-deleted-task",
          externalReference: null,
          expectedSyncWatermark: null,
          nextAttemptAtUtc: now.toISOString(),
          deadlineAtUtc: new Date(now.getTime() + 86400_000).toISOString(),
          lastError: "error",
          version: 1,
          createdAtUtc: now.toISOString(),
          updatedAtUtc: now.toISOString(),
        });
      });

      await assert.rejects(
        fixture.persistence.transaction(tenant, async (transaction) => {
          const plannedA = await transaction.securityMigrations.get("migration-migration-A");
          assert.ok(plannedA);
          const activeA = transitionSecurityMigration(plannedA, "active", now.toISOString());
          await transaction.securityMigrations.saveProgressPreservingPlan(plannedA.id, activeA, plannedA.version);
        }),
        /SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE/,
        `${name}:deleted_task_subject_fails_closed`,
      );

      // Clean up Case 2 op
      if (name === "memory") {
        (fixture.persistence as MemoryPersistence).snapshot().operations.delete(`${tenant}:op:deleted-task`);
      } else {
        const db = new DatabaseSync(fixture.sqlitePath!);
        try {
          db.prepare(`DELETE FROM integration_operations WHERE tenant_id = ? AND operation_id = ?`).run(tenant, "op:deleted-task");
        } finally {
          db.close();
        }
      }

      // Case 3: Deleted asset subject
      await fixture.persistence.transaction(tenant, async (transaction) => {
        await transaction.assets.insert({
          tenantId: tenant, id: "asset-deleted", projectId: "project-A", ownerNodeId: "node-A",
          uploaderPrincipalId: principal, failureCode: null,
          displayName: "asset.txt", contentType: "text/plain", size: 10, sha256: "0".repeat(64),
          lifecycleState: "available", securityDomainId: null, securityEpoch: 1,
          version: 1, deletedAtUtc: now.toISOString(),
        });
        await transaction.integrationOperations.insert({
          tenantId: tenant,
          id: "op:deleted-asset",
          operationType: "collaboration.asset.project",
          subjectType: "asset",
          subjectId: "asset-deleted",
          fingerprint: "fp-deleted-asset",
          state: "retryable",
          currentStep: "upload_blob",
          attempts: 1,
          externalRequestId: "req-deleted-asset",
          externalReference: null,
          expectedSyncWatermark: null,
          nextAttemptAtUtc: now.toISOString(),
          deadlineAtUtc: new Date(now.getTime() + 86400_000).toISOString(),
          lastError: "error",
          version: 1,
          createdAtUtc: now.toISOString(),
          updatedAtUtc: now.toISOString(),
        });
      });

      await assert.rejects(
        fixture.persistence.transaction(tenant, async (transaction) => {
          const plannedA = await transaction.securityMigrations.get("migration-migration-A");
          assert.ok(plannedA);
          const activeA = transitionSecurityMigration(plannedA, "active", now.toISOString());
          await transaction.securityMigrations.saveProgressPreservingPlan(plannedA.id, activeA, plannedA.version);
        }),
        /SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE/,
        `${name}:deleted_asset_subject_fails_closed`,
      );

      // Case 4: In SQLite, corrupt asset_json row
      if (name === "sqlite") {
        const db = new DatabaseSync(fixture.sqlitePath!);
        try {
          db.prepare(`DELETE FROM integration_operations WHERE tenant_id = ? AND operation_id = ?`).run(tenant, "op:deleted-asset");
          db.prepare(`
            INSERT INTO assets (
              tenant_id, asset_id, project_id, owner_node_id, lifecycle_state, version, asset_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(tenant, "asset-corrupt-row", "project-A", "node-A", "available", 1, "{ corrupt json");
          db.prepare(`
            INSERT INTO integration_operations (
              tenant_id, operation_id, operation_type, subject_type, subject_id, state, version, operation_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            tenant, "op:corrupt-asset-row", "collaboration.asset.project", "asset", "asset-corrupt-row", "retryable", 1,
            JSON.stringify({
              tenantId: tenant, id: "op:corrupt-asset-row", operationType: "collaboration.asset.project",
              subjectType: "asset", subjectId: "asset-corrupt-row", fingerprint: "fp", state: "retryable",
              currentStep: "upload_blob", attempts: 1, externalRequestId: "req-corrupt", externalReference: null,
              expectedSyncWatermark: null, nextAttemptAtUtc: now.toISOString(),
              deadlineAtUtc: new Date(now.getTime() + 86400_000).toISOString(), lastError: "err", version: 1,
              createdAtUtc: now.toISOString(), updatedAtUtc: now.toISOString(),
            }),
          );
        } finally {
          db.close();
        }

        await assert.rejects(
          fixture.persistence.transaction(tenant, async (transaction) => {
            const plannedA = await transaction.securityMigrations.get("migration-migration-A");
            assert.ok(plannedA);
            const activeA = transitionSecurityMigration(plannedA, "active", now.toISOString());
            await transaction.securityMigrations.saveProgressPreservingPlan(plannedA.id, activeA, plannedA.version);
          }),
          /SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE/,
          "sqlite:corrupt_asset_json_fails_closed",
        );
      }
    } finally {
      await fixture.cleanup();
    }
  }
});

class ControllableBlockingTaskProjection implements TaskProjectionPort {
  readonly #records = new Map<string, TaskProjectionRecord>();
  onWorkerACall?: () => void;
  workerAHeldPromise?: Promise<void>;
  onWorkerBCall?: () => void;
  workerBHeldPromise?: Promise<void>;
  createCalls = 0;

  async health(): Promise<"ok"> { return "ok"; }
  async get(): Promise<undefined> { return undefined; }
  async remove(): Promise<void> {}

  async create(task: Parameters<TaskProjectionPort["create"]>[0]): Promise<TaskProjectionRecord> {
    this.createCalls++;
    if (this.createCalls === 1) {
      this.onWorkerACall?.();
      if (this.workerAHeldPromise) await this.workerAHeldPromise;
    } else {
      this.onWorkerBCall?.();
      if (this.workerBHeldPromise) await this.workerBHeldPromise;
    }
    const previous = this.#records.get(task.requestId);
    if (previous !== undefined) return previous;
    const record: TaskProjectionRecord = {
      reference: externalReference("huly", "issue", `huly-${task.requestId}`),
      title: task.title,
      status: task.status,
      syncWatermark: `wm-${task.requestId}`,
    };
    this.#records.set(task.requestId, record);
    return record;
  }
}

test("TC-SEC-002J same-job concurrent retry fencing preserves generation ownership across Memory and two-connection SQLite", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    let nowMs = Date.parse("2026-09-04T03:00:00.000Z");
    const clock = () => new Date(nowMs);
    const fixture = await createTestPersistence(name, clock);

    let persistenceB: Persistence;
    if (name === "sqlite") {
      persistenceB = new SqlitePersistence({ path: fixture.sqlitePath!, now: clock });
    } else {
      persistenceB = fixture.persistence;
    }

    try {
      await grantProjectMembership(fixture.persistence, tenant, "project-1", principal);

      await fixture.persistence.transaction(tenant, async (transaction) => {
        await transaction.nodes.insert({
          tenantId: tenant, id: "node-1", projectId: "project-1", parentId: null,
          leaderPrincipalId: null,
          title: "root", kind: "work_package", securityDomainId: null, securityEpoch: 1,
          version: 1, deletedAtUtc: null,
        });
        await insertDomain(transaction, "domain-target", "node-1", "project-1");
        const planned = migrationPlan("concurrent-fence", "node-1", null, "domain-target", 1, 2);
        await transaction.securityMigrations.insert(planned);

        await transaction.tasks.insert({
          tenantId: tenant, id: "task-concurrent", projectId: "project-1", ownerNodeId: "node-1",
          title: "concurrent task", executionState: "todo", reviewState: "not_required",
          assigneePrincipalId: null, reviewerPrincipalId: null, requiresAcceptance: false,
          securityDomainId: null, securityEpoch: 1, version: 1, deletedAtUtc: null,
        });

        await transaction.jobs.schedule({
          tenantId: tenant, id: "job-concurrent-1", jobType: "collaboration.task.project",
          dedupeKey: "job-concurrent-1", payload: { taskId: "task-concurrent", desiredVersion: 1 },
          state: "pending", priority: 1, availableAtUtc: clock().toISOString(),
          attempts: 0, maxAttempts: 5, leaseOwner: null, leaseToken: null,
          leaseExpiresAtUtc: null, lastError: null, completedAtUtc: null, createdAtUtc: clock().toISOString(),
        });
      });

      const blockingTasks = new ControllableBlockingTaskProjection();
      const content = new MemoryAssetContent();

      let resolveWorkerAStarted!: () => void;
      const workerAStarted = new Promise<void>((resolve) => { resolveWorkerAStarted = resolve; });
      let resolveWorkerAHeld!: () => void;
      const workerAHeld = new Promise<void>((resolve) => { resolveWorkerAHeld = resolve; });

      let resolveWorkerBStarted!: () => void;
      const workerBStarted = new Promise<void>((resolve) => { resolveWorkerBStarted = resolve; });
      let resolveWorkerBHeld!: () => void;
      const workerBHeld = new Promise<void>((resolve) => { resolveWorkerBHeld = resolve; });

      blockingTasks.onWorkerACall = () => resolveWorkerAStarted();
      blockingTasks.workerAHeldPromise = workerAHeld;
      blockingTasks.onWorkerBCall = () => resolveWorkerBStarted();
      blockingTasks.workerBHeldPromise = workerBHeld;

      const processorA = new CollaborationProjectionProcessor({
        persistence: fixture.persistence, assetContent: content, tasks: blockingTasks,
        blobs: new FakeBlobProjection(), taskFiles: new FailsOnceTaskFileProjection(),
        now: clock, fenceDurationMilliseconds: 5_000,
      });

      const processorB = new CollaborationProjectionProcessor({
        persistence: persistenceB, assetContent: content, tasks: blockingTasks,
        blobs: new FakeBlobProjection(), taskFiles: new FailsOnceTaskFileProjection(),
        now: clock, fenceDurationMilliseconds: 5_000,
      });

      const jobs = await getJobs(fixture.persistence);
      const jobA = jobs.find((j) => j.id === "job-concurrent-1")!;
      const jobB = { ...jobA };

      // 1. Worker A starts processing job
      const workerAPromise = processorA.process(jobA);
      await workerAStarted;

      // At this point Worker A has acquired fence and is calling Huly (paused inside blockingTasks.create)
      const opAfterA = await fixture.persistence.read(tenant, async (tx) => await tx.integrationOperations.get(`op:${jobA.id}`));
      assert.ok(opAfterA);
      assert.equal(opAfterA.state, "running");
      const tokenA = (opAfterA as any).leaseToken;

      // 2. Advance time past Worker A's fence expiry (5 seconds duration -> advance by 10s)
      nowMs += 10_000;

      // 3. Worker B reclaims the same job and starts processing
      const workerBPromise = processorB.process(jobB);
      await workerBStarted;

      // Worker B has taken over the fence with a fresh generation token, and updated the operation!
      const opAfterB = await fixture.persistence.read(tenant, async (tx) => await tx.integrationOperations.get(`op:${jobB.id}`));
      assert.ok(opAfterB);
      assert.equal(opAfterB.state, "running");
      const tokenB = (opAfterB as any).leaseToken;
      assert.notEqual(tokenA, tokenB, `${name}:generations_must_be_distinct`);

      // 4. Worker A's provider call completes now
      resolveWorkerAHeld();
      await workerAPromise;

      // 5. PROVE Worker A could NOT complete Worker B's operation or release Worker B's fence!
      const opAfterAComplete = await fixture.persistence.read(tenant, async (tx) => await tx.integrationOperations.get(`op:${jobA.id}`));
      assert.ok(opAfterAComplete);
      assert.notEqual(opAfterAComplete.state, "completed", `${name}:worker_A_must_not_complete_B_operation`);
      assert.equal((opAfterAComplete as any).leaseToken, tokenB, `${name}:operation_must_still_belong_to_generation_B`);

      // Prove planned -> active STAYS BLOCKED while Worker B is still calling Huly!
      await assert.rejects(
        fixture.persistence.transaction(tenant, async (transaction) => {
          const planned = await transaction.securityMigrations.get("migration-concurrent-fence");
          assert.ok(planned);
          const active = transitionSecurityMigration(planned, "active", clock().toISOString());
          await transaction.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
        }),
        /SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE/,
        `${name}:planned_to_active_must_stay_blocked_while_B_running`,
      );

      // 6. Worker B's provider call finishes and Worker B completes cleanly
      resolveWorkerBHeld();
      await workerBPromise;

      const opFinal = await fixture.persistence.read(tenant, async (tx) => await tx.integrationOperations.get(`op:${jobA.id}`));
      assert.ok(opFinal);
      assert.equal(opFinal.state, "completed", `${name}:worker_B_completed_operation`);

      // 7. Now planned -> active SUCCEEDS!
      await fixture.persistence.transaction(tenant, async (transaction) => {
        const planned = await transaction.securityMigrations.get("migration-concurrent-fence");
        assert.ok(planned);
        const active = transitionSecurityMigration(planned, "active", clock().toISOString());
        await transaction.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
      });
    } finally {
      if (name === "sqlite") {
        await persistenceB.close();
      }
      await fixture.cleanup();
    }
  }
});



test("ARCH-GATE-HULY-002 task and partial asset projection resume from durable stable references", async () => {
  const persistence = new MemoryPersistence();
  const content = new MemoryAssetContent();
  const tasks = new FakeTaskProjection();
  const blobs = new FakeBlobProjection();
  const files = new FailsOnceTaskFileProjection();
  try {
    await grantProjectMembership(persistence, tenant, "project-1", principal);
    await executeCreateNode(persistence, {
      tenantId: tenant,
      commandId: "node-command",
      idempotencyKey: "node-request",
      correlationId: "correlation-1",
      principalId: principal,
      projectId: "project-1",
      nodeId: "node-1",
      parentId: null,
      title: "实施",
      securityDomainId: null,
      occurredAtUtc: now.toISOString(),
    });
    await new CreateTaskHandler(persistence, { scheduleCollaborationProjection: true }).execute({
      tenantId: tenant,
      commandId: "task-command",
      idempotencyKey: "task-request",
      correlationId: "correlation-1",
      principalId: principal,
      projectId: "project-1",
      nodeId: "node-1",
      taskId: "task-1",
      title: "提交证据",
      assigneePrincipalId: principal,
      requiresAcceptance: false,
      reviewerPrincipalId: null,
      occurredAtUtc: now.toISOString(),
    });
    const bytes = new TextEncoder().encode("durable projection evidence");
    await new AttachTaskAssetHandler(persistence, content, { scheduleCollaborationProjection: true }).execute({
      tenantId: tenant,
      commandId: "asset-command",
      idempotencyKey: "asset-request",
      correlationId: "correlation-1",
      principalId: principal,
      projectId: "project-1",
      taskId: "task-1",
      assetId: "asset-1",
      displayName: "evidence.txt",
      contentType: "text/plain",
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      occurredAtUtc: now.toISOString(),
      deadlineAtUtc: new Date(now.getTime() + 60_000).toISOString(),
    });

    let testTime = now;
    const processor = new CollaborationProjectionProcessor({ persistence, assetContent: content, tasks, blobs, taskFiles: files, now: () => testTime });
    const jobs = [...persistence.snapshot().jobs.values()];
    const taskJob = jobs.find((job) => job.jobType === "collaboration.task.project");
    const assetJob = jobs.find((job) => job.jobType === "collaboration.asset.project");
    assert.ok(taskJob);
    assert.ok(assetJob);
    await processor.process(taskJob);
    await assert.rejects(processor.process(assetJob), /attachment service unavailable/);

    const partial = await persistence.read(tenant, async (transaction) => await transaction.integrationOperations.get(`op:${assetJob.id}`));
    assert.equal(partial?.state, "retryable");
    assert.equal(partial?.currentStep, "attach_file");
    assert.equal(partial?.externalReference?.kind, "blob");
    assert.equal(blobs.putCalls, 1);

    testTime = new Date(now.getTime() + 35_000);
    await processor.process(assetJob);
    await processor.process(assetJob);
    const result = await persistence.read(tenant, async (transaction) => ({
      task: await transaction.externalBindings.getByOwner("task", "task-1", "collaboration_projection"),
      asset: await transaction.externalBindings.getByOwner("asset", "asset-1", "collaboration_projection"),
      operation: await transaction.integrationOperations.get(`op:${assetJob.id}`),
      steps: await transaction.integrationOperations.listSteps(`op:${assetJob.id}`),
    }));
    assert.equal(result.task?.reference.kind, "task");
    assert.equal(result.asset?.reference.kind, "attachment");
    assert.equal(result.operation?.state, "completed");
    assert.equal(result.steps.filter((step) => step.step === "upload_blob" && step.outcome === "succeeded").length, 1);
    assert.equal(blobs.putCalls, 1);
    assert.equal(files.attachCalls, 2);
  } finally {
    await persistence.close();
  }
});

class FakeTaskProjection implements TaskProjectionPort {
  async health() { return "ok" as const; }
  async create(input: Parameters<TaskProjectionPort["create"]>[0]) {
    return {
      reference: externalReference("huly", "task", `task-${input.requestId}`),
      title: input.title,
      status: input.status,
      syncWatermark: "1",
    };
  }
  async get() { return undefined; }
  async remove() {}
}

class CountingTaskProjection extends FakeTaskProjection {
  createCalls = 0;
  override async create(input: Parameters<TaskProjectionPort["create"]>[0]) {
    this.createCalls += 1;
    return await super.create(input);
  }
}

class FakeBlobProjection implements ExternalBlobProjectionPort {
  readonly stored = new Map<string, StoredAssetContent>();
  putCalls = 0;
  async health() { return "ok" as const; }
  async put(input: Parameters<ExternalBlobProjectionPort["put"]>[0]) {
    this.putCalls += 1;
    const value = {
      reference: externalReference("huly", "blob", `blob-${input.requestId}`),
      contentType: input.contentType,
      size: input.bytes.byteLength,
      sha256: input.sha256,
      scanState: "available" as const,
    };
    this.stored.set(externalReferenceKey(value.reference), value);
    return value;
  }
  async exists(reference: Parameters<ExternalBlobProjectionPort["exists"]>[0]) {
    return this.stored.has(externalReferenceKey(reference));
  }
  async remove(reference: Parameters<ExternalBlobProjectionPort["remove"]>[0]) {
    this.stored.delete(externalReferenceKey(reference));
  }
}
class FakeTaskFileProjection implements TaskFileProjectionPort {
  readonly records = new Map<string, Awaited<ReturnType<TaskFileProjectionPort["attach"]>>>();
  attachCalls = 0;
  async health() { return "ok" as const; }
  async attach(input: AttachFileProjection) {
    this.attachCalls += 1;
    const value = {
      reference: externalReference("huly", "attachment", `attachment-${input.requestId}`),
      taskReference: input.taskReference,
      blobReference: input.blobReference,
      name: input.name,
      contentType: input.contentType,
      size: input.size,
      syncWatermark: "2",
    };
    this.records.set(externalReferenceKey(value.reference), value);
    return value;
  }
  async get(reference: Parameters<TaskFileProjectionPort["get"]>[0]) {
    return this.records.get(externalReferenceKey(reference));
  }
  async remove(reference: Parameters<TaskFileProjectionPort["remove"]>[0]) {
    this.records.delete(externalReferenceKey(reference));
  }
}

class FailsOnceTaskFileProjection implements TaskFileProjectionPort {
  readonly records = new Map<string, Awaited<ReturnType<TaskFileProjectionPort["attach"]>>>();
  attachCalls = 0;
  async health() { return "ok" as const; }
  async attach(input: AttachFileProjection) {
    this.attachCalls += 1;
    if (this.attachCalls === 1) {
      throw new IntegrationCallError("HULY_HTTP_503", "attachment service unavailable", { retryable: true, outcome: "known_failed" });
    }
    const value = {
      reference: externalReference("huly", "attachment", `attachment-${input.requestId}`),
      taskReference: input.taskReference,
      blobReference: input.blobReference,
      name: input.name,
      contentType: input.contentType,
      size: input.size,
      syncWatermark: "2",
    };
    this.records.set(externalReferenceKey(value.reference), value);
    return value;
  }
  async get(reference: Parameters<TaskFileProjectionPort["get"]>[0]) {
    return this.records.get(externalReferenceKey(reference));
  }
  async remove(reference: Parameters<TaskFileProjectionPort["remove"]>[0]) {
    this.records.delete(externalReferenceKey(reference));
  }
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("TC-SEC-002J real concurrency racing planned-to-active with open provider promises, ambiguous outcome reconciliation and crash/restart across fence duration in Memory and SQLite", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    let currentTime = now;
    const fixture = await createTestPersistence(name, () => currentTime);
    const content = new MemoryAssetContent();

    try {
      await grantProjectMembership(fixture.persistence, tenant, "project-1", principal);

      // =========================================================================
      // 1. Task: Race planned-to-active while tasks.create is in flight
      // =========================================================================
      await executeCreateNode(fixture.persistence, {
        tenantId: tenant, commandId: "task-race-node", idempotencyKey: "task-race-node",
        correlationId: "race-task", principalId: principal, projectId: "project-1", nodeId: "node-race-task",
        parentId: null, title: "race task node", securityDomainId: null, occurredAtUtc: now.toISOString(),
      });
      await new CreateTaskHandler(fixture.persistence, { scheduleCollaborationProjection: true }).execute({
        tenantId: tenant, commandId: "task-race-cmd", idempotencyKey: "task-race-cmd",
        correlationId: "race-task", principalId: principal, projectId: "project-1", nodeId: "node-race-task",
        taskId: "task-race", title: "task racing", assigneePrincipalId: null, requiresAcceptance: false,
        reviewerPrincipalId: null, occurredAtUtc: now.toISOString(),
      });
      await fixture.persistence.transaction(tenant, async (tx) => {
        await insertDomain(tx, "domain-target-task", "node-race-task");
        await tx.securityMigrations.insert(migrationPlan("race-task", "node-race-task", null, "domain-target-task", 1, 2, 2));
      });

      const taskCallStarted = createDeferred();
      const taskCallRelease = createDeferred();
      const racingTasks: TaskProjectionPort = {
        health: async () => "ok",
        create: async (input) => {
          taskCallStarted.resolve();
          await taskCallRelease.promise;
          return {
            reference: externalReference("huly", "task", `task-${input.requestId}`),
            title: input.title,
            status: input.status,
            syncWatermark: "1",
          };
        },
        get: async () => undefined,
        remove: async () => {},
      };

      const taskProcessor = new CollaborationProjectionProcessor({
        persistence: fixture.persistence, assetContent: content, tasks: racingTasks,
        blobs: new FakeBlobProjection(), taskFiles: new FailsOnceTaskFileProjection(), now: () => currentTime,
      });

      const [taskJob] = (await getJobs(fixture.persistence)).filter((j) => j.payload.taskId === "task-race");
      assert.ok(taskJob);

      // Launch projection in background
      const taskProcessPromise = taskProcessor.process(taskJob);
      await taskCallStarted.promise; // Provider call is now in-flight!

      // Attempt to activate migration while task provider call is open -> MUST REFUSE!
      await assert.rejects(
        fixture.persistence.transaction(tenant, async (tx) => {
          const planned = await tx.securityMigrations.get("migration-race-task");
          assert.ok(planned);
          const active = transitionSecurityMigration(planned, "active", currentTime.toISOString());
          await tx.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
        }),
        /SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE/,
        `${name}:task_promise_race_refused`,
      );

      // Resolve provider call and let task projection complete
      taskCallRelease.resolve();
      await taskProcessPromise;

      // After provider completes and fence is released, activation SUCCEEDS!
      await fixture.persistence.transaction(tenant, async (tx) => {
        const planned = await tx.securityMigrations.get("migration-race-task");
        assert.ok(planned);
        const active = transitionSecurityMigration(planned, "active", currentTime.toISOString());
        await tx.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
        await tx.nodes.migrateSecurityOwnership(planned.id, "node-race-task", 1);
        await tx.tasks.migrateSecurityOwnership(planned.id, "task-race", 1);
        const checkpoint = checkpointSecurityMigration(active, {
          cursor: JSON.stringify(["node-race-task", "task", "task-race"]),
          migratedItems: 2,
          occurredAtUtc: currentTime.toISOString(),
        });
        await tx.securityMigrations.saveProgressPreservingPlan(planned.id, checkpoint, active.version);
        const verifying = transitionSecurityMigration(checkpoint, "verifying", currentTime.toISOString());
        await tx.securityMigrations.saveProgressPreservingPlan(planned.id, verifying, checkpoint.version);
      });
      await commitMigrationForTest(fixture.persistence, tenant, "migration-race-task", currentTime.toISOString());
      const committedMigration1 = await fixture.persistence.read(tenant, async (tx) => await tx.securityMigrations.get("migration-race-task"));
      assert.equal(committedMigration1?.state, "committed", `${name}:task_migration_committed`);

      // =========================================================================
      // 2. Asset: Race planned-to-active during blobs.put and taskFiles.attach
      // =========================================================================
      await executeCreateNode(fixture.persistence, {
        tenantId: tenant, commandId: "asset-race-node", idempotencyKey: "asset-race-node",
        correlationId: "race-asset", principalId: principal, projectId: "project-1", nodeId: "node-race-asset",
        parentId: null, title: "race asset node", securityDomainId: null, occurredAtUtc: now.toISOString(),
      });
      await new CreateTaskHandler(fixture.persistence, { scheduleCollaborationProjection: false }).execute({
        tenantId: tenant, commandId: "asset-host-task-cmd", idempotencyKey: "asset-host-task-cmd",
        correlationId: "race-asset", principalId: principal, projectId: "project-1", nodeId: "node-race-asset",
        taskId: "task-for-asset", title: "task for asset", assigneePrincipalId: null, requiresAcceptance: false,
        reviewerPrincipalId: null, occurredAtUtc: now.toISOString(),
      });
      // Pre-seed task projection binding
      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.externalBindings.insert({
          tenantId: tenant,
          id: "binding:collaboration:task:task-for-asset",
          ownerType: "task",
          ownerId: "task-for-asset",
          role: "collaboration_projection",
          reference: externalReference("huly", "task", "huly-task-for-asset"),
          desiredVersion: 1,
          observedVersion: 1,
          syncWatermark: "1",
          syncState: "synced",
          lastError: null,
          version: 1,
          updatedAtUtc: currentTime.toISOString(),
        });
      });

      const assetBytes = new TextEncoder().encode("racing asset content");
      await new AttachTaskAssetHandler(fixture.persistence, content, { scheduleCollaborationProjection: true }).execute({
        tenantId: tenant, commandId: "asset-race-attach-cmd", idempotencyKey: "asset-race-attach-cmd",
        correlationId: "race-asset", principalId: principal, projectId: "project-1", taskId: "task-for-asset",
        assetId: "asset-race", displayName: "racing.txt", contentType: "text/plain",
        bytes: assetBytes, sha256: createHash("sha256").update(assetBytes).digest("hex"),
        occurredAtUtc: currentTime.toISOString(), deadlineAtUtc: new Date(currentTime.getTime() + 60_000).toISOString(),
      });

      await fixture.persistence.transaction(tenant, async (tx) => {
        await insertDomain(tx, "domain-target-asset", "node-race-asset");
        await tx.securityMigrations.insert(migrationPlan("race-asset", "node-race-asset", null, "domain-target-asset", 1, 2, 3));
      });

      const blobCallStarted = createDeferred();
      const blobCallRelease = createDeferred();
      const attachCallStarted = createDeferred();
      const attachCallRelease = createDeferred();

      const racingBlobs: ExternalBlobProjectionPort = {
        health: async () => "ok",
        put: async (input) => {
          blobCallStarted.resolve();
          await blobCallRelease.promise;
          return {
            reference: externalReference("huly", "blob", `blob-${input.requestId}`),
            contentType: input.contentType,
            size: input.bytes.byteLength,
            sha256: input.sha256,
            scanState: "available",
          };
        },
        exists: async () => true,
        remove: async () => {},
      };

      const racingTaskFiles: TaskFileProjectionPort = {
        health: async () => "ok",
        attach: async (input) => {
          attachCallStarted.resolve();
          await attachCallRelease.promise;
          return {
            reference: externalReference("huly", "attachment", `attachment-${input.requestId}`),
            taskReference: input.taskReference,
            blobReference: input.blobReference,
            name: input.name,
            contentType: input.contentType,
            size: input.size,
            syncWatermark: "1",
          };
        },
        get: async () => undefined,
        remove: async () => {},
      };

      const assetProcessor = new CollaborationProjectionProcessor({
        persistence: fixture.persistence, assetContent: content, tasks: new CountingTaskProjection(),
        blobs: racingBlobs, taskFiles: racingTaskFiles, now: () => currentTime,
      });

      const [assetJob] = (await getJobs(fixture.persistence)).filter((j) => j.payload.assetId === "asset-race");
      assert.ok(assetJob);

      const assetProcessPromise = assetProcessor.process(assetJob);

      // Race 2a: While blobs.put is in flight, planned-to-active MUST REFUSE!
      await blobCallStarted.promise;
      await assert.rejects(
        fixture.persistence.transaction(tenant, async (tx) => {
          const planned = await tx.securityMigrations.get("migration-race-asset");
          assert.ok(planned);
          const active = transitionSecurityMigration(planned, "active", currentTime.toISOString());
          await tx.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
        }),
        /SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE/,
        `${name}:blob_promise_race_refused`,
      );
      blobCallRelease.resolve();

      // Race 2b: While taskFiles.attach is in flight, planned-to-active MUST REFUSE!
      await attachCallStarted.promise;
      await assert.rejects(
        fixture.persistence.transaction(tenant, async (tx) => {
          const planned = await tx.securityMigrations.get("migration-race-asset");
          assert.ok(planned);
          const active = transitionSecurityMigration(planned, "active", currentTime.toISOString());
          await tx.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
        }),
        /SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE/,
        `${name}:attach_promise_race_refused`,
      );
      attachCallRelease.resolve();

      await assetProcessPromise;

      // After asset projection completes, activation SUCCEEDS!
      await fixture.persistence.transaction(tenant, async (tx) => {
        const planned = await tx.securityMigrations.get("migration-race-asset");
        assert.ok(planned);
        const active = transitionSecurityMigration(planned, "active", currentTime.toISOString());
        await tx.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
        await tx.nodes.migrateSecurityOwnership(planned.id, "node-race-asset", 1);
        await tx.tasks.migrateSecurityOwnership(planned.id, "task-for-asset", 1);
        const asset = await tx.assets.get("asset-race");
        assert.ok(asset);
        await tx.assets.migrateSecurityOwnership(planned.id, "asset-race", asset.version);
        const checkpoint = checkpointSecurityMigration(active, {
          cursor: JSON.stringify(["node-race-asset", "asset", "asset-race"]),
          migratedItems: 3,
          occurredAtUtc: currentTime.toISOString(),
        });
        await tx.securityMigrations.saveProgressPreservingPlan(planned.id, checkpoint, active.version);
        const verifying = transitionSecurityMigration(checkpoint, "verifying", currentTime.toISOString());
        await tx.securityMigrations.saveProgressPreservingPlan(planned.id, verifying, checkpoint.version);
      });
      await commitMigrationForTest(fixture.persistence, tenant, "migration-race-asset", currentTime.toISOString());
      const committedMigration2 = await fixture.persistence.read(tenant, async (tx) => await tx.securityMigrations.get("migration-race-asset"));
      assert.equal(committedMigration2?.state, "committed", `${name}:asset_migration_committed`);

      // =========================================================================
      // 3. Ambiguous timeout outcome, fence holding past fence expiry, restart & reconciliation
      // =========================================================================
      await executeCreateNode(fixture.persistence, {
        tenantId: tenant, commandId: "ambig-node", idempotencyKey: "ambig-node",
        correlationId: "ambig", principalId: principal, projectId: "project-1", nodeId: "node-ambig",
        parentId: null, title: "ambig node", securityDomainId: null, occurredAtUtc: now.toISOString(),
      });
      await new CreateTaskHandler(fixture.persistence, { scheduleCollaborationProjection: true }).execute({
        tenantId: tenant, commandId: "ambig-task-cmd", idempotencyKey: "ambig-task-cmd",
        correlationId: "ambig", principalId: principal, projectId: "project-1", nodeId: "node-ambig",
        taskId: "task-ambig", title: "task ambiguous", assigneePrincipalId: null, requiresAcceptance: false,
        reviewerPrincipalId: null, occurredAtUtc: now.toISOString(),
      });
      await fixture.persistence.transaction(tenant, async (tx) => {
        await insertDomain(tx, "domain-target-ambig", "node-ambig");
        await tx.securityMigrations.insert(migrationPlan("ambig", "node-ambig", null, "domain-target-ambig", 1, 2));
      });

      let shouldFailAmbig = true;
      const ambigTasks: TaskProjectionPort = {
        health: async () => "ok",
        create: async (input) => {
          if (shouldFailAmbig) {
            throw new IntegrationCallError("HULY_HTTP_504", "ambiguous gateway timeout", { retryable: true, outcome: "ambiguous" });
          }
          return {
            reference: externalReference("huly", "task", `task-${input.requestId}`),
            title: input.title,
            status: input.status,
            syncWatermark: "1",
          };
        },
        get: async () => undefined,
        remove: async () => {},
      };

      const ambigProcessor = new CollaborationProjectionProcessor({
        persistence: fixture.persistence, assetContent: content, tasks: ambigTasks,
        blobs: new FakeBlobProjection(), taskFiles: new FailsOnceTaskFileProjection(), now: () => currentTime,
      });

      const [ambigJob] = (await getJobs(fixture.persistence)).filter((j) => j.payload.taskId === "task-ambig");
      assert.ok(ambigJob);

      // Process and catch ambiguous error
      await assert.rejects(async () => await ambigProcessor.process(ambigJob), /gateway timeout/);

      // Verify operation is recorded in retryable state
      const op = await fixture.persistence.read(tenant, async (tx) => await tx.integrationOperations.get(`op:${ambigJob.id}`));
      assert.equal(op?.state, "retryable", `${name}:op_retryable_after_ambiguous_failure`);

      // Advance clock BEYOND fence duration (+45 seconds)
      currentTime = new Date(currentTime.getTime() + 45_000);

      // Even though fence duration is passed, planned-to-active MUST STILL REFUSE because operation is unresolved!
      await assert.rejects(
        fixture.persistence.transaction(tenant, async (tx) => {
          const planned = await tx.securityMigrations.get("migration-ambig");
          assert.ok(planned);
          const active = transitionSecurityMigration(planned, "active", currentTime.toISOString());
          await tx.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
        }),
        /SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE/,
        `${name}:refused_past_fence_expiry_with_unresolved_op`,
      );

      // In SQLite: Restart connection and verify planned-to-active STILL REFUSES
      if (name === "sqlite" && fixture.sqlitePath) {
        await fixture.persistence.close();
        const reopened = new SqlitePersistence({ path: fixture.sqlitePath, now: () => currentTime });
        try {
          await assert.rejects(
            reopened.transaction(tenant, async (tx) => {
              const planned = await tx.securityMigrations.get("migration-ambig");
              assert.ok(planned);
              const active = transitionSecurityMigration(planned, "active", currentTime.toISOString());
              await tx.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
            }),
            /SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE/,
            "sqlite:reopened_refused_past_expiry_with_unresolved_op",
          );
        } finally {
          await reopened.close();
        }
        const restored = new SqlitePersistence({ path: fixture.sqlitePath, now: () => currentTime });
        (fixture as { persistence: Persistence }).persistence = restored;
      }

      // Now reconcile: retry the operation to success
      shouldFailAmbig = false;
      const reconcileProcessor = new CollaborationProjectionProcessor({
        persistence: fixture.persistence, assetContent: content, tasks: ambigTasks,
        blobs: new FakeBlobProjection(), taskFiles: new FailsOnceTaskFileProjection(), now: () => currentTime,
      });
      const reconcileResult = await reconcileProcessor.process(ambigJob);
      assert.equal(reconcileResult, undefined, `${name}:reconciliation_succeeded`);

      // Verify operation is now completed
      const completedOp = await fixture.persistence.read(tenant, async (tx) => await tx.integrationOperations.get(`op:${ambigJob.id}`));
      assert.equal(completedOp?.state, "completed", `${name}:op_completed`);

      // Now that the operation is completed and fence released, planned-to-active SUCCEEDS!
      await fixture.persistence.transaction(tenant, async (tx) => {
        const planned = await tx.securityMigrations.get("migration-ambig");
        assert.ok(planned);
        const active = transitionSecurityMigration(planned, "active", currentTime.toISOString());
        await tx.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
      });
      const activeMigration3 = await fixture.persistence.read(tenant, async (tx) => await tx.securityMigrations.get("migration-ambig"));
      assert.equal(activeMigration3?.state, "active", `${name}:ambig_migration_activated_after_reconciliation`);

    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-SEC-002J direct Asset matrix: source, target, and outside scope during open migration in Memory and SQLite", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const fixture = await createTestPersistence(name);
    const content = new MemoryAssetContent();
    const blobs = new FakeBlobProjection();
    const taskFiles = new FakeTaskFileProjection();
    const tasks = new CountingTaskProjection();
    try {
      await grantProjectMembership(fixture.persistence, tenant, "project-1", principal);

      await executeCreateNode(fixture.persistence, {
        tenantId: tenant, commandId: "node-source-cmd", idempotencyKey: "node-source-cmd",
        correlationId: "scope-test", principalId: principal, projectId: "project-1", nodeId: "node-1",
        parentId: null, title: "migration root", securityDomainId: null, occurredAtUtc: now.toISOString(),
      });
      await executeCreateNode(fixture.persistence, {
        tenantId: tenant, commandId: "node-outside-cmd", idempotencyKey: "node-outside-cmd",
        correlationId: "scope-test", principalId: principal, projectId: "project-1", nodeId: "node-outside",
        parentId: null, title: "outside root", securityDomainId: null, occurredAtUtc: now.toISOString(),
      });

      await new CreateTaskHandler(fixture.persistence, { scheduleCollaborationProjection: false }).execute({
        tenantId: tenant, commandId: "task-source-cmd", idempotencyKey: "task-source-cmd",
        correlationId: "scope-test", principalId: principal, projectId: "project-1", nodeId: "node-1",
        taskId: "task-source", title: "source task", assigneePrincipalId: null, requiresAcceptance: false,
        reviewerPrincipalId: null, occurredAtUtc: now.toISOString(),
      });
      await new CreateTaskHandler(fixture.persistence, { scheduleCollaborationProjection: false }).execute({
        tenantId: tenant, commandId: "task-outside-cmd", idempotencyKey: "task-outside-cmd",
        correlationId: "scope-test", principalId: principal, projectId: "project-1", nodeId: "node-outside",
        taskId: "task-outside", title: "outside task", assigneePrincipalId: null, requiresAcceptance: false,
        reviewerPrincipalId: null, occurredAtUtc: now.toISOString(),
      });

      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.externalBindings.insert({
          tenantId: tenant, id: "binding:collaboration:task:task-source",
          ownerType: "task", ownerId: "task-source", role: "collaboration_projection",
          reference: externalReference("huly", "task", "huly-task-source"),
          desiredVersion: 1, observedVersion: 1, syncWatermark: "1",
          syncState: "synced", lastError: null, version: 1, updatedAtUtc: now.toISOString(),
        });
        await tx.externalBindings.insert({
          tenantId: tenant, id: "binding:collaboration:task:task-outside",
          ownerType: "task", ownerId: "task-outside", role: "collaboration_projection",
          reference: externalReference("huly", "task", "huly-task-outside"),
          desiredVersion: 1, observedVersion: 1, syncWatermark: "1",
          syncState: "synced", lastError: null, version: 1, updatedAtUtc: now.toISOString(),
        });
      });

      const sourceBytes = new TextEncoder().encode("source asset payload");
      await new AttachTaskAssetHandler(fixture.persistence, content, { scheduleCollaborationProjection: true }).execute({
        tenantId: tenant, commandId: "asset-source-cmd", idempotencyKey: "asset-source-cmd",
        correlationId: "scope-test", principalId: principal, projectId: "project-1", taskId: "task-source",
        assetId: "asset-source", displayName: "source.txt", contentType: "text/plain",
        bytes: sourceBytes, sha256: createHash("sha256").update(sourceBytes).digest("hex"),
        occurredAtUtc: now.toISOString(), deadlineAtUtc: new Date(now.getTime() + 60_000).toISOString(),
      });

      const outsideBytes = new TextEncoder().encode("outside asset payload");
      await new AttachTaskAssetHandler(fixture.persistence, content, { scheduleCollaborationProjection: true }).execute({
        tenantId: tenant, commandId: "asset-outside-cmd", idempotencyKey: "asset-outside-cmd",
        correlationId: "scope-test", principalId: principal, projectId: "project-1", taskId: "task-outside",
        assetId: "asset-outside", displayName: "outside.txt", contentType: "text/plain",
        bytes: outsideBytes, sha256: createHash("sha256").update(outsideBytes).digest("hex"),
        occurredAtUtc: now.toISOString(), deadlineAtUtc: new Date(now.getTime() + 60_000).toISOString(),
      });

      await fixture.persistence.transaction(tenant, async (tx) => {
        await insertDomain(tx, "domain-target", "node-1");
        const planned = migrationPlan("asset-scope", "node-1", null, "domain-target", 1, 2, 3);
        await tx.securityMigrations.insert(planned);
        const active = transitionSecurityMigration(planned, "active", now.toISOString());
        await tx.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
      });

      const processor = new CollaborationProjectionProcessor({
        persistence: fixture.persistence, assetContent: content, tasks,
        blobs, taskFiles, now: () => now,
      });

      const jobs = await getJobs(fixture.persistence);
      const outsideJob = jobs.find((j) => j.payload.assetId === "asset-outside")!;
      const sourceJob = jobs.find((j) => j.payload.assetId === "asset-source")!;
      assert.ok(outsideJob);
      assert.ok(sourceJob);

      // 1. Outside asset job -> SUCCEEDS!
      const outsideResult = await processor.process(outsideJob);
      assert.equal(outsideResult, undefined, `${name}:outside_result`);
      assert.equal(blobs.putCalls, 1, `${name}:outside_blob_put`);
      assert.equal(taskFiles.attachCalls, 1, `${name}:outside_file_attached`);
      const outsideBinding = await fixture.persistence.read(tenant, async (tx) =>
        await tx.externalBindings.getByOwner("asset", "asset-outside", "collaboration_projection"),
      );
      assert.equal(outsideBinding?.syncState, "synced", `${name}:outside_binding_synced`);

      // 2. Source asset job (during active migration) -> DEFERS!
      const sourceResult = await processor.process(sourceJob);
      assert.equal(sourceResult?.outcome, "deferred", `${name}:source_deferred`);
      assert.equal(blobs.putCalls, 1, `${name}:source_no_new_blob_put`);
      assert.equal(taskFiles.attachCalls, 1, `${name}:source_no_new_file_attached`);
      const sourceBinding = await fixture.persistence.read(tenant, async (tx) =>
        await tx.externalBindings.getByOwner("asset", "asset-source", "collaboration_projection"),
      );
      assert.equal(sourceBinding, undefined, `${name}:source_no_binding`);

      // 3. Migrate task and asset to target scope
      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.tasks.migrateSecurityOwnership("migration-asset-scope", "task-source", 1);
        const asset = await tx.assets.get("asset-source");
        assert.ok(asset);
        await tx.assets.migrateSecurityOwnership("migration-asset-scope", "asset-source", asset.version);
      });

      // Target asset job (during active migration) -> ALSO DEFERS!
      const targetResult = await processor.process(sourceJob);
      assert.equal(targetResult?.outcome, "deferred", `${name}:target_scope_deferred`);
      assert.equal(blobs.putCalls, 1, `${name}:target_no_new_blob_put`);
      assert.equal(taskFiles.attachCalls, 1, `${name}:target_no_new_file_attached`);
      const targetBinding = await fixture.persistence.read(tenant, async (tx) =>
        await tx.externalBindings.getByOwner("asset", "asset-source", "collaboration_projection"),
      );
      assert.equal(targetBinding, undefined, `${name}:target_no_binding`);

      // 4. Commit migration: verifying -> committed
      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.nodes.migrateSecurityOwnership("migration-asset-scope", "node-1", 1);
        const active = await tx.securityMigrations.get("migration-asset-scope");
        assert.ok(active);
        const checkpoint = checkpointSecurityMigration(active, {
          cursor: JSON.stringify(["node-1", "asset", "asset-source"]),
          migratedItems: 3,
          occurredAtUtc: now.toISOString(),
        });
        await tx.securityMigrations.saveProgressPreservingPlan(active.id, checkpoint, active.version);
        const verifying = transitionSecurityMigration(checkpoint, "verifying", now.toISOString());
        await tx.securityMigrations.saveProgressPreservingPlan(active.id, verifying, checkpoint.version);
      });
      await commitMigrationForTest(fixture.persistence, tenant, "migration-asset-scope", now.toISOString());

      // After migration committed -> SUCCEEDS!
      const committedResult = await processor.process(sourceJob);
      assert.equal(committedResult, undefined, `${name}:committed_result`);
      assert.equal(blobs.putCalls, 2, `${name}:committed_blob_put`);
      assert.equal(taskFiles.attachCalls, 2, `${name}:committed_file_attached`);
      const committedBinding = await fixture.persistence.read(tenant, async (tx) =>
        await tx.externalBindings.getByOwner("asset", "asset-source", "collaboration_projection"),
      );
      assert.equal(committedBinding?.syncState, "synced", `${name}:committed_binding_synced`);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-SEC-002J direct Asset matrix: planned, committed, and rolled_back states allow projection in Memory and SQLite", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    for (const testState of ["planned", "committed", "rolled_back"] as const) {
      const fixture = await createTestPersistence(name);
      const content = new MemoryAssetContent();
      const blobs = new FakeBlobProjection();
      const taskFiles = new FakeTaskFileProjection();
      const tasks = new CountingTaskProjection();
      try {
        await grantProjectMembership(fixture.persistence, tenant, "project-1", principal);
        await executeCreateNode(fixture.persistence, {
          tenantId: tenant, commandId: `node-${testState}`, idempotencyKey: `node-${testState}`,
          correlationId: testState, principalId: principal, projectId: "project-1", nodeId: "node-1",
          parentId: null, title: "migration node", securityDomainId: null, occurredAtUtc: now.toISOString(),
        });
        await new CreateTaskHandler(fixture.persistence, { scheduleCollaborationProjection: false }).execute({
          tenantId: tenant, commandId: `task-${testState}`, idempotencyKey: `task-${testState}`,
          correlationId: testState, principalId: principal, projectId: "project-1", nodeId: "node-1",
          taskId: "task-1", title: "lifecycle task", assigneePrincipalId: null, requiresAcceptance: false,
          reviewerPrincipalId: null, occurredAtUtc: now.toISOString(),
        });
        await fixture.persistence.transaction(tenant, async (tx) => {
          await tx.externalBindings.insert({
            tenantId: tenant, id: "binding:collaboration:task:task-1",
            ownerType: "task", ownerId: "task-1", role: "collaboration_projection",
            reference: externalReference("huly", "task", "huly-task-1"),
            desiredVersion: 1, observedVersion: 1, syncWatermark: "1",
            syncState: "synced", lastError: null, version: 1, updatedAtUtc: now.toISOString(),
          });
        });

        const assetBytes = new TextEncoder().encode(`asset content for ${testState}`);
        await new AttachTaskAssetHandler(fixture.persistence, content, { scheduleCollaborationProjection: true }).execute({
          tenantId: tenant, commandId: `asset-${testState}`, idempotencyKey: `asset-${testState}`,
          correlationId: testState, principalId: principal, projectId: "project-1", taskId: "task-1",
          assetId: "asset-1", displayName: "lifecycle.txt", contentType: "text/plain",
          bytes: assetBytes, sha256: createHash("sha256").update(assetBytes).digest("hex"),
          occurredAtUtc: now.toISOString(), deadlineAtUtc: new Date(now.getTime() + 60_000).toISOString(),
        });

        await fixture.persistence.transaction(tenant, async (tx) => {
          await insertDomain(tx, "domain-target", "node-1");
          const planned = migrationPlan(testState, "node-1", null, "domain-target", 1, 2, 3);
          await tx.securityMigrations.insert(planned);
          if (testState === "committed") {
            const active = transitionSecurityMigration(planned, "active", now.toISOString());
            await tx.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
            await tx.nodes.migrateSecurityOwnership(planned.id, "node-1", 1);
            await tx.tasks.migrateSecurityOwnership(planned.id, "task-1", 1);
            const asset = await tx.assets.get("asset-1");
            assert.ok(asset);
            await tx.assets.migrateSecurityOwnership(planned.id, "asset-1", asset.version);
            const checkpoint = checkpointSecurityMigration(active, {
              cursor: JSON.stringify(["node-1", "asset", "asset-1"]),
              migratedItems: 3,
              occurredAtUtc: now.toISOString(),
            });
            await tx.securityMigrations.saveProgressPreservingPlan(planned.id, checkpoint, active.version);
            const verifying = transitionSecurityMigration(checkpoint, "verifying", now.toISOString());
            await tx.securityMigrations.saveProgressPreservingPlan(planned.id, verifying, checkpoint.version);
          }
        });

        if (testState === "committed") {
          await commitMigrationForTest(fixture.persistence, tenant, `migration-${testState}`, now.toISOString());
        } else if (testState === "rolled_back") {
          await rollbackMigrationForTest(fixture.persistence, tenant, `migration-${testState}`, now.toISOString());
        }

        const processor = new CollaborationProjectionProcessor({
          persistence: fixture.persistence, assetContent: content, tasks,
          blobs, taskFiles, now: () => now,
        });
        const [job] = (await getJobs(fixture.persistence)).filter((j) => j.jobType === "collaboration.asset.project");
        assert.ok(job);
        const result = await processor.process(job);
        assert.equal(result, undefined, `${name}:${testState}:result_completed`);
        assert.equal(blobs.putCalls, 1, `${name}:${testState}:blob_calls`);
        assert.equal(taskFiles.attachCalls, 1, `${name}:${testState}:file_calls`);

        const binding = await fixture.persistence.read(tenant, async (tx) =>
          await tx.externalBindings.getByOwner("asset", "asset-1", "collaboration_projection"),
        );
        assert.equal(binding?.syncState, "synced", `${name}:${testState}:binding`);
      } finally {
        await fixture.cleanup();
      }
    }
  }
});

test("TC-SEC-002J direct Asset matrix: formal root and intermediate corruption fails closed in Memory and SQLite", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    for (const scenario of [
      "corrupt-epoch",
      "drifted-epoch",
      "nested-domain",
      "invalid-migration-root",
      "missing-formal-root",
      "deleted-formal-root",
      "cross-project-formal-root",
      "unrelated-formal-root",
      "wrong-domain-on-root",
      "wrong-epoch-on-root",
      "corrupt-ancestor-cycle",
      "corrupt-ancestor-deleted",
      "corrupt-ancestor-cross-project",
      "intermediate-public-middle",
      "intermediate-other-domain",
      "intermediate-mismatched-epoch",
    ] as const) {
      const fixture = await createTestPersistence(name);
      const content = new MemoryAssetContent();
      const blobs = new FakeBlobProjection();
      const taskFiles = new FakeTaskFileProjection();
      const tasks = new CountingTaskProjection();
      try {
        await grantProjectMembership(fixture.persistence, tenant, "project-1", principal);
        await fixture.persistence.transaction(tenant, async (transaction) => {
          await transaction.nodes.insert({
            tenantId: tenant, id: "node-1", projectId: "project-1", parentId: null,
            leaderPrincipalId: null,
            title: "node", kind: "work_package", securityDomainId: null, securityEpoch: 1,
            version: 1, deletedAtUtc: null,
          });

          let assetDomain: string | null = null;
          let assetEpoch = 1;
          let assetOwnerNodeId = "node-1";

          if (scenario === "corrupt-epoch") {
            assetEpoch = 0;
          } else if (scenario === "drifted-epoch") {
            assetEpoch = 5;
          } else if (scenario === "nested-domain") {
            await insertDomain(transaction, "parent-domain", "node-1");
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-2", projectId: "project-1", parentId: "node-1",
              leaderPrincipalId: null,
              title: "nested node", kind: "work_package", securityDomainId: "nested-domain", securityEpoch: 1,
              version: 1, deletedAtUtc: null,
            });
            await transaction.securityDomains.insert({
              tenantId: tenant, id: "nested-domain", projectId: "project-1", rootNodeId: "node-2",
              parentSecurityDomainId: "parent-domain", permissionVersion: 1, version: 1,
              createdByPrincipalId: principal, createdAtUtc: now.toISOString(), deletedAtUtc: null,
            });
            assetDomain = "nested-domain";
            assetOwnerNodeId = "node-2";
          } else if (scenario === "invalid-migration-root") {
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-deleted", projectId: "project-1", parentId: null,
              leaderPrincipalId: null,
              title: "deleted root", kind: "work_package", securityDomainId: null, securityEpoch: 1,
              version: 1, deletedAtUtc: now.toISOString(),
            });
            await insertDomain(transaction, "domain-target", "node-1");
            const planned = migrationPlan("invalid-root", "node-deleted");
            await transaction.securityMigrations.insert(planned);
            const active = transitionSecurityMigration(planned, "active", now.toISOString());
            await transaction.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
          } else if (scenario === "missing-formal-root") {
            if (name === "sqlite") {
              await assert.rejects(
                transaction.securityDomains.insert({
                  tenantId: tenant, id: "missing-domain", projectId: "project-1", rootNodeId: "node-nonexistent",
                  parentSecurityDomainId: null, permissionVersion: 1, version: 1, createdByPrincipalId: principal,
                  createdAtUtc: now.toISOString(), deletedAtUtc: null,
                }),
                /FOREIGN KEY constraint failed|constraint failed/i,
              );
              return;
            }
            await transaction.securityDomains.insert({
              tenantId: tenant, id: "missing-domain", projectId: "project-1", rootNodeId: "node-nonexistent",
              parentSecurityDomainId: null, permissionVersion: 1, version: 1, createdByPrincipalId: principal,
              createdAtUtc: now.toISOString(), deletedAtUtc: null,
            });
            assetDomain = "missing-domain";
          } else if (scenario === "deleted-formal-root") {
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-del-root", projectId: "project-1", parentId: null,
              leaderPrincipalId: null,
              title: "del root", kind: "work_package", securityDomainId: "del-domain", securityEpoch: 1,
              version: 1, deletedAtUtc: now.toISOString(),
            });
            await transaction.securityDomains.insert({
              tenantId: tenant, id: "del-domain", projectId: "project-1", rootNodeId: "node-del-root",
              parentSecurityDomainId: null, permissionVersion: 1, version: 1, createdByPrincipalId: principal,
              createdAtUtc: now.toISOString(), deletedAtUtc: null,
            });
            assetDomain = "del-domain";
            assetOwnerNodeId = "node-del-root";
          } else if (scenario === "cross-project-formal-root") {
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-other-proj", projectId: "project-other", parentId: null,
              leaderPrincipalId: null,
              title: "other proj node", kind: "work_package", securityDomainId: "cross-domain", securityEpoch: 1,
              version: 1, deletedAtUtc: null,
            });
            await transaction.securityDomains.insert({
              tenantId: tenant, id: "cross-domain", projectId: "project-1", rootNodeId: "node-other-proj",
              parentSecurityDomainId: null, permissionVersion: 1, version: 1, createdByPrincipalId: principal,
              createdAtUtc: now.toISOString(), deletedAtUtc: null,
            });
            assetDomain = "cross-domain";
          } else if (scenario === "unrelated-formal-root") {
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-unrelated-root", projectId: "project-1", parentId: null,
              leaderPrincipalId: null,
              title: "unrelated root", kind: "work_package", securityDomainId: "unrelated-domain", securityEpoch: 1,
              version: 1, deletedAtUtc: null,
            });
            await transaction.securityDomains.insert({
              tenantId: tenant, id: "unrelated-domain", projectId: "project-1", rootNodeId: "node-unrelated-root",
              parentSecurityDomainId: null, permissionVersion: 1, version: 1, createdByPrincipalId: principal,
              createdAtUtc: now.toISOString(), deletedAtUtc: null,
            });
            assetDomain = "unrelated-domain";
            assetOwnerNodeId = "node-1";
          } else if (scenario === "wrong-domain-on-root") {
            await transaction.securityDomains.insert({
              tenantId: tenant, id: "wrong-domain", projectId: "project-1", rootNodeId: "node-1",
              parentSecurityDomainId: null, permissionVersion: 1, version: 1, createdByPrincipalId: principal,
              createdAtUtc: now.toISOString(), deletedAtUtc: null,
            });
            assetDomain = "wrong-domain";
            assetOwnerNodeId = "node-1";
          } else if (scenario === "wrong-epoch-on-root") {
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-epoch-root", projectId: "project-1", parentId: null,
              leaderPrincipalId: null,
              title: "epoch root", kind: "work_package", securityDomainId: "epoch-domain", securityEpoch: 3,
              version: 1, deletedAtUtc: null,
            });
            await transaction.securityDomains.insert({
              tenantId: tenant, id: "epoch-domain", projectId: "project-1", rootNodeId: "node-epoch-root",
              parentSecurityDomainId: null, permissionVersion: 1, version: 1, createdByPrincipalId: principal,
              createdAtUtc: now.toISOString(), deletedAtUtc: null,
            });
            assetDomain = "epoch-domain";
            assetOwnerNodeId = "node-epoch-root";
            assetEpoch = 1;
          } else if (scenario === "corrupt-ancestor-cycle") {
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-cycle-a", projectId: "project-1", parentId: "node-cycle-b",
              leaderPrincipalId: null,
              title: "cycle a", kind: "work_package", securityDomainId: null, securityEpoch: 1,
              version: 1, deletedAtUtc: null,
            });
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-cycle-b", projectId: "project-1", parentId: "node-cycle-a",
              leaderPrincipalId: null,
              title: "cycle b", kind: "work_package", securityDomainId: null, securityEpoch: 1,
              version: 1, deletedAtUtc: null,
            });
            assetOwnerNodeId = "node-cycle-a";
          } else if (scenario === "corrupt-ancestor-deleted") {
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-parent-del", projectId: "project-1", parentId: null,
              leaderPrincipalId: null,
              title: "parent del", kind: "work_package", securityDomainId: null, securityEpoch: 1,
              version: 1, deletedAtUtc: now.toISOString(),
            });
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-child-live", projectId: "project-1", parentId: "node-parent-del",
              leaderPrincipalId: null,
              title: "child live", kind: "work_package", securityDomainId: null, securityEpoch: 1,
              version: 1, deletedAtUtc: null,
            });
            assetOwnerNodeId = "node-child-live";
          } else if (scenario === "corrupt-ancestor-cross-project") {
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-parent-other", projectId: "project-other", parentId: null,
              leaderPrincipalId: null,
              title: "parent other", kind: "work_package", securityDomainId: null, securityEpoch: 1,
              version: 1, deletedAtUtc: null,
            });
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-child-proj1", projectId: "project-1", parentId: "node-parent-other",
              leaderPrincipalId: null,
              title: "child proj1", kind: "work_package", securityDomainId: null, securityEpoch: 1,
              version: 1, deletedAtUtc: null,
            });
            assetOwnerNodeId = "node-child-proj1";
          } else if (scenario === "intermediate-public-middle") {
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-cont-root", projectId: "project-1", parentId: null,
              leaderPrincipalId: null,
              title: "cont root", kind: "work_package", securityDomainId: "domain-cont", securityEpoch: 2,
              version: 1, deletedAtUtc: null,
            });
            await insertDomain(transaction, "domain-cont", "node-cont-root");
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-mid-public", projectId: "project-1", parentId: "node-cont-root",
              leaderPrincipalId: null,
              title: "mid public", kind: "work_package", securityDomainId: null, securityEpoch: 2,
              version: 1, deletedAtUtc: null,
            });
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-leaf-asset", projectId: "project-1", parentId: "node-mid-public",
              leaderPrincipalId: null,
              title: "leaf asset", kind: "work_package", securityDomainId: "domain-cont", securityEpoch: 2,
              version: 1, deletedAtUtc: null,
            });
            assetDomain = "domain-cont";
            assetOwnerNodeId = "node-leaf-asset";
            assetEpoch = 2;
          } else if (scenario === "intermediate-other-domain") {
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-cont-root", projectId: "project-1", parentId: null,
              leaderPrincipalId: null,
              title: "cont root", kind: "work_package", securityDomainId: "domain-cont-1", securityEpoch: 2,
              version: 1, deletedAtUtc: null,
            });
            await insertDomain(transaction, "domain-cont-1", "node-cont-root");
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-other-root", projectId: "project-1", parentId: null,
              leaderPrincipalId: null,
              title: "other root", kind: "work_package", securityDomainId: "domain-cont-2", securityEpoch: 2,
              version: 1, deletedAtUtc: null,
            });
            await insertDomain(transaction, "domain-cont-2", "node-other-root");
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-mid-other", projectId: "project-1", parentId: "node-cont-root",
              leaderPrincipalId: null,
              title: "mid other", kind: "work_package", securityDomainId: "domain-cont-2", securityEpoch: 2,
              version: 1, deletedAtUtc: null,
            });
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-leaf-asset", projectId: "project-1", parentId: "node-mid-other",
              leaderPrincipalId: null,
              title: "leaf asset", kind: "work_package", securityDomainId: "domain-cont-1", securityEpoch: 2,
              version: 1, deletedAtUtc: null,
            });
            assetDomain = "domain-cont-1";
            assetOwnerNodeId = "node-leaf-asset";
            assetEpoch = 2;
          } else if (scenario === "intermediate-mismatched-epoch") {
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-cont-root", projectId: "project-1", parentId: null,
              leaderPrincipalId: null,
              title: "cont root", kind: "work_package", securityDomainId: "domain-cont", securityEpoch: 2,
              version: 1, deletedAtUtc: null,
            });
            await insertDomain(transaction, "domain-cont", "node-cont-root");
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-mid-mismatch", projectId: "project-1", parentId: "node-cont-root",
              leaderPrincipalId: null,
              title: "mid mismatch", kind: "work_package", securityDomainId: "domain-cont", securityEpoch: 1,
              version: 1, deletedAtUtc: null,
            });
            await transaction.nodes.insert({
              tenantId: tenant, id: "node-leaf-asset", projectId: "project-1", parentId: "node-mid-mismatch",
              leaderPrincipalId: null,
              title: "leaf asset", kind: "work_package", securityDomainId: "domain-cont", securityEpoch: 2,
              version: 1, deletedAtUtc: null,
            });
            assetDomain = "domain-cont";
            assetOwnerNodeId = "node-leaf-asset";
            assetEpoch = 2;
          }

          await transaction.tasks.insert({
            tenantId: tenant,
            id: "task-1",
            projectId: "project-1",
            ownerNodeId: assetOwnerNodeId,
            title: "task for asset",
            executionState: "todo",
            reviewState: "not_required",
            assigneePrincipalId: null,
            reviewerPrincipalId: null,
            requiresAcceptance: false,
            securityDomainId: assetDomain,
            securityEpoch: assetEpoch,
            version: 1,
            deletedAtUtc: null,
          });

          await transaction.externalBindings.insert({
            tenantId: tenant,
            id: "binding:collaboration:task:task-1",
            ownerType: "task",
            ownerId: "task-1",
            role: "collaboration_projection",
            reference: externalReference("huly", "task", "huly-task-1"),
            desiredVersion: 1,
            observedVersion: 1,
            syncWatermark: "1",
            syncState: "synced",
            lastError: null,
            version: 1,
            updatedAtUtc: now.toISOString(),
          });

          const bytes = new TextEncoder().encode("asset corruption test bytes");
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          const storedContent = await content.put({
            tenantId: tenant,
            requestId: `req-${scenario}`,
            contentType: "text/plain",
            bytes,
            sha256,
          });

          await transaction.assets.insert({
            tenantId: tenant,
            id: "asset-1",
            projectId: "project-1",
            ownerNodeId: assetOwnerNodeId,
            uploaderPrincipalId: principal,
            failureCode: null,
            displayName: "asset-corrupt.txt",
            contentType: "text/plain",
            size: bytes.byteLength,
            sha256,
            lifecycleState: "available",
            securityDomainId: assetDomain,
            securityEpoch: assetEpoch,
            version: 1,
            deletedAtUtc: null,
          });

          await transaction.assets.insertBinding({
            tenantId: tenant,
            id: "binding:asset-1:task-1",
            assetId: "asset-1",
            targetType: "task",
            targetId: "task-1",
            purpose: "attachment",
            version: 1,
            invalidatedAtUtc: null,
          });

          await transaction.externalBindings.insert({
            tenantId: tenant,
            id: "binding:blob:asset-1",
            ownerType: "asset",
            ownerId: "asset-1",
            role: "blob_replica",
            reference: storedContent.reference,
            desiredVersion: 1,
            observedVersion: 1,
            syncWatermark: "1",
            syncState: "synced",
            lastError: null,
            version: 1,
            updatedAtUtc: now.toISOString(),
          });

          await transaction.jobs.schedule({
            tenantId: tenant,
            id: "job-asset-1",
            jobType: "collaboration.asset.project",
            dedupeKey: "job-asset-1",
            payload: { assetId: "asset-1", taskId: "task-1", desiredVersion: 1 },
            state: "pending",
            priority: 1,
            availableAtUtc: now.toISOString(),
            attempts: 0,
            maxAttempts: 5,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAtUtc: null,
            lastError: null,
            completedAtUtc: null,
            createdAtUtc: now.toISOString(),
          });
        });

        const processor = new CollaborationProjectionProcessor({
          persistence: fixture.persistence, assetContent: content, tasks,
          blobs, taskFiles, now: () => now,
        });

        const [job] = (await getJobs(fixture.persistence)).filter((j) => j.jobType === "collaboration.asset.project");
        if (scenario === "missing-formal-root" && name === "sqlite") {
          assert.equal(job, undefined);
          return;
        }
        assert.ok(job);
        const result = await processor.process(job);
        assert.equal(result?.outcome, "deferred", `${name}:${scenario}:defers`);
        assert.equal(blobs.putCalls, 0, `${name}:${scenario}:zero_blob_calls`);
        assert.equal(taskFiles.attachCalls, 0, `${name}:${scenario}:zero_attach_calls`);
        const binding = await fixture.persistence.read(tenant, async (tx) =>
          await tx.externalBindings.getByOwner("asset", "asset-1", "collaboration_projection"),
        );
        assert.equal(binding, undefined, `${name}:${scenario}:no_external_binding`);
      } finally {
        await fixture.cleanup();
      }
    }
  }
});

test("TC-SEC-002J direct Asset matrix: defer preserves previous attempts, lastError, and avoids dead letter in Memory and SQLite", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const fixture = await createTestPersistence(name);
    const content = new MemoryAssetContent();
    let blobShouldFail = true;
    let blobPutCalls = 0;
    const controllableBlobs: ExternalBlobProjectionPort = {
      health: async () => "ok",
      put: async (input) => {
        blobPutCalls += 1;
        if (blobShouldFail) {
          throw new IntegrationCallError("HULY_HTTP_504", "blob gateway timeout", { retryable: true, outcome: "known_failed" });
        }
        return {
          reference: externalReference("huly", "blob", `blob-${input.requestId}`),
          contentType: input.contentType,
          size: input.bytes.byteLength,
          sha256: input.sha256,
          scanState: "available",
        };
      },
      exists: async () => false,
      remove: async () => {},
    };
    const taskFiles = new FakeTaskFileProjection();
    const tasks = new CountingTaskProjection();

    try {
      await grantProjectMembership(fixture.persistence, tenant, "project-1", principal);

      await executeCreateNode(fixture.persistence, {
        tenantId: tenant, commandId: "asset-defer-node", idempotencyKey: "asset-defer-node",
        correlationId: "defer-test", principalId: principal, projectId: "project-1", nodeId: "node-1",
        parentId: null, title: "node", securityDomainId: null, occurredAtUtc: now.toISOString(),
      });

      await new CreateTaskHandler(fixture.persistence, { scheduleCollaborationProjection: false }).execute({
        tenantId: tenant, commandId: "asset-defer-task", idempotencyKey: "asset-defer-task",
        correlationId: "defer-test", principalId: principal, projectId: "project-1", nodeId: "node-1",
        taskId: "task-1", title: "task for defer asset", assigneePrincipalId: null, requiresAcceptance: false,
        reviewerPrincipalId: null, occurredAtUtc: now.toISOString(),
      });

      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.externalBindings.insert({
          tenantId: tenant, id: "binding:collaboration:task:task-1",
          ownerType: "task", ownerId: "task-1", role: "collaboration_projection",
          reference: externalReference("huly", "task", "huly-task-1"),
          desiredVersion: 1, observedVersion: 1, syncWatermark: "1",
          syncState: "synced", lastError: null, version: 1, updatedAtUtc: now.toISOString(),
        });
      });

      const assetBytes = new TextEncoder().encode("defer test payload");
      await new AttachTaskAssetHandler(fixture.persistence, content, { scheduleCollaborationProjection: false }).execute({
        tenantId: tenant, commandId: "asset-defer-attach", idempotencyKey: "asset-defer-attach",
        correlationId: "defer-test", principalId: principal, projectId: "project-1", taskId: "task-1",
        assetId: "asset-1", displayName: "defer.txt", contentType: "text/plain",
        bytes: assetBytes, sha256: createHash("sha256").update(assetBytes).digest("hex"),
        occurredAtUtc: now.toISOString(), deadlineAtUtc: new Date(now.getTime() + 60_000).toISOString(),
      });

      // Schedule job with maxAttempts = 2
      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.jobs.schedule({
          tenantId: tenant,
          id: "job:collaboration-asset:asset-1:v1",
          jobType: "collaboration.asset.project",
          dedupeKey: "asset-1:v1",
          payload: { assetId: "asset-1", taskId: "task-1", desiredVersion: 1 },
          state: "pending",
          priority: 40,
          availableAtUtc: now.toISOString(),
          attempts: 0,
          maxAttempts: 2,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAtUtc: null,
          lastError: null,
          completedAtUtc: null,
          createdAtUtc: now.toISOString(),
        });
      });

      // 1. Run cycle with failing provider call -> attempts becomes 1, lastError set to blob gateway timeout
      const failingProcessor = new CollaborationProjectionProcessor({
        persistence: fixture.persistence, assetContent: content, tasks,
        blobs: controllableBlobs, taskFiles, now: () => now,
      });
      await runWorkerCycle({
        outbox: fixture.persistence.outboxConsumer, jobs: fixture.persistence.jobConsumer,
        processJob: async (job) => await failingProcessor.process(job),
      }, { workerId: "worker-asset-failing", now: () => now });

      const [initialJob] = await getJobs(fixture.persistence);
      assert.equal(initialJob?.attempts, 1, `${name}:attempts_after_failure`);
      assert.match(String(initialJob?.lastError), /blob gateway timeout/, `${name}:last_error_after_failure`);
      assert.equal(initialJob?.state, "pending", `${name}:pending_state_after_failure`);

      // 2. Verify planned-to-active refuses while asset operation is unresolved / fence active
      await fixture.persistence.transaction(tenant, async (tx) => {
        await insertDomain(tx, "domain-target", "node-1");
        const planned = migrationPlan("asset-defer-preserve", "node-1", null, "domain-target", 1, 2, 3);
        await tx.securityMigrations.insert(planned);
      });
      await assert.rejects(
        fixture.persistence.transaction(tenant, async (tx) => {
          const planned = await tx.securityMigrations.get("migration-asset-defer-preserve");
          assert.ok(planned);
          const active = transitionSecurityMigration(planned, "active", now.toISOString());
          await tx.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
        }),
        /SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE/,
        `${name}:refuses_activation_with_unresolved_asset_op`,
      );

      // Compensate prior failed operation and release fence so migration can be activated
      await fixture.persistence.transaction(tenant, async (tx) => {
        const op = await tx.integrationOperations.get("op:job:collaboration-asset:asset-1:v1");
        if (op) {
          await tx.integrationOperations.update({
            ...op,
            state: "compensated",
            version: op.version + 1,
          }, op.version);
        }
        if (op?.leaseToken) {
          await tx.outboundProjectionFences.release("fence:asset:asset-1", op.leaseToken);
        }
        const planned = await tx.securityMigrations.get("migration-asset-defer-preserve");
        assert.ok(planned);
        const active = transitionSecurityMigration(planned, "active", now.toISOString());
        await tx.securityMigrations.saveProgressPreservingPlan(planned.id, active, planned.version);
      });

      // 3. Process deferred under active migration: worker claims it (attempts would be 2 = maxAttempts),
      // but defer restores attempts to 1 and does NOT dead-letter!
      const time2 = new Date(now.getTime() + 10_000);
      const deferProcessor = new CollaborationProjectionProcessor({
        persistence: fixture.persistence, assetContent: content, tasks,
        blobs: controllableBlobs, taskFiles, now: () => time2,
      });
      await runWorkerCycle({
        outbox: fixture.persistence.outboxConsumer, jobs: fixture.persistence.jobConsumer,
        processJob: async (job) => await deferProcessor.process(job),
      }, { workerId: "worker-asset-defer", now: () => time2 });

      const [deferredJob] = await getJobs(fixture.persistence);
      assert.equal(deferredJob?.state, "pending", `${name}:deferred_state_is_pending`);
      assert.equal(deferredJob?.attempts, 1, `${name}:attempts_restored_not_consumed`);
      assert.match(String(deferredJob?.lastError), /blob gateway timeout/, `${name}:last_error_preserved`);

      // 4. Migrate and commit migration
      await fixture.persistence.transaction(tenant, async (tx) => {
        const active = await tx.securityMigrations.get("migration-asset-defer-preserve");
        assert.ok(active);
        await tx.nodes.migrateSecurityOwnership(active.id, "node-1", 1);
        await tx.tasks.migrateSecurityOwnership(active.id, "task-1", 1);
        const asset = await tx.assets.get("asset-1");
        assert.ok(asset);
        await tx.assets.migrateSecurityOwnership(active.id, "asset-1", asset.version);
        const checkpoint = checkpointSecurityMigration(active, {
          cursor: JSON.stringify(["node-1", "asset", "asset-1"]),
          migratedItems: 3,
          occurredAtUtc: time2.toISOString(),
        });
        await tx.securityMigrations.saveProgressPreservingPlan(active.id, checkpoint, active.version);
        const verifying = transitionSecurityMigration(checkpoint, "verifying", time2.toISOString());
        await tx.securityMigrations.saveProgressPreservingPlan(active.id, verifying, checkpoint.version);
      });
      await commitMigrationForTest(fixture.persistence, tenant, "migration-asset-defer-preserve", time2.toISOString());

      // Reset operation to retryable so the deferred job can retry to completion under new epoch
      await fixture.persistence.transaction(tenant, async (tx) => {
        const op = await tx.integrationOperations.get("op:job:collaboration-asset:asset-1:v1");
        if (op) {
          await tx.integrationOperations.update({
            ...op,
            state: "retryable",
            version: op.version + 1,
          }, op.version);
        }
      });

      // 5. Advance clock past deferral delay (+70s), enable successful blob put, run worker cycle
      const time3 = new Date(time2.getTime() + 70_000);
      blobShouldFail = false;
      const successProcessor = new CollaborationProjectionProcessor({
        persistence: fixture.persistence, assetContent: content, tasks,
        blobs: controllableBlobs, taskFiles, now: () => time3,
      });
      await runWorkerCycle({
        outbox: fixture.persistence.outboxConsumer, jobs: fixture.persistence.jobConsumer,
        processJob: async (job) => await successProcessor.process(job),
      }, { workerId: "worker-asset-success", now: () => time3 });

      const [completedJob] = await getJobs(fixture.persistence);
      assert.equal(completedJob?.state, "completed", `${name}:completed_state`);
      assert.equal(blobPutCalls, 2, `${name}:blob_put_succeeded`);
      assert.equal(taskFiles.attachCalls, 1, `${name}:file_attached_succeeded`);

      const binding = await fixture.persistence.read(tenant, async (tx) =>
        await tx.externalBindings.getByOwner("asset", "asset-1", "collaboration_projection"),
      );
      assert.equal(binding?.syncState, "synced", `${name}:final_binding_synced`);
    } finally {
      await fixture.cleanup();
    }
  }
});
