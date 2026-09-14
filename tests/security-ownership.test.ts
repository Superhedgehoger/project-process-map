import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import type { Persistence } from "../packages/application/src/ports/persistence.ts";
import { transitionAsset, type Asset } from "../packages/domain/src/assets.ts";
import { principalId, tenantId } from "../packages/domain/src/identity.ts";
import { startTask, type ProductTask } from "../packages/domain/src/tasks.ts";

const tenant = tenantId("tenant-security-ownership");
const uploader = principalId("ownership-uploader");

type Fixture = Readonly<{
  name: "memory" | "sqlite";
  persistence: Persistence;
  cleanup(): Promise<void>;
}>;

async function fixture(name: "memory" | "sqlite"): Promise<Fixture> {
  if (name === "memory") {
    const persistence = new MemoryPersistence();
    return { name, persistence, cleanup: async () => await persistence.close() };
  }
  const directory = await mkdtemp(join(tmpdir(), "ppm-security-ownership-"));
  const persistence = new SqlitePersistence({ path: join(directory, "ownership.sqlite") });
  return {
    name,
    persistence,
    cleanup: async () => { await persistence.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

function task(id: string, securityDomainId: string | null): ProductTask {
  return {
    tenantId: tenant,
    id,
    projectId: "ownership-project",
    ownerNodeId: "ownership-node",
    securityDomainId,
    securityEpoch: securityDomainId === null ? 1 : 2,
    title: "Ownership task",
    assigneePrincipalId: uploader,
    requiresAcceptance: false,
    reviewerPrincipalId: null,
    executionState: "todo",
    reviewState: "not_required",
    version: 1,
    deletedAtUtc: null,
  };
}

function asset(id: string, securityDomainId: string | null): Asset {
  return {
    tenantId: tenant,
    id,
    projectId: "ownership-project",
    ownerNodeId: "ownership-node",
    securityDomainId,
    securityEpoch: securityDomainId === null ? 1 : 2,
    uploaderPrincipalId: uploader,
    displayName: "evidence.txt",
    contentType: "text/plain",
    size: 4,
    sha256: "0".repeat(64),
    lifecycleState: "initiated",
    failureCode: null,
    version: 1,
    deletedAtUtc: null,
  };
}

async function prepare(persistence: Persistence): Promise<void> {
  await persistence.transaction(tenant, async (transaction) => {
    await transaction.principals.insert({
      tenantId: tenant,
      id: uploader,
      kind: "user",
      status: "active",
      version: 1,
      createdAtUtc: "2026-09-09T01:00:00.000Z",
      updatedAtUtc: "2026-09-09T01:00:00.000Z",
    });
    for (const id of ["ownership-node", "other-node"]) await transaction.nodes.insert({
      tenantId: tenant,
      id,
      projectId: "ownership-project",
      parentId: null,
      leaderPrincipalId: null,
      title: id,
      kind: "work_package",
      securityDomainId: null,
      securityEpoch: 1,
      version: 1,
      deletedAtUtc: null,
    });
    await transaction.tasks.insert(task("public-task", null));
    await transaction.tasks.insert(task("sensitive-task", "domain-a"));
    await transaction.assets.insert(asset("public-asset", null));
    await transaction.assets.insert(asset("sensitive-asset", "domain-a"));
  });
}

test("TC-SEC-002B Task ordinary save rejects every security-ownership rewrite", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence);
      const publicTask = task("public-task", null);
      const sensitiveTask = task("sensitive-task", "domain-a");
      const attempts: Array<readonly [ProductTask, ProductTask]> = [
        [publicTask, { ...publicTask, securityDomainId: "domain-a", securityEpoch: 2, version: 2 }],
        [sensitiveTask, { ...sensitiveTask, securityDomainId: null, version: 2 }],
        [sensitiveTask, { ...sensitiveTask, securityDomainId: "domain-b", version: 2 }],
        [sensitiveTask, { ...sensitiveTask, securityEpoch: 3, version: 2 }],
        [sensitiveTask, { ...sensitiveTask, ownerNodeId: "other-node", version: 2 }],
        [sensitiveTask, { ...sensitiveTask, projectId: "other-project", version: 2 }],
        [sensitiveTask, { ...sensitiveTask, tenantId: tenantId("other-tenant"), version: 2 }],
        [sensitiveTask, { ...sensitiveTask, id: "renamed-task", version: 2 }],
      ];
      await current.persistence.transaction(tenant, async (transaction) => {
        for (const [original, proposed] of attempts) {
          await assert.rejects(
            transaction.tasks.savePreservingSecurityOwnership(original.id, proposed, original.version),
            /TASK_SECURITY_OWNERSHIP_IMMUTABLE/,
            name,
          );
        }
      });
      const state = await current.persistence.read(tenant, async (transaction) => ({
        publicTask: await transaction.tasks.get(publicTask.id),
        sensitiveTask: await transaction.tasks.get(sensitiveTask.id),
        renamed: await transaction.tasks.get("renamed-task"),
      }));
      assert.deepEqual(state.publicTask, publicTask, name);
      assert.deepEqual(state.sensitiveTask, sensitiveTask, name);
      assert.equal(state.renamed, undefined, name);
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002B Asset ordinary save rejects every security-ownership rewrite", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence);
      const publicAsset = asset("public-asset", null);
      const sensitiveAsset = asset("sensitive-asset", "domain-a");
      const attempts: Array<readonly [Asset, Asset]> = [
        [publicAsset, { ...publicAsset, securityDomainId: "domain-a", securityEpoch: 2, version: 2 }],
        [sensitiveAsset, { ...sensitiveAsset, securityDomainId: null, version: 2 }],
        [sensitiveAsset, { ...sensitiveAsset, securityDomainId: "domain-b", version: 2 }],
        [sensitiveAsset, { ...sensitiveAsset, securityEpoch: 3, version: 2 }],
        [sensitiveAsset, { ...sensitiveAsset, ownerNodeId: "other-node", version: 2 }],
        [sensitiveAsset, { ...sensitiveAsset, projectId: "other-project", version: 2 }],
        [sensitiveAsset, { ...sensitiveAsset, tenantId: tenantId("other-tenant"), version: 2 }],
        [sensitiveAsset, { ...sensitiveAsset, id: "renamed-asset", version: 2 }],
        [sensitiveAsset, { ...sensitiveAsset, uploaderPrincipalId: principalId("other-uploader"), version: 2 }],
      ];
      await current.persistence.transaction(tenant, async (transaction) => {
        for (const [original, proposed] of attempts) {
          await assert.rejects(
            transaction.assets.savePreservingSecurityOwnership(original.id, proposed, original.version),
            /ASSET_SECURITY_OWNERSHIP_IMMUTABLE/,
            name,
          );
        }
      });
      const state = await current.persistence.read(tenant, async (transaction) => ({
        publicAsset: await transaction.assets.get(publicAsset.id),
        sensitiveAsset: await transaction.assets.get(sensitiveAsset.id),
        renamed: await transaction.assets.get("renamed-asset"),
      }));
      assert.deepEqual(state.publicAsset, publicAsset, name);
      assert.deepEqual(state.sensitiveAsset, sensitiveAsset, name);
      assert.equal(state.renamed, undefined, name);
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002B legitimate lifecycle saves preserve ownership and stale CAS fails", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence);
      const originalTask = task("sensitive-task", "domain-a");
      const originalAsset = asset("sensitive-asset", "domain-a");
      const started = startTask(originalTask);
      const uploading = transitionAsset(originalAsset, "uploading");
      await current.persistence.transaction(tenant, async (transaction) => {
        await transaction.tasks.savePreservingSecurityOwnership(originalTask.id, started, originalTask.version);
        await transaction.assets.savePreservingSecurityOwnership(originalAsset.id, uploading, originalAsset.version);
      });
      await assert.rejects(current.persistence.transaction(tenant, async (transaction) => {
        await transaction.tasks.savePreservingSecurityOwnership(
          originalTask.id, { ...originalTask, executionState: "completed", version: 2 }, originalTask.version,
        );
      }), /TASK_VERSION_CONFLICT/, name);
      await assert.rejects(current.persistence.transaction(tenant, async (transaction) => {
        await transaction.assets.savePreservingSecurityOwnership(
          originalAsset.id, { ...originalAsset, lifecycleState: "scanning", version: 2 }, originalAsset.version,
        );
      }), /ASSET_VERSION_CONFLICT/, name);
      const state = await current.persistence.read(tenant, async (transaction) => ({
        task: await transaction.tasks.get(originalTask.id),
        asset: await transaction.assets.get(originalAsset.id),
      }));
      assert.equal(state.task?.executionState, "in_progress", name);
      assert.equal(state.task?.securityDomainId, "domain-a", name);
      assert.equal(state.asset?.lifecycleState, "uploading", name);
      assert.equal(state.asset?.securityEpoch, 2, name);
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002B SQLite concurrent CAS and restart preserve security ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-security-ownership-race-"));
  const path = join(directory, "ownership.sqlite");
  const first = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
  try {
    await prepare(first);
    const second = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
    const original = task("sensitive-task", "domain-a");
    const taskResults = await Promise.allSettled([
      first.transaction(tenant, async (transaction) => transaction.tasks.savePreservingSecurityOwnership(
        original.id, { ...original, executionState: "in_progress", version: 2 }, 1,
      )),
      second.transaction(tenant, async (transaction) => transaction.tasks.savePreservingSecurityOwnership(
        original.id, { ...original, assigneePrincipalId: null, version: 2 }, 1,
      )),
    ]);
    assert.equal(taskResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(taskResults.filter((result) => result.status === "rejected").length, 1);
    const originalAsset = asset("sensitive-asset", "domain-a");
    const assetResults = await Promise.allSettled([
      first.transaction(tenant, async (transaction) => transaction.assets.savePreservingSecurityOwnership(
        originalAsset.id, { ...originalAsset, lifecycleState: "uploading", version: 2 }, 1,
      )),
      second.transaction(tenant, async (transaction) => transaction.assets.savePreservingSecurityOwnership(
        originalAsset.id, { ...originalAsset, failureCode: "retry", version: 2 }, 1,
      )),
    ]);
    assert.equal(assetResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(assetResults.filter((result) => result.status === "rejected").length, 1);
    await second.close();
    await first.close();
    const restarted = new SqlitePersistence({ path });
    const stored = await restarted.read(tenant, async (transaction) => ({
      task: await transaction.tasks.get(original.id),
      asset: await transaction.assets.get(originalAsset.id),
    }));
    assert.equal(stored.task?.version, 2);
    assert.equal(stored.task?.projectId, original.projectId);
    assert.equal(stored.task?.ownerNodeId, original.ownerNodeId);
    assert.equal(stored.task?.securityDomainId, original.securityDomainId);
    assert.equal(stored.task?.securityEpoch, original.securityEpoch);
    assert.equal(stored.asset?.version, 2);
    assert.equal(stored.asset?.projectId, originalAsset.projectId);
    assert.equal(stored.asset?.ownerNodeId, originalAsset.ownerNodeId);
    assert.equal(stored.asset?.securityDomainId, originalAsset.securityDomainId);
    assert.equal(stored.asset?.securityEpoch, originalAsset.securityEpoch);
    assert.equal(stored.asset?.uploaderPrincipalId, originalAsset.uploaderPrincipalId);
    await restarted.close();
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TC-SEC-002B SQLite rejects Task and Asset relational/JSON ownership drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-security-ownership-drift-"));
  const path = join(directory, "ownership.sqlite");
  const persistence = new SqlitePersistence({ path });
  try {
    await prepare(persistence);
    await persistence.close();
    const database = new DatabaseSync(path);
    const driftedTask = { ...task("sensitive-task", "domain-a"), projectId: "drifted-project" };
    database.prepare("UPDATE product_tasks SET task_json = ? WHERE tenant_id = ? AND task_id = ?")
      .run(JSON.stringify(driftedTask), tenant, driftedTask.id);
    database.prepare("UPDATE assets SET owner_node_id = ? WHERE tenant_id = ? AND asset_id = ?")
      .run("other-node", tenant, "sensitive-asset");
    database.close();

    const reopened = new SqlitePersistence({ path });
    try {
      const originalTask = task("sensitive-task", "domain-a");
      const originalAsset = asset("sensitive-asset", "domain-a");
      await assert.rejects(reopened.transaction(tenant, async (transaction) => {
        await transaction.tasks.savePreservingSecurityOwnership(
          originalTask.id, { ...originalTask, executionState: "in_progress", version: 2 }, 1,
        );
      }), /TASK_SECURITY_OWNERSHIP_IMMUTABLE/);
      await assert.rejects(reopened.transaction(tenant, async (transaction) => {
        await transaction.assets.savePreservingSecurityOwnership(
          originalAsset.id, { ...originalAsset, lifecycleState: "uploading", version: 2 }, 1,
        );
      }), /ASSET_SECURITY_OWNERSHIP_IMMUTABLE/);
      const stored = await reopened.read(tenant, async (transaction) => ({
        task: await transaction.tasks.get(originalTask.id),
        asset: await transaction.assets.get(originalAsset.id),
      }));
      assert.equal(stored.task?.projectId, "drifted-project");
      assert.equal(stored.asset?.ownerNodeId, originalAsset.ownerNodeId);
    } finally {
      await reopened.close();
    }
  } finally {
    await persistence.close();
    await rm(directory, { recursive: true, force: true });
  }
});
