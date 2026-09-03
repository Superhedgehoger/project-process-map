import { access, readFile } from "node:fs/promises";

type Manifest = {
  upstreamRepository?: string;
  upstreamCommit?: string;
  reason?: string;
  regressionCoverage?: string[];
  removalCondition?: string;
  packages?: string[];
  compositionFiles?: string[];
  runtimeServices?: string[];
};

const manifestPath = "huly-extension/manifest.json";
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
const baseline = JSON.parse(await readFile(".huly-baseline.json", "utf8")) as {
  platform?: { repository?: string; commit?: string };
};
const failures: string[] = [];

if (manifest.upstreamRepository !== baseline.platform?.repository) failures.push("extension repository must match the accepted baseline");
if (manifest.upstreamCommit !== baseline.platform?.commit) failures.push("extension commit must match the accepted baseline");
if (!manifest.reason) failures.push("patch reason is required");
if (!manifest.removalCondition) failures.push("patch removal condition is required");
if ((manifest.regressionCoverage?.length ?? 0) < 3) failures.push("patch regression coverage is incomplete");
if (manifest.packages?.length !== 4) failures.push("extension must declare four Huly packages");
if (manifest.compositionFiles?.length !== 5) failures.push("extension must declare five composition files");
if (JSON.stringify(manifest.runtimeServices) !== JSON.stringify(["front", "transactor", "workspace"])) {
  failures.push("extension runtime services must include front, transactor and workspace");
}

for (const packagePath of manifest.packages ?? []) {
  try {
    const packageJson = JSON.parse(await readFile(`huly-extension/${packagePath}/package.json`, "utf8")) as {
      name?: string;
      version?: string;
      private?: boolean;
    };
    if (!packageJson.name?.startsWith("@hcengineering/")) failures.push(`invalid package name: ${packagePath}`);
    if (packageJson.version !== "0.7.426") failures.push(`package version must match Huly: ${packagePath}`);
    if (packageJson.private !== true) failures.push(`prototype package must remain private: ${packagePath}`);
  } catch {
    failures.push(`missing or invalid package: ${packagePath}`);
  }
}

for (const path of [
  "huly-extension/plugins/project-process-map/src/index.ts",
  "huly-extension/plugins/project-process-map-resources/src/plugin.ts",
  "huly-extension/plugins/project-process-map-resources/src/index.ts",
  "huly-extension/plugins/project-process-map-resources/src/components/ProjectProcessMapApplication.svelte",
  "huly-extension/plugins/project-process-map-assets/assets/icons.svg",
  "huly-extension/plugins/project-process-map-assets/lang/en.json",
  "huly-extension/plugins/project-process-map-assets/lang/zh.json",
  "huly-extension/models/project-process-map/src/index.ts",
  "huly-extension/models/project-process-map/src/plugin.ts",
]) {
  try {
    await access(path);
  } catch {
    failures.push(`missing extension source: ${path}`);
  }
}

async function requireContent(path: string, expectations: Array<[string, string]>): Promise<void> {
  try {
    const source = await readFile(path, "utf8");
    for (const [needle, message] of expectations) {
      if (!source.includes(needle)) failures.push(`${message}: ${path}`);
    }
  } catch {
    failures.push(`missing verification input: ${path}`);
  }
}

await requireContent("huly-extension/models/project-process-map/src/index.ts", [
  ["alias: projectProcessMapId", "application alias is required"],
  ["hidden: false", "application must be visible"],
  ["position: 'top'", "application must register in the top shell"],
]);

await requireContent("huly-extension/plugins/project-process-map-resources/src/components/ProjectProcessMapApplication.svelte", [
  ["N-06", "six-node shell fixture is required"],
  ["Product API → Huly", "P0-05 authority path label is required"],
  ["apiFetch", "P0-05 shell must use Product API"],
  ["presentation.metadata.Token", "P0-05 shell must delegate the current Huly actor token"],
  ["P0-05 边界", "P0-05 non-goals must remain visible"],
  ["aria-label={`查看${node.title}`}", "node selection must remain accessible"],
]);

await requireContent("huly-extension/plugins/project-process-map-resources/package.json", [
  ["@hcengineering/presentation", "Huly identity and workspace helpers are required"],
]);

await requireContent("packages/adapters/src/huly-rest.ts", [
  ["/api/v1/tx/", "Huly Task adapter must use the locked REST transaction surface"],
  ["/api/v1/find-all/", "Huly Task adapter must support authoritative readback"],
  ["HulyRestTaskFileAdapter", "Huly Attachment adapter is required"],
]);

for (const path of ["packages/domain/src/outbox.ts", "packages/application/src/node-task-file.ts"]) {
  const source = await readFile(path, "utf8");
  if (source.includes("@hcengineering/")) failures.push(`Huly SDK type leaked outside adapter: ${path}`);
}

await requireContent("tools/apply-huly-extension.ts", [
  ["enabled: true", "model composition must explicitly enable the plugin"],
  ["classFilter: [workbench.class.Application]", "model composition must retain the UI class filter"],
  ["lang === 'zh'", "Chinese language loading must be explicit"],
  ["project-process-map-assets/lang/en.json", "unsupported languages must fall back to English"],
  ["webpackChunkName: \"project-process-map\"", "resource loader registration is required"],
]);

await requireContent("infra/huly/compose.shell-prototype.yml", [
  ["project-process-map/huly-front:p0-05", "shell override must use the P0-05 Front image"],
  ["project-process-map/huly-transactor:p0-04", "shell override must use the prototype Transactor image"],
  ["project-process-map/huly-workspace:p0-04", "shell override must use the prototype Workspace image"],
]);

await requireContent("tools/huly-local.sh", [
  ["HULY_COMPOSE_OVERRIDE", "local launcher must accept the shell override"],
  ["compose+=(-f \"$extension_override\")", "shell override must be appended after the digest lock"],
]);

if (failures.length > 0) {
  console.error(JSON.stringify({ status: "blocked", failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: "ok", upstreamCommit: manifest.upstreamCommit, packages: manifest.packages?.length }));
}
