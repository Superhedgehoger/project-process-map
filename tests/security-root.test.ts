import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canAccessProjectObject } from "../packages/application/src/access/project-security.ts";
import { AttachTaskAssetHandler } from "../packages/application/src/assets/attach-task-asset.ts";
import { executeCreateNode } from "../packages/application/src/create-node.ts";
import { ApplicationError } from "../packages/application/src/errors.ts";
import type { OutboxConsumer, Persistence } from "../packages/application/src/ports/persistence.ts";
import {
  CreateSecurityRootHandler,
  type CreateSecurityRootCommand,
  type CreateSecurityRootFailurePoint,
} from "../packages/application/src/security/create-security-root.ts";
import { CreateTaskHandler } from "../packages/application/src/tasks/create-task.ts";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { MemoryAssetContent } from "../packages/adapters/src/memory/asset-content.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import type { DomainEvent } from "../packages/domain/src/events.ts";
import { principalId, tenantId } from "../packages/domain/src/identity.ts";
import { grantProjectMembership } from "./support/project-membership.ts";

const tenant = tenantId("tenant-security-root");
const manager = principalId("security-manager");
const member = principalId("security-member");

type Fixture = Readonly<{
  name: string;
  persistence: Persistence;
  outbox: OutboxConsumer;
  events(): Promise<DomainEvent[]>;
  cleanup(): Promise<void>;
}>;

