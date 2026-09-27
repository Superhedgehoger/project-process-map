/**
 * Frozen v12 schema fixture. It composes the immutable v11 schema with the
 * exact v12 deliverable DDL introduced by commit 46cc16b.
 * Future migrations must not modify this fixture.
 */
import { DatabaseSync } from "node:sqlite";
import { applyFrozenV11Schema } from "./v11-schema.ts";

export const FROZEN_V12_SCHEMA_VERSION = 12;

export function applyFrozenV12Schema(database: DatabaseSync): void {
  applyFrozenV11Schema(database);
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE deliverable_requirements (
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
    CREATE INDEX deliverable_requirements_by_node
      ON deliverable_requirements (tenant_id, owner_node_id, deliverable_id);
    CREATE INDEX deliverable_requirements_by_project
      ON deliverable_requirements (tenant_id, project_id, deliverable_id);
    CREATE UNIQUE INDEX uq_deliverable_requirements_key
      ON deliverable_requirements (tenant_id, project_id, owner_node_id, requirement_key);

    CREATE TABLE deliverable_evidence_links (
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
    CREATE INDEX deliverable_evidence_links_by_requirement
      ON deliverable_evidence_links (tenant_id, requirement_id, link_id);
    CREATE UNIQUE INDEX uq_deliverable_evidence_natural_key
      ON deliverable_evidence_links (tenant_id, requirement_id, source_type, source_id);

    CREATE TABLE deliverable_action_records (
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
    CREATE INDEX deliverable_actions_by_requirement
      ON deliverable_action_records (tenant_id, requirement_id, occurred_at_utc, action_id);

    INSERT INTO schema_migrations (version, applied_at_utc)
      VALUES (12, '2026-09-25T00:00:00.000Z');
    COMMIT;
  `);
}
