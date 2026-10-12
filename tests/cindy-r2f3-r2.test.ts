import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile, cp, unlink, readdir } from "node:fs/promises";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CindyOrchestrator,
  CindyState,
  RuntimeArtifactStore,
  ArtifactKind,
  computeAuthoritativeExecutionSnapshot,
  computeExecutionSnapshot,
  computeTreeDigest,
  computeDiffDigest,
  readCanonicalTaskPacketAtCommit,
  evaluateGitAuthority,
  TransitionRejectedError,
  ArtifactValidationError,
  ArtifactDigestMismatchError,
  SymlinkEscapeError,
  PathTraversalError,
  TaskPacketNotCommittedError,
  CINDY_EXECUTION_SNAPSHOT_V1,
  validateScopeEntry,
  CindyStopReason,
  type ReviewResultArtifact,
  type CindyRun,
} from "../tools/cindy/index.ts";

async function createTestEnv(): Promise<{
  repoDir: string;
  bareDir: string;
  baseCommit: string;
  taskId: string;
  runId: string;
  cleanup: () => Promise<void>;
}> {
  const repoDir = await mkdtemp(join(tmpdir(), "cindy-r2-repo-"));
  const bareDir = await mkdtemp(join(tmpdir(), "cindy-r2-bare-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

  git(["init", "-b", "main"]);
  git(["config", "user.name", "Cindy Test"]);
  git(["config", "user.email", "cindy-test@example.com"]);

  await writeFile(
    join(repoDir, ".gitignore"),
    "node_modules/\n.agent/runtime/\n.agent/.cindy-init-staging/\n*.ignored\n*.env\n",
    "utf8"
  );
  await writeFile(join(repoDir, "README.md"), "# Test Repo\n", "utf8");
  await cp(join(process.cwd(), "schemas"), join(repoDir, "schemas"), { recursive: true });

  const taskId = "TEST-TASK-R2";
  const tdir = join(repoDir, ".agent", "tasks", taskId);
  await mkdir(tdir, { recursive: true });

  git(["add", "."]);
  git(["commit", "-m", "chore: initial commit"]);
  const baseCommit = git(["rev-parse", "HEAD"]).trim();

  const taskPacket = {
    taskId,
    status: "READY",
    branch: "main",
    baseCommit,
    allowedScope: ["src/", "schemas/", "tools/", "tests/"],
  };
  await writeFile(join(tdir, "task.json"), JSON.stringify(taskPacket, null, 2), "utf8");

  git(["add", "."]);
  git(["commit", "-m", "chore: add task packet"]);

  execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: bareDir, encoding: "utf8" });
  git(["remote", "add", "origin", bareDir]);
  git(["push", "-u", "-q", "origin", "main"]);

  const runId = "run-r2-001";

  return {
    repoDir,
    bareDir,
    baseCommit,
    taskId,
    runId,
    cleanup: async () => {
      await rm(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(bareDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

async function addExecutionInputs(repoDir: string, taskId: string, ignoredPaths: string[]) {
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
  const tdir = join(repoDir, ".agent", "tasks", taskId);
  await writeFile(
    join(tdir, "execution-inputs.json"),
    JSON.stringify({
      version: "CINDY_EXECUTION_INPUTS_V1",
      taskId,
      ignoredPaths,
    }, null, 2),
    "utf8"
  );
  // Touch task.json so taskAuthorityCommit moves to HEAD
  const taskPath = join(tdir, "task.json");
  const packet = JSON.parse(await readFile(taskPath, "utf8"));
  packet.updatedAt = new Date().toISOString();
  await writeFile(taskPath, JSON.stringify(packet, null, 2), "utf8");
  git(["add", tdir]);
  git(["commit", "-m", "chore: add execution inputs and touch task"]);
  git(["push", "-q"]);
}

async function assertNoSideEffects(
  orchestrator: CindyOrchestrator,
  runId: string,
  initialRun: CindyRun,
  kind: ArtifactKind,
  cycle: number,
  repoDir: string
) {
  const store = orchestrator.artifactStore;
  const artifactPath = store.getArtifactPath(runId, kind, cycle);
  assert.equal(existsSync(artifactPath), false, `formal artifact must be ABSENT at ${artifactPath}`);

  const currentRun = await orchestrator.getRun(runId);
  assert.equal(currentRun.version, initialRun.version, "run version must be UNCHANGED");
  assert.equal(currentRun.currentCycle, initialRun.currentCycle, "cycle must be UNCHANGED");
  assert.deepEqual(currentRun.history, initialRun.history, "history must be UNCHANGED");

  const runDir = join(repoDir, ".agent", "runtime", runId);
  if (existsSync(runDir)) {
    const files = await readdir(runDir);
    const tempFiles = files.filter((f) => f.startsWith(".tmp") || f.includes(".tmp_"));
    assert.equal(tempFiles.length, 0, `temp artifacts must be ABSENT, found: ${tempFiles.join(", ")}`);
  }

  // Lock must be released
  const lock = await store.acquireRunLock(runId);
  await store.releaseRunLock(runDir, lock.ownerId);
}

describe("R2F3-R2 Comprehensive Test Probes (1-35)", () => {
  // =========================================================================
  // HIGH R1-H01: Immutable Authority Context & Final Authority Fence (1-5)
  // =========================================================================

  test("TEST 1: capture HEAD=A, barrier HEAD->B, A Task allowedScope=A_SCOPE, B Task allowedScope=B_SCOPE -> actualHead=A, TaskPacket=B, authority ok=true rejected", async () => {
    const env = await createTestEnv();
    try {
      const git = (args: string[]) => execFileSync("git", args, { cwd: env.repoDir, encoding: "utf8" });
      const commitA = git(["rev-parse", "HEAD"]).trim();

      // Commit B: update task packet with different scope
      const taskPath = join(env.repoDir, ".agent", "tasks", env.taskId, "task.json");
      const packetB = JSON.parse(await readFile(taskPath, "utf8"));
      packetB.allowedScope = ["other-scope/"];
      await writeFile(taskPath, JSON.stringify(packetB, null, 2), "utf8");
      git(["add", taskPath]);
      git(["commit", "-m", "commit B"]);
      const commitB = git(["rev-parse", "HEAD"]).trim();
      assert.notEqual(commitA, commitB);

      // Verify readCanonicalTaskPacketAtCommit anchored to commit A reads A_SCOPE
      const packetAtA = readCanonicalTaskPacketAtCommit(env.repoDir, env.taskId, commitA);
      assert.deepEqual(packetAtA?.allowedScope, ["src/", "schemas/", "tools/", "tests/"]);

      // Verify readCanonicalTaskPacketAtCommit anchored to commit B reads B_SCOPE
      const packetAtB = readCanonicalTaskPacketAtCommit(env.repoDir, env.taskId, commitB);
      assert.deepEqual(packetAtB?.allowedScope, ["other-scope/"]);

      // Evaluating authority bound to commit A while live HEAD is at commit B must fail closed
      const evalResult = evaluateGitAuthority({
        repoDir: env.repoDir,
        taskId: env.taskId,
        runSnapshot: {
          branch: "main",
          headCommit: commitA,
          baseCommit: env.baseCommit,
          taskAuthorityCommit: commitA,
          upstreamSha: commitA,
          upstreamRef: "refs/remotes/origin/main",
          upstreamCommit: commitA,
          allowedScope: ["src/", "schemas/", "tools/", "tests/"],
        },
      });

      assert.equal(evalResult.ok, false);
      assert.match(evalResult.stopExplanation ?? "", /headCommit drifted|drif/i);
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 2: A Task exists, HEAD->B, B Task deleted -> A authority + B missing state cannot mix", async () => {
    const env = await createTestEnv();
    try {
      const git = (args: string[]) => execFileSync("git", args, { cwd: env.repoDir, encoding: "utf8" });
      const commitA = git(["rev-parse", "HEAD"]).trim();

      // Commit B deletes task packet
      const taskPath = join(env.repoDir, ".agent", "tasks", env.taskId, "task.json");
      git(["rm", taskPath]);
      git(["commit", "-m", "delete task packet at B"]);
      const commitB = git(["rev-parse", "HEAD"]).trim();

      // Read at A returns packet; read at B throws TaskPacketNotCommittedError
      const packetAtA = readCanonicalTaskPacketAtCommit(env.repoDir, env.taskId, commitA);
      assert.ok(packetAtA);
      assert.equal(packetAtA.taskId, env.taskId);

      assert.throws(
        () => readCanonicalTaskPacketAtCommit(env.repoDir, env.taskId, commitB),
        (err: unknown) => err instanceof TaskPacketNotCommittedError
      );

      // Authority bound to A when live HEAD is B cannot mix states: fails closed
      const evalResult = evaluateGitAuthority({
        repoDir: env.repoDir,
        taskId: env.taskId,
        runSnapshot: {
          branch: "main",
          headCommit: commitA,
          baseCommit: env.baseCommit,
          taskAuthorityCommit: commitA,
          upstreamSha: commitA,
          upstreamRef: "refs/remotes/origin/main",
          upstreamCommit: commitA,
          allowedScope: ["src/"],
        },
      });
      assert.equal(evalResult.ok, false);
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 3: A task history and B task history different -> authority cannot mix", async () => {
    const env = await createTestEnv();
    try {
      const git = (args: string[]) => execFileSync("git", args, { cwd: env.repoDir, encoding: "utf8" });
      const commitA = git(["rev-parse", "HEAD"]).trim();

      // Update task packet reviewHistory at commit B
      const taskPath = join(env.repoDir, ".agent", "tasks", env.taskId, "task.json");
      const packet = JSON.parse(await readFile(taskPath, "utf8"));
      packet.reviewHistory = [{ review: "Review 1", verdict: "FAIL" }];
      await writeFile(taskPath, JSON.stringify(packet, null, 2), "utf8");
      git(["add", taskPath]);
      git(["commit", "-m", "add review history at commit B"]);
      const commitB = git(["rev-parse", "HEAD"]).trim();

      const packetAtA = readCanonicalTaskPacketAtCommit(env.repoDir, env.taskId, commitA);
      const packetAtB = readCanonicalTaskPacketAtCommit(env.repoDir, env.taskId, commitB);
      assert.equal(packetAtA?.reviewHistory, undefined);
      assert.equal((packetAtB?.reviewHistory as any[])?.length, 1);
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 4: Task authority commit must be last modifier reachable from A, not current symbolic HEAD", async () => {
    const env = await createTestEnv();
    try {
      const git = (args: string[]) => execFileSync("git", args, { cwd: env.repoDir, encoding: "utf8" });
      const commitA = git(["rev-parse", "HEAD"]).trim();

      // Commit B modifies task.json
      const taskPath = join(env.repoDir, ".agent", "tasks", env.taskId, "task.json");
      const packet = JSON.parse(await readFile(taskPath, "utf8"));
      packet.description = "updated at B";
      await writeFile(taskPath, JSON.stringify(packet, null, 2), "utf8");
      git(["add", taskPath]);
      git(["commit", "-m", "modify task.json at B"]);
      const commitB = git(["rev-parse", "HEAD"]).trim();

      // Task authority anchored to commit A using git log -1 <commitA> -- taskPath
      const logA = git(["log", "-1", "--format=%H", commitA, "--", `.agent/tasks/${env.taskId}/task.json`]).trim();
      const logB = git(["log", "-1", "--format=%H", commitB, "--", `.agent/tasks/${env.taskId}/task.json`]).trim();

      assert.equal(logA, commitA);
      assert.equal(logB, commitB);
      assert.notEqual(logA, logB);
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 5: final fence: branch/upstream drift even if HEAD same -> reject", async () => {
    const env = await createTestEnv();
    try {
      const git = (args: string[]) => execFileSync("git", args, { cwd: env.repoDir, encoding: "utf8" });
      const currentHead = git(["rev-parse", "HEAD"]).trim();

      // Upstream tracking ref is changed (drift) without changing HEAD
      git(["update-ref", "refs/remotes/origin/main", "HEAD~1"]);

      const evalResult = evaluateGitAuthority({
        repoDir: env.repoDir,
        taskId: env.taskId,
        runSnapshot: {
          branch: "main",
          headCommit: currentHead,
          baseCommit: env.baseCommit,
          taskAuthorityCommit: currentHead,
          upstreamSha: currentHead,
          upstreamRef: "refs/remotes/origin/main",
          upstreamCommit: currentHead,
          allowedScope: ["src/"],
        },
      });

      assert.equal(evalResult.ok, false);
      assert.match(evalResult.stopExplanation ?? "", /upstream drift detected|upstreamCommit drifted|upstreamSha drifted/i);
    } finally {
      await env.cleanup();
    }
  });

  // =========================================================================
  // HIGH R1-H02: Filesystem Identity Overrides Status Deletion (6-9)
  // =========================================================================

  test("TEST 6: tracked retain.env, git rm --cached retain.env, retain.env remains on filesystem -> snapshot digest changes when file content changes", async () => {
    const env = await createTestEnv();
    try {
      const git = (args: string[]) => execFileSync("git", args, { cwd: env.repoDir, encoding: "utf8" });
      const envPath = join(env.repoDir, "retain.env");
      await writeFile(envPath, "SECRET=A\n", "utf8");
      git(["add", "-f", "retain.env"]);
      git(["commit", "-m", "add retain.env"]);

      // git rm --cached: staged deletion, but retained on filesystem
      git(["rm", "--cached", "retain.env"]);
      assert.equal(existsSync(envPath), true);

      const snap1 = await computeExecutionSnapshot(env.repoDir);
      const entry1 = snap1.manifest.entries.find((e) => e.path === "retain.env");
      assert.ok(entry1);
      assert.equal(entry1.entryType, "regular", "Must not be deleted if physically present");

      // Change file content on disk
      await writeFile(envPath, "SECRET=B_MODIFIED\n", "utf8");
      const snap2 = await computeExecutionSnapshot(env.repoDir);
      const entry2 = snap2.manifest.entries.find((e) => e.path === "retain.env");
      assert.ok(entry2);
      assert.equal(entry2.entryType, "regular");
      if (entry1.entryType === "regular" && entry2.entryType === "regular") {
        assert.notEqual(entry1.contentSha256, entry2.contentSha256);
      }
      assert.notEqual(snap1.digest, snap2.digest, "Snapshot digest must change when retained file content changes");
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 7: tracked retain.env, git rm --cached retain.env, retain.env replaced with symlink -> snapshot digest changes", async () => {
    const env = await createTestEnv();
    try {
      const git = (args: string[]) => execFileSync("git", args, { cwd: env.repoDir, encoding: "utf8" });
      const envPath = join(env.repoDir, "retain.env");
      await writeFile(envPath, "REGULAR_CONTENT\n", "utf8");
      git(["add", "-f", "retain.env"]);
      git(["commit", "-m", "add retain.env"]);
      git(["rm", "--cached", "retain.env"]);

      const snapRegular = await computeExecutionSnapshot(env.repoDir);

      // Replace regular file with symlink
      await unlink(envPath);
      await writeFile(join(env.repoDir, "target.txt"), "target content\n", "utf8");
      execFileSync("ln", ["-s", "target.txt", envPath]);

      const snapSymlink = await computeExecutionSnapshot(env.repoDir);
      const entry = snapSymlink.manifest.entries.find((e) => e.path === "retain.env");
      assert.ok(entry);
      assert.equal(entry.entryType, "symlink");
      assert.notEqual(snapRegular.digest, snapSymlink.digest);
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 8: true file deletion (lstat ENOENT) -> entryType = deleted", async () => {
    const env = await createTestEnv();
    try {
      const git = (args: string[]) => execFileSync("git", args, { cwd: env.repoDir, encoding: "utf8" });
      const filePath = join(env.repoDir, "temp-file.txt");
      await writeFile(filePath, "data\n", "utf8");
      git(["add", "temp-file.txt"]);
      git(["commit", "-m", "add temp file"]);

      // Physically delete the file
      await unlink(filePath);
      assert.equal(existsSync(filePath), false);

      const snap = await computeExecutionSnapshot(env.repoDir);
      const entry = snap.manifest.entries.find((e) => e.path === "temp-file.txt");
      assert.ok(entry);
      assert.equal(entry.entryType, "deleted");
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 9: staged rename regression passes -> old path deleted, new path has actual entry identity", async () => {
    const env = await createTestEnv();
    try {
      const git = (args: string[]) => execFileSync("git", args, { cwd: env.repoDir, encoding: "utf8" });
      await writeFile(join(env.repoDir, "old-path.txt"), "rename me\n", "utf8");
      git(["add", "old-path.txt"]);
      git(["commit", "-m", "add old path"]);

      git(["mv", "old-path.txt", "new-path.txt"]);

      const snap = await computeExecutionSnapshot(env.repoDir);
      const oldEntry = snap.manifest.entries.find((e) => e.path === "old-path.txt");
      const newEntry = snap.manifest.entries.find((e) => e.path === "new-path.txt");

      assert.ok(oldEntry);
      assert.equal(oldEntry.entryType, "deleted");
      assert.ok(newEntry);
      assert.equal(newEntry.entryType, "regular");
    } finally {
      await env.cleanup();
    }
  });

  // =========================================================================
  // HIGH R1-H03: No Outside Inspection / Safe Component Chain (10-15)
  // =========================================================================

  test("TEST 10: repo -> outside -> repo escape/re-entry rejected", async () => {
    const env = await createTestEnv();
    const outsideDir = await mkdtemp(join(tmpdir(), "cindy-outside-"));
    try {
      // outsideDir has link back to repo
      execFileSync("ln", ["-s", env.repoDir, join(outsideDir, "back-link")]);
      // repo has link to outsideDir/back-link/README.md
      execFileSync("ln", ["-s", join(outsideDir, "back-link", "README.md"), join(env.repoDir, "reentrant-link")]);

      await assert.rejects(
        async () => {
          await computeExecutionSnapshot(env.repoDir);
        },
        (err: unknown) => err instanceof SymlinkEscapeError
      );
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
      await env.cleanup();
    }
  });

  test("TEST 11: repo -> outside symlink rejected", async () => {
    const env = await createTestEnv();
    const outsideDir = await mkdtemp(join(tmpdir(), "cindy-outside-"));
    try {
      await writeFile(join(outsideDir, "outside.txt"), "outside data\n", "utf8");
      execFileSync("ln", ["-s", join(outsideDir, "outside.txt"), join(env.repoDir, "escape-link")]);

      await assert.rejects(
        async () => {
          await computeExecutionSnapshot(env.repoDir);
        },
        (err: unknown) => err instanceof SymlinkEscapeError
      );
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
      await env.cleanup();
    }
  });

  test("TEST 12: no external stat/readlink/readFile occurs on escape paths", async () => {
    const env = await createTestEnv();
    try {
      // Symlink pointing to nonexistent outside path: walkSafeComponentChain fails on containment check
      execFileSync("ln", ["-s", "/nonexistent-outside-dir-xyz/foo", join(env.repoDir, "external-link")]);

      await assert.rejects(
        async () => {
          await computeExecutionSnapshot(env.repoDir);
        },
        (err: unknown) => err instanceof SymlinkEscapeError
      );
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 13: error matches /Unsupported special file type/ or SymlinkEscapeError", async () => {
    const env = await createTestEnv();
    try {
      execFileSync("ln", ["-s", "../../outside", join(env.repoDir, "bad-link")]);

      await assert.rejects(
        async () => {
          await computeExecutionSnapshot(env.repoDir);
        },
        (err: unknown) => {
          assert.ok(err instanceof SymlinkEscapeError);
          return true;
        }
      );
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 14: safe intra-repo symlink still passes", async () => {
    const env = await createTestEnv();
    try {
      await writeFile(join(env.repoDir, "inside.txt"), "hello inside\n", "utf8");
      execFileSync("ln", ["-s", "inside.txt", join(env.repoDir, "safe-link")]);

      const snap = await computeExecutionSnapshot(env.repoDir);
      const entry = snap.manifest.entries.find((e) => e.path === "safe-link");
      assert.ok(entry);
      assert.equal(entry.entryType, "symlink");
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 15: safe symlink to directory within repo resolves correctly", async () => {
    const env = await createTestEnv();
    try {
      await mkdir(join(env.repoDir, "sub"), { recursive: true });
      await writeFile(join(env.repoDir, "sub", "doc.txt"), "doc\n", "utf8");
      execFileSync("ln", ["-s", "sub", join(env.repoDir, "sub-link")]);

      const snap = await computeExecutionSnapshot(env.repoDir);
      const entry = snap.manifest.entries.find((e) => e.path === "sub-link");
      assert.ok(entry);
      assert.equal(entry.entryType, "symlink");
    } finally {
      await env.cleanup();
    }
  });

  // =========================================================================
  // HIGH R1-H04: Zero Silent Backfill in Typed Writers (16-21)
  // =========================================================================

  test("TEST 16: store.recordTestResult without snapshot fields throws ArtifactValidationError", async () => {
    const env = await createTestEnv();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await orchestrator.initRun({ runId: env.runId, taskId: env.taskId });
      await orchestrator.markReadyForBuilder(run.runId);
      await orchestrator.startBuilding(run.runId);
      await orchestrator.completeBuilding(run.runId);
      await orchestrator.startTesting(run.runId);

      const store = orchestrator.artifactStore;
      await assert.rejects(
        async () => {
          await store.recordTestResult(run.runId, {
            command: "pnpm test",
            exitCode: 0,
            status: "PASS",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            logDigest: "0".repeat(64),
            // Missing executionSnapshotVersion and executionSnapshotDigest
          } as any);
        },
        (err: unknown) => err instanceof ArtifactValidationError
      );
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 17: store.recordDiffManifest without snapshot fields throws ArtifactValidationError", async () => {
    const env = await createTestEnv();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await orchestrator.initRun({ runId: env.runId, taskId: env.taskId });
      await orchestrator.markReadyForBuilder(run.runId);
      await orchestrator.startBuilding(run.runId);
      await orchestrator.completeBuilding(run.runId);
      await orchestrator.startTesting(run.runId);

      const store = orchestrator.artifactStore;
      await assert.rejects(
        async () => {
          await store.recordDiffManifest(run.runId, {} as any);
        },
        (err: unknown) => err instanceof ArtifactValidationError
      );
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 18: store.recordReviewRequest without snapshot fields throws ArtifactValidationError", async () => {
    const env = await createTestEnv();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await orchestrator.initRun({ runId: env.runId, taskId: env.taskId });
      await orchestrator.markReadyForBuilder(run.runId);
      await orchestrator.startBuilding(run.runId);
      await orchestrator.completeBuilding(run.runId);
      await orchestrator.startTesting(run.runId);
      const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
      await orchestrator.recordTestResult(run.runId, {
        command: "pnpm test",
        exitCode: 0,
        status: "PASS",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        logDigest: "0".repeat(64),
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: snap.digest
    });
      await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
      await orchestrator.prepareForReview(run.runId);

      const store = orchestrator.artifactStore;
      await assert.rejects(
        async () => {
          await store.recordReviewRequest(run.runId, {
            reviewer: { identity: "rev", session: "s1", readOnlyConfirmed: true },
          } as any);
        },
        (err: unknown) => err instanceof ArtifactValidationError
      );
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 19: store.recordReviewResult without snapshot fields throws ArtifactValidationError", async () => {
    const env = await createTestEnv();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await orchestrator.initRun({ runId: env.runId, taskId: env.taskId });
      await orchestrator.markReadyForBuilder(run.runId);
      await orchestrator.startBuilding(run.runId);
      await orchestrator.completeBuilding(run.runId);
      await orchestrator.startTesting(run.runId);
      const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
      await orchestrator.recordTestResult(run.runId, {
        command: "pnpm test",
        exitCode: 0,
        status: "PASS",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        logDigest: "0".repeat(64),
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: snap.digest
    });
      await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
      await orchestrator.prepareForReview(run.runId);
      await orchestrator.startReview(run.runId, {
        reviewer: { identity: "rev", session: "s1", readOnlyConfirmed: true },
      });

      const store = orchestrator.artifactStore;
      await assert.rejects(
        async () => {
          await store.recordReviewResult(run.runId, {
            runId: run.runId,
            taskId: run.taskId,
            reviewedBaseCommit: run.baseCommit,
            cycle: 1,
            reviewer: { identity: "rev", session: "s1", readOnlyConfirmed: true },
            reviewedTreeDigest: await computeTreeDigest(env.repoDir),
            reviewedDiffDigest: await computeDiffDigest(env.repoDir),
            verdict: "PASS",
            findings: [],
            recordedAt: new Date().toISOString(),
          } as any);
        },
        (err: unknown) => err instanceof ArtifactValidationError
      );
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 20: no auto-backfill occurs in RuntimeArtifactStore", async () => {
    const env = await createTestEnv();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await orchestrator.initRun({ runId: env.runId, taskId: env.taskId });
      const store = orchestrator.artifactStore;

      // With wrong or empty strings, it fails validation immediately without auto-backfilling
      await assert.rejects(
        async () => {
          await store.recordTestResult(run.runId, {
            command: "pnpm test",
            exitCode: 0,
            status: "PASS",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            logDigest: "0".repeat(64),
            executionSnapshotVersion: "",
            executionSnapshotDigest: "",
          } as any);
        },
        (err: unknown) => err instanceof ArtifactValidationError
      );
    } finally {
      await env.cleanup();
    }
  });

  describe("CINDY-ORCH-MVP-R2F3-R2-R1 Architecture Decision CU - No Backfill Matrix (TEST 1-16)", () => {
    async function setupTesting(orchestrator: CindyOrchestrator, runId: string, taskId: string) {
      const run = await orchestrator.initRun({ runId, taskId });
      await orchestrator.markReadyForBuilder(runId);
      await orchestrator.startBuilding(runId);
      await orchestrator.completeBuilding(runId);
      await orchestrator.startTesting(runId);
      return await orchestrator.getRun(runId);
    }

    async function setupReadyForReview(orchestrator: CindyOrchestrator, runId: string, taskId: string) {
      const run = await setupTesting(orchestrator, runId, taskId);
      const snap = await orchestrator.computeCurrentExecutionSnapshot(taskId);
      const tree = await orchestrator.computeCurrentTreeDigest();
      await orchestrator.recordTestResult(runId, {
        command: "pnpm test",
        exitCode: 0,
        status: "PASS",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        logDigest: "0".repeat(64),
        boundTreeDigest: tree,
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest,
      });
      await orchestrator.recordDiffManifest(runId, {
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest,
      });
      await orchestrator.prepareForReview(runId);
      return await orchestrator.getRun(runId);
    }

    async function setupReviewing(orchestrator: CindyOrchestrator, runId: string, taskId: string, session = "sess-nb") {
      await setupReadyForReview(orchestrator, runId, taskId);
      await orchestrator.startReview(runId, {
        reviewer: { identity: "Reviewer Cindy", session, readOnlyConfirmed: true, readOnlyRequired: true },
      });
      return await orchestrator.getRun(runId);
    }

    // TEST 1: CindyOrchestrator.recordTestResult missing version -> reject
    test("TEST 1: CindyOrchestrator.recordTestResult missing version -> reject", async () => {
      const env = await createTestEnv();
      try {
        const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
        const run = await setupTesting(orchestrator, env.runId, env.taskId);
        const snap = await orchestrator.computeCurrentExecutionSnapshot(env.taskId);
        const tree = await orchestrator.computeCurrentTreeDigest();

        await assert.rejects(
          async () => {
            await orchestrator.recordTestResult(run.runId, {
              command: "pnpm test",
              exitCode: 0,
              status: "PASS",
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              logDigest: "0".repeat(64),
              boundTreeDigest: tree,
              executionSnapshotVersion: undefined as any,
              executionSnapshotDigest: snap.digest,
            });
          },
          (err: unknown) => err instanceof ArtifactValidationError
        );

        await assertNoSideEffects(orchestrator, run.runId, run, ArtifactKind.TEST_RESULT, 1, env.repoDir);
      } finally {
        await env.cleanup();
      }
    });

    // TEST 2: CindyOrchestrator.recordTestResult missing digest -> reject
    test("TEST 2: CindyOrchestrator.recordTestResult missing digest -> reject", async () => {
      const env = await createTestEnv();
      try {
        const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
        const run = await setupTesting(orchestrator, env.runId, env.taskId);
        const tree = await orchestrator.computeCurrentTreeDigest();

        await assert.rejects(
          async () => {
            await orchestrator.recordTestResult(run.runId, {
              command: "pnpm test",
              exitCode: 0,
              status: "PASS",
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              logDigest: "0".repeat(64),
              boundTreeDigest: tree,
              executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
              executionSnapshotDigest: undefined as any,
            });
          },
          (err: unknown) => err instanceof ArtifactValidationError
        );

        await assertNoSideEffects(orchestrator, run.runId, run, ArtifactKind.TEST_RESULT, 1, env.repoDir);
      } finally {
        await env.cleanup();
      }
    });

    // TEST 3: CindyOrchestrator.recordTestResult missing both -> reject
    test("TEST 3: CindyOrchestrator.recordTestResult missing both -> reject", async () => {
      const env = await createTestEnv();
      try {
        const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
        const run = await setupTesting(orchestrator, env.runId, env.taskId);
        const tree = await orchestrator.computeCurrentTreeDigest();

        await assert.rejects(
          async () => {
            await orchestrator.recordTestResult(run.runId, {
              command: "pnpm test",
              exitCode: 0,
              status: "PASS",
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              logDigest: "0".repeat(64),
              boundTreeDigest: tree,
              executionSnapshotVersion: undefined as any,
              executionSnapshotDigest: undefined as any,
            });
          },
          (err: unknown) => err instanceof ArtifactValidationError
        );

        await assertNoSideEffects(orchestrator, run.runId, run, ArtifactKind.TEST_RESULT, 1, env.repoDir);
      } finally {
        await env.cleanup();
      }
    });

    // TEST 4: CindyOrchestrator.recordDiffManifest missing version -> reject
    test("TEST 4: CindyOrchestrator.recordDiffManifest missing version -> reject", async () => {
      const env = await createTestEnv();
      try {
        const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
        const run = await setupTesting(orchestrator, env.runId, env.taskId);
        const snap = await orchestrator.computeCurrentExecutionSnapshot(env.taskId);

        await assert.rejects(
          async () => {
            await orchestrator.recordDiffManifest(run.runId, {
              executionSnapshotVersion: undefined as any,
              executionSnapshotDigest: snap.digest,
            });
          },
          (err: unknown) => err instanceof ArtifactValidationError
        );

        await assertNoSideEffects(orchestrator, run.runId, run, ArtifactKind.DIFF_MANIFEST, 1, env.repoDir);
      } finally {
        await env.cleanup();
      }
    });

    // TEST 5: CindyOrchestrator.recordDiffManifest missing digest -> reject
    test("TEST 5: CindyOrchestrator.recordDiffManifest missing digest -> reject", async () => {
      const env = await createTestEnv();
      try {
        const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
        const run = await setupTesting(orchestrator, env.runId, env.taskId);

        await assert.rejects(
          async () => {
            await orchestrator.recordDiffManifest(run.runId, {
              executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
              executionSnapshotDigest: undefined as any,
            });
          },
          (err: unknown) => err instanceof ArtifactValidationError
        );

        await assertNoSideEffects(orchestrator, run.runId, run, ArtifactKind.DIFF_MANIFEST, 1, env.repoDir);
      } finally {
        await env.cleanup();
      }
    });

    // TEST 6: CindyOrchestrator.recordDiffManifest missing both -> reject
    test("TEST 6: CindyOrchestrator.recordDiffManifest missing both -> reject", async () => {
      const env = await createTestEnv();
      try {
        const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
        const run = await setupTesting(orchestrator, env.runId, env.taskId);

        await assert.rejects(
          async () => {
            await orchestrator.recordDiffManifest(run.runId, {} as any);
          },
          (err: unknown) => err instanceof ArtifactValidationError
        );

        await assertNoSideEffects(orchestrator, run.runId, run, ArtifactKind.DIFF_MANIFEST, 1, env.repoDir);
      } finally {
        await env.cleanup();
      }
    });

    // TEST 7: CindyOrchestrator.recordReviewRequest missing version -> reject
    test("TEST 7: CindyOrchestrator.recordReviewRequest missing version -> reject", async () => {
      const env = await createTestEnv();
      try {
        const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
        const run = await setupReadyForReview(orchestrator, env.runId, env.taskId);
        const snap = await orchestrator.computeCurrentExecutionSnapshot(env.taskId);

        await assert.rejects(
          async () => {
            await orchestrator.recordReviewRequest(run.runId, {
              reviewer: { identity: "Reviewer Cindy", session: "sess-nb-rev", readOnlyConfirmed: true },
              cycle: 1,
              executionSnapshotVersion: undefined as any,
              executionSnapshotDigest: snap.digest,
            });
          },
          (err: unknown) => err instanceof ArtifactValidationError
        );

        await assertNoSideEffects(orchestrator, run.runId, run, ArtifactKind.REVIEW_REQUEST, 1, env.repoDir);
      } finally {
        await env.cleanup();
      }
    });

    // TEST 8: CindyOrchestrator.recordReviewRequest missing digest -> reject
    test("TEST 8: CindyOrchestrator.recordReviewRequest missing digest -> reject", async () => {
      const env = await createTestEnv();
      try {
        const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
        const run = await setupReadyForReview(orchestrator, env.runId, env.taskId);

        await assert.rejects(
          async () => {
            await orchestrator.recordReviewRequest(run.runId, {
              reviewer: { identity: "Reviewer Cindy", session: "sess-nb-rev", readOnlyConfirmed: true },
              cycle: 1,
              executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
              executionSnapshotDigest: undefined as any,
            });
          },
          (err: unknown) => err instanceof ArtifactValidationError
        );

        await assertNoSideEffects(orchestrator, run.runId, run, ArtifactKind.REVIEW_REQUEST, 1, env.repoDir);
      } finally {
        await env.cleanup();
      }
    });

    // TEST 9: CindyOrchestrator.recordReviewRequest missing both -> reject
    test("TEST 9: CindyOrchestrator.recordReviewRequest missing both -> reject", async () => {
      const env = await createTestEnv();
      try {
        const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
        const run = await setupReadyForReview(orchestrator, env.runId, env.taskId);

        await assert.rejects(
          async () => {
            await orchestrator.recordReviewRequest(run.runId, {
              reviewer: { identity: "Reviewer Cindy", session: "sess-nb-rev", readOnlyConfirmed: true },
              cycle: 1,
              executionSnapshotVersion: undefined as any,
              executionSnapshotDigest: undefined as any,
            });
          },
          (err: unknown) => err instanceof ArtifactValidationError
        );

        await assertNoSideEffects(orchestrator, run.runId, run, ArtifactKind.REVIEW_REQUEST, 1, env.repoDir);
      } finally {
        await env.cleanup();
      }
    });

    // TEST 10: CindyOrchestrator.recordValidatedReviewResult missing version -> reject
    test("TEST 10: CindyOrchestrator.recordValidatedReviewResult missing version -> reject", async () => {
      const env = await createTestEnv();
      try {
        const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
        const run = await setupReviewing(orchestrator, env.runId, env.taskId, "sess-nb-res");
        const snap = await orchestrator.computeCurrentExecutionSnapshot(env.taskId);
        const tree = await orchestrator.computeCurrentTreeDigest();
        const diff = await orchestrator.computeCurrentDiffDigest();

        await assert.rejects(
          async () => {
            await orchestrator.recordValidatedReviewResult(run.runId, {
              runId: run.runId,
              taskId: run.taskId,
              cycle: 1,
              reviewer: { identity: "Reviewer Cindy", session: "sess-nb-res", readOnlyConfirmed: true },
              reviewedBaseCommit: run.baseCommit,
              reviewedTreeDigest: tree,
              reviewedDiffDigest: diff,
              verdict: "FAIL",
              findings: [{ id: "F1", severity: "HIGH", title: "Missing version test" }],
              recordedAt: new Date().toISOString(),
              executionSnapshotVersion: undefined as any,
              executionSnapshotDigest: snap.digest,
            });
          },
          (err: unknown) => err instanceof ArtifactValidationError
        );

        await assertNoSideEffects(orchestrator, run.runId, run, ArtifactKind.REVIEW_RESULT, 1, env.repoDir);
      } finally {
        await env.cleanup();
      }
    });

    // TEST 11: CindyOrchestrator.recordValidatedReviewResult missing digest -> reject
    test("TEST 11: CindyOrchestrator.recordValidatedReviewResult missing digest -> reject", async () => {
      const env = await createTestEnv();
      try {
        const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
        const run = await setupReviewing(orchestrator, env.runId, env.taskId, "sess-nb-res");
        const tree = await orchestrator.computeCurrentTreeDigest();
        const diff = await orchestrator.computeCurrentDiffDigest();

        await assert.rejects(
          async () => {
            await orchestrator.recordValidatedReviewResult(run.runId, {
              runId: run.runId,
              taskId: run.taskId,
              cycle: 1,
              reviewer: { identity: "Reviewer Cindy", session: "sess-nb-res", readOnlyConfirmed: true },
              reviewedBaseCommit: run.baseCommit,
              reviewedTreeDigest: tree,
              reviewedDiffDigest: diff,
              verdict: "FAIL",
              findings: [{ id: "F1", severity: "HIGH", title: "Missing digest test" }],
              recordedAt: new Date().toISOString(),
              executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
              executionSnapshotDigest: undefined as any,
            });
          },
          (err: unknown) => err instanceof ArtifactValidationError
        );

        await assertNoSideEffects(orchestrator, run.runId, run, ArtifactKind.REVIEW_RESULT, 1, env.repoDir);
      } finally {
        await env.cleanup();
      }
    });

    // TEST 12: CindyOrchestrator.recordValidatedReviewResult missing both -> reject
    test("TEST 12: CindyOrchestrator.recordValidatedReviewResult missing both -> reject", async () => {
      const env = await createTestEnv();
      try {
        const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
        const run = await setupReviewing(orchestrator, env.runId, env.taskId, "sess-nb-res");
        const tree = await orchestrator.computeCurrentTreeDigest();
        const diff = await orchestrator.computeCurrentDiffDigest();

        await assert.rejects(
          async () => {
            await orchestrator.recordValidatedReviewResult(run.runId, {
              runId: run.runId,
              taskId: run.taskId,
              cycle: 1,
              reviewer: { identity: "Reviewer Cindy", session: "sess-nb-res", readOnlyConfirmed: true },
              reviewedBaseCommit: run.baseCommit,
              reviewedTreeDigest: tree,
              reviewedDiffDigest: diff,
              verdict: "FAIL",
              findings: [{ id: "F1", severity: "HIGH", title: "Missing both test" }],
              recordedAt: new Date().toISOString(),
              executionSnapshotVersion: undefined as any,
              executionSnapshotDigest: undefined as any,
            });
          },
          (err: unknown) => err instanceof ArtifactValidationError
        );

        await assertNoSideEffects(orchestrator, run.runId, run, ArtifactKind.REVIEW_RESULT, 1, env.repoDir);
      } finally {
        await env.cleanup();
      }
    });

    // TEST 13: 完整正确: version + digest -> PASS
    test("TEST 13: 完整正确: version + digest -> PASS", async () => {
      const env = await createTestEnv();
      try {
        const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
        const run = await setupTesting(orchestrator, env.runId, env.taskId);
        const snap = await orchestrator.computeCurrentExecutionSnapshot(env.taskId);
        const tree = await orchestrator.computeCurrentTreeDigest();

        // 1. recordTestResult PASS
        const testRes = await orchestrator.recordTestResult(run.runId, {
          command: "pnpm test",
          exitCode: 0,
          status: "PASS",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          logDigest: "0".repeat(64),
          boundTreeDigest: tree,
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: snap.digest,
        });
        assert.ok(existsSync(testRes.path));

        // 2. recordDiffManifest PASS
        const diffRes = await orchestrator.recordDiffManifest(run.runId, {
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: snap.digest,
        });
        assert.ok(existsSync(diffRes.path));

        // 3. prepareForReview
        const readyRun = await orchestrator.prepareForReview(run.runId);
        assert.equal(readyRun.state, CindyState.READY_FOR_REVIEW);

        // 4. recordReviewRequest PASS
        const reqRes = await orchestrator.recordReviewRequest(run.runId, {
          reviewer: { identity: "Reviewer Cindy", session: "sess-nb-13", readOnlyConfirmed: true, readOnlyRequired: true },
          cycle: 1,
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: snap.digest,
        });
        assert.ok(existsSync(reqRes.path));

        // 5. startReview
        const reviewingRun = await orchestrator.startReview(run.runId, {
          reviewer: { identity: "Reviewer Cindy", session: "sess-nb-13", readOnlyConfirmed: true, readOnlyRequired: true },
        });
        assert.equal(reviewingRun.state, CindyState.REVIEWING);

        // 6. recordValidatedReviewResult PASS
        const diff = await orchestrator.computeCurrentDiffDigest();
        const reviewRun = await orchestrator.recordValidatedReviewResult(run.runId, {
          runId: run.runId,
          taskId: run.taskId,
          cycle: 1,
          reviewer: { identity: "Reviewer Cindy", session: "sess-nb-13", readOnlyConfirmed: true },
          reviewedBaseCommit: run.baseCommit,
          reviewedTreeDigest: tree,
          reviewedDiffDigest: diff,
          verdict: "PASS",
          findings: [],
          recordedAt: new Date().toISOString(),
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: snap.digest,
        });
        assert.equal(reviewRun.state, CindyState.REVIEWING);

        const reviewPath = orchestrator.artifactStore.getArtifactPath(run.runId, ArtifactKind.REVIEW_RESULT, 1);
        assert.ok(existsSync(reviewPath));
      } finally {
        await env.cleanup();
      }
    });

    // TEST 14: 完整但 stale digest -> reject
    test("TEST 14: 完整但 stale digest -> reject", async () => {
      const env = await createTestEnv();
      try {
        const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
        const run = await setupTesting(orchestrator, env.runId, env.taskId);
        const tree = await orchestrator.computeCurrentTreeDigest();
        const staleDigest = "1".repeat(64);

        // recordTestResult with stale digest rejects with ArtifactDigestMismatchError
        await assert.rejects(
          async () => {
            await orchestrator.recordTestResult(run.runId, {
              command: "pnpm test",
              exitCode: 0,
              status: "PASS",
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              logDigest: "0".repeat(64),
              boundTreeDigest: tree,
              executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
              executionSnapshotDigest: staleDigest,
            });
          },
          (err: unknown) => err instanceof ArtifactDigestMismatchError
        );
        await assertNoSideEffects(orchestrator, run.runId, run, ArtifactKind.TEST_RESULT, 1, env.repoDir);

        // recordDiffManifest with stale digest rejects with ArtifactDigestMismatchError
        await assert.rejects(
          async () => {
            await orchestrator.recordDiffManifest(run.runId, {
              executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
              executionSnapshotDigest: staleDigest,
            });
          },
          (err: unknown) => err instanceof ArtifactDigestMismatchError
        );
        await assertNoSideEffects(orchestrator, run.runId, run, ArtifactKind.DIFF_MANIFEST, 1, env.repoDir);
      } finally {
        await env.cleanup();
      }
    });

    // TEST 15: unknown version -> reject
    test("TEST 15: unknown version -> reject", async () => {
      const env = await createTestEnv();
      try {
        const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
        const run = await setupTesting(orchestrator, env.runId, env.taskId);
        const snap = await orchestrator.computeCurrentExecutionSnapshot(env.taskId);
        const tree = await orchestrator.computeCurrentTreeDigest();
        const unknownVersion = "CINDY_EXECUTION_SNAPSHOT_V999";

        await assert.rejects(
          async () => {
            await orchestrator.recordTestResult(run.runId, {
              command: "pnpm test",
              exitCode: 0,
              status: "PASS",
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              logDigest: "0".repeat(64),
              boundTreeDigest: tree,
              executionSnapshotVersion: unknownVersion as any,
              executionSnapshotDigest: snap.digest,
            });
          },
          (err: unknown) => err instanceof ArtifactValidationError
        );
        await assertNoSideEffects(orchestrator, run.runId, run, ArtifactKind.TEST_RESULT, 1, env.repoDir);

        await assert.rejects(
          async () => {
            await orchestrator.recordDiffManifest(run.runId, {
              executionSnapshotVersion: unknownVersion as any,
              executionSnapshotDigest: snap.digest,
            });
          },
          (err: unknown) => err instanceof ArtifactValidationError
        );
        await assertNoSideEffects(orchestrator, run.runId, run, ArtifactKind.DIFF_MANIFEST, 1, env.repoDir);
      } finally {
        await env.cleanup();
      }
    });

    // TEST 16: malformed digest -> reject
    test("TEST 16: malformed digest -> reject", async () => {
      const env = await createTestEnv();
      try {
        const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
        const run = await setupTesting(orchestrator, env.runId, env.taskId);
        const tree = await orchestrator.computeCurrentTreeDigest();
        const malformedDigest = "not-a-64-character-hex-digest";

        await assert.rejects(
          async () => {
            await orchestrator.recordTestResult(run.runId, {
              command: "pnpm test",
              exitCode: 0,
              status: "PASS",
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              logDigest: "0".repeat(64),
              boundTreeDigest: tree,
              executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
              executionSnapshotDigest: malformedDigest,
            });
          },
          (err: unknown) => err instanceof ArtifactValidationError
        );
        await assertNoSideEffects(orchestrator, run.runId, run, ArtifactKind.TEST_RESULT, 1, env.repoDir);

        await assert.rejects(
          async () => {
            await orchestrator.recordDiffManifest(run.runId, {
              executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
              executionSnapshotDigest: malformedDigest,
            });
          },
          (err: unknown) => err instanceof ArtifactValidationError
        );
        await assertNoSideEffects(orchestrator, run.runId, run, ArtifactKind.DIFF_MANIFEST, 1, env.repoDir);
      } finally {
        await env.cleanup();
      }
    });
  });

  // =========================================================================
  // HIGH R1-H05: Double Snapshot Fence in Semantic Consumers (22-28)
  // =========================================================================

  test("TEST 22: prepareForReview: declared ignored input drift during execution -> Double Snapshot Fence rejects with ArtifactDigestMismatchError", async () => {
    const env = await createTestEnv();
    try {
      await writeFile(join(env.repoDir, "config.ignored"), "INITIAL_VALUE\n", "utf8");
      await addExecutionInputs(env.repoDir, env.taskId, ["config.ignored"]);

      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await orchestrator.initRun({ runId: env.runId, taskId: env.taskId });
      await orchestrator.markReadyForBuilder(run.runId);
      await orchestrator.startBuilding(run.runId);
      await orchestrator.completeBuilding(run.runId);
      await orchestrator.startTesting(run.runId);
      const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
      await orchestrator.recordTestResult(run.runId, {
        command: "pnpm test",
        exitCode: 0,
        status: "PASS",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        logDigest: "0".repeat(64),
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: snap.digest
    });
      await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });

      // Mutate the ignored file so execution snapshot drifts
      const store = orchestrator.artifactStore;
      const originalAcquire = store.acquireRunLock.bind(store);
      store.acquireRunLock = async (...args) => {
        await writeFile(join(env.repoDir, "config.ignored"), "DRIFTED_VALUE\n", "utf8");
        return originalAcquire(...args);
      };

      await assert.rejects(
        async () => {
          await orchestrator.prepareForReview(run.runId);
        },
        (err: unknown) => err instanceof ArtifactDigestMismatchError
      );
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 23: startReview: declared ignored input drift during review setup -> rejects with ArtifactDigestMismatchError", async () => {
    const env = await createTestEnv();
    try {
      await writeFile(join(env.repoDir, "config.ignored"), "INITIAL_VALUE\n", "utf8");
      await addExecutionInputs(env.repoDir, env.taskId, ["config.ignored"]);

      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await orchestrator.initRun({ runId: env.runId, taskId: env.taskId });
      await orchestrator.markReadyForBuilder(run.runId);
      await orchestrator.startBuilding(run.runId);
      await orchestrator.completeBuilding(run.runId);
      await orchestrator.startTesting(run.runId);
      const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
      await orchestrator.recordTestResult(run.runId, {
        command: "pnpm test",
        exitCode: 0,
        status: "PASS",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        logDigest: "0".repeat(64),
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: snap.digest
    });
      await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
      await orchestrator.prepareForReview(run.runId);

      const store = orchestrator.artifactStore;
      const originalAcquire = store.acquireRunLock.bind(store);
      store.acquireRunLock = async (...args) => {
        await writeFile(join(env.repoDir, "config.ignored"), "DRIFTED_VALUE_2\n", "utf8");
        return originalAcquire(...args);
      };

      await assert.rejects(
        async () => {
          await orchestrator.startReview(run.runId, {
            reviewer: { identity: "rev", session: "s1", readOnlyConfirmed: true },
          });
        },
        (err: unknown) => err instanceof ArtifactDigestMismatchError
      );
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 24: recordValidatedReviewResult PASS: input drift during review result recording -> rejects with ArtifactDigestMismatchError", async () => {
    const env = await createTestEnv();
    try {
      await writeFile(join(env.repoDir, "config.ignored"), "INITIAL_VALUE\n", "utf8");
      await addExecutionInputs(env.repoDir, env.taskId, ["config.ignored"]);

      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await orchestrator.initRun({ runId: env.runId, taskId: env.taskId });
      await orchestrator.markReadyForBuilder(run.runId);
      await orchestrator.startBuilding(run.runId);
      await orchestrator.completeBuilding(run.runId);
      await orchestrator.startTesting(run.runId);
      const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
      await orchestrator.recordTestResult(run.runId, {
        command: "pnpm test",
        exitCode: 0,
        status: "PASS",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        logDigest: "0".repeat(64),
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: snap.digest
    });
      await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
      await orchestrator.prepareForReview(run.runId);
      await orchestrator.startReview(run.runId, {
        reviewer: { identity: "rev", session: "s1", readOnlyConfirmed: true },
      });

      const store = orchestrator.artifactStore;
      const originalAcquire = store.acquireRunLock.bind(store);
      store.acquireRunLock = async (...args) => {
        await writeFile(join(env.repoDir, "config.ignored"), "DRIFTED_UNDER_LOCK\n", "utf8");
        return originalAcquire(...args);
      };

      await assert.rejects(
        async () => {
          await store.recordReviewResult(run.runId, {
            runId: run.runId,
            taskId: run.taskId,
            reviewedBaseCommit: run.baseCommit,
            cycle: 1,
            reviewer: { identity: "rev", session: "s1", readOnlyConfirmed: true },
            reviewedTreeDigest: await computeTreeDigest(env.repoDir),
            reviewedDiffDigest: await computeDiffDigest(env.repoDir),
            verdict: "PASS",
            findings: [],
            recordedAt: new Date().toISOString(),
            executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
            executionSnapshotDigest: snap.digest,
          });
        },
        (err: unknown) => err instanceof ArtifactDigestMismatchError
      );
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 25: recordValidatedReviewResult FAIL: input drift -> rejects with ArtifactDigestMismatchError", async () => {
    const env = await createTestEnv();
    try {
      await writeFile(join(env.repoDir, "config.ignored"), "INITIAL_VALUE\n", "utf8");
      await addExecutionInputs(env.repoDir, env.taskId, ["config.ignored"]);

      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await orchestrator.initRun({ runId: env.runId, taskId: env.taskId });
      await orchestrator.markReadyForBuilder(run.runId);
      await orchestrator.startBuilding(run.runId);
      await orchestrator.completeBuilding(run.runId);
      await orchestrator.startTesting(run.runId);
      const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
      await orchestrator.recordTestResult(run.runId, {
        command: "pnpm test",
        exitCode: 0,
        status: "PASS",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        logDigest: "0".repeat(64),
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: snap.digest
    });
      await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
      await orchestrator.prepareForReview(run.runId);
      await orchestrator.startReview(run.runId, {
        reviewer: { identity: "rev", session: "s1", readOnlyConfirmed: true },
      });

      const store = orchestrator.artifactStore;
      const originalAcquire = store.acquireRunLock.bind(store);
      store.acquireRunLock = async (...args) => {
        await writeFile(join(env.repoDir, "config.ignored"), "DRIFTED_UNDER_LOCK_FAIL\n", "utf8");
        return originalAcquire(...args);
      };

      await assert.rejects(
        async () => {
          await store.recordReviewResult(run.runId, {
            runId: run.runId,
            taskId: run.taskId,
            reviewedBaseCommit: run.baseCommit,
            cycle: 1,
            reviewer: { identity: "rev", session: "s1", readOnlyConfirmed: true },
            reviewedTreeDigest: await computeTreeDigest(env.repoDir),
            reviewedDiffDigest: await computeDiffDigest(env.repoDir),
            verdict: "FAIL",
            findings: [{ id: "F1", severity: "HIGH", title: "Problem found" }],
            recordedAt: new Date().toISOString(),
            executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
            executionSnapshotDigest: snap.digest,
          });
        },
        (err: unknown) => err instanceof ArtifactDigestMismatchError
      );
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 26: PASS duplicate replay with input drift -> rejects with ArtifactDigestMismatchError", async () => {
    const env = await createTestEnv();
    try {
      await writeFile(join(env.repoDir, "config.ignored"), "INITIAL_VALUE\n", "utf8");
      await addExecutionInputs(env.repoDir, env.taskId, ["config.ignored"]);

      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await orchestrator.initRun({ runId: env.runId, taskId: env.taskId });
      await orchestrator.markReadyForBuilder(run.runId);
      await orchestrator.startBuilding(run.runId);
      await orchestrator.completeBuilding(run.runId);
      await orchestrator.startTesting(run.runId);
      const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
      await orchestrator.recordTestResult(run.runId, {
        command: "pnpm test",
        exitCode: 0,
        status: "PASS",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        logDigest: "0".repeat(64),
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: snap.digest
    });
      await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
      await orchestrator.prepareForReview(run.runId);
      await orchestrator.startReview(run.runId, {
        reviewer: { identity: "rev", session: "s1", readOnlyConfirmed: true },
      });

      const store = orchestrator.artifactStore;
      const resPayload: ReviewResultArtifact = {
        runId: run.runId,
        taskId: run.taskId,
        reviewedBaseCommit: run.baseCommit,
        cycle: 1,
        reviewer: { identity: "rev", session: "s1", readOnlyConfirmed: true },
        reviewedTreeDigest: await computeTreeDigest(env.repoDir),
        reviewedDiffDigest: await computeDiffDigest(env.repoDir),
        verdict: "PASS" as const,
        findings: [],
        recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest,
      };

      // First call succeeds
      await store.recordReviewResult(run.runId, resPayload);

      // Now drift declared input and try duplicate replay
      await writeFile(join(env.repoDir, "config.ignored"), "DRIFT_AFTER_PASS\n", "utf8");
      await assert.rejects(
        async () => {
          await store.recordReviewResult(run.runId, resPayload);
        },
        (err: unknown) => err instanceof ArtifactDigestMismatchError
      );
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 27: FAIL duplicate replay with input drift -> rejects with ArtifactDigestMismatchError", async () => {
    const env = await createTestEnv();
    try {
      await writeFile(join(env.repoDir, "config.ignored"), "INITIAL_VALUE\n", "utf8");
      await addExecutionInputs(env.repoDir, env.taskId, ["config.ignored"]);

      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await orchestrator.initRun({ runId: env.runId, taskId: env.taskId });
      await orchestrator.markReadyForBuilder(run.runId);
      await orchestrator.startBuilding(run.runId);
      await orchestrator.completeBuilding(run.runId);
      await orchestrator.startTesting(run.runId);
      const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
      await orchestrator.recordTestResult(run.runId, {
        command: "pnpm test",
        exitCode: 0,
        status: "PASS",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        logDigest: "0".repeat(64),
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: snap.digest
    });
      await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
      await orchestrator.prepareForReview(run.runId);
      await orchestrator.startReview(run.runId, {
        reviewer: { identity: "rev", session: "s1", readOnlyConfirmed: true },
      });

      const store = orchestrator.artifactStore;
      const resPayload: ReviewResultArtifact = {
        runId: run.runId,
        taskId: run.taskId,
        reviewedBaseCommit: run.baseCommit,
        cycle: 1,
        reviewer: { identity: "rev", session: "s1", readOnlyConfirmed: true },
        reviewedTreeDigest: await computeTreeDigest(env.repoDir),
        reviewedDiffDigest: await computeDiffDigest(env.repoDir),
        verdict: "FAIL" as const,
        findings: [{ id: "F1", severity: "HIGH" as const, title: "Problem found" }],
        recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest,
      };

      // First call succeeds
      await store.recordReviewResult(run.runId, resPayload);

      // Now drift declared input and try duplicate replay
      await writeFile(join(env.repoDir, "config.ignored"), "DRIFT_AFTER_FAIL\n", "utf8");
      await assert.rejects(
        async () => {
          await store.recordReviewResult(run.runId, resPayload);
        },
        (err: unknown) => err instanceof ArtifactDigestMismatchError
      );
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 28: stable input passes all transitions", async () => {
    const env = await createTestEnv();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await orchestrator.initRun({ runId: env.runId, taskId: env.taskId });
      await orchestrator.markReadyForBuilder(run.runId);
      await orchestrator.startBuilding(run.runId);
      await orchestrator.completeBuilding(run.runId);
      await orchestrator.startTesting(run.runId);
      const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
      await orchestrator.recordTestResult(run.runId, {
        command: "pnpm test",
        exitCode: 0,
        status: "PASS",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        logDigest: "0".repeat(64),
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: snap.digest
    });
      await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
      await orchestrator.prepareForReview(run.runId);
      await orchestrator.startReview(run.runId, {
        reviewer: { identity: "rev", session: "s1", readOnlyConfirmed: true },
      });

      const store = orchestrator.artifactStore;
      const res = await store.recordReviewResult(run.runId, {
        runId: run.runId,
        taskId: run.taskId,
        reviewedBaseCommit: run.baseCommit,
        cycle: 1,
        reviewer: { identity: "rev", session: "s1", readOnlyConfirmed: true },
        reviewedTreeDigest: await computeTreeDigest(env.repoDir),
        reviewedDiffDigest: await computeDiffDigest(env.repoDir),
        verdict: "PASS",
        findings: [],
        recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest,
      });

      assert.ok(res.path);
      const updatedRun = await orchestrator.getRun(run.runId);
      assert.equal(updatedRun.state, CindyState.REVIEWING);
    } finally {
      await env.cleanup();
    }
  });

  // =========================================================================
  // HIGH R1-H06: Run-Bound Git Authority in consumeReviewPass (29-30)
  // =========================================================================

  test("TEST 29: consumeReviewPass rejects if branch/upstream drifts from run-bound authority context", async () => {
    const env = await createTestEnv();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await orchestrator.initRun({ runId: env.runId, taskId: env.taskId });
      await orchestrator.markReadyForBuilder(run.runId);
      await orchestrator.startBuilding(run.runId);
      await orchestrator.completeBuilding(run.runId);
      await orchestrator.startTesting(run.runId);
      const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
      await orchestrator.recordTestResult(run.runId, {
        command: "pnpm test",
        exitCode: 0,
        status: "PASS",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        logDigest: "0".repeat(64),
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: snap.digest
    });
      await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
      await orchestrator.prepareForReview(run.runId);
      await orchestrator.startReview(run.runId, {
        reviewer: { identity: "rev", session: "s1", readOnlyConfirmed: true },
      });

      const store = orchestrator.artifactStore;
      await store.recordReviewResult(run.runId, {
        runId: run.runId,
        taskId: run.taskId,
        reviewedBaseCommit: run.baseCommit,
        cycle: 1,
        reviewer: { identity: "rev", session: "s1", readOnlyConfirmed: true },
        reviewedTreeDigest: await computeTreeDigest(env.repoDir),
        reviewedDiffDigest: await computeDiffDigest(env.repoDir),
        verdict: "PASS",
        findings: [],
        recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest,
      });

      // Drift upstream before consuming review pass
      const git = (args: string[]) => execFileSync("git", args, { cwd: env.repoDir, encoding: "utf8" });
      git(["update-ref", "refs/remotes/origin/main", "HEAD~1"]);

      await assert.rejects(
        async () => {
          await orchestrator.consumeReviewPass(run.runId);
        },
        (err: unknown) => err instanceof TransitionRejectedError
      );
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 30: consumeReviewPass succeeds when live authority context matches run-bound context", async () => {
    const env = await createTestEnv();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await orchestrator.initRun({ runId: env.runId, taskId: env.taskId });
      await orchestrator.markReadyForBuilder(run.runId);
      await orchestrator.startBuilding(run.runId);
      await orchestrator.completeBuilding(run.runId);
      await orchestrator.startTesting(run.runId);
      const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
      await orchestrator.recordTestResult(run.runId, {
        command: "pnpm test",
        exitCode: 0,
        status: "PASS",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        logDigest: "0".repeat(64),
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: snap.digest
    });
      await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
      await orchestrator.prepareForReview(run.runId);
      await orchestrator.startReview(run.runId, {
        reviewer: { identity: "rev", session: "s1", readOnlyConfirmed: true },
      });

      const store = orchestrator.artifactStore;
      await store.recordReviewResult(run.runId, {
        runId: run.runId,
        taskId: run.taskId,
        reviewedBaseCommit: run.baseCommit,
        cycle: 1,
        reviewer: { identity: "rev", session: "s1", readOnlyConfirmed: true },
        reviewedTreeDigest: await computeTreeDigest(env.repoDir),
        reviewedDiffDigest: await computeDiffDigest(env.repoDir),
        verdict: "PASS",
        findings: [],
        recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest,
      });

      const reviewRes = await orchestrator.consumeReviewPass(run.runId);
      assert.equal(reviewRes.verdict, "PASS");
      assert.equal(reviewRes.cycle, 1);
    } finally {
      await env.cleanup();
    }
  });

  // =========================================================================
  // MEDIUM R1-M02: deriveSafetyStop with Deleted Committed Task Packet (31)
  // =========================================================================

  test("TEST 31: deriveSafetyStop() succeeds and records GIT_SAFETY_STOP even when committed Task Packet is deleted", async () => {
    const env = await createTestEnv();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await orchestrator.initRun({ runId: env.runId, taskId: env.taskId });
      await orchestrator.markReadyForBuilder(run.runId);
      await orchestrator.startBuilding(run.runId);

      // Now delete committed task packet and advance HEAD
      const git = (args: string[]) => execFileSync("git", args, { cwd: env.repoDir, encoding: "utf8" });
      const taskPath = join(env.repoDir, ".agent", "tasks", env.taskId, "task.json");
      git(["rm", taskPath]);
      git(["commit", "-m", "delete task packet"]);

      // deriveSafetyStop must succeed and transition run to GIT_SAFETY_STOP
      const stoppedRun = await orchestrator.deriveSafetyStop(run.runId);
      assert.equal(stoppedRun.state, CindyState.GIT_SAFETY_STOP);
      assert.equal(stoppedRun.stopReason, CindyStopReason.TASK_PACKET_NOT_COMMITTED);
    } finally {
      await env.cleanup();
    }
  });

  // =========================================================================
  // MEDIUM R1-M01: Valid POSIX Filename Traversal Edge Cases (32-35)
  // =========================================================================

  test("TEST 32: path '..config' accepted as legitimate filename", () => {
    assert.doesNotThrow(() => validateScopeEntry("..config"));
  });

  test("TEST 33: path '...foo' accepted", () => {
    assert.doesNotThrow(() => validateScopeEntry("...foo"));
  });

  test("TEST 34: path '.hidden' accepted", () => {
    assert.doesNotThrow(() => validateScopeEntry(".hidden"));
  });

  test("TEST 35: paths '..', '../foo', 'foo/..', 'foo/../bar', '.' rejected as traversal", () => {
    const invalidPaths = ["..", "../foo", "foo/..", "foo/../bar", "."];
    for (const p of invalidPaths) {
      assert.throws(
        () => validateScopeEntry(p),
        (err: unknown) => err instanceof PathTraversalError,
        `Expected ${p} to throw PathTraversalError`
      );
    }
  });
});
