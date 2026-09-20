import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import { createProductionSqliteBundle } from "../packages/adapters/src/sqlite/production-bundle.ts";
import { ApplicationError } from "../packages/application/src/errors.ts";
import { hashRoleBindingPayload } from "../packages/application/src/role-slots/assign-project-role-binding.ts";
import type {
  AssignProjectRoleBindingCommand,
  AssignProjectRoleBindingFailurePoint,
  InitializeProjectRoleSlotsCommand,
  Persistence,
} from "../packages/application/src/ports/persistence.ts";
import { principalId, tenantId, type PrincipalId, type TenantId } from "../packages/domain/src/identity.ts";
import {
  type TemplateRoleSlot,
  type ProjectRoleBinding,
  normalizeCandidateIds,
  assertValidSlotKey,
  roleBindingEventSchemas,
  roleSlotEventSchemas,
} from "../packages/domain/src/role-slots.ts";

import { transitionSecurityMigration, type SecurityDomainMigration } from "../packages/domain/src/security-migration.ts";
import { createTestMemoryBundle, createTestSqliteBundle } from "./helpers/test-persistence-bundle.ts";
import { grantProjectMembership } from "./support/project-membership.ts";

const tenant = tenantId("tenant-role-binding");
const otherTenant = tenantId("tenant-cross");
const projectId = "project-role-test";
const manager = principalId("pm-principal-1");
const altManager = principalId("pm-principal-2");
const memberU1 = principalId("member-u1");
const memberU2 = principalId("member-u2");
const memberU3 = principalId("member-u3");
const crossTenantUser = principalId("cross-tenant-user");
const revokedUser = principalId("revoked-user");
const revokedMember = principalId("revoked-member");
const unregisteredUser = principalId("unregistered-user");

type Fixture = {
  name: "memory" | "sqlite";
  persistence: Persistence;
  path?: string;
  cleanup(): Promise<void>;
};

async function createFixture(name: "memory" | "sqlite", options: { now?: () => Date } = {}): Promise<Fixture> {
  const now = options.now ?? (() => new Date("2026-09-15T01:00:00.000Z"));
  if (name === "memory") {
    const bundle = createTestMemoryBundle({ now });
    return {
      name,
      persistence: bundle.persistence,
      cleanup: async () => await bundle.persistence.close(),
    };
  }
  const directory = await mkdtemp(join(tmpdir(), "ppm-role-binding-"));
  const path = join(directory, "role-binding.sqlite");
  const bundle = createTestSqliteBundle({ path, now });
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

async function prepareIdentitiesAndSlots(persistence: Persistence): Promise<void> {
  const atUtc = "2026-09-15T00:00:00.000Z";

  // Grant project memberships
  await grantProjectMembership(persistence, tenant, projectId, manager, { role: "project_manager" });
  await grantProjectMembership(persistence, tenant, projectId, altManager, { role: "project_manager" });
  await grantProjectMembership(persistence, tenant, projectId, memberU1, { role: "member" });
  await grantProjectMembership(persistence, tenant, projectId, memberU2, { role: "member" });
  await grantProjectMembership(persistence, tenant, projectId, memberU3, { role: "member" });

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

  // Revoked user & revoked member in main tenant
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

    // Seed a root node into project
    await tx.nodes.insert({
      tenantId: tenant,
      id: "node-root-1",
      projectId,
      parentId: null,
      leaderPrincipalId: null,
      title: "Root Node",
      kind: "work_package",
      securityDomainId: null,
      securityEpoch: 1,
      version: 1,
      deletedAtUtc: null,
    });
  });

  // Initialize TemplateRoleSlots into project via PM
  await persistence.executeInitializeProjectRoleSlots({
    tenantId: tenant,
    commandId: "cmd-init-slots-1",
    idempotencyKey: "idem-init-slots-1",
    principalId: manager,
    projectId,
    sourceTemplateVersionId: "tpl-v1",
    occurredAtUtc: atUtc,
    slots: [
      {
        slotKey: "reviewer_qa",
        name: "QA 验收人",
        description: "负责质量验收的角色槽位",
      },
      {
        slotKey: "security_auditor",
        name: "安全审计员",
        description: "负责安全审计的角色槽位",
      },
    ],
  });
}

function assignCmd(overrides: Partial<AssignProjectRoleBindingCommand> = {}): AssignProjectRoleBindingCommand {
  return {
    tenantId: tenant,
    commandId: "cmd-assign-role-1",
    idempotencyKey: "idem-assign-role-1",
    correlationId: "cor-role-1",
    principalId: manager,
    projectId,
    slotKey: "reviewer_qa",
    principalIds: [memberU2, memberU1, memberU2],
    expectedVersion: 0,
    occurredAtUtc: "2026-09-15T01:00:00.000Z",
    ...overrides,
  };
}

// 1. Domain unit tests
test("TC-SEC-004B TemplateRoleSlot and candidate normalization", () => {
  const candidates = [principalId("user-b"), principalId("user-a"), principalId("user-b"), principalId("user-c"), principalId("user-a")];
  const normalized = normalizeCandidateIds(candidates);
  assert.deepEqual(normalized, [principalId("user-a"), principalId("user-b"), principalId("user-c")]);

  assert.doesNotThrow(() => assertValidSlotKey("reviewer_qa"));
  assert.doesNotThrow(() => assertValidSlotKey("approver-sec"));

  assert.throws(() => assertValidSlotKey(""), /INVALID_ROLE_SLOT_KEY/);
  assert.throws(() => assertValidSlotKey("invalid slot key"), /INVALID_ROLE_SLOT_KEY/);
  assert.throws(() => assertValidSlotKey("a".repeat(65)), /INVALID_ROLE_SLOT_KEY/);
});

// 2. Event schema registry & ADR-008 fixture verification
test("TC-SEC-004B ADR-008 schema registry, fixtures, and sensitive field exclusion", async () => {
  assert.equal(roleBindingEventSchemas.assigned.eventType, "project-map.role-binding.assigned");
  assert.equal(roleBindingEventSchemas.assigned.schemaVersion, 1);
  assert.deepEqual(roleBindingEventSchemas.assigned.requiredPayloadFields, [
    "projectId",
    "slotKey",
    "principalIds",
    "version",
  ]);

  assert.equal(roleSlotEventSchemas.initialized.eventType, "project-map.role-slots.initialized");
  assert.equal(roleSlotEventSchemas.initialized.schemaVersion, 1);
  assert.deepEqual(roleSlotEventSchemas.initialized.requiredPayloadFields, [
    "projectId",
    "sourceTemplateVersionId",
    "slotKeys",
  ]);

  const fixturesPath = join(process.cwd(), "tests/fixtures/role-binding-events-v1.json");
  const rawFixtures = await readFile(fixturesPath, "utf-8");
  const fixtures = JSON.parse(rawFixtures) as Array<{
    eventType: string;
    schemaVersion: number;
    payload: Record<string, unknown>;
  }>;
  assert.ok(fixtures.length >= 2);

  const forbiddenSensitiveKeys = ["secret", "token", "password", "apiKey", "credentials", "authorization"];
  for (const item of fixtures) {
    assert.equal(item.schemaVersion, 1);
    if (item.eventType === "project-map.role-binding.assigned") {
      for (const field of roleBindingEventSchemas.assigned.requiredPayloadFields) {
        assert.ok(field in item.payload, `Fixture missing required field: ${field}`);
      }
    } else if (item.eventType === "project-map.role-slots.initialized") {
      for (const field of roleSlotEventSchemas.initialized.requiredPayloadFields) {
        assert.ok(field in item.payload, `Fixture missing required field: ${field}`);
      }
    } else {
      assert.fail(`Unexpected fixture eventType: ${item.eventType}`);
    }
    for (const key of Object.keys(item.payload)) {
      assert.equal(forbiddenSensitiveKeys.includes(key), false, `Sensitive key leaked in payload: ${key}`);
    }
  }

  // Dead-letter check on unknown schema version
  const simulatedConsumer = (event: { eventType: string; schemaVersion: number }) => {
    const allSchemas = [...Object.values(roleBindingEventSchemas), ...Object.values(roleSlotEventSchemas)];
    const known = allSchemas.find(
      (s) => s.eventType === event.eventType && s.schemaVersion === event.schemaVersion,
    );
    if (!known) {
      throw new Error(`DEAD_LETTER: Unrecognized event version ${event.eventType}.v${event.schemaVersion}`);
    }
    return true;
  };

  assert.equal(simulatedConsumer({ eventType: "project-map.role-binding.assigned", schemaVersion: 1 }), true);
  assert.throws(
    () => simulatedConsumer({ eventType: "project-map.role-binding.assigned", schemaVersion: 2 }),
    /DEAD_LETTER/,
  );
});

