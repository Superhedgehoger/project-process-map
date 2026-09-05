import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import { executeCreateNode } from "../packages/application/src/create-node.ts";
import { ApplicationError } from "../packages/application/src/errors.ts";
import type { Persistence } from "../packages/application/src/ports/persistence.ts";
import { CreateSecurityRootHandler } from "../packages/application/src/security/create-security-root.ts";
import {
  ManageSecurityGrantHandler,
  type ManageSecurityGrantCommand,
  type ManageSecurityGrantFailurePoint,
} from "../packages/application/src/security/manage-security-grant.ts";
import { principalId, tenantId } from "../packages/domain/src/identity.ts";
import type { DomainEvent } from "../packages/domain/src/events.ts";
import { grantProjectMembership } from "./support/project-membership.ts";

const tenant = tenantId("tenant-security-grant");
const creator = principalId("grant-creator");
const replacement = principalId("grant-replacement");
const member = principalId("grant-member");

type Fixture = Readonly<{
  name: string;
  persistence: Persistence;
  events(): Promise<DomainEvent[]>;
  readyOutbox(): Promise<number>;
  cleanup(): Promise<void>;
}>;

async function fixture(name: "memory" | "sqlite"): Promise<Fixture> {
  if (name === "memory") {
    const persistence = new MemoryPersistence();
    return {
      name,
      persistence,
      events: async () => [...persistence.snapshot().events.values()],
      readyOutbox: async () => await persistence.outboxConsumer.countReady("9999-12-31T23:59:59.999Z"),
      cleanup: async () => await persistence.close(),
    };
  }
  const directory = await mkdtemp(join(tmpdir(), "ppm-security-grant-"));
  const persistence = new SqlitePersistence({ path: join(directory, "grant.sqlite") });
  return {
    name,
    persistence,
    events: async () => await persistence.listEvents(tenant),
    readyOutbox: async () => await persistence.outboxConsumer.countReady("9999-12-31T23:59:59.999Z"),
    cleanup: async () => { await persistence.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

async function prepare(persistence: Persistence): Promise<void> {
  await executeCreateNode(persistence, {
    tenantId: tenant,
    commandId: "create-grant-root",
    idempotencyKey: "create-grant-root",
    correlationId: "security-grant",
    principalId: creator,
    projectId: "project-grant",
    nodeId: "grant-root",
    parentId: null,
    title: "Grant root",
    securityDomainId: null,
    occurredAtUtc: "2026-09-05T01:00:00.000Z",
  });
  await grantProjectMembership(persistence, tenant, "project-grant", creator, { role: "project_manager" });
  await grantProjectMembership(persistence, tenant, "project-grant", replacement, { role: "project_manager" });
  await grantProjectMembership(persistence, tenant, "project-grant", member);
  await new CreateSecurityRootHandler(persistence).execute({
    tenantId: tenant,
    commandId: "secure-grant-root",
    idempotencyKey: "secure-grant-root",
    correlationId: "security-grant",
    principalId: creator,
    projectId: "project-grant",
    nodeId: "grant-root",
    securityDomainId: "grant-domain",
    expectedNodeVersion: 1,
    reason: "restricted",
    occurredAtUtc: "2026-09-05T01:01:00.000Z",
  });
}

function command(overrides: Partial<ManageSecurityGrantCommand> = {}): ManageSecurityGrantCommand {
  return {
    tenantId: tenant,
    commandId: "grant-member-view",
    idempotencyKey: "grant-member-view",
    correlationId: "security-grant",
    principalId: creator,
    projectId: "project-grant",
    securityDomainId: "grant-domain",
    targetPrincipalId: member,
    action: "set",
    capability: "view",
    expiresAtUtc: null,
    expectedGrantVersion: null,
    expectedDomainVersion: 1,
    reason: "needs access",
    occurredAtUtc: "2026-09-05T01:02:00.000Z",
    ...overrides,
  };
}

test("TC-SEC-003A Grant, Domain version, event, audit and receipt commit together", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence);
      const handler = new ManageSecurityGrantHandler(current.persistence);
      const created = await handler.execute(command());
      assert.equal(created.value.grantVersion, 1, name);
      assert.equal(created.value.permissionVersion, 2, name);
      const replay = await handler.execute({ ...command(), commandId: "lost-response-retry" });
      assert.equal(replay.replayed, true, name);
      const state = await current.persistence.read(tenant, async (transaction) => ({
        domain: await transaction.securityDomains.get("grant-domain"),
        grant: await transaction.securityGrants.get("grant-domain", member),
        audits: await transaction.securityGrantAudits.listByDomain("grant-domain"),
      }));
      assert.equal(state.domain?.version, 2, name);
      assert.equal(state.grant?.capability, "view", name);
      assert.equal(state.audits.length, 1, name);
      assert.equal(state.audits[0]?.action, "granted", name);
      assert.equal(JSON.stringify(state.audits).includes(command().reason), false, name);
      const events = (await current.events()).filter((event) => event.eventType.startsWith("project-map.security-grant."));
      assert.equal(events.length, 1, name);
      assert.equal(events[0]?.originalSecurityEpoch, 2, name);
      assert.equal(events[0]?.payload.permissionVersion, 2, name);
      assert.equal(JSON.stringify(events).includes(command().reason), false, name);

      await handler.execute(command({
        commandId: "change-member-grant",
        idempotencyKey: "change-member-grant",
        capability: "contribute",
        expectedGrantVersion: 1,
        expectedDomainVersion: 2,
      }));
      const changedEvents = (await current.events()).filter(
        (event) => event.eventType.startsWith("project-map.security-grant."),
      );
      assert.deepEqual(changedEvents.map((event) => event.originalSecurityEpoch), [2, 2], name);
      assert.deepEqual(changedEvents.map((event) => event.payload.permissionVersion), [2, 3], name);
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-003 last permanent administrator cannot be revoked, demoted or made temporary", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    for (const scenario of ["revoke", "demote", "temporary"] as const) {
      const current = await fixture(name);
      try {
        await prepare(current.persistence);
        const input = scenario === "revoke"
          ? command({
            commandId: "revoke-last", idempotencyKey: "revoke-last", targetPrincipalId: creator,
            action: "revoke", capability: null, expiresAtUtc: null, expectedGrantVersion: 1,
          })
          : command({
            commandId: `change-last-${scenario}`, idempotencyKey: `change-last-${scenario}`,
            targetPrincipalId: creator, capability: scenario === "demote" ? "edit" : "manage_access",
            expiresAtUtc: scenario === "temporary" ? "2099-09-06T01:00:00.000Z" : null,
            expectedGrantVersion: 1,
          });
        await assert.rejects(
          new ManageSecurityGrantHandler(current.persistence).execute(input),
          (error) => error instanceof ApplicationError && error.code === "SECURITY_DOMAIN_LAST_ADMINISTRATOR",
          `${name}:${scenario}`,
        );
        const state = await current.persistence.read(tenant, async (transaction) => ({
          domain: await transaction.securityDomains.get("grant-domain"),
          grant: await transaction.securityGrants.get("grant-domain", creator),
          audits: await transaction.securityGrantAudits.listByDomain("grant-domain"),
        }));
        assert.equal(state.domain?.version, 1, `${name}:${scenario}`);
        assert.equal(state.grant?.status, "active", `${name}:${scenario}`);
        assert.equal(state.grant?.capability, "manage_access", `${name}:${scenario}`);
        assert.deepEqual(state.audits, [], `${name}:${scenario}`);
      } finally {
        await current.cleanup();
      }
    }
  }
});

