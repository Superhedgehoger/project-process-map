import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import { ApplicationError } from "../packages/application/src/errors.ts";
import { SecurityMigrationInventoryReader } from "../packages/application/src/security/build-security-migration-inventory.ts";
import type { Persistence } from "../packages/application/src/ports/persistence.ts";
import type { Asset } from "../packages/domain/src/assets.ts";
import { principalId, tenantId } from "../packages/domain/src/identity.ts";
import type { ProjectNode } from "../packages/domain/src/project-structure.ts";
import type { ProductTask } from "../packages/domain/src/tasks.ts";

const tenant = tenantId("tenant-migration-inventory");
const projectId = "inventory-project";
const domainId = "domain-a";
const epoch = 2;

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
  const directory = await mkdtemp(join(tmpdir(), "ppm-migration-inventory-"));
  const path = join(directory, "inventory.sqlite");
  const persistence = new SqlitePersistence({ path });
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
    securityDomainId: domainId,
    securityEpoch: epoch,
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
    securityDomainId: domainId,
    securityEpoch: epoch,
    title: id,
    assigneePrincipalId: null,
    requiresAcceptance: false,
    reviewerPrincipalId: null,
    executionState: "todo",
    reviewState: "not_required",
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
    securityDomainId: domainId,
    securityEpoch: epoch,
    uploaderPrincipalId: principalId("inventory-uploader"),
    displayName: `${id}.txt`,
    contentType: "text/plain",
    size: 1,
    sha256: "0".repeat(64),
    lifecycleState: "initiated",
    failureCode: null,
    version: 1,
    deletedAtUtc: null,
    ...overrides,
  };
}

async function prepareCompleteTree(persistence: Persistence): Promise<void> {
  await persistence.transaction(tenant, async (transaction) => {
    for (const current of [
      node("z-root", null),
      node("a-child", "z-root", { deletedAtUtc: "2026-09-09T10:00:00.000Z", version: 2 }),
      node("m-grand", "a-child"),
      node("x-outside", null, { securityDomainId: null, securityEpoch: 1 }),
    ]) await transaction.nodes.insert(current);
    for (const current of [
      task("task-z", "z-root"),
      task("task-a", "m-grand", { deletedAtUtc: "2026-09-09T10:01:00.000Z", version: 2 }),
      task("task-outside", "x-outside", { securityDomainId: null, securityEpoch: 1 }),
    ]) await transaction.tasks.insert(current);
    for (const current of [
      asset("asset-z", "z-root"),
      asset("asset-a", "a-child", {
        lifecycleState: "deleted",
        deletedAtUtc: "2026-09-09T10:02:00.000Z",
        version: 2,
      }),
      asset("asset-outside", "x-outside", { securityDomainId: null, securityEpoch: 1 }),
    ]) await transaction.assets.insert(current);
  });
}

function query() {
  return {
    tenantId: tenant,
    projectId,
    rootNodeId: "z-root",
    sourceSecurityDomainId: domainId,
    sourceSecurityEpoch: epoch,
  } as const;
}

async function expectInventoryInvalid(promise: Promise<unknown>, message?: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ApplicationError && error.code === "SECURITY_MIGRATION_INVENTORY_INVALID",
    message,
  );
}

test("TC-SEC-002D Memory and SQLite build the same stable non-empty subtree inventory", async () => {
  let expected: Awaited<ReturnType<SecurityMigrationInventoryReader["build"]>> | undefined;
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepareCompleteTree(current.persistence);
      const reader = new SecurityMigrationInventoryReader(current.persistence);
      const first = await reader.build(query());
      const replay = await reader.build(query());
      assert.deepEqual(replay, first, name);
      assert.equal(first.totalItems, 7, name);
      assert.deepEqual(first.items.map((item) => `${item.ownerNodeId}:${item.kind}:${item.id}`), [
        "a-child:node:a-child",
        "a-child:asset:asset-a",
        "m-grand:node:m-grand",
        "m-grand:task:task-a",
        "z-root:node:z-root",
        "z-root:task:task-z",
        "z-root:asset:asset-z",
      ], name);
      assert.equal(first.items.some((item) => item.id === "task-outside" || item.id === "asset-outside"), false, name);
      assert.equal(new Set(first.items.map((item) => item.cursor)).size, first.totalItems, name);
      if (expected === undefined) expected = first;
      else assert.deepEqual(first, expected, name);

      if (name === "sqlite") {
        await current.persistence.close();
        const restarted = new SqlitePersistence({ path: current.path as string });
        const afterRestart = await new SecurityMigrationInventoryReader(restarted).build(query());
        assert.deepEqual(afterRestart, first);
        await restarted.close();
      }
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002D inventory fails closed for source and object ownership drift", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const empty = await fixture(name);
    try {
      await expectInventoryInvalid(
        new SecurityMigrationInventoryReader(empty.persistence).build(query()),
        `${name}:missing-root`,
      );
      await empty.persistence.transaction(tenant, async (transaction) => {
        await transaction.nodes.insert(node("z-root", null));
      });
      const inventory = await new SecurityMigrationInventoryReader(empty.persistence).build(query());
      assert.equal(inventory.totalItems, 1, `${name}:empty-subtree`);
    } finally {
      await empty.cleanup();
    }

    for (const scenario of ["epoch", "domain", "nested", "cross-project", "cross-project-node"] as const) {
      const current = await fixture(name);
      try {
        await current.persistence.transaction(tenant, async (transaction) => {
          await transaction.nodes.insert(node("z-root", null));
          await transaction.nodes.insert(node("a-child", "z-root", scenario === "epoch"
            ? { securityEpoch: 3 }
            : scenario === "domain" ? { securityDomainId: "domain-b" } : {}));
          if (scenario === "nested") await transaction.securityDomains.insert({
            tenantId: tenant,
            id: domainId,
            projectId,
            rootNodeId: "a-child",
            parentSecurityDomainId: null,
            permissionVersion: 1,
            version: 1,
            createdByPrincipalId: principalId("nested-domain-creator"),
            createdAtUtc: "2026-09-09T10:00:00.000Z",
            deletedAtUtc: null,
          });
          if (scenario === "cross-project") {
            await transaction.tasks.insert(task("cross-project-task", "a-child", { projectId: "other-project" }));
          }
          if (scenario === "cross-project-node") {
            await transaction.nodes.insert(node("cross-project-child", "z-root", { projectId: "other-project" }));
          }
        });
        await expectInventoryInvalid(
          new SecurityMigrationInventoryReader(current.persistence).build(query()),
          `${name}:${scenario}`,
        );
      } finally {
        await current.cleanup();
      }
    }
  }
});

