import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Asset, AssetBinding } from "../../../domain/src/assets.ts";
import type { BackgroundJob, DomainEvent, OutboxMessage } from "../../../domain/src/events.ts";
import type { ExternalBinding } from "../../../domain/src/external-reference.ts";
import { tenantId as parseTenantId, type TenantId } from "../../../domain/src/identity.ts";
import type { IntegrationOperation, IntegrationStepAttempt } from "../../../domain/src/integration-operations.ts";
import type { ProjectNode } from "../../../domain/src/project-structure.ts";
import type { ProductTask, TaskReviewCycle } from "../../../domain/src/tasks.ts";
import type {
  ClaimOptions,
  CommandReceipt,
  CommandScope,
  JobConsumer,
  OutboxConsumer,
  Persistence,
  TransactionContext,
} from "../../../application/src/ports/persistence.ts";

export type SqlitePersistenceOptions = Readonly<{
  path: string;
  busyTimeoutMilliseconds?: number;
}>;

const pathLocks = new Map<string, Promise<void>>();

export class SqlitePersistence implements Persistence {
  readonly #database: DatabaseSync;
  readonly #lockKey: string;
  #closed = false;

  constructor(options: SqlitePersistenceOptions) {
    if (options.path.trim().length === 0) throw new Error("SQLite path is required");
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
    this.#lockKey = options.path === ":memory:" ? `:memory:${randomUUID()}` : resolve(options.path);
    this.#database = new DatabaseSync(options.path, {
      timeout: options.busyTimeoutMilliseconds ?? 5_000,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    this.#database.exec("PRAGMA journal_mode=WAL");
    this.#database.exec("PRAGMA synchronous=FULL");
    this.#database.exec("PRAGMA foreign_keys=ON");
    this.migrate();
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
      return await work(this.context(tenantId));
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
    return {
      tenantId,
      nodes: {
        get: async (nodeId) => {
          const row = this.#database.prepare("SELECT * FROM project_nodes WHERE tenant_id = ? AND node_id = ?").get(tenantId, nodeId);
          return row === undefined ? undefined : nodeFromRow(row);
        },
        listByProject: async (projectId) => this.#database.prepare(
          "SELECT * FROM project_nodes WHERE tenant_id = ? AND project_id = ? ORDER BY node_id",
        ).all(tenantId, projectId).map(nodeFromRow),
        insert: async (node) => {
          if (node.tenantId !== tenantId) throw new Error("TENANT_CONTEXT_MISMATCH");
          this.#database.prepare(`
            INSERT INTO project_nodes (
              tenant_id, node_id, project_id, parent_node_id, title, kind,
              security_domain_id, security_epoch, version, deleted_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            tenantId, node.id, node.projectId, node.parentId, node.title, node.kind,
            node.securityDomainId, node.securityEpoch, node.version, node.deletedAtUtc,
          );
        },
      },
      tasks: {
        get: async (taskId) => {
          const row = this.#database.prepare("SELECT task_json FROM product_tasks WHERE tenant_id = ? AND task_id = ?").get(tenantId, taskId);
          return row === undefined ? undefined : parseJson<ProductTask>(asString(row.task_json));
        },
        listByNode: async (nodeId) => this.#database.prepare(`
          SELECT task_json FROM product_tasks
          WHERE tenant_id = ? AND owner_node_id = ?
          ORDER BY task_id
        `).all(tenantId, nodeId).map((row) => parseJson<ProductTask>(asString(row.task_json))),
        insert: async (task) => {
          assertTenant(tenantId, task.tenantId);
          this.#database.prepare(`
            INSERT INTO product_tasks (tenant_id, task_id, project_id, owner_node_id, lifecycle_state, version, task_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(tenantId, task.id, task.projectId, task.ownerNodeId, task.executionState, task.version, JSON.stringify(task));
        },
        update: async (task, expectedVersion) => {
          assertTenant(tenantId, task.tenantId);
          if (task.version !== expectedVersion + 1) throw new Error("TASK_VERSION_CONFLICT");
          const result = this.#database.prepare(`
            UPDATE product_tasks
            SET project_id = ?, owner_node_id = ?, lifecycle_state = ?, version = ?, task_json = ?
            WHERE tenant_id = ? AND task_id = ? AND version = ?
          `).run(task.projectId, task.ownerNodeId, task.executionState, task.version, JSON.stringify(task), tenantId, task.id, expectedVersion);
          if (result.changes !== 1) throw new Error("TASK_VERSION_CONFLICT");
        },
        appendReviewCycle: async (cycle) => {
          assertTenant(tenantId, cycle.tenantId);
          this.#database.prepare(`
            INSERT INTO task_review_actions (tenant_id, task_id, cycle, action, occurred_at_utc, action_json)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(tenantId, cycle.taskId, cycle.cycle, cycle.action, cycle.occurredAtUtc, JSON.stringify(cycle));
        },
        listReviewCycles: async (taskId) => this.#database.prepare(`
          SELECT action_json FROM task_review_actions
          WHERE tenant_id = ? AND task_id = ?
          ORDER BY cycle, occurred_at_utc, action
        `).all(tenantId, taskId).map((row) => parseJson<TaskReviewCycle>(asString(row.action_json))),
      },
      assets: {
        get: async (assetId) => {
          const row = this.#database.prepare("SELECT asset_json FROM assets WHERE tenant_id = ? AND asset_id = ?").get(tenantId, assetId);
          return row === undefined ? undefined : parseJson<Asset>(asString(row.asset_json));
        },
        insert: async (asset) => {
          assertTenant(tenantId, asset.tenantId);
          this.#database.prepare(`
            INSERT INTO assets (tenant_id, asset_id, project_id, owner_node_id, lifecycle_state, version, asset_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(tenantId, asset.id, asset.projectId, asset.ownerNodeId, asset.lifecycleState, asset.version, JSON.stringify(asset));
        },
        update: async (asset, expectedVersion) => {
          assertTenant(tenantId, asset.tenantId);
          if (asset.version !== expectedVersion + 1) throw new Error("ASSET_VERSION_CONFLICT");
          const result = this.#database.prepare(`
            UPDATE assets
            SET project_id = ?, owner_node_id = ?, lifecycle_state = ?, version = ?, asset_json = ?
            WHERE tenant_id = ? AND asset_id = ? AND version = ?
          `).run(asset.projectId, asset.ownerNodeId, asset.lifecycleState, asset.version, JSON.stringify(asset), tenantId, asset.id, expectedVersion);
          if (result.changes !== 1) throw new Error("ASSET_VERSION_CONFLICT");
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
            SELECT operation_json FROM integration_operations WHERE tenant_id = ? AND operation_id = ?
          `).get(tenantId, operationId);
          return row === undefined ? undefined : parseJson<IntegrationOperation>(asString(row.operation_json));
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
      },
      outbox: {
        enqueue: async (message) => {
          assertTenant(tenantId, message.tenantId);
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
      },
    };
  }

