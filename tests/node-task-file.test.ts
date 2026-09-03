import assert from "node:assert/strict";
import test from "node:test";
import {
  NodeTaskFileService,
  type AttachTaskFileCommand,
  type CreateTaskCommand,
  type IntegrationSaga,
  type LocalFailurePoint,
  type TaskMapping,
} from "../packages/application/src/node-task-file.ts";
import {
  InMemoryBlobAdapter,
  InMemoryTaskAdapter,
  InMemoryTaskFileAdapter,
} from "../packages/adapters/src/in-memory.ts";
import type { AttachFileAtAuthority, TaskFileAuthorityRecord, UploadBlob } from "../packages/adapters/src/ports.ts";
import { executeCreateNode, InMemoryTransactionalStore } from "../packages/domain/src/outbox.ts";

function taskCommand(overrides: Partial<CreateTaskCommand> = {}): CreateTaskCommand {
  return {
    commandId: "cmd-task-1",
    idempotencyKey: "request-task-1",
    correlationId: "cor-1",
    actorId: "user-1",
    projectId: "project-1",
    nodeId: "node-1",
    taskId: "task-1",
    title: "提交技术方案",
    status: "todo",
    occurredAtUtc: "2026-09-03T01:00:00.000Z",
    ...overrides,
  };
}

const fileBytes = new TextEncoder().encode("phase-0 evidence");

function fileCommand(overrides: Partial<AttachTaskFileCommand> = {}): AttachTaskFileCommand {
  return {
    commandId: "cmd-file-1",
    idempotencyKey: "request-file-1",
    correlationId: "cor-1",
    actorId: "user-1",
    projectId: "project-1",
    taskId: "task-1",
    fileId: "file-1",
    name: "技术方案.txt",
    contentType: "text/plain",
    bytes: fileBytes,
    sha256: "cdd25c8649ac3cf60fbfd2b974ff28a83c0ea93c7f110e786549392c0b2c2eeb",
    occurredAtUtc: "2026-09-03T01:01:00.000Z",
    ...overrides,
  };
}

function fixture(kind: "stage" | "work_package" | "milestone" = "work_package") {
  const store = new InMemoryTransactionalStore();
  executeCreateNode(store, {
    commandId: "cmd-node-1",
    idempotencyKey: "request-node-1",
    correlationId: "cor-1",
    actorId: "user-1",
    projectId: "project-1",
    nodeId: "node-1",
    title: "方案设计",
    kind,
    securityDomainId: "security-1",
    occurredAtUtc: "2026-09-03T00:59:00.000Z",
  });
  const taskAdapter = new InstrumentedTaskAdapter();
  const blobAdapter = new InstrumentedBlobAdapter();
  const taskFileAdapter = new InstrumentedTaskFileAdapter();
  const service = new NodeTaskFileService(store, taskAdapter, blobAdapter, taskFileAdapter);
  return { store, taskAdapter, blobAdapter, taskFileAdapter, service };
}

class InstrumentedTaskAdapter extends InMemoryTaskAdapter {
  creates = 0;
  removes = 0;
  lastAuthorityRef: string | undefined;
  failRemove = false;

  override async create(input: Parameters<InMemoryTaskAdapter["create"]>[0]) {
    this.creates += 1;
    const result = await super.create(input);
    this.lastAuthorityRef = result.authorityRef;
    return result;
  }

  override async remove(authorityRef: string): Promise<void> {
    this.removes += 1;
    if (this.failRemove) throw new Error("task compensation unavailable");
    await super.remove(authorityRef);
  }
}

class InstrumentedBlobAdapter extends InMemoryBlobAdapter {
  uploads = 0;
  removes = 0;

  override async upload(input: UploadBlob) {
    this.uploads += 1;
    return await super.upload(input);
  }

  override async remove(authorityRef: string): Promise<void> {
    this.removes += 1;
    await super.remove(authorityRef);
  }
}

class InstrumentedTaskFileAdapter extends InMemoryTaskFileAdapter {
  attaches = 0;
  removes = 0;
  failNextAttach = false;

  override async attach(input: AttachFileAtAuthority): Promise<TaskFileAuthorityRecord> {
    this.attaches += 1;
    if (this.failNextAttach) {
      this.failNextAttach = false;
      throw new Error("temporary attachment timeout");
    }
    return await super.attach(input);
  }

  override async remove(authorityRef: string): Promise<void> {
    this.removes += 1;
    await super.remove(authorityRef);
  }
}

test("P0-05-CT-001 links Node to Task to File with inherited ownership and no authority refs in public DTOs", async () => {
  const { store, service } = fixture();
  const task = await service.createTask(taskCommand());
  const file = await service.attachTaskFile(fileCommand());
  const detail = await service.getNodeDetail("node-1");
  const snapshot = store.snapshot();

  assert.equal(task.replayed, false);
  assert.equal(file.replayed, false);
  assert.deepEqual(detail.tasks[0]?.files[0], file.value);
  assert.equal(JSON.stringify({ task, file, detail }).includes("authority:"), false);
  const mapping = store.getProjection<TaskMapping>("node_task_mapping", "task-1");
  assert.equal(mapping?.ownerNodeId, "node-1");
  assert.equal(mapping?.securityDomainId, "security-1");
  assert.deepEqual(snapshot.events.map((event) => event.projectSequence), [1, 2, 3]);
  assert.deepEqual(snapshot.events.map((event) => event.eventType), [
    "project-map.node.created.v1",
    "project-map.task.linked.v1",
    "project-map.file.attached.v1",
  ]);
  assert.equal(snapshot.outbox.length, 3);
});

