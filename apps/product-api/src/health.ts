import type { HealthReport } from "../../../packages/contracts/src/health.ts";

export function buildHulyConfigurationReport(configured: boolean): HealthReport {
  const components = [
    { component: "product-api", status: "ok" as const, version: "0.0.1" },
    {
      component: "huly-adapter-configuration",
      status: configured ? "ok" as const : "degraded" as const,
      version: "rest-v0.7.426",
    },
  ];
  return {
    status: configured ? "ok" : "degraded",
    checkedAt: new Date().toISOString(),
    components,
  };
}
