import { createHash } from "node:crypto";
import { eventTopic, type DomainEvent, type OutboxMessage } from "../../../domain/src/events.ts";
import type { PrincipalId, TenantId } from "../../../domain/src/identity.ts";
import { isProjectManager } from "../../../domain/src/project-access.ts";
import {
  acceptTask,
  assignTaskAssignee,
  assignTaskReviewer,
  completeTaskWithoutReview,
  rejectTask,
  startTask,
  submitTask,
  withdrawTask,
  type ProductTask,
  type TaskReviewActionRecord,
} from "../../../domain/src/tasks.ts";
import { ApplicationError } from "../errors.ts";
import { assertProjectSecurityStable, canAccessProjectObject } from "../access/project-security.ts";
import type { CommandScope, Persistence, TransactionContext } from "../ports/persistence.ts";
import { toTaskView, type TaskView } from "./create-task.ts";

export type TaskCommandAction = "start" | "submit" | "accept" | "reject" | "withdraw" | "complete" | "assign_assignee" | "assign_reviewer";

export type ActOnTaskCommand = Readonly<{
  tenantId: TenantId;
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  principalId: PrincipalId;
  taskId: string;
  action: TaskCommandAction;
  expectedVersion: number;
  assigneePrincipalId: PrincipalId | null;
  reviewerPrincipalId: PrincipalId | null;
  note: string | null;
  occurredAtUtc: string;
}>;

export type ActOnTaskResult = Readonly<{ value: TaskView; replayed: boolean }>;

export class ActOnTaskHandler {
  readonly #persistence: Persistence;

  constructor(persistence: Persistence) {
    this.#persistence = persistence;
  }

  async execute(command: ActOnTaskCommand): Promise<ActOnTaskResult> {
    validate(command);
    const scope: CommandScope = {
      principalId: command.principalId,
      operation: `task_${command.action}`,
      idempotencyKey: command.idempotencyKey,
    };
    const fingerprint = hash({
      taskId: command.taskId,
      action: command.action,
      expectedVersion: command.expectedVersion,
      assigneePrincipalId: command.assigneePrincipalId,
      reviewerPrincipalId: command.reviewerPrincipalId,
      note: normalizedNote(command.note),
    });

    return await this.#persistence.transaction(command.tenantId, async (transaction) => {
      const authorizationAtUtc = new Date().toISOString();
      const task = await transaction.tasks.get(command.taskId);
      if (task === undefined || task.deletedAtUtc !== null) throw new ApplicationError("TASK_NOT_FOUND", "Task not found");
      const actorMembership = await transaction.memberships.get(task.projectId, command.principalId);
      if (!await canAccessProjectObject(
        transaction, actorMembership, command.principalId, task.projectId,
        task.securityDomainId, actionCapability(command.action), authorizationAtUtc,
      )) throw new ApplicationError("TASK_NOT_FOUND", "Task not found");
      await assertProjectSecurityStable(transaction, task.projectId);
      const manager = isProjectManager(actorMembership);
      assertAuthorized(task, command, manager);
      if (command.action === "assign_reviewer" || command.action === "assign_assignee") {
        const candidatePrincipalId = command.action === "assign_reviewer" ? command.reviewerPrincipalId : command.assigneePrincipalId;
        if (candidatePrincipalId === null) throw new ApplicationError(
          command.action === "assign_reviewer" ? "REVIEWER_REQUIRED" : "ASSIGNEE_REQUIRED",
          command.action === "assign_reviewer" ? "A reviewer is required" : "An assignee is required",
        );
        const candidate = await transaction.memberships.get(task.projectId, candidatePrincipalId);
        if (!await canAccessProjectObject(
          transaction, candidate, candidatePrincipalId, task.projectId,
          task.securityDomainId, "view", authorizationAtUtc,
        )) {
          throw new ApplicationError(
            command.action === "assign_reviewer" ? "REVIEWER_NOT_ELIGIBLE" : "ASSIGNEE_NOT_ELIGIBLE",
            command.action === "assign_reviewer" ? "The reviewer is not eligible for this task" : "The assignee is not eligible for this task",
          );
        }
        const principal = await transaction.principals.get(candidatePrincipalId);
        if (principal?.status !== "active") throw new ApplicationError(
          command.action === "assign_reviewer" ? "REVIEWER_NOT_ELIGIBLE" : "ASSIGNEE_NOT_ELIGIBLE",
          "The selected principal is not active",
        );
      }
      const previous = await transaction.receipts.get<TaskView>(scope);
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint) throw new ApplicationError(
          "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
          "The idempotency key was already used with a different payload",
        );
        return { value: structuredClone(previous.result), replayed: true };
      }
      if (task.version !== command.expectedVersion) throw new ApplicationError("TASK_VERSION_CONFLICT", "Task version conflict");

      const existingActions = await transaction.tasks.listReviewActions(task.id);
      const { updated, reviewAction } = applyAction(task, existingActions, command);
      await transaction.tasks.update(updated, task.version);
      if (reviewAction !== null) await transaction.tasks.appendReviewAction(reviewAction);
      const allActions = reviewAction === null ? existingActions : [...existingActions, reviewAction];
      const event = await appendEvent(transaction, command, updated, reviewAction?.cycleNumber ?? null);
      await transaction.outbox.enqueue(outboxFor(event));
      const value = toTaskView(updated, allActions);
      await transaction.receipts.insert({ scope, fingerprint, result: value, createdAtUtc: command.occurredAtUtc });
      return { value, replayed: false };
    });
  }
}

