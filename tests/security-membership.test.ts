import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import { executeCreateNode } from "../packages/application/src/create-node.ts";
import { ApplicationError } from "../packages/application/src/errors.ts";
import type { CommandScope, Persistence } from "../packages/application/src/ports/persistence.ts";
import { CreateSecurityRootHandler } from "../packages/application/src/security/create-security-root.ts";
import { ManageSecurityGrantHandler } from "../packages/application/src/security/manage-security-grant.ts";
import {
  RestrictProjectMembershipHandler,
  type RestrictProjectMembershipCommand,
  type RestrictProjectMembershipFailurePoint,
} from "../packages/application/src/security/restrict-project-membership.ts";
import type { DomainEvent } from "../packages/domain/src/events.ts";
import { principalId, tenantId } from "../packages/domain/src/identity.ts";
import { projectMembershipRestrictionEventSchemas } from "../packages/domain/src/project-access.ts";
import { grantProjectMembership } from "./support/project-membership.ts";

const tenant = tenantId("tenant-membership-security");
const creator = principalId("membership-creator");
const replacement = principalId("membership-replacement");
const member = principalId("membership-member");
const projectId = "project-membership-security";

type Fixture = Readonly<{
  name: "memory" | "sqlite";
  persistence: Persistence;
  events(): Promise<DomainEvent[]>;
  outbox(): Promise<number>;
  cleanup(): Promise<void>;
}>;

