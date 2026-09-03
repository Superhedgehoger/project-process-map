import { createHash } from "node:crypto";

export type ProjectNode = {
  id: string;
  projectId: string;
  title: string;
  kind: "stage" | "work_package" | "milestone";
  securityDomainId: string | null;
  version: number;
};

export type EventEnvelope<
  TAggregateType extends string,
  TEventType extends string,
  TBefore,
  TAfter,
> = {
  eventId: string;
  projectId: string;
  projectSequence: number;
  aggregateType: TAggregateType;
  aggregateId: string;
  aggregateVersion: number;
  eventType: TEventType;
  actorId: string;
  occurredAtUtc: string;
  correlationId: string;
  causationId: string;
  originalSecurityDomainId: string | null;
  before: TBefore;
  after: TAfter;
  schemaVersion: 1;
};

export type DomainEvent = EventEnvelope<
  "project_node",
  "project-map.node.created.v1",
  null,
  Readonly<ProjectNode>
>;

export type AnyDomainEvent = EventEnvelope<string, string, unknown, unknown>;

export type OutboxMessage<TEvent extends AnyDomainEvent = DomainEvent> = {
  id: string;
  eventId: string;
  topic: string;
  payload: Readonly<TEvent>;
  publishedAt?: string;
};

export type CreateNodeCommand = {
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  actorId: string;
  projectId: string;
  nodeId: string;
  title: string;
  kind?: ProjectNode["kind"];
  securityDomainId: string | null;
  occurredAtUtc: string;
};

export type CreateNodeResult = {
  node: ProjectNode;
  event: DomainEvent;
  outbox: OutboxMessage;
  replayed: boolean;
};

export type FailurePoint = "after_aggregate" | "after_event" | "after_outbox" | "after_idempotency";

type StoredCommand<TResult = unknown> = {
  fingerprint: string;
  result: TResult;
};

type StoreState = {
  aggregates: Map<string, Readonly<ProjectNode>>;
  events: AnyDomainEvent[];
  outbox: OutboxMessage<AnyDomainEvent>[];
  commands: Map<string, StoredCommand>;
  projectSequences: Map<string, number>;
  projections: Map<string, Map<string, unknown>>;
};

export type Transaction = {
  getAggregate(id: string): Readonly<ProjectNode> | undefined;
  putAggregate(id: string, value: Readonly<ProjectNode>): void;
  appendEvent(event: AnyDomainEvent): void;
  enqueue(message: OutboxMessage<AnyDomainEvent>): void;
  getCommand<TResult>(key: string): StoredCommand<TResult> | undefined;
  putCommand<TResult>(key: string, command: StoredCommand<TResult>): void;
  nextProjectSequence(projectId: string): number;
  getProjection<T>(namespace: string, id: string): Readonly<T> | undefined;
  putProjection<T>(namespace: string, id: string, value: Readonly<T>): void;
  setProjection<T>(namespace: string, id: string, value: Readonly<T>): void;
  deleteProjection(namespace: string, id: string): void;
};

function cloneState(state: StoreState): StoreState {
  return {
    aggregates: new Map(structuredClone([...state.aggregates])),
    events: structuredClone(state.events),
    outbox: structuredClone(state.outbox),
    commands: new Map(structuredClone([...state.commands])),
    projectSequences: new Map(state.projectSequences),
    projections: new Map(structuredClone([...state.projections])),
  };
}

