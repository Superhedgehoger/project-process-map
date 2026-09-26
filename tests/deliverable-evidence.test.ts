import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createProductApi } from "../apps/product-api/src/app.ts";
import { MemoryAssetContent } from "../packages/adapters/src/memory/asset-content.ts";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import {
  applyFrozenV11Schema,
} from "../packages/adapters/src/sqlite/schema/v11-schema.ts";
import { FrozenV11SqlitePersistenceReader } from "../packages/adapters/src/sqlite/schema/v11-reader.ts";
import {
  acceptDeliverable,
  assertCanonicalDeliverableActionRecord,
  assertCanonicalDeliverableRequirement,
  assertCanonicalEvidenceLink,
  assertValidRequirementKey,
  deliverableEventSchemas,
  submitDeliverable,
  waiveDeliverable,
  type DeliverableActionRecord,
  type DeliverableRequirement,
  type EvidenceLink,
} from "../packages/domain/src/deliverables.ts";
import {
  assertNoSensitiveFields,
  validateEventAgainstSchema,
} from "../packages/domain/src/event-schema-registry.ts";
import type { DomainEvent } from "../packages/domain/src/events.ts";
import { principalId, tenantId, type PrincipalId, type TenantId } from "../packages/domain/src/identity.ts";
import { type ProjectNode } from "../packages/domain/src/project-structure.ts";
import { ApplicationError } from "../packages/application/src/errors.ts";
import { AcceptDeliverableHandler } from "../packages/application/src/deliverables/accept-deliverable.ts";
import {
  InitializeDeliverableRequirementHandler,
} from "../packages/application/src/deliverables/initialize-deliverable-requirement.ts";
import { SubmitDeliverableEvidenceHandler } from "../packages/application/src/deliverables/submit-deliverable-evidence.ts";
import { WaiveDeliverableHandler } from "../packages/application/src/deliverables/waive-deliverable.ts";
import { CreateSecurityRootHandler } from "../packages/application/src/security/create-security-root.ts";
import { ManageSecurityGrantHandler } from "../packages/application/src/security/manage-security-grant.ts";
import { SecurityMigrationInventoryReader } from "../packages/application/src/security/build-security-migration-inventory.ts";
import { BeginSecurityMigrationVerificationHandler } from "../packages/application/src/security/begin-security-migration-verification.ts";
import { CommitSecurityMigrationHandler } from "../packages/application/src/security/commit-security-migration.ts";
import { ExecuteSecurityMigrationBatchHandler } from "../packages/application/src/security/execute-security-migration-batch.ts";
import type { ExternalCollaborationEpochReadinessPort } from "../packages/application/src/ports/integrations.ts";
import type { SecurityDomainMigration } from "../packages/domain/src/security-migration.ts";
import { executeAssignNodeLeader } from "../packages/application/src/create-node.ts";
import { transitionSecurityMigration } from "../packages/domain/src/security-migration.ts";
import type { DeliverableRequirementView, Persistence } from "../packages/application/src/ports/persistence.ts";
import type { TestReadinessHarness } from "../packages/adapters/src/security-migration-coordinator.ts";
import { createTestMemoryBundle, createTestSqliteBundle } from "./helpers/test-persistence-bundle.ts";
import {
  runSubmitAtActualCasBarrier,
  waitForActualCasAttemptMarker,
  waitForActualCasContenderOpen,
  waitForActualCasReadyMarker,
  writeActualCasStartMarker,
  writeCasReleaseMarker,
} from "./helpers/cas-independent-worker.ts";
import {
  assertNoRecordResidue,
  captureSnapshot,
  type DeliverableRecordSnapshot,
} from "./helpers/deliverable-record-snapshot.ts";
import { grantProjectMembership } from "./support/project-membership.ts";

const tenant = tenantId("tenant-dlv");
const foreignTenant = tenantId("tenant-dlv-foreign");
const pm = principalId("pm-principal");
const nodeLeader = principalId("leader-principal");
const reviewer = principalId("reviewer-principal");
const member = principalId("member-principal");
const outsider = principalId("outsider-principal");
const projectId = "project-dlv-1";
const otherProjectId = "project-dlv-2";
const rootNodeId = "node-dlv-root";
const subNodeId = "node-dlv-sub";
const otherNodeId = "node-dlv-other";
const dlvTenantGrantDomain = "grant-dlv-domain";

type Fixture = {
  name: "memory" | "sqlite";
  persistence: Persistence;
  path?: string;
  testHarness: TestReadinessHarness;
  cleanup(): Promise<void>;
};

async function createFixture(
  name: "memory" | "sqlite",
  options: { now?: () => Date } = {},
): Promise<Fixture> {
  if (name === "memory") {
    const bundle = createTestMemoryBundle({ now: options.now });
    return {
      name,
      persistence: bundle.persistence,
      testHarness: bundle.testHarness,
      cleanup: async () => await bundle.persistence.close(),
    };
  }
  const directory = await mkdtemp(join(tmpdir(), "ppm-dlv-"));
  const path = join(directory, "dlv.sqlite");
  const bundle = createTestSqliteBundle({ path, now: options.now });
  return {
    name,
    persistence: bundle.persistence,
    path,
    testHarness: bundle.testHarness,
    cleanup: async () => {
      await bundle.persistence.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function setupBaseProject(persistence: Persistence, tId: TenantId = tenant): Promise<void> {
  const atUtc = "2026-09-04T00:00:00.000Z";
  await grantProjectMembership(persistence, tId, projectId, pm, { role: "project_manager" });
  await grantProjectMembership(persistence, tId, projectId, nodeLeader, { role: "member" });
  await grantProjectMembership(persistence, tId, projectId, reviewer, { role: "member" });
  await grantProjectMembership(persistence, tId, projectId, member, { role: "member" });

  await persistence.transaction(tId, async (tx) => {
    const rootNode: ProjectNode = {
      tenantId: tId,
      id: rootNodeId,
      projectId,
      parentId: null,
      leaderPrincipalId: null,
      title: "Root Node",
      kind: "stage",
      securityDomainId: null,
      securityEpoch: 1,
      version: 1,
      deletedAtUtc: null,
    };
    await tx.nodes.insert(rootNode);

    const subNode: ProjectNode = {
      tenantId: tId,
      id: subNodeId,
      projectId,
      parentId: rootNodeId,
      leaderPrincipalId: null,
      title: "Sub WorkPackage",
      kind: "work_package",
      securityDomainId: null,
      securityEpoch: 1,
      version: 1,
      deletedAtUtc: null,
    };
    await tx.nodes.insert(subNode);

    const otherNode: ProjectNode = {
      tenantId: tId,
      id: otherNodeId,
      projectId,
      parentId: rootNodeId,
      leaderPrincipalId: null,
      title: "Other WorkPackage",
      kind: "work_package",
      securityDomainId: null,
      securityEpoch: 1,
      version: 1,
      deletedAtUtc: null,
    };
    await tx.nodes.insert(otherNode);
  });

  await executeAssignNodeLeader(persistence, {
    tenantId: tId,
    commandId: `cmd-assign-leader-${subNodeId}-${Date.now()}`,
    idempotencyKey: `idem-assign-leader-${subNodeId}-${Date.now()}`,
    correlationId: `cor-assign-leader-${subNodeId}`,
    principalId: pm,
    projectId,
    nodeId: subNodeId,
    leaderPrincipalId: nodeLeader,
    expectedVersion: 1,
    occurredAtUtc: atUtc,
  });
}

async function assertNoCommandResidue(
  fixture: Fixture,
  params: { commandId: string; principalId: PrincipalId; operation: string; idempotencyKey: string },
): Promise<void> {
  if (fixture.name === "memory") {
    const snapshot = (fixture.persistence as MemoryPersistence).snapshot();
    assert.equal([...snapshot.events.values()].some((event) => event.eventId === `evt:${params.commandId}`), false);
    assert.equal([...snapshot.outbox.values()].some((message) => message.eventId === `evt:${params.commandId}`), false);
    assert.equal([...snapshot.receipts.values()].some((receipt) =>
      receipt.scope.principalId === params.principalId
      && receipt.scope.operation === params.operation
      && receipt.scope.idempotencyKey === params.idempotencyKey), false);
    return;
  }
  const database = new DatabaseSync(fixture.path!, { readOnly: true });
  try {
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE event_id = ?").get(`evt:${params.commandId}`) as { count: number }).count, 0);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM outbox_messages WHERE event_id = ?").get(`evt:${params.commandId}`) as { count: number }).count, 0);
    assert.equal((database.prepare(`
      SELECT COUNT(*) AS count FROM command_receipts
      WHERE principal_id = ? AND operation = ? AND idempotency_key = ?
    `).get(params.principalId, params.operation, params.idempotencyKey) as { count: number }).count, 0);
  } finally {
    database.close();
  }
}

async function insertAsset(
  persistence: Persistence,
  params: {
    tenantId?: TenantId;
    assetId: string;
    projectId?: string;
    ownerNodeId: string;
    lifecycleState?: "initiated" | "uploading" | "scanning" | "available" | "quarantined" | "failed" | "deleted";
    securityDomainId?: string | null;
    securityEpoch?: number;
    deletedAtUtc?: string | null;
  },
): Promise<void> {
  const tId = params.tenantId ?? tenant;
  const pId = params.projectId ?? projectId;
  const atUtc = "2026-09-04T00:00:00.000Z";
  await persistence.transaction(tId, async (tx) => {
    await tx.assets.insert({
      tenantId: tId,
      id: params.assetId,
      projectId: pId,
      ownerNodeId: params.ownerNodeId,
      securityDomainId: params.securityDomainId ?? null,
      securityEpoch: params.securityEpoch ?? 1,
      uploaderPrincipalId: nodeLeader,
      displayName: `Asset ${params.assetId}`,
      contentType: "application/pdf",
      size: 1024,
      sha256: "abc123def456",
      lifecycleState: params.lifecycleState ?? "available",
      failureCode: null,
      version: 1,
      deletedAtUtc: params.deletedAtUtc ?? null,
    });
  });
}

// --------------------------------------------------------------------------
// 1. Domain contract & state machine assertions
// --------------------------------------------------------------------------
test("TC-DLV-001: Domain assertions, key validation and schema registry", () => {
  assert.doesNotThrow(() => assertValidRequirementKey("spec-design-doc"));
  assert.doesNotThrow(() => assertValidRequirementKey("FINAL_REPORT_2026"));
  assert.throws(() => assertValidRequirementKey(""), /INVALID_DELIVERABLE_KEY/);
  assert.throws(() => assertValidRequirementKey("bad key with spaces"), /INVALID_DELIVERABLE_KEY/);
  assert.throws(() => assertValidRequirementKey("bad/slashes"), /INVALID_DELIVERABLE_KEY/);

  const validReq: DeliverableRequirement = {
    tenantId: tenant,
    id: "req-1",
    projectId,
    ownerNodeId: subNodeId,
    securityDomainId: null,
    securityEpoch: 1,
    requirementKey: "req-key-1",
    title: "Design Doc",
    description: "Detailed architecture doc",
    required: true,
    acceptedSourceTypes: ["file"],
    minCount: 1,
    reviewerPrincipalId: reviewer,
    status: "pending",
    acceptedByPrincipalId: null,
    acceptedAtUtc: null,
    acceptedReason: null,
    waivedByPrincipalId: null,
    waivedAtUtc: null,
    waivedReason: null,
    version: 1,
    createdAtUtc: "2026-09-04T00:00:00.000Z",
    updatedAtUtc: "2026-09-04T00:00:00.000Z",
    deletedAtUtc: null,
  };

  assert.doesNotThrow(() => assertCanonicalDeliverableRequirement(validReq, { tenantId: tenant }));
  assert.throws(() => assertCanonicalDeliverableRequirement(validReq, { tenantId: foreignTenant }), /tenantId drift/);
  assert.throws(() => assertCanonicalDeliverableRequirement({ ...validReq, minCount: 0 }), /minCount must be positive/);
  assert.throws(() => assertCanonicalDeliverableRequirement({ ...validReq, acceptedSourceTypes: [] }), /acceptedSourceTypes/);

  // R2F1: Terminal state invariants (fail-closed on corrupt records)
  // accepted requires acceptedByPrincipalId and acceptedAtUtc
  const acceptedReq: DeliverableRequirement = {
    ...validReq,
    status: "accepted",
    acceptedByPrincipalId: reviewer,
    acceptedAtUtc: "2026-09-04T02:00:00.000Z",
    acceptedReason: "ok",
  };
  assert.doesNotThrow(() => assertCanonicalDeliverableRequirement(acceptedReq, { tenantId: tenant }));
  assert.throws(
    () => assertCanonicalDeliverableRequirement({ ...acceptedReq, acceptedByPrincipalId: null }),
    /accepted status requires acceptedByPrincipalId/,
  );
  assert.throws(
    () => assertCanonicalDeliverableRequirement({ ...acceptedReq, acceptedAtUtc: null }),
    /accepted status requires a valid acceptedAtUtc/,
  );
  // accepted must not carry waiver fields
  assert.throws(
    () => assertCanonicalDeliverableRequirement({ ...acceptedReq, waivedReason: "bad" } as unknown as DeliverableRequirement),
    /accepted status must not carry waiver fields/,
  );
  // waived requires waivedByPrincipalId, waivedAtUtc and non-empty waivedReason
  const waivedReq: DeliverableRequirement = {
    ...validReq,
    status: "waived",
    waivedByPrincipalId: pm,
    waivedAtUtc: "2026-09-04T02:00:00.000Z",
    waivedReason: "no longer needed",
  };
  assert.doesNotThrow(() => assertCanonicalDeliverableRequirement(waivedReq, { tenantId: tenant }));
  assert.throws(
    () => assertCanonicalDeliverableRequirement({ ...waivedReq, waivedByPrincipalId: null }),
    /waived status requires waivedByPrincipalId/,
  );
  assert.throws(
    () => assertCanonicalDeliverableRequirement({ ...waivedReq, waivedReason: "   " } as unknown as DeliverableRequirement),
    /waived status requires a non-empty waivedReason/,
  );
  // waived must not carry acceptance fields
  assert.throws(
    () => assertCanonicalDeliverableRequirement({ ...waivedReq, acceptedByPrincipalId: reviewer, acceptedAtUtc: "2026-09-04T03:00:00.000Z", acceptedReason: "nope" } as unknown as DeliverableRequirement),
    /waived status must not carry acceptance fields/,
  );
  // non-terminal statuses must not carry terminal fields
  assert.throws(
    () => assertCanonicalDeliverableRequirement({ ...validReq, acceptedByPrincipalId: reviewer, acceptedAtUtc: "2026-09-04T03:00:00.000Z", acceptedReason: "nope" } as unknown as DeliverableRequirement),
    /non-terminal status must not carry acceptance fields/,
  );
  assert.throws(
    () => assertCanonicalDeliverableRequirement({ ...validReq, waivedByPrincipalId: pm, waivedAtUtc: "2026-09-04T03:00:00.000Z", waivedReason: "x" } as unknown as DeliverableRequirement),
    /non-terminal status must not carry waiver fields/,
  );
  // deletedAtUtc must be canonical UTC
  assert.doesNotThrow(() => assertCanonicalDeliverableRequirement({ ...validReq, deletedAtUtc: "2026-09-04T03:00:00.000Z" }, { tenantId: tenant }));
  assert.throws(
    () => assertCanonicalDeliverableRequirement({ ...validReq, deletedAtUtc: "not-a-timestamp" } as unknown as DeliverableRequirement),
    /deletedAtUtc must be a canonical UTC timestamp/,
  );
  assert.throws(
    () => assertCanonicalDeliverableRequirement({ ...acceptedReq, acceptedByPrincipalId: "" } as unknown as DeliverableRequirement),
    /acceptedByPrincipalId must be a canonical non-empty string/,
  );
  assert.throws(
    () => assertCanonicalDeliverableRequirement({ ...acceptedReq, acceptedReason: 42 } as unknown as DeliverableRequirement),
    /acceptedReason must be a canonical non-empty string or null/,
  );
  assert.throws(
    () => assertCanonicalDeliverableRequirement({ ...waivedReq, waivedAtUtc: 42 } as unknown as DeliverableRequirement),
    /waived status requires a valid waivedAtUtc/,
  );

  const validSubmitAction: DeliverableActionRecord = {
    tenantId: tenant,
    id: "act-submit-domain",
    requirementId: validReq.id,
    action: "submitted",
    actorPrincipalId: nodeLeader,
    occurredAtUtc: "2026-09-04T01:00:00.000Z",
    reason: null,
    evidenceCount: 1,
    evidenceIds: ["asset-domain"],
  };
  assert.doesNotThrow(() => assertCanonicalDeliverableActionRecord(validSubmitAction));
  assert.throws(
    () => assertCanonicalDeliverableActionRecord({ ...validSubmitAction, actorPrincipalId: "" } as DeliverableActionRecord),
    /invalid actorPrincipalId/,
  );
  assert.throws(
    () => assertCanonicalDeliverableActionRecord({ ...validSubmitAction, reason: 42 } as unknown as DeliverableActionRecord),
    /reason must be a canonical non-empty string or null/,
  );
  assert.throws(
    () => assertCanonicalDeliverableActionRecord({ ...validSubmitAction, evidenceIds: ["asset-domain", 42], evidenceCount: 2 } as unknown as DeliverableActionRecord),
    /evidenceIds must contain canonical non-empty strings/,
  );
  assert.throws(
    () => assertCanonicalDeliverableActionRecord({ ...validSubmitAction, evidenceIds: ["asset-domain", "asset-domain"], evidenceCount: 2 }),
    /evidenceIds must be unique/,
  );
  assert.throws(
    () => assertCanonicalDeliverableActionRecord({ ...validSubmitAction, evidenceCount: 2 }),
    /evidenceCount must match evidenceIds length/,
  );

  // Transitions
  const submitted = submitDeliverable(validReq, { occurredAtUtc: "2026-09-04T01:00:00.000Z" });
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.version, 2);

  assert.throws(() => submitDeliverable(submitted, { occurredAtUtc: "2026-09-04T01:00:00.000Z" }), /DELIVERABLE_ALREADY_SUBMITTED/);

  const accepted = acceptDeliverable(submitted, {
    acceptedByPrincipalId: reviewer,
    occurredAtUtc: "2026-09-04T02:00:00.000Z",
    acceptedReason: "Looks great",
  });
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.acceptedByPrincipalId, reviewer);
  assert.equal(accepted.acceptedReason, "Looks great");
  assert.equal(accepted.version, 3);

  assert.throws(() => acceptDeliverable(accepted, { acceptedByPrincipalId: reviewer, occurredAtUtc: "2026-09-04T02:00:00.000Z" }), /DELIVERABLE_ALREADY_ACCEPTED/);
  assert.throws(() => submitDeliverable(accepted, { occurredAtUtc: "2026-09-04T03:00:00.000Z" }), /DELIVERABLE_IS_TERMINAL/);
  assert.throws(() => waiveDeliverable(accepted, { waivedByPrincipalId: pm, occurredAtUtc: "2026-09-04T03:00:00.000Z", reason: "Cannot waive accepted" }), /DELIVERABLE_ALREADY_ACCEPTED/);

  const waived = waiveDeliverable(validReq, {
    waivedByPrincipalId: pm,
    occurredAtUtc: "2026-09-04T02:00:00.000Z",
    reason: "No longer needed for this milestone",
  });
  assert.equal(waived.status, "waived");
  assert.equal(waived.waivedByPrincipalId, pm);
  assert.equal(waived.version, 2);

  assert.throws(() => waiveDeliverable(validReq, { waivedByPrincipalId: pm, occurredAtUtc: "2026-09-04T02:00:00.000Z", reason: "   " }), /WAIVER_REASON_REQUIRED/);
  assert.throws(() => waiveDeliverable(waived, { waivedByPrincipalId: pm, occurredAtUtc: "2026-09-04T02:00:00.000Z", reason: "Already waived" }), /DELIVERABLE_ALREADY_WAIVED/);
  assert.throws(() => acceptDeliverable(waived, { acceptedByPrincipalId: reviewer, occurredAtUtc: "2026-09-04T03:00:00.000Z" }), /DELIVERABLE_IS_TERMINAL/);

  // Schema registry & sensitive field assertions
  const initEvent: DomainEvent = {
    tenantId: tenant,
    eventId: "evt-init-1",
    projectId,
    projectSequence: 1,
    aggregateType: "deliverable",
    aggregateId: "req-1",
    aggregateVersion: 1,
    eventType: "project-map.deliverable.initialized",
    schemaVersion: 1,
    actorPrincipalId: pm,
    occurredAtUtc: "2026-09-04T00:00:00.000Z",
    correlationId: "cor-1",
    causationId: "cmd-1",
    originalSecurityDomainId: null,
    originalSecurityEpoch: 1,
    payload: {
      projectId,
      nodeId: subNodeId,
      deliverableId: "req-1",
      requirementKey: "req-key-1",
      required: true,
      minCount: 1,
      reviewerPrincipalId: reviewer,
    },
  };
  assert.doesNotThrow(() => validateEventAgainstSchema(initEvent));
  assert.doesNotThrow(() => assertNoSensitiveFields(initEvent));
  assert.throws(() => assertNoSensitiveFields({ ...initEvent, payload: { ...initEvent.payload, secret: "leak" } }), /SENSITIVE_FIELD_FORBIDDEN/);
});

test("R2F2-3/4: Memory and SQLite reject corrupt canonical facts and duplicate evidence natural keys", async () => {
  for (const backend of ["memory", "sqlite"] as const) {
    const fixture = await createFixture(backend);
    try {
      await setupBaseProject(fixture.persistence);
      await new InitializeDeliverableRequirementHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: `cmd-init-canonical-${backend}`,
        idempotencyKey: `idem-init-canonical-${backend}`,
        correlationId: `corr-init-canonical-${backend}`,
        principalId: pm,
        projectId,
        nodeId: subNodeId,
        deliverableId: `req-canonical-${backend}`,
        requirementKey: `key-canonical-${backend}`,
        title: "Canonical persistence",
        required: true,
        acceptedSourceTypes: ["file"],
        minCount: 1,
        reviewerPrincipalId: reviewer,
        occurredAtUtc: "2026-09-04T00:00:00.000Z",
      });
      const requirementId = `req-canonical-${backend}`;
      const linkBase: EvidenceLink = {
        tenantId: tenant,
        id: `link-canonical-${backend}-1`,
        requirementId,
        sourceType: "file",
        sourceId: "asset-natural-key",
        submittedByPrincipalId: nodeLeader,
        linkedAtUtc: "2026-09-04T01:00:00.000Z",
        version: 1,
      };
      await fixture.persistence.transaction(tenant, async (tx) => tx.deliverables.appendEvidenceLink(linkBase));
      await assert.rejects(
        fixture.persistence.transaction(tenant, async (tx) => tx.deliverables.appendEvidenceLink({
          ...linkBase,
          id: `link-canonical-${backend}-2`,
        })),
        /EVIDENCE_LINK_ALREADY_EXISTS|UNIQUE constraint failed/,
      );
      const canonicalAction: DeliverableActionRecord = {
        tenantId: tenant,
        id: `action-base-${backend}`,
        requirementId,
        action: "submitted",
        actorPrincipalId: nodeLeader,
        occurredAtUtc: "2026-09-04T01:00:00.000Z",
        reason: null,
        evidenceCount: 1,
        evidenceIds: ["asset-natural-key"],
      };
      const corruptActions = [
        { ...canonicalAction, id: `action-empty-actor-${backend}`, actorPrincipalId: "" },
        { ...canonicalAction, id: `action-bad-reason-${backend}`, reason: 42 },
        { ...canonicalAction, id: `action-bad-id-${backend}`, evidenceIds: [42] },
        { ...canonicalAction, id: `action-duplicate-id-${backend}`, evidenceCount: 2, evidenceIds: ["asset-natural-key", "asset-natural-key"] },
        { ...canonicalAction, id: `action-count-${backend}`, evidenceCount: 2 },
      ];
      for (const corruptAction of corruptActions) {
        await assert.rejects(
          fixture.persistence.transaction(tenant, async (tx) =>
            tx.deliverables.appendAction(corruptAction as unknown as DeliverableActionRecord)),
          /DELIVERABLE_ACTION_RECORD_CORRUPT/,
        );
      }
      const storedRequirement = await fixture.persistence.read(tenant, async (tx) => tx.deliverables.get(requirementId));
      assert.ok(storedRequirement);
      await assert.rejects(
        fixture.persistence.transaction(tenant, async (tx) => tx.deliverables.insert({
          ...storedRequirement,
          id: `req-bad-terminal-${backend}`,
          requirementKey: `key-bad-terminal-${backend}`,
          status: "accepted",
          acceptedByPrincipalId: "",
          acceptedAtUtc: "2026-09-04T02:00:00.000Z",
        } as DeliverableRequirement)),
        /DELIVERABLE_RECORD_CORRUPT/,
      );

      if (backend === "memory") {
        const snapshot = (fixture.persistence as MemoryPersistence).snapshot();
        const key = `${tenant}\u0000${requirementId}`;
        const stored = snapshot.deliverables.get(key)!;
        snapshot.deliverables.set(key, { ...stored, acceptedByPrincipalId: "" } as DeliverableRequirement);
        const actionKey = `${tenant}\u0000act:cmd-init-canonical-${backend}`;
        const action = snapshot.deliverableActions.get(actionKey)!;
        snapshot.deliverableActions.set(actionKey, { ...action, actorPrincipalId: "" } as DeliverableActionRecord);
        const reopened = new MemoryPersistence({ snapshot });
        await assert.rejects(
          reopened.read(tenant, async (tx) => tx.deliverables.get(requirementId)),
          /DELIVERABLE_RECORD_CORRUPT/,
        );
        await assert.rejects(
          reopened.read(tenant, async (tx) => tx.deliverables.listActions(requirementId)),
          /DELIVERABLE_ACTION_RECORD_CORRUPT/,
        );
        await reopened.close();
      } else {
        await fixture.persistence.close();
        const raw = new DatabaseSync(fixture.path!);
        const row = raw.prepare("SELECT deliverable_json FROM deliverable_requirements WHERE deliverable_id = ?")
          .get(requirementId) as { deliverable_json: string };
        const corrupt = JSON.parse(row.deliverable_json) as Record<string, unknown>;
        corrupt.acceptedByPrincipalId = "";
        raw.prepare("UPDATE deliverable_requirements SET deliverable_json = ? WHERE deliverable_id = ?")
          .run(JSON.stringify(corrupt), requirementId);
        raw.prepare("UPDATE deliverable_action_records SET actor_principal_id = '' WHERE requirement_id = ?")
          .run(requirementId);
        raw.close();
        const reopened = new SqlitePersistence({ path: fixture.path! });
        await assert.rejects(
          reopened.read(tenant, async (tx) => tx.deliverables.get(requirementId)),
          /DELIVERABLE_RECORD_CORRUPT/,
        );
        await assert.rejects(
          reopened.read(tenant, async (tx) => tx.deliverables.listActions(requirementId)),
          /DELIVERABLE_ACTION_RECORD_CORRUPT/,
        );
        await reopened.close();
      }
    } finally {
      await fixture.cleanup();
    }
  }
});

