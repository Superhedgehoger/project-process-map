import { createHash } from "node:crypto";
import { eventTopic, type BackgroundJob, type DomainEvent, type OutboxMessage } from "../../../domain/src/events.ts";
import type { PrincipalId, TenantId } from "../../../domain/src/identity.ts";
import { canAccessSecurityDomain } from "../../../domain/src/project-access.ts";
import { taskLifecycle, type ProductTask, type TaskLifecycleState, type TaskReviewActionRecord } from "../../../domain/src/tasks.ts";
import { ApplicationError } from "../errors.ts";
import { assertProjectSecurityStable } from "../access/project-security.ts";
import type { CommandScope, Persistence, TransactionContext } from "../ports/persistence.ts";

export type CreateTaskCommand = Readonly<{
  tenantId: TenantId;
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  principalId: PrincipalId;
  projectId: string;
  nodeId: string;
  taskId: string;
  title: string;
  assigneePrincipalId: PrincipalId | null;
  requiresAcceptance: boolean;
  reviewerPrincipalId: PrincipalId | null;
  occurredAtUtc: string;
}>;

export type TaskReviewActionView = Readonly<{
  cycleNumber: number;
  action: TaskReviewActionRecord["action"];
  actorPrincipalId: PrincipalId;
  reviewerPrincipalId: PrincipalId | null;
  occurredAtUtc: string;
  note: string | null;
}>;

export type TaskView = Readonly<{
  id: string;
  nodeId: string;
  title: string;
  status: TaskLifecycleState;
  assigneePrincipalId: PrincipalId | null;
  requiresAcceptance: boolean;
  reviewerPrincipalId: PrincipalId | null;
  version: number;
  reviewHistory: TaskReviewActionView[];
}>;

export type CreateTaskResult = Readonly<{ value: TaskView; replayed: boolean }>;

export class CreateTaskHandler {
  readonly #persistence: Persistence;
  readonly #options: Readonly<{ scheduleCollaborationProjection: boolean }>;

