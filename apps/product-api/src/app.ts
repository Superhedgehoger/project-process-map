import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ApplicationError,
  NodeTaskFileService,
  type AttachTaskFileCommand,
  type CreateTaskCommand,
} from "../../../packages/application/src/node-task-file.ts";
import {
  InMemoryBlobAdapter,
  InMemoryTaskAdapter,
  InMemoryTaskFileAdapter,
} from "../../../packages/adapters/src/in-memory.ts";
import {
  HulyRestBlobAdapter,
  HulyRestTaskAdapter,
  HulyRestTaskFileAdapter,
  resolveHulyActorId,
  type HulyRestConfig,
} from "../../../packages/adapters/src/huly-rest.ts";
import type { BlobAdapter, TaskAdapter, TaskFileAdapter, TaskAuthorityStatus } from "../../../packages/adapters/src/ports.ts";
import { executeCreateNode, InMemoryTransactionalStore, type ProjectNode } from "../../../packages/domain/src/outbox.ts";
import { buildHealthReport, buildHulyConfigurationReport } from "./health.ts";

export type ProductApiOptions = {
  adapterMode: "memory" | "huly";
  store?: InMemoryTransactionalStore;
  transactionEndpoint?: string | undefined;
  fileEndpoint?: string | undefined;
  workspaceId?: string | undefined;
  hulyProjectId?: string | undefined;
  allowedOrigin?: string | undefined;
};

type AdapterContext = {
  actorId: string;
  taskAdapter: TaskAdapter;
  blobAdapter: BlobAdapter;
  taskFileAdapter: TaskFileAdapter;
};

type JsonBody = Record<string, unknown>;

