import assert from "node:assert/strict";
import test from "node:test";
import { buildHealthReport } from "../apps/product-api/src/health.ts";
import { InMemoryFileAdapter, InMemoryTaskAdapter } from "../packages/adapters/src/in-memory.ts";

test("Product API reports all Phase 0 memory boundaries", async () => {
  const report = await buildHealthReport(new InMemoryTaskAdapter(), new InMemoryFileAdapter());
  assert.equal(report.status, "ok");
  assert.deepEqual(
    report.components.map((component) => component.component),
    ["product-api", "task-adapter", "file-adapter"],
  );
});

