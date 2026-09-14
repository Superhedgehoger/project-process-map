import type {
  AssignNodeLeaderCommand,
  AssignNodeLeaderFailurePoint,
  AssignNodeLeaderResult,
  CreateNodeCommand,
  CreateNodeFailurePoint,
  CreateNodeResult,
} from "../../../application/src/ports/persistence.ts";
import type { VerifyMigrationReadiness } from "../../../application/src/security/security-migration-coordinator.ts";
import { HulyRestCollaborationEpochReadinessAdapter, type HulyRestConfig } from "../huly-rest.ts";
import { SqlitePersistence } from "./persistence.ts";

export type ProductionSqliteBundleOptions = Readonly<{
  databasePath: string;
  busyTimeoutMilliseconds?: number | undefined;
  now?: (() => Date) | undefined;
  hulyConfig?: HulyRestConfig | undefined;
}>;

export type ProductionSqliteBundle = Readonly<{
  persistence: SqlitePersistence;
  verifyMigrationReadiness?: VerifyMigrationReadiness | undefined;
  createNode: (command: CreateNodeCommand, failurePoint?: CreateNodeFailurePoint) => Promise<CreateNodeResult>;
  assignNodeLeader: (command: AssignNodeLeaderCommand, failurePoint?: AssignNodeLeaderFailurePoint) => Promise<AssignNodeLeaderResult>;
}>;

export function createProductionSqliteBundle(options: ProductionSqliteBundleOptions): ProductionSqliteBundle {
  const verifier = options.hulyConfig !== undefined
    ? new HulyRestCollaborationEpochReadinessAdapter(options.hulyConfig)
    : undefined;
  const persistence = new SqlitePersistence({
    path: options.databasePath,
    busyTimeoutMilliseconds: options.busyTimeoutMilliseconds,
    now: options.now,
    verifier,
  });
  return {
    persistence,
    verifyMigrationReadiness: persistence.verifyMigrationReadiness,
    createNode: (command, failurePoint) => persistence.executeCreateNode(command, failurePoint),
    assignNodeLeader: (command, failurePoint) => persistence.executeAssignNodeLeader(command, failurePoint),
  };
}
