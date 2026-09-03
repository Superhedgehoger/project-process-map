import { createHash } from "node:crypto";
import { eventTopic, type DomainEvent, type OutboxMessage } from "../../domain/src/events.ts";
import type { PrincipalId, TenantId } from "../../domain/src/identity.ts";
import type { ProjectNode } from "../../domain/src/project-structure.ts";
import type { CommandScope, Persistence } from "./ports/persistence.ts";

export type CreateNodeCommand = Readonly<{
  tenantId: TenantId;
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  principalId: PrincipalId;
  projectId: string;
  nodeId: string;
  parentId: string | null;
  title: string;
  kind?: ProjectNode["kind"];
  securityDomainId: string | null;
  occurredAtUtc: string;
}>;

export type NodeCreatedPayload = Readonly<{
  nodeId: string;
  parentId: string | null;
  title: string;
  kind: ProjectNode["kind"];
}>;

export type CreateNodeResult = Readonly<{
  node: ProjectNode;
  event: DomainEvent<NodeCreatedPayload>;
  outbox: OutboxMessage;
  replayed: boolean;
}>;

export type CreateNodeFailurePoint = "after_aggregate" | "after_event" | "after_outbox" | "after_idempotency";

export async function executeCreateNode(
  persistence: Persistence,
  command: CreateNodeCommand,
  failurePoint?: CreateNodeFailurePoint,
): Promise<CreateNodeResult> {
  validate(command);
  const scope: CommandScope = {
    principalId: command.principalId,
    operation: "create_node",
    idempotencyKey: command.idempotencyKey,
  };
  const fingerprint = hash({
    projectId: command.projectId,
    nodeId: command.nodeId,
    parentId: command.parentId,
    title: command.title,
    kind: command.kind ?? "work_package",
    securityDomainId: command.securityDomainId,
  });

  return await persistence.transaction(command.tenantId, async (transaction) => {
    const previous = await transaction.receipts.get<Omit<CreateNodeResult, "replayed">>(scope);
    if (previous !== undefined) {
      if (previous.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
      return { ...structuredClone(previous.result), replayed: true };
    }
    if (await transaction.nodes.get(command.nodeId) !== undefined) throw new Error(`Aggregate already exists: ${command.nodeId}`);
    if (command.parentId !== null) {
      const parent = await transaction.nodes.get(command.parentId);
      if (parent === undefined || parent.projectId !== command.projectId) throw new Error("PARENT_NODE_NOT_FOUND");
    }
    const projectSequence = await transaction.sequences.next(command.projectId);
    const node: ProjectNode = {
      tenantId: command.tenantId,
      id: command.nodeId,
      projectId: command.projectId,
      parentId: command.parentId,
      title: command.title,
      kind: command.kind ?? "work_package",
      securityDomainId: command.securityDomainId,
      securityEpoch: 1,
      version: 1,
      deletedAtUtc: null,
    };
    await transaction.nodes.insert(node);
    inject(failurePoint, "after_aggregate");
    const event: DomainEvent<NodeCreatedPayload> = {
      tenantId: command.tenantId,
      eventId: `evt:${command.commandId}`,
      projectId: command.projectId,
      projectSequence,
      aggregateType: "project_node",
      aggregateId: node.id,
      aggregateVersion: node.version,
      eventType: "project-map.node.created",
      schemaVersion: 1,
      actorPrincipalId: command.principalId,
      occurredAtUtc: command.occurredAtUtc,
      correlationId: command.correlationId,
      causationId: command.commandId,
      originalSecurityDomainId: command.securityDomainId,
      originalSecurityEpoch: node.securityEpoch,
      payload: { nodeId: node.id, parentId: node.parentId, title: node.title, kind: node.kind },
    };
    await transaction.events.append(event);
    inject(failurePoint, "after_event");
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
    inject(failurePoint, "after_outbox");
    const result = { node, event, outbox };
    await transaction.receipts.insert({ scope, fingerprint, result, createdAtUtc: command.occurredAtUtc });
    inject(failurePoint, "after_idempotency");
    return { ...result, replayed: false };
  });
}

function validate(command: CreateNodeCommand): void {
  for (const [name, value] of Object.entries({
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId,
    principalId: command.principalId,
    projectId: command.projectId,
    nodeId: command.nodeId,
    title: command.title,
  })) if (String(value).trim().length === 0) throw new Error(`${name} is required`);
  if (!command.occurredAtUtc.endsWith("Z") || Number.isNaN(Date.parse(command.occurredAtUtc))) {
    throw new Error("occurredAtUtc must be a valid UTC timestamp");
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function inject(expected: CreateNodeFailurePoint | undefined, actual: CreateNodeFailurePoint): void {
  if (expected === actual) throw new Error(`Injected failure: ${actual}`);
}

