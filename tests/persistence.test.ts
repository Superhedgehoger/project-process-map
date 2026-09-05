import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { executeCreateNode, type CreateNodeCommand, type CreateNodeFailurePoint } from "../packages/application/src/create-node.ts";
import type { OutboxConsumer, Persistence } from "../packages/application/src/ports/persistence.ts";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import { principalId, tenantId, type TenantId } from "../packages/domain/src/identity.ts";

const tenantA = tenantId("tenant-a");
const tenantB = tenantId("tenant-b");

function command(tenant: TenantId = tenantA, overrides: Partial<CreateNodeCommand> = {}): CreateNodeCommand {
  return {
    tenantId: tenant,
    commandId: "cmd-1",
    idempotencyKey: "request-1",
    correlationId: "cor-1",
    principalId: principalId("principal-1"),
    projectId: "project-1",
    nodeId: "node-1",
    parentId: null,
    title: "启动",
    securityDomainId: null,
    occurredAtUtc: "2026-09-03T10:00:00.000Z",
    ...overrides,
  };
}

type PersistenceFixture = {
  name: string;
  persistence: Persistence;
  outbox: OutboxConsumer;
  cleanup(): Promise<void>;
};

async function fixtures(): Promise<PersistenceFixture[]> {
  const directory = await mkdtemp(join(tmpdir(), "ppm-persistence-"));
  const memory = new MemoryPersistence();
  const sqlite = new SqlitePersistence({ path: join(directory, "product.sqlite") });
  return [
    { name: "memory", persistence: memory, outbox: memory.outboxConsumer, cleanup: async () => await memory.close() },
    {
      name: "sqlite",
      persistence: sqlite,
      outbox: sqlite.outboxConsumer,
      cleanup: async () => { await sqlite.close(); await rm(directory, { recursive: true, force: true }); },
    },
  ];
}

