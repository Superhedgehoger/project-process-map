import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { Script } from "node:vm";
import { createProductApi, type ProductApiOptions } from "../apps/product-api/src/app.ts";
import { MemoryAssetContent } from "../packages/adapters/src/memory/asset-content.ts";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { principalId } from "../packages/domain/src/identity.ts";

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
