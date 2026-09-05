import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AttachTaskAssetHandler } from "../packages/application/src/assets/attach-task-asset.ts";
import { executeCreateNode } from "../packages/application/src/create-node.ts";
import type { AssetContentPort, PutAssetContent } from "../packages/application/src/ports/integrations.ts";
import type { Persistence } from "../packages/application/src/ports/persistence.ts";
import { CreateTaskHandler } from "../packages/application/src/tasks/create-task.ts";
import { FilesystemAssetContent } from "../packages/adapters/src/filesystem/asset-content.ts";
import { MemoryAssetContent } from "../packages/adapters/src/memory/asset-content.ts";
import { MemoryPersistence } from "../packages/adapters/src/memory/persistence.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import { principalId, tenantId } from "../packages/domain/src/identity.ts";
import { grantProjectMembership } from "./support/project-membership.ts";

const tenant = tenantId("tenant-asset-test");
const principal = principalId("principal-asset-test");
const bytes = new TextEncoder().encode("architecture evidence");
const sha256 = createHash("sha256").update(bytes).digest("hex");

async function prepare(persistence: Persistence): Promise<void> {
  await grantProjectMembership(persistence, tenant, "project-1", principal, { securityDomainIds: ["security-1"] });
  await executeCreateNode(persistence, {
    tenantId: tenant,
    commandId: "node-command",
    idempotencyKey: "node-request",
    correlationId: "correlation-1",
    principalId: principal,
    projectId: "project-1",
    nodeId: "node-1",
    parentId: null,
    title: "方案设计",
    securityDomainId: null,
    occurredAtUtc: "2026-09-04T02:00:00.000Z",
  });
  await new CreateTaskHandler(persistence).execute({
    tenantId: tenant,
    commandId: "task-command",
    idempotencyKey: "task-request",
    correlationId: "correlation-1",
    principalId: principal,
    projectId: "project-1",
    nodeId: "node-1",
    taskId: "task-1",
    title: "提交方案",
    assigneePrincipalId: principal,
    requiresAcceptance: false,
    reviewerPrincipalId: null,
    occurredAtUtc: "2026-09-04T02:01:00.000Z",
  });
}

function command() {
  return {
    tenantId: tenant,
    commandId: "asset-command",
    idempotencyKey: "asset-request",
    correlationId: "correlation-1",
    principalId: principal,
    projectId: "project-1",
    taskId: "task-1",
    assetId: "asset-1",
    displayName: "方案.txt",
    contentType: "text/plain",
    bytes,
    sha256,
    occurredAtUtc: "2026-09-04T02:02:00.000Z",
    deadlineAtUtc: "2026-09-04T02:07:00.000Z",
  } as const;
}

test("ARCH-GATE-ASSET-003 Asset ingest persists lifecycle, binding, stable replica and operation steps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-asset-ingest-"));
  const stores = [new MemoryPersistence(), new SqlitePersistence({ path: join(directory, "asset.sqlite") })];
  try {
    for (const persistence of stores) {
      await prepare(persistence);
      const handler = new AttachTaskAssetHandler(persistence, new MemoryAssetContent(), { scheduleCollaborationProjection: true });
      const created = await handler.execute(command());
      const replay = await handler.execute({ ...command(), commandId: "asset-command-retry" });
      assert.equal(created.value.lifecycleState, "available");
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.value, created.value);
      assert.equal(JSON.stringify(created).includes("externalId"), false);
      const state = await persistence.read(tenant, async (transaction) => ({
        asset: await transaction.assets.get("asset-1"),
        bindings: await transaction.assets.listBindings("task", "task-1"),
        replica: await transaction.externalBindings.getByOwner("asset", "asset-1", "blob_replica"),
      }));
      assert.equal(state.asset?.lifecycleState, "available");
      assert.equal(state.bindings.length, 1);
      assert.deepEqual(Object.keys(state.replica?.reference ?? {}).sort(), ["externalId", "kind", "provider", "schemaVersion"]);
      assert.equal(JSON.stringify(state.replica?.reference).includes("scan"), false);
      assert.equal(JSON.stringify(state.replica?.reference).includes("方案"), false);
    }
  } finally {
    for (const persistence of stores) await persistence.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ARCH-GATE-ASSET-004 failed storage attempt is durable and exact retry converges without duplicate Asset", async () => {
  const persistence = new MemoryPersistence();
  const content = new FailsOnceContent();
  try {
    await prepare(persistence);
    const handler = new AttachTaskAssetHandler(persistence, content);
    await assert.rejects(handler.execute(command()), /temporary storage failure/);
    const failed = await persistence.read(tenant, async (transaction) => await transaction.assets.get("asset-1"));
    assert.equal(failed?.lifecycleState, "failed");
    const recovered = await handler.execute(command());
    assert.equal(recovered.value.lifecycleState, "available");
    assert.equal(content.attempts, 2);
    assert.equal(persistence.snapshot().assets.size, 1);
    const operation = [...persistence.snapshot().operations.values()][0];
    assert.equal(operation?.state, "completed");
    assert.equal(persistence.snapshot().operationSteps.size, 4);
  } finally {
    await persistence.close();
  }
});

test("ARCH-GATE-ASSET-005 filesystem content is idempotent across adapter restart without Docker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-asset-content-"));
  try {
    const input: PutAssetContent = { tenantId: tenant, requestId: "request-1", contentType: "text/plain", bytes, sha256 };
    const first = await new FilesystemAssetContent(directory).put(input);
    const secondAdapter = new FilesystemAssetContent(directory);
    assert.deepEqual(await secondAdapter.put(input), first);
    assert.deepEqual(await secondAdapter.get(first.reference), first);
    await assert.rejects(secondAdapter.put({ ...input, bytes: new TextEncoder().encode("changed"), sha256: createHash("sha256").update("changed").digest("hex") }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

class FailsOnceContent implements AssetContentPort {
  readonly delegate = new MemoryAssetContent();
  attempts = 0;

  async put(input: PutAssetContent) {
    this.attempts += 1;
    if (this.attempts === 1) throw new Error("temporary storage failure");
    return await this.delegate.put(input);
  }

  async get(reference: Parameters<AssetContentPort["get"]>[0]) {
    return await this.delegate.get(reference);
  }

  async read(reference: Parameters<AssetContentPort["read"]>[0]) {
    return await this.delegate.read(reference);
  }

  async remove(reference: Parameters<AssetContentPort["remove"]>[0]) {
    await this.delegate.remove(reference);
  }
}