test("ARCH-GATE-PERSIST-001 memory and SQLite commit tenant-scoped Node, minimal event and Outbox atomically", async () => {
  for (const fixture of await fixtures()) {
    try {
      const result = await executeCreateNode(fixture.persistence, command());
      const node = await fixture.persistence.read(tenantA, async (tx) => await tx.nodes.get("node-1"));
      assert.deepEqual(node, result.node, fixture.name);
      assert.equal(result.event.eventType, "project-map.node.created", fixture.name);
      assert.equal(result.event.schemaVersion, 1, fixture.name);
      assert.deepEqual(result.event.payload, { nodeId: "node-1", parentId: null, title: "启动", kind: "work_package" }, fixture.name);
      assert.equal(JSON.stringify(result.event).includes("before"), false, fixture.name);
      assert.equal(JSON.stringify(result.event).includes("after"), false, fixture.name);
      assert.equal(result.outbox.topic, "project-map.node.created.v1", fixture.name);
      assert.equal(await fixture.outbox.countReady("2026-09-03T10:00:00.000Z"), 1, fixture.name);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("TC-SEC-001 ordinary node creation cannot bypass the atomic first-admin security command", async () => {
  for (const fixture of await fixtures()) {
    try {
      await assert.rejects(
        executeCreateNode(fixture.persistence, command(tenantA, { securityDomainId: "bypass-domain" })),
        (error) => error instanceof Error && "code" in error
          && error.code === "SECURITY_DOMAIN_ASSIGNMENT_REQUIRES_COMMAND",
        fixture.name,
      );
      assert.equal(await fixture.persistence.read(tenantA, async (tx) => await tx.nodes.get("node-1")), undefined, fixture.name);
      assert.equal(await fixture.outbox.countReady("9999-12-31T23:59:59.999Z"), 0, fixture.name);
    } finally {
      await fixture.cleanup();
    }
  }
});

for (const failurePoint of ["after_aggregate", "after_event", "after_outbox", "after_idempotency"] satisfies CreateNodeFailurePoint[]) {
  test(`ARCH-GATE-PERSIST-002 ${failurePoint} rolls back every write in both adapters`, async () => {
    for (const fixture of await fixtures()) {
      try {
        await assert.rejects(executeCreateNode(fixture.persistence, command(), failurePoint), new RegExp(failurePoint));
        assert.equal(await fixture.persistence.read(tenantA, async (tx) => await tx.nodes.get("node-1")), undefined, fixture.name);
        assert.equal(await fixture.persistence.read(tenantA, async (tx) => await tx.sequences.current("project-1")), 0, fixture.name);
        assert.equal(await fixture.outbox.countReady("9999-12-31T23:59:59.999Z"), 0, fixture.name);
      } finally {
        await fixture.cleanup();
      }
    }
  });
}

test("ARCH-GATE-TENANT-001 identical IDs and idempotency keys are isolated by tenant", async () => {
  const persistence = new MemoryPersistence();
  try {
    const first = await executeCreateNode(persistence, command(tenantA));
    const second = await executeCreateNode(persistence, command(tenantB));
    const replay = await executeCreateNode(persistence, command(tenantA, { commandId: "ignored-on-replay" }));
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal((await persistence.read(tenantA, async (tx) => await tx.nodes.listByProject("project-1"))).length, 1);
    assert.equal((await persistence.read(tenantB, async (tx) => await tx.nodes.listByProject("project-1"))).length, 1);
  } finally {
    await persistence.close();
  }
});

test("ARCH-GATE-PERSIST-003 SQLite survives restart and replays the original command receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-restart-"));
  const path = join(directory, "product.sqlite");
  try {
    const firstStore = new SqlitePersistence({ path });
    const first = await executeCreateNode(firstStore, command());
    await firstStore.close();

    const secondStore = new SqlitePersistence({ path });
    const replay = await executeCreateNode(secondStore, command(tenantA, { commandId: "cmd-after-restart", correlationId: "cor-after-restart" }));
    assert.equal(replay.replayed, true);
    assert.deepEqual({ ...replay, replayed: false }, first);
    assert.equal((await secondStore.listEvents(tenantA)).length, 1);
    assert.equal((await secondStore.listOutbox(tenantA)).length, 1);
    await secondStore.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ARCH-GATE-PERSIST-004 two SQLite connections serialize the same command without duplicate facts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-concurrent-"));
  const path = join(directory, "product.sqlite");
  const firstStore = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
  const secondStore = new SqlitePersistence({ path, busyTimeoutMilliseconds: 5_000 });
  try {
    const results = await Promise.all([
      executeCreateNode(firstStore, command()),
      executeCreateNode(secondStore, command(tenantA, { commandId: "cmd-concurrent" })),
    ]);
    assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
    assert.equal((await firstStore.listEvents(tenantA)).length, 1);
    assert.equal((await firstStore.listOutbox(tenantA)).length, 1);
  } finally {
    await firstStore.close();
    await secondStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ARCH-GATE-QUEUE-001 leases prevent duplicate claim, expire safely and reject stale acknowledgement", async () => {
  const persistence = new SqlitePersistence({ path: ":memory:" });
  try {
    await executeCreateNode(persistence, command());
    const first = await persistence.outboxConsumer.claim({
      workerId: "worker-a",
      nowUtc: "2026-09-03T10:00:01.000Z",
      leaseUntilUtc: "2026-09-03T10:01:01.000Z",
      limit: 10,
    });
    assert.equal(first.length, 1);
    assert.equal((await persistence.outboxConsumer.claim({
      workerId: "worker-b",
      nowUtc: "2026-09-03T10:00:02.000Z",
      leaseUntilUtc: "2026-09-03T10:01:02.000Z",
      limit: 10,
    })).length, 0);

    const reclaimed = await persistence.outboxConsumer.claim({
      workerId: "worker-b",
      nowUtc: "2026-09-03T10:01:02.000Z",
      leaseUntilUtc: "2026-09-03T10:02:02.000Z",
      limit: 10,
    });
    assert.equal(reclaimed.length, 1);
    assert.notEqual(reclaimed[0]?.leaseToken, first[0]?.leaseToken);
    assert.equal(await persistence.outboxConsumer.markPublished(
      tenantA, first[0]?.id ?? "", first[0]?.leaseToken ?? "", "2026-09-03T10:01:03.000Z",
    ), false);
    assert.equal(await persistence.outboxConsumer.markPublished(
      tenantA, reclaimed[0]?.id ?? "", reclaimed[0]?.leaseToken ?? "", "2026-09-03T10:01:03.000Z",
    ), true);
    assert.equal(await persistence.outboxConsumer.countReady("9999-12-31T23:59:59.999Z"), 0);
  } finally {
    await persistence.close();
  }
});

test("ARCH-GATE-QUEUE-002 a failed job reaches dead letter and cannot be reclaimed", async () => {
  const persistence = new SqlitePersistence({ path: ":memory:" });
  try {
    await persistence.transaction(tenantA, async (transaction) => {
      await transaction.jobs.schedule({
        tenantId: tenantA,
        id: "job-1",
        jobType: "huly.task.project",
        dedupeKey: "task-1:v1",
        payload: { taskId: "task-1", desiredVersion: 1 },
        state: "pending",
        priority: 10,
        availableAtUtc: "2026-09-03T10:00:00.000Z",
        attempts: 0,
        maxAttempts: 1,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAtUtc: null,
        lastError: null,
        completedAtUtc: null,
        createdAtUtc: "2026-09-03T10:00:00.000Z",
      });
    });
    const claimed = await persistence.jobConsumer.claim({
      workerId: "worker-a",
      nowUtc: "2026-09-03T10:00:01.000Z",
      leaseUntilUtc: "2026-09-03T10:01:01.000Z",
      limit: 1,
    });
    assert.equal(claimed[0]?.attempts, 1);
    assert.equal(await persistence.jobConsumer.release(
      tenantA,
      claimed[0]?.id ?? "",
      claimed[0]?.leaseToken ?? "",
      "2026-09-03T10:02:00.000Z",
      "upstream timeout",
    ), "dead_letter");
    assert.equal((await persistence.listJobs(tenantA))[0]?.state, "dead_letter");
    assert.equal(await persistence.jobConsumer.countReady("9999-12-31T23:59:59.999Z"), 0);
  } finally {
    await persistence.close();
  }
});
