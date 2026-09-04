import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

type PackageManifest = { name: string; version: string; engines?: { node?: string } };

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as PackageManifest;
const releaseRoot = join(root, "dist", "release");
const releaseName = `${manifest.name}-${manifest.version}-node24`;
const staging = join(releaseRoot, releaseName);
const archive = join(releaseRoot, `${releaseName}.tar.gz`);

await rm(releaseRoot, { recursive: true, force: true });
await mkdir(join(staging, "app"), { recursive: true });
await mkdir(join(staging, "bin"), { recursive: true });
await cp(join(root, "dist", "native", "apps"), join(staging, "app", "apps"), { recursive: true });
await cp(join(root, "dist", "native", "packages"), join(staging, "app", "packages"), { recursive: true });

await writeFile(join(staging, "package.json"), `${JSON.stringify({
  name: manifest.name,
  version: manifest.version,
  private: true,
  type: "module",
  engines: manifest.engines,
  scripts: { start: "node app/apps/runtime/src/main.js" },
}, null, 2)}\n`);
await writeFile(join(staging, "VERSION"), `${manifest.version}\n`);
await writeFile(join(staging, "bin", "project-process-map"), `#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/../app/apps/runtime/src/main.js"
`);
await chmod(join(staging, "bin", "project-process-map"), 0o755);
await writeFile(join(staging, "README.txt"), `Project Process Map ${manifest.version}

Runtime requirement: Node.js 24 or later. Docker is not used.
Start: ./bin/project-process-map
Default URL: http://127.0.0.1:4100
Safe bind: HOST=127.0.0.1 PORT=4100 ./bin/project-process-map
Persistent data: PROJECT_DATA_DIR=./data (SQLite database and Asset content)

This architecture-gate package runs without Docker and uses persistent SQLite plus
filesystem Asset content by default. Non-loopback binding is intentionally blocked
until the P0-07 identity/authorization gate is complete. Production SaaS still
requires PostgreSQL, managed object storage, identity, TLS, backup and multi-replica
release gates.
`);

execFileSync("tar", ["-czf", archive, "-C", releaseRoot, releaseName], { stdio: "inherit" });
const sha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
await writeFile(join(releaseRoot, "SHA256SUMS"), `${sha256}  ${basename(archive)}\n`);
console.log(JSON.stringify({ release: archive, sha256, runtime: manifest.engines?.node ?? ">=24" }));
