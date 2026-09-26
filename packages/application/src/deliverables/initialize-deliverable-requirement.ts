import { createHash } from "node:crypto";
import {
  assertCanonicalDeliverableActionRecord,
  assertCanonicalDeliverableRequirement,
  assertCanonicalEvidenceLink,
  assertValidRequirementKey,
  type DeliverableAction,
  type DeliverableActionRecord,
  type DeliverableRequirement,
  type EvidenceLink,
} from "../../../domain/src/deliverables.ts";
import { isCanonicalUtcTimestamp } from "../../../domain/src/security-access.ts";
import { eventTopic, type DomainEvent, type OutboxMessage } from "../../../domain/src/events.ts";
import { isNodeLeader } from "../../../domain/src/project-structure.ts";
import { isProjectManager } from "../../../domain/src/project-access.ts";
import {
  assertProjectSecurityStable,
  canAccessProjectObject,
  canAccessProjectObjectDuringMigration,
} from "../access/project-security.ts";
import { ApplicationError } from "../errors.ts";
import type {
  CommandScope,
  DeliverableFailurePoint,
  DeliverableRequirementView,
  InitializeDeliverableRequirementCommand,
  InitializeDeliverableRequirementResult,
  Persistence,
  TransactionContext,
} from "../ports/persistence.ts";

export function toDeliverableRequirementView(
  requirement: DeliverableRequirement,
  links: readonly import("../../../domain/src/deliverables.ts").EvidenceLink[],
  actions: readonly DeliverableActionRecord[],
): DeliverableRequirementView {
  return {
    id: requirement.id,
    projectId: requirement.projectId,
    nodeId: requirement.ownerNodeId,
    requirementKey: requirement.requirementKey,
    title: requirement.title,
    description: requirement.description,
    required: requirement.required,
    acceptedSourceTypes: requirement.acceptedSourceTypes,
    minCount: requirement.minCount,
    reviewerPrincipalId: requirement.reviewerPrincipalId,
    status: requirement.status,
    acceptedByPrincipalId: requirement.acceptedByPrincipalId,
    acceptedAtUtc: requirement.acceptedAtUtc,
    acceptedReason: requirement.acceptedReason,
    waivedByPrincipalId: requirement.waivedByPrincipalId,
    waivedAtUtc: requirement.waivedAtUtc,
    waivedReason: requirement.waivedReason,
    version: requirement.version,
    evidenceLinks: links,
    actionHistory: actions,
  };
}

export function hashInitializeDeliverablePayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function assertExactDeliverableReplayFacts(
  receipt: DeliverableRequirementView,
  authoritative: DeliverableRequirementView,
  expectedAction: DeliverableAction,
): void {
  if (!Array.isArray(receipt.evidenceLinks) || !Array.isArray(receipt.actionHistory)) {
    throw new ApplicationError("DELIVERABLE_RECORD_CORRUPT", "Replay receipt facts are malformed");
  }
  const validateFacts = (
    links: readonly EvidenceLink[],
    actions: readonly DeliverableActionRecord[],
    source: string,
  ): void => {
    const linkIds = new Set<string>();
    const naturalKeys = new Set<string>();
    for (const link of links) {
      try {
        assertCanonicalEvidenceLink(link, { requirementId: authoritative.id });
      } catch {
        throw new ApplicationError("DELIVERABLE_RECORD_CORRUPT", `${source} evidence link is corrupt`);
      }
      const naturalKey = `${link.tenantId}\u0000${link.requirementId}\u0000${link.sourceType}\u0000${link.sourceId}`;
      if (linkIds.has(link.id) || naturalKeys.has(naturalKey)) {
        throw new ApplicationError("DELIVERABLE_RECORD_CORRUPT", `${source} evidence links contain duplicates`);
      }
      linkIds.add(link.id);
      naturalKeys.add(naturalKey);
    }
    const actionIds = new Set<string>();
    const actionTypes = new Set<DeliverableAction>();
    for (const action of actions) {
      try {
        assertCanonicalDeliverableActionRecord(action, { requirementId: authoritative.id });
      } catch {
        throw new ApplicationError("DELIVERABLE_RECORD_CORRUPT", `${source} deliverable action is corrupt`);
      }
      if (actionIds.has(action.id) || actionTypes.has(action.action)) {
        throw new ApplicationError("DELIVERABLE_RECORD_CORRUPT", `${source} deliverable actions contain duplicates`);
      }
      actionIds.add(action.id);
      actionTypes.add(action.action);
    }
    if (actions.filter((action) => action.action === expectedAction).length !== 1) {
      throw new ApplicationError("DELIVERABLE_RECORD_CORRUPT", `${source} ${expectedAction} action is missing or duplicated`);
    }
  };

  validateFacts(receipt.evidenceLinks, receipt.actionHistory, "Receipt");
  validateFacts(authoritative.evidenceLinks, authoritative.actionHistory, "Authoritative");
  if (stableJson(receipt) !== stableJson(authoritative)) {
    throw new ApplicationError(
      "DELIVERABLE_RECORD_CORRUPT",
      "Replay receipt does not exactly match authoritative deliverable, action and evidence facts",
    );
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    const sorted = [...value].sort((left, right) => {
      const leftId = typeof left === "object" && left !== null && "id" in left ? String(left.id) : JSON.stringify(left);
      const rightId = typeof right === "object" && right !== null && "id" in right ? String(right.id) : JSON.stringify(right);
      return leftId.localeCompare(rightId);
    });
    return `[${sorted.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function assertExactDeliverableReplayEventFacts(params: Readonly<{
  tenantId: string;
  projectId: string;
  requirement: Pick<DeliverableRequirement, "id" | "securityDomainId" | "securityEpoch" | "version">;
  eventType: "project-map.deliverable.submitted" | "project-map.deliverable.accepted" | "project-map.deliverable.waived";
  actorPrincipalId: string;
  occurredAtUtc: string;
  expectedPayload: Readonly<Record<string, unknown>>;
  events: readonly DomainEvent[];
  outboxMessages: readonly OutboxMessage[];
}>): void {
  const {
    tenantId,
    projectId,
    requirement,
    eventType,
    actorPrincipalId,
    occurredAtUtc,
    expectedPayload,
    events,
    outboxMessages,
  } = params;
  const relevantEvents = events.filter((event) => {
    const payload = typeof event.payload === "object" && event.payload !== null
      ? event.payload as Record<string, unknown>
      : null;
    return event.eventType === eventType
      && (event.aggregateId === requirement.id || payload?.deliverableId === requirement.id);
  });
  if (relevantEvents.length !== 1) {
    throw new ApplicationError(
      "DELIVERABLE_RECORD_CORRUPT",
      `Replay requires exactly one authoritative ${eventType} event`,
    );
  }
  const event = relevantEvents[0]!;
  if (
    event.tenantId !== tenantId
    || event.projectId !== projectId
    || event.aggregateType !== "deliverable"
    || event.aggregateId !== requirement.id
    || event.aggregateVersion !== requirement.version
    || event.schemaVersion !== 1
    || event.actorPrincipalId !== actorPrincipalId
    || event.occurredAtUtc !== occurredAtUtc
    || event.originalSecurityDomainId !== requirement.securityDomainId
    || event.originalSecurityEpoch !== requirement.securityEpoch
    || stableJson(event.payload) !== stableJson(expectedPayload)
  ) {
    throw new ApplicationError(
      "DELIVERABLE_RECORD_CORRUPT",
      `Authoritative ${eventType} event drifted from the replay command or aggregate`,
    );
  }

  const relevantOutbox = outboxMessages.filter((message) => {
    const payload = message.payload;
    return message.eventId === event.eventId
      || payload.eventId === event.eventId
      || (payload.eventType === eventType && payload.aggregateId === requirement.id);
  });
  if (relevantOutbox.length !== 1) {
    throw new ApplicationError(
      "DELIVERABLE_RECORD_CORRUPT",
      `Replay requires exactly one outbox message for ${eventType}`,
    );
  }
  const outbox = relevantOutbox[0]!;
  if (
    outbox.tenantId !== tenantId
    || outbox.id !== `outbox:${event.eventId}`
    || outbox.eventId !== event.eventId
    || outbox.topic !== eventTopic(event)
    || outbox.createdAtUtc !== event.occurredAtUtc
    || stableJson(outbox.payload) !== stableJson(event)
  ) {
    throw new ApplicationError(
      "DELIVERABLE_RECORD_CORRUPT",
      `Outbox message diverged from the authoritative ${eventType} event`,
    );
  }
}

// R2F6 Finding 1: precise canonical action/link/command consistency for the submit replay path.
// The authoritative action set must be exactly initialized + submitted; the submitted action's
// actor and time must equal the replaying command's principal and occurredAtUtc; every
// evidence link's submitter/time must equal the submitted action's; each link ID must be the
// canonical `link:<requirementId>:<sourceType>:<sourceId>` form. Simultaneous tamper of the
// submitted action, the evidence links and the replaying command payload (even while keeping
// actor/time internally consistent inside the records) fails closed here.
export function assertExactSubmitReplayCommandFacts(params: Readonly<{
  requirement: Pick<DeliverableRequirement, "id" | "tenantId" | "updatedAtUtc">
  links: readonly EvidenceLink[];
  actions: readonly DeliverableActionRecord[];
  principalId: string;
  occurredAtUtc: string;
  receiptLinks: readonly EvidenceLink[];
  receiptActions: readonly DeliverableActionRecord[];
}>): void {
  const { requirement, links, actions, principalId, occurredAtUtc, receiptLinks, receiptActions } = params;
  if (requirement.updatedAtUtc !== occurredAtUtc) {
    throw new ApplicationError(
      "DELIVERABLE_RECORD_CORRUPT",
      "Authoritative submitted aggregate time does not match the fingerprinted replay command",
    );
  }
  const linkConsistency = (
    linkSet: readonly EvidenceLink[],
    actionSet: readonly DeliverableActionRecord[],
    commandPrincipalId: string,
    commandOccurredAtUtc: string,
    source: string,
  ): void => {
    const actionTypes = new Set(actionSet.map((action) => action.action));
    if (
      actionSet.length !== 2
      || !actionTypes.has("initialized")
      || !actionTypes.has("submitted")
      || actionTypes.size !== 2
    ) {
      throw new ApplicationError(
        "DELIVERABLE_RECORD_CORRUPT",
        `${source} action set must be exactly one initialized and one submitted action`,
      );
    }
    const submitted = actionSet.find((action) => action.action === "submitted")!;
    if (submitted.actorPrincipalId !== commandPrincipalId) {
      throw new ApplicationError(
        "DELIVERABLE_RECORD_CORRUPT",
        `${source} submitted action actor does not equal the replaying command principal`,
      );
    }
    if (submitted.occurredAtUtc !== commandOccurredAtUtc) {
      throw new ApplicationError(
        "DELIVERABLE_RECORD_CORRUPT",
        `${source} submitted action time does not equal the replaying command occurredAtUtc`,
      );
    }
    for (const link of linkSet) {
      if (link.id !== `link:${requirement.id}:${link.sourceType}:${link.sourceId}`) {
        throw new ApplicationError(
          "DELIVERABLE_RECORD_CORRUPT",
          `${source} evidence link id is not canonical for its (sourceType, sourceId) pair`,
        );
      }
      if (link.submittedByPrincipalId !== submitted.actorPrincipalId || link.linkedAtUtc !== submitted.occurredAtUtc) {
        throw new ApplicationError(
          "DELIVERABLE_RECORD_CORRUPT",
          `${source} evidence link submitter/time does not match the submitted action`,
        );
      }
    }
  };
  linkConsistency(links, actions, principalId, occurredAtUtc, "Authoritative");
  linkConsistency(receiptLinks, receiptActions, principalId, occurredAtUtc, "Receipt");
  if (
    receiptLinks.length !== links.length
    || receiptActions.length !== actions.length
    || receiptLinks.some((link, index) => {
      const other = links[index]!;
      return link.id !== other.id
        || link.sourceType !== other.sourceType
        || link.sourceId !== other.sourceId;
    })
    || receiptActions.some((action, index) => {
      const other = actions[index]!;
      return action.id !== other.id
        || action.action !== other.action
        || action.actorPrincipalId !== other.actorPrincipalId
        || action.occurredAtUtc !== other.occurredAtUtc;
    })
  ) {
    throw new ApplicationError(
      "DELIVERABLE_RECORD_CORRUPT",
      "Receipt action/link records do not exactly match the authoritative submit records",
    );
  }
}

// R2F7 Finding 1: terminal replay is valid only when the complete lifecycle and terminal
// command facts remain bound together. This is intentionally stricter than receipt/view
// equality: a coordinated action+receipt tamper must not redefine the terminal actor/time/reason.
export function assertExactTerminalReplayCommandFacts(params: Readonly<{
  terminal: "accepted" | "waived";
  requirement: DeliverableRequirement;
  receipt: DeliverableRequirementView;
  authoritativeActions: readonly DeliverableActionRecord[];
  receiptActions: readonly DeliverableActionRecord[];
  principalId: string;
  commandOccurredAtUtc: string;
  receiptCreatedAtUtc: string;
  normalizedReason: string | null;
}>): void {
  const {
    terminal,
    requirement,
    receipt,
    authoritativeActions,
    receiptActions,
    principalId,
    commandOccurredAtUtc,
    receiptCreatedAtUtc,
    normalizedReason,
  } = params;
  if (receiptCreatedAtUtc !== commandOccurredAtUtc) {
    throw new ApplicationError(
      "DELIVERABLE_RECORD_CORRUPT",
      `Receipt ${terminal} time does not match the fingerprinted replay command`,
    );
  }
  if (requirement.updatedAtUtc !== commandOccurredAtUtc) {
    throw new ApplicationError(
      "DELIVERABLE_RECORD_CORRUPT",
      `Authoritative ${terminal} aggregate update time does not match the fingerprinted replay command`,
    );
  }
  const assertLifecycle = (actions: readonly DeliverableActionRecord[], source: string): DeliverableActionRecord => {
    const hasSubmitted = actions.some((action) => action.action === "submitted");
    const expected = terminal === "accepted" || hasSubmitted
      ? new Set<DeliverableAction>(["initialized", "submitted", terminal])
      : new Set<DeliverableAction>(["initialized", "waived"]);
    const actual = new Set(actions.map((action) => action.action));
    if (
      actions.length !== expected.size
      || actual.size !== expected.size
      || [...actual].some((action) => !expected.has(action))
    ) {
      throw new ApplicationError(
        "DELIVERABLE_RECORD_CORRUPT",
        `${source} action set does not exactly match the ${terminal} lifecycle`,
      );
    }
    return actions.find((action) => action.action === terminal)!;
  };

  const authoritativeTerminal = assertLifecycle(authoritativeActions, "Authoritative");
  const receiptTerminal = assertLifecycle(receiptActions, "Receipt");
  const aggregateActor = terminal === "accepted"
    ? requirement.acceptedByPrincipalId
    : requirement.waivedByPrincipalId;
  const aggregateTime = terminal === "accepted"
    ? requirement.acceptedAtUtc
    : requirement.waivedAtUtc;
  const aggregateReason = terminal === "accepted"
    ? requirement.acceptedReason
    : requirement.waivedReason;
  const receiptActor = terminal === "accepted"
    ? receipt.acceptedByPrincipalId
    : receipt.waivedByPrincipalId;
  const receiptTime = terminal === "accepted"
    ? receipt.acceptedAtUtc
    : receipt.waivedAtUtc;
  const receiptReason = terminal === "accepted"
    ? receipt.acceptedReason
    : receipt.waivedReason;

  for (const [source, action] of [
    ["Authoritative", authoritativeTerminal],
    ["Receipt", receiptTerminal],
  ] as const) {
    if (
      action.actorPrincipalId !== principalId
      || action.actorPrincipalId !== aggregateActor
      || action.occurredAtUtc !== commandOccurredAtUtc
      || action.occurredAtUtc !== receiptCreatedAtUtc
      || action.occurredAtUtc !== aggregateTime
      || action.reason !== normalizedReason
      || action.reason !== aggregateReason
      || action.evidenceCount !== 0
      || action.evidenceIds.length !== 0
    ) {
      throw new ApplicationError(
        "DELIVERABLE_RECORD_CORRUPT",
        `${source} ${terminal} action does not match the aggregate, replay principal, receipt time and command payload`,
      );
    }
  }
  if (
    receiptActor !== aggregateActor
    || receiptTime !== aggregateTime
    || receiptReason !== aggregateReason
    || receiptActor !== principalId
    || receiptTime !== commandOccurredAtUtc
    || receiptTime !== receiptCreatedAtUtc
    || receiptReason !== normalizedReason
  ) {
    throw new ApplicationError(
      "DELIVERABLE_RECORD_CORRUPT",
      `Receipt ${terminal} facts do not match the aggregate and replay command`,
    );
  }
}

export function assertExactInitializeReplayCommandFacts(params: Readonly<{
  requirement: DeliverableRequirement;
  receipt: DeliverableRequirementView;
  authoritativeLinks: readonly EvidenceLink[];
  authoritativeActions: readonly DeliverableActionRecord[];
  initializationEvents: readonly DomainEvent[];
  command: InitializeDeliverableRequirementCommand;
  receiptCreatedAtUtc: string;
  nodeSecurityDomainId: string | null;
  nodeSecurityEpoch: number;
}>): void {
  const {
    requirement,
    receipt,
    authoritativeLinks,
    authoritativeActions,
    initializationEvents,
    command,
    receiptCreatedAtUtc,
    nodeSecurityDomainId,
    nodeSecurityEpoch,
  } = params;
  const occurredAtUtc = new Date(Date.parse(command.occurredAtUtc)).toISOString();
  if (receiptCreatedAtUtc !== occurredAtUtc) {
    throw new ApplicationError(
      "DELIVERABLE_RECORD_CORRUPT",
      "Initialize receipt creation time does not match the normalized command occurredAtUtc",
    );
  }
  if (authoritativeLinks.length !== 0 || receipt.evidenceLinks.length !== 0) {
    throw new ApplicationError("DELIVERABLE_RECORD_CORRUPT", "Initialized requirement must not contain evidence links");
  }

  const assertInitializedAction = (
    actions: readonly DeliverableActionRecord[],
    source: string,
  ): DeliverableActionRecord => {
    if (actions.length !== 1 || actions[0]?.action !== "initialized") {
      throw new ApplicationError(
        "DELIVERABLE_RECORD_CORRUPT",
        `${source} initialize action set must contain exactly one initialized action`,
      );
    }
    const action = actions[0]!;
    if (
      action.tenantId !== command.tenantId
      || action.requirementId !== command.deliverableId
      || action.actorPrincipalId !== command.principalId
      || action.occurredAtUtc !== occurredAtUtc
      || action.reason !== null
      || action.evidenceCount !== 0
      || action.evidenceIds.length !== 0
    ) {
      throw new ApplicationError(
        "DELIVERABLE_RECORD_CORRUPT",
        `${source} initialized action does not match the initialize command`,
      );
    }
    return action;
  };
  const authoritativeAction = assertInitializedAction(authoritativeActions, "Authoritative");
  const receiptAction = assertInitializedAction(receipt.actionHistory, "Receipt");

  const matchingEvents = initializationEvents.filter((event) => {
    const payload = typeof event.payload === "object" && event.payload !== null
      ? event.payload as Record<string, unknown>
      : null;
    return event.aggregateId === command.deliverableId
      || payload?.deliverableId === command.deliverableId;
  });
  if (matchingEvents.length !== 1) {
    throw new ApplicationError(
      "DELIVERABLE_RECORD_CORRUPT",
      "Initialize replay requires exactly one authoritative initialization event",
    );
  }
  const initializationEvent = matchingEvents[0]!;
  const expectedEventPayload = {
    deliverableId: command.deliverableId,
    projectId: command.projectId,
    nodeId: command.nodeId,
    requirementKey: command.requirementKey,
    minCount: command.minCount,
    reviewerPrincipalId: command.reviewerPrincipalId,
    required: command.required,
    ...(command.description?.trim() ? { description: command.description.trim() } : {}),
  };
  if (
    initializationEvent.tenantId !== command.tenantId
    || initializationEvent.projectId !== command.projectId
    || initializationEvent.aggregateType !== "deliverable"
    || initializationEvent.aggregateId !== command.deliverableId
    || initializationEvent.aggregateVersion !== 1
    || initializationEvent.eventType !== "project-map.deliverable.initialized"
    || initializationEvent.schemaVersion !== 1
    || initializationEvent.actorPrincipalId !== authoritativeAction.actorPrincipalId
    || initializationEvent.actorPrincipalId !== receiptAction.actorPrincipalId
    || initializationEvent.occurredAtUtc !== authoritativeAction.occurredAtUtc
    || initializationEvent.occurredAtUtc !== receiptAction.occurredAtUtc
    || initializationEvent.occurredAtUtc !== receiptCreatedAtUtc
    || stableJson(initializationEvent.payload) !== stableJson(expectedEventPayload)
  ) {
    throw new ApplicationError(
      "DELIVERABLE_RECORD_CORRUPT",
      "Initialization event drifted from its tenant, project, aggregate, command, action or receipt facts",
    );
  }
  const originalSecurityDomainId = initializationEvent.originalSecurityDomainId;
  const originalSecurityEpoch = initializationEvent.originalSecurityEpoch;
  if (
    (originalSecurityDomainId !== null
      && (typeof originalSecurityDomainId !== "string" || originalSecurityDomainId.trim().length === 0))
    || !Number.isSafeInteger(originalSecurityEpoch)
    || originalSecurityEpoch <= 0
    || requirement.securityDomainId !== originalSecurityDomainId
    || requirement.securityEpoch !== originalSecurityEpoch
    || nodeSecurityDomainId !== originalSecurityDomainId
    || nodeSecurityEpoch !== originalSecurityEpoch
  ) {
    throw new ApplicationError(
      "DELIVERABLE_RECORD_CORRUPT",
      "Initialized requirement and node no longer match the initialization event security facts",
    );
  }

  const expectedRequirement = {
    tenantId: command.tenantId,
    id: command.deliverableId,
    projectId: command.projectId,
    ownerNodeId: command.nodeId,
    securityDomainId: originalSecurityDomainId,
    securityEpoch: originalSecurityEpoch,
    requirementKey: command.requirementKey,
    title: command.title.trim(),
    description: command.description?.trim() || null,
    required: command.required,
    acceptedSourceTypes: [...command.acceptedSourceTypes],
    minCount: command.minCount,
    reviewerPrincipalId: command.reviewerPrincipalId,
    status: "pending",
    acceptedByPrincipalId: null,
    acceptedAtUtc: null,
    acceptedReason: null,
    waivedByPrincipalId: null,
    waivedAtUtc: null,
    waivedReason: null,
    version: 1,
    createdAtUtc: occurredAtUtc,
    updatedAtUtc: occurredAtUtc,
    deletedAtUtc: null,
  };
  if (stableJson(requirement) !== stableJson(expectedRequirement)) {
    throw new ApplicationError(
      "DELIVERABLE_RECORD_CORRUPT",
      "Initialized requirement no longer exactly matches the normalized initialize command and initialization event security facts",
    );
  }
}

export function assertEvidenceLinkTimestampsCanonical(links: readonly EvidenceLink[]): void {
  for (const link of links) {
    if (!isCanonicalUtcTimestamp(link.linkedAtUtc)) {
      throw new ApplicationError("DELIVERABLE_RECORD_CORRUPT", "Evidence link timestamp is not canonical");
    }
  }
}

export function injectDeliverableFailure(
  failurePoint: DeliverableFailurePoint | undefined,
  currentPoint: DeliverableFailurePoint,
): void {
  if (failurePoint === currentPoint) {
    throw new Error(`INJECTED_FAILURE:${currentPoint}`);
  }
}

export class InitializeDeliverableRequirementHandler {
  readonly #persistence: Persistence;

  constructor(persistence: Persistence) {
    this.#persistence = persistence;
  }

  async execute(
    command: InitializeDeliverableRequirementCommand,
  ): Promise<InitializeDeliverableRequirementResult> {
    this.#validate(command);
    const scope: CommandScope = {
      principalId: command.principalId,
      operation: "initialize_deliverable_requirement",
      idempotencyKey: command.idempotencyKey,
    };
    const fingerprint = hashInitializeDeliverablePayload({
      projectId: command.projectId,
      nodeId: command.nodeId,
      deliverableId: command.deliverableId,
      requirementKey: command.requirementKey,
      title: command.title.trim(),
      description: command.description?.trim() || null,
      required: command.required,
      acceptedSourceTypes: [...command.acceptedSourceTypes],
      minCount: command.minCount,
      reviewerPrincipalId: command.reviewerPrincipalId,
      occurredAtUtc: new Date(Date.parse(command.occurredAtUtc)).toISOString(),
    });

    return await this.#persistence.transaction(command.tenantId, async (transaction) => {
      const authorizationAtUtc = this.#persistence.nowUtc();
      const principal = await transaction.principals.get(command.principalId);
      if (principal?.status !== "active" || principal.kind !== "user") {
        throw new ApplicationError("NODE_NOT_FOUND", `Node not found: ${command.nodeId}`);
      }

      const node = await transaction.nodes.get(command.nodeId);
      if (node === undefined || node.deletedAtUtc !== null || node.projectId !== command.projectId) {
        throw new ApplicationError("NODE_NOT_FOUND", `Node not found: ${command.nodeId}`);
      }

      const membership = await transaction.memberships.get(command.projectId, command.principalId);
      if (membership?.status !== "active") {
        throw new ApplicationError("NODE_NOT_FOUND", `Node not found: ${command.nodeId}`);
      }

      const isManager = isProjectManager(membership);
      if (!isManager) {
        throw new ApplicationError(
          "PM_ROLE_REQUIRED",
          "Only project manager can initialize deliverable requirements",
        );
      }

      const allowed = await canAccessProjectObjectDuringMigration(
        transaction,
        membership,
        command.principalId,
        {
          projectId: node.projectId,
          ownerNodeId: node.id,
          securityDomainId: node.securityDomainId,
          securityEpoch: node.securityEpoch,
        },
        "edit",
        authorizationAtUtc,
      );
      if (!allowed) {
        throw new ApplicationError("NODE_NOT_FOUND", `Node not found: ${command.nodeId}`);
      }

      await assertProjectSecurityStable(transaction, command.projectId);

      const previous = await transaction.receipts.get<DeliverableRequirementView>(scope);
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint) {
          throw new ApplicationError(
            "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
            "The idempotency key was already used with a different payload",
          );
        }
        const authoritative = await transaction.deliverables.get(command.deliverableId);
        if (
          authoritative === undefined ||
          authoritative.requirementKey !== command.requirementKey ||
          authoritative.ownerNodeId !== command.nodeId ||
          authoritative.projectId !== command.projectId
        ) {
          throw new ApplicationError("DELIVERABLE_RECORD_CORRUPT", "Authoritative deliverable requirement drifted");
        }
        const authoritativeNode = await transaction.nodes.get(authoritative.ownerNodeId);
        if (
          authoritativeNode === undefined ||
          authoritativeNode.deletedAtUtc !== null ||
          authoritativeNode.projectId !== authoritative.projectId
        ) {
          throw new ApplicationError("DELIVERABLE_RECORD_CORRUPT", "Authoritative deliverable requirement no longer matches its node");
        }
        const replayReceiptLinks = await transaction.deliverables.listEvidenceLinks(authoritative.id);
        const replayReceiptActions = await transaction.deliverables.listActions(authoritative.id);
        const initializationEvents = await transaction.events.list(command.tenantId);
        const authoritativeView = toDeliverableRequirementView(authoritative, replayReceiptLinks, replayReceiptActions);
        if (authoritative.status !== "pending" || authoritative.version !== 1) {
          throw new ApplicationError(
            "DELIVERABLE_VERSION_CONFLICT",
            "Replayed initialize receipt is stale: authoritative requirement lifecycle advanced beyond the receipt",
          );
        }
        assertExactDeliverableReplayFacts(previous.result, authoritativeView, "initialized");
        assertExactInitializeReplayCommandFacts({
          requirement: authoritative,
          receipt: previous.result,
          authoritativeLinks: replayReceiptLinks,
          authoritativeActions: replayReceiptActions,
          initializationEvents,
          command,
          receiptCreatedAtUtc: previous.createdAtUtc,
          nodeSecurityDomainId: authoritativeNode.securityDomainId,
          nodeSecurityEpoch: authoritativeNode.securityEpoch,
        });
        const reviewerPrincipal = await transaction.principals.get(command.reviewerPrincipalId);
        if (reviewerPrincipal?.status !== "active" || reviewerPrincipal.kind !== "user") {
          throw new ApplicationError("REVIEWER_NOT_ELIGIBLE", "The assigned reviewer is no longer active");
        }
        const reviewerMembership = await transaction.memberships.get(command.projectId, command.reviewerPrincipalId);
        if (reviewerMembership?.status !== "active") {
          throw new ApplicationError("REVIEWER_NOT_ELIGIBLE", "The assigned reviewer is no longer an active member");
        }
        const reviewerAccess = await canAccessProjectObject(
          transaction,
          reviewerMembership,
          command.reviewerPrincipalId,
          node.projectId,
          node.securityDomainId,
          "view",
          authorizationAtUtc,
        );
        if (!reviewerAccess) {
          throw new ApplicationError("REVIEWER_NOT_ELIGIBLE", "The assigned reviewer cannot access the security domain");
        }
        return { value: structuredClone(previous.result), replayed: true };
      }

      if ((await transaction.deliverables.get(command.deliverableId)) !== undefined) {
        throw new ApplicationError("DELIVERABLE_ALREADY_EXISTS", `Deliverable already exists: ${command.deliverableId}`);
      }

      const existingByKey = await transaction.deliverables.getByKey(
        command.projectId,
        command.nodeId,
        command.requirementKey,
      );
      if (existingByKey !== undefined) {
        throw new ApplicationError(
          "DELIVERABLE_ALREADY_EXISTS",
          `Deliverable with key ${command.requirementKey} already exists on this node`,
        );
      }

      const reviewerPrincipal = await transaction.principals.get(command.reviewerPrincipalId);
      if (reviewerPrincipal?.status !== "active" || reviewerPrincipal.kind !== "user") {
        throw new ApplicationError("REVIEWER_NOT_ELIGIBLE", "The selected reviewer is not an active user");
      }
      const reviewerMembership = await transaction.memberships.get(command.projectId, command.reviewerPrincipalId);
      if (reviewerMembership?.status !== "active") {
        throw new ApplicationError("REVIEWER_NOT_ELIGIBLE", "The selected reviewer is not an active project member");
      }
      const reviewerEligible = await canAccessProjectObject(
        transaction,
        reviewerMembership,
        command.reviewerPrincipalId,
        node.projectId,
        node.securityDomainId,
        "view",
        authorizationAtUtc,
      );
      if (!reviewerEligible) {
        throw new ApplicationError("REVIEWER_NOT_ELIGIBLE", "The selected reviewer cannot access the security domain");
      }

      const requirement: DeliverableRequirement = {
        tenantId: command.tenantId,
        id: command.deliverableId,
        projectId: command.projectId,
        ownerNodeId: command.nodeId,
        securityDomainId: node.securityDomainId,
        securityEpoch: node.securityEpoch,
        requirementKey: command.requirementKey,
        title: command.title.trim(),
        description: command.description?.trim() || null,
        required: command.required,
        acceptedSourceTypes: command.acceptedSourceTypes,
        minCount: command.minCount,
        reviewerPrincipalId: command.reviewerPrincipalId,
        status: "pending",
        acceptedByPrincipalId: null,
        acceptedAtUtc: null,
        acceptedReason: null,
        waivedByPrincipalId: null,
        waivedAtUtc: null,
        waivedReason: null,
        version: 1,
        createdAtUtc: command.occurredAtUtc,
        updatedAtUtc: command.occurredAtUtc,
        deletedAtUtc: null,
      };

      assertCanonicalDeliverableRequirement(requirement, {
        tenantId: command.tenantId,
        projectId: command.projectId,
        ownerNodeId: command.nodeId,
        id: command.deliverableId,
      });

      await transaction.deliverables.insert(requirement);
      injectDeliverableFailure(command.failurePoint, "after_aggregate");

      const actionRecord: DeliverableActionRecord = {
        tenantId: command.tenantId,
        id: `act:${command.commandId}`,
        requirementId: requirement.id,
        action: "initialized",
        actorPrincipalId: command.principalId,
        occurredAtUtc: command.occurredAtUtc,
        reason: null,
        evidenceCount: 0,
        evidenceIds: [],
      };
      await transaction.deliverables.appendAction(actionRecord);
      injectDeliverableFailure(command.failurePoint, "after_action");

      const event = await this.#appendEvent(transaction, command, requirement);
      injectDeliverableFailure(command.failurePoint, "after_event");

      await transaction.outbox.enqueue(this.#outboxFor(event));
      injectDeliverableFailure(command.failurePoint, "after_outbox");

      const value = toDeliverableRequirementView(requirement, [], [actionRecord]);
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

  #validate(command: InitializeDeliverableRequirementCommand): void {
    for (const [name, value] of Object.entries({
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      correlationId: command.correlationId,
      principalId: command.principalId,
      projectId: command.projectId,
      nodeId: command.nodeId,
      deliverableId: command.deliverableId,
      requirementKey: command.requirementKey,
      title: command.title,
      reviewerPrincipalId: command.reviewerPrincipalId,
    })) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new ApplicationError("VALIDATION_FAILED", `${name} is required`);
      }
    }
    try {
      assertValidRequirementKey(command.requirementKey);
    } catch {
      throw new ApplicationError("VALIDATION_FAILED", `requirementKey is invalid: ${command.requirementKey}`);
    }
    if (!Number.isSafeInteger(command.minCount) || command.minCount <= 0) {
      throw new ApplicationError("VALIDATION_FAILED", "minCount must be a positive integer");
    }
    if (!Array.isArray(command.acceptedSourceTypes) || command.acceptedSourceTypes.length === 0) {
      throw new ApplicationError("VALIDATION_FAILED", "acceptedSourceTypes must be a non-empty array");
    }
    for (const st of command.acceptedSourceTypes) {
      if (st !== "file" && st !== "process_record") {
        throw new ApplicationError("VALIDATION_FAILED", `Invalid acceptedSourceType: ${st}`);
      }
    }
    if (typeof command.required !== "boolean") {
      throw new ApplicationError("VALIDATION_FAILED", "required must be a boolean");
    }
    if (!command.occurredAtUtc.endsWith("Z") || Number.isNaN(Date.parse(command.occurredAtUtc))) {
      throw new ApplicationError("VALIDATION_FAILED", "occurredAtUtc must be a valid UTC timestamp");
    }
  }

  async #appendEvent(
    transaction: TransactionContext,
    command: InitializeDeliverableRequirementCommand,
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
      eventType: "project-map.deliverable.initialized",
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
        requirementKey: requirement.requirementKey,
        minCount: requirement.minCount,
        reviewerPrincipalId: requirement.reviewerPrincipalId,
        required: requirement.required,
        ...(requirement.description ? { description: requirement.description } : {}),
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
