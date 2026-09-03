import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { HulyRestBlobAdapter, HulyRestTaskAdapter, HulyRestTaskFileAdapter } from "../packages/adapters/src/huly-rest.ts";

type StoredDoc = Record<string, unknown>;

test("P0-05-CT-008 Huly REST adapters create, reconcile and compensate Issue, Attachment and Blob", async (context) => {
  const issues = new Map<string, StoredDoc>();
  const attachments = new Map<string, StoredDoc>();
  const blobs = new Set<string>();
  const transactions: StoredDoc[] = [];
  let sequence = 4;
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
  const taskAdapter = new HulyRestTaskAdapter(config);
  const blobAdapter = new HulyRestBlobAdapter(config);
  const taskFileAdapter = new HulyRestTaskFileAdapter(config);
  const taskInput = { authorityKey: "task-key", title: "真实 Huly 任务", status: "todo" as const };
  const task = await taskAdapter.create(taskInput);
  assert.deepEqual(await taskAdapter.create(taskInput), task);
  assert.deepEqual(await taskAdapter.get(task.authorityRef), task);

  const bytes = new TextEncoder().encode("huly attachment");
  const blob = await blobAdapter.upload({
    authorityKey: "blob-key",
    contentType: "text/plain",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  assert.equal(blob.scanState, "scanning");
  assert.deepEqual(await blobAdapter.get(blob.authorityRef), blob);

  const attachmentInput = {
    authorityKey: "attachment-key",
    taskAuthorityRef: task.authorityRef,
    blobAuthorityRef: blob.authorityRef,
    name: "evidence.txt",
    contentType: "text/plain",
    size: bytes.byteLength,
  };
  const attachment = await taskFileAdapter.attach(attachmentInput);
  assert.deepEqual(await taskFileAdapter.attach(attachmentInput), attachment);
  assert.deepEqual(await taskFileAdapter.get(attachment.authorityRef), attachment);
  assert.equal(transactions.filter((item) => item._class === "core:class:TxUpdateDoc").length, 1);
  assert.equal(transactions.filter((item) => item._class === "core:class:TxCreateDoc").length, 2);
  assert.equal(sequence, 5);

  await taskFileAdapter.remove(attachment.authorityRef);
  await blobAdapter.remove(blob.authorityRef);
  await taskAdapter.remove(task.authorityRef);
  assert.equal(attachments.size, 0);
  assert.equal(blobs.size, 0);
  assert.equal(issues.size, 0);
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
