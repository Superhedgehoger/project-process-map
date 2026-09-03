import { startProductApiServer } from "./server.ts";

const runtime = await startProductApiServer();
console.log(JSON.stringify({ component: "product-api", status: "ready", host: runtime.host, port: runtime.port }));
