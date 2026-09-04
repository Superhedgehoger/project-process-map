import type { PrincipalId, TenantId } from "./identity.ts";

export type TaskExecutionState = "todo" | "in_progress" | "completed" | "canceled" | "promoted";
export type TaskReviewState = "not_required" | "not_submitted" | "pending" | "accepted" | "rejected" | "withdrawn";
export type TaskLifecycleState = "todo" | "in_progress" | "pending_review" | "completed" | "canceled" | "promoted";

export type ProductTask = Readonly<{
  tenantId: TenantId;
  id: string;
  projectId: string;
  ownerNodeId: string;
  securityDomainId: string | null;
  securityEpoch: number;
  title: string;
  assigneePrincipalId: PrincipalId | null;
  requiresAcceptance: boolean;
  executionState: TaskExecutionState;
  reviewState: TaskReviewState;
  version: number;
  deletedAtUtc: string | null;
}>;

export type TaskReviewAction = "submitted" | "accepted" | "rejected" | "withdrawn";

export type TaskReviewCycle = Readonly<{
  tenantId: TenantId;
  taskId: string;
  cycle: number;
  action: TaskReviewAction;
  actorPrincipalId: PrincipalId;
  occurredAtUtc: string;
  comment: string | null;
}>;

export function taskLifecycle(task: Pick<ProductTask, "executionState" | "reviewState">): TaskLifecycleState {
  if (task.executionState === "canceled" || task.executionState === "promoted") return task.executionState;
  if (task.reviewState === "pending") return "pending_review";
  if (task.reviewState === "accepted" || task.executionState === "completed") return "completed";
  return task.executionState === "todo" ? "todo" : "in_progress";
}

export function startTask(task: ProductTask): ProductTask {
  assertMutable(task);
  if (task.executionState !== "todo") throw new Error("TASK_START_TRANSITION_INVALID");
  return { ...task, executionState: "in_progress", version: task.version + 1 };
}

export function submitTask(task: ProductTask): ProductTask {
  assertMutable(task);
  if (!task.requiresAcceptance) throw new Error("TASK_REVIEW_NOT_REQUIRED");
  if (task.executionState !== "in_progress") throw new Error("TASK_SUBMIT_TRANSITION_INVALID");
  if (task.reviewState !== "not_submitted" && task.reviewState !== "rejected" && task.reviewState !== "withdrawn") {
    throw new Error("TASK_SUBMIT_TRANSITION_INVALID");
  }
  return { ...task, reviewState: "pending", version: task.version + 1 };
}

export function acceptTask(task: ProductTask): ProductTask {
  if (task.reviewState !== "pending" || task.executionState !== "in_progress") throw new Error("TASK_ACCEPT_TRANSITION_INVALID");
  return { ...task, executionState: "completed", reviewState: "accepted", version: task.version + 1 };
}

export function rejectTask(task: ProductTask): ProductTask {
  if (task.reviewState !== "pending" || task.executionState !== "in_progress") throw new Error("TASK_REJECT_TRANSITION_INVALID");
  return { ...task, reviewState: "rejected", version: task.version + 1 };
}

export function withdrawTask(task: ProductTask): ProductTask {
  if (task.reviewState !== "pending" || task.executionState !== "in_progress") throw new Error("TASK_WITHDRAW_TRANSITION_INVALID");
  return { ...task, reviewState: "withdrawn", version: task.version + 1 };
}

export function completeTaskWithoutReview(task: ProductTask): ProductTask {
  assertMutable(task);
  if (task.requiresAcceptance || task.reviewState !== "not_required" || task.executionState !== "in_progress") {
    throw new Error("TASK_DIRECT_COMPLETE_FORBIDDEN");
  }
  return { ...task, executionState: "completed", version: task.version + 1 };
}

export function cancelTask(task: ProductTask): ProductTask {
  assertMutable(task);
  if (task.reviewState === "pending") throw new Error("TASK_PENDING_REVIEW_CANNOT_CANCEL");
  return { ...task, executionState: "canceled", version: task.version + 1 };
}

export function promoteTask(task: ProductTask): ProductTask {
  if (task.executionState !== "completed") throw new Error("TASK_PROMOTE_TRANSITION_INVALID");
  if (task.requiresAcceptance && task.reviewState !== "accepted") throw new Error("TASK_PROMOTE_REQUIRES_ACCEPTANCE");
  return { ...task, executionState: "promoted", version: task.version + 1 };
}

function assertMutable(task: ProductTask): void {
  if (task.executionState === "completed" || task.executionState === "canceled" || task.executionState === "promoted") {
    throw new Error("TASK_IS_TERMINAL");
  }
}
