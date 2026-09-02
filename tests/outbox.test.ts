import assert from "node:assert/strict";
import test from "node:test";
import {
  executeCreateNode,
  InMemoryTransactionalStore,
  type CreateNodeCommand,
  type FailurePoint,
} from "../packages/domain/src/outbox.ts";

function command(overrides: Partial<CreateNodeCommand> = {}): CreateNodeCommand {
  return {
    commandId: "cmd-1",
    idempotencyKey: "request-1",
    correlationId: "cor-1",
    actorId: "user-1",
    projectId: "project-1",
    nodeId: "node-1",
    title: "启动",
    securityDomainId: "security-1",
    occurredAtUtc: "2026-09-02T10:00:00.000Z",
    ...overrides,
  };
}

test("create node commits aggregate, complete event envelope and outbox together", () => {
  const store = new InMemoryTransactionalStore();
  const result = executeCreateNode(store, command());
  const snapshot = store.snapshot();

  assert.equal(result.replayed, false);
  assert.equal(snapshot.aggregates.size, 1);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.outbox.length, 1);
  assert.equal(snapshot.commands.size, 1);
  assert.deepEqual(result.event, {
    eventId: "evt:cmd-1",
    projectId: "project-1",
    projectSequence: 1,
    aggregateType: "project_node",
    aggregateId: "node-1",
    aggregateVersion: 1,
    eventType: "project-map.node.created.v1",
    actorId: "user-1",
    occurredAtUtc: "2026-09-02T10:00:00.000Z",
    correlationId: "cor-1",
    causationId: "cmd-1",
    originalSecurityDomainId: "security-1",
    before: null,
    after: result.node,
    schemaVersion: 1,
  });
  assert.deepEqual(result.outbox.payload, result.event);
  assert.equal(result.outbox.eventId, result.event.eventId);
});

for (const failurePoint of ["after_aggregate", "after_event", "after_outbox", "after_idempotency"] satisfies FailurePoint[]) {
  test(`failure at ${failurePoint} rolls back every local write`, () => {
    const store = new InMemoryTransactionalStore();
    assert.throws(() => executeCreateNode(store, command(), failurePoint), new RegExp(failurePoint));
    const snapshot = store.snapshot();
    assert.equal(snapshot.aggregates.size, 0);
    assert.equal(snapshot.events.length, 0);
    assert.equal(snapshot.outbox.length, 0);
    assert.equal(snapshot.commands.size, 0);
    assert.equal(snapshot.projectSequences.size, 0);
  });
}

test("an exact idempotent replay returns the first result without a second write", () => {
  const store = new InMemoryTransactionalStore();
  const first = executeCreateNode(store, command());
  const replay = executeCreateNode(store, command({ commandId: "cmd-retry", correlationId: "cor-retry" }));
  const snapshot = store.snapshot();

  assert.equal(replay.replayed, true);
  assert.deepEqual({ ...replay, replayed: false }, first);
  assert.equal(snapshot.aggregates.size, 1);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.outbox.length, 1);
  assert.equal(snapshot.commands.size, 1);
});

test("reusing an idempotency key with a different payload is rejected", () => {
  const store = new InMemoryTransactionalStore();
  executeCreateNode(store, command());
  assert.throws(
    () => executeCreateNode(store, command({ title: "篡改后的标题" })),
    /IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD/,
  );
  assert.equal(store.snapshot().events.length, 1);
});

test("project sequence is isolated, unique and increasing", () => {
  const store = new InMemoryTransactionalStore();
  const first = executeCreateNode(store, command());
  const second = executeCreateNode(store, command({
    commandId: "cmd-2",
    idempotencyKey: "request-2",
    nodeId: "node-2",
  }));
  const otherProject = executeCreateNode(store, command({
    commandId: "cmd-3",
    idempotencyKey: "request-3",
    projectId: "project-2",
    nodeId: "node-3",
  }));

  assert.equal(first.event.projectSequence, 1);
  assert.equal(second.event.projectSequence, 2);
  assert.equal(otherProject.event.projectSequence, 1);
  assert.deepEqual(store.snapshot().projectSequences, new Map([["project-1", 2], ["project-2", 1]]));
});

test("duplicate aggregate id is rejected without consuming project sequence", () => {
  const store = new InMemoryTransactionalStore();
  executeCreateNode(store, command());
  assert.throws(
    () => executeCreateNode(store, command({ commandId: "cmd-2", idempotencyKey: "request-2" })),
    /Aggregate already exists/,
  );
  assert.equal(store.snapshot().projectSequences.get("project-1"), 1);
});
