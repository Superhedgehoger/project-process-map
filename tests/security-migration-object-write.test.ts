import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import type { Persistence } from "../packages/application/src/ports/persistence.ts";
import type { Asset } from "../packages/domain/src/assets.ts";
import { principalId, tenantId } from "../packages/domain/src/identity.ts";
import type { ProjectNode } from "../packages/domain/src/project-structure.ts";
import { transitionSecurityMigration, type SecurityDomainMigration } from "../packages/domain/src/security-migration.ts";
import type { ProductTask } from "../packages/domain/src/tasks.ts";

const tenant = tenantId("tenant-migration-write");
const projectId = "migration-write-project";
const sourceDomainId = "domain-source";

type Fixture = Readonly<{
  name: "memory" | "sqlite";
  persistence: Persistence;
  path: string | null;
  cleanup(): Promise<void>;
}>;

async function fixture(name: "memory" | "sqlite"): Promise<Fixture> {
  if (name === "memory") {
    const persistence = new MemoryPersistence();
    return { name, persistence, path: null, cleanup: async () => await persistence.close() };
  }
  const directory = await mkdtemp(join(tmpdir(), "ppm-migration-write-"));
  const path = join(directory, "migration.sqlite");
  const persistence = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
  return {
    name,
    persistence,
    path,
    cleanup: async () => { await persistence.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

function node(id: string, parentId: string | null, overrides: Partial<ProjectNode> = {}): ProjectNode {
  return {
    tenantId: tenant,
    id,
    projectId,
    parentId,
    leaderPrincipalId: null,
    title: id,
    kind: "work_package",
    securityDomainId: sourceDomainId,
    securityEpoch: 1,
    version: 1,
    deletedAtUtc: null,
    ...overrides,
  };
}

function task(id: string, ownerNodeId: string, overrides: Partial<ProductTask> = {}): ProductTask {
  return {
    tenantId: tenant,
    id,
    projectId,
    ownerNodeId,
    securityDomainId: sourceDomainId,
    securityEpoch: 1,
    title: id,
    assigneePrincipalId: principalId("migration-assignee"),
    requiresAcceptance: true,
    reviewerPrincipalId: principalId("migration-reviewer"),
    executionState: "in_progress",
    reviewState: "not_submitted",
    version: 1,
    deletedAtUtc: null,
    ...overrides,
  };
}

function asset(id: string, ownerNodeId: string, overrides: Partial<Asset> = {}): Asset {
  return {
    tenantId: tenant,
    id,
    projectId,
    ownerNodeId,
    securityDomainId: sourceDomainId,
    securityEpoch: 1,
    uploaderPrincipalId: principalId("migration-uploader"),
    displayName: `${id}.txt`,
    contentType: "text/plain",
    size: 8,
    sha256: "a".repeat(64),
    lifecycleState: "available",
    failureCode: null,
    version: 1,
    deletedAtUtc: null,
    ...overrides,
  };
}

function plannedMigration(targetSecurityDomainId: string | null, overrides: Partial<SecurityDomainMigration> = {}): SecurityDomainMigration {
  return {
    tenantId: tenant,
    id: "migration-write",
    projectId,
    rootNodeId: "root",
    sourceSecurityDomainId: sourceDomainId,
    targetSecurityDomainId,
    hierarchyRevision: 1,
    sourceSecurityEpoch: 1,
    targetSecurityEpoch: 2,
    state: "planned",
    cursor: null,
    totalItems: 5,
    migratedItems: 0,
    failure: null,
    nextAttemptAtUtc: null,
    deadlineAtUtc: "2026-09-10T00:00:00.000Z",
    version: 1,
    createdAtUtc: "2026-09-09T12:00:00.000Z",
    updatedAtUtc: "2026-09-09T12:00:00.000Z",
    ...overrides,
  };
}

async function prepare(
  persistence: Persistence,
  targetSecurityDomainId: string | null,
  migrationState: "planned" | "active" = "active",
  taskOverrides: Partial<ProductTask> = {},
): Promise<SecurityDomainMigration> {
  const planned = plannedMigration(targetSecurityDomainId);
  const migration = migrationState === "active"
    ? transitionSecurityMigration(planned, "active", "2026-09-09T12:01:00.000Z")
    : planned;
  await persistence.transaction(tenant, async (transaction) => {
    for (const current of [
      node("root", null),
      node("child", "root", { deletedAtUtc: "2026-09-09T12:02:00.000Z" }),
      node("outside", null),
    ]) await transaction.nodes.insert(current);
    await transaction.tasks.insert(task("task-child", "child", taskOverrides));
    await transaction.tasks.insert(task("task-outside", "outside"));
    await transaction.assets.insert(asset("asset-child", "child"));
    await transaction.assets.insert(asset("asset-outside", "outside"));
    await transaction.securityMigrations.insert(planned);
    if (migration.state === "active") {
      await transaction.securityMigrations.saveProgressPreservingPlan(migration.id, migration, planned.version);
    }
  });
  return migration;
}

test("TC-SEC-002E migration-only ports change only security ownership and version", async () => {
  for (const targetSecurityDomainId of ["domain-target", null] as const) {
    for (const name of ["memory", "sqlite"] as const) {
      const current = await fixture(name);
      try {
        const migration = await prepare(current.persistence, targetSecurityDomainId);
        const originalNode = node("child", "root", { deletedAtUtc: "2026-09-09T12:02:00.000Z" });
        const originalTask = task("task-child", "child");
        const originalAsset = asset("asset-child", "child");
        const changed = await current.persistence.transaction(tenant, async (transaction) => ({
          node: await transaction.nodes.migrateSecurityOwnership(migration.id, originalNode.id, originalNode.version),
          task: await transaction.tasks.migrateSecurityOwnership(migration.id, originalTask.id, originalTask.version),
          asset: await transaction.assets.migrateSecurityOwnership(migration.id, originalAsset.id, originalAsset.version),
        }));
        assert.deepEqual(changed.node, { ...originalNode, securityDomainId: targetSecurityDomainId, securityEpoch: 2, version: 2 }, name);
        assert.deepEqual(changed.task, { ...originalTask, securityDomainId: targetSecurityDomainId, securityEpoch: 2, version: 2 }, name);
        assert.deepEqual(changed.asset, { ...originalAsset, securityDomainId: targetSecurityDomainId, securityEpoch: 2, version: 2 }, name);
      } finally {
        await current.cleanup();
      }
    }
  }
});

test("TC-SEC-002E invalid migration writes are caught without partial object changes", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      const migration = await prepare(current.persistence, "domain-target");
      await current.persistence.transaction(tenant, async (transaction) => {
        await assert.rejects(
          transaction.nodes.migrateSecurityOwnership(migration.id, "child", 99),
          /NODE_VERSION_CONFLICT/,
        );
        await assert.rejects(
          transaction.tasks.migrateSecurityOwnership(migration.id, "task-child", 99),
          /TASK_VERSION_CONFLICT/,
        );
        await assert.rejects(
          transaction.assets.migrateSecurityOwnership(migration.id, "asset-child", 99),
          /ASSET_VERSION_CONFLICT/,
        );
        await assert.rejects(
          transaction.tasks.migrateSecurityOwnership("missing-migration", "task-child", 1),
          /SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE/,
        );
        await assert.rejects(transaction.nodes.migrateSecurityOwnership(migration.id, "missing-node", 1), /NODE_NOT_FOUND/);
        await assert.rejects(
          transaction.assets.migrateSecurityOwnership(migration.id, "asset-outside", 1),
          /SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE/,
        );
        await assert.rejects(
          transaction.nodes.migrateSecurityOwnership(migration.id, "outside", 1),
          /SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE/,
        );
        await assert.rejects(
          transaction.tasks.migrateSecurityOwnership(migration.id, "task-outside", 1),
          /SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE/,
        );
        await assert.rejects(
          transaction.tasks.migrateSecurityOwnership(migration.id, "missing-task", 1),
          /TASK_NOT_FOUND/,
        );
        await assert.rejects(transaction.assets.migrateSecurityOwnership(migration.id, "missing-asset", 1), /ASSET_NOT_FOUND/);
      });
      const unchanged = await current.persistence.read(tenant, async (transaction) => ({
        node: await transaction.nodes.get("child"),
        task: await transaction.tasks.get("task-child"),
        asset: await transaction.assets.get("asset-outside"),
      }));
      assert.deepEqual(unchanged.node, node("child", "root", { deletedAtUtc: "2026-09-09T12:02:00.000Z" }), name);
      assert.deepEqual(unchanged.task, task("task-child", "child"), name);
      assert.deepEqual(unchanged.asset, asset("asset-outside", "outside"), name);

      const migrated = await current.persistence.transaction(tenant, async (transaction) => ({
        node: await transaction.nodes.migrateSecurityOwnership(migration.id, "child", 1),
        task: await transaction.tasks.migrateSecurityOwnership(migration.id, "task-child", 1),
        asset: await transaction.assets.migrateSecurityOwnership(migration.id, "asset-child", 1),
      }));
      await assert.rejects(current.persistence.transaction(tenant, async (transaction) => {
        await transaction.nodes.migrateSecurityOwnership(migration.id, migrated.node.id, migrated.node.version);
      }), /SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE/, `${name}:node-already-target`);
      await assert.rejects(current.persistence.transaction(tenant, async (transaction) => {
        await transaction.tasks.migrateSecurityOwnership(migration.id, migrated.task.id, migrated.task.version);
      }), /SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE/, `${name}:task-already-target`);
      await assert.rejects(current.persistence.transaction(tenant, async (transaction) => {
        await transaction.assets.migrateSecurityOwnership(migration.id, migrated.asset.id, migrated.asset.version);
      }), /SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE/, `${name}:asset-already-target`);
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002E a non-active or wrong-source migration cannot change an object", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    for (const scenario of ["planned", "wrong-source", "wrong-project"] as const) {
      const current = await fixture(name);
      try {
        const migration = await prepare(
          current.persistence,
          "domain-target",
          scenario === "planned" ? "planned" : "active",
          scenario === "wrong-source" ? { securityEpoch: 9 }
            : scenario === "wrong-project" ? { projectId: "other-project" } : {},
        );
        await assert.rejects(current.persistence.transaction(tenant, async (transaction) => {
          await transaction.tasks.migrateSecurityOwnership(migration.id, "task-child", 1);
        }), /SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE/);
      } finally {
        await current.cleanup();
      }
    }
  }
});

test("TC-SEC-002E SQLite concurrent writers and restart preserve one target ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-migration-write-race-"));
  const path = join(directory, "migration.sqlite");
  const first = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
  try {
    const migration = await prepare(first, "domain-target");
    const second = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
    const results = await Promise.allSettled([
      first.transaction(tenant, async (transaction) => {
        await transaction.tasks.migrateSecurityOwnership(migration.id, "task-child", 1);
      }),
      second.transaction(tenant, async (transaction) => {
        await transaction.tasks.migrateSecurityOwnership(migration.id, "task-child", 1);
      }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    await second.close();
    await first.close();

    const restarted = new SqlitePersistence({ path });
    const stored = await restarted.read(tenant, async (transaction) => transaction.tasks.get("task-child"));
    assert.equal(stored?.securityDomainId, "domain-target");
    assert.equal(stored?.securityEpoch, 2);
    assert.equal(stored?.version, 2);
    await restarted.close();
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});
