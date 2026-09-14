import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import test from "node:test";
import { createProductApi } from "../apps/product-api/src/app.ts";
import { MemoryAssetContent } from "../packages/adapters/src/memory/asset-content.ts";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import { createProductionSqliteBundle } from "../packages/adapters/src/sqlite/production-bundle.ts";
import {
  canAccessProjectNode,
  canAccessProjectNodeDuringMigration,
} from "../packages/application/src/access/project-security.ts";
import {
  executeAssignNodeLeader,
  executeCreateNode,
  type AssignNodeLeaderCommand,
  type CreateNodeCommand,
  type CreateNodeFailurePoint,
} from "../packages/application/src/create-node.ts";
import { ApplicationError } from "../packages/application/src/errors.ts";
import { resolveExternalIdentity } from "../packages/application/src/identity/resolve-external-identity.ts";
import type { Persistence } from "../packages/application/src/ports/persistence.ts";
import { createTestMemoryBundle, createTestSqliteBundle } from "./helpers/test-persistence-bundle.ts";
import { CreateSecurityRootHandler } from "../packages/application/src/security/create-security-root.ts";
import { ManageSecurityGrantHandler } from "../packages/application/src/security/manage-security-grant.ts";
import { RestrictProjectMembershipHandler } from "../packages/application/src/security/restrict-project-membership.ts";
import { ActOnTaskHandler } from "../packages/application/src/tasks/act-on-task.ts";
import { CreateTaskHandler } from "../packages/application/src/tasks/create-task.ts";
import { isNodeLeader, nodeEventSchemas, type ProjectNode } from "../packages/domain/src/project-structure.ts";
import { principalId, tenantId, type PrincipalId, type TenantId } from "../packages/domain/src/identity.ts";
import { transitionSecurityMigration, type SecurityDomainMigration, type SecurityDomainMigrationState } from "../packages/domain/src/security-migration.ts";
import { grantProjectMembership } from "./support/project-membership.ts";

const tenant = tenantId("tenant-node-owner");
const otherTenant = tenantId("tenant-cross");
const manager = principalId("pm-principal");
const alternateManager = principalId("alt-pm-principal");
const leaderU2 = principalId("leader-u2-principal");
const memberU1 = principalId("member-u1-principal");
const crossTenantUser = principalId("cross-user-principal");
const revokedUser = principalId("revoked-user-principal");
const revokedMember = principalId("revoked-member-principal");
const servicePrincipal = principalId("service-principal");
const projectId = "project-node-owner";

type Fixture = {
  name: "memory" | "sqlite";
  persistence: Persistence;
  path?: string;
  cleanup(): Promise<void>;
};

