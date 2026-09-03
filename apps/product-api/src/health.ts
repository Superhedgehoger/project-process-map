import type { HealthReport } from "../../../packages/contracts/src/health.ts";
import type { TaskAdapter, TaskFileAdapter } from "../../../packages/adapters/src/ports.ts";

export async function buildHealthReport(
  taskAdapter: TaskAdapter,
  fileAdapter: TaskFileAdapter,
): Promise<HealthReport> {
  const [tasks, files] = await Promise.all([taskAdapter.health(), fileAdapter.health()]);
  const components = [
    { component: "product-api", status: "ok" as const, version: "0.0.1" },
    { component: "task-adapter", status: tasks, version: "memory" },
    { component: "file-adapter", status: files, version: "memory" },
  ];
  return {
    status: components.every((component) => component.status === "ok") ? "ok" : "degraded",
    checkedAt: new Date().toISOString(),
    components,
  };
}

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
