import { createServer } from "node:http";
import { createProductApi } from "./app.ts";

const port = Number.parseInt(process.env.PORT ?? "4100", 10);
const adapterMode = process.env.ADAPTER_MODE === "huly" ? "huly" : "memory";
const server = createServer(createProductApi({
  adapterMode,
  transactionEndpoint: process.env.HULY_TRANSACTION_ENDPOINT,
  fileEndpoint: process.env.HULY_FILE_ENDPOINT,
  workspaceId: process.env.HULY_WORKSPACE_ID,
  hulyProjectId: process.env.HULY_PROJECT_ID,
  allowedOrigin: process.env.PRODUCT_UI_ORIGIN,
}));

server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ component: "product-api", status: "ready", port }));
});
