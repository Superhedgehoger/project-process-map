/**
 * Frozen v11 schema, transcribed verbatim from commit
 * 0598ad482c02876de6f4e804033bdba906b9d6c7 (`packages/adapters/src/sqlite/persistence.ts`,
 * `migrate()`, up to and including the v11 marker).
 *
 * R2F4 Finding 2: the v11→v12 upgrade evidence must be built from a frozen,
 * independent v11 schema — not by creating a database with the current v12
 * adapter and stripping the v12 tables out of it. This module is a frozen
 * copy of the v11 DDL and must not drift with the current adapter: any future
 * schema change adds a NEW frozen module (v12-schema.ts, ...) and does not
 * rewrite this one.
 *
 * `v11SchemaVersionGuard` is a frozen replica of the version guard the
 * v11-generation reader enforced (same MAX(version) read from
 * `schema_migrations` + the same fail-closed error contract as the v11
 * `assertSupportedSchema`), so old-reader rejection evidence exercises real
 * v11 reader logic, not a test-local "MAX + manual throw" substitute.
 */
import { DatabaseSync } from "node:sqlite";

export const FROZEN_V11_SCHEMA_VERSION = 11;

/** Frozen v11 reader guard: reject any database carrying a schema version above 11. */
export function v11SchemaVersionGuard(database: DatabaseSync, pathLabel?: string): void {
  const row = database.prepare(
    "SELECT MAX(version) AS version FROM schema_migrations",
  ).get() as { version?: number } | undefined;
  const version = row?.version;
  if (typeof version === "number" && version > FROZEN_V11_SCHEMA_VERSION) {
    // Error contract verbatim from the base-commit v11 `assertSupportedSchema()`.
    // The v11 generation closed the handle and rethrew; the frozen guard keeps
    // the exact message (an optional path label is appended for test diagnostics
    // only and is not part of the v11 contract).
    const base = `SQLITE_SCHEMA_VERSION_UNSUPPORTED:${version}`;
    throw new Error(pathLabel === undefined ? base : `${base} (database ${pathLabel})`);
  }
}

/**
 * Apply the frozen v11 schema to a fresh database: the v1-v10 DDL block,
 * marker rows 2-10, then the v11 role-slot DDL block and the v11 marker row,
 * in the same statement order the v11 `migrate()` used.
 */
export function applyFrozenV11Schema(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
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
  // v2-v10: idempotent marker rows (the v11 `migrate()` inserted 2-9 with
  // `new Date().toISOString()` and 10 after the leader_principal_id ALTER;
  // those columns already exist in the frozen v1 DDL, so markers only).
  const marker = (version: number): void => {
    database
      .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at_utc) VALUES (?, ?)")
      .run(version, "2026-09-04T00:00:00.000Z");
  };
  for (const version of [2, 3, 4, 5, 6, 7, 8, 9, 10]) marker(version);

  // v11: role slot foundation tables (frozen from commit 0598ad4).
  database.exec(`
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
  marker(11);
  database.exec("COMMIT;");
}
