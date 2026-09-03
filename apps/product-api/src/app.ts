import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AttachTaskAssetHandler, listTaskAssets } from "../../../packages/application/src/assets/attach-task-asset.ts";
import { executeCreateNode } from "../../../packages/application/src/create-node.ts";
import { ApplicationError, asApplicationError } from "../../../packages/application/src/errors.ts";
import type { AssetContentPort } from "../../../packages/application/src/ports/integrations.ts";
import type { Persistence } from "../../../packages/application/src/ports/persistence.ts";
import { CreateTaskHandler, listTasksForNode } from "../../../packages/application/src/tasks/create-task.ts";
import { MemoryAssetContent } from "../../../packages/adapters/src/memory/asset-content.ts";
import { MemoryPersistence } from "../../../packages/adapters/src/memory/persistence.ts";
import { resolveHulyActorId, type HulyRestConfig } from "../../../packages/adapters/src/huly-rest.ts";
import { principalId, tenantId, type PrincipalId, type TenantId } from "../../../packages/domain/src/identity.ts";
import type { ProjectNode } from "../../../packages/domain/src/project-structure.ts";
import type { ApiNode } from "../../../packages/contracts/src/project-process-map-api.ts";
import { buildHulyConfigurationReport } from "./health.ts";
import { productWebHtml } from "./web.ts";

export type ProductApiOptions = {
  collaborationMode: "disabled" | "huly";
  persistence?: Persistence;
  assetContent?: AssetContentPort;
  tenantId?: TenantId;
  transactionEndpoint?: string | undefined;
  fileEndpoint?: string | undefined;
  workspaceId?: string | undefined;
  hulyProjectId?: string | undefined;
  hulyServiceToken?: string | undefined;
  allowedOrigin?: string | undefined;
};

type JsonBody = Record<string, unknown>;
type RequestIdentity = Readonly<{ tenantId: TenantId; principalId: PrincipalId }>;

