import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import type { AssetContentPort } from "../../../packages/application/src/ports/integrations.ts";
import type { JobConsumer, OutboxConsumer, Persistence } from "../../../packages/application/src/ports/persistence.ts";
import { FilesystemAssetContent } from "../../../packages/adapters/src/filesystem/asset-content.ts";
import { SqlitePersistence } from "../../../packages/adapters/src/sqlite/persistence.ts";
import { tenantId } from "../../../packages/domain/src/identity.ts";
import { createProductApi, type ProductApiOptions } from "./app.ts";

export type ProductApiRuntime = {
  host: string;
  port: number;
  server: Server;
  persistence: Persistence;
  ownsPersistence: boolean;
};

export type ProductApiDependencies = Readonly<{
  persistence: Persistence;
  assetContent: AssetContentPort;
}>;

export type NativeProductApiDependencies = Readonly<{
  persistence: Persistence & { readonly outboxConsumer: OutboxConsumer; readonly jobConsumer: JobConsumer };
  assetContent: AssetContentPort;
}>;

export function createNativeDependencies(environment: NodeJS.ProcessEnv = process.env): NativeProductApiDependencies {
  const dataDirectory = resolve(environment.PROJECT_DATA_DIR?.trim() || "data");
  const databasePath = resolve(environment.DATABASE_PATH?.trim() || resolve(dataDirectory, "project-process-map.sqlite"));
  const assetDirectory = resolve(environment.ASSET_CONTENT_DIR?.trim() || resolve(dataDirectory, "assets"));
  return {
    persistence: new SqlitePersistence({ path: databasePath }),
    assetContent: new FilesystemAssetContent(assetDirectory),
  };
}

export async function startProductApiServer(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies?: ProductApiDependencies,
): Promise<ProductApiRuntime> {
  const runtimeDependencies = dependencies ?? createNativeDependencies(environment);
  const port = parsePort(environment.PORT ?? "4100");
  const host = environment.HOST?.trim() || "127.0.0.1";
  const options: ProductApiOptions = {
    adapterMode: environment.ADAPTER_MODE === "huly" ? "huly" : "memory",
    persistence: runtimeDependencies.persistence,
    assetContent: runtimeDependencies.assetContent,
    tenantId: tenantId(environment.PRODUCT_TENANT_ID?.trim() || "phase0-tenant"),
    ...(environment.HULY_TRANSACTION_ENDPOINT === undefined ? {} : { transactionEndpoint: environment.HULY_TRANSACTION_ENDPOINT }),
    ...(environment.HULY_FILE_ENDPOINT === undefined ? {} : { fileEndpoint: environment.HULY_FILE_ENDPOINT }),
    ...(environment.HULY_WORKSPACE_ID === undefined ? {} : { workspaceId: environment.HULY_WORKSPACE_ID }),
    ...(environment.HULY_PROJECT_ID === undefined ? {} : { hulyProjectId: environment.HULY_PROJECT_ID }),
    ...(environment.HULY_SERVICE_TOKEN === undefined ? {} : { hulyServiceToken: environment.HULY_SERVICE_TOKEN }),
    ...(environment.PRODUCT_UI_ORIGIN === undefined ? {} : { allowedOrigin: environment.PRODUCT_UI_ORIGIN }),
  };
  const server = createServer(createProductApi(options));
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error("Product API did not expose a listening address");
  return {
    host,
    port: address.port,
    server,
    persistence: runtimeDependencies.persistence,
    ownsPersistence: dependencies === undefined,
  };
}

export async function stopProductApiServer(runtime: ProductApiRuntime): Promise<void> {
  await new Promise<void>((resolveClose, reject) => runtime.server.close((error) => error === undefined ? resolveClose() : reject(error)));
  if (runtime.ownsPersistence) await runtime.persistence.close();
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid PORT: ${value}`);
  return port;
}
