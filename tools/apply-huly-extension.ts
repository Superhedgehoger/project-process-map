import { execFileSync } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type Manifest = {
  upstreamCommit: string;
  packages: string[];
};

const manifest = JSON.parse(await readFile("huly-extension/manifest.json", "utf8")) as Manifest;
const platformDirectory = resolve(process.env.HULY_PLATFORM_DIR ?? "artifacts/huly/platform-p0-04");
const actualCommit = execFileSync("git", ["-C", platformDirectory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (actualCommit !== manifest.upstreamCommit) throw new Error(`unexpected Huly commit: ${actualCommit}`);

function insertAfter(source: string, marker: string, addition: string, identity: string): string {
  if (source.includes(identity)) return source;
  const position = source.indexOf(marker);
  if (position < 0) throw new Error(`composition marker not found: ${marker.slice(0, 60)}`);
  return source.slice(0, position + marker.length) + addition + source.slice(position + marker.length);
}

async function patch(path: string, transform: (source: string) => string): Promise<void> {
  const source = await readFile(path, "utf8");
  const updated = transform(source);
  if (updated !== source) await writeFile(path, updated);
}

for (const packagePath of manifest.packages) {
  await cp(resolve("huly-extension", packagePath), resolve(platformDirectory, packagePath), { recursive: true, force: true });
}

await patch(resolve(platformDirectory, "rush.json"), (source) => insertAfter(
  source,
  `    {\n      "packageName": "@hcengineering/model-inbox",\n      "projectFolder": "models/inbox",\n      "shouldPublish": false\n    },`,
  `\n    {\n      "packageName": "@hcengineering/project-process-map",\n      "projectFolder": "plugins/project-process-map",\n      "shouldPublish": false\n    },\n    {\n      "packageName": "@hcengineering/project-process-map-assets",\n      "projectFolder": "plugins/project-process-map-assets",\n      "shouldPublish": false\n    },\n    {\n      "packageName": "@hcengineering/project-process-map-resources",\n      "projectFolder": "plugins/project-process-map-resources",\n      "shouldPublish": false\n    },\n    {\n      "packageName": "@hcengineering/model-project-process-map",\n      "projectFolder": "models/project-process-map",\n      "shouldPublish": false\n    },`,
  `"packageName": "@hcengineering/project-process-map"`,
));

await patch(resolve(platformDirectory, "models/all/package.json"), (source) => insertAfter(
  source,
  `    "@hcengineering/model-inbox": "workspace:^0.7.426",`,
  `\n    "@hcengineering/model-project-process-map": "workspace:^0.7.426",`,
  `"@hcengineering/model-project-process-map"`,
));

await patch(resolve(platformDirectory, "models/all/src/index.ts"), (source) => {
  let updated = insertAfter(
    source,
    `import { inboxId, createModel as inboxModel } from '@hcengineering/model-inbox'`,
    `\nimport projectProcessMap, { projectProcessMapId, createModel as projectProcessMapModel } from '@hcengineering/model-project-process-map'`,
    `createModel as projectProcessMapModel`,
  );
  updated = insertAfter(
    updated,
    `    [inboxModel, inboxId],`,
    `
    [
      projectProcessMapModel,
      projectProcessMapId,
      {
        label: projectProcessMap.string.ProjectProcessMap,
        enabled: true,
        beta: false,
        icon: projectProcessMap.icon.ProjectProcessMap,
        classFilter: [workbench.class.Application]
      }
    ],`,
    `label: projectProcessMap.string.ProjectProcessMap`,
  );
  return updated;
});

await patch(resolve(platformDirectory, "dev/prod/package.json"), (source) => insertAfter(
  source,
  `    "@hcengineering/inbox-resources": "workspace:^0.7.426",`,
  `\n    "@hcengineering/project-process-map": "workspace:^0.7.426",\n    "@hcengineering/project-process-map-assets": "workspace:^0.7.426",\n    "@hcengineering/project-process-map-resources": "workspace:^0.7.426",`,
  `"@hcengineering/project-process-map-resources"`,
));

await patch(resolve(platformDirectory, "dev/prod/src/platform.ts"), (source) => {
  let updated = insertAfter(
    source,
    `import { inboxId } from '@hcengineering/inbox'`,
    `\nimport { projectProcessMapId } from '@hcengineering/project-process-map'`,
    `from '@hcengineering/project-process-map'`,
  );
  updated = insertAfter(
    updated,
    `import '@hcengineering/inbox-assets'`,
    `\nimport '@hcengineering/project-process-map-assets'`,
    `import '@hcengineering/project-process-map-assets'`,
  );
  updated = insertAfter(
    updated,
    '  addStringsLoader(inboxId, async (lang: string) => await import(`@hcengineering/inbox-assets/lang/${lang}.json`))',
    `
  addStringsLoader(projectProcessMapId, async (lang: string) =>
    lang === 'zh'
      ? await import('@hcengineering/project-process-map-assets/lang/zh.json')
      : await import('@hcengineering/project-process-map-assets/lang/en.json')
  )`,
    'addStringsLoader(projectProcessMapId',
  );
  updated = insertAfter(
    updated,
    `  addLocation(inboxId, async () => await import(/* webpackChunkName: "inbox" */ '@hcengineering/inbox-resources'))`,
    `\n  addLocation(\n    projectProcessMapId,\n    async () => await import(/* webpackChunkName: "project-process-map" */ '@hcengineering/project-process-map-resources')\n  )`,
    `webpackChunkName: "project-process-map"`,
  );
  return updated;
});

console.log(JSON.stringify({ status: "applied", platformDirectory, upstreamCommit: actualCommit, packages: manifest.packages.length }));