test("TC-SEC-003A caught persistence guard failures cannot commit a partial Grant write", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence);
      await current.persistence.transaction(tenant, async (transaction) => {
        const domain = await transaction.securityDomains.get("grant-domain");
        const grant = await transaction.securityGrants.get("grant-domain", creator);
        assert.ok(domain);
        assert.ok(grant);
        await assert.rejects(
          transaction.securityGrants.saveWithDomainVersion({
            ...grant,
            status: "revoked",
            version: grant.version + 1,
            updatedAtUtc: "2026-09-05T01:03:00.000Z",
          }, grant.version, {
            ...domain,
            permissionVersion: domain.permissionVersion + 1,
            version: domain.version + 1,
          }, domain.version),
          /SECURITY_DOMAIN_LAST_ADMINISTRATOR/,
          name,
        );
      });
      const state = await current.persistence.read(tenant, async (transaction) => ({
        domain: await transaction.securityDomains.get("grant-domain"),
        grant: await transaction.securityGrants.get("grant-domain", creator),
      }));
      assert.equal(state.domain?.version, 1, name);
      assert.equal(state.grant?.version, 1, name);
      assert.equal(state.grant?.status, "active", name);
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-003A persistence read callbacks cannot commit writes", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence);
      await current.persistence.read(tenant, async (transaction) => {
        const domain = await transaction.securityDomains.get("grant-domain");
        assert.ok(domain);
        await transaction.securityGrants.saveWithDomainVersion({
          tenantId: tenant,
          id: "grant:grant-domain:grant-member",
          securityDomainId: "grant-domain",
          principalId: member,
          capability: "view",
          status: "active",
          expiresAtUtc: null,
          grantedByPrincipalId: creator,
          reason: "read rollback test",
          version: 1,
          createdAtUtc: "2026-09-05T01:03:00.000Z",
          updatedAtUtc: "2026-09-05T01:03:00.000Z",
        }, null, {
          ...domain,
          permissionVersion: domain.permissionVersion + 1,
          version: domain.version + 1,
        }, domain.version);
      });
      const state = await current.persistence.read(tenant, async (transaction) => ({
        domain: await transaction.securityDomains.get("grant-domain"),
        grant: await transaction.securityGrants.get("grant-domain", member),
      }));
      assert.equal(state.domain?.version, 1, name);
      assert.equal(state.grant, undefined, name);
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-003A a replacement permanent administrator permits revoking the original", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence);
      const handler = new ManageSecurityGrantHandler(current.persistence);
      await handler.execute(command());
      await handler.execute(command({
        commandId: "grant-replacement", idempotencyKey: "grant-replacement",
        targetPrincipalId: replacement, capability: "manage_access",
        expectedDomainVersion: 2,
      }));
      const revoked = await handler.execute(command({
        commandId: "revoke-creator", idempotencyKey: "revoke-creator", principalId: replacement,
        targetPrincipalId: creator, action: "revoke", capability: null, expiresAtUtc: null,
        expectedGrantVersion: 1, expectedDomainVersion: 3,
      }));
      assert.equal(revoked.value.status, "revoked", name);
      assert.equal(revoked.value.permissionVersion, 4, name);
      await assert.rejects(
        handler.execute({ ...command(), commandId: "replay-after-grant-revocation" }),
        (error) => error instanceof ApplicationError && error.code === "NODE_NOT_FOUND",
        name,
      );
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-003 an ordinary member manage_access Grant cannot strand the domain", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence);
      const handler = new ManageSecurityGrantHandler(current.persistence);
      await handler.execute(command({ capability: "manage_access" }));
      await assert.rejects(
        handler.execute(command({
          commandId: "revoke-only-actionable-admin",
          idempotencyKey: "revoke-only-actionable-admin",
          targetPrincipalId: creator,
          action: "revoke",
          capability: null,
          expiresAtUtc: null,
          expectedGrantVersion: 1,
          expectedDomainVersion: 2,
        })),
        (error) => error instanceof ApplicationError && error.code === "SECURITY_DOMAIN_LAST_ADMINISTRATOR",
        name,
      );
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-003A authorization and target eligibility are rechecked before replay", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence);
      const handler = new ManageSecurityGrantHandler(current.persistence);
      await handler.execute(command());
      await current.persistence.transaction(tenant, async (transaction) => {
        const membership = await transaction.memberships.get("project-grant", creator);
        assert.ok(membership);
        await transaction.memberships.update({
          ...membership,
          status: "revoked",
          version: membership.version + 1,
          updatedAtUtc: "2026-09-05T01:03:00.000Z",
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

  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence);
      await current.persistence.transaction(tenant, async (transaction) => {
        const membership = await transaction.memberships.get("project-grant", member);
        assert.ok(membership);
        await transaction.memberships.update({
          ...membership,
          status: "revoked",
          version: membership.version + 1,
          updatedAtUtc: "2026-09-05T01:03:00.000Z",
        }, membership.version);
      });
      await assert.rejects(
        new ManageSecurityGrantHandler(current.persistence).execute(command()),
        (error) => error instanceof ApplicationError && error.code === "SECURITY_GRANT_TARGET_INELIGIBLE",
        name,
      );
    } finally {
      await current.cleanup();
    }
  }

  for (const revokedParty of ["actor-principal", "target-principal"] as const) {
    const persistence = new MemoryPersistence();
    try {
      await prepare(persistence);
      const handler = new ManageSecurityGrantHandler(persistence);
      await handler.execute(command());
      if (revokedParty === "actor-principal") {
        await handler.execute(command({
          commandId: "grant-replay-backup-admin",
          idempotencyKey: "grant-replay-backup-admin",
          targetPrincipalId: replacement,
          capability: "manage_access",
          expectedDomainVersion: 2,
        }));
      }
      await persistence.transaction(tenant, async (transaction) => {
        const id = revokedParty === "actor-principal" ? creator : member;
        const principal = await transaction.principals.get(id);
        assert.ok(principal);
        await transaction.principals.update({
          ...principal,
          status: "revoked",
          version: principal.version + 1,
          updatedAtUtc: "2026-09-05T01:04:00.000Z",
        }, principal.version);
      });
      await assert.rejects(
        handler.execute({ ...command(), commandId: `replay-${revokedParty}` }),
        (error) => error instanceof ApplicationError && error.code === (
          revokedParty === "actor-principal" ? "NODE_NOT_FOUND" : "SECURITY_GRANT_TARGET_INELIGIBLE"
        ),
        revokedParty,
      );
    } finally {
      await persistence.close();
    }
  }
});

