import type { Asset, AssetBinding } from "../../../domain/src/assets.ts";
import type { BackgroundJob, DomainEvent, OutboxMessage } from "../../../domain/src/events.ts";
import type { ExternalBinding, ExternalReference } from "../../../domain/src/external-reference.ts";
import type { PrincipalId, TenantId } from "../../../domain/src/identity.ts";
import type { ExternalIdentityMapping, Principal } from "../../../domain/src/identity.ts";
import type { IntegrationOperation, IntegrationStepAttempt } from "../../../domain/src/integration-operations.ts";
import type { ProjectNode } from "../../../domain/src/project-structure.ts";
import type { OutboundProjectionFence } from "../../../domain/src/outbound-projection-fence.ts";
import type { ProjectMembership, ProjectMembershipSecurityAuditEntry } from "../../../domain/src/project-access.ts";
import type { ProductTask, TaskReviewActionRecord } from "../../../domain/src/tasks.ts";
import type { SecurityDomainMigration, SecurityMigrationAuditEntry } from "../../../domain/src/security-migration.ts";
import type { SecurityDomain, SecurityGrant, SecurityGrantAuditEntry } from "../../../domain/src/security-access.ts";
import type {
  TemplateRoleSlot,
  ProjectRoleBinding,
  ProjectRoleSlotSnapshot,
  ProjectRoleSlotAuditEntry,
  RoleSlotsInitializedPayload,
} from "../../../domain/src/role-slots.ts";
import type {
  DeliverableRequirement,
  EvidenceLink,
  DeliverableActionRecord,
  EvidenceSourceType,
} from "../../../domain/src/deliverables.ts";

import type { SecurityMigrationReadinessEvidence } from "./integrations.ts";

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

export type AssignNodeLeaderCommand = Readonly<{
  tenantId: TenantId;
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  principalId: PrincipalId;
  projectId: string;
  nodeId: string;
  expectedVersion: number;
  leaderPrincipalId: PrincipalId | null;
  occurredAtUtc: string;
}>;

export type NodeLeaderAssignedPayload = Readonly<{
  nodeId: string;
  previousLeaderPrincipalId: PrincipalId | null;
  leaderPrincipalId: PrincipalId | null;
}>;

export type AssignNodeLeaderResult = Readonly<{
  node: ProjectNode;
  event: DomainEvent<NodeLeaderAssignedPayload>;
  outbox: OutboxMessage;
  replayed: boolean;
}>;

export type AssignNodeLeaderFailurePoint = "after_aggregate" | "after_event" | "after_outbox" | "after_idempotency";

export type TemplateRoleSlotInit = Readonly<{
  slotKey: string;
  name: string;
  description?: string | null | undefined;
}>;

export type InitializeProjectRoleSlotsCommand = Readonly<{
  tenantId: TenantId;
  commandId: string;
  idempotencyKey: string;
  correlationId?: string | null | undefined;
  principalId: PrincipalId;
  projectId: string;
  sourceTemplateVersionId: string;
  slots: readonly TemplateRoleSlotInit[];
  occurredAtUtc: string;
}>;

export type InitializeProjectRoleSlotsFailurePoint =
  | "after_state"
  | "after_audit"
  | "after_event"
  | "after_outbox"
  | "after_idempotency";

export type InitializeProjectRoleSlotsResult = Readonly<{
  snapshot: ProjectRoleSlotSnapshot;
  slots: readonly TemplateRoleSlot[];
  event: DomainEvent<RoleSlotsInitializedPayload>;
  outbox: OutboxMessage;
  audit: ProjectRoleSlotAuditEntry;
  replayed: boolean;
}>;


export type AssignProjectRoleBindingCommand = Readonly<{
  tenantId: TenantId;
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  principalId: PrincipalId;
  projectId: string;
  slotKey: string;
  principalIds: readonly PrincipalId[];
  expectedVersion: number;
  occurredAtUtc: string;
}>;

export type RoleBindingAssignedPayload = Readonly<{
  projectId: string;
  slotKey: string;
  principalIds: readonly PrincipalId[];
  version: number;
}>;

export type AssignProjectRoleBindingResult = Readonly<{
  binding: ProjectRoleBinding;
  event: DomainEvent<RoleBindingAssignedPayload>;
  outbox: OutboxMessage;
  replayed: boolean;
}>;

export type AssignProjectRoleBindingFailurePoint =
  | "after_aggregate"
  | "after_event"
  | "after_outbox"
  | "after_idempotency";

