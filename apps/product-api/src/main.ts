import { startProductApiServer, stopProductApiServer } from "./server.ts";

const runtime = await startProductApiServer();
console.log(JSON.stringify({ component: "product-api", status: "ready", host: runtime.host, port: runtime.port }));

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void stopProductApiServer(runtime).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
