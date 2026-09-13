import { createHash, randomUUID } from "node:crypto";
import type { Asset, AssetBinding } from "../../../domain/src/assets.ts";
import { eventTopic, type BackgroundJob, type DomainEvent, type OutboxMessage } from "../../../domain/src/events.ts";
import type { ExternalBinding } from "../../../domain/src/external-reference.ts";
import type { TenantId, PrincipalId } from "../../../domain/src/identity.ts";
import type { ExternalIdentityMapping, Principal } from "../../../domain/src/identity.ts";
import type { IntegrationOperation, IntegrationStepAttempt } from "../../../domain/src/integration-operations.ts";
import type { ProjectNode } from "../../../domain/src/project-structure.ts";
import type { OutboundProjectionFence } from "../../../domain/src/outbound-projection-fence.ts";
import { isProjectManager, type ProjectMembership, type ProjectMembershipSecurityAuditEntry } from "../../../domain/src/project-access.ts";
import type { ProductTask, TaskReviewActionRecord } from "../../../domain/src/tasks.ts";
import {
  assertSecurityMigrationInitialPlan,
  assertSecurityMigrationProgressChange,
  transitionSecurityMigration,
  type SecurityDomainMigration,
  type SecurityMigrationAuditEntry,
} from "../../../domain/src/security-migration.ts";
import { grantAllows, isCanonicalUtcTimestamp, isPermanentSecurityAdministrator, type SecurityDomain, type SecurityGrant, type SecurityGrantAuditEntry } from "../../../domain/src/security-access.ts";
import {
  type ClaimOptions,
  type CommandReceipt,
  type CommandScope,
  type CommitSecurityMigrationResult,
  type CommitWithReadinessEvidenceParams,
  type JobConsumer,
  type OutboxConsumer,
  type Persistence,
  type RollbackSecurityMigrationResult,
  type RollbackWithAuditParams,
  type SecurityMigrationAuditRepository,
  type SecurityMigrationManifestItem,
  type SecurityMigrationManifestSnapshot,
  type SecurityMigrationReadinessEvidenceRecord,
  type TransactionContext,
} from "../../../application/src/ports/persistence.ts";
import {
  createVerificationOperation,
  type InternalIssueChallengeParams,
  type InternalRecordVerifiedEvidenceParams,
  type TestReadinessHarness,
} from "../security-migration-coordinator.ts";
import type { VerifyMigrationReadiness } from "../../../application/src/security/security-migration-coordinator.ts";
import type { ExternalCollaborationEpochReadinessPort } from "../../../application/src/ports/integrations.ts";
import { canAccessProjectObjectDuringMigration } from "../../../application/src/access/project-security.ts";
import {
  assertManifestMatchesSnapshot,
  collectSecurityMigrationManifest,
  computeSecurityMigrationManifestDigest,
  validateCanonicalSnapshotItems,
  type SecurityMigrationManifestInput,
} from "../../../application/src/security/security-migration-manifest.ts";
import { buildResumableSecurityMigrationInventory } from "../../../application/src/security/build-security-migration-inventory.ts";