// 3. Dual-engine matrix (Memory & SQLite)
for (const engine of ["memory", "sqlite"] as const) {
  test(`TC-SEC-004B (${engine}): Full lifecycle - slot queries, assignment, deduplication, idempotency, updates, clearing`, async () => {
    const fixture = await createFixture(engine);
    try {
      await prepareIdentitiesAndSlots(fixture.persistence);

      // Slot queries
      await fixture.persistence.transaction(tenant, async (tx) => {
        const slot = await tx.roleSlots.get(projectId, "reviewer_qa");
        assert.ok(slot);
        assert.equal(slot.name, "QA 验收人");
        assert.equal(slot.sourceTemplateVersionId, "tpl-v1");

        const allSlots = await tx.roleSlots.listByProject(projectId);
        assert.equal(allSlots.length, 2);

        const initialBinding = await tx.roleBindings.get(projectId, "reviewer_qa");
        assert.equal(initialBinding, undefined);

        const initialBindings = await tx.roleBindings.listByProject(projectId);
        assert.deepEqual(initialBindings, []);
      });

      // 1. Initial Assignment by PM: [memberU2, memberU1, memberU2] -> deduplicated to [memberU1, memberU2]
      const assignResult = await fixture.persistence.executeAssignProjectRoleBinding(
        assignCmd({
          principalIds: [memberU2, memberU1, memberU2],
          expectedVersion: 0,
        }),
      );

      assert.equal(assignResult.replayed, false);
      assert.equal(assignResult.binding.projectId, projectId);
      assert.equal(assignResult.binding.slotKey, "reviewer_qa");
      assert.deepEqual(assignResult.binding.principalIds, [memberU1, memberU2]);
      assert.equal(assignResult.binding.version, 1);
      assert.equal(assignResult.binding.updatedByPrincipalId, manager);
      assert.equal(assignResult.binding.updatedAtUtc, "2026-09-15T01:00:00.000Z");
      assert.equal(assignResult.event.eventType, "project-map.role-binding.assigned");
      assert.equal(assignResult.outbox.topic, "project-map.role-binding.assigned.v1");

      // Verify in persistence
      await fixture.persistence.transaction(tenant, async (tx) => {
        const binding = await tx.roleBindings.get(projectId, "reviewer_qa");
        assert.ok(binding);
        assert.deepEqual(binding.principalIds, [memberU1, memberU2]);
        assert.equal(binding.version, 1);

        const list = await tx.roleBindings.listByProject(projectId);
        assert.equal(list.length, 1);
        assert.equal(list[0]?.slotKey, "reviewer_qa");
      });

      // 2. Idempotency replay: exact same command returns replayed: true with identical result
      const replayResult = await fixture.persistence.executeAssignProjectRoleBinding(
        assignCmd({
          principalIds: [memberU2, memberU1, memberU2],
          expectedVersion: 0,
        }),
      );
      assert.equal(replayResult.replayed, true);
      assert.deepEqual(replayResult.binding.principalIds, [memberU1, memberU2]);
      assert.equal(replayResult.binding.version, 1);

      // 3. Update candidates by Alt PM with expectedVersion: 1
      const updateResult = await fixture.persistence.executeAssignProjectRoleBinding(
        assignCmd({
          commandId: "cmd-assign-role-2",
          idempotencyKey: "idem-assign-role-2",
          principalId: altManager,
          principalIds: [memberU3],
          expectedVersion: 1,
          occurredAtUtc: "2026-09-15T01:30:00.000Z",
        }),
      );
      assert.equal(updateResult.replayed, false);
      assert.deepEqual(updateResult.binding.principalIds, [memberU3]);
      assert.equal(updateResult.binding.version, 2);
      assert.equal(updateResult.binding.updatedByPrincipalId, altManager);

      // 4. Clear candidates by PM (principalIds: []) with expectedVersion: 2
      const clearResult = await fixture.persistence.executeAssignProjectRoleBinding(
        assignCmd({
          commandId: "cmd-assign-role-3",
          idempotencyKey: "idem-assign-role-3",
          principalId: manager,
          principalIds: [],
          expectedVersion: 2,
          occurredAtUtc: "2026-09-15T02:00:00.000Z",
        }),
      );
      assert.equal(clearResult.replayed, false);
      assert.deepEqual(clearResult.binding.principalIds, []);
      assert.equal(clearResult.binding.version, 3);
      assert.equal(clearResult.binding.updatedByPrincipalId, manager);
    } finally {
      await fixture.cleanup();
    }
  });

  test(`TC-SEC-004B (${engine}): Negative matrix - authorization, candidate eligibility, slot validation, version conflict, idempotency mismatch, replay recheck, security migration freeze`, async () => {
    const fixture = await createFixture(engine);
    try {
      await prepareIdentitiesAndSlots(fixture.persistence);

      // 1. Non-PM operator (memberU1) -> FORBIDDEN
      await assert.rejects(
        fixture.persistence.executeAssignProjectRoleBinding(
          assignCmd({ principalId: memberU1 }),
        ),
        (e) => e instanceof ApplicationError && e.code === "FORBIDDEN",
        "Member U1 cannot assign role bindings",
      );

      // 2. Unregistered operator -> FORBIDDEN
      await assert.rejects(
        fixture.persistence.executeAssignProjectRoleBinding(
          assignCmd({ principalId: unregisteredUser }),
        ),
        (e) => e instanceof ApplicationError && e.code === "FORBIDDEN",
        "Unregistered user cannot assign role bindings",
      );

      // 3. Revoked operator -> FORBIDDEN
      await assert.rejects(
        fixture.persistence.executeAssignProjectRoleBinding(
          assignCmd({ principalId: revokedUser }),
        ),
        (e) => e instanceof ApplicationError && e.code === "FORBIDDEN",
        "Revoked user cannot assign role bindings",
      );

      // 4. Ineligible candidate: unregistered principal -> INVALID_ROLE_BINDING_CANDIDATE
      await assert.rejects(
        fixture.persistence.executeAssignProjectRoleBinding(
          assignCmd({ principalIds: [unregisteredUser] }),
        ),
        (e) => e instanceof ApplicationError && e.code === "INVALID_ROLE_BINDING_CANDIDATE",
        "Unregistered candidate rejected",
      );

      // 5. Ineligible candidate: revoked user -> INVALID_ROLE_BINDING_CANDIDATE
      await assert.rejects(
        fixture.persistence.executeAssignProjectRoleBinding(
          assignCmd({ principalIds: [revokedUser] }),
        ),
        (e) => e instanceof ApplicationError && e.code === "INVALID_ROLE_BINDING_CANDIDATE",
        "Revoked user candidate rejected",
      );

      // 6. Ineligible candidate: revoked project member -> INVALID_ROLE_BINDING_CANDIDATE
      await assert.rejects(
        fixture.persistence.executeAssignProjectRoleBinding(
          assignCmd({ principalIds: [revokedMember] }),
        ),
        (e) => e instanceof ApplicationError && e.code === "INVALID_ROLE_BINDING_CANDIDATE",
        "Revoked membership candidate rejected",
      );

      // 7. Ineligible candidate: cross-tenant user -> INVALID_ROLE_BINDING_CANDIDATE
      await assert.rejects(
        fixture.persistence.executeAssignProjectRoleBinding(
          assignCmd({ principalIds: [crossTenantUser] }),
        ),
        (e) => e instanceof ApplicationError && e.code === "INVALID_ROLE_BINDING_CANDIDATE",
        "Cross-tenant candidate rejected",
      );

      // 8. Non-existent slot key -> ROLE_SLOT_NOT_FOUND
      await assert.rejects(
        fixture.persistence.executeAssignProjectRoleBinding(
          assignCmd({ slotKey: "non_existent_slot" }),
        ),
        (e) => e instanceof ApplicationError && e.code === "ROLE_SLOT_NOT_FOUND",
        "Non-existent slot key rejected",
      );

      // 9. Invalid slot key format -> INVALID_ROLE_SLOT
      await assert.rejects(
        fixture.persistence.executeAssignProjectRoleBinding(
          assignCmd({ slotKey: "invalid slot with spaces" }),
        ),
        (e) => e instanceof ApplicationError && e.code === "INVALID_ROLE_SLOT",
        "Malformed slot key rejected",
      );

      // 10. Version conflict on initial create: expectedVersion: 1 when version is 0 -> ROLE_BINDING_VERSION_CONFLICT
      await assert.rejects(
        fixture.persistence.executeAssignProjectRoleBinding(
          assignCmd({ expectedVersion: 1 }),
        ),
        (e) => e instanceof ApplicationError && e.code === "ROLE_BINDING_VERSION_CONFLICT",
        "Version conflict rejected",
      );

      // Now successfully create version 1
      await fixture.persistence.executeAssignProjectRoleBinding(
        assignCmd({ expectedVersion: 0 }),
      );

      // 11. Version conflict on update: expectedVersion: 0 when version is 1 -> ROLE_BINDING_VERSION_CONFLICT
      await assert.rejects(
        fixture.persistence.executeAssignProjectRoleBinding(
          assignCmd({
            commandId: "cmd-assign-role-conflict",
            idempotencyKey: "idem-assign-role-conflict",
            expectedVersion: 0,
          }),
        ),
        (e) => e instanceof ApplicationError && e.code === "ROLE_BINDING_VERSION_CONFLICT",
        "Stale version update rejected",
      );

      // 12. Idempotency key reused with different payload -> IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD
      await assert.rejects(
        fixture.persistence.executeAssignProjectRoleBinding(
          assignCmd({
            commandId: "cmd-diff-payload",
            // same idempotency key as initial create: "idem-assign-role-1"
            principalIds: [memberU3],
            expectedVersion: 0,
          }),
        ),
        (e) => e instanceof ApplicationError && e.code === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
        "Idempotency key reuse with different candidates rejected",
      );

      await assert.rejects(
        fixture.persistence.executeAssignProjectRoleBinding(
          assignCmd({
            commandId: "cmd-diff-slot",
            // same idempotency key as initial create: "idem-assign-role-1"
            slotKey: "security_auditor",
            expectedVersion: 0,
          }),
        ),
        (e) => e instanceof ApplicationError && e.code === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
        "Idempotency key reuse with different slotKey rejected",
      );

      // 13. Replay authorization recheck: revoke PM principal and attempt replay
      await fixture.persistence.transaction(tenant, async (tx) => {
        const pmPrincipal = await tx.principals.get(manager);
        if (pmPrincipal) {
          await tx.principals.update(
            { ...pmPrincipal, status: "revoked", version: pmPrincipal.version + 1 },
            pmPrincipal.version,
          );
        }
      });

      await assert.rejects(
        fixture.persistence.executeAssignProjectRoleBinding(
          assignCmd({ expectedVersion: 0 }),
        ),
        (e) => e instanceof ApplicationError && e.code === "FORBIDDEN",
        "Replay with revoked PM principal is rejected upon revalidation",
      );

      // Restore PM principal
      await fixture.persistence.transaction(tenant, async (tx) => {
        const pmPrincipal = await tx.principals.get(manager);
        if (pmPrincipal) {
          await tx.principals.update(
            { ...pmPrincipal, status: "active", version: pmPrincipal.version + 1 },
            pmPrincipal.version,
          );
        }
      });

      // 14. Replay candidate recheck: revoke candidate principal and attempt replay
      await fixture.persistence.transaction(tenant, async (tx) => {
        const candPrincipal = await tx.principals.get(memberU1);
        if (candPrincipal) {
          await tx.principals.update(
            { ...candPrincipal, status: "revoked", version: candPrincipal.version + 1 },
            candPrincipal.version,
          );
        }
      });

      await assert.rejects(
        fixture.persistence.executeAssignProjectRoleBinding(
          assignCmd({ expectedVersion: 0 }),
        ),
        (e) => e instanceof ApplicationError && e.code === "INVALID_ROLE_BINDING_CANDIDATE",
        "Replay with revoked candidate principal is rejected upon revalidation",
      );

      // Restore candidate principal
      await fixture.persistence.transaction(tenant, async (tx) => {
        const candPrincipal = await tx.principals.get(memberU1);
        if (candPrincipal) {
          await tx.principals.update(
            { ...candPrincipal, status: "active", version: candPrincipal.version + 1 },
            candPrincipal.version,
          );
        }
      });

      // 15. Security migration freeze: active migration blocks role binding writes
      await fixture.persistence.transaction(tenant, async (tx) => {
        const planned: SecurityDomainMigration = {
          id: "mig-freeze-1",
          tenantId: tenant,
          projectId,
          rootNodeId: "node-root-1",
          sourceSecurityDomainId: null,
          targetSecurityDomainId: "sd-new",
          hierarchyRevision: 1,
          sourceSecurityEpoch: 1,
          targetSecurityEpoch: 2,
          state: "planned",
          cursor: null,
          totalItems: 5,
          migratedItems: 0,
          failure: null,
          nextAttemptAtUtc: null,
          deadlineAtUtc: "2026-09-20T00:00:00.000Z",
          version: 1,
          createdAtUtc: "2026-09-15T02:20:00.000Z",
          updatedAtUtc: "2026-09-15T02:20:00.000Z",
        };
        const active = transitionSecurityMigration(planned, "active", "2026-09-15T02:20:00.000Z");
        await tx.securityMigrations.insert(planned);
        await tx.securityMigrations.saveProgressPreservingPlan(active.id, active, planned.version);
      });

      await assert.rejects(
        fixture.persistence.executeAssignProjectRoleBinding(
          assignCmd({
            commandId: "cmd-during-migration",
            idempotencyKey: "idem-during-migration",
            expectedVersion: 1,
          }),
        ),
        (e) => e instanceof ApplicationError && e.code === "SECURITY_MIGRATION_IN_PROGRESS",
        "Role binding assignment frozen during active security migration",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  // 4. Failure injection & zero partial writes
  for (const failurePoint of [
    "after_aggregate",
    "after_event",
    "after_outbox",
    "after_idempotency",
  ] as const) {
    test(`TC-SEC-004B (${engine}): Failure injection at ${failurePoint} guarantees zero partial writes`, async () => {
      const fixture = await createFixture(engine);
      try {
        await prepareIdentitiesAndSlots(fixture.persistence);

        // Record baseline counts
        let initialEventsCount = 0;
        let initialOutboxCount = 0;
        if (fixture.name === "sqlite") {
          const db = new DatabaseSync(fixture.path!);
          initialEventsCount = Number((db.prepare("SELECT COUNT(*) as c FROM domain_events WHERE tenant_id = ?").get(tenant) as any)?.c ?? 0);
          initialOutboxCount = Number((db.prepare("SELECT COUNT(*) as c FROM outbox_messages WHERE tenant_id = ?").get(tenant) as any)?.c ?? 0);
          db.close();
        } else {
          const snap = (fixture.persistence as MemoryPersistence).snapshot();
          initialEventsCount = [...snap.events.values()].filter((e) => e.tenantId === tenant).length;
          initialOutboxCount = [...snap.outbox.values()].filter((m) => m.tenantId === tenant).length;
        }

        // Execute with injected failure
        await assert.rejects(
          fixture.persistence.executeAssignProjectRoleBinding(
            assignCmd({
              commandId: `cmd-fail-${failurePoint}`,
              idempotencyKey: `idem-fail-${failurePoint}`,
            }),
            failurePoint,
          ),
          /Injected failure/,
        );

        // Verify 0 partial writes:
        // 1. Role binding not saved
        await fixture.persistence.transaction(tenant, async (tx) => {
          const binding = await tx.roleBindings.get(projectId, "reviewer_qa");
          assert.equal(binding, undefined, `Binding should NOT exist after failure at ${failurePoint}`);
        });

        // 2. Events & outbox counts unchanged
        if (fixture.name === "sqlite") {
          const db = new DatabaseSync(fixture.path!);
          const eventsCount = Number((db.prepare("SELECT COUNT(*) as c FROM domain_events WHERE tenant_id = ?").get(tenant) as any)?.c ?? 0);
          const outboxCount = Number((db.prepare("SELECT COUNT(*) as c FROM outbox_messages WHERE tenant_id = ?").get(tenant) as any)?.c ?? 0);
          const receiptsCount = Number((db.prepare("SELECT COUNT(*) as c FROM command_receipts WHERE tenant_id = ? AND idempotency_key = ?").get(tenant, `idem-fail-${failurePoint}`) as any)?.c ?? 0);
          db.close();

          assert.equal(eventsCount, initialEventsCount, `Events count drifted after failure at ${failurePoint}`);
          assert.equal(outboxCount, initialOutboxCount, `Outbox count drifted after failure at ${failurePoint}`);
          assert.equal(receiptsCount, 0, `Receipt should NOT exist after failure at ${failurePoint}`);
        } else {
          const snap = (fixture.persistence as MemoryPersistence).snapshot();
          const eventsCount = [...snap.events.values()].filter((e) => e.tenantId === tenant).length;
          const outboxCount = [...snap.outbox.values()].filter((m) => m.tenantId === tenant).length;
          const receipt = snap.receipts.get(`${tenant}\u0000${manager}\u0000assign_project_role_binding\u0000idem-fail-${failurePoint}`);

          assert.equal(eventsCount, initialEventsCount, `Events count drifted after failure at ${failurePoint}`);
          assert.equal(outboxCount, initialOutboxCount, `Outbox count drifted after failure at ${failurePoint}`);
          assert.equal(receipt, undefined, `Receipt should NOT exist after failure at ${failurePoint}`);
        }
      } finally {
        await fixture.cleanup();
      }
    });
  }
}

// 5. SQLite restart persistence
test("TC-SEC-004B (sqlite): Restart persistence preserves role slots and bindings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-restart-role-"));
  const path = join(directory, "restart.sqlite");
  try {
    const bundle1 = createTestSqliteBundle({ path });
    await prepareIdentitiesAndSlots(bundle1.persistence);
    await bundle1.persistence.executeAssignProjectRoleBinding(
      assignCmd({ expectedVersion: 0 }),
    );
    await bundle1.persistence.close();

    // Reopen with new SqlitePersistence instance
    const bundle2 = createTestSqliteBundle({ path });
    await bundle2.persistence.transaction(tenant, async (tx) => {
      const slot = await tx.roleSlots.get(projectId, "reviewer_qa");
      assert.ok(slot);
      assert.equal(slot.name, "QA 验收人");

      const binding = await tx.roleBindings.get(projectId, "reviewer_qa");
      assert.ok(binding);
      assert.equal(binding.version, 1);
      assert.deepEqual(binding.principalIds, [memberU1, memberU2]);
      assert.equal(binding.updatedByPrincipalId, manager);
    });
    await bundle2.persistence.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// 6. SQLite CAS concurrency (two connections contend on version update)
test("TC-SEC-004B (sqlite): Concurrent CAS updates guarantee exactly one winner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-cas-role-"));
  const path = join(directory, "cas.sqlite");
  try {
    const bundle = createTestSqliteBundle({ path });
    await prepareIdentitiesAndSlots(bundle.persistence);
    await bundle.persistence.executeAssignProjectRoleBinding(
      assignCmd({ expectedVersion: 0 }),
    );
    await bundle.persistence.close();

    // Open two independent persistence instances on the same SQLite file
    const connA = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5000 });
    const connB = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5000 });

    const opA = connA.executeAssignProjectRoleBinding(
      assignCmd({
        commandId: "cmd-cas-a",
        idempotencyKey: "idem-cas-a",
        principalId: manager,
        principalIds: [memberU1],
        expectedVersion: 1,
      }),
    );
    const opB = connB.executeAssignProjectRoleBinding(
      assignCmd({
        commandId: "cmd-cas-b",
        idempotencyKey: "idem-cas-b",
        principalId: altManager,
        principalIds: [memberU2],
        expectedVersion: 1,
      }),
    );

    const results = await Promise.allSettled([opA, opB]);
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    assert.equal(fulfilled.length, 1, "Exactly one concurrent update must succeed");
    assert.equal(rejected.length, 1, "The conflicting concurrent update must fail");
    assert.ok(
      rejected[0]?.reason instanceof ApplicationError && rejected[0].reason.code === "ROLE_BINDING_VERSION_CONFLICT",
      `Expected ROLE_BINDING_VERSION_CONFLICT, got: ${rejected[0]?.reason}`,
    );

    await connA.close();
    await connB.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// 7. Architectural probe / Zero raw mutator export verification
test("TC-SEC-004B ARCH-PROBE: Zero raw mutator authority exports and TransactionContext guard", async () => {
  const memoryModule = await import("../packages/adapters/src/memory/persistence.ts");
  for (const exportKey of Object.keys(memoryModule)) {
    assert.equal(
      /mutat.*role/i.test(exportKey),
      false,
      `Memory adapter must not export any role mutation authority: found ${exportKey}`,
    );
  }

  const sqliteModule = await import("../packages/adapters/src/sqlite/persistence.ts");
  for (const exportKey of Object.keys(sqliteModule)) {
    assert.equal(
      /mutat.*role/i.test(exportKey),
      false,
      `SQLite adapter must not export any role mutation authority: found ${exportKey}`,
    );
  }

  const prodModule = await import("../packages/adapters/src/sqlite/production-bundle.ts");
  for (const exportKey of Object.keys(prodModule)) {
    assert.equal(
      /mutat.*role/i.test(exportKey),
      false,
      `Production bundle must not export any role mutation authority: found ${exportKey}`,
    );
  }

  // Production bundle exposes assignProjectRoleBinding
  const prodSqliteDir = await mkdtemp(join(tmpdir(), "arch-probe-prod-role-"));
  const prodBundle = createProductionSqliteBundle({ databasePath: join(prodSqliteDir, "prod.db") });
  try {
    assert.equal(typeof prodBundle.assignProjectRoleBinding, "function");
    assert.equal((prodBundle as any).roleBindingMutations, undefined);
  } finally {
    await prodBundle.persistence.close();
    await rm(prodSqliteDir, { recursive: true, force: true });
  }

  // Verify TransactionContext has ONLY get and listByProject on roleBindings and roleSlots
  const testBundle = createTestMemoryBundle();
  try {
    await testBundle.persistence.transaction(tenant, async (tx) => {
      assert.equal(typeof tx.roleBindings.get, "function");
      assert.equal(typeof tx.roleBindings.listByProject, "function");
      assert.equal((tx.roleBindings as any).insert, undefined, "roleBindings must NOT expose raw insert");
      assert.equal((tx.roleBindings as any).update, undefined, "roleBindings must NOT expose raw update");
      assert.equal((tx.roleBindings as any).save, undefined, "roleBindings must NOT expose raw save");
      assert.equal((tx.roleBindings as any).delete, undefined, "roleBindings must NOT expose raw delete");

      assert.equal(typeof tx.roleSlots.get, "function");
      assert.equal(typeof tx.roleSlots.listByProject, "function");
      assert.equal((tx.roleSlots as any).insert, undefined, "roleSlots must NOT expose raw insert");
      assert.equal((tx.roleSlots as any).update, undefined, "roleSlots must NOT expose raw update");
      assert.equal((tx.roleSlots as any).save, undefined, "roleSlots must NOT expose raw save");
      assert.equal((tx.roleSlots as any).delete, undefined, "roleSlots must NOT expose raw delete");
    });
  } finally {
    await testBundle.persistence.close();
  }
});

// 7. Finding 1: Project role slot initialization authorization, version freezing, and write-once immutability
for (const fixtureName of ["memory", "sqlite"] as const) {
  test(`TC-SEC-004B (${fixtureName}): Finding 1 - Role slot initialization authorization, version freezing, and immutability`, async () => {
    const fixture = await createFixture(fixtureName);
    try {
      const atUtc = "2026-09-15T00:00:00.000Z";
      await grantProjectMembership(fixture.persistence, tenant, projectId, manager, { role: "project_manager" });
      await grantProjectMembership(fixture.persistence, tenant, projectId, memberU1, { role: "member" });

      // 1. TransactionContext mutation bypass prevented: tx.roleSlots has NO insert/update/save/delete
      await fixture.persistence.transaction(tenant, async (tx) => {
        assert.equal(typeof tx.roleSlots.get, "function");
        assert.equal(typeof tx.roleSlots.listByProject, "function");
        assert.equal((tx.roleSlots as any).insert, undefined, "tx.roleSlots must NOT expose insert");
        assert.equal((tx.roleSlots as any).update, undefined, "tx.roleSlots must NOT expose update");
        assert.equal((tx.roleSlots as any).save, undefined, "tx.roleSlots must NOT expose save");
        assert.equal((tx.roleSlots as any).delete, undefined, "tx.roleSlots must NOT expose delete");
      });

      // 2. Authorization: Non-PM cannot initialize role slots
      await assert.rejects(
        async () => {
          await fixture.persistence.executeInitializeProjectRoleSlots({
            tenantId: tenant,
            commandId: "cmd-init-unauth",
            idempotencyKey: "idem-init-unauth",
            principalId: memberU1,
            projectId,
            sourceTemplateVersionId: "tpl-v1",
            occurredAtUtc: atUtc,
            slots: [{ slotKey: "reviewer_qa", name: "QA", description: null }],
          });
        },
        (error: any) => error instanceof ApplicationError && error.code === "FORBIDDEN",
      );

      // 3. Active PM successfully initializes role slots
      const initResult = await fixture.persistence.executeInitializeProjectRoleSlots({
        tenantId: tenant,
        commandId: "cmd-init-pm-1",
        idempotencyKey: "idem-init-pm-1",
        principalId: manager,
        projectId,
        sourceTemplateVersionId: "tpl-v1",
        occurredAtUtc: atUtc,
        slots: [
          { slotKey: "security_auditor", name: "Security Auditor", description: "Sec audit slot" },
          { slotKey: "reviewer_qa", name: "QA Reviewer", description: "QA slot" },
        ],
      });
      assert.equal(initResult.replayed, false);
      assert.equal(initResult.slots.length, 2);
      assert.equal(initResult.slots[0]?.slotKey, "reviewer_qa"); // sorted deterministically
      assert.equal(initResult.slots[1]?.slotKey, "security_auditor");

      // 4. Same idempotency key + same payload: replayed = true
      const replayResult = await fixture.persistence.executeInitializeProjectRoleSlots({
        tenantId: tenant,
        commandId: "cmd-init-pm-1",
        idempotencyKey: "idem-init-pm-1",
        principalId: manager,
        projectId,
        sourceTemplateVersionId: "tpl-v1",
        occurredAtUtc: atUtc,
        slots: [
          { slotKey: "security_auditor", name: "Security Auditor", description: "Sec audit slot" },
          { slotKey: "reviewer_qa", name: "QA Reviewer", description: "QA slot" },
        ],
      });
      assert.equal(replayResult.replayed, true);
      assert.equal(replayResult.slots.length, 2);

      // 5. Same idempotency key + different payload: IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD
      await assert.rejects(
        async () => {
          await fixture.persistence.executeInitializeProjectRoleSlots({
            tenantId: tenant,
            commandId: "cmd-init-pm-diff",
            idempotencyKey: "idem-init-pm-1",
            principalId: manager,
            projectId,
            sourceTemplateVersionId: "tpl-v1",
            occurredAtUtc: atUtc,
            slots: [
              { slotKey: "reviewer_qa", name: "Different QA Name", description: null },
            ],
          });
        },
        (error: any) => error instanceof ApplicationError && error.code === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
      );

      // 6. Different idempotency key, but exact same slot definitions: idempotent success (replayed = false, no conflict)
      const secondCallResult = await fixture.persistence.executeInitializeProjectRoleSlots({
        tenantId: tenant,
        commandId: "cmd-init-pm-2",
        idempotencyKey: "idem-init-pm-2",
        principalId: manager,
        projectId,
        sourceTemplateVersionId: "tpl-v1",
        occurredAtUtc: atUtc,
        slots: [
          { slotKey: "reviewer_qa", name: "QA Reviewer", description: "QA slot" },
          { slotKey: "security_auditor", name: "Security Auditor", description: "Sec audit slot" },
        ],
      });
      assert.equal(secondCallResult.replayed, false);
      assert.equal(secondCallResult.slots.length, 2);

      // 7. Frozen template version: attempting to initialize with a different version fails closed
      await assert.rejects(
        async () => {
          await fixture.persistence.executeInitializeProjectRoleSlots({
            tenantId: tenant,
            commandId: "cmd-init-version-conflict",
            idempotencyKey: "idem-init-v2",
            principalId: manager,
            projectId,
            sourceTemplateVersionId: "tpl-v2",
            occurredAtUtc: atUtc,
            slots: [
              { slotKey: "reviewer_qa", name: "QA Reviewer", description: "QA slot" },
              { slotKey: "security_auditor", name: "Security Auditor", description: "Sec audit slot" },
            ],
          });
        },
        (error: any) => error instanceof ApplicationError && error.code === "ROLE_SLOT_TEMPLATE_VERSION_FROZEN",
      );

      // 8. Immutable write-once: attempting to add a new slot to existing project fails closed
      await assert.rejects(
        async () => {
          await fixture.persistence.executeInitializeProjectRoleSlots({
            tenantId: tenant,
            commandId: "cmd-init-add-slot",
            idempotencyKey: "idem-init-add",
            principalId: manager,
            projectId,
            sourceTemplateVersionId: "tpl-v1",
            occurredAtUtc: atUtc,
            slots: [
              { slotKey: "reviewer_qa", name: "QA Reviewer", description: "QA slot" },
              { slotKey: "security_auditor", name: "Security Auditor", description: "Sec audit slot" },
              { slotKey: "architect_lead", name: "Lead Architect", description: null },
            ],
          });
        },
        (error: any) => error instanceof ApplicationError && error.code === "ROLE_SLOT_IMMUTABLE_CONFLICT",
      );

      // 9. Immutable write-once: attempting to rewrite an existing slot definition fails closed
      await assert.rejects(
        async () => {
          await fixture.persistence.executeInitializeProjectRoleSlots({
            tenantId: tenant,
            commandId: "cmd-init-modify-slot",
            idempotencyKey: "idem-init-mod",
            principalId: manager,
            projectId,
            sourceTemplateVersionId: "tpl-v1",
            occurredAtUtc: atUtc,
            slots: [
              { slotKey: "reviewer_qa", name: "Modified QA Reviewer", description: "Changed" },
              { slotKey: "security_auditor", name: "Security Auditor", description: "Sec audit slot" },
            ],
          });
        },
        (error: any) => error instanceof ApplicationError && error.code === "ROLE_SLOT_IMMUTABLE_CONFLICT",
      );

      // 10. Immutable write-once: attempting to pass a subset of slots fails closed
      await assert.rejects(
        async () => {
          await fixture.persistence.executeInitializeProjectRoleSlots({
            tenantId: tenant,
            commandId: "cmd-init-subset-slot",
            idempotencyKey: "idem-init-sub",
            principalId: manager,
            projectId,
            sourceTemplateVersionId: "tpl-v1",
            occurredAtUtc: atUtc,
            slots: [
              { slotKey: "reviewer_qa", name: "QA Reviewer", description: "QA slot" },
            ],
          });
        },
        (error: any) => error instanceof ApplicationError && error.code === "ROLE_SLOT_IMMUTABLE_CONFLICT",
      );
    } finally {
      await fixture.cleanup();
    }
  });
}

