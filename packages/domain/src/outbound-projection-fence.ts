import type { TenantId } from "./identity.ts";

export type OutboundProjectionFence = Readonly<{
  tenantId: TenantId;
  id: string;
  projectId: string;
  ownerNodeId: string;
  token: string;
  expiresAtUtc: string;
  createdAtUtc: string;
}>;
