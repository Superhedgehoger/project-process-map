import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Asset, AssetBinding } from "../../../domain/src/assets.ts";
import { eventTopic, type BackgroundJob, type DomainEvent, type OutboxMessage } from "../../../domain/src/events.ts";
import type { ExternalBinding } from "../../../domain/src/external-reference.ts";
import { principalId as parsePrincipalId, tenantId as parseTenantId, type TenantId, type PrincipalId } from "../../../domain/src/identity.ts";
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
import {
  grantAllows,
  isCanonicalUtcTimestamp,
  isPermanentSecurityAdministrator,
  type SecurityDomain,
  type SecurityGrant,
  type SecurityGrantAuditEntry,
} from "../../../domain/src/security-access.ts";
import {
  assertCanonicalProjectRoleBinding,
  assertCanonicalTemplateRoleSlot,
  assertCanonicalProjectRoleSlotSnapshot,
  assertCanonicalProjectRoleSlotAuditEntry,
  compareExactStrings,
  normalizeCandidateIds,
  type ProjectRoleBinding,
  type TemplateRoleSlot,
  type ProjectRoleSlotSnapshot,
  type ProjectRoleSlotAuditAction,
  type ProjectRoleSlotAuditEntry,
  type RoleSlotsInitializedPayload,
} from "../../../domain/src/role-slots.ts";
import {
  assertCanonicalDeliverableRequirement,
  assertCanonicalEvidenceLink,
  assertCanonicalDeliverableActionRecord,
  type DeliverableRequirement,
  type EvidenceLink,
  type DeliverableActionRecord,
  type DeliverableAction,
  type DeliverableStatus,
  type EvidenceSourceType,
} from "../../../domain/src/deliverables.ts";
import {
  type AssignNodeLeaderCommand,
  type AssignNodeLeaderFailurePoint,
  type AssignNodeLeaderResult,
  type AssignProjectRoleBindingCommand,
  type AssignProjectRoleBindingFailurePoint,
  type AssignProjectRoleBindingResult,
  type InitializeProjectRoleSlotsCommand,
  type InitializeProjectRoleSlotsFailurePoint,
  type InitializeProjectRoleSlotsResult,
  type RoleBindingAssignedPayload,

  type ClaimOptions,
  type CommandReceipt,
  type CommandScope,
  type CommitSecurityMigrationResult,
  type CommitWithReadinessEvidenceParams,
  type CreateNodeCommand,
  type CreateNodeFailurePoint,
  type CreateNodeResult,
  type JobConsumer,
  type NodeCreatedPayload,
  type NodeLeaderAssignedPayload,
  type OutboxConsumer,
  type Persistence,
  type RollbackSecurityMigrationResult,
  type RollbackWithAuditParams,
  type SecurityMigrationManifestSnapshot,
  type SecurityMigrationReadinessEvidenceRecord,
  type TransactionContext,
} from "../../../application/src/ports/persistence.ts";
import {
  assertEligibleNodeLeader,
  hash,
  inject,
  resolveInheritance,
  validate,
  validateAssignLeader,
} from "../../../application/src/create-node.ts";
import {
  assertEligibleRoleBindingCandidate,
  hashRoleBindingPayload,
  injectRoleBindingFailure,
  validateAssignProjectRoleBinding,
} from "../../../application/src/role-slots/assign-project-role-binding.ts";
import {
  areRoleSlotsIdentical,
  assertCoherentRoleSlotsInitializationRecords,
  hashInitializeRoleSlotsPayload,
  injectRoleSlotFailure,
  validateInitializeProjectRoleSlots,
} from "../../../application/src/role-slots/initialize-project-role-slots.ts";
import { ApplicationError } from "../../../application/src/errors.ts";
import { assertProjectSecurityStable } from "../../../application/src/access/project-security.ts";
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
import { assertNoSensitiveFields, validateEventAgainstSchema } from "../../../domain/src/event-schema-registry.ts";

export type SqlitePersistenceOptions = Readonly<{
  path: string;
  busyTimeoutMilliseconds?: number | undefined;
  now?: (() => Date) | undefined;
  verifier?: ExternalCollaborationEpochReadinessPort | undefined;
  attachTestHarness?: ((harness: TestReadinessHarness) => void) | undefined;
}>;

const pathLocks = new Map<string, Promise<void>>();
const currentSchemaVersion = 12;

export class SqlitePersistence implements Persistence {
  readonly #database: DatabaseSync;
  readonly #lockKey: string;
  readonly #now: () => Date;
  readonly #verifyMigrationReadiness?: VerifyMigrationReadiness | undefined;
  #closed = false;

