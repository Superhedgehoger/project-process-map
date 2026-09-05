import type { HealthReport } from "./health.ts";

export type ApiNode = Readonly<{
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  kind: "stage" | "work_package" | "milestone";
  version: number;
}>;

export type ApiAsset = Readonly<{
  id: string;
  taskId: string;
  nodeId: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  lifecycleState: "initiated" | "uploading" | "scanning" | "available" | "quarantined" | "failed" | "deleted";
  scanState: "scanning" | "available" | "quarantined" | "failed";
  version: number;
}>;

export type ApiTaskSummary = Readonly<{
  id: string;
  nodeId: string;
  title: string;
  status: "todo" | "in_progress" | "pending_review" | "completed" | "canceled" | "promoted";
  assigneePrincipalId: string | null;
  requiresAcceptance: boolean;
  reviewerPrincipalId: string | null;
  version: number;
  reviewHistory: ApiTaskReviewAction[];
}>;

export type ApiTask = ApiTaskSummary & Readonly<{ files: ApiAsset[] }>;

export type ApiTaskReviewAction = Readonly<{
  cycleNumber: number;
  action: "submitted" | "accepted" | "rejected" | "withdrawn";
  actorPrincipalId: string;
  reviewerPrincipalId: string | null;
  occurredAtUtc: string;
  note: string | null;
}>;

export type ApiNodeDetail = Readonly<{ node: ApiNode; tasks: ApiTask[] }>;
export type ApiSecurityRoot = Readonly<{
  securityDomainId: string;
  rootNodeId: string;
  permissionVersion: number;
  creatorCapability: "manage_access";
  nodeVersion: number;
  securityEpoch: number;
}>;
export type CreateSecurityRootRequest = Readonly<{
  expectedNodeVersion: number;
  reason: string;
}>;
export type CreateTaskRequest = Readonly<{
  title: string;
  taskId?: string;
  requiresAcceptance?: boolean;
  reviewerPrincipalId?: string;
}>;
export type TaskActionRequest = Readonly<{
  expectedVersion: number;
  note?: string;
  assigneePrincipalId?: string;
  reviewerPrincipalId?: string;
}>;
export type AttachAssetRequest = Readonly<{
  name: string;
  contentType: string;
  contentBase64: string;
  fileId?: string;
  sha256?: string;
}>;
export type CommandResult<T> = Readonly<{ value: T; replayed: boolean }>;
export type ApiError = Readonly<{ code: string; message: string }>;
export type HealthResponse = HealthReport & Readonly<{ collaborationMode: "disabled" | "huly" }>;

export function decodeHealthResponse(value: unknown): HealthResponse {
  const record = object(value, "health response");
  const status = oneOf(record.status, ["ok", "degraded"] as const, "health status");
  const collaborationMode = oneOf(record.collaborationMode, ["disabled", "huly"] as const, "collaboration mode");
  const checkedAt = string(record.checkedAt, "checkedAt");
  if (!Array.isArray(record.components)) throw new ContractDecodeError("components must be an array");
  return {
    status,
    collaborationMode,
    checkedAt,
    components: record.components.map((item) => {
      const component = object(item, "health component");
      return {
        component: string(component.component, "component"),
        status: oneOf(component.status, ["ok", "degraded"] as const, "component status"),
        version: string(component.version, "version"),
      };
    }),
  };
}

export function decodeNodeList(value: unknown): ApiNode[] {
  if (!Array.isArray(value)) throw new ContractDecodeError("node list must be an array");
  return value.map(decodeNode);
}

export function decodeNodeDetail(value: unknown): ApiNodeDetail {
  const record = object(value, "node detail");
  if (!Array.isArray(record.tasks)) throw new ContractDecodeError("tasks must be an array");
  return { node: decodeNode(record.node), tasks: record.tasks.map(decodeTask) };
}

export function decodeCommandResult<T>(value: unknown, decode: (input: unknown) => T): CommandResult<T> {
  const record = object(value, "command result");
  if (typeof record.replayed !== "boolean") throw new ContractDecodeError("replayed must be boolean");
  return { value: decode(record.value), replayed: record.replayed };
}

export function decodeTask(value: unknown): ApiTask {
  const record = object(value, "task");
  if (!Array.isArray(record.files)) throw new ContractDecodeError("task files must be an array");
  return { ...decodeTaskSummary(record), files: record.files.map(decodeAsset) };
}