async function fixture(name: "memory" | "sqlite"): Promise<Fixture> {
  if (name === "memory") {
    const persistence = new MemoryPersistence();
    return {
      name,
      persistence,
      events: async () => [...persistence.snapshot().events.values()],
      outbox: async () => await persistence.outboxConsumer.countReady("9999-12-31T23:59:59.999Z"),
      cleanup: async () => await persistence.close(),
    };
  }
  const directory = await mkdtemp(join(tmpdir(), "ppm-security-membership-"));
  const persistence = new SqlitePersistence({ path: join(directory, "membership.sqlite") });
  return {
    name,
    persistence,
    events: async () => await persistence.listEvents(tenant),
    outbox: async () => await persistence.outboxConsumer.countReady("9999-12-31T23:59:59.999Z"),
    cleanup: async () => { await persistence.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

async function prepare(
  persistence: Persistence,
  options: Readonly<{ domains?: number; replacementAdmin?: readonly number[]; memberGrant?: readonly number[] }> = {},
): Promise<void> {
  const domainCount = options.domains ?? 1;
  for (let index = 1; index <= domainCount; index += 1) {
    await executeCreateNode(persistence, {
      tenantId: tenant,
      commandId: `create-membership-root-${index}`,
      idempotencyKey: `create-membership-root-${index}`,
      correlationId: "security-membership",
      principalId: creator,
      projectId,
      nodeId: `membership-root-${index}`,
      parentId: null,
      title: `Membership root ${index}`,
      securityDomainId: null,
      occurredAtUtc: `2026-09-05T02:0${index}:00.000Z`,
    });
  }
  await grantProjectMembership(persistence, tenant, projectId, creator, { role: "project_manager" });
  await grantProjectMembership(persistence, tenant, projectId, replacement, { role: "project_manager" });
  await grantProjectMembership(persistence, tenant, projectId, member);
  for (let index = 1; index <= domainCount; index += 1) {
    await new CreateSecurityRootHandler(persistence).execute({
      tenantId: tenant,
      commandId: `secure-membership-root-${index}`,
      idempotencyKey: `secure-membership-root-${index}`,
      correlationId: "security-membership",
      principalId: creator,
      projectId,
      nodeId: `membership-root-${index}`,
      securityDomainId: `membership-domain-${index}`,
      expectedNodeVersion: 1,
      reason: "restricted",
      occurredAtUtc: `2026-09-05T02:1${index}:00.000Z`,
    });
    let domainVersion = 1;
    if (options.replacementAdmin?.includes(index)) {
      await grant(persistence, index, replacement, "manage_access", domainVersion, `replacement-${index}`);
      domainVersion += 1;
    }
    if (options.memberGrant?.includes(index)) {
      await grant(persistence, index, member, "view", domainVersion, `member-${index}`);
    }
  }
}

async function grant(
  persistence: Persistence,
  domainIndex: number,
  targetPrincipalId: typeof member | typeof replacement,
  capability: "view" | "manage_access",
  expectedDomainVersion: number,
  id: string,
): Promise<void> {
  await new ManageSecurityGrantHandler(persistence).execute({
    tenantId: tenant,
    commandId: `grant-${id}`,
    idempotencyKey: `grant-${id}`,
    correlationId: "security-membership",
    principalId: creator,
    projectId,
    securityDomainId: `membership-domain-${domainIndex}`,
    targetPrincipalId,
    action: "set",
    capability,
    expiresAtUtc: null,
    expectedGrantVersion: null,
    expectedDomainVersion,
    reason: "test setup",
    occurredAtUtc: `2026-09-05T02:2${domainIndex}:00.000Z`,
  });
}

function command(overrides: Partial<RestrictProjectMembershipCommand> = {}): RestrictProjectMembershipCommand {
  return {
    tenantId: tenant,
    commandId: "restrict-member",
    idempotencyKey: "restrict-member",
    correlationId: "security-membership",
    principalId: creator,
    projectId,
    targetPrincipalId: member,
    action: "revoke",
    expectedMembershipVersion: 1,
    reason: "project access removed",
    occurredAtUtc: "2026-09-05T02:30:00.000Z",
    ...overrides,
  };
}

test("TC-SEC-003C restriction atomically updates Membership, affected Domain, audit, event, Outbox and receipt", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence, { memberGrant: [1] });
      const beforeOutbox = await current.outbox();
      const handler = new RestrictProjectMembershipHandler(current.persistence);
      const result = await handler.execute(command());
      assert.deepEqual(result.value, {
        targetPrincipalId: member,
        role: "member",
        status: "revoked",
        membershipVersion: 2,
      }, name);
      assert.equal(result.replayed, false, name);
      const state = await current.persistence.read(tenant, async (transaction) => ({
        membership: await transaction.memberships.get(projectId, member),
        domain: await transaction.securityDomains.get("membership-domain-1"),
        audits: await transaction.membershipSecurityAudits.listByProject(projectId),
        receipt: await transaction.receipts.get({
          principalId: creator,
          operation: "restrict_project_membership",
          idempotencyKey: "restrict-member",
        }),
      }));
      assert.equal(state.membership?.version, 2, name);
      assert.equal(state.membership?.status, "revoked", name);
      assert.equal(state.domain?.permissionVersion, 3, name);
      assert.equal(state.domain?.version, 3, name);
      assert.equal(state.audits.length, 1, name);
      assert.equal(state.audits[0]?.action, "revoked", name);
      assert.equal(JSON.stringify(state.audits).includes(command().reason), false, name);
      assert.ok(state.receipt, name);
      const events = (await current.events()).filter((event) => event.causationId === command().commandId);
      assert.equal(events.length, 1, name);
      assert.deepEqual(events[0]?.payload, { action: "revoked", permissionVersion: 3 }, name);
      assert.equal(JSON.stringify(events).includes(command().reason), false, name);
      assert.equal(await current.outbox(), beforeOutbox + 1, name);
      const replay = await handler.execute({ ...command(), commandId: "lost-response-retry" });
      assert.equal(replay.replayed, true, name);
      assert.deepEqual(replay.value, result.value, name);
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-003C last actionable administrator cannot be demoted or revoked", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    for (const action of ["demote", "revoke"] as const) {
      const current = await fixture(name);
      try {
        await prepare(current.persistence);
        await assert.rejects(
          new RestrictProjectMembershipHandler(current.persistence).execute(command({
            commandId: `last-admin-${action}`,
            idempotencyKey: `last-admin-${action}`,
            targetPrincipalId: creator,
            action,
          })),
          (error) => error instanceof ApplicationError && error.code === "SECURITY_DOMAIN_LAST_ADMINISTRATOR",
          `${name}:${action}`,
        );
        const state = await current.persistence.read(tenant, async (transaction) => ({
          membership: await transaction.memberships.get(projectId, creator),
          domain: await transaction.securityDomains.get("membership-domain-1"),
          audits: await transaction.membershipSecurityAudits.listByProject(projectId),
        }));
        assert.equal(state.membership?.role, "project_manager", `${name}:${action}`);
        assert.equal(state.membership?.status, "active", `${name}:${action}`);
        assert.equal(state.domain?.version, 1, `${name}:${action}`);
        assert.deepEqual(state.audits, [], `${name}:${action}`);
      } finally {
        await current.cleanup();
      }
    }
  }
});