test("TC-SEC-003A manager-without-Grant, service identity and cross-tenant callers fail closed", async () => {
  for (const scenario of ["manager-without-grant", "service", "cross-tenant"] as const) {
    const persistence = new MemoryPersistence();
    try {
      await prepare(persistence);
      if (scenario === "service") await persistence.transaction(tenant, async (transaction) => {
        const principal = await transaction.principals.get(replacement);
        assert.ok(principal);
        await transaction.principals.update({
          ...principal,
          kind: "service",
          version: principal.version + 1,
          updatedAtUtc: "2026-09-05T01:03:00.000Z",
        }, principal.version);
      });
      const input = scenario === "cross-tenant"
        ? command({ tenantId: tenantId("other-tenant") })
        : command({ principalId: replacement });
      await assert.rejects(
        new ManageSecurityGrantHandler(persistence).execute(input),
        (error) => error instanceof ApplicationError && error.code === "NODE_NOT_FOUND",
        scenario,
      );
    } finally {
      await persistence.close();
    }
  }
});

test("TC-SEC-003A nested security domains fail closed", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence);
      await executeCreateNode(current.persistence, {
        tenantId: tenant,
        commandId: "create-nested-root-node",
        idempotencyKey: "create-nested-root-node",
        correlationId: "security-grant",
        principalId: creator,
        projectId: "project-grant",
        nodeId: "nested-root-node",
        parentId: null,
        title: "Nested root placeholder",
        securityDomainId: null,
        occurredAtUtc: "2026-09-05T01:02:00.000Z",
      });
      await current.persistence.transaction(tenant, async (transaction) => {
        await transaction.securityDomains.insert({
          tenantId: tenant,
          id: "nested-domain",
          projectId: "project-grant",
          rootNodeId: "nested-root-node",
          parentSecurityDomainId: "grant-domain",
          permissionVersion: 1,
          version: 1,
          createdByPrincipalId: creator,
          createdAtUtc: "2026-09-05T01:03:00.000Z",
          deletedAtUtc: null,
        });
        await transaction.securityGrants.insert({
          tenantId: tenant,
          id: "grant:nested-domain:grant-creator",
          securityDomainId: "nested-domain",
          principalId: creator,
          capability: "manage_access",
          status: "active",
          expiresAtUtc: null,
          grantedByPrincipalId: creator,
          reason: "nested fixture",
          version: 1,
          createdAtUtc: "2026-09-05T01:03:00.000Z",
          updatedAtUtc: "2026-09-05T01:03:00.000Z",
        });
      });
      await assert.rejects(
        new ManageSecurityGrantHandler(current.persistence).execute(command({ securityDomainId: "nested-domain" })),
        (error) => error instanceof ApplicationError && error.code === "NODE_NOT_FOUND",
        name,
      );
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-003A legacy, cross-project and migrating domains fail closed", async () => {
  for (const scenario of ["legacy", "cross-project", "migration"] as const) {
    const persistence = new MemoryPersistence();
    try {
      await prepare(persistence);
      if (scenario === "migration") await persistence.transaction(tenant, async (transaction) => {
        await transaction.securityMigrations.insert({
          tenantId: tenant,
          id: "grant-migration",
          projectId: "project-grant",
          rootNodeId: "grant-root",
          sourceSecurityDomainId: "grant-domain",
          targetSecurityDomainId: "target-domain",
          hierarchyRevision: 1,
          sourceSecurityEpoch: 1,
          targetSecurityEpoch: 2,
          state: "active",
          cursor: null,
          totalItems: 1,
          migratedItems: 0,
          failure: null,
          nextAttemptAtUtc: null,
          deadlineAtUtc: "2026-09-06T01:00:00.000Z",
          version: 1,
          createdAtUtc: "2026-09-05T01:02:00.000Z",
          updatedAtUtc: "2026-09-05T01:02:00.000Z",
        });
      });
      const input = scenario === "legacy"
        ? command({ securityDomainId: "legacy-domain" })
        : scenario === "cross-project"
          ? command({ projectId: "other-project" })
          : command();
      await assert.rejects(
        new ManageSecurityGrantHandler(persistence).execute(input),
        (error) => error instanceof ApplicationError && error.code === (
          scenario === "migration" ? "SECURITY_MIGRATION_IN_PROGRESS" : "NODE_NOT_FOUND"
        ),
        scenario,
      );
    } finally {
      await persistence.close();
    }
  }
});

