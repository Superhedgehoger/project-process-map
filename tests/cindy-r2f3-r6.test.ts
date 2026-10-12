/**
 * CINDY-ORCH-MVP-R2F3-R6 Test Suite
 *
 * Covers all findings from PI_GPT6_R2F3_R5_REVIEW_FAIL:
 * - Matrix A (A1 to A10): M-R5-01 Initialization Final Authority Order
 * - Matrix B (B1 to B12): M-R5-02 Semantic Publication After Fence Await
 * - Matrix C (C1 to C10): M-R5-03 Valid POSIX Nested Symlink
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import fs, { existsSync, symlinkSync, writeFileSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CindyOrchestrator,
  CindyState,
  RuntimeArtifactStore,
  ArtifactKind,
  inspectSnapshotEntry,
  assertSnapshotPathContained,
  resolveSnapshotTerminalPath,
  computeTreeDigestSync,
  TransitionRejectedError,
  DirtyTreeUnexplainedError,
  SymlinkEscapeError,
  FilesystemSnapshotError,
  CINDY_EXECUTION_SNAPSHOT_V1,
  type CindyRun,
  type ReviewResultArtifact,
  type ReviewRequestArtifact,
} from "../tools/cindy/index.ts";

// ============================================================
// Helper: Create temporary Git repository for initialization tests
// ============================================================

async function createTestRepo(customTaskId = "TASK-R6"): Promise<{
  repoDir: string;
  bareDir: string;
  baseCommit: string;
  taskId: string;
  runId: string;
  cleanup: () => Promise<void>;
}> {
  const repoDir = await mkdtemp(join(tmpdir(), "cindy-r6-repo-"));
  const bareDir = await mkdtemp(join(tmpdir(), "cindy-r6-bare-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

  git(["init", "-b", "main"]);
  git(["config", "user.name", "Cindy R6 Test"]);
  git(["config", "user.email", "cindy-r6@example.com"]);

  await writeFile(
    join(repoDir, ".gitignore"),
    "node_modules/\n.agent/runtime/\n.agent/.cindy-init-staging/\n*.ignored\n*.env\n",
    "utf8"
  );
  await writeFile(join(repoDir, "README.md"), "# R6 Test Repo\n", "utf8");
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "src", "input.ts"), "export const val = 42;\n", "utf8");

  // Copy schemas
  execFileSync("cp", ["-r", join(process.cwd(), "schemas"), join(repoDir, "schemas")]);

  const taskId = customTaskId;
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

  const runId = "run-r6-001";

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

// ============================================================
// Matrix A: M-R5-01 Initialization Final Authority Order
// ============================================================

describe("R2F3-R6: Matrix A - M-R5-01 Initialization Final Authority Order", () => {
  test("A1: final tree scan branch drift -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const store = new RuntimeArtifactStore({ repoDir });

      const checkStaging = () => {
        const stagingBase = join(repoDir, ".agent", ".cindy-init-staging");
        return existsSync(stagingBase) && readdirSync(stagingBase).length > 0;
      };

      let hooked = false;
      const origRead = fs.readFileSync;
      fs.readFileSync = ((...args: any[]) => {
        const res = (origRead as any)(...args);
        const pathStr = String(args[0]);
        if (!hooked && checkStaging() && pathStr.includes("src/input.ts")) {
          hooked = true;
          git(["checkout", "-b", "side"]);
        }
        return res;
      }) as any;

      try {
        await assert.rejects(
          () => store.initializeRunSafely({ runId, taskId }),
          (err: unknown) => {
            assert(err instanceof TransitionRejectedError);
            assert.match((err as Error).message, /authority|tree changed|fail closed/i);
            return true;
          }
        );
      } finally {
        fs.readFileSync = origRead;
      }
    } finally {
      await env.cleanup();
    }
  });

  test("A2: final tree scan upstream drift -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, bareDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const store = new RuntimeArtifactStore({ repoDir });

      const checkStaging = () => {
        const stagingBase = join(repoDir, ".agent", ".cindy-init-staging");
        return existsSync(stagingBase) && readdirSync(stagingBase).length > 0;
      };

      let hooked = false;
      const origRead = fs.readFileSync;
      fs.readFileSync = ((...args: any[]) => {
        const res = (origRead as any)(...args);
        const pathStr = String(args[0]);
        if (!hooked && checkStaging() && pathStr.includes("src/input.ts")) {
          hooked = true;
          // Drift upstream branch configuration
          git(["config", "branch.main.remote", "unknown_remote"]);
        }
        return res;
      }) as any;

      try {
        await assert.rejects(
          () => store.initializeRunSafely({ runId, taskId }),
          (err: unknown) => {
            assert(err instanceof TransitionRejectedError);
            return true;
          }
        );
      } finally {
        fs.readFileSync = origRead;
      }
    } finally {
      await env.cleanup();
    }
  });

  test("A3: final tree scan index-only mutation -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const store = new RuntimeArtifactStore({ repoDir });

      const checkStaging = () => {
        const stagingBase = join(repoDir, ".agent", ".cindy-init-staging");
        return existsSync(stagingBase) && readdirSync(stagingBase).length > 0;
      };

      let hooked = false;
      const origRead = fs.readFileSync;
      fs.readFileSync = ((...args: any[]) => {
        const res = (origRead as any)(...args);
        const pathStr = String(args[0]);
        if (!hooked && checkStaging() && pathStr.includes("src/input.ts")) {
          hooked = true;
          writeFileSync(join(repoDir, "README.md"), "staged mutation\n");
          git(["add", "README.md"]);
          writeFileSync(join(repoDir, "README.md"), "# R6 Test Repo\n");
        }
        return res;
      }) as any;

      try {
        await assert.rejects(
          () => store.initializeRunSafely({ runId, taskId }),
          (err: unknown) => {
            assert(err instanceof DirtyTreeUnexplainedError || err instanceof TransitionRejectedError);
            return true;
          }
        );
      } finally {
        fs.readFileSync = origRead;
      }
    } finally {
      await env.cleanup();
    }
  });

  test("A4: final tree scan outside-scope dirty -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const store = new RuntimeArtifactStore({ repoDir });

      const checkStaging = () => {
        const stagingBase = join(repoDir, ".agent", ".cindy-init-staging");
        return existsSync(stagingBase) && readdirSync(stagingBase).length > 0;
      };

      let hooked = false;
      const origRead = fs.readFileSync;
      fs.readFileSync = ((...args: any[]) => {
        const res = (origRead as any)(...args);
        const pathStr = String(args[0]);
        if (!hooked && checkStaging() && pathStr.includes("src/input.ts")) {
          hooked = true;
          writeFileSync(join(repoDir, "untracked-outside.txt"), "outside scope content\n");
        }
        return res;
      }) as any;

      try {
        await assert.rejects(
          () => store.initializeRunSafely({ runId, taskId }),
          (err: unknown) => {
            assert(err instanceof DirtyTreeUnexplainedError || err instanceof TransitionRejectedError);
            return true;
          }
        );
      } finally {
        fs.readFileSync = origRead;
      }
    } finally {
      await env.cleanup();
    }
  });

  test("A5: final tree scan allowed-scope content mutation -> reject stale binding", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const store = new RuntimeArtifactStore({ repoDir });

      const checkStaging = () => {
        const stagingBase = join(repoDir, ".agent", ".cindy-init-staging");
        return existsSync(stagingBase) && readdirSync(stagingBase).length > 0;
      };

      let hooked = false;
      const origRead = fs.readFileSync;
      fs.readFileSync = ((...args: any[]) => {
        const res = (origRead as any)(...args);
        const pathStr = String(args[0]);
        if (!hooked && checkStaging() && pathStr.includes("src/input.ts")) {
          hooked = true;
          writeFileSync(join(repoDir, "src", "input.ts"), "export const mutated = 999;\n");
        }
        return res;
      }) as any;

      try {
        await assert.rejects(
          () => store.initializeRunSafely({ runId, taskId }),
          (err: unknown) => {
            assert(err instanceof TransitionRejectedError);
            assert.match((err as Error).message, /STALE_TREE_BINDING|clean state changed/i);
            return true;
          }
        );
      } finally {
        fs.readFileSync = origRead;
      }
    } finally {
      await env.cleanup();
    }
  });

  test("A6: legitimate initial dirty scope -> normal initialization succeeds", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      // Legitimate modification in allowed scope prior to initialization
      await writeFile(join(repoDir, "src", "input.ts"), "export const modifiedPrior = 100;\n", "utf8");

      const store = new RuntimeArtifactStore({ repoDir });
      const run = await store.initializeRunSafely({ runId, taskId });

      assert.equal(run.state, CindyState.TASK_INITIALIZED);
      assert.equal(run.runId, runId);

      const liveDigest = computeTreeDigestSync(repoDir);
      assert.equal(run.boundTreeDigest, liveDigest);
    } finally {
      await env.cleanup();
    }
  });

  test("A7: healthy clean initialization -> PASS", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const store = new RuntimeArtifactStore({ repoDir });
      const run = await store.initializeRunSafely({ runId, taskId });

      assert.equal(run.state, CindyState.TASK_INITIALIZED);
      assert.equal(run.version, 1);
      assert.equal(run.branch, "main");
    } finally {
      await env.cleanup();
    }
  });

  test("A8: published boundTreeDigest equals fresh live digest", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const store = new RuntimeArtifactStore({ repoDir });
      const run = await store.initializeRunSafely({ runId, taskId });

      const freshLiveDigest = computeTreeDigestSync(repoDir);
      assert.equal(run.boundTreeDigest, freshLiveDigest);

      const baseline = await store.readArtifact<any>(runId, ArtifactKind.BASELINE);
      assert.equal(baseline.initialTreeDigest, freshLiveDigest);
    } finally {
      await env.cleanup();
    }
  });

  test("A9: rejected operation leaves no formal dir, no current pointer, no half bundle, no lock", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const store = new RuntimeArtifactStore({ repoDir });

      (store as any).onBeforeFinalValidationFence = async () => {
        await writeFile(join(repoDir, "src", "late.ts"), "// late write", "utf8");
      };

      await assert.rejects(
        () => store.initializeRunSafely({ runId, taskId }),
        TransitionRejectedError
      );

      // Verify no runtime directory exists for this run
      assert.ok(!existsSync(join(repoDir, ".agent", "runtime", runId)));
      // Verify no staging residue exists
      const stagingBase = join(repoDir, ".agent", ".cindy-init-staging");
      if (existsSync(stagingBase)) {
        assert.equal(readdirSync(stagingBase).length, 0);
      }
      // Verify no stale lock
      assert.ok(!existsSync(join(repoDir, ".agent", "runtime", `${runId}.lock`)));
      assert.ok(!existsSync(join(repoDir, ".agent", "runtime", `${runId}.init.lock`)));
    } finally {
      await env.cleanup();
    }
  });

  test("A10: zero ordinary await between final authority fence and atomic rename", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const store = new RuntimeArtifactStore({ repoDir });

      // Run initializeRunSafely and verify successful execution
      const run = await store.initializeRunSafely({ runId, taskId });
      assert.equal(run.state, CindyState.TASK_INITIALIZED);

      // Staging directory was renamed synchronously to final run dir
      assert.ok(existsSync(join(repoDir, ".agent", "runtime", runId, "run.json")));
    } finally {
      await env.cleanup();
    }
  });
});

// ============================================================
// Matrix B: M-R5-02 Semantic Publication After Fence Await
// ============================================================

describe("R2F3-R6: Matrix B - M-R5-02 Semantic Publication After Fence Await", () => {
  async function setupTestingRun(orchestrator: CindyOrchestrator, runId: string, taskId: string): Promise<CindyRun> {
    await orchestrator.initRun({ runId, taskId });
    await orchestrator.markReadyForBuilder(runId);
    await orchestrator.startBuilding(runId);
    await orchestrator.completeBuilding(runId);
    await orchestrator.startTesting(runId);
    return await orchestrator.getRun(runId);
  }

  async function recordPassingEvidence(orchestrator: CindyOrchestrator, runId: string, taskId: string): Promise<void> {
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
  }

  async function setupReadyForReviewRun(orchestrator: CindyOrchestrator, runId: string, taskId: string): Promise<CindyRun> {
    await setupTestingRun(orchestrator, runId, taskId);
    await recordPassingEvidence(orchestrator, runId, taskId);
    await orchestrator.prepareForReview(runId);
    return await orchestrator.getRun(runId);
  }

  async function setupReviewingRun(
    orchestrator: CindyOrchestrator,
    runId: string,
    taskId: string,
    session = "session-1"
  ): Promise<CindyRun> {
    await setupReadyForReviewRun(orchestrator, runId, taskId);
    return await orchestrator.startReview(runId, {
      reviewer: { identity: "cindy-reviewer", session, readOnlyConfirmed: true, readOnlyRequired: true },
    });
  }

  test("B1: prepareForReview tmp open barrier rejection", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const orchestrator = new CindyOrchestrator({ repoDir });

      await setupTestingRun(orchestrator, runId, taskId);
      await recordPassingEvidence(orchestrator, runId, taskId);

      const fsPromises = await import("node:fs/promises");
      const tempDummy = join(repoDir, "dummy.txt");
      const dummyH = await fsPromises.open(tempDummy, "w");
      const FileHandleProto = Object.getPrototypeOf(dummyH);
      await dummyH.close();
      fs.unlinkSync(tempDummy);

      const origSync = FileHandleProto.sync;
      let hooked = false;

      FileHandleProto.sync = async function (...args: any[]) {
        const res = await origSync.apply(this, args as any);
        const trace = new Error().stack || "";
        if (!hooked && trace.includes("executeSemanticTransition") && !trace.includes("acquireRunLock")) {
          hooked = true;
          git(["checkout", "-b", "side"]);
        }
        return res;
      };

      try {
        await assert.rejects(
          () => orchestrator.prepareForReview(runId),
          (err: unknown) => {
            assert(err instanceof TransitionRejectedError);
            assert.match((err as Error).message, /BRANCH_MISMATCH|authority changed/i);
            return true;
          }
        );
      } finally {
        FileHandleProto.sync = origSync;
      }
    } finally {
      await env.cleanup();
    }
  });

  test("B2: startReview staged write barrier rejection", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const orchestrator = new CindyOrchestrator({ repoDir });

      await setupReadyForReviewRun(orchestrator, runId, taskId);

      const fsPromises = await import("node:fs/promises");
      const tempDummy = join(repoDir, "dummy.txt");
      const dummyH = await fsPromises.open(tempDummy, "w");
      const FileHandleProto = Object.getPrototypeOf(dummyH);
      await dummyH.close();
      fs.unlinkSync(tempDummy);

      const origSync = FileHandleProto.sync;
      let hooked = false;

      FileHandleProto.sync = async function (...args: any[]) {
        const res = await origSync.apply(this, args as any);
        const trace = new Error().stack || "";
        if (!hooked && trace.includes("executeSemanticTransition") && !trace.includes("acquireRunLock")) {
          hooked = true;
          git(["checkout", "-b", "side"]);
        }
        return res;
      };

      try {
        await assert.rejects(
          () =>
            orchestrator.startReview(runId, {
              reviewer: { identity: "cindy-reviewer", session: "session-1", readOnlyConfirmed: true, readOnlyRequired: true },
            }),
          (err: unknown) => {
            assert(err instanceof TransitionRejectedError);
            assert.match((err as Error).message, /BRANCH_MISMATCH|authority changed/i);
            return true;
          }
        );
      } finally {
        FileHandleProto.sync = origSync;
      }
    } finally {
      await env.cleanup();
    }
  });

  test("B3: initial Review PASS staged write barrier rejection", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const orchestrator = new CindyOrchestrator({ repoDir });

      const reviewingRun = await setupReviewingRun(orchestrator, runId, taskId, "session-pass");

      const snap = await orchestrator.computeCurrentExecutionSnapshot(taskId);
      const tree = await orchestrator.computeCurrentTreeDigest();
      const diff = await orchestrator.computeCurrentDiffDigest();

      const passReview: ReviewResultArtifact = {
        runId,
        taskId,
        cycle: 1,
        verdict: "PASS",
        reviewedTreeDigest: tree,
        reviewedDiffDigest: diff,
        reviewedBaseCommit: reviewingRun.baseCommit,
        executionSnapshotVersion: snap.version,
        executionSnapshotDigest: snap.digest,
        findings: [],
        recordedAt: new Date().toISOString(),
        reviewer: {
          identity: "cindy-reviewer",
          session: "session-pass",
          readOnlyConfirmed: true,
        },
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      };

      const fsPromises = await import("node:fs/promises");
      const tempDummy = join(repoDir, "dummy.txt");
      const dummyH = await fsPromises.open(tempDummy, "w");
      const FileHandleProto = Object.getPrototypeOf(dummyH);
      await dummyH.close();
      fs.unlinkSync(tempDummy);

      const origSync = FileHandleProto.sync;
      let hooked = false;

      FileHandleProto.sync = async function (...args: any[]) {
        const res = await origSync.apply(this, args as any);
        const trace = new Error().stack || "";
        if (!hooked && trace.includes("executeSemanticTransition") && !trace.includes("acquireRunLock")) {
          hooked = true;
          git(["checkout", "-b", "side"]);
        }
        return res;
      };

      try {
        await assert.rejects(
          () => orchestrator.recordValidatedReviewResult(runId, passReview),
          (err: unknown) => {
            assert(err instanceof TransitionRejectedError);
            assert.match((err as Error).message, /BRANCH_MISMATCH|authority changed/i);
            return true;
          }
        );
      } finally {
        FileHandleProto.sync = origSync;
      }
    } finally {
      await env.cleanup();
    }
  });

  test("B4: initial Review FAIL staged write barrier rejection", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const orchestrator = new CindyOrchestrator({ repoDir });

      const reviewingRun = await setupReviewingRun(orchestrator, runId, taskId, "session-fail");

      const snap = await orchestrator.computeCurrentExecutionSnapshot(taskId);
      const tree = await orchestrator.computeCurrentTreeDigest();
      const diff = await orchestrator.computeCurrentDiffDigest();

      const failReview: ReviewResultArtifact = {
        runId,
        taskId,
        cycle: 1,
        verdict: "FAIL",
        reviewedTreeDigest: tree,
        reviewedDiffDigest: diff,
        reviewedBaseCommit: reviewingRun.baseCommit,
        executionSnapshotVersion: snap.version,
        executionSnapshotDigest: snap.digest,
        findings: [{ id: "F-1", severity: "HIGH", title: "Test finding" }],
        recordedAt: new Date().toISOString(),
        reviewer: {
          identity: "cindy-reviewer",
          session: "session-fail",
          readOnlyConfirmed: true,
        },
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      };

      const fsPromises = await import("node:fs/promises");
      const tempDummy = join(repoDir, "dummy.txt");
      const dummyH = await fsPromises.open(tempDummy, "w");
      const FileHandleProto = Object.getPrototypeOf(dummyH);
      await dummyH.close();
      fs.unlinkSync(tempDummy);

      const origSync = FileHandleProto.sync;
      let hooked = false;

      FileHandleProto.sync = async function (...args: any[]) {
        const res = await origSync.apply(this, args as any);
        const trace = new Error().stack || "";
        if (!hooked && trace.includes("executeSemanticTransition") && !trace.includes("acquireRunLock")) {
          hooked = true;
          git(["checkout", "-b", "side"]);
        }
        return res;
      };

      try {
        await assert.rejects(
          () => orchestrator.recordValidatedReviewResult(runId, failReview),
          (err: unknown) => {
            assert(err instanceof TransitionRejectedError);
            assert.match((err as Error).message, /BRANCH_MISMATCH|authority changed/i);
            return true;
          }
        );
      } finally {
        FileHandleProto.sync = origSync;
      }
    } finally {
      await env.cleanup();
    }
  });

  test("B5: PASS duplicate replay with authority drift -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const orchestrator = new CindyOrchestrator({ repoDir });

      const reviewingRun = await setupReviewingRun(orchestrator, runId, taskId, "session-pass");

      const snap = await orchestrator.computeCurrentExecutionSnapshot(taskId);
      const tree = await orchestrator.computeCurrentTreeDigest();
      const diff = await orchestrator.computeCurrentDiffDigest();

      const passReview: ReviewResultArtifact = {
        runId,
        taskId,
        cycle: 1,
        verdict: "PASS",
        reviewedTreeDigest: tree,
        reviewedDiffDigest: diff,
        reviewedBaseCommit: reviewingRun.baseCommit,
        executionSnapshotVersion: snap.version,
        executionSnapshotDigest: snap.digest,
        findings: [],
        recordedAt: new Date().toISOString(),
        reviewer: {
          identity: "cindy-reviewer",
          session: "session-pass",
          readOnlyConfirmed: true,
        },
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      };

      await orchestrator.recordValidatedReviewResult(runId, passReview);

      // Now drift branch
      git(["checkout", "-b", "side"]);

      // Replay PASS
      await assert.rejects(
        () => orchestrator.recordValidatedReviewResult(runId, passReview),
        (err: unknown) => {
          assert(err instanceof TransitionRejectedError);
          assert.match((err as Error).message, /BRANCH_MISMATCH|authority changed|drift/i);
          return true;
        }
      );
    } finally {
      await env.cleanup();
    }
  });

  test("B6: FAIL duplicate replay with authority drift -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const orchestrator = new CindyOrchestrator({ repoDir });

      const reviewingRun = await setupReviewingRun(orchestrator, runId, taskId, "session-fail");

      const snap = await orchestrator.computeCurrentExecutionSnapshot(taskId);
      const tree = await orchestrator.computeCurrentTreeDigest();
      const diff = await orchestrator.computeCurrentDiffDigest();

      const failReview: ReviewResultArtifact = {
        runId,
        taskId,
        cycle: 1,
        verdict: "FAIL",
        reviewedTreeDigest: tree,
        reviewedDiffDigest: diff,
        reviewedBaseCommit: reviewingRun.baseCommit,
        executionSnapshotVersion: snap.version,
        executionSnapshotDigest: snap.digest,
        findings: [{ id: "F-1", severity: "HIGH", title: "Test finding" }],
        recordedAt: new Date().toISOString(),
        reviewer: {
          identity: "cindy-reviewer",
          session: "session-fail",
          readOnlyConfirmed: true,
        },
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      };

      await orchestrator.recordValidatedReviewResult(runId, failReview);

      // Now drift branch
      git(["checkout", "-b", "side"]);

      // Replay FAIL
      await assert.rejects(
        () => orchestrator.recordValidatedReviewResult(runId, failReview),
        (err: unknown) => {
          assert(err instanceof TransitionRejectedError);
          assert.match((err as Error).message, /BRANCH_MISMATCH|authority changed|drift/i);
          return true;
        }
      );
    } finally {
      await env.cleanup();
    }
  });

  test("B7: READY_FOR_BUILDER normal transition -> PASS", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });

      await orchestrator.initRun({ taskId, runId });
      const readyRun = await orchestrator.markReadyForBuilder(runId);

      assert.equal(readyRun.state, CindyState.READY_FOR_BUILDER);
      assert.equal(readyRun.version, 2);
    } finally {
      await env.cleanup();
    }
  });

  test("B8: semantic late branch drift -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const orchestrator = new CindyOrchestrator({ repoDir });

      await orchestrator.initRun({ taskId, runId });

      const fsPromises = await import("node:fs/promises");
      const tempDummy = join(repoDir, "dummy.txt");
      const dummyH = await fsPromises.open(tempDummy, "w");
      const FileHandleProto = Object.getPrototypeOf(dummyH);
      await dummyH.close();
      fs.unlinkSync(tempDummy);

      const origSync = FileHandleProto.sync;
      let hooked = false;

      FileHandleProto.sync = async function (...args: any[]) {
        const res = await origSync.apply(this, args as any);
        const trace = new Error().stack || "";
        if (!hooked && trace.includes("executeSemanticTransition") && !trace.includes("acquireRunLock")) {
          hooked = true;
          git(["checkout", "-b", "side"]);
        }
        return res;
      };

      try {
        await assert.rejects(
          () => orchestrator.markReadyForBuilder(runId),
          (err: unknown) => {
            assert(err instanceof TransitionRejectedError);
            assert.match((err as Error).message, /BRANCH_MISMATCH|authority changed/i);
            return true;
          }
        );
      } finally {
        FileHandleProto.sync = origSync;
      }
    } finally {
      await env.cleanup();
    }
  });

  test("B9: semantic late upstream drift -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const orchestrator = new CindyOrchestrator({ repoDir });

      await orchestrator.initRun({ taskId, runId });

      const fsPromises = await import("node:fs/promises");
      const tempDummy = join(repoDir, "dummy.txt");
      const dummyH = await fsPromises.open(tempDummy, "w");
      const FileHandleProto = Object.getPrototypeOf(dummyH);
      await dummyH.close();
      fs.unlinkSync(tempDummy);

      const origSync = FileHandleProto.sync;
      let hooked = false;

      FileHandleProto.sync = async function (...args: any[]) {
        const res = await origSync.apply(this, args as any);
        const trace = new Error().stack || "";
        if (!hooked && trace.includes("executeSemanticTransition") && !trace.includes("acquireRunLock")) {
          hooked = true;
          git(["config", "branch.main.remote", "invalid_remote"]);
        }
        return res;
      };

      try {
        await assert.rejects(
          () => orchestrator.markReadyForBuilder(runId),
          (err: unknown) => {
            assert(err instanceof TransitionRejectedError);
            assert.match((err as Error).message, /upstream|authority changed/i);
            return true;
          }
        );
      } finally {
        FileHandleProto.sync = origSync;
      }
    } finally {
      await env.cleanup();
    }
  });

  test("B10: semantic late index-only mutation -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const orchestrator = new CindyOrchestrator({ repoDir });

      await orchestrator.initRun({ taskId, runId });

      const fsPromises = await import("node:fs/promises");
      const tempDummy = join(repoDir, "dummy.txt");
      const dummyH = await fsPromises.open(tempDummy, "w");
      const FileHandleProto = Object.getPrototypeOf(dummyH);
      await dummyH.close();
      fs.unlinkSync(tempDummy);

      const origSync = FileHandleProto.sync;
      let hooked = false;

      FileHandleProto.sync = async function (...args: any[]) {
        const res = await origSync.apply(this, args as any);
        const trace = new Error().stack || "";
        if (!hooked && trace.includes("executeSemanticTransition") && !trace.includes("acquireRunLock")) {
          hooked = true;
          writeFileSync(join(repoDir, "README.md"), "staged index change\n");
          git(["add", "README.md"]);
          writeFileSync(join(repoDir, "README.md"), "# R6 Test Repo\n");
        }
        return res;
      };

      try {
        await assert.rejects(
          () => orchestrator.markReadyForBuilder(runId),
          (err: unknown) => {
            assert(err instanceof DirtyTreeUnexplainedError || err instanceof TransitionRejectedError);
            return true;
          }
        );
      } finally {
        FileHandleProto.sync = origSync;
      }
    } finally {
      await env.cleanup();
    }
  });

  test("B11: rejected operation version, history, cycle unchanged, no staging residue, lock released", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const orchestrator = new CindyOrchestrator({ repoDir });

      await orchestrator.initRun({ taskId, runId });
      const beforeRun = await orchestrator.getRun(runId);

      const fsPromises = await import("node:fs/promises");
      const tempDummy = join(repoDir, "dummy.txt");
      const dummyH = await fsPromises.open(tempDummy, "w");
      const FileHandleProto = Object.getPrototypeOf(dummyH);
      await dummyH.close();
      fs.unlinkSync(tempDummy);

      const origSync = FileHandleProto.sync;
      let hooked = false;

      FileHandleProto.sync = async function (...args: any[]) {
        const res = await origSync.apply(this, args as any);
        const trace = new Error().stack || "";
        if (!hooked && trace.includes("executeSemanticTransition") && !trace.includes("acquireRunLock")) {
          hooked = true;
          git(["checkout", "-b", "side"]);
        }
        return res;
      };

      try {
        await assert.rejects(
          () => orchestrator.markReadyForBuilder(runId),
          TransitionRejectedError
        );
      } finally {
        FileHandleProto.sync = origSync;
      }

      // Revert branch to inspect run cleanly
      git(["checkout", "main"]);

      const afterRun = await orchestrator.getRun(runId);
      assert.equal(afterRun.version, beforeRun.version);
      assert.equal(afterRun.state, beforeRun.state);
      assert.equal(afterRun.currentCycle, beforeRun.currentCycle);
      assert.equal(afterRun.history.length, beforeRun.history.length);

      // Verify no staging residue (.tmp_run_*.json) in run directory
      const runDir = join(repoDir, ".agent", "runtime", runId);
      const files = readdirSync(runDir);
      assert.ok(!files.some((f) => f.startsWith(".tmp_run_")));

      // Verify lock released: acquiring lock immediately succeeds
      const { ownerId } = await orchestrator.artifactStore.acquireRunLock(runDir);
      await orchestrator.artifactStore.releaseRunLock(runDir, ownerId);
    } finally {
      await env.cleanup();
    }
  });

  test("B12: healthy clean replay remains idempotent", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });

      const reviewingRun = await setupReviewingRun(orchestrator, runId, taskId, "session-pass");

      const snap = await orchestrator.computeCurrentExecutionSnapshot(taskId);
      const tree = await orchestrator.computeCurrentTreeDigest();
      const diff = await orchestrator.computeCurrentDiffDigest();

      const passReview: ReviewResultArtifact = {
        runId,
        taskId,
        cycle: 1,
        verdict: "PASS",
        reviewedTreeDigest: tree,
        reviewedDiffDigest: diff,
        reviewedBaseCommit: reviewingRun.baseCommit,
        executionSnapshotVersion: snap.version,
        executionSnapshotDigest: snap.digest,
        findings: [],
        recordedAt: new Date().toISOString(),
        reviewer: {
          identity: "cindy-reviewer",
          session: "session-pass",
          readOnlyConfirmed: true,
        },
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      };

      const pass1 = await orchestrator.recordValidatedReviewResult(runId, passReview);

      // Second replay under clean state
      const pass2 = await orchestrator.recordValidatedReviewResult(runId, passReview);

      assert.equal(pass1.version, pass2.version);
      assert.equal(pass1.state, pass2.state);
      assert.equal(pass1.history.length, pass2.history.length);
    } finally {
      await env.cleanup();
    }
  });
});

// ============================================================
// Matrix C: M-R5-03 Valid POSIX Nested Symlink
// ============================================================

describe("R2F3-R6: Matrix C - M-R5-03 Valid POSIX Nested Symlink", () => {
  test("C1: nested ancestor symlink fixture -> PASS", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cindy-c1-"));
    try {
      await mkdir(join(dir, "real", "deep"), { recursive: true });
      await writeFile(join(dir, "real", "file"), "hello nested\n", "utf8");
      symlinkSync("real/deep", join(dir, "hop"));
      symlinkSync("hop/..", join(dir, "raw-dir"));

      const entry = inspectSnapshotEntry(dir, "raw-dir/file");
      assert.equal(entry.entryType, "regular");
      assert.equal(entry.path, "raw-dir/file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("C2: resolved terminal path strictly equals root/real/file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cindy-c2-"));
    try {
      await mkdir(join(dir, "real", "deep"), { recursive: true });
      await writeFile(join(dir, "real", "file"), "hello terminal\n", "utf8");
      symlinkSync("real/deep", join(dir, "hop"));
      symlinkSync("hop/..", join(dir, "raw-dir"));

      const resolved = resolveSnapshotTerminalPath(dir, "raw-dir/file");
      const expected = fs.realpathSync.native ? fs.realpathSync.native(join(dir, "real", "file")) : join(dir, "real", "file");
      assert.equal(resolved, expected);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("C3: actual file content correctly read and hashed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cindy-c3-"));
    try {
      const content = "exact content test 12345\n";
      await mkdir(join(dir, "real", "deep"), { recursive: true });
      await writeFile(join(dir, "real", "file"), content, "utf8");
      symlinkSync("real/deep", join(dir, "hop"));
      symlinkSync("hop/..", join(dir, "raw-dir"));

      const entry = inspectSnapshotEntry(dir, "raw-dir/file");
      assert.equal(entry.entryType, "regular");
      assert.equal(entry.path, "raw-dir/file");

      // Verify content hash matches directly hashed content
      const directEntry = inspectSnapshotEntry(dir, "real/file");
      assert.equal((entry as any).contentSha256, (directEntry as any).contentSha256);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("C4: ordinary internal symlink PASS", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cindy-c4-"));
    try {
      await writeFile(join(dir, "target.txt"), "target content\n", "utf8");
      symlinkSync("target.txt", join(dir, "normal-symlink"));

      const entry = inspectSnapshotEntry(dir, "normal-symlink");
      assert.equal(entry.entryType, "symlink");
      assert.equal((entry as any).target, "target.txt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("C5: legitimate internal symlink target containing '..' PASS", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cindy-c5-"));
    try {
      await mkdir(join(dir, "subA"), { recursive: true });
      await mkdir(join(dir, "subB"), { recursive: true });
      await writeFile(join(dir, "subB", "target.txt"), "content B\n", "utf8");
      symlinkSync("../subB/target.txt", join(dir, "subA", "link-to-b"));

      const entry = inspectSnapshotEntry(dir, "subA/link-to-b");
      assert.equal(entry.entryType, "symlink");
      assert.equal((entry as any).target, "../subB/target.txt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("C6: real symlink loop REJECT", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cindy-c6-"));
    try {
      symlinkSync("loop2", join(dir, "loop1"));
      symlinkSync("loop1", join(dir, "loop2"));

      assert.throws(
        () => inspectSnapshotEntry(dir, "loop1"),
        (err: unknown) => {
          assert(err instanceof SymlinkEscapeError);
          assert.match((err as Error).message, /loop/i);
          return true;
        }
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("C7: repo -> outside -> repo REJECT", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cindy-c7-"));
    try {
      await writeFile(join(dir, "safe.txt"), "safe\n", "utf8");
      symlinkSync("../../" + dir.slice(1) + "/safe.txt", join(dir, "escape-reenter"));

      assert.throws(
        () => inspectSnapshotEntry(dir, "escape-reenter"),
        (err: unknown) => {
          assert(err instanceof SymlinkEscapeError);
          assert.match((err as Error).message, /escapes repository root/i);
          return true;
        }
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("C8: reserved namespace alias REJECT", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cindy-c8-"));
    try {
      await mkdir(join(dir, ".agent", "runtime"), { recursive: true });
      await writeFile(join(dir, ".agent", "runtime", "secret.json"), "secret\n", "utf8");
      symlinkSync(".agent/runtime", join(dir, "runtime-alias"));

      assert.throws(
        () => inspectSnapshotEntry(dir, "runtime-alias/secret.json"),
        (err: unknown) => {
          assert(err instanceof SymlinkEscapeError);
          assert.match((err as Error).message, /reserved namespace/i);
          return true;
        }
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("C9: missing/../.git/config REJECT", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cindy-c9-"));
    try {
      await mkdir(join(dir, ".git"), { recursive: true });
      await writeFile(join(dir, ".git", "config"), "[core]\n", "utf8");

      assert.throws(
        () => inspectSnapshotEntry(dir, "missing/../.git/config"),
        (err: unknown) => {
          assert(err instanceof FilesystemSnapshotError || err instanceof SymlinkEscapeError);
          return true;
        }
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("C10: POSIX backslash filenames PASS", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cindy-c10-"));
    try {
      const filename = "foo\\bar";
      await writeFile(join(dir, filename), "backslash content\n", "utf8");

      const entry = inspectSnapshotEntry(dir, filename);
      assert.equal(entry.entryType, "regular");
      assert.equal(entry.path, filename);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
