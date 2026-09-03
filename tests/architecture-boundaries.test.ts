import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { assertWritableRelationKind } from "../packages/domain/src/project-structure.ts";

test("ARCH-GATE-BOUNDARY-001 domain and application do not depend on adapter implementations", async () => {
  for (const root of ["packages/domain/src", "packages/application/src"]) {
    for (const path of await sourceFiles(root)) {
      const source = await readFile(path, "utf8");
      assert.equal(source.includes("adapters/src"), false, `${path} imports an adapter implementation`);
      assert.equal(source.includes("@hcengineering/"), false, `${path} imports a Huly SDK package`);
    }
  }
});

test("ARCH-GATE-BOUNDARY-002 Huly model and base plugin do not depend on resources implementation", async () => {
  const paths = [
    "huly-extension/models/project-process-map/src/plugin.ts",
    "huly-extension/models/project-process-map/package.json",
    "huly-extension/plugins/project-process-map/src/index.ts",
  ];
  for (const path of paths) {
    const source = await readFile(path, "utf8");
    assert.equal(source.includes("project-process-map-resources"), false, `${path} depends on UI resources internals`);
  }
  const basePlugin = await readFile("huly-extension/plugins/project-process-map/src/index.ts", "utf8");
  assert.match(basePlugin, /ProjectProcessMapApplication/);
});

test("ARCH-GATE-TREE-001 parent-child Relation is rejected because Node.parentId is authoritative", () => {
  assert.doesNotThrow(() => assertWritableRelationKind("predecessor"));
  assert.doesNotThrow(() => assertWritableRelationKind("related"));
  assert.throws(() => assertWritableRelationKind("parent-child"), /PARENT_CHILD_RELATION_IS_DERIVED/);
});

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