test("TC-SEC-003A an expired administrator Grant cannot authorize a new write", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence);
      await new ManageSecurityGrantHandler(current.persistence).execute(command({
        commandId: "grant-expiry-backup",
        idempotencyKey: "grant-expiry-backup",
        targetPrincipalId: replacement,
        capability: "manage_access",
      }));
      await current.persistence.transaction(tenant, async (transaction) => {
        const domain = await transaction.securityDomains.get("grant-domain");
        const grant = await transaction.securityGrants.get("grant-domain", creator);
        assert.ok(domain);
        assert.ok(grant);
        await transaction.securityGrants.saveWithDomainVersion({
          ...grant,
          expiresAtUtc: "2000-01-01T00:00:00.000Z",
          version: grant.version + 1,
          updatedAtUtc: "2026-09-05T01:03:00.000Z",
        }, grant.version, {
          ...domain,
          permissionVersion: domain.permissionVersion + 1,
          version: domain.version + 1,
        }, domain.version);
      });
      await assert.rejects(
        new ManageSecurityGrantHandler(current.persistence).execute(command({
          commandId: "expired-actor",
          idempotencyKey: "expired-actor",
          expectedDomainVersion: 3,
        })),
        (error) => error instanceof ApplicationError && error.code === "NODE_NOT_FOUND",
        name,
      );
      await assert.rejects(
        new ManageSecurityGrantHandler(current.persistence).execute(command({
          commandId: "replay-expired-actor-receipt",
          idempotencyKey: "grant-expiry-backup",
          targetPrincipalId: replacement,
          capability: "manage_access",
        })),
        (error) => error instanceof ApplicationError && error.code === "NODE_NOT_FOUND",
        `${name}:replay`,
      );
    } finally {
      await current.cleanup();
    }
  }
});

