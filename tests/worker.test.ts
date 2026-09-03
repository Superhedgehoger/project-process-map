import assert from "node:assert/strict";
import test from "node:test";
import { startWorker } from "../apps/worker/src/worker.ts";
import { InMemoryTransactionalStore } from "../packages/domain/src/outbox.ts";

test("P0-ND-01 native worker starts and stops without an external supervisor", () => {
  const messages: string[] = [];
  const runtime = startWorker(new InMemoryTransactionalStore(), 60_000, (message) => messages.push(message));
  runtime.stop();
  assert.deepEqual(JSON.parse(messages[0] ?? "{}"), { component: "worker", status: "ready", outboxDepth: 0 });
});

test("P0-ND-01 native worker rejects an invalid heartbeat", () => {
  assert.throws(() => startWorker(new InMemoryTransactionalStore(), 0), /heartbeat must be positive/);
});
