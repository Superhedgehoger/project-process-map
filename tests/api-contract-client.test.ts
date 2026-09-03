import assert from "node:assert/strict";
import test from "node:test";
import { projectProcessMapBrowserClientSource } from "../packages/api-client/src/project-process-map-client.ts";
import { ContractDecodeError, decodeNodeDetail } from "../packages/contracts/src/project-process-map-api.ts";

type BrowserClient = {
  createTask(nodeId: string, input: { title: string }, idempotencyKey: string): Promise<unknown>;
};
type BrowserClientConstructor = new (options: { fetch: typeof fetch; timeoutMilliseconds: number }) => BrowserClient;

test("ARCH-GATE-CONTRACT-001 decoder rejects drifted task status before UI rendering", () => {
  assert.throws(() => decodeNodeDetail({
    node: { id: "N-1", projectId: "P-1", parentId: null, title: "节点", kind: "stage", version: 1 },
    tasks: [{ id: "T-1", nodeId: "N-1", title: "任务", status: "unknown", requiresAcceptance: false, version: 1, files: [] }],
  }), ContractDecodeError);
});

test("ARCH-GATE-CONTRACT-002 embedded canonical client retries an idempotent command with the same key", async () => {
  const target = globalThis as typeof globalThis & { ProjectProcessMapBrowserClient?: BrowserClientConstructor };
  const previous = target.ProjectProcessMapBrowserClient;
  const requests: RequestInit[] = [];
  try {
    Function(projectProcessMapBrowserClientSource)();
    const Constructor = target.ProjectProcessMapBrowserClient;
    assert.ok(Constructor);
    const client = new Constructor({
      timeoutMilliseconds: 1_000,
      fetch: async (_input, init = {}) => {
        requests.push(init);
        if (requests.length === 1) return response(503, { code: "UPSTREAM_FAILURE", message: "temporary" });
        return response(201, {
          value: { id: "T-1", nodeId: "N-1", title: "任务", status: "todo", requiresAcceptance: false, version: 1 },
          replayed: false,
        });
      },
    });
    await client.createTask("N-1", { title: "任务" }, "stable-command-key");
    assert.equal(requests.length, 2);
    assert.equal(new Headers(requests[0]?.headers).get("idempotency-key"), "stable-command-key");
    assert.equal(new Headers(requests[1]?.headers).get("idempotency-key"), "stable-command-key");
  } finally {
    if (previous === undefined) delete target.ProjectProcessMapBrowserClient;
    else target.ProjectProcessMapBrowserClient = previous;
  }
});

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
