import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import { ApplicationError } from "../packages/application/src/errors.ts";
import {
  ExecuteSecurityMigrationBatchHandler,
  maximumSecurityMigrationBatchSize,
} from "../packages/application/src/security/execute-security-migration-batch.ts";
import { buildResumableSecurityMigrationInventory } from "../packages/application/src/security/build-security-migration-inventory.ts";
import type { Persistence, TransactionContext } from "../packages/application/src/ports/persistence.ts";
import type { Asset } from "../packages/domain/src/assets.ts";
import { principalId, tenantId } from "../packages/domain/src/identity.ts";
import type { ProjectNode } from "../packages/domain/src/project-structure.ts";
import { transitionSecurityMigration, type SecurityDomainMigration } from "../packages/domain/src/security-migration.ts";
import type { ProductTask } from "../packages/domain/src/tasks.ts";

const tenant = tenantId("tenant-migration-batch");
const projectId = "migration-batch-project";
const sourceDomainId = "batch-source";
const targetDomainId = "batch-target";
const totalItems = 6;

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
  const directory = await mkdtemp(join(tmpdir(), "ppm-migration-batch-"));
  const path = join(directory, "batch.sqlite");
  const persistence = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
  return {
    name,
    persistence,
    path,
    cleanup: async () => { await persistence.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

function node(id: string, parentId: string | null): ProjectNode {
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
  };
}

function task(id: string, ownerNodeId: string): ProductTask {
  return {
    tenantId: tenant,
    id,
    projectId,
    ownerNodeId,
    securityDomainId: sourceDomainId,
    securityEpoch: 1,
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

function asset(id: string, ownerNodeId: string): Asset {
  return {
    tenantId: tenant,
    id,
    projectId,
    ownerNodeId,
    securityDomainId: sourceDomainId,
    securityEpoch: 1,
    uploaderPrincipalId: principalId("batch-uploader"),
    displayName: `${id}.txt`,
    contentType: "text/plain",
    size: 1,
    sha256: "b".repeat(64),
    lifecycleState: "available",
    failureCode: null,
    version: 1,
    deletedAtUtc: null,
  };
}

function plannedMigration(overrides: Partial<SecurityDomainMigration> = {}): SecurityDomainMigration {
  return {
    tenantId: tenant,
    id: "migration-batch",
    projectId,
    rootNodeId: "root",
    sourceSecurityDomainId: sourceDomainId,
    targetSecurityDomainId: targetDomainId,
    hierarchyRevision: 1,
    sourceSecurityEpoch: 1,
    targetSecurityEpoch: 2,
    state: "planned",
    cursor: null,
    totalItems,
    migratedItems: 0,
    failure: null,
    nextAttemptAtUtc: null,
    deadlineAtUtc: "2026-09-11T00:00:00.000Z",
    version: 1,
    createdAtUtc: "2026-09-10T08:00:00.000Z",
    updatedAtUtc: "2026-09-10T08:00:00.000Z",
    ...overrides,
  };
}

async function prepare(persistence: Persistence, activate = true, overrides: Partial<SecurityDomainMigration> = {}) {
  const planned = plannedMigration(overrides);
  const active = transitionSecurityMigration(planned, "active", "2026-09-10T08:01:00.000Z");
  await persistence.transaction(tenant, async (transaction) => {
    await transaction.nodes.insert(node("root", null));
    await transaction.nodes.insert(node("child", "root"));
    await transaction.tasks.insert(task("task-child", "child"));
    await transaction.assets.insert(asset("asset-child", "child"));
    await transaction.tasks.insert(task("task-root", "root"));
    await transaction.assets.insert(asset("asset-root", "root"));
    await transaction.securityMigrations.insert(planned);
    if (activate) await transaction.securityMigrations.saveProgressPreservingPlan(active.id, active, planned.version);
  });
  return activate ? active : planned;
}

function command(expectedMigrationVersion: number, batchSize: number, minute: number) {
  return {
    tenantId: tenant,
    migrationId: "migration-batch",
    expectedMigrationVersion,
    batchSize,
    occurredAtUtc: `2026-09-10T08:${String(minute).padStart(2, "0")}:00.000Z`,
  } as const;
}

async function state(persistence: Persistence) {
  return await persistence.read(tenant, async (transaction) => ({
    migration: await transaction.securityMigrations.get("migration-batch"),
    nodes: await transaction.nodes.listForSecurityMigration(),
    tasks: await transaction.tasks.listForSecurityMigration(),
    assets: await transaction.assets.listForSecurityMigration(),
  }));
}

test("TC-SEC-002F Memory and SQLite execute stable bounded batches and resume to completion", async () => {
  const expectedOrder = ["node:child", "task:task-child", "asset:asset-child", "node:root", "task:task-root", "asset:asset-root"];
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence);
      const handler = new ExecuteSecurityMigrationBatchHandler(current.persistence);
      const first = await handler.execute(command(2, 2, 2));
      const second = await handler.execute(command(first.migrationVersion, 2, 3));
      const final = await handler.execute(command(second.migrationVersion, 10, 4));
      assert.deepEqual(
        [...first.processedItems, ...second.processedItems, ...final.processedItems].map((item) => `${item.kind}:${item.id}`),
        expectedOrder,
        name,
      );
      assert.deepEqual([first.migratedItems, second.migratedItems, final.migratedItems], [2, 4, 6], name);
      assert.equal(final.complete, true, name);
      const noOp = await handler.execute(command(final.migrationVersion, 10, 5));
      assert.equal(noOp.processedItems.length, 0, name);
      assert.equal(noOp.migrationVersion, final.migrationVersion, name);
      assert.equal(noOp.cursor, final.cursor, name);
      const stored = await state(current.persistence);
      assert.equal(stored.migration?.migratedItems, totalItems, name);
      for (const object of [...stored.nodes, ...stored.tasks, ...stored.assets]) {
        assert.equal(object.securityDomainId, targetDomainId, `${name}:${object.id}:domain`);
        assert.equal(object.securityEpoch, 2, `${name}:${object.id}:epoch`);
        assert.equal(object.version, 2, `${name}:${object.id}:version`);
      }
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002F every object write and checkpoint failure rolls back the entire batch", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    for (const failure of ["node", "task", "asset", "checkpoint"] as const) {
      const current = await fixture(name);
      try {
        await prepare(current.persistence);
        const before = await state(current.persistence);
        const handler = new ExecuteSecurityMigrationBatchHandler(failingPersistence(current.persistence, failure));
        await assert.rejects(
          handler.execute(command(2, totalItems, 2)),
          failure === "checkpoint" ? /SECURITY_MIGRATION_VERSION_CONFLICT/ : /INJECTED_FAILURE/,
          `${name}:${failure}`,
        );
        assert.deepEqual(await state(current.persistence), before, `${name}:${failure}`);
      } finally {
        await current.cleanup();
      }
    }
  }
});

