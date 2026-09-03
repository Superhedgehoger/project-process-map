import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { InMemoryTransactionalStore } from "../../../packages/domain/src/outbox.ts";
import { createProductApi, type ProductApiOptions } from "./app.ts";

export type ProductApiRuntime = {
  host: string;
  port: number;
  server: Server;
};

export async function startProductApiServer(
  environment: NodeJS.ProcessEnv = process.env,
  store = new InMemoryTransactionalStore(),
): Promise<ProductApiRuntime> {
  const port = parsePort(environment.PORT ?? "4100");
  const host = environment.HOST?.trim() || "127.0.0.1";
  const options: ProductApiOptions = {
    adapterMode: environment.ADAPTER_MODE === "huly" ? "huly" : "memory",
    store,
    ...(environment.HULY_TRANSACTION_ENDPOINT === undefined ? {} : { transactionEndpoint: environment.HULY_TRANSACTION_ENDPOINT }),
    ...(environment.HULY_FILE_ENDPOINT === undefined ? {} : { fileEndpoint: environment.HULY_FILE_ENDPOINT }),
    ...(environment.HULY_WORKSPACE_ID === undefined ? {} : { workspaceId: environment.HULY_WORKSPACE_ID }),
    ...(environment.HULY_PROJECT_ID === undefined ? {} : { hulyProjectId: environment.HULY_PROJECT_ID }),
    ...(environment.PRODUCT_UI_ORIGIN === undefined ? {} : { allowedOrigin: environment.PRODUCT_UI_ORIGIN }),
  };
  const server = createServer(createProductApi(options));
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error("Product API did not expose a listening address");
  return { host, port: address.port, server };
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid PORT: ${value}`);
  return port;
}
