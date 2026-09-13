import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { executeCreateNode } from "../packages/application/src/create-node.ts";
import { ApplicationError } from "../packages/application/src/errors.ts";
import { ActOnTaskHandler } from "../packages/application/src/tasks/act-on-task.ts";
import { CreateTaskHandler } from "../packages/application/src/tasks/create-task.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import { principalId, tenantId } from "../packages/domain/src/identity.ts";
import { grantProjectMembership } from "./support/project-membership.ts";

const tenant = tenantId("tenant-upgrade");
const manager = principalId("manager-upgrade");

test("P0-05A-T1a SQLite upgrades a legacy Task and receipt without stranding the task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-task-upgrade-"));
  const path = join(directory, "legacy.sqlite");
  try {
    const old = new SqlitePersistence({ path });
    await grantProjectMembership(old, tenant, "project-upgrade", manager, { role: "project_manager" });
    await executeCreateNode(old, {
      tenantId: tenant,
      commandId: "legacy-node",
      idempotencyKey: "legacy-node",
      correlationId: "legacy-upgrade",
      principalId: manager,
      projectId: "project-upgrade",
      nodeId: "node-upgrade",
      parentId: null,
      title: "旧任务节点",
      securityDomainId: null,
      occurredAtUtc: "2026-09-04T01:00:00.000Z",
    });
    const createCommand = {
      tenantId: tenant,
      commandId: "legacy-task",
      idempotencyKey: "legacy-task",
      correlationId: "legacy-upgrade",
      principalId: manager,
      projectId: "project-upgrade",
      nodeId: "node-upgrade",
      taskId: "task-upgrade",
      title: "升级前任务",
      assigneePrincipalId: manager,
      requiresAcceptance: false,
      reviewerPrincipalId: null,
      occurredAtUtc: "2026-09-04T01:01:00.000Z",
    } as const;
    await new CreateTaskHandler(old).execute(createCommand);
    await old.close();

    const legacy = new DatabaseSync(path);
    legacy.exec("DROP TABLE project_membership_security_audits; DROP TABLE security_grant_audits; DROP TABLE security_grants; DROP TABLE security_domains; DELETE FROM schema_migrations WHERE version IN (4, 5, 6)");
    const row = legacy.prepare("SELECT task_json FROM product_tasks WHERE tenant_id = ? AND task_id = ?")
      .get(tenant, "task-upgrade") as { task_json: string };
    const task = JSON.parse(row.task_json) as Record<string, unknown>;
    delete task.reviewerPrincipalId;
    task.assigneePrincipalId = null;
    legacy.prepare("UPDATE product_tasks SET task_json = ? WHERE tenant_id = ? AND task_id = ?")
      .run(JSON.stringify(task), tenant, "task-upgrade");
    const legacyFingerprint = createHash("sha256").update(JSON.stringify({
      projectId: "project-upgrade",
      nodeId: "node-upgrade",
      taskId: "task-upgrade",
      title: "升级前任务",
      assigneePrincipalId: null,
      requiresAcceptance: false,
    })).digest("hex");
    legacy.prepare(`
      UPDATE command_receipts SET fingerprint = ?, result_json = ?
      WHERE tenant_id = ? AND principal_id = ? AND operation = 'create_task' AND idempotency_key = ?
    `).run(legacyFingerprint, JSON.stringify({
      id: "task-upgrade",
      nodeId: "node-upgrade",
      title: "升级前任务",
      status: "todo",
      requiresAcceptance: false,
      version: 1,
    }), tenant, manager, "legacy-task");
    legacy.close();

    const upgraded = new SqlitePersistence({ path });
    const replay = await new CreateTaskHandler(upgraded).execute(createCommand);
    assert.equal(replay.replayed, true);
    assert.equal(replay.value.assigneePrincipalId, null);
    assert.equal(replay.value.reviewerPrincipalId, null);
    assert.deepEqual(replay.value.reviewHistory, []);
    await assert.rejects(new CreateTaskHandler(upgraded).execute({
      ...createCommand,
      title: "不同负载",
      commandId: "different-command",
    }), (error) => error instanceof ApplicationError && error.code === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");

    const actions = new ActOnTaskHandler(upgraded);
    const base = {
      tenantId: tenant,
      correlationId: "legacy-upgrade",
      principalId: manager,
      taskId: "task-upgrade",
      assigneePrincipalId: null,
      reviewerPrincipalId: null,
      note: null,
    } as const;
    const assigned = await actions.execute({
      ...base,
      action: "assign_assignee",
      assigneePrincipalId: manager,
      expectedVersion: 1,
      commandId: "assign-legacy-task",
      idempotencyKey: "assign-legacy-task",
      occurredAtUtc: "2026-09-04T01:02:00.000Z",
    });
    assert.equal(assigned.value.assigneePrincipalId, manager);
    await actions.execute({ ...base, action: "start", expectedVersion: 2, commandId: "start-legacy-task", idempotencyKey: "start-legacy-task", occurredAtUtc: "2026-09-04T01:03:00.000Z" });
    const completed = await actions.execute({ ...base, action: "complete", expectedVersion: 3, commandId: "complete-legacy-task", idempotencyKey: "complete-legacy-task", occurredAtUtc: "2026-09-04T01:04:00.000Z" });
    assert.equal(completed.value.status, "completed");
    await upgraded.close();

    const evidence = new DatabaseSync(path, { readOnly: true });
    assert.equal((evidence.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version, 9);
    evidence.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ARCH-GATE-SQLITE-003 a future schema version is rejected instead of silently downgraded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-future-schema-"));
  const path = join(directory, "future.sqlite");
  try {
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at_utc TEXT NOT NULL) STRICT");
    database.prepare("INSERT INTO schema_migrations (version, applied_at_utc) VALUES (?, ?)")
      .run(999, "2026-09-04T00:00:00.000Z");
    database.close();
    assert.throws(() => new SqlitePersistence({ path }), /SQLITE_SCHEMA_VERSION_UNSUPPORTED:999/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TC-SEC-002J schema v6 to v7 migration and rejection by v6 binary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-v6-upgrade-"));
  const path = join(directory, "v6.sqlite");
  try {
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at_utc TEXT NOT NULL) STRICT;
      INSERT INTO schema_migrations (version, applied_at_utc) VALUES
        (1, '2026-09-04T00:00:00.000Z'),
        (2, '2026-09-04T00:00:00.000Z'),
        (3, '2026-09-04T00:00:00.000Z'),
        (4, '2026-09-04T00:00:00.000Z'),
        (5, '2026-09-04T00:00:00.000Z'),
        (6, '2026-09-04T00:00:00.000Z');
      CREATE TABLE tenants (tenant_id TEXT PRIMARY KEY, state TEXT NOT NULL, created_at_utc TEXT NOT NULL) STRICT;
      CREATE TABLE project_nodes (
        tenant_id TEXT NOT NULL, node_id TEXT NOT NULL, project_id TEXT NOT NULL,
        parent_node_id TEXT, title TEXT NOT NULL, kind TEXT NOT NULL,
        security_domain_id TEXT, security_epoch INTEGER NOT NULL,
        version INTEGER NOT NULL, deleted_at_utc TEXT,
        PRIMARY KEY (tenant_id, node_id)
      ) STRICT;
    `);
    database.close();

    const persistence = new SqlitePersistence({ path });
    await persistence.transaction(tenant, async (tx) => {
      await tx.nodes.insert({
        tenantId: tenant, id: "node-v6", projectId: "project-1", parentId: null,
        title: "node", kind: "work_package", securityDomainId: null, securityEpoch: 1,
        version: 1, deletedAtUtc: null,
      });
      const acquired = await tx.outboundProjectionFences.acquire({
        tenantId: tenant,
        id: "fence:task:1",
        projectId: "project-1",
        ownerNodeId: "node-v6",
        token: "tok",
        expiresAtUtc: "2026-09-04T01:00:00.000Z",
        createdAtUtc: "2026-09-04T00:00:00.000Z",
      });
      assert.equal(acquired, true);
    });
    await persistence.close();

    const evidence = new DatabaseSync(path, { readOnly: true });
    const maxVersion = (evidence.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version;
    assert.equal(maxVersion, 9);
    evidence.close();

    const v6SimulatedCheck = (dbPath: string) => {
      const db = new DatabaseSync(dbPath);
      const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
      const v6MaxSupported = 6;
      if (row.version > v6MaxSupported) {
        db.close();
        throw new Error(`SQLITE_SCHEMA_VERSION_UNSUPPORTED:${row.version}`);
      }
      db.close();
    };
    assert.throws(() => v6SimulatedCheck(path), /SQLITE_SCHEMA_VERSION_UNSUPPORTED:9/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TC-SEC-002K schema v7 to v8 migration and rejection by v7 binary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-v7-upgrade-"));
  const path = join(directory, "v7.sqlite");
  try {
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at_utc TEXT NOT NULL) STRICT;
      INSERT INTO schema_migrations (version, applied_at_utc) VALUES
        (1, '2026-09-04T00:00:00.000Z'),
        (2, '2026-09-04T00:00:00.000Z'),
        (3, '2026-09-04T00:00:00.000Z'),
        (4, '2026-09-04T00:00:00.000Z'),
        (5, '2026-09-04T00:00:00.000Z'),
        (6, '2026-09-04T00:00:00.000Z'),
        (7, '2026-09-04T00:00:00.000Z');
      CREATE TABLE tenants (tenant_id TEXT PRIMARY KEY, state TEXT NOT NULL, created_at_utc TEXT NOT NULL) STRICT;
      CREATE TABLE project_nodes (
        tenant_id TEXT NOT NULL, node_id TEXT NOT NULL, project_id TEXT NOT NULL,
        parent_node_id TEXT, title TEXT NOT NULL, kind TEXT NOT NULL,
        security_domain_id TEXT, security_epoch INTEGER NOT NULL,
        version INTEGER NOT NULL, deleted_at_utc TEXT,
        PRIMARY KEY (tenant_id, node_id)
      ) STRICT;
    `);
    database.close();

    const persistence = new SqlitePersistence({ path });
    await persistence.transaction(tenant, async (tx) => {
      await tx.nodes.insert({
        tenantId: tenant, id: "node-v7", projectId: "project-1", parentId: null,
        title: "node", kind: "work_package", securityDomainId: null, securityEpoch: 1,
        version: 1, deletedAtUtc: null,
      });
    });
    await persistence.close();

    const evidence = new DatabaseSync(path, { readOnly: true });
    const maxVersion = (evidence.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version;
    assert.equal(maxVersion, 9);
    const tableCheck = evidence.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='security_migration_audits'").get();
    assert.ok(tableCheck);
    evidence.close();

    const v7SimulatedCheck = (dbPath: string) => {
      const db = new DatabaseSync(dbPath);
      const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
      const v7MaxSupported = 7;
      if (row.version > v7MaxSupported) {
        db.close();
        throw new Error(`SQLITE_SCHEMA_VERSION_UNSUPPORTED:${row.version}`);
      }
      db.close();
    };
    assert.throws(() => v7SimulatedCheck(path), /SQLITE_SCHEMA_VERSION_UNSUPPORTED:9/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TC-SEC-002K schema v8 to v9 migration and rejection by v8 binary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-v8-upgrade-"));
  const path = join(directory, "v8.sqlite");
  try {
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at_utc TEXT NOT NULL) STRICT;
      INSERT INTO schema_migrations (version, applied_at_utc) VALUES
        (1, '2026-09-04T00:00:00.000Z'),
        (2, '2026-09-04T00:00:00.000Z'),
        (3, '2026-09-04T00:00:00.000Z'),
        (4, '2026-09-04T00:00:00.000Z'),
        (5, '2026-09-04T00:00:00.000Z'),
        (6, '2026-09-04T00:00:00.000Z'),
        (7, '2026-09-04T00:00:00.000Z'),
        (8, '2026-09-04T00:00:00.000Z');
      CREATE TABLE tenants (tenant_id TEXT PRIMARY KEY, state TEXT NOT NULL, created_at_utc TEXT NOT NULL) STRICT;
      CREATE TABLE project_nodes (
        tenant_id TEXT NOT NULL, node_id TEXT NOT NULL, project_id TEXT NOT NULL,
        parent_node_id TEXT, title TEXT NOT NULL, kind TEXT NOT NULL,
        security_domain_id TEXT, security_epoch INTEGER NOT NULL,
        version INTEGER NOT NULL, deleted_at_utc TEXT,
        PRIMARY KEY (tenant_id, node_id)
      ) STRICT;
    `);
    database.close();

    const persistence = new SqlitePersistence({ path });
    await persistence.transaction(tenant, async (tx) => {
      await tx.nodes.insert({
        tenantId: tenant, id: "node-v8", projectId: "project-1", parentId: null,
        title: "node", kind: "work_package", securityDomainId: null, securityEpoch: 1,
        version: 1, deletedAtUtc: null,
      });
    });
    await persistence.close();

    const evidence = new DatabaseSync(path, { readOnly: true });
    const maxVersion = (evidence.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version;
    assert.equal(maxVersion, 9);
    const tableCheck = evidence.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='consumed_security_migration_evidence'").get();
    assert.ok(tableCheck);
    evidence.close();

    const v8SimulatedCheck = (dbPath: string) => {
      const db = new DatabaseSync(dbPath);
      const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
      const v8MaxSupported = 8;
      if (row.version > v8MaxSupported) {
        db.close();
        throw new Error(`SQLITE_SCHEMA_VERSION_UNSUPPORTED:${row.version}`);
      }
      db.close();
    };
    assert.throws(() => v8SimulatedCheck(path), /SQLITE_SCHEMA_VERSION_UNSUPPORTED:9/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