test("TC-SEC-003C one unsafe domain rolls back a multi-domain demotion", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence, { domains: 2, replacementAdmin: [1] });
      await assert.rejects(
        new RestrictProjectMembershipHandler(current.persistence).execute(command({
          commandId: "multi-domain-last-admin",
          idempotencyKey: "multi-domain-last-admin",
          targetPrincipalId: creator,
          action: "demote",
        })),
        (error) => error instanceof ApplicationError && error.code === "SECURITY_DOMAIN_LAST_ADMINISTRATOR",
        name,
      );
      const state = await current.persistence.read(tenant, async (transaction) => ({
        membership: await transaction.memberships.get(projectId, creator),
        first: await transaction.securityDomains.get("membership-domain-1"),
        second: await transaction.securityDomains.get("membership-domain-2"),
        audits: await transaction.membershipSecurityAudits.listByProject(projectId),
      }));
      assert.equal(state.membership?.role, "project_manager", name);
      assert.equal(state.first?.version, 2, name);
      assert.equal(state.second?.version, 1, name);
      assert.deepEqual(state.audits, [], name);
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-003C legacy-only and nested security scopes fail closed", async () => {
  const legacyTarget = principalId("legacy-membership-target");
  for (const name of ["memory", "sqlite"] as const) {
    const legacy = await fixture(name);
    try {
      await prepare(legacy.persistence);
      await grantProjectMembership(legacy.persistence, tenant, projectId, legacyTarget, {
        securityDomainIds: ["legacy-domain"],
      });
      await assert.rejects(
        new RestrictProjectMembershipHandler(legacy.persistence).execute(command({
          commandId: "reject-legacy-membership",
          idempotencyKey: "reject-legacy-membership",
          targetPrincipalId: legacyTarget,
        })),
        (error) => error instanceof ApplicationError && error.code === "PROJECT_MEMBERSHIP_TRANSITION_INVALID",
        `${name}:legacy`,
      );
      const membership = await legacy.persistence.read(tenant, async (transaction) => (
        await transaction.memberships.get(projectId, legacyTarget)
      ));
      assert.equal(membership?.status, "active", `${name}:legacy`);
    } finally {
      await legacy.cleanup();
    }

    const nested = await fixture(name);
    try {
      await prepare(nested.persistence, { memberGrant: [1] });
      await executeCreateNode(nested.persistence, {
        tenantId: tenant,
        commandId: "create-nested-membership-root",
        idempotencyKey: "create-nested-membership-root",
        correlationId: "security-membership",
        principalId: creator,
        projectId,
        nodeId: "nested-membership-root",
        parentId: null,
        title: "Nested legacy root",
        securityDomainId: null,
        occurredAtUtc: "2026-09-05T02:25:00.000Z",
      });
      await nested.persistence.transaction(tenant, async (transaction) => {
        await transaction.securityDomains.insert({
          tenantId: tenant,
          id: "nested-membership-domain",
          projectId,
          rootNodeId: "nested-membership-root",
          parentSecurityDomainId: "membership-domain-1",
          permissionVersion: 1,
          version: 1,
          createdByPrincipalId: creator,
          createdAtUtc: "2026-09-05T02:26:00.000Z",
          deletedAtUtc: null,
        });
        await transaction.securityGrants.insert({
          tenantId: tenant,
          id: "grant:nested-membership-domain:membership-member",
          securityDomainId: "nested-membership-domain",
          principalId: member,
          capability: "view",
          status: "active",
          expiresAtUtc: null,
          grantedByPrincipalId: creator,
          reason: "test fixture",
          version: 1,
          createdAtUtc: "2026-09-05T02:26:00.000Z",
          updatedAtUtc: "2026-09-05T02:26:00.000Z",
        });
      });
      await assert.rejects(
        new RestrictProjectMembershipHandler(nested.persistence).execute(command({
          commandId: "reject-nested-membership",
          idempotencyKey: "reject-nested-membership",
        })),
        (error) => error instanceof ApplicationError && error.code === "PROJECT_MEMBERSHIP_TRANSITION_INVALID",
        `${name}:nested`,
      );
      const state = await nested.persistence.read(tenant, async (transaction) => ({
        membership: await transaction.memberships.get(projectId, member),
        formal: await transaction.securityDomains.get("membership-domain-1"),
        nested: await transaction.securityDomains.get("nested-membership-domain"),
      }));
      assert.equal(state.membership?.status, "active", `${name}:nested`);
      assert.equal(state.formal?.version, 2, `${name}:nested`);
      assert.equal(state.nested?.version, 1, `${name}:nested`);
    } finally {
      await nested.cleanup();
    }
  }
});

