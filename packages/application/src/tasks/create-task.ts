import { createHash } from "node:crypto";
import { eventTopic, type BackgroundJob, type DomainEvent, type OutboxMessage } from "../../../domain/src/events.ts";
import type { PrincipalId, TenantId } from "../../../domain/src/identity.ts";
import { taskLifecycle, type ProductTask, type TaskLifecycleState } from "../../../domain/src/tasks.ts";
import type { CommandScope, Persistence } from "../ports/persistence.ts";

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
  occurredAtUtc: string;
}>;

export type TaskView = Readonly<{
  id: string;
  nodeId: string;
  title: string;
  status: TaskLifecycleState;
  requiresAcceptance: boolean;
  version: number;
}>;

export type CreateTaskResult = Readonly<{ value: TaskView; replayed: boolean }>;

export class CreateTaskHandler {
  readonly #persistence: Persistence;
  readonly #options: Readonly<{ scheduleCollaborationProjection: boolean }>;

  constructor(
    persistence: Persistence,
    options: Readonly<{ scheduleCollaborationProjection: boolean }> = { scheduleCollaborationProjection: false },
  ) {
    this.#persistence = persistence;
    this.#options = options;
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
    });

    return await this.#persistence.transaction(command.tenantId, async (transaction) => {
      const previous = await transaction.receipts.get<TaskView>(scope);
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
        return { value: structuredClone(previous.result), replayed: true };
      }
      const node = await transaction.nodes.get(command.nodeId);
      if (node === undefined) throw new Error("NODE_NOT_FOUND");
      if (node.projectId !== command.projectId) throw new Error("PROJECT_MISMATCH");
      if (node.kind === "milestone") throw new Error("MILESTONE_TASK_FORBIDDEN");
      if (node.deletedAtUtc !== null) throw new Error("NODE_DELETED");
      if (await transaction.tasks.get(command.taskId) !== undefined) throw new Error("TASK_ALREADY_EXISTS");

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
      const value = toTaskView(task);
      await transaction.receipts.insert({ scope, fingerprint, result: value, createdAtUtc: command.occurredAtUtc });
      return { value, replayed: false };
    });
  }
}

export async function listTasksForNode(persistence: Persistence, tenantId: TenantId, nodeId: string): Promise<TaskView[]> {
  return await persistence.read(tenantId, async (transaction) => (await transaction.tasks.listByNode(nodeId)).map(toTaskView));
}

export function toTaskView(task: ProductTask): TaskView {
  return {
    id: task.id,
    nodeId: task.ownerNodeId,
    title: task.title,
    status: taskLifecycle(task),
    requiresAcceptance: task.requiresAcceptance,
    version: task.version,
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