// 8. Finding 2: Unicode permutation and deterministic string ordering
for (const fixtureName of ["memory", "sqlite"] as const) {
  test(`TC-SEC-004B (${fixtureName}): Finding 2 - Unicode permutation and deterministic exact string ordering`, async () => {
    const fixture = await createFixture(fixtureName);
    try {
      const atUtc = "2026-09-15T00:00:00.000Z";
      const unicodeUserA = principalId("user-\u00E9");   // é (U+00E9)
      const unicodeUserB = principalId("user-e\u0301");   // e + combining acute (U+0065 U+0301)

      await grantProjectMembership(fixture.persistence, tenant, projectId, manager, { role: "project_manager" });
      await grantProjectMembership(fixture.persistence, tenant, projectId, unicodeUserA, { role: "member" });
      await grantProjectMembership(fixture.persistence, tenant, projectId, unicodeUserB, { role: "member" });

      await fixture.persistence.executeInitializeProjectRoleSlots({
        tenantId: tenant,
        commandId: "cmd-init-unicode",
        idempotencyKey: "idem-init-unicode",
        principalId: manager,
        projectId,
        sourceTemplateVersionId: "tpl-v1",
        occurredAtUtc: atUtc,
        slots: [{ slotKey: "reviewer_qa", name: "QA Reviewer", description: null }],
      });

      // Permutation 1: [A, B]
      const sorted1 = normalizeCandidateIds([unicodeUserA, unicodeUserB]);
      // Permutation 2: [B, A]
      const sorted2 = normalizeCandidateIds([unicodeUserB, unicodeUserA]);

      assert.deepEqual(sorted1, sorted2, "normalizeCandidateIds must produce identical output regardless of input order");
      // Since 'e' (0x65) < '\u00E9' (0xE9), unicodeUserB precedes unicodeUserA in exact code unit ordering
      assert.deepEqual(sorted1, [unicodeUserB, unicodeUserA]);

      // Hashing is identical for both permutations
      const hash1 = hashRoleBindingPayload({
        projectId,
        slotKey: "reviewer_qa",
        principalIds: sorted1,
        expectedVersion: 0,
      });
      const hash2 = hashRoleBindingPayload({
        projectId,
        slotKey: "reviewer_qa",
        principalIds: sorted2,
        expectedVersion: 0,
      });
      assert.equal(hash1, hash2, "Payload hash must be identical for Unicode candidate permutations");

      // Execution with [A, B]
      const result1 = await fixture.persistence.executeAssignProjectRoleBinding({
        tenantId: tenant,
        commandId: "cmd-assign-unicode-1",
        idempotencyKey: "idem-assign-unicode",
        correlationId: "corr-u1",
        principalId: manager,
        projectId,
        slotKey: "reviewer_qa",
        principalIds: [unicodeUserA, unicodeUserB],
        expectedVersion: 0,
        occurredAtUtc: atUtc,
      });
      assert.equal(result1.replayed, false);
      assert.deepEqual(result1.binding.principalIds, [unicodeUserB, unicodeUserA]);

      // Replay with reversed input [B, A] under same idempotency key succeeds as replay
      const result2 = await fixture.persistence.executeAssignProjectRoleBinding({
        tenantId: tenant,
        commandId: "cmd-assign-unicode-1",
        idempotencyKey: "idem-assign-unicode",
        correlationId: "corr-u1",
        principalId: manager,
        projectId,
        slotKey: "reviewer_qa",
        principalIds: [unicodeUserB, unicodeUserA],
        expectedVersion: 0,
        occurredAtUtc: atUtc,
      });
      assert.equal(result2.replayed, true);
      assert.deepEqual(result2.binding.principalIds, [unicodeUserB, unicodeUserA]);
    } finally {
      await fixture.cleanup();
    }
  });
}

