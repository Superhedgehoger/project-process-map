import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import {
  canAccessProjectObjectDuringMigration,
  canViewProjectObjectDuringMigration,
} from "../packages/application/src/access/project-security.ts";
import type { Persistence } from "../packages/application/src/ports/persistence.ts";
import { principalId, tenantId, type PrincipalId } from "../packages/domain/src/identity.ts";
import type { ProjectMembership } from "../packages/domain/src/project-access.ts";
import type { ProjectNode } from "../packages/domain/src/project-structure.ts";
import type { SecurityDomain, SecurityGrant } from "../packages/domain/src/security-access.ts";
import { transitionSecurityMigration, type SecurityDomainMigration } from "../packages/domain/src/security-migration.ts";

const tenant = tenantId("tenant-migration-read");
const projectId = "migration-read-project";
const sourceDomainId = "read-source";
const targetDomainId = "read-target";
const oldOnly = principalId("read-old-only");
const newOnly = principalId("read-new-only");
const both = principalId("read-both");
const neither = principalId("read-neither");
const revoked = principalId("read-revoked");
const expired = principalId("read-expired-grant");
const revokedGrant = principalId("read-revoked-grant");
const revokedMember = principalId("read-revoked-member");

type Fixture = Readonly<{ persistence: Persistence; cleanup(): Promise<void> }>;

async function fixture(name: "memory" | "sqlite"): Promise<Fixture> {
  if (name === "memory") {
    const persistence = new MemoryPersistence();
    return { persistence, cleanup: async () => await persistence.close() };
  }
  const directory = await mkdtemp(join(tmpdir(), "ppm-migration-read-"));
  const persistence = new SqlitePersistence({ path: join(directory, "read.sqlite") });
  return { persistence, cleanup: async () => { await persistence.close(); await rm(directory, { recursive: true, force: true }); } };
}

function node(
  id: string,
  parentId: string | null,
  securityDomainId: string | null,
  securityEpoch: number,
): ProjectNode {
  return {
    tenantId: tenant,
    id,
    projectId,
    parentId,
    leaderPrincipalId: null,
    title: id,
    kind: "work_package",
    securityDomainId,
    securityEpoch,
    version: 1,
    deletedAtUtc: null,
  };
}

function membership(id: PrincipalId, status: ProjectMembership["status"] = "active"): ProjectMembership {
  return {
    tenantId: tenant,
    projectId,
    principalId: id,
    role: "member",
    status,
    securityDomainIds: [],
    version: 1,
    createdAtUtc: "2026-09-10T10:00:00.000Z",
    updatedAtUtc: "2026-09-10T10:00:00.000Z",
  };
}

function domain(id: string, rootNodeId: string): SecurityDomain {
  return {
    tenantId: tenant,
    id,
    projectId,
    rootNodeId,
    parentSecurityDomainId: null,
    permissionVersion: 1,
    version: 1,
    createdByPrincipalId: both,
    createdAtUtc: "2026-09-10T10:00:00.000Z",
    deletedAtUtc: null,
  };
}

function grant(domainId: string, id: PrincipalId, overrides: Partial<SecurityGrant> = {}): SecurityGrant {
  return {
    tenantId: tenant,
    id: `grant:${domainId}:${id}`,
    securityDomainId: domainId,
    principalId: id,
    capability: "manage_access",
    status: "active",
    expiresAtUtc: null,
    grantedByPrincipalId: both,
    reason: "migration read fixture",
    version: 1,
    createdAtUtc: "2026-09-10T10:00:00.000Z",
    updatedAtUtc: "2026-09-10T10:00:00.000Z",
    ...overrides,
  };
}

function plannedMigration(
  source: string | null,
  target: string | null,
  rootNodeId = "root",
): SecurityDomainMigration {
  return {
    tenantId: tenant,
    id: "migration-read",
    projectId,
    rootNodeId,
    sourceSecurityDomainId: source,
    targetSecurityDomainId: target,
    hierarchyRevision: 1,
    sourceSecurityEpoch: 1,
    targetSecurityEpoch: 2,
    state: "planned",
    cursor: null,
    totalItems: 2,
    migratedItems: 0,
    failure: null,
    nextAttemptAtUtc: null,
    deadlineAtUtc: "2026-09-11T00:00:00.000Z",
    version: 1,
    createdAtUtc: "2026-09-10T10:00:00.000Z",
    updatedAtUtc: "2026-09-10T10:00:00.000Z",
  };
}

