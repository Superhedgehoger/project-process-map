import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryTransactionalStore, recordNodeCreated } from "../packages/domain/src/outbox.ts";

test("domain state, event and outbox commit together", () => {
  const store = new InMemoryTransactionalStore();
  recordNodeCreated(store, { nodeId: "node-1", projectId: "project-1", title: "启动" });
  const snapshot = store.snapshot();
  assert.equal(snapshot.aggregates.size, 1);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.outbox.length, 1);
  assert.equal(snapshot.outbox[0]?.eventId, snapshot.events[0]?.id);
});

test("injected failure rolls back state, event and outbox", () => {
  const store = new InMemoryTransactionalStore();
  assert.throws(
    () => recordNodeCreated(store, { nodeId: "node-1", projectId: "project-1", title: "启动" }, true),
    /Injected transaction failure/,
  );
  const snapshot = store.snapshot();
  assert.equal(snapshot.aggregates.size, 0);
  assert.equal(snapshot.events.length, 0);
  assert.equal(snapshot.outbox.length, 0);
});
