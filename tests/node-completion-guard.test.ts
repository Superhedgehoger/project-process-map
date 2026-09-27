import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type ProjectNode,
  completeProjectNode,
  nodeEventSchemas,
} from "../packages/domain/src/project-structure.ts";
import {
  getEventSchema,
  validateEventAgainstSchema,
} from "../packages/domain/src/event-schema-registry.ts";
import { principalId, tenantId, type PrincipalId, type TenantId } from "../packages/domain/src/identity.ts";
import type { DomainEvent } from "../packages/domain/src/events.ts";
import type { ProductTask } from "../packages/domain/src/tasks.ts";
import type { DeliverableRequirement } from "../packages/domain/src/deliverables.ts";
import { ApplicationError, asApplicationError } from "../packages/application/src/errors.ts";
import type {
  CompleteProjectNodeCommand,
  CompleteProjectNodeFailurePoint,
  Persistence,
} from "../packages/application/src/ports/persistence.ts";
import {
  CompleteProjectNodeHandler,
  executeCompleteProjectNode,
} from "../packages/application/src/complete-node.ts";
import { executeAssignNodeLeader } from "../packages/application/src/create-node.ts";
import { createTestMemoryBundle, createTestSqliteBundle } from "./helpers/test-persistence-bundle.ts";
import { grantProjectMembership } from "./support/project-membership.ts";
import { CreateSecurityRootHandler } from "../packages/application/src/security/create-security-root.ts";
import { transitionSecurityMigration, type SecurityDomainMigration } from "../packages/domain/src/security-migration.ts";
import { Script } from "node:vm";
import { createProductApi } from "../apps/product-api/src/app.ts";
import { MemoryAssetContent } from "../packages/adapters/src/memory/asset-content.ts";
import { projectProcessMapBrowserClientSource } from "../packages/api-client/src/project-process-map-client.ts";
import { decodeCommandResult, decodeNode, type ApiNode } from "../packages/contracts/src/project-process-map-api.ts";

const tenant = tenantId("tenant-ncg");
const pm = principalId("pm-principal");
const nodeLeader = principalId("leader-principal");
const reviewer = principalId("reviewer-principal");
const member = principalId("member-principal");
const outsider = principalId("outsider-principal");
const projectId = "project-ncg-1";
const rootNodeId = "node-ncg-root";
const targetNodeId = "node-ncg-target";

type Fixture = {
  name: "memory" | "sqlite";
  persistence: Persistence;
  path?: string;
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
      cleanup: async () => await bundle.persistence.close(),
    };
  }
  const directory = await mkdtemp(join(tmpdir(), "ppm-ncg-"));
  const path = join(directory, "ncg.sqlite");
  const bundle = createTestSqliteBundle({ path, now: options.now });
  return {
    name,
    persistence: bundle.persistence,
    path,
    cleanup: async () => {
      await bundle.persistence.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function setupBaseProject(persistence: Persistence, tId: TenantId = tenant): Promise<void> {
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
      status: "planned",
      completedAtUtc: null,
      completedByPrincipalId: null,
      securityDomainId: null,
      securityEpoch: 1,
      version: 1,
      deletedAtUtc: null,
    };
    await tx.nodes.insert(rootNode);

    const targetNode: ProjectNode = {
      tenantId: tId,
      id: targetNodeId,
      projectId,
      parentId: rootNodeId,
      leaderPrincipalId: null,
      title: "Target WorkPackage",
      kind: "work_package",
      status: "planned",
      completedAtUtc: null,
      completedByPrincipalId: null,
      securityDomainId: null,
      securityEpoch: 1,
      version: 1,
      deletedAtUtc: null,
    };
    await tx.nodes.insert(targetNode);
  });
}

test("P0-05A-T2b-R2F1: node completion error codes normalize as application errors", () => {
  for (const code of [
    "NODE_ALREADY_COMPLETED",
    "NODE_TASKS_NOT_COMPLETED",
    "NODE_DELIVERABLES_NOT_SATISFIED",
  ] as const) {
    const normalized = asApplicationError(new Error(code));
    assert.equal(normalized.code, code);
    assert.notEqual(normalized.code, "UPSTREAM_FAILURE");
  }
});