test("TC-SEC-003C public membership event identities are isolated by project", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      for (const currentProject of ["membership-project-a", "membership-project-b"]) {
        await grantProjectMembership(current.persistence, tenant, currentProject, creator, { role: "project_manager" });
        await grantProjectMembership(current.persistence, tenant, currentProject, member);
        await new RestrictProjectMembershipHandler(current.persistence).execute(command({
          commandId: `restrict-${currentProject}`,
          idempotencyKey: `restrict-${currentProject}`,
          projectId: currentProject,
        }));
      }
      const events = (await current.events()).filter((event) => event.eventType === "project-map.project-membership.revoked");
      assert.equal(events.length, 2, name);
      assert.notEqual(events[0]?.aggregateId, events[1]?.aggregateId, name);
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-003C event schema registry matches the v1 compatibility fixtures", () => {
  const fixtures = JSON.parse(readFileSync(
    new URL("./fixtures/project-membership-restriction-events-v1.json", import.meta.url), "utf8",
  )) as Array<{ eventType: string; schemaVersion: number; payload: Record<string, unknown> }>;
  assert.deepEqual([...new Map(fixtures.map(({ eventType, schemaVersion }) => (
    [eventType, { eventType, schemaVersion }]
  ))).values()], [
    {
      eventType: projectMembershipRestrictionEventSchemas.demoted.eventType,
      schemaVersion: projectMembershipRestrictionEventSchemas.demoted.schemaVersion,
    },
    {
      eventType: projectMembershipRestrictionEventSchemas.revoked.eventType,
      schemaVersion: projectMembershipRestrictionEventSchemas.revoked.schemaVersion,
    },
  ]);
  for (const fixture of fixtures) {
    const action = fixture.payload.action as "demoted" | "revoked";
    const schema = projectMembershipRestrictionEventSchemas[action];
    const allowed = new Set([...schema.requiredPayloadFields, ...schema.optionalPayloadFields]);
    assert.equal(schema.requiredPayloadFields.every((field) => field in fixture.payload), true);
    assert.equal(Object.keys(fixture.payload).every((field) => allowed.has(field as "action" | "permissionVersion")), true);
    assert.equal(JSON.stringify(fixture).includes("reason"), false);
  }
});

test("TC-SEC-003C all injected failures roll back every artifact", async () => {
  const points: RestrictProjectMembershipFailurePoint[] = [
    "after_state", "after_audit", "after_event", "after_outbox", "after_receipt",
  ];
  for (const name of ["memory", "sqlite"] as const) {
    for (const point of points) {
      const current = await fixture(name);
      try {
        await prepare(current.persistence, { memberGrant: [1] });
        const beforeEvents = (await current.events()).length;
        const beforeOutbox = await current.outbox();
        await assert.rejects(
          new RestrictProjectMembershipHandler(current.persistence).execute(command(), point),
          new RegExp(`Injected failure: ${point}`),
          `${name}:${point}`,
        );
        const scope: CommandScope = {
          principalId: creator,
          operation: "restrict_project_membership",
          idempotencyKey: command().idempotencyKey,
        };
        const state = await current.persistence.read(tenant, async (transaction) => ({
          membership: await transaction.memberships.get(projectId, member),
          domain: await transaction.securityDomains.get("membership-domain-1"),
          audits: await transaction.membershipSecurityAudits.listByProject(projectId),
          receipt: await transaction.receipts.get(scope),
        }));
        assert.equal(state.membership?.status, "active", `${name}:${point}`);
        assert.equal(state.membership?.version, 1, `${name}:${point}`);
        assert.equal(state.domain?.version, 2, `${name}:${point}`);
        assert.deepEqual(state.audits, [], `${name}:${point}`);
        assert.equal(state.receipt, undefined, `${name}:${point}`);
        assert.equal((await current.events()).length, beforeEvents, `${name}:${point}`);
        assert.equal(await current.outbox(), beforeOutbox, `${name}:${point}`);
      } finally {
        await current.cleanup();
      }
    }
  }
});

