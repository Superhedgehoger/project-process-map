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
    legacy.exec("DROP TABLE security_grant_audits; DROP TABLE security_grants; DROP TABLE security_domains; DELETE FROM schema_migrations WHERE version IN (4, 5)");
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
    assert.equal((evidence.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version, 5);
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
