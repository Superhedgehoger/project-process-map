import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile, cp, symlink, readdir, appendFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { existsSync, writeFileSync, unlinkSync } from "node:fs";

import {
  CindyOrchestrator,
  CindyState,
  ArtifactKind,
  computeTreeDigest,
  computeDiffDigest,
  checkDirtyTreeOwnership,
  RuntimeArtifactStore,
  reconcileCurrentState,
  importLegacyTask,
  TransitionRejectedError,
  ConflictingArtifactError,
  ArtifactDigestMismatchError,
  ArtifactValidationError,
  ConcurrentRunUpdateError,
  StaleRunLockError,
  ArtifactCorruptionError,
  PathTraversalError,
  InvalidRunIdError,
  assertNoSymlinkAncestors,
  assertValidSchemaDialect,
  validateDraft2020,
  loadArtifactSchema,
  CINDY_DIALECT_SCHEMA_ID,
  InvalidRepositoryRootError,
  isPrivilegedState,
  PRIVILEGED_STATES,
  CindyStopReason,
  readCommittedClosure,
  readCommittedTaskPacket,
  readCommittedFileAtHead,
  getGitUpstream,
  checkGitUpstreamStatus,
  evaluateGitAuthority,
  InvalidCommittedClosureError,
  TaskPacketNotCommittedError,
  RESUME_TARGET_WHITELIST,
  DirtyTreeUnexplainedError,
  AmbiguousActiveRunError,
  ActiveRunExistsError,
  InvalidRunRecordError,
  RunGitSnapshotIncompleteError,
  ConcurrentInitError,
  StaleInitLockError,
  validateArtifactBoundary,
  validateScopeEntry,
  isFileInScope,
  validateTaskId,
  InvalidTaskIdError,
  deepFreeze,
  executeSemanticTransition,
  canTransition,
  validateTransition,
  StateDrivingArtifactRequiresTypedWriterError,
  STATE_DRIVING_ARTIFACT_KINDS,
  CINDY_EXECUTION_SNAPSHOT_V1,
  type CindyRun,
  type ReviewResultArtifact,
} from "../tools/cindy/index.ts";

/**
 * Helper to initialize an isolated temporary git repo for tests
 */
async function createTempRepo(options?: { withoutCurrentJson?: boolean }): Promise<{ repoDir: string; initialCommit: string; baseCommit: string; cleanup: () => Promise<void> }> {
  const repoDir = await mkdtemp(join(tmpdir(), "cindy-test-repo-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

  git(["init", "-b", "main"]);
  git(["config", "user.name", "Cindy Test"]);
  git(["config", "user.email", "cindy-test@example.com"]);

  // Create .gitignore ignoring .agent/runtime/ and .agent/.cindy-init-staging/
  await writeFile(join(repoDir, ".gitignore"), "node_modules/\n.agent/runtime/\n.agent/.cindy-init-staging/\n", "utf8");
  await writeFile(join(repoDir, "README.md"), "# Test Repo\n", "utf8");

  // Copy schemas to temp repo for hermetic testing
  await cp(join(process.cwd(), "schemas"), join(repoDir, "schemas"), { recursive: true });

  git(["add", "."]);
  git(["commit", "-m", "chore: base commit"]);
  const baseCommit = git(["rev-parse", "HEAD"]).trim();

  // Create minimal legacy .agent task fixture
  const legacyTaskDir = join(repoDir, ".agent", "tasks", "P0-05A-T2b");
  const legacyArtifactDir = join(legacyTaskDir, "artifacts");
  await mkdir(legacyArtifactDir, { recursive: true });

  const legacyTask = {
    taskId: "P0-05A-T2b",
    status: "CLOSED",
    branch: "main",
    baseCommit: baseCommit,
    allowedScope: ["src/", "schemas/", "tools/", "tests/"],
    reviewHistory: [
      {
        review: "Codex R2 Review",
        verdict: "FAIL",
        repairTaskId: "P0-05A-T2b-R2F1",
        findings: ["MEDIUM-01 schema mismatch"],
      },
      {
        review: "Independent Codex R2 Repair Review",
        verdict: "PASS",
        repairTaskId: "P0-05A-T2b-R2F1",
      },
    ],
    closeoutCommit: "dummy-closeout",
  };
  await writeFile(join(legacyTaskDir, "task.json"), JSON.stringify(legacyTask, null, 2), "utf8");

  const closeout = {
    runId: "run-p0-05a-t2b-legacy",
    taskId: "P0-05A-T2b",
    status: "CLOSED",
    finalTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
    finalGate: "PASS",
    closedAt: "2026-09-28T00:00:00.000Z",
    reviewHistory: legacyTask.reviewHistory,
  };
  await writeFile(join(legacyArtifactDir, "closeout.json"), JSON.stringify(closeout, null, 2), "utf8");

  // Create active task spec for CINDY-ORCH-MVP and seed standard test tasks
  const seedTaskIds = [
    "CINDY-ORCH-MVP",
    "TEST-TASK-001",
    "TEST-TASK-002",
    "TEST-TASK-003",
    "TEST-TASK-004",
    "TEST-BIND",
    "TASK-CORRECT",
    "TASK-BASE",
    "TASK-CYCLE",
    "TASK-TREE",
    "TASK-TREE-MISMATCH",
    "TASK-RAW",
    "TASK-INJECT",
    "TASK-EC",
    "TASK-REV",
    "TASK-RO",
    "TASK-FG",
    "TASK-M01A",
    "TASK-M01B",
    "TASK-M01C",
    "TASK-M01D",
    "TASK-PRIV",
    "TASK-FA",
    "TASK-CS",
    "TASK-SM",
    "TASK-SC",
    "TASK-ROF",
    "TASK-PASS-TEST",
    "TASK-1",
    "TASK-REAL",
    "TASK-SESS",
    "TASK-CYC",
    "TEST-NO-PULL",
    "TEST-NO-UP",
    "TEST-P1",
    "TEST-P2",
    "TEST-P3",
    "TEST-P4",
    "TEST-P5",
    "TEST-P6",
    "TEST-P7",
    "TEST-SCOPE-CLEAN",
    "TEST-SCOPE-DIRTY",
    "TEST-ABS",
    "TEST-TRAVERSAL",
    "TEST-01",
    "TEST-02",
    "TEST-03",
    "TEST-04",
    "TASK-STALE-1",
    "TASK-STALE-2",
    "TASK-CONC-1",
    "TASK-STALE-REV",
    "TASK-CANONICAL",
    "TEST-VALID-UP",
    "TASK-R6R1",
    "TASK-NOOP",
    "TASK-DEEP",
    "TASK-PUB",
    "TASK-ALL-PRIV",
    "TASK-FAIL-OK",
    "TASK-FAIL-BAD",
    "TASK-NB-01",
    "TASK-NB-02",
    "TASK-NB-03",
    "TASK-NB-04",
  ];

  for (const tid of seedTaskIds) {
    const tdir = join(repoDir, ".agent", "tasks", tid);
    await mkdir(tdir, { recursive: true });
    await writeFile(
      join(tdir, "task.json"),
      JSON.stringify(
        {
          taskId: tid,
          status: "READY",
          branch: "main",
          baseCommit: baseCommit,
          allowedScope: ["src/", "schemas/", "tools/", "tests/"],
        },
        null,
        2
      ),
      "utf8"
    );
  }

  // Initial .agent/current.json
  if (!options?.withoutCurrentJson) {
    const currentJson = {
      task: "CINDY-ORCH-MVP",
      status: "READY",
      branch: "main",
    };
    await writeFile(join(repoDir, ".agent", "current.json"), JSON.stringify(currentJson, null, 2), "utf8");
  }

  git(["add", "."]);
  git(["commit", "-m", "chore: initial test commit"]);

  const initialCommit = git(["rev-parse", "HEAD"]).trim();

  // Configure upstream remote tracking for hermetic test isolation
  const bareDir = await mkdtemp(join(tmpdir(), "cindy-test-bare-"));
  execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: bareDir, encoding: "utf8" });
  git(["remote", "add", "origin", bareDir]);
  git(["push", "-u", "-q", "origin", "main"]);

  return {
    repoDir,
    initialCommit,
    baseCommit,
    cleanup: async () => {
      await rm(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(bareDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/**
 * Helper to seed a valid minimal run.json for direct storage tests (Decision AQ compliance)
 */
async function seedRun(repoDir: string, runId: string, taskId = "TEST-01"): Promise<void> {
  const runDir = join(repoDir, ".agent", "runtime", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "run.json"),
    JSON.stringify(
      {
        runId,
        taskId,
        version: 1,
        state: CindyState.TESTING,
        currentCycle: 1,
        branch: "main",
        baseCommit: "0000000000000000000000000000000000000000",
        headCommit: "0000000000000000000000000000000000000000",
        taskAuthorityCommit: "0000000000000000000000000000000000000000",
        upstreamRef: "refs/remotes/origin/main",
        upstreamCommit: "0000000000000000000000000000000000000000",
        allowedScope: ["src/"],
        history: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf8"
  );
}

async function createMockRegisteredRun(repoDir: string, runId: string, taskId = "TEST-TASK-001"): Promise<string> {
  const runDir = join(repoDir, ".agent", "runtime", runId);
  await mkdir(runDir, { recursive: true });
  const run: CindyRun = {
    runId,
    taskId,
    version: 1,
    state: CindyState.TASK_INITIALIZED,
    currentCycle: 1,
    branch: "main",
    baseCommit: "0123456789abcdef0123456789abcdef01234567",
    headCommit: "0123456789abcdef0123456789abcdef01234567",
    taskAuthorityCommit: "0123456789abcdef0123456789abcdef01234567",
    upstreamRef: "refs/remotes/origin/main",
    upstreamCommit: "0123456789abcdef0123456789abcdef01234567",
    allowedScope: ["src/"],
    boundTreeDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    stopReason: null,
    stopExplanation: null,
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(join(runDir, "run.json"), JSON.stringify(run, null, 2), "utf8");
  return runDir;
}

// =========================================================================
// Baseline tests 1 to 23 (with R2-01/02/07/08/10 updates)
// =========================================================================

test("1. valid administrative and evidence-aware state transition succeeds", async () => {
  const { repoDir, baseCommit, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-valid-1",
      taskId: "TEST-TASK-001",
      baseCommit: baseCommit,
      branch: "main",
      allowedScope: ["src/"],
    });

    assert.equal(run.state, CindyState.TASK_INITIALIZED);

    const step1 = await orchestrator.markReadyForBuilder(run.runId);
    assert.equal(step1.state, CindyState.READY_FOR_BUILDER);

    const step2 = await orchestrator.startBuilding(run.runId);
    assert.equal(step2.state, CindyState.BUILDING);

    const step3 = await orchestrator.completeBuilding(run.runId);
    assert.equal(step3.state, CindyState.BUILDER_COMPLETE);

    const step4 = await orchestrator.startTesting(run.runId);
    assert.equal(step4.state, CindyState.TESTING);

    // Direct transition to READY_FOR_REVIEW must be rejected (R2-02)
    await assert.rejects(
      async () => {
        await orchestrator.transition(run.runId, CindyState.READY_FOR_REVIEW);
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );

    // Record test result artifact for cycle 1
    const tree = await orchestrator.computeCurrentTreeDigest();
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: tree,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });

    const step5 = await orchestrator.prepareForReview(run.runId);
    assert.equal(step5.state, CindyState.READY_FOR_REVIEW);

    const step6 = await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Reviewer Cindy", session: "sess-1", readOnlyConfirmed: true },
    });
    assert.equal(step6.state, CindyState.REVIEWING);
  } finally {
    await cleanup();
  }
});

test("2. invalid state transition rejected (fail closed)", async () => {
  const { repoDir, baseCommit, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-invalid-1",
      taskId: "TEST-TASK-002",
      baseCommit: baseCommit,
      branch: "main",
      allowedScope: ["src/"],
    });

    assert.equal(run.state, CindyState.TASK_INITIALIZED);

    // Cannot jump directly from TASK_INITIALIZED to PUSHING or CLOSED
    await assert.rejects(
      async () => {
        await orchestrator.transition(run.runId, CindyState.PUSHING);
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );

    await assert.rejects(
      async () => {
        await orchestrator.transition(run.runId, CindyState.CLOSED);
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );

    // State remains TASK_INITIALIZED
    const currentRun = await orchestrator.getRun(run.runId);
    assert.equal(currentRun.state, CindyState.TASK_INITIALIZED);
  } finally {
    await cleanup();
  }
});

test("3. same transition replay is idempotent", async () => {
  const { repoDir, baseCommit, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-idemp-1",
      taskId: "TEST-TASK-003",
      baseCommit: baseCommit,
      branch: "main",
      allowedScope: ["src/"],
    });

    await orchestrator.markReadyForBuilder(run.runId);
    const r1 = await orchestrator.startBuilding(run.runId);
    assert.equal(r1.state, CindyState.BUILDING);

    // Replay the transition to BUILDING
    const r2 = await orchestrator.startBuilding(run.runId);
    assert.equal(r2.state, CindyState.BUILDING);
    assert.equal(r2.history.length, r1.history.length);
    assert.equal(r2.version, r1.version);
  } finally {
    await cleanup();
  }
});

test("4. stale current reconcile resolves against Git and task specs", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const result = await reconcileCurrentState({ repoDir, taskId: "CINDY-ORCH-MVP" });
    assert.equal(result.reconciled, true);
    assert.equal(result.currentTaskId, "CINDY-ORCH-MVP");
    assert.notEqual(result.headCommit, "");
  } finally {
    await cleanup();
  }
});

test("5. committed CLOSED beats stale pointer and prevents re-execution", async () => {
  const { repoDir, baseCommit, cleanup } = await createTempRepo();
  try {
    const staleCurrent = {
      task: "P0-05A-T2b",
      status: "BUILDING",
      branch: "main",
    };
    await writeFile(join(repoDir, ".agent", "current.json"), JSON.stringify(staleCurrent, null, 2), "utf8");

    const result = await reconcileCurrentState({ repoDir, taskId: "P0-05A-T2b" });
    assert.equal(result.reconciled, true);
    assert.equal(result.taskAlreadyClosed, true);
    assert.equal(result.resolvedStatus, "CLOSED");

    const orchestrator = new CindyOrchestrator({ repoDir });
    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "run-closed-task",
          taskId: "P0-05A-T2b",
          baseCommit: baseCommit,
          branch: "main",
          allowedScope: ["src/"],
        });
      },
      (err: Error) => err.message.includes("CLOSED")
    );
  } finally {
    await cleanup();
  }
});

test("6. unknown dirty file -> DIRTY_TREE_UNEXPLAINED", async () => {
  const allowedScope = ["schemas/", "tools/", "tests/"];
  const dirtyFiles = ["tools/cindy.ts", "apps/product-api/src/unauthorized.ts"];

  const ownership = checkDirtyTreeOwnership(allowedScope, dirtyFiles);
  assert.equal(ownership.ok, false);
  assert.deepEqual(ownership.unexplainedFiles, ["apps/product-api/src/unauthorized.ts"]);
  assert.equal(ownership.stopReason, CindyState.DIRTY_TREE_UNEXPLAINED);
});

test("7. allowed dirty file -> accepted", async () => {
  const allowedScope = ["schemas/", "tools/", "tests/", "package.json", ".gitignore"];
  const dirtyFiles = ["tools/cindy.ts", "tests/cindy-orchestrator.test.ts", "package.json"];

  const ownership = checkDirtyTreeOwnership(allowedScope, dirtyFiles);
  assert.equal(ownership.ok, true);
  assert.deepEqual(ownership.unexplainedFiles, []);
  assert.equal(ownership.stopReason, null);
});

test("8. tracked change alters digest", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const d1 = await computeTreeDigest(repoDir);
    await writeFile(join(repoDir, "README.md"), "# Modified Test Repo\n", "utf8");
    const d2 = await computeTreeDigest(repoDir);
    assert.notEqual(d1, d2);
  } finally {
    await cleanup();
  }
});

test("9. staged change alters digest", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const d1 = await computeTreeDigest(repoDir);
    await writeFile(join(repoDir, "README.md"), "# Staged Change\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repoDir });
    const d2 = await computeTreeDigest(repoDir);
    assert.notEqual(d1, d2);
  } finally {
    await cleanup();
  }
});

test("10. unstaged change alters digest", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    await writeFile(join(repoDir, "README.md"), "# Staged Change\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repoDir });
    const dStaged = await computeTreeDigest(repoDir);

    await writeFile(join(repoDir, "README.md"), "# Staged AND Unstaged\n", "utf8");
    const dUnstaged = await computeTreeDigest(repoDir);
    assert.notEqual(dStaged, dUnstaged);
  } finally {
    await cleanup();
  }
});

test("11. untracked file alters digest", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const d1 = await computeTreeDigest(repoDir);
    await writeFile(join(repoDir, "new-untracked-file.txt"), "hello untracked\n", "utf8");
    const d2 = await computeTreeDigest(repoDir);
    assert.notEqual(d1, d2);
  } finally {
    await cleanup();
  }
});

test("12. deletion alters digest", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const d1 = await computeTreeDigest(repoDir);
    await rm(join(repoDir, "README.md"));
    const d2 = await computeTreeDigest(repoDir);
    assert.notEqual(d1, d2);
  } finally {
    await cleanup();
  }
});

test("13. rename alters digest", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const d1 = await computeTreeDigest(repoDir);
    execFileSync("git", ["mv", "README.md", "README_RENAMED.md"], { cwd: repoDir });
    const d2 = await computeTreeDigest(repoDir);
    assert.notEqual(d1, d2);
  } finally {
    await cleanup();
  }
});

test("14. same tree produces same digest", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const d1 = await computeTreeDigest(repoDir);
    const d2 = await computeTreeDigest(repoDir);
    assert.equal(d1, d2);

    await writeFile(join(repoDir, "test.txt"), "data", "utf8");
    const dDirty1 = await computeTreeDigest(repoDir);
    const dDirty2 = await computeTreeDigest(repoDir);
    assert.equal(dDirty1, dDirty2);
  } finally {
    await cleanup();
  }
});

test("15. runtime artifact write does not dirty Git tree", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    await seedRun(repoDir, "run-art-test");
    const statusBefore = execFileSync("git", ["status", "--short"], { cwd: repoDir, encoding: "utf8" }).trim();
    assert.equal(statusBefore, "");
    const digestBefore = await computeTreeDigest(repoDir);

    const store = new RuntimeArtifactStore({ repoDir });
    const receiptPayload = {
      runId: "run-art-test",
      taskId: "TEST-01",
      commit: "0000000000000000000000000000000000000000",
      branch: "main",
      finalTreeClean: true,
      recordedAt: new Date().toISOString(),
    };
    await store.recordArtifact("run-art-test", ArtifactKind.GIT_RECEIPT, receiptPayload);

    const statusAfter = execFileSync("git", ["status", "--short"], { cwd: repoDir, encoding: "utf8" }).trim();
    assert.equal(statusAfter, "", "git status must remain clean after writing to .agent/runtime/");

    const digestAfter = await computeTreeDigest(repoDir);
    assert.equal(digestBefore, digestAfter, "Tree digest must be unchanged after runtime artifact write");
  } finally {
    await cleanup();
  }
});

test("16. artifact digest mismatch fails closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-mismatch-test", taskId: "TEST-01" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    await assert.rejects(
      async () => {
            const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
        await orchestrator.recordDiffManifest(run.runId, {
          expectedTreeDigest: "1111111111111111111111111111111111111111111111111111111111111111", // mismatched
            executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
            executionSnapshotDigest: snap.digest
        });
      },
      (err: unknown) => err instanceof ArtifactDigestMismatchError
    );
  } finally {
    await cleanup();
  }
});

test("17. repeated artifact record is idempotent", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    await seedRun(repoDir, "run-idemp-art", "TEST-02");
    const store = new RuntimeArtifactStore({ repoDir });
    const payload = {
      runId: "run-idemp-art",
      taskId: "TEST-02",
      commit: "0000000000000000000000000000000000000000",
      branch: "main",
      finalTreeClean: true,
      recordedAt: new Date().toISOString(),
    };

    const rec1 = await store.recordArtifact("run-idemp-art", ArtifactKind.GIT_RECEIPT, payload);
    assert.equal(rec1.isDuplicate, false);

    const rec2 = await store.recordArtifact("run-idemp-art", ArtifactKind.GIT_RECEIPT, payload);
    assert.equal(rec2.isDuplicate, true);
    assert.equal(rec1.digest, rec2.digest);
  } finally {
    await cleanup();
  }
});

test("18. conflicting repeated artifact is rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    await seedRun(repoDir, "run-conflict-art", "TEST-02");
    const store = new RuntimeArtifactStore({ repoDir });
    const payload1 = {
      runId: "run-conflict-art",
      taskId: "TEST-02",
      commit: "0000000000000000000000000000000000000000",
      branch: "main",
      finalTreeClean: true,
      recordedAt: new Date().toISOString(),
    };
    const payload2 = {
      ...payload1,
      finalTreeClean: false, // conflicting payload
    };

    await store.recordArtifact("run-conflict-art", ArtifactKind.GIT_RECEIPT, payload1);

    await assert.rejects(
      async () => {
        await store.recordArtifact("run-conflict-art", ArtifactKind.GIT_RECEIPT, payload2);
      },
      (err: unknown) => err instanceof ConflictingArtifactError
    );
  } finally {
    await cleanup();
  }
});

test("19. legacy import preserves historical FAIL", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const legacy = await importLegacyTask("P0-05A-T2b", { repoDir });
    assert.equal(legacy.taskId, "P0-05A-T2b");
    assert.equal(legacy.status, "CLOSED");
    assert.equal(legacy.reviewHistory.length, 2);
    assert.equal(legacy.reviewHistory[0]?.verdict, "FAIL");
    assert.equal(legacy.reviewHistory[1]?.verdict, "PASS");

    const content = await readFile(join(repoDir, ".agent", "tasks", "P0-05A-T2b", "task.json"), "utf8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.reviewHistory[0].verdict, "FAIL");
  } finally {
    await cleanup();
  }
});

test("20. no commit or push capability exposed on orchestrator", () => {
  const orchestrator = new CindyOrchestrator();
  const proto = Object.getPrototypeOf(orchestrator);

  const forbiddenMethods = [
    "commit",
    "push",
    "reset",
    "clean",
    "stash",
    "rebase",
    "amend",
    "forcePush",
    "deleteBranch",
  ];

  for (const forbidden of forbiddenMethods) {
    assert.equal(
      forbidden in orchestrator || forbidden in proto,
      false,
      `Orchestrator must not expose forbidden method: ${forbidden}`
    );
  }
});

test("21. reconcile non-existent task fails closed with CONTRACT_CONFLICT", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const invalidCurrent = {
      task: "NON_EXISTENT_TASK_XYZ",
      status: "BUILDING",
      branch: "main",
    };
    await writeFile(join(repoDir, ".agent", "current.json"), JSON.stringify(invalidCurrent, null, 2), "utf8");

    const result = await reconcileCurrentState({ repoDir, taskId: "NON_EXISTENT_TASK_XYZ" });
    assert.equal(result.reconciled, false);
    assert.equal(result.stopReason, CindyState.CONTRACT_CONFLICT);
    assert.ok(result.stopExplanation?.includes("NON_EXISTENT_TASK_XYZ"));
  } finally {
    await cleanup();
  }
});

test("22. reconcile detects HEAD drift and fails closed with GIT_SAFETY_STOP", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const result = await reconcileCurrentState({
      repoDir,
      taskId: "CINDY-ORCH-MVP",
      expectedBaseCommit: "0000000000000000000000000000000000000000",
    });
    assert.equal(result.stopReason, CindyState.GIT_SAFETY_STOP);
    assert.ok(result.stopExplanation?.includes("BASELINE_MISMATCH") || result.stopExplanation?.includes("HEAD drift"));
  } finally {
    await cleanup();
  }
});

test("23. repair cycle transition flow: review PASS remains REVIEWING; gate sealed in MVP (Decision A)", async () => {
  const { repoDir, baseCommit, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-repair-flow",
      taskId: "TEST-TASK-004",
      baseCommit: baseCommit,
      branch: "main",
      allowedScope: ["src/"],
    });

    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    // Record test PASS for cycle 1
    const tree1 = await orchestrator.computeCurrentTreeDigest();
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: tree1,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });

    await orchestrator.prepareForReview(run.runId);
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Reviewer Cindy", session: "sess-1", readOnlyConfirmed: true },
    });

    // Review verdict FAIL triggers transition to REPAIR_INITIALIZED
    const diff1 = await orchestrator.computeCurrentDiffDigest();
    const repairInit = await orchestrator.recordValidatedReviewResult(run.runId, {
      runId: run.runId,
      taskId: "TEST-TASK-004",
      cycle: 1,
      reviewer: { identity: "Reviewer Cindy", session: "sess-1", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: tree1,
      reviewedDiffDigest: diff1,
      verdict: "FAIL",
      findings: [
        {
          id: "FINDING-01",
          severity: "HIGH",
          title: "Logic flaw in edge case",
        },
      ],
      recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    assert.equal(repairInit.state, CindyState.REPAIR_INITIALIZED);

    // Repair builder
    const repairBuild = await orchestrator.startRepairBuilding(run.runId);
    assert.equal(repairBuild.state, CindyState.REPAIR_BUILDING);

    // Re-test
    await orchestrator.completeRepairBuilding(run.runId);

    // Record repair test PASS for cycle 2
    const tree2 = await orchestrator.computeCurrentTreeDigest();
    await orchestrator.recordTestResult(run.runId, {
      cycle: repairInit.currentCycle,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: tree2,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });

    await orchestrator.prepareForReview(run.runId);
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Reviewer Cindy", session: "sess-2", readOnlyConfirmed: true },
    });

    // Review verdict PASS records evidence but does NOT enter FINAL_GATE (Decision A)
    const diff2 = await orchestrator.computeCurrentDiffDigest();
    const reviewPassRun = await orchestrator.recordValidatedReviewResult(run.runId, {
      runId: run.runId,
      taskId: "TEST-TASK-004",
      cycle: repairInit.currentCycle,
      reviewer: { identity: "Reviewer Cindy", session: "sess-2", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: tree2,
      reviewedDiffDigest: diff2,
      verdict: "PASS",
      findings: [],
      recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    // Review PASS keeps state REVIEWING in Control Plane MVP (privileged states sealed)
    assert.equal(reviewPassRun.state, CindyState.REVIEWING);

    // consumeReviewPass verifies the recorded PASS evidence
    const passEvidence = await orchestrator.consumeReviewPass(run.runId, repairInit.currentCycle);
    assert.equal(passEvidence.verdict, "PASS");

    // Decision A: recordValidatedFinalGateResult is SEALED in Control Plane MVP.
    // No public API can advance to or past FINAL_GATE.
    await assert.rejects(
      async () => {
        await orchestrator.recordValidatedFinalGateResult(run.runId, {
          verdict: "PASS",
          boundTreeDigest: tree2,
        });
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        (err as Error).message.includes("FEATURE_NOT_AVAILABLE_IN_CONTROL_PLANE_MVP"),
      "recordValidatedFinalGateResult must be sealed with FEATURE_NOT_AVAILABLE_IN_CONTROL_PLANE_MVP"
    );
  } finally {
    await cleanup();
  }
});

// =========================================================================
// R2-01: Path Safety Tests
// =========================================================================

test("24. Path safety: traversal runId (..) rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "..",
          taskId: "TEST-TRAVERSAL",
        });
      },
      (err: unknown) => err instanceof InvalidRunIdError
    );
  } finally {
    await cleanup();
  }
});

test("25. Path safety: traversal runId (../x) rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "../x",
          taskId: "TEST-TRAVERSAL",
        });
      },
      (err: unknown) => err instanceof InvalidRunIdError
    );
  } finally {
    await cleanup();
  }
});

test("26. Path safety: absolute path runId rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "/etc/passwd",
          taskId: "TEST-TRAVERSAL",
        });
      },
      (err: unknown) => err instanceof InvalidRunIdError
    );
  } finally {
    await cleanup();
  }
});

test("27. Path safety: traversal artifact path (../../current) rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    await assert.rejects(
      async () => {
        await store.recordArtifact("run-path-test", "../../current", { data: 123 });
      },
      (err: unknown) => err instanceof ArtifactValidationError || err instanceof PathTraversalError
    );
  } finally {
    await cleanup();
  }
});

test("28. Path safety: traversal artifact path (../../../package) rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    await assert.rejects(
      async () => {
        await store.recordArtifact("run-path-test", "../../../package", { data: 123 });
      },
      (err: unknown) => err instanceof ArtifactValidationError || err instanceof PathTraversalError
    );
  } finally {
    await cleanup();
  }
});

test("29. Path safety: nested traversal artifact path (nested/../../escape) rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    await assert.rejects(
      async () => {
        await store.recordArtifact("run-path-test", "nested/../../escape", { data: 123 });
      },
      (err: unknown) => err instanceof ArtifactValidationError || err instanceof PathTraversalError
    );
  } finally {
    await cleanup();
  }
});

test("30. Path safety: symlink escape rejected fail closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = store.getRunDir("run-symlink-test");
    await mkdir(runDir, { recursive: true });

    // Create a symlink pointing to repo root package.json
    const symlinkTarget = join(repoDir, "package.json");
    const symlinkPath = join(runDir, "run.json");
    await symlink(symlinkTarget, symlinkPath);

    // Attempting to record artifact into the symlinked target must be rejected
    await assert.rejects(
      async () => {
        await store.recordArtifact("run-symlink-test", ArtifactKind.RUN, {
          runId: "run-symlink-test",
          taskId: "TEST",
          version: 1,
          state: CindyState.TASK_INITIALIZED,
          currentCycle: 1,
          branch: "main",
          baseCommit: "commit-001",
          headCommit: "commit-001",
          allowedScope: ["src/"],
          history: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      },
      (err: unknown) => err instanceof PathTraversalError
    );
  } finally {
    await cleanup();
  }
});

// =========================================================================
// R2-02: Trusted State Progression Tests
// =========================================================================

test("31. State progression: direct transition to evidence-gated states rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-gated-states",
      taskId: "TEST-01",
    });

    const dangerousStates = [
      CindyState.READY_FOR_REVIEW,
      CindyState.REVIEWING,
      CindyState.FINAL_GATE,
      CindyState.READY_TO_COMMIT,
      CindyState.CLOSED,
    ];

    for (const dangerous of dangerousStates) {
      await assert.rejects(
        async () => {
          await orchestrator.transition(run.runId, dangerous);
        },
        (err: unknown) => err instanceof TransitionRejectedError,
        `Direct transition to dangerous state ${dangerous} must be rejected`
      );
    }
  } finally {
    await cleanup();
  }
});

test("32. State progression: REVIEWING cannot freely transition READY_TO_COMMIT", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-no-free-commit",
      taskId: "TEST-02",
    });

    await assert.rejects(
      async () => {
        await orchestrator.transition(run.runId, CindyState.READY_TO_COMMIT);
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );
  } finally {
    await cleanup();
  }
});

test("33. State progression: Review FAIL cannot bypass repair to FINAL_GATE", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-fail-repair",
      taskId: "TEST-03",
    });

    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const tree = await orchestrator.computeCurrentTreeDigest();
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: tree,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });

    await orchestrator.prepareForReview(run.runId);
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Reviewer Cindy", session: "sess-1", readOnlyConfirmed: true },
    });

    const diff = await orchestrator.computeCurrentDiffDigest();
    const updated = await orchestrator.recordValidatedReviewResult(run.runId, {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Reviewer Cindy", session: "sess-1", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: tree,
      reviewedDiffDigest: diff,
      verdict: "FAIL",
      findings: [
        {
          id: "SEC-01",
          severity: "BLOCKER",
          title: "Vulnerability detected",
        },
      ],
      recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });

    // Run must be in REPAIR_INITIALIZED, not FINAL_GATE
    assert.equal(updated.state, CindyState.REPAIR_INITIALIZED);

    // Direct transition to FINAL_GATE without repair must be rejected
    await assert.rejects(
      async () => {
        await orchestrator.transition(run.runId, CindyState.FINAL_GATE);
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );
  } finally {
    await cleanup();
  }
});

test("34. State progression: Final gate required before READY_TO_COMMIT", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-gate-required",
      taskId: "TEST-04",
    });

    // From TASK_INITIALIZED or any non-gate state, READY_TO_COMMIT is rejected
    await assert.rejects(
      async () => {
        await orchestrator.transition(run.runId, CindyState.READY_TO_COMMIT);
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );
  } finally {
    await cleanup();
  }
});

// =========================================================================
// R2-07: Artifact Binding Tests
// =========================================================================

test("35. Artifact binding: wrong runId rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-bind-1", taskId: "TEST-BIND" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const tree = await orchestrator.computeCurrentTreeDigest();
    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.recordArtifact(
          run.runId,
          ArtifactKind.TEST_RESULT,
          {
            runId: "wrong-run-id", // Wrong runId
            taskId: run.taskId,
            cycle: 1,
            command: "pnpm test",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            exitCode: 0,
            boundTreeDigest: tree,
            logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
            status: "PASS",
          },
          { cycle: 1 }
        );
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
  } finally {
    await cleanup();
  }
});

test("36. Artifact binding: wrong taskId rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-bind-2", taskId: "TASK-CORRECT" });

    const tree = await orchestrator.computeCurrentTreeDigest();
    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.recordArtifact(
          run.runId,
          ArtifactKind.TEST_RESULT,
          {
            runId: run.runId,
            taskId: "TASK-WRONG", // Wrong taskId
            cycle: 1,
            command: "pnpm test",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            exitCode: 0,
            boundTreeDigest: tree,
            logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
            status: "PASS",
          },
          { cycle: 1, taskId: "TASK-CORRECT" }
        );
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
  } finally {
    await cleanup();
  }
});

test("37. Artifact binding: wrong base rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-bind-3", taskId: "TASK-BASE" });

    const tree = await orchestrator.computeCurrentTreeDigest();
    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.recordArtifact(
          run.runId,
          ArtifactKind.DIFF_MANIFEST,
          {
            runId: run.runId,
            taskId: run.taskId,
            baseCommit: "wrong-base-commit-sha", // Wrong baseCommit
            changedFiles: [],
            untrackedFiles: [],
            stagedFiles: [],
            unstagedFiles: [],
            deletedFiles: [],
            renamedFiles: [],
            allowedScope: ["src/"],
            isWithinScope: true,
            unexplainedFiles: [],
            diffDigest: "0000000000000000000000000000000000000000000000000000000000000000",
            boundTreeDigest: tree,
            recordedAt: new Date().toISOString(),
          },
          { expectedBaseCommit: run.baseCommit }
        );
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
  } finally {
    await cleanup();
  }
});

test("38. Artifact binding: wrong cycle rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-bind-4", taskId: "TASK-CYCLE" });

    const tree = await orchestrator.computeCurrentTreeDigest();
    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.recordArtifact(
          run.runId,
          ArtifactKind.TEST_RESULT,
          {
            runId: run.runId,
            taskId: run.taskId,
            cycle: 5, // Payload claims cycle 5
            command: "pnpm test",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            exitCode: 0,
            boundTreeDigest: tree,
            logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
            status: "PASS",
          },
          { cycle: 1 } // Context expects cycle 1
        );
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
  } finally {
    await cleanup();
  }
});

test("39. Artifact binding: missing treeDigest rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-bind-5", taskId: "TASK-TREE" });

    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.recordArtifact(
          run.runId,
          ArtifactKind.TEST_RESULT,
          {
            runId: run.runId,
            taskId: run.taskId,
            cycle: 1,
            command: "pnpm test",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            exitCode: 0,
            // boundTreeDigest is missing!
            logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
            status: "PASS",
          } as unknown as Record<string, unknown>,
          { cycle: 1 }
        );
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
  } finally {
    await cleanup();
  }
});

test("40. Artifact binding: mismatched treeDigest rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-bind-6", taskId: "TASK-TREE-MISMATCH" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const currentTree = await orchestrator.computeCurrentTreeDigest();

    await assert.rejects(
      async () => {
            const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
        await orchestrator.recordTestResult(
          run.runId,
          {
            command: "pnpm test",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            exitCode: 0,
            boundTreeDigest: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", // Mismatched
            logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
            status: "PASS",
              executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
              executionSnapshotDigest: snap.digest
        },
          { cycle: 1, expectedTreeDigest: currentTree }
        );
      },
      (err: unknown) => err instanceof ArtifactDigestMismatchError
    );
  } finally {
    await cleanup();
  }
});

test("41. Artifact binding: PASS then modify tracked file invalidates evidence", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-stale-tracked",
      taskId: "TASK-STALE-1",
    });

    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const treeBefore = await orchestrator.computeCurrentTreeDigest();
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: treeBefore,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });

    await orchestrator.prepareForReview(run.runId);
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Reviewer Cindy", session: "sess-1", readOnlyConfirmed: true },
    });

    const diffBefore = await orchestrator.computeCurrentDiffDigest();
    await orchestrator.recordValidatedReviewResult(run.runId, {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Reviewer Cindy", session: "sess-1", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: treeBefore,
      reviewedDiffDigest: diffBefore,
      verdict: "PASS",
      findings: [],
      recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });

    // Modify tracked file AFTER review PASS
    await writeFile(join(repoDir, "README.md"), "# Mutated README\n", "utf8");

    // Attempting to consume review pass must fail closed: evidence is now invalidated
    await assert.rejects(
      async () => {
        await orchestrator.consumeReviewPass(run.runId);
      },
      (err: unknown) => err instanceof ArtifactDigestMismatchError
    );
  } finally {
    await cleanup();
  }
});

test("42. Artifact binding: PASS then add untracked file invalidates evidence", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-stale-untracked",
      taskId: "TASK-STALE-2",
    });

    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const treeBefore = await orchestrator.computeCurrentTreeDigest();
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: treeBefore,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });

    await orchestrator.prepareForReview(run.runId);
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Reviewer Cindy", session: "sess-1", readOnlyConfirmed: true },
    });

    const diffBefore = await orchestrator.computeCurrentDiffDigest();
    await orchestrator.recordValidatedReviewResult(run.runId, {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Reviewer Cindy", session: "sess-1", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: treeBefore,
      reviewedDiffDigest: diffBefore,
      verdict: "PASS",
      findings: [],
      recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });

    // Add untracked file AFTER review PASS
    await writeFile(join(repoDir, "rogue-file.js"), "console.log('injected');\n", "utf8");

    // Attempting to consume review pass must fail closed: evidence is stale
    await assert.rejects(
      async () => {
        await orchestrator.consumeReviewPass(run.runId);
      },
      (err: unknown) => err instanceof ArtifactDigestMismatchError
    );
  } finally {
    await cleanup();
  }
});

// =========================================================================
// R2-08: Atomicity & Concurrency Tests
// =========================================================================

test("43. Concurrency: two concurrent same-run transitions only one succeeds and other gets CONCURRENT_RUN_UPDATE", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-concurrent-1",
      taskId: "TASK-CONC-1",
    });

    assert.equal(run.version, 1);

    // Prepare two concurrent transitions starting from identical version 1 state
    const run1 = await orchestrator.getRun(run.runId);
    const run2 = await orchestrator.getRun(run.runId);

    // Call applyAdministrativeTransition concurrently with expectedVersion: 1
    const p1 = orchestrator.markReadyForBuilder(
      run.runId,
      { expectedVersion: 1 }
    );
    const p2 = orchestrator.markReadyForBuilder(
      run.runId,
      { expectedVersion: 1 }
    );

    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1, "Exactly one concurrent transition must succeed");
    assert.equal(rejected.length, 1, "The competing transition must be rejected");

    const reason = (rejected[0] as PromiseRejectedResult).reason;
    assert.ok(
      reason instanceof ConcurrentRunUpdateError,
      `Compete error must be ConcurrentRunUpdateError, got: ${String(reason)}`
    );
    assert.ok(
      (reason as Error).message.includes("CONCURRENT_RUN_UPDATE"),
      "Error message must contain CONCURRENT_RUN_UPDATE"
    );
  } finally {
    await cleanup();
  }
});

test("44. Concurrency: stale revision rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-stale-rev",
      taskId: "TASK-STALE-REV",
    });

    await assert.rejects(
      async () => {
        // Attempt update with stale version 99
        await orchestrator.markReadyForBuilder(
          run.runId,
          { expectedVersion: 99 }
        );
      },
      (err: unknown) =>
        err instanceof ConcurrentRunUpdateError && (err as Error).message.includes("CONCURRENT_RUN_UPDATE")
    );
  } finally {
    await cleanup();
  }
});

test("45. Concurrency: concurrent duplicate artifact write succeeds idempotently", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    await seedRun(repoDir, "run-dup-art", "TASK-DUP");
    const store = new RuntimeArtifactStore({ repoDir });
    const payload = {
      runId: "run-dup-art",
      taskId: "TASK-DUP",
      commit: "0000000000000000000000000000000000000000",
      branch: "main",
      finalTreeClean: true,
      recordedAt: new Date().toISOString(),
    };

    const [r1, r2] = await Promise.all([
      store.recordArtifact("run-dup-art", ArtifactKind.GIT_RECEIPT, payload),
      store.recordArtifact("run-dup-art", ArtifactKind.GIT_RECEIPT, payload),
    ]);

    assert.equal(r1.digest, r2.digest);
    assert.ok(r1.isDuplicate || r2.isDuplicate, "One of the concurrent duplicate calls must be marked duplicate");
  } finally {
    await cleanup();
  }
});

test("46. Concurrency: conflicting duplicate artifact write fails closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    await seedRun(repoDir, "run-conf-art", "TASK-CONF");
    const store = new RuntimeArtifactStore({ repoDir });
    const payload1 = {
      runId: "run-conf-art",
      taskId: "TASK-CONF",
      commit: "0000000000000000000000000000000000000000",
      branch: "main",
      finalTreeClean: true,
      recordedAt: new Date().toISOString(),
    };
    const payload2 = {
      ...payload1,
      finalTreeClean: false,
    };

    const results = await Promise.allSettled([
      store.recordArtifact("run-conf-art", ArtifactKind.GIT_RECEIPT, payload1),
      store.recordArtifact("run-conf-art", ArtifactKind.GIT_RECEIPT, payload2),
    ]);

    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(rejected.length, 1, "Conflicting duplicate must be rejected");
    assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof ConflictingArtifactError);
  } finally {
    await cleanup();
  }
});

test("47. Concurrency: simulated partial artifact fails closed on recovery", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = store.getRunDir("run-partial-test");
    await mkdir(runDir, { recursive: true });

    // Write empty / partial file
    await writeFile(join(runDir, "run.json"), "", "utf8");

    await assert.rejects(
      async () => {
        await store.readArtifact("run-partial-test", ArtifactKind.RUN);
      },
      (err: unknown) => err instanceof ArtifactCorruptionError
    );

    // Write truncated JSON
    await writeFile(join(runDir, "run.json"), '{"runId": "run-partial', "utf8");

    await assert.rejects(
      async () => {
        await store.readArtifact("run-partial-test", ArtifactKind.RUN);
      },
      (err: unknown) => err instanceof ArtifactCorruptionError
    );
  } finally {
    await cleanup();
  }
});

test("48. Concurrency: interrupted temp file ignored by artifact store", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = store.getRunDir("run-interrupted-temp");
    await mkdir(runDir, { recursive: true });

    // Simulate interrupted temp file
    await writeFile(join(runDir, ".tmp_run_12345.json"), '{"runId": "ignored"}', "utf8");
    await writeFile(join(runDir, ".tmp_art_99999.json"), '{"data": "ignored"}', "utf8");

    const artifacts = await store.listArtifacts("run-interrupted-temp");
    assert.deepEqual(artifacts, [], "Temp files must not appear in listed artifacts");
  } finally {
    await cleanup();
  }
});

// =========================================================================
// R2-10: Real Runtime Schema Enforcement Tests
// =========================================================================

test("49. Schema: malformed run payload rejected at write boundary and createInitialRun removed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    // Raw createInitialRun must not exist per AD-U
    assert.strictEqual((store as unknown as Record<string, unknown>).createInitialRun, undefined);
    // initializeRunSafely rejects malformed taskId
    await assert.rejects(
      async () => {
        await store.initializeRunSafely({
          runId: "run-malformed",
          taskId: "../malformed-task",
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError || err instanceof TransitionRejectedError
    );
  } finally {
    await cleanup();
  }
});

test("50. Schema: malformed review result rejected at write boundary", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    await assert.rejects(
      async () => {
        await store.recordArtifact(
          "run-malformed-rev",
          ArtifactKind.REVIEW_RESULT,
          {
            runId: "run-malformed-rev",
            taskId: "TASK",
            cycle: 1,
            reviewer: { identity: "Alice", readOnlyConfirmed: true },
            reviewedBaseCommit: "base",
            reviewedTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
            reviewedDiffDigest: "0000000000000000000000000000000000000000000000000000000000000000",
            verdict: "INVALID_VERDICT", // Enum violation
            findings: [],
            recordedAt: new Date().toISOString(),
          } as unknown as Record<string, unknown>,
          { cycle: 1 }
        );
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
  } finally {
    await cleanup();
  }
});

test("51. Schema: semantically mismatched artifact rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    await assert.rejects(
      async () => {
        await store.recordArtifact(
          "run-sem-mismatch",
          ArtifactKind.TEST_RESULT,
          {
            runId: "run-sem-mismatch",
            taskId: "TASK",
            cycle: 2, // Cycle mismatch with options.cycle: 1
            command: "pnpm test",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            exitCode: 0,
            boundTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
            logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
            status: "PASS",
          },
          { cycle: 1 }
        );
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
  } finally {
    await cleanup();
  }
});

test("52. Schema: malformed artifact on disk fails closed at read boundary", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = store.getRunDir("run-read-schema-test");
    await mkdir(runDir, { recursive: true });

    // Manually write an artifact that violates the schema
    const malformedCloseout = {
      runId: "run-read-schema-test",
      taskId: "TASK",
      status: "OPEN", // const requires "CLOSED"
      finalTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      finalGate: "FAIL", // const requires "PASS"
      closedAt: new Date().toISOString(),
    };
    await writeFile(join(runDir, "closeout.json"), JSON.stringify(malformedCloseout), "utf8");

    // Attempting to read it must fail closed
    await assert.rejects(
      async () => {
        await store.readArtifact("run-read-schema-test", ArtifactKind.CLOSEOUT);
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
  } finally {
    await cleanup();
  }
});

// =========================================================================
// R2F1-H01: Runtime Root / Ancestor Symlink Tests
// =========================================================================

test("53. Path safety: .agent directory as symlink is rejected fail closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  const outsideDir = await mkdtemp(join(tmpdir(), "outside-agent-"));
  try {
    const agentDir = join(repoDir, ".agent");
    await rm(agentDir, { recursive: true, force: true });
    await symlink(outsideDir, agentDir);

    const store = new RuntimeArtifactStore({ repoDir });
    await assert.rejects(
      async () => {
        await store.recordArtifact("run-agent-symlink", ArtifactKind.TEST_RESULT, {
          runId: "run-agent-symlink",
          taskId: "TASK",
          cycle: 1,
          command: "pnpm test",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          exitCode: 0,
          boundTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
          logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
          status: "PASS",
        }, { cycle: 1 });
      },
      (err: unknown) => err instanceof PathTraversalError
    );
  } finally {
    await rm(outsideDir, { recursive: true, force: true }).catch(() => {});
    await cleanup();
  }
});

test("54. Path safety: .agent/runtime directory as symlink is rejected fail closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  const outsideDir = await mkdtemp(join(tmpdir(), "outside-runtime-"));
  try {
    const runtimeDir = join(repoDir, ".agent", "runtime");
    await mkdir(join(repoDir, ".agent"), { recursive: true });
    await symlink(outsideDir, runtimeDir);

    const store = new RuntimeArtifactStore({ repoDir });
    await assert.rejects(
      async () => {
        await store.recordArtifact("run-rt-symlink", ArtifactKind.TEST_RESULT, {
          runId: "run-rt-symlink",
          taskId: "TASK",
          cycle: 1,
          command: "pnpm test",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          exitCode: 0,
          boundTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
          logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
          status: "PASS",
        }, { cycle: 1 });
      },
      (err: unknown) => err instanceof PathTraversalError
    );
  } finally {
    await rm(outsideDir, { recursive: true, force: true }).catch(() => {});
    await cleanup();
  }
});

test("55. Path safety: run directory as symlink is rejected fail closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  const outsideDir = await mkdtemp(join(tmpdir(), "outside-run-"));
  try {
    const runDir = join(repoDir, ".agent", "runtime", "run-symlink-dir");
    await mkdir(join(repoDir, ".agent", "runtime"), { recursive: true });
    await symlink(outsideDir, runDir);

    const store = new RuntimeArtifactStore({ repoDir });
    await assert.rejects(
      async () => {
        await store.recordArtifact("run-symlink-dir", ArtifactKind.TEST_RESULT, {
          runId: "run-symlink-dir",
          taskId: "TASK",
          cycle: 1,
          command: "pnpm test",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          exitCode: 0,
          boundTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
          logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
          status: "PASS",
        }, { cycle: 1 });
      },
      (err: unknown) => err instanceof PathTraversalError
    );
  } finally {
    await rm(outsideDir, { recursive: true, force: true }).catch(() => {});
    await cleanup();
  }
});

test("56. Path safety: artifact parent directory as symlink is rejected fail closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  const outsideDir = await mkdtemp(join(tmpdir(), "outside-parent-"));
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = store.getRunDir("run-parent-sym");
    await mkdir(runDir, { recursive: true });
    const subDirSymlink = join(runDir, "nested");
    await symlink(outsideDir, subDirSymlink);

    assert.throws(
      () => {
        assertNoSymlinkAncestors(repoDir, join(subDirSymlink, "artifact.json"));
      },
      (err: unknown) => err instanceof PathTraversalError
    );
  } finally {
    await rm(outsideDir, { recursive: true, force: true }).catch(() => {});
    await cleanup();
  }
});

test("57. Path safety: dangling symlink target is rejected fail closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    await seedRun(repoDir, "run-dangling-sym", "TASK");
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = store.getRunDir("run-dangling-sym");
    await mkdir(runDir, { recursive: true });

    const danglingTarget = join(runDir, "non-existent-target.json");
    const targetFile = join(runDir, "test-result-cycle-1.json");
    await symlink(danglingTarget, targetFile);

    await assert.rejects(
      async () => {
        await store.recordArtifact("run-dangling-sym", ArtifactKind.TEST_RESULT, {
          runId: "run-dangling-sym",
          taskId: "TASK",
          cycle: 1,
          command: "pnpm test",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          exitCode: 0,
          boundTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
          logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
          status: "PASS",
        }, { cycle: 1 });
      },
      (err: unknown) => err instanceof PathTraversalError
    );
  } finally {
    await cleanup();
  }
});

// =========================================================================
// R2F1-H02: Closed Raw State Persistence Entrance Tests
// =========================================================================

test("58. Raw state persistence: direct arbitrary transition to CLOSED without authorization is rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-raw-closed", taskId: "TASK-RAW" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const testingRun = await orchestrator.getRun(run.runId);
    assert.equal(testingRun.state, CindyState.TESTING);

    // Direct transition to CLOSED via public orchestrator transition is rejected
    await assert.rejects(
      async () => {
        await orchestrator.transition(run.runId, CindyState.CLOSED);
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );

    // saveRunState does not exist on store (raw arbitrary saveRunState removed completely)
    assert.equal("saveRunState" in orchestrator.artifactStore, false, "saveRunState must not exist on store");

    // store.applyAdministrativeTransition directly to CLOSED is rejected
    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.applyAdministrativeTransition(
          run.runId,
          CindyState.CLOSED
        );
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );

    // State on disk remains unchanged (TESTING)
    const currentRun = await orchestrator.getRun(run.runId);
    assert.equal(currentRun.state, CindyState.TESTING);
  } finally {
    await cleanup();
  }
});

test("59. Raw state persistence: CLOSED cannot be injected via recordArtifact", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-inject-closed", taskId: "TASK-INJECT" });

    // Attempting to record ArtifactKind.RUN via recordArtifact is rejected
    await assert.rejects(
      async () => {
        await orchestrator.recordArtifact(run.runId, ArtifactKind.RUN, {
          runId: run.runId,
          taskId: run.taskId,
          version: 2,
          state: CindyState.CLOSED,
          currentCycle: 1,
          branch: "main",
          baseCommit: run.baseCommit,
          headCommit: run.headCommit,
          allowedScope: [],
          history: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );

    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.recordArtifact(run.runId, ArtifactKind.RUN, {
          runId: run.runId,
          taskId: run.taskId,
          version: 2,
          state: CindyState.CLOSED,
          currentCycle: 1,
          branch: "main",
          baseCommit: run.baseCommit,
          headCommit: run.headCommit,
          allowedScope: [],
          history: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
  } finally {
    await cleanup();
  }
});

// =========================================================================
// R2F1-H03: Evidence Validation Tests
// =========================================================================

test("60. Evidence validation: test result with status=PASS but exitCode!=0 is rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-exitcode-mismatch", taskId: "TASK-EC" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const tree = await orchestrator.computeCurrentTreeDigest();
    // 1. Direct recordArtifact of status=PASS with exitCode!=0 is rejected at boundary
    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.recordTestResult(
          run.runId,
          {
            runId: run.runId,
            taskId: run.taskId,
            cycle: 1,
            command: "pnpm test",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            exitCode: 1, // Non-zero exit code!
            boundTreeDigest: tree,
            logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
            status: "PASS", // Claimed PASS
          },
          { cycle: 1, taskId: run.taskId }
        );
      },
      (err: unknown) => err instanceof ArtifactValidationError && (err as Error).message.includes("exitCode")
    );

    // 2. Fabricated on disk: prepareForReview must reject due to artifact inconsistency at consumption boundary
    const runDir = orchestrator.artifactStore.getRunDir(run.runId);
    const liveSnap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await writeFile(
      join(runDir, "test-result-cycle-1.json"),
      JSON.stringify({
        runId: run.runId,
        taskId: run.taskId,
        cycle: 1,
        command: "pnpm test",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        exitCode: 1,
        boundTreeDigest: tree,
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: liveSnap.digest,
        logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        status: "PASS",
      }),
      "utf8"
    );

    await assert.rejects(
      async () => {
        await orchestrator.prepareForReview(run.runId);
      },
      (err: unknown) => err instanceof ArtifactValidationError && (err as Error).message.includes("exitCode")
    );
  } finally {
    await cleanup();
  }
});

test("61. Evidence validation: review result with mismatched reviewer is rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-mismatch-reviewer", taskId: "TASK-REV" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const tree = await orchestrator.computeCurrentTreeDigest();
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: tree,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });

    await orchestrator.prepareForReview(run.runId);
    // Start review with reviewer Alice
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Alice", session: "sess-alice", readOnlyConfirmed: true },
    });

    const diff = await orchestrator.computeCurrentDiffDigest();
    // Try to record result with reviewer Bob
    await assert.rejects(
      async () => {
            const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
        await orchestrator.recordValidatedReviewResult(run.runId, {
          runId: run.runId,
          taskId: run.taskId,
          cycle: 1,
          reviewer: { identity: "Bob", session: "sess-bob", readOnlyConfirmed: true }, // Mismatched!
          reviewedBaseCommit: run.baseCommit,
          reviewedTreeDigest: tree,
          reviewedDiffDigest: diff,
          verdict: "PASS",
          findings: [],
          recordedAt: new Date().toISOString(),
            executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
            executionSnapshotDigest: snap.digest
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError && (err as Error).message.includes("reviewer")
    );
  } finally {
    await cleanup();
  }
});

test("62. Evidence validation: review result with readOnlyConfirmed=false is rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-readonly-false", taskId: "TASK-RO" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const tree = await orchestrator.computeCurrentTreeDigest();
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: tree,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });

    await orchestrator.prepareForReview(run.runId);

    // startReview with readOnlyConfirmed=false must be rejected
    await assert.rejects(
      async () => {
        await orchestrator.startReview(run.runId, {
          reviewer: { identity: "Alice", session: "sess-1", readOnlyConfirmed: false },
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
  } finally {
    await cleanup();
  }
});

test("63. Final gate: fake final gate PASS without validated gate evidence is rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-fake-gate", taskId: "TASK-FG" });

    // Directly calling recordValidatedFinalGateResult from TASK_INITIALIZED is rejected
    await assert.rejects(
      async () => {
        await orchestrator.recordValidatedFinalGateResult(run.runId, {
          verdict: "PASS",
          boundTreeDigest: await orchestrator.computeCurrentTreeDigest(),
        });
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );
  } finally {
    await cleanup();
  }
});

// =========================================================================
// R2F1-H04: Schema Dialect Fail Closed & Meta-validation Tests
// =========================================================================

test("64. Schema dialect: unknown top-level keyword in schema rejected", () => {
  const badSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    unknownKeyword: "foo",
  };
  assert.throws(
    () => {
      assertValidSchemaDialect(badSchema);
    },
    (err: unknown) => err instanceof ArtifactValidationError && (err as Error).message.includes("unknown keyword 'unknownKeyword'")
  );
});

test("65. Schema dialect: nested unknown keyword in schema rejected", () => {
  const badNestedSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      field: {
        type: "string",
        unsupportedKeyword: 123,
      },
    },
  };
  assert.throws(
    () => {
      assertValidSchemaDialect(badNestedSchema);
    },
    (err: unknown) => err instanceof ArtifactValidationError && (err as Error).message.includes("unknown keyword 'unsupportedKeyword'")
  );
});

test("66. Schema dialect: minLength constraint is enforced", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string", minLength: 5 },
    },
  };
  assertValidSchemaDialect(schema);

  const errorsFail = validateDraft2020({ name: "abc" }, schema);
  assert.ok(errorsFail.length > 0, "String length < minLength must yield errors");
  assert.ok(errorsFail[0]!.includes("minLength"), "Error message must mention minLength");

  const errorsPass = validateDraft2020({ name: "abcdef" }, schema);
  assert.equal(errorsPass.length, 0, "String length >= minLength must pass");
});

test("67. Schema dialect: invalid keyword parameter type rejected", () => {
  const badTypeSchema = {
    type: 123, // Invalid: must be string or array
  };
  assert.throws(
    () => {
      assertValidSchemaDialect(badTypeSchema);
    },
    (err: unknown) => err instanceof ArtifactValidationError
  );

  const badMinLengthSchema = {
    type: "string",
    minLength: "not-a-number",
  };
  assert.throws(
    () => {
      assertValidSchemaDialect(badMinLengthSchema);
    },
    (err: unknown) => err instanceof ArtifactValidationError
  );
});

// =========================================================================
// R2F1-M01: Consumption-time Evidence Validation Tests
// =========================================================================

test("68. Consumption validation: review PASS invalidated by tracked file mutation", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-m01-tracked", taskId: "TASK-M01A" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const tree = await orchestrator.computeCurrentTreeDigest();
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: tree,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });

    await orchestrator.prepareForReview(run.runId);
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Alice", session: "sess-1", readOnlyConfirmed: true },
    });

    const diff = await orchestrator.computeCurrentDiffDigest();
    await orchestrator.recordValidatedReviewResult(run.runId, {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Alice", session: "sess-1", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: tree,
      reviewedDiffDigest: diff,
      verdict: "PASS",
      findings: [],
      recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });

    // Validated consumption passes before mutation
    const passEvidence = await orchestrator.consumeReviewPass(run.runId);
    assert.equal(passEvidence.verdict, "PASS");

    // Mutate a tracked file
    await writeFile(join(repoDir, "README.md"), "# Mutated README\n", "utf8");

    // Now consumeReviewPass must reject
    await assert.rejects(
      async () => {
        await orchestrator.consumeReviewPass(run.runId);
      },
      (err: unknown) => err instanceof ArtifactDigestMismatchError
    );
  } finally {
    await cleanup();
  }
});

test("69. Consumption validation: review PASS invalidated by untracked file addition", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-m01-untracked", taskId: "TASK-M01B" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const tree = await orchestrator.computeCurrentTreeDigest();
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: tree,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });

    await orchestrator.prepareForReview(run.runId);
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Alice", session: "sess-1", readOnlyConfirmed: true },
    });

    const diff = await orchestrator.computeCurrentDiffDigest();
    await orchestrator.recordValidatedReviewResult(run.runId, {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Alice", session: "sess-1", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: tree,
      reviewedDiffDigest: diff,
      verdict: "PASS",
      findings: [],
      recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });

    // Add untracked file
    await writeFile(join(repoDir, "new_untracked_file.txt"), "hello", "utf8");

    // consumeReviewPass must reject
    await assert.rejects(
      async () => {
        await orchestrator.consumeReviewPass(run.runId);
      },
      (err: unknown) => err instanceof ArtifactDigestMismatchError
    );
  } finally {
    await cleanup();
  }
});

test("70. Consumption validation: wrong cycle in evidence consumption rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-m01-cycle", taskId: "TASK-M01C" });

    await assert.rejects(
      async () => {
        await orchestrator.consumeReviewPass(run.runId, 99); // cycle 99 does not exist
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
  } finally {
    await cleanup();
  }
});

test("71. Consumption validation: wrong base commit in evidence consumption rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-m01-base", taskId: "TASK-M01D" });
    const tree = await orchestrator.computeCurrentTreeDigest();

    // Fabricate review-result on disk with mismatched reviewedBaseCommit
    const runDir = orchestrator.artifactStore.getRunDir(run.runId);
    await mkdir(runDir, { recursive: true });
    const liveSnap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const liveDiff = await orchestrator.computeCurrentDiffDigest();
    await writeFile(
      join(runDir, "review-request-cycle-1.json"),
      JSON.stringify({
        runId: run.runId,
        taskId: run.taskId,
        baseCommit: run.baseCommit,
        cycle: 1,
        reviewer: { identity: "Alice", session: "s1", readOnlyConfirmed: true, readOnlyRequired: true },
        boundTreeDigest: tree,
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: liveSnap.digest,
        requestedAt: new Date().toISOString(),
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      }, null, 2),
      "utf8"
    );
    const fabricatedReview = {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Alice", session: "s1", readOnlyConfirmed: true },
      reviewedBaseCommit: "0000000000000000000000000000000000000000", // Mismatched base
      reviewedTreeDigest: tree,
      reviewedDiffDigest: liveDiff,
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: liveSnap.digest,
      verdict: "PASS",
      findings: [],
      recordedAt: new Date().toISOString(),
      trustClassification: "STRUCTURE_VALID_EXTERNAL",
    };
    await writeFile(join(runDir, "review-result-cycle-1.json"), JSON.stringify(fabricatedReview), "utf8");

    await assert.rejects(
      async () => {
        await orchestrator.consumeReviewPass(run.runId, 1);
      },
      (err: unknown) => err instanceof ArtifactValidationError && (err as Error).message.includes("base")
    );
  } finally {
    await cleanup();
  }
});

// =========================================================================
// R2F1-M02: Stale Lock Recovery Tests
// =========================================================================

test("72. Lock safety: active live owner lock prevents acquisition and rejects", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    await seedRun(repoDir, "run-lock-live", "TASK");
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = store.getRunDir("run-lock-live");
    await mkdir(runDir, { recursive: true });

    // Manually create lock belonging to current (live) process
    const lockPath = join(runDir, ".run.lock");
    const liveLock = {
      pid: process.pid,
      hostname: (await import("node:os")).hostname(),
      createdAt: new Date().toISOString(),
      ownerId: "live-owner-uuid",
    };
    await writeFile(lockPath, JSON.stringify(liveLock), "utf8");

    await assert.rejects(
      async () => {
        await store.recordArtifact("run-lock-live", ArtifactKind.GIT_RECEIPT, {
          runId: "run-lock-live",
          taskId: "TASK",
          commit: "0000000000000000000000000000000000000000",
          branch: "main",
          finalTreeClean: true,
          recordedAt: new Date().toISOString(),
        });
      },
      (err: unknown) => err instanceof ConcurrentRunUpdateError
    );
  } finally {
    await cleanup();
  }
});

test("73. Lock safety: dead owner PID lock recognized as stale and fails closed without deletion", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = await createMockRegisteredRun(repoDir, "run-lock-dead");

    // Pick a definitely dead PID
    const deadPid = 9999999;
    let isDead = false;
    try {
      process.kill(deadPid, 0);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") {
        isDead = true;
      }
    }
    assert.ok(isDead, "Test requires PID 9999999 to be non-existent");

    const lockPath = join(runDir, ".run.lock");
    const deadLock = {
      pid: deadPid,
      hostname: (await import("node:os")).hostname(),
      createdAt: new Date().toISOString(),
      ownerId: "dead-owner-uuid",
    };
    await writeFile(lockPath, JSON.stringify(deadLock), "utf8");

    // Under Decision D: dead PID lock is not automatically deleted or reclaimed.
    // It must fail closed with STALE_RUN_LOCK_REQUIRES_RECONCILIATION.
    await assert.rejects(
      async () => {
        await store.acquireRunLock(runDir);
      },
      (err: unknown) =>
        err instanceof ConcurrentRunUpdateError &&
        (err as Error).message.includes("STALE_RUN_LOCK_REQUIRES_RECONCILIATION")
    );

    // Lock file must remain untouched on disk
    assert.equal(existsSync(lockPath), true, "Dead lock must NOT be deleted");
    const currentLock = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(currentLock.ownerId, "dead-owner-uuid");
  } finally {
    await cleanup();
  }
});

test("74. Lock safety: wrong owner cannot release lock", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = await createMockRegisteredRun(repoDir, "run-lock-release");

    const lock = await store.acquireRunLock(runDir);
    assert.ok(lock.ownerId);

    // Attempt release with wrong ownerId
    await assert.rejects(
      async () => {
        await store.releaseRunLock(runDir, "wrong-owner-id");
      },
      (err: unknown) => err instanceof ConcurrentRunUpdateError
    );

    // Legitimate owner can release
    await store.releaseRunLock(runDir, lock.ownerId);
  } finally {
    await cleanup();
  }
});

test("75. Lock safety: malformed lock fails closed and is not deleted", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    await seedRun(repoDir, "run-lock-malformed", "TASK");
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = store.getRunDir("run-lock-malformed");
    await mkdir(runDir, { recursive: true });

    const lockPath = join(runDir, ".run.lock");
    await writeFile(lockPath, "not valid json {", "utf8");

    await assert.rejects(
      async () => {
        await store.recordArtifact("run-lock-malformed", ArtifactKind.GIT_RECEIPT, {
          runId: "run-lock-malformed",
          taskId: "TASK",
          commit: "0000000000000000000000000000000000000000",
          branch: "main",
          finalTreeClean: true,
          recordedAt: new Date().toISOString(),
        });
      },
      (err: unknown) => err instanceof ConcurrentRunUpdateError
    );

    // Malformed lock file must NOT have been deleted
    const content = await readFile(lockPath, "utf8");
    assert.equal(content, "not valid json {");
  } finally {
    await cleanup();
  }
});

test("76. Lock safety: stale temp files do not block lock acquisition or valid recovery", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    await seedRun(repoDir, "run-stale-tmp", "TASK");
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = store.getRunDir("run-stale-tmp");
    await mkdir(runDir, { recursive: true });

    // Leave a stale interrupted temp file
    const staleTmpPath = join(runDir, ".tmp_art_stale_123.json");
    await writeFile(staleTmpPath, '{"partial": true}', "utf8");

    const res = await store.recordArtifact("run-stale-tmp", ArtifactKind.GIT_RECEIPT, {
      runId: "run-stale-tmp",
      taskId: "TASK",
      commit: "0000000000000000000000000000000000000000",
      branch: "main",
      finalTreeClean: true,
      recordedAt: new Date().toISOString(),
    });

    assert.ok(res.digest);
  } finally {
    await cleanup();
  }
});

// =========================================================================
// R2F1-M03: Artifact Schema and Cycle Completeness Tests
// =========================================================================

test("77. Artifact cycle contract: cyclic artifact without cycle rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    await seedRun(repoDir, "run-no-cycle", "TASK");
    const store = new RuntimeArtifactStore({ repoDir });
    await assert.rejects(
      async () => {
        // test-result requires cycle
        await store.recordArtifact("run-no-cycle", ArtifactKind.TEST_RESULT, {
          runId: "run-no-cycle",
          taskId: "TASK",
          command: "pnpm test",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          exitCode: 0,
          boundTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
          logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
          status: "PASS",
        } as unknown as Record<string, unknown>);
      },
      (err: unknown) => err instanceof ArtifactValidationError && (err as Error).message.includes("requires a positive safe integer cycle")
    );
  } finally {
    await cleanup();
  }
});

test("78. Artifact cycle contract: non-safe-integer, negative, fraction, zero or Infinity cycle rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    await seedRun(repoDir, "run-bad-cycles", "TASK");
    const store = new RuntimeArtifactStore({ repoDir });
    const payload = {
      runId: "run-bad-cycles",
      taskId: "TASK",
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
    } as unknown as Record<string, unknown>;

    const badCycles = [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 10];
    for (const badCycle of badCycles) {
      await assert.rejects(
        async () => {
          await store.recordArtifact("run-bad-cycles", ArtifactKind.TEST_RESULT, payload, { cycle: badCycle });
        },
        (err: unknown) => err instanceof ArtifactValidationError,
        `Cycle ${String(badCycle)} must be rejected`
      );
    }
  } finally {
    await cleanup();
  }
});

test("79. Artifact cycle contract: non-cyclic artifact with cycle rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    await seedRun(repoDir, "run-non-cycle", "TASK");
    const store = new RuntimeArtifactStore({ repoDir });
    const nonCyclicKinds = [
      ArtifactKind.BASELINE,
      ArtifactKind.CLOSEOUT,
      ArtifactKind.GIT_RECEIPT,
      ArtifactKind.NEXT_TASK,
    ];

    for (const kind of nonCyclicKinds) {
      await assert.rejects(
        async () => {
          await store.recordArtifact("run-non-cycle", kind, { data: 1 }, { cycle: 1 });
        },
        (err: unknown) => err instanceof ArtifactValidationError && (err as Error).message.includes("does not accept a cycle"),
        `Providing cycle to non-cyclic kind '${kind}' must be rejected`
      );
    }
  } finally {
    await cleanup();
  }
});

test("80. Artifact schema completeness: all registered artifact kinds have schemas and unmapped kind rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });

    // Unknown artifact kind rejected at schema boundary
    await assert.rejects(
      async () => {
        await store.recordArtifact("run-schema-complete", "unregistered-kind", { foo: "bar" });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
  } finally {
    await cleanup();
  }
});

// =========================================================================
// R2F1-R2: Additional Finding Closure & Architecture Decision Tests
// =========================================================================

test("81. R2F1-R3 Capability: getInternalRunToken does NOT exist in index or deep import artifact-store", async () => {
  const cindyIndex = await import("../tools/cindy/index.ts");
  assert.equal("INTERNAL_RUN_TOKEN" in cindyIndex, false, "INTERNAL_RUN_TOKEN must not be in public API index");
  assert.equal("getInternalRunToken" in cindyIndex, false, "getInternalRunToken must not be in public API index");

  const artifactStoreModule = await import("../tools/cindy/artifact-store.ts");
  assert.equal("INTERNAL_RUN_TOKEN" in artifactStoreModule, false, "INTERNAL_RUN_TOKEN must not be in artifact-store deep import");
  assert.equal("getInternalRunToken" in artifactStoreModule, false, "getInternalRunToken must not be in artifact-store deep import");
});

test("82. R2F1-R3 Capability: no raw arbitrary saveRunState capability exists on RuntimeArtifactStore", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    assert.equal("saveRunState" in store, false, "saveRunState must not exist on RuntimeArtifactStore");
    assert.equal((store as unknown as Record<string, unknown>).saveRunState, undefined, "saveRunState must be undefined");
  } finally {
    await cleanup();
  }
});

test("83. R2F1-R2 H02: public transition to privileged states (FINAL_GATE, READY_TO_COMMIT, CLOSED) is rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-pub-priv", taskId: "TASK-PRIV" });

    const privilegedStates = [
      CindyState.FINAL_GATE,
      CindyState.READY_TO_COMMIT,
      CindyState.COMMITTING,
      CindyState.PUSHING,
      CindyState.CLOSED,
      CindyState.NEXT_TASK_SELECTED,
    ];

    for (const st of privilegedStates) {
      await assert.rejects(
        async () => {
          await orchestrator.transition(run.runId, st);
        },
        (err: unknown) => err instanceof TransitionRejectedError,
        `Public transition to privileged state ${st} must be rejected`
      );
    }
  } finally {
    await cleanup();
  }
});

test("84. R2F1-R2 H02: fake gate cannot authorize anything (recordValidatedFinalGateResult fails closed with FEATURE_NOT_AVAILABLE_IN_CONTROL_PLANE_MVP)", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-fake-auth", taskId: "TASK-FA" });
    const tree = await orchestrator.computeCurrentTreeDigest();

    // From non-FINAL_GATE: rejected with TransitionRejectedError
    await assert.rejects(
      async () => {
        await orchestrator.recordValidatedFinalGateResult(run.runId, {
          verdict: "PASS",
          boundTreeDigest: tree,
        });
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );

    // State remains TASK_INITIALIZED — no authorization granted
    const currentRun = await orchestrator.getRun(run.runId);
    assert.equal(currentRun.state, CindyState.TASK_INITIALIZED);
  } finally {
    await cleanup();
  }
});

test("85. R2F1-R2 H02: recordCloseout is sealed fail closed with FEATURE_NOT_AVAILABLE_IN_CONTROL_PLANE_MVP", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-closeout-sealed", taskId: "TASK-CS" });

    await assert.rejects(
      async () => {
        await orchestrator.recordCloseout(run.runId);
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        (err as Error).message.includes("FEATURE_NOT_AVAILABLE_IN_CONTROL_PLANE_MVP")
    );
  } finally {
    await cleanup();
  }
});

test("86. R2F1-R2 M01: reviewer session mismatch rejected at review result recording", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-sess-mismatch", taskId: "TASK-SM" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const tree = await orchestrator.computeCurrentTreeDigest();
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: tree,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });

    await orchestrator.prepareForReview(run.runId);
    // Request has session "session-alpha"
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Alice", session: "session-alpha", readOnlyConfirmed: true },
    });

    const diff = await orchestrator.computeCurrentDiffDigest();
    // Result has same identity "Alice", but different session "session-beta" -> must reject
    await assert.rejects(
      async () => {
            const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
        await orchestrator.recordValidatedReviewResult(run.runId, {
          runId: run.runId,
          taskId: run.taskId,
          cycle: 1,
          reviewer: { identity: "Alice", session: "session-beta", readOnlyConfirmed: true },
          reviewedBaseCommit: run.baseCommit,
          reviewedTreeDigest: tree,
          reviewedDiffDigest: diff,
          verdict: "PASS",
          findings: [],
          recordedAt: new Date().toISOString(),
            executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
            executionSnapshotDigest: snap.digest
        });
      },
      (err: unknown) =>
        err instanceof ArtifactValidationError && (err as Error).message.includes("session mismatch")
    );
  } finally {
    await cleanup();
  }
});

test("87. R2F1-R2 M01: reviewer session mismatch rejected at consumeReviewPass", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-sess-consume", taskId: "TASK-SC" });
    const tree = await orchestrator.computeCurrentTreeDigest();

    // Fabricate a review-request with session "sess-expected"
    const runDir = orchestrator.artifactStore.getRunDir(run.runId);
    await mkdir(runDir, { recursive: true });
    const liveSnap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const liveDiff = await orchestrator.computeCurrentDiffDigest();
    await writeFile(
      join(runDir, "review-request-cycle-1.json"),
      JSON.stringify({
        runId: run.runId,
        taskId: run.taskId,
        baseCommit: run.baseCommit,
        cycle: 1,
        reviewer: {
          identity: "Alice",
          session: "sess-expected",
          readOnlyConfirmed: true,
          readOnlyRequired: true,
        },
        boundTreeDigest: tree,
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: liveSnap.digest,
        requestedAt: new Date().toISOString(),
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      }),
      "utf8"
    );

    // Fabricate a review-result with session "sess-different"
    await writeFile(
      join(runDir, "review-result-cycle-1.json"),
      JSON.stringify({
        runId: run.runId,
        taskId: run.taskId,
        cycle: 1,
        reviewer: { identity: "Alice", session: "sess-different", readOnlyConfirmed: true },
        reviewedBaseCommit: run.baseCommit,
        reviewedTreeDigest: tree,
        reviewedDiffDigest: liveDiff,
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: liveSnap.digest,
        verdict: "PASS",
        findings: [],
        recordedAt: new Date().toISOString(),
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      }),
      "utf8"
    );

    await assert.rejects(
      async () => {
        await orchestrator.consumeReviewPass(run.runId, 1);
      },
      (err: unknown) =>
        err instanceof ArtifactValidationError && (err as Error).message.includes("session mismatch")
    );
  } finally {
    await cleanup();
  }
});

test("88. R2F1-R2: readOnlyConfirmed=false rejected in review request and review result", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-ro-false", taskId: "TASK-ROF" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const tree = await orchestrator.computeCurrentTreeDigest();
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: tree,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });

    await orchestrator.prepareForReview(run.runId);

    // startReview with readOnlyConfirmed: false must be rejected
    await assert.rejects(
      async () => {
        await orchestrator.startReview(run.runId, {
          reviewer: { identity: "Alice", session: "sess-1", readOnlyConfirmed: false },
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
  } finally {
    await cleanup();
  }
});

test("89. R2F1-R2 H03: schema with unsupported $schema is rejected fail closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const customSchemaDir = join(repoDir, "schemas");
    await mkdir(customSchemaDir, { recursive: true });

    // Write a schema declaring standard Draft 2020-12 instead of Cindy Control Schema Dialect v1
    const badSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "Bad Schema",
      type: "object",
      properties: { test: { type: "string" } },
    };
    await writeFile(join(customSchemaDir, "bad-schema.json"), JSON.stringify(badSchema), "utf8");

    assert.throws(
      () => {
        loadArtifactSchema(repoDir, "bad-schema.json");
      },
      (err: unknown) =>
        err instanceof ArtifactValidationError &&
        (err as Error).message.includes("Cindy Control Schema Dialect v1")
    );
  } finally {
    await cleanup();
  }
});

test("90. R2F1-R2 H03: schema with unsupported format (e.g. email) is rejected fail closed", () => {
  const schemaWithEmail = {
    $schema: CINDY_DIALECT_SCHEMA_ID,
    type: "object",
    properties: {
      userEmail: {
        type: "string",
        format: "email", // unsupported format in Cindy Control Schema Dialect v1
      },
    },
  };

  assert.throws(
    () => {
      assertValidSchemaDialect(schemaWithEmail);
    },
    (err: unknown) =>
      err instanceof ArtifactValidationError &&
      (err as Error).message.includes("unsupported format 'email'")
  );
});

test("91. R2F1-R2 H03: schema with unsupported items form (boolean items) is rejected fail closed", () => {
  const schemaWithBooleanItems = {
    $schema: CINDY_DIALECT_SCHEMA_ID,
    type: "object",
    properties: {
      tags: {
        type: "array",
        items: false, // boolean schema for items is unsupported in Cindy dialect
      },
    },
  };

  assert.throws(
    () => {
      assertValidSchemaDialect(schemaWithBooleanItems);
    },
    (err: unknown) =>
      err instanceof ArtifactValidationError &&
      (err as Error).message.includes("boolean schema for items is not supported")
  );
});

test("92. R2F1-R2 H03: schema with nested unknown keyword is rejected fail closed", () => {
  const schemaWithDeepUnknown = {
    $schema: CINDY_DIALECT_SCHEMA_ID,
    type: "object",
    properties: {
      outer: {
        type: "object",
        properties: {
          inner: {
            type: "string",
            unrecognizedNestedKeyword: "danger",
          },
        },
      },
    },
  };

  assert.throws(
    () => {
      assertValidSchemaDialect(schemaWithDeepUnknown);
    },
    (err: unknown) =>
      err instanceof ArtifactValidationError &&
      (err as Error).message.includes("unknown keyword 'unrecognizedNestedKeyword'")
  );
});

test("93. R2F1-R2 H05: two concurrent stale-lock recoverers fail closed without deleting lock", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store1 = new RuntimeArtifactStore({ repoDir });
    const store2 = new RuntimeArtifactStore({ repoDir });
    const runDir = await createMockRegisteredRun(repoDir, "run-concurrent-recover");

    // Pick a definitely dead PID
    const deadPid = 9999998;
    const lockPath = join(runDir, ".run.lock");
    const deadLock = {
      pid: deadPid,
      hostname: (await import("node:os")).hostname(),
      createdAt: new Date().toISOString(),
      ownerId: "stale-dead-owner",
    };
    await writeFile(lockPath, JSON.stringify(deadLock), "utf8");

    // Both recoverers concurrently attempt acquireRunLock against dead PID lock
    const [res1, res2] = await Promise.allSettled([
      store1.acquireRunLock(runDir),
      store2.acquireRunLock(runDir),
    ]);

    // Under Decision D: ZERO recoverers enter critical section. Both must fail closed.
    const fulfilled = [res1, res2].filter((r) => r.status === "fulfilled");
    assert.equal(fulfilled.length, 0, "Zero processes must enter critical section on stale lock");

    const rejected = [res1, res2].filter((r) => r.status === "rejected");
    assert.equal(rejected.length, 2, "Both processes must fail closed");
    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason;
      assert.ok(
        reason instanceof ConcurrentRunUpdateError &&
        reason.message.includes("STALE_RUN_LOCK_REQUIRES_RECONCILIATION"),
        "Must fail with STALE_RUN_LOCK_REQUIRES_RECONCILIATION"
      );
    }

    // The lock file must exist untouched
    const lockContent = await readFile(lockPath, "utf8");
    const lockMeta = JSON.parse(lockContent);
    assert.equal(lockMeta.ownerId, "stale-dead-owner");

    // No stale claim or recovery files created
    assert.equal(existsSync(join(runDir, ".run.lock.recovery")), false);
  } finally {
    await cleanup();
  }
});

test("94. R2F1-R2 N02: lock metadata write failure cleans up own partial lock and recovers", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = await createMockRegisteredRun(repoDir, "run-write-fail-test");

    const probePath = join(runDir, ".probe-wf");
    const probeHandle = await (await import("node:fs/promises")).open(probePath, "w");
    const proto = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    await rm(probePath, { force: true });

    const originalWriteFile = proto.writeFile;
    let shouldFail = true;

    proto.writeFile = async function (...args: unknown[]) {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("Simulated disk write failure");
      }
      return originalWriteFile.apply(this, args);
    };

    try {
      // First attempt triggers injected write failure
      await assert.rejects(
        async () => {
          await store.acquireRunLock(runDir);
        },
        (err: unknown) =>
          err instanceof ConcurrentRunUpdateError &&
          (err as Error).message.includes("Failed to write lock metadata")
      );

      // Verify that no leftover empty/partial lock remains
      const lockPath = join(runDir, ".run.lock");
      assert.equal(existsSync(lockPath), false, "Partial lock must have been unlinked upon write failure");

      // Subsequent attempt with normal write succeeds cleanly
      const acquired = await store.acquireRunLock(runDir);
      assert.ok(acquired.ownerId);
      await store.releaseRunLock(runDir, acquired.ownerId);
    } finally {
      proto.writeFile = originalWriteFile;
    }
  } finally {
    await cleanup();
  }
});

test("95. R2F1-R2 N02: lock metadata sync failure cleans up own partial lock and recovers", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = await createMockRegisteredRun(repoDir, "run-sync-fail-test");

    const probePath = join(runDir, ".probe-sf");
    const probeHandle = await (await import("node:fs/promises")).open(probePath, "w");
    const proto = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    await rm(probePath, { force: true });

    const originalSync = proto.sync;
    let shouldFail = true;

    proto.sync = async function (...args: unknown[]) {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("Simulated disk sync failure");
      }
      return originalSync.apply(this, args);
    };

    try {
      // First attempt triggers injected sync failure
      await assert.rejects(
        async () => {
          await store.acquireRunLock(runDir);
        },
        (err: unknown) =>
          err instanceof ConcurrentRunUpdateError &&
          (err as Error).message.includes("Failed to write lock metadata")
      );

      // Verify that no corrupt lock remains
      const lockPath = join(runDir, ".run.lock");
      assert.equal(existsSync(lockPath), false, "Lock must have been unlinked upon sync failure");

      // Subsequent attempt with normal sync succeeds cleanly
      const acquired = await store.acquireRunLock(runDir);
      assert.ok(acquired.ownerId);
      await store.releaseRunLock(runDir, acquired.ownerId);
    } finally {
      proto.sync = originalSync;
    }
  } finally {
    await cleanup();
  }
});

test("96. R2F1-R2 H04: canonical repo root behavior when repoDir is a symlink", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  const symlinkRepoDir = join(tmpdir(), `cindy-symlink-repo-${Date.now()}`);
  await symlink(repoDir, symlinkRepoDir);
  try {
    const store = new RuntimeArtifactStore({ repoDir: symlinkRepoDir });
    const orchestrator = new CindyOrchestrator({ repoDir: symlinkRepoDir });

    const expectedCanonical = (await import("node:fs")).realpathSync(repoDir);
    assert.equal(store.repoDir, expectedCanonical, "RuntimeArtifactStore must resolve to canonical path");
    assert.equal(orchestrator.repoDir, expectedCanonical, "CindyOrchestrator must resolve to canonical path");

    const run = await orchestrator.initRun({
      runId: "run-canonical-test",
      taskId: "TASK-CANONICAL",
    });
    assert.equal(run.runId, "run-canonical-test");

    const runDir = store.getRunDir("run-canonical-test");
    assert.ok(runDir.startsWith(expectedCanonical), "runDir must be under canonical repository root");

    const readRun = await orchestrator.getRun("run-canonical-test");
    assert.equal(readRun.taskId, "TASK-CANONICAL");
  } finally {
    await rm(symlinkRepoDir, { force: true }).catch(() => {});
    await cleanup();
  }
});

// =========================================================================
// R2F1-R3: Repair & Convergence Tests
// =========================================================================

// --- CAPABILITY TESTS ---

test("97. R2F1-R3 Capability: createInitialRun raw method removed from RuntimeArtifactStore", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    assert.strictEqual((store as any).createInitialRun, undefined);
  } finally {
    await cleanup();
  }
});

test("98. R2F1-R3 Capability: store cannot bypass init lock to create READY_TO_COMMIT run", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    assert.strictEqual((store as any).createInitialRun, undefined);
  } finally {
    await cleanup();
  }
});

test("99. R2F1-R3 Capability: store cannot bypass init lock to create COMMITTING run", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    assert.strictEqual((store as any).createInitialRun, undefined);
  } finally {
    await cleanup();
  }
});

test("100. R2F1-R3 Capability: store cannot bypass init lock to create NEXT_TASK_SELECTED run", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    assert.strictEqual((store as any).createInitialRun, undefined);
  } finally {
    await cleanup();
  }
});

// --- PRIVILEGED STATES TESTS ---

test("101. R2F1-R3 Privileged states: Review PASS does NOT enter FINAL_GATE (remains REVIEWING)", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-pass-not-gate", taskId: "TASK-PASS-TEST" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const tree = await orchestrator.computeCurrentTreeDigest();
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: tree,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });

    await orchestrator.prepareForReview(run.runId);
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Alice", session: "s1", readOnlyConfirmed: true },
    });

    const diff = await orchestrator.computeCurrentDiffDigest();
    const resultRun = await orchestrator.recordValidatedReviewResult(run.runId, {
      runId: run.runId,
      taskId: run.taskId,
      reviewedBaseCommit: run.baseCommit,
      cycle: 1,
      reviewer: { identity: "Alice", session: "s1", readOnlyConfirmed: true },
      reviewedTreeDigest: tree,
      reviewedDiffDigest: diff,
      verdict: "PASS",
      findings: [],
      recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });

    assert.equal(resultRun.state, CindyState.REVIEWING, "Run state must remain REVIEWING after PASS");
    const onDiskRun = await orchestrator.getRun(run.runId);
    assert.equal(onDiskRun.state, CindyState.REVIEWING, "On-disk run state must remain REVIEWING after PASS");

    const passEvidence = await orchestrator.consumeReviewPass(run.runId, 1);
    assert.equal(passEvidence.verdict, "PASS");
  } finally {
    await cleanup();
  }
});

test("102. R2F1-R3 Privileged states: public FINAL_GATE impossible", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-no-fg", taskId: "TASK-1" });

    await assert.rejects(
      async () => {
        await orchestrator.transition(run.runId, CindyState.FINAL_GATE);
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );

    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.applyAdministrativeTransition(run.runId, CindyState.FINAL_GATE);
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );

    await assert.rejects(
      async () => {
        await orchestrator.recordValidatedFinalGateResult(run.runId, {
          verdict: "PASS",
          boundTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        });
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        (err as Error).message.includes("FEATURE_NOT_AVAILABLE_IN_CONTROL_PLANE_MVP")
    );
  } finally {
    await cleanup();
  }
});

test("103. R2F1-R3 Privileged states: public READY_TO_COMMIT impossible", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-no-rtc", taskId: "TASK-1" });

    await assert.rejects(
      async () => {
        await orchestrator.transition(run.runId, CindyState.READY_TO_COMMIT);
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );

    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.applyAdministrativeTransition(run.runId, CindyState.READY_TO_COMMIT);
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );
  } finally {
    await cleanup();
  }
});

test("104. R2F1-R3 Privileged states: public CLOSED impossible", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-no-closed", taskId: "TASK-1" });

    await assert.rejects(
      async () => {
        await orchestrator.transition(run.runId, CindyState.CLOSED);
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );

    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.applyAdministrativeTransition(run.runId, CindyState.CLOSED);
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );

    await assert.rejects(
      async () => {
        await orchestrator.recordCloseout(run.runId);
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        (err as Error).message.includes("FEATURE_NOT_AVAILABLE_IN_CONTROL_PLANE_MVP")
    );
  } finally {
    await cleanup();
  }
});

test("105. R2F1-R3 Privileged states: CLI privileged state impossible", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const cliPath = join(process.cwd(), "tools", "cindy-cli.ts");
    for (const cmd of ["commit", "push", "close", "final-gate", "ready-to-commit"]) {
      assert.throws(
        () => {
          execFileSync(process.execPath, ["--experimental-strip-types", cliPath, cmd], {
            cwd: repoDir,
            encoding: "utf8",
            stdio: "pipe",
          });
        },
        (err: unknown) => {
          const status = (err as { status?: number }).status;
          return status === 1;
        }
      );
    }
  } finally {
    await cleanup();
  }
});

test("CINDY-R2-F01: CLI init cannot select a task from current hints", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const cliPath = join(process.cwd(), "tools", "cindy-cli.ts");
    const currentPath = join(repoDir, ".agent", "current.json");
    const hints = [
      // Valid committed pointer used to authorize init without explicit --task.
      await readFile(currentPath, "utf8"),
      JSON.stringify({ taskId: "TEST-TASK-001", runId: "stale-run", status: "CLOSED" }),
      JSON.stringify({ task: "UNKNOWN-TASK", taskId: "TASK-1" }),
      "{broken-json",
      undefined,
    ];
    for (const hint of hints) {
      if (hint === undefined) await unlink(currentPath);
      else await writeFile(currentPath, hint, "utf8");
      const before = execFileSync("git", ["status", "--porcelain=v1"], { cwd: repoDir, encoding: "utf8" });
      for (const args of [[], ["--task"], ["--task", "--unknown"]]) {
        const result = spawnSync(process.execPath, ["--experimental-strip-types", cliPath, "init", ...args], {
          cwd: repoDir, encoding: "utf8", timeout: 30_000,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 1);
        assert.equal(JSON.parse(result.stderr).error, "CURRENT_TASK_UNRESOLVED");
        assert.equal(result.stdout, "");
        assert.equal(existsSync(join(repoDir, ".agent", "runtime")), false);
        assert.equal(existsSync(join(repoDir, ".agent", ".cindy-init-staging")), false);
        assert.equal(execFileSync("git", ["status", "--porcelain=v1"], { cwd: repoDir, encoding: "utf8" }), before);
      }
    }
  } finally {
    await cleanup();
  }
});

test("CINDY-R2-F01: CLI init uses explicit task despite a different committed hint", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const cliPath = join(process.cwd(), "tools", "cindy-cli.ts");
    const currentPath = join(repoDir, ".agent", "current.json");
    const hintBefore = await readFile(currentPath, "utf8");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", cliPath, "init", "--task", "TASK-1"], {
      cwd: repoDir, encoding: "utf8", timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const run = JSON.parse(result.stdout) as CindyRun;
    assert.equal(run.taskId, "TASK-1");
    assert.equal(run.state, CindyState.TASK_INITIALIZED);
    assert.equal(JSON.parse(await readFile(join(repoDir, ".agent", "runtime", run.runId, "run.json"), "utf8")).taskId, "TASK-1");
    assert.equal(await readFile(currentPath, "utf8"), hintBefore);
    assert.equal(execFileSync("git", ["status", "--porcelain=v1"], { cwd: repoDir, encoding: "utf8" }), "");
  } finally {
    await cleanup();
  }
});

// --- REVIEW BINDING TESTS ---

test("106. R2F1-R3 Review binding: wrong request taskId rejected in consumeReviewPass", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-bind-task", taskId: "TASK-REAL" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const tree = await orchestrator.computeCurrentTreeDigest();
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: tree,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });

    await orchestrator.prepareForReview(run.runId);
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Alice", session: "s1", readOnlyConfirmed: true },
    });

    const diff = await orchestrator.computeCurrentDiffDigest();
    await orchestrator.recordValidatedReviewResult(run.runId, {
      runId: run.runId,
      taskId: run.taskId,
      reviewedBaseCommit: run.baseCommit,
      cycle: 1,
      reviewer: { identity: "Alice", session: "s1", readOnlyConfirmed: true },
      reviewedTreeDigest: tree,
      reviewedDiffDigest: diff,
      verdict: "PASS",
      findings: [],
      recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });

    // Corrupt request taskId on disk
    const reqPath = orchestrator.artifactStore.getArtifactPath(run.runId, ArtifactKind.REVIEW_REQUEST, 1);
    const reqData = JSON.parse(await readFile(reqPath, "utf8"));
    reqData.taskId = "WRONG-TASK";
    await writeFile(reqPath, JSON.stringify(reqData, null, 2), "utf8");

    await assert.rejects(
      async () => {
        await orchestrator.consumeReviewPass(run.runId, 1);
      },
      (err: unknown) =>
        err instanceof ArtifactValidationError && (err as Error).message.includes("taskId binding mismatch")
    );
  } finally {
    await cleanup();
  }
});

test("107. R2F1-R3 Review binding: wrong request baseCommit rejected in consumeReviewPass", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-bind-base", taskId: "TASK-BASE" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const tree = await orchestrator.computeCurrentTreeDigest();
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: tree,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });

    await orchestrator.prepareForReview(run.runId);
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Alice", session: "s1", readOnlyConfirmed: true },
    });

    const diff = await orchestrator.computeCurrentDiffDigest();
    await orchestrator.recordValidatedReviewResult(run.runId, {
      runId: run.runId,
      taskId: run.taskId,
      reviewedBaseCommit: run.baseCommit,
      cycle: 1,
      reviewer: { identity: "Alice", session: "s1", readOnlyConfirmed: true },
      reviewedTreeDigest: tree,
      reviewedDiffDigest: diff,
      verdict: "PASS",
      findings: [],
      recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });

    // Corrupt request baseCommit on disk
    const reqPath = orchestrator.artifactStore.getArtifactPath(run.runId, ArtifactKind.REVIEW_REQUEST, 1);
    const reqData = JSON.parse(await readFile(reqPath, "utf8"));
    reqData.baseCommit = "corrupted-wrong-base";
    await writeFile(reqPath, JSON.stringify(reqData, null, 2), "utf8");

    await assert.rejects(
      async () => {
        await orchestrator.consumeReviewPass(run.runId, 1);
      },
      (err: unknown) =>
        err instanceof ArtifactValidationError && (err as Error).message.includes("baseCommit binding mismatch")
    );
  } finally {
    await cleanup();
  }
});

test("108. R2F1-R3 Review binding: wrong reviewer session rejected in consumeReviewPass", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-bind-sess", taskId: "TASK-SESS" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const tree = await orchestrator.computeCurrentTreeDigest();
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: tree,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });

    await orchestrator.prepareForReview(run.runId);
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Alice", session: "session-1", readOnlyConfirmed: true },
    });

    const diff = await orchestrator.computeCurrentDiffDigest();
    await orchestrator.recordValidatedReviewResult(run.runId, {
      runId: run.runId,
      taskId: run.taskId,
      reviewedBaseCommit: run.baseCommit,
      cycle: 1,
      reviewer: { identity: "Alice", session: "session-1", readOnlyConfirmed: true },
      reviewedTreeDigest: tree,
      reviewedDiffDigest: diff,
      verdict: "PASS",
      findings: [],
      recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });

    // Change review result session on disk to session-2
    const resPath = orchestrator.artifactStore.getArtifactPath(run.runId, ArtifactKind.REVIEW_RESULT, 1);
    const resData = JSON.parse(await readFile(resPath, "utf8"));
    resData.reviewer.session = "session-2";
    await writeFile(resPath, JSON.stringify(resData, null, 2), "utf8");

    await assert.rejects(
      async () => {
        await orchestrator.consumeReviewPass(run.runId, 1);
      },
      (err: unknown) =>
        err instanceof ArtifactValidationError && (err as Error).message.includes("session mismatch")
    );
  } finally {
    await cleanup();
  }
});

test("109. R2F1-R3 Review binding: missing reviewer session schema rejected fail closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    // Attempt to validate review request without reviewer.session
    assert.throws(
      () => {
        validateArtifactBoundary(
          repoDir,
          ArtifactKind.REVIEW_REQUEST,
          {
            runId: "run-no-sess",
            taskId: "TASK",
            baseCommit: "dummy-commit",
            cycle: 1,
            reviewer: { identity: "Alice", readOnlyConfirmed: true },
            boundTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
            requestedAt: new Date().toISOString(),
          },
          { runId: "run-no-sess", taskId: "TASK", cycle: 1 }
        );
      },
      (err: unknown) =>
        err instanceof ArtifactValidationError &&
        ((err as Error).message.includes("missing required property 'session'") ||
         (err as Error).message.includes("requires non-empty reviewer.session"))
    );

    // Attempt to validate review result without reviewer.session
    assert.throws(
      () => {
        validateArtifactBoundary(
          repoDir,
          ArtifactKind.REVIEW_RESULT,
          {
            runId: "run-no-sess-res",
            taskId: "TASK",
            reviewedBaseCommit: "dummy-commit",
            cycle: 1,
            reviewer: { identity: "Alice", readOnlyConfirmed: true },
            reviewedTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
            reviewedDiffDigest: "0000000000000000000000000000000000000000000000000000000000000000",
            verdict: "PASS",
            findings: [],
            recordedAt: new Date().toISOString(),
          },
          { runId: "run-no-sess-res", taskId: "TASK", cycle: 1 }
        );
      },
      (err: unknown) =>
        err instanceof ArtifactValidationError &&
        ((err as Error).message.includes("missing required property 'session'") ||
         (err as Error).message.includes("requires non-empty reviewer.session"))
    );
  } finally {
    await cleanup();
  }
});

test("110. R2F1-R3 Review binding: wrong cycle in review request or review result rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-bind-cycle", taskId: "TASK-CYC" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const tree = await orchestrator.computeCurrentTreeDigest();
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: tree,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });

    await orchestrator.prepareForReview(run.runId);
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Alice", session: "s1", readOnlyConfirmed: true },
    });

    const diff = await orchestrator.computeCurrentDiffDigest();
    await orchestrator.recordValidatedReviewResult(run.runId, {
      runId: run.runId,
      taskId: run.taskId,
      reviewedBaseCommit: run.baseCommit,
      cycle: 1,
      reviewer: { identity: "Alice", session: "s1", readOnlyConfirmed: true },
      reviewedTreeDigest: tree,
      reviewedDiffDigest: diff,
      verdict: "PASS",
      findings: [],
      recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });

    // Pass wrong cycle 2 to consumeReviewPass
    await assert.rejects(
      async () => {
        await orchestrator.consumeReviewPass(run.runId, 2);
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
  } finally {
    await cleanup();
  }
});

test("111. R2F1-R3 Review binding: stale tree rejects consumeReviewPass", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-stale-tree", taskId: "TASK-TREE" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const tree = await orchestrator.computeCurrentTreeDigest();
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: tree,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });

    await orchestrator.prepareForReview(run.runId);
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Alice", session: "s1", readOnlyConfirmed: true },
    });

    const diff = await orchestrator.computeCurrentDiffDigest();
    await orchestrator.recordValidatedReviewResult(run.runId, {
      runId: run.runId,
      taskId: run.taskId,
      reviewedBaseCommit: run.baseCommit,
      cycle: 1,
      reviewer: { identity: "Alice", session: "s1", readOnlyConfirmed: true },
      reviewedTreeDigest: tree,
      reviewedDiffDigest: diff,
      verdict: "PASS",
      findings: [],
      recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });

    // Mutate tree before consuming review PASS
    await writeFile(join(repoDir, "README.md"), "# Stale Mutation\n", "utf8");

    await assert.rejects(
      async () => {
        await orchestrator.consumeReviewPass(run.runId, 1);
      },
      (err: unknown) =>
        err instanceof ArtifactDigestMismatchError &&
        (err as Error).message.includes("tree digest mismatch")
    );
  } finally {
    await cleanup();
  }
});

// --- LOCK TESTS ---

test("112. R2F1-R3 Lock: two concurrent stale recoverers: zero enter under Decision D", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store1 = new RuntimeArtifactStore({ repoDir });
    const store2 = new RuntimeArtifactStore({ repoDir });
    const runDir = await createMockRegisteredRun(repoDir, "run-lock-concurrent");

    const deadPid = 9999998;
    const lockPath = join(runDir, ".run.lock");
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: deadPid,
        hostname: (await import("node:os")).hostname(),
        createdAt: new Date().toISOString(),
        ownerId: "dead-owner-112",
      }),
      "utf8"
    );

    const [res1, res2] = await Promise.allSettled([
      store1.acquireRunLock(runDir),
      store2.acquireRunLock(runDir),
    ]);

    const fulfilled = [res1, res2].filter((r) => r.status === "fulfilled");
    assert.equal(fulfilled.length, 0, "Zero processes must enter critical section");

    const lockContent = await readFile(lockPath, "utf8");
    const lockMeta = JSON.parse(lockContent);
    assert.equal(lockMeta.ownerId, "dead-owner-112", "Dead lock must remain untouched");
  } finally {
    await cleanup();
  }
});

test("113. R2F1-R3 Lock: no .run.lock.recovery or .run.lock.stale.* dependency created", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = await createMockRegisteredRun(repoDir, "run-no-recovery-mutex");

    const deadPid = 9999998;
    const lockPath = join(runDir, ".run.lock");
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: deadPid,
        hostname: (await import("node:os")).hostname(),
        createdAt: new Date().toISOString(),
        ownerId: "dead-owner-113",
      }),
      "utf8"
    );

    await assert.rejects(
      async () => {
        await store.acquireRunLock(runDir);
      },
      (err: unknown) =>
        err instanceof ConcurrentRunUpdateError &&
        (err as Error).message.includes("STALE_RUN_LOCK_REQUIRES_RECONCILIATION")
    );

    // .run.lock.recovery must NOT exist
    const recoveryPath = join(runDir, ".run.lock.recovery");
    assert.equal(existsSync(recoveryPath), false, ".run.lock.recovery must not exist");

    // No stale claim file created
    const files = await readdir(runDir);
    assert.ok(!files.some((f) => f.includes(".run.lock.stale")), "No .run.lock.stale.* file created");
  } finally {
    await cleanup();
  }
});

test("114. R2F1-R3 Lock: live PID preserved and not recovered", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = await createMockRegisteredRun(repoDir, "run-live-pid");

    const lockPath = join(runDir, ".run.lock");
    const liveLock = {
      pid: process.pid,
      hostname: (await import("node:os")).hostname(),
      createdAt: new Date().toISOString(),
      ownerId: "live-process-owner",
    };
    await writeFile(lockPath, JSON.stringify(liveLock), "utf8");

    await assert.rejects(
      async () => {
        await store.acquireRunLock(runDir);
      },
      (err: unknown) =>
        err instanceof ConcurrentRunUpdateError &&
        (err as Error).message.includes("CONCURRENT_RUN_UPDATE")
    );

    // Lock file must be preserved untouched
    const currentLock = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(currentLock.ownerId, "live-process-owner");
  } finally {
    await cleanup();
  }
});

test("115. R2F1-R3 Lock: EPERM simulated on PID check fails closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = await createMockRegisteredRun(repoDir, "run-eperm-test");

    const lockPath = join(runDir, ".run.lock");
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 12345,
        hostname: (await import("node:os")).hostname(),
        createdAt: new Date().toISOString(),
        ownerId: "eperm-owner",
      }),
      "utf8"
    );

    const origKill = process.kill;
    // Mock process.kill to throw EPERM
    (process as unknown as { kill: (pid: number, signal?: number | string) => void }).kill = function (
      pid: number,
      signal?: number | string
    ) {
      if (pid === 12345 && signal === 0) {
        const err = new Error("kill EPERM") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return origKill.call(process, pid, signal as string);
    };

    try {
      await assert.rejects(
        async () => {
          await store.acquireRunLock(runDir);
        },
        (err: unknown) =>
          err instanceof ConcurrentRunUpdateError &&
          (err as Error).message.includes("CONCURRENT_RUN_UPDATE")
      );

      // Lock file must NOT be deleted or recovered
      assert.equal(existsSync(lockPath), true, "Lock must be preserved on EPERM");
    } finally {
      process.kill = origKill;
    }
  } finally {
    await cleanup();
  }
});

test("116. R2F1-R3 Lock: other hostname fails closed and does not recover", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = await createMockRegisteredRun(repoDir, "run-other-host");

    const lockPath = join(runDir, ".run.lock");
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 9999998,
        hostname: "different-remote-host.example.com",
        createdAt: new Date().toISOString(),
        ownerId: "remote-owner",
      }),
      "utf8"
    );

    await assert.rejects(
      async () => {
        await store.acquireRunLock(runDir);
      },
      (err: unknown) =>
        err instanceof ConcurrentRunUpdateError &&
        (err as Error).message.includes("CONCURRENT_RUN_UPDATE")
    );

    // Lock file must NOT be deleted
    assert.equal(existsSync(lockPath), true, "Lock from another host must never be unlinked");
  } finally {
    await cleanup();
  }
});

test("117. R2F1-R4 Lock: dead PID on same host produces STALE_RUN_LOCK_REQUIRES_RECONCILIATION and remains untouched", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = await createMockRegisteredRun(repoDir, "run-dead-pid-rec");

    const deadPid = 9999998;
    const lockPath = join(runDir, ".run.lock");
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: deadPid,
        hostname: (await import("node:os")).hostname(),
        createdAt: new Date().toISOString(),
        ownerId: "stale-dead-117",
      }),
      "utf8"
    );

    await assert.rejects(
      async () => {
        await store.acquireRunLock(runDir);
      },
      (err: unknown) =>
        err instanceof ConcurrentRunUpdateError &&
        (err as Error).message.includes("STALE_RUN_LOCK_REQUIRES_RECONCILIATION")
    );

    const lockMeta = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(lockMeta.pid, deadPid);
    assert.equal(lockMeta.ownerId, "stale-dead-117");

    const files = await readdir(runDir);
    assert.ok(!files.some((f) => f.includes(".run.lock.stale")), "No .run.lock.stale.* files");
  } finally {
    await cleanup();
  }
});

test("118. R2F1-R3 Lock: stale claim race: second process creates fresh lock, first recoverer must NOT delete it", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = await createMockRegisteredRun(repoDir, "run-race-fresh");

    const lockPath = join(runDir, ".run.lock");
    const freshOwner = "fresh-live-owner-b";
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        hostname: (await import("node:os")).hostname(),
        createdAt: new Date().toISOString(),
        ownerId: freshOwner,
      }),
      "utf8"
    );

    await assert.rejects(
      async () => {
        await store.acquireRunLock(runDir);
      },
      (err: unknown) => err instanceof ConcurrentRunUpdateError
    );

    // Fresh lock must still be in place with freshOwner
    const lockContent = await readFile(lockPath, "utf8");
    const lockMeta = JSON.parse(lockContent);
    assert.equal(lockMeta.ownerId, freshOwner, "Fresh lock must not be deleted or corrupted");
  } finally {
    await cleanup();
  }
});

// --- LOCK FAILURE TESTS ---

test("121. R2F1-R3 Lock failure: replacement lock simulated: old cleanup must NOT unlink replacement", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = await createMockRegisteredRun(repoDir, "run-replace-sim");

    const lockPath = join(runDir, ".run.lock");

    const probePath = join(runDir, ".probe-repl");
    const probeHandle = await (await import("node:fs/promises")).open(probePath, "w");
    const proto = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    await rm(probePath, { force: true });

    const originalWriteFile = proto.writeFile;
    let replacedLockContent = "";
    proto.writeFile = async function (...args: unknown[]) {
      try {
        unlinkSync(lockPath);
      } catch {}
      replacedLockContent = JSON.stringify({
        pid: process.pid,
        hostname: (await import("node:os")).hostname(),
        createdAt: new Date().toISOString(),
        ownerId: "replacement-owner-survives",
      });
      writeFileSync(lockPath, replacedLockContent, "utf8");

      throw new Error("Simulated write failure after lock replacement");
    };

    try {
      await assert.rejects(
        async () => {
          await store.acquireRunLock(runDir);
        },
        (err: unknown) =>
          err instanceof ConcurrentRunUpdateError &&
          (err as Error).message.includes("Failed to write lock metadata")
      );

      // CRITICAL ASSERTION: The replacement lock MUST NOT have been unlinked
      assert.equal(existsSync(lockPath), true, "Replacement lock must NOT be unlinked by old cleanup");
      const currentContent = await readFile(lockPath, "utf8");
      const currentMeta = JSON.parse(currentContent);
      assert.equal(currentMeta.ownerId, "replacement-owner-survives", "Replacement lock content must be preserved");
    } finally {
      proto.writeFile = originalWriteFile;
    }
  } finally {
    await cleanup();
  }
});

// --- REPOSITORY ROOT TESTS ---

test("122. R2F1-R3 Repo root: nonexistent repository root rejected fail closed", () => {
  const badPath = "/nonexistent/repo/root/path/cindy-" + Date.now();
  assert.throws(
    () => {
      new CindyOrchestrator({ repoDir: badPath });
    },
    (err: unknown) =>
      err instanceof InvalidRepositoryRootError &&
      (err as Error).message.includes("INVALID_REPOSITORY_ROOT")
  );

  assert.throws(
    () => {
      new RuntimeArtifactStore({ repoDir: badPath });
    },
    (err: unknown) =>
      err instanceof InvalidRepositoryRootError &&
      (err as Error).message.includes("INVALID_REPOSITORY_ROOT")
  );
});

test("123. R2F1-R3 Repo root: canonical temp repo accepted", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const orchestrator = new CindyOrchestrator({ repoDir });
    const realCanonical = (await import("node:fs")).realpathSync(repoDir);
    assert.equal(store.repoDir, realCanonical);
    assert.equal(orchestrator.repoDir, realCanonical);
  } finally {
    await cleanup();
  }
});

test("124. R2F1-R3 Repo root: symlink repo input behavior is deterministic and canonical", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  const symlinkRepoDir = join(tmpdir(), `cindy-symlink-root-${Date.now()}`);
  await symlink(repoDir, symlinkRepoDir);
  try {
    const store = new RuntimeArtifactStore({ repoDir: symlinkRepoDir });
    const orchestrator = new CindyOrchestrator({ repoDir: symlinkRepoDir });
    const realCanonical = (await import("node:fs")).realpathSync(repoDir);
    assert.equal(store.repoDir, realCanonical, "Must resolve to real canonical root");
    assert.equal(orchestrator.repoDir, realCanonical, "Must resolve to real canonical root");
  } finally {
    await rm(symlinkRepoDir, { force: true }).catch(() => {});
    await cleanup();
  }
});

// =========================================================================
// R2F1-R4: Lock Safety Convergence & Stage Boundary Tests
// =========================================================================

// --- INITIAL RUN STATE TESTS ---

test("125. R2F2 AD-U: createInitialRun bypass is removed from RuntimeArtifactStore", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    assert.strictEqual(
      (store as unknown as Record<string, unknown>).createInitialRun,
      undefined,
      "createInitialRun must not exist"
    );
    assert.strictEqual(
      typeof store.initializeRunSafely,
      "function",
      "initializeRunSafely must exist"
    );
  } finally {
    await cleanup();
  }
});

test("126. R2F2 AD-U / AD-Q: initializeRunSafely creates run in TASK_INITIALIZED with taskAuthorityCommit", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const run = await store.initializeRunSafely({
      runId: "run-init-safely",
      taskId: "TASK-1",
    });
    assert.equal(run.state, CindyState.TASK_INITIALIZED);
    assert.ok(run.taskAuthorityCommit);
    assert.equal(run.taskAuthorityCommit.length, 40);
    assert.ok(run.baseCommit);
    assert.equal(run.baseCommit.length, 40);
    assert.equal(run.taskAuthorityCommit, run.headCommit);

    const loaded = await store.getRun("run-init-safely");
    assert.equal(loaded?.state, CindyState.TASK_INITIALIZED);
    assert.equal(loaded?.taskAuthorityCommit, run.taskAuthorityCommit);
    assert.equal(loaded?.baseCommit, run.baseCommit);
  } finally {
    await cleanup();
  }
});

test("127. R2F2 AD-T: initializeRunSafely rejects invalid taskId", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    await assert.rejects(
      async () => {
        await store.initializeRunSafely({
          runId: "run-init-bad-task",
          taskId: "../malformed/path",
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
  } finally {
    await cleanup();
  }
});

test("128. R2F2 AD-Q: initializeRunSafely rejects caller baseCommit mismatch", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    await assert.rejects(
      async () => {
        await store.initializeRunSafely({
          runId: "run-init-drift",
          taskId: "TASK-1",
          baseCommit: "0".repeat(40),
        });
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        err.message.includes("BASELINE_MISMATCH")
    );
  } finally {
    await cleanup();
  }
});

test("129. R2F2 AD-I: initializeRunSafely rejects second active run for same task", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    await store.initializeRunSafely({
      runId: "run-init-dup-1",
      taskId: "TASK-1",
    });

    await assert.rejects(
      async () => {
        await store.initializeRunSafely({
          runId: "run-init-dup-2",
          taskId: "TASK-1",
        });
      },
      (err: unknown) =>
        err instanceof ActiveRunExistsError &&
        err.message.includes("ACTIVE_RUN_EXISTS")
    );
  } finally {
    await cleanup();
  }
});

// --- REVIEW SCHEMA TESTS ---

test("130. R2F1-R4 Review Schema: request missing reviewer.identity rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    assert.throws(
      () => {
        validateArtifactBoundary(
          repoDir,
          ArtifactKind.REVIEW_REQUEST,
          {
            runId: "run-req-noid",
            taskId: "TASK",
            baseCommit: "0000000000000000000000000000000000000000",
            cycle: 1,
            reviewer: {
              session: "sess-123",
              readOnlyRequired: true,
            },
            boundTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
            requestedAt: new Date().toISOString(),
          },
          { runId: "run-req-noid", taskId: "TASK", cycle: 1 }
        );
      },
      (err: unknown) =>
        err instanceof ArtifactValidationError &&
        (err as Error).message.includes("missing required property 'identity'")
    );
  } finally {
    await cleanup();
  }
});

test("131. R2F1-R4 Review Schema: request missing reviewer.session rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    assert.throws(
      () => {
        validateArtifactBoundary(
          repoDir,
          ArtifactKind.REVIEW_REQUEST,
          {
            runId: "run-req-nosess",
            taskId: "TASK",
            baseCommit: "0000000000000000000000000000000000000000",
            cycle: 1,
            reviewer: {
              identity: "reviewer-1",
              readOnlyRequired: true,
            },
            boundTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
            requestedAt: new Date().toISOString(),
          },
          { runId: "run-req-nosess", taskId: "TASK", cycle: 1 }
        );
      },
      (err: unknown) =>
        err instanceof ArtifactValidationError &&
        (err as Error).message.includes("missing required property 'session'")
    );
  } finally {
    await cleanup();
  }
});

test("132. R2F1-R4 Review Schema: request missing readOnlyRequired rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    assert.throws(
      () => {
        validateArtifactBoundary(
          repoDir,
          ArtifactKind.REVIEW_REQUEST,
          {
            runId: "run-req-noro",
            taskId: "TASK",
            baseCommit: "0000000000000000000000000000000000000000",
            cycle: 1,
            reviewer: {
              identity: "reviewer-1",
              session: "sess-123",
            },
            boundTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
            requestedAt: new Date().toISOString(),
          },
          { runId: "run-req-noro", taskId: "TASK", cycle: 1 }
        );
      },
      (err: unknown) =>
        err instanceof ArtifactValidationError &&
        (err as Error).message.includes("missing required property 'readOnlyRequired'")
    );
  } finally {
    await cleanup();
  }
});

test("133. R2F1-R4 Review Schema: request with complete reviewer passes", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    assert.doesNotThrow(() => {
      validateArtifactBoundary(
        repoDir,
        ArtifactKind.REVIEW_REQUEST,
        {
          runId: "run-req-ok",
          taskId: "TASK",
          baseCommit: "0000000000000000000000000000000000000000",
          cycle: 1,
          reviewer: {
            identity: "reviewer-1",
            session: "sess-123",
            readOnlyRequired: true,
          },
          boundTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: "0000000000000000000000000000000000000000000000000000000000000000",
          requestedAt: new Date().toISOString(),
        },
        { runId: "run-req-ok", taskId: "TASK", cycle: 1 }
      );
    });
  } finally {
    await cleanup();
  }
});

// --- LOCK ACQUISITION TESTS ---

test("134. R2F1-R4 Lock: candidate fully written before main lock exists", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = await createMockRegisteredRun(repoDir, "run-cand-written");

    const lockPath = join(runDir, ".run.lock");
    const probePath = join(runDir, ".probe-cw");
    const probeHandle = await (await import("node:fs/promises")).open(probePath, "w");
    const proto = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    await rm(probePath, { force: true });

    const originalSync = proto.sync;
    let candidateChecked = false;
    proto.sync = async function (...args: unknown[]) {
      const res = await originalSync.apply(this, args);
      // Main lock must NOT exist when candidate syncs
      assert.equal(existsSync(lockPath), false, "Main lock must NOT exist when candidate syncs");
      const files = await readdir(runDir);
      const cand = files.find((f) => f.startsWith(".run.lock.candidate."));
      if (cand) {
        const candContent = await readFile(join(runDir, cand), "utf8");
        const candMeta = JSON.parse(candContent);
        assert.equal(candMeta.pid, process.pid);
        assert.ok(candMeta.ownerId);
        assert.ok(candMeta.createdAt);
        assert.ok(candMeta.hostname);
        candidateChecked = true;
      }
      return res;
    };

    try {
      const lock = await store.acquireRunLock(runDir);
      assert.ok(candidateChecked, "Candidate was checked and verified before link");
      assert.ok(lock.ownerId);
      assert.equal(existsSync(lockPath), true, "Main lock exists after link");
      await store.releaseRunLock(runDir, lock.ownerId);
    } finally {
      proto.sync = originalSync;
    }
  } finally {
    await cleanup();
  }
});

test("135. R2F1-R4 Lock: two concurrent healthy acquires: exactly one succeeds and loser cannot modify winner lock", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store1 = new RuntimeArtifactStore({ repoDir });
    const store2 = new RuntimeArtifactStore({ repoDir });
    const runDir = await createMockRegisteredRun(repoDir, "run-two-concurrent");

    // Acquire lock with store1
    const lock1 = await store1.acquireRunLock(runDir);
    assert.ok(lock1.ownerId);

    // store2 attempts to acquire while store1 holds the lock -> must reject with ConcurrentRunUpdateError
    await assert.rejects(
      async () => {
        await store2.acquireRunLock(runDir);
      },
      (err: unknown) =>
        err instanceof ConcurrentRunUpdateError &&
        (err as Error).message.includes("CONCURRENT_RUN_UPDATE")
    );

    // Winner lock is untouched
    const lockPath = join(runDir, ".run.lock");
    const meta = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(meta.ownerId, lock1.ownerId, "Winner lock must not be modified by loser");

    // store1 releases cleanly
    await store1.releaseRunLock(runDir, lock1.ownerId);
    assert.equal(existsSync(lockPath), false, "Lock released successfully");
  } finally {
    await cleanup();
  }
});

test("136. R2F1-R4 Lock: candidate write failure leaves no main lock and does not block next acquire", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = await createMockRegisteredRun(repoDir, "run-cand-wf");

    const lockPath = join(runDir, ".run.lock");
    const probePath = join(runDir, ".probe-wf");
    const probeHandle = await (await import("node:fs/promises")).open(probePath, "w");
    const proto = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    await rm(probePath, { force: true });

    const originalWriteFile = proto.writeFile;
    let failOnce = true;
    proto.writeFile = async function (...args: unknown[]) {
      if (failOnce) {
        failOnce = false;
        throw new Error("Simulated candidate write failure");
      }
      return originalWriteFile.apply(this, args);
    };

    try {
      await assert.rejects(
        async () => {
          await store.acquireRunLock(runDir);
        },
        (err: unknown) =>
          err instanceof ConcurrentRunUpdateError &&
          (err as Error).message.includes("Failed to write lock metadata")
      );

      // Verify no main lock exists and candidate is unlinked
      assert.equal(existsSync(lockPath), false, "Main lock must not exist upon candidate write failure");
      const files = await readdir(runDir);
      assert.ok(!files.some((f) => f.startsWith(".run.lock.candidate.")), "Candidate file must be cleaned up");

      // Next acquire succeeds cleanly
      const acquired = await store.acquireRunLock(runDir);
      assert.ok(acquired.ownerId);
      assert.equal(existsSync(lockPath), true);
      await store.releaseRunLock(runDir, acquired.ownerId);
    } finally {
      proto.writeFile = originalWriteFile;
    }
  } finally {
    await cleanup();
  }
});

test("137. R2F1-R4 Lock: candidate sync failure leaves no main lock and does not block next acquire", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = await createMockRegisteredRun(repoDir, "run-cand-sf");

    const lockPath = join(runDir, ".run.lock");
    const probePath = join(runDir, ".probe-sf");
    const probeHandle = await (await import("node:fs/promises")).open(probePath, "w");
    const proto = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    await rm(probePath, { force: true });

    const originalSync = proto.sync;
    let failOnce = true;
    proto.sync = async function (...args: unknown[]) {
      if (failOnce) {
        failOnce = false;
        throw new Error("Simulated candidate sync failure");
      }
      return originalSync.apply(this, args);
    };

    try {
      await assert.rejects(
        async () => {
          await store.acquireRunLock(runDir);
        },
        (err: unknown) =>
          err instanceof ConcurrentRunUpdateError &&
          (err as Error).message.includes("Failed to write lock metadata")
      );

      // Verify no main lock exists and candidate is unlinked
      assert.equal(existsSync(lockPath), false, "Main lock must not exist upon candidate sync failure");
      const files = await readdir(runDir);
      assert.ok(!files.some((f) => f.startsWith(".run.lock.candidate.")), "Candidate file must be cleaned up");

      // Next acquire succeeds cleanly
      const acquired = await store.acquireRunLock(runDir);
      assert.ok(acquired.ownerId);
      assert.equal(existsSync(lockPath), true);
      await store.releaseRunLock(runDir, acquired.ownerId);
    } finally {
      proto.sync = originalSync;
    }
  } finally {
    await cleanup();
  }
});

test("138. R2F1-R4 Lock: candidate validation failure leaves no main lock and does not block next acquire", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const runDir = await createMockRegisteredRun(repoDir, "run-cand-valf");

    const lockPath = join(runDir, ".run.lock");
    const probePath = join(runDir, ".probe-cv");
    const probeHandle = await (await import("node:fs/promises")).open(probePath, "w");
    const proto = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    await rm(probePath, { force: true });

    const originalSync = proto.sync;
    let failOnce = true;
    proto.sync = async function (...args: unknown[]) {
      await originalSync.apply(this, args);
      if (failOnce) {
        failOnce = false;
        // Corrupt candidate content so candidate validation fails on re-read
        await (this as { truncate: (len: number) => Promise<void> }).truncate(0);
        await (this as { write: (str: string, pos: number) => Promise<unknown> }).write("{ corrupted json", 0);
      }
    };

    try {
      await assert.rejects(
        async () => {
          await store.acquireRunLock(runDir);
        },
        (err: unknown) =>
          err instanceof ConcurrentRunUpdateError &&
          (err as Error).message.includes("Failed to write lock metadata")
      );

      // Verify no main lock exists and candidate is unlinked
      assert.equal(existsSync(lockPath), false, "Main lock must not exist upon candidate validation failure");
      const files = await readdir(runDir);
      assert.ok(!files.some((f) => f.startsWith(".run.lock.candidate.")), "Candidate file must be cleaned up");

      // Next acquire succeeds cleanly
      const acquired = await store.acquireRunLock(runDir);
      assert.ok(acquired.ownerId);
      assert.equal(existsSync(lockPath), true);
      await store.releaseRunLock(runDir, acquired.ownerId);
    } finally {
      proto.sync = originalSync;
    }
  } finally {
    await cleanup();
  }
});

// --- STALE LOCK DECISION D TESTS ---

test("139. R2F1-R4 Stale Lock: comprehensive Decision D verification (untouched, error, zero entry, no auxiliary files)", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store1 = new RuntimeArtifactStore({ repoDir });
    const store2 = new RuntimeArtifactStore({ repoDir });
    const runDir = await createMockRegisteredRun(repoDir, "run-stale-comp");

    const deadPid = 9999998;
    const lockPath = join(runDir, ".run.lock");
    const initialMetadata = {
      pid: deadPid,
      hostname: (await import("node:os")).hostname(),
      createdAt: new Date().toISOString(),
      ownerId: "stale-dead-comp",
    };
    await writeFile(lockPath, JSON.stringify(initialMetadata), "utf8");

    // Both processes face stale lock concurrently
    const [res1, res2] = await Promise.allSettled([
      store1.acquireRunLock(runDir),
      store2.acquireRunLock(runDir),
    ]);

    // Zero entry
    assert.equal(res1.status, "rejected");
    assert.equal(res2.status, "rejected");

    // STALE_RUN_LOCK_REQUIRES_RECONCILIATION
    const err1 = (res1 as PromiseRejectedResult).reason;
    const err2 = (res2 as PromiseRejectedResult).reason;
    assert.ok(err1 instanceof StaleRunLockError && err1.message.includes("STALE_RUN_LOCK_REQUIRES_RECONCILIATION"));
    assert.ok(err2 instanceof StaleRunLockError && err2.message.includes("STALE_RUN_LOCK_REQUIRES_RECONCILIATION"));

    // Main lock remains completely untouched
    const currentMeta = JSON.parse(await readFile(lockPath, "utf8"));
    assert.deepEqual(currentMeta, initialMetadata);

    // No stale or recovery files created
    const allFiles = await readdir(runDir);
    assert.ok(!allFiles.some((f) => f.includes(".run.lock.stale")), "No .run.lock.stale.* files created");
    assert.ok(!allFiles.includes(".run.lock.recovery"), "No .run.lock.recovery file created");
  } finally {
    await cleanup();
  }
});

// =========================================================================
// R2F2 Gated Tests (Tests 140 to 172)
// Covering R2-03 (Closure), R2-04 (Baseline/Upstream), R2-06 (Scope), R2-09 (Pause/Resume)
// =========================================================================

// --- COMMITTED CLOSURE ---

test("140. R2F2-R2-03 Committed Closure: uncommitted fake CLOSED closure in working tree is NOT committed closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    // Write fake closeout in working tree without committing
    const taskDir = join(repoDir, ".agent", "tasks", "UNCOMMITTED-TASK", "artifacts");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, "closeout.json"),
      JSON.stringify({ taskId: "UNCOMMITTED-TASK", status: "CLOSED" }, null, 2),
      "utf8"
    );

    // Also write task spec in working tree
    await writeFile(
      join(repoDir, ".agent", "tasks", "UNCOMMITTED-TASK", "task.json"),
      JSON.stringify({ taskId: "UNCOMMITTED-TASK", status: "READY", branch: "main" }, null, 2),
      "utf8"
    );

    // .agent/current.json points to UNCOMMITTED-TASK
    await writeFile(
      join(repoDir, ".agent", "current.json"),
      JSON.stringify({ task: "UNCOMMITTED-TASK", status: "READY", branch: "main" }, null, 2),
      "utf8"
    );

    const closureFact = readCommittedClosure("UNCOMMITTED-TASK", repoDir);
    assert.equal(closureFact.isClosed, false, "Committed closure from HEAD must not see uncommitted file");

    const result = await reconcileCurrentState({ repoDir });
    assert.equal(result.taskAlreadyClosed, false, "Reconcile must NOT report taskAlreadyClosed for uncommitted closure");
    assert.notEqual(result.resolvedStatus, "CLOSED");
  } finally {
    await cleanup();
  }
});

test("141. R2F2-R2-03 Committed Closure: committed valid closure is recognized from HEAD", async () => {
  const { repoDir, initialCommit, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const taskDir = join(repoDir, ".agent", "tasks", "COMMITTED-TASK", "artifacts");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, "closeout.json"),
      JSON.stringify({
        runId: "run-committed-task",
        taskId: "COMMITTED-TASK",
        status: "CLOSED",
        finalTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        finalGate: "PASS",
        closedAt: new Date().toISOString(),
      }, null, 2),
      "utf8"
    );
    await writeFile(
      join(repoDir, ".agent", "tasks", "COMMITTED-TASK", "task.json"),
      JSON.stringify({ taskId: "COMMITTED-TASK", status: "CLOSED", branch: "main", baseCommit: initialCommit, allowedScope: ["src/"] }, null, 2),
      "utf8"
    );
    git(["add", "."]);
    git(["commit", "-m", "chore: commit valid closeout"]);
    git(["push", "-u", "-q", "origin", "main"]);

    const closureFact = readCommittedClosure("COMMITTED-TASK", repoDir);
    assert.equal(closureFact.isClosed, true);
    assert.equal(closureFact.closureData?.status, "CLOSED");

    await writeFile(
      join(repoDir, ".agent", "current.json"),
      JSON.stringify({ task: "COMMITTED-TASK", status: "READY", branch: "main" }, null, 2),
      "utf8"
    );

    const result = await reconcileCurrentState({ repoDir, taskId: "COMMITTED-TASK" });
    assert.equal(result.taskAlreadyClosed, true);
    assert.equal(result.resolvedStatus, "CLOSED");
  } finally {
    await cleanup();
  }
});

test("142. R2F2-R2-03 Committed Closure: committed closure + working tree edited -> committed fact remains from HEAD", async () => {
  const { repoDir, initialCommit, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const taskDir = join(repoDir, ".agent", "tasks", "EDITED-TASK", "artifacts");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, "closeout.json"),
      JSON.stringify({
        runId: "run-edited-task",
        taskId: "EDITED-TASK",
        status: "CLOSED",
        finalTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        finalGate: "PASS",
        closedAt: new Date().toISOString(),
      }, null, 2),
      "utf8"
    );
    await writeFile(
      join(repoDir, ".agent", "tasks", "EDITED-TASK", "task.json"),
      JSON.stringify({ taskId: "EDITED-TASK", status: "READY", branch: "main" }, null, 2),
      "utf8"
    );
    git(["add", "."]);
    git(["commit", "-m", "chore: commit closeout for EDITED-TASK"]);
    git(["push", "-u", "-q", "origin", "main"]);

    // Working tree edits closeout to OPEN / READY
    await writeFile(
      join(taskDir, "closeout.json"),
      JSON.stringify({ taskId: "EDITED-TASK", status: "READY" }, null, 2),
      "utf8"
    );

    // Committed authority still reads HEAD: isClosed is true!
    const closureFact = readCommittedClosure("EDITED-TASK", repoDir);
    assert.equal(closureFact.isClosed, true, "Committed closure fact must remain from HEAD despite working tree edit");

    // But working tree edit is dirty and must be tracked
    const status = execFileSync("git", ["status", "--porcelain=v1"], { cwd: repoDir, encoding: "utf8" });
    assert.ok(status.includes("closeout.json"), "Working tree modification must be tracked as dirty");
  } finally {
    await cleanup();
  }
});

test("143. R2F2-R2-03 Committed Closure: committed closure + working tree deleted -> committed fact remains from HEAD but dirty deletion separately detected", async () => {
  const { repoDir, initialCommit, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const taskDir = join(repoDir, ".agent", "tasks", "DELETED-TASK", "artifacts");
    await mkdir(taskDir, { recursive: true });
    const closeoutPath = join(taskDir, "closeout.json");
    await writeFile(
      closeoutPath,
      JSON.stringify({
        runId: "run-deleted-task",
        taskId: "DELETED-TASK",
        status: "CLOSED",
        finalTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        finalGate: "PASS",
        closedAt: new Date().toISOString(),
      }, null, 2),
      "utf8"
    );
    await writeFile(
      join(repoDir, ".agent", "tasks", "DELETED-TASK", "task.json"),
      JSON.stringify(
        {
          taskId: "DELETED-TASK",
          status: "READY",
          branch: "main",
          baseCommit: initialCommit,
          allowedScope: ["src/"],
        },
        null,
        2
      ),
      "utf8"
    );
    git(["add", "."]);
    git(["commit", "-m", "chore: commit closeout for DELETED-TASK"]);
    git(["push", "-u", "-q", "origin", "main"]);

    // Delete working tree file
    await rm(closeoutPath);

    // Committed fact still reads HEAD
    const closureFact = readCommittedClosure("DELETED-TASK", repoDir);
    assert.equal(closureFact.isClosed, true, "Committed fact must remain from HEAD");

    // Reconcile flags dirty deletion
    await writeFile(
      join(repoDir, ".agent", "current.json"),
      JSON.stringify({ task: "DELETED-TASK", status: "CLOSED", branch: "main" }, null, 2),
      "utf8"
    );
    const result = await reconcileCurrentState({ repoDir, taskId: "DELETED-TASK" });
    assert.equal(result.taskAlreadyClosed, true);
    assert.equal(result.stopReason, CindyState.DIRTY_TREE_UNEXPLAINED);
    assert.ok(result.stopExplanation?.includes("closeout.json"));
  } finally {
    await cleanup();
  }
});

test("144. R2F2-R2-03 Committed Closure: malformed committed closure fails closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const taskDir = join(repoDir, ".agent", "tasks", "CORRUPT-TASK", "artifacts");
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, "closeout.json"), "{ invalid JSON content", "utf8");
    git(["add", "."]);
    git(["commit", "-m", "chore: commit malformed closeout"]);
    git(["push", "-u", "-q", "origin", "main"]);

    assert.throws(
      () => readCommittedClosure("CORRUPT-TASK", repoDir),
      (err: unknown) => err instanceof ArtifactValidationError
    );

    await writeFile(
      join(repoDir, ".agent", "current.json"),
      JSON.stringify({ task: "CORRUPT-TASK", status: "READY", branch: "main" }, null, 2),
      "utf8"
    );

    const result = await reconcileCurrentState({ repoDir, taskId: "CORRUPT-TASK" });
    assert.equal(result.reconciled, false);
    assert.equal(result.stopReason, CindyState.CONTRACT_CONFLICT);
  } finally {
    await cleanup();
  }
});

test("145. R2F2-R2-03 Committed Closure: wrong taskId committed closure fails closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const taskDir = join(repoDir, ".agent", "tasks", "TASK-TARGET", "artifacts");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, "closeout.json"),
      JSON.stringify({ taskId: "TASK-IMPOSTOR", status: "CLOSED" }, null, 2),
      "utf8"
    );
    git(["add", "."]);
    git(["commit", "-m", "chore: commit mismatched closeout"]);
    git(["push", "-u", "-q", "origin", "main"]);

    assert.throws(
      () => readCommittedClosure("TASK-TARGET", repoDir),
      (err: unknown) => err instanceof ArtifactValidationError && err.message.includes("taskId mismatch")
    );
  } finally {
    await cleanup();
  }
});

// --- BASELINE ---

test("146. R2F2-R2-04 Baseline: caller base != actual/task base is rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "run-wrong-base",
          taskId: "CINDY-ORCH-MVP",
          baseCommit: "0000000000000000000000000000000000000000",
          branch: "main",
        });
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );
  } finally {
    await cleanup();
  }
});

test("147. R2F2-R2-04 Baseline: HEAD != committed Task baseline is rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const taskDir = join(repoDir, ".agent", "tasks", "TASK-DRIFT");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, "task.json"),
      JSON.stringify({
        taskId: "TASK-DRIFT",
        branch: "main",
        baseCommit: "0000000000000000000000000000000000000000",
        allowedScope: ["src/"],
      }, null, 2),
      "utf8"
    );
    git(["add", "."]);
    git(["commit", "-m", "chore: commit task with drifted base"]);
    git(["push", "-u", "-q", "origin", "main"]);

    const orchestrator = new CindyOrchestrator({ repoDir });
    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "run-drift-task",
          taskId: "TASK-DRIFT",
        });
      },
      (err: unknown) => err instanceof TransitionRejectedError && err.message.includes("committed Task baseline")
    );
  } finally {
    await cleanup();
  }
});

test("148. R2F2-R2-04 Baseline: correct HEAD is accepted", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const currentHead = git(["rev-parse", "HEAD"]).trim();
    const taskDir = join(repoDir, ".agent", "tasks", "TASK-CORRECT-BASE");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, "task.json"),
      JSON.stringify({
        taskId: "TASK-CORRECT-BASE",
        branch: "main",
        baseCommit: currentHead,
        allowedScope: ["src/"],
      }, null, 2),
      "utf8"
    );
    git(["add", "."]);
    git(["commit", "-m", "chore: commit task with matching base"]);
    git(["push", "-u", "-q", "origin", "main"]);

    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-correct-base",
      taskId: "TASK-CORRECT-BASE",
      baseCommit: currentHead,
    });

    assert.equal(run.state, CindyState.TASK_INITIALIZED);
    assert.equal(run.stopReason, null);
    assert.equal(run.baseCommit, currentHead);
  } finally {
    await cleanup();
  }
});

test("149. R2F2-R2-04 Baseline: caller cannot override authoritative branch/base", async () => {
  const { repoDir, initialCommit, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const taskDir = join(repoDir, ".agent", "tasks", "TASK-AUTH-OVERRIDE");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, "task.json"),
      JSON.stringify({
        taskId: "TASK-AUTH-OVERRIDE",
        branch: "main",
        baseCommit: initialCommit,
        allowedScope: ["src/"],
      }, null, 2),
      "utf8"
    );
    git(["add", "."]);
    git(["commit", "-m", "chore: commit auth task"]);
    git(["push", "-u", "-q", "origin", "main"]);

    const head = git(["rev-parse", "HEAD"]).trim();
    await writeFile(
      join(taskDir, "task.json"),
      JSON.stringify({
        taskId: "TASK-AUTH-OVERRIDE",
        branch: "main",
        baseCommit: head,
        allowedScope: ["src/"],
      }, null, 2),
      "utf8"
    );
    git(["add", "."]);
    git(["commit", "-m", "chore: set head"]);
    git(["push", "-u", "-q", "origin", "main"]);

    const orchestrator = new CindyOrchestrator({ repoDir });

    // Caller cannot override branch
    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "run-over-branch",
          taskId: "TASK-AUTH-OVERRIDE",
          branch: "malicious-branch",
        });
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );

    // Caller cannot override baseCommit
    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "run-over-base",
          taskId: "TASK-AUTH-OVERRIDE",
          baseCommit: "1111111111111111111111111111111111111111",
        });
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );
  } finally {
    await cleanup();
  }
});

// --- UPSTREAM ---

test("150. R2F2-R2-04 Upstream: missing upstream enters GIT_SAFETY_STOP", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    git(["branch", "--unset-upstream"]);
    git(["remote", "remove", "origin"]);

    assert.equal(getGitUpstream(repoDir), null);

    const orchestrator = new CindyOrchestrator({ repoDir });

    // Under Decision J preflight, initRun rejects upfront without writing to disk
    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "run-missing-up",
          taskId: "TEST-NO-UP",
        });
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        err.message.includes("UPSTREAM_MISSING")
    );

    // No run was written to disk
    const activeRuns = await orchestrator.artifactStore.resolveAllActiveRuns();
    assert.equal(activeRuns.length, 0);

    const reconcileResult = await reconcileCurrentState({ repoDir, taskId: "TEST-NO-UP" });
    assert.equal(reconcileResult.stopReason, CindyState.GIT_SAFETY_STOP);
    assert.equal(reconcileResult.detailedStopReason, CindyStopReason.UPSTREAM_MISSING);
  } finally {
    await cleanup();
  }
});

test("151. R2F2-R2-04 Upstream: upstream present and expected passes", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const up = getGitUpstream(repoDir);
    assert.ok(up !== null && up.commit.length === 40);

    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-valid-up",
      taskId: "TEST-VALID-UP",
    });

    assert.equal(run.state, CindyState.TASK_INITIALIZED);
    assert.equal(run.stopReason, null);
    assert.equal(run.upstreamSha, up.commit);
  } finally {
    await cleanup();
  }
});

test("152. R2F2-R2-04 Upstream: upstream SHA drifts after init causes reconcile to pause", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const upBefore = getGitUpstream(repoDir)!;

    // Simulate remote advance by pushing another commit from a separate clone
    const otherDir = await mkdtemp(join(tmpdir(), "cindy-other-clone-"));
    try {
      execFileSync("git", ["clone", "-b", "main", git(["config", "--get", "remote.origin.url"]).trim(), otherDir], { encoding: "utf8" });
      execFileSync("git", ["config", "user.name", "Other Dev"], { cwd: otherDir });
      execFileSync("git", ["config", "user.email", "other@example.com"], { cwd: otherDir });
      await writeFile(join(otherDir, "remote-file.txt"), "hello from remote", "utf8");
      execFileSync("git", ["add", "."], { cwd: otherDir });
      execFileSync("git", ["commit", "-m", "feat: remote change"], { cwd: otherDir });
      execFileSync("git", ["push", "-q", "origin", "main"], { cwd: otherDir });
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }

    // Local fetches upstream
    git(["fetch", "-q", "origin"]);

    const upAfter = getGitUpstream(repoDir)!;
    assert.notEqual(upBefore.commit, upAfter.commit, "Upstream commit should have drifted");

    // Reconcile checking against original upstream SHA pauses with GIT_SAFETY_STOP
    const result = await reconcileCurrentState({ repoDir, taskId: "CINDY-ORCH-MVP", expectedUpstreamSha: upBefore.commit });
    assert.equal(result.stopReason, CindyState.GIT_SAFETY_STOP);
    assert.ok(result.stopExplanation?.includes("Upstream drift detected"));
  } finally {
    await cleanup();
  }
});

test("153. R2F2-R2-04 Upstream: no automatic pull/rebase/merge when upstream drifts", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const headBefore = git(["rev-parse", "HEAD"]).trim();

    const orchestrator = new CindyOrchestrator({ repoDir });
    await orchestrator.initRun({ runId: "run-no-pull", taskId: "TEST-NO-PULL" });

    // Run reconcile with drifted expected SHA
    await reconcileCurrentState({ repoDir, expectedUpstreamSha: "0000000000000000000000000000000000000000" });

    const headAfter = git(["rev-parse", "HEAD"]).trim();
    assert.equal(headBefore, headAfter, "Local HEAD must not be modified by reconcile; no automatic pull/merge/rebase");
  } finally {
    await cleanup();
  }
});

// --- DIRTY / SCOPE ---

test("154. R2F2-R2-06 Scope: scope=[] + clean tree passes", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-scope-clean",
      taskId: "TEST-SCOPE-CLEAN",
      allowedScope: [],
    });

    assert.equal(run.state, CindyState.TASK_INITIALIZED);
    assert.equal(run.stopReason, null);
  } finally {
    await cleanup();
  }
});

test("155. R2F2-R2-06 Scope: scope=[] + dirty tree fails closed to DIRTY_TREE_UNEXPLAINED", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    await writeFile(join(repoDir, "unauthorized.txt"), "dirty content", "utf8");

    const orchestrator = new CindyOrchestrator({ repoDir });
    // Under Decision J preflight, initRun rejects upfront if working tree is dirty
    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "run-scope-dirty",
          taskId: "TEST-SCOPE-DIRTY",
          allowedScope: [],
        });
      },
      (err: unknown) =>
        err instanceof DirtyTreeUnexplainedError &&
        (err as DirtyTreeUnexplainedError).unexplainedFiles.includes("unauthorized.txt")
    );

    // No run was written to disk
    const activeRuns = await orchestrator.artifactStore.resolveAllActiveRuns();
    assert.equal(activeRuns.length, 0);
  } finally {
    await cleanup();
  }
});

test("156. R2F2-R2-06 Scope: ../ scope is rejected fail closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "run-traversal-scope",
          taskId: "TEST-TRAVERSAL",
          allowedScope: ["../escape"],
        });
      },
      (err: unknown) => err instanceof PathTraversalError
    );

    assert.throws(
      () => checkDirtyTreeOwnership(["../../escape"], []),
      (err: unknown) => err instanceof PathTraversalError
    );
  } finally {
    await cleanup();
  }
});

test("157. R2F2-R2-06 Scope: absolute scope is rejected fail closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "run-abs-scope",
          taskId: "TEST-ABS",
          allowedScope: ["/etc/passwd"],
        });
      },
      (err: unknown) => err instanceof PathTraversalError
    );

    assert.throws(
      () => checkDirtyTreeOwnership(["/var/data"], []),
      (err: unknown) => err instanceof PathTraversalError
    );
  } finally {
    await cleanup();
  }
});

test("158. R2F2-R2-06 Scope: prefix collision rejected (tools/cindy must not own tools/cindy-malicious/a.ts)", async () => {
  const allowedWithoutSlash = ["tools/cindy"];
  const res1 = checkDirtyTreeOwnership(allowedWithoutSlash, ["tools/cindy-malicious/a.ts"]);
  assert.equal(res1.ok, false);
  assert.deepEqual(res1.unexplainedFiles, ["tools/cindy-malicious/a.ts"]);

  const allowedWithSlash = ["tools/cindy/"];
  const res2 = checkDirtyTreeOwnership(allowedWithSlash, ["tools/cindy-malicious/a.ts"]);
  assert.equal(res2.ok, false);
  assert.deepEqual(res2.unexplainedFiles, ["tools/cindy-malicious/a.ts"]);

  // But genuine subpaths are owned
  const res3 = checkDirtyTreeOwnership(allowedWithoutSlash, ["tools/cindy/a.ts"]);
  assert.equal(res3.ok, true);
  assert.equal(res3.unexplainedFiles.length, 0);

  const res4 = checkDirtyTreeOwnership(allowedWithSlash, ["tools/cindy/a.ts"]);
  assert.equal(res4.ok, true);
  assert.equal(res4.unexplainedFiles.length, 0);
});

test("159. R2F2-R2-06 Scope: authorized nested path is accepted", async () => {
  const allowed = ["tools/cindy/"];
  const res = checkDirtyTreeOwnership(allowed, [
    "tools/cindy/sub/nested/file.ts",
    "tools/cindy/deep/path/to/another/file.json",
  ]);
  assert.equal(res.ok, true);
  assert.equal(res.unexplainedFiles.length, 0);
});

test("160. R2F2-R2-06 Scope: untracked file outside scope is rejected", async () => {
  const allowed = ["tools/cindy/"];
  const res = checkDirtyTreeOwnership(allowed, [
    "tools/cindy/safe.ts",
    "untracked-rogue.txt",
  ]);
  assert.equal(res.ok, false);
  assert.deepEqual(res.unexplainedFiles, ["untracked-rogue.txt"]);
});

test("161. R2F2-R2-06 Scope: deleted file outside scope is rejected", async () => {
  const allowed = ["tools/cindy/"];
  const res = checkDirtyTreeOwnership(allowed, [
    "deleted-critical-file.txt",
  ]);
  assert.equal(res.ok, false);
  assert.deepEqual(res.unexplainedFiles, ["deleted-critical-file.txt"]);
});

test("162. R2F2-R2-06 Scope: rename old outside / new inside is rejected", async () => {
  const allowed = ["tools/cindy/"];
  const res = checkDirtyTreeOwnership(allowed, [
    "tools/cindy/new-file.ts",
    "old-outside-repo-file.ts",
  ]);
  assert.equal(res.ok, false);
  assert.deepEqual(res.unexplainedFiles, ["old-outside-repo-file.ts"]);
});

test("163. R2F2-R2-06 Scope: rename old+new both inside scope is accepted", async () => {
  const allowed = ["tools/cindy/"];
  const res = checkDirtyTreeOwnership(allowed, [
    "tools/cindy/new-name.ts",
    "tools/cindy/old-name.ts",
  ]);
  assert.equal(res.ok, true);
  assert.equal(res.unexplainedFiles.length, 0);
});

test("164. R2F2-R2-06 Scope: CLI / caller cannot broaden committed task scope", async () => {
  const { repoDir, baseCommit, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const taskDir = join(repoDir, ".agent", "tasks", "TASK-NARROW-SCOPE");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, "task.json"),
      JSON.stringify({
        taskId: "TASK-NARROW-SCOPE",
        branch: "main",
        baseCommit: baseCommit,
        allowedScope: ["tools/cindy/"],
      }, null, 2),
      "utf8"
    );
    git(["add", "."]);
    git(["commit", "-m", "chore: commit narrow task"]);
    git(["push", "-u", "-q", "origin", "main"]);

    const orchestrator = new CindyOrchestrator({ repoDir });

    // Caller passes broader scope ["tools/", "tests/"]
    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "run-broaden",
          taskId: "TASK-NARROW-SCOPE",
          allowedScope: ["tools/", "tests/"],
        });
      },
      (err: unknown) => err instanceof TransitionRejectedError && err.message.includes("broaden")
    );
  } finally {
    await cleanup();
  }
});

// --- PAUSE / RESUME ---

test("165. R2F2-R2-09 Pause/Resume: PRODUCT_DECISION_REQUIRED cannot generic-transition to BUILDING", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-pause-1", taskId: "TEST-P1" });

    // Enter pause state
    await orchestrator.transition(run.runId, CindyState.PRODUCT_DECISION_REQUIRED);

    // Direct generic transition forward is rejected
    await assert.rejects(
      async () => {
        await orchestrator.transition(run.runId, CindyState.BUILDING);
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );

    // Cannot transition to READY_TO_COMMIT
    await assert.rejects(
      async () => {
        await orchestrator.transition(run.runId, CindyState.READY_TO_COMMIT);
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );
  } finally {
    await cleanup();
  }
});

test("166. R2F2-R2-09 Pause/Resume: DIRTY_TREE_UNEXPLAINED cannot generic-transition to BUILDING", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-pause-2", taskId: "TEST-P2" });

    const rogue = join(repoDir, "rogue-166.txt");
    await writeFile(rogue, "dirty", "utf8");
    await orchestrator.deriveSafetyStop(run.runId);

    await assert.rejects(
      async () => {
        await orchestrator.transition(run.runId, CindyState.BUILDING);
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );
  } finally {
    await cleanup();
  }
});

test("167. R2F2-R2-09 Pause/Resume: GIT_SAFETY_STOP cannot generic-transition forward", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-pause-3", taskId: "TEST-P3" });

    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    await writeFile(join(repoDir, "drift-167.txt"), "drift\n", "utf8");
    git(["add", "drift-167.txt"]);
    git(["commit", "-m", "chore: drift 167"]);
    await orchestrator.deriveSafetyStop(run.runId);

    await assert.rejects(
      async () => {
        await orchestrator.transition(run.runId, CindyState.BUILDING);
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );

    await assert.rejects(
      async () => {
        await orchestrator.transition(run.runId, CindyState.READY_TO_COMMIT);
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );
  } finally {
    await cleanup();
  }
});

test("168. R2F2-R2-09 Pause/Resume: pause -> RECONCILING only through explicit resume operation", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-pause-4", taskId: "TEST-P4" });

    await orchestrator.transition(run.runId, CindyState.BLOCKED);

    // Direct generic transition to RECONCILING is rejected
    await assert.rejects(
      async () => {
        await orchestrator.transition(run.runId, CindyState.RECONCILING);
      },
      (err: unknown) => err instanceof TransitionRejectedError && err.message.includes("controlled resumeRun")
    );
  } finally {
    await cleanup();
  }
});

test("169. R2F2-R2-09 Pause/Resume: dirty cause persists -> remains paused", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-pause-persist-dirty",
      taskId: "TEST-P5",
      allowedScope: ["src/"],
    });

    assert.equal(run.state, CindyState.TASK_INITIALIZED);

    // Create rogue dirty file and pause run to DIRTY_TREE_UNEXPLAINED
    const rogueFile = join(repoDir, "rogue.txt");
    await writeFile(rogueFile, "dirty", "utf8");

    await orchestrator.deriveSafetyStop(run.runId);

    // Rogue file persists
    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.DIRTY_TREE_UNEXPLAINED);
    assert.equal(resumed.stopReason, CindyStopReason.DIRTY_TREE_UNEXPLAINED);
  } finally {
    await cleanup();
  }
});

test("170. R2F2-R2-09 Pause/Resume: dirty cause resolved -> controlled resume succeeds", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-pause-resolved-dirty",
      taskId: "TEST-P6",
      allowedScope: ["src/"],
    });

    assert.equal(run.state, CindyState.TASK_INITIALIZED);

    // Create rogue dirty file and pause run to DIRTY_TREE_UNEXPLAINED
    const rogueFile = join(repoDir, "rogue.txt");
    await writeFile(rogueFile, "dirty", "utf8");

    await orchestrator.deriveSafetyStop(run.runId);

    // Clean up dirty cause
    await rm(rogueFile);

    // Resume succeeds back to TASK_INITIALIZED
    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.TASK_INITIALIZED);
    assert.equal(resumed.stopReason, null);
    assert.equal(resumed.pausedFrom, null);
  } finally {
    await cleanup();
  }
});

test("171. R2F2-R2-09 Pause/Resume: upstream cause persists -> remains paused", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-pause-persist-up",
      taskId: "TEST-P7",
    });

    assert.equal(run.state, CindyState.TASK_INITIALIZED);

    // Simulate upstream breaking after init
    git(["branch", "--unset-upstream"]);
    git(["remote", "remove", "origin"]);

    await orchestrator.deriveSafetyStop(run.runId);

    // Upstream still missing
    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.GIT_SAFETY_STOP);
    assert.equal(resumed.stopReason, CindyStopReason.UPSTREAM_MISSING);
  } finally {
    await cleanup();
  }
});

test("172. R2F2-R2-09 Pause/Resume: product decision without approved structured fact -> remains paused", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-pause-pd",
      taskId: "CINDY-ORCH-MVP",
    });

    // Enter PRODUCT_DECISION_REQUIRED
    await orchestrator.transition(run.runId, CindyState.PRODUCT_DECISION_REQUIRED, {
      stopReason: CindyStopReason.PRODUCT_DECISION_REQUIRED,
    });

    // Resume attempt without approved product decision in committed task packet remains paused
    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.PRODUCT_DECISION_REQUIRED);
    assert.equal(resumed.stopReason, CindyStopReason.PRODUCT_DECISION_REQUIRED);
  } finally {
    await cleanup();
  }
});

// =========================================================================
// R2F2-R1: 36 Robustness and Authority Closure Tests (Tests 173 - 208)
// =========================================================================

// --- Finding 1: R2-03 Closeout Schema Validation & Fail-Closed (173 - 181) ---

test("173. R2F2-R1 F1: committed closeout missing required fields (only taskRef) throws InvalidCommittedClosureError", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const closeoutDir = join(repoDir, ".agent", "tasks", "TEST-C1", "artifacts");
    await mkdir(closeoutDir, { recursive: true });
    await writeFile(join(closeoutDir, "closeout.json"), JSON.stringify({ taskRef: "TEST-C1" }), "utf8");
    git(["add", "."]);
    git(["commit", "-m", "chore: partial closeout"]);

    assert.throws(
      () => readCommittedClosure("TEST-C1", repoDir),
      (err: unknown) => err instanceof InvalidCommittedClosureError
    );
  } finally {
    await cleanup();
  }
});

test("174. R2F2-R1 F1: committed closeout missing runId throws InvalidCommittedClosureError", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const closeoutDir = join(repoDir, ".agent", "tasks", "TEST-C2", "artifacts");
    await mkdir(closeoutDir, { recursive: true });
    await writeFile(
      join(closeoutDir, "closeout.json"),
      JSON.stringify({
        taskId: "TEST-C2",
        status: "CLOSED",
        finalTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        finalGate: "PASS",
        closedAt: "2026-09-28T00:00:00.000Z",
      }),
      "utf8"
    );
    git(["add", "."]);
    git(["commit", "-m", "chore: closeout without runId"]);

    assert.throws(
      () => readCommittedClosure("TEST-C2", repoDir),
      (err: unknown) => err instanceof InvalidCommittedClosureError
    );
  } finally {
    await cleanup();
  }
});

test("175. R2F2-R1 F1: committed closeout missing finalTreeDigest throws InvalidCommittedClosureError", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const closeoutDir = join(repoDir, ".agent", "tasks", "TEST-C3", "artifacts");
    await mkdir(closeoutDir, { recursive: true });
    await writeFile(
      join(closeoutDir, "closeout.json"),
      JSON.stringify({
        runId: "run-c3",
        taskId: "TEST-C3",
        status: "CLOSED",
        finalGate: "PASS",
        closedAt: "2026-09-28T00:00:00.000Z",
      }),
      "utf8"
    );
    git(["add", "."]);
    git(["commit", "-m", "chore: closeout without finalTreeDigest"]);

    assert.throws(
      () => readCommittedClosure("TEST-C3", repoDir),
      (err: unknown) => err instanceof InvalidCommittedClosureError
    );
  } finally {
    await cleanup();
  }
});

test("176. R2F2-R1 F1: committed closeout missing finalGate throws InvalidCommittedClosureError", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const closeoutDir = join(repoDir, ".agent", "tasks", "TEST-C4", "artifacts");
    await mkdir(closeoutDir, { recursive: true });
    await writeFile(
      join(closeoutDir, "closeout.json"),
      JSON.stringify({
        runId: "run-c4",
        taskId: "TEST-C4",
        status: "CLOSED",
        finalTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        closedAt: "2026-09-28T00:00:00.000Z",
      }),
      "utf8"
    );
    git(["add", "."]);
    git(["commit", "-m", "chore: closeout without finalGate"]);

    assert.throws(
      () => readCommittedClosure("TEST-C4", repoDir),
      (err: unknown) => err instanceof InvalidCommittedClosureError
    );
  } finally {
    await cleanup();
  }
});

test("177. R2F2-R1 F1: committed closeout missing closedAt throws InvalidCommittedClosureError", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const closeoutDir = join(repoDir, ".agent", "tasks", "TEST-C5", "artifacts");
    await mkdir(closeoutDir, { recursive: true });
    await writeFile(
      join(closeoutDir, "closeout.json"),
      JSON.stringify({
        runId: "run-c5",
        taskId: "TEST-C5",
        status: "CLOSED",
        finalTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        finalGate: "PASS",
      }),
      "utf8"
    );
    git(["add", "."]);
    git(["commit", "-m", "chore: closeout without closedAt"]);

    assert.throws(
      () => readCommittedClosure("TEST-C5", repoDir),
      (err: unknown) => err instanceof InvalidCommittedClosureError
    );
  } finally {
    await cleanup();
  }
});

test("178. R2F2-R1 F1: committed closeout with malformed JSON blob in Git throws InvalidCommittedClosureError", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const closeoutDir = join(repoDir, ".agent", "tasks", "TEST-C6", "artifacts");
    await mkdir(closeoutDir, { recursive: true });
    await writeFile(join(closeoutDir, "closeout.json"), "{ invalid: json... ", "utf8");
    git(["add", "."]);
    git(["commit", "-m", "chore: malformed closeout"]);

    assert.throws(
      () => readCommittedClosure("TEST-C6", repoDir),
      (err: unknown) => err instanceof InvalidCommittedClosureError
    );
  } finally {
    await cleanup();
  }
});

test("179. R2F2-R1 F1: committed closeout with taskId mismatching current task throws InvalidCommittedClosureError", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const closeoutDir = join(repoDir, ".agent", "tasks", "TEST-C7", "artifacts");
    await mkdir(closeoutDir, { recursive: true });
    await writeFile(
      join(closeoutDir, "closeout.json"),
      JSON.stringify({
        runId: "run-c7",
        taskId: "DIFFERENT-TASK-ID",
        status: "CLOSED",
        finalTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        finalGate: "PASS",
        closedAt: "2026-09-28T00:00:00.000Z",
      }),
      "utf8"
    );
    git(["add", "."]);
    git(["commit", "-m", "chore: taskId mismatch closeout"]);

    assert.throws(
      () => readCommittedClosure("TEST-C7", repoDir),
      (err: unknown) => err instanceof InvalidCommittedClosureError
    );
  } finally {
    await cleanup();
  }
});

test("180. R2F2-R1 F1: committed closeout complete and valid returns CommittedClosureResult isClosed true", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const closeoutDir = join(repoDir, ".agent", "tasks", "TEST-C8", "artifacts");
    await mkdir(closeoutDir, { recursive: true });
    const validPayload = {
      runId: "run-c8",
      taskId: "TEST-C8",
      status: "CLOSED",
      finalTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      finalGate: "PASS",
      closedAt: "2026-09-28T00:00:00.000Z",
    };
    await writeFile(join(closeoutDir, "closeout.json"), JSON.stringify(validPayload, null, 2), "utf8");
    git(["add", "."]);
    git(["commit", "-m", "chore: valid closeout"]);

    const res = readCommittedClosure("TEST-C8", repoDir);
    assert.equal(res.isClosed, true);
    assert.equal(res.closureData?.status, "CLOSED");
    assert.equal(res.closureData?.taskId, "TEST-C8");
  } finally {
    await cleanup();
  }
});

test("181. R2F2-R1 F1: uncommitted fake closeout.json in working tree when HEAD has no closeout returns isClosed false", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const closeoutDir = join(repoDir, ".agent", "tasks", "TEST-C9", "artifacts");
    await mkdir(closeoutDir, { recursive: true });
    const fakePayload = {
      runId: "run-c9-fake",
      taskId: "TEST-C9",
      status: "CLOSED",
      finalTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      finalGate: "PASS",
      closedAt: "2026-09-28T00:00:00.000Z",
    };
    await writeFile(join(closeoutDir, "closeout.json"), JSON.stringify(fakePayload, null, 2), "utf8");

    const res = readCommittedClosure("TEST-C9", repoDir);
    assert.equal(res.isClosed, false);
    assert.equal(res.closureData, undefined);
  } finally {
    await cleanup();
  }
});

// --- Finding 3 & Scope: Task Packet Authority (182 - 185) ---

test("182. R2F2-R1 F3: HEAD has no task.json, caller provides scope/baseCommit to initRun throws TaskPacketNotCommittedError", async () => {
  const { repoDir, initialCommit, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "run-no-task",
          taskId: "NON_EXISTENT_TASK_XYZ",
          allowedScope: ["src/"],
          baseCommit: initialCommit,
        });
      },
      (err: unknown) => err instanceof TaskPacketNotCommittedError
    );
  } finally {
    await cleanup();
  }
});

test("183. R2F2-R1 F3: working tree has task.json but uncommitted in HEAD -> initRun throws TaskPacketNotCommittedError", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const taskDir = join(repoDir, ".agent", "tasks", "UNCOMMITTED_TASK");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, "task.json"),
      JSON.stringify({
        task: "UNCOMMITTED_TASK",
        branch: "main",
        allowedScope: ["src/"],
      }),
      "utf8"
    );

    const orchestrator = new CindyOrchestrator({ repoDir });
    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "run-uncommitted-task",
          taskId: "UNCOMMITTED_TASK",
        });
      },
      (err: unknown) => err instanceof TaskPacketNotCommittedError
    );
  } finally {
    await cleanup();
  }
});

test("184. R2F2-R1 F3: HEAD has committed task.json -> initRun succeeds and run.allowedScope derives from committed task packet", async () => {
  const { repoDir, baseCommit, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const taskDir = join(repoDir, ".agent", "tasks", "COMMITTED_TASK_AUTH");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, "task.json"),
      JSON.stringify({
        taskId: "COMMITTED_TASK_AUTH",
        branch: "main",
        baseCommit: baseCommit,
        allowedScope: ["src/core/", "src/auth/"],
      }, null, 2),
      "utf8"
    );
    git(["add", "."]);
    git(["commit", "-m", "chore: add committed task packet"]);
    git(["push", "-u", "-q", "origin", "main"]);

    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-committed-auth",
      taskId: "COMMITTED_TASK_AUTH",
    });

    assert.equal(run.state, CindyState.TASK_INITIALIZED);
    assert.deepEqual(run.allowedScope, ["src/core/", "src/auth/"]);
  } finally {
    await cleanup();
  }
});

test("185. R2F2-R1 F3: caller allowedScope can narrow committed scope but cannot broaden beyond committed scope", async () => {
  const { repoDir, baseCommit, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const taskDir = join(repoDir, ".agent", "tasks", "TASK-SCOPE-NARROW");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, "task.json"),
      JSON.stringify({
        taskId: "TASK-SCOPE-NARROW",
        branch: "main",
        baseCommit: baseCommit,
        allowedScope: ["src/a/", "src/b/"],
      }, null, 2),
      "utf8"
    );
    git(["add", "."]);
    git(["commit", "-m", "chore: add scope task packet"]);
    git(["push", "-u", "-q", "origin", "main"]);

    const orchestrator = new CindyOrchestrator({ repoDir });

    const run1 = await orchestrator.initRun({
      runId: "run-narrow-ok",
      taskId: "TASK-SCOPE-NARROW",
      allowedScope: ["src/a/"],
    });
    assert.deepEqual(run1.allowedScope, ["src/a/"]);

    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "run-broaden-denied",
          taskId: "TASK-SCOPE-NARROW",
          allowedScope: ["src/a/", "unauthorized/secret/"],
        });
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );
  } finally {
    await cleanup();
  }
});

// --- Finding 6: Baseline Authority & Caller Assertion Conflicts (186 - 188) ---

test("186. R2F2-R1 F6: task packet baseCommit=A, caller passes expectedBaseCommit=B to reconcile -> fails closed to GIT_SAFETY_STOP / BASELINE_MISMATCH", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const result = await reconcileCurrentState({
      repoDir,
      taskId: "CINDY-ORCH-MVP",
      expectedBaseCommit: "9999999999999999999999999999999999999999",
    });
    assert.equal(result.reconciled, false);
    assert.equal(result.stopReason, CindyState.GIT_SAFETY_STOP);
    assert.equal(result.detailedStopReason, CindyStopReason.BASELINE_MISMATCH);
    assert.ok(result.stopExplanation?.includes("BASELINE_MISMATCH"));
  } finally {
    await cleanup();
  }
});

test("187. R2F2-R1 F6: task packet baseCommit=A, actual current HEAD moved to divergent B -> reconcile fails closed to GIT_SAFETY_STOP / BASELINE_DRIFT", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const taskDir = join(repoDir, ".agent", "tasks", "TASK-BASE-DRIFT");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, "task.json"),
      JSON.stringify({
        taskId: "TASK-BASE-DRIFT",
        branch: "main",
        baseCommit: "1111111111111111111111111111111111111111",
        allowedScope: ["src/"],
      }, null, 2),
      "utf8"
    );
    git(["add", "."]);
    git(["commit", "-m", "chore: task with divergent base"]);
    git(["push", "-u", "-q", "origin", "main"]);

    await writeFile(
      join(repoDir, ".agent", "current.json"),
      JSON.stringify({ task: "TASK-BASE-DRIFT", status: "BUILDING", branch: "main" }),
      "utf8"
    );

    const result = await reconcileCurrentState({ repoDir, taskId: "TASK-BASE-DRIFT" });
    assert.equal(result.reconciled, false);
    assert.equal(result.stopReason, CindyState.GIT_SAFETY_STOP);
    assert.equal(result.detailedStopReason, CindyStopReason.BASELINE_DRIFT);
  } finally {
    await cleanup();
  }
});

test("188. R2F2-R1 F6: task packet baseCommit=A, actual current HEAD=A -> reconcile baseline check passes", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const currentHead = git(["rev-parse", "HEAD"]).trim();
    const taskDir = join(repoDir, ".agent", "tasks", "TASK-BASE-MATCH");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, "task.json"),
      JSON.stringify({
        taskId: "TASK-BASE-MATCH",
        branch: "main",
        baseCommit: currentHead,
        allowedScope: ["src/"],
      }, null, 2),
      "utf8"
    );
    git(["add", "."]);
    git(["commit", "-m", "chore: task with matching base"]);
    git(["push", "-u", "-q", "origin", "main"]);

    await writeFile(
      join(repoDir, ".agent", "current.json"),
      JSON.stringify({ task: "TASK-BASE-MATCH", status: "BUILDING", branch: "main" }),
      "utf8"
    );

    const result = await reconcileCurrentState({
      repoDir,
      expectedBaseCommit: currentHead,
    });
    assert.notEqual(result.detailedStopReason, CindyStopReason.BASELINE_MISMATCH);
    assert.notEqual(result.detailedStopReason, CindyStopReason.BASELINE_DRIFT);
  } finally {
    await cleanup();
  }
});

// --- Finding 2: Upstream Automatic Verification & Safety Stops (189 - 195) ---

test("189. R2F2-R1 F2: no upstream configured -> enters GIT_SAFETY_STOP / UPSTREAM_MISSING", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    git(["branch", "--unset-upstream"]);
    git(["remote", "remove", "origin"]);

    const orchestrator = new CindyOrchestrator({ repoDir });

    // Under Decision J preflight, initRun rejects upfront without writing to disk
    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "run-f2-no-up",
          taskId: "CINDY-ORCH-MVP",
        });
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        err.message.includes("UPSTREAM_MISSING")
    );

    // Verify no run was written to disk
    const activeRuns = await orchestrator.artifactStore.resolveAllActiveRuns();
    assert.equal(activeRuns.length, 0);

    const reconcileResult = await reconcileCurrentState({ repoDir, taskId: "CINDY-ORCH-MVP" });
    assert.equal(reconcileResult.stopReason, CindyState.GIT_SAFETY_STOP);
    assert.equal(reconcileResult.detailedStopReason, CindyStopReason.UPSTREAM_MISSING);
  } finally {
    await cleanup();
  }
});

test("190. R2F2-R1 F2: run initialized with upstreamSha=A, upstream advances to B, reconcile without caller expectedUpstreamSha automatically detects UPSTREAM_DRIFT and enters GIT_SAFETY_STOP", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-auto-up-drift",
      taskId: "CINDY-ORCH-MVP",
    });
    assert.equal(run.state, CindyState.TASK_INITIALIZED);

    const otherDir = await mkdtemp(join(tmpdir(), "cindy-other-clone-"));
    try {
      execFileSync("git", ["clone", "-b", "main", git(["config", "--get", "remote.origin.url"]).trim(), otherDir], { encoding: "utf8" });
      execFileSync("git", ["config", "user.name", "Other Dev"], { cwd: otherDir });
      execFileSync("git", ["config", "user.email", "other@example.com"], { cwd: otherDir });
      await writeFile(join(otherDir, "remote-file-190.txt"), "hello from remote 190", "utf8");
      execFileSync("git", ["add", "."], { cwd: otherDir });
      execFileSync("git", ["commit", "-m", "feat: remote advance 190"], { cwd: otherDir });
      execFileSync("git", ["push", "-q", "origin", "main"], { cwd: otherDir });
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }

    git(["fetch", "-q", "origin"]);

    const result = await reconcileCurrentState({
      repoDir,
    });

    assert.equal(result.reconciled, false);
    assert.equal(result.stopReason, CindyState.GIT_SAFETY_STOP);
    assert.equal(result.detailedStopReason, CindyStopReason.UPSTREAM_DRIFT);
    assert.ok(result.stopExplanation?.includes("Upstream drift detected"));
  } finally {
    await cleanup();
  }
});

test("191. R2F2-R1 F2: checkGitUpstreamStatus ahead -> evaluateGitAuthority enters GIT_SAFETY_STOP / UPSTREAM_AHEAD", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    git(["commit", "--allow-empty", "-m", "local commit ahead"]);

    const upStatus = checkGitUpstreamStatus(repoDir);
    assert.equal(upStatus.divergence, "ahead");
    assert.equal(upStatus.aheadCount, 1);
    assert.equal(upStatus.behindCount, 0);

    const evalResult = evaluateGitAuthority({
      repoDir,
      taskId: "CINDY-ORCH-MVP",
    });
    assert.equal(evalResult.ok, false);
    assert.equal(evalResult.stopState, CindyState.GIT_SAFETY_STOP);
    assert.equal(evalResult.stopReason, CindyStopReason.UPSTREAM_AHEAD);
  } finally {
    await cleanup();
  }
});

test("192. R2F2-R1 F2: checkGitUpstreamStatus behind -> evaluateGitAuthority enters GIT_SAFETY_STOP / UPSTREAM_BEHIND", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

    const otherDir = await mkdtemp(join(tmpdir(), "cindy-other-clone-"));
    try {
      execFileSync("git", ["clone", "-b", "main", git(["config", "--get", "remote.origin.url"]).trim(), otherDir], { encoding: "utf8" });
      execFileSync("git", ["config", "user.name", "Other Dev"], { cwd: otherDir });
      execFileSync("git", ["config", "user.email", "other@example.com"], { cwd: otherDir });
      await writeFile(join(otherDir, "remote-behind.txt"), "remote", "utf8");
      execFileSync("git", ["add", "."], { cwd: otherDir });
      execFileSync("git", ["commit", "-m", "feat: remote commit"], { cwd: otherDir });
      execFileSync("git", ["push", "-q", "origin", "main"], { cwd: otherDir });
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }

    git(["fetch", "-q", "origin"]);

    const upStatus = checkGitUpstreamStatus(repoDir);
    assert.equal(upStatus.divergence, "behind");
    assert.equal(upStatus.aheadCount, 0);
    assert.equal(upStatus.behindCount, 1);

    const evalResult = evaluateGitAuthority({
      repoDir,
      taskId: "CINDY-ORCH-MVP",
    });
    assert.equal(evalResult.ok, false);
    assert.equal(evalResult.stopState, CindyState.GIT_SAFETY_STOP);
    assert.equal(evalResult.stopReason, CindyStopReason.UPSTREAM_BEHIND);
  } finally {
    await cleanup();
  }
});

test("193. R2F2-R1 F2: checkGitUpstreamStatus diverged -> evaluateGitAuthority enters GIT_SAFETY_STOP / UPSTREAM_DIVERGED", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

    const otherDir = await mkdtemp(join(tmpdir(), "cindy-other-clone-"));
    try {
      execFileSync("git", ["clone", "-b", "main", git(["config", "--get", "remote.origin.url"]).trim(), otherDir], { encoding: "utf8" });
      execFileSync("git", ["config", "user.name", "Other Dev"], { cwd: otherDir });
      execFileSync("git", ["config", "user.email", "other@example.com"], { cwd: otherDir });
      await writeFile(join(otherDir, "remote-diverged.txt"), "remote", "utf8");
      execFileSync("git", ["add", "."], { cwd: otherDir });
      execFileSync("git", ["commit", "-m", "feat: remote diverged"], { cwd: otherDir });
      execFileSync("git", ["push", "-q", "origin", "main"], { cwd: otherDir });
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }

    git(["commit", "--allow-empty", "-m", "local diverged commit"]);
    git(["fetch", "-q", "origin"]);

    const upStatus = checkGitUpstreamStatus(repoDir);
    assert.equal(upStatus.divergence, "diverged");
    assert.equal(upStatus.aheadCount, 1);
    assert.equal(upStatus.behindCount, 1);

    const evalResult = evaluateGitAuthority({
      repoDir,
      taskId: "CINDY-ORCH-MVP",
    });
    assert.equal(evalResult.ok, false);
    assert.equal(evalResult.stopState, CindyState.GIT_SAFETY_STOP);
    assert.equal(evalResult.stopReason, CindyStopReason.UPSTREAM_DIVERGED);
  } finally {
    await cleanup();
  }
});

test("194. R2F2-R1 F2: detached HEAD -> evaluateGitAuthority enters GIT_SAFETY_STOP / BRANCH_MISMATCH", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    git(["checkout", "--detach", "HEAD"]);

    const evalResult = evaluateGitAuthority({
      repoDir,
      taskId: "CINDY-ORCH-MVP",
    });
    assert.equal(evalResult.ok, false);
    assert.equal(evalResult.stopState, CindyState.GIT_SAFETY_STOP);
    assert.equal(evalResult.stopReason, CindyStopReason.BRANCH_MISMATCH);
    assert.ok(evalResult.stopExplanation?.includes("Detached HEAD"));
  } finally {
    await cleanup();
  }
});

test("195. R2F2 AD-S: git execution whitelist audit: runGitReadOnly is unexported and only typed readers exist", async () => {
  const gitMod = await import("../tools/cindy/git.ts");
  assert.strictEqual(
    (gitMod as unknown as Record<string, unknown>).runGitReadOnly,
    undefined,
    "runGitReadOnly must not be exported; all access must use typed fact readers"
  );
  assert.strictEqual(typeof gitMod.getGitStatus, "function");
  assert.strictEqual(typeof gitMod.getGitHead, "function");
  assert.strictEqual(typeof gitMod.getGitBranch, "function");
  assert.strictEqual(typeof gitMod.getGitUpstream, "function");
  assert.strictEqual(typeof gitMod.getTaskAuthorityCommit, "function");
  assert.strictEqual(typeof gitMod.evaluateGitAuthority, "function");
});

// --- Scope Boundary Invariants (196 - 198) ---

test("196. R2F2-R1 Scope: without committed task packet, caller cannot inject arbitrary scope", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "run-arbitrary-scope",
          taskId: "NO-SUCH-TASK-DEFINED",
          allowedScope: ["/etc/", "secret/"],
        });
      },
      (err: unknown) => err instanceof TaskPacketNotCommittedError
    );
  } finally {
    await cleanup();
  }
});

test("197. R2F2-R1 Scope: uncommitted working-tree file modifications outside scope trigger DIRTY_TREE_UNEXPLAINED", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-dirty-unexplained-init",
      taskId: "CINDY-ORCH-MVP",
    });
    assert.equal(run.state, CindyState.TASK_INITIALIZED);

    await writeFile(join(repoDir, "rogue-outside-scope.txt"), "malicious content", "utf8");

    const reconcileResult = await reconcileCurrentState({
      repoDir,
    });
    assert.equal(reconcileResult.reconciled, false);
    assert.equal(reconcileResult.stopReason, CindyState.DIRTY_TREE_UNEXPLAINED);
    assert.equal(reconcileResult.detailedStopReason, CindyStopReason.DIRTY_TREE_UNEXPLAINED);
  } finally {
    await cleanup();
  }
});

test("198. R2F2-R1 Scope: working tree edit of task.json cannot alter authoritative run scope or bypass scope check", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-scope-tamper-check",
      taskId: "CINDY-ORCH-MVP",
    });
    const originalScope = [...run.allowedScope];

    const taskPath = join(repoDir, ".agent", "tasks", "CINDY-ORCH-MVP", "task.json");
    const tampered = JSON.parse(await readFile(taskPath, "utf8"));
    tampered.allowedScope = [".", "/"];
    await writeFile(taskPath, JSON.stringify(tampered, null, 2), "utf8");

    const committedPacket = readCommittedTaskPacket("CINDY-ORCH-MVP", repoDir);
    assert.deepEqual(committedPacket?.allowedScope, originalScope);
    assert.notDeepEqual(committedPacket?.allowedScope, [".", "/"]);
  } finally {
    await cleanup();
  }
});

// --- Finding 4: System-Derived pausedFrom & State Integrity (199 - 202) ---

test("199. R2F2-R1 F4: TASK_INITIALIZED run pause records pausedFrom: TASK_INITIALIZED (caller cannot choose pausedFrom: BUILDING)", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-f4-task-init-pause",
      taskId: "CINDY-ORCH-MVP",
    });
    assert.equal(run.state, CindyState.TASK_INITIALIZED);

    const paused = await orchestrator.pauseRun(run.runId, CindyState.BLOCKED);
    assert.equal(paused.state, CindyState.BLOCKED);
    assert.equal(paused.pausedFrom, CindyState.TASK_INITIALIZED);
  } finally {
    await cleanup();
  }
});

test("200. R2F2-R1 F4: BUILDING run pause records pausedFrom: BUILDING", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-f4-building-pause",
      taskId: "CINDY-ORCH-MVP",
    });
    await orchestrator.markReadyForBuilder(run.runId);
    const building = await orchestrator.startBuilding(run.runId);
    assert.equal(building.state, CindyState.BUILDING);

    const paused = await orchestrator.pauseRun(run.runId, CindyState.BLOCKED);
    assert.equal(paused.state, CindyState.BLOCKED);
    assert.equal(paused.pausedFrom, CindyState.BUILDING);
  } finally {
    await cleanup();
  }
});

test("201. R2F2-R1 F4: paused run re-paused during reconcile inherits original pausedFrom", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-f4-re-pause-inherit",
      taskId: "CINDY-ORCH-MVP",
    });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);

    await writeFile(join(repoDir, "rogue-persist.txt"), "dirty", "utf8");
    const stopped = await orchestrator.deriveSafetyStop(run.runId);
    assert.equal(stopped.state, CindyState.DIRTY_TREE_UNEXPLAINED);
    assert.equal(stopped.pausedFrom, CindyState.BUILDING);

    const recResult = await reconcileCurrentState({
      repoDir,
    });
    assert.equal(recResult.stopReason, CindyState.DIRTY_TREE_UNEXPLAINED);

    const runAfterReconcile = await orchestrator.getRun(run.runId);
    assert.equal(runAfterReconcile.state, CindyState.DIRTY_TREE_UNEXPLAINED);
    assert.equal(runAfterReconcile.pausedFrom, CindyState.BUILDING);
  } finally {
    await cleanup();
  }
});

test("202. R2F2-R1 F4: corrupted or privileged pausedFrom (e.g. COMPLETE or CLOSED) causes resumeRun to fail closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-f4-corrupted-pausedfrom",
      taskId: "CINDY-ORCH-MVP",
    });
    await orchestrator.pauseRun(run.runId, CindyState.BLOCKED);

    const runPath = join(orchestrator.artifactStore.getRunDir(run.runId), "run.json");

    // Case 1: Corrupted non-state string "COMPLETE" rejected fail-closed at schema level
    const runData1 = JSON.parse(await readFile(runPath, "utf8"));
    runData1.pausedFrom = "COMPLETE";
    await writeFile(runPath, JSON.stringify(runData1, null, 2), "utf8");

    await assert.rejects(
      async () => {
        await orchestrator.resumeRun(run.runId);
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );

    // Case 2: Privileged state CLOSED (valid enum in schema, but not in RESUME_TARGET_WHITELIST)
    const runData2 = JSON.parse(await readFile(runPath, "utf8"));
    runData2.pausedFrom = CindyState.CLOSED;
    await writeFile(runPath, JSON.stringify(runData2, null, 2), "utf8");

    await assert.rejects(
      async () => {
        await orchestrator.resumeRun(run.runId);
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        (err as Error).message.includes("Corrupted or prohibited pausedFrom state")
    );
  } finally {
    await cleanup();
  }
});

// --- Finding 5: Resume Git Authority Revalidation (203 - 208) ---

test("203. R2F2-R1 F5: run paused at HEAD A, HEAD drifts to B while paused -> resumeRun fails closed to GIT_SAFETY_STOP / HEAD_DRIFT", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-f5-head-drift-resume",
      taskId: "CINDY-ORCH-MVP",
    });

    git(["commit", "--allow-empty", "-m", "chore: external commit while paused"]);
    const stopped = await orchestrator.deriveSafetyStop(run.runId);
    assert.equal(stopped.state, CindyState.GIT_SAFETY_STOP);
    assert.equal(stopped.stopReason, CindyStopReason.HEAD_DRIFT);

    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.GIT_SAFETY_STOP);
    assert.equal(resumed.stopReason, CindyStopReason.HEAD_DRIFT);
  } finally {
    await cleanup();
  }
});

test("204. R2F2-R1 F5: run paused at upstream A, upstream drifts to B while paused -> resumeRun fails closed to GIT_SAFETY_STOP / UPSTREAM_DRIFT", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-f5-upstream-drift-resume",
      taskId: "CINDY-ORCH-MVP",
    });

    const otherDir = await mkdtemp(join(tmpdir(), "cindy-other-clone-"));
    try {
      execFileSync("git", ["clone", "-b", "main", git(["config", "--get", "remote.origin.url"]).trim(), otherDir], { encoding: "utf8" });
      execFileSync("git", ["config", "user.name", "Other Dev"], { cwd: otherDir });
      execFileSync("git", ["config", "user.email", "other@example.com"], { cwd: otherDir });
      await writeFile(join(otherDir, "remote-204.txt"), "hello", "utf8");
      execFileSync("git", ["add", "."], { cwd: otherDir });
      execFileSync("git", ["commit", "-m", "feat: remote change 204"], { cwd: otherDir });
      execFileSync("git", ["push", "-q", "origin", "main"], { cwd: otherDir });
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }

    git(["fetch", "-q", "origin"]);

    const stopped = await orchestrator.deriveSafetyStop(run.runId);
    assert.equal(stopped.state, CindyState.GIT_SAFETY_STOP);
    assert.equal(stopped.stopReason, CindyStopReason.UPSTREAM_DRIFT);

    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.GIT_SAFETY_STOP);
    assert.equal(resumed.stopReason, CindyStopReason.UPSTREAM_DRIFT);
  } finally {
    await cleanup();
  }
});

test("205. R2F2-R1 F5: run paused with valid upstream, upstream removed while paused -> resumeRun fails closed to GIT_SAFETY_STOP / UPSTREAM_MISSING", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-f5-upstream-removed-resume",
      taskId: "CINDY-ORCH-MVP",
    });

    git(["branch", "--unset-upstream"]);
    git(["remote", "remove", "origin"]);

    const stopped = await orchestrator.deriveSafetyStop(run.runId);
    assert.equal(stopped.state, CindyState.GIT_SAFETY_STOP);
    assert.equal(stopped.stopReason, CindyStopReason.UPSTREAM_MISSING);

    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.GIT_SAFETY_STOP);
    assert.equal(resumed.stopReason, CindyStopReason.UPSTREAM_MISSING);
  } finally {
    await cleanup();
  }
});

test("206. R2F2-R1 F5: run paused due to dirty tree, dirty tree persists -> resumeRun remains in DIRTY_TREE_UNEXPLAINED", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-f5-dirty-persist-resume",
      taskId: "CINDY-ORCH-MVP",
    });
    assert.equal(run.state, CindyState.TASK_INITIALIZED);

    const rogueFile = join(repoDir, "rogue-206.txt");
    await writeFile(rogueFile, "dirty", "utf8");

    await orchestrator.deriveSafetyStop(run.runId);

    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.DIRTY_TREE_UNEXPLAINED);
    assert.equal(resumed.stopReason, CindyStopReason.DIRTY_TREE_UNEXPLAINED);
  } finally {
    await cleanup();
  }
});

test("207. R2F2-R1 F5: run paused due to dirty tree, dirty tree cleared -> resumeRun successfully resumes to pausedFrom", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-f5-dirty-cleared-resume",
      taskId: "CINDY-ORCH-MVP",
    });
    assert.equal(run.state, CindyState.TASK_INITIALIZED);

    const rogueFile = join(repoDir, "rogue-207.txt");
    await writeFile(rogueFile, "dirty", "utf8");

    await orchestrator.deriveSafetyStop(run.runId);

    await rm(rogueFile);

    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.TASK_INITIALIZED);
    assert.equal(resumed.stopReason, null);
    assert.equal(resumed.pausedFrom, null);
  } finally {
    await cleanup();
  }
});

test("208. R2F2-R1 F5: run paused in PRODUCT_DECISION_REQUIRED without approved decision -> resumeRun remains paused", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-f5-pd-required-resume",
      taskId: "CINDY-ORCH-MVP",
    });
    await orchestrator.transition(run.runId, CindyState.PRODUCT_DECISION_REQUIRED, {
      stopReason: CindyStopReason.PRODUCT_DECISION_REQUIRED,
    });

    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.PRODUCT_DECISION_REQUIRED);
    assert.equal(resumed.stopReason, CindyStopReason.PRODUCT_DECISION_REQUIRED);
  } finally {
    await cleanup();
  }
});

// =========================================================================
// R2F2-R2: 42-Case Targeted Test Matrix
// =========================================================================

// --- Group 1: Exact Baseline Equality (10 cases) ---

test("209. Matrix 1.1: actualHead === authoritativeTaskBase passes", async () => {
  const { repoDir, baseCommit, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const head = git(["rev-parse", "HEAD"]).trim();
    const up = getGitUpstream(repoDir)!;

    const res = evaluateGitAuthority({
      repoDir,
      taskId: "CINDY-ORCH-MVP",
      runSnapshot: {
        branch: "main",
        headCommit: head,
        baseCommit: baseCommit,
        taskAuthorityCommit: head,
        upstreamSha: up.commit,
        upstreamRef: up.ref,
        upstreamCommit: up.commit,
      },
    });

    assert.equal(res.ok, true);
    assert.equal(res.actualHead, head);
    assert.equal(res.stopReason, null);
  } finally {
    await cleanup();
  }
});

test("210. Matrix 1.2: actualHead is child/descendant of baseline rejected fail closed (BASELINE_DRIFT)", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const base = git(["rev-parse", "HEAD"]).trim();

    // Advance HEAD by creating a commit
    await writeFile(join(repoDir, "extra.txt"), "extra", "utf8");
    git(["add", "."]);
    git(["commit", "-m", "chore: advance head"]);
    git(["push", "-q", "origin", "main"]);

    const newHead = git(["rev-parse", "HEAD"]).trim();
    assert.notEqual(base, newHead);

    const up = getGitUpstream(repoDir)!;

    // Evaluated with baseline=base, but actualHead is descendant newHead
    const res = evaluateGitAuthority({
      repoDir,
      taskId: "CINDY-ORCH-MVP",
      runSnapshot: {
        branch: "main",
        headCommit: base,
        baseCommit: base,
        taskAuthorityCommit: base,
        upstreamSha: up.commit,
        upstreamRef: up.ref,
        upstreamCommit: up.commit,
      },
    });

    assert.equal(res.ok, false);
    assert.ok(
      res.stopReason === CindyStopReason.HEAD_DRIFT ||
      res.stopReason === CindyStopReason.BASELINE_DRIFT ||
      res.stopReason === CindyStopReason.BASELINE_MISMATCH ||
      res.stopReason === CindyStopReason.TASK_PACKET_DRIFT
    );
  } finally {
    await cleanup();
  }
});

test("211. Matrix 1.3: actualHead is parent/ancestor of baseline rejected fail closed (BASELINE_DRIFT)", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const currentHead = git(["rev-parse", "HEAD"]).trim();
    const up = getGitUpstream(repoDir)!;

    // Simulated future commit as baseline
    const futureCommit = "1111111111111111111111111111111111111111";

    const res = evaluateGitAuthority({
      repoDir,
      taskId: "CINDY-ORCH-MVP",
      runSnapshot: {
        branch: "main",
        headCommit: futureCommit,
        baseCommit: futureCommit,
        taskAuthorityCommit: futureCommit,
        upstreamSha: up.commit,
        upstreamRef: up.ref,
        upstreamCommit: up.commit,
      },
    });

    assert.equal(res.ok, false);
    assert.ok(
      res.stopReason === CindyStopReason.HEAD_DRIFT ||
      res.stopReason === CindyStopReason.BASELINE_DRIFT ||
      res.stopReason === CindyStopReason.BASELINE_MISMATCH ||
      res.stopReason === CindyStopReason.TASK_PACKET_DRIFT
    );
  } finally {
    await cleanup();
  }
});

test("212. Matrix 1.4: actualHead is unrelated branch from baseline rejected fail closed (BASELINE_DRIFT)", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const up = getGitUpstream(repoDir)!;
    const unrelatedCommit = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

    const res = evaluateGitAuthority({
      repoDir,
      taskId: "CINDY-ORCH-MVP",
      runSnapshot: {
        branch: "main",
        headCommit: unrelatedCommit,
        baseCommit: unrelatedCommit,
        taskAuthorityCommit: unrelatedCommit,
        upstreamSha: up.commit,
        upstreamRef: up.ref,
        upstreamCommit: up.commit,
      },
    });

    assert.equal(res.ok, false);
    assert.ok(
      res.stopReason === CindyStopReason.HEAD_DRIFT ||
      res.stopReason === CindyStopReason.BASELINE_DRIFT ||
      res.stopReason === CindyStopReason.BASELINE_MISMATCH ||
      res.stopReason === CindyStopReason.TASK_PACKET_DRIFT
    );
  } finally {
    await cleanup();
  }
});

test("213. Matrix 1.5: caller expectedBaseCommit === actualHead === taskBase passes", async () => {
  const { repoDir, baseCommit, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const head = git(["rev-parse", "HEAD"]).trim();
    const up = getGitUpstream(repoDir)!;

    const res = evaluateGitAuthority({
      repoDir,
      taskId: "CINDY-ORCH-MVP",
      callerAssertions: {
        expectedBaseCommit: baseCommit,
      },
      runSnapshot: {
        branch: "main",
        headCommit: head,
        baseCommit: baseCommit,
        taskAuthorityCommit: head,
        upstreamSha: up.commit,
        upstreamRef: up.ref,
        upstreamCommit: up.commit,
      },
    });

    assert.equal(res.ok, true);
    assert.equal(res.stopReason, null);
  } finally {
    await cleanup();
  }
});

test("214. Matrix 1.6: caller expectedBaseCommit != actualHead rejected fail closed (BASELINE_MISMATCH)", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const head = git(["rev-parse", "HEAD"]).trim();
    const up = getGitUpstream(repoDir)!;

    const res = evaluateGitAuthority({
      repoDir,
      taskId: "CINDY-ORCH-MVP",
      callerAssertions: {
        expectedBaseCommit: "9999999999999999999999999999999999999999",
      },
      runSnapshot: {
        branch: "main",
        headCommit: head,
        baseCommit: head,
        upstreamSha: up.commit,
        upstreamRef: up.ref,
        upstreamCommit: up.commit,
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.stopReason, CindyStopReason.BASELINE_MISMATCH);
  } finally {
    await cleanup();
  }
});

test("215. Matrix 1.7: caller expectedBaseCommit != taskBase rejected fail closed (BASELINE_MISMATCH)", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const head = git(["rev-parse", "HEAD"]).trim();
    const up = getGitUpstream(repoDir)!;

    const taskDir = join(repoDir, ".agent", "tasks", "TASK-MATRIX-17");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, "task.json"),
      JSON.stringify({
        taskId: "TASK-MATRIX-17",
        branch: "main",
        baseCommit: head,
        allowedScope: ["src/"],
      }, null, 2),
      "utf8"
    );
    git(["add", "."]);
    git(["commit", "-m", "chore: task matrix 17"]);
    git(["push", "-q", "origin", "main"]);

    const newHead = git(["rev-parse", "HEAD"]).trim();

    const res = evaluateGitAuthority({
      repoDir,
      taskId: "TASK-MATRIX-17",
      callerAssertions: {
        expectedBaseCommit: newHead,
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.stopReason, CindyStopReason.BASELINE_MISMATCH);
  } finally {
    await cleanup();
  }
});

test("216. Matrix 1.8: initRun preflight baseline check exact equality rejects descendant", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const oldCommit = git(["rev-parse", "HEAD"]).trim();

    await writeFile(join(repoDir, "advance.txt"), "content", "utf8");
    git(["add", "."]);
    git(["commit", "-m", "chore: advance commit"]);
    git(["push", "-q", "origin", "main"]);

    const orchestrator = new CindyOrchestrator({ repoDir });

    // Calling initRun with stale expected baseCommit (parent of actual HEAD)
    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "run-m18",
          taskId: "CINDY-ORCH-MVP",
          baseCommit: oldCommit,
        });
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        (err.message.includes("BASELINE_MISMATCH") || err.message.includes("TASK_BASELINE_DRIFT") || err.message.includes("DRIFT"))
    );

    const active = await orchestrator.artifactStore.resolveAllActiveRuns();
    assert.equal(active.length, 0);
  } finally {
    await cleanup();
  }
});

test("217. Matrix 1.9: reconcile baseline check exact equality rejects descendant", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-m19",
      taskId: "CINDY-ORCH-MVP",
    });
    assert.equal(run.state, CindyState.TASK_INITIALIZED);

    // Commit changes while run is active (HEAD moves ahead of run.baseCommit)
    await writeFile(join(repoDir, "ahead.txt"), "drift", "utf8");
    git(["add", "."]);
    git(["commit", "-m", "chore: drift commit"]);
    git(["push", "-q", "origin", "main"]);

    const reconcileResult = await reconcileCurrentState({ repoDir });
    assert.equal(reconcileResult.stopReason, CindyState.GIT_SAFETY_STOP);
    assert.ok(
      reconcileResult.detailedStopReason === CindyStopReason.HEAD_DRIFT ||
      reconcileResult.detailedStopReason === CindyStopReason.BASELINE_DRIFT ||
      reconcileResult.detailedStopReason === CindyStopReason.BASELINE_MISMATCH
    );
  } finally {
    await cleanup();
  }
});

test("218. Matrix 1.10: resumeRun baseline check exact equality rejects descendant", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-m110",
      taskId: "CINDY-ORCH-MVP",
    });

    // Commit while active, causing HEAD drift
    await writeFile(join(repoDir, "paused-advance.txt"), "advance", "utf8");
    git(["add", "."]);
    git(["commit", "-m", "chore: advance while paused"]);
    git(["push", "-q", "origin", "main"]);

    const stopped = await orchestrator.deriveSafetyStop(run.runId);
    assert.equal(stopped.state, CindyState.GIT_SAFETY_STOP);
    assert.equal(stopped.stopReason, CindyStopReason.HEAD_DRIFT);

    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.GIT_SAFETY_STOP);
    assert.equal(resumed.stopReason, CindyStopReason.HEAD_DRIFT);
  } finally {
    await cleanup();
  }
});

// --- Group 2: Unique Active Run Authority (11 cases) ---

test("219. Matrix 2.1: 0 active runs -> resolveActiveRunForTask returns null", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const run = await store.resolveActiveRunForTask("CINDY-ORCH-MVP");
    assert.equal(run, null);
  } finally {
    await cleanup();
  }
});

test("220. Matrix 2.2: 1 active run -> resolveActiveRunForTask returns the unique run", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const created = await orchestrator.initRun({
      runId: "run-m22",
      taskId: "CINDY-ORCH-MVP",
    });

    const resolved = await orchestrator.artifactStore.resolveActiveRunForTask("CINDY-ORCH-MVP");
    assert.ok(resolved !== null);
    assert.equal(resolved.runId, "run-m22");
    assert.equal(resolved.state, CindyState.TASK_INITIALIZED);
  } finally {
    await cleanup();
  }
});

test("221. Matrix 2.3: 2 active runs for same task -> resolveActiveRunForTask throws AmbiguousActiveRunError fail closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const head = git(["rev-parse", "HEAD"]).trim();
    const up = getGitUpstream(repoDir)!;

    const store = new RuntimeArtifactStore({ repoDir });

    const run1: CindyRun = {
      runId: "run-m23-a",
      taskId: "TASK-MULTI",
      version: 1,
      state: CindyState.TASK_INITIALIZED,
      currentCycle: 1,
      branch: "main",
      baseCommit: head,
      headCommit: head,
      taskAuthorityCommit: head,
      upstreamRef: up.ref ?? "refs/remotes/origin/main",
      upstreamCommit: up.commit,
      allowedScope: ["src/"],
      history: [{ fromState: CindyState.RECONCILING, toState: CindyState.TASK_INITIALIZED, timestamp: new Date().toISOString() }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const run2: CindyRun = {
      runId: "run-m23-b",
      taskId: "TASK-MULTI",
      version: 1,
      state: CindyState.RECONCILING,
      currentCycle: 1,
      branch: "main",
      baseCommit: head,
      headCommit: head,
      taskAuthorityCommit: head,
      upstreamRef: up.ref ?? "refs/remotes/origin/main",
      upstreamCommit: up.commit,
      allowedScope: ["src/"],
      history: [{ fromState: CindyState.TASK_INITIALIZED, toState: CindyState.RECONCILING, timestamp: new Date().toISOString() }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const runDir1 = join(repoDir, ".agent", "runtime", "run-m23-a");
    await mkdir(runDir1, { recursive: true });
    await writeFile(join(runDir1, "run.json"), JSON.stringify(run1, null, 2), "utf8");

    const runDir2 = join(repoDir, ".agent", "runtime", "run-m23-b");
    await mkdir(runDir2, { recursive: true });
    await writeFile(join(runDir2, "run.json"), JSON.stringify(run2, null, 2), "utf8");

    await assert.rejects(
      async () => {
        await store.resolveActiveRunForTask("TASK-MULTI");
      },
      (err: unknown) =>
        err instanceof AmbiguousActiveRunError &&
        err.message.includes("TASK-MULTI")
    );
  } finally {
    await cleanup();
  }
});

test("222. Matrix 2.4: 2 active runs across different tasks -> resolveAllActiveRuns returns both, reconcile without current.json fail closed AMBIGUOUS_ACTIVE_RUN", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const head = git(["rev-parse", "HEAD"]).trim();
    const up = getGitUpstream(repoDir)!;

    const store = new RuntimeArtifactStore({ repoDir });

    const run1: CindyRun = {
      runId: "run-m24-t1",
      taskId: "TASK-1",
      version: 1,
      state: CindyState.TASK_INITIALIZED,
      currentCycle: 1,
      branch: "main",
      baseCommit: head,
      headCommit: head,
      taskAuthorityCommit: head,
      upstreamRef: up.ref ?? "refs/remotes/origin/main",
      upstreamCommit: up.commit,
      allowedScope: ["src/"],
      history: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const run2: CindyRun = {
      runId: "run-m24-t2",
      taskId: "TASK-2",
      version: 1,
      state: CindyState.TASK_INITIALIZED,
      currentCycle: 1,
      branch: "main",
      baseCommit: head,
      headCommit: head,
      taskAuthorityCommit: head,
      upstreamRef: up.ref ?? "refs/remotes/origin/main",
      upstreamCommit: up.commit,
      allowedScope: ["src/"],
      history: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const runDir1 = join(repoDir, ".agent", "runtime", "run-m24-t1");
    await mkdir(runDir1, { recursive: true });
    await writeFile(join(runDir1, "run.json"), JSON.stringify(run1, null, 2), "utf8");

    const runDir2 = join(repoDir, ".agent", "runtime", "run-m24-t2");
    await mkdir(runDir2, { recursive: true });
    await writeFile(join(runDir2, "run.json"), JSON.stringify(run2, null, 2), "utf8");

    const all = await store.resolveAllActiveRuns();
    assert.equal(all.length, 2);

    // Remove current.json
    const cjson = join(repoDir, ".agent", "current.json");
    if (existsSync(cjson)) await rm(cjson);

    const rec = await reconcileCurrentState({ repoDir });
    assert.equal(rec.reconciled, false);
    assert.equal(rec.detailedStopReason, CindyStopReason.AMBIGUOUS_ACTIVE_RUN);
  } finally {
    await cleanup();
  }
});

test("223. Matrix 2.5: current.json points to active run -> matches and reconciles", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    await writeFile(
      join(repoDir, ".agent", "current.json"),
      JSON.stringify({ task: "CINDY-ORCH-MVP", runId: "run-m25", status: "READY", branch: "main" }),
      "utf8"
    );
    const taskPath = join(repoDir, ".agent", "tasks", "CINDY-ORCH-MVP", "task.json");
    const taskData = JSON.parse(await readFile(taskPath, "utf8"));
    taskData.updatedAt = new Date().toISOString();
    await writeFile(taskPath, JSON.stringify(taskData, null, 2), "utf8");

    git(["commit", "-am", "chore: update current.json and task for run-m25"]);
    git(["push", "-q", "origin", "main"]);

    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-m25",
      taskId: "CINDY-ORCH-MVP",
    });

    const rec = await reconcileCurrentState({ repoDir });
    assert.equal(rec.currentTaskId, "CINDY-ORCH-MVP");
    assert.equal(rec.stopReason, null);
  } finally {
    await cleanup();
  }
});

test("224. Matrix 2.6: current.json points to completed/closed run while active run exists -> hint ignored, active run chosen", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const activeRun = await orchestrator.initRun({
      runId: "run-m26-active",
      taskId: "CINDY-ORCH-MVP",
    });

    // current.json points to closed run id
    await writeFile(
      join(repoDir, ".agent", "current.json"),
      JSON.stringify({ task: "CINDY-ORCH-MVP", runId: "run-p0-05a-t2b-legacy", status: "CLOSED", branch: "main" }),
      "utf8"
    );

    const rec = await reconcileCurrentState({ repoDir });
    assert.equal(rec.resolvedStatus, "TASK_INITIALIZED");
    assert.equal(rec.pointerHealth, "MISMATCH");
  } finally {
    await cleanup();
  }
});

test("225. Matrix 2.7: current.json points to non-existent run while active run exists -> hint ignored, active run chosen", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    await orchestrator.initRun({
      runId: "run-m27-real",
      taskId: "CINDY-ORCH-MVP",
    });

    // current.json points to non-existent ghost run
    await writeFile(
      join(repoDir, ".agent", "current.json"),
      JSON.stringify({ task: "CINDY-ORCH-MVP", runId: "run-ghost-999", status: "READY", branch: "main" }),
      "utf8"
    );

    const rec = await reconcileCurrentState({ repoDir });
    assert.equal(rec.resolvedStatus, "TASK_INITIALIZED");
    assert.equal(rec.pointerHealth, "MISMATCH");
  } finally {
    await cleanup();
  }
});

test("226. Matrix 2.8: current.json missing, exactly 1 active run in repo -> active run resolved and used", async () => {
  const { repoDir, cleanup } = await createTempRepo({ withoutCurrentJson: true });
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-m28",
      taskId: "CINDY-ORCH-MVP",
    });

    const rec = await reconcileCurrentState({ repoDir });
    assert.equal(rec.currentTaskId, "CINDY-ORCH-MVP");
    assert.equal(rec.stopReason, null);
  } finally {
    await cleanup();
  }
});

test("227. Matrix 2.9: active run JSON corrupted / malformed -> resolveActiveRunForTask throws InvalidRunRecordError fail closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const runDir = join(repoDir, ".agent", "runtime", "run-m29");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run.json"), '{"taskId": "TASK-CORRUPT", broken json', "utf8");

    const store = new RuntimeArtifactStore({ repoDir });
    await assert.rejects(
      async () => {
        await store.resolveActiveRunForTask("TASK-CORRUPT");
      },
      (err: unknown) =>
        err instanceof InvalidRunRecordError &&
        err.message.includes("run-m29")
    );
  } finally {
    await cleanup();
  }
});

test("228. Matrix 2.10: active run schema invalid -> resolveActiveRunForTask throws InvalidRunRecordError fail closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const head = git(["rev-parse", "HEAD"]).trim();

    const runDir = join(repoDir, ".agent", "runtime", "run-m210");
    await mkdir(runDir, { recursive: true });
    // Valid snapshot fields and taskId, but missing required schema fields (e.g. version, history, allowedScope)
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({
        runId: "run-m210",
        taskId: "TASK-SCHEMA-INV",
        branch: "main",
        headCommit: head,
        baseCommit: head,
        upstreamRef: "refs/remotes/origin/main",
        upstreamCommit: head,
        taskAuthorityCommit: head,
        state: CindyState.TASK_INITIALIZED,
      }),
      "utf8"
    );

    const store = new RuntimeArtifactStore({ repoDir });
    await assert.rejects(
      async () => {
        await store.resolveActiveRunForTask("TASK-SCHEMA-INV");
      },
      (err: unknown) =>
        err instanceof InvalidRunRecordError &&
        err.message.includes("run-m210")
    );
  } finally {
    await cleanup();
  }
});

test("229. Matrix 2.11: findLatestRunForTask does not exist in codebase (static audit)", async () => {
  const store = new RuntimeArtifactStore({ repoDir: "/tmp" });
  assert.equal(
    typeof (store as unknown as Record<string, unknown>)["findLatestRunForTask"],
    "undefined",
    "findLatestRunForTask must not exist on RuntimeArtifactStore"
  );
});

// --- Group 3: Git Snapshot Completeness (7 cases) ---

test("230. Matrix 3.1: run record with all 7 fields (runId, taskId, branch, headCommit, baseCommit, upstreamRef, upstreamCommit) passes", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-m31",
      taskId: "CINDY-ORCH-MVP",
    });

    assert.ok(run.runId);
    assert.ok(run.taskId);
    assert.ok(run.branch);
    assert.ok(run.headCommit);
    assert.ok(run.baseCommit);
    assert.ok(run.upstreamRef);
    assert.ok(run.upstreamCommit);
  } finally {
    await cleanup();
  }
});

test("231. Matrix 3.2: run record missing upstreamRef -> throws RunGitSnapshotIncompleteError fail closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const head = git(["rev-parse", "HEAD"]).trim();

    const runDir = join(repoDir, ".agent", "runtime", "run-m32");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({
        runId: "run-m32",
        taskId: "TASK-INCOMP",
        version: 1,
        state: CindyState.TASK_INITIALIZED,
        currentCycle: 1,
        branch: "main",
        baseCommit: head,
        headCommit: head,
        upstreamCommit: head,
        allowedScope: ["src/"],
        history: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      "utf8"
    );

    const store = new RuntimeArtifactStore({ repoDir });
    await assert.rejects(
      async () => {
        await store.resolveActiveRunForTask("TASK-INCOMP");
      },
      (err: unknown) =>
        err instanceof RunGitSnapshotIncompleteError &&
        err.message.includes("missing required Git authority snapshot field")
    );
  } finally {
    await cleanup();
  }
});

test("232. Matrix 3.3: run record missing upstreamCommit -> throws RunGitSnapshotIncompleteError fail closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const head = git(["rev-parse", "HEAD"]).trim();

    const runDir = join(repoDir, ".agent", "runtime", "run-m33");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({
        runId: "run-m33",
        taskId: "TASK-INCOMP-2",
        version: 1,
        state: CindyState.TASK_INITIALIZED,
        currentCycle: 1,
        branch: "main",
        baseCommit: head,
        headCommit: head,
        upstreamRef: "refs/remotes/origin/main",
        allowedScope: ["src/"],
        history: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      "utf8"
    );

    const store = new RuntimeArtifactStore({ repoDir });
    await assert.rejects(
      async () => {
        await store.resolveActiveRunForTask("TASK-INCOMP-2");
      },
      (err: unknown) =>
        err instanceof RunGitSnapshotIncompleteError &&
        err.message.includes("missing required Git authority snapshot field")
    );
  } finally {
    await cleanup();
  }
});

test("233. Matrix 3.4: run record with empty string upstreamRef -> schema/semantic validation fails", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const head = git(["rev-parse", "HEAD"]).trim();

    const runPayload = {
      runId: "run-m34",
      taskId: "TASK-EMPTY-UP",
      version: 1,
      state: CindyState.TASK_INITIALIZED,
      currentCycle: 1,
      branch: "main",
      baseCommit: head,
      headCommit: head,
      taskAuthorityCommit: head,
      upstreamRef: "",
      upstreamCommit: head,
      allowedScope: ["src/"],
      history: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    assert.throws(
      () => {
        validateArtifactBoundary(repoDir, ArtifactKind.RUN, runPayload, {
          runId: "run-m34",
          taskId: "TASK-EMPTY-UP",
        });
      },
      (err: unknown) =>
        err instanceof ArtifactValidationError &&
        err.message.includes("upstreamRef")
    );
  } finally {
    await cleanup();
  }
});

test("234. Matrix 3.5: run record with invalid upstreamCommit format -> schema/semantic validation fails", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const head = git(["rev-parse", "HEAD"]).trim();

    const runPayload = {
      runId: "run-m35",
      taskId: "TASK-BAD-SHA",
      version: 1,
      state: CindyState.TASK_INITIALIZED,
      currentCycle: 1,
      branch: "main",
      baseCommit: head,
      headCommit: head,
      taskAuthorityCommit: head,
      upstreamRef: "refs/remotes/origin/main",
      upstreamCommit: "not-a-40-hex-commit-sha",
      allowedScope: ["src/"],
      history: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    assert.throws(
      () => {
        validateArtifactBoundary(repoDir, ArtifactKind.RUN, runPayload, {
          runId: "run-m35",
          taskId: "TASK-BAD-SHA",
        });
      },
      (err: unknown) =>
        err instanceof ArtifactValidationError &&
        err.message.includes("upstreamCommit")
    );
  } finally {
    await cleanup();
  }
});

test("235. Matrix 3.6: baseline artifact missing upstreamRef/upstreamCommit -> schema validation fails", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const head = git(["rev-parse", "HEAD"]).trim();

    const baselinePayload = {
      runId: "run-m36",
      taskId: "TASK-BASE-INC",
      branch: "main",
      baseCommit: head,
      upstreamSha: head,
      initialTreeClean: true,
      initialTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      recordedAt: new Date().toISOString(),
    };

    assert.throws(
      () => {
        validateArtifactBoundary(repoDir, ArtifactKind.BASELINE, baselinePayload, {
          runId: "run-m36",
          taskId: "TASK-BASE-INC",
        });
      },
      (err: unknown) =>
        err instanceof ArtifactValidationError &&
        err.message.includes("missing required property")
    );
  } finally {
    await cleanup();
  }
});

test("236. Matrix 3.7: evaluateGitAuthority with incomplete snapshot -> fails closed with RUN_GIT_SNAPSHOT_INCOMPLETE", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const head = git(["rev-parse", "HEAD"]).trim();

    const res = evaluateGitAuthority({
      repoDir,
      taskId: "CINDY-ORCH-MVP",
      runSnapshot: {
        branch: "main",
        headCommit: head,
        baseCommit: head,
        // Missing upstreamRef and upstreamCommit
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.stopReason, CindyStopReason.RUN_GIT_SNAPSHOT_INCOMPLETE);
  } finally {
    await cleanup();
  }
});

// --- Group 4: Controlled Resume & No Generic Exit (8 cases) ---

test("237. Matrix 4.1: PAUSED -> RECONCILING via transition() rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-m41", taskId: "CINDY-ORCH-MVP" });
    await orchestrator.transition(run.runId, CindyState.BLOCKED);

    await assert.rejects(
      async () => {
        await orchestrator.transition(run.runId, CindyState.RECONCILING);
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        err.message.includes("controlled resumeRun")
    );
  } finally {
    await cleanup();
  }
});

test("238. Matrix 4.2: PAUSED -> BUILDING via transition() rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-m42", taskId: "CINDY-ORCH-MVP" });
    await orchestrator.transition(run.runId, CindyState.BLOCKED);

    await assert.rejects(
      async () => {
        await orchestrator.transition(run.runId, CindyState.BUILDING);
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        err.message.includes("controlled resumeRun")
    );
  } finally {
    await cleanup();
  }
});

test("239. Matrix 4.3: PAUSED -> READY_TO_COMMIT via transition() rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-m43", taskId: "CINDY-ORCH-MVP" });
    await orchestrator.transition(run.runId, CindyState.BLOCKED);

    await assert.rejects(
      async () => {
        await orchestrator.transition(run.runId, CindyState.READY_TO_COMMIT);
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );
  } finally {
    await cleanup();
  }
});

test("240. Matrix 4.4: allowResumeFromPause does not exist in options (static audit)", async () => {
  const store = new RuntimeArtifactStore({ repoDir: "/tmp" });
  assert.equal(
    typeof (store as unknown as Record<string, unknown>)["allowResumeFromPause"],
    "undefined",
    "allowResumeFromPause must not exist"
  );
});

test("241. Matrix 4.5: controlled resumeRun() transitions directly from PAUSED to pausedFrom (no intermediate RECONCILING in history)", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-m45", taskId: "CINDY-ORCH-MVP" });
    assert.equal(run.state, CindyState.TASK_INITIALIZED);

    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    await writeFile(join(repoDir, "drift-241.txt"), "drift\n", "utf8");
    git(["add", "drift-241.txt"]);
    git(["commit", "-m", "chore: drift 241"]);
    await orchestrator.deriveSafetyStop(run.runId);
    git(["reset", "--hard", "HEAD~1"]);

    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.TASK_INITIALIZED);

    // Verify history does NOT contain intermediate RECONCILING hop
    const states = resumed.history.map((h) => `${h.fromState}->${h.toState}`);
    assert.equal(states.some((s) => s.includes("RECONCILING") && s.includes("GIT_SAFETY_STOP")), false);
    assert.equal(resumed.history[resumed.history.length - 1]?.fromState, CindyState.GIT_SAFETY_STOP);
    assert.equal(resumed.history[resumed.history.length - 1]?.toState, CindyState.TASK_INITIALIZED);
  } finally {
    await cleanup();
  }
});

test("242. Matrix 4.6: resumeRun() when safety cause persists remains in pause state", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-m46", taskId: "CINDY-ORCH-MVP" });

    const rogue = join(repoDir, "persisting-rogue.txt");
    await writeFile(rogue, "dirty", "utf8");

    await orchestrator.deriveSafetyStop(run.runId);

    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.DIRTY_TREE_UNEXPLAINED);
    assert.equal(resumed.stopReason, CindyStopReason.DIRTY_TREE_UNEXPLAINED);
  } finally {
    await cleanup();
  }
});

test("243. Matrix 4.7: resumeRun() when safety cause resolved returns to pausedFrom", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-m47", taskId: "CINDY-ORCH-MVP" });

    const rogue = join(repoDir, "resolving-rogue.txt");
    await writeFile(rogue, "dirty", "utf8");

    await orchestrator.deriveSafetyStop(run.runId);

    await rm(rogue);

    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.TASK_INITIALIZED);
    assert.equal(resumed.stopReason, null);
    assert.equal(resumed.pausedFrom, null);
  } finally {
    await cleanup();
  }
});

test("244. Matrix 4.8: applyResumeTransition blocks deep import bypass when authority checks fail", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-m48", taskId: "CINDY-ORCH-MVP" });

    await orchestrator.transition(run.runId, CindyState.BLOCKED);

    // Tamper git working tree by introducing a dirty file
    await writeFile(join(repoDir, "tamper.txt"), "tamper", "utf8");

    // Attempting deep-import bypass directly via applyResumeTransition
    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.applyResumeTransition(
          run.runId
        );
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        err.message.includes("Cannot resume run")
    );
  } finally {
    await cleanup();
  }
});

// --- Group 5: Run Creation Preflight (6 cases) ---

test("245. Matrix 5.1: initRun with dirty tree throws DirtyTreeUnexplainedError, zero run records on disk", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    await writeFile(join(repoDir, "untracked-init.txt"), "dirty", "utf8");
    const orchestrator = new CindyOrchestrator({ repoDir });

    await assert.rejects(
      async () => {
        await orchestrator.initRun({ runId: "run-m51", taskId: "CINDY-ORCH-MVP" });
      },
      (err: unknown) =>
        err instanceof DirtyTreeUnexplainedError &&
        (err as DirtyTreeUnexplainedError).unexplainedFiles.includes("untracked-init.txt")
    );

    const active = await orchestrator.artifactStore.resolveAllActiveRuns();
    assert.equal(active.length, 0);
  } finally {
    await cleanup();
  }
});

test("246. Matrix 5.2: initRun with missing upstream throws TransitionRejectedError, zero run records on disk", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    git(["branch", "--unset-upstream"]);
    git(["remote", "remove", "origin"]);

    const orchestrator = new CindyOrchestrator({ repoDir });

    await assert.rejects(
      async () => {
        await orchestrator.initRun({ runId: "run-m52", taskId: "CINDY-ORCH-MVP" });
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        err.message.includes("UPSTREAM_MISSING")
    );

    const active = await orchestrator.artifactStore.resolveAllActiveRuns();
    assert.equal(active.length, 0);
  } finally {
    await cleanup();
  }
});

test("247. Matrix 5.3: initRun with ahead upstream throws TransitionRejectedError, zero run records on disk", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    await writeFile(join(repoDir, "local-only.txt"), "local commit", "utf8");
    git(["add", "."]);
    git(["commit", "-m", "chore: local only ahead commit"]);
    // Do NOT push to remote, so local is ahead by 1

    const orchestrator = new CindyOrchestrator({ repoDir });

    await assert.rejects(
      async () => {
        await orchestrator.initRun({ runId: "run-m53", taskId: "CINDY-ORCH-MVP" });
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        err.message.includes("UPSTREAM_AHEAD")
    );

    const active = await orchestrator.artifactStore.resolveAllActiveRuns();
    assert.equal(active.length, 0);
  } finally {
    await cleanup();
  }
});

test("248. Matrix 5.4: initRun with diverged upstream throws TransitionRejectedError, zero run records on disk", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    // Advance remote via a second clone
    const otherDir = await mkdtemp(join(tmpdir(), "cindy-remote-div-"));
    try {
      execFileSync("git", ["clone", "-b", "main", git(["config", "--get", "remote.origin.url"]).trim(), otherDir], { encoding: "utf8" });
      execFileSync("git", ["config", "user.name", "Other Dev"], { cwd: otherDir });
      execFileSync("git", ["config", "user.email", "other@example.com"], { cwd: otherDir });
      await writeFile(join(otherDir, "remote-file.txt"), "remote file", "utf8");
      execFileSync("git", ["add", "."], { cwd: otherDir });
      execFileSync("git", ["commit", "-m", "feat: remote divergence commit"], { cwd: otherDir });
      execFileSync("git", ["push", "-q", "origin", "main"], { cwd: otherDir });
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }

    // Make local commit without pulling
    await writeFile(join(repoDir, "local-div.txt"), "local divergence commit", "utf8");
    git(["add", "."]);
    git(["commit", "-m", "chore: local divergence commit"]);
    // Fetch remote so git tracking knows it's diverged
    git(["fetch", "-q", "origin"]);

    const orchestrator = new CindyOrchestrator({ repoDir });

    await assert.rejects(
      async () => {
        await orchestrator.initRun({ runId: "run-m54", taskId: "CINDY-ORCH-MVP" });
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        err.message.includes("UPSTREAM_DIVERGED")
    );

    const active = await orchestrator.artifactStore.resolveAllActiveRuns();
    assert.equal(active.length, 0);
  } finally {
    await cleanup();
  }
});

test("249. Matrix 5.5: initRun with baseline drift throws TransitionRejectedError, zero run records on disk", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });

    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "run-m55",
          taskId: "CINDY-ORCH-MVP",
          baseCommit: "1111111111111111111111111111111111111111",
        });
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        err.message.includes("BASELINE_MISMATCH")
    );

    const active = await orchestrator.artifactStore.resolveAllActiveRuns();
    assert.equal(active.length, 0);
  } finally {
    await cleanup();
  }
});

test("250. Matrix 5.6: initRun with existing active run throws ActiveRunExistsError, zero new run records on disk", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run1 = await orchestrator.initRun({
      runId: "run-m56-first",
      taskId: "CINDY-ORCH-MVP",
    });
    assert.equal(run1.state, CindyState.TASK_INITIALIZED);

    // Attempt second initRun for same task while first is active
    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "run-m56-second",
          taskId: "CINDY-ORCH-MVP",
        });
      },
      (err: unknown) =>
        err instanceof ActiveRunExistsError &&
        err.message.includes("run-m56-first")
    );

    const active = await orchestrator.artifactStore.resolveAllActiveRuns();
    assert.equal(active.length, 1);
    assert.equal(active[0]?.runId, "run-m56-first");
  } finally {
    await cleanup();
  }
});

// =========================================================================
// R2F2-R3 Targeted Test Matrix & Final Convergence Verification
// =========================================================================

// --- Group 1: Task Authority Commit (Tests 251 - 256) ---

test("251. R3 Matrix 1.1: task.json last modified at A, HEAD=A -> taskAuthorityCommit is A", async () => {
  const { repoDir, initialCommit, cleanup } = await createTempRepo();
  try {
    const packetResult = readCommittedTaskPacket("CINDY-ORCH-MVP", repoDir);
    assert.ok(packetResult);
    assert.equal(packetResult.taskAuthorityCommit, initialCommit);
  } finally {
    await cleanup();
  }
});

test("252. R3 Matrix 1.2: task.json last modified at A, unrelated commit B, HEAD=B -> initRun rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    await writeFile(join(repoDir, "unrelated.txt"), "hello", "utf8");
    git(["add", "."]);
    git(["commit", "-m", "chore: unrelated commit B"]);
    git(["push", "-q", "origin", "main"]);

    const orchestrator = new CindyOrchestrator({ repoDir });
    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "run-r3-m12",
          taskId: "CINDY-ORCH-MVP",
        });
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        err.message.includes("TASK_BASELINE_DRIFT")
    );
  } finally {
    await cleanup();
  }
});

test("253. R3 Matrix 1.3: task.json formally modified in B, HEAD=B -> taskAuthorityCommit=B, initRun succeeds", async () => {
  const { repoDir, baseCommit, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const taskPath = join(repoDir, ".agent", "tasks", "CINDY-ORCH-MVP", "task.json");
    const raw = JSON.parse(await readFile(taskPath, "utf8"));
    raw.title = "Formally updated task in commit B";
    await writeFile(taskPath, JSON.stringify(raw, null, 2), "utf8");
    git(["add", "."]);
    git(["commit", "-m", "feat: activate task in commit B"]);
    git(["push", "-q", "origin", "main"]);

    const newHead = git(["rev-parse", "HEAD"]).trim();

    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-r3-m13",
      taskId: "CINDY-ORCH-MVP",
    });

    assert.equal(run.taskAuthorityCommit, newHead);
    assert.equal(run.baseCommit, baseCommit);
    assert.equal(run.headCommit, newHead);
  } finally {
    await cleanup();
  }
});

test("254. R3 Matrix 1.4: caller expectedBase cannot change taskAuthorityCommit", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    await assert.rejects(
      async () => {
        await orchestrator.initRun({
          runId: "run-r3-m14",
          taskId: "CINDY-ORCH-MVP",
          baseCommit: "0000000000000000000000000000000000000000",
        });
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        err.message.includes("BASELINE_MISMATCH")
    );
  } finally {
    await cleanup();
  }
});

test("255. R3 Matrix 1.5: run.taskAuthorityCommit != current anchor -> reconcile rejects with drift", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const orchestrator = new CindyOrchestrator({ repoDir });
    await orchestrator.initRun({
      runId: "run-r3-m15",
      taskId: "CINDY-ORCH-MVP",
    });

    // Advance HEAD
    await writeFile(join(repoDir, "advance.txt"), "adv", "utf8");
    git(["add", "."]);
    git(["commit", "-m", "chore: advance HEAD"]);
    git(["push", "-q", "origin", "main"]);

    const rec = await reconcileCurrentState({ repoDir, taskId: "CINDY-ORCH-MVP" });
    assert.equal(rec.reconciled, false);
    assert.ok(
      rec.detailedStopReason === CindyStopReason.BASELINE_DRIFT ||
      rec.detailedStopReason === CindyStopReason.HEAD_DRIFT
    );
  } finally {
    await cleanup();
  }
});

test("256. R3 Matrix 1.6: resume anchor drift -> reject", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-r3-m16",
      taskId: "CINDY-ORCH-MVP",
    });

    // Advance HEAD
    await writeFile(join(repoDir, "advance-resume.txt"), "adv", "utf8");
    git(["add", "."]);
    git(["commit", "-m", "chore: advance HEAD while paused"]);
    git(["push", "-q", "origin", "main"]);

    const stopped = await orchestrator.deriveSafetyStop(run.runId);
    assert.equal(stopped.state, CindyState.GIT_SAFETY_STOP);
    assert.equal(stopped.stopReason, CindyStopReason.HEAD_DRIFT);

    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.GIT_SAFETY_STOP);
    assert.equal(resumed.stopReason, CindyStopReason.HEAD_DRIFT);
  } finally {
    await cleanup();
  }
});

// --- Group 2: Concurrent Init (Tests 257 - 261) ---

test("257. R3 Matrix 2.1: two concurrent inits with barrier -> <= 1 succeeds", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator1 = new CindyOrchestrator({ repoDir });
    const orchestrator2 = new CindyOrchestrator({ repoDir });

    let started = 0;
    let releaseBarrier: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const initWrapper = async (orch: CindyOrchestrator, runId: string) => {
      started++;
      if (started === 2) {
        releaseBarrier!();
      }
      await barrier;
      return orch.initRun({ runId, taskId: "CINDY-ORCH-MVP" });
    };

    const results = await Promise.allSettled([
      initWrapper(orchestrator1, "run-conc-1"),
      initWrapper(orchestrator2, "run-conc-2"),
    ]);

    const successes = results.filter((r) => r.status === "fulfilled");
    assert.ok(successes.length <= 1, `Expected at most 1 init to succeed, got ${successes.length}`);
  } finally {
    await cleanup();
  }
});

test("258. R3 Matrix 2.2: after concurrent init, total active run count is <= 1", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const activeRuns = await orchestrator.artifactStore.resolveAllActiveRuns();
    assert.ok(activeRuns.length <= 1);
  } finally {
    await cleanup();
  }
});

test("259. R3 Matrix 2.3: second caller retry after init throws ActiveRunExistsError", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    await orchestrator.initRun({ runId: "run-first-259", taskId: "CINDY-ORCH-MVP" });

    await assert.rejects(
      async () => {
        await orchestrator.initRun({ runId: "run-second-259", taskId: "CINDY-ORCH-MVP" });
      },
      (err: unknown) => err instanceof ActiveRunExistsError
    );
  } finally {
    await cleanup();
  }
});

test("260. R3 Matrix 2.4: init lock live contention throws ConcurrentInitError fail closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const os = await import("node:os");
    const lockMeta = {
      ownerId: "synthetic-live-holder",
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
    };
    const lockPath = join(repoDir, ".agent", "runtime", ".init.lock");
    await mkdir(join(repoDir, ".agent", "runtime"), { recursive: true });
    await writeFile(lockPath, JSON.stringify(lockMeta), "utf8");

    await assert.rejects(
      async () => {
        await orchestrator.initRun({ runId: "run-contention-260", taskId: "CINDY-ORCH-MVP" });
      },
      (err: unknown) => err instanceof ConcurrentInitError
    );
  } finally {
    await cleanup();
  }
});

test("261. R3 Matrix 2.5: stale init lock does not automatically reclaim and throws StaleInitLockError", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const os = await import("node:os");
    const lockMeta = {
      ownerId: "dead-owner",
      pid: 99999999, // Unlikely to exist
      hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
    };
    const lockPath = join(repoDir, ".agent", "runtime", ".init.lock");
    await mkdir(join(repoDir, ".agent", "runtime"), { recursive: true });
    await writeFile(lockPath, JSON.stringify(lockMeta), "utf8");

    await assert.rejects(
      async () => {
        await orchestrator.initRun({ runId: "run-stale-261", taskId: "CINDY-ORCH-MVP" });
      },
      (err: unknown) => err instanceof StaleInitLockError
    );

    // Verify .init.lock was NOT automatically deleted/reclaimed
    assert.equal(existsSync(lockPath), true);
  } finally {
    await cleanup();
  }
});

// --- Group 3: Malformed Run (Tests 262 - 266) ---

test("262. R3 Matrix 3.1: malformed JSON taskId on same line fails closed with InvalidRunRecordError", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const runDir = join(repoDir, ".agent", "runtime", "run-malformed-31");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run.json"), '{"taskId": "CINDY-ORCH-MVP", broken-here', "utf8");

    const store = new RuntimeArtifactStore({ repoDir });
    await assert.rejects(
      async () => {
        await store.resolveActiveRunForTask("CINDY-ORCH-MVP");
      },
      (err: unknown) => err instanceof InvalidRunRecordError
    );
  } finally {
    await cleanup();
  }
});

test("263. R3 Matrix 3.2: newline between taskId and colon fails closed with InvalidRunRecordError", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const runDir = join(repoDir, ".agent", "runtime", "run-malformed-32");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run.json"), '{"taskId"\n: "CINDY-ORCH-MVP", broken-content', "utf8");

    const store = new RuntimeArtifactStore({ repoDir });
    await assert.rejects(
      async () => {
        await store.resolveActiveRunForTask("CINDY-ORCH-MVP");
      },
      (err: unknown) => err instanceof InvalidRunRecordError
    );
  } finally {
    await cleanup();
  }
});

test("264. R3 Matrix 3.3: truncated JSON fails closed with InvalidRunRecordError", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const runDir = join(repoDir, ".agent", "runtime", "run-malformed-33");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run.json"), '{"taskId": "CINDY-ORCH-MVP"', "utf8");

    const store = new RuntimeArtifactStore({ repoDir });
    await assert.rejects(
      async () => {
        await store.resolveActiveRunForTask("CINDY-ORCH-MVP");
      },
      (err: unknown) => err instanceof InvalidRunRecordError
    );
  } finally {
    await cleanup();
  }
});

test("265. R3 Matrix 3.4: schema-invalid run fails closed with InvalidRunRecordError", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const runDir = join(repoDir, ".agent", "runtime", "run-malformed-34");
    await mkdir(runDir, { recursive: true });
    // Valid JSON but missing required fields according to cindy-run schema
    await writeFile(join(runDir, "run.json"), JSON.stringify({ runId: "bad", state: "TASK_INITIALIZED" }), "utf8");

    const store = new RuntimeArtifactStore({ repoDir });
    await assert.rejects(
      async () => {
        await store.resolveActiveRunForTask("CINDY-ORCH-MVP");
      },
      (err: unknown) => err instanceof InvalidRunRecordError
    );
  } finally {
    await cleanup();
  }
});

test("266. R3 Matrix 3.5: cannot guess task ownership through regex: fails repository-level", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const runDir = join(repoDir, ".agent", "runtime", "run-malformed-35");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run.json"), 'some random prefix taskId : CINDY-ORCH-MVP invalid json', "utf8");

    const store = new RuntimeArtifactStore({ repoDir });
    await assert.rejects(
      async () => {
        await store.resolveAllActiveRuns();
      },
      (err: unknown) => err instanceof InvalidRunRecordError
    );
  } finally {
    await cleanup();
  }
});

// --- Group 4: Current Pointer (Tests 267 - 272) ---

test("267. R3 Matrix 4.1: pointer taskId wrong cannot change unique active authority", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-ptr-41",
      taskId: "CINDY-ORCH-MVP",
    });

    await writeFile(
      join(repoDir, ".agent", "current.json"),
      JSON.stringify({ task: "WRONG-TASK", runId: run.runId, status: "READY" }),
      "utf8"
    );

    const rec = await reconcileCurrentState({ repoDir });
    assert.equal(rec.currentTaskId, "CINDY-ORCH-MVP");
    assert.equal(rec.resolvedStatus, "TASK_INITIALIZED");
    assert.equal(rec.pointerHealth, "MISMATCH");
  } finally {
    await cleanup();
  }
});

test("268. R3 Matrix 4.2: pointer runId wrong cannot create authority", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    await orchestrator.initRun({
      runId: "run-ptr-42-real",
      taskId: "CINDY-ORCH-MVP",
    });

    await writeFile(
      join(repoDir, ".agent", "current.json"),
      JSON.stringify({ task: "CINDY-ORCH-MVP", runId: "ghost-runId-42", status: "READY" }),
      "utf8"
    );

    const rec = await reconcileCurrentState({ repoDir });
    assert.equal(rec.resolvedStatus, "TASK_INITIALIZED");
    assert.equal(rec.pointerHealth, "MISMATCH");
  } finally {
    await cleanup();
  }
});

test("269. R3 Matrix 4.3: pointer status=CLOSED but active run=TASK_INITIALIZED -> status authority remains TASK_INITIALIZED", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-ptr-43",
      taskId: "CINDY-ORCH-MVP",
    });

    await writeFile(
      join(repoDir, ".agent", "current.json"),
      JSON.stringify({ task: "CINDY-ORCH-MVP", runId: run.runId, status: "CLOSED" }),
      "utf8"
    );

    const rec = await reconcileCurrentState({ repoDir });
    assert.equal(rec.taskAlreadyClosed, false);
    assert.equal(rec.resolvedStatus, CindyState.TASK_INITIALIZED);
  } finally {
    await cleanup();
  }
});

test("270. R3 Matrix 4.4: current.json missing, unique active run -> normal resolution", async () => {
  const { repoDir, cleanup } = await createTempRepo({ withoutCurrentJson: true });
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    await orchestrator.initRun({
      runId: "run-ptr-44",
      taskId: "CINDY-ORCH-MVP",
    });

    const rec = await reconcileCurrentState({ repoDir });
    assert.equal(rec.reconciled, true);
    assert.equal(rec.currentTaskId, "CINDY-ORCH-MVP");
    assert.equal(rec.resolvedStatus, CindyState.TASK_INITIALIZED);
  } finally {
    await cleanup();
  }
});

test("271. R3 Matrix 4.5: 0 active + pointer only -> cannot select task solely by pointer", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    await writeFile(
      join(repoDir, ".agent", "current.json"),
      JSON.stringify({ task: "GHOST_TASK_UNCOMMITTED", status: "READY" }),
      "utf8"
    );

    const rec = await reconcileCurrentState({ repoDir });
    assert.equal(rec.reconciled, false);
    assert.equal(rec.detailedStopReason, CindyStopReason.CURRENT_TASK_UNRESOLVED);
  } finally {
    await cleanup();
  }
});

test("272. R3 Matrix 4.6: >1 active -> pointer cannot disambiguate", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const now = new Date().toISOString();
    const run1: CindyRun = {
      runId: "run-m46-a",
      taskId: "TEST-TASK-001",
      version: 1,
      state: CindyState.TASK_INITIALIZED,
      currentCycle: 1,
      branch: "main",
      baseCommit: "0".repeat(40),
      headCommit: "0".repeat(40),
      taskAuthorityCommit: "0".repeat(40),
      upstreamRef: "refs/remotes/origin/main",
      upstreamCommit: "0".repeat(40),
      upstreamSha: "0".repeat(40),
      allowedScope: ["src/"],
      boundTreeDigest: "0".repeat(64),
      stopReason: null,
      stopExplanation: null,
      history: [],
      createdAt: now,
      updatedAt: now,
    };
    const run2: CindyRun = {
      ...run1,
      runId: "run-m46-b",
      taskId: "TEST-TASK-002",
    };
    const runDir1 = join(repoDir, ".agent", "runtime", "run-m46-a");
    await mkdir(runDir1, { recursive: true });
    await writeFile(join(runDir1, "run.json"), JSON.stringify(run1, null, 2), "utf8");

    const runDir2 = join(repoDir, ".agent", "runtime", "run-m46-b");
    await mkdir(runDir2, { recursive: true });
    await writeFile(join(runDir2, "run.json"), JSON.stringify(run2, null, 2), "utf8");

    await writeFile(
      join(repoDir, ".agent", "current.json"),
      JSON.stringify({ task: "TEST-TASK-001", runId: "run-m46-a", status: "READY" }),
      "utf8"
    );

    const rec = await reconcileCurrentState({ repoDir });
    assert.equal(rec.reconciled, false);
    assert.equal(rec.detailedStopReason, CindyStopReason.AMBIGUOUS_ACTIVE_RUN);
  } finally {
    await cleanup();
  }
});

// --- Group 5: Pause Security & Resume Policies (Tests 273 - 283) ---

test("273. R3 Matrix 5.1: recordSafetyStopOnPausedRun capability does not exist on store or orchestrator", () => {
  const store = new RuntimeArtifactStore({ repoDir: "/tmp" });
  const orch = new CindyOrchestrator({ repoDir: "/tmp" });
  assert.equal((store as unknown as Record<string, unknown>).recordSafetyStopOnPausedRun, undefined);
  assert.equal((orch as unknown as Record<string, unknown>).recordSafetyStopOnPausedRun, undefined);
});

test("274. R3 Matrix 5.2: deep import cannot transition new run -> CLOSED", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-sec-52",
      taskId: "CINDY-ORCH-MVP",
    });

    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.applyAdministrativeTransition(run.runId, CindyState.CLOSED);
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        err.message.includes("privileged state")
    );
  } finally {
    await cleanup();
  }
});

test("275. R3 Matrix 5.3: PRODUCT_DECISION_REQUIRED -> BLOCKED generic transition rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-sec-53",
      taskId: "CINDY-ORCH-MVP",
    });

    await orchestrator.transition(run.runId, CindyState.PRODUCT_DECISION_REQUIRED);

    await assert.rejects(
      async () => {
        await orchestrator.transition(run.runId, CindyState.BLOCKED);
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        err.message.includes("pause state")
    );
  } finally {
    await cleanup();
  }
});

test("276. R3 Matrix 5.4: PRODUCT_DECISION_REQUIRED without committed approval -> resume rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-sec-54",
      taskId: "CINDY-ORCH-MVP",
    });

    await orchestrator.transition(run.runId, CindyState.PRODUCT_DECISION_REQUIRED);

    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.PRODUCT_DECISION_REQUIRED);
  } finally {
    await cleanup();
  }
});

test("277. R3 Matrix 5.5: CONTRACT_CONFLICT without committed resolution -> resume rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-sec-55",
      taskId: "CINDY-ORCH-MVP",
    });

    await orchestrator.transition(run.runId, CindyState.CONTRACT_CONFLICT);

    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.CONTRACT_CONFLICT);
  } finally {
    await cleanup();
  }
});

test("278. R3 Matrix 5.6: MIGRATION_OR_SECURITY_AMBIGUITY without committed resolution -> resume rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-sec-56",
      taskId: "CINDY-ORCH-MVP",
    });

    await orchestrator.transition(run.runId, CindyState.MIGRATION_OR_SECURITY_AMBIGUITY);

    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.MIGRATION_OR_SECURITY_AMBIGUITY);
  } finally {
    await cleanup();
  }
});

test("279. R3 Matrix 5.7: BLOCKED without structured resolution -> resume rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-sec-57",
      taskId: "CINDY-ORCH-MVP",
    });

    await orchestrator.transition(run.runId, CindyState.BLOCKED);

    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.BLOCKED);
  } finally {
    await cleanup();
  }
});

test("280. R3 Matrix 5.8: DIRTY_TREE_UNEXPLAINED cause cleared -> controlled resume succeeds", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-sec-58",
      taskId: "CINDY-ORCH-MVP",
    });

    const rogue = join(repoDir, "rogue-sec-58.txt");
    await writeFile(rogue, "dirty", "utf8");

    await orchestrator.deriveSafetyStop(run.runId);

    await rm(rogue);

    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.TASK_INITIALIZED);
  } finally {
    await cleanup();
  }
});

test("281. R3 Matrix 5.9: GIT_SAFETY_STOP cause restored -> controlled resume succeeds", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-sec-59",
      taskId: "CINDY-ORCH-MVP",
    });

    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    await writeFile(join(repoDir, "drift.txt"), "drift\n", "utf8");
    git(["add", "drift.txt"]);
    git(["commit", "-m", "chore: cause head drift"]);

    await orchestrator.deriveSafetyStop(run.runId);

    // Restore cause
    git(["reset", "--hard", "HEAD~1"]);

    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.TASK_INITIALIZED);
  } finally {
    await cleanup();
  }
});

test("282. R3 Matrix 5.10: failed resume must not overwrite original stopReason", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-sec-510",
      taskId: "CINDY-ORCH-MVP",
    });

    await orchestrator.transition(run.runId, CindyState.PRODUCT_DECISION_REQUIRED, {
      stopReason: CindyStopReason.PRODUCT_DECISION_REQUIRED,
    });

    // Tamper git working tree by dirty file
    await writeFile(join(repoDir, "tamper-510.txt"), "dirty", "utf8");

    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.PRODUCT_DECISION_REQUIRED);
    assert.equal(resumed.stopReason, CindyStopReason.PRODUCT_DECISION_REQUIRED);
  } finally {
    await cleanup();
  }
});

test("283. R3 Matrix 5.11: failed resume must not change pausedFrom", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({
      runId: "run-sec-511",
      taskId: "CINDY-ORCH-MVP",
    });

    await orchestrator.transition(run.runId, CindyState.BLOCKED);
    assert.equal(run.state, CindyState.TASK_INITIALIZED);

    // Tamper git working tree
    await writeFile(join(repoDir, "tamper-511.txt"), "dirty", "utf8");

    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.pausedFrom, CindyState.TASK_INITIALIZED);
  } finally {
    await cleanup();
  }
});

// --- Group 6: Dirty Path Exactness (Tests 284 - 288) ---

test("284. R3 Matrix 6.1: 'src/a.ts ' cannot match 'src/a.ts'", () => {
  const scope = ["src/a.ts"];
  const res = checkDirtyTreeOwnership(scope, ["src/a.ts "]);
  assert.equal(res.ok, false);
  assert.deepEqual(res.unexplainedFiles, ["src/a.ts "]);
});

test("285. R3 Matrix 6.2: ' src/a.ts' keeps exact leading whitespace", () => {
  const scope = ["src/a.ts"];
  const res = checkDirtyTreeOwnership(scope, [" src/a.ts"]);
  assert.equal(res.ok, false);
  assert.deepEqual(res.unexplainedFiles, [" src/a.ts"]);
});

test("286. R3 Matrix 6.3: tab filename keeps exact whitespace", () => {
  const scope = ["src/a.ts"];
  const res = checkDirtyTreeOwnership(scope, ["src/\ta.ts"]);
  assert.equal(res.ok, false);
  assert.deepEqual(res.unexplainedFiles, ["src/\ta.ts"]);
});

test("287. R3 Matrix 6.4: newline filename keeps exact whitespace", () => {
  const scope = ["src/a.ts"];
  const res = checkDirtyTreeOwnership(scope, ["src/\na.ts"]);
  assert.equal(res.ok, false);
  assert.deepEqual(res.unexplainedFiles, ["src/\na.ts"]);
});

test("288. R3 Matrix 6.5: rename old/new whitespace are both correctly judged", () => {
  const scope = ["src/"];
  // Old inside, new outside -> reject
  const res1 = checkDirtyTreeOwnership(scope, ["src/old.ts", "other/ new.ts"]);
  assert.equal(res1.ok, false);
  assert.deepEqual(res1.unexplainedFiles, ["other/ new.ts"]);

  // Old and new both inside scope with whitespace
  const res2 = checkDirtyTreeOwnership(scope, ["src/old name.ts", "src/new name.ts"]);
  assert.equal(res2.ok, true);
  assert.equal(res2.unexplainedFiles.length, 0);
});

// --- Group 7: Concurrency Stability 20x Repetition (Test 289) ---

test("289. R3 Matrix 7.1: 20x repetition of concurrent init asserts active run count <= 1", async () => {
  for (let i = 0; i < 20; i++) {
    const { repoDir, cleanup } = await createTempRepo();
    try {
      const orchestrator1 = new CindyOrchestrator({ repoDir });
      const orchestrator2 = new CindyOrchestrator({ repoDir });

      let started = 0;
      let releaseBarrier: () => void;
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });

      const initWrapper = async (orch: CindyOrchestrator, runId: string) => {
        started++;
        if (started === 2) {
          releaseBarrier!();
        }
        await barrier;
        return orch.initRun({ runId, taskId: "CINDY-ORCH-MVP" });
      };

      const results = await Promise.allSettled([
        initWrapper(orchestrator1, `run-rep-${i}-1`),
        initWrapper(orchestrator2, `run-rep-${i}-2`),
      ]);

      const successes = results.filter((r) => r.status === "fulfilled");
      assert.ok(successes.length <= 1, `Iteration ${i}: Expected <= 1 success, got ${successes.length}`);

      const allActive = await orchestrator1.artifactStore.resolveAllActiveRuns();
      assert.ok(allActive.length <= 1, `Iteration ${i}: Expected <= 1 active run on disk, got ${allActive.length}`);
    } finally {
      await cleanup();
    }
  }
});

// =========================================================================
// R2F2-R4: Trust Boundary Final Closure Tests (Tests 290 - 316)
// =========================================================================

// --- Architecture Decision P: Manual Pause Policy & Auto-Resume Disallowance ---

test("290. R4 AD-P: resumeRun on PRODUCT_DECISION_REQUIRED unconditionally fails closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-ad-p-1", taskId: "CINDY-ORCH-MVP" });
    await orchestrator.artifactStore.applyAdministrativeTransition(run.runId, CindyState.PRODUCT_DECISION_REQUIRED, {
      reason: "Needs product decision",
    });

    // High-level orchestrator resume keeps run paused and unchanged
    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.PRODUCT_DECISION_REQUIRED);

    // Direct low-level store transition throws TransitionRejectedError
    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.applyResumeTransition(run.runId);
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        err.message.includes("PRODUCT_DECISION_REQUIRED requires manual resolution")
    );
  } finally {
    await cleanup();
  }
});

test("291. R4 AD-P: resumeRun on CONTRACT_CONFLICT unconditionally fails closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-ad-p-2", taskId: "CINDY-ORCH-MVP" });
    await orchestrator.artifactStore.applyAdministrativeTransition(run.runId, CindyState.CONTRACT_CONFLICT, {
      reason: "Contract conflict detected",
    });

    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.CONTRACT_CONFLICT);

    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.applyResumeTransition(run.runId);
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        err.message.includes("CONTRACT_CONFLICT requires manual resolution")
    );
  } finally {
    await cleanup();
  }
});

test("292. R4 AD-P: resumeRun on MIGRATION_OR_SECURITY_AMBIGUITY unconditionally fails closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-ad-p-3", taskId: "CINDY-ORCH-MVP" });
    await orchestrator.artifactStore.applyAdministrativeTransition(run.runId, CindyState.MIGRATION_OR_SECURITY_AMBIGUITY, {
      reason: "Security ambiguity detected",
    });

    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.MIGRATION_OR_SECURITY_AMBIGUITY);

    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.applyResumeTransition(run.runId);
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        err.message.includes("MIGRATION_OR_SECURITY_AMBIGUITY requires manual resolution")
    );
  } finally {
    await cleanup();
  }
});

test("293. R4 AD-P: resumeRun on BLOCKED unconditionally fails closed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-ad-p-4", taskId: "CINDY-ORCH-MVP" });
    await orchestrator.artifactStore.applyAdministrativeTransition(run.runId, CindyState.BLOCKED, {
      reason: "Run blocked by external dependency",
    });

    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.BLOCKED);

    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.applyResumeTransition(run.runId);
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        err.message.includes("BLOCKED requires manual resolution")
    );
  } finally {
    await cleanup();
  }
});

test("294. R4 AD-P: resumeRun on DIRTY_TREE_UNEXPLAINED succeeds once dirty files are cleared", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-ad-p-5", taskId: "CINDY-ORCH-MVP" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);

    const dirtyFilePath = join(repoDir, "rogue.txt");
    await writeFile(dirtyFilePath, "dirty", "utf8");

    await orchestrator.deriveSafetyStop(run.runId);

    // While dirty file persists: resume fails
    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.applyResumeTransition(run.runId);
      },
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        err.message.includes("DIRTY_TREE_UNEXPLAINED")
    );

    // Remove dirty file: resume succeeds to BUILDING
    await rm(dirtyFilePath);
    const resumed = await orchestrator.resumeRun(run.runId);
    assert.equal(resumed.state, CindyState.BUILDING);
  } finally {
    await cleanup();
  }
});

// --- Architecture Decision Q: taskAuthorityCommit & 5-Way Equality ---

test("295. R4 AD-Q: CindyRun schema rejects missing taskAuthorityCommit", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const head = git(["rev-parse", "HEAD"]).trim();

    const runPayload = {
      runId: "run-ad-q-missing-tac",
      taskId: "CINDY-ORCH-MVP",
      version: 1,
      state: CindyState.TASK_INITIALIZED,
      currentCycle: 1,
      branch: "main",
      baseCommit: head,
      headCommit: head,
      // taskAuthorityCommit is intentionally omitted
      upstreamRef: "refs/remotes/origin/main",
      upstreamCommit: head,
      allowedScope: ["src/"],
      history: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    assert.throws(
      () => {
        validateArtifactBoundary(repoDir, ArtifactKind.RUN, runPayload, {
          runId: "run-ad-q-missing-tac",
          taskId: "CINDY-ORCH-MVP",
        });
      },
      (err: unknown) =>
        err instanceof ArtifactValidationError &&
        err.message.includes("taskAuthorityCommit")
    );
  } finally {
    await cleanup();
  }
});

test("296. R4 AD-Q: BaselineArtifact schema rejects missing taskAuthorityCommit", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const head = git(["rev-parse", "HEAD"]).trim();

    const baselinePayload = {
      runId: "run-ad-q-baseline",
      taskId: "CINDY-ORCH-MVP",
      branch: "main",
      baseCommit: head,
      // taskAuthorityCommit is omitted
      upstreamRef: "refs/remotes/origin/main",
      upstreamCommit: head,
      initialTreeClean: true,
      initialTreeDigest: "0".repeat(64),
      recordedAt: new Date().toISOString(),
    };

    assert.throws(
      () => {
        validateArtifactBoundary(repoDir, ArtifactKind.BASELINE, baselinePayload, {
          runId: "run-ad-q-baseline",
          taskId: "CINDY-ORCH-MVP",
        });
      },
      (err: unknown) =>
        err instanceof ArtifactValidationError &&
        err.message.includes("taskAuthorityCommit")
    );
  } finally {
    await cleanup();
  }
});

test("297. R4 AD-Q: 5-way equality: evaluateGitAuthority rejects run when taskAuthorityCommit != currentTask.taskAuthorityCommit", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const head = git(["rev-parse", "HEAD"]).trim();
    const up = getGitUpstream(repoDir)!;

    const res = evaluateGitAuthority({
      repoDir,
      taskId: "CINDY-ORCH-MVP",
      runSnapshot: {
        branch: "main",
        headCommit: head,
        baseCommit: head,
        taskAuthorityCommit: "1".repeat(40), // Does not match currentTask authority commit
        upstreamSha: up.commit,
        upstreamRef: up.ref,
        upstreamCommit: up.commit,
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.stopReason, CindyStopReason.TASK_PACKET_DRIFT);
  } finally {
    await cleanup();
  }
});

test("298. R4 AD-Q: 5-way equality: evaluateGitAuthority rejects run when baseCommit != taskAuthorityCommit", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const head = git(["rev-parse", "HEAD"]).trim();
    const up = getGitUpstream(repoDir)!;

    const res = evaluateGitAuthority({
      repoDir,
      taskId: "CINDY-ORCH-MVP",
      runSnapshot: {
        branch: "main",
        headCommit: head,
        baseCommit: "2".repeat(40), // Mismatched baseCommit
        taskAuthorityCommit: head,
        upstreamSha: up.commit,
        upstreamRef: up.ref,
        upstreamCommit: up.commit,
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.stopReason, CindyStopReason.BASELINE_MISMATCH);
  } finally {
    await cleanup();
  }
});

test("299. R4 AD-Q: 5-way equality: evaluateGitAuthority rejects run when headCommit != taskAuthorityCommit", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const head = git(["rev-parse", "HEAD"]).trim();
    const up = getGitUpstream(repoDir)!;

    const res = evaluateGitAuthority({
      repoDir,
      taskId: "CINDY-ORCH-MVP",
      runSnapshot: {
        branch: "main",
        headCommit: "3".repeat(40), // Mismatched headCommit
        baseCommit: head,
        taskAuthorityCommit: head,
        upstreamSha: up.commit,
        upstreamRef: up.ref,
        upstreamCommit: up.commit,
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.stopReason, CindyStopReason.BASELINE_MISMATCH);
  } finally {
    await cleanup();
  }
});

test("300. R4 AD-Q: 5-way equality: evaluateGitAuthority succeeds when all 5 parts match", async () => {
  const { repoDir, baseCommit, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const head = git(["rev-parse", "HEAD"]).trim();
    const up = getGitUpstream(repoDir)!;

    const res = evaluateGitAuthority({
      repoDir,
      taskId: "CINDY-ORCH-MVP",
      runSnapshot: {
        branch: "main",
        headCommit: head,
        baseCommit: baseCommit,
        taskAuthorityCommit: head,
        upstreamSha: up.commit,
        upstreamRef: up.ref,
        upstreamCommit: up.commit,
      },
    });

    assert.equal(res.ok, true);
    assert.equal(res.stopReason, null);
  } finally {
    await cleanup();
  }
});

test("301. R4 AD-Q: resolveActiveRunForTask throws RunGitSnapshotIncompleteError if taskAuthorityCommit is missing", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const head = git(["rev-parse", "HEAD"]).trim();

    const runDir = join(repoDir, ".agent", "runtime", "run-missing-tac");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({
        runId: "run-missing-tac",
        taskId: "TASK-1",
        version: 1,
        state: CindyState.TASK_INITIALIZED,
        currentCycle: 1,
        branch: "main",
        baseCommit: head,
        headCommit: head,
        // taskAuthorityCommit is missing
        upstreamRef: "refs/remotes/origin/main",
        upstreamCommit: head,
        allowedScope: ["src/"],
        history: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      "utf8"
    );

    const store = new RuntimeArtifactStore({ repoDir });
    await assert.rejects(
      async () => {
        await store.resolveActiveRunForTask("TASK-1");
      },
      (err: unknown) =>
        err instanceof RunGitSnapshotIncompleteError &&
        err.message.includes("missing required Git authority snapshot field")
    );
  } finally {
    await cleanup();
  }
});

// --- Architecture Decision R: POSIX Path Semantics & Git Filename Literals ---

test("302. R4 AD-R: validateScopeEntry rejects backslash in scope entry", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    assert.throws(
      () => validateScopeEntry("src\\auth", repoDir),
      (err: unknown) =>
        err instanceof PathTraversalError &&
        err.message.includes("cannot contain backslash")
    );
  } finally {
    await cleanup();
  }
});

test("303. R4 AD-R: scope 'src/' does not authorize literal backslash file 'src\\rogue.ts'", () => {
  const inScope = isFileInScope("src\\rogue.ts", "src/");
  assert.equal(inScope, false, "Scope 'src/' must NOT match literal backslash path 'src\\rogue.ts'");
});

test("304. R4 AD-R: checkDirtyTreeOwnership flags 'src\\rogue.ts' as unexplained when scope is ['src/']", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const result = checkDirtyTreeOwnership(["src/"], ["src\\rogue.ts"], repoDir);
    assert.equal(result.ok, false);
    assert.deepEqual(result.unexplainedFiles, ["src\\rogue.ts"]);
  } finally {
    await cleanup();
  }
});

// --- Architecture Decision S: No Generic Git Command Runner Exported ---

test("305. R4 AD-S: runGitReadOnly is unexported; only typed readers exist", async () => {
  const gitMod = await import("../tools/cindy/git.ts");
  assert.strictEqual(
    (gitMod as unknown as Record<string, unknown>).runGitReadOnly,
    undefined,
    "runGitReadOnly must be internal and not exported"
  );
  assert.strictEqual(typeof gitMod.getGitStatus, "function");
  assert.strictEqual(typeof gitMod.getGitHead, "function");
  assert.strictEqual(typeof gitMod.getGitBranch, "function");
  assert.strictEqual(typeof gitMod.getGitUpstream, "function");
  assert.strictEqual(typeof gitMod.getGitDiffHead, "function");
  assert.strictEqual(typeof gitMod.getGitUntrackedFiles, "function");
  assert.strictEqual(typeof gitMod.getGitIndexBlobSha, "function");
  assert.strictEqual(typeof gitMod.readCommittedFileAtHead, "function");
  assert.strictEqual(typeof gitMod.readCommittedClosure, "function");
  assert.strictEqual(typeof gitMod.readCommittedTaskPacket, "function");
  assert.strictEqual(typeof gitMod.getTaskAuthorityCommit, "function");
  assert.strictEqual(typeof gitMod.isGitAncestor, "function");
  assert.strictEqual(typeof gitMod.checkGitUpstreamStatus, "function");
  assert.strictEqual(typeof gitMod.evaluateGitAuthority, "function");
});

// --- Architecture Decision T: Strict Task ID Validation ---

test("306. R4 AD-T: validateTaskId rejects '.' and '..'", () => {
  assert.throws(() => validateTaskId("."), (err: unknown) => err instanceof InvalidTaskIdError);
  assert.throws(() => validateTaskId(".."), (err: unknown) => err instanceof InvalidTaskIdError);
});

test("307. R4 AD-T: validateTaskId rejects slashes and backslashes", () => {
  assert.throws(() => validateTaskId("foo/bar"), (err: unknown) => err instanceof InvalidTaskIdError);
  assert.throws(() => validateTaskId("foo\\bar"), (err: unknown) => err instanceof InvalidTaskIdError);
  assert.throws(() => validateTaskId("../traversal"), (err: unknown) => err instanceof InvalidTaskIdError);
});

test("308. R4 AD-T: validateTaskId rejects whitespace", () => {
  assert.throws(() => validateTaskId("foo bar"), (err: unknown) => err instanceof InvalidTaskIdError);
  assert.throws(() => validateTaskId(" foo"), (err: unknown) => err instanceof InvalidTaskIdError);
  assert.throws(() => validateTaskId("foo "), (err: unknown) => err instanceof InvalidTaskIdError);
});

test("309. R4 AD-T: validateTaskId rejects control characters (null byte, newline, tab)", () => {
  assert.throws(() => validateTaskId("foo\0bar"), (err: unknown) => err instanceof InvalidTaskIdError);
  assert.throws(() => validateTaskId("foo\nbar"), (err: unknown) => err instanceof InvalidTaskIdError);
  assert.throws(() => validateTaskId("foo\rbar"), (err: unknown) => err instanceof InvalidTaskIdError);
  assert.throws(() => validateTaskId("foo\tbar"), (err: unknown) => err instanceof InvalidTaskIdError);
});

test("310. R4 AD-T: validateTaskId accepts valid identifiers", () => {
  assert.doesNotThrow(() => validateTaskId("TASK-001"));
  assert.doesNotThrow(() => validateTaskId("CINDY-ORCH-MVP"));
  assert.doesNotThrow(() => validateTaskId("feature_1.2-alpha"));
});

test("311. R4 AD-T: readCommittedTaskPacket throws if committed packet taskId does not match requested taskId", async () => {
  const { repoDir, baseCommit, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const taskDir = join(repoDir, ".agent", "tasks", "TASK-MISMATCH-ID");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, "task.json"),
      JSON.stringify({
        taskId: "TASK-DIFFERENT-ID",
        branch: "main",
        baseCommit: baseCommit,
        allowedScope: ["src/"],
      }, null, 2),
      "utf8"
    );
    git(["add", "."]);
    git(["commit", "-m", "chore: add mismatched taskId packet"]);

    assert.throws(
      () => readCommittedTaskPacket("TASK-MISMATCH-ID", repoDir),
      (err: unknown) =>
        err instanceof ArtifactValidationError &&
        err.message.includes("taskId mismatch")
    );
  } finally {
    await cleanup();
  }
});

// --- Architecture Decision U: Elimination of Raw createInitialRun Bypass ---

test("312. R4 AD-U: RuntimeArtifactStore has no createInitialRun bypass", () => {
  const store = new RuntimeArtifactStore({ repoDir: "/tmp" });
  assert.strictEqual((store as unknown as Record<string, unknown>).createInitialRun, undefined);
  assert.strictEqual(typeof store.initializeRunSafely, "function");
});

test("313. R4 AD-U: initializeRunSafely creates both run.json and baseline.json atomically", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const run = await store.initializeRunSafely({
      runId: "run-init-atomically",
      taskId: "CINDY-ORCH-MVP",
    });

    assert.equal(run.state, CindyState.TASK_INITIALIZED);
    assert.ok(run.taskAuthorityCommit);

    const baseline = await store.readArtifact<Record<string, unknown>>("run-init-atomically", ArtifactKind.BASELINE);
    assert.ok(baseline);
    assert.equal(baseline.taskAuthorityCommit, run.taskAuthorityCommit);
    assert.equal(baseline.baseCommit, run.baseCommit);
  } finally {
    await cleanup();
  }
});

// --- Architecture Decision V: Init Lock Failure Injections ---

test("314. R4 AD-V: acquireInitLock cleans up candidate and leaves .init.lock untouched on candidate write failure", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const runtimeDir = join(repoDir, ".agent", "runtime");
    await mkdir(runtimeDir, { recursive: true });

    // Existing main lock
    const mainLockPath = join(runtimeDir, ".init.lock");
    await writeFile(mainLockPath, "main-lock-content", "utf8");

    // Acquire will fail or time out, but must NOT alter existing main lock
    await assert.rejects(
      async () => {
        await store.acquireInitLock();
      },
      (err: unknown) => err instanceof ConcurrentInitError
    );

    // Main lock still exists with original content
    const content = await readFile(mainLockPath, "utf8");
    assert.equal(content, "main-lock-content");

    // Clean up main lock for test hygiene
    await rm(mainLockPath);
  } finally {
    await cleanup();
  }
});

test("315. R4 AD-V: releaseInitLock with wrong ownerId throws ConcurrentInitError and does not unlink .init.lock", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const { ownerId, lockPath } = await store.acquireInitLock();

    // Attempt release with wrong ownerId
    await assert.rejects(
      async () => {
        await store.releaseInitLock("wrong-owner-id");
      },
      (err: unknown) =>
        err instanceof ConcurrentInitError &&
        err.message.includes("owner mismatch")
    );

    // Lock still exists
    assert.equal(existsSync(lockPath), true);

    // Release with correct ownerId
    await store.releaseInitLock(ownerId);
    assert.equal(existsSync(lockPath), false);
  } finally {
    await cleanup();
  }
});

// --- Architecture Decision W: Documentation Update Verification ---

test("316. R4 AD-W: documentation records Architecture Decisions P through W", async () => {
  const docPath = join(process.cwd(), "docs", "development", "cindy-orchestration.md");
  const docContent = await readFile(docPath, "utf8");
  assert.ok(docContent.includes("DECISION P"));
  assert.ok(docContent.includes("DECISION Q"));
  assert.ok(docContent.includes("DECISION R"));
  assert.ok(docContent.includes("DECISION S"));
  assert.ok(docContent.includes("DECISION T"));
  assert.ok(docContent.includes("DECISION U"));
  assert.ok(docContent.includes("DECISION V"));
  assert.ok(docContent.includes("DECISION W"));
});

// =========================================================================
// R6: Public Mutation Surface Final Seal Tests
// =========================================================================

test("R6 B01: withAuthorizedRunMutation physically removed from RuntimeArtifactStore.prototype", () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(RuntimeArtifactStore.prototype, "withAuthorizedRunMutation"),
    false,
    "withAuthorizedRunMutation must not exist on RuntimeArtifactStore.prototype"
  );
  assert.equal(
    (RuntimeArtifactStore.prototype as unknown as Record<string, unknown>).withAuthorizedRunMutation,
    undefined,
    "withAuthorizedRunMutation must be undefined on prototype"
  );

  // Strict whitelist of public prototype methods on RuntimeArtifactStore
  const protoProps = Object.getOwnPropertyNames(RuntimeArtifactStore.prototype).filter(
    (p) => p !== "constructor"
  );
  const allowedMethods = new Set([
    "getRunDir",
    "getArtifactPath",
    "resolveActiveRunForTask",
    "resolveAllActiveRuns",
    "getRun",
    "readArtifact",
    "listArtifacts",
    "acquireRunLock",
    "releaseRunLock",
    "acquireInitLock",
    "releaseInitLock",
    "withInitLock",
    "recordArtifact",
    "recordTestResult",
    "recordDiffManifest",
    "recordReviewRequest",
    "recordReviewResult",
    "initializeRunSafely",
    "applyAdministrativeTransition",
    "applyResumeTransition",
  ]);

  for (const prop of protoProps) {
    assert.ok(
      allowedMethods.has(prop),
      `Unexpected property/method '${prop}' found on RuntimeArtifactStore.prototype`
    );
  }
  assert.ok(!protoProps.includes("writeBoundEvidenceInternal"), "writeBoundEvidenceInternal must not be on prototype");
  assert.ok(!protoProps.includes("recordBoundEvidence"), "recordBoundEvidence must not be on prototype");
});

test("R6 B01: deepFreeze recursively seals object graph preventing in-place mutation", () => {
  const obj = {
    runId: "run-freeze-test",
    currentCycle: 1,
    history: [{ state: "INIT", timestamp: "2026-09-29T00:00:00.000Z" }],
    allowedScope: ["src/", "tools/"],
  };

  const frozen = deepFreeze(obj);
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Object.isFrozen(frozen.history), true);
  assert.equal(Object.isFrozen(frozen.history[0]), true);
  assert.equal(Object.isFrozen(frozen.allowedScope), true);

  assert.throws(() => {
    (frozen as Record<string, unknown>).currentCycle = 2;
  }, TypeError);

  assert.throws(() => {
    frozen.history.push({ state: "NEXT", timestamp: "2026-09-29T01:00:00.000Z" });
  }, TypeError);
});

test("R6 B01: executeSemanticTransition validates state machine and rejects arbitrary or invalid transitions", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-sem-invalid", taskId: "TEST-TASK-001" });
    const store = new RuntimeArtifactStore({ repoDir });

    // Cannot jump from TASK_INITIALIZED to BUILDING or COMPLETE or REVIEWING
    await assert.rejects(
      () =>
        executeSemanticTransition(store, run.runId, {
          type: "startBuilding",
        }),
      (err: unknown) => err instanceof TransitionRejectedError
    );

    await assert.rejects(
      () =>
        executeSemanticTransition(store, run.runId, {
          type: "completeBuilding",
        }),
      (err: unknown) => err instanceof TransitionRejectedError
    );

    await assert.rejects(
      () =>
        executeSemanticTransition(store, run.runId, {
          type: "startReview",
          reviewer: { identity: "Reviewer Cindy", session: "sess-1", readOnlyConfirmed: true },
        }),
      (err: unknown) => err instanceof TransitionRejectedError
    );

    const currentRun = await store.getRun(run.runId);
    assert.equal(currentRun?.state, CindyState.TASK_INITIALIZED);
  } finally {
    await cleanup();
  }
});

test("R6 B01: generic raw writer cannot promote state-driving evidence", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-raw-evidence", taskId: "TEST-TASK-001" });
    const store = new RuntimeArtifactStore({ repoDir });
    await assert.rejects(
      store.recordArtifact(
        run.runId,
        ArtifactKind.TEST_RESULT,
        { status: "PASS" },
        { cycle: run.currentCycle, authoritative: true }
      ),
      ArtifactValidationError
    );
    await assert.rejects(
      orchestrator.recordArtifact(
        run.runId,
        ArtifactKind.REVIEW_RESULT,
        { verdict: "PASS" },
        { cycle: run.currentCycle, authoritative: true }
      ),
      ArtifactValidationError
    );
    assert.equal(await store.readArtifact(run.runId, ArtifactKind.TEST_RESULT, run.currentCycle), null);
    assert.equal(await store.readArtifact(run.runId, ArtifactKind.REVIEW_RESULT, run.currentCycle), null);
  } finally {
    await cleanup();
  }
});

test("R6 B01: administrative transition cannot forge pausedFrom to skip builder stages", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-admin-pause", taskId: "TEST-TASK-001" });
    const store = new RuntimeArtifactStore({ repoDir });

    const pausedRun = await store.applyAdministrativeTransition(run.runId, CindyState.BLOCKED, {
      stopReason: CindyStopReason.BLOCKED,
    });
    assert.equal(pausedRun.state, CindyState.BLOCKED);
    assert.equal(pausedRun.pausedFrom, CindyState.TASK_INITIALIZED);
  } finally {
    await cleanup();
  }
});

test("R6 B01: live authority drift (HEAD drift) before CAS write is detected and rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-head-drift", taskId: "TEST-TASK-001" });

    // Drift HEAD by committing a new file
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    await writeFile(join(repoDir, "drift.txt"), "drift content\n", "utf8");
    git(["add", "drift.txt"]);
    git(["commit", "-m", "chore: cause head drift"]);

    // Attempting forward transition must fail closed due to live authority check
    await assert.rejects(
      () => orchestrator.markReadyForBuilder(run.runId),
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        (err.message.includes("HEAD_DRIFT") || err.message.includes("HEAD drift") || err.message.includes("Live repository authority"))
    );

    const store = new RuntimeArtifactStore({ repoDir });
    const currentRun = await store.getRun(run.runId);
    assert.equal(currentRun?.state, CindyState.TASK_INITIALIZED);
  } finally {
    await cleanup();
  }
});

test("R6 M03: unknown runId in recordArtifact fails closed without creating orphan directory", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const store = new RuntimeArtifactStore({ repoDir });
    const unknownRunId = "run-unknown-m03-" + Date.now();
    const orphanRunDir = join(repoDir, ".agent", "runtime", unknownRunId);

    await assert.rejects(
      () =>
        store.recordArtifact(
          unknownRunId,
          ArtifactKind.DIFF_MANIFEST,
          { files: [] },
          { cycle: 1 }
        ),
      (err: unknown) =>
        err instanceof ArtifactValidationError && (err.message.includes("non-existent") || err.message.includes("unknown"))
    );

    assert.equal(
      existsSync(orphanRunDir),
      false,
      "Runtime directory must NOT be created for unknown runId"
    );
  } finally {
    await cleanup();
  }
});

test("R6 H01: Task Packet strictly requires branch, 40-hex baseCommit, and allowedScope (no fallbacks)", async () => {
  const { repoDir, baseCommit, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

    // Missing branch
    const dirNoBranch = join(repoDir, ".agent", "tasks", "TASK-NO-BRANCH");
    await mkdir(dirNoBranch, { recursive: true });
    await writeFile(
      join(dirNoBranch, "task.json"),
      JSON.stringify({ taskId: "TASK-NO-BRANCH", baseCommit, allowedScope: ["src/"] }, null, 2),
      "utf8"
    );

    // Missing baseCommit
    const dirNoBase = join(repoDir, ".agent", "tasks", "TASK-NO-BASE");
    await mkdir(dirNoBase, { recursive: true });
    await writeFile(
      join(dirNoBase, "task.json"),
      JSON.stringify({ taskId: "TASK-NO-BASE", branch: "main", allowedScope: ["src/"] }, null, 2),
      "utf8"
    );

    // Invalid baseCommit format (not 40-hex)
    const dirBadBase = join(repoDir, ".agent", "tasks", "TASK-BAD-BASE");
    await mkdir(dirBadBase, { recursive: true });
    await writeFile(
      join(dirBadBase, "task.json"),
      JSON.stringify({ taskId: "TASK-BAD-BASE", branch: "main", baseCommit: "not-a-40-hex-sha", allowedScope: ["src/"] }, null, 2),
      "utf8"
    );

    // Missing allowedScope
    const dirNoScope = join(repoDir, ".agent", "tasks", "TASK-NO-SCOPE");
    await mkdir(dirNoScope, { recursive: true });
    await writeFile(
      join(dirNoScope, "task.json"),
      JSON.stringify({ taskId: "TASK-NO-SCOPE", branch: "main", baseCommit }, null, 2),
      "utf8"
    );

    // Empty allowedScope (schema valid per Decision AO)
    const dirEmptyScope = join(repoDir, ".agent", "tasks", "TASK-EMPTY-SCOPE");
    await mkdir(dirEmptyScope, { recursive: true });
    await writeFile(
      join(dirEmptyScope, "task.json"),
      JSON.stringify({ taskId: "TASK-EMPTY-SCOPE", branch: "main", baseCommit, allowedScope: [] }, null, 2),
      "utf8"
    );

    git(["add", "."]);
    git(["commit", "-m", "chore: commit invalid task packets"]);

    assert.throws(
      () => readCommittedTaskPacket("TASK-NO-BRANCH", repoDir),
      (err: unknown) => err instanceof ArtifactValidationError
    );

    assert.throws(
      () => readCommittedTaskPacket("TASK-NO-BASE", repoDir),
      (err: unknown) => err instanceof ArtifactValidationError
    );

    assert.throws(
      () => readCommittedTaskPacket("TASK-BAD-BASE", repoDir),
      (err: unknown) => err instanceof ArtifactValidationError
    );

    assert.throws(
      () => readCommittedTaskPacket("TASK-NO-SCOPE", repoDir),
      (err: unknown) => err instanceof ArtifactValidationError
    );

    // Empty scope is schema-valid
    const emptyResult = readCommittedTaskPacket("TASK-EMPTY-SCOPE", repoDir);
    assert.ok(emptyResult);
    assert.deepEqual(emptyResult.allowedScope, []);
  } finally {
    await cleanup();
  }
});

test("R6 H02: readCommittedTaskPacket rejects legacy .agent/tasks/<taskId>.json flat file path", async () => {
  const { repoDir, baseCommit, cleanup } = await createTempRepo();
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

    // Write legacy flat file .agent/tasks/TASK-LEGACY-FLAT.json without directory
    await writeFile(
      join(repoDir, ".agent", "tasks", "TASK-LEGACY-FLAT.json"),
      JSON.stringify({ taskId: "TASK-LEGACY-FLAT", branch: "main", baseCommit, allowedScope: ["src/"] }, null, 2),
      "utf8"
    );
    git(["add", "."]);
    git(["commit", "-m", "chore: add flat legacy task file"]);

    // readCommittedTaskPacket must look ONLY at .agent/tasks/<taskId>/task.json and return null
    assert.equal(readCommittedTaskPacket("TASK-LEGACY-FLAT", repoDir), null);

    const orchestrator = new CindyOrchestrator({ repoDir });
    await assert.rejects(
      () => orchestrator.initRun({ taskId: "TASK-LEGACY-FLAT", runId: "run-legacy-flat" }),
      (err: unknown) => err instanceof TaskPacketNotCommittedError
    );
  } finally {
    await cleanup();
  }
});

test("R6 M01: importLegacyTask validates taskId and rejects missing or mismatched taskId without backfill", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    // Missing taskId
    const dirMissing = join(repoDir, ".agent", "tasks", "TASK-MISSING-ID");
    await mkdir(dirMissing, { recursive: true });
    const missingContent = JSON.stringify({ status: "CLOSED", branch: "main" }, null, 2);
    await writeFile(join(dirMissing, "task.json"), missingContent, "utf8");

    await assert.rejects(
      () => importLegacyTask("TASK-MISSING-ID", { repoDir }),
      (err: unknown) => err instanceof ArtifactValidationError && err.message.includes("missing") && err.message.includes("taskId")
    );

    // Verify file on disk was NOT modified (no backfill)
    const fileAfterMissing = await readFile(join(dirMissing, "task.json"), "utf8");
    assert.equal(fileAfterMissing, missingContent, "importLegacyTask must not backfill missing taskId on disk");

    // Mismatched taskId
    const dirMismatch = join(repoDir, ".agent", "tasks", "TASK-DIR-NAME");
    await mkdir(dirMismatch, { recursive: true });
    const mismatchContent = JSON.stringify({ taskId: "DIFFERENT-ID", status: "CLOSED", branch: "main" }, null, 2);
    await writeFile(join(dirMismatch, "task.json"), mismatchContent, "utf8");

    await assert.rejects(
      () => importLegacyTask("TASK-DIR-NAME", { repoDir }),
      (err: unknown) => err instanceof ArtifactValidationError && err.message.includes("taskId mismatch")
    );

    // Verify file on disk was NOT modified
    const fileAfterMismatch = await readFile(join(dirMismatch, "task.json"), "utf8");
    assert.equal(fileAfterMismatch, mismatchContent, "importLegacyTask must not mutate mismatched taskId on disk");
  } finally {
    await cleanup();
  }
});

// =========================================================================
// R2F2-R6-R1: Privileged-State Regression Fix Tests
// =========================================================================

test("R6-R1 1-4: valid bound ReviewResult PASS records immutable evidence, state remains REVIEWING, never enters FINAL_GATE or READY_TO_COMMIT", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-r6r1-pass", taskId: "TASK-R6R1" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const tree = await orchestrator.computeCurrentTreeDigest();
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: tree,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
    await orchestrator.prepareForReview(run.runId);
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Reviewer Cindy", session: "sess-pass-1", readOnlyConfirmed: true },
    });

    const diff = await orchestrator.computeCurrentDiffDigest();
    const reviewResultPayload: ReviewResultArtifact = {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Reviewer Cindy", session: "sess-pass-1", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: tree,
      reviewedDiffDigest: diff,
      verdict: "PASS" as const,
      findings: [],
      recordedAt: new Date().toISOString(),
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    };

    // Test both recordReviewPass and recordValidatedReviewResult
    const afterPass = await orchestrator.recordReviewPass(run.runId, reviewResultPayload);

    // 1. State remains REVIEWING
    assert.equal(afterPass.state, CindyState.REVIEWING, "In-memory state must remain REVIEWING");
    const onDiskRun = await orchestrator.getRun(run.runId);
    assert.equal(onDiskRun.state, CindyState.REVIEWING, "On-disk state must remain REVIEWING");

    // 2. PASS evidence successfully recorded and verified
    const passEvidence = await orchestrator.consumeReviewPass(run.runId, 1);
    assert.equal(passEvidence.verdict, "PASS");
    assert.equal(passEvidence.trustClassification, "STRUCTURE_VALID_EXTERNAL");

    // Immutability: conflicting overwrite rejected
    await assert.rejects(
      async () => {
            const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
        await orchestrator.recordValidatedReviewResult(
          run.runId,
          { ...reviewResultPayload, verdict: "FAIL" as const,
              executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
              executionSnapshotDigest: snap.digest
        }
        );
      },
      (err: unknown) => err instanceof ConflictingArtifactError || err instanceof ArtifactValidationError
    );

    // 3. PASS does NOT produce FINAL_GATE
    assert.notEqual(afterPass.state, CindyState.FINAL_GATE);
    assert.notEqual(onDiskRun.state, CindyState.FINAL_GATE);

    // 4. PASS does NOT produce READY_TO_COMMIT
    assert.notEqual(afterPass.state, CindyState.READY_TO_COMMIT);
    assert.notEqual(onDiskRun.state, CindyState.READY_TO_COMMIT);
  } finally {
    await cleanup();
  }
});

test("R6-R1 5: SemanticOperation union has no consumeReviewPass -> FINAL_GATE or equivalent operation", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-r6r1-noop", taskId: "TASK-NOOP" });
    const store = orchestrator.artifactStore;

    // Passing unrecognized operation like consumeReviewPass or enterFinalGate is rejected
    await assert.rejects(
      () =>
        executeSemanticTransition(store, run.runId, {
          type: "consumeReviewPass",
        } as unknown as Parameters<typeof executeSemanticTransition>[2]),
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        (err as Error).message.includes("Unrecognized semantic operation type 'consumeReviewPass'")
    );

    await assert.rejects(
      () =>
        executeSemanticTransition(store, run.runId, {
          type: "finalGate",
        } as unknown as Parameters<typeof executeSemanticTransition>[2]),
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        (err as Error).message.includes("Unrecognized semantic operation type 'finalGate'")
    );
  } finally {
    await cleanup();
  }
});

test("R6-R1 6: RuntimeArtifactStore deep import cannot transition REVIEWING -> FINAL_GATE", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-r6r1-deep", taskId: "TASK-DEEP" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const tree = await orchestrator.computeCurrentTreeDigest();
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: tree,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
    await orchestrator.prepareForReview(run.runId);
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Reviewer Cindy", session: "sess-deep-1", readOnlyConfirmed: true },
    });

    const currentRun = await orchestrator.getRun(run.runId);
    assert.equal(currentRun.state, CindyState.REVIEWING);

    // Deep import direct store call: applyAdministrativeTransition to FINAL_GATE must fail
    await assert.rejects(
      () => orchestrator.artifactStore.applyAdministrativeTransition(run.runId, CindyState.FINAL_GATE),
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        (err as Error).message.includes("sealed and prohibited in Control Plane MVP")
    );

    // executeSemanticTransition with targetState: FINAL_GATE must fail
    await assert.rejects(
      () =>
        executeSemanticTransition(orchestrator.artifactStore, run.runId, {
          type: "administrative",
          targetState: CindyState.FINAL_GATE,
        }),
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        (err as Error).message.includes("sealed and prohibited in Control Plane MVP")
    );

    // State machine direct check
    assert.equal(canTransition(CindyState.REVIEWING, CindyState.FINAL_GATE), false);
    assert.throws(
      () => validateTransition(CindyState.REVIEWING, CindyState.FINAL_GATE),
      (err: unknown) => err instanceof TransitionRejectedError
    );
    assert.throws(
      () => validateTransition(CindyState.REVIEWING, CindyState.FINAL_GATE, { allowEvidenceGated: true }),
      (err: unknown) => err instanceof TransitionRejectedError
    );

    // Run remains REVIEWING
    const freshRun = await orchestrator.getRun(run.runId);
    assert.equal(freshRun.state, CindyState.REVIEWING);
  } finally {
    await cleanup();
  }
});

test("R6-R1 7: CindyOrchestrator public API cannot transition REVIEWING -> FINAL_GATE", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-r6r1-pub", taskId: "TASK-PUB" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const tree = await orchestrator.computeCurrentTreeDigest();
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: tree,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
    await orchestrator.prepareForReview(run.runId);
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Reviewer Cindy", session: "sess-pub-1", readOnlyConfirmed: true },
    });

    // Public generic transition to FINAL_GATE
    await assert.rejects(
      () => orchestrator.transition(run.runId, CindyState.FINAL_GATE),
      (err: unknown) => err instanceof TransitionRejectedError
    );

    // Public recordValidatedFinalGateResult
    await assert.rejects(
      () => orchestrator.recordValidatedFinalGateResult(run.runId, { verdict: "PASS", boundTreeDigest: tree }),
      (err: unknown) =>
        err instanceof TransitionRejectedError &&
        (err as Error).message.includes("FEATURE_NOT_AVAILABLE_IN_CONTROL_PLANE_MVP")
    );

    // State remains in REVIEWING
    const freshRun = await orchestrator.getRun(run.runId);
    assert.equal(freshRun.state, CindyState.REVIEWING);
  } finally {
    await cleanup();
  }
});

test("R6-R1 8: Any non-privileged state cannot transition to any privileged state via semantic operation or state machine", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-r6r1-all-priv", taskId: "TASK-ALL-PRIV" });

    const nonPrivilegedStates: CindyState[] = [
      CindyState.RECONCILING,
      CindyState.TASK_INITIALIZED,
      CindyState.READY_FOR_BUILDER,
      CindyState.BUILDING,
      CindyState.BUILDER_COMPLETE,
      CindyState.TESTING,
      CindyState.READY_FOR_REVIEW,
      CindyState.REVIEWING,
      CindyState.REPAIR_INITIALIZED,
      CindyState.REPAIR_BUILDING,
      CindyState.PRODUCT_DECISION_REQUIRED,
      CindyState.BLOCKED,
      CindyState.CONTRACT_CONFLICT,
      CindyState.DIRTY_TREE_UNEXPLAINED,
      CindyState.GIT_SAFETY_STOP,
      CindyState.MIGRATION_OR_SECURITY_AMBIGUITY,
    ];

    const privilegedStatesList = Array.from(PRIVILEGED_STATES);

    for (const fromState of nonPrivilegedStates) {
      for (const privState of privilegedStatesList) {
        assert.equal(
          canTransition(fromState, privState),
          false,
          `canTransition(${fromState}, ${privState}) must be false`
        );
        assert.throws(
          () => validateTransition(fromState, privState),
          (err: unknown) => err instanceof TransitionRejectedError,
          `validateTransition(${fromState}, ${privState}) must reject`
        );
        assert.throws(
          () => validateTransition(fromState, privState, { allowEvidenceGated: true }),
          (err: unknown) => err instanceof TransitionRejectedError,
          `validateTransition(${fromState}, ${privState}, allowEvidenceGated) must reject`
        );
      }
    }

    // Direct transition to any privileged state via store administrative transition is rejected
    for (const privState of privilegedStatesList) {
      await assert.rejects(
        () => orchestrator.artifactStore.applyAdministrativeTransition(run.runId, privState),
        (err: unknown) => err instanceof TransitionRejectedError
      );
      await assert.rejects(
        () =>
          executeSemanticTransition(orchestrator.artifactStore, run.runId, {
            type: "administrative",
            targetState: privState,
          }),
        (err: unknown) => err instanceof TransitionRejectedError
      );
    }
  } finally {
    await cleanup();
  }
});

test("R6-R1 9: Valid FAIL successfully enters approved repair flow", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-r6r1-fail-ok", taskId: "TASK-FAIL-OK" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const tree = await orchestrator.computeCurrentTreeDigest();
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: tree,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
    await orchestrator.prepareForReview(run.runId);
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Reviewer Cindy", session: "sess-fail-1", readOnlyConfirmed: true },
    });

    const diff = await orchestrator.computeCurrentDiffDigest();
    const repairInitRun = await orchestrator.recordValidatedReviewResult(run.runId, {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Reviewer Cindy", session: "sess-fail-1", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: tree,
      reviewedDiffDigest: diff,
      verdict: "FAIL",
      findings: [
        {
          id: "FINDING-R6R1-01",
          severity: "HIGH",
          title: "Logic bug found in review",
        },
      ],
      recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });

    // Valid FAIL transitions to REPAIR_INITIALIZED
    assert.equal(repairInitRun.state, CindyState.REPAIR_INITIALIZED);
    assert.equal(repairInitRun.currentCycle, 2);

    // Can progress into REPAIR_BUILDING
    const repairBuildingRun = await orchestrator.startRepairBuilding(run.runId);
    assert.equal(repairBuildingRun.state, CindyState.REPAIR_BUILDING);
  } finally {
    await cleanup();
  }
});

test("R6-R1 10: Invalid or mismatched FAIL cannot enter repair flow", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-r6r1-fail-bad", taskId: "TASK-FAIL-BAD" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const tree = await orchestrator.computeCurrentTreeDigest();
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: tree,
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
    await orchestrator.prepareForReview(run.runId);
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Reviewer Cindy", session: "sess-bad-fail", readOnlyConfirmed: true },
    });

    const diff = await orchestrator.computeCurrentDiffDigest();

    // 1. Mismatched cycle
    await assert.rejects(
      () =>
        orchestrator.recordValidatedReviewResult(run.runId, {
          runId: run.runId,
          taskId: run.taskId,
          cycle: 99, // Mismatched cycle
          reviewer: { identity: "Reviewer Cindy", session: "sess-bad-fail", readOnlyConfirmed: true },
          reviewedBaseCommit: run.baseCommit,
          reviewedTreeDigest: tree,
          reviewedDiffDigest: diff,
          verdict: "FAIL",
          findings: [{ id: "F1", severity: "HIGH", title: "Error" }],
          recordedAt: new Date().toISOString(),
            executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
            executionSnapshotDigest: snap.digest
        }),
      (err: unknown) => err instanceof ArtifactValidationError
    );

    // 2. Mismatched taskId
    await assert.rejects(
      () =>
        orchestrator.recordValidatedReviewResult(run.runId, {
          runId: run.runId,
          taskId: "WRONG-TASK",
          cycle: 1,
          reviewer: { identity: "Reviewer Cindy", session: "sess-bad-fail", readOnlyConfirmed: true },
          reviewedBaseCommit: run.baseCommit,
          reviewedTreeDigest: tree,
          reviewedDiffDigest: diff,
          verdict: "FAIL",
          findings: [{ id: "F1", severity: "HIGH", title: "Error" }],
          recordedAt: new Date().toISOString(),
            executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
            executionSnapshotDigest: snap.digest
        }),
      (err: unknown) => err instanceof ArtifactValidationError
    );

    // 3. Mismatched treeDigest
    await assert.rejects(
      () =>
        orchestrator.recordValidatedReviewResult(run.runId, {
          runId: run.runId,
          taskId: run.taskId,
          cycle: 1,
          reviewer: { identity: "Reviewer Cindy", session: "sess-bad-fail", readOnlyConfirmed: true },
          reviewedBaseCommit: run.baseCommit,
          reviewedTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
          reviewedDiffDigest: diff,
          verdict: "FAIL",
          findings: [{ id: "F1", severity: "HIGH", title: "Error" }],
          recordedAt: new Date().toISOString(),
            executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
            executionSnapshotDigest: snap.digest
        }),
      (err: unknown) => err instanceof ArtifactDigestMismatchError
    );

    // 4. Mismatched reviewer session
    await assert.rejects(
      () =>
        orchestrator.recordValidatedReviewResult(run.runId, {
          runId: run.runId,
          taskId: run.taskId,
          cycle: 1,
          reviewer: { identity: "Reviewer Cindy", session: "wrong-session", readOnlyConfirmed: true },
          reviewedBaseCommit: run.baseCommit,
          reviewedTreeDigest: tree,
          reviewedDiffDigest: diff,
          verdict: "FAIL",
          findings: [{ id: "F1", severity: "HIGH", title: "Error" }],
          recordedAt: new Date().toISOString(),
            executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
            executionSnapshotDigest: snap.digest
        }),
      (err: unknown) => err instanceof ArtifactValidationError
    );

    // Verify run NEVER entered repair flow: state remains REVIEWING, cycle remains 1
    const runAfterErrors = await orchestrator.getRun(run.runId);
    assert.equal(runAfterErrors.state, CindyState.REVIEWING);
    assert.equal(runAfterErrors.currentCycle, 1);
  } finally {
    await cleanup();
  }
});

// ============================================================================
// R2F2-R6-R2 FINDINGS & ARCHITECTURAL DECISIONS (AS, AT, AU, AV)
// ============================================================================

// Helper to advance a run to REVIEWING cleanly
async function advanceRunToReviewing(orchestrator: CindyOrchestrator, runId: string, reviewerSession = "sess-rev-1") {
  await orchestrator.markReadyForBuilder(runId);
  await orchestrator.startBuilding(runId);
  await orchestrator.completeBuilding(runId);
  await orchestrator.startTesting(runId);

  const run = await orchestrator.getRun(runId);
  const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
  const tree = await orchestrator.computeCurrentTreeDigest();
  await orchestrator.recordTestResult(runId, {
    cycle: 1,
    command: "pnpm test",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    exitCode: 0,
    boundTreeDigest: tree,
    logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
    status: "PASS",
    executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
    executionSnapshotDigest: snap.digest,
  });
  await orchestrator.recordDiffManifest(runId, {
    executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
    executionSnapshotDigest: snap.digest,
  });
  await orchestrator.prepareForReview(runId);
  await orchestrator.startReview(runId, {
    reviewer: { identity: "Reviewer Cindy", session: reviewerSession, readOnlyConfirmed: true, readOnlyRequired: true },
  });
}

// -----------------------------
// STORED REVIEW RESULT (Tests 1-8)
// -----------------------------

test("1. R6-R2 AS: REVIEWING with no review-result file rejects caller-provided FAIL", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-1-fail", taskId: "TEST-TASK-001" });
    await advanceRunToReviewing(orchestrator, run.runId, "sess-1");

    // Direct semantic transition with no stored review-result file must fail
    await assert.rejects(
      async () => {
        await executeSemanticTransition(orchestrator.artifactStore, run.runId, {
          type: "recordValidatedReviewResult",
          verdict: "FAIL",
          review: {
            runId: run.runId,
            taskId: run.taskId,
            cycle: 1,
            reviewer: { identity: "Reviewer Cindy", session: "sess-1", readOnlyConfirmed: true },
            reviewedBaseCommit: run.baseCommit,
            reviewedTreeDigest: await orchestrator.computeCurrentTreeDigest(),
            reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
            verdict: "FAIL",
            findings: [{ id: "F1", severity: "HIGH", title: "Error" }],
            recordedAt: new Date().toISOString(),
            executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
            executionSnapshotDigest: (await orchestrator.computeCurrentExecutionSnapshot(run.taskId)).digest,
          },
        });
      },
      (err: unknown) =>
        err instanceof ArtifactValidationError &&
        (err as Error).message.includes("state-driving review result must be stored on disk")
    );

    const check = await orchestrator.getRun(run.runId);
    assert.equal(check.state, CindyState.REVIEWING);
    assert.equal(check.currentCycle, 1);
  } finally {
    await cleanup();
  }
});

test("2. R6-R2 AS: REVIEWING with no stored PASS rejects direct PASS semantic transition", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-2-pass", taskId: "TEST-TASK-001" });
    await advanceRunToReviewing(orchestrator, run.runId, "sess-2");

    await assert.rejects(
      async () => {
        await executeSemanticTransition(orchestrator.artifactStore, run.runId, {
          type: "recordValidatedReviewResult",
          verdict: "PASS",
        });
      },
      (err: unknown) =>
        err instanceof ArtifactValidationError &&
        (err as Error).message.includes("state-driving review result must be stored on disk")
    );
  } finally {
    await cleanup();
  }
});

test("3. R6-R2 AS: stored FAIL with wrong runId is rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-3-run", taskId: "TEST-TASK-001" });
    await advanceRunToReviewing(orchestrator, run.runId, "sess-3");

    await assert.rejects(
      async () => {
            const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
        await orchestrator.recordValidatedReviewResult(run.runId, {
          runId: "wrong-run-id",
          taskId: run.taskId,
          cycle: 1,
          reviewer: { identity: "Reviewer Cindy", session: "sess-3", readOnlyConfirmed: true },
          reviewedBaseCommit: run.baseCommit,
          reviewedTreeDigest: await orchestrator.computeCurrentTreeDigest(),
          reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
          verdict: "FAIL",
          findings: [{ id: "F1", severity: "HIGH", title: "Error" }],
          recordedAt: new Date().toISOString(),
            executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
            executionSnapshotDigest: snap.digest
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
  } finally {
    await cleanup();
  }
});

test("4. R6-R2 AS: stored FAIL with wrong cycle is rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-4-cyc", taskId: "TEST-TASK-001" });
    await advanceRunToReviewing(orchestrator, run.runId, "sess-4");

    await assert.rejects(
      async () => {
            const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
        await orchestrator.recordValidatedReviewResult(run.runId, {
          runId: run.runId,
          taskId: run.taskId,
          cycle: 99,
          reviewer: { identity: "Reviewer Cindy", session: "sess-4", readOnlyConfirmed: true },
          reviewedBaseCommit: run.baseCommit,
          reviewedTreeDigest: await orchestrator.computeCurrentTreeDigest(),
          reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
          verdict: "FAIL",
          findings: [{ id: "F1", severity: "HIGH", title: "Error" }],
          recordedAt: new Date().toISOString(),
            executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
            executionSnapshotDigest: snap.digest
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
  } finally {
    await cleanup();
  }
});

test("5. R6-R2 AS: stored FAIL with wrong reviewer session is rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-5-sess", taskId: "TEST-TASK-001" });
    await advanceRunToReviewing(orchestrator, run.runId, "sess-5-expected");

    await assert.rejects(
      async () => {
            const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
        await orchestrator.recordValidatedReviewResult(run.runId, {
          runId: run.runId,
          taskId: run.taskId,
          cycle: 1,
          reviewer: { identity: "Reviewer Cindy", session: "sess-5-wrong", readOnlyConfirmed: true },
          reviewedBaseCommit: run.baseCommit,
          reviewedTreeDigest: await orchestrator.computeCurrentTreeDigest(),
          reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
          verdict: "FAIL",
          findings: [{ id: "F1", severity: "HIGH", title: "Error" }],
          recordedAt: new Date().toISOString(),
            executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
            executionSnapshotDigest: snap.digest
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
  } finally {
    await cleanup();
  }
});

test("6. R6-R2 AS: stored FAIL with wrong tree is rejected", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-6-tree", taskId: "TEST-TASK-001" });
    await advanceRunToReviewing(orchestrator, run.runId, "sess-6");

    await assert.rejects(
      async () => {
            const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
        await orchestrator.recordValidatedReviewResult(run.runId, {
          runId: run.runId,
          taskId: run.taskId,
          cycle: 1,
          reviewer: { identity: "Reviewer Cindy", session: "sess-6", readOnlyConfirmed: true },
          reviewedBaseCommit: run.baseCommit,
          reviewedTreeDigest: "0000000000000000000000000000000000000000000000000000000000000000",
          reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
          verdict: "FAIL",
          findings: [{ id: "F1", severity: "HIGH", title: "Error" }],
          recordedAt: new Date().toISOString(),
            executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
            executionSnapshotDigest: snap.digest
        });
      },
      (err: unknown) => err instanceof ArtifactDigestMismatchError
    );
  } finally {
    await cleanup();
  }
});

test("7. R6-R2 AS: stored valid FAIL transitions to REPAIR_INITIALIZED and advances cycle", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-7-valid-fail", taskId: "TEST-TASK-001" });
    await advanceRunToReviewing(orchestrator, run.runId, "sess-7");

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const res = await orchestrator.recordValidatedReviewResult(run.runId, {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Reviewer Cindy", session: "sess-7", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: await orchestrator.computeCurrentTreeDigest(),
      reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
      verdict: "FAIL",
      findings: [{ id: "F1", severity: "HIGH", title: "Fix needed" }],
      recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });

    assert.equal(res.state, CindyState.REPAIR_INITIALIZED);
    assert.equal(res.currentCycle, 2);
  } finally {
    await cleanup();
  }
});

test("8. R6-R2 AS: stored valid PASS leaves state in REVIEWING", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-8-valid-pass", taskId: "TEST-TASK-001" });
    await advanceRunToReviewing(orchestrator, run.runId, "sess-8");

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const res = await orchestrator.recordValidatedReviewResult(run.runId, {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Reviewer Cindy", session: "sess-8", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: await orchestrator.computeCurrentTreeDigest(),
      reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
      verdict: "PASS",
      findings: [],
      recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });

    assert.equal(res.state, CindyState.REVIEWING);
    assert.equal(res.currentCycle, 1);
  } finally {
    await cleanup();
  }
});

// -----------------------------
// PASS & FAIL IDEMPOTENCY (Tests 9-13)
// -----------------------------

test("9-11. R6-R2 AV: identical review PASS replay is idempotent with no version bump or duplicate history", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-9-idemp", taskId: "TEST-TASK-001" });
    await advanceRunToReviewing(orchestrator, run.runId, "sess-9");

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const passArtifact: ReviewResultArtifact = {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Reviewer Cindy", session: "sess-9", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: await orchestrator.computeCurrentTreeDigest(),
      reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
      verdict: "PASS",
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
      findings: [],
      recordedAt: new Date().toISOString(),
    };

    // 9. First PASS consume
    const first = await orchestrator.recordValidatedReviewResult(run.runId, passArtifact);
    assert.equal(first.state, CindyState.REVIEWING);
    const vFirst = first.version;
    const historyLenFirst = first.history.length;
    const updatedAtFirst = first.updatedAt;

    // 10-11. Second identical PASS consume
    const second = await orchestrator.recordValidatedReviewResult(run.runId, passArtifact);
    assert.equal(second.version, vFirst, "Version must not bump on identical PASS replay");
    assert.equal(second.history.length, historyLenFirst, "History must not duplicate PASS entry");
    assert.equal(second.updatedAt, updatedAtFirst, "updatedAt must not mutate on idempotent replay");
  } finally {
    await cleanup();
  }
});

test("12. R6-R2 AV: second different PASS for same request/cycle is rejected with conflict", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-12-conflict", taskId: "TEST-TASK-001" });
    await advanceRunToReviewing(orchestrator, run.runId, "sess-12");

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const passArtifact: ReviewResultArtifact = {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Reviewer Cindy", session: "sess-12", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: await orchestrator.computeCurrentTreeDigest(),
      reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
      verdict: "PASS",
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
      findings: [],
      recordedAt: new Date().toISOString(),
    };
    await orchestrator.recordValidatedReviewResult(run.runId, passArtifact);
    const differentPass: ReviewResultArtifact = {
      ...passArtifact,
      findings: [{ id: "DIFF-1", severity: "LOW", title: "Different content" }],
    };
    await assert.rejects(
      async () => {
        await orchestrator.recordValidatedReviewResult(run.runId, differentPass);
      },
      (err: unknown) => err instanceof ConflictingArtifactError
    );
  } finally {
    await cleanup();
  }
});

test("13. R6-R2 AV: second identical FAIL replay does not duplicate repair transition", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-13-fail-idemp", taskId: "TEST-TASK-001" });
    await advanceRunToReviewing(orchestrator, run.runId, "sess-13");

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const failArtifact: ReviewResultArtifact = {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Reviewer Cindy", session: "sess-13", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: await orchestrator.computeCurrentTreeDigest(),
      reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
      verdict: "FAIL",
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
      findings: [{ id: "F1", severity: "HIGH", title: "Error" }],
      recordedAt: new Date().toISOString(),
    };

    const first = await orchestrator.recordValidatedReviewResult(run.runId, failArtifact);
    assert.equal(first.state, CindyState.REPAIR_INITIALIZED);
    assert.equal(first.currentCycle, 2);
    const vFirst = first.version;
    const historyLenFirst = first.history.length;

    // Second call with same FAIL
    const second = await orchestrator.recordValidatedReviewResult(run.runId, failArtifact);
    assert.equal(second.state, CindyState.REPAIR_INITIALIZED);
    assert.equal(second.version, vFirst, "Version must not bump on repeated FAIL");
    assert.equal(second.currentCycle, 2, "Cycle must not bump again on repeated FAIL");
    assert.equal(second.history.length, historyLenFirst, "History must not duplicate repair transition");
  } finally {
    await cleanup();
  }
});

// -----------------------------
// MANUAL PAUSE AUTHORITY (Tests 14-20)
// -----------------------------

test("14. R6-R2 AT: clean valid authority allows BLOCKED administrative pause", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-14-clean-block", taskId: "TEST-TASK-001" });

    const paused = await orchestrator.pauseRun(run.runId, CindyState.BLOCKED, { reason: "Legitimate block" });
    assert.equal(paused.state, CindyState.BLOCKED);
    assert.equal(paused.pausedFrom, CindyState.TASK_INITIALIZED);
    assert.equal(paused.stopReason, CindyState.BLOCKED);
  } finally {
    await cleanup();
  }
});

test("15. R6-R2 AT: HEAD drift rejects manual pause to BLOCKED", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-15-head-drift", taskId: "TEST-TASK-001" });

    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    await writeFile(join(repoDir, "drift.txt"), "drift\n", "utf8");
    git(["add", "drift.txt"]);
    git(["commit", "-m", "chore: cause head drift"]);

    await assert.rejects(
      async () => {
        await orchestrator.pauseRun(run.runId, CindyState.BLOCKED, { reason: "Blocked attempt" });
      },
      (err: unknown) => err instanceof TransitionRejectedError && (err as Error).message.includes("HEAD_DRIFT")
    );
  } finally {
    await cleanup();
  }
});

test("16. R6-R2 AT: upstream drift rejects manual pause to BLOCKED", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-16-up-drift", taskId: "TEST-TASK-001" });

    // Mutate upstream ref directly in bare remote
    const remoteDir = join(repoDir, "remote.git");
    if (existsSync(remoteDir)) {
      const gitRemote = (args: string[]) => execFileSync("git", args, { cwd: remoteDir, encoding: "utf8" });
      gitRemote(["commit", "--allow-empty", "-m", "upstream commit"]);
    } else {
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      await writeFile(join(repoDir, "updrift.txt"), "up\n", "utf8");
      git(["add", "updrift.txt"]);
      git(["commit", "-m", "local ahead commit"]);
    }

    await assert.rejects(
      async () => {
        await orchestrator.pauseRun(run.runId, CindyState.BLOCKED, { reason: "Blocked attempt" });
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );
  } finally {
    await cleanup();
  }
});

test("17. R6-R2 AT: Task authority drift rejects manual pause to BLOCKED", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-17-task-drift", taskId: "TEST-TASK-001" });

    // Mutate task packet in commit
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const taskPacketPath = join(repoDir, ".agent", "tasks", "TEST-TASK-001", "task.json");
    await writeFile(taskPacketPath, JSON.stringify({ taskId: "TEST-TASK-001", branch: "main", baseCommit: run.baseCommit, allowedScope: ["src/"] }, null, 2), "utf8");
    git(["add", taskPacketPath]);
    git(["commit", "-m", "chore: mutate task packet"]);

    await assert.rejects(
      async () => {
        await orchestrator.pauseRun(run.runId, CindyState.BLOCKED, { reason: "Blocked attempt" });
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );
  } finally {
    await cleanup();
  }
});

test("18. R6-R2 AT: outside-scope dirty rejects manual pause to BLOCKED", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-18-dirty-drift", taskId: "TEST-TASK-001" });

    await writeFile(join(repoDir, "rogue-outside.txt"), "dirty\n", "utf8");

    await assert.rejects(
      async () => {
        await orchestrator.pauseRun(run.runId, CindyState.BLOCKED, { reason: "Blocked attempt" });
      },
      (err: unknown) => err instanceof DirtyTreeUnexplainedError
    );
  } finally {
    await cleanup();
  }
});

test("19-20. R6-R2 AT: PRODUCT_DECISION_REQUIRED allowed with clean authority, rejected with HEAD drift", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-19-pdr", taskId: "TEST-TASK-001" });

    // 19. Clean authority -> allowed
    const paused = await orchestrator.pauseRun(run.runId, CindyState.PRODUCT_DECISION_REQUIRED, { reason: "Decision needed" });
    assert.equal(paused.state, CindyState.PRODUCT_DECISION_REQUIRED);

    // 20. With HEAD drift on fresh run -> rejected
    const run2 = await orchestrator.initRun({ runId: "r6-r2-20-pdr-drift", taskId: "TEST-TASK-002" });
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    await writeFile(join(repoDir, "drift2.txt"), "drift\n", "utf8");
    git(["add", "drift2.txt"]);
    git(["commit", "-m", "chore: cause head drift"]);

    await assert.rejects(
      async () => {
        await orchestrator.pauseRun(run2.runId, CindyState.PRODUCT_DECISION_REQUIRED, { reason: "Decision needed" });
      },
      (err: unknown) => err instanceof TransitionRejectedError && (err as Error).message.includes("HEAD_DRIFT")
    );
  } finally {
    await cleanup();
  }
});

// -----------------------------
// DERIVED SAFETY STOP (Tests 21-26)
// -----------------------------

test("21-22. R6-R2 AT: HEAD drift detected derives GIT_SAFETY_STOP with detailed reason HEAD_DRIFT", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-21-derive-git", taskId: "TEST-TASK-001" });

    // Cause HEAD drift
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    await writeFile(join(repoDir, "drift.txt"), "drift\n", "utf8");
    git(["add", "drift.txt"]);
    git(["commit", "-m", "chore: cause head drift"]);

    // Internal system derives safety stop
    const stopped = await orchestrator.deriveSafetyStop(run.runId);
    assert.equal(stopped.state, CindyState.GIT_SAFETY_STOP);
    assert.equal(stopped.pausedFrom, CindyState.TASK_INITIALIZED);
    assert.equal(stopped.stopReason, CindyStopReason.HEAD_DRIFT);
    assert.ok(stopped.stopExplanation?.includes("HEAD_DRIFT"));
  } finally {
    await cleanup();
  }
});

test("23. R6-R2 AT: caller cannot request GIT_SAFETY_STOP directly via pauseRun", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-23-forge-stop", taskId: "TEST-TASK-001" });

    await assert.rejects(
      async () => {
        await orchestrator.pauseRun(run.runId, CindyState.GIT_SAFETY_STOP, { reason: "Fake reason" });
      },
      (err: unknown) => err instanceof TransitionRejectedError && (err as Error).message.includes("derived safety stop")
    );
  } finally {
    await cleanup();
  }
});

test("24. R6-R2 AT: outside-scope dirty derives DIRTY_TREE_UNEXPLAINED", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-24-derive-dirty", taskId: "TEST-TASK-001" });

    await writeFile(join(repoDir, "unexplained.txt"), "dirty\n", "utf8");

    const stopped = await orchestrator.deriveSafetyStop(run.runId);
    assert.equal(stopped.state, CindyState.DIRTY_TREE_UNEXPLAINED);
    assert.equal(stopped.pausedFrom, CindyState.TASK_INITIALIZED);
    assert.equal(stopped.stopReason, CindyStopReason.DIRTY_TREE_UNEXPLAINED);
  } finally {
    await cleanup();
  }
});

test("25. R6-R2 AT: caller cannot forge DIRTY_TREE_UNEXPLAINED when tree is clean and valid", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-25-forge-dirty", taskId: "TEST-TASK-001" });

    await assert.rejects(
      async () => {
        await orchestrator.deriveSafetyStop(run.runId);
      },
      (err: unknown) => err instanceof TransitionRejectedError && (err as Error).message.includes("clean and valid")
    );
  } finally {
    await cleanup();
  }
});

test("26. R6-R2 AT: derived safety stop preserves bound Git authority snapshot commits unchanged", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-26-no-rewrite", taskId: "TEST-TASK-001" });

    const origHead = run.headCommit;
    const origBase = run.baseCommit;
    const origTaskAuth = run.taskAuthorityCommit;
    const origUpstream = run.upstreamCommit;

    // Cause HEAD drift
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    await writeFile(join(repoDir, "drift.txt"), "drift\n", "utf8");
    git(["add", "drift.txt"]);
    git(["commit", "-m", "chore: cause head drift"]);

    const stopped = await orchestrator.deriveSafetyStop(run.runId);
    assert.equal(stopped.headCommit, origHead, "headCommit must not be rewritten");
    assert.equal(stopped.baseCommit, origBase, "baseCommit must not be rewritten");
    assert.equal(stopped.taskAuthorityCommit, origTaskAuth, "taskAuthorityCommit must not be rewritten");
    assert.equal(stopped.upstreamCommit, origUpstream, "upstreamCommit must not be rewritten");
  } finally {
    await cleanup();
  }
});

// -----------------------------
// UNKNOWN RUN / LOCK (Tests 27-33)
// -----------------------------

test("27-28. R6-R2 AU: executeSemanticTransition unknown run rejects and leaves no orphan directory", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const unknownRunId = "unknown-sem-probe";
    const unknownDir = join(repoDir, ".agent", "runtime", unknownRunId);

    await assert.rejects(
      async () => {
        await executeSemanticTransition(orchestrator.artifactStore, unknownRunId, { type: "markReadyForBuilder" });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
    assert.equal(existsSync(unknownDir), false, "No orphan directory created");
  } finally {
    await cleanup();
  }
});

test("29-30. R6-R2 AU: acquireRunLock unknown run rejects and leaves no directory", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const unknownRunId = "unknown-lock-probe";
    const unknownDir = join(repoDir, ".agent", "runtime", unknownRunId);

    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.acquireRunLock(unknownRunId);
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
    assert.equal(existsSync(unknownDir), false, "No directory created from acquireRunLock(runId)");

    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.acquireRunLock(unknownDir);
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
    assert.equal(existsSync(unknownDir), false, "No directory created from acquireRunLock(runDir)");
  } finally {
    await cleanup();
  }
});

test("31-32. R6-R2 AU: recordArtifact and recordTestResult on unknown run reject and leave no directory", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const unknownRunId = "unknown-art-probe";
    const unknownDir = join(repoDir, ".agent", "runtime", unknownRunId);

    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.recordArtifact(unknownRunId, ArtifactKind.TEST_RESULT, { dummy: true });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
    assert.equal(existsSync(unknownDir), false, "No directory created from recordArtifact");

    await assert.rejects(
      async () => {
            const snap = await orchestrator.computeCurrentExecutionSnapshot((await orchestrator.getRun(unknownRunId)).taskId);
        await orchestrator.recordTestResult(unknownRunId, {
          runId: unknownRunId,
          taskId: "TEST-TASK-001",
          cycle: 1,
          command: "npm test",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          status: "PASS",
          exitCode: 0,
          boundTreeDigest: "dummy",
          logDigest: "dummy",
            executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
            executionSnapshotDigest: snap.digest
        });
      },
      (err: unknown) => err instanceof Error
    );
    assert.equal(existsSync(unknownDir), false, "No directory created from recordTestResult");
  } finally {
    await cleanup();
  }
});

test("33. R6-R2 AU: valid registered run lock still functions correctly", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-33-valid-lock", taskId: "TEST-TASK-001" });
    const runDir = orchestrator.artifactStore.getRunDir(run.runId);

    const lock = await orchestrator.artifactStore.acquireRunLock(runDir);
    assert.ok(lock.ownerId);
    await orchestrator.artifactStore.releaseRunLock(runDir, lock.ownerId);
  } finally {
    await cleanup();
  }
});

// -----------------------------
// PRIVILEGED REGRESSION (Tests 34-40)
// -----------------------------

test("34-40. R6-R2 Privileged regression: Review PASS stays REVIEWING, privileged states remain sealed", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-34-priv", taskId: "TEST-TASK-001" });
    await advanceRunToReviewing(orchestrator, run.runId, "sess-34");

    // 34. Stays REVIEWING
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const passResult = await orchestrator.recordValidatedReviewResult(run.runId, {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Reviewer Cindy", session: "sess-34", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: await orchestrator.computeCurrentTreeDigest(),
      reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
      verdict: "PASS",
      findings: [],
      recordedAt: new Date().toISOString(),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    assert.equal(passResult.state, CindyState.REVIEWING);

    // 35-40. Privileged states sealed
    const privilegedStates = [
      CindyState.FINAL_GATE,
      CindyState.READY_TO_COMMIT,
      CindyState.COMMITTING,
      CindyState.PUSHING,
      CindyState.CLOSED,
      CindyState.NEXT_TASK_SELECTED,
    ];
    for (const privState of privilegedStates) {
      await assert.rejects(
        async () => {
          await orchestrator.artifactStore.applyAdministrativeTransition(run.runId, privState);
        },
        (err: unknown) => err instanceof TransitionRejectedError && (err as Error).message.includes("sealed and prohibited")
      );
    }
  } finally {
    await cleanup();
  }
});

// -----------------------------
// INDEPENDENT DRIFT TESTS
// -----------------------------

test("41. Independent Drift: upstream drift rejects normal state transition", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-drift-up", taskId: "TEST-TASK-001" });

    // Drift upstream ref without altering local HEAD
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    git(["update-ref", "refs/remotes/origin/main", run.baseCommit]);

    await assert.rejects(
      async () => {
        await orchestrator.markReadyForBuilder(run.runId);
      },
      (err: unknown) => err instanceof TransitionRejectedError && (err as Error).message.includes("UPSTREAM_")
    );
  } finally {
    await cleanup();
  }
});

test("42. Independent Drift: Task Packet authority commit drift rejects normal state transition", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-drift-task", taskId: "TEST-TASK-001" });

    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const taskPath = join(repoDir, ".agent", "tasks", "TEST-TASK-001", "task.json");
    await writeFile(taskPath, JSON.stringify({ taskId: "TEST-TASK-001", branch: "main", baseCommit: run.baseCommit, allowedScope: ["src/"] }, null, 2), "utf8");
    git(["add", taskPath]);
    git(["commit", "-m", "chore: mutate task packet"]);

    await assert.rejects(
      async () => {
        await orchestrator.markReadyForBuilder(run.runId);
      },
      (err: unknown) => err instanceof TransitionRejectedError
    );
  } finally {
    await cleanup();
  }
});

test("43. Independent Drift: new outside-scope dirty file rejects normal state transition", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r2-drift-dirty", taskId: "TEST-TASK-001" });

    await writeFile(join(repoDir, "unauthorized-file.txt"), "outside\n", "utf8");

    await assert.rejects(
      async () => {
        await orchestrator.markReadyForBuilder(run.runId);
      },
      (err: unknown) => err instanceof DirtyTreeUnexplainedError
    );
  } finally {
    await cleanup();
  }
});

// =========================================================================
// CINDY-ORCH-MVP-R2F2-R6-R3 TESTS
// =========================================================================

// -----------------------------
// BLOCKER B01: STATE-DRIVING EVIDENCE / GENERIC BOUND WRITER REMOVAL
// -----------------------------

test("R6-R3 B01.1: RuntimeArtifactStore.prototype does not have recordBoundEvidence", () => {
  assert.equal(
    (RuntimeArtifactStore.prototype as unknown as Record<string, unknown>).recordBoundEvidence,
    undefined,
    "recordBoundEvidence must be completely removed from RuntimeArtifactStore.prototype"
  );
  const protoProps = Object.getOwnPropertyNames(RuntimeArtifactStore.prototype);
  assert.ok(!protoProps.includes("recordBoundEvidence"), "recordBoundEvidence must not be in prototype properties");
});

test("R6-R3 B01.2: generic recordArtifact cannot set STRUCTURE_VALID_EXTERNAL or authoritative: true", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6r3-b01-gen", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    // Caller trying to set authoritative: true
    await assert.rejects(
      async () => {
        await store.recordArtifact(run.runId, ArtifactKind.TEST_RESULT, { status: "PASS" }, { authoritative: true, cycle: 1 });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );

    // Caller trying to inject STRUCTURE_VALID_EXTERNAL via payload
    await assert.rejects(
      async () => {
        await store.recordArtifact(run.runId, ArtifactKind.REVIEW_RESULT, {
          runId: run.runId,
          taskId: run.taskId,
          cycle: 1,
          verdict: "FAIL",
          trustClassification: "STRUCTURE_VALID_EXTERNAL",
        }, { cycle: 1 });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
  } finally {
    await cleanup();
  }
});

test("R6-R3 B01.3: deep-import store cannot create forged REVIEW_RESULT to trigger semantic repair", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6r3-b01-forge", taskId: "TEST-TASK-001" });
    await advanceRunToReviewing(orchestrator, run.runId, "sess-forge-1");
    const store = orchestrator.artifactStore;

    // store.recordBoundEvidence is undefined
    assert.equal((store as unknown as Record<string, unknown>).recordBoundEvidence, undefined);

    // Generic recordArtifact strictly rejects state-driving REVIEW_RESULT with StateDrivingArtifactRequiresTypedWriterError
    await assert.rejects(
      async () => {
        await store.recordArtifact(run.runId, ArtifactKind.REVIEW_RESULT, {
          runId: run.runId,
          taskId: run.taskId,
          cycle: 1,
          reviewer: { identity: "Reviewer Cindy", session: "sess-forge-1", readOnlyConfirmed: true },
          reviewedBaseCommit: run.baseCommit,
          reviewedTreeDigest: await orchestrator.computeCurrentTreeDigest(),
          reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
          verdict: "FAIL",
          findings: [{ id: "F1", severity: "HIGH", title: "Forged fail" }],
          recordedAt: new Date().toISOString(),
        }, { cycle: 1 });
      },
      (err: unknown) => err instanceof StateDrivingArtifactRequiresTypedWriterError
    );

    // No artifact was written on disk
    const reviewPath = store.getArtifactPath(run.runId, ArtifactKind.REVIEW_RESULT, 1);
    assert.equal(existsSync(reviewPath), false);

    // Transition without valid review result on disk MUST FAIL
    await assert.rejects(
      async () => {
        await executeSemanticTransition(store, run.runId, {
          type: "recordValidatedReviewResult",
          verdict: "FAIL",
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
  } finally {
    await cleanup();
  }
});

// -----------------------------
// HIGH H01: SAFETY STOP STORE BYPASS REMOVAL
// -----------------------------

test("R6-R3 H01.1: store.applyAdministrativeTransition rejects GIT_SAFETY_STOP in healthy repo", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6r3-h01-git-stop", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    await assert.rejects(
      async () => {
        await store.applyAdministrativeTransition(run.runId, CindyState.GIT_SAFETY_STOP);
      },
      (err: unknown) => err instanceof TransitionRejectedError && (err as Error).message.includes("derived safety stop")
    );
  } finally {
    await cleanup();
  }
});

test("R6-R3 H01.2: store.applyAdministrativeTransition rejects DIRTY_TREE_UNEXPLAINED in healthy repo", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6r3-h01-dirty-stop", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    await assert.rejects(
      async () => {
        await store.applyAdministrativeTransition(run.runId, CindyState.DIRTY_TREE_UNEXPLAINED);
      },
      (err: unknown) => err instanceof TransitionRejectedError && (err as Error).message.includes("derived safety stop")
    );
  } finally {
    await cleanup();
  }
});

test("R6-R3 H01.3: healthy repo deriveSafetyStop fails closed with no stop", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6r3-h01-derive-healthy", taskId: "TEST-TASK-001" });

    await assert.rejects(
      async () => {
        await orchestrator.deriveSafetyStop(run.runId);
      },
      (err: unknown) => err instanceof TransitionRejectedError && (err as Error).message.includes("clean and valid")
    );
  } finally {
    await cleanup();
  }
});

// -----------------------------
// HIGH H02: RUN LOCK PREFLIGHT
// -----------------------------

test("R6-R3 H02.1: acquireRunLock on orphan directory without run.json rejects and creates NO lock", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const orphanRunId = "orphan-run-1";
    const orphanDir = join(repoDir, ".agent", "runtime", orphanRunId);
    await mkdir(orphanDir, { recursive: true });

    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.acquireRunLock(orphanRunId);
      },
      (err: unknown) => err instanceof InvalidRunRecordError
    );

    const lockPath = join(orphanDir, ".run.lock");
    assert.equal(existsSync(lockPath), false, "Must NOT create .run.lock in orphan directory");
  } finally {
    await cleanup();
  }
});

test("R6-R3 H02.2: acquireRunLock on malformed run.json rejects and creates NO lock", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const malformedRunId = "malformed-run-1";
    const runDir = join(repoDir, ".agent", "runtime", malformedRunId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run.json"), "{ broken json", "utf8");

    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.acquireRunLock(malformedRunId);
      },
      (err: unknown) => err instanceof InvalidRunRecordError
    );

    const lockPath = join(runDir, ".run.lock");
    assert.equal(existsSync(lockPath), false, "Must NOT create .run.lock for malformed run.json");
  } finally {
    await cleanup();
  }
});

test("R6-R3 H02.3: acquireRunLock on schema-invalid run.json rejects and creates NO lock", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const schemaInvalidRunId = "schema-inv-run-1";
    const runDir = join(repoDir, ".agent", "runtime", schemaInvalidRunId);
    await mkdir(runDir, { recursive: true });
    // Missing required fields like version, state, taskId, etc.
    await writeFile(join(runDir, "run.json"), JSON.stringify({ runId: schemaInvalidRunId }), "utf8");

    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.acquireRunLock(schemaInvalidRunId);
      },
      (err: unknown) => err instanceof InvalidRunRecordError || err instanceof ArtifactValidationError
    );

    const lockPath = join(runDir, ".run.lock");
    assert.equal(existsSync(lockPath), false, "Must NOT create .run.lock for schema-invalid run.json");
  } finally {
    await cleanup();
  }
});

test("R6-R3 H02.4: acquireRunLock on runId mismatch rejects and creates NO lock", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "valid-run-orig", taskId: "TEST-TASK-001" });
    const origDir = orchestrator.artifactStore.getRunDir(run.runId);
    const origContent = await readFile(join(origDir, "run.json"), "utf8");

    // Copy run.json to mismatched directory
    const mismatchedRunId = "mismatched-run-dir";
    const mismatchedDir = join(repoDir, ".agent", "runtime", mismatchedRunId);
    await mkdir(mismatchedDir, { recursive: true });
    await writeFile(join(mismatchedDir, "run.json"), origContent, "utf8"); // runId inside is still 'valid-run-orig'

    await assert.rejects(
      async () => {
        await orchestrator.artifactStore.acquireRunLock(mismatchedRunId);
      },
      (err: unknown) => err instanceof InvalidRunRecordError && (err as Error).message.includes("runId mismatch")
    );

    const lockPath = join(mismatchedDir, ".run.lock");
    assert.equal(existsSync(lockPath), false, "Must NOT create .run.lock when runId does not match directory");
  } finally {
    await cleanup();
  }
});

// -----------------------------
// MEDIUM M01: REVIEW RESULT IMMUTABILITY
// -----------------------------

test("R6-R3 M01.1: first FAIL cycle 1 advances currentCycle to 2, identical replay is idempotent", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6r3-m01-fail-idemp", taskId: "TEST-TASK-001" });
    await advanceRunToReviewing(orchestrator, run.runId, "sess-m01-1");

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const failPayload: ReviewResultArtifact = {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Reviewer Cindy", session: "sess-m01-1", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: await orchestrator.computeCurrentTreeDigest(),
      reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
      verdict: "FAIL",
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
      findings: [{ id: "F1", severity: "HIGH", title: "First failure" }],
      recordedAt: new Date().toISOString(),
    };

    const first = await orchestrator.recordValidatedReviewResult(run.runId, failPayload);
    assert.equal(first.state, CindyState.REPAIR_INITIALIZED);
    assert.equal(first.currentCycle, 2);
    const vFirst = first.version;
    const historyLenFirst = first.history.length;

    // Second call with IDENTICAL FAIL payload
    const second = await orchestrator.recordValidatedReviewResult(run.runId, failPayload);
    assert.equal(second.state, CindyState.REPAIR_INITIALIZED);
    assert.equal(second.version, vFirst, "Version must not bump on idempotent FAIL replay");
    assert.equal(second.currentCycle, 2, "currentCycle must remain 2");
    assert.equal(second.history.length, historyLenFirst, "History must not append on idempotent replay");
  } finally {
    await cleanup();
  }
});

test("R6-R3 M01.2: same cycle different findings after FAIL rejects with ConflictingArtifactError", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6r3-m01-fail-conflict", taskId: "TEST-TASK-001" });
    await advanceRunToReviewing(orchestrator, run.runId, "sess-m01-2");

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const failPayload1: ReviewResultArtifact = {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Reviewer Cindy", session: "sess-m01-2", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: await orchestrator.computeCurrentTreeDigest(),
      reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
      verdict: "FAIL",
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
      findings: [{ id: "F1", severity: "HIGH", title: "Original finding" }],
      recordedAt: new Date().toISOString(),
    };

    await orchestrator.recordValidatedReviewResult(run.runId, failPayload1);

    // Call again with same cycle 1, same requestId/session, but DIFFERENT findings
    const failPayload2: ReviewResultArtifact = {
      ...failPayload1,
      findings: [{ id: "F2", severity: "LOW", title: "Different finding" }],
    };

    await assert.rejects(
      async () => {
        await orchestrator.recordValidatedReviewResult(run.runId, failPayload2);
      },
      (err: unknown) => err instanceof ConflictingArtifactError
    );

    const onDisk = await orchestrator.getRun(run.runId);
    assert.equal(onDisk.state, CindyState.REPAIR_INITIALIZED);
    assert.equal(onDisk.currentCycle, 2);
  } finally {
    await cleanup();
  }
});

test("R6-R3 M01.3: FAIL then PASS for same cycle rejects with ConflictingArtifactError", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6r3-m01-fail-then-pass", taskId: "TEST-TASK-001" });
    await advanceRunToReviewing(orchestrator, run.runId, "sess-m01-3");

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const failPayload: ReviewResultArtifact = {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Reviewer Cindy", session: "sess-m01-3", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: await orchestrator.computeCurrentTreeDigest(),
      reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
      verdict: "FAIL",
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
      findings: [{ id: "F1", severity: "HIGH", title: "Issue" }],
      recordedAt: new Date().toISOString(),
    };

    await orchestrator.recordValidatedReviewResult(run.runId, failPayload);

    const passPayload: ReviewResultArtifact = {
      ...failPayload,
      verdict: "PASS",
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
      findings: [],
    };

    await assert.rejects(
      async () => {
        await orchestrator.recordValidatedReviewResult(run.runId, passPayload);
      },
      (err: unknown) => err instanceof ConflictingArtifactError
    );
  } finally {
    await cleanup();
  }
});

test("R6-R3 M01.4: PASS then FAIL for same cycle rejects with ConflictingArtifactError", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6r3-m01-pass-then-fail", taskId: "TEST-TASK-001" });
    await advanceRunToReviewing(orchestrator, run.runId, "sess-m01-4");

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const passPayload: ReviewResultArtifact = {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Reviewer Cindy", session: "sess-m01-4", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: await orchestrator.computeCurrentTreeDigest(),
      reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
      verdict: "PASS",
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
      findings: [],
      recordedAt: new Date().toISOString(),
    };

    await orchestrator.recordValidatedReviewResult(run.runId, passPayload);

    const failPayload: ReviewResultArtifact = {
      ...passPayload,
      verdict: "FAIL",
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
      findings: [{ id: "F1", severity: "HIGH", title: "Late failure" }],
    };

    await assert.rejects(
      async () => {
        await orchestrator.recordValidatedReviewResult(run.runId, failPayload);
      },
      (err: unknown) => err instanceof ConflictingArtifactError
    );
  } finally {
    await cleanup();
  }
});

// =========================================================================
// R2F2-R6-R4: BLOCKER B01 & HIGH H03 FINAL SEAL TESTS
// =========================================================================

test("R6-R4 B01.1: writeBoundEvidenceInternal is physically removed from artifact-store exports", async () => {
  const artifactStoreModule = await import("../tools/cindy/artifact-store.ts");
  assert.equal("writeBoundEvidenceInternal" in artifactStoreModule, false);
  assert.equal((artifactStoreModule as Record<string, unknown>).writeBoundEvidenceInternal, undefined);

  // Assert no alternative raw writer names are exported
  const forbiddenExports = [
    "writeBoundEvidenceInternal",
    "writeTrustedArtifactInternal",
    "recordStructuredEvidenceInternal",
    "persistBoundArtifact",
    "writeBoundEvidence",
    "recordBoundEvidence",
    "internalRecordBoundFn",
  ];
  for (const name of forbiddenExports) {
    assert.equal(name in artifactStoreModule, false, `Forbidden export '${name}' found in artifact-store module`);
  }
});

test("R6-R4 B01.2: writeBoundEvidenceInternal is physically absent from cindy index exports", async () => {
  const indexModule = await import("../tools/cindy/index.ts");
  assert.equal("writeBoundEvidenceInternal" in indexModule, false);
  assert.equal((indexModule as Record<string, unknown>).writeBoundEvidenceInternal, undefined);

  const forbiddenExports = [
    "writeBoundEvidenceInternal",
    "writeTrustedArtifactInternal",
    "recordStructuredEvidenceInternal",
    "persistBoundArtifact",
    "writeBoundEvidence",
    "recordBoundEvidence",
    "internalRecordBoundFn",
  ];
  for (const name of forbiddenExports) {
    assert.equal(name in indexModule, false, `Forbidden export '${name}' found in index module`);
  }
});

test("R6-R4 B01.3: RuntimeArtifactStore has NO static, symbol, or prototype raw trusted writer capability", () => {
  // Static property check
  const staticProps = Object.getOwnPropertyNames(RuntimeArtifactStore);
  assert.ok(!staticProps.includes("writeBoundEvidenceInternal"));
  assert.ok(!staticProps.includes("writeBoundEvidence"));
  assert.ok(!staticProps.includes("recordBoundEvidence"));

  // Static symbol check
  const staticSymbols = Object.getOwnPropertySymbols(RuntimeArtifactStore);
  assert.equal(staticSymbols.length, 0, "No static symbols allowed on RuntimeArtifactStore");

  // Prototype property check
  const protoProps = Object.getOwnPropertyNames(RuntimeArtifactStore.prototype);
  assert.ok(!protoProps.includes("writeBoundEvidenceInternal"));
  assert.ok(!protoProps.includes("writeBoundEvidence"));
  assert.ok(!protoProps.includes("recordBoundEvidence"));

  // Prototype symbol check
  const protoSymbols = Object.getOwnPropertySymbols(RuntimeArtifactStore.prototype);
  assert.equal(protoSymbols.length, 0, "No prototype symbols allowed on RuntimeArtifactStore.prototype");
});

test("R6-R4 BD.1: typed store.recordTestResult enforces state, cycle, tree binding, exitCode invariants", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6r4-typed-test", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    // 1. Cannot call from TASK_INITIALIZED (requires TESTING)
    await assert.rejects(
      async () => {
        await store.recordTestResult(run.runId, {
          command: "pnpm test",
          exitCode: 0,
          status: "PASS",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError && (err as Error).message.includes("TESTING")
    );

    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    // 2. Reject exitCode != 0 when PASS
    await assert.rejects(
      async () => {
        await store.recordTestResult(run.runId, {
          command: "pnpm test",
          exitCode: 1,
          status: "PASS",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError && (err as Error).message.includes("exitCode")
    );

    // 3. Reject mismatched boundTreeDigest
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await assert.rejects(
      async () => {
        await store.recordTestResult(run.runId, {
          command: "pnpm test",
          exitCode: 0,
          status: "PASS",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
          boundTreeDigest: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: snap.digest,
        });
      },
      (err: unknown) => err instanceof ArtifactDigestMismatchError
    );

    // 4. Valid call succeeds and writes STRUCTURE_VALID_EXTERNAL
    const currentTree = await orchestrator.computeCurrentTreeDigest();
    const result = await store.recordTestResult(run.runId, {
      command: "pnpm test",
      exitCode: 0,
      status: "PASS",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      boundTreeDigest: currentTree,
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    });
    assert.ok(result.digest);
    assert.equal(result.isDuplicate, false);

    const onDisk = await store.readArtifact<Record<string, unknown>>(run.runId, ArtifactKind.TEST_RESULT, 1);
    assert.equal(onDisk?.trustClassification, "STRUCTURE_VALID_EXTERNAL");
  } finally {
    await cleanup();
  }
});

test("R6-R4 BD.2: typed store.recordDiffManifest enforces state, scope, and tree binding invariants", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6r4-typed-diff", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    // 1. Cannot call from TASK_INITIALIZED
    await assert.rejects(
      async () => {
        await store.recordDiffManifest(run.runId);
      },
      (err: unknown) => err instanceof ArtifactValidationError && (err as Error).message.includes("TESTING")
    );

    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    // 2. Reject mismatched expectedTreeDigest
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await assert.rejects(
      async () => {
        await store.recordDiffManifest(run.runId, {
          expectedTreeDigest: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: snap.digest,
        });
      },
      (err: unknown) => err instanceof ArtifactDigestMismatchError
    );

    // 3. Valid call succeeds and writes STRUCTURE_VALID_EXTERNAL
    const result = await store.recordDiffManifest(run.runId, {
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    });
    assert.ok(result.digest);
    assert.equal(result.isDuplicate, false);

    const onDisk = await store.readArtifact<Record<string, unknown>>(run.runId, ArtifactKind.DIFF_MANIFEST, 1);
    assert.equal(onDisk?.trustClassification, "STRUCTURE_VALID_EXTERNAL");
  } finally {
    await cleanup();
  }
});

test("R6-R4 BD.3: typed store.recordReviewRequest enforces state, reviewer identity & session, and read-only invariants", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6r4-typed-req", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    // 1. Cannot call from TASK_INITIALIZED (requires READY_FOR_REVIEW)
    await assert.rejects(
      async () => {
        await store.recordReviewRequest(run.runId, {
          reviewer: { identity: "Reviewer Cindy", session: "sess-1", readOnlyConfirmed: true },
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError && (err as Error).message.includes("READY_FOR_REVIEW")
    );

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
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
    await orchestrator.prepareForReview(run.runId);

    // 2. Reject readOnlyConfirmed: false
    await assert.rejects(
      async () => {
        await store.recordReviewRequest(run.runId, {
          reviewer: { identity: "Reviewer Cindy", session: "sess-1", readOnlyConfirmed: false },
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: snap.digest,
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError && (err as Error).message.includes("read-only")
    );

    // 3. Reject empty identity
    await assert.rejects(
      async () => {
        await store.recordReviewRequest(run.runId, {
          reviewer: { identity: "   ", session: "sess-1", readOnlyConfirmed: true },
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: snap.digest,
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError && (err as Error).message.includes("identity")
    );

    // 4. Reject empty session
    await assert.rejects(
      async () => {
        await store.recordReviewRequest(run.runId, {
          reviewer: { identity: "Reviewer Cindy", session: "   ", readOnlyConfirmed: true },
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: snap.digest,
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError && (err as Error).message.includes("session")
    );

    // 5. Valid call succeeds and writes STRUCTURE_VALID_EXTERNAL
    const result = await store.recordReviewRequest(run.runId, {
      reviewer: { identity: "Reviewer Cindy", session: "sess-1", readOnlyConfirmed: true },
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    });
    assert.ok(result.digest);
    assert.equal(result.isDuplicate, false);

    const onDisk = await store.readArtifact<Record<string, unknown>>(run.runId, ArtifactKind.REVIEW_REQUEST, 1);
    assert.equal(onDisk?.trustClassification, "STRUCTURE_VALID_EXTERNAL");
  } finally {
    await cleanup();
  }
});

test("R6-R4 BD.4: typed store.recordReviewResult enforces state, bound request, session match, and tree/diff binding", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6r4-typed-res", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    // 1. Cannot call before REVIEWING
    await assert.rejects(
      async () => {
        await store.recordReviewResult(run.runId, {
          runId: run.runId,
          taskId: run.taskId,
          cycle: 1,
          reviewer: { identity: "Reviewer Cindy", session: "sess-1", readOnlyConfirmed: true },
          reviewedBaseCommit: run.baseCommit,
          reviewedTreeDigest: await orchestrator.computeCurrentTreeDigest(),
          reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
          verdict: "PASS",
          findings: [],
          recordedAt: new Date().toISOString(),
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: (await orchestrator.computeCurrentExecutionSnapshot(run.taskId)).digest,
        });
      },
      (err: unknown) => err instanceof TransitionRejectedError && (err as Error).message.includes("REVIEWING")
    );

    await advanceRunToReviewing(orchestrator, run.runId, "sess-1");

    // 2. Reject reviewer session mismatch against bound review request
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await assert.rejects(
      async () => {
        await store.recordReviewResult(run.runId, {
          runId: run.runId,
          taskId: run.taskId,
          cycle: 1,
          reviewer: { identity: "Reviewer Cindy", session: "sess-wrong", readOnlyConfirmed: true },
          reviewedBaseCommit: run.baseCommit,
          reviewedTreeDigest: await orchestrator.computeCurrentTreeDigest(),
          reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: snap.digest,
          verdict: "PASS",
          findings: [],
          recordedAt: new Date().toISOString(),
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError && (err as Error).message.includes("session mismatch")
    );

    // 3. Reject tree digest mismatch
    await assert.rejects(
      async () => {
        await store.recordReviewResult(run.runId, {
          runId: run.runId,
          taskId: run.taskId,
          cycle: 1,
          reviewer: { identity: "Reviewer Cindy", session: "sess-1", readOnlyConfirmed: true },
          reviewedBaseCommit: run.baseCommit,
          reviewedTreeDigest: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: snap.digest,
          verdict: "PASS",
          findings: [],
          recordedAt: new Date().toISOString(),
        });
      },
      (err: unknown) => err instanceof ArtifactDigestMismatchError
    );

    // 4. Valid call succeeds and writes STRUCTURE_VALID_EXTERNAL
    const currentTree = await orchestrator.computeCurrentTreeDigest();
    const currentDiff = await orchestrator.computeCurrentDiffDigest();
    const result = await store.recordReviewResult(run.runId, {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Reviewer Cindy", session: "sess-1", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: currentTree,
      reviewedDiffDigest: currentDiff,
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
      verdict: "PASS",
      findings: [],
      recordedAt: new Date().toISOString(),
    });
    assert.ok(result.digest);
    assert.equal(result.isDuplicate, false);

    const onDisk = await store.readArtifact<Record<string, unknown>>(run.runId, ArtifactKind.REVIEW_RESULT, 1);
    assert.equal(onDisk?.trustClassification, "STRUCTURE_VALID_EXTERNAL");
  } finally {
    await cleanup();
  }
});

test("R6-R4 H03.1: generic recordArtifact strictly rejects ALL state-driving artifact kinds with StateDrivingArtifactRequiresTypedWriterError", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6r4-h03-squat", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    const testKinds = [
      ArtifactKind.BASELINE,
      ArtifactKind.TEST_RESULT,
      ArtifactKind.DIFF_MANIFEST,
      ArtifactKind.REVIEW_REQUEST,
      ArtifactKind.REVIEW_RESULT,
      ArtifactKind.REPAIR_INIT,
      ArtifactKind.CLOSEOUT,
      ArtifactKind.NEXT_TASK,
    ];

    const cyclicKinds = new Set<string>([
      ArtifactKind.TEST_RESULT,
      ArtifactKind.DIFF_MANIFEST,
      ArtifactKind.REVIEW_REQUEST,
      ArtifactKind.REVIEW_RESULT,
      ArtifactKind.REPAIR_INIT,
    ]);

    for (const kind of testKinds) {
      assert.ok(STATE_DRIVING_ARTIFACT_KINDS.has(kind), `${kind} must be in STATE_DRIVING_ARTIFACT_KINDS`);

      const isCyclic = cyclicKinds.has(kind);
      const canonicalPath = isCyclic
        ? store.getArtifactPath(run.runId, kind, 1)
        : store.getArtifactPath(run.runId, kind);
      const fileExistedBefore = existsSync(canonicalPath);

      await assert.rejects(
        async () => {
          await store.recordArtifact(
            run.runId,
            kind,
            {
              runId: run.runId,
              taskId: run.taskId,
              data: "malicious-squatting-payload",
              ...(isCyclic ? { cycle: 1 } : {}),
            },
            isCyclic ? { cycle: 1 } : {}
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof StateDrivingArtifactRequiresTypedWriterError, `Expected StateDrivingArtifactRequiresTypedWriterError for ${kind}`);
          assert.equal((err as StateDrivingArtifactRequiresTypedWriterError).kind, kind);
          return true;
        }
      );

      // Verify NO file was created on disk by the rejected call
      if (!fileExistedBefore) {
        assert.equal(existsSync(canonicalPath), false, `Canonical file for ${kind} must NOT exist after rejection`);
      }
    }
  } finally {
    await cleanup();
  }
});

test("R6-R4 H03.2: path squatting DoS prevention - generic rejection allows subsequent formal typed recording", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6r4-h03-nosquat", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    // Attacker tries to squat test-result-cycle-1.json via generic recordArtifact
    await assert.rejects(
      async () => {
        await store.recordArtifact(run.runId, ArtifactKind.TEST_RESULT, {
          runId: run.runId,
          taskId: run.taskId,
          cycle: 1,
          command: "malicious test",
          status: "PASS",
        }, { cycle: 1 });
      },
      (err: unknown) => err instanceof StateDrivingArtifactRequiresTypedWriterError
    );

    // Attacker tries to squat diff-manifest-cycle-1.json via generic recordArtifact
    await assert.rejects(
      async () => {
        await store.recordArtifact(run.runId, ArtifactKind.DIFF_MANIFEST, {
          runId: run.runId,
          taskId: run.taskId,
          cycle: 1,
        }, { cycle: 1 });
      },
      (err: unknown) => err instanceof StateDrivingArtifactRequiresTypedWriterError
    );

    // Legitimate workflow records test result and diff manifest without ConflictingArtifactError
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const testRes = await orchestrator.recordTestResult(run.runId, {
      command: "pnpm test",
      exitCode: 0,
      status: "PASS",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest
    });
    assert.equal(testRes.isDuplicate, false);

    const diffRes = await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
    assert.equal(diffRes.isDuplicate, false);
  } finally {
    await cleanup();
  }
});

// =========================================================================
// R6-R5: H04 Atomic Typed Evidence Write / Double-Checked Locked Revalidation
// =========================================================================

function createTestBarrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("R6-R5 H04 TEST 1: STATE RACE - recordTestResult preflight passes, state changes before lock -> rejected under lock", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "h04-test-state-race", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const preflightBarrier = createTestBarrier();
    const releaseBarrier = createTestBarrier();

    const originalAcquire = store.acquireRunLock.bind(store);
    store.acquireRunLock = async (...args) => {
      preflightBarrier.resolve();
      await releaseBarrier.promise;
      return originalAcquire(...args);
    };

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const treeDigest = await computeTreeDigest(repoDir);
    const writePromise = store.recordTestResult(run.runId, {
      command: "pnpm test",
      exitCode: 0,
      status: "PASS",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      boundTreeDigest: treeDigest,
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    });

    await preflightBarrier.promise;

    // Concurrently mutate run state to BLOCKED via second store instance
    const store2 = new RuntimeArtifactStore({ repoDir });
    await store2.applyAdministrativeTransition(run.runId, CindyState.BLOCKED, {
      reason: "Manual pause during race window",
    });

    releaseBarrier.resolve();

    await assert.rejects(
      writePromise,
      (err: unknown) => {
        assert.ok(
          err instanceof ArtifactValidationError || err instanceof TransitionRejectedError,
          `Expected ArtifactValidationError or TransitionRejectedError, got ${String(err)}`
        );
        return true;
      }
    );

    // Verify canonical artifact file does NOT exist
    const canonicalPath = join(repoDir, ".agent", "runtime", run.runId, "test-result-cycle-1.json");
    assert.equal(existsSync(canonicalPath), false, "test-result-cycle-1.json must NOT exist on disk");

    // Verify no temp artifact files
    const runDirFiles = await readdir(join(repoDir, ".agent", "runtime", run.runId));
    const tempFiles = runDirFiles.filter((f) => f.startsWith(".tmp_"));
    assert.equal(tempFiles.length, 0, `No temp files should remain, found: ${tempFiles.join(", ")}`);

    // Verify run lock is released
    assert.equal(existsSync(join(repoDir, ".agent", "runtime", run.runId, ".run.lock")), false, "Run lock must be released");

    // Verify run.json state remains BLOCKED
    const finalRun = await store2.getRun(run.runId);
    assert.equal(finalRun.state, CindyState.BLOCKED);
  } finally {
    await cleanup();
  }
});

test("R6-R5 H04 TEST 2: TREE RACE - recordTestResult preflight passes, tracked file modified before lock -> rejected under lock", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "h04-test-tree-race", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const preflightBarrier = createTestBarrier();
    const releaseBarrier = createTestBarrier();

    const originalAcquire = store.acquireRunLock.bind(store);
    store.acquireRunLock = async (...args) => {
      preflightBarrier.resolve();
      await releaseBarrier.promise;
      return originalAcquire(...args);
    };

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const treeDigest = await computeTreeDigest(repoDir);
    const writePromise = store.recordTestResult(run.runId, {
      command: "pnpm test",
      exitCode: 0,
      status: "PASS",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      boundTreeDigest: treeDigest,
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    });

    await preflightBarrier.promise;

    // Mutate a tracked file in allowed scope during the race window
    await writeFile(join(repoDir, "schemas", "cindy-run.json"), "/* modified during race */\n", "utf8");

    releaseBarrier.resolve();

    await assert.rejects(
      writePromise,
      (err: unknown) => {
        assert.ok(
          err instanceof ArtifactDigestMismatchError,
          `Expected ArtifactDigestMismatchError, got ${String(err)}`
        );
        return true;
      }
    );

    const canonicalPath = join(repoDir, ".agent", "runtime", run.runId, "test-result-cycle-1.json");
    assert.equal(existsSync(canonicalPath), false, "test-result-cycle-1.json must NOT exist on disk");

    const runDirFiles = await readdir(join(repoDir, ".agent", "runtime", run.runId));
    const tempFiles = runDirFiles.filter((f) => f.startsWith(".tmp_"));
    assert.equal(tempFiles.length, 0, "No temp files should remain");
    assert.equal(existsSync(join(repoDir, ".agent", "runtime", run.runId, ".run.lock")), false, "Run lock must be released");
  } finally {
    await cleanup();
  }
});

test("R6-R5 H04 TEST 3: HEAD RACE - recordReviewRequest preflight passes, new commit advances HEAD -> rejected under lock", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "h04-test-head-race", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

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
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
    await orchestrator.prepareForReview(run.runId);

    const preflightBarrier = createTestBarrier();
    const releaseBarrier = createTestBarrier();

    const originalAcquire = store.acquireRunLock.bind(store);
    store.acquireRunLock = async (...args) => {
      preflightBarrier.resolve();
      await releaseBarrier.promise;
      return originalAcquire(...args);
    };

    const writePromise = store.recordReviewRequest(run.runId, {
      reviewer: {
        identity: "rev-alice",
        session: "sess-001",
        readOnlyConfirmed: true,
      },
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    });

    await preflightBarrier.promise;

    // Advance HEAD with a new commit during the race window
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    await writeFile(join(repoDir, "extra-commit.txt"), "advance head\n", "utf8");
    git(["add", "extra-commit.txt"]);
    git(["commit", "-m", "chore: advance HEAD during race"]);

    releaseBarrier.resolve();

    await assert.rejects(
      writePromise,
      (err: unknown) => {
        assert.ok(
          err instanceof TransitionRejectedError || err instanceof ArtifactValidationError,
          `Expected TransitionRejectedError or ArtifactValidationError, got ${String(err)}`
        );
        return true;
      }
    );

    const canonicalPath = join(repoDir, ".agent", "runtime", run.runId, "review-request-cycle-1.json");
    assert.equal(existsSync(canonicalPath), false, "review-request-cycle-1.json must NOT exist on disk");
    assert.equal(existsSync(join(repoDir, ".agent", "runtime", run.runId, ".run.lock")), false, "Run lock must be released");
  } finally {
    await cleanup();
  }
});

test("R6-R5 H04 TEST 4: TASK AUTHORITY RACE - recordDiffManifest preflight passes, task packet committed -> rejected under lock", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "h04-test-task-race", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const preflightBarrier = createTestBarrier();
    const releaseBarrier = createTestBarrier();

    const originalAcquire = store.acquireRunLock.bind(store);
    store.acquireRunLock = async (...args) => {
      preflightBarrier.resolve();
      await releaseBarrier.promise;
      return originalAcquire(...args);
    };

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const writePromise = store.recordDiffManifest(run.runId, {
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    });

    await preflightBarrier.promise;

    // Modify canonical Task Packet and commit to drift taskAuthorityCommit
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const tdir = join(repoDir, ".agent", "tasks", "TEST-TASK-001");
    const taskPath = join(tdir, "task.json");
    const packet = JSON.parse(await readFile(taskPath, "utf8"));
    packet.description = "task packet modified during race";
    await writeFile(taskPath, JSON.stringify(packet, null, 2), "utf8");
    git(["add", taskPath]);
    git(["commit", "-m", "chore: modify task packet during race"]);

    releaseBarrier.resolve();

    await assert.rejects(
      writePromise,
      (err: unknown) => {
        assert.ok(
          err instanceof TransitionRejectedError || err instanceof ArtifactValidationError,
          `Expected TransitionRejectedError or ArtifactValidationError, got ${String(err)}`
        );
        return true;
      }
    );

    const canonicalPath = join(repoDir, ".agent", "runtime", run.runId, "diff-manifest-cycle-1.json");
    assert.equal(existsSync(canonicalPath), false, "diff-manifest-cycle-1.json must NOT exist on disk");
    assert.equal(existsSync(join(repoDir, ".agent", "runtime", run.runId, ".run.lock")), false, "Run lock must be released");
  } finally {
    await cleanup();
  }
});

test("R6-R5 H04 TEST 5: UPSTREAM RACE - recordTestResult preflight passes, upstream ref drifts -> rejected under lock", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "h04-test-upstream-race", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const preflightBarrier = createTestBarrier();
    const releaseBarrier = createTestBarrier();

    const originalAcquire = store.acquireRunLock.bind(store);
    store.acquireRunLock = async (...args) => {
      preflightBarrier.resolve();
      await releaseBarrier.promise;
      return originalAcquire(...args);
    };

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const treeDigest = await computeTreeDigest(repoDir);
    const writePromise = store.recordTestResult(run.runId, {
      command: "pnpm test",
      exitCode: 0,
      status: "PASS",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      boundTreeDigest: treeDigest,
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    });

    await preflightBarrier.promise;

    // Move upstream remote tracking ref
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    git(["update-ref", "refs/remotes/origin/main", "HEAD~1"]);

    releaseBarrier.resolve();

    await assert.rejects(
      writePromise,
      (err: unknown) => {
        assert.ok(
          err instanceof TransitionRejectedError || err instanceof ArtifactValidationError,
          `Expected TransitionRejectedError or ArtifactValidationError, got ${String(err)}`
        );
        return true;
      }
    );

    const canonicalPath = join(repoDir, ".agent", "runtime", run.runId, "test-result-cycle-1.json");
    assert.equal(existsSync(canonicalPath), false, "test-result-cycle-1.json must NOT exist on disk");
    assert.equal(existsSync(join(repoDir, ".agent", "runtime", run.runId, ".run.lock")), false, "Run lock must be released");
  } finally {
    await cleanup();
  }
});

test("R6-R5 H04 TEST 6: DIRTY-SCOPE RACE - recordDiffManifest preflight passes, outside-scope dirty file created -> rejected under lock", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "h04-test-dirtyscope-race", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const preflightBarrier = createTestBarrier();
    const releaseBarrier = createTestBarrier();

    const originalAcquire = store.acquireRunLock.bind(store);
    store.acquireRunLock = async (...args) => {
      preflightBarrier.resolve();
      await releaseBarrier.promise;
      return originalAcquire(...args);
    };

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const writePromise = store.recordDiffManifest(run.runId, {
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    });

    await preflightBarrier.promise;

    // Create an unexplainable dirty file outside allowedScope
    await writeFile(join(repoDir, "forbidden-outside-scope.tmp"), "unauthorized dirty\n", "utf8");

    releaseBarrier.resolve();

    await assert.rejects(
      writePromise,
      (err: unknown) => {
        assert.ok(
          err instanceof TransitionRejectedError || err instanceof ArtifactValidationError,
          `Expected TransitionRejectedError or ArtifactValidationError, got ${String(err)}`
        );
        return true;
      }
    );

    const canonicalPath = join(repoDir, ".agent", "runtime", run.runId, "diff-manifest-cycle-1.json");
    assert.equal(existsSync(canonicalPath), false, "diff-manifest-cycle-1.json must NOT exist on disk");
    assert.equal(existsSync(join(repoDir, ".agent", "runtime", run.runId, ".run.lock")), false, "Run lock must be released");
  } finally {
    await cleanup();
  }
});

test("R6-R5 H04 TEST 7: REVIEW_RESULT RACE - recordReviewResult preflight passes, working tree mutated before lock -> rejected under lock", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "h04-test-review-race", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

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
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
    await orchestrator.prepareForReview(run.runId);
    const reqSnap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await store.recordReviewRequest(run.runId, {
      reviewer: {
        identity: "rev-bob",
        session: "sess-bob-1",
        readOnlyConfirmed: true,
      },
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: reqSnap.digest,
    });
    await orchestrator.startReview(run.runId);

    const preflightBarrier = createTestBarrier();
    const releaseBarrier = createTestBarrier();

    const originalAcquire = store.acquireRunLock.bind(store);
    store.acquireRunLock = async (...args) => {
      preflightBarrier.resolve();
      await releaseBarrier.promise;
      return originalAcquire(...args);
    };

    const reviewedTree = await computeTreeDigest(repoDir);
    const reviewedDiff = await computeDiffDigest(repoDir);

    const resSnap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const writePromise = store.recordReviewResult(run.runId, {
      runId: run.runId,
      taskId: run.taskId,
      reviewedBaseCommit: run.baseCommit,
      cycle: 1,
      reviewer: {
        identity: "rev-bob",
        session: "sess-bob-1",
        readOnlyConfirmed: true,
      },
      reviewedTreeDigest: reviewedTree,
      reviewedDiffDigest: reviewedDiff,
      verdict: "PASS",
      findings: [],
      recordedAt: new Date().toISOString(),
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: resSnap.digest,
    });

    await preflightBarrier.promise;

    // Mutate tree during the race window
    await writeFile(join(repoDir, "schemas", "cindy-run.json"), "/* modified during review result race */\n", "utf8");

    releaseBarrier.resolve();

    await assert.rejects(
      writePromise,
      (err: unknown) => {
        assert.ok(
          err instanceof ArtifactDigestMismatchError || err instanceof ArtifactValidationError,
          `Expected ArtifactDigestMismatchError or ArtifactValidationError, got ${String(err)}`
        );
        return true;
      }
    );

    const canonicalPath = join(repoDir, ".agent", "runtime", run.runId, "review-result-cycle-1.json");
    assert.equal(existsSync(canonicalPath), false, "review-result-cycle-1.json must NOT exist on disk");
    assert.equal(existsSync(join(repoDir, ".agent", "runtime", run.runId, ".run.lock")), false, "Run lock must be released");
  } finally {
    await cleanup();
  }
});

test("R6-R5 H04 TEST 8: REVIEW_RESULT REQUEST TAMPER RACE - review request deleted during race window -> rejected under lock", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "h04-test-reqtamper-race", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

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
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
    await orchestrator.prepareForReview(run.runId);
    const reqSnap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await store.recordReviewRequest(run.runId, {
      reviewer: {
        identity: "rev-carol",
        session: "sess-carol-1",
        readOnlyConfirmed: true,
      },
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: reqSnap.digest,
    });
    await orchestrator.startReview(run.runId);

    const preflightBarrier = createTestBarrier();
    const releaseBarrier = createTestBarrier();

    const originalAcquire = store.acquireRunLock.bind(store);
    store.acquireRunLock = async (...args) => {
      preflightBarrier.resolve();
      await releaseBarrier.promise;
      return originalAcquire(...args);
    };

    const reviewedTree = await computeTreeDigest(repoDir);
    const reviewedDiff = await computeDiffDigest(repoDir);

    const resSnap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const writePromise = store.recordReviewResult(run.runId, {
      runId: run.runId,
      taskId: run.taskId,
      reviewedBaseCommit: run.baseCommit,
      cycle: 1,
      reviewer: {
        identity: "rev-carol",
        session: "sess-carol-1",
        readOnlyConfirmed: true,
      },
      reviewedTreeDigest: reviewedTree,
      reviewedDiffDigest: reviewedDiff,
      verdict: "PASS",
      findings: [],
      recordedAt: new Date().toISOString(),
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: resSnap.digest,
    });

    await preflightBarrier.promise;

    // Delete review request artifact during the race window
    const reqPath = join(repoDir, ".agent", "runtime", run.runId, "review-request-cycle-1.json");
    await rm(reqPath);

    releaseBarrier.resolve();

    await assert.rejects(
      writePromise,
      (err: unknown) => {
        assert.ok(
          err instanceof ArtifactValidationError,
          `Expected ArtifactValidationError, got ${String(err)}`
        );
        return true;
      }
    );

    const canonicalPath = join(repoDir, ".agent", "runtime", run.runId, "review-result-cycle-1.json");
    assert.equal(existsSync(canonicalPath), false, "review-result-cycle-1.json must NOT exist on disk");
    assert.equal(existsSync(join(repoDir, ".agent", "runtime", run.runId, ".run.lock")), false, "Run lock must be released");
  } finally {
    await cleanup();
  }
});

// =========================================================================
// R6-R5: M01 Atomic Run + Baseline Initialization
// =========================================================================

test("R6-R5 M01 TEST A: NORMAL INIT - run.json and baseline.json simultaneously present and valid", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "m01-test-normal", taskId: "TEST-TASK-001" });

    const runPath = join(repoDir, ".agent", "runtime", run.runId, "run.json");
    const baselinePath = join(repoDir, ".agent", "runtime", run.runId, "baseline.json");

    assert.equal(existsSync(runPath), true, "run.json must exist in published directory");
    assert.equal(existsSync(baselinePath), true, "baseline.json must exist in published directory");

    const runData = JSON.parse(await readFile(runPath, "utf8"));
    const baselineData = JSON.parse(await readFile(baselinePath, "utf8"));

    assert.equal(runData.runId, run.runId);
    assert.equal(baselineData.runId, run.runId);
    assert.equal(runData.taskId, "TEST-TASK-001");
    assert.equal(baselineData.taskId, "TEST-TASK-001");
    assert.equal(runData.baseCommit, baselineData.baseCommit);
    assert.equal(runData.taskAuthorityCommit, baselineData.taskAuthorityCommit);
    assert.equal(runData.upstreamRef, baselineData.upstreamRef);
    assert.equal(runData.upstreamCommit, baselineData.upstreamCommit);
  } finally {
    await cleanup();
  }
});

test("R6-R5 M01 TEST B: STAGING NOT ACTIVE - .agent/.cindy-init-staging ignored by active scanner", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const store = orchestrator.artifactStore;

    // Create partial/unrelated data in staging directory
    const stagingFoo = join(repoDir, ".agent", ".cindy-init-staging", "foo");
    await mkdir(stagingFoo, { recursive: true });
    await writeFile(join(stagingFoo, "run.json"), JSON.stringify({ runId: "foo", taskId: "TEST-TASK-001", state: "TESTING" }), "utf8");

    const stagingBar = join(repoDir, ".agent", ".cindy-init-staging", "bar");
    await mkdir(stagingBar, { recursive: true });
    await writeFile(join(stagingBar, "baseline.json"), JSON.stringify({ runId: "bar", taskId: "TEST-TASK-001" }), "utf8");

    // Active run scanner must NOT consider .cindy-init-staging entries
    const active = await store.resolveActiveRunForTask("TEST-TASK-001");
    assert.equal(active, null, "resolveActiveRunForTask must return null when only staging residue exists");

    const allActive = await store.resolveAllActiveRuns();
    assert.equal(allActive.length, 0, "resolveAllActiveRuns must return empty array when only staging residue exists");

    // Normal initialization must still succeed
    const run = await orchestrator.initRun({ runId: "m01-init-with-staging", taskId: "TEST-TASK-001" });
    assert.equal(run.runId, "m01-init-with-staging");
  } finally {
    await cleanup();
  }
});

test("R6-R5 M01 TEST C: CRASH RESIDUE IN STAGING DOES NOT TAKE ACTIVE SLOT OR TRIGGER INVALID_RUN_RECORD", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const store = orchestrator.artifactStore;

    // Create corrupted residue in staging
    const crashStaging = join(repoDir, ".agent", ".cindy-init-staging", "crash-orphan");
    await mkdir(crashStaging, { recursive: true });
    await writeFile(join(crashStaging, "run.json"), "truncated invalid json {{{", "utf8");

    // Must not throw InvalidRunRecordError
    const allActive = await store.resolveAllActiveRuns();
    assert.equal(allActive.length, 0);

    const reconcileResult = await reconcileCurrentState({ repoDir, taskId: "TEST-TASK-001" });
    assert.equal(reconcileResult.stopReason, null);
  } finally {
    await cleanup();
  }
});

test("R6-R5 M01 TEST D: FINAL RUN DIRECTORY COLLISION FAILS CLOSED", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });

    // Pre-create the final runtime directory
    const collisionDir = join(repoDir, ".agent", "runtime", "m01-collision-run");
    await mkdir(collisionDir, { recursive: true });
    await writeFile(join(collisionDir, "pre-existing.txt"), "do not overwrite", "utf8");

    await assert.rejects(
      () => orchestrator.initRun({ runId: "m01-collision-run", taskId: "TEST-TASK-001" }),
      (err: unknown) => {
        assert.ok(
          err instanceof ConflictingArtifactError || err instanceof ArtifactValidationError || err instanceof ConcurrentRunUpdateError,
          `Expected conflict or validation error, got ${String(err)}`
        );
        return true;
      }
    );

    // Existing directory contents must remain untouched
    assert.equal(existsSync(join(collisionDir, "pre-existing.txt")), true);
    assert.equal(existsSync(join(collisionDir, "run.json")), false);
    assert.equal(existsSync(join(collisionDir, "baseline.json")), false);
  } finally {
    await cleanup();
  }
});

test("R6-R5 M01 TEST E: FINAL BUNDLE INVARIANT - no half-initialized runs exist across runtime", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    await orchestrator.initRun({ runId: "m01-bundle-1", taskId: "TEST-TASK-001" });

    const runtimeDir = join(repoDir, ".agent", "runtime");
    const entries = await readdir(runtimeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const runJsonExists = existsSync(join(runtimeDir, entry.name, "run.json"));
      const baselineJsonExists = existsSync(join(runtimeDir, entry.name, "baseline.json"));

      assert.equal(
        runJsonExists && baselineJsonExists,
        true,
        `Directory '${entry.name}' must have both run.json and baseline.json`
      );
    }
  } finally {
    await cleanup();
  }
});

// =========================================================================
// R6-R5: L01 Documentation Invariant Tests
// =========================================================================

test("R6-R5 L01: documentation defines STRUCTURE_VALID_EXTERNAL precisely without overclaims", async () => {
  const docPath = join(process.cwd(), "docs", "development", "cindy-orchestration.md");
  const docContent = await readFile(docPath, "utf8");

  assert.ok(
    docContent.includes("STRUCTURE_VALID_EXTERNAL 表示该工件由外部执行者产生"),
    "Doc must contain precise definition of STRUCTURE_VALID_EXTERNAL"
  );
  assert.ok(
    docContent.includes("该分类不表示 Cindy 自己执行了测试、Review 或外部命令"),
    "Doc must state that Cindy does not execute tests/review itself"
  );
  assert.ok(
    !docContent.includes("TRUSTED_EXECUTOR_PASS"),
    "Doc must not introduce unapproved TRUSTED_EXECUTOR_PASS"
  );
  assert.ok(
    !docContent.includes("- `PROCESS_ATTESTED`") && !docContent.includes('"PROCESS_ATTESTED"'),
    "Doc must not introduce unapproved PROCESS_ATTESTED as valid classification"
  );
});

// =========================================================================
// R6-R6: H04 DUPLICATE REPLAY LOCKED REVALIDATION TESTS (Architecture Decisions BK-BO)
// =========================================================================

test("R6-R6 H04 TEST 1: TEST_RESULT IDENTICAL DUPLICATE STATE RACE", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r6-h04-t1", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const treeDigest = await computeTreeDigest(repoDir);
    const testPayload = {
      command: "pnpm test",
      exitCode: 0,
      status: "PASS" as const,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      boundTreeDigest: treeDigest,
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    };

    // 1. Legal first write: TEST_RESULT A
    const res1 = await store.recordTestResult(run.runId, testPayload);
    assert.equal(res1.isDuplicate, false);

    const artifactPath = store.getArtifactPath(run.runId, ArtifactKind.TEST_RESULT, 1);
    const originalArtifactBytes = await readFile(artifactPath);

    // 2. Second call recordTestResult(A) with barrier before acquireRunLock
    const preflightBarrier = createTestBarrier();
    const releaseBarrier = createTestBarrier();

    const originalAcquire = store.acquireRunLock.bind(store);
    store.acquireRunLock = async (...args) => {
      preflightBarrier.resolve();
      await releaseBarrier.promise;
      return originalAcquire(...args);
    };

    const secondWritePromise = store.recordTestResult(run.runId, testPayload);
    await preflightBarrier.promise;

    // 3. Concurrently second store transitions TESTING -> BLOCKED
    const store2 = new RuntimeArtifactStore({ repoDir });
    const blockedRun = await store2.applyAdministrativeTransition(run.runId, CindyState.BLOCKED, {
      reason: "Administrative pause to BLOCKED",
    });
    assert.equal(blockedRun.state, CindyState.BLOCKED);

    // 4. Release barrier
    releaseBarrier.resolve();

    // 5. Must reject under lock (cannot return isDuplicate: true)
    await assert.rejects(
      secondWritePromise,
      (err: unknown) => {
        assert.ok(
          err instanceof ArtifactValidationError || err instanceof TransitionRejectedError,
          `Expected ArtifactValidationError or TransitionRejectedError, got ${String(err)}`
        );
        return true;
      }
    );

    // Assertions:
    // - artifact bytes unchanged
    const currentArtifactBytes = await readFile(artifactPath);
    assert.deepEqual(currentArtifactBytes, originalArtifactBytes, "Artifact bytes must be unchanged");

    // - run state remains BLOCKED
    const finalRun = await store2.getRun(run.runId);
    assert.equal(finalRun.state, CindyState.BLOCKED, "Run state must remain BLOCKED");

    // - run version remains second store version
    assert.equal(finalRun.version, blockedRun.version, "Run version must match version after transition to BLOCKED");

    // - no extra artifact
    const runDirFiles = await readdir(join(repoDir, ".agent", "runtime", run.runId));
    const testResultFiles = runDirFiles.filter((f) => f.startsWith("test-result"));
    assert.equal(testResultFiles.length, 1, "Only 1 test result file should exist");

    // - no lock residue
    assert.equal(existsSync(join(repoDir, ".agent", "runtime", run.runId, ".run.lock")), false, "No lock residue");
  } finally {
    await cleanup();
  }
});

test("R6-R6 H04 TEST 2: TEST_RESULT IDENTICAL DUPLICATE TREE RACE", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r6-h04-t2", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const treeDigest = await computeTreeDigest(repoDir);
    const testPayload = {
      command: "pnpm test",
      exitCode: 0,
      status: "PASS" as const,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      boundTreeDigest: treeDigest,
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    };

    const res1 = await store.recordTestResult(run.runId, testPayload);
    assert.equal(res1.isDuplicate, false);

    const preflightBarrier = createTestBarrier();
    const releaseBarrier = createTestBarrier();

    const originalAcquire = store.acquireRunLock.bind(store);
    store.acquireRunLock = async (...args) => {
      preflightBarrier.resolve();
      await releaseBarrier.promise;
      return originalAcquire(...args);
    };

    const secondWritePromise = store.recordTestResult(run.runId, testPayload);
    await preflightBarrier.promise;

    // Mutate allowed-scope tracked file
    await appendFile(join(repoDir, "schemas", "cindy-run.schema.json"), "\n/* tree race change */\n");

    releaseBarrier.resolve();

    await assert.rejects(
      secondWritePromise,
      (err: unknown) => {
        assert.ok(
          err instanceof ArtifactDigestMismatchError,
          `Expected ArtifactDigestMismatchError, got ${String(err)}`
        );
        return true;
      }
    );
  } finally {
    await cleanup();
  }
});

test("R6-R6 H04 TEST 3: TEST_RESULT IDENTICAL DUPLICATE HEAD RACE", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r6-h04-t3", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const treeDigest = await computeTreeDigest(repoDir);
    const testPayload = {
      command: "pnpm test",
      exitCode: 0,
      status: "PASS" as const,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      boundTreeDigest: treeDigest,
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    };

    const res1 = await store.recordTestResult(run.runId, testPayload);
    assert.equal(res1.isDuplicate, false);

    const preflightBarrier = createTestBarrier();
    const releaseBarrier = createTestBarrier();

    const originalAcquire = store.acquireRunLock.bind(store);
    store.acquireRunLock = async (...args) => {
      preflightBarrier.resolve();
      await releaseBarrier.promise;
      return originalAcquire(...args);
    };

    const secondWritePromise = store.recordTestResult(run.runId, testPayload);
    await preflightBarrier.promise;

    // Advance HEAD commit
    const { execSync } = await import("child_process");
    execSync("git commit --allow-empty -m 'HEAD drift commit'", { cwd: repoDir, stdio: "ignore" });

    releaseBarrier.resolve();

    await assert.rejects(
      secondWritePromise,
      (err: unknown) => {
        assert.ok(
          err instanceof TransitionRejectedError,
          `Expected TransitionRejectedError, got ${String(err)}`
        );
        return true;
      }
    );
  } finally {
    await cleanup();
  }
});

test("R6-R6 H04 TEST 4: TEST_RESULT CLEAN REPLAY", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r6-h04-t4", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const treeDigest = await computeTreeDigest(repoDir);
    const testPayload = {
      command: "pnpm test",
      exitCode: 0,
      status: "PASS" as const,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      boundTreeDigest: treeDigest,
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    };

    const res1 = await store.recordTestResult(run.runId, testPayload);
    assert.equal(res1.isDuplicate, false);

    const runBefore = await store.getRun(run.runId);
    const artifactPath = store.getArtifactPath(run.runId, ArtifactKind.TEST_RESULT, 1);
    const bytesBefore = await readFile(artifactPath);

    // Clean replay: no repo or run change
    const res2 = await store.recordTestResult(run.runId, testPayload);
    assert.equal(res2.isDuplicate, true);

    const runAfter = await store.getRun(run.runId);
    const bytesAfter = await readFile(artifactPath);

    assert.equal(runAfter.version, runBefore.version, "run.version must not bump on clean duplicate");
    assert.deepEqual(bytesAfter, bytesBefore, "artifact bytes must not mutate");
    assert.equal(runAfter.history.length, runBefore.history.length, "no new history entries");

    const files = await readdir(join(repoDir, ".agent", "runtime", run.runId));
    assert.equal(files.filter((f) => f.startsWith(".tmp_")).length, 0, "no temp files");
  } finally {
    await cleanup();
  }
});

test("R6-R6 H04 TEST 5: DIFF_MANIFEST DUPLICATE DRIFT", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r6-h04-t5", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const res1 = await store.recordDiffManifest(run.runId, {
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    });
    assert.equal(res1.isDuplicate, false);

    const preflightBarrier = createTestBarrier();
    const releaseBarrier = createTestBarrier();

    const originalAcquire = store.acquireRunLock.bind(store);
    store.acquireRunLock = async (...args) => {
      preflightBarrier.resolve();
      await releaseBarrier.promise;
      return originalAcquire(...args);
    };

    const secondPromise = store.recordDiffManifest(run.runId, {
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    });
    await preflightBarrier.promise;

    // Mutate tree
    await appendFile(join(repoDir, "schemas", "cindy-run.schema.json"), "\n/* diff drift */\n");

    releaseBarrier.resolve();

    await assert.rejects(
      secondPromise,
      (err: unknown) => {
        assert.ok(
          err instanceof ArtifactDigestMismatchError || err instanceof ArtifactValidationError,
          `Expected ArtifactDigestMismatchError or ArtifactValidationError, got ${String(err)}`
        );
        return true;
      }
    );
  } finally {
    await cleanup();
  }
});

test("R6-R6 H04 TEST 6: DIFF_MANIFEST CLEAN REPLAY", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r6-h04-t6", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const res1 = await store.recordDiffManifest(run.runId, {
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    });
    assert.equal(res1.isDuplicate, false);

    const runBefore = await store.getRun(run.runId);
    const res2 = await store.recordDiffManifest(run.runId, {
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    });
    assert.equal(res2.isDuplicate, true);

    const runAfter = await store.getRun(run.runId);
    assert.equal(runAfter.version, runBefore.version);
    assert.equal(runAfter.history.length, runBefore.history.length);
  } finally {
    await cleanup();
  }
});

test("R6-R6 H04 TEST 7: REVIEW_REQUEST DUPLICATE HEAD/TREE RACE", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r6-h04-t7", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: await orchestrator.computeCurrentTreeDigest(),
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
    await orchestrator.prepareForReview(run.runId);

    const requestOptions = {
      reviewer: {
        identity: "Reviewer Cindy",
        session: "sess-r6-7",
        readOnlyConfirmed: true,
        readOnlyRequired: true,
      },
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    };

    const res1 = await store.recordReviewRequest(run.runId, requestOptions);
    assert.equal(res1.isDuplicate, false);

    const preflightBarrier = createTestBarrier();
    const releaseBarrier = createTestBarrier();

    const originalAcquire = store.acquireRunLock.bind(store);
    store.acquireRunLock = async (...args) => {
      preflightBarrier.resolve();
      await releaseBarrier.promise;
      return originalAcquire(...args);
    };

    const secondPromise = store.recordReviewRequest(run.runId, requestOptions);
    await preflightBarrier.promise;

    // Mutate tree
    await appendFile(join(repoDir, "schemas", "cindy-run.schema.json"), "\n/* tree race change */\n");

    releaseBarrier.resolve();

    await assert.rejects(
      secondPromise,
      (err: unknown) => {
        assert.ok(
          err instanceof ArtifactDigestMismatchError || err instanceof TransitionRejectedError,
          `Expected ArtifactDigestMismatchError or TransitionRejectedError, got ${String(err)}`
        );
        return true;
      }
    );
  } finally {
    await cleanup();
  }
});

test("R6-R6 H04 TEST 8: REVIEW_REQUEST CLEAN REPLAY", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r6-h04-t8", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    await orchestrator.recordTestResult(run.runId, {
      cycle: 1,
      command: "pnpm test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      boundTreeDigest: await orchestrator.computeCurrentTreeDigest(),
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      status: "PASS",
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest
    });
    await orchestrator.recordDiffManifest(run.runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
    await orchestrator.prepareForReview(run.runId);

    const requestOptions = {
      reviewer: {
        identity: "Reviewer Cindy",
        session: "sess-r6-8",
        readOnlyConfirmed: true,
        readOnlyRequired: true,
      },
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    };

    const res1 = await store.recordReviewRequest(run.runId, requestOptions);
    assert.equal(res1.isDuplicate, false);

    const runBefore = await store.getRun(run.runId);
    const res2 = await store.recordReviewRequest(run.runId, requestOptions);
    assert.equal(res2.isDuplicate, true);

    const runAfter = await store.getRun(run.runId);
    assert.equal(runAfter.version, runBefore.version);
    assert.equal(runAfter.history.length, runBefore.history.length);
  } finally {
    await cleanup();
  }
});

test("R6-R6 H04 TEST 9: REVIEW_RESULT PASS DUPLICATE TREE RACE", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r6-h04-t9", taskId: "TEST-TASK-001" });
    await advanceRunToReviewing(orchestrator, run.runId, "sess-r6-9");
    const store = orchestrator.artifactStore;

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const passPayload: ReviewResultArtifact = {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Reviewer Cindy", session: "sess-r6-9", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: await orchestrator.computeCurrentTreeDigest(),
      reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
      verdict: "PASS",
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
      findings: [],
      recordedAt: new Date().toISOString(),
    };

    const res1 = await orchestrator.recordValidatedReviewResult(run.runId, passPayload);
    assert.equal(res1.state, CindyState.REVIEWING);

    const preflightBarrier = createTestBarrier();
    const releaseBarrier = createTestBarrier();

    const originalAcquire = store.acquireRunLock.bind(store);
    store.acquireRunLock = async (...args) => {
      preflightBarrier.resolve();
      await releaseBarrier.promise;
      return originalAcquire(...args);
    };

    const secondPromise = orchestrator.recordValidatedReviewResult(run.runId, passPayload);
    await preflightBarrier.promise;

    // Mutate tree
    await appendFile(join(repoDir, "schemas", "cindy-run.schema.json"), "\n/* tree race change */\n");

    releaseBarrier.resolve();

    await assert.rejects(
      secondPromise,
      (err: unknown) => {
        assert.ok(
          err instanceof ArtifactDigestMismatchError,
          `Expected ArtifactDigestMismatchError, got ${String(err)}`
        );
        return true;
      }
    );
  } finally {
    await cleanup();
  }
});

test("R6-R6 H04 TEST 10: REVIEW_RESULT PASS CLEAN REPLAY", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r6-h04-t10", taskId: "TEST-TASK-001" });
    await advanceRunToReviewing(orchestrator, run.runId, "sess-r6-10");

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const passPayload: ReviewResultArtifact = {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Reviewer Cindy", session: "sess-r6-10", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: await orchestrator.computeCurrentTreeDigest(),
      reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
      verdict: "PASS",
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
      findings: [],
      recordedAt: new Date().toISOString(),
    };

    const res1 = await orchestrator.recordValidatedReviewResult(run.runId, passPayload);
    assert.equal(res1.state, CindyState.REVIEWING);
    const vFirst = res1.version;
    const historyLenFirst = res1.history.length;

    const res2 = await orchestrator.recordValidatedReviewResult(run.runId, passPayload);
    assert.equal(res2.state, CindyState.REVIEWING);
    assert.equal(res2.version, vFirst, "Version must not bump on identical PASS replay");
    assert.equal(res2.history.length, historyLenFirst, "History must not duplicate PASS entry");
  } finally {
    await cleanup();
  }
});

test("R6-R6 H04 TEST 11: REVIEW_RESULT FAIL APPROVED REPLAY", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r6-h04-t11", taskId: "TEST-TASK-001" });
    await advanceRunToReviewing(orchestrator, run.runId, "sess-r6-11");
    const store = orchestrator.artifactStore;

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const failPayload: ReviewResultArtifact = {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Reviewer Cindy", session: "sess-r6-11", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: await orchestrator.computeCurrentTreeDigest(),
      reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
      verdict: "FAIL",
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
      findings: [{ id: "F1", severity: "HIGH", title: "Original finding" }],
      recordedAt: new Date().toISOString(),
    };

    const first = await orchestrator.recordValidatedReviewResult(run.runId, failPayload);
    assert.equal(first.state, CindyState.REPAIR_INITIALIZED);
    assert.equal(first.currentCycle, 2);
    const vFirst = first.version;
    const historyLenFirst = first.history.length;

    const artifactPath = store.getArtifactPath(run.runId, ArtifactKind.REVIEW_RESULT, 1);
    const bytesFirst = await readFile(artifactPath);

    // New invocation: same cycle 1, same result A, facts unchanged
    const second = await orchestrator.recordValidatedReviewResult(run.runId, failPayload);
    assert.equal(second.state, CindyState.REPAIR_INITIALIZED);
    assert.equal(second.version, vFirst, "currentCycle and version must not increase");
    assert.equal(second.currentCycle, 2, "currentCycle must remain 2");
    assert.equal(second.history.length, historyLenFirst, "history must not increase");

    const bytesSecond = await readFile(artifactPath);
    assert.deepEqual(bytesSecond, bytesFirst, "artifact bytes must not change");
  } finally {
    await cleanup();
  }
});

test("R6-R6 H04 TEST 12: REVIEW_RESULT FAIL REPLAY WITH NEW DRIFT", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r6-h04-t12", taskId: "TEST-TASK-001" });
    await advanceRunToReviewing(orchestrator, run.runId, "sess-r6-12");
    const store = orchestrator.artifactStore;

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const failPayload: ReviewResultArtifact = {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Reviewer Cindy", session: "sess-r6-12", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: await orchestrator.computeCurrentTreeDigest(),
      reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
      verdict: "FAIL",
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
      findings: [{ id: "F1", severity: "HIGH", title: "Original finding" }],
      recordedAt: new Date().toISOString(),
    };

    await orchestrator.recordValidatedReviewResult(run.runId, failPayload);

    const preflightBarrier = createTestBarrier();
    const releaseBarrier = createTestBarrier();

    const originalAcquire = store.acquireRunLock.bind(store);
    store.acquireRunLock = async (...args) => {
      preflightBarrier.resolve();
      await releaseBarrier.promise;
      return originalAcquire(...args);
    };

    const secondPromise = orchestrator.recordValidatedReviewResult(run.runId, failPayload);
    await preflightBarrier.promise;

    // Mutate tree
    await appendFile(join(repoDir, "schemas", "cindy-run.schema.json"), "\n/* tree drift */\n");

    releaseBarrier.resolve();

    await assert.rejects(
      secondPromise,
      (err: unknown) => {
        assert.ok(
          err instanceof ArtifactDigestMismatchError,
          `Expected ArtifactDigestMismatchError, got ${String(err)}`
        );
        return true;
      }
    );
  } finally {
    await cleanup();
  }
});

test("R6-R6 H04 TEST 13: REVIEW_REQUEST DELETED BEFORE DUPLICATE REVIEW_RESULT", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r6-h04-t13", taskId: "TEST-TASK-001" });
    await advanceRunToReviewing(orchestrator, run.runId, "sess-r6-13");
    const store = orchestrator.artifactStore;

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const failPayload: ReviewResultArtifact = {
      runId: run.runId,
      taskId: run.taskId,
      cycle: 1,
      reviewer: { identity: "Reviewer Cindy", session: "sess-r6-13", readOnlyConfirmed: true },
      reviewedBaseCommit: run.baseCommit,
      reviewedTreeDigest: await orchestrator.computeCurrentTreeDigest(),
      reviewedDiffDigest: await orchestrator.computeCurrentDiffDigest(),
      verdict: "FAIL",
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
      findings: [{ id: "F1", severity: "HIGH", title: "Original finding" }],
      recordedAt: new Date().toISOString(),
    };

    await orchestrator.recordValidatedReviewResult(run.runId, failPayload);

    const preflightBarrier = createTestBarrier();
    const releaseBarrier = createTestBarrier();

    const originalAcquire = store.acquireRunLock.bind(store);
    store.acquireRunLock = async (...args) => {
      preflightBarrier.resolve();
      await releaseBarrier.promise;
      return originalAcquire(...args);
    };

    const secondPromise = orchestrator.recordValidatedReviewResult(run.runId, failPayload);
    await preflightBarrier.promise;

    // Delete bound review request on disk
    const reqPath = store.getArtifactPath(run.runId, ArtifactKind.REVIEW_REQUEST, 1);
    await unlink(reqPath);

    releaseBarrier.resolve();

    await assert.rejects(
      secondPromise,
      (err: unknown) => {
        assert.ok(
          err instanceof ArtifactValidationError,
          `Expected ArtifactValidationError, got ${String(err)}`
        );
        return true;
      }
    );
  } finally {
    await cleanup();
  }
});

test("R6-R6 H04 TEST 14: VERSION-ONLY RACE", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "r6-r6-h04-t14", taskId: "TEST-TASK-001" });
    const store = orchestrator.artifactStore;

    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);

    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const treeDigest = await computeTreeDigest(repoDir);
    const testPayload = {
      command: "pnpm test",
      exitCode: 0,
      status: "PASS" as const,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      logDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      boundTreeDigest: treeDigest,
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    };

    const res1 = await store.recordTestResult(run.runId, testPayload);
    assert.equal(res1.isDuplicate, false);

    const preflightBarrier = createTestBarrier();
    const releaseBarrier = createTestBarrier();

    const originalAcquire = store.acquireRunLock.bind(store);
    store.acquireRunLock = async (...args) => {
      preflightBarrier.resolve();
      await releaseBarrier.promise;
      return originalAcquire(...args);
    };

    const secondPromise = store.recordTestResult(run.runId, testPayload);
    await preflightBarrier.promise;

    // Mutate only run.version on disk without altering tree, git, or state
    const runPath = store.getArtifactPath(run.runId, ArtifactKind.RUN);
    const runContent = JSON.parse(await readFile(runPath, "utf8"));
    runContent.version += 1;
    await writeFile(runPath, JSON.stringify(runContent, null, 2) + "\n", "utf8");

    releaseBarrier.resolve();

    await assert.rejects(
      secondPromise,
      (err: unknown) => {
        assert.ok(
          err instanceof ArtifactValidationError,
          `Expected ArtifactValidationError, got ${String(err)}`
        );
        return true;
      }
    );
  } finally {
    await cleanup();
  }
});

// =========================================================================
// CINDY-ORCH-MVP-R2F3-R2-R1 Architecture Decision CU: No Backfill Matrix
// =========================================================================

async function assertNoSideEffectsOrch(
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

  const lock = await store.acquireRunLock(runId);
  await store.releaseRunLock(runDir, lock.ownerId);
}

test("R2F3-R2-R1 NB TEST 1: CindyOrchestrator.recordTestResult missing version -> reject", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-nb-01", taskId: "TASK-NB-01" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const tree = await orchestrator.computeCurrentTreeDigest();
    const testingRun = await orchestrator.getRun(run.runId);

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

    await assertNoSideEffectsOrch(orchestrator, run.runId, testingRun, ArtifactKind.TEST_RESULT, 1, repoDir);
  } finally {
    await cleanup();
  }
});

test("R2F3-R2-R1 NB TEST 2: CindyOrchestrator.recordTestResult missing digest -> reject", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-nb-02", taskId: "TASK-NB-01" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);
    const tree = await orchestrator.computeCurrentTreeDigest();
    const testingRun = await orchestrator.getRun(run.runId);

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

    await assertNoSideEffectsOrch(orchestrator, run.runId, testingRun, ArtifactKind.TEST_RESULT, 1, repoDir);
  } finally {
    await cleanup();
  }
});

test("R2F3-R2-R1 NB TEST 3: CindyOrchestrator.recordTestResult missing both -> reject", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-nb-03", taskId: "TASK-NB-01" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);
    const tree = await orchestrator.computeCurrentTreeDigest();
    const testingRun = await orchestrator.getRun(run.runId);

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

    await assertNoSideEffectsOrch(orchestrator, run.runId, testingRun, ArtifactKind.TEST_RESULT, 1, repoDir);
  } finally {
    await cleanup();
  }
});

test("R2F3-R2-R1 NB TEST 4: CindyOrchestrator.recordDiffManifest missing version -> reject", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-nb-04", taskId: "TASK-NB-02" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const testingRun = await orchestrator.getRun(run.runId);

    await assert.rejects(
      async () => {
        await orchestrator.recordDiffManifest(run.runId, {
          executionSnapshotVersion: undefined as any,
          executionSnapshotDigest: snap.digest,
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );

    await assertNoSideEffectsOrch(orchestrator, run.runId, testingRun, ArtifactKind.DIFF_MANIFEST, 1, repoDir);
  } finally {
    await cleanup();
  }
});

test("R2F3-R2-R1 NB TEST 5: CindyOrchestrator.recordDiffManifest missing digest -> reject", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-nb-05", taskId: "TASK-NB-02" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);
    const testingRun = await orchestrator.getRun(run.runId);

    await assert.rejects(
      async () => {
        await orchestrator.recordDiffManifest(run.runId, {
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: undefined as any,
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );

    await assertNoSideEffectsOrch(orchestrator, run.runId, testingRun, ArtifactKind.DIFF_MANIFEST, 1, repoDir);
  } finally {
    await cleanup();
  }
});

test("R2F3-R2-R1 NB TEST 6: CindyOrchestrator.recordDiffManifest missing both -> reject", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-nb-06", taskId: "TASK-NB-02" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);
    const testingRun = await orchestrator.getRun(run.runId);

    await assert.rejects(
      async () => {
        await orchestrator.recordDiffManifest(run.runId, {} as any);
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );

    await assertNoSideEffectsOrch(orchestrator, run.runId, testingRun, ArtifactKind.DIFF_MANIFEST, 1, repoDir);
  } finally {
    await cleanup();
  }
});

test("R2F3-R2-R1 NB TEST 7: CindyOrchestrator.recordReviewRequest missing version -> reject", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-nb-07", taskId: "TASK-NB-03" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const tree = await orchestrator.computeCurrentTreeDigest();
    await orchestrator.recordTestResult(run.runId, {
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
    await orchestrator.recordDiffManifest(run.runId, {
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    });
    await orchestrator.prepareForReview(run.runId);
    const readyRun = await orchestrator.getRun(run.runId);

    await assert.rejects(
      async () => {
        await orchestrator.recordReviewRequest(run.runId, {
          reviewer: { identity: "Reviewer Cindy", session: "sess-nb-07", readOnlyConfirmed: true },
          cycle: 1,
          executionSnapshotVersion: undefined as any,
          executionSnapshotDigest: snap.digest,
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );

    await assertNoSideEffectsOrch(orchestrator, run.runId, readyRun, ArtifactKind.REVIEW_REQUEST, 1, repoDir);
  } finally {
    await cleanup();
  }
});

test("R2F3-R2-R1 NB TEST 8: CindyOrchestrator.recordReviewRequest missing digest -> reject", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-nb-08", taskId: "TASK-NB-03" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const tree = await orchestrator.computeCurrentTreeDigest();
    await orchestrator.recordTestResult(run.runId, {
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
    await orchestrator.recordDiffManifest(run.runId, {
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    });
    await orchestrator.prepareForReview(run.runId);
    const readyRun = await orchestrator.getRun(run.runId);

    await assert.rejects(
      async () => {
        await orchestrator.recordReviewRequest(run.runId, {
          reviewer: { identity: "Reviewer Cindy", session: "sess-nb-08", readOnlyConfirmed: true },
          cycle: 1,
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: undefined as any,
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );

    await assertNoSideEffectsOrch(orchestrator, run.runId, readyRun, ArtifactKind.REVIEW_REQUEST, 1, repoDir);
  } finally {
    await cleanup();
  }
});

test("R2F3-R2-R1 NB TEST 9: CindyOrchestrator.recordReviewRequest missing both -> reject", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-nb-09", taskId: "TASK-NB-03" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const tree = await orchestrator.computeCurrentTreeDigest();
    await orchestrator.recordTestResult(run.runId, {
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
    await orchestrator.recordDiffManifest(run.runId, {
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    });
    await orchestrator.prepareForReview(run.runId);
    const readyRun = await orchestrator.getRun(run.runId);

    await assert.rejects(
      async () => {
        await orchestrator.recordReviewRequest(run.runId, {
          reviewer: { identity: "Reviewer Cindy", session: "sess-nb-09", readOnlyConfirmed: true },
          cycle: 1,
          executionSnapshotVersion: undefined as any,
          executionSnapshotDigest: undefined as any,
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );

    await assertNoSideEffectsOrch(orchestrator, run.runId, readyRun, ArtifactKind.REVIEW_REQUEST, 1, repoDir);
  } finally {
    await cleanup();
  }
});

test("R2F3-R2-R1 NB TEST 10: CindyOrchestrator.recordValidatedReviewResult missing version -> reject", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-nb-10", taskId: "TASK-NB-04" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const tree = await orchestrator.computeCurrentTreeDigest();
    await orchestrator.recordTestResult(run.runId, {
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
    await orchestrator.recordDiffManifest(run.runId, {
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    });
    await orchestrator.prepareForReview(run.runId);
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Reviewer Cindy", session: "sess-nb-10", readOnlyConfirmed: true, readOnlyRequired: true },
    });
    const reviewingRun = await orchestrator.getRun(run.runId);
    const diff = await orchestrator.computeCurrentDiffDigest();

    await assert.rejects(
      async () => {
        await orchestrator.recordValidatedReviewResult(run.runId, {
          runId: run.runId,
          taskId: run.taskId,
          cycle: 1,
          reviewer: { identity: "Reviewer Cindy", session: "sess-nb-10", readOnlyConfirmed: true },
          reviewedBaseCommit: run.baseCommit,
          reviewedTreeDigest: tree,
          reviewedDiffDigest: diff,
          verdict: "FAIL",
          findings: [{ id: "F1", severity: "HIGH", title: "Error" }],
          recordedAt: new Date().toISOString(),
          executionSnapshotVersion: undefined as any,
          executionSnapshotDigest: snap.digest,
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );

    await assertNoSideEffectsOrch(orchestrator, run.runId, reviewingRun, ArtifactKind.REVIEW_RESULT, 1, repoDir);
  } finally {
    await cleanup();
  }
});

test("R2F3-R2-R1 NB TEST 11: CindyOrchestrator.recordValidatedReviewResult missing digest -> reject", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-nb-11", taskId: "TASK-NB-04" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const tree = await orchestrator.computeCurrentTreeDigest();
    await orchestrator.recordTestResult(run.runId, {
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
    await orchestrator.recordDiffManifest(run.runId, {
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    });
    await orchestrator.prepareForReview(run.runId);
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Reviewer Cindy", session: "sess-nb-11", readOnlyConfirmed: true, readOnlyRequired: true },
    });
    const reviewingRun = await orchestrator.getRun(run.runId);
    const diff = await orchestrator.computeCurrentDiffDigest();

    await assert.rejects(
      async () => {
        await orchestrator.recordValidatedReviewResult(run.runId, {
          runId: run.runId,
          taskId: run.taskId,
          cycle: 1,
          reviewer: { identity: "Reviewer Cindy", session: "sess-nb-11", readOnlyConfirmed: true },
          reviewedBaseCommit: run.baseCommit,
          reviewedTreeDigest: tree,
          reviewedDiffDigest: diff,
          verdict: "FAIL",
          findings: [{ id: "F1", severity: "HIGH", title: "Error" }],
          recordedAt: new Date().toISOString(),
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: undefined as any,
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );

    await assertNoSideEffectsOrch(orchestrator, run.runId, reviewingRun, ArtifactKind.REVIEW_RESULT, 1, repoDir);
  } finally {
    await cleanup();
  }
});

test("R2F3-R2-R1 NB TEST 12: CindyOrchestrator.recordValidatedReviewResult missing both -> reject", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-nb-12", taskId: "TASK-NB-04" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const tree = await orchestrator.computeCurrentTreeDigest();
    await orchestrator.recordTestResult(run.runId, {
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
    await orchestrator.recordDiffManifest(run.runId, {
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: snap.digest,
    });
    await orchestrator.prepareForReview(run.runId);
    await orchestrator.startReview(run.runId, {
      reviewer: { identity: "Reviewer Cindy", session: "sess-nb-12", readOnlyConfirmed: true, readOnlyRequired: true },
    });
    const reviewingRun = await orchestrator.getRun(run.runId);
    const diff = await orchestrator.computeCurrentDiffDigest();

    await assert.rejects(
      async () => {
        await orchestrator.recordValidatedReviewResult(run.runId, {
          runId: run.runId,
          taskId: run.taskId,
          cycle: 1,
          reviewer: { identity: "Reviewer Cindy", session: "sess-nb-12", readOnlyConfirmed: true },
          reviewedBaseCommit: run.baseCommit,
          reviewedTreeDigest: tree,
          reviewedDiffDigest: diff,
          verdict: "FAIL",
          findings: [{ id: "F1", severity: "HIGH", title: "Error" }],
          recordedAt: new Date().toISOString(),
          executionSnapshotVersion: undefined as any,
          executionSnapshotDigest: undefined as any,
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );

    await assertNoSideEffectsOrch(orchestrator, run.runId, reviewingRun, ArtifactKind.REVIEW_RESULT, 1, repoDir);
  } finally {
    await cleanup();
  }
});

test("R2F3-R2-R1 NB TEST 13: 完整正确: version + digest -> PASS", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-nb-13", taskId: "TASK-NB-01" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
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
    await cleanup();
  }
});

test("R2F3-R2-R1 NB TEST 14: 完整但 stale digest -> reject", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-nb-14", taskId: "TASK-NB-01" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);
    const tree = await orchestrator.computeCurrentTreeDigest();
    const testingRun = await orchestrator.getRun(run.runId);
    const staleDigest = "1".repeat(64);

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
    await assertNoSideEffectsOrch(orchestrator, run.runId, testingRun, ArtifactKind.TEST_RESULT, 1, repoDir);

    await assert.rejects(
      async () => {
        await orchestrator.recordDiffManifest(run.runId, {
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: staleDigest,
        });
      },
      (err: unknown) => err instanceof ArtifactDigestMismatchError
    );
    await assertNoSideEffectsOrch(orchestrator, run.runId, testingRun, ArtifactKind.DIFF_MANIFEST, 1, repoDir);
  } finally {
    await cleanup();
  }
});

test("R2F3-R2-R1 NB TEST 15: unknown version -> reject", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-nb-15", taskId: "TASK-NB-01" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);
    const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
    const tree = await orchestrator.computeCurrentTreeDigest();
    const testingRun = await orchestrator.getRun(run.runId);
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
    await assertNoSideEffectsOrch(orchestrator, run.runId, testingRun, ArtifactKind.TEST_RESULT, 1, repoDir);

    await assert.rejects(
      async () => {
        await orchestrator.recordDiffManifest(run.runId, {
          executionSnapshotVersion: unknownVersion as any,
          executionSnapshotDigest: snap.digest,
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
    await assertNoSideEffectsOrch(orchestrator, run.runId, testingRun, ArtifactKind.DIFF_MANIFEST, 1, repoDir);
  } finally {
    await cleanup();
  }
});

test("R2F3-R2-R1 NB TEST 16: malformed digest -> reject", async () => {
  const { repoDir, cleanup } = await createTempRepo();
  try {
    const orchestrator = new CindyOrchestrator({ repoDir });
    const run = await orchestrator.initRun({ runId: "run-nb-16", taskId: "TASK-NB-01" });
    await orchestrator.markReadyForBuilder(run.runId);
    await orchestrator.startBuilding(run.runId);
    await orchestrator.completeBuilding(run.runId);
    await orchestrator.startTesting(run.runId);
    const tree = await orchestrator.computeCurrentTreeDigest();
    const testingRun = await orchestrator.getRun(run.runId);
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
    await assertNoSideEffectsOrch(orchestrator, run.runId, testingRun, ArtifactKind.TEST_RESULT, 1, repoDir);

    await assert.rejects(
      async () => {
        await orchestrator.recordDiffManifest(run.runId, {
          executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
          executionSnapshotDigest: malformedDigest,
        });
      },
      (err: unknown) => err instanceof ArtifactValidationError
    );
    await assertNoSideEffectsOrch(orchestrator, run.runId, testingRun, ArtifactKind.DIFF_MANIFEST, 1, repoDir);
  } finally {
    await cleanup();
  }
});
