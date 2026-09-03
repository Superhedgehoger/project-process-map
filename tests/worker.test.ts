import assert from "node:assert/strict";
import test from "node:test";
import { startWorker } from "../apps/worker/src/worker.ts";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";

test("ARCH-GATE-WORKER-001 native worker starts, claims queues and stops without an external supervisor", async () => {
  const messages: string[] = [];
  const persistence = new MemoryPersistence();
  const runtime = startWorker(
    { outbox: persistence.outboxConsumer, jobs: persistence.jobConsumer },
    60_000,
    (message) => messages.push(message),
    { workerId: "worker-test" },
  );
  await runtime.runOnce();
  runtime.stop();
  assert.deepEqual(JSON.parse(messages[0] ?? "{}"), { component: "worker", status: "ready", workerId: "worker-test" });
  assert.equal(messages.some((message) => (JSON.parse(message) as { status?: string }).status === "ok"), true);
  await persistence.close();
});

test("P0-ND-01 native worker rejects an invalid heartbeat", () => {
  const persistence = new MemoryPersistence();
  assert.throws(
    () => startWorker({ outbox: persistence.outboxConsumer, jobs: persistence.jobConsumer }, 0),
    /heartbeat must be positive/,
  );
});
