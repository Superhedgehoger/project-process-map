import type { Asset, AssetBinding } from "../../../domain/src/assets.ts";
import type { BackgroundJob, DomainEvent, OutboxMessage } from "../../../domain/src/events.ts";
import type { ExternalBinding } from "../../../domain/src/external-reference.ts";
import type { PrincipalId, TenantId } from "../../../domain/src/identity.ts";
import type { ExternalIdentityMapping, Principal } from "../../../domain/src/identity.ts";
import type { IntegrationOperation, IntegrationStepAttempt } from "../../../domain/src/integration-operations.ts";
import type { ProjectNode } from "../../../domain/src/project-structure.ts";
import type { ProjectMembership } from "../../../domain/src/project-access.ts";
import type { ProductTask, TaskReviewActionRecord } from "../../../domain/src/tasks.ts";
import type { SecurityDomainMigration } from "../../../domain/src/security-migration.ts";

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

export interface TaskRepository {
  get(taskId: string): Promise<ProductTask | undefined>;
  listByNode(nodeId: string): Promise<ProductTask[]>;
  insert(task: ProductTask): Promise<void>;
  update(task: ProductTask, expectedVersion: number): Promise<void>;
  appendReviewAction(action: TaskReviewActionRecord): Promise<void>;
  listReviewActions(taskId: string): Promise<TaskReviewActionRecord[]>;
}

export interface AssetRepository {
  get(assetId: string): Promise<Asset | undefined>;
  insert(asset: Asset): Promise<void>;
  update(asset: Asset, expectedVersion: number): Promise<void>;
  insertBinding(binding: AssetBinding): Promise<void>;
  listBindings(targetType: AssetBinding["targetType"], targetId: string): Promise<AssetBinding[]>;
}

export interface ExternalBindingRepository {
  getByOwner(ownerType: ExternalBinding["ownerType"], ownerId: string, role: ExternalBinding["role"]): Promise<ExternalBinding | undefined>;
  insert(binding: ExternalBinding): Promise<void>;
  update(binding: ExternalBinding, expectedVersion: number): Promise<void>;
}

export interface IntegrationOperationRepository {
  get(operationId: string): Promise<IntegrationOperation | undefined>;
  insert(operation: IntegrationOperation): Promise<void>;
  update(operation: IntegrationOperation, expectedVersion: number): Promise<void>;
  appendStep(attempt: IntegrationStepAttempt): Promise<void>;
  listSteps(operationId: string): Promise<IntegrationStepAttempt[]>;
  listRecoverable(): Promise<IntegrationOperation[]>;
}

export interface IdentityMappingRepository {
  findExternal(
    provider: string,
    connectionId: string,
    externalTenantRef: string,
    externalSubjectRef: string,
  ): Promise<ExternalIdentityMapping | undefined>;
  insertExternal(mapping: ExternalIdentityMapping): Promise<void>;
  updateExternal(mapping: ExternalIdentityMapping, expectedVersion: number): Promise<void>;
}

export interface PrincipalRepository {
  get(principalId: PrincipalId): Promise<Principal | undefined>;
  insert(principal: Principal): Promise<void>;
  update(principal: Principal, expectedVersion: number): Promise<void>;
}

export interface ProjectMembershipRepository {
  get(projectId: string, principalId: PrincipalId): Promise<ProjectMembership | undefined>;
  insert(membership: ProjectMembership): Promise<void>;
  update(membership: ProjectMembership, expectedVersion: number): Promise<void>;
}

export interface SecurityDomainMigrationRepository {
  get(migrationId: string): Promise<SecurityDomainMigration | undefined>;
  insert(migration: SecurityDomainMigration): Promise<void>;
  update(migration: SecurityDomainMigration, expectedVersion: number): Promise<void>;
  listRecoverable(): Promise<SecurityDomainMigration[]>;
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
  rescheduleDeadLetter(jobId: string, availableAtUtc: string): Promise<boolean>;
}

export type TransactionContext = Readonly<{
  tenantId: TenantId;
  nodes: ProjectNodeRepository;
  tasks: TaskRepository;
  assets: AssetRepository;
  externalBindings: ExternalBindingRepository;
  integrationOperations: IntegrationOperationRepository;
  identities: IdentityMappingRepository;
  principals: PrincipalRepository;
  memberships: ProjectMembershipRepository;
  securityMigrations: SecurityDomainMigrationRepository;
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
  markDeadLetter(
    tenantId: TenantId,
    jobId: string,
    leaseToken: string,
    error: string,
  ): Promise<boolean>;
}