async function createFixture(name: "memory" | "sqlite"): Promise<Fixture> {
  if (name === "memory") {
    const bundle = createTestMemoryBundle();
    return {
      name,
      persistence: bundle.persistence,
      cleanup: async () => await bundle.persistence.close(),
    };
  }
  const directory = await mkdtemp(join(tmpdir(), "ppm-node-owner-"));
  const path = join(directory, "node-owner.sqlite");
  const bundle = createTestSqliteBundle({ path });
  return {
    name,
    persistence: bundle.persistence,
    path,
    cleanup: async () => {
      await bundle.persistence.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function countEventsAndOutbox(fixture: Fixture, tenantId: TenantId): Promise<{ events: number; outbox: number }> {
  if (fixture.name === "sqlite") {
    const db = new DatabaseSync(fixture.path!);
    try {
      const eventCount = Number((db.prepare("SELECT COUNT(*) as c FROM domain_events WHERE tenant_id = ?").get(tenantId) as any)?.c ?? 0);
      const outboxCount = Number((db.prepare("SELECT COUNT(*) as c FROM outbox_messages WHERE tenant_id = ?").get(tenantId) as any)?.c ?? 0);
      return { events: eventCount, outbox: outboxCount };
    } finally {
      db.close();
    }
  } else {
    const snap = (fixture.persistence as MemoryPersistence).snapshot();
    const eventCount = [...snap.events.values()].filter((e) => e.tenantId === tenantId).length;
    const outboxCount = [...snap.outbox.values()].filter((m) => m.tenantId === tenantId).length;
    return { events: eventCount, outbox: outboxCount };
  }
}

async function prepareIdentities(persistence: Persistence): Promise<void> {
  const atUtc = "2026-09-05T00:00:00.000Z";
  // Setup main tenant principals and memberships
  await grantProjectMembership(persistence, tenant, projectId, manager, { role: "project_manager" });
  await grantProjectMembership(persistence, tenant, projectId, alternateManager, { role: "project_manager" });
  await grantProjectMembership(persistence, tenant, projectId, leaderU2, { role: "member" });
  await grantProjectMembership(persistence, tenant, projectId, memberU1, { role: "member" });

  // Cross tenant user on other tenant
  await persistence.transaction(otherTenant, async (tx) => {
    await tx.principals.insert({
      tenantId: otherTenant,
      id: crossTenantUser,
      kind: "user",
      status: "active",
      version: 1,
      createdAtUtc: atUtc,
      updatedAtUtc: atUtc,
    });
  });

  // Revoked user
  await persistence.transaction(tenant, async (tx) => {
    await tx.principals.insert({
      tenantId: tenant,
      id: revokedUser,
      kind: "user",
      status: "revoked",
      version: 1,
      createdAtUtc: atUtc,
      updatedAtUtc: atUtc,
    });
    // Revoked membership user
    await tx.principals.insert({
      tenantId: tenant,
      id: revokedMember,
      kind: "user",
      status: "active",
      version: 1,
      createdAtUtc: atUtc,
      updatedAtUtc: atUtc,
    });
    await tx.memberships.insert({
      tenantId: tenant,
      projectId,
      principalId: revokedMember,
      role: "member",
      status: "revoked",
      securityDomainIds: [],
      version: 1,
      createdAtUtc: atUtc,
      updatedAtUtc: atUtc,
    });
    // Service principal
    await tx.principals.insert({
      tenantId: tenant,
      id: servicePrincipal,
      kind: "service",
      status: "active",
      version: 1,
      createdAtUtc: atUtc,
      updatedAtUtc: atUtc,
    });
  });
}

function createNodeCmd(overrides: Partial<CreateNodeCommand> = {}): CreateNodeCommand {
  return {
    tenantId: tenant,
    commandId: "cmd-create-node-1",
    idempotencyKey: "idem-create-node-1",
    correlationId: "cor-node-1",
    principalId: manager,
    projectId,
    nodeId: "node-root-1",
    parentId: null,
    leaderPrincipalId: null,
    title: "Node 1",
    kind: "work_package",
    securityDomainId: null,
    occurredAtUtc: "2026-09-05T01:00:00.000Z",
    ...overrides,
  };
}

function assignLeaderCmd(overrides: Partial<AssignNodeLeaderCommand> = {}): AssignNodeLeaderCommand {
  return {
    tenantId: tenant,
    commandId: "cmd-assign-leader-1",
    idempotencyKey: "idem-assign-leader-1",
    correlationId: "cor-assign-1",
    principalId: manager,
    projectId,
    nodeId: "node-root-1",
    leaderPrincipalId: leaderU2,
    expectedVersion: 1,
    occurredAtUtc: "2026-09-05T01:10:00.000Z",
    ...overrides,
  };
}

test("TC-TASK-005 ProjectNode domain model supports leaderPrincipalId and helper functions", () => {
  const node: ProjectNode = {
    tenantId: tenant,
    id: "test-node",
    projectId,
    parentId: null,
    leaderPrincipalId: leaderU2,
    title: "Domain Test Node",
    kind: "work_package",
    securityDomainId: null,
    securityEpoch: 1,
    version: 1,
    deletedAtUtc: null,
  };

  assert.equal(node.leaderPrincipalId, leaderU2);
  assert.equal(isNodeLeader(node, leaderU2), true);
  assert.equal(isNodeLeader(node, memberU1), false);
  assert.equal(isNodeLeader(node, null), false);
  assert.equal(isNodeLeader(node, undefined), false);
});

test("TC-TASK-005 / TC-SEC-004A positive: active project manager creates node with valid leaderPrincipalId", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const fixture = await createFixture(name);
    try {
      await prepareIdentities(fixture.persistence);

      const result = await executeCreateNode(fixture.persistence, createNodeCmd({
        nodeId: `node-u2-${name}`,
        leaderPrincipalId: leaderU2,
      }));

      assert.equal(result.node.leaderPrincipalId, leaderU2, fixture.name);
      assert.equal(result.node.version, 2, fixture.name);
      assert.equal(result.event.eventType, "project-map.node.created", fixture.name);
      assert.equal(result.event.schemaVersion, 1, fixture.name);
      assert.equal(result.event.payload.nodeId, `node-u2-${name}`, fixture.name);
      assert.equal(result.leaderAssignedEvent?.eventType, "project-map.node.leader_assigned", fixture.name);
      assert.equal(result.leaderAssignedEvent?.schemaVersion, 1, fixture.name);
      assert.equal(result.leaderAssignedEvent?.payload.leaderPrincipalId, leaderU2, fixture.name);

      const stored = await fixture.persistence.read(tenant, async (tx) => await tx.nodes.get(`node-u2-${name}`));
      assert.ok(stored, fixture.name);
      assert.equal(stored.leaderPrincipalId, leaderU2, fixture.name);
      assert.equal(stored.version, 2, fixture.name);

      // Idempotent replay
      const replay = await executeCreateNode(fixture.persistence, createNodeCmd({
        nodeId: `node-u2-${name}`,
        leaderPrincipalId: leaderU2,
        commandId: `cmd-create-node-replay-${name}`,
      }));
      assert.equal(replay.replayed, true, fixture.name);
      assert.equal(replay.node.leaderPrincipalId, leaderU2, fixture.name);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005 / TC-SEC-004A negative: non-manager cannot assign leaderPrincipalId during node creation", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const fixture = await createFixture(name);
    try {
      await prepareIdentities(fixture.persistence);

      // Member U1 attempts to create node specifying leaderPrincipalId
      await assert.rejects(
        executeCreateNode(fixture.persistence, createNodeCmd({
          principalId: memberU1,
          nodeId: `node-illegal-create-${name}`,
          leaderPrincipalId: leaderU2,
        })),
        (err) => err instanceof ApplicationError && err.code === "FORBIDDEN",
        fixture.name,
      );

      // Verify no aggregate was saved
      const stored = await fixture.persistence.read(tenant, async (tx) => await tx.nodes.get(`node-illegal-create-${name}`));
      assert.equal(stored, undefined, fixture.name);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005 / TC-SEC-004A candidate validation: invalid candidates atomically rejected with INVALID_NODE_LEADER", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const fixture = await createFixture(name);
    try {
      await prepareIdentities(fixture.persistence);

      const invalidCandidates: Array<{ desc: string; principalId: PrincipalId }> = [
        { desc: "nonexistent principal", principalId: principalId("nonexistent-user") },
        { desc: "cross-tenant user", principalId: crossTenantUser },
        { desc: "revoked principal", principalId: revokedUser },
        { desc: "service principal", principalId: servicePrincipal },
        { desc: "revoked project member", principalId: revokedMember },
      ];

      for (const [idx, item] of invalidCandidates.entries()) {
        const nodeId = `node-invalid-${idx}-${name}`;
        await assert.rejects(
          executeCreateNode(fixture.persistence, createNodeCmd({
            nodeId,
            commandId: `cmd-invalid-${idx}-${name}`,
            idempotencyKey: `idem-invalid-${idx}-${name}`,
            leaderPrincipalId: item.principalId,
          })),
          (err) => err instanceof ApplicationError && (err.code === ("INVALID_NODE_LEADER" as any) || err.message.includes("INVALID_NODE_LEADER")),
          `${fixture.name} - ${item.desc}`,
        );

        // Ensure no aggregate was stored
        const stored = await fixture.persistence.read(tenant, async (tx) => await tx.nodes.get(nodeId));
        assert.equal(stored, undefined, `${fixture.name} - ${item.desc}`);
      }
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005 / TC-SEC-004A assign / change node leader via executeAssignNodeLeader with CAS", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const fixture = await createFixture(name);
    try {
      await prepareIdentities(fixture.persistence);

      // Create initial node with no leader
      const nodeId = `node-assign-${name}`;
      await executeCreateNode(fixture.persistence, createNodeCmd({
        nodeId,
        leaderPrincipalId: null,
      }));

      // 1. Assign leader U2
      const assigned = await executeAssignNodeLeader(fixture.persistence, assignLeaderCmd({
        nodeId,
        leaderPrincipalId: leaderU2,
        expectedVersion: 1,
      }));
      assert.equal(assigned.node.leaderPrincipalId, leaderU2, fixture.name);
      assert.equal(assigned.node.version, 2, fixture.name);
      assert.equal(assigned.event.eventType, "project-map.node.leader_assigned", fixture.name);
      assert.equal(assigned.event.payload.previousLeaderPrincipalId, null, fixture.name);
      assert.equal(assigned.event.payload.leaderPrincipalId, leaderU2, fixture.name);

      // 2. Replay returns replayed result
      const replay = await executeAssignNodeLeader(fixture.persistence, assignLeaderCmd({
        nodeId,
        leaderPrincipalId: leaderU2,
        expectedVersion: 1,
        commandId: `cmd-assign-replay-${name}`,
      }));
      assert.equal(replay.replayed, true, fixture.name);
      assert.equal(replay.node.leaderPrincipalId, leaderU2, fixture.name);

      // 3. Clear leader (set to null)
      const cleared = await executeAssignNodeLeader(fixture.persistence, assignLeaderCmd({
        nodeId,
        commandId: `cmd-clear-leader-${name}`,
        idempotencyKey: `idem-clear-leader-${name}`,
        leaderPrincipalId: null,
        expectedVersion: 2,
      }));
      assert.equal(cleared.node.leaderPrincipalId, null, fixture.name);
      assert.equal(cleared.node.version, 3, fixture.name);

      // 4. Stale version conflict
      await assert.rejects(
        executeAssignNodeLeader(fixture.persistence, assignLeaderCmd({
          nodeId,
          commandId: `cmd-conflict-${name}`,
          idempotencyKey: `idem-conflict-${name}`,
          leaderPrincipalId: leaderU2,
          expectedVersion: 2, // actual is 3
        })),
        (err) => err instanceof ApplicationError && err.code === "NODE_VERSION_CONFLICT",
        fixture.name,
      );

      // 5. Non-manager (including U2 themselves) cannot change leader
      await assert.rejects(
        executeAssignNodeLeader(fixture.persistence, assignLeaderCmd({
          nodeId,
          principalId: leaderU2,
          commandId: `cmd-u2-assign-${name}`,
          idempotencyKey: `idem-u2-assign-${name}`,
          leaderPrincipalId: leaderU2,
          expectedVersion: 3,
        })),
        (err) => err instanceof ApplicationError && err.code === "FORBIDDEN",
        fixture.name,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-SEC-004A RBAC ∩ Grant intersection: ordinary node vs sensitive node U2 responsibility and 404 concealment", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const fixture = await createFixture(name);
    try {
      await prepareIdentities(fixture.persistence);
      const atUtc = "2026-09-05T02:00:00.000Z";

      // 1. Ordinary node
      const ordNodeId = `node-ordinary-${name}`;
      const ordResult = await executeCreateNode(fixture.persistence, createNodeCmd({
        nodeId: ordNodeId,
        leaderPrincipalId: leaderU2,
        securityDomainId: null,
      }));

      // U2 (Node Owner) on ordinary node:
      // Can view
      assert.equal(
        await fixture.persistence.read(tenant, async (tx) => {
          const m = await tx.memberships.get(projectId, leaderU2);
          return await canAccessProjectNode(tx, m, leaderU2, ordResult.node, "view", atUtc);
        }),
        true,
        `${fixture.name} - U2 ordinary view`,
      );
      // Can edit responsibility content
      assert.equal(
        await fixture.persistence.read(tenant, async (tx) => {
          const m = await tx.memberships.get(projectId, leaderU2);
          return await canAccessProjectNode(tx, m, leaderU2, ordResult.node, "edit", atUtc);
        }),
        true,
        `${fixture.name} - U2 ordinary edit`,
      );
      // U1 (regular member, not leader) cannot edit ordinary node
      assert.equal(
        await fixture.persistence.read(tenant, async (tx) => {
          const m = await tx.memberships.get(projectId, memberU1);
          return await canAccessProjectNode(tx, m, memberU1, ordResult.node, "edit", atUtc);
        }),
        false,
        `${fixture.name} - U1 ordinary edit denied`,
      );
      // U2 cannot manage_access on ordinary node (only PM can)
      assert.equal(
        await fixture.persistence.read(tenant, async (tx) => {
          const m = await tx.memberships.get(projectId, leaderU2);
          return await canAccessProjectNode(tx, m, leaderU2, ordResult.node, "manage_access", atUtc);
        }),
        false,
        `${fixture.name} - U2 ordinary manage_access denied`,
      );

      // 2. Sensitive node hierarchy
      // First create security root node
      const rootNodeId = `node-sec-root-${name}`;
      await executeCreateNode(fixture.persistence, createNodeCmd({
        nodeId: rootNodeId,
        leaderPrincipalId: null,
        securityDomainId: null,
        commandId: `cmd-sec-root-node-${name}`,
        idempotencyKey: `idem-sec-root-node-${name}`,
      }));
      const domainId = `domain-sec-${name}`;
      await new CreateSecurityRootHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: `cmd-sec-root-${name}`,
        idempotencyKey: `idem-sec-root-${name}`,
        correlationId: "sec-domain",
        principalId: manager,
        projectId,
        nodeId: rootNodeId,
        securityDomainId: domainId,
        reason: "create test sensitive domain",
        occurredAtUtc: atUtc,
        expectedNodeVersion: 1,
      });

      // Create child node under sensitive root and assign leaderU2
      const sensChildId = `node-sens-child-${name}`;
      const childResult = await executeCreateNode(fixture.persistence, createNodeCmd({
        nodeId: sensChildId,
        parentId: rootNodeId,
        leaderPrincipalId: leaderU2,
        commandId: `cmd-create-sens-child-${name}`,
        idempotencyKey: `idem-create-sens-child-${name}`,
      }));
      assert.equal(childResult.node.securityDomainId, domainId);
      assert.equal(childResult.node.leaderPrincipalId, leaderU2);

      // --- SENSITIVE CASE A: U2 has NO Grant ---
      // U2 has no grant: view -> false, edit -> false
      assert.equal(
        await fixture.persistence.read(tenant, async (tx) => {
          const m = await tx.memberships.get(projectId, leaderU2);
          return await canAccessProjectNodeDuringMigration(tx, m, leaderU2, childResult.node, "view", atUtc);
        }),
        false,
        `${fixture.name} - U2 sensitive no-grant view denied (404)`,
      );
      assert.equal(
        await fixture.persistence.read(tenant, async (tx) => {
          const m = await tx.memberships.get(projectId, leaderU2);
          return await canAccessProjectNodeDuringMigration(tx, m, leaderU2, childResult.node, "edit", atUtc);
        }),
        false,
        `${fixture.name} - U2 sensitive no-grant edit denied (404)`,
      );

      // --- SENSITIVE CASE B: U2 granted "view" capability ---
      await new ManageSecurityGrantHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: `grant-u2-view-${name}`,
        idempotencyKey: `grant-u2-view-${name}`,
        correlationId: "sec-grant",
        principalId: manager,
        projectId,
        securityDomainId: domainId,
        targetPrincipalId: leaderU2,
        action: "set",
        capability: "view",
        expiresAtUtc: null,
        expectedGrantVersion: null,
        expectedDomainVersion: 1,
        reason: "read access",
        occurredAtUtc: atUtc,
      });

      // U2 with "view" grant: view -> true, edit -> false
      assert.equal(
        await fixture.persistence.read(tenant, async (tx) => {
          const m = await tx.memberships.get(projectId, leaderU2);
          return await canAccessProjectNodeDuringMigration(tx, m, leaderU2, childResult.node, "view", atUtc);
        }),
        true,
        `${fixture.name} - U2 sensitive view-grant view allowed`,
      );
      assert.equal(
        await fixture.persistence.read(tenant, async (tx) => {
          const m = await tx.memberships.get(projectId, leaderU2);
          return await canAccessProjectNodeDuringMigration(tx, m, leaderU2, childResult.node, "edit", atUtc);
        }),
        false,
        `${fixture.name} - U2 sensitive view-grant edit denied`,
      );

      // --- SENSITIVE CASE C: U2 granted "edit" capability ---
      await new ManageSecurityGrantHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: `grant-u2-edit-${name}`,
        idempotencyKey: `grant-u2-edit-${name}`,
        correlationId: "sec-grant",
        principalId: manager,
        projectId,
        securityDomainId: domainId,
        targetPrincipalId: leaderU2,
        action: "set",
        capability: "edit",
        expiresAtUtc: null,
        expectedGrantVersion: 1,
        expectedDomainVersion: 2,
        reason: "edit access",
        occurredAtUtc: atUtc,
      });

      // U2 with "edit" grant: view -> true, edit -> true
      assert.equal(
        await fixture.persistence.read(tenant, async (tx) => {
          const m = await tx.memberships.get(projectId, leaderU2);
          return await canAccessProjectNodeDuringMigration(tx, m, leaderU2, childResult.node, "view", atUtc);
        }),
        true,
        `${fixture.name} - U2 sensitive edit-grant view allowed`,
      );
      assert.equal(
        await fixture.persistence.read(tenant, async (tx) => {
          const m = await tx.memberships.get(projectId, leaderU2);
          return await canAccessProjectNodeDuringMigration(tx, m, leaderU2, childResult.node, "edit", atUtc);
        }),
        true,
        `${fixture.name} - U2 sensitive edit-grant edit allowed`,
      );

      // Even with edit grant, U2 cannot manage_access (role is member)
      assert.equal(
        await fixture.persistence.read(tenant, async (tx) => {
          const m = await tx.memberships.get(projectId, leaderU2);
          return await canAccessProjectNodeDuringMigration(tx, m, leaderU2, childResult.node, "manage_access", atUtc);
        }),
        false,
        `${fixture.name} - U2 sensitive manage_access denied`,
      );

      // --- SENSITIVE CASE D: Revoking Grant drops immediately to 404 ---
      await new ManageSecurityGrantHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: `revoke-u2-grant-${name}`,
        idempotencyKey: `revoke-u2-grant-${name}`,
        correlationId: "sec-grant",
        principalId: manager,
        projectId,
        securityDomainId: domainId,
        targetPrincipalId: leaderU2,
        action: "revoke",
        capability: null,
        expiresAtUtc: null,
        expectedGrantVersion: 2,
        expectedDomainVersion: 3,
        reason: "revoke access",
        occurredAtUtc: atUtc,
      });

      assert.equal(
        await fixture.persistence.read(tenant, async (tx) => {
          const m = await tx.memberships.get(projectId, leaderU2);
          return await canAccessProjectNodeDuringMigration(tx, m, leaderU2, childResult.node, "view", atUtc);
        }),
        false,
        `${fixture.name} - U2 post-revoke view denied (404)`,
      );
      assert.equal(
        await fixture.persistence.read(tenant, async (tx) => {
          const m = await tx.memberships.get(projectId, leaderU2);
          return await canAccessProjectNodeDuringMigration(tx, m, leaderU2, childResult.node, "edit", atUtc);
        }),
        false,
        `${fixture.name} - U2 post-revoke edit denied (404)`,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-SEC-004A last administrator invariant zero-break: Node Owner presence cannot satisfy or bypass last permanent admin", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const fixture = await createFixture(name);
    try {
      await prepareIdentities(fixture.persistence);
      const atUtc = "2026-09-05T03:00:00.000Z";

      // Create security root with manager as first administrator
      const rootNodeId = `node-last-admin-${name}`;
      await executeCreateNode(fixture.persistence, createNodeCmd({
        nodeId: rootNodeId,
        leaderPrincipalId: null,
        commandId: `cmd-last-admin-root-${name}`,
        idempotencyKey: `idem-last-admin-root-${name}`,
      }));
      const domainId = `domain-last-admin-${name}`;
      await new CreateSecurityRootHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: `cmd-root-${name}`,
        idempotencyKey: `idem-root-${name}`,
        correlationId: "last-admin",
        principalId: manager,
        projectId,
        nodeId: rootNodeId,
        securityDomainId: domainId,
        reason: "first sensitive admin",
        occurredAtUtc: atUtc,
        expectedNodeVersion: 1,
      });

      // Create sensitive child node with U2 as leaderPrincipalId
      const childNodeId = `node-child-last-admin-${name}`;
      await executeCreateNode(fixture.persistence, createNodeCmd({
        nodeId: childNodeId,
        parentId: rootNodeId,
        leaderPrincipalId: leaderU2,
        commandId: `cmd-child-${name}`,
        idempotencyKey: `idem-child-${name}`,
      }));

      // Manager attempts to revoke their own permanent manage_access grant while U2 is node leader
      // Must be rejected with SECURITY_DOMAIN_LAST_ADMINISTRATOR
      await assert.rejects(
        new ManageSecurityGrantHandler(fixture.persistence).execute({
          tenantId: tenant,
          commandId: `revoke-pm-last-${name}`,
          idempotencyKey: `revoke-pm-last-${name}`,
          correlationId: "last-admin",
          principalId: manager,
          projectId,
          securityDomainId: domainId,
          targetPrincipalId: manager,
          action: "revoke",
          capability: null,
          expiresAtUtc: null,
          expectedGrantVersion: 1,
          expectedDomainVersion: 1,
          reason: "self revoke",
          occurredAtUtc: atUtc,
        }),
        (err) => err instanceof ApplicationError && err.code === "SECURITY_DOMAIN_LAST_ADMINISTRATOR",
        `${fixture.name} - last admin grant revocation rejected`,
      );

      // Attempting to demote or revoke manager project membership is also rejected
      await assert.rejects(
        new RestrictProjectMembershipHandler(fixture.persistence).execute({
          tenantId: tenant,
          commandId: `demote-pm-last-${name}`,
          idempotencyKey: `demote-pm-last-${name}`,
          correlationId: "last-admin",
          principalId: manager,
          projectId,
          targetPrincipalId: manager,
          action: "demote",
          reason: "self demote",
          expectedMembershipVersion: 1,
          occurredAtUtc: atUtc,
        }),
        (err) => err instanceof ApplicationError && err.code === "SECURITY_DOMAIN_LAST_ADMINISTRATOR",
        `${fixture.name} - last admin membership demote rejected`,
      );

      // U2 cannot invoke ManageSecurityGrantHandler to manage grants (returns 404 NODE_NOT_FOUND)
      await assert.rejects(
        new ManageSecurityGrantHandler(fixture.persistence).execute({
          tenantId: tenant,
          commandId: `u2-try-grant-${name}`,
          idempotencyKey: `u2-try-grant-${name}`,
          correlationId: "last-admin",
          principalId: leaderU2,
          projectId,
          securityDomainId: domainId,
          targetPrincipalId: leaderU2,
          action: "set",
          capability: "manage_access",
          expiresAtUtc: null,
          expectedGrantVersion: null,
          expectedDomainVersion: 1,
          reason: "u2 privilege escalation attempt",
          occurredAtUtc: atUtc,
        }),
        (err) => err instanceof ApplicationError && err.code === "NODE_NOT_FOUND",
        `${fixture.name} - U2 grant write forbidden 404`,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-SEC-004A SQLite schema v9 to v10 migration, null backfill, restart and CAS concurrency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-v9-upgrade-"));
  const path = join(directory, "v9.sqlite");
  try {
    // 1. Seed a legacy v9 database
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at_utc TEXT NOT NULL) STRICT;
      INSERT INTO schema_migrations (version, applied_at_utc) VALUES
        (1, '2026-09-04T00:00:00.000Z'),
        (2, '2026-09-04T00:00:00.000Z'),
        (3, '2026-09-04T00:00:00.000Z'),
        (4, '2026-09-04T00:00:00.000Z'),
        (5, '2026-09-04T00:00:00.000Z'),
        (6, '2026-09-04T00:00:00.000Z'),
        (7, '2026-09-04T00:00:00.000Z'),
        (8, '2026-09-04T00:00:00.000Z'),
        (9, '2026-09-04T00:00:00.000Z');
      CREATE TABLE tenants (tenant_id TEXT PRIMARY KEY, state TEXT NOT NULL, created_at_utc TEXT NOT NULL) STRICT;
      INSERT INTO tenants VALUES ('tenant-v9', 'active', '2026-09-04T00:00:00.000Z');
      CREATE TABLE project_nodes (
        tenant_id TEXT NOT NULL, node_id TEXT NOT NULL, project_id TEXT NOT NULL,
        parent_node_id TEXT, title TEXT NOT NULL, kind TEXT NOT NULL,
        security_domain_id TEXT, security_epoch INTEGER NOT NULL,
        version INTEGER NOT NULL, deleted_at_utc TEXT,
        PRIMARY KEY (tenant_id, node_id)
      ) STRICT;
      INSERT INTO project_nodes VALUES
        ('tenant-v9', 'legacy-node-1', 'proj-1', NULL, 'Old Title', 'work_package', NULL, 1, 1, NULL);
    `);
    database.close();

    // 2. Open with SqlitePersistence -> auto migrates to v10
    const v9Tenant = tenantId("tenant-v9");
    const bundle1 = createTestSqliteBundle({ path });
    const persistence1 = bundle1.persistence;
    const loaded = await persistence1.read(v9Tenant, async (tx) => await tx.nodes.get("legacy-node-1"));
    assert.ok(loaded);
    assert.equal(loaded.leaderPrincipalId, null);
    assert.equal(loaded.title, "Old Title");

    // Verify schema_migrations has version 10
    const checkDb = new DatabaseSync(path, { readOnly: true });
    const maxVer = (checkDb.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version;
    assert.equal(maxVer, 10);
    checkDb.close();

    // 3. Simulated v9 check rejects v10 database
    const v9SimulatedCheck = (dbPath: string) => {
      const db = new DatabaseSync(dbPath);
      const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
      const v9MaxSupported = 9;
      if (row.version > v9MaxSupported) {
        db.close();
        throw new Error(`SQLITE_SCHEMA_VERSION_UNSUPPORTED:${row.version}`);
      }
      db.close();
    };
    assert.throws(() => v9SimulatedCheck(path), /SQLITE_SCHEMA_VERSION_UNSUPPORTED:10/);

    // 4. Two independent connections CAS concurrency
    const bundle2 = createTestSqliteBundle({ path });
    const persistence2 = bundle2.persistence;
    await grantProjectMembership(persistence1, v9Tenant, "proj-1", manager, { role: "project_manager" });
    await grantProjectMembership(persistence1, v9Tenant, "proj-1", leaderU2, { role: "member" });
    await grantProjectMembership(persistence1, v9Tenant, "proj-1", memberU1, { role: "member" });

    // Race two connections assigning leader with same expectedVersion: 1
    const results = await Promise.allSettled([
      executeAssignNodeLeader(persistence1, assignLeaderCmd({
        tenantId: v9Tenant,
        projectId: "proj-1",
        nodeId: "legacy-node-1",
        leaderPrincipalId: leaderU2,
        expectedVersion: 1,
        commandId: "race-1",
        idempotencyKey: "race-1",
      })),
      executeAssignNodeLeader(persistence2, assignLeaderCmd({
        tenantId: v9Tenant,
        projectId: "proj-1",
        nodeId: "legacy-node-1",
        leaderPrincipalId: memberU1,
        expectedVersion: 1,
        commandId: "race-2",
        idempotencyKey: "race-2",
      })),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "Exactly one write should succeed");
    assert.equal(rejected.length, 1, "Conflicting write should fail");
    assert.ok(
      (rejected[0] as PromiseRejectedResult).reason instanceof ApplicationError &&
      (rejected[0] as PromiseRejectedResult).reason.code === "NODE_VERSION_CONFLICT",
      "Conflicting write must fail with NODE_VERSION_CONFLICT",
    );

    await persistence1.close();
    await persistence2.close();

    // 5. Restart verification: reload and verify persisted winner state
    const persistenceRestart = new SqlitePersistence({ path });
    const afterRestart = await persistenceRestart.read(v9Tenant, async (tx) => await tx.nodes.get("legacy-node-1"));
    assert.ok(afterRestart);
    assert.equal(afterRestart.version, 2);
    const winningLeader = (fulfilled[0] as PromiseFulfilledResult<any>).value.node.leaderPrincipalId;
    assert.equal(afterRestart.leaderPrincipalId, winningLeader);
    await persistenceRestart.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TC-SEC-004A migration write freeze and read dual-grant intersection for Node Owner", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const fixture = await createFixture(name);
    try {
      await prepareIdentities(fixture.persistence);
      const atUtc = "2026-09-05T04:00:00.000Z";

      // 1. Setup source root and domain
      const rootNodeId = `node-mig-root-${name}`;
      await executeCreateNode(fixture.persistence, createNodeCmd({
        nodeId: rootNodeId,
        leaderPrincipalId: null,
        commandId: `cmd-mig-root-${name}`,
        idempotencyKey: `idem-mig-root-${name}`,
      }));
      const sourceDomId = `dom-src-${name}`;
      await new CreateSecurityRootHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: `cmd-mig-sec-${name}`,
        idempotencyKey: `idem-mig-sec-${name}`,
        correlationId: "mig",
        principalId: manager,
        projectId,
        nodeId: rootNodeId,
        securityDomainId: sourceDomId,
        reason: "migration root",
        occurredAtUtc: atUtc,
        expectedNodeVersion: 1,
      });

      // 2. Child node with U2 as leader
      const childNodeId = `node-mig-child-${name}`;
      const childResult = await executeCreateNode(fixture.persistence, createNodeCmd({
        nodeId: childNodeId,
        parentId: rootNodeId,
        leaderPrincipalId: leaderU2,
        commandId: `cmd-mig-child-${name}`,
        idempotencyKey: `idem-mig-child-${name}`,
      }));

      // Target domain and root
      const targetDomId = `dom-tgt-${name}`;
      const targetRootId = `node-mig-tgt-root-${name}`;
      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.nodes.insert({
          tenantId: tenant,
          id: targetRootId,
          projectId,
          parentId: null,
          leaderPrincipalId: null,
          title: "Target Root",
          kind: "work_package",
          securityDomainId: targetDomId,
          securityEpoch: 2,
          version: 1,
          deletedAtUtc: null,
        });
        await tx.securityDomains.insert({
          tenantId: tenant,
          id: targetDomId,
          projectId,
          rootNodeId: targetRootId,
          parentSecurityDomainId: null,
          permissionVersion: 1,
          version: 1,
          createdByPrincipalId: manager,
          createdAtUtc: atUtc,
          deletedAtUtc: null,
        });
        await tx.securityGrants.insert({
          tenantId: tenant,
          id: `grant-tgt-admin-${name}`,
          securityDomainId: targetDomId,
          principalId: manager,
          capability: "manage_access",
          status: "active",
          expiresAtUtc: null,
          grantedByPrincipalId: manager,
          reason: "target admin",
          version: 1,
          createdAtUtc: atUtc,
          updatedAtUtc: atUtc,
        });
        // Insert active migration
        const planned: SecurityDomainMigration = {
          tenantId: tenant,
          id: `mig-${name}`,
          projectId,
          rootNodeId,
          sourceSecurityDomainId: sourceDomId,
          targetSecurityDomainId: targetDomId,
          hierarchyRevision: 1,
          sourceSecurityEpoch: 2,
          targetSecurityEpoch: 3,
          state: "planned",
          cursor: null,
          totalItems: 2,
          migratedItems: 0,
          failure: null,
          nextAttemptAtUtc: null,
          deadlineAtUtc: "2026-09-11T00:00:00.000Z",
          version: 1,
          createdAtUtc: atUtc,
          updatedAtUtc: atUtc,
        };
        const active = transitionSecurityMigration(planned, "active", atUtc);
        await tx.securityMigrations.insert(planned);
        await tx.securityMigrations.saveProgressPreservingPlan(active.id, active, planned.version);
      });

      // 3. While migration is active, write operations on nodes are frozen
      await assert.rejects(
        executeAssignNodeLeader(fixture.persistence, assignLeaderCmd({
          nodeId: childNodeId,
          leaderPrincipalId: memberU1,
          expectedVersion: childResult.node.version,
          commandId: `cmd-frozen-assign-${name}`,
          idempotencyKey: `idem-frozen-assign-${name}`,
        })),
        (err) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_IN_PROGRESS",
        `${fixture.name} - assign leader frozen during migration`,
      );

      // Migration Oracle Prevention:
      // Unauthorized principals (U1 member, U2 owner without grant, U0 non-member)
      // MUST receive NODE_NOT_FOUND (404), exactly identical to requesting a nonexistent node,
      // and CANNOT distinguish the existing sensitive node under migration from a nonexistent node.
      await assert.rejects(
        executeAssignNodeLeader(fixture.persistence, assignLeaderCmd({
          principalId: memberU1,
          nodeId: childNodeId,
          leaderPrincipalId: leaderU2,
          expectedVersion: childResult.node.version,
          commandId: `cmd-oracle-u1-${name}`,
          idempotencyKey: `idem-oracle-u1-${name}`,
        })),
        (err) => err instanceof ApplicationError && err.code === "NODE_NOT_FOUND",
        `${fixture.name} - U1 assign-leader on sensitive node under migration concealed with NODE_NOT_FOUND`,
      );

      await assert.rejects(
        executeAssignNodeLeader(fixture.persistence, assignLeaderCmd({
          principalId: leaderU2,
          nodeId: childNodeId,
          leaderPrincipalId: memberU1,
          expectedVersion: childResult.node.version,
          commandId: `cmd-oracle-u2-${name}`,
          idempotencyKey: `idem-oracle-u2-${name}`,
        })),
        (err) => err instanceof ApplicationError && err.code === "NODE_NOT_FOUND",
        `${fixture.name} - U2 assign-leader on sensitive node under migration concealed with NODE_NOT_FOUND`,
      );

      await assert.rejects(
        executeAssignNodeLeader(fixture.persistence, assignLeaderCmd({
          principalId: crossTenantUser,
          nodeId: childNodeId,
          leaderPrincipalId: memberU1,
          expectedVersion: childResult.node.version,
          commandId: `cmd-oracle-u0-${name}`,
          idempotencyKey: `idem-oracle-u0-${name}`,
        })),
        (err) => err instanceof ApplicationError && err.code === "NODE_NOT_FOUND",
        `${fixture.name} - U0 assign-leader on sensitive node under migration concealed with NODE_NOT_FOUND`,
      );

      await assert.rejects(
        executeCreateNode(fixture.persistence, createNodeCmd({
          nodeId: `node-frozen-child-${name}`,
          parentId: childNodeId,
          commandId: `cmd-frozen-create-${name}`,
          idempotencyKey: `idem-frozen-create-${name}`,
        })),
        (err) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_IN_PROGRESS",
        `${fixture.name} - create child frozen during migration`,
      );

      // 4. Read intersection:
      // Grant U2 in source domain only
      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.securityGrants.insert({
          tenantId: tenant,
          id: `grant-src-${name}`,
          securityDomainId: sourceDomId,
          principalId: leaderU2,
          capability: "edit",
          status: "active",
          expiresAtUtc: null,
          grantedByPrincipalId: manager,
          reason: "src grant",
          version: 1,
          createdAtUtc: atUtc,
          updatedAtUtc: atUtc,
        });
      });

      // Only source grant -> read denied during migration
      assert.equal(
        await fixture.persistence.read(tenant, async (tx) => {
          const m = await tx.memberships.get(projectId, leaderU2);
          return await canAccessProjectNodeDuringMigration(tx, m, leaderU2, childResult.node, "view", atUtc);
        }),
        false,
        `${fixture.name} - source only grant denied during migration`,
      );

      // Grant U2 in target domain as well -> dual grant satisfied
      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.securityGrants.insert({
          tenantId: tenant,
          id: `grant-tgt-${name}`,
          securityDomainId: targetDomId,
          principalId: leaderU2,
          capability: "view",
          status: "active",
          expiresAtUtc: null,
          grantedByPrincipalId: manager,
          reason: "tgt grant",
          version: 1,
          createdAtUtc: atUtc,
          updatedAtUtc: atUtc,
        });
      });

      assert.equal(
        await fixture.persistence.read(tenant, async (tx) => {
          const m = await tx.memberships.get(projectId, leaderU2);
          return await canAccessProjectNodeDuringMigration(tx, m, leaderU2, childResult.node, "view", atUtc);
        }),
        true,
        `${fixture.name} - dual grant allows view during migration`,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-SEC-004A failure point injection rolls back assign leader atomically", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const fixture = await createFixture(name);
    try {
      await prepareIdentities(fixture.persistence);

      const nodeId = `node-fail-inject-${name}`;
      await executeCreateNode(fixture.persistence, createNodeCmd({
        nodeId,
        leaderPrincipalId: null,
        commandId: `cmd-fail-init-${name}`,
        idempotencyKey: `idem-fail-init-${name}`,
      }));

      const points = ["after_aggregate", "after_event", "after_outbox", "after_idempotency"] as const;
      for (const [idx, fp] of points.entries()) {
        const failCmd = assignLeaderCmd({
          nodeId,
          leaderPrincipalId: leaderU2,
          expectedVersion: 1,
          commandId: `cmd-fail-${idx}-${name}`,
          idempotencyKey: `idem-fail-${idx}-${name}`,
        });

        const preStats = await countEventsAndOutbox(fixture, tenant);
        const preSeq = await fixture.persistence.read(tenant, async (tx) => await tx.sequences.current(projectId));

        await assert.rejects(
          executeAssignNodeLeader(fixture.persistence, failCmd, fp),
          new RegExp(`Injected failure: ${fp}`),
          `${fixture.name} - ${fp}`,
        );

        // State remains at version 1 with null leader, no receipt, no event, no outbox, sequence unchanged
        const postStats = await countEventsAndOutbox(fixture, tenant);
        const { node, receipt, sequence } = await fixture.persistence.read(tenant, async (tx) => ({
          node: await tx.nodes.get(nodeId),
          receipt: await tx.receipts.get({
            principalId: manager,
            operation: "assign_node_leader",
            idempotencyKey: failCmd.idempotencyKey,
          }),
          sequence: await tx.sequences.current(projectId),
        }));

        assert.ok(node);
        assert.equal(node.version, 1, `${fixture.name} - ${fp} node version unchanged`);
        assert.equal(node.leaderPrincipalId, null, `${fixture.name} - ${fp} leader unchanged`);
        assert.equal(receipt, undefined, `${fixture.name} - ${fp} receipt rolled back`);
        assert.equal(postStats.events, preStats.events, `${fixture.name} - ${fp} event rolled back`);
        assert.equal(postStats.outbox, preStats.outbox, `${fixture.name} - ${fp} outbox rolled back`);
        assert.equal(sequence, preSeq, `${fixture.name} - ${fp} sequence rolled back`);
      }
    } finally {
      await fixture.cleanup();
    }
  }
});

async function callApi(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
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

test("Finding 1: Trusted time - authorization uses trusted current time; backdating past expired grant fails closed", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const fixture = await createFixture(name);
    try {
      await prepareIdentities(fixture.persistence);
      const pastTimeUtc = "2026-09-01T00:00:00.000Z";
      const expiredGrantTimeUtc = "2026-09-02T00:00:00.000Z";

      // 1. Create sensitive root and child node
      const rootNodeId = `node-tt-root-${name}`;
      await executeCreateNode(fixture.persistence, createNodeCmd({
        nodeId: rootNodeId,
        leaderPrincipalId: null,
        commandId: `cmd-tt-root-${name}`,
        idempotencyKey: `idem-tt-root-${name}`,
      }));
      const domainId = `domain-tt-${name}`;
      await new CreateSecurityRootHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: `cmd-tt-sec-${name}`,
        idempotencyKey: `idem-tt-sec-${name}`,
        correlationId: "tt",
        principalId: manager,
        projectId,
        nodeId: rootNodeId,
        securityDomainId: domainId,
        reason: "trusted time root",
        occurredAtUtc: pastTimeUtc,
        expectedNodeVersion: 1,
      });

      const childNodeId = `node-tt-child-${name}`;
      await executeCreateNode(fixture.persistence, createNodeCmd({
        nodeId: childNodeId,
        parentId: rootNodeId,
        leaderPrincipalId: null,
        commandId: `cmd-tt-child-${name}`,
        idempotencyKey: `idem-tt-child-${name}`,
      }));

      // Grant alternateManager permanent manage_access so expiring manager grant preserves last-admin invariant
      await new ManageSecurityGrantHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: `grant-tt-alt-${name}`,
        idempotencyKey: `grant-tt-alt-${name}`,
        correlationId: "tt",
        principalId: manager,
        projectId,
        securityDomainId: domainId,
        targetPrincipalId: alternateManager,
        action: "set",
        capability: "manage_access",
        expiresAtUtc: null,
        expectedGrantVersion: null,
        expectedDomainVersion: 1,
        reason: "second admin so manager grant can expire",
        occurredAtUtc: pastTimeUtc,
      });

      // 2. Set manager grant to expire in the past directly in persistence
      await fixture.persistence.transaction(tenant, async (tx) => {
        const domain = await tx.securityDomains.get(domainId);
        const grant = await tx.securityGrants.get(domainId, manager);
        assert.ok(domain);
        assert.ok(grant);
        await tx.securityGrants.saveWithDomainVersion({
          ...grant,
          expiresAtUtc: "2000-01-01T00:00:00.000Z",
          version: grant.version + 1,
          updatedAtUtc: pastTimeUtc,
        }, grant.version, {
          ...domain,
          permissionVersion: domain.permissionVersion + 1,
          version: domain.version + 1,
        }, domain.version);
      });

      // 3. Manager attempts to assign leader supplying a backdated occurredAtUtc (inside expired grant window)
      // Must fail closed with NODE_NOT_FOUND (404) because authorization evaluates against trusted current time!
      await assert.rejects(
        executeAssignNodeLeader(fixture.persistence, assignLeaderCmd({
          nodeId: childNodeId,
          leaderPrincipalId: leaderU2,
          expectedVersion: 1,
          commandId: `cmd-tt-backdated-${name}`,
          idempotencyKey: `idem-tt-backdated-${name}`,
          occurredAtUtc: "2026-09-01T12:00:00.000Z",
        })),
        (err) => err instanceof ApplicationError && err.code === "NODE_NOT_FOUND",
        `${fixture.name} - backdated timestamp cannot bypass expired grant`,
      );

      // 3b. Explicit regression: Grant expires between forged occurredAtUtc and trusted current time.
      // Grant expires at 2026-09-02T00:00:00.000Z.
      // Caller provides forged backdated command.occurredAtUtc = "2026-09-01T12:00:00.000Z" (when grant was valid).
      // But trusted persistence.nowUtc() is "2026-09-03T00:00:00.000Z" (when grant is expired).
      // Authorization MUST evaluate against trusted nowUtc, so forged backdating must fail closed with NODE_NOT_FOUND (404)!
      await fixture.persistence.transaction(tenant, async (tx) => {
        const domain = await tx.securityDomains.get(domainId);
        const grant = await tx.securityGrants.get(domainId, manager);
        assert.ok(domain);
        assert.ok(grant);
        await tx.securityGrants.saveWithDomainVersion({
          ...grant,
          expiresAtUtc: "2026-09-02T00:00:00.000Z",
          version: grant.version + 1,
          updatedAtUtc: "2026-09-01T00:00:00.000Z",
        }, grant.version, {
          ...domain,
          permissionVersion: domain.permissionVersion + 1,
          version: domain.version + 1,
        }, domain.version);
      });

      const originalNowUtc = fixture.persistence.nowUtc.bind(fixture.persistence);
      fixture.persistence.nowUtc = () => "2026-09-03T00:00:00.000Z";

      await assert.rejects(
        executeAssignNodeLeader(fixture.persistence, assignLeaderCmd({
          nodeId: childNodeId,
          leaderPrincipalId: leaderU2,
          expectedVersion: 1,
          commandId: `cmd-tt-forged-${name}`,
          idempotencyKey: `idem-tt-forged-${name}`,
          occurredAtUtc: "2026-09-01T12:00:00.000Z", // Forged backdated time when grant was not yet expired
        })),
        (err) => err instanceof ApplicationError && err.code === "NODE_NOT_FOUND",
        `${fixture.name} - forged backdating past expired grant fails closed against trusted nowUtc`,
      );

      fixture.persistence.nowUtc = originalNowUtc;

      // 4. Restore manager grant to active (null expiry)
      await fixture.persistence.transaction(tenant, async (tx) => {
        const domain = await tx.securityDomains.get(domainId);
        const grant = await tx.securityGrants.get(domainId, manager);
        assert.ok(domain);
        assert.ok(grant);
        await tx.securityGrants.saveWithDomainVersion({
          ...grant,
          expiresAtUtc: null,
          version: grant.version + 1,
          updatedAtUtc: pastTimeUtc,
        }, grant.version, {
          ...domain,
          permissionVersion: domain.permissionVersion + 1,
          version: domain.version + 1,
        }, domain.version);
      });

      // 5. Future timestamp is accepted as audit metadata while authorization succeeds
      const futureTimeUtc = "2035-01-01T00:00:00.000Z";
      const futureResult = await executeAssignNodeLeader(fixture.persistence, assignLeaderCmd({
        nodeId: childNodeId,
        leaderPrincipalId: leaderU2,
        expectedVersion: 1,
        commandId: `cmd-tt-future-${name}`,
        idempotencyKey: `idem-tt-future-${name}`,
        occurredAtUtc: futureTimeUtc,
      }));
      assert.equal(futureResult.node.leaderPrincipalId, leaderU2);
      assert.equal(futureResult.event.occurredAtUtc, futureTimeUtc);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("Finding 2: Idempotent replay reauthorizes principal, membership, grant, deletion, candidate and migration state", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    async function setupScenario(scenarioKey: string) {
      const fixture = await createFixture(name);
      await prepareIdentities(fixture.persistence);
      const atUtc = "2026-09-05T01:00:00.000Z";

      const rootNodeId = `node-rep-root-${name}-${scenarioKey}`;
      await executeCreateNode(fixture.persistence, createNodeCmd({
        nodeId: rootNodeId,
        leaderPrincipalId: null,
        commandId: `cmd-rep-root-${name}-${scenarioKey}`,
        idempotencyKey: `idem-rep-root-${name}-${scenarioKey}`,
      }));
      const domainId = `domain-rep-${name}-${scenarioKey}`;
      await new CreateSecurityRootHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: `cmd-rep-sec-${name}-${scenarioKey}`,
        idempotencyKey: `idem-rep-sec-${name}-${scenarioKey}`,
        correlationId: "rep",
        principalId: manager,
        projectId,
        nodeId: rootNodeId,
        securityDomainId: domainId,
        reason: "replay root",
        occurredAtUtc: atUtc,
        expectedNodeVersion: 1,
      });

      await new ManageSecurityGrantHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: `grant-rep-alt-${name}-${scenarioKey}`,
        idempotencyKey: `grant-rep-alt-${name}-${scenarioKey}`,
        correlationId: "rep",
        principalId: manager,
        projectId,
        securityDomainId: domainId,
        targetPrincipalId: alternateManager,
        action: "set",
        capability: "manage_access",
        expiresAtUtc: null,
        expectedGrantVersion: null,
        expectedDomainVersion: 1,
        reason: "second admin for replay tests",
        occurredAtUtc: atUtc,
      });

      const childNodeId = `node-rep-child-${name}-${scenarioKey}`;
      await executeCreateNode(fixture.persistence, createNodeCmd({
        nodeId: childNodeId,
        parentId: rootNodeId,
        leaderPrincipalId: null,
        commandId: `cmd-rep-child-${name}-${scenarioKey}`,
        idempotencyKey: `idem-rep-child-${name}-${scenarioKey}`,
      }));

      const assignCmd = assignLeaderCmd({
        nodeId: childNodeId,
        leaderPrincipalId: leaderU2,
        expectedVersion: 1,
        commandId: `cmd-rep-assign-${name}-${scenarioKey}`,
        idempotencyKey: `idem-rep-assign-${name}-${scenarioKey}`,
      });
      const initial = await executeAssignNodeLeader(fixture.persistence, assignCmd);
      assert.equal(initial.replayed, false);
      assert.equal(initial.node.leaderPrincipalId, leaderU2);

      // Verify normal replay works
      const replayOk = await executeAssignNodeLeader(fixture.persistence, assignCmd);
      assert.equal(replayOk.replayed, true);

      return { fixture, rootNodeId, childNodeId, domainId, assignCmd, atUtc };
    }

    // --- Case A: Actor demoted to member ---
    {
      const s = await setupScenario("demote");
      try {
        await s.fixture.persistence.transaction(tenant, async (tx) => {
          const mem = await tx.memberships.get(projectId, manager);
          assert.ok(mem);
          await tx.memberships.restrictWithSecurityDomains({
            ...mem,
            role: "member",
            version: mem.version + 1,
          }, mem.version, s.atUtc);
        });
        await assert.rejects(
          executeAssignNodeLeader(s.fixture.persistence, s.assignCmd),
          (err) => err instanceof ApplicationError && err.code === "NODE_NOT_FOUND",
          `${name} - demoted actor replay rejected 404`,
        );
      } finally {
        await s.fixture.cleanup();
      }
    }

    // --- Case B: Sensitive Grant revoked ---
    {
      const s = await setupScenario("revoke-grant");
      try {
        await new ManageSecurityGrantHandler(s.fixture.persistence).execute({
          tenantId: tenant,
          commandId: `revoke-rep-mgr-${name}`,
          idempotencyKey: `revoke-rep-mgr-${name}`,
          correlationId: "rep",
          principalId: alternateManager,
          projectId,
          securityDomainId: s.domainId,
          targetPrincipalId: manager,
          action: "revoke",
          capability: null,
          expiresAtUtc: null,
          expectedGrantVersion: 1,
          expectedDomainVersion: 2,
          reason: "revoke manager grant for replay test",
          occurredAtUtc: s.atUtc,
        });
        await assert.rejects(
          executeAssignNodeLeader(s.fixture.persistence, s.assignCmd),
          (err) => err instanceof ApplicationError && err.code === "NODE_NOT_FOUND",
          `${name} - revoked grant replay rejected 404`,
        );
      } finally {
        await s.fixture.cleanup();
      }
    }

    // --- Case C: Sensitive Grant expired ---
    {
      const s = await setupScenario("expire-grant");
      try {
        await s.fixture.persistence.transaction(tenant, async (tx) => {
          const domain = await tx.securityDomains.get(s.domainId);
          const grant = await tx.securityGrants.get(s.domainId, manager);
          assert.ok(domain);
          assert.ok(grant);
          await tx.securityGrants.saveWithDomainVersion({
            ...grant,
            expiresAtUtc: "2000-01-01T00:00:00.000Z",
            version: grant.version + 1,
            updatedAtUtc: s.atUtc,
          }, grant.version, {
            ...domain,
            permissionVersion: domain.permissionVersion + 1,
            version: domain.version + 1,
          }, domain.version);
        });
        await assert.rejects(
          executeAssignNodeLeader(s.fixture.persistence, s.assignCmd),
          (err) => err instanceof ApplicationError && err.code === "NODE_NOT_FOUND",
          `${name} - expired grant replay rejected 404`,
        );
      } finally {
        await s.fixture.cleanup();
      }
    }

    // --- Case D: Node soft-deleted ---
    {
      const s = await setupScenario("delete-node");
      try {
        if (s.fixture.path) {
          const db = new DatabaseSync(s.fixture.path);
          db.prepare("UPDATE project_nodes SET deleted_at_utc = ? WHERE tenant_id = ? AND node_id = ?").run(s.atUtc, tenant, s.childNodeId);
          db.close();
        } else {
          const snap = (s.fixture.persistence as MemoryPersistence).snapshot();
          const current = snap.nodes.get(`${tenant}\u0000${s.childNodeId}`);
          if (current) {
            snap.nodes.set(`${tenant}\u0000${s.childNodeId}`, { ...current, deletedAtUtc: s.atUtc });
            const newMem = new MemoryPersistence({ snapshot: snap });
            s.fixture.persistence = newMem;
          }
        }
        await assert.rejects(
          executeAssignNodeLeader(s.fixture.persistence, s.assignCmd),
          (err) => err instanceof ApplicationError && err.code === "NODE_NOT_FOUND",
          `${name} - soft deleted node replay rejected 404`,
        );
      } finally {
        await s.fixture.cleanup();
      }
    }

    // --- Case E: Candidate revoked ---
    {
      const s = await setupScenario("revoke-candidate");
      try {
        await s.fixture.persistence.transaction(tenant, async (tx) => {
          const cand = await tx.principals.get(leaderU2);
          assert.ok(cand);
          await tx.principals.update({
            ...cand,
            status: "revoked",
            version: cand.version + 1,
            updatedAtUtc: s.atUtc,
          }, cand.version);
        });
        await assert.rejects(
          executeAssignNodeLeader(s.fixture.persistence, s.assignCmd),
          (err) => err instanceof ApplicationError && err.code === "INVALID_NODE_LEADER",
          `${name} - revoked candidate replay rejected`,
        );
      } finally {
        await s.fixture.cleanup();
      }
    }

    // --- Case F: Active migration ---
    {
      const s = await setupScenario("active-migration");
      try {
        await s.fixture.persistence.transaction(tenant, async (tx) => {
          const planned: SecurityDomainMigration = {
            tenantId: tenant,
            id: `mig-rep-${name}`,
            projectId,
            rootNodeId: s.rootNodeId,
            sourceSecurityDomainId: s.domainId,
            targetSecurityDomainId: s.domainId,
            hierarchyRevision: 1,
            sourceSecurityEpoch: 1,
            targetSecurityEpoch: 2,
            state: "planned",
            cursor: null,
            totalItems: 1,
            migratedItems: 0,
            failure: null,
            nextAttemptAtUtc: null,
            deadlineAtUtc: "2026-09-15T00:00:00.000Z",
            version: 1,
            createdAtUtc: s.atUtc,
            updatedAtUtc: s.atUtc,
          };
          const active = transitionSecurityMigration(planned, "active", s.atUtc);
          await tx.securityMigrations.insert(planned);
          await tx.securityMigrations.saveProgressPreservingPlan(active.id, active, planned.version);
        });
        await assert.rejects(
          executeAssignNodeLeader(s.fixture.persistence, s.assignCmd),
          (err) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_IN_PROGRESS",
          `${name} - active migration replay rejected`,
        );
      } finally {
        await s.fixture.cleanup();
      }
    }

    // --- Case G: executeCreateNode replay revalidates authoritative node, soft-deletion and drift ---
    {
      const fixture = await createFixture(name);
      try {
        await prepareIdentities(fixture.persistence);
        const atUtc = "2026-09-05T01:00:00.000Z";
        const createCmd = createNodeCmd({
          nodeId: `node-rep-create-${name}`,
          leaderPrincipalId: leaderU2,
          commandId: `cmd-rep-create-${name}`,
          idempotencyKey: `idem-rep-create-${name}`,
        });

        const created = await executeCreateNode(fixture.persistence, createCmd);
        assert.equal(created.replayed, false);
        assert.equal(created.node.leaderPrincipalId, leaderU2);

        // 1. Normal replay succeeds and returns replayed: true with authoritative node
        const normalReplay = await executeCreateNode(fixture.persistence, createCmd);
        assert.equal(normalReplay.replayed, true);
        assert.equal(normalReplay.node.id, createCmd.nodeId);
        assert.equal(normalReplay.node.deletedAtUtc, null);

        // 2. Soft-delete the created node
        if (fixture.path) {
          const db = new DatabaseSync(fixture.path);
          db.prepare("UPDATE project_nodes SET deleted_at_utc = ? WHERE tenant_id = ? AND node_id = ?").run(atUtc, tenant, createCmd.nodeId);
          db.close();
        } else {
          const snap = (fixture.persistence as MemoryPersistence).snapshot();
          const current = snap.nodes.get(`${tenant}\u0000${createCmd.nodeId}`);
          assert.ok(current);
          snap.nodes.set(`${tenant}\u0000${createCmd.nodeId}`, { ...current, deletedAtUtc: atUtc });
          fixture.persistence = new MemoryPersistence({ snapshot: snap });
        }

        // Replay MUST fail closed with NODE_NOT_FOUND (cannot return stale undeleted receipt!)
        await assert.rejects(
          executeCreateNode(fixture.persistence, createCmd),
          (err) => err instanceof ApplicationError && err.code === "NODE_NOT_FOUND",
          `${name} - executeCreateNode replay after soft-delete fails closed with NODE_NOT_FOUND`,
        );

        // 3. Un-delete, but mutate title to simulate node state drift
        if (fixture.path) {
          const db = new DatabaseSync(fixture.path);
          db.prepare("UPDATE project_nodes SET deleted_at_utc = NULL, title = ? WHERE tenant_id = ? AND node_id = ?").run("Drifted Title", tenant, createCmd.nodeId);
          db.close();
        } else {
          const snap = (fixture.persistence as MemoryPersistence).snapshot();
          const current = snap.nodes.get(`${tenant}\u0000${createCmd.nodeId}`);
          assert.ok(current);
          snap.nodes.set(`${tenant}\u0000${createCmd.nodeId}`, { ...current, deletedAtUtc: null, title: "Drifted Title" });
          fixture.persistence = new MemoryPersistence({ snapshot: snap });
        }

        await assert.rejects(
          executeCreateNode(fixture.persistence, createCmd),
          (err) => err instanceof ApplicationError && err.code === "NODE_NOT_FOUND",
          `${name} - executeCreateNode replay after state drift fails closed with NODE_NOT_FOUND`,
        );

        // 4. Restore title, test actor demoted from PM
        if (fixture.path) {
          const db = new DatabaseSync(fixture.path);
          db.prepare("UPDATE project_nodes SET title = ? WHERE tenant_id = ? AND node_id = ?").run(createCmd.title, tenant, createCmd.nodeId);
          db.close();
        } else {
          const snap = (fixture.persistence as MemoryPersistence).snapshot();
          const current = snap.nodes.get(`${tenant}\u0000${createCmd.nodeId}`);
          assert.ok(current);
          snap.nodes.set(`${tenant}\u0000${createCmd.nodeId}`, { ...current, title: createCmd.title });
          fixture.persistence = new MemoryPersistence({ snapshot: snap });
        }

        await fixture.persistence.transaction(tenant, async (tx) => {
          const mem = await tx.memberships.get(projectId, manager);
          assert.ok(mem);
          await tx.memberships.restrictWithSecurityDomains({
            ...mem,
            role: "member",
            version: mem.version + 1,
          }, mem.version, atUtc);
        });

        await assert.rejects(
          executeCreateNode(fixture.persistence, createCmd),
          (err) => err instanceof ApplicationError && err.code === "FORBIDDEN",
          `${name} - executeCreateNode replay after actor demotion fails closed with FORBIDDEN`,
        );
      } finally {
        await fixture.cleanup();
      }
    }
  }
});

test("Finding 4: Generic persistence bypass prevention on nodes.insert and nodes.assignLeader", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const fixture = await createFixture(name);
    try {
      await prepareIdentities(fixture.persistence);
      const atUtc = "2026-09-05T01:00:00.000Z";

      // 1. Direct generic nodes.insert rejects non-null leaders with NODE_LEADER_DIRECT_INSERT_FORBIDDEN
      await fixture.persistence.transaction(tenant, async (tx) => {
        // Service principal
        await assert.rejects(
          tx.nodes.insert({
            tenantId: tenant,
            id: `bp-node-svc-${name}`,
            projectId,
            parentId: null,
            leaderPrincipalId: servicePrincipal,
            title: "Service Leader Node",
            kind: "work_package",
            securityDomainId: null,
            securityEpoch: 1,
            version: 1,
            deletedAtUtc: null,
          }),
          (err: any) => err instanceof ApplicationError && err.code === "NODE_LEADER_DIRECT_INSERT_FORBIDDEN",
          `${fixture.name} - direct insert with service principal leader rejected`,
        );

        // Revoked user
        await assert.rejects(
          tx.nodes.insert({
            tenantId: tenant,
            id: `bp-node-rev-${name}`,
            projectId,
            parentId: null,
            leaderPrincipalId: revokedUser,
            title: "Revoked User Leader Node",
            kind: "work_package",
            securityDomainId: null,
            securityEpoch: 1,
            version: 1,
            deletedAtUtc: null,
          }),
          (err: any) => err instanceof ApplicationError && err.code === "NODE_LEADER_DIRECT_INSERT_FORBIDDEN",
          `${fixture.name} - direct insert with revoked user leader rejected`,
        );

        // Non-member
        await assert.rejects(
          tx.nodes.insert({
            tenantId: tenant,
            id: `bp-node-nm-${name}`,
            projectId,
            parentId: null,
            leaderPrincipalId: crossTenantUser,
            title: "Cross Tenant Leader Node",
            kind: "work_package",
            securityDomainId: null,
            securityEpoch: 1,
            version: 1,
            deletedAtUtc: null,
          }),
          (err: any) => err instanceof ApplicationError && err.code === "NODE_LEADER_DIRECT_INSERT_FORBIDDEN",
          `${fixture.name} - direct insert with non-member leader rejected`,
        );
      });

      // Guarded executeCreateNode rejects invalid candidates with INVALID_NODE_LEADER
      await assert.rejects(
        executeCreateNode(fixture.persistence, createNodeCmd({
          nodeId: `bp-node-cmd-svc-${name}`,
          leaderPrincipalId: servicePrincipal,
          commandId: `cmd-bp-svc-${name}`,
          idempotencyKey: `idem-bp-svc-${name}`,
        })),
        /INVALID_NODE_LEADER/,
        `${fixture.name} - guarded create with service principal rejected`,
      );
      await assert.rejects(
        executeCreateNode(fixture.persistence, createNodeCmd({
          nodeId: `bp-node-cmd-rev-${name}`,
          leaderPrincipalId: revokedUser,
          commandId: `cmd-bp-rev-${name}`,
          idempotencyKey: `idem-bp-rev-${name}`,
        })),
        /INVALID_NODE_LEADER/,
        `${fixture.name} - guarded create with revoked user rejected`,
      );
      await assert.rejects(
        executeCreateNode(fixture.persistence, createNodeCmd({
          nodeId: `bp-node-cmd-nm-${name}`,
          leaderPrincipalId: crossTenantUser,
          commandId: `cmd-bp-nm-${name}`,
          idempotencyKey: `idem-bp-nm-${name}`,
        })),
        /INVALID_NODE_LEADER/,
        `${fixture.name} - guarded create with non-member rejected`,
      );

      await fixture.persistence.transaction(tenant, async (tx) => {

        // Valid insert with null leader
        await tx.nodes.insert({
          tenantId: tenant,
          id: `bp-node-valid-${name}`,
          projectId,
          parentId: null,
          leaderPrincipalId: null,
          title: "Valid Node",
          kind: "work_package",
          securityDomainId: null,
          securityEpoch: 1,
          version: 1,
          deletedAtUtc: null,
        });
      });

      // 2. Generic persistence bypass prevention: tx.nodes has NO assignLeader, calling it fails closed
      await fixture.persistence.transaction(tenant, async (tx) => {
        // tx.nodes.assignLeader is undefined
        assert.equal(
          (tx.nodes as any).assignLeader,
          undefined,
          `${fixture.name} - generic tx.nodes.assignLeader must be undefined`,
        );

        // Invoking tx.nodes.assignLeader throws TypeError
        assert.throws(
          () => (tx.nodes as any).assignLeader(`bp-node-valid-${name}`, projectId, leaderU2, 1),
          /is not a function/,
          `${fixture.name} - invoking tx.nodes.assignLeader throws TypeError`,
        );

        // Persistence root also has no assignLeader
        assert.equal(
          (fixture.persistence as any).assignLeader,
          undefined,
          `${fixture.name} - generic persistence.assignLeader must be undefined`,
        );

        // Generic insert with non-null leader is strictly rejected
        await assert.rejects(
          tx.nodes.insert({
            tenantId: tenant,
            id: `bp-node-direct-leader-${name}`,
            projectId,
            parentId: null,
            leaderPrincipalId: leaderU2,
            title: "Direct Leader Insert",
            kind: "work_package",
            securityDomainId: null,
            securityEpoch: 1,
            version: 1,
            deletedAtUtc: null,
          }),
          (err) => err instanceof ApplicationError && err.code === "NODE_LEADER_DIRECT_INSERT_FORBIDDEN",
          `${fixture.name} - direct insert with non-null leader forbidden`,
        );
      });

      // 3. Guarded execution rejects invalid mutations without any exposed raw mutator
      // Soft-deleted / nonexistent node rejected
      await assert.rejects(
        executeAssignNodeLeader(fixture.persistence, assignLeaderCmd({
          nodeId: "nonexistent-node",
          leaderPrincipalId: leaderU2,
          expectedVersion: 1,
          commandId: `cmd-nonexistent-${name}`,
          idempotencyKey: `idem-nonexistent-${name}`,
        })),
        (err) => err instanceof ApplicationError && err.code === "NODE_NOT_FOUND",
        `${fixture.name} - guarded assignLeader nonexistent node rejected 404`,
      );

      // Revoked user candidate
      await assert.rejects(
        executeAssignNodeLeader(fixture.persistence, assignLeaderCmd({
          nodeId: `bp-node-valid-${name}`,
          leaderPrincipalId: revokedUser,
          expectedVersion: 1,
          commandId: `cmd-revoked-${name}`,
          idempotencyKey: `idem-revoked-${name}`,
        })),
        (err) => err instanceof ApplicationError && err.code === "INVALID_NODE_LEADER",
        `${fixture.name} - guarded assignLeader revoked user rejected`,
      );

      // Service principal candidate
      await assert.rejects(
        executeAssignNodeLeader(fixture.persistence, assignLeaderCmd({
          nodeId: `bp-node-valid-${name}`,
          leaderPrincipalId: servicePrincipal,
          expectedVersion: 1,
          commandId: `cmd-svc-${name}`,
          idempotencyKey: `idem-svc-${name}`,
        })),
        (err) => err instanceof ApplicationError && err.code === "INVALID_NODE_LEADER",
        `${fixture.name} - guarded assignLeader service principal rejected`,
      );

      // Non-member candidate
      await assert.rejects(
        executeAssignNodeLeader(fixture.persistence, assignLeaderCmd({
          nodeId: `bp-node-valid-${name}`,
          leaderPrincipalId: crossTenantUser,
          expectedVersion: 1,
          commandId: `cmd-cross-${name}`,
          idempotencyKey: `idem-cross-${name}`,
        })),
        (err) => err instanceof ApplicationError && err.code === "INVALID_NODE_LEADER",
        `${fixture.name} - guarded assignLeader non-member rejected`,
      );

      // Valid assignment succeeds through guarded command
      const updated = await executeAssignNodeLeader(fixture.persistence, assignLeaderCmd({
        nodeId: `bp-node-valid-${name}`,
        leaderPrincipalId: leaderU2,
        expectedVersion: 1,
        commandId: `cmd-valid-assign-${name}`,
        idempotencyKey: `idem-valid-assign-${name}`,
      }));
      assert.equal(updated.node.leaderPrincipalId, leaderU2);
      assert.equal(updated.node.version, 2);
      assert.equal(updated.event.eventType, "project-map.node.leader_assigned");

      // 4. Active migration freeze rejects direct persistence mutations (including null leader!) and guarded commands
      await fixture.persistence.transaction(tenant, async (tx) => {
        const planned: SecurityDomainMigration = {
          tenantId: tenant,
          id: `mig-bp-${name}`,
          projectId,
          rootNodeId: `bp-node-valid-${name}`,
          sourceSecurityDomainId: "dom-bp",
          targetSecurityDomainId: "dom-bp-2",
          hierarchyRevision: 1,
          sourceSecurityEpoch: 1,
          targetSecurityEpoch: 2,
          state: "planned",
          cursor: null,
          totalItems: 1,
          migratedItems: 0,
          failure: null,
          nextAttemptAtUtc: null,
          deadlineAtUtc: "2026-09-15T00:00:00.000Z",
          version: 1,
          createdAtUtc: atUtc,
          updatedAtUtc: atUtc,
        };
        const active = transitionSecurityMigration(planned, "active", atUtc);
        await tx.securityMigrations.insert(planned);
        await tx.securityMigrations.saveProgressPreservingPlan(active.id, active, planned.version);

        // Direct insert during migration with leader (frozen by migration)
        await assert.rejects(
          tx.nodes.insert({
            tenantId: tenant,
            id: `bp-node-mig-frozen-${name}`,
            projectId,
            parentId: null,
            leaderPrincipalId: leaderU2,
            title: "Frozen Insert Node",
            kind: "work_package",
            securityDomainId: null,
            securityEpoch: 1,
            version: 1,
            deletedAtUtc: null,
          }),
          /SECURITY_MIGRATION_IN_PROGRESS/,
          `${fixture.name} - direct insert during active migration rejected`,
        );

        // Direct insert during migration with null leader (ALL node inserts must freeze!)
        await assert.rejects(
          tx.nodes.insert({
            tenantId: tenant,
            id: `bp-node-mig-frozen-null-${name}`,
            projectId,
            parentId: null,
            leaderPrincipalId: null,
            title: "Frozen Insert Node Null Leader",
            kind: "work_package",
            securityDomainId: null,
            securityEpoch: 1,
            version: 1,
            deletedAtUtc: null,
          }),
          /SECURITY_MIGRATION_IN_PROGRESS/,
          `${fixture.name} - direct null-leader insert during active migration rejected`,
        );
      });

      // Guarded assignLeader during active migration rejected
      await assert.rejects(
        executeAssignNodeLeader(fixture.persistence, assignLeaderCmd({
          nodeId: `bp-node-valid-${name}`,
          leaderPrincipalId: memberU1,
          expectedVersion: 2,
          commandId: `cmd-mig-frozen-assign-${name}`,
          idempotencyKey: `idem-mig-frozen-assign-${name}`,
        })),
        (err) => err instanceof ApplicationError && err.code === "SECURITY_MIGRATION_IN_PROGRESS",
        `${fixture.name} - guarded assignLeader during active migration rejected`,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("Finding 5: Genuine v9 create receipt replay upcasts leaderPrincipalId to null, and concurrent v9 migrations succeed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-v9-receipt-"));
  const path = join(directory, "v9-receipt.sqlite");
  try {
    // 1. Setup genuine v9 database with legacy create receipt
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at_utc TEXT NOT NULL) STRICT;
      INSERT INTO schema_migrations (version, applied_at_utc) VALUES
        (1, '2026-09-04T00:00:00.000Z'), (2, '2026-09-04T00:00:00.000Z'),
        (3, '2026-09-04T00:00:00.000Z'), (4, '2026-09-04T00:00:00.000Z'),
        (5, '2026-09-04T00:00:00.000Z'), (6, '2026-09-04T00:00:00.000Z'),
        (7, '2026-09-04T00:00:00.000Z'), (8, '2026-09-04T00:00:00.000Z'),
        (9, '2026-09-04T00:00:00.000Z');
      CREATE TABLE tenants (tenant_id TEXT PRIMARY KEY, state TEXT NOT NULL, created_at_utc TEXT NOT NULL) STRICT;
      INSERT INTO tenants VALUES ('tenant-v9-rcpt', 'active', '2026-09-04T00:00:00.000Z');
      CREATE TABLE project_nodes (
        tenant_id TEXT NOT NULL, node_id TEXT NOT NULL, project_id TEXT NOT NULL,
        parent_node_id TEXT, title TEXT NOT NULL, kind TEXT NOT NULL,
        security_domain_id TEXT, security_epoch INTEGER NOT NULL,
        version INTEGER NOT NULL, deleted_at_utc TEXT,
        PRIMARY KEY (tenant_id, node_id)
      ) STRICT;
      CREATE TABLE command_receipts (
        tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL,
        created_at_utc TEXT NOT NULL,
        PRIMARY KEY (tenant_id, principal_id, operation, idempotency_key)
      ) STRICT;
      CREATE TABLE principals (
        tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, kind TEXT NOT NULL,
        state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
        created_at_utc TEXT NOT NULL, updated_at_utc TEXT NOT NULL,
        PRIMARY KEY (tenant_id, principal_id)
      ) STRICT;
      CREATE TABLE project_memberships (
        tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_id TEXT NOT NULL,
        role TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
        membership_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, project_id, principal_id)
      ) STRICT;
      CREATE TABLE domain_events (
        tenant_id TEXT NOT NULL, event_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
        project_sequence INTEGER NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
        aggregate_version INTEGER NOT NULL, event_type TEXT NOT NULL, schema_version INTEGER NOT NULL,
        occurred_at_utc TEXT NOT NULL, event_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE outbox_messages (
        tenant_id TEXT NOT NULL, message_id TEXT PRIMARY KEY, event_id TEXT NOT NULL,
        topic TEXT NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL,
        available_at_utc TEXT NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
        lease_owner TEXT, lease_token TEXT, lease_expires_at_utc TEXT,
        last_error TEXT, published_at_utc TEXT, created_at_utc TEXT
      ) STRICT;
      CREATE TABLE project_sequences (
        tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, last_sequence INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, project_id)
      ) STRICT;
    `);

    // Insert legacy v9 node and v9 receipt
    const v9Tenant = tenantId("tenant-v9-rcpt");
    const v9NodeId = "legacy-rcpt-node";
    const v9IdemKey = "idem-v9-legacy";
    const legacyPayload = JSON.stringify({
      projectId: "proj-v9",
      nodeId: v9NodeId,
      parentId: null,
      title: "V9 Legacy Title",
      kind: "work_package",
      securityDomainId: null,
    });
    const legacyFp = createHash("sha256").update(legacyPayload).digest("hex");
    const legacyResultJson = JSON.stringify({
      node: {
        tenantId: v9Tenant,
        id: v9NodeId,
        projectId: "proj-v9",
        parentId: null,
        title: "V9 Legacy Title",
        kind: "work_package",
        securityDomainId: null,
        securityEpoch: 1,
        version: 1,
        deletedAtUtc: null,
      },
      event: { eventId: "evt:v9", eventType: "project-map.node.created" },
      outbox: { id: "outbox:v9" },
    });

    db.prepare(`
      INSERT INTO project_nodes VALUES ('tenant-v9-rcpt', 'legacy-rcpt-node', 'proj-v9', NULL, 'V9 Legacy Title', 'work_package', NULL, 1, 1, NULL)
    `).run();
    db.prepare(`
      INSERT INTO command_receipts VALUES ('tenant-v9-rcpt', ?, 'create_node', ?, ?, ?, '2026-09-04T00:00:00.000Z')
    `).run(manager, v9IdemKey, legacyFp, legacyResultJson);
    db.prepare(`
      INSERT INTO principals VALUES ('tenant-v9-rcpt', ?, 'user', 'active', 1, '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z')
    `).run(manager);
    db.prepare(`
      INSERT INTO principals VALUES ('tenant-v9-rcpt', ?, 'user', 'active', 1, '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z')
    `).run(leaderU2);
    db.prepare(`
      INSERT INTO project_memberships VALUES ('tenant-v9-rcpt', 'proj-v9', ?, 'project_manager', 'active', 1, json_object('tenantId', 'tenant-v9-rcpt', 'projectId', 'proj-v9', 'principalId', ?, 'role', 'project_manager', 'status', 'active', 'securityDomainIds', json_array(), 'version', 1, 'createdAtUtc', '2026-09-04T00:00:00.000Z', 'updatedAtUtc', '2026-09-04T00:00:00.000Z'))
    `).run(manager, manager);
    db.prepare(`
      INSERT INTO project_memberships VALUES ('tenant-v9-rcpt', 'proj-v9', ?, 'member', 'active', 1, json_object('tenantId', 'tenant-v9-rcpt', 'projectId', 'proj-v9', 'principalId', ?, 'role', 'member', 'status', 'active', 'securityDomainIds', json_array(), 'version', 1, 'createdAtUtc', '2026-09-04T00:00:00.000Z', 'updatedAtUtc', '2026-09-04T00:00:00.000Z'))
    `).run(leaderU2, leaderU2);
    db.close();

    // 2. Open two concurrent SqlitePersistence connections across genuine child processes to verify cross-process migration serialization
    const workerScript = `
      import { SqlitePersistence } from ${JSON.stringify(resolve(process.cwd(), "packages/adapters/src/sqlite/persistence.ts"))};
      const p = new SqlitePersistence({ path: process.argv[process.argv.length - 1] });
      await p.close();
      process.exit(0);
    `;
    const runWorker = () => new Promise<void>((res, rej) => {
      const cp = spawn(process.execPath, ["--input-type=module", "-e", workerScript, "--", path], { stdio: "inherit" });
      cp.on("exit", (code) => code === 0 ? res() : rej(new Error(`Child process failed with code ${code}`)));
    });
    await Promise.all([runWorker(), runWorker()]);

    const p1 = new SqlitePersistence({ path });

    // 3. SQLite: (a) null/omitted leader replay succeeds and upcasts null
    const replayNull = await executeCreateNode(p1, {
      tenantId: v9Tenant,
      commandId: "cmd-v9-null",
      idempotencyKey: v9IdemKey,
      correlationId: "cor-v9",
      principalId: manager,
      projectId: "proj-v9",
      nodeId: v9NodeId,
      parentId: null,
      leaderPrincipalId: null,
      title: "V9 Legacy Title",
      kind: "work_package",
      securityDomainId: null,
      occurredAtUtc: "2026-09-04T00:00:00.000Z",
    });
    assert.equal(replayNull.replayed, true, "sqlite - legacy receipt null replay should succeed");
    assert.equal(replayNull.node.leaderPrincipalId, null, "sqlite - legacy receipt null replay should upcast null");

    const replayOmitted = await executeCreateNode(p1, {
      tenantId: v9Tenant,
      commandId: "cmd-v9-omitted",
      idempotencyKey: v9IdemKey,
      correlationId: "cor-v9",
      principalId: manager,
      projectId: "proj-v9",
      nodeId: v9NodeId,
      parentId: null,
      title: "V9 Legacy Title",
      kind: "work_package",
      securityDomainId: null,
      occurredAtUtc: "2026-09-04T00:00:00.000Z",
    });
    assert.equal(replayOmitted.replayed, true, "sqlite - legacy receipt omitted leader replay should succeed");
    assert.equal(replayOmitted.node.leaderPrincipalId, null, "sqlite - legacy receipt omitted leader replay should upcast null");

    // Record baseline state before (b)
    const nodeBeforeSqlite = await p1.read(v9Tenant, async (tx) => await tx.nodes.get(v9NodeId));
    const receiptBeforeSqlite = await p1.read(v9Tenant, async (tx) => await tx.receipts.get({
      principalId: manager,
      operation: "create_node",
      idempotencyKey: v9IdemKey,
    }));
    const preStatsSqlite = await countEventsAndOutbox({ name: "sqlite", persistence: p1, path, cleanup: async () => {} }, v9Tenant);
    const preSeqSqlite = await p1.read(v9Tenant, async (tx) => await tx.sequences.current("proj-v9"));

    // (b) non-null eligible leader with same key rejects exact idempotency reuse error
    await assert.rejects(
      executeCreateNode(p1, {
        tenantId: v9Tenant,
        commandId: "cmd-v9-nonnull-conflict",
        idempotencyKey: v9IdemKey,
        correlationId: "cor-v9-conflict",
        principalId: manager,
        projectId: "proj-v9",
        nodeId: v9NodeId,
        parentId: null,
        leaderPrincipalId: leaderU2,
        title: "V9 Legacy Title",
        kind: "work_package",
        securityDomainId: null,
        occurredAtUtc: "2026-09-04T00:00:00.000Z",
      }),
      (err) => err instanceof ApplicationError && err.code === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
      "sqlite - non-null leader with same key must reject IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
    );

    // (c) prove zero node/event/outbox/receipt/sequence changes after rejection
    const nodeAfterSqlite = await p1.read(v9Tenant, async (tx) => await tx.nodes.get(v9NodeId));
    const receiptAfterSqlite = await p1.read(v9Tenant, async (tx) => await tx.receipts.get({
      principalId: manager,
      operation: "create_node",
      idempotencyKey: v9IdemKey,
    }));
    const postStatsSqlite = await countEventsAndOutbox({ name: "sqlite", persistence: p1, path, cleanup: async () => {} }, v9Tenant);
    const postSeqSqlite = await p1.read(v9Tenant, async (tx) => await tx.sequences.current("proj-v9"));

    assert.deepEqual(nodeAfterSqlite, nodeBeforeSqlite, "sqlite - node unchanged after rejection");
    assert.equal(nodeAfterSqlite?.leaderPrincipalId, null, "sqlite - node leader remains null");
    assert.deepEqual(receiptAfterSqlite, receiptBeforeSqlite, "sqlite - receipt unchanged after rejection");
    assert.equal(postStatsSqlite.events, preStatsSqlite.events, "sqlite - event count unchanged");
    assert.equal(postStatsSqlite.outbox, preStatsSqlite.outbox, "sqlite - outbox count unchanged");
    assert.equal(postSeqSqlite, preSeqSqlite, "sqlite - sequence unchanged");

    await p1.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  // 4. Memory: direct regression test seeded with v9 receipt / null-leader node
  {
    const memBundle = createTestMemoryBundle();
    const memP = memBundle.persistence;
    const memTenant = tenantId("tenant-v9-mem");
    const memProjectId = "proj-v9-mem";
    const memNodeId = "legacy-mem-node";
    const memIdemKey = "idem-v9-mem";

    await memP.transaction(memTenant, async (tx) => {
      await tx.principals.insert({
        tenantId: memTenant,
        id: manager,
        kind: "user",
        status: "active",
        version: 1,
        createdAtUtc: "2026-09-04T00:00:00.000Z",
        updatedAtUtc: "2026-09-04T00:00:00.000Z",
      });
      await tx.principals.insert({
        tenantId: memTenant,
        id: leaderU2,
        kind: "user",
        status: "active",
        version: 1,
        createdAtUtc: "2026-09-04T00:00:00.000Z",
        updatedAtUtc: "2026-09-04T00:00:00.000Z",
      });
      await tx.memberships.insert({
        tenantId: memTenant,
        projectId: memProjectId,
        principalId: manager,
        role: "project_manager",
        status: "active",
        securityDomainIds: [],
        version: 1,
        createdAtUtc: "2026-09-04T00:00:00.000Z",
        updatedAtUtc: "2026-09-04T00:00:00.000Z",
      });
      await tx.memberships.insert({
        tenantId: memTenant,
        projectId: memProjectId,
        principalId: leaderU2,
        role: "member",
        status: "active",
        securityDomainIds: [],
        version: 1,
        createdAtUtc: "2026-09-04T00:00:00.000Z",
        updatedAtUtc: "2026-09-04T00:00:00.000Z",
      });
      await tx.nodes.insert({
        tenantId: memTenant,
        id: memNodeId,
        projectId: memProjectId,
        parentId: null,
        leaderPrincipalId: null,
        title: "V9 Legacy Mem Title",
        kind: "work_package",
        securityDomainId: null,
        securityEpoch: 1,
        version: 1,
        deletedAtUtc: null,
      });

      const memLegacyPayload = JSON.stringify({
        projectId: memProjectId,
        nodeId: memNodeId,
        parentId: null,
        title: "V9 Legacy Mem Title",
        kind: "work_package",
        securityDomainId: null,
      });
      const memLegacyFp = createHash("sha256").update(memLegacyPayload).digest("hex");

      await tx.receipts.insert({
        scope: {
          principalId: manager,
          operation: "create_node",
          idempotencyKey: memIdemKey,
        },
        fingerprint: memLegacyFp,
        result: {
          node: {
            tenantId: memTenant,
            id: memNodeId,
            projectId: memProjectId,
            parentId: null,
            leaderPrincipalId: null,
            title: "V9 Legacy Mem Title",
            kind: "work_package",
            securityDomainId: null,
            securityEpoch: 1,
            version: 1,
            deletedAtUtc: null,
          },
          event: { eventId: "evt:v9-mem", eventType: "project-map.node.created" } as any,
          outbox: { id: "outbox:v9-mem" } as any,
        },
        createdAtUtc: "2026-09-04T00:00:00.000Z",
      });
    });

    // (a) null/omitted leader replay succeeds and upcasts null
    const memReplayNull = await executeCreateNode(memP, {
      tenantId: memTenant,
      commandId: "cmd-mem-null",
      idempotencyKey: memIdemKey,
      correlationId: "cor-mem",
      principalId: manager,
      projectId: memProjectId,
      nodeId: memNodeId,
      parentId: null,
      leaderPrincipalId: null,
      title: "V9 Legacy Mem Title",
      kind: "work_package",
      securityDomainId: null,
      occurredAtUtc: "2026-09-04T00:00:00.000Z",
    });
    assert.equal(memReplayNull.replayed, true, "memory - legacy receipt null replay should succeed");
    assert.equal(memReplayNull.node.leaderPrincipalId, null, "memory - legacy receipt null replay should upcast null");

    const memReplayOmitted = await executeCreateNode(memP, {
      tenantId: memTenant,
      commandId: "cmd-mem-omitted",
      idempotencyKey: memIdemKey,
      correlationId: "cor-mem",
      principalId: manager,
      projectId: memProjectId,
      nodeId: memNodeId,
      parentId: null,
      title: "V9 Legacy Mem Title",
      kind: "work_package",
      securityDomainId: null,
      occurredAtUtc: "2026-09-04T00:00:00.000Z",
    });
    assert.equal(memReplayOmitted.replayed, true, "memory - legacy receipt omitted leader replay should succeed");
    assert.equal(memReplayOmitted.node.leaderPrincipalId, null, "memory - legacy receipt omitted leader replay should upcast null");

    // Record baseline state before (b)
    const nodeBeforeMem = await memP.read(memTenant, async (tx) => await tx.nodes.get(memNodeId));
    const receiptBeforeMem = await memP.read(memTenant, async (tx) => await tx.receipts.get({
      principalId: manager,
      operation: "create_node",
      idempotencyKey: memIdemKey,
    }));
    const preStatsMem = await countEventsAndOutbox({ name: "memory", persistence: memP, cleanup: async () => {} }, memTenant);
    const preSeqMem = await memP.read(memTenant, async (tx) => await tx.sequences.current(memProjectId));

    // (b) non-null eligible leader with same key rejects exact idempotency reuse error
    await assert.rejects(
      executeCreateNode(memP, {
        tenantId: memTenant,
        commandId: "cmd-mem-nonnull-conflict",
        idempotencyKey: memIdemKey,
        correlationId: "cor-mem-conflict",
        principalId: manager,
        projectId: memProjectId,
        nodeId: memNodeId,
        parentId: null,
        leaderPrincipalId: leaderU2,
        title: "V9 Legacy Mem Title",
        kind: "work_package",
        securityDomainId: null,
        occurredAtUtc: "2026-09-04T00:00:00.000Z",
      }),
      (err) => err instanceof ApplicationError && err.code === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
      "memory - non-null leader with same key must reject IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
    );

    // (c) prove zero node/event/outbox/receipt/sequence changes after rejection
    const nodeAfterMem = await memP.read(memTenant, async (tx) => await tx.nodes.get(memNodeId));
    const receiptAfterMem = await memP.read(memTenant, async (tx) => await tx.receipts.get({
      principalId: manager,
      operation: "create_node",
      idempotencyKey: memIdemKey,
    }));
    const postStatsMem = await countEventsAndOutbox({ name: "memory", persistence: memP, cleanup: async () => {} }, memTenant);
    const postSeqMem = await memP.read(memTenant, async (tx) => await tx.sequences.current(memProjectId));

    assert.deepEqual(nodeAfterMem, nodeBeforeMem, "memory - node unchanged after rejection");
    assert.equal(nodeAfterMem?.leaderPrincipalId, null, "memory - node leader remains null");
    assert.deepEqual(receiptAfterMem, receiptBeforeMem, "memory - receipt unchanged after rejection");
    assert.equal(postStatsMem.events, preStatsMem.events, "memory - event count unchanged");
    assert.equal(postStatsMem.outbox, preStatsMem.outbox, "memory - outbox count unchanged");
    assert.equal(postSeqMem, preSeqMem, "memory - sequence unchanged");
  }
});

