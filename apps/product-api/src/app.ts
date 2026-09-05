import type { IncomingMessage, ServerResponse } from "node:http";
import { executeCreateNode } from "../../../packages/application/src/create-node.ts";
import { ApplicationError, asApplicationError } from "../../../packages/application/src/errors.ts";
import { resolveExternalIdentity } from "../../../packages/application/src/identity/resolve-external-identity.ts";
import { IntegrationRecoveryService } from "../../../packages/application/src/integrations/recover-integration.ts";
import type { AssetContentPort, ExternalIdentityVerifier } from "../../../packages/application/src/ports/integrations.ts";
import type { Persistence } from "../../../packages/application/src/ports/persistence.ts";
import { principalId, tenantId, type PrincipalId, type TenantId } from "../../../packages/domain/src/identity.ts";
import type { ProjectNode } from "../../../packages/domain/src/project-structure.ts";
import { buildHulyConfigurationReport } from "./health.ts";
import { sendHtml, sendJson, setCors } from "./http.ts";
import { routeProjectRequest, type ProductRequestIdentity } from "./routes/project.ts";
import { routeRecoveryRequest } from "./routes/recovery.ts";
import { productWebHtml } from "./web.ts";

export type ProductApiOptions = {
  collaborationMode: "disabled" | "huly";
  persistence: Persistence;
  assetContent: AssetContentPort;
  tenantId?: TenantId;
  externalIdentityVerifier?: ExternalIdentityVerifier | undefined;
  collaborationProjectionConfigured?: boolean | undefined;
  allowedOrigin?: string | undefined;
  recoveryOperatorPrincipalIds?: readonly PrincipalId[] | undefined;
};

export function createProductApi(options: ProductApiOptions) {
  const persistence = options.persistence;
  const assetContent = options.assetContent;
  const productTenantId = options.tenantId ?? tenantId("phase0-tenant");
  const collaborationConfigured = hulyConfigured(options);
  const recoveryOperators = new Set<string>(options.recoveryOperatorPrincipalIds ?? []);
  const recovery = new IntegrationRecoveryService(persistence, {
    canRecover: async (tenant, principal) => tenant === productTenantId && recoveryOperators.has(principal),
  });
  const ready = seedPhase0Nodes(persistence, productTenantId);

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    setCors(response, options.allowedOrigin ?? "http://localhost:8089");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    try {
      const url = new URL(request.url ?? "/", "http://product-api.local");
      if (request.method === "GET" && url.pathname === "/") {
        sendHtml(response, productWebHtml);
        return;
      }
      if (request.method === "GET" && url.pathname === "/health") {
        const report = options.collaborationMode === "huly"
          ? buildHulyConfigurationReport(collaborationConfigured)
          : nativeHealthReport();
        sendJson(response, report.status === "ok" ? 200 : 503, { ...report, collaborationMode: options.collaborationMode });
        return;
      }
      await ready;
      const identity = await requestIdentity(request, options, productTenantId, persistence);
      if (await routeRecoveryRequest(request, response, url, identity, recovery)) return;
      if (await routeProjectRequest(request, response, url, identity, {
        persistence,
        assetContent,
        scheduleCollaborationProjection: collaborationConfigured,
      })) return;
      sendJson(response, 404, { code: "NOT_FOUND", message: "Route not found" });
    } catch (cause) {
      const error = asApplicationError(cause);
      sendJson(response, httpStatus(error), { code: error.code, message: error.message });
    }
  };
}

