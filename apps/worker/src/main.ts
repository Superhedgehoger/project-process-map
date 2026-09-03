import { InMemoryTransactionalStore } from "../../../packages/domain/src/outbox.ts";
import { startWorker } from "./worker.ts";

const store = new InMemoryTransactionalStore();
const heartbeatMilliseconds = Number.parseInt(process.env.WORKER_HEARTBEAT_MS ?? "30000", 10);

startWorker(store, heartbeatMilliseconds);
