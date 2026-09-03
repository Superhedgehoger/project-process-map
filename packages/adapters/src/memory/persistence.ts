import { randomUUID } from "node:crypto";
import type { BackgroundJob, DomainEvent, OutboxMessage } from "../../../domain/src/events.ts";
import type { TenantId } from "../../../domain/src/identity.ts";
import type { ProjectNode } from "../../../domain/src/project-structure.ts";
import type {
  ClaimOptions,
  CommandReceipt,
  CommandScope,
  JobConsumer,
  OutboxConsumer,
  Persistence,
  TransactionContext,
} from "../../../application/src/ports/persistence.ts";

type MemoryState = {
  nodes: Map<string, ProjectNode>;
  receipts: Map<string, CommandReceipt>;
  sequences: Map<string, number>;
  events: Map<string, DomainEvent>;
  aggregateVersions: Set<string>;
  projectEventSequences: Set<string>;
  outbox: Map<string, OutboxMessage>;
  jobs: Map<string, BackgroundJob>;
  jobDedupe: Map<string, string>;
};

function emptyState(): MemoryState {
  return {
    nodes: new Map(),
    receipts: new Map(),
    sequences: new Map(),
    events: new Map(),
    aggregateVersions: new Set(),
    projectEventSequences: new Set(),
    outbox: new Map(),
    jobs: new Map(),
    jobDedupe: new Map(),
  };
}

function cloneState(state: MemoryState): MemoryState {
  return {
    nodes: new Map(structuredClone([...state.nodes])),
    receipts: new Map(structuredClone([...state.receipts])),
    sequences: new Map(state.sequences),
    events: new Map(structuredClone([...state.events])),
    aggregateVersions: new Set(state.aggregateVersions),
    projectEventSequences: new Set(state.projectEventSequences),
    outbox: new Map(structuredClone([...state.outbox])),
    jobs: new Map(structuredClone([...state.jobs])),
    jobDedupe: new Map(state.jobDedupe),
  };
}

export type MemoryPersistenceSnapshot = Readonly<MemoryState>;

export class MemoryPersistence implements Persistence {
  #state = emptyState();
  #tail: Promise<void> = Promise.resolve();