// --------------------------------------------------------------------------
// 2. TC-DLV-001: File-backed positive & negative cross-boundary matrices
// --------------------------------------------------------------------------
for (const backend of ["memory", "sqlite"] as const) {
  test(`TC-DLV-001 (${backend}): file-backed submission positive and negative boundary matrix`, async () => {
    const fixture = await createFixture(backend);
    try {
      await setupBaseProject(fixture.persistence);

      const initHandler = new InitializeDeliverableRequirementHandler(fixture.persistence);
      const submitHandler = new SubmitDeliverableEvidenceHandler(fixture.persistence);

      // Node Leader cannot initialize deliverable requirement (strictly PM only)
      await assert.rejects(
        () => initHandler.execute({
          tenantId: tenant,
          commandId: "cmd-init-leader-forbidden",
          idempotencyKey: "idem-init-leader-forbidden",
          correlationId: "corr-init-leader-forbidden",
          principalId: nodeLeader,
          projectId,
          nodeId: subNodeId,
          deliverableId: "req-leader-forbidden",
          requirementKey: "req-key-leader",
          title: "Leader Init Attempt",
          required: true,
          acceptedSourceTypes: ["file"],
          minCount: 1,
          reviewerPrincipalId: reviewer,
          occurredAtUtc: "2026-09-04T00:00:00.000Z",
        }),
        (err: ApplicationError) => err.code === "PM_ROLE_REQUIRED",
      );

      // Initialize requirement: minCount = 2
      const initResult = await initHandler.execute({
        tenantId: tenant,
        commandId: "cmd-init-1",
        idempotencyKey: "idem-init-1",
        correlationId: "corr-init-1",
        principalId: pm,
        projectId,
        nodeId: subNodeId,
        deliverableId: "req-file-1",
        requirementKey: "req-key-docs",
        title: "Architecture Docs",
        required: true,
        acceptedSourceTypes: ["file"],
        minCount: 2,
        reviewerPrincipalId: reviewer,
        occurredAtUtc: "2026-09-04T00:00:00.000Z",
      });
      assert.equal(initResult.value.status, "pending");
      assert.equal(initResult.value.minCount, 2);

      // Insert valid assets under subNodeId
      await insertAsset(fixture.persistence, { assetId: "asset-sub-1", ownerNodeId: subNodeId });
      await insertAsset(fixture.persistence, { assetId: "asset-sub-2", ownerNodeId: subNodeId });

      // Negative: insufficient evidence count (< minCount 2)
      await assert.rejects(
        () => submitHandler.execute({
          tenantId: tenant,
          commandId: "cmd-submit-insufficient",
          idempotencyKey: "idem-sub-insufficient",
          correlationId: "corr-1",
          principalId: nodeLeader,
          deliverableId: "req-file-1",
          expectedVersion: 1,
          evidence: [{ sourceType: "file", sourceId: "asset-sub-1" }],
          occurredAtUtc: "2026-09-04T01:00:00.000Z",
        }),
        (err: ApplicationError) => err.code === "INSUFFICIENT_EVIDENCE_COUNT",
      );

      // Negative: duplicate evidence items
      await assert.rejects(
        () => submitHandler.execute({
          tenantId: tenant,
          commandId: "cmd-submit-dup",
          idempotencyKey: "idem-sub-dup",
          correlationId: "corr-2",
          principalId: nodeLeader,
          deliverableId: "req-file-1",
          expectedVersion: 1,
          evidence: [
            { sourceType: "file", sourceId: "asset-sub-1" },
            { sourceType: "file", sourceId: "asset-sub-1" },
          ],
          occurredAtUtc: "2026-09-04T01:00:00.000Z",
        }),
        (err: ApplicationError) => err.code === "DUPLICATE_EVIDENCE",
      );

      // Negative: ProcessRecord unsupported fail-closed
      await assert.rejects(
        () => submitHandler.execute({
          tenantId: tenant,
          commandId: "cmd-submit-proc",
          idempotencyKey: "idem-sub-proc",
          correlationId: "corr-3",
          principalId: nodeLeader,
          deliverableId: "req-file-1",
          expectedVersion: 1,
          evidence: [
            { sourceType: "file", sourceId: "asset-sub-1" },
            { sourceType: "process_record", sourceId: "proc-123" },
          ],
          occurredAtUtc: "2026-09-04T01:00:00.000Z",
        }),
        (err: ApplicationError) => err.code === "SOURCE_TYPE_UNSUPPORTED" || err.code === "PROCESS_RECORD_UNSUPPORTED",
      );

      // Negative: cross-node asset
      await insertAsset(fixture.persistence, { assetId: "asset-other-node", ownerNodeId: otherNodeId });
      await assert.rejects(
        () => submitHandler.execute({
          tenantId: tenant,
          commandId: "cmd-submit-cross-node",
          idempotencyKey: "idem-sub-cross-node",
          correlationId: "corr-4",
          principalId: nodeLeader,
          deliverableId: "req-file-1",
          expectedVersion: 1,
          evidence: [
            { sourceType: "file", sourceId: "asset-sub-1" },
            { sourceType: "file", sourceId: "asset-other-node" },
          ],
          occurredAtUtc: "2026-09-04T01:00:00.000Z",
        }),
        (err: ApplicationError) => err.code === "EVIDENCE_NOT_FOUND",
      );

      // Negative: cross-project asset
      await insertAsset(fixture.persistence, {
        assetId: "asset-cross-proj",
        projectId: otherProjectId,
        ownerNodeId: subNodeId,
      });
      await assert.rejects(
        () => submitHandler.execute({
          tenantId: tenant,
          commandId: "cmd-submit-cross-proj",
          idempotencyKey: "idem-sub-cross-proj",
          correlationId: "corr-5",
          principalId: nodeLeader,
          deliverableId: "req-file-1",
          expectedVersion: 1,
          evidence: [
            { sourceType: "file", sourceId: "asset-sub-1" },
            { sourceType: "file", sourceId: "asset-cross-proj" },
          ],
          occurredAtUtc: "2026-09-04T01:00:00.000Z",
        }),
        (err: ApplicationError) => err.code === "EVIDENCE_NOT_FOUND",
      );

      // Negative: deleted asset -> EVIDENCE_NOT_FOUND (unified, previously NOT_AVAILABLE)
      await insertAsset(fixture.persistence, {
        assetId: "asset-deleted",
        ownerNodeId: subNodeId,
        deletedAtUtc: "2026-09-04T00:30:00.000Z",
      });
      await assert.rejects(
        () => submitHandler.execute({
          tenantId: tenant,
          commandId: "cmd-submit-deleted",
          idempotencyKey: "idem-sub-deleted",
          correlationId: "corr-6",
          principalId: nodeLeader,
          deliverableId: "req-file-1",
          expectedVersion: 1,
          evidence: [
            { sourceType: "file", sourceId: "asset-sub-1" },
            { sourceType: "file", sourceId: "asset-deleted" },
          ],
          occurredAtUtc: "2026-09-04T01:00:00.000Z",
        }),
        (err: ApplicationError) => err.code === "EVIDENCE_NOT_FOUND",
      );

      // Negative: uploading / quarantined / failed asset
      for (const badState of ["uploading", "quarantined", "failed"] as const) {
        await insertAsset(fixture.persistence, {
          assetId: `asset-${badState}`,
          ownerNodeId: subNodeId,
          lifecycleState: badState,
        });
        await assert.rejects(
          () => submitHandler.execute({
            tenantId: tenant,
            commandId: `cmd-submit-${badState}`,
            idempotencyKey: `idem-sub-${badState}`,
            correlationId: "corr-state",
            principalId: nodeLeader,
            deliverableId: "req-file-1",
            expectedVersion: 1,
            evidence: [
              { sourceType: "file", sourceId: "asset-sub-1" },
              { sourceType: "file", sourceId: `asset-${badState}` },
            ],
            occurredAtUtc: "2026-09-04T01:00:00.000Z",
          }),
          (err: ApplicationError) => err.code === "EVIDENCE_NOT_AVAILABLE",
        );
      }

      // Positive submission: node leader submits 2 valid available assets
      const submitResult = await submitHandler.execute({
        tenantId: tenant,
        commandId: "cmd-submit-valid",
        idempotencyKey: "idem-sub-valid",
        correlationId: "corr-valid",
        principalId: nodeLeader,
        deliverableId: "req-file-1",
        expectedVersion: 1,
        evidence: [
          { sourceType: "file", sourceId: "asset-sub-1" },
          { sourceType: "file", sourceId: "asset-sub-2" },
        ],
        occurredAtUtc: "2026-09-04T01:00:00.000Z",
      });

      assert.equal(submitResult.value.status, "submitted");
      assert.equal(submitResult.value.version, 2);
      assert.equal(submitResult.value.evidenceLinks.length, 2);
      assert.equal(submitResult.value.actionHistory.length, 2);
      assert.equal(submitResult.value.actionHistory[0]?.action, "initialized");
      assert.equal(submitResult.value.actionHistory[1]?.action, "submitted");
      assert.equal(submitResult.replayed, false);

      // Verify asset bindings exist
      await fixture.persistence.read(tenant, async (tx) => {
        const bindings = await tx.assets.listBindings("deliverable", "req-file-1");
        assert.equal(bindings.length, 2);
        assert.ok(bindings.some((b) => b.assetId === "asset-sub-1"));
        assert.ok(bindings.some((b) => b.assetId === "asset-sub-2"));
      });
    } finally {
      await fixture.cleanup();
    }
  });
}

// --------------------------------------------------------------------------
// 3. TC-DLV-003: Reviewer acceptance, PM waiver, CAS, time & replay
// --------------------------------------------------------------------------
for (const backend of ["memory", "sqlite"] as const) {
  test(`TC-DLV-003 (${backend}): Reviewer acceptance, PM waiver, CAS, trusted time and replay reauthorization`, async () => {
    const fixture = await createFixture(backend);
    try {
      await setupBaseProject(fixture.persistence);

      const initHandler = new InitializeDeliverableRequirementHandler(fixture.persistence);
      const submitHandler = new SubmitDeliverableEvidenceHandler(fixture.persistence);
      const acceptHandler = new AcceptDeliverableHandler(fixture.persistence);
      const waiveHandler = new WaiveDeliverableHandler(fixture.persistence);

      // Initialize requirement 1 for accept flow
      await initHandler.execute({
        tenantId: tenant,
        commandId: "cmd-init-2",
        idempotencyKey: "idem-init-2",
        correlationId: "corr-init-2",
        principalId: pm,
        projectId,
        nodeId: subNodeId,
        deliverableId: "req-dlv-accept",
        requirementKey: "key-accept",
        title: "Test Accept",
        required: true,
        acceptedSourceTypes: ["file"],
        minCount: 1,
        reviewerPrincipalId: reviewer,
        occurredAtUtc: "2026-09-04T00:00:00.000Z",
      });

      await insertAsset(fixture.persistence, { assetId: "asset-for-accept", ownerNodeId: subNodeId });

      // Submitter authorization: ordinary member cannot submit
      await assert.rejects(
        () => submitHandler.execute({
          tenantId: tenant,
          commandId: "cmd-sub-member-denied",
          idempotencyKey: "idem-sub-member",
          correlationId: "corr-denied",
          principalId: member,
          deliverableId: "req-dlv-accept",
          expectedVersion: 1,
          evidence: [{ sourceType: "file", sourceId: "asset-for-accept" }],
          occurredAtUtc: "2026-09-04T01:00:00.000Z",
        }),
        (err: ApplicationError) => err.code === "DELIVERABLE_SUBMISSION_FORBIDDEN",
      );

      // Node leader submits successfully
      await submitHandler.execute({
        tenantId: tenant,
        commandId: "cmd-sub-leader-ok",
        idempotencyKey: "idem-sub-leader",
        correlationId: "corr-leader-ok",
        principalId: nodeLeader,
        deliverableId: "req-dlv-accept",
        expectedVersion: 1,
        evidence: [{ sourceType: "file", sourceId: "asset-for-accept" }],
        occurredAtUtc: "2026-09-04T01:00:00.000Z",
      });

      // Acceptance authorization:
      // Submitter or ordinary member cannot accept
      await assert.rejects(
        () => acceptHandler.execute({
          tenantId: tenant,
          commandId: "cmd-acc-unauth",
          idempotencyKey: "idem-acc-unauth",
          correlationId: "corr-acc-unauth",
          principalId: member,
          deliverableId: "req-dlv-accept",
          expectedVersion: 2,
          occurredAtUtc: "2026-09-04T02:00:00.000Z",
        }),
        (err: ApplicationError) => err.code === "DELIVERABLE_ACTION_FORBIDDEN",
      );

      // CAS conflict on accept (expectedVersion = 1 instead of 2)
      await assert.rejects(
        () => acceptHandler.execute({
          tenantId: tenant,
          commandId: "cmd-acc-cas",
          idempotencyKey: "idem-acc-cas",
          correlationId: "corr-acc-cas",
          principalId: reviewer,
          deliverableId: "req-dlv-accept",
          expectedVersion: 1,
          occurredAtUtc: "2026-09-04T02:00:00.000Z",
        }),
        (err: ApplicationError) => err.code === "DELIVERABLE_VERSION_CONFLICT",
      );

      // Reviewer accepts successfully
      const acceptResult = await acceptHandler.execute({
        tenantId: tenant,
        commandId: "cmd-acc-ok",
        idempotencyKey: "idem-acc-ok",
        correlationId: "corr-acc-ok",
        principalId: reviewer,
        deliverableId: "req-dlv-accept",
        expectedVersion: 2,
        note: "Accepted with approval",
        occurredAtUtc: "2026-09-04T02:00:00.000Z",
      });

      assert.equal(acceptResult.value.status, "accepted");
      assert.equal(acceptResult.value.acceptedByPrincipalId, reviewer);
      assert.equal(acceptResult.value.acceptedReason, "Accepted with approval");
      assert.equal(acceptResult.value.version, 3);
      assert.equal(acceptResult.replayed, false);

      // Idempotent replay of accept
      const replayAccept = await acceptHandler.execute({
        tenantId: tenant,
        commandId: "cmd-acc-replay",
        idempotencyKey: "idem-acc-ok",
        correlationId: "corr-acc-replay",
        principalId: reviewer,
        deliverableId: "req-dlv-accept",
        expectedVersion: 2,
        note: "Accepted with approval",
        occurredAtUtc: "2026-09-04T02:00:00.000Z",
      });
      assert.equal(replayAccept.replayed, true);
      assert.equal(replayAccept.value.status, "accepted");

      // Idempotent replay with different payload fails
      await assert.rejects(
        () => acceptHandler.execute({
          tenantId: tenant,
          commandId: "cmd-acc-diff",
          idempotencyKey: "idem-acc-ok",
          correlationId: "corr-acc-diff",
          principalId: reviewer,
          deliverableId: "req-dlv-accept",
          expectedVersion: 2,
          note: "DIFFERENT NOTE",
          occurredAtUtc: "2026-09-04T02:05:00.000Z",
        }),
        (err: ApplicationError) => err.code === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
      );

      // Initialize requirement 2 for waiver flow
      await initHandler.execute({
        tenantId: tenant,
        commandId: "cmd-init-3",
        idempotencyKey: "idem-init-3",
        correlationId: "corr-init-3",
        principalId: pm,
        projectId,
        nodeId: subNodeId,
        deliverableId: "req-dlv-waive",
        requirementKey: "key-waive",
        title: "Test Waive",
        required: true,
        acceptedSourceTypes: ["file"],
        minCount: 1,
        reviewerPrincipalId: reviewer,
        occurredAtUtc: "2026-09-04T00:00:00.000Z",
      });

      // Waiver authorization: Node leader cannot waive
      await assert.rejects(
        () => waiveHandler.execute({
          tenantId: tenant,
          commandId: "cmd-waive-leader-denied",
          idempotencyKey: "idem-waive-leader",
          correlationId: "corr-waive-leader",
          principalId: nodeLeader,
          deliverableId: "req-dlv-waive",
          expectedVersion: 1,
          reason: "Leader trying to waive",
          occurredAtUtc: "2026-09-04T02:00:00.000Z",
        }),
        (err: ApplicationError) => err.code === "PM_ROLE_REQUIRED" || err.code === "DELIVERABLE_ACTION_FORBIDDEN",
      );

      // Waiver: blank reason fails
      await assert.rejects(
        () => waiveHandler.execute({
          tenantId: tenant,
          commandId: "cmd-waive-blank",
          idempotencyKey: "idem-waive-blank",
          correlationId: "corr-waive-blank",
          principalId: pm,
          deliverableId: "req-dlv-waive",
          expectedVersion: 1,
          reason: "    ",
          occurredAtUtc: "2026-09-04T02:00:00.000Z",
        }),
        (err: ApplicationError) => err.code === "WAIVER_REASON_REQUIRED" || err.code === "VALIDATION_FAILED",
      );

      // PM waives successfully
      const waiveResult = await waiveHandler.execute({
        tenantId: tenant,
        commandId: "cmd-waive-pm-ok",
        idempotencyKey: "idem-waive-pm",
        correlationId: "corr-waive-pm",
        principalId: pm,
        deliverableId: "req-dlv-waive",
        expectedVersion: 1,
        reason: "Scope descoped by management",
        occurredAtUtc: "2026-09-04T02:00:00.000Z",
      });

      assert.equal(waiveResult.value.status, "waived");
      assert.equal(waiveResult.value.waivedByPrincipalId, pm);
      assert.equal(waiveResult.value.waivedReason, "Scope descoped by management");
      assert.equal(waiveResult.value.version, 2);
      assert.equal(waiveResult.replayed, false);

      // Replay of waiver
      const replayWaive = await waiveHandler.execute({
        tenantId: tenant,
        commandId: "cmd-waive-replay",
        idempotencyKey: "idem-waive-pm",
        correlationId: "corr-waive-replay",
        principalId: pm,
        deliverableId: "req-dlv-waive",
        expectedVersion: 1,
        reason: "Scope descoped by management",
        occurredAtUtc: "2026-09-04T02:00:00.000Z",
      });
      assert.equal(replayWaive.replayed, true);
      assert.equal(replayWaive.value.status, "waived");
    } finally {
      await fixture.cleanup();
    }
  });
}

// --------------------------------------------------------------------------
// R2F9 Finding 1: complete deliverable fingerprints include business time
// --------------------------------------------------------------------------
for (const backend of ["memory", "sqlite"] as const) {
  test(`R2F9-1 (${backend}): initialize/submit/accept/waive reject same-key different occurredAtUtc`, async () => {
    const fixture = await createFixture(backend);
    try {
      await setupBaseProject(fixture.persistence);
      const initHandler = new InitializeDeliverableRequirementHandler(fixture.persistence);
      const submitHandler = new SubmitDeliverableEvidenceHandler(fixture.persistence);
      const acceptHandler = new AcceptDeliverableHandler(fixture.persistence);
      const waiveHandler = new WaiveDeliverableHandler(fixture.persistence);
      const mismatch = (error: ApplicationError): boolean =>
        error.code === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD";

      const initializeCommand = {
        tenantId: tenant,
        commandId: `cmd-r2f9-init-${backend}`,
        idempotencyKey: `idem-r2f9-init-${backend}`,
        correlationId: `corr-r2f9-init-${backend}`,
        principalId: pm,
        projectId,
        nodeId: subNodeId,
        deliverableId: `req-r2f9-accept-${backend}`,
        requirementKey: `key-r2f9-accept-${backend}`,
        title: "R2F9 complete fingerprint",
        required: true,
        acceptedSourceTypes: ["file"] as const,
        minCount: 1,
        reviewerPrincipalId: reviewer,
        occurredAtUtc: "2026-09-04T00:00:00.000Z",
      };
      await initHandler.execute(initializeCommand);
      await assert.rejects(
        initHandler.execute({
          ...initializeCommand,
          commandId: `cmd-r2f9-init-mismatch-${backend}`,
          correlationId: `corr-r2f9-init-mismatch-${backend}`,
          occurredAtUtc: "2026-09-04T00:00:01.000Z",
        }),
        mismatch,
      );

      const assetId = `asset-r2f9-${backend}`;
      await insertAsset(fixture.persistence, { assetId, ownerNodeId: subNodeId });
      const submitCommand = {
        tenantId: tenant,
        commandId: `cmd-r2f9-submit-${backend}`,
        idempotencyKey: `idem-r2f9-submit-${backend}`,
        correlationId: `corr-r2f9-submit-${backend}`,
        principalId: nodeLeader,
        deliverableId: initializeCommand.deliverableId,
        expectedVersion: 1,
        evidence: [{ sourceType: "file" as const, sourceId: assetId }],
        occurredAtUtc: "2026-09-04T01:00:00.000Z",
      };
      await submitHandler.execute(submitCommand);
      await assert.rejects(
        submitHandler.execute({
          ...submitCommand,
          commandId: `cmd-r2f9-submit-mismatch-${backend}`,
          correlationId: `corr-r2f9-submit-mismatch-${backend}`,
          occurredAtUtc: "2026-09-04T01:00:01.000Z",
        }),
        mismatch,
      );

      const acceptCommand = {
        tenantId: tenant,
        commandId: `cmd-r2f9-accept-${backend}`,
        idempotencyKey: `idem-r2f9-accept-${backend}`,
        correlationId: `corr-r2f9-accept-${backend}`,
        principalId: reviewer,
        deliverableId: initializeCommand.deliverableId,
        expectedVersion: 2,
        note: "approved",
        occurredAtUtc: "2026-09-04T02:00:00.000Z",
      };
      await acceptHandler.execute(acceptCommand);
      await assert.rejects(
        acceptHandler.execute({
          ...acceptCommand,
          commandId: `cmd-r2f9-accept-mismatch-${backend}`,
          correlationId: `corr-r2f9-accept-mismatch-${backend}`,
          occurredAtUtc: "2026-09-04T02:00:01.000Z",
        }),
        mismatch,
      );

      const waiverInitializeCommand = {
        ...initializeCommand,
        commandId: `cmd-r2f9-init-waive-${backend}`,
        idempotencyKey: `idem-r2f9-init-waive-${backend}`,
        correlationId: `corr-r2f9-init-waive-${backend}`,
        deliverableId: `req-r2f9-waive-${backend}`,
        requirementKey: `key-r2f9-waive-${backend}`,
      };
      await initHandler.execute(waiverInitializeCommand);
      const waiveCommand = {
        tenantId: tenant,
        commandId: `cmd-r2f9-waive-${backend}`,
        idempotencyKey: `idem-r2f9-waive-${backend}`,
        correlationId: `corr-r2f9-waive-${backend}`,
        principalId: pm,
        deliverableId: waiverInitializeCommand.deliverableId,
        expectedVersion: 1,
        reason: "descoped",
        occurredAtUtc: "2026-09-04T02:00:00.000Z",
      };
      await waiveHandler.execute(waiveCommand);
      await assert.rejects(
        waiveHandler.execute({
          ...waiveCommand,
          commandId: `cmd-r2f9-waive-mismatch-${backend}`,
          correlationId: `corr-r2f9-waive-mismatch-${backend}`,
          occurredAtUtc: "2026-09-04T02:00:01.000Z",
        }),
        mismatch,
      );

      await fixture.persistence.read(tenant, async (transaction) => {
        const accepted = await transaction.deliverables.get(initializeCommand.deliverableId);
        const waived = await transaction.deliverables.get(waiverInitializeCommand.deliverableId);
        assert.equal(accepted?.status, "accepted");
        assert.equal(accepted?.version, 3);
        assert.equal(waived?.status, "waived");
        assert.equal(waived?.version, 2);
      });
    } finally {
      await fixture.cleanup();
    }
  });
}

