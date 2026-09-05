import assert from "node:assert/strict";
import test from "node:test";
import { assertAssetDownloadable, transitionAsset, type Asset } from "../packages/domain/src/assets.ts";
import { principalId, tenantId } from "../packages/domain/src/identity.ts";
import { advanceIntegrationOperation, type IntegrationOperation } from "../packages/domain/src/integration-operations.ts";
import {
  checkpointSecurityMigration,
  effectiveSecurityDomains,
  transitionSecurityMigration,
  type SecurityDomainMigration,
} from "../packages/domain/src/security-migration.ts";
import { grantAllows, type SecurityGrant } from "../packages/domain/src/security-access.ts";
import {
  acceptTask,
  assignTaskAssignee,
  assignTaskReviewer,
  cancelTask,
  completeTaskWithoutReview,
  promoteTask,
  rejectTask,
  startTask,
  submitTask,
  taskLifecycle,
  withdrawTask,
  type ProductTask,
} from "../packages/domain/src/tasks.ts";

const tenant = tenantId("tenant-1");
const principal = principalId("principal-1");

function task(requiresAcceptance = true): ProductTask {
  return {
    tenantId: tenant,
    id: "task-1",
    projectId: "project-1",
    ownerNodeId: "node-1",
    securityDomainId: "domain-1",
    securityEpoch: 1,
    title: "提交方案",
    assigneePrincipalId: principal,
    requiresAcceptance,
    reviewerPrincipalId: requiresAcceptance ? principal : null,
    executionState: "todo",
    reviewState: requiresAcceptance ? "not_submitted" : "not_required",
    version: 1,
    deletedAtUtc: null,
  };
}

test("ARCH-GATE-TASK-001 reviewed Task requires submit and accept before completion", () => {
  const started = startTask(task());
  const submitted = submitTask(started);
  assert.equal(taskLifecycle(submitted), "pending_review");
  assert.throws(() => completeTaskWithoutReview(submitted), /TASK_DIRECT_COMPLETE_FORBIDDEN/);
  const accepted = acceptTask(submitted);
  assert.equal(taskLifecycle(accepted), "completed");
  assert.equal(accepted.version, 4);
});

test("ARCH-GATE-TASK-002 rejection and withdrawal remain auditable intermediate states and allow resubmission", () => {
  const submitted = submitTask(startTask(task()));
  const rejected = rejectTask(submitted);
  assert.equal(taskLifecycle(rejected), "in_progress");
  assert.equal(taskLifecycle(submitTask(rejected)), "pending_review");

  const withdrawn = withdrawTask(submitted);
  assert.equal(taskLifecycle(withdrawn), "in_progress");
  assert.equal(taskLifecycle(submitTask(withdrawn)), "pending_review");
});

test("ARCH-GATE-TASK-003 non-reviewed Task can complete directly but cannot enter review", () => {
  const started = startTask(task(false));
  assert.throws(() => submitTask(started), /TASK_REVIEW_NOT_REQUIRED/);
  assert.equal(taskLifecycle(completeTaskWithoutReview(started)), "completed");
});

test("P0-05A-T1a assignee and reviewer changes are versioned and freeze while review is pending", () => {
  const other = principalId("principal-2");
  const reassigned = assignTaskAssignee(task(), other);
  assert.equal(reassigned.assigneePrincipalId, other);
  const rereviewed = assignTaskReviewer(reassigned, other);
  assert.equal(rereviewed.reviewerPrincipalId, other);
  const pending = submitTask(startTask(rereviewed));
  assert.throws(() => assignTaskAssignee(pending, principal), /TASK_ASSIGNEE_LOCKED_DURING_REVIEW/);
  assert.throws(() => assignTaskReviewer(pending, principal), /TASK_REVIEWER_LOCKED_DURING_REVIEW/);
});

test("ARCH-GATE-TASK-006 cancellation and promotion have explicit terminal transitions", () => {
  assert.equal(taskLifecycle(cancelTask(task())), "canceled");
  assert.throws(() => cancelTask(submitTask(startTask(task()))), /TASK_PENDING_REVIEW_CANNOT_CANCEL/);
  assert.throws(() => promoteTask(startTask(task(false))), /TASK_PROMOTE_TRANSITION_INVALID/);
  const accepted = acceptTask(submitTask(startTask(task())));
  assert.equal(taskLifecycle(promoteTask(accepted)), "promoted");
});

test("ARCH-GATE-INTEGRATION-001 operation state cannot bypass running or leave a terminal state", () => {
  const planned: IntegrationOperation = {
    tenantId: tenant,
    id: "operation-1",
    operationType: "collaboration.task.project",
    subjectType: "task",
    subjectId: "task-1",
    fingerprint: "fingerprint",
    state: "planned",
    currentStep: "create_task",
    attempts: 0,
    externalRequestId: "request-1",
    externalReference: null,
    expectedSyncWatermark: null,
    nextAttemptAtUtc: null,
    deadlineAtUtc: "2026-09-04T01:00:00.000Z",
    lastError: null,
    version: 1,
    createdAtUtc: "2026-09-04T00:00:00.000Z",
    updatedAtUtc: "2026-09-04T00:00:00.000Z",
  };
  assert.throws(() => advanceIntegrationOperation(planned, {
    state: "completed",
    currentStep: "task_created",
    occurredAtUtc: "2026-09-04T00:01:00.000Z",
  }), /TRANSITION_INVALID/);
  const running = advanceIntegrationOperation(planned, {
    state: "running",
    currentStep: "create_task",
    occurredAtUtc: "2026-09-04T00:01:00.000Z",
  });
  const completed = advanceIntegrationOperation(running, {
    state: "completed",
    currentStep: "task_created",
    occurredAtUtc: "2026-09-04T00:02:00.000Z",
  });
  assert.throws(() => advanceIntegrationOperation(completed, {
    state: "retryable",
    currentStep: "create_task",
    occurredAtUtc: "2026-09-04T00:03:00.000Z",
    lastError: "late error",
  }), /IS_TERMINAL/);
});

