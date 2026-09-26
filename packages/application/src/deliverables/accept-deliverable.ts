import { createHash } from "node:crypto";
import {
  acceptDeliverable,
  assertCanonicalDeliverableActionRecord,
  type DeliverableActionRecord,
  type DeliverableRequirement,
  type EvidenceLink,
} from "../../../domain/src/deliverables.ts";
import { eventTopic, type DomainEvent, type OutboxMessage } from "../../../domain/src/events.ts";
import { isProjectManager } from "../../../domain/src/project-access.ts";
import {
  assertProjectSecurityStable,
  canAccessProjectObjectDuringMigration,
} from "../access/project-security.ts";
import { ApplicationError } from "../errors.ts";
import type {
  AcceptDeliverableCommand,
  AcceptDeliverableResult,
  CommandScope,
  DeliverableRequirementView,
  Persistence,
  TransactionContext,
} from "../ports/persistence.ts";
import {
  assertExactDeliverableReplayFacts,
  assertExactDeliverableReplayEventFacts,
  assertExactTerminalReplayCommandFacts,
  injectDeliverableFailure,
  toDeliverableRequirementView,
} from "./initialize-deliverable-requirement.ts";

export function hashAcceptDeliverablePayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// R2F3 Finding 1: the first (non-replay) accept must validate the exact authoritative submitted
// action and EvidenceLink set before advancing the aggregate or writing any fact. The caller
// invokes `validateAuthoritativeSubmission` strictly between the CAS status/version gates and the
// first `savePreservingSecurityOwnership` write; any drift is fail-closed.
//
// R2F6 Finding 2: `validateReplaySubmissionFacts` re-applies the same complete file-evidence
// semantics on the submit portion of the action/link record set during accept/waive replay.
// The accept replay tolerates the terminal accepted/waived action that legitimately follows the
// submit; the semantic checks (exact initialized+submitted set, link ID/actor/time
// canonicality, accepted-source and ProcessRecord rejection, per-asset availability) are
// identical to the first-accept path, so a file -> process_record double tamper of the link
// and the receipt fails closed in replay as well.
export async function validateReplaySubmissionFacts(
  transaction: TransactionContext,
  requirement: DeliverableRequirement,
  links: readonly EvidenceLink[],
  actions: readonly DeliverableActionRecord[],
): Promise<void> {
  const terminal = requirement.status === "accepted" ? "accepted" : requirement.status === "waived" ? "waived" : null;
  const expected = terminal === null
    ? new Set<DeliverableActionRecord["action"]>(["initialized", "submitted"])
    : new Set<DeliverableActionRecord["action"]>(["initialized", "submitted", terminal]);
  if (actions.length !== expected.size || actions.some((action) => !expected.has(action.action))) {
    throw new ApplicationError(
      "DELIVERABLE_RECORD_CORRUPT",
      "Replayed deliverable actions do not exactly match the authoritative lifecycle record set",
    );
  }
  const submitPortion = actions.filter((action) => action.action === "initialized" || action.action === "submitted");
  await validateAuthoritativeSubmission(
    transaction,
    requirement,
    links,
    submitPortion,
  );
}

