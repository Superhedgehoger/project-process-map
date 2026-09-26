import { createHash } from "node:crypto";
import {
  assertCanonicalDeliverableActionRecord,
  waiveDeliverable,
  type DeliverableActionRecord,
  type DeliverableRequirement,
} from "../../../domain/src/deliverables.ts";
import { eventTopic, type DomainEvent, type OutboxMessage } from "../../../domain/src/events.ts";
import { isProjectManager } from "../../../domain/src/project-access.ts";
import {
  assertProjectSecurityStable,
  canAccessProjectObjectDuringMigration,
} from "../access/project-security.ts";
import { ApplicationError } from "../errors.ts";
import type {
  CommandScope,
  DeliverableRequirementView,
  Persistence,
  TransactionContext,
  WaiveDeliverableCommand,
  WaiveDeliverableResult,
} from "../ports/persistence.ts";
import {
  assertExactDeliverableReplayFacts,
  assertExactDeliverableReplayEventFacts,
  assertExactTerminalReplayCommandFacts,
  injectDeliverableFailure,
  toDeliverableRequirementView,
} from "./initialize-deliverable-requirement.ts";
import { validateReplaySubmissionFacts } from "./accept-deliverable.ts";

export function hashWaiveDeliverablePayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class WaiveDeliverableHandler {
  readonly #persistence: Persistence;

  constructor(persistence: Persistence) {
    this.#persistence = persistence;
  }

  async execute(command: WaiveDeliverableCommand): Promise<WaiveDeliverableResult> {
    this.#validate(command);
    const scope: CommandScope = {
      principalId: command.principalId,
      operation: "waive_deliverable",
      idempotencyKey: command.idempotencyKey,
    };
    const fingerprint = hashWaiveDeliverablePayload({
      deliverableId: command.deliverableId,
      expectedVersion: command.expectedVersion,
      reason: command.reason.trim(),
      occurredAtUtc: new Date(Date.parse(command.occurredAtUtc)).toISOString(),
    });

    return await this.#persistence.transaction(command.tenantId, async (transaction) => {
      const authorizationAtUtc = this.#persistence.nowUtc();
      const req = await transaction.deliverables.get(command.deliverableId);
      if (req === undefined || req.deletedAtUtc !== null) {
        throw new ApplicationError("DELIVERABLE_NOT_FOUND", `Deliverable requirement not found: ${command.deliverableId}`);
      }

      const node = await transaction.nodes.get(req.ownerNodeId);
      if (
        node === undefined ||
        node.deletedAtUtc !== null ||
        node.projectId !== req.projectId ||
        node.securityDomainId !== req.securityDomainId ||
        node.securityEpoch !== req.securityEpoch
      ) {
        throw new ApplicationError("DELIVERABLE_NOT_FOUND", `Deliverable requirement not found: ${command.deliverableId}`);
      }

      const principal = await transaction.principals.get(command.principalId);
      if (principal?.status !== "active" || principal.kind !== "user") {
        throw new ApplicationError("DELIVERABLE_NOT_FOUND", `Deliverable requirement not found: ${command.deliverableId}`);
      }

      const membership = await transaction.memberships.get(req.projectId, command.principalId);
      if (membership?.status !== "active") {
        throw new ApplicationError("DELIVERABLE_NOT_FOUND", `Deliverable requirement not found: ${command.deliverableId}`);
      }

      const canView = await canAccessProjectObjectDuringMigration(
        transaction,
        membership,
        command.principalId,
        req,
        "view",
        authorizationAtUtc,
      );
      if (!canView) {
        throw new ApplicationError("DELIVERABLE_NOT_FOUND", `Deliverable requirement not found: ${command.deliverableId}`);
      }

      await assertProjectSecurityStable(transaction, req.projectId);

      const isManager = isProjectManager(membership);
      if (!isManager) {
        throw new ApplicationError(
          "PM_ROLE_REQUIRED",
          "Only a project manager can waive deliverable requirements",
        );
      }

      const hasEdit = await canAccessProjectObjectDuringMigration(
        transaction,
        membership,
        command.principalId,
        req,
        "edit",
        authorizationAtUtc,
      );
      if (!hasEdit) {
        throw new ApplicationError(
          "DELIVERABLE_ACTION_FORBIDDEN",
          "Project manager lacks required capability in security domain",
        );
      }

      const previous = await transaction.receipts.get<DeliverableRequirementView>(scope);
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint) {
          throw new ApplicationError(
            "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
            "The idempotency key was already used with a different payload",
          );
        }
        // R2F1: Re-validate authoritative state on replay. Compatibility rule:
        //  - waived terminal state is stable: replay stays compatible while authoritative
        //    actor/time/reason still match the receipt; any drift is fail-closed.
        if (
          req.status !== "waived"
          || req.version !== command.expectedVersion + 1
          || previous.result.version !== req.version
        ) {
          throw new ApplicationError(
            "DELIVERABLE_VERSION_CONFLICT",
            "Replayed waive receipt is stale: authoritative requirement lifecycle no longer matches the command",
          );
        }
        if (
          req.waivedByPrincipalId !== previous.result.waivedByPrincipalId
          || req.waivedAtUtc !== previous.result.waivedAtUtc
          || req.waivedReason !== previous.result.waivedReason
        ) {
          throw new ApplicationError(
            "DELIVERABLE_RECORD_CORRUPT",
            "Replayed waive receipt no longer matches the authoritative waiver record",
          );
        }
        const replayLinks = await transaction.deliverables.listEvidenceLinks(req.id);
        const replayActions = await transaction.deliverables.listActions(req.id);
        const replayEvents = await transaction.events.list(command.tenantId);
        const replayOutbox = await transaction.outbox.list(command.tenantId);
        const authoritative = toDeliverableRequirementView(req, replayLinks, replayActions);
        assertExactDeliverableReplayFacts(previous.result, authoritative, "waived");
        const commandOccurredAtUtc = new Date(Date.parse(command.occurredAtUtc)).toISOString();
        assertExactTerminalReplayCommandFacts({
          terminal: "waived",
          requirement: req,
          receipt: previous.result,
          authoritativeActions: replayActions,
          receiptActions: previous.result.actionHistory,
          principalId: command.principalId,
          commandOccurredAtUtc,
          receiptCreatedAtUtc: previous.createdAtUtc,
          normalizedReason: command.reason.trim(),
        });
        assertExactDeliverableReplayEventFacts({
          tenantId: command.tenantId,
          projectId: req.projectId,
          requirement: req,
          eventType: "project-map.deliverable.waived",
          actorPrincipalId: command.principalId,
          occurredAtUtc: commandOccurredAtUtc,
          expectedPayload: {
            deliverableId: req.id,
            projectId: req.projectId,
            nodeId: req.ownerNodeId,
            waivedByPrincipalId: command.principalId,
            waivedReason: command.reason.trim(),
          },
          events: replayEvents,
          outboxMessages: replayOutbox,
        });
        // R2F6 Finding 2: waive replay re-runs the complete authoritative submission
        // semantics when a submitted action exists (file-evidence scope/availability,
        // canonical link binding, ProcessRecord rejection); when no submitted action
        // exists, the evidence link set must be exactly empty.
        const hasSubmittedAction = replayActions.some((action) => action.action === "submitted");
        if (hasSubmittedAction) {
          await validateReplaySubmissionFacts(transaction, req, replayLinks, replayActions);
        } else if (replayLinks.length !== 0) {
          throw new ApplicationError(
            "DELIVERABLE_RECORD_CORRUPT",
            "Waived deliverable without a submitted action must not carry evidence links",
          );
        }
        return { value: structuredClone(previous.result), replayed: true };
      }

      if (req.status === "accepted") {
        throw new ApplicationError("DELIVERABLE_ALREADY_ACCEPTED", "Deliverable requirement is already accepted");
      }
      if (req.status === "waived") {
        throw new ApplicationError("DELIVERABLE_ALREADY_WAIVED", "Deliverable requirement is already waived");
      }

      if (req.version !== command.expectedVersion) {
        throw new ApplicationError("DELIVERABLE_VERSION_CONFLICT", "Deliverable version conflict");
      }

      const updated = waiveDeliverable(req, {
        waivedByPrincipalId: command.principalId,
        occurredAtUtc: command.occurredAtUtc,
        reason: command.reason,
      });
      await transaction.deliverables.savePreservingSecurityOwnership(req.id, updated, req.version);
      injectDeliverableFailure(command.failurePoint, "after_aggregate");

      const actionRecord: DeliverableActionRecord = {
        tenantId: command.tenantId,
        id: `act:${command.commandId}`,
        requirementId: req.id,
        action: "waived",
        actorPrincipalId: command.principalId,
        occurredAtUtc: command.occurredAtUtc,
        reason: command.reason.trim(),
        evidenceCount: 0,
        evidenceIds: [],
      };
      assertCanonicalDeliverableActionRecord(actionRecord, {
        tenantId: command.tenantId,
        requirementId: req.id,
      });
      await transaction.deliverables.appendAction(actionRecord);
      injectDeliverableFailure(command.failurePoint, "after_action");

      const event = await this.#appendEvent(transaction, command, updated);
      injectDeliverableFailure(command.failurePoint, "after_event");

      await transaction.outbox.enqueue(this.#outboxFor(event));
      injectDeliverableFailure(command.failurePoint, "after_outbox");

      const allLinks = await transaction.deliverables.listEvidenceLinks(req.id);
      const allActions = await transaction.deliverables.listActions(req.id);
      const value = toDeliverableRequirementView(updated, allLinks, allActions);
      await transaction.receipts.insert({
        scope,
        fingerprint,
        result: value,
        createdAtUtc: command.occurredAtUtc,
      });
      injectDeliverableFailure(command.failurePoint, "after_idempotency");

      return { value, replayed: false };
    });
  }

  #validate(command: WaiveDeliverableCommand): void {
    for (const [name, value] of Object.entries({
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      correlationId: command.correlationId,
      principalId: command.principalId,
      deliverableId: command.deliverableId,
    })) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new ApplicationError("VALIDATION_FAILED", `${name} is required`);
      }
    }
    if (typeof command.reason !== "string" || command.reason.trim().length === 0) {
      throw new ApplicationError("WAIVER_REASON_REQUIRED", "A waiver reason is required");
    }
    if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion <= 0) {
      throw new ApplicationError("VALIDATION_FAILED", "expectedVersion must be a positive integer");
    }
    if (!command.occurredAtUtc.endsWith("Z") || Number.isNaN(Date.parse(command.occurredAtUtc))) {
      throw new ApplicationError("VALIDATION_FAILED", "occurredAtUtc must be a valid UTC timestamp");
    }
  }

  async #appendEvent(
    transaction: TransactionContext,
    command: WaiveDeliverableCommand,
    requirement: DeliverableRequirement,
  ): Promise<DomainEvent> {
    const sequence = await transaction.sequences.next(requirement.projectId);
    const event: DomainEvent = {
      tenantId: command.tenantId,
      eventId: `evt:${command.commandId}`,
      projectId: requirement.projectId,
      projectSequence: sequence,
      aggregateType: "deliverable",
      aggregateId: requirement.id,
      aggregateVersion: requirement.version,
      eventType: "project-map.deliverable.waived",
      schemaVersion: 1,
      actorPrincipalId: command.principalId,
      occurredAtUtc: command.occurredAtUtc,
      correlationId: command.correlationId,
      causationId: command.commandId,
      originalSecurityDomainId: requirement.securityDomainId,
      originalSecurityEpoch: requirement.securityEpoch,
      payload: {
        deliverableId: requirement.id,
        projectId: requirement.projectId,
        nodeId: requirement.ownerNodeId,
        waivedByPrincipalId: command.principalId,
        waivedReason: command.reason.trim(),
      },
    };
    await transaction.events.append(event);
    return event;
  }

  #outboxFor(event: DomainEvent): OutboxMessage {
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
}
