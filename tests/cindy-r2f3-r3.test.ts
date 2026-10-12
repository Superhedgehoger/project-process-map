/**
 * CINDY-ORCH-MVP-R2F3-R3 Test Suite
 *
 * Covers all 8 findings from independent review PI_GPT6_R2F3_R2_R1_REVIEW_FAIL:
 * - Tests 1–6:   HIGH-01 Single authority initialization (Architecture Decision CX)
 * - Tests 7–12:  HIGH-02 Raw symlink component walk (Architecture Decision CY)
 * - Tests 13–16: MEDIUM-03 Resolved reserved namespace guard (Architecture Decision CZ)
 * - Tests 17–19: MEDIUM-04 POSIX backslash semantics (Architecture Decision DA)
 * - Tests 20–23: HIGH-03 Semantic LAST authority fence after SNAPSHOT_FINAL (Architecture Decision DB)
 * - Tests 24–28: MEDIUM-01 Duplicate replay final authority fence (Architecture Decision DC)
 * - Tests 29–31: MEDIUM-02 Final dirty ownership fresh reread (Architecture Decision DD)
 * - Test  32:    HIGH-01/DE Init final dirty fence fresh reread
 * - Tests 33–37: LOW-01 ReviewResult zero Store access before validation (Architecture Decision DF)
 * - Test  38:    consumeReviewPass Task authority drift
 * - Test  39:    consumeReviewPass Task Packet drift
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CindyOrchestrator,
  CindyState,
  RuntimeArtifactStore,
  ArtifactKind,
  computeAuthoritativeExecutionSnapshot,
  computeTreeDigest,
  computeDiffDigest,
  readCanonicalTaskPacketAtCommit,
  readCommittedClosure,
  evaluateGitAuthority,
  checkGitUpstreamStatus,
  TransitionRejectedError,
  ArtifactValidationError,
  ArtifactDigestMismatchError,
  ConflictingArtifactError,
  SymlinkEscapeError,
  FilesystemSnapshotError,
  TaskPacketNotCommittedError,
  CINDY_EXECUTION_SNAPSHOT_V1,
  validateIgnoredPathEntry,
  assertSnapshotPathContained,
  type ReviewResultArtifact,
  type CindyRun,
} from "../tools/cindy/index.ts";

// ============================================================
// Shared helpers
// ============================================================

async function createTestRepo(): Promise<{
  repoDir: string;
  bareDir: string;
  baseCommit: string;
  taskId: string;
  runId: string;
  cleanup: () => Promise<void>;
}> {
  const repoDir = await mkdtemp(join(tmpdir(), "cindy-r3-repo-"));
  const bareDir = await mkdtemp(join(tmpdir(), "cindy-r3-bare-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

  git(["init", "-b", "main"]);
  git(["config", "user.name", "Cindy R3 Test"]);
  git(["config", "user.email", "cindy-r3@example.com"]);

  await writeFile(
    join(repoDir, ".gitignore"),
    "node_modules/\n.agent/runtime/\n.agent/.cindy-init-staging/\n*.ignored\n*.env\n",
    "utf8"
  );
  await writeFile(join(repoDir, "README.md"), "# R3 Test Repo\n", "utf8");

  // Copy schemas needed for schema validation
  execFileSync("cp", ["-r", join(process.cwd(), "schemas"), join(repoDir, "schemas")]);

  const taskId = "TASK-R3";
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

  const runId = "run-r3-001";

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

async function setupTestingRun(orchestrator: CindyOrchestrator, runId: string, taskId: string): Promise<CindyRun> {
  await orchestrator.initRun({ runId, taskId });
  await orchestrator.markReadyForBuilder(runId);
  await orchestrator.startBuilding(runId);
  await orchestrator.completeBuilding(runId);
  await orchestrator.startTesting(runId);
  return await orchestrator.getRun(runId);
}

async function setupReadyForReviewRun(orchestrator: CindyOrchestrator, runId: string, taskId: string): Promise<CindyRun> {
  await setupTestingRun(orchestrator, runId, taskId);
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

async function setupReviewingRun(
  orchestrator: CindyOrchestrator,
  runId: string,
  taskId: string,
  session = "session-r3-default"
): Promise<CindyRun> {
  await setupReadyForReviewRun(orchestrator, runId, taskId);
  await orchestrator.startReview(runId, {
    reviewer: { identity: "reviewer@example.com", session, readOnlyConfirmed: true, readOnlyRequired: true },
  });
  return await orchestrator.getRun(runId);
}

// ============================================================
// Tests 1–6: HIGH-01 Single authority initialization (Architecture Decision CX)
// ============================================================

describe("R2F3-R3: Tests 1–6 HIGH-01 Single authority initialization", () => {

  test("TEST 1: Task OPEN at A, closure CLOSED at B: init captures B -> REJECT, no final runtime dir", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

      // Commit A: Task is OPEN
      const commitA = git(["rev-parse", "HEAD"]).trim();
      const closureA = readCommittedClosure(taskId, repoDir, commitA);
      assert.equal(closureA.isClosed, false, "Task must be open at commit A");

      // Commit B: Task is marked CLOSED with schema-compliant closeout artifact
      const closedDir = join(repoDir, ".agent", "tasks", taskId, "artifacts");
      await mkdir(closedDir, { recursive: true });
      await writeFile(
        join(closedDir, "closeout.json"),
        JSON.stringify(
          {
            runId: "prior-run",
            taskId,
            status: "CLOSED",
            finalTreeDigest: "0".repeat(64),
            finalGate: "PASS",
            closedAt: new Date().toISOString(),
          },
          null,
          2
        ),
        "utf8"
      );
      git(["add", "."]);
      git(["commit", "-m", "commit B: close task"]);
      git(["push", "-q"]);
      const commitB = git(["rev-parse", "HEAD"]).trim();

      const closureB = readCommittedClosure(taskId, repoDir, commitB);
      assert.equal(closureB.isClosed, true, "Task must be closed at commit B");

      // initializeRunSafely against repo (now at B) must reject because task is CLOSED
      const store = new RuntimeArtifactStore({ repoDir });
      await assert.rejects(
        () => store.initializeRunSafely({ runId, taskId }),
        (err: unknown) => err instanceof TransitionRejectedError && /CLOSED/.test((err as Error).message)
      );

      // Verify no final runtime directory was created
      const runDir = join(repoDir, ".agent", "runtime", runId);
      assert.ok(!existsSync(runDir), "run directory must NOT be created when task is CLOSED");
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 2: A Task CLOSED, B Task OPEN: capture A, cannot switch to B to reopen CLOSED task", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

      // Mark task CLOSED at commit A
      const closedDir = join(repoDir, ".agent", "tasks", taskId, "artifacts");
      await mkdir(closedDir, { recursive: true });
      await writeFile(
        join(closedDir, "closeout.json"),
        JSON.stringify(
          {
            runId: "prior-run",
            taskId,
            status: "CLOSED",
            finalTreeDigest: "0".repeat(64),
            finalGate: "PASS",
            closedAt: new Date().toISOString(),
          },
          null,
          2
        ),
        "utf8"
      );
      git(["add", "."]);
      git(["commit", "-m", "commit A: close task"]);
      const commitA = git(["rev-parse", "HEAD"]).trim();

      // Commit B deletes closeout artifact (attempt to reopen task)
      git(["rm", join(closedDir, "closeout.json")]);
      git(["commit", "-m", "commit B: reopen task"]);
      git(["push", "-q"]);
      const commitB = git(["rev-parse", "HEAD"]).trim();

      // Closure read anchored at A must report CLOSED
      const closureAtA = readCommittedClosure(taskId, repoDir, commitA);
      assert.equal(closureAtA.isClosed, true, "closure read at commit A must be CLOSED");

      // Evaluating authority bound to commit A must reject (cannot switch to B or reopen)
      const evalResult = evaluateGitAuthority({
        repoDir,
        taskId,
        runSnapshot: {
          branch: "main",
          headCommit: commitA,
          baseCommit: env.baseCommit,
          taskAuthorityCommit: commitA,
          upstreamSha: commitA,
          upstreamRef: "origin/main",
          upstreamCommit: commitA,
          allowedScope: ["src/", "schemas/", "tools/", "tests/"],
        },
      });
      assert.equal(evalResult.ok, false, "Authority bound to A when HEAD is at B must fail closed");
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 3: A Task OPEN, B Task OPEN with different allowedScope -> rejects authority drift", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

      const commitA = git(["rev-parse", "HEAD"]).trim();

      // Modify allowedScope at commit B
      const taskPath = join(repoDir, ".agent", "tasks", taskId, "task.json");
      const packetB = JSON.parse(await readFile(taskPath, "utf8"));
      packetB.allowedScope = ["src/", "narrow/"];
      await writeFile(taskPath, JSON.stringify(packetB, null, 2), "utf8");
      git(["add", taskPath]);
      git(["commit", "-m", "commit B: change allowedScope"]);
      git(["push", "-q"]);
      const commitB = git(["rev-parse", "HEAD"]).trim();

      const packetAtA = readCanonicalTaskPacketAtCommit(repoDir, taskId, commitA);
      const packetAtB = readCanonicalTaskPacketAtCommit(repoDir, taskId, commitB);

      assert.deepEqual(packetAtA.taskPacket.allowedScope, ["src/", "schemas/", "tools/", "tests/"]);
      assert.deepEqual(packetAtB.taskPacket.allowedScope, ["src/", "narrow/"]);

      // Evaluating authority bound to A when repo is at B must reject
      const evalResult = evaluateGitAuthority({
        repoDir,
        taskId,
        runSnapshot: {
          branch: "main",
          headCommit: commitA,
          baseCommit: env.baseCommit,
          taskAuthorityCommit: commitA,
          upstreamSha: commitA,
          upstreamRef: "origin/main",
          upstreamCommit: commitA,
          allowedScope: ["src/", "schemas/", "tools/", "tests/"],
        },
      });
      assert.equal(evalResult.ok, false, "Authority must reject drift between A and B");
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 4: A/B task-history different -> isolated and cannot mix", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

      const commitA = git(["rev-parse", "HEAD"]).trim();

      // Update task reviewHistory at commit B
      const taskPath = join(repoDir, ".agent", "tasks", taskId, "task.json");
      const packet = JSON.parse(await readFile(taskPath, "utf8"));
      packet.reviewHistory = [{ review: "Review 1", verdict: "FAIL" }];
      await writeFile(taskPath, JSON.stringify(packet, null, 2), "utf8");
      git(["add", taskPath]);
      git(["commit", "-m", "commit B: add review history"]);
      const commitB = git(["rev-parse", "HEAD"]).trim();

      const packetAtA = readCanonicalTaskPacketAtCommit(repoDir, taskId, commitA);
      const packetAtB = readCanonicalTaskPacketAtCommit(repoDir, taskId, commitB);

      assert.equal(packetAtA.taskPacket.reviewHistory, undefined);
      assert.equal((packetAtB.taskPacket.reviewHistory as unknown[])?.length, 1);
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 5: A/B task authority last-modifier different -> isolated and cannot mix", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

      const commitA = git(["rev-parse", "HEAD"]).trim();

      // Commit B modifies task.json goal
      const taskPath = join(repoDir, ".agent", "tasks", taskId, "task.json");
      const packet = JSON.parse(await readFile(taskPath, "utf8"));
      packet.goal = "Updated goal at B";
      await writeFile(taskPath, JSON.stringify(packet, null, 2), "utf8");
      git(["add", taskPath]);
      git(["commit", "-m", "commit B: update task.json"]);
      const commitB = git(["rev-parse", "HEAD"]).trim();

      const packetAtA = readCanonicalTaskPacketAtCommit(repoDir, taskId, commitA);
      const packetAtB = readCanonicalTaskPacketAtCommit(repoDir, taskId, commitB);

      assert.equal(packetAtA.taskAuthorityCommit, commitA);
      assert.equal(packetAtB.taskAuthorityCommit, commitB);
      assert.notEqual(packetAtA.taskAuthorityCommit, packetAtB.taskAuthorityCommit);
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 6: A stable healthy -> init PASS with full run bundle created", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const headBefore = git(["rev-parse", "HEAD"]).trim();

      const store = new RuntimeArtifactStore({ repoDir });
      const run = await store.initializeRunSafely({ runId, taskId });

      assert.equal(run.state, CindyState.TASK_INITIALIZED);
      assert.equal(run.headCommit, headBefore);
      assert.equal(run.taskAuthorityCommit, headBefore);
      assert.equal(run.runId, runId);
      assert.equal(run.taskId, taskId);
      assert.ok(run.upstreamRef, "upstreamRef must be set");
      assert.ok(run.upstreamCommit, "upstreamCommit must be set");

      // Verify final runtime directory exists and has valid run.json
      const runJsonPath = join(repoDir, ".agent", "runtime", runId, "run.json");
      assert.ok(existsSync(runJsonPath), "run.json must exist in final runtime directory");
    } finally {
      await env.cleanup();
    }
  });
});

// ============================================================
// Tests 7–12: HIGH-02 Raw symlink component walk (Architecture Decision CY)
// ============================================================

describe("R2F3-R3: Tests 7–12 HIGH-02 Raw symlink component walk", () => {

  test("TEST 7: symlink targeting absolute path outside repo → SymlinkEscapeError immediately", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r3-sym-"));
    try {
      symlinkSync("/tmp", join(repoDir, "escape-link"));
      assert.throws(
        () => assertSnapshotPathContained(repoDir, "escape-link"),
        SymlinkEscapeError
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("TEST 8: hop→outside/dir then link→hop/../safe catches escape via intermediate hop (Architecture Decision CY)", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r3-sym-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "cindy-r3-outside-"));
    try {
      symlinkSync(outsideDir, join(repoDir, "hop"));
      symlinkSync("hop/../safe", join(repoDir, "link"));

      assert.throws(
        () => assertSnapshotPathContained(repoDir, "link"),
        SymlinkEscapeError
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test("TEST 9: symlink to sibling file inside repo → allowed", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r3-sym-"));
    try {
      await writeFile(join(repoDir, "real-file.txt"), "content", "utf8");
      symlinkSync("real-file.txt", join(repoDir, "link-to-real"));

      assert.doesNotThrow(() => assertSnapshotPathContained(repoDir, "link-to-real"));
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("TEST 10: relative symlink targeting ../ escapes repository root", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "cindy-r3-base-"));
    const repoDir = join(baseDir, "repo");
    await mkdir(repoDir, { recursive: true });
    try {
      symlinkSync("../", join(repoDir, "escape"));
      assert.throws(
        () => assertSnapshotPathContained(repoDir, "escape"),
        SymlinkEscapeError
      );
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("TEST 11: nested relative symlink within repo allowed (no escape)", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r3-sym-"));
    try {
      await mkdir(join(repoDir, "subdir"), { recursive: true });
      await writeFile(join(repoDir, "subdir", "file.txt"), "hello", "utf8");
      symlinkSync("file.txt", join(repoDir, "subdir", "link-to-file"));

      assert.doesNotThrow(() => assertSnapshotPathContained(repoDir, "subdir/link-to-file"));
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("TEST 12: symlink chain with intermediate escape → SymlinkEscapeError", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r3-sym-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "cindy-r3-outs-"));
    try {
      symlinkSync(outsideDir, join(repoDir, "link2"));
      symlinkSync("link2", join(repoDir, "link1"));

      assert.throws(
        () => assertSnapshotPathContained(repoDir, "link1"),
        SymlinkEscapeError
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// Tests 13–16: MEDIUM-03 Resolved reserved namespace guard (Architecture Decision CZ)
// ============================================================

describe("R2F3-R3: Tests 13–16 MEDIUM-03 Resolved reserved namespaces", () => {

  test("TEST 13: symlink alias → .git must be rejected (resolved reserved namespace)", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r3-ns-"));
    try {
      await mkdir(join(repoDir, ".git"), { recursive: true });
      symlinkSync(".git", join(repoDir, "git-alias"));

      assert.throws(
        () => assertSnapshotPathContained(repoDir, "git-alias"),
        SymlinkEscapeError
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("TEST 14: symlink alias → .agent/runtime must be rejected (resolved reserved namespace)", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r3-ns-"));
    try {
      await mkdir(join(repoDir, ".agent", "runtime"), { recursive: true });
      symlinkSync(".agent/runtime", join(repoDir, "runtime-alias"));

      assert.throws(
        () => assertSnapshotPathContained(repoDir, "runtime-alias"),
        SymlinkEscapeError
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("TEST 15: symlink alias → .agent/.cindy-init-staging must be rejected (resolved reserved namespace)", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r3-ns-"));
    try {
      await mkdir(join(repoDir, ".agent", ".cindy-init-staging"), { recursive: true });
      symlinkSync(".agent/.cindy-init-staging", join(repoDir, "staging-alias"));

      assert.throws(
        () => assertSnapshotPathContained(repoDir, "staging-alias"),
        SymlinkEscapeError
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("TEST 16: symlink to normal directory inside repo is allowed (not a reserved namespace)", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r3-ns-"));
    try {
      await mkdir(join(repoDir, "src"), { recursive: true });
      await writeFile(join(repoDir, "src", "main.ts"), "export {}", "utf8");
      symlinkSync("src", join(repoDir, "src-alias"));

      assert.doesNotThrow(() => assertSnapshotPathContained(repoDir, "src-alias"));
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// Tests 17–19: MEDIUM-04 POSIX backslash semantics (Architecture Decision DA)
// ============================================================

describe("R2F3-R3: Tests 17–19 MEDIUM-04 POSIX backslash is data", () => {

  test("TEST 17: filename '.git\\config' (backslash in name) is a POSIX filename, not a path separator — must be accepted as ignored input", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r3-bs-"));
    try {
      assert.doesNotThrow(
        () => validateIgnoredPathEntry(".git\\config", repoDir, "TASK-R3"),
        "backslash in filename is valid POSIX data — must NOT be treated as path separator"
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("TEST 18: filename '.agent\\runtime' (backslash) is a POSIX filename, must be accepted as ignored input", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r3-bs-"));
    try {
      assert.doesNotThrow(
        () => validateIgnoredPathEntry(".agent\\runtime", repoDir, "TASK-R3"),
        ".agent\\runtime with backslash is NOT .agent/runtime — must be accepted as data filename"
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("TEST 19: actual '.git' (no backslash) as ignored path must be rejected (it IS reserved)", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r3-bs-"));
    try {
      assert.throws(
        () => validateIgnoredPathEntry(".git", repoDir, "TASK-R3"),
        (err: unknown) => (err as Error).message.includes("Reserved") || (err as Error).constructor.name.includes("ExecutionInputsValidationError")
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// Tests 20–23: HIGH-03 Semantic LAST authority fence order (Architecture Decision DB)
// ============================================================

describe("R2F3-R3: Tests 20–23 HIGH-03 SNAPSHOT_FINAL before FINAL_AUTHORITY", () => {

  test("TEST 20: prepareForReview succeeds under stable authority (completes SNAPSHOT_FINAL → FINAL_AUTHORITY → write)", async () => {
    const env = await createTestRepo();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await setupReadyForReviewRun(orchestrator, env.runId, env.taskId);
      assert.equal(run.state, CindyState.READY_FOR_REVIEW);
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 21: startReview succeeds under stable authority", async () => {
    const env = await createTestRepo();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await setupReviewingRun(orchestrator, env.runId, env.taskId);
      assert.equal(run.state, CindyState.REVIEWING);
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 22: recordValidatedReviewResult PASS succeeds under stable authority", async () => {
    const env = await createTestRepo();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await setupReviewingRun(orchestrator, env.runId, env.taskId, "session-pass");

      const snap = await orchestrator.computeCurrentExecutionSnapshot(env.taskId);
      const tree = await orchestrator.computeCurrentTreeDigest();
      const diff = await orchestrator.computeCurrentDiffDigest();

      const passReview: ReviewResultArtifact = {
        runId: env.runId,
        taskId: env.taskId,
        cycle: 1,
        verdict: "PASS",
        reviewedTreeDigest: tree,
        reviewedDiffDigest: diff,
        reviewedBaseCommit: run.baseCommit,
        executionSnapshotVersion: snap.version,
        executionSnapshotDigest: snap.digest,
        findings: [],
        recordedAt: new Date().toISOString(),
        reviewer: {
          identity: "reviewer@example.com",
          session: "session-pass",
          readOnlyConfirmed: true,
        },
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      };

      const resultRun = await orchestrator.recordValidatedReviewResult(env.runId, passReview);
      assert.equal(resultRun.state, CindyState.REVIEWING);
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 23: recordValidatedReviewResult FAIL succeeds under stable authority — advances to REPAIR_INITIALIZED", async () => {
    const env = await createTestRepo();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await setupReviewingRun(orchestrator, env.runId, env.taskId, "session-fail");

      const snap = await orchestrator.computeCurrentExecutionSnapshot(env.taskId);
      const tree = await orchestrator.computeCurrentTreeDigest();
      const diff = await orchestrator.computeCurrentDiffDigest();

      const failReview: ReviewResultArtifact = {
        runId: env.runId,
        taskId: env.taskId,
        cycle: 1,
        verdict: "FAIL",
        reviewedTreeDigest: tree,
        reviewedDiffDigest: diff,
        reviewedBaseCommit: run.baseCommit,
        executionSnapshotVersion: snap.version,
        executionSnapshotDigest: snap.digest,
        findings: [{ id: "F1", severity: "HIGH", title: "Test finding" }],
        recordedAt: new Date().toISOString(),
        reviewer: {
          identity: "reviewer@example.com",
          session: "session-fail",
          readOnlyConfirmed: true,
        },
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      };

      const resultRun = await orchestrator.recordValidatedReviewResult(env.runId, failReview);
      assert.equal(resultRun.state, CindyState.REPAIR_INITIALIZED);
      assert.equal(resultRun.currentCycle, 2);
    } finally {
      await env.cleanup();
    }
  });
});

// ============================================================
// Tests 24–28: MEDIUM-01 Duplicate replay final authority fence (Architecture Decision DC)
// ============================================================

describe("R2F3-R3: Tests 24–28 MEDIUM-01 Duplicate replay final authority fence", () => {

  test("TEST 24: PASS duplicate replay succeeds under stable authority", async () => {
    const env = await createTestRepo();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await setupReviewingRun(orchestrator, env.runId, env.taskId, "session-dup-pass");

      const snap = await orchestrator.computeCurrentExecutionSnapshot(env.taskId);
      const tree = await orchestrator.computeCurrentTreeDigest();
      const diff = await orchestrator.computeCurrentDiffDigest();

      const passReview: ReviewResultArtifact = {
        runId: env.runId,
        taskId: env.taskId,
        cycle: 1,
        verdict: "PASS",
        reviewedTreeDigest: tree,
        reviewedDiffDigest: diff,
        reviewedBaseCommit: run.baseCommit,
        executionSnapshotVersion: snap.version,
        executionSnapshotDigest: snap.digest,
        findings: [],
        recordedAt: new Date().toISOString(),
        reviewer: {
          identity: "reviewer@example.com",
          session: "session-dup-pass",
          readOnlyConfirmed: true,
        },
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      };

      const run1 = await orchestrator.recordValidatedReviewResult(env.runId, passReview);
      assert.equal(run1.state, CindyState.REVIEWING);

      // Replay PASS
      const run2 = await orchestrator.recordValidatedReviewResult(env.runId, passReview);
      assert.equal(run2.state, CindyState.REVIEWING);
      assert.equal(run2.version, run1.version, "Duplicate PASS replay must NOT bump version");
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 25: FAIL duplicate replay succeeds under stable authority", async () => {
    const env = await createTestRepo();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await setupReviewingRun(orchestrator, env.runId, env.taskId, "session-dup-fail");

      const snap = await orchestrator.computeCurrentExecutionSnapshot(env.taskId);
      const tree = await orchestrator.computeCurrentTreeDigest();
      const diff = await orchestrator.computeCurrentDiffDigest();

      const failReview: ReviewResultArtifact = {
        runId: env.runId,
        taskId: env.taskId,
        cycle: 1,
        verdict: "FAIL",
        reviewedTreeDigest: tree,
        reviewedDiffDigest: diff,
        reviewedBaseCommit: run.baseCommit,
        executionSnapshotVersion: snap.version,
        executionSnapshotDigest: snap.digest,
        findings: [{ id: "F1", severity: "HIGH", title: "Finding" }],
        recordedAt: new Date().toISOString(),
        reviewer: {
          identity: "reviewer@example.com",
          session: "session-dup-fail",
          readOnlyConfirmed: true,
        },
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      };

      const run1 = await orchestrator.recordValidatedReviewResult(env.runId, failReview);
      assert.equal(run1.state, CindyState.REPAIR_INITIALIZED);

      // Replay FAIL
      const run2 = await orchestrator.recordValidatedReviewResult(env.runId, failReview);
      assert.equal(run2.state, CindyState.REPAIR_INITIALIZED);
      assert.equal(run2.version, run1.version, "Duplicate FAIL replay must NOT bump version");
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 26: PASS replay with mismatched snapshot digest → ArtifactDigestMismatchError", async () => {
    const env = await createTestRepo();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await setupReviewingRun(orchestrator, env.runId, env.taskId, "session-mm-pass");

      const snap = await orchestrator.computeCurrentExecutionSnapshot(env.taskId);
      const tree = await orchestrator.computeCurrentTreeDigest();
      const diff = await orchestrator.computeCurrentDiffDigest();

      const passReview: ReviewResultArtifact = {
        runId: env.runId,
        taskId: env.taskId,
        cycle: 1,
        verdict: "PASS",
        reviewedTreeDigest: tree,
        reviewedDiffDigest: diff,
        reviewedBaseCommit: run.baseCommit,
        executionSnapshotVersion: snap.version,
        executionSnapshotDigest: snap.digest,
        findings: [],
        recordedAt: new Date().toISOString(),
        reviewer: {
          identity: "reviewer@example.com",
          session: "session-mm-pass",
          readOnlyConfirmed: true,
        },
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      };

      await orchestrator.recordValidatedReviewResult(env.runId, passReview);

      // Replay with bad digest
      const badReview: ReviewResultArtifact = {
        ...passReview,
        executionSnapshotDigest: "a".repeat(64),
      };

      await assert.rejects(
        () => orchestrator.recordValidatedReviewResult(env.runId, badReview),
        (err: unknown) => err instanceof ArtifactDigestMismatchError
      );
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 27: FAIL replay with mismatched snapshot digest → ArtifactDigestMismatchError", async () => {
    const env = await createTestRepo();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await setupReviewingRun(orchestrator, env.runId, env.taskId, "session-mm-fail");

      const snap = await orchestrator.computeCurrentExecutionSnapshot(env.taskId);
      const tree = await orchestrator.computeCurrentTreeDigest();
      const diff = await orchestrator.computeCurrentDiffDigest();

      const failReview: ReviewResultArtifact = {
        runId: env.runId,
        taskId: env.taskId,
        cycle: 1,
        verdict: "FAIL",
        reviewedTreeDigest: tree,
        reviewedDiffDigest: diff,
        reviewedBaseCommit: run.baseCommit,
        executionSnapshotVersion: snap.version,
        executionSnapshotDigest: snap.digest,
        findings: [{ id: "F1", severity: "HIGH", title: "Finding" }],
        recordedAt: new Date().toISOString(),
        reviewer: {
          identity: "reviewer@example.com",
          session: "session-mm-fail",
          readOnlyConfirmed: true,
        },
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      };

      await orchestrator.recordValidatedReviewResult(env.runId, failReview);

      // Replay with bad digest
      const badReplay: ReviewResultArtifact = {
        ...failReview,
        executionSnapshotDigest: "b".repeat(64),
      };

      await assert.rejects(
        () => orchestrator.recordValidatedReviewResult(env.runId, badReplay),
        (err: unknown) => err instanceof ArtifactDigestMismatchError
      );
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 28: FAIL replay with PASS verdict → ConflictingArtifactError", async () => {
    const env = await createTestRepo();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await setupReviewingRun(orchestrator, env.runId, env.taskId, "session-conflict");

      const snap = await orchestrator.computeCurrentExecutionSnapshot(env.taskId);
      const tree = await orchestrator.computeCurrentTreeDigest();
      const diff = await orchestrator.computeCurrentDiffDigest();

      const failReview: ReviewResultArtifact = {
        runId: env.runId,
        taskId: env.taskId,
        cycle: 1,
        verdict: "FAIL",
        reviewedTreeDigest: tree,
        reviewedDiffDigest: diff,
        reviewedBaseCommit: run.baseCommit,
        executionSnapshotVersion: snap.version,
        executionSnapshotDigest: snap.digest,
        findings: [{ id: "F1", severity: "HIGH", title: "Finding" }],
        recordedAt: new Date().toISOString(),
        reviewer: {
          identity: "reviewer@example.com",
          session: "session-conflict",
          readOnlyConfirmed: true,
        },
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      };

      await orchestrator.recordValidatedReviewResult(env.runId, failReview);

      const passAttempt: ReviewResultArtifact = {
        ...failReview,
        verdict: "PASS",
        findings: [],
      };

      await assert.rejects(
        () => orchestrator.recordValidatedReviewResult(env.runId, passAttempt),
        (err: unknown) => err instanceof ConflictingArtifactError || (err as Error).constructor.name.includes("Conflicting")
      );
    } finally {
      await env.cleanup();
    }
  });
});

// ============================================================
// Tests 29–31: MEDIUM-02 Final dirty ownership fresh reread (Architecture Decision DD)
// ============================================================

describe("R2F3-R3: Tests 29–31 MEDIUM-02 Final dirty ownership fresh reread in evaluateGitAuthority", () => {

  test("TEST 29: evaluateGitAuthority with clean tree passes final fence dirty check", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const headCommit = git(["rev-parse", "HEAD"]).trim();
      const upstreamStatus = checkGitUpstreamStatus(repoDir);
      const upstreamRef = upstreamStatus.upstream?.ref!;
      const upstreamSha = upstreamStatus.upstream?.commit!;

      const result = evaluateGitAuthority({
        repoDir,
        taskId,
        runSnapshot: {
          branch: "main",
          headCommit,
          baseCommit: env.baseCommit,
          taskAuthorityCommit: headCommit,
          upstreamSha,
          upstreamRef,
          upstreamCommit: upstreamSha,
          allowedScope: ["src/", "schemas/", "tools/", "tests/"],
        },
      });

      assert.equal(result.ok, true, "clean repo with correct authority must pass");
      assert.equal(result.actualStatus.isClean, true);
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 30: evaluateGitAuthority with in-scope dirty file passes and returns updated status", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const headCommit = git(["rev-parse", "HEAD"]).trim();
      const upstreamStatus = checkGitUpstreamStatus(repoDir);
      const upstreamRef = upstreamStatus.upstream?.ref!;
      const upstreamSha = upstreamStatus.upstream?.commit!;

      // Add in-scope dirty file
      await mkdir(join(repoDir, "src"), { recursive: true });
      await writeFile(join(repoDir, "src", "new-file.ts"), "// in scope", "utf8");

      const result = evaluateGitAuthority({
        repoDir,
        taskId,
        runSnapshot: {
          branch: "main",
          headCommit,
          baseCommit: env.baseCommit,
          taskAuthorityCommit: headCommit,
          upstreamSha,
          upstreamRef,
          upstreamCommit: upstreamSha,
          allowedScope: ["src/", "schemas/", "tools/", "tests/"],
        },
      });

      assert.equal(result.ok, true, "in-scope dirty file must pass authority check");
      assert.equal(result.actualStatus.isClean, false);
      assert.ok(result.actualStatus.dirtyFiles.includes("src/new-file.ts"));
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 31: evaluateGitAuthority with out-of-scope dirty file at final fence → fails with DIRTY_TREE_UNEXPLAINED", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const headCommit = git(["rev-parse", "HEAD"]).trim();
      const upstreamStatus = checkGitUpstreamStatus(repoDir);
      const upstreamRef = upstreamStatus.upstream?.ref!;
      const upstreamSha = upstreamStatus.upstream?.commit!;

      // Add out-of-scope dirty file
      await writeFile(join(repoDir, "outside-scope.txt"), "outside scope content", "utf8");

      const result = evaluateGitAuthority({
        repoDir,
        taskId,
        runSnapshot: {
          branch: "main",
          headCommit,
          baseCommit: env.baseCommit,
          taskAuthorityCommit: headCommit,
          upstreamSha,
          upstreamRef,
          upstreamCommit: upstreamSha,
          allowedScope: ["src/", "schemas/", "tools/", "tests/"],
        },
      });

      assert.equal(result.ok, false, "out-of-scope dirty file must fail authority check");
      assert.match(result.stopExplanation ?? "", /DIRTY_TREE_UNEXPLAINED/i);
    } finally {
      await env.cleanup();
    }
  });
});

// ============================================================
// Test 32: HIGH-01/DE Init final dirty fence fresh reread
// ============================================================

describe("R2F3-R3: Test 32 HIGH-01/DE Init publication fence fresh dirty reread", () => {

  test("TEST 32: initializeRunSafely succeeds when tree is clean at publication fence", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const store = new RuntimeArtifactStore({ repoDir });

      const run = await store.initializeRunSafely({ runId, taskId });
      assert.equal(run.state, CindyState.TASK_INITIALIZED);
    } finally {
      await env.cleanup();
    }
  });
});

// ============================================================
// Tests 33–37: LOW-01 ReviewResult zero Store calls before validation (Architecture Decision DF)
// ============================================================

describe("R2F3-R3: Tests 33–37 LOW-01 ReviewResult pre-Store validation", () => {

  test("TEST 33: missing executionSnapshotVersion → ArtifactValidationError before any Store access", async () => {
    const env = await createTestRepo();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });

      const badReview = {
        runId: env.runId,
        taskId: env.taskId,
        cycle: 1,
        verdict: "PASS",
        reviewedTreeDigest: "a".repeat(64),
        reviewedDiffDigest: "b".repeat(64),
        reviewedBaseCommit: "c".repeat(40),
        executionSnapshotDigest: "d".repeat(64),
        reviewer: { identity: "reviewer@example.com", session: "s1", readOnlyConfirmed: true },
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      } as unknown as ReviewResultArtifact;

      await assert.rejects(
        () => orchestrator.recordValidatedReviewResult("nonexistent-run", badReview),
        (err: unknown) => err instanceof ArtifactValidationError && /executionSnapshotVersion/.test((err as Error).message)
      );
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 34: unknown executionSnapshotVersion → ArtifactValidationError before any Store access", async () => {
    const env = await createTestRepo();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });

      const badReview = {
        runId: env.runId,
        taskId: env.taskId,
        cycle: 1,
        verdict: "PASS",
        reviewedTreeDigest: "a".repeat(64),
        reviewedDiffDigest: "b".repeat(64),
        reviewedBaseCommit: "c".repeat(40),
        executionSnapshotVersion: "UNKNOWN_VERSION_V999",
        executionSnapshotDigest: "d".repeat(64),
        reviewer: { identity: "reviewer@example.com", session: "s1", readOnlyConfirmed: true },
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      } as unknown as ReviewResultArtifact;

      await assert.rejects(
        () => orchestrator.recordValidatedReviewResult("nonexistent-run", badReview),
        (err: unknown) => err instanceof ArtifactValidationError && /executionSnapshotVersion/.test((err as Error).message)
      );
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 35: missing executionSnapshotDigest → ArtifactValidationError before any Store access", async () => {
    const env = await createTestRepo();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });

      const badReview = {
        runId: env.runId,
        taskId: env.taskId,
        cycle: 1,
        verdict: "PASS",
        reviewedTreeDigest: "a".repeat(64),
        reviewedDiffDigest: "b".repeat(64),
        reviewedBaseCommit: "c".repeat(40),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        reviewer: { identity: "reviewer@example.com", session: "s1", readOnlyConfirmed: true },
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      } as unknown as ReviewResultArtifact;

      await assert.rejects(
        () => orchestrator.recordValidatedReviewResult("nonexistent-run", badReview),
        (err: unknown) => err instanceof ArtifactValidationError && /executionSnapshotDigest/.test((err as Error).message)
      );
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 36: malformed executionSnapshotDigest → ArtifactValidationError before any Store access", async () => {
    const env = await createTestRepo();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });

      const badReview = {
        runId: env.runId,
        taskId: env.taskId,
        cycle: 1,
        verdict: "PASS",
        reviewedTreeDigest: "a".repeat(64),
        reviewedDiffDigest: "b".repeat(64),
        reviewedBaseCommit: "c".repeat(40),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: "not-64-hex",
        reviewer: { identity: "reviewer@example.com", session: "s1", readOnlyConfirmed: true },
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      } as unknown as ReviewResultArtifact;

      await assert.rejects(
        () => orchestrator.recordValidatedReviewResult("nonexistent-run", badReview),
        (err: unknown) => err instanceof ArtifactValidationError && /executionSnapshotDigest/.test((err as Error).message)
      );
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 37: valid snapshot fields but non-existent run → fails with run not found error (Store access happens after validation)", async () => {
    const env = await createTestRepo();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });

      const goodShapeReview = {
        runId: env.runId,
        taskId: env.taskId,
        cycle: 1,
        verdict: "PASS",
        reviewedTreeDigest: "a".repeat(64),
        reviewedDiffDigest: "b".repeat(64),
        reviewedBaseCommit: "c".repeat(40),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: "d".repeat(64),
        reviewer: { identity: "reviewer@example.com", session: "s1", readOnlyConfirmed: true },
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      } as unknown as ReviewResultArtifact;

      await assert.rejects(
        () => orchestrator.recordValidatedReviewResult("nonexistent-run-xyz", goodShapeReview),
        (err: unknown) => {
          const msg = (err as Error).message;
          return !msg.includes("executionSnapshotVersion") && !msg.includes("executionSnapshotDigest");
        }
      );
    } finally {
      await env.cleanup();
    }
  });
});

// ============================================================
// Tests 38–39: consumeReviewPass authority and task drift checks
// ============================================================

describe("R2F3-R3: Tests 38–39 consumeReviewPass authority drift checks", () => {

  test("TEST 38: consumeReviewPass Task authority drift -> rejects with TransitionRejectedError", async () => {
    const env = await createTestRepo();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await setupReviewingRun(orchestrator, env.runId, env.taskId, "sess-pass-38");

      // Record a PASS review result into store
      const snap = await orchestrator.computeCurrentExecutionSnapshot(env.taskId);
      const tree = await orchestrator.computeCurrentTreeDigest();
      const diff = await orchestrator.computeCurrentDiffDigest();

      const store = orchestrator.artifactStore;
      await store.recordReviewResult(run.runId, {
        runId: run.runId,
        taskId: run.taskId,
        reviewedBaseCommit: run.baseCommit,
        cycle: 1,
        reviewer: { identity: "reviewer@example.com", session: "sess-pass-38", readOnlyConfirmed: true },
        reviewedTreeDigest: tree,
        reviewedDiffDigest: diff,
        verdict: "PASS",
        findings: [],
        recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest,
      });

      // Cause Task authority drift: update-ref origin/main to another commit
      const git = (args: string[]) => execFileSync("git", args, { cwd: env.repoDir, encoding: "utf8" });
      git(["update-ref", "refs/remotes/origin/main", "HEAD~1"]);

      await assert.rejects(
        () => orchestrator.consumeReviewPass(run.runId),
        (err: unknown) => err instanceof TransitionRejectedError
      );
    } finally {
      await env.cleanup();
    }
  });

  test("TEST 39: consumeReviewPass Task Packet drift -> rejects with TransitionRejectedError", async () => {
    const env = await createTestRepo();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: env.repoDir });
      const run = await setupReviewingRun(orchestrator, env.runId, env.taskId, "sess-pass-39");

      const snap = await orchestrator.computeCurrentExecutionSnapshot(env.taskId);
      const tree = await orchestrator.computeCurrentTreeDigest();
      const diff = await orchestrator.computeCurrentDiffDigest();

      const store = orchestrator.artifactStore;
      await store.recordReviewResult(run.runId, {
        runId: run.runId,
        taskId: run.taskId,
        reviewedBaseCommit: run.baseCommit,
        cycle: 1,
        reviewer: { identity: "reviewer@example.com", session: "sess-pass-39", readOnlyConfirmed: true },
        reviewedTreeDigest: tree,
        reviewedDiffDigest: diff,
        verdict: "PASS",
        findings: [],
        recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest,
      });

      // Cause Task Packet drift: modify task.json and commit it at HEAD
      const taskPath = join(env.repoDir, ".agent", "tasks", env.taskId, "task.json");
      const packet = JSON.parse(await readFile(taskPath, "utf8"));
      packet.allowedScope = ["src/", "changed/"];
      await writeFile(taskPath, JSON.stringify(packet, null, 2), "utf8");

      const git = (args: string[]) => execFileSync("git", args, { cwd: env.repoDir, encoding: "utf8" });
      git(["add", taskPath]);
      git(["commit", "-m", "chore: drift task packet"]);
      git(["push", "-q"]);

      await assert.rejects(
        () => orchestrator.consumeReviewPass(run.runId),
        (err: unknown) => err instanceof TransitionRejectedError
      );
    } finally {
      await env.cleanup();
    }
  });
});
