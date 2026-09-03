import assert from "node:assert/strict";
import test from "node:test";
import { assertAssetDownloadable, transitionAsset, type Asset } from "../packages/domain/src/assets.ts";
import { principalId, tenantId } from "../packages/domain/src/identity.ts";
import {
  effectiveSecurityDomains,
  transitionSecurityMigration,
  type SecurityDomainMigration,
} from "../packages/domain/src/security-migration.ts";
import {
  acceptTask,
  completeTaskWithoutReview,
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
    version: 1,
  };
}

test("ARCH-GATE-SECURITY-001 active and failed migration keeps old/new permission intersection until commit", () => {
  const active = transitionSecurityMigration(migration(), "active");
  assert.deepEqual(effectiveSecurityDomains(active), ["domain-old", "domain-new"]);
  const retryable = transitionSecurityMigration(active, "retryable", "projection lag");
  assert.deepEqual(effectiveSecurityDomains(retryable), ["domain-old", "domain-new"]);
  const resumed = transitionSecurityMigration(retryable, "verifying");
  const committed = transitionSecurityMigration(resumed, "committed");
  assert.deepEqual(effectiveSecurityDomains(committed), ["domain-new"]);
  assert.throws(() => transitionSecurityMigration(committed, "active"), /TRANSITION_INVALID/);
});

