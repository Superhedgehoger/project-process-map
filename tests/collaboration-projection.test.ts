import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { AttachTaskAssetHandler } from "../packages/application/src/assets/attach-task-asset.ts";
import { executeCreateNode } from "../packages/application/src/create-node.ts";
import { CollaborationProjectionProcessor } from "../packages/application/src/integrations/project-collaboration.ts";
import {
  IntegrationCallError,
  type AttachFileProjection,
  type ExternalBlobProjectionPort,
  type StoredAssetContent,
  type TaskFileProjectionPort,
  type TaskProjectionPort,
} from "../packages/application/src/ports/integrations.ts";
import { CreateTaskHandler } from "../packages/application/src/tasks/create-task.ts";
import { MemoryAssetContent } from "../packages/adapters/src/memory/asset-content.ts";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { externalReference, externalReferenceKey } from "../packages/domain/src/external-reference.ts";
import { principalId, tenantId } from "../packages/domain/src/identity.ts";

const tenant = tenantId("tenant-collaboration-projection");
const principal = principalId("principal-collaboration-projection");
const now = new Date("2026-09-04T03:00:00.000Z");

test("ARCH-GATE-HULY-002 task and partial asset projection resume from durable stable references", async () => {
  const persistence = new MemoryPersistence();
  const content = new MemoryAssetContent();
  const tasks = new FakeTaskProjection();
  const blobs = new FakeBlobProjection();
  const files = new FailsOnceTaskFileProjection();
  try {
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
      requiresAcceptance: true,
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

    const processor = new CollaborationProjectionProcessor({ persistence, assetContent: content, tasks, blobs, taskFiles: files, now: () => now });
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