test("Finding 6: ADR-008 schema registry, fixtures, sensitive field negatives and unknown version dead-letter", async () => {
  // 1. Registry structure
  assert.equal(nodeEventSchemas.created.eventType, "project-map.node.created");
  assert.equal(nodeEventSchemas.created.schemaVersion, 1);
  assert.deepEqual(nodeEventSchemas.created.requiredPayloadFields, ["nodeId", "parentId", "title", "kind"]);
  assert.equal(nodeEventSchemas.leaderAssigned.eventType, "project-map.node.leader_assigned");
  assert.equal(nodeEventSchemas.leaderAssigned.schemaVersion, 1);
  assert.deepEqual(nodeEventSchemas.leaderAssigned.requiredPayloadFields, ["nodeId", "previousLeaderPrincipalId", "leaderPrincipalId"]);

  // 2. Load and validate v1 fixtures
  const fixturesPath = join(process.cwd(), "tests/fixtures/node-events-v1.json");
  const rawFixtures = await readFile(fixturesPath, "utf-8");
  const fixtures = JSON.parse(rawFixtures) as Array<{ eventType: string; schemaVersion: number; payload: Record<string, unknown> }>;
  assert.ok(fixtures.length >= 4);

  const forbiddenSensitiveKeys = ["secret", "token", "password", "apiKey", "credentials", "authorization"];
  for (const item of fixtures) {
    if (item.eventType === nodeEventSchemas.created.eventType) {
      assert.equal(item.schemaVersion, 1);
      for (const field of nodeEventSchemas.created.requiredPayloadFields) {
        assert.ok(field in item.payload, `created fixture missing field: ${field}`);
      }
    } else if (item.eventType === nodeEventSchemas.leaderAssigned.eventType) {
      assert.equal(item.schemaVersion, 1);
      for (const field of nodeEventSchemas.leaderAssigned.requiredPayloadFields) {
        assert.ok(field in item.payload, `leaderAssigned fixture missing field: ${field}`);
      }
    } else {
      assert.fail(`Unexpected event type: ${item.eventType}`);
    }

    // Verify negative check: NO sensitive fields in payload
    for (const key of Object.keys(item.payload)) {
      assert.equal(forbiddenSensitiveKeys.includes(key), false, `Sensitive key leaked in payload: ${key}`);
    }
  }

  // 3. Unrecognized event version dead-letter / halt assertion
  const simulatedConsumer = (event: { eventType: string; schemaVersion: number }) => {
    const known = Object.values(nodeEventSchemas).find(
      (s) => s.eventType === event.eventType && s.schemaVersion === event.schemaVersion,
    );
    if (!known) {
      throw new Error(`DEAD_LETTER: Unrecognized event version ${event.eventType}.v${event.schemaVersion}`);
    }
    return true;
  };

  assert.equal(simulatedConsumer({ eventType: "project-map.node.created", schemaVersion: 1 }), true);
  assert.throws(
    () => simulatedConsumer({ eventType: "project-map.node.created", schemaVersion: 999 }),
    /DEAD_LETTER: Unrecognized event version project-map\.node\.created\.v999/,
  );
});