for (const failurePoint of ["after_state", "after_audit", "after_event", "after_outbox", "after_receipt"] satisfies ManageSecurityGrantFailurePoint[]) {
  test(`TC-SEC-003A ${failurePoint} rolls back Grant, Domain, audit and receipt`, async () => {
    for (const name of ["memory", "sqlite"] as const) {
      const current = await fixture(name);
      try {
        await prepare(current.persistence);
        await assert.rejects(
          new ManageSecurityGrantHandler(current.persistence).execute(command(), failurePoint),
          new RegExp(failurePoint),
          name,
        );
        const state = await current.persistence.read(tenant, async (transaction) => ({
          domain: await transaction.securityDomains.get("grant-domain"),
          grant: await transaction.securityGrants.get("grant-domain", member),
          audits: await transaction.securityGrantAudits.listByDomain("grant-domain"),
          receipt: await transaction.receipts.get({
            principalId: creator,
            operation: "manage_security_grant",
            idempotencyKey: "grant-member-view",
          }),
        }));
        assert.equal(state.domain?.version, 1, name);
        assert.equal(state.grant, undefined, name);
        assert.deepEqual(state.audits, [], name);
        assert.equal(state.receipt, undefined, name);
        assert.equal((await current.events()).filter(
          (event) => event.eventType.startsWith("project-map.security-grant."),
        ).length, 0, name);
        assert.equal(await current.readyOutbox(), 2, name);
      } finally {
        await current.cleanup();
      }
    }
  });
}