async function prepare(
  persistence: Persistence,
  source: string | null,
  target: string | null,
  migrationRootNodeId = "root",
  migrationRootProjectId: string | null = null,
): Promise<SecurityDomainMigration> {
  const planned = plannedMigration(source, target, migrationRootNodeId);
  const active = transitionSecurityMigration(planned, "active", "2026-09-10T10:01:00.000Z");
  await persistence.transaction(tenant, async (transaction) => {
    await transaction.nodes.insert(node("root", null, source, 1));
    await transaction.nodes.insert(node("child", "root", source, 1));
    await transaction.nodes.insert(node("target-root", null, target, target === null ? 1 : 2));
    await transaction.nodes.insert(node("outside", null, null, 1));
    if (migrationRootProjectId !== null) {
      await transaction.nodes.insert({
        ...node(migrationRootNodeId, null, null, 1),
        projectId: migrationRootProjectId,
      });
    }
    for (const id of [oldOnly, newOnly, both, neither, revoked, expired, revokedGrant, revokedMember]) {
      await transaction.principals.insert({
        tenantId: tenant,
        id,
        kind: "user",
        status: id === revoked ? "revoked" : "active",
        version: 1,
        createdAtUtc: "2026-09-10T10:00:00.000Z",
        updatedAtUtc: "2026-09-10T10:00:00.000Z",
      });
      await transaction.memberships.insert(membership(id, id === revokedMember ? "revoked" : "active"));
    }
    if (source !== null) {
      await transaction.securityDomains.insert(domain(source, "root"));
      for (const id of [oldOnly, both, revoked, expired, revokedGrant, revokedMember]) {
        await transaction.securityGrants.insert(grant(source, id));
      }
    }
    if (target !== null) {
      await transaction.securityDomains.insert(domain(target, "target-root"));
      for (const id of [newOnly, both, revoked, revokedMember]) await transaction.securityGrants.insert(grant(target, id));
      await transaction.securityGrants.insert(grant(target, expired, { expiresAtUtc: "2026-09-10T10:01:30.000Z" }));
      await transaction.securityGrants.insert(grant(target, revokedGrant, { status: "revoked" }));
    }
    await transaction.securityMigrations.insert(planned);
    await transaction.securityMigrations.saveProgressPreservingPlan(active.id, active, planned.version);
  });
  return active;
}

async function canView(persistence: Persistence, id: PrincipalId, ownerNodeId: string, domainId: string | null, epoch: number) {
  return await persistence.read(tenant, async (transaction) => await canViewProjectObjectDuringMigration(
    transaction,
    await transaction.memberships.get(projectId, id),
    id,
    { projectId, ownerNodeId, securityDomainId: domainId, securityEpoch: epoch },
    "2026-09-10T10:02:00.000Z",
  ));
}

async function canContribute(persistence: Persistence, id: PrincipalId, ownerNodeId: string, domainId: string | null, epoch: number) {
  return await persistence.read(tenant, async (transaction) => await canAccessProjectObjectDuringMigration(
    transaction,
    await transaction.memberships.get(projectId, id),
    id,
    { projectId, ownerNodeId, securityDomainId: domainId, securityEpoch: epoch },
    "contribute",
    "2026-09-10T10:02:00.000Z",
  ));
}