export async function validateAuthoritativeSubmission(
  transaction: TransactionContext,
  requirement: DeliverableRequirement,
  links: readonly EvidenceLink[],
  actions: readonly DeliverableActionRecord[],
): Promise<void> {
  const initial = actions.filter((action) => action.action === "initialized");
  const submittedActions = actions.filter((action) => action.action === "submitted");
  if (
    actions.length !== 2
    || initial.length !== 1
    || submittedActions.length !== 1
  ) {
    throw new ApplicationError(
      "DELIVERABLE_RECORD_CORRUPT",
      "Submitted deliverable must have exactly one initialized action and one submitted action",
    );
  }

  const submittedAction = submittedActions[0]!;
  const actionEvidenceIds = [...submittedAction.evidenceIds].sort();
  const linkEvidenceIds = links.map((link) => link.sourceId).sort();
  if (
    links.length < requirement.minCount
    || submittedAction.evidenceCount !== links.length
    || actionEvidenceIds.length !== links.length
    || actionEvidenceIds.some((id, index) => id !== linkEvidenceIds[index])
  ) {
    throw new ApplicationError(
      "DELIVERABLE_RECORD_CORRUPT",
      "Submitted action evidence IDs/count do not exactly match authoritative EvidenceLinks",
    );
  }

  const naturalKeys = new Set<string>();
  const linkIds = new Set<string>();
  for (const link of links) {
    const naturalKey = `${link.sourceType}\u0000${link.sourceId}`;
    if (
      naturalKeys.has(naturalKey)
      || linkIds.has(link.id)
      || link.id !== `link:${requirement.id}:${link.sourceType}:${link.sourceId}`
      || link.submittedByPrincipalId !== submittedAction.actorPrincipalId
      || link.linkedAtUtc !== submittedAction.occurredAtUtc
      || !requirement.acceptedSourceTypes.includes(link.sourceType)
    ) {
      throw new ApplicationError(
        "DELIVERABLE_RECORD_CORRUPT",
        "Authoritative EvidenceLink set does not exactly match the submitted action",
      );
    }
    naturalKeys.add(naturalKey);
    linkIds.add(link.id);

    if (link.sourceType !== "file") {
      throw new ApplicationError(
        "PROCESS_RECORD_UNSUPPORTED",
        "ProcessRecord evidence source is currently unsupported",
      );
    }
    const asset = await transaction.assets.get(link.sourceId);
    if (
      asset === undefined
      || asset.deletedAtUtc !== null
      || asset.tenantId !== requirement.tenantId
      || asset.projectId !== requirement.projectId
      || asset.ownerNodeId !== requirement.ownerNodeId
      || asset.securityDomainId !== requirement.securityDomainId
      || asset.securityEpoch !== requirement.securityEpoch
    ) {
      throw new ApplicationError(
        "EVIDENCE_NOT_FOUND",
        `Evidence asset ${link.sourceId} is no longer available or scope drifted before acceptance`,
      );
    }
    if (asset.lifecycleState !== "available") {
      throw new ApplicationError(
        "EVIDENCE_NOT_AVAILABLE",
        `Evidence asset ${link.sourceId} lifecycle state is ${asset.lifecycleState} before acceptance`,
      );
    }
  }
}

export class AcceptDeliverableHandler {
  readonly #persistence: Persistence;

  constructor(persistence: Persistence) {
    this.#persistence = persistence;
  }

