import type { BackgroundJob, DomainEvent, OutboxMessage } from "../../../domain/src/events.ts";
import type { PrincipalId, TenantId } from "../../../domain/src/identity.ts";
import type { ProjectNode } from "../../../domain/src/project-structure.ts";

export type CommandScope = Readonly<{
  principalId: PrincipalId;
  operation: string;
  idempotencyKey: string;
}>;

export type CommandReceipt<TResult = unknown> = Readonly<{
  scope: CommandScope;
  fingerprint: string;
  result: TResult;
  createdAtUtc: string;
}>;

export interface ProjectNodeRepository {
  get(nodeId: string): Promise<ProjectNode | undefined>;
  listByProject(projectId: string): Promise<ProjectNode[]>;
  insert(node: ProjectNode): Promise<void>;
}

export interface CommandReceiptRepository {
  get<TResult>(scope: CommandScope): Promise<CommandReceipt<TResult> | undefined>;
  insert<TResult>(receipt: CommandReceipt<TResult>): Promise<void>;
}

export interface ProjectSequenceRepository {
  next(projectId: string): Promise<number>;
  current(projectId: string): Promise<number>;
}

export interface DomainEventWriter {
  append(event: DomainEvent): Promise<void>;
}

export interface OutboxWriter {
  enqueue(message: OutboxMessage): Promise<void>;
}

export interface JobWriter {
  schedule(job: BackgroundJob): Promise<void>;
}

export type TransactionContext = Readonly<{
  tenantId: TenantId;
  nodes: ProjectNodeRepository;
  receipts: CommandReceiptRepository;
  sequences: ProjectSequenceRepository;
  events: DomainEventWriter;
  outbox: OutboxWriter;
  jobs: JobWriter;
}>;

export interface Persistence {
  transaction<T>(tenantId: TenantId, work: (transaction: TransactionContext) => Promise<T>): Promise<T>;
  read<T>(tenantId: TenantId, work: (transaction: TransactionContext) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type ClaimOptions = Readonly<{
  workerId: string;
  nowUtc: string;
  leaseUntilUtc: string;
  limit: number;
}>;

export interface OutboxConsumer {
  countReady(nowUtc: string): Promise<number>;
  claim(options: ClaimOptions): Promise<OutboxMessage[]>;
  markPublished(tenantId: TenantId, messageId: string, leaseToken: string, publishedAtUtc: string): Promise<boolean>;
  release(
    tenantId: TenantId,
    messageId: string,
    leaseToken: string,
    nextAttemptAtUtc: string,
    error: string,
  ): Promise<"retry" | "dead_letter" | "lease_lost">;
}

export interface JobConsumer {
  countReady(nowUtc: string): Promise<number>;
  claim(options: ClaimOptions): Promise<BackgroundJob[]>;
  markCompleted(tenantId: TenantId, jobId: string, leaseToken: string, completedAtUtc: string): Promise<boolean>;
  release(
    tenantId: TenantId,
    jobId: string,
    leaseToken: string,
    nextAttemptAtUtc: string,
    error: string,
  ): Promise<"retry" | "dead_letter" | "lease_lost">;
}

