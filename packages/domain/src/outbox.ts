export type DomainEvent = {
  id: string;
  aggregateId: string;
  type: string;
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
};

export type OutboxMessage = {
  id: string;
  eventId: string;
  topic: string;
  payload: Readonly<Record<string, unknown>>;
  publishedAt?: string;
};

type StoreState = {
  aggregates: Map<string, Readonly<Record<string, unknown>>>;
  events: DomainEvent[];
  outbox: OutboxMessage[];
};

export type Transaction = {
  putAggregate(id: string, value: Readonly<Record<string, unknown>>): void;
  appendEvent(event: DomainEvent): void;
  enqueue(message: OutboxMessage): void;
};

export class InMemoryTransactionalStore {
  #state: StoreState = { aggregates: new Map(), events: [], outbox: [] };

  transaction<T>(operation: (transaction: Transaction) => T): T {
    const draft: StoreState = {
      aggregates: new Map(this.#state.aggregates),
      events: structuredClone(this.#state.events),
      outbox: structuredClone(this.#state.outbox),
    };
    const transaction: Transaction = {
      putAggregate: (id, value) => draft.aggregates.set(id, structuredClone(value)),
      appendEvent: (event) => draft.events.push(structuredClone(event)),
      enqueue: (message) => draft.outbox.push(structuredClone(message)),
    };

    const result = operation(transaction);
    this.#state = draft;
    return result;
  }

  snapshot(): Readonly<StoreState> {
    return {
      aggregates: new Map(this.#state.aggregates),
      events: structuredClone(this.#state.events),
      outbox: structuredClone(this.#state.outbox),
    };
  }
}

export function recordNodeCreated(
  store: InMemoryTransactionalStore,
  input: { nodeId: string; projectId: string; title: string },
  failAfterEvent = false,
): void {
  const eventId = `evt:${input.nodeId}:created`;
  store.transaction((transaction) => {
    transaction.putAggregate(input.nodeId, input);
    transaction.appendEvent({
      id: eventId,
      aggregateId: input.nodeId,
      type: "project-map.node.created.v1",
      occurredAt: new Date().toISOString(),
      payload: input,
    });
    if (failAfterEvent) throw new Error("Injected transaction failure");
    transaction.enqueue({
      id: `outbox:${eventId}`,
      eventId,
      topic: "project-map.node.created.v1",
      payload: input,
    });
  });
}