function asset(): Asset {
  return {
    tenantId: tenant,
    id: "asset-1",
    projectId: "project-1",
    ownerNodeId: "node-1",
    securityDomainId: "domain-1",
    securityEpoch: 1,
    uploaderPrincipalId: principal,
    displayName: "方案.pdf",
    contentType: "application/pdf",
    size: 100,
    sha256: "a".repeat(64),
    lifecycleState: "initiated",
    failureCode: null,
    version: 1,
    deletedAtUtc: null,
  };
}

test("ARCH-GATE-ASSET-001 Asset lifecycle rejects download until scanning succeeds", () => {
  const uploading = transitionAsset(asset(), "uploading");
  const scanning = transitionAsset(uploading, "scanning");
  assert.throws(() => assertAssetDownloadable(scanning), /ASSET_NOT_AVAILABLE/);
  const available = transitionAsset(scanning, "available");
  assert.doesNotThrow(() => assertAssetDownloadable(available));
  const deleted = transitionAsset(available, "deleted", { occurredAtUtc: "2026-09-04T00:00:00.000Z" });
  assert.throws(() => assertAssetDownloadable(deleted), /ASSET_NOT_AVAILABLE/);
  assert.equal(deleted.deletedAtUtc, "2026-09-04T00:00:00.000Z");
});

test("ARCH-GATE-ASSET-002 failed upload can retry but cannot skip scanning", () => {
  const failed = transitionAsset(transitionAsset(asset(), "uploading"), "failed", { failureCode: "STORAGE_TIMEOUT" });
  assert.equal(failed.failureCode, "STORAGE_TIMEOUT");
  assert.equal(transitionAsset(failed, "uploading").failureCode, null);
  assert.throws(() => transitionAsset(asset(), "available"), /ASSET_TRANSITION_INVALID/);
});

function migration(): SecurityDomainMigration {
  return {
    tenantId: tenant,
    id: "migration-1",
    projectId: "project-1",
    rootNodeId: "node-1",
    sourceSecurityDomainId: "domain-old",
    targetSecurityDomainId: "domain-new",
    hierarchyRevision: 7,
    sourceSecurityEpoch: 3,
    targetSecurityEpoch: 4,
    state: "planned",
    cursor: null,
    totalItems: 10,
    migratedItems: 0,
    failure: null,
    nextAttemptAtUtc: null,
    deadlineAtUtc: "2026-09-04T01:00:00.000Z",
    version: 1,
    createdAtUtc: "2026-09-04T00:00:00.000Z",
    updatedAtUtc: "2026-09-04T00:00:00.000Z",
  };
}

test("ARCH-GATE-SECURITY-001 active and failed migration keeps old/new permission intersection until commit", () => {
  const active = transitionSecurityMigration(migration(), "active", "2026-09-04T00:01:00.000Z");
  assert.deepEqual(effectiveSecurityDomains(active), ["domain-old", "domain-new"]);
  const checkpoint = checkpointSecurityMigration(active, { cursor: "node-5", migratedItems: 5, occurredAtUtc: "2026-09-04T00:02:00.000Z" });
  const retryable = transitionSecurityMigration(checkpoint, "retryable", "2026-09-04T00:03:00.000Z", "projection lag");
  assert.deepEqual(effectiveSecurityDomains(retryable), ["domain-old", "domain-new"]);
  const resumed = transitionSecurityMigration(retryable, "verifying", "2026-09-04T00:04:00.000Z");
  const committed = transitionSecurityMigration(resumed, "committed", "2026-09-04T00:05:00.000Z");
  assert.deepEqual(effectiveSecurityDomains(committed), ["domain-new"]);
  assert.throws(() => transitionSecurityMigration(committed, "active", "2026-09-04T00:06:00.000Z"), /TRANSITION_INVALID/);
});

test("TC-SEC-001 an expired or malformed Grant timestamp fails closed", () => {
  const grant: SecurityGrant = {
    tenantId: tenant,
    id: "grant-1",
    securityDomainId: "domain-1",
    principalId: principal,
    capability: "manage_access",
    status: "active",
    expiresAtUtc: "2026-09-04T00:05:00.000Z",
    grantedByPrincipalId: principal,
    reason: "temporary access",
    version: 1,
    createdAtUtc: "2026-09-04T00:00:00.000Z",
    updatedAtUtc: "2026-09-04T00:00:00.000Z",
  };
  assert.equal(grantAllows(grant, "view", "2026-09-04T00:04:59.999Z"), true);
  assert.equal(grantAllows(grant, "view", "2026-09-04T00:05:00.000Z"), false);
  assert.equal(grantAllows(grant, "view", "not-a-time"), false);
  assert.equal(grantAllows({ ...grant, expiresAtUtc: "not-a-time" }, "view", "2026-09-04T00:01:00.000Z"), false);
  assert.equal(grantAllows({ ...grant, expiresAtUtc: "2026-02-30T00:00:00.000Z" }, "view", "2026-02-01T00:00:00.000Z"), false);
});