export type DeliverableRequirementView = Readonly<{
  id: string;
  projectId: string;
  nodeId: string;
  requirementKey: string;
  title: string;
  description: string | null;
  required: boolean;
  acceptedSourceTypes: readonly EvidenceSourceType[];
  minCount: number;
  reviewerPrincipalId: PrincipalId;
  status: DeliverableRequirement["status"];
  acceptedByPrincipalId: PrincipalId | null;
  acceptedAtUtc: string | null;
  acceptedReason: string | null;
  waivedByPrincipalId: PrincipalId | null;
  waivedAtUtc: string | null;
  waivedReason: string | null;
  version: number;
  evidenceLinks: readonly EvidenceLink[];
  actionHistory: readonly DeliverableActionRecord[];
}>;

export type DeliverableFailurePoint =
  | "after_aggregate"
  | "after_evidence"
  | "after_action"
  | "after_event"
  | "after_outbox"
  | "after_idempotency";

export type InitializeDeliverableRequirementCommand = Readonly<{
  tenantId: TenantId;
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  principalId: PrincipalId;
  projectId: string;
  nodeId: string;
  deliverableId: string;
  requirementKey: string;
  title: string;
  description?: string | null | undefined;
  required: boolean;
  acceptedSourceTypes: readonly EvidenceSourceType[];
  minCount: number;
  reviewerPrincipalId: PrincipalId;
  occurredAtUtc: string;
  failurePoint?: DeliverableFailurePoint | undefined;
}>;

export type InitializeDeliverableRequirementResult = Readonly<{
  value: DeliverableRequirementView;
  replayed: boolean;
}>;

export type SubmitDeliverableEvidenceCommand = Readonly<{
  tenantId: TenantId;
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  principalId: PrincipalId;
  deliverableId: string;
  expectedVersion: number;
  evidence: readonly { sourceType: EvidenceSourceType; sourceId: string }[];
  occurredAtUtc: string;
  failurePoint?: DeliverableFailurePoint | undefined;
}>;

export type SubmitDeliverableEvidenceResult = Readonly<{
  value: DeliverableRequirementView;
  replayed: boolean;
}>;

export type AcceptDeliverableCommand = Readonly<{
  tenantId: TenantId;
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  principalId: PrincipalId;
  deliverableId: string;
  expectedVersion: number;
  note?: string | null | undefined;
  occurredAtUtc: string;
  failurePoint?: DeliverableFailurePoint | undefined;
}>;

export type AcceptDeliverableResult = Readonly<{
  value: DeliverableRequirementView;
  replayed: boolean;
}>;

export type WaiveDeliverableCommand = Readonly<{
  tenantId: TenantId;
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  principalId: PrincipalId;
  deliverableId: string;
  expectedVersion: number;
  reason: string;
  occurredAtUtc: string;
  failurePoint?: DeliverableFailurePoint | undefined;
}>;

export type WaiveDeliverableResult = Readonly<{
  value: DeliverableRequirementView;
  replayed: boolean;
}>;

export type CreateNodeCommand = Readonly<{
  tenantId: TenantId;
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  principalId: PrincipalId;
  projectId: string;
  nodeId: string;
  parentId: string | null;
  leaderPrincipalId?: PrincipalId | null;
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
  leaderAssignedEvent?: DomainEvent<NodeLeaderAssignedPayload> | undefined;
  leaderAssignedOutbox?: OutboxMessage | undefined;
  replayed: boolean;
}>;

export type CreateNodeFailurePoint =
  | "after_aggregate"
  | "after_event"
  | "after_outbox"
  | "after_leader_assigned"
  | "after_leader_outbox"
  | "after_idempotency";

export interface ProjectNodeRepository {
  get(nodeId: string): Promise<ProjectNode | undefined>;
  listByProject(projectId: string): Promise<ProjectNode[]>;
  listForSecurityMigration(): Promise<ProjectNode[]>;
  hasSecurityDomainReference(securityDomainId: string): Promise<boolean>;
  insert(node: ProjectNode): Promise<void>;
  assignSecurityDomain(
    nodeId: string,
    projectId: string,
    securityDomainId: string,
    expectedVersion: number,
  ): Promise<ProjectNode>;
  migrateSecurityOwnership(migrationId: string, nodeId: string, expectedVersion: number): Promise<ProjectNode>;
  rollbackSecurityOwnership(migrationId: string, nodeId: string, expectedVersion: number): Promise<ProjectNode>;
}

export interface CommandReceiptRepository {
  get<TResult>(scope: CommandScope): Promise<CommandReceipt<TResult> | undefined>;
  insert<TResult>(receipt: CommandReceipt<TResult>): Promise<void>;
}

