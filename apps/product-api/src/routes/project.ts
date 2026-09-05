import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AttachTaskAssetHandler, listTaskAssetsInTransaction } from "../../../../packages/application/src/assets/attach-task-asset.ts";
import { ApplicationError } from "../../../../packages/application/src/errors.ts";
import { assertProjectSecurityStable, canAccessProjectObject } from "../../../../packages/application/src/access/project-security.ts";
import type { AssetContentPort } from "../../../../packages/application/src/ports/integrations.ts";
import type { Persistence } from "../../../../packages/application/src/ports/persistence.ts";
import { ActOnTaskHandler, type TaskCommandAction } from "../../../../packages/application/src/tasks/act-on-task.ts";
import { CreateTaskHandler, listTasksForNodeInTransaction } from "../../../../packages/application/src/tasks/create-task.ts";
import { CreateSecurityRootHandler } from "../../../../packages/application/src/security/create-security-root.ts";
import { ManageSecurityGrantHandler } from "../../../../packages/application/src/security/manage-security-grant.ts";
import type { ApiNode } from "../../../../packages/contracts/src/project-process-map-api.ts";
import { principalId, type PrincipalId, type TenantId } from "../../../../packages/domain/src/identity.ts";
import type { ProjectNode } from "../../../../packages/domain/src/project-structure.ts";
import { isCanonicalUtcTimestamp } from "../../../../packages/domain/src/security-access.ts";
import { deterministicPublicId, optionalBodyBoolean, optionalBodyString, readJson, requiredHeader, requiredPositiveInteger, requiredString, sendJson } from "../http.ts";

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
    const nodes = await persistence.read(identity.tenantId, async (transaction) => {
      const membership = await transaction.memberships.get("phase0-project", identity.principalId);
      if (membership === undefined || membership.status !== "active") return [];
      await assertProjectSecurityStable(transaction, "phase0-project");
      const visible: ProjectNode[] = [];
      const atUtc = new Date().toISOString();
      for (const node of await transaction.nodes.listByProject("phase0-project")) {
        if (await canAccessProjectObject(
          transaction, membership, identity.principalId, node.projectId,
          node.securityDomainId, "view", atUtc,
        )) visible.push(node);
      }
      return visible;
    });
    sendJson(response, 200, nodes.map(publicNode).sort((left, right) => left.id.localeCompare(right.id)));
    return true;
  }
  const detailMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)$/);
  if (request.method === "GET" && detailMatch?.[1] !== undefined) {
    const nodeId = decodeURIComponent(detailMatch[1]);
    const detail = await persistence.read(identity.tenantId, async (transaction) => {
      const node = await transaction.nodes.get(nodeId);
      if (node === undefined) throw new ApplicationError("NODE_NOT_FOUND", `Node not found: ${nodeId}`);
      const membership = await transaction.memberships.get(node.projectId, identity.principalId);
      const atUtc = new Date().toISOString();
      if (!await canAccessProjectObject(
        transaction, membership, identity.principalId, node.projectId,
        node.securityDomainId, "view", atUtc,
      )) throw new ApplicationError("NODE_NOT_FOUND", `Node not found: ${nodeId}`);
      await assertProjectSecurityStable(transaction, node.projectId);
      const tasks = await listTasksForNodeInTransaction(
        transaction,
        nodeId,
        async (task) => await canAccessProjectObject(
          transaction, membership, identity.principalId, task.projectId,
          task.securityDomainId, "view", atUtc,
        ),
      );
      return {
        node: publicNode(node),
        tasks: await Promise.all(tasks.map(async (task) => ({
          ...task,
          files: await listTaskAssetsInTransaction(
            transaction,
            task.id,
            async (asset) => await canAccessProjectObject(
              transaction, membership, identity.principalId, asset.projectId,
              asset.securityDomainId, "view", atUtc,
            ),
          ),
        }))),
      };
    });
    sendJson(response, 200, detail);
    return true;
  }
  const taskMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)\/tasks$/);
  const securityRootMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)\/security-domain$/);
  const securityGrantActionMatch = url.pathname.match(
    /^\/api\/security-domains\/([^/]+)\/grants\/([^/]+)\/actions\/([^/]+)$/,
  );
  if (request.method === "POST" && securityGrantActionMatch?.[1] !== undefined
    && securityGrantActionMatch[2] !== undefined && securityGrantActionMatch[3] !== undefined) {
    const securityDomainId = decodePathIdentifier(securityGrantActionMatch[1]);
    const targetPrincipalId = principalId(decodePathIdentifier(securityGrantActionMatch[2]));
    const action = securityGrantAction(securityGrantActionMatch[3]);
    const body = await readJson(request);
    const allowedFields = action === "set"
      ? ["capability", "expiresAtUtc", "expectedGrantVersion", "expectedDomainVersion", "reason"]
      : ["expectedGrantVersion", "expectedDomainVersion", "reason"];
    assertExactFields(body, allowedFields);
    const idempotencyKey = requiredHeader(request, "idempotency-key");
    const principalKey = commandKey(identity, idempotencyKey);
    const result = await new ManageSecurityGrantHandler(persistence).execute({
      tenantId: identity.tenantId,
      commandId: deterministicPublicId(`cmd-security-grant-${action}`, principalKey),
      idempotencyKey,
      correlationId: request.headers["x-correlation-id"]?.toString() ?? randomUUID(),
      principalId: identity.principalId,
      projectId: "phase0-project",
      securityDomainId,
      targetPrincipalId,
      action,
      capability: action === "set" ? requiredCapability(body, "capability") : null,
      expiresAtUtc: action === "set" ? requiredNullableUtc(body, "expiresAtUtc") : null,
      expectedGrantVersion: action === "set"
        ? requiredNullablePositiveInteger(body, "expectedGrantVersion")
        : requiredPositiveInteger(body, "expectedGrantVersion"),
      expectedDomainVersion: requiredPositiveInteger(body, "expectedDomainVersion"),
      reason: requiredString(body, "reason"),
      occurredAtUtc: new Date().toISOString(),
    });
    sendJson(response, 200, result);
    return true;
  }
  if (request.method === "POST" && securityRootMatch?.[1] !== undefined) {
    const nodeId = decodeURIComponent(securityRootMatch[1]);
    const body = await readJson(request);
    const idempotencyKey = requiredHeader(request, "idempotency-key");
    const principalKey = commandKey(identity, idempotencyKey);
    const result = await new CreateSecurityRootHandler(persistence).execute({
      tenantId: identity.tenantId,
      commandId: deterministicPublicId("cmd-security-root", principalKey),
      idempotencyKey,
      correlationId: request.headers["x-correlation-id"]?.toString() ?? randomUUID(),
      principalId: identity.principalId,
      projectId: "phase0-project",
      nodeId,
      securityDomainId: deterministicPublicId("security-domain", principalKey),
      expectedNodeVersion: requiredPositiveInteger(body, "expectedNodeVersion"),
      reason: requiredString(body, "reason"),
      occurredAtUtc: new Date().toISOString(),
    });
    sendJson(response, result.replayed ? 200 : 201, result);
    return true;
  }
  if (request.method === "POST" && taskMatch?.[1] !== undefined) {
    const nodeId = decodeURIComponent(taskMatch[1]);
    const node = await persistence.read(identity.tenantId, async (transaction) => {
      const candidate = await transaction.nodes.get(nodeId);
      if (candidate === undefined) return undefined;
      const membership = await transaction.memberships.get(candidate.projectId, identity.principalId);
      return await canAccessProjectObject(
        transaction, membership, identity.principalId, candidate.projectId,
        candidate.securityDomainId, "contribute", new Date().toISOString(),
      ) ? candidate : undefined;
    });
    if (node === undefined) throw new ApplicationError("NODE_NOT_FOUND", `Node not found: ${nodeId}`);
    const body = await readJson(request);
    const idempotencyKey = requiredHeader(request, "idempotency-key");
    const principalKey = commandKey(identity, idempotencyKey);
    const reviewer = optionalBodyString(body, "reviewerPrincipalId");
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
      taskId: optionalBodyString(body, "taskId") ?? deterministicPublicId("task", principalKey),
      title: requiredString(body, "title"),
      assigneePrincipalId: identity.principalId,
      requiresAcceptance: optionalBodyBoolean(body, "requiresAcceptance") ?? false,
      reviewerPrincipalId: reviewer === undefined ? null : principalId(reviewer),
      occurredAtUtc: new Date().toISOString(),
    });
    sendJson(response, result.replayed ? 200 : 201, result);
    return true;
  }
  const actionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/actions\/([^/]+)$/);
  if (request.method === "POST" && actionMatch?.[1] !== undefined && actionMatch[2] !== undefined) {
    const taskId = decodeURIComponent(actionMatch[1]);
    const action = taskAction(actionMatch[2]);
    const body = await readJson(request);
    const idempotencyKey = requiredHeader(request, "idempotency-key");
    const principalKey = commandKey(identity, idempotencyKey);
    const assignee = optionalBodyString(body, "assigneePrincipalId");
    const reviewer = optionalBodyString(body, "reviewerPrincipalId");
    if (action !== "assign_assignee" && assignee !== undefined) {
      throw new ApplicationError("VALIDATION_FAILED", "assigneePrincipalId is only valid for assign-assignee");
    }
    if (action !== "assign_reviewer" && reviewer !== undefined) {
      throw new ApplicationError("VALIDATION_FAILED", "reviewerPrincipalId is only valid for assign-reviewer");
    }
    const result = await new ActOnTaskHandler(persistence).execute({
      tenantId: identity.tenantId,
      commandId: deterministicPublicId(`cmd-task-${action}`, principalKey),
      idempotencyKey,
      correlationId: request.headers["x-correlation-id"]?.toString() ?? randomUUID(),
      principalId: identity.principalId,
      taskId,
      action,
      expectedVersion: requiredPositiveInteger(body, "expectedVersion"),
      assigneePrincipalId: assignee === undefined ? null : principalId(assignee),
      reviewerPrincipalId: reviewer === undefined ? null : principalId(reviewer),
      note: optionalBodyString(body, "note") ?? null,
      occurredAtUtc: new Date().toISOString(),
    });
    sendJson(response, 200, result);
    return true;
  }
  const fileMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/files$/);
  if (request.method === "POST" && fileMatch?.[1] !== undefined) {
    const taskId = decodeURIComponent(fileMatch[1]);
    const task = await persistence.read(identity.tenantId, async (transaction) => {
      const candidate = await transaction.tasks.get(taskId);
      if (candidate === undefined) return undefined;
      const membership = await transaction.memberships.get(candidate.projectId, identity.principalId);
      return await canAccessProjectObject(
        transaction, membership, identity.principalId, candidate.projectId,
        candidate.securityDomainId, "contribute", new Date().toISOString(),
      ) ? candidate : undefined;
    });
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
      assetId: optionalBodyString(body, "fileId") ?? deterministicPublicId("asset", principalKey),
      displayName: requiredString(body, "name"),
      contentType: requiredString(body, "contentType"),
      bytes,
      sha256: optionalBodyString(body, "sha256") ?? createHash("sha256").update(bytes).digest("hex"),
      occurredAtUtc,
      deadlineAtUtc: new Date(Date.parse(occurredAtUtc) + 5 * 60_000).toISOString(),
    });
    sendJson(response, result.replayed ? 200 : 201, result);
    return true;
  }
  return false;
}