type MemoryState = {
  nodes: Map<string, ProjectNode>;
  tasks: Map<string, ProductTask>;
  reviewActions: Map<string, TaskReviewActionRecord>;
  assets: Map<string, Asset>;
  assetBindings: Map<string, AssetBinding>;
  externalBindings: Map<string, ExternalBinding>;
  operations: Map<string, IntegrationOperation>;
  outboundProjectionFences: Map<string, OutboundProjectionFence>;
  operationSteps: Map<string, IntegrationStepAttempt>;
  identityMappings: Map<string, ExternalIdentityMapping>;
  principals: Map<string, Principal>;
  memberships: Map<string, ProjectMembership>;
  membershipSecurityAudits: Map<string, ProjectMembershipSecurityAuditEntry>;
  securityDomains: Map<string, SecurityDomain>;
  securityGrants: Map<string, SecurityGrant>;
  securityGrantAudits: Map<string, SecurityGrantAuditEntry>;
  securityMigrations: Map<string, SecurityDomainMigration>;
  securityMigrationAudits: Map<string, SecurityMigrationAuditEntry>;
  manifestSnapshots: Map<string, SecurityMigrationManifestSnapshot>;
  readinessEvidence: Map<string, SecurityMigrationReadinessEvidenceRecord>;
  consumedReadinessEvidence: Map<string, { evidenceId: string; nonce: string; migrationId: string; manifestDigest: string; consumedAtUtc: string }>;
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
    tasks: new Map(),
    reviewActions: new Map(),
    assets: new Map(),
    assetBindings: new Map(),
    externalBindings: new Map(),
    operations: new Map(),
    outboundProjectionFences: new Map(),
    operationSteps: new Map(),
    identityMappings: new Map(),
    principals: new Map(),
    memberships: new Map(),
    membershipSecurityAudits: new Map(),
    securityDomains: new Map(),
    securityGrants: new Map(),
    securityGrantAudits: new Map(),
    securityMigrations: new Map(),
    securityMigrationAudits: new Map(),
    manifestSnapshots: new Map(),
    readinessEvidence: new Map(),
    consumedReadinessEvidence: new Map(),
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
    tasks: new Map(structuredClone([...state.tasks])),
    reviewActions: new Map(structuredClone([...state.reviewActions])),
    assets: new Map(structuredClone([...state.assets])),
    assetBindings: new Map(structuredClone([...state.assetBindings])),
    externalBindings: new Map(structuredClone([...state.externalBindings])),
    operations: new Map(structuredClone([...state.operations])),
    outboundProjectionFences: new Map(structuredClone([...state.outboundProjectionFences])),
    operationSteps: new Map(structuredClone([...state.operationSteps])),
    identityMappings: new Map(structuredClone([...state.identityMappings])),
    principals: new Map(structuredClone([...state.principals])),
    memberships: new Map(structuredClone([...state.memberships])),
    membershipSecurityAudits: new Map(structuredClone([...state.membershipSecurityAudits])),
    securityDomains: new Map(structuredClone([...state.securityDomains])),
    securityGrants: new Map(structuredClone([...state.securityGrants])),
    securityGrantAudits: new Map(structuredClone([...state.securityGrantAudits])),
    securityMigrations: new Map(structuredClone([...state.securityMigrations])),
    securityMigrationAudits: new Map(structuredClone([...state.securityMigrationAudits])),
    manifestSnapshots: new Map(structuredClone([...state.manifestSnapshots])),
    readinessEvidence: new Map(structuredClone([...state.readinessEvidence])),
    consumedReadinessEvidence: new Map(structuredClone([...state.consumedReadinessEvidence])),
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

export type MemoryPersistenceOptions = Readonly<{
  now?: (() => Date) | undefined;
  verifier?: ExternalCollaborationEpochReadinessPort | undefined;
  attachTestHarness?: ((harness: TestReadinessHarness) => void) | undefined;
}>;

export class MemoryPersistence implements Persistence {
  #state = emptyState();
  #tail: Promise<void> = Promise.resolve();
  readonly #now: () => Date;
  readonly #verifyMigrationReadiness?: VerifyMigrationReadiness | undefined;

  constructor(options?: MemoryPersistenceOptions) {
    this.#now = options?.now ?? (() => new Date());
    if (options?.verifier !== undefined) {
      this.#verifyMigrationReadiness = createVerificationOperation({
        persistence: this,
        verifier: options.verifier,
        issueChallenge: async (tenantId, params) => await this.#issueReadinessChallenge(tenantId, params),
        recordVerifiedEvidence: async (tenantId, params) => await this.#recordVerifiedEvidence(tenantId, params),
        nowUtc: () => this.nowUtc(),
      });
    }
    if (options?.attachTestHarness !== undefined) {
      options.attachTestHarness({
        issueChallenge: async (tenantId, params) => await this.#issueReadinessChallenge(tenantId, params),
        recordVerifiedEvidence: async (tenantId, params) => await this.#recordVerifiedEvidence(tenantId, params),
        createVerificationOperation: (verifier) => createVerificationOperation({
          persistence: this,
          verifier,
          issueChallenge: async (tenantId, params) => await this.#issueReadinessChallenge(tenantId, params),
          recordVerifiedEvidence: async (tenantId, params) => await this.#recordVerifiedEvidence(tenantId, params),
          nowUtc: () => this.nowUtc(),
        }),
      });
    }
  }

  get verifyMigrationReadiness(): VerifyMigrationReadiness | undefined {
    return this.#verifyMigrationReadiness;
  }

  nowUtc(): string {
    return this.#now().toISOString();
  }

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
    defer: async (tenantId, id, leaseToken, availableAtUtc) => await this.exclusive(
      async () => deferJob(this.#state.jobs, tenantId, id, leaseToken, availableAtUtc),
    ),
    markDeadLetter: async (tenantId, id, leaseToken, error) => await this.exclusive(
      async () => deadLetter(this.#state.jobs, tenantId, id, leaseToken, error),
    ),
  };

  async transaction<T>(tenantId: TenantId, work: (transaction: TransactionContext) => Promise<T>): Promise<T> {
    return await this.exclusive(async () => {
      const draft = cloneState(this.#state);
      const result = await work(context(draft, tenantId, () => this.nowUtc()));
      this.#state = draft;
      return result;
    });
  }

  async read<T>(tenantId: TenantId, work: (transaction: TransactionContext) => Promise<T>): Promise<T> {
    await this.#tail;
    return await work(context(cloneState(this.#state), tenantId, () => this.nowUtc()));
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

  async #issueReadinessChallenge(
    tenantId: TenantId,
    params: InternalIssueChallengeParams,
  ): Promise<SecurityMigrationReadinessEvidenceRecord> {
    return await this.exclusive(async () => {
      const tenantPrefix = `${tenantId}\u0000`;
      const key = `${tenantPrefix}${params.migrationId}`;
      const migration = this.#state.securityMigrations.get(key);
      if (migration === undefined) throw new Error("SECURITY_MIGRATION_NOT_FOUND");
      if (params.purpose !== "commit" && params.purpose !== "rollback") {
        throw new Error("VALIDATION_FAILED");
      }
      if (params.purpose === "commit" && migration.state !== "verifying") {
        throw new Error("SECURITY_MIGRATION_COMMIT_INVALID");
      }
      if (params.purpose === "rollback" && !["planned", "active", "verifying", "retryable", "recovery_required"].includes(migration.state)) {
        throw new Error("SECURITY_MIGRATION_ROLLBACK_INVALID");
      }
      const snapshotKey = `${tenantPrefix}${params.migrationId}`;
      const snapshot = this.#state.manifestSnapshots.get(snapshotKey);
      if (snapshot === undefined) {
        throw new Error("SECURITY_MIGRATION_MANIFEST_SNAPSHOT_NOT_FOUND");
      }

      const evidenceId = randomUUID();
      const nonce = randomUUID();
      const issuedAtUtc = this.nowUtc();
      const expiresAtUtc = new Date(Date.parse(issuedAtUtc) + (params.ttlMilliseconds ?? 60_000)).toISOString();

      const targetSecurityDomainId = params.purpose === "rollback" ? migration.sourceSecurityDomainId : migration.targetSecurityDomainId;
      const targetSecurityEpoch = params.purpose === "rollback" ? migration.sourceSecurityEpoch : migration.targetSecurityEpoch;
      const sourceSecurityDomainId = params.purpose === "rollback" ? migration.targetSecurityDomainId : migration.sourceSecurityDomainId;
      const sourceSecurityEpoch = params.purpose === "rollback" ? migration.targetSecurityEpoch : migration.sourceSecurityEpoch;

      const record: SecurityMigrationReadinessEvidenceRecord = {
        tenantId,
        evidenceId,
        nonce,
        migrationId: migration.id,
        purpose: params.purpose,
        projectId: migration.projectId,
        sourceSecurityDomainId,
        targetSecurityDomainId,
        sourceSecurityEpoch,
        targetSecurityEpoch,
        manifestDigest: snapshot.manifestDigest,
        itemCount: snapshot.items.length,
        provider: null,
        status: "issued",
        converged: false,
        issuedAtUtc,
        verifiedAtUtc: null,
        expiresAtUtc,
        consumedAtUtc: null,
        channels: null,
        reason: null,
      };

      this.#state.readinessEvidence.set(`${tenantPrefix}${evidenceId}`, structuredClone(record));
      return record;
    });
  }

  async #recordVerifiedEvidence(
    tenantId: TenantId,
    params: InternalRecordVerifiedEvidenceParams,
  ): Promise<SecurityMigrationReadinessEvidenceRecord> {
    return await this.exclusive(async () => {
      const tenantPrefix = `${tenantId}\u0000`;
      const evidenceKey = `${tenantPrefix}${params.evidenceId}`;
      const existing = this.#state.readinessEvidence.get(evidenceKey);
      if (existing === undefined) throw new Error("SECURITY_MIGRATION_EVIDENCE_NOT_FOUND");
      if (existing.status !== "issued") {
        throw new Error("SECURITY_MIGRATION_EVIDENCE_ALREADY_VERIFIED");
      }
      const currentNowUtc = this.nowUtc();
      if (currentNowUtc > existing.expiresAtUtc) {
        throw new Error("SECURITY_MIGRATION_EVIDENCE_EXPIRED");
      }
      if (params.provider !== "huly") {
        throw new Error("SECURITY_MIGRATION_EVIDENCE_INVALID");
      }
      if (
        params.evidenceId !== existing.evidenceId
        || params.nonce !== existing.nonce
        || params.tenantId !== existing.tenantId
        || params.projectId !== existing.projectId
        || params.migrationId !== existing.migrationId
        || params.purpose !== existing.purpose
        || params.sourceSecurityDomainId !== existing.sourceSecurityDomainId
        || params.targetSecurityDomainId !== existing.targetSecurityDomainId
        || params.sourceSecurityEpoch !== existing.sourceSecurityEpoch
        || params.targetSecurityEpoch !== existing.targetSecurityEpoch
        || params.manifestDigest !== existing.manifestDigest
        || params.itemCount !== existing.itemCount
        || params.issuedAtUtc !== existing.issuedAtUtc
        || params.expiresAtUtc !== existing.expiresAtUtc
      ) {
        throw new Error("SECURITY_MIGRATION_EVIDENCE_INVALID");
      }

      const updated: SecurityMigrationReadinessEvidenceRecord = {
        ...existing,
        status: "verified",
        provider: params.provider,
        converged: params.converged,
        channels: params.channels,
        verifiedAtUtc: currentNowUtc,
        reason: params.reason ?? null,
      };

      this.#state.readinessEvidence.set(evidenceKey, structuredClone(updated));
      return updated;
    });
  }
}

function context(
  state: MemoryState,
  tenantId: TenantId,
  nowUtc: () => string = () => new Date().toISOString(),
): TransactionContext {
  const tenantPrefix = `${tenantId}\u0000`;
  const migrationForObjectWrite = (migrationId: string): SecurityDomainMigration => {
    const migration = state.securityMigrations.get(`${tenantPrefix}${migrationId}`);
    if (migration === undefined || migration.state !== "active"
      || migration.sourceSecurityEpoch <= 0 || migration.targetSecurityEpoch <= 0
      || (migration.sourceSecurityDomainId === migration.targetSecurityDomainId
        && migration.sourceSecurityEpoch === migration.targetSecurityEpoch)) {
      throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
    }
    return migration;
  };
  const migrationForObjectRollback = (migrationId: string): SecurityDomainMigration => {
    const migration = state.securityMigrations.get(`${tenantPrefix}${migrationId}`);
    if (migration === undefined || !["planned", "active", "verifying", "retryable", "recovery_required"].includes(migration.state)
      || migration.sourceSecurityEpoch <= 0 || migration.targetSecurityEpoch <= 0
      || (migration.sourceSecurityDomainId === migration.targetSecurityDomainId
        && migration.sourceSecurityEpoch === migration.targetSecurityEpoch)) {
      throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
    }
    return migration;
  };
  const assertMigrationScope = (migration: SecurityDomainMigration, ownerNodeId: string): void => {
    const visited = new Set<string>();
    let currentId: string | null = ownerNodeId;
    while (currentId !== null) {
      if (visited.has(currentId)) throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
      visited.add(currentId);
      const current = state.nodes.get(`${tenantPrefix}${currentId}`);
      if (current === undefined || current.projectId !== migration.projectId) {
        throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
      }
      if (current.id === migration.rootNodeId) return;
      currentId = current.parentId;
    }
    throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
  };
  const collectSubtreeDepths = (projectId: string, rootNodeId: string): Map<string, number> => {
    const nodes = [...state.nodes.values()].filter((n) => n.tenantId === tenantId && n.projectId === projectId && n.deletedAtUtc === null);
    const byParent = new Map<string | null, string[]>();
    for (const node of nodes) {
      const list = byParent.get(node.parentId) ?? [];
      list.push(node.id);
      byParent.set(node.parentId, list);
    }
    const depths = new Map<string, number>();
    depths.set(rootNodeId, 0);
    const queue = [rootNodeId];
    while (queue.length > 0) {
      const next = queue.shift()!;
      const currentDepth = depths.get(next) ?? 0;
      for (const child of byParent.get(next) ?? []) {
        if (!depths.has(child)) {
          depths.set(child, currentDepth + 1);
          queue.push(child);
        }
      }
    }
    return depths;
  };
  const assertActorAuthorizedForMigration = async (
    migration: SecurityDomainMigration,
    actorPrincipalId: PrincipalId,
    timestampUtc: string,
  ): Promise<void> => {
    const principal = await context.principals.get(actorPrincipalId);
    if (principal?.status !== "active") {
      throw new Error("NODE_NOT_FOUND");
    }
    const membership = await context.memberships.get(migration.projectId, actorPrincipalId);
    if (membership?.status !== "active" || !isProjectManager(membership)) {
      throw new Error("NODE_NOT_FOUND");
    }
    const rootNode = await context.nodes.get(migration.rootNodeId);
    if (rootNode === undefined || rootNode.projectId !== migration.projectId || rootNode.deletedAtUtc !== null) {
      throw new Error("NODE_NOT_FOUND");
    }
    const authorized = await canAccessProjectObjectDuringMigration(
      context,
      membership,
      actorPrincipalId,
      {
        projectId: migration.projectId,
        ownerNodeId: rootNode.id,
        securityDomainId: rootNode.securityDomainId,
        securityEpoch: rootNode.securityEpoch,
      },
      "manage_access",
      timestampUtc,
    );
    if (!authorized) {
      throw new Error("NODE_NOT_FOUND");
    }
  };
  const context: TransactionContext = {
    tenantId,
    nodes: {
      get: async (nodeId) => clone(state.nodes.get(`${tenantPrefix}${nodeId}`)),
      listByProject: async (projectId) => [...state.nodes.values()]
        .filter((node) => node.tenantId === tenantId && node.projectId === projectId)
        .map((node) => structuredClone(node)),
      listForSecurityMigration: async () => [...state.nodes.values()]
        .filter((node) => node.tenantId === tenantId)
        .map((node) => structuredClone(node)),
      hasSecurityDomainReference: async (securityDomainId) => [...state.nodes.values()].some(
        (node) => node.tenantId === tenantId && node.securityDomainId === securityDomainId,
      ),
      insert: async (node) => {
        if (node.tenantId !== tenantId) throw new Error("TENANT_CONTEXT_MISMATCH");
        const key = `${tenantPrefix}${node.id}`;
        if (state.nodes.has(key)) throw new Error(`Aggregate already exists: ${node.id}`);
        state.nodes.set(key, structuredClone(node));
      },
      assignSecurityDomain: async (nodeId, projectId, securityDomainId, expectedVersion) => {
        const key = `${tenantPrefix}${nodeId}`;
        const current = state.nodes.get(key);
        if (current === undefined) throw new Error("NODE_NOT_FOUND");
        if (current.projectId !== projectId) throw new Error("PROJECT_MISMATCH");
        if (current.securityDomainId !== null) throw new Error("NODE_ALREADY_SENSITIVE");
        if (current.version !== expectedVersion) throw new Error("NODE_VERSION_CONFLICT");
        const domain = state.securityDomains.get(`${tenantPrefix}${securityDomainId}`);
        if (domain?.projectId !== projectId || domain.rootNodeId !== nodeId) throw new Error("SECURITY_DOMAIN_ROOT_MISMATCH");
        const firstAdministrator = state.securityGrants.get(securityGrantKey(
          tenantId,
          securityDomainId,
          domain.createdByPrincipalId,
        ));
        if (firstAdministrator?.status !== "active"
          || firstAdministrator.capability !== "manage_access"
          || firstAdministrator.expiresAtUtc !== null) {
          throw new Error("SECURITY_DOMAIN_FIRST_ADMIN_REQUIRED");
        }
        const updated = {
          ...current,
          securityDomainId,
          securityEpoch: current.securityEpoch + 1,
          version: current.version + 1,
        };
        state.nodes.set(key, structuredClone(updated));
        return structuredClone(updated);
      },
      migrateSecurityOwnership: async (migrationId, nodeId, expectedVersion) => {
        const migration = migrationForObjectWrite(migrationId);
        const key = `${tenantPrefix}${nodeId}`;
        const current = state.nodes.get(key);
        if (current === undefined) throw new Error("NODE_NOT_FOUND");
        if (current.version !== expectedVersion) throw new Error("NODE_VERSION_CONFLICT");
        assertMigrationScope(migration, current.id);
        if (current.securityDomainId !== migration.sourceSecurityDomainId
          || current.securityEpoch !== migration.sourceSecurityEpoch) {
          throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
        }
        const updated = { ...current, securityDomainId: migration.targetSecurityDomainId,
          securityEpoch: migration.targetSecurityEpoch, version: current.version + 1 };
        state.nodes.set(key, structuredClone(updated));
        return structuredClone(updated);
      },
      rollbackSecurityOwnership: async (migrationId, nodeId, expectedVersion) => {
        const migration = migrationForObjectRollback(migrationId);
        const key = `${tenantPrefix}${nodeId}`;
        const current = state.nodes.get(key);
        if (current === undefined) throw new Error("NODE_NOT_FOUND");
        if (current.version !== expectedVersion) throw new Error("NODE_VERSION_CONFLICT");
        assertMigrationScope(migration, current.id);
        if (current.securityDomainId !== migration.targetSecurityDomainId
          || current.securityEpoch !== migration.targetSecurityEpoch) {
          throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
        }
        const updated = { ...current, securityDomainId: migration.sourceSecurityDomainId,
          securityEpoch: migration.sourceSecurityEpoch, version: current.version + 1 };
        state.nodes.set(key, structuredClone(updated));
        return structuredClone(updated);
      },
    },
    tasks: {
      get: async (taskId) => clone(state.tasks.get(`${tenantPrefix}${taskId}`)),
      listByNode: async (nodeId) => [...state.tasks.values()]
        .filter((task) => task.tenantId === tenantId && task.ownerNodeId === nodeId)
        .map((task) => structuredClone(task)),
      listForSecurityMigration: async () => [...state.tasks.values()]
        .filter((task) => task.tenantId === tenantId)
        .map((task) => structuredClone(task)),
      hasSecurityDomainReference: async (securityDomainId) => [...state.tasks.values()].some(
        (task) => task.tenantId === tenantId && task.securityDomainId === securityDomainId,
      ),
      insert: async (task) => {
        assertTenant(tenantId, task.tenantId);
        const key = `${tenantPrefix}${task.id}`;
        if (state.tasks.has(key)) throw new Error("TASK_ALREADY_EXISTS");
        state.tasks.set(key, structuredClone(task));
      },
      savePreservingSecurityOwnership: async (taskId, task, expectedVersion) => {
        const key = `${tenantPrefix}${taskId}`;
        const existing = state.tasks.get(key);
        if (existing === undefined) throw new Error("TASK_NOT_FOUND");
        if (existing.version !== expectedVersion || task.version !== expectedVersion + 1) throw new Error("TASK_VERSION_CONFLICT");
        if (task.tenantId !== tenantId || task.id !== taskId
          || task.projectId !== existing.projectId || task.ownerNodeId !== existing.ownerNodeId
          || task.securityDomainId !== existing.securityDomainId || task.securityEpoch !== existing.securityEpoch) {
          throw new Error("TASK_SECURITY_OWNERSHIP_IMMUTABLE");
        }
        state.tasks.set(key, structuredClone(task));
      },
      migrateSecurityOwnership: async (migrationId, taskId, expectedVersion) => {
        const migration = migrationForObjectWrite(migrationId);
        const key = `${tenantPrefix}${taskId}`;
        const current = state.tasks.get(key);
        if (current === undefined) throw new Error("TASK_NOT_FOUND");
        if (current.version !== expectedVersion) throw new Error("TASK_VERSION_CONFLICT");
        assertMigrationScope(migration, current.ownerNodeId);
        if (current.projectId !== migration.projectId || current.securityDomainId !== migration.sourceSecurityDomainId
          || current.securityEpoch !== migration.sourceSecurityEpoch) {
          throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
        }
        const updated = { ...current, securityDomainId: migration.targetSecurityDomainId,
          securityEpoch: migration.targetSecurityEpoch, version: current.version + 1 };
        state.tasks.set(key, structuredClone(updated));
        return structuredClone(updated);
      },
      rollbackSecurityOwnership: async (migrationId, taskId, expectedVersion) => {
        const migration = migrationForObjectRollback(migrationId);
        const key = `${tenantPrefix}${taskId}`;
        const current = state.tasks.get(key);
        if (current === undefined) throw new Error("TASK_NOT_FOUND");
        if (current.version !== expectedVersion) throw new Error("TASK_VERSION_CONFLICT");
        assertMigrationScope(migration, current.ownerNodeId);
        if (current.projectId !== migration.projectId || current.securityDomainId !== migration.targetSecurityDomainId
          || current.securityEpoch !== migration.targetSecurityEpoch) {
          throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
        }
        const updated = { ...current, securityDomainId: migration.sourceSecurityDomainId,
          securityEpoch: migration.sourceSecurityEpoch, version: current.version + 1 };
        state.tasks.set(key, structuredClone(updated));
        return structuredClone(updated);
      },
      appendReviewAction: async (action) => {
        assertTenant(tenantId, action.tenantId);
        const key = `${tenantPrefix}${action.taskId}\u0000${action.cycleNumber}\u0000${action.action}`;
        if (state.reviewActions.has(key)) throw new Error("TASK_REVIEW_ACTION_ALREADY_EXISTS");
        state.reviewActions.set(key, structuredClone(action));
      },
      listReviewActions: async (taskId) => [...state.reviewActions.values()]
        .filter((action) => action.tenantId === tenantId && action.taskId === taskId)
        .sort((left, right) => left.cycleNumber - right.cycleNumber || reviewActionOrder(left.action) - reviewActionOrder(right.action))
        .map((action) => structuredClone(action)),
    },
    assets: {
      get: async (assetId) => clone(state.assets.get(`${tenantPrefix}${assetId}`)),
      hasForNode: async (nodeId) => [...state.assets.values()].some(
        (asset) => asset.tenantId === tenantId && asset.ownerNodeId === nodeId,
      ),
      listForSecurityMigration: async () => [...state.assets.values()]
        .filter((asset) => asset.tenantId === tenantId)
        .map((asset) => structuredClone(asset)),
      hasSecurityDomainReference: async (securityDomainId) => [...state.assets.values()].some(
        (asset) => asset.tenantId === tenantId && asset.securityDomainId === securityDomainId,
      ),
      insert: async (asset) => {
        assertTenant(tenantId, asset.tenantId);
        const key = `${tenantPrefix}${asset.id}`;
        if (state.assets.has(key)) throw new Error("ASSET_ALREADY_EXISTS");
        state.assets.set(key, structuredClone(asset));
      },
      savePreservingSecurityOwnership: async (assetId, asset, expectedVersion) => {
        const key = `${tenantPrefix}${assetId}`;
        const existing = state.assets.get(key);
        if (existing === undefined) throw new Error("ASSET_NOT_FOUND");
        if (existing.version !== expectedVersion || asset.version !== expectedVersion + 1) throw new Error("ASSET_VERSION_CONFLICT");
        if (asset.tenantId !== tenantId || asset.id !== assetId
          || asset.projectId !== existing.projectId || asset.ownerNodeId !== existing.ownerNodeId
          || asset.securityDomainId !== existing.securityDomainId || asset.securityEpoch !== existing.securityEpoch
          || asset.uploaderPrincipalId !== existing.uploaderPrincipalId) {
          throw new Error("ASSET_SECURITY_OWNERSHIP_IMMUTABLE");
        }
        state.assets.set(key, structuredClone(asset));
      },
      migrateSecurityOwnership: async (migrationId, assetId, expectedVersion) => {
        const migration = migrationForObjectWrite(migrationId);
        const key = `${tenantPrefix}${assetId}`;
        const current = state.assets.get(key);
        if (current === undefined) throw new Error("ASSET_NOT_FOUND");
        if (current.version !== expectedVersion) throw new Error("ASSET_VERSION_CONFLICT");
        assertMigrationScope(migration, current.ownerNodeId);
        if (current.projectId !== migration.projectId || current.securityDomainId !== migration.sourceSecurityDomainId
          || current.securityEpoch !== migration.sourceSecurityEpoch) {
          throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
        }
        const updated = { ...current, securityDomainId: migration.targetSecurityDomainId,
          securityEpoch: migration.targetSecurityEpoch, version: current.version + 1 };
        state.assets.set(key, structuredClone(updated));
        return structuredClone(updated);
      },
      rollbackSecurityOwnership: async (migrationId, assetId, expectedVersion) => {
        const migration = migrationForObjectRollback(migrationId);
        const key = `${tenantPrefix}${assetId}`;
        const current = state.assets.get(key);
        if (current === undefined) throw new Error("ASSET_NOT_FOUND");
        if (current.version !== expectedVersion) throw new Error("ASSET_VERSION_CONFLICT");
        assertMigrationScope(migration, current.ownerNodeId);
        if (current.projectId !== migration.projectId || current.securityDomainId !== migration.targetSecurityDomainId
          || current.securityEpoch !== migration.targetSecurityEpoch) {
          throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
        }
        const updated = { ...current, securityDomainId: migration.sourceSecurityDomainId,
          securityEpoch: migration.sourceSecurityEpoch, version: current.version + 1 };
        state.assets.set(key, structuredClone(updated));
        return structuredClone(updated);
      },
      insertBinding: async (binding) => {
        assertTenant(tenantId, binding.tenantId);
        const key = `${tenantPrefix}${binding.id}`;
        if (state.assetBindings.has(key)) throw new Error("ASSET_BINDING_ALREADY_EXISTS");
        state.assetBindings.set(key, structuredClone(binding));
      },
      listBindings: async (targetType, targetId) => [...state.assetBindings.values()]
        .filter((binding) => binding.tenantId === tenantId && binding.targetType === targetType && binding.targetId === targetId)
        .map((binding) => structuredClone(binding)),
    },
    externalBindings: {
      getByOwner: async (ownerType, ownerId, role) => clone([...state.externalBindings.values()].find(
        (binding) => binding.tenantId === tenantId && binding.ownerType === ownerType && binding.ownerId === ownerId && binding.role === role,
      )),
      insert: async (binding) => {
        assertTenant(tenantId, binding.tenantId);
        const ownerKey = externalOwnerKey(tenantId, binding.ownerType, binding.ownerId, binding.role);
        if ([...state.externalBindings.values()].some((item) => externalOwnerKey(item.tenantId, item.ownerType, item.ownerId, item.role) === ownerKey)) {
          throw new Error("EXTERNAL_BINDING_ALREADY_EXISTS");
        }
        state.externalBindings.set(`${tenantPrefix}${binding.id}`, structuredClone(binding));
      },
      update: async (binding, expectedVersion) => {
        assertTenant(tenantId, binding.tenantId);
        const key = `${tenantPrefix}${binding.id}`;
        const existing = state.externalBindings.get(key);
        if (existing === undefined) throw new Error("EXTERNAL_BINDING_NOT_FOUND");
        if (existing.version !== expectedVersion || binding.version !== expectedVersion + 1) throw new Error("EXTERNAL_BINDING_VERSION_CONFLICT");
        state.externalBindings.set(key, structuredClone(binding));
      },
    },
    integrationOperations: {
      get: async (operationId) => clone(state.operations.get(`${tenantPrefix}${operationId}`)),
      insert: async (operation) => {
        assertTenant(tenantId, operation.tenantId);
        const key = `${tenantPrefix}${operation.id}`;
        if (state.operations.has(key)) throw new Error("INTEGRATION_OPERATION_ALREADY_EXISTS");
        state.operations.set(key, structuredClone(operation));
      },
      update: async (operation, expectedVersion) => {
        assertTenant(tenantId, operation.tenantId);
        const key = `${tenantPrefix}${operation.id}`;
        const existing = state.operations.get(key);
        if (existing === undefined) throw new Error("INTEGRATION_OPERATION_NOT_FOUND");
        if (existing.version !== expectedVersion || operation.version !== expectedVersion + 1) throw new Error("INTEGRATION_OPERATION_VERSION_CONFLICT");
        state.operations.set(key, structuredClone(operation));
      },
      appendStep: async (attempt) => {
        assertTenant(tenantId, attempt.tenantId);
        const key = `${tenantPrefix}${attempt.operationId}\u0000${attempt.sequence}`;
        if (state.operationSteps.has(key)) throw new Error("INTEGRATION_STEP_ALREADY_EXISTS");
        state.operationSteps.set(key, structuredClone(attempt));
      },
      listSteps: async (operationId) => [...state.operationSteps.values()]
        .filter((attempt) => attempt.tenantId === tenantId && attempt.operationId === operationId)
        .sort((left, right) => left.sequence - right.sequence)
        .map((attempt) => structuredClone(attempt)),
      listRecoverable: async () => [...state.operations.values()]
        .filter((operation) => operation.tenantId === tenantId && (operation.state === "retryable" || operation.state === "recovery_required"))
        .map((operation) => structuredClone(operation)),
    },
    outboundProjectionFences: {
      acquire: async (fence) => {
        assertTenant(tenantId, fence.tenantId);
        const key = `${tenantPrefix}${fence.id}`;
        const current = state.outboundProjectionFences.get(key);
        if (current !== undefined && current.expiresAtUtc > fence.createdAtUtc) return false;
        state.outboundProjectionFences.set(key, structuredClone(fence));
        return true;
      },
      renew: async (fenceId, token, expiresAtUtc) => {
        const key = `${tenantPrefix}${fenceId}`;
        const current = state.outboundProjectionFences.get(key);
        if (current === undefined || current.token !== token) return false;
        state.outboundProjectionFences.set(key, { ...current, expiresAtUtc });
        return true;
      },
      release: async (fenceId, token) => {
        const key = `${tenantPrefix}${fenceId}`;
        const current = state.outboundProjectionFences.get(key);
        if (current === undefined || current.token !== token) return false;
        state.outboundProjectionFences.delete(key);
        return true;
      },
    },
    identities: {
      findExternal: async (provider, connectionId, externalTenantRef, externalSubjectRef) => clone(state.identityMappings.get(
        identityKey(tenantId, provider, connectionId, externalTenantRef, externalSubjectRef),
      )),
      insertExternal: async (mapping) => {
        assertTenant(tenantId, mapping.tenantId);
        const key = identityKey(tenantId, mapping.provider, mapping.connectionId, mapping.externalTenantRef, mapping.externalSubjectRef);
        if (state.identityMappings.has(key)) throw new Error("EXTERNAL_IDENTITY_ALREADY_MAPPED");
        state.identityMappings.set(key, structuredClone(mapping));
      },
      updateExternal: async (mapping, expectedVersion) => {
        assertTenant(tenantId, mapping.tenantId);
        const key = identityKey(tenantId, mapping.provider, mapping.connectionId, mapping.externalTenantRef, mapping.externalSubjectRef);
        const current = state.identityMappings.get(key);
        if (current === undefined || current.version !== expectedVersion || mapping.version !== expectedVersion + 1) {
          throw new Error("EXTERNAL_IDENTITY_VERSION_CONFLICT");
        }
        state.identityMappings.set(key, structuredClone(mapping));
      },
    },
    principals: {
      get: async (id) => clone(state.principals.get(`${tenantPrefix}${id}`)),
      insert: async (principal) => {
        assertTenant(tenantId, principal.tenantId);
        const key = `${tenantPrefix}${principal.id}`;
        if (state.principals.has(key)) throw new Error("PRINCIPAL_ALREADY_EXISTS");
        state.principals.set(key, structuredClone(principal));
      },
      update: async (principal, expectedVersion) => {
        assertTenant(tenantId, principal.tenantId);
        const key = `${tenantPrefix}${principal.id}`;
        const current = state.principals.get(key);
        if (current === undefined || current.version !== expectedVersion || principal.version !== expectedVersion + 1) throw new Error("PRINCIPAL_VERSION_CONFLICT");
        state.principals.set(key, structuredClone(principal));
      },
    },
    memberships: {
      get: async (projectId, principalId) => clone(state.memberships.get(membershipKey(tenantId, projectId, principalId))),
      insert: async (membership) => {
        assertTenant(tenantId, membership.tenantId);
        const key = membershipKey(tenantId, membership.projectId, membership.principalId);
        if (state.memberships.has(key)) throw new Error("PROJECT_MEMBERSHIP_ALREADY_EXISTS");
        state.memberships.set(key, structuredClone(membership));
      },
      restrictWithSecurityDomains: async (membership, expectedVersion, evaluatedAtUtc) => {
        assertTenant(tenantId, membership.tenantId);
        if (!isCanonicalUtcTimestamp(evaluatedAtUtc)) throw new Error("VALIDATION_FAILED");
        const key = membershipKey(tenantId, membership.projectId, membership.principalId);
        const current = state.memberships.get(key);
        if (current === undefined || current.version !== expectedVersion || membership.version !== expectedVersion + 1
          || membership.tenantId !== current.tenantId || membership.projectId !== current.projectId
          || membership.principalId !== current.principalId || membership.createdAtUtc !== current.createdAtUtc
          || JSON.stringify(membership.securityDomainIds) !== JSON.stringify(current.securityDomainIds)) {
          throw new Error("PROJECT_MEMBERSHIP_VERSION_CONFLICT");
        }
        const demoted = current.status === "active" && current.role === "project_manager"
          && membership.status === "active" && membership.role === "member";
        const revoked = current.status === "active" && membership.status === "revoked"
          && membership.role === current.role;
        if (!demoted && !revoked) throw new Error("PROJECT_MEMBERSHIP_TRANSITION_INVALID");
        if (current.securityDomainIds.length > 0) throw new Error("PROJECT_MEMBERSHIP_TRANSITION_INVALID");
        const principal = state.principals.get(`${tenantPrefix}${membership.principalId}`);
        if (principal?.status !== "active" || principal.kind !== "user") {
          throw new Error("PROJECT_MEMBERSHIP_TARGET_INELIGIBLE");
        }
        const affectedDomains = [...state.securityDomains.values()].filter((domain) => {
          if (domain.tenantId !== tenantId || domain.projectId !== membership.projectId || domain.deletedAtUtc !== null) return false;
          const grant = state.securityGrants.get(securityGrantKey(tenantId, domain.id, membership.principalId));
          return grantAllows(grant, "view", evaluatedAtUtc);
        });
        if (affectedDomains.some((domain) => domain.parentSecurityDomainId !== null)) {
          throw new Error("PROJECT_MEMBERSHIP_TRANSITION_INVALID");
        }
        for (const domain of affectedDomains) {
          const targetGrant = state.securityGrants.get(securityGrantKey(tenantId, domain.id, membership.principalId));
          if (targetGrant !== undefined && isPermanentSecurityAdministrator(targetGrant)) {
            const hasReplacement = [...state.securityGrants.values()].some((grant) => {
              if (grant.tenantId !== tenantId || grant.securityDomainId !== domain.id
                || grant.principalId === membership.principalId || !isPermanentSecurityAdministrator(grant)) return false;
              const replacementMembership = state.memberships.get(membershipKey(tenantId, domain.projectId, grant.principalId));
              const replacementPrincipal = state.principals.get(`${tenantPrefix}${grant.principalId}`);
              return replacementMembership?.status === "active" && replacementMembership.role === "project_manager"
                && replacementPrincipal?.status === "active" && replacementPrincipal.kind === "user";
            });
            if (!hasReplacement) throw new Error("SECURITY_DOMAIN_LAST_ADMINISTRATOR");
          }
        }
        state.memberships.set(key, structuredClone(membership));
        const updatedDomains = affectedDomains.map((domain) => ({
          ...domain,
          permissionVersion: domain.permissionVersion + 1,
          version: domain.version + 1,
        }));
        for (const domain of updatedDomains) state.securityDomains.set(`${tenantPrefix}${domain.id}`, structuredClone(domain));
        return structuredClone(updatedDomains);
      },
    },
    membershipSecurityAudits: {
      append: async (entry) => {
        assertTenant(tenantId, entry.tenantId);
        const key = `${tenantPrefix}${entry.id}`;
        if (state.membershipSecurityAudits.has(key)) throw new Error("SECURITY_AUDIT_ALREADY_EXISTS");
        state.membershipSecurityAudits.set(key, structuredClone(entry));
      },
      listByProject: async (projectId) => [...state.membershipSecurityAudits.values()]
        .filter((entry) => entry.tenantId === tenantId && entry.projectId === projectId)
        .sort((left, right) => left.occurredAtUtc.localeCompare(right.occurredAtUtc) || left.id.localeCompare(right.id))
        .map((entry) => structuredClone(entry)),
    },
    securityDomains: {
      get: async (securityDomainId) => clone(state.securityDomains.get(`${tenantPrefix}${securityDomainId}`)),
      getByRoot: async (projectId, rootNodeId) => clone([...state.securityDomains.values()].find(
        (domain) => domain.tenantId === tenantId && domain.projectId === projectId && domain.rootNodeId === rootNodeId,
      )),
      insert: async (domain) => {
        assertTenant(tenantId, domain.tenantId);
        const key = `${tenantPrefix}${domain.id}`;
        if (state.securityDomains.has(key)) throw new Error("SECURITY_DOMAIN_ALREADY_EXISTS");
        if ([...state.securityDomains.values()].some((item) => item.tenantId === tenantId
          && item.projectId === domain.projectId && item.rootNodeId === domain.rootNodeId)) {
          throw new Error("SECURITY_ROOT_ALREADY_EXISTS");
        }
        state.securityDomains.set(key, structuredClone(domain));
      },
    },
    securityGrants: {
      get: async (securityDomainId, principalId) => clone(state.securityGrants.get(
        securityGrantKey(tenantId, securityDomainId, principalId),
      )),
      listByDomain: async (securityDomainId) => [...state.securityGrants.values()]
        .filter((grant) => grant.tenantId === tenantId && grant.securityDomainId === securityDomainId)
        .map((grant) => structuredClone(grant)),
      insert: async (grant) => {
        assertTenant(tenantId, grant.tenantId);
        const key = securityGrantKey(tenantId, grant.securityDomainId, grant.principalId);
        if (state.securityGrants.has(key)) throw new Error("SECURITY_GRANT_ALREADY_EXISTS");
        state.securityGrants.set(key, structuredClone(grant));
      },
      saveWithDomainVersion: async (grant, expectedGrantVersion, domain, expectedDomainVersion) => {
        assertTenant(tenantId, grant.tenantId);
        assertTenant(tenantId, domain.tenantId);
        if (grant.securityDomainId !== domain.id) throw new Error("SECURITY_GRANT_DOMAIN_MISMATCH");
        const domainKey = `${tenantPrefix}${domain.id}`;
        const currentDomain = state.securityDomains.get(domainKey);
        if (currentDomain === undefined
          || currentDomain.version !== expectedDomainVersion
          || domain.version !== expectedDomainVersion + 1
          || domain.permissionVersion !== currentDomain.permissionVersion + 1
          || domain.projectId !== currentDomain.projectId
          || domain.rootNodeId !== currentDomain.rootNodeId
          || domain.parentSecurityDomainId !== currentDomain.parentSecurityDomainId
          || domain.createdByPrincipalId !== currentDomain.createdByPrincipalId
          || domain.createdAtUtc !== currentDomain.createdAtUtc
          || domain.deletedAtUtc !== currentDomain.deletedAtUtc) {
          throw new Error("SECURITY_DOMAIN_VERSION_CONFLICT");
        }
        const grantKey = securityGrantKey(tenantId, grant.securityDomainId, grant.principalId);
        const currentGrant = state.securityGrants.get(grantKey);
        if (expectedGrantVersion === null) {
          if (currentGrant !== undefined || grant.version !== 1) throw new Error("SECURITY_GRANT_VERSION_CONFLICT");
        } else if (currentGrant === undefined
          || currentGrant.version !== expectedGrantVersion
          || grant.version !== expectedGrantVersion + 1
          || grant.id !== currentGrant.id
          || grant.createdAtUtc !== currentGrant.createdAtUtc) {
          throw new Error("SECURITY_GRANT_VERSION_CONFLICT");
        }
        const resultingGrants = [...state.securityGrants.values()].filter(
          (item) => item.tenantId === tenantId && item.securityDomainId === domain.id && item.principalId !== grant.principalId,
        );
        resultingGrants.push(grant);
        if (!resultingGrants.some((item) => {
          if (!isPermanentSecurityAdministrator(item)) return false;
          const membership = state.memberships.get(membershipKey(tenantId, domain.projectId, item.principalId));
          const principal = state.principals.get(`${tenantPrefix}${item.principalId}`);
          return membership?.status === "active" && membership.role === "project_manager"
            && principal?.status === "active" && principal.kind === "user";
        })) throw new Error("SECURITY_DOMAIN_LAST_ADMINISTRATOR");
        state.securityGrants.set(grantKey, structuredClone(grant));
        state.securityDomains.set(domainKey, structuredClone(domain));
      },
    },
    securityGrantAudits: {
      append: async (entry) => {
        assertTenant(tenantId, entry.tenantId);
        const key = `${tenantPrefix}${entry.id}`;
        if (state.securityGrantAudits.has(key)) throw new Error("SECURITY_AUDIT_ALREADY_EXISTS");
        state.securityGrantAudits.set(key, structuredClone(entry));
      },
      listByDomain: async (securityDomainId) => [...state.securityGrantAudits.values()]
        .filter((entry) => entry.tenantId === tenantId && entry.securityDomainId === securityDomainId)
        .sort((left, right) => left.occurredAtUtc.localeCompare(right.occurredAtUtc) || left.id.localeCompare(right.id))
        .map((entry) => structuredClone(entry)),
    },
    securityMigrations: {
      get: async (migrationId) => clone(state.securityMigrations.get(`${tenantPrefix}${migrationId}`)),
      insert: async (migration) => {
        assertTenant(tenantId, migration.tenantId);
        assertSecurityMigrationInitialPlan(migration);
        const key = `${tenantPrefix}${migration.id}`;
        if (state.securityMigrations.has(key)) throw new Error("SECURITY_MIGRATION_ALREADY_EXISTS");
        if ([...state.securityMigrations.values()].some((item) => item.tenantId === tenantId
          && item.rootNodeId === migration.rootNodeId && !["committed", "rolled_back"].includes(item.state))) {
          throw new Error("SECURITY_MIGRATION_ROOT_ALREADY_OPEN");
        }
        state.securityMigrations.set(key, structuredClone(migration));
      },
      saveProgressPreservingPlan: async (migrationId, migration, expectedVersion) => {
        const key = `${tenantPrefix}${migrationId}`;
        const current = state.securityMigrations.get(key);
        if (current === undefined) throw new Error("SECURITY_MIGRATION_NOT_FOUND");
        if (current.version !== expectedVersion || migration.version !== expectedVersion + 1) throw new Error("SECURITY_MIGRATION_VERSION_CONFLICT");
        if (migration.tenantId !== tenantId || migration.id !== migrationId
          || migration.projectId !== current.projectId || migration.rootNodeId !== current.rootNodeId
          || migration.sourceSecurityDomainId !== current.sourceSecurityDomainId
          || migration.targetSecurityDomainId !== current.targetSecurityDomainId
          || migration.hierarchyRevision !== current.hierarchyRevision
          || migration.sourceSecurityEpoch !== current.sourceSecurityEpoch
          || migration.targetSecurityEpoch !== current.targetSecurityEpoch
          || migration.totalItems !== current.totalItems || migration.deadlineAtUtc !== current.deadlineAtUtc
          || migration.createdAtUtc !== current.createdAtUtc) {
          throw new Error("SECURITY_MIGRATION_PLAN_IMMUTABLE");
        }
        assertSecurityMigrationProgressChange(current, migration);
        if (migration.state === "committed" || migration.state === "rolled_back") {
          throw new Error("SECURITY_MIGRATION_TERMINAL_BYPASS_FORBIDDEN");
        }
        if (current.state === "planned" && migration.state === "active"
          && hasActiveFenceOrUnresolvedOperationInMigrationScope(state, tenantId, migration, nowUtc())) {
          throw new Error("SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE");
        }
        state.securityMigrations.set(key, structuredClone(migration));
      },
      saveManifestSnapshot: async (snapshot) => {
        if (snapshot.tenantId !== tenantId) throw new Error("TENANT_CONTEXT_MISMATCH");
        const key = `${tenantPrefix}${snapshot.migrationId}`;
        const existing = state.manifestSnapshots.get(key);
        if (existing !== undefined) {
          if (
            existing.manifestDigest !== snapshot.manifestDigest
            || existing.itemCount !== snapshot.itemCount
            || existing.itemCount !== snapshot.items.length
            || existing.createdAtUtc !== snapshot.createdAtUtc
            || JSON.stringify(existing.items) !== JSON.stringify(snapshot.items)
          ) {
            throw new Error("SECURITY_MIGRATION_SNAPSHOT_IMMUTABLE");
          }
          return;
        }
        const migration = state.securityMigrations.get(key);
        const envelope = migration !== undefined ? {
          tenantId,
          projectId: snapshot.projectId ?? migration.projectId,
          migrationId: snapshot.migrationId,
          sourceSecurityDomainId: snapshot.sourceSecurityDomainId !== undefined ? snapshot.sourceSecurityDomainId : migration.sourceSecurityDomainId,
          targetSecurityDomainId: snapshot.targetSecurityDomainId !== undefined ? snapshot.targetSecurityDomainId : migration.targetSecurityDomainId,
          sourceSecurityEpoch: snapshot.sourceSecurityEpoch ?? migration.sourceSecurityEpoch,
          targetSecurityEpoch: snapshot.targetSecurityEpoch ?? migration.targetSecurityEpoch,
        } : {
          tenantId,
          projectId: snapshot.projectId,
          migrationId: snapshot.migrationId,
          sourceSecurityDomainId: snapshot.sourceSecurityDomainId ?? null,
          targetSecurityDomainId: snapshot.targetSecurityDomainId ?? null,
          sourceSecurityEpoch: snapshot.sourceSecurityEpoch,
          targetSecurityEpoch: snapshot.targetSecurityEpoch,
        };
        validateCanonicalSnapshotItems(snapshot, envelope);
        state.manifestSnapshots.set(key, structuredClone(snapshot));
      },
      getManifestSnapshot: async (migrationId) => {
        const key = `${tenantPrefix}${migrationId}`;
        const item = state.manifestSnapshots.get(key);
        if (item === undefined) return undefined;
        const migration = state.securityMigrations.get(key);
        const envelope = migration !== undefined ? {
          tenantId,
          projectId: item.projectId ?? migration.projectId,
          migrationId: item.migrationId,
          sourceSecurityDomainId: item.sourceSecurityDomainId !== undefined ? item.sourceSecurityDomainId : migration.sourceSecurityDomainId,
          targetSecurityDomainId: item.targetSecurityDomainId !== undefined ? item.targetSecurityDomainId : migration.targetSecurityDomainId,
          sourceSecurityEpoch: item.sourceSecurityEpoch ?? migration.sourceSecurityEpoch,
          targetSecurityEpoch: item.targetSecurityEpoch ?? migration.targetSecurityEpoch,
        } : {
          tenantId,
          projectId: item.projectId,
          migrationId: item.migrationId,
          sourceSecurityDomainId: item.sourceSecurityDomainId ?? null,
          targetSecurityDomainId: item.targetSecurityDomainId ?? null,
          sourceSecurityEpoch: item.sourceSecurityEpoch,
          targetSecurityEpoch: item.targetSecurityEpoch,
        };
        validateCanonicalSnapshotItems(item, envelope);
        return structuredClone(item);
      },
      getReadinessEvidence: async (evidenceId) => {
        const record = state.readinessEvidence.get(`${tenantPrefix}${evidenceId}`);
        return record === undefined ? undefined : structuredClone(record);
      },
      commitWithReadinessEvidence: async (params) => {
        const currentNowUtc = nowUtc();
        const key = `${tenantPrefix}${params.migrationId}`;
        const current = state.securityMigrations.get(key);
        if (current === undefined) throw new Error("SECURITY_MIGRATION_NOT_FOUND");
        if (current.version !== params.expectedVersion) throw new Error("SECURITY_MIGRATION_VERSION_CONFLICT");
        if (current.state !== "verifying") throw new Error("SECURITY_MIGRATION_COMMIT_INVALID");

        await assertActorAuthorizedForMigration(current, params.actorPrincipalId, currentNowUtc);

        const evidenceKey = `${tenantPrefix}${params.evidenceId}`;
        const evidence = state.readinessEvidence.get(evidenceKey);
        if (evidence === undefined) throw new Error("SECURITY_MIGRATION_EVIDENCE_NOT_FOUND");

        if (evidence.status !== "verified") {
          throw new Error("SECURITY_MIGRATION_EVIDENCE_NOT_VERIFIED");
        }
        if (evidence.provider !== "huly") {
          throw new Error("SECURITY_MIGRATION_EVIDENCE_INVALID");
        }
        if (evidence.purpose !== "commit") {
          throw new Error("SECURITY_MIGRATION_EVIDENCE_INVALID");
        }
        if (
          evidence.tenantId !== tenantId
          || evidence.projectId !== current.projectId
          || evidence.migrationId !== current.id
          || evidence.targetSecurityDomainId !== current.targetSecurityDomainId
          || evidence.targetSecurityEpoch !== current.targetSecurityEpoch
          || evidence.sourceSecurityDomainId !== current.sourceSecurityDomainId
          || evidence.sourceSecurityEpoch !== current.sourceSecurityEpoch
        ) {
          throw new Error("SECURITY_MIGRATION_EVIDENCE_INVALID");
        }

        if (
          !evidence.converged
          || evidence.channels?.issue !== "converged"
          || evidence.channels?.attachment !== "converged"
          || evidence.channels?.blob !== "converged"
        ) {
          throw new Error("SECURITY_MIGRATION_CONVERGENCE_NOT_READY");
        }

        if (currentNowUtc > evidence.expiresAtUtc) {
          throw new Error("SECURITY_MIGRATION_EVIDENCE_EXPIRED");
        }

        if (evidence.verifiedAtUtc === null || evidence.verifiedAtUtc > currentNowUtc) {
          throw new Error("SECURITY_MIGRATION_EVIDENCE_INVALID");
        }

        if (evidence.issuedAtUtc > evidence.verifiedAtUtc) {
          throw new Error("SECURITY_MIGRATION_EVIDENCE_INVALID");
        }

        const nonceKey = `${tenantPrefix}${evidence.nonce}`;
        const evidenceIdKey = `${tenantPrefix}${evidence.evidenceId}`;
        if (state.consumedReadinessEvidence.has(nonceKey) || state.consumedReadinessEvidence.has(evidenceIdKey)) {
          throw new Error("SECURITY_MIGRATION_EVIDENCE_REPLAYED");
        }

        // TOCTOU Revalidation
        const snapshot = state.manifestSnapshots.get(key);
        if (snapshot === undefined) {
          throw new Error("SECURITY_MIGRATION_MANIFEST_SNAPSHOT_NOT_FOUND");
        }
        if (snapshot.manifestDigest !== evidence.manifestDigest || snapshot.items.length !== evidence.itemCount) {
          throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH");
        }

        const liveManifest = await collectSecurityMigrationManifest(context, current);
        assertManifestMatchesSnapshot(liveManifest, snapshot);

        if (hasIncompleteInventoryObjectsInMigrationScope(state, tenantId, current)) {
          throw new Error("SECURITY_MIGRATION_INVENTORY_INCOMPLETE");
        }

        if (hasActiveFenceOrUnresolvedOperationInMigrationScope(state, tenantId, current, currentNowUtc)) {
          throw new Error("SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE");
        }

        const record = {
          evidenceId: evidence.evidenceId,
          nonce: evidence.nonce,
          migrationId: current.id,
          manifestDigest: evidence.manifestDigest,
          consumedAtUtc: currentNowUtc,
        };
        state.consumedReadinessEvidence.set(nonceKey, record);
        state.consumedReadinessEvidence.set(evidenceIdKey, record);

        const updatedEvidence: SecurityMigrationReadinessEvidenceRecord = {
          ...evidence,
          status: "consumed",
          consumedAtUtc: currentNowUtc,
        };
        state.readinessEvidence.set(evidenceKey, updatedEvidence);

        const committed = transitionSecurityMigration(current, "committed", currentNowUtc);
        state.securityMigrations.set(key, structuredClone(committed));

        const audit: SecurityMigrationAuditEntry = {
          tenantId,
          auditId: randomUUID(),
          migrationId: committed.id,
          projectId: committed.projectId,
          action: "committed",
          actorPrincipalId: params.actorPrincipalId,
          reason: params.reason ?? "Security migration external convergence verified and committed",
          sourceSecurityDomainId: committed.sourceSecurityDomainId,
          targetSecurityDomainId: committed.targetSecurityDomainId,
          sourceSecurityEpoch: committed.sourceSecurityEpoch,
          targetSecurityEpoch: committed.targetSecurityEpoch,
          migratedItems: committed.migratedItems,
          occurredAtUtc: currentNowUtc,
        };
        await context.securityMigrationAudits.append(audit);

        const projectSequence = await context.sequences.next(committed.projectId);
        const event: DomainEvent = {
          tenantId,
          eventId: randomUUID(),
          projectId: committed.projectId,
          projectSequence,
          aggregateType: "security_domain_migration",
          aggregateId: committed.id,
          aggregateVersion: committed.version,
          eventType: "project-map.security-migration.committed",
          schemaVersion: 1,
          actorPrincipalId: params.actorPrincipalId,
          occurredAtUtc: currentNowUtc,
          correlationId: params.idempotencyKey ?? committed.id,
          causationId: params.idempotencyKey ?? committed.id,
          originalSecurityDomainId: committed.targetSecurityDomainId,
          originalSecurityEpoch: committed.targetSecurityEpoch,
          payload: {
            migrationId: committed.id,
            rootNodeId: committed.rootNodeId,
            sourceSecurityDomainId: committed.sourceSecurityDomainId,
            targetSecurityDomainId: committed.targetSecurityDomainId,
            sourceSecurityEpoch: committed.sourceSecurityEpoch,
            targetSecurityEpoch: committed.targetSecurityEpoch,
            migratedItems: committed.migratedItems,
          },
        };
        await context.events.append(event);

        const outbox: OutboxMessage = {
          tenantId,
          id: `outbox:${event.eventId}`,
          eventId: event.eventId,
          topic: eventTopic(event),
          payload: event,
          state: "pending",
          availableAtUtc: currentNowUtc,
          attempts: 0,
          maxAttempts: 8,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAtUtc: null,
          lastError: null,
          publishedAtUtc: null,
          createdAtUtc: currentNowUtc,
        };
        await context.outbox.enqueue(outbox);

        const commitResult: CommitSecurityMigrationResult = {
          migrationId: committed.id,
          state: "committed",
          migrationVersion: committed.version,
          occurredAtUtc: params.occurredAtUtc,
        };

        if (params.idempotencyKey !== undefined) {
          const scope: CommandScope = {
            principalId: params.actorPrincipalId,
            operation: "commit_security_migration",
            idempotencyKey: params.idempotencyKey,
          };
          await context.receipts.insert({
            scope,
            fingerprint: createHash("sha256").update(JSON.stringify({
              migrationId: committed.id,
              expectedVersion: params.expectedVersion,
              occurredAtUtc: params.occurredAtUtc,
            })).digest("hex"),
            result: commitResult,
            createdAtUtc: currentNowUtc,
          });
        }

        return commitResult;
      },
      rollbackWithAudit: async (params) => {
        const currentNowUtc = nowUtc();
        const key = `${tenantPrefix}${params.migrationId}`;
        const current = state.securityMigrations.get(key);
        if (current === undefined) throw new Error("SECURITY_MIGRATION_NOT_FOUND");
        if (current.version !== params.expectedVersion) throw new Error("SECURITY_MIGRATION_VERSION_CONFLICT");
        if (!["planned", "active", "verifying", "retryable", "recovery_required"].includes(current.state)) {
          throw new Error("SECURITY_MIGRATION_ROLLBACK_INVALID");
        }

        await assertActorAuthorizedForMigration(current, params.actorPrincipalId, currentNowUtc);

        let rolledBackItems = 0;
        if (current.migratedItems > 0) {
          if (params.evidenceId === undefined) {
            throw new Error("SECURITY_MIGRATION_EVIDENCE_REQUIRED");
          }
          const evidenceKey = `${tenantPrefix}${params.evidenceId}`;
          const evidence = state.readinessEvidence.get(evidenceKey);
          if (evidence === undefined) throw new Error("SECURITY_MIGRATION_EVIDENCE_NOT_FOUND");

          if (evidence.status !== "verified") {
            throw new Error("SECURITY_MIGRATION_EVIDENCE_NOT_VERIFIED");
          }
          if (evidence.provider !== "huly") {
            throw new Error("SECURITY_MIGRATION_EVIDENCE_INVALID");
          }
          if (evidence.purpose !== "rollback") {
            throw new Error("SECURITY_MIGRATION_EVIDENCE_INVALID");
          }
          if (
            evidence.tenantId !== tenantId
            || evidence.projectId !== current.projectId
            || evidence.migrationId !== current.id
            || evidence.targetSecurityDomainId !== current.sourceSecurityDomainId
            || evidence.targetSecurityEpoch !== current.sourceSecurityEpoch
            || evidence.sourceSecurityDomainId !== current.targetSecurityDomainId
            || evidence.sourceSecurityEpoch !== current.targetSecurityEpoch
          ) {
            throw new Error("SECURITY_MIGRATION_EVIDENCE_INVALID");
          }

          if (
            !evidence.converged
            || evidence.channels?.issue !== "converged"
            || evidence.channels?.attachment !== "converged"
            || evidence.channels?.blob !== "converged"
          ) {
            throw new Error("SECURITY_MIGRATION_CONVERGENCE_NOT_READY");
          }

          if (currentNowUtc > evidence.expiresAtUtc) {
            throw new Error("SECURITY_MIGRATION_EVIDENCE_EXPIRED");
          }

          if (evidence.verifiedAtUtc === null || evidence.verifiedAtUtc > currentNowUtc) {
            throw new Error("SECURITY_MIGRATION_EVIDENCE_INVALID");
          }

          if (evidence.issuedAtUtc > evidence.verifiedAtUtc) {
            throw new Error("SECURITY_MIGRATION_EVIDENCE_INVALID");
          }

          const nonceKey = `${tenantPrefix}${evidence.nonce}`;
          const evidenceIdKey = `${tenantPrefix}${evidence.evidenceId}`;
          if (state.consumedReadinessEvidence.has(nonceKey) || state.consumedReadinessEvidence.has(evidenceIdKey)) {
            throw new Error("SECURITY_MIGRATION_EVIDENCE_REPLAYED");
          }

          const snapshot = state.manifestSnapshots.get(key);
          if (snapshot === undefined) {
            throw new Error("SECURITY_MIGRATION_MANIFEST_SNAPSHOT_NOT_FOUND");
          }
          if (snapshot.manifestDigest !== evidence.manifestDigest || snapshot.items.length !== evidence.itemCount) {
            throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH");
          }

          if (hasActiveFenceOrUnresolvedOperationInMigrationScope(state, tenantId, current, currentNowUtc)) {
            throw new Error("SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE");
          }

          const liveManifest = await collectSecurityMigrationManifest(context, current);
          assertManifestMatchesSnapshot(liveManifest, snapshot);

          const record = {
            evidenceId: evidence.evidenceId,
            nonce: evidence.nonce,
            migrationId: current.id,
            manifestDigest: evidence.manifestDigest,
            consumedAtUtc: currentNowUtc,
          };
          state.consumedReadinessEvidence.set(nonceKey, record);
          state.consumedReadinessEvidence.set(evidenceIdKey, record);

          const updatedEvidence: SecurityMigrationReadinessEvidenceRecord = {
            ...evidence,
            status: "consumed",
            consumedAtUtc: currentNowUtc,
          };
          state.readinessEvidence.set(evidenceKey, updatedEvidence);

          // Restore objects in reverse order using immutable manifest snapshot (asset -> task -> node)
          // 1. Assets
          for (const item of snapshot.items.filter((i) => i.kind === "asset")) {
            const asset = await context.assets.get(item.id);
            if (asset !== undefined && asset.securityDomainId === current.targetSecurityDomainId && asset.securityEpoch === current.targetSecurityEpoch) {
              await context.assets.rollbackSecurityOwnership(current.id, asset.id, asset.version);
              rolledBackItems++;
            }
          }
          // 2. Tasks
          for (const item of snapshot.items.filter((i) => i.kind === "task")) {
            const task = await context.tasks.get(item.id);
            if (task !== undefined && task.securityDomainId === current.targetSecurityDomainId && task.securityEpoch === current.targetSecurityEpoch) {
              await context.tasks.rollbackSecurityOwnership(current.id, task.id, task.version);
              rolledBackItems++;
            }
          }
          // 3. Nodes in reverse depth order (leaves before root)
          const nodeDepths = collectSubtreeDepths(current.projectId, current.rootNodeId);
          const nodeItems = snapshot.items
            .filter((i) => i.kind === "node")
            .sort((a, b) => (nodeDepths.get(b.id) ?? 0) - (nodeDepths.get(a.id) ?? 0));
          for (const item of nodeItems) {
            const node = await context.nodes.get(item.id);
            if (node !== undefined && node.securityDomainId === current.targetSecurityDomainId && node.securityEpoch === current.targetSecurityEpoch) {
              await context.nodes.rollbackSecurityOwnership(current.id, node.id, node.version);
              rolledBackItems++;
            }
          }
        }

        if (hasObjectsNotRevertedToSourceInMigrationScope(state, tenantId, current)) {
          throw new Error("SECURITY_MIGRATION_ROLLBACK_INCOMPLETE");
        }

        const rolledBack = transitionSecurityMigration(current, "rolled_back", currentNowUtc);
        state.securityMigrations.set(key, structuredClone(rolledBack));

        const audit: SecurityMigrationAuditEntry = {
          tenantId,
          auditId: randomUUID(),
          migrationId: rolledBack.id,
          projectId: rolledBack.projectId,
          action: "rolled_back",
          actorPrincipalId: params.actorPrincipalId,
          reason: params.reason,
          sourceSecurityDomainId: rolledBack.sourceSecurityDomainId,
          targetSecurityDomainId: rolledBack.targetSecurityDomainId,
          sourceSecurityEpoch: rolledBack.sourceSecurityEpoch,
          targetSecurityEpoch: rolledBack.targetSecurityEpoch,
          migratedItems: rolledBackItems,
          occurredAtUtc: currentNowUtc,
        };
        await context.securityMigrationAudits.append(audit);

        const projectSequence = await context.sequences.next(rolledBack.projectId);
        const event: DomainEvent = {
          tenantId,
          eventId: randomUUID(),
          projectId: rolledBack.projectId,
          projectSequence,
          aggregateType: "security_domain_migration",
          aggregateId: rolledBack.id,
          aggregateVersion: rolledBack.version,
          eventType: "project-map.security-migration.rolled_back",
          schemaVersion: 1,
          actorPrincipalId: params.actorPrincipalId,
          occurredAtUtc: currentNowUtc,
          correlationId: params.idempotencyKey ?? rolledBack.id,
          causationId: params.idempotencyKey ?? rolledBack.id,
          originalSecurityDomainId: rolledBack.sourceSecurityDomainId,
          originalSecurityEpoch: rolledBack.sourceSecurityEpoch,
          payload: {
            migrationId: rolledBack.id,
            rootNodeId: rolledBack.rootNodeId,
            sourceSecurityDomainId: rolledBack.sourceSecurityDomainId,
            targetSecurityDomainId: rolledBack.targetSecurityDomainId,
            sourceSecurityEpoch: rolledBack.sourceSecurityEpoch,
            targetSecurityEpoch: rolledBack.targetSecurityEpoch,
            migratedItems: rolledBackItems,
            reason: params.reason,
          },
        };
        await context.events.append(event);

        const outbox: OutboxMessage = {
          tenantId,
          id: `outbox:${event.eventId}`,
          eventId: event.eventId,
          topic: eventTopic(event),
          payload: event,
          state: "pending",
          availableAtUtc: currentNowUtc,
          attempts: 0,
          maxAttempts: 8,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAtUtc: null,
          lastError: null,
          publishedAtUtc: null,
          createdAtUtc: currentNowUtc,
        };
        await context.outbox.enqueue(outbox);

        const rollbackResult: RollbackSecurityMigrationResult = {
          migrationId: rolledBack.id,
          state: "rolled_back",
          migrationVersion: rolledBack.version,
          rolledBackItems,
          occurredAtUtc: params.occurredAtUtc,
        };

        if (params.idempotencyKey !== undefined) {
          const scope: CommandScope = {
            principalId: params.actorPrincipalId,
            operation: "rollback_security_migration",
            idempotencyKey: params.idempotencyKey,
          };
          await context.receipts.insert({
            scope,
            fingerprint: createHash("sha256").update(JSON.stringify({
              migrationId: rolledBack.id,
              expectedVersion: params.expectedVersion,
              reason: params.reason.trim(),
              occurredAtUtc: params.occurredAtUtc,
            })).digest("hex"),
            result: rollbackResult,
            createdAtUtc: currentNowUtc,
          });
        }

        return rollbackResult;
      },
      listRecoverable: async () => [...state.securityMigrations.values()]
        .filter((migration) => migration.tenantId === tenantId && !["committed", "rolled_back"].includes(migration.state))
        .map((migration) => structuredClone(migration)),
    },
    securityMigrationAudits: {
      append: async (entry) => {
        assertTenant(tenantId, entry.tenantId);
        const key = `${tenantPrefix}${entry.auditId}`;
        if (state.securityMigrationAudits.has(key)) throw new Error("SECURITY_AUDIT_ALREADY_EXISTS");
        state.securityMigrationAudits.set(key, structuredClone(entry));
      },
      listByMigration: async (migrationId) => [...state.securityMigrationAudits.values()]
        .filter((entry) => entry.tenantId === tenantId && entry.migrationId === migrationId)
        .sort((left, right) => left.occurredAtUtc.localeCompare(right.occurredAtUtc) || left.auditId.localeCompare(right.auditId))
        .map((entry) => structuredClone(entry)),
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
      rescheduleDeadLetter: async (jobId, availableAtUtc) => {
        const key = `${tenantPrefix}${jobId}`;
        const job = state.jobs.get(key);
        if (job === undefined || job.state !== "dead_letter") return false;
        state.jobs.set(key, {
          ...job,
          state: "pending",
          availableAtUtc,
          attempts: 0,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAtUtc: null,
          lastError: null,
          completedAtUtc: null,
        });
        return true;
      },
    },
  };
  return context;
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function receiptKey(tenantId: TenantId, scope: CommandScope): string {
  return `${tenantId}\u0000${scope.principalId}\u0000${scope.operation}\u0000${scope.idempotencyKey}`;
}

function externalOwnerKey(tenantId: TenantId, ownerType: ExternalBinding["ownerType"], ownerId: string, role: ExternalBinding["role"]): string {
  return `${tenantId}\u0000${ownerType}\u0000${ownerId}\u0000${role}`;
}

function identityKey(tenantId: TenantId, provider: string, connectionId: string, externalTenantRef: string, externalSubjectRef: string): string {
  return `${tenantId}\u0000${provider}\u0000${connectionId}\u0000${externalTenantRef}\u0000${externalSubjectRef}`;
}

function membershipKey(tenantId: TenantId, projectId: string, principalId: string): string {
  return `${tenantId}\u0000${projectId}\u0000${principalId}`;
}

function securityGrantKey(tenantId: TenantId, securityDomainId: string, principalId: string): string {
  return `${tenantId}\u0000${securityDomainId}\u0000${principalId}`;
}

function reviewActionOrder(action: TaskReviewActionRecord["action"]): number {
  return action === "submitted" ? 0 : 1;
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

function deadLetter<T extends BackgroundJob>(
  store: Map<string, T>,
  tenantId: TenantId,
  id: string,
  leaseToken: string,
  error: string,
): boolean {
  const key = `${tenantId}\u0000${id}`;
  const item = store.get(key);
  if (item === undefined || item.state !== "leased" || item.leaseToken !== leaseToken) return false;
  store.set(key, {
    ...item,
    state: "dead_letter",
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAtUtc: null,
    lastError: error,
  });
  return true;
}

function deferJob<T extends BackgroundJob>(
  store: Map<string, T>,
  tenantId: TenantId,
  id: string,
  leaseToken: string,
  availableAtUtc: string,
): boolean {
  const key = `${tenantId}\u0000${id}`;
  const item = store.get(key);
  if (item === undefined || item.state !== "leased" || item.leaseToken !== leaseToken) return false;
  store.set(key, {
    ...item,
    state: "pending",
    availableAtUtc,
    attempts: Math.max(0, item.attempts - 1),
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAtUtc: null,
  });
  return true;
}

function hasActiveFenceOrUnresolvedOperationInMigrationScope(
  state: MemoryState,
  tenantId: TenantId,
  migration: SecurityDomainMigration,
  trustedNowUtc: string,
): boolean {
  const tenantPrefix = `${tenantId}\u0000`;

  const activeFences = [...state.outboundProjectionFences.values()]
    .filter((f) => f.tenantId === tenantId && f.projectId === migration.projectId && f.expiresAtUtc > trustedNowUtc);

  const unresolvedOps = [...state.operations.values()]
    .filter((op) => op.tenantId === tenantId
      && !["completed", "compensated"].includes(op.state)
      && (op.operationType === "collaboration.task.project" || op.operationType === "collaboration.asset.project"));

  if (activeFences.length === 0 && unresolvedOps.length === 0) {
    return false;
  }

  const migrationRoot = state.nodes.get(`${tenantPrefix}${migration.rootNodeId}`);
  if (migrationRoot === undefined || migrationRoot.projectId !== migration.projectId || migrationRoot.deletedAtUtc !== null) {
    return true;
  }

  for (const fence of activeFences) {
    const visited = new Set<string>();
    let currentId: string | null = fence.ownerNodeId;
    while (currentId !== null) {
      if (visited.has(currentId)) return true;
      visited.add(currentId);
      const node = state.nodes.get(`${tenantPrefix}${currentId}`);
      if (node === undefined || node.projectId !== migration.projectId || node.deletedAtUtc !== null) return true;
      if (node.id === migration.rootNodeId) return true;
      currentId = node.parentId;
    }
  }

  for (const op of state.operations.values()) {
    if (op.tenantId !== tenantId) continue;
    if (op.state === "completed" || op.state === "compensated") continue;
    if (op.operationType !== "collaboration.task.project" && op.operationType !== "collaboration.asset.project") {
      if (op.operationType === "asset.ingest" || op.operationType === "blob.delete") {
        continue;
      }
      return true;
    }

    let ownerNodeId: string | null = null;
    const subjectType = (op as { subjectType?: unknown }).subjectType;
    if (subjectType === "task") {
      const task = state.tasks.get(`${tenantPrefix}${op.subjectId}`);
      if (task === undefined) return true;
      if (task.projectId !== migration.projectId) continue;
      if (task.deletedAtUtc !== null) return true;
      ownerNodeId = task.ownerNodeId;
    } else if (subjectType === "asset") {
      const asset = state.assets.get(`${tenantPrefix}${op.subjectId}`);
      if (asset === undefined) return true;
      if (asset.projectId !== migration.projectId) continue;
      if (asset.deletedAtUtc !== null) return true;
      ownerNodeId = asset.ownerNodeId;
    } else {
      return true;
    }

    if (!ownerNodeId || typeof ownerNodeId !== "string") {
      return true;
    }

    const visited = new Set<string>();
    let currentId: string | null = ownerNodeId;
    while (currentId !== null) {
      if (visited.has(currentId)) return true;
      visited.add(currentId);
      const node = state.nodes.get(`${tenantPrefix}${currentId}`);
      if (node === undefined || node.projectId !== migration.projectId || node.deletedAtUtc !== null) return true;
      if (node.id === migration.rootNodeId) return true;
      currentId = node.parentId;
    }
  }

  return false;
}

function collectSubtreeNodeIds(
  state: MemoryState,
  tenantId: TenantId,
  projectId: string,
  rootNodeId: string,
): Set<string> {
  const projectNodes = [...state.nodes.values()].filter((n) => n.tenantId === tenantId && n.projectId === projectId);
  const byParent = new Map<string | null, string[]>();
  for (const node of projectNodes) {
    if (node.deletedAtUtc !== null) continue;
    const list = byParent.get(node.parentId) ?? [];
    list.push(node.id);
    byParent.set(node.parentId, list);
  }
  const subtree = new Set<string>();
  const queue = [rootNodeId];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (subtree.has(next)) continue;
    subtree.add(next);
    for (const child of byParent.get(next) ?? []) {
      queue.push(child);
    }
  }
  return subtree;
}

function hasIncompleteInventoryObjectsInMigrationScope(
  state: MemoryState,
  tenantId: TenantId,
  migration: SecurityDomainMigration,
): boolean {
  const tenantPrefix = `${tenantId}\u0000`;
  const root = state.nodes.get(`${tenantPrefix}${migration.rootNodeId}`);
  if (root === undefined || root.projectId !== migration.projectId || root.deletedAtUtc !== null) return true;
  const subtree = collectSubtreeNodeIds(state, tenantId, migration.projectId, migration.rootNodeId);

  for (const nodeId of subtree) {
    const node = state.nodes.get(`${tenantPrefix}${nodeId}`);
    if (node === undefined || node.securityDomainId !== migration.targetSecurityDomainId
      || node.securityEpoch !== migration.targetSecurityEpoch) {
      return true;
    }
  }

  for (const task of state.tasks.values()) {
    if (task.tenantId !== tenantId || task.projectId !== migration.projectId || task.deletedAtUtc !== null) continue;
    if (subtree.has(task.ownerNodeId)) {
      if (task.securityDomainId !== migration.targetSecurityDomainId
        || task.securityEpoch !== migration.targetSecurityEpoch) {
        return true;
      }
    }
  }

  for (const asset of state.assets.values()) {
    if (asset.tenantId !== tenantId || asset.projectId !== migration.projectId || asset.deletedAtUtc !== null) continue;
    if (subtree.has(asset.ownerNodeId)) {
      if (asset.securityDomainId !== migration.targetSecurityDomainId
        || asset.securityEpoch !== migration.targetSecurityEpoch) {
        return true;
      }
    }
  }

  return false;
}

function hasObjectsNotRevertedToSourceInMigrationScope(
  state: MemoryState,
  tenantId: TenantId,
  migration: SecurityDomainMigration,
): boolean {
  const tenantPrefix = `${tenantId}\u0000`;
  const root = state.nodes.get(`${tenantPrefix}${migration.rootNodeId}`);
  if (root === undefined || root.projectId !== migration.projectId || root.deletedAtUtc !== null) return true;
  const subtree = collectSubtreeNodeIds(state, tenantId, migration.projectId, migration.rootNodeId);

  for (const nodeId of subtree) {
    const node = state.nodes.get(`${tenantPrefix}${nodeId}`);
    if (node === undefined || node.securityDomainId !== migration.sourceSecurityDomainId
      || node.securityEpoch !== migration.sourceSecurityEpoch) {
      return true;
    }
  }

  for (const task of state.tasks.values()) {
    if (task.tenantId !== tenantId || task.projectId !== migration.projectId || task.deletedAtUtc !== null) continue;
    if (subtree.has(task.ownerNodeId)) {
      if (task.securityDomainId !== migration.sourceSecurityDomainId
        || task.securityEpoch !== migration.sourceSecurityEpoch) {
        return true;
      }
    }
  }

  for (const asset of state.assets.values()) {
    if (asset.tenantId !== tenantId || asset.projectId !== migration.projectId || asset.deletedAtUtc !== null) continue;
    if (subtree.has(asset.ownerNodeId)) {
      if (asset.securityDomainId !== migration.sourceSecurityDomainId
        || asset.securityEpoch !== migration.sourceSecurityEpoch) {
        return true;
      }
    }
  }

  return false;
}

function computeNodeDepths(rootNodeId: string, nodes: readonly ProjectNode[]): Map<string, number> {
  const byParent = new Map<string | null, string[]>();
  for (const node of nodes) {
    const list = byParent.get(node.parentId) ?? [];
    list.push(node.id);
    byParent.set(node.parentId, list);
  }
  const depths = new Map<string, number>();
  depths.set(rootNodeId, 0);
  const queue = [{ id: rootNodeId, depth: 0 }];
  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    for (const child of byParent.get(id) ?? []) {
      depths.set(child, depth + 1);
      queue.push({ id: child, depth: depth + 1 });
    }
  }
  return depths;
}
