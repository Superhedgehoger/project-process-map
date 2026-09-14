import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import { ApplicationError } from "../packages/application/src/errors.ts";
import { BeginSecurityMigrationVerificationHandler } from "../packages/application/src/security/begin-security-migration-verification.ts";
import { ExecuteSecurityMigrationBatchHandler } from "../packages/application/src/security/execute-security-migration-batch.ts";
import type { Persistence } from "../packages/application/src/ports/persistence.ts";
import type { Asset } from "../packages/domain/src/assets.ts";
import { principalId, tenantId } from "../packages/domain/src/identity.ts";
import type { ProjectNode } from "../packages/domain/src/project-structure.ts";
import {
  effectiveSecurityDomains,
  transitionSecurityMigration,
  type SecurityDomainMigration,
} from "../packages/domain/src/security-migration.ts";
import type { ProductTask } from "../packages/domain/src/tasks.ts";

const tenant = tenantId("tenant-migration-verification");
const projectId = "verification-project";
const sourceDomainId = "verification-source";

type Fixture = Readonly<{
  name: "memory" | "sqlite";
  persistence: Persistence;
  path: string | null;
  cleanup(): Promise<void>;
}>;

async function fixture(name: "memory" | "sqlite"): Promise<Fixture> {
  if (name === "memory") {
    const persistence = new MemoryPersistence();
    return { name, persistence, path: null, cleanup: async () => await persistence.close() };
  }
  const directory = await mkdtemp(join(tmpdir(), "ppm-migration-verification-"));
  const path = join(directory, "verification.sqlite");
  const persistence = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
  return {
    name,
    persistence,
    path,
    cleanup: async () => { await persistence.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

function node(): ProjectNode {
  return {
    tenantId: tenant,
    id: "root",
    projectId,
    parentId: null,
    leaderPrincipalId: null,
    title: "root",
    kind: "work_package",
    securityDomainId: sourceDomainId,
    securityEpoch: 1,
    version: 1,
    deletedAtUtc: null,
  };
}

function task(): ProductTask {
  return {
    tenantId: tenant,
    id: "task",
    projectId,
    ownerNodeId: "root",
    securityDomainId: sourceDomainId,
    securityEpoch: 1,
    title: "task",
    assigneePrincipalId: null,
    requiresAcceptance: false,
    reviewerPrincipalId: null,
    executionState: "todo",
    reviewState: "not_required",
    version: 1,
    deletedAtUtc: null,
  };
}

function asset(): Asset {
  return {
    tenantId: tenant,
    id: "asset",
    projectId,
    ownerNodeId: "root",
    securityDomainId: sourceDomainId,
    securityEpoch: 1,
    uploaderPrincipalId: principalId("verification-uploader"),
    displayName: "asset.txt",
    contentType: "text/plain",
    size: 1,
    sha256: "c".repeat(64),
    lifecycleState: "available",
    failureCode: null,
    version: 1,
    deletedAtUtc: null,
  };
}

function plannedMigration(
  targetSecurityDomainId: string | null = "verification-target",
  overrides: Partial<SecurityDomainMigration> = {},
): SecurityDomainMigration {
  return {
    tenantId: tenant,
    id: "migration-verification",
    projectId,
    rootNodeId: "root",
    sourceSecurityDomainId: sourceDomainId,
    targetSecurityDomainId,
    hierarchyRevision: 1,
    sourceSecurityEpoch: 1,
    targetSecurityEpoch: 2,
    state: "planned",
    cursor: null,
    totalItems: 3,
    migratedItems: 0,
    failure: null,
    nextAttemptAtUtc: null,
    deadlineAtUtc: "2026-09-11T00:00:00.000Z",
    version: 1,
    createdAtUtc: "2026-09-10T09:00:00.000Z",
    updatedAtUtc: "2026-09-10T09:00:00.000Z",
    ...overrides,
  };
}

async function prepare(
  persistence: Persistence,
  options: Readonly<{ activate?: boolean; complete?: boolean; target?: string | null; totalItems?: number }> = {},
): Promise<SecurityDomainMigration> {
  const planned = plannedMigration(options.target, options.totalItems === undefined ? {} : { totalItems: options.totalItems });
  const active = transitionSecurityMigration(planned, "active", "2026-09-10T09:01:00.000Z");
  await persistence.transaction(tenant, async (transaction) => {
    await transaction.nodes.insert(node());
    await transaction.tasks.insert(task());
    await transaction.assets.insert(asset());
    await transaction.securityMigrations.insert(planned);
    if (options.activate !== false) {
      await transaction.securityMigrations.saveProgressPreservingPlan(active.id, active, planned.version);
    }
  });
  if (options.complete === true) {
    const result = await new ExecuteSecurityMigrationBatchHandler(persistence).execute({
      tenantId: tenant,
      migrationId: planned.id,
      expectedMigrationVersion: active.version,
      batchSize: 3,
      occurredAtUtc: "2026-09-10T09:02:00.000Z",
    });
    return await persistence.read(tenant, async (transaction) => {
      const migration = await transaction.securityMigrations.get(result.migrationId);
      return migration as SecurityDomainMigration;
    });
  }
  return options.activate === false ? planned : active;
}

function command(expectedMigrationVersion: number) {
  return {
    tenantId: tenant,
    migrationId: "migration-verification",
    expectedMigrationVersion,
    occurredAtUtc: "2026-09-10T09:03:00.000Z",
  } as const;
}

test("TC-SEC-002G only a complete target inventory enters verifying", async () => {
  for (const target of ["verification-target", null] as const) {
    for (const name of ["memory", "sqlite"] as const) {
      const current = await fixture(name);
      try {
        const completed = await prepare(current.persistence, { complete: true, target });
        const result = await new BeginSecurityMigrationVerificationHandler(current.persistence)
          .execute(command(completed.version));
        assert.deepEqual(result, {
          migrationId: completed.id,
          state: "verifying",
          cursor: completed.cursor,
          migratedItems: 3,
          totalItems: 3,
          migrationVersion: completed.version + 1,
        }, name);
        const stored = await current.persistence.read(tenant, async (transaction) =>
          await transaction.securityMigrations.get(completed.id));
        assert.deepEqual(stored, transitionSecurityMigration(completed, "verifying", command(completed.version).occurredAtUtc), name);
        assert.deepEqual(effectiveSecurityDomains(stored as SecurityDomainMigration), [sourceDomainId, target], name);
      } finally {
        await current.cleanup();
      }
    }
  }
});

test("TC-SEC-002G incomplete, non-active, missing, stale and mismatched plans remain unchanged", async () => {
  for (const name of ["memory", "sqlite"] as const) {
    for (const scenario of ["incomplete", "planned", "total", "out-of-order"] as const) {
      const current = await fixture(name);
      try {
        const migration = await prepare(current.persistence, {
          activate: scenario !== "planned",
          totalItems: scenario === "total" ? 4 : 3,
        });
        if (scenario === "out-of-order") await current.persistence.transaction(tenant, async (transaction) => {
          await transaction.assets.migrateSecurityOwnership(migration.id, "asset", 1);
        });
        const before = await current.persistence.read(tenant, async (transaction) =>
          await transaction.securityMigrations.get(migration.id));
        await assert.rejects(
          new BeginSecurityMigrationVerificationHandler(current.persistence).execute(command(migration.version)),
          (error) => error instanceof ApplicationError
            && ["SECURITY_MIGRATION_VERIFICATION_INVALID", "SECURITY_MIGRATION_INVENTORY_INVALID"].includes(error.code),
          `${name}:${scenario}`,
        );
        assert.deepEqual(await current.persistence.read(tenant, async (transaction) =>
          await transaction.securityMigrations.get(migration.id)), before, `${name}:${scenario}`);
      } finally {
        await current.cleanup();
      }
    }

    const current = await fixture(name);
    try {
      const completed = await prepare(current.persistence, { complete: true });
      const handler = new BeginSecurityMigrationVerificationHandler(current.persistence);
      await assert.rejects(handler.execute(command(completed.version - 1)), isCode("SECURITY_MIGRATION_VERSION_CONFLICT"));
      await assert.rejects(handler.execute({ ...command(completed.version), migrationId: "missing" }), isCode("SECURITY_MIGRATION_NOT_FOUND"));
      await assert.rejects(handler.execute({ ...command(completed.version), expectedMigrationVersion: 0 }), isCode("VALIDATION_FAILED"));
    } finally {
      await current.cleanup();
    }
  }
});

test("TC-SEC-002G SQLite concurrent verification advances once and survives restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-migration-verification-race-"));
  const path = join(directory, "verification.sqlite");
  const first = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
  try {
    const completed = await prepare(first, { complete: true });
    const second = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
    const settled = await Promise.allSettled([
      new BeginSecurityMigrationVerificationHandler(first).execute(command(completed.version)),
      new BeginSecurityMigrationVerificationHandler(second).execute(command(completed.version)),
    ]);
    assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
    await second.close();
    await first.close();

    const restarted = new SqlitePersistence({ path });
    try {
      const stored = await restarted.read(tenant, async (transaction) =>
        await transaction.securityMigrations.get(completed.id));
      assert.equal(stored?.state, "verifying");
      assert.equal(stored?.version, completed.version + 1);
      assert.deepEqual(effectiveSecurityDomains(stored as SecurityDomainMigration), [sourceDomainId, "verification-target"]);
    } finally {
      await restarted.close();
    }
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function isCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ApplicationError && error.code === code;
}
