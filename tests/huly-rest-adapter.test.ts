import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  HulyRestBlobProjectionAdapter,
  HulyRestTaskFileProjectionAdapter,
  HulyRestTaskProjectionAdapter,
} from "../packages/adapters/src/huly-rest.ts";
import { IntegrationCallError } from "../packages/application/src/ports/integrations.ts";

type StoredDoc = Record<string, unknown>;

test("P0-05-CT-008 Huly REST adapters create, reconcile and compensate Issue, Attachment and Blob", async (context) => {
  const issues = new Map<string, StoredDoc>();
  const attachments = new Map<string, StoredDoc>();
  const blobs = new Set<string>();
  const transactions: StoredDoc[] = [];
  let sequence = 4;
  let loseTaskCreateResponse = true;
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer actor-token");

    if (url.pathname.endsWith("/api/v1/account/workspace-1")) {
      return json({ socialIds: ["email:user@example.test"] });
    }
    if (url.pathname.endsWith("/api/v1/find-all/workspace-1")) {
      const classId = url.searchParams.get("class");
      const query = JSON.parse(url.searchParams.get("query") ?? "{}") as StoredDoc;
      if (classId === "tracker:class:Project") {
        return findResult([{ _id: "huly-project-1", identifier: "PPM", sequence, type: "project-type-1", defaultIssueStatus: "tracker:status:Todo" }]);
      }
      if (classId === "task:class:TaskType") return findResult([{ _id: "task-type-1", kind: "task" }]);
      if (classId === "tracker:class:Issue") return findResult(query._id === undefined ? [...issues.values()] : maybe(issues.get(String(query._id))));
      if (classId === "attachment:class:Attachment") return findResult(query._id === undefined ? [...attachments.values()] : maybe(attachments.get(String(query._id))));
    }
    if (url.pathname.endsWith("/api/v1/tx/workspace-1")) {
      const transaction = JSON.parse(String(init.body)) as StoredDoc;
      transactions.push(transaction);
      if (transaction._class === "core:class:TxUpdateDoc") {
        sequence += 1;
        return json({ object: { sequence } });
      }
      if (transaction._class === "core:class:TxCreateDoc") {
        const doc = {
          ...(transaction.attributes as StoredDoc),
          _id: transaction.objectId,
          _class: transaction.objectClass,
          space: transaction.objectSpace,
          attachedTo: transaction.attachedTo,
          modifiedOn: transaction.modifiedOn,
        };
        const target = transaction.objectClass === "tracker:class:Issue" ? issues : attachments;
        target.set(String(transaction.objectId), doc);
        if (transaction.objectClass === "tracker:class:Issue" && loseTaskCreateResponse) {
          loseTaskCreateResponse = false;
          throw new TypeError("socket closed after commit");
        }
        return json({});
      }
      if (transaction._class === "core:class:TxRemoveDoc") {
        const target = transaction.objectClass === "tracker:class:Issue" ? issues : attachments;
        target.delete(String(transaction.objectId));
        return json({});
      }
    }
    if (url.pathname.startsWith("/files/workspace-1")) {
      const blobId = url.searchParams.get("file");
      if (init.method === "HEAD") return new Response(null, { status: blobId !== null && blobs.has(blobId) ? 200 : 404 });
      if (init.method === "DELETE") {
        if (blobId !== null) blobs.delete(blobId);
        return new Response(null, { status: 200 });
      }
      if (init.method === "POST") {
        assert.ok(init.body instanceof FormData);
        const file = init.body.get("file");
        assert.ok(file instanceof File);
        blobs.add(file.name);
        return json([{ id: file.name }]);
      }
    }
    return new Response(null, { status: 404 });
  };

  const config = {
    transactionEndpoint: "ws://huly.test/_transactor",
    fileEndpoint: "http://huly.test/files",
    workspaceId: "workspace-1",
    projectId: "huly-project-1",
    actorToken: "actor-token",
  };
  const taskAdapter = new HulyRestTaskProjectionAdapter(config);
  const blobAdapter = new HulyRestBlobProjectionAdapter(config);
  const taskFileAdapter = new HulyRestTaskFileProjectionAdapter(config);
  const taskInput = { requestId: "task-key", title: "真实 Huly 任务", status: "todo" as const };
  const task = await taskAdapter.create(taskInput);
  assert.deepEqual(await taskAdapter.create(taskInput), task);
  assert.deepEqual(await taskAdapter.get(task.reference), task);

  const bytes = new TextEncoder().encode("huly attachment");
  const blob = await blobAdapter.put({
    requestId: "blob-key",
    contentType: "text/plain",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  assert.equal(blob.scanState, "scanning");
  assert.equal(await blobAdapter.exists(blob.reference), true);

  const attachmentInput = {
    requestId: "attachment-key",
    taskReference: task.reference,
    blobReference: blob.reference,
    name: "evidence.txt",
    contentType: "text/plain",
    size: bytes.byteLength,
  };
  const attachment = await taskFileAdapter.attach(attachmentInput);
  assert.deepEqual(await taskFileAdapter.attach(attachmentInput), attachment);
  assert.deepEqual(await taskFileAdapter.get(attachment.reference), attachment);
  assert.equal(transactions.filter((item) => item._class === "core:class:TxUpdateDoc").length, 1);
  assert.equal(transactions.filter((item) => item._class === "core:class:TxCreateDoc").length, 2);
  assert.equal(sequence, 5);

  const issueBeforeDelete = issues.get(task.reference.externalId);
  assert.ok(issueBeforeDelete);
  issueBeforeDelete.modifiedOn = 999;
  await assert.rejects(taskAdapter.remove(task.reference, task.syncWatermark), /HULY_SYNC_WATERMARK_CONFLICT/);
  assert.equal(issues.has(task.reference.externalId), true);
  issueBeforeDelete.modifiedOn = Number(task.syncWatermark);

  await taskFileAdapter.remove(attachment.reference, attachment.syncWatermark);
  await blobAdapter.remove(blob.reference);
  await taskAdapter.remove(task.reference, task.syncWatermark);
  assert.equal(attachments.size, 0);
  assert.equal(blobs.size, 0);
  assert.equal(issues.size, 0);
});

test("ARCH-GATE-HULY-001 Huly calls have an abortable deadline and classify ambiguous timeout", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_input, init = {}) => await new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
  const adapter = new HulyRestTaskProjectionAdapter({
    transactionEndpoint: "http://huly.test/_transactor",
    fileEndpoint: "http://huly.test/files",
    workspaceId: "workspace-1",
    projectId: "project-1",
    actorToken: "service-token",
    requestTimeoutMilliseconds: 5,
  });
  assert.equal(await adapter.health(), "degraded");
  const direct = new HulyRestTaskProjectionAdapter({
    transactionEndpoint: "http://huly.test/_transactor",
    fileEndpoint: "http://huly.test/files",
    workspaceId: "workspace-1",
    projectId: "project-1",
    actorToken: "service-token",
    requestTimeoutMilliseconds: 5,
  });
  try {
    await direct.create({ requestId: "request-1", title: "timeout", status: "todo" });
    assert.fail("timeout should reject");
  } catch (error) {
    assert.ok(error instanceof IntegrationCallError);
    assert.equal(error.code, "HULY_REQUEST_TIMEOUT");
    assert.equal(error.retryable, true);
    assert.equal(error.outcome, "ambiguous");
  }
});

function maybe(value: StoredDoc | undefined): StoredDoc[] {
  return value === undefined ? [] : [value];
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function findResult(value: StoredDoc[]): Response {
  return json({ dataType: "TotalArray", total: -1, lookupMap: null, value });
}