export function createProductApi(options: ProductApiOptions) {
  const persistence = options.persistence ?? new MemoryPersistence();
  const content = options.assetContent ?? new MemoryAssetContent();
  const productTenantId = options.tenantId ?? tenantId("phase0-tenant");
  const ready = seedPhase0Nodes(persistence, productTenantId);

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    setCors(response, options.allowedOrigin ?? "http://localhost:8089");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    try {
      const url = new URL(request.url ?? "/", "http://product-api.local");
      if (request.method === "GET" && url.pathname === "/") {
        sendHtml(response, productWebHtml);
        return;
      }
      if (request.method === "GET" && url.pathname === "/health") {
        const report = options.collaborationMode === "huly"
          ? buildHulyConfigurationReport(hulyConfigured(options))
          : nativeHealthReport();
        sendJson(response, report.status === "ok" ? 200 : 503, { ...report, collaborationMode: options.collaborationMode });
        return;
      }

      await ready;
      const identity = await requestIdentity(request, options, productTenantId);
      if (request.method === "GET" && url.pathname === "/api/nodes") {
        const nodes = await persistence.read(identity.tenantId, async (transaction) => await transaction.nodes.listByProject("phase0-project"));
        sendJson(response, 200, nodes.map(publicNode).sort((left, right) => left.id.localeCompare(right.id)));
        return;
      }

      const detailMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)$/);
      if (request.method === "GET" && detailMatch?.[1] !== undefined) {
        const nodeId = decodeURIComponent(detailMatch[1]);
        const node = await persistence.read(identity.tenantId, async (transaction) => await transaction.nodes.get(nodeId));
        if (node === undefined) throw new ApplicationError("NODE_NOT_FOUND", `Node not found: ${nodeId}`);
        const tasks = await listTasksForNode(persistence, identity.tenantId, nodeId);
        const withAssets = await Promise.all(tasks.map(async (task) => ({
          ...task,
          files: await listTaskAssets(persistence, identity.tenantId, task.id),
        })));
        sendJson(response, 200, { node: publicNode(node), tasks: withAssets });
        return;
      }

      const taskMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)\/tasks$/);
      if (request.method === "POST" && taskMatch?.[1] !== undefined) {
        const nodeId = decodeURIComponent(taskMatch[1]);
        const node = await persistence.read(identity.tenantId, async (transaction) => await transaction.nodes.get(nodeId));
        if (node === undefined) throw new ApplicationError("NODE_NOT_FOUND", `Node not found: ${nodeId}`);
        const body = await readJson(request);
        const idempotencyKey = requiredHeader(request, "idempotency-key");
        const principalKey = `${identity.tenantId}\u0000${identity.principalId}\u0000${idempotencyKey}`;
        const result = await new CreateTaskHandler(persistence, {
          scheduleCollaborationProjection: hulyConfigured(options),
        }).execute({
          tenantId: identity.tenantId,
          commandId: deterministicPublicId("cmd-task", principalKey),
          idempotencyKey,
          correlationId: request.headers["x-correlation-id"]?.toString() ?? randomUUID(),
          principalId: identity.principalId,
          projectId: node.projectId,
          nodeId,
          taskId: optionalString(body.taskId) ?? deterministicPublicId("task", principalKey),
          title: requiredString(body, "title"),
          assigneePrincipalId: null,
          requiresAcceptance: body.requiresAcceptance === true,
          occurredAtUtc: new Date().toISOString(),
        });
        sendJson(response, result.replayed ? 200 : 201, result);
        return;
      }

      const fileMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/files$/);
      if (request.method === "POST" && fileMatch?.[1] !== undefined) {
        const taskId = decodeURIComponent(fileMatch[1]);
        const task = await persistence.read(identity.tenantId, async (transaction) => await transaction.tasks.get(taskId));
        if (task === undefined) throw new ApplicationError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
        const body = await readJson(request);
        const idempotencyKey = requiredHeader(request, "idempotency-key");
        const principalKey = `${identity.tenantId}\u0000${identity.principalId}\u0000${idempotencyKey}`;
        const contentBase64 = requiredString(body, "contentBase64");
        const bytes = Uint8Array.from(Buffer.from(contentBase64, "base64"));
        if (bytes.byteLength === 0 || bytes.byteLength > 2 * 1024 * 1024) {
          throw new ApplicationError("FILE_SIZE_INVALID", "Phase 0 files must be between 1 byte and 2 MiB");
        }
        const occurredAtUtc = new Date().toISOString();
        const result = await new AttachTaskAssetHandler(persistence, content, {
          scheduleCollaborationProjection: hulyConfigured(options),
        }).execute({
          tenantId: identity.tenantId,
          commandId: deterministicPublicId("cmd-asset", principalKey),
          idempotencyKey,
          correlationId: request.headers["x-correlation-id"]?.toString() ?? randomUUID(),
          principalId: identity.principalId,
          projectId: task.projectId,
          taskId,
          assetId: optionalString(body.fileId) ?? deterministicPublicId("asset", principalKey),
          displayName: requiredString(body, "name"),
          contentType: requiredString(body, "contentType"),
          bytes,
          sha256: optionalString(body.sha256) ?? createHash("sha256").update(bytes).digest("hex"),
          occurredAtUtc,
          deadlineAtUtc: new Date(Date.parse(occurredAtUtc) + 5 * 60_000).toISOString(),
        });
        sendJson(response, result.replayed ? 200 : 201, result);
        return;
      }

      sendJson(response, 404, { code: "NOT_FOUND", message: "Route not found" });
    } catch (cause) {
      const error = asApplicationError(cause);
      sendJson(response, httpStatus(error), { code: error.code, message: error.message });
    }
  };
}

