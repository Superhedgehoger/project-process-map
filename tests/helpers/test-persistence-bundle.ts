import type { ExternalCollaborationEpochReadinessPort } from "../../packages/application/src/ports/integrations.ts";
import type {
  AssignNodeLeaderCommand,
  AssignNodeLeaderFailurePoint,
  AssignNodeLeaderResult,
  AssignProjectRoleBindingCommand,
  AssignProjectRoleBindingFailurePoint,
  AssignProjectRoleBindingResult,
  CreateNodeCommand,
  CreateNodeFailurePoint,
  CreateNodeResult,
  InitializeProjectRoleSlotsCommand,
  InitializeProjectRoleSlotsFailurePoint,
  InitializeProjectRoleSlotsResult,
  Persistence,
} from "../../packages/application/src/ports/persistence.ts";
import type { VerifyMigrationReadiness } from "../../packages/application/src/security/security-migration-coordinator.ts";
import type { TestReadinessHarness } from "../../packages/adapters/src/security-migration-coordinator.ts";
import { MemoryPersistence, type MemoryPersistenceSnapshot } from "../../packages/adapters/src/memory/persistence.ts";
import { SqlitePersistence } from "../../packages/adapters/src/sqlite/persistence.ts";

export type TestMemoryBundle = Readonly<{
  persistence: MemoryPersistence;
  verifyMigrationReadiness?: VerifyMigrationReadiness | undefined;
  testHarness: TestReadinessHarness;
  createNode: (command: CreateNodeCommand, failurePoint?: CreateNodeFailurePoint) => Promise<CreateNodeResult>;
  assignNodeLeader: (command: AssignNodeLeaderCommand, failurePoint?: AssignNodeLeaderFailurePoint) => Promise<AssignNodeLeaderResult>;
  assignProjectRoleBinding: (
    command: AssignProjectRoleBindingCommand,
    failurePoint?: AssignProjectRoleBindingFailurePoint,
  ) => Promise<AssignProjectRoleBindingResult>;
  initializeProjectRoleSlots: (command: InitializeProjectRoleSlotsCommand, failurePoint?: InitializeProjectRoleSlotsFailurePoint) => Promise<InitializeProjectRoleSlotsResult>;
}>;

export type TestSqliteBundle = Readonly<{
  persistence: SqlitePersistence;
  verifyMigrationReadiness?: VerifyMigrationReadiness | undefined;
  testHarness: TestReadinessHarness;
  createNode: (command: CreateNodeCommand, failurePoint?: CreateNodeFailurePoint) => Promise<CreateNodeResult>;
  assignNodeLeader: (command: AssignNodeLeaderCommand, failurePoint?: AssignNodeLeaderFailurePoint) => Promise<AssignNodeLeaderResult>;
  assignProjectRoleBinding: (
    command: AssignProjectRoleBindingCommand,
    failurePoint?: AssignProjectRoleBindingFailurePoint,
  ) => Promise<AssignProjectRoleBindingResult>;
  initializeProjectRoleSlots: (command: InitializeProjectRoleSlotsCommand, failurePoint?: InitializeProjectRoleSlotsFailurePoint) => Promise<InitializeProjectRoleSlotsResult>;
}>;


const testHarnessRegistry = new WeakMap<Persistence, TestReadinessHarness>();

export function getTestReadinessHarness(persistence: Persistence): TestReadinessHarness | undefined {
  return testHarnessRegistry.get(persistence);
}

export function createTestMemoryBundle(options: {
  verifier?: ExternalCollaborationEpochReadinessPort | undefined;
  now?: (() => Date) | undefined;
  snapshot?: MemoryPersistenceSnapshot | undefined;
} = {}): TestMemoryBundle {
  let harness: TestReadinessHarness | undefined;
  const persistence = new MemoryPersistence({
    now: options.now,
    verifier: options.verifier,
    snapshot: options.snapshot,
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
    createNode: (command, failurePoint) => persistence.executeCreateNode(command, failurePoint),
    assignNodeLeader: (command, failurePoint) => persistence.executeAssignNodeLeader(command, failurePoint),
    assignProjectRoleBinding: (command, failurePoint) => persistence.executeAssignProjectRoleBinding(command, failurePoint),
    initializeProjectRoleSlots: (command, failurePoint) => persistence.executeInitializeProjectRoleSlots(command, failurePoint),
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
    createNode: (command, failurePoint) => persistence.executeCreateNode(command, failurePoint),
    assignNodeLeader: (command, failurePoint) => persistence.executeAssignNodeLeader(command, failurePoint),
    assignProjectRoleBinding: (command, failurePoint) => persistence.executeAssignProjectRoleBinding(command, failurePoint),
    initializeProjectRoleSlots: (command, failurePoint) => persistence.executeInitializeProjectRoleSlots(command, failurePoint),
  };
}