export interface TaskRepository {
  get(taskId: string): Promise<ProductTask | undefined>;
  listByNode(nodeId: string): Promise<ProductTask[]>;
  listForSecurityMigration(): Promise<ProductTask[]>;
  hasSecurityDomainReference(securityDomainId: string): Promise<boolean>;
  insert(task: ProductTask): Promise<void>;
  savePreservingSecurityOwnership(taskId: string, task: ProductTask, expectedVersion: number): Promise<void>;
  migrateSecurityOwnership(migrationId: string, taskId: string, expectedVersion: number): Promise<ProductTask>;
  rollbackSecurityOwnership(migrationId: string, taskId: string, expectedVersion: number): Promise<ProductTask>;
  appendReviewAction(action: TaskReviewActionRecord): Promise<void>;
  listReviewActions(taskId: string): Promise<TaskReviewActionRecord[]>;
}

export interface AssetRepository {
  get(assetId: string): Promise<Asset | undefined>;
  hasForNode(nodeId: string): Promise<boolean>;
  listForSecurityMigration(): Promise<Asset[]>;
  hasSecurityDomainReference(securityDomainId: string): Promise<boolean>;
  insert(asset: Asset): Promise<void>;
  savePreservingSecurityOwnership(assetId: string, asset: Asset, expectedVersion: number): Promise<void>;
  migrateSecurityOwnership(migrationId: string, assetId: string, expectedVersion: number): Promise<Asset>;
  rollbackSecurityOwnership(migrationId: string, assetId: string, expectedVersion: number): Promise<Asset>;
  insertBinding(binding: AssetBinding): Promise<void>;
  listBindings(targetType: AssetBinding["targetType"], targetId: string): Promise<AssetBinding[]>;
}

