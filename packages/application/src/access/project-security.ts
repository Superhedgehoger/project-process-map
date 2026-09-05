import { ApplicationError } from "../errors.ts";
import type { TransactionContext } from "../ports/persistence.ts";
import type { PrincipalId } from "../../../domain/src/identity.ts";
import type { ProjectMembership } from "../../../domain/src/project-access.ts";
import { grantAllows, type SecurityCapability } from "../../../domain/src/security-access.ts";

export async function canAccessProjectObject(
  transaction: TransactionContext,
  membership: ProjectMembership | undefined,
  principalId: PrincipalId,
  projectId: string,
  securityDomainId: string | null,
  requiredCapability: SecurityCapability,
  atUtc: string,
): Promise<boolean> {
  if (membership?.status !== "active" || membership.projectId !== projectId) return false;
  if (securityDomainId === null) return true;
  const domain = await transaction.securityDomains.get(securityDomainId);
  if (domain === undefined) {
    // v3 stored visibility only. It must never be promoted into a write or access-management capability.
    return requiredCapability === "view" && membership.securityDomainIds.includes(securityDomainId);
  }
  if (domain.projectId !== projectId || domain.deletedAtUtc !== null) return false;
  if (requiredCapability === "manage_access" && membership.role !== "project_manager") return false;
  // Nested-domain intersection is deliberately fail-closed until TC-SEC-002.
  if (domain.parentSecurityDomainId !== null) return false;
  return grantAllows(await transaction.securityGrants.get(domain.id, principalId), requiredCapability, atUtc);
}

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
