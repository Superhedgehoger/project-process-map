import { InMemoryTransactionalStore } from "../../../packages/domain/src/outbox.ts";

const store = new InMemoryTransactionalStore();
const heartbeatMilliseconds = Number.parseInt(process.env.WORKER_HEARTBEAT_MS ?? "30000", 10);

console.log(JSON.stringify({ component: "worker", status: "ready", outboxDepth: 0 }));
setInterval(() => {
  console.log(JSON.stringify({
    component: "worker",
    status: "ok",
    checkedAt: new Date().toISOString(),
    outboxDepth: store.snapshot().outbox.length,
  }));
}, heartbeatMilliseconds).unref();