test("TC-DLV-002: ProjectNode domain status model, completion transition, and event schema", () => {
  const tid = tenantId("t1");
  const pmId = principalId("usr:pm");
  const node: ProjectNode = {
    tenantId: tid,
    id: "node-1",
    projectId: "proj-1",
    parentId: null,
    leaderPrincipalId: null,
    title: "Stage 1",
    kind: "stage",
    status: "planned",
    completedAtUtc: null,
    completedByPrincipalId: null,
    securityDomainId: null,
    securityEpoch: 1,
    version: 1,
    deletedAtUtc: null,
  };

  assert.equal(node.status, "planned");
  assert.equal(node.completedAtUtc, null);
  assert.equal(node.completedByPrincipalId, null);

  const completed = completeProjectNode(node, {
    completedByPrincipalId: pmId,
    occurredAtUtc: "2026-09-26T12:00:00.000Z",
  });

  assert.equal(completed.status, "completed");
  assert.equal(completed.completedAtUtc, "2026-09-26T12:00:00.000Z");
  assert.equal(completed.completedByPrincipalId, pmId);
  assert.equal(completed.version, 2);

  // Attempting to complete already completed node throws
  assert.throws(
    () =>
      completeProjectNode(completed, {
        completedByPrincipalId: pmId,
        occurredAtUtc: "2026-09-26T12:01:00.000Z",
      }),
    /NODE_ALREADY_COMPLETED/,
  );

  // Schema registry verification
  assert.ok(nodeEventSchemas.completed);
  assert.equal(nodeEventSchemas.completed.eventType, "project-map.node.completed");
  assert.equal(nodeEventSchemas.completed.schemaVersion, 1);
  const registered = getEventSchema("project-map.node.completed", 1);
  assert.ok(registered);

  const validEvent: DomainEvent = {
    tenantId: tid,
    eventId: "evt:1",
    projectId: "proj-1",
    projectSequence: 1,
    aggregateType: "project_node",
    aggregateId: node.id,
    aggregateVersion: 2,
    eventType: "project-map.node.completed",
    schemaVersion: 1,
    actorPrincipalId: pmId,
    occurredAtUtc: "2026-09-26T12:00:00.000Z",
    correlationId: "cor-1",
    causationId: "cmd-1",
    originalSecurityDomainId: null,
    originalSecurityEpoch: 1,
    payload: {
      nodeId: node.id,
      completedByPrincipalId: pmId,
      completedAtUtc: "2026-09-26T12:00:00.000Z",
    },
  };

  assert.doesNotThrow(() => validateEventAgainstSchema(validEvent));
});