  constructor(
    persistence: Persistence,
    options: Readonly<{ scheduleCollaborationProjection?: boolean }> = {},
  ) {
    this.#persistence = persistence;
    this.#options = {
      scheduleCollaborationProjection: options.scheduleCollaborationProjection ?? false,
    };
  }

  async execute(command: CreateTaskCommand): Promise<CreateTaskResult> {
    validate(command);
    const scope: CommandScope = {
      principalId: command.principalId,
      operation: "create_task",
      idempotencyKey: command.idempotencyKey,
    };
    const fingerprint = hash({
      projectId: command.projectId,
      nodeId: command.nodeId,
      taskId: command.taskId,
      title: command.title,
      assigneePrincipalId: command.assigneePrincipalId,
      requiresAcceptance: command.requiresAcceptance,
      reviewerPrincipalId: command.reviewerPrincipalId,
    });

    return await this.#persistence.transaction(command.tenantId, async (transaction) => {
      const node = await transaction.nodes.get(command.nodeId);
      if (node === undefined) throw new Error("NODE_NOT_FOUND");
      if (node.projectId !== command.projectId) throw new Error("PROJECT_MISMATCH");
      const actorMembership = await transaction.memberships.get(command.projectId, command.principalId);
      if (!canAccessSecurityDomain(actorMembership, node.securityDomainId)) throw new ApplicationError("NODE_NOT_FOUND", "Node not found");
      await assertProjectSecurityStable(transaction, command.projectId);
      const previous = await transaction.receipts.get<unknown>(scope);
      if (previous !== undefined) {
        const legacy = isLegacyTaskView(previous.result) && command.reviewerPrincipalId === null
          && legacyFingerprints(command).includes(previous.fingerprint);
        if (previous.fingerprint !== fingerprint && !legacy) throw new ApplicationError(
          "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
          "The idempotency key was already used with a different payload",
        );
        return { value: taskViewFromReceipt(previous.result), replayed: true };
      }
      if (node.kind === "milestone") throw new Error("MILESTONE_TASK_FORBIDDEN");
      if (node.deletedAtUtc !== null) throw new Error("NODE_DELETED");
      if (await transaction.tasks.get(command.taskId) !== undefined) throw new Error("TASK_ALREADY_EXISTS");
      if (command.requiresAcceptance && command.reviewerPrincipalId === null) {
        throw new ApplicationError("REVIEWER_REQUIRED", "A reviewer is required for an acceptance task");
      }
      if (!command.requiresAcceptance && command.reviewerPrincipalId !== null) {
        throw new ApplicationError("REVIEWER_NOT_ALLOWED", "A reviewer is only valid for an acceptance task");
      }
      if (command.assigneePrincipalId !== null && !canAccessSecurityDomain(
        await transaction.memberships.get(command.projectId, command.assigneePrincipalId),
        node.securityDomainId,
      )) throw new ApplicationError("ASSIGNEE_NOT_ELIGIBLE", "The assignee is not eligible for this task");
      if (command.assigneePrincipalId !== null) {
        const assignee = await transaction.principals.get(command.assigneePrincipalId);
        if (assignee?.status !== "active") throw new ApplicationError("ASSIGNEE_NOT_ELIGIBLE", "The assignee is not active");
      }
      if (command.reviewerPrincipalId !== null && !canAccessSecurityDomain(
        await transaction.memberships.get(command.projectId, command.reviewerPrincipalId),
        node.securityDomainId,
      )) {
        throw new ApplicationError("REVIEWER_NOT_ELIGIBLE", "The reviewer is not eligible for this task");
      }
      if (command.reviewerPrincipalId !== null) {
        const reviewer = await transaction.principals.get(command.reviewerPrincipalId);
        if (reviewer?.status !== "active") throw new ApplicationError("REVIEWER_NOT_ELIGIBLE", "The reviewer is not active");
      }

      const task: ProductTask = {
        tenantId: command.tenantId,
        id: command.taskId,
        projectId: command.projectId,
        ownerNodeId: node.id,
        securityDomainId: node.securityDomainId,
        securityEpoch: node.securityEpoch,
        title: command.title,
        assigneePrincipalId: command.assigneePrincipalId,
        requiresAcceptance: command.requiresAcceptance,
        reviewerPrincipalId: command.reviewerPrincipalId,
        executionState: "todo",
        reviewState: command.requiresAcceptance ? "not_submitted" : "not_required",
        version: 1,
        deletedAtUtc: null,
      };
      await transaction.tasks.insert(task);
      const sequence = await transaction.sequences.next(command.projectId);
      const event: DomainEvent = {
        tenantId: command.tenantId,
        eventId: `evt:${command.commandId}`,
        projectId: command.projectId,
        projectSequence: sequence,
        aggregateType: "task",
        aggregateId: task.id,
        aggregateVersion: task.version,
        eventType: "project-map.task.created",
        schemaVersion: 1,
        actorPrincipalId: command.principalId,
        occurredAtUtc: command.occurredAtUtc,
        correlationId: command.correlationId,
        causationId: command.commandId,
        originalSecurityDomainId: task.securityDomainId,
        originalSecurityEpoch: task.securityEpoch,
        payload: { taskId: task.id, nodeId: task.ownerNodeId, requiresAcceptance: task.requiresAcceptance },
      };
      await transaction.events.append(event);
      const outbox: OutboxMessage = {
        tenantId: command.tenantId,
        id: `outbox:${event.eventId}`,
        eventId: event.eventId,
        topic: eventTopic(event),
        payload: event,
        state: "pending",
        availableAtUtc: command.occurredAtUtc,
        attempts: 0,
        maxAttempts: 8,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAtUtc: null,
        lastError: null,
        publishedAtUtc: null,
        createdAtUtc: command.occurredAtUtc,
      };
      await transaction.outbox.enqueue(outbox);
      if (this.#options.scheduleCollaborationProjection) {
        await transaction.jobs.schedule(projectionJob(command, task));
      }
      const value = toTaskView(task, []);
      await transaction.receipts.insert({ scope, fingerprint, result: value, createdAtUtc: command.occurredAtUtc });
      return { value, replayed: false };
    });
  }
}