  private migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at_utc TEXT NOT NULL
      ) STRICT;

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
        created_at_utc TEXT NOT NULL,
        PRIMARY KEY (tenant_id, principal_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS project_nodes (
        tenant_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        parent_node_id TEXT,
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
    title: asString(row.title),
    kind: asNodeKind(row.kind),
    securityDomainId: nullableString(row.security_domain_id),
    securityEpoch: asNumber(row.security_epoch),
    version: asNumber(row.version),
    deletedAtUtc: nullableString(row.deleted_at_utc),
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

function validateClaim(options: ClaimOptions): void {
  if (options.workerId.trim().length === 0 || !Number.isInteger(options.limit) || options.limit <= 0) throw new Error("INVALID_CLAIM_OPTIONS");
  if (Date.parse(options.leaseUntilUtc) <= Date.parse(options.nowUtc)) throw new Error("INVALID_LEASE_DEADLINE");
}

function assertTenant(expected: TenantId, actual: TenantId): void {
  if (expected !== actual) throw new Error("TENANT_CONTEXT_MISMATCH");
}

function translateConstraint(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  if (error.message.includes("project_nodes.tenant_id, project_nodes.node_id")) return new Error("AGGREGATE_ALREADY_EXISTS");
  if (error.message.includes("command_receipts")) return new Error("IDEMPOTENCY_RECORD_ALREADY_EXISTS");
  if (error.message.includes("domain_events.tenant_id, domain_events.aggregate_type")) return new Error("AGGREGATE_VERSION_ALREADY_EXISTS");
  if (error.message.includes("domain_events.tenant_id, domain_events.project_id")) return new Error("PROJECT_SEQUENCE_ALREADY_EXISTS");
  return error;
}