async function fixture(name: string): Promise<Fixture> {
  if (name === "memory") {
    const persistence = new MemoryPersistence();
    return {
      name,
      persistence,
      outbox: persistence.outboxConsumer,
      events: async () => [...persistence.snapshot().events.values()],
      cleanup: async () => await persistence.close(),
    };
  }
  const directory = await mkdtemp(join(tmpdir(), "ppm-security-root-"));
  const persistence = new SqlitePersistence({ path: join(directory, "security.sqlite") });
  return {
    name,
    persistence,
    outbox: persistence.outboxConsumer,
    events: async () => await persistence.listEvents(tenant),
    cleanup: async () => { await persistence.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

async function prepare(persistence: Persistence): Promise<void> {
  await executeCreateNode(persistence, {
    tenantId: tenant,
    commandId: "create-public-node",
    idempotencyKey: "create-public-node",
    correlationId: "security-root",
    principalId: manager,
    projectId: "project-security",
    nodeId: "node-security",
    parentId: null,
    title: "敏感方案",
    securityDomainId: null,
    occurredAtUtc: "2026-09-04T11:00:00.000Z",
  });
  await grantProjectMembership(persistence, tenant, "project-security", manager, { role: "project_manager" });
  await grantProjectMembership(persistence, tenant, "project-security", member);
}

function command(overrides: Partial<CreateSecurityRootCommand> = {}): CreateSecurityRootCommand {
  return {
    tenantId: tenant,
    commandId: "create-security-root",
    idempotencyKey: "create-security-root",
    correlationId: "security-root",
    principalId: manager,
    projectId: "project-security",
    nodeId: "node-security",
    securityDomainId: "security-domain-1",
    expectedNodeVersion: 1,
    reason: "项目商业方案需要限制访问",
    occurredAtUtc: "2026-09-04T11:01:00.000Z",
    ...overrides,
  };
}

test("TC-SEC-001 first sensitive root atomically creates its first manage_access grant", async () => {
  for (const name of ["memory", "sqlite"]) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence);
      const handler = new CreateSecurityRootHandler(current.persistence);
      const created = await handler.execute(command());
      assert.equal(created.replayed, false, name);
      assert.equal(created.value.creatorCapability, "manage_access", name);
      assert.equal(created.value.permissionVersion, 1, name);
      assert.equal(created.value.nodeVersion, 2, name);

      const state = await current.persistence.read(tenant, async (transaction) => {
        const membership = await transaction.memberships.get("project-security", manager);
        const deniedMembership = await transaction.memberships.get("project-security", member);
        return {
          node: await transaction.nodes.get("node-security"),
          domain: await transaction.securityDomains.get("security-domain-1"),
          grants: await transaction.securityGrants.listByDomain("security-domain-1"),
          managerAllowed: await canAccessProjectObject(
            transaction, membership, manager, "project-security", "security-domain-1", "manage_access", command().occurredAtUtc,
          ),
          memberAllowed: await canAccessProjectObject(
            transaction, deniedMembership, member, "project-security", "security-domain-1", "view", command().occurredAtUtc,
          ),
        };
      });
      assert.equal(state.node?.securityDomainId, "security-domain-1", name);
      assert.equal(state.node?.securityEpoch, 2, name);
      assert.equal(state.domain?.rootNodeId, "node-security", name);
      assert.equal(state.grants.length, 1, name);
      assert.equal(state.grants[0]?.capability, "manage_access", name);
      assert.equal(state.managerAllowed, true, name);
      assert.equal(state.memberAllowed, false, name);

      const replay = await handler.execute({ ...command(), commandId: "retry-after-timeout" });
      assert.equal(replay.replayed, true, name);
      assert.deepEqual(replay.value, created.value, name);
      const securityEvents = (await current.events()).filter((event) => event.aggregateType === "security_domain");
      assert.equal(securityEvents.length, 1, name);
      assert.equal(securityEvents[0]?.eventType, "project-map.security-domain.created", name);
      assert.equal(JSON.stringify(securityEvents).includes(command().reason), false, name);
      assert.equal(await current.outbox.countReady("9999-12-31T23:59:59.999Z"), 2, name);
      await current.persistence.transaction(tenant, async (transaction) => {
        const membership = await transaction.memberships.get("project-security", manager);
        assert.ok(membership);
        await transaction.memberships.update({
          ...membership,
          status: "revoked",
          version: membership.version + 1,
          updatedAtUtc: "2026-09-04T11:02:00.000Z",
        }, membership.version);
      });
      await assert.rejects(
        handler.execute({ ...command(), commandId: "replay-after-revoke" }),
        (error) => error instanceof ApplicationError && error.code === "NODE_NOT_FOUND",
        name,
      );
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-001 assigning a domain requires its permanent first administrator", async () => {
  for (const name of ["memory", "sqlite"]) {
    for (const scenario of ["missing", "view", "revoked", "temporary"] as const) {
      const current = await fixture(name);
      try {
        await prepare(current.persistence);
        await assert.rejects(current.persistence.transaction(tenant, async (transaction) => {
          await transaction.securityDomains.insert({
            tenantId: tenant,
            id: "guarded-domain",
            projectId: "project-security",
            rootNodeId: "node-security",
            parentSecurityDomainId: null,
            permissionVersion: 1,
            version: 1,
            createdByPrincipalId: manager,
            createdAtUtc: "2026-09-04T11:01:00.000Z",
            deletedAtUtc: null,
          });
          if (scenario !== "missing") await transaction.securityGrants.insert({
            tenantId: tenant,
            id: "guarded-domain-first-admin",
            securityDomainId: "guarded-domain",
            principalId: manager,
            capability: scenario === "view" ? "view" : "manage_access",
            status: scenario === "revoked" ? "revoked" : "active",
            expiresAtUtc: scenario === "temporary" ? "2026-09-05T11:01:00.000Z" : null,
            grantedByPrincipalId: manager,
            reason: "first administrator invariant",
            version: 1,
            createdAtUtc: "2026-09-04T11:01:00.000Z",
            updatedAtUtc: "2026-09-04T11:01:00.000Z",
          });
          await transaction.nodes.assignSecurityDomain(
            "node-security", "project-security", "guarded-domain", 1,
          );
        }), /SECURITY_DOMAIN_FIRST_ADMIN_REQUIRED/, `${name}:${scenario}`);
        const state = await current.persistence.read(tenant, async (transaction) => ({
          node: await transaction.nodes.get("node-security"),
          domain: await transaction.securityDomains.get("guarded-domain"),
        }));
        assert.equal(state.node?.securityDomainId, null, `${name}:${scenario}`);
        assert.equal(state.domain, undefined, `${name}:${scenario}`);
      } finally {
        await current.cleanup();
      }
    }
  }
});

test("TC-SEC-001 missing, revoked-member and revoked-principal identities all fail closed", async () => {
  for (const scenario of ["missing-membership", "revoked-membership", "revoked-principal"] as const) {
    const persistence = new MemoryPersistence();
    try {
      await prepare(persistence);
      const actor = principalId(`manager-${scenario}`);
      if (scenario !== "missing-membership") {
        await grantProjectMembership(persistence, tenant, "project-security", actor, { role: "project_manager" });
        await persistence.transaction(tenant, async (transaction) => {
          if (scenario === "revoked-membership") {
            const membership = await transaction.memberships.get("project-security", actor);
            assert.ok(membership);
            await transaction.memberships.update({
              ...membership,
              status: "revoked",
              version: membership.version + 1,
              updatedAtUtc: "2026-09-04T11:00:30.000Z",
            }, membership.version);
          } else {
            const principal = await transaction.principals.get(actor);
            assert.ok(principal);
            await transaction.principals.update({
              ...principal,
              status: "revoked",
              version: principal.version + 1,
              updatedAtUtc: "2026-09-04T11:00:30.000Z",
            }, principal.version);
          }
        });
      }
      await assert.rejects(
        new CreateSecurityRootHandler(persistence).execute(command({
          principalId: actor,
          commandId: `command-${scenario}`,
          idempotencyKey: `request-${scenario}`,
        })),
        (error) => error instanceof ApplicationError && error.code === "NODE_NOT_FOUND",
        scenario,
      );
      assert.equal(await persistence.read(tenant, async (transaction) => transaction.securityDomains.get("security-domain-1")), undefined);
    } finally {
      await persistence.close();
    }
  }
});

test("TC-SEC-001 empty-leaf and legacy-ID guards fail closed without partial writes", async () => {
  const scenarios = ["child", "task", "asset", "legacy-id"] as const;
  for (const scenario of scenarios) {
    const persistence = new MemoryPersistence();
    try {
      await prepare(persistence);
      if (scenario === "child") {
        await executeCreateNode(persistence, {
          tenantId: tenant, commandId: "child", idempotencyKey: "child", correlationId: "security-root",
          principalId: manager, projectId: "project-security", nodeId: "child", parentId: "node-security",
          title: "既有后代", securityDomainId: null, occurredAtUtc: "2026-09-04T11:00:10.000Z",
        });
      } else if (scenario === "task") {
        await new CreateTaskHandler(persistence).execute({
          tenantId: tenant, commandId: "task", idempotencyKey: "task", correlationId: "security-root",
          principalId: manager, projectId: "project-security", nodeId: "node-security", taskId: "task",
          title: "既有任务", assigneePrincipalId: manager, requiresAcceptance: false, reviewerPrincipalId: null,
          occurredAtUtc: "2026-09-04T11:00:10.000Z",
        });
      } else if (scenario === "asset") {
        await persistence.transaction(tenant, async (transaction) => await transaction.assets.insert({
          tenantId: tenant, id: "asset", projectId: "project-security", ownerNodeId: "node-security",
          securityDomainId: null, securityEpoch: 1, uploaderPrincipalId: manager, displayName: "existing.txt",
          contentType: "text/plain", size: 1, sha256: "0".repeat(64), lifecycleState: "available",
          failureCode: null, version: 1, deletedAtUtc: null,
        }));
      } else {
        await persistence.transaction(tenant, async (transaction) => await transaction.nodes.insert({
          tenantId: tenant, id: "legacy-node", projectId: "legacy-project", parentId: null, title: "旧敏感节点",
          kind: "work_package", securityDomainId: command().securityDomainId, securityEpoch: 1,
          version: 1, deletedAtUtc: null,
        }));
      }
      await assert.rejects(
        new CreateSecurityRootHandler(persistence).execute(command()),
        (error) => error instanceof ApplicationError && error.code === (
          scenario === "legacy-id" ? "SECURITY_DOMAIN_ID_IN_USE" : "SECURITY_ROOT_REQUIRES_EMPTY_LEAF"
        ),
        scenario,
      );
      const state = await persistence.read(tenant, async (transaction) => ({
        node: await transaction.nodes.get("node-security"),
        domain: await transaction.securityDomains.get(command().securityDomainId),
        grants: await transaction.securityGrants.listByDomain(command().securityDomainId),
      }));
      assert.equal(state.node?.securityDomainId, null, scenario);
      assert.equal(state.domain, undefined, scenario);
      assert.deepEqual(state.grants, [], scenario);
    } finally {
      await persistence.close();
    }
  }
});

test("TC-SEC-001 a secured leaf protects inherited Task and Asset paths and rejects public children", async () => {
  const persistence = new MemoryPersistence();
  try {
    await prepare(persistence);
    await new CreateSecurityRootHandler(persistence).execute(command());
    await assert.rejects(executeCreateNode(persistence, {
      tenantId: tenant, commandId: "late-child", idempotencyKey: "late-child", correlationId: "security-root",
      principalId: manager, projectId: "project-security", nodeId: "late-child", parentId: "node-security",
      title: "禁止公开后代", securityDomainId: null, occurredAtUtc: "2026-09-04T11:02:00.000Z",
    }), /inheritance support/);
    const task = {
      tenantId: tenant, commandId: "secure-task", idempotencyKey: "secure-task", correlationId: "security-root",
      principalId: manager, projectId: "project-security", nodeId: "node-security", taskId: "secure-task",
      title: "敏感任务", assigneePrincipalId: manager, requiresAcceptance: false, reviewerPrincipalId: null,
      occurredAtUtc: "2026-09-04T11:03:00.000Z",
    } as const;
    await new CreateTaskHandler(persistence).execute(task);
    await assert.rejects(
      new CreateTaskHandler(persistence).execute({ ...task, commandId: "denied-task", idempotencyKey: "denied-task", taskId: "denied-task", principalId: member }),
      (error) => error instanceof ApplicationError && error.code === "NODE_NOT_FOUND",
    );
    const bytes = new TextEncoder().encode("sensitive evidence");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await new AttachTaskAssetHandler(persistence, new MemoryAssetContent()).execute({
      tenantId: tenant, commandId: "secure-asset", idempotencyKey: "secure-asset", correlationId: "security-root",
      principalId: manager, projectId: "project-security", taskId: "secure-task", assetId: "secure-asset",
      displayName: "evidence.txt", contentType: "text/plain", bytes, sha256,
      occurredAtUtc: "2026-09-04T11:04:00.000Z", deadlineAtUtc: "2026-09-04T11:09:00.000Z",
    });
    const stored = await persistence.read(tenant, async (transaction) => ({
      task: await transaction.tasks.get("secure-task"), asset: await transaction.assets.get("secure-asset"),
    }));
    assert.equal(stored.task?.securityDomainId, command().securityDomainId);
    assert.equal(stored.asset?.securityDomainId, command().securityDomainId);
  } finally {
    await persistence.close();
  }
});

test("TC-SEC-001 legacy visibility never grants write or access-management capabilities", async () => {
  const persistence = new MemoryPersistence();
  try {
    await prepare(persistence);
    await persistence.transaction(tenant, async (transaction) => {
      const membership = await transaction.memberships.get("project-security", member);
      assert.ok(membership);
      await transaction.memberships.update({
        ...membership, securityDomainIds: ["legacy-domain"], version: membership.version + 1,
        updatedAtUtc: "2026-09-04T11:01:00.000Z",
      }, membership.version);
    });
    const allowed = await persistence.read(tenant, async (transaction) => {
      const membership = await transaction.memberships.get("project-security", member);
      return {
        view: await canAccessProjectObject(transaction, membership, member, "project-security", "legacy-domain", "view", command().occurredAtUtc),
        contribute: await canAccessProjectObject(transaction, membership, member, "project-security", "legacy-domain", "contribute", command().occurredAtUtc),
        manage: await canAccessProjectObject(transaction, membership, member, "project-security", "legacy-domain", "manage_access", command().occurredAtUtc),
      };
    });
    assert.deepEqual(allowed, { view: true, contribute: false, manage: false });
  } finally {
    await persistence.close();
  }
});

test("TC-SEC-001 non-manager is rejected without creating a domain, grant, event or receipt", async () => {
  for (const name of ["memory", "sqlite"]) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence);
      await assert.rejects(
        new CreateSecurityRootHandler(current.persistence).execute(command({ principalId: member })),
        (error) => error instanceof ApplicationError && error.code === "NODE_NOT_FOUND",
        name,
      );
      const state = await current.persistence.read(tenant, async (transaction) => ({
        node: await transaction.nodes.get("node-security"),
        domain: await transaction.securityDomains.get("security-domain-1"),
        grants: await transaction.securityGrants.listByDomain("security-domain-1"),
        receipt: await transaction.receipts.get({
          principalId: member,
          operation: "create_security_root",
          idempotencyKey: "create-security-root",
        }),
      }));
      assert.equal(state.node?.securityDomainId, null, name);
      assert.equal(state.domain, undefined, name);
      assert.deepEqual(state.grants, [], name);
      assert.equal(state.receipt, undefined, name);
      assert.equal((await current.events()).filter((event) => event.aggregateType === "security_domain").length, 0, name);
      assert.equal(await current.outbox.countReady("9999-12-31T23:59:59.999Z"), 1, name);
    } finally {
      await current.cleanup();
    }
  }
});

