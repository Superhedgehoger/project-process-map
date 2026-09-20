import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeCreateNode } from "../packages/application/src/create-node.ts";
import { ApplicationError, type ApplicationErrorCode } from "../packages/application/src/errors.ts";
import type { OutboxConsumer, Persistence } from "../packages/application/src/ports/persistence.ts";
import { CreateSecurityRootHandler } from "../packages/application/src/security/create-security-root.ts";
import { ManageSecurityGrantHandler } from "../packages/application/src/security/manage-security-grant.ts";
import { ActOnTaskHandler } from "../packages/application/src/tasks/act-on-task.ts";
import { CreateTaskHandler, type CreateTaskCommand } from "../packages/application/src/tasks/create-task.ts";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import { principalId, tenantId, type PrincipalId, type TenantId } from "../packages/domain/src/identity.ts";
import type { SecurityCapability } from "../packages/domain/src/security-access.ts";
import { transitionSecurityMigration, type SecurityDomainMigration } from "../packages/domain/src/security-migration.ts";
import { grantProjectMembership } from "./support/project-membership.ts";

const tenant = tenantId("tenant-reviewer-res");
const manager = principalId("manager-user");
const explicitUser = principalId("explicit-user");
const candidateA = principalId("cand-a-user");
const candidateB = principalId("cand-b-user");
const candidateC = principalId("cand-c-user");
const nodeLeader = principalId("leader-user");
const outsider = principalId("outsider-user");

type Fixture = Readonly<{
  name: string;
  persistence: Persistence;
  outbox: OutboxConsumer;
  path?: string;
  cleanup(): Promise<void>;
}>;

async function fixtures(): Promise<Fixture[]> {
  const directory = await mkdtemp(join(tmpdir(), "ppm-reviewer-res-"));
  const memory = new MemoryPersistence();
  const sqlitePath = join(directory, "review-res.sqlite");
  const sqlite = new SqlitePersistence({ path: sqlitePath });
  return [
    {
      name: "memory",
      persistence: memory,
      outbox: memory.outboxConsumer,
      cleanup: async () => await memory.close(),
    },
    {
      name: "sqlite",
      persistence: sqlite,
      outbox: sqlite.outboxConsumer,
      path: sqlitePath,
      cleanup: async () => {
        await sqlite.close();
        await rm(directory, { recursive: true, force: true });
      },
    },
  ];
}

function errorCode(expected: ApplicationErrorCode): (error: unknown) => boolean {
  return (error: unknown) => error instanceof ApplicationError && error.code === expected;
}

let grantSeq = 0;

async function grantCapability(
  persistence: Persistence,
  domainId: string,
  targetPrincipalId: PrincipalId,
  capability: SecurityCapability,
  expiresAtUtc: string | null = null,
) {
  const domain = await persistence.read(tenant, async (tx) => tx.securityDomains.get(domainId));
  assert.ok(domain);
  const existingGrant = await persistence.read(tenant, async (tx) => tx.securityGrants.get(domainId, targetPrincipalId));
  const handler = new ManageSecurityGrantHandler(persistence);
  await handler.execute({
    tenantId: tenant,
    commandId: `cmd-grant-${domainId}-${targetPrincipalId}-${++grantSeq}`,
    idempotencyKey: `idem-grant-${domainId}-${targetPrincipalId}-${grantSeq}`,
    correlationId: "corr-grant",
    principalId: manager,
    projectId: "proj-1",
    securityDomainId: domainId,
    targetPrincipalId,
    action: "set",
    capability,
    expiresAtUtc,
    expectedGrantVersion: existingGrant?.version ?? null,
    expectedDomainVersion: domain.version,
    reason: "test grant capability",
    occurredAtUtc: "2026-09-20T10:02:00.000Z",
  });
}

async function revokeCapability(
  persistence: Persistence,
  domainId: string,
  targetPrincipalId: PrincipalId,
) {
  const domain = await persistence.read(tenant, async (tx) => tx.securityDomains.get(domainId));
  assert.ok(domain);
  const existingGrant = await persistence.read(tenant, async (tx) => tx.securityGrants.get(domainId, targetPrincipalId));
  assert.ok(existingGrant);
  const handler = new ManageSecurityGrantHandler(persistence);
  await handler.execute({
    tenantId: tenant,
    commandId: `cmd-revoke-${domainId}-${targetPrincipalId}-${++grantSeq}`,
    idempotencyKey: `idem-revoke-${domainId}-${targetPrincipalId}-${grantSeq}`,
    correlationId: "corr-revoke",
    principalId: manager,
    projectId: "proj-1",
    securityDomainId: domainId,
    targetPrincipalId,
    action: "revoke",
    capability: null,
    expiresAtUtc: null,
    expectedGrantVersion: existingGrant.version,
    expectedDomainVersion: domain.version,
    reason: "test revoke capability",
    occurredAtUtc: "2026-09-20T10:03:00.000Z",
  });
}

async function setupBaseline(
  persistence: Persistence,
  tTenant: TenantId,
  projectId = "proj-1",
  nodeId = "node-1",
  leaderId: PrincipalId | null = null,
) {
  // Setup manager
  await grantProjectMembership(persistence, tTenant, projectId, manager, { role: "project_manager" });

  // Setup ordinary members
  await grantProjectMembership(persistence, tTenant, projectId, explicitUser);
  await grantProjectMembership(persistence, tTenant, projectId, candidateA);
  await grantProjectMembership(persistence, tTenant, projectId, candidateB);
  await grantProjectMembership(persistence, tTenant, projectId, candidateC);
  if (leaderId !== null) {
    await grantProjectMembership(persistence, tTenant, projectId, leaderId);
  }

  // Create node (with optional leader)
  await executeCreateNode(persistence, {
    tenantId: tTenant,
    commandId: `cmd-create-node-${nodeId}`,
    idempotencyKey: `idem-create-node-${nodeId}`,
    correlationId: "corr-setup",
    principalId: manager,
    projectId,
    nodeId,
    parentId: null,
    title: "Root Node",
    leaderPrincipalId: leaderId,
    securityDomainId: null,
    occurredAtUtc: "2026-09-20T10:00:00.000Z",
  });
}

async function initializeSlotsAndBindings(
  persistence: Persistence,
  tTenant: TenantId,
  projectId = "proj-1",
  slotKey = "reviewer_qa",
  candidates: readonly PrincipalId[] = [candidateB, candidateA, candidateC],
) {
  await persistence.executeInitializeProjectRoleSlots({
    tenantId: tTenant,
    commandId: `cmd-init-slots-${slotKey}`,
    idempotencyKey: `idem-init-slots-${slotKey}`,
    principalId: manager,
    projectId,
    sourceTemplateVersionId: "tpl-v1",
    slots: [
      { slotKey, name: "QA Reviewer", description: "Slot for QA reviews" },
      { slotKey: "security_auditor", name: "Sec Auditor", description: null },
    ],
    occurredAtUtc: "2026-09-20T10:01:00.000Z",
  });

  if (candidates.length > 0) {
    await persistence.executeAssignProjectRoleBinding({
      tenantId: tTenant,
      commandId: `cmd-assign-role-${slotKey}`,
      idempotencyKey: `idem-assign-role-${slotKey}`,
      correlationId: "corr-role",
      principalId: manager,
      projectId,
      slotKey,
      principalIds: candidates,
      expectedVersion: 0,
      occurredAtUtc: "2026-09-20T10:02:00.000Z",
    });
  }
}

function taskCmd(
  tTenant: TenantId,
  taskId: string,
  overrides: Partial<CreateTaskCommand> = {},
): CreateTaskCommand {
  return {
    tenantId: tTenant,
    commandId: `cmd-${taskId}`,
    idempotencyKey: `idem-${taskId}`,
    correlationId: `corr-${taskId}`,
    principalId: manager,
    projectId: "proj-1",
    nodeId: "node-1",
    taskId,
    title: `Task ${taskId}`,
    assigneePrincipalId: null,
    requiresAcceptance: true,
    reviewerPrincipalId: null,
    reviewerRoleSlotKey: null,
    occurredAtUtc: "2026-09-20T10:03:00.000Z",
    ...overrides,
  };
}

