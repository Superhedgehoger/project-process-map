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
import { ManageSecurityGrantHandler } from "../packages/application/src/security/manage-security-grant.ts";
import { CreateTaskHandler } from "../packages/application/src/tasks/create-task.ts";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { MemoryAssetContent } from "../packages/adapters/src/memory/asset-content.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import type { DomainEvent } from "../packages/domain/src/events.ts";
import { principalId, tenantId } from "../packages/domain/src/identity.ts";
import { transitionSecurityMigration, type SecurityDomainMigration } from "../packages/domain/src/security-migration.ts";
import { grantProjectMembership } from "./support/project-membership.ts";

const tenant = tenantId("tenant-security-root");
const manager = principalId("security-manager");
const member = principalId("security-member");
const legacyMember = principalId("legacy-security-member");

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

function childCommand(overrides: Partial<Parameters<typeof executeCreateNode>[1]> = {}): Parameters<typeof executeCreateNode>[1] {
  return {
    tenantId: tenant,
    commandId: "create-sensitive-child",
    idempotencyKey: "create-sensitive-child",
    correlationId: "security-inheritance",
    principalId: manager,
    projectId: "project-security",
    nodeId: "sensitive-child",
    parentId: "node-security",
    title: "敏感后代",
    securityDomainId: null,
    occurredAtUtc: "2026-09-04T11:02:00.000Z",
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
        const principal = await transaction.principals.get(manager);
        assert.ok(principal);
        await transaction.principals.update({
          ...principal,
          status: "revoked",
          version: principal.version + 1,
          updatedAtUtc: "2026-09-04T11:02:00.000Z",
        }, principal.version);
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
            const principal = await transaction.principals.get(actor);
            assert.ok(principal);
            await transaction.principals.update({
              ...principal,
              status: "revoked",
              version: principal.version + 1,
              updatedAtUtc: "2026-09-04T11:00:30.000Z",
            }, principal.version);
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

test("TC-SEC-002A a sensitive child, Task and Asset inherit the parent domain", async () => {
  const persistence = new MemoryPersistence();
  try {
    await prepare(persistence);
    await new CreateSecurityRootHandler(persistence).execute(command());
    const child = await executeCreateNode(persistence, {
      tenantId: tenant, commandId: "late-child", idempotencyKey: "late-child", correlationId: "security-root",
      principalId: manager, projectId: "project-security", nodeId: "late-child", parentId: "node-security",
      title: "敏感后代", securityDomainId: null, occurredAtUtc: "2026-09-04T11:02:00.000Z",
    });
    assert.equal(child.node.securityDomainId, command().securityDomainId);
    assert.equal(child.node.securityEpoch, 2);
    assert.equal(child.event.originalSecurityDomainId, command().securityDomainId);
    assert.equal(child.event.originalSecurityEpoch, 2);
    const task = {
      tenantId: tenant, commandId: "secure-task", idempotencyKey: "secure-task", correlationId: "security-root",
      principalId: manager, projectId: "project-security", nodeId: "late-child", taskId: "secure-task",
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

test("TC-SEC-002A sensitive inheritance and replay reauthorize in Memory and SQLite", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence);
      await new CreateSecurityRootHandler(current.persistence).execute(command());
      const created = await executeCreateNode(current.persistence, childCommand());
      assert.equal(created.node.securityDomainId, command().securityDomainId, name);
      assert.equal(created.node.securityEpoch, 2, name);
      assert.equal(created.event.originalSecurityDomainId, command().securityDomainId, name);
      assert.equal(created.outbox.payload.originalSecurityEpoch, 2, name);
      const replay = await executeCreateNode(current.persistence, childCommand({ commandId: "retry-sensitive-child" }));
      assert.equal(replay.replayed, true, name);

      const alternate = principalId(`alternate-security-manager-${name}`);
      await grantProjectMembership(current.persistence, tenant, "project-security", alternate, { role: "project_manager" });
      await new ManageSecurityGrantHandler(current.persistence).execute({
        tenantId: tenant,
        commandId: `grant-alternate-${name}`,
        idempotencyKey: `grant-alternate-${name}`,
        correlationId: "security-inheritance",
        principalId: manager,
        projectId: "project-security",
        securityDomainId: command().securityDomainId,
        targetPrincipalId: alternate,
        action: "set",
        capability: "manage_access",
        expiresAtUtc: null,
        expectedGrantVersion: null,
        expectedDomainVersion: 1,
        reason: "replacement administrator",
        occurredAtUtc: "2026-09-04T11:03:00.000Z",
      });
      await new ManageSecurityGrantHandler(current.persistence).execute({
        tenantId: tenant,
        commandId: `revoke-original-${name}`,
        idempotencyKey: `revoke-original-${name}`,
        correlationId: "security-inheritance",
        principalId: alternate,
        projectId: "project-security",
        securityDomainId: command().securityDomainId,
        targetPrincipalId: manager,
        action: "revoke",
        capability: null,
        expiresAtUtc: null,
        expectedGrantVersion: 1,
        expectedDomainVersion: 2,
        reason: "remove access",
        occurredAtUtc: "2026-09-04T11:04:00.000Z",
      });
      await assert.rejects(
        executeCreateNode(current.persistence, childCommand({ commandId: "replay-after-grant-revoke" })),
        (error) => error instanceof ApplicationError && error.code === "PARENT_NODE_NOT_FOUND",
        name,
      );
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002A a member with edit and a manager without Grant receive the same minimal parent error", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence);
      await new CreateSecurityRootHandler(current.persistence).execute(command());
      await new ManageSecurityGrantHandler(current.persistence).execute({
        tenantId: tenant,
        commandId: `grant-member-edit-${name}`,
        idempotencyKey: `grant-member-edit-${name}`,
        correlationId: "security-inheritance",
        principalId: manager,
        projectId: "project-security",
        securityDomainId: command().securityDomainId,
        targetPrincipalId: member,
        action: "set",
        capability: "edit",
        expiresAtUtc: null,
        expectedGrantVersion: null,
        expectedDomainVersion: 1,
        reason: "edit content only",
        occurredAtUtc: "2026-09-04T11:03:00.000Z",
      });
      const ungrantedManager = principalId(`ungranted-manager-${name}`);
      await grantProjectMembership(current.persistence, tenant, "project-security", ungrantedManager, { role: "project_manager" });
      const errors: ApplicationError[] = [];
      for (const [actor, parentId] of [
        [member, "node-security"],
        [ungrantedManager, "node-security"],
        [ungrantedManager, "missing-sensitive-parent"],
      ] as const) {
        try {
          await executeCreateNode(current.persistence, childCommand({
            commandId: `denied-${actor}-${parentId}-${name}`,
            idempotencyKey: `denied-${actor}-${parentId}-${name}`,
            nodeId: `denied-${actor}-${parentId}-${name}`,
            principalId: actor,
            parentId,
          }));
          assert.fail("expected parent denial");
        } catch (error) {
          assert.ok(error instanceof ApplicationError, name);
          errors.push(error);
        }
      }
      assert.deepEqual(errors.map((error) => [error.code, error.message]), [
        ["PARENT_NODE_NOT_FOUND", "Parent node not found"],
        ["PARENT_NODE_NOT_FOUND", "Parent node not found"],
        ["PARENT_NODE_NOT_FOUND", "Parent node not found"],
      ], name);
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002A inherited child creation rolls back at every existing failure point", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    for (const failurePoint of ["after_aggregate", "after_event", "after_outbox", "after_idempotency"] as const) {
      const current = await fixture(name);
      try {
        await prepare(current.persistence);
        await new CreateSecurityRootHandler(current.persistence).execute(command());
        const beforeEvents = (await current.events()).length;
        const beforeOutbox = await current.outbox.countReady("9999-12-31T23:59:59.999Z");
        await assert.rejects(
          executeCreateNode(current.persistence, childCommand(), failurePoint),
          new RegExp(failurePoint),
          `${name}:${failurePoint}`,
        );
        const state = await current.persistence.read(tenant, async (transaction) => ({
          node: await transaction.nodes.get(childCommand().nodeId),
          receipt: await transaction.receipts.get({
            principalId: manager,
            operation: "create_node",
            idempotencyKey: childCommand().idempotencyKey,
          }),
        }));
        assert.equal(state.node, undefined, `${name}:${failurePoint}`);
        assert.equal(state.receipt, undefined, `${name}:${failurePoint}`);
        assert.equal((await current.events()).length, beforeEvents, `${name}:${failurePoint}`);
        assert.equal(await current.outbox.countReady("9999-12-31T23:59:59.999Z"), beforeOutbox, `${name}:${failurePoint}`);
      } finally {
        await current.cleanup();
      }
    }
  }
});

test("TC-SEC-002A legacy, nested and migrating parent scopes fail closed", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence);
      await new CreateSecurityRootHandler(current.persistence).execute(command());
      await current.persistence.transaction(tenant, async (transaction) => {
        await transaction.nodes.insert({
          tenantId: tenant,
          id: "legacy-sensitive-parent",
          projectId: "project-security",
          parentId: null,
          title: "Legacy parent",
          kind: "work_package",
          securityDomainId: "legacy-only-domain",
          securityEpoch: 1,
          version: 1,
          deletedAtUtc: null,
        });
        await transaction.nodes.insert({
          tenantId: tenant,
          id: "nested-sensitive-parent",
          projectId: "project-security",
          parentId: null,
          title: "Nested parent",
          kind: "work_package",
          securityDomainId: "nested-sensitive-domain",
          securityEpoch: 2,
          version: 1,
          deletedAtUtc: null,
        });
        await transaction.nodes.insert({
          tenantId: tenant,
          id: "stale-epoch-parent",
          projectId: "project-security",
          parentId: null,
          title: "Stale epoch parent",
          kind: "work_package",
          securityDomainId: command().securityDomainId,
          securityEpoch: 1,
          version: 1,
          deletedAtUtc: null,
        });
        await transaction.nodes.insert({
          tenantId: tenant,
          id: "deleted-formal-root",
          projectId: "project-security",
          parentId: null,
          title: "Deleted formal root",
          kind: "work_package",
          securityDomainId: "deleted-root-domain",
          securityEpoch: 2,
          version: 1,
          deletedAtUtc: "2026-09-04T11:03:00.000Z",
        });
        await transaction.nodes.insert({
          tenantId: tenant,
          id: "live-parent-with-deleted-root",
          projectId: "project-security",
          parentId: null,
          title: "Live parent with deleted root",
          kind: "work_package",
          securityDomainId: "deleted-root-domain",
          securityEpoch: 2,
          version: 1,
          deletedAtUtc: null,
        });
        await transaction.securityDomains.insert({
          tenantId: tenant,
          id: "nested-sensitive-domain",
          projectId: "project-security",
          rootNodeId: "nested-sensitive-parent",
          parentSecurityDomainId: command().securityDomainId,
          permissionVersion: 1,
          version: 1,
          createdByPrincipalId: manager,
          createdAtUtc: "2026-09-04T11:03:00.000Z",
          deletedAtUtc: null,
        });
        await transaction.securityDomains.insert({
          tenantId: tenant,
          id: "deleted-root-domain",
          projectId: "project-security",
          rootNodeId: "deleted-formal-root",
          parentSecurityDomainId: null,
          permissionVersion: 1,
          version: 1,
          createdByPrincipalId: manager,
          createdAtUtc: "2026-09-04T11:03:00.000Z",
          deletedAtUtc: null,
        });
        await transaction.securityGrants.insert({
          tenantId: tenant,
          id: "grant:nested-sensitive-domain:security-manager",
          securityDomainId: "nested-sensitive-domain",
          principalId: manager,
          capability: "manage_access",
          status: "active",
          expiresAtUtc: null,
          grantedByPrincipalId: manager,
          reason: "test fixture",
          version: 1,
          createdAtUtc: "2026-09-04T11:03:00.000Z",
          updatedAtUtc: "2026-09-04T11:03:00.000Z",
        });
        await transaction.securityGrants.insert({
          tenantId: tenant,
          id: "grant:deleted-root-domain:security-manager",
          securityDomainId: "deleted-root-domain",
          principalId: manager,
          capability: "manage_access",
          status: "active",
          expiresAtUtc: null,
          grantedByPrincipalId: manager,
          reason: "test fixture",
          version: 1,
          createdAtUtc: "2026-09-04T11:03:00.000Z",
          updatedAtUtc: "2026-09-04T11:03:00.000Z",
        });
      });
      for (const parentId of [
        "legacy-sensitive-parent",
        "nested-sensitive-parent",
        "stale-epoch-parent",
        "live-parent-with-deleted-root",
      ]) {
        await assert.rejects(
          executeCreateNode(current.persistence, childCommand({
            commandId: `reject-${parentId}-${name}`,
            idempotencyKey: `reject-${parentId}-${name}`,
            nodeId: `child-of-${parentId}-${name}`,
            parentId,
          })),
          (error) => error instanceof ApplicationError && error.code === "PARENT_NODE_NOT_FOUND",
          `${name}:${parentId}`,
        );
      }
      await current.persistence.transaction(tenant, async (transaction) => {
        const planned: SecurityDomainMigration = {
          tenantId: tenant,
          id: `inheritance-migration-${name}`,
          projectId: "project-security",
          rootNodeId: "node-security",
          sourceSecurityDomainId: command().securityDomainId,
          targetSecurityDomainId: "future-domain",
          hierarchyRevision: 1,
          sourceSecurityEpoch: 2,
          targetSecurityEpoch: 3,
          state: "planned",
          cursor: null,
          totalItems: 1,
          migratedItems: 0,
          failure: null,
          nextAttemptAtUtc: null,
          deadlineAtUtc: "2026-09-04T12:00:00.000Z",
          version: 1,
          createdAtUtc: "2026-09-04T11:03:00.000Z",
          updatedAtUtc: "2026-09-04T11:03:00.000Z",
        };
        await transaction.securityMigrations.insert(planned);
        const active = transitionSecurityMigration(planned, "active", "2026-09-04T11:04:00.000Z");
        await transaction.securityMigrations.saveProgressPreservingPlan(active.id, active, planned.version);
      });
      await assert.rejects(
        executeCreateNode(current.persistence, childCommand({
          commandId: `reject-migration-${name}`,
          idempotencyKey: `reject-migration-${name}`,
        })),
        (error) => error instanceof ApplicationError && error.code === "SECURITY_MIGRATION_IN_PROGRESS",
        `${name}:migration`,
      );
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002A SQLite concurrent retry and restart preserve one inherited child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-sensitive-child-race-"));
  const path = join(directory, "inheritance.sqlite");
  const first = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
  try {
    await prepare(first);
    await new CreateSecurityRootHandler(first).execute(command());
    const second = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
    const results = await Promise.all([
      executeCreateNode(first, childCommand()),
      executeCreateNode(second, childCommand({ commandId: "concurrent-sensitive-child" })),
    ]);
    assert.equal(results.filter((result) => result.replayed).length, 1);
    assert.equal(results.every((result) => result.node.securityDomainId === command().securityDomainId), true);
    await second.close();
    await first.close();
    const restarted = new SqlitePersistence({ path });
    const node = await restarted.read(tenant, async (transaction) => transaction.nodes.get(childCommand().nodeId));
    const events = (await restarted.listEvents(tenant)).filter((event) => event.aggregateId === childCommand().nodeId);
    assert.equal(node?.securityDomainId, command().securityDomainId);
    assert.equal(node?.securityEpoch, 2);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.originalSecurityDomainId, command().securityDomainId);
    await restarted.close();
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TC-SEC-001 legacy visibility never grants write or access-management capabilities", async () => {
  const persistence = new MemoryPersistence();
  try {
    await prepare(persistence);
    await grantProjectMembership(persistence, tenant, "project-security", legacyMember, {
      securityDomainIds: ["legacy-domain"],
    });
    const allowed = await persistence.read(tenant, async (transaction) => {
      const membership = await transaction.memberships.get("project-security", legacyMember);
      return {
        view: await canAccessProjectObject(transaction, membership, legacyMember, "project-security", "legacy-domain", "view", command().occurredAtUtc),
        contribute: await canAccessProjectObject(transaction, membership, legacyMember, "project-security", "legacy-domain", "contribute", command().occurredAtUtc),
        manage: await canAccessProjectObject(transaction, membership, legacyMember, "project-security", "legacy-domain", "manage_access", command().occurredAtUtc),
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
