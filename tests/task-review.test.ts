import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeCreateNode } from "../packages/application/src/create-node.ts";
import { ApplicationError, type ApplicationErrorCode } from "../packages/application/src/errors.ts";
import type { OutboxConsumer, Persistence } from "../packages/application/src/ports/persistence.ts";
import { ActOnTaskHandler, type TaskCommandAction } from "../packages/application/src/tasks/act-on-task.ts";
import { CreateTaskHandler } from "../packages/application/src/tasks/create-task.ts";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import { principalId, tenantId, type PrincipalId } from "../packages/domain/src/identity.ts";
import { grantProjectMembership } from "./support/project-membership.ts";

const tenant = tenantId("tenant-task-review");
const assignee = principalId("assignee-1");
const reviewer = principalId("reviewer-1");
const outsider = principalId("outsider-1");
const manager = principalId("manager-1");

type Fixture = Readonly<{ name: string; persistence: Persistence; outbox: OutboxConsumer; cleanup(): Promise<void> }>;

async function fixtures(): Promise<Fixture[]> {
  const directory = await mkdtemp(join(tmpdir(), "ppm-task-review-"));
  const memory = new MemoryPersistence();
  const sqlite = new SqlitePersistence({ path: join(directory, "review.sqlite") });
  return [
    { name: "memory", persistence: memory, outbox: memory.outboxConsumer, cleanup: async () => await memory.close() },
    { name: "sqlite", persistence: sqlite, outbox: sqlite.outboxConsumer, cleanup: async () => { await sqlite.close(); await rm(directory, { recursive: true, force: true }); } },
  ];
}

async function prepare(persistence: Persistence, taskId = "task-1"): Promise<void> {
  await grantProjectMembership(persistence, tenant, "project-1", assignee, { securityDomainIds: ["security-1"] });
  await grantProjectMembership(persistence, tenant, "project-1", reviewer, { securityDomainIds: ["security-1"] });
  await grantProjectMembership(persistence, tenant, "project-1", outsider, { securityDomainIds: ["security-1"] });
  if (await persistence.read(tenant, async (transaction) => await transaction.nodes.get("node-1")) === undefined) {
    await executeCreateNode(persistence, {
      tenantId: tenant,
      commandId: "create-node",
      idempotencyKey: "create-node",
      correlationId: "task-review",
      principalId: assignee,
      projectId: "project-1",
      nodeId: "node-1",
      parentId: null,
      title: "方案验收",
      securityDomainId: "security-1",
      occurredAtUtc: "2026-09-04T08:00:00.000Z",
    });
  }
  await new CreateTaskHandler(persistence).execute({
    tenantId: tenant,
    commandId: `create-${taskId}`,
    idempotencyKey: `create-${taskId}`,
    correlationId: "task-review",
    principalId: assignee,
    projectId: "project-1",
    nodeId: "node-1",
    taskId,
    title: "提交并验收方案",
    assigneePrincipalId: assignee,
    requiresAcceptance: true,
    reviewerPrincipalId: reviewer,
    occurredAtUtc: "2026-09-04T08:01:00.000Z",
  });
}

function command(
  actor: PrincipalId,
  action: TaskCommandAction,
  expectedVersion: number,
  sequence: number,
  note: string | null = null,
  taskId = "task-1",
) {
  return {
    tenantId: tenant,
    commandId: `command-${taskId}-${sequence}`,
    idempotencyKey: `request-${taskId}-${sequence}`,
    correlationId: "task-review",
    principalId: actor,
    taskId,
    action,
    expectedVersion,
    assigneePrincipalId: null,
    reviewerPrincipalId: null,
    note,
    occurredAtUtc: `2026-09-04T08:${String(sequence + 1).padStart(2, "0")}:00.000Z`,
  } as const;
}

