import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AttachTaskAssetHandler, listTaskAssetsInTransaction } from "../../../../packages/application/src/assets/attach-task-asset.ts";
import { DownloadAssetContentHandler } from "../../../../packages/application/src/assets/download-asset-content.ts";
import { ApplicationError } from "../../../../packages/application/src/errors.ts";
import {
  assertProjectSecurityStable,
  canAccessProjectNodeDuringMigration,
  canAccessProjectObjectDuringMigration,
  canViewProjectObjectDuringMigration,
} from "../../../../packages/application/src/access/project-security.ts";
import { executeAssignNodeLeader } from "../../../../packages/application/src/create-node.ts";
import type { AssetContentPort } from "../../../../packages/application/src/ports/integrations.ts";
import type {
  AssignNodeLeaderCommand,
  AssignNodeLeaderFailurePoint,
  AssignNodeLeaderResult,
  CommitSecurityMigrationResult,
  CreateNodeCommand,
  CreateNodeFailurePoint,
  CreateNodeResult,
  Persistence,
  RollbackSecurityMigrationResult,
} from "../../../../packages/application/src/ports/persistence.ts";
import { ActOnTaskHandler, type TaskCommandAction } from "../../../../packages/application/src/tasks/act-on-task.ts";
import { CreateTaskHandler, listTasksForNodeInTransaction } from "../../../../packages/application/src/tasks/create-task.ts";
import { CreateSecurityRootHandler } from "../../../../packages/application/src/security/create-security-root.ts";
import { ManageSecurityGrantHandler } from "../../../../packages/application/src/security/manage-security-grant.ts";
import { CommitSecurityMigrationHandler } from "../../../../packages/application/src/security/commit-security-migration.ts";
import { RollbackSecurityMigrationHandler } from "../../../../packages/application/src/security/rollback-security-migration.ts";
import type { VerifyMigrationReadiness } from "../../../../packages/application/src/security/security-migration-coordinator.ts";
import { SubmitDeliverableEvidenceHandler } from "../../../../packages/application/src/deliverables/submit-deliverable-evidence.ts";
import { AcceptDeliverableHandler } from "../../../../packages/application/src/deliverables/accept-deliverable.ts";
import { WaiveDeliverableHandler } from "../../../../packages/application/src/deliverables/waive-deliverable.ts";
import { toDeliverableRequirementView } from "../../../../packages/application/src/deliverables/initialize-deliverable-requirement.ts";
import type {
  AcceptDeliverableResult,
  DeliverableRequirementView,
  SubmitDeliverableEvidenceResult,
  WaiveDeliverableResult,
} from "../../../../packages/application/src/ports/persistence.ts";
import type { EvidenceSourceType } from "../../../../packages/domain/src/deliverables.ts";

import type { ApiNode } from "../../../../packages/contracts/src/project-process-map-api.ts";
import { principalId, type PrincipalId, type TenantId } from "../../../../packages/domain/src/identity.ts";
import { isNodeLeader, type ProjectNode } from "../../../../packages/domain/src/project-structure.ts";
import { isCanonicalUtcTimestamp } from "../../../../packages/domain/src/security-access.ts";
import { deterministicPublicId, optionalBodyBoolean, optionalBodyString, readJson, requiredHeader, requiredPositiveInteger, requiredString, sendBytes, sendJson } from "../http.ts";

export type ProductRequestIdentity = Readonly<{ tenantId: TenantId; principalId: PrincipalId }>;
export type ProjectRouteDependencies = Readonly<{
  persistence: Persistence;
  createNode?: ((command: CreateNodeCommand, failurePoint?: CreateNodeFailurePoint) => Promise<CreateNodeResult>) | undefined;
  assignNodeLeader?: ((command: AssignNodeLeaderCommand, failurePoint?: AssignNodeLeaderFailurePoint) => Promise<AssignNodeLeaderResult>) | undefined;
  assetContent: AssetContentPort;
  scheduleCollaborationProjection: boolean;
  verifyMigrationReadiness?: VerifyMigrationReadiness | undefined;
}>;

