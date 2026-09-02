import type { HealthReport } from "../../../packages/contracts/src/health.ts";
import type { FileAdapter, TaskAdapter } from "../../../packages/adapters/src/ports.ts";

export async function buildHealthReport(
  taskAdapter: TaskAdapter,
  fileAdapter: FileAdapter,
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