  readonly outboxConsumer: OutboxConsumer = {
    countReady: async (nowUtc) => {
      await this.#tail;
      return [...this.#state.outbox.values()].filter((message) => ready(message, nowUtc)).length;
    },
    claim: async (options) => {
      validateClaim(options);
      return await this.exclusive(async () => claimFrom(this.#state.outbox, options));
    },
    markPublished: async (tenantId, messageId, leaseToken, publishedAtUtc) => await this.exclusive(
      async () => complete(this.#state.outbox, tenantId, messageId, leaseToken, publishedAtUtc, "publishedAtUtc", "published"),
    ),
    release: async (tenantId, id, leaseToken, nextAttemptAtUtc, error) => await this.exclusive(
      async () => release(this.#state.outbox, tenantId, id, leaseToken, nextAttemptAtUtc, error),
    ),
  };

  readonly jobConsumer: JobConsumer = {
    countReady: async (nowUtc) => {
      await this.#tail;
      return [...this.#state.jobs.values()].filter((job) => ready(job, nowUtc)).length;
    },
    claim: async (options) => {
      validateClaim(options);
      return await this.exclusive(async () => claimFrom(this.#state.jobs, options));
    },
    markCompleted: async (tenantId, jobId, leaseToken, completedAtUtc) => await this.exclusive(
      async () => complete(this.#state.jobs, tenantId, jobId, leaseToken, completedAtUtc, "completedAtUtc", "completed"),
    ),
    release: async (tenantId, id, leaseToken, nextAttemptAtUtc, error) => await this.exclusive(
      async () => release(this.#state.jobs, tenantId, id, leaseToken, nextAttemptAtUtc, error),
    ),
  };

  async transaction<T>(tenantId: TenantId, work: (transaction: TransactionContext) => Promise<T>): Promise<T> {
    return await this.exclusive(async () => {
      const draft = cloneState(this.#state);
      const result = await work(context(draft, tenantId));
      this.#state = draft;
      return result;
    });
  }

  async read<T>(tenantId: TenantId, work: (transaction: TransactionContext) => Promise<T>): Promise<T> {
    await this.#tail;
    return await work(context(cloneState(this.#state), tenantId));
  }

  async close(): Promise<void> {
    await this.#tail;
  }

  snapshot(): MemoryPersistenceSnapshot {
    return cloneState(this.#state);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let unlock = (): void => {};
    this.#tail = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
    }
  }
}

function context(state: MemoryState, tenantId: TenantId): TransactionContext {
  const tenantPrefix = `${tenantId}\u0000`;
  return {
    tenantId,
    nodes: {
      get: async (nodeId) => clone(state.nodes.get(`${tenantPrefix}${nodeId}`)),
      listByProject: async (projectId) => [...state.nodes.values()]
        .filter((node) => node.tenantId === tenantId && node.projectId === projectId)
        .map((node) => structuredClone(node)),
      insert: async (node) => {
        if (node.tenantId !== tenantId) throw new Error("TENANT_CONTEXT_MISMATCH");
        const key = `${tenantPrefix}${node.id}`;
        if (state.nodes.has(key)) throw new Error(`Aggregate already exists: ${node.id}`);
        state.nodes.set(key, structuredClone(node));
      },
    },
    receipts: {
      get: async <T>(scope: CommandScope) => clone(state.receipts.get(receiptKey(tenantId, scope))) as CommandReceipt<T> | undefined,
      insert: async (receipt) => {
        const key = receiptKey(tenantId, receipt.scope);
        if (state.receipts.has(key)) throw new Error("IDEMPOTENCY_RECORD_ALREADY_EXISTS");
        state.receipts.set(key, structuredClone(receipt));
      },
    },
    sequences: {
      next: async (projectId) => {
        const key = `${tenantPrefix}${projectId}`;
        const next = (state.sequences.get(key) ?? 0) + 1;
        state.sequences.set(key, next);
        return next;
      },
      current: async (projectId) => state.sequences.get(`${tenantPrefix}${projectId}`) ?? 0,
    },
    events: {
      append: async (event) => {
        assertTenant(tenantId, event.tenantId);
        const eventKey = `${tenantPrefix}${event.eventId}`;
        const aggregateKey = `${tenantPrefix}${event.aggregateType}\u0000${event.aggregateId}\u0000${event.aggregateVersion}`;
        const sequenceKey = `${tenantPrefix}${event.projectId}\u0000${event.projectSequence}`;
        if (state.events.has(eventKey)) throw new Error("EVENT_ALREADY_EXISTS");
        if (state.aggregateVersions.has(aggregateKey)) throw new Error("AGGREGATE_VERSION_ALREADY_EXISTS");
        if (state.projectEventSequences.has(sequenceKey)) throw new Error("PROJECT_SEQUENCE_ALREADY_EXISTS");
        state.events.set(eventKey, structuredClone(event));
        state.aggregateVersions.add(aggregateKey);
        state.projectEventSequences.add(sequenceKey);
      },
    },
    outbox: {
      enqueue: async (message) => {
        assertTenant(tenantId, message.tenantId);
        const key = `${tenantPrefix}${message.id}`;
        if (state.outbox.has(key) || [...state.outbox.values()].some((item) => item.tenantId === tenantId && item.eventId === message.eventId)) {
          throw new Error("OUTBOX_EVENT_ALREADY_EXISTS");
        }
        state.outbox.set(key, structuredClone(message));
      },
    },
    jobs: {
      schedule: async (job) => {
        assertTenant(tenantId, job.tenantId);
        const key = `${tenantPrefix}${job.id}`;
        if (state.jobs.has(key)) throw new Error("JOB_ALREADY_EXISTS");
        if (job.dedupeKey !== null) {
          const dedupe = `${tenantPrefix}${job.jobType}\u0000${job.dedupeKey}`;
          if (state.jobDedupe.has(dedupe)) throw new Error("JOB_DEDUPE_KEY_ALREADY_EXISTS");
          state.jobDedupe.set(dedupe, key);
        }
        state.jobs.set(key, structuredClone(job));
      },
    },
  };
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function receiptKey(tenantId: TenantId, scope: CommandScope): string {
  return `${tenantId}\u0000${scope.principalId}\u0000${scope.operation}\u0000${scope.idempotencyKey}`;
}

function assertTenant(expected: TenantId, actual: TenantId): void {
  if (actual !== expected) throw new Error("TENANT_CONTEXT_MISMATCH");
}

function validateClaim(options: ClaimOptions): void {
  if (options.workerId.trim().length === 0 || options.limit <= 0 || !Number.isInteger(options.limit)) throw new Error("INVALID_CLAIM_OPTIONS");
  if (Date.parse(options.leaseUntilUtc) <= Date.parse(options.nowUtc)) throw new Error("INVALID_LEASE_DEADLINE");
}

function ready(item: OutboxMessage | BackgroundJob, nowUtc: string): boolean {
  return (item.state === "pending" && item.availableAtUtc <= nowUtc)
    || (item.state === "leased" && item.leaseExpiresAtUtc !== null && item.leaseExpiresAtUtc <= nowUtc);
}

function claimFrom<T extends OutboxMessage | BackgroundJob>(store: Map<string, T>, options: ClaimOptions): T[] {
  const claimed: T[] = [];
  const candidates = [...store.entries()]
    .filter(([, item]) => ready(item, options.nowUtc))
    .sort(([, left], [, right]) => left.availableAtUtc.localeCompare(right.availableAtUtc))
    .slice(0, options.limit);
  for (const [key, item] of candidates) {
    const updated = {
      ...item,
      state: "leased" as const,
      attempts: item.attempts + 1,
      leaseOwner: options.workerId,
      leaseToken: randomUUID(),
      leaseExpiresAtUtc: options.leaseUntilUtc,
    } as T;
    store.set(key, updated);
    claimed.push(structuredClone(updated));
  }
  return claimed;
}

function complete<T extends OutboxMessage | BackgroundJob>(
  store: Map<string, T>,
  tenantId: TenantId,
  id: string,
  leaseToken: string,
  atUtc: string,
  completionField: "publishedAtUtc" | "completedAtUtc",
  completedState: "published" | "completed",
): boolean {
  const key = `${tenantId}\u0000${id}`;
  const item = store.get(key);
  if (item === undefined || item.state !== "leased" || item.leaseToken !== leaseToken) return false;
  const updated = {
    ...item,
    state: completedState,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAtUtc: null,
    [completionField]: atUtc,
  } as T;
  store.set(key, updated);
  return true;
}

function release<T extends OutboxMessage | BackgroundJob>(
  store: Map<string, T>,
  tenantId: TenantId,
  id: string,
  leaseToken: string,
  nextAttemptAtUtc: string,
  error: string,
): "retry" | "dead_letter" | "lease_lost" {
  const key = `${tenantId}\u0000${id}`;
  const item = store.get(key);
  if (item === undefined || item.state !== "leased" || item.leaseToken !== leaseToken) return "lease_lost";
  const dead = item.attempts >= item.maxAttempts;
  store.set(key, {
    ...item,
    state: dead ? "dead_letter" : "pending",
    availableAtUtc: nextAttemptAtUtc,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAtUtc: null,
    lastError: error,
  } as T);
  return dead ? "dead_letter" : "retry";
}
