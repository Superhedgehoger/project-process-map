import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
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
      await transaction.securityMigrations.update(checkpoint, active.version);
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
      await transaction.securityMigrations.update(next, restored?.version ?? 0);
      await assert.rejects(transaction.securityMigrations.update(next, restored?.version ?? 0), /VERSION_CONFLICT/);
    });
    await second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function migration(): SecurityDomainMigration {
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
  };
}
