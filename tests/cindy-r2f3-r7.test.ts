/**
 * CINDY-ORCH-MVP-R2F3-R7 Test Suite
 *
 * Dedicated verification suite for:
 * - Matrix A (A1 to A13): M-R6-01 Initialization Tree Freshness & Metadata Seal
 * - Matrix B (B1 to B14): M-R6-02 Semantic Tree Freshness & Staged Writer Race
 * - Matrix C (C1 to C11): M-R6-03 FAIL Replay Stored Evidence Validation
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import fs, {
  existsSync,
  symlinkSync,
  writeFileSync,
  lstatSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CindyOrchestrator,
  CindyState,
  RuntimeArtifactStore,
  ArtifactKind,
  TransitionRejectedError,
  DirtyTreeUnexplainedError,
  ConflictingArtifactError,
  ArtifactValidationError,
  ArtifactDigestMismatchError,
  computeTreeDigestSync,
  computeTreeSnapshotSync,
  executeSemanticTransition,
  CINDY_EXECUTION_SNAPSHOT_V1,
  type CindyRun,
  type ReviewResultArtifact,
  type ReviewRequestArtifact,
} from "../tools/cindy/index.ts";

// ============================================================
// Helper: Create temporary Git repository for initialization tests
// ============================================================

async function createTestRepo(customTaskId = "TASK-R7"): Promise<{
  repoDir: string;
  bareDir: string;
  baseCommit: string;
  taskId: string;
  runId: string;
  cleanup: () => Promise<void>;
}> {
  const repoDir = await mkdtemp(join(tmpdir(), "cindy-r7-repo-"));
  const bareDir = await mkdtemp(join(tmpdir(), "cindy-r7-bare-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

  git(["init", "-b", "main"]);
  git(["config", "user.name", "Cindy R7 Test"]);
  git(["config", "user.email", "cindy-r7@example.com"]);

  await writeFile(
    join(repoDir, ".gitignore"),
    "node_modules/\n.agent/runtime/\n.agent/.cindy-init-staging/\n*.ignored\n*.env\n",
    "utf8"
  );
  await writeFile(join(repoDir, "README.md"), "# R7 Test Repo\n", "utf8");
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

  const runId = "run-r7-001";

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
// Matrix A: M-R6-01 Initialization Tree Freshness (A1 to A13)
// ============================================================

describe("R2F3-R7: Matrix A - M-R6-01 Initialization Tree Freshness", () => {
  test("A1: second scan last read mutation -> REJECT stale binding", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const store = new RuntimeArtifactStore({ repoDir });

      const checkStaging = () => {
        const stagingBase = join(repoDir, ".agent", ".cindy-init-staging");
        return existsSync(stagingBase) && readdirSync(stagingBase).length > 0;
      };

      let scanReadCount = 0;
      const origRead = fs.readFileSync;
      fs.readFileSync = ((...args: any[]) => {
        const res = (origRead as any)(...args);
        const pathStr = String(args[0]);
        if (checkStaging() && pathStr.includes("src/input.ts")) {
          scanReadCount++;
          // Trigger on second scan's read of src/input.ts
          if (scanReadCount === 2) {
            writeFileSync(join(repoDir, "src", "input.ts"), "export const lateMutated = 999;\n");
          }
        }
        return res;
      }) as any;

      try {
        await assert.rejects(
          () => store.initializeRunSafely({ runId, taskId }),
          (err: unknown) => {
            assert(err instanceof TransitionRejectedError);
            assert.match((err as Error).message, /STALE_TREE_BINDING|tree changed|fail closed/i);
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

  test("A2: second scan complete / pre-Git authority mutation -> REJECT stale binding", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const store = new RuntimeArtifactStore({ repoDir });

      // Hook getGitHead during Step 2 (Git authority evaluation, after tree scans complete)
      const gitModule = await import("../tools/cindy/git.ts");
      const origGetGitHead = gitModule.getGitHead;
      let mutated = false;

      (store as any).onBeforeFinalValidationFence = async () => {
        // Still before fence, do nothing
      };

      // We hook fs.readFileSync when reading task.json in Step 2 of final Git validation
      const origRead = fs.readFileSync;
      fs.readFileSync = ((...args: any[]) => {
        const res = (origRead as any)(...args);
        const pathStr = String(args[0]);
        // When checking task.json in Git authority, mutate allowedScope file
        if (!mutated && pathStr.includes("task.json")) {
          const stagingBase = join(repoDir, ".agent", ".cindy-init-staging");
          if (existsSync(stagingBase) && readdirSync(stagingBase).length > 0) {
            mutated = true;
            writeFileSync(join(repoDir, "src", "input.ts"), "export const preGitMutated = 777;\n");
          }
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

  test("A3: branch drift -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const store = new RuntimeArtifactStore({ repoDir });

      (store as any).onBeforeFinalValidationFence = async () => {
        git(["checkout", "-b", "side"]);
      };

      await assert.rejects(
        () => store.initializeRunSafely({ runId, taskId }),
        (err: unknown) => {
          assert(err instanceof TransitionRejectedError);
          assert.match((err as Error).message, /authority|branch/i);
          return true;
        }
      );
    } finally {
      await env.cleanup();
    }
  });

  test("A4: upstream drift -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const store = new RuntimeArtifactStore({ repoDir });

      (store as any).onBeforeFinalValidationFence = async () => {
        git(["config", "branch.main.remote", "unknown_remote"]);
      };

      await assert.rejects(
        () => store.initializeRunSafely({ runId, taskId }),
        (err: unknown) => {
          assert(err instanceof TransitionRejectedError);
          assert.match((err as Error).message, /authority|upstream/i);
          return true;
        }
      );
    } finally {
      await env.cleanup();
    }
  });

  test("A5: README index-only mutation -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const store = new RuntimeArtifactStore({ repoDir });

      (store as any).onBeforeFinalValidationFence = async () => {
        // Stage modification to README (outside allowedScope) into index
        await writeFile(join(repoDir, "README.md"), "# Mutated README\n", "utf8");
        git(["add", "README.md"]);
      };

      await assert.rejects(
        () => store.initializeRunSafely({ runId, taskId }),
        (err: unknown) => {
          assert(err instanceof DirtyTreeUnexplainedError || err instanceof TransitionRejectedError);
          return true;
        }
      );
    } finally {
      await env.cleanup();
    }
  });

  test("A6: regular file same-size content mutation -> REJECT via metadata/version fence", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const store = new RuntimeArtifactStore({ repoDir });

      const checkStaging = () => {
        const stagingBase = join(repoDir, ".agent", ".cindy-init-staging");
        return existsSync(stagingBase) && readdirSync(stagingBase).length > 0;
      };

      let scanCount = 0;
      const origRead = fs.readFileSync;
      fs.readFileSync = ((...args: any[]) => {
        const res = (origRead as any)(...args);
        const pathStr = String(args[0]);
        if (checkStaging() && pathStr.includes("src/input.ts")) {
          scanCount++;
          // On second scan, mutate to exact same size: "export const val = 99;\n" (24 bytes)
          if (scanCount === 2) {
            writeFileSync(join(repoDir, "src", "input.ts"), "export const val = 99;\n");
          }
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

  test("A7: regular -> symlink mutation -> REJECT stale identity", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const store = new RuntimeArtifactStore({ repoDir });

      (store as any).onBeforeFinalValidationFence = async () => {
        // Replace regular file src/input.ts with symlink pointing to schemas/
        unlinkSync(join(repoDir, "src", "input.ts"));
        symlinkSync("../schemas", join(repoDir, "src", "input.ts"));
      };

      await assert.rejects(
        () => store.initializeRunSafely({ runId, taskId }),
        (err: unknown) => {
          assert(err instanceof TransitionRejectedError);
          return true;
        }
      );
    } finally {
      await env.cleanup();
    }
  });

  test("A8: symlink target retarget -> REJECT stale identity", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

      // Create target files and a symlink
      await writeFile(join(repoDir, "src", "t1.ts"), "export const t1 = 1;\n", "utf8");
      await writeFile(join(repoDir, "src", "t2.ts"), "export const t2 = 2;\n", "utf8");
      symlinkSync("t1.ts", join(repoDir, "src", "link.ts"));
      git(["add", "."]);
      git(["commit", "-m", "chore: add symlink"]);
      git(["push", "origin", "main"]);

      const store = new RuntimeArtifactStore({ repoDir });

      (store as any).onBeforeFinalValidationFence = async () => {
        // Retarget link.ts from t1.ts to t2.ts
        unlinkSync(join(repoDir, "src", "link.ts"));
        symlinkSync("t2.ts", join(repoDir, "src", "link.ts"));
      };

      await assert.rejects(
        () => store.initializeRunSafely({ runId, taskId }),
        (err: unknown) => {
          assert(err instanceof TransitionRejectedError);
          return true;
        }
      );
    } finally {
      await env.cleanup();
    }
  });

  test("A9: rename/replace file -> detects inode identity drift -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const store = new RuntimeArtifactStore({ repoDir });

      const checkStaging = () => {
        const stagingBase = join(repoDir, ".agent", ".cindy-init-staging");
        return existsSync(stagingBase) && readdirSync(stagingBase).length > 0;
      };

      let scanCount = 0;
      const origRead = fs.readFileSync;
      fs.readFileSync = ((...args: any[]) => {
        const res = (origRead as any)(...args);
        const pathStr = String(args[0]);
        if (checkStaging() && pathStr.includes("src/input.ts")) {
          scanCount++;
          // On second scan, replace file via atomic rename with identical content (new inode)
          if (scanCount === 2) {
            const tmpFile = join(repoDir, "temp-replace.ts");
            writeFileSync(tmpFile, "export const val = 42;\n");
            renameSync(tmpFile, join(repoDir, "src", "input.ts"));
          }
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

  test("A10: healthy clean initialization -> PASS", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const store = new RuntimeArtifactStore({ repoDir });

      const run = await store.initializeRunSafely({ runId, taskId });
      assert.equal(run.state, CindyState.TASK_INITIALIZED);
      assert.equal(run.runId, runId);
      assert.equal(run.version, 1);
      assert.equal(run.currentCycle, 1);
    } finally {
      await env.cleanup();
    }
  });

  test("A11: initially authorized dirty initialization -> PASS", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      // Dirty modification in allowed scope prior to init
      await writeFile(join(repoDir, "src", "input.ts"), "export const modifiedPrior = 99;\n", "utf8");

      const store = new RuntimeArtifactStore({ repoDir });
      const run = await store.initializeRunSafely({ runId, taskId });

      assert.equal(run.state, CindyState.TASK_INITIALIZED);
      const liveDigest = computeTreeDigestSync(repoDir);
      assert.equal(run.boundTreeDigest, liveDigest);
    } finally {
      await env.cleanup();
    }
  });

  test("A12: rejected operation leaves formal runtime ABSENT, current pointer untouched, lock released", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const store = new RuntimeArtifactStore({ repoDir });

      (store as any).onBeforeFinalValidationFence = async () => {
        git(["checkout", "-b", "side"]);
      };

      await assert.rejects(
        () => store.initializeRunSafely({ runId, taskId }),
        TransitionRejectedError
      );

      // Verify no runtime directory exists for this run
      assert.ok(!existsSync(join(repoDir, ".agent", "runtime", runId)));
      // Verify no current pointer exists
      assert.ok(!existsSync(join(repoDir, ".agent", "runtime", "current.json")));
      // Verify no staging residue exists
      const stagingBase = join(repoDir, ".agent", ".cindy-init-staging");
      if (existsSync(stagingBase)) {
        assert.equal(readdirSync(stagingBase).length, 0);
      }
      // Verify lock released: acquiring init lock succeeds immediately
      const initLock = await store.acquireInitLock();
      await store.releaseInitLock(initLock.ownerId);
    } finally {
      await env.cleanup();
    }
  });

  test("A13: published boundTreeDigest / identity independently verified consistent", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const store = new RuntimeArtifactStore({ repoDir });

      const run = await store.initializeRunSafely({ runId, taskId });
      const liveSnapshot = computeTreeSnapshotSync(repoDir);

      assert.equal(run.boundTreeDigest, liveSnapshot.digest);
      assert.ok(run.boundTreeDigest && run.boundTreeDigest.length === 64);
    } finally {
      await env.cleanup();
    }
  });
});

// ============================================================
// Matrix B: M-R6-02 Semantic Tree Freshness (B1 to B14)
// ============================================================

describe("R2F3-R7: Matrix B - M-R6-02 Semantic Tree Freshness", () => {
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

  test("B1: markReadyForBuilder second scan last read mutation -> REJECT stale state", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      await orchestrator.initRun({ runId, taskId });

      const fsPromises = await import("node:fs/promises");
      const tempDummy = join(repoDir, "dummy.txt");
      const dummyH = await fsPromises.open(tempDummy, "w");
      const FileHandleProto = Object.getPrototypeOf(dummyH);
      await dummyH.close();
      unlinkSync(tempDummy);

      const origSync = FileHandleProto.sync;
      let stageWriteSynced = false;

      FileHandleProto.sync = async function (...args: any[]) {
        const res = await origSync.apply(this, args as any);
        const trace = new Error().stack || "";
        if (trace.includes("executeSemanticTransition") && !trace.includes("acquireRunLock")) {
          stageWriteSynced = true;
        }
        return res;
      };

      let scanCountAfterSync = 0;
      const origRead = fs.readFileSync;
      fs.readFileSync = ((...args: any[]) => {
        const res = (origRead as any)(...args);
        const pathStr = String(args[0]);
        if (stageWriteSynced && pathStr.includes("src/input.ts")) {
          scanCountAfterSync++;
          if (scanCountAfterSync === 2) {
            writeFileSync(join(repoDir, "src", "input.ts"), "export const b1Mutated = 123;\n");
          }
        }
        return res;
      }) as any;

      try {
        await assert.rejects(
          () => orchestrator.markReadyForBuilder(runId),
          (err: unknown) => {
            assert(err instanceof TransitionRejectedError);
            return true;
          }
        );
      } finally {
        FileHandleProto.sync = origSync;
        fs.readFileSync = origRead;
      }
    } finally {
      await env.cleanup();
    }
  });

  test("B2: markReadyForBuilder final scan complete / pre-Git authority mutation -> REJECT stale state", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      await orchestrator.initRun({ runId, taskId });

      const fsPromises = await import("node:fs/promises");
      const tempDummy = join(repoDir, "dummy.txt");
      const dummyH = await fsPromises.open(tempDummy, "w");
      const FileHandleProto = Object.getPrototypeOf(dummyH);
      await dummyH.close();
      unlinkSync(tempDummy);

      const origSync = FileHandleProto.sync;
      let stageWriteSynced = false;

      FileHandleProto.sync = async function (...args: any[]) {
        const res = await origSync.apply(this, args as any);
        const trace = new Error().stack || "";
        if (trace.includes("executeSemanticTransition") && !trace.includes("acquireRunLock")) {
          stageWriteSynced = true;
        }
        return res;
      };

      let fenceCallCount = 0;
      const origLstat = fs.lstatSync;
      (fs as any).lstatSync = ((...args: any[]) => {
        const res = (origLstat as any)(...args);
        const pathStr = String(args[0]);
        const trace = new Error().stack || "";
        if (stageWriteSynced && pathStr.includes("src/input.ts") && trace.includes("verifyFileIdentityFence")) {
          fenceCallCount++;
          if (fenceCallCount === 1) {
            writeFileSync(join(repoDir, "src", "input.ts"), "export const b2Mutated = 456;\n");
          }
        }
        return res;
      }) as any;

      try {
        await assert.rejects(
          () => orchestrator.markReadyForBuilder(runId),
          (err: unknown) => {
            assert(err instanceof TransitionRejectedError);
            return true;
          }
        );
      } finally {
        FileHandleProto.sync = origSync;
        (fs as any).lstatSync = origLstat;
      }
    } finally {
      await env.cleanup();
    }
  });

  test("B3: prepareForReview late mutation -> REJECT stale state", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      await setupTestingRun(orchestrator, runId, taskId);
      await recordPassingEvidence(orchestrator, runId, taskId);

      const fsPromises = await import("node:fs/promises");
      const tempDummy = join(repoDir, "dummy.txt");
      const dummyH = await fsPromises.open(tempDummy, "w");
      const FileHandleProto = Object.getPrototypeOf(dummyH);
      await dummyH.close();
      unlinkSync(tempDummy);

      const origSync = FileHandleProto.sync;
      let stageWriteSynced = false;

      FileHandleProto.sync = async function (...args: any[]) {
        const res = await origSync.apply(this, args as any);
        const trace = new Error().stack || "";
        if (trace.includes("executeSemanticTransition") && !trace.includes("acquireRunLock")) {
          stageWriteSynced = true;
        }
        return res;
      };

      let fenceCallCount = 0;
      const origLstat = fs.lstatSync;
      (fs as any).lstatSync = ((...args: any[]) => {
        const res = (origLstat as any)(...args);
        const pathStr = String(args[0]);
        const trace = new Error().stack || "";
        if (stageWriteSynced && pathStr.includes("src/input.ts") && trace.includes("verifyFileIdentityFence")) {
          fenceCallCount++;
          if (fenceCallCount === 1) {
            writeFileSync(join(repoDir, "src", "input.ts"), "export const b3Mutated = 789;\n");
          }
        }
        return res;
      }) as any;

      try {
        await assert.rejects(
          () => orchestrator.prepareForReview(runId),
          (err: unknown) => {
            assert(err instanceof TransitionRejectedError || err instanceof ArtifactDigestMismatchError);
            return true;
          }
        );
      } finally {
        FileHandleProto.sync = origSync;
        (fs as any).lstatSync = origLstat;
      }
    } finally {
      await env.cleanup();
    }
  });

  test("B4: startReview late mutation -> REJECT stale state", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      await setupReadyForReviewRun(orchestrator, runId, taskId);

      const fsPromises = await import("node:fs/promises");
      const tempDummy = join(repoDir, "dummy.txt");
      const dummyH = await fsPromises.open(tempDummy, "w");
      const FileHandleProto = Object.getPrototypeOf(dummyH);
      await dummyH.close();
      unlinkSync(tempDummy);

      const origSync = FileHandleProto.sync;
      let stageWriteSynced = false;

      FileHandleProto.sync = async function (...args: any[]) {
        const res = await origSync.apply(this, args as any);
        const trace = new Error().stack || "";
        if (trace.includes("executeSemanticTransition") && !trace.includes("acquireRunLock")) {
          stageWriteSynced = true;
        }
        return res;
      };

      let fenceCallCount = 0;
      const origLstat = fs.lstatSync;
      (fs as any).lstatSync = ((...args: any[]) => {
        const res = (origLstat as any)(...args);
        const pathStr = String(args[0]);
        const trace = new Error().stack || "";
        if (stageWriteSynced && pathStr.includes("src/input.ts") && trace.includes("verifyFileIdentityFence")) {
          fenceCallCount++;
          if (fenceCallCount === 1) {
            writeFileSync(join(repoDir, "src", "input.ts"), "export const b4Mutated = 999;\n");
          }
        }
        return res;
      }) as any;

      try {
        await assert.rejects(
          () => orchestrator.startReview(runId, {
            reviewer: { identity: "cindy-reviewer", session: "s1", readOnlyConfirmed: true, readOnlyRequired: true },
          }),
          (err: unknown) => {
            assert(err instanceof TransitionRejectedError || err instanceof ArtifactDigestMismatchError);
            return true;
          }
        );
      } finally {
        FileHandleProto.sync = origSync;
        (fs as any).lstatSync = origLstat;
      }
    } finally {
      await env.cleanup();
    }
  });

  test("B5: initial PASS late mutation -> REJECT stale state", async () => {
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

      const fsPromises = await import("node:fs/promises");
      const tempDummy = join(repoDir, "dummy.txt");
      const dummyH = await fsPromises.open(tempDummy, "w");
      const FileHandleProto = Object.getPrototypeOf(dummyH);
      await dummyH.close();
      unlinkSync(tempDummy);

      const origSync = FileHandleProto.sync;
      let stageWriteSynced = false;

      FileHandleProto.sync = async function (...args: any[]) {
        const res = await origSync.apply(this, args as any);
        const trace = new Error().stack || "";
        if (trace.includes("executeSemanticTransition") && !trace.includes("acquireRunLock")) {
          stageWriteSynced = true;
        }
        return res;
      };

      let fenceCallCount = 0;
      const origLstat = fs.lstatSync;
      (fs as any).lstatSync = ((...args: any[]) => {
        const res = (origLstat as any)(...args);
        const pathStr = String(args[0]);
        const trace = new Error().stack || "";
        if (stageWriteSynced && pathStr.includes("src/input.ts") && trace.includes("verifyFileIdentityFence")) {
          fenceCallCount++;
          if (fenceCallCount === 1) {
            writeFileSync(join(repoDir, "src", "input.ts"), "export const b5Mutated = 111;\n");
          }
        }
        return res;
      }) as any;

      try {
        await assert.rejects(
          () => orchestrator.recordValidatedReviewResult(runId, passReview),
          (err: unknown) => {
            assert(err instanceof TransitionRejectedError || err instanceof ArtifactDigestMismatchError);
            return true;
          }
        );
      } finally {
        FileHandleProto.sync = origSync;
        (fs as any).lstatSync = origLstat;
      }
    } finally {
      await env.cleanup();
    }
  });

  test("B6: initial FAIL late mutation -> REJECT stale state", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
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
      unlinkSync(tempDummy);

      const origSync = FileHandleProto.sync;
      let stageWriteSynced = false;

      FileHandleProto.sync = async function (...args: any[]) {
        const res = await origSync.apply(this, args as any);
        const trace = new Error().stack || "";
        if (trace.includes("executeSemanticTransition") && !trace.includes("acquireRunLock")) {
          stageWriteSynced = true;
        }
        return res;
      };

      let fenceCallCount = 0;
      const origLstat = fs.lstatSync;
      (fs as any).lstatSync = ((...args: any[]) => {
        const res = (origLstat as any)(...args);
        const pathStr = String(args[0]);
        const trace = new Error().stack || "";
        if (stageWriteSynced && pathStr.includes("src/input.ts") && trace.includes("verifyFileIdentityFence")) {
          fenceCallCount++;
          if (fenceCallCount === 1) {
            writeFileSync(join(repoDir, "src", "input.ts"), "export const b6Mutated = 222;\n");
          }
        }
        return res;
      }) as any;

      try {
        await assert.rejects(
          () => orchestrator.recordValidatedReviewResult(runId, failReview),
          (err: unknown) => {
            assert(err instanceof TransitionRejectedError || err instanceof ArtifactDigestMismatchError);
            return true;
          }
        );
      } finally {
        FileHandleProto.sync = origSync;
        (fs as any).lstatSync = origLstat;
      }
    } finally {
      await env.cleanup();
    }
  });

  test("B7: branch drift -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const orchestrator = new CindyOrchestrator({ repoDir });
      await orchestrator.initRun({ runId, taskId });

      git(["checkout", "-b", "side"]);

      await assert.rejects(
        () => orchestrator.markReadyForBuilder(runId),
        (err: unknown) => {
          assert(err instanceof TransitionRejectedError);
          assert.match((err as Error).message, /BRANCH_MISMATCH/i);
          return true;
        }
      );
    } finally {
      await env.cleanup();
    }
  });

  test("B8: upstream drift -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const orchestrator = new CindyOrchestrator({ repoDir });
      await orchestrator.initRun({ runId, taskId });

      git(["config", "branch.main.remote", "unknown_remote"]);

      await assert.rejects(
        () => orchestrator.markReadyForBuilder(runId),
        (err: unknown) => {
          assert(err instanceof TransitionRejectedError);
          assert.match((err as Error).message, /UPSTREAM_MISSING|UPSTREAM_DRIFT/i);
          return true;
        }
      );
    } finally {
      await env.cleanup();
    }
  });

  test("B9: scope outside index-only mutation -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const orchestrator = new CindyOrchestrator({ repoDir });
      await orchestrator.initRun({ runId, taskId });

      // Stage change to README (outside allowedScope)
      await writeFile(join(repoDir, "README.md"), "# Staged README\n", "utf8");
      git(["add", "README.md"]);

      await assert.rejects(
        () => orchestrator.markReadyForBuilder(runId),
        (err: unknown) => {
          assert(err instanceof DirtyTreeUnexplainedError || err instanceof TransitionRejectedError);
          return true;
        }
      );
    } finally {
      await env.cleanup();
    }
  });

  test("B10: staged write barrier Git authority drift -> continues to REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const orchestrator = new CindyOrchestrator({ repoDir });
      await orchestrator.initRun({ runId, taskId });

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
            assert.match((err as Error).message, /authority changed|BRANCH_MISMATCH/i);
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

  test("B11: normal READY_FOR_BUILDER transition -> PASS", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      await orchestrator.initRun({ runId, taskId });

      const run = await orchestrator.markReadyForBuilder(runId);
      assert.equal(run.state, CindyState.READY_FOR_BUILDER);
      assert.equal(run.version, 2);
    } finally {
      await env.cleanup();
    }
  });

  test("B12: rejected operation leaves version, history, cycle, formal state untouched, no staging residue, lock released", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const orchestrator = new CindyOrchestrator({ repoDir });
      const initialRun = await orchestrator.initRun({ runId, taskId });

      git(["checkout", "-b", "side"]);

      await assert.rejects(
        () => orchestrator.markReadyForBuilder(runId),
        TransitionRejectedError
      );

      // Restore branch
      git(["checkout", "main"]);

      const currentRun = await orchestrator.getRun(runId);
      assert.equal(currentRun.version, initialRun.version);
      assert.equal(currentRun.state, initialRun.state);
      assert.equal(currentRun.currentCycle, initialRun.currentCycle);
      assert.equal(currentRun.history.length, initialRun.history.length);

      // Verify no temporary files in run dir
      const runDir = join(repoDir, ".agent", "runtime", runId);
      const files = readdirSync(runDir);
      assert.ok(!files.some((f) => f.startsWith(".tmp_run_")));

      // Verify lock released: acquiring lock succeeds immediately
      const { ownerId } = await orchestrator.artifactStore.acquireRunLock(runDir);
      await orchestrator.artifactStore.releaseRunLock(runDir, ownerId);
    } finally {
      await env.cleanup();
    }
  });

  test("B13: clean duplicate replay remains idempotent", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      await orchestrator.initRun({ runId, taskId });

      const run1 = await orchestrator.markReadyForBuilder(runId);
      const run2 = await orchestrator.markReadyForBuilder(runId);

      assert.equal(run1.version, run2.version);
      assert.equal(run1.state, run2.state);
      assert.equal(run1.history.length, run2.history.length);
    } finally {
      await env.cleanup();
    }
  });

  test("B14: public APIs prohibit direct entry into privileged states", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      await orchestrator.initRun({ runId, taskId });

      // Prohibit transition to FINAL_GATE
      await assert.rejects(
        () => orchestrator.artifactStore.applyAdministrativeTransition(runId, CindyState.FINAL_GATE as any),
        (err: unknown) => {
          assert(err instanceof TransitionRejectedError);
          assert.match((err as Error).message, /sealed and prohibited/i);
          return true;
        }
      );

      // Prohibit transition to CLOSED
      await assert.rejects(
        () => orchestrator.artifactStore.applyAdministrativeTransition(runId, CindyState.CLOSED as any),
        (err: unknown) => {
          assert(err instanceof TransitionRejectedError);
          assert.match((err as Error).message, /sealed and prohibited/i);
          return true;
        }
      );
    } finally {
      await env.cleanup();
    }
  });
});

// ============================================================
// Matrix C: M-R6-03 FAIL Replay Stored Evidence (C1 to C11)
// ============================================================

describe("R2F3-R7: Matrix C - M-R6-03 FAIL Replay Stored Evidence", () => {
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

  async function setupReviewingRun(
    orchestrator: CindyOrchestrator,
    runId: string,
    taskId: string,
    session = "session-c"
  ): Promise<CindyRun> {
    await setupTestingRun(orchestrator, runId, taskId);
    await recordPassingEvidence(orchestrator, runId, taskId);
    await orchestrator.prepareForReview(runId);
    return await orchestrator.startReview(runId, {
      reviewer: { identity: "cindy-reviewer", session, readOnlyConfirmed: true, readOnlyRequired: true },
    });
  }

  async function setupFailedReviewRun(
    orchestrator: CindyOrchestrator,
    runId: string,
    taskId: string,
    session = "session-fail"
  ): Promise<{ run: CindyRun; failReview: ReviewResultArtifact }> {
    const reviewingRun = await setupReviewingRun(orchestrator, runId, taskId, session);
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
        session,
        readOnlyConfirmed: true,
      },
      trustClassification: "STRUCTURE_VALID_EXTERNAL",
    };

    const run = await orchestrator.recordValidatedReviewResult(runId, failReview);
    return { run, failReview };
  }

  test("C1: valid identical FAIL replay with op.review omitted -> idempotent PASS", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      const { run: runAfterFail } = await setupFailedReviewRun(orchestrator, runId, taskId);

      assert.equal(runAfterFail.state, CindyState.REPAIR_INITIALIZED);
      assert.equal(runAfterFail.currentCycle, 2);

      // Replay with op.review OMITTED (only verdict: FAIL or undefined)
      const replayRun = await executeSemanticTransition(orchestrator.artifactStore, runId, {
        type: "recordValidatedReviewResult",
        verdict: "FAIL",
      });

      assert.equal(replayRun.version, runAfterFail.version);
      assert.equal(replayRun.state, runAfterFail.state);
      assert.equal(replayRun.currentCycle, runAfterFail.currentCycle);
      assert.equal(replayRun.history.length, runAfterFail.history.length);
    } finally {
      await env.cleanup();
    }
  });

  test("C2: stored verdict tampered to PASS -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      await setupFailedReviewRun(orchestrator, runId, taskId);

      // Tamper on-disk review-result-1.json to verdict = PASS
      const reviewPath = orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.REVIEW_RESULT, 1);
      const stored = JSON.parse(readFileSync(reviewPath, "utf8"));
      stored.verdict = "PASS";
      writeFileSync(reviewPath, JSON.stringify(stored, null, 2), "utf8");

      // Replay with op.review omitted
      await assert.rejects(
        () => executeSemanticTransition(orchestrator.artifactStore, runId, {
          type: "recordValidatedReviewResult",
          verdict: "FAIL",
        }),
        (err: unknown) => {
          assert(err instanceof ConflictingArtifactError || err instanceof ArtifactValidationError);
          return true;
        }
      );
    } finally {
      await env.cleanup();
    }
  });

  test("C3: stored tree digest drift -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      await setupFailedReviewRun(orchestrator, runId, taskId);

      // Tamper on-disk review-result-1.json reviewedTreeDigest
      const reviewPath = orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.REVIEW_RESULT, 1);
      const stored = JSON.parse(readFileSync(reviewPath, "utf8"));
      stored.reviewedTreeDigest = "a".repeat(64);
      writeFileSync(reviewPath, JSON.stringify(stored, null, 2), "utf8");

      await assert.rejects(
        () => executeSemanticTransition(orchestrator.artifactStore, runId, {
          type: "recordValidatedReviewResult",
          verdict: "FAIL",
        }),
        (err: unknown) => {
          assert(err instanceof ArtifactDigestMismatchError);
          return true;
        }
      );
    } finally {
      await env.cleanup();
    }
  });

  test("C4: stored diff digest drift -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      await setupFailedReviewRun(orchestrator, runId, taskId);

      // Tamper on-disk review-result-1.json reviewedDiffDigest
      const reviewPath = orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.REVIEW_RESULT, 1);
      const stored = JSON.parse(readFileSync(reviewPath, "utf8"));
      stored.reviewedDiffDigest = "b".repeat(64);
      writeFileSync(reviewPath, JSON.stringify(stored, null, 2), "utf8");

      await assert.rejects(
        () => executeSemanticTransition(orchestrator.artifactStore, runId, {
          type: "recordValidatedReviewResult",
          verdict: "FAIL",
        }),
        (err: unknown) => {
          assert(err instanceof ArtifactDigestMismatchError);
          return true;
        }
      );
    } finally {
      await env.cleanup();
    }
  });

  test("C5: stored base commit drift -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      await setupFailedReviewRun(orchestrator, runId, taskId);

      // Tamper on-disk review-result-1.json reviewedBaseCommit
      const reviewPath = orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.REVIEW_RESULT, 1);
      const stored = JSON.parse(readFileSync(reviewPath, "utf8"));
      stored.reviewedBaseCommit = "c".repeat(40);
      writeFileSync(reviewPath, JSON.stringify(stored, null, 2), "utf8");

      await assert.rejects(
        () => executeSemanticTransition(orchestrator.artifactStore, runId, {
          type: "recordValidatedReviewResult",
          verdict: "FAIL",
        }),
        (err: unknown) => {
          assert(err instanceof ArtifactValidationError);
          return true;
        }
      );
    } finally {
      await env.cleanup();
    }
  });

  test("C6: reviewer session mismatch -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      await setupFailedReviewRun(orchestrator, runId, taskId);

      // Tamper reviewer session in on-disk review-result-1.json
      const reviewPath = orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.REVIEW_RESULT, 1);
      const stored = JSON.parse(readFileSync(reviewPath, "utf8"));
      stored.reviewer.session = "tampered-session";
      writeFileSync(reviewPath, JSON.stringify(stored, null, 2), "utf8");

      await assert.rejects(
        () => executeSemanticTransition(orchestrator.artifactStore, runId, {
          type: "recordValidatedReviewResult",
          verdict: "FAIL",
        }),
        (err: unknown) => {
          assert(err instanceof ArtifactValidationError);
          return true;
        }
      );
    } finally {
      await env.cleanup();
    }
  });

  test("C7: stored REVIEW_REQUEST binding stale -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      await setupFailedReviewRun(orchestrator, runId, taskId);

      // Tamper on-disk review-request boundTreeDigest
      const reqPath = orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.REVIEW_REQUEST, 1);
      const stored = JSON.parse(readFileSync(reqPath, "utf8"));
      stored.boundTreeDigest = "d".repeat(64);
      writeFileSync(reqPath, JSON.stringify(stored, null, 2), "utf8");

      await assert.rejects(
        () => executeSemanticTransition(orchestrator.artifactStore, runId, {
          type: "recordValidatedReviewResult",
          verdict: "FAIL",
        }),
        (err: unknown) => {
          assert(err instanceof ArtifactDigestMismatchError || err instanceof ArtifactValidationError);
          return true;
        }
      );
    } finally {
      await env.cleanup();
    }
  });

  test("C8: snapshot identity stale -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      await setupFailedReviewRun(orchestrator, runId, taskId);

      // Tamper on-disk review-result-1.json executionSnapshotDigest
      const reviewPath = orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.REVIEW_RESULT, 1);
      const stored = JSON.parse(readFileSync(reviewPath, "utf8"));
      stored.executionSnapshotDigest = "e".repeat(64);
      writeFileSync(reviewPath, JSON.stringify(stored, null, 2), "utf8");

      await assert.rejects(
        () => executeSemanticTransition(orchestrator.artifactStore, runId, {
          type: "recordValidatedReviewResult",
          verdict: "FAIL",
        }),
        (err: unknown) => {
          assert(err instanceof ArtifactDigestMismatchError);
          return true;
        }
      );
    } finally {
      await env.cleanup();
    }
  });

  test("C9: Git authority drift -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const orchestrator = new CindyOrchestrator({ repoDir });
      await setupFailedReviewRun(orchestrator, runId, taskId);

      // Drift branch
      git(["checkout", "-b", "side"]);

      await assert.rejects(
        () => executeSemanticTransition(orchestrator.artifactStore, runId, {
          type: "recordValidatedReviewResult",
          verdict: "FAIL",
        }),
        (err: unknown) => {
          assert(err instanceof TransitionRejectedError);
          assert.match((err as Error).message, /BRANCH_MISMATCH|authority changed/i);
          return true;
        }
      );
    } finally {
      await env.cleanup();
    }
  });

  test("C10: all rejections leave run version, history, cycle unchanged", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      const { run: runBeforeRejection } = await setupFailedReviewRun(orchestrator, runId, taskId);

      // Tamper stored verdict to PASS to force rejection
      const reviewPath = orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.REVIEW_RESULT, 1);
      const stored = JSON.parse(readFileSync(reviewPath, "utf8"));
      stored.verdict = "PASS";
      writeFileSync(reviewPath, JSON.stringify(stored, null, 2), "utf8");

      await assert.rejects(
        () => executeSemanticTransition(orchestrator.artifactStore, runId, {
          type: "recordValidatedReviewResult",
          verdict: "FAIL",
        })
      );

      // Re-read run from disk and assert all fields untouched
      const currentRun = await orchestrator.getRun(runId);
      assert.equal(currentRun.version, runBeforeRejection.version);
      assert.equal(currentRun.state, runBeforeRejection.state);
      assert.equal(currentRun.currentCycle, runBeforeRejection.currentCycle);
      assert.equal(currentRun.history.length, runBeforeRejection.history.length);
    } finally {
      await env.cleanup();
    }
  });

  test("C11: regular PASS replay continues to comply with full evidence validation", async () => {
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

      const passRun1 = await orchestrator.recordValidatedReviewResult(runId, passReview);
      assert.equal(passRun1.state, CindyState.REVIEWING);

      // Replay PASS
      const passRun2 = await orchestrator.recordValidatedReviewResult(runId, passReview);
      assert.equal(passRun2.version, passRun1.version);
      assert.equal(passRun2.state, passRun1.state);
      assert.equal(passRun2.history.length, passRun1.history.length);
    } finally {
      await env.cleanup();
    }
  });

  test("C12: M-R7-01 stored REVIEW_RESULT identity='' -> REJECT Fail Closed", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      const { run: runBeforeRejection } = await setupFailedReviewRun(orchestrator, runId, taskId);

      // Tamper reviewer.identity in stored review-result-1.json to ""
      const reviewPath = orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.REVIEW_RESULT, 1);
      const stored = JSON.parse(readFileSync(reviewPath, "utf8"));
      stored.reviewer.identity = "";
      writeFileSync(reviewPath, JSON.stringify(stored, null, 2), "utf8");

      await assert.rejects(
        () => executeSemanticTransition(orchestrator.artifactStore, runId, {
          type: "recordValidatedReviewResult",
          verdict: "FAIL",
        }),
        (err: unknown) => {
          assert(err instanceof ArtifactValidationError || err instanceof TransitionRejectedError);
          return true;
        }
      );

      const currentRun = await orchestrator.getRun(runId);
      assert.equal(currentRun.version, runBeforeRejection.version);
      assert.equal(currentRun.state, runBeforeRejection.state);
      assert.equal(currentRun.currentCycle, runBeforeRejection.currentCycle);
      assert.equal(currentRun.history.length, runBeforeRejection.history.length);
      assert.deepStrictEqual(currentRun, runBeforeRejection);

      const diskRun = JSON.parse(readFileSync(orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.RUN), "utf8"));
      assert.deepStrictEqual(diskRun, runBeforeRejection);
    } finally {
      await env.cleanup();
    }
  });

  test("C13: M-R7-01 stored REVIEW_RESULT identity missing -> REJECT Fail Closed", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      const { run: runBeforeRejection } = await setupFailedReviewRun(orchestrator, runId, taskId);

      // Tamper reviewer.identity in stored review-result-1.json to missing (delete)
      const reviewPath = orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.REVIEW_RESULT, 1);
      const stored = JSON.parse(readFileSync(reviewPath, "utf8"));
      delete stored.reviewer.identity;
      writeFileSync(reviewPath, JSON.stringify(stored, null, 2), "utf8");

      await assert.rejects(
        () => executeSemanticTransition(orchestrator.artifactStore, runId, {
          type: "recordValidatedReviewResult",
          verdict: "FAIL",
        }),
        (err: unknown) => {
          assert(err instanceof ArtifactValidationError || err instanceof TransitionRejectedError);
          return true;
        }
      );

      const currentRun = await orchestrator.getRun(runId);
      assert.equal(currentRun.version, runBeforeRejection.version);
      assert.equal(currentRun.state, runBeforeRejection.state);
      assert.equal(currentRun.currentCycle, runBeforeRejection.currentCycle);
      assert.equal(currentRun.history.length, runBeforeRejection.history.length);
      assert.deepStrictEqual(currentRun, runBeforeRejection);

      const diskRun = JSON.parse(readFileSync(orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.RUN), "utf8"));
      assert.deepStrictEqual(diskRun, runBeforeRejection);
    } finally {
      await env.cleanup();
    }
  });

  test("C14: M-R7-01 stored REVIEW_REQUEST identity='' -> REJECT Fail Closed", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      const { run: runBeforeRejection } = await setupFailedReviewRun(orchestrator, runId, taskId);

      // Tamper reviewer.identity in stored review-request-1.json to ""
      const reqPath = orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.REVIEW_REQUEST, 1);
      const stored = JSON.parse(readFileSync(reqPath, "utf8"));
      stored.reviewer.identity = "";
      writeFileSync(reqPath, JSON.stringify(stored, null, 2), "utf8");

      await assert.rejects(
        () => executeSemanticTransition(orchestrator.artifactStore, runId, {
          type: "recordValidatedReviewResult",
          verdict: "FAIL",
        }),
        (err: unknown) => {
          assert(err instanceof ArtifactValidationError || err instanceof TransitionRejectedError);
          return true;
        }
      );

      const currentRun = await orchestrator.getRun(runId);
      assert.equal(currentRun.version, runBeforeRejection.version);
      assert.equal(currentRun.state, runBeforeRejection.state);
      assert.equal(currentRun.currentCycle, runBeforeRejection.currentCycle);
      assert.equal(currentRun.history.length, runBeforeRejection.history.length);
      assert.deepStrictEqual(currentRun, runBeforeRejection);

      const diskRun = JSON.parse(readFileSync(orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.RUN), "utf8"));
      assert.deepStrictEqual(diskRun, runBeforeRejection);
    } finally {
      await env.cleanup();
    }
  });

  test("C15: M-R7-01 stored REVIEW_REQUEST identity missing -> REJECT Fail Closed", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      const { run: runBeforeRejection } = await setupFailedReviewRun(orchestrator, runId, taskId);

      // Tamper reviewer.identity in stored review-request-1.json to missing (delete)
      const reqPath = orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.REVIEW_REQUEST, 1);
      const stored = JSON.parse(readFileSync(reqPath, "utf8"));
      delete stored.reviewer.identity;
      writeFileSync(reqPath, JSON.stringify(stored, null, 2), "utf8");

      await assert.rejects(
        () => executeSemanticTransition(orchestrator.artifactStore, runId, {
          type: "recordValidatedReviewResult",
          verdict: "FAIL",
        }),
        (err: unknown) => {
          assert(err instanceof ArtifactValidationError || err instanceof TransitionRejectedError);
          return true;
        }
      );

      const currentRun = await orchestrator.getRun(runId);
      assert.equal(currentRun.version, runBeforeRejection.version);
      assert.equal(currentRun.state, runBeforeRejection.state);
      assert.equal(currentRun.currentCycle, runBeforeRejection.currentCycle);
      assert.equal(currentRun.history.length, runBeforeRejection.history.length);
      assert.deepStrictEqual(currentRun, runBeforeRejection);

      const diskRun = JSON.parse(readFileSync(orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.RUN), "utf8"));
      assert.deepStrictEqual(diskRun, runBeforeRejection);
    } finally {
      await env.cleanup();
    }
  });

  test("C16: M-R7-01 stored REVIEW_RESULT session='' -> REJECT Fail Closed", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      const { run: runBeforeRejection } = await setupFailedReviewRun(orchestrator, runId, taskId);

      // Tamper reviewer.session in stored review-result-1.json to ""
      const reviewPath = orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.REVIEW_RESULT, 1);
      const stored = JSON.parse(readFileSync(reviewPath, "utf8"));
      stored.reviewer.session = "";
      writeFileSync(reviewPath, JSON.stringify(stored, null, 2), "utf8");

      await assert.rejects(
        () => executeSemanticTransition(orchestrator.artifactStore, runId, {
          type: "recordValidatedReviewResult",
          verdict: "FAIL",
        }),
        (err: unknown) => {
          assert(err instanceof ArtifactValidationError || err instanceof TransitionRejectedError);
          return true;
        }
      );

      const currentRun = await orchestrator.getRun(runId);
      assert.equal(currentRun.version, runBeforeRejection.version);
      assert.equal(currentRun.state, runBeforeRejection.state);
      assert.equal(currentRun.currentCycle, runBeforeRejection.currentCycle);
      assert.equal(currentRun.history.length, runBeforeRejection.history.length);
      assert.deepStrictEqual(currentRun, runBeforeRejection);

      const diskRun = JSON.parse(readFileSync(orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.RUN), "utf8"));
      assert.deepStrictEqual(diskRun, runBeforeRejection);
    } finally {
      await env.cleanup();
    }
  });

  test("C17: M-R7-01 stored REVIEW_REQUEST session='' -> REJECT Fail Closed", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      const { run: runBeforeRejection } = await setupFailedReviewRun(orchestrator, runId, taskId);

      // Tamper reviewer.session in stored review-request-1.json to ""
      const reqPath = orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.REVIEW_REQUEST, 1);
      const stored = JSON.parse(readFileSync(reqPath, "utf8"));
      stored.reviewer.session = "";
      writeFileSync(reqPath, JSON.stringify(stored, null, 2), "utf8");

      await assert.rejects(
        () => executeSemanticTransition(orchestrator.artifactStore, runId, {
          type: "recordValidatedReviewResult",
          verdict: "FAIL",
        }),
        (err: unknown) => {
          assert(err instanceof ArtifactValidationError || err instanceof TransitionRejectedError);
          return true;
        }
      );

      const currentRun = await orchestrator.getRun(runId);
      assert.equal(currentRun.version, runBeforeRejection.version);
      assert.equal(currentRun.state, runBeforeRejection.state);
      assert.equal(currentRun.currentCycle, runBeforeRejection.currentCycle);
      assert.equal(currentRun.history.length, runBeforeRejection.history.length);
      assert.deepStrictEqual(currentRun, runBeforeRejection);

      const diskRun = JSON.parse(readFileSync(orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.RUN), "utf8"));
      assert.deepStrictEqual(diskRun, runBeforeRejection);
    } finally {
      await env.cleanup();
    }
  });

  test("C18: M-R7-01 stored REVIEW_RESULT session missing -> REJECT Fail Closed", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      const { run: runBeforeRejection } = await setupFailedReviewRun(orchestrator, runId, taskId);

      // Tamper reviewer.session in stored review-result-1.json to missing (delete)
      const reviewPath = orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.REVIEW_RESULT, 1);
      const stored = JSON.parse(readFileSync(reviewPath, "utf8"));
      delete stored.reviewer.session;
      writeFileSync(reviewPath, JSON.stringify(stored, null, 2), "utf8");

      await assert.rejects(
        () => executeSemanticTransition(orchestrator.artifactStore, runId, {
          type: "recordValidatedReviewResult",
          verdict: "FAIL",
        }),
        (err: unknown) => {
          assert(err instanceof ArtifactValidationError || err instanceof TransitionRejectedError);
          return true;
        }
      );

      const currentRun = await orchestrator.getRun(runId);
      assert.equal(currentRun.version, runBeforeRejection.version);
      assert.equal(currentRun.state, runBeforeRejection.state);
      assert.equal(currentRun.currentCycle, runBeforeRejection.currentCycle);
      assert.equal(currentRun.history.length, runBeforeRejection.history.length);
      assert.deepStrictEqual(currentRun, runBeforeRejection);

      const diskRun = JSON.parse(readFileSync(orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.RUN), "utf8"));
      assert.deepStrictEqual(diskRun, runBeforeRejection);
    } finally {
      await env.cleanup();
    }
  });

  test("C19: M-R7-01 stored REVIEW_REQUEST session missing -> REJECT Fail Closed", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const orchestrator = new CindyOrchestrator({ repoDir });
      const { run: runBeforeRejection } = await setupFailedReviewRun(orchestrator, runId, taskId);

      // Tamper reviewer.session in stored review-request-1.json to missing (delete)
      const reqPath = orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.REVIEW_REQUEST, 1);
      const stored = JSON.parse(readFileSync(reqPath, "utf8"));
      delete stored.reviewer.session;
      writeFileSync(reqPath, JSON.stringify(stored, null, 2), "utf8");

      await assert.rejects(
        () => executeSemanticTransition(orchestrator.artifactStore, runId, {
          type: "recordValidatedReviewResult",
          verdict: "FAIL",
        }),
        (err: unknown) => {
          assert(err instanceof ArtifactValidationError || err instanceof TransitionRejectedError);
          return true;
        }
      );

      const currentRun = await orchestrator.getRun(runId);
      assert.equal(currentRun.version, runBeforeRejection.version);
      assert.equal(currentRun.state, runBeforeRejection.state);
      assert.equal(currentRun.currentCycle, runBeforeRejection.currentCycle);
      assert.equal(currentRun.history.length, runBeforeRejection.history.length);
      assert.deepStrictEqual(currentRun, runBeforeRejection);

      const diskRun = JSON.parse(readFileSync(orchestrator.artifactStore.getArtifactPath(runId, ArtifactKind.RUN), "utf8"));
      assert.deepStrictEqual(diskRun, runBeforeRejection);
    } finally {
      await env.cleanup();
    }
  });
});
