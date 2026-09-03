import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryBlobAdapter, InMemoryTaskFileAdapter, InMemoryTaskAdapter } from "../packages/adapters/src/in-memory.ts";

test("memory task adapter owns authority fields without node-domain fields", async () => {
  const adapter = new InMemoryTaskAdapter();
  const created = await adapter.create({ authorityKey: "task-1", title: "提交方案", status: "todo" });
  assert.deepEqual(created, {
    authorityRef: "task-authority:task-1",
    title: "提交方案",
    status: "todo",
    syncWatermark: "1",
  });
  assert.deepEqual(await adapter.get(created.authorityRef), created);
  assert.equal(await adapter.health(), "ok");
});

test("memory adapters replay identical authority requests and reject changed payloads", async () => {
  const adapter = new InMemoryTaskFileAdapter();
  const file = {
    authorityKey: "file-1",
    taskAuthorityRef: "task-authority:task-1",
    blobAuthorityRef: "blob-authority:file-1",
    name: "report.pdf",
    contentType: "application/pdf",
    size: 3,
  };
  const first = await adapter.attach(file);
  assert.deepEqual(await adapter.attach(file), first);
  await assert.rejects(adapter.attach({ ...file, name: "changed.pdf" }), /AUTHORITY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD/);
});

test("blob adapter keeps only content authority data", async () => {
  const adapter = new InMemoryBlobAdapter();
  const created = await adapter.upload({
    authorityKey: "blob-1",
    contentType: "text/plain",
    bytes: new TextEncoder().encode("abc"),
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  });
  assert.equal(created.size, 3);
  assert.equal(created.scanState, "available");
  assert.deepEqual(await adapter.get(created.authorityRef), created);
});
