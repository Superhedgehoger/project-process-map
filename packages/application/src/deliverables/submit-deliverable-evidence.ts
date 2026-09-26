import { createHash } from "node:crypto";
import type { AssetBinding } from "../../../domain/src/assets.ts";
import {
  assertCanonicalDeliverableActionRecord,
  assertCanonicalEvidenceLink,
  submitDeliverable,
  type DeliverableActionRecord,
  type DeliverableRequirement,
  type EvidenceLink,
} from "../../../domain/src/deliverables.ts";
import { eventTopic, type DomainEvent, type OutboxMessage } from "../../../domain/src/events.ts";
import { isProjectManager } from "../../../domain/src/project-access.ts";
import { isNodeLeader } from "../../../domain/src/project-structure.ts";
import { isCanonicalUtcTimestamp } from "../../../domain/src/security-access.ts";
import {
  assertProjectSecurityStable,
  canAccessProjectObjectDuringMigration,
} from "../access/project-security.ts";
import { ApplicationError } from "../errors.ts";
import type {
  CommandScope,
  DeliverableRequirementView,
  Persistence,
  SubmitDeliverableEvidenceCommand,
  SubmitDeliverableEvidenceResult,
  TransactionContext,
} from "../ports/persistence.ts";
import {
  assertExactDeliverableReplayFacts,
  assertExactDeliverableReplayEventFacts,
  assertExactSubmitReplayCommandFacts,
  injectDeliverableFailure,
  toDeliverableRequirementView,
} from "./initialize-deliverable-requirement.ts";

export function hashSubmitDeliverablePayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class SubmitDeliverableEvidenceHandler {
  readonly #persistence: Persistence;

  constructor(persistence: Persistence) {
    this.#persistence = persistence;
  }

  async execute(
    command: SubmitDeliverableEvidenceCommand,
  ): Promise<SubmitDeliverableEvidenceResult> {
    this.#validate(command);
    const scope: CommandScope = {
      principalId: command.principalId,
      operation: "submit_deliverable_evidence",
      idempotencyKey: command.idempotencyKey,
    };
    const fingerprint = hashSubmitDeliverablePayload({
      deliverableId: command.deliverableId,
      expectedVersion: command.expectedVersion,
      evidence: command.evidence.map((e) => ({
        sourceType: e.sourceType,
        sourceId: e.sourceId,
      })),
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
      const isLeader = isNodeLeader(node, command.principalId);
      if (!isManager && !isLeader) {
        throw new ApplicationError(
          "DELIVERABLE_SUBMISSION_FORBIDDEN",
          "Only the project manager or node owner can submit deliverable evidence",
        );
      }

      const hasContribute = await canAccessProjectObjectDuringMigration(
        transaction,
        membership,
        command.principalId,
        req,
        "contribute",
        authorizationAtUtc,
      );
      if (!hasContribute) {
        throw new ApplicationError(
          "DELIVERABLE_SUBMISSION_FORBIDDEN",
          "Submitter does not have contribute access to security domain",
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
        // R2F1: Re-validate authoritative state on replay.
        // Authoritative requirement must still exist and be canonical; the replayed receipt must be
        // compatible with the current authoritative lifecycle:
        //  - requirement status/actor/links must still match the receipt value; terminal fields are
        //    enforced by assertCanonicalDeliverableRequirement; any drift (status advanced, actor or
        //    evidence drifted, node/domain/epoch mismatch) is DELIVERABLE_RECORD_CORRUPT (fail closed).
        //  - a later legitimate lifecycle step (e.g. accept/waive after this submit) means the
        //    replayed submit receipt is no longer the authoritative state: rejected with
        //    DELIVERABLE_VERSION_CONFLICT, never treated as a replay.
        if (
          req.status !== "submitted"
          || req.version !== command.expectedVersion + 1
          || previous.result.version !== req.version
        ) {
          throw new ApplicationError(
            "DELIVERABLE_VERSION_CONFLICT",
            "Replayed submit receipt is stale: authoritative requirement lifecycle advanced beyond the receipt",
          );
        }
        for (const item of command.evidence) {
          // R2F5 Finding 1: re-execute the accepted-source and ProcessRecord constraints for
          // every replayed evidence item (the source type must be accepted by the requirement
          // and process_record stays unsupported), not just file availability. A
          // file -> process_record tamper of the command, receipt or authoritative link
          // fails closed here or in the pair-set comparison below.
          if (!req.acceptedSourceTypes.includes(item.sourceType)) {
            throw new ApplicationError(
              "SOURCE_TYPE_UNSUPPORTED",
              `Source type ${item.sourceType} is not accepted by this requirement on replay`,
            );
          }
          if (item.sourceType === "process_record") {
            throw new ApplicationError(
              "PROCESS_RECORD_UNSUPPORTED",
              "ProcessRecord evidence source is currently unsupported",
            );
          }
          if (item.sourceType === "file") {
            const asset = await transaction.assets.get(item.sourceId);
            if (
              asset === undefined ||
              asset.deletedAtUtc !== null ||
              asset.tenantId !== req.tenantId ||
              asset.projectId !== req.projectId ||
              asset.ownerNodeId !== req.ownerNodeId ||
              asset.securityDomainId !== req.securityDomainId ||
              asset.securityEpoch !== req.securityEpoch
            ) {
              throw new ApplicationError(
                "EVIDENCE_NOT_FOUND",
                `Asset ${item.sourceId} is no longer available or scope drifted on replay`,
              );
            }
            if (asset.lifecycleState !== "available") {
              throw new ApplicationError(
                "EVIDENCE_NOT_AVAILABLE",
                `Asset ${item.sourceId} lifecycle state is ${asset.lifecycleState} on replay`,
              );
            }
          }
        }
        const replayLinks = await transaction.deliverables.listEvidenceLinks(req.id);
        const replayActions = await transaction.deliverables.listActions(req.id);
        const replayEvents = await transaction.events.list(command.tenantId);
        const replayOutbox = await transaction.outbox.list(command.tenantId);
        const authoritative = toDeliverableRequirementView(req, replayLinks, replayActions);
        assertExactDeliverableReplayFacts(previous.result, authoritative, "submitted");
        const submitAction = replayActions.find((action) => action.action === "submitted")!;
        // R2F5 Finding 1: bind the replay to the exact full (sourceType, sourceId) set of the
        // authoritative links and compare it against the original command/receipt pair set,
        // not only the sourceId projection. Any tamper of an authoritative link's
        // sourceType (or the receipt's) is a stable fail-closed mismatch.
        const pairKey = (sourceType: string, sourceId: string): string => `${sourceType}\u0000${sourceId}`;
        const authoritativePairKeys = replayLinks.map((link) => pairKey(link.sourceType, link.sourceId)).sort();
        const receiptPairKeys = previous.result.evidenceLinks
          .map((link) => pairKey(link.sourceType, link.sourceId))
          .sort();
        const commandPairKeys = command.evidence
          .map((item) => pairKey(item.sourceType, item.sourceId))
          .sort();
        if (authoritativePairKeys.join("\n") !== receiptPairKeys.join("\n")
          || authoritativePairKeys.join("\n") !== commandPairKeys.join("\n")) {
          throw new ApplicationError(
            "DELIVERABLE_RECORD_CORRUPT",
            "Replayed submit evidence does not exactly match authoritative (sourceType, sourceId) links",
          );
        }
        const commandEvidenceIds = command.evidence.map((item) => item.sourceId).sort();
        if (
          submitAction.evidenceCount !== command.evidence.length
          || submitAction.evidenceIds.length !== command.evidence.length
          || [...submitAction.evidenceIds].sort().some((id, index) => id !== commandEvidenceIds[index])
          || previous.result.evidenceLinks.length !== command.evidence.length
        ) {
          throw new ApplicationError(
            "DELIVERABLE_RECORD_CORRUPT",
            "Replayed submit action, evidence IDs, count and receipt payload do not match",
          );
        }
        // R2F6 Finding 1: precise canonical action/link/command consistency on replay — the
        // authoritative action set must be exactly initialized + submitted; the submitted
        // actor must equal the replaying command principal; every link's submitter/time must
        // equal the submitted action; each link ID must be the canonical
        // `link:<reqId>:<sourceType>:<sourceId>` form, bound to the authoritative pair set.
        // The submitted action's occurredAtUtc is the original command's business timestamp.
        // The complete fingerprint above has already required this replay command to carry the
        // same normalized occurredAtUtc before these authoritative fact checks run.
        const commandOccurredAtUtc = new Date(Date.parse(command.occurredAtUtc)).toISOString();
        if (previous.createdAtUtc !== commandOccurredAtUtc) {
          throw new ApplicationError(
            "DELIVERABLE_RECORD_CORRUPT",
            "Submit receipt time does not match the fingerprinted replay command",
          );
        }
        assertExactSubmitReplayCommandFacts({
          requirement: req,
          links: replayLinks,
          actions: replayActions,
          principalId: command.principalId,
          occurredAtUtc: commandOccurredAtUtc,
          receiptLinks: previous.result.evidenceLinks,
          receiptActions: previous.result.actionHistory,
        });
        assertExactDeliverableReplayEventFacts({
          tenantId: command.tenantId,
          projectId: req.projectId,
          requirement: req,
          eventType: "project-map.deliverable.submitted",
          actorPrincipalId: command.principalId,
          occurredAtUtc: commandOccurredAtUtc,
          expectedPayload: {
            deliverableId: req.id,
            projectId: req.projectId,
            nodeId: req.ownerNodeId,
            evidenceCount: command.evidence.length,
            evidenceIds: command.evidence.map((item) => item.sourceId),
          },
          events: replayEvents,
          outboxMessages: replayOutbox,
        });
        return { value: structuredClone(previous.result), replayed: true };
      }

      if (req.version !== command.expectedVersion) {
        throw new ApplicationError("DELIVERABLE_VERSION_CONFLICT", "Deliverable version conflict");
      }

      if (req.status === "accepted" || req.status === "waived") {
        throw new ApplicationError("DELIVERABLE_IS_TERMINAL", "Deliverable requirement is terminal");
      }
      if (req.status === "submitted") {
        throw new ApplicationError("DELIVERABLE_ALREADY_SUBMITTED", "Deliverable requirement is already submitted");
      }
      if (req.status !== "pending" && req.status !== "evidence_due") {
        throw new ApplicationError("DELIVERABLE_SUBMIT_TRANSITION_INVALID", `Deliverable status is ${req.status}`);
      }

      if (command.evidence.length < req.minCount) {
        throw new ApplicationError(
          "INSUFFICIENT_EVIDENCE_COUNT",
          `Evidence count (${command.evidence.length}) is less than requirement minCount (${req.minCount})`,
        );
      }

      const distinctSourceIds = new Set(command.evidence.map((e) => e.sourceId));
      if (distinctSourceIds.size !== command.evidence.length) {
        throw new ApplicationError("DUPLICATE_EVIDENCE", "Duplicate evidence items are not allowed");
      }

      for (const item of command.evidence) {
        if (!req.acceptedSourceTypes.includes(item.sourceType)) {
          throw new ApplicationError(
            "SOURCE_TYPE_UNSUPPORTED",
            `Source type ${item.sourceType} is not accepted by this requirement`,
          );
        }
        if (item.sourceType === "process_record") {
          throw new ApplicationError(
            "PROCESS_RECORD_UNSUPPORTED",
            "ProcessRecord evidence source is currently unsupported",
          );
        }
        if (item.sourceType === "file") {
          const asset = await transaction.assets.get(item.sourceId);
          if (asset === undefined || asset.deletedAtUtc !== null) {
            throw new ApplicationError("EVIDENCE_NOT_FOUND", `Asset ${item.sourceId} is not found or deleted`);
          }
          if (
            asset.tenantId !== req.tenantId
            || asset.projectId !== req.projectId
            || asset.ownerNodeId !== req.ownerNodeId
            || asset.securityDomainId !== req.securityDomainId
            || asset.securityEpoch !== req.securityEpoch
          ) {
            throw new ApplicationError(
              "EVIDENCE_NOT_FOUND",
              `Asset ${item.sourceId} is not in the scope of this deliverable requirement`,
            );
          }
          if (asset.lifecycleState !== "available") {
            throw new ApplicationError(
              "EVIDENCE_NOT_AVAILABLE",
              `Asset ${item.sourceId} lifecycle state is ${asset.lifecycleState}`,
            );
          }
        }
      }

      const updated = submitDeliverable(req, { occurredAtUtc: command.occurredAtUtc });
      await transaction.deliverables.savePreservingSecurityOwnership(req.id, updated, req.version);
      injectDeliverableFailure(command.failurePoint, "after_aggregate");

      for (const item of command.evidence) {
        const linkId = `link:${req.id}:${item.sourceType}:${item.sourceId}`;
        const link: EvidenceLink = {
          tenantId: command.tenantId,
          id: linkId,
          requirementId: req.id,
          sourceType: item.sourceType,
          sourceId: item.sourceId,
          submittedByPrincipalId: command.principalId,
          linkedAtUtc: command.occurredAtUtc,
          version: 1,
        };
        assertCanonicalEvidenceLink(link, {
          tenantId: command.tenantId,
          requirementId: req.id,
        });
        await transaction.deliverables.appendEvidenceLink(link);

        if (item.sourceType === "file") {
          const bindingId = `asset-binding:${item.sourceId}:deliverable:${req.id}`;
          const existingBindings = await transaction.assets.listBindings("deliverable", req.id);
          if (!existingBindings.some((b) => b.assetId === item.sourceId)) {
            const binding: AssetBinding = {
              tenantId: command.tenantId,
              id: bindingId,
              assetId: item.sourceId,
              targetType: "deliverable",
              targetId: req.id,
              purpose: "evidence",
              version: 1,
              invalidatedAtUtc: null,
            };
            await transaction.assets.insertBinding(binding);
          }
        }
      }
      injectDeliverableFailure(command.failurePoint, "after_evidence");

      const actionRecord: DeliverableActionRecord = {
        tenantId: command.tenantId,
        id: `act:${command.commandId}`,
        requirementId: req.id,
        action: "submitted",
        actorPrincipalId: command.principalId,
        occurredAtUtc: command.occurredAtUtc,
        reason: null,
        evidenceCount: command.evidence.length,
        evidenceIds: command.evidence.map((e) => e.sourceId),
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

  #validate(command: SubmitDeliverableEvidenceCommand): void {
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
    if (!Array.isArray(command.evidence) || command.evidence.length === 0) {
      throw new ApplicationError("VALIDATION_FAILED", "evidence must be a non-empty array");
    }
    for (const item of command.evidence) {
      if (!item || typeof item !== "object") {
        throw new ApplicationError("VALIDATION_FAILED", "evidence items must be objects");
      }
      if (item.sourceType !== "file" && item.sourceType !== "process_record") {
        throw new ApplicationError("VALIDATION_FAILED", `Invalid evidence sourceType: ${item.sourceType}`);
      }
      if (typeof item.sourceId !== "string" || item.sourceId.trim().length === 0) {
        throw new ApplicationError("VALIDATION_FAILED", "evidence sourceId is required");
      }
    }
    if (!command.occurredAtUtc.endsWith("Z") || Number.isNaN(Date.parse(command.occurredAtUtc))) {
      throw new ApplicationError("VALIDATION_FAILED", "occurredAtUtc must be a valid UTC timestamp");
    }
  }

  async #appendEvent(
    transaction: TransactionContext,
    command: SubmitDeliverableEvidenceCommand,
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
      eventType: "project-map.deliverable.submitted",
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
        evidenceCount: command.evidence.length,
        evidenceIds: command.evidence.map((e) => e.sourceId),
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