test("TC-SEC-002D SQLite fails closed on hierarchy and object row/JSON corruption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-migration-inventory-corrupt-"));
  const path = join(directory, "inventory.sqlite");
  const persistence = new SqlitePersistence({ path });
  try {
    await prepareCompleteTree(persistence);
    await persistence.close();
    const database = new DatabaseSync(path);
    database.exec("PRAGMA foreign_keys=OFF");
    database.prepare("UPDATE project_nodes SET parent_node_id = ? WHERE tenant_id = ? AND node_id = ?")
      .run("missing-parent", tenant, "a-child");
    const stored = database.prepare(
      "SELECT task_json FROM product_tasks WHERE tenant_id = ? AND task_id = ?",
    ).get(tenant, "task-z") as { task_json: string };
    const storedAsset = database.prepare(
      "SELECT asset_json FROM assets WHERE tenant_id = ? AND asset_id = ?",
    ).get(tenant, "asset-z") as { asset_json: string };
    database.prepare("UPDATE product_tasks SET task_json = ? WHERE tenant_id = ? AND task_id = ?")
      .run(JSON.stringify({ ...(JSON.parse(stored.task_json) as ProductTask), ownerNodeId: "a-child" }), tenant, "task-z");
    database.close();

    const reopened = new SqlitePersistence({ path });
    try {
      await expectInventoryInvalid(new SecurityMigrationInventoryReader(reopened).build(query()));
    } finally {
      await reopened.close();
    }

    const repairedHierarchy = new DatabaseSync(path);
    repairedHierarchy.prepare("UPDATE project_nodes SET parent_node_id = ? WHERE tenant_id = ? AND node_id = ?")
      .run("z-root", tenant, "a-child");
    repairedHierarchy.close();
    const rowDrift = new SqlitePersistence({ path });
    try {
      await expectInventoryInvalid(new SecurityMigrationInventoryReader(rowDrift).build(query()));
    } finally {
      await rowDrift.close();
    }

    const taskRepaired = new DatabaseSync(path);
    taskRepaired.prepare("UPDATE product_tasks SET task_json = ? WHERE tenant_id = ? AND task_id = ?")
      .run(stored.task_json, tenant, "task-z");
    taskRepaired.prepare("UPDATE assets SET asset_json = ? WHERE tenant_id = ? AND asset_id = ?")
      .run(JSON.stringify({ ...(JSON.parse(storedAsset.asset_json) as Asset), ownerNodeId: "a-child" }), tenant, "asset-z");
    taskRepaired.close();
    const assetDrift = new SqlitePersistence({ path });
    try {
      await expectInventoryInvalid(new SecurityMigrationInventoryReader(assetDrift).build(query()));
    } finally {
      await assetDrift.close();
    }

    const assetRepaired = new DatabaseSync(path);
    assetRepaired.exec("PRAGMA foreign_keys=OFF");
    assetRepaired.prepare("UPDATE assets SET asset_json = ? WHERE tenant_id = ? AND asset_id = ?")
      .run(storedAsset.asset_json, tenant, "asset-z");
    assetRepaired.prepare("UPDATE project_nodes SET parent_node_id = ? WHERE tenant_id = ? AND node_id = ?")
      .run("m-grand", tenant, "z-root");
    assetRepaired.close();
    const cycle = new SqlitePersistence({ path });
    try {
      await expectInventoryInvalid(new SecurityMigrationInventoryReader(cycle).build(query()));
    } finally {
      await cycle.close();
    }
  } finally {
    await persistence.close();
    await rm(directory, { recursive: true, force: true });
  }
});