export async function listTasksForNode(persistence: Persistence, tenantId: TenantId, nodeId: string): Promise<TaskView[]> {
  return await persistence.read(tenantId, async (transaction) => await listTasksForNodeInTransaction(transaction, nodeId));
}

export async function listTasksForNodeInTransaction(
  transaction: TransactionContext,
  nodeId: string,
  include: (task: ProductTask) => boolean = () => true,
): Promise<TaskView[]> {
  return await Promise.all((await transaction.tasks.listByNode(nodeId)).filter(include).map(
    async (task) => toTaskView(task, await transaction.tasks.listReviewActions(task.id)),
  ));
}

export function toTaskView(task: ProductTask, reviewActions: readonly TaskReviewActionRecord[]): TaskView {
  return {
    id: task.id,
    nodeId: task.ownerNodeId,
    title: task.title,
    status: taskLifecycle(task),
    assigneePrincipalId: task.assigneePrincipalId,
    requiresAcceptance: task.requiresAcceptance,
    reviewerPrincipalId: task.reviewerPrincipalId,
    version: task.version,
    reviewHistory: reviewActions.map((action) => ({
      cycleNumber: action.cycleNumber,
      action: action.action,
      actorPrincipalId: action.actorPrincipalId,
      reviewerPrincipalId: action.reviewerPrincipalId,
      occurredAtUtc: action.occurredAtUtc,
      note: action.note,
    })),
  };
}

function projectionJob(command: CreateTaskCommand, task: ProductTask): BackgroundJob {
  return {
    tenantId: command.tenantId,
    id: `job:collaboration-task:${task.id}:v${task.version}`,
    jobType: "collaboration.task.project",
    dedupeKey: `${task.id}:v${task.version}`,
    payload: { taskId: task.id, desiredVersion: task.version, correlationId: command.correlationId },
    state: "pending",
    priority: 50,
    availableAtUtc: command.occurredAtUtc,
    attempts: 0,
    maxAttempts: 8,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAtUtc: null,
    lastError: null,
    completedAtUtc: null,
    createdAtUtc: command.occurredAtUtc,
  };
}

function validate(command: CreateTaskCommand): void {
  for (const [name, value] of Object.entries({
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId,
    principalId: command.principalId,
    projectId: command.projectId,
    nodeId: command.nodeId,
    taskId: command.taskId,
    title: command.title,
  })) if (String(value).trim().length === 0) throw new Error(`${name} is required`);
  if (!command.occurredAtUtc.endsWith("Z") || Number.isNaN(Date.parse(command.occurredAtUtc))) throw new Error("occurredAtUtc must be UTC");
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function legacyFingerprints(command: CreateTaskCommand): string[] {
  const value = {
    projectId: command.projectId,
    nodeId: command.nodeId,
    taskId: command.taskId,
    title: command.title,
    assigneePrincipalId: command.assigneePrincipalId,
    requiresAcceptance: command.requiresAcceptance,
  };
  const fingerprints = [hash(value)];
  if (command.assigneePrincipalId !== null) fingerprints.push(hash({ ...value, assigneePrincipalId: null }));
  return fingerprints;
}

function isLegacyTaskView(value: unknown): boolean {
  return typeof value === "object" && value !== null && !("reviewHistory" in value);
}

function taskViewFromReceipt(value: unknown): TaskView {
  if (typeof value !== "object" || value === null) throw new Error("TASK_RECEIPT_INVALID");
  const task = value as Partial<TaskView>;
  if (typeof task.id !== "string" || typeof task.nodeId !== "string" || typeof task.title !== "string"
    || typeof task.status !== "string" || typeof task.requiresAcceptance !== "boolean"
    || typeof task.version !== "number") throw new Error("TASK_RECEIPT_INVALID");
  return {
    id: task.id,
    nodeId: task.nodeId,
    title: task.title,
    status: task.status as TaskLifecycleState,
    assigneePrincipalId: task.assigneePrincipalId ?? null,
    requiresAcceptance: task.requiresAcceptance,
    reviewerPrincipalId: task.reviewerPrincipalId ?? null,
    version: task.version,
    reviewHistory: structuredClone(task.reviewHistory ?? []),
  };
}
