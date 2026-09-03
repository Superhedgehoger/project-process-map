declare const tenantIdBrand: unique symbol;
declare const principalIdBrand: unique symbol;

export type TenantId = string & { readonly [tenantIdBrand]: true };
export type PrincipalId = string & { readonly [principalIdBrand]: true };

function identifier(name: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${name} is required`);
  if (normalized.includes("\u0000")) throw new Error(`${name} contains an invalid character`);
  return normalized;
}

export function tenantId(value: string): TenantId {
  return identifier("tenantId", value) as TenantId;
}

export function principalId(value: string): PrincipalId {
  return identifier("principalId", value) as PrincipalId;
}

export type RequestContext = Readonly<{
  tenantId: TenantId;
  principalId: PrincipalId;
  correlationId: string;
}>;

export type ExternalIdentityMapping = Readonly<{
  tenantId: TenantId;
  principalId: PrincipalId;
  provider: string;
  connectionId: string;
  externalTenantRef: string;
  externalSubjectRef: string;
  status: "active" | "revoked";
  version: number;
}>;

