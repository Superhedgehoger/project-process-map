import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = resolve("artifacts/fixtures");
const nodes = Array.from({ length: 200 }, (_, index) => ({
  id: `node-${String(index + 1).padStart(3, "0")}`,
  title: `脱敏阶段 ${index + 1}`,
  sensitive: index % 17 === 0,
}));
const relations = Array.from({ length: 300 }, (_, index) => ({
  id: `relation-${String(index + 1).padStart(3, "0")}`,
  from: nodes[index % nodes.length]?.id,
  to: nodes[(index * 7 + 1) % nodes.length]?.id,
  type: index % 5 === 0 ? "decision" : "sequence",
}));
const tasks = Array.from({ length: 2_000 }, (_, index) => ({
  id: `task-${String(index + 1).padStart(4, "0")}`,
  nodeId: nodes[index % nodes.length]?.id,
  title: `脱敏任务 ${index + 1}`,
  status: ["todo", "in_progress", "submitted", "completed"][index % 4],
}));
const minimalTemplate = {
  id: "tpl-phase0-signed",
  name: "Phase 0 最小签字模板",
  roleSlots: [{ id: "project-owner", required: true }],
  deliverables: [{ id: "delivery-01", required: true }],
  decisions: [{ id: "decision-01", required: true, execution: "manual" }],
  defaultTasks: [{ id: "default-task-01", acceptanceRequired: true }],
};

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(resolve(outputDirectory, "large-project.json"), JSON.stringify({ nodes, relations, tasks }, null, 2)),
  writeFile(resolve(outputDirectory, "minimal-signed-template.json"), JSON.stringify(minimalTemplate, null, 2)),
]);
console.log(JSON.stringify({ outputDirectory, nodes: nodes.length, relations: relations.length, tasks: tasks.length }));

