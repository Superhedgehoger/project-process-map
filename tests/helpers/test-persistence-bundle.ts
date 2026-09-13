import type { ExternalCollaborationEpochReadinessPort } from "../../packages/application/src/ports/integrations.ts";
import type { Persistence } from "../../packages/application/src/ports/persistence.ts";
import type { VerifyMigrationReadiness } from "../../packages/application/src/security/security-migration-coordinator.ts";
import type { TestReadinessHarness } from "../../packages/adapters/src/security-migration-coordinator.ts";
import { MemoryPersistence } from "../../packages/adapters/src/memory/persistence.ts";
import { SqlitePersistence } from "../../packages/adapters/src/sqlite/persistence.ts";

export type TestMemoryBundle = Readonly<{
  persistence: MemoryPersistence;
  verifyMigrationReadiness?: VerifyMigrationReadiness | undefined;
  testHarness: TestReadinessHarness;
}>;

export type TestSqliteBundle = Readonly<{
  persistence: SqlitePersistence;
  verifyMigrationReadiness?: VerifyMigrationReadiness | undefined;
  testHarness: TestReadinessHarness;
}>;

const testHarnessRegistry = new WeakMap<Persistence, TestReadinessHarness>();

export function getTestReadinessHarness(persistence: Persistence): TestReadinessHarness | undefined {
  return testHarnessRegistry.get(persistence);
}

export function createTestMemoryBundle(options: {
  verifier?: ExternalCollaborationEpochReadinessPort | undefined;
  now?: (() => Date) | undefined;
} = {}): TestMemoryBundle {
  let harness: TestReadinessHarness | undefined;
  const persistence = new MemoryPersistence({
    now: options.now,
    verifier: options.verifier,
    attachTestHarness: (h) => {
      harness = h;
    },
  });
  if (harness === undefined) {
    throw new Error("Failed to initialize test harness on MemoryPersistence");
  }
  testHarnessRegistry.set(persistence, harness);
  return {
    persistence,
    verifyMigrationReadiness: persistence.verifyMigrationReadiness,
    testHarness: harness,
  };
}

export function createTestSqliteBundle(options: {
  path: string;
  verifier?: ExternalCollaborationEpochReadinessPort | undefined;
  busyTimeoutMilliseconds?: number | undefined;
  now?: (() => Date) | undefined;
}): TestSqliteBundle {
  let harness: TestReadinessHarness | undefined;
  const persistence = new SqlitePersistence({
    path: options.path,
    busyTimeoutMilliseconds: options.busyTimeoutMilliseconds,
    now: options.now,
    verifier: options.verifier,
    attachTestHarness: (h) => {
      harness = h;
    },
  });
  if (harness === undefined) {
    throw new Error("Failed to initialize test harness on SqlitePersistence");
  }
  testHarnessRegistry.set(persistence, harness);
  return {
    persistence,
    verifyMigrationReadiness: persistence.verifyMigrationReadiness,
    testHarness: harness,
  };
}
