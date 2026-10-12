/**
 * CINDY-ORCH-MVP-R2F3-R4 Test Suite
 *
 * Covers all findings from PI_GPT6_R2F3_R3_REVIEW_FAIL:
 * - Tests A1–A5: HIGH-01 Initialization publication fence & race prevention
 * - Tests B1–B4: MEDIUM-02 Initialization final dirty ownership & freshness
 * - Tests C1–C7: HIGH-02 Symlink loop false positive resolution & cycle detection
 * - Tests D1–D7: MEDIUM-03 Reserved namespace component guard
 * - Tests E1–E6: MEDIUM-04 POSIX backslash filename semantics
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import fs, { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CindyOrchestrator,
  CindyState,
  RuntimeArtifactStore,
  ArtifactKind,
  inspectSnapshotEntry,
  assertSnapshotPathContained,
  validateIgnoredPathEntry,
  computeTreeDigest,
  readCanonicalTaskPacketAtCommit,
  readCommittedClosure,
  checkGitUpstreamStatus,
  evaluateGitAuthority,
  TransitionRejectedError,
  DirtyTreeUnexplainedError,
  SymlinkEscapeError,
  FilesystemSnapshotError,
  ExecutionInputsValidationError,
  ConflictingArtifactError,
} from "../tools/cindy/index.ts";

// ============================================================
// Shared test environment helper
// ============================================================

async function createTestRepo(customTaskId = "TASK-R4"): Promise<{
  repoDir: string;
  bareDir: string;
  baseCommit: string;
  taskId: string;
  runId: string;
  cleanup: () => Promise<void>;
}> {
  const repoDir = await mkdtemp(join(tmpdir(), "cindy-r4-repo-"));
  const bareDir = await mkdtemp(join(tmpdir(), "cindy-r4-bare-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

  git(["init", "-b", "main"]);
  git(["config", "user.name", "Cindy R4 Test"]);
  git(["config", "user.email", "cindy-r4@example.com"]);

  await writeFile(
    join(repoDir, ".gitignore"),
    "node_modules/\n.agent/runtime/\n.agent/.cindy-init-staging/\n*.ignored\n*.env\n",
    "utf8"
  );
  await writeFile(join(repoDir, "README.md"), "# R4 Test Repo\n", "utf8");

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

  const runId = "run-r4-001";

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
// Group A: HIGH-01 Initialization publication fence
// ============================================================

describe("R2F3-R4: Group A - HIGH-01 Initialization Publication Fence", () => {
  test("TEST A1: Task A OPEN, barrier mutates HEAD to closed B before final fence -> init REJECTS, no publication", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

      const store = new RuntimeArtifactStore({ repoDir });
      let barrierTriggered = false;

      // Deterministic barrier right before the final authority validation fence:
      // Preparation has completed, but publication has not occurred yet.
      (store as any).onBeforeFinalValidationFence = async () => {
        barrierTriggered = true;
        // Mutate Git: close the task at a new commit B and push
        const closedDir = join(repoDir, ".agent", "tasks", taskId, "artifacts");
        await mkdir(closedDir, { recursive: true });
        await writeFile(
          join(closedDir, "closeout.json"),
          JSON.stringify(
            {
              runId: "prior-closed-run",
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
      };

      await assert.rejects(
        () => store.initializeRunSafely({ runId, taskId }),
        (err: unknown) => {
          return (
            err instanceof TransitionRejectedError &&
            (/authority.*changed|CLOSED|HEAD_DRIFT/i.test((err as Error).message))
          );
        }
      );

      assert.ok(barrierTriggered, "Barrier must have triggered before final fence");

      // Verify NO publication: runtime dir must NOT exist
      const publishedRunDir = join(repoDir, ".agent", "runtime", runId);
      assert.ok(!existsSync(publishedRunDir), "Run directory must NOT be published upon rejection");

      // Verify staging dir was cleaned up
      const stagingRoot = join(repoDir, ".agent", ".cindy-init-staging");
      if (existsSync(stagingRoot)) {
        const entries = fs.readdirSync(stagingRoot);
        const lingering = entries.filter((e) => e.startsWith(runId));
        assert.equal(lingering.length, 0, "Staging directory must be cleaned up on failure");
      }
    } finally {
      await env.cleanup();
    }
  });

  test("TEST A2: Task A CLOSED, HEAD points to OPEN B -> cannot reopen CLOSED A", async () => {
    const env = await createTestRepo("TASK-A");
    try {
      const { repoDir } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

      // Close TASK-A at commit A
      const closedDir = join(repoDir, ".agent", "tasks", "TASK-A", "artifacts");
      await mkdir(closedDir, { recursive: true });
      await writeFile(
        join(closedDir, "closeout.json"),
        JSON.stringify(
          {
            runId: "run-a-prev",
            taskId: "TASK-A",
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
      git(["commit", "-m", "close TASK-A"]);

      // Create TASK-B which is OPEN at commit B
      const bDir = join(repoDir, ".agent", "tasks", "TASK-B");
      await mkdir(bDir, { recursive: true });
      await writeFile(
        join(bDir, "task.json"),
        JSON.stringify(
          {
            taskId: "TASK-B",
            status: "READY",
            branch: "main",
            baseCommit: env.baseCommit,
            allowedScope: ["src/"],
          },
          null,
          2
        ),
        "utf8"
      );
      git(["add", "."]);
      git(["commit", "-m", "add open TASK-B"]);
      git(["push", "-q"]);

      const store = new RuntimeArtifactStore({ repoDir });
      await assert.rejects(
        () => store.initializeRunSafely({ runId: "run-a-new", taskId: "TASK-A" }),
        (err: unknown) => err instanceof TransitionRejectedError && /CLOSED/i.test((err as Error).message)
      );

      const publishedRunDir = join(repoDir, ".agent", "runtime", "run-a-new");
      assert.ok(!existsSync(publishedRunDir), "Cannot publish run for closed task");
    } finally {
      await env.cleanup();
    }
  });

  test("TEST A3: A/B Task Packet allowedScope differ -> rejects mixing authority", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

      const store = new RuntimeArtifactStore({ repoDir });
      let barrierHit = false;

      (store as any).onBeforeFinalValidationFence = async () => {
        barrierHit = true;
        const taskJsonPath = join(repoDir, ".agent", "tasks", taskId, "task.json");
        const packet = JSON.parse(await readFile(taskJsonPath, "utf8"));
        packet.allowedScope = ["different-scope/"];
        await writeFile(taskJsonPath, JSON.stringify(packet, null, 2), "utf8");
        git(["add", taskJsonPath]);
        git(["commit", "-m", "mutate allowedScope"]);
        git(["push", "-q"]);
      };

      await assert.rejects(
        () => store.initializeRunSafely({ runId, taskId }),
        TransitionRejectedError
      );

      assert.ok(barrierHit, "Barrier must have triggered");
      assert.ok(!existsSync(join(repoDir, ".agent", "runtime", runId)));
    } finally {
      await env.cleanup();
    }
  });

  test("TEST A4: HEAD/upstream drifts before final validation -> rejects", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

      const store = new RuntimeArtifactStore({ repoDir });
      let barrierHit = false;

      (store as any).onBeforeFinalValidationFence = async () => {
        barrierHit = true;
        // Add a commit on main
        await mkdir(join(repoDir, "src"), { recursive: true });
        await writeFile(join(repoDir, "src", "extra.ts"), "// extra", "utf8");
        git(["add", "src/extra.ts"]);
        git(["commit", "-m", "extra commit drift"]);
        git(["push", "-q"]);
      };

      await assert.rejects(
        () => store.initializeRunSafely({ runId, taskId }),
        TransitionRejectedError
      );

      assert.ok(barrierHit, "Barrier must have triggered");
      assert.ok(!existsSync(join(repoDir, ".agent", "runtime", runId)));
    } finally {
      await env.cleanup();
    }
  });

  test("TEST A5: healthy stable Task -> normal initialization PASSES with full bundle", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId, baseCommit } = env;
      const store = new RuntimeArtifactStore({ repoDir });

      const run = await store.initializeRunSafely({ runId, taskId });
      assert.equal(run.state, CindyState.TASK_INITIALIZED);
      assert.equal(run.runId, runId);
      assert.equal(run.taskId, taskId);
      assert.equal(run.baseCommit, baseCommit);

      const runDir = join(repoDir, ".agent", "runtime", runId);
      assert.ok(existsSync(join(runDir, "run.json")), "run.json must exist in published runtime");
      assert.ok(existsSync(join(runDir, "baseline.json")), "baseline.json must exist in published runtime");
    } finally {
      await env.cleanup();
    }
  });
});

// ============================================================
// Group B: MEDIUM-02 Initialization final dirty ownership
// ============================================================

describe("R2F3-R4: Group B - MEDIUM-02 Final Dirty Ownership", () => {
  test("TEST B1: index-only mutation on outside-scope README.md during preparation -> rejects publication", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

      const store = new RuntimeArtifactStore({ repoDir });
      let barrierHit = false;

      (store as any).onBeforeFinalValidationFence = async () => {
        barrierHit = true;
        // Make an index-only modification to outside-scope README.md
        await writeFile(join(repoDir, "README.md"), "# Modified in index\n", "utf8");
        git(["add", "README.md"]);
        // Revert working tree file so it's staged (index-only mutation)
        await writeFile(join(repoDir, "README.md"), "# R4 Test Repo\n", "utf8");
      };

      await assert.rejects(
        () => store.initializeRunSafely({ runId, taskId }),
        (err: unknown) => {
          return (
            err instanceof DirtyTreeUnexplainedError ||
            (err instanceof TransitionRejectedError && /dirty|unexplained/i.test((err as Error).message))
          );
        }
      );

      assert.ok(barrierHit, "Barrier must have triggered");
      assert.ok(!existsSync(join(repoDir, ".agent", "runtime", runId)), "Run must not be published");
    } finally {
      await env.cleanup();
    }
  });

  test("TEST B2: outside-scope untracked file added during preparation -> rejects publication", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const store = new RuntimeArtifactStore({ repoDir });
      let barrierHit = false;

      (store as any).onBeforeFinalValidationFence = async () => {
        barrierHit = true;
        // Add outside-scope untracked file
        await writeFile(join(repoDir, "untracked-outside.txt"), "hello", "utf8");
      };

      await assert.rejects(
        () => store.initializeRunSafely({ runId, taskId }),
        (err: unknown) => {
          return (
            err instanceof DirtyTreeUnexplainedError ||
            (err instanceof TransitionRejectedError && /dirty|unexplained|STALE_TREE_BINDING/i.test((err as Error).message))
          );
        }
      );

      assert.ok(barrierHit, "Barrier must have triggered");
      assert.ok(!existsSync(join(repoDir, ".agent", "runtime", runId)));
    } finally {
      await env.cleanup();
    }
  });

  test("TEST B3: allowed-scope dirty file in working tree -> accepted per R2F2 contract", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;

      // Add allowed-scope dirty file
      await mkdir(join(repoDir, "src"), { recursive: true });
      await writeFile(join(repoDir, "src", "in-scope.ts"), "// in scope dirty", "utf8");

      const store = new RuntimeArtifactStore({ repoDir });
      const run = await store.initializeRunSafely({ runId, taskId });

      assert.equal(run.state, CindyState.TASK_INITIALIZED);
      assert.ok(existsSync(join(repoDir, ".agent", "runtime", runId)));
    } finally {
      await env.cleanup();
    }
  });

  test("TEST B4: ignored runtime artifacts do not trigger unexplained dirty rejection", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;

      // Put files inside .agent/runtime (which is in .gitignore)
      const priorRunDir = join(repoDir, ".agent", "runtime", "prior-run");
      await mkdir(priorRunDir, { recursive: true });
      const now = new Date().toISOString();
      const priorClosedRun = {
        runId: "prior-run",
        taskId: "PRIOR-TASK",
        version: 1,
        state: CindyState.CLOSED,
        currentCycle: 1,
        branch: "main",
        baseCommit: env.baseCommit,
        headCommit: env.baseCommit,
        taskAuthorityCommit: env.baseCommit,
        upstreamRef: "refs/remotes/origin/main",
        upstreamCommit: env.baseCommit,
        allowedScope: ["src/"],
        boundTreeDigest: "0".repeat(64),
        stopReason: null,
        stopExplanation: null,
        history: [],
        createdAt: now,
        updatedAt: now,
      };
      await writeFile(join(priorRunDir, "run.json"), JSON.stringify(priorClosedRun, null, 2), "utf8");

      const store = new RuntimeArtifactStore({ repoDir });
      const run = await store.initializeRunSafely({ runId, taskId });

      assert.equal(run.state, CindyState.TASK_INITIALIZED);
    } finally {
      await env.cleanup();
    }
  });
});

// ============================================================
// Group C: HIGH-02 Symlink loop false positive
// ============================================================

describe("R2F3-R4: Group C - HIGH-02 Symlink Loop False Positive & Cycle Detection", () => {
  test("TEST C1: repeat -> hop2/../hop2/file resolves successfully without false positive loop detection", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r4-sym-"));
    try {
      await mkdir(join(repoDir, "dir"), { recursive: true });
      await writeFile(join(repoDir, "dir", "file"), "hello world\n", "utf8");

      symlinkSync("dir", join(repoDir, "hop2"));
      symlinkSync("hop2/../hop2/file", join(repoDir, "repeat"));

      assert.doesNotThrow(() => assertSnapshotPathContained(repoDir, "repeat"));

      const entry = inspectSnapshotEntry(repoDir, "repeat");
      assert.equal(entry.entryType, "symlink");
      assert.equal((entry as any).target, "hop2/../hop2/file");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("TEST C2: actual symlink loop A -> B, B -> A fails closed", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r4-sym-"));
    try {
      symlinkSync("linkB", join(repoDir, "linkA"));
      symlinkSync("linkA", join(repoDir, "linkB"));

      assert.throws(
        () => assertSnapshotPathContained(repoDir, "linkA"),
        (err: unknown) => err instanceof SymlinkEscapeError && /loop/i.test((err as Error).message)
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("TEST C3: long symlink chain exceeding 40 hops fails closed", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r4-sym-"));
    try {
      for (let i = 0; i < 45; i++) {
        symlinkSync(`link-${i + 1}`, join(repoDir, `link-${i}`));
      }
      await writeFile(join(repoDir, "link-45"), "target", "utf8");

      assert.throws(
        () => assertSnapshotPathContained(repoDir, "link-0"),
        (err: unknown) => err instanceof SymlinkEscapeError && /nesting depth|loop/i.test((err as Error).message)
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("TEST C4: hop -> outside/dir, link -> hop/../safe rejected", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r4-sym-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "cindy-r4-out-"));
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

  test("TEST C5: escape and re-entry via .. escapes repository root and is rejected", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "cindy-r4-base-"));
    const repoDir = join(baseDir, "repo");
    await mkdir(repoDir, { recursive: true });
    try {
      symlinkSync("../../repo", join(repoDir, "escape-reenter"));

      assert.throws(
        () => assertSnapshotPathContained(repoDir, "escape-reenter"),
        SymlinkEscapeError
      );
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("TEST C6: safe internal ancestor symlink PASSES", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r4-sym-"));
    try {
      await mkdir(join(repoDir, "sub"), { recursive: true });
      await writeFile(join(repoDir, "sub", "target.txt"), "safe content", "utf8");
      symlinkSync("sub", join(repoDir, "link-sub"));

      assert.doesNotThrow(() => assertSnapshotPathContained(repoDir, "link-sub/target.txt"));

      const entry = inspectSnapshotEntry(repoDir, "link-sub/target.txt");
      assert.equal(entry.entryType, "regular");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("TEST C7: broken internal symlink adheres to raw-target identity contract", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r4-sym-"));
    try {
      symlinkSync("nonexistent-file.txt", join(repoDir, "broken-link"));

      assert.doesNotThrow(() => assertSnapshotPathContained(repoDir, "broken-link"));

      const entry = inspectSnapshotEntry(repoDir, "broken-link");
      assert.equal(entry.entryType, "symlink");
      assert.equal((entry as any).target, "nonexistent-file.txt");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// Group D: MEDIUM-03 Reserved namespace component guard
// ============================================================

describe("R2F3-R4: Group D - MEDIUM-03 Reserved Namespace Component Guard", () => {
  test("TEST D1: runtime-alias -> .agent/runtime, declaration runtime-alias/secret -> REJECT", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r4-ns-"));
    try {
      await mkdir(join(repoDir, ".agent", "runtime"), { recursive: true });
      await writeFile(join(repoDir, ".agent", "runtime", "secret"), "confidential", "utf8");
      symlinkSync(".agent/runtime", join(repoDir, "runtime-alias"));

      assert.throws(
        () => assertSnapshotPathContained(repoDir, "runtime-alias/secret"),
        SymlinkEscapeError
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("TEST D2: alias -> .agent/runtime/missing -> REJECT even when target is missing", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r4-ns-"));
    try {
      await mkdir(join(repoDir, ".agent"), { recursive: true });
      symlinkSync(".agent/runtime/missing", join(repoDir, "alias-missing"));

      assert.throws(
        () => assertSnapshotPathContained(repoDir, "alias-missing"),
        SymlinkEscapeError
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("TEST D3: alias into .agent/runtime then .. returning to repo -> REJECT", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r4-ns-"));
    try {
      await mkdir(join(repoDir, ".agent", "runtime"), { recursive: true });
      await writeFile(join(repoDir, "target.txt"), "hello", "utf8");
      symlinkSync(".agent/runtime", join(repoDir, "runtime-alias"));

      assert.throws(
        () => assertSnapshotPathContained(repoDir, "runtime-alias/../../target.txt"),
        SymlinkEscapeError
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("TEST D4: git-alias -> .git -> REJECT", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r4-ns-"));
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

  test("TEST D5: staging-alias -> .agent/.cindy-init-staging -> REJECT", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r4-ns-"));
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

  test("TEST D6: instrument filesystem calls: no lstat/readlink/readFile on reserved child", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r4-ns-"));
    try {
      await mkdir(join(repoDir, ".agent", "runtime"), { recursive: true });
      await writeFile(join(repoDir, ".agent", "runtime", "secret-child.txt"), "secret", "utf8");
      symlinkSync(".agent/runtime", join(repoDir, "runtime-alias"));

      const touchedPaths: string[] = [];
      const origLstat = fs.lstatSync;
      const origReadlink = fs.readlinkSync;
      const origReadFile = fs.readFileSync;

      (fs as any).lstatSync = ((p: fs.PathLike, opts?: any) => {
        touchedPaths.push(String(p));
        return origLstat(p, opts);
      }) as any;
      (fs as any).readlinkSync = ((p: fs.PathLike, opts?: any) => {
        touchedPaths.push(String(p));
        return origReadlink(p, opts);
      }) as any;
      (fs as any).readFileSync = ((p: any, opts?: any) => {
        touchedPaths.push(String(p));
        return origReadFile(p, opts);
      }) as any;

      try {
        assert.throws(
          () => assertSnapshotPathContained(repoDir, "runtime-alias/secret-child.txt"),
          SymlinkEscapeError
        );
      } finally {
        (fs as any).lstatSync = origLstat;
        (fs as any).readlinkSync = origReadlink;
        (fs as any).readFileSync = origReadFile;
      }

      // Assert that neither repo/.agent/runtime nor secret-child.txt was ever inspected with lstat/readlink/readFile
      const reservedTouched = touchedPaths.filter((p) => p.includes(".agent/runtime"));
      assert.equal(
        reservedTouched.length,
        0,
        `No syscall must touch reserved namespace components, but touched: ${reservedTouched.join(", ")}`
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("TEST D7: normal internal symlink alias not entering reserved namespace PASSES", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r4-ns-"));
    try {
      await mkdir(join(repoDir, "normal-dir"), { recursive: true });
      await writeFile(join(repoDir, "normal-dir", "data.json"), "{}", "utf8");
      symlinkSync("normal-dir", join(repoDir, "normal-alias"));

      assert.doesNotThrow(() => assertSnapshotPathContained(repoDir, "normal-alias/data.json"));
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// Group E: MEDIUM-04 POSIX backslash filename semantics
// ============================================================

describe("R2F3-R4: Group E - MEDIUM-04 POSIX Backslash Filename Semantics", () => {
  test("TEST E1: real filename '..\\input.env' snapshot inspection PASSES", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r4-bs-"));
    try {
      writeFileSync(join(repoDir, "..\\input.env"), "KEY=VALUE\n", "utf8");

      assert.doesNotThrow(() => assertSnapshotPathContained(repoDir, "..\\input.env"));

      const entry = inspectSnapshotEntry(repoDir, "..\\input.env");
      assert.equal(entry.entryType, "regular");
      assert.equal(entry.path, "..\\input.env");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("TEST E2: '..\\input.env' as valid ignored input declaration PASSES", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r4-bs-"));
    try {
      assert.doesNotThrow(() => validateIgnoredPathEntry("..\\input.env", repoDir, "TASK-1"));
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("TEST E3: '.git\\config' is a single POSIX filename and PASSES", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r4-bs-"));
    try {
      writeFileSync(join(repoDir, ".git\\config"), "not git directory\n", "utf8");

      assert.doesNotThrow(() => assertSnapshotPathContained(repoDir, ".git\\config"));
      const entry = inspectSnapshotEntry(repoDir, ".git\\config");
      assert.equal(entry.entryType, "regular");
      assert.equal(entry.path, ".git\\config");

      assert.doesNotThrow(() => validateIgnoredPathEntry(".git\\config", repoDir, "TASK-1"));
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("TEST E4: 'foo\\bar' filename PASSES", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r4-bs-"));
    try {
      writeFileSync(join(repoDir, "foo\\bar"), "foo backslash bar\n", "utf8");

      assert.doesNotThrow(() => assertSnapshotPathContained(repoDir, "foo\\bar"));
      const entry = inspectSnapshotEntry(repoDir, "foo\\bar");
      assert.equal(entry.entryType, "regular");
      assert.equal(entry.path, "foo\\bar");

      assert.doesNotThrow(() => validateIgnoredPathEntry("foo\\bar", repoDir, "TASK-1"));
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("TEST E5: true traversal '../outside' REJECTED", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r4-bs-"));
    try {
      assert.throws(
        () => assertSnapshotPathContained(repoDir, "../outside"),
        SymlinkEscapeError
      );

      assert.throws(
        () => validateIgnoredPathEntry("../outside", repoDir, "TASK-1"),
        ExecutionInputsValidationError
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("TEST E6: non-canonical 'foo/../bar' in ignored declaration REJECTED", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-r4-bs-"));
    try {
      assert.throws(
        () => validateIgnoredPathEntry("foo/../bar", repoDir, "TASK-1"),
        ExecutionInputsValidationError
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
