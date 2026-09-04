import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { IntegrationRecoveryService } from "../../../../packages/application/src/integrations/recover-integration.ts";
import type { ProductRequestIdentity } from "./project.ts";
import { deterministicPublicId, readJson, requiredHeader, requiredPositiveInteger, requiredString, sendJson } from "../http.ts";

export async function routeRecoveryRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  identity: ProductRequestIdentity,
  recovery: IntegrationRecoveryService,
): Promise<boolean> {
  if (request.method === "GET" && url.pathname === "/api/operator/integration-operations") {
    sendJson(response, 200, await recovery.list(identity.tenantId, identity.principalId));
    return true;
  }
  const match = url.pathname.match(/^\/api\/operator\/integration-operations\/([^/]+)\/retry$/);
  if (request.method !== "POST" || match?.[1] === undefined) return false;
  const body = await readJson(request);
  const idempotencyKey = requiredHeader(request, "idempotency-key");
  const operationId = decodeURIComponent(match[1]);
  const principalKey = `${identity.tenantId}\u0000${identity.principalId}\u0000${idempotencyKey}`;
  const result = await recovery.retry({
    tenantId: identity.tenantId,
    principalId: identity.principalId,
    commandId: deterministicPublicId("cmd-recovery", principalKey),
    idempotencyKey,
    correlationId: request.headers["x-correlation-id"]?.toString() ?? randomUUID(),
    operationId,
    expectedVersion: requiredPositiveInteger(body, "expectedVersion"),
    reason: requiredString(body, "reason"),
    occurredAtUtc: new Date().toISOString(),
  });
  sendJson(response, result.replayed ? 200 : 202, result);
  return true;
}