// --------------------------------------------------------------------------
// R2F10 Finding 2: initialize replay binds the full immutable command facts and
// permits only the single canonical initialized action.
// --------------------------------------------------------------------------
test("R2F10-2 (memory/sqlite): initialize replay rejects coordinated immutable-fact and extra-action tamper without new durable facts", async () => {
  for (const backend of ["memory", "sqlite"] as const) {
    for (const tamper of ["reviewer-and-receipt", "extra-action-and-receipt"] as const) {
      const fixture = await createFixture(backend);
      let replayPersistence: Persistence = fixture.persistence;
      try {
        await setupBaseProject(fixture.persistence);
        const suffix = `r2f10-${backend}-${tamper}`;
        const requirementId = `req-${suffix}`;
        const idempotencyKey = `idem-${suffix}`;
        const command = {
          tenantId: tenant,
          commandId: `cmd-${suffix}`,
          idempotencyKey,
          correlationId: `corr-${suffix}`,
          principalId: pm,
          projectId,
          nodeId: subNodeId,
          deliverableId: requirementId,
          requirementKey: `key-${suffix}`,
          title: "  Immutable initialization  ",
          description: "  exact facts  ",
          required: true,
          acceptedSourceTypes: ["file", "process_record"] as const,
          minCount: 2,
          reviewerPrincipalId: reviewer,
          occurredAtUtc: "2026-09-04T00:00:00.000Z",
        };
        await new InitializeDeliverableRequirementHandler(fixture.persistence).execute(command);

        const receiptKey = `${tenant}\u0000${pm}\u0000initialize_deliverable_requirement\u0000${idempotencyKey}`;
        const extraAction: DeliverableActionRecord = {
          tenantId: tenant,
          id: `act:extra-${suffix}`,
          requirementId,
          action: "accepted",
          actorPrincipalId: pm,
          occurredAtUtc: command.occurredAtUtc,
          reason: null,
          evidenceCount: 0,
          evidenceIds: [],
        };
        if (backend === "memory") {
          const snapshot = (fixture.persistence as MemoryPersistence).snapshot();
          const receipt = structuredClone(snapshot.receipts.get(receiptKey)!);
          const result = receipt.result as {
            reviewerPrincipalId: PrincipalId;
            actionHistory: DeliverableActionRecord[];
          };
          if (tamper === "reviewer-and-receipt") {
            const requirementKey = `${tenant}\u0000${requirementId}`;
            const requirement = snapshot.deliverables.get(requirementKey)!;
            snapshot.deliverables.set(requirementKey, { ...requirement, reviewerPrincipalId: member });
            result.reviewerPrincipalId = member;
          } else {
            snapshot.deliverableActions.set(`${tenant}\u0000${extraAction.id}`, extraAction);
            result.actionHistory.push(extraAction);
          }
          snapshot.receipts.set(receiptKey, receipt);
          replayPersistence = new MemoryPersistence({ snapshot });
        } else {
          const raw = new DatabaseSync(fixture.path!);
          const receiptRow = raw.prepare(`
            SELECT result_json FROM command_receipts
            WHERE tenant_id = ? AND principal_id = ?
              AND operation = 'initialize_deliverable_requirement' AND idempotency_key = ?
          `).get(tenant, pm, idempotencyKey) as { result_json: string };
          const result = JSON.parse(receiptRow.result_json) as {
            reviewerPrincipalId: PrincipalId;
            actionHistory: DeliverableActionRecord[];
          };
          if (tamper === "reviewer-and-receipt") {
            const aggregateRow = raw.prepare(`
              SELECT deliverable_json FROM deliverable_requirements
              WHERE tenant_id = ? AND deliverable_id = ?
            `).get(tenant, requirementId) as { deliverable_json: string };
            const aggregate = JSON.parse(aggregateRow.deliverable_json) as DeliverableRequirement;
            raw.prepare(`
              UPDATE deliverable_requirements SET deliverable_json = ?
              WHERE tenant_id = ? AND deliverable_id = ?
            `).run(JSON.stringify({ ...aggregate, reviewerPrincipalId: member }), tenant, requirementId);
            result.reviewerPrincipalId = member;
          } else {
            raw.prepare(`
              INSERT INTO deliverable_action_records (
                tenant_id, action_id, requirement_id, action, actor_principal_id,
                occurred_at_utc, reason, evidence_count, evidence_ids_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              tenant,
              extraAction.id,
              requirementId,
              extraAction.action,
              extraAction.actorPrincipalId,
              extraAction.occurredAtUtc,
              extraAction.reason,
              extraAction.evidenceCount,
              JSON.stringify(extraAction.evidenceIds),
            );
            result.actionHistory.push(extraAction);
          }
          raw.prepare(`
            UPDATE command_receipts SET result_json = ?
            WHERE tenant_id = ? AND principal_id = ?
              AND operation = 'initialize_deliverable_requirement' AND idempotency_key = ?
          `).run(JSON.stringify(result), tenant, pm, idempotencyKey);
          raw.close();
        }

        const aggregateBefore = await replayPersistence.read(tenant, async (tx) => {
          return await tx.deliverables.get(requirementId);
        });
        const durableBefore = await captureSnapshot(replayPersistence, {
          tenantId: tenant,
          requirementId,
          path: backend === "sqlite" ? fixture.path : undefined,
        });
        await assert.rejects(
          new InitializeDeliverableRequirementHandler(replayPersistence).execute({
            ...command,
            commandId: `cmd-replay-${suffix}`,
            correlationId: `corr-replay-${suffix}`,
          }),
          (error: ApplicationError) => error.code === "DELIVERABLE_RECORD_CORRUPT",
        );
        const aggregateAfter = await replayPersistence.read(tenant, async (tx) => {
          return await tx.deliverables.get(requirementId);
        });
        assert.deepEqual(aggregateAfter, aggregateBefore, "Failed initialize replay must not mutate the aggregate");
        const durableAfter = await captureSnapshot(replayPersistence, {
          tenantId: tenant,
          requirementId,
          path: backend === "sqlite" ? fixture.path : undefined,
        });
        assertNoRecordResidue(
          durableBefore,
          durableAfter,
          "Failed initialize replay must not append actions, events, outbox messages or receipts",
        );
      } finally {
        if (replayPersistence !== fixture.persistence) await replayPersistence.close();
        await fixture.cleanup();
      }
    }
  }
});

// --------------------------------------------------------------------------
// R2F11: initialize replay binds current node/requirement security facts to the
// unchanged authoritative initialization event, not to each other.
// --------------------------------------------------------------------------
test("R2F11 (memory/sqlite): initialize replay rejects coordinated node and requirement security-epoch tamper without new durable facts", async () => {
  for (const backend of ["memory", "sqlite"] as const) {
    const fixture = await createFixture(backend);
    let replayPersistence: Persistence = fixture.persistence;
    try {
      await setupBaseProject(fixture.persistence);
      const suffix = `r2f11-${backend}`;
      const requirementId = `req-${suffix}`;
      const idempotencyKey = `idem-${suffix}`;
      const command = {
        tenantId: tenant,
        commandId: `cmd-${suffix}`,
        idempotencyKey,
        correlationId: `corr-${suffix}`,
        principalId: pm,
        projectId,
        nodeId: subNodeId,
        deliverableId: requirementId,
        requirementKey: `key-${suffix}`,
        title: "Initialization security binding",
        description: "Security epoch must remain bound to the initialization event",
        required: true,
        acceptedSourceTypes: ["file"] as const,
        minCount: 1,
        reviewerPrincipalId: reviewer,
        occurredAtUtc: "2026-09-04T00:00:00.000Z",
      };
      const initialized = await new InitializeDeliverableRequirementHandler(fixture.persistence).execute(command);

      if (backend === "memory") {
        const snapshot = (fixture.persistence as MemoryPersistence).snapshot();
        const nodeKey = `${tenant}\u0000${subNodeId}`;
        const requirementKey = `${tenant}\u0000${requirementId}`;
        const node = snapshot.nodes.get(nodeKey)!;
        const requirement = snapshot.deliverables.get(requirementKey)!;
        snapshot.nodes.set(nodeKey, { ...node, securityEpoch: 2 });
        snapshot.deliverables.set(requirementKey, { ...requirement, securityEpoch: 2 });
        replayPersistence = new MemoryPersistence({ snapshot });
      } else {
        const raw = new DatabaseSync(fixture.path!);
        const aggregateRow = raw.prepare(`
          SELECT deliverable_json FROM deliverable_requirements
          WHERE tenant_id = ? AND deliverable_id = ?
        `).get(tenant, requirementId) as { deliverable_json: string };
        const aggregate = JSON.parse(aggregateRow.deliverable_json) as DeliverableRequirement;
        raw.prepare(`
          UPDATE project_nodes SET security_epoch = 2
          WHERE tenant_id = ? AND node_id = ?
        `).run(tenant, subNodeId);
        raw.prepare(`
          UPDATE deliverable_requirements
          SET security_epoch = 2, deliverable_json = ?
          WHERE tenant_id = ? AND deliverable_id = ?
        `).run(JSON.stringify({ ...aggregate, securityEpoch: 2 }), tenant, requirementId);
        raw.close();
      }

      const currentFactsBefore = await replayPersistence.read(tenant, async (tx) => {
        const node = await tx.nodes.get(subNodeId);
        const requirement = await tx.deliverables.get(requirementId);
        const actions = await tx.deliverables.listActions(requirementId);
        const events = (await tx.events.list(tenant)).filter((event) => event.aggregateId === requirementId);
        const receipt = await tx.receipts.get<typeof initialized.value>({
          principalId: pm,
          operation: "initialize_deliverable_requirement",
          idempotencyKey,
        });
        assert.equal(node?.securityEpoch, 2);
        assert.equal(requirement?.securityEpoch, 2);
        assert.equal(events.length, 1);
        assert.equal(events[0]?.originalSecurityEpoch, 1);
        assert.equal(events[0]?.actorPrincipalId, command.principalId);
        assert.equal(events[0]?.occurredAtUtc, command.occurredAtUtc);
        assert.deepEqual(actions, initialized.value.actionHistory);
        assert.equal(receipt?.createdAtUtc, command.occurredAtUtc);
        assert.deepEqual(receipt?.result, initialized.value);
        return { node, requirement };
      });
      const durableBefore = await captureSnapshot(replayPersistence, {
        tenantId: tenant,
        requirementId,
        path: backend === "sqlite" ? fixture.path : undefined,
      });

      await assert.rejects(
        new InitializeDeliverableRequirementHandler(replayPersistence).execute({
          ...command,
          commandId: `cmd-replay-${suffix}`,
          correlationId: `corr-replay-${suffix}`,
        }),
        (error: ApplicationError) => error.code === "DELIVERABLE_RECORD_CORRUPT",
      );

      const currentFactsAfter = await replayPersistence.read(tenant, async (tx) => ({
        node: await tx.nodes.get(subNodeId),
        requirement: await tx.deliverables.get(requirementId),
      }));
      assert.deepEqual(currentFactsAfter, currentFactsBefore, "Failed initialize replay must not mutate node or requirement facts");
      const durableAfter = await captureSnapshot(replayPersistence, {
        tenantId: tenant,
        requirementId,
        path: backend === "sqlite" ? fixture.path : undefined,
      });
      assertNoRecordResidue(
        durableBefore,
        durableAfter,
        "Failed initialize replay must not append actions, events, outbox messages or receipts",
      );
    } finally {
      if (replayPersistence !== fixture.persistence) await replayPersistence.close();
      await fixture.cleanup();
    }
  }
});

// --------------------------------------------------------------------------
// R2F12: replay versions are relative to the submitted command and replay time
// is anchored to the fingerprinted command plus the unchanged event/outbox.
// --------------------------------------------------------------------------
test("R2F12-1 (memory/sqlite): submit replay supports a legally committed migration v2 to v3 transition", async () => {
  for (const backend of ["memory", "sqlite"] as const) {
    const fixture = await createFixture(backend);
    try {
      await setupBaseProject(fixture.persistence);
      const suffix = `r2f12-version-${backend}`;
      const requirementId = `req-${suffix}`;
      const assetId = `asset-${suffix}`;
      const domainId = `domain-${suffix}`;
      const migrationId = `migration-${suffix}`;
      await new CreateSecurityRootHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: `cmd-root-${suffix}`,
        idempotencyKey: `idem-root-${suffix}`,
        correlationId: `corr-root-${suffix}`,
        principalId: pm,
        projectId,
        nodeId: subNodeId,
        securityDomainId: domainId,
        expectedNodeVersion: 2,
        reason: "Establish migration source domain",
        occurredAtUtc: "2026-09-04T00:00:00.000Z",
      });
      const grants = new ManageSecurityGrantHandler(fixture.persistence);
      const contributorGrant = await grants.execute({
        tenantId: tenant,
        commandId: `cmd-contributor-${suffix}`,
        idempotencyKey: `idem-contributor-${suffix}`,
        correlationId: `corr-contributor-${suffix}`,
        principalId: pm,
        projectId,
        securityDomainId: domainId,
        targetPrincipalId: nodeLeader,
        action: "set",
        capability: "contribute",
        expiresAtUtc: null,
        expectedGrantVersion: null,
        expectedDomainVersion: 1,
        reason: "Allow pre-migration contribution",
        occurredAtUtc: "2026-09-04T00:01:00.000Z",
      });
      await grants.execute({
        tenantId: tenant,
        commandId: `cmd-reviewer-${suffix}`,
        idempotencyKey: `idem-reviewer-${suffix}`,
        correlationId: `corr-reviewer-${suffix}`,
        principalId: pm,
        projectId,
        securityDomainId: domainId,
        targetPrincipalId: reviewer,
        action: "set",
        capability: "view",
        expiresAtUtc: null,
        expectedGrantVersion: null,
        expectedDomainVersion: contributorGrant.value.domainVersion,
        reason: "Allow requirement reviewer",
        occurredAtUtc: "2026-09-04T00:02:00.000Z",
      });
      await new InitializeDeliverableRequirementHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: `cmd-init-${suffix}`,
        idempotencyKey: `idem-init-${suffix}`,
        correlationId: `corr-init-${suffix}`,
        principalId: pm,
        projectId,
        nodeId: subNodeId,
        deliverableId: requirementId,
        requirementKey: `key-${suffix}`,
        title: "Post-migration submit",
        required: true,
        acceptedSourceTypes: ["file"],
        minCount: 1,
        reviewerPrincipalId: reviewer,
        occurredAtUtc: "2026-09-04T00:03:00.000Z",
      });
      await insertAsset(fixture.persistence, {
        assetId,
        ownerNodeId: subNodeId,
        securityDomainId: domainId,
        securityEpoch: 2,
      });

      const inventory = await new SecurityMigrationInventoryReader(fixture.persistence).build({
        tenantId: tenant,
        projectId,
        rootNodeId: subNodeId,
        sourceSecurityDomainId: domainId,
        sourceSecurityEpoch: 2,
      });
      const planned: SecurityDomainMigration = {
        tenantId: tenant,
        id: migrationId,
        projectId,
        rootNodeId: subNodeId,
        sourceSecurityDomainId: domainId,
        targetSecurityDomainId: null,
        hierarchyRevision: 1,
        sourceSecurityEpoch: 2,
        targetSecurityEpoch: 3,
        state: "planned",
        cursor: null,
        totalItems: inventory.items.length,
        migratedItems: 0,
        failure: null,
        nextAttemptAtUtc: null,
        deadlineAtUtc: "2099-09-05T00:00:00.000Z",
        version: 1,
        createdAtUtc: "2026-09-04T00:04:00.000Z",
        updatedAtUtc: "2026-09-04T00:04:00.000Z",
      };
      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.securityMigrations.insert(planned);
        await tx.securityMigrations.saveProgressPreservingPlan(
          migrationId,
          transitionSecurityMigration(planned, "active", "2026-09-04T00:05:00.000Z"),
          1,
        );
      });
      const batch = await new ExecuteSecurityMigrationBatchHandler(fixture.persistence).execute({
        tenantId: tenant,
        migrationId,
        expectedMigrationVersion: 2,
        batchSize: 100,
        occurredAtUtc: "2026-09-04T00:06:00.000Z",
      });
      assert.equal(batch.complete, true);
      const verifying = await new BeginSecurityMigrationVerificationHandler(fixture.persistence).execute({
        tenantId: tenant,
        migrationId,
        expectedMigrationVersion: batch.migrationVersion,
        occurredAtUtc: "2026-09-04T00:07:00.000Z",
      });
      const verifier: ExternalCollaborationEpochReadinessPort = {
        checkEpochReadiness: async (scope) => ({
          evidenceId: scope.evidenceId,
          nonce: scope.nonce,
          tenantId: scope.tenantId,
          migrationId: scope.migrationId,
          purpose: scope.purpose,
          projectId: scope.projectId,
          manifestDigest: scope.manifestDigest,
          sourceSecurityDomainId: scope.sourceSecurityDomainId,
          targetSecurityDomainId: scope.targetSecurityDomainId,
          sourceSecurityEpoch: scope.sourceSecurityEpoch,
          targetSecurityEpoch: scope.targetSecurityEpoch,
          provider: "huly",
          converged: true,
          channels: { issue: "converged", attachment: "converged", blob: "converged" },
          verifiedAtUtc: scope.issuedAtUtc ?? fixture.persistence.nowUtc(),
          expiresAtUtc: scope.expiresAtUtc,
          consumedAtUtc: null,
          itemCount: scope.itemCount,
        }),
      };
      await new CommitSecurityMigrationHandler(
        fixture.persistence,
        fixture.testHarness.createVerificationOperation(verifier),
      ).execute({
        tenantId: tenant,
        migrationId,
        expectedMigrationVersion: verifying.migrationVersion,
        actorPrincipalId: pm,
        occurredAtUtc: "2026-09-04T00:08:00.000Z",
      });
      const migrated = await fixture.persistence.read(tenant, async (tx) => ({
        node: await tx.nodes.get(subNodeId),
        requirement: await tx.deliverables.get(requirementId),
        asset: await tx.assets.get(assetId),
        migration: await tx.securityMigrations.get(migrationId),
      }));
      assert.equal(migrated.migration?.state, "committed");
      assert.deepEqual(
        [migrated.node?.securityDomainId, migrated.requirement?.securityDomainId, migrated.asset?.securityDomainId],
        [null, null, null],
      );
      assert.deepEqual(
        [migrated.node?.securityEpoch, migrated.requirement?.securityEpoch, migrated.asset?.securityEpoch],
        [3, 3, 3],
      );
      assert.equal(migrated.requirement?.version, 2);

      const command = {
        tenantId: tenant,
        commandId: `cmd-submit-${suffix}`,
        idempotencyKey: `idem-submit-${suffix}`,
        correlationId: `corr-submit-${suffix}`,
        principalId: nodeLeader,
        deliverableId: requirementId,
        expectedVersion: 2,
        evidence: [{ sourceType: "file" as const, sourceId: assetId }],
        occurredAtUtc: "2026-09-04T01:00:00.000Z",
      };
      const first = await new SubmitDeliverableEvidenceHandler(fixture.persistence).execute(command);
      assert.equal(first.value.version, 3);
      assert.equal(first.replayed, false);
      const replay = await new SubmitDeliverableEvidenceHandler(fixture.persistence).execute({
        ...command,
        commandId: `cmd-submit-replay-${suffix}`,
        correlationId: `corr-submit-replay-${suffix}`,
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.value.version, 3);
      await new AcceptDeliverableHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: `cmd-accept-${suffix}`,
        idempotencyKey: `idem-accept-${suffix}`,
        correlationId: `corr-accept-${suffix}`,
        principalId: reviewer,
        deliverableId: requirementId,
        expectedVersion: 3,
        occurredAtUtc: "2026-09-04T02:00:00.000Z",
      });
      await assert.rejects(
        new SubmitDeliverableEvidenceHandler(fixture.persistence).execute({
          ...command,
          commandId: `cmd-submit-stale-${suffix}`,
          correlationId: `corr-submit-stale-${suffix}`,
        }),
        (error: ApplicationError) => error.code === "DELIVERABLE_VERSION_CONFLICT",
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("R2F12-2 (memory/sqlite): coordinated replay-time rewrites fail against command and event/outbox without residue", async () => {
  for (const backend of ["memory", "sqlite"] as const) {
    for (const flow of ["submit", "accept", "waive"] as const) {
      const fixture = await createFixture(backend);
      let replayPersistence: Persistence = fixture.persistence;
      try {
        await setupBaseProject(fixture.persistence);
        const suffix = `r2f12-time-${backend}-${flow}`;
        const requirementId = `req-${suffix}`;
        const assetId = `asset-${suffix}`;
        await new InitializeDeliverableRequirementHandler(fixture.persistence).execute({
          tenantId: tenant,
          commandId: `cmd-init-${suffix}`,
          idempotencyKey: `idem-init-${suffix}`,
          correlationId: `corr-init-${suffix}`,
          principalId: pm,
          projectId,
          nodeId: subNodeId,
          deliverableId: requirementId,
          requirementKey: `key-${suffix}`,
          title: "Replay time anchor",
          required: true,
          acceptedSourceTypes: ["file"],
          minCount: 1,
          reviewerPrincipalId: reviewer,
          occurredAtUtc: "2026-09-04T00:00:00.000Z",
        });
        await insertAsset(fixture.persistence, { assetId, ownerNodeId: subNodeId });
        const submitCommand = {
          tenantId: tenant,
          commandId: `cmd-submit-${suffix}`,
          idempotencyKey: `idem-submit-${suffix}`,
          correlationId: `corr-submit-${suffix}`,
          principalId: nodeLeader,
          deliverableId: requirementId,
          expectedVersion: 1,
          evidence: [{ sourceType: "file" as const, sourceId: assetId }],
          occurredAtUtc: "2026-09-04T01:00:00.000Z",
        };
        await new SubmitDeliverableEvidenceHandler(fixture.persistence).execute(submitCommand);
        if (flow === "accept") {
          await new AcceptDeliverableHandler(fixture.persistence).execute({
            tenantId: tenant,
            commandId: `cmd-accept-${suffix}`,
            idempotencyKey: `idem-accept-${suffix}`,
            correlationId: `corr-accept-${suffix}`,
            principalId: reviewer,
            deliverableId: requirementId,
            expectedVersion: 2,
            note: "approved",
            occurredAtUtc: "2026-09-04T02:00:00.000Z",
          });
        } else if (flow === "waive") {
          await new WaiveDeliverableHandler(fixture.persistence).execute({
            tenantId: tenant,
            commandId: `cmd-waive-${suffix}`,
            idempotencyKey: `idem-waive-${suffix}`,
            correlationId: `corr-waive-${suffix}`,
            principalId: pm,
            deliverableId: requirementId,
            expectedVersion: 2,
            reason: "descoped",
            occurredAtUtc: "2026-09-04T02:00:00.000Z",
          });
        }

        const principal = flow === "submit" ? nodeLeader : flow === "accept" ? reviewer : pm;
        const operation = flow === "submit" ? "submit_deliverable_evidence" : `${flow}_deliverable`;
        const idempotencyKey = `idem-${flow}-${suffix}`;
        const actionName = flow === "submit" ? "submitted" : flow === "accept" ? "accepted" : "waived";
        const originalTime = flow === "submit" ? "2026-09-04T01:00:00.000Z" : "2026-09-04T02:00:00.000Z";
        const tamperedTime = "2026-09-04T03:00:00.000Z";
        const receiptKey = `${tenant}\u0000${principal}\u0000${operation}\u0000${idempotencyKey}`;
        const actionId = `act:cmd-${flow}-${suffix}`;
        const linkId = `link:${requirementId}:file:${assetId}`;

        if (backend === "memory") {
          const snapshot = (fixture.persistence as MemoryPersistence).snapshot();
          const receipt = structuredClone(snapshot.receipts.get(receiptKey)!);
          (receipt as unknown as { createdAtUtc: string }).createdAtUtc = tamperedTime;
          const result = receipt.result as DeliverableRequirementView;
          const receiptAction = result.actionHistory.find((action) => action.action === actionName)!;
          (receiptAction as { occurredAtUtc: string }).occurredAtUtc = tamperedTime;
          const action = snapshot.deliverableActions.get(`${tenant}\u0000${actionId}`)!;
          snapshot.deliverableActions.set(`${tenant}\u0000${actionId}`, { ...action, occurredAtUtc: tamperedTime });
          if (flow === "submit") {
            const link = snapshot.evidenceLinks.get(`${tenant}\u0000${linkId}`)!;
            snapshot.evidenceLinks.set(`${tenant}\u0000${linkId}`, { ...link, linkedAtUtc: tamperedTime });
            (result.evidenceLinks[0] as { linkedAtUtc: string }).linkedAtUtc = tamperedTime;
          } else {
            const requirementKey = `${tenant}\u0000${requirementId}`;
            const requirement = snapshot.deliverables.get(requirementKey)!;
            const timeField = flow === "accept" ? "acceptedAtUtc" : "waivedAtUtc";
            snapshot.deliverables.set(requirementKey, { ...requirement, [timeField]: tamperedTime });
            (result as unknown as Record<string, unknown>)[timeField] = tamperedTime;
          }
          snapshot.receipts.set(receiptKey, receipt);
          replayPersistence = new MemoryPersistence({ snapshot });
        } else {
          const raw = new DatabaseSync(fixture.path!);
          const receiptRow = raw.prepare(`
            SELECT result_json FROM command_receipts
            WHERE tenant_id = ? AND principal_id = ? AND operation = ? AND idempotency_key = ?
          `).get(tenant, principal, operation, idempotencyKey) as { result_json: string };
          const result = JSON.parse(receiptRow.result_json) as DeliverableRequirementView;
          const receiptAction = result.actionHistory.find((action) => action.action === actionName)!;
          (receiptAction as { occurredAtUtc: string }).occurredAtUtc = tamperedTime;
          raw.prepare(`
            UPDATE deliverable_action_records SET occurred_at_utc = ?
            WHERE tenant_id = ? AND action_id = ?
          `).run(tamperedTime, tenant, actionId);
          if (flow === "submit") {
            raw.prepare(`
              UPDATE deliverable_evidence_links SET linked_at_utc = ?
              WHERE tenant_id = ? AND link_id = ?
            `).run(tamperedTime, tenant, linkId);
            (result.evidenceLinks[0] as { linkedAtUtc: string }).linkedAtUtc = tamperedTime;
          } else {
            const requirementRow = raw.prepare(`
              SELECT deliverable_json FROM deliverable_requirements
              WHERE tenant_id = ? AND deliverable_id = ?
            `).get(tenant, requirementId) as { deliverable_json: string };
            const requirement = JSON.parse(requirementRow.deliverable_json) as DeliverableRequirement;
            const timeField = flow === "accept" ? "acceptedAtUtc" : "waivedAtUtc";
            raw.prepare(`
              UPDATE deliverable_requirements SET deliverable_json = ?
              WHERE tenant_id = ? AND deliverable_id = ?
            `).run(JSON.stringify({ ...requirement, [timeField]: tamperedTime }), tenant, requirementId);
            (result as unknown as Record<string, unknown>)[timeField] = tamperedTime;
          }
          raw.prepare(`
            UPDATE command_receipts SET result_json = ?, created_at_utc = ?
            WHERE tenant_id = ? AND principal_id = ? AND operation = ? AND idempotency_key = ?
          `).run(JSON.stringify(result), tamperedTime, tenant, principal, operation, idempotencyKey);
          raw.close();
        }

        const before = await captureSnapshot(replayPersistence, {
          tenantId: tenant,
          requirementId,
          path: backend === "sqlite" ? fixture.path : undefined,
        });
        const replay = flow === "submit"
          ? new SubmitDeliverableEvidenceHandler(replayPersistence).execute({
              ...submitCommand,
              commandId: `cmd-submit-replay-${suffix}`,
              correlationId: `corr-submit-replay-${suffix}`,
            })
          : flow === "accept"
            ? new AcceptDeliverableHandler(replayPersistence).execute({
                tenantId: tenant,
                commandId: `cmd-accept-replay-${suffix}`,
                idempotencyKey,
                correlationId: `corr-accept-replay-${suffix}`,
                principalId: reviewer,
                deliverableId: requirementId,
                expectedVersion: 2,
                note: "approved",
                occurredAtUtc: originalTime,
              })
            : new WaiveDeliverableHandler(replayPersistence).execute({
                tenantId: tenant,
                commandId: `cmd-waive-replay-${suffix}`,
                idempotencyKey,
                correlationId: `corr-waive-replay-${suffix}`,
                principalId: pm,
                deliverableId: requirementId,
                expectedVersion: 2,
                reason: "descoped",
                occurredAtUtc: originalTime,
              });
        await assert.rejects(replay, (error: ApplicationError) => error.code === "DELIVERABLE_RECORD_CORRUPT");
        const after = await captureSnapshot(replayPersistence, {
          tenantId: tenant,
          requirementId,
          path: backend === "sqlite" ? fixture.path : undefined,
        });
        assertNoRecordResidue(before, after, "Failed replay-time tamper must not append durable facts");
      } finally {
        if (replayPersistence !== fixture.persistence) await replayPersistence.close();
        await fixture.cleanup();
      }
    }
  }
});

test("R2F13-1 (memory/sqlite): aggregate-only updatedAtUtc tamper fails every action replay without residue", async () => {
  for (const backend of ["memory", "sqlite"] as const) {
    for (const flow of ["submit", "accept", "waive"] as const) {
      const fixture = await createFixture(backend);
      let replayPersistence: Persistence = fixture.persistence;
      try {
        await setupBaseProject(fixture.persistence);
        const suffix = `r2f13-updated-${backend}-${flow}`;
        const requirementId = `req-${suffix}`;
        const assetId = `asset-${suffix}`;
        await new InitializeDeliverableRequirementHandler(fixture.persistence).execute({
          tenantId: tenant, commandId: `cmd-init-${suffix}`, idempotencyKey: `idem-init-${suffix}`,
          correlationId: `corr-init-${suffix}`, principalId: pm, projectId, nodeId: subNodeId,
          deliverableId: requirementId, requirementKey: `key-${suffix}`, title: "Aggregate time anchor",
          required: true, acceptedSourceTypes: ["file"], minCount: 1, reviewerPrincipalId: reviewer,
          occurredAtUtc: "2026-09-04T00:00:00.000Z",
        });
        await insertAsset(fixture.persistence, { assetId, ownerNodeId: subNodeId });
        const submitCommand = {
          tenantId: tenant, commandId: `cmd-submit-${suffix}`, idempotencyKey: `idem-submit-${suffix}`,
          correlationId: `corr-submit-${suffix}`, principalId: nodeLeader, deliverableId: requirementId,
          expectedVersion: 1, evidence: [{ sourceType: "file" as const, sourceId: assetId }],
          occurredAtUtc: "2026-09-04T01:00:00.000Z",
        };
        await new SubmitDeliverableEvidenceHandler(fixture.persistence).execute(submitCommand);
        if (flow === "accept") {
          await new AcceptDeliverableHandler(fixture.persistence).execute({
            tenantId: tenant, commandId: `cmd-accept-${suffix}`, idempotencyKey: `idem-accept-${suffix}`,
            correlationId: `corr-accept-${suffix}`, principalId: reviewer, deliverableId: requirementId,
            expectedVersion: 2, note: "approved", occurredAtUtc: "2026-09-04T02:00:00.000Z",
          });
        } else if (flow === "waive") {
          await new WaiveDeliverableHandler(fixture.persistence).execute({
            tenantId: tenant, commandId: `cmd-waive-${suffix}`, idempotencyKey: `idem-waive-${suffix}`,
            correlationId: `corr-waive-${suffix}`, principalId: pm, deliverableId: requirementId,
            expectedVersion: 2, reason: "descoped", occurredAtUtc: "2026-09-04T02:00:00.000Z",
          });
        }
        if (backend === "memory") {
          const snapshot = (fixture.persistence as MemoryPersistence).snapshot();
          const key = `${tenant}\u0000${requirementId}`;
          const requirement = snapshot.deliverables.get(key)!;
          snapshot.deliverables.set(key, { ...requirement, updatedAtUtc: "2026-09-04T03:00:00.000Z" });
          replayPersistence = new MemoryPersistence({ snapshot });
        } else {
          const raw = new DatabaseSync(fixture.path!);
          const row = raw.prepare(`SELECT deliverable_json FROM deliverable_requirements WHERE tenant_id = ? AND deliverable_id = ?`)
            .get(tenant, requirementId) as { deliverable_json: string };
          const requirement = JSON.parse(row.deliverable_json) as DeliverableRequirement;
          raw.prepare(`UPDATE deliverable_requirements SET deliverable_json = ? WHERE tenant_id = ? AND deliverable_id = ?`)
            .run(JSON.stringify({ ...requirement, updatedAtUtc: "2026-09-04T03:00:00.000Z" }), tenant, requirementId);
          raw.close();
        }
        const before = await captureSnapshot(replayPersistence, { tenantId: tenant, requirementId, path: backend === "sqlite" ? fixture.path : undefined });
        const replay = flow === "submit"
          ? new SubmitDeliverableEvidenceHandler(replayPersistence).execute({ ...submitCommand, commandId: `cmd-submit-replay-${suffix}`, correlationId: `corr-submit-replay-${suffix}` })
          : flow === "accept"
            ? new AcceptDeliverableHandler(replayPersistence).execute({
                tenantId: tenant, commandId: `cmd-accept-replay-${suffix}`, idempotencyKey: `idem-accept-${suffix}`,
                correlationId: `corr-accept-replay-${suffix}`, principalId: reviewer, deliverableId: requirementId,
                expectedVersion: 2, note: "approved", occurredAtUtc: "2026-09-04T02:00:00.000Z",
              })
            : new WaiveDeliverableHandler(replayPersistence).execute({
                tenantId: tenant, commandId: `cmd-waive-replay-${suffix}`, idempotencyKey: `idem-waive-${suffix}`,
                correlationId: `corr-waive-replay-${suffix}`, principalId: pm, deliverableId: requirementId,
                expectedVersion: 2, reason: "descoped", occurredAtUtc: "2026-09-04T02:00:00.000Z",
              });
        await assert.rejects(replay, (error: ApplicationError) => error.code === "DELIVERABLE_RECORD_CORRUPT");
        const after = await captureSnapshot(replayPersistence, { tenantId: tenant, requirementId, path: backend === "sqlite" ? fixture.path : undefined });
        assertNoRecordResidue(before, after, "Aggregate-only time tamper must not append durable facts");
      } finally {
        if (replayPersistence !== fixture.persistence) await replayPersistence.close();
        await fixture.cleanup();
      }
    }
  }
});

test("R2F13-2 (memory/sqlite): coordinated terminal version rewrite cannot redefine expectedVersion plus one", async () => {
  for (const backend of ["memory", "sqlite"] as const) {
    for (const flow of ["accept", "waive"] as const) {
      const fixture = await createFixture(backend);
      let replayPersistence: Persistence = fixture.persistence;
      try {
        await setupBaseProject(fixture.persistence);
        const suffix = `r2f13-version-${backend}-${flow}`;
        const requirementId = `req-${suffix}`;
        const assetId = `asset-${suffix}`;
        await new InitializeDeliverableRequirementHandler(fixture.persistence).execute({
          tenantId: tenant, commandId: `cmd-init-${suffix}`, idempotencyKey: `idem-init-${suffix}`,
          correlationId: `corr-init-${suffix}`, principalId: pm, projectId, nodeId: subNodeId,
          deliverableId: requirementId, requirementKey: `key-${suffix}`, title: "Terminal version anchor",
          required: true, acceptedSourceTypes: ["file"], minCount: 1, reviewerPrincipalId: reviewer,
          occurredAtUtc: "2026-09-04T00:00:00.000Z",
        });
        await insertAsset(fixture.persistence, { assetId, ownerNodeId: subNodeId });
        await new SubmitDeliverableEvidenceHandler(fixture.persistence).execute({
          tenantId: tenant, commandId: `cmd-submit-${suffix}`, idempotencyKey: `idem-submit-${suffix}`,
          correlationId: `corr-submit-${suffix}`, principalId: nodeLeader, deliverableId: requirementId,
          expectedVersion: 1, evidence: [{ sourceType: "file", sourceId: assetId }], occurredAtUtc: "2026-09-04T01:00:00.000Z",
        });
        const principal = flow === "accept" ? reviewer : pm;
        const operation = flow === "accept" ? "accept_deliverable" : "waive_deliverable";
        const occurredAtUtc = "2026-09-04T02:00:00.000Z";
        if (flow === "accept") {
          await new AcceptDeliverableHandler(fixture.persistence).execute({
            tenantId: tenant, commandId: `cmd-accept-${suffix}`, idempotencyKey: `idem-accept-${suffix}`,
            correlationId: `corr-accept-${suffix}`, principalId: reviewer, deliverableId: requirementId,
            expectedVersion: 2, note: "approved", occurredAtUtc,
          });
        } else {
          await new WaiveDeliverableHandler(fixture.persistence).execute({
            tenantId: tenant, commandId: `cmd-waive-${suffix}`, idempotencyKey: `idem-waive-${suffix}`,
            correlationId: `corr-waive-${suffix}`, principalId: pm, deliverableId: requirementId,
            expectedVersion: 2, reason: "descoped", occurredAtUtc,
          });
        }
        const eventId = `evt:cmd-${flow}-${suffix}`;
        const receiptKey = `${tenant}\u0000${principal}\u0000${operation}\u0000idem-${flow}-${suffix}`;
        if (backend === "memory") {
          const snapshot = (fixture.persistence as MemoryPersistence).snapshot();
          const requirementKey = `${tenant}\u0000${requirementId}`;
          const requirement = snapshot.deliverables.get(requirementKey)!;
          snapshot.deliverables.set(requirementKey, { ...requirement, version: 4 });
          const receipt = structuredClone(snapshot.receipts.get(receiptKey)!);
          (receipt.result as unknown as { version: number }).version = 4;
          snapshot.receipts.set(receiptKey, receipt);
          const eventKey = `${tenant}\u0000${eventId}`;
          const event = snapshot.events.get(eventKey)!;
          const changedEvent = { ...event, aggregateVersion: 4 };
          snapshot.events.set(eventKey, changedEvent);
          const outboxKey = `${tenant}\u0000outbox:${eventId}`;
          const outbox = snapshot.outbox.get(outboxKey)!;
          snapshot.outbox.set(outboxKey, { ...outbox, payload: changedEvent });
          replayPersistence = new MemoryPersistence({ snapshot });
        } else {
          const raw = new DatabaseSync(fixture.path!);
          const requirementRow = raw.prepare(`SELECT deliverable_json FROM deliverable_requirements WHERE tenant_id = ? AND deliverable_id = ?`)
            .get(tenant, requirementId) as { deliverable_json: string };
          const requirement = JSON.parse(requirementRow.deliverable_json) as DeliverableRequirement;
          raw.prepare(`UPDATE deliverable_requirements SET version = 4, deliverable_json = ? WHERE tenant_id = ? AND deliverable_id = ?`)
            .run(JSON.stringify({ ...requirement, version: 4 }), tenant, requirementId);
          const receiptRow = raw.prepare(`SELECT result_json FROM command_receipts WHERE tenant_id = ? AND principal_id = ? AND operation = ? AND idempotency_key = ?`)
            .get(tenant, principal, operation, `idem-${flow}-${suffix}`) as { result_json: string };
          const result = JSON.parse(receiptRow.result_json) as DeliverableRequirementView;
          (result as unknown as { version: number }).version = 4;
          raw.prepare(`UPDATE command_receipts SET result_json = ? WHERE tenant_id = ? AND principal_id = ? AND operation = ? AND idempotency_key = ?`)
            .run(JSON.stringify(result), tenant, principal, operation, `idem-${flow}-${suffix}`);
          const eventRow = raw.prepare(`SELECT event_json FROM domain_events WHERE tenant_id = ? AND event_id = ?`)
            .get(tenant, eventId) as { event_json: string };
          const changedEvent = { ...(JSON.parse(eventRow.event_json) as DomainEvent), aggregateVersion: 4 };
          raw.prepare(`UPDATE domain_events SET aggregate_version = 4, event_json = ? WHERE tenant_id = ? AND event_id = ?`)
            .run(JSON.stringify(changedEvent), tenant, eventId);
          raw.prepare(`UPDATE outbox_messages SET payload_json = ? WHERE tenant_id = ? AND event_id = ?`)
            .run(JSON.stringify(changedEvent), tenant, eventId);
          raw.close();
        }
        const before = await captureSnapshot(replayPersistence, { tenantId: tenant, requirementId, path: backend === "sqlite" ? fixture.path : undefined });
        const replay = flow === "accept"
          ? new AcceptDeliverableHandler(replayPersistence).execute({
              tenantId: tenant, commandId: `cmd-accept-replay-${suffix}`, idempotencyKey: `idem-accept-${suffix}`,
              correlationId: `corr-accept-replay-${suffix}`, principalId: reviewer, deliverableId: requirementId,
              expectedVersion: 2, note: "approved", occurredAtUtc,
            })
          : new WaiveDeliverableHandler(replayPersistence).execute({
              tenantId: tenant, commandId: `cmd-waive-replay-${suffix}`, idempotencyKey: `idem-waive-${suffix}`,
              correlationId: `corr-waive-replay-${suffix}`, principalId: pm, deliverableId: requirementId,
              expectedVersion: 2, reason: "descoped", occurredAtUtc,
            });
        await assert.rejects(replay, (error: ApplicationError) => error.code === "DELIVERABLE_VERSION_CONFLICT");
        const after = await captureSnapshot(replayPersistence, { tenantId: tenant, requirementId, path: backend === "sqlite" ? fixture.path : undefined });
        assertNoRecordResidue(before, after, "Terminal version rewrite must not append durable facts");
      } finally {
        if (replayPersistence !== fixture.persistence) await replayPersistence.close();
        await fixture.cleanup();
      }
    }
  }
});

// --------------------------------------------------------------------------
// 4. Failure injection & atomic rollback across all boundaries
// --------------------------------------------------------------------------
for (const backend of ["memory", "sqlite"] as const) {
  test(`TC-DLV-001/003 (${backend}): Failure injection points roll back completely`, async () => {
    const fixture = await createFixture(backend);
    try {
      await setupBaseProject(fixture.persistence);

      const initHandler = new InitializeDeliverableRequirementHandler(fixture.persistence);
      const submitHandler = new SubmitDeliverableEvidenceHandler(fixture.persistence);
      const acceptHandler = new AcceptDeliverableHandler(fixture.persistence);
      const waiveHandler = new WaiveDeliverableHandler(fixture.persistence);

      // Failure during initialization
      for (const fp of ["after_aggregate", "after_action", "after_event", "after_outbox", "after_idempotency"] as const) {
        await assert.rejects(
          () => initHandler.execute({
            tenantId: tenant,
            commandId: `cmd-init-fail-${fp}`,
            idempotencyKey: `idem-init-fail-${fp}`,
            correlationId: `corr-${fp}`,
            principalId: pm,
            projectId,
            nodeId: subNodeId,
            deliverableId: `req-fail-${fp}`,
            requirementKey: `key-fail-${fp}`,
            title: `Fail ${fp}`,
            required: true,
            acceptedSourceTypes: ["file"],
            minCount: 1,
            reviewerPrincipalId: reviewer,
            occurredAtUtc: "2026-09-04T00:00:00.000Z",
            failurePoint: fp,
          }),
          /INJECTED_FAILURE/,
        );

        // Verify zero state left behind
        await fixture.persistence.read(tenant, async (tx) => {
          const loaded = await tx.deliverables.get(`req-fail-${fp}`);
          assert.equal(loaded, undefined, `Aggregate req-fail-${fp} must not persist`);
          const actions = await tx.deliverables.listActions(`req-fail-${fp}`);
          assert.equal(actions.length, 0, `Actions for req-fail-${fp} must not persist`);
          const links = await tx.deliverables.listEvidenceLinks(`req-fail-${fp}`);
          assert.equal(links.length, 0, `Evidence for req-fail-${fp} must not persist`);
        });
        await assertNoCommandResidue(fixture, {
          commandId: `cmd-init-fail-${fp}`,
          principalId: pm,
          operation: "initialize_deliverable_requirement",
          idempotencyKey: `idem-init-fail-${fp}`,
        });
      }

      // Initialize clean requirement for submit failure test
      await initHandler.execute({
        tenantId: tenant,
        commandId: "cmd-init-clean-sub",
        idempotencyKey: "idem-init-clean-sub",
        correlationId: "corr-clean-sub",
        principalId: pm,
        projectId,
        nodeId: subNodeId,
        deliverableId: "req-clean-sub",
        requirementKey: "key-clean-sub",
        title: "Clean Sub",
        required: true,
        acceptedSourceTypes: ["file"],
        minCount: 1,
        reviewerPrincipalId: reviewer,
        occurredAtUtc: "2026-09-04T00:00:00.000Z",
      });

      await insertAsset(fixture.persistence, { assetId: "asset-clean-sub", ownerNodeId: subNodeId });

      // Failure during submit
      for (const fp of ["after_aggregate", "after_evidence", "after_action", "after_event", "after_outbox", "after_idempotency"] as const) {
        await assert.rejects(
          () => submitHandler.execute({
            tenantId: tenant,
            commandId: `cmd-sub-fail-${fp}`,
            idempotencyKey: `idem-sub-fail-${fp}`,
            correlationId: `corr-sub-${fp}`,
            principalId: nodeLeader,
            deliverableId: "req-clean-sub",
            expectedVersion: 1,
            evidence: [{ sourceType: "file", sourceId: "asset-clean-sub" }],
            occurredAtUtc: "2026-09-04T01:00:00.000Z",
            failurePoint: fp,
          }),
          /INJECTED_FAILURE/,
        );

        // Verify status rolled back to pending and version remains 1, with zero residue in
        // aggregate facts, events and outbox for this command
        await fixture.persistence.read(tenant, async (tx) => {
          const req = await tx.deliverables.get("req-clean-sub");
          assert.ok(req);
          assert.equal(req.status, "pending");
          assert.equal(req.version, 1);
          const links = await tx.deliverables.listEvidenceLinks("req-clean-sub");
          assert.equal(links.length, 0, `Links must not persist on failure ${fp}`);
          const actions = await tx.deliverables.listActions("req-clean-sub");
          assert.equal(actions.length, 1, `Actions must remain at 1 (initialized) on failure ${fp}`);
          assert.equal(actions[0]?.action, "initialized");
          const commandReceipt = await tx.receipts.get({
            principalId: nodeLeader,
            operation: "submit_deliverable_evidence",
            idempotencyKey: `idem-sub-fail-${fp}`,
          });
          assert.equal(commandReceipt, undefined, `Receipt must not persist on failure ${fp}`);
          const commandBindings = await tx.assets.listBindings("deliverable", "req-clean-sub");
          assert.equal(commandBindings.length, 0, `Bindings must not persist on failure ${fp}`);
        });
        await assertNoCommandResidue(fixture, {
          commandId: `cmd-sub-fail-${fp}`,
          principalId: nodeLeader,
          operation: "submit_deliverable_evidence",
          idempotencyKey: `idem-sub-fail-${fp}`,
        });
      }

      await initHandler.execute({
        tenantId: tenant,
        commandId: "cmd-init-clean-accept",
        idempotencyKey: "idem-init-clean-accept",
        correlationId: "corr-clean-accept",
        principalId: pm,
        projectId,
        nodeId: subNodeId,
        deliverableId: "req-clean-accept",
        requirementKey: "key-clean-accept",
        title: "Clean Accept",
        required: true,
        acceptedSourceTypes: ["file"],
        minCount: 1,
        reviewerPrincipalId: reviewer,
        occurredAtUtc: "2026-09-04T00:00:00.000Z",
      });
      await insertAsset(fixture.persistence, { assetId: "asset-clean-accept", ownerNodeId: subNodeId });
      await submitHandler.execute({
        tenantId: tenant,
        commandId: "cmd-sub-clean-accept",
        idempotencyKey: "idem-sub-clean-accept",
        correlationId: "corr-sub-clean-accept",
        principalId: nodeLeader,
        deliverableId: "req-clean-accept",
        expectedVersion: 1,
        evidence: [{ sourceType: "file", sourceId: "asset-clean-accept" }],
        occurredAtUtc: "2026-09-04T01:00:00.000Z",
      });

      for (const fp of ["after_aggregate", "after_action", "after_event", "after_outbox", "after_idempotency"] as const) {
        await assert.rejects(() => acceptHandler.execute({
          tenantId: tenant,
          commandId: `cmd-accept-fail-${fp}`,
          idempotencyKey: `idem-accept-fail-${fp}`,
          correlationId: `corr-accept-${fp}`,
          principalId: reviewer,
          deliverableId: "req-clean-accept",
          expectedVersion: 2,
          note: "atomic accept",
          occurredAtUtc: "2026-09-04T02:00:00.000Z",
          failurePoint: fp,
        }), /INJECTED_FAILURE/);
        await fixture.persistence.read(tenant, async (tx) => {
          const req = await tx.deliverables.get("req-clean-accept");
          assert.equal(req?.status, "submitted");
          assert.equal(req?.version, 2);
          assert.equal((await tx.deliverables.listEvidenceLinks("req-clean-accept")).length, 1);
          assert.equal((await tx.deliverables.listActions("req-clean-accept")).length, 2);
        });
        await assertNoCommandResidue(fixture, {
          commandId: `cmd-accept-fail-${fp}`,
          principalId: reviewer,
          operation: "accept_deliverable",
          idempotencyKey: `idem-accept-fail-${fp}`,
        });
      }

      await initHandler.execute({
        tenantId: tenant,
        commandId: "cmd-init-clean-waive",
        idempotencyKey: "idem-init-clean-waive",
        correlationId: "corr-clean-waive",
        principalId: pm,
        projectId,
        nodeId: subNodeId,
        deliverableId: "req-clean-waive",
        requirementKey: "key-clean-waive",
        title: "Clean Waive",
        required: true,
        acceptedSourceTypes: ["file"],
        minCount: 1,
        reviewerPrincipalId: reviewer,
        occurredAtUtc: "2026-09-04T00:00:00.000Z",
      });
      for (const fp of ["after_aggregate", "after_action", "after_event", "after_outbox", "after_idempotency"] as const) {
        await assert.rejects(() => waiveHandler.execute({
          tenantId: tenant,
          commandId: `cmd-waive-fail-${fp}`,
          idempotencyKey: `idem-waive-fail-${fp}`,
          correlationId: `corr-waive-${fp}`,
          principalId: pm,
          deliverableId: "req-clean-waive",
          expectedVersion: 1,
          reason: "atomic waive",
          occurredAtUtc: "2026-09-04T02:00:00.000Z",
          failurePoint: fp,
        }), /INJECTED_FAILURE/);
        await fixture.persistence.read(tenant, async (tx) => {
          const req = await tx.deliverables.get("req-clean-waive");
          assert.equal(req?.status, "pending");
          assert.equal(req?.version, 1);
          assert.equal((await tx.deliverables.listEvidenceLinks("req-clean-waive")).length, 0);
          assert.equal((await tx.deliverables.listActions("req-clean-waive")).length, 1);
        });
        await assertNoCommandResidue(fixture, {
          commandId: `cmd-waive-fail-${fp}`,
          principalId: pm,
          operation: "waive_deliverable",
          idempotencyKey: `idem-waive-fail-${fp}`,
        });
      }
    } finally {
      await fixture.cleanup();
    }
  });
}

// --------------------------------------------------------------------------
// 5. Product API HTTP routes and error mappings
// --------------------------------------------------------------------------
test("TC-DLV-001/003 (Product API): HTTP route integration and status codes", async () => {
  const fixture = await createFixture("sqlite");
  try {
    await setupBaseProject(fixture.persistence, tenant);

    await fixture.persistence.transaction(tenant, async (tx) => {
      for (const pId of [pm, nodeLeader, reviewer, member]) {
        await tx.identities.insertExternal({
          tenantId: tenant,
          principalId: pId,
          provider: "huly",
          connectionId: "test",
          externalTenantRef: "workspace-dlv",
          externalSubjectRef: pId,
          status: "active",
          version: 1,
          createdAtUtc: "2026-09-04T00:00:00.000Z",
          updatedAtUtc: "2026-09-04T00:00:00.000Z",
        });
      }
    });

    const assetContent = new MemoryAssetContent();
    const app = createProductApi({
      collaborationMode: "huly",
      collaborationProjectionConfigured: true,
      externalIdentityVerifier: {
        authenticate: async (token: string) => ({
          provider: "huly",
          connectionId: "test",
          externalTenantRef: "workspace-dlv",
          externalSubjectRef: token,
        }),
      },
      persistence: fixture.persistence,
      assetContent,
      tenantId: tenant,
    });

    const initHandler = new InitializeDeliverableRequirementHandler(fixture.persistence);
    await initHandler.execute({
      tenantId: tenant,
      commandId: "cmd-api-init",
      idempotencyKey: "idem-api-init",
      correlationId: "corr-api-init",
      principalId: pm,
      projectId,
      nodeId: subNodeId,
      deliverableId: "dlv-api-1",
      requirementKey: "key-api-1",
      title: "API Deliverable",
      required: true,
      acceptedSourceTypes: ["file"],
      minCount: 1,
      reviewerPrincipalId: reviewer,
      occurredAtUtc: "2026-09-04T00:00:00.000Z",
    });
    await initHandler.execute({
      tenantId: tenant,
      commandId: "cmd-api-init-waive",
      idempotencyKey: "idem-api-init-waive",
      correlationId: "corr-api-init-waive",
      principalId: pm,
      projectId,
      nodeId: subNodeId,
      deliverableId: "dlv-api-waive",
      requirementKey: "key-api-waive",
      title: "API Waiver Deliverable",
      required: true,
      acceptedSourceTypes: ["file"],
      minCount: 1,
      reviewerPrincipalId: reviewer,
      occurredAtUtc: "2026-09-04T00:00:00.000Z",
    });

    await insertAsset(fixture.persistence, { assetId: "asset-api-1", ownerNodeId: subNodeId });

    // Helper for sending fake HTTP requests
    async function request(
      method: string,
      path: string,
      headers: Record<string, string>,
      body?: unknown,
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      return new Promise((resolve, reject) => {
        const req = {
          method,
          url: path,
          headers: {
            host: "product-api.local",
            ...headers,
          },
          [Symbol.asyncIterator]: async function* () {
            if (body !== undefined) yield Buffer.from(JSON.stringify(body));
          },
        } as unknown as import("node:http").IncomingMessage;

        let statusCode = 200;
        let responseBody = "";
        const res = {
          writeHead: (code: number) => { statusCode = code; },
          setHeader: () => {},
          end: (chunk?: string | Buffer) => {
            if (chunk) responseBody += chunk.toString();
            try {
              resolve({ status: statusCode, body: JSON.parse(responseBody || "{}") });
            } catch {
              resolve({ status: statusCode, body: { raw: responseBody } });
            }
          },
        } as unknown as import("node:http").ServerResponse;

        app(req, res).catch(reject);
      });
    }

    // 1. GET /api/deliverables/:id as PM -> 200
    const getRes = await request("GET", "/api/deliverables/dlv-api-1", {
      authorization: `Bearer ${pm}`,
    });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.id, "dlv-api-1");
    assert.equal(getRes.body.status, "pending");

    // 2. GET /api/nodes/:nodeId/deliverables -> 200 list
    const listRes = await request("GET", `/api/nodes/${subNodeId}/deliverables`, {
      authorization: `Bearer ${pm}`,
    });
    assert.equal(listRes.status, 200);
    assert.ok(Array.isArray(listRes.body));
    assert.equal((listRes.body as unknown as unknown[]).length, 2);

    // 3. POST /api/deliverables/:id/actions/submit by unauthorized member -> 403
    const submitForbiddenRes = await request(
      "POST",
      "/api/deliverables/dlv-api-1/actions/submit",
      {
        authorization: `Bearer ${member}`,
        "idempotency-key": "idem-sub-http-1",
      },
      {
        expectedVersion: 1,
        evidence: [{ sourceType: "file", sourceId: "asset-api-1" }],
      },
    );
    assert.equal(submitForbiddenRes.status, 403);
    assert.equal(submitForbiddenRes.body.code, "DELIVERABLE_SUBMISSION_FORBIDDEN");

    // 4. POST /api/deliverables/:id/actions/submit by node leader -> 200
    const submitOkRes = await request(
      "POST",
      "/api/deliverables/dlv-api-1/actions/submit",
      {
        authorization: `Bearer ${nodeLeader}`,
        "idempotency-key": "idem-sub-http-2",
      },
      {
        expectedVersion: 1,
        evidence: [{ sourceType: "file", sourceId: "asset-api-1" }],
      },
    );
    assert.equal(submitOkRes.status, 200);
    assert.equal((submitOkRes.body.value as Record<string, unknown>).status, "submitted");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const submitReplayRes = await request(
      "POST",
      "/api/deliverables/dlv-api-1/actions/submit",
      {
        authorization: `Bearer ${nodeLeader}`,
        "idempotency-key": "idem-sub-http-2",
      },
      {
        expectedVersion: 1,
        evidence: [{ sourceType: "file", sourceId: "asset-api-1" }],
      },
    );
    assert.equal(submitReplayRes.status, 200);
    assert.equal(submitReplayRes.body.replayed, true);
    const submitMismatchRes = await request(
      "POST",
      "/api/deliverables/dlv-api-1/actions/submit",
      {
        authorization: `Bearer ${nodeLeader}`,
        "idempotency-key": "idem-sub-http-2",
      },
      {
        expectedVersion: 1,
        evidence: [{ sourceType: "file", sourceId: "different-asset" }],
      },
    );
    assert.equal(submitMismatchRes.status, 409);
    assert.equal(submitMismatchRes.body.code, "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");

    // 5. POST /api/deliverables/:id/actions/accept by reviewer -> 200
    const acceptOkRes = await request(
      "POST",
      "/api/deliverables/dlv-api-1/actions/accept",
      {
        authorization: `Bearer ${reviewer}`,
        "idempotency-key": "idem-acc-http-1",
      },
      {
        expectedVersion: 2,
        reason: "Approval via HTTP API",
      },
    );
    assert.equal(acceptOkRes.status, 200);
    assert.equal((acceptOkRes.body.value as Record<string, unknown>).status, "accepted");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const acceptReplayRes = await request(
      "POST",
      "/api/deliverables/dlv-api-1/actions/accept",
      {
        authorization: `Bearer ${reviewer}`,
        "idempotency-key": "idem-acc-http-1",
      },
      {
        expectedVersion: 2,
        reason: "Approval via HTTP API",
      },
    );
    assert.equal(acceptReplayRes.status, 200);
    assert.equal(acceptReplayRes.body.replayed, true);

    // 6. POST /api/deliverables/:id/actions/waive on accepted -> 409
    const waiveConflictRes = await request(
      "POST",
      "/api/deliverables/dlv-api-1/actions/waive",
      {
        authorization: `Bearer ${pm}`,
        "idempotency-key": "idem-waive-http-1",
      },
      {
        expectedVersion: 3,
        reason: "Attempt to waive accepted",
      },
    );
    assert.equal(waiveConflictRes.status, 409);
    assert.equal(waiveConflictRes.body.code, "DELIVERABLE_ALREADY_ACCEPTED");

    // 7. Waive retry with the same public payload reuses the first receipt time.
    const waiveRequest = () => request(
      "POST",
      "/api/deliverables/dlv-api-waive/actions/waive",
      {
        authorization: `Bearer ${pm}`,
        "idempotency-key": "idem-waive-http-replay",
      },
      {
        expectedVersion: 1,
        reason: "No longer required",
      },
    );
    const waiveOkRes = await waiveRequest();
    assert.equal(waiveOkRes.status, 200);
    assert.equal((waiveOkRes.body.value as Record<string, unknown>).status, "waived");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const waiveReplayRes = await waiveRequest();
    assert.equal(waiveReplayRes.status, 200);
    assert.equal(waiveReplayRes.body.replayed, true);

    // 8. Client-supplied business time remains unsupported.
    const clientTimeRes = await request(
      "POST",
      "/api/deliverables/dlv-api-waive/actions/waive",
      {
        authorization: `Bearer ${pm}`,
        "idempotency-key": "idem-waive-http-client-time",
      },
      {
        expectedVersion: 2,
        reason: "Client-selected time",
        occurredAtUtc: "2000-01-01T00:00:00.000Z",
      },
    );
    assert.equal(clientTimeRes.status, 422);
    assert.equal(clientTimeRes.body.code, "VALIDATION_FAILED");

    // 9. GET non-existent deliverable -> 404
    const notFoundRes = await request("GET", "/api/deliverables/dlv-non-existent", {
      authorization: `Bearer ${pm}`,
    });
    assert.equal(notFoundRes.status, 404);
    assert.equal(notFoundRes.body.code, "DELIVERABLE_NOT_FOUND");
  } finally {
    await fixture.cleanup();
  }
});

// --------------------------------------------------------------------------
// R2F1 Finding 2: Asset ID enumeration — non-existent, deleted, cross project/node/domain/epoch
// all fail-closed with the same 404 EVIDENCE_NOT_FOUND; only when scope matches does the
// lifecycle-unavailable distinction appear.
// --------------------------------------------------------------------------
for (const backend of ["memory", "sqlite"] as const) {
  test(`R2F1-2 (${backend}): unknown asset ids are uniformly non-enumerable 404 before lifecycle is exposed`, async () => {
    const fixture = await createFixture(backend);
    try {
      await setupBaseProject(fixture.persistence);
      const initHandler = new InitializeDeliverableRequirementHandler(fixture.persistence);
      const submitHandler = new SubmitDeliverableEvidenceHandler(fixture.persistence);
      await initHandler.execute({
        tenantId: tenant,
        commandId: "cmd-init-enum",
        idempotencyKey: "idem-init-enum",
        correlationId: "corr-init-enum",
        principalId: pm,
        projectId,
        nodeId: subNodeId,
        deliverableId: "req-enum",
        requirementKey: "key-enum",
        title: "Enumeration Matrix",
        required: true,
        acceptedSourceTypes: ["file"],
        minCount: 1,
        reviewerPrincipalId: reviewer,
        occurredAtUtc: "2026-09-04T00:00:00.000Z",
      });
      await insertAsset(fixture.persistence, { assetId: "asset-enum-ok", ownerNodeId: subNodeId });

      const probe = (sourceId: string, commandSuffix: string) => submitHandler.execute({
        tenantId: tenant,
        commandId: `cmd-probe-${commandSuffix}`,
        idempotencyKey: `idem-probe-${commandSuffix}`,
        correlationId: `corr-probe-${commandSuffix}`,
        principalId: nodeLeader,
        deliverableId: "req-enum",
        expectedVersion: 1,
        evidence: [{ sourceType: "file", sourceId }],
        occurredAtUtc: "2026-09-04T01:00:00.000Z",
      });

      // 1. Non-existent asset: EVIDENCE_NOT_FOUND (404), indistinguishable from deleted/cross-scope
      await assert.rejects(probe("asset-missing", "missing"), (err: ApplicationError) => err.code === "EVIDENCE_NOT_FOUND");

      // 2. Cross project asset: EVIDENCE_NOT_FOUND (404) — not an availability error
      await insertAsset(fixture.persistence, { assetId: "asset-enum-cross-proj", projectId: otherProjectId, ownerNodeId: subNodeId, lifecycleState: "available" });
      await assert.rejects(probe("asset-enum-cross-proj", "cross-proj"), (err: ApplicationError) => err.code === "EVIDENCE_NOT_FOUND");

      // 3. Cross node asset: EVIDENCE_NOT_FOUND (404)
      await insertAsset(fixture.persistence, { assetId: "asset-enum-cross-node", ownerNodeId: otherNodeId, lifecycleState: "available" });
      await assert.rejects(probe("asset-enum-cross-node", "cross-node"), (err: ApplicationError) => err.code === "EVIDENCE_NOT_FOUND");

      // 4. Cross epoch (legacy reference, same domain id): EVIDENCE_NOT_FOUND (404)
      await insertAsset(fixture.persistence, { assetId: "asset-enum-cross-epoch", ownerNodeId: subNodeId, lifecycleState: "available", securityEpoch: 2 });
      await assert.rejects(probe("asset-enum-cross-epoch", "cross-epoch"), (err: ApplicationError) => err.code === "EVIDENCE_NOT_FOUND");

      // 5. Cross domain: EVIDENCE_NOT_FOUND (404)
      await insertAsset(fixture.persistence, { assetId: "asset-enum-cross-domain", ownerNodeId: subNodeId, lifecycleState: "available", securityDomainId: "some-other-domain" });
      await assert.rejects(probe("asset-enum-cross-domain", "cross-domain"), (err: ApplicationError) => err.code === "EVIDENCE_NOT_FOUND");

      // 6. Deleted asset in matching scope: still EVIDENCE_NOT_FOUND (404), not lifecycle-specific
      await insertAsset(fixture.persistence, { assetId: "asset-enum-deleted", ownerNodeId: subNodeId, lifecycleState: "available", deletedAtUtc: "2026-09-04T00:30:00.000Z" });
      await assert.rejects(probe("asset-enum-deleted", "deleted"), (err: ApplicationError) => err.code === "EVIDENCE_NOT_FOUND");

      // 7. Only after scope matches does the lifecycle distinction appear:
      // quarantined/failed/uploading in the exact same scope -> EVIDENCE_NOT_AVAILABLE
      await insertAsset(fixture.persistence, { assetId: "asset-enum-quarantined", ownerNodeId: subNodeId, lifecycleState: "quarantined" });
      await assert.rejects(probe("asset-enum-quarantined", "quarantined"), (err: ApplicationError) => err.code === "EVIDENCE_NOT_AVAILABLE");

      // 8. Positive control: in-scope available asset still passes
      await probe("asset-enum-ok", "positive");
    } finally {
      await fixture.cleanup();
    }
  });
}

// --------------------------------------------------------------------------
// R2F1 Finding 3: replay re-authorization, drift and legitimate lifecycle progression
// --------------------------------------------------------------------------
for (const backend of ["memory", "sqlite"] as const) {
  test(`R2F1-3 (${backend}): replay fully reauthorizes; revoked grant fails closed, later legal steps stay compatible`, async () => {
    const fixture = await createFixture(backend);
    try {
      await setupBaseProject(fixture.persistence);
      const initHandler = new InitializeDeliverableRequirementHandler(fixture.persistence);
      const submitHandler = new SubmitDeliverableEvidenceHandler(fixture.persistence);
      const acceptHandler = new AcceptDeliverableHandler(fixture.persistence);
      const waiveHandler = new WaiveDeliverableHandler(fixture.persistence);
      const grantHandler = new ManageSecurityGrantHandler(fixture.persistence);

      // Initialize an in-scope deliverable
      await initHandler.execute({
        tenantId: tenant,
        commandId: "cmd-init-r3",
        idempotencyKey: "idem-init-r3",
        correlationId: "corr-init-r3",
        principalId: pm,
        projectId,
        nodeId: subNodeId,
        deliverableId: "req-r3",
        requirementKey: "key-r3",
        title: "Replay Matrix",
        required: true,
        acceptedSourceTypes: ["file"],
        minCount: 1,
        reviewerPrincipalId: reviewer,
        occurredAtUtc: "2026-09-04T00:00:00.000Z",
      });
      await insertAsset(fixture.persistence, { assetId: "asset-r3", ownerNodeId: subNodeId });

      // Submit successfully
      const submitResult = await submitHandler.execute({
        tenantId: tenant,
        commandId: "cmd-sub-r3",
        idempotencyKey: "idem-sub-r3",
        correlationId: "corr-sub-r3",
        principalId: nodeLeader,
        deliverableId: "req-r3",
        expectedVersion: 1,
        evidence: [{ sourceType: "file", sourceId: "asset-r3" }],
        occurredAtUtc: "2026-09-04T01:00:00.000Z",
      });
      assert.equal(submitResult.value.status, "submitted");

      // Clean replay of submit (same payload, state unchanged) stays replayed
      const submitReplay = await submitHandler.execute({
        tenantId: tenant,
        commandId: "cmd-sub-r3-replay",
        idempotencyKey: "idem-sub-r3",
        correlationId: "corr-sub-r3-replay",
        principalId: nodeLeader,
        deliverableId: "req-r3",
        expectedVersion: 1,
        evidence: [{ sourceType: "file", sourceId: "asset-r3" }],
        occurredAtUtc: "2026-09-04T01:00:00.000Z",
      });
      assert.equal(submitReplay.replayed, true);
      assert.equal(submitReplay.value.status, "submitted");

      // Accept via reviewer; the replayed accept receipt remains compatible with later reads
      await acceptHandler.execute({
        tenantId: tenant,
        commandId: "cmd-acc-r3",
        idempotencyKey: "idem-acc-r3",
        correlationId: "corr-acc-r3",
        principalId: reviewer,
        deliverableId: "req-r3",
        expectedVersion: 2,
        note: "ok",
        occurredAtUtc: "2026-09-04T02:00:00.000Z",
      });
      const acceptReplay = await acceptHandler.execute({
        tenantId: tenant,
        commandId: "cmd-acc-r3-replay",
        idempotencyKey: "idem-acc-r3",
        correlationId: "corr-acc-r3-replay",
        principalId: reviewer,
        deliverableId: "req-r3",
        expectedVersion: 2,
        note: "ok",
        occurredAtUtc: "2026-09-04T02:00:00.000Z",
      });
      assert.equal(acceptReplay.replayed, true);
      assert.equal(acceptReplay.value.status, "accepted");

      // Stale submit replay after legal lifecycle progression: fail-closed, not treated as replay
      await assert.rejects(
        submitHandler.execute({
          tenantId: tenant,
          commandId: "cmd-sub-r3-stale",
          idempotencyKey: "idem-sub-r3",
          correlationId: "corr-sub-r3-stale",
          principalId: nodeLeader,
          deliverableId: "req-r3",
          expectedVersion: 1,
          evidence: [{ sourceType: "file", sourceId: "asset-r3" }],
          occurredAtUtc: "2026-09-04T01:00:00.000Z",
        }),
        (err: ApplicationError) => err.code === "DELIVERABLE_VERSION_CONFLICT",
      );

      // Waive: second requirement, replay compatibility
      await initHandler.execute({
        tenantId: tenant,
        commandId: "cmd-init-r3-w",
        idempotencyKey: "idem-init-r3-w",
        correlationId: "corr-init-r3-w",
        principalId: pm,
        projectId,
        nodeId: subNodeId,
        deliverableId: "req-r3-w",
        requirementKey: "key-r3-w",
        title: "Replay Waive",
        required: true,
        acceptedSourceTypes: ["file"],
        minCount: 1,
        reviewerPrincipalId: reviewer,
        occurredAtUtc: "2026-09-04T00:00:00.000Z",
      });
      await waiveHandler.execute({
        tenantId: tenant,
        commandId: "cmd-waive-r3",
        idempotencyKey: "idem-waive-r3",
        correlationId: "corr-waive-r3",
        principalId: pm,
        deliverableId: "req-r3-w",
        expectedVersion: 1,
        reason: "out of scope",
        occurredAtUtc: "2026-09-04T03:00:00.000Z",
      });
      const waiveReplay = await waiveHandler.execute({
        tenantId: tenant,
        commandId: "cmd-waive-r3-replay",
        idempotencyKey: "idem-waive-r3",
        correlationId: "corr-waive-r3-replay",
        principalId: pm,
        deliverableId: "req-r3-w",
        expectedVersion: 1,
        reason: "out of scope",
        occurredAtUtc: "2026-09-04T03:00:00.000Z",
      });
      assert.equal(waiveReplay.replayed, true);
      assert.equal(waiveReplay.value.status, "waived");

      // Revoked-grant matrix: a deliverable inside a Security Domain whose reviewer's view grant is
      // revoked must fail closed on replay of the accept receipt, while a legal later lifecycle step
      // (the accept itself) was only compatible while the grant was active.
      const grantDomainFixture = await createFixture(backend);
      try {
        await setupBaseProject(grantDomainFixture.persistence);
        const grantFixtureHandler = new ManageSecurityGrantHandler(grantDomainFixture.persistence);
        const secRoot = new CreateSecurityRootHandler(grantDomainFixture.persistence);
        await secRoot.execute({
          tenantId: tenant,
          commandId: "cmd-sec-root-r3",
          idempotencyKey: "idem-sec-root-r3",
          correlationId: "corr-sec-root-r3",
          principalId: pm,
          projectId,
          nodeId: subNodeId,
          securityDomainId: "dlv-r3-domain",
          expectedNodeVersion: 2,
          reason: "R2F1 grant matrix",
          occurredAtUtc: "2026-09-04T04:00:00.000Z",
        });
        // Reviewer holds an active view grant; contributor grant for the node leader, later revoked.
        const reviewerGrant = await grantFixtureHandler.execute({
          tenantId: tenant,
          commandId: "cmd-grant-reviewer",
          idempotencyKey: "idem-grant-reviewer",
          correlationId: "corr-grant-reviewer",
          principalId: pm,
          projectId,
          securityDomainId: "dlv-r3-domain",
          targetPrincipalId: reviewer,
          action: "set",
          capability: "view",
          expiresAtUtc: null,
          expectedGrantVersion: null,
          expectedDomainVersion: 1,
          reason: "reviewer view grant",
          occurredAtUtc: "2026-09-04T04:30:00.000Z",
        });
        await grantFixtureHandler.execute({
          tenantId: tenant,
          commandId: "cmd-grant-nl",
          idempotencyKey: "idem-grant-nl",
          correlationId: "corr-grant-nl",
          principalId: pm,
          projectId,
          securityDomainId: "dlv-r3-domain",
          targetPrincipalId: nodeLeader,
          action: "set",
          capability: "contribute",
          expiresAtUtc: null,
          expectedGrantVersion: null,
          expectedDomainVersion: reviewerGrant.value.domainVersion,
          reason: "contributor grant for replay test",
          occurredAtUtc: "2026-09-04T05:00:00.000Z",
        });
        const submitInDomain = new SubmitDeliverableEvidenceHandler(grantDomainFixture.persistence);
        const initInDomain = new InitializeDeliverableRequirementHandler(grantDomainFixture.persistence);
        const acceptInDomain = new AcceptDeliverableHandler(grantDomainFixture.persistence);
        await initInDomain.execute({
          tenantId: tenant,
          commandId: "cmd-init-domain",
          idempotencyKey: "idem-init-domain",
          correlationId: "corr-init-domain",
          principalId: pm,
          projectId,
          nodeId: subNodeId,
          deliverableId: "req-domain-grant",
          requirementKey: "key-domain-grant",
          title: "Domain Grant Matrix",
          required: true,
          acceptedSourceTypes: ["file"],
          minCount: 1,
          reviewerPrincipalId: reviewer,
          occurredAtUtc: "2026-09-04T05:05:00.000Z",
        });
        await grantDomainFixture.persistence.transaction(tenant, async (tx) => {
          await tx.assets.insert({
            tenantId: tenant, id: "asset-domain-grant", projectId, ownerNodeId: subNodeId,
            securityDomainId: "dlv-r3-domain", securityEpoch: 2,
            uploaderPrincipalId: nodeLeader, displayName: "d", contentType: "application/pdf", size: 1,
            sha256: "d", lifecycleState: "available", failureCode: null, version: 1, deletedAtUtc: null,
          });
        });
        // Leader with the active contribute grant can submit
        await submitInDomain.execute({
          tenantId: tenant,
          commandId: "cmd-sub-domain-grant",
          idempotencyKey: "idem-sub-domain-grant",
          correlationId: "corr-sub-domain-grant",
          principalId: nodeLeader,
          deliverableId: "req-domain-grant",
          expectedVersion: 1,
          evidence: [{ sourceType: "file", sourceId: "asset-domain-grant" }],
          occurredAtUtc: "2026-09-04T05:10:00.000Z",
        });
        // Revoke the reviewer view grant; accept must fail closed
        const revokeDomainVersion = await grantDomainFixture.persistence.read(tenant, async (tx) => {
          const d = await tx.securityDomains.get("dlv-r3-domain");
          return d?.version;
        });
        await grantFixtureHandler.execute({
          tenantId: tenant,
          commandId: "cmd-revoke-reviewer",
          idempotencyKey: "idem-revoke-reviewer",
          correlationId: "corr-revoke-reviewer",
          principalId: pm,
          projectId,
          securityDomainId: "dlv-r3-domain",
          targetPrincipalId: reviewer,
          action: "revoke",
          capability: null,
          expiresAtUtc: null,
          expectedGrantVersion: reviewerGrant.value.grantVersion,
          expectedDomainVersion: revokeDomainVersion as number,
          reason: "revoke reviewer view grant",
          occurredAtUtc: "2026-09-04T05:15:00.000Z",
        });
        await assert.rejects(
          acceptInDomain.execute({
            tenantId: tenant,
            commandId: "cmd-acc-domain-grant",
            idempotencyKey: "idem-acc-domain-grant",
            correlationId: "corr-acc-domain-grant",
            principalId: reviewer,
            deliverableId: "req-domain-grant",
            expectedVersion: 2,
            note: "reviewer accepts",
            occurredAtUtc: "2026-09-04T05:20:00.000Z",
          }),
          (err: ApplicationError) => err.code === "DELIVERABLE_NOT_FOUND" || err.code === "REVIEWER_NOT_ELIGIBLE" || err.code === "DELIVERABLE_ACTION_FORBIDDEN",
        );
        // Legal later lifecycle step: PM accept (edit capability via membership + active PM path)
        // stays compatible as a fresh, non-replayed command after the reviewer grant revoke.
        const pmAccept = await acceptInDomain.execute({
          tenantId: tenant,
          commandId: "cmd-acc-domain-pm",
          idempotencyKey: "idem-acc-domain-pm",
          correlationId: "corr-acc-domain-pm",
          principalId: pm,
          deliverableId: "req-domain-grant",
          expectedVersion: 2,
          note: "PM accepts after reviewer grant revoke",
          occurredAtUtc: "2026-09-04T05:25:00.000Z",
        });
        assert.equal(pmAccept.replayed, false);
        assert.equal(pmAccept.value.status, "accepted");
        // Replay of that PM accept receipt stays compatible with the terminal accepted state
        const pmAcceptReplay = await acceptInDomain.execute({
          tenantId: tenant,
          commandId: "cmd-acc-domain-pm-replay",
          idempotencyKey: "idem-acc-domain-pm",
          correlationId: "corr-acc-domain-pm-replay",
          principalId: pm,
          deliverableId: "req-domain-grant",
          expectedVersion: 2,
          note: "PM accepts after reviewer grant revoke",
          occurredAtUtc: "2026-09-04T05:25:00.000Z",
        });
        assert.equal(pmAcceptReplay.replayed, true);
      } finally {
        await grantDomainFixture.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });
}

test("R2F2-1: replay fails closed on deleted/replaced actions and equal-count EvidenceLink replacement", async () => {
  for (const backend of ["memory", "sqlite"] as const) {
    for (const tamper of ["delete-action", "replace-action", "replace-link"] as const) {
      const fixture = await createFixture(backend);
      let replayPersistence: Persistence = fixture.persistence;
      try {
        await setupBaseProject(fixture.persistence);
        const suffix = `${backend}-${tamper}`;
        await new InitializeDeliverableRequirementHandler(fixture.persistence).execute({
          tenantId: tenant,
          commandId: `cmd-init-tamper-${suffix}`,
          idempotencyKey: `idem-init-tamper-${suffix}`,
          correlationId: `corr-init-tamper-${suffix}`,
          principalId: pm,
          projectId,
          nodeId: subNodeId,
          deliverableId: `req-tamper-${suffix}`,
          requirementKey: `key-tamper-${suffix}`,
          title: "Replay tamper",
          required: true,
          acceptedSourceTypes: ["file"],
          minCount: 1,
          reviewerPrincipalId: reviewer,
          occurredAtUtc: "2026-09-04T00:00:00.000Z",
        });
        await insertAsset(fixture.persistence, { assetId: `asset-tamper-${suffix}`, ownerNodeId: subNodeId });
        await new SubmitDeliverableEvidenceHandler(fixture.persistence).execute({
          tenantId: tenant,
          commandId: `cmd-submit-tamper-${suffix}`,
          idempotencyKey: `idem-submit-tamper-${suffix}`,
          correlationId: `corr-submit-tamper-${suffix}`,
          principalId: nodeLeader,
          deliverableId: `req-tamper-${suffix}`,
          expectedVersion: 1,
          evidence: [{ sourceType: "file", sourceId: `asset-tamper-${suffix}` }],
          occurredAtUtc: "2026-09-04T01:00:00.000Z",
        });

        if (backend === "memory") {
          const snapshot = (fixture.persistence as MemoryPersistence).snapshot();
          const oldActionId = `act:cmd-submit-tamper-${suffix}`;
          const oldActionKey = `${tenant}\u0000${oldActionId}`;
          const oldLinkId = `link:req-tamper-${suffix}:file:asset-tamper-${suffix}`;
          const oldLinkKey = `${tenant}\u0000${oldLinkId}`;
          if (tamper === "delete-action") {
            snapshot.deliverableActions.delete(oldActionKey);
          } else if (tamper === "replace-action") {
            const action = snapshot.deliverableActions.get(oldActionKey)!;
            snapshot.deliverableActions.delete(oldActionKey);
            snapshot.deliverableActions.set(`${tenant}\u0000replacement:${oldActionId}`, {
              ...action,
              id: `replacement:${oldActionId}`,
            });
          } else {
            const link = snapshot.evidenceLinks.get(oldLinkKey)!;
            snapshot.evidenceLinks.delete(oldLinkKey);
            snapshot.evidenceLinks.set(`${tenant}\u0000replacement:${oldLinkId}`, {
              ...link,
              id: `replacement:${oldLinkId}`,
            });
          }
          replayPersistence = new MemoryPersistence({ snapshot });
        } else {
          const raw = new DatabaseSync(fixture.path!);
          if (tamper === "delete-action") {
            raw.prepare("DELETE FROM deliverable_action_records WHERE action_id = ?")
              .run(`act:cmd-submit-tamper-${suffix}`);
          } else if (tamper === "replace-action") {
            raw.prepare("UPDATE deliverable_action_records SET action_id = ? WHERE action_id = ?")
              .run(`replacement:act:cmd-submit-tamper-${suffix}`, `act:cmd-submit-tamper-${suffix}`);
          } else {
            raw.prepare("UPDATE deliverable_evidence_links SET link_id = ? WHERE requirement_id = ?")
              .run(`replacement:link:${suffix}`, `req-tamper-${suffix}`);
          }
          raw.close();
        }

        await assert.rejects(
          new SubmitDeliverableEvidenceHandler(replayPersistence).execute({
            tenantId: tenant,
            commandId: `cmd-submit-replay-${suffix}`,
            idempotencyKey: `idem-submit-tamper-${suffix}`,
            correlationId: `corr-submit-replay-${suffix}`,
            principalId: nodeLeader,
            deliverableId: `req-tamper-${suffix}`,
            expectedVersion: 1,
            evidence: [{ sourceType: "file", sourceId: `asset-tamper-${suffix}` }],
            occurredAtUtc: "2026-09-04T01:00:00.000Z",
          }),
          (error: ApplicationError) => error.code === "DELIVERABLE_RECORD_CORRUPT",
        );
      } finally {
        if (replayPersistence !== fixture.persistence) await replayPersistence.close();
        await fixture.cleanup();
      }
    }
  }
});

// --------------------------------------------------------------------------
// R2F5 Finding 1: submit replay must bind the exact full (sourceType, sourceId)
// set of the authoritative links against the original command/receipt. A
// simultaneous tamper of an authoritative link's sourceType and the receipt's
// stored sourceType (leaving sourceId untouched) must fail closed.
// --------------------------------------------------------------------------
test("R2F5-1 (memory/sqlite): submit replay fails closed when an authoritative link sourceType and the receipt sourceType are tampered together", async () => {
  for (const backend of ["memory", "sqlite"] as const) {
    const fixture = await createFixture(backend);
    let replayPersistence: Persistence = fixture.persistence;
    try {
      const suffix = `r2f5-${backend}`;
      await setupBaseProject(fixture.persistence);
      await new InitializeDeliverableRequirementHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: `cmd-init-${suffix}`,
        idempotencyKey: `idem-init-${suffix}`,
        correlationId: `corr-init-${suffix}`,
        principalId: pm,
        projectId,
        nodeId: subNodeId,
        deliverableId: `req-${suffix}`,
        requirementKey: `key-${suffix}`,
        title: "R2F5 sourceType binding",
        required: true,
        acceptedSourceTypes: ["file"],
        minCount: 1,
        reviewerPrincipalId: reviewer,
        occurredAtUtc: "2026-09-04T00:00:00.000Z",
      });
      await insertAsset(fixture.persistence, { assetId: `asset-${suffix}`, ownerNodeId: subNodeId });
      await new SubmitDeliverableEvidenceHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: `cmd-submit-${suffix}`,
        idempotencyKey: `idem-submit-${suffix}`,
        correlationId: `corr-submit-${suffix}`,
        principalId: nodeLeader,
        deliverableId: `req-${suffix}`,
        expectedVersion: 1,
        evidence: [{ sourceType: "file", sourceId: `asset-${suffix}` }],
        occurredAtUtc: "2026-09-04T01:00:00.000Z",
      });

      const linkId = `link:req-${suffix}:file:asset-${suffix}`;
      const receiptScopeKey = `${tenant}\u0000${nodeLeader}\u0000submit_deliverable_evidence\u0000idem-submit-${suffix}`;
      if (backend === "memory") {
        const snapshot = (fixture.persistence as MemoryPersistence).snapshot();
        // Tamper the authoritative link AND the stored receipt together:
        // sourceType file -> process_record, sourceId kept identical.
        const linkKey = `${tenant}\u0000${linkId}`;
        const link = snapshot.evidenceLinks.get(linkKey)!;
        snapshot.evidenceLinks.delete(linkKey);
        snapshot.evidenceLinks.set(`${tenant}\u0000tampered:${linkId}`, {
          ...link,
          id: `tampered:${linkId}`,
          sourceType: "process_record",
        });
        const receipt = snapshot.receipts.get(receiptScopeKey)!;
        const tamperedReceipt = structuredClone(receipt);
        const result = tamperedReceipt.result as { evidenceLinks: Array<{ sourceType?: string }> };
        for (const storedLink of result.evidenceLinks) {
          storedLink.sourceType = "process_record";
        }
        snapshot.receipts.set(receiptScopeKey, tamperedReceipt);
        replayPersistence = new MemoryPersistence({ snapshot });
      } else {
        const raw = new DatabaseSync(fixture.path!);
        raw.prepare("UPDATE deliverable_evidence_links SET source_type = 'process_record' WHERE link_id = ?")
          .run(linkId);
        const receiptRow = raw.prepare(`
          SELECT result_json FROM command_receipts
          WHERE tenant_id = ? AND principal_id = ? AND operation = 'submit_deliverable_evidence'
            AND idempotency_key = ?
        `).get(tenant, nodeLeader, `idem-submit-${suffix}`) as { result_json: string } | undefined;
        assert.notEqual(receiptRow, undefined, "The submit receipt must exist for tampering");
        const result = JSON.parse(receiptRow!.result_json) as { evidenceLinks: Array<Record<string, unknown>> };
        for (const storedLink of result.evidenceLinks) {
          storedLink.sourceType = "process_record";
        }
        raw.prepare("UPDATE command_receipts SET result_json = ? WHERE tenant_id = ? AND principal_id = ? AND operation = 'submit_deliverable_evidence' AND idempotency_key = ?")
          .run(JSON.stringify(result), tenant, nodeLeader, `idem-submit-${suffix}`);
        raw.close();
      }

      // The re-submitted command keeps the original (untampered) payload: the
      // authoritative/receipt pair set now disagrees with the command, and the
      // tampered sourceType must be re-checked against the accepted-source and
      // ProcessRecord constraints on replay.
      await assert.rejects(
        new SubmitDeliverableEvidenceHandler(replayPersistence).execute({
          tenantId: tenant,
          commandId: `cmd-submit-replay-${suffix}`,
          idempotencyKey: `idem-submit-${suffix}`,
          correlationId: `corr-submit-replay-${suffix}`,
          principalId: nodeLeader,
          deliverableId: `req-${suffix}`,
          expectedVersion: 1,
          evidence: [{ sourceType: "file", sourceId: `asset-${suffix}` }],
          occurredAtUtc: "2026-09-04T01:00:00.000Z",
        }),
        (error: ApplicationError) =>
          error.code === "DELIVERABLE_RECORD_CORRUPT"
          || error.code === "SOURCE_TYPE_UNSUPPORTED"
          || error.code === "PROCESS_RECORD_UNSUPPORTED",
      );
    } finally {
      if (replayPersistence !== fixture.persistence) await replayPersistence.close();
      await fixture.cleanup();
    }
  }
});

// --------------------------------------------------------------------------
// R2F6 Finding 1: submit replay must bind the exact canonical action/link/command
// facts. A simultaneous tamper of the submitted action's actor/time, the link's
// submitter/time/ID and the receipt records (keeping everything internally
// consistent with the NEW values, while the replaying command keeps the
// original payload) must fail closed on both backends.
// --------------------------------------------------------------------------
test("R2F6-1 (memory/sqlite): submit replay fails closed when action, links and receipt are tampered together with a consistent actor/time", async () => {
  for (const backend of ["memory", "sqlite"] as const) {
    const fixture = await createFixture(backend);
    let replayPersistence: Persistence = fixture.persistence;
    try {
      const suffix = `r2f6-${backend}`;
      await setupBaseProject(fixture.persistence);
      await new InitializeDeliverableRequirementHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: `cmd-init-${suffix}`,
        idempotencyKey: `idem-init-${suffix}`,
        correlationId: `corr-init-${suffix}`,
        principalId: pm,
        projectId,
        nodeId: subNodeId,
        deliverableId: `req-${suffix}`,
        requirementKey: `key-${suffix}`,
        title: "R2F6 canonical replay binding",
        required: true,
        acceptedSourceTypes: ["file"],
        minCount: 1,
        reviewerPrincipalId: reviewer,
        occurredAtUtc: "2026-09-04T00:00:00.000Z",
      });
      await insertAsset(fixture.persistence, { assetId: `asset-${suffix}`, ownerNodeId: subNodeId });
      await new SubmitDeliverableEvidenceHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: `cmd-submit-${suffix}`,
        idempotencyKey: `idem-submit-${suffix}`,
        correlationId: `corr-submit-${suffix}`,
        principalId: nodeLeader,
        deliverableId: `req-${suffix}`,
        expectedVersion: 1,
        evidence: [{ sourceType: "file", sourceId: `asset-${suffix}` }],
        occurredAtUtc: "2026-09-04T01:00:00.000Z",
      });

      // Tamper the submitted action's actor+time, the link's submitter+time+ID and the receipt's
      // action/link records together, keeping the NEW values internally consistent. The replaying
      // command keeps the original payload (nodeLeader + 01:00:00), so the authoritative/receipt
      // records no longer match it.
      const newActor = "pm-principal" as PrincipalId;
      const newTime = "2026-09-04T02:00:00.000Z";
      const tamperedLinkId = `link:req-${suffix}:file:asset-${suffix}`;
      const receiptScopeKey = `${tenant}\u0000${nodeLeader}\u0000submit_deliverable_evidence\u0000idem-submit-${suffix}`;
      if (backend === "memory") {
        const snapshot = (fixture.persistence as MemoryPersistence).snapshot();
        const actionKey = `${tenant}\u0000act:cmd-submit-${suffix}`;
        const action = snapshot.deliverableActions.get(actionKey)!;
        snapshot.deliverableActions.delete(actionKey);
        snapshot.deliverableActions.set(`${tenant}\u0000replacement:act:cmd-submit-${suffix}`, {
          ...action,
          id: `replacement:act:cmd-submit-${suffix}`,
          actorPrincipalId: newActor,
          occurredAtUtc: newTime,
        } as DeliverableActionRecord);
        const linkKey = `${tenant}\u0000${tamperedLinkId}`;
        const link = snapshot.evidenceLinks.get(linkKey)!;
        snapshot.evidenceLinks.delete(linkKey);
        snapshot.evidenceLinks.set(`${tenant}\u0000tampered:${tamperedLinkId}`, {
          ...link,
          id: `tampered:${tamperedLinkId}`,
          submittedByPrincipalId: newActor,
          linkedAtUtc: newTime,
        } as EvidenceLink);
        const receipt = snapshot.receipts.get(receiptScopeKey)!;
        const tamperedReceipt = structuredClone(receipt);
        const result = tamperedReceipt.result as {
          evidenceLinks: Array<{ submittedByPrincipalId?: string; linkedAtUtc?: string; id?: string }>;
          actionHistory: Array<Record<string, unknown>>;
        };
        for (const storedLink of result.evidenceLinks) {
          storedLink.submittedByPrincipalId = newActor;
          storedLink.linkedAtUtc = newTime;
          storedLink.id = `tampered:${tamperedLinkId}`;
        }
        for (const storedAction of result.actionHistory) {
          if (storedAction.action === "submitted") {
            storedAction.id = `replacement:act:cmd-submit-${suffix}`;
            storedAction.actorPrincipalId = newActor;
            storedAction.occurredAtUtc = newTime;
          }
        }
        snapshot.receipts.set(receiptScopeKey, tamperedReceipt);
        replayPersistence = new MemoryPersistence({ snapshot });
      } else {
        const raw = new DatabaseSync(fixture.path!);
        raw.prepare(
          "UPDATE deliverable_action_records SET action_id = ?, actor_principal_id = ?, occurred_at_utc = ? WHERE action_id = ?",
        ).run(
          `replacement:act:cmd-submit-${suffix}`,
          newActor,
          newTime,
          `act:cmd-submit-${suffix}`,
        );
        raw.prepare(
          "UPDATE deliverable_evidence_links SET link_id = ?, submitted_by_principal_id = ?, linked_at_utc = ? WHERE link_id = ?",
        ).run(`tampered:${tamperedLinkId}`, newActor, newTime, tamperedLinkId);
        const receiptRow = raw.prepare(`
          SELECT result_json FROM command_receipts
          WHERE tenant_id = ? AND principal_id = ? AND operation = 'submit_deliverable_evidence'
            AND idempotency_key = ?
        `).get(tenant, nodeLeader, `idem-submit-${suffix}`) as { result_json: string } | undefined;
        assert.notEqual(receiptRow, undefined, "The submit receipt must exist for tampering");
        const result = JSON.parse(receiptRow!.result_json) as {
          evidenceLinks: Array<Record<string, unknown>>;
          actionHistory: Array<Record<string, unknown>>;
        };
        for (const storedLink of result.evidenceLinks) {
          storedLink.submittedByPrincipalId = newActor;
          storedLink.linkedAtUtc = newTime;
          storedLink.id = `tampered:${tamperedLinkId}`;
        }
        for (const storedAction of result.actionHistory) {
          if (storedAction.action === "submitted") {
            storedAction.id = `replacement:act:cmd-submit-${suffix}`;
            storedAction.actorPrincipalId = newActor;
            storedAction.occurredAtUtc = newTime;
          }
        }
        raw.prepare(
          "UPDATE command_receipts SET result_json = ? WHERE tenant_id = ? AND principal_id = ? AND operation = 'submit_deliverable_evidence' AND idempotency_key = ?",
        ).run(JSON.stringify(result), tenant, nodeLeader, `idem-submit-${suffix}`);
        raw.close();
      }

      // The replaying command keeps the original (untampered) payload: the authoritative/receipt
      // canonical records now disagree with the command principal and with the original link
      // submitter/time, and the tampered link id is no longer canonical for its pair.
      await assert.rejects(
        new SubmitDeliverableEvidenceHandler(replayPersistence).execute({
          tenantId: tenant,
          commandId: `cmd-submit-replay-${suffix}`,
          idempotencyKey: `idem-submit-${suffix}`,
          correlationId: `corr-submit-replay-${suffix}`,
          principalId: nodeLeader,
          deliverableId: `req-${suffix}`,
          expectedVersion: 1,
          evidence: [{ sourceType: "file", sourceId: `asset-${suffix}` }],
          occurredAtUtc: "2026-09-04T01:00:00.000Z",
        }),
        (error: ApplicationError) => error.code === "DELIVERABLE_RECORD_CORRUPT",
      );
    } finally {
      if (replayPersistence !== fixture.persistence) await replayPersistence.close();
      await fixture.cleanup();
    }
  }
});

// --------------------------------------------------------------------------
// R2F6 Finding 2: accept and waive replay must re-run the complete authoritative
// submission semantics. A simultaneous tamper of an authoritative evidence link
// (file -> process_record) and the corresponding receipt records must fail
// closed in both the accept replay and the waive replay paths.
// --------------------------------------------------------------------------
test("R2F6-2 (memory/sqlite): accept and waive replay fail closed when a link sourceType and the receipt are tampered together to process_record", async () => {
  for (const backend of ["memory", "sqlite"] as const) {
    for (const flow of ["accept", "waive"] as const) {
      const fixture = await createFixture(backend);
      let replayPersistence: Persistence = fixture.persistence;
      try {
        const suffix = `r2f6-${flow}-${backend}`;
        await setupBaseProject(fixture.persistence);
        await new InitializeDeliverableRequirementHandler(fixture.persistence).execute({
          tenantId: tenant,
          commandId: `cmd-init-${suffix}`,
          idempotencyKey: `idem-init-${suffix}`,
          correlationId: `corr-init-${suffix}`,
          principalId: pm,
          projectId,
          nodeId: subNodeId,
          deliverableId: `req-${suffix}`,
          requirementKey: `key-${suffix}`,
          title: "R2F6 replay evidence revalidation",
          required: true,
          acceptedSourceTypes: ["file"],
          minCount: 1,
          reviewerPrincipalId: reviewer,
          occurredAtUtc: "2026-09-04T00:00:00.000Z",
        });
        await insertAsset(fixture.persistence, { assetId: `asset-${suffix}`, ownerNodeId: subNodeId });
        await new SubmitDeliverableEvidenceHandler(fixture.persistence).execute({
          tenantId: tenant,
          commandId: `cmd-submit-${suffix}`,
          idempotencyKey: `idem-submit-${suffix}`,
          correlationId: `corr-submit-${suffix}`,
          principalId: nodeLeader,
          deliverableId: `req-${suffix}`,
          expectedVersion: 1,
          evidence: [{ sourceType: "file", sourceId: `asset-${suffix}` }],
          occurredAtUtc: "2026-09-04T01:00:00.000Z",
        });

        // First, run the legitimate terminal step so the replay branch becomes active.
        const requirementId = `req-${suffix}`;
        const receiptScopeKey = flow === "accept"
          ? `${tenant}\u0000${reviewer}\u0000accept_deliverable\u0000idem-${flow}-${suffix}`
          : `${tenant}\u0000${pm}\u0000waive_deliverable\u0000idem-${flow}-${suffix}`;
        if (flow === "accept") {
          await new AcceptDeliverableHandler(fixture.persistence).execute({
            tenantId: tenant,
            commandId: `cmd-accept-${suffix}`,
            idempotencyKey: `idem-accept-${suffix}`,
            correlationId: `corr-accept-${suffix}`,
            principalId: reviewer,
            deliverableId: requirementId,
            expectedVersion: 2,
            note: "ok",
            occurredAtUtc: "2026-09-04T02:00:00.000Z",
          });
        } else {
          await new WaiveDeliverableHandler(fixture.persistence).execute({
            tenantId: tenant,
            commandId: `cmd-waive-${suffix}`,
            idempotencyKey: `idem-waive-${suffix}`,
            correlationId: `corr-waive-${suffix}`,
            principalId: pm,
            deliverableId: requirementId,
            expectedVersion: 2,
            reason: "out of scope",
            occurredAtUtc: "2026-09-04T02:00:00.000Z",
          });
        }

        // Tamper the authoritative link's sourceType (file -> process_record) AND the terminal
        // receipt's stored evidence links together.
        const linkId = `link:${requirementId}:file:asset-${suffix}`;
        if (backend === "memory") {
          const snapshot = (fixture.persistence as MemoryPersistence).snapshot();
          const linkKey = `${tenant}\u0000${linkId}`;
          const link = snapshot.evidenceLinks.get(linkKey)!;
          snapshot.evidenceLinks.delete(linkKey);
          snapshot.evidenceLinks.set(`${tenant}\u0000tampered:${linkId}`, {
            ...link,
            id: `tampered:${linkId}`,
            sourceType: "process_record",
          } as EvidenceLink);
          const receipt = snapshot.receipts.get(receiptScopeKey)!;
          const tamperedReceipt = structuredClone(receipt);
          const result = tamperedReceipt.result as { evidenceLinks: Array<{ sourceType?: string; id?: string }> };
          for (const storedLink of result.evidenceLinks) {
            storedLink.sourceType = "process_record";
            storedLink.id = `tampered:${linkId}`;
          }
          snapshot.receipts.set(receiptScopeKey, tamperedReceipt);
          replayPersistence = new MemoryPersistence({ snapshot });
        } else {
          const raw = new DatabaseSync(fixture.path!);
          raw.prepare("UPDATE deliverable_evidence_links SET source_type = 'process_record', link_id = ? WHERE link_id = ?")
            .run(`tampered:${linkId}`, linkId);
          const receiptRow = raw.prepare(`
            SELECT result_json FROM command_receipts
            WHERE tenant_id = ? AND operation = ? AND idempotency_key = ?
          `).get(tenant, flow === "accept" ? "accept_deliverable" : "waive_deliverable", `idem-${flow}-${suffix}`) as { result_json: string } | undefined;
          assert.notEqual(receiptRow, undefined, "The terminal receipt must exist for tampering");
          const result = JSON.parse(receiptRow!.result_json) as { evidenceLinks: Array<Record<string, unknown>> };
          for (const storedLink of result.evidenceLinks) {
            storedLink.sourceType = "process_record";
            storedLink.id = `tampered:${linkId}`;
          }
          raw.prepare(
            "UPDATE command_receipts SET result_json = ? WHERE tenant_id = ? AND operation = ? AND idempotency_key = ?",
          ).run(JSON.stringify(result), tenant, flow === "accept" ? "accept_deliverable" : "waive_deliverable", `idem-${flow}-${suffix}`);
          raw.close();
        }

        // Replaying the terminal step must now fail closed: the authoritative link is no
        // longer an accepted source type, the link id is no longer canonical, and the receipt
        // no longer matches the authoritative record.
        if (flow === "accept") {
          await assert.rejects(
            new AcceptDeliverableHandler(replayPersistence).execute({
              tenantId: tenant,
              commandId: `cmd-accept-replay-${suffix}`,
              idempotencyKey: `idem-accept-${suffix}`,
              correlationId: `corr-accept-replay-${suffix}`,
              principalId: reviewer,
              deliverableId: requirementId,
              expectedVersion: 2,
              note: "ok",
              occurredAtUtc: "2026-09-04T02:00:00.000Z",
            }),
            (error: ApplicationError) =>
              error.code === "DELIVERABLE_RECORD_CORRUPT" || error.code === "PROCESS_RECORD_UNSUPPORTED",
          );
        } else {
          await assert.rejects(
            new WaiveDeliverableHandler(replayPersistence).execute({
              tenantId: tenant,
              commandId: `cmd-waive-replay-${suffix}`,
              idempotencyKey: `idem-waive-${suffix}`,
              correlationId: `corr-waive-replay-${suffix}`,
              principalId: pm,
              deliverableId: requirementId,
              expectedVersion: 2,
              reason: "out of scope",
              occurredAtUtc: "2026-09-04T02:00:00.000Z",
            }),
            (error: ApplicationError) =>
              error.code === "DELIVERABLE_RECORD_CORRUPT" || error.code === "PROCESS_RECORD_UNSUPPORTED",
          );
        }
      } finally {
        if (replayPersistence !== fixture.persistence) await replayPersistence.close();
        await fixture.cleanup();
      }
    }
  }
});

// --------------------------------------------------------------------------
// R2F7 Finding 1: terminal replay requires the exact legal lifecycle and binds the
// terminal action to the aggregate, replay principal, original receipt time and
// normalized command reason. Coordinated action+receipt tampering cannot redefine it.
// --------------------------------------------------------------------------
test("R2F7-1 (memory/sqlite): accept/waive replay rejects terminal action+receipt tamper and deleted initialized action", async () => {
  for (const backend of ["memory", "sqlite"] as const) {
    for (const flow of ["accept", "waive"] as const) {
      for (const tamper of ["terminal-action-and-receipt", "delete-initialized"] as const) {
        const fixture = await createFixture(backend);
        let replayPersistence: Persistence = fixture.persistence;
        try {
          const suffix = `r2f7-${backend}-${flow}-${tamper}`;
          const requirementId = `req-${suffix}`;
          await setupBaseProject(fixture.persistence);
          await new InitializeDeliverableRequirementHandler(fixture.persistence).execute({
            tenantId: tenant,
            commandId: `cmd-init-${suffix}`,
            idempotencyKey: `idem-init-${suffix}`,
            correlationId: `corr-init-${suffix}`,
            principalId: pm,
            projectId,
            nodeId: subNodeId,
            deliverableId: requirementId,
            requirementKey: `key-${suffix}`,
            title: "R2F7 terminal replay binding",
            required: true,
            acceptedSourceTypes: ["file"],
            minCount: 1,
            reviewerPrincipalId: reviewer,
            occurredAtUtc: "2026-09-04T00:00:00.000Z",
          });
          if (flow === "accept") {
            await insertAsset(fixture.persistence, { assetId: `asset-${suffix}`, ownerNodeId: subNodeId });
            await new SubmitDeliverableEvidenceHandler(fixture.persistence).execute({
              tenantId: tenant,
              commandId: `cmd-submit-${suffix}`,
              idempotencyKey: `idem-submit-${suffix}`,
              correlationId: `corr-submit-${suffix}`,
              principalId: nodeLeader,
              deliverableId: requirementId,
              expectedVersion: 1,
              evidence: [{ sourceType: "file", sourceId: `asset-${suffix}` }],
              occurredAtUtc: "2026-09-04T01:00:00.000Z",
            });
            await new AcceptDeliverableHandler(fixture.persistence).execute({
              tenantId: tenant,
              commandId: `cmd-accept-${suffix}`,
              idempotencyKey: `idem-accept-${suffix}`,
              correlationId: `corr-accept-${suffix}`,
              principalId: reviewer,
              deliverableId: requirementId,
              expectedVersion: 2,
              note: "  approved  ",
              occurredAtUtc: "2026-09-04T02:00:00.000Z",
            });
          } else {
            // Deliberately waive directly from pending: the only legal lifecycle is
            // initialized+waived (a synthetic submitted action is not tolerated).
            await new WaiveDeliverableHandler(fixture.persistence).execute({
              tenantId: tenant,
              commandId: `cmd-waive-${suffix}`,
              idempotencyKey: `idem-waive-${suffix}`,
              correlationId: `corr-waive-${suffix}`,
              principalId: pm,
              deliverableId: requirementId,
              expectedVersion: 1,
              reason: "  descoped  ",
              occurredAtUtc: "2026-09-04T02:00:00.000Z",
            });
          }

          const operation = flow === "accept" ? "accept_deliverable" : "waive_deliverable";
          const replayPrincipal = flow === "accept" ? reviewer : pm;
          const idempotencyKey = `idem-${flow}-${suffix}`;
          const terminalActionId = `act:cmd-${flow}-${suffix}`;
          const initializedActionId = `act:cmd-init-${suffix}`;
          const tamperedActor = flow === "accept" ? pm : reviewer;
          const tamperedTime = "2026-09-04T03:00:00.000Z";
          const tamperedReason = flow === "accept" ? "tampered approval" : "tampered waiver";

          if (backend === "memory") {
            const snapshot = (fixture.persistence as MemoryPersistence).snapshot();
            const receiptKey = `${tenant}\u0000${replayPrincipal}\u0000${operation}\u0000${idempotencyKey}`;
            const receipt = structuredClone(snapshot.receipts.get(receiptKey)!);
            const result = receipt.result as { actionHistory: DeliverableActionRecord[] };
            if (tamper === "delete-initialized") {
              snapshot.deliverableActions.delete(`${tenant}\u0000${initializedActionId}`);
              result.actionHistory = result.actionHistory.filter((action) => action.action !== "initialized");
            } else {
              const actionKey = `${tenant}\u0000${terminalActionId}`;
              const action = snapshot.deliverableActions.get(actionKey)!;
              snapshot.deliverableActions.set(actionKey, {
                ...action,
                actorPrincipalId: tamperedActor,
                occurredAtUtc: tamperedTime,
                reason: tamperedReason,
              });
              const receiptAction = result.actionHistory.find(
                (action) => action.action === (flow === "accept" ? "accepted" : "waived"),
              ) as unknown as { actorPrincipalId: PrincipalId; occurredAtUtc: string; reason: string | null };
              receiptAction.actorPrincipalId = tamperedActor;
              receiptAction.occurredAtUtc = tamperedTime;
              receiptAction.reason = tamperedReason;
            }
            snapshot.receipts.set(receiptKey, receipt);
            replayPersistence = new MemoryPersistence({ snapshot });
          } else {
            const raw = new DatabaseSync(fixture.path!);
            const receiptRow = raw.prepare(`
              SELECT result_json FROM command_receipts
              WHERE tenant_id = ? AND principal_id = ? AND operation = ? AND idempotency_key = ?
            `).get(tenant, replayPrincipal, operation, idempotencyKey) as { result_json: string };
            const result = JSON.parse(receiptRow.result_json) as { actionHistory: DeliverableActionRecord[] };
            if (tamper === "delete-initialized") {
              raw.prepare("DELETE FROM deliverable_action_records WHERE tenant_id = ? AND action_id = ?")
                .run(tenant, initializedActionId);
              result.actionHistory = result.actionHistory.filter((action) => action.action !== "initialized");
            } else {
              raw.prepare(`
                UPDATE deliverable_action_records
                SET actor_principal_id = ?, occurred_at_utc = ?, reason = ?
                WHERE tenant_id = ? AND action_id = ?
              `).run(tamperedActor, tamperedTime, tamperedReason, tenant, terminalActionId);
              const receiptAction = result.actionHistory.find(
                (action) => action.action === (flow === "accept" ? "accepted" : "waived"),
              ) as unknown as { actorPrincipalId: PrincipalId; occurredAtUtc: string; reason: string | null };
              receiptAction.actorPrincipalId = tamperedActor;
              receiptAction.occurredAtUtc = tamperedTime;
              receiptAction.reason = tamperedReason;
            }
            raw.prepare(`
              UPDATE command_receipts SET result_json = ?
              WHERE tenant_id = ? AND principal_id = ? AND operation = ? AND idempotency_key = ?
            `).run(JSON.stringify(result), tenant, replayPrincipal, operation, idempotencyKey);
            raw.close();
          }

          const replay = flow === "accept"
            ? new AcceptDeliverableHandler(replayPersistence).execute({
                tenantId: tenant,
                commandId: `cmd-accept-replay-${suffix}`,
                idempotencyKey,
                correlationId: `corr-accept-replay-${suffix}`,
                principalId: reviewer,
                deliverableId: requirementId,
                expectedVersion: 2,
                note: "approved",
                occurredAtUtc: "2026-09-04T02:00:00.000Z",
              })
            : new WaiveDeliverableHandler(replayPersistence).execute({
                tenantId: tenant,
                commandId: `cmd-waive-replay-${suffix}`,
                idempotencyKey,
                correlationId: `corr-waive-replay-${suffix}`,
                principalId: pm,
                deliverableId: requirementId,
                expectedVersion: 1,
                reason: "descoped",
                occurredAtUtc: "2026-09-04T02:00:00.000Z",
              });
          await assert.rejects(replay, (error: ApplicationError) => error.code === "DELIVERABLE_RECORD_CORRUPT");
        } finally {
          if (replayPersistence !== fixture.persistence) await replayPersistence.close();
          await fixture.cleanup();
        }
      }
    }
  }
});

// --------------------------------------------------------------------------
// R2F1 Finding 4: SQLite corruption fail-closed on reopen / row + schema corruption
// --------------------------------------------------------------------------
test("R2F1-4 (sqlite): v12 deliverable row and schema corruption fail closed on reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-dlv-corrupt-"));
  const path = join(directory, "corrupt.sqlite");
  try {
    // 1. Fresh v12 database with a clean deliverable row
    const bundle = createTestSqliteBundle({ path });
    await setupBaseProject(bundle.persistence);
    const initHandler = new InitializeDeliverableRequirementHandler(bundle.persistence);
    await initHandler.execute({
      tenantId: tenant,
      commandId: "cmd-init-corrupt",
      idempotencyKey: "idem-init-corrupt",
      correlationId: "corr-init-corrupt",
      principalId: pm,
      projectId,
      nodeId: subNodeId,
      deliverableId: "req-corrupt",
      requirementKey: "key-corrupt",
      title: "Corruption Fixture",
      required: true,
      acceptedSourceTypes: ["file"],
      minCount: 1,
      reviewerPrincipalId: reviewer,
      occurredAtUtc: "2026-09-04T00:00:00.000Z",
    });
    await bundle.persistence.close();

    // 2. Corrupt a single row: replace deliverable_json with malformed JSON
    const rawCorrupt = new DatabaseSync(path);
    rawCorrupt.prepare("UPDATE deliverable_requirements SET deliverable_json = 'not-json' WHERE tenant_id = ? AND deliverable_id = ?")
      .run(tenant, "req-corrupt");
    rawCorrupt.close();

    // Reopen + first authoritative read must fail closed on corrupt row
    const reopened = new SqlitePersistence({ path });
    await assert.rejects(
      reopened.read(tenant, async (tx) => tx.deliverables.get("req-corrupt")),
      /DELIVERABLE_RECORD_CORRUPT/,
      "Corrupt deliverable row must fail closed on authoritative read",
    );
    await reopened.close();

    // 3. Restore row, corrupt schema shape (drop CHECK constraint on a v12 table) and reopen
    const rawRestore = new DatabaseSync(path);
    rawRestore.exec(`
      PRAGMA foreign_keys=OFF;
      DROP TABLE deliverable_action_records;
      DROP TABLE deliverable_evidence_links;
      DROP TABLE deliverable_requirements;
      PRAGMA foreign_keys=ON;
      CREATE TABLE deliverable_requirements (
        tenant_id TEXT NOT NULL,
        deliverable_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        owner_node_id TEXT NOT NULL,
        security_domain_id TEXT,
        security_epoch INTEGER NOT NULL,
        requirement_key TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        deliverable_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, deliverable_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
        FOREIGN KEY (tenant_id, owner_node_id) REFERENCES project_nodes (tenant_id, node_id)
      ) STRICT;
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
      CREATE INDEX IF NOT EXISTS deliverable_requirements_by_node ON deliverable_requirements (tenant_id, owner_node_id, deliverable_id);
      CREATE INDEX IF NOT EXISTS deliverable_requirements_by_project ON deliverable_requirements (tenant_id, project_id, deliverable_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_deliverable_requirements_key ON deliverable_requirements (tenant_id, project_id, owner_node_id, requirement_key);
      CREATE INDEX IF NOT EXISTS deliverable_evidence_links_by_requirement ON deliverable_evidence_links (tenant_id, requirement_id, link_id);
      CREATE INDEX IF NOT EXISTS deliverable_actions_by_requirement ON deliverable_action_records (tenant_id, requirement_id, occurred_at_utc, action_id);
    `);
    rawRestore.close();

    assert.throws(
      () => new SqlitePersistence({ path }),
      /SQLITE_SCHEMA_INCOMPATIBLE: table deliverable_requirements missing CHECK \(security_epoch > 0\)/,
      "Reopen with missing CHECK constraint must fail closed",
    );

    // 4. R2F8 — two fresh child processes each run a real product submit with its own
    //    SqlitePersistence/pathLocks/DatabaseSync. A test-only method wrapper coordinates
    //    their actual handler write transactions immediately before the stale CAS UPDATE; it
    //    does not add a production hook, permission or bypass. Both transactions must read v1,
    //    remain physically identical through their real CAS attempt, and never restart between
    //    the barrier and UPDATE. The loser is only DELIVERABLE_VERSION_CONFLICT, and the six
    //    durable fact categories retain exactly one winner's facts.
    const dualDirectory = await mkdtemp(join(tmpdir(), "ppm-dlv-cas-dual-"));
    const dualPath = join(dualDirectory, "dual.sqlite");
    const readyFile = join(dualDirectory, "cas-ready");
    const conn1 = createTestSqliteBundle({ path: dualPath });
    await setupBaseProject(conn1.persistence);
    await new InitializeDeliverableRequirementHandler(conn1.persistence).execute({
      tenantId: tenant,
      commandId: "cmd-init-dual",
      idempotencyKey: "idem-init-dual",
      correlationId: "corr-init-dual",
      principalId: pm,
      projectId,
      nodeId: subNodeId,
      deliverableId: "req-dual",
      requirementKey: "key-dual",
      title: "Dual CAS",
      required: true,
      acceptedSourceTypes: ["file"],
      minCount: 1,
      reviewerPrincipalId: reviewer,
      occurredAtUtc: "2026-09-04T00:00:00.000Z",
    });
    const assetDual = "asset-dual";
    await conn1.persistence.transaction(tenant, async (tx) => {
      await tx.assets.insert({
        tenantId: tenant, id: assetDual, projectId, ownerNodeId: subNodeId, securityDomainId: null, securityEpoch: 1,
        uploaderPrincipalId: nodeLeader, displayName: "dual", contentType: "application/pdf", size: 1,
        sha256: "dual", lifecycleState: "available", failureCode: null, version: 1, deletedAtUtc: null,
      });
    });
    const sharedSubmitBase = {
      tenantId: tenant,
      principalId: nodeLeader,
      deliverableId: "req-dual",
      expectedVersion: 1,
      evidence: [{ sourceType: "file" as const, sourceId: assetDual }],
      occurredAtUtc: "2026-09-04T01:00:00.000Z",
    };
    // R2F8: both contenders are separate processes running the real submit handler. Test-layer
    // SQLite instrumentation lets both actual handler write transactions read v1, then blocks
    // each immediately before its real CAS UPDATE. Only after both update-boundary markers
    // report v1 does this parent release them. The loser attempts the same stale
    // `UPDATE ... WHERE version = 1` after the winner commits without ending/restarting its
    // transaction. Only the controlled test helper converts SQLite's 517 after a fresh read
    // proves the target requirement advanced from stale v1 to v2; the production adapter has
    // no BUSY_SNAPSHOT mapping. No pre-transaction stale object is accepted as evidence.
    const contender1 = runSubmitAtActualCasBarrier(dualPath, {
      ...sharedSubmitBase,
      commandId: "cmd-sub-dual-1",
      idempotencyKey: "idem-sub-dual-1",
      correlationId: "c1",
    }, readyFile);
    const contender2 = runSubmitAtActualCasBarrier(dualPath, {
      ...sharedSubmitBase,
      commandId: "cmd-sub-dual-2",
      idempotencyKey: "idem-sub-dual-2",
      correlationId: "c2",
    }, readyFile);
    await Promise.all([
      waitForActualCasContenderOpen(readyFile, "cmd-sub-dual-1"),
      waitForActualCasContenderOpen(readyFile, "cmd-sub-dual-2"),
    ]);
    writeActualCasStartMarker(readyFile);
    const [contender1Ready, contender2Ready] = await Promise.all([
      waitForActualCasReadyMarker(readyFile, "cmd-sub-dual-1"),
      waitForActualCasReadyMarker(readyFile, "cmd-sub-dual-2"),
    ]);
    assert.equal(contender1Ready.observedVersion, 1, "Contender 1 actual write transaction must hold stale v1 at CAS");
    assert.equal(contender2Ready.observedVersion, 1, "Contender 2 actual write transaction must hold stale v1 at CAS");
    assert.equal(writeCasReleaseMarker(readyFile), true, "Both actual stale CAS updates must be released together");
    const [outcome1, outcome2] = await Promise.all([contender1, contender2]);
    const [contender1Attempt, contender2Attempt] = await Promise.all([
      waitForActualCasAttemptMarker(readyFile, "cmd-sub-dual-1"),
      waitForActualCasAttemptMarker(readyFile, "cmd-sub-dual-2"),
    ]);
    assert.equal(
      contender1Attempt.readTransactionId,
      contender1Attempt.updateTransactionId,
      "Contender 1 must execute CAS in the same physical transaction that read stale v1",
    );
    assert.equal(
      contender2Attempt.readTransactionId,
      contender2Attempt.updateTransactionId,
      "Contender 2 must execute CAS in the same physical transaction that read stale v1",
    );
    assert.equal(contender1Attempt.readTransactionId, contender1Ready.readTransactionId);
    assert.equal(contender2Attempt.readTransactionId, contender2Ready.readTransactionId);
    const contender1IsWinner = outcome1.ok === true && outcome1.replayed === false;
    const contender2IsWinner = outcome2.ok === true && outcome2.replayed === false;
    assert.equal(
      Number(contender1IsWinner) + Number(contender2IsWinner),
      1,
      `Exactly one actual stale CAS contender must win: ${JSON.stringify([outcome1, outcome2])}`,
    );
    const loser = contender1IsWinner ? outcome2 : outcome1;
    assert.ok(
      loser.ok === false && loser.code === "DELIVERABLE_VERSION_CONFLICT",
      `Actual stale CAS loser must be only DELIVERABLE_VERSION_CONFLICT: ${JSON.stringify(loser)}`,
    );
    assert.deepEqual(
      loser.busySnapshotVersionProof,
      { staleVersion: 1, currentVersion: 2 },
      "Test-only 517 conversion requires a fresh post-rollback proof that the target advanced from stale v1",
    );

    // R2F5 Finding 2: precise fact uniqueness across all six durable categories — aggregate,
    // evidence, action, event, outbox and receipt — each must carry exactly the winner's
    // facts, with no duplicates in the shared database.
    const expectedWinner = {
      commandId: contender1IsWinner ? "cmd-sub-dual-1" : "cmd-sub-dual-2",
      principalId: nodeLeader,
      idempotencyKey: contender1IsWinner ? "idem-sub-dual-1" : "idem-sub-dual-2",
      eventId: contender1IsWinner ? "evt:cmd-sub-dual-1" : "evt:cmd-sub-dual-2",
      outboxId: contender1IsWinner ? "outbox:evt:cmd-sub-dual-1" : "outbox:evt:cmd-sub-dual-2",
    };
    await conn1.persistence.read(tenant, async (tx) => {
      // 1. Aggregate: the requirement advanced exactly once, to submitted at version 2.
      const req = await tx.deliverables.get("req-dual");
      assert.equal(req?.status, "submitted", "Aggregate must be in submitted status after the CAS race");
      assert.equal(req?.version, 2, "Aggregate version must be exactly 2 after the CAS race");
      // 2. Evidence: exactly one link, carrying the winner's submitted command identity.
      const links = await tx.deliverables.listEvidenceLinks("req-dual");
      assert.equal(links.length, 1, "Only one evidence link must exist after the CAS race");
      // 3. Action: exactly two actions total (init + submit); exactly one submitted action.
      const actions = await tx.deliverables.listActions("req-dual");
      assert.equal(actions.length, 2, "Exactly init + submit actions must exist after the CAS race");
      const submittedActions = actions.filter((a) => a.action === "submitted");
      assert.equal(submittedActions.length, 1, "Only one submitted action must exist after the CAS race");
      assert.deepEqual(
        submittedActions[0]?.evidenceIds,
        [assetDual],
        "The winner's submitted action must reference the single evidence asset",
      );
      // 4. Event: exactly one deliverable.submitted event, carrying the winner's command id.
      const allEvents = await tx.events.list(tenant);
      const submittedEvents = allEvents.filter((event) => event.eventType === "project-map.deliverable.submitted");
      assert.equal(submittedEvents.length, 1, "Exactly one submitted event must exist after the CAS race");
      assert.equal(
        submittedEvents[0]?.causationId,
        expectedWinner.commandId,
        "The submitted event must carry the winner's command identity",
      );
      // 5. Outbox: exactly one outbox message for the winner's event, no duplicate messages.
      const allOutbox = await tx.outbox.list(tenant);
      const submittedOutbox = allOutbox.filter((message) => message.eventId === expectedWinner.eventId);
      assert.equal(submittedOutbox.length, 1, "Exactly one outbox message must exist for the winner's event");
      assert.equal(submittedOutbox[0]?.id, expectedWinner.outboxId, "The outbox message must be the winner's");
      const duplicateEventIds = allOutbox
        .map((message) => message.eventId)
        .filter((eventId, index, all) => all.indexOf(eventId) !== index);
      assert.equal(duplicateEventIds.length, 0, "No duplicate outbox messages may exist after the CAS race");
      // 6. Receipt: exactly one command receipt for the winner's idempotency scope.
      const winnerReceipt = await tx.receipts.get<unknown>({
        principalId: expectedWinner.principalId,
        operation: "submit_deliverable_evidence",
        idempotencyKey: expectedWinner.idempotencyKey,
      });
      assert.notEqual(winnerReceipt, undefined, "The winner's command receipt must exist");
      const loserIdempotencyKey = contender1IsWinner ? "idem-sub-dual-2" : "idem-sub-dual-1";
      const loserReceipt = await tx.receipts.get<unknown>({
        principalId: expectedWinner.principalId,
        operation: "submit_deliverable_evidence",
        idempotencyKey: loserIdempotencyKey,
      });
      assert.equal(loserReceipt, undefined, "The loser's command receipt must not exist");
    });
    await conn1.persistence.close();
    await rm(dualDirectory, { recursive: true, force: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("R2F2-4/5 (sqlite): exact v12 schema validation, real v11 upgrade and v11 reader rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppm-dlv-v12-hardening-"));
  try {
    // R2F4 Finding 2: build the v11 fixture from the frozen, independent v11 schema.
    const v11Path = join(root, "real-v11.sqlite");
    const v11 = new DatabaseSync(v11Path);
    applyFrozenV11Schema(v11);
    assert.equal(v11.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()!.version, 11);
    assert.equal(v11.prepare("SELECT name FROM sqlite_master WHERE name = 'deliverable_requirements'").get(), undefined);
    v11.close();

    const upgraded = new SqlitePersistence({ path: v11Path });
    await upgraded.close();
    const upgradedRaw = new DatabaseSync(v11Path, { readOnly: true });
    assert.equal(upgradedRaw.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()!.version, 12);
    const evidenceIndexes = upgradedRaw.prepare("PRAGMA index_list(deliverable_evidence_links)").all() as Array<{ name: string; unique: number }>;
    assert.equal(evidenceIndexes.find((index) => index.name === "uq_deliverable_evidence_natural_key")?.unique, 1);
    upgradedRaw.close();

    // Old-reader rejection: execute the FROZEN base-v11 reader startup path (the actual
    // v11-generation SqlitePersistence open + assertSupportedSchema guard + fail-closed
    // close contract), not a newly written MAX(version)+throw substitute. The frozen reader
    // opens the v12 database, fails its guard with the v11-contract error, and closes the
    // handle fail-closed.
    assert.throws(
      () => new FrozenV11SqlitePersistenceReader({ path: v11Path }),
      /SQLITE_SCHEMA_VERSION_UNSUPPORTED:12/,
      "Frozen v11 reader startup path must reject the upgraded v12 database",
    );

    const corruptCurrentSchema = async (
      name: string,
      mutate: (database: DatabaseSync) => void,
      expected: RegExp,
    ): Promise<void> => {
      const path = join(root, `${name}.sqlite`);
      const current = new SqlitePersistence({ path });
      await current.close();
      const raw = new DatabaseSync(path);
      mutate(raw);
      raw.close();
      assert.throws(() => new SqlitePersistence({ path }), expected);
    };

    await corruptCurrentSchema("requirement-index-not-unique", (database) => database.exec(`
      DROP INDEX uq_deliverable_requirements_key;
      CREATE INDEX uq_deliverable_requirements_key
        ON deliverable_requirements (tenant_id, project_id, owner_node_id, requirement_key);
    `), /uq_deliverable_requirements_key uniqueness mismatch/);
    await corruptCurrentSchema("evidence-index-not-unique", (database) => database.exec(`
      DROP INDEX uq_deliverable_evidence_natural_key;
      CREATE INDEX uq_deliverable_evidence_natural_key
        ON deliverable_evidence_links (tenant_id, requirement_id, source_type, source_id);
    `), /uq_deliverable_evidence_natural_key uniqueness mismatch/);

    await corruptCurrentSchema("status-enum-expanded", (database) => database.exec(`
      PRAGMA foreign_keys=OFF;
      DROP TABLE deliverable_action_records;
      DROP TABLE deliverable_evidence_links;
      DROP TABLE deliverable_requirements;
      CREATE TABLE deliverable_requirements (
        tenant_id TEXT NOT NULL, deliverable_id TEXT NOT NULL, project_id TEXT NOT NULL,
        owner_node_id TEXT NOT NULL, security_domain_id TEXT,
        security_epoch INTEGER NOT NULL CHECK (security_epoch > 0), requirement_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'submitted', 'accepted', 'waived', 'evidence_due', 'extra')),
        version INTEGER NOT NULL CHECK (version > 0), deliverable_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, deliverable_id), FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
        FOREIGN KEY (tenant_id, owner_node_id) REFERENCES project_nodes (tenant_id, node_id)
      ) STRICT;
      CREATE INDEX deliverable_requirements_by_node ON deliverable_requirements (tenant_id, owner_node_id, deliverable_id);
      CREATE INDEX deliverable_requirements_by_project ON deliverable_requirements (tenant_id, project_id, deliverable_id);
      CREATE UNIQUE INDEX uq_deliverable_requirements_key ON deliverable_requirements (tenant_id, project_id, owner_node_id, requirement_key);
      CREATE TABLE deliverable_evidence_links (
        tenant_id TEXT NOT NULL, link_id TEXT NOT NULL, requirement_id TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('file', 'process_record')), source_id TEXT NOT NULL,
        submitted_by_principal_id TEXT NOT NULL, linked_at_utc TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0), PRIMARY KEY (tenant_id, link_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
        FOREIGN KEY (tenant_id, requirement_id) REFERENCES deliverable_requirements (tenant_id, deliverable_id)
      ) STRICT;
      CREATE INDEX deliverable_evidence_links_by_requirement ON deliverable_evidence_links (tenant_id, requirement_id, link_id);
      CREATE UNIQUE INDEX uq_deliverable_evidence_natural_key ON deliverable_evidence_links (tenant_id, requirement_id, source_type, source_id);
      CREATE TABLE deliverable_action_records (
        tenant_id TEXT NOT NULL, action_id TEXT NOT NULL, requirement_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('initialized', 'submitted', 'accepted', 'waived')),
        actor_principal_id TEXT NOT NULL, occurred_at_utc TEXT NOT NULL, reason TEXT,
        evidence_count INTEGER NOT NULL CHECK (evidence_count >= 0), evidence_ids_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, action_id), FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
        FOREIGN KEY (tenant_id, requirement_id) REFERENCES deliverable_requirements (tenant_id, deliverable_id)
      ) STRICT;
      CREATE INDEX deliverable_actions_by_requirement ON deliverable_action_records (tenant_id, requirement_id, occurred_at_utc, action_id);
      PRAGMA foreign_keys=ON;
    `), /status CHECK enum mismatch/);

    await corruptCurrentSchema("source-enum-expanded", (database) => database.exec(`
      DROP TABLE deliverable_evidence_links;
      CREATE TABLE deliverable_evidence_links (
        tenant_id TEXT NOT NULL, link_id TEXT NOT NULL, requirement_id TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('file', 'process_record', 'extra')), source_id TEXT NOT NULL,
        submitted_by_principal_id TEXT NOT NULL, linked_at_utc TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0), PRIMARY KEY (tenant_id, link_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
        FOREIGN KEY (tenant_id, requirement_id) REFERENCES deliverable_requirements (tenant_id, deliverable_id)
      ) STRICT;
      CREATE INDEX deliverable_evidence_links_by_requirement ON deliverable_evidence_links (tenant_id, requirement_id, link_id);
      CREATE UNIQUE INDEX uq_deliverable_evidence_natural_key ON deliverable_evidence_links (tenant_id, requirement_id, source_type, source_id);
    `), /source_type CHECK enum mismatch/);

    await corruptCurrentSchema("action-enum-expanded", (database) => database.exec(`
      DROP TABLE deliverable_action_records;
      CREATE TABLE deliverable_action_records (
        tenant_id TEXT NOT NULL, action_id TEXT NOT NULL, requirement_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('initialized', 'submitted', 'accepted', 'waived', 'extra')),
        actor_principal_id TEXT NOT NULL, occurred_at_utc TEXT NOT NULL, reason TEXT,
        evidence_count INTEGER NOT NULL CHECK (evidence_count >= 0), evidence_ids_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, action_id), FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
        FOREIGN KEY (tenant_id, requirement_id) REFERENCES deliverable_requirements (tenant_id, deliverable_id)
      ) STRICT;
      CREATE INDEX deliverable_actions_by_requirement ON deliverable_action_records (tenant_id, requirement_id, occurred_at_utc, action_id);
    `), /action CHECK enum mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// R2F3 Finding 2: v12 schema validator must reject partially weakened UNIQUE index
// --------------------------------------------------------------------------
test("R2F3-2 (sqlite): v12 schema validator rejects partial UNIQUE index on deliverable tables", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppm-dlv-r2f3-partial-idx-"));
  try {
    const rejectPartial = async (name: string, mutate: (db: DatabaseSync) => void, expected: RegExp): Promise<void> => {
      const path = join(root, `${name}.sqlite`);
      const initial = new SqlitePersistence({ path });
      await initial.close();
      const raw = new DatabaseSync(path);
      mutate(raw);
      raw.close();
      assert.throws(() => new SqlitePersistence({ path }), expected);
    };

    // uq_deliverable_requirements_key must not become partial (WHERE clause restricts it).
    await rejectPartial("req-partial-unique", (db) => {
      db.exec(`
        PRAGMA foreign_keys=OFF;
        DROP INDEX uq_deliverable_requirements_key;
        CREATE UNIQUE INDEX uq_deliverable_requirements_key
          ON deliverable_requirements (tenant_id, project_id, owner_node_id, requirement_key)
          WHERE status != 'waived';
        PRAGMA foreign_keys=ON;
      `);
    }, /uq_deliverable_requirements_key must cover the full table/);

    // uq_deliverable_evidence_natural_key must not become partial.
    await rejectPartial("evidence-partial-unique", (db) => {
      db.exec(`
        PRAGMA foreign_keys=OFF;
        DROP INDEX uq_deliverable_evidence_natural_key;
        CREATE UNIQUE INDEX uq_deliverable_evidence_natural_key
          ON deliverable_evidence_links (tenant_id, requirement_id, source_type, source_id)
          WHERE source_type = 'file';
        PRAGMA foreign_keys=ON;
      `);
    }, /uq_deliverable_evidence_natural_key must cover the full table/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// R2F1 Finding 5: Grant revoked/expired fail-closed on non-null domain submit + migration
// --------------------------------------------------------------------------
for (const backend of ["memory", "sqlite"] as const) {
  test(`R2F1-5 (${backend}): revoked/expired Grant on non-null Security Domain fails closed; deliverable migration keeps parity`, async () => {
    let trustedNow = new Date("2099-12-30T00:00:00.000Z");
    const fixture = await createFixture(backend, { now: () => trustedNow });
    try {
      await setupBaseProject(fixture.persistence);
      const secRoot = new CreateSecurityRootHandler(fixture.persistence);
      await secRoot.execute({
        tenantId: tenant,
        commandId: "cmd-sec-root-r5",
        idempotencyKey: "idem-sec-root-r5",
        correlationId: "corr-sec-root-r5",
        principalId: pm,
        projectId,
        nodeId: subNodeId,
        securityDomainId: dlvTenantGrantDomain,
        expectedNodeVersion: 2,
        reason: "R2F1 grant matrix",
        occurredAtUtc: "2026-09-04T07:00:00.000Z",
      });

      // Node leader only holds membership; create a view grant that is expired at authorization time
      const grantHandler = new ManageSecurityGrantHandler(fixture.persistence);
      const grantSet = await grantHandler.execute({
        tenantId: tenant,
        commandId: "cmd-grant-expired",
        idempotencyKey: "idem-grant-expired",
        correlationId: "corr-grant-expired",
        principalId: pm,
        projectId,
        securityDomainId: dlvTenantGrantDomain,
        targetPrincipalId: nodeLeader,
        action: "set",
        capability: "contribute",
        expiresAtUtc: "2099-12-31T00:00:00.000Z", // expired at the fixed persistence clock
        expectedGrantVersion: null,
        expectedDomainVersion: 1,
        reason: "expired grant fixture",
        occurredAtUtc: "2026-09-04T07:10:00.000Z",
      });
      trustedNow = new Date("2100-01-01T00:00:00.000Z");
      const initHandler = new InitializeDeliverableRequirementHandler(fixture.persistence);
      // Node leader cannot initialize (PM-only entry). Initialize as PM fails because the
      // reviewer does not hold a view grant in this domain (fail-closed REVOKE/expired matrix).
      await assert.rejects(
        initHandler.execute({
          tenantId: tenant,
          commandId: "cmd-init-expired",
          idempotencyKey: "idem-init-expired",
          correlationId: "corr-init-expired",
          principalId: nodeLeader,
          projectId,
          nodeId: subNodeId,
          deliverableId: "req-expired",
          requirementKey: "key-expired",
          title: "Expired Grant Domain",
          required: true,
          acceptedSourceTypes: ["file"],
          minCount: 1,
          reviewerPrincipalId: reviewer,
          occurredAtUtc: "2026-09-04T08:00:00.000Z",
        }),
        (err: ApplicationError) => err.code === "PM_ROLE_REQUIRED" || err.code === "NODE_NOT_FOUND",
      );

      // Grant the reviewer an active view grant so initialization succeeds, then PM initializes;
      // node leader submit still fails closed because the expired contribute grant does not count.
      await grantHandler.execute({
        tenantId: tenant,
        commandId: "cmd-grant-reviewer-view",
        idempotencyKey: "idem-grant-reviewer-view",
        correlationId: "corr-grant-reviewer-view",
        principalId: pm,
        projectId,
        securityDomainId: dlvTenantGrantDomain,
        targetPrincipalId: reviewer,
        action: "set",
        capability: "view",
        expiresAtUtc: null,
        expectedGrantVersion: null,
        expectedDomainVersion: grantSet.value.domainVersion,
        reason: "reviewer view grant",
        occurredAtUtc: "2026-09-04T08:05:00.000Z",
      });
      await initHandler.execute({
        tenantId: tenant,
        commandId: "cmd-init-pm-expired",
        idempotencyKey: "idem-init-pm-expired",
        correlationId: "corr-init-pm-expired",
        principalId: pm,
        projectId,
        nodeId: subNodeId,
        deliverableId: "req-pm-expired",
        requirementKey: "key-pm-expired",
        title: "PM Expired Grant Domain",
        required: true,
        acceptedSourceTypes: ["file"],
        minCount: 1,
        reviewerPrincipalId: reviewer,
        occurredAtUtc: "2026-09-04T08:00:00.000Z",
      });
      const submitHandler = new SubmitDeliverableEvidenceHandler(fixture.persistence);
      await insertAsset(fixture.persistence, { assetId: "asset-expired", ownerNodeId: subNodeId, securityDomainId: dlvTenantGrantDomain, securityEpoch: 2 });
      await assert.rejects(
        submitHandler.execute({
          tenantId: tenant,
          commandId: "cmd-submit-expired",
          idempotencyKey: "idem-submit-expired",
          correlationId: "corr-submit-expired",
          principalId: nodeLeader,
          deliverableId: "req-pm-expired",
          expectedVersion: 1,
          evidence: [{ sourceType: "file", sourceId: "asset-expired" }],
          occurredAtUtc: "2026-09-04T08:01:00.000Z",
        }),
        (err: ApplicationError) => err.code === "DELIVERABLE_NOT_FOUND" || err.code === "DELIVERABLE_SUBMISSION_FORBIDDEN",
      );

      // Migration parity: an active migration inventory keeps the deliverable in scope for v12 batches
      const plannedMigration: SecurityDomainMigration = {
        tenantId: tenant,
        id: "dlv-migration-verify",
        projectId,
        rootNodeId: subNodeId,
        sourceSecurityDomainId: dlvTenantGrantDomain,
        targetSecurityDomainId: "dlv-r5-target",
        hierarchyRevision: 1,
        sourceSecurityEpoch: 2,
        targetSecurityEpoch: 3,
        state: "planned",
        cursor: null,
        totalItems: 0,
        migratedItems: 0,
        failure: null,
        nextAttemptAtUtc: null,
        deadlineAtUtc: "2026-09-05T00:00:00.000Z",
        version: 1,
        createdAtUtc: "2026-09-04T08:30:00.000Z",
        updatedAtUtc: "2026-09-04T08:30:00.000Z",
      };
      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.securityMigrations.insert(plannedMigration);
        const active = transitionSecurityMigration(plannedMigration, "active", "2026-09-04T08:31:00.000Z");
        await tx.securityMigrations.saveProgressPreservingPlan(active.id, active, 1);
      });
      const reader = new SecurityMigrationInventoryReader(fixture.persistence);
      const inventory = await reader.build({
        tenantId: tenant,
        projectId,
        rootNodeId: subNodeId,
        sourceSecurityDomainId: dlvTenantGrantDomain,
        sourceSecurityEpoch: 2,
      });
      assert.ok(inventory.items.some((item) => item.kind === "deliverable" && item.id === "req-pm-expired"), "Deliverable must appear in the migration inventory");
      const dlvList = await fixture.persistence.read(tenant, async (tx) => tx.deliverables.listByProject(projectId));
      assert.ok(dlvList.some((item) => item.id === "req-pm-expired"), "Deliverable is readable for migration inventory in v12 schema");
    } finally {
      await fixture.cleanup();
    }
  });
}

// --------------------------------------------------------------------------
// R2F3 Finding 1: first accept must validate authoritative submission set before any write
// --------------------------------------------------------------------------
test("R2F3-1 (memory/sqlite): first accept fails closed when EvidenceLink is deleted or replaced before mutation", async () => {
  for (const backend of ["memory", "sqlite"] as const) {
    for (const tamper of ["delete-link", "replace-link"] as const) {
      const fixture = await createFixture(backend);
      let mutatorPersistence: Persistence = fixture.persistence;
      try {
        await setupBaseProject(fixture.persistence);
        const suffix = `${backend}-${tamper}`;
        await new InitializeDeliverableRequirementHandler(fixture.persistence).execute({
          tenantId: tenant,
          commandId: `cmd-init-r2f3-${suffix}`,
          idempotencyKey: `idem-init-r2f3-${suffix}`,
          correlationId: `corr-init-r2f3-${suffix}`,
          principalId: pm,
          projectId,
          nodeId: subNodeId,
          deliverableId: `req-r2f3-${suffix}`,
          requirementKey: `key-r2f3-${suffix}`,
          title: "R2F3 first accept guard",
          required: true,
          acceptedSourceTypes: ["file"],
          minCount: 1,
          reviewerPrincipalId: reviewer,
          occurredAtUtc: "2026-09-04T00:00:00.000Z",
        });
        await insertAsset(fixture.persistence, { assetId: `asset-r2f3-${suffix}`, ownerNodeId: subNodeId });
        await new SubmitDeliverableEvidenceHandler(fixture.persistence).execute({
          tenantId: tenant,
          commandId: `cmd-submit-r2f3-${suffix}`,
          idempotencyKey: `idem-submit-r2f3-${suffix}`,
          correlationId: `corr-submit-r2f3-${suffix}`,
          principalId: nodeLeader,
          deliverableId: `req-r2f3-${suffix}`,
          expectedVersion: 1,
          evidence: [{ sourceType: "file", sourceId: `asset-r2f3-${suffix}` }],
          occurredAtUtc: "2026-09-04T01:00:00.000Z",
        });

        // Baseline: count facts before the failed accept so the zero-residue assertions are
        // relative to this command's identity, not to an untouched fixture.
        const preResidue = await fixture.persistence.read(tenant, async (tx) => {
          return {
            events: (await tx.events.list(tenant)).filter((event) => event.causationId === `cmd-accept-r2f3-${suffix}`).length,
            outbox: (await tx.outbox.list(tenant)).filter((message) => message.eventId === `evt:cmd-accept-r2f3-${suffix}`).length,
          };
        });
        assert.equal(preResidue.events, 0, "No accept event may exist before the failed accept");
        assert.equal(preResidue.outbox, 0, "No accept outbox message may exist before the failed accept");

        // Tamper with the EvidenceLink before first accept.
        if (backend === "memory") {
          const snapshot = (fixture.persistence as MemoryPersistence).snapshot();
          const linkId = `link:req-r2f3-${suffix}:file:asset-r2f3-${suffix}`;
          const linkKey = `${tenant}\u0000${linkId}`;
          if (tamper === "delete-link") {
            snapshot.evidenceLinks.delete(linkKey);
          } else {
            const link = snapshot.evidenceLinks.get(linkKey)!;
            snapshot.evidenceLinks.delete(linkKey);
            snapshot.evidenceLinks.set(`${tenant}\u0000tampered:${linkId}`, {
              ...link,
              id: `tampered:${linkId}`,
              sourceId: `asset-r2f3-${suffix}-tampered`,
            });
          }
          mutatorPersistence = new MemoryPersistence({ snapshot });
        } else if (backend === "sqlite") {
          const raw = new DatabaseSync(fixture.path!);
          if (tamper === "delete-link") {
            raw.prepare("DELETE FROM deliverable_evidence_links WHERE link_id = ?")
              .run(`link:req-r2f3-${suffix}:file:asset-r2f3-${suffix}`);
          } else {
            // Equal-count replacement: keep exactly one link but with a tampered source.
            raw.prepare(
              "UPDATE deliverable_evidence_links SET link_id = ?, source_id = ? WHERE requirement_id = ?",
            ).run(
              `link:req-r2f3-${suffix}:file:asset-r2f3-${suffix}-tampered`,
              `asset-r2f3-${suffix}-tampered`,
              `req-r2f3-${suffix}`,
            );
          }
          raw.close();
        }

        // R2F6 Finding 4: capture the complete post-tamper baseline (links, actions, events,
        // outbox, receipts — full record sets, no projection) on the mutator backend before
        // the accept attempt; the post-failure state must deepEqual this baseline exactly.
        const postTamperBaseline: DeliverableRecordSnapshot = await captureSnapshot(mutatorPersistence, {
          tenantId: tenant,
          requirementId: `req-r2f3-${suffix}`,
          path: backend === "sqlite" ? fixture.path : undefined,
        });

        const acceptCommand = {
          tenantId: tenant,
          commandId: `cmd-accept-r2f3-${suffix}`,
          idempotencyKey: `idem-accept-r2f3-${suffix}`,
          correlationId: `corr-accept-r2f3-${suffix}`,
          principalId: reviewer,
          deliverableId: `req-r2f3-${suffix}`,
          expectedVersion: 2,
          note: "first accept after tamper",
          occurredAtUtc: "2026-09-04T02:00:00.000Z",
        };
        await assert.rejects(
          new AcceptDeliverableHandler(mutatorPersistence).execute(acceptCommand),
          (err: ApplicationError) =>
            err.code === "DELIVERABLE_RECORD_CORRUPT"
            || err.code === "EVIDENCE_NOT_FOUND",
        );
        // R2F6 Finding 4: after tampering and before the accept, the complete record-set
        // baseline (links/actions/events/outbox/receipts) was captured on the actual mutator
        // backend. After the failed accept, deepEqual the FULL record set against that
        // baseline — no field projection, no targeted ID filtering.
        const afterSnapshot = await captureSnapshot(mutatorPersistence, {
          tenantId: tenant,
          requirementId: `req-r2f3-${suffix}`,
          path: backend === "sqlite" ? fixture.path : undefined,
        });
        assertNoRecordResidue(
          postTamperBaseline,
          afterSnapshot,
          "Failed first accept must leave the complete links/actions/events/outbox/receipt record set unchanged",
        );
      } finally {
        if (mutatorPersistence !== fixture.persistence) await mutatorPersistence.close();
        await fixture.cleanup();
      }
    }
  }
});

test("R2F3-4 (sqlite): realistic v11 fixture with full data upgrades to v12, reopens and rejects old reader", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppm-dlv-r2f3-v11-full-"));
  const v11Path = join(root, "r2f3-full-v11.sqlite");
  const v11Tenant = "t-r2f3" as TenantId;
  const v11ProjectId = "p-r2f3";
  const v11NodeId = "n-r2f3";
  const v11Pm = "pm-r2f3" as PrincipalId;
  const v11Reviewer = "rev-r2f3" as PrincipalId;
  try {
    // Build the fixture from the frozen v11 schema only (no current-adapter involvement).
    const frozenV11 = new DatabaseSync(v11Path);
    applyFrozenV11Schema(frozenV11);
    const maxV11 = frozenV11.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number };
    assert.equal(maxV11.v, 11, "frozen v11 fixture must have max schema version 11");
    const hasDeliverableTable = frozenV11.prepare("SELECT 1 FROM sqlite_master WHERE name = 'deliverable_requirements'").get();
    assert.equal(hasDeliverableTable, undefined, "v11 fixture must not have deliverable_requirements table");
    // Seed representative v11 data directly into the frozen-schema database.
    const seedTime = "2026-09-04T00:00:00.000Z";
    frozenV11.prepare(
      "INSERT INTO tenants (tenant_id, state, created_at_utc) VALUES (?, 'active', ?)",
    ).run(v11Tenant, seedTime);
    const insertPrincipal = frozenV11.prepare(
      "INSERT INTO principals (tenant_id, principal_id, kind, state, version, created_at_utc, updated_at_utc) VALUES (?, ?, 'user', 'active', 1, ?, ?)",
    );
    for (const principalId of [v11Pm, v11Reviewer]) {
      insertPrincipal.run(v11Tenant, principalId, seedTime, seedTime);
    }
    const insertMembership = frozenV11.prepare(
      "INSERT INTO project_memberships (tenant_id, project_id, principal_id, role, status, version, membership_json) VALUES (?, ?, ?, ?, 'active', 1, ?)",
    );
    for (const [principalId, role] of [
      [v11Pm, "project_manager"],
      [v11Reviewer, "member"],
    ] as Array<[string, string]>) {
      insertMembership.run(v11Tenant, v11ProjectId, principalId, role, JSON.stringify({
        tenantId: v11Tenant, projectId: v11ProjectId, principalId, role, status: "active",
        securityDomainIds: [], version: 1,
        createdAtUtc: seedTime, updatedAtUtc: seedTime,
      }));
    }
    const insertNode = frozenV11.prepare(
      "INSERT INTO project_nodes (tenant_id, node_id, project_id, parent_node_id, leader_principal_id, title, kind, security_domain_id, security_epoch, version, deleted_at_utc) VALUES (?, ?, ?, ?, ?, ?, 'stage', ?, 1, 1, NULL)",
    );
    insertNode.run(v11Tenant, v11NodeId, v11ProjectId, null, v11Reviewer, "Root", null);
    const insertAsset = frozenV11.prepare(
      "INSERT INTO assets (tenant_id, asset_id, project_id, owner_node_id, lifecycle_state, version, asset_json) VALUES (?, ?, ?, ?, 'available', 1, ?)",
    );
    insertAsset.run(v11Tenant, "a-r2f3", v11ProjectId, v11NodeId, JSON.stringify({
      tenantId: v11Tenant, id: "a-r2f3", projectId: v11ProjectId, ownerNodeId: v11NodeId,
      securityDomainId: null, securityEpoch: 1, uploaderPrincipalId: v11Reviewer,
      displayName: "file.pdf", contentType: "application/pdf", size: 1024, sha256: "sha-r2f3",
      lifecycleState: "available", failureCode: null, version: 1, deletedAtUtc: null,
    }));
    frozenV11.close();

    // Upgrade path: opening with the current adapter must auto-upgrade v11 -> v12 and preserve all v11 data.
    const upgraded = createTestSqliteBundle({ path: v11Path });
    try {
      const v11Data = await upgraded.persistence.read(v11Tenant, async (tx) => {
        const node = await tx.nodes.get(v11NodeId);
        const asset = await tx.assets.get("a-r2f3");
        return { node: node ?? null, asset: asset ?? null };
      });
      assert.equal(v11Data.node?.id, v11NodeId, "v11 node data must survive the upgrade");
      assert.equal(v11Data.asset?.id, "a-r2f3", "v11 asset data must survive the upgrade");
      assert.equal(v11Data.asset?.displayName, "file.pdf", "v11 asset display name must be preserved");

      // Now insert a full deliverable scenario through the application handlers.
      await new InitializeDeliverableRequirementHandler(upgraded.persistence).execute({
        tenantId: v11Tenant,
        commandId: "cmd-init-r2f3-v12",
        idempotencyKey: "idem-init-r2f3-v12",
        correlationId: "corr-init-r2f3-v12",
        principalId: v11Pm,
        projectId: v11ProjectId,
        nodeId: v11NodeId,
        deliverableId: "dr-r2f3",
        requirementKey: "rk-r2f3",
        title: "R2F3 deliverable",
        required: true,
        acceptedSourceTypes: ["file"],
        minCount: 1,
        reviewerPrincipalId: v11Reviewer,
        occurredAtUtc: "2026-09-04T00:00:00.000Z",
      });
      const submitResult = await new SubmitDeliverableEvidenceHandler(upgraded.persistence).execute({
        tenantId: v11Tenant,
        commandId: "cmd-submit-r2f3-v12",
        idempotencyKey: "idem-submit-r2f3-v12",
        correlationId: "corr-submit-r2f3-v12",
        principalId: v11Reviewer,
        deliverableId: "dr-r2f3",
        expectedVersion: 1,
        evidence: [{ sourceType: "file", sourceId: "a-r2f3" }],
        occurredAtUtc: "2026-09-04T01:00:00.000Z",
      });
      assert.equal(submitResult.value.status, "submitted", "Deliverable must be submitted after upgrade");
    } finally {
      await upgraded.persistence.close();
    }

    // Re-open the upgraded database through the current adapter: all data (v11 originals + new
    // v12 deliverable facts) must be readable.
    const reopened = createTestSqliteBundle({ path: v11Path });
    try {
      const data = await reopened.persistence.read(v11Tenant, async (tx) => {
        const req = await tx.deliverables.get("dr-r2f3");
        const asset = await tx.assets.get("a-r2f3");
        const node = await tx.nodes.get(v11NodeId);
        return {
          req: req ?? null,
          asset: asset ?? null,
          node: node ?? null,
          links: req ? await tx.deliverables.listEvidenceLinks(req.id) : [],
          actions: req ? await tx.deliverables.listActions(req.id) : [],
        };
      });
      assert.equal(data.req?.status, "submitted", "Re-opened database must have the deliverable in submitted state");
      assert.equal(data.asset?.id, "a-r2f3", "Re-opened asset must be preserved");
      assert.equal(data.node?.id, v11NodeId, "Re-opened node must be preserved");
      assert.equal(data.links.length, 1, "Re-opened evidence link count must be 1");
      assert.equal(data.actions.length, 2, "Re-opened action count must be 2 (init + submit)");
      assert.equal(data.links[0]!.sourceId, "a-r2f3", "Evidence link must reference the v11 asset");
    } finally {
      await reopened.persistence.close();
    }

    // Old-reader rejection: execute the FROZEN base-v11 reader startup path (the actual
    // v11-generation SqlitePersistence open + assertSupportedSchema guard + fail-closed
    // close contract), not a test-local MAX(version)+manual-throw substitute.
    assert.throws(
      () => new FrozenV11SqlitePersistenceReader({ path: v11Path }),
      /SQLITE_SCHEMA_VERSION_UNSUPPORTED:12/,
      "Frozen v11 reader startup path must reject the upgraded v12 database",
    );

    // Verify the v12 deliverable tables have the correct schema shape (full v12 validator checks pass)
    const verifyV12 = new SqlitePersistence({ path: v11Path });
    await verifyV12.close();
    const rawVerify = new DatabaseSync(v11Path, { readOnly: true });
    const evidenceIndexes = rawVerify.prepare("PRAGMA index_list(deliverable_evidence_links)").all() as Array<{ name: string; unique: number; partial: number }>;
    const naturalKey = evidenceIndexes.find((index) => index.name === "uq_deliverable_evidence_natural_key");
    assert.equal(naturalKey?.unique, 1, "v12 evidence natural key index must be UNIQUE");
    assert.equal(naturalKey?.partial, 0, "v12 evidence natural key index must not be partial");
    rawVerify.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