export class InMemoryTransactionalStore {
  #state: StoreState = {
    aggregates: new Map(),
    events: [],
    outbox: [],
    commands: new Map(),
    projectSequences: new Map(),
    projections: new Map(),
  };

  transaction<T>(operation: (transaction: Transaction) => T): T {
    const draft = cloneState(this.#state);
    const transaction: Transaction = {
      getAggregate: (id) => {
        const aggregate = draft.aggregates.get(id);
        return aggregate ? structuredClone(aggregate) : undefined;
      },
      putAggregate: (id, value) => {
        if (draft.aggregates.has(id)) throw new Error(`Aggregate already exists: ${id}`);
        draft.aggregates.set(id, structuredClone(value));
      },
      appendEvent: (event) => {
        if (draft.events.some((item) => item.aggregateId === event.aggregateId && item.aggregateVersion === event.aggregateVersion)) {
          throw new Error(`Aggregate version already exists: ${event.aggregateId}@${event.aggregateVersion}`);
        }
        if (draft.events.some((item) => item.projectId === event.projectId && item.projectSequence === event.projectSequence)) {
          throw new Error(`Project sequence already exists: ${event.projectId}@${event.projectSequence}`);
        }
        draft.events.push(structuredClone(event));
      },
      enqueue: (message) => {
        if (draft.outbox.some((item) => item.id === message.id || item.eventId === message.eventId)) {
          throw new Error(`Outbox event already exists: ${message.eventId}`);
        }
        draft.outbox.push(structuredClone(message));
      },
      getCommand: (key) => {
        const command = draft.commands.get(key);
        return command ? structuredClone(command) as never : undefined;
      },
      putCommand: (key, command) => {
        if (draft.commands.has(key)) throw new Error(`Idempotency record already exists: ${key}`);
        draft.commands.set(key, structuredClone(command));
      },
      nextProjectSequence: (projectId) => {
        const next = (draft.projectSequences.get(projectId) ?? 0) + 1;
        draft.projectSequences.set(projectId, next);
        return next;
      },
      getProjection: <T>(namespace: string, id: string) => {
        const projection = draft.projections.get(namespace)?.get(id) as T | undefined;
        return projection === undefined ? undefined : structuredClone(projection);
      },
      putProjection: <T>(namespace: string, id: string, value: Readonly<T>) => {
        const projections = draft.projections.get(namespace) ?? new Map<string, unknown>();
        if (projections.has(id)) throw new Error(`Projection already exists: ${namespace}/${id}`);
        projections.set(id, structuredClone(value));
        draft.projections.set(namespace, projections);
      },
      setProjection: <T>(namespace: string, id: string, value: Readonly<T>) => {
        const projections = draft.projections.get(namespace) ?? new Map<string, unknown>();
        projections.set(id, structuredClone(value));
        draft.projections.set(namespace, projections);
      },
      deleteProjection: (namespace: string, id: string) => {
        draft.projections.get(namespace)?.delete(id);
      },
    };

    const result = operation(transaction);
    this.#state = draft;
    return result;
  }

  snapshot(): Readonly<StoreState> {
    return cloneState(this.#state);
  }

  getNode(id: string): Readonly<ProjectNode> | undefined {
    const node = this.#state.aggregates.get(id);
    return node === undefined ? undefined : structuredClone(node);
  }

  listNodes(): Readonly<ProjectNode>[] {
    return [...this.#state.aggregates.values()]
      .map((node) => structuredClone(node));
  }

  getProjection<T>(namespace: string, id: string): Readonly<T> | undefined {
    const projection = this.#state.projections.get(namespace)?.get(id) as T | undefined;
    return projection === undefined ? undefined : structuredClone(projection);
  }

  listProjections<T>(namespace: string): Readonly<T>[] {
    return [...(this.#state.projections.get(namespace)?.values() ?? [])]
      .map((projection) => structuredClone(projection as T));
  }
}

function required(name: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`${name} is required`);
}

function validateCommand(command: CreateNodeCommand): void {
  for (const [name, value] of [
    ["commandId", command.commandId],
    ["idempotencyKey", command.idempotencyKey],
    ["correlationId", command.correlationId],
    ["actorId", command.actorId],
    ["projectId", command.projectId],
    ["nodeId", command.nodeId],
    ["title", command.title],
  ] as const) required(name, value);

  if (!command.occurredAtUtc.endsWith("Z") || Number.isNaN(Date.parse(command.occurredAtUtc))) {
    throw new Error("occurredAtUtc must be a valid UTC timestamp");
  }
}

function commandKey(command: CreateNodeCommand): string {
  return `${command.actorId}\u0000create_node\u0000${command.idempotencyKey}`;
}

function commandFingerprint(command: CreateNodeCommand): string {
  return createHash("sha256").update(JSON.stringify({
    projectId: command.projectId,
    nodeId: command.nodeId,
    title: command.title,
    kind: command.kind ?? "work_package",
    securityDomainId: command.securityDomainId,
  })).digest("hex");
}

function injectFailure(expected: FailurePoint | undefined, actual: FailurePoint): void {
  if (expected === actual) throw new Error(`Injected failure: ${actual}`);
}

export function executeCreateNode(
  store: InMemoryTransactionalStore,
  command: CreateNodeCommand,
  failurePoint?: FailurePoint,
): CreateNodeResult {
  validateCommand(command);
  const idempotencyKey = commandKey(command);
  const fingerprint = commandFingerprint(command);

  return store.transaction((transaction) => {
    const previous = transaction.getCommand<Omit<CreateNodeResult, "replayed">>(idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
      return { ...structuredClone(previous.result), replayed: true };
    }

    if (transaction.getAggregate(command.nodeId)) throw new Error(`Aggregate already exists: ${command.nodeId}`);
    const projectSequence = transaction.nextProjectSequence(command.projectId);
    const node: ProjectNode = {
      id: command.nodeId,
      projectId: command.projectId,
      title: command.title,
      kind: command.kind ?? "work_package",
      securityDomainId: command.securityDomainId,
      version: 1,
    };
    transaction.putAggregate(node.id, node);
    injectFailure(failurePoint, "after_aggregate");

    const event: DomainEvent = {
      eventId: `evt:${command.commandId}`,
      projectId: command.projectId,
      projectSequence,
      aggregateType: "project_node",
      aggregateId: node.id,
      aggregateVersion: node.version,
      eventType: "project-map.node.created.v1",
      actorId: command.actorId,
      occurredAtUtc: command.occurredAtUtc,
      correlationId: command.correlationId,
      causationId: command.commandId,
      originalSecurityDomainId: command.securityDomainId,
      before: null,
      after: node,
      schemaVersion: 1,
    };
    transaction.appendEvent(event);
    injectFailure(failurePoint, "after_event");

    const outbox: OutboxMessage = {
      id: `outbox:${event.eventId}`,
      eventId: event.eventId,
      topic: event.eventType,
      payload: event,
    };
    transaction.enqueue(outbox);
    injectFailure(failurePoint, "after_outbox");

    const result = { node, event, outbox };
    transaction.putCommand(idempotencyKey, { fingerprint, result });
    injectFailure(failurePoint, "after_idempotency");
    return { ...structuredClone(result), replayed: false };
  });
}