function securityGrantAction(value: string): "set" | "revoke" {
  if (value === "set" || value === "revoke") return value;
  throw new ApplicationError("NOT_FOUND", "Security grant action not found");
}

function decodePathIdentifier(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.trim().length === 0 || decoded.includes("\u0000")) throw new Error("invalid identifier");
    return decoded;
  } catch {
    throw new ApplicationError("VALIDATION_FAILED", "Path identifier is invalid");
  }
}

function assertExactFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedFields = new Set(allowed);
  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    throw new ApplicationError("VALIDATION_FAILED", "Request body contains unsupported fields");
  }
}

function requiredNullablePositiveInteger(body: Record<string, unknown>, name: string): number | null {
  const value = body[name];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ApplicationError("VALIDATION_FAILED", `${name} must be null or a positive integer`);
  }
  return value;
}

function requiredNullableUtc(body: Record<string, unknown>, name: string): string | null {
  const value = body[name];
  if (value === null) return null;
  if (typeof value !== "string" || !isCanonicalUtcTimestamp(value)) {
    throw new ApplicationError("VALIDATION_FAILED", `${name} must be null or a UTC timestamp`);
  }
  return value;
}

function requiredCapability(
  body: Record<string, unknown>,
  name: string,
): "view" | "contribute" | "edit" | "manage_access" {
  const value = body[name];
  if (value === "view" || value === "contribute" || value === "edit" || value === "manage_access") return value;
  throw new ApplicationError("VALIDATION_FAILED", `${name} is invalid`);
}

function taskAction(value: string): TaskCommandAction {
  if (value === "start" || value === "submit" || value === "accept" || value === "reject" || value === "withdraw" || value === "complete") return value;
  if (value === "assign-reviewer") return "assign_reviewer";
  if (value === "assign-assignee") return "assign_assignee";
  throw new ApplicationError("NOT_FOUND", "Task action not found");
}

function commandKey(identity: ProductRequestIdentity, idempotencyKey: string): string {
  return `${identity.tenantId}\u0000${identity.principalId}\u0000${idempotencyKey}`;
}

function publicNode(node: ProjectNode): ApiNode {
  return { id: node.id, projectId: node.projectId, parentId: node.parentId, title: node.title, kind: node.kind, version: node.version };
}
