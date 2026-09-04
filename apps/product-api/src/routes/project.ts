import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AttachTaskAssetHandler, listTaskAssets } from "../../../../packages/application/src/assets/attach-task-asset.ts";
import { ApplicationError } from "../../../../packages/application/src/errors.ts";
import type { AssetContentPort } from "../../../../packages/application/src/ports/integrations.ts";
import type { Persistence } from "../../../../packages/application/src/ports/persistence.ts";
import { CreateTaskHandler, listTasksForNode } from "../../../../packages/application/src/tasks/create-task.ts";
import type { ApiNode } from "../../../../packages/contracts/src/project-process-map-api.ts";
import type { PrincipalId, TenantId } from "../../../../packages/domain/src/identity.ts";
import type { ProjectNode } from "../../../../packages/domain/src/project-structure.ts";
import { deterministicPublicId, optionalString, readJson, requiredHeader, requiredString, sendJson } from "../http.ts";

export type ProductRequestIdentity = Readonly<{ tenantId: TenantId; principalId: PrincipalId }>;
export type ProjectRouteDependencies = Readonly<{
  persistence: Persistence;
  assetContent: AssetContentPort;
  scheduleCollaborationProjection: boolean;
}>;

export async function routeProjectRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  identity: ProductRequestIdentity,
  dependencies: ProjectRouteDependencies,
): Promise<boolean> {
  const { persistence } = dependencies;
  if (request.method === "GET" && url.pathname === "/api/nodes") {
    const nodes = await persistence.read(identity.tenantId, async (transaction) => await transaction.nodes.listByProject("phase0-project"));
    sendJson(response, 200, nodes.map(publicNode).sort((left, right) => left.id.localeCompare(right.id)));
    return true;
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
    return true;
  }
  const taskMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)\/tasks$/);
  if (request.method === "POST" && taskMatch?.[1] !== undefined) {
    const nodeId = decodeURIComponent(taskMatch[1]);
    const node = await persistence.read(identity.tenantId, async (transaction) => await transaction.nodes.get(nodeId));
    if (node === undefined) throw new ApplicationError("NODE_NOT_FOUND", `Node not found: ${nodeId}`);
    const body = await readJson(request);
    const idempotencyKey = requiredHeader(request, "idempotency-key");
    const principalKey = commandKey(identity, idempotencyKey);
    const result = await new CreateTaskHandler(persistence, {
      scheduleCollaborationProjection: dependencies.scheduleCollaborationProjection,
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
    return true;
  }
  const fileMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/files$/);
  if (request.method === "POST" && fileMatch?.[1] !== undefined) {
    const taskId = decodeURIComponent(fileMatch[1]);
    const task = await persistence.read(identity.tenantId, async (transaction) => await transaction.tasks.get(taskId));
    if (task === undefined) throw new ApplicationError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
    const body = await readJson(request);
    const idempotencyKey = requiredHeader(request, "idempotency-key");
    const principalKey = commandKey(identity, idempotencyKey);
    const contentBase64 = requiredString(body, "contentBase64");
    const bytes = Uint8Array.from(Buffer.from(contentBase64, "base64"));
    if (bytes.byteLength === 0 || bytes.byteLength > 2 * 1024 * 1024) throw new ApplicationError("FILE_SIZE_INVALID", "Files must be between 1 byte and 2 MiB");
    const occurredAtUtc = new Date().toISOString();
    const result = await new AttachTaskAssetHandler(persistence, dependencies.assetContent, {
      scheduleCollaborationProjection: dependencies.scheduleCollaborationProjection,
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
    return true;
  }
  return false;
}

function commandKey(identity: ProductRequestIdentity, idempotencyKey: string): string {
  return `${identity.tenantId}\u0000${identity.principalId}\u0000${idempotencyKey}`;
}

function publicNode(node: ProjectNode): ApiNode {
  return { id: node.id, projectId: node.projectId, parentId: node.parentId, title: node.title, kind: node.kind, version: node.version };
}