test("Finding 7: Explicit last-admin coverage - U2 with permanent manage_access grant cannot satisfy or bypass last project manager", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const fixture = await createFixture(name);
    try {
      await prepareIdentities(fixture.persistence);
      const atUtc = "2026-09-05T01:00:00.000Z";

      // 1. Create sensitive root with manager as first administrator
      const rootNodeId = `node-la7-root-${name}`;
      await executeCreateNode(fixture.persistence, createNodeCmd({
        nodeId: rootNodeId,
        leaderPrincipalId: null,
        commandId: `cmd-la7-root-${name}`,
        idempotencyKey: `idem-la7-root-${name}`,
      }));
      const domainId = `domain-la7-${name}`;
      await new CreateSecurityRootHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: `cmd-la7-sec-${name}`,
        idempotencyKey: `idem-la7-sec-${name}`,
        correlationId: "la7",
        principalId: manager,
        projectId,
        nodeId: rootNodeId,
        securityDomainId: domainId,
        reason: "last admin test root",
        occurredAtUtc: atUtc,
        expectedNodeVersion: 1,
      });

      // 2. Manager grants U2 (role: member) a PERMANENT manage_access grant
      await new ManageSecurityGrantHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: `grant-la7-u2-${name}`,
        idempotencyKey: `grant-la7-u2-${name}`,
        correlationId: "la7",
        principalId: manager,
        projectId,
        securityDomainId: domainId,
        targetPrincipalId: leaderU2,
        action: "set",
        capability: "manage_access",
        expiresAtUtc: null, // permanent grant!
        expectedGrantVersion: null,
        expectedDomainVersion: 1,
        reason: "grant u2 permanent manage_access",
        occurredAtUtc: atUtc,
      });

      // Verify U2 grant is active and permanent
      const u2Grant = await fixture.persistence.read(tenant, async (tx) => await tx.securityGrants.get(domainId, leaderU2));
      assert.ok(u2Grant);
      assert.equal(u2Grant.capability, "manage_access");
      assert.equal(u2Grant.expiresAtUtc, null);

      // 3. Manager attempts to demote manager's own membership to 'member'
      // MUST be rejected because U2 is only a 'member' and does NOT count as a valid project manager for last-admin protection!
      await assert.rejects(
        new RestrictProjectMembershipHandler(fixture.persistence).execute({
          tenantId: tenant,
          commandId: `demote-mgr-la7-${name}`,
          idempotencyKey: `demote-mgr-la7-${name}`,
          correlationId: "la7",
          principalId: manager,
          projectId,
          targetPrincipalId: manager,
          action: "demote",
          reason: "attempt demote last pm",
          expectedMembershipVersion: 1,
          occurredAtUtc: atUtc,
        }),
        (err) => err instanceof ApplicationError && err.code === "SECURITY_DOMAIN_LAST_ADMINISTRATOR",
        `${fixture.name} - demoting last PM rejected despite U2 having permanent manage_access`,
      );

      // 4. Manager attempts to revoke manager's own manage_access grant
      // MUST also be rejected with SECURITY_DOMAIN_LAST_ADMINISTRATOR!
      await assert.rejects(
        new ManageSecurityGrantHandler(fixture.persistence).execute({
          tenantId: tenant,
          commandId: `revoke-mgr-la7-${name}`,
          idempotencyKey: `revoke-mgr-la7-${name}`,
          correlationId: "la7",
          principalId: manager,
          projectId,
          securityDomainId: domainId,
          targetPrincipalId: manager,
          action: "revoke",
          capability: null,
          expiresAtUtc: null,
          expectedGrantVersion: 1,
          expectedDomainVersion: 2,
          reason: "attempt revoke last pm grant",
          occurredAtUtc: atUtc,
        }),
        (err) => err instanceof ApplicationError && err.code === "SECURITY_DOMAIN_LAST_ADMINISTRATOR",
        `${fixture.name} - revoking last PM grant rejected despite U2 having permanent manage_access`,
      );

      // 5. If another valid project manager is granted permanent manage_access:
      await new ManageSecurityGrantHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: `grant-alt-la7-${name}`,
        idempotencyKey: `grant-alt-la7-${name}`,
        correlationId: "la7",
        principalId: manager,
        projectId,
        securityDomainId: domainId,
        targetPrincipalId: alternateManager,
        action: "set",
        capability: "manage_access",
        expiresAtUtc: null,
        expectedGrantVersion: null,
        expectedDomainVersion: 2,
        reason: "second real pm admin",
        occurredAtUtc: atUtc,
      });

      // Now manager can revoke their own grant because alternateManager is an active user + active PM + permanent grant!
      const revokeOk = await new ManageSecurityGrantHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: `revoke-mgr-la7-now-ok-${name}`,
        idempotencyKey: `revoke-mgr-la7-now-ok-${name}`,
        correlationId: "la7",
        principalId: manager,
        projectId,
        securityDomainId: domainId,
        targetPrincipalId: manager,
        action: "revoke",
        capability: null,
        expiresAtUtc: null,
        expectedGrantVersion: 1,
        expectedDomainVersion: 3,
        reason: "now safe to revoke",
        occurredAtUtc: atUtc,
      });
      assert.equal(revokeOk.value.status, "revoked");
    } finally {
      await fixture.cleanup();
    }
  }
});

