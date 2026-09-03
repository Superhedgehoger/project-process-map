import assert from "node:assert/strict";
import test from "node:test";
import { buildHulyConfigurationReport } from "../apps/product-api/src/health.ts";

test("Product API does not claim Huly health when worker configuration is incomplete", () => {
  const report = buildHulyConfigurationReport(false);
  assert.equal(report.status, "degraded");
  assert.equal(report.components[1]?.component, "huly-adapter-configuration");
});
