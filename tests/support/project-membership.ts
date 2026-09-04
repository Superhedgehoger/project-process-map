import type { Persistence } from "../../packages/application/src/ports/persistence.ts";
import type { PrincipalId, TenantId } from "../../packages/domain/src/identity.ts";

export async function grantProjectMembership(
  persistence: Persistence,
  tenantId: TenantId,
  projectId: string,
  principalId: PrincipalId,
  options: Readonly<{
    role?: "project_manager" | "member";
    securityDomainIds?: readonly string[];
  }> = {},
): Promise<void> {
  const occurredAtUtc = "2026-09-04T00:00:00.000Z";
  await persistence.transaction(tenantId, async (transaction) => {
    if (await transaction.principals.get(principalId) === undefined) await transaction.principals.insert({
      tenantId,
      id: principalId,
      kind: "user",
      status: "active",
      version: 1,
      createdAtUtc: occurredAtUtc,
      updatedAtUtc: occurredAtUtc,
    });
    if (await transaction.memberships.get(projectId, principalId) === undefined) await transaction.memberships.insert({
      tenantId,
      projectId,
      principalId,
      role: options.role ?? "member",
      status: "active",
      securityDomainIds: [...(options.securityDomainIds ?? [])],
      version: 1,
      createdAtUtc: occurredAtUtc,
      updatedAtUtc: occurredAtUtc,
    });
  });
}