export async function seedPhase0Nodes(persistence: Persistence, productTenantId: TenantId): Promise<void> {
  const nodes: Array<Pick<ProjectNode, "id" | "title" | "kind">> = [
    { id: "N-01", title: "项目启动", kind: "stage" },
    { id: "N-02", title: "需求澄清", kind: "stage" },
    { id: "N-03", title: "方案设计", kind: "work_package" },
    { id: "N-04", title: "开发与联调", kind: "work_package" },
    { id: "N-05", title: "测试验收", kind: "work_package" },
    { id: "N-06", title: "发布复盘", kind: "milestone" },
  ];
  for (const [index, node] of nodes.entries()) {
    if (await persistence.read(productTenantId, async (transaction) => await transaction.nodes.get(node.id)) !== undefined) continue;
    await executeCreateNode(persistence, {
      tenantId: productTenantId,
      commandId: `phase0-node-${index + 1}`,
      idempotencyKey: `phase0-node-${index + 1}`,
      correlationId: "phase0-seed",
      principalId: principalId("phase0-system"),
      projectId: "phase0-project",
      nodeId: node.id,
      parentId: null,
      title: node.title,
      kind: node.kind,
      securityDomainId: null,
      occurredAtUtc: "2026-09-03T00:00:00.000Z",
    });
  }
}

async function requestIdentity(request: IncomingMessage, options: ProductApiOptions, productTenantId: TenantId): Promise<RequestIdentity> {
  if (options.collaborationMode === "disabled") return { tenantId: productTenantId, principalId: principalId("phase0-user") };
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer ")) throw new ApplicationError("UNAUTHORIZED", "Bearer token is required");
  const actorToken = authorization.slice("Bearer ".length).trim();
  if (actorToken.length === 0) throw new ApplicationError("UNAUTHORIZED", "Bearer token is required");
  if (options.transactionEndpoint === undefined || options.fileEndpoint === undefined || options.workspaceId === undefined || options.hulyProjectId === undefined) {
    throw new ApplicationError("HULY_ADAPTER_NOT_CONFIGURED", "Huly connection is not configured");
  }
  const config: HulyRestConfig = {
    transactionEndpoint: options.transactionEndpoint,
    fileEndpoint: options.fileEndpoint,
    workspaceId: options.workspaceId,
    projectId: options.hulyProjectId,
    actorToken,
  };
  const externalActor = await resolveHulyActorId(config);
  return {
    tenantId: productTenantId,
    principalId: principalId(`principal-${createHash("sha256").update(`${options.workspaceId}\u0000${externalActor}`).digest("hex").slice(0, 24)}`),
  };
}

function publicNode(node: ProjectNode): ApiNode {
  return { id: node.id, projectId: node.projectId, parentId: node.parentId, title: node.title, kind: node.kind, version: node.version };
}

function hulyConfigured(options: ProductApiOptions): boolean {
  return options.transactionEndpoint !== undefined
    && options.fileEndpoint !== undefined
    && options.workspaceId !== undefined
    && options.hulyProjectId !== undefined
    && options.hulyServiceToken !== undefined;
}

function nativeHealthReport() {
  return {
    status: "ok" as const,
    checkedAt: new Date().toISOString(),
    components: [
      { component: "product-api", status: "ok" as const, version: "0.0.1" },
      { component: "persistence", status: "ok" as const, version: "application-port" },
      { component: "asset-content", status: "ok" as const, version: "application-port" },
    ],
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

function deterministicPublicId(prefix: string, key: string): string {
  return `${prefix}-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function httpStatus(error: ApplicationError): number {
  const statuses: Partial<Record<ApplicationError["code"], number>> = {
    UNAUTHORIZED: 401,
    NOT_FOUND: 404,
    NODE_NOT_FOUND: 404,
    TASK_NOT_FOUND: 404,
    TASK_ALREADY_EXISTS: 409,
    ASSET_ALREADY_EXISTS: 409,
    IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD: 409,
    CONFLICT: 409,
    HULY_ADAPTER_NOT_CONFIGURED: 503,
    UPSTREAM_FAILURE: 502,
  };
  return statuses[error.code] ?? 422;
}

function setCors(response: ServerResponse, origin: string): void {
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "origin");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "authorization,content-type,idempotency-key,x-correlation-id");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}