export function createProductApi(options: ProductApiOptions) {
  const store = options.store ?? new InMemoryTransactionalStore();
  seedPhase0Nodes(store);
  const memoryAdapters = {
    taskAdapter: new InMemoryTaskAdapter(),
    blobAdapter: new InMemoryBlobAdapter(),
    taskFileAdapter: new InMemoryTaskFileAdapter(),
  };

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    setCors(response, options.allowedOrigin ?? "http://localhost:8089");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      const url = new URL(request.url ?? "/", "http://product-api.local");
      if (request.method === "GET" && url.pathname === "/health") {
        const report = options.adapterMode === "memory"
          ? await buildHealthReport(memoryAdapters.taskAdapter, memoryAdapters.taskFileAdapter)
          : buildHulyConfigurationReport(hulyConfigured(options));
        sendJson(response, report.status === "ok" ? 200 : 503, { ...report, adapterMode: options.adapterMode });
        return;
      }

      const context = await adapterContext(request, options, memoryAdapters);
      const service = new NodeTaskFileService(store, context.taskAdapter, context.blobAdapter, context.taskFileAdapter);
      const detailMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)$/);
      if (request.method === "GET" && detailMatch?.[1] !== undefined) {
        sendJson(response, 200, await service.getNodeDetail(decodeURIComponent(detailMatch[1])));
        return;
      }

      const taskMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)\/tasks$/);
      if (request.method === "POST" && taskMatch?.[1] !== undefined) {
        const nodeId = decodeURIComponent(taskMatch[1]);
        const node = store.getNode(nodeId);
        if (node === undefined) throw new ApplicationError("NODE_NOT_FOUND", `Node not found: ${nodeId}`);
        const body = await readJson(request);
        const idempotencyKey = requiredHeader(request, "idempotency-key");
        const actorKey = `${context.actorId}\u0000${idempotencyKey}`;
        const command: CreateTaskCommand = {
          commandId: deterministicPublicId("cmd-task", actorKey),
          idempotencyKey,
          correlationId: request.headers["x-correlation-id"]?.toString() ?? randomUUID(),
          actorId: context.actorId,
          projectId: node.projectId,
          nodeId,
          taskId: optionalString(body.taskId) ?? deterministicPublicId("task", actorKey),
          title: requiredString(body, "title"),
          status: parseTaskStatus(body.status),
          occurredAtUtc: new Date().toISOString(),
        };
        const result = await service.createTask(command);
        sendJson(response, result.replayed ? 200 : 201, result);
        return;
      }

      const fileMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/files$/);
      if (request.method === "POST" && fileMatch?.[1] !== undefined) {
        const taskId = decodeURIComponent(fileMatch[1]);
        const body = await readJson(request);
        const idempotencyKey = requiredHeader(request, "idempotency-key");
        const actorKey = `${context.actorId}\u0000${idempotencyKey}`;
        const contentBase64 = requiredString(body, "contentBase64");
        const bytes = Uint8Array.from(Buffer.from(contentBase64, "base64"));
        if (bytes.byteLength === 0 || bytes.byteLength > 2 * 1024 * 1024) {
          throw new ApplicationError("FILE_SIZE_INVALID", "Phase 0 files must be between 1 byte and 2 MiB");
        }
        const mapping = store.getProjection<{ projectId: string }>("node_task_mapping", taskId);
        if (mapping === undefined) throw new ApplicationError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
        const command: AttachTaskFileCommand = {
          commandId: deterministicPublicId("cmd-file", actorKey),
          idempotencyKey,
          correlationId: request.headers["x-correlation-id"]?.toString() ?? randomUUID(),
          actorId: context.actorId,
          projectId: mapping.projectId,
          taskId,
          fileId: optionalString(body.fileId) ?? deterministicPublicId("file", actorKey),
          name: requiredString(body, "name"),
          contentType: requiredString(body, "contentType"),
          bytes,
          sha256: optionalString(body.sha256) ?? createHash("sha256").update(bytes).digest("hex"),
          occurredAtUtc: new Date().toISOString(),
        };
        const result = await service.attachTaskFile(command);
        sendJson(response, result.replayed ? 200 : 201, result);
        return;
      }

      sendJson(response, 404, { code: "NOT_FOUND", message: "Route not found" });
    } catch (error) {
      const status = httpStatus(error);
      sendJson(response, status, {
        code: error instanceof ApplicationError ? error.code : status === 401 ? "UNAUTHORIZED" : "UPSTREAM_FAILURE",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

function hulyConfigured(options: ProductApiOptions): boolean {
  return options.transactionEndpoint !== undefined
    && options.fileEndpoint !== undefined
    && options.hulyProjectId !== undefined;
}

export function seedPhase0Nodes(store: InMemoryTransactionalStore): void {
  const nodes: Array<Pick<ProjectNode, "id" | "title" | "kind">> = [
    { id: "N-01", title: "项目启动", kind: "stage" },
    { id: "N-02", title: "需求澄清", kind: "stage" },
    { id: "N-03", title: "方案设计", kind: "work_package" },
    { id: "N-04", title: "开发与联调", kind: "work_package" },
    { id: "N-05", title: "测试验收", kind: "work_package" },
    { id: "N-06", title: "发布复盘", kind: "milestone" },
  ];
  for (const [index, node] of nodes.entries()) {
    if (store.getNode(node.id) !== undefined) continue;
    executeCreateNode(store, {
      commandId: `phase0-node-${index + 1}`,
      idempotencyKey: `phase0-node-${index + 1}`,
      correlationId: "phase0-seed",
      actorId: "phase0-system",
      projectId: "phase0-project",
      nodeId: node.id,
      title: node.title,
      kind: node.kind,
      securityDomainId: null,
      occurredAtUtc: "2026-09-03T00:00:00.000Z",
    });
  }
}

async function adapterContext(
  request: IncomingMessage,
  options: ProductApiOptions,
  memory: Omit<AdapterContext, "actorId">,
): Promise<AdapterContext> {
  if (options.adapterMode === "memory") return { actorId: "phase0-user", ...memory };
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer ")) throw new ApplicationError("UNAUTHORIZED", "Bearer token is required");
  const actorToken = authorization.slice("Bearer ".length).trim();
  if (actorToken.length === 0) throw new ApplicationError("UNAUTHORIZED", "Bearer token is required");
  const workspaceId = options.workspaceId ?? request.headers["x-huly-workspace"]?.toString();
  if (workspaceId === undefined) throw new ApplicationError("HULY_WORKSPACE_REQUIRED", "Huly workspace is required");
  if (options.transactionEndpoint === undefined || options.fileEndpoint === undefined || options.hulyProjectId === undefined) {
    throw new ApplicationError("HULY_ADAPTER_NOT_CONFIGURED", "Huly adapter endpoints and project are required");
  }
  const config: HulyRestConfig = {
    transactionEndpoint: options.transactionEndpoint,
    fileEndpoint: options.fileEndpoint,
    workspaceId,
    projectId: options.hulyProjectId,
    actorToken,
  };
  return {
    actorId: await resolveHulyActorId(config),
    taskAdapter: new HulyRestTaskAdapter(config),
    blobAdapter: new HulyRestBlobAdapter(config),
    taskFileAdapter: new HulyRestTaskFileAdapter(config),
  };
}

async function readJson(request: IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 3 * 1024 * 1024) throw new ApplicationError("REQUEST_TOO_LARGE", "Request body exceeds 3 MiB");
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    return value as JsonBody;
  } catch {
    throw new ApplicationError("INVALID_JSON", "Request body must be a JSON object");
  }
}

function requiredHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name]?.toString().trim();
  if (value === undefined || value.length === 0) throw new ApplicationError("IDEMPOTENCY_KEY_REQUIRED", `${name} header is required`);
  return value;
}

function requiredString(body: JsonBody, name: string): string {
  const value = optionalString(body[name]);
  if (value === undefined) throw new ApplicationError("VALIDATION_FAILED", `${name} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseTaskStatus(value: unknown): TaskAuthorityStatus {
  const status = value ?? "todo";
  if (status === "todo" || status === "in_progress" || status === "completed" || status === "canceled") return status;
  throw new ApplicationError("VALIDATION_FAILED", "status is invalid for an authority task");
}

function deterministicPublicId(prefix: string, key: string): string {
  return `${prefix}-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function httpStatus(error: unknown): number {
  if (!(error instanceof ApplicationError)) return 502;
  if (error.code === "UNAUTHORIZED") return 401;
  if (error.code.endsWith("NOT_FOUND")) return 404;
  if (error.code.includes("ALREADY_EXISTS") || error.code === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD" || error.code.includes("RECOVERY")) return 409;
  if (error.code.includes("CONFIGURED") || error.code.includes("WORKSPACE_REQUIRED")) return 503;
  return 422;
}

function setCors(response: ServerResponse, origin: string): void {
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "origin");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "authorization,content-type,idempotency-key,x-correlation-id,x-huly-workspace");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