test("Finding 3: Authoritative production wiring - HTTP Product API matrix for U0/U1/U2/U3, soft-deletion, and assign-leader action", async () => {
  const bundle = createTestMemoryBundle();
  const persistence = bundle.persistence;
  const assetContent = new MemoryAssetContent();
  const pTenant = tenantId("phase0-tenant");
  const atUtc = "2026-09-05T01:00:00.000Z";

  const apiIdentity = async (subject: string, role: "project_manager" | "member" | null) => {
    const external = { provider: "huly", connectionId: "conn-1", externalTenantRef: "ext-tenant", externalSubjectRef: subject } as const;
    const pId = await resolveExternalIdentity(persistence, { tenantId: pTenant, ...external });
    if (role !== null) {
      await grantProjectMembership(persistence, pTenant, "phase0-project", pId, { role });
    }
    return { principalId: pId, subject };
  };

  const idU0 = await apiIdentity("sub-u0", null);
  const idU1 = await apiIdentity("sub-u1", "member");
  const idU2 = await apiIdentity("sub-u2", "member");
  const idU3 = await apiIdentity("sub-u3", "project_manager");
  const idPM = await apiIdentity("sub-pm", "project_manager");

  let activeSubject = idU0.subject;
  const handler = createProductApi({
    collaborationMode: "huly",
    persistence,
    createNode: bundle.createNode,
    assignNodeLeader: bundle.assignNodeLeader,
    assetContent,
    externalIdentityVerifier: {
      authenticate: async () => ({
        provider: "huly",
        connectionId: "conn-1",
        externalTenantRef: "ext-tenant",
        externalSubjectRef: activeSubject,
      }),
    },
    collaborationProjectionConfigured: true,
  });

  const asUser = (id: { subject: string }) => {
    activeSubject = id.subject;
    return {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    };
  };

  // 1. Ordinary node
  // PM creates ordinary node
  await executeCreateNode(persistence, {
    tenantId: pTenant,
    commandId: "cmd-http-ord",
    idempotencyKey: "idem-http-ord",
    correlationId: "http",
    principalId: idPM.principalId,
    projectId: "phase0-project",
    nodeId: "node-http-ord",
    parentId: null,
    leaderPrincipalId: null,
    title: "HTTP Ordinary Node",
    kind: "work_package",
    securityDomainId: null,
    occurredAtUtc: atUtc,
  });

  // U0 cannot view nodes in project (empty list)
  const u0List = await callApi(handler, "/api/nodes", { headers: asUser(idU0) });
  assert.equal(u0List.status, 200);
  assert.deepEqual(JSON.parse(u0List.body), []);

  // U1 views ordinary node
  const u1List = await callApi(handler, "/api/nodes", { headers: asUser(idU1) });
  assert.equal(u1List.status, 200);
  const nodes = JSON.parse(u1List.body) as Array<{ id: string }>;
  assert.ok(nodes.some((n) => n.id === "node-http-ord"));

  // U1 cannot assign leader (403 Forbidden)
  const u1Assign = await callApi(handler, "/api/nodes/node-http-ord/actions/assign-leader", {
    method: "POST",
    headers: { ...asUser(idU1), "idempotency-key": "idem-u1-assign" },
    body: JSON.stringify({ expectedVersion: 1, leaderPrincipalId: idU2.principalId }),
  });
  assert.equal(u1Assign.status, 403);

  // U2 cannot assign leader (403 Forbidden)
  const u2Assign = await callApi(handler, "/api/nodes/node-http-ord/actions/assign-leader", {
    method: "POST",
    headers: { ...asUser(idU2), "idempotency-key": "idem-u2-assign" },
    body: JSON.stringify({ expectedVersion: 1, leaderPrincipalId: idU2.principalId }),
  });
  assert.equal(u2Assign.status, 403);

  // PM assigns U2 as leader
  const pmAssign = await callApi(handler, "/api/nodes/node-http-ord/actions/assign-leader", {
    method: "POST",
    headers: { ...asUser(idPM), "idempotency-key": "idem-pm-assign" },
    body: JSON.stringify({ expectedVersion: 1, leaderPrincipalId: idU2.principalId }),
  });
  assert.equal(pmAssign.status, 200);
  const assignBody = JSON.parse(pmAssign.body) as { value: { id: string; leaderPrincipalId: string; version: number } };
  assert.equal(assignBody.value.leaderPrincipalId, idU2.principalId);
  assert.equal(assignBody.value.version, 2);

  // U1 cannot create task under ordinary node owned by U2 (403 Forbidden)
  const u1CreateOrdTask = await callApi(handler, "/api/nodes/node-http-ord/tasks", {
    method: "POST",
    headers: { ...asUser(idU1), "idempotency-key": "idem-u1-ord-task" },
    body: JSON.stringify({ taskId: "task-u1-ord", title: "U1 ordinary task" }),
  });
  assert.equal(u1CreateOrdTask.status, 403);
  assert.equal((JSON.parse(u1CreateOrdTask.body) as { code: string }).code, "FORBIDDEN");

  // U2 (the Node Owner) can create task under node-http-ord (201 Created)
  const u2CreateOrdTask = await callApi(handler, "/api/nodes/node-http-ord/tasks", {
    method: "POST",
    headers: { ...asUser(idU2), "idempotency-key": "idem-u2-ord-task" },
    body: JSON.stringify({ taskId: "task-u2-ord", title: "U2 ordinary task" }),
  });
  assert.equal(u2CreateOrdTask.status, 201);

  // PM can also create task under node-http-ord (201 Created)
  const pmCreateOrdTask = await callApi(handler, "/api/nodes/node-http-ord/tasks", {
    method: "POST",
    headers: { ...asUser(idPM), "idempotency-key": "idem-pm-ord-task" },
    body: JSON.stringify({ taskId: "task-pm-ord", title: "PM ordinary task" }),
  });
  assert.equal(pmCreateOrdTask.status, 201);

  // 2. Sensitive node hierarchy
  // PM creates sensitive root and child node
  await executeCreateNode(persistence, {
    tenantId: pTenant,
    commandId: "cmd-http-sens-root",
    idempotencyKey: "idem-http-sens-root",
    correlationId: "http",
    principalId: idPM.principalId,
    projectId: "phase0-project",
    nodeId: "node-http-sens-root",
    parentId: null,
    leaderPrincipalId: null,
    title: "HTTP Sensitive Root",
    kind: "work_package",
    securityDomainId: null,
    occurredAtUtc: atUtc,
  });
  const domainId = "domain-http-sens";
  await new CreateSecurityRootHandler(persistence).execute({
    tenantId: pTenant,
    commandId: "cmd-http-sec-root",
    idempotencyKey: "idem-http-sec-root",
    correlationId: "http",
    principalId: idPM.principalId,
    projectId: "phase0-project",
    nodeId: "node-http-sens-root",
    securityDomainId: domainId,
    reason: "http sensitive domain",
    occurredAtUtc: atUtc,
    expectedNodeVersion: 1,
  });

  // PM creates child node under sensitive root with U2 as leader
  await executeCreateNode(persistence, {
    tenantId: pTenant,
    commandId: "cmd-http-sens-child",
    idempotencyKey: "idem-http-sens-child",
    correlationId: "http",
    principalId: idPM.principalId,
    projectId: "phase0-project",
    nodeId: "node-http-sens-child",
    parentId: "node-http-sens-root",
    leaderPrincipalId: idU2.principalId,
    title: "HTTP Sensitive Child",
    kind: "work_package",
    securityDomainId: null,
    occurredAtUtc: atUtc,
  });

  // --- 404 CONCEALMENT CHECKS ---
  // Baseline non-existent node response
  const nonExistentNodeTask = await callApi(handler, "/api/nodes/nonexistent-node-123/tasks", {
    method: "POST",
    headers: { ...asUser(idU1), "idempotency-key": "idem-u1-nonexistent-node" },
    body: JSON.stringify({ taskId: "task-nonexistent-node", title: "Nonexistent" }),
  });
  assert.equal(nonExistentNodeTask.status, 404);

  // U1 POST /api/nodes/node-http-sens-child/tasks -> 404 concealed with exact same body structure
  const u1CreateSensTask = await callApi(handler, "/api/nodes/node-http-sens-child/tasks", {
    method: "POST",
    headers: { ...asUser(idU1), "idempotency-key": "idem-u1-sens-task" },
    body: JSON.stringify({ taskId: "task-u1-sens", title: "U1 sensitive task" }),
  });
  assert.equal(u1CreateSensTask.status, 404);
  assert.deepEqual(
    JSON.parse(u1CreateSensTask.body),
    JSON.parse(nonExistentNodeTask.body.replace("nonexistent-node-123", "node-http-sens-child")),
  );

  // Baseline non-existent node GET response
  const nonExistentNodeGet = await callApi(handler, "/api/nodes/nonexistent-node-123", { headers: asUser(idU1) });
  assert.equal(nonExistentNodeGet.status, 404);

  // U0 GET sensitive child -> 404
  const u0GetSens = await callApi(handler, "/api/nodes/node-http-sens-child", { headers: asUser(idU0) });
  assert.equal(u0GetSens.status, 404);
  // U1 GET sensitive child -> 404
  const u1GetSens = await callApi(handler, "/api/nodes/node-http-sens-child", { headers: asUser(idU1) });
  assert.equal(u1GetSens.status, 404);
  // U2 (Node Owner without Grant) GET sensitive child -> 404 (strictly concealed!)
  const u2GetSens = await callApi(handler, "/api/nodes/node-http-sens-child", { headers: asUser(idU2) });
  assert.equal(u2GetSens.status, 404);
  // U3 (Project Manager without Grant) GET sensitive child -> 404
  const u3GetSens = await callApi(handler, "/api/nodes/node-http-sens-child", { headers: asUser(idU3) });
  assert.equal(u3GetSens.status, 404);

  // Exact deep equality between all unauthorized roles and non-existent node response pattern
  assert.deepEqual(JSON.parse(u0GetSens.body), JSON.parse(u1GetSens.body));
  assert.deepEqual(JSON.parse(u1GetSens.body), JSON.parse(u2GetSens.body));
  assert.deepEqual(JSON.parse(u2GetSens.body), JSON.parse(u3GetSens.body));
  assert.deepEqual(
    JSON.parse(u2GetSens.body),
    JSON.parse(nonExistentNodeGet.body.replace("nonexistent-node-123", "node-http-sens-child")),
  );

  // PM (has permanent grant) GET sensitive child -> 200
  const pmGetSens = await callApi(handler, "/api/nodes/node-http-sens-child", { headers: asUser(idPM) });
  assert.equal(pmGetSens.status, 200);

  // Grant U2 "view" capability on sensitive domain
  await new ManageSecurityGrantHandler(persistence).execute({
    tenantId: pTenant,
    commandId: "grant-http-u2-view",
    idempotencyKey: "grant-http-u2-view",
    correlationId: "http",
    principalId: idPM.principalId,
    projectId: "phase0-project",
    securityDomainId: domainId,
    targetPrincipalId: idU2.principalId,
    action: "set",
    capability: "view",
    expiresAtUtc: null,
    expectedGrantVersion: null,
    expectedDomainVersion: 1,
    reason: "u2 view grant",
    occurredAtUtc: atUtc,
  });

  // U2 with "view" grant: GET -> 200
  assert.equal((await callApi(handler, "/api/nodes/node-http-sens-child", { headers: asUser(idU2) })).status, 200);
  // U2 with "view" grant: create task (contribute) -> 404 (concealed since lack contribute capability)
  const u2CreateTaskNoEdit = await callApi(handler, "/api/nodes/node-http-sens-child/tasks", {
    method: "POST",
    headers: { ...asUser(idU2), "idempotency-key": "idem-u2-task-viewonly" },
    body: JSON.stringify({ taskId: "task-viewonly", title: "View only task" }),
  });
  assert.equal(u2CreateTaskNoEdit.status, 404);

  // Upgrade U2 to "edit" capability
  await new ManageSecurityGrantHandler(persistence).execute({
    tenantId: pTenant,
    commandId: "grant-http-u2-edit",
    idempotencyKey: "grant-http-u2-edit",
    correlationId: "http",
    principalId: idPM.principalId,
    projectId: "phase0-project",
    securityDomainId: domainId,
    targetPrincipalId: idU2.principalId,
    action: "set",
    capability: "edit",
    expiresAtUtc: null,
    expectedGrantVersion: 1,
    expectedDomainVersion: 2,
    reason: "u2 edit grant",
    occurredAtUtc: atUtc,
  });

  // U2 with "edit" grant: create task (contribute) -> 201 Created!
  const u2CreateTaskEdit = await callApi(handler, "/api/nodes/node-http-sens-child/tasks", {
    method: "POST",
    headers: { ...asUser(idU2), "idempotency-key": "idem-u2-task-edit" },
    body: JSON.stringify({ taskId: "task-edit-ok", title: "Edit ok task" }),
  });
  assert.equal(u2CreateTaskEdit.status, 201);

  // 3. Soft-deletion filtering
  const snap = persistence.snapshot();
  const childKey = `${pTenant}\u0000node-http-sens-child`;
  const existingNode = snap.nodes.get(childKey);
  assert.ok(existingNode);
  snap.nodes.set(childKey, { ...existingNode, deletedAtUtc: atUtc });
  const restoredBundle = createTestMemoryBundle({ snapshot: snap });
  const handlerAfterDelete = createProductApi({
    collaborationMode: "huly",
    persistence: restoredBundle.persistence,
    createNode: restoredBundle.createNode,
    assignNodeLeader: restoredBundle.assignNodeLeader,
    assetContent,
    externalIdentityVerifier: {
      authenticate: async () => ({
        provider: "huly",
        connectionId: "conn-1",
        externalTenantRef: "ext-tenant",
        externalSubjectRef: activeSubject,
      }),
    },
    collaborationProjectionConfigured: true,
  });

  // Soft-deleted node does not appear in GET /api/nodes
  const listAfterDel = await callApi(handlerAfterDelete, "/api/nodes", { headers: asUser(idPM) });
  assert.equal(listAfterDel.status, 200);
  const nodesAfterDel = JSON.parse(listAfterDel.body) as Array<{ id: string }>;
  assert.equal(nodesAfterDel.some((n) => n.id === "node-http-sens-child"), false);

  // Soft-deleted node GET detail returns 404
  assert.equal((await callApi(handlerAfterDelete, "/api/nodes/node-http-sens-child", { headers: asUser(idPM) })).status, 404);

  // Soft-deleted node assign-leader returns 404
  const assignDel = await callApi(handlerAfterDelete, "/api/nodes/node-http-sens-child/actions/assign-leader", {
    method: "POST",
    headers: { ...asUser(idPM), "idempotency-key": "idem-del-assign" },
    body: JSON.stringify({ expectedVersion: 1, leaderPrincipalId: idU1.principalId }),
  });
  assert.equal(assignDel.status, 404);

  // Baseline non-existent task action response
  const nonExistentTaskRes = await callApi(handlerAfterDelete, "/api/tasks/nonexistent-task-123/actions/start", {
    method: "POST",
    headers: { ...asUser(idU2), "idempotency-key": "idem-u2-nonexistent-act" },
    body: JSON.stringify({ expectedVersion: 1 }),
  });
  assert.equal(nonExistentTaskRes.status, 404);

  // U2 Task action after owner-node soft deletion -> 404 concealed
  const u2TaskActionAfterDel = await callApi(handlerAfterDelete, "/api/tasks/task-edit-ok/actions/start", {
    method: "POST",
    headers: { ...asUser(idU2), "idempotency-key": "idem-u2-start-after-del" },
    body: JSON.stringify({ expectedVersion: 1 }),
  });
  assert.equal(u2TaskActionAfterDel.status, 404);
  assert.deepEqual(
    JSON.parse(u2TaskActionAfterDel.body),
    JSON.parse(nonExistentTaskRes.body.replace("nonexistent-task-123", "task-edit-ok")),
  );

  // Baseline non-existent file response
  const nonExistentTaskFileRes = await callApi(handlerAfterDelete, "/api/tasks/nonexistent-task-123/files", {
    method: "POST",
    headers: { ...asUser(idU2), "idempotency-key": "idem-u2-nonexistent-file" },
    body: JSON.stringify({ name: "doc.txt", contentType: "text/plain", contentBase64: Buffer.from("test").toString("base64") }),
  });
  assert.equal(nonExistentTaskFileRes.status, 404);

  // U2 File upload after owner-node soft deletion -> 404 concealed
  const u2TaskFileAfterDel = await callApi(handlerAfterDelete, "/api/tasks/task-edit-ok/files", {
    method: "POST",
    headers: { ...asUser(idU2), "idempotency-key": "idem-u2-file-after-del" },
    body: JSON.stringify({ name: "doc.txt", contentType: "text/plain", contentBase64: Buffer.from("test").toString("base64") }),
  });
  assert.equal(u2TaskFileAfterDel.status, 404);
  assert.deepEqual(
    JSON.parse(u2TaskFileAfterDel.body),
    JSON.parse(nonExistentTaskFileRes.body.replace("nonexistent-task-123", "task-edit-ok")),
  );

  // --- Migration Oracle Prevention on assign-leader action: ---
  // Baseline non-existent node assign-leader response
  const nonExistentNodeAssign = await callApi(handler, "/api/nodes/nonexistent-node-123/actions/assign-leader", {
    method: "POST",
    headers: { ...asUser(idPM), "idempotency-key": "idem-nonexistent-assign" },
    body: JSON.stringify({ expectedVersion: 1, leaderPrincipalId: idU1.principalId }),
  });
  assert.equal(nonExistentNodeAssign.status, 404);

  // Set up an active migration on phase0-project
  const plannedMigration: SecurityDomainMigration = {
    tenantId: pTenant,
    id: "mig-oracle-http",
    projectId: "phase0-project",
    rootNodeId: "node-http-sens-root",
    sourceSecurityDomainId: domainId,
    targetSecurityDomainId: domainId,
    hierarchyRevision: 1,
    sourceSecurityEpoch: 1,
    targetSecurityEpoch: 2,
    state: "planned",
    cursor: null,
    totalItems: 1,
    migratedItems: 0,
    failure: null,
    nextAttemptAtUtc: null,
    deadlineAtUtc: "2026-09-15T00:00:00.000Z",
    version: 1,
    createdAtUtc: atUtc,
    updatedAtUtc: atUtc,
  };
  const activeMigration = transitionSecurityMigration(plannedMigration, "active", atUtc);
  await persistence.transaction(pTenant, async (tx) => {
    await tx.securityMigrations.insert(plannedMigration);
    await tx.securityMigrations.saveProgressPreservingPlan(activeMigration.id, activeMigration, plannedMigration.version);
  });

  // U0 assign-leader -> 404
  const u0AssignMig = await callApi(handler, "/api/nodes/node-http-sens-child/actions/assign-leader", {
    method: "POST",
    headers: { ...asUser(idU0), "idempotency-key": "idem-u0-assign-mig" },
    body: JSON.stringify({ expectedVersion: 1, leaderPrincipalId: idU1.principalId }),
  });
  assert.equal(u0AssignMig.status, 404);

  // U1 assign-leader -> 404
  const u1AssignMig = await callApi(handler, "/api/nodes/node-http-sens-child/actions/assign-leader", {
    method: "POST",
    headers: { ...asUser(idU1), "idempotency-key": "idem-u1-assign-mig" },
    body: JSON.stringify({ expectedVersion: 1, leaderPrincipalId: idU2.principalId }),
  });
  assert.equal(u1AssignMig.status, 404);

  // U2 (Node Owner without PM role) assign-leader -> 404
  const u2AssignMig = await callApi(handler, "/api/nodes/node-http-sens-child/actions/assign-leader", {
    method: "POST",
    headers: { ...asUser(idU2), "idempotency-key": "idem-u2-assign-mig" },
    body: JSON.stringify({ expectedVersion: 1, leaderPrincipalId: idU1.principalId }),
  });
  assert.equal(u2AssignMig.status, 404);

  // U3 (PM without Grant) assign-leader -> 404
  const u3AssignMig = await callApi(handler, "/api/nodes/node-http-sens-child/actions/assign-leader", {
    method: "POST",
    headers: { ...asUser(idU3), "idempotency-key": "idem-u3-assign-mig" },
    body: JSON.stringify({ expectedVersion: 1, leaderPrincipalId: idU1.principalId }),
  });
  assert.equal(u3AssignMig.status, 404);

  // Exact body equality between U0, U1, U2, U3 and baseline non-existent node
  assert.deepEqual(JSON.parse(u0AssignMig.body), JSON.parse(u1AssignMig.body));
  assert.deepEqual(JSON.parse(u1AssignMig.body), JSON.parse(u2AssignMig.body));
  assert.deepEqual(JSON.parse(u2AssignMig.body), JSON.parse(u3AssignMig.body));
  assert.deepEqual(
    JSON.parse(u0AssignMig.body),
    JSON.parse(nonExistentNodeAssign.body.replace("nonexistent-node-123", "node-http-sens-child")),
  );

  // Authorized PM with permanent Grant receives 409 SECURITY_MIGRATION_IN_PROGRESS
  const pmAssignMig = await callApi(handler, "/api/nodes/node-http-sens-child/actions/assign-leader", {
    method: "POST",
    headers: { ...asUser(idPM), "idempotency-key": "idem-pm-assign-mig" },
    body: JSON.stringify({ expectedVersion: 1, leaderPrincipalId: idU2.principalId }),
  });
  assert.equal(pmAssignMig.status, 409);
  assert.equal((JSON.parse(pmAssignMig.body) as { code: string }).code, "SECURITY_MIGRATION_IN_PROGRESS");
});