export function decodeTaskSummary(value: unknown): ApiTaskSummary {
  const record = object(value, "task");
  if (!Array.isArray(record.reviewHistory)) throw new ContractDecodeError("task reviewHistory must be an array");
  return {
    id: string(record.id, "task.id"),
    nodeId: string(record.nodeId, "task.nodeId"),
    title: string(record.title, "task.title"),
    status: oneOf(record.status, ["todo", "in_progress", "pending_review", "completed", "canceled", "promoted"] as const, "task.status"),
    assigneePrincipalId: nullableNonEmptyString(record.assigneePrincipalId, "task.assigneePrincipalId"),
    requiresAcceptance: boolean(record.requiresAcceptance, "task.requiresAcceptance"),
    reviewerPrincipalId: nullableNonEmptyString(record.reviewerPrincipalId, "task.reviewerPrincipalId"),
    version: positiveInteger(record.version, "task.version"),
    reviewHistory: record.reviewHistory.map(decodeTaskReviewAction),
  };
}

export function decodeTaskReviewAction(value: unknown): ApiTaskReviewAction {
  const record = object(value, "task review action");
  return {
    cycleNumber: positiveInteger(record.cycleNumber, "task review action.cycleNumber"),
    action: oneOf(record.action, ["submitted", "accepted", "rejected", "withdrawn"] as const, "task review action.action"),
    actorPrincipalId: string(record.actorPrincipalId, "task review action.actorPrincipalId"),
    reviewerPrincipalId: nullableNonEmptyString(record.reviewerPrincipalId, "task review action.reviewerPrincipalId"),
    occurredAtUtc: string(record.occurredAtUtc, "task review action.occurredAtUtc"),
    note: nullableNonEmptyString(record.note, "task review action.note"),
  };
}

export function decodeAsset(value: unknown): ApiAsset {
  const record = object(value, "asset");
  return {
    id: string(record.id, "asset.id"),
    taskId: string(record.taskId, "asset.taskId"),
    nodeId: string(record.nodeId, "asset.nodeId"),
    name: string(record.name, "asset.name"),
    contentType: string(record.contentType, "asset.contentType"),
    size: nonNegativeInteger(record.size, "asset.size"),
    sha256: string(record.sha256, "asset.sha256"),
    lifecycleState: oneOf(record.lifecycleState, ["initiated", "uploading", "scanning", "available", "quarantined", "failed", "deleted"] as const, "asset.lifecycleState"),
    scanState: oneOf(record.scanState, ["scanning", "available", "quarantined", "failed"] as const, "asset.scanState"),
    version: positiveInteger(record.version, "asset.version"),
  };
}

export function decodeSecurityRoot(value: unknown): ApiSecurityRoot {
  const record = object(value, "security root");
  return {
    securityDomainId: string(record.securityDomainId, "securityRoot.securityDomainId"),
    rootNodeId: string(record.rootNodeId, "securityRoot.rootNodeId"),
    permissionVersion: positiveInteger(record.permissionVersion, "securityRoot.permissionVersion"),
    creatorCapability: oneOf(record.creatorCapability, ["manage_access"] as const, "securityRoot.creatorCapability"),
    nodeVersion: positiveInteger(record.nodeVersion, "securityRoot.nodeVersion"),
    securityEpoch: positiveInteger(record.securityEpoch, "securityRoot.securityEpoch"),
  };
}

export class ContractDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractDecodeError";
  }
}

function decodeNode(value: unknown): ApiNode {
  const record = object(value, "node");
  return {
    id: string(record.id, "node.id"),
    projectId: string(record.projectId, "node.projectId"),
    parentId: record.parentId === null ? null : string(record.parentId, "node.parentId"),
    title: string(record.title, "node.title"),
    kind: oneOf(record.kind, ["stage", "work_package", "milestone"] as const, "node.kind"),
    version: positiveInteger(record.version, "node.version"),
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ContractDecodeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ContractDecodeError(`${name} must be a non-empty string`);
  return value;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new ContractDecodeError(`${name} must be boolean`);
  return value;
}

function nullableNonEmptyString(value: unknown, name: string): string | null {
  return value === null ? null : string(value, name);
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new ContractDecodeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ContractDecodeError(`${name} must be a non-negative integer`);
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, options: T, name: string): T[number] {
  if (typeof value !== "string" || !options.includes(value)) throw new ContractDecodeError(`${name} is invalid`);
  return value as T[number];
}
