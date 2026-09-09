import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import type { Persistence } from "../packages/application/src/ports/persistence.ts";
import { tenantId } from "../packages/domain/src/identity.ts";
import {
  checkpointSecurityMigration,
  effectiveSecurityDomains,
  transitionSecurityMigration,
  type SecurityDomainMigration,
} from "../packages/domain/src/security-migration.ts";

const tenant = tenantId("tenant-security-migration");

test("ARCH-GATE-SECURITY-002 migration cursor survives restart and stale workers cannot overwrite progress", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-security-migration-"));
  const path = join(directory, "security.sqlite");
  try {
    const first = new SqlitePersistence({ path });
    await first.transaction(tenant, async (transaction) => {
      await transaction.nodes.insert({
        tenantId: tenant,
        id: "node-root",
        projectId: "project-1",
        parentId: null,
        title: "敏感阶段",
        kind: "work_package",
        securityDomainId: "domain-old",
        securityEpoch: 1,
        version: 1,
        deletedAtUtc: null,
      });
    });
    const planned = migration();
    const active = transitionSecurityMigration(planned, "active", "2026-09-04T05:01:00.000Z");
    const checkpoint = checkpointSecurityMigration(active, {
      cursor: "item-005",
      migratedItems: 5,
      occurredAtUtc: "2026-09-04T05:02:00.000Z",
    });
    await first.transaction(tenant, async (transaction) => {
      await transaction.securityMigrations.insert(active);
      await transaction.securityMigrations.saveProgressPreservingPlan(checkpoint.id, checkpoint, active.version);
      await assert.rejects(transaction.securityMigrations.insert({ ...planned, id: "migration-2" }), /ROOT_ALREADY_OPEN|UNIQUE/);
    });
    await first.close();

    const second = new SqlitePersistence({ path });
    const restored = await second.read(tenant, async (transaction) => await transaction.securityMigrations.get("migration-1"));
    assert.equal(restored?.cursor, "item-005");
    assert.equal(restored?.migratedItems, 5);
    assert.deepEqual(effectiveSecurityDomains(restored as SecurityDomainMigration), ["domain-old", "domain-new"]);
    const next = checkpointSecurityMigration(restored as SecurityDomainMigration, {
      cursor: "item-008",
      migratedItems: 8,
      occurredAtUtc: "2026-09-04T05:03:00.000Z",
    });
    await second.transaction(tenant, async (transaction) => {
      await transaction.securityMigrations.saveProgressPreservingPlan(next.id, next, restored?.version ?? 0);
      await assert.rejects(
        transaction.securityMigrations.saveProgressPreservingPlan(next.id, next, restored?.version ?? 0),
        /VERSION_CONFLICT/,
      );
    });
    await second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function migration(overrides: Partial<SecurityDomainMigration> = {}): SecurityDomainMigration {
  return {
    tenantId: tenant,
    id: "migration-1",
    projectId: "project-1",
    rootNodeId: "node-root",
    sourceSecurityDomainId: "domain-old",
    targetSecurityDomainId: "domain-new",
    hierarchyRevision: 1,
    sourceSecurityEpoch: 1,
    targetSecurityEpoch: 2,
    state: "planned",
    cursor: null,
    totalItems: 10,
    migratedItems: 0,
    failure: null,
    nextAttemptAtUtc: null,
    deadlineAtUtc: "2026-09-04T06:00:00.000Z",
    version: 1,
    createdAtUtc: "2026-09-04T05:00:00.000Z",
    updatedAtUtc: "2026-09-04T05:00:00.000Z",
    ...overrides,
  };
}

async function prepareMigration(
  persistence: Persistence,
  planned: SecurityDomainMigration = migration(),
): Promise<SecurityDomainMigration> {
  const active = transitionSecurityMigration(planned, "active", "2026-09-04T05:01:00.000Z");
  await persistence.transaction(tenant, async (transaction) => {
    await transaction.nodes.insert({
      tenantId: tenant,
      id: planned.rootNodeId,
      projectId: planned.projectId,
      parentId: null,
      title: planned.rootNodeId,
      kind: "work_package",
      securityDomainId: planned.sourceSecurityDomainId,
      securityEpoch: planned.sourceSecurityEpoch,
      version: 1,
      deletedAtUtc: null,
    });
    await transaction.securityMigrations.insert(active);
  });
  return active;
}

test("TC-SEC-002C migration progress save rejects every identity and plan rewrite", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "ppm-security-migration-plan-"));
    const persistence: Persistence = name === "memory"
      ? new MemoryPersistence()
      : new SqlitePersistence({ path: join(directory, "security.sqlite") });
    try {
      const active = await prepareMigration(persistence);
      const proposals: SecurityDomainMigration[] = [
        { ...active, tenantId: tenantId("other-tenant"), version: 3 },
        { ...active, id: "renamed-migration", version: 3 },
        { ...active, projectId: "other-project", version: 3 },
        { ...active, rootNodeId: "other-root", version: 3 },
        { ...active, sourceSecurityDomainId: "other-source", version: 3 },
        { ...active, targetSecurityDomainId: "other-target", version: 3 },
        { ...active, hierarchyRevision: 2, version: 3 },
        { ...active, sourceSecurityEpoch: 2, version: 3 },
        { ...active, targetSecurityEpoch: 3, version: 3 },
        { ...active, totalItems: 11, version: 3 },
        { ...active, deadlineAtUtc: "2026-09-04T07:00:00.000Z", version: 3 },
        { ...active, createdAtUtc: "2026-09-04T04:00:00.000Z", version: 3 },
      ];
      await persistence.transaction(tenant, async (transaction) => {
        for (const proposed of proposals) {
          await assert.rejects(
            transaction.securityMigrations.saveProgressPreservingPlan(active.id, proposed, active.version),
            /SECURITY_MIGRATION_PLAN_IMMUTABLE/,
            name,
          );
        }
      });
      const stored = await persistence.read(tenant, async (transaction) => transaction.securityMigrations.get(active.id));
      assert.deepEqual(stored, active, name);
    } finally {
      await persistence.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("TC-SEC-002C progress save accepts only domain transition or checkpoint output", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "ppm-security-migration-progress-"));
    const persistence: Persistence = name === "memory"
      ? new MemoryPersistence()
      : new SqlitePersistence({ path: join(directory, "security.sqlite") });
    try {
      const active = await prepareMigration(persistence);
      const checkpoint = checkpointSecurityMigration(active, {
        cursor: "item-005",
        migratedItems: 5,
        occurredAtUtc: "2026-09-04T05:02:00.000Z",
      });
      await persistence.transaction(tenant, async (transaction) => {
        await transaction.securityMigrations.saveProgressPreservingPlan(active.id, checkpoint, active.version);
      });
      const invalid: SecurityDomainMigration[] = [
        { ...checkpoint, state: "committed", cursor: null, migratedItems: checkpoint.totalItems, version: 4,
          updatedAtUtc: "2026-09-04T05:03:00.000Z" },
        { ...checkpoint, cursor: "item-004", migratedItems: 4, version: 4,
          updatedAtUtc: "2026-09-04T05:03:00.000Z" },
        { ...checkpoint, cursor: "item-011", migratedItems: 11, version: 4,
          updatedAtUtc: "2026-09-04T05:03:00.000Z" },
        { ...checkpoint, failure: "forged", version: 4, updatedAtUtc: "2026-09-04T05:03:00.000Z" },
      ];
      await persistence.transaction(tenant, async (transaction) => {
        for (const proposed of invalid) {
          await assert.rejects(
            transaction.securityMigrations.saveProgressPreservingPlan(checkpoint.id, proposed, checkpoint.version),
            /SECURITY_MIGRATION_(TRANSITION_INVALID|PROGRESS_INVALID)/,
            name,
          );
        }
      });
      const stored = await persistence.read(tenant, async (transaction) => transaction.securityMigrations.get(active.id));
      assert.deepEqual(stored, checkpoint, name);
      assert.deepEqual(effectiveSecurityDomains(stored as SecurityDomainMigration), ["domain-old", "domain-new"], name);
      const verifying = transitionSecurityMigration(checkpoint, "verifying", "2026-09-04T05:04:00.000Z");
      await persistence.transaction(tenant, async (transaction) => {
        await transaction.securityMigrations.saveProgressPreservingPlan(checkpoint.id, verifying, checkpoint.version);
      });
      const transitioned = await persistence.read(
        tenant,
        async (transaction) => transaction.securityMigrations.get(active.id),
      );
      assert.deepEqual(transitioned, verifying, name);
      assert.deepEqual(effectiveSecurityDomains(transitioned as SecurityDomainMigration), ["domain-old", "domain-new"], name);
    } finally {
      await persistence.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("TC-SEC-002C SQLite concurrent progress CAS and restart preserve the migration plan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-security-migration-race-"));
  const path = join(directory, "security.sqlite");
  const first = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
  try {
    const active = await prepareMigration(first);
    const second = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
    const left = checkpointSecurityMigration(active, {
      cursor: "item-003",
      migratedItems: 3,
      occurredAtUtc: "2026-09-04T05:02:00.000Z",
    });
    const right = checkpointSecurityMigration(active, {
      cursor: "item-004",
      migratedItems: 4,
      occurredAtUtc: "2026-09-04T05:02:01.000Z",
    });
    const results = await Promise.allSettled([
      first.transaction(tenant, async (transaction) => {
        await transaction.securityMigrations.saveProgressPreservingPlan(active.id, left, active.version);
      }),
      second.transaction(tenant, async (transaction) => {
        await transaction.securityMigrations.saveProgressPreservingPlan(active.id, right, active.version);
      }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    await second.close();
    await first.close();

    const restarted = new SqlitePersistence({ path });
    const stored = await restarted.read(tenant, async (transaction) => transaction.securityMigrations.get(active.id));
    assert.equal(stored?.version, 3);
    assert.ok(stored?.cursor === "item-003" || stored?.cursor === "item-004");
    assert.equal(stored?.projectId, active.projectId);
    assert.equal(stored?.rootNodeId, active.rootNodeId);
    assert.equal(stored?.sourceSecurityDomainId, active.sourceSecurityDomainId);
    assert.equal(stored?.targetSecurityDomainId, active.targetSecurityDomainId);
    assert.equal(stored?.hierarchyRevision, active.hierarchyRevision);
    assert.equal(stored?.totalItems, active.totalItems);
    assert.equal(stored?.deadlineAtUtc, active.deadlineAtUtc);
    assert.equal(stored?.createdAtUtc, active.createdAtUtc);
    await restarted.close();
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TC-SEC-002C SQLite rejects relational and JSON migration-plan drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-security-migration-drift-"));
  const path = join(directory, "security.sqlite");
  const persistence = new SqlitePersistence({ path });
  try {
    const firstPlan = migration();
    const secondPlan = migration({
      id: "migration-2",
      rootNodeId: "node-root-2",
      sourceSecurityDomainId: "domain-old-2",
      targetSecurityDomainId: "domain-new-2",
    });
    const thirdPlan = migration({
      id: "migration-3",
      rootNodeId: "node-root-3",
      sourceSecurityDomainId: "domain-old-3",
      targetSecurityDomainId: "domain-new-3",
    });
    const fourthPlan = migration({
      id: "migration-4",
      rootNodeId: "node-root-4",
      sourceSecurityDomainId: "domain-old-4",
      targetSecurityDomainId: "domain-new-4",
    });
    const firstActive = await prepareMigration(persistence, firstPlan);
    const secondActive = await prepareMigration(persistence, secondPlan);
    const thirdActive = await prepareMigration(persistence, thirdPlan);
    const fourthActive = await prepareMigration(persistence, fourthPlan);
    await persistence.transaction(tenant, async (transaction) => {
      await transaction.nodes.insert({
        tenantId: tenant,
        id: "node-root-drift",
        projectId: secondPlan.projectId,
        parentId: null,
        title: "node-root-drift",
        kind: "work_package",
        securityDomainId: secondPlan.sourceSecurityDomainId,
        securityEpoch: secondPlan.sourceSecurityEpoch,
        version: 1,
        deletedAtUtc: null,
      });
    });
    await persistence.close();

    const database = new DatabaseSync(path);
    database.prepare("UPDATE security_domain_migrations SET migration_json = ? WHERE tenant_id = ? AND migration_id = ?")
      .run(JSON.stringify({ ...firstActive, projectId: "drifted-project" }), tenant, firstActive.id);
    database.prepare("UPDATE security_domain_migrations SET root_node_id = ? WHERE tenant_id = ? AND migration_id = ?")
      .run("node-root-drift", tenant, secondActive.id);
    database.prepare("UPDATE security_domain_migrations SET migration_json = ? WHERE tenant_id = ? AND migration_id = ?")
      .run(JSON.stringify({ ...thirdActive, state: "committed" }), tenant, thirdActive.id);
    database.prepare("UPDATE security_domain_migrations SET version = ? WHERE tenant_id = ? AND migration_id = ?")
      .run(9, tenant, fourthActive.id);
    database.close();

    const reopened = new SqlitePersistence({ path });
    try {
      for (const active of [firstActive, secondActive, thirdActive, fourthActive]) {
        await assert.rejects(reopened.read(tenant, async (transaction) => {
          await transaction.securityMigrations.get(active.id);
        }), /SECURITY_MIGRATION_PERSISTENCE_INCONSISTENT/);
        const checkpoint = checkpointSecurityMigration(active, {
          cursor: "item-001",
          migratedItems: 1,
          occurredAtUtc: "2026-09-04T05:02:00.000Z",
        });
        await assert.rejects(reopened.transaction(tenant, async (transaction) => {
          await transaction.securityMigrations.saveProgressPreservingPlan(active.id, checkpoint, active.version);
        }), /SECURITY_MIGRATION_PERSISTENCE_INCONSISTENT/);
      }
      await assert.rejects(reopened.read(tenant, async (transaction) => {
        await transaction.securityMigrations.listRecoverable();
      }), /SECURITY_MIGRATION_PERSISTENCE_INCONSISTENT/);
    } finally {
      await reopened.close();
    }

    const evidence = new DatabaseSync(path, { readOnly: true });
    const firstRow = evidence.prepare(
      "SELECT project_id, migration_json FROM security_domain_migrations WHERE tenant_id = ? AND migration_id = ?",
    ).get(tenant, firstActive.id) as { project_id: string; migration_json: string };
    const secondRow = evidence.prepare(
      "SELECT root_node_id FROM security_domain_migrations WHERE tenant_id = ? AND migration_id = ?",
    ).get(tenant, secondActive.id) as { root_node_id: string };
    const thirdRow = evidence.prepare(
      "SELECT state, migration_json FROM security_domain_migrations WHERE tenant_id = ? AND migration_id = ?",
    ).get(tenant, thirdActive.id) as { state: string; migration_json: string };
    const fourthRow = evidence.prepare(
      "SELECT version, migration_json FROM security_domain_migrations WHERE tenant_id = ? AND migration_id = ?",
    ).get(tenant, fourthActive.id) as { version: number; migration_json: string };
    assert.equal(firstRow.project_id, firstActive.projectId);
    assert.equal((JSON.parse(firstRow.migration_json) as SecurityDomainMigration).projectId, "drifted-project");
    assert.equal(secondRow.root_node_id, "node-root-drift");
    assert.equal(thirdRow.state, "active");
    assert.equal((JSON.parse(thirdRow.migration_json) as SecurityDomainMigration).state, "committed");
    assert.equal(fourthRow.version, 9);
    assert.equal((JSON.parse(fourthRow.migration_json) as SecurityDomainMigration).version, fourthActive.version);
    evidence.close();
  } finally {
    await persistence.close();
    await rm(directory, { recursive: true, force: true });
  }
});
