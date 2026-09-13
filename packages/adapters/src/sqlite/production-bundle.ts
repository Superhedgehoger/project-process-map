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
  };
}
