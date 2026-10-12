import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { createServer } from "node:net";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  CINDY_EXECUTION_SNAPSHOT_V1,
  CINDY_EXECUTION_INPUTS_V1,
  type ExecutionSnapshotManifest,
  computeExecutionSnapshot,
  computeAuthoritativeExecutionSnapshot,
  canonicalizeSnapshotManifest,
  inspectSnapshotEntry,
  SymlinkEscapeError,
  UnsupportedFileTypeSnapshotError,
  FilesystemSnapshotError,
  ExecutionInputsValidationError,
  ArtifactDigestMismatchError,
  ArtifactValidationError,
  ArtifactKind,
  validateStrictCommitSha,
  readCommittedFileAtCommit,
  getTrackedFilesAtCommit,
  validateArtifactBoundary,
  loadArtifactSchema,
  validateIgnoredPathEntry,
} from "../tools/cindy/index.ts";
import { CindyOrchestrator } from "../tools/cindy/orchestrator.ts";

function setupBareGitRepo(): { repo: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cindy-test-git-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Cindy Test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "cindy@test.local"], { cwd: dir });

  writeFileSync(join(dir, "README.md"), "# Initial\n");
  writeFileSync(
    join(dir, ".gitignore"),
    ".agent/runtime/\n.agent/.cindy-init-staging/\nnode_modules/\n.cache/\n*.env\n*.log\n*.key\n*.secret\n*.ignored\n"
  );
  execFileSync("git", ["add", "README.md", ".gitignore"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });

  return {
    repo: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function setupCindyRepo(
  taskId: string = "P0-05A",
  options: { ignoredPaths?: string[] } = {}
) {
  const repo = mkdtempSync(join(tmpdir(), "cindy-test-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Cindy Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "cindy@test.local"], { cwd: repo });

  writeFileSync(join(repo, "README.md"), "# Test Repo\n");
  writeFileSync(
    join(repo, ".gitignore"),
    ".agent/runtime/\n.agent/.cindy-init-staging/\nnode_modules/\n.cache/\n*.env\n*.log\n*.key\n*.secret\n*.ignored\n"
  );
  execFileSync("git", ["add", "README.md", ".gitignore"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo });

  const bareDir = mkdtempSync(join(tmpdir(), "cindy-test-bare-"));
  execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: bareDir });
  execFileSync("git", ["remote", "add", "origin", bareDir], { cwd: repo });
  execFileSync("git", ["push", "-u", "-q", "origin", "main"], { cwd: repo });

  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  mkdirSync(join(repo, ".agent", "tasks", taskId), { recursive: true });
  const taskPacket = {
    taskId,
    status: "READY",
    branch: "main",
    baseCommit,
    allowedScope: ["src/"],
  };
  writeFileSync(join(repo, ".agent", "tasks", taskId, "task.json"), JSON.stringify(taskPacket, null, 2));

  if (options.ignoredPaths !== undefined) {
    const declPath = join(repo, ".agent", "tasks", taskId, "execution-inputs.json");
    writeFileSync(
      declPath,
      JSON.stringify(
        {
          version: "CINDY_EXECUTION_INPUTS_V1",
          taskId,
          ignoredPaths: options.ignoredPaths,
        },
        null,
        2
      )
    );
  }

  execFileSync("git", ["add", ".agent/tasks"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "add task packet and execution inputs"], { cwd: repo });
  execFileSync("git", ["push", "-q"], { cwd: repo });

  const runId = "RUN_01JTEST000000000000000000";
  return {
    repo,
    bareDir,
    taskId,
    runId,
    baseCommit,
    cleanup: () => {
      rmSync(repo, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
    },
  };
}

function commitExecutionInputs(repo: string, taskId: string, ignoredPaths: string[]) {
  const declPath = join(repo, ".agent", "tasks", taskId, "execution-inputs.json");
  mkdirSync(dirname(declPath), { recursive: true });
  writeFileSync(
    declPath,
    JSON.stringify(
      {
        version: "CINDY_EXECUTION_INPUTS_V1",
        taskId,
        ignoredPaths,
      },
      null,
      2
    )
  );
  execFileSync("git", ["add", declPath], { cwd: repo });
  execFileSync("git", ["commit", "-m", "commit execution inputs"], { cwd: repo });
  execFileSync("git", ["push", "-q"], { cwd: repo });
}

describe("CINDY_EXECUTION_SNAPSHOT_V1 — R2-05 Entry Identity & Collision Safety", () => {
  it("A. regular file: content change alters snapshot digest", async () => {
    const { repo, cleanup } = setupBareGitRepo();
    try {
      writeFileSync(join(repo, "file.txt"), "version 1\n");
      const snap1 = await computeExecutionSnapshot(repo);

      writeFileSync(join(repo, "file.txt"), "version 2\n");
      const snap2 = await computeExecutionSnapshot(repo);

      assert.notEqual(snap1.digest, snap2.digest);
    } finally {
      cleanup();
    }
  });

  it("B. regular file: chmod +x / -x alters snapshot digest", async () => {
    const { repo, cleanup } = setupBareGitRepo();
    try {
      const scriptPath = join(repo, "run.sh");
      writeFileSync(scriptPath, "#!/bin/sh\necho hi\n");
      chmodSync(scriptPath, 0o644);
      const snap1 = await computeExecutionSnapshot(repo);

      chmodSync(scriptPath, 0o755);
      const snap2 = await computeExecutionSnapshot(repo);

      assert.notEqual(snap1.digest, snap2.digest);
    } finally {
      cleanup();
    }
  });

  it("C. entry type change: regular file to symlink alters snapshot digest", async () => {
    const { repo, cleanup } = setupBareGitRepo();
    try {
      writeFileSync(join(repo, "target.txt"), "same content\n");
      execFileSync("git", ["add", "target.txt"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "add target"], { cwd: repo });

      writeFileSync(join(repo, "probe.txt"), "same content\n");
      const snapRegular = await computeExecutionSnapshot(repo);

      rmSync(join(repo, "probe.txt"));
      execFileSync("ln", ["-s", "target.txt", join(repo, "probe.txt")]);
      const snapSymlink = await computeExecutionSnapshot(repo);

      assert.notEqual(snapRegular.digest, snapSymlink.digest);
    } finally {
      cleanup();
    }
  });

  it("D. entry type change: symlink to regular file alters snapshot digest (reverse transition)", async () => {
    const { repo, cleanup } = setupBareGitRepo();
    try {
      writeFileSync(join(repo, "target.txt"), "target data\n");
      execFileSync("git", ["add", "target.txt"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "add target"], { cwd: repo });

      execFileSync("ln", ["-s", "target.txt", join(repo, "link.txt")]);
      const snapSymlink = await computeExecutionSnapshot(repo);

      rmSync(join(repo, "link.txt"));
      writeFileSync(join(repo, "link.txt"), "target data\n");
      const snapRegular = await computeExecutionSnapshot(repo);

      assert.notEqual(snapSymlink.digest, snapRegular.digest);
    } finally {
      cleanup();
    }
  });

  it("E. symlink: retargeting from ./a to ./b with identical target contents alters snapshot digest", async () => {
    const { repo, cleanup } = setupBareGitRepo();
    try {
      writeFileSync(join(repo, "a.txt"), "identical content\n");
      writeFileSync(join(repo, "b.txt"), "identical content\n");
      execFileSync("git", ["add", "a.txt", "b.txt"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "add targets"], { cwd: repo });

      execFileSync("ln", ["-s", "a.txt", join(repo, "link.txt")]);
      const snapA = await computeExecutionSnapshot(repo);

      rmSync(join(repo, "link.txt"));
      execFileSync("ln", ["-s", "b.txt", join(repo, "link.txt")]);
      const snapB = await computeExecutionSnapshot(repo);

      assert.notEqual(snapA.digest, snapB.digest);
    } finally {
      cleanup();
    }
  });

  it("F. internal symlink target string is explicitly asserted in manifest", async () => {
    const { repo, cleanup } = setupBareGitRepo();
    try {
      writeFileSync(join(repo, "target.txt"), "target data\n");
      execFileSync("git", ["add", "target.txt"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "add target"], { cwd: repo });

      execFileSync("ln", ["-s", "target.txt", join(repo, "link.txt")]);
      const snap = await computeExecutionSnapshot(repo);

      const linkEntry = snap.manifest.entries.find((e) => e.path === "link.txt");
      assert(linkEntry);
      assert.equal(linkEntry.entryType, "symlink");
      if (linkEntry.entryType === "symlink") {
        assert.equal(linkEntry.target, "target.txt");
      }
    } finally {
      cleanup();
    }
  });

  it("G. static symlink escape: target escaping repo root fails closed with SymlinkEscapeError", async () => {
    const { repo, cleanup } = setupBareGitRepo();
    try {
      execFileSync("ln", ["-s", "../../outside-secret", join(repo, "escape.txt")]);

      await assert.rejects(
        async () => {
          await computeExecutionSnapshot(repo);
        },
        (err: unknown) => {
          assert(err instanceof SymlinkEscapeError);
          assert.match((err as Error).message, /escapes repository root/);
          return true;
        }
      );
    } finally {
      cleanup();
    }
  });

  it("H. broken symlink: target within repo that does not exist binds target string without error", async () => {
    const { repo, cleanup } = setupBareGitRepo();
    try {
      execFileSync("ln", ["-s", "does-not-exist.txt", join(repo, "broken.txt")]);
      const snap = await computeExecutionSnapshot(repo);

      const entry = snap.manifest.entries.find((e) => e.path === "broken.txt");
      assert(entry);
      assert.equal(entry.entryType, "symlink");
      if (entry.entryType === "symlink") {
        assert.equal(entry.target, "does-not-exist.txt");
      }
    } finally {
      cleanup();
    }
  });

  it("I. unsupported file type: FIFO fails closed with UnsupportedFileTypeSnapshotError", async () => {
    const { repo, cleanup } = setupBareGitRepo();
    try {
      const fifoPath = join(repo, "test.fifo");
      execFileSync("mkfifo", [fifoPath]);

      await assert.rejects(
        async () => {
          await computeExecutionSnapshot(repo, { declaredIgnoredInputs: ["test.fifo"] });
        },
        (err: unknown) => {
          assert(err instanceof UnsupportedFileTypeSnapshotError);
          assert.match((err as Error).message, /Unsupported special file type/);
          return true;
        }
      );
    } finally {
      cleanup();
    }
  });

  it("J. unsupported file type: socket fails closed with UnsupportedFileTypeSnapshotError", async () => {
    const { repo, cleanup } = setupBareGitRepo();
    const sockPath = join(repo, "test.sock");
    const server = createServer();
    try {
      await new Promise<void>((res) => server.listen(sockPath, () => res()));

      await assert.rejects(
        async () => {
          await computeExecutionSnapshot(repo, { declaredIgnoredInputs: ["test.sock"] });
        },
        (err: unknown) => {
          assert(err instanceof UnsupportedFileTypeSnapshotError);
          assert.match((err as Error).message, /Unsupported special file type/);
          return true;
        }
      );
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
      cleanup();
    }
  });

  it("K. directory: bare directory declared as snapshot entry fails closed", async () => {
    const { repo, cleanup } = setupBareGitRepo();
    try {
      mkdirSync(join(repo, "somedir"));
      await assert.rejects(
        async () => {
          inspectSnapshotEntry(repo, "somedir");
        },
        (err: unknown) => {
          assert(err instanceof UnsupportedFileTypeSnapshotError);
          assert.match((err as Error).message, /Directory path 'somedir' cannot be hashed/);
          return true;
        }
      );
    } finally {
      cleanup();
    }
  });

  it("L. raw POSIX path semantics: filenames with leading/trailing spaces, newlines, tabs, backslashes", async () => {
    const { repo, cleanup } = setupBareGitRepo();
    try {
      const names = [
        " leading.txt",
        "trailing.txt ",
        "line1\nline2.txt",
        "col1\tcol2.txt",
        "path\\with\\backslash.txt",
      ];
      for (const name of names) {
        writeFileSync(join(repo, name), `content of ${JSON.stringify(name)}\n`);
      }

      const snap = await computeExecutionSnapshot(repo);
      for (const name of names) {
        const found = snap.manifest.entries.find((e) => e.path === name);
        assert(found, `Expected entry for '${JSON.stringify(name)}' in snapshot`);
        assert.equal(found.entryType, "regular");
      }

      const canonicalStr = canonicalizeSnapshotManifest(snap.manifest);
      assert(canonicalStr.includes("\\n"));
      assert(canonicalStr.includes("\\t"));
      assert(canonicalStr.includes("\\\\"));
    } finally {
      cleanup();
    }
  });

  it("M. deterministic bytewise entry sorting in manifest serialization", () => {
    const manifest: ExecutionSnapshotManifest = {
      version: CINDY_EXECUTION_SNAPSHOT_V1,
      headCommit: "0".repeat(40),
      entries: [
        { path: "z.txt", entryType: "regular" as const, contentSha256: "1", executable: false },
        { path: "a.txt", entryType: "regular" as const, contentSha256: "2", executable: false },
        { path: "A.txt", entryType: "regular" as const, contentSha256: "3", executable: false },
        { path: " leading.txt", entryType: "regular" as const, contentSha256: "4", executable: false },
      ],
    };

    const serialized = canonicalizeSnapshotManifest(manifest);
    const parsed = JSON.parse(serialized);
    const paths = parsed.entries.map((e: { path: string }) => e.path);

    // ASCII byte order: space (0x20) < 'A' (0x41) < 'a' (0x61) < 'z' (0x7a)
    assert.deepEqual(paths, [" leading.txt", "A.txt", "a.txt", "z.txt"]);
  });

  it("N. filesystem failure probes: lstat and regular file read failures fail closed", async () => {
    const { repo, cleanup } = setupBareGitRepo();
    try {
      // 1. Regular file read failure
      const unreadableFile = join(repo, "unreadable.txt");
      writeFileSync(unreadableFile, "secret");
      chmodSync(unreadableFile, 0o000);

      assert.throws(
        () => inspectSnapshotEntry(repo, "unreadable.txt"),
        (err: unknown) => {
          assert(err instanceof FilesystemSnapshotError);
          assert.match((err as Error).message, /Failed to read file/);
          return true;
        }
      );
      chmodSync(unreadableFile, 0o644);

      // 2. lstat failure via unsearchable directory
      const unsearchableDir = join(repo, "unsearchable");
      mkdirSync(unsearchableDir);
      const child = join(unsearchableDir, "child.txt");
      writeFileSync(child, "data");
      chmodSync(unsearchableDir, 0o000);

      assert.throws(
        () => inspectSnapshotEntry(repo, "unsearchable/child.txt"),
        (err: unknown) => {
          assert(err instanceof FilesystemSnapshotError);
          assert.match((err as Error).message, /Failed to lstat/);
          return true;
        }
      );
      chmodSync(unsearchableDir, 0o755);
    } finally {
      cleanup();
    }
  });
});

describe("CINDY_EXECUTION_INPUTS_V1 — R2-11 Explicit Ignored Inputs Matrix (20 points)", () => {
  it("1. committed declaration absent -> authoritative set = []", async () => {
    const { repo, taskId, cleanup } = setupCindyRepo();
    try {
      const snap = await computeAuthoritativeExecutionSnapshot(repo, taskId);
      assert.equal(snap.manifest.ignoredInputDeclaration?.source, "ABSENT_EMPTY");
      assert.equal(snap.manifest.ignoredInputDeclaration?.contentSha256, null);
      assert.equal(snap.manifest.ignoredInputDeclaration?.version, CINDY_EXECUTION_INPUTS_V1);
    } finally {
      cleanup();
    }
  });

  it("2. working-tree-only execution-inputs.json but absent in HEAD -> cannot take effect", async () => {
    const { repo, taskId, cleanup } = setupCindyRepo();
    try {
      const declPath = join(repo, ".agent", "tasks", taskId, "execution-inputs.json");
      writeFileSync(
        declPath,
        JSON.stringify({
          version: "CINDY_EXECUTION_INPUTS_V1",
          taskId,
          ignoredPaths: ["local-secret.env"],
        })
      );
      // local-secret.env is matched by *.env in .gitignore
      writeFileSync(join(repo, "local-secret.env"), "KEY=123\n");

      const snap = await computeAuthoritativeExecutionSnapshot(repo, taskId);
      // Working tree file must be ignored by authoritative snapshot!
      assert.equal(snap.manifest.ignoredInputDeclaration?.source, "ABSENT_EMPTY");
      const found = snap.manifest.entries.find((e) => e.path === "local-secret.env");
      assert.equal(found, undefined);
    } finally {
      cleanup();
    }
  });

  it("3. committed declaration in HEAD -> takes effect and binds into snapshot", async () => {
    const { repo, taskId, cleanup } = setupCindyRepo("P0-05A", {
      ignoredPaths: ["config.local.json"],
    });
    try {
      writeFileSync(join(repo, "config.local.json"), "{\"env\":\"dev\"}\n");

      const snap = await computeAuthoritativeExecutionSnapshot(repo, taskId);
      assert.equal(snap.manifest.ignoredInputDeclaration?.source, "COMMITTED_TASK_SCOPED_FILE");
      assert(snap.manifest.ignoredInputDeclaration?.contentSha256);
      const found = snap.manifest.entries.find((e) => e.path === "config.local.json");
      assert(found);
      assert.equal(found.entryType, "regular");
    } finally {
      cleanup();
    }
  });

  it("4. working-tree modified declaration uncommitted -> trusted declaration still from HEAD", async () => {
    const { repo, taskId, cleanup } = setupCindyRepo("P0-05A", {
      ignoredPaths: ["committed.ignored"],
    });
    try {
      writeFileSync(join(repo, "committed.ignored"), "hello\n");

      // Mutate working tree declaration uncommitted
      const declPath = join(repo, ".agent", "tasks", taskId, "execution-inputs.json");
      writeFileSync(
        declPath,
        JSON.stringify({
          version: "CINDY_EXECUTION_INPUTS_V1",
          taskId,
          ignoredPaths: ["forged.ignored"],
        })
      );
      writeFileSync(join(repo, "forged.ignored"), "forged\n");

      const snap = await computeAuthoritativeExecutionSnapshot(repo, taskId);
      assert(snap.manifest.entries.find((e) => e.path === "committed.ignored"));
      assert.equal(snap.manifest.entries.find((e) => e.path === "forged.ignored"), undefined);
    } finally {
      cleanup();
    }
  });

  it("5. declaration.taskId mismatch -> reject", async () => {
    const { repo, taskId, cleanup } = setupCindyRepo();
    try {
      const declPath = join(repo, ".agent", "tasks", taskId, "execution-inputs.json");
      writeFileSync(
        declPath,
        JSON.stringify({
          version: "CINDY_EXECUTION_INPUTS_V1",
          taskId: "ANOTHER_TASK_ID",
          ignoredPaths: [],
        })
      );
      execFileSync("git", ["add", declPath], { cwd: repo });
      execFileSync("git", ["commit", "-m", "mismatch taskId"], { cwd: repo });

      await assert.rejects(
        async () => {
          await computeAuthoritativeExecutionSnapshot(repo, taskId);
        },
        (err: unknown) => {
          assert(err instanceof ExecutionInputsValidationError);
          assert.match((err as Error).message, /taskId mismatch/);
          return true;
        }
      );
    } finally {
      cleanup();
    }
  });

  it("6. wrong version -> reject", async () => {
    const { repo, taskId, cleanup } = setupCindyRepo();
    try {
      const declPath = join(repo, ".agent", "tasks", taskId, "execution-inputs.json");
      writeFileSync(
        declPath,
        JSON.stringify({
          version: "WRONG_VERSION_V2",
          taskId,
          ignoredPaths: [],
        })
      );
      execFileSync("git", ["add", declPath], { cwd: repo });
      execFileSync("git", ["commit", "-m", "wrong version"], { cwd: repo });

      await assert.rejects(
        async () => {
          await computeAuthoritativeExecutionSnapshot(repo, taskId);
        },
        (err: unknown) => {
          assert(err instanceof ExecutionInputsValidationError);
          assert.match((err as Error).message, /version/);
          return true;
        }
      );
    } finally {
      cleanup();
    }
  });

  it("7. additional property -> reject", async () => {
    const { repo, taskId, cleanup } = setupCindyRepo();
    try {
      const declPath = join(repo, ".agent", "tasks", taskId, "execution-inputs.json");
      writeFileSync(
        declPath,
        JSON.stringify({
          version: "CINDY_EXECUTION_INPUTS_V1",
          taskId,
          ignoredPaths: [],
          unsupportedExtra: true,
        })
      );
      execFileSync("git", ["add", declPath], { cwd: repo });
      execFileSync("git", ["commit", "-m", "additional property"], { cwd: repo });

      await assert.rejects(
        async () => {
          await computeAuthoritativeExecutionSnapshot(repo, taskId);
        },
        (err: unknown) => {
          assert(err instanceof ExecutionInputsValidationError);
          assert.match((err as Error).message, /unexpected additional property/);
          return true;
        }
      );
    } finally {
      cleanup();
    }
  });

  it("8. absolute path -> reject", async () => {
    const { repo, taskId, cleanup } = setupCindyRepo();
    try {
      commitExecutionInputs(repo, taskId, ["/etc/passwd"]);
      await assert.rejects(
        async () => {
          await computeAuthoritativeExecutionSnapshot(repo, taskId);
        },
        (err: unknown) => {
          assert(err instanceof ExecutionInputsValidationError);
          assert.match((err as Error).message, /cannot be absolute/);
          return true;
        }
      );
    } finally {
      cleanup();
    }
  });

  it("9. traversal escape -> reject", async () => {
    const { repo, taskId, cleanup } = setupCindyRepo();
    try {
      commitExecutionInputs(repo, taskId, ["../outside.txt"]);
      await assert.rejects(
        async () => {
          await computeAuthoritativeExecutionSnapshot(repo, taskId);
        },
        (err: unknown) => {
          assert(err instanceof ExecutionInputsValidationError);
          assert.match((err as Error).message, /escapes repository root/);
          return true;
        }
      );
    } finally {
      cleanup();
    }
  });

  it("10. .git path -> reject", async () => {
    const { repo, taskId, cleanup } = setupCindyRepo();
    try {
      commitExecutionInputs(repo, taskId, [".git/config"]);
      await assert.rejects(
        async () => {
          await computeAuthoritativeExecutionSnapshot(repo, taskId);
        },
        (err: unknown) => {
          assert(err instanceof ExecutionInputsValidationError);
          assert.match((err as Error).message, /Reserved or authority path/);
          return true;
        }
      );
    } finally {
      cleanup();
    }
  });

  it("11. .agent/runtime path -> reject", async () => {
    const { repo, taskId, cleanup } = setupCindyRepo();
    try {
      commitExecutionInputs(repo, taskId, [".agent/runtime/run.json"]);
      await assert.rejects(
        async () => {
          await computeAuthoritativeExecutionSnapshot(repo, taskId);
        },
        (err: unknown) => {
          assert(err instanceof ExecutionInputsValidationError);
          assert.match((err as Error).message, /Reserved or authority path/);
          return true;
        }
      );
    } finally {
      cleanup();
    }
  });

  it("12. staging path -> reject", async () => {
    const { repo, taskId, cleanup } = setupCindyRepo();
    try {
      commitExecutionInputs(repo, taskId, [".agent/.cindy-init-staging/test"]);
      await assert.rejects(
        async () => {
          await computeAuthoritativeExecutionSnapshot(repo, taskId);
        },
        (err: unknown) => {
          assert(err instanceof ExecutionInputsValidationError);
          assert.match((err as Error).message, /Reserved or authority path/);
          return true;
        }
      );
    } finally {
      cleanup();
    }
  });

  it("13. declared ignored regular file content change -> snapshot changes", async () => {
    const { repo, taskId, cleanup } = setupCindyRepo("P0-05A", { ignoredPaths: ["local.env"] });
    try {
      writeFileSync(join(repo, "local.env"), "V=1\n");
      const snap1 = await computeAuthoritativeExecutionSnapshot(repo, taskId);

      writeFileSync(join(repo, "local.env"), "V=2\n");
      const snap2 = await computeAuthoritativeExecutionSnapshot(repo, taskId);

      assert.notEqual(snap1.digest, snap2.digest);
    } finally {
      cleanup();
    }
  });

  it("14. regular <-> symlink -> snapshot changes", async () => {
    const { repo, taskId, cleanup } = setupCindyRepo("P0-05A", { ignoredPaths: ["tool.bin"] });
    try {
      writeFileSync(join(repo, "target.bin"), "bin-data\n");
      execFileSync("git", ["add", "target.bin"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "add target.bin"], { cwd: repo });

      writeFileSync(join(repo, "tool.bin"), "bin-data\n");
      const snapRegular = await computeAuthoritativeExecutionSnapshot(repo, taskId);

      rmSync(join(repo, "tool.bin"));
      execFileSync("ln", ["-s", "target.bin", join(repo, "tool.bin")]);
      const snapSymlink = await computeAuthoritativeExecutionSnapshot(repo, taskId);

      assert.notEqual(snapRegular.digest, snapSymlink.digest);
    } finally {
      cleanup();
    }
  });

  it("15. ignored symlink target change -> snapshot changes", async () => {
    const { repo, taskId, cleanup } = setupCindyRepo("P0-05A", { ignoredPaths: ["link.txt"] });
    try {
      writeFileSync(join(repo, "a.txt"), "data\n");
      writeFileSync(join(repo, "b.txt"), "data\n");
      execFileSync("git", ["add", "a.txt", "b.txt"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "add targets"], { cwd: repo });

      execFileSync("ln", ["-s", "a.txt", join(repo, "link.txt")]);
      const snapA = await computeAuthoritativeExecutionSnapshot(repo, taskId);

      rmSync(join(repo, "link.txt"));
      execFileSync("ln", ["-s", "b.txt", join(repo, "link.txt")]);
      const snapB = await computeAuthoritativeExecutionSnapshot(repo, taskId);

      assert.notEqual(snapA.digest, snapB.digest);
    } finally {
      cleanup();
    }
  });

  it("16. ignored symlink escape -> reject", async () => {
    const { repo, taskId, cleanup } = setupCindyRepo("P0-05A", { ignoredPaths: ["bad-link"] });
    try {
      execFileSync("ln", ["-s", "../../outside", join(repo, "bad-link")]);

      await assert.rejects(
        async () => {
          await computeAuthoritativeExecutionSnapshot(repo, taskId);
        },
        (err: unknown) => {
          assert(err instanceof SymlinkEscapeError);
          return true;
        }
      );
    } finally {
      cleanup();
    }
  });

  it("17. missing declared ignored file -> reject", async () => {
    const { repo, taskId, cleanup } = setupCindyRepo("P0-05A", {
      ignoredPaths: ["missing-file.txt"],
    });
    try {
      // Do not create missing-file.txt on disk

      await assert.rejects(
        async () => {
          await computeAuthoritativeExecutionSnapshot(repo, taskId);
        },
        (err: unknown) => {
          assert(err instanceof FilesystemSnapshotError);
          assert.match((err as Error).message, /File not found/);
          return true;
        }
      );
    } finally {
      cleanup();
    }
  });

  it("18. undeclared ignored file change -> snapshot unchanged", async () => {
    const { repo, taskId, cleanup } = setupCindyRepo("P0-05A", { ignoredPaths: [] });
    try {
      writeFileSync(join(repo, "undeclared.log"), "first\n");
      const snap1 = await computeAuthoritativeExecutionSnapshot(repo, taskId);

      writeFileSync(join(repo, "undeclared.log"), "second\n");
      const snap2 = await computeAuthoritativeExecutionSnapshot(repo, taskId);

      assert.equal(snap1.digest, snap2.digest);
    } finally {
      cleanup();
    }
  });

  it("19. undeclared node_modules/cache -> unchanged", async () => {
    const { repo, taskId, cleanup } = setupCindyRepo();
    try {
      mkdirSync(join(repo, "node_modules", "somepkg"), { recursive: true });
      mkdirSync(join(repo, ".cache"), { recursive: true });
      writeFileSync(join(repo, "node_modules", "somepkg", "index.js"), "code 1\n");
      writeFileSync(join(repo, ".cache", "cache.bin"), "cache 1\n");

      const snap1 = await computeAuthoritativeExecutionSnapshot(repo, taskId);

      writeFileSync(join(repo, "node_modules", "somepkg", "index.js"), "code 2\n");
      writeFileSync(join(repo, ".cache", "cache.bin"), "cache 2\n");

      const snap2 = await computeAuthoritativeExecutionSnapshot(repo, taskId);
      assert.equal(snap1.digest, snap2.digest);
    } finally {
      cleanup();
    }
  });

  it("20. .agent/runtime changes -> unchanged", async () => {
    const { repo, taskId, cleanup } = setupCindyRepo();
    try {
      mkdirSync(join(repo, ".agent", "runtime", "some-run"), { recursive: true });
      writeFileSync(join(repo, ".agent", "runtime", "some-run", "log.txt"), "log 1\n");

      const snap1 = await computeAuthoritativeExecutionSnapshot(repo, taskId);

      writeFileSync(join(repo, ".agent", "runtime", "some-run", "log.txt"), "log 2\n");
      const snap2 = await computeAuthoritativeExecutionSnapshot(repo, taskId);

      assert.equal(snap1.digest, snap2.digest);
    } finally {
      cleanup();
    }
  });
});

describe("CINDY_EXECUTION_SNAPSHOT_V1 — Evidence Binding, Staleness & Caller Attacks", () => {
  it("recordTestResult binds executionSnapshotVersion and executionSnapshotDigest", async () => {
    const { repo, taskId, runId, cleanup } = setupCindyRepo();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: repo });
      await orchestrator.initRun({ runId, taskId });

      // Create a file in scope
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "src", "code.ts"), "export const x = 1;\n");

      // Advance to TESTING
      await orchestrator.markReadyForBuilder(runId);
      await orchestrator.startBuilding(runId);
      await orchestrator.completeBuilding(runId);
      await orchestrator.startTesting(runId);

      const snap = await orchestrator.computeCurrentExecutionSnapshot(taskId);
      assert.equal(snap.version, CINDY_EXECUTION_SNAPSHOT_V1);

      const rec = await orchestrator.artifactStore.recordTestResult(runId, {
        command: "npm test",
        exitCode: 0,
        status: "PASS",
        output: "all tests passed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        logDigest: "0".repeat(64),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest,
      });

      assert(rec.digest);
      const testResult = await orchestrator.artifactStore.readArtifact<any>(
        runId,
        ArtifactKind.TEST_RESULT,
        1
      );
      assert.equal(testResult?.executionSnapshotVersion, CINDY_EXECUTION_SNAPSHOT_V1);
      assert.equal(testResult?.executionSnapshotDigest, snap.digest);
      assert.equal(testResult?.boundTreeDigest, await orchestrator.computeCurrentTreeDigest());
    } finally {
      cleanup();
    }
  });

  it("recordTestResult rejects with ArtifactDigestMismatchError when caller supplies stale snapshot digest", async () => {
    const { repo, taskId, runId, cleanup } = setupCindyRepo();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: repo });
      await orchestrator.initRun({ runId, taskId });

      await orchestrator.markReadyForBuilder(runId);
      await orchestrator.startBuilding(runId);
      await orchestrator.completeBuilding(runId);
      await orchestrator.startTesting(runId);

      await assert.rejects(
        async () => {
          await orchestrator.artifactStore.recordTestResult(
            runId,
            {
              command: "npm test",
              exitCode: 0,
              status: "PASS",
              output: "all tests passed",
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              logDigest: "0".repeat(64),
              executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
              executionSnapshotDigest: "f".repeat(64), // fake digest
            }
          );
        },
        (err: unknown) => {
          assert(err instanceof ArtifactDigestMismatchError);
          assert.match((err as Error).message, /executionSnapshotDigest.*does not match authoritative/);
          return true;
        }
      );
    } finally {
      cleanup();
    }
  });

  it("recordReviewResult rejects with ArtifactDigestMismatchError if working tree mutated after review-request", async () => {
    const { repo, taskId, runId, baseCommit, cleanup } = setupCindyRepo();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: repo });
      await orchestrator.initRun({ runId, taskId });

      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "src", "code.ts"), "export const x = 1;\n");

      await orchestrator.markReadyForBuilder(runId);
      await orchestrator.startBuilding(runId);
      await orchestrator.completeBuilding(runId);
      await orchestrator.startTesting(runId);
      const testSnap = await orchestrator.computeCurrentExecutionSnapshot(taskId);
      await orchestrator.artifactStore.recordTestResult(runId, {
        command: "npm test",
        exitCode: 0,
        status: "PASS",
        output: "passed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        logDigest: "0".repeat(64),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: testSnap.digest,
      });
      const run = await orchestrator.getRun(runId);
      const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);

      await orchestrator.recordDiffManifest(runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
      await orchestrator.prepareForReview(runId);
      await orchestrator.artifactStore.recordReviewRequest(runId, {
        reviewer: {
          identity: "reviewer-1",
          session: "session-1",
          readOnlyConfirmed: true,
        },
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: testSnap.digest,
      });
      await orchestrator.startReview(runId);

      const requestSnapshot = await orchestrator.computeCurrentExecutionSnapshot(taskId);
      const requestTree = await orchestrator.computeCurrentTreeDigest();
      const requestDiff = await orchestrator.computeCurrentDiffDigest();

      // Mutate working tree AFTER review-request
      writeFileSync(join(repo, "src", "code.ts"), "export const x = 2; // mutated\n");

      await assert.rejects(
        async () => {
          await orchestrator.artifactStore.recordReviewResult(runId, {
            runId,
            taskId,
            cycle: 1,
            reviewedBaseCommit: baseCommit,
            reviewedTreeDigest: requestTree,
            reviewedDiffDigest: requestDiff,
            executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
            executionSnapshotDigest: requestSnapshot.digest,
            reviewer: {
              identity: "reviewer-1",
              session: "session-1",
              readOnlyConfirmed: true,
            },
            verdict: "PASS",
            findings: [],
            recordedAt: new Date().toISOString(),
          });
        },
        (err: unknown) => {
          assert(err instanceof ArtifactDigestMismatchError);
          assert.match((err as Error).message, /Working tree mutated after review request was created/);
          return true;
        }
      );
    } finally {
      cleanup();
    }
  });

  it("consumeReviewPass re-validates executionSnapshotVersion and executionSnapshotDigest against live tree", async () => {
    const { repo, taskId, runId, baseCommit, cleanup } = setupCindyRepo();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: repo });
      await orchestrator.initRun({ runId, taskId });

      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "src", "code.ts"), "export const x = 1;\n");

      await orchestrator.markReadyForBuilder(runId);
      await orchestrator.startBuilding(runId);
      await orchestrator.completeBuilding(runId);
      await orchestrator.startTesting(runId);

      const testSnap = await orchestrator.computeCurrentExecutionSnapshot(taskId);
      await orchestrator.artifactStore.recordTestResult(runId, {
        command: "npm test",
        exitCode: 0,
        status: "PASS",
        output: "passed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        logDigest: "0".repeat(64),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: testSnap.digest,
      });

      await orchestrator.recordDiffManifest(runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: testSnap.digest });
      await orchestrator.prepareForReview(runId);
      await orchestrator.artifactStore.recordReviewRequest(runId, {
        reviewer: {
          identity: "reviewer-1",
          session: "session-1",
          readOnlyConfirmed: true,
        },
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: testSnap.digest,
      });
      await orchestrator.startReview(runId);

      const reviewedTree = await orchestrator.computeCurrentTreeDigest();
      const reviewedDiff = await orchestrator.computeCurrentDiffDigest();
      const snap = await orchestrator.computeCurrentExecutionSnapshot(taskId);

      await orchestrator.artifactStore.recordReviewResult(runId, {
        runId,
        taskId,
        cycle: 1,
        reviewedBaseCommit: baseCommit,
        reviewedTreeDigest: reviewedTree,
        reviewedDiffDigest: reviewedDiff,
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: snap.digest,
        reviewer: {
          identity: "reviewer-1",
          session: "session-1",
          readOnlyConfirmed: true,
        },
        verdict: "PASS",
        findings: [],
        recordedAt: new Date().toISOString(),
      });

      // Mutate working tree BEFORE consumeReviewPass
      writeFileSync(join(repo, "src", "code.ts"), "export const x = 99; // drift\n");

      await assert.rejects(
        async () => {
          await orchestrator.consumeReviewPass(runId);
        },
        (err: unknown) => {
          assert(err instanceof ArtifactDigestMismatchError);
          return true;
        }
      );
    } finally {
      cleanup();
    }
  });

  it("Ignored-input stale evidence: declared ignored file mutated after review-request fails closed", async () => {
    const { repo, taskId, runId, baseCommit, cleanup } = setupCindyRepo("P0-05A", {
      ignoredPaths: ["local.env"],
    });
    try {
      writeFileSync(join(repo, "local.env"), "VAR=initial\n");

      const orchestrator = new CindyOrchestrator({ repoDir: repo });
      await orchestrator.initRun({ runId, taskId });

      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "src", "code.ts"), "export const x = 1;\n");

      await orchestrator.markReadyForBuilder(runId);
      await orchestrator.startBuilding(runId);
      await orchestrator.completeBuilding(runId);
      await orchestrator.startTesting(runId);

      const testSnap = await orchestrator.computeCurrentExecutionSnapshot(taskId);
      await orchestrator.artifactStore.recordTestResult(runId, {
        command: "npm test",
        exitCode: 0,
        status: "PASS",
        output: "passed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        logDigest: "0".repeat(64),
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: testSnap.digest,
      });
      const run = await orchestrator.getRun(runId);
      const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);

      await orchestrator.recordDiffManifest(runId, { executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1, executionSnapshotDigest: snap.digest });
      await orchestrator.prepareForReview(runId);
      await orchestrator.artifactStore.recordReviewRequest(runId, {
        reviewer: {
          identity: "reviewer-1",
          session: "session-1",
          readOnlyConfirmed: true,
        },
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: testSnap.digest,
      });
      await orchestrator.startReview(runId);

      const requestSnapshot = await orchestrator.computeCurrentExecutionSnapshot(taskId);
      const requestTree = await orchestrator.computeCurrentTreeDigest();
      const requestDiff = await orchestrator.computeCurrentDiffDigest();

      // Mutate the declared IGNORED input
      writeFileSync(join(repo, "local.env"), "VAR=stolen_or_modified\n");

      await assert.rejects(
        async () => {
          await orchestrator.artifactStore.recordReviewResult(runId, {
            runId,
            taskId,
            cycle: 1,
            reviewedBaseCommit: baseCommit,
            reviewedTreeDigest: requestTree,
            reviewedDiffDigest: requestDiff,
            executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
            executionSnapshotDigest: requestSnapshot.digest,
            reviewer: {
              identity: "reviewer-1",
              session: "session-1",
              readOnlyConfirmed: true,
            },
            verdict: "PASS",
            findings: [],
            recordedAt: new Date().toISOString(),
          });
        },
        (err: unknown) => {
          assert(err instanceof ArtifactDigestMismatchError);
          assert.match((err as Error).message, /Working tree mutated after review request was created/);
          return true;
        }
      );
    } finally {
      cleanup();
    }
  });

  it("Caller fake input list attack: caller cannot forge or alter authoritative ignored input set in typed store", async () => {
    const { repo, taskId, runId, cleanup } = setupCindyRepo();
    try {
      // Repository has NO declared ignored inputs in HEAD; secret.key is matched by *.key in .gitignore
      writeFileSync(join(repo, "secret.key"), "SECRET\n");

      const orchestrator = new CindyOrchestrator({ repoDir: repo });
      await orchestrator.initRun({ runId, taskId });

      await orchestrator.markReadyForBuilder(runId);
      await orchestrator.startBuilding(runId);
      await orchestrator.completeBuilding(runId);
      await orchestrator.startTesting(runId);

      // Caller computes a fake snapshot using low-level helper with custom declaredIgnoredInputs
      const fakeSnapshot = await computeExecutionSnapshot(repo, {
        declaredIgnoredInputs: ["secret.key"],
      });

      // Attempting to record test result with this fake digest fails closed
      await assert.rejects(
        async () => {
          await orchestrator.artifactStore.recordTestResult(runId, {
            command: "npm test",
            exitCode: 0,
            status: "PASS",
            output: "passed",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            logDigest: "0".repeat(64),
            executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
            executionSnapshotDigest: fakeSnapshot.digest,
          });
        },
        (err: unknown) => {
          assert(err instanceof ArtifactDigestMismatchError);
          return true;
        }
      );
    } finally {
      cleanup();
    }
  });
});