  async execute(command: AcceptDeliverableCommand): Promise<AcceptDeliverableResult> {
    this.#validate(command);
    const scope: CommandScope = {
      principalId: command.principalId,
      operation: "accept_deliverable",
      idempotencyKey: command.idempotencyKey,
    };
    const fingerprint = hashAcceptDeliverablePayload({
      deliverableId: command.deliverableId,
      expectedVersion: command.expectedVersion,
      note: command.note?.trim() || null,
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

      const isSnapshottedReviewer = command.principalId === req.reviewerPrincipalId;
      const isManager = isProjectManager(membership);

      if (!isSnapshottedReviewer && !isManager) {
        throw new ApplicationError(
          "DELIVERABLE_ACTION_FORBIDDEN",
          "Only the assigned reviewer or a project manager can accept this deliverable",
        );
      }

      if (isSnapshottedReviewer) {
        const revPrincipal = await transaction.principals.get(req.reviewerPrincipalId);
        if (revPrincipal?.status !== "active" || revPrincipal.kind !== "user") {
          throw new ApplicationError("REVIEWER_NOT_ELIGIBLE", "Reviewer is no longer active");
        }
        const revMembership = await transaction.memberships.get(req.projectId, req.reviewerPrincipalId);
        if (revMembership?.status !== "active") {
          throw new ApplicationError("REVIEWER_NOT_ELIGIBLE", "Reviewer membership is no longer active");
        }
        const hasAccess = await canAccessProjectObjectDuringMigration(
          transaction,
          revMembership,
          command.principalId,
          req,
          "view",
          authorizationAtUtc,
        );
        if (!hasAccess) {
          throw new ApplicationError("REVIEWER_NOT_ELIGIBLE", "Reviewer lacks required capability in security domain");
        }
      } else {
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
        //  - accepted terminal state is stable: the replayed accept receipt stays compatible as long
        //    as authoritative actor/time/status still match the receipt; any drift is fail-closed.
        //  - a later legitimate lifecycle step does not exist after acceptance, so a replay after any
        //    state advance beyond accepted is rejected with DELIVERABLE_VERSION_CONFLICT.
        if (
          req.status !== "accepted"
          || req.version !== command.expectedVersion + 1
          || previous.result.version !== req.version
        ) {
          throw new ApplicationError(
            "DELIVERABLE_VERSION_CONFLICT",
            "Replayed accept receipt is stale: authoritative requirement lifecycle no longer matches the command",
          );
        }
        if (
          req.acceptedByPrincipalId !== previous.result.acceptedByPrincipalId
          || req.acceptedAtUtc !== previous.result.acceptedAtUtc
        ) {
          throw new ApplicationError(
            "DELIVERABLE_RECORD_CORRUPT",
            "Replayed accept receipt no longer matches the authoritative acceptance record",
          );
        }
        const replayLinks = await transaction.deliverables.listEvidenceLinks(req.id);
        const replayActions = await transaction.deliverables.listActions(req.id);
        const replayEvents = await transaction.events.list(command.tenantId);
        const replayOutbox = await transaction.outbox.list(command.tenantId);
        const authoritative = toDeliverableRequirementView(req, replayLinks, replayActions);
        assertExactDeliverableReplayFacts(previous.result, authoritative, "accepted");
        const commandOccurredAtUtc = new Date(Date.parse(command.occurredAtUtc)).toISOString();
        assertExactTerminalReplayCommandFacts({
          terminal: "accepted",
          requirement: req,
          receipt: previous.result,
          authoritativeActions: replayActions,
          receiptActions: previous.result.actionHistory,
          principalId: command.principalId,
          commandOccurredAtUtc,
          receiptCreatedAtUtc: previous.createdAtUtc,
          normalizedReason: command.note?.trim() || null,
        });
        assertExactDeliverableReplayEventFacts({
          tenantId: command.tenantId,
          projectId: req.projectId,
          requirement: req,
          eventType: "project-map.deliverable.accepted",
          actorPrincipalId: command.principalId,
          occurredAtUtc: commandOccurredAtUtc,
          expectedPayload: {
            deliverableId: req.id,
            projectId: req.projectId,
            nodeId: req.ownerNodeId,
            acceptedByPrincipalId: command.principalId,
            ...(command.note?.trim() ? { acceptedReason: command.note.trim() } : {}),
          },
          events: replayEvents,
          outboxMessages: replayOutbox,
        });
        // R2F6 Finding 2: accept replay re-runs the complete first-accept authoritative
        // submission semantics (exact initialized+submitted action set, canonical link
        // ID/submitter/time binding, accepted-source and ProcessRecord rejection, per-asset
        // scope/availability) on the current authoritative links/actions, instead of only
        // the asset-availability projection below. A file -> process_record tamper of the
        // link and receipt together now fails closed in replay.
        await validateReplaySubmissionFacts(transaction, req, replayLinks, replayActions);
        return { value: structuredClone(previous.result), replayed: true };
      }

      if (req.status === "accepted") {
        throw new ApplicationError("DELIVERABLE_ALREADY_ACCEPTED", "Deliverable requirement is already accepted");
      }
      if (req.status === "waived") {
        throw new ApplicationError("DELIVERABLE_IS_TERMINAL", "Deliverable requirement is terminal");
      }
      if (req.status !== "submitted") {
        throw new ApplicationError(
          "DELIVERABLE_NOT_SUBMITTED",
          `Deliverable requirement must be submitted before acceptance, current status is ${req.status}`,
        );
      }

      if (req.version !== command.expectedVersion) {
        throw new ApplicationError("DELIVERABLE_VERSION_CONFLICT", "Deliverable version conflict");
      }

      const submittedLinks = await transaction.deliverables.listEvidenceLinks(req.id);
      const submittedActions = await transaction.deliverables.listActions(req.id);
      await validateAuthoritativeSubmission(transaction, req, submittedLinks, submittedActions);

      const updated = acceptDeliverable(req, {
        acceptedByPrincipalId: command.principalId,
        occurredAtUtc: command.occurredAtUtc,
        acceptedReason: command.note ?? null,
      });
      await transaction.deliverables.savePreservingSecurityOwnership(req.id, updated, req.version);
      injectDeliverableFailure(command.failurePoint, "after_aggregate");

      const actionRecord: DeliverableActionRecord = {
        tenantId: command.tenantId,
        id: `act:${command.commandId}`,
        requirementId: req.id,
        action: "accepted",
        actorPrincipalId: command.principalId,
        occurredAtUtc: command.occurredAtUtc,
        reason: command.note?.trim() || null,
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

  #validate(command: AcceptDeliverableCommand): void {
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
    if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion <= 0) {
      throw new ApplicationError("VALIDATION_FAILED", "expectedVersion must be a positive integer");
    }
    if (!command.occurredAtUtc.endsWith("Z") || Number.isNaN(Date.parse(command.occurredAtUtc))) {
      throw new ApplicationError("VALIDATION_FAILED", "occurredAtUtc must be a valid UTC timestamp");
    }
  }

  async #appendEvent(
    transaction: TransactionContext,
    command: AcceptDeliverableCommand,
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
      eventType: "project-map.deliverable.accepted",
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
        acceptedByPrincipalId: command.principalId,
        ...(command.note?.trim() ? { acceptedReason: command.note.trim() } : {}),
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