export interface DeliverableRepository {
  get(deliverableId: string): Promise<DeliverableRequirement | undefined>;
  getByKey(projectId: string, ownerNodeId: string, requirementKey: string): Promise<DeliverableRequirement | undefined>;
  listByNode(nodeId: string): Promise<DeliverableRequirement[]>;
  listByProject(projectId: string): Promise<DeliverableRequirement[]>;
  listForSecurityMigration(): Promise<DeliverableRequirement[]>;
  hasSecurityDomainReference(securityDomainId: string): Promise<boolean>;
  insert(requirement: DeliverableRequirement): Promise<void>;
  savePreservingSecurityOwnership(
    requirementId: string,
    requirement: DeliverableRequirement,
    expectedVersion: number,
  ): Promise<void>;
  migrateSecurityOwnership(
    migrationId: string,
    requirementId: string,
    expectedVersion: number,
  ): Promise<DeliverableRequirement>;
  rollbackSecurityOwnership(
    migrationId: string,
    requirementId: string,
    expectedVersion: number,
  ): Promise<DeliverableRequirement>;
  appendEvidenceLink(link: EvidenceLink): Promise<void>;
  listEvidenceLinks(requirementId: string): Promise<EvidenceLink[]>;
  appendAction(action: DeliverableActionRecord): Promise<void>;
  listActions(requirementId: string): Promise<DeliverableActionRecord[]>;
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

export interface OutboundProjectionFenceRepository {
  acquire(fence: OutboundProjectionFence): Promise<boolean>;
  renew(fenceId: string, token: string, expiresAtUtc: string): Promise<boolean>;
  release(fenceId: string, token: string): Promise<boolean>;
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
  restrictWithSecurityDomains(
    membership: ProjectMembership,
    expectedVersion: number,
    evaluatedAtUtc: string,
  ): Promise<SecurityDomain[]>;
}

export interface ProjectMembershipSecurityAuditRepository {
  append(entry: ProjectMembershipSecurityAuditEntry): Promise<void>;
  listByProject(projectId: string): Promise<ProjectMembershipSecurityAuditEntry[]>;
}

export interface SecurityDomainRepository {
  get(securityDomainId: string): Promise<SecurityDomain | undefined>;
  getByRoot(projectId: string, rootNodeId: string): Promise<SecurityDomain | undefined>;
  insert(securityDomain: SecurityDomain): Promise<void>;
}

export interface SecurityGrantRepository {
  get(securityDomainId: string, principalId: PrincipalId): Promise<SecurityGrant | undefined>;
  listByDomain(securityDomainId: string): Promise<SecurityGrant[]>;
  insert(grant: SecurityGrant): Promise<void>;
  saveWithDomainVersion(
    grant: SecurityGrant,
    expectedGrantVersion: number | null,
    securityDomain: SecurityDomain,
    expectedDomainVersion: number,
  ): Promise<void>;
}

export interface SecurityGrantAuditRepository {
  append(entry: SecurityGrantAuditEntry): Promise<void>;
  listByDomain(securityDomainId: string): Promise<SecurityGrantAuditEntry[]>;
}

export type SecurityMigrationManifestItem = Readonly<{
  kind: "node" | "task" | "asset" | "deliverable";
  id: string;
  ownerNodeId: string;
  version: number;
  securityDomainId: string | null;
  securityEpoch: number;
  externalReference?: ExternalReference | null | undefined;
  bindingVersion?: number | undefined;
  desiredVersion?: number | undefined;
  observedVersion?: number | null | undefined;
  syncState?: string | undefined;
  syncWatermark?: string | null | undefined;
  externalAttachmentReference?: ExternalReference | null | undefined;
  attachmentBindingVersion?: number | undefined;
  attachmentDesiredVersion?: number | undefined;
  attachmentObservedVersion?: number | null | undefined;
  attachmentSyncState?: string | undefined;
  attachmentSyncWatermark?: string | null | undefined;
  externalBlobReference?: ExternalReference | null | undefined;
  blobBindingVersion?: number | undefined;
  blobDesiredVersion?: number | undefined;
  blobObservedVersion?: number | null | undefined;
  blobSyncState?: string | undefined;
  blobSyncWatermark?: string | null | undefined;
  externalIssueId?: string | null | undefined;
}>;

export type SecurityMigrationManifestSnapshot = Readonly<{
  tenantId: TenantId;
  migrationId: string;
  projectId?: string | undefined;
  sourceSecurityDomainId?: string | null | undefined;
  targetSecurityDomainId?: string | null | undefined;
  sourceSecurityEpoch?: number | undefined;
  targetSecurityEpoch?: number | undefined;
  manifestDigest: string;
  itemCount: number;
  items: readonly SecurityMigrationManifestItem[];
  createdAtUtc: string;
}>;

export type SecurityMigrationReadinessEvidenceStatus = "issued" | "verified" | "consumed";

export type SecurityMigrationReadinessEvidenceRecord = Readonly<{
  tenantId: TenantId;
  evidenceId: string;
  nonce: string;
  migrationId: string;
  purpose: "commit" | "rollback";
  projectId: string;
  sourceSecurityDomainId: string | null;
  targetSecurityDomainId: string | null;
  sourceSecurityEpoch: number;
  targetSecurityEpoch: number;
  manifestDigest: string;
  itemCount: number;
  provider: string | null;
  status: SecurityMigrationReadinessEvidenceStatus;
  converged: boolean;
  issuedAtUtc: string;
  verifiedAtUtc: string | null;
  expiresAtUtc: string;
  consumedAtUtc: string | null;
  channels: Readonly<{
    issue: "converged" | "not_converged";
    attachment: "converged" | "not_converged";
    blob: "converged" | "not_converged";
  }> | null;
  reason?: string | null | undefined;
}>;

export type CommitWithReadinessEvidenceParams = Readonly<{
  migrationId: string;
  expectedVersion: number;
  evidenceId: string;
  actorPrincipalId: PrincipalId;
  occurredAtUtc: string;
  reason?: string | undefined;
  idempotencyKey?: string | undefined;
}>;

export type RollbackWithAuditParams = Readonly<{
  migrationId: string;
  expectedVersion: number;
  evidenceId?: string | undefined;
  actorPrincipalId: PrincipalId;
  reason: string;
  occurredAtUtc: string;
  idempotencyKey?: string | undefined;
}>;

export type CommitSecurityMigrationResult = Readonly<{
  migrationId: string;
  state: "committed";
  migrationVersion: number;
  occurredAtUtc?: string | undefined;
  replayed?: boolean | undefined;
}>;

export type RollbackSecurityMigrationResult = Readonly<{
  migrationId: string;
  state: "rolled_back" | "recovery_required";
  migrationVersion: number;
  rolledBackItems?: number | undefined;
  occurredAtUtc?: string | undefined;
  replayed?: boolean | undefined;
}>;

export interface SecurityDomainMigrationRepository {
  get(migrationId: string): Promise<SecurityDomainMigration | undefined>;
  insert(migration: SecurityDomainMigration): Promise<void>;
  saveProgressPreservingPlan(
    migrationId: string,
    migration: SecurityDomainMigration,
    expectedVersion: number,
  ): Promise<void>;
  saveManifestSnapshot(snapshot: SecurityMigrationManifestSnapshot): Promise<void>;
  getManifestSnapshot(migrationId: string): Promise<SecurityMigrationManifestSnapshot | undefined>;
  getReadinessEvidence(evidenceId: string): Promise<SecurityMigrationReadinessEvidenceRecord | undefined>;
  commitWithReadinessEvidence(
    params: CommitWithReadinessEvidenceParams,
  ): Promise<CommitSecurityMigrationResult>;
  rollbackWithAudit(
    params: RollbackWithAuditParams,
  ): Promise<RollbackSecurityMigrationResult>;
  listRecoverable(): Promise<SecurityDomainMigration[]>;
}

export interface SecurityMigrationAuditRepository {
  append(entry: SecurityMigrationAuditEntry): Promise<void>;
  listByMigration(migrationId: string): Promise<SecurityMigrationAuditEntry[]>;
}

export interface TemplateRoleSlotRepository {
  get(projectId: string, slotKey: string): Promise<TemplateRoleSlot | undefined>;
  listByProject(projectId: string): Promise<TemplateRoleSlot[]>;
  getSnapshot(projectId: string): Promise<ProjectRoleSlotSnapshot | undefined>;
}

export interface RoleSlotAuditRepository {
  append(entry: ProjectRoleSlotAuditEntry): Promise<void>;
  listByProject(projectId: string): Promise<ProjectRoleSlotAuditEntry[]>;
}

export interface ProjectRoleBindingRepository {
  get(projectId: string, slotKey: string): Promise<ProjectRoleBinding | undefined>;
  listByProject(projectId: string): Promise<ProjectRoleBinding[]>;
}

export interface ProjectSequenceRepository {
  next(projectId: string): Promise<number>;
  current(projectId: string): Promise<number>;
}

export interface DomainEventWriter {
  append(event: DomainEvent): Promise<void>;
  list(tenantId: TenantId): Promise<DomainEvent[]>;
}

export interface OutboxWriter {
  enqueue(message: OutboxMessage): Promise<void>;
  list(tenantId: TenantId): Promise<OutboxMessage[]>;
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
  deliverables: DeliverableRepository;
  externalBindings: ExternalBindingRepository;
  integrationOperations: IntegrationOperationRepository;
  outboundProjectionFences: OutboundProjectionFenceRepository;
  identities: IdentityMappingRepository;
  principals: PrincipalRepository;
  memberships: ProjectMembershipRepository;
  membershipSecurityAudits: ProjectMembershipSecurityAuditRepository;
  securityDomains: SecurityDomainRepository;
  securityGrants: SecurityGrantRepository;
  securityGrantAudits: SecurityGrantAuditRepository;
  securityMigrations: SecurityDomainMigrationRepository;
  securityMigrationAudits: SecurityMigrationAuditRepository;
  roleSlots: TemplateRoleSlotRepository;
  roleSlotAudits: RoleSlotAuditRepository;
  roleBindings: ProjectRoleBindingRepository;
  receipts: CommandReceiptRepository;
  sequences: ProjectSequenceRepository;
  events: DomainEventWriter;
  outbox: OutboxWriter;
  jobs: JobWriter;
}>;

export interface Persistence {
  nowUtc(): string;
  transaction<T>(tenantId: TenantId, work: (transaction: TransactionContext) => Promise<T>): Promise<T>;
  read<T>(tenantId: TenantId, work: (transaction: TransactionContext) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  executeCreateNode(
    command: CreateNodeCommand,
    failurePoint?: CreateNodeFailurePoint,
  ): Promise<CreateNodeResult>;
  executeAssignNodeLeader(
    command: AssignNodeLeaderCommand,
    failurePoint?: AssignNodeLeaderFailurePoint,
  ): Promise<AssignNodeLeaderResult>;
  executeInitializeProjectRoleSlots(
    command: InitializeProjectRoleSlotsCommand,
    failurePoint?: InitializeProjectRoleSlotsFailurePoint,
  ): Promise<InitializeProjectRoleSlotsResult>;

  executeAssignProjectRoleBinding(
    command: AssignProjectRoleBindingCommand,
    failurePoint?: AssignProjectRoleBindingFailurePoint,
  ): Promise<AssignProjectRoleBindingResult>;
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
  defer(
    tenantId: TenantId,
    jobId: string,
    leaseToken: string,
    availableAtUtc: string,
  ): Promise<boolean>;
  markDeadLetter(
    tenantId: TenantId,
    jobId: string,
    leaseToken: string,
    error: string,
  ): Promise<boolean>;
}