// 9. Finding 3: SQLite corrupt-row fail closed
test("TC-SEC-004B (sqlite): Finding 3 - Direct corrupted row fails closed on get, list, and command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-corrupt-test-"));
  const path = join(directory, "corrupt.sqlite");
  const fixture = createTestSqliteBundle({ path });
  try {
    const atUtc = "2026-09-15T00:00:00.000Z";
    await grantProjectMembership(fixture.persistence, tenant, projectId, manager, { role: "project_manager" });
    await grantProjectMembership(fixture.persistence, tenant, projectId, memberU1, { role: "member" });
    await grantProjectMembership(fixture.persistence, tenant, projectId, memberU2, { role: "member" });

    await fixture.persistence.executeInitializeProjectRoleSlots({
      tenantId: tenant,
      commandId: "cmd-init-corrupt",
      idempotencyKey: "idem-init-corrupt",
      principalId: manager,
      projectId,
      sourceTemplateVersionId: "tpl-v1",
      occurredAtUtc: atUtc,
      slots: [
        { slotKey: "reviewer_qa", name: "QA Reviewer", description: null },
        { slotKey: "security_auditor", name: "Sec Auditor", description: null },
      ],
    });

    const db = new DatabaseSync(path);

    // Corruption Case 1: Whitespace-padded candidate in principal_ids_json
    db.prepare(`
      INSERT INTO project_role_bindings (
        tenant_id, project_id, slot_key, principal_ids_json, version, updated_at_utc, updated_by_principal_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(tenant, projectId, "reviewer_qa", JSON.stringify(["  member-u1  "]), 1, atUtc, manager);

    // Read get must fail closed with ROLE_BINDING_RECORD_CORRUPT
    await assert.rejects(
      async () => {
        await fixture.persistence.read(tenant, async (tx) => {
          await tx.roleBindings.get(projectId, "reviewer_qa");
        });
      },
      (error: any) => error instanceof ApplicationError && error.code === "ROLE_BINDING_RECORD_CORRUPT",
    );

    // Read listByProject must fail closed with ROLE_BINDING_RECORD_CORRUPT
    await assert.rejects(
      async () => {
        await fixture.persistence.read(tenant, async (tx) => {
          await tx.roleBindings.listByProject(projectId);
        });
      },
      (error: any) => error instanceof ApplicationError && error.code === "ROLE_BINDING_RECORD_CORRUPT",
    );

    // Command read (reading current binding before updating) must fail closed with ROLE_BINDING_RECORD_CORRUPT
    await assert.rejects(
      async () => {
        await fixture.persistence.executeAssignProjectRoleBinding({
          tenantId: tenant,
          commandId: "cmd-assign-corrupt-pad",
          idempotencyKey: "idem-corrupt-pad",
          correlationId: "corr-cp",
          principalId: manager,
          projectId,
          slotKey: "reviewer_qa",
          principalIds: [memberU1],
          expectedVersion: 1,
          occurredAtUtc: atUtc,
        });
      },
      (error: any) => error instanceof ApplicationError && error.code === "ROLE_BINDING_RECORD_CORRUPT",
    );

    // Corruption Case 2: Duplicate candidate in principal_ids_json
    db.prepare("UPDATE project_role_bindings SET principal_ids_json = ? WHERE slot_key = ?").run(
      JSON.stringify(["member-u1", "member-u1"]),
      "reviewer_qa",
    );
    await assert.rejects(
      async () => {
        await fixture.persistence.read(tenant, async (tx) => {
          await tx.roleBindings.get(projectId, "reviewer_qa");
        });
      },
      (error: any) => error instanceof ApplicationError && error.code === "ROLE_BINDING_RECORD_CORRUPT",
    );

    // Corruption Case 3: Out-of-order candidates in principal_ids_json
    db.prepare("UPDATE project_role_bindings SET principal_ids_json = ? WHERE slot_key = ?").run(
      JSON.stringify(["member-u2", "member-u1"]),
      "reviewer_qa",
    );
    await assert.rejects(
      async () => {
        await fixture.persistence.read(tenant, async (tx) => {
          await tx.roleBindings.get(projectId, "reviewer_qa");
        });
      },
      (error: any) => error instanceof ApplicationError && error.code === "ROLE_BINDING_RECORD_CORRUPT",
    );

    // Corruption Case 4: Invalid (non-canonical UTC) updatedAtUtc
    db.prepare("UPDATE project_role_bindings SET principal_ids_json = ?, updated_at_utc = ? WHERE slot_key = ?").run(
      JSON.stringify(["member-u1"]),
      "2026-09-15 00:00:00", // invalid non-canonical timestamp
      "reviewer_qa",
    );
    await assert.rejects(
      async () => {
        await fixture.persistence.read(tenant, async (tx) => {
          await tx.roleBindings.get(projectId, "reviewer_qa");
        });
      },
      (error: any) => error instanceof ApplicationError && error.code === "ROLE_BINDING_RECORD_CORRUPT",
    );

    // Corruption Case 5: Whitespace-padded updated_by_principal_id
    db.prepare("UPDATE project_role_bindings SET updated_at_utc = ?, updated_by_principal_id = '  padded-principal  ' WHERE slot_key = ?").run(
      atUtc,
      "reviewer_qa",
    );
    await assert.rejects(
      async () => {
        await fixture.persistence.read(tenant, async (tx) => {
          await tx.roleBindings.get(projectId, "reviewer_qa");
        });
      },
      (error: any) => error instanceof ApplicationError && error.code === "ROLE_BINDING_RECORD_CORRUPT",
    );

    // Corruption Case 6: Slot corruption - invalid timestamp
    db.prepare("UPDATE project_role_slots SET created_at_utc = 'invalid-date' WHERE slot_key = 'reviewer_qa'").run();
    await assert.rejects(
      async () => {
        await fixture.persistence.read(tenant, async (tx) => {
          await tx.roleSlots.get(projectId, "reviewer_qa");
        });
      },
      (error: any) => error instanceof ApplicationError && error.code === "ROLE_SLOT_RECORD_CORRUPT",
    );
    await assert.rejects(
      async () => {
        await fixture.persistence.read(tenant, async (tx) => {
          await tx.roleSlots.listByProject(projectId);
        });
      },
      (error: any) => error instanceof ApplicationError && error.code === "ROLE_SLOT_RECORD_CORRUPT",
    );

    // Corruption Case 7: Slot corruption - whitespace-padded name
    db.prepare("UPDATE project_role_slots SET created_at_utc = ?, name = '  padded  ' WHERE slot_key = 'reviewer_qa'").run(atUtc);
    await assert.rejects(
      async () => {
        await fixture.persistence.read(tenant, async (tx) => {
          await tx.roleSlots.get(projectId, "reviewer_qa");
        });
      },
      (error: any) => error instanceof ApplicationError && error.code === "ROLE_SLOT_RECORD_CORRUPT",
    );

    db.close();
  } finally {
    await fixture.persistence.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TC-SEC-004B (memory): Finding 3 - Direct memory state corruption fails closed on get and list", async () => {
  const fixture = await createFixture("memory");
  try {
    const atUtc = "2026-09-15T00:00:00.000Z";
    await grantProjectMembership(fixture.persistence, tenant, projectId, manager, { role: "project_manager" });
    await grantProjectMembership(fixture.persistence, tenant, projectId, memberU1, { role: "member" });

    await fixture.persistence.executeInitializeProjectRoleSlots({
      tenantId: tenant,
      commandId: "cmd-mem-init",
      idempotencyKey: "idem-mem-init",
      principalId: manager,
      projectId,
      sourceTemplateVersionId: "tpl-v1",
      occurredAtUtc: atUtc,
      slots: [{ slotKey: "reviewer_qa", name: "QA", description: null }],
    });

    await fixture.persistence.executeAssignProjectRoleBinding({
      tenantId: tenant,
      commandId: "cmd-mem-bind",
      idempotencyKey: "idem-mem-bind",
      correlationId: "corr-mb",
      principalId: manager,
      projectId,
      slotKey: "reviewer_qa",
      principalIds: [memberU1],
      expectedVersion: 0,
      occurredAtUtc: atUtc,
    });

    const mem = fixture.persistence as MemoryPersistence;
    const snap = mem.snapshot();
    const bindingKey = `${tenant}\u0000${projectId}\u0000reviewer_qa`;

    // 1. Discriminator drift in role binding (detected on get)
    const bindingDrift = structuredClone(snap.roleBindings.get(bindingKey)!);
    (bindingDrift as any).projectId = "other-project-drift";
    snap.roleBindings.set(bindingKey, bindingDrift);
    const memWithDrift = new MemoryPersistence({ snapshot: snap });
    await assert.rejects(
      async () => {
        await memWithDrift.read(tenant, async (tx) => {
          await tx.roleBindings.get(projectId, "reviewer_qa");
        });
      },
      (error: any) => error instanceof ApplicationError && error.code === "ROLE_BINDING_RECORD_CORRUPT",
    );

    // 2. Corrupt candidate list (padded) in role binding (detected on listByProject)
    const snap2 = mem.snapshot();
    const bindingPadded = structuredClone(snap2.roleBindings.get(bindingKey)!);
    (bindingPadded as any).principalIds = ["  member-u1  "];
    snap2.roleBindings.set(bindingKey, bindingPadded);
    const memWithPadded = new MemoryPersistence({ snapshot: snap2 });
    await assert.rejects(
      async () => {
        await memWithPadded.read(tenant, async (tx) => {
          await tx.roleBindings.listByProject(projectId);
        });
      },
      (error: any) => error instanceof ApplicationError && error.code === "ROLE_BINDING_RECORD_CORRUPT",
    );

    // 3. Non-positive version in role binding
    const bindingZeroVer = structuredClone(snap.roleBindings.get(bindingKey)!);
    (bindingZeroVer as any).version = 0;
    snap.roleBindings.set(bindingKey, bindingZeroVer);
    const memWithZeroVer = new MemoryPersistence({ snapshot: snap });
    await assert.rejects(
      async () => {
        await memWithZeroVer.read(tenant, async (tx) => {
          await tx.roleBindings.get(projectId, "reviewer_qa");
        });
      },
      (error: any) => error instanceof ApplicationError && error.code === "ROLE_BINDING_RECORD_CORRUPT",
    );

    // 3. Discriminator drift in role slot
    const slotKey = `${tenant}\u0000${projectId}\u0000reviewer_qa`;
    const slotDrift = structuredClone(snap.roleSlots.get(slotKey)!);
    (slotDrift as any).slotKey = "other-slot-drift";
    snap.roleSlots.set(slotKey, slotDrift);
    const memWithSlotDrift = new MemoryPersistence({ snapshot: snap });
    await assert.rejects(
      async () => {
        await memWithSlotDrift.read(tenant, async (tx) => {
          await tx.roleSlots.get(projectId, "reviewer_qa");
        });
      },
      (error: any) => error instanceof ApplicationError && error.code === "ROLE_SLOT_RECORD_CORRUPT",
    );
  } finally {
    await fixture.cleanup();
  }
});

// 10. Finding 4: Memory receipt key verification
test("TC-SEC-004B (memory): Finding 4 - Memory receipt key structure uses \\u0000 separators and is verifiable", async () => {
  const fixture = await createFixture("memory");
  try {
    await prepareIdentitiesAndSlots(fixture.persistence);
    const atUtc = "2026-09-15T00:00:00.000Z";
    const idemKey = "idem-receipt-format-test";

    const result = await fixture.persistence.executeAssignProjectRoleBinding({
      tenantId: tenant,
      commandId: "cmd-rcpt-test",
      idempotencyKey: idemKey,
      correlationId: "corr-rcpt",
      principalId: manager,
      projectId,
      slotKey: "reviewer_qa",
      principalIds: [memberU1],
      expectedVersion: 0,
      occurredAtUtc: atUtc,
    });
    assert.equal(result.replayed, false);

    const snap = (fixture.persistence as MemoryPersistence).snapshot();
    const correctKey = `${tenant}\u0000${manager}\u0000assign_project_role_binding\u0000${idemKey}`;
    const wrongColonKey = `${tenant}:${manager}:assign_project_role_binding:${idemKey}`;

    // Verify correct \u0000 key finds the receipt
    const storedReceipt = snap.receipts.get(correctKey);
    assert.notEqual(storedReceipt, undefined, "Receipt must be retrievable by \\u0000 separated key");
    assert.equal(storedReceipt?.scope.idempotencyKey, idemKey);

    // Verify wrong colon key does NOT find the receipt
    assert.equal(snap.receipts.get(wrongColonKey), undefined, "Colon key must not match receipt key");
  } finally {
    await fixture.cleanup();
  }
});

// 11. Finding 5: List ordering parity between Memory and SQLite
test("TC-SEC-004B (parity): Finding 5 - listByProject returns identical deterministic slot-key ordering on Memory and SQLite", async () => {
  const memFixture = await createFixture("memory");
  const sqliteFixture = await createFixture("sqlite");
  try {
    const atUtc = "2026-09-15T00:00:00.000Z";
    const slotKeysToInsert = [
      { slotKey: "zeta_slot", name: "Zeta Slot", description: null },
      { slotKey: "alpha_slot", name: "Alpha Slot", description: null },
      { slotKey: "mu_slot", name: "Mu Slot", description: null },
      { slotKey: "beta_slot", name: "Beta Slot", description: null },
    ];

    for (const f of [memFixture, sqliteFixture]) {
      await grantProjectMembership(f.persistence, tenant, projectId, manager, { role: "project_manager" });
      await grantProjectMembership(f.persistence, tenant, projectId, memberU1, { role: "member" });
      await f.persistence.executeInitializeProjectRoleSlots({
        tenantId: tenant,
        commandId: "cmd-parity-init",
        idempotencyKey: "idem-parity-init",
        principalId: manager,
        projectId,
        sourceTemplateVersionId: "tpl-v1",
        occurredAtUtc: atUtc,
        slots: slotKeysToInsert,
      });
      // Assign two bindings
      await f.persistence.executeAssignProjectRoleBinding({
        tenantId: tenant,
        commandId: "cmd-bind-zeta",
        idempotencyKey: "idem-bind-zeta",
        correlationId: "corr-z",
        principalId: manager,
        projectId,
        slotKey: "zeta_slot",
        principalIds: [memberU1],
        expectedVersion: 0,
        occurredAtUtc: atUtc,
      });
      await f.persistence.executeAssignProjectRoleBinding({
        tenantId: tenant,
        commandId: "cmd-bind-alpha",
        idempotencyKey: "idem-bind-alpha",
        correlationId: "corr-a",
        principalId: manager,
        projectId,
        slotKey: "alpha_slot",
        principalIds: [memberU1],
        expectedVersion: 0,
        occurredAtUtc: atUtc,
      });
    }

    const memSlots = await memFixture.persistence.read(tenant, (tx) => tx.roleSlots.listByProject(projectId));
    const sqliteSlots = await sqliteFixture.persistence.read(tenant, (tx) => tx.roleSlots.listByProject(projectId));

    const expectedSlotOrder = ["alpha_slot", "beta_slot", "mu_slot", "zeta_slot"];
    assert.deepEqual(memSlots.map((s) => s.slotKey), expectedSlotOrder);
    assert.deepEqual(sqliteSlots.map((s) => s.slotKey), expectedSlotOrder);
    assert.deepEqual(memSlots.map((s) => s.slotKey), sqliteSlots.map((s) => s.slotKey));

    const memBindings = await memFixture.persistence.read(tenant, (tx) => tx.roleBindings.listByProject(projectId));
    const sqliteBindings = await sqliteFixture.persistence.read(tenant, (tx) => tx.roleBindings.listByProject(projectId));

    const expectedBindingOrder = ["alpha_slot", "zeta_slot"];
    assert.deepEqual(memBindings.map((b) => b.slotKey), expectedBindingOrder);
    assert.deepEqual(sqliteBindings.map((b) => b.slotKey), expectedBindingOrder);
    assert.deepEqual(memBindings.map((b) => b.slotKey), sqliteBindings.map((b) => b.slotKey));
  } finally {
    await memFixture.cleanup();
    await sqliteFixture.cleanup();
  }
});

// ============================================================================
// CYCLE 2 REWORK TESTS
// ============================================================================

// Finding 1: Atomic initialization chain, payload hygiene, failure injection (Memory and SQLite)
for (const engine of ["memory", "sqlite"] as const) {
  test(`TC-SEC-004B (${engine}): Cycle 2 Finding 1 - Atomic initialization writes state, audit, event, outbox, receipt`, async () => {
    const fixture = await createFixture(engine);
    try {
      const atUtc = "2026-09-15T00:00:00.000Z";
      const pId = `proj-atomic-${engine}`;
      await grantProjectMembership(fixture.persistence, tenant, pId, manager, { role: "project_manager" });

      const result = await fixture.persistence.executeInitializeProjectRoleSlots({
        tenantId: tenant,
        commandId: `cmd-atomic-init-${engine}`,
        idempotencyKey: `idem-atomic-init-${engine}`,
        correlationId: "corr-atomic",
        principalId: manager,
        projectId: pId,
        sourceTemplateVersionId: "tpl-v1",
        occurredAtUtc: atUtc,
        slots: [
          { slotKey: "reviewer_qa", name: "QA Reviewer", description: "QA desc" },
          { slotKey: "reviewer_sec", name: "Security Reviewer", description: "Sec desc" },
        ],
      });

      assert.equal(result.replayed, false);
      assert.equal(result.snapshot.projectId, pId);
      assert.equal(result.snapshot.sourceTemplateVersionId, "tpl-v1");
      assert.equal(result.slots.length, 2);

      // Verify minimal registered event & public payload hygiene (no names, no descriptions, no snapshots)
      assert.equal(result.event.eventType, "project-map.role-slots.initialized");
      assert.equal(result.event.schemaVersion, 1);
      assert.deepEqual(result.event.payload, {
        projectId: pId,
        sourceTemplateVersionId: "tpl-v1",
        slotKeys: ["reviewer_qa", "reviewer_sec"],
      });
      assert.equal("name" in result.event.payload, false, "Event payload must not contain slot names");
      assert.equal("description" in result.event.payload, false, "Event payload must not contain slot descriptions");
      assert.equal("snapshot" in result.event.payload, false, "Event payload must not contain sensitive snapshot details");

      // Verify outbox
      assert.equal(result.outbox.topic, "project-map.role-slots.initialized.v1");
      assert.equal(result.outbox.eventId, result.event.eventId);

      // Verify audit evidence
      assert.equal(result.audit.action, "initialized");
      assert.deepEqual(result.audit.slotKeys, ["reviewer_qa", "reviewer_sec"]);
      assert.equal(result.audit.actorPrincipalId, manager);

      // Verify persisted audit entry via repository
      const audits = await fixture.persistence.read(tenant, (tx) => tx.roleSlotAudits.listByProject(pId));
      assert.equal(audits.length, 1);
      assert.equal(audits[0]?.id, `audit:cmd-atomic-init-${engine}`);
    } finally {
      await fixture.cleanup();
    }
  });

  const failurePoints = [
    "after_state",
    "after_audit",
    "after_event",
    "after_outbox",
    "after_idempotency",
  ] as const;

  for (const fp of failurePoints) {
    test(`TC-SEC-004B (${engine}): Cycle 2 Finding 1 - Failure injection at ${fp} guarantees zero partial writes and sequence rollback`, async () => {
      const fixture = await createFixture(engine);
      try {
        const atUtc = "2026-09-15T00:00:00.000Z";
        const pId = `proj-fail-${fp}-${engine}`;
        await grantProjectMembership(fixture.persistence, tenant, pId, manager, { role: "project_manager" });

        const seqBefore = await fixture.persistence.read(tenant, (tx) => tx.sequences.current(pId));
        assert.equal(seqBefore, 0);

        await assert.rejects(
          async () => {
            await fixture.persistence.executeInitializeProjectRoleSlots(
              {
                tenantId: tenant,
                commandId: `cmd-fail-${fp}`,
                idempotencyKey: `idem-fail-${fp}`,
                correlationId: "corr-fail",
                principalId: manager,
                projectId: pId,
                sourceTemplateVersionId: "tpl-v1",
                occurredAtUtc: atUtc,
                slots: [
                  { slotKey: "reviewer_qa", name: "QA Reviewer", description: null },
                ],
              },
              fp,
            );
          },
          (error: any) => error instanceof Error && error.message.includes(`Injected failure: ${fp}`),
        );

        // Verify zero partial writes and sequence rollback
        await fixture.persistence.read(tenant, async (tx) => {
          const snapshot = await tx.roleSlots.getSnapshot(pId);
          assert.equal(snapshot, undefined, `Snapshot must not be written on failure at ${fp}`);

          const slots = await tx.roleSlots.listByProject(pId);
          assert.equal(slots.length, 0, `Slots must not be written on failure at ${fp}`);

          const audits = await tx.roleSlotAudits.listByProject(pId);
          assert.equal(audits.length, 0, `Audits must not be written on failure at ${fp}`);

          const receipt = await tx.receipts.get({
            principalId: manager,
            operation: "initialize_project_role_slots",
            idempotencyKey: `idem-fail-${fp}`,
          });
          assert.equal(receipt, undefined, `Receipt must not be written on failure at ${fp}`);

          const seqAfter = await tx.sequences.current(pId);
          assert.equal(seqAfter, 0, `Project sequence must be rolled back on failure at ${fp}`);
        });
      } finally {
        await fixture.cleanup();
      }
    });
  }
}

// Finding 2: Empty slots [] durable snapshot marker, version freeze, non-identical rejection, restart
for (const engine of ["memory", "sqlite"] as const) {
  test(`TC-SEC-004B (${engine}): Cycle 2 Finding 2 - Empty slots initialization creates durable marker and freezes template version`, async () => {
    const fixture = await createFixture(engine);
    try {
      const atUtc = "2026-09-15T00:00:00.000Z";
      const pId = `proj-empty-${engine}`;
      await grantProjectMembership(fixture.persistence, tenant, pId, manager, { role: "project_manager" });

      // 1. Initializing with slots: [] creates durable snapshot marker
      const emptyResult = await fixture.persistence.executeInitializeProjectRoleSlots({
        tenantId: tenant,
        commandId: "cmd-init-empty",
        idempotencyKey: "idem-init-empty",
        principalId: manager,
        projectId: pId,
        sourceTemplateVersionId: "tpl-v1",
        occurredAtUtc: atUtc,
        slots: [],
      });
      assert.equal(emptyResult.replayed, false);
      assert.equal(emptyResult.slots.length, 0);
      assert.equal(emptyResult.snapshot.sourceTemplateVersionId, "tpl-v1");

      const marker = await fixture.persistence.read(tenant, (tx) => tx.roleSlots.getSnapshot(pId));
      assert.notEqual(marker, undefined, "Snapshot marker must exist even when slots is empty");
      assert.equal(marker?.sourceTemplateVersionId, "tpl-v1");

      // 2. Later initialization with v2 must fail closed
      await assert.rejects(
        async () => {
          await fixture.persistence.executeInitializeProjectRoleSlots({
            tenantId: tenant,
            commandId: "cmd-init-switch",
            idempotencyKey: "idem-init-switch",
            principalId: manager,
            projectId: pId,
            sourceTemplateVersionId: "tpl-v2",
            occurredAtUtc: atUtc,
            slots: [],
          });
        },
        (error: any) => error instanceof ApplicationError && error.code === "ROLE_SLOT_TEMPLATE_VERSION_FROZEN",
      );

      // 3. Later initialization with v1 but non-empty slots must fail closed (cannot mutate frozen empty snapshot)
      await assert.rejects(
        async () => {
          await fixture.persistence.executeInitializeProjectRoleSlots({
            tenantId: tenant,
            commandId: "cmd-init-nonempty",
            idempotencyKey: "idem-init-nonempty",
            principalId: manager,
            projectId: pId,
            sourceTemplateVersionId: "tpl-v1",
            occurredAtUtc: atUtc,
            slots: [{ slotKey: "qa", name: "QA", description: null }],
          });
        },
        (error: any) => error instanceof ApplicationError && error.code === "ROLE_SLOT_IMMUTABLE_CONFLICT",
      );

      // 4. Exact idempotent replay of empty initialization succeeds
      const replayResult = await fixture.persistence.executeInitializeProjectRoleSlots({
        tenantId: tenant,
        commandId: "cmd-init-empty",
        idempotencyKey: "idem-init-empty",
        principalId: manager,
        projectId: pId,
        sourceTemplateVersionId: "tpl-v1",
        occurredAtUtc: atUtc,
        slots: [],
      });
      assert.equal(replayResult.replayed, true);
      assert.equal(replayResult.slots.length, 0);
      assert.equal(replayResult.snapshot.sourceTemplateVersionId, "tpl-v1");
    } finally {
      await fixture.cleanup();
    }
  });
}

test("TC-SEC-004B (sqlite): Cycle 2 Finding 2 - Restart persistence preserves empty snapshot marker and freezes version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-role-restart-empty-"));
  const path = join(directory, "empty-restart.sqlite");
  try {
    const atUtc = "2026-09-15T00:00:00.000Z";
    const pId = "proj-restart-empty";

    // Session 1: initialize empty slots
    const bundle1 = createTestSqliteBundle({ path });
    await grantProjectMembership(bundle1.persistence, tenant, pId, manager, { role: "project_manager" });
    await bundle1.initializeProjectRoleSlots({
      tenantId: tenant,
      commandId: "cmd-empty-restart-1",
      idempotencyKey: "idem-empty-restart-1",
      principalId: manager,
      projectId: pId,
      sourceTemplateVersionId: "tpl-v1",
      occurredAtUtc: atUtc,
      slots: [],
    });
    await bundle1.persistence.close();

    // Session 2: reopen database and verify frozen snapshot marker persists
    const bundle2 = createTestSqliteBundle({ path });
    const snapshot = await bundle2.persistence.read(tenant, (tx) => tx.roleSlots.getSnapshot(pId));
    assert.notEqual(snapshot, undefined);
    assert.equal(snapshot?.sourceTemplateVersionId, "tpl-v1");

    // Switching template version fails closed across restart
    await assert.rejects(
      async () => {
        await bundle2.initializeProjectRoleSlots({
          tenantId: tenant,
          commandId: "cmd-empty-restart-2",
          idempotencyKey: "idem-empty-restart-2",
          principalId: manager,
          projectId: pId,
          sourceTemplateVersionId: "tpl-v2",
          occurredAtUtc: atUtc,
          slots: [],
        });
      },
      (error: any) => error instanceof ApplicationError && error.code === "ROLE_SLOT_TEMPLATE_VERSION_FROZEN",
    );
    await bundle2.persistence.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Finding 3: Memory Map authoritative key validation vs silent filtering
test("TC-SEC-004B (memory): Cycle 2 Finding 3 - Memory Map storage key validation fails closed on discriminator drift", async () => {
  const fixture = await createFixture("memory");
  try {
    await prepareIdentitiesAndSlots(fixture.persistence);
    const snap = (fixture.persistence as MemoryPersistence).snapshot();

    // 1. Discriminator drift in roleBindings
    // Map key says projectId is "project-role-test", but object has projectId "other-project"
    const keyBinding = `${tenant}\u0000${projectId}\u0000reviewer_qa`;
    (snap.roleBindings as any).set(keyBinding, {
      tenantId: tenant,
      projectId: "other-project", // DRIFT!
      slotKey: "reviewer_qa",
      principalIds: [memberU1],
      version: 1,
      updatedAtUtc: "2026-09-15T00:00:00.000Z",
      updatedByPrincipalId: manager,
    });

    const memWithDrift = new MemoryPersistence({ snapshot: snap });
    // listByProject must NOT silently filter out; it must detect discriminator drift and throw ROLE_BINDING_RECORD_CORRUPT
    await assert.rejects(
      async () => {
        await memWithDrift.read(tenant, (tx) => tx.roleBindings.listByProject(projectId));
      },
      (error: any) => error instanceof ApplicationError && error.code === "ROLE_BINDING_RECORD_CORRUPT",
    );
    await assert.rejects(
      async () => {
        await memWithDrift.read(tenant, (tx) => tx.roleBindings.get(projectId, "reviewer_qa"));
      },
      (error: any) => error instanceof ApplicationError && error.code === "ROLE_BINDING_RECORD_CORRUPT",
    );

    // 2. Discriminator drift in roleSlots
    const keySlot = `${tenant}\u0000${projectId}\u0000reviewer_qa`;
    (snap.roleSlots as any).set(keySlot, {
      tenantId: tenant,
      projectId: "other-project", // DRIFT!
      slotKey: "reviewer_qa",
      sourceTemplateVersionId: "tpl-v1",
      name: "QA",
      description: null,
      createdAtUtc: "2026-09-15T00:00:00.000Z",
    });

    const memWithSlotDrift = new MemoryPersistence({ snapshot: snap });
    await assert.rejects(
      async () => {
        await memWithSlotDrift.read(tenant, (tx) => tx.roleSlots.listByProject(projectId));
      },
      (error: any) => error instanceof ApplicationError && error.code === "ROLE_SLOT_RECORD_CORRUPT",
    );
    await assert.rejects(
      async () => {
        await memWithSlotDrift.read(tenant, (tx) => tx.roleSlots.get(projectId, "reviewer_qa"));
      },
      (error: any) => error instanceof ApplicationError && error.code === "ROLE_SLOT_RECORD_CORRUPT",
    );
  } finally {
    await fixture.cleanup();
  }
});

// Finding 4: Authoritative state validation before receipt replay
for (const engine of ["memory", "sqlite"] as const) {
  test(`TC-SEC-004B (${engine}): Cycle 2 Finding 4 - Corrupted state fails closed on binding receipt replay`, async () => {
    const fixture = await createFixture(engine);
    try {
      await prepareIdentitiesAndSlots(fixture.persistence);
      const atUtc = "2026-09-15T00:00:00.000Z";
      const idemKey = `idem-replay-corrupt-binding-${engine}`;

      // 1. Successful binding assignment
      const initResult = await fixture.persistence.executeAssignProjectRoleBinding({
        tenantId: tenant,
        commandId: "cmd-bind-orig",
        idempotencyKey: idemKey,
        correlationId: "corr-1",
        principalId: manager,
        projectId,
        slotKey: "reviewer_qa",
        principalIds: [memberU1],
        expectedVersion: 0,
        occurredAtUtc: atUtc,
      });
      assert.equal(initResult.replayed, false);

      // 2. Exact canonical replay succeeds
      const goodReplay = await fixture.persistence.executeAssignProjectRoleBinding({
        tenantId: tenant,
        commandId: "cmd-bind-orig",
        idempotencyKey: idemKey,
        correlationId: "corr-1",
        principalId: manager,
        projectId,
        slotKey: "reviewer_qa",
        principalIds: [memberU1],
        expectedVersion: 0,
        occurredAtUtc: atUtc,
      });
      assert.equal(goodReplay.replayed, true);

      // 3. Corrupt the authoritative binding record
      if (engine === "memory") {
        const snap = (fixture.persistence as MemoryPersistence).snapshot();
        const key = `${tenant}\u0000${projectId}\u0000reviewer_qa`;
        (snap.roleBindings as any).set(key, {
          ...snap.roleBindings.get(key)!,
          updatedAtUtc: "invalid-timestamp",
        });
        const corruptedMem = new MemoryPersistence({ snapshot: snap });
        await assert.rejects(
          async () => {
            await corruptedMem.executeAssignProjectRoleBinding({
              tenantId: tenant,
              commandId: "cmd-bind-orig",
              idempotencyKey: idemKey,
              correlationId: "corr-1",
              principalId: manager,
              projectId,
              slotKey: "reviewer_qa",
              principalIds: [memberU1],
              expectedVersion: 0,
              occurredAtUtc: atUtc,
            });
          },
          (error: any) => error instanceof ApplicationError && error.code === "ROLE_BINDING_RECORD_CORRUPT",
        );
      } else {
        const db = new DatabaseSync((fixture as any).path);
        db.prepare(`
          UPDATE project_role_bindings
          SET updated_at_utc = 'invalid-timestamp'
          WHERE tenant_id = ? AND project_id = ? AND slot_key = ?
        `).run(tenant, projectId, "reviewer_qa");
        db.close();

        await assert.rejects(
          async () => {
            await fixture.persistence.executeAssignProjectRoleBinding({
              tenantId: tenant,
              commandId: "cmd-bind-orig",
              idempotencyKey: idemKey,
              correlationId: "corr-1",
              principalId: manager,
              projectId,
              slotKey: "reviewer_qa",
              principalIds: [memberU1],
              expectedVersion: 0,
              occurredAtUtc: atUtc,
            });
          },
          (error: any) => error instanceof ApplicationError && error.code === "ROLE_BINDING_RECORD_CORRUPT",
        );
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test(`TC-SEC-004B (${engine}): Cycle 2 Finding 4 - Corrupted state fails closed on initialization receipt replay`, async () => {
    const fixture = await createFixture(engine);
    try {
      const atUtc = "2026-09-15T00:00:00.000Z";
      const pId = `proj-replay-init-${engine}`;
      const idemKey = `idem-init-replay-${engine}`;
      await grantProjectMembership(fixture.persistence, tenant, pId, manager, { role: "project_manager" });

      // 1. Initialize role slots
      const initResult = await fixture.persistence.executeInitializeProjectRoleSlots({
        tenantId: tenant,
        commandId: "cmd-init-replay-orig",
        idempotencyKey: idemKey,
        principalId: manager,
        projectId: pId,
        sourceTemplateVersionId: "tpl-v1",
        occurredAtUtc: atUtc,
        slots: [{ slotKey: "reviewer_qa", name: "QA Reviewer", description: null }],
      });
      assert.equal(initResult.replayed, false);

      // 2. Canonical replay succeeds
      const goodReplay = await fixture.persistence.executeInitializeProjectRoleSlots({
        tenantId: tenant,
        commandId: "cmd-init-replay-orig",
        idempotencyKey: idemKey,
        principalId: manager,
        projectId: pId,
        sourceTemplateVersionId: "tpl-v1",
        occurredAtUtc: atUtc,
        slots: [{ slotKey: "reviewer_qa", name: "QA Reviewer", description: null }],
      });
      assert.equal(goodReplay.replayed, true);

      // 3. Corrupt snapshot marker
      if (engine === "memory") {
        const snap = (fixture.persistence as MemoryPersistence).snapshot();
        const key = `${tenant}\u0000${pId}`;
        (snap.roleSlotSnapshots as any).set(key, {
          ...snap.roleSlotSnapshots.get(key)!,
          createdAtUtc: "invalid-timestamp",
        });
        const corruptedMem = new MemoryPersistence({ snapshot: snap });
        await assert.rejects(
          async () => {
            await corruptedMem.executeInitializeProjectRoleSlots({
              tenantId: tenant,
              commandId: "cmd-init-replay-orig",
              idempotencyKey: idemKey,
              principalId: manager,
              projectId: pId,
              sourceTemplateVersionId: "tpl-v1",
              occurredAtUtc: atUtc,
              slots: [{ slotKey: "reviewer_qa", name: "QA Reviewer", description: null }],
            });
          },
          (error: any) => error instanceof ApplicationError && error.code === "ROLE_SLOT_RECORD_CORRUPT",
        );
      } else {
        const db = new DatabaseSync((fixture as any).path);
        db.prepare(`
          UPDATE project_role_slot_snapshots
          SET created_at_utc = 'invalid-timestamp'
          WHERE tenant_id = ? AND project_id = ?
        `).run(tenant, pId);
        db.close();

        await assert.rejects(
          async () => {
            await fixture.persistence.executeInitializeProjectRoleSlots({
              tenantId: tenant,
              commandId: "cmd-init-replay-orig",
              idempotencyKey: idemKey,
              principalId: manager,
              projectId: pId,
              sourceTemplateVersionId: "tpl-v1",
              occurredAtUtc: atUtc,
              slots: [{ slotKey: "reviewer_qa", name: "QA Reviewer", description: null }],
            });
          },
          (error: any) => error instanceof ApplicationError && error.code === "ROLE_SLOT_RECORD_CORRUPT",
        );
      }
    } finally {
      await fixture.cleanup();
    }
  });
}

// =========================================================================
// Cycle 3 Findings
// =========================================================================

// Finding 1: Historical binding replay succeeds after version advances
for (const engine of ["memory", "sqlite"] as const) {
  test(`TC-SEC-004B (${engine}): Cycle 3 Finding 1 - Historical binding replay succeeds after version advances`, async () => {
    const fixture = await createFixture(engine);
    try {
      await prepareIdentitiesAndSlots(fixture.persistence);
      const atUtc1 = "2026-09-15T01:00:00.000Z";
      const atUtc2 = "2026-09-15T02:00:00.000Z";
      const atUtc3 = "2026-09-15T03:00:00.000Z";

      // 1. Initial assignment v1: [memberU1]
      const v1Result = await fixture.persistence.executeAssignProjectRoleBinding(
        assignCmd({
          commandId: "cmd-v1",
          idempotencyKey: "idem-v1",
          principalIds: [memberU1],
          expectedVersion: 0,
          occurredAtUtc: atUtc1,
        }),
      );
      assert.equal(v1Result.replayed, false);
      assert.equal(v1Result.binding.version, 1);
      assert.deepEqual(v1Result.binding.principalIds, [memberU1]);

      // 2. Advance to v2: [memberU2]
      const v2Result = await fixture.persistence.executeAssignProjectRoleBinding(
        assignCmd({
          commandId: "cmd-v2",
          idempotencyKey: "idem-v2",
          principalId: altManager,
          principalIds: [memberU2],
          expectedVersion: 1,
          occurredAtUtc: atUtc2,
        }),
      );
      assert.equal(v2Result.replayed, false);
      assert.equal(v2Result.binding.version, 2);
      assert.deepEqual(v2Result.binding.principalIds, [memberU2]);

      // 3. Replay exact original v1 command while authoritative state is at v2
      // Authoritative state has version 2 >= 1. Receipt has version 1.
      // Historical replay must succeed and return v1 receipt result.
      const v1Replay = await fixture.persistence.executeAssignProjectRoleBinding(
        assignCmd({
          commandId: "cmd-v1",
          idempotencyKey: "idem-v1",
          principalIds: [memberU1],
          expectedVersion: 0,
          occurredAtUtc: atUtc1,
        }),
      );
      assert.equal(v1Replay.replayed, true);
      assert.equal(v1Replay.binding.version, 1);
      assert.deepEqual(v1Replay.binding.principalIds, [memberU1]);
      assert.equal(v1Replay.binding.updatedByPrincipalId, manager);

      // 4. Advance to v3: []
      const v3Result = await fixture.persistence.executeAssignProjectRoleBinding(
        assignCmd({
          commandId: "cmd-v3",
          idempotencyKey: "idem-v3",
          principalId: manager,
          principalIds: [],
          expectedVersion: 2,
          occurredAtUtc: atUtc3,
        }),
      );
      assert.equal(v3Result.replayed, false);
      assert.equal(v3Result.binding.version, 3);

      // Replay of v1 and v2 both still succeed
      const v1ReplayAfterV3 = await fixture.persistence.executeAssignProjectRoleBinding(
        assignCmd({
          commandId: "cmd-v1",
          idempotencyKey: "idem-v1",
          principalIds: [memberU1],
          expectedVersion: 0,
          occurredAtUtc: atUtc1,
        }),
      );
      assert.equal(v1ReplayAfterV3.replayed, true);
      assert.equal(v1ReplayAfterV3.binding.version, 1);

      const v2ReplayAfterV3 = await fixture.persistence.executeAssignProjectRoleBinding(
        assignCmd({
          commandId: "cmd-v2",
          idempotencyKey: "idem-v2",
          principalId: altManager,
          principalIds: [memberU2],
          expectedVersion: 1,
          occurredAtUtc: atUtc2,
        }),
      );
      assert.equal(v2ReplayAfterV3.replayed, true);
      assert.equal(v2ReplayAfterV3.binding.version, 2);

      // 5. If authoritative binding is corrupted, historical replay must fail closed
      if (engine === "memory") {
        const snap = (fixture.persistence as MemoryPersistence).snapshot();
        const key = `${tenant}\u0000${projectId}\u0000reviewer_qa`;
        (snap.roleBindings as any).set(key, {
          ...snap.roleBindings.get(key)!,
          updatedAtUtc: "invalid-time",
        });
        const corruptedMem = new MemoryPersistence({ snapshot: snap });
        await assert.rejects(
          corruptedMem.executeAssignProjectRoleBinding(
            assignCmd({
              commandId: "cmd-v1",
              idempotencyKey: "idem-v1",
              principalIds: [memberU1],
              expectedVersion: 0,
              occurredAtUtc: atUtc1,
            }),
          ),
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_BINDING_RECORD_CORRUPT",
        );
      } else {
        const db = new DatabaseSync((fixture as any).path);
        db.prepare(`
          UPDATE project_role_bindings
          SET updated_at_utc = 'invalid-time'
          WHERE tenant_id = ? AND project_id = ? AND slot_key = ?
        `).run(tenant, projectId, "reviewer_qa");
        db.close();

        await assert.rejects(
          fixture.persistence.executeAssignProjectRoleBinding(
            assignCmd({
              commandId: "cmd-v1",
              idempotencyKey: "idem-v1",
              principalIds: [memberU1],
              expectedVersion: 0,
              occurredAtUtc: atUtc1,
            }),
          ),
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_BINDING_RECORD_CORRUPT",
        );
      }
    } finally {
      await fixture.cleanup();
    }
  });

  // Finding 2: Complete replay coherence (divergent/corrupted receipt event or outbox)
  test(`TC-SEC-004B (${engine}): Cycle 3 Finding 2 - Binding receipt with corrupted/divergent event or outbox fails closed`, async () => {
    const fixture = await createFixture(engine);
    try {
      await prepareIdentitiesAndSlots(fixture.persistence);
      const atUtc = "2026-09-15T01:00:00.000Z";
      const idemKey = `idem-coherent-bind-${engine}`;

      await fixture.persistence.executeAssignProjectRoleBinding(
        assignCmd({
          commandId: "cmd-coherent-bind-1",
          idempotencyKey: idemKey,
          principalIds: [memberU1],
          expectedVersion: 0,
          occurredAtUtc: atUtc,
        }),
      );

      // Mutate receipt in storage to have corrupted event
      if (engine === "memory") {
        const snap = (fixture.persistence as MemoryPersistence).snapshot();
        const rKey = `${tenant}\u0000${manager}\u0000assign_project_role_binding\u0000${idemKey}`;
        const prevReceipt = snap.receipts.get(rKey)!;
        const prevResult = prevReceipt.result as any;

        // Subcase A: Corrupted event sequence in receipt
        const corruptedReceiptA = {
          ...prevReceipt,
          result: {
            ...prevResult,
            event: { ...prevResult.event, projectSequence: -5 },
          },
        };
        snap.receipts.set(rKey, corruptedReceiptA);
        const memA = new MemoryPersistence({ snapshot: snap });
        await assert.rejects(
          memA.executeAssignProjectRoleBinding(
            assignCmd({
              commandId: "cmd-coherent-bind-1",
              idempotencyKey: idemKey,
              principalIds: [memberU1],
              expectedVersion: 0,
              occurredAtUtc: atUtc,
            }),
          ),
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_BINDING_RECORD_CORRUPT",
        );

        // Subcase B: Outbox eventId mismatch in receipt
        const corruptedReceiptB = {
          ...prevReceipt,
          result: {
            ...prevResult,
            outbox: { ...prevResult.outbox, eventId: "different-event-id" },
          },
        };
        snap.receipts.set(rKey, corruptedReceiptB);
        const memB = new MemoryPersistence({ snapshot: snap });
        await assert.rejects(
          memB.executeAssignProjectRoleBinding(
            assignCmd({
              commandId: "cmd-coherent-bind-1",
              idempotencyKey: idemKey,
              principalIds: [memberU1],
              expectedVersion: 0,
              occurredAtUtc: atUtc,
            }),
          ),
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_BINDING_RECORD_CORRUPT",
        );
      } else {
        const db = new DatabaseSync((fixture as any).path);
        const row = db.prepare(`
          SELECT result_json FROM command_receipts
          WHERE tenant_id = ? AND principal_id = ? AND operation = 'assign_project_role_binding' AND idempotency_key = ?
        `).get(tenant, manager, idemKey) as { result_json: string };
        const result = JSON.parse(row.result_json);

        // Subcase A: Corrupted event sequence
        const corruptedResultA = { ...result, event: { ...result.event, projectSequence: -5 } };
        db.prepare(`
          UPDATE command_receipts SET result_json = ?
          WHERE tenant_id = ? AND principal_id = ? AND operation = 'assign_project_role_binding' AND idempotency_key = ?
        `).run(JSON.stringify(corruptedResultA), tenant, manager, idemKey);

        await assert.rejects(
          fixture.persistence.executeAssignProjectRoleBinding(
            assignCmd({
              commandId: "cmd-coherent-bind-1",
              idempotencyKey: idemKey,
              principalIds: [memberU1],
              expectedVersion: 0,
              occurredAtUtc: atUtc,
            }),
          ),
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_BINDING_RECORD_CORRUPT",
        );

        // Subcase B: Outbox eventId mismatch
        const corruptedResultB = { ...result, outbox: { ...result.outbox, eventId: "different-event-id" } };
        db.prepare(`
          UPDATE command_receipts SET result_json = ?
          WHERE tenant_id = ? AND principal_id = ? AND operation = 'assign_project_role_binding' AND idempotency_key = ?
        `).run(JSON.stringify(corruptedResultB), tenant, manager, idemKey);

        await assert.rejects(
          fixture.persistence.executeAssignProjectRoleBinding(
            assignCmd({
              commandId: "cmd-coherent-bind-1",
              idempotencyKey: idemKey,
              principalIds: [memberU1],
              expectedVersion: 0,
              occurredAtUtc: atUtc,
            }),
          ),
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_BINDING_RECORD_CORRUPT",
        );
        db.close();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test(`TC-SEC-004B (${engine}): Cycle 3 Finding 2 - Initialization receipt with corrupted/divergent event or outbox fails closed`, async () => {
    const fixture = await createFixture(engine);
    try {
      const atUtc = "2026-09-15T00:00:00.000Z";
      const pId = `proj-coherent-init-${engine}`;
      const idemKey = `idem-coherent-init-${engine}`;
      await grantProjectMembership(fixture.persistence, tenant, pId, manager, { role: "project_manager" });

      await fixture.persistence.executeInitializeProjectRoleSlots({
        tenantId: tenant,
        commandId: "cmd-coherent-init-1",
        idempotencyKey: idemKey,
        principalId: manager,
        projectId: pId,
        sourceTemplateVersionId: "tpl-v1",
        occurredAtUtc: atUtc,
        slots: [{ slotKey: "reviewer_qa", name: "QA Reviewer", description: null }],
      });

      if (engine === "memory") {
        const snap = (fixture.persistence as MemoryPersistence).snapshot();
        const rKey = `${tenant}\u0000${manager}\u0000initialize_project_role_slots\u0000${idemKey}`;
        const prevReceipt = snap.receipts.get(rKey)!;
        const prevResult = prevReceipt.result as any;

        // Subcase A: Corrupted event schema version
        const corruptedReceiptA = {
          ...prevReceipt,
          result: {
            ...prevResult,
            event: { ...prevResult.event, schemaVersion: 999 },
          },
        };
        snap.receipts.set(rKey, corruptedReceiptA);
        const memA = new MemoryPersistence({ snapshot: snap });
        await assert.rejects(
          memA.executeInitializeProjectRoleSlots({
            tenantId: tenant,
            commandId: "cmd-coherent-init-1",
            idempotencyKey: idemKey,
            principalId: manager,
            projectId: pId,
            sourceTemplateVersionId: "tpl-v1",
            occurredAtUtc: atUtc,
            slots: [{ slotKey: "reviewer_qa", name: "QA Reviewer", description: null }],
          }),
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
        );

        // Subcase B: Corrupted outbox topic
        const corruptedReceiptB = {
          ...prevReceipt,
          result: {
            ...prevResult,
            outbox: { ...prevResult.outbox, topic: "wrong-topic" },
          },
        };
        snap.receipts.set(rKey, corruptedReceiptB);
        const memB = new MemoryPersistence({ snapshot: snap });
        await assert.rejects(
          memB.executeInitializeProjectRoleSlots({
            tenantId: tenant,
            commandId: "cmd-coherent-init-1",
            idempotencyKey: idemKey,
            principalId: manager,
            projectId: pId,
            sourceTemplateVersionId: "tpl-v1",
            occurredAtUtc: atUtc,
            slots: [{ slotKey: "reviewer_qa", name: "QA Reviewer", description: null }],
          }),
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
        );

        // Subcase C: Divergent receipt snapshot sourceTemplateVersionId
        const corruptedReceiptC = {
          ...prevReceipt,
          result: {
            ...prevResult,
            snapshot: { ...prevResult.snapshot, sourceTemplateVersionId: "tpl-divergent" },
          },
        };
        snap.receipts.set(rKey, corruptedReceiptC);
        const memC = new MemoryPersistence({ snapshot: snap });
        await assert.rejects(
          memC.executeInitializeProjectRoleSlots({
            tenantId: tenant,
            commandId: "cmd-coherent-init-1",
            idempotencyKey: idemKey,
            principalId: manager,
            projectId: pId,
            sourceTemplateVersionId: "tpl-v1",
            occurredAtUtc: atUtc,
            slots: [{ slotKey: "reviewer_qa", name: "QA Reviewer", description: null }],
          }),
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
        );
      } else {
        const db = new DatabaseSync((fixture as any).path);
        const row = db.prepare(`
          SELECT result_json FROM command_receipts
          WHERE tenant_id = ? AND principal_id = ? AND operation = 'initialize_project_role_slots' AND idempotency_key = ?
        `).get(tenant, manager, idemKey) as { result_json: string };
        const result = JSON.parse(row.result_json);

        // Subcase A: Corrupted event schema version
        const corruptedResultA = { ...result, event: { ...result.event, schemaVersion: 999 } };
        db.prepare(`
          UPDATE command_receipts SET result_json = ?
          WHERE tenant_id = ? AND principal_id = ? AND operation = 'initialize_project_role_slots' AND idempotency_key = ?
        `).run(JSON.stringify(corruptedResultA), tenant, manager, idemKey);

        await assert.rejects(
          fixture.persistence.executeInitializeProjectRoleSlots({
            tenantId: tenant,
            commandId: "cmd-coherent-init-1",
            idempotencyKey: idemKey,
            principalId: manager,
            projectId: pId,
            sourceTemplateVersionId: "tpl-v1",
            occurredAtUtc: atUtc,
            slots: [{ slotKey: "reviewer_qa", name: "QA Reviewer", description: null }],
          }),
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
        );

        // Subcase B: Corrupted outbox topic
        const corruptedResultB = { ...result, outbox: { ...result.outbox, topic: "wrong-topic" } };
        db.prepare(`
          UPDATE command_receipts SET result_json = ?
          WHERE tenant_id = ? AND principal_id = ? AND operation = 'initialize_project_role_slots' AND idempotency_key = ?
        `).run(JSON.stringify(corruptedResultB), tenant, manager, idemKey);

        await assert.rejects(
          fixture.persistence.executeInitializeProjectRoleSlots({
            tenantId: tenant,
            commandId: "cmd-coherent-init-1",
            idempotencyKey: idemKey,
            principalId: manager,
            projectId: pId,
            sourceTemplateVersionId: "tpl-v1",
            occurredAtUtc: atUtc,
            slots: [{ slotKey: "reviewer_qa", name: "QA Reviewer", description: null }],
          }),
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
        );

        // Subcase C: Divergent receipt snapshot sourceTemplateVersionId
        const corruptedResultC = { ...result, snapshot: { ...result.snapshot, sourceTemplateVersionId: "tpl-divergent" } };
        db.prepare(`
          UPDATE command_receipts SET result_json = ?
          WHERE tenant_id = ? AND principal_id = ? AND operation = 'initialize_project_role_slots' AND idempotency_key = ?
        `).run(JSON.stringify(corruptedResultC), tenant, manager, idemKey);

        await assert.rejects(
          fixture.persistence.executeInitializeProjectRoleSlots({
            tenantId: tenant,
            commandId: "cmd-coherent-init-1",
            idempotencyKey: idemKey,
            principalId: manager,
            projectId: pId,
            sourceTemplateVersionId: "tpl-v1",
            occurredAtUtc: atUtc,
            slots: [{ slotKey: "reviewer_qa", name: "QA Reviewer", description: null }],
          }),
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
        );
        db.close();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  // Finding 3: Remove fabricated identical-initialization results
  test(`TC-SEC-004B (${engine}): Cycle 3 Finding 3 - Different idempotency key with identical frozen snapshot returns authoritative persisted history`, async () => {
    const fixture = await createFixture(engine);
    try {
      const atUtc = "2026-09-15T00:00:00.000Z";
      const pId = `proj-ident-hist-${engine}`;
      await grantProjectMembership(fixture.persistence, tenant, pId, manager, { role: "project_manager" });

      const slots = [
        { slotKey: "reviewer_qa", name: "QA Reviewer", description: null },
        { slotKey: "security_auditor", name: "Security Auditor", description: "Audit" },
      ];

      // 1. First initialization with key 1
      const res1 = await fixture.persistence.executeInitializeProjectRoleSlots({
        tenantId: tenant,
        commandId: "cmd-hist-1",
        idempotencyKey: "idem-hist-1",
        principalId: manager,
        projectId: pId,
        sourceTemplateVersionId: "tpl-v1",
        occurredAtUtc: atUtc,
        slots,
      });

      assert.equal(res1.replayed, false);
      assert.ok(Number.isInteger(res1.event.projectSequence));
      assert.ok(res1.event.projectSequence > 0, "Initial sequence must be positive integer");
      assert.ok(res1.event.eventId.startsWith("evt:"));
      assert.deepEqual(res1.event.payload.slotKeys, ["reviewer_qa", "security_auditor"]);
      assert.equal(res1.outbox.eventId, res1.event.eventId);
      assert.equal(res1.audit.action, "initialized");

      // 2. Second initialization with DIFFERENT idempotency key but IDENTICAL frozen snapshot
      const res2 = await fixture.persistence.executeInitializeProjectRoleSlots({
        tenantId: tenant,
        commandId: "cmd-hist-2",
        idempotencyKey: "idem-hist-2",
        principalId: manager,
        projectId: pId,
        sourceTemplateVersionId: "tpl-v1",
        occurredAtUtc: atUtc,
        slots,
      });

      assert.equal(res2.replayed, false);
      // Must return authoritative persisted history, NOT fabricated sequence 0 or empty payload
      assert.equal(res2.event.projectSequence, res1.event.projectSequence, "Sequence must match authoritative persisted event");
      assert.equal(res2.event.eventId, res1.event.eventId, "Event ID must match authoritative persisted event");
      assert.deepEqual(res2.event.payload, res1.event.payload, "Event payload must match authoritative persisted payload");
      assert.equal(res2.outbox.id, res1.outbox.id, "Outbox ID must match authoritative persisted outbox");
      assert.equal(res2.outbox.eventId, res1.outbox.eventId);
      assert.equal(res2.audit.id, res1.audit.id, "Audit ID must match authoritative persisted audit");
      assert.deepEqual(res2.audit.slotKeys, res1.audit.slotKeys);

      // 3. Verify durable receipt was written for idem-hist-2
      if (engine === "sqlite") {
        const db = new DatabaseSync((fixture as any).path);
        const row = db.prepare(`
          SELECT result_json FROM command_receipts
          WHERE tenant_id = ? AND principal_id = ? AND operation = 'initialize_project_role_slots' AND idempotency_key = ?
        `).get(tenant, manager, "idem-hist-2") as { result_json: string };
        assert.ok(row, "Durable receipt must be recorded for idem-hist-2");
        const stored = JSON.parse(row.result_json);
        assert.equal(stored.event.projectSequence, res1.event.projectSequence);
        assert.deepEqual(stored.event.payload.slotKeys, ["reviewer_qa", "security_auditor"]);
        db.close();
      } else {
        const snap = (fixture.persistence as MemoryPersistence).snapshot();
        const rKey = `${tenant}\u0000${manager}\u0000initialize_project_role_slots\u0000idem-hist-2`;
        const r = snap.receipts.get(rKey);
        assert.ok(r, "Durable receipt must be recorded for idem-hist-2 in memory");
        const rResult = r.result as any;
        assert.equal(rResult?.event?.projectSequence, res1.event.projectSequence);
        assert.deepEqual(rResult?.event?.payload?.slotKeys, ["reviewer_qa", "security_auditor"]);
      }

      // 4. Replay of second key returns replayed: true with exact same authoritative history
      const res2Replay = await fixture.persistence.executeInitializeProjectRoleSlots({
        tenantId: tenant,
        commandId: "cmd-hist-2",
        idempotencyKey: "idem-hist-2",
        principalId: manager,
        projectId: pId,
        sourceTemplateVersionId: "tpl-v1",
        occurredAtUtc: atUtc,
        slots,
      });
      assert.equal(res2Replay.replayed, true);
      assert.equal(res2Replay.event.projectSequence, res1.event.projectSequence);
      assert.deepEqual(res2Replay.event.payload, res1.event.payload);
    } finally {
      await fixture.cleanup();
    }
  });
}

// Finding 4: Memory get malformed key fail-closed
test("TC-SEC-004B (memory): Cycle 3 Finding 4 - Memory get fails closed on malformed authoritative Map keys", async () => {
  const fixture = await createFixture("memory");
  try {
    await prepareIdentitiesAndSlots(fixture.persistence);
    const snap = (fixture.persistence as MemoryPersistence).snapshot();

    // 1. roleSlots.get fails closed when key split length is 1 (malformed single key) but value claims slot
    (snap.roleSlots as any).set("malformed-single-key", {
      tenantId: tenant,
      projectId: "project-role-test",
      slotKey: "reviewer_qa",
      sourceTemplateVersionId: "tpl-v1",
      name: "Corrupt Slot",
      description: null,
      createdAtUtc: "2026-09-15T00:00:00.000Z",
    });
    const memSlots1 = new MemoryPersistence({ snapshot: snap });
    await assert.rejects(
      async () => {
        await memSlots1.read(tenant, (tx) => tx.roleSlots.get("project-role-test", "reviewer_qa"));
      },
      (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
      "Must fail closed when record claims scope under malformed key with length 1",
    );

    // 2. roleSlots.get fails closed when key split length is 4 (extra segments)
    const snap2 = (fixture.persistence as MemoryPersistence).snapshot();
    (snap2.roleSlots as any).set(`${tenant}\u0000project-role-test\u0000reviewer_qa\u0000extra`, {
      tenantId: tenant,
      projectId: "project-role-test",
      slotKey: "reviewer_qa",
      sourceTemplateVersionId: "tpl-v1",
      name: "Corrupt Slot",
      description: null,
      createdAtUtc: "2026-09-15T00:00:00.000Z",
    });
    const memSlots2 = new MemoryPersistence({ snapshot: snap2 });
    await assert.rejects(
      async () => {
        await memSlots2.read(tenant, (tx) => tx.roleSlots.get("project-role-test", "reviewer_qa"));
      },
      (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
      "Must fail closed when record claims scope under malformed key with length 4",
    );

    // 3. roleBindings.get fails closed when key split length is 1 but value claims slot
    const snap3 = (fixture.persistence as MemoryPersistence).snapshot();
    (snap3.roleBindings as any).set("malformed-binding-key", {
      tenantId: tenant,
      projectId: "project-role-test",
      slotKey: "reviewer_qa",
      principalIds: [memberU1],
      version: 1,
      updatedAtUtc: "2026-09-15T00:00:00.000Z",
      updatedByPrincipalId: manager,
    });
    const memBindings1 = new MemoryPersistence({ snapshot: snap3 });
    await assert.rejects(
      async () => {
        await memBindings1.read(tenant, (tx) => tx.roleBindings.get("project-role-test", "reviewer_qa"));
      },
      (err: any) => err instanceof ApplicationError && err.code === "ROLE_BINDING_RECORD_CORRUPT",
      "Must fail closed when binding claims scope under malformed key with length 1",
    );

    // 4. roleBindings.get fails closed when key split length is 4
    const snap4 = (fixture.persistence as MemoryPersistence).snapshot();
    (snap4.roleBindings as any).set(`${tenant}\u0000project-role-test\u0000reviewer_qa\u0000extra`, {
      tenantId: tenant,
      projectId: "project-role-test",
      slotKey: "reviewer_qa",
      principalIds: [memberU1],
      version: 1,
      updatedAtUtc: "2026-09-15T00:00:00.000Z",
      updatedByPrincipalId: manager,
    });
    const memBindings2 = new MemoryPersistence({ snapshot: snap4 });
    await assert.rejects(
      async () => {
        await memBindings2.read(tenant, (tx) => tx.roleBindings.get("project-role-test", "reviewer_qa"));
      },
      (err: any) => err instanceof ApplicationError && err.code === "ROLE_BINDING_RECORD_CORRUPT",
      "Must fail closed when binding claims scope under malformed key with length 4",
    );

    // 5. roleSlots.getSnapshot fails closed when snapshot stored under malformed key
    const snap5 = (fixture.persistence as MemoryPersistence).snapshot();
    (snap5.roleSlotSnapshots as any).set(`${tenant}\u0000project-role-test\u0000extra`, {
      tenantId: tenant,
      projectId: "project-role-test",
      sourceTemplateVersionId: "tpl-v1",
      createdAtUtc: "2026-09-15T00:00:00.000Z",
      createdByPrincipalId: manager,
    });
    const memSnap1 = new MemoryPersistence({ snapshot: snap5 });
    await assert.rejects(
      async () => {
        await memSnap1.read(tenant, (tx) => tx.roleSlots.getSnapshot("project-role-test"));
      },
      (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
      "Must fail closed when snapshot claims scope under malformed key with length 3",
    );
  } finally {
    await fixture.cleanup();
  }
});

// ============================================================================
// CODEX R2 CYCLE 4 REWORK TESTS
// ============================================================================

for (const engine of ["memory", "sqlite"] as const) {
  // Cycle 4 Finding 1: Durable record validation on binding replay
  test(`TC-SEC-004B (${engine}): Cycle 4 Finding 1 - Role binding replay validates durable event and outbox, failing closed on deletion or divergence while historical replay remains valid`, async () => {
    const fixture = await createFixture(engine);
    try {
      await prepareIdentitiesAndSlots(fixture.persistence);
      const projectId = "project-role-test";
      const slotKey = "reviewer_qa";

      // 1. Assign v1 binding
      const cmd1: AssignProjectRoleBindingCommand = {
        tenantId: tenant,
        commandId: "cmd-rb-c4-1",
        idempotencyKey: "idem-rb-c4-1",
        correlationId: "corr-rb-c4-1",
        principalId: manager,
        projectId,
        slotKey,
        principalIds: [memberU1],
        expectedVersion: 0,
        occurredAtUtc: "2026-09-15T00:00:00.000Z",
      };
      const res1 = await fixture.persistence.executeAssignProjectRoleBinding(cmd1);
      assert.equal(res1.binding.version, 1);
      assert.equal(res1.replayed, false);

      // Replay v1 succeeds
      const replay1 = await fixture.persistence.executeAssignProjectRoleBinding(cmd1);
      assert.equal(replay1.replayed, true);
      assert.equal(replay1.binding.version, 1);

      // 2. Advance binding to v2
      const cmd2: AssignProjectRoleBindingCommand = {
        tenantId: tenant,
        commandId: "cmd-rb-c4-2",
        idempotencyKey: "idem-rb-c4-2",
        correlationId: "corr-rb-c4-2",
        principalId: manager,
        projectId,
        slotKey,
        principalIds: [memberU2],
        expectedVersion: 1,
        occurredAtUtc: "2026-09-15T00:01:00.000Z",
      };
      const res2 = await fixture.persistence.executeAssignProjectRoleBinding(cmd2);
      assert.equal(res2.binding.version, 2);

      // 3. Legitimate historical replay of v1 still succeeds after binding advanced to v2
      const histReplay1 = await fixture.persistence.executeAssignProjectRoleBinding(cmd1);
      assert.equal(histReplay1.replayed, true);
      assert.equal(histReplay1.binding.version, 1);
      assert.deepEqual(histReplay1.binding.principalIds, [memberU1]);

      // 4. Test missing durable domain event fails closed on replay
      if (engine === "sqlite") {
        const db = new DatabaseSync((fixture as any).path);
        db.exec("PRAGMA foreign_keys = OFF;");
        // Backup event 1 row
        const evRow = db.prepare("SELECT * FROM domain_events WHERE tenant_id = ? AND event_id = ?").get(tenant, res1.event.eventId) as any;
        db.prepare("DELETE FROM domain_events WHERE tenant_id = ? AND event_id = ?").run(tenant, res1.event.eventId);
        db.close();

        await assert.rejects(
          async () => {
            await fixture.persistence.executeAssignProjectRoleBinding(cmd1);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_BINDING_RECORD_CORRUPT",
          "Replay must fail closed when durable domain event is deleted in sqlite",
        );

        // Test divergent durable domain event fails closed on replay
        const db2 = new DatabaseSync((fixture as any).path);
        const mutatedEv = JSON.parse(evRow.event_json);
        mutatedEv.aggregateVersion = 999;
        db2.prepare(`
          INSERT INTO domain_events (tenant_id, event_id, project_id, project_sequence, aggregate_type, aggregate_id, aggregate_version, event_type, schema_version, occurred_at_utc, event_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(evRow.tenant_id, evRow.event_id, evRow.project_id, evRow.project_sequence, evRow.aggregate_type, evRow.aggregate_id, evRow.aggregate_version, evRow.event_type, evRow.schema_version, evRow.occurred_at_utc, JSON.stringify(mutatedEv));
        db2.close();

        await assert.rejects(
          async () => {
            await fixture.persistence.executeAssignProjectRoleBinding(cmd1);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_BINDING_RECORD_CORRUPT",
          "Replay must fail closed when durable domain event is divergent in sqlite",
        );

        // Restore original event row
        const db3 = new DatabaseSync((fixture as any).path);
        db3.prepare("UPDATE domain_events SET event_json = ? WHERE tenant_id = ? AND event_id = ?").run(evRow.event_json, tenant, res1.event.eventId);
        db3.close();

        // Replay succeeds again
        const restoredReplay = await fixture.persistence.executeAssignProjectRoleBinding(cmd1);
        assert.equal(restoredReplay.replayed, true);

        // Test missing durable outbox fails closed on replay
        const db4 = new DatabaseSync((fixture as any).path);
        const outRow = db4.prepare("SELECT * FROM outbox_messages WHERE tenant_id = ? AND message_id = ?").get(tenant, res1.outbox.id) as any;
        db4.prepare("DELETE FROM outbox_messages WHERE tenant_id = ? AND message_id = ?").run(tenant, res1.outbox.id);
        db4.close();

        await assert.rejects(
          async () => {
            await fixture.persistence.executeAssignProjectRoleBinding(cmd1);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_BINDING_RECORD_CORRUPT",
          "Replay must fail closed when durable outbox message is deleted in sqlite",
        );

        // Test divergent durable outbox fails closed on replay
        const db5 = new DatabaseSync((fixture as any).path);
        db5.prepare(`
          INSERT INTO outbox_messages (tenant_id, message_id, event_id, topic, payload_json, state, available_at_utc, attempts, max_attempts, created_at_utc)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(outRow.tenant_id, outRow.message_id, outRow.event_id, "divergent.topic", outRow.payload_json, outRow.state, outRow.available_at_utc, outRow.attempts, outRow.max_attempts, outRow.created_at_utc);
        db5.close();

        await assert.rejects(
          async () => {
            await fixture.persistence.executeAssignProjectRoleBinding(cmd1);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_BINDING_RECORD_CORRUPT",
          "Replay must fail closed when durable outbox is divergent in sqlite",
        );
      } else {
        const mem = fixture.persistence as any;
        const snap = mem.snapshot();
        const evKey = `${tenant}\u0000${res1.event.eventId}`;
        const originalEv = snap.events.get(evKey);
        assert.ok(originalEv);

        // Delete event
        snap.events.delete(evKey);
        const memWithoutEv = new MemoryPersistence({ snapshot: snap });
        await assert.rejects(
          async () => {
            await memWithoutEv.executeAssignProjectRoleBinding(cmd1);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_BINDING_RECORD_CORRUPT",
          "Replay must fail closed when durable domain event is deleted in memory",
        );

        // Mutate event (divergent)
        const snapDivergentEv = mem.snapshot();
        const mutatedEv = structuredClone(originalEv);
        (mutatedEv as any).aggregateVersion = 999;
        snapDivergentEv.events.set(evKey, mutatedEv);
        const memDivergentEv = new MemoryPersistence({ snapshot: snapDivergentEv });
        await assert.rejects(
          async () => {
            await memDivergentEv.executeAssignProjectRoleBinding(cmd1);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_BINDING_RECORD_CORRUPT",
          "Replay must fail closed when durable domain event is divergent in memory",
        );

        // Delete outbox
        const snapNoOutbox = mem.snapshot();
        const outKey = `${tenant}\u0000${res1.outbox.id}`;
        const originalOut = snapNoOutbox.outbox.get(outKey);
        assert.ok(originalOut);
        snapNoOutbox.outbox.delete(outKey);
        const memWithoutOutbox = new MemoryPersistence({ snapshot: snapNoOutbox });
        await assert.rejects(
          async () => {
            await memWithoutOutbox.executeAssignProjectRoleBinding(cmd1);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_BINDING_RECORD_CORRUPT",
          "Replay must fail closed when durable outbox message is deleted in memory",
        );

        // Mutate outbox (divergent)
        const snapDivergentOutbox = mem.snapshot();
        const mutatedOut = structuredClone(originalOut);
        mutatedOut.topic = "divergent.topic";
        snapDivergentOutbox.outbox.set(outKey, mutatedOut);
        const memDivergentOutbox = new MemoryPersistence({ snapshot: snapDivergentOutbox });
        await assert.rejects(
          async () => {
            await memDivergentOutbox.executeAssignProjectRoleBinding(cmd1);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_BINDING_RECORD_CORRUPT",
          "Replay must fail closed when durable outbox is divergent in memory",
        );

        // Mutate outbox value-side id while keeping map key intact (Cycle 6 regression)
        const snapDivergentOutboxId = mem.snapshot();
        const mutatedOutId = structuredClone(originalOut);
        mutatedOutId.id = "divergent-outbox-id";
        snapDivergentOutboxId.outbox.set(outKey, mutatedOutId);
        const memDivergentOutboxId = new MemoryPersistence({ snapshot: snapDivergentOutboxId });
        await assert.rejects(
          async () => {
            await memDivergentOutboxId.executeAssignProjectRoleBinding(cmd1);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_BINDING_RECORD_CORRUPT",
          "Replay must fail closed when durable outbox value-side id is divergent in memory",
        );
      }
    } finally {
      await fixture.cleanup();
    }
  });

  // Cycle 4 Finding 1: Durable record validation on initialization replay
  test(`TC-SEC-004B (${engine}): Cycle 4 Finding 1 - Role slots initialization replay validates durable audit, event, and outbox, failing closed on deletion or divergence`, async () => {
    const fixture = await createFixture(engine);
    try {
      const atUtc = "2026-09-15T00:00:00.000Z";
      const pId = `proj-c4-init-rep-${engine}`;
      await grantProjectMembership(fixture.persistence, tenant, pId, manager, { role: "project_manager" });

      const slots = [
        { slotKey: "reviewer_qa", name: "QA Reviewer", description: null },
      ];

      const cmd: InitializeProjectRoleSlotsCommand = {
        tenantId: tenant,
        commandId: "cmd-init-c4-rep",
        idempotencyKey: "idem-init-c4-rep",
        principalId: manager,
        projectId: pId,
        sourceTemplateVersionId: "tpl-v1",
        occurredAtUtc: atUtc,
        slots,
      };

      const res = await fixture.persistence.executeInitializeProjectRoleSlots(cmd);
      assert.equal(res.replayed, false);

      // Replay succeeds
      const replay = await fixture.persistence.executeInitializeProjectRoleSlots(cmd);
      assert.equal(replay.replayed, true);

      if (engine === "sqlite") {
        const db = new DatabaseSync((fixture as any).path);
        // Backup rows
        const auditRow = db.prepare("SELECT * FROM project_role_slot_audits WHERE tenant_id = ? AND id = ?").get(tenant, res.audit.id) as any;
        const evRow = db.prepare("SELECT * FROM domain_events WHERE tenant_id = ? AND event_id = ?").get(tenant, res.event.eventId) as any;
        const outRow = db.prepare("SELECT * FROM outbox_messages WHERE tenant_id = ? AND message_id = ?").get(tenant, res.outbox.id) as any;

        // 1. Audit deletion
        db.prepare("DELETE FROM project_role_slot_audits WHERE tenant_id = ? AND id = ?").run(tenant, res.audit.id);
        db.close();

        await assert.rejects(
          async () => {
            await fixture.persistence.executeInitializeProjectRoleSlots(cmd);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
          "Init replay must fail closed when durable audit is deleted in sqlite",
        );

        // Audit divergence
        const db2 = new DatabaseSync((fixture as any).path);
        db2.prepare(`
          INSERT INTO project_role_slot_audits (tenant_id, id, project_id, actor_principal_id, source_template_version_id, action, slot_keys_json, occurred_at_utc)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(auditRow.tenant_id, auditRow.id, auditRow.project_id, auditRow.actor_principal_id, auditRow.source_template_version_id, "initialized", JSON.stringify(["different_key"]), auditRow.occurred_at_utc);
        db2.close();

        await assert.rejects(
          async () => {
            await fixture.persistence.executeInitializeProjectRoleSlots(cmd);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
          "Init replay must fail closed when durable audit is divergent in sqlite",
        );

        // Restore audit
        const db3 = new DatabaseSync((fixture as any).path);
        db3.exec("PRAGMA foreign_keys = OFF;");
        db3.prepare("UPDATE project_role_slot_audits SET slot_keys_json = ? WHERE tenant_id = ? AND id = ?").run(auditRow.slot_keys_json, tenant, res.audit.id);

        // 2. Event deletion
        db3.prepare("DELETE FROM domain_events WHERE tenant_id = ? AND event_id = ?").run(tenant, res.event.eventId);
        db3.close();

        await assert.rejects(
          async () => {
            await fixture.persistence.executeInitializeProjectRoleSlots(cmd);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
          "Init replay must fail closed when durable event is deleted in sqlite",
        );

        // Restore event
        const db4 = new DatabaseSync((fixture as any).path);
        db4.prepare(`
          INSERT INTO domain_events (tenant_id, event_id, project_id, project_sequence, aggregate_type, aggregate_id, aggregate_version, event_type, schema_version, occurred_at_utc, event_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(evRow.tenant_id, evRow.event_id, evRow.project_id, evRow.project_sequence, evRow.aggregate_type, evRow.aggregate_id, evRow.aggregate_version, evRow.event_type, evRow.schema_version, evRow.occurred_at_utc, evRow.event_json);

        // 3. Outbox deletion
        db4.prepare("DELETE FROM outbox_messages WHERE tenant_id = ? AND message_id = ?").run(tenant, res.outbox.id);
        db4.close();

        await assert.rejects(
          async () => {
            await fixture.persistence.executeInitializeProjectRoleSlots(cmd);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
          "Init replay must fail closed when durable outbox is deleted in sqlite",
        );

        // Outbox divergence
        const db5 = new DatabaseSync((fixture as any).path);
        db5.prepare(`
          INSERT INTO outbox_messages (tenant_id, message_id, event_id, topic, payload_json, state, available_at_utc, attempts, max_attempts, created_at_utc)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(outRow.tenant_id, outRow.message_id, outRow.event_id, "tampered.topic", outRow.payload_json, outRow.state, outRow.available_at_utc, outRow.attempts, outRow.max_attempts, outRow.created_at_utc);
        db5.close();

        await assert.rejects(
          async () => {
            await fixture.persistence.executeInitializeProjectRoleSlots(cmd);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
          "Init replay must fail closed when durable outbox is divergent in sqlite",
        );
      } else {
        const mem = fixture.persistence as any;
        const audKey = `${tenant}\u0000${res.audit.id}`;
        const evKey = `${tenant}\u0000${res.event.eventId}`;
        const outKey = `${tenant}\u0000${res.outbox.id}`;

        // Audit deletion
        const snapNoAud = mem.snapshot();
        snapNoAud.roleSlotAudits.delete(audKey);
        const memNoAud = new MemoryPersistence({ snapshot: snapNoAud });
        await assert.rejects(
          async () => {
            await memNoAud.executeInitializeProjectRoleSlots(cmd);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
          "Init replay must fail closed when durable audit is deleted in memory",
        );

        // Audit divergence
        const snapDivAud = mem.snapshot();
        const mutatedAud = structuredClone(snapDivAud.roleSlotAudits.get(audKey));
        mutatedAud.slotKeys = ["tampered_key"];
        snapDivAud.roleSlotAudits.set(audKey, mutatedAud);
        const memDivAud = new MemoryPersistence({ snapshot: snapDivAud });
        await assert.rejects(
          async () => {
            await memDivAud.executeInitializeProjectRoleSlots(cmd);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
          "Init replay must fail closed when durable audit is divergent in memory",
        );

        // Event deletion
        const snapNoEv = mem.snapshot();
        snapNoEv.events.delete(evKey);
        const memNoEv = new MemoryPersistence({ snapshot: snapNoEv });
        await assert.rejects(
          async () => {
            await memNoEv.executeInitializeProjectRoleSlots(cmd);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
          "Init replay must fail closed when durable event is deleted in memory",
        );

        // Event divergence
        const snapDivEv = mem.snapshot();
        const mutatedEv = structuredClone(snapDivEv.events.get(evKey));
        mutatedEv.projectSequence = -5;
        snapDivEv.events.set(evKey, mutatedEv);
        const memDivEv = new MemoryPersistence({ snapshot: snapDivEv });
        await assert.rejects(
          async () => {
            await memDivEv.executeInitializeProjectRoleSlots(cmd);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
          "Init replay must fail closed when durable event is divergent in memory",
        );

        // Outbox deletion
        const snapNoOut = mem.snapshot();
        snapNoOut.outbox.delete(outKey);
        const memNoOut = new MemoryPersistence({ snapshot: snapNoOut });
        await assert.rejects(
          async () => {
            await memNoOut.executeInitializeProjectRoleSlots(cmd);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
          "Init replay must fail closed when durable outbox is deleted in memory",
        );

        // Outbox divergence
        const snapDivOut = mem.snapshot();
        const mutatedOut = structuredClone(snapDivOut.outbox.get(outKey));
        mutatedOut.topic = "tampered.topic";
        snapDivOut.outbox.set(outKey, mutatedOut);
        const memDivOut = new MemoryPersistence({ snapshot: snapDivOut });
        await assert.rejects(
          async () => {
            await memDivOut.executeInitializeProjectRoleSlots(cmd);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
          "Init replay must fail closed when durable outbox is divergent in memory",
        );
      }
    } finally {
      await fixture.cleanup();
    }
  });

  // Cycle 4 Finding 2: Corrupt durable-history validation on different-key identical initialization
  test(`TC-SEC-004B (${engine}): Cycle 4 Finding 2 - Different-key identical initialization fails closed and creates zero receipt on corrupted durable history`, async () => {
    const fixture = await createFixture(engine);
    try {
      const atUtc = "2026-09-15T00:00:00.000Z";
      const pId = `proj-c4-corrupt-hist-${engine}`;
      await grantProjectMembership(fixture.persistence, tenant, pId, manager, { role: "project_manager" });

      const slots = [
        { slotKey: "reviewer_qa", name: "QA Reviewer", description: null },
      ];

      // 1. Initial initialization with key 1
      const res1 = await fixture.persistence.executeInitializeProjectRoleSlots({
        tenantId: tenant,
        commandId: "cmd-c4-diff-1",
        idempotencyKey: "idem-c4-diff-1",
        principalId: manager,
        projectId: pId,
        sourceTemplateVersionId: "tpl-v1",
        occurredAtUtc: atUtc,
        slots,
      });
      assert.equal(res1.replayed, false);

      const cmdDiffKey: InitializeProjectRoleSlotsCommand = {
        tenantId: tenant,
        commandId: "cmd-c4-diff-2",
        idempotencyKey: "idem-c4-diff-2",
        principalId: manager,
        projectId: pId,
        sourceTemplateVersionId: "tpl-v1",
        occurredAtUtc: atUtc,
        slots,
      };

      if (engine === "sqlite") {
        const db = new DatabaseSync((fixture as any).path);
        const evRow = db.prepare("SELECT * FROM domain_events WHERE tenant_id = ? AND event_id = ?").get(tenant, res1.event.eventId) as any;
        const auditRow = db.prepare("SELECT * FROM project_role_slot_audits WHERE tenant_id = ? AND id = ?").get(tenant, res1.audit.id) as any;
        const outRow = db.prepare("SELECT * FROM outbox_messages WHERE tenant_id = ? AND message_id = ?").get(tenant, res1.outbox.id) as any;

        // Sub-test A: Corrupt event sequence
        const badEv = JSON.parse(evRow.event_json);
        badEv.projectSequence = 0;
        db.prepare("UPDATE domain_events SET event_json = ? WHERE tenant_id = ? AND event_id = ?").run(JSON.stringify(badEv), tenant, res1.event.eventId);
        db.close();

        await assert.rejects(
          async () => {
            await fixture.persistence.executeInitializeProjectRoleSlots(cmdDiffKey);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
          "Different-key identical init must fail closed on corrupt event sequence",
        );

        // Verify NO receipt was recorded for idem-c4-diff-2
        const checkDb1 = new DatabaseSync((fixture as any).path);
        const r1 = checkDb1.prepare("SELECT * FROM command_receipts WHERE idempotency_key = ?").get("idem-c4-diff-2");
        assert.equal(r1, undefined, "Zero receipt must be recorded on corrupted durable history");
        // Restore event
        checkDb1.prepare("UPDATE domain_events SET event_json = ? WHERE tenant_id = ? AND event_id = ?").run(evRow.event_json, tenant, res1.event.eventId);

        // Sub-test B: Corrupt audit slot keys
        checkDb1.prepare("UPDATE project_role_slot_audits SET slot_keys_json = ? WHERE tenant_id = ? AND id = ?").run(JSON.stringify(["tampered_slot"]), tenant, res1.audit.id);
        checkDb1.close();

        await assert.rejects(
          async () => {
            await fixture.persistence.executeInitializeProjectRoleSlots(cmdDiffKey);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
          "Different-key identical init must fail closed on corrupt audit slot keys",
        );

        const checkDb2 = new DatabaseSync((fixture as any).path);
        const r2 = checkDb2.prepare("SELECT * FROM command_receipts WHERE idempotency_key = ?").get("idem-c4-diff-2");
        assert.equal(r2, undefined, "Zero receipt must be recorded on corrupted audit");
        // Restore audit
        checkDb2.prepare("UPDATE project_role_slot_audits SET slot_keys_json = ? WHERE tenant_id = ? AND id = ?").run(auditRow.slot_keys_json, tenant, res1.audit.id);

        // Sub-test C: Corrupt outbox topic
        checkDb2.prepare("UPDATE outbox_messages SET topic = ? WHERE tenant_id = ? AND message_id = ?").run("divergent.outbox.topic", tenant, res1.outbox.id);
        checkDb2.close();

        await assert.rejects(
          async () => {
            await fixture.persistence.executeInitializeProjectRoleSlots(cmdDiffKey);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
          "Different-key identical init must fail closed on corrupt outbox topic",
        );

        const checkDb3 = new DatabaseSync((fixture as any).path);
        const r3 = checkDb3.prepare("SELECT * FROM command_receipts WHERE idempotency_key = ?").get("idem-c4-diff-2");
        assert.equal(r3, undefined, "Zero receipt must be recorded on corrupted outbox");
        // Restore outbox
        checkDb3.prepare("UPDATE outbox_messages SET topic = ? WHERE tenant_id = ? AND message_id = ?").run(outRow.topic, tenant, res1.outbox.id);
        checkDb3.close();

        // Sub-test D: When durable history is uncorrupted, different-key identical init succeeds and writes receipt
        const successRes = await fixture.persistence.executeInitializeProjectRoleSlots(cmdDiffKey);
        assert.equal(successRes.replayed, false);
        assert.equal(successRes.event.projectSequence, res1.event.projectSequence);
        const verifyDb = new DatabaseSync((fixture as any).path);
        const rSuccess = verifyDb.prepare("SELECT * FROM command_receipts WHERE idempotency_key = ?").get("idem-c4-diff-2");
        assert.ok(rSuccess, "Receipt must be recorded after valid cross-record coherence validation");
        verifyDb.close();
      } else {
        const mem = fixture.persistence as any;
        const evKey = `${tenant}\u0000${res1.event.eventId}`;
        const audKey = `${tenant}\u0000${res1.audit.id}`;
        const outKey = `${tenant}\u0000${res1.outbox.id}`;
        const rDiffKey = `${tenant}\u0000${manager}\u0000initialize_project_role_slots\u0000idem-c4-diff-2`;

        // Sub-test A: Corrupt event sequence in memory
        const snapBadEv = mem.snapshot();
        const badEv = structuredClone(snapBadEv.events.get(evKey));
        badEv.projectSequence = 0;
        snapBadEv.events.set(evKey, badEv);
        const memBadEv = new MemoryPersistence({ snapshot: snapBadEv });

        await assert.rejects(
          async () => {
            await memBadEv.executeInitializeProjectRoleSlots(cmdDiffKey);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
          "Different-key identical init must fail closed on corrupt event sequence in memory",
        );
        assert.equal(memBadEv.snapshot().receipts.has(rDiffKey), false, "Zero receipt created on corrupt event");

        // Sub-test B: Corrupt audit slot keys in memory
        const snapBadAud = mem.snapshot();
        const badAud = structuredClone(snapBadAud.roleSlotAudits.get(audKey));
        badAud.slotKeys = ["tampered_slot"];
        snapBadAud.roleSlotAudits.set(audKey, badAud);
        const memBadAud = new MemoryPersistence({ snapshot: snapBadAud });

        await assert.rejects(
          async () => {
            await memBadAud.executeInitializeProjectRoleSlots(cmdDiffKey);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
          "Different-key identical init must fail closed on corrupt audit in memory",
        );
        assert.equal(memBadAud.snapshot().receipts.has(rDiffKey), false, "Zero receipt created on corrupt audit");

        // Sub-test C: Corrupt outbox in memory
        const snapBadOut = mem.snapshot();
        const badOut = structuredClone(snapBadOut.outbox.get(outKey));
        badOut.topic = "divergent.outbox.topic";
        snapBadOut.outbox.set(outKey, badOut);
        const memBadOut = new MemoryPersistence({ snapshot: snapBadOut });

        await assert.rejects(
          async () => {
            await memBadOut.executeInitializeProjectRoleSlots(cmdDiffKey);
          },
          (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
          "Different-key identical init must fail closed on corrupt outbox in memory",
        );
        assert.equal(memBadOut.snapshot().receipts.has(rDiffKey), false, "Zero receipt created on corrupt outbox");

        // Sub-test D: Uncorrupted succeeds
        const successRes = await fixture.persistence.executeInitializeProjectRoleSlots(cmdDiffKey);
        assert.equal(successRes.replayed, false);
        assert.equal(successRes.event.projectSequence, res1.event.projectSequence);
        assert.equal(mem.snapshot().receipts.has(rDiffKey), true, "Receipt created on coherent durable records");
      }
    } finally {
      await fixture.cleanup();
    }
  });
}

// Cycle 5 Finding 1: Initialization replay canonically validates every receipt-embedded discriminator
for (const engine of ["memory", "sqlite"] as const) {
  test(`TC-SEC-004B (${engine}): Cycle 5 Finding 1 - Initialization replay rejects tampered receipt discriminators`, async () => {
    const fixture = await createFixture(engine);
    try {
      const atUtc = "2026-09-15T00:00:00.000Z";
      const pId = `proj-c5-disc-${engine}`;
      await grantProjectMembership(fixture.persistence, tenant, pId, manager, { role: "project_manager" });

      const slots = [
        { slotKey: "reviewer_qa", name: "QA Reviewer", description: null },
      ];

      const origCommand: InitializeProjectRoleSlotsCommand = {
        tenantId: tenant,
        commandId: `cmd-c5-init-${engine}`,
        idempotencyKey: `idem-c5-init-${engine}`,
        principalId: manager,
        projectId: pId,
        sourceTemplateVersionId: "tpl-v1",
        occurredAtUtc: atUtc,
        slots,
      };

      const res = await fixture.persistence.executeInitializeProjectRoleSlots(origCommand);
      assert.equal(res.replayed, false);

      // Normal replay succeeds
      const normalReplay = await fixture.persistence.executeInitializeProjectRoleSlots(origCommand);
      assert.equal(normalReplay.replayed, true);

      // Mutate receipt result helper
      const testTamperedReceipt = async (tamper: (result: any) => void, desc: string) => {
        if (engine === "sqlite") {
          const db = new DatabaseSync((fixture as any).path);
          const row = db.prepare("SELECT result_json FROM command_receipts WHERE idempotency_key = ?").get(origCommand.idempotencyKey) as any;
          const originalJson = row.result_json;
          const parsed = JSON.parse(originalJson);
          tamper(parsed);
          db.prepare("UPDATE command_receipts SET result_json = ? WHERE idempotency_key = ?").run(JSON.stringify(parsed), origCommand.idempotencyKey);
          db.close();

          await assert.rejects(
            async () => {
              await fixture.persistence.executeInitializeProjectRoleSlots(origCommand);
            },
            (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
            `Replay must reject tampered ${desc} in SQLite`,
          );

          // Restore original receipt
          const restoreDb = new DatabaseSync((fixture as any).path);
          restoreDb.prepare("UPDATE command_receipts SET result_json = ? WHERE idempotency_key = ?").run(originalJson, origCommand.idempotencyKey);
          restoreDb.close();
        } else {
          const mem = fixture.persistence as any;
          const rKey = `${tenant}\u0000${manager}\u0000initialize_project_role_slots\u0000${origCommand.idempotencyKey}`;
          const snap = mem.snapshot();
          const origReceipt = snap.receipts.get(rKey);
          const clonedReceipt = structuredClone(origReceipt);
          tamper(clonedReceipt.result);
          snap.receipts.set(rKey, clonedReceipt);
          const corruptedMem = new MemoryPersistence({ snapshot: snap });

          await assert.rejects(
            async () => {
              await corruptedMem.executeInitializeProjectRoleSlots(origCommand);
            },
            (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
            `Replay must reject tampered ${desc} in Memory`,
          );
        }
      };

      // 1. slots[0].tenantId tampered
      await testTamperedReceipt((r) => {
        (r.slots[0] as any).tenantId = "wrong-tenant";
      }, "slots[0].tenantId");

      // 2. slots[0].projectId tampered
      await testTamperedReceipt((r) => {
        (r.slots[0] as any).projectId = "wrong-project";
      }, "slots[0].projectId");

      // 3. audit.tenantId tampered
      await testTamperedReceipt((r) => {
        (r.audit as any).tenantId = "wrong-tenant";
      }, "audit.tenantId");

      // 4. audit.projectId tampered
      await testTamperedReceipt((r) => {
        (r.audit as any).projectId = "wrong-project";
      }, "audit.projectId");

      // 5. snapshot.tenantId tampered
      await testTamperedReceipt((r) => {
        (r.snapshot as any).tenantId = "wrong-tenant";
      }, "snapshot.tenantId");

      // 6. snapshot.projectId tampered
      await testTamperedReceipt((r) => {
        (r.snapshot as any).projectId = "wrong-project";
      }, "snapshot.projectId");

      // 7. event.tenantId tampered
      await testTamperedReceipt((r) => {
        (r.event as any).tenantId = "wrong-tenant";
      }, "event.tenantId");

      // 8. outbox.tenantId tampered
      await testTamperedReceipt((r) => {
        (r.outbox as any).tenantId = "wrong-tenant";
      }, "outbox.tenantId");

      // Final: valid replay still succeeds
      const finalReplay = await fixture.persistence.executeInitializeProjectRoleSlots(origCommand);
      assert.equal(finalReplay.replayed, true);
    } finally {
      await fixture.cleanup();
    }
  });
}

// Cycle 5 Finding 2: SQLite domain_events relational columns cross-check against event_json
test("TC-SEC-004B (sqlite): Cycle 5 Finding 2 - SQLite domain_events relational column drift fails closed and creates zero new receipts", async () => {
  const fixture = await createFixture("sqlite");
  try {
    const atUtc = "2026-09-15T00:00:00.000Z";
    const pId = "proj-c5-f2-sqlite";
    await grantProjectMembership(fixture.persistence, tenant, pId, manager, { role: "project_manager" });
    await grantProjectMembership(fixture.persistence, tenant, pId, memberU1, { role: "member" });

    const slots = [
      { slotKey: "reviewer_qa", name: "QA Reviewer", description: null },
    ];

    // 1. Initial initialization
    const initCmd: InitializeProjectRoleSlotsCommand = {
      tenantId: tenant,
      commandId: "cmd-c5-f2-1",
      idempotencyKey: "idem-c5-f2-1",
      principalId: manager,
      projectId: pId,
      sourceTemplateVersionId: "tpl-v1",
      occurredAtUtc: atUtc,
      slots,
    };
    const res = await fixture.persistence.executeInitializeProjectRoleSlots(initCmd);
    assert.equal(res.replayed, false);

    const diffKeyCmd: InitializeProjectRoleSlotsCommand = {
      tenantId: tenant,
      commandId: "cmd-c5-f2-2",
      idempotencyKey: "idem-c5-f2-2",
      principalId: manager,
      projectId: pId,
      sourceTemplateVersionId: "tpl-v1",
      occurredAtUtc: atUtc,
      slots,
    };

    const getReceiptCount = () => {
      const db = new DatabaseSync((fixture as any).path);
      const count = (db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get() as any).count;
      db.close();
      return count;
    };
    const baselineReceiptCount = getReceiptCount();

    // Sub-test A: relational project_sequence 1 -> 999 with event_json projectSequence = 1
    const dbA = new DatabaseSync((fixture as any).path);
    dbA.prepare("UPDATE domain_events SET project_sequence = 999 WHERE tenant_id = ? AND event_id = ?").run(tenant, res.event.eventId);
    dbA.close();

    // A1: Replay of original command must fail closed
    await assert.rejects(
      async () => {
        await fixture.persistence.executeInitializeProjectRoleSlots(initCmd);
      },
      (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
      "Replay must fail closed on project_sequence relational drift",
    );

    // A2: Different-key identical initialization must fail closed
    await assert.rejects(
      async () => {
        await fixture.persistence.executeInitializeProjectRoleSlots(diffKeyCmd);
      },
      (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
      "Different-key init must fail closed on project_sequence relational drift",
    );
    assert.equal(getReceiptCount(), baselineReceiptCount, "Must create zero new receipts on relational project_sequence drift");

    // Restore project_sequence
    const dbRestoreA = new DatabaseSync((fixture as any).path);
    dbRestoreA.prepare("UPDATE domain_events SET project_sequence = ? WHERE tenant_id = ? AND event_id = ?").run(res.event.projectSequence, tenant, res.event.eventId);
    dbRestoreA.close();

    // Sub-test B: relational project_id drift
    const dbB = new DatabaseSync((fixture as any).path);
    dbB.prepare("UPDATE domain_events SET project_id = ? WHERE tenant_id = ? AND event_id = ?").run("divergent-project", tenant, res.event.eventId);
    dbB.close();

    await assert.rejects(
      async () => {
        await fixture.persistence.executeInitializeProjectRoleSlots(initCmd);
      },
      (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
      "Replay must fail closed on project_id relational drift",
    );
    await assert.rejects(
      async () => {
        await fixture.persistence.executeInitializeProjectRoleSlots(diffKeyCmd);
      },
      (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
      "Different-key init must fail closed on project_id relational drift",
    );
    assert.equal(getReceiptCount(), baselineReceiptCount, "Must create zero new receipts on relational project_id drift");

    // Restore project_id
    const dbRestoreB = new DatabaseSync((fixture as any).path);
    dbRestoreB.prepare("UPDATE domain_events SET project_id = ? WHERE tenant_id = ? AND event_id = ?").run(pId, tenant, res.event.eventId);
    dbRestoreB.close();

    // Sub-test C: relational event_type drift
    const dbC = new DatabaseSync((fixture as any).path);
    dbC.prepare("UPDATE domain_events SET event_type = ? WHERE tenant_id = ? AND event_id = ?").run("divergent.event.type", tenant, res.event.eventId);
    dbC.close();

    await assert.rejects(
      async () => {
        await fixture.persistence.executeInitializeProjectRoleSlots(initCmd);
      },
      (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
      "Replay must fail closed on event_type relational drift",
    );
    await assert.rejects(
      async () => {
        await fixture.persistence.executeInitializeProjectRoleSlots(diffKeyCmd);
      },
      (err: any) => err instanceof ApplicationError && err.code === "ROLE_SLOT_RECORD_CORRUPT",
      "Different-key init must fail closed on event_type relational drift",
    );
    assert.equal(getReceiptCount(), baselineReceiptCount, "Must create zero new receipts on relational event_type drift");

    // Restore event_type
    const dbRestoreC = new DatabaseSync((fixture as any).path);
    dbRestoreC.prepare("UPDATE domain_events SET event_type = ? WHERE tenant_id = ? AND event_id = ?").run(res.event.eventType, tenant, res.event.eventId);
    dbRestoreC.close();

    // Uncorrupted different-key init now succeeds and creates exactly one new receipt
    const successDiff = await fixture.persistence.executeInitializeProjectRoleSlots(diffKeyCmd);
    assert.equal(successDiff.replayed, false);
    assert.equal(getReceiptCount(), baselineReceiptCount + 1, "Exactly one new receipt created after valid coherence validation");

    // Sub-test D: Role binding replay with domain_events relational drift
    const bindCmd: AssignProjectRoleBindingCommand = {
      tenantId: tenant,
      commandId: "cmd-c5-f2-bind",
      idempotencyKey: "idem-c5-f2-bind",
      correlationId: "corr-c5-bind",
      principalId: manager,
      projectId: pId,
      slotKey: "reviewer_qa",
      principalIds: [memberU1],
      expectedVersion: 0,
      occurredAtUtc: atUtc,
    };
    const bindRes = await fixture.persistence.executeAssignProjectRoleBinding(bindCmd);
    assert.equal(bindRes.replayed, false);

    // Tamper domain_events project_sequence for binding event
    const dbD = new DatabaseSync((fixture as any).path);
    dbD.prepare("UPDATE domain_events SET project_sequence = 999 WHERE tenant_id = ? AND event_id = ?").run(tenant, bindRes.event.eventId);
    dbD.close();

    await assert.rejects(
      async () => {
        await fixture.persistence.executeAssignProjectRoleBinding(bindCmd);
      },
      (err: any) => err instanceof ApplicationError && err.code === "ROLE_BINDING_RECORD_CORRUPT",
      "Role binding replay must fail closed on domain_events relational project_sequence drift",
    );
  } finally {
    await fixture.cleanup();
  }
});