for (const failurePoint of ["after_domain", "after_grant", "after_node", "after_event", "after_outbox", "after_receipt"] satisfies CreateSecurityRootFailurePoint[]) {
  test(`TC-SEC-001 ${failurePoint} rolls back the root and first administrator together`, async () => {
    for (const name of ["memory", "sqlite"]) {
      const current = await fixture(name);
      try {
        await prepare(current.persistence);
        await assert.rejects(
          new CreateSecurityRootHandler(current.persistence).execute(command(), failurePoint),
          new RegExp(failurePoint),
          name,
        );
        const state = await current.persistence.read(tenant, async (transaction) => ({
          node: await transaction.nodes.get("node-security"),
          domain: await transaction.securityDomains.get("security-domain-1"),
          grants: await transaction.securityGrants.listByDomain("security-domain-1"),
        }));
        assert.equal(state.node?.securityDomainId, null, name);
        assert.equal(state.node?.version, 1, name);
        assert.equal(state.domain, undefined, name);
        assert.deepEqual(state.grants, [], name);
        assert.equal((await current.events()).filter((event) => event.aggregateType === "security_domain").length, 0, name);
      } finally {
        await current.cleanup();
      }
    }
  });
}

test("TC-SEC-001 SQLite restart and concurrent retry preserve exactly one root and administrator", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-security-concurrent-"));
  const path = join(directory, "security.sqlite");
  const first = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
  try {
    await prepare(first);
    const second = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
    const results = await Promise.all([
      new CreateSecurityRootHandler(first).execute(command()),
      new CreateSecurityRootHandler(second).execute({ ...command(), commandId: "concurrent-retry" }),
    ]);
    assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
    await second.close();
    await first.close();

    const restarted = new SqlitePersistence({ path });
    const state = await restarted.read(tenant, async (transaction) => ({
      domain: await transaction.securityDomains.get("security-domain-1"),
      grants: await transaction.securityGrants.listByDomain("security-domain-1"),
      node: await transaction.nodes.get("node-security"),
    }));
    assert.equal(state.domain?.permissionVersion, 1);
    assert.equal(state.grants.length, 1);
    assert.equal(state.node?.securityDomainId, "security-domain-1");
    assert.equal((await restarted.listEvents(tenant)).filter((event) => event.aggregateType === "security_domain").length, 1);
    await restarted.close();
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});