describe("CINDY-ORCH-MVP-R2F3-R1 Repair Matrix (H01-H05, M01-M02)", () => {
  // H01: Immutable Authority Commit & Moving HEAD
  it("H01.1: readCommittedFileAtCommit strictly rejects revision expressions", async () => {
    const { repo, cleanup } = setupBareGitRepo();
    try {
      const invalidRevs = ["HEAD", "HEAD~1", "main", "origin/main", "a".repeat(39), "g".repeat(40), "HEAD:file.txt"];
      for (const rev of invalidRevs) {
        assert.throws(
          () => readCommittedFileAtCommit(repo, rev, "README.md"),
          (err: unknown) => {
            assert(err instanceof Error);
            assert.match((err as Error).message, /40-character lowercase hex/);
            return true;
          }
        );
      }
    } finally {
      cleanup();
    }
  });

  it("H01.2: validateStrictCommitSha enforces strictly 40-char lowercase hex", () => {
    assert.doesNotThrow(() => validateStrictCommitSha("0123456789abcdef0123456789abcdef01234567"));
    assert.throws(() => validateStrictCommitSha("HEAD"));
    assert.throws(() => validateStrictCommitSha("0123456789ABCDEF0123456789ABCDEF01234567")); // uppercase rejected
    assert.throws(() => validateStrictCommitSha("0123456789abcdef")); // short rejected
  });

  // H02: Complete Tracked Inventory
  it("H02.1: clean tracked file with skip-worktree altered on disk changes snapshot digest", async () => {
    const { repo, cleanup } = setupBareGitRepo();
    try {
      writeFileSync(join(repo, "tracked.txt"), "committed content\n");
      execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "add tracked.txt"], { cwd: repo });

      const snapClean = await computeExecutionSnapshot(repo);

      // Mark skip-worktree so git status does not report it as dirty
      execFileSync("git", ["update-index", "--skip-worktree", "tracked.txt"], { cwd: repo });
      writeFileSync(join(repo, "tracked.txt"), "sneaky silent modification\n");

      const snapModified = await computeExecutionSnapshot(repo);
      assert.notEqual(snapClean.digest, snapModified.digest);
    } finally {
      cleanup();
    }
  });

  it("H02.2: clean tracked file with core.filemode=false and chmod +x changes snapshot digest", async () => {
    const { repo, cleanup } = setupBareGitRepo();
    try {
      execFileSync("git", ["config", "core.filemode", "false"], { cwd: repo });
      writeFileSync(join(repo, "script.sh"), "#!/bin/sh\necho hi\n");
      execFileSync("git", ["add", "script.sh"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "add script"], { cwd: repo });

      const snapNonExec = await computeExecutionSnapshot(repo);
      const entryBefore = snapNonExec.manifest.entries.find((e) => e.path === "script.sh");
      assert.equal((entryBefore as any).executable, false);

      chmodSync(join(repo, "script.sh"), 0o755);
      const snapExec = await computeExecutionSnapshot(repo);
      const entryAfter = snapExec.manifest.entries.find((e) => e.path === "script.sh");
      assert.equal((entryAfter as any).executable, true);
      assert.notEqual(snapNonExec.digest, snapExec.digest);
    } finally {
      cleanup();
    }
  });

  it("H02.3: clean committed symlink passes through real containment inspection", async () => {
    const { repo, cleanup } = setupBareGitRepo();
    try {
      writeFileSync(join(repo, "target.txt"), "target\n");
      execFileSync("ln", ["-s", "target.txt", join(repo, "symlink.txt")]);
      execFileSync("git", ["add", "target.txt", "symlink.txt"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "add committed symlink"], { cwd: repo });

      const snap = await computeExecutionSnapshot(repo);
      const entry = snap.manifest.entries.find((e) => e.path === "symlink.txt");
      assert(entry);
      assert.equal(entry.entryType, "symlink");
    } finally {
      cleanup();
    }
  });

  it("H02.4: tracked file deletion produces explicit deleted entry", async () => {
    const { repo, cleanup } = setupBareGitRepo();
    try {
      writeFileSync(join(repo, "to-delete.txt"), "delete me\n");
      execFileSync("git", ["add", "to-delete.txt"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "add file to delete"], { cwd: repo });

      rmSync(join(repo, "to-delete.txt"));
      const snap = await computeExecutionSnapshot(repo);
      const entry = snap.manifest.entries.find((e) => e.path === "to-delete.txt");
      assert(entry);
      assert.equal(entry.entryType, "deleted");
    } finally {
      cleanup();
    }
  });

  it("H02.5: staged rename binds old path deletion and new entry", async () => {
    const { repo, cleanup } = setupBareGitRepo();
    try {
      writeFileSync(join(repo, "old-name.txt"), "data\n");
      execFileSync("git", ["add", "old-name.txt"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "commit old name"], { cwd: repo });

      execFileSync("git", ["mv", "old-name.txt", "new-name.txt"], { cwd: repo });
      const snap = await computeExecutionSnapshot(repo);
      const oldEntry = snap.manifest.entries.find((e) => e.path === "old-name.txt");
      const newEntry = snap.manifest.entries.find((e) => e.path === "new-name.txt");
      assert(oldEntry);
      assert.equal(oldEntry.entryType, "deleted");
      assert(newEntry);
      assert.equal(newEntry.entryType, "regular");
    } finally {
      cleanup();
    }
  });

  // H03: Static Symlink Containment
  it("H03.1: nested symlink escape (foo -> inside -> outside) fails closed", async () => {
    const { repo, taskId, cleanup } = setupCindyRepo("P0-05A", { ignoredPaths: ["foo"] });
    try {
      execFileSync("ln", ["-s", "../../outside", join(repo, "inside-link")]);
      execFileSync("ln", ["-s", "inside-link", join(repo, "foo")]);

      await assert.rejects(
        async () => {
          await computeAuthoritativeExecutionSnapshot(repo, taskId);
        },
        (err: unknown) => err instanceof SymlinkEscapeError
      );
    } finally {
      cleanup();
    }
  });

  it("H03.2: ancestor symlink escape (.cache/ext -> outsideDir with .cache/ext/secret) fails closed", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "cindy-outside-"));
    const { repo, taskId, cleanup } = setupCindyRepo("P0-05A", {
      ignoredPaths: [".cache/ext/secret"],
    });
    try {
      mkdirSync(join(repo, ".cache"), { recursive: true });
      execFileSync("ln", ["-s", outsideDir, join(repo, ".cache", "ext")]);
      writeFileSync(join(outsideDir, "secret"), "stolen-data");

      await assert.rejects(
        async () => {
          await computeAuthoritativeExecutionSnapshot(repo, taskId);
        },
        (err: unknown) => err instanceof SymlinkEscapeError
      );
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
      cleanup();
    }
  });

  it("H03.3: symlink loop fails closed without infinite recursion", async () => {
    const { repo, taskId, cleanup } = setupCindyRepo("P0-05A", { ignoredPaths: ["loop-a"] });
    try {
      execFileSync("ln", ["-s", "loop-b", join(repo, "loop-a")]);
      execFileSync("ln", ["-s", "loop-a", join(repo, "loop-b")]);

      await assert.rejects(
        async () => {
          await computeAuthoritativeExecutionSnapshot(repo, taskId);
        },
        (err: unknown) => err instanceof SymlinkEscapeError
      );
    } finally {
      cleanup();
    }
  });

  // M01: Reserved Namespace Path Aliases
  it("M01: declaration rejects reserved namespace aliases (foo/../.git/config, ./.git/config, .agent//runtime/x, task.json)", () => {
    const { repo, cleanup } = setupBareGitRepo();
    try {
      const aliasAttempts = [
        "foo/../.git/config",
        "./.git/config",
        ".agent//runtime/x",
        ".agent/tasks/P0-05A/task.json",
        ".agent/tasks/P0-05A/execution-inputs.json",
      ];
      for (const p of aliasAttempts) {
        assert.throws(
          () => validateIgnoredPathEntry(p, repo, "P0-05A"),
          (err: unknown) => err instanceof ExecutionInputsValidationError
        );
      }
    } finally {
      cleanup();
    }
  });

  // H04: Mandatory Snapshot Fields in Schemas
  it("H04: 4 schemas strictly require valid executionSnapshotVersion and executionSnapshotDigest", () => {
    const { repo, cleanup } = setupBareGitRepo();
    try {
      const schemaNames = [
        "cindy-test-result.schema.json",
        "cindy-diff-manifest.schema.json",
        "cindy-review-request.schema.json",
        "cindy-review.schema.json",
      ];
      for (const schemaName of schemaNames) {
        const schema = loadArtifactSchema(repo, schemaName) as { required?: string[] };
        assert(schema.required && schema.required.includes("executionSnapshotVersion"), `${schemaName} must require executionSnapshotVersion`);
        assert(schema.required && schema.required.includes("executionSnapshotDigest"), `${schemaName} must require executionSnapshotDigest`);
      }
    } finally {
      cleanup();
    }
  });

  // M02: recordDiffManifest assertions
  it("M02: recordDiffManifest validates expectedExecutionSnapshot assertions", async () => {
    const { repo, taskId, runId, cleanup } = setupCindyRepo();
    try {
      const orchestrator = new CindyOrchestrator({ repoDir: repo });
      await orchestrator.initRun({ runId, taskId });

      await orchestrator.markReadyForBuilder(runId);
      await orchestrator.startBuilding(runId);
      await orchestrator.completeBuilding(runId);
      await orchestrator.startTesting(runId);

      // Version mismatch rejects
      await assert.rejects(
        async () => {
              const run = await orchestrator.getRun(runId);
              const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
          await orchestrator.recordDiffManifest(runId, {
            expectedExecutionSnapshotVersion: "UNKNOWN_VERSION",
              executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
              executionSnapshotDigest: snap.digest
        });
        },
        (err: unknown) => err instanceof ArtifactValidationError
      );

      // Digest mismatch rejects
      await assert.rejects(
        async () => {
              const run = await orchestrator.getRun(runId);
              const snap = await orchestrator.computeCurrentExecutionSnapshot(run.taskId);
          await orchestrator.recordDiffManifest(runId, {
            expectedExecutionSnapshotDigest: "0".repeat(64),
              executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
              executionSnapshotDigest: snap.digest
        });
        },
        (err: unknown) => err instanceof ArtifactDigestMismatchError
      );

      // Matching assertion succeeds
      const liveSnap = await orchestrator.computeCurrentExecutionSnapshot(taskId);
      const res = await orchestrator.recordDiffManifest(runId, {
        expectedExecutionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        expectedExecutionSnapshotDigest: liveSnap.digest,
        executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
        executionSnapshotDigest: liveSnap.digest
      });
      assert(res.digest);
    } finally {
      cleanup();
    }
  });
});