export async function seedPhase0Nodes(persistence: Persistence, productTenantId: TenantId): Promise<void> {
  const seededAtUtc = "2026-09-03T00:00:00.000Z";
  await persistence.transaction(productTenantId, async (transaction) => {
    for (const id of [principalId("phase0-system"), principalId("phase0-user")]) {
      if (await transaction.principals.get(id) === undefined) await transaction.principals.insert({
        tenantId: productTenantId,
        id,
        kind: id === "phase0-system" ? "service" : "user",
        status: "active",
        version: 1,
        createdAtUtc: seededAtUtc,
        updatedAtUtc: seededAtUtc,
      });
      if (await transaction.memberships.get("phase0-project", id) === undefined) await transaction.memberships.insert({
        tenantId: productTenantId,
        projectId: "phase0-project",
        principalId: id,
        role: "project_manager",
        status: "active",
        securityDomainIds: [],
        version: 1,
        createdAtUtc: seededAtUtc,
        updatedAtUtc: seededAtUtc,
      });
    }
  });
  const nodes: Array<Pick<ProjectNode, "id" | "title" | "kind">> = [
    { id: "N-01", title: "项目启动", kind: "stage" },
    { id: "N-02", title: "需求澄清", kind: "stage" },
    { id: "N-03", title: "方案设计", kind: "work_package" },
    { id: "N-04", title: "开发与联调", kind: "work_package" },
    { id: "N-05", title: "测试验收", kind: "work_package" },
    { id: "N-06", title: "发布复盘", kind: "milestone" },
  ];
  for (const [index, node] of nodes.entries()) {
    if (await persistence.read(productTenantId, async (transaction) => await transaction.nodes.get(node.id)) !== undefined) continue;
    await executeCreateNode(persistence, {
      tenantId: productTenantId,
      commandId: `phase0-node-${index + 1}`,
      idempotencyKey: `phase0-node-${index + 1}`,
      correlationId: "phase0-seed",
      principalId: principalId("phase0-system"),
      projectId: "phase0-project",
      nodeId: node.id,
      parentId: null,
      title: node.title,
      kind: node.kind,
      securityDomainId: null,
      occurredAtUtc: seededAtUtc,
    });
  }
}

async function requestIdentity(
  request: IncomingMessage,
  options: ProductApiOptions,
  productTenantId: TenantId,
  persistence: Persistence,
): Promise<ProductRequestIdentity> {
  if (options.collaborationMode === "disabled") return { tenantId: productTenantId, principalId: principalId("phase0-user") };
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer ")) throw new ApplicationError("UNAUTHORIZED", "Bearer token is required");
  const credential = authorization.slice("Bearer ".length).trim();
  if (credential.length === 0) throw new ApplicationError("UNAUTHORIZED", "Bearer token is required");
  if (options.externalIdentityVerifier === undefined) throw new ApplicationError("HULY_ADAPTER_NOT_CONFIGURED", "Huly connection is not configured");
  const external = await options.externalIdentityVerifier.authenticate(credential);
  return {
    tenantId: productTenantId,
    principalId: await resolveExternalIdentity(persistence, { tenantId: productTenantId, ...external }),
  };
}

function hulyConfigured(options: ProductApiOptions): boolean {
  return options.externalIdentityVerifier !== undefined && options.collaborationProjectionConfigured === true;
}

function nativeHealthReport() {
  return {
    status: "ok" as const,
    checkedAt: new Date().toISOString(),
    components: [
      { component: "product-api", status: "ok" as const, version: "0.0.1" },
      { component: "persistence", status: "ok" as const, version: "application-port" },
      { component: "asset-content", status: "ok" as const, version: "application-port" },
    ],
  };
}

function httpStatus(error: ApplicationError): number {
  const statuses: Partial<Record<ApplicationError["code"], number>> = {
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    NODE_NOT_FOUND: 404,
    TASK_NOT_FOUND: 404,
    INTEGRATION_OPERATION_NOT_FOUND: 404,
    TASK_ALREADY_EXISTS: 409,
    TASK_VERSION_CONFLICT: 409,
    NODE_VERSION_CONFLICT: 409,
    NODE_ALREADY_SENSITIVE: 409,
    SECURITY_DOMAIN_ALREADY_EXISTS: 409,
    SECURITY_ROOT_REQUIRES_EMPTY_LEAF: 409,
    SECURITY_DOMAIN_ID_IN_USE: 409,
    SECURITY_DOMAIN_VERSION_CONFLICT: 409,
    SECURITY_GRANT_VERSION_CONFLICT: 409,
    SECURITY_DOMAIN_LAST_ADMINISTRATOR: 409,
    ASSET_ALREADY_EXISTS: 409,
    IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD: 409,
    CONFLICT: 409,
    INTEGRATION_OPERATION_VERSION_CONFLICT: 409,
    INTEGRATION_OPERATION_NOT_RECOVERABLE: 409,
    INTEGRATION_OPERATION_REQUIRES_SPECIALIZED_RECOVERY: 409,
    INTEGRATION_RECOVERY_JOB_NOT_DEAD_LETTER: 409,
    TASK_ACTION_FORBIDDEN: 403,
    SECURITY_ROOT_FORBIDDEN: 403,
    REVIEWER_NOT_ELIGIBLE: 403,
    ASSIGNEE_NOT_ELIGIBLE: 403,
    SECURITY_MIGRATION_IN_PROGRESS: 409,
    HULY_ADAPTER_NOT_CONFIGURED: 503,
    UPSTREAM_FAILURE: 502,
  };
  return statuses[error.code] ?? 422;
}