test("TC-SEC-003C SQLite savepoint removes a partial Membership write when a caught domain write fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-membership-savepoint-"));
  const path = join(directory, "membership.sqlite");
  try {
    const setup = new SqlitePersistence({ path });
    await prepare(setup, { memberGrant: [1] });
    await setup.close();
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TRIGGER fail_membership_domain_update
      BEFORE UPDATE ON security_domains
      BEGIN SELECT RAISE(ABORT, 'injected domain failure'); END;
    `);
    database.close();
    const persistence = new SqlitePersistence({ path });
    await persistence.transaction(tenant, async (transaction) => {
      const membership = await transaction.memberships.get(projectId, member);
      assert.ok(membership);
      try {
        await transaction.memberships.restrictWithSecurityDomains({
          ...membership,
          status: "revoked",
          version: membership.version + 1,
          updatedAtUtc: "2026-09-05T02:30:00.000Z",
        }, membership.version, "2026-09-05T02:30:00.000Z");
        assert.fail("expected injected domain failure");
      } catch (error) {
        assert.match(String(error), /injected domain failure/);
      }
    });
    const state = await persistence.read(tenant, async (transaction) => ({
      membership: await transaction.memberships.get(projectId, member),
      domain: await transaction.securityDomains.get("membership-domain-1"),
    }));
    assert.equal(state.membership?.status, "active");
    assert.equal(state.membership?.version, 1);
    assert.equal(state.domain?.version, 2);
    await persistence.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TC-SEC-003C replay rechecks actor authorization", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const current = await fixture(name);
    try {
      await prepare(current.persistence, { replacementAdmin: [1], memberGrant: [1] });
      const handler = new RestrictProjectMembershipHandler(current.persistence);
      await handler.execute(command());
      await new RestrictProjectMembershipHandler(current.persistence).execute(command({
        commandId: "demote-original-actor",
        idempotencyKey: "demote-original-actor",
        principalId: replacement,
        targetPrincipalId: creator,
        action: "demote",
      }));
      await assert.rejects(
        handler.execute({ ...command(), commandId: "replay-after-actor-demotion" }),
        (error) => error instanceof ApplicationError && error.code === "NODE_NOT_FOUND",
        name,
      );
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-003C concurrent administrators cannot demote each other and strand the domain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-membership-race-"));
  const path = join(directory, "membership.sqlite");
  const first = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
  try {
    await prepare(first, { replacementAdmin: [1] });
    const second = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
    const results = await Promise.allSettled([
      new RestrictProjectMembershipHandler(first).execute(command({
        commandId: "demote-replacement",
        idempotencyKey: "demote-replacement",
        targetPrincipalId: replacement,
        action: "demote",
      })),
      new RestrictProjectMembershipHandler(second).execute(command({
        commandId: "demote-creator",
        idempotencyKey: "demote-creator",
        principalId: replacement,
        targetPrincipalId: creator,
        action: "demote",
      })),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    await second.close();
    await first.close();
    const restarted = new SqlitePersistence({ path });
    const state = await restarted.read(tenant, async (transaction) => ({
      creator: await transaction.memberships.get(projectId, creator),
      replacement: await transaction.memberships.get(projectId, replacement),
      domain: await transaction.securityDomains.get("membership-domain-1"),
      audits: await transaction.membershipSecurityAudits.listByProject(projectId),
    }));
    assert.equal([state.creator, state.replacement].filter((membership) => membership?.role === "project_manager").length, 1);
    assert.equal(state.domain?.version, 3);
    assert.equal(state.domain?.permissionVersion, 3);
    assert.equal(state.audits.length, 1);
    await restarted.close();
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});
