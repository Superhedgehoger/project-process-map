import type { TenantId } from "../../../domain/src/identity.ts";
import type { SecurityMigrationReadinessEvidenceRecord } from "../ports/persistence.ts";

export type VerifyMigrationReadinessInput = Readonly<{
  tenantId: TenantId;
  migrationId: string;
  purpose: "commit" | "rollback";
}>;

export type VerifyMigrationReadinessResult = Readonly<{
  evidenceId: string;
  record?: SecurityMigrationReadinessEvidenceRecord | undefined;
}>;

export type VerifyMigrationReadiness = (
  input: VerifyMigrationReadinessInput,
) => Promise<VerifyMigrationReadinessResult>;
