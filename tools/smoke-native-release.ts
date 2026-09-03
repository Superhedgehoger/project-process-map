import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

type PackageManifest = { name: string; version: string };
type ReadyMessage = { component?: string; status?: string; url?: string };

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as PackageManifest;
const releaseName = `${manifest.name}-${manifest.version}-node24`;
const releaseRoot = join(root, "dist", "release");
const archive = join(releaseRoot, `${releaseName}.tar.gz`);
const [expectedHash, expectedName] = (await readFile(join(releaseRoot, "SHA256SUMS"), "utf8")).trim().split(/\s+/);
assert.equal(expectedName, basename(archive));
assert.equal(createHash("sha256").update(await readFile(archive)).digest("hex"), expectedHash);

const temporaryRoot = await mkdtemp(join(tmpdir(), "project-process-map-native-"));
const fakeBin = join(temporaryRoot, "fake-bin");
const dockerMarker = join(temporaryRoot, "docker-was-called");
await mkdir(fakeBin);
const fakeDocker = join(fakeBin, "docker");
await writeFile(fakeDocker, `#!/bin/sh\nprintf called > "${dockerMarker}"\nexit 97\n`);
await chmod(fakeDocker, 0o755);

try {
  const tar = spawn("tar", ["-xzf", archive, "-C", temporaryRoot], { stdio: "inherit" });
  assert.equal(await exitCode(tar), 0);
  const installRoot = join(temporaryRoot, releaseName);
  const child = spawn(join(installRoot, "bin", "project-process-map"), [], {
    cwd: installRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      WORKER_HEARTBEAT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  assert.ok(child.stdout);
  const ready = await waitForReady(child, child.stdout, 10_000, () => stderr);
  assert.equal(ready.component, "product-runtime");
  assert.equal(ready.status, "ready");
  assert.ok(ready.url);

  const health = await fetch(`${ready.url}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { adapterMode: string }).adapterMode, "memory");
  const page = await fetch(ready.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /项目过程图谱/);
  const nodes = await fetch(`${ready.url}/api/nodes`);
  assert.equal(nodes.status, 200);
  assert.equal((await nodes.json() as unknown[]).length, 6);

  const created = await fetch(`${ready.url}/api/nodes/N-04/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "native-smoke-task" },
    body: JSON.stringify({ title: "无 Docker 启动验证" }),
  });
  assert.equal(created.status, 201);
  child.kill("SIGTERM");
  assert.equal(await exitCode(child), 0, stderr);
  await assert.rejects(readFile(dockerMarker), { code: "ENOENT" });
  console.log(JSON.stringify({ status: "ok", release: basename(archive), dockerInvoked: false, verticalPath: "page -> nodes -> task" }));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function waitForReady(
  child: ReturnType<typeof spawn>,
  stream: NodeJS.ReadableStream,
  timeoutMilliseconds: number,
  stderr: () => string,
): Promise<ReadyMessage> {
  const lines = createInterface({ input: stream });
  return await new Promise<ReadyMessage>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error("Native runtime did not become ready")), timeoutMilliseconds);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectReady(new Error(`Native runtime exited before ready (${String(code)}): ${stderr()}`));
    });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as ReadyMessage;
        if (message.component !== "product-runtime" || message.status !== "ready") return;
        clearTimeout(timeout);
        lines.close();
        resolveReady(message);
      } catch {
        // Ignore non-JSON startup output and keep waiting for the runtime envelope.
      }
    });
  });
}

async function exitCode(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", resolveExit);
  });
}
