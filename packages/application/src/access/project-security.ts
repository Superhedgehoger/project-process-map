import { ApplicationError } from "../errors.ts";
import type { TransactionContext } from "../ports/persistence.ts";

/**
 * P0-07 will apply source/target domain intersections per object. Until then,
 * fail closed for the entire project so a partial migration cannot expose data.
 */
export async function assertProjectSecurityStable(
  transaction: TransactionContext,
  projectId: string,
): Promise<void> {
  const open = (await transaction.securityMigrations.listRecoverable())
    .some((migration) => migration.projectId === projectId);
  if (open) throw new ApplicationError(
    "SECURITY_MIGRATION_IN_PROGRESS",
    "Project access is temporarily frozen during a security-domain migration",
  );
}
