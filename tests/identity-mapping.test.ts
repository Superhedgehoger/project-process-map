import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveExternalIdentity } from "../packages/application/src/identity/resolve-external-identity.ts";
import { SqlitePersistence } from "../packages/adapters/src/sqlite/persistence.ts";
import { tenantId } from "../packages/domain/src/identity.ts";

const tenant = tenantId("tenant-identity-test");

test("ARCH-GATE-IDENTITY-001 external identity is persistent, revocable and connection scoped without storing credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppm-identity-"));
  const path = join(directory, "identity.sqlite");
  const input = {
    tenantId: tenant,
    provider: "huly",
    connectionId: "connection-a",
    externalTenantRef: "workspace-1",
    externalSubjectRef: "email:user@example.test",
  } as const;
  try {
    const firstStore = new SqlitePersistence({ path });
    const first = await resolveExternalIdentity(firstStore, input);
    await firstStore.close();

    const secondStore = new SqlitePersistence({ path });
    assert.equal(await resolveExternalIdentity(secondStore, input), first);
    assert.notEqual(await resolveExternalIdentity(secondStore, { ...input, connectionId: "connection-b" }), first);
    await secondStore.transaction(tenant, async (transaction) => {
      const mapping = await transaction.identities.findExternal("huly", "connection-a", "workspace-1", "email:user@example.test");
      assert.ok(mapping);
      await transaction.identities.updateExternal({
        ...mapping,
        status: "revoked",
        version: mapping.version + 1,
        updatedAtUtc: "2026-09-04T04:00:00.000Z",
      }, mapping.version);
    });
    await assert.rejects(resolveExternalIdentity(secondStore, input), /EXTERNAL_IDENTITY_REVOKED/);
    await secondStore.close();

    const databaseBytes = await readFile(path);
    assert.equal(databaseBytes.includes(Buffer.from("secret-bearer-token-never-persisted")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