test("TC-SEC-003A SQLite restart and concurrent Grant commands preserve one domain version sequence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-security-grant-concurrent-"));
  const path = join(directory, "grant.sqlite");
  const first = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
  try {
    await prepare(first);
    const second = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
    const results = await Promise.allSettled([
      new ManageSecurityGrantHandler(first).execute(command({ commandId: "concurrent-a", idempotencyKey: "concurrent-a" })),
      new ManageSecurityGrantHandler(second).execute(command({ commandId: "concurrent-b", idempotencyKey: "concurrent-b" })),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    await second.close();
    await first.close();
    const restarted = new SqlitePersistence({ path });
    const state = await restarted.read(tenant, async (transaction) => ({
      domain: await transaction.securityDomains.get("grant-domain"),
      grant: await transaction.securityGrants.get("grant-domain", member),
      audits: await transaction.securityGrantAudits.listByDomain("grant-domain"),
    }));
    assert.equal(state.domain?.version, 2);
    assert.equal(state.grant?.version, 1);
    assert.equal(state.audits.length, 1);
    await restarted.close();
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TC-SEC-003A SQLite v4 to v5 upgrade preserves SecurityDomain and Grant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-security-grant-upgrade-"));
  const path = join(directory, "grant-upgrade.sqlite");
  try {
    const original = new SqlitePersistence({ path });
    await prepare(original);
    await original.close();

    const legacy = new DatabaseSync(path);
    legacy.exec("DROP TABLE security_grant_audits; DELETE FROM schema_migrations WHERE version = 5");
    legacy.close();

    const upgraded = new SqlitePersistence({ path });
    const state = await upgraded.read(tenant, async (transaction) => ({
      domain: await transaction.securityDomains.get("grant-domain"),
      grant: await transaction.securityGrants.get("grant-domain", creator),
      audits: await transaction.securityGrantAudits.listByDomain("grant-domain"),
    }));
    assert.equal(state.domain?.version, 1);
    assert.equal(state.grant?.capability, "manage_access");
    assert.deepEqual(state.audits, []);
    await upgraded.close();

    const evidence = new DatabaseSync(path, { readOnly: true });
    assert.equal((evidence.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version, 5);
    evidence.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TC-SEC-003 concurrent administrators cannot revoke each other and strand the domain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-security-grant-admin-race-"));
  const path = join(directory, "grant.sqlite");
  const first = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
  try {
    await prepare(first);
    await new ManageSecurityGrantHandler(first).execute(command({
      commandId: "grant-race-replacement",
      idempotencyKey: "grant-race-replacement",
      targetPrincipalId: replacement,
      capability: "manage_access",
    }));
    const second = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
    try {
      const results = await Promise.allSettled([
        new ManageSecurityGrantHandler(first).execute(command({
          commandId: "creator-revokes-replacement",
          idempotencyKey: "creator-revokes-replacement",
          targetPrincipalId: replacement,
          action: "revoke",
          capability: null,
          expiresAtUtc: null,
          expectedGrantVersion: 1,
          expectedDomainVersion: 2,
        })),
        new ManageSecurityGrantHandler(second).execute(command({
          commandId: "replacement-revokes-creator",
          idempotencyKey: "replacement-revokes-creator",
          principalId: replacement,
          targetPrincipalId: creator,
          action: "revoke",
          capability: null,
          expiresAtUtc: null,
          expectedGrantVersion: 1,
          expectedDomainVersion: 2,
        })),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected").length, 1);
      const grants = await first.read(tenant, async (transaction) => (
        await transaction.securityGrants.listByDomain("grant-domain")
      ));
      const activeAdministrators = grants.filter((grant) => grant.status === "active"
        && grant.capability === "manage_access" && grant.expiresAtUtc === null);
      assert.equal(activeAdministrators.length, 1);
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});