test("TC-SEC-002F rejects invalid inputs, state, version and plan inventory without writes", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence, false);
      const before = await state(current.persistence);
      const handler = new ExecuteSecurityMigrationBatchHandler(current.persistence);
      await assert.rejects(handler.execute(command(1, 1, 2)), isCode("SECURITY_MIGRATION_BATCH_INVALID"));
      await assert.rejects(handler.execute({ ...command(1, 1, 2), migrationId: "missing" }), isCode("SECURITY_MIGRATION_NOT_FOUND"));
      await assert.rejects(handler.execute(command(99, 1, 2)), isCode("SECURITY_MIGRATION_VERSION_CONFLICT"));
      await assert.rejects(handler.execute(command(1, 0, 2)), isCode("VALIDATION_FAILED"));
      await assert.rejects(handler.execute(command(1, maximumSecurityMigrationBatchSize + 1, 2)), isCode("VALIDATION_FAILED"));
      assert.deepEqual(await state(current.persistence), before, name);
    } finally {
      await current.cleanup();
    }

    const mismatch = await fixture(name);
    try {
      await prepare(mismatch.persistence, true, { totalItems: totalItems + 1 });
      const before = await state(mismatch.persistence);
      await assert.rejects(
        new ExecuteSecurityMigrationBatchHandler(mismatch.persistence).execute(command(2, 2, 2)),
        isCode("SECURITY_MIGRATION_BATCH_INVALID"),
      );
      assert.deepEqual(await state(mismatch.persistence), before, `${name}:total`);
    } finally {
      await mismatch.cleanup();
    }
  }
});

