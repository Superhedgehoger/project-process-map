import { InMemoryTransactionalStore } from "../../../packages/domain/src/outbox.ts";
import { startProductApiServer } from "../../product-api/src/server.ts";
import { startWorker } from "../../worker/src/worker.ts";

const store = new InMemoryTransactionalStore();
const heartbeatMilliseconds = Number.parseInt(process.env.WORKER_HEARTBEAT_MS ?? "30000", 10);
const worker = startWorker(store, heartbeatMilliseconds);
const runtime = await startProductApiServer(process.env, store);

console.log(JSON.stringify({
  component: "product-runtime",
  status: "ready",
  url: `http://${runtime.host}:${runtime.port}`,
  adapterMode: process.env.ADAPTER_MODE === "huly" ? "huly" : "memory",
}));

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  worker.stop();
  runtime.server.close((error) => {
    if (error !== undefined) {
      console.error(JSON.stringify({ component: "product-runtime", status: "stop_failed", message: error.message }));
      process.exitCode = 1;
    }
  });
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
