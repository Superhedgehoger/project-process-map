import { createNativeDependencies, startProductApiServer } from "../../product-api/src/server.ts";
import { startWorker } from "../../worker/src/worker.ts";

const dependencies = createNativeDependencies(process.env);
const heartbeatMilliseconds = Number.parseInt(process.env.WORKER_HEARTBEAT_MS ?? "30000", 10);
const worker = startWorker({
  outbox: dependencies.persistence.outboxConsumer,
  jobs: dependencies.persistence.jobConsumer,
}, heartbeatMilliseconds);
const runtime = await startProductApiServer(process.env, dependencies);

console.log(JSON.stringify({
  component: "product-runtime",
  status: "ready",
  url: `http://${runtime.host}:${runtime.port}`,
  adapterMode: process.env.ADAPTER_MODE === "huly" ? "huly" : "memory",
  persistence: "sqlite",
}));

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  worker.stop();
  runtime.server.close((error) => {
    void dependencies.persistence.close().then(() => {
      if (error !== undefined) {
        console.error(JSON.stringify({ component: "product-runtime", status: "stop_failed", message: error.message }));
        process.exitCode = 1;
      }
    });
  });
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