test("TC-SEC-002F resumable inventory rejects an out-of-order target object", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence);
      const handler = new ExecuteSecurityMigrationBatchHandler(current.persistence);
      const first = await handler.execute(command(2, 2, 2));
      await current.persistence.transaction(tenant, async (transaction) => {
        await transaction.assets.migrateSecurityOwnership("migration-batch", "asset-root", 1);
      });
      const before = await state(current.persistence);
      await assert.rejects(
        handler.execute(command(first.migrationVersion, 2, 3)),
        isCode("SECURITY_MIGRATION_INVENTORY_INVALID"),
        name,
      );
      assert.deepEqual(await state(current.persistence), before, name);
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002F resumable inventory rejects forged or drifted progress boundaries", async () => {
  const firstCursor = JSON.stringify(["child", "node", "child"]);
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence);
      for (const progress of [
        { cursor: "missing-cursor", migratedItems: 1 },
        { cursor: null, migratedItems: 1 },
        { cursor: firstCursor, migratedItems: 2 },
        { cursor: firstCursor, migratedItems: 1 },
      ] as const) {
        await assert.rejects(current.persistence.read(tenant, async (transaction) => {
          await buildResumableSecurityMigrationInventory(transaction, {
            tenantId: tenant,
            projectId,
            rootNodeId: "root",
            sourceSecurityDomainId: sourceDomainId,
            sourceSecurityEpoch: 1,
          }, {
            ...progress,
            targetSecurityDomainId: targetDomainId,
            targetSecurityEpoch: 2,
          });
        }), isCode("SECURITY_MIGRATION_INVENTORY_INVALID"), `${name}:${progress.cursor}:${progress.migratedItems}`);
      }
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002F bounded batches support migration back to public ownership", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence, true, { targetSecurityDomainId: null });
      const handler = new ExecuteSecurityMigrationBatchHandler(current.persistence);
      const first = await handler.execute(command(2, 3, 2));
      const final = await handler.execute(command(first.migrationVersion, 3, 3));
      assert.equal(final.complete, true, name);
      const stored = await state(current.persistence);
      assert.equal([...stored.nodes, ...stored.tasks, ...stored.assets]
        .every((object) => object.securityDomainId === null && object.securityEpoch === 2 && object.version === 2), true, name);
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002F SQLite concurrent batches commit once and restart resumes without skips", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-migration-batch-race-"));
  const path = join(directory, "batch.sqlite");
  const first = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
  try {
    await prepare(first);
    const second = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
    const settled = await Promise.allSettled([
      new ExecuteSecurityMigrationBatchHandler(first).execute(command(2, 2, 2)),
      new ExecuteSecurityMigrationBatchHandler(second).execute(command(2, 2, 2)),
    ]);
    assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
    await second.close();
    await first.close();

    const restarted = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
    try {
      const partial = await state(restarted);
      assert.equal(partial.migration?.migratedItems, 2);
      const final = await new ExecuteSecurityMigrationBatchHandler(restarted)
        .execute(command(partial.migration?.version ?? 0, 10, 3));
      assert.equal(final.migratedItems, totalItems);
      assert.equal(final.complete, true);
      const stored = await state(restarted);
      assert.equal(stored.migration?.cursor, final.cursor);
      assert.equal([...stored.nodes, ...stored.tasks, ...stored.assets]
        .every((object) => object.securityDomainId === targetDomainId && object.securityEpoch === 2 && object.version === 2), true);
    } finally {
      await restarted.close();
    }
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function isCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ApplicationError && error.code === code;
}

function failingPersistence(base: Persistence, failure: "node" | "task" | "asset" | "checkpoint"): Persistence {
  return {
    nowUtc: () => new Date().toISOString(),
    transaction: async (tenantId, work) => await base.transaction(tenantId, async (transaction) => {
      const injected = (): never => { throw new Error(`INJECTED_FAILURE:${failure}`); };
      const decorated: TransactionContext = {
        ...transaction,
        nodes: failure === "node" ? { ...transaction.nodes, migrateSecurityOwnership: async () => injected() } : transaction.nodes,
        tasks: failure === "task" ? { ...transaction.tasks, migrateSecurityOwnership: async () => injected() } : transaction.tasks,
        assets: failure === "asset" ? { ...transaction.assets, migrateSecurityOwnership: async () => injected() } : transaction.assets,
        securityMigrations: failure === "checkpoint"
          ? {
              ...transaction.securityMigrations,
              saveProgressPreservingPlan: async (migrationId, migration, expectedVersion) =>
                await transaction.securityMigrations.saveProgressPreservingPlan(migrationId, migration, expectedVersion + 1),
            }
          : transaction.securityMigrations,
      };
      return await work(decorated);
    }),
    read: async (tenantId, work) => await base.read(tenantId, work),
    executeCreateNode: async (cmd, fp) => await base.executeCreateNode(cmd, fp),
    executeAssignNodeLeader: async (cmd, fp) => await base.executeAssignNodeLeader(cmd, fp),
    executeAssignProjectRoleBinding: async (cmd, fp) => await base.executeAssignProjectRoleBinding(cmd, fp),
    executeInitializeProjectRoleSlots: async (cmd, fp) => await base.executeInitializeProjectRoleSlots(cmd, fp),
    close: async () => {},

  };
}