function applyAction(
  task: ProductTask,
  actions: readonly TaskReviewActionRecord[],
  command: ActOnTaskCommand,
): Readonly<{ updated: ProductTask; reviewAction: TaskReviewActionRecord | null }> {
  if (command.action === "start") return { updated: startTask(task), reviewAction: null };
  if (command.action === "complete") return { updated: completeTaskWithoutReview(task), reviewAction: null };
  if (command.action === "assign_reviewer") {
    if (command.reviewerPrincipalId === null) throw new ApplicationError("REVIEWER_REQUIRED", "A reviewer is required");
    return { updated: assignTaskReviewer(task, command.reviewerPrincipalId), reviewAction: null };
  }
  if (command.action === "assign_assignee") {
    if (command.assigneePrincipalId === null) throw new ApplicationError("ASSIGNEE_REQUIRED", "An assignee is required");
    return { updated: assignTaskAssignee(task, command.assigneePrincipalId), reviewAction: null };
  }

  if (command.action === "submit") {
    if (!task.requiresAcceptance) return { updated: submitTask(task), reviewAction: null };
    if (task.reviewerPrincipalId === null) throw new ApplicationError("REVIEWER_REQUIRED", "Task reviewer is missing");
    const cycleNumber = actions.reduce((maximum, action) => Math.max(maximum, action.cycleNumber), 0) + 1;
    return {
      updated: submitTask(task),
      reviewAction: record(command, task, cycleNumber, task.reviewerPrincipalId),
    };
  }

  const submitted = latestSubmitted(actions);
  if (submitted === undefined) throw new ApplicationError("TASK_REVIEW_CYCLE_NOT_FOUND", "Active task review cycle not found");
  if (submitted.reviewerPrincipalId === null) throw new ApplicationError("REVIEWER_REQUIRED", "Task review cycle has no reviewer");
  if (command.action === "reject" && normalizedNote(command.note) === null) {
    throw new ApplicationError("TASK_REJECTION_REASON_REQUIRED", "A rejection reason is required");
  }
  const updated = command.action === "accept"
    ? acceptTask(task)
    : command.action === "reject"
      ? rejectTask(task)
      : withdrawTask(task);
  return {
    updated,
    reviewAction: record(command, task, submitted.cycleNumber, submitted.reviewerPrincipalId),
  };
}

function record(
  command: ActOnTaskCommand,
  task: ProductTask,
  cycleNumber: number,
  reviewerPrincipalId: PrincipalId,
): TaskReviewActionRecord {
  if (command.action !== "submit" && command.action !== "accept" && command.action !== "reject" && command.action !== "withdraw") {
    throw new Error("TASK_REVIEW_ACTION_INVALID");
  }
  return {
    tenantId: command.tenantId,
    taskId: task.id,
    cycleNumber,
    action: command.action === "submit" ? "submitted" : command.action === "accept" ? "accepted" : command.action === "reject" ? "rejected" : "withdrawn",
    actorPrincipalId: command.principalId,
    reviewerPrincipalId,
    occurredAtUtc: command.occurredAtUtc,
    note: normalizedNote(command.note),
  };
}

function latestSubmitted(actions: readonly TaskReviewActionRecord[]): TaskReviewActionRecord | undefined {
  const maximum = actions.reduce((value, action) => Math.max(value, action.cycleNumber), 0);
  return actions.find((action) => action.cycleNumber === maximum && action.action === "submitted");
}

