import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { CollaborationProjectionProcessor } from "../../../packages/application/src/integrations/project-collaboration.ts";
import type { AssetContentPort } from "../../../packages/application/src/ports/integrations.ts";
import type { JobConsumer, OutboxConsumer, Persistence } from "../../../packages/application/src/ports/persistence.ts";
import { FilesystemAssetContent } from "../../../packages/adapters/src/filesystem/asset-content.ts";
import {
  HulyRestBlobProjectionAdapter,
  HulyRestIdentityVerifier,
  HulyRestTaskFileProjectionAdapter,
  HulyRestTaskProjectionAdapter,
  type HulyRestConfig,
} from "../../../packages/adapters/src/huly-rest.ts";
import { SqlitePersistence } from "../../../packages/adapters/src/sqlite/persistence.ts";
import type { BackgroundJob } from "../../../packages/domain/src/events.ts";
import { tenantId } from "../../../packages/domain/src/identity.ts";
import { principalId } from "../../../packages/domain/src/identity.ts";
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

export function createNativeJobProcessor(
  environment: NodeJS.ProcessEnv,
  dependencies: NativeProductApiDependencies,
): ((job: BackgroundJob) => Promise<void>) | undefined {
  if (configuredCollaborationMode(environment) !== "huly") return undefined;
  const config = hulyWorkerConfig(environment);
  if (config === undefined) return undefined;
  const processor = new CollaborationProjectionProcessor({
    persistence: dependencies.persistence,
    assetContent: dependencies.assetContent,
    tasks: new HulyRestTaskProjectionAdapter(config),
    blobs: new HulyRestBlobProjectionAdapter(config),
    taskFiles: new HulyRestTaskFileProjectionAdapter(config),
  });
  return async (job) => await processor.process(job);
}

export async function startProductApiServer(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies?: ProductApiDependencies,
): Promise<ProductApiRuntime> {
  const port = parsePort(environment.PORT ?? "4100");
  const host = environment.HOST?.trim() || "127.0.0.1";
  if (!isLoopbackHost(host)) throw new Error("PUBLIC_BIND_REQUIRES_P0_07");
  const runtimeDependencies = dependencies ?? createNativeDependencies(environment);
  const identityVerifier = hulyIdentityVerifier(environment);
  const options: ProductApiOptions = {
    collaborationMode: configuredCollaborationMode(environment),
    persistence: runtimeDependencies.persistence,
    assetContent: runtimeDependencies.assetContent,
    tenantId: tenantId(environment.PRODUCT_TENANT_ID?.trim() || "phase0-tenant"),
    ...(identityVerifier === undefined ? {} : { externalIdentityVerifier: identityVerifier }),
    collaborationProjectionConfigured: hulyWorkerConfig(environment) !== undefined,
    ...(environment.PRODUCT_UI_ORIGIN === undefined ? {} : { allowedOrigin: environment.PRODUCT_UI_ORIGIN }),
    recoveryOperatorPrincipalIds: (environment.RECOVERY_OPERATOR_PRINCIPAL_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .map(principalId),
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

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function hulyWorkerConfig(environment: NodeJS.ProcessEnv): HulyRestConfig | undefined {
  const transactionEndpoint = environment.HULY_TRANSACTION_ENDPOINT?.trim();
  const fileEndpoint = environment.HULY_FILE_ENDPOINT?.trim();
  const workspaceId = environment.HULY_WORKSPACE_ID?.trim();
  const projectId = environment.HULY_PROJECT_ID?.trim();
  const actorToken = environment.HULY_SERVICE_TOKEN?.trim();
  if (!transactionEndpoint || !fileEndpoint || !workspaceId || !projectId || !actorToken) return undefined;
  const timeout = Number.parseInt(environment.HULY_REQUEST_TIMEOUT_MS ?? "10000", 10);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("HULY_REQUEST_TIMEOUT_MS must be a positive integer");
  return { transactionEndpoint, fileEndpoint, workspaceId, projectId, actorToken, requestTimeoutMilliseconds: timeout };
}

function configuredCollaborationMode(environment: NodeJS.ProcessEnv): "disabled" | "huly" {
  return environment.COLLABORATION_MODE === "huly" || environment.ADAPTER_MODE === "huly" ? "huly" : "disabled";
}

function hulyIdentityVerifier(environment: NodeJS.ProcessEnv): HulyRestIdentityVerifier | undefined {
  const transactionEndpoint = environment.HULY_TRANSACTION_ENDPOINT?.trim();
  const fileEndpoint = environment.HULY_FILE_ENDPOINT?.trim();
  const workspaceId = environment.HULY_WORKSPACE_ID?.trim();
  const projectId = environment.HULY_PROJECT_ID?.trim();
  if (!transactionEndpoint || !fileEndpoint || !workspaceId || !projectId) return undefined;
  return new HulyRestIdentityVerifier({
    transactionEndpoint,
    fileEndpoint,
    workspaceId,
    projectId,
    connectionId: environment.HULY_CONNECTION_ID?.trim() || "huly-primary",
  });
}