  constructor(options: SqlitePersistenceOptions) {
    if (options.path.trim().length === 0) throw new Error("SQLite path is required");
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
    this.#now = options.now ?? (() => new Date());
    this.#lockKey = options.path === ":memory:" ? `:memory:${randomUUID()}` : resolve(options.path);
    const busyTimeout = Math.max(10_000, options.busyTimeoutMilliseconds ?? 10_000);
    this.#database = new DatabaseSync(options.path, {
      timeout: busyTimeout,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    this.#database.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
    this.#database.exec("PRAGMA journal_mode=WAL");
    this.#database.exec("PRAGMA synchronous=FULL");
    this.#database.exec("PRAGMA foreign_keys=ON");
    try {
      this.assertSupportedSchema();
      this.migrate();
    } catch (error) {
      try {
        this.#database.close();
      } catch {}
      this.#closed = true;
      throw error;
    }
    if (options.verifier !== undefined) {
      this.#verifyMigrationReadiness = createVerificationOperation({
        persistence: this,
        verifier: options.verifier,
        issueChallenge: async (tenantId, params) => await this.#issueReadinessChallenge(tenantId, params),
        recordVerifiedEvidence: async (tenantId, params) => await this.#recordVerifiedEvidence(tenantId, params),
        nowUtc: () => this.nowUtc(),
      });
    }
    if (options.attachTestHarness !== undefined) {
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
    return (this.#now ?? (() => new Date()))().toISOString();
  }

  #mutateNodeLeader(
    tenantId: TenantId,
    nodeId: string,
    projectId: string,
    leaderPrincipalId: PrincipalId | null,
    expectedVersion: number,
  ): ProjectNode {
    const result = this.#database.prepare(`
      UPDATE project_nodes
      SET leader_principal_id = ?, version = version + 1
      WHERE tenant_id = ? AND node_id = ? AND project_id = ? AND version = ?
    `).run(leaderPrincipalId ?? null, tenantId, nodeId, projectId, expectedVersion);
    if (result.changes !== 1) {
      throw new ApplicationError("NODE_VERSION_CONFLICT", "Node version conflict");
    }
    const row = this.#database.prepare(
      "SELECT * FROM project_nodes WHERE tenant_id = ? AND node_id = ?",
    ).get(tenantId, nodeId) as Record<string, unknown>;
    return nodeFromRow(row);
  }

  #mutateProjectRoleBinding(
    tenantId: TenantId,
    projectId: string,
    slotKey: string,
    principalIds: readonly PrincipalId[],
    expectedVersion: number,
    nextVersion: number,
    nowUtc: string,
    actorPrincipalId: PrincipalId,
  ): ProjectRoleBinding {
    if (expectedVersion === 0) {
      const insertResult = this.#database.prepare(`
        INSERT INTO project_role_bindings (
          tenant_id, project_id, slot_key, principal_ids_json, version, updated_at_utc, updated_by_principal_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        tenantId,
        projectId,
        slotKey,
        JSON.stringify(principalIds),
        nextVersion,
        nowUtc,
        actorPrincipalId,
      );
      if (insertResult.changes !== 1) {
        throw new ApplicationError("ROLE_BINDING_VERSION_CONFLICT", "Role binding version conflict");
      }
    } else {
      const updateResult = this.#database.prepare(`
        UPDATE project_role_bindings
        SET principal_ids_json = ?, version = ?, updated_at_utc = ?, updated_by_principal_id = ?
        WHERE tenant_id = ? AND project_id = ? AND slot_key = ? AND version = ?
      `).run(
        JSON.stringify(principalIds),
        nextVersion,
        nowUtc,
        actorPrincipalId,
        tenantId,
        projectId,
        slotKey,
        expectedVersion,
      );
      if (updateResult.changes !== 1) {
        throw new ApplicationError("ROLE_BINDING_VERSION_CONFLICT", "Role binding version conflict");
      }
    }
    const row = this.#database.prepare(`
      SELECT * FROM project_role_bindings
      WHERE tenant_id = ? AND project_id = ? AND slot_key = ?
    `).get(tenantId, projectId, slotKey) as Record<string, unknown>;
    return bindingFromRow(row, { tenantId, projectId, slotKey });
  }

  #mutateInitializeProjectRoleSlots(
    command: InitializeProjectRoleSlotsCommand,
    nowUtc: string,
  ): Readonly<{ snapshot: ProjectRoleSlotSnapshot; slots: readonly TemplateRoleSlot[] }> {
    const snapshot: ProjectRoleSlotSnapshot = {
      tenantId: command.tenantId,
      projectId: command.projectId,
      sourceTemplateVersionId: command.sourceTemplateVersionId,
      createdAtUtc: nowUtc,
      createdByPrincipalId: command.principalId,
    };
    assertCanonicalProjectRoleSlotSnapshot(snapshot, {
      tenantId: command.tenantId,
      projectId: command.projectId,
    });
    this.#database.prepare(`
      INSERT INTO project_role_slot_snapshots (
        tenant_id, project_id, source_template_version_id, created_at_utc, created_by_principal_id
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      snapshot.tenantId,
      snapshot.projectId,
      snapshot.sourceTemplateVersionId,
      snapshot.createdAtUtc,
      snapshot.createdByPrincipalId,
    );

    const insertStmt = this.#database.prepare(`
      INSERT INTO project_role_slots (
        tenant_id, project_id, slot_key, source_template_version_id, name, description, created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const slots: TemplateRoleSlot[] = [];
    for (const slotInit of command.slots) {
      const slot: TemplateRoleSlot = {
        tenantId: command.tenantId,
        projectId: command.projectId,
        slotKey: slotInit.slotKey,
        name: slotInit.name,
        description: slotInit.description ?? null,
        sourceTemplateVersionId: command.sourceTemplateVersionId,
        createdAtUtc: nowUtc,
      };
      assertCanonicalTemplateRoleSlot(slot, {
        tenantId: command.tenantId,
        projectId: command.projectId,
        slotKey: slot.slotKey,
      });
      insertStmt.run(
        slot.tenantId,
        slot.projectId,
        slot.slotKey,
        slot.sourceTemplateVersionId,
        slot.name,
        slot.description,
        slot.createdAtUtc,
      );
      slots.push(slot);
    }
    slots.sort((a, b) => compareExactStrings(a.slotKey, b.slotKey));
    return { snapshot, slots };
  }


  async executeCreateNode(
    command: CreateNodeCommand,
    failurePoint?: CreateNodeFailurePoint,
  ): Promise<CreateNodeResult> {
    validate(command);
    if (command.securityDomainId !== null) {
      throw new ApplicationError(
        "SECURITY_DOMAIN_ASSIGNMENT_REQUIRES_COMMAND",
        "A sensitive root must be created through the security-domain command",
      );
    }
    const scope: CommandScope = {
      principalId: command.principalId,
      operation: "create_node",
      idempotencyKey: command.idempotencyKey,
    };
    const v9Fingerprint = hash({
      projectId: command.projectId,
      nodeId: command.nodeId,
      parentId: command.parentId,
      title: command.title,
      kind: command.kind ?? "work_package",
      securityDomainId: command.securityDomainId,
    });
    const fingerprint = (command.leaderPrincipalId === null || command.leaderPrincipalId === undefined)
      ? v9Fingerprint
      : hash({
          projectId: command.projectId,
          nodeId: command.nodeId,
          parentId: command.parentId,
          leaderPrincipalId: command.leaderPrincipalId,
          title: command.title,
          kind: command.kind ?? "work_package",
          securityDomainId: command.securityDomainId,
        });

    return await this.transaction(command.tenantId, async (transaction) => {
      const nowUtc = this.nowUtc();
      const inheritance = await resolveInheritance(transaction, command, nowUtc);
      const actorPrincipal = await transaction.principals.get(command.principalId);
      const actorMembership = await transaction.memberships.get(command.projectId, command.principalId);
      if (actorPrincipal !== undefined && (actorPrincipal.status !== "active" || actorPrincipal.tenantId !== command.tenantId)) {
        throw new ApplicationError("FORBIDDEN", "Principal is not active");
      }
      if (actorMembership !== undefined && (actorMembership.status !== "active" || actorMembership.tenantId !== command.tenantId)) {
        throw new ApplicationError("FORBIDDEN", "Membership is not active");
      }
      if (command.leaderPrincipalId !== null && command.leaderPrincipalId !== undefined) {
        if (
          actorPrincipal === undefined ||
          actorPrincipal.tenantId !== command.tenantId ||
          actorPrincipal.status !== "active" ||
          actorPrincipal.kind !== "user" ||
          actorMembership === undefined ||
          actorMembership.tenantId !== command.tenantId ||
          actorMembership.projectId !== command.projectId ||
          actorMembership.status !== "active" ||
          !isProjectManager(actorMembership)
        ) {
          throw new ApplicationError("FORBIDDEN", "Only active project managers can assign node leaders");
        }
        await assertEligibleNodeLeader(transaction, command.tenantId, command.projectId, command.leaderPrincipalId);
      }
      const previous = await transaction.receipts.get<Omit<CreateNodeResult, "replayed">>(scope);
      if (previous !== undefined) {
        const allowV9Fallback = command.leaderPrincipalId === null || command.leaderPrincipalId === undefined;
        if (previous.fingerprint !== fingerprint && (!allowV9Fallback || previous.fingerprint !== v9Fingerprint)) {
          throw new ApplicationError("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
        }
        if (previous.result.node.securityDomainId !== inheritance.securityDomainId
          || previous.result.node.securityEpoch !== inheritance.securityEpoch) {
          throw new ApplicationError("PARENT_NODE_NOT_FOUND", "Parent node not found");
        }
        const existingNode = await transaction.nodes.get(command.nodeId);
        if (existingNode === undefined || existingNode.deletedAtUtc !== null) {
          throw new ApplicationError("NODE_NOT_FOUND", "Node not found");
        }
        if (
          existingNode.tenantId !== command.tenantId ||
          existingNode.projectId !== command.projectId ||
          existingNode.parentId !== command.parentId ||
          existingNode.title !== command.title ||
          existingNode.kind !== (command.kind ?? "work_package") ||
          existingNode.securityDomainId !== inheritance.securityDomainId ||
          existingNode.securityEpoch !== inheritance.securityEpoch
        ) {
          throw new ApplicationError("NODE_NOT_FOUND", "Node state has drifted");
        }
        return {
          ...structuredClone(previous.result),
          node: {
            ...structuredClone(existingNode),
            leaderPrincipalId: existingNode.leaderPrincipalId ?? null,
          },
          replayed: true,
        };
      }

      if (await transaction.nodes.get(command.nodeId) !== undefined) {
        throw new Error(`Aggregate already exists: ${command.nodeId}`);
      }

      const projectSequence = await transaction.sequences.next(command.projectId);
      let node: ProjectNode = {
        tenantId: command.tenantId,
        id: command.nodeId,
        projectId: command.projectId,
        parentId: command.parentId,
        leaderPrincipalId: null,
        title: command.title,
        kind: command.kind ?? "work_package",
        securityDomainId: inheritance.securityDomainId,
        securityEpoch: inheritance.securityEpoch,
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
        originalSecurityDomainId: node.securityDomainId,
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

      let leaderAssignedEvent: DomainEvent<NodeLeaderAssignedPayload> | undefined;
      let leaderAssignedOutbox: OutboxMessage | undefined;

      if (command.leaderPrincipalId !== null && command.leaderPrincipalId !== undefined) {
        node = this.#mutateNodeLeader(
          command.tenantId,
          command.nodeId,
          command.projectId,
          command.leaderPrincipalId,
          1,
        );

        const leaderSequence = await transaction.sequences.next(command.projectId);
        leaderAssignedEvent = {
          tenantId: command.tenantId,
          eventId: `evt:${command.commandId}:leader`,
          projectId: command.projectId,
          projectSequence: leaderSequence,
          aggregateType: "project_node",
          aggregateId: node.id,
          aggregateVersion: node.version,
          eventType: "project-map.node.leader_assigned",
          schemaVersion: 1,
          actorPrincipalId: command.principalId,
          occurredAtUtc: command.occurredAtUtc,
          correlationId: command.correlationId,
          causationId: command.commandId,
          originalSecurityDomainId: node.securityDomainId,
          originalSecurityEpoch: node.securityEpoch,
          payload: {
            nodeId: node.id,
            previousLeaderPrincipalId: null,
            leaderPrincipalId: command.leaderPrincipalId,
          },
        };
        await transaction.events.append(leaderAssignedEvent);
        inject(failurePoint, "after_leader_assigned");

        leaderAssignedOutbox = {
          tenantId: command.tenantId,
          id: `outbox:${leaderAssignedEvent.eventId}`,
          eventId: leaderAssignedEvent.eventId,
          topic: eventTopic(leaderAssignedEvent),
          payload: leaderAssignedEvent,
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
        await transaction.outbox.enqueue(leaderAssignedOutbox);
        inject(failurePoint, "after_leader_outbox");
      }

      const result: CreateNodeResult = {
        node,
        event,
        outbox,
        ...(leaderAssignedEvent !== undefined ? { leaderAssignedEvent } : {}),
        ...(leaderAssignedOutbox !== undefined ? { leaderAssignedOutbox } : {}),
        replayed: false,
      };
      await transaction.receipts.insert({
        scope,
        fingerprint,
        result: {
          node,
          event,
          outbox,
          ...(leaderAssignedEvent !== undefined ? { leaderAssignedEvent } : {}),
          ...(leaderAssignedOutbox !== undefined ? { leaderAssignedOutbox } : {}),
        },
        createdAtUtc: command.occurredAtUtc,
      });
      inject(failurePoint, "after_idempotency");
      return result;
    });
  }

  async executeAssignNodeLeader(
    command: AssignNodeLeaderCommand,
    failurePoint?: AssignNodeLeaderFailurePoint,
  ): Promise<AssignNodeLeaderResult> {
    validateAssignLeader(command);
    const scope: CommandScope = {
      principalId: command.principalId,
      operation: "assign_node_leader",
      idempotencyKey: command.idempotencyKey,
    };
    const fingerprint = hash({
      projectId: command.projectId,
      nodeId: command.nodeId,
      expectedVersion: command.expectedVersion,
      leaderPrincipalId: command.leaderPrincipalId,
    });

    return await this.transaction(command.tenantId, async (transaction) => {
      const currentNode = await transaction.nodes.get(command.nodeId);
      if (currentNode === undefined || currentNode.deletedAtUtc !== null) {
        throw new ApplicationError("NODE_NOT_FOUND", "Node not found");
      }
      if (currentNode.projectId !== command.projectId) {
        throw new ApplicationError("PROJECT_MISMATCH", "Project mismatch");
      }

      const actorPrincipal = await transaction.principals.get(command.principalId);
      const actorMembership = await transaction.memberships.get(command.projectId, command.principalId);
      if (
        actorPrincipal === undefined ||
        actorPrincipal.tenantId !== command.tenantId ||
        actorPrincipal.status !== "active" ||
        actorPrincipal.kind !== "user" ||
        actorMembership === undefined ||
        actorMembership.tenantId !== command.tenantId ||
        actorMembership.projectId !== command.projectId ||
        actorMembership.status !== "active" ||
        !isProjectManager(actorMembership)
      ) {
        if (currentNode.securityDomainId !== null) {
          throw new ApplicationError("NODE_NOT_FOUND", "Node not found");
        }
        throw new ApplicationError("FORBIDDEN", "Only active project managers can assign node leaders");
      }

      const nowUtc = this.nowUtc();
      if (currentNode.securityDomainId !== null) {
        const canAccess = await canAccessProjectObjectDuringMigration(
          transaction,
          actorMembership,
          command.principalId,
          {
            projectId: command.projectId,
            ownerNodeId: currentNode.id,
            securityDomainId: currentNode.securityDomainId,
            securityEpoch: currentNode.securityEpoch,
          },
          "edit",
          nowUtc,
        );
        if (!canAccess) {
          throw new ApplicationError("NODE_NOT_FOUND", "Node not found");
        }
      }

      await assertProjectSecurityStable(transaction, command.projectId);

      if (command.leaderPrincipalId !== null) {
        await assertEligibleNodeLeader(transaction, command.tenantId, command.projectId, command.leaderPrincipalId);
      }

      const previous = await transaction.receipts.get<Omit<AssignNodeLeaderResult, "replayed">>(scope);
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint) {
          throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
        }
        return { ...structuredClone(previous.result), replayed: true };
      }

      if (currentNode.version !== command.expectedVersion) {
        throw new ApplicationError("NODE_VERSION_CONFLICT", "Node version conflict");
      }

      const updatedNode = this.#mutateNodeLeader(
        command.tenantId,
        command.nodeId,
        command.projectId,
        command.leaderPrincipalId,
        command.expectedVersion,
      );
      inject(failurePoint, "after_aggregate");

      const projectSequence = await transaction.sequences.next(command.projectId);
      const event: DomainEvent<NodeLeaderAssignedPayload> = {
        tenantId: command.tenantId,
        eventId: `evt:${command.commandId}`,
        projectId: command.projectId,
        projectSequence,
        aggregateType: "project_node",
        aggregateId: updatedNode.id,
        aggregateVersion: updatedNode.version,
        eventType: "project-map.node.leader_assigned",
        schemaVersion: 1,
        actorPrincipalId: command.principalId,
        occurredAtUtc: command.occurredAtUtc,
        correlationId: command.correlationId,
        causationId: command.commandId,
        originalSecurityDomainId: updatedNode.securityDomainId,
        originalSecurityEpoch: updatedNode.securityEpoch,
        payload: {
          nodeId: updatedNode.id,
          previousLeaderPrincipalId: currentNode.leaderPrincipalId,
          leaderPrincipalId: updatedNode.leaderPrincipalId,
        },
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

      const result: AssignNodeLeaderResult = {
        node: updatedNode,
        event,
        outbox,
        replayed: false,
      };
      await transaction.receipts.insert({
        scope,
        fingerprint,
        result: {
          node: updatedNode,
          event,
          outbox,
        },
        createdAtUtc: command.occurredAtUtc,
      });
      inject(failurePoint, "after_idempotency");
      return result;
    });
  }

  async executeAssignProjectRoleBinding(
    command: AssignProjectRoleBindingCommand,
    failurePoint?: AssignProjectRoleBindingFailurePoint,
  ): Promise<AssignProjectRoleBindingResult> {
    validateAssignProjectRoleBinding(command);
    const distinctCandidateIds = normalizeCandidateIds(command.principalIds);
    const scope: CommandScope = {
      principalId: command.principalId,
      operation: "assign_project_role_binding",
      idempotencyKey: command.idempotencyKey,
    };
    const fingerprint = hashRoleBindingPayload({
      projectId: command.projectId,
      slotKey: command.slotKey,
      principalIds: distinctCandidateIds,
      expectedVersion: command.expectedVersion,
    });

    return await this.transaction(command.tenantId, async (transaction) => {
      const actorPrincipal = await transaction.principals.get(command.principalId);
      const actorMembership = await transaction.memberships.get(command.projectId, command.principalId);
      if (
        actorPrincipal === undefined ||
        actorPrincipal.tenantId !== command.tenantId ||
        actorPrincipal.status !== "active" ||
        actorPrincipal.kind !== "user" ||
        actorMembership === undefined ||
        actorMembership.tenantId !== command.tenantId ||
        actorMembership.projectId !== command.projectId ||
        actorMembership.status !== "active" ||
        !isProjectManager(actorMembership)
      ) {
        throw new ApplicationError("FORBIDDEN", "Only active project managers can assign role bindings");
      }

      await assertProjectSecurityStable(transaction, command.projectId);

      const slot = await transaction.roleSlots.get(command.projectId, command.slotKey);
      if (slot === undefined || slot.tenantId !== command.tenantId || slot.projectId !== command.projectId) {
        throw new ApplicationError("ROLE_SLOT_NOT_FOUND", `Role slot ${command.slotKey} not found in project ${command.projectId}`);
      }

      for (const candidateId of distinctCandidateIds) {
        await assertEligibleRoleBindingCandidate(transaction, command.tenantId, command.projectId, candidateId);
      }

      const previous = await transaction.receipts.get<Omit<AssignProjectRoleBindingResult, "replayed">>(scope);
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint) {
          throw new ApplicationError("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
        }

        // 1. Authoritative current binding must exist and be canonical
        const currentBinding = await transaction.roleBindings.get(command.projectId, command.slotKey);
        if (currentBinding === undefined) {
          throw new ApplicationError("ROLE_BINDING_RECORD_CORRUPT", "Authoritative role binding missing on receipt replay");
        }
        assertCanonicalProjectRoleBinding(currentBinding, {
          tenantId: command.tenantId,
          projectId: command.projectId,
          slotKey: command.slotKey,
        });
        if (currentBinding.version < previous.result.binding.version) {
          throw new ApplicationError("ROLE_BINDING_RECORD_CORRUPT", "Authoritative role binding version is older than receipt");
        }

        // 2. Receipt binding must be canonical and complete
        assertCanonicalProjectRoleBinding(previous.result.binding, {
          tenantId: command.tenantId,
          projectId: command.projectId,
          slotKey: command.slotKey,
        });
        if (previous.result.binding.updatedByPrincipalId !== command.principalId) {
          throw new ApplicationError("ROLE_BINDING_RECORD_CORRUPT", "Receipt updatedByPrincipalId mismatch");
        }
        if (
          previous.result.binding.principalIds.length !== distinctCandidateIds.length ||
          !previous.result.binding.principalIds.every((id, idx) => id === distinctCandidateIds[idx])
        ) {
          throw new ApplicationError("ROLE_BINDING_RECORD_CORRUPT", "Receipt principalIds mismatch");
        }
        if (!isCanonicalUtcTimestamp(previous.result.binding.updatedAtUtc)) {
          throw new ApplicationError("ROLE_BINDING_RECORD_CORRUPT", "Receipt updatedAtUtc invalid");
        }
        if (!Number.isInteger(previous.result.binding.version) || previous.result.binding.version <= 0) {
          throw new ApplicationError("ROLE_BINDING_RECORD_CORRUPT", "Receipt version invalid");
        }

        // 3. Receipt event must be coherent and canonical
        const rev = previous.result.event;
        if (
          !rev ||
          rev.tenantId !== command.tenantId ||
          rev.projectId !== command.projectId ||
          rev.aggregateType !== "project_role_binding" ||
          rev.aggregateId !== `${command.projectId}:${command.slotKey}` ||
          rev.aggregateVersion !== previous.result.binding.version ||
          rev.eventType !== "project-map.role-binding.assigned" ||
          rev.schemaVersion !== 1 ||
          rev.actorPrincipalId !== command.principalId ||
          rev.occurredAtUtc !== previous.result.binding.updatedAtUtc ||
          !Number.isInteger(rev.projectSequence) ||
          rev.projectSequence <= 0 ||
          rev.payload?.projectId !== command.projectId ||
          rev.payload?.slotKey !== command.slotKey ||
          rev.payload?.version !== previous.result.binding.version ||
          !Array.isArray(rev.payload?.principalIds) ||
          rev.payload.principalIds.length !== distinctCandidateIds.length ||
          !rev.payload.principalIds.every((id: string, idx: number) => id === distinctCandidateIds[idx])
        ) {
          throw new ApplicationError("ROLE_BINDING_RECORD_CORRUPT", "Receipt event is invalid or divergent");
        }

        // 4. Receipt outbox must be coherent
        const rout = previous.result.outbox;
        if (
          !rout ||
          rout.tenantId !== command.tenantId ||
          rout.id !== `outbox:${rev.eventId}` ||
          rout.eventId !== rev.eventId ||
          rout.topic !== "project-map.role-binding.assigned.v1" ||
          JSON.stringify(rout.payload) !== JSON.stringify(rev)
        ) {
          throw new ApplicationError("ROLE_BINDING_RECORD_CORRUPT", "Receipt outbox is invalid or divergent");
        }

        // 5. Independently load and validate durable domain event
        const eventRow = this.#database.prepare(
          "SELECT * FROM domain_events WHERE tenant_id = ? AND event_id = ?",
        ).get(command.tenantId, rev.eventId) as Record<string, unknown> | undefined;
        if (!eventRow) {
          throw new ApplicationError("ROLE_BINDING_RECORD_CORRUPT", "Durable domain event missing for role binding receipt");
        }
        const durableEvent = domainEventFromRow(eventRow, "ROLE_BINDING_RECORD_CORRUPT");
        if (JSON.stringify(durableEvent) !== JSON.stringify(rev)) {
          throw new ApplicationError("ROLE_BINDING_RECORD_CORRUPT", "Durable domain event divergent from role binding receipt");
        }

        // 6. Independently load and validate durable outbox message
        const outboxRow = this.#database.prepare(
          "SELECT * FROM outbox_messages WHERE tenant_id = ? AND message_id = ?",
        ).get(command.tenantId, rout.id) as Record<string, unknown> | undefined;
        if (!outboxRow) {
          throw new ApplicationError("ROLE_BINDING_RECORD_CORRUPT", "Durable outbox message missing for role binding receipt");
        }
        const durableOutbox = outboxFromRow(outboxRow);
        if (
          durableOutbox.tenantId !== command.tenantId ||
          durableOutbox.id !== rout.id ||
          durableOutbox.eventId !== rev.eventId ||
          durableOutbox.topic !== rout.topic ||
          durableOutbox.createdAtUtc !== rout.createdAtUtc ||
          JSON.stringify(durableOutbox.payload) !== JSON.stringify(rev)
        ) {
          throw new ApplicationError("ROLE_BINDING_RECORD_CORRUPT", "Durable outbox message divergent from role binding receipt");
        }

        return { ...structuredClone(previous.result), replayed: true };
      }

      const currentBinding = await transaction.roleBindings.get(command.projectId, command.slotKey);
      if (currentBinding === undefined) {
        if (command.expectedVersion !== 0) {
          throw new ApplicationError("ROLE_BINDING_VERSION_CONFLICT", "Role binding version conflict");
        }
      } else {
        if (currentBinding.version !== command.expectedVersion) {
          throw new ApplicationError("ROLE_BINDING_VERSION_CONFLICT", "Role binding version conflict");
        }
      }

      const nextVersion = (currentBinding?.version ?? 0) + 1;
      const nowUtc = this.nowUtc();

      const binding = this.#mutateProjectRoleBinding(
        command.tenantId,
        command.projectId,
        command.slotKey,
        distinctCandidateIds,
        command.expectedVersion,
        nextVersion,
        nowUtc,
        command.principalId,
      );
      injectRoleBindingFailure(failurePoint, "after_aggregate");

      const projectSequence = await transaction.sequences.next(command.projectId);
      const event: DomainEvent<RoleBindingAssignedPayload> = {
        tenantId: command.tenantId,
        eventId: `evt:${command.commandId}`,
        projectId: command.projectId,
        projectSequence,
        aggregateType: "project_role_binding",
        aggregateId: `${command.projectId}:${command.slotKey}`,
        aggregateVersion: binding.version,
        eventType: "project-map.role-binding.assigned",
        schemaVersion: 1,
        actorPrincipalId: command.principalId,
        occurredAtUtc: nowUtc,
        correlationId: command.correlationId,
        causationId: command.commandId,
        originalSecurityDomainId: null,
        originalSecurityEpoch: 0,
        payload: {
          projectId: command.projectId,
          slotKey: command.slotKey,
          principalIds: distinctCandidateIds,
          version: binding.version,
        },
      };
      await transaction.events.append(event);
      injectRoleBindingFailure(failurePoint, "after_event");

      const outbox: OutboxMessage = {
        tenantId: command.tenantId,
        id: `outbox:${event.eventId}`,
        eventId: event.eventId,
        topic: eventTopic(event),
        payload: event,
        state: "pending",
        availableAtUtc: nowUtc,
        attempts: 0,
        maxAttempts: 8,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAtUtc: null,
        lastError: null,
        publishedAtUtc: null,
        createdAtUtc: nowUtc,
      };
      await transaction.outbox.enqueue(outbox);
      injectRoleBindingFailure(failurePoint, "after_outbox");

      const result: AssignProjectRoleBindingResult = {
        binding,
        event,
        outbox,
        replayed: false,
      };
      await transaction.receipts.insert({
        scope,
        fingerprint,
        result: {
          binding,
          event,
          outbox,
        },
        createdAtUtc: nowUtc,
      });
      injectRoleBindingFailure(failurePoint, "after_idempotency");
      return result;
    });
  }

  async executeInitializeProjectRoleSlots(
    command: InitializeProjectRoleSlotsCommand,
    failurePoint?: InitializeProjectRoleSlotsFailurePoint,
  ): Promise<InitializeProjectRoleSlotsResult> {
    validateInitializeProjectRoleSlots(command);
    const scope: CommandScope = {
      principalId: command.principalId,
      operation: "initialize_project_role_slots",
      idempotencyKey: command.idempotencyKey,
    };
    const fingerprint = hashInitializeRoleSlotsPayload(command);

    return await this.transaction(command.tenantId, async (transaction) => {
      const actorPrincipal = await transaction.principals.get(command.principalId);
      const actorMembership = await transaction.memberships.get(command.projectId, command.principalId);
      if (
        actorPrincipal === undefined ||
        actorPrincipal.tenantId !== command.tenantId ||
        actorPrincipal.status !== "active" ||
        actorPrincipal.kind !== "user" ||
        actorMembership === undefined ||
        actorMembership.tenantId !== command.tenantId ||
        actorMembership.projectId !== command.projectId ||
        actorMembership.status !== "active" ||
        !isProjectManager(actorMembership)
      ) {
        throw new ApplicationError("FORBIDDEN", "Only active project managers can initialize role slots");
      }

      await assertProjectSecurityStable(transaction, command.projectId);

      const previous = await transaction.receipts.get<Omit<InitializeProjectRoleSlotsResult, "replayed">>(scope);
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint) {
          throw new ApplicationError("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
        }

        // 1. Authoritative current snapshot & slots
        const currentSnapshot = await transaction.roleSlots.getSnapshot(command.projectId);
        if (currentSnapshot === undefined) {
          throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", "Authoritative role slot snapshot missing on receipt replay");
        }
        const currentSlots = await transaction.roleSlots.listByProject(command.projectId);

        // 2. Independently load durable audit
        const auditRow = this.#database.prepare(
          "SELECT * FROM project_role_slot_audits WHERE tenant_id = ? AND id = ?",
        ).get(command.tenantId, previous.result.audit.id) as Record<string, unknown> | undefined;
        if (!auditRow) {
          throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", "Durable role slot audit missing on receipt replay");
        }
        const durableAudit = roleSlotAuditFromRow(auditRow, { tenantId: command.tenantId, projectId: command.projectId });

        // 3. Independently load durable event
        const eventRow = this.#database.prepare(
          "SELECT * FROM domain_events WHERE tenant_id = ? AND event_id = ?",
        ).get(command.tenantId, previous.result.event.eventId) as Record<string, unknown> | undefined;
        if (!eventRow) {
          throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", "Durable domain event missing on receipt replay");
        }
        const durableEvent = domainEventFromRow<RoleSlotsInitializedPayload>(eventRow, "ROLE_SLOT_RECORD_CORRUPT");

        // 4. Independently load durable outbox
        const outboxRow = this.#database.prepare(
          "SELECT * FROM outbox_messages WHERE tenant_id = ? AND message_id = ?",
        ).get(command.tenantId, previous.result.outbox.id) as Record<string, unknown> | undefined;
        if (!outboxRow) {
          throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", "Durable outbox message missing on receipt replay");
        }
        const durableOutbox = outboxFromRow(outboxRow);

        // 5. Canonical validation of receipt-embedded records and full cross-record coherence
        assertCoherentRoleSlotsInitializationRecords({
          tenantId: command.tenantId,
          projectId: command.projectId,
          sourceTemplateVersionId: command.sourceTemplateVersionId,
          snapshot: previous.result.snapshot,
          slots: previous.result.slots,
          audit: previous.result.audit,
          event: previous.result.event,
          outbox: previous.result.outbox,
        });

        // 6. Full cross-record coherence validator on durable records
        assertCoherentRoleSlotsInitializationRecords({
          tenantId: command.tenantId,
          projectId: command.projectId,
          sourceTemplateVersionId: command.sourceTemplateVersionId,
          snapshot: currentSnapshot,
          slots: currentSlots,
          audit: durableAudit,
          event: durableEvent,
          outbox: durableOutbox,
        });

        // 7. Ensure receipt matches durable records
        if (
          previous.result.snapshot.tenantId !== currentSnapshot.tenantId ||
          previous.result.snapshot.projectId !== currentSnapshot.projectId ||
          previous.result.snapshot.sourceTemplateVersionId !== currentSnapshot.sourceTemplateVersionId ||
          previous.result.snapshot.createdAtUtc !== currentSnapshot.createdAtUtc ||
          previous.result.snapshot.createdByPrincipalId !== currentSnapshot.createdByPrincipalId ||
          previous.result.slots.length !== currentSlots.length ||
          !previous.result.slots.every((ps, idx) => {
            const cs = currentSlots[idx]!;
            return (
              ps.tenantId === cs.tenantId &&
              ps.projectId === cs.projectId &&
              ps.slotKey === cs.slotKey &&
              ps.name === cs.name &&
              ps.description === cs.description &&
              ps.sourceTemplateVersionId === cs.sourceTemplateVersionId &&
              ps.createdAtUtc === cs.createdAtUtc
            );
          }) ||
          previous.result.audit.id !== durableAudit.id ||
          previous.result.audit.tenantId !== durableAudit.tenantId ||
          previous.result.audit.projectId !== durableAudit.projectId ||
          previous.result.audit.occurredAtUtc !== durableAudit.occurredAtUtc ||
          previous.result.audit.actorPrincipalId !== durableAudit.actorPrincipalId ||
          previous.result.audit.sourceTemplateVersionId !== durableAudit.sourceTemplateVersionId ||
          previous.result.audit.action !== durableAudit.action ||
          JSON.stringify(previous.result.audit.slotKeys) !== JSON.stringify(durableAudit.slotKeys) ||
          JSON.stringify(previous.result.event) !== JSON.stringify(durableEvent) ||
          previous.result.outbox.id !== durableOutbox.id ||
          previous.result.outbox.tenantId !== durableOutbox.tenantId ||
          previous.result.outbox.eventId !== durableOutbox.eventId ||
          previous.result.outbox.topic !== durableOutbox.topic ||
          previous.result.outbox.createdAtUtc !== durableOutbox.createdAtUtc ||
          JSON.stringify(previous.result.outbox.payload) !== JSON.stringify(durableEvent)
        ) {
          throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", "Receipt result diverges from durable records");
        }

        return { ...structuredClone(previous.result), replayed: true };
      }

      const existingSnapshot = await transaction.roleSlots.getSnapshot(command.projectId);
      if (existingSnapshot !== undefined) {
        if (command.sourceTemplateVersionId !== existingSnapshot.sourceTemplateVersionId) {
          throw new ApplicationError("ROLE_SLOT_TEMPLATE_VERSION_FROZEN", `Project ${command.projectId} role slots are frozen to template version ${existingSnapshot.sourceTemplateVersionId}`);
        }
        const existingSlots = await transaction.roleSlots.listByProject(command.projectId);
        if (!areRoleSlotsIdentical(existingSlots, command.slots)) {
          throw new ApplicationError("ROLE_SLOT_IMMUTABLE_CONFLICT", `Role slots for project ${command.projectId} are immutable and cannot be rewritten or extended`);
        }

        const existingAudits = await transaction.roleSlotAudits.listByProject(command.projectId);
        const audit = existingAudits.find(
          (a) => a.action === "initialized" && a.sourceTemplateVersionId === existingSnapshot.sourceTemplateVersionId,
        );
        if (audit === undefined) {
          throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", "Authoritative initialization audit missing");
        }

        const eventRow = this.#database.prepare(
          "SELECT * FROM domain_events WHERE tenant_id = ? AND aggregate_type = 'project_role_slots' AND aggregate_id = ? AND aggregate_version = 1",
        ).get(command.tenantId, command.projectId) as Record<string, unknown> | undefined;
        if (!eventRow) {
          throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", "Authoritative initialization event missing from domain_events");
        }
        const event = domainEventFromRow<RoleSlotsInitializedPayload>(eventRow, "ROLE_SLOT_RECORD_CORRUPT");

        const outboxRow = this.#database.prepare(
          "SELECT * FROM outbox_messages WHERE tenant_id = ? AND event_id = ?",
        ).get(command.tenantId, event.eventId) as Record<string, unknown> | undefined;
        if (!outboxRow) {
          throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", "Authoritative initialization outbox missing from outbox_messages");
        }
        const outbox = outboxFromRow(outboxRow);

        assertCoherentRoleSlotsInitializationRecords({
          tenantId: command.tenantId,
          projectId: command.projectId,
          sourceTemplateVersionId: command.sourceTemplateVersionId,
          snapshot: existingSnapshot,
          slots: existingSlots,
          audit,
          event,
          outbox,
        });

        const nowUtc = this.nowUtc();
        const result: InitializeProjectRoleSlotsResult = {
          snapshot: existingSnapshot,
          slots: existingSlots,
          event,
          outbox,
          audit,
          replayed: false,
        };
        await transaction.receipts.insert({
          scope,
          fingerprint,
          result: {
            snapshot: existingSnapshot,
            slots: existingSlots,
            event,
            outbox,
            audit,
          },
          createdAtUtc: nowUtc,
        });
        return result;
      }

      const nowUtc = this.nowUtc();
      const { snapshot, slots } = this.#mutateInitializeProjectRoleSlots(command, nowUtc);
      injectRoleSlotFailure(failurePoint, "after_state");

      const sortedSlotKeys = slots.map((s) => s.slotKey);
      const audit: ProjectRoleSlotAuditEntry = {
        tenantId: command.tenantId,
        id: `audit:${command.commandId}`,
        projectId: command.projectId,
        actorPrincipalId: command.principalId,
        sourceTemplateVersionId: command.sourceTemplateVersionId,
        action: "initialized",
        slotKeys: sortedSlotKeys,
        occurredAtUtc: nowUtc,
      };
      await transaction.roleSlotAudits.append(audit);
      injectRoleSlotFailure(failurePoint, "after_audit");

      const projectSequence = await transaction.sequences.next(command.projectId);
      const event: DomainEvent<RoleSlotsInitializedPayload> = {
        tenantId: command.tenantId,
        eventId: `evt:${command.commandId}`,
        projectId: command.projectId,
        projectSequence,
        aggregateType: "project_role_slots",
        aggregateId: command.projectId,
        aggregateVersion: 1,
        eventType: "project-map.role-slots.initialized",
        schemaVersion: 1,
        actorPrincipalId: command.principalId,
        occurredAtUtc: nowUtc,
        correlationId: command.correlationId ?? command.commandId,
        causationId: command.commandId,
        originalSecurityDomainId: null,
        originalSecurityEpoch: 0,
        payload: {
          projectId: command.projectId,
          sourceTemplateVersionId: command.sourceTemplateVersionId,
          slotKeys: sortedSlotKeys,
        },
      };
      validateEventAgainstSchema(event);
      await transaction.events.append(event);
      injectRoleSlotFailure(failurePoint, "after_event");

      const outbox: OutboxMessage = {
        tenantId: command.tenantId,
        id: `outbox:${event.eventId}`,
        eventId: event.eventId,
        topic: eventTopic(event),
        payload: event,
        state: "pending",
        availableAtUtc: nowUtc,
        attempts: 0,
        maxAttempts: 8,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAtUtc: null,
        lastError: null,
        publishedAtUtc: null,
        createdAtUtc: nowUtc,
      };
      await transaction.outbox.enqueue(outbox);
      injectRoleSlotFailure(failurePoint, "after_outbox");

      const result: InitializeProjectRoleSlotsResult = {
        snapshot,
        slots,
        event,
        outbox,
        audit,
        replayed: false,
      };
      await transaction.receipts.insert({
        scope,
        fingerprint,
        result: {
          snapshot,
          slots,
          event,
          outbox,
          audit,
        },
        createdAtUtc: nowUtc,
      });
      injectRoleSlotFailure(failurePoint, "after_idempotency");
      return result;
    });
  }


  readonly outboxConsumer: OutboxConsumer = {
    countReady: async (nowUtc) => this.countReady("outbox_messages", nowUtc),
    claim: async (options) => await this.claimOutbox(options),
    markPublished: async (tenantId, messageId, leaseToken, publishedAtUtc) => await this.completeQueue(
      "outbox_messages", tenantId, messageId, leaseToken, "published", "published_at_utc", publishedAtUtc,
    ),
    release: async (tenantId, messageId, leaseToken, nextAttemptAtUtc, error) => await this.releaseQueue(
      "outbox_messages", tenantId, messageId, leaseToken, nextAttemptAtUtc, error,
    ),
  };

  readonly jobConsumer: JobConsumer = {
    countReady: async (nowUtc) => this.countReady("background_jobs", nowUtc),
    claim: async (options) => await this.claimJobs(options),
    markCompleted: async (tenantId, jobId, leaseToken, completedAtUtc) => await this.completeQueue(
      "background_jobs", tenantId, jobId, leaseToken, "completed", "completed_at_utc", completedAtUtc,
    ),
    release: async (tenantId, jobId, leaseToken, nextAttemptAtUtc, error) => await this.releaseQueue(
      "background_jobs", tenantId, jobId, leaseToken, nextAttemptAtUtc, error,
    ),
    defer: async (tenantId, jobId, leaseToken, availableAtUtc) => await this.deferJob(
      tenantId, jobId, leaseToken, availableAtUtc,
    ),
    markDeadLetter: async (tenantId, jobId, leaseToken, error) => await this.markJobDeadLetter(
      tenantId, jobId, leaseToken, error,
    ),
  };

  async transaction<T>(tenantId: TenantId, work: (transaction: TransactionContext) => Promise<T>): Promise<T> {
    return await this.exclusive(async () => {
      this.ensureOpen();
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        this.ensureTenant(tenantId);
        const result = await work(this.context(tenantId));
        this.#database.exec("COMMIT");
        return result;
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw translateConstraint(error);
      }
    });
  }

  async read<T>(tenantId: TenantId, work: (transaction: TransactionContext) => Promise<T>): Promise<T> {
    return await this.exclusive(async () => {
      this.ensureOpen();
      this.#database.exec("BEGIN DEFERRED");
      try {
        const result = await work(this.context(tenantId));
        this.#database.exec("ROLLBACK");
        return result;
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    await this.exclusive(async () => {
      if (!this.#closed) {
        this.#closed = true;
        this.#database.close();
      }
    });
  }

  async #issueReadinessChallenge(
    tenantId: TenantId,
    params: InternalIssueChallengeParams,
  ): Promise<SecurityMigrationReadinessEvidenceRecord> {
    return await this.transaction(tenantId, async () => {
      const row = this.#database.prepare(`
        SELECT * FROM security_domain_migrations WHERE tenant_id = ? AND migration_id = ?
      `).get(tenantId, params.migrationId);
      if (row === undefined) throw new Error("SECURITY_MIGRATION_NOT_FOUND");
      const migration = securityMigrationFromRow(row);
      if (params.purpose !== "commit" && params.purpose !== "rollback") {
        throw new Error("VALIDATION_FAILED");
      }
      if (params.purpose === "commit" && migration.state !== "verifying") {
        throw new Error("SECURITY_MIGRATION_COMMIT_INVALID");
      }
      if (params.purpose === "rollback" && !["planned", "active", "verifying", "retryable", "recovery_required"].includes(migration.state)) {
        throw new Error("SECURITY_MIGRATION_ROLLBACK_INVALID");
      }
      const snapshotRow = this.#database.prepare(`
        SELECT * FROM security_migration_manifest_snapshots
        WHERE tenant_id = ? AND migration_id = ?
      `).get(tenantId, params.migrationId) as Record<string, unknown> | undefined;
      if (snapshotRow === undefined) {
        throw new Error("SECURITY_MIGRATION_MANIFEST_SNAPSHOT_NOT_FOUND");
      }
      const snapshot = manifestSnapshotFromRow(snapshotRow, this.#database);

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

      this.#database.prepare(`
        INSERT INTO security_migration_readiness_evidence (
          tenant_id, evidence_id, migration_id, purpose, nonce, status,
          manifest_digest, item_count, source_security_domain_id, target_security_domain_id,
          source_security_epoch, target_security_epoch, issued_at_utc, expires_at_utc,
          verified_at_utc, consumed_at_utc, verifier_provider, channels_json, converged, reason, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tenantId, record.evidenceId, record.migrationId, record.purpose, record.nonce, record.status,
        record.manifestDigest, record.itemCount, record.sourceSecurityDomainId, record.targetSecurityDomainId,
        record.sourceSecurityEpoch, record.targetSecurityEpoch, record.issuedAtUtc, record.expiresAtUtc,
        null, null, null, null, 0, null, JSON.stringify(record),
      );

      return record;
    });
  }

  async #recordVerifiedEvidence(
    tenantId: TenantId,
    params: InternalRecordVerifiedEvidenceParams,
  ): Promise<SecurityMigrationReadinessEvidenceRecord> {
    return await this.transaction(tenantId, async () => {
      const row = this.#database.prepare(`
        SELECT * FROM security_migration_readiness_evidence WHERE tenant_id = ? AND evidence_id = ?
      `).get(tenantId, params.evidenceId) as Record<string, unknown> | undefined;
      if (row === undefined) throw new Error("SECURITY_MIGRATION_EVIDENCE_NOT_FOUND");
      const existing = readinessEvidenceFromRow(row);
      if (existing.status !== "issued") {
        throw new Error("SECURITY_MIGRATION_EVIDENCE_ALREADY_VERIFIED");
      }
      const nowUtc = this.nowUtc();
      if (nowUtc > existing.expiresAtUtc) {
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
        verifiedAtUtc: nowUtc,
        reason: params.reason ?? null,
      };

      const updateResult = this.#database.prepare(`
        UPDATE security_migration_readiness_evidence
        SET status = ?, verified_at_utc = ?, verifier_provider = ?,
            channels_json = ?, converged = ?, reason = ?, evidence_json = ?
        WHERE tenant_id = ? AND evidence_id = ? AND status = 'issued'
      `).run(
        updated.status, updated.verifiedAtUtc, updated.provider ?? null,
        JSON.stringify(updated.channels), updated.converged ? 1 : 0, updated.reason ?? null, JSON.stringify(updated),
        tenantId, params.evidenceId,
      );
      if (updateResult.changes !== 1) {
        throw new Error("SECURITY_MIGRATION_EVIDENCE_ALREADY_VERIFIED");
      }

      return updated;
    });
  }

  async listEvents(tenantId: TenantId): Promise<DomainEvent[]> {
    return await this.exclusive(async () => this.#database.prepare(
        "SELECT event_json FROM domain_events WHERE tenant_id = ? ORDER BY project_id, project_sequence",
      ).all(tenantId).map((row) => parseJson<DomainEvent>(asString(row.event_json))));
  }

  async listOutbox(tenantId: TenantId): Promise<OutboxMessage[]> {
    return await this.exclusive(async () => this.#database.prepare(
        "SELECT * FROM outbox_messages WHERE tenant_id = ? ORDER BY created_at_utc, message_id",
      ).all(tenantId).map(outboxFromRow));
  }

  async listJobs(tenantId: TenantId): Promise<BackgroundJob[]> {
    return await this.exclusive(async () => this.#database.prepare(
        "SELECT * FROM background_jobs WHERE tenant_id = ? ORDER BY created_at_utc, job_id",
      ).all(tenantId).map(jobFromRow));
  }

  private context(tenantId: TenantId): TransactionContext {
    const context: TransactionContext = {
      tenantId,
      nodes: {
        get: async (nodeId) => {
          const row = this.#database.prepare("SELECT * FROM project_nodes WHERE tenant_id = ? AND node_id = ?").get(tenantId, nodeId);
          return row === undefined ? undefined : nodeFromRow(row);
        },
        listByProject: async (projectId) => this.#database.prepare(
          "SELECT * FROM project_nodes WHERE tenant_id = ? AND project_id = ? ORDER BY node_id",
        ).all(tenantId, projectId).map(nodeFromRow),
        listForSecurityMigration: async () => this.#database.prepare(
          "SELECT * FROM project_nodes WHERE tenant_id = ? ORDER BY node_id",
        ).all(tenantId).map(nodeFromRow),
        hasSecurityDomainReference: async (securityDomainId) => this.#database.prepare(`
          SELECT 1 FROM project_nodes
          WHERE tenant_id = ? AND security_domain_id = ?
          LIMIT 1
        `).get(tenantId, securityDomainId) !== undefined,
        insert: async (node) => {
          if (node.tenantId !== tenantId) throw new Error("TENANT_CONTEXT_MISMATCH");
          const activeMigration = this.#database.prepare(`
            SELECT 1 FROM security_domain_migrations
            WHERE tenant_id = ? AND project_id = ? AND state IN ('active', 'verifying', 'retryable', 'recovery_required')
            LIMIT 1
          `).get(tenantId, node.projectId);
          if (activeMigration !== undefined) throw new Error("SECURITY_MIGRATION_IN_PROGRESS");
          if (node.leaderPrincipalId !== null) {
            throw new ApplicationError("NODE_LEADER_DIRECT_INSERT_FORBIDDEN", "Direct insert of node with non-null leader is forbidden; use createNode command");
          }
          this.#database.prepare(`
            INSERT INTO project_nodes (
              tenant_id, node_id, project_id, parent_node_id, leader_principal_id, title, kind,
              security_domain_id, security_epoch, version, deleted_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            tenantId, node.id, node.projectId, node.parentId, node.leaderPrincipalId ?? null, node.title, node.kind,
            node.securityDomainId, node.securityEpoch, node.version, node.deletedAtUtc,
          );
        },
        assignSecurityDomain: async (nodeId, projectId, securityDomainId, expectedVersion) => {
          const domainRow = this.#database.prepare(`
            SELECT domain_json FROM security_domains
            WHERE tenant_id = ? AND security_domain_id = ? AND project_id = ? AND root_node_id = ?
          `).get(tenantId, securityDomainId, projectId, nodeId);
          if (domainRow === undefined) throw new Error("SECURITY_DOMAIN_ROOT_MISMATCH");
          const domain = parseJson<SecurityDomain>(asString(domainRow.domain_json));
          const firstAdministrator = this.#database.prepare(`
            SELECT capability, status, expires_at_utc FROM security_grants
            WHERE tenant_id = ? AND security_domain_id = ? AND principal_id = ?
          `).get(tenantId, securityDomainId, domain.createdByPrincipalId);
          if (firstAdministrator === undefined
            || firstAdministrator.capability !== "manage_access"
            || firstAdministrator.status !== "active"
            || firstAdministrator.expires_at_utc !== null) {
            throw new Error("SECURITY_DOMAIN_FIRST_ADMIN_REQUIRED");
          }
          const result = this.#database.prepare(`
            UPDATE project_nodes
            SET security_domain_id = ?, security_epoch = security_epoch + 1, version = version + 1
            WHERE tenant_id = ? AND node_id = ? AND project_id = ? AND version = ? AND security_domain_id IS NULL
          `).run(
            securityDomainId, tenantId, nodeId, projectId, expectedVersion,
          );
          if (result.changes !== 1) throw new Error("NODE_VERSION_CONFLICT");
          const row = this.#database.prepare(
            "SELECT * FROM project_nodes WHERE tenant_id = ? AND node_id = ?",
          ).get(tenantId, nodeId);
          if (row === undefined) throw new Error("NODE_NOT_FOUND");
          return nodeFromRow(row);
        },
        migrateSecurityOwnership: async (migrationId, nodeId, expectedVersion) => {
          const migration = this.migrationForObjectWrite(tenantId, migrationId);
          const row = this.#database.prepare(
            "SELECT * FROM project_nodes WHERE tenant_id = ? AND node_id = ?",
          ).get(tenantId, nodeId);
          if (row === undefined) throw new Error("NODE_NOT_FOUND");
          const current = nodeFromRow(row);
          if (current.version !== expectedVersion) throw new Error("NODE_VERSION_CONFLICT");
          this.assertMigrationScope(tenantId, migration, current.id);
          if (current.securityDomainId !== migration.sourceSecurityDomainId
            || current.securityEpoch !== migration.sourceSecurityEpoch) {
            throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
          }
          const result = this.#database.prepare(`
            UPDATE project_nodes
            SET security_domain_id = ?, security_epoch = ?, version = version + 1
            WHERE tenant_id = ? AND node_id = ? AND project_id = ? AND version = ?
              AND security_domain_id IS ? AND security_epoch = ?
          `).run(
            migration.targetSecurityDomainId, migration.targetSecurityEpoch, tenantId, nodeId,
            migration.projectId, expectedVersion, migration.sourceSecurityDomainId, migration.sourceSecurityEpoch,
          );
          if (result.changes !== 1) throw new Error("NODE_VERSION_CONFLICT");
          const updated = this.#database.prepare(
            "SELECT * FROM project_nodes WHERE tenant_id = ? AND node_id = ?",
          ).get(tenantId, nodeId);
          if (updated === undefined) throw new Error("NODE_NOT_FOUND");
          return nodeFromRow(updated);
        },
        rollbackSecurityOwnership: async (migrationId, nodeId, expectedVersion) => {
          const migration = this.migrationForObjectRollback(tenantId, migrationId);
          const row = this.#database.prepare(
            "SELECT * FROM project_nodes WHERE tenant_id = ? AND node_id = ?",
          ).get(tenantId, nodeId);
          if (row === undefined) throw new Error("NODE_NOT_FOUND");
          const current = nodeFromRow(row);
          if (current.version !== expectedVersion) throw new Error("NODE_VERSION_CONFLICT");
          this.assertMigrationScope(tenantId, migration, current.id);
          if (current.projectId !== migration.projectId
            || current.securityDomainId !== migration.targetSecurityDomainId
            || current.securityEpoch !== migration.targetSecurityEpoch) {
            throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
          }
          const result = this.#database.prepare(`
            UPDATE project_nodes
            SET security_domain_id = ?, security_epoch = ?, version = version + 1
            WHERE tenant_id = ? AND node_id = ? AND project_id = ? AND version = ?
              AND security_domain_id IS ? AND security_epoch = ?
          `).run(
            migration.sourceSecurityDomainId, migration.sourceSecurityEpoch, tenantId, nodeId,
            migration.projectId, expectedVersion, migration.targetSecurityDomainId, migration.targetSecurityEpoch,
          );
          if (result.changes !== 1) throw new Error("NODE_VERSION_CONFLICT");
          const updated = this.#database.prepare(
            "SELECT * FROM project_nodes WHERE tenant_id = ? AND node_id = ?",
          ).get(tenantId, nodeId);
          if (updated === undefined) throw new Error("NODE_NOT_FOUND");
          return nodeFromRow(updated);
        },
      },
      tasks: {
        get: async (taskId) => {
          const row = this.#database.prepare("SELECT task_json FROM product_tasks WHERE tenant_id = ? AND task_id = ?").get(tenantId, taskId);
          return row === undefined ? undefined : productTaskFromJson(asString(row.task_json));
        },
        listByNode: async (nodeId) => this.#database.prepare(`
          SELECT task_json FROM product_tasks
          WHERE tenant_id = ? AND owner_node_id = ?
          ORDER BY task_id
        `).all(tenantId, nodeId).map((row) => productTaskFromJson(asString(row.task_json))),
        listForSecurityMigration: async () => this.#database.prepare(`
          SELECT * FROM product_tasks WHERE tenant_id = ? ORDER BY task_id
        `).all(tenantId).map((row) => productTaskFromRow(row)),
        hasSecurityDomainReference: async (securityDomainId) => this.#database.prepare(`
          SELECT task_json FROM product_tasks WHERE tenant_id = ?
        `).all(tenantId).some((row) => {
          const task = productTaskFromJson(asString(row.task_json));
          return task.securityDomainId === securityDomainId;
        }),
        insert: async (task) => {
          assertTenant(tenantId, task.tenantId);
          this.#database.prepare(`
            INSERT INTO product_tasks (tenant_id, task_id, project_id, owner_node_id, lifecycle_state, version, task_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(tenantId, task.id, task.projectId, task.ownerNodeId, task.executionState, task.version, JSON.stringify(task));
        },
        savePreservingSecurityOwnership: async (taskId, task, expectedVersion) => {
          const currentRow = this.#database.prepare(`
            SELECT tenant_id, task_id, project_id, owner_node_id, version, task_json
            FROM product_tasks WHERE tenant_id = ? AND task_id = ?
          `).get(tenantId, taskId);
          if (currentRow === undefined) throw new Error("TASK_NOT_FOUND");
          const current = productTaskFromJson(asString(currentRow.task_json));
          if (current.tenantId !== asString(currentRow.tenant_id) || current.id !== asString(currentRow.task_id)
            || current.projectId !== asString(currentRow.project_id) || current.ownerNodeId !== asString(currentRow.owner_node_id)) {
            throw new Error("TASK_SECURITY_OWNERSHIP_IMMUTABLE");
          }
          if (current.version !== asNumber(currentRow.version) || current.version !== expectedVersion
            || task.version !== expectedVersion + 1) {
            throw new Error("TASK_VERSION_CONFLICT");
          }
          if (task.tenantId !== tenantId || task.id !== taskId
            || task.projectId !== current.projectId || task.ownerNodeId !== current.ownerNodeId
            || task.securityDomainId !== current.securityDomainId || task.securityEpoch !== current.securityEpoch) {
            throw new Error("TASK_SECURITY_OWNERSHIP_IMMUTABLE");
          }
          const result = this.#database.prepare(`
            UPDATE product_tasks
            SET lifecycle_state = ?, version = ?, task_json = ?
            WHERE tenant_id = ? AND task_id = ? AND version = ?
          `).run(task.executionState, task.version, JSON.stringify(task), tenantId, taskId, expectedVersion);
          if (result.changes !== 1) throw new Error("TASK_VERSION_CONFLICT");
        },
        migrateSecurityOwnership: async (migrationId, taskId, expectedVersion) => {
          const migration = this.migrationForObjectWrite(tenantId, migrationId);
          const row = this.#database.prepare(
            "SELECT * FROM product_tasks WHERE tenant_id = ? AND task_id = ?",
          ).get(tenantId, taskId);
          if (row === undefined) throw new Error("TASK_NOT_FOUND");
          const current = productTaskFromRow(row);
          if (current.version !== expectedVersion) throw new Error("TASK_VERSION_CONFLICT");
          this.assertMigrationScope(tenantId, migration, current.ownerNodeId);
          if (current.projectId !== migration.projectId || current.securityDomainId !== migration.sourceSecurityDomainId
            || current.securityEpoch !== migration.sourceSecurityEpoch) {
            throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
          }
          const updated = { ...current, securityDomainId: migration.targetSecurityDomainId,
            securityEpoch: migration.targetSecurityEpoch, version: current.version + 1 };
          const result = this.#database.prepare(`
            UPDATE product_tasks SET version = ?, task_json = ?
            WHERE tenant_id = ? AND task_id = ? AND project_id = ? AND owner_node_id = ? AND version = ?
          `).run(
            updated.version, JSON.stringify(updated), tenantId, taskId, migration.projectId,
            current.ownerNodeId, expectedVersion,
          );
          if (result.changes !== 1) throw new Error("TASK_VERSION_CONFLICT");
          return updated;
        },
        rollbackSecurityOwnership: async (migrationId, taskId, expectedVersion) => {
          const migration = this.migrationForObjectRollback(tenantId, migrationId);
          const row = this.#database.prepare(
            "SELECT * FROM product_tasks WHERE tenant_id = ? AND task_id = ?",
          ).get(tenantId, taskId);
          if (row === undefined) throw new Error("TASK_NOT_FOUND");
          const current = productTaskFromRow(row);
          if (current.version !== expectedVersion) throw new Error("TASK_VERSION_CONFLICT");
          this.assertMigrationScope(tenantId, migration, current.ownerNodeId);
          if (current.projectId !== migration.projectId || current.securityDomainId !== migration.targetSecurityDomainId
            || current.securityEpoch !== migration.targetSecurityEpoch) {
            throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
          }
          const updated = { ...current, securityDomainId: migration.sourceSecurityDomainId,
            securityEpoch: migration.sourceSecurityEpoch, version: current.version + 1 };
          const result = this.#database.prepare(`
            UPDATE product_tasks SET version = ?, task_json = ?
            WHERE tenant_id = ? AND task_id = ? AND project_id = ? AND owner_node_id = ? AND version = ?
          `).run(
            updated.version, JSON.stringify(updated), tenantId, taskId, migration.projectId,
            current.ownerNodeId, expectedVersion,
          );
          if (result.changes !== 1) throw new Error("TASK_VERSION_CONFLICT");
          return updated;
        },
        appendReviewAction: async (action) => {
          assertTenant(tenantId, action.tenantId);
          this.#database.prepare(`
            INSERT INTO task_review_actions (tenant_id, task_id, cycle, action, occurred_at_utc, action_json)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(tenantId, action.taskId, action.cycleNumber, action.action, action.occurredAtUtc, JSON.stringify(action));
        },
        listReviewActions: async (taskId) => this.#database.prepare(`
          SELECT action_json FROM task_review_actions
          WHERE tenant_id = ? AND task_id = ?
          ORDER BY cycle, CASE action WHEN 'submitted' THEN 0 ELSE 1 END
        `).all(tenantId, taskId).map((row) => reviewActionFromJson(asString(row.action_json))),
      },
      assets: {
        get: async (assetId) => {
          const row = this.#database.prepare("SELECT asset_json FROM assets WHERE tenant_id = ? AND asset_id = ?").get(tenantId, assetId);
          return row === undefined ? undefined : parseJson<Asset>(asString(row.asset_json));
        },
        hasForNode: async (nodeId) => this.#database.prepare(`
          SELECT asset_json FROM assets WHERE tenant_id = ? AND owner_node_id = ?
        `).get(tenantId, nodeId) !== undefined,
        listForSecurityMigration: async () => this.#database.prepare(`
          SELECT * FROM assets WHERE tenant_id = ? ORDER BY asset_id
        `).all(tenantId).map((row) => assetFromRow(row)),
        hasSecurityDomainReference: async (securityDomainId) => this.#database.prepare(`
          SELECT asset_json FROM assets WHERE tenant_id = ?
        `).all(tenantId).some((row) => {
          const asset = parseJson<Asset>(asString(row.asset_json));
          return asset.securityDomainId === securityDomainId;
        }),
        insert: async (asset) => {
          assertTenant(tenantId, asset.tenantId);
          this.#database.prepare(`
            INSERT INTO assets (tenant_id, asset_id, project_id, owner_node_id, lifecycle_state, version, asset_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(tenantId, asset.id, asset.projectId, asset.ownerNodeId, asset.lifecycleState, asset.version, JSON.stringify(asset));
        },
        savePreservingSecurityOwnership: async (assetId, asset, expectedVersion) => {
          const currentRow = this.#database.prepare(`
            SELECT tenant_id, asset_id, project_id, owner_node_id, version, asset_json
            FROM assets WHERE tenant_id = ? AND asset_id = ?
          `).get(tenantId, assetId);
          if (currentRow === undefined) throw new Error("ASSET_NOT_FOUND");
          const current = parseJson<Asset>(asString(currentRow.asset_json));
          if (current.tenantId !== asString(currentRow.tenant_id) || current.id !== asString(currentRow.asset_id)
            || current.projectId !== asString(currentRow.project_id) || current.ownerNodeId !== asString(currentRow.owner_node_id)) {
            throw new Error("ASSET_SECURITY_OWNERSHIP_IMMUTABLE");
          }
          if (current.version !== asNumber(currentRow.version) || current.version !== expectedVersion
            || asset.version !== expectedVersion + 1) {
            throw new Error("ASSET_VERSION_CONFLICT");
          }
          if (asset.tenantId !== tenantId || asset.id !== assetId
            || asset.projectId !== current.projectId || asset.ownerNodeId !== current.ownerNodeId
            || asset.securityDomainId !== current.securityDomainId || asset.securityEpoch !== current.securityEpoch
            || asset.uploaderPrincipalId !== current.uploaderPrincipalId) {
            throw new Error("ASSET_SECURITY_OWNERSHIP_IMMUTABLE");
          }
          const result = this.#database.prepare(`
            UPDATE assets
            SET lifecycle_state = ?, version = ?, asset_json = ?
            WHERE tenant_id = ? AND asset_id = ? AND version = ?
          `).run(asset.lifecycleState, asset.version, JSON.stringify(asset), tenantId, assetId, expectedVersion);
          if (result.changes !== 1) throw new Error("ASSET_VERSION_CONFLICT");
        },
        migrateSecurityOwnership: async (migrationId, assetId, expectedVersion) => {
          const migration = this.migrationForObjectWrite(tenantId, migrationId);
          const row = this.#database.prepare(
            "SELECT * FROM assets WHERE tenant_id = ? AND asset_id = ?",
          ).get(tenantId, assetId);
          if (row === undefined) throw new Error("ASSET_NOT_FOUND");
          const current = assetFromRow(row);
          if (current.version !== expectedVersion) throw new Error("ASSET_VERSION_CONFLICT");
          this.assertMigrationScope(tenantId, migration, current.ownerNodeId);
          if (current.projectId !== migration.projectId || current.securityDomainId !== migration.sourceSecurityDomainId
            || current.securityEpoch !== migration.sourceSecurityEpoch) {
            throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
          }
          const updated = { ...current, securityDomainId: migration.targetSecurityDomainId,
            securityEpoch: migration.targetSecurityEpoch, version: current.version + 1 };
          const result = this.#database.prepare(`
            UPDATE assets SET version = ?, asset_json = ?
            WHERE tenant_id = ? AND asset_id = ? AND project_id = ? AND owner_node_id = ? AND version = ?
          `).run(
            updated.version, JSON.stringify(updated), tenantId, assetId, migration.projectId,
            current.ownerNodeId, expectedVersion,
          );
          if (result.changes !== 1) throw new Error("ASSET_VERSION_CONFLICT");
          return updated;
        },
        rollbackSecurityOwnership: async (migrationId, assetId, expectedVersion) => {
          const migration = this.migrationForObjectRollback(tenantId, migrationId);
          const row = this.#database.prepare(
            "SELECT * FROM assets WHERE tenant_id = ? AND asset_id = ?",
          ).get(tenantId, assetId);
          if (row === undefined) throw new Error("ASSET_NOT_FOUND");
          const current = assetFromRow(row);
          if (current.version !== expectedVersion) throw new Error("ASSET_VERSION_CONFLICT");
          this.assertMigrationScope(tenantId, migration, current.ownerNodeId);
          if (current.projectId !== migration.projectId || current.securityDomainId !== migration.targetSecurityDomainId
            || current.securityEpoch !== migration.targetSecurityEpoch) {
            throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
          }
          const updated = { ...current, securityDomainId: migration.sourceSecurityDomainId,
            securityEpoch: migration.sourceSecurityEpoch, version: current.version + 1 };
          const result = this.#database.prepare(`
            UPDATE assets SET version = ?, asset_json = ?
            WHERE tenant_id = ? AND asset_id = ? AND project_id = ? AND owner_node_id = ? AND version = ?
          `).run(
            updated.version, JSON.stringify(updated), tenantId, assetId, migration.projectId,
            current.ownerNodeId, expectedVersion,
          );
          if (result.changes !== 1) throw new Error("ASSET_VERSION_CONFLICT");
          return updated;
        },
        insertBinding: async (binding) => {
          assertTenant(tenantId, binding.tenantId);
          this.#database.prepare(`
            INSERT INTO asset_bindings (tenant_id, binding_id, asset_id, target_type, target_id, binding_json)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(tenantId, binding.id, binding.assetId, binding.targetType, binding.targetId, JSON.stringify(binding));
        },
        listBindings: async (targetType, targetId) => this.#database.prepare(`
          SELECT binding_json FROM asset_bindings
          WHERE tenant_id = ? AND target_type = ? AND target_id = ?
          ORDER BY binding_id
        `).all(tenantId, targetType, targetId).map((row) => parseJson<AssetBinding>(asString(row.binding_json))),
      },
      deliverables: {
        get: async (deliverableId) => {
          const row = this.#database.prepare(
            "SELECT * FROM deliverable_requirements WHERE tenant_id = ? AND deliverable_id = ?",
          ).get(tenantId, deliverableId) as Record<string, unknown> | undefined;
          return row === undefined ? undefined : deliverableRequirementFromRow(row);
        },
        getByKey: async (projectId, ownerNodeId, requirementKey) => {
          const row = this.#database.prepare(
            "SELECT * FROM deliverable_requirements WHERE tenant_id = ? AND project_id = ? AND owner_node_id = ? AND requirement_key = ?",
          ).get(tenantId, projectId, ownerNodeId, requirementKey) as Record<string, unknown> | undefined;
          return row === undefined ? undefined : deliverableRequirementFromRow(row);
        },
        listByNode: async (nodeId) => {
          const rows = this.#database.prepare(
            "SELECT * FROM deliverable_requirements WHERE tenant_id = ? AND owner_node_id = ? ORDER BY requirement_key ASC",
          ).all(tenantId, nodeId) as Record<string, unknown>[];
          return rows.map(deliverableRequirementFromRow);
        },
        listByProject: async (projectId) => {
          const rows = this.#database.prepare(
            "SELECT * FROM deliverable_requirements WHERE tenant_id = ? AND project_id = ? ORDER BY owner_node_id ASC, requirement_key ASC",
          ).all(tenantId, projectId) as Record<string, unknown>[];
          return rows.map(deliverableRequirementFromRow);
        },
        listForSecurityMigration: async () => {
          const rows = this.#database.prepare(
            "SELECT * FROM deliverable_requirements WHERE tenant_id = ? ORDER BY deliverable_id ASC",
          ).all(tenantId) as Record<string, unknown>[];
          return rows.map(deliverableRequirementFromRow);
        },
        hasSecurityDomainReference: async (securityDomainId) => {
          const row = this.#database.prepare(
            "SELECT 1 FROM deliverable_requirements WHERE tenant_id = ? AND security_domain_id = ? LIMIT 1",
          ).get(tenantId, securityDomainId);
          return row !== undefined;
        },
        insert: async (requirement) => {
          assertTenant(tenantId, requirement.tenantId);
          assertCanonicalDeliverableRequirement(requirement, { tenantId });
          const existingKey = this.#database.prepare(
            "SELECT 1 FROM deliverable_requirements WHERE tenant_id = ? AND project_id = ? AND owner_node_id = ? AND requirement_key = ?",
          ).get(tenantId, requirement.projectId, requirement.ownerNodeId, requirement.requirementKey);
          if (existingKey !== undefined) throw new Error("DELIVERABLE_ALREADY_EXISTS");
          const existingId = this.#database.prepare(
            "SELECT 1 FROM deliverable_requirements WHERE tenant_id = ? AND deliverable_id = ?",
          ).get(tenantId, requirement.id);
          if (existingId !== undefined) throw new Error("DELIVERABLE_ALREADY_EXISTS");

          this.#database.prepare(`
            INSERT INTO deliverable_requirements (
              tenant_id, deliverable_id, project_id, owner_node_id,
              security_domain_id, security_epoch, requirement_key,
              status, version, deliverable_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            tenantId,
            requirement.id,
            requirement.projectId,
            requirement.ownerNodeId,
            requirement.securityDomainId,
            requirement.securityEpoch,
            requirement.requirementKey,
            requirement.status,
            requirement.version,
            JSON.stringify(requirement),
          );
        },
        savePreservingSecurityOwnership: async (requirementId, requirement, expectedVersion) => {
          assertTenant(tenantId, requirement.tenantId);
          const row = this.#database.prepare(
            "SELECT * FROM deliverable_requirements WHERE tenant_id = ? AND deliverable_id = ?",
          ).get(tenantId, requirementId) as Record<string, unknown> | undefined;
          if (row === undefined) throw new Error("DELIVERABLE_NOT_FOUND");
          const current = deliverableRequirementFromRow(row);
          if (current.version !== expectedVersion || requirement.version !== expectedVersion + 1) {
            throw new Error("DELIVERABLE_VERSION_CONFLICT");
          }
          if (
            requirement.tenantId !== tenantId ||
            requirement.id !== requirementId ||
            requirement.projectId !== current.projectId ||
            requirement.ownerNodeId !== current.ownerNodeId ||
            requirement.requirementKey !== current.requirementKey ||
            requirement.securityDomainId !== current.securityDomainId ||
            requirement.securityEpoch !== current.securityEpoch
          ) {
            throw new Error("DELIVERABLE_SECURITY_OWNERSHIP_IMMUTABLE");
          }
          assertCanonicalDeliverableRequirement(requirement, { tenantId, id: requirementId });
          const result = this.#database.prepare(`
            UPDATE deliverable_requirements
            SET status = ?, version = ?, deliverable_json = ?
            WHERE tenant_id = ? AND deliverable_id = ? AND version = ?
          `).run(requirement.status, requirement.version, JSON.stringify(requirement), tenantId, requirementId, expectedVersion);
          if (result.changes !== 1) throw new Error("DELIVERABLE_VERSION_CONFLICT");
        },
        migrateSecurityOwnership: async (migrationId, requirementId, expectedVersion) => {
          const migration = this.migrationForObjectWrite(tenantId, migrationId);
          const row = this.#database.prepare(
            "SELECT * FROM deliverable_requirements WHERE tenant_id = ? AND deliverable_id = ?",
          ).get(tenantId, requirementId) as Record<string, unknown> | undefined;
          if (row === undefined) throw new Error("DELIVERABLE_NOT_FOUND");
          const current = deliverableRequirementFromRow(row);
          if (current.version !== expectedVersion) throw new Error("DELIVERABLE_VERSION_CONFLICT");
          this.assertMigrationScope(tenantId, migration, current.ownerNodeId);
          if (
            current.projectId !== migration.projectId ||
            current.securityDomainId !== migration.sourceSecurityDomainId ||
            current.securityEpoch !== migration.sourceSecurityEpoch
          ) {
            throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
          }
          const updated: DeliverableRequirement = {
            ...current,
            securityDomainId: migration.targetSecurityDomainId,
            securityEpoch: migration.targetSecurityEpoch,
            version: current.version + 1,
          };
          const result = this.#database.prepare(`
            UPDATE deliverable_requirements
            SET security_domain_id = ?, security_epoch = ?, version = ?, deliverable_json = ?
            WHERE tenant_id = ? AND deliverable_id = ? AND project_id = ? AND owner_node_id = ? AND version = ?
          `).run(
            updated.securityDomainId,
            updated.securityEpoch,
            updated.version,
            JSON.stringify(updated),
            tenantId,
            requirementId,
            migration.projectId,
            current.ownerNodeId,
            expectedVersion,
          );
          if (result.changes !== 1) throw new Error("DELIVERABLE_VERSION_CONFLICT");
          return updated;
        },
        rollbackSecurityOwnership: async (migrationId, requirementId, expectedVersion) => {
          const migration = this.migrationForObjectRollback(tenantId, migrationId);
          const row = this.#database.prepare(
            "SELECT * FROM deliverable_requirements WHERE tenant_id = ? AND deliverable_id = ?",
          ).get(tenantId, requirementId) as Record<string, unknown> | undefined;
          if (row === undefined) throw new Error("DELIVERABLE_NOT_FOUND");
          const current = deliverableRequirementFromRow(row);
          if (current.version !== expectedVersion) throw new Error("DELIVERABLE_VERSION_CONFLICT");
          this.assertMigrationScope(tenantId, migration, current.ownerNodeId);
          if (
            current.projectId !== migration.projectId ||
            current.securityDomainId !== migration.targetSecurityDomainId ||
            current.securityEpoch !== migration.targetSecurityEpoch
          ) {
            throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
          }
          const updated: DeliverableRequirement = {
            ...current,
            securityDomainId: migration.sourceSecurityDomainId,
            securityEpoch: migration.sourceSecurityEpoch,
            version: current.version + 1,
          };
          const result = this.#database.prepare(`
            UPDATE deliverable_requirements
            SET security_domain_id = ?, security_epoch = ?, version = ?, deliverable_json = ?
            WHERE tenant_id = ? AND deliverable_id = ? AND project_id = ? AND owner_node_id = ? AND version = ?
          `).run(
            updated.securityDomainId,
            updated.securityEpoch,
            updated.version,
            JSON.stringify(updated),
            tenantId,
            requirementId,
            migration.projectId,
            current.ownerNodeId,
            expectedVersion,
          );
          if (result.changes !== 1) throw new Error("DELIVERABLE_VERSION_CONFLICT");
          return updated;
        },
        appendEvidenceLink: async (link) => {
          assertTenant(tenantId, link.tenantId);
          assertCanonicalEvidenceLink(link, { tenantId });
          const existing = this.#database.prepare(`
            SELECT 1 FROM deliverable_evidence_links
            WHERE tenant_id = ? AND (
              link_id = ? OR (requirement_id = ? AND source_type = ? AND source_id = ?)
            )
          `).get(tenantId, link.id, link.requirementId, link.sourceType, link.sourceId);
          if (existing !== undefined) throw new Error("EVIDENCE_LINK_ALREADY_EXISTS");
          this.#database.prepare(`
            INSERT INTO deliverable_evidence_links (
              tenant_id, link_id, requirement_id, source_type, source_id,
              submitted_by_principal_id, linked_at_utc, version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            tenantId,
            link.id,
            link.requirementId,
            link.sourceType,
            link.sourceId,
            link.submittedByPrincipalId,
            link.linkedAtUtc,
            link.version,
          );
        },
        listEvidenceLinks: async (requirementId) => {
          const rows = this.#database.prepare(
            "SELECT * FROM deliverable_evidence_links WHERE tenant_id = ? AND requirement_id = ? ORDER BY linked_at_utc ASC, link_id ASC",
          ).all(tenantId, requirementId) as Record<string, unknown>[];
          return rows.map(evidenceLinkFromRow);
        },
        appendAction: async (action) => {
          assertTenant(tenantId, action.tenantId);
          assertCanonicalDeliverableActionRecord(action, { tenantId });
          const existing = this.#database.prepare(
            "SELECT 1 FROM deliverable_action_records WHERE tenant_id = ? AND action_id = ?",
          ).get(tenantId, action.id);
          if (existing !== undefined) throw new Error("DELIVERABLE_ACTION_ALREADY_EXISTS");
          this.#database.prepare(`
            INSERT INTO deliverable_action_records (
              tenant_id, action_id, requirement_id, action,
              actor_principal_id, occurred_at_utc, reason, evidence_count, evidence_ids_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            tenantId,
            action.id,
            action.requirementId,
            action.action,
            action.actorPrincipalId,
            action.occurredAtUtc,
            action.reason,
            action.evidenceCount,
            JSON.stringify(action.evidenceIds),
          );
        },
        listActions: async (requirementId) => {
          const rows = this.#database.prepare(
            "SELECT * FROM deliverable_action_records WHERE tenant_id = ? AND requirement_id = ? ORDER BY occurred_at_utc ASC, action_id ASC",
          ).all(tenantId, requirementId) as Record<string, unknown>[];
          return rows.map(deliverableActionFromRow);
        },
      },
      externalBindings: {
        getByOwner: async (ownerType, ownerId, role) => {
          const row = this.#database.prepare(`
            SELECT binding_json FROM external_bindings
            WHERE tenant_id = ? AND owner_type = ? AND owner_id = ? AND role = ?
          `).get(tenantId, ownerType, ownerId, role);
          return row === undefined ? undefined : parseJson<ExternalBinding>(asString(row.binding_json));
        },
        insert: async (binding) => {
          assertTenant(tenantId, binding.tenantId);
          this.#database.prepare(`
            INSERT INTO external_bindings (
              tenant_id, binding_id, owner_type, owner_id, role, provider, kind, external_id, schema_version, version, binding_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            tenantId, binding.id, binding.ownerType, binding.ownerId, binding.role,
            binding.reference.provider, binding.reference.kind, binding.reference.externalId,
            binding.reference.schemaVersion, binding.version, JSON.stringify(binding),
          );
        },
        update: async (binding, expectedVersion) => {
          assertTenant(tenantId, binding.tenantId);
          if (binding.version !== expectedVersion + 1) throw new Error("EXTERNAL_BINDING_VERSION_CONFLICT");
          const result = this.#database.prepare(`
            UPDATE external_bindings
            SET provider = ?, kind = ?, external_id = ?, schema_version = ?, version = ?, binding_json = ?
            WHERE tenant_id = ? AND binding_id = ? AND version = ?
          `).run(
            binding.reference.provider, binding.reference.kind, binding.reference.externalId,
            binding.reference.schemaVersion, binding.version, JSON.stringify(binding), tenantId, binding.id, expectedVersion,
          );
          if (result.changes !== 1) throw new Error("EXTERNAL_BINDING_VERSION_CONFLICT");
        },
      },
      integrationOperations: {
        get: async (operationId) => {
          const row = this.#database.prepare(`
            SELECT tenant_id, operation_id, operation_type, subject_type, subject_id, state, version, operation_json
            FROM integration_operations WHERE tenant_id = ? AND operation_id = ?
          `).get(tenantId, operationId);
          return row === undefined ? undefined : integrationOperationFromRow(row as Record<string, unknown>);
        },
        insert: async (operation) => {
          assertTenant(tenantId, operation.tenantId);
          this.#database.prepare(`
            INSERT INTO integration_operations (
              tenant_id, operation_id, operation_type, subject_type, subject_id, state, version, operation_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            tenantId, operation.id, operation.operationType, operation.subjectType, operation.subjectId,
            operation.state, operation.version, JSON.stringify(operation),
          );
        },
        update: async (operation, expectedVersion) => {
          assertTenant(tenantId, operation.tenantId);
          if (operation.version !== expectedVersion + 1) throw new Error("INTEGRATION_OPERATION_VERSION_CONFLICT");
          const result = this.#database.prepare(`
            UPDATE integration_operations
            SET state = ?, version = ?, operation_json = ?
            WHERE tenant_id = ? AND operation_id = ? AND version = ?
          `).run(operation.state, operation.version, JSON.stringify(operation), tenantId, operation.id, expectedVersion);
          if (result.changes !== 1) throw new Error("INTEGRATION_OPERATION_VERSION_CONFLICT");
        },
        appendStep: async (attempt) => {
          assertTenant(tenantId, attempt.tenantId);
          this.#database.prepare(`
            INSERT INTO integration_step_attempts (tenant_id, operation_id, sequence, attempt_json)
            VALUES (?, ?, ?, ?)
          `).run(tenantId, attempt.operationId, attempt.sequence, JSON.stringify(attempt));
        },
        listSteps: async (operationId) => this.#database.prepare(`
          SELECT attempt_json FROM integration_step_attempts
          WHERE tenant_id = ? AND operation_id = ? ORDER BY sequence
        `).all(tenantId, operationId).map((row) => parseJson<IntegrationStepAttempt>(asString(row.attempt_json))),
        listRecoverable: async () => this.#database.prepare(`
          SELECT tenant_id, operation_id, operation_type, subject_type, subject_id, state, version, operation_json
          FROM integration_operations
          WHERE tenant_id = ? AND state IN ('retryable', 'recovery_required')
          ORDER BY operation_id
        `).all(tenantId).map((row) => integrationOperationFromRow(row as Record<string, unknown>)),
      },
      outboundProjectionFences: {
        acquire: async (fence) => {
          assertTenant(tenantId, fence.tenantId);
          const current = this.#database.prepare(`
            SELECT token, expires_at_utc FROM outbound_projection_fences
            WHERE tenant_id = ? AND fence_id = ?
          `).get(tenantId, fence.id);
          if (current !== undefined) {
            if (asString(current.expires_at_utc) > fence.createdAtUtc) {
              return false;
            }
            const result = this.#database.prepare(`
              UPDATE outbound_projection_fences
              SET project_id = ?, owner_node_id = ?, token = ?, expires_at_utc = ?, created_at_utc = ?, fence_json = ?
              WHERE tenant_id = ? AND fence_id = ? AND expires_at_utc <= ?
            `).run(
              fence.projectId, fence.ownerNodeId, fence.token,
              fence.expiresAtUtc, fence.createdAtUtc, JSON.stringify(fence),
              tenantId, fence.id, fence.createdAtUtc,
            );
            return result.changes === 1;
          }
          try {
            this.#database.prepare(`
              INSERT INTO outbound_projection_fences (
                tenant_id, fence_id, project_id, owner_node_id, token, expires_at_utc, created_at_utc, fence_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              tenantId, fence.id, fence.projectId, fence.ownerNodeId, fence.token,
              fence.expiresAtUtc, fence.createdAtUtc, JSON.stringify(fence),
            );
            return true;
          } catch {
            return false;
          }
        },
        renew: async (fenceId, token, expiresAtUtc) => this.#database.prepare(`
          UPDATE outbound_projection_fences
          SET expires_at_utc = ?
          WHERE tenant_id = ? AND fence_id = ? AND token = ?
        `).run(expiresAtUtc, tenantId, fenceId, token).changes === 1,
        release: async (fenceId, token) => this.#database.prepare(`
          DELETE FROM outbound_projection_fences
          WHERE tenant_id = ? AND fence_id = ? AND token = ?
        `).run(tenantId, fenceId, token).changes === 1,
      },
      identities: {
        findExternal: async (provider, connectionId, externalTenantRef, externalSubjectRef) => {
          const row = this.#database.prepare(`
            SELECT mapping_json FROM external_identity_mappings
            WHERE tenant_id = ? AND provider = ? AND connection_id = ?
              AND external_tenant_ref = ? AND external_subject_ref = ?
          `).get(tenantId, provider, connectionId, externalTenantRef, externalSubjectRef);
          return row === undefined ? undefined : parseJson<ExternalIdentityMapping>(asString(row.mapping_json));
        },
        insertExternal: async (mapping) => {
          assertTenant(tenantId, mapping.tenantId);
          this.#database.prepare(`
            INSERT INTO external_identity_mappings (
              tenant_id, provider, connection_id, external_tenant_ref, external_subject_ref,
              principal_id, status, version, mapping_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            tenantId, mapping.provider, mapping.connectionId, mapping.externalTenantRef, mapping.externalSubjectRef,
            mapping.principalId, mapping.status, mapping.version, JSON.stringify(mapping),
          );
        },
        updateExternal: async (mapping, expectedVersion) => {
          assertTenant(tenantId, mapping.tenantId);
          if (mapping.version !== expectedVersion + 1) throw new Error("EXTERNAL_IDENTITY_VERSION_CONFLICT");
          const result = this.#database.prepare(`
            UPDATE external_identity_mappings
            SET principal_id = ?, status = ?, version = ?, mapping_json = ?
            WHERE tenant_id = ? AND provider = ? AND connection_id = ?
              AND external_tenant_ref = ? AND external_subject_ref = ? AND version = ?
          `).run(
            mapping.principalId, mapping.status, mapping.version, JSON.stringify(mapping), tenantId,
            mapping.provider, mapping.connectionId, mapping.externalTenantRef, mapping.externalSubjectRef, expectedVersion,
          );
          if (result.changes !== 1) throw new Error("EXTERNAL_IDENTITY_VERSION_CONFLICT");
        },
      },
      principals: {
        get: async (id) => {
          const row = this.#database.prepare(`
            SELECT * FROM principals WHERE tenant_id = ? AND principal_id = ?
          `).get(tenantId, id);
          return row === undefined ? undefined : principalFromRow(row);
        },
        insert: async (principal) => {
          assertTenant(tenantId, principal.tenantId);
          this.#database.prepare(`
            INSERT INTO principals (
              tenant_id, principal_id, kind, state, version, created_at_utc, updated_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            tenantId, principal.id, principal.kind, principal.status, principal.version,
            principal.createdAtUtc, principal.updatedAtUtc,
          );
        },
        update: async (principal, expectedVersion) => {
          assertTenant(tenantId, principal.tenantId);
          if (principal.version !== expectedVersion + 1) throw new Error("PRINCIPAL_VERSION_CONFLICT");
          const result = this.#database.prepare(`
            UPDATE principals SET kind = ?, state = ?, version = ?, updated_at_utc = ?
            WHERE tenant_id = ? AND principal_id = ? AND version = ?
          `).run(
            principal.kind, principal.status, principal.version, principal.updatedAtUtc,
            tenantId, principal.id, expectedVersion,
          );
          if (result.changes !== 1) throw new Error("PRINCIPAL_VERSION_CONFLICT");
        },
      },
      memberships: {
        get: async (projectId, principalId) => {
          const row = this.#database.prepare(`
            SELECT membership_json FROM project_memberships
            WHERE tenant_id = ? AND project_id = ? AND principal_id = ?
          `).get(tenantId, projectId, principalId);
          return row === undefined ? undefined : parseJson<ProjectMembership>(asString(row.membership_json));
        },
        insert: async (membership) => {
          assertTenant(tenantId, membership.tenantId);
          this.#database.prepare(`
            INSERT INTO project_memberships (
              tenant_id, project_id, principal_id, role, status, version, membership_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            tenantId, membership.projectId, membership.principalId, membership.role,
            membership.status, membership.version, JSON.stringify(membership),
          );
        },
        restrictWithSecurityDomains: async (membership, expectedVersion, evaluatedAtUtc) => {
          assertTenant(tenantId, membership.tenantId);
          if (!isCanonicalUtcTimestamp(evaluatedAtUtc)) throw new Error("VALIDATION_FAILED");
          const currentRow = this.#database.prepare(`
            SELECT membership_json FROM project_memberships
            WHERE tenant_id = ? AND project_id = ? AND principal_id = ?
          `).get(tenantId, membership.projectId, membership.principalId);
          const current = currentRow === undefined
            ? undefined
            : parseJson<ProjectMembership>(asString(currentRow.membership_json));
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
          const eligibleTarget = this.#database.prepare(`
            SELECT 1 FROM principals
            WHERE tenant_id = ? AND principal_id = ? AND state = 'active' AND kind = 'user'
          `).get(tenantId, membership.principalId);
          if (eligibleTarget === undefined) throw new Error("PROJECT_MEMBERSHIP_TARGET_INELIGIBLE");

          const affected = this.#database.prepare(`
            SELECT domain.domain_json, grant_row.grant_json
            FROM security_domains AS domain
            JOIN security_grants AS grant_row
              ON grant_row.tenant_id = domain.tenant_id
             AND grant_row.security_domain_id = domain.security_domain_id
            WHERE domain.tenant_id = ? AND domain.project_id = ?
              AND grant_row.principal_id = ?
            ORDER BY domain.security_domain_id
          `).all(tenantId, membership.projectId, membership.principalId)
            .map((row) => ({
              domain: parseJson<SecurityDomain>(asString(row.domain_json)),
              grant: parseJson<SecurityGrant>(asString(row.grant_json)),
            }))
            .filter(({ domain, grant }) => domain.deletedAtUtc === null && grantAllows(grant, "view", evaluatedAtUtc));
          if (affected.some(({ domain }) => domain.parentSecurityDomainId !== null)) {
            throw new Error("PROJECT_MEMBERSHIP_TRANSITION_INVALID");
          }
          for (const { domain, grant } of affected) {
            if (!isPermanentSecurityAdministrator(grant)) continue;
            const replacement = this.#database.prepare(`
              SELECT 1 FROM security_grants AS grant_row
              JOIN project_memberships AS membership
                ON membership.tenant_id = grant_row.tenant_id
               AND membership.project_id = ?
               AND membership.principal_id = grant_row.principal_id
               AND membership.status = 'active' AND membership.role = 'project_manager'
              JOIN principals AS principal
                ON principal.tenant_id = grant_row.tenant_id
               AND principal.principal_id = grant_row.principal_id
               AND principal.state = 'active' AND principal.kind = 'user'
              WHERE grant_row.tenant_id = ? AND grant_row.security_domain_id = ?
                AND grant_row.principal_id <> ?
                AND grant_row.capability = 'manage_access' AND grant_row.status = 'active'
                AND grant_row.expires_at_utc IS NULL
              LIMIT 1
            `).get(membership.projectId, tenantId, domain.id, membership.principalId);
            if (replacement === undefined) throw new Error("SECURITY_DOMAIN_LAST_ADMINISTRATOR");
          }

          const updatedDomains = affected.map(({ domain }) => ({
            ...domain,
            permissionVersion: domain.permissionVersion + 1,
            version: domain.version + 1,
          }));
          this.#database.exec("SAVEPOINT project_membership_security_write");
          try {
            const membershipResult = this.#database.prepare(`
              UPDATE project_memberships
              SET role = ?, status = ?, version = ?, membership_json = ?
              WHERE tenant_id = ? AND project_id = ? AND principal_id = ? AND version = ?
            `).run(
              membership.role, membership.status, membership.version, JSON.stringify(membership),
              tenantId, membership.projectId, membership.principalId, expectedVersion,
            );
            if (membershipResult.changes !== 1) throw new Error("PROJECT_MEMBERSHIP_VERSION_CONFLICT");
            for (const domain of updatedDomains) {
              const domainResult = this.#database.prepare(`
                UPDATE security_domains
                SET permission_version = ?, version = ?, domain_json = ?
                WHERE tenant_id = ? AND security_domain_id = ? AND version = ? AND permission_version = ?
              `).run(
                domain.permissionVersion, domain.version, JSON.stringify(domain), tenantId, domain.id,
                domain.version - 1, domain.permissionVersion - 1,
              );
              if (domainResult.changes !== 1) throw new Error("SECURITY_DOMAIN_VERSION_CONFLICT");
            }
            this.#database.exec("RELEASE SAVEPOINT project_membership_security_write");
          } catch (error) {
            this.#database.exec("ROLLBACK TO SAVEPOINT project_membership_security_write");
            this.#database.exec("RELEASE SAVEPOINT project_membership_security_write");
            throw error;
          }
          return updatedDomains;
        },
      },
      membershipSecurityAudits: {
        append: async (entry) => {
          assertTenant(tenantId, entry.tenantId);
          this.#database.prepare(`
            INSERT INTO project_membership_security_audits (
              tenant_id, audit_id, project_id, target_principal_id, occurred_at_utc, audit_json
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).run(tenantId, entry.id, entry.projectId, entry.targetPrincipalId, entry.occurredAtUtc, JSON.stringify(entry));
        },
        listByProject: async (projectId) => this.#database.prepare(`
          SELECT audit_json FROM project_membership_security_audits
          WHERE tenant_id = ? AND project_id = ?
          ORDER BY occurred_at_utc, audit_id
        `).all(tenantId, projectId).map(
          (row) => parseJson<ProjectMembershipSecurityAuditEntry>(asString(row.audit_json)),
        ),
      },
      securityDomains: {
        get: async (securityDomainId) => {
          const row = this.#database.prepare(`
            SELECT domain_json FROM security_domains WHERE tenant_id = ? AND security_domain_id = ?
          `).get(tenantId, securityDomainId);
          return row === undefined ? undefined : parseJson<SecurityDomain>(asString(row.domain_json));
        },
        getByRoot: async (projectId, rootNodeId) => {
          const row = this.#database.prepare(`
            SELECT domain_json FROM security_domains
            WHERE tenant_id = ? AND project_id = ? AND root_node_id = ?
          `).get(tenantId, projectId, rootNodeId);
          return row === undefined ? undefined : parseJson<SecurityDomain>(asString(row.domain_json));
        },
        insert: async (domain) => {
          assertTenant(tenantId, domain.tenantId);
          this.#database.prepare(`
            INSERT INTO security_domains (
              tenant_id, security_domain_id, project_id, root_node_id, parent_security_domain_id,
              permission_version, version, domain_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            tenantId, domain.id, domain.projectId, domain.rootNodeId, domain.parentSecurityDomainId,
            domain.permissionVersion, domain.version, JSON.stringify(domain),
          );
        },
      },
      securityGrants: {
        get: async (securityDomainId, principalId) => {
          const row = this.#database.prepare(`
            SELECT grant_json FROM security_grants
            WHERE tenant_id = ? AND security_domain_id = ? AND principal_id = ?
          `).get(tenantId, securityDomainId, principalId);
          return row === undefined ? undefined : parseJson<SecurityGrant>(asString(row.grant_json));
        },
        listByDomain: async (securityDomainId) => this.#database.prepare(`
          SELECT grant_json FROM security_grants
          WHERE tenant_id = ? AND security_domain_id = ? ORDER BY principal_id
        `).all(tenantId, securityDomainId).map((row) => parseJson<SecurityGrant>(asString(row.grant_json))),
        insert: async (grant) => {
          assertTenant(tenantId, grant.tenantId);
          this.#database.prepare(`
            INSERT INTO security_grants (
              tenant_id, security_domain_id, principal_id, capability, status,
              expires_at_utc, version, grant_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            tenantId, grant.securityDomainId, grant.principalId, grant.capability, grant.status,
            grant.expiresAtUtc, grant.version, JSON.stringify(grant),
          );
        },
        saveWithDomainVersion: async (grant, expectedGrantVersion, domain, expectedDomainVersion) => {
          assertTenant(tenantId, grant.tenantId);
          assertTenant(tenantId, domain.tenantId);
          if (grant.securityDomainId !== domain.id) throw new Error("SECURITY_GRANT_DOMAIN_MISMATCH");

          const currentDomain = this.#database.prepare(`
            SELECT version, permission_version, domain_json FROM security_domains
            WHERE tenant_id = ? AND security_domain_id = ?
          `).get(tenantId, domain.id);
          const currentDomainValue = currentDomain === undefined
            ? undefined
            : parseJson<SecurityDomain>(asString(currentDomain.domain_json));
          if (currentDomain === undefined || currentDomainValue === undefined
            || asNumber(currentDomain.version) !== expectedDomainVersion
            || domain.version !== expectedDomainVersion + 1
            || domain.permissionVersion !== asNumber(currentDomain.permission_version) + 1
            || domain.projectId !== currentDomainValue.projectId
            || domain.rootNodeId !== currentDomainValue.rootNodeId
            || domain.parentSecurityDomainId !== currentDomainValue.parentSecurityDomainId
            || domain.createdByPrincipalId !== currentDomainValue.createdByPrincipalId
            || domain.createdAtUtc !== currentDomainValue.createdAtUtc
            || domain.deletedAtUtc !== currentDomainValue.deletedAtUtc) {
            throw new Error("SECURITY_DOMAIN_VERSION_CONFLICT");
          }

          const currentGrant = this.#database.prepare(`
            SELECT version, grant_json FROM security_grants
            WHERE tenant_id = ? AND security_domain_id = ? AND principal_id = ?
          `).get(tenantId, grant.securityDomainId, grant.principalId);
          const currentGrantValue = currentGrant === undefined
            ? undefined
            : parseJson<SecurityGrant>(asString(currentGrant.grant_json));
          if (expectedGrantVersion === null) {
            if (currentGrant !== undefined || grant.version !== 1) throw new Error("SECURITY_GRANT_VERSION_CONFLICT");
          } else if (currentGrant === undefined || currentGrantValue === undefined
            || asNumber(currentGrant.version) !== expectedGrantVersion
            || grant.version !== expectedGrantVersion + 1
            || grant.id !== currentGrantValue.id
            || grant.createdAtUtc !== currentGrantValue.createdAtUtc) {
            throw new Error("SECURITY_GRANT_VERSION_CONFLICT");
          }

          const proposedAdministrator = grant.capability === "manage_access"
            && grant.status === "active"
            && grant.expiresAtUtc === null
            && this.#database.prepare(`
              SELECT 1 FROM project_memberships AS membership
              JOIN principals AS principal
                ON principal.tenant_id = membership.tenant_id
               AND principal.principal_id = membership.principal_id
               AND principal.state = 'active' AND principal.kind = 'user'
              WHERE membership.tenant_id = ? AND membership.project_id = ?
                AND membership.principal_id = ?
                AND membership.status = 'active' AND membership.role = 'project_manager'
              LIMIT 1
            `).get(tenantId, domain.projectId, grant.principalId) !== undefined;
          const otherAdministrator = this.#database.prepare(`
            SELECT 1 FROM security_grants AS grant_row
            JOIN project_memberships AS membership
              ON membership.tenant_id = grant_row.tenant_id
             AND membership.project_id = ?
             AND membership.principal_id = grant_row.principal_id
             AND membership.status = 'active' AND membership.role = 'project_manager'
            JOIN principals AS principal
              ON principal.tenant_id = grant_row.tenant_id
             AND principal.principal_id = grant_row.principal_id
             AND principal.state = 'active' AND principal.kind = 'user'
            WHERE grant_row.tenant_id = ? AND grant_row.security_domain_id = ?
              AND grant_row.principal_id <> ?
              AND grant_row.capability = 'manage_access' AND grant_row.status = 'active'
              AND grant_row.expires_at_utc IS NULL
            LIMIT 1
          `).get(domain.projectId, tenantId, domain.id, grant.principalId);
          if (!proposedAdministrator && otherAdministrator === undefined) {
            throw new Error("SECURITY_DOMAIN_LAST_ADMINISTRATOR");
          }

          this.#database.exec("SAVEPOINT security_grant_domain_write");
          try {
            if (expectedGrantVersion === null) {
              this.#database.prepare(`
                INSERT INTO security_grants (
                  tenant_id, security_domain_id, principal_id, capability, status,
                  expires_at_utc, version, grant_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                tenantId, grant.securityDomainId, grant.principalId, grant.capability, grant.status,
                grant.expiresAtUtc, grant.version, JSON.stringify(grant),
              );
            } else {
              const grantResult = this.#database.prepare(`
                UPDATE security_grants
                SET capability = ?, status = ?, expires_at_utc = ?, version = ?, grant_json = ?
                WHERE tenant_id = ? AND security_domain_id = ? AND principal_id = ? AND version = ?
              `).run(
                grant.capability, grant.status, grant.expiresAtUtc, grant.version, JSON.stringify(grant),
                tenantId, grant.securityDomainId, grant.principalId, expectedGrantVersion,
              );
              if (grantResult.changes !== 1) throw new Error("SECURITY_GRANT_VERSION_CONFLICT");
            }
            const domainResult = this.#database.prepare(`
              UPDATE security_domains
              SET permission_version = ?, version = ?, domain_json = ?
              WHERE tenant_id = ? AND security_domain_id = ? AND version = ? AND permission_version = ?
            `).run(
              domain.permissionVersion, domain.version, JSON.stringify(domain), tenantId, domain.id,
              expectedDomainVersion, domain.permissionVersion - 1,
            );
            if (domainResult.changes !== 1) throw new Error("SECURITY_DOMAIN_VERSION_CONFLICT");
            this.#database.exec("RELEASE SAVEPOINT security_grant_domain_write");
          } catch (error) {
            this.#database.exec("ROLLBACK TO SAVEPOINT security_grant_domain_write");
            this.#database.exec("RELEASE SAVEPOINT security_grant_domain_write");
            throw error;
          }
        },
      },
      securityGrantAudits: {
        append: async (entry) => {
          assertTenant(tenantId, entry.tenantId);
          this.#database.prepare(`
            INSERT INTO security_grant_audits (
              tenant_id, audit_id, project_id, security_domain_id, occurred_at_utc, audit_json
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).run(tenantId, entry.id, entry.projectId, entry.securityDomainId, entry.occurredAtUtc, JSON.stringify(entry));
        },
        listByDomain: async (securityDomainId) => this.#database.prepare(`
          SELECT audit_json FROM security_grant_audits
          WHERE tenant_id = ? AND security_domain_id = ?
          ORDER BY occurred_at_utc, audit_id
        `).all(tenantId, securityDomainId).map(
          (row) => parseJson<SecurityGrantAuditEntry>(asString(row.audit_json)),
        ),
      },
      securityMigrations: {
        get: async (migrationId) => {
          const row = this.#database.prepare(`
            SELECT * FROM security_domain_migrations WHERE tenant_id = ? AND migration_id = ?
          `).get(tenantId, migrationId);
          return row === undefined ? undefined : securityMigrationFromRow(row);
        },
        insert: async (migration) => {
          assertTenant(tenantId, migration.tenantId);
          assertSecurityMigrationInitialPlan(migration);
          this.#database.prepare(`
            INSERT INTO security_domain_migrations (
              tenant_id, migration_id, project_id, root_node_id, state, hierarchy_revision,
              cursor, total_items, migrated_items, next_attempt_at_utc, updated_at_utc, version, migration_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            tenantId, migration.id, migration.projectId, migration.rootNodeId, migration.state, migration.hierarchyRevision,
            migration.cursor, migration.totalItems, migration.migratedItems, migration.nextAttemptAtUtc,
            migration.updatedAtUtc, migration.version, JSON.stringify(migration),
          );
        },
        saveProgressPreservingPlan: async (migrationId, migration, expectedVersion) => {
          const currentRow = this.#database.prepare(`
            SELECT tenant_id, migration_id, project_id, root_node_id, state, hierarchy_revision,
                   cursor, total_items, migrated_items, next_attempt_at_utc, updated_at_utc, version, migration_json
            FROM security_domain_migrations WHERE tenant_id = ? AND migration_id = ?
          `).get(tenantId, migrationId);
          if (currentRow === undefined) throw new Error("SECURITY_MIGRATION_NOT_FOUND");
          const current = securityMigrationFromRow(currentRow);
          if (current.version !== asNumber(currentRow.version) || current.version !== expectedVersion
            || migration.version !== expectedVersion + 1) {
            throw new Error("SECURITY_MIGRATION_VERSION_CONFLICT");
          }
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
            && this.hasActiveFenceOrUnresolvedOperationInMigrationScope(tenantId, migration, this.nowUtc())) {
            throw new Error("SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE");
          }
          const result = this.#database.prepare(`
            UPDATE security_domain_migrations
            SET state = ?, cursor = ?, migrated_items = ?,
                next_attempt_at_utc = ?, updated_at_utc = ?, version = ?, migration_json = ?
            WHERE tenant_id = ? AND migration_id = ? AND version = ?
          `).run(
            migration.state, migration.cursor, migration.migratedItems,
            migration.nextAttemptAtUtc, migration.updatedAtUtc, migration.version, JSON.stringify(migration),
            tenantId, migrationId, expectedVersion,
          );
          if (result.changes !== 1) throw new Error("SECURITY_MIGRATION_VERSION_CONFLICT");
        },
        saveManifestSnapshot: async (snapshot) => {
          assertTenant(tenantId, snapshot.tenantId);
          const existingRow = this.#database.prepare(`
            SELECT * FROM security_migration_manifest_snapshots
            WHERE tenant_id = ? AND migration_id = ?
          `).get(tenantId, snapshot.migrationId) as Record<string, unknown> | undefined;
          if (existingRow !== undefined) {
            const existing = manifestSnapshotFromRow(existingRow, this.#database);
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
          const migrationRow = this.#database.prepare(`
            SELECT * FROM security_domain_migrations WHERE tenant_id = ? AND migration_id = ?
          `).get(tenantId, snapshot.migrationId);
          let envelope: Parameters<typeof validateCanonicalSnapshotItems>[1] = {
            tenantId,
            projectId: snapshot.projectId,
            migrationId: snapshot.migrationId,
            sourceSecurityDomainId: snapshot.sourceSecurityDomainId ?? null,
            targetSecurityDomainId: snapshot.targetSecurityDomainId ?? null,
            sourceSecurityEpoch: snapshot.sourceSecurityEpoch,
            targetSecurityEpoch: snapshot.targetSecurityEpoch,
          };
          if (migrationRow !== undefined) {
            const migration = securityMigrationFromRow(migrationRow);
            envelope = {
              tenantId,
              projectId: snapshot.projectId ?? migration.projectId,
              migrationId: snapshot.migrationId,
              sourceSecurityDomainId: snapshot.sourceSecurityDomainId !== undefined ? snapshot.sourceSecurityDomainId : migration.sourceSecurityDomainId,
              targetSecurityDomainId: snapshot.targetSecurityDomainId !== undefined ? snapshot.targetSecurityDomainId : migration.targetSecurityDomainId,
              sourceSecurityEpoch: snapshot.sourceSecurityEpoch ?? migration.sourceSecurityEpoch,
              targetSecurityEpoch: snapshot.targetSecurityEpoch ?? migration.targetSecurityEpoch,
            };
          }
          validateCanonicalSnapshotItems(snapshot, envelope);
          this.#database.prepare(`
            INSERT INTO security_migration_manifest_snapshots (
              tenant_id, migration_id, manifest_digest, item_count, snapshot_json, created_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            tenantId, snapshot.migrationId, snapshot.manifestDigest, snapshot.items.length,
            JSON.stringify(snapshot), snapshot.createdAtUtc,
          );
        },
        getManifestSnapshot: async (migrationId) => {
          const row = this.#database.prepare(`
            SELECT * FROM security_migration_manifest_snapshots
            WHERE tenant_id = ? AND migration_id = ?
          `).get(tenantId, migrationId) as Record<string, unknown> | undefined;
          return row === undefined ? undefined : manifestSnapshotFromRow(row, this.#database);
        },
        getReadinessEvidence: async (evidenceId) => {
          const row = this.#database.prepare(`
            SELECT * FROM security_migration_readiness_evidence
            WHERE tenant_id = ? AND evidence_id = ?
          `).get(tenantId, evidenceId) as Record<string, unknown> | undefined;
          return row === undefined ? undefined : readinessEvidenceFromRow(row);
        },
        commitWithReadinessEvidence: async (params) => {
          const nowUtc = this.nowUtc();
          const currentRow = this.#database.prepare(`
            SELECT * FROM security_domain_migrations WHERE tenant_id = ? AND migration_id = ?
          `).get(tenantId, params.migrationId);
          if (currentRow === undefined) throw new Error("SECURITY_MIGRATION_NOT_FOUND");
          const current = securityMigrationFromRow(currentRow);
          if (current.version !== params.expectedVersion) {
            throw new Error("SECURITY_MIGRATION_VERSION_CONFLICT");
          }
          if (current.state !== "verifying") {
            throw new Error("SECURITY_MIGRATION_COMMIT_INVALID");
          }

          await this.assertActorAuthorizedForMigration(context, tenantId, current, params.actorPrincipalId, nowUtc);

          const evidenceRow = this.#database.prepare(`
            SELECT * FROM security_migration_readiness_evidence WHERE tenant_id = ? AND evidence_id = ?
          `).get(tenantId, params.evidenceId) as Record<string, unknown> | undefined;
          if (evidenceRow === undefined) throw new Error("SECURITY_MIGRATION_EVIDENCE_NOT_FOUND");
          const evidence = readinessEvidenceFromRow(evidenceRow);

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

          if (nowUtc > evidence.expiresAtUtc) {
            throw new Error("SECURITY_MIGRATION_EVIDENCE_EXPIRED");
          }

          if (evidence.verifiedAtUtc === null || evidence.verifiedAtUtc > nowUtc) {
            throw new Error("SECURITY_MIGRATION_EVIDENCE_INVALID");
          }

          if (evidence.issuedAtUtc > evidence.verifiedAtUtc) {
            throw new Error("SECURITY_MIGRATION_EVIDENCE_INVALID");
          }

          const consumedByNonce = this.#database.prepare(`
            SELECT 1 FROM consumed_security_migration_evidence
            WHERE tenant_id = ? AND nonce = ?
            LIMIT 1
          `).get(tenantId, evidence.nonce);
          const consumedById = this.#database.prepare(`
            SELECT 1 FROM consumed_security_migration_evidence
            WHERE tenant_id = ? AND evidence_id = ?
            LIMIT 1
          `).get(tenantId, evidence.evidenceId);
          if (consumedByNonce !== undefined || consumedById !== undefined) {
            throw new Error("SECURITY_MIGRATION_EVIDENCE_REPLAYED");
          }

          // TOCTOU Revalidation
          const snapshotRow = this.#database.prepare(`
            SELECT * FROM security_migration_manifest_snapshots WHERE tenant_id = ? AND migration_id = ?
          `).get(tenantId, current.id) as Record<string, unknown> | undefined;
          if (snapshotRow === undefined) {
            throw new Error("SECURITY_MIGRATION_MANIFEST_SNAPSHOT_NOT_FOUND");
          }
          const snapshot = manifestSnapshotFromRow(snapshotRow, this.#database);
          if (snapshot.manifestDigest !== evidence.manifestDigest || snapshot.items.length !== evidence.itemCount) {
            throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH");
          }

          const liveManifest = await collectSecurityMigrationManifest(context, current);
          assertManifestMatchesSnapshot(liveManifest, snapshot);

          if (this.hasIncompleteInventoryObjectsInMigrationScope(tenantId, current)) {
            throw new Error("SECURITY_MIGRATION_INVENTORY_INCOMPLETE");
          }

          if (this.hasActiveFenceOrUnresolvedOperationInMigrationScope(tenantId, current, nowUtc)) {
            throw new Error("SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE");
          }

          const updatedEvidence: SecurityMigrationReadinessEvidenceRecord = {
            ...evidence,
            status: "consumed",
            consumedAtUtc: nowUtc,
          };
          this.#database.prepare(`
            UPDATE security_migration_readiness_evidence
            SET status = 'consumed', consumed_at_utc = ?, evidence_json = ?
            WHERE tenant_id = ? AND evidence_id = ? AND status = 'verified'
          `).run(nowUtc, JSON.stringify(updatedEvidence), tenantId, evidence.evidenceId);

          this.#database.prepare(`
            INSERT INTO consumed_security_migration_evidence (
              tenant_id, evidence_id, nonce, migration_id, manifest_digest, consumed_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).run(tenantId, evidence.evidenceId, evidence.nonce, current.id, evidence.manifestDigest, nowUtc);

          const committed = transitionSecurityMigration(current, "committed", nowUtc);
          const result = this.#database.prepare(`
            UPDATE security_domain_migrations
            SET state = ?, updated_at_utc = ?, version = version + 1, migration_json = ?
            WHERE tenant_id = ? AND migration_id = ? AND version = ?
          `).run(
            committed.state, committed.updatedAtUtc, JSON.stringify(committed),
            tenantId, committed.id, current.version,
          );
          if (result.changes !== 1) throw new Error("SECURITY_MIGRATION_VERSION_CONFLICT");

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
            occurredAtUtc: nowUtc,
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
            occurredAtUtc: nowUtc,
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
            availableAtUtc: nowUtc,
            attempts: 0,
            maxAttempts: 8,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAtUtc: null,
            lastError: null,
            publishedAtUtc: null,
            createdAtUtc: nowUtc,
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
              createdAtUtc: nowUtc,
            });
          }

          return commitResult;
        },
        rollbackWithAudit: async (params) => {
          const nowUtc = this.nowUtc();
          const currentRow = this.#database.prepare(`
            SELECT * FROM security_domain_migrations WHERE tenant_id = ? AND migration_id = ?
          `).get(tenantId, params.migrationId);
          if (currentRow === undefined) throw new Error("SECURITY_MIGRATION_NOT_FOUND");
          const current = securityMigrationFromRow(currentRow);
          if (current.version !== params.expectedVersion) {
            throw new Error("SECURITY_MIGRATION_VERSION_CONFLICT");
          }
          if (!["planned", "active", "verifying", "retryable", "recovery_required"].includes(current.state)) {
            throw new Error("SECURITY_MIGRATION_ROLLBACK_INVALID");
          }

          await this.assertActorAuthorizedForMigration(context, tenantId, current, params.actorPrincipalId, nowUtc);

          let rolledBackItems = 0;
          if (current.migratedItems > 0) {
            if (params.evidenceId === undefined) {
              throw new Error("SECURITY_MIGRATION_EVIDENCE_REQUIRED");
            }
            const evidenceRow = this.#database.prepare(`
              SELECT * FROM security_migration_readiness_evidence WHERE tenant_id = ? AND evidence_id = ?
            `).get(tenantId, params.evidenceId) as Record<string, unknown> | undefined;
            if (evidenceRow === undefined) throw new Error("SECURITY_MIGRATION_EVIDENCE_NOT_FOUND");
            const evidence = readinessEvidenceFromRow(evidenceRow);

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

            if (nowUtc > evidence.expiresAtUtc) {
              throw new Error("SECURITY_MIGRATION_EVIDENCE_EXPIRED");
            }

            if (evidence.verifiedAtUtc === null || evidence.verifiedAtUtc > nowUtc) {
              throw new Error("SECURITY_MIGRATION_EVIDENCE_INVALID");
            }

            if (evidence.issuedAtUtc > evidence.verifiedAtUtc) {
              throw new Error("SECURITY_MIGRATION_EVIDENCE_INVALID");
            }

            const existingNonce = this.#database.prepare(`
              SELECT evidence_id FROM consumed_security_migration_evidence WHERE tenant_id = ? AND (nonce = ? OR evidence_id = ?)
            `).get(tenantId, evidence.nonce, evidence.evidenceId);
            if (existingNonce !== undefined) {
              throw new Error("SECURITY_MIGRATION_EVIDENCE_REPLAYED");
            }

            const snapshotRow = this.#database.prepare(`
              SELECT * FROM security_migration_manifest_snapshots WHERE tenant_id = ? AND migration_id = ?
            `).get(tenantId, current.id) as Record<string, unknown> | undefined;
            if (snapshotRow === undefined) {
              throw new Error("SECURITY_MIGRATION_MANIFEST_SNAPSHOT_NOT_FOUND");
            }
            const snapshot = manifestSnapshotFromRow(snapshotRow, this.#database);
            if (snapshot.manifestDigest !== evidence.manifestDigest || snapshot.items.length !== evidence.itemCount) {
              throw new Error("SECURITY_MIGRATION_MANIFEST_MISMATCH");
            }

            if (this.hasActiveFenceOrUnresolvedOperationInMigrationScope(tenantId, current, nowUtc)) {
              throw new Error("SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE");
            }

            const liveManifest = await collectSecurityMigrationManifest(context, current);
            assertManifestMatchesSnapshot(liveManifest, snapshot);

            const updatedEvidence: SecurityMigrationReadinessEvidenceRecord = {
              ...evidence,
              status: "consumed",
              consumedAtUtc: nowUtc,
            };
            this.#database.prepare(`
              UPDATE security_migration_readiness_evidence
              SET status = 'consumed', consumed_at_utc = ?, evidence_json = ?
              WHERE tenant_id = ? AND evidence_id = ? AND status = 'verified'
            `).run(nowUtc, JSON.stringify(updatedEvidence), tenantId, evidence.evidenceId);

            this.#database.prepare(`
              INSERT INTO consumed_security_migration_evidence (
                tenant_id, evidence_id, nonce, migration_id, manifest_digest, consumed_at_utc
              ) VALUES (?, ?, ?, ?, ?, ?)
            `).run(tenantId, evidence.evidenceId, evidence.nonce, current.id, evidence.manifestDigest, nowUtc);

            // Restore objects in reverse order using immutable manifest snapshot (deliverable -> asset -> task -> node)
            // 1. Deliverables (roll back first, since they are leaves owned by nodes)
            for (const item of snapshot.items.filter((i) => i.kind === "deliverable")) {
              const deliverable = await context.deliverables.get(item.id);
              if (deliverable !== undefined && deliverable.securityDomainId === current.targetSecurityDomainId && deliverable.securityEpoch === current.targetSecurityEpoch) {
                await context.deliverables.rollbackSecurityOwnership(current.id, deliverable.id, deliverable.version);
                rolledBackItems++;
              }
            }
            // 2. Assets
            for (const item of snapshot.items.filter((i) => i.kind === "asset")) {
              const asset = await context.assets.get(item.id);
              if (asset !== undefined && asset.securityDomainId === current.targetSecurityDomainId && asset.securityEpoch === current.targetSecurityEpoch) {
                await context.assets.rollbackSecurityOwnership(current.id, asset.id, asset.version);
                rolledBackItems++;
              }
            }
            // 3. Tasks
            for (const item of snapshot.items.filter((i) => i.kind === "task")) {
              const task = await context.tasks.get(item.id);
              if (task !== undefined && task.securityDomainId === current.targetSecurityDomainId && task.securityEpoch === current.targetSecurityEpoch) {
                await context.tasks.rollbackSecurityOwnership(current.id, task.id, task.version);
                rolledBackItems++;
              }
            }
            // 4. Nodes in reverse depth order (leaves before root)
            const nodeDepths = this.collectSubtreeDepths(tenantId, current.projectId, current.rootNodeId);
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

          if (this.hasObjectsNotRevertedToSourceInMigrationScope(tenantId, current)) {
            throw new Error("SECURITY_MIGRATION_ROLLBACK_INCOMPLETE");
          }

          const rolledBack = transitionSecurityMigration(current, "rolled_back", nowUtc);
          const result = this.#database.prepare(`
            UPDATE security_domain_migrations
            SET state = ?, cursor = ?, migrated_items = ?,
                next_attempt_at_utc = ?, updated_at_utc = ?, version = ?, migration_json = ?
            WHERE tenant_id = ? AND migration_id = ? AND version = ?
          `).run(
            rolledBack.state, rolledBack.cursor, rolledBack.migratedItems,
            rolledBack.nextAttemptAtUtc, rolledBack.updatedAtUtc, rolledBack.version, JSON.stringify(rolledBack),
            tenantId, params.migrationId, params.expectedVersion,
          );
          if (result.changes !== 1) throw new Error("SECURITY_MIGRATION_VERSION_CONFLICT");

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
            occurredAtUtc: nowUtc,
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
            occurredAtUtc: nowUtc,
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
            availableAtUtc: nowUtc,
            attempts: 0,
            maxAttempts: 8,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAtUtc: null,
            lastError: null,
            publishedAtUtc: null,
            createdAtUtc: nowUtc,
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
              createdAtUtc: nowUtc,
            });
          }

          return rollbackResult;
        },
        listRecoverable: async () => this.#database.prepare(`
          SELECT * FROM security_domain_migrations
          WHERE tenant_id = ?
          ORDER BY migration_id
        `).all(tenantId)
          .map((row) => securityMigrationFromRow(row))
          .filter((migration) => !["committed", "rolled_back"].includes(migration.state)),
      },
      securityMigrationAudits: {
        append: async (entry) => {
          assertTenant(tenantId, entry.tenantId);
          this.#database.prepare(`
            INSERT INTO security_migration_audits (
              tenant_id, audit_id, project_id, migration_id, occurred_at_utc, audit_json
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).run(tenantId, entry.auditId, entry.projectId, entry.migrationId, entry.occurredAtUtc, JSON.stringify(entry));
        },
        listByMigration: async (migrationId) => this.#database.prepare(`
          SELECT audit_json FROM security_migration_audits
          WHERE tenant_id = ? AND migration_id = ?
          ORDER BY occurred_at_utc, audit_id
        `).all(tenantId, migrationId).map(
          (row) => parseJson<SecurityMigrationAuditEntry>(asString(row.audit_json)),
        ),
      },
      roleSlots: {
        get: async (projectId, slotKey) => {
          const row = this.#database.prepare(`
            SELECT * FROM project_role_slots
            WHERE tenant_id = ? AND project_id = ? AND slot_key = ?
          `).get(tenantId, projectId, slotKey) as Record<string, unknown> | undefined;
          return row === undefined ? undefined : slotFromRow(row, { tenantId, projectId, slotKey });
        },
        listByProject: async (projectId) => {
          const rows = this.#database.prepare(`
            SELECT * FROM project_role_slots
            WHERE tenant_id = ? AND project_id = ?
            ORDER BY slot_key
          `).all(tenantId, projectId) as Record<string, unknown>[];
          return rows
            .map((row) => slotFromRow(row, { tenantId, projectId, slotKey: asString(row.slot_key) }))
            .sort((a, b) => compareExactStrings(a.slotKey, b.slotKey));
        },
        getSnapshot: async (projectId) => {
          const row = this.#database.prepare(`
            SELECT * FROM project_role_slot_snapshots
            WHERE tenant_id = ? AND project_id = ?
          `).get(tenantId, projectId) as Record<string, unknown> | undefined;
          return row === undefined ? undefined : snapshotFromRow(row, { tenantId, projectId });
        },
      },
      roleSlotAudits: {
        append: async (entry) => {
          assertCanonicalProjectRoleSlotAuditEntry(entry, { tenantId, projectId: entry.projectId });
          this.#database.prepare(`
            INSERT INTO project_role_slot_audits (
              tenant_id, id, project_id, actor_principal_id, source_template_version_id, action, slot_keys_json, occurred_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            entry.tenantId,
            entry.id,
            entry.projectId,
            entry.actorPrincipalId,
            entry.sourceTemplateVersionId,
            entry.action,
            JSON.stringify(entry.slotKeys),
            entry.occurredAtUtc,
          );
        },
        listByProject: async (projectId) => {
          const rows = this.#database.prepare(`
            SELECT * FROM project_role_slot_audits
            WHERE tenant_id = ? AND project_id = ?
            ORDER BY occurred_at_utc, id
          `).all(tenantId, projectId) as Record<string, unknown>[];
          return rows.map((row) => roleSlotAuditFromRow(row, { tenantId, projectId }));
        },
      },

      roleBindings: {
        get: async (projectId, slotKey) => {
          const row = this.#database.prepare(`
            SELECT * FROM project_role_bindings
            WHERE tenant_id = ? AND project_id = ? AND slot_key = ?
          `).get(tenantId, projectId, slotKey) as Record<string, unknown> | undefined;
          return row === undefined ? undefined : bindingFromRow(row, { tenantId, projectId, slotKey });
        },
        listByProject: async (projectId) => {
          const rows = this.#database.prepare(`
            SELECT * FROM project_role_bindings
            WHERE tenant_id = ? AND project_id = ?
            ORDER BY slot_key
          `).all(tenantId, projectId) as Record<string, unknown>[];
          return rows
            .map((row) => bindingFromRow(row, { tenantId, projectId, slotKey: asString(row.slot_key) }))
            .sort((a, b) => compareExactStrings(a.slotKey, b.slotKey));
        },
      },
      receipts: {
        get: async <T>(scope: CommandScope) => {
          const row = this.#database.prepare(`
            SELECT fingerprint, result_json, created_at_utc
            FROM command_receipts
            WHERE tenant_id = ? AND principal_id = ? AND operation = ? AND idempotency_key = ?
          `).get(tenantId, scope.principalId, scope.operation, scope.idempotencyKey);
          if (row === undefined) return undefined;
          return {
            scope,
            fingerprint: asString(row.fingerprint),
            result: parseJson<T>(asString(row.result_json)),
            createdAtUtc: asString(row.created_at_utc),
          };
        },
        insert: async (receipt) => {
          this.#database.prepare(`
            INSERT INTO command_receipts (
              tenant_id, principal_id, operation, idempotency_key, fingerprint, result_json, created_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            tenantId, receipt.scope.principalId, receipt.scope.operation, receipt.scope.idempotencyKey,
            receipt.fingerprint, JSON.stringify(receipt.result), receipt.createdAtUtc,
          );
        },
      },
      sequences: {
        next: async (projectId) => {
          const row = this.#database.prepare(`
            INSERT INTO project_sequences (tenant_id, project_id, last_sequence)
            VALUES (?, ?, 1)
            ON CONFLICT (tenant_id, project_id)
            DO UPDATE SET last_sequence = last_sequence + 1
            RETURNING last_sequence
          `).get(tenantId, projectId);
          if (row === undefined) throw new Error("PROJECT_SEQUENCE_NOT_RETURNED");
          return asNumber(row.last_sequence);
        },
        current: async (projectId) => {
          const row = this.#database.prepare(
            "SELECT last_sequence FROM project_sequences WHERE tenant_id = ? AND project_id = ?",
          ).get(tenantId, projectId);
          return row === undefined ? 0 : asNumber(row.last_sequence);
        },
      },
      events: {
        append: async (event) => {
          assertTenant(tenantId, event.tenantId);
          validateEventAgainstSchema(event);
          this.#database.prepare(`
            INSERT INTO domain_events (
              tenant_id, event_id, project_id, project_sequence, aggregate_type,
              aggregate_id, aggregate_version, event_type, schema_version,
              occurred_at_utc, event_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            tenantId, event.eventId, event.projectId, event.projectSequence, event.aggregateType,
            event.aggregateId, event.aggregateVersion, event.eventType, event.schemaVersion,
            event.occurredAtUtc, JSON.stringify(event),
          );
        },
        list: async () => (this.#database.prepare(
          "SELECT event_json FROM domain_events WHERE tenant_id = ? ORDER BY project_id, project_sequence",
        ).all(tenantId) as Array<Record<string, unknown>>).map((row) => parseJson<DomainEvent>(asString(row.event_json))),
      },
      outbox: {
        enqueue: async (message) => {
          assertTenant(tenantId, message.tenantId);
          if (message.payload !== null && typeof message.payload === "object") {
            assertNoSensitiveFields(message.payload);
            const event = message.payload as Record<string, unknown>;
            if (typeof event.eventType === "string" && typeof event.schemaVersion === "number") {
              validateEventAgainstSchema(event as unknown as DomainEvent);
            }
          }
          this.#database.prepare(`
            INSERT INTO outbox_messages (
              tenant_id, message_id, event_id, topic, payload_json, state,
              available_at_utc, attempts, max_attempts, lease_owner, lease_token,
              lease_expires_at_utc, last_error, published_at_utc, created_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            tenantId, message.id, message.eventId, message.topic, JSON.stringify(message.payload), message.state,
            message.availableAtUtc, message.attempts, message.maxAttempts, message.leaseOwner, message.leaseToken,
            message.leaseExpiresAtUtc, message.lastError, message.publishedAtUtc, message.createdAtUtc,
          );
        },
        list: async () => (this.#database.prepare(
          "SELECT * FROM outbox_messages WHERE tenant_id = ? ORDER BY created_at_utc, message_id",
        ).all(tenantId) as Array<Record<string, unknown>>).map(outboxFromRow),
      },
      jobs: {
        schedule: async (job) => {
          assertTenant(tenantId, job.tenantId);
          this.#database.prepare(`
            INSERT INTO background_jobs (
              tenant_id, job_id, job_type, dedupe_key, payload_json, state, priority,
              available_at_utc, attempts, max_attempts, lease_owner, lease_token,
              lease_expires_at_utc, last_error, completed_at_utc, created_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            tenantId, job.id, job.jobType, job.dedupeKey, JSON.stringify(job.payload), job.state, job.priority,
            job.availableAtUtc, job.attempts, job.maxAttempts, job.leaseOwner, job.leaseToken,
            job.leaseExpiresAtUtc, job.lastError, job.completedAtUtc, job.createdAtUtc,
          );
        },
        rescheduleDeadLetter: async (jobId, availableAtUtc) => {
          const result = this.#database.prepare(`
            UPDATE background_jobs
            SET state = 'pending', available_at_utc = ?, attempts = 0,
                lease_owner = NULL, lease_token = NULL, lease_expires_at_utc = NULL,
                last_error = NULL, completed_at_utc = NULL
            WHERE tenant_id = ? AND job_id = ? AND state = 'dead_letter'
          `).run(availableAtUtc, tenantId, jobId);
          return result.changes === 1;
        },
      },
    };
    return context;
  }

  private migrate(): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at_utc TEXT NOT NULL
        ) STRICT;
      `);
      const maxRow = this.#database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version?: number } | undefined;
      const countRow = this.#database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count?: number } | undefined;
      if (typeof maxRow?.version === "number" && maxRow.version >= currentSchemaVersion && countRow?.count === currentSchemaVersion) {
        this.#validateV11TableShapes(this.#database);
        this.#validateV12TableShapes(this.#database);
        this.#database.exec("COMMIT");
        return;
      }

      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS tenants (
        tenant_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('active', 'suspended')),
        created_at_utc TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS principals (
        tenant_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('user', 'service')),
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
        PRIMARY KEY (tenant_id, principal_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS external_identity_mappings (
        tenant_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        external_tenant_ref TEXT NOT NULL,
        external_subject_ref TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        version INTEGER NOT NULL CHECK (version > 0),
        mapping_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, provider, connection_id, external_tenant_ref, external_subject_ref),
        FOREIGN KEY (tenant_id, principal_id) REFERENCES principals (tenant_id, principal_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS external_identity_by_principal
        ON external_identity_mappings (tenant_id, principal_id, status);

      CREATE TABLE IF NOT EXISTS project_memberships (
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('project_manager', 'member')),
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        version INTEGER NOT NULL CHECK (version > 0),
        membership_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, project_id, principal_id),
        FOREIGN KEY (tenant_id, principal_id) REFERENCES principals (tenant_id, principal_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS project_memberships_by_principal
        ON project_memberships (tenant_id, principal_id, status, project_id);

      CREATE TABLE IF NOT EXISTS project_membership_security_audits (
        tenant_id TEXT NOT NULL,
        audit_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        target_principal_id TEXT NOT NULL,
        occurred_at_utc TEXT NOT NULL,
        audit_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, audit_id),
        FOREIGN KEY (tenant_id, target_principal_id) REFERENCES principals (tenant_id, principal_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS project_membership_security_audits_by_project
        ON project_membership_security_audits (tenant_id, project_id, occurred_at_utc, audit_id);

      CREATE TABLE IF NOT EXISTS security_domains (
        tenant_id TEXT NOT NULL,
        security_domain_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        root_node_id TEXT NOT NULL,
        parent_security_domain_id TEXT,
        permission_version INTEGER NOT NULL CHECK (permission_version > 0),
        version INTEGER NOT NULL CHECK (version > 0),
        domain_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, security_domain_id),
        UNIQUE (tenant_id, project_id, root_node_id),
        FOREIGN KEY (tenant_id, root_node_id) REFERENCES project_nodes (tenant_id, node_id),
        FOREIGN KEY (tenant_id, parent_security_domain_id) REFERENCES security_domains (tenant_id, security_domain_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS security_grants (
        tenant_id TEXT NOT NULL,
        security_domain_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        capability TEXT NOT NULL CHECK (capability IN ('view', 'contribute', 'edit', 'manage_access')),
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        expires_at_utc TEXT,
        version INTEGER NOT NULL CHECK (version > 0),
        grant_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, security_domain_id, principal_id),
        FOREIGN KEY (tenant_id, security_domain_id) REFERENCES security_domains (tenant_id, security_domain_id),
        FOREIGN KEY (tenant_id, principal_id) REFERENCES principals (tenant_id, principal_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS security_grants_by_principal
        ON security_grants (tenant_id, principal_id, status, security_domain_id);

      CREATE TABLE IF NOT EXISTS security_grant_audits (
        tenant_id TEXT NOT NULL,
        audit_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        security_domain_id TEXT NOT NULL,
        occurred_at_utc TEXT NOT NULL,
        audit_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, audit_id),
        FOREIGN KEY (tenant_id, security_domain_id) REFERENCES security_domains (tenant_id, security_domain_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS security_grant_audits_by_domain
        ON security_grant_audits (tenant_id, security_domain_id, occurred_at_utc, audit_id);

      CREATE TABLE IF NOT EXISTS project_nodes (
        tenant_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        parent_node_id TEXT,
        leader_principal_id TEXT,
        title TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('stage', 'work_package', 'milestone')),
        security_domain_id TEXT,
        security_epoch INTEGER NOT NULL CHECK (security_epoch > 0),
        version INTEGER NOT NULL CHECK (version > 0),
        deleted_at_utc TEXT,
        PRIMARY KEY (tenant_id, node_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
        FOREIGN KEY (tenant_id, parent_node_id) REFERENCES project_nodes (tenant_id, node_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS project_nodes_by_project ON project_nodes (tenant_id, project_id, node_id);

      CREATE TABLE IF NOT EXISTS product_tasks (
        tenant_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        owner_node_id TEXT NOT NULL,
        lifecycle_state TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        task_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, task_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
        FOREIGN KEY (tenant_id, owner_node_id) REFERENCES project_nodes (tenant_id, node_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS product_tasks_by_node ON product_tasks (tenant_id, owner_node_id, task_id);

      CREATE TABLE IF NOT EXISTS task_review_actions (
        tenant_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        cycle INTEGER NOT NULL CHECK (cycle > 0),
        action TEXT NOT NULL,
        occurred_at_utc TEXT NOT NULL,
        action_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, task_id, cycle, action),
        FOREIGN KEY (tenant_id, task_id) REFERENCES product_tasks (tenant_id, task_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS assets (
        tenant_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        owner_node_id TEXT NOT NULL,
        lifecycle_state TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        asset_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, asset_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
        FOREIGN KEY (tenant_id, owner_node_id) REFERENCES project_nodes (tenant_id, node_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS assets_by_node ON assets (tenant_id, owner_node_id, asset_id);

      CREATE TABLE IF NOT EXISTS asset_bindings (
        tenant_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        binding_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, binding_id),
        UNIQUE (tenant_id, asset_id, target_type, target_id),
        FOREIGN KEY (tenant_id, asset_id) REFERENCES assets (tenant_id, asset_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS asset_bindings_by_target ON asset_bindings (tenant_id, target_type, target_id);

      CREATE TABLE IF NOT EXISTS external_bindings (
        tenant_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        role TEXT NOT NULL,
        provider TEXT NOT NULL,
        kind TEXT NOT NULL,
        external_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        binding_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, binding_id),
        UNIQUE (tenant_id, owner_type, owner_id, role),
        UNIQUE (tenant_id, provider, kind, external_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS integration_operations (
        tenant_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        state TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        operation_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, operation_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS integration_operations_by_subject
        ON integration_operations (tenant_id, subject_type, subject_id, operation_type);

      CREATE TABLE IF NOT EXISTS integration_step_attempts (
        tenant_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        attempt_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, operation_id, sequence),
        FOREIGN KEY (tenant_id, operation_id) REFERENCES integration_operations (tenant_id, operation_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS outbound_projection_fences (
        tenant_id TEXT NOT NULL,
        fence_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        owner_node_id TEXT NOT NULL,
        token TEXT NOT NULL,
        expires_at_utc TEXT NOT NULL,
        created_at_utc TEXT NOT NULL,
        fence_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, fence_id),
        FOREIGN KEY (tenant_id, owner_node_id) REFERENCES project_nodes (tenant_id, node_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS outbound_projection_fences_active
        ON outbound_projection_fences (tenant_id, project_id, expires_at_utc);

      CREATE TABLE IF NOT EXISTS security_domain_migrations (
        tenant_id TEXT NOT NULL,
        migration_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        root_node_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('planned', 'active', 'verifying', 'committed', 'retryable', 'recovery_required', 'rolled_back')),
        hierarchy_revision INTEGER NOT NULL,
        cursor TEXT,
        total_items INTEGER NOT NULL CHECK (total_items >= 0),
        migrated_items INTEGER NOT NULL CHECK (migrated_items >= 0),
        next_attempt_at_utc TEXT,
        updated_at_utc TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        migration_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, migration_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
        FOREIGN KEY (tenant_id, root_node_id) REFERENCES project_nodes (tenant_id, node_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS security_migrations_recovery
        ON security_domain_migrations (tenant_id, state, migration_id);
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_security_migration_per_root
        ON security_domain_migrations (tenant_id, root_node_id)
        WHERE state NOT IN ('committed', 'rolled_back');

      CREATE TABLE IF NOT EXISTS security_migration_audits (
        tenant_id TEXT NOT NULL,
        audit_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        migration_id TEXT NOT NULL,
        occurred_at_utc TEXT NOT NULL,
        audit_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, audit_id),
        FOREIGN KEY (tenant_id, migration_id) REFERENCES security_domain_migrations (tenant_id, migration_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS security_migration_audits_by_migration
        ON security_migration_audits (tenant_id, migration_id, occurred_at_utc, audit_id);

      CREATE TABLE IF NOT EXISTS security_migration_manifest_snapshots (
        tenant_id TEXT NOT NULL,
        migration_id TEXT NOT NULL,
        manifest_digest TEXT NOT NULL,
        item_count INTEGER NOT NULL CHECK (item_count >= 0),
        snapshot_json TEXT NOT NULL,
        created_at_utc TEXT NOT NULL,
        PRIMARY KEY (tenant_id, migration_id),
        FOREIGN KEY (tenant_id, migration_id) REFERENCES security_domain_migrations (tenant_id, migration_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS security_migration_readiness_evidence (
        tenant_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        migration_id TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('commit', 'rollback')),
        nonce TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('issued', 'verified', 'consumed')),
        manifest_digest TEXT NOT NULL,
        item_count INTEGER NOT NULL CHECK (item_count >= 0),
        source_security_domain_id TEXT,
        target_security_domain_id TEXT,
        source_security_epoch INTEGER NOT NULL CHECK (source_security_epoch > 0),
        target_security_epoch INTEGER NOT NULL CHECK (target_security_epoch > 0),
        issued_at_utc TEXT NOT NULL,
        expires_at_utc TEXT NOT NULL,
        verified_at_utc TEXT,
        consumed_at_utc TEXT,
        verifier_provider TEXT,
        channels_json TEXT,
        converged INTEGER CHECK (converged IN (0, 1)),
        reason TEXT,
        evidence_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, evidence_id),
        FOREIGN KEY (tenant_id, migration_id) REFERENCES security_domain_migrations (tenant_id, migration_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS readiness_evidence_by_migration
        ON security_migration_readiness_evidence (tenant_id, migration_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS readiness_evidence_by_nonce
        ON security_migration_readiness_evidence (tenant_id, nonce);

      CREATE TABLE IF NOT EXISTS consumed_security_migration_evidence (
        tenant_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        migration_id TEXT NOT NULL,
        manifest_digest TEXT NOT NULL,
        consumed_at_utc TEXT NOT NULL,
        PRIMARY KEY (tenant_id, evidence_id),
        FOREIGN KEY (tenant_id, migration_id) REFERENCES security_domain_migrations (tenant_id, migration_id)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS consumed_evidence_by_nonce
        ON consumed_security_migration_evidence (tenant_id, nonce);

      CREATE TABLE IF NOT EXISTS command_receipts (
        tenant_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at_utc TEXT NOT NULL,
        PRIMARY KEY (tenant_id, principal_id, operation, idempotency_key),
        FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS project_sequences (
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
        PRIMARY KEY (tenant_id, project_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS domain_events (
        tenant_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_sequence INTEGER NOT NULL,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        aggregate_version INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        occurred_at_utc TEXT NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, event_id),
        UNIQUE (tenant_id, aggregate_type, aggregate_id, aggregate_version),
        UNIQUE (tenant_id, project_id, project_sequence),
        FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS outbox_messages (
        tenant_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'published', 'dead_letter')),
        available_at_utc TEXT NOT NULL,
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
        lease_owner TEXT,
        lease_token TEXT,
        lease_expires_at_utc TEXT,
        last_error TEXT,
        published_at_utc TEXT,
        created_at_utc TEXT NOT NULL,
        PRIMARY KEY (tenant_id, message_id),
        UNIQUE (tenant_id, event_id),
        FOREIGN KEY (tenant_id, event_id) REFERENCES domain_events (tenant_id, event_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS outbox_ready ON outbox_messages (state, available_at_utc, lease_expires_at_utc);

      CREATE TABLE IF NOT EXISTS background_jobs (
        tenant_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        job_type TEXT NOT NULL,
        dedupe_key TEXT,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'completed', 'dead_letter')),
        priority INTEGER NOT NULL,
        available_at_utc TEXT NOT NULL,
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
        lease_owner TEXT,
        lease_token TEXT,
        lease_expires_at_utc TEXT,
        last_error TEXT,
        completed_at_utc TEXT,
        created_at_utc TEXT NOT NULL,
        PRIMARY KEY (tenant_id, job_id),
        UNIQUE (tenant_id, job_type, dedupe_key),
        FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS jobs_ready ON background_jobs (state, priority DESC, available_at_utc, lease_expires_at_utc);

      INSERT OR IGNORE INTO schema_migrations (version, applied_at_utc)
      VALUES (1, '2026-09-03T00:00:00.000Z');
    `);
    this.ensureColumn("principals", "version", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("principals", "updated_at_utc", "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
    this.#database.prepare(`
      INSERT OR IGNORE INTO schema_migrations (version, applied_at_utc) VALUES (2, ?)
    `).run(new Date().toISOString());
    this.#database.prepare(`
      INSERT OR IGNORE INTO schema_migrations (version, applied_at_utc) VALUES (3, ?)
    `).run(new Date().toISOString());
    this.#database.prepare(`
      INSERT OR IGNORE INTO schema_migrations (version, applied_at_utc) VALUES (4, ?)
    `).run(new Date().toISOString());
    this.#database.prepare(`
      INSERT OR IGNORE INTO schema_migrations (version, applied_at_utc) VALUES (5, ?)
    `).run(new Date().toISOString());
    this.#database.prepare(`
      INSERT OR IGNORE INTO schema_migrations (version, applied_at_utc) VALUES (6, ?)
    `).run(new Date().toISOString());
    this.#database.prepare(`
      INSERT OR IGNORE INTO schema_migrations (version, applied_at_utc) VALUES (7, ?)
    `).run(new Date().toISOString());
    this.#database.prepare(`
      INSERT OR IGNORE INTO schema_migrations (version, applied_at_utc) VALUES (8, ?)
    `).run(new Date().toISOString());
    this.#database.prepare(`
      INSERT OR IGNORE INTO schema_migrations (version, applied_at_utc) VALUES (9, ?)
    `).run(new Date().toISOString());
    this.ensureColumn("project_nodes", "leader_principal_id", "TEXT");
    this.#database.prepare(`
      INSERT OR IGNORE INTO schema_migrations (version, applied_at_utc) VALUES (10, ?)
    `).run(new Date().toISOString());
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS project_role_slot_snapshots (
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        source_template_version_id TEXT NOT NULL,
        created_at_utc TEXT NOT NULL,
        created_by_principal_id TEXT NOT NULL,
        PRIMARY KEY (tenant_id, project_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS project_role_slots (
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        slot_key TEXT NOT NULL,
        source_template_version_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        created_at_utc TEXT NOT NULL,
        PRIMARY KEY (tenant_id, project_id, slot_key),
        FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS project_role_bindings (
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        slot_key TEXT NOT NULL,
        principal_ids_json TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        updated_at_utc TEXT NOT NULL,
        updated_by_principal_id TEXT NOT NULL,
        PRIMARY KEY (tenant_id, project_id, slot_key),
        FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
        FOREIGN KEY (tenant_id, project_id, slot_key) REFERENCES project_role_slots (tenant_id, project_id, slot_key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS project_role_slot_audits (
        tenant_id TEXT NOT NULL,
        id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        actor_principal_id TEXT NOT NULL,
        source_template_version_id TEXT NOT NULL,
        action TEXT NOT NULL,
        slot_keys_json TEXT NOT NULL,
        occurred_at_utc TEXT NOT NULL,
        PRIMARY KEY (tenant_id, id),
        FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_project_role_slot_audits_project
        ON project_role_slot_audits (tenant_id, project_id, occurred_at_utc, id);
    `);

    this.#validateV11TableShapes(this.#database);

    this.#database.prepare(`
      INSERT OR IGNORE INTO schema_migrations (version, applied_at_utc) VALUES (11, ?)
    `).run(new Date().toISOString());

    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS deliverable_requirements (
        tenant_id TEXT NOT NULL,
        deliverable_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        owner_node_id TEXT NOT NULL,
        security_domain_id TEXT,
        security_epoch INTEGER NOT NULL CHECK (security_epoch > 0),
        requirement_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'submitted', 'accepted', 'waived', 'evidence_due')),
        version INTEGER NOT NULL CHECK (version > 0),
        deliverable_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, deliverable_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
        FOREIGN KEY (tenant_id, owner_node_id) REFERENCES project_nodes (tenant_id, node_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS deliverable_requirements_by_node
        ON deliverable_requirements (tenant_id, owner_node_id, deliverable_id);
      CREATE INDEX IF NOT EXISTS deliverable_requirements_by_project
        ON deliverable_requirements (tenant_id, project_id, deliverable_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_deliverable_requirements_key
        ON deliverable_requirements (tenant_id, project_id, owner_node_id, requirement_key);

      CREATE TABLE IF NOT EXISTS deliverable_evidence_links (
        tenant_id TEXT NOT NULL,
        link_id TEXT NOT NULL,
        requirement_id TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('file', 'process_record')),
        source_id TEXT NOT NULL,
        submitted_by_principal_id TEXT NOT NULL,
        linked_at_utc TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        PRIMARY KEY (tenant_id, link_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
        FOREIGN KEY (tenant_id, requirement_id) REFERENCES deliverable_requirements (tenant_id, deliverable_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS deliverable_evidence_links_by_requirement
        ON deliverable_evidence_links (tenant_id, requirement_id, link_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_deliverable_evidence_natural_key
        ON deliverable_evidence_links (tenant_id, requirement_id, source_type, source_id);

      CREATE TABLE IF NOT EXISTS deliverable_action_records (
        tenant_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        requirement_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('initialized', 'submitted', 'accepted', 'waived')),
        actor_principal_id TEXT NOT NULL,
        occurred_at_utc TEXT NOT NULL,
        reason TEXT,
        evidence_count INTEGER NOT NULL CHECK (evidence_count >= 0),
        evidence_ids_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, action_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
        FOREIGN KEY (tenant_id, requirement_id) REFERENCES deliverable_requirements (tenant_id, deliverable_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS deliverable_actions_by_requirement
        ON deliverable_action_records (tenant_id, requirement_id, occurred_at_utc, action_id);
    `);

    this.#validateV12TableShapes(this.#database);

    this.#database.prepare(`
      INSERT OR IGNORE INTO schema_migrations (version, applied_at_utc) VALUES (12, ?)
    `).run(new Date().toISOString());
    this.#database.exec("COMMIT");
  } catch (error) {
    this.#database.exec("ROLLBACK");
    throw error;
  }
}

  #validateV11TableShapes(db: DatabaseSync): void {
  const tableSchemas: Record<
    string,
    {
      columns: Record<string, { type: string; notnull: number; pk: number }>;
      foreignKeys: Array<{ table: string; from: string; to: string }>;
    }
  > = {
    project_role_slot_snapshots: {
      columns: {
        tenant_id: { type: "TEXT", notnull: 1, pk: 1 },
        project_id: { type: "TEXT", notnull: 1, pk: 2 },
        source_template_version_id: { type: "TEXT", notnull: 1, pk: 0 },
        created_at_utc: { type: "TEXT", notnull: 1, pk: 0 },
        created_by_principal_id: { type: "TEXT", notnull: 1, pk: 0 },
      },
      foreignKeys: [{ table: "tenants", from: "tenant_id", to: "tenant_id" }],
    },
    project_role_slots: {
      columns: {
        tenant_id: { type: "TEXT", notnull: 1, pk: 1 },
        project_id: { type: "TEXT", notnull: 1, pk: 2 },
        slot_key: { type: "TEXT", notnull: 1, pk: 3 },
        source_template_version_id: { type: "TEXT", notnull: 1, pk: 0 },
        name: { type: "TEXT", notnull: 1, pk: 0 },
        description: { type: "TEXT", notnull: 0, pk: 0 },
        created_at_utc: { type: "TEXT", notnull: 1, pk: 0 },
      },
      foreignKeys: [{ table: "tenants", from: "tenant_id", to: "tenant_id" }],
    },
    project_role_bindings: {
      columns: {
        tenant_id: { type: "TEXT", notnull: 1, pk: 1 },
        project_id: { type: "TEXT", notnull: 1, pk: 2 },
        slot_key: { type: "TEXT", notnull: 1, pk: 3 },
        principal_ids_json: { type: "TEXT", notnull: 1, pk: 0 },
        version: { type: "INTEGER", notnull: 1, pk: 0 },
        updated_at_utc: { type: "TEXT", notnull: 1, pk: 0 },
        updated_by_principal_id: { type: "TEXT", notnull: 1, pk: 0 },
      },
      foreignKeys: [
        { table: "tenants", from: "tenant_id", to: "tenant_id" },
        { table: "project_role_slots", from: "tenant_id", to: "tenant_id" },
        { table: "project_role_slots", from: "project_id", to: "project_id" },
        { table: "project_role_slots", from: "slot_key", to: "slot_key" },
      ],
    },
    project_role_slot_audits: {
      columns: {
        tenant_id: { type: "TEXT", notnull: 1, pk: 1 },
        id: { type: "TEXT", notnull: 1, pk: 2 },
        project_id: { type: "TEXT", notnull: 1, pk: 0 },
        actor_principal_id: { type: "TEXT", notnull: 1, pk: 0 },
        source_template_version_id: { type: "TEXT", notnull: 1, pk: 0 },
        action: { type: "TEXT", notnull: 1, pk: 0 },
        slot_keys_json: { type: "TEXT", notnull: 1, pk: 0 },
        occurred_at_utc: { type: "TEXT", notnull: 1, pk: 0 },
      },
      foreignKeys: [{ table: "tenants", from: "tenant_id", to: "tenant_id" }],
    },
  };

  for (const [tableName, expected] of Object.entries(tableSchemas)) {
    const ddlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
      | { sql?: string }
      | undefined;
    if (!ddlRow?.sql) {
      throw new Error(`SQLITE_SCHEMA_INCOMPATIBLE: table ${tableName} missing`);
    }
    if (!/\bSTRICT\b/i.test(ddlRow.sql)) {
      throw new Error(`SQLITE_SCHEMA_INCOMPATIBLE: table ${tableName} not STRICT`);
    }

    if (tableName === "project_role_bindings") {
      if (!/\bCHECK\s*\(\s*version\s*>\s*0\s*\)/i.test(ddlRow.sql)) {
        throw new Error("SQLITE_SCHEMA_INCOMPATIBLE: table project_role_bindings missing CHECK (version > 0)");
      }
    }

    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>;

    const colMap = new Map(cols.map((c) => [c.name, c]));
    if (cols.length !== Object.keys(expected.columns).length) {
      throw new Error(
        `SQLITE_SCHEMA_INCOMPATIBLE: table ${tableName} column count mismatch: expected ${Object.keys(expected.columns).length}, got ${cols.length}`,
      );
    }

    for (const [colName, exp] of Object.entries(expected.columns)) {
      const actual = colMap.get(colName);
      if (!actual) {
        throw new Error(`SQLITE_SCHEMA_INCOMPATIBLE: table ${tableName} missing column ${colName}`);
      }
      if (actual.type.toUpperCase() !== exp.type || actual.notnull !== exp.notnull || actual.pk !== exp.pk) {
        throw new Error(`SQLITE_SCHEMA_INCOMPATIBLE: table ${tableName} column ${colName} shape mismatch`);
      }
    }

    const fks = db.prepare(`PRAGMA foreign_key_list(${tableName})`).all() as Array<{
      table: string;
      from: string;
      to: string;
    }>;

    for (const expFk of expected.foreignKeys) {
      const match = fks.some((f) => f.table === expFk.table && f.from === expFk.from && f.to === expFk.to);
      if (!match) {
        throw new Error(
          `SQLITE_SCHEMA_INCOMPATIBLE: table ${tableName} missing foreign key ${expFk.from} -> ${expFk.table}(${expFk.to})`,
        );
      }
    }
  }

  const idxRow = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_project_role_slot_audits_project'",
  ).get() as { name?: string; sql?: string } | undefined;
  if (!idxRow?.name || !idxRow.sql) {
    throw new Error("SQLITE_SCHEMA_INCOMPATIBLE: index idx_project_role_slot_audits_project missing");
  }
  if (
    !/ON\s+project_role_slot_audits\s*\(\s*tenant_id\s*,\s*project_id\s*,\s*occurred_at_utc\s*,\s*id\s*\)/i.test(
      idxRow.sql,
    )
  ) {
    throw new Error("SQLITE_SCHEMA_INCOMPATIBLE: index idx_project_role_slot_audits_project definition mismatch");
  }
}

  #validateV12TableShapes(db: DatabaseSync): void {
    const tableSchemas: Record<
      string,
      {
        columns: Record<string, { type: string; notnull: number; pk: number }>;
        foreignKeys: Array<{ table: string; from: string; to: string }>;
      }
    > = {
      deliverable_requirements: {
        columns: {
          tenant_id: { type: "TEXT", notnull: 1, pk: 1 },
          deliverable_id: { type: "TEXT", notnull: 1, pk: 2 },
          project_id: { type: "TEXT", notnull: 1, pk: 0 },
          owner_node_id: { type: "TEXT", notnull: 1, pk: 0 },
          security_domain_id: { type: "TEXT", notnull: 0, pk: 0 },
          security_epoch: { type: "INTEGER", notnull: 1, pk: 0 },
          requirement_key: { type: "TEXT", notnull: 1, pk: 0 },
          status: { type: "TEXT", notnull: 1, pk: 0 },
          version: { type: "INTEGER", notnull: 1, pk: 0 },
          deliverable_json: { type: "TEXT", notnull: 1, pk: 0 },
        },
        foreignKeys: [
          { table: "tenants", from: "tenant_id", to: "tenant_id" },
          { table: "project_nodes", from: "tenant_id", to: "tenant_id" },
          { table: "project_nodes", from: "owner_node_id", to: "node_id" },
        ],
      },
      deliverable_evidence_links: {
        columns: {
          tenant_id: { type: "TEXT", notnull: 1, pk: 1 },
          link_id: { type: "TEXT", notnull: 1, pk: 2 },
          requirement_id: { type: "TEXT", notnull: 1, pk: 0 },
          source_type: { type: "TEXT", notnull: 1, pk: 0 },
          source_id: { type: "TEXT", notnull: 1, pk: 0 },
          submitted_by_principal_id: { type: "TEXT", notnull: 1, pk: 0 },
          linked_at_utc: { type: "TEXT", notnull: 1, pk: 0 },
          version: { type: "INTEGER", notnull: 1, pk: 0 },
        },
        foreignKeys: [
          { table: "tenants", from: "tenant_id", to: "tenant_id" },
          { table: "deliverable_requirements", from: "tenant_id", to: "tenant_id" },
          { table: "deliverable_requirements", from: "requirement_id", to: "deliverable_id" },
        ],
      },
      deliverable_action_records: {
        columns: {
          tenant_id: { type: "TEXT", notnull: 1, pk: 1 },
          action_id: { type: "TEXT", notnull: 1, pk: 2 },
          requirement_id: { type: "TEXT", notnull: 1, pk: 0 },
          action: { type: "TEXT", notnull: 1, pk: 0 },
          actor_principal_id: { type: "TEXT", notnull: 1, pk: 0 },
          occurred_at_utc: { type: "TEXT", notnull: 1, pk: 0 },
          reason: { type: "TEXT", notnull: 0, pk: 0 },
          evidence_count: { type: "INTEGER", notnull: 1, pk: 0 },
          evidence_ids_json: { type: "TEXT", notnull: 1, pk: 0 },
        },
        foreignKeys: [
          { table: "tenants", from: "tenant_id", to: "tenant_id" },
          { table: "deliverable_requirements", from: "tenant_id", to: "tenant_id" },
          { table: "deliverable_requirements", from: "requirement_id", to: "deliverable_id" },
        ],
      },
    };

    for (const [tableName, expected] of Object.entries(tableSchemas)) {
      const ddlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
        | { sql?: string }
        | undefined;
      if (!ddlRow?.sql) {
        throw new Error(`SQLITE_SCHEMA_INCOMPATIBLE: table ${tableName} missing`);
      }
      if (!/\bSTRICT\b/i.test(ddlRow.sql)) {
        throw new Error(`SQLITE_SCHEMA_INCOMPATIBLE: table ${tableName} not STRICT`);
      }

      if (tableName === "deliverable_requirements") {
        if (!/\bCHECK\s*\(\s*security_epoch\s*>\s*0\s*\)/i.test(ddlRow.sql)) {
          throw new Error("SQLITE_SCHEMA_INCOMPATIBLE: table deliverable_requirements missing CHECK (security_epoch > 0)");
        }
        if (!/\bCHECK\s*\(\s*version\s*>\s*0\s*\)/i.test(ddlRow.sql)) {
          throw new Error("SQLITE_SCHEMA_INCOMPATIBLE: table deliverable_requirements missing CHECK (version > 0)");
        }
        if (!/\bCHECK\s*\(\s*status\s+IN\s*\(\s*'pending'\s*,\s*'submitted'\s*,\s*'accepted'\s*,\s*'waived'\s*,\s*'evidence_due'\s*\)\s*\)/i.test(ddlRow.sql)) {
          throw new Error("SQLITE_SCHEMA_INCOMPATIBLE: table deliverable_requirements status CHECK enum mismatch");
        }
      }

      if (tableName === "deliverable_evidence_links") {
        if (!/\bCHECK\s*\(\s*version\s*>\s*0\s*\)/i.test(ddlRow.sql)) {
          throw new Error("SQLITE_SCHEMA_INCOMPATIBLE: table deliverable_evidence_links missing CHECK (version > 0)");
        }
        if (!/\bCHECK\s*\(\s*source_type\s+IN\s*\(\s*'file'\s*,\s*'process_record'\s*\)\s*\)/i.test(ddlRow.sql)) {
          throw new Error("SQLITE_SCHEMA_INCOMPATIBLE: table deliverable_evidence_links source_type CHECK enum mismatch");
        }
      }

      if (tableName === "deliverable_action_records") {
        if (!/\bCHECK\s*\(\s*evidence_count\s*>=\s*0\s*\)/i.test(ddlRow.sql)) {
          throw new Error("SQLITE_SCHEMA_INCOMPATIBLE: table deliverable_action_records missing CHECK (evidence_count >= 0)");
        }
        if (!/\bCHECK\s*\(\s*action\s+IN\s*\(\s*'initialized'\s*,\s*'submitted'\s*,\s*'accepted'\s*,\s*'waived'\s*\)\s*\)/i.test(ddlRow.sql)) {
          throw new Error("SQLITE_SCHEMA_INCOMPATIBLE: table deliverable_action_records action CHECK enum mismatch");
        }
      }

      const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
        pk: number;
      }>;

      const colMap = new Map(cols.map((c) => [c.name, c]));
      if (cols.length !== Object.keys(expected.columns).length) {
        throw new Error(
          `SQLITE_SCHEMA_INCOMPATIBLE: table ${tableName} column count mismatch: expected ${Object.keys(expected.columns).length}, got ${cols.length}`,
        );
      }

      for (const [colName, exp] of Object.entries(expected.columns)) {
        const actual = colMap.get(colName);
        if (!actual) {
          throw new Error(`SQLITE_SCHEMA_INCOMPATIBLE: table ${tableName} missing column ${colName}`);
        }
        if (actual.type.toUpperCase() !== exp.type || actual.notnull !== exp.notnull || actual.pk !== exp.pk) {
          throw new Error(`SQLITE_SCHEMA_INCOMPATIBLE: table ${tableName} column ${colName} shape mismatch`);
        }
      }

      const fks = db.prepare(`PRAGMA foreign_key_list(${tableName})`).all() as Array<{
        table: string;
        from: string;
        to: string;
      }>;

      for (const expFk of expected.foreignKeys) {
        const match = fks.some((f) => f.table === expFk.table && f.from === expFk.from && f.to === expFk.to);
        if (!match) {
          throw new Error(
            `SQLITE_SCHEMA_INCOMPATIBLE: table ${tableName} missing foreign key ${expFk.from} -> ${expFk.table}(${expFk.to})`,
          );
        }
      }
    }

    const expectedIndexes = [
      {
        table: "deliverable_requirements",
        name: "deliverable_requirements_by_node",
        unique: 0,
        columns: ["tenant_id", "owner_node_id", "deliverable_id"],
      },
      {
        table: "deliverable_requirements",
        name: "deliverable_requirements_by_project",
        unique: 0,
        columns: ["tenant_id", "project_id", "deliverable_id"],
      },
      {
        table: "deliverable_requirements",
        name: "uq_deliverable_requirements_key",
        unique: 1,
        columns: ["tenant_id", "project_id", "owner_node_id", "requirement_key"],
      },
      {
        table: "deliverable_evidence_links",
        name: "deliverable_evidence_links_by_requirement",
        unique: 0,
        columns: ["tenant_id", "requirement_id", "link_id"],
      },
      {
        table: "deliverable_evidence_links",
        name: "uq_deliverable_evidence_natural_key",
        unique: 1,
        columns: ["tenant_id", "requirement_id", "source_type", "source_id"],
      },
      {
        table: "deliverable_action_records",
        name: "deliverable_actions_by_requirement",
        unique: 0,
        columns: ["tenant_id", "requirement_id", "occurred_at_utc", "action_id"],
      },
    ] as const;

    for (const expIdx of expectedIndexes) {
      const indexes = db.prepare(`PRAGMA index_list(${expIdx.table})`).all() as Array<{
        name: string;
        unique: number;
        partial: number;
      }>;
      const actual = indexes.find((index) => index.name === expIdx.name);
      if (actual === undefined) {
        throw new Error(`SQLITE_SCHEMA_INCOMPATIBLE: index ${expIdx.name} missing`);
      }
      if (actual.unique !== expIdx.unique) {
        throw new Error(`SQLITE_SCHEMA_INCOMPATIBLE: index ${expIdx.name} uniqueness mismatch`);
      }
      if (actual.partial !== 0) {
        throw new Error(`SQLITE_SCHEMA_INCOMPATIBLE: index ${expIdx.name} must cover the full table`);
      }
      const columns = db.prepare(`PRAGMA index_info(${expIdx.name})`).all() as Array<{
        seqno: number;
        name: string;
      }>;
      const names = columns.sort((a, b) => a.seqno - b.seqno).map((column) => column.name);
      if (names.length !== expIdx.columns.length || names.some((name, index) => name !== expIdx.columns[index])) {
        throw new Error(`SQLITE_SCHEMA_INCOMPATIBLE: index ${expIdx.name} definition mismatch`);
      }
      if (expIdx.unique === 1) {
        const keyColumns = (db.prepare(`PRAGMA index_xinfo(${expIdx.name})`).all() as Array<{
          seqno: number;
          cid: number;
          name: string | null;
          desc: number;
          coll: string;
          key: number;
        }>).filter((column) => column.key === 1).sort((a, b) => a.seqno - b.seqno);
        if (
          keyColumns.length !== expIdx.columns.length
          || keyColumns.some((column, index) =>
            column.cid < 0
            || column.name !== expIdx.columns[index]
            || column.desc !== 0
            || column.coll.toUpperCase() !== "BINARY")
        ) {
          throw new Error(`SQLITE_SCHEMA_INCOMPATIBLE: index ${expIdx.name} key definition mismatch`);
        }
        const indexDdl = db.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
        ).get(expIdx.name) as { sql?: string } | undefined;
        const escapedColumns = expIdx.columns.map((column) => column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        const definition = new RegExp(
          `^CREATE\\s+UNIQUE\\s+INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${expIdx.name}\\s+ON\\s+${expIdx.table}\\s*\\(\\s*${escapedColumns.join("\\s*,\\s*")}\\s*\\)\\s*$`,
          "i",
        );
        if (!indexDdl?.sql || !definition.test(indexDdl.sql)) {
          throw new Error(`SQLITE_SCHEMA_INCOMPATIBLE: index ${expIdx.name} unique definition mismatch`);
        }
      }
    }
  }

  private assertSupportedSchema(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at_utc TEXT NOT NULL
      ) STRICT;
    `);
    const row = this.#database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
    const version = row?.version;
    if (typeof version === "number" && version > currentSchemaVersion) {
      this.#database.close();
      this.#closed = true;
      throw new Error(`SQLITE_SCHEMA_VERSION_UNSUPPORTED:${version}`);
    }
  }

  private ensureColumn(table: "principals" | "project_nodes", column: string, definition: string): void {
    const columns = this.#database.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((value) => value.name === column)) this.#database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private ensureTenant(tenantId: TenantId): void {
    this.#database.prepare(`
      INSERT OR IGNORE INTO tenants (tenant_id, state, created_at_utc)
      VALUES (?, 'active', ?)
    `).run(tenantId, new Date().toISOString());
  }

  private async countReady(table: QueueTable, nowUtc: string): Promise<number> {
    return await this.exclusive(async () => {
      this.ensureOpen();
      const row = this.#database.prepare(`
        SELECT COUNT(*) AS count FROM ${table}
        WHERE (state = 'pending' AND available_at_utc <= ?)
           OR (state = 'leased' AND lease_expires_at_utc <= ?)
      `).get(nowUtc, nowUtc);
      return row === undefined ? 0 : asNumber(row.count);
    });
  }

  private async claimOutbox(options: ClaimOptions): Promise<OutboxMessage[]> {
    return await this.claimQueue("outbox_messages", "message_id", options, outboxFromRow);
  }

  private async claimJobs(options: ClaimOptions): Promise<BackgroundJob[]> {
    return await this.claimQueue("background_jobs", "job_id", options, jobFromRow);
  }

  private async claimQueue<T>(
    table: QueueTable,
    idColumn: "message_id" | "job_id",
    options: ClaimOptions,
    decode: (row: Record<string, unknown>) => T,
  ): Promise<T[]> {
    validateClaim(options);
    return await this.exclusive(async () => {
      this.ensureOpen();
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        const order = table === "background_jobs" ? "priority DESC, available_at_utc, job_id" : "available_at_utc, message_id";
        const rows = this.#database.prepare(`
          SELECT tenant_id, ${idColumn} AS queue_id FROM ${table}
          WHERE (state = 'pending' AND available_at_utc <= ?)
             OR (state = 'leased' AND lease_expires_at_utc <= ?)
          ORDER BY ${order}
          LIMIT ?
        `).all(options.nowUtc, options.nowUtc, options.limit);
        const claimed: T[] = [];
        for (const row of rows) {
          const tenant = asString(row.tenant_id);
          const id = asString(row.queue_id);
          const leaseToken = randomUUID();
          this.#database.prepare(`
            UPDATE ${table}
            SET state = 'leased', attempts = attempts + 1, lease_owner = ?, lease_token = ?, lease_expires_at_utc = ?
            WHERE tenant_id = ? AND ${idColumn} = ?
          `).run(options.workerId, leaseToken, options.leaseUntilUtc, tenant, id);
          const claimedRow = this.#database.prepare(
            `SELECT * FROM ${table} WHERE tenant_id = ? AND ${idColumn} = ?`,
          ).get(tenant, id);
          if (claimedRow !== undefined) claimed.push(decode(claimedRow));
        }
        this.#database.exec("COMMIT");
        return claimed;
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  private async completeQueue(
    table: QueueTable,
    tenantId: TenantId,
    id: string,
    leaseToken: string,
    completedState: "published" | "completed",
    completedColumn: "published_at_utc" | "completed_at_utc",
    completedAtUtc: string,
  ): Promise<boolean> {
    return await this.exclusive(async () => {
      const idColumn = table === "outbox_messages" ? "message_id" : "job_id";
      const result = this.#database.prepare(`
        UPDATE ${table}
        SET state = ?, ${completedColumn} = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at_utc = NULL
        WHERE tenant_id = ? AND ${idColumn} = ? AND state = 'leased' AND lease_token = ?
      `).run(completedState, completedAtUtc, tenantId, id, leaseToken);
      return result.changes === 1;
    });
  }

  private async releaseQueue(
    table: QueueTable,
    tenantId: TenantId,
    id: string,
    leaseToken: string,
    nextAttemptAtUtc: string,
    error: string,
  ): Promise<"retry" | "dead_letter" | "lease_lost"> {
    return await this.exclusive(async () => {
      const idColumn = table === "outbox_messages" ? "message_id" : "job_id";
      const row = this.#database.prepare(`
        UPDATE ${table}
        SET state = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'pending' END,
            available_at_utc = ?, last_error = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at_utc = NULL
        WHERE tenant_id = ? AND ${idColumn} = ? AND state = 'leased' AND lease_token = ?
        RETURNING state
      `).get(nextAttemptAtUtc, error, tenantId, id, leaseToken);
      if (row === undefined) return "lease_lost";
      return asString(row.state) === "dead_letter" ? "dead_letter" : "retry";
    });
  }

  private async markJobDeadLetter(tenantId: TenantId, jobId: string, leaseToken: string, error: string): Promise<boolean> {
    return await this.exclusive(async () => {
      const result = this.#database.prepare(`
        UPDATE background_jobs
        SET state = 'dead_letter', last_error = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at_utc = NULL
        WHERE tenant_id = ? AND job_id = ? AND state = 'leased' AND lease_token = ?
      `).run(error, tenantId, jobId, leaseToken);
      return result.changes === 1;
    });
  }

  private async deferJob(tenantId: TenantId, jobId: string, leaseToken: string, availableAtUtc: string): Promise<boolean> {
    return await this.exclusive(async () => {
      const result = this.#database.prepare(`
        UPDATE background_jobs
        SET state = 'pending', available_at_utc = ?, attempts = MAX(0, attempts - 1),
            lease_owner = NULL, lease_token = NULL, lease_expires_at_utc = NULL
        WHERE tenant_id = ? AND job_id = ? AND state = 'leased' AND lease_token = ?
      `).run(availableAtUtc, tenantId, jobId, leaseToken);
      return result.changes === 1;
    });
  }

  private hasActiveFenceOrUnresolvedOperationInMigrationScope(
    tenantId: TenantId,
    migration: SecurityDomainMigration,
    trustedNowUtc: string,
  ): boolean {
    const activeFences = this.#database.prepare(`
      SELECT fence_id, owner_node_id FROM outbound_projection_fences
      WHERE tenant_id = ? AND project_id = ? AND expires_at_utc > ?
    `).all(tenantId, migration.projectId, trustedNowUtc);

    const allOps = this.#database.prepare(`
      SELECT tenant_id, operation_id, operation_type, subject_type, subject_id, state, version, operation_json
      FROM integration_operations
      WHERE tenant_id = ?
    `).all(tenantId) as Array<Record<string, unknown>>;

    if (activeFences.length === 0 && allOps.length === 0) {
      return false;
    }

    const migrationRoot = this.#database.prepare(`
      SELECT node_id, project_id, deleted_at_utc
      FROM project_nodes
      WHERE tenant_id = ? AND node_id = ?
    `).get(tenantId, migration.rootNodeId);
    if (migrationRoot === undefined || asString(migrationRoot.project_id) !== migration.projectId
      || migrationRoot.deleted_at_utc !== null) {
      return true;
    }

    for (const fence of activeFences) {
      const visited = new Set<string>();
      let currentId: string | null = asString(fence.owner_node_id);
      while (currentId !== null) {
        if (visited.has(currentId)) return true;
        visited.add(currentId);
        const ancestorNode = this.#database.prepare(`
          SELECT node_id, project_id, parent_node_id, deleted_at_utc
          FROM project_nodes
          WHERE tenant_id = ? AND node_id = ?
        `).get(tenantId, currentId) as Record<string, unknown> | undefined;
        if (ancestorNode === undefined || asString(ancestorNode.project_id) !== migration.projectId || ancestorNode.deleted_at_utc !== null) {
          return true;
        }
        if (asString(ancestorNode.node_id) === migration.rootNodeId) return true;
        currentId = ancestorNode.parent_node_id === null ? null : asString(ancestorNode.parent_node_id);
      }
    }

    for (const rawOp of allOps) {
      let op: IntegrationOperation;
      try {
        op = integrationOperationFromRow(rawOp);
      } catch {
        return true;
      }

      if (op.tenantId !== tenantId) return true;

      // Only after successful validation may consistently terminal completed/compensated operations be skipped
      if (op.state === "completed" || op.state === "compensated") {
        continue;
      }

      // Only after successful validation may known non-collaboration operations be skipped
      if (op.operationType !== "collaboration.task.project" && op.operationType !== "collaboration.asset.project") {
        if (op.operationType === "asset.ingest" || op.operationType === "blob.delete") {
          continue;
        }
        return true;
      }

      const subjectType = (op as { subjectType?: unknown }).subjectType;
      if (subjectType !== "task" && subjectType !== "asset") {
        return true;
      }

      if (!op.subjectId || typeof op.subjectId !== "string") {
        return true;
      }

      let ownerNodeId: string | null = null;
      if (subjectType === "task") {
        const row = this.#database.prepare(`
          SELECT tenant_id, task_id, project_id, owner_node_id, lifecycle_state, version, task_json
          FROM product_tasks
          WHERE tenant_id = ? AND task_id = ?
        `).get(tenantId, op.subjectId);
        if (row === undefined) return true;
        let task: ProductTask;
        try {
          task = productTaskFromRow(row as Record<string, unknown>);
        } catch {
          return true;
        }
        if (task.projectId !== migration.projectId) continue;
        if (task.deletedAtUtc !== null) {
          return true;
        }
        ownerNodeId = task.ownerNodeId;
      } else if (subjectType === "asset") {
        const row = this.#database.prepare(`
          SELECT tenant_id, asset_id, project_id, owner_node_id, lifecycle_state, version, asset_json
          FROM assets
          WHERE tenant_id = ? AND asset_id = ?
        `).get(tenantId, op.subjectId);
        if (row === undefined) return true;
        let asset: Asset;
        try {
          asset = assetFromRow(row as Record<string, unknown>);
        } catch {
          return true;
        }
        if (asset.projectId !== migration.projectId) continue;
        if (asset.deletedAtUtc !== null) {
          return true;
        }
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
        const ancestorNode = this.#database.prepare(`
          SELECT node_id, project_id, parent_node_id, deleted_at_utc
          FROM project_nodes
          WHERE tenant_id = ? AND node_id = ?
        `).get(tenantId, currentId) as Record<string, unknown> | undefined;
        if (ancestorNode === undefined || asString(ancestorNode.project_id) !== migration.projectId || ancestorNode.deleted_at_utc !== null) {
          return true;
        }
        if (asString(ancestorNode.node_id) === migration.rootNodeId) return true;
        currentId = ancestorNode.parent_node_id === null ? null : asString(ancestorNode.parent_node_id);
      }
    }

    return false;
  }

  private migrationForObjectWrite(tenantId: TenantId, migrationId: string): SecurityDomainMigration {
    const row = this.#database.prepare(
      "SELECT * FROM security_domain_migrations WHERE tenant_id = ? AND migration_id = ?",
    ).get(tenantId, migrationId);
    if (row === undefined) throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
    const migration = securityMigrationFromRow(row);
    if (migration.state !== "active" || migration.sourceSecurityEpoch <= 0 || migration.targetSecurityEpoch <= 0
      || (migration.sourceSecurityDomainId === migration.targetSecurityDomainId
        && migration.sourceSecurityEpoch === migration.targetSecurityEpoch)) {
      throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
    }
    return migration;
  }

  private migrationForObjectRollback(tenantId: TenantId, migrationId: string): SecurityDomainMigration {
    const row = this.#database.prepare(
      "SELECT * FROM security_domain_migrations WHERE tenant_id = ? AND migration_id = ?",
    ).get(tenantId, migrationId);
    if (row === undefined) throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
    const migration = securityMigrationFromRow(row);
    if (!["planned", "active", "verifying", "retryable", "recovery_required"].includes(migration.state)
      || migration.sourceSecurityEpoch <= 0 || migration.targetSecurityEpoch <= 0
      || (migration.sourceSecurityDomainId === migration.targetSecurityDomainId
        && migration.sourceSecurityEpoch === migration.targetSecurityEpoch)) {
      throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
    }
    return migration;
  }

  private collectSubtreeDepths(tenantId: TenantId, projectId: string, rootNodeId: string): Map<string, number> {
    const rows = this.#database.prepare(`
      SELECT node_id, parent_node_id, deleted_at_utc
      FROM project_nodes
      WHERE tenant_id = ? AND project_id = ?
    `).all(tenantId, projectId) as Array<Record<string, unknown>>;

    const byParent = new Map<string | null, string[]>();
    for (const row of rows) {
      if (row.deleted_at_utc !== null) continue;
      const id = asString(row.node_id);
      const parentId = row.parent_node_id === null ? null : asString(row.parent_node_id);
      const list = byParent.get(parentId) ?? [];
      list.push(id);
      byParent.set(parentId, list);
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
  }

  private async assertActorAuthorizedForMigration(
    context: TransactionContext,
    tenantId: TenantId,
    migration: SecurityDomainMigration,
    actorPrincipalId: PrincipalId,
    nowUtc: string,
  ): Promise<void> {
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
      nowUtc,
    );
    if (!authorized) {
      throw new Error("NODE_NOT_FOUND");
    }
  }

  private collectSubtreeNodeIds(tenantId: TenantId, projectId: string, rootNodeId: string): Set<string> {
    const rows = this.#database.prepare(`
      SELECT node_id, parent_node_id, deleted_at_utc
      FROM project_nodes
      WHERE tenant_id = ? AND project_id = ?
    `).all(tenantId, projectId) as Array<Record<string, unknown>>;

    const byParent = new Map<string | null, string[]>();
    for (const row of rows) {
      if (row.deleted_at_utc !== null) continue;
      const id = asString(row.node_id);
      const parentId = row.parent_node_id === null ? null : asString(row.parent_node_id);
      const list = byParent.get(parentId) ?? [];
      list.push(id);
      byParent.set(parentId, list);
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

  private hasIncompleteInventoryObjectsInMigrationScope(
    tenantId: TenantId,
    migration: SecurityDomainMigration,
  ): boolean {
    const rootRow = this.#database.prepare(`
      SELECT * FROM project_nodes WHERE tenant_id = ? AND node_id = ?
    `).get(tenantId, migration.rootNodeId) as Record<string, unknown> | undefined;
    if (rootRow === undefined || asString(rootRow.project_id) !== migration.projectId || rootRow.deleted_at_utc !== null) {
      return true;
    }
    const subtree = this.collectSubtreeNodeIds(tenantId, migration.projectId, migration.rootNodeId);

    for (const nodeId of subtree) {
      const nodeRow = this.#database.prepare(`
        SELECT * FROM project_nodes WHERE tenant_id = ? AND node_id = ?
      `).get(tenantId, nodeId) as Record<string, unknown> | undefined;
      if (nodeRow === undefined) return true;
      const node = nodeFromRow(nodeRow);
      if (node.securityDomainId !== migration.targetSecurityDomainId
        || node.securityEpoch !== migration.targetSecurityEpoch) {
        return true;
      }
    }

    const taskRows = this.#database.prepare(`
      SELECT * FROM product_tasks WHERE tenant_id = ? AND project_id = ?
    `).all(tenantId, migration.projectId) as Array<Record<string, unknown>>;
    for (const taskRow of taskRows) {
      const task = productTaskFromRow(taskRow);
      if (task.deletedAtUtc !== null) continue;
      if (subtree.has(task.ownerNodeId)) {
        if (task.securityDomainId !== migration.targetSecurityDomainId
          || task.securityEpoch !== migration.targetSecurityEpoch) {
          return true;
        }
      }
    }

    const assetRows = this.#database.prepare(`
      SELECT * FROM assets WHERE tenant_id = ? AND project_id = ?
    `).all(tenantId, migration.projectId) as Array<Record<string, unknown>>;
    for (const assetRow of assetRows) {
      const asset = assetFromRow(assetRow);
      if (asset.deletedAtUtc !== null) continue;
      if (subtree.has(asset.ownerNodeId)) {
        if (asset.securityDomainId !== migration.targetSecurityDomainId
          || asset.securityEpoch !== migration.targetSecurityEpoch) {
          return true;
        }
      }
    }

    const deliverableRows = this.#database.prepare(`
      SELECT * FROM deliverable_requirements WHERE tenant_id = ? AND project_id = ?
    `).all(tenantId, migration.projectId) as Array<Record<string, unknown>>;
    for (const deliverableRow of deliverableRows) {
      const deliverable = deliverableRequirementFromRow(deliverableRow);
      if (deliverable.deletedAtUtc !== null) continue;
      if (subtree.has(deliverable.ownerNodeId)) {
        if (deliverable.securityDomainId !== migration.targetSecurityDomainId
          || deliverable.securityEpoch !== migration.targetSecurityEpoch) {
          return true;
        }
      }
    }

    return false;
  }

  private hasObjectsNotRevertedToSourceInMigrationScope(
    tenantId: TenantId,
    migration: SecurityDomainMigration,
  ): boolean {
    const rootRow = this.#database.prepare(`
      SELECT * FROM project_nodes WHERE tenant_id = ? AND node_id = ?
    `).get(tenantId, migration.rootNodeId) as Record<string, unknown> | undefined;
    if (rootRow === undefined || asString(rootRow.project_id) !== migration.projectId || rootRow.deleted_at_utc !== null) {
      return true;
    }
    const subtree = this.collectSubtreeNodeIds(tenantId, migration.projectId, migration.rootNodeId);

    for (const nodeId of subtree) {
      const nodeRow = this.#database.prepare(`
        SELECT * FROM project_nodes WHERE tenant_id = ? AND node_id = ?
      `).get(tenantId, nodeId) as Record<string, unknown> | undefined;
      if (nodeRow === undefined) return true;
      const node = nodeFromRow(nodeRow);
      if (node.securityDomainId !== migration.sourceSecurityDomainId
        || node.securityEpoch !== migration.sourceSecurityEpoch) {
        return true;
      }
    }

    const taskRows = this.#database.prepare(`
      SELECT * FROM product_tasks WHERE tenant_id = ? AND project_id = ?
    `).all(tenantId, migration.projectId) as Array<Record<string, unknown>>;
    for (const taskRow of taskRows) {
      const task = productTaskFromRow(taskRow);
      if (task.deletedAtUtc !== null) continue;
      if (subtree.has(task.ownerNodeId)) {
        if (task.securityDomainId !== migration.sourceSecurityDomainId
          || task.securityEpoch !== migration.sourceSecurityEpoch) {
          return true;
        }
      }
    }

    const assetRows = this.#database.prepare(`
      SELECT * FROM assets WHERE tenant_id = ? AND project_id = ?
    `).all(tenantId, migration.projectId) as Array<Record<string, unknown>>;
    for (const assetRow of assetRows) {
      const asset = assetFromRow(assetRow);
      if (asset.deletedAtUtc !== null) continue;
      if (subtree.has(asset.ownerNodeId)) {
        if (asset.securityDomainId !== migration.sourceSecurityDomainId
          || asset.securityEpoch !== migration.sourceSecurityEpoch) {
          return true;
        }
      }
    }

    const deliverableRows = this.#database.prepare(`
      SELECT * FROM deliverable_requirements WHERE tenant_id = ? AND project_id = ?
    `).all(tenantId, migration.projectId) as Array<Record<string, unknown>>;
    for (const deliverableRow of deliverableRows) {
      const deliverable = deliverableRequirementFromRow(deliverableRow);
      if (deliverable.deletedAtUtc !== null) continue;
      if (subtree.has(deliverable.ownerNodeId)) {
        if (deliverable.securityDomainId !== migration.sourceSecurityDomainId
          || deliverable.securityEpoch !== migration.sourceSecurityEpoch) {
          return true;
        }
      }
    }

    return false;
  }

  private assertMigrationScope(
    tenantId: TenantId,
    migration: SecurityDomainMigration,
    ownerNodeId: string,
  ): void {
    const visited = new Set<string>();
    let currentId: string | null = ownerNodeId;
    while (currentId !== null) {
      if (visited.has(currentId)) throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
      visited.add(currentId);
      const row = this.#database.prepare(
        "SELECT * FROM project_nodes WHERE tenant_id = ? AND node_id = ?",
      ).get(tenantId, currentId);
      if (row === undefined) throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
      const current = nodeFromRow(row);
      if (current.projectId !== migration.projectId) throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
      if (current.id === migration.rootNodeId) return;
      currentId = current.parentId;
    }
    throw new Error("SECURITY_MIGRATION_OBJECT_NOT_ELIGIBLE");
  }

  private ensureOpen(): void {
    if (this.#closed) throw new Error("SQLITE_PERSISTENCE_CLOSED");
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = pathLocks.get(this.#lockKey) ?? Promise.resolve();
    let unlock = (): void => {};
    const current = new Promise<void>((resolveLock) => { unlock = resolveLock; });
    pathLocks.set(this.#lockKey, current);
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
      if (pathLocks.get(this.#lockKey) === current) pathLocks.delete(this.#lockKey);
    }
  }
}

type QueueTable = "outbox_messages" | "background_jobs";

function nodeFromRow(row: Record<string, unknown>): ProjectNode {
  return {
    tenantId: parseTenantId(asString(row.tenant_id)),
    id: asString(row.node_id),
    projectId: asString(row.project_id),
    parentId: nullableString(row.parent_node_id),
    leaderPrincipalId: nullablePrincipalId(row.leader_principal_id),
    title: asString(row.title),
    kind: asNodeKind(row.kind),
    securityDomainId: nullableString(row.security_domain_id),
    securityEpoch: asNumber(row.security_epoch),
    version: asNumber(row.version),
    deletedAtUtc: nullableString(row.deleted_at_utc),
  };
}

function nullablePrincipalId(value: unknown): PrincipalId | null {
  const parsed = nullableString(value);
  return parsed === null ? null : parsePrincipalId(parsed);
}

function productTaskFromRow(row: Record<string, unknown>): ProductTask {
  const task = productTaskFromJson(asString(row.task_json));
  if (task.tenantId !== asString(row.tenant_id) || task.id !== asString(row.task_id)
    || task.projectId !== asString(row.project_id) || task.ownerNodeId !== asString(row.owner_node_id)
    || task.executionState !== asString(row.lifecycle_state) || task.version !== asNumber(row.version)) {
    throw new Error("TASK_PERSISTENCE_INCONSISTENT");
  }
  return task;
}

function assetFromRow(row: Record<string, unknown>): Asset {
  const asset = parseJson<Asset>(asString(row.asset_json));
  if (asset.tenantId !== asString(row.tenant_id) || asset.id !== asString(row.asset_id)
    || asset.projectId !== asString(row.project_id) || asset.ownerNodeId !== asString(row.owner_node_id)
    || asset.lifecycleState !== asString(row.lifecycle_state) || asset.version !== asNumber(row.version)) {
    throw new Error("ASSET_PERSISTENCE_INCONSISTENT");
  }
  return asset;
}

function deliverableRequirementFromRow(row: Record<string, unknown>): DeliverableRequirement {
  let req: DeliverableRequirement;
  try {
    req = parseJson<DeliverableRequirement>(asString(row.deliverable_json));
  } catch {
    throw new Error("DELIVERABLE_RECORD_CORRUPT: malformed deliverable_json");
  }
  const rowSecDomain = row.security_domain_id !== null && row.security_domain_id !== undefined
    ? asString(row.security_domain_id)
    : null;
  if (
    req.tenantId !== asString(row.tenant_id) ||
    req.id !== asString(row.deliverable_id) ||
    req.projectId !== asString(row.project_id) ||
    req.ownerNodeId !== asString(row.owner_node_id) ||
    (req.securityDomainId ?? null) !== rowSecDomain ||
    req.securityEpoch !== asNumber(row.security_epoch) ||
    req.requirementKey !== asString(row.requirement_key) ||
    req.status !== asString(row.status) ||
    req.version !== asNumber(row.version)
  ) {
    throw new Error("DELIVERABLE_RECORD_CORRUPT: column mismatch");
  }
  assertCanonicalDeliverableRequirement(req);
  return req;
}

function evidenceLinkFromRow(row: Record<string, unknown>): EvidenceLink {
  const link: EvidenceLink = {
    tenantId: asString(row.tenant_id) as TenantId,
    id: asString(row.link_id),
    requirementId: asString(row.requirement_id),
    sourceType: asString(row.source_type) as EvidenceSourceType,
    sourceId: asString(row.source_id),
    submittedByPrincipalId: asString(row.submitted_by_principal_id) as PrincipalId,
    linkedAtUtc: asString(row.linked_at_utc),
    version: asNumber(row.version),
  };
  assertCanonicalEvidenceLink(link);
  return link;
}

function deliverableActionFromRow(row: Record<string, unknown>): DeliverableActionRecord {
  let evidenceIds: string[];
  try {
    evidenceIds = parseJson<string[]>(asString(row.evidence_ids_json));
  } catch {
    throw new Error("DELIVERABLE_ACTION_RECORD_CORRUPT: malformed evidence_ids_json");
  }
  const action: DeliverableActionRecord = {
    tenantId: asString(row.tenant_id) as TenantId,
    id: asString(row.action_id),
    requirementId: asString(row.requirement_id),
    action: asString(row.action) as DeliverableAction,
    actorPrincipalId: asString(row.actor_principal_id) as PrincipalId,
    occurredAtUtc: asString(row.occurred_at_utc),
    reason: row.reason !== null && row.reason !== undefined ? asString(row.reason) : null,
    evidenceCount: asNumber(row.evidence_count),
    evidenceIds,
  };
  assertCanonicalDeliverableActionRecord(action);
  return action;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function securityMigrationFromRow(row: Record<string, unknown>): SecurityDomainMigration {
  let migration: SecurityDomainMigration;
  try {
    migration = parseJson<SecurityDomainMigration>(asString(row.migration_json));
  } catch {
    throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: malformed migration_json");
  }

  if (typeof migration !== "object" || migration === null) {
    throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: migration_json is not an object");
  }

  // Required fields check
  if (
    typeof migration.tenantId !== "string" || migration.tenantId.length === 0
    || typeof migration.id !== "string" || migration.id.length === 0
    || typeof migration.projectId !== "string" || migration.projectId.length === 0
    || typeof migration.rootNodeId !== "string" || migration.rootNodeId.length === 0
    || typeof migration.state !== "string"
    || typeof migration.hierarchyRevision !== "number"
    || typeof migration.totalItems !== "number"
    || typeof migration.migratedItems !== "number"
    || typeof migration.version !== "number"
    || typeof migration.sourceSecurityEpoch !== "number"
    || typeof migration.targetSecurityEpoch !== "number"
    || typeof migration.createdAtUtc !== "string"
    || typeof migration.updatedAtUtc !== "string"
    || typeof migration.deadlineAtUtc !== "string"
  ) {
    throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: missing required fields in migration_json");
  }

  // Illegal state string check
  const validStates = new Set([
    "planned", "active", "verifying", "committed", "retryable", "recovery_required", "rolled_back",
  ]);
  if (!validStates.has(migration.state)) {
    throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: illegal migration state");
  }

  // Negative or non-integer items/version/epochs check
  if (
    !Number.isSafeInteger(migration.totalItems) || migration.totalItems < 0
    || !Number.isSafeInteger(migration.migratedItems) || migration.migratedItems < 0
    || !Number.isSafeInteger(migration.version) || migration.version <= 0
    || !Number.isSafeInteger(migration.hierarchyRevision) || migration.hierarchyRevision < 0
    || !Number.isSafeInteger(migration.sourceSecurityEpoch) || migration.sourceSecurityEpoch <= 0
    || !Number.isSafeInteger(migration.targetSecurityEpoch) || migration.targetSecurityEpoch <= 0
  ) {
    throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: non-integer or negative counters");
  }

  // migrated_items > total_items check
  if (migration.migratedItems > migration.totalItems) {
    throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: migrated items exceeds total items");
  }

  // Timestamps validation
  if (!isIsoTimestamp(migration.createdAtUtc) || !isIsoTimestamp(migration.updatedAtUtc) || !isIsoTimestamp(migration.deadlineAtUtc)) {
    throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: invalid ISO timestamp");
  }
  if (migration.nextAttemptAtUtc !== null && migration.nextAttemptAtUtc !== undefined && !isIsoTimestamp(migration.nextAttemptAtUtc)) {
    throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: invalid nextAttemptAtUtc");
  }
  if (Date.parse(migration.updatedAtUtc) < Date.parse(migration.createdAtUtc)) {
    throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: updatedAtUtc precedes createdAtUtc");
  }

  // Relational columns validation
  const relationalTotalItems = asNumber(row.total_items);
  const relationalMigratedItems = asNumber(row.migrated_items);
  const relationalVersion = asNumber(row.version);
  if (!Number.isSafeInteger(relationalTotalItems) || relationalTotalItems < 0
    || !Number.isSafeInteger(relationalMigratedItems) || relationalMigratedItems < 0
    || !Number.isSafeInteger(relationalVersion) || relationalVersion <= 0) {
    throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: relational column counter invalid");
  }
  if (relationalMigratedItems > relationalTotalItems) {
    throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: relational migrated items exceeds total items");
  }

  // Mismatch between column and JSON check
  if (
    migration.tenantId !== asString(row.tenant_id)
    || migration.id !== asString(row.migration_id)
    || migration.projectId !== asString(row.project_id)
    || migration.rootNodeId !== asString(row.root_node_id)
    || migration.state !== asString(row.state)
    || migration.hierarchyRevision !== asNumber(row.hierarchy_revision)
    || migration.cursor !== nullableString(row.cursor)
    || migration.totalItems !== relationalTotalItems
    || migration.migratedItems !== relationalMigratedItems
    || migration.nextAttemptAtUtc !== nullableString(row.next_attempt_at_utc)
    || migration.updatedAtUtc !== asString(row.updated_at_utc)
    || migration.version !== relationalVersion
  ) {
    throw new Error("SECURITY_MIGRATION_PERSISTENCE_INCONSISTENT");
  }

  return migration;
}

function manifestSnapshotFromRow(row: Record<string, unknown>, db?: DatabaseSync): SecurityMigrationManifestSnapshot {
  let snapshot: SecurityMigrationManifestSnapshot;
  try {
    snapshot = parseJson<SecurityMigrationManifestSnapshot>(asString(row.snapshot_json));
  } catch {
    throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: malformed snapshot_json");
  }

  if (typeof snapshot !== "object" || snapshot === null) {
    throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: snapshot_json is not an object");
  }

  if (
    typeof snapshot.tenantId !== "string" || snapshot.tenantId.length === 0
    || typeof snapshot.migrationId !== "string" || snapshot.migrationId.length === 0
    || typeof snapshot.manifestDigest !== "string" || snapshot.manifestDigest.length === 0
    || typeof snapshot.itemCount !== "number" || !Number.isSafeInteger(snapshot.itemCount) || snapshot.itemCount < 0
    || typeof snapshot.createdAtUtc !== "string" || !isIsoTimestamp(snapshot.createdAtUtc)
    || !Array.isArray(snapshot.items)
  ) {
    throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: missing or invalid required snapshot fields");
  }

  if (snapshot.items.length !== snapshot.itemCount) {
    throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: snapshot item count mismatch");
  }

  const relationalTenantId = asString(row.tenant_id);
  const relationalMigrationId = asString(row.migration_id);
  const relationalManifestDigest = asString(row.manifest_digest);
  const relationalItemCount = asNumber(row.item_count);
  const relationalCreatedAtUtc = asString(row.created_at_utc);

  if (
    snapshot.tenantId !== relationalTenantId
    || snapshot.migrationId !== relationalMigrationId
    || snapshot.manifestDigest !== relationalManifestDigest
    || snapshot.itemCount !== relationalItemCount
    || snapshot.createdAtUtc !== relationalCreatedAtUtc
  ) {
    throw new Error("SECURITY_MIGRATION_PERSISTENCE_INCONSISTENT");
  }

  let envelope = {
    projectId: snapshot.projectId,
    sourceSecurityDomainId: snapshot.sourceSecurityDomainId ?? null,
    targetSecurityDomainId: snapshot.targetSecurityDomainId ?? null,
    sourceSecurityEpoch: snapshot.sourceSecurityEpoch,
    targetSecurityEpoch: snapshot.targetSecurityEpoch,
  };

  if ((envelope.projectId === undefined || envelope.sourceSecurityEpoch === undefined || envelope.targetSecurityEpoch === undefined) && db !== undefined) {
    const migRow = db.prepare(`
      SELECT migration_json
      FROM security_domain_migrations
      WHERE tenant_id = ? AND migration_id = ?
    `).get(relationalTenantId, relationalMigrationId) as Record<string, unknown> | undefined;
    if (migRow !== undefined && migRow.migration_json) {
      const parsedMig = JSON.parse(asString(migRow.migration_json));
      envelope = {
        projectId: asString(parsedMig.projectId),
        sourceSecurityDomainId: parsedMig.sourceSecurityDomainId ? asString(parsedMig.sourceSecurityDomainId) : null,
        targetSecurityDomainId: parsedMig.targetSecurityDomainId ? asString(parsedMig.targetSecurityDomainId) : null,
        sourceSecurityEpoch: asNumber(parsedMig.sourceSecurityEpoch),
        targetSecurityEpoch: asNumber(parsedMig.targetSecurityEpoch),
      };
    }
  }

  validateCanonicalSnapshotItems(snapshot, {
    tenantId: relationalTenantId as TenantId,
    projectId: envelope.projectId,
    migrationId: relationalMigrationId,
    sourceSecurityDomainId: envelope.sourceSecurityDomainId,
    targetSecurityDomainId: envelope.targetSecurityDomainId,
    sourceSecurityEpoch: envelope.sourceSecurityEpoch,
    targetSecurityEpoch: envelope.targetSecurityEpoch,
  });

  return snapshot;
}

function readinessEvidenceFromRow(row: Record<string, unknown>): SecurityMigrationReadinessEvidenceRecord {
  let evidence: SecurityMigrationReadinessEvidenceRecord;
  try {
    evidence = parseJson<SecurityMigrationReadinessEvidenceRecord>(asString(row.evidence_json));
  } catch {
    throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: malformed evidence_json");
  }

  if (typeof evidence !== "object" || evidence === null) {
    throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: evidence_json is not an object");
  }

  if (
    typeof evidence.tenantId !== "string" || evidence.tenantId.length === 0
    || typeof evidence.evidenceId !== "string" || evidence.evidenceId.length === 0
    || typeof evidence.nonce !== "string" || evidence.nonce.length === 0
    || typeof evidence.migrationId !== "string" || evidence.migrationId.length === 0
    || typeof evidence.purpose !== "string" || (evidence.purpose !== "commit" && evidence.purpose !== "rollback")
    || typeof evidence.projectId !== "string" || evidence.projectId.length === 0
    || typeof evidence.sourceSecurityEpoch !== "number" || !Number.isSafeInteger(evidence.sourceSecurityEpoch) || evidence.sourceSecurityEpoch <= 0
    || typeof evidence.targetSecurityEpoch !== "number" || !Number.isSafeInteger(evidence.targetSecurityEpoch) || evidence.targetSecurityEpoch <= 0
    || typeof evidence.manifestDigest !== "string" || evidence.manifestDigest.length === 0
    || typeof evidence.itemCount !== "number" || !Number.isSafeInteger(evidence.itemCount) || evidence.itemCount < 0
    || typeof evidence.status !== "string" || !["issued", "verified", "consumed"].includes(evidence.status)
    || typeof evidence.converged !== "boolean"
    || typeof evidence.issuedAtUtc !== "string" || !isIsoTimestamp(evidence.issuedAtUtc)
    || typeof evidence.expiresAtUtc !== "string" || !isIsoTimestamp(evidence.expiresAtUtc)
  ) {
    throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: missing or invalid required evidence fields");
  }

  if (evidence.verifiedAtUtc !== null && (typeof evidence.verifiedAtUtc !== "string" || !isIsoTimestamp(evidence.verifiedAtUtc))) {
    throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: invalid verifiedAtUtc");
  }
  if (evidence.consumedAtUtc !== null && (typeof evidence.consumedAtUtc !== "string" || !isIsoTimestamp(evidence.consumedAtUtc))) {
    throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: invalid consumedAtUtc");
  }

  if (Date.parse(evidence.expiresAtUtc) <= Date.parse(evidence.issuedAtUtc)) {
    throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: expiresAtUtc precedes issuedAtUtc");
  }

  if (evidence.status === "issued") {
    if (evidence.verifiedAtUtc !== null || evidence.consumedAtUtc !== null || evidence.converged !== false || evidence.channels !== null) {
      throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: issued evidence must not have verification fields");
    }
  } else if (evidence.status === "verified") {
    if (evidence.verifiedAtUtc === null || evidence.consumedAtUtc !== null) {
      throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: verified evidence must have verifiedAtUtc and no consumedAtUtc");
    }
  } else if (evidence.status === "consumed") {
    if (evidence.verifiedAtUtc === null || evidence.consumedAtUtc === null) {
      throw new Error("SECURITY_MIGRATION_RECORD_CORRUPT: consumed evidence must have verifiedAtUtc and consumedAtUtc");
    }
  }

  const relationalTenantId = asString(row.tenant_id);
  const relationalEvidenceId = asString(row.evidence_id);
  const relationalMigrationId = asString(row.migration_id);
  const relationalPurpose = asString(row.purpose);
  const relationalNonce = asString(row.nonce);
  const relationalStatus = asString(row.status);
  const relationalManifestDigest = asString(row.manifest_digest);
  const relationalItemCount = asNumber(row.item_count);
  const relationalSourceSecurityDomainId = nullableString(row.source_security_domain_id);
  const relationalTargetSecurityDomainId = nullableString(row.target_security_domain_id);
  const relationalSourceSecurityEpoch = asNumber(row.source_security_epoch);
  const relationalTargetSecurityEpoch = asNumber(row.target_security_epoch);
  const relationalIssuedAtUtc = asString(row.issued_at_utc);
  const relationalExpiresAtUtc = asString(row.expires_at_utc);
  const relationalVerifiedAtUtc = nullableString(row.verified_at_utc);
  const relationalConsumedAtUtc = nullableString(row.consumed_at_utc);
  const relationalVerifierProvider = nullableString(row.verifier_provider);
  const relationalConverged = asNumber(row.converged) === 1;
  const relationalReason = nullableString(row.reason);

  const channelsJson = nullableString(row.channels_json);
  const expectedChannelsJson = evidence.channels === null ? null : JSON.stringify(evidence.channels);

  if (
    evidence.tenantId !== relationalTenantId
    || evidence.evidenceId !== relationalEvidenceId
    || evidence.migrationId !== relationalMigrationId
    || evidence.purpose !== relationalPurpose
    || evidence.nonce !== relationalNonce
    || evidence.status !== relationalStatus
    || evidence.manifestDigest !== relationalManifestDigest
    || evidence.itemCount !== relationalItemCount
    || evidence.sourceSecurityDomainId !== relationalSourceSecurityDomainId
    || evidence.targetSecurityDomainId !== relationalTargetSecurityDomainId
    || evidence.sourceSecurityEpoch !== relationalSourceSecurityEpoch
    || evidence.targetSecurityEpoch !== relationalTargetSecurityEpoch
    || evidence.issuedAtUtc !== relationalIssuedAtUtc
    || evidence.expiresAtUtc !== relationalExpiresAtUtc
    || evidence.verifiedAtUtc !== relationalVerifiedAtUtc
    || evidence.consumedAtUtc !== relationalConsumedAtUtc
    || evidence.provider !== relationalVerifierProvider
    || evidence.converged !== relationalConverged
    || (evidence.reason ?? null) !== relationalReason
    || (channelsJson === null ? expectedChannelsJson !== null : JSON.stringify(parseJson(channelsJson)) !== expectedChannelsJson)
  ) {
    throw new Error("SECURITY_MIGRATION_PERSISTENCE_INCONSISTENT");
  }

  return evidence;
}


const ALLOWED_INTEGRATION_OPERATION_TYPES = new Set<string>([
  "asset.ingest",
  "collaboration.task.project",
  "collaboration.asset.project",
  "blob.delete",
]);

const ALLOWED_INTEGRATION_SUBJECT_TYPES = new Set<string>([
  "task",
  "asset",
]);

const ALLOWED_INTEGRATION_OPERATION_STATES = new Set<string>([
  "planned",
  "running",
  "retryable",
  "completed",
  "compensated",
  "recovery_required",
]);

function integrationOperationFromRow(row: Record<string, unknown>): IntegrationOperation {
  const relationalTenantId = asString(row.tenant_id);
  const relationalOperationId = asString(row.operation_id);
  const relationalOperationType = asString(row.operation_type);
  const relationalSubjectType = asString(row.subject_type);
  const relationalSubjectId = asString(row.subject_id);
  const relationalState = asString(row.state);
  const relationalVersion = asNumber(row.version);

  if (!ALLOWED_INTEGRATION_OPERATION_TYPES.has(relationalOperationType)
    || !ALLOWED_INTEGRATION_SUBJECT_TYPES.has(relationalSubjectType)
    || !ALLOWED_INTEGRATION_OPERATION_STATES.has(relationalState)) {
    throw new Error("INTEGRATION_OPERATION_ENUM_INVALID");
  }

  const op = parseJson<IntegrationOperation>(asString(row.operation_json));
  if (typeof op !== "object" || op === null || Array.isArray(op)) {
    throw new Error("INTEGRATION_OPERATION_PERSISTENCE_INCONSISTENT");
  }

  if (!ALLOWED_INTEGRATION_OPERATION_TYPES.has(op.operationType as string)
    || !ALLOWED_INTEGRATION_SUBJECT_TYPES.has(op.subjectType as string)
    || !ALLOWED_INTEGRATION_OPERATION_STATES.has(op.state as string)) {
    throw new Error("INTEGRATION_OPERATION_ENUM_INVALID");
  }

  if (op.tenantId !== relationalTenantId
    || op.id !== relationalOperationId
    || op.operationType !== relationalOperationType
    || op.subjectType !== relationalSubjectType
    || op.subjectId !== relationalSubjectId
    || op.state !== relationalState
    || op.version !== relationalVersion) {
    throw new Error("INTEGRATION_OPERATION_PERSISTENCE_INCONSISTENT");
  }
  return op;
}

function principalFromRow(row: Record<string, unknown>): Principal {
  const state = asString(row.state);
  const kind = asString(row.kind);
  if (state !== "active" && state !== "revoked") throw new Error("SQLITE_PRINCIPAL_STATE_INVALID");
  if (kind !== "user" && kind !== "service") throw new Error("SQLITE_PRINCIPAL_KIND_INVALID");
  return {
    tenantId: parseTenantId(asString(row.tenant_id)),
    id: row.principal_id as Principal["id"],
    kind,
    status: state,
    version: asNumber(row.version),
    createdAtUtc: asString(row.created_at_utc),
    updatedAtUtc: asString(row.updated_at_utc),
  };
}

function outboxFromRow(row: Record<string, unknown>): OutboxMessage {
  return {
    tenantId: parseTenantId(asString(row.tenant_id)),
    id: asString(row.message_id),
    eventId: asString(row.event_id),
    topic: asString(row.topic),
    payload: parseJson<DomainEvent>(asString(row.payload_json)),
    state: asOutboxState(row.state),
    availableAtUtc: asString(row.available_at_utc),
    attempts: asNumber(row.attempts),
    maxAttempts: asNumber(row.max_attempts),
    leaseOwner: nullableString(row.lease_owner),
    leaseToken: nullableString(row.lease_token),
    leaseExpiresAtUtc: nullableString(row.lease_expires_at_utc),
    lastError: nullableString(row.last_error),
    publishedAtUtc: nullableString(row.published_at_utc),
    createdAtUtc: asString(row.created_at_utc),
  };
}

function jobFromRow(row: Record<string, unknown>): BackgroundJob {
  return {
    tenantId: parseTenantId(asString(row.tenant_id)),
    id: asString(row.job_id),
    jobType: asString(row.job_type),
    dedupeKey: nullableString(row.dedupe_key),
    payload: parseJson<Record<string, unknown>>(asString(row.payload_json)),
    state: asJobState(row.state),
    priority: asNumber(row.priority),
    availableAtUtc: asString(row.available_at_utc),
    attempts: asNumber(row.attempts),
    maxAttempts: asNumber(row.max_attempts),
    leaseOwner: nullableString(row.lease_owner),
    leaseToken: nullableString(row.lease_token),
    leaseExpiresAtUtc: nullableString(row.lease_expires_at_utc),
    lastError: nullableString(row.last_error),
    completedAtUtc: nullableString(row.completed_at_utc),
    createdAtUtc: asString(row.created_at_utc),
  };
}

function asString(value: unknown): string {
  if (typeof value !== "string") throw new Error("SQLITE_ROW_STRING_EXPECTED");
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return asString(value);
}

function asNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("SQLITE_ROW_INTEGER_EXPECTED");
  return value;
}

function asNodeKind(value: unknown): ProjectNode["kind"] {
  if (value === "stage" || value === "work_package" || value === "milestone") return value;
  throw new Error("SQLITE_NODE_KIND_INVALID");
}

function asOutboxState(value: unknown): OutboxMessage["state"] {
  if (value === "pending" || value === "leased" || value === "published" || value === "dead_letter") return value;
  throw new Error("SQLITE_OUTBOX_STATE_INVALID");
}

function asJobState(value: unknown): BackgroundJob["state"] {
  if (value === "pending" || value === "leased" || value === "completed" || value === "dead_letter") return value;
  throw new Error("SQLITE_JOB_STATE_INVALID");
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function productTaskFromJson(value: string): ProductTask {
  const task = parseJson<ProductTask & { reviewerPrincipalId?: ProductTask["reviewerPrincipalId"] }>(value);
  return { ...task, reviewerPrincipalId: task.reviewerPrincipalId ?? null };
}

function reviewActionFromJson(value: string): TaskReviewActionRecord {
  const action = parseJson<TaskReviewActionRecord & {
    cycle?: number;
    comment?: string | null;
  }>(value);
  const cycleNumber = action.cycleNumber ?? action.cycle;
  if (!Number.isSafeInteger(cycleNumber) || cycleNumber === undefined || cycleNumber <= 0) {
    throw new Error("SQLITE_TASK_REVIEW_CYCLE_INVALID");
  }
  return {
    tenantId: action.tenantId,
    taskId: action.taskId,
    cycleNumber,
    action: action.action,
    actorPrincipalId: action.actorPrincipalId,
    reviewerPrincipalId: action.reviewerPrincipalId ?? null,
    occurredAtUtc: action.occurredAtUtc,
    note: action.note ?? action.comment ?? null,
  };
}

function validateClaim(options: ClaimOptions): void {
  if (options.workerId.trim().length === 0 || !Number.isInteger(options.limit) || options.limit <= 0) throw new Error("INVALID_CLAIM_OPTIONS");
  if (Date.parse(options.leaseUntilUtc) <= Date.parse(options.nowUtc)) throw new Error("INVALID_LEASE_DEADLINE");
}

function assertTenant(expected: TenantId, actual: TenantId): void {
  if (expected !== actual) throw new Error("TENANT_CONTEXT_MISMATCH");
}

function translateConstraint(error: unknown): unknown {
  if (error instanceof ApplicationError) return error;
  if (!(error instanceof Error)) return error;
  if (error.message.includes("project_nodes.tenant_id, project_nodes.node_id")) return new Error("AGGREGATE_ALREADY_EXISTS");
  if (error.message.includes("project_role_slots")) return new Error("ROLE_SLOT_ALREADY_EXISTS");
  if (error.message.includes("command_receipts")) return new Error("IDEMPOTENCY_RECORD_ALREADY_EXISTS");
  if (error.message.includes("domain_events.tenant_id, domain_events.aggregate_type")) return new Error("AGGREGATE_VERSION_ALREADY_EXISTS");
  if (error.message.includes("domain_events.tenant_id, domain_events.project_id")) return new Error("PROJECT_SEQUENCE_ALREADY_EXISTS");
  return error;
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

function slotFromRow(
  row: Record<string, unknown>,
  expectedScope?: { tenantId?: TenantId; projectId?: string; slotKey?: string },
): TemplateRoleSlot {
  try {
    const slot: TemplateRoleSlot = {
      tenantId: asString(row.tenant_id) as TenantId,
      projectId: asString(row.project_id),
      slotKey: asString(row.slot_key),
      sourceTemplateVersionId: asString(row.source_template_version_id),
      name: asString(row.name),
      description: row.description === null || row.description === undefined ? null : asString(row.description),
      createdAtUtc: asString(row.created_at_utc),
    };
    assertCanonicalTemplateRoleSlot(slot, expectedScope);
    return slot;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", error instanceof Error ? error.message : String(error));
  }
}

function bindingFromRow(
  row: Record<string, unknown>,
  expectedScope?: { tenantId?: TenantId; projectId?: string; slotKey?: string },
): ProjectRoleBinding {
  try {
    const rawIds = JSON.parse(asString(row.principal_ids_json));
    const binding: ProjectRoleBinding = {
      tenantId: asString(row.tenant_id) as TenantId,
      projectId: asString(row.project_id),
      slotKey: asString(row.slot_key),
      principalIds: rawIds as PrincipalId[],
      version: asNumber(row.version),
      updatedAtUtc: asString(row.updated_at_utc),
      updatedByPrincipalId: asString(row.updated_by_principal_id) as PrincipalId,
    };
    assertCanonicalProjectRoleBinding(binding, expectedScope);
    return binding;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError("ROLE_BINDING_RECORD_CORRUPT", error instanceof Error ? error.message : String(error));
  }
}

function snapshotFromRow(
  row: Record<string, unknown>,
  expectedScope?: { tenantId?: TenantId; projectId?: string },
): ProjectRoleSlotSnapshot {
  try {
    const snapshot: ProjectRoleSlotSnapshot = {
      tenantId: asString(row.tenant_id) as TenantId,
      projectId: asString(row.project_id),
      sourceTemplateVersionId: asString(row.source_template_version_id),
      createdAtUtc: asString(row.created_at_utc),
      createdByPrincipalId: asString(row.created_by_principal_id) as PrincipalId,
    };
    assertCanonicalProjectRoleSlotSnapshot(snapshot, expectedScope);
    return snapshot;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError("ROLE_SLOT_RECORD_CORRUPT", error instanceof Error ? error.message : String(error));
  }
}

function domainEventFromRow<T extends Record<string, unknown> = Record<string, unknown>>(
  row: Record<string, unknown>,
  errorCode: "ROLE_SLOT_RECORD_CORRUPT" | "ROLE_BINDING_RECORD_CORRUPT" = "ROLE_SLOT_RECORD_CORRUPT",
): DomainEvent<T> {
  const eventJsonStr = asString(row.event_json);
  const event = parseJson<DomainEvent<T>>(eventJsonStr);
  if (!event || typeof event !== "object") {
    throw new ApplicationError(errorCode, "Domain event JSON is corrupted");
  }

  const rowTenantId = asString(row.tenant_id);
  const rowEventId = asString(row.event_id);
  const rowProjectId = asString(row.project_id);
  const rowProjectSequence = asNumber(row.project_sequence);
  const rowAggregateType = asString(row.aggregate_type);
  const rowAggregateId = asString(row.aggregate_id);
  const rowAggregateVersion = asNumber(row.aggregate_version);
  const rowEventType = asString(row.event_type);
  const rowSchemaVersion = asNumber(row.schema_version);
  const rowOccurredAtUtc = asString(row.occurred_at_utc);

  if (
    rowTenantId !== event.tenantId ||
    rowEventId !== event.eventId ||
    rowProjectId !== event.projectId ||
    rowProjectSequence !== event.projectSequence ||
    rowAggregateType !== event.aggregateType ||
    rowAggregateId !== event.aggregateId ||
    rowAggregateVersion !== event.aggregateVersion ||
    rowEventType !== event.eventType ||
    rowSchemaVersion !== event.schemaVersion ||
    rowOccurredAtUtc !== event.occurredAtUtc
  ) {
    throw new ApplicationError(
      errorCode,
      `Domain event relational columns diverge from event_json: ` +
      `tenant(${rowTenantId} vs ${event.tenantId}), ` +
      `eventId(${rowEventId} vs ${event.eventId}), ` +
      `projectId(${rowProjectId} vs ${event.projectId}), ` +
      `sequence(${rowProjectSequence} vs ${event.projectSequence}), ` +
      `aggregateType(${rowAggregateType} vs ${event.aggregateType}), ` +
      `aggregateId(${rowAggregateId} vs ${event.aggregateId}), ` +
      `aggregateVersion(${rowAggregateVersion} vs ${event.aggregateVersion}), ` +
      `eventType(${rowEventType} vs ${event.eventType}), ` +
      `schemaVersion(${rowSchemaVersion} vs ${event.schemaVersion}), ` +
      `occurredAt(${rowOccurredAtUtc} vs ${event.occurredAtUtc})`,
    );
  }

  return event;
}

function roleSlotAuditFromRow(
  row: Record<string, unknown>,
  expectedScope?: { tenantId?: TenantId; projectId?: string },
): ProjectRoleSlotAuditEntry {
  try {
    const slotKeys = JSON.parse(asString(row.slot_keys_json));
    const entry: ProjectRoleSlotAuditEntry = {
      tenantId: asString(row.tenant_id) as TenantId,
      id: asString(row.id),
      projectId: asString(row.project_id),
      actorPrincipalId: asString(row.actor_principal_id) as PrincipalId,
      sourceTemplateVersionId: asString(row.source_template_version_id),
      action: asString(row.action) as ProjectRoleSlotAuditAction,
      slotKeys: slotKeys as readonly string[],
      occurredAtUtc: asString(row.occurred_at_utc),
    };
    assertCanonicalProjectRoleSlotAuditEntry(entry, expectedScope);
    return entry;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError("ROLE_SLOT_AUDIT_RECORD_CORRUPT", error instanceof Error ? error.message : String(error));
  }
}
