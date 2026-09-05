import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { Script } from "node:vm";
import { createProductApi, type ProductApiOptions } from "../apps/product-api/src/app.ts";
import { startProductApiServer } from "../apps/product-api/src/server.ts";
import { decodeCommandResult, decodeSecurityRoot, decodeTaskSummary } from "../packages/contracts/src/project-process-map-api.ts";
import { resolveExternalIdentity } from "../packages/application/src/identity/resolve-external-identity.ts";
import { MemoryAssetContent } from "../packages/adapters/src/memory/asset-content.ts";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { principalId, tenantId } from "../packages/domain/src/identity.ts";
import { grantProjectMembership } from "./support/project-membership.ts";

const phase0Tenant = tenantId("phase0-tenant");

test("P0-05-CT-009 Product API exposes the vertical path with stable HTTP semantics", async () => {
  const handler = createTestProductApi({ collaborationMode: "disabled", allowedOrigin: "http://ui.test" });
  const missingKey = await call(handler, "/api/nodes/N-03/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "接口任务" }),
  });
  assert.equal(missingKey.status, 422);
  assert.equal((JSON.parse(missingKey.body) as { code: string }).code, "IDEMPOTENCY_KEY_REQUIRED");

  const createTask = () => call(handler, "/api/nodes/N-03/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "api-task-1" },
    body: JSON.stringify({ taskId: "api-task-1", title: "接口任务", status: "todo" }),
  });
  const firstTask = await createTask();
  assert.equal(firstTask.status, 201);
  const taskBody = JSON.parse(firstTask.body) as { value: { id: string }; replayed: boolean };
  assert.equal(taskBody.value.id, "api-task-1");
  assert.equal(taskBody.replayed, false);
  assert.equal(decodeCommandResult(JSON.parse(firstTask.body), decodeTaskSummary).value.id, "api-task-1");
  const replayTask = await createTask();
  assert.equal(replayTask.status, 200);
  assert.equal((JSON.parse(replayTask.body) as { replayed: boolean }).replayed, true);

  const fileResponse = await call(handler, "/api/tasks/api-task-1/files", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "api-file-1" },
    body: JSON.stringify({
      fileId: "api-file-1",
      name: "evidence.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("api evidence").toString("base64"),
    }),
  });
  assert.equal(fileResponse.status, 201);

  const detailResponse = await call(handler, "/api/nodes/N-03");
  assert.equal(detailResponse.status, 200);
  const detailText = detailResponse.body;
  const detail = JSON.parse(detailText) as { tasks: Array<{ id: string; files: Array<{ id: string }> }> };
  assert.equal(detail.tasks[0]?.id, "api-task-1");
  assert.equal(detail.tasks[0]?.files[0]?.id, "api-file-1");
  assert.equal(detailText.includes("AuthorityRef"), false);
  assert.equal(detailText.includes("authorityRef"), false);

  const milestoneResponse = await call(handler, "/api/nodes/N-06/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "milestone-task" },
    body: JSON.stringify({ title: "不允许" }),
  });
  assert.equal(milestoneResponse.status, 422);
  assert.equal((JSON.parse(milestoneResponse.body) as { code: string }).code, "MILESTONE_TASK_FORBIDDEN");

  const missingResponse = await call(handler, "/unknown");
  assert.equal(missingResponse.status, 404);
  assert.equal(missingResponse.headers.get("access-control-allow-origin"), "http://ui.test");
});

test("P0-05-CT-009 Huly health reports configuration readiness without claiming a memory adapter check", async () => {
  const configured = createTestProductApi({
    collaborationMode: "huly",
    externalIdentityVerifier: { authenticate: async () => ({ provider: "huly", connectionId: "test", externalTenantRef: "workspace-1", externalSubjectRef: "actor-1" }) },
    collaborationProjectionConfigured: true,
  });
  const ready = await call(configured, "/health");
  assert.equal(ready.status, 200);
  assert.deepEqual(
    (JSON.parse(ready.body) as { components: Array<{ component: string }> }).components.map((item) => item.component),
    ["product-api", "huly-adapter-configuration"],
  );

  const incomplete = await call(createTestProductApi({ collaborationMode: "huly" }), "/health");
  assert.equal(incomplete.status, 503);
});

