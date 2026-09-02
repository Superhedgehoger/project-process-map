import { createServer } from "node:http";
import { InMemoryFileAdapter, InMemoryTaskAdapter } from "../../../packages/adapters/src/in-memory.ts";
import { buildHealthReport } from "./health.ts";

const taskAdapter = new InMemoryTaskAdapter();
const fileAdapter = new InMemoryFileAdapter();
const port = Number.parseInt(process.env.PORT ?? "4100", 10);

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    const report = await buildHealthReport(taskAdapter, fileAdapter);
    response.writeHead(report.status === "ok" ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify(report));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ code: "NOT_FOUND", message: "Route not found" }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ component: "product-api", status: "ready", port }));
});