export async function routeProjectRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  identity: ProductRequestIdentity,
  dependencies: ProjectRouteDependencies,
): Promise<boolean> {
  const { persistence } = dependencies;
  const assetContentMatch = url.pathname.match(/^\/api\/assets\/([^/]+)\/content$/);
  if (request.method === "GET" && assetContentMatch?.[1] !== undefined) {
    const result = await new DownloadAssetContentHandler(persistence, dependencies.assetContent).execute({
      tenantId: identity.tenantId,
      principalId: identity.principalId,
      assetId: decodeAssetContentIdentifier(assetContentMatch[1]),
    });
    sendBytes(response, result.contentType, result.bytes);
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/nodes") {
    const nodes = await persistence.read(identity.tenantId, async (transaction) => {
      const membership = await transaction.memberships.get("phase0-project", identity.principalId);
      if (membership === undefined || membership.status !== "active") return [];
      const visible: ProjectNode[] = [];
      const atUtc = new Date().toISOString();
      for (const node of await transaction.nodes.listByProject("phase0-project")) {
        if (node.deletedAtUtc !== null) continue;
        if (await canAccessProjectNodeDuringMigration(
          transaction, membership, identity.principalId, node, "view", atUtc,
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
      if (node === undefined || node.deletedAtUtc !== null) throw new ApplicationError("NODE_NOT_FOUND", `Node not found: ${nodeId}`);
      const membership = await transaction.memberships.get(node.projectId, identity.principalId);
      const atUtc = new Date().toISOString();
      if (!await canAccessProjectNodeDuringMigration(
        transaction, membership, identity.principalId, node, "view", atUtc,
      )) throw new ApplicationError("NODE_NOT_FOUND", `Node not found: ${nodeId}`);
      const tasks = await listTasksForNodeInTransaction(
        transaction,
        nodeId,
        async (task) => task.deletedAtUtc === null && await canViewProjectObjectDuringMigration(
          transaction, membership, identity.principalId, {
            projectId: task.projectId,
            ownerNodeId: task.ownerNodeId,
            securityDomainId: task.securityDomainId,
            securityEpoch: task.securityEpoch,
          }, atUtc,
        ),
      );
      return {
        node: publicNode(node),
        tasks: await Promise.all(tasks.map(async (task) => ({
          ...task,
          files: await listTaskAssetsInTransaction(
            transaction,
            task.id,
            async (asset) => await canViewProjectObjectDuringMigration(
              transaction, membership, identity.principalId, {
                projectId: asset.projectId,
                ownerNodeId: asset.ownerNodeId,
                securityDomainId: asset.securityDomainId,
                securityEpoch: asset.securityEpoch,
              }, atUtc,
            ),
          ),
        }))),
      };
    });
    sendJson(response, 200, detail);
    return true;
  }
  const taskMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)\/tasks$/);
  const assignLeaderMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)\/actions\/assign-leader$/);
  if (request.method === "POST" && assignLeaderMatch?.[1] !== undefined) {
    const nodeId = decodeURIComponent(assignLeaderMatch[1]);
    const body = await readJson(request);
    assertExactFields(body, ["expectedVersion", "leaderPrincipalId"]);
    const expectedVersion = requiredPositiveInteger(body, "expectedVersion");
    const rawLeader = body.leaderPrincipalId;
    let targetLeader: PrincipalId | null = null;
    if (rawLeader !== null && rawLeader !== undefined) {
      if (typeof rawLeader !== "string" || rawLeader.trim().length === 0) {
        throw new ApplicationError("VALIDATION_FAILED", "leaderPrincipalId must be a non-empty string or null");
      }
      targetLeader = principalId(rawLeader.trim());
    }
    const idempotencyKey = requiredHeader(request, "idempotency-key");
    const principalKey = commandKey(identity, idempotencyKey);
    const command: AssignNodeLeaderCommand = {
      tenantId: identity.tenantId,
      commandId: deterministicPublicId("cmd-assign-leader", principalKey),
      idempotencyKey,
      correlationId: request.headers["x-correlation-id"]?.toString() ?? randomUUID(),
      principalId: identity.principalId,
      projectId: "phase0-project",
      nodeId,
      leaderPrincipalId: targetLeader,
      expectedVersion,
      occurredAtUtc: new Date().toISOString(),
    };
    const result = await (dependencies.assignNodeLeader
      ? dependencies.assignNodeLeader(command)
      : executeAssignNodeLeader(persistence, command));
    sendJson(response, 200, { value: publicNode(result.node), replayed: result.replayed });
    return true;
  }
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
    const nodeLookup = await persistence.read(identity.tenantId, async (transaction) => {
      const candidate = await transaction.nodes.get(nodeId);
      if (candidate === undefined || candidate.deletedAtUtc !== null) return { status: "not_found" as const };
      const membership = await transaction.memberships.get(candidate.projectId, identity.principalId);
      if (membership?.status !== "active") return { status: "not_found" as const };

      const isManager = membership.role === "project_manager";
      const isLeader = isNodeLeader(candidate, identity.principalId);
      const hasResponsibility = candidate.leaderPrincipalId === null ? true : (isManager || isLeader);

      if (candidate.securityDomainId !== null) {
        if (!hasResponsibility) return { status: "concealed_not_found" as const };
        const allowed = await canAccessProjectNodeDuringMigration(
          transaction, membership, identity.principalId, candidate, "contribute", new Date().toISOString(),
        );
        if (!allowed) return { status: "concealed_not_found" as const };
        return { status: "ok" as const, node: candidate };
      }

      if (!hasResponsibility) return { status: "forbidden" as const };
      return { status: "ok" as const, node: candidate };
    });

    if (nodeLookup.status === "not_found" || nodeLookup.status === "concealed_not_found") {
      throw new ApplicationError("NODE_NOT_FOUND", `Node not found: ${nodeId}`);
    }
    if (nodeLookup.status === "forbidden") {
      throw new ApplicationError("FORBIDDEN", "Forbidden: only project manager or node leader can create tasks under this node");
    }
    const node = nodeLookup.node;
    const body = await readJson(request);
    const idempotencyKey = requiredHeader(request, "idempotency-key");
    const principalKey = commandKey(identity, idempotencyKey);
    const reviewer = optionalBodyString(body, "reviewerPrincipalId");
    const reviewerRoleSlotKey = optionalBodyString(body, "reviewerRoleSlotKey");
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
      reviewerRoleSlotKey: reviewerRoleSlotKey === undefined ? null : reviewerRoleSlotKey,
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
      if (candidate === undefined || candidate.deletedAtUtc !== null) return undefined;
      const ownerNode = await transaction.nodes.get(candidate.ownerNodeId);
      if (ownerNode === undefined || ownerNode.deletedAtUtc !== null) return undefined;
      if (ownerNode.projectId !== candidate.projectId || ownerNode.securityDomainId !== candidate.securityDomainId || ownerNode.securityEpoch !== candidate.securityEpoch) return undefined;
      const membership = await transaction.memberships.get(candidate.projectId, identity.principalId);
      return await canAccessProjectObjectDuringMigration(
        transaction, membership, identity.principalId, {
          projectId: candidate.projectId,
          ownerNodeId: candidate.ownerNodeId,
          securityDomainId: candidate.securityDomainId,
          securityEpoch: candidate.securityEpoch,
        }, "contribute", new Date().toISOString(),
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
  const migrationCommitMatch = url.pathname.match(/^\/api\/security-migrations\/([^/]+)\/actions\/commit$/);
  if (request.method === "POST" && migrationCommitMatch?.[1] !== undefined) {
    const migrationId = decodePathIdentifier(migrationCommitMatch[1]);
    const body = await readJson(request);
    assertExactFields(body, ["expectedVersion"]);
    const expectedMigrationVersion = requiredPositiveInteger(body, "expectedVersion");
    const idempotencyKey = requiredHeader(request, "idempotency-key");
    const verifyMigrationReadiness = dependencies.verifyMigrationReadiness;
    if (verifyMigrationReadiness === undefined) {
      throw new ApplicationError("HULY_ADAPTER_NOT_CONFIGURED", "Collaboration epoch readiness adapter is not configured");
    }
    const existingReceipt = await persistence.read(identity.tenantId, async (tx) => {
      return await tx.receipts.get<CommitSecurityMigrationResult>({
        principalId: identity.principalId,
        operation: "commit_security_migration",
        idempotencyKey,
      });
    });
    const occurredAtUtc = existingReceipt?.result?.occurredAtUtc ?? new Date().toISOString();
    const handler = new CommitSecurityMigrationHandler(persistence, verifyMigrationReadiness);
    const result = await handler.execute({
      tenantId: identity.tenantId,
      migrationId,
      expectedMigrationVersion,
      actorPrincipalId: identity.principalId,
      occurredAtUtc,
      idempotencyKey,
    });
    sendJson(response, 200, result);
    return true;
  }
  const migrationRollbackMatch = url.pathname.match(/^\/api\/security-migrations\/([^/]+)\/actions\/rollback$/);
  if (request.method === "POST" && migrationRollbackMatch?.[1] !== undefined) {
    const migrationId = decodePathIdentifier(migrationRollbackMatch[1]);
    const body = await readJson(request);
    assertExactFields(body, ["expectedVersion", "reason"]);
    const expectedMigrationVersion = requiredPositiveInteger(body, "expectedVersion");
    const reason = requiredString(body, "reason");
    const idempotencyKey = requiredHeader(request, "idempotency-key");
    const existingReceipt = await persistence.read(identity.tenantId, async (tx) => {
      return await tx.receipts.get<RollbackSecurityMigrationResult>({
        principalId: identity.principalId,
        operation: "rollback_security_migration",
        idempotencyKey,
      });
    });
    const occurredAtUtc = existingReceipt?.result?.occurredAtUtc ?? new Date().toISOString();
    const handler = new RollbackSecurityMigrationHandler(persistence, dependencies.verifyMigrationReadiness);
    const result = await handler.execute({
      tenantId: identity.tenantId,
      migrationId,
      expectedMigrationVersion,
      actorPrincipalId: identity.principalId,
      reason,
      occurredAtUtc,
      idempotencyKey,
    });
    sendJson(response, 200, result);
    return true;
  }

  const deliverableDetailMatch = url.pathname.match(/^\/api\/deliverables\/([^/]+)$/);
  if (request.method === "GET" && deliverableDetailMatch?.[1] !== undefined) {
    const deliverableId = decodePathIdentifier(deliverableDetailMatch[1]);
    const detail = await persistence.read(identity.tenantId, async (transaction) => {
      const req = await transaction.deliverables.get(deliverableId);
      if (req === undefined || req.deletedAtUtc !== null) {
        throw new ApplicationError("DELIVERABLE_NOT_FOUND", `Deliverable requirement not found: ${deliverableId}`);
      }
      const membership = await transaction.memberships.get(req.projectId, identity.principalId);
      const atUtc = persistence.nowUtc();
      if (!await canViewProjectObjectDuringMigration(
        transaction, membership, identity.principalId, {
          projectId: req.projectId,
          ownerNodeId: req.ownerNodeId,
          securityDomainId: req.securityDomainId,
          securityEpoch: req.securityEpoch,
        }, atUtc,
      )) {
        throw new ApplicationError("DELIVERABLE_NOT_FOUND", `Deliverable requirement not found: ${deliverableId}`);
      }
      const evidenceLinks = await transaction.deliverables.listEvidenceLinks(req.id);
      const actionHistory = await transaction.deliverables.listActions(req.id);
      return toDeliverableRequirementView(req, evidenceLinks, actionHistory);
    });
    sendJson(response, 200, detail);
    return true;
  }

  const nodeDeliverablesMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)\/deliverables$/);
  if (request.method === "GET" && nodeDeliverablesMatch?.[1] !== undefined) {
    const nodeId = decodePathIdentifier(nodeDeliverablesMatch[1]);
    const list = await persistence.read(identity.tenantId, async (transaction) => {
      const node = await transaction.nodes.get(nodeId);
      if (node === undefined || node.deletedAtUtc !== null) {
        throw new ApplicationError("NODE_NOT_FOUND", `Node not found: ${nodeId}`);
      }
      const membership = await transaction.memberships.get(node.projectId, identity.principalId);
      const atUtc = persistence.nowUtc();
      if (!await canAccessProjectNodeDuringMigration(
        transaction, membership, identity.principalId, node, "view", atUtc,
      )) {
        throw new ApplicationError("NODE_NOT_FOUND", `Node not found: ${nodeId}`);
      }
      const reqs = await transaction.deliverables.listByNode(nodeId);
      const visible: DeliverableRequirementView[] = [];
      for (const req of reqs) {
        if (req.deletedAtUtc !== null) continue;
        if (!await canViewProjectObjectDuringMigration(
          transaction, membership, identity.principalId, {
            projectId: req.projectId,
            ownerNodeId: req.ownerNodeId,
            securityDomainId: req.securityDomainId,
            securityEpoch: req.securityEpoch,
          }, atUtc,
        )) continue;
        const evidenceLinks = await transaction.deliverables.listEvidenceLinks(req.id);
        const actionHistory = await transaction.deliverables.listActions(req.id);
        visible.push(toDeliverableRequirementView(req, evidenceLinks, actionHistory));
      }
      return visible;
    });
    sendJson(response, 200, list);
    return true;
  }

  const deliverableActionMatch = url.pathname.match(/^\/api\/deliverables\/([^/]+)\/actions\/([^/]+)$/);
  if (request.method === "POST" && deliverableActionMatch?.[1] !== undefined && deliverableActionMatch[2] !== undefined) {
    const deliverableId = decodePathIdentifier(deliverableActionMatch[1]);
    const action = deliverableActionMatch[2];
    if (action !== "submit" && action !== "accept" && action !== "waive") {
      throw new ApplicationError("NOT_FOUND", "Deliverable action not found");
    }
    const body = await readJson(request);
    const idempotencyKey = requiredHeader(request, "idempotency-key");
    const principalKey = commandKey(identity, idempotencyKey);
    const expectedVersion = requiredPositiveInteger(body, "expectedVersion");

    if (action === "submit") {
      assertExactFields(body, ["expectedVersion", "evidence"]);
      const rawEvidence = body["evidence"];
      if (!Array.isArray(rawEvidence)) {
        throw new ApplicationError("VALIDATION_FAILED", "evidence must be an array");
      }
      const evidence = rawEvidence.map((item, idx) => {
        if (typeof item !== "object" || item === null) {
          throw new ApplicationError("VALIDATION_FAILED", `evidence[${idx}] must be an object`);
        }
        assertExactFields(item as Record<string, unknown>, ["sourceType", "sourceId"]);
        const sourceType = (item as Record<string, unknown>)["sourceType"];
        const sourceId = (item as Record<string, unknown>)["sourceId"];
        if (sourceType !== "file" && sourceType !== "process_record") {
          throw new ApplicationError("SOURCE_TYPE_UNSUPPORTED", `Invalid source type: ${sourceType}`);
        }
        if (typeof sourceId !== "string" || sourceId.trim().length === 0) {
          throw new ApplicationError("VALIDATION_FAILED", `evidence[${idx}].sourceId is required`);
        }
        return { sourceType: sourceType as EvidenceSourceType, sourceId };
      });

      const handler = new SubmitDeliverableEvidenceHandler(persistence);
      const result = await executePublicDeliverableCommand(
        persistence,
        identity,
        "submit_deliverable_evidence",
        idempotencyKey,
        async (occurredAtUtc) => await handler.execute({
          tenantId: identity.tenantId,
          commandId: deterministicPublicId("cmd-dlv-submit", principalKey),
          idempotencyKey,
          correlationId: request.headers["x-correlation-id"]?.toString() ?? randomUUID(),
          principalId: identity.principalId,
          deliverableId,
          expectedVersion,
          evidence,
          occurredAtUtc,
        }),
      );
      sendJson(response, 200, result);
      return true;
    }

    if (action === "accept") {
      assertExactFields(body, ["expectedVersion", "reason", "note"]);
      const rawReason = body["reason"] ?? body["note"];
      let note: string | null = null;
      if (rawReason !== undefined && rawReason !== null) {
        if (typeof rawReason !== "string") {
          throw new ApplicationError("VALIDATION_FAILED", "reason must be string or null");
        }
        note = rawReason;
      }

      const handler = new AcceptDeliverableHandler(persistence);
      const result = await executePublicDeliverableCommand(
        persistence,
        identity,
        "accept_deliverable",
        idempotencyKey,
        async (occurredAtUtc) => await handler.execute({
          tenantId: identity.tenantId,
          commandId: deterministicPublicId("cmd-dlv-accept", principalKey),
          idempotencyKey,
          correlationId: request.headers["x-correlation-id"]?.toString() ?? randomUUID(),
          principalId: identity.principalId,
          deliverableId,
          expectedVersion,
          note,
          occurredAtUtc,
        }),
      );
      sendJson(response, 200, result);
      return true;
    }

    if (action === "waive") {
      assertExactFields(body, ["expectedVersion", "reason"]);
      const reason = requiredString(body, "reason");

      const handler = new WaiveDeliverableHandler(persistence);
      const result = await executePublicDeliverableCommand(
        persistence,
        identity,
        "waive_deliverable",
        idempotencyKey,
        async (occurredAtUtc) => await handler.execute({
          tenantId: identity.tenantId,
          commandId: deterministicPublicId("cmd-dlv-waive", principalKey),
          idempotencyKey,
          correlationId: request.headers["x-correlation-id"]?.toString() ?? randomUUID(),
          principalId: identity.principalId,
          deliverableId,
          expectedVersion,
          reason,
          occurredAtUtc,
        }),
      );
      sendJson(response, 200, result);
      return true;
    }
  }
  return false;
}

