import assert from "node:assert/strict";
import test from "node:test";
import { runWorkerCycle } from "../apps/worker/src/worker.ts";
import { executeCreateNode } from "../packages/application/src/create-node.ts";
import { CollaborationProjectionProcessor } from "../packages/application/src/integrations/project-collaboration.ts";
import { IntegrationRecoveryService } from "../packages/application/src/integrations/recover-integration.ts";
import {
  IntegrationCallError,
  type ExternalBlobProjectionPort,
  type TaskFileProjectionPort,
  type TaskProjectionPort,
} from "../packages/application/src/ports/integrations.ts";
import { CreateTaskHandler } from "../packages/application/src/tasks/create-task.ts";
import { MemoryAssetContent } from "../packages/adapters/src/memory/asset-content.ts";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { externalReference } from "../packages/domain/src/external-reference.ts";
import { principalId, tenantId } from "../packages/domain/src/identity.ts";

const tenant = tenantId("tenant-recovery-test");
const operator = principalId("principal-recovery-operator");
const time = new Date("2026-09-04T06:00:00.000Z");

test("ARCH-GATE-RECOVERY-001 authorized retry requeues the same saga and audits without exposing provider references", async () => {
  const persistence = new MemoryPersistence();
  const taskPort = new ToggleTaskProjection();
  try {
    await executeCreateNode(persistence, {
      tenantId: tenant,
      commandId: "node-command",
      idempotencyKey: "node-request",
      correlationId: "recovery",
      principalId: operator,
      projectId: "project-1",
      nodeId: "node-1",
      parentId: null,
      title: "节点",
      securityDomainId: null,
      occurredAtUtc: time.toISOString(),
    });
    await new CreateTaskHandler(persistence, { scheduleCollaborationProjection: true }).execute({
      tenantId: tenant,
      commandId: "task-command",
      idempotencyKey: "task-request",
      correlationId: "recovery",
      principalId: operator,
      projectId: "project-1",
      nodeId: "node-1",
      taskId: "task-1",
      title: "需恢复任务",
      assigneePrincipalId: null,
      requiresAcceptance: false,
      occurredAtUtc: time.toISOString(),
    });
    const processor = new CollaborationProjectionProcessor({
      persistence,
      assetContent: new MemoryAssetContent(),
      tasks: taskPort,
      blobs: unusedBlobPort,
      taskFiles: unusedFilePort,
      now: () => time,
    });
    await runWorkerCycle({
      outbox: persistence.outboxConsumer,
      jobs: persistence.jobConsumer,
      processJob: async (job) => await processor.process(job),
    }, { workerId: "worker-1", now: () => time });
    const deadJob = [...persistence.snapshot().jobs.values()][0];
    assert.equal(deadJob?.state, "dead_letter");

    const denied = new IntegrationRecoveryService(persistence, { canRecover: async () => false });
    await assert.rejects(denied.list(tenant, operator), /FORBIDDEN/);
    const recovery = new IntegrationRecoveryService(persistence, { canRecover: async (_tenant, principal) => principal === operator });
    const [operation] = await recovery.list(tenant, operator);
    assert.ok(operation);
    assert.equal(operation.state, "recovery_required");
    assert.equal(JSON.stringify(operation).includes("externalReference"), false);
    assert.equal(JSON.stringify(operation).includes("lastError"), false);

    const command = {
      tenantId: tenant,
      principalId: operator,
      commandId: "recover-command",
      idempotencyKey: "recover-request",
      correlationId: "recovery",
      operationId: operation.id,
      expectedVersion: operation.version,
      reason: "已确认服务配置，重新投影",
      occurredAtUtc: new Date(time.getTime() + 1_000).toISOString(),
    } as const;
    const retried = await recovery.retry(command);
    const replay = await recovery.retry({ ...command, commandId: "ignored-replay" });
    assert.equal(retried.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal([...persistence.snapshot().jobs.values()][0]?.state, "pending");

    taskPort.fail = false;
    await runWorkerCycle({
      outbox: persistence.outboxConsumer,
      jobs: persistence.jobConsumer,
      processJob: async (job) => await processor.process(job),
    }, { workerId: "worker-2", now: () => new Date(time.getTime() + 2_000) });
    const final = await persistence.read(tenant, async (transaction) => await transaction.integrationOperations.get(operation.id));
    assert.equal(final?.state, "completed");
    assert.equal([...persistence.snapshot().jobs.values()][0]?.state, "completed");
    assert.equal([...persistence.snapshot().events.values()].some((event) => event.eventType === "project-map.integration.recovery-requested"), true);
  } finally {
    await persistence.close();
  }
});

class ToggleTaskProjection implements TaskProjectionPort {
  fail = true;
  async health() { return "ok" as const; }
  async create(input: Parameters<TaskProjectionPort["create"]>[0]) {
    if (this.fail) throw new IntegrationCallError("HULY_HTTP_403", "service identity forbidden", { retryable: false, outcome: "known_failed" });
    return { reference: externalReference("huly", "task", `task-${input.requestId}`), title: input.title, status: input.status, syncWatermark: "1" };
  }
  async get() { return undefined; }
  async remove() {}
}

const unusedBlobPort: ExternalBlobProjectionPort = {
  health: async () => "ok",
  put: async () => { throw new Error("unused"); },
  exists: async () => false,
  remove: async () => {},
};

const unusedFilePort: TaskFileProjectionPort = {
  health: async () => "ok",
  attach: async () => { throw new Error("unused"); },
  get: async () => undefined,
  remove: async () => {},
};