test("P0-05A-T1a required-review Task rejects a missing or ineligible reviewer atomically", async () => {
  for (const fixture of await fixtures()) {
    try {
      await executeCreateNode(fixture.persistence, {
        tenantId: tenant,
        commandId: "create-node",
        idempotencyKey: "create-node",
        correlationId: "task-review",
        principalId: assignee,
        projectId: "project-1",
        nodeId: "node-1",
        parentId: null,
        title: "方案验收",
        securityDomainId: "security-1",
        occurredAtUtc: "2026-09-04T08:00:00.000Z",
      });
      await grantProjectMembership(fixture.persistence, tenant, "project-1", assignee, { securityDomainIds: ["security-1"] });
      await grantProjectMembership(fixture.persistence, tenant, "project-1", reviewer, { securityDomainIds: ["security-1"] });
      const base = {
        tenantId: tenant,
        correlationId: "task-review",
        principalId: assignee,
        projectId: "project-1",
        nodeId: "node-1",
        title: "必验任务",
        assigneePrincipalId: assignee,
        requiresAcceptance: true,
        occurredAtUtc: "2026-09-04T08:01:00.000Z",
      } as const;
      const handler = new CreateTaskHandler(fixture.persistence);
      await assert.rejects(handler.execute({
        ...base,
        commandId: "missing-reviewer",
        idempotencyKey: "missing-reviewer",
        taskId: "missing-reviewer",
        reviewerPrincipalId: null,
      }), errorCode("REVIEWER_REQUIRED"), fixture.name);
      await assert.rejects(handler.execute({
        ...base,
        commandId: "ineligible-reviewer",
        idempotencyKey: "ineligible-reviewer",
        taskId: "ineligible-reviewer",
        reviewerPrincipalId: outsider,
      }), errorCode("REVIEWER_NOT_ELIGIBLE"), fixture.name);
      await fixture.persistence.transaction(tenant, async (transaction) => {
        const principal = await transaction.principals.get(reviewer);
        assert.ok(principal);
        await transaction.principals.update({
          ...principal,
          status: "revoked",
          version: principal.version + 1,
          updatedAtUtc: "2026-09-04T08:02:00.000Z",
        }, principal.version);
      });
      await assert.rejects(handler.execute({
        ...base,
        commandId: "revoked-reviewer",
        idempotencyKey: "revoked-reviewer",
        taskId: "revoked-reviewer",
        reviewerPrincipalId: reviewer,
      }), errorCode("REVIEWER_NOT_ELIGIBLE"), fixture.name);
      assert.equal(await fixture.persistence.read(tenant, async (transaction) => (await transaction.tasks.listByNode("node-1")).length), 0, fixture.name);
      assert.equal(await fixture.outbox.countReady("9999-12-31T23:59:59.999Z"), 1, fixture.name);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("P0-05A-T1a rejection and resubmission preserve immutable review cycles in Memory and SQLite", async () => {
  for (const fixture of await fixtures()) {
    try {
      await prepare(fixture.persistence);
      const handler = new ActOnTaskHandler(fixture.persistence);
      assert.equal((await handler.execute(command(assignee, "start", 1, 1))).value.status, "in_progress", fixture.name);
      const submitted = await handler.execute(command(assignee, "submit", 2, 2, "方案和测试记录已提交"));
      assert.equal(submitted.value.status, "pending_review", fixture.name);
      assert.equal(submitted.value.reviewHistory[0]?.cycleNumber, 1, fixture.name);
      const replay = await handler.execute({ ...command(assignee, "submit", 2, 2, "方案和测试记录已提交"), commandId: "retry-submit" });
      assert.equal(replay.replayed, true, fixture.name);
      assert.equal(replay.value.reviewHistory.length, 1, fixture.name);

      await assert.rejects(handler.execute(command(outsider, "accept", 3, 3)), errorCode("TASK_ACTION_FORBIDDEN"), fixture.name);
      await assert.rejects(handler.execute(command(reviewer, "reject", 3, 4)), errorCode("TASK_REJECTION_REASON_REQUIRED"), fixture.name);
      const rejected = await handler.execute(command(reviewer, "reject", 3, 5, "缺少回滚说明"));
      assert.equal(rejected.value.status, "in_progress", fixture.name);
      const second = await handler.execute(command(assignee, "submit", 4, 6, "已补充回滚说明"));
      assert.equal(second.value.reviewHistory.at(-1)?.cycleNumber, 2, fixture.name);
      const accepted = await handler.execute(command(reviewer, "accept", 5, 7, "验收通过"));
      assert.equal(accepted.value.status, "completed", fixture.name);
      assert.equal(accepted.value.version, 6, fixture.name);
      assert.deepEqual(
        accepted.value.reviewHistory.map((action) => [action.cycleNumber, action.action, action.reviewerPrincipalId]),
        [[1, "submitted", reviewer], [1, "rejected", reviewer], [2, "submitted", reviewer], [2, "accepted", reviewer]],
        fixture.name,
      );
      const messages = await fixture.outbox.claim({
        workerId: `test-${fixture.name}`,
        nowUtc: "9999-12-30T00:00:00.000Z",
        leaseUntilUtc: "9999-12-31T00:00:00.000Z",
        limit: 20,
      });
      const taskEvents = messages.map((message) => message.payload).filter((event) => event.aggregateType === "task");
      assert.deepEqual(taskEvents.map((event) => event.eventType), [
        "project-map.task.created",
        "project-map.task.started",
        "project-map.task.review.submitted",
        "project-map.task.review.rejected",
        "project-map.task.review.submitted",
        "project-map.task.review.accepted",
      ], fixture.name);
      assert.equal(JSON.stringify(taskEvents).includes("回滚说明"), false, fixture.name);
      await assert.rejects(handler.execute(command(reviewer, "reject", 5, 8, "并发旧版本")), errorCode("TASK_VERSION_CONFLICT"), fixture.name);
    } finally {
      await fixture.cleanup();
    }
  }
});

function errorCode(code: ApplicationErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof ApplicationError && error.code === code;
}

test("P0-05A-T1a concurrent decisions commit exactly one result and SQLite restores the history after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-task-review-restart-"));
  const path = join(directory, "review.sqlite");
  try {
    const first = new SqlitePersistence({ path });
    await prepare(first, "task-restart");
    const handler = new ActOnTaskHandler(first);
    await handler.execute(command(assignee, "start", 1, 1, null, "task-restart"));
    await handler.execute(command(assignee, "submit", 2, 2, "提交", "task-restart"));
    const outcomes = await Promise.allSettled([
      handler.execute(command(reviewer, "accept", 3, 3, "通过", "task-restart")),
      handler.execute(command(reviewer, "reject", 3, 4, "退回", "task-restart")),
    ]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["fulfilled", "rejected"]);
    await first.close();

    const restored = new SqlitePersistence({ path });
    const state = await restored.read(tenant, async (transaction) => ({
      task: await transaction.tasks.get("task-restart"),
      history: await transaction.tasks.listReviewActions("task-restart"),
    }));
    assert.equal(state.task?.version, 4);
    assert.equal(state.history.length, 2);
    assert.equal(state.history[0]?.action, "submitted");
    assert.ok(state.history[1]?.action === "accepted" || state.history[1]?.action === "rejected");
    await restored.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("P0-05A-T1a a manager can recover an unassigned task without taking over assignee-only actions", async () => {
  for (const fixture of await fixtures()) {
    try {
      await prepare(fixture.persistence, "task-assignment");
      await grantProjectMembership(fixture.persistence, tenant, "project-1", manager, {
        role: "project_manager",
        securityDomainIds: ["security-1"],
      });
      await fixture.persistence.transaction(tenant, async (transaction) => {
        const task = await transaction.tasks.get("task-assignment");
        assert.ok(task);
        await transaction.tasks.update({ ...task, assigneePrincipalId: null, version: task.version + 1 }, task.version);
      });
      const handler = new ActOnTaskHandler(fixture.persistence);
      await assert.rejects(handler.execute({
        ...command(manager, "assign_assignee", 2, 20, null, "task-assignment"),
        assigneePrincipalId: null,
      }), errorCode("ASSIGNEE_REQUIRED"), fixture.name);
      const assigned = await handler.execute({
        ...command(manager, "assign_assignee", 2, 21, null, "task-assignment"),
        assigneePrincipalId: outsider,
      });
      assert.equal(assigned.value.assigneePrincipalId, outsider, fixture.name);
      await handler.execute(command(outsider, "start", 3, 22, null, "task-assignment"));
      await assert.rejects(
        handler.execute(command(manager, "submit", 4, 23, null, "task-assignment")),
        errorCode("TASK_ACTION_FORBIDDEN"),
        fixture.name,
      );
      await handler.execute(command(outsider, "submit", 4, 24, null, "task-assignment"));
    } finally {
      await fixture.cleanup();
    }
  }
});

test("P0-05A-T1a current membership is checked before an idempotent replay", async () => {
  for (const fixture of await fixtures()) {
    try {
      await prepare(fixture.persistence, "task-revoke");
      const handler = new ActOnTaskHandler(fixture.persistence);
      const start = command(assignee, "start", 1, 30, null, "task-revoke");
      await handler.execute(start);
      await fixture.persistence.transaction(tenant, async (transaction) => {
        const membership = await transaction.memberships.get("project-1", assignee);
        assert.ok(membership);
        await transaction.memberships.update({
          ...membership,
          status: "revoked",
          version: membership.version + 1,
          updatedAtUtc: "2026-09-04T09:00:00.000Z",
        }, membership.version);
      });
      await assert.rejects(handler.execute({ ...start, commandId: "replay-after-revoke" }), errorCode("TASK_NOT_FOUND"), fixture.name);
    } finally {
      await fixture.cleanup();
    }
  }
});
