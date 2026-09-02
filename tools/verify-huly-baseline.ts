import { readFile } from "node:fs/promises";

type Baseline = {
  platform?: { repository?: string; commit?: string };
  selfhost?: { repository?: string; commit?: string };
  licenseEvidence?: string[];
  deployCommands?: string[];
  decision?: string;
};

const baseline = JSON.parse(await readFile(".huly-baseline.json", "utf8")) as Baseline;
const failures: string[] = [];
for (const [name, repository] of [["platform", baseline.platform], ["selfhost", baseline.selfhost]] as const) {
  if (!repository?.repository?.startsWith("https://github.com/hcengineering/")) failures.push(`${name} repository must be official`);
  if (!/^[0-9a-f]{40}$/.test(repository?.commit ?? "")) failures.push(`${name} commit must be a full SHA`);
}
if ((baseline.licenseEvidence?.length ?? 0) < 2) failures.push("both repository licenses require evidence");
if (!baseline.deployCommands?.length) failures.push("reproducible deploy commands are required");

if (failures.length > 0) {
  console.error(JSON.stringify({ status: "blocked", failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: "candidate-locked", decision: baseline.decision }));
}