test("TC-TASK-005: Explicit eligible reviewer wins directly", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      await initializeSlotsAndBindings(fixture.persistence, tenant, "proj-1", "reviewer_qa", [candidateB, candidateA]);

      const handler = new CreateTaskHandler(fixture.persistence);

      // Case A: explicit reviewer provided without slot key -> explicit reviewer wins
      const resA = await handler.execute(taskCmd(tenant, "task-exp-1", {
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      }));
      assert.equal(resA.replayed, false);
      assert.equal(resA.value.reviewerPrincipalId, explicitUser);

      // Case B: explicit reviewer provided AND reviewerRoleSlotKey provided -> explicit reviewer wins
      const resB = await handler.execute(taskCmd(tenant, "task-exp-2", {
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: "reviewer_qa",
      }));
      assert.equal(resB.replayed, false);
      assert.equal(resB.value.reviewerPrincipalId, explicitUser);

      // Verify task in persistence
      const persisted = await fixture.persistence.read(tenant, async (tx) => await tx.tasks.get("task-exp-1"));
      assert.equal(persisted?.reviewerPrincipalId, explicitUser);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Ineligible explicit reviewer is rejected with REVIEWER_NOT_ELIGIBLE and does not fall through", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      await initializeSlotsAndBindings(fixture.persistence, tenant, "proj-1", "reviewer_qa", [candidateA]);

      const handler = new CreateTaskHandler(fixture.persistence);

      // 1. Non-member explicit reviewer rejects
      await assert.rejects(
        handler.execute(taskCmd(tenant, "task-ineligible-1", {
          reviewerPrincipalId: outsider,
          reviewerRoleSlotKey: "reviewer_qa", // Even with a valid slot, cannot mask explicit error
        })),
        errorCode("REVIEWER_NOT_ELIGIBLE"),
        fixture.name,
      );

      // 2. Revoked principal explicit reviewer rejects
      await fixture.persistence.transaction(tenant, async (tx) => {
        const p = await tx.principals.get(explicitUser);
        assert.ok(p);
        await tx.principals.update({ ...p, status: "revoked", version: p.version + 1, updatedAtUtc: "2026-09-20T10:04:00.000Z" }, p.version);
      });

      await assert.rejects(
        handler.execute(taskCmd(tenant, "task-ineligible-2", {
          reviewerPrincipalId: explicitUser,
          reviewerRoleSlotKey: "reviewer_qa",
        })),
        errorCode("REVIEWER_NOT_ELIGIBLE"),
        fixture.name,
      );

      // Assert zero tasks written
      assert.equal(
        await fixture.persistence.read(tenant, async (tx) => (await tx.tasks.listByNode("node-1")).length),
        0,
        fixture.name,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Deterministic multi-candidate slot selection picks canonical smallest Principal ID", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      // Candidates intentionally inserted in non-lexicographical order: candidateC, candidateB, candidateA
      // candidateA = "cand-a-user", candidateB = "cand-b-user", candidateC = "cand-c-user"
      await initializeSlotsAndBindings(fixture.persistence, tenant, "proj-1", "reviewer_qa", [candidateC, candidateB, candidateA]);

      const handler = new CreateTaskHandler(fixture.persistence);

      const res = await handler.execute(taskCmd(tenant, "task-slot-1", {
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: "reviewer_qa",
      }));
      assert.equal(res.replayed, false);
      // Smallest canonical Principal ID is candidateA ("cand-a-user")
      assert.equal(res.value.reviewerPrincipalId, candidateA);

      // Now revoke candidateA's membership; remaining candidates are B and C
      await fixture.persistence.transaction(tenant, async (tx) => {
        const m = await tx.memberships.get("proj-1", candidateA);
        assert.ok(m);
        await tx.memberships.restrictWithSecurityDomains({
          ...m,
          status: "revoked",
          version: m.version + 1,
        }, m.version, "2026-09-20T10:05:00.000Z");
      });

      const res2 = await handler.execute(taskCmd(tenant, "task-slot-2", {
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: "reviewer_qa",
      }));
      // Smallest remaining eligible candidate is candidateB ("cand-b-user")
      assert.equal(res2.value.reviewerPrincipalId, candidateB);

      // Now revoke candidateB's principal status; remaining is C
      await fixture.persistence.transaction(tenant, async (tx) => {
        const p = await tx.principals.get(candidateB);
        assert.ok(p);
        await tx.principals.update({ ...p, status: "revoked", version: p.version + 1, updatedAtUtc: "2026-09-20T10:06:00.000Z" }, p.version);
      });

      const res3 = await handler.execute(taskCmd(tenant, "task-slot-3", {
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: "reviewer_qa",
      }));
      assert.equal(res3.value.reviewerPrincipalId, candidateC);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Slot fallthrough reasons gracefully fall back to Node Owner", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      const handler = new CreateTaskHandler(fixture.persistence);

      // Reason 1: reviewerRoleSlotKey is null / omitted -> falls through to node owner
      const res1 = await handler.execute(taskCmd(tenant, "task-fall-1", {
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: null,
      }));
      assert.equal(res1.value.reviewerPrincipalId, nodeLeader);

      // Reason 2: reviewerRoleSlotKey does not exist in project -> falls through to node owner
      const res2 = await handler.execute(taskCmd(tenant, "task-fall-2", {
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: "non_existent_slot",
      }));
      assert.equal(res2.value.reviewerPrincipalId, nodeLeader);

      // Reason 3: Slot exists, but no binding exists in project -> falls through to node owner
      await fixture.persistence.executeInitializeProjectRoleSlots({
        tenantId: tenant,
        commandId: "cmd-init-unbound-slot",
        idempotencyKey: "idem-init-unbound-slot",
        principalId: manager,
        projectId: "proj-1",
        sourceTemplateVersionId: "tpl-v1",
        slots: [{ slotKey: "unbound_slot", name: "Unbound Slot", description: null }],
        occurredAtUtc: "2026-09-20T10:07:00.000Z",
      });
      const res3 = await handler.execute(taskCmd(tenant, "task-fall-3", {
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: "unbound_slot",
      }));
      assert.equal(res3.value.reviewerPrincipalId, nodeLeader);

      // Reason 4: Slot exists and binding exists, but principalIds is empty -> falls through to node owner
      await fixture.persistence.executeAssignProjectRoleBinding({
        tenantId: tenant,
        commandId: "cmd-assign-empty-slot",
        idempotencyKey: "idem-assign-empty-slot",
        correlationId: "corr-empty",
        principalId: manager,
        projectId: "proj-1",
        slotKey: "unbound_slot",
        principalIds: [],
        expectedVersion: 0,
        occurredAtUtc: "2026-09-20T10:08:00.000Z",
      });
      const res4 = await handler.execute(taskCmd(tenant, "task-fall-4", {
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: "unbound_slot",
      }));
      assert.equal(res4.value.reviewerPrincipalId, nodeLeader);

      // Reason 5: Slot candidates all have revoked Principal status -> falls through to node owner
      await fixture.persistence.executeAssignProjectRoleBinding({
        tenantId: tenant,
        commandId: "cmd-assign-revoked-p",
        idempotencyKey: "idem-assign-revoked-p",
        correlationId: "corr-revoked-p",
        principalId: manager,
        projectId: "proj-1",
        slotKey: "unbound_slot",
        principalIds: [candidateA],
        expectedVersion: 1,
        occurredAtUtc: "2026-09-20T10:09:00.000Z",
      });
      await fixture.persistence.transaction(tenant, async (tx) => {
        const p = await tx.principals.get(candidateA);
        assert.ok(p);
        await tx.principals.update({ ...p, status: "revoked", version: p.version + 1, updatedAtUtc: "2026-09-20T10:10:00.000Z" }, p.version);
      });
      const res5 = await handler.execute(taskCmd(tenant, "task-fall-5", {
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: "unbound_slot",
      }));
      assert.equal(res5.value.reviewerPrincipalId, nodeLeader);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Final missing or ineligible candidate rejects atomically with REVIEWER_REQUIRED (zero writes)", async () => {
  for (const fixture of await fixtures()) {
    try {
      // Baseline with node having NO leader (leaderPrincipalId = null)
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", null);
      const initialTasks = await fixture.persistence.read(tenant, async (tx) => (await tx.tasks.listByNode("node-1")).length);
      const initialOutbox = await fixture.outbox.countReady("9999-12-31T23:59:59.999Z");
      const handler = new CreateTaskHandler(fixture.persistence);

      // 1. Both explicit and slot omitted, node leader is null -> REVIEWER_REQUIRED
      await assert.rejects(
        handler.execute(taskCmd(tenant, "task-req-1", {
          reviewerPrincipalId: null,
          reviewerRoleSlotKey: null,
        })),
        errorCode("REVIEWER_REQUIRED"),
        fixture.name,
      );

      // 2. Slot specified but unbound, node leader is null -> REVIEWER_REQUIRED
      await assert.rejects(
        handler.execute(taskCmd(tenant, "task-req-2", {
          reviewerPrincipalId: null,
          reviewerRoleSlotKey: "non_existent_slot",
        })),
        errorCode("REVIEWER_REQUIRED"),
        fixture.name,
      );

      // Assert Task and ready-outbox counts remain unchanged without writes
      const taskCount = await fixture.persistence.read(tenant, async (tx) => (await tx.tasks.listByNode("node-1")).length);
      assert.equal(taskCount, initialTasks, fixture.name);
      assert.equal(await fixture.outbox.countReady("9999-12-31T23:59:59.999Z"), initialOutbox, fixture.name);

      // Now create a node with an INELIGIBLE leader (e.g. revoked principal)
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-with-revoked-leader", nodeLeader);
      await fixture.persistence.transaction(tenant, async (tx) => {
        const p = await tx.principals.get(nodeLeader);
        assert.ok(p);
        await tx.principals.update({ ...p, status: "revoked", version: p.version + 1, updatedAtUtc: "2026-09-20T10:11:00.000Z" }, p.version);
      });

      await assert.rejects(
        handler.execute(taskCmd(tenant, "task-req-3", {
          nodeId: "node-with-revoked-leader",
          reviewerPrincipalId: null,
          reviewerRoleSlotKey: null,
        })),
        errorCode("REVIEWER_REQUIRED"),
        fixture.name,
      );

      assert.equal(
        await fixture.persistence.read(tenant, async (tx) => (await tx.tasks.listByNode("node-with-revoked-leader")).length),
        0,
        fixture.name,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Sensitive domain SecurityGrant view capability check across slot candidates and node owner", async () => {
  for (const fixture of await fixtures()) {
    try {
      // Create a sensitive security domain
      const secDomainId = "sec-domain-alpha";
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-sensitive", nodeLeader);

      await new CreateSecurityRootHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: "cmd-sec-root-node-sensitive",
        idempotencyKey: "idem-sec-root-node-sensitive",
        correlationId: "corr-sec-root",
        principalId: manager,
        projectId: "proj-1",
        nodeId: "node-sensitive",
        securityDomainId: secDomainId,
        expectedNodeVersion: 2,
        reason: "Sensitive root",
        occurredAtUtc: "2026-09-20T10:00:30.000Z",
      });

      // candidateB has active "view" grant
      await grantCapability(fixture.persistence, secDomainId, candidateB, "view");

      // candidateA has EXPIRED grant, candidateC has REVOKED grant
      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.securityGrants.insert({
          tenantId: tenant,
          id: `grant-${secDomainId}-${candidateA}`,
          securityDomainId: secDomainId,
          principalId: candidateA,
          capability: "view",
          status: "active",
          expiresAtUtc: "2020-01-01T00:00:00.000Z",
          grantedByPrincipalId: manager,
          reason: "expired view grant",
          version: 1,
          createdAtUtc: "2020-01-01T00:00:00.000Z",
          updatedAtUtc: "2020-01-01T00:00:00.000Z",
        });
        await tx.securityGrants.insert({
          tenantId: tenant,
          id: `grant-${secDomainId}-${candidateC}`,
          securityDomainId: secDomainId,
          principalId: candidateC,
          capability: "view",
          status: "revoked",
          expiresAtUtc: null,
          grantedByPrincipalId: manager,
          reason: "revoked view grant",
          version: 1,
          createdAtUtc: "2020-01-01T00:00:00.000Z",
          updatedAtUtc: "2020-01-01T00:00:00.000Z",
        });
      });

      // nodeLeader has NO grant in secDomainId

      await initializeSlotsAndBindings(fixture.persistence, tenant, "proj-1", "reviewer_qa", [candidateA, candidateB, candidateC]);

      const handler = new CreateTaskHandler(fixture.persistence);

      // CandidateA (expired) and CandidateC (revoked) are filtered out.
      // CandidateB has active view grant -> candidateB wins!
      const res1 = await handler.execute(taskCmd(tenant, "task-sec-1", {
        nodeId: "node-sensitive",
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: "reviewer_qa",
      }));
      assert.equal(res1.value.reviewerPrincipalId, candidateB);

      // Now revoke CandidateB's grant.
      await revokeCapability(fixture.persistence, secDomainId, candidateB);

      // Now all slot candidates (A, B, C) lack view access -> falls through to nodeLeader.
      // But nodeLeader ALSO lacks view grant -> falls through to REVIEWER_REQUIRED!
      await assert.rejects(
        handler.execute(taskCmd(tenant, "task-sec-2", {
          nodeId: "node-sensitive",
          reviewerPrincipalId: null,
          reviewerRoleSlotKey: "reviewer_qa",
        })),
        errorCode("REVIEWER_REQUIRED"),
        fixture.name,
      );

      // Give nodeLeader an active view grant
      await grantCapability(fixture.persistence, secDomainId, nodeLeader, "view");

      // Now nodeLeader is eligible and wins the fallback!
      const res3 = await handler.execute(taskCmd(tenant, "task-sec-3", {
        nodeId: "node-sensitive",
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: "reviewer_qa",
      }));
      assert.equal(res3.value.reviewerPrincipalId, nodeLeader);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: requiresAcceptance=false rejects non-null reviewerRoleSlotKey", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      const handler = new CreateTaskHandler(fixture.persistence);

      // requiresAcceptance = false with reviewerRoleSlotKey rejects with REVIEWER_NOT_ALLOWED
      await assert.rejects(
        handler.execute(taskCmd(tenant, "task-no-acc-1", {
          requiresAcceptance: false,
          reviewerPrincipalId: null,
          reviewerRoleSlotKey: "reviewer_qa",
        })),
        errorCode("REVIEWER_NOT_ALLOWED"),
        fixture.name,
      );

      // requiresAcceptance = false with reviewerPrincipalId rejects with REVIEWER_NOT_ALLOWED
      await assert.rejects(
        handler.execute(taskCmd(tenant, "task-no-acc-2", {
          requiresAcceptance: false,
          reviewerPrincipalId: explicitUser,
          reviewerRoleSlotKey: null,
        })),
        errorCode("REVIEWER_NOT_ALLOWED"),
        fixture.name,
      );

      // requiresAcceptance = false with both null succeeds
      const res = await handler.execute(taskCmd(tenant, "task-no-acc-3", {
        requiresAcceptance: false,
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: null,
      }));
      assert.equal(res.value.reviewerPrincipalId, null);
      assert.equal(res.value.requiresAcceptance, false);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: reviewerRoleSlotKey format validation enforces canonical slotKey rules", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      const handler = new CreateTaskHandler(fixture.persistence);

      // Invalid characters in slot key (spaces)
      await assert.rejects(
        handler.execute(taskCmd(tenant, "task-bad-slot-1", {
          reviewerRoleSlotKey: "slot with spaces",
        })),
        errorCode("VALIDATION_FAILED"),
        fixture.name,
      );

      // Invalid characters (slashes)
      await assert.rejects(
        handler.execute(taskCmd(tenant, "task-bad-slot-2", {
          reviewerRoleSlotKey: "slot/with/slashes",
        })),
        errorCode("VALIDATION_FAILED"),
        fixture.name,
      );

      // Length > 64 chars
      await assert.rejects(
        handler.execute(taskCmd(tenant, "task-bad-slot-3", {
          reviewerRoleSlotKey: "a".repeat(65),
        })),
        errorCode("VALIDATION_FAILED"),
        fixture.name,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Idempotent replay, fingerprint sensitivity, and duplicate taskId rejection", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      await initializeSlotsAndBindings(fixture.persistence, tenant, "proj-1", "reviewer_qa", [candidateA]);

      const handler = new CreateTaskHandler(fixture.persistence);
      const cmd = taskCmd(tenant, "task-idem-1", {
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: "reviewer_qa",
      });

      // 1. Initial execution
      const res1 = await handler.execute(cmd);
      assert.equal(res1.replayed, false);
      assert.equal(res1.value.reviewerPrincipalId, candidateA);

      // 2. Exact replay with same payload -> returns replayed: true
      const replay = await handler.execute({ ...cmd, commandId: "diff-cmd-id" });
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.value, res1.value);

      // 3. Replay with different payload (different reviewerRoleSlotKey) -> IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD
      await assert.rejects(
        handler.execute({ ...cmd, reviewerRoleSlotKey: "security_auditor" }),
        errorCode("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD"),
        fixture.name,
      );

      // 4. Duplicate taskId: another command with the same taskId but different idempotencyKey -> TASK_ALREADY_EXISTS
      await assert.rejects(
        handler.execute({
          ...cmd,
          commandId: "concurrent-cmd",
          idempotencyKey: "concurrent-key",
        }),
        /TASK_ALREADY_EXISTS/,
        fixture.name,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Security migration freeze fail-closed", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      // Create another node that is placed under migration
      await executeCreateNode(fixture.persistence, {
        tenantId: tenant,
        commandId: "cmd-create-node-mig",
        idempotencyKey: "idem-create-node-mig",
        correlationId: "corr-setup",
        principalId: manager,
        projectId: "proj-1",
        nodeId: "node-migrating",
        parentId: null,
        title: "Migrating Node",
        leaderPrincipalId: null,
        securityDomainId: null,
        occurredAtUtc: "2026-09-20T10:00:10.000Z",
      });
      await initializeSlotsAndBindings(fixture.persistence, tenant, "proj-1", "reviewer_qa", [candidateA]);

      // Place project/node-migrating into active security migration
      await fixture.persistence.transaction(tenant, async (tx) => {
        const planned: SecurityDomainMigration = {
          id: "mig-freeze-1",
          tenantId: tenant,
          projectId: "proj-1",
          rootNodeId: "node-migrating",
          sourceSecurityDomainId: null,
          targetSecurityDomainId: "sd-new",
          hierarchyRevision: 1,
          sourceSecurityEpoch: 1,
          targetSecurityEpoch: 2,
          state: "planned",
          cursor: null,
          totalItems: 5,
          migratedItems: 0,
          failure: null,
          nextAttemptAtUtc: null,
          deadlineAtUtc: "2026-09-25T00:00:00.000Z",
          version: 1,
          createdAtUtc: "2026-09-20T10:15:00.000Z",
          updatedAtUtc: "2026-09-20T10:15:00.000Z",
        };
        const active = transitionSecurityMigration(planned, "active", "2026-09-20T10:15:00.000Z");
        await tx.securityMigrations.insert(planned);
        await tx.securityMigrations.saveProgressPreservingPlan(active.id, active, planned.version);
      });

      const handler = new CreateTaskHandler(fixture.persistence);

      // Task creation on node-1 must be frozen with SECURITY_MIGRATION_IN_PROGRESS
      await assert.rejects(
        handler.execute(taskCmd(tenant, "task-mig-freeze", {
          nodeId: "node-1",
          reviewerRoleSlotKey: "reviewer_qa",
        })),
        errorCode("SECURITY_MIGRATION_IN_PROGRESS"),
        fixture.name,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Task snapshot is immutable against subsequent binding mutations and survives SQLite restart", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      await initializeSlotsAndBindings(fixture.persistence, tenant, "proj-1", "reviewer_qa", [candidateA]);

      const handler = new CreateTaskHandler(fixture.persistence);
      const res = await handler.execute(taskCmd(tenant, "task-snap-1", {
        reviewerRoleSlotKey: "reviewer_qa",
      }));
      assert.equal(res.value.reviewerPrincipalId, candidateA);

      // Mutate role binding to candidateB
      await fixture.persistence.executeAssignProjectRoleBinding({
        tenantId: tenant,
        commandId: "cmd-reassign-binding",
        idempotencyKey: "idem-reassign-binding",
        correlationId: "corr-reassign",
        principalId: manager,
        projectId: "proj-1",
        slotKey: "reviewer_qa",
        principalIds: [candidateB],
        expectedVersion: 1,
        occurredAtUtc: "2026-09-20T10:16:00.000Z",
      });

      // Existing task snapshot MUST NOT change
      const taskAfterBindingChange = await fixture.persistence.read(tenant, async (tx) => await tx.tasks.get("task-snap-1"));
      assert.equal(taskAfterBindingChange?.reviewerPrincipalId, candidateA);

      // SQLite restart test
      if (fixture.path) {
        await fixture.persistence.close();
        const reopened = new SqlitePersistence({ path: fixture.path });
        try {
          const reloadedTask = await reopened.read(tenant, async (tx) => await tx.tasks.get("task-snap-1"));
          assert.equal(reloadedTask?.reviewerPrincipalId, candidateA);
          assert.equal(reloadedTask?.version, 1);
          assert.equal(reloadedTask?.executionState, "todo");
          assert.equal(reloadedTask?.reviewState, "not_submitted");
        } finally {
          await reopened.close();
        }
      }
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Replay reauthorization validates persisted reviewer against Principal, Membership and Grant revocation/expiry without substitution", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      await initializeSlotsAndBindings(fixture.persistence, tenant, "proj-1", "reviewer_qa", [candidateA, candidateB]);

      const handler = new CreateTaskHandler(fixture.persistence);

      // --- Case 1: Principal revocation ---
      const cmd1 = taskCmd(tenant, "task-replay-revoked-principal", {
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: "reviewer_qa",
      });
      const res1 = await handler.execute(cmd1);
      assert.equal(res1.replayed, false);
      assert.equal(res1.value.reviewerPrincipalId, candidateA);

      // Verify exact replay initially succeeds
      const replay1Success = await handler.execute(cmd1);
      assert.equal(replay1Success.replayed, true);
      assert.equal(replay1Success.value.reviewerPrincipalId, candidateA);

      // Revoke candidateA's principal
      await fixture.persistence.transaction(tenant, async (tx) => {
        const p = await tx.principals.get(candidateA);
        assert.ok(p);
        await tx.principals.update({ ...p, status: "revoked", version: p.version + 1, updatedAtUtc: "2026-09-20T11:00:00.000Z" }, p.version);
      });

      // Exact replay must now FAIL with REVIEWER_NOT_ELIGIBLE.
      // Must NOT rerun resolution to pick candidateB or fall back to nodeLeader!
      await assert.rejects(
        handler.execute(cmd1),
        errorCode("REVIEWER_NOT_ELIGIBLE"),
        fixture.name,
      );

      // --- Case 2: Membership revocation ---
      // Reset candidateA principal back to active
      await fixture.persistence.transaction(tenant, async (tx) => {
        const p = await tx.principals.get(candidateA);
        assert.ok(p);
        await tx.principals.update({ ...p, status: "active", version: p.version + 1, updatedAtUtc: "2026-09-20T11:01:00.000Z" }, p.version);
      });

      const cmd2 = taskCmd(tenant, "task-replay-revoked-membership", {
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: "reviewer_qa",
      });
      const res2 = await handler.execute(cmd2);
      assert.equal(res2.replayed, false);
      assert.equal(res2.value.reviewerPrincipalId, candidateA);

      // Revoke candidateA's membership in proj-1
      await fixture.persistence.transaction(tenant, async (tx) => {
        const m = await tx.memberships.get("proj-1", candidateA);
        assert.ok(m);
        await tx.memberships.restrictWithSecurityDomains({
          ...m,
          status: "revoked",
          version: m.version + 1,
        }, m.version, "2026-09-20T11:02:00.000Z");
      });

      // Exact replay must now FAIL with REVIEWER_NOT_ELIGIBLE
      await assert.rejects(
        handler.execute(cmd2),
        errorCode("REVIEWER_NOT_ELIGIBLE"),
        fixture.name,
      );

      // --- Case 3: Sensitive Domain Grant Revocation ---
      const secDomainReplay = "sec-domain-replay";
      await executeCreateNode(fixture.persistence, {
        tenantId: tenant,
        commandId: "cmd-create-node-sec-replay",
        idempotencyKey: "idem-create-node-sec-replay",
        correlationId: "corr-sec-replay",
        principalId: manager,
        projectId: "proj-1",
        nodeId: "node-sec-replay",
        parentId: null,
        title: "Sensitive Node Replay",
        leaderPrincipalId: nodeLeader,
        securityDomainId: null,
        occurredAtUtc: "2026-09-20T11:03:00.000Z",
      });
      await new CreateSecurityRootHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: "cmd-sec-root-node-replay",
        idempotencyKey: "idem-sec-root-node-replay",
        correlationId: "corr-sec-replay",
        principalId: manager,
        projectId: "proj-1",
        nodeId: "node-sec-replay",
        securityDomainId: secDomainReplay,
        expectedNodeVersion: 2,
        reason: "Sensitive root replay",
        occurredAtUtc: "2026-09-20T11:03:30.000Z",
      });

      // Grant candidateB active view grant (candidateA membership is revoked so candidateB is selected)
      await grantCapability(fixture.persistence, secDomainReplay, candidateB, "view");

      const cmd3 = taskCmd(tenant, "task-replay-revoked-grant", {
        nodeId: "node-sec-replay",
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: "reviewer_qa",
      });
      const res3 = await handler.execute(cmd3);
      assert.equal(res3.replayed, false);
      assert.equal(res3.value.reviewerPrincipalId, candidateB);

      // Exact replay succeeds initially
      const replay3Success = await handler.execute(cmd3);
      assert.equal(replay3Success.replayed, true);

      // Revoke candidateB's view grant
      await revokeCapability(fixture.persistence, secDomainReplay, candidateB);

      // Replay must FAIL with REVIEWER_NOT_ELIGIBLE
      await assert.rejects(
        handler.execute(cmd3),
        errorCode("REVIEWER_NOT_ELIGIBLE"),
        fixture.name,
      );

      // --- Case 4: Sensitive Domain Grant Expiration ---
      const secDomainExpire = "sec-domain-expire";
      await executeCreateNode(fixture.persistence, {
        tenantId: tenant,
        commandId: "cmd-create-node-sec-expire",
        idempotencyKey: "idem-create-node-sec-expire",
        correlationId: "corr-sec-expire",
        principalId: manager,
        projectId: "proj-1",
        nodeId: "node-sec-expire",
        parentId: null,
        title: "Sensitive Node Expire",
        leaderPrincipalId: nodeLeader,
        securityDomainId: null,
        occurredAtUtc: "2026-09-20T11:04:00.000Z",
      });
      await new CreateSecurityRootHandler(fixture.persistence).execute({
        tenantId: tenant,
        commandId: "cmd-sec-root-node-expire",
        idempotencyKey: "idem-sec-root-node-expire",
        correlationId: "corr-sec-expire",
        principalId: manager,
        projectId: "proj-1",
        nodeId: "node-sec-expire",
        securityDomainId: secDomainExpire,
        expectedNodeVersion: 2,
        reason: "Sensitive root expire",
        occurredAtUtc: "2026-09-20T11:04:30.000Z",
      });

      // Grant candidateC active view grant expiring in the future
      await grantCapability(fixture.persistence, secDomainExpire, candidateC, "view", "2099-01-01T00:00:00.000Z");

      const cmd4 = taskCmd(tenant, "task-replay-expired-grant", {
        nodeId: "node-sec-expire",
        reviewerPrincipalId: explicitUser, // test with explicit reviewer as well
        reviewerRoleSlotKey: null,
      });
      // Explicit candidateC
      const cmd4Explicit = taskCmd(tenant, "task-replay-expired-grant-cand-c", {
        nodeId: "node-sec-expire",
        reviewerPrincipalId: candidateC,
        reviewerRoleSlotKey: null,
      });
      const res4 = await handler.execute(cmd4Explicit);
      assert.equal(res4.replayed, false);
      assert.equal(res4.value.reviewerPrincipalId, candidateC);

      // Now expire candidateC's grant by setting expiresAtUtc in the past
      await fixture.persistence.transaction(tenant, async (tx) => {
        const domain = await tx.securityDomains.get(secDomainExpire);
        assert.ok(domain);
        const grant = await tx.securityGrants.get(secDomainExpire, candidateC);
        assert.ok(grant);
        const updatedDomain = {
          ...domain,
          permissionVersion: domain.permissionVersion + 1,
          version: domain.version + 1,
        };
        await tx.securityGrants.saveWithDomainVersion(
          {
            ...grant,
            expiresAtUtc: "2020-01-01T00:00:00.000Z",
            version: grant.version + 1,
            updatedAtUtc: "2026-09-20T11:05:00.000Z",
          },
          grant.version,
          updatedDomain,
          domain.version,
        );
      });

      // Replay must FAIL with REVIEWER_NOT_ELIGIBLE
      await assert.rejects(
        handler.execute(cmd4Explicit),
        errorCode("REVIEWER_NOT_ELIGIBLE"),
        fixture.name,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Genuine base 9cadf1c receipt fingerprint compatibility and rejection of non-null/drifted slot keys", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      const handler = new CreateTaskHandler(fixture.persistence);

      // In base commit 9cadf1c:
      // Fingerprint was computed without reviewerRoleSlotKey:
      // hash({ projectId, nodeId, taskId, title, assigneePrincipalId, requiresAcceptance, reviewerPrincipalId })
      // Result had reviewHistory: [] (normal TaskView) and explicit non-null reviewer
      const baseTask = {
        id: "task-base-compat",
        nodeId: "node-1",
        title: "Base Commit Task",
        status: "todo" as const,
        assigneePrincipalId: null,
        requiresAcceptance: true,
        reviewerPrincipalId: explicitUser,
        version: 1,
        reviewHistory: [],
      };

      const baseFp = createHash("sha256").update(JSON.stringify({
        projectId: "proj-1",
        nodeId: "node-1",
        taskId: "task-base-compat",
        title: "Base Commit Task",
        assigneePrincipalId: null,
        requiresAcceptance: true,
        reviewerPrincipalId: explicitUser,
      })).digest("hex");

      const scope = {
        principalId: manager,
        operation: "create_task",
        idempotencyKey: "idem-base-compat",
      };

      // Insert existing base-era task and receipt into persistence
      await fixture.persistence.transaction(tenant, async (tx) => {
        const node = await tx.nodes.get("node-1");
        assert.ok(node);
        await tx.tasks.insert({
          tenantId: tenant,
          id: "task-base-compat",
          projectId: "proj-1",
          ownerNodeId: "node-1",
          securityDomainId: node.securityDomainId,
          securityEpoch: node.securityEpoch,
          title: "Base Commit Task",
          assigneePrincipalId: null,
          requiresAcceptance: true,
          reviewerPrincipalId: explicitUser,
          executionState: "todo",
          reviewState: "not_submitted",
          version: 1,
          deletedAtUtc: null,
        });
        await tx.receipts.insert({
          scope,
          fingerprint: baseFp,
          result: baseTask,
          createdAtUtc: "2026-09-20T09:00:00.000Z",
        });
      });

      // 1. Replay with reviewerRoleSlotKey: null (or omitted) -> succeeds with replayed: true
      const replayNullSlot = await handler.execute({
        tenantId: tenant,
        commandId: "cmd-replay-base-1",
        idempotencyKey: "idem-base-compat",
        correlationId: "corr-replay-base-1",
        principalId: manager,
        projectId: "proj-1",
        nodeId: "node-1",
        taskId: "task-base-compat",
        title: "Base Commit Task",
        assigneePrincipalId: null,
        requiresAcceptance: true,
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
        occurredAtUtc: "2026-09-20T10:00:00.000Z",
      });
      assert.equal(replayNullSlot.replayed, true);
      assert.equal(replayNullSlot.value.id, "task-base-compat");
      assert.equal(replayNullSlot.value.reviewerPrincipalId, explicitUser);

      // Also replay with reviewerRoleSlotKey: undefined (omitted) -> succeeds with replayed: true
      const replayOmittedSlot = await handler.execute({
        tenantId: tenant,
        commandId: "cmd-replay-base-1b",
        idempotencyKey: "idem-base-compat",
        correlationId: "corr-replay-base-1b",
        principalId: manager,
        projectId: "proj-1",
        nodeId: "node-1",
        taskId: "task-base-compat",
        title: "Base Commit Task",
        assigneePrincipalId: null,
        requiresAcceptance: true,
        reviewerPrincipalId: explicitUser,
        occurredAtUtc: "2026-09-20T10:00:00.000Z",
      });
      assert.equal(replayOmittedSlot.replayed, true);

      // 2. Replay with non-null reviewerRoleSlotKey -> MUST REJECT with IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD
      await assert.rejects(
        handler.execute({
          tenantId: tenant,
          commandId: "cmd-replay-base-2",
          idempotencyKey: "idem-base-compat",
          correlationId: "corr-replay-base-2",
          principalId: manager,
          projectId: "proj-1",
          nodeId: "node-1",
          taskId: "task-base-compat",
          title: "Base Commit Task",
          assigneePrincipalId: null,
          requiresAcceptance: true,
          reviewerPrincipalId: explicitUser,
          reviewerRoleSlotKey: "reviewer_qa",
          occurredAtUtc: "2026-09-20T10:00:00.000Z",
        }),
        errorCode("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD"),
        fixture.name,
      );

      // 3. Replay with drifted field (e.g. title) -> MUST REJECT with IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD
      await assert.rejects(
        handler.execute({
          tenantId: tenant,
          commandId: "cmd-replay-base-3",
          idempotencyKey: "idem-base-compat",
          correlationId: "corr-replay-base-3",
          principalId: manager,
          projectId: "proj-1",
          nodeId: "node-1",
          taskId: "task-base-compat",
          title: "Changed Title",
          assigneePrincipalId: null,
          requiresAcceptance: true,
          reviewerPrincipalId: explicitUser,
          reviewerRoleSlotKey: null,
          occurredAtUtc: "2026-09-20T10:00:00.000Z",
        }),
        errorCode("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD"),
        fixture.name,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Corrupt or missing reviewer snapshot in acceptance task receipt fails closed on replay", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      const handler = new CreateTaskHandler(fixture.persistence);

      // 1. Corrupt: requiresAcceptance = true, but reviewerPrincipalId is null
      const cmdCorruptNull = taskCmd(tenant, "task-corrupt-null", {
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: null,
      });
      const scopeCorruptNull = {
        principalId: cmdCorruptNull.principalId,
        operation: "create_task",
        idempotencyKey: cmdCorruptNull.idempotencyKey,
      };
      const fpCorruptNull = createHash("sha256").update(JSON.stringify({
        projectId: cmdCorruptNull.projectId,
        nodeId: cmdCorruptNull.nodeId,
        taskId: cmdCorruptNull.taskId,
        title: cmdCorruptNull.title,
        assigneePrincipalId: cmdCorruptNull.assigneePrincipalId,
        requiresAcceptance: cmdCorruptNull.requiresAcceptance,
        reviewerPrincipalId: cmdCorruptNull.reviewerPrincipalId,
        reviewerRoleSlotKey: null,
      })).digest("hex");

      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.receipts.insert({
          scope: scopeCorruptNull,
          fingerprint: fpCorruptNull,
          result: {
            id: "task-corrupt-null",
            nodeId: "node-1",
            title: "Task task-corrupt-null",
            status: "todo",
            assigneePrincipalId: null,
            requiresAcceptance: true,
            reviewerPrincipalId: null, // corrupt: acceptance task without reviewer!
            version: 1,
            reviewHistory: [],
          },
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });

      await assert.rejects(
        handler.execute(cmdCorruptNull),
        errorCode("VALIDATION_FAILED"),
        fixture.name,
      );

      // 2. Corrupt: requiresAcceptance = true, reviewerPrincipalId is empty string
      const cmdCorruptEmpty = taskCmd(tenant, "task-corrupt-empty", {
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: null,
      });
      const scopeCorruptEmpty = {
        principalId: cmdCorruptEmpty.principalId,
        operation: "create_task",
        idempotencyKey: cmdCorruptEmpty.idempotencyKey,
      };
      const fpCorruptEmpty = createHash("sha256").update(JSON.stringify({
        projectId: cmdCorruptEmpty.projectId,
        nodeId: cmdCorruptEmpty.nodeId,
        taskId: cmdCorruptEmpty.taskId,
        title: cmdCorruptEmpty.title,
        assigneePrincipalId: cmdCorruptEmpty.assigneePrincipalId,
        requiresAcceptance: cmdCorruptEmpty.requiresAcceptance,
        reviewerPrincipalId: cmdCorruptEmpty.reviewerPrincipalId,
        reviewerRoleSlotKey: null,
      })).digest("hex");

      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.receipts.insert({
          scope: scopeCorruptEmpty,
          fingerprint: fpCorruptEmpty,
          result: {
            id: "task-corrupt-empty",
            nodeId: "node-1",
            title: "Task task-corrupt-empty",
            status: "todo",
            assigneePrincipalId: null,
            requiresAcceptance: true,
            reviewerPrincipalId: "   ", // corrupt empty string
            version: 1,
            reviewHistory: [],
          },
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });

      await assert.rejects(
        handler.execute(cmdCorruptEmpty),
        errorCode("VALIDATION_FAILED"),
        fixture.name,
      );

      // 3. Corrupt: result is not an object or missing required fields
      const cmdCorruptNonObject = taskCmd(tenant, "task-corrupt-non-obj", {
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: null,
      });
      const scopeCorruptNonObject = {
        principalId: cmdCorruptNonObject.principalId,
        operation: "create_task",
        idempotencyKey: cmdCorruptNonObject.idempotencyKey,
      };
      const fpCorruptNonObject = createHash("sha256").update(JSON.stringify({
        projectId: cmdCorruptNonObject.projectId,
        nodeId: cmdCorruptNonObject.nodeId,
        taskId: cmdCorruptNonObject.taskId,
        title: cmdCorruptNonObject.title,
        assigneePrincipalId: cmdCorruptNonObject.assigneePrincipalId,
        requiresAcceptance: cmdCorruptNonObject.requiresAcceptance,
        reviewerPrincipalId: cmdCorruptNonObject.reviewerPrincipalId,
        reviewerRoleSlotKey: null,
      })).digest("hex");

      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.receipts.insert({
          scope: scopeCorruptNonObject,
          fingerprint: fpCorruptNonObject,
          result: "corrupt-string-result",
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });

      await assert.rejects(
        handler.execute(cmdCorruptNonObject),
        errorCode("VALIDATION_FAILED"),
        fixture.name,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Authoritative Task absent, deleted, domain/epoch drift, or node mismatch fails closed on replay", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      const handler = new CreateTaskHandler(fixture.persistence);

      const makeScopeAndFp = (cmd: ReturnType<typeof taskCmd>) => {
        const fp = createHash("sha256").update(JSON.stringify({
          projectId: cmd.projectId,
          nodeId: cmd.nodeId,
          taskId: cmd.taskId,
          title: cmd.title,
          assigneePrincipalId: cmd.assigneePrincipalId,
          requiresAcceptance: cmd.requiresAcceptance,
          reviewerPrincipalId: cmd.reviewerPrincipalId,
          reviewerRoleSlotKey: null,
        })).digest("hex");
        const scope = {
          principalId: cmd.principalId,
          operation: "create_task",
          idempotencyKey: cmd.idempotencyKey,
        };
        return { fp, scope };
      };

      const baseReceipt = (cmd: ReturnType<typeof taskCmd>) => ({
        id: cmd.taskId,
        nodeId: cmd.nodeId,
        projectId: cmd.projectId,
        title: cmd.title,
        status: "todo" as const,
        assigneePrincipalId: null,
        requiresAcceptance: true,
        reviewerPrincipalId: explicitUser,
        version: 1,
        reviewHistory: [],
      });

      // 1. Authoritative Task absent (receipt exists but task row missing) -> TASK_NOT_FOUND
      const cmdAbsent = taskCmd(tenant, "task-absent-1", {
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      const { fp: fpAbsent, scope: scopeAbsent } = makeScopeAndFp(cmdAbsent);
      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.receipts.insert({
          scope: scopeAbsent,
          fingerprint: fpAbsent,
          result: baseReceipt(cmdAbsent),
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });
      await assert.rejects(
        handler.execute(cmdAbsent),
        errorCode("TASK_NOT_FOUND"),
        fixture.name,
      );

      // 2. Authoritative Task deleted (deletedAtUtc is not null) -> TASK_NOT_FOUND
      const cmdDeleted = taskCmd(tenant, "task-deleted-1", {
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      const { fp: fpDeleted, scope: scopeDeleted } = makeScopeAndFp(cmdDeleted);
      await fixture.persistence.transaction(tenant, async (tx) => {
        const node = await tx.nodes.get("node-1");
        assert.ok(node);
        await tx.tasks.insert({
          tenantId: tenant,
          id: cmdDeleted.taskId,
          projectId: "proj-1",
          ownerNodeId: "node-1",
          securityDomainId: node.securityDomainId,
          securityEpoch: node.securityEpoch,
          title: cmdDeleted.title,
          assigneePrincipalId: null,
          requiresAcceptance: true,
          reviewerPrincipalId: explicitUser,
          executionState: "todo",
          reviewState: "not_submitted",
          version: 1,
          deletedAtUtc: "2026-09-20T10:05:00.000Z",
        });
        await tx.receipts.insert({
          scope: scopeDeleted,
          fingerprint: fpDeleted,
          result: baseReceipt(cmdDeleted),
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });
      await assert.rejects(
        handler.execute(cmdDeleted),
        errorCode("TASK_NOT_FOUND"),
        fixture.name,
      );

      // 3. Authoritative Task ownerNodeId mismatch -> TASK_NOT_FOUND
      await executeCreateNode(fixture.persistence, {
        tenantId: tenant,
        commandId: "cmd-create-node-2-mismatch",
        idempotencyKey: "idem-create-node-2-mismatch",
        correlationId: "corr-setup",
        principalId: manager,
        projectId: "proj-1",
        nodeId: "node-2",
        parentId: null,
        title: "Second Node",
        leaderPrincipalId: null,
        securityDomainId: null,
        occurredAtUtc: "2026-09-20T10:00:00.000Z",
      });

      const cmdNodeMismatch = taskCmd(tenant, "task-node-mismatch-1", {
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      const { fp: fpNode, scope: scopeNode } = makeScopeAndFp(cmdNodeMismatch);
      await fixture.persistence.transaction(tenant, async (tx) => {
        const node = await tx.nodes.get("node-1");
        assert.ok(node);
        await tx.tasks.insert({
          tenantId: tenant,
          id: cmdNodeMismatch.taskId,
          projectId: "proj-1",
          ownerNodeId: "node-2",
          securityDomainId: node.securityDomainId,
          securityEpoch: node.securityEpoch,
          title: cmdNodeMismatch.title,
          assigneePrincipalId: null,
          requiresAcceptance: true,
          reviewerPrincipalId: explicitUser,
          executionState: "todo",
          reviewState: "not_submitted",
          version: 1,
          deletedAtUtc: null,
        });
        await tx.receipts.insert({
          scope: scopeNode,
          fingerprint: fpNode,
          result: baseReceipt(cmdNodeMismatch),
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });
      await assert.rejects(
        handler.execute(cmdNodeMismatch),
        errorCode("TASK_NOT_FOUND"),
        fixture.name,
      );

      // 4. Authoritative Task projectId mismatch -> TASK_NOT_FOUND
      const cmdProjMismatch = taskCmd(tenant, "task-proj-mismatch-1", {
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      const { fp: fpProj, scope: scopeProj } = makeScopeAndFp(cmdProjMismatch);
      await fixture.persistence.transaction(tenant, async (tx) => {
        const node = await tx.nodes.get("node-1");
        assert.ok(node);
        await tx.tasks.insert({
          tenantId: tenant,
          id: cmdProjMismatch.taskId,
          projectId: "other-proj-id",
          ownerNodeId: "node-1",
          securityDomainId: node.securityDomainId,
          securityEpoch: node.securityEpoch,
          title: cmdProjMismatch.title,
          assigneePrincipalId: null,
          requiresAcceptance: true,
          reviewerPrincipalId: explicitUser,
          executionState: "todo",
          reviewState: "not_submitted",
          version: 1,
          deletedAtUtc: null,
        });
        await tx.receipts.insert({
          scope: scopeProj,
          fingerprint: fpProj,
          result: baseReceipt(cmdProjMismatch),
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });
      await assert.rejects(
        handler.execute(cmdProjMismatch),
        errorCode("TASK_NOT_FOUND"),
        fixture.name,
      );

      // 5. Authoritative Task securityDomainId drift/incoherence -> TASK_NOT_FOUND
      const cmdDomainDrift = taskCmd(tenant, "task-domain-drift-1", {
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      const { fp: fpDomain, scope: scopeDomain } = makeScopeAndFp(cmdDomainDrift);
      await fixture.persistence.transaction(tenant, async (tx) => {
        const node = await tx.nodes.get("node-1");
        assert.ok(node);
        await tx.tasks.insert({
          tenantId: tenant,
          id: cmdDomainDrift.taskId,
          projectId: "proj-1",
          ownerNodeId: "node-1",
          securityDomainId: "sd-drifted-incoherent",
          securityEpoch: node.securityEpoch,
          title: cmdDomainDrift.title,
          assigneePrincipalId: null,
          requiresAcceptance: true,
          reviewerPrincipalId: explicitUser,
          executionState: "todo",
          reviewState: "not_submitted",
          version: 1,
          deletedAtUtc: null,
        });
        await tx.receipts.insert({
          scope: scopeDomain,
          fingerprint: fpDomain,
          result: baseReceipt(cmdDomainDrift),
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });
      await assert.rejects(
        handler.execute(cmdDomainDrift),
        errorCode("TASK_NOT_FOUND"),
        fixture.name,
      );

      // 6. Authoritative Task securityEpoch drift/incoherence -> TASK_NOT_FOUND
      const cmdEpochDrift = taskCmd(tenant, "task-epoch-drift-1", {
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      const { fp: fpEpoch, scope: scopeEpoch } = makeScopeAndFp(cmdEpochDrift);
      await fixture.persistence.transaction(tenant, async (tx) => {
        const node = await tx.nodes.get("node-1");
        assert.ok(node);
        await tx.tasks.insert({
          tenantId: tenant,
          id: cmdEpochDrift.taskId,
          projectId: "proj-1",
          ownerNodeId: "node-1",
          securityDomainId: node.securityDomainId,
          securityEpoch: node.securityEpoch + 1,
          title: cmdEpochDrift.title,
          assigneePrincipalId: null,
          requiresAcceptance: true,
          reviewerPrincipalId: explicitUser,
          executionState: "todo",
          reviewState: "not_submitted",
          version: 1,
          deletedAtUtc: null,
        });
        await tx.receipts.insert({
          scope: scopeEpoch,
          fingerprint: fpEpoch,
          result: baseReceipt(cmdEpochDrift),
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });
      await assert.rejects(
        handler.execute(cmdEpochDrift),
        errorCode("TASK_NOT_FOUND"),
        fixture.name,
      );

      // 7. Authoritative Task requiresAcceptance mismatch -> TASK_NOT_FOUND
      const cmdAccMismatch = taskCmd(tenant, "task-acc-mismatch-1", {
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      const { fp: fpAcc, scope: scopeAcc } = makeScopeAndFp(cmdAccMismatch);
      await fixture.persistence.transaction(tenant, async (tx) => {
        const node = await tx.nodes.get("node-1");
        assert.ok(node);
        await tx.tasks.insert({
          tenantId: tenant,
          id: cmdAccMismatch.taskId,
          projectId: "proj-1",
          ownerNodeId: "node-1",
          securityDomainId: node.securityDomainId,
          securityEpoch: node.securityEpoch,
          title: cmdAccMismatch.title,
          assigneePrincipalId: null,
          requiresAcceptance: false, // mismatch with command.requiresAcceptance: true
          reviewerPrincipalId: null,
          executionState: "todo",
          reviewState: "not_submitted",
          version: 1,
          deletedAtUtc: null,
        });
        await tx.receipts.insert({
          scope: scopeAcc,
          fingerprint: fpAcc,
          result: baseReceipt(cmdAccMismatch),
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });
      await assert.rejects(
        handler.execute(cmdAccMismatch),
        errorCode("TASK_NOT_FOUND"),
        fixture.name,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Receipt identity, project, node, acceptance, and reviewer corruption fails closed on replay", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      const handler = new CreateTaskHandler(fixture.persistence);

      const insertAuthoritativeTask = async (taskId: string, title: string, requiresAcceptance = true) => {
        await fixture.persistence.transaction(tenant, async (tx) => {
          const node = await tx.nodes.get("node-1");
          assert.ok(node);
          await tx.tasks.insert({
            tenantId: tenant,
            id: taskId,
            projectId: "proj-1",
            ownerNodeId: "node-1",
            securityDomainId: node.securityDomainId,
            securityEpoch: node.securityEpoch,
            title,
            assigneePrincipalId: null,
            requiresAcceptance,
            reviewerPrincipalId: requiresAcceptance ? explicitUser : null,
            executionState: "todo",
            reviewState: "not_submitted",
            version: 1,
            deletedAtUtc: null,
          });
        });
      };

      const makeScopeAndFp = (cmd: ReturnType<typeof taskCmd>) => {
        const fp = createHash("sha256").update(JSON.stringify({
          projectId: cmd.projectId,
          nodeId: cmd.nodeId,
          taskId: cmd.taskId,
          title: cmd.title,
          assigneePrincipalId: cmd.assigneePrincipalId,
          requiresAcceptance: cmd.requiresAcceptance,
          reviewerPrincipalId: cmd.reviewerPrincipalId,
          reviewerRoleSlotKey: null,
        })).digest("hex");
        const scope = {
          principalId: cmd.principalId,
          operation: "create_task",
          idempotencyKey: cmd.idempotencyKey,
        };
        return { fp, scope };
      };

      // 1. Receipt id mismatch
      const cmdIdMismatch = taskCmd(tenant, "task-rcpt-id-1", {
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      await insertAuthoritativeTask(cmdIdMismatch.taskId, cmdIdMismatch.title);
      const { fp: fpId, scope: scopeId } = makeScopeAndFp(cmdIdMismatch);
      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.receipts.insert({
          scope: scopeId,
          fingerprint: fpId,
          result: {
            id: "different-task-id",
            nodeId: "node-1",
            title: cmdIdMismatch.title,
            status: "todo",
            assigneePrincipalId: null,
            requiresAcceptance: true,
            reviewerPrincipalId: explicitUser,
            version: 1,
            reviewHistory: [],
          },
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });
      await assert.rejects(handler.execute(cmdIdMismatch), errorCode("VALIDATION_FAILED"), fixture.name);

      // 2. Receipt nodeId mismatch
      const cmdNodeMismatch = taskCmd(tenant, "task-rcpt-node-1", {
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      await insertAuthoritativeTask(cmdNodeMismatch.taskId, cmdNodeMismatch.title);
      const { fp: fpNode, scope: scopeNode } = makeScopeAndFp(cmdNodeMismatch);
      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.receipts.insert({
          scope: scopeNode,
          fingerprint: fpNode,
          result: {
            id: cmdNodeMismatch.taskId,
            nodeId: "different-node-id",
            title: cmdNodeMismatch.title,
            status: "todo",
            assigneePrincipalId: null,
            requiresAcceptance: true,
            reviewerPrincipalId: explicitUser,
            version: 1,
            reviewHistory: [],
          },
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });
      await assert.rejects(handler.execute(cmdNodeMismatch), errorCode("VALIDATION_FAILED"), fixture.name);

      // 3. Receipt projectId mismatch
      const cmdProjMismatch = taskCmd(tenant, "task-rcpt-proj-1", {
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      await insertAuthoritativeTask(cmdProjMismatch.taskId, cmdProjMismatch.title);
      const { fp: fpProj, scope: scopeProj } = makeScopeAndFp(cmdProjMismatch);
      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.receipts.insert({
          scope: scopeProj,
          fingerprint: fpProj,
          result: {
            id: cmdProjMismatch.taskId,
            nodeId: "node-1",
            projectId: "different-project",
            title: cmdProjMismatch.title,
            status: "todo",
            assigneePrincipalId: null,
            requiresAcceptance: true,
            reviewerPrincipalId: explicitUser,
            version: 1,
            reviewHistory: [],
          },
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });
      await assert.rejects(handler.execute(cmdProjMismatch), errorCode("VALIDATION_FAILED"), fixture.name);

      // 4. Receipt title mismatch
      const cmdTitleMismatch = taskCmd(tenant, "task-rcpt-title-1", {
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      await insertAuthoritativeTask(cmdTitleMismatch.taskId, cmdTitleMismatch.title);
      const { fp: fpTitle, scope: scopeTitle } = makeScopeAndFp(cmdTitleMismatch);
      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.receipts.insert({
          scope: scopeTitle,
          fingerprint: fpTitle,
          result: {
            id: cmdTitleMismatch.taskId,
            nodeId: "node-1",
            projectId: "proj-1",
            title: "Mismatched Title In Receipt",
            status: "todo",
            assigneePrincipalId: null,
            requiresAcceptance: true,
            reviewerPrincipalId: explicitUser,
            version: 1,
            reviewHistory: [],
          },
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });
      await assert.rejects(handler.execute(cmdTitleMismatch), errorCode("VALIDATION_FAILED"), fixture.name);

      // 5. Receipt requiresAcceptance mismatch (receipt has false while command has true)
      const cmdAccMismatch = taskCmd(tenant, "task-rcpt-acc-1", {
        requiresAcceptance: true,
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      await insertAuthoritativeTask(cmdAccMismatch.taskId, cmdAccMismatch.title);
      const { fp: fpAcc, scope: scopeAcc } = makeScopeAndFp(cmdAccMismatch);
      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.receipts.insert({
          scope: scopeAcc,
          fingerprint: fpAcc,
          result: {
            id: cmdAccMismatch.taskId,
            nodeId: "node-1",
            projectId: "proj-1",
            title: cmdAccMismatch.title,
            status: "todo",
            assigneePrincipalId: null,
            requiresAcceptance: false,
            reviewerPrincipalId: null,
            version: 1,
            reviewHistory: [],
          },
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });
      await assert.rejects(handler.execute(cmdAccMismatch), errorCode("VALIDATION_FAILED"), fixture.name);

      // 6. Receipt status invalid
      const cmdStatusInvalid = taskCmd(tenant, "task-rcpt-status-1", {
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      await insertAuthoritativeTask(cmdStatusInvalid.taskId, cmdStatusInvalid.title);
      const { fp: fpStatus, scope: scopeStatus } = makeScopeAndFp(cmdStatusInvalid);
      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.receipts.insert({
          scope: scopeStatus,
          fingerprint: fpStatus,
          result: {
            id: cmdStatusInvalid.taskId,
            nodeId: "node-1",
            projectId: "proj-1",
            title: cmdStatusInvalid.title,
            status: "invalid_lifecycle_state",
            assigneePrincipalId: null,
            requiresAcceptance: true,
            reviewerPrincipalId: explicitUser,
            version: 1,
            reviewHistory: [],
          },
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });
      await assert.rejects(handler.execute(cmdStatusInvalid), errorCode("VALIDATION_FAILED"), fixture.name);

      // 7. Receipt requiresAcceptance: false but non-null reviewer
      const cmdNoAccRev = taskCmd(tenant, "task-rcpt-noacc-rev-1", {
        requiresAcceptance: false,
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: null,
      });
      await insertAuthoritativeTask(cmdNoAccRev.taskId, cmdNoAccRev.title, false);
      const { fp: fpNoAccRev, scope: scopeNoAccRev } = makeScopeAndFp(cmdNoAccRev);
      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.receipts.insert({
          scope: scopeNoAccRev,
          fingerprint: fpNoAccRev,
          result: {
            id: cmdNoAccRev.taskId,
            nodeId: "node-1",
            projectId: "proj-1",
            title: cmdNoAccRev.title,
            status: "todo",
            assigneePrincipalId: null,
            requiresAcceptance: false,
            reviewerPrincipalId: explicitUser,
            version: 1,
            reviewHistory: [],
          },
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });
      await assert.rejects(handler.execute(cmdNoAccRev), errorCode("VALIDATION_FAILED"), fixture.name);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Direct persistence state progression preserves original creation snapshot on replay", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      await initializeSlotsAndBindings(fixture.persistence, tenant, "proj-1", "reviewer_qa", [candidateA]);

      const handler = new CreateTaskHandler(fixture.persistence);
      const cmd = taskCmd(tenant, "task-progression-test", {
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: "reviewer_qa",
      });

      // 1. Initial creation
      const created = await handler.execute(cmd);
      assert.equal(created.replayed, false);
      assert.equal(created.value.version, 1);
      assert.equal(created.value.status, "todo");
      assert.equal(created.value.reviewerPrincipalId, candidateA);

      // 2. Immediate exact replay returns creation snapshot
      const replayImmediate = await handler.execute(cmd);
      assert.equal(replayImmediate.replayed, true);
      assert.equal(replayImmediate.value.version, 1);
      assert.equal(replayImmediate.value.status, "todo");

      // 3. Subsequent legitimate task state progression in persistence (version 2, in_progress)
      await fixture.persistence.transaction(tenant, async (tx) => {
        const task = await tx.tasks.get(cmd.taskId);
        assert.ok(task);
        await tx.tasks.savePreservingSecurityOwnership(task.id, {
          ...task,
          executionState: "in_progress",
          version: task.version + 1,
        }, task.version);
      });

      // Verify task in persistence is actually at version 2, in_progress
      const currentTask2 = await fixture.persistence.read(tenant, async (tx) => tx.tasks.get(cmd.taskId));
      assert.equal(currentTask2?.version, 2);
      assert.equal(currentTask2?.executionState, "in_progress");

      // 4. Exact replay returns original creation snapshot (version 1, todo) while task is at version 2
      const replayAfterProgression = await handler.execute(cmd);
      assert.equal(replayAfterProgression.replayed, true);
      assert.equal(replayAfterProgression.value.version, 1);
      assert.equal(replayAfterProgression.value.status, "todo");
      assert.equal(replayAfterProgression.value.reviewerPrincipalId, candidateA);

      // 5. Subsequent legitimate progression to version 3 (completed)
      await fixture.persistence.transaction(tenant, async (tx) => {
        const task = await tx.tasks.get(cmd.taskId);
        assert.ok(task);
        await tx.tasks.savePreservingSecurityOwnership(task.id, {
          ...task,
          executionState: "completed",
          version: task.version + 1,
        }, task.version);
      });

      const currentTask3 = await fixture.persistence.read(tenant, async (tx) => tx.tasks.get(cmd.taskId));
      assert.equal(currentTask3?.version, 3);
      assert.equal(currentTask3?.executionState, "completed");

      // 6. Exact replay again returns original creation snapshot (version 1, todo) while task is at version 3
      const replayAfterCompleted = await handler.execute(cmd);
      assert.equal(replayAfterCompleted.replayed, true);
      assert.equal(replayAfterCompleted.value.version, 1);
      assert.equal(replayAfterCompleted.value.status, "todo");
      assert.equal(replayAfterCompleted.value.reviewerPrincipalId, candidateA);

      // 7. If candidateA is subsequently revoked, replay fails closed with REVIEWER_NOT_ELIGIBLE
      await fixture.persistence.transaction(tenant, async (tx) => {
        const p = await tx.principals.get(candidateA);
        assert.ok(p);
        await tx.principals.update({ ...p, status: "revoked", version: p.version + 1, updatedAtUtc: "2026-09-20T11:00:00.000Z" }, p.version);
      });
      await assert.rejects(
        handler.execute(cmd),
        errorCode("REVIEWER_NOT_ELIGIBLE"),
        fixture.name,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Non-null reviewerRoleSlotKey rejected across immediate-base and older-legacy fingerprints, including requiresAcceptance=false", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      const handler = new CreateTaskHandler(fixture.persistence);

      // 1. Immediate-base fingerprint rejection of non-null slot
      const baseCmd = taskCmd(tenant, "task-base-slot-reject", {
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      const baseFp = createHash("sha256").update(JSON.stringify({
        projectId: baseCmd.projectId,
        nodeId: baseCmd.nodeId,
        taskId: baseCmd.taskId,
        title: baseCmd.title,
        assigneePrincipalId: baseCmd.assigneePrincipalId,
        requiresAcceptance: baseCmd.requiresAcceptance,
        reviewerPrincipalId: baseCmd.reviewerPrincipalId,
      })).digest("hex");

      await fixture.persistence.transaction(tenant, async (tx) => {
        const node = await tx.nodes.get("node-1");
        assert.ok(node);
        await tx.tasks.insert({
          tenantId: tenant,
          id: baseCmd.taskId,
          projectId: "proj-1",
          ownerNodeId: "node-1",
          securityDomainId: node.securityDomainId,
          securityEpoch: node.securityEpoch,
          title: baseCmd.title,
          assigneePrincipalId: null,
          requiresAcceptance: true,
          reviewerPrincipalId: explicitUser,
          executionState: "todo",
          reviewState: "not_submitted",
          version: 1,
          deletedAtUtc: null,
        });
        await tx.receipts.insert({
          scope: {
            principalId: baseCmd.principalId,
            operation: "create_task",
            idempotencyKey: baseCmd.idempotencyKey,
          },
          fingerprint: baseFp,
          result: {
            id: baseCmd.taskId,
            nodeId: baseCmd.nodeId,
            title: baseCmd.title,
            status: "todo",
            assigneePrincipalId: null,
            requiresAcceptance: true,
            reviewerPrincipalId: explicitUser,
            version: 1,
            reviewHistory: [],
          },
          createdAtUtc: "2026-09-20T09:00:00.000Z",
        });
      });

      // Replaying with non-null reviewerRoleSlotKey must reject
      await assert.rejects(
        handler.execute({ ...baseCmd, reviewerRoleSlotKey: "reviewer_qa" }),
        errorCode("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD"),
        fixture.name,
      );

      // 2. Older-legacy fingerprint rejection of non-null slot
      const olderCmd = taskCmd(tenant, "task-older-slot-reject", {
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: null,
        assigneePrincipalId: manager,
      });
      const olderFp = createHash("sha256").update(JSON.stringify({
        projectId: olderCmd.projectId,
        nodeId: olderCmd.nodeId,
        taskId: olderCmd.taskId,
        title: olderCmd.title,
        assigneePrincipalId: null,
        requiresAcceptance: true,
      })).digest("hex");

      await fixture.persistence.transaction(tenant, async (tx) => {
        const node = await tx.nodes.get("node-1");
        assert.ok(node);
        await tx.tasks.insert({
          tenantId: tenant,
          id: olderCmd.taskId,
          projectId: "proj-1",
          ownerNodeId: "node-1",
          securityDomainId: node.securityDomainId,
          securityEpoch: node.securityEpoch,
          title: olderCmd.title,
          assigneePrincipalId: manager,
          requiresAcceptance: true,
          reviewerPrincipalId: nodeLeader,
          executionState: "todo",
          reviewState: "not_submitted",
          version: 1,
          deletedAtUtc: null,
        });
        await tx.receipts.insert({
          scope: {
            principalId: olderCmd.principalId,
            operation: "create_task",
            idempotencyKey: olderCmd.idempotencyKey,
          },
          fingerprint: olderFp,
          result: {
            id: olderCmd.taskId,
            nodeId: olderCmd.nodeId,
            title: olderCmd.title,
            status: "todo",
            requiresAcceptance: true,
            reviewerPrincipalId: nodeLeader,
            version: 1,
          },
          createdAtUtc: "2026-09-20T09:00:00.000Z",
        });
      });

      // Replaying with non-null reviewerRoleSlotKey must reject
      await assert.rejects(
        handler.execute({ ...olderCmd, reviewerRoleSlotKey: "reviewer_qa" }),
        errorCode("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD"),
        fixture.name,
      );

      // 3. requiresAcceptance: false command with non-null slot rejects with REVIEWER_NOT_ALLOWED even if receipt exists
      const noAccSlotCmd = taskCmd(tenant, "task-no-acc-slot", {
        requiresAcceptance: false,
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: "reviewer_qa",
      });
      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.receipts.insert({
          scope: {
            principalId: noAccSlotCmd.principalId,
            operation: "create_task",
            idempotencyKey: noAccSlotCmd.idempotencyKey,
          },
          fingerprint: "dummy-fp-slot",
          result: {
            id: noAccSlotCmd.taskId,
            nodeId: "node-1",
            title: noAccSlotCmd.title,
            status: "todo",
            assigneePrincipalId: null,
            requiresAcceptance: false,
            reviewerPrincipalId: null,
            version: 1,
            reviewHistory: [],
          },
          createdAtUtc: "2026-09-20T09:00:00.000Z",
        });
      });
      await assert.rejects(
        handler.execute(noAccSlotCmd),
        errorCode("REVIEWER_NOT_ALLOWED"),
        fixture.name,
      );

      // 4. requiresAcceptance: false command with non-null reviewer rejects with REVIEWER_NOT_ALLOWED even if receipt exists
      const noAccRevCmd = taskCmd(tenant, "task-no-acc-rev", {
        requiresAcceptance: false,
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      await fixture.persistence.transaction(tenant, async (tx) => {
        await tx.receipts.insert({
          scope: {
            principalId: noAccRevCmd.principalId,
            operation: "create_task",
            idempotencyKey: noAccRevCmd.idempotencyKey,
          },
          fingerprint: "dummy-fp-rev",
          result: {
            id: noAccRevCmd.taskId,
            nodeId: "node-1",
            title: noAccRevCmd.title,
            status: "todo",
            assigneePrincipalId: null,
            requiresAcceptance: false,
            reviewerPrincipalId: null,
            version: 1,
            reviewHistory: [],
          },
          createdAtUtc: "2026-09-20T09:00:00.000Z",
        });
      });
      await assert.rejects(
        handler.execute(noAccRevCmd),
        errorCode("REVIEWER_NOT_ALLOWED"),
        fixture.name,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Explicit reviewer eligible-substitution rejected under current and immediate-base fingerprints while intact revoked fails closed", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      const handler = new CreateTaskHandler(fixture.persistence);

      // --- 1. Current fingerprint ---
      const cmdCurr = taskCmd(tenant, "task-explicit-sub-curr", {
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      // 1a. Intact creation
      const resCurr = await handler.execute(cmdCurr);
      assert.equal(resCurr.replayed, false);
      assert.equal(resCurr.value.reviewerPrincipalId, explicitUser);

      // Verify exact replay initially succeeds
      const replayCurrOk = await handler.execute(cmdCurr);
      assert.equal(replayCurrOk.replayed, true);
      assert.equal(replayCurrOk.value.reviewerPrincipalId, explicitUser);

      // 1b. Intact receipt with revoked A:
      await fixture.persistence.transaction(tenant, async (tx) => {
        const p = await tx.principals.get(explicitUser);
        assert.ok(p);
        await tx.principals.update({ ...p, status: "revoked", version: p.version + 1, updatedAtUtc: "2026-09-20T12:00:00.000Z" }, p.version);
      });
      // Replay must fail closed with REVIEWER_NOT_ELIGIBLE
      await assert.rejects(
        handler.execute(cmdCurr),
        errorCode("REVIEWER_NOT_ELIGIBLE"),
        fixture.name,
      );

      // Restore explicitUser to active
      await fixture.persistence.transaction(tenant, async (tx) => {
        const p = await tx.principals.get(explicitUser);
        assert.ok(p);
        await tx.principals.update({ ...p, status: "active", version: p.version + 1, updatedAtUtc: "2026-09-20T12:01:00.000Z" }, p.version);
      });

      // 1c. Corrupted receipt substituting explicitUser with candidateB (who is active and eligible)
      const cmdCurrTampered = taskCmd(tenant, "task-explicit-sub-curr-tampered", {
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      const fpCurrTampered = createHash("sha256").update(JSON.stringify({
        projectId: cmdCurrTampered.projectId,
        nodeId: cmdCurrTampered.nodeId,
        taskId: cmdCurrTampered.taskId,
        title: cmdCurrTampered.title,
        assigneePrincipalId: cmdCurrTampered.assigneePrincipalId,
        requiresAcceptance: cmdCurrTampered.requiresAcceptance,
        reviewerPrincipalId: cmdCurrTampered.reviewerPrincipalId,
        reviewerRoleSlotKey: null,
      })).digest("hex");

      await fixture.persistence.transaction(tenant, async (tx) => {
        const node = await tx.nodes.get("node-1");
        assert.ok(node);
        await tx.tasks.insert({
          tenantId: tenant,
          id: cmdCurrTampered.taskId,
          projectId: "proj-1",
          ownerNodeId: "node-1",
          securityDomainId: node.securityDomainId,
          securityEpoch: node.securityEpoch,
          title: cmdCurrTampered.title,
          assigneePrincipalId: null,
          requiresAcceptance: true,
          reviewerPrincipalId: explicitUser,
          executionState: "todo",
          reviewState: "not_submitted",
          version: 1,
          deletedAtUtc: null,
        });
        await tx.receipts.insert({
          scope: {
            principalId: cmdCurrTampered.principalId,
            operation: "create_task",
            idempotencyKey: cmdCurrTampered.idempotencyKey,
          },
          fingerprint: fpCurrTampered,
          result: {
            id: cmdCurrTampered.taskId,
            nodeId: "node-1",
            title: cmdCurrTampered.title,
            status: "todo",
            assigneePrincipalId: null,
            requiresAcceptance: true,
            reviewerPrincipalId: candidateB, // Substituted with candidateB!
            version: 1,
            reviewHistory: [],
          },
          createdAtUtc: "2026-09-20T12:02:00.000Z",
        });
      });

      // Replay must fail closed with VALIDATION_FAILED, never succeed or accept candidateB
      await assert.rejects(
        handler.execute(cmdCurrTampered),
        errorCode("VALIDATION_FAILED"),
        fixture.name,
      );

      // --- 2. Immediate-base fingerprint ---
      const cmdBase = taskCmd(tenant, "task-explicit-sub-base", {
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      const fpBase = createHash("sha256").update(JSON.stringify({
        projectId: cmdBase.projectId,
        nodeId: cmdBase.nodeId,
        taskId: cmdBase.taskId,
        title: cmdBase.title,
        assigneePrincipalId: cmdBase.assigneePrincipalId,
        requiresAcceptance: cmdBase.requiresAcceptance,
        reviewerPrincipalId: cmdBase.reviewerPrincipalId,
      })).digest("hex");

      // 2a. Intact base receipt with revoked A
      await fixture.persistence.transaction(tenant, async (tx) => {
        const node = await tx.nodes.get("node-1");
        assert.ok(node);
        await tx.tasks.insert({
          tenantId: tenant,
          id: cmdBase.taskId,
          projectId: "proj-1",
          ownerNodeId: "node-1",
          securityDomainId: node.securityDomainId,
          securityEpoch: node.securityEpoch,
          title: cmdBase.title,
          assigneePrincipalId: null,
          requiresAcceptance: true,
          reviewerPrincipalId: explicitUser,
          executionState: "todo",
          reviewState: "not_submitted",
          version: 1,
          deletedAtUtc: null,
        });
        await tx.receipts.insert({
          scope: {
            principalId: cmdBase.principalId,
            operation: "create_task",
            idempotencyKey: cmdBase.idempotencyKey,
          },
          fingerprint: fpBase,
          result: {
            id: cmdBase.taskId,
            nodeId: "node-1",
            title: cmdBase.title,
            status: "todo",
            assigneePrincipalId: null,
            requiresAcceptance: true,
            reviewerPrincipalId: explicitUser,
            version: 1,
            reviewHistory: [],
          },
          createdAtUtc: "2026-09-20T12:03:00.000Z",
        });
      });

      // Revoke explicitUser
      await fixture.persistence.transaction(tenant, async (tx) => {
        const p = await tx.principals.get(explicitUser);
        assert.ok(p);
        await tx.principals.update({ ...p, status: "revoked", version: p.version + 1, updatedAtUtc: "2026-09-20T12:04:00.000Z" }, p.version);
      });

      // Replay base command must fail closed with REVIEWER_NOT_ELIGIBLE
      await assert.rejects(
        handler.execute(cmdBase),
        errorCode("REVIEWER_NOT_ELIGIBLE"),
        fixture.name,
      );

      // Restore explicitUser
      await fixture.persistence.transaction(tenant, async (tx) => {
        const p = await tx.principals.get(explicitUser);
        assert.ok(p);
        await tx.principals.update({ ...p, status: "active", version: p.version + 1, updatedAtUtc: "2026-09-20T12:05:00.000Z" }, p.version);
      });

      // 2b. Corrupt base receipt substituted with eligible candidateB
      const cmdBaseTampered = taskCmd(tenant, "task-explicit-sub-base-tampered", {
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      const fpBaseTampered = createHash("sha256").update(JSON.stringify({
        projectId: cmdBaseTampered.projectId,
        nodeId: cmdBaseTampered.nodeId,
        taskId: cmdBaseTampered.taskId,
        title: cmdBaseTampered.title,
        assigneePrincipalId: cmdBaseTampered.assigneePrincipalId,
        requiresAcceptance: cmdBaseTampered.requiresAcceptance,
        reviewerPrincipalId: cmdBaseTampered.reviewerPrincipalId,
      })).digest("hex");

      await fixture.persistence.transaction(tenant, async (tx) => {
        const node = await tx.nodes.get("node-1");
        assert.ok(node);
        await tx.tasks.insert({
          tenantId: tenant,
          id: cmdBaseTampered.taskId,
          projectId: "proj-1",
          ownerNodeId: "node-1",
          securityDomainId: node.securityDomainId,
          securityEpoch: node.securityEpoch,
          title: cmdBaseTampered.title,
          assigneePrincipalId: null,
          requiresAcceptance: true,
          reviewerPrincipalId: explicitUser,
          executionState: "todo",
          reviewState: "not_submitted",
          version: 1,
          deletedAtUtc: null,
        });
        await tx.receipts.insert({
          scope: {
            principalId: cmdBaseTampered.principalId,
            operation: "create_task",
            idempotencyKey: cmdBaseTampered.idempotencyKey,
          },
          fingerprint: fpBaseTampered,
          result: {
            id: cmdBaseTampered.taskId,
            nodeId: "node-1",
            title: cmdBaseTampered.title,
            status: "todo",
            assigneePrincipalId: null,
            requiresAcceptance: true,
            reviewerPrincipalId: candidateB, // Substituted!
            version: 1,
            reviewHistory: [],
          },
          createdAtUtc: "2026-09-20T12:06:00.000Z",
        });
      });

      // Replay base command must fail closed with VALIDATION_FAILED
      await assert.rejects(
        handler.execute(cmdBaseTampered),
        errorCode("VALIDATION_FAILED"),
        fixture.name,
      );

      // --- 3. Slot-resolved reviewer is NOT bound to null explicit reviewer ---
      await initializeSlotsAndBindings(fixture.persistence, tenant, "proj-1", "reviewer_qa", [candidateA]);
      const cmdSlotResolved = taskCmd(tenant, "task-slot-resolved-ok", {
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: "reviewer_qa",
      });
      const resSlot = await handler.execute(cmdSlotResolved);
      assert.equal(resSlot.replayed, false);
      assert.equal(resSlot.value.reviewerPrincipalId, candidateA);

      // Replay succeeds: resolved reviewer candidateA is NOT rejected for being !== null
      const replaySlot = await handler.execute(cmdSlotResolved);
      assert.equal(replaySlot.replayed, true);
      assert.equal(replaySlot.value.reviewerPrincipalId, candidateA);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Generation-aware receipt validation rejects invalid projectId type and drift", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      const handler = new CreateTaskHandler(fixture.persistence);

      const makeScopeAndFp = (cmd: ReturnType<typeof taskCmd>) => ({
        scope: {
          principalId: cmd.principalId,
          operation: "create_task",
          idempotencyKey: cmd.idempotencyKey,
        },
        fp: createHash("sha256").update(JSON.stringify({
          projectId: cmd.projectId,
          nodeId: cmd.nodeId,
          taskId: cmd.taskId,
          title: cmd.title,
          assigneePrincipalId: cmd.assigneePrincipalId,
          requiresAcceptance: cmd.requiresAcceptance,
          reviewerPrincipalId: cmd.reviewerPrincipalId,
          reviewerRoleSlotKey: null,
        })).digest("hex"),
      });

      const insertTaskAndReceipt = async (taskId: string, receiptProjectId: unknown) => {
        const cmd = taskCmd(tenant, taskId, { reviewerPrincipalId: explicitUser, reviewerRoleSlotKey: null });
        const { scope, fp } = makeScopeAndFp(cmd);
        await fixture.persistence.transaction(tenant, async (tx) => {
          const node = await tx.nodes.get("node-1");
          assert.ok(node);
          await tx.tasks.insert({
            tenantId: tenant,
            id: cmd.taskId,
            projectId: "proj-1",
            ownerNodeId: "node-1",
            securityDomainId: node.securityDomainId,
            securityEpoch: node.securityEpoch,
            title: cmd.title,
            assigneePrincipalId: null,
            requiresAcceptance: true,
            reviewerPrincipalId: explicitUser,
            executionState: "todo",
            reviewState: "not_submitted",
            version: 1,
            deletedAtUtc: null,
          });
          await tx.receipts.insert({
            scope,
            fingerprint: fp,
            result: {
              id: cmd.taskId,
              nodeId: "node-1",
              projectId: receiptProjectId,
              title: cmd.title,
              status: "todo",
              assigneePrincipalId: null,
              requiresAcceptance: true,
              reviewerPrincipalId: explicitUser,
              version: 1,
              reviewHistory: [],
            },
            createdAtUtc: "2026-09-20T10:00:00.000Z",
          });
        });
        return cmd;
      };

      // 1. projectId is number
      const cmdNum = await insertTaskAndReceipt("task-proj-num", 123);
      await assert.rejects(handler.execute(cmdNum), errorCode("VALIDATION_FAILED"), fixture.name);

      // 2. projectId is boolean
      const cmdBool = await insertTaskAndReceipt("task-proj-bool", true);
      await assert.rejects(handler.execute(cmdBool), errorCode("VALIDATION_FAILED"), fixture.name);

      // 3. projectId is object
      const cmdObj = await insertTaskAndReceipt("task-proj-obj", { id: "proj-1" });
      await assert.rejects(handler.execute(cmdObj), errorCode("VALIDATION_FAILED"), fixture.name);

      // 4. projectId is string mismatch
      const cmdMis = await insertTaskAndReceipt("task-proj-mismatch", "wrong-proj");
      await assert.rejects(handler.execute(cmdMis), errorCode("VALIDATION_FAILED"), fixture.name);

      // 5. projectId is matching string -> succeeds
      const cmdValid = await insertTaskAndReceipt("task-proj-valid", "proj-1");
      const resValid = await handler.execute(cmdValid);
      assert.equal(resValid.replayed, true);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Generation-aware receipt validation rejects null-command/non-null-receipt assignee drift for current and base generations", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      const handler = new CreateTaskHandler(fixture.persistence);

      // 1. Current generation: command has assignee: null, receipt has assignee: explicitUser
      const cmdCurr = taskCmd(tenant, "task-assignee-drift-curr", {
        assigneePrincipalId: null,
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      const fpCurr = createHash("sha256").update(JSON.stringify({
        projectId: cmdCurr.projectId,
        nodeId: cmdCurr.nodeId,
        taskId: cmdCurr.taskId,
        title: cmdCurr.title,
        assigneePrincipalId: null,
        requiresAcceptance: true,
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      })).digest("hex");

      await fixture.persistence.transaction(tenant, async (tx) => {
        const node = await tx.nodes.get("node-1");
        assert.ok(node);
        await tx.tasks.insert({
          tenantId: tenant,
          id: cmdCurr.taskId,
          projectId: "proj-1",
          ownerNodeId: "node-1",
          securityDomainId: node.securityDomainId,
          securityEpoch: node.securityEpoch,
          title: cmdCurr.title,
          assigneePrincipalId: null,
          requiresAcceptance: true,
          reviewerPrincipalId: explicitUser,
          executionState: "todo",
          reviewState: "not_submitted",
          version: 1,
          deletedAtUtc: null,
        });
        await tx.receipts.insert({
          scope: {
            principalId: cmdCurr.principalId,
            operation: "create_task",
            idempotencyKey: cmdCurr.idempotencyKey,
          },
          fingerprint: fpCurr,
          result: {
            id: cmdCurr.taskId,
            nodeId: "node-1",
            title: cmdCurr.title,
            status: "todo",
            assigneePrincipalId: explicitUser, // Drift: non-null assignee in receipt!
            requiresAcceptance: true,
            reviewerPrincipalId: explicitUser,
            version: 1,
            reviewHistory: [],
          },
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });
      await assert.rejects(handler.execute(cmdCurr), errorCode("VALIDATION_FAILED"), fixture.name);

      // 2. Immediate-base generation: command has assignee: null, receipt has assignee: explicitUser
      const cmdBase = taskCmd(tenant, "task-assignee-drift-base", {
        assigneePrincipalId: null,
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      const fpBase = createHash("sha256").update(JSON.stringify({
        projectId: cmdBase.projectId,
        nodeId: cmdBase.nodeId,
        taskId: cmdBase.taskId,
        title: cmdBase.title,
        assigneePrincipalId: null,
        requiresAcceptance: true,
        reviewerPrincipalId: explicitUser,
      })).digest("hex");

      await fixture.persistence.transaction(tenant, async (tx) => {
        const node = await tx.nodes.get("node-1");
        assert.ok(node);
        await tx.tasks.insert({
          tenantId: tenant,
          id: cmdBase.taskId,
          projectId: "proj-1",
          ownerNodeId: "node-1",
          securityDomainId: node.securityDomainId,
          securityEpoch: node.securityEpoch,
          title: cmdBase.title,
          assigneePrincipalId: null,
          requiresAcceptance: true,
          reviewerPrincipalId: explicitUser,
          executionState: "todo",
          reviewState: "not_submitted",
          version: 1,
          deletedAtUtc: null,
        });
        await tx.receipts.insert({
          scope: {
            principalId: cmdBase.principalId,
            operation: "create_task",
            idempotencyKey: cmdBase.idempotencyKey,
          },
          fingerprint: fpBase,
          result: {
            id: cmdBase.taskId,
            nodeId: "node-1",
            title: cmdBase.title,
            status: "todo",
            assigneePrincipalId: explicitUser, // Drift!
            requiresAcceptance: true,
            reviewerPrincipalId: explicitUser,
            version: 1,
            reviewHistory: [],
          },
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });
      await assert.rejects(handler.execute(cmdBase), errorCode("VALIDATION_FAILED"), fixture.name);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Current-format creation receipts reject fabricated status, version, and reviewHistory", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      const handler = new CreateTaskHandler(fixture.persistence);

      const makeScopeAndFp = (cmd: ReturnType<typeof taskCmd>) => ({
        scope: {
          principalId: cmd.principalId,
          operation: "create_task",
          idempotencyKey: cmd.idempotencyKey,
        },
        fp: createHash("sha256").update(JSON.stringify({
          projectId: cmd.projectId,
          nodeId: cmd.nodeId,
          taskId: cmd.taskId,
          title: cmd.title,
          assigneePrincipalId: cmd.assigneePrincipalId,
          requiresAcceptance: cmd.requiresAcceptance,
          reviewerPrincipalId: cmd.reviewerPrincipalId,
          reviewerRoleSlotKey: null,
        })).digest("hex"),
      });

      const insertInitialTaskAndReceipt = async (taskId: string, resultOverrides: Record<string, unknown>) => {
        const cmd = taskCmd(tenant, taskId, { reviewerPrincipalId: explicitUser, reviewerRoleSlotKey: null });
        const { scope, fp } = makeScopeAndFp(cmd);
        await fixture.persistence.transaction(tenant, async (tx) => {
          const node = await tx.nodes.get("node-1");
          assert.ok(node);
          await tx.tasks.insert({
            tenantId: tenant,
            id: cmd.taskId,
            projectId: "proj-1",
            ownerNodeId: "node-1",
            securityDomainId: node.securityDomainId,
            securityEpoch: node.securityEpoch,
            title: cmd.title,
            assigneePrincipalId: null,
            requiresAcceptance: true,
            reviewerPrincipalId: explicitUser,
            executionState: "todo",
            reviewState: "not_submitted",
            version: 1,
            deletedAtUtc: null,
          });
          await tx.receipts.insert({
            scope,
            fingerprint: fp,
            result: {
              id: cmd.taskId,
              nodeId: "node-1",
              title: cmd.title,
              status: "todo",
              assigneePrincipalId: null,
              requiresAcceptance: true,
              reviewerPrincipalId: explicitUser,
              version: 1,
              reviewHistory: [],
              ...resultOverrides,
            },
            createdAtUtc: "2026-09-20T10:00:00.000Z",
          });
        });
        return cmd;
      };

      // 1. Fabricated status: "completed" with version 1
      const cmdCompleted = await insertInitialTaskAndReceipt("task-fab-completed", { status: "completed" });
      await assert.rejects(handler.execute(cmdCompleted), errorCode("VALIDATION_FAILED"), fixture.name);

      // 2. Fabricated status: "in_progress" with version 1
      const cmdInProgress = await insertInitialTaskAndReceipt("task-fab-inprog", { status: "in_progress" });
      await assert.rejects(handler.execute(cmdInProgress), errorCode("VALIDATION_FAILED"), fixture.name);

      // 3. Fabricated version: 999999 with status "todo"
      const cmdVer999 = await insertInitialTaskAndReceipt("task-fab-ver999", { version: 999999 });
      await assert.rejects(handler.execute(cmdVer999), errorCode("VALIDATION_FAILED"), fixture.name);

      // 4. Fabricated status: "completed" with version: 999999
      const cmdBoth = await insertInitialTaskAndReceipt("task-fab-both", { status: "completed", version: 999999 });
      await assert.rejects(handler.execute(cmdBoth), errorCode("VALIDATION_FAILED"), fixture.name);

      // 5. Fabricated version: 2 (version must be 1 for a creation snapshot)
      const cmdVer2 = await insertInitialTaskAndReceipt("task-fab-ver2", { version: 2 });
      await assert.rejects(handler.execute(cmdVer2), errorCode("VALIDATION_FAILED"), fixture.name);

      // 6. Fabricated non-empty reviewHistory
      const cmdReviewHist = await insertInitialTaskAndReceipt("task-fab-revhist", {
        reviewHistory: [
          {
            cycleNumber: 1,
            action: "submit_for_review",
            actorPrincipalId: manager,
            reviewerPrincipalId: explicitUser,
            occurredAtUtc: "2026-09-20T10:00:00.000Z",
            note: null,
          },
        ],
      });
      await assert.rejects(handler.execute(cmdReviewHist), errorCode("VALIDATION_FAILED"), fixture.name);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Positive legacy upgrade receipt compatibility for older-legacy and immediate-base generations", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      const handler = new CreateTaskHandler(fixture.persistence);

      // 1. Older-legacy receipt (pre-P0-05A, no reviewHistory, no assignee in receipt result)
      const olderCmd = taskCmd(tenant, "task-pos-older-legacy", {
        assigneePrincipalId: manager,
        requiresAcceptance: false,
        reviewerPrincipalId: null,
        reviewerRoleSlotKey: null,
      });
      const olderFp = createHash("sha256").update(JSON.stringify({
        projectId: olderCmd.projectId,
        nodeId: olderCmd.nodeId,
        taskId: olderCmd.taskId,
        title: olderCmd.title,
        assigneePrincipalId: null, // Legacy hash omitted non-null assignee
        requiresAcceptance: false,
      })).digest("hex");

      await fixture.persistence.transaction(tenant, async (tx) => {
        const node = await tx.nodes.get("node-1");
        assert.ok(node);
        await tx.tasks.insert({
          tenantId: tenant,
          id: olderCmd.taskId,
          projectId: "proj-1",
          ownerNodeId: "node-1",
          securityDomainId: node.securityDomainId,
          securityEpoch: node.securityEpoch,
          title: olderCmd.title,
          assigneePrincipalId: manager,
          requiresAcceptance: false,
          reviewerPrincipalId: null,
          executionState: "todo",
          reviewState: "not_required",
          version: 1,
          deletedAtUtc: null,
        });
        await tx.receipts.insert({
          scope: {
            principalId: olderCmd.principalId,
            operation: "create_task",
            idempotencyKey: olderCmd.idempotencyKey,
          },
          fingerprint: olderFp,
          result: {
            id: olderCmd.taskId,
            nodeId: "node-1",
            title: olderCmd.title,
            status: "todo",
            requiresAcceptance: false,
            version: 1,
            // Notice: no reviewHistory, no assigneePrincipalId (older legacy format)
          },
          createdAtUtc: "2026-09-20T08:00:00.000Z",
        });
      });

      const replayOlder = await handler.execute(olderCmd);
      assert.equal(replayOlder.replayed, true);
      assert.equal(replayOlder.value.id, olderCmd.taskId);
      assert.equal(replayOlder.value.status, "todo");
      assert.equal(replayOlder.value.version, 1);
      assert.equal(replayOlder.value.assigneePrincipalId, null); // Older legacy returns null
      assert.equal(replayOlder.value.reviewerPrincipalId, null);
      assert.deepEqual(replayOlder.value.reviewHistory, []);

      // 2. Immediate-base receipt (9cadf1c)
      const baseCmd = taskCmd(tenant, "task-pos-base-legacy", {
        assigneePrincipalId: manager,
        requiresAcceptance: true,
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      const baseFp = createHash("sha256").update(JSON.stringify({
        projectId: baseCmd.projectId,
        nodeId: baseCmd.nodeId,
        taskId: baseCmd.taskId,
        title: baseCmd.title,
        assigneePrincipalId: baseCmd.assigneePrincipalId,
        requiresAcceptance: true,
        reviewerPrincipalId: explicitUser,
      })).digest("hex");

      await fixture.persistence.transaction(tenant, async (tx) => {
        const node = await tx.nodes.get("node-1");
        assert.ok(node);
        await tx.tasks.insert({
          tenantId: tenant,
          id: baseCmd.taskId,
          projectId: "proj-1",
          ownerNodeId: "node-1",
          securityDomainId: node.securityDomainId,
          securityEpoch: node.securityEpoch,
          title: baseCmd.title,
          assigneePrincipalId: manager,
          requiresAcceptance: true,
          reviewerPrincipalId: explicitUser,
          executionState: "todo",
          reviewState: "not_submitted",
          version: 1,
          deletedAtUtc: null,
        });
        await tx.receipts.insert({
          scope: {
            principalId: baseCmd.principalId,
            operation: "create_task",
            idempotencyKey: baseCmd.idempotencyKey,
          },
          fingerprint: baseFp,
          result: {
            id: baseCmd.taskId,
            nodeId: "node-1",
            title: baseCmd.title,
            status: "todo",
            assigneePrincipalId: manager,
            requiresAcceptance: true,
            reviewerPrincipalId: explicitUser,
            version: 1,
            reviewHistory: [],
          },
          createdAtUtc: "2026-09-20T08:30:00.000Z",
        });
      });

      const replayBase = await handler.execute(baseCmd);
      assert.equal(replayBase.replayed, true);
      assert.equal(replayBase.value.id, baseCmd.taskId);
      assert.equal(replayBase.value.status, "todo");
      assert.equal(replayBase.value.version, 1);
      assert.equal(replayBase.value.assigneePrincipalId, manager);
      assert.equal(replayBase.value.reviewerPrincipalId, explicitUser);
      assert.deepEqual(replayBase.value.reviewHistory, []);

      // 3. Genuine current receipt with null assignee and empty reviewHistory
      const currCmd = taskCmd(tenant, "task-pos-curr-null-assignee", {
        assigneePrincipalId: null,
        requiresAcceptance: true,
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      const currRes = await handler.execute(currCmd);
      assert.equal(currRes.replayed, false);
      const replayCurr = await handler.execute(currCmd);
      assert.equal(replayCurr.replayed, true);
      assert.equal(replayCurr.value.assigneePrincipalId, null);
      assert.equal(replayCurr.value.reviewerPrincipalId, explicitUser);
      assert.deepEqual(replayCurr.value.reviewHistory, []);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Immediate-base creation receipts reject fabricated non-empty and malformed reviewHistory", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      const handler = new CreateTaskHandler(fixture.persistence);

      const makeBaseFpAndScope = (cmd: ReturnType<typeof taskCmd>) => ({
        scope: {
          principalId: cmd.principalId,
          operation: "create_task",
          idempotencyKey: cmd.idempotencyKey,
        },
        fp: createHash("sha256").update(JSON.stringify({
          projectId: cmd.projectId,
          nodeId: cmd.nodeId,
          taskId: cmd.taskId,
          title: cmd.title,
          assigneePrincipalId: cmd.assigneePrincipalId,
          requiresAcceptance: cmd.requiresAcceptance,
          reviewerPrincipalId: cmd.reviewerPrincipalId,
        })).digest("hex"),
      });

      const insertTaskAndReceiptWithHistory = async (taskId: string, reviewHistory: unknown) => {
        const cmd = taskCmd(tenant, taskId, {
          reviewerPrincipalId: explicitUser,
          reviewerRoleSlotKey: null,
        });
        const { scope, fp } = makeBaseFpAndScope(cmd);
        await fixture.persistence.transaction(tenant, async (tx) => {
          const node = await tx.nodes.get("node-1");
          assert.ok(node);
          await tx.tasks.insert({
            tenantId: tenant,
            id: cmd.taskId,
            projectId: "proj-1",
            ownerNodeId: "node-1",
            securityDomainId: node.securityDomainId,
            securityEpoch: node.securityEpoch,
            title: cmd.title,
            assigneePrincipalId: null,
            requiresAcceptance: true,
            reviewerPrincipalId: explicitUser,
            executionState: "todo",
            reviewState: "not_submitted",
            version: 1,
            deletedAtUtc: null,
          });
          await tx.receipts.insert({
            scope,
            fingerprint: fp,
            result: {
              id: cmd.taskId,
              nodeId: "node-1",
              title: cmd.title,
              status: "todo",
              assigneePrincipalId: null,
              requiresAcceptance: true,
              reviewerPrincipalId: explicitUser,
              version: 1,
              reviewHistory,
            },
            createdAtUtc: "2026-09-20T09:00:00.000Z",
          });
        });
        return cmd;
      };

      // 1. Fabricated non-empty reviewHistory in immediate-base receipt
      const cmdNonEmpty = await insertTaskAndReceiptWithHistory("task-base-revhist-nonempty", [
        {
          cycleNumber: 1,
          action: "submitted",
          actorPrincipalId: manager,
          reviewerPrincipalId: explicitUser,
          occurredAtUtc: "2026-09-20T09:00:00.000Z",
          note: null,
        },
      ]);
      await assert.rejects(handler.execute(cmdNonEmpty), errorCode("VALIDATION_FAILED"), fixture.name);

      // 2. Malformed reviewHistory: negative cycleNumber
      const cmdNegCycle = await insertTaskAndReceiptWithHistory("task-base-revhist-neg-cycle", [
        {
          cycleNumber: -1,
          action: "submitted",
          actorPrincipalId: manager,
          reviewerPrincipalId: explicitUser,
          occurredAtUtc: "2026-09-20T09:00:00.000Z",
          note: null,
        },
      ]);
      await assert.rejects(handler.execute(cmdNegCycle), errorCode("VALIDATION_FAILED"), fixture.name);

      // 3. Malformed reviewHistory: zero cycleNumber
      const cmdZeroCycle = await insertTaskAndReceiptWithHistory("task-base-revhist-zero-cycle", [
        {
          cycleNumber: 0,
          action: "submitted",
          actorPrincipalId: manager,
          reviewerPrincipalId: explicitUser,
          occurredAtUtc: "2026-09-20T09:00:00.000Z",
          note: null,
        },
      ]);
      await assert.rejects(handler.execute(cmdZeroCycle), errorCode("VALIDATION_FAILED"), fixture.name);

      // 4. Malformed reviewHistory: invalid action string
      const cmdBadAction = await insertTaskAndReceiptWithHistory("task-base-revhist-bad-action", [
        {
          cycleNumber: 1,
          action: "invalid_action_type",
          actorPrincipalId: manager,
          reviewerPrincipalId: explicitUser,
          occurredAtUtc: "2026-09-20T09:00:00.000Z",
          note: null,
        },
      ]);
      await assert.rejects(handler.execute(cmdBadAction), errorCode("VALIDATION_FAILED"), fixture.name);

      // 5. Malformed reviewHistory: empty actorPrincipalId
      const cmdBadActor = await insertTaskAndReceiptWithHistory("task-base-revhist-bad-actor", [
        {
          cycleNumber: 1,
          action: "submitted",
          actorPrincipalId: "",
          reviewerPrincipalId: explicitUser,
          occurredAtUtc: "2026-09-20T09:00:00.000Z",
          note: null,
        },
      ]);
      await assert.rejects(handler.execute(cmdBadActor), errorCode("VALIDATION_FAILED"), fixture.name);

      // 6. Malformed reviewHistory: empty reviewerPrincipalId
      const cmdBadRev = await insertTaskAndReceiptWithHistory("task-base-revhist-bad-rev", [
        {
          cycleNumber: 1,
          action: "submitted",
          actorPrincipalId: manager,
          reviewerPrincipalId: "   ",
          occurredAtUtc: "2026-09-20T09:00:00.000Z",
          note: null,
        },
      ]);
      await assert.rejects(handler.execute(cmdBadRev), errorCode("VALIDATION_FAILED"), fixture.name);

      // 7. Malformed reviewHistory: invalid non-UTC timestamp
      const cmdBadDate = await insertTaskAndReceiptWithHistory("task-base-revhist-bad-date", [
        {
          cycleNumber: 1,
          action: "submitted",
          actorPrincipalId: manager,
          reviewerPrincipalId: explicitUser,
          occurredAtUtc: "invalid-timestamp",
          note: null,
        },
      ]);
      await assert.rejects(handler.execute(cmdBadDate), errorCode("VALIDATION_FAILED"), fixture.name);

      // 8. Malformed reviewHistory: invalid note type (number)
      const cmdBadNote = await insertTaskAndReceiptWithHistory("task-base-revhist-bad-note", [
        {
          cycleNumber: 1,
          action: "submitted",
          actorPrincipalId: manager,
          reviewerPrincipalId: explicitUser,
          occurredAtUtc: "2026-09-20T09:00:00.000Z",
          note: 99999,
        },
      ]);
      await assert.rejects(handler.execute(cmdBadNote), errorCode("VALIDATION_FAILED"), fixture.name);

      // 9. Malformed reviewHistory: non-object item
      const cmdNonObjItem = await insertTaskAndReceiptWithHistory("task-base-revhist-non-obj", [
        "not-an-object",
      ]);
      await assert.rejects(handler.execute(cmdNonObjItem), errorCode("VALIDATION_FAILED"), fixture.name);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Current and immediate-base receipts reject missing assigneePrincipalId even when command assignee is null", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      const handler = new CreateTaskHandler(fixture.persistence);

      // 1. Current generation: command has assignee: null, receipt omits assigneePrincipalId
      const cmdCurr = taskCmd(tenant, "task-missing-assignee-curr", {
        assigneePrincipalId: null,
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      const fpCurr = createHash("sha256").update(JSON.stringify({
        projectId: cmdCurr.projectId,
        nodeId: cmdCurr.nodeId,
        taskId: cmdCurr.taskId,
        title: cmdCurr.title,
        assigneePrincipalId: null,
        requiresAcceptance: true,
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      })).digest("hex");

      await fixture.persistence.transaction(tenant, async (tx) => {
        const node = await tx.nodes.get("node-1");
        assert.ok(node);
        await tx.tasks.insert({
          tenantId: tenant,
          id: cmdCurr.taskId,
          projectId: "proj-1",
          ownerNodeId: "node-1",
          securityDomainId: node.securityDomainId,
          securityEpoch: node.securityEpoch,
          title: cmdCurr.title,
          assigneePrincipalId: null,
          requiresAcceptance: true,
          reviewerPrincipalId: explicitUser,
          executionState: "todo",
          reviewState: "not_submitted",
          version: 1,
          deletedAtUtc: null,
        });
        await tx.receipts.insert({
          scope: {
            principalId: cmdCurr.principalId,
            operation: "create_task",
            idempotencyKey: cmdCurr.idempotencyKey,
          },
          fingerprint: fpCurr,
          result: {
            id: cmdCurr.taskId,
            nodeId: "node-1",
            title: cmdCurr.title,
            status: "todo",
            // Notice: assigneePrincipalId is completely omitted
            requiresAcceptance: true,
            reviewerPrincipalId: explicitUser,
            version: 1,
            reviewHistory: [],
          },
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });

      // Must reject with VALIDATION_FAILED even though command.assigneePrincipalId is null
      await assert.rejects(handler.execute(cmdCurr), errorCode("VALIDATION_FAILED"), fixture.name);

      // 2. Immediate-base generation: command has assignee: null, receipt omits assigneePrincipalId
      const cmdBase = taskCmd(tenant, "task-missing-assignee-base", {
        assigneePrincipalId: null,
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      const fpBase = createHash("sha256").update(JSON.stringify({
        projectId: cmdBase.projectId,
        nodeId: cmdBase.nodeId,
        taskId: cmdBase.taskId,
        title: cmdBase.title,
        assigneePrincipalId: null,
        requiresAcceptance: true,
        reviewerPrincipalId: explicitUser,
      })).digest("hex");

      await fixture.persistence.transaction(tenant, async (tx) => {
        const node = await tx.nodes.get("node-1");
        assert.ok(node);
        await tx.tasks.insert({
          tenantId: tenant,
          id: cmdBase.taskId,
          projectId: "proj-1",
          ownerNodeId: "node-1",
          securityDomainId: node.securityDomainId,
          securityEpoch: node.securityEpoch,
          title: cmdBase.title,
          assigneePrincipalId: null,
          requiresAcceptance: true,
          reviewerPrincipalId: explicitUser,
          executionState: "todo",
          reviewState: "not_submitted",
          version: 1,
          deletedAtUtc: null,
        });
        await tx.receipts.insert({
          scope: {
            principalId: cmdBase.principalId,
            operation: "create_task",
            idempotencyKey: cmdBase.idempotencyKey,
          },
          fingerprint: fpBase,
          result: {
            id: cmdBase.taskId,
            nodeId: "node-1",
            title: cmdBase.title,
            status: "todo",
            // Notice: assigneePrincipalId is completely omitted
            requiresAcceptance: true,
            reviewerPrincipalId: explicitUser,
            version: 1,
            reviewHistory: [],
          },
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });

      // Must reject with VALIDATION_FAILED even though command.assigneePrincipalId is null
      await assert.rejects(handler.execute(cmdBase), errorCode("VALIDATION_FAILED"), fixture.name);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Current and immediate-base receipts reject missing reviewHistory", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      const handler = new CreateTaskHandler(fixture.persistence);

      // 1. Current generation: receipt omits reviewHistory
      const cmdCurr = taskCmd(tenant, "task-missing-revhist-curr", {
        assigneePrincipalId: null,
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      const fpCurr = createHash("sha256").update(JSON.stringify({
        projectId: cmdCurr.projectId,
        nodeId: cmdCurr.nodeId,
        taskId: cmdCurr.taskId,
        title: cmdCurr.title,
        assigneePrincipalId: null,
        requiresAcceptance: true,
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      })).digest("hex");

      await fixture.persistence.transaction(tenant, async (tx) => {
        const node = await tx.nodes.get("node-1");
        assert.ok(node);
        await tx.tasks.insert({
          tenantId: tenant,
          id: cmdCurr.taskId,
          projectId: "proj-1",
          ownerNodeId: "node-1",
          securityDomainId: node.securityDomainId,
          securityEpoch: node.securityEpoch,
          title: cmdCurr.title,
          assigneePrincipalId: null,
          requiresAcceptance: true,
          reviewerPrincipalId: explicitUser,
          executionState: "todo",
          reviewState: "not_submitted",
          version: 1,
          deletedAtUtc: null,
        });
        await tx.receipts.insert({
          scope: {
            principalId: cmdCurr.principalId,
            operation: "create_task",
            idempotencyKey: cmdCurr.idempotencyKey,
          },
          fingerprint: fpCurr,
          result: {
            id: cmdCurr.taskId,
            nodeId: "node-1",
            title: cmdCurr.title,
            status: "todo",
            assigneePrincipalId: null,
            requiresAcceptance: true,
            reviewerPrincipalId: explicitUser,
            version: 1,
            // Notice: reviewHistory is completely omitted
          },
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });

      await assert.rejects(handler.execute(cmdCurr), errorCode("VALIDATION_FAILED"), fixture.name);

      // 2. Immediate-base generation: receipt omits reviewHistory
      const cmdBase = taskCmd(tenant, "task-missing-revhist-base", {
        assigneePrincipalId: null,
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });
      const fpBase = createHash("sha256").update(JSON.stringify({
        projectId: cmdBase.projectId,
        nodeId: cmdBase.nodeId,
        taskId: cmdBase.taskId,
        title: cmdBase.title,
        assigneePrincipalId: null,
        requiresAcceptance: true,
        reviewerPrincipalId: explicitUser,
      })).digest("hex");

      await fixture.persistence.transaction(tenant, async (tx) => {
        const node = await tx.nodes.get("node-1");
        assert.ok(node);
        await tx.tasks.insert({
          tenantId: tenant,
          id: cmdBase.taskId,
          projectId: "proj-1",
          ownerNodeId: "node-1",
          securityDomainId: node.securityDomainId,
          securityEpoch: node.securityEpoch,
          title: cmdBase.title,
          assigneePrincipalId: null,
          requiresAcceptance: true,
          reviewerPrincipalId: explicitUser,
          executionState: "todo",
          reviewState: "not_submitted",
          version: 1,
          deletedAtUtc: null,
        });
        await tx.receipts.insert({
          scope: {
            principalId: cmdBase.principalId,
            operation: "create_task",
            idempotencyKey: cmdBase.idempotencyKey,
          },
          fingerprint: fpBase,
          result: {
            id: cmdBase.taskId,
            nodeId: "node-1",
            title: cmdBase.title,
            status: "todo",
            assigneePrincipalId: null,
            requiresAcceptance: true,
            reviewerPrincipalId: explicitUser,
            version: 1,
            // Notice: reviewHistory is completely omitted
          },
          createdAtUtc: "2026-09-20T10:00:00.000Z",
        });
      });

      await assert.rejects(handler.execute(cmdBase), errorCode("VALIDATION_FAILED"), fixture.name);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-TASK-005: Command-level lifecycle progression (start -> submit -> accept) preserves original creation snapshot on replay and validates current assignee/reviewer reauthorization", async () => {
  for (const fixture of await fixtures()) {
    try {
      await setupBaseline(fixture.persistence, tenant, "proj-1", "node-1", nodeLeader);
      await executeCreateNode(fixture.persistence, {
        tenantId: tenant,
        commandId: "cmd-create-node-lifecycle",
        idempotencyKey: "idem-create-node-lifecycle",
        correlationId: "corr-lifecycle-node",
        principalId: manager,
        projectId: "proj-1",
        nodeId: "node-lifecycle",
        parentId: null,
        title: "Lifecycle Node",
        leaderPrincipalId: null,
        securityDomainId: null,
        occurredAtUtc: "2026-09-20T10:00:00.000Z",
      });

      const createHandler = new CreateTaskHandler(fixture.persistence);
      const actionHandler = new ActOnTaskHandler(fixture.persistence);

      const cmd = taskCmd(tenant, "task-cmd-lifecycle-test", {
        nodeId: "node-lifecycle",
        assigneePrincipalId: candidateA,
        reviewerPrincipalId: explicitUser,
        reviewerRoleSlotKey: null,
      });

      // 1. Initial creation via CreateTaskHandler
      const created = await createHandler.execute(cmd);
      assert.equal(created.replayed, false);
      assert.equal(created.value.version, 1);
      assert.equal(created.value.status, "todo");
      assert.equal(created.value.assigneePrincipalId, candidateA);
      assert.equal(created.value.reviewerPrincipalId, explicitUser);
      assert.deepEqual(created.value.reviewHistory, []);

      // 2. Immediate exact replay returns original creation snapshot
      const replay1 = await createHandler.execute(cmd);
      assert.equal(replay1.replayed, true);
      assert.equal(replay1.value.version, 1);
      assert.equal(replay1.value.status, "todo");

      // 3. Command-level start via ActOnTaskHandler (assignee candidateA starts)
      const baseAction = {
        tenantId: tenant,
        correlationId: "corr-lifecycle",
        taskId: cmd.taskId,
        assigneePrincipalId: null,
        reviewerPrincipalId: null,
        note: null,
      } as const;

      const started = await actionHandler.execute({
        ...baseAction,
        principalId: candidateA,
        action: "start",
        expectedVersion: 1,
        commandId: "cmd-start-task",
        idempotencyKey: "idem-start-task",
        occurredAtUtc: "2026-09-20T10:01:00.000Z",
      });
      assert.equal(started.replayed, false);
      assert.equal(started.value.version, 2);
      assert.equal(started.value.status, "in_progress");

      // 4. Command-level submit via ActOnTaskHandler (assignee candidateA submits)
      const submitted = await actionHandler.execute({
        ...baseAction,
        principalId: candidateA,
        action: "submit",
        expectedVersion: 2,
        note: "Ready for review",
        commandId: "cmd-submit-task",
        idempotencyKey: "idem-submit-task",
        occurredAtUtc: "2026-09-20T10:02:00.000Z",
      });
      assert.equal(submitted.replayed, false);
      assert.equal(submitted.value.version, 3);
      assert.equal(submitted.value.status, "pending_review");
      assert.equal(submitted.value.reviewHistory.length, 1);

      // 5. Command-level accept via ActOnTaskHandler (reviewer explicitUser accepts)
      const accepted = await actionHandler.execute({
        ...baseAction,
        principalId: explicitUser,
        action: "accept",
        expectedVersion: 3,
        note: "Approved by reviewer",
        commandId: "cmd-accept-task",
        idempotencyKey: "idem-accept-task",
        occurredAtUtc: "2026-09-20T10:03:00.000Z",
      });
      assert.equal(accepted.replayed, false);
      assert.equal(accepted.value.version, 4);
      assert.equal(accepted.value.status, "completed");
      assert.equal(accepted.value.reviewHistory.length, 2);

      // 6. Creation replay against fully completed task (version 4, status completed)
      // MUST preserve and return the original creation snapshot (version 1, todo, empty reviewHistory)
      const replayAfterLifecycle = await createHandler.execute(cmd);
      assert.equal(replayAfterLifecycle.replayed, true);
      assert.equal(replayAfterLifecycle.value.version, 1);
      assert.equal(replayAfterLifecycle.value.status, "todo");
      assert.equal(replayAfterLifecycle.value.assigneePrincipalId, candidateA);
      assert.equal(replayAfterLifecycle.value.reviewerPrincipalId, explicitUser);
      assert.deepEqual(replayAfterLifecycle.value.reviewHistory, []);

      // 7. Current reviewer reauthorization: revoking explicitUser fails closed with REVIEWER_NOT_ELIGIBLE
      await fixture.persistence.transaction(tenant, async (tx) => {
        const p = await tx.principals.get(explicitUser);
        assert.ok(p);
        await tx.principals.update({ ...p, status: "revoked", version: p.version + 1, updatedAtUtc: "2026-09-20T11:00:00.000Z" }, p.version);
      });
      await assert.rejects(createHandler.execute(cmd), errorCode("REVIEWER_NOT_ELIGIBLE"), fixture.name);

      // Restore explicitUser to active
      await fixture.persistence.transaction(tenant, async (tx) => {
        const p = await tx.principals.get(explicitUser);
        assert.ok(p);
        await tx.principals.update({ ...p, status: "active", version: p.version + 1, updatedAtUtc: "2026-09-20T11:01:00.000Z" }, p.version);
      });
      const replayReviewerRestored = await createHandler.execute(cmd);
      assert.equal(replayReviewerRestored.replayed, true);

      // 8. Current assignee reauthorization: revoking candidateA fails closed with ASSIGNEE_NOT_ELIGIBLE
      await fixture.persistence.transaction(tenant, async (tx) => {
        const p = await tx.principals.get(candidateA);
        assert.ok(p);
        await tx.principals.update({ ...p, status: "revoked", version: p.version + 1, updatedAtUtc: "2026-09-20T11:02:00.000Z" }, p.version);
      });
      await assert.rejects(createHandler.execute(cmd), errorCode("ASSIGNEE_NOT_ELIGIBLE"), fixture.name);

      // Restore candidateA principal to active
      await fixture.persistence.transaction(tenant, async (tx) => {
        const p = await tx.principals.get(candidateA);
        assert.ok(p);
        await tx.principals.update({ ...p, status: "active", version: p.version + 1, updatedAtUtc: "2026-09-20T11:03:00.000Z" }, p.version);
      });
      const replayAssigneePrincipalRestored = await createHandler.execute(cmd);
      assert.equal(replayAssigneePrincipalRestored.replayed, true);

      // 9. Current assignee membership revocation: revoking candidateA membership in proj-1 fails closed
      await fixture.persistence.transaction(tenant, async (tx) => {
        const m = await tx.memberships.get("proj-1", candidateA);
        assert.ok(m);
        await tx.memberships.restrictWithSecurityDomains({
          ...m,
          status: "revoked",
          version: m.version + 1,
        }, m.version, "2026-09-20T11:04:00.000Z");
      });
      await assert.rejects(createHandler.execute(cmd), errorCode("ASSIGNEE_NOT_ELIGIBLE"), fixture.name);
    } finally {
      await fixture.cleanup();
    }
  }
});
