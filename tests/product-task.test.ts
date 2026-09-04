import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeCreateNode } from "../packages/application/src/create-node.ts";
import type { Persistence } from "../packages/application/src/ports/persistence.ts";
import { CreateTaskHandler } from "../packages/application/src/tasks/create-task.ts";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import { principalId, tenantId } from "../packages/domain/src/identity.ts";
import { grantProjectMembership } from "./support/project-membership.ts";

const tenant = tenantId("tenant-task-test");
const principal = principalId("principal-task-test");

async function prepare(persistence: Persistence): Promise<void> {
  await grantProjectMembership(persistence, tenant, "project-1", principal, { securityDomainIds: ["security-1"] });
  await executeCreateNode(persistence, {
    tenantId: tenant,
    commandId: "node-command",
    idempotencyKey: "node-request",
    correlationId: "correlation-1",
    principalId: principal,
    projectId: "project-1",
    nodeId: "node-1",
    parentId: null,
    title: "方案设计",
    securityDomainId: "security-1",
    occurredAtUtc: "2026-09-04T01:00:00.000Z",
  });
}

function createCommand() {
  return {
    tenantId: tenant,
    commandId: "task-command",
    idempotencyKey: "task-request",
    correlationId: "correlation-1",
    principalId: principal,
    projectId: "project-1",
    nodeId: "node-1",
    taskId: "task-1",
    title: "提交技术方案",
    assigneePrincipalId: principal,
    requiresAcceptance: true,
    reviewerPrincipalId: principal,
    occurredAtUtc: "2026-09-04T01:01:00.000Z",
  } as const;
}

test("ARCH-GATE-TASK-004 product Task commits locally and only schedules optional Huly projection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-product-task-"));
  const stores = [
    new MemoryPersistence(),
    new SqlitePersistence({ path: join(directory, "task.sqlite") }),
  ];
  try {
    for (const persistence of stores) {
      await prepare(persistence);
      const handler = new CreateTaskHandler(persistence, { scheduleCollaborationProjection: true });
      const created = await handler.execute(createCommand());
      const replay = await handler.execute({ ...createCommand(), commandId: "task-command-retry" });
      assert.equal(created.replayed, false);
      assert.equal(created.value.status, "todo");
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.value, created.value);
      const task = await persistence.read(tenant, async (transaction) => await transaction.tasks.get("task-1"));
      assert.equal(task?.reviewState, "not_submitted");
      const jobs = persistence instanceof MemoryPersistence
        ? [...persistence.snapshot().jobs.values()]
        : await persistence.listJobs(tenant);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]?.jobType, "collaboration.task.project");
    }
  } finally {
    for (const persistence of stores) await persistence.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ARCH-GATE-TASK-005 Huly projection can be disabled without disabling product Task", async () => {
  const persistence = new MemoryPersistence();
  try {
    await prepare(persistence);
    const created = await new CreateTaskHandler(persistence).execute(createCommand());
    assert.equal(created.value.id, "task-1");
    assert.equal(persistence.snapshot().jobs.size, 0);
  } finally {
    await persistence.close();
  }
});