async function executePublicDeliverableCommand<TResult>(
  persistence: Persistence,
  identity: ProductRequestIdentity,
  operation: "submit_deliverable_evidence" | "accept_deliverable" | "waive_deliverable",
  idempotencyKey: string,
  execute: (occurredAtUtc: string) => Promise<TResult>,
): Promise<TResult> {
  const scope = { principalId: identity.principalId, operation, idempotencyKey };
  const previous = await persistence.read(identity.tenantId, async (transaction) => {
    return await transaction.receipts.get(scope);
  });
  const occurredAtUtc = previous?.createdAtUtc ?? new Date().toISOString();
  try {
    return await execute(occurredAtUtc);
  } catch (error) {
    // A concurrent first request can commit after the read above. Retry once with the
    // authoritative receipt time; the handler still compares the complete business payload.
    if (
      previous === undefined
      && error instanceof ApplicationError
      && error.code === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD"
    ) {
      const concurrent = await persistence.read(identity.tenantId, async (transaction) => {
        return await transaction.receipts.get(scope);
      });
      if (concurrent !== undefined) return await execute(concurrent.createdAtUtc);
    }
    throw error;
  }
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

function decodeAssetContentIdentifier(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.trim().length === 0 || decoded.includes("\u0000") || decoded.includes("/")) throw new Error("invalid identifier");
    return decoded;
  } catch {
    throw new ApplicationError("NOT_FOUND", "Asset content not found");
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
  return {
    id: node.id,
    projectId: node.projectId,
    parentId: node.parentId,
    leaderPrincipalId: node.leaderPrincipalId,
    title: node.title,
    kind: node.kind,
    version: node.version,
  };
}