test("P0-05A-T1a Product API exposes an idempotent two-cycle task review path", async () => {
  const handler = createTestProductApi({ collaborationMode: "disabled" });
  const created = await call(handler, "/api/nodes/N-03/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "review-task" },
    body: JSON.stringify({
      taskId: "review-task",
      title: "验收发布方案",
      requiresAcceptance: true,
      reviewerPrincipalId: "phase0-user",
    }),
  });
  assert.equal(created.status, 201);

  const action = async (name: string, expectedVersion: number, key: string, note?: string) => await call(
    handler,
    `/api/tasks/review-task/actions/${name}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ expectedVersion, ...(note === undefined ? {} : { note }) }),
    },
  );
  assert.equal((JSON.parse((await action("start", 1, "review-start")).body) as { value: { status: string } }).value.status, "in_progress");
  const firstSubmit = await action("submit", 2, "review-submit-1", "首轮提交");
  assert.equal((JSON.parse(firstSubmit.body) as { value: { status: string } }).value.status, "pending_review");
  const replay = await action("submit", 2, "review-submit-1", "首轮提交");
  assert.equal((JSON.parse(replay.body) as { replayed: boolean }).replayed, true);
  assert.equal((await action("reject", 3, "review-reject-without-reason")).status, 422);
  assert.equal((JSON.parse((await action("reject", 3, "review-reject", "补充上线回滚步骤")).body) as { value: { status: string } }).value.status, "in_progress");
  await action("submit", 4, "review-submit-2", "已补充回滚步骤");
  const accepted = await action("accept", 5, "review-accept", "通过");
  const body = JSON.parse(accepted.body) as { value: { status: string; reviewHistory: Array<{ cycleNumber: number; action: string }> } };
  assert.equal(body.value.status, "completed");
  assert.deepEqual(body.value.reviewHistory.map((entry) => [entry.cycleNumber, entry.action]), [
    [1, "submitted"], [1, "rejected"], [2, "submitted"], [2, "accepted"],
  ]);
});

test("P0-05A-T1a Product API rejects drifted command fields and supports explicit assignment", async () => {
  const handler = createTestProductApi({ collaborationMode: "disabled" });
  const invalidBoolean = await call(handler, "/api/nodes/N-03/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "invalid-boolean" },
    body: JSON.stringify({ title: "错误类型", requiresAcceptance: "true" }),
  });
  assert.equal(invalidBoolean.status, 422);
  assert.equal((JSON.parse(invalidBoolean.body) as { code: string }).code, "VALIDATION_FAILED");

  await call(handler, "/api/nodes/N-03/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "assignment-task" },
    body: JSON.stringify({ taskId: "assignment-task", title: "改派任务" }),
  });
  const missing = await call(handler, "/api/tasks/assignment-task/actions/assign-assignee", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "missing-assignee" },
    body: JSON.stringify({ expectedVersion: 1 }),
  });
  assert.equal(missing.status, 422);
  assert.equal((JSON.parse(missing.body) as { code: string }).code, "ASSIGNEE_REQUIRED");
  const assigned = await call(handler, "/api/tasks/assignment-task/actions/assign-assignee", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "assign-system" },
    body: JSON.stringify({ expectedVersion: 1, assigneePrincipalId: "phase0-system" }),
  });
  assert.equal(assigned.status, 200);
  assert.equal((JSON.parse(assigned.body) as { value: { assigneePrincipalId: string } }).value.assigneePrincipalId, "phase0-system");
  const unrelatedReviewer = await call(handler, "/api/tasks/assignment-task/actions/start", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "bad-start-field" },
    body: JSON.stringify({ expectedVersion: 2, reviewerPrincipalId: "phase0-user" }),
  });
  assert.equal(unrelatedReviewer.status, 422);
  assert.equal((JSON.parse(unrelatedReviewer.body) as { code: string }).code, "VALIDATION_FAILED");
  const numericNote = await call(handler, "/api/tasks/assignment-task/actions/complete", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "numeric-note" },
    body: JSON.stringify({ expectedVersion: 2, note: 12 }),
  });
  assert.equal(numericNote.status, 422);
  assert.equal((JSON.parse(numericNote.body) as { code: string }).code, "VALIDATION_FAILED");
});

test("ARCH-GATE-ACL-001 an authenticated Huly principal without membership is fail-closed", async () => {
  const handler = createTestProductApi({
    collaborationMode: "huly",
    externalIdentityVerifier: { authenticate: async () => ({ provider: "huly", connectionId: "test", externalTenantRef: "workspace-1", externalSubjectRef: "actor-no-membership" }) },
    collaborationProjectionConfigured: true,
  });
  const headers = { authorization: "Bearer valid-test-token" };
  const nodes = await call(handler, "/api/nodes", { headers });
  assert.equal(nodes.status, 200);
  assert.deepEqual(JSON.parse(nodes.body), []);
  const detail = await call(handler, "/api/nodes/N-03", { headers });
  assert.equal(detail.status, 404);
});

test("ARCH-GATE-ACL-002 an open security migration freezes project API access", async () => {
  const persistence = new MemoryPersistence();
  const handler = createProductApi({ collaborationMode: "disabled", persistence, assetContent: new MemoryAssetContent() });
  await call(handler, "/api/nodes");
  await persistence.transaction(phase0Tenant, async (transaction) => {
    await transaction.securityMigrations.insert({
      tenantId: phase0Tenant,
      id: "migration-api",
      projectId: "phase0-project",
      rootNodeId: "N-03",
      sourceSecurityDomainId: null,
      targetSecurityDomainId: "sensitive",
      hierarchyRevision: 1,
      sourceSecurityEpoch: 1,
      targetSecurityEpoch: 2,
      state: "active",
      cursor: null,
      totalItems: 1,
      migratedItems: 0,
      failure: null,
      nextAttemptAtUtc: null,
      deadlineAtUtc: "2026-09-04T12:00:00.000Z",
      version: 1,
      createdAtUtc: "2026-09-04T10:00:00.000Z",
      updatedAtUtc: "2026-09-04T10:00:00.000Z",
    });
  });
  const response = await call(handler, "/api/nodes/N-03");
  assert.equal(response.status, 409);
  assert.equal((JSON.parse(response.body) as { code: string }).code, "SECURITY_MIGRATION_IN_PROGRESS");
});

test("TC-SEC-001 Product API creates one sensitive root while an ungranted member cannot infer it", async () => {
  const persistence = new MemoryPersistence();
  const assetContent = new MemoryAssetContent();
  const managerApi = createProductApi({ collaborationMode: "disabled", persistence, assetContent });
  const request = {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "sensitive-root-n03" },
    body: JSON.stringify({
      securityDomainId: "security-n03",
      expectedNodeVersion: 1,
      reason: "方案包含受限商务信息",
    }),
  };
  const created = await call(managerApi, "/api/nodes/N-03/security-domain", request);
  assert.equal(created.status, 201);
  const result = decodeCommandResult(JSON.parse(created.body), decodeSecurityRoot);
  assert.equal(result.value.creatorCapability, "manage_access");
  assert.equal(result.value.nodeVersion, 2);
  assert.notEqual(result.value.securityDomainId, "security-n03");
  const replay = await call(managerApi, "/api/nodes/N-03/security-domain", request);
  assert.equal(replay.status, 200);
  assert.equal(decodeCommandResult(JSON.parse(replay.body), decodeSecurityRoot).replayed, true);
  assert.equal((await call(managerApi, "/api/nodes/N-03")).status, 200);

  const external = {
    provider: "huly",
    connectionId: "test",
    externalTenantRef: "workspace-1",
    externalSubjectRef: "ordinary-member",
  } as const;
  const memberApi = createProductApi({
    collaborationMode: "huly",
    persistence,
    assetContent,
    externalIdentityVerifier: { authenticate: async () => external },
    collaborationProjectionConfigured: true,
  });
  const authorization = { authorization: "Bearer ordinary-member-token" };
  await call(memberApi, "/api/nodes", { headers: authorization });
  const internalPrincipal = await resolveExternalIdentity(persistence, { tenantId: phase0Tenant, ...external });
  await grantProjectMembership(persistence, phase0Tenant, "phase0-project", internalPrincipal);
  const visible = await call(memberApi, "/api/nodes", { headers: authorization });
  assert.equal(visible.status, 200);
  assert.equal((JSON.parse(visible.body) as Array<{ id: string }>).some((node) => node.id === "N-03"), false);
  const hidden = await call(memberApi, "/api/nodes/N-03", { headers: authorization });
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.includes(result.value.securityDomainId), false);
  const deniedExisting = await call(memberApi, "/api/nodes/N-02/security-domain", {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json", "idempotency-key": "probe-existing" },
    body: JSON.stringify({ securityDomainId: "probe-existing", expectedNodeVersion: 1, reason: "probe" }),
  });
  const deniedMissing = await call(memberApi, "/api/nodes/N-missing/security-domain", {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json", "idempotency-key": "probe-missing" },
    body: JSON.stringify({ securityDomainId: "probe-missing", expectedNodeVersion: 1, reason: "probe" }),
  });
  assert.equal(deniedExisting.status, 404);
  assert.equal(deniedMissing.status, 404);
  assert.equal(deniedExisting.body, deniedMissing.body);

  const ungrantedManagerExternal = { ...external, externalSubjectRef: "ungranted-manager" };
  const ungrantedManagerApi = createProductApi({
    collaborationMode: "huly",
    persistence,
    assetContent,
    externalIdentityVerifier: { authenticate: async () => ungrantedManagerExternal },
    collaborationProjectionConfigured: true,
  });
  const ungrantedManagerPrincipal = await resolveExternalIdentity(persistence, {
    tenantId: phase0Tenant,
    ...ungrantedManagerExternal,
  });
  await grantProjectMembership(persistence, phase0Tenant, "phase0-project", ungrantedManagerPrincipal, {
    role: "project_manager",
  });
  const managerHeaders = { authorization: "Bearer ungranted-manager-token", "content-type": "application/json" };
  const ungrantedExisting = await call(ungrantedManagerApi, "/api/nodes/N-03/security-domain", {
    method: "POST",
    headers: { ...managerHeaders, "idempotency-key": "ungranted-existing" },
    body: JSON.stringify({ securityDomainId: result.value.securityDomainId, expectedNodeVersion: 2, reason: "probe" }),
  });
  const ungrantedMissing = await call(ungrantedManagerApi, "/api/nodes/N-missing/security-domain", {
    method: "POST",
    headers: { ...managerHeaders, "idempotency-key": "ungranted-missing" },
    body: JSON.stringify({ securityDomainId: result.value.securityDomainId, expectedNodeVersion: 2, reason: "probe" }),
  });
  assert.equal(ungrantedExisting.status, 404);
  assert.equal(ungrantedMissing.status, 404);
  assert.equal(ungrantedExisting.body, ungrantedMissing.body);
});

test("P0-ND-01 public network binding is rejected before runtime dependencies are opened", async () => {
  const persistence = new MemoryPersistence();
  await assert.rejects(startProductApiServer(
    { HOST: "0.0.0.0", PORT: "0" },
    { persistence, assetContent: new MemoryAssetContent() },
  ), /PUBLIC_BIND_REQUIRES_P0_07/);
  await persistence.close();
});

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

test("P0-ND-01 Product API serves a standalone browser entry and node collection", async () => {
  const handler = createTestProductApi({ collaborationMode: "disabled" });
  const page = await call(handler, "/");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.match(page.body, /项目过程图谱/);
  assert.match(page.body, /原生 Node/);
  const script = page.body.match(/<script>([\s\S]+)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));

  const nodes = await call(handler, "/api/nodes");
  assert.equal(nodes.status, 200);
  const body = JSON.parse(nodes.body) as Array<{ id: string }>;
  assert.deepEqual(body.map((node) => node.id), ["N-01", "N-02", "N-03", "N-04", "N-05", "N-06"]);
});

test("ARCH-GATE-RECOVERY-002 operator recovery routes are deny-by-default", async () => {
  const denied = await call(createTestProductApi({ collaborationMode: "disabled" }), "/api/operator/integration-operations");
  assert.equal(denied.status, 403);
  const allowed = await call(createTestProductApi({
    collaborationMode: "disabled",
    recoveryOperatorPrincipalIds: [principalId("phase0-user")],
  }), "/api/operator/integration-operations");
  assert.equal(allowed.status, 200);
  assert.deepEqual(JSON.parse(allowed.body), []);
});

function createTestProductApi(options: Omit<ProductApiOptions, "persistence" | "assetContent">) {
  return createProductApi({ ...options, persistence: new MemoryPersistence(), assetContent: new MemoryAssetContent() });
}

async function call(
  handler: Handler,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: Map<string, string>; body: string }> {
  const request = Readable.from(init.body === undefined ? [] : [Buffer.from(init.body)]) as IncomingMessage;
  request.method = init.method ?? "GET";
  request.url = url;
  request.headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const headers = new Map<string, string>();
  let status = 200;
  let body = "";
  const response = {
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); },
    writeHead(value: number, values?: Record<string, string>) {
      status = value;
      for (const [name, headerValue] of Object.entries(values ?? {})) headers.set(name.toLowerCase(), headerValue);
      return this;
    },
    end(value?: string) { body += value ?? ""; return this; },
  } as unknown as ServerResponse;
  await handler(request, response);
  return { status, headers, body };
}
