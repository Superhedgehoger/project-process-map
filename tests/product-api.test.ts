import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { createProductApi } from "../apps/product-api/src/app.ts";

test("P0-05-CT-009 Product API exposes the vertical path with stable HTTP semantics", async () => {
  const handler = createProductApi({ adapterMode: "memory", allowedOrigin: "http://ui.test" });
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
  const configured = createProductApi({
    adapterMode: "huly",
    transactionEndpoint: "http://huly.test/_transactor",
    fileEndpoint: "http://huly.test/files",
    workspaceId: "workspace-1",
    hulyProjectId: "project-1",
  });
  const ready = await call(configured, "/health");
  assert.equal(ready.status, 200);
  assert.deepEqual(
    (JSON.parse(ready.body) as { components: Array<{ component: string }> }).components.map((item) => item.component),
    ["product-api", "huly-adapter-configuration"],
  );

  const incomplete = await call(createProductApi({ adapterMode: "huly" }), "/health");
  assert.equal(incomplete.status, 503);
});

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

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