test("Finding 4: Initial non-null leader assignment emits approved events atomically and rolls back across all failure points", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const fixture = await createFixture(name);
    try {
      await prepareIdentities(fixture.persistence);

      // Positive execution with initial non-null leader
      const createCmd = createNodeCmd({
        nodeId: `node-init-leader-${name}`,
        leaderPrincipalId: leaderU2,
        commandId: `cmd-init-leader-${name}`,
        idempotencyKey: `idem-init-leader-${name}`,
      });
      const result = await executeCreateNode(fixture.persistence, createCmd);
      assert.equal(result.node.leaderPrincipalId, leaderU2);
      assert.equal(result.node.version, 2);
      assert.ok(result.event);
      assert.equal(result.event.eventType, "project-map.node.created");
      assert.equal(result.event.schemaVersion, 1);
      assert.equal((result.event.payload as Record<string, unknown>).leaderPrincipalId, undefined);
      assert.ok(result.leaderAssignedEvent);
      assert.equal(result.leaderAssignedEvent.eventType, "project-map.node.leader_assigned");
      assert.equal(result.leaderAssignedEvent.schemaVersion, 1);
      assert.equal(result.leaderAssignedEvent.payload.previousLeaderPrincipalId, null);
      assert.equal(result.leaderAssignedEvent.payload.leaderPrincipalId, leaderU2);

      // Replay idempotency returns identical result with replayed: true
      const replay = await executeCreateNode(fixture.persistence, createCmd);
      assert.equal(replay.replayed, true);
      assert.equal(replay.node.leaderPrincipalId, leaderU2);
      assert.equal(replay.node.version, 2);

      // Verify node and receipt in persistence
      await fixture.persistence.read(tenant, async (tx) => {
        const node = await tx.nodes.get(`node-init-leader-${name}`);
        assert.ok(node);
        assert.equal(node.leaderPrincipalId, leaderU2);
        assert.equal(node.version, 2);
        const receipt = await tx.receipts.get({
          principalId: manager,
          operation: "create_node",
          idempotencyKey: createCmd.idempotencyKey,
        });
        assert.ok(receipt);
      });

      // Atomic failure injection across all 6 failure points
      const points: readonly CreateNodeFailurePoint[] = [
        "after_aggregate",
        "after_event",
        "after_outbox",
        "after_leader_assigned",
        "after_leader_outbox",
        "after_idempotency",
      ];

      for (const [idx, fp] of points.entries()) {
        const failNodeId = `node-fail-init-${idx}-${name}`;
        const failCmd = createNodeCmd({
          nodeId: failNodeId,
          leaderPrincipalId: leaderU2,
          commandId: `cmd-fail-init-${idx}-${name}`,
          idempotencyKey: `idem-fail-init-${idx}-${name}`,
        });

        const preStats = await countEventsAndOutbox(fixture, tenant);
        const preSeq = await fixture.persistence.read(tenant, async (tx) => await tx.sequences.current(projectId));

        await assert.rejects(
          executeCreateNode(fixture.persistence, failCmd, fp),
          new RegExp(`Injected failure: ${fp}`),
          `${fixture.name} - ${fp}`,
        );

        // Assert full atomic rollback: no node, no receipt, no event, no outbox, sequence unchanged
        const postStats = await countEventsAndOutbox(fixture, tenant);
        const { node, receipt, sequence } = await fixture.persistence.read(tenant, async (tx) => ({
          node: await tx.nodes.get(failNodeId),
          receipt: await tx.receipts.get({
            principalId: manager,
            operation: "create_node",
            idempotencyKey: failCmd.idempotencyKey,
          }),
          sequence: await tx.sequences.current(projectId),
        }));

        assert.equal(node, undefined, `${fixture.name} - ${fp} node rolled back`);
        assert.equal(receipt, undefined, `${fixture.name} - ${fp} receipt rolled back`);
        assert.equal(postStats.events, preStats.events, `${fixture.name} - ${fp} event rolled back`);
        assert.equal(postStats.outbox, preStats.outbox, `${fixture.name} - ${fp} outbox rolled back`);
        assert.equal(sequence, preSeq, `${fixture.name} - ${fp} sequence rolled back`);
      }
    } finally {
      await fixture.cleanup();
    }
  }
});

