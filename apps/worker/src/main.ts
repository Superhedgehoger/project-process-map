import { createNativeDependencies } from "../../product-api/src/server.ts";
import { startWorker } from "./worker.ts";

const dependencies = createNativeDependencies(process.env);
const heartbeatMilliseconds = Number.parseInt(process.env.WORKER_HEARTBEAT_MS ?? "30000", 10);
const worker = startWorker({
  outbox: dependencies.persistence.outboxConsumer,
  jobs: dependencies.persistence.jobConsumer,
}, heartbeatMilliseconds);

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  worker.stop();
  void dependencies.persistence.close();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
