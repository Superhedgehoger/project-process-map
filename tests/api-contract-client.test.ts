import assert from "node:assert/strict";
import test from "node:test";
import { projectProcessMapBrowserClientSource } from "../packages/api-client/src/project-process-map-client.ts";
import { ContractDecodeError, decodeNodeDetail } from "../packages/contracts/src/project-process-map-api.ts";

type BrowserClient = {
  createTask(nodeId: string, input: { title: string }, idempotencyKey: string): Promise<unknown>;
  getNode(nodeId: string): Promise<unknown>;
  actOnTask(taskId: string, action: string, input: { expectedVersion: number }, idempotencyKey: string): Promise<unknown>;
  createSecurityRoot(nodeId: string, input: { expectedNodeVersion: number; reason: string }, idempotencyKey: string): Promise<unknown>;
  setSecurityGrant(domainId: string, targetPrincipalId: string, input: Record<string, unknown>, idempotencyKey: string): Promise<unknown>;
  revokeSecurityGrant(domainId: string, targetPrincipalId: string, input: Record<string, unknown>, idempotencyKey: string): Promise<unknown>;
};
type BrowserClientConstructor = new (options: { fetch: typeof fetch; timeoutMilliseconds: number }) => BrowserClient;

test("ARCH-GATE-CONTRACT-001 decoder rejects drifted task status before UI rendering", () => {
  assert.throws(() => decodeNodeDetail({
    node: { id: "N-1", projectId: "P-1", parentId: null, title: "节点", kind: "stage", version: 1 },
    tasks: [{ id: "T-1", nodeId: "N-1", title: "任务", status: "unknown", assigneePrincipalId: null, requiresAcceptance: false, reviewerPrincipalId: null, version: 1, reviewHistory: [], files: [] }],
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
          value: { id: "T-1", nodeId: "N-1", title: "任务", status: "todo", assigneePrincipalId: "P-1", requiresAcceptance: false, reviewerPrincipalId: null, version: 1, reviewHistory: [] },
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

test("P0-05A-T1a embedded client rejects a drifted detail response before rendering", async () => {
  const target = globalThis as typeof globalThis & { ProjectProcessMapBrowserClient?: BrowserClientConstructor };
  const previous = target.ProjectProcessMapBrowserClient;
  try {
    Function(projectProcessMapBrowserClientSource)();
    const Constructor = target.ProjectProcessMapBrowserClient;
    assert.ok(Constructor);
    const client = new Constructor({
      timeoutMilliseconds: 1_000,
      fetch: async () => response(200, {
        node: { id: "N-1", projectId: "P-1", parentId: null, title: "节点", kind: "stage", version: 1 },
        tasks: [{ id: "T-1", nodeId: "N-1", title: "任务", status: "future_state", assigneePrincipalId: null, requiresAcceptance: false, reviewerPrincipalId: null, version: 1, reviewHistory: [], files: [] }],
      }),
    });
    await assert.rejects(client.getNode("N-1"), /task.status is invalid/);
  } finally {
    if (previous === undefined) delete target.ProjectProcessMapBrowserClient;
    else target.ProjectProcessMapBrowserClient = previous;
  }
});

test("P0-05A-T1a embedded client supports explicit assignment action routes", async () => {
  const target = globalThis as typeof globalThis & { ProjectProcessMapBrowserClient?: BrowserClientConstructor };
  const previous = target.ProjectProcessMapBrowserClient;
  let requestedUrl = "";
  try {
    Function(projectProcessMapBrowserClientSource)();
    const Constructor = target.ProjectProcessMapBrowserClient;
    assert.ok(Constructor);
    const client = new Constructor({
      timeoutMilliseconds: 1_000,
      fetch: async (input) => {
        requestedUrl = String(input);
        return response(200, {
          value: { id: "T-1", nodeId: "N-1", title: "任务", status: "todo", assigneePrincipalId: "P-2", requiresAcceptance: false, reviewerPrincipalId: null, version: 2, reviewHistory: [] },
          replayed: false,
        });
      },
    });
    await client.actOnTask("T-1", "assign-assignee", { expectedVersion: 1 }, "assign-1");
    assert.match(requestedUrl, /\/actions\/assign-assignee$/);
  } finally {
    if (previous === undefined) delete target.ProjectProcessMapBrowserClient;
    else target.ProjectProcessMapBrowserClient = previous;
  }
});

test("TC-SEC-001 embedded client decodes the sensitive-root command contract", async () => {
  const target = globalThis as typeof globalThis & { ProjectProcessMapBrowserClient?: BrowserClientConstructor };
  const previous = target.ProjectProcessMapBrowserClient;
  let requestedUrl = "";
  try {
    Function(projectProcessMapBrowserClientSource)();
    const Constructor = target.ProjectProcessMapBrowserClient;
    assert.ok(Constructor);
    const client = new Constructor({
      timeoutMilliseconds: 1_000,
      fetch: async (input) => {
        requestedUrl = String(input);
        return response(201, {
          value: {
            securityDomainId: "security-1",
            rootNodeId: "N-1",
            permissionVersion: 1,
            creatorCapability: "manage_access",
            nodeVersion: 2,
            securityEpoch: 2,
          },
          replayed: false,
        });
      },
    });
    await client.createSecurityRoot("N-1", { expectedNodeVersion: 1, reason: "受限" }, "security-root-1");
    assert.match(requestedUrl, /\/api\/nodes\/N-1\/security-domain$/);
  } finally {
    if (previous === undefined) delete target.ProjectProcessMapBrowserClient;
    else target.ProjectProcessMapBrowserClient = previous;
  }
});

test("TC-SEC-003B embedded client encodes Grant action paths, preserves the key and rejects drift", async () => {
  const target = globalThis as typeof globalThis & { ProjectProcessMapBrowserClient?: BrowserClientConstructor };
  const previous = target.ProjectProcessMapBrowserClient;
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  try {
    Function(projectProcessMapBrowserClientSource)();
    const Constructor = target.ProjectProcessMapBrowserClient;
    assert.ok(Constructor);
    const client = new Constructor({
      timeoutMilliseconds: 1_000,
      fetch: async (input, init) => {
        requests.push({ url: String(input), init });
        if (requests.length === 1) return response(503, { code: "UPSTREAM_FAILURE", message: "temporary" });
        return response(200, {
          value: {
            securityDomainId: "domain/one",
            targetPrincipalId: "target one",
            capability: "view",
            status: "active",
            expiresAtUtc: null,
            grantVersion: 1,
            permissionVersion: 2,
            domainVersion: 2,
          },
          replayed: false,
        });
      },
    });
    await client.setSecurityGrant("domain/one", "target one", {
      capability: "view", expiresAtUtc: null, expectedGrantVersion: null, expectedDomainVersion: 1, reason: "needed",
    }, "grant-key");
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.match(request.url, /\/api\/security-domains\/domain%2Fone\/grants\/target%20one\/actions\/set$/);
      assert.equal(new Headers(request.init?.headers).get("idempotency-key"), "grant-key");
    }

    const drifted = new Constructor({
      timeoutMilliseconds: 1_000,
      fetch: async () => response(200, {
        value: {
          securityDomainId: "domain-one", targetPrincipalId: "target-one", capability: "owner", status: "active",
          expiresAtUtc: null, grantVersion: 1, permissionVersion: 2, domainVersion: 2,
        },
        replayed: false,
      }),
    });
    await assert.rejects(
      drifted.revokeSecurityGrant("domain-one", "target-one", {
        expectedGrantVersion: 1, expectedDomainVersion: 2, reason: "remove",
      }, "revoke-key"),
      /securityGrant.capability is invalid/,
    );
    for (const [overrides, expected] of [
      [{ expiresAtUtc: "not-a-utc-timestamp" }, /securityGrant.expiresAtUtc must be UTC/],
      [{ reason: "server-leak" }, /security grant contains unsupported fields/],
    ] as const) {
      const strict = new Constructor({
        timeoutMilliseconds: 1_000,
        fetch: async () => response(200, {
          value: {
            securityDomainId: "domain-one", targetPrincipalId: "target-one", capability: "view", status: "active",
            grantVersion: 1, permissionVersion: 2, domainVersion: 2, ...overrides,
          },
          replayed: false,
        }),
      });
      await assert.rejects(
        strict.setSecurityGrant("domain-one", "target-one", {
          capability: "view", expiresAtUtc: null, expectedGrantVersion: null, expectedDomainVersion: 1, reason: "set",
        }, "strict-key"),
        expected,
      );
    }
  } finally {
    if (previous === undefined) delete target.ProjectProcessMapBrowserClient;
    else target.ProjectProcessMapBrowserClient = previous;
  }
});

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
