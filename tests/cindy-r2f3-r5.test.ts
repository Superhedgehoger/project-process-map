/**
 * CINDY-ORCH-MVP-R2F3-R5 Test Suite
 *
 * Covers all findings from PI_GPT6_R2F3_R4_REVIEW_FAIL:
 * - Matrix M1 (M1-01 to M1-10): M-R4-01 Path Identity & Reserved Namespace Bypass
 * - Matrix M2 (M2-01 to M2-09): M-R4-02 Publication Freshness & Tree Binding
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile, chmod } from "node:fs/promises";
import fs, { existsSync, symlinkSync, writeFileSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CindyOrchestrator,
  CindyState,
  RuntimeArtifactStore,
  ArtifactKind,
  inspectSnapshotEntry,
  assertSnapshotPathContained,
  validateCanonicalInputPath,
  computeTreeDigest,
  computeTreeDigestSync,
  TransitionRejectedError,
  DirtyTreeUnexplainedError,
  SymlinkEscapeError,
  FilesystemSnapshotError,
  ConflictingArtifactError,
} from "../tools/cindy/index.ts";

// ============================================================
// Helper: Create temporary Git repository for initialization tests
// ============================================================

async function createTestRepo(customTaskId = "TASK-R5"): Promise<{
  repoDir: string;
  bareDir: string;
  baseCommit: string;
  taskId: string;
  runId: string;
  cleanup: () => Promise<void>;
}> {
  const repoDir = await mkdtemp(join(tmpdir(), "cindy-r5-repo-"));
  const bareDir = await mkdtemp(join(tmpdir(), "cindy-r5-bare-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

  git(["init", "-b", "main"]);
  git(["config", "user.name", "Cindy R5 Test"]);
  git(["config", "user.email", "cindy-r5@example.com"]);

  await writeFile(
    join(repoDir, ".gitignore"),
    "node_modules/\n.agent/runtime/\n.agent/.cindy-init-staging/\n*.ignored\n*.env\n",
    "utf8"
  );
  await writeFile(join(repoDir, "README.md"), "# R5 Test Repo\n", "utf8");

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

  const runId = "run-r5-001";

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
// Matrix M1: M-R4-01 Path Identity & Reserved Namespace Bypass
// ============================================================

describe("R2F3-R5: Matrix M1 - M-R4-01 Path Identity & Reserved Namespace Bypass", () => {
  test("M1-01: missing/../.git/config -> REJECT, reserved file read: NO", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-m1-01-"));
    try {
      await mkdir(join(repoDir, ".git"), { recursive: true });
      await writeFile(join(repoDir, ".git", "config"), "[core]\nrepositoryformatversion = 0\n", "utf8");

      // Verify that inspectSnapshotEntry strictly rejects missing/../.git/config
      assert.throws(
        () => inspectSnapshotEntry(repoDir, "missing/../.git/config"),
        (err: unknown) => {
          assert(err instanceof SymlinkEscapeError || err instanceof FilesystemSnapshotError);
          assert.match((err as Error).message, /canonical POSIX form/i);
          return true;
        }
      );

      // Verify assertSnapshotPathContained also strictly rejects it
      assert.throws(
        () => assertSnapshotPathContained(repoDir, "missing/../.git/config"),
        (err: unknown) => {
          assert(err instanceof SymlinkEscapeError || err instanceof FilesystemSnapshotError);
          assert.match((err as Error).message, /canonical POSIX form/i);
          return true;
        }
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("M1-02: missing/../.agent/runtime/secret -> REJECT, reserved file read: NO", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-m1-02-"));
    try {
      await mkdir(join(repoDir, ".agent", "runtime"), { recursive: true });
      await writeFile(join(repoDir, ".agent", "runtime", "secret"), "SECRET_TOKEN\n", "utf8");

      assert.throws(
        () => inspectSnapshotEntry(repoDir, "missing/../.agent/runtime/secret"),
        (err: unknown) => {
          assert(err instanceof SymlinkEscapeError || err instanceof FilesystemSnapshotError);
          assert.match((err as Error).message, /canonical POSIX form/i);
          return true;
        }
      );

      assert.throws(
        () => assertSnapshotPathContained(repoDir, "missing/../.agent/runtime/secret"),
        (err: unknown) => {
          assert(err instanceof SymlinkEscapeError || err instanceof FilesystemSnapshotError);
          assert.match((err as Error).message, /canonical POSIX form/i);
          return true;
        }
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("M1-03: missing/../.agent/.cindy-init-staging/secret -> REJECT, reserved file read: NO", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-m1-03-"));
    try {
      await mkdir(join(repoDir, ".agent", ".cindy-init-staging"), { recursive: true });
      await writeFile(join(repoDir, ".agent", ".cindy-init-staging", "secret"), "STAGING_DATA\n", "utf8");

      assert.throws(
        () => inspectSnapshotEntry(repoDir, "missing/../.agent/.cindy-init-staging/secret"),
        (err: unknown) => {
          assert(err instanceof SymlinkEscapeError || err instanceof FilesystemSnapshotError);
          assert.match((err as Error).message, /canonical POSIX form/i);
          return true;
        }
      );

      assert.throws(
        () => assertSnapshotPathContained(repoDir, "missing/../.agent/.cindy-init-staging/secret"),
        (err: unknown) => {
          assert(err instanceof SymlinkEscapeError || err instanceof FilesystemSnapshotError);
          assert.match((err as Error).message, /canonical POSIX form/i);
          return true;
        }
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("M1-04: missing/../ordinary.txt -> canonical input validation reject without reading ordinary.txt", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-m1-04-"));
    try {
      await writeFile(join(repoDir, "ordinary.txt"), "regular content\n", "utf8");

      assert.throws(
        () => inspectSnapshotEntry(repoDir, "missing/../ordinary.txt"),
        (err: unknown) => {
          assert(err instanceof SymlinkEscapeError || err instanceof FilesystemSnapshotError);
          assert.match((err as Error).message, /canonical POSIX form/i);
          return true;
        }
      );

      assert.throws(
        () => assertSnapshotPathContained(repoDir, "missing/../ordinary.txt"),
        (err: unknown) => {
          assert(err instanceof SymlinkEscapeError || err instanceof FilesystemSnapshotError);
          assert.match((err as Error).message, /canonical POSIX form/i);
          return true;
        }
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("M1-05: canonical tracked deletion continues to be deterministically encoded as 'deleted'", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-m1-05-"));
    try {
      // 1. Terminal file does not exist
      const entry1 = inspectSnapshotEntry(repoDir, "deleted-file.txt", { allowMissing: true });
      assert.equal(entry1.entryType, "deleted");
      assert.equal(entry1.path, "deleted-file.txt");

      // 2. Ancestor directory does not exist
      const entry2 = inspectSnapshotEntry(repoDir, "nested/dir/deleted-file.txt", { allowMissing: true });
      assert.equal(entry2.entryType, "deleted");
      assert.equal(entry2.path, "nested/dir/deleted-file.txt");

      // 3. When allowMissing is false, throws File not found
      assert.throws(
        () => inspectSnapshotEntry(repoDir, "deleted-file.txt", { allowMissing: false }),
        (err: unknown) => {
          assert(err instanceof FilesystemSnapshotError);
          assert.match((err as Error).message, /File not found/i);
          return true;
        }
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("M1-06: broken internal symlink preserves raw target identity per contract", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-m1-06-"));
    try {
      symlinkSync("target-does-not-exist.txt", join(repoDir, "broken-link"));

      assert.doesNotThrow(() => assertSnapshotPathContained(repoDir, "broken-link"));

      const entry = inspectSnapshotEntry(repoDir, "broken-link");
      assert.equal(entry.entryType, "symlink");
      assert.equal((entry as any).target, "target-does-not-exist.txt");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("M1-07: legitimate internal symlink target with '..' resolves per POSIX component order", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-m1-07-"));
    try {
      await mkdir(join(repoDir, "subA"), { recursive: true });
      await mkdir(join(repoDir, "subB"), { recursive: true });
      await writeFile(join(repoDir, "subB", "target.txt"), "hello from B\n", "utf8");

      symlinkSync("../subB/target.txt", join(repoDir, "subA", "link-to-b"));

      assert.doesNotThrow(() => assertSnapshotPathContained(repoDir, "subA/link-to-b"));

      const entry = inspectSnapshotEntry(repoDir, "subA/link-to-b");
      assert.equal(entry.entryType, "symlink");
      assert.equal((entry as any).target, "../subB/target.txt");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("M1-08: symlink escape and re-entry via '..' remains strictly REJECTED", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-m1-08-"));
    try {
      // Symlink attempts to escape repo and re-enter
      symlinkSync("../../" + repoDir.slice(1) + "/safe.txt", join(repoDir, "escape-reenter"));

      assert.throws(
        () => assertSnapshotPathContained(repoDir, "escape-reenter"),
        (err: unknown) => {
          assert(err instanceof SymlinkEscapeError);
          assert.match((err as Error).message, /escapes repository root/i);
          return true;
        }
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("M1-09: real POSIX filenames with backslash pass correctly ('..\\input.env', '.git\\config', 'foo\\bar')", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-m1-09-"));
    try {
      // In POSIX, backslash is an ordinary character in a single component filename
      const names = ["..\\input.env", ".git\\config", "foo\\bar"];
      for (const name of names) {
        writeFileSync(join(repoDir, name), `content of ${name}\n`, "utf8");
        assert.doesNotThrow(() => validateCanonicalInputPath(name));
        assert.doesNotThrow(() => assertSnapshotPathContained(repoDir, name));
        const entry = inspectSnapshotEntry(repoDir, name);
        assert.equal(entry.entryType, "regular");
        assert.equal(entry.path, name);
      }
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("M1-10: instrument filesystem calls to verify ZERO lstat/readlink/readFile on reserved namespaces during bypass rejection", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-m1-10-"));
    try {
      await mkdir(join(repoDir, ".git"), { recursive: true });
      await writeFile(join(repoDir, ".git", "config"), "[core]\n", "utf8");
      await mkdir(join(repoDir, ".agent", "runtime"), { recursive: true });
      await writeFile(join(repoDir, ".agent", "runtime", "secret"), "SECRET\n", "utf8");
      await mkdir(join(repoDir, ".agent", ".cindy-init-staging"), { recursive: true });
      await writeFile(join(repoDir, ".agent", ".cindy-init-staging", "secret"), "SECRET\n", "utf8");

      let reservedLstat = 0;
      let reservedReadlink = 0;
      let reservedReadFile = 0;

      const isReserved = (p: string) =>
        p.includes(".git/config") ||
        p.includes(".agent/runtime/secret") ||
        p.includes(".agent/.cindy-init-staging/secret");

      const origLstat = fs.lstatSync;
      const origReadlink = fs.readlinkSync;
      const origReadFile = fs.readFileSync;

      (fs as any).lstatSync = ((p: fs.PathLike, opts?: any) => {
        if (isReserved(String(p))) reservedLstat++;
        return origLstat(p, opts);
      }) as any;

      (fs as any).readlinkSync = ((p: fs.PathLike, opts?: any) => {
        if (isReserved(String(p))) reservedReadlink++;
        return origReadlink(p, opts);
      }) as any;

      (fs as any).readFileSync = ((p: fs.PathLike, opts?: any) => {
        if (isReserved(String(p))) reservedReadFile++;
        return origReadFile(p, opts);
      }) as any;

      try {
        const bypassProbes = [
          "missing/../.git/config",
          "missing/../.agent/runtime/secret",
          "missing/../.agent/.cindy-init-staging/secret",
        ];

        for (const probe of bypassProbes) {
          assert.throws(
            () => inspectSnapshotEntry(repoDir, probe),
            /canonical POSIX form/i
          );
        }

        assert.equal(reservedLstat, 0, "Expected ZERO lstat calls on reserved namespace children");
        assert.equal(reservedReadlink, 0, "Expected ZERO readlink calls on reserved namespace children");
        assert.equal(reservedReadFile, 0, "Expected ZERO readFile calls on reserved namespace children");
      } finally {
        (fs as any).lstatSync = origLstat;
        (fs as any).readlinkSync = origReadlink;
        (fs as any).readFileSync = origReadFile;
      }
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// Matrix M2: M-R4-02 Publication Freshness & Tree Binding
// ============================================================

describe("R2F3-R5: Matrix M2 - M-R4-02 Publication Freshness & Tree Binding", () => {
  test("M2-01: healthy clean tree -> staged digest equals live digest -> init PASS", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const store = new RuntimeArtifactStore({ repoDir });
      const run = await store.initializeRunSafely({ runId, taskId });

      assert.equal(run.state, CindyState.TASK_INITIALIZED);
      assert.equal(run.runId, runId);

      const liveTreeDigest = computeTreeDigestSync(repoDir);
      assert.equal(run.boundTreeDigest, liveTreeDigest);

      const baseline = await store.readArtifact<any>(runId, ArtifactKind.BASELINE);
      assert.equal(baseline.initialTreeClean, true);
      assert.equal(baseline.initialTreeDigest, liveTreeDigest);
    } finally {
      await env.cleanup();
    }
  });

  test("M2-02: allowed-scope file modified during preparation window -> final tree digest changes -> init REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const store = new RuntimeArtifactStore({ repoDir });

      // Hook right before final validation fence: mutate an allowed-scope file
      (store as any).onBeforeFinalValidationFence = async () => {
        await mkdir(join(repoDir, "src"), { recursive: true });
        await writeFile(join(repoDir, "src", "late-change.ts"), "// late modified", "utf8");
      };

      await assert.rejects(
        () => store.initializeRunSafely({ runId, taskId }),
        (err: unknown) => {
          assert(err instanceof TransitionRejectedError);
          assert.match((err as Error).message, /clean state changed|STALE_TREE_BINDING/i);
          return true;
        }
      );

      // Verify run was not published
      assert.ok(!existsSync(join(repoDir, ".agent", "runtime", runId)));
    } finally {
      await env.cleanup();
    }
  });

  test("M2-03: allowed-scope file modified at staging-directory close() barrier -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const store = new RuntimeArtifactStore({ repoDir });

      let barrierTriggered = false;
      (store as any).onAfterStagingClose = async () => {
        barrierTriggered = true;
        await mkdir(join(repoDir, "src"), { recursive: true });
        await writeFile(join(repoDir, "src", "barrier-change.ts"), "// modified at close barrier", "utf8");
      };

      await assert.rejects(
        () => store.initializeRunSafely({ runId, taskId }),
        (err: unknown) => {
          assert(err instanceof TransitionRejectedError);
          assert.match((err as Error).message, /clean state changed|STALE_TREE_BINDING/i);
          return true;
        }
      );

      assert.ok(barrierTriggered, "Staging close barrier must have triggered");
      assert.ok(!existsSync(join(repoDir, ".agent", "runtime", runId)));
    } finally {
      await env.cleanup();
    }
  });

  test("M2-04: README.md index-only modification during preparation -> rejected by dirty ownership", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      const store = new RuntimeArtifactStore({ repoDir });

      (store as any).onBeforeFinalValidationFence = async () => {
        // Stage a change to README.md (index only, outside allowedScope)
        await writeFile(join(repoDir, "README.md"), "# Staged change\n", "utf8");
        git(["add", "README.md"]);
        // Restore working tree file so working tree looks like original commit, but index is dirty
        await writeFile(join(repoDir, "README.md"), "# R5 Test Repo\n", "utf8");
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

      assert.ok(!existsSync(join(repoDir, ".agent", "runtime", runId)));
    } finally {
      await env.cleanup();
    }
  });

  test("M2-05: outside-scope untracked modification during preparation -> REJECT", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const store = new RuntimeArtifactStore({ repoDir });

      (store as any).onBeforeFinalValidationFence = async () => {
        await writeFile(join(repoDir, "outside-untracked.txt"), "outside scope file\n", "utf8");
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

      assert.ok(!existsSync(join(repoDir, ".agent", "runtime", runId)));
    } finally {
      await env.cleanup();
    }
  });

  test("M2-06: initially legally dirty allowed-scope control works normally per frozen R2F2 contract", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;

      // Create an allowed-scope dirty file BEFORE initialization starts
      await mkdir(join(repoDir, "src"), { recursive: true });
      await writeFile(join(repoDir, "src", "pre-existing.ts"), "// pre-existing dirty file", "utf8");

      const store = new RuntimeArtifactStore({ repoDir });
      const run = await store.initializeRunSafely({ runId, taskId });

      assert.equal(run.state, CindyState.TASK_INITIALIZED);
      assert.ok(existsSync(join(repoDir, ".agent", "runtime", runId)));

      const baseline = await store.readArtifact<any>(runId, ArtifactKind.BASELINE);
      assert.equal(baseline.initialTreeClean, false);
      assert.equal(run.boundTreeDigest, computeTreeDigestSync(repoDir));
    } finally {
      await env.cleanup();
    }
  });

  test("M2-07: after late change rejection, run final dir is ABSENT, current pointer unpromoted, no half bundle, no lock residue", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const store = new RuntimeArtifactStore({ repoDir });

      (store as any).onBeforeFinalValidationFence = async () => {
        await mkdir(join(repoDir, "src"), { recursive: true });
        await writeFile(join(repoDir, "src", "late-change.ts"), "// late modified", "utf8");
      };

      await assert.rejects(() => store.initializeRunSafely({ runId, taskId }));

      // Invariants check:
      // 1. Run final directory is ABSENT
      const finalDir = join(repoDir, ".agent", "runtime", runId);
      assert.ok(!existsSync(finalDir), "Final run directory must NOT exist");

      // 2. Current pointer is unpromoted / absent
      const currentPointer = join(repoDir, ".agent", "runtime", "current.json");
      assert.ok(!existsSync(currentPointer), "Current pointer must NOT exist");

      // 3. Staging directory has no orphaned run bundle
      const stagingDir = join(repoDir, ".agent", ".cindy-init-staging");
      if (existsSync(stagingDir)) {
        const stagingEntries = fs.readdirSync(stagingDir);
        const relatedStaged = stagingEntries.filter((e) => e.startsWith(runId));
        assert.equal(relatedStaged.length, 0, "No orphaned staging directories for runId");
      }

      // 4. Init lock residue is ABSENT
      const initLock = join(repoDir, ".agent", ".cindy-init.lock");
      assert.ok(!existsSync(initLock), "Init lock residue must NOT exist");
    } finally {
      await env.cleanup();
    }
  });

  test("M2-08: healthy initialization success -> independent recomputation matches published boundTreeDigest", async () => {
    const env = await createTestRepo();
    try {
      const { repoDir, taskId, runId } = env;
      const store = new RuntimeArtifactStore({ repoDir });
      const run = await store.initializeRunSafely({ runId, taskId });

      // Independently compute fresh tree digest using both sync and async functions
      const freshSyncDigest = computeTreeDigestSync(repoDir);
      const freshAsyncDigest = await computeTreeDigest(repoDir);

      assert.equal(freshSyncDigest, freshAsyncDigest);
      assert.equal(run.boundTreeDigest, freshSyncDigest);

      const publishedRun = await store.getRun(runId);
      assert.equal(publishedRun.boundTreeDigest, freshSyncDigest);
    } finally {
      await env.cleanup();
    }
  });

  test("M2-09: computeTreeDigestSync matches async computeTreeDigest on regular content, executable mode, and symlinks", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cindy-m2-09-"));
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    try {
      git(["init", "-b", "main"]);
      git(["config", "user.name", "Sync Digest Test"]);
      git(["config", "user.email", "sync-test@example.com"]);

      // 1. Regular file
      await writeFile(join(repoDir, "regular.txt"), "hello world\n", "utf8");

      // 2. Executable file
      await writeFile(join(repoDir, "script.sh"), "#!/bin/sh\necho hi\n", "utf8");
      await chmod(join(repoDir, "script.sh"), 0o755);

      // 3. Symlink
      symlinkSync("regular.txt", join(repoDir, "symlink-regular"));

      git(["add", "."]);
      git(["commit", "-m", "chore: setup files"]);

      // Test with clean tree
      const cleanSync = computeTreeDigestSync(repoDir);
      const cleanAsync = await computeTreeDigest(repoDir);
      assert.equal(cleanSync, cleanAsync, "Sync and async digests must match on clean tree");

      // Test with working tree modifications (both regular and executable)
      await writeFile(join(repoDir, "regular.txt"), "modified content\n", "utf8");
      await chmod(join(repoDir, "script.sh"), 0o644); // remove executable bit

      const dirtySync = computeTreeDigestSync(repoDir);
      const dirtyAsync = await computeTreeDigest(repoDir);
      assert.equal(dirtySync, dirtyAsync, "Sync and async digests must match on modified tree");
      assert.notEqual(dirtySync, cleanSync, "Digest must reflect file content and mode changes");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
