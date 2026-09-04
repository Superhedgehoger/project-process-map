import { createHash } from "node:crypto";
import { principalId, type ExternalIdentityMapping, type Principal, type PrincipalId, type TenantId } from "../../../domain/src/identity.ts";
import type { Persistence } from "../ports/persistence.ts";

export type ResolveExternalIdentity = Readonly<{
  tenantId: TenantId;
  provider: string;
  connectionId: string;
  externalTenantRef: string;
  externalSubjectRef: string;
}>;

export async function resolveExternalIdentity(
  persistence: Persistence,
  input: ResolveExternalIdentity,
): Promise<PrincipalId> {
  validate(input);
  return await persistence.transaction(input.tenantId, async (transaction) => {
    const existing = await transaction.identities.findExternal(
      input.provider,
      input.connectionId,
      input.externalTenantRef,
      input.externalSubjectRef,
    );
    if (existing !== undefined) {
      if (existing.status !== "active") throw new Error("EXTERNAL_IDENTITY_REVOKED");
      const principal = await transaction.principals.get(existing.principalId);
      if (principal === undefined || principal.status !== "active") throw new Error("PRINCIPAL_REVOKED");
      return existing.principalId;
    }
    const stable = createHash("sha256").update([
      input.tenantId,
      input.provider,
      input.connectionId,
      input.externalTenantRef,
      input.externalSubjectRef,
    ].join("\u0000")).digest("hex").slice(0, 24);
    const nowUtc = new Date().toISOString();
    const internalPrincipalId = principalId(`principal-${stable}`);
    const principal: Principal = {
      tenantId: input.tenantId,
      id: internalPrincipalId,
      kind: "user",
      status: "active",
      version: 1,
      createdAtUtc: nowUtc,
      updatedAtUtc: nowUtc,
    };
    const mapping: ExternalIdentityMapping = {
      tenantId: input.tenantId,
      principalId: internalPrincipalId,
      provider: input.provider,
      connectionId: input.connectionId,
      externalTenantRef: input.externalTenantRef,
      externalSubjectRef: input.externalSubjectRef,
      status: "active",
      version: 1,
      createdAtUtc: nowUtc,
      updatedAtUtc: nowUtc,
    };
    await transaction.principals.insert(principal);
    await transaction.identities.insertExternal(mapping);
    return mapping.principalId;
  });
}

function validate(input: ResolveExternalIdentity): void {
  for (const [name, value] of Object.entries({
    provider: input.provider,
    connectionId: input.connectionId,
    externalTenantRef: input.externalTenantRef,
    externalSubjectRef: input.externalSubjectRef,
  })) if (value.trim().length === 0 || value.includes("\u0000")) throw new Error(`${name} is invalid`);
}