test("TC-SEC-002H only a principal with both domain grants can read source or target objects", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      const migration = await prepare(current.persistence, sourceDomainId, targetDomainId);
      assert.equal(await canView(current.persistence, oldOnly, "child", sourceDomainId, 1), false, `${name}:old-source`);
      assert.equal(await canView(current.persistence, newOnly, "child", sourceDomainId, 1), false, `${name}:new-source`);
      assert.equal(await canView(current.persistence, both, "child", sourceDomainId, 1), true, `${name}:both-source`);
      assert.equal(await canView(current.persistence, revoked, "child", sourceDomainId, 1), false, `${name}:revoked`);
      assert.equal(await canView(current.persistence, expired, "child", sourceDomainId, 1), false, `${name}:expired-grant`);
      assert.equal(await canView(current.persistence, revokedGrant, "child", sourceDomainId, 1), false, `${name}:revoked-grant`);
      assert.equal(await canView(current.persistence, revokedMember, "child", sourceDomainId, 1), false, `${name}:revoked-member`);
      await current.persistence.transaction(tenant, async (transaction) => {
        await transaction.nodes.migrateSecurityOwnership(migration.id, "child", 1);
      });
      assert.equal(await canView(current.persistence, oldOnly, "child", targetDomainId, 2), false, `${name}:old-target`);
      assert.equal(await canView(current.persistence, newOnly, "child", targetDomainId, 2), false, `${name}:new-target`);
      assert.equal(await canView(current.persistence, both, "child", targetDomainId, 2), true, `${name}:both-target`);
      assert.equal(await canView(current.persistence, oldOnly, "outside", null, 1), true, `${name}:outside`);
      assert.equal(await canView(current.persistence, neither, "child", targetDomainId, 2), false, `${name}:neither`);
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002H active, verifying, retryable and recovery-required all retain the intersection", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    for (const targetState of ["verifying", "retryable", "recovery_required"] as const) {
      const current = await fixture(name);
      try {
        const active = await prepare(current.persistence, sourceDomainId, targetDomainId);
        const changed = transitionSecurityMigration(
          active,
          targetState,
          "2026-09-10T10:02:30.000Z",
          targetState === "verifying" ? null : `${targetState} fixture`,
        );
        await current.persistence.transaction(tenant, async (transaction) => {
          await transaction.securityMigrations.saveProgressPreservingPlan(active.id, changed, active.version);
        });
        assert.equal(await canView(current.persistence, oldOnly, "child", sourceDomainId, 1), false, `${name}:${targetState}:old`);
        assert.equal(await canView(current.persistence, newOnly, "child", sourceDomainId, 1), false, `${name}:${targetState}:new`);
        assert.equal(await canView(current.persistence, both, "child", sourceDomainId, 1), true, `${name}:${targetState}:both`);
      } finally {
        await current.cleanup();
      }
    }
  }
});

test("TC-SEC-002H source-public and target-public migrations still require the sensitive side", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const toPublic = await fixture(name);
    try {
      await prepare(toPublic.persistence, sourceDomainId, null);
      assert.equal(await canView(toPublic.persistence, oldOnly, "child", sourceDomainId, 1), true, `${name}:to-public-old`);
      assert.equal(await canView(toPublic.persistence, neither, "child", sourceDomainId, 1), false, `${name}:to-public-neither`);
    } finally {
      await toPublic.cleanup();
    }

    const fromPublic = await fixture(name);
    try {
      await prepare(fromPublic.persistence, null, targetDomainId);
      assert.equal(await canView(fromPublic.persistence, newOnly, "child", null, 1), true, `${name}:from-public-new`);
      assert.equal(await canView(fromPublic.persistence, neither, "child", null, 1), false, `${name}:from-public-neither`);
    } finally {
      await fromPublic.cleanup();
    }
  }
});

test("TC-SEC-002H write preauthorization cannot reveal the object's current migration side", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      const migration = await prepare(current.persistence, sourceDomainId, targetDomainId);
      assert.equal(await canContribute(current.persistence, oldOnly, "child", sourceDomainId, 1), false, `${name}:old-source`);
      assert.equal(await canContribute(current.persistence, newOnly, "child", sourceDomainId, 1), false, `${name}:new-source`);
      assert.equal(await canContribute(current.persistence, both, "child", sourceDomainId, 1), true, `${name}:both-source`);
      await current.persistence.transaction(tenant, async (transaction) => {
        await transaction.nodes.migrateSecurityOwnership(migration.id, "child", 1);
      });
      assert.equal(await canContribute(current.persistence, oldOnly, "child", targetDomainId, 2), false, `${name}:old-target`);
      assert.equal(await canContribute(current.persistence, newOnly, "child", targetDomainId, 2), false, `${name}:new-target`);
      assert.equal(await canContribute(current.persistence, both, "child", targetDomainId, 2), true, `${name}:both-target`);
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002H an invalid open migration root fails closed for the whole project", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const rootProjectIds = name === "memory" ? [null, "another-project"] as const : ["another-project"] as const;
    for (const rootProjectId of rootProjectIds) {
      const current = await fixture(name);
      try {
        await prepare(current.persistence, sourceDomainId, targetDomainId, "invalid-root", rootProjectId);
        assert.equal(
          await canView(current.persistence, both, "outside", null, 1),
          false,
          `${name}:${rootProjectId ?? "missing"}`,
        );
      } finally {
        await current.cleanup();
      }
    }
  }
});
