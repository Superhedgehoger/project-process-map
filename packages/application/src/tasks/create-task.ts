import { createHash } from "node:crypto";
import { eventTopic, type BackgroundJob, type DomainEvent, type OutboxMessage } from "../../../domain/src/events.ts";
import type { PrincipalId, TenantId } from "../../../domain/src/identity.ts";
import { assertValidSlotKey } from "../../../domain/src/role-slots.ts";
import { taskLifecycle, type ProductTask, type TaskLifecycleState, type TaskReviewActionRecord } from "../../../domain/src/tasks.ts";
import { ApplicationError } from "../errors.ts";
import { assertProjectSecurityStable, canAccessProjectObject, canAccessProjectObjectDuringMigration } from "../access/project-security.ts";
import type { CommandScope, Persistence, TransactionContext } from "../ports/persistence.ts";
import { isCandidateEligible, resolveTaskReviewer } from "./resolve-task-reviewer.ts";

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
  reviewerRoleSlotKey?: string | null | undefined;
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
      reviewerRoleSlotKey: command.reviewerRoleSlotKey ?? null,
    });

    return await this.#persistence.transaction(command.tenantId, async (transaction) => {
      const authorizationAtUtc = this.#persistence.nowUtc();
      const node = await transaction.nodes.get(command.nodeId);
      if (node === undefined) throw new Error("NODE_NOT_FOUND");
      if (node.projectId !== command.projectId) throw new Error("PROJECT_MISMATCH");
      const actorMembership = await transaction.memberships.get(command.projectId, command.principalId);
      if (!await canAccessProjectObjectDuringMigration(
        transaction, actorMembership, command.principalId, {
          projectId: command.projectId,
          ownerNodeId: node.id,
          securityDomainId: node.securityDomainId,
          securityEpoch: node.securityEpoch,
        }, "contribute", authorizationAtUtc,
      )) throw new ApplicationError("NODE_NOT_FOUND", "Node not found");
      await assertProjectSecurityStable(transaction, command.projectId);
      const previous = await transaction.receipts.get<unknown>(scope);
      if (previous !== undefined) {
        if (typeof previous.result !== "object" || previous.result === null) {
          throw new ApplicationError("VALIDATION_FAILED", "Task receipt is invalid");
        }
        const raw = previous.result as Record<string, unknown>;

        let generation: "current" | "base" | "older_legacy" | null = null;
        if (previous.fingerprint === fingerprint) {
          generation = "current";
        } else if (
          (command.reviewerRoleSlotKey === null || command.reviewerRoleSlotKey === undefined)
          && previous.fingerprint === baseFingerprint(command)
        ) {
          generation = "base";
        } else if (
          (command.reviewerRoleSlotKey === null || command.reviewerRoleSlotKey === undefined)
          && isOlderLegacyReceipt(raw) && command.reviewerPrincipalId === null
          && legacyFingerprints(command).includes(previous.fingerprint)
        ) {
          generation = "older_legacy";
        }
        if (generation === null) {
          throw new ApplicationError(
            "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
            "The idempotency key was already used with a different payload",
          );
        }

        // Reject invalid or non-string projectId when present
        if ("projectId" in raw && raw.projectId !== undefined) {
          if (typeof raw.projectId !== "string" || raw.projectId !== command.projectId) {
            throw new ApplicationError("VALIDATION_FAILED", "Receipt project ID is invalid or does not match command");
          }
        }

        // Validate immutable creation receipt identity fields
        if (typeof raw.id !== "string" || raw.id.trim().length === 0 || raw.id !== command.taskId) {
          throw new ApplicationError("VALIDATION_FAILED", "Receipt task ID does not match command");
        }
        if (typeof raw.nodeId !== "string" || raw.nodeId.trim().length === 0 || raw.nodeId !== command.nodeId) {
          throw new ApplicationError("VALIDATION_FAILED", "Receipt node ID does not match command");
        }
        if (typeof raw.title !== "string" || raw.title.trim().length === 0 || raw.title !== command.title) {
          throw new ApplicationError("VALIDATION_FAILED", "Receipt title does not match command");
        }
        if (typeof raw.requiresAcceptance !== "boolean" || raw.requiresAcceptance !== command.requiresAcceptance) {
          throw new ApplicationError("VALIDATION_FAILED", "Receipt requiresAcceptance does not match command");
        }

        // Creation snapshot status and version invariants:
        // A create_task receipt always represents the initial creation snapshot.
        if (raw.version !== 1) {
          throw new ApplicationError("VALIDATION_FAILED", "Receipt version must be 1 for a creation snapshot");
        }
        if (raw.status !== "todo") {
          throw new ApplicationError("VALIDATION_FAILED", "Receipt status must be todo for a creation snapshot");
        }

        // Generation-aware field validation:
        // For current and immediate-base receipts, require creation fields that are part of those formats
        // to be explicitly present with correct types.
        if (generation === "current" || generation === "base") {
          // assigneePrincipalId must be explicitly present and either null or a non-empty string
          if (!("assigneePrincipalId" in raw) || raw.assigneePrincipalId === undefined) {
            throw new ApplicationError("VALIDATION_FAILED", "Receipt assigneePrincipalId must be explicitly present");
          }
          if (raw.assigneePrincipalId !== null && (typeof raw.assigneePrincipalId !== "string" || raw.assigneePrincipalId.trim().length === 0)) {
            throw new ApplicationError("VALIDATION_FAILED", "Receipt assigneePrincipalId must be null or a non-empty string");
          }
          if (raw.assigneePrincipalId !== command.assigneePrincipalId) {
            throw new ApplicationError("VALIDATION_FAILED", "Receipt assignee does not match command");
          }

          // reviewerPrincipalId must be explicitly present
          if (!("reviewerPrincipalId" in raw) || raw.reviewerPrincipalId === undefined) {
            throw new ApplicationError("VALIDATION_FAILED", "Receipt reviewerPrincipalId must be explicitly present");
          }
          if (command.requiresAcceptance) {
            if (typeof raw.reviewerPrincipalId !== "string" || raw.reviewerPrincipalId.trim().length === 0) {
              throw new ApplicationError("VALIDATION_FAILED", "Task receipt reviewer snapshot is corrupt or missing");
            }
            if (command.reviewerPrincipalId !== null && raw.reviewerPrincipalId !== command.reviewerPrincipalId) {
              throw new ApplicationError("VALIDATION_FAILED", "Receipt reviewer does not match explicitly requested reviewer");
            }
          } else {
            if (raw.reviewerPrincipalId !== null) {
              throw new ApplicationError("VALIDATION_FAILED", "Task receipt reviewer must be null when requiresAcceptance is false");
            }
          }

          // reviewHistory must be explicitly present as an array with length 0
          if (!("reviewHistory" in raw) || raw.reviewHistory === undefined) {
            throw new ApplicationError("VALIDATION_FAILED", "Receipt reviewHistory must be explicitly present");
          }
          if (!Array.isArray(raw.reviewHistory)) {
            throw new ApplicationError("VALIDATION_FAILED", "Receipt reviewHistory must be an array");
          }
          for (const item of raw.reviewHistory) {
            assertValidTaskReviewActionView(item);
          }
          if (raw.reviewHistory.length !== 0) {
            throw new ApplicationError("VALIDATION_FAILED", "Receipt reviewHistory must be empty for a creation snapshot");
          }
        } else {
          // generation === "older_legacy"
          // Confine missing-field normalization only to the documented older-legacy generation.
          if ("assigneePrincipalId" in raw && raw.assigneePrincipalId !== undefined && raw.assigneePrincipalId !== null) {
            throw new ApplicationError("VALIDATION_FAILED", "Older legacy receipt assignee must be null or omitted");
          }
          if ("reviewerPrincipalId" in raw && raw.reviewerPrincipalId !== undefined && raw.reviewerPrincipalId !== null) {
            throw new ApplicationError("VALIDATION_FAILED", "Older legacy receipt reviewer must be null or omitted");
          }
          if ("reviewHistory" in raw && raw.reviewHistory !== undefined) {
            if (!Array.isArray(raw.reviewHistory) || raw.reviewHistory.length !== 0) {
              throw new ApplicationError("VALIDATION_FAILED", "Older legacy receipt reviewHistory must be omitted or empty");
            }
          }
        }

        const replayedView: TaskView = {
          id: raw.id as string,
          nodeId: raw.nodeId as string,
          title: raw.title as string,
          status: raw.status as TaskLifecycleState,
          assigneePrincipalId: generation === "older_legacy" ? null : (raw.assigneePrincipalId as PrincipalId | null),
          requiresAcceptance: raw.requiresAcceptance as boolean,
          reviewerPrincipalId: generation === "older_legacy" ? null : (raw.reviewerPrincipalId as PrincipalId | null),
          version: raw.version as number,
          reviewHistory: generation === "older_legacy" ? [] : structuredClone(raw.reviewHistory as TaskReviewActionView[]),
        };

        // Load authoritative Task and validate ownership and domain/epoch coherence
        const authoritativeTask = await transaction.tasks.get(command.taskId);
        if (authoritativeTask === undefined || authoritativeTask.deletedAtUtc !== null) {
          throw new ApplicationError("TASK_NOT_FOUND", `Task not found: ${command.taskId}`);
        }
        if (authoritativeTask.id !== command.taskId
          || authoritativeTask.projectId !== command.projectId
          || authoritativeTask.ownerNodeId !== command.nodeId) {
          throw new ApplicationError("TASK_NOT_FOUND", "Task identity or ownership mismatch");
        }
        if (authoritativeTask.securityDomainId !== node.securityDomainId
          || authoritativeTask.securityEpoch !== node.securityEpoch) {
          throw new ApplicationError("TASK_NOT_FOUND", "Task security domain or epoch incoherent with node");
        }
        if (authoritativeTask.requiresAcceptance !== command.requiresAcceptance) {
          throw new ApplicationError("TASK_NOT_FOUND", "Task acceptance semantics mismatch");
        }
        if (authoritativeTask.version < replayedView.version) {
          throw new ApplicationError("TASK_NOT_FOUND", "Task version is less than receipt version");
        }

        // Authorize persisted resolved reviewer against authoritative Task's current domain
        if (replayedView.requiresAcceptance) {
          if (replayedView.reviewerPrincipalId === null) {
            throw new ApplicationError("REVIEWER_REQUIRED", "A reviewer is required for an acceptance task");
          }
          const isEligible = await isCandidateEligible(
            transaction,
            command.tenantId,
            command.projectId,
            authoritativeTask.securityDomainId,
            replayedView.reviewerPrincipalId,
            authorizationAtUtc,
          );
          if (!isEligible) {
            throw new ApplicationError("REVIEWER_NOT_ELIGIBLE", "The reviewer is not eligible for this task");
          }
        }

        if (replayedView.assigneePrincipalId !== null) {
          const assignee = await transaction.principals.get(replayedView.assigneePrincipalId);
          if (assignee?.status !== "active" || !await canAccessProjectObject(
            transaction,
            await transaction.memberships.get(command.projectId, replayedView.assigneePrincipalId),
            replayedView.assigneePrincipalId,
            command.projectId,
            authoritativeTask.securityDomainId,
            "view",
            authorizationAtUtc,
          )) {
            throw new ApplicationError("ASSIGNEE_NOT_ELIGIBLE", "The assignee is not eligible for this task");
          }
        }

        return { value: replayedView, replayed: true };
      }
      if (node.kind === "milestone") throw new Error("MILESTONE_TASK_FORBIDDEN");
      if (node.deletedAtUtc !== null) throw new Error("NODE_DELETED");
      if (await transaction.tasks.get(command.taskId) !== undefined) throw new Error("TASK_ALREADY_EXISTS");
      if (!command.requiresAcceptance && (command.reviewerPrincipalId !== null || (command.reviewerRoleSlotKey !== null && command.reviewerRoleSlotKey !== undefined))) {
        throw new ApplicationError("REVIEWER_NOT_ALLOWED", "A reviewer is only valid for an acceptance task");
      }
      if (command.assigneePrincipalId !== null && !await canAccessProjectObject(
        transaction,
        await transaction.memberships.get(command.projectId, command.assigneePrincipalId),
        command.assigneePrincipalId,
        command.projectId,
        node.securityDomainId,
        "view",
        authorizationAtUtc,
      )) throw new ApplicationError("ASSIGNEE_NOT_ELIGIBLE", "The assignee is not eligible for this task");
      if (command.assigneePrincipalId !== null) {
        const assignee = await transaction.principals.get(command.assigneePrincipalId);
        if (assignee?.status !== "active") throw new ApplicationError("ASSIGNEE_NOT_ELIGIBLE", "The assignee is not active");
      }

      let resolvedReviewerPrincipalId: PrincipalId | null = null;
      if (command.requiresAcceptance) {
        const resolution = await resolveTaskReviewer(transaction, {
          tenantId: command.tenantId,
          projectId: command.projectId,
          node,
          explicitReviewerPrincipalId: command.reviewerPrincipalId,
          reviewerRoleSlotKey: command.reviewerRoleSlotKey,
          authorizationAtUtc,
        });
        resolvedReviewerPrincipalId = resolution.reviewerPrincipalId;
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
        reviewerPrincipalId: resolvedReviewerPrincipalId,
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
  include: (task: ProductTask) => boolean | Promise<boolean> = () => true,
): Promise<TaskView[]> {
  const selected: ProductTask[] = [];
  for (const task of await transaction.tasks.listByNode(nodeId)) if (await include(task)) selected.push(task);
  return await Promise.all(selected.map(
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
    tenantId: command.tenantId,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId,
    principalId: command.principalId,
    projectId: command.projectId,
    nodeId: command.nodeId,
    taskId: command.taskId,
    title: command.title,
  })) if (String(value).trim().length === 0) throw new ApplicationError("VALIDATION_FAILED", `${name} is required`);
  if (!command.occurredAtUtc.endsWith("Z") || Number.isNaN(Date.parse(command.occurredAtUtc))) {
    throw new ApplicationError("VALIDATION_FAILED", "occurredAtUtc must be UTC");
  }
  if (!command.requiresAcceptance && (command.reviewerPrincipalId !== null || (command.reviewerRoleSlotKey !== null && command.reviewerRoleSlotKey !== undefined))) {
    throw new ApplicationError("REVIEWER_NOT_ALLOWED", "A reviewer is only valid for an acceptance task");
  }
  if (command.reviewerRoleSlotKey !== undefined && command.reviewerRoleSlotKey !== null) {
    if (typeof command.reviewerRoleSlotKey !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(command.reviewerRoleSlotKey)) {
      throw new ApplicationError("VALIDATION_FAILED", `reviewerRoleSlotKey format or length is invalid: ${command.reviewerRoleSlotKey}`);
    }
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function baseFingerprint(command: CreateTaskCommand): string {
  return hash({
    projectId: command.projectId,
    nodeId: command.nodeId,
    taskId: command.taskId,
    title: command.title,
    assigneePrincipalId: command.assigneePrincipalId,
    requiresAcceptance: command.requiresAcceptance,
    reviewerPrincipalId: command.reviewerPrincipalId,
  });
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

function isOlderLegacyReceipt(value: Record<string, unknown>): boolean {
  return !("reviewHistory" in value)
    && (!("assigneePrincipalId" in value) || value.assigneePrincipalId === null)
    && (!("reviewerPrincipalId" in value) || value.reviewerPrincipalId === null);
}

const VALID_REVIEW_ACTIONS: ReadonlySet<string> = new Set([
  "submitted",
  "accepted",
  "rejected",
  "withdrawn",
]);

function assertValidTaskReviewActionView(item: unknown): void {
  if (typeof item !== "object" || item === null) {
    throw new ApplicationError("VALIDATION_FAILED", "Task receipt reviewHistory item must be an object");
  }
  const r = item as Record<string, unknown>;
  if (typeof r.cycleNumber !== "number" || !Number.isInteger(r.cycleNumber) || r.cycleNumber < 1) {
    throw new ApplicationError("VALIDATION_FAILED", "Task receipt reviewHistory cycleNumber must be a positive integer");
  }
  if (typeof r.action !== "string" || !VALID_REVIEW_ACTIONS.has(r.action)) {
    throw new ApplicationError("VALIDATION_FAILED", `Task receipt reviewHistory action is invalid: ${String(r.action)}`);
  }
  if (typeof r.actorPrincipalId !== "string" || r.actorPrincipalId.trim().length === 0) {
    throw new ApplicationError("VALIDATION_FAILED", "Task receipt reviewHistory actorPrincipalId must be a non-empty string");
  }
  if (r.reviewerPrincipalId !== null && (typeof r.reviewerPrincipalId !== "string" || (r.reviewerPrincipalId as string).trim().length === 0)) {
    throw new ApplicationError("VALIDATION_FAILED", "Task receipt reviewHistory reviewerPrincipalId must be null or a non-empty string");
  }
  if (typeof r.occurredAtUtc !== "string" || !r.occurredAtUtc.endsWith("Z") || Number.isNaN(Date.parse(r.occurredAtUtc))) {
    throw new ApplicationError("VALIDATION_FAILED", "Task receipt reviewHistory occurredAtUtc must be a valid UTC timestamp");
  }
  if (r.note !== null && typeof r.note !== "string") {
    throw new ApplicationError("VALIDATION_FAILED", "Task receipt reviewHistory note must be null or a string");
  }
}