test("ARCH-PROBE / TC-SEC-004A: Elimination of raw mutation authority, generic insert leader guard, cross-instance isolation, and production schema rejection", async () => {
  // 1. Dynamic module exports inspection: NO raw mutation authority or getters exported anywhere
  const createNodeExports = await import("../packages/application/src/create-node.ts");
  assert.equal(
    (createNodeExports as any).issueNodeLeaderMutationCapability,
    undefined,
    "create-node module must not export issueNodeLeaderMutationCapability",
  );
  assert.equal(
    (createNodeExports as any).NodeLeaderMutationCapability,
    undefined,
    "create-node module must not export NodeLeaderMutationCapability",
  );

  const portsExports = await import("../packages/application/src/ports/persistence.ts");
  assert.equal(
    (portsExports as any).NodeLeaderMutationRepository,
    undefined,
    "ports/persistence module must not export NodeLeaderMutationRepository",
  );
  assert.equal(
    (portsExports as any).issueNodeLeaderMutationCapability,
    undefined,
    "ports/persistence module must not export issueNodeLeaderMutationCapability",
  );

  const memoryModule = await import("../packages/adapters/src/memory/persistence.ts");
  assert.equal(
    (memoryModule as any).getMemoryNodeLeaderMutator,
    undefined,
    "Memory persistence module must NOT export getMemoryNodeLeaderMutator",
  );
  for (const exportKey of Object.keys(memoryModule)) {
    assert.equal(
      /mutat/i.test(exportKey),
      false,
      `Memory adapter must not export any mutation authority: found ${exportKey}`,
    );
  }

  const sqliteModule = await import("../packages/adapters/src/sqlite/persistence.ts");
  assert.equal(
    (sqliteModule as any).getSqliteNodeLeaderMutator,
    undefined,
    "SQLite persistence module must NOT export getSqliteNodeLeaderMutator",
  );
  for (const exportKey of Object.keys(sqliteModule)) {
    assert.equal(
      /mutat/i.test(exportKey),
      false,
      `SQLite adapter must not export any mutation authority: found ${exportKey}`,
    );
  }

  const prodModule = await import("../packages/adapters/src/sqlite/production-bundle.ts");
  for (const exportKey of Object.keys(prodModule)) {
    assert.equal(
      /mutat/i.test(exportKey),
      false,
      `Production bundle module must not export any mutation authority: found ${exportKey}`,
    );
  }

  // Verify production bundle does NOT expose raw repository or mutator property
  const prodSqliteDir = await mkdtemp(join(tmpdir(), "arch-probe-prod-sqlite-"));
  const prodBundle = createProductionSqliteBundle({ databasePath: join(prodSqliteDir, "prod.db") });
  try {
    assert.equal((prodBundle as any).nodeLeaderMutations, undefined, "production bundle must NOT expose nodeLeaderMutations");
    assert.equal((prodBundle as any).mutator, undefined, "production bundle must NOT expose mutator");
    assert.equal(typeof prodBundle.createNode, "function", "production bundle exposes guarded createNode");
    assert.equal(typeof prodBundle.assignNodeLeader, "function", "production bundle exposes guarded assignNodeLeader");
  } finally {
    await prodBundle.persistence.close();
    await rm(prodSqliteDir, { recursive: true, force: true });
  }

  // Verify test bundles do NOT expose nodeLeaderMutations
  const memBundle = createTestMemoryBundle();
  assert.equal((memBundle as any).nodeLeaderMutations, undefined, "TestMemoryBundle must NOT expose nodeLeaderMutations");
  assert.equal(typeof memBundle.createNode, "function");
  assert.equal(typeof memBundle.assignNodeLeader, "function");

  const sqliteDir = await mkdtemp(join(tmpdir(), "arch-probe-sqlite-"));
  const sqliteBundle = createTestSqliteBundle({ path: join(sqliteDir, "test.db") });
  try {
    assert.equal((sqliteBundle as any).nodeLeaderMutations, undefined, "TestSqliteBundle must NOT expose nodeLeaderMutations");
    assert.equal(typeof sqliteBundle.createNode, "function");
    assert.equal(typeof sqliteBundle.assignNodeLeader, "function");
  } finally {
    await sqliteBundle.persistence.close();
    await rm(sqliteDir, { recursive: true, force: true });
  }

  // 2. Direct generic nodes.insert rejects non-null leader in Memory and SQLite
  await memBundle.persistence.transaction(tenant, async (tx) => {
    await assert.rejects(
      tx.nodes.insert({
        tenantId: tenant,
        id: "mem-raw-insert-reject",
        projectId,
        parentId: null,
        leaderPrincipalId: leaderU2,
        title: "Raw Leader Insert",
        kind: "work_package",
        securityDomainId: null,
        securityEpoch: 1,
        version: 1,
        deletedAtUtc: null,
      }),
      (err) => err instanceof ApplicationError && err.code === "NODE_LEADER_DIRECT_INSERT_FORBIDDEN",
      "Memory generic nodes.insert rejects non-null leader",
    );
  });

  const sqliteDir2 = await mkdtemp(join(tmpdir(), "arch-probe-sqlite2-"));
  const sqliteBundle2 = createTestSqliteBundle({ path: join(sqliteDir2, "test2.db") });
  try {
    await sqliteBundle2.persistence.transaction(tenant, async (tx) => {
      await assert.rejects(
        tx.nodes.insert({
          tenantId: tenant,
          id: "sqlite-raw-insert-reject",
          projectId,
          parentId: null,
          leaderPrincipalId: leaderU2,
          title: "Raw Leader Insert",
          kind: "work_package",
          securityDomainId: null,
          securityEpoch: 1,
          version: 1,
          deletedAtUtc: null,
        }),
        (err) => err instanceof ApplicationError && err.code === "NODE_LEADER_DIRECT_INSERT_FORBIDDEN",
        "SQLite generic nodes.insert rejects non-null leader",
      );
    });
  } finally {
    await sqliteBundle2.persistence.close();
    await rm(sqliteDir2, { recursive: true, force: true });
  }

  // Setup identities for guarded execution
  await memBundle.persistence.transaction(tenant, async (tx) => {
    await tx.principals.insert({
      tenantId: tenant,
      id: manager,
      kind: "user",
      status: "active",
      version: 1,
      createdAtUtc: "2026-09-14T00:00:00.000Z",
      updatedAtUtc: "2026-09-14T00:00:00.000Z",
    });
    await tx.principals.insert({
      tenantId: tenant,
      id: leaderU2,
      kind: "user",
      status: "active",
      version: 1,
      createdAtUtc: "2026-09-14T00:00:00.000Z",
      updatedAtUtc: "2026-09-14T00:00:00.000Z",
    });
    await tx.memberships.insert({
      tenantId: tenant,
      projectId,
      principalId: manager,
      role: "project_manager",
      status: "active",
      securityDomainIds: [],
      version: 1,
      createdAtUtc: "2026-09-14T00:00:00.000Z",
      updatedAtUtc: "2026-09-14T00:00:00.000Z",
    });
    await tx.memberships.insert({
      tenantId: tenant,
      projectId,
      principalId: leaderU2,
      role: "member",
      status: "active",
      securityDomainIds: [],
      version: 1,
      createdAtUtc: "2026-09-14T00:00:00.000Z",
      updatedAtUtc: "2026-09-14T00:00:00.000Z",
    });
  });

  // Guarded createNode with initial leader succeeds atomically with events, outbox, and receipt
  const createCmd: CreateNodeCommand = {
    commandId: "arch-probe-cmd-1",
    idempotencyKey: "arch-probe-idem-1",
    correlationId: "arch-probe-corr-1",
    tenantId: tenant,
    projectId,
    principalId: manager,
    nodeId: "arch-probe-node-1",
    parentId: null,
    leaderPrincipalId: leaderU2,
    title: "Arch Probe Node",
    kind: "work_package",
    securityDomainId: null,
    occurredAtUtc: "2026-09-14T00:00:00.000Z",
  };
  const createResult = await executeCreateNode(memBundle.persistence, createCmd);
  assert.equal(createResult.node.leaderPrincipalId, leaderU2);
  assert.equal(createResult.node.version, 2);
  assert.ok(createResult.event);
  assert.equal(createResult.event.eventType, "project-map.node.created");
  assert.equal(createResult.event.schemaVersion, 1);
  assert.equal((createResult.event.payload as Record<string, unknown>).leaderPrincipalId, undefined);
  assert.ok(createResult.leaderAssignedEvent);
  assert.equal(createResult.leaderAssignedEvent.eventType, "project-map.node.leader_assigned");
  assert.equal(createResult.leaderAssignedEvent.schemaVersion, 1);
  assert.equal(createResult.leaderAssignedEvent.payload.previousLeaderPrincipalId, null);
  assert.equal(createResult.leaderAssignedEvent.payload.leaderPrincipalId, leaderU2);

  // Replay idempotency returns identical result
  const replayResult = await executeCreateNode(memBundle.persistence, createCmd);
  assert.equal(replayResult.replayed, true);
  assert.equal(replayResult.node.leaderPrincipalId, leaderU2);

  // 3. Cross-instance A/B misuse negative: independent database instances are strictly isolated
  const dirA = await mkdtemp(join(tmpdir(), "arch-probe-iso-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "arch-probe-iso-b-"));
  const bA = createTestSqliteBundle({ path: join(dirA, "a.db") });
  const bB = createTestSqliteBundle({ path: join(dirB, "b.db") });
  try {
    await prepareIdentities(bA.persistence);
    await prepareIdentities(bB.persistence);

    // Create node on instance A
    await executeCreateNode(bA.persistence, {
      commandId: "iso-cmd-a",
      idempotencyKey: "iso-idem-a",
      correlationId: "iso-a",
      tenantId: tenant,
      projectId,
      principalId: manager,
      nodeId: "node-in-db-a",
      parentId: null,
      leaderPrincipalId: null,
      title: "Node in DB A",
      kind: "work_package",
      securityDomainId: null,
      occurredAtUtc: "2026-09-14T00:00:00.000Z",
    });

    // Attempting to mutate instance A's node via instance B's persistence fails closed (404 NODE_NOT_FOUND)
    await assert.rejects(
      executeAssignNodeLeader(bB.persistence, {
        commandId: "iso-cmd-b-attack",
        idempotencyKey: "iso-idem-b-attack",
        correlationId: "iso-b",
        tenantId: tenant,
        projectId,
        principalId: manager,
        nodeId: "node-in-db-a",
        leaderPrincipalId: leaderU2,
        expectedVersion: 1,
        occurredAtUtc: "2026-09-14T00:00:00.000Z",
      }),
      (err) => err instanceof ApplicationError && err.code === "NODE_NOT_FOUND",
      "Cross-instance mutation via foreign persistence fails closed with NODE_NOT_FOUND",
    );

    // Node in DB A remains unmutated (leader null, version 1)
    await bA.persistence.read(tenant, async (tx) => {
      const nodeA = await tx.nodes.get("node-in-db-a");
      assert.ok(nodeA);
      assert.equal(nodeA.leaderPrincipalId, null);
      assert.equal(nodeA.version, 1);
    });
  } finally {
    await bA.persistence.close();
    await bB.persistence.close();
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }

  // 4. Actual Memory and SQLite events.append and outbox.enqueue production schema rejection
  for (const name of ["memory", "sqlite"] as const) {
    const fixture = await createFixture(name);
    try {
      await fixture.persistence.transaction(tenant, async (tx) => {
        // A. events.append rejects invalid event schema version
        await assert.rejects(
          tx.events.append({
            eventId: "invalid-event-1",
            tenantId: tenant,
            projectId,
            projectSequence: 99,
            aggregateType: "node",
            aggregateId: "node-test",
            aggregateVersion: 1,
            eventType: "project-map.node.created",
            schemaVersion: 99, // Invalid schema version
            actorPrincipalId: manager,
            occurredAtUtc: "2026-09-14T00:00:00.000Z",
            correlationId: "corr-inv",
            causationId: "caus-inv",
            originalSecurityDomainId: null,
            originalSecurityEpoch: 1,
            payload: {},
          }),
          /UNKNOWN_EVENT_SCHEMA_VERSION/,
          `${fixture.name} - events.append rejects unknown schema version`,
        );

        // B. events.append rejects unexpected payload fields (e.g. leaderPrincipalId in node.created:v1)
        await assert.rejects(
          tx.events.append({
            eventId: "invalid-event-2",
            tenantId: tenant,
            projectId,
            projectSequence: 99,
            aggregateType: "node",
            aggregateId: "node-test",
            aggregateVersion: 1,
            eventType: "project-map.node.created",
            schemaVersion: 1,
            actorPrincipalId: manager,
            occurredAtUtc: "2026-09-14T00:00:00.000Z",
            correlationId: "corr-inv",
            causationId: "caus-inv",
            originalSecurityDomainId: null,
            originalSecurityEpoch: 1,
            payload: {
              nodeId: "node-test",
              parentId: null,
              title: "Test",
              kind: "work_package",
              leaderPrincipalId: leaderU2, // Forbidden field in created:v1!
            },
          }),
          /EVENT_PAYLOAD_UNKNOWN_FIELD:leaderPrincipalId/,
          `${fixture.name} - events.append rejects invalid payload field`,
        );

        // C. outbox.enqueue rejects sensitive fields
        await assert.rejects(
          tx.outbox.enqueue({
            tenantId: tenant,
            id: "outbox-sensitive-1",
            eventId: "ev-sens-1",
            topic: "test.topic",
            payload: {
              eventId: "ev-sens-1",
              tenantId: tenant,
              projectId,
              projectSequence: 100,
              aggregateType: "node",
              aggregateId: "node-test",
              aggregateVersion: 1,
              eventType: "project-map.node.created",
              schemaVersion: 1,
              actorPrincipalId: manager,
              occurredAtUtc: "2026-09-14T00:00:00.000Z",
              correlationId: "corr-sens",
              causationId: "caus-sens",
              originalSecurityDomainId: null,
              originalSecurityEpoch: 1,
              payload: {
                nodeId: "node-test",
                parentId: null,
                title: "Test",
                kind: "work_package",
                token: "super-secret",
              },
            },
            state: "pending",
            availableAtUtc: "2026-09-14T00:00:00.000Z",
            attempts: 0,
            maxAttempts: 8,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAtUtc: null,
            lastError: null,
            publishedAtUtc: null,
            createdAtUtc: "2026-09-14T00:00:00.000Z",
          }),
          /SENSITIVE_FIELD_FORBIDDEN/,
          `${fixture.name} - outbox.enqueue rejects sensitive fields`,
        );
      });
    } finally {
      await fixture.cleanup();
    }
  }
});

test("Finding 8: Direct Memory and SQLite nodes.insert migration freeze matrix for null leader across all migration states", async () => {
  const atUtc = "2026-09-14T00:00:00.000Z";

  for (const name of ["memory", "sqlite"] as const) {
    const fixture = await createFixture(name);
    try {
      await prepareIdentities(fixture.persistence);

      const openStates: readonly SecurityDomainMigrationState[] = [
        "active",
        "verifying",
        "retryable",
        "recovery_required",
      ];
      const closedStates: readonly SecurityDomainMigrationState[] = [
        "planned",
        "committed",
        "rolled_back",
      ];

      // 1. In each open state, direct tx.nodes.insert with leaderPrincipalId: null MUST be blocked
      for (const state of openStates) {
        const openProjectId = `proj-open-${state}-${name}`;
        const migId = `mig-freeze-${state}-${name}`;
        let record: SecurityDomainMigration = {
          tenantId: tenant,
          id: migId,
          projectId: openProjectId,
          rootNodeId: `node-root-${openProjectId}`,
          sourceSecurityDomainId: "dom-a",
          targetSecurityDomainId: "dom-b",
          hierarchyRevision: 1,
          sourceSecurityEpoch: 1,
          targetSecurityEpoch: 2,
          state: "planned",
          cursor: null,
          totalItems: 1,
          migratedItems: 0,
          failure: null,
          nextAttemptAtUtc: null,
          deadlineAtUtc: "2026-09-15T00:00:00.000Z",
          version: 1,
          createdAtUtc: atUtc,
          updatedAtUtc: atUtc,
        };

        await fixture.persistence.transaction(tenant, async (tx) => {
          await tx.nodes.insert({
            tenantId: tenant,
            id: `node-root-${openProjectId}`,
            projectId: openProjectId,
            parentId: null,
            leaderPrincipalId: null,
            title: "Root Node",
            kind: "work_package",
            securityDomainId: null,
            securityEpoch: 1,
            version: 1,
            deletedAtUtc: null,
          });
          await tx.securityMigrations.insert(record);
          const sequence: SecurityDomainMigrationState[] = [];
          if (state === "active") sequence.push("active");
          else if (state === "verifying") sequence.push("active", "verifying");
          else if (state === "retryable") sequence.push("active", "retryable");
          else if (state === "recovery_required") sequence.push("active", "recovery_required");

          for (const next of sequence) {
            const updated = transitionSecurityMigration(
              record,
              next,
              atUtc,
              next === "recovery_required" || next === "retryable" ? "test error" : null,
            );
            await tx.securityMigrations.saveProgressPreservingPlan(record.id, updated, record.version);
            record = updated;
          }

          // Blocked for null-leader insert
          await assert.rejects(
            tx.nodes.insert({
              tenantId: tenant,
              id: `node-open-${state}-${name}`,
              projectId: openProjectId,
              parentId: null,
              leaderPrincipalId: null,
              title: `Frozen ${state} Node`,
              kind: "work_package",
              securityDomainId: null,
              securityEpoch: 1,
              version: 1,
              deletedAtUtc: null,
            }),
            /SECURITY_MIGRATION_IN_PROGRESS/,
            `${fixture.name} - null leader insert blocked in ${state} state`,
          );
        });
      }

      // 2. In non-open states (planned, committed, rolled_back), direct tx.nodes.insert with leaderPrincipalId: null SUCCEEDS
      for (const state of closedStates) {
        const closedProjectId = `proj-closed-${state}-${name}`;
        const migId = `mig-closed-${state}-${name}`;
        const initialRecord: SecurityDomainMigration = {
          tenantId: tenant,
          id: migId,
          projectId: closedProjectId,
          rootNodeId: `node-root-${closedProjectId}`,
          sourceSecurityDomainId: "dom-a",
          targetSecurityDomainId: "dom-b",
          hierarchyRevision: 1,
          sourceSecurityEpoch: 1,
          targetSecurityEpoch: 2,
          state: "planned",
          cursor: null,
          totalItems: 1,
          migratedItems: 0,
          failure: null,
          nextAttemptAtUtc: null,
          deadlineAtUtc: "2026-09-15T00:00:00.000Z",
          version: 1,
          createdAtUtc: atUtc,
          updatedAtUtc: atUtc,
        };

        await fixture.persistence.transaction(tenant, async (tx) => {
          await tx.nodes.insert({
            tenantId: tenant,
            id: `node-root-${closedProjectId}`,
            projectId: closedProjectId,
            parentId: null,
            leaderPrincipalId: null,
            title: "Root Node",
            kind: "work_package",
            securityDomainId: null,
            securityEpoch: 1,
            version: 1,
            deletedAtUtc: null,
          });
          await tx.securityMigrations.insert(initialRecord);
        });

        let testPersistence = fixture.persistence;

        if (state !== "planned") {
          if (name === "sqlite") {
            const db = new DatabaseSync(fixture.path!);
            db.prepare(`
              UPDATE security_domain_migrations
              SET state = ?, migration_json = json_set(migration_json, '$.state', ?)
              WHERE tenant_id = ? AND migration_id = ?
            `).run(state, state, tenant, migId);
            db.close();
          } else {
            const snap = (fixture.persistence as MemoryPersistence).snapshot();
            const memKey = `${tenant}\u0000${migId}`;
            const existing = snap.securityMigrations.get(memKey);
            assert.ok(existing);
            snap.securityMigrations.set(memKey, {
              ...existing,
              state,
              version: existing.version + 1,
            });
            testPersistence = new MemoryPersistence({ snapshot: snap });
          }
        }

        // Allowed for null-leader insert
        await testPersistence.transaction(tenant, async (tx) => {
          await tx.nodes.insert({
            tenantId: tenant,
            id: `node-allowed-${state}-${name}`,
            projectId: closedProjectId,
            parentId: null,
            leaderPrincipalId: null,
            title: `Allowed ${state} Node`,
            kind: "work_package",
            securityDomainId: null,
            securityEpoch: 1,
            version: 1,
            deletedAtUtc: null,
          });

          const inserted = await tx.nodes.get(`node-allowed-${state}-${name}`);
          assert.ok(inserted);
          assert.equal(inserted.leaderPrincipalId, null);
          assert.equal(inserted.id, `node-allowed-${state}-${name}`);
        });
      }
    } finally {
      await fixture.cleanup();
    }
  }
});