function assertAuthorized(task: ProductTask, command: ActOnTaskCommand, manager: boolean): void {
  const actor = command.principalId;
  if (command.action === "assign_reviewer" || command.action === "assign_assignee") {
    if (!manager) throw new ApplicationError("TASK_ACTION_FORBIDDEN", `Only a project manager can assign the task ${command.action === "assign_reviewer" ? "reviewer" : "assignee"}`);
    return;
  }
  const assigneeOnly = command.action === "start" || command.action === "withdraw" || command.action === "complete";
  if (assigneeOnly && task.assigneePrincipalId !== actor) {
    throw new ApplicationError("TASK_ACTION_FORBIDDEN", "Only the task assignee can perform this action");
  }
  if (command.action === "submit" && task.assigneePrincipalId !== actor) {
    throw new ApplicationError("TASK_ACTION_FORBIDDEN", "Only the task assignee can submit this task");
  }
  const reviewerAction = command.action === "accept" || command.action === "reject";
  if (reviewerAction && task.reviewerPrincipalId !== actor && !manager) {
    throw new ApplicationError("TASK_ACTION_FORBIDDEN", "Only the assigned reviewer or a project manager can perform this action");
  }
}

async function appendEvent(
  transaction: TransactionContext,
  command: ActOnTaskCommand,
  task: ProductTask,
  cycleNumber: number | null,
): Promise<DomainEvent> {
  const sequence = await transaction.sequences.next(task.projectId);
  const event: DomainEvent = {
    tenantId: command.tenantId,
    eventId: `evt:${command.commandId}`,
    projectId: task.projectId,
    projectSequence: sequence,
    aggregateType: "task",
    aggregateId: task.id,
    aggregateVersion: task.version,
    eventType: eventType(command.action),
    schemaVersion: 1,
    actorPrincipalId: command.principalId,
    occurredAtUtc: command.occurredAtUtc,
    correlationId: command.correlationId,
    causationId: command.commandId,
    originalSecurityDomainId: task.securityDomainId,
    originalSecurityEpoch: task.securityEpoch,
    payload: cycleNumber === null
      ? { taskId: task.id, nodeId: task.ownerNodeId }
      : { taskId: task.id, nodeId: task.ownerNodeId, cycleNumber },
  };
  await transaction.events.append(event);
  return event;
}

function outboxFor(event: DomainEvent): OutboxMessage {
  return {
    tenantId: event.tenantId,
    id: `outbox:${event.eventId}`,
    eventId: event.eventId,
    topic: eventTopic(event),
    payload: event,
    state: "pending",
    availableAtUtc: event.occurredAtUtc,
    attempts: 0,
    maxAttempts: 8,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAtUtc: null,
    lastError: null,
    publishedAtUtc: null,
    createdAtUtc: event.occurredAtUtc,
  };
}

function eventType(action: TaskCommandAction): string {
  return action === "submit" || action === "accept" || action === "reject" || action === "withdraw"
    ? `project-map.task.review.${action === "submit" ? "submitted" : action === "accept" ? "accepted" : action === "reject" ? "rejected" : "withdrawn"}`
    : `project-map.task.${action === "complete" ? "completed" : action === "assign_reviewer" ? "reviewer_assigned" : action === "assign_assignee" ? "assignee_assigned" : "started"}`;
}

function actionCapability(action: TaskCommandAction): "contribute" | "edit" {
  return action === "assign_assignee" || action === "assign_reviewer" || action === "accept" || action === "reject"
    ? "edit"
    : "contribute";
}

function validate(command: ActOnTaskCommand): void {
  for (const [name, value] of Object.entries({
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId,
    principalId: command.principalId,
    taskId: command.taskId,
  })) if (String(value).trim().length === 0) throw new ApplicationError("VALIDATION_FAILED", `${name} is required`);
  if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion <= 0) {
    throw new ApplicationError("VALIDATION_FAILED", "expectedVersion must be a positive integer");
  }
  if (!command.occurredAtUtc.endsWith("Z") || Number.isNaN(Date.parse(command.occurredAtUtc))) {
    throw new ApplicationError("VALIDATION_FAILED", "occurredAtUtc must be UTC");
  }
  if (command.action !== "assign_assignee" && command.assigneePrincipalId !== null) {
    throw new ApplicationError("VALIDATION_FAILED", "assigneePrincipalId is only valid for assign_assignee");
  }
  if (command.action !== "assign_reviewer" && command.reviewerPrincipalId !== null) {
    throw new ApplicationError("VALIDATION_FAILED", "reviewerPrincipalId is only valid for assign_reviewer");
  }
  const reviewAction = command.action === "submit" || command.action === "accept"
    || command.action === "reject" || command.action === "withdraw";
  if (!reviewAction && normalizedNote(command.note) !== null) {
    throw new ApplicationError("VALIDATION_FAILED", "note is only valid for a review action");
  }
}

function normalizedNote(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length === 0 ? null : normalized;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
