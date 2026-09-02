import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryFileAdapter, InMemoryTaskAdapter } from "../packages/adapters/src/in-memory.ts";

test("memory task adapter preserves the adapter DTO", async () => {
  const adapter = new InMemoryTaskAdapter();
  const created = await adapter.create({ id: "task-1", nodeId: "node-1", title: "提交方案", status: "todo" });
  assert.deepEqual(created, {
    id: "task-1",
    nodeId: "node-1",
    title: "提交方案",
    status: "todo",
    version: 1,
  });
  assert.deepEqual(await adapter.get("task-1"), created);
  assert.equal(await adapter.health(), "ok");
});

test("memory adapters reject duplicate authority records", async () => {
  const adapter = new InMemoryFileAdapter();
  const file = { id: "file-1", nodeId: "node-1", name: "report.pdf", contentType: "application/pdf" };
  await adapter.attach(file);
  await assert.rejects(adapter.attach(file), /already exists/);
});