for (const backend of ["memory", "sqlite"] as const) {
  test(`TC-DLV-002 (${backend}): Happy path - all tasks and deliverables satisfied -> node completed`, async () => {
    const fixture = await createFixture(backend);
    try {
      await setupBaseProject(fixture.persistence);

      // Seed 1 task without review (completed)
      // Seed 1 task with review (accepted)
      // Seed 1 required deliverable (accepted)
      // Seed 1 required deliverable (waived)
      // Seed 1 optional deliverable (pending - should not block)
      await fixture.persistence.transaction(tenant, async (tx) => {
        const task1: ProductTask = {
          tenantId: tenant,
          id: "task-1",
          projectId,
          ownerNodeId: targetNodeId,
          securityDomainId: null,
          securityEpoch: 1,
          title: "Direct task",
          assigneePrincipalId: member,
          requiresAcceptance: false,
          reviewerPrincipalId: null,
          executionState: "completed",
          reviewState: "not_required",
          version: 2,
          deletedAtUtc: null,
        };
        await tx.tasks.insert(task1);

        const task2: ProductTask = {
          tenantId: tenant,
          id: "task-2",
          projectId,
          ownerNodeId: targetNodeId,
          securityDomainId: null,
          securityEpoch: 1,
          title: "Reviewed task",
          assigneePrincipalId: member,
          requiresAcceptance: true,
          reviewerPrincipalId: reviewer,
          executionState: "completed",
          reviewState: "accepted",
          version: 3,
          deletedAtUtc: null,
        };
        await tx.tasks.insert(task2);

        const dlv1: DeliverableRequirement = {
          tenantId: tenant,
          id: "dlv-1",
          projectId,
          ownerNodeId: targetNodeId,
          securityDomainId: null,
          securityEpoch: 1,
          requirementKey: "req-1",
          title: "Design Doc",
          description: null,
          required: true,
          acceptedSourceTypes: ["file"],
          minCount: 1,
          reviewerPrincipalId: reviewer,
          status: "accepted",
          acceptedByPrincipalId: reviewer,
          acceptedAtUtc: "2026-09-26T10:00:00.000Z",
          acceptedReason: null,
          waivedByPrincipalId: null,
          waivedAtUtc: null,
          waivedReason: null,
          version: 3,
          createdAtUtc: "2026-09-26T09:00:00.000Z",
          updatedAtUtc: "2026-09-26T10:00:00.000Z",
          deletedAtUtc: null,
        };
        await tx.deliverables.insert(dlv1);

        const dlv2: DeliverableRequirement = {
          tenantId: tenant,
          id: "dlv-2",
          projectId,
          ownerNodeId: targetNodeId,
          securityDomainId: null,
          securityEpoch: 1,
          requirementKey: "req-2",
          title: "Audit Report",
          description: null,
          required: true,
          acceptedSourceTypes: ["file"],
          minCount: 1,
          reviewerPrincipalId: reviewer,
          status: "waived",
          acceptedByPrincipalId: null,
          acceptedAtUtc: null,
          acceptedReason: null,
          waivedByPrincipalId: pm,
          waivedAtUtc: "2026-09-26T10:30:00.000Z",
          waivedReason: "Waived for milestone release",
          version: 2,
          createdAtUtc: "2026-09-26T09:00:00.000Z",
          updatedAtUtc: "2026-09-26T10:30:00.000Z",
          deletedAtUtc: null,
        };
        await tx.deliverables.insert(dlv2);

        const dlvOpt: DeliverableRequirement = {
          tenantId: tenant,
          id: "dlv-opt",
          projectId,
          ownerNodeId: targetNodeId,
          securityDomainId: null,
          securityEpoch: 1,
          requirementKey: "req-opt",
          title: "Optional Survey",
          description: null,
          required: false,
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
          createdAtUtc: "2026-09-26T09:00:00.000Z",
          updatedAtUtc: "2026-09-26T09:00:00.000Z",
          deletedAtUtc: null,
        };
        await tx.deliverables.insert(dlvOpt);
      });

      const cmd: CompleteProjectNodeCommand = {
        tenantId: tenant,
        commandId: "cmd-complete-1",
        idempotencyKey: "idem-complete-1",
        correlationId: "cor-complete-1",
        principalId: pm,
        projectId,
        nodeId: targetNodeId,
        expectedVersion: 1,
        occurredAtUtc: "2026-09-26T12:00:00.000Z",
      };

      const result = await executeCompleteProjectNode(fixture.persistence, cmd);
      assert.equal(result.replayed, false);
      assert.equal(result.node.status, "completed");
      assert.equal(result.node.completedAtUtc, "2026-09-26T12:00:00.000Z");
      assert.equal(result.node.completedByPrincipalId, pm);
      assert.equal(result.node.version, 2);

      // Event and outbox
      assert.equal(result.event.eventType, "project-map.node.completed");
      assert.equal(result.event.schemaVersion, 1);
      assert.equal(result.event.aggregateId, targetNodeId);
      assert.equal(result.event.aggregateVersion, 2);
      assert.equal(result.event.payload.nodeId, targetNodeId);
      assert.equal(result.event.payload.completedByPrincipalId, pm);
      assert.equal(result.event.payload.completedAtUtc, "2026-09-26T12:00:00.000Z");
      assert.equal(result.outbox.topic, "project-map.node.completed.v1");
      assert.equal(result.outbox.eventId, result.event.eventId);

      // Read back from persistence
      const readBack = await fixture.persistence.read(tenant, async (tx) => {
        return await tx.nodes.get(targetNodeId);
      });
      assert.ok(readBack);
      assert.equal(readBack.status, "completed");
      assert.equal(readBack.completedAtUtc, "2026-09-26T12:00:00.000Z");
      assert.equal(readBack.completedByPrincipalId, pm);
      assert.equal(readBack.version, 2);
    } finally {
      await fixture.cleanup();
    }
  });

  test(`TC-DLV-002 (${backend}): Task guard rejects uncompleted task without durable residue`, async () => {
    const fixture = await createFixture(backend);
    try {
      await setupBaseProject(fixture.persistence);

      await fixture.persistence.transaction(tenant, async (tx) => {
        const incompleteTask: ProductTask = {
          tenantId: tenant,
          id: "task-in-prog",
          projectId,
          ownerNodeId: targetNodeId,
          securityDomainId: null,
          securityEpoch: 1,
          title: "In-progress task",
          assigneePrincipalId: member,
          requiresAcceptance: false,
          reviewerPrincipalId: null,
          executionState: "in_progress",
          reviewState: "not_required",
          version: 1,
          deletedAtUtc: null,
        };
        await tx.tasks.insert(incompleteTask);
      });

      const cmd: CompleteProjectNodeCommand = {
        tenantId: tenant,
        commandId: "cmd-complete-fail-task",
        idempotencyKey: "idem-complete-fail-task",
        correlationId: "cor-fail-task",
        principalId: pm,
        projectId,
        nodeId: targetNodeId,
        expectedVersion: 1,
        occurredAtUtc: "2026-09-26T12:00:00.000Z",
      };

      await assert.rejects(
        () => executeCompleteProjectNode(fixture.persistence, cmd),
        (err: unknown) => {
          assert.ok(err instanceof ApplicationError);
          assert.equal(err.code, "NODE_TASKS_NOT_COMPLETED");
          return true;
        },
      );

      // Verify zero residue
      await fixture.persistence.read(tenant, async (tx) => {
        const node = await tx.nodes.get(targetNodeId);
        assert.ok(node);
        assert.equal(node.status, "planned");
        assert.equal(node.version, 1);
        const events = await tx.events.list(tenant);
        assert.equal(events.filter((e) => e.eventType === "project-map.node.completed").length, 0);
        const outbox = await tx.outbox.list(tenant);
        assert.equal(outbox.filter((o) => o.topic === "project-map.node.completed.v1").length, 0);
        const receipt = await tx.receipts.get({
          principalId: pm,
          operation: "complete_project_node",
          idempotencyKey: cmd.idempotencyKey,
        });
        assert.equal(receipt, undefined);
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test(`P0-05A-T2b-R2F1 (${backend}): canceled and promoted tasks do not block node completion`, async () => {
    const cases: ReadonlyArray<Pick<ProductTask, "executionState" | "requiresAcceptance" | "reviewState"> & { name: string }> = [
      { name: "canceled non-acceptance", executionState: "canceled", requiresAcceptance: false, reviewState: "not_required" },
      { name: "promoted non-acceptance", executionState: "promoted", requiresAcceptance: false, reviewState: "not_required" },
      { name: "canceled acceptance-required", executionState: "canceled", requiresAcceptance: true, reviewState: "not_submitted" },
    ];

    for (const [index, taskCase] of cases.entries()) {
      const fixture = await createFixture(backend);
      try {
        await setupBaseProject(fixture.persistence);
        await fixture.persistence.transaction(tenant, async (tx) => {
          await tx.tasks.insert({
            tenantId: tenant,
            id: `task-terminal-${index}`,
            projectId,
            ownerNodeId: targetNodeId,
            securityDomainId: null,
            securityEpoch: 1,
            title: taskCase.name,
            assigneePrincipalId: member,
            requiresAcceptance: taskCase.requiresAcceptance,
            reviewerPrincipalId: taskCase.requiresAcceptance ? reviewer : null,
            executionState: taskCase.executionState,
            reviewState: taskCase.reviewState,
            version: 2,
            deletedAtUtc: null,
          });
        });

        const result = await executeCompleteProjectNode(fixture.persistence, {
          tenantId: tenant,
          commandId: `cmd-terminal-${index}`,
          idempotencyKey: `idem-terminal-${index}`,
          correlationId: `cor-terminal-${index}`,
          principalId: pm,
          projectId,
          nodeId: targetNodeId,
          expectedVersion: 1,
          occurredAtUtc: "2026-09-26T12:00:00.000Z",
        });
        assert.equal(result.node.status, "completed", taskCase.name);
      } finally {
        await fixture.cleanup();
      }
    }
  });

  test(`TC-DLV-002 (${backend}): Task guard rejects task pending review or rejected`, async () => {
    const fixture = await createFixture(backend);
    try {
      await setupBaseProject(fixture.persistence);

      await fixture.persistence.transaction(tenant, async (tx) => {
        const pendingTask: ProductTask = {
          tenantId: tenant,
          id: "task-pending-review",
          projectId,
          ownerNodeId: targetNodeId,
          securityDomainId: null,
          securityEpoch: 1,
          title: "Task pending review",
          assigneePrincipalId: member,
          requiresAcceptance: true,
          reviewerPrincipalId: reviewer,
          executionState: "in_progress",
          reviewState: "pending",
          version: 2,
          deletedAtUtc: null,
        };
        await tx.tasks.insert(pendingTask);
      });

      const cmd: CompleteProjectNodeCommand = {
        tenantId: tenant,
        commandId: "cmd-pending-review",
        idempotencyKey: "idem-pending-review",
        correlationId: "cor-pending",
        principalId: pm,
        projectId,
        nodeId: targetNodeId,
        expectedVersion: 1,
        occurredAtUtc: "2026-09-26T12:00:00.000Z",
      };

      await assert.rejects(
        () => executeCompleteProjectNode(fixture.persistence, cmd),
        (err: unknown) => {
          assert.ok(err instanceof ApplicationError);
          assert.equal(err.code, "NODE_TASKS_NOT_COMPLETED");
          return true;
        },
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test(`TC-DLV-002 (${backend}): Deliverable guard rejects required deliverable that is pending or submitted`, async () => {
    const fixture = await createFixture(backend);
    try {
      await setupBaseProject(fixture.persistence);

      await fixture.persistence.transaction(tenant, async (tx) => {
        const dlvPending: DeliverableRequirement = {
          tenantId: tenant,
          id: "dlv-pending",
          projectId,
          ownerNodeId: targetNodeId,
          securityDomainId: null,
          securityEpoch: 1,
          requirementKey: "req-pending",
          title: "Pending Deliverable",
          description: null,
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
          createdAtUtc: "2026-09-26T09:00:00.000Z",
          updatedAtUtc: "2026-09-26T09:00:00.000Z",
          deletedAtUtc: null,
        };
        await tx.deliverables.insert(dlvPending);
      });

      const cmd: CompleteProjectNodeCommand = {
        tenantId: tenant,
        commandId: "cmd-dlv-pending",
        idempotencyKey: "idem-dlv-pending",
        correlationId: "cor-dlv-pending",
        principalId: pm,
        projectId,
        nodeId: targetNodeId,
        expectedVersion: 1,
        occurredAtUtc: "2026-09-26T12:00:00.000Z",
      };

      await assert.rejects(
        () => executeCompleteProjectNode(fixture.persistence, cmd),
        (err: unknown) => {
          assert.ok(err instanceof ApplicationError);
          assert.equal(err.code, "NODE_DELIVERABLES_NOT_SATISFIED");
          return true;
        },
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test(`TC-DLV-002 (${backend}): Authorization guard - Node Owner can complete, outsider rejected`, async () => {
    const fixture = await createFixture(backend);
    try {
      await setupBaseProject(fixture.persistence);

      // Assign nodeLeader to targetNode
      await executeAssignNodeLeader(fixture.persistence, {
        tenantId: tenant,
        commandId: "cmd-assign-leader-test",
        idempotencyKey: "idem-assign-leader-test",
        correlationId: "cor-assign-leader",
        principalId: pm,
        projectId,
        nodeId: targetNodeId,
        expectedVersion: 1,
        leaderPrincipalId: nodeLeader,
        occurredAtUtc: "2026-09-26T11:00:00.000Z",
      });

      // Node Owner (nodeLeader) completes node
      const leaderCmd: CompleteProjectNodeCommand = {
        tenantId: tenant,
        commandId: "cmd-leader-complete",
        idempotencyKey: "idem-leader-complete",
        correlationId: "cor-leader",
        principalId: nodeLeader,
        projectId,
        nodeId: targetNodeId,
        expectedVersion: 2,
        occurredAtUtc: "2026-09-26T12:00:00.000Z",
      };

      const result = await executeCompleteProjectNode(fixture.persistence, leaderCmd);
      assert.equal(result.node.status, "completed");
      assert.equal(result.node.completedByPrincipalId, nodeLeader);

      // Non-manager, non-leader member attempts to complete another node
      await fixture.persistence.transaction(tenant, async (tx) => {
        const otherNode: ProjectNode = {
          tenantId: tenant,
          id: "node-other-auth",
          projectId,
          parentId: rootNodeId,
          leaderPrincipalId: null,
          title: "Other Node",
          kind: "work_package",
          status: "planned",
          completedAtUtc: null,
          completedByPrincipalId: null,
          securityDomainId: null,
          securityEpoch: 1,
          version: 1,
          deletedAtUtc: null,
        };
        await tx.nodes.insert(otherNode);
      });

      const memberCmd: CompleteProjectNodeCommand = {
        tenantId: tenant,
        commandId: "cmd-member-fail",
        idempotencyKey: "idem-member-fail",
        correlationId: "cor-member-fail",
        principalId: member,
        projectId,
        nodeId: "node-other-auth",
        expectedVersion: 1,
        occurredAtUtc: "2026-09-26T12:00:00.000Z",
      };

      await assert.rejects(
        () => executeCompleteProjectNode(fixture.persistence, memberCmd),
        (err: unknown) => {
          assert.ok(err instanceof ApplicationError);
          assert.equal(err.code, "FORBIDDEN");
          return true;
        },
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test(`TC-DLV-002 (${backend}): CAS & concurrency - stale version rejected, replay returns same result`, async () => {
    const fixture = await createFixture(backend);
    try {
      await setupBaseProject(fixture.persistence);

      // Stale expectedVersion
      const staleCmd: CompleteProjectNodeCommand = {
        tenantId: tenant,
        commandId: "cmd-stale",
        idempotencyKey: "idem-stale",
        correlationId: "cor-stale",
        principalId: pm,
        projectId,
        nodeId: targetNodeId,
        expectedVersion: 99,
        occurredAtUtc: "2026-09-26T12:00:00.000Z",
      };

      await assert.rejects(
        () => executeCompleteProjectNode(fixture.persistence, staleCmd),
        (err: unknown) => {
          assert.ok(err instanceof ApplicationError);
          assert.equal(err.code, "NODE_VERSION_CONFLICT");
          return true;
        },
      );

      // Legal completion
      const legalCmd: CompleteProjectNodeCommand = {
        tenantId: tenant,
        commandId: "cmd-legal",
        idempotencyKey: "idem-legal",
        correlationId: "cor-legal",
        principalId: pm,
        projectId,
        nodeId: targetNodeId,
        expectedVersion: 1,
        occurredAtUtc: "2026-09-26T12:00:00.000Z",
      };

      const firstResult = await executeCompleteProjectNode(fixture.persistence, legalCmd);
      assert.equal(firstResult.replayed, false);

      // Replay with identical payload returns replayed = true
      const replayResult = await executeCompleteProjectNode(fixture.persistence, legalCmd);
      assert.equal(replayResult.replayed, true);
      assert.equal(replayResult.node.id, firstResult.node.id);
      assert.equal(replayResult.node.version, firstResult.node.version);
      assert.equal(replayResult.event.eventId, firstResult.event.eventId);

      // Replay with different payload returns error
      const tamperCmd: CompleteProjectNodeCommand = {
        ...legalCmd,
        occurredAtUtc: "2026-09-26T13:00:00.000Z",
      };

      await assert.rejects(
        () => executeCompleteProjectNode(fixture.persistence, tamperCmd),
        /IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD/,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test(`TC-DLV-002 (${backend}): Failure injection points roll back completely`, async () => {
    const failurePoints: CompleteProjectNodeFailurePoint[] = [
      "after_aggregate",
      "after_event",
      "after_outbox",
      "after_idempotency",
    ];

    for (const fp of failurePoints) {
      const fixture = await createFixture(backend);
      try {
        await setupBaseProject(fixture.persistence);

        const cmd: CompleteProjectNodeCommand = {
          tenantId: tenant,
          commandId: `cmd-fp-${fp}`,
          idempotencyKey: `idem-fp-${fp}`,
          correlationId: `cor-fp-${fp}`,
          principalId: pm,
          projectId,
          nodeId: targetNodeId,
          expectedVersion: 1,
          occurredAtUtc: "2026-09-26T12:00:00.000Z",
        };

        await assert.rejects(
          () => executeCompleteProjectNode(fixture.persistence, cmd, fp),
          new RegExp(`Injected failure: ${fp}`),
        );

        // Verify zero residue
        await fixture.persistence.read(tenant, async (tx) => {
          const node = await tx.nodes.get(targetNodeId);
          assert.ok(node);
          assert.equal(node.status, "planned");
          assert.equal(node.version, 1);
          assert.equal(node.completedAtUtc, null);
          assert.equal(node.completedByPrincipalId, null);

          const events = await tx.events.list(tenant);
          assert.equal(events.filter((e) => e.eventType === "project-map.node.completed").length, 0);

          const outbox = await tx.outbox.list(tenant);
          assert.equal(outbox.filter((o) => o.topic === "project-map.node.completed.v1").length, 0);

          const receipt = await tx.receipts.get({
            principalId: pm,
            operation: "complete_project_node",
            idempotencyKey: cmd.idempotencyKey,
          });
          assert.equal(receipt, undefined);
        });
      } finally {
        await fixture.cleanup();
      }
    }
  });

  test(`TC-DLV-002 (${backend}): Concurrency race - two concurrent completions, exactly one succeeds`, async () => {
    const fixture = await createFixture(backend);
    try {
      await setupBaseProject(fixture.persistence);

      const cmd1: CompleteProjectNodeCommand = {
        tenantId: tenant,
        commandId: "cmd-race-1",
        idempotencyKey: "idem-race-1",
        correlationId: "cor-race-1",
        principalId: pm,
        projectId,
        nodeId: targetNodeId,
        expectedVersion: 1,
        occurredAtUtc: "2026-09-26T12:00:00.000Z",
      };

      const cmd2: CompleteProjectNodeCommand = {
        tenantId: tenant,
        commandId: "cmd-race-2",
        idempotencyKey: "idem-race-2",
        correlationId: "cor-race-2",
        principalId: pm,
        projectId,
        nodeId: targetNodeId,
        expectedVersion: 1,
        occurredAtUtc: "2026-09-26T12:00:00.000Z",
      };

      const results = await Promise.allSettled([
        executeCompleteProjectNode(fixture.persistence, cmd1),
        executeCompleteProjectNode(fixture.persistence, cmd2),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);

      const rejectedError = (rejected[0] as PromiseRejectedResult).reason;
      assert.ok(rejectedError instanceof ApplicationError);
      assert.equal(rejectedError.code, "NODE_VERSION_CONFLICT");

      // Verify node state in database
      await fixture.persistence.read(tenant, async (tx) => {
        const node = await tx.nodes.get(targetNodeId);
        assert.ok(node);
        assert.equal(node.status, "completed");
        assert.equal(node.version, 2);
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test(`TC-DLV-002 (${backend}): Security domain concealment - unauthorized user gets uniform NODE_NOT_FOUND`, async () => {
    const fixture = await createFixture(backend);
    try {
      await setupBaseProject(fixture.persistence);

      // Create security root on target node
      const rootHandler = new CreateSecurityRootHandler(fixture.persistence);
      await rootHandler.execute({
        tenantId: tenant,
        commandId: "cmd-sec-root",
        idempotencyKey: "idem-sec-root",
        correlationId: "cor-sec-root",
        principalId: pm,
        projectId,
        nodeId: targetNodeId,
        securityDomainId: "sec-dom-guard",
        expectedNodeVersion: 1,
        reason: "Isolate target node",
        occurredAtUtc: "2026-09-26T10:00:00.000Z",
      });

      // Outsider (not even in project) -> NODE_NOT_FOUND
      const outsiderCmd: CompleteProjectNodeCommand = {
        tenantId: tenant,
        commandId: "cmd-outsider-sec",
        idempotencyKey: "idem-outsider-sec",
        correlationId: "cor-outsider-sec",
        principalId: outsider,
        projectId,
        nodeId: targetNodeId,
        expectedVersion: 2,
        occurredAtUtc: "2026-09-26T12:00:00.000Z",
      };

      await assert.rejects(
        () => executeCompleteProjectNode(fixture.persistence, outsiderCmd),
        (err: unknown) => {
          assert.ok(err instanceof ApplicationError);
          assert.equal(err.code, "NODE_NOT_FOUND");
          return true;
        },
      );

      // Project member without grant -> NODE_NOT_FOUND
      const memberCmd: CompleteProjectNodeCommand = {
        tenantId: tenant,
        commandId: "cmd-member-sec",
        idempotencyKey: "idem-member-sec",
        correlationId: "cor-member-sec",
        principalId: member,
        projectId,
        nodeId: targetNodeId,
        expectedVersion: 2,
        occurredAtUtc: "2026-09-26T12:00:00.000Z",
      };

      await assert.rejects(
        () => executeCompleteProjectNode(fixture.persistence, memberCmd),
        (err: unknown) => {
          assert.ok(err instanceof ApplicationError);
          assert.equal(err.code, "NODE_NOT_FOUND");
          return true;
        },
      );

      // The same unauthorized member cannot distinguish wrong-project from correct-project access.
      await assert.rejects(
        () => executeCompleteProjectNode(fixture.persistence, {
          ...memberCmd,
          commandId: "cmd-member-sec-wrong-project",
          idempotencyKey: "idem-member-sec-wrong-project",
          projectId: "wrong-project",
        }),
        (err: unknown) => {
          assert.ok(err instanceof ApplicationError);
          assert.equal(err.code, "NODE_NOT_FOUND");
          return true;
        },
      );

      // A nonexistent node is concealed with the same result.
      await assert.rejects(
        () => executeCompleteProjectNode(fixture.persistence, {
          ...memberCmd,
          commandId: "cmd-member-sec-missing",
          idempotencyKey: "idem-member-sec-missing",
          nodeId: "node-does-not-exist",
        }),
        (err: unknown) => {
          assert.ok(err instanceof ApplicationError);
          assert.equal(err.code, "NODE_NOT_FOUND");
          return true;
        },
      );

      // An actor authorized against the node's authoritative project may receive the mismatch invariant.
      await assert.rejects(
        () => executeCompleteProjectNode(fixture.persistence, {
          ...memberCmd,
          commandId: "cmd-pm-sec-wrong-project",
          idempotencyKey: "idem-pm-sec-wrong-project",
          principalId: pm,
          projectId: "wrong-project",
        }),
        (err: unknown) => {
          assert.ok(err instanceof ApplicationError);
          assert.equal(err.code, "PROJECT_MISMATCH");
          return true;
        },
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test(`TC-DLV-002 (${backend}): Migration freeze - node completion rejected when migration is active`, async () => {
    const fixture = await createFixture(backend);
    try {
      await setupBaseProject(fixture.persistence);

      // Create an active migration on the project
      await fixture.persistence.transaction(tenant, async (tx) => {
        const plannedMigration: SecurityDomainMigration = {
          tenantId: tenant,
          id: "mig-test-1",
          projectId,
          rootNodeId: targetNodeId,
          sourceSecurityDomainId: null,
          targetSecurityDomainId: "sec-dom-target",
          hierarchyRevision: 1,
          sourceSecurityEpoch: 1,
          targetSecurityEpoch: 2,
          state: "planned",
          cursor: null,
          totalItems: 1,
          migratedItems: 0,
          failure: null,
          nextAttemptAtUtc: null,
          deadlineAtUtc: "2026-09-30T00:00:00.000Z",
          version: 1,
          createdAtUtc: "2026-09-26T10:00:00.000Z",
          updatedAtUtc: "2026-09-26T10:00:00.000Z",
        };
        const activeMigration = transitionSecurityMigration(plannedMigration, "active", "2026-09-26T10:30:00.000Z");
        await tx.securityMigrations.insert(plannedMigration);
        await tx.securityMigrations.saveProgressPreservingPlan(activeMigration.id, activeMigration, plannedMigration.version);
      });

      const pmCmd: CompleteProjectNodeCommand = {
        tenantId: tenant,
        commandId: "cmd-freeze",
        idempotencyKey: "idem-freeze",
        correlationId: "cor-freeze",
        principalId: pm,
        projectId,
        nodeId: targetNodeId,
        expectedVersion: 1,
        occurredAtUtc: "2026-09-26T12:00:00.000Z",
      };

      await assert.rejects(
        () => executeCompleteProjectNode(fixture.persistence, pmCmd),
        (err: unknown) => {
          assert.ok(err instanceof ApplicationError);
          assert.equal(err.code, "SECURITY_MIGRATION_IN_PROGRESS");
          return true;
        },
      );
    } finally {
      await fixture.cleanup();
    }
  });
}

test("TC-DLV-002 (sqlite): Restart survival - completed state, events, outbox, and receipt survive database reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-reopen-"));
  const path = join(directory, "reopen.sqlite");
  try {
    const bundle1 = createTestSqliteBundle({ path });
    await setupBaseProject(bundle1.persistence);

    const cmd: CompleteProjectNodeCommand = {
      tenantId: tenant,
      commandId: "cmd-reopen-1",
      idempotencyKey: "idem-reopen-1",
      correlationId: "cor-reopen-1",
      principalId: pm,
      projectId,
      nodeId: targetNodeId,
      expectedVersion: 1,
      occurredAtUtc: "2026-09-26T12:00:00.000Z",
    };

    const firstResult = await executeCompleteProjectNode(bundle1.persistence, cmd);
    assert.equal(firstResult.node.status, "completed");
    assert.equal(firstResult.replayed, false);

    // Close SQLite connection
    await bundle1.persistence.close();

    // Reopen from same file
    const bundle2 = createTestSqliteBundle({ path });
    try {
      await bundle2.persistence.read(tenant, async (tx) => {
        const node = await tx.nodes.get(targetNodeId);
        assert.ok(node);
        assert.equal(node.status, "completed");
        assert.equal(node.completedAtUtc, "2026-09-26T12:00:00.000Z");
        assert.equal(node.completedByPrincipalId, pm);
        assert.equal(node.version, 2);

        const events = await tx.events.list(tenant);
        const completedEvents = events.filter((e) => e.eventType === "project-map.node.completed");
        assert.equal(completedEvents.length, 1);
        assert.equal(completedEvents[0]?.aggregateVersion, 2);

        const outbox = await tx.outbox.list(tenant);
        const completedOutbox = outbox.filter((o) => o.topic === "project-map.node.completed.v1");
        assert.equal(completedOutbox.length, 1);

        const receipt = await tx.receipts.get({
          principalId: pm,
          operation: "complete_project_node",
          idempotencyKey: cmd.idempotencyKey,
        });
        assert.ok(receipt);
      });

      // Replay against reopened database
      const replayResult = await executeCompleteProjectNode(bundle2.persistence, cmd);
      assert.equal(replayResult.replayed, true);
      assert.equal(replayResult.node.id, firstResult.node.id);
      assert.equal(replayResult.node.version, 2);
    } finally {
      await bundle2.persistence.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TC-DLV-002: Product API POST /api/nodes/:nodeId/actions/complete exposes the node completion guard", async () => {
  const assetContent = new MemoryAssetContent();
  const fixture = await createFixture("memory");
  try {
    await setupBaseProject(fixture.persistence);

    // Seed incomplete task
    await fixture.persistence.transaction(tenant, async (tx) => {
      for (const pId of [pm, nodeLeader, member, outsider]) {
        if (pId === outsider) {
          await tx.principals.insert({
            tenantId: tenant,
            id: outsider,
            kind: "user",
            status: "active",
            version: 1,
            createdAtUtc: "2026-09-26T00:00:00.000Z",
            updatedAtUtc: "2026-09-26T00:00:00.000Z",
          });
        }
        await tx.identities.insertExternal({
          tenantId: tenant,
          principalId: pId,
          provider: "huly",
          connectionId: "test",
          externalTenantRef: "workspace-ncg",
          externalSubjectRef: pId,
          status: "active",
          version: 1,
          createdAtUtc: "2026-09-26T00:00:00.000Z",
          updatedAtUtc: "2026-09-26T00:00:00.000Z",
        });
      }

      const task: ProductTask = {
        tenantId: tenant,
        id: "task-incomplete-http",
        projectId,
        ownerNodeId: targetNodeId,
        title: "Incomplete HTTP Task",
        assigneePrincipalId: member,
        requiresAcceptance: false,
        reviewerPrincipalId: null,
        executionState: "in_progress",
        reviewState: "not_required",
        securityDomainId: null,
        securityEpoch: 1,
        version: 1,
        deletedAtUtc: null,
      };
      await tx.tasks.insert(task);
    });

    const app = createProductApi({
      collaborationMode: "huly",
      collaborationProjectionConfigured: true,
      externalIdentityVerifier: {
        authenticate: async (token: string) => ({
          provider: "huly",
          connectionId: "test",
          externalTenantRef: "workspace-ncg",
          externalSubjectRef: token,
        }),
      },
      persistence: fixture.persistence,
      assetContent,
      tenantId: tenant,
    });

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

    // 1. Missing idempotency-key -> 422
    const missingKeyRes = await request(
      "POST",
      `/api/nodes/${targetNodeId}/actions/complete`,
      { authorization: `Bearer ${pm}`, "content-type": "application/json" },
      { expectedVersion: 1 },
    );
    assert.equal(missingKeyRes.status, 422);

    // 2. Incomplete task -> 409 NODE_TASKS_NOT_COMPLETED
    const incompleteRes = await request(
      "POST",
      `/api/nodes/${targetNodeId}/actions/complete`,
      {
        authorization: `Bearer ${pm}`,
        "content-type": "application/json",
        "idempotency-key": "idem-http-fail",
      },
      { expectedVersion: 1 },
    );
    assert.equal(incompleteRes.status, 409);
    assert.equal(incompleteRes.body.code, "NODE_TASKS_NOT_COMPLETED");

    // Complete the task
    await fixture.persistence.transaction(tenant, async (tx) => {
      const task = await tx.tasks.get("task-incomplete-http");
      assert.ok(task);
      await tx.tasks.savePreservingSecurityOwnership(task.id, {
        ...task,
        executionState: "completed",
        version: task.version + 1,
      }, task.version);
    });

    // 3. Unauthorized outsider -> 403 FORBIDDEN
    const outsiderRes = await request(
      "POST",
      `/api/nodes/${targetNodeId}/actions/complete`,
      {
        authorization: `Bearer ${outsider}`,
        "content-type": "application/json",
        "idempotency-key": "idem-http-outsider",
      },
      { expectedVersion: 1 },
    );
    assert.equal(outsiderRes.status, 403);
    assert.equal(outsiderRes.body.code, "FORBIDDEN");

    // 4. Node Owner completion -> 200 OK
    // First assign nodeLeader as owner
    await executeAssignNodeLeader(fixture.persistence, {
      tenantId: tenant,
      commandId: "cmd-al-http",
      idempotencyKey: "idem-al-http",
      correlationId: "cor-al-http",
      principalId: pm,
      projectId,
      nodeId: targetNodeId,
      leaderPrincipalId: nodeLeader,
      expectedVersion: 1,
      occurredAtUtc: "2026-09-26T11:00:00.000Z",
    });

    const completeRes = await request(
      "POST",
      `/api/nodes/${targetNodeId}/actions/complete`,
      {
        authorization: `Bearer ${nodeLeader}`,
        "content-type": "application/json",
        "idempotency-key": "idem-http-owner",
      },
      { expectedVersion: 2 },
    );
    assert.equal(completeRes.status, 200);
    const completedNode = completeRes.body.value as ApiNode;
    assert.equal(completedNode.status, "completed");
    assert.equal(completedNode.completedByPrincipalId, nodeLeader);
    assert.equal(completedNode.version, 3);
    assert.equal(completeRes.body.replayed, false);

    // 5. Replay with same idempotency key -> 200 OK replayed: true
    const replayRes = await request(
      "POST",
      `/api/nodes/${targetNodeId}/actions/complete`,
      {
        authorization: `Bearer ${nodeLeader}`,
        "content-type": "application/json",
        "idempotency-key": "idem-http-owner",
      },
      { expectedVersion: 2 },
    );
    assert.equal(replayRes.status, 200);
    assert.equal(replayRes.body.replayed, true);
    assert.equal((replayRes.body.value as ApiNode).id, targetNodeId);

    // 6. Test browser client completeNode in VM
    const sandbox = {
      globalThis: {} as Record<string, unknown>,
      Headers,
      AbortSignal,
    };
    new Script(projectProcessMapBrowserClientSource).runInNewContext(sandbox);
    const BrowserClient = sandbox.globalThis.ProjectProcessMapBrowserClient as any;

    const client = new BrowserClient({
      baseUrl: "http://product-api.local",
      authorization: () => `Bearer ${nodeLeader}`,
      fetch: async (url: string, init: any) => {
        const path = new URL(url).pathname;
        const res = await request(
          init.method ?? "GET",
          path,
          Object.fromEntries(new Headers(init.headers).entries()),
          init.body ? JSON.parse(init.body) : undefined,
        );
        return {
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          json: async () => res.body,
        };
      },
    });

    const clientReplay = await client.completeNode(
      targetNodeId,
      { expectedVersion: 2 },
      "idem-http-owner",
    );
    assert.equal(clientReplay.replayed, true);
    assert.equal(clientReplay.value.status, "completed");
    assert.equal(clientReplay.value.id, targetNodeId);
  } finally {
    await fixture.cleanup();
  }
});