test("P0-05-CT-002 exact command replay does not duplicate authority records, events or outbox", async () => {
  const { store, taskAdapter, blobAdapter, taskFileAdapter, service } = fixture();
  const firstTask = await service.createTask(taskCommand());
  const replayTask = await service.createTask(taskCommand({ commandId: "cmd-task-retry", correlationId: "cor-retry" }));
  const firstFile = await service.attachTaskFile(fileCommand());
  const replayFile = await service.attachTaskFile(fileCommand({ commandId: "cmd-file-retry", correlationId: "cor-retry" }));

  assert.deepEqual(replayTask, { value: firstTask.value, replayed: true });
  assert.deepEqual(replayFile, { value: firstFile.value, replayed: true });
  assert.equal(taskAdapter.creates, 1);
  assert.equal(blobAdapter.uploads, 1);
  assert.equal(taskFileAdapter.attaches, 1);
  assert.equal(store.snapshot().events.length, 3);
  assert.equal(store.snapshot().outbox.length, 3);
  await assert.rejects(service.createTask(taskCommand({ title: "changed" })), /Idempotency key was reused/);
});

test("P0-05-CT-002 concurrent service instances share the same command lock", async () => {
  const { store, taskAdapter, blobAdapter, taskFileAdapter, service } = fixture();
  const otherService = new NodeTaskFileService(store, taskAdapter, blobAdapter, taskFileAdapter);
  const results = await Promise.all([
    service.createTask(taskCommand()),
    otherService.createTask(taskCommand({ commandId: "cmd-task-concurrent" })),
  ]);

  assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
  assert.equal(taskAdapter.creates, 1);
  assert.equal(store.snapshot().events.length, 2);
  assert.equal(store.snapshot().outbox.length, 2);
});

test("P0-05-CT-003 rejects missing and milestone nodes before creating an authority task", async () => {
  const missing = fixture();
  await assert.rejects(missing.service.createTask(taskCommand({ nodeId: "missing" })), /Node not found/);
  assert.equal(missing.taskAdapter.creates, 0);

  const milestone = fixture("milestone");
  await assert.rejects(milestone.service.createTask(taskCommand()), /Milestones cannot contain tasks/);
  assert.equal(milestone.taskAdapter.creates, 0);
});

for (const failurePoint of ["after_projection", "after_event", "after_outbox"] satisfies LocalFailurePoint[]) {
  test(`P0-05-CT-004 ${failurePoint} rolls back local task state and compensates authority`, async () => {
    const { store, taskAdapter, service } = fixture();
    await assert.rejects(service.createTask(taskCommand(), failurePoint), new RegExp(failurePoint));
    assert.equal(store.getProjection("node_task_mapping", "task-1"), undefined);
    assert.equal(store.snapshot().events.length, 1);
    assert.equal(store.snapshot().outbox.length, 1);
    assert.equal(store.snapshot().projectSequences.get("project-1"), 1);
    assert.equal(taskAdapter.removes, 1);
    assert.equal(await taskAdapter.get(taskAdapter.lastAuthorityRef ?? "missing"), undefined);
  });
}

test("P0-05-CT-005 attachment timeout resumes the same Blob without an orphan or duplicate", async () => {
  const { blobAdapter, taskFileAdapter, service } = fixture();
  await service.createTask(taskCommand());
  taskFileAdapter.failNextAttach = true;
  await assert.rejects(service.attachTaskFile(fileCommand()), /temporary attachment timeout/);
  const result = await service.attachTaskFile(fileCommand());

  assert.equal(result.replayed, false);
  assert.equal(blobAdapter.uploads, 1);
  assert.equal(taskFileAdapter.attaches, 2);
  assert.equal((await service.getNodeDetail("node-1")).tasks[0]?.files.length, 1);
});

test("P0-05-CT-006 file local failure removes Attachment before Blob and leaves no metadata", async () => {
  const { store, blobAdapter, taskFileAdapter, service } = fixture();
  await service.createTask(taskCommand());
  await assert.rejects(service.attachTaskFile(fileCommand(), "after_event"), /after_event/);

  assert.equal(store.getProjection("task_file_metadata", "file-1"), undefined);
  assert.equal(taskFileAdapter.removes, 1);
  assert.equal(blobAdapter.removes, 1);
  assert.equal(store.snapshot().events.length, 2);
});

test("P0-05-CT-007 failed compensation is explicit and blocks unsafe automatic replay", async () => {
  const { store, taskAdapter, service } = fixture();
  taskAdapter.failRemove = true;
  await assert.rejects(service.createTask(taskCommand(), "after_event"), /after_event/);
  const saga = store.listProjections<IntegrationSaga>("node_task_file_saga")[0];

  assert.equal(saga?.status, "recovery_required");
  assert.match(saga?.failure ?? "", /compensation unavailable/);
  await assert.rejects(service.createTask(taskCommand()), /SAGA_RECOVERY_REQUIRED/);
});
