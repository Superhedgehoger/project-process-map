import { mkdir, readFile, rename, unlink, open, readdir, lstat, link, chmod, rm, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, renameSync, openSync, fsyncSync, closeSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";
import {
  sha256,
  computeTreeDigest,
  computeTreeDigestSync,
  computeTreeSnapshotSync,
  computeDiffDigest,
  computeExecutionSnapshot,
  computeAuthoritativeExecutionSnapshot,
  CINDY_EXECUTION_SNAPSHOT_V1,
  collectFileIdentities,
  verifyFileIdentityFence,
} from "./digest.ts";
import {
  ArtifactKind,
  ConflictingArtifactError,
  ConcurrentRunUpdateError,
  StaleRunLockError,
  ConcurrentInitError,
  StaleInitLockError,
  ArtifactCorruptionError,
  PathTraversalError,
  ArtifactValidationError,
  StateDrivingArtifactRequiresTypedWriterError,
  ArtifactDigestMismatchError,
  TransitionRejectedError,
  AmbiguousActiveRunError,
  ActiveRunExistsError,
  TaskPacketNotCommittedError,
  DirtyTreeUnexplainedError,
  InvalidRunRecordError,
  RunGitSnapshotIncompleteError,
  CindyState,
  isPrivilegedState,
  CindyStopReason,
  RESUME_TARGET_WHITELIST,
  ADMINISTRATIVE_PAUSE_TARGETS,
  isAdministrativePauseTarget,
  STATE_DRIVING_ARTIFACT_KINDS,
  isStateDrivingArtifactKind,
  type CindyRun,
  type BaselineArtifact,
  type InitRunOptions,
  type TestResultArtifact,
  type DiffManifestArtifact,
  type ReviewRequestArtifact,
  type ReviewResultArtifact,
  type FileIdentityRecord,
  type ExecutionSnapshotManifest,
} from "./types.ts";
import {
  resolveSafeRunDir,
  resolveSafeArtifactPath,
  assertNoSymlinkAncestors,
  canonicalizeRepoDir,
  validateRunId,
  validateTaskId,
  parseArtifactKindAndCycle,
} from "./path-safety.ts";
import {
  validateArtifactBoundary,
} from "./schema-validator.ts";
import {
  validateTransition,
  isEvidenceGatedState,
  isPauseState,
} from "./state-machine.ts";
import {
  evaluateGitAuthority,
  readCommittedClosure,
  readCommittedTaskPacket,
  readCanonicalTaskPacketAtCommit,
  validateStrictCommitSha,
  getGitBranch,
  getGitHead,
  checkGitUpstreamStatus,
  getGitStatus,
  isGitAncestor,
} from "./git.ts";
import {
  checkDirtyTreeOwnership,
  validateScopeEntry,
  assertScopeNotBroadened,
} from "./ownership.ts";

export interface RecordArtifactOptions {
  cycle?: number | undefined;
  taskId?: string | undefined;
  expectedTreeDigest?: string | undefined;
  expectedExecutionSnapshotDigest?: string | undefined;
  expectedExecutionSnapshotVersion?: string | undefined;
  expectedBaseCommit?: string | undefined;
  /** Deprecated caller assertion; generic writes reject true at runtime. */
  authoritative?: boolean | undefined;
}

export interface RecordArtifactResult {
  path: string;
  digest: string;
  isDuplicate: boolean;
}

export interface RunLockMetadata {
  pid: number;
  hostname: string;
  createdAt: string;
  ownerId: string;
}

/**
 * Recursively freezes an object and all nested objects
 */
export function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj as Readonly<T>;
}

/**
 * Deterministically sort object keys for stable canonical JSON representation
 */
export function canonicalizeJson(obj: unknown): string {
  function sortKeys(val: unknown): unknown {
    if (val === null || typeof val !== "object") {
      return val;
    }
    if (Array.isArray(val)) {
      return val.map(sortKeys);
    }
    const record = val as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort((a, b) => a.localeCompare(b));
    const sortedObj: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      sortedObj[k] = sortKeys(record[k]);
    }
    return sortedObj;
  }

  const sorted = sortKeys(obj);
  return JSON.stringify(sorted, null, 2) + "\n";
}

type TypedEvidenceWriteIntent =
  | {
      kind: typeof ArtifactKind.TEST_RESULT;
      runId: string;
      artifact: TestResultArtifact;
      expectedRunVersion: number;
      expectedState: typeof CindyState.TESTING;
      cycle: number;
      expectedExecutionSnapshotVersion?: string;
      expectedExecutionSnapshotDigest?: string;
      expectedTreeDigest: string;
      expectedBaseCommit: string;
    }
  | {
      kind: typeof ArtifactKind.DIFF_MANIFEST;
      runId: string;
      artifact: DiffManifestArtifact;
      expectedRunVersion: number;
      expectedState: typeof CindyState.TESTING;
      cycle: number;
      expectedExecutionSnapshotVersion?: string;
      expectedExecutionSnapshotDigest?: string;
      expectedTreeDigest: string;
      expectedBaseCommit: string;
    }
  | {
      kind: typeof ArtifactKind.REVIEW_REQUEST;
      runId: string;
      artifact: ReviewRequestArtifact;
      expectedRunVersion: number;
      expectedState: typeof CindyState.READY_FOR_REVIEW;
      cycle: number;
      expectedExecutionSnapshotVersion?: string;
      expectedExecutionSnapshotDigest?: string;
      expectedTreeDigest: string;
      expectedBaseCommit: string;
    }
  | {
      kind: typeof ArtifactKind.REVIEW_RESULT;
      runId: string;
      artifact: ReviewResultArtifact;
      expectedRunVersion: number;
      cycle: number;
      expectedExecutionSnapshotVersion?: string;
      expectedExecutionSnapshotDigest?: string;
      expectedTreeDigest: string;
      expectedBaseCommit: string;
    };

export class RuntimeArtifactStore {
  public readonly repoDir: string;

  constructor(options: { repoDir?: string } = {}) {
    this.repoDir = canonicalizeRepoDir(options.repoDir ?? process.cwd());
  }

  public getRunDir(runId: string): string {
    return resolveSafeRunDir(this.repoDir, runId);
  }

  public getArtifactPath(runId: string, artifactType: string, cycle?: number): string {
    return resolveSafeArtifactPath(this.repoDir, runId, artifactType, cycle);
  }



  /**
   * Resolves the unique active run for a given task according to Architecture Decision I.
   * Scans all schema-valid run records in .agent/runtime.
   * - 0 active runs: returns null (safe repository-level reconcile)
   * - 1 active run: returns the unique active run snapshot
   * - >1 active runs: throws AmbiguousActiveRunError (fail closed)
   * - malformed or schema-invalid run belonging to taskId: throws InvalidRunRecordError (fail closed)
   * - incomplete git snapshot (missing upstreamRef or upstreamCommit): throws RunGitSnapshotIncompleteError (fail closed)
   */
  public async resolveActiveRunForTask(taskId: string): Promise<CindyRun | null> {
    validateTaskId(taskId);
    const runtimeDir = join(this.repoDir, ".agent", "runtime");
    if (!existsSync(runtimeDir)) return null;

    const entries = await readdir(runtimeDir, { withFileTypes: true });
    const activeRuns: CindyRun[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith(".tmp_")) continue;

      if (!entry.isDirectory()) {
        throw new InvalidRunRecordError(
          `INVALID_RUN_RECORD: Unrecognized runtime file entry '${entry.name}'`
        );
      }
      const runId = entry.name;
      try {
        validateRunId(runId);
      } catch (err: unknown) {
        throw new InvalidRunRecordError(
          `INVALID_RUN_RECORD: Invalid run directory name '${runId}': ${err instanceof Error ? err.message : String(err)}`
        );
      }

      const runPath = this.getArtifactPath(runId, ArtifactKind.RUN);
      if (!existsSync(runPath)) {
        throw new InvalidRunRecordError(
          `INVALID_RUN_RECORD: Missing run.json in run directory '${runId}'`
        );
      }

      let raw: string;
      try {
        raw = await readFile(runPath, "utf8");
      } catch (err: unknown) {
        throw new InvalidRunRecordError(
          `INVALID_RUN_RECORD: Failed to read run file for '${runId}': ${err instanceof Error ? err.message : String(err)}`
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err: unknown) {
        throw new InvalidRunRecordError(
          `INVALID_RUN_RECORD: Malformed JSON in run '${runId}': ${err instanceof Error ? err.message : String(err)}`
        );
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new InvalidRunRecordError(
          `INVALID_RUN_RECORD: Run '${runId}' must be a JSON object`
        );
      }

      const obj = parsed as Record<string, unknown>;
      if (typeof obj.taskId !== "string" || !obj.taskId) {
        throw new InvalidRunRecordError(
          `INVALID_RUN_RECORD: Run '${runId}' is missing taskId`
        );
      }

      // Snapshot completeness check (Architecture Decision I, J, Q)
      if (
        typeof obj.branch !== "string" ||
        !obj.branch ||
        typeof obj.headCommit !== "string" ||
        !obj.headCommit ||
        typeof obj.baseCommit !== "string" ||
        !obj.baseCommit ||
        typeof obj.taskAuthorityCommit !== "string" ||
        !obj.taskAuthorityCommit ||
        (obj.taskAuthorityCommit as string).length !== 40 ||
        typeof obj.upstreamRef !== "string" ||
        !obj.upstreamRef ||
        typeof obj.upstreamCommit !== "string" ||
        !obj.upstreamCommit ||
        (obj.upstreamCommit as string).length !== 40
      ) {
        throw new RunGitSnapshotIncompleteError(
          `RUN_GIT_SNAPSHOT_INCOMPLETE: Run '${runId}' for task '${obj.taskId}' is missing required Git authority snapshot field(s)`
        );
      }

      // Validate schema dialect and structure
      try {
        validateArtifactBoundary(this.repoDir, ArtifactKind.RUN, parsed, {
          runId,
          taskId: obj.taskId as string,
        });
      } catch (schemaErr: unknown) {
        throw new InvalidRunRecordError(
          `INVALID_RUN_RECORD: Schema/semantic validation failed for run '${runId}' of task '${obj.taskId}': ${schemaErr instanceof Error ? schemaErr.message : String(schemaErr)}`
        );
      }

      const run = parsed as CindyRun;

      // Check if active (non-terminal)
      const isTerminal = run.state === CindyState.CLOSED || run.state === CindyState.NEXT_TASK_SELECTED;
      if (!isTerminal && obj.taskId === taskId) {
        activeRuns.push(run);
      }
    }

    if (activeRuns.length === 0) {
      return null;
    }
    if (activeRuns.length === 1) {
      return activeRuns[0]!;
    }

    throw new AmbiguousActiveRunError(
      `AMBIGUOUS_ACTIVE_RUN: Multiple active runs (${activeRuns.map((r) => r.runId).join(", ")}) exist for task '${taskId}'`
    );
  }

  /**
   * Scans all runs across all tasks in runtime directory, returning all active runs.
   * Throws if any malformed run or incomplete snapshot is found.
   */
  public async resolveAllActiveRuns(): Promise<CindyRun[]> {
    const runtimeDir = join(this.repoDir, ".agent", "runtime");
    if (!existsSync(runtimeDir)) return [];

    const entries = await readdir(runtimeDir, { withFileTypes: true });
    const activeRuns: CindyRun[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith(".tmp_")) continue;

      if (!entry.isDirectory()) {
        throw new InvalidRunRecordError(
          `INVALID_RUN_RECORD: Unrecognized runtime file entry '${entry.name}'`
        );
      }
      const runId = entry.name;
      try {
        validateRunId(runId);
      } catch (err: unknown) {
        throw new InvalidRunRecordError(
          `INVALID_RUN_RECORD: Invalid run directory name '${runId}': ${err instanceof Error ? err.message : String(err)}`
        );
      }

      const runPath = this.getArtifactPath(runId, ArtifactKind.RUN);
      if (!existsSync(runPath)) {
        throw new InvalidRunRecordError(
          `INVALID_RUN_RECORD: Missing run.json in run directory '${runId}'`
        );
      }

      let raw: string;
      try {
        raw = await readFile(runPath, "utf8");
      } catch (err: unknown) {
        throw new InvalidRunRecordError(
          `INVALID_RUN_RECORD: Failed to read run file for '${runId}': ${err instanceof Error ? err.message : String(err)}`
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err: unknown) {
        throw new InvalidRunRecordError(
          `INVALID_RUN_RECORD: Malformed JSON in run '${runId}': ${err instanceof Error ? err.message : String(err)}`
        );
      }

      const run = parsed as CindyRun;
      if (!run || typeof run !== "object" || typeof run.taskId !== "string") {
        throw new InvalidRunRecordError(`INVALID_RUN_RECORD: Run '${runId}' is missing taskId`);
      }

      if (
        typeof run.branch !== "string" ||
        !run.branch ||
        typeof run.headCommit !== "string" ||
        !run.headCommit ||
        typeof run.baseCommit !== "string" ||
        !run.baseCommit ||
        typeof run.taskAuthorityCommit !== "string" ||
        !run.taskAuthorityCommit ||
        run.taskAuthorityCommit.length !== 40 ||
        typeof run.upstreamRef !== "string" ||
        !run.upstreamRef ||
        typeof run.upstreamCommit !== "string" ||
        !run.upstreamCommit ||
        run.upstreamCommit.length !== 40
      ) {
        throw new RunGitSnapshotIncompleteError(
          `RUN_GIT_SNAPSHOT_INCOMPLETE: Run '${runId}' is missing required Git authority snapshot field(s)`
        );
      }

      try {
        validateArtifactBoundary(this.repoDir, ArtifactKind.RUN, run, {
          runId,
          taskId: run.taskId,
        });
      } catch (schemaErr: unknown) {
        throw new InvalidRunRecordError(
          `INVALID_RUN_RECORD: Schema/semantic validation failed for run '${runId}': ${schemaErr instanceof Error ? schemaErr.message : String(schemaErr)}`
        );
      }

      const isTerminal = run.state === CindyState.CLOSED || run.state === CindyState.NEXT_TASK_SELECTED;
      if (!isTerminal) {
        activeRuns.push(run);
      }
    }

    return activeRuns;
  }

  /**
   * Acquire per-run mutual exclusion lock using candidate-file + atomic link pattern.
   *
   * WHY LINK (Decision D):
   * `link(candidate, ".run.lock")` provides atomic create-if-absent semantics
   * guaranteed by the filesystem kernel. Unlike exists() -> write(), there is NO
   * TOCTOU acquisition window. If two processes concurrently compete, exactly one link
   * succeeds; the loser gets EEXIST.
   *
   * CANDIDATE PATTERN:
   * Formal `.run.lock` can only ever appear on disk once metadata has been completely
   * written, synced to disk, closed, and validated. If candidate creation, writing,
   * syncing, or validation fails, ONLY the unique candidate file is unlinked.
   * Formal `.run.lock` is NEVER left empty, truncated, or half-written.
   *
   * STALE LOCK MVP CONTRACT (Decision D):
   * Automatic stale-lock reclamation is DEFERRED in Control Plane MVP.
   * If .run.lock exists:
   * - live owner: wait and retry; fail with CONCURRENT_RUN_UPDATE if timed out
   * - confirmed dead owner (ESRCH on same host): fail closed with STALE_RUN_LOCK_REQUIRES_RECONCILIATION
   * - unknown / EPERM / foreign hostname: fail closed
   * - malformed lock metadata: fail closed
   * Under NO circumstances does the Control Plane MVP unlink, rename, replace, or
   * reclaim an existing main lock. Confirmed stale != automatic deletion.
   */
  public async acquireRunLock(runTarget: string): Promise<{ ownerId: string; lockPath: string }> {
    let runId: string;
    if (runTarget.includes("/") || runTarget.includes("\\")) {
      const parts = runTarget.split(/[/\\]+/).filter(Boolean);
      runId = parts.at(-1) ?? "";
    } else {
      runId = runTarget;
    }
    validateRunId(runId);
    const runDir = this.getRunDir(runId);
    assertNoSymlinkAncestors(this.repoDir, runDir);

    if (!existsSync(runDir)) {
      throw new ArtifactValidationError(
        `Cannot acquire run lock: run directory does not exist for '${runId}'`
      );
    }
    assertNoSymlinkAncestors(this.repoDir, runDir);

    const runPath = this.getArtifactPath(runId, ArtifactKind.RUN);
    if (!existsSync(runPath)) {
      throw new InvalidRunRecordError(
        `INVALID_RUN_RECORD: Cannot acquire run lock: run.json does not exist in run directory for '${runId}'`
      );
    }

    let runRaw: string;
    try {
      runRaw = await readFile(runPath, "utf8");
    } catch (err: unknown) {
      throw new InvalidRunRecordError(
        `INVALID_RUN_RECORD: Cannot acquire run lock: failed to read run.json for '${runId}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!runRaw || runRaw.trim().length === 0) {
      throw new InvalidRunRecordError(
        `INVALID_RUN_RECORD: Cannot acquire run lock: run.json is empty for '${runId}'`
      );
    }

    let runParsed: Record<string, unknown>;
    try {
      runParsed = JSON.parse(runRaw);
    } catch (err: unknown) {
      throw new InvalidRunRecordError(
        `INVALID_RUN_RECORD: Cannot acquire run lock: malformed JSON in run.json for '${runId}': ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!runParsed || typeof runParsed !== "object") {
      throw new InvalidRunRecordError(
        `INVALID_RUN_RECORD: Cannot acquire run lock: run.json is not an object for '${runId}'`
      );
    }

    if (runParsed.runId !== runId) {
      throw new InvalidRunRecordError(
        `INVALID_RUN_RECORD: Cannot acquire run lock: runId mismatch in run.json (directory '${runId}', run.json '${String(runParsed.runId)}')`
      );
    }

    if (!runParsed.taskId || typeof runParsed.taskId !== "string") {
      throw new InvalidRunRecordError(
        `INVALID_RUN_RECORD: Cannot acquire run lock: missing or invalid taskId in run.json for '${runId}'`
      );
    }
    validateTaskId(runParsed.taskId);

    try {
      validateArtifactBoundary(this.repoDir, ArtifactKind.RUN, runParsed, {
        runId,
        taskId: runParsed.taskId,
      });
    } catch (err: unknown) {
      throw new InvalidRunRecordError(
        `INVALID_RUN_RECORD: Cannot acquire run lock: schema validation failed for run.json in '${runId}': ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const lockPath = join(runDir, ".run.lock");
    const maxRetries = 25;
    const retryDelayMs = 20;
    const currentOwnerId = randomUUID();

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Step 1: Generate unique candidate file path
      const candidateId = randomUUID();
      const candidatePath = join(runDir, `.run.lock.candidate.${candidateId}`);

      const metadata: RunLockMetadata = {
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
        ownerId: currentOwnerId,
      };

      // Steps 2-5: open("wx"), write complete metadata, sync, close
      let candidateCreated = false;
      try {
        const fileHandle = await open(candidatePath, "wx");
        candidateCreated = true;
        try {
          await fileHandle.writeFile(JSON.stringify(metadata), "utf8");
          await fileHandle.sync();
        } finally {
          await fileHandle.close();
        }

        // Step 6: Re-read candidate and validate metadata completeness
        const readBack = await readFile(candidatePath, "utf8");
        const parsed = JSON.parse(readBack) as RunLockMetadata;
        if (
          !parsed ||
          typeof parsed !== "object" ||
          parsed.pid !== process.pid ||
          parsed.hostname !== os.hostname() ||
          parsed.ownerId !== currentOwnerId ||
          typeof parsed.createdAt !== "string"
        ) {
          throw new Error("Candidate lock metadata validation failed");
        }
      } catch (candidateErr: unknown) {
        if (candidateCreated) {
          await unlink(candidatePath).catch(() => {});
        }
        throw new ConcurrentRunUpdateError(
          `CONCURRENT_RUN_UPDATE: Failed to write lock metadata at ${lockPath}: ${String(candidateErr)}`
        );
      }

      // Step 7: Atomic competition for .run.lock via hard link
      let linkSuccess = false;
      try {
        await link(candidatePath, lockPath);
        linkSuccess = true;
      } catch (linkErr: unknown) {
        // Link failed — clean up candidate file
        await unlink(candidatePath).catch(() => {});

        if ((linkErr as NodeJS.ErrnoException).code !== "EEXIST") {
          throw linkErr;
        }
      }

      if (linkSuccess) {
        // Step 8: Success! Current process is the authoritative owner of .run.lock.
        // Clean up candidate file. Hard link points to same inode, so removing
        // candidatePath does NOT affect .run.lock.
        try {
          await unlink(candidatePath);
        } catch {
          // If candidate cleanup fails, DO NOT delete main lock!
          // Current process already legitimately owns main lock.
        }
        return { ownerId: currentOwnerId, lockPath };
      }

      // Lock already exists — inspect existing lock file
      let content: string;
      try {
        content = await readFile(lockPath, "utf8");
      } catch (readErr: unknown) {
        if ((readErr as NodeJS.ErrnoException).code === "ENOENT") {
          // Lock disappeared between link and read — retry
          continue;
        }
        throw new ConcurrentRunUpdateError(
          `CONCURRENT_RUN_UPDATE: Could not read run lock at ${lockPath}`
        );
      }

      let meta: RunLockMetadata;
      try {
        meta = JSON.parse(content) as RunLockMetadata;
      } catch {
        throw new ConcurrentRunUpdateError(
          `CONCURRENT_RUN_UPDATE: Run lock is malformed at ${lockPath}; failing closed`
        );
      }

      if (
        !meta ||
        typeof meta !== "object" ||
        typeof meta.pid !== "number" ||
        typeof meta.hostname !== "string" ||
        typeof meta.createdAt !== "string" ||
        typeof meta.ownerId !== "string"
      ) {
        throw new ConcurrentRunUpdateError(
          `CONCURRENT_RUN_UPDATE: Run lock metadata invalid at ${lockPath}; failing closed`
        );
      }

      // Check if the owner process is dead (same host only)
      if (meta.hostname !== os.hostname()) {
        // Foreign hostname cannot prove dead -> wait and retry; fail closed on timeout
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }

      let isDead = false;
      try {
        process.kill(meta.pid, 0);
        isDead = false;
      } catch (killErr: unknown) {
        const code = (killErr as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          isDead = true;
        } else {
          // EPERM or other error: treat as alive / unknown -> wait and retry; fail closed on timeout
          isDead = false;
        }
      }

      if (isDead) {
        // Confirmed dead owner!
        // Under Control Plane MVP Approved Architecture Decision D:
        // Automatic stale lock reclamation is DEFERRED.
        // We MUST NOT unlink, rename, replace, or reclaim the main lock.
        throw new StaleRunLockError(
          `STALE_RUN_LOCK_REQUIRES_RECONCILIATION: Stale run lock detected at ${lockPath} (held by dead PID ${meta.pid} on ${meta.hostname}); automatic reclamation is deferred in Control Plane MVP`
        );
      }

      // Lock holder is alive (or unknown) — wait and retry
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      continue;
    }

    throw new ConcurrentRunUpdateError(
      `CONCURRENT_RUN_UPDATE: Timed out waiting to acquire run lock for ${runDir}`
    );
  }

  /**
   * Release per-run mutual exclusion lock, verifying that only the matching owner can release.
   */
  public async releaseRunLock(runDir: string, expectedOwnerId: string): Promise<void> {
    const lockPath = join(runDir, ".run.lock");
    try {
      const content = await readFile(lockPath, "utf8");
      let meta: RunLockMetadata;
      try {
        meta = JSON.parse(content) as RunLockMetadata;
      } catch {
        throw new ConcurrentRunUpdateError(
          `CONCURRENT_RUN_UPDATE: Cannot release lock: malformed lock metadata at ${lockPath}`
        );
      }
      if (meta && typeof meta === "object" && meta.ownerId === expectedOwnerId) {
        await unlink(lockPath);
      } else {
        throw new ConcurrentRunUpdateError(
          `CONCURRENT_RUN_UPDATE: Cannot release lock: owner mismatch (expected '${expectedOwnerId}', found '${meta?.ownerId}')`
        );
      }
    } catch (err: unknown) {
      if (err instanceof ConcurrentRunUpdateError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }
  }

  async #withRunLock<T>(runDir: string, action: () => Promise<T>): Promise<T> {
    const { ownerId } = await this.acquireRunLock(runDir);
    try {
      return await action();
    } finally {
      await this.releaseRunLock(runDir, ownerId).catch(() => {});
    }
  }

  /**
   * Acquire repository-level initialization lock (.agent/runtime/.init.lock) (Decision M).
   * Follows candidate-file + atomic hard link pattern.
   * Stale lock reclamation is NOT supported in Control Plane MVP.
   */
  public async acquireInitLock(): Promise<{ ownerId: string; lockPath: string }> {
    const runtimeDir = join(this.repoDir, ".agent", "runtime");
    assertNoSymlinkAncestors(this.repoDir, runtimeDir);
    await mkdir(runtimeDir, { recursive: true });
    assertNoSymlinkAncestors(this.repoDir, runtimeDir);

    const lockPath = join(runtimeDir, ".init.lock");
    const maxRetries = 25;
    const retryDelayMs = 20;
    const currentOwnerId = randomUUID();

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const candidateId = randomUUID();
      const candidatePath = join(runtimeDir, `.init.lock.candidate.${candidateId}`);

      const metadata: RunLockMetadata = {
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
        ownerId: currentOwnerId,
      };

      let candidateCreated = false;
      try {
        const fileHandle = await open(candidatePath, "wx");
        candidateCreated = true;
        try {
          await fileHandle.writeFile(JSON.stringify(metadata), "utf8");
          await fileHandle.sync();
        } finally {
          await fileHandle.close();
        }

        const readBack = await readFile(candidatePath, "utf8");
        const parsed = JSON.parse(readBack) as RunLockMetadata;
        if (
          !parsed ||
          typeof parsed !== "object" ||
          parsed.pid !== process.pid ||
          parsed.hostname !== os.hostname() ||
          parsed.ownerId !== currentOwnerId ||
          typeof parsed.createdAt !== "string"
        ) {
          throw new Error("Candidate init lock metadata validation failed");
        }
      } catch (candidateErr: unknown) {
        if (candidateCreated) {
          await unlink(candidatePath).catch(() => {});
        }
        throw new ConcurrentInitError(
          `CONCURRENT_INIT: Failed to write init lock metadata at ${lockPath}: ${String(candidateErr)}`
        );
      }

      let linkSuccess = false;
      try {
        await link(candidatePath, lockPath);
        linkSuccess = true;
      } catch (linkErr: unknown) {
        await unlink(candidatePath).catch(() => {});
        if ((linkErr as NodeJS.ErrnoException).code !== "EEXIST") {
          throw linkErr;
        }
      }

      if (linkSuccess) {
        try {
          await unlink(candidatePath);
        } catch {}
        return { ownerId: currentOwnerId, lockPath };
      }

      // Lock already exists — inspect
      let content: string;
      try {
        content = await readFile(lockPath, "utf8");
      } catch (readErr: unknown) {
        if ((readErr as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw new ConcurrentInitError(
          `CONCURRENT_INIT: Could not read init lock at ${lockPath}`
        );
      }

      let meta: RunLockMetadata;
      try {
        meta = JSON.parse(content) as RunLockMetadata;
      } catch {
        throw new ConcurrentInitError(
          `CONCURRENT_INIT: Init lock is malformed at ${lockPath}; failing closed`
        );
      }

      if (
        !meta ||
        typeof meta !== "object" ||
        typeof meta.pid !== "number" ||
        typeof meta.hostname !== "string" ||
        typeof meta.ownerId !== "string"
      ) {
        throw new ConcurrentInitError(
          `CONCURRENT_INIT: Init lock metadata invalid at ${lockPath}; failing closed`
        );
      }

      if (meta.hostname !== os.hostname()) {
        throw new ConcurrentInitError(
          `CONCURRENT_INIT: Init lock owned by foreign host ${meta.hostname}; failing closed`
        );
      }

      let isAlive = true;
      try {
        process.kill(meta.pid, 0);
      } catch (killErr: unknown) {
        const code = (killErr as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          isAlive = false;
        } else if (code === "EPERM") {
          isAlive = true;
        } else {
          isAlive = true;
        }
      }

      if (!isAlive) {
        // Confirmed dead owner on same host: Decision M & D
        // Control Plane MVP does NOT auto-reclaim stale locks. Fail closed.
        throw new StaleInitLockError(
          "STALE_INIT_LOCK_REQUIRES_RECONCILIATION: Confirmed stale .init.lock (owner PID dead); manual reconciliation required"
        );
      }

      // Live owner — wait and retry
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      continue;
    }

    throw new ConcurrentInitError(
      `CONCURRENT_INIT: Timed out waiting to acquire init lock at ${lockPath}`
    );
  }

  public async releaseInitLock(expectedOwnerId: string): Promise<void> {
    const lockPath = join(this.repoDir, ".agent", "runtime", ".init.lock");
    try {
      const content = await readFile(lockPath, "utf8");
      let meta: RunLockMetadata;
      try {
        meta = JSON.parse(content) as RunLockMetadata;
      } catch {
        throw new ConcurrentInitError(
          `CONCURRENT_INIT: Cannot release lock: malformed lock metadata at ${lockPath}`
        );
      }
      if (meta && typeof meta === "object" && meta.ownerId === expectedOwnerId) {
        await unlink(lockPath);
      } else {
        throw new ConcurrentInitError(
          `CONCURRENT_INIT: Cannot release lock: owner mismatch (expected '${expectedOwnerId}', found '${meta?.ownerId}')`
        );
      }
    } catch (err: unknown) {
      if (err instanceof ConcurrentInitError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }
  }

  public async withInitLock<T>(action: () => Promise<T>): Promise<T> {
    const { ownerId } = await this.acquireInitLock();
    try {
      return await action();
    } finally {
      await this.releaseInitLock(ownerId).catch(() => {});
    }
  }

  /**
   * Low-level atomic artifact writer. CALLER MUST HOLD RUN LOCK.
   * Enforces symlink prevention, duplicate/conflict detection,
   * atomic temporary file write, fsync, and atomic rename.
   */
  async #writeArtifactAtomicLocked(
    runId: string,
    runDir: string,
    targetPath: string,
    artifactType: string,
    payload: Record<string, unknown>
  ): Promise<RecordArtifactResult> {
    assertNoSymlinkAncestors(this.repoDir, targetPath);

    try {
      const stat = lstatSync(targetPath);
      if (stat.isSymbolicLink()) {
        throw new PathTraversalError(`Artifact file cannot be a symbolic link: ${targetPath}`);
      }
    } catch (err: unknown) {
      if (err instanceof PathTraversalError) throw err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const jsonString = canonicalizeJson(payload);
    const digest = sha256(jsonString);

    if (existsSync(targetPath)) {
      const existingContent = await readFile(targetPath, "utf8");
      const existingDigest = sha256(existingContent);

      if (existingDigest === digest) {
        return { path: targetPath, digest, isDuplicate: true };
      }

      throw new ConflictingArtifactError(
        `Conflicting repeated artifact write for ${artifactType} in run ${runId} (existing ${existingDigest}, new ${digest})`
      );
    }

    const tempPath = join(runDir, `.tmp_art_${randomUUID()}.json`);
    const fileHandle = await open(tempPath, "w");
    try {
      await fileHandle.writeFile(jsonString, "utf8");
      await fileHandle.sync();
    } finally {
      await fileHandle.close();
    }

    try {
      assertNoSymlinkAncestors(this.repoDir, targetPath);
      await chmod(tempPath, 0o644);
      await rename(tempPath, targetPath);
      return { path: targetPath, digest, isDuplicate: false };
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      throw error;
    }
  }

  /**
   * Double-checked typed evidence writer (Architecture Decision BI).
   * Acquires run lock, re-reads run.json from disk, and re-validates:
   * 1. Run schema, runId, taskId, unique active run
   * 2. Canonical artifact conflict / identical replay
   * 3. Run version (must equal expectedRunVersion), state, and cycle
   * 4. Fresh Git authority facts (HEAD, Task authority, upstream, divergence, clean/scope)
   * 5. Fresh working tree digest, diff digest, status, scope ownership
   * 6. Artifact-specific bindings (e.g. fresh REVIEW_REQUEST from disk for REVIEW_RESULT)
   * 7. Artifact boundary schema validation
   * Only after all locked validations pass is the evidence written to disk as STRUCTURE_VALID_EXTERNAL.
   */
  async #writeTypedArtifactAtomic(
    intent: TypedEvidenceWriteIntent
  ): Promise<RecordArtifactResult> {
    const { runId, kind, cycle } = intent;
    const targetPath = this.getArtifactPath(runId, kind, cycle);
    const runDir = dirname(targetPath);

    assertNoSymlinkAncestors(this.repoDir, targetPath);

    return this.#withRunLock(runDir, async () => {
      // 1. Re-read run.json fresh from disk under run lock
      const runPath = this.getArtifactPath(runId, ArtifactKind.RUN);
      if (!existsSync(runPath)) {
        throw new ArtifactValidationError(`Run '${runId}' not found under lock`);
      }
      const lockedRun = await this.getRun(runId);

      // 2. Validate locked run schema, runId, taskId
      validateArtifactBoundary(this.repoDir, ArtifactKind.RUN, lockedRun, {
        runId,
        taskId: lockedRun.taskId,
      });

      if (lockedRun.taskId !== intent.artifact.taskId) {
        throw new ArtifactValidationError(
          `Locked run taskId '${lockedRun.taskId}' does not match artifact taskId '${intent.artifact.taskId}'`
        );
      }

      // 3. Unique active run check under lock
      const active = await this.resolveActiveRunForTask(lockedRun.taskId);
      if (!active || active.runId !== runId) {
        throw new AmbiguousActiveRunError(
          `Run '${runId}' is not the unique active run for task '${lockedRun.taskId}' under lock`
        );
      }

      // 4. Check existing canonical artifact conflict / duplicate candidate (Architecture Decisions BK, BL)
      let duplicateCandidate = false;
      let existingArtifactDigest: string | null = null;
      if (existsSync(targetPath)) {
        const existingContent = await readFile(targetPath, "utf8");
        const existingDigest = sha256(existingContent);
        const newDigest = sha256(canonicalizeJson(intent.artifact));

        if (existingDigest === newDigest) {
          duplicateCandidate = true;
          existingArtifactDigest = newDigest;
        } else {
          throw new ConflictingArtifactError(
            `Conflicting repeated artifact write for ${kind} in run ${runId} (existing ${existingDigest}, new ${newDigest})`
          );
        }
      }

      // 5. Version, state, and cycle revalidation under lock (H04-A, Decisions BM, BN)
      if (lockedRun.version !== intent.expectedRunVersion) {
        throw new ArtifactValidationError(
          `Stale run version under lock: expected ${intent.expectedRunVersion}, but current locked run version is ${lockedRun.version}`
        );
      }

      if (intent.kind === ArtifactKind.REVIEW_RESULT) {
        const isReplayingFailedCycle =
          lockedRun.state === CindyState.REPAIR_INITIALIZED &&
          intent.cycle === lockedRun.currentCycle - 1 &&
          duplicateCandidate &&
          intent.artifact.verdict === "FAIL";

        if (isReplayingFailedCycle) {
          const hasConsumedFailHistory = lockedRun.history.some(
            (h) =>
              h.toState === CindyState.REPAIR_INITIALIZED &&
              (h.reason?.includes(`cycle ${intent.cycle}`) ?? false)
          );
          if (!hasConsumedFailHistory) {
            throw new TransitionRejectedError(
              `Cannot replay review result for cycle ${intent.cycle}: no corresponding repair transition found in run history`
            );
          }
        } else if (lockedRun.state !== CindyState.REVIEWING) {
          throw new TransitionRejectedError(
            `Cannot record review result from state '${lockedRun.state}'; run must be in REVIEWING`
          );
        } else if (intent.cycle !== lockedRun.currentCycle) {
          throw new ArtifactValidationError(
            `Review result cycle mismatch: intent cycle ${intent.cycle}, current run cycle ${lockedRun.currentCycle}`
          );
        }
      } else {
        if (lockedRun.state !== intent.expectedState) {
          throw new ArtifactValidationError(
            `Cannot record '${kind}' from state '${lockedRun.state}'; run must be in ${intent.expectedState}`
          );
        }
        if (intent.cycle !== lockedRun.currentCycle) {
          throw new ArtifactValidationError(
            `${kind} cycle mismatch: intent cycle ${intent.cycle}, current run cycle ${lockedRun.currentCycle}`
          );
        }
      }

      // 6. Fresh Git authority locked revalidation (H04-B)
      const freshAuthority = evaluateGitAuthority({
        repoDir: this.repoDir,
        taskId: lockedRun.taskId,
        runSnapshot: {
          branch: lockedRun.branch,
          headCommit: lockedRun.headCommit,
          baseCommit: lockedRun.baseCommit,
          taskAuthorityCommit: lockedRun.taskAuthorityCommit,
          upstreamRef: lockedRun.upstreamRef,
          upstreamCommit: lockedRun.upstreamCommit,
          upstreamSha: lockedRun.upstreamSha,
          allowedScope: lockedRun.allowedScope,
        },
      });
      if (!freshAuthority.ok) {
        throw new TransitionRejectedError(
          `Cannot record ${kind} under lock: ${freshAuthority.stopExplanation}`
        );
      }

      // 7. Fresh Execution Snapshot / Tree / Diff / Scope locked revalidation (H04-C, Decision BY & BZ)
      const freshTreeDigest = await computeTreeDigest(this.repoDir);
      const freshSnapshot = await computeAuthoritativeExecutionSnapshot(
        this.repoDir,
        lockedRun.taskId,
        { expectedHeadCommit: lockedRun.headCommit }
      );

      if (intent.kind === ArtifactKind.TEST_RESULT) {
        if (!intent.artifact.executionSnapshotVersion || intent.artifact.executionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1) {
          throw new ArtifactValidationError(
            `Test result snapshot version mismatch under lock: artifact has '${intent.artifact.executionSnapshotVersion}', expected '${CINDY_EXECUTION_SNAPSHOT_V1}'`
          );
        }
        if (!intent.artifact.executionSnapshotDigest || !/^[0-9a-f]{64}$/.test(intent.artifact.executionSnapshotDigest)) {
          throw new ArtifactValidationError(
            `Test result snapshot digest must be a 64-character lowercase hex string, got '${intent.artifact.executionSnapshotDigest}'`
          );
        }
        if (intent.artifact.executionSnapshotDigest !== freshSnapshot.digest) {
          throw new ArtifactDigestMismatchError(
            `Test result execution snapshot digest mismatch under lock: artifact has '${intent.artifact.executionSnapshotDigest}', live snapshot is '${freshSnapshot.digest}'`
          );
        }
        if (intent.expectedExecutionSnapshotDigest && intent.expectedExecutionSnapshotDigest !== freshSnapshot.digest) {
          throw new ArtifactDigestMismatchError(
            `Test result expected execution snapshot digest mismatch under lock: expected '${intent.expectedExecutionSnapshotDigest}', live snapshot is '${freshSnapshot.digest}'`
          );
        }
        if (intent.artifact.boundTreeDigest !== freshTreeDigest) {
          throw new ArtifactDigestMismatchError(
            `Test result tree digest mismatch under lock: artifact has '${intent.artifact.boundTreeDigest}', live tree is '${freshTreeDigest}'`
          );
        }
        if (intent.expectedTreeDigest !== freshTreeDigest) {
          throw new ArtifactDigestMismatchError(
            `Test result expected tree digest mismatch under lock: expected '${intent.expectedTreeDigest}', live tree is '${freshTreeDigest}'`
          );
        }
        if (intent.expectedBaseCommit !== lockedRun.baseCommit) {
          throw new ArtifactValidationError(
            `Test result base commit mismatch under lock: expected '${intent.expectedBaseCommit}', run has '${lockedRun.baseCommit}'`
          );
        }
      } else if (intent.kind === ArtifactKind.DIFF_MANIFEST) {
        if (!intent.artifact.executionSnapshotVersion || intent.artifact.executionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1) {
          throw new ArtifactValidationError(
            `Diff manifest snapshot version mismatch under lock: artifact has '${intent.artifact.executionSnapshotVersion}', expected '${CINDY_EXECUTION_SNAPSHOT_V1}'`
          );
        }
        if (!intent.artifact.executionSnapshotDigest || !/^[0-9a-f]{64}$/.test(intent.artifact.executionSnapshotDigest)) {
          throw new ArtifactValidationError(
            `Diff manifest snapshot digest must be a 64-character lowercase hex string, got '${intent.artifact.executionSnapshotDigest}'`
          );
        }
        if (intent.artifact.executionSnapshotDigest !== freshSnapshot.digest) {
          throw new ArtifactDigestMismatchError(
            `Diff manifest execution snapshot digest mismatch under lock: artifact has '${intent.artifact.executionSnapshotDigest}', live snapshot is '${freshSnapshot.digest}'`
          );
        }
        if (intent.expectedExecutionSnapshotDigest && intent.expectedExecutionSnapshotDigest !== freshSnapshot.digest) {
          throw new ArtifactDigestMismatchError(
            `Diff manifest expected execution snapshot digest mismatch under lock: expected '${intent.expectedExecutionSnapshotDigest}', live snapshot is '${freshSnapshot.digest}'`
          );
        }
        if (intent.artifact.boundTreeDigest !== freshTreeDigest) {
          throw new ArtifactDigestMismatchError(
            `Diff manifest tree digest mismatch under lock: artifact has '${intent.artifact.boundTreeDigest}', live tree is '${freshTreeDigest}'`
          );
        }
        if (intent.expectedTreeDigest !== freshTreeDigest) {
          throw new ArtifactDigestMismatchError(
            `Diff manifest expected tree digest mismatch under lock: expected '${intent.expectedTreeDigest}', live tree is '${freshTreeDigest}'`
          );
        }
        const freshDiffDigest = await computeDiffDigest(this.repoDir);
        if (intent.artifact.diffDigest !== freshDiffDigest) {
          throw new ArtifactDigestMismatchError(
            `Diff manifest diff digest mismatch under lock: artifact has '${intent.artifact.diffDigest}', live diff is '${freshDiffDigest}'`
          );
        }
        const freshGitStatus = getGitStatus(this.repoDir);
        if (canonicalizeJson(intent.artifact.changedFiles) !== canonicalizeJson(freshGitStatus.dirtyFiles)) {
          throw new ArtifactValidationError(
            "Diff manifest changedFiles do not match live git status under lock"
          );
        }
        const freshOwnership = checkDirtyTreeOwnership(lockedRun.allowedScope, freshGitStatus.dirtyFiles, this.repoDir);
        if (intent.artifact.isWithinScope !== freshOwnership.ok) {
          throw new ArtifactValidationError(
            "Diff manifest isWithinScope does not match live scope ownership check under lock"
          );
        }
        if (canonicalizeJson(intent.artifact.unexplainedFiles) !== canonicalizeJson(freshOwnership.unexplainedFiles)) {
          throw new ArtifactValidationError(
            "Diff manifest unexplainedFiles do not match live scope ownership check under lock"
          );
        }
        if (intent.expectedBaseCommit !== lockedRun.baseCommit) {
          throw new ArtifactValidationError(
            `Diff manifest base commit mismatch under lock: expected '${intent.expectedBaseCommit}', run has '${lockedRun.baseCommit}'`
          );
        }
      } else if (intent.kind === ArtifactKind.REVIEW_REQUEST) {
        if (!intent.artifact.executionSnapshotVersion || intent.artifact.executionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1) {
          throw new ArtifactValidationError(
            `Review request snapshot version mismatch under lock: artifact has '${intent.artifact.executionSnapshotVersion}', expected '${CINDY_EXECUTION_SNAPSHOT_V1}'`
          );
        }
        if (!intent.artifact.executionSnapshotDigest || !/^[0-9a-f]{64}$/.test(intent.artifact.executionSnapshotDigest)) {
          throw new ArtifactValidationError(
            `Review request snapshot digest must be a 64-character lowercase hex string, got '${intent.artifact.executionSnapshotDigest}'`
          );
        }
        if (intent.artifact.executionSnapshotDigest !== freshSnapshot.digest) {
          throw new ArtifactDigestMismatchError(
            `Review request execution snapshot digest mismatch under lock: artifact has '${intent.artifact.executionSnapshotDigest}', live snapshot is '${freshSnapshot.digest}'`
          );
        }
        if (intent.expectedExecutionSnapshotDigest && intent.expectedExecutionSnapshotDigest !== freshSnapshot.digest) {
          throw new ArtifactDigestMismatchError(
            `Review request expected execution snapshot digest mismatch under lock: expected '${intent.expectedExecutionSnapshotDigest}', live snapshot is '${freshSnapshot.digest}'`
          );
        }
        if (intent.artifact.boundTreeDigest !== freshTreeDigest) {
          throw new ArtifactDigestMismatchError(
            `Review request tree digest mismatch under lock: artifact has '${intent.artifact.boundTreeDigest}', live tree is '${freshTreeDigest}'`
          );
        }
        if (intent.expectedTreeDigest !== freshTreeDigest) {
          throw new ArtifactDigestMismatchError(
            `Review request expected tree digest mismatch under lock: expected '${intent.expectedTreeDigest}', live tree is '${freshTreeDigest}'`
          );
        }
        if (intent.expectedBaseCommit !== lockedRun.baseCommit) {
          throw new ArtifactValidationError(
            `Review request base commit mismatch under lock: expected '${intent.expectedBaseCommit}', run has '${lockedRun.baseCommit}'`
          );
        }
        if (intent.artifact.baseCommit !== lockedRun.baseCommit) {
          throw new ArtifactValidationError(
            `Review request artifact baseCommit '${intent.artifact.baseCommit}' does not match run baseCommit '${lockedRun.baseCommit}'`
          );
        }
      } else if (intent.kind === ArtifactKind.REVIEW_RESULT) {
        const reviewRequest = await this.readArtifact<ReviewRequestArtifact>(
          intent.runId,
          ArtifactKind.REVIEW_REQUEST,
          intent.cycle
        );
        if (!reviewRequest) {
          throw new ArtifactValidationError(
            `Missing bound REVIEW_REQUEST for run '${intent.runId}' cycle ${intent.cycle} under lock`
          );
        }
        if (reviewRequest.trustClassification !== "STRUCTURE_VALID_EXTERNAL") {
          throw new ArtifactValidationError(
            `Review request for cycle ${intent.cycle} is not STRUCTURE_VALID_EXTERNAL under lock`
          );
        }
        if (reviewRequest.taskId !== lockedRun.taskId || reviewRequest.runId !== intent.runId || reviewRequest.cycle !== intent.cycle) {
          throw new ArtifactValidationError(
            `Review request binding mismatch for run '${intent.runId}' cycle ${intent.cycle} under lock`
          );
        }
        if (reviewRequest.baseCommit !== lockedRun.baseCommit) {
          throw new ArtifactValidationError(
            `Review request base commit '${reviewRequest.baseCommit}' does not match run baseCommit '${lockedRun.baseCommit}' under lock`
          );
        }
        if (!intent.artifact.reviewer || intent.artifact.reviewer.readOnlyConfirmed !== true) {
          throw new ArtifactValidationError("Reviewer must confirm read-only mode under lock");
        }
        if (intent.artifact.reviewer.identity !== reviewRequest.reviewer.identity) {
          throw new ArtifactValidationError(
            `Review result reviewer identity mismatch under lock: expected '${reviewRequest.reviewer.identity}', got '${intent.artifact.reviewer.identity}'`
          );
        }
        if (intent.artifact.reviewer.session !== reviewRequest.reviewer.session) {
          throw new ArtifactValidationError(
            `Review result reviewer session mismatch under lock: expected '${reviewRequest.reviewer.session}', got '${intent.artifact.reviewer.session}'`
          );
        }
        if (!intent.artifact.executionSnapshotVersion || intent.artifact.executionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1) {
          throw new ArtifactValidationError(
            `Review result snapshot version mismatch under lock: artifact has '${intent.artifact.executionSnapshotVersion}', expected '${CINDY_EXECUTION_SNAPSHOT_V1}'`
          );
        }
        if (!intent.artifact.executionSnapshotDigest || !/^[0-9a-f]{64}$/.test(intent.artifact.executionSnapshotDigest)) {
          throw new ArtifactValidationError(
            `Review result snapshot digest must be a 64-character lowercase hex string, got '${intent.artifact.executionSnapshotDigest}'`
          );
        }
        if (!reviewRequest.executionSnapshotVersion || reviewRequest.executionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1) {
          throw new ArtifactValidationError(
            `Bound review request snapshot version invalid under lock: '${reviewRequest.executionSnapshotVersion}'`
          );
        }
        if (!reviewRequest.executionSnapshotDigest || !/^[0-9a-f]{64}$/.test(reviewRequest.executionSnapshotDigest)) {
          throw new ArtifactValidationError(
            `Bound review request snapshot digest invalid under lock: '${reviewRequest.executionSnapshotDigest}'`
          );
        }
        if (reviewRequest.executionSnapshotDigest !== freshSnapshot.digest) {
          throw new ArtifactDigestMismatchError(
            `Working tree mutated after review request was created (request snapshot ${reviewRequest.executionSnapshotDigest}, current snapshot ${freshSnapshot.digest})`
          );
        }
        if (intent.artifact.executionSnapshotDigest !== freshSnapshot.digest) {
          throw new ArtifactDigestMismatchError(
            `Review result executionSnapshotDigest ('${intent.artifact.executionSnapshotDigest}') does not match live snapshot digest ('${freshSnapshot.digest}')`
          );
        }
        if (intent.expectedExecutionSnapshotDigest && intent.expectedExecutionSnapshotDigest !== freshSnapshot.digest) {
          throw new ArtifactDigestMismatchError(
            `Review result expected execution snapshot digest mismatch under lock: expected '${intent.expectedExecutionSnapshotDigest}', live snapshot is '${freshSnapshot.digest}'`
          );
        }
        if (reviewRequest.boundTreeDigest !== freshTreeDigest) {
          throw new ArtifactDigestMismatchError(
            `Working tree mutated after review request was created (request ${reviewRequest.boundTreeDigest}, current ${freshTreeDigest})`
          );
        }
        if (intent.artifact.reviewedTreeDigest !== freshTreeDigest) {
          throw new ArtifactDigestMismatchError(
            `Review result reviewedTreeDigest ('${intent.artifact.reviewedTreeDigest}') does not match live working tree digest ('${freshTreeDigest}')`
          );
        }
        if (intent.expectedTreeDigest && intent.expectedTreeDigest !== freshTreeDigest) {
          throw new ArtifactDigestMismatchError(
            `Review result expectedTreeDigest ('${intent.expectedTreeDigest}') does not match live working tree digest ('${freshTreeDigest}')`
          );
        }
        const freshDiffDigest = await computeDiffDigest(this.repoDir);
        if (intent.artifact.reviewedDiffDigest !== freshDiffDigest) {
          throw new ArtifactDigestMismatchError(
            `Review result reviewedDiffDigest ('${intent.artifact.reviewedDiffDigest}') does not match live diff digest ('${freshDiffDigest}')`
          );
        }
        if (intent.artifact.reviewedBaseCommit !== lockedRun.baseCommit) {
          throw new ArtifactValidationError(
            `Review result base commit mismatch under lock: artifact has '${intent.artifact.reviewedBaseCommit}', run has '${lockedRun.baseCommit}'`
          );
        }
      }

      // 8. Validate schema boundary of payload under lock
      validateArtifactBoundary(this.repoDir, intent.kind, intent.artifact, {
        runId: intent.runId,
        taskId: lockedRun.taskId,
        cycle: intent.cycle,
        expectedTreeDigest: freshTreeDigest,
        expectedBaseCommit: lockedRun.baseCommit,
      });

      // 9. Return duplicate if candidate, otherwise atomically write to disk (Architecture Decision BK)
      if (duplicateCandidate && existingArtifactDigest) {
        return { path: targetPath, digest: existingArtifactDigest, isDuplicate: true };
      }

      return this.#writeArtifactAtomicLocked(
        intent.runId,
        runDir,
        targetPath,
        intent.kind,
        intent.artifact as unknown as Record<string, unknown>
      );
    });
  }

  /**
   * Generic artifact writer for non-state-driving runtime artifacts (e.g. diagnostic receipts).
   * Strictly rejects state-driving artifact kinds (TEST_RESULT, DIFF_MANIFEST, REVIEW_REQUEST,
   * REVIEW_RESULT, BASELINE, REPAIR_INIT, CLOSEOUT, NEXT_TASK, RUN) with
   * StateDrivingArtifactRequiresTypedWriterError to prevent canonical path squatting (Architecture Decisions BE, BG).
   * Generic artifacts are strictly marked UNVERIFIED_EXTERNAL.
   */
  public async recordArtifact<T extends object>(
    runId: string,
    artifactType: string,
    data: T,
    options: RecordArtifactOptions = {}
  ): Promise<RecordArtifactResult> {
    validateRunId(runId);
    const runPath = this.getArtifactPath(runId, ArtifactKind.RUN);
    if (!existsSync(runPath)) {
      throw new ArtifactValidationError(
        `Cannot record artifact '${artifactType}' for unknown or non-existent run '${runId}'`
      );
    }

    const { kind, cycle } = parseArtifactKindAndCycle(artifactType, options.cycle);
    const targetPath = this.getArtifactPath(runId, kind, cycle);
    const runDir = dirname(targetPath);
    assertNoSymlinkAncestors(this.repoDir, targetPath);

    if (kind === ArtifactKind.RUN) {
      throw new ArtifactValidationError(
        `Artifact kind 'run' cannot be recorded via recordArtifact; run state is managed strictly by orchestrator operations`
      );
    }

    if (STATE_DRIVING_ARTIFACT_KINDS.has(kind)) {
      throw new StateDrivingArtifactRequiresTypedWriterError(kind);
    }

    if (options.authoritative === true) {
      throw new ArtifactValidationError("Generic recordArtifact cannot mark evidence authoritative");
    }
    const payload = { ...(data as Record<string, unknown>) };
    if (payload.trustClassification === "STRUCTURE_VALID_EXTERNAL") {
      throw new ArtifactValidationError(
        "Generic recordArtifact cannot write STRUCTURE_VALID_EXTERNAL trustClassification"
      );
    }

    const run = await this.getRun(runId);
    if (options.taskId && run.taskId !== options.taskId) {
      throw new ArtifactValidationError(
        `Cannot record artifact '${artifactType}': taskId mismatch (payload/options '${options.taskId}', run '${run.taskId}')`
      );
    }

    payload.trustClassification = "UNVERIFIED_EXTERNAL";

    validateArtifactBoundary(this.repoDir, kind, payload, {
      runId,
      taskId: options.taskId,
      cycle,
      expectedTreeDigest: options.expectedTreeDigest,
      expectedBaseCommit: options.expectedBaseCommit,
    });

    return this.#withRunLock(runDir, async () => {
      return this.#writeArtifactAtomicLocked(runId, runDir, targetPath, kind, payload);
    });
  }

  /**
   * Records validated test result evidence with self-enforced invariants (Architecture Decision BD).
   * Fully validates run existence, schema, unique active run, Git authority, state (TESTING),
   * cycle, base commit, and working tree binding before writing STRUCTURE_VALID_EXTERNAL evidence.
   */
  public async recordTestResult(
    runId: string,
    testResult: {
      command: string;
      exitCode: number;
      status: "PASS" | "FAIL";
      output?: string;
      startedAt: string;
      completedAt: string;
      logDigest: string;
      cycle?: number;
      executionSnapshotVersion?: string;
      executionSnapshotDigest?: string;
      boundTreeDigest?: string;
      taskId?: string;
      runId?: string;
    },
    options: RecordArtifactOptions = {}
  ): Promise<RecordArtifactResult> {
    validateRunId(runId);
    const runPath = this.getArtifactPath(runId, ArtifactKind.RUN);
    if (!existsSync(runPath)) {
      throw new ArtifactValidationError(
        `Cannot record test result for unknown or non-existent run '${runId}'`
      );
    }
    const run = await this.getRun(runId);
    validateArtifactBoundary(this.repoDir, ArtifactKind.RUN, run, { runId, taskId: run.taskId });

    const active = await this.resolveActiveRunForTask(run.taskId);
    if (!active || active.runId !== runId) {
      throw new AmbiguousActiveRunError(`Run '${runId}' is not the unique active run for task '${run.taskId}'`);
    }

    if (run.state !== CindyState.TESTING) {
      throw new ArtifactValidationError(`Cannot record 'test-result' from state '${run.state}'; run must be in TESTING`);
    }

    if (testResult.status === "PASS" && testResult.exitCode !== 0) {
      throw new ArtifactValidationError(`Test result status PASS requires exitCode 0, got ${testResult.exitCode}`);
    }

    if (!testResult.executionSnapshotVersion) {
      throw new ArtifactValidationError("Test result missing required executionSnapshotVersion");
    }
    if (testResult.executionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1) {
      throw new ArtifactValidationError(
        `Test result executionSnapshotVersion mismatch: payload has '${testResult.executionSnapshotVersion}', expected '${CINDY_EXECUTION_SNAPSHOT_V1}'`
      );
    }
    if (!testResult.executionSnapshotDigest) {
      throw new ArtifactValidationError("Test result missing required executionSnapshotDigest");
    }
    if (!/^[0-9a-f]{64}$/.test(testResult.executionSnapshotDigest)) {
      throw new ArtifactValidationError(
        `Test result executionSnapshotDigest must be a 64-character lowercase hex string, got '${testResult.executionSnapshotDigest}'`
      );
    }

    if (testResult.taskId && testResult.taskId !== run.taskId) {
      throw new ArtifactValidationError(`Test result taskId mismatch: payload has '${testResult.taskId}', expected '${run.taskId}'`);
    }
    if (options.taskId && options.taskId !== run.taskId) {
      throw new ArtifactValidationError(`Test result taskId mismatch: options has '${options.taskId}', expected '${run.taskId}'`);
    }
    if (testResult.runId && testResult.runId !== runId) {
      throw new ArtifactValidationError(`Test result runId mismatch: payload has '${testResult.runId}', expected '${runId}'`);
    }

    const targetCycle = testResult.cycle ?? options.cycle ?? run.currentCycle;
    if (targetCycle !== run.currentCycle) {
      throw new ArtifactValidationError(`Test result cycle mismatch: cycle ${targetCycle} does not match run.currentCycle ${run.currentCycle}`);
    }
    if (testResult.cycle !== undefined && testResult.cycle !== run.currentCycle) {
      throw new ArtifactValidationError(`Test result cycle mismatch: payload has cycle ${testResult.cycle}, expected ${run.currentCycle}`);
    }
    if (options.cycle !== undefined && options.cycle !== run.currentCycle) {
      throw new ArtifactValidationError(`Test result cycle mismatch: options has cycle ${options.cycle}, expected ${run.currentCycle}`);
    }

    const authoritativeTree = await computeTreeDigest(this.repoDir);
    const liveSnapshot = await computeAuthoritativeExecutionSnapshot(
      this.repoDir,
      run.taskId,
      { expectedHeadCommit: run.headCommit }
    );

    const executionSnapshotVersion = testResult.executionSnapshotVersion;
    if (options.expectedExecutionSnapshotVersion && options.expectedExecutionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1) {
      throw new ArtifactValidationError(
        `Test result expectedExecutionSnapshotVersion mismatch: expected '${options.expectedExecutionSnapshotVersion}', but current algorithm version is '${CINDY_EXECUTION_SNAPSHOT_V1}'`
      );
    }

    const executionSnapshotDigest = testResult.executionSnapshotDigest;
    if (executionSnapshotDigest !== liveSnapshot.digest) {
      throw new ArtifactDigestMismatchError(
        `Test result executionSnapshotDigest ('${executionSnapshotDigest}') does not match authoritative execution snapshot digest ('${liveSnapshot.digest}')`
      );
    }
    if (options.expectedExecutionSnapshotDigest && options.expectedExecutionSnapshotDigest !== liveSnapshot.digest) {
      throw new ArtifactDigestMismatchError(
        `Test result expectedExecutionSnapshotDigest ('${options.expectedExecutionSnapshotDigest}') does not match authoritative execution snapshot digest ('${liveSnapshot.digest}')`
      );
    }
    if (testResult.boundTreeDigest && testResult.boundTreeDigest !== authoritativeTree) {
      throw new ArtifactDigestMismatchError(
        `Test result boundTreeDigest ('${testResult.boundTreeDigest}') does not match authoritative working tree digest ('${authoritativeTree}')`
      );
    }
    if (options.expectedTreeDigest && options.expectedTreeDigest !== authoritativeTree) {
      throw new ArtifactDigestMismatchError(
        `Test result expectedTreeDigest ('${options.expectedTreeDigest}') does not match authoritative working tree digest ('${authoritativeTree}')`
      );
    }
    if (options.expectedBaseCommit && options.expectedBaseCommit !== run.baseCommit) {
      throw new ArtifactValidationError(`Test result base commit mismatch: expected '${options.expectedBaseCommit}', run has '${run.baseCommit}'`);
    }

    const authority = evaluateGitAuthority({
      repoDir: this.repoDir,
      taskId: run.taskId,
      runSnapshot: {
        branch: run.branch,
        headCommit: run.headCommit,
        baseCommit: run.baseCommit,
        taskAuthorityCommit: run.taskAuthorityCommit,
        upstreamRef: run.upstreamRef,
        upstreamCommit: run.upstreamCommit,
        upstreamSha: run.upstreamSha,
        allowedScope: run.allowedScope,
      },
    });
    if (!authority.ok) {
      throw new TransitionRejectedError(`Cannot record test result: ${authority.stopExplanation}`);
    }

    if (testResult.status === "PASS" && testResult.exitCode !== 0) {
      throw new ArtifactValidationError(`Test result status PASS requires exitCode 0, got ${testResult.exitCode}`);
    }

    const payload: TestResultArtifact = {
      runId: run.runId,
      taskId: run.taskId,
      cycle: targetCycle,
      command: testResult.command,
      exitCode: testResult.exitCode,
      status: testResult.status,
      startedAt: testResult.startedAt,
      completedAt: testResult.completedAt,
      logDigest: testResult.logDigest,
      executionSnapshotVersion,
      executionSnapshotDigest,
      boundTreeDigest: authoritativeTree,
      trustClassification: "STRUCTURE_VALID_EXTERNAL",
    };

    return this.#writeTypedArtifactAtomic({
      kind: ArtifactKind.TEST_RESULT,
      runId,
      artifact: payload,
      expectedRunVersion: run.version,
      expectedState: CindyState.TESTING,
      cycle: targetCycle,
      expectedExecutionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      expectedExecutionSnapshotDigest: liveSnapshot.digest,
      expectedTreeDigest: authoritativeTree,
      expectedBaseCommit: run.baseCommit,
    });
  }

  /**
   * Computes authoritative live diff and tree digests, validates scope ownership,
   * and records a diff-manifest artifact with STRUCTURE_VALID_EXTERNAL trust classification.
   */
  public async recordDiffManifest(
    runId: string,
    optionsOrPayload: {
      cycle?: number;
      expectedExecutionSnapshotVersion?: string;
      expectedExecutionSnapshotDigest?: string;
      executionSnapshotVersion?: string;
      executionSnapshotDigest?: string;
      expectedTreeDigest?: string;
      expectedBaseCommit?: string;
      taskId?: string;
      runId?: string;
      baseCommit?: string;
      changedFiles?: string[];
      untrackedFiles?: string[];
      stagedFiles?: string[];
      unstagedFiles?: string[];
      deletedFiles?: string[];
      renamedFiles?: Array<{ from: string; to: string }>;
      allowedScope?: string[];
      isWithinScope?: boolean;
      unexplainedFiles?: string[];
      diffDigest?: string;
      boundTreeDigest?: string;
      recordedAt?: string;
    } = {}
  ): Promise<RecordArtifactResult> {
    validateRunId(runId);
    const runPath = this.getArtifactPath(runId, ArtifactKind.RUN);
    if (!existsSync(runPath)) {
      throw new ArtifactValidationError(
        `Cannot record diff manifest for unknown or non-existent run '${runId}'`
      );
    }
    const run = await this.getRun(runId);
    validateArtifactBoundary(this.repoDir, ArtifactKind.RUN, run, { runId, taskId: run.taskId });

    const active = await this.resolveActiveRunForTask(run.taskId);
    if (!active || active.runId !== runId) {
      throw new AmbiguousActiveRunError(`Run '${runId}' is not the unique active run for task '${run.taskId}'`);
    }

    if (run.state !== CindyState.TESTING) {
      throw new ArtifactValidationError(`Cannot record 'diff-manifest' from state '${run.state}'; run must be in TESTING`);
    }

    if (!optionsOrPayload.executionSnapshotVersion) {
      throw new ArtifactValidationError("Diff manifest missing required executionSnapshotVersion");
    }
    if (optionsOrPayload.executionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1) {
      throw new ArtifactValidationError(
        `Diff manifest executionSnapshotVersion mismatch: payload has '${optionsOrPayload.executionSnapshotVersion}', expected '${CINDY_EXECUTION_SNAPSHOT_V1}'`
      );
    }
    if (!optionsOrPayload.executionSnapshotDigest) {
      throw new ArtifactValidationError("Diff manifest missing required executionSnapshotDigest");
    }
    if (!/^[0-9a-f]{64}$/.test(optionsOrPayload.executionSnapshotDigest)) {
      throw new ArtifactValidationError(
        `Diff manifest executionSnapshotDigest must be a 64-character lowercase hex string: '${optionsOrPayload.executionSnapshotDigest}'`
      );
    }

    const authority = evaluateGitAuthority({
      repoDir: this.repoDir,
      taskId: run.taskId,
      runSnapshot: {
        branch: run.branch,
        headCommit: run.headCommit,
        baseCommit: run.baseCommit,
        taskAuthorityCommit: run.taskAuthorityCommit,
        upstreamRef: run.upstreamRef,
        upstreamCommit: run.upstreamCommit,
        upstreamSha: run.upstreamSha,
        allowedScope: run.allowedScope,
      },
    });
    if (!authority.ok) {
      throw new TransitionRejectedError(`Cannot record diff manifest: ${authority.stopExplanation}`);
    }

    const targetCycle = optionsOrPayload.cycle ?? run.currentCycle;
    if (targetCycle !== run.currentCycle) {
      throw new ArtifactValidationError(`Diff manifest cycle mismatch: cycle ${targetCycle} does not match run.currentCycle ${run.currentCycle}`);
    }

    const currentTreeDigest = await computeTreeDigest(this.repoDir);
    const liveSnapshot = await computeAuthoritativeExecutionSnapshot(
      this.repoDir,
      run.taskId,
      { expectedHeadCommit: run.headCommit }
    );
    const currentDiffDigest = await computeDiffDigest(this.repoDir);
    const gitStatus = getGitStatus(this.repoDir);
    const ownership = checkDirtyTreeOwnership(run.allowedScope, gitStatus.dirtyFiles, this.repoDir);

    if (optionsOrPayload.expectedExecutionSnapshotVersion !== undefined) {
      if (optionsOrPayload.expectedExecutionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1) {
        throw new ArtifactValidationError(
          `Diff manifest expectedExecutionSnapshotVersion mismatch: expected '${optionsOrPayload.expectedExecutionSnapshotVersion}', but current algorithm version is '${CINDY_EXECUTION_SNAPSHOT_V1}'`
        );
      }
    }
    if (optionsOrPayload.executionSnapshotVersion !== undefined) {
      if (optionsOrPayload.executionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1) {
        throw new ArtifactValidationError(
          `Diff manifest executionSnapshotVersion mismatch: payload has '${optionsOrPayload.executionSnapshotVersion}', expected '${CINDY_EXECUTION_SNAPSHOT_V1}'`
        );
      }
      if (
        optionsOrPayload.expectedExecutionSnapshotVersion !== undefined &&
        optionsOrPayload.expectedExecutionSnapshotVersion !== optionsOrPayload.executionSnapshotVersion
      ) {
        throw new ArtifactValidationError("Diff manifest expectedExecutionSnapshotVersion and executionSnapshotVersion mismatch");
      }
    }
    if (optionsOrPayload.expectedExecutionSnapshotDigest !== undefined) {
      if (!/^[0-9a-f]{64}$/.test(optionsOrPayload.expectedExecutionSnapshotDigest)) {
        throw new ArtifactValidationError(
          `Diff manifest expectedExecutionSnapshotDigest must be a 64-character lowercase hex string: '${optionsOrPayload.expectedExecutionSnapshotDigest}'`
        );
      }
      if (optionsOrPayload.expectedExecutionSnapshotDigest !== liveSnapshot.digest) {
        throw new ArtifactDigestMismatchError(
          `Diff manifest expectedExecutionSnapshotDigest ('${optionsOrPayload.expectedExecutionSnapshotDigest}') does not match authoritative execution snapshot digest ('${liveSnapshot.digest}')`
        );
      }
    }
    if (optionsOrPayload.executionSnapshotDigest !== undefined) {
      if (!/^[0-9a-f]{64}$/.test(optionsOrPayload.executionSnapshotDigest)) {
        throw new ArtifactValidationError(
          `Diff manifest executionSnapshotDigest must be a 64-character lowercase hex string: '${optionsOrPayload.executionSnapshotDigest}'`
        );
      }
      if (optionsOrPayload.executionSnapshotDigest !== liveSnapshot.digest) {
        throw new ArtifactDigestMismatchError(
          `Diff manifest executionSnapshotDigest ('${optionsOrPayload.executionSnapshotDigest}') does not match authoritative execution snapshot digest ('${liveSnapshot.digest}')`
        );
      }
      if (
        optionsOrPayload.expectedExecutionSnapshotDigest !== undefined &&
        optionsOrPayload.expectedExecutionSnapshotDigest !== optionsOrPayload.executionSnapshotDigest
      ) {
        throw new ArtifactDigestMismatchError("Diff manifest expectedExecutionSnapshotDigest and executionSnapshotDigest mismatch");
      }
    }
    if (optionsOrPayload.expectedTreeDigest && optionsOrPayload.expectedTreeDigest !== currentTreeDigest) {
      throw new ArtifactDigestMismatchError(
        `Diff manifest expectedTreeDigest ('${optionsOrPayload.expectedTreeDigest}') does not match authoritative working tree digest ('${currentTreeDigest}')`
      );
    }
    if (optionsOrPayload.boundTreeDigest && optionsOrPayload.boundTreeDigest !== currentTreeDigest) {
      throw new ArtifactDigestMismatchError(
        `Diff manifest boundTreeDigest ('${optionsOrPayload.boundTreeDigest}') does not match authoritative working tree digest ('${currentTreeDigest}')`
      );
    }
    if (optionsOrPayload.diffDigest && optionsOrPayload.diffDigest !== currentDiffDigest) {
      throw new ArtifactDigestMismatchError(
        `Diff manifest diffDigest ('${optionsOrPayload.diffDigest}') does not match authoritative diff digest ('${currentDiffDigest}')`
      );
    }
    if (optionsOrPayload.expectedBaseCommit && optionsOrPayload.expectedBaseCommit !== run.baseCommit) {
      throw new ArtifactValidationError(`Diff manifest base commit mismatch: expected '${optionsOrPayload.expectedBaseCommit}', run has '${run.baseCommit}'`);
    }
    if (optionsOrPayload.baseCommit && optionsOrPayload.baseCommit !== run.baseCommit) {
      throw new ArtifactValidationError(`Diff manifest base commit mismatch: payload has '${optionsOrPayload.baseCommit}', expected '${run.baseCommit}'`);
    }
    if (optionsOrPayload.taskId && optionsOrPayload.taskId !== run.taskId) {
      throw new ArtifactValidationError(`Diff manifest taskId mismatch: payload has '${optionsOrPayload.taskId}', expected '${run.taskId}'`);
    }
    if (optionsOrPayload.runId && optionsOrPayload.runId !== runId) {
      throw new ArtifactValidationError(`Diff manifest runId mismatch: payload has '${optionsOrPayload.runId}', expected '${runId}'`);
    }
    if (optionsOrPayload.changedFiles && canonicalizeJson(optionsOrPayload.changedFiles) !== canonicalizeJson(gitStatus.dirtyFiles)) {
      throw new ArtifactValidationError("Diff manifest changedFiles do not match live git status");
    }
    if (optionsOrPayload.allowedScope && canonicalizeJson(optionsOrPayload.allowedScope) !== canonicalizeJson(run.allowedScope)) {
      throw new ArtifactValidationError("Diff manifest allowedScope does not match run allowedScope");
    }
    if (optionsOrPayload.isWithinScope !== undefined && optionsOrPayload.isWithinScope !== ownership.ok) {
      throw new ArtifactValidationError("Diff manifest isWithinScope does not match authoritative scope ownership check");
    }
    if (optionsOrPayload.unexplainedFiles && canonicalizeJson(optionsOrPayload.unexplainedFiles) !== canonicalizeJson(ownership.unexplainedFiles)) {
      throw new ArtifactValidationError("Diff manifest unexplainedFiles do not match authoritative scope ownership check");
    }

    const changedFiles = gitStatus.dirtyFiles;
    const untrackedFiles = gitStatus.entries.filter((e) => e.isUntracked).map((e) => e.path);
    const stagedFiles = gitStatus.entries.filter((e) => e.isStaged).map((e) => e.path);
    const unstagedFiles = gitStatus.entries.filter((e) => e.isUnstaged).map((e) => e.path);
    const deletedFiles = gitStatus.entries.filter((e) => e.isDeleted).map((e) => e.path);
    const renamedFiles = gitStatus.entries
      .filter((e) => e.isRenamed && e.origPath)
      .map((e) => ({ from: e.origPath!, to: e.path }));

    let recordedAt = optionsOrPayload.recordedAt;
    if (!recordedAt) {
      const existing = await this.readArtifact<DiffManifestArtifact>(runId, ArtifactKind.DIFF_MANIFEST, targetCycle);
      if (existing?.recordedAt) {
        recordedAt = existing.recordedAt;
      }
    }
    if (!recordedAt) {
      recordedAt = new Date().toISOString();
    }

    const payload: DiffManifestArtifact = {
      runId,
      taskId: run.taskId,
      baseCommit: run.baseCommit,
      changedFiles,
      untrackedFiles,
      stagedFiles,
      unstagedFiles,
      deletedFiles,
      renamedFiles,
      allowedScope: run.allowedScope,
      isWithinScope: ownership.ok,
      unexplainedFiles: ownership.unexplainedFiles,
      diffDigest: currentDiffDigest,
      executionSnapshotVersion: optionsOrPayload.executionSnapshotVersion,
      executionSnapshotDigest: optionsOrPayload.executionSnapshotDigest,
      boundTreeDigest: currentTreeDigest,
      recordedAt,
      trustClassification: "STRUCTURE_VALID_EXTERNAL",
    };

    return this.#writeTypedArtifactAtomic({
      kind: ArtifactKind.DIFF_MANIFEST,
      runId,
      artifact: payload,
      expectedRunVersion: run.version,
      expectedState: CindyState.TESTING,
      cycle: targetCycle,
      expectedExecutionSnapshotVersion: optionsOrPayload.expectedExecutionSnapshotVersion ?? optionsOrPayload.executionSnapshotVersion,
      expectedExecutionSnapshotDigest: optionsOrPayload.expectedExecutionSnapshotDigest ?? optionsOrPayload.executionSnapshotDigest,
      expectedTreeDigest: currentTreeDigest,
      expectedBaseCommit: run.baseCommit,
    });
  }

  /**
   * Records a validated review-request artifact with STRUCTURE_VALID_EXTERNAL trust classification.
   */
  public async recordReviewRequest(
    runId: string,
    options: {
      reviewer: {
        identity: string;
        session?: string;
        readOnlyConfirmed: boolean;
        readOnlyRequired?: boolean;
      };
      cycle?: number;
      expectedExecutionSnapshotVersion?: string;
      expectedExecutionSnapshotDigest?: string;
      executionSnapshotVersion?: string;
      executionSnapshotDigest?: string;
      expectedTreeDigest?: string;
      expectedBaseCommit?: string;
      taskId?: string;
      runId?: string;
      baseCommit?: string;
      boundTreeDigest?: string;
      requestedAt?: string;
    }
  ): Promise<RecordArtifactResult> {
    validateRunId(runId);
    const runPath = this.getArtifactPath(runId, ArtifactKind.RUN);
    if (!existsSync(runPath)) {
      throw new ArtifactValidationError(
        `Cannot record review request for unknown or non-existent run '${runId}'`
      );
    }
    const run = await this.getRun(runId);
    validateArtifactBoundary(this.repoDir, ArtifactKind.RUN, run, { runId, taskId: run.taskId });

    const active = await this.resolveActiveRunForTask(run.taskId);
    if (!active || active.runId !== runId) {
      throw new AmbiguousActiveRunError(`Run '${runId}' is not the unique active run for task '${run.taskId}'`);
    }

    if (run.state !== CindyState.READY_FOR_REVIEW) {
      throw new ArtifactValidationError(`Cannot record 'review-request' from state '${run.state}'; run must be in READY_FOR_REVIEW`);
    }

    if (!options.executionSnapshotVersion) {
      throw new ArtifactValidationError("Review request missing required executionSnapshotVersion");
    }
    if (options.executionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1) {
      throw new ArtifactValidationError(
        `Review request executionSnapshotVersion ('${options.executionSnapshotVersion}') does not match authoritative snapshot version ('${CINDY_EXECUTION_SNAPSHOT_V1}')`
      );
    }
    if (!options.executionSnapshotDigest) {
      throw new ArtifactValidationError("Review request missing required executionSnapshotDigest");
    }
    if (!/^[0-9a-f]{64}$/.test(options.executionSnapshotDigest)) {
      throw new ArtifactValidationError(
        `Review request executionSnapshotDigest must be a 64-character lowercase hex string, got '${options.executionSnapshotDigest}'`
      );
    }

    const authority = evaluateGitAuthority({
      repoDir: this.repoDir,
      taskId: run.taskId,
      runSnapshot: {
        branch: run.branch,
        headCommit: run.headCommit,
        baseCommit: run.baseCommit,
        taskAuthorityCommit: run.taskAuthorityCommit,
        upstreamRef: run.upstreamRef,
        upstreamCommit: run.upstreamCommit,
        upstreamSha: run.upstreamSha,
        allowedScope: run.allowedScope,
      },
    });
    if (!authority.ok) {
      throw new TransitionRejectedError(`Cannot record review request: ${authority.stopExplanation}`);
    }

    if (!options.reviewer || typeof options.reviewer !== "object") {
      throw new ArtifactValidationError("Review request missing reviewer");
    }
    if (!options.reviewer.identity || typeof options.reviewer.identity !== "string" || options.reviewer.identity.trim().length === 0) {
      throw new ArtifactValidationError("Reviewer identity must be a non-empty string");
    }
    if (!options.reviewer.session || typeof options.reviewer.session !== "string" || options.reviewer.session.trim().length === 0) {
      throw new ArtifactValidationError("Reviewer session must be a non-empty string");
    }
    if (options.reviewer.readOnlyConfirmed !== true) {
      throw new ArtifactValidationError("Reviewer must confirm read-only mode");
    }

    const currentTreeDigest = await computeTreeDigest(this.repoDir);
    const liveSnapshot = await computeAuthoritativeExecutionSnapshot(
      this.repoDir,
      run.taskId,
      { expectedHeadCommit: run.headCommit }
    );
    const executionSnapshotVersion = options.executionSnapshotVersion;
    if (options.expectedExecutionSnapshotVersion && options.expectedExecutionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1) {
      throw new ArtifactValidationError(
        `Review request expectedExecutionSnapshotVersion ('${options.expectedExecutionSnapshotVersion}') does not match authoritative snapshot version ('${CINDY_EXECUTION_SNAPSHOT_V1}')`
      );
    }

    const executionSnapshotDigest = options.executionSnapshotDigest;
    if (executionSnapshotDigest !== liveSnapshot.digest) {
      throw new ArtifactDigestMismatchError(
        `Review request executionSnapshotDigest ('${executionSnapshotDigest}') does not match authoritative execution snapshot digest ('${liveSnapshot.digest}')`
      );
    }
    if (options.expectedExecutionSnapshotDigest && options.expectedExecutionSnapshotDigest !== liveSnapshot.digest) {
      throw new ArtifactDigestMismatchError(
        `Review request expectedExecutionSnapshotDigest ('${options.expectedExecutionSnapshotDigest}') does not match authoritative execution snapshot digest ('${liveSnapshot.digest}')`
      );
    }
    if (options.expectedTreeDigest && options.expectedTreeDigest !== currentTreeDigest) {
      throw new ArtifactDigestMismatchError(
        `Review request expectedTreeDigest ('${options.expectedTreeDigest}') does not match authoritative working tree digest ('${currentTreeDigest}')`
      );
    }
    if (options.boundTreeDigest && options.boundTreeDigest !== currentTreeDigest) {
      throw new ArtifactDigestMismatchError(
        `Review request boundTreeDigest ('${options.boundTreeDigest}') does not match authoritative working tree digest ('${currentTreeDigest}')`
      );
    }
    if (options.expectedBaseCommit && options.expectedBaseCommit !== run.baseCommit) {
      throw new ArtifactValidationError(`Review request base commit mismatch: expected '${options.expectedBaseCommit}', run has '${run.baseCommit}'`);
    }
    if (options.baseCommit && options.baseCommit !== run.baseCommit) {
      throw new ArtifactValidationError(`Review request base commit mismatch: payload has '${options.baseCommit}', expected '${run.baseCommit}'`);
    }
    if (options.taskId && options.taskId !== run.taskId) {
      throw new ArtifactValidationError(`Review request taskId mismatch: payload has '${options.taskId}', expected '${run.taskId}'`);
    }
    if (options.runId && options.runId !== runId) {
      throw new ArtifactValidationError(`Review request runId mismatch: payload has '${options.runId}', expected '${runId}'`);
    }

    const targetCycle = options.cycle ?? run.currentCycle;
    if (targetCycle !== run.currentCycle) {
      throw new ArtifactValidationError(`Review request cycle mismatch: cycle ${targetCycle} does not match run.currentCycle ${run.currentCycle}`);
    }

    let requestedAt = options.requestedAt;
    if (!requestedAt) {
      const existing = await this.readArtifact<ReviewRequestArtifact>(runId, ArtifactKind.REVIEW_REQUEST, targetCycle);
      if (existing?.requestedAt) {
        requestedAt = existing.requestedAt;
      }
    }
    if (!requestedAt) {
      requestedAt = new Date().toISOString();
    }

    const payload: ReviewRequestArtifact = {
      runId,
      taskId: run.taskId,
      baseCommit: run.baseCommit,
      cycle: targetCycle,
      reviewer: {
        identity: options.reviewer.identity,
        session: options.reviewer.session,
        readOnlyConfirmed: true,
        readOnlyRequired: options.reviewer.readOnlyRequired ?? true,
      },
      executionSnapshotVersion,
      executionSnapshotDigest,
      boundTreeDigest: currentTreeDigest,
      requestedAt,
      trustClassification: "STRUCTURE_VALID_EXTERNAL",
    };

    return this.#writeTypedArtifactAtomic({
      kind: ArtifactKind.REVIEW_REQUEST,
      runId,
      artifact: payload,
      expectedRunVersion: run.version,
      expectedState: CindyState.READY_FOR_REVIEW,
      cycle: targetCycle,
      expectedExecutionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      expectedExecutionSnapshotDigest: liveSnapshot.digest,
      expectedTreeDigest: currentTreeDigest,
      expectedBaseCommit: run.baseCommit,
    });
  }

  /**
   * Records a validated review-result artifact with STRUCTURE_VALID_EXTERNAL trust classification.
   * Self-enforces all invariants (Architecture Decision BD):
   * run exists, schema valid, state = REVIEWING (or approved idempotent replay state),
   * taskId, runId, review cycle, existing bound REVIEW_REQUEST, reviewer identity & session,
   * readOnlyConfirmed, baseCommit, head/tree/diff binding, staleness, immutable artifact conflict,
   * trustClassification internally fixed.
   */
  public async recordReviewResult(
    runId: string,
    review: ReviewResultArtifact,
    options: {
      cycle?: number;
      expectedExecutionSnapshotVersion?: string;
      expectedExecutionSnapshotDigest?: string;
      expectedTreeDigest?: string;
      expectedBaseCommit?: string;
      taskId?: string;
    } = {}
  ): Promise<RecordArtifactResult> {
    validateRunId(runId);
    const runPath = this.getArtifactPath(runId, ArtifactKind.RUN);
    if (!existsSync(runPath)) {
      throw new ArtifactValidationError(
        `Cannot record review result for unknown or non-existent run '${runId}'`
      );
    }
    const run = await this.getRun(runId);
    validateArtifactBoundary(this.repoDir, ArtifactKind.RUN, run, { runId, taskId: run.taskId });

    const active = await this.resolveActiveRunForTask(run.taskId);
    if (!active || active.runId !== runId) {
      throw new AmbiguousActiveRunError(`Run '${runId}' is not the unique active run for task '${run.taskId}'`);
    }

    const authority = evaluateGitAuthority({
      repoDir: this.repoDir,
      taskId: run.taskId,
      runSnapshot: {
        branch: run.branch,
        headCommit: run.headCommit,
        baseCommit: run.baseCommit,
        taskAuthorityCommit: run.taskAuthorityCommit,
        upstreamRef: run.upstreamRef,
        upstreamCommit: run.upstreamCommit,
        upstreamSha: run.upstreamSha,
        allowedScope: run.allowedScope,
      },
    });
    if (!authority.ok) {
      throw new TransitionRejectedError(`Cannot record review result: ${authority.stopExplanation}`);
    }

    const targetCycle = review.cycle ?? options.cycle ?? run.currentCycle;

    // Outer preflight canonical conflict check (Architecture Decision BL)
    const existingReview = await this.readArtifact<ReviewResultArtifact>(
      runId,
      ArtifactKind.REVIEW_RESULT,
      targetCycle
    );
    if (existingReview) {
      if (!review.executionSnapshotVersion || !review.executionSnapshotDigest) {
        throw new ArtifactValidationError("Review result missing mandatory snapshot fields");
      }
      const normalizedIncoming: ReviewResultArtifact = {
        ...review,
        runId,
        taskId: run.taskId,
        cycle: targetCycle,
        executionSnapshotVersion: review.executionSnapshotVersion,
        executionSnapshotDigest: review.executionSnapshotDigest,
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      };
      if (canonicalizeJson(existingReview) !== canonicalizeJson(normalizedIncoming)) {
        throw new ConflictingArtifactError(
          `Conflicting review result artifact for cycle ${targetCycle}: cannot overwrite existing result`
        );
      }
    }

    // Must be in REVIEWING, or if replaying an already-failed cycle in REPAIR_INITIALIZED
    const isReplayingFailedCycle =
      run.state === CindyState.REPAIR_INITIALIZED &&
      targetCycle === run.currentCycle - 1 &&
      review.verdict === "FAIL" &&
      existingReview !== null;

    if (run.state !== CindyState.REVIEWING && !isReplayingFailedCycle) {
      throw new TransitionRejectedError(
        `Cannot record review result from state '${run.state}'; run must be in REVIEWING`
      );
    }

    if (!review.executionSnapshotVersion) {
      throw new ArtifactValidationError("Review result missing required executionSnapshotVersion");
    }
    if (review.executionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1) {
      throw new ArtifactValidationError(
        `Review result executionSnapshotVersion ('${review.executionSnapshotVersion}') does not match authoritative snapshot version ('${CINDY_EXECUTION_SNAPSHOT_V1}')`
      );
    }
    if (!review.executionSnapshotDigest) {
      throw new ArtifactValidationError("Review result missing required executionSnapshotDigest");
    }
    if (!/^[0-9a-f]{64}$/.test(review.executionSnapshotDigest)) {
      throw new ArtifactValidationError(
        `Review result executionSnapshotDigest must be a 64-character lowercase hex string, got '${review.executionSnapshotDigest}'`
      );
    }

    if (review.taskId !== run.taskId || (options.taskId && options.taskId !== run.taskId)) {
      throw new ArtifactValidationError(
        `Review result taskId mismatch: payload has '${review.taskId}', expected '${run.taskId}'`
      );
    }
    if (review.runId !== runId) {
      throw new ArtifactValidationError(
        `Review result runId mismatch: payload has '${review.runId}', expected '${runId}'`
      );
    }
    if (!isReplayingFailedCycle && targetCycle !== run.currentCycle) {
      throw new ArtifactValidationError(
        `Review result cycle mismatch: payload has cycle ${targetCycle}, expected ${run.currentCycle}`
      );
    }
    if (options.cycle !== undefined && options.cycle !== targetCycle) {
      throw new ArtifactValidationError(
        `Review result cycle mismatch: options has cycle ${options.cycle}, expected ${targetCycle}`
      );
    }

    // Verify existing REVIEW_REQUEST on disk
    const reviewRequest = await this.readArtifact<ReviewRequestArtifact>(
      runId,
      ArtifactKind.REVIEW_REQUEST,
      targetCycle
    );
    if (!reviewRequest) {
      throw new ArtifactValidationError(
        `Missing bound REVIEW_REQUEST for run '${runId}' cycle ${targetCycle}`
      );
    }
    if (reviewRequest.trustClassification !== "STRUCTURE_VALID_EXTERNAL") {
      throw new ArtifactValidationError(
        `Review request for cycle ${targetCycle} is not STRUCTURE_VALID_EXTERNAL`
      );
    }
    if (reviewRequest.taskId !== run.taskId || reviewRequest.runId !== runId || reviewRequest.cycle !== targetCycle) {
      throw new ArtifactValidationError(
        `Review request binding mismatch for run '${runId}' cycle ${targetCycle}`
      );
    }
    if (reviewRequest.baseCommit !== run.baseCommit) {
      throw new ArtifactValidationError(
        `Review request base commit '${reviewRequest.baseCommit}' does not match run base commit '${run.baseCommit}'`
      );
    }

    if (!review.reviewer) {
      throw new ArtifactValidationError("Review result missing reviewer");
    }
    if (review.reviewer.readOnlyConfirmed !== true) {
      throw new ArtifactValidationError("Reviewer must confirm read-only mode");
    }
    if (review.reviewer.identity !== reviewRequest.reviewer.identity) {
      throw new ArtifactValidationError(
        `Review result reviewer identity mismatch: expected '${reviewRequest.reviewer.identity}', got '${review.reviewer.identity}'`
      );
    }
    if (review.reviewer.session !== reviewRequest.reviewer.session) {
      throw new ArtifactValidationError(
        `Review result reviewer session mismatch: expected '${reviewRequest.reviewer.session}', got '${review.reviewer.session}'`
      );
    }

    if (review.reviewedBaseCommit !== run.baseCommit) {
      throw new ArtifactValidationError(
        `Review result base commit mismatch: payload has '${review.reviewedBaseCommit}', expected '${run.baseCommit}'`
      );
    }
    if (options.expectedBaseCommit && options.expectedBaseCommit !== run.baseCommit) {
      throw new ArtifactValidationError(
        `Review result expectedBaseCommit mismatch: expected '${options.expectedBaseCommit}', run has '${run.baseCommit}'`
      );
    }

    const currentTreeDigest = await computeTreeDigest(this.repoDir);
    const liveSnapshot = await computeAuthoritativeExecutionSnapshot(
      this.repoDir,
      run.taskId,
      { expectedHeadCommit: run.headCommit }
    );
    if (!reviewRequest.executionSnapshotVersion || reviewRequest.executionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1) {
      throw new ArtifactValidationError("Bound review request missing or invalid executionSnapshotVersion");
    }
    if (!reviewRequest.executionSnapshotDigest || !/^[0-9a-f]{64}$/.test(reviewRequest.executionSnapshotDigest)) {
      throw new ArtifactValidationError("Bound review request missing or invalid executionSnapshotDigest");
    }
    if (reviewRequest.executionSnapshotDigest !== liveSnapshot.digest) {
      throw new ArtifactDigestMismatchError(
        `Working tree mutated after review request was created (request snapshot ${reviewRequest.executionSnapshotDigest}, current snapshot ${liveSnapshot.digest})`
      );
    }
    const executionSnapshotVersion = review.executionSnapshotVersion;
    const executionSnapshotDigest = review.executionSnapshotDigest;
    if (executionSnapshotDigest !== liveSnapshot.digest) {
      throw new ArtifactDigestMismatchError(
        `Review result executionSnapshotDigest ('${executionSnapshotDigest}') does not match authoritative execution snapshot digest ('${liveSnapshot.digest}')`
      );
    }
    if (options.expectedExecutionSnapshotVersion && options.expectedExecutionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1) {
      throw new ArtifactValidationError(
        `Review result expectedExecutionSnapshotVersion ('${options.expectedExecutionSnapshotVersion}') does not match authoritative snapshot version ('${CINDY_EXECUTION_SNAPSHOT_V1}')`
      );
    }
    if (options.expectedExecutionSnapshotDigest && options.expectedExecutionSnapshotDigest !== liveSnapshot.digest) {
      throw new ArtifactDigestMismatchError(
        `Review result expectedExecutionSnapshotDigest ('${options.expectedExecutionSnapshotDigest}') does not match authoritative execution snapshot digest ('${liveSnapshot.digest}')`
      );
    }
    if (reviewRequest.boundTreeDigest !== currentTreeDigest) {
      throw new ArtifactDigestMismatchError(
        `Working tree mutated after review request was created (request ${reviewRequest.boundTreeDigest}, current ${currentTreeDigest})`
      );
    }
    if (review.reviewedTreeDigest !== currentTreeDigest) {
      throw new ArtifactDigestMismatchError(
        `Review result reviewedTreeDigest ('${review.reviewedTreeDigest}') does not match authoritative working tree digest ('${currentTreeDigest}')`
      );
    }
    if (options.expectedTreeDigest && options.expectedTreeDigest !== currentTreeDigest) {
      throw new ArtifactDigestMismatchError(
        `Review result expectedTreeDigest ('${options.expectedTreeDigest}') does not match authoritative working tree digest ('${currentTreeDigest}')`
      );
    }

    const currentDiffDigest = await computeDiffDigest(this.repoDir);
    if (review.reviewedDiffDigest !== currentDiffDigest) {
      throw new ArtifactDigestMismatchError(
        `Review result reviewedDiffDigest ('${review.reviewedDiffDigest}') does not match authoritative diff digest ('${currentDiffDigest}')`
      );
    }

    const payload: ReviewResultArtifact = {
      ...review,
      runId,
      taskId: run.taskId,
      cycle: targetCycle,
      reviewedBaseCommit: run.baseCommit,
      executionSnapshotVersion,
      executionSnapshotDigest,
      reviewedTreeDigest: currentTreeDigest,
      reviewedDiffDigest: currentDiffDigest,
      trustClassification: "STRUCTURE_VALID_EXTERNAL",
    };

    return this.#writeTypedArtifactAtomic({
      kind: ArtifactKind.REVIEW_RESULT,
      runId,
      artifact: payload,
      expectedRunVersion: run.version,
      cycle: targetCycle,
      expectedExecutionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      expectedExecutionSnapshotDigest: liveSnapshot.digest,
      expectedTreeDigest: currentTreeDigest,
      expectedBaseCommit: run.baseCommit,
    });
  }

  /**
   * Initializes a new Cindy run safely within an atomic initialization lock,
   * enforcing strict runId/taskId validation, committed closure verification,
   * committed Task Packet baseline and scope binding, live Git authority checks,
   * exactness equality (actual HEAD == taskAuthorityCommit), scope/dirty tree evaluation,
   * active run uniqueness, and recording the baseline artifact (Decision U, T, Q, L).
   *
   * Raw run creation bypass is completely removed; all initializations must pass through
   * this single, authoritative, locked boundary.
   */
  public async initializeRunSafely(options: InitRunOptions): Promise<CindyRun> {
    const { runId, taskId } = options;

    validateRunId(runId);
    validateTaskId(taskId);

    const targetPath = this.getArtifactPath(runId, ArtifactKind.RUN);
    const finalRunDir = dirname(targetPath);
    assertNoSymlinkAncestors(this.repoDir, finalRunDir);

    if (existsSync(finalRunDir)) {
      throw new ConflictingArtifactError(
        `Run directory already exists for run '${runId}'; cannot initialize a new run`
      );
    }

    return this.withInitLock(async () => {
      assertNoSymlinkAncestors(this.repoDir, finalRunDir);
      if (existsSync(finalRunDir)) {
        throw new ConflictingArtifactError(
          `Run directory already exists for run '${runId}'; cannot initialize a new run`
        );
      }
      // Architecture Decision CX: Capture a single immutable authority commit first.
      // ALL commit-derived facts (closure, task packet, task history, taskAuthorityCommit)
      // must be anchored to this single captured commit. Mixing reads from different HEAD
      // states (A-closure + B-task-packet) is prohibited.
      const authorityHead = getGitHead(this.repoDir);
      validateStrictCommitSha(authorityHead);

      // 1. Committed closure authority: verify task is not already CLOSED at authorityHead (R2-03)
      // Anchored to authorityHead — not symbolic HEAD at read time.
      const closure = readCommittedClosure(taskId, this.repoDir, authorityHead);
      if (closure.isClosed) {
        throw new TransitionRejectedError(`Task ${taskId} is already CLOSED at ${authorityHead}; cannot re-execute`);
      }

      // 2. Read committed Task Packet strictly at authorityHead & derive taskAuthorityCommit
      // (R2-04, R2-06, Decision L, T, CX). All commit-derived facts anchored to authorityHead.
      const committedPacket = readCanonicalTaskPacketAtCommit(this.repoDir, taskId, authorityHead);
      const taskPacket = committedPacket.taskPacket;
      const taskAuthorityCommit = committedPacket.taskAuthorityCommit;

      // 3. Obtain actual Git facts directly from Git (R2-04)
      const actualBranch = getGitBranch(this.repoDir);
      if (!actualBranch || actualBranch === "HEAD") {
        throw new TransitionRejectedError("Detached HEAD is not permitted in Cindy control plane");
      }
      // actualHead must match authorityHead — any drift means the repo changed between capture and now.
      const actualHead = getGitHead(this.repoDir);
      if (actualHead !== authorityHead) {
        throw new TransitionRejectedError(
          `HEAD_DRIFT: Repository HEAD changed between authority capture ('${authorityHead}') and validation ('${actualHead}'); fail closed and retry as new invocation`
        );
      }

      // 4. Upstream resolution & evaluation preflight (Architecture Decision J)
      const upstreamStatus = checkGitUpstreamStatus(this.repoDir);
      const actualUpstream = upstreamStatus.upstream;
      if (!actualUpstream || !actualUpstream.commit || !actualUpstream.ref || upstreamStatus.divergence === "missing") {
        throw new TransitionRejectedError(
          `UPSTREAM_MISSING: No upstream configured for branch '${actualBranch}'`
        );
      }
      if (upstreamStatus.divergence === "ahead") {
        throw new TransitionRejectedError(
          `UPSTREAM_AHEAD: Local branch '${actualBranch}' is ahead of upstream by ${upstreamStatus.aheadCount} commit(s)`
        );
      }
      if (upstreamStatus.divergence === "behind") {
        throw new TransitionRejectedError(
          `UPSTREAM_BEHIND: Local branch '${actualBranch}' is behind upstream by ${upstreamStatus.behindCount} commit(s)`
        );
      }
      if (upstreamStatus.divergence === "diverged") {
        throw new TransitionRejectedError(
          `UPSTREAM_DIVERGED: Local branch '${actualBranch}' and upstream have diverged (+${upstreamStatus.aheadCount}/-${upstreamStatus.behindCount})`
        );
      }

      // 5. Branch authority & assertion validation (R2-04, H01)
      const taskBranch = taskPacket.branch;
      if (typeof taskBranch !== "string" || !taskBranch) {
        throw new TransitionRejectedError("Committed task packet branch is required");
      }
      if (actualBranch !== taskBranch) {
        throw new TransitionRejectedError(
          `Actual Git branch '${actualBranch}' does not match committed Task branch '${taskBranch}'`
        );
      }
      if (options.branch && options.branch !== actualBranch) {
        throw new TransitionRejectedError(
          `Caller branch '${options.branch}' does not match actual Git branch '${actualBranch}'`
        );
      }
      if (options.branch && options.branch !== taskBranch) {
        throw new TransitionRejectedError(
          `Caller branch '${options.branch}' cannot override committed Task branch '${taskBranch}'`
        );
      }

      // 6. Caller baseCommit assertion validation (H01: strictly required 40-hex SHA, no fallback)
      const taskBase = taskPacket.baseCommit;
      if (typeof taskBase !== "string" || !/^[0-9a-f]{40}$/.test(taskBase)) {
        throw new TransitionRejectedError("Committed task packet baseCommit is required and must be 40-char lowercase hex SHA");
      }
      if (options.baseCommit && options.baseCommit !== taskBase) {
        throw new TransitionRejectedError(
          `BASELINE_MISMATCH: Caller baseCommit '${options.baseCommit}' does not match committed task baseCommit '${taskBase}'`
        );
      }

      // 7. Baseline / Base commit authority ancestry validation (Architecture Decision X)
      if (!isGitAncestor(taskBase, taskAuthorityCommit, this.repoDir)) {
        throw new TransitionRejectedError(
          `BASELINE_DRIFT: committed Task baseline '${taskBase}' is not an ancestor of task authority commit '${taskAuthorityCommit}'`
        );
      }

      // 8. Exactness: actual HEAD must strictly equal taskAuthorityCommit (Architecture Decision X & L)
      if (actualHead !== taskAuthorityCommit) {
        throw new TransitionRejectedError(
          `TASK_BASELINE_DRIFT: Actual Git HEAD '${actualHead}' does not match task authority commit '${taskAuthorityCommit}'`
        );
      }

      // 9. Scope & dirty tree evaluation (R2-04, R2-06, Decision R, H01: canonical allowedScope required)
      const actualStatus = getGitStatus(this.repoDir);
      const authScope = taskPacket.allowedScope;
      if (!Array.isArray(authScope)) {
        throw new TransitionRejectedError("Committed task packet allowedScope is required and must be an array");
      }
      let effectiveScope: string[];

      if (options.allowedScope) {
        assertScopeNotBroadened(options.allowedScope, authScope, this.repoDir);
        effectiveScope = options.allowedScope.map((s) => validateScopeEntry(s, this.repoDir));
      } else {
        effectiveScope = authScope.map((s) => validateScopeEntry(s, this.repoDir));
      }

      if (!actualStatus.isClean) {
        const ownership = checkDirtyTreeOwnership(effectiveScope, actualStatus.dirtyFiles, this.repoDir);
        if (!ownership.ok) {
          throw new DirtyTreeUnexplainedError(ownership.unexplainedFiles);
        }
      }

      // 10. Check existing active run inside init critical section (Architecture Decisions I & M)
      const existingActive = await this.resolveActiveRunForTask(taskId);
      if (existingActive) {
        throw new ActiveRunExistsError(
          `ACTIVE_RUN_EXISTS: Active run '${existingActive.runId}' already exists for task '${taskId}'; cannot initialize a new run`
        );
      }

      // 11. All safety checks passed! Persist run and baseline snapshot
      const branch = taskBranch;
      const baseCommit = taskBase;
      const headCommit = actualHead;
      const treeDigest = await computeTreeDigest(this.repoDir);

      const now = new Date().toISOString();
      const run: CindyRun = {
        runId,
        taskId,
        version: 1,
        state: CindyState.TASK_INITIALIZED,
        currentCycle: 1,
        branch,
        baseCommit,
        headCommit,
        taskAuthorityCommit,
        upstreamRef: actualUpstream.ref,
        upstreamCommit: actualUpstream.commit,
        upstreamSha: actualUpstream.commit,
        allowedScope: effectiveScope,
        boundTreeDigest: treeDigest,
        stopReason: null,
        stopExplanation: null,
        history: [
          {
            fromState: CindyState.RECONCILING,
            toState: CindyState.TASK_INITIALIZED,
            timestamp: now,
            reason: "Run initialized",
          },
        ],
        createdAt: now,
        updatedAt: now,
      };

      const baseline: BaselineArtifact = {
        runId,
        taskId,
        branch,
        baseCommit,
        taskAuthorityCommit,
        upstreamRef: actualUpstream.ref,
        upstreamCommit: actualUpstream.commit,
        upstreamSha: actualUpstream.commit,
        initialTreeClean: actualStatus.isClean,
        initialTreeDigest: treeDigest,
        recordedAt: now,
      };

      const baselinePayload: Record<string, unknown> = {
        ...baseline,
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      };

      validateArtifactBoundary(this.repoDir, ArtifactKind.RUN, run, {
        runId,
        taskId,
      });

      validateArtifactBoundary(this.repoDir, ArtifactKind.BASELINE, baselinePayload, {
        runId,
        taskId,
        cycle: 1,
        expectedTreeDigest: treeDigest,
        expectedBaseCommit: baseCommit,
      });

      // 12. Preparation phase: prepare staging and runtime parent directories, write bundle (HIGH-01)
      const runtimeDir = dirname(finalRunDir);
      assertNoSymlinkAncestors(this.repoDir, runtimeDir);
      await mkdir(runtimeDir, { recursive: true });
      assertNoSymlinkAncestors(this.repoDir, runtimeDir);

      const stagingRoot = join(this.repoDir, ".agent", ".cindy-init-staging");
      assertNoSymlinkAncestors(this.repoDir, stagingRoot);
      await mkdir(stagingRoot, { recursive: true });
      assertNoSymlinkAncestors(this.repoDir, stagingRoot);

      const stagingDir = join(stagingRoot, `${runId}.${randomUUID()}`);
      await mkdir(stagingDir, { recursive: false });

      try {
        // Write baseline.json in staging
        const stagedBaselinePath = join(stagingDir, "baseline.json");
        const baselineJson = canonicalizeJson(baselinePayload);
        const baselineHandle = await open(stagedBaselinePath, "w");
        try {
          await baselineHandle.writeFile(baselineJson, "utf8");
          await baselineHandle.sync();
        } finally {
          await baselineHandle.close();
        }
        await chmod(stagedBaselinePath, 0o644);

        // Write run.json in staging
        const stagedRunPath = join(stagingDir, "run.json");
        const runJson = canonicalizeJson(run);
        const runHandle = await open(stagedRunPath, "w");
        try {
          await runHandle.writeFile(runJson, "utf8");
          await runHandle.sync();
        } finally {
          await runHandle.close();
        }
        await chmod(stagedRunPath, 0o644);

        // Verify staging bundle completeness and schema
        const stagedRunRaw = await readFile(stagedRunPath, "utf8");
        const stagedBaselineRaw = await readFile(stagedBaselinePath, "utf8");
        const parsedStagedRun = JSON.parse(stagedRunRaw) as CindyRun;
        const parsedStagedBaseline = JSON.parse(stagedBaselineRaw) as BaselineArtifact;

        if (parsedStagedRun.runId !== runId || parsedStagedBaseline.runId !== runId) {
          throw new ArtifactValidationError("Staged runId mismatch");
        }
        if (parsedStagedRun.taskId !== taskId || parsedStagedBaseline.taskId !== taskId) {
          throw new ArtifactValidationError("Staged taskId mismatch");
        }
        if (parsedStagedRun.baseCommit !== parsedStagedBaseline.baseCommit) {
          throw new ArtifactValidationError("Staged baseCommit mismatch");
        }
        if (parsedStagedRun.taskAuthorityCommit !== parsedStagedBaseline.taskAuthorityCommit) {
          throw new ArtifactValidationError("Staged taskAuthorityCommit mismatch");
        }
        if (
          parsedStagedRun.upstreamRef !== parsedStagedBaseline.upstreamRef ||
          parsedStagedRun.upstreamCommit !== parsedStagedBaseline.upstreamCommit
        ) {
          throw new ArtifactValidationError("Staged upstream binding mismatch");
        }

        validateArtifactBoundary(this.repoDir, ArtifactKind.RUN, parsedStagedRun, {
          runId,
          taskId,
        });
        validateArtifactBoundary(this.repoDir, ArtifactKind.BASELINE, parsedStagedBaseline, {
          runId,
          taskId,
          cycle: 1,
          expectedTreeDigest: treeDigest,
          expectedBaseCommit: baseCommit,
        });

        // Fsync staging directory
        const stagingDirHandle = await open(stagingDir, "r");
        try {
          await stagingDirHandle.sync();
        } finally {
          await stagingDirHandle.close();
        }

        if (typeof (this as any).onAfterStagingClose === "function") {
          await (this as any).onAfterStagingClose();
        }

        // =========================================================================
        // FINAL VALIDATION & ATOMIC PUBLICATION PHASE (M-R5-01 / HIGH-01)
        // Order:
        // 1. FINAL SNAPSHOT / TREE VALIDATION (with double sync stability check)
        // 2. FINAL GIT AUTHORITY VALIDATION (re-reading HEAD, branch, upstream, task packet, closure, status, dirty ownership)
        // 3. ATOMIC PUBLICATION (sync renameSync, zero awaited IO)
        // =========================================================================

        if (typeof (this as any).onBeforeFinalValidationFence === "function") {
          await (this as any).onBeforeFinalValidationFence();
        }

        assertNoSymlinkAncestors(this.repoDir, finalRunDir);
        if (existsSync(finalRunDir)) {
          throw new ConflictingArtifactError(
            `Run directory already exists for run '${runId}'; cannot publish staged run`
          );
        }

        // --- STEP 1: FINAL TREE / SNAPSHOT VALIDATION ---
        // Authoritative tree digest & stability check before final Git authority evaluation.
        // Performs double synchronous scan to ensure files did not mutate during or right after reading.
        const finalSnapshot1 = computeTreeSnapshotSync(this.repoDir);
        const finalTreeDigest1 = finalSnapshot1.digest;
        if (finalTreeDigest1 !== treeDigest) {
          throw new TransitionRejectedError(
            `STALE_TREE_BINDING: Authoritative tree digest changed during initialization (staged: '${treeDigest}', live: '${finalTreeDigest1}'); fail closed and retry as new invocation`
          );
        }

        // Tree stability verification: second synchronous pass ensuring consistency within validation interval
        const finalTreeDigest2 = computeTreeDigestSync(this.repoDir);
        if (finalTreeDigest2 !== finalTreeDigest1) {
          throw new TransitionRejectedError(
            `STALE_TREE_BINDING: Working tree mutated during final tree validation scan (pass 1: '${finalTreeDigest1}', pass 2: '${finalTreeDigest2}'); fail closed`
          );
        }

        // Architecture Decision M-R6-01: Post-read file identity fence.
        // Collect filesystem identity metadata (ino, size, mtimeMs) for all scanned regular files,
        // then verify none have changed since the content was read. This narrows the race window
        // between the last readFileSync and the atomic renameSync publication.
        const canonicalRepoDir = canonicalizeRepoDir(this.repoDir);
        const fileIdentities = finalSnapshot1.fileIdentities ?? collectFileIdentities(canonicalRepoDir, finalSnapshot1.manifest);
        verifyFileIdentityFence(canonicalRepoDir, fileIdentities, finalSnapshot1.manifest);

        // --- STEP 2: FINAL GIT AUTHORITY VALIDATION ---
        // Re-read and validate all Git authority facts AFTER tree scan:
        // HEAD, branch, upstreamRef, upstreamCommit, ahead/behind, task authority,
        // task packet identity, closure, git status, and dirty ownership.
        const publishFenceHead = getGitHead(this.repoDir);
        const publishFenceBranch = getGitBranch(this.repoDir);
        const finalUpstream = checkGitUpstreamStatus(this.repoDir);
        const finalPacket = readCanonicalTaskPacketAtCommit(this.repoDir, taskId, authorityHead);
        const finalClosure = readCommittedClosure(taskId, this.repoDir, publishFenceHead);

        if (
          publishFenceHead !== authorityHead ||
          publishFenceBranch !== branch ||
          finalPacket.taskAuthorityCommit !== taskAuthorityCommit ||
          finalUpstream.upstream?.ref !== actualUpstream.ref ||
          finalUpstream.upstream?.commit !== actualUpstream.commit ||
          finalUpstream.divergence !== "equal" ||
          finalClosure.isClosed ||
          JSON.stringify(finalPacket.taskPacket.allowedScope) !== JSON.stringify(taskPacket.allowedScope)
        ) {
          throw new TransitionRejectedError(
            "Live Git/Task authority or tree changed before initial run publish; fail closed (HEAD must remain at authorityHead throughout initialization)"
          );
        }

        // Fresh dirty ownership and index status check
        const finalStatus = getGitStatus(this.repoDir);
        if (!finalStatus.isClean) {
          const finalOwnership = checkDirtyTreeOwnership(effectiveScope, finalStatus.dirtyFiles, this.repoDir);
          if (!finalOwnership.ok) {
            throw new DirtyTreeUnexplainedError(finalOwnership.unexplainedFiles);
          }
        }

        // Fresh tree clean state consistency check
        if (finalStatus.isClean !== baseline.initialTreeClean) {
          throw new TransitionRejectedError(
            `Working tree clean state changed during initialization (initial: ${baseline.initialTreeClean}, final: ${finalStatus.isClean}); fail closed and retry as new invocation`
          );
        }

        // Final Freshness Seal (immediately before publication renameSync, Decision M-R6-01):
        verifyFileIdentityFence(canonicalRepoDir, fileIdentities, finalSnapshot1.manifest);

        // --- STEP 3: ATOMIC PUBLICATION PHASE ---
        // Immediate synchronous atomic rename without ANY ordinary awaited IO
        renameSync(stagingDir, finalRunDir);

        // Best-effort fsync of parent runtime directory
        try {
          const runtimeDirHandle = openSync(runtimeDir, "r");
          fsyncSync(runtimeDirHandle);
          closeSync(runtimeDirHandle);
        } catch {
          // best effort
        }

        return run;
      } catch (err) {
        // Clean up un-published staging directory on failure
        try {
          rmSync(stagingDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup error
        }
        throw err;
      }
    });
  }

  /**
   * Reads run state by runId.
   */
  public async getRun(runId: string): Promise<CindyRun> {
    const run = await this.readArtifact<CindyRun>(runId, ArtifactKind.RUN);
    if (!run) {
      throw new Error(`Cindy run not found: ${runId}`);
    }
    return run;
  }

  /**
   * Applies an administrative state transition to an existing run under run lock.
   * Rejects any transition to privileged states (FINAL_GATE, READY_TO_COMMIT,
   * COMMITTING, PUSHING, CLOSED, NEXT_TASK_SELECTED) or evidence-gated states.
   * Rejects generic transitions to forward execution states (Architecture Decision Z).
   */
  public async applyAdministrativeTransition(
    runId: string,
    targetState: CindyState,
    options: {
      reason?: string | undefined;
      boundTreeDigest?: string | undefined;
      expectedVersion?: number | undefined;
      stopReason?: CindyStopReason | CindyState | undefined;
      pausedFrom?: CindyState | undefined;
    } = {}
  ): Promise<CindyRun> {
    if (isPrivilegedState(targetState)) {
      throw new TransitionRejectedError(
        `Transition to privileged state '${targetState}' is sealed and prohibited in Control Plane MVP`
      );
    }
    if (isEvidenceGatedState(targetState)) {
      throw new TransitionRejectedError(
        `Direct transition to evidence-gated state '${targetState}' is rejected; must use dedicated orchestrator operation`
      );
    }
    if (
      targetState === CindyState.GIT_SAFETY_STOP ||
      targetState === CindyState.DIRTY_TREE_UNEXPLAINED
    ) {
      throw new TransitionRejectedError(
        `Cannot apply administrative transition to derived safety stop state '${targetState}'; derived safety stop states must be derived via deriveSafetyStop()`
      );
    }
    if (!isAdministrativePauseTarget(targetState)) {
      throw new TransitionRejectedError(
        `Administrative transition cannot choose non-administrative target '${targetState}'; target must be one of approved administrative pause states (BLOCKED, PRODUCT_DECISION_REQUIRED, CONTRACT_CONFLICT, MIGRATION_OR_SECURITY_AMBIGUITY)`
      );
    }
    return executeSemanticTransition(this, runId, {
      type: "administrative",
      targetState,
      ...options,
    });
  }

  /**
   * Controlled reconcile-driven resume transition (Decision K & O).
   * Executes stop-reason-specific policy and full live Git and task authority validation
   * at the mutation boundary, guaranteeing that deep imports cannot resume a run without passing
   * all authoritative checks.
   * Target state is strictly derived from trusted run.pausedFrom (caller cannot choose).
   */
  public async applyResumeTransition(
    runId: string,
    options: {
      reason?: string | undefined;
      boundTreeDigest?: string | undefined;
      expectedVersion?: number | undefined;
    } = {}
  ): Promise<CindyRun> {
    return executeSemanticTransition(this, runId, {
      type: "resume",
      ...options,
    });
  }

  /**
   * Read raw artifact from disk with schema and corruption checks.
   */
  public async readArtifact<T = unknown>(
    runId: string,
    artifactType: string,
    cycle?: number
  ): Promise<T | null> {
    const targetPath = this.getArtifactPath(runId, artifactType, cycle);
    if (!existsSync(targetPath)) {
      return null;
    }

    assertNoSymlinkAncestors(this.repoDir, targetPath);

    let content: string;
    try {
      content = await readFile(targetPath, "utf8");
    } catch (err: unknown) {
      throw new ArtifactCorruptionError(
        `Failed to read artifact ${targetPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!content || content.trim().length === 0) {
      throw new ArtifactCorruptionError(`Partial or empty artifact file: ${targetPath}`);
    }

    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch (err: unknown) {
      throw new ArtifactCorruptionError(
        `Malformed JSON in artifact ${targetPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    validateArtifactBoundary(this.repoDir, artifactType, data, {
      runId,
      cycle,
    });

    return data as T;
  }

  public async listArtifacts(runId: string): Promise<string[]> {
    const runDir = this.getRunDir(runId);
    if (!existsSync(runDir)) {
      return [];
    }
    const entries = await readdir(runDir);
    return entries
      .filter((e) => e.endsWith(".json") && !e.startsWith(".tmp_"))
      .sort((a, b) => a.localeCompare(b));
  }
}

async function writeRunAtomic(
  repoDir: string,
  runDir: string,
  targetPath: string,
  run: CindyRun
): Promise<RecordArtifactResult> {
  assertNoSymlinkAncestors(repoDir, targetPath);

  try {
    const stat = lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
      throw new PathTraversalError(`Artifact file cannot be a symbolic link: ${targetPath}`);
    }
  } catch (err: unknown) {
    if (err instanceof PathTraversalError) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const jsonString = canonicalizeJson(run);
  const digest = sha256(jsonString);

  const tempPath = join(runDir, `.tmp_run_${randomUUID()}.json`);
  const fileHandle = await open(tempPath, "w");
  try {
    await fileHandle.writeFile(jsonString, "utf8");
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }

  assertNoSymlinkAncestors(repoDir, targetPath);
  renameSync(tempPath, targetPath);
  try {
    const dirHandle = openSync(runDir, "r");
    fsyncSync(dirHandle);
    closeSync(dirHandle);
  } catch {
    // best effort
  }
  return { path: targetPath, digest, isDuplicate: false };
}

export type SemanticOperation =
  | {
      type: "markReadyForBuilder";
      reason?: string | undefined;
      boundTreeDigest?: string | undefined;
      expectedVersion?: number | undefined;
    }
  | {
      type: "startBuilding";
      reason?: string | undefined;
      boundTreeDigest?: string | undefined;
      expectedVersion?: number | undefined;
    }
  | {
      type: "completeBuilding";
      reason?: string | undefined;
      boundTreeDigest?: string | undefined;
      expectedVersion?: number | undefined;
    }
  | {
      type: "startTesting";
      reason?: string | undefined;
      boundTreeDigest?: string | undefined;
      expectedVersion?: number | undefined;
    }
  | {
      type: "startRepairBuilding";
      reason?: string | undefined;
      boundTreeDigest?: string | undefined;
      expectedVersion?: number | undefined;
    }
  | {
      type: "prepareForReview";
      reason?: string | undefined;
      expectedVersion?: number | undefined;
    }
  | {
      type: "startReview";
      reviewer?: {
        identity: string;
        session?: string | undefined;
        readOnlyConfirmed: boolean;
        readOnlyRequired?: boolean | undefined;
      } | undefined;
      expectedVersion?: number | undefined;
    }
  | {
      type: "recordValidatedReviewResult";
      verdict?: "PASS" | "FAIL" | undefined;
      review?: ReviewResultArtifact | undefined;
      expectedVersion?: number | undefined;
    }
  | {
      type: "deriveSafetyStop";
      expectedVersion?: number | undefined;
    }
  | {
      type: "administrative";
      targetState: CindyState;
      reason?: string | undefined;
      boundTreeDigest?: string | undefined;
      expectedVersion?: number | undefined;
      stopReason?: CindyStopReason | CindyState | undefined;
      pausedFrom?: CindyState | undefined;
    }
  | {
      type: "resume";
      reason?: string | undefined;
      boundTreeDigest?: string | undefined;
      expectedVersion?: number | undefined;
    };

export async function executeSemanticTransition(
  store: RuntimeArtifactStore,
  runId: string,
  op: SemanticOperation
): Promise<CindyRun> {
  validateRunId(runId);
  const targetPath = store.getArtifactPath(runId, ArtifactKind.RUN);
  const runDir = dirname(targetPath);

  // DECISION AU: Lock acquisition must not create unknown run
  // Before creating .run.lock / candidate lock, must verify:
  // runDir exists, run.json exists, run.json schema valid, runId match.
  if (!existsSync(runDir) || !existsSync(targetPath)) {
    throw new ArtifactValidationError(
      `Cannot execute semantic transition: unknown or non-existent run '${runId}'`
    );
  }

  let preRaw: string;
  try {
    preRaw = await readFile(targetPath, "utf8");
  } catch (err: unknown) {
    throw new InvalidRunRecordError(
      `INVALID_RUN_RECORD: Failed to read run file for '${runId}': ${err instanceof Error ? err.message : String(err)}`
    );
  }
  let preParsed: Record<string, unknown>;
  try {
    preParsed = JSON.parse(preRaw);
  } catch (err: unknown) {
    throw new InvalidRunRecordError(
      `INVALID_RUN_RECORD: Malformed JSON in run '${runId}': ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!preParsed || typeof preParsed !== "object" || preParsed.runId !== runId) {
    throw new InvalidRunRecordError(
      `INVALID_RUN_RECORD: Run record mismatch or invalid for runId '${runId}'`
    );
  }
  validateArtifactBoundary(store.repoDir, ArtifactKind.RUN, preParsed, {
    runId,
    taskId: preParsed.taskId as string,
  });

  const { ownerId } = await store.acquireRunLock(runDir);
  let stagedRunPath: string | null = null;
  let stagedPublished = false;
  try {
    const rawRun = await store.getRun(runId);
    const beforeSnapshot = deepFreeze(structuredClone(rawRun));

    validateArtifactBoundary(store.repoDir, ArtifactKind.RUN, beforeSnapshot, {
      runId,
      taskId: beforeSnapshot.taskId,
    });

    const activeRun = await store.resolveActiveRunForTask(beforeSnapshot.taskId);
    if (!activeRun || activeRun.runId !== runId) {
      throw new AmbiguousActiveRunError(
        `AMBIGUOUS_ACTIVE_RUN: Run '${runId}' is not the unique active run for task '${beforeSnapshot.taskId}'`
      );
    }

    const isResuming = op.type === "resume";
    const isDerivedSafetyStop = op.type === "deriveSafetyStop";

    let taskAuthorityCommit: string | null = null;
    let taskBranch: string | null = null;
    let taskBase: string | null = null;
    let taskScope: string[] | null = null;

    if (!isDerivedSafetyStop) {
      const committedPacket = readCommittedTaskPacket(beforeSnapshot.taskId, store.repoDir);
      if (!committedPacket) {
        throw new TaskPacketNotCommittedError(beforeSnapshot.taskId);
      }
      taskAuthorityCommit = committedPacket.taskAuthorityCommit;
      const taskPacket = committedPacket.taskPacket;
      taskBranch = taskPacket.branch as string;
      taskBase = taskPacket.baseCommit as string;
      taskScope = taskPacket.allowedScope as string[];
    }

    if (!isResuming && !isDerivedSafetyStop) {
      const actualHead = getGitHead(store.repoDir);
      if (actualHead !== beforeSnapshot.headCommit) {
        throw new TransitionRejectedError(
          `HEAD_DRIFT: Actual Git HEAD '${actualHead}' does not match run bound HEAD '${beforeSnapshot.headCommit}'`
        );
      }
      if (
        actualHead !== taskAuthorityCommit ||
        beforeSnapshot.taskAuthorityCommit !== taskAuthorityCommit ||
        beforeSnapshot.headCommit !== taskAuthorityCommit
      ) {
        throw new TransitionRejectedError(
          `TASK_PACKET_DRIFT: Task authority commit drift detected (HEAD='${actualHead}', taskAuthorityCommit='${taskAuthorityCommit}', run='${beforeSnapshot.taskAuthorityCommit}')`
        );
      }

      if (beforeSnapshot.baseCommit !== taskBase) {
        throw new TransitionRejectedError(
          `BASELINE_MISMATCH: Run bound baseCommit '${beforeSnapshot.baseCommit}' does not match committed task baseCommit '${taskBase}'`
        );
      }
      if (!isGitAncestor(taskBase, taskAuthorityCommit, store.repoDir)) {
        throw new TransitionRejectedError(
          `BASELINE_DRIFT: Task baseCommit '${taskBase}' is not an ancestor of task authority commit '${taskAuthorityCommit}'`
        );
      }
      if (!isGitAncestor(beforeSnapshot.baseCommit, beforeSnapshot.taskAuthorityCommit, store.repoDir)) {
        throw new TransitionRejectedError(
          `BASELINE_DRIFT: Run bound baseCommit '${beforeSnapshot.baseCommit}' is not an ancestor of task authority commit '${beforeSnapshot.taskAuthorityCommit}'`
        );
      }

      const actualBranch = getGitBranch(store.repoDir);
      if (!actualBranch || actualBranch === "HEAD") {
        throw new TransitionRejectedError("Detached HEAD is not permitted in Cindy control plane");
      }
      if (actualBranch !== taskBranch || beforeSnapshot.branch !== actualBranch) {
        throw new TransitionRejectedError(
          `BRANCH_MISMATCH: Actual Git branch '${actualBranch}' does not match committed task branch '${taskBranch}' or run bound branch '${beforeSnapshot.branch}'`
        );
      }

      const upstreamStatus = checkGitUpstreamStatus(store.repoDir);
      const actualUpstream = upstreamStatus.upstream;
      if (!actualUpstream || !actualUpstream.commit || !actualUpstream.ref || upstreamStatus.divergence === "missing") {
        throw new TransitionRejectedError(
          `UPSTREAM_MISSING: No upstream configured for branch '${actualBranch}'`
        );
      }
      if (beforeSnapshot.upstreamRef && actualUpstream.ref && beforeSnapshot.upstreamRef !== actualUpstream.ref) {
        throw new TransitionRejectedError(
          `UPSTREAM_DRIFT: Upstream ref drift detected: expected '${beforeSnapshot.upstreamRef}', found '${actualUpstream.ref}'`
        );
      }
      const boundUpstreamSha = beforeSnapshot.upstreamCommit ?? beforeSnapshot.upstreamSha;
      if (boundUpstreamSha && actualUpstream.commit !== boundUpstreamSha) {
        throw new TransitionRejectedError(
          `UPSTREAM_DRIFT: Upstream commit drift detected: expected '${boundUpstreamSha}', found '${actualUpstream.commit}'`
        );
      }

      if (upstreamStatus.divergence === "ahead") {
        throw new TransitionRejectedError(
          `UPSTREAM_AHEAD: Local branch '${actualBranch}' is ahead of upstream by ${upstreamStatus.aheadCount} commit(s)`
        );
      }
      if (upstreamStatus.divergence === "behind") {
        throw new TransitionRejectedError(
          `UPSTREAM_BEHIND: Local branch '${actualBranch}' is behind upstream by ${upstreamStatus.behindCount} commit(s)`
        );
      }
      if (upstreamStatus.divergence === "diverged") {
        throw new TransitionRejectedError(
          `UPSTREAM_DIVERGED: Local branch '${actualBranch}' and upstream have diverged (+${upstreamStatus.aheadCount}/-${upstreamStatus.behindCount})`
        );
      }

      const actualStatus = getGitStatus(store.repoDir);
      if (!actualStatus.isClean) {
        const scope = beforeSnapshot.allowedScope ?? taskScope;
        const ownership = checkDirtyTreeOwnership(scope, actualStatus.dirtyFiles, store.repoDir);
        if (!ownership.ok) {
          throw new DirtyTreeUnexplainedError(ownership.unexplainedFiles);
        }
      }
    }

    let liveSnapshot: { version: string; digest: string } | null = null;
    let liveCtx: { authorityHeadCommit: string; version: string; digest: string } | null = null;
    if (!isResuming && !isDerivedSafetyStop) {
      const snap = await computeAuthoritativeExecutionSnapshot(
        store.repoDir,
        beforeSnapshot.taskId,
        { expectedHeadCommit: beforeSnapshot.headCommit }
      );
      liveSnapshot = snap;
      liveCtx = {
        authorityHeadCommit: beforeSnapshot.headCommit,
        version: CINDY_EXECUTION_SNAPSHOT_V1,
        digest: snap.digest,
      };
    }

    if (op.expectedVersion !== undefined && beforeSnapshot.version !== op.expectedVersion) {
      throw new ConcurrentRunUpdateError(
        `CONCURRENT_RUN_UPDATE: Stale run state update rejected. Expected version ${op.expectedVersion}, but current is ${beforeSnapshot.version}`
      );
    }

    let nextRun: CindyRun;
    const now = new Date().toISOString();

    if (op.type === "administrative") {
      const targetState = op.targetState;
      if (
        targetState === CindyState.GIT_SAFETY_STOP ||
        targetState === CindyState.DIRTY_TREE_UNEXPLAINED
      ) {
        throw new TransitionRejectedError(
          `Cannot apply administrative transition to derived safety stop state '${targetState}'; derived safety stop states must be derived via deriveSafetyStop()`
        );
      }
      if (isPrivilegedState(targetState)) {
        throw new TransitionRejectedError(
          `Transition to privileged state '${targetState}' is sealed and prohibited in Control Plane MVP`
        );
      }
      if (isEvidenceGatedState(targetState)) {
        throw new TransitionRejectedError(
          `Direct transition to evidence-gated state '${targetState}' is rejected; must use dedicated orchestrator operation`
        );
      }
      if (!isAdministrativePauseTarget(targetState)) {
        throw new TransitionRejectedError(
          `Administrative transition cannot choose non-administrative target '${targetState}'; target must be one of approved administrative pause states (BLOCKED, PRODUCT_DECISION_REQUIRED, CONTRACT_CONFLICT, MIGRATION_OR_SECURITY_AMBIGUITY)`
        );
      }
      if (
        op.stopReason === CindyStopReason.GIT_SAFETY_STOP ||
        op.stopReason === CindyStopReason.DIRTY_TREE_UNEXPLAINED ||
        op.stopReason === CindyStopReason.HEAD_DRIFT ||
        op.stopReason === CindyStopReason.HEAD_MISMATCH ||
        op.stopReason === CindyStopReason.UPSTREAM_DRIFT ||
        op.stopReason === CindyStopReason.UPSTREAM_MISSING ||
        op.stopReason === CindyStopReason.TASK_BASELINE_DRIFT ||
        op.stopReason === CindyStopReason.TASK_PACKET_DRIFT
      ) {
        throw new TransitionRejectedError(
          `Cannot specify derived safety stop reason '${op.stopReason}' in administrative transition; safety stop reasons must be derived via deriveSafetyStop()`
        );
      }
      if (isPauseState(beforeSnapshot.state)) {
        throw new TransitionRejectedError(
          `Generic transition from pause state '${beforeSnapshot.state}' to '${targetState}' is rejected; pause reason is immutable until successful resume via controlled resumeRun()`
        );
      }
      validateTransition(beforeSnapshot.state, targetState, { allowEvidenceGated: false });

      nextRun = {
        ...beforeSnapshot,
        version: beforeSnapshot.version + 1,
        state: targetState,
        updatedAt: now,
        history: [
          ...beforeSnapshot.history,
          {
            fromState: beforeSnapshot.state,
            toState: targetState,
            timestamp: now,
            reason: op.reason,
          },
        ],
        boundTreeDigest: op.boundTreeDigest ?? (await computeTreeDigest(store.repoDir)),
        pausedFrom: beforeSnapshot.state,
        stopReason: op.stopReason ?? targetState,
        stopExplanation: op.reason ?? null,
      };
    } else if (op.type === "deriveSafetyStop") {
      if (
        beforeSnapshot.state === CindyState.CLOSED ||
        beforeSnapshot.state === CindyState.NEXT_TASK_SELECTED
      ) {
        throw new TransitionRejectedError(
          `Cannot derive safety stop for terminal state '${beforeSnapshot.state}'`
        );
      }
      if (isPauseState(beforeSnapshot.state)) {
        throw new TransitionRejectedError(
          `Run is already in pause state '${beforeSnapshot.state}'; cannot derive safety stop without resume`
        );
      }

      const evalResult = evaluateGitAuthority({
        repoDir: store.repoDir,
        taskId: beforeSnapshot.taskId,
        runSnapshot: {
          branch: beforeSnapshot.branch,
          headCommit: beforeSnapshot.headCommit,
          baseCommit: beforeSnapshot.baseCommit,
          taskAuthorityCommit: beforeSnapshot.taskAuthorityCommit,
          upstreamSha: beforeSnapshot.upstreamSha,
          upstreamRef: beforeSnapshot.upstreamRef,
          upstreamCommit: beforeSnapshot.upstreamCommit,
          allowedScope: beforeSnapshot.allowedScope,
        },
      });

      const actualStatus = getGitStatus(store.repoDir);
      let ownershipOk = true;
      let unexplainedFiles: string[] = [];
      if (!actualStatus.isClean) {
        const ownership = checkDirtyTreeOwnership(
          beforeSnapshot.allowedScope,
          actualStatus.dirtyFiles,
          store.repoDir
        );
        ownershipOk = ownership.ok;
        unexplainedFiles = ownership.unexplainedFiles;
      }

      if (evalResult.ok && ownershipOk) {
        throw new TransitionRejectedError(
          "Cannot derive safety stop: live Git authority and working tree are clean and valid; safety stop requires genuine authority or scope failure"
        );
      }

      let targetState: CindyState;
      let detailedStopReason: CindyStopReason | CindyState;
      let stopExplanation: string;

      if (!ownershipOk) {
        targetState = CindyState.DIRTY_TREE_UNEXPLAINED;
        detailedStopReason = CindyStopReason.DIRTY_TREE_UNEXPLAINED;
        stopExplanation = `Unexplained dirty files outside scope: ${unexplainedFiles.join(", ")}`;
      } else if (evalResult.stopState === CindyState.DIRTY_TREE_UNEXPLAINED) {
        targetState = CindyState.DIRTY_TREE_UNEXPLAINED;
        detailedStopReason = evalResult.stopReason ?? CindyStopReason.DIRTY_TREE_UNEXPLAINED;
        stopExplanation = evalResult.stopExplanation ?? "Dirty tree unexplained";
      } else {
        targetState = CindyState.GIT_SAFETY_STOP;
        detailedStopReason = evalResult.stopReason ?? CindyStopReason.GIT_SAFETY_STOP;
        stopExplanation = evalResult.stopExplanation ?? "Git safety stop derived from live authority failure";
      }

      nextRun = {
        ...beforeSnapshot,
        version: beforeSnapshot.version + 1,
        state: targetState,
        updatedAt: now,
        history: [
          ...beforeSnapshot.history,
          {
            fromState: beforeSnapshot.state,
            toState: targetState,
            timestamp: now,
            reason: stopExplanation,
          },
        ],
        boundTreeDigest: beforeSnapshot.boundTreeDigest,
        pausedFrom: beforeSnapshot.state,
        stopReason: detailedStopReason,
        stopExplanation: stopExplanation,
        // Bound authority commits remain untouched (Decision AT)
      };
    } else if (op.type === "resume") {
      if (!isPauseState(beforeSnapshot.state) && beforeSnapshot.state !== CindyState.RECONCILING) {
        throw new TransitionRejectedError(
          `Cannot execute resume transition from active state '${beforeSnapshot.state}'; run must be in a pause state`
        );
      }

      const targetState = beforeSnapshot.pausedFrom;
      if (!targetState || !RESUME_TARGET_WHITELIST.has(targetState)) {
        throw new TransitionRejectedError(
          `Corrupted or prohibited pausedFrom state '${String(targetState)}'; cannot resume`
        );
      }
      if (isPrivilegedState(targetState)) {
        throw new TransitionRejectedError(
          `Transition to privileged state '${targetState}' is sealed and prohibited in Control Plane MVP`
        );
      }
      if (isEvidenceGatedState(targetState)) {
        throw new TransitionRejectedError(
          `Direct resume transition to evidence-gated state '${targetState}' is rejected; must use dedicated orchestrator operation`
        );
      }

      const evalResult = evaluateGitAuthority({
        repoDir: store.repoDir,
        taskId: beforeSnapshot.taskId,
        runSnapshot: {
          branch: beforeSnapshot.branch,
          headCommit: beforeSnapshot.headCommit,
          baseCommit: beforeSnapshot.baseCommit,
          taskAuthorityCommit: beforeSnapshot.taskAuthorityCommit,
          upstreamSha: beforeSnapshot.upstreamSha,
          upstreamRef: beforeSnapshot.upstreamRef,
          upstreamCommit: beforeSnapshot.upstreamCommit,
          allowedScope: beforeSnapshot.allowedScope,
        },
      });

      if (!evalResult.ok) {
        throw new TransitionRejectedError(
          `Cannot resume run: live Git/Task authority check failed (${evalResult.stopReason}): ${evalResult.stopExplanation}`
        );
      }

      const stopReason = beforeSnapshot.stopReason ?? beforeSnapshot.state;
      if (
        beforeSnapshot.state === CindyState.PRODUCT_DECISION_REQUIRED ||
        stopReason === CindyStopReason.PRODUCT_DECISION_REQUIRED ||
        beforeSnapshot.state === CindyState.CONTRACT_CONFLICT ||
        stopReason === CindyStopReason.CONTRACT_CONFLICT ||
        beforeSnapshot.state === CindyState.MIGRATION_OR_SECURITY_AMBIGUITY ||
        stopReason === CindyStopReason.MIGRATION_OR_SECURITY_AMBIGUITY ||
        beforeSnapshot.state === CindyState.BLOCKED ||
        stopReason === CindyStopReason.BLOCKED
      ) {
        throw new TransitionRejectedError(
          `Cannot resume run: ${stopReason} requires manual resolution and cannot be automatically resumed in Control Plane MVP`
        );
      } else if (
        beforeSnapshot.state === CindyState.DIRTY_TREE_UNEXPLAINED ||
        stopReason === CindyStopReason.DIRTY_TREE_UNEXPLAINED
      ) {
        if (!evalResult.actualStatus.isClean) {
          const ownership = checkDirtyTreeOwnership(
            beforeSnapshot.allowedScope,
            evalResult.actualStatus.dirtyFiles,
            store.repoDir
          );
          if (!ownership.ok) {
            throw new TransitionRejectedError(
              `Cannot resume run: DIRTY_TREE_UNEXPLAINED condition persists (${ownership.unexplainedFiles.join(", ")})`
            );
          }
        }
      } else if (
        beforeSnapshot.state === CindyState.GIT_SAFETY_STOP ||
        stopReason === CindyStopReason.GIT_SAFETY_STOP
      ) {
        // Safe upstream divergence and exact HEAD match already verified by evalResult.ok
      } else {
        throw new TransitionRejectedError(
          `Cannot resume run: unrecognized pause reason '${String(stopReason)}'`
        );
      }

      nextRun = {
        ...beforeSnapshot,
        version: beforeSnapshot.version + 1,
        state: targetState,
        updatedAt: now,
        history: [
          ...beforeSnapshot.history,
          {
            fromState: beforeSnapshot.state,
            toState: targetState,
            timestamp: now,
            reason: op.reason ?? `Controlled resume to ${targetState}`,
          },
        ],
        boundTreeDigest: op.boundTreeDigest ?? beforeSnapshot.boundTreeDigest,
        pausedFrom: null,
        stopReason: null,
        stopExplanation: null,
      };
    } else if (op.type === "markReadyForBuilder") {
      if (beforeSnapshot.state === CindyState.READY_FOR_BUILDER) {
        return beforeSnapshot;
      }
      validateTransition(beforeSnapshot.state, CindyState.READY_FOR_BUILDER);
      const treeDigest = op.boundTreeDigest ?? (await computeTreeDigest(store.repoDir));
      nextRun = {
        ...beforeSnapshot,
        state: CindyState.READY_FOR_BUILDER,
        version: beforeSnapshot.version + 1,
        boundTreeDigest: treeDigest,
        updatedAt: now,
        history: [
          ...beforeSnapshot.history,
          {
            fromState: beforeSnapshot.state,
            toState: CindyState.READY_FOR_BUILDER,
            timestamp: now,
            reason: op.reason ?? "Marked ready for builder",
          },
        ],
      };
    } else if (op.type === "startBuilding") {
      if (beforeSnapshot.state === CindyState.BUILDING) {
        return beforeSnapshot;
      }
      validateTransition(beforeSnapshot.state, CindyState.BUILDING);
      const treeDigest = op.boundTreeDigest ?? (await computeTreeDigest(store.repoDir));
      nextRun = {
        ...beforeSnapshot,
        state: CindyState.BUILDING,
        version: beforeSnapshot.version + 1,
        boundTreeDigest: treeDigest,
        updatedAt: now,
        history: [
          ...beforeSnapshot.history,
          {
            fromState: beforeSnapshot.state,
            toState: CindyState.BUILDING,
            timestamp: now,
            reason: op.reason ?? "Builder started",
          },
        ],
      };
    } else if (op.type === "completeBuilding") {
      if (beforeSnapshot.state === CindyState.BUILDER_COMPLETE) {
        return beforeSnapshot;
      }
      validateTransition(beforeSnapshot.state, CindyState.BUILDER_COMPLETE);
      const treeDigest = op.boundTreeDigest ?? (await computeTreeDigest(store.repoDir));
      nextRun = {
        ...beforeSnapshot,
        state: CindyState.BUILDER_COMPLETE,
        version: beforeSnapshot.version + 1,
        boundTreeDigest: treeDigest,
        updatedAt: now,
        history: [
          ...beforeSnapshot.history,
          {
            fromState: beforeSnapshot.state,
            toState: CindyState.BUILDER_COMPLETE,
            timestamp: now,
            reason: op.reason ?? "Builder complete",
          },
        ],
      };
    } else if (op.type === "startTesting") {
      if (beforeSnapshot.state === CindyState.TESTING) {
        return beforeSnapshot;
      }
      validateTransition(beforeSnapshot.state, CindyState.TESTING);
      const treeDigest = op.boundTreeDigest ?? (await computeTreeDigest(store.repoDir));
      nextRun = {
        ...beforeSnapshot,
        state: CindyState.TESTING,
        version: beforeSnapshot.version + 1,
        boundTreeDigest: treeDigest,
        updatedAt: now,
        history: [
          ...beforeSnapshot.history,
          {
            fromState: beforeSnapshot.state,
            toState: CindyState.TESTING,
            timestamp: now,
            reason: op.reason ?? "Testing started",
          },
        ],
      };
    } else if (op.type === "startRepairBuilding") {
      if (beforeSnapshot.state === CindyState.REPAIR_BUILDING) {
        return beforeSnapshot;
      }
      validateTransition(beforeSnapshot.state, CindyState.REPAIR_BUILDING);
      const treeDigest = op.boundTreeDigest ?? (await computeTreeDigest(store.repoDir));
      nextRun = {
        ...beforeSnapshot,
        state: CindyState.REPAIR_BUILDING,
        version: beforeSnapshot.version + 1,
        boundTreeDigest: treeDigest,
        updatedAt: now,
        history: [
          ...beforeSnapshot.history,
          {
            fromState: beforeSnapshot.state,
            toState: CindyState.REPAIR_BUILDING,
            timestamp: now,
            reason: op.reason ?? "Repair building started",
          },
        ],
      };
    } else if (op.type === "prepareForReview") {
      if (beforeSnapshot.state !== CindyState.TESTING) {
        throw new TransitionRejectedError(
          `Cannot prepare for review from state '${beforeSnapshot.state}'; run must be in TESTING`
        );
      }
      const tree = await computeTreeDigest(store.repoDir);
      const test = await store.readArtifact<TestResultArtifact>(runId, ArtifactKind.TEST_RESULT, beforeSnapshot.currentCycle);
      const diff = await store.readArtifact<DiffManifestArtifact>(runId, ArtifactKind.DIFF_MANIFEST, beforeSnapshot.currentCycle);
      if (!test || !diff || test.trustClassification !== "STRUCTURE_VALID_EXTERNAL" ||
          diff.trustClassification !== "STRUCTURE_VALID_EXTERNAL" || test.status !== "PASS" ||
          test.exitCode !== 0 || test.runId !== runId || test.taskId !== beforeSnapshot.taskId ||
          test.cycle !== beforeSnapshot.currentCycle || test.boundTreeDigest !== tree ||
          diff.runId !== runId || diff.taskId !== beforeSnapshot.taskId ||
          diff.boundTreeDigest !== tree || diff.baseCommit !== beforeSnapshot.baseCommit ||
          diff.isWithinScope !== true) {
        throw new ArtifactValidationError("Missing or stale bound TEST_RESULT / DIFF_MANIFEST");
      }
      if (!liveCtx) {
        throw new TransitionRejectedError("Missing authoritative snapshot context for prepareForReview");
      }
      if (!test.executionSnapshotVersion || test.executionSnapshotVersion !== liveCtx.version) {
        throw new ArtifactValidationError(`TEST_RESULT executionSnapshotVersion mismatch or missing: '${test.executionSnapshotVersion}'`);
      }
      if (!test.executionSnapshotDigest || !/^[0-9a-f]{64}$/.test(test.executionSnapshotDigest)) {
        throw new ArtifactValidationError(`TEST_RESULT executionSnapshotDigest malformed or missing: '${test.executionSnapshotDigest}'`);
      }
      if (test.executionSnapshotDigest !== liveCtx.digest) {
        throw new ArtifactDigestMismatchError(`TEST_RESULT executionSnapshotDigest '${test.executionSnapshotDigest}' does not match live snapshot '${liveCtx.digest}'`);
      }
      if (!diff.executionSnapshotVersion || diff.executionSnapshotVersion !== liveCtx.version) {
        throw new ArtifactValidationError(`DIFF_MANIFEST executionSnapshotVersion mismatch or missing: '${diff.executionSnapshotVersion}'`);
      }
      if (!diff.executionSnapshotDigest || !/^[0-9a-f]{64}$/.test(diff.executionSnapshotDigest)) {
        throw new ArtifactValidationError(`DIFF_MANIFEST executionSnapshotDigest malformed or missing: '${diff.executionSnapshotDigest}'`);
      }
      if (diff.executionSnapshotDigest !== liveCtx.digest) {
        throw new ArtifactDigestMismatchError(`DIFF_MANIFEST executionSnapshotDigest '${diff.executionSnapshotDigest}' does not match live snapshot '${liveCtx.digest}'`);
      }
      nextRun = {
        ...beforeSnapshot,
        state: CindyState.READY_FOR_REVIEW,
        version: beforeSnapshot.version + 1,
        boundTreeDigest: tree,
        updatedAt: now,
        history: [
          ...beforeSnapshot.history,
          {
            fromState: beforeSnapshot.state,
            toState: CindyState.READY_FOR_REVIEW,
            timestamp: now,
            reason: op.reason ?? `Tests PASS verified for cycle ${beforeSnapshot.currentCycle} and diff-manifest bound`,
          },
        ],
      };
    } else if (op.type === "startReview") {
      if (beforeSnapshot.state !== CindyState.READY_FOR_REVIEW) {
        throw new TransitionRejectedError(
          `Cannot start review from state '${beforeSnapshot.state}'; run must be in READY_FOR_REVIEW`
        );
      }
      const tree = await computeTreeDigest(store.repoDir);
      if (beforeSnapshot.boundTreeDigest && beforeSnapshot.boundTreeDigest !== tree) {
        throw new ArtifactDigestMismatchError(
          `Working tree mutated prior to starting review (expected ${beforeSnapshot.boundTreeDigest}, found ${tree})`
        );
      }
      const request = await store.readArtifact<ReviewRequestArtifact>(runId, ArtifactKind.REVIEW_REQUEST, beforeSnapshot.currentCycle);
      if (!request || request.trustClassification !== "STRUCTURE_VALID_EXTERNAL" ||
          request.runId !== runId || request.taskId !== beforeSnapshot.taskId ||
          request.cycle !== beforeSnapshot.currentCycle || request.baseCommit !== beforeSnapshot.baseCommit ||
          request.boundTreeDigest !== tree || request.reviewer?.readOnlyConfirmed !== true ||
          request.reviewer?.readOnlyRequired !== true || !request.reviewer?.identity ||
          !request.reviewer?.session) {
        throw new ArtifactValidationError("Missing or stale bound REVIEW_REQUEST");
      }
      if (!liveCtx) {
        throw new TransitionRejectedError("Missing authoritative snapshot context for startReview");
      }
      if (!request.executionSnapshotVersion || request.executionSnapshotVersion !== liveCtx.version) {
        throw new ArtifactValidationError(`REVIEW_REQUEST executionSnapshotVersion mismatch or missing: '${request.executionSnapshotVersion}'`);
      }
      if (!request.executionSnapshotDigest || !/^[0-9a-f]{64}$/.test(request.executionSnapshotDigest)) {
        throw new ArtifactValidationError(`REVIEW_REQUEST executionSnapshotDigest malformed or missing: '${request.executionSnapshotDigest}'`);
      }
      if (request.executionSnapshotDigest !== liveCtx.digest) {
        throw new ArtifactDigestMismatchError(`REVIEW_REQUEST executionSnapshotDigest '${request.executionSnapshotDigest}' does not match live snapshot '${liveCtx.digest}'`);
      }
      if (op.reviewer && (request.reviewer.identity !== op.reviewer.identity || (op.reviewer.session && request.reviewer.session !== op.reviewer.session))) {
        throw new ArtifactValidationError("Review request reviewer mismatch with startReview options");
      }
      const reviewerIdentity = request.reviewer.identity;
      nextRun = {
        ...beforeSnapshot,
        state: CindyState.REVIEWING,
        version: beforeSnapshot.version + 1,
        boundTreeDigest: tree,
        updatedAt: now,
        history: [
          ...beforeSnapshot.history,
          {
            fromState: beforeSnapshot.state,
            toState: CindyState.REVIEWING,
            timestamp: now,
            reason: `Review session started by ${reviewerIdentity}`,
          },
        ],
      };
    } else if (op.type === "recordValidatedReviewResult") {
      if (beforeSnapshot.state === CindyState.REPAIR_INITIALIZED) {
        // AV / M01: Idempotent duplicate check for FAIL with on-disk artifact comparison
        const failedCycle = beforeSnapshot.currentCycle - 1;
        const existing = await store.readArtifact<ReviewResultArtifact>(
          runId,
          ArtifactKind.REVIEW_RESULT,
          failedCycle
        );
        if (!existing) {
          throw new ArtifactValidationError(`Missing stored REVIEW_RESULT for cycle ${failedCycle}`);
        }
        if (op.verdict === "PASS") {
          throw new ConflictingArtifactError(
            `Cannot record PASS review result for cycle ${failedCycle} that already recorded FAIL`
          );
        }
        if (existing && op.review) {
          if (!op.review.executionSnapshotVersion || !op.review.executionSnapshotDigest) {
            throw new ArtifactValidationError("Replayed review result missing mandatory snapshot fields");
          }
          if (
            !op.review.reviewer ||
            typeof op.review.reviewer !== "object" ||
            typeof op.review.reviewer.identity !== "string" ||
            op.review.reviewer.identity.trim().length === 0
          ) {
            throw new ArtifactValidationError(
              "Replayed review result reviewer identity is missing, empty, or invalid"
            );
          }
          if (
            typeof op.review.reviewer.session !== "string" ||
            op.review.reviewer.session.trim().length === 0
          ) {
            throw new ArtifactValidationError(
              "Replayed review result reviewer session is missing, empty, or invalid"
            );
          }
          const normalizedOpReview: ReviewResultArtifact = {
            ...op.review,
            runId,
            taskId: beforeSnapshot.taskId,
            cycle: failedCycle,
            executionSnapshotVersion: op.review.executionSnapshotVersion,
            executionSnapshotDigest: op.review.executionSnapshotDigest,
            trustClassification: "STRUCTURE_VALID_EXTERNAL",
          };
          if (canonicalizeJson(existing) !== canonicalizeJson(normalizedOpReview)) {
            throw new ConflictingArtifactError(
              `Conflicting review result artifact for cycle ${failedCycle}`
            );
          }
        }
        // Architecture Decision M-R6-03: Validate stored review result evidence fields
        // regardless of whether op.review is present. Prevents tampered stored evidence
        // from being accepted during FAIL duplicate replay.
        if (existing.verdict !== "FAIL") {
          throw new ConflictingArtifactError(
            `Stored REVIEW_RESULT for cycle ${failedCycle} has verdict '${existing.verdict}', expected 'FAIL'`
          );
        }
        if (existing.runId !== runId) {
          throw new ArtifactValidationError(
            `Stored REVIEW_RESULT runId '${existing.runId}' does not match run '${runId}'`
          );
        }
        if (existing.taskId !== beforeSnapshot.taskId) {
          throw new ArtifactValidationError(
            `Stored REVIEW_RESULT taskId '${existing.taskId}' does not match run taskId '${beforeSnapshot.taskId}'`
          );
        }
        if (existing.cycle !== failedCycle) {
          throw new ArtifactValidationError(
            `Stored REVIEW_RESULT cycle ${existing.cycle} does not match expected cycle ${failedCycle}`
          );
        }
        if (existing.trustClassification !== "STRUCTURE_VALID_EXTERNAL") {
          throw new ArtifactValidationError(
            `Stored REVIEW_RESULT trustClassification '${existing.trustClassification}' is not STRUCTURE_VALID_EXTERNAL`
          );
        }
        if (existing.reviewedBaseCommit !== beforeSnapshot.baseCommit) {
          throw new ArtifactValidationError(
            `Stored REVIEW_RESULT reviewedBaseCommit '${existing.reviewedBaseCommit}' does not match run baseCommit '${beforeSnapshot.baseCommit}'`
          );
        }
        const request = await store.readArtifact<ReviewRequestArtifact>(
          runId,
          ArtifactKind.REVIEW_REQUEST,
          failedCycle
        );
        if (
          !request ||
          request.trustClassification !== "STRUCTURE_VALID_EXTERNAL" ||
          request.runId !== runId ||
          request.taskId !== beforeSnapshot.taskId ||
          request.cycle !== failedCycle ||
          request.baseCommit !== beforeSnapshot.baseCommit
        ) {
          throw new ArtifactValidationError("Missing or stale bound REVIEW_REQUEST for replay under lock");
        }
        // M-R7-01: In FAIL duplicate replay under lock, reviewer identity and session must exist,
        // be non-empty strings on both bound REVIEW_REQUEST and stored REVIEW_RESULT, and match exactly.
        // Truthy conditions must NOT skip validation when fields are missing or empty.
        if (
          !request.reviewer ||
          typeof request.reviewer !== "object" ||
          typeof request.reviewer.identity !== "string" ||
          request.reviewer.identity.trim().length === 0
        ) {
          throw new ArtifactValidationError(
            "Bound REVIEW_REQUEST reviewer identity is missing or empty"
          );
        }
        if (
          typeof request.reviewer.session !== "string" ||
          request.reviewer.session.trim().length === 0
        ) {
          throw new ArtifactValidationError(
            "Bound REVIEW_REQUEST reviewer session is missing or empty"
          );
        }
        if (
          !existing.reviewer ||
          typeof existing.reviewer !== "object" ||
          typeof existing.reviewer.identity !== "string" ||
          existing.reviewer.identity.trim().length === 0
        ) {
          throw new ArtifactValidationError(
            "Stored REVIEW_RESULT reviewer identity is missing or empty"
          );
        }
        if (
          typeof existing.reviewer.session !== "string" ||
          existing.reviewer.session.trim().length === 0
        ) {
          throw new ArtifactValidationError(
            "Stored REVIEW_RESULT reviewer session is missing or empty"
          );
        }
        if (existing.reviewer.identity !== request.reviewer.identity) {
          throw new ArtifactValidationError(
            `Stored REVIEW_RESULT reviewer identity '${existing.reviewer.identity}' does not match REVIEW_REQUEST reviewer '${request.reviewer.identity}'`
          );
        }
        if (existing.reviewer.session !== request.reviewer.session) {
          throw new ArtifactValidationError(
            `Stored REVIEW_RESULT reviewer session '${existing.reviewer.session}' does not match REVIEW_REQUEST session '${request.reviewer.session}'`
          );
        }
        if (!liveCtx) {
          throw new TransitionRejectedError("Missing authoritative snapshot context for review result replay");
        }
        if (!existing.executionSnapshotVersion || existing.executionSnapshotVersion !== liveCtx.version) {
          throw new ArtifactValidationError(`Replayed REVIEW_RESULT executionSnapshotVersion mismatch or missing: '${existing.executionSnapshotVersion}'`);
        }
        if (!existing.executionSnapshotDigest || !/^[0-9a-f]{64}$/.test(existing.executionSnapshotDigest)) {
          throw new ArtifactValidationError(`Replayed REVIEW_RESULT executionSnapshotDigest malformed or missing: '${existing.executionSnapshotDigest}'`);
        }
        if (existing.executionSnapshotDigest !== liveCtx.digest) {
          throw new ArtifactDigestMismatchError(`Replayed REVIEW_RESULT executionSnapshotDigest '${existing.executionSnapshotDigest}' does not match live snapshot '${liveCtx.digest}'`);
        }
        if (!request.executionSnapshotVersion || request.executionSnapshotVersion !== liveCtx.version) {
          throw new ArtifactValidationError(`Bound REVIEW_REQUEST executionSnapshotVersion mismatch: '${request.executionSnapshotVersion}'`);
        }
        if (!request.executionSnapshotDigest || !/^[0-9a-f]{64}$/.test(request.executionSnapshotDigest)) {
          throw new ArtifactValidationError(`Bound REVIEW_REQUEST executionSnapshotDigest malformed: '${request.executionSnapshotDigest}'`);
        }
        if (request.executionSnapshotDigest !== liveCtx.digest) {
          throw new ArtifactDigestMismatchError(`Bound REVIEW_REQUEST executionSnapshotDigest '${request.executionSnapshotDigest}' does not match live snapshot '${liveCtx.digest}'`);
        }
        const tree = await computeTreeDigest(store.repoDir);
        if (request.boundTreeDigest !== tree) {
          throw new ArtifactDigestMismatchError(
            `Working tree mutated after review request was created (request ${request.boundTreeDigest}, current ${tree})`
          );
        }
        // M-R6-03: Always validate stored review result tree/diff digests, not just when op.review is present
        if (existing.reviewedTreeDigest !== tree) {
          throw new ArtifactDigestMismatchError(
            `Stored REVIEW_RESULT reviewedTreeDigest '${existing.reviewedTreeDigest}' does not match current tree '${tree}'`
          );
        }
        if (op.review && op.review.reviewedTreeDigest !== tree) {
          throw new ArtifactDigestMismatchError(
            `Replayed review reviewedTreeDigest '${op.review.reviewedTreeDigest}' does not match current tree '${tree}'`
          );
        }
        const diff = await computeDiffDigest(store.repoDir);
        if (existing.reviewedDiffDigest !== diff) {
          throw new ArtifactDigestMismatchError(
            `Stored REVIEW_RESULT reviewedDiffDigest '${existing.reviewedDiffDigest}' does not match current diff '${diff}'`
          );
        }
        if (op.review && op.review.reviewedDiffDigest !== diff) {
          throw new ArtifactDigestMismatchError(
            `Replayed review reviewedDiffDigest '${op.review.reviewedDiffDigest}' does not match current diff '${diff}'`
          );
        }
        const alreadyRecordedFail = beforeSnapshot.history.some(
          (h) => h.toState === CindyState.REPAIR_INITIALIZED
        );
        if (alreadyRecordedFail && (op.verdict === "FAIL" || op.verdict === undefined)) {
          // Architecture Decision DC: FAIL duplicate replay must NOT bypass the final run-bound authority fence.
          // SNAPSHOT_FINAL → FINAL_AUTHORITY → return (Architecture Decision DB + DC).
          const snapshotFinal = await computeAuthoritativeExecutionSnapshot(
            store.repoDir,
            beforeSnapshot.taskId,
            { expectedHeadCommit: beforeSnapshot.headCommit }
          );
          if (snapshotFinal.digest !== liveCtx.digest) {
            throw new ArtifactDigestMismatchError(
              `Execution snapshot drifted before FAIL duplicate replay return (before ${liveCtx.digest}, final ${snapshotFinal.digest})`
            );
          }
          // Final run-bound authority fence before duplicate replay return (Architecture Decision DC).
          const replayFinalAuthority = evaluateGitAuthority({
            repoDir: store.repoDir,
            taskId: beforeSnapshot.taskId,
            runSnapshot: {
              branch: beforeSnapshot.branch,
              headCommit: beforeSnapshot.headCommit,
              baseCommit: beforeSnapshot.baseCommit,
              taskAuthorityCommit: beforeSnapshot.taskAuthorityCommit,
              upstreamSha: beforeSnapshot.upstreamSha,
              upstreamRef: beforeSnapshot.upstreamRef,
              upstreamCommit: beforeSnapshot.upstreamCommit,
              allowedScope: beforeSnapshot.allowedScope,
            },
          });
          if (!replayFinalAuthority.ok) {
            throw new TransitionRejectedError(
              `Live authority changed before FAIL duplicate replay return: ${replayFinalAuthority.stopExplanation}`
            );
          }
          const replayStatus = getGitStatus(store.repoDir);
          if (!replayStatus.isClean) {
            const replayOwnership = checkDirtyTreeOwnership(beforeSnapshot.allowedScope, replayStatus.dirtyFiles, store.repoDir);
            if (!replayOwnership.ok) {
              throw new DirtyTreeUnexplainedError(replayOwnership.unexplainedFiles);
            }
          }
          const replayUpstream = checkGitUpstreamStatus(store.repoDir);
          if (
            replayUpstream.divergence === "diverged" ||
            replayUpstream.divergence === "ahead" ||
            replayUpstream.divergence === "behind" ||
            replayUpstream.divergence === "missing"
          ) {
            throw new TransitionRejectedError(`Git upstream diverged before FAIL duplicate replay return: ${replayUpstream.divergence}`);
          }
          if (beforeSnapshot.upstreamRef && replayUpstream.upstream?.ref && replayUpstream.upstream.ref !== beforeSnapshot.upstreamRef) {
            throw new TransitionRejectedError(
              `Git upstream ref drifted before FAIL duplicate replay return: expected '${beforeSnapshot.upstreamRef}', got '${replayUpstream.upstream.ref}'`
            );
          }
          const boundUpstreamSha = beforeSnapshot.upstreamCommit ?? beforeSnapshot.upstreamSha;
          if (boundUpstreamSha && replayUpstream.upstream?.commit && replayUpstream.upstream.commit !== boundUpstreamSha) {
            throw new TransitionRejectedError(
              `Git upstream commit drifted before FAIL duplicate replay return: expected '${boundUpstreamSha}', got '${replayUpstream.upstream.commit}'`
            );
          }
          return beforeSnapshot;
        }
      }
      if (beforeSnapshot.state !== CindyState.REVIEWING) {
        throw new TransitionRejectedError(
          `Cannot record review result from state '${beforeSnapshot.state}'; run must be in REVIEWING`
        );
      }
      const request = await store.readArtifact<ReviewRequestArtifact>(runId, ArtifactKind.REVIEW_REQUEST, beforeSnapshot.currentCycle);
      if (!request || request.trustClassification !== "STRUCTURE_VALID_EXTERNAL" ||
          request.runId !== runId || request.taskId !== beforeSnapshot.taskId ||
          request.cycle !== beforeSnapshot.currentCycle || request.baseCommit !== beforeSnapshot.baseCommit ||
          !request.reviewer?.identity || !request.reviewer?.session ||
          request.reviewer?.readOnlyRequired !== true) {
        throw new ArtifactValidationError("Missing or stale bound REVIEW_REQUEST");
      }

      // AS / B01: Stored review result ONLY. NO fallback to op.review!
      const review = await store.readArtifact<ReviewResultArtifact>(
        runId,
        ArtifactKind.REVIEW_RESULT,
        beforeSnapshot.currentCycle
      );
      if (!review) {
        throw new ArtifactValidationError(
          `Missing bound REVIEW_RESULT artifact on disk for run '${runId}' cycle ${beforeSnapshot.currentCycle}: state-driving review result must be stored on disk before recording transition`
        );
      }

      const tree = await computeTreeDigest(store.repoDir);
      const diff = await computeDiffDigest(store.repoDir);

      if (!liveCtx) {
        throw new TransitionRejectedError("Missing authoritative snapshot context for recordValidatedReviewResult");
      }
      if (!request.executionSnapshotVersion || request.executionSnapshotVersion !== liveCtx.version) {
        throw new ArtifactValidationError(`Bound REVIEW_REQUEST executionSnapshotVersion mismatch: '${request.executionSnapshotVersion}'`);
      }
      if (!request.executionSnapshotDigest || !/^[0-9a-f]{64}$/.test(request.executionSnapshotDigest)) {
        throw new ArtifactValidationError(`Bound REVIEW_REQUEST executionSnapshotDigest malformed: '${request.executionSnapshotDigest}'`);
      }
      if (request.executionSnapshotDigest !== liveCtx.digest) {
        throw new ArtifactDigestMismatchError(`Bound REVIEW_REQUEST executionSnapshotDigest '${request.executionSnapshotDigest}' does not match live snapshot '${liveCtx.digest}'`);
      }
      if (!review.executionSnapshotVersion || review.executionSnapshotVersion !== liveCtx.version) {
        throw new ArtifactValidationError(`Bound REVIEW_RESULT executionSnapshotVersion mismatch: '${review.executionSnapshotVersion}'`);
      }
      if (!review.executionSnapshotDigest || !/^[0-9a-f]{64}$/.test(review.executionSnapshotDigest)) {
        throw new ArtifactValidationError(`Bound REVIEW_RESULT executionSnapshotDigest malformed: '${review.executionSnapshotDigest}'`);
      }
      if (review.executionSnapshotDigest !== liveCtx.digest) {
        throw new ArtifactDigestMismatchError(`Bound REVIEW_RESULT executionSnapshotDigest '${review.executionSnapshotDigest}' does not match live snapshot '${liveCtx.digest}'`);
      }

      if (
        review.trustClassification !== "STRUCTURE_VALID_EXTERNAL" ||
        (op.verdict !== undefined && review.verdict !== op.verdict) ||
        review.runId !== runId ||
        review.taskId !== beforeSnapshot.taskId ||
        review.cycle !== beforeSnapshot.currentCycle ||
        review.reviewedTreeDigest !== tree ||
        review.reviewedDiffDigest !== diff ||
        review.reviewedBaseCommit !== beforeSnapshot.baseCommit ||
        review.reviewer?.identity !== request.reviewer.identity ||
        review.reviewer?.session !== request.reviewer.session ||
        review.reviewer?.readOnlyConfirmed !== true
      ) {
        throw new ArtifactValidationError("Missing or stale bound REVIEW_RESULT");
      }

      if (review.verdict === "PASS") {
        const passAlreadyRecorded = beforeSnapshot.history.some(
          (h) =>
            h.toState === CindyState.REVIEWING &&
            h.reason?.includes(`Review verdict PASS recorded for cycle ${beforeSnapshot.currentCycle}`)
        );
        if (passAlreadyRecorded) {
          if (op.verdict !== undefined && op.verdict !== "PASS") {
            throw new ConflictingArtifactError(
              `Conflicting review result for cycle ${beforeSnapshot.currentCycle}: cannot record ${op.verdict} when PASS already recorded`
            );
          }
          if (op.review) {
            if (!op.review.executionSnapshotVersion || op.review.executionSnapshotVersion !== liveCtx.version) {
              throw new ArtifactValidationError("Replayed review result executionSnapshotVersion mismatch");
            }
            if (!op.review.executionSnapshotDigest || !/^[0-9a-f]{64}$/.test(op.review.executionSnapshotDigest)) {
              throw new ArtifactValidationError("Replayed review result executionSnapshotDigest malformed");
            }
            if (op.review.executionSnapshotDigest !== liveCtx.digest) {
              throw new ArtifactDigestMismatchError("Replayed review result executionSnapshotDigest does not match live snapshot");
            }
            const normalizedOpReview: ReviewResultArtifact = {
              ...op.review,
              runId,
              taskId: beforeSnapshot.taskId,
              cycle: beforeSnapshot.currentCycle,
              executionSnapshotVersion: op.review.executionSnapshotVersion,
              executionSnapshotDigest: op.review.executionSnapshotDigest,
              trustClassification: "STRUCTURE_VALID_EXTERNAL",
            };
            if (canonicalizeJson(review) !== canonicalizeJson(normalizedOpReview)) {
              throw new ConflictingArtifactError(
                `Conflicting review result artifact for cycle ${beforeSnapshot.currentCycle}`
              );
            }
          }
          if (review.executionSnapshotDigest !== liveCtx.digest) {
            throw new ArtifactDigestMismatchError(
              `Stored review result executionSnapshotDigest ('${review.executionSnapshotDigest}') does not match live snapshot digest ('${liveCtx.digest}') during PASS duplicate replay`
            );
          }
          if (review.reviewedTreeDigest !== tree) {
            throw new ArtifactDigestMismatchError(
              `Working tree mutated during PASS duplicate replay (expected ${review.reviewedTreeDigest}, current ${tree})`
            );
          }
          if (review.reviewedDiffDigest !== diff) {
            throw new ArtifactDigestMismatchError(
              `Working diff mutated during PASS duplicate replay (expected ${review.reviewedDiffDigest}, current ${diff})`
            );
          }
          // AV / M01 / CJ / DC: Idempotent PASS consumption — SNAPSHOT_FINAL → FINAL_AUTHORITY → return.
          // Must NOT bypass the final run-bound authority fence (Architecture Decision DC).
          const snapshotFinal = await computeAuthoritativeExecutionSnapshot(
            store.repoDir,
            beforeSnapshot.taskId,
            { expectedHeadCommit: beforeSnapshot.headCommit }
          );
          if (snapshotFinal.digest !== liveCtx.digest) {
            throw new ArtifactDigestMismatchError(
              `Execution snapshot drifted before PASS duplicate replay return (before ${liveCtx.digest}, final ${snapshotFinal.digest})`
            );
          }
          // Final run-bound authority fence before duplicate replay return (Architecture Decision DC).
          const passReplayFinalAuthority = evaluateGitAuthority({
            repoDir: store.repoDir,
            taskId: beforeSnapshot.taskId,
            runSnapshot: {
              branch: beforeSnapshot.branch,
              headCommit: beforeSnapshot.headCommit,
              baseCommit: beforeSnapshot.baseCommit,
              taskAuthorityCommit: beforeSnapshot.taskAuthorityCommit,
              upstreamSha: beforeSnapshot.upstreamSha,
              upstreamRef: beforeSnapshot.upstreamRef,
              upstreamCommit: beforeSnapshot.upstreamCommit,
              allowedScope: beforeSnapshot.allowedScope,
            },
          });
          if (!passReplayFinalAuthority.ok) {
            throw new TransitionRejectedError(
              `Live authority changed before PASS duplicate replay return: ${passReplayFinalAuthority.stopExplanation}`
            );
          }
          const passStatus = getGitStatus(store.repoDir);
          if (!passStatus.isClean) {
            const passOwnership = checkDirtyTreeOwnership(beforeSnapshot.allowedScope, passStatus.dirtyFiles, store.repoDir);
            if (!passOwnership.ok) {
              throw new DirtyTreeUnexplainedError(passOwnership.unexplainedFiles);
            }
          }
          const passUpstream = checkGitUpstreamStatus(store.repoDir);
          if (
            passUpstream.divergence === "diverged" ||
            passUpstream.divergence === "ahead" ||
            passUpstream.divergence === "behind" ||
            passUpstream.divergence === "missing"
          ) {
            throw new TransitionRejectedError(`Git upstream diverged before PASS duplicate replay return: ${passUpstream.divergence}`);
          }
          if (beforeSnapshot.upstreamRef && passUpstream.upstream?.ref && passUpstream.upstream.ref !== beforeSnapshot.upstreamRef) {
            throw new TransitionRejectedError(
              `Git upstream ref drifted before PASS duplicate replay return: expected '${beforeSnapshot.upstreamRef}', got '${passUpstream.upstream.ref}'`
            );
          }
          const boundPassUpstreamSha = beforeSnapshot.upstreamCommit ?? beforeSnapshot.upstreamSha;
          if (boundPassUpstreamSha && passUpstream.upstream?.commit && passUpstream.upstream.commit !== boundPassUpstreamSha) {
            throw new TransitionRejectedError(
              `Git upstream commit drifted before PASS duplicate replay return: expected '${boundPassUpstreamSha}', got '${passUpstream.upstream.commit}'`
            );
          }
          return beforeSnapshot;
        }

        nextRun = {
          ...beforeSnapshot,
          version: beforeSnapshot.version + 1,
          state: CindyState.REVIEWING,
          updatedAt: now,
          history: [
            ...beforeSnapshot.history,
            {
              fromState: beforeSnapshot.state,
              toState: CindyState.REVIEWING,
              timestamp: now,
              reason: `Review verdict PASS recorded for cycle ${beforeSnapshot.currentCycle}`,
            },
          ],
        };
      } else {
        nextRun = {
          ...beforeSnapshot,
          version: beforeSnapshot.version + 1,
          state: CindyState.REPAIR_INITIALIZED,
          currentCycle: beforeSnapshot.currentCycle + 1,
          updatedAt: now,
          history: [
            ...beforeSnapshot.history,
            {
              fromState: beforeSnapshot.state,
              toState: CindyState.REPAIR_INITIALIZED,
              timestamp: now,
              reason: `Review verdict FAIL for cycle ${beforeSnapshot.currentCycle} with ${review.findings?.length ?? 0} findings`,
            },
          ],
        };
      }
    } else {
      throw new TransitionRejectedError(`Unrecognized semantic operation type '${(op as { type: string }).type}'`);
    }

    if (isPrivilegedState(nextRun.state)) {
      throw new TransitionRejectedError(
        `Transition to privileged state '${nextRun.state}' is sealed and prohibited in Control Plane MVP`
      );
    }

    if (nextRun.version !== beforeSnapshot.version + 1) {
      throw new ConcurrentRunUpdateError(
        `CONCURRENT_RUN_UPDATE: Stale run state update rejected. Expected version ${beforeSnapshot.version + 1}, got ${nextRun.version}`
      );
    }

    if (
      nextRun.runId !== beforeSnapshot.runId ||
      nextRun.taskId !== beforeSnapshot.taskId ||
      nextRun.branch !== beforeSnapshot.branch ||
      nextRun.baseCommit !== beforeSnapshot.baseCommit ||
      nextRun.headCommit !== beforeSnapshot.headCommit ||
      nextRun.taskAuthorityCommit !== beforeSnapshot.taskAuthorityCommit ||
      nextRun.upstreamRef !== beforeSnapshot.upstreamRef ||
      nextRun.upstreamCommit !== beforeSnapshot.upstreamCommit ||
      canonicalizeJson(nextRun.allowedScope) !== canonicalizeJson(beforeSnapshot.allowedScope) ||
      (nextRun.upstreamSha ?? null) !== (beforeSnapshot.upstreamSha ?? null) ||
      nextRun.createdAt !== beforeSnapshot.createdAt ||
      nextRun.history.length !== beforeSnapshot.history.length + 1 ||
      nextRun.history.at(-1)?.fromState !== beforeSnapshot.state ||
      nextRun.history.at(-1)?.toState !== nextRun.state
    ) {
      throw new TransitionRejectedError("Mutation altered bound authority, cycle, identity or transition history");
    }

    validateArtifactBoundary(store.repoDir, ArtifactKind.RUN, nextRun, {
      runId,
      taskId: nextRun.taskId,
    });

    // =========================================================================
    // FOUR-STAGE SECURE PUBLICATION PIPELINE (M-R5-02)
    // 1. PREPARE STAGED RUN WRITE (all awaited IO completed before final validation)
    // 2. FINAL EVIDENCE / SNAPSHOT VALIDATION (CAS check, snapshot, double-sync tree scan)
    // 3. FINAL RUN-BOUND GIT AUTHORITY FENCE (re-read Git authority facts, status, dirty ownership)
    // 4. ATOMIC PUBLICATION (sync renameSync, zero awaited IO after fence)
    // =========================================================================

    // --- STEP 1: PREPARE STAGED RUN WRITE ---
    const jsonString = canonicalizeJson(nextRun);
    stagedRunPath = join(runDir, `.tmp_run_${randomUUID()}.json`);
    assertNoSymlinkAncestors(store.repoDir, stagedRunPath);
    const fileHandle = await open(stagedRunPath, "w");
    try {
      await fileHandle.writeFile(jsonString, "utf8");
      await fileHandle.sync();
    } finally {
      await fileHandle.close();
    }
    await chmod(stagedRunPath, 0o644);

    // --- STEP 2: FINAL EVIDENCE / SNAPSHOT VALIDATION ---
    // Re-verify existing target file state on disk (CAS check: version and state must be unchanged)
    assertNoSymlinkAncestors(store.repoDir, targetPath);
    const currentDiskRun = await store.getRun(runId);
    if (currentDiskRun.version !== beforeSnapshot.version || currentDiskRun.state !== beforeSnapshot.state) {
      throw new ConcurrentRunUpdateError(
        `CONCURRENT_RUN_UPDATE: Stale run state update rejected. Expected version ${beforeSnapshot.version}, disk version is ${currentDiskRun.version}`
      );
    }

    // Execution snapshot validation (Decision DB)
    if (liveSnapshot) {
      const snapshotFinal = await computeAuthoritativeExecutionSnapshot(
        store.repoDir,
        beforeSnapshot.taskId,
        { expectedHeadCommit: beforeSnapshot.headCommit }
      );
      if (snapshotFinal.digest !== liveSnapshot.digest) {
        throw new ArtifactDigestMismatchError(
          `Execution snapshot drifted before state mutation (before ${liveSnapshot.digest}, final ${snapshotFinal.digest})`
        );
      }
    }

    // Tree binding validation with double synchronous scan and identity fence
    let semanticCanonicalRepo: string | null = null;
    let semanticIdentities: Map<string, FileIdentityRecord> | null = null;
    let semanticManifest: ExecutionSnapshotManifest | null = null;
    if (!isDerivedSafetyStop && nextRun.boundTreeDigest) {
      const treeSnapshot1 = computeTreeSnapshotSync(store.repoDir);
      if (treeSnapshot1.digest !== nextRun.boundTreeDigest) {
        throw new TransitionRejectedError("Working tree changed before state write");
      }
      const treeSnapshot2 = computeTreeSnapshotSync(store.repoDir);
      if (treeSnapshot2.digest !== treeSnapshot1.digest) {
        throw new TransitionRejectedError("Working tree mutated during validation before state write");
      }
      // Architecture Decision M-R6-02: Post-read file identity fence for semantic transitions.
      semanticCanonicalRepo = canonicalizeRepoDir(store.repoDir);
      semanticIdentities = treeSnapshot1.fileIdentities ?? collectFileIdentities(semanticCanonicalRepo, treeSnapshot1.manifest);
      semanticManifest = treeSnapshot1.manifest;
      verifyFileIdentityFence(semanticCanonicalRepo, semanticIdentities, treeSnapshot1.manifest);
    }

    // --- STEP 3: FINAL RUN-BOUND GIT AUTHORITY FENCE ---
    // Synchronous authority evaluation AFTER snapshot and tree scan (Decision DB)
    const finalAuthority = !isDerivedSafetyStop && evaluateGitAuthority({
      repoDir: store.repoDir,
      taskId: beforeSnapshot.taskId,
      runSnapshot: {
        branch: beforeSnapshot.branch,
        headCommit: beforeSnapshot.headCommit,
        baseCommit: beforeSnapshot.baseCommit,
        taskAuthorityCommit: beforeSnapshot.taskAuthorityCommit,
        upstreamSha: beforeSnapshot.upstreamSha,
        upstreamRef: beforeSnapshot.upstreamRef,
        upstreamCommit: beforeSnapshot.upstreamCommit,
        allowedScope: beforeSnapshot.allowedScope,
      },
    });
    if (finalAuthority && !finalAuthority.ok) {
      throw new TransitionRejectedError(`Live authority changed before write: ${finalAuthority.stopExplanation}`);
    }

    // Fresh dirty ownership check
    if (!isDerivedSafetyStop) {
      const finalStatus = getGitStatus(store.repoDir);
      if (!finalStatus.isClean) {
        const finalOwnership = checkDirtyTreeOwnership(beforeSnapshot.allowedScope, finalStatus.dirtyFiles, store.repoDir);
        if (!finalOwnership.ok) {
          throw new DirtyTreeUnexplainedError(finalOwnership.unexplainedFiles);
        }
      }

      // Fresh upstream status check
      const finalUpstream = checkGitUpstreamStatus(store.repoDir);
      if (
        finalUpstream.divergence === "diverged" ||
        finalUpstream.divergence === "ahead" ||
        finalUpstream.divergence === "behind" ||
        finalUpstream.divergence === "missing"
      ) {
        throw new TransitionRejectedError(`Git upstream diverged before state write: ${finalUpstream.divergence}`);
      }
      if (beforeSnapshot.upstreamRef && finalUpstream.upstream?.ref && finalUpstream.upstream.ref !== beforeSnapshot.upstreamRef) {
        throw new TransitionRejectedError(
          `Git upstream ref drifted before state write: expected '${beforeSnapshot.upstreamRef}', got '${finalUpstream.upstream.ref}'`
        );
      }
      const boundUpstreamSha = beforeSnapshot.upstreamCommit ?? beforeSnapshot.upstreamSha;
      if (boundUpstreamSha && finalUpstream.upstream?.commit && finalUpstream.upstream.commit !== boundUpstreamSha) {
        throw new TransitionRejectedError(
          `Git upstream commit drifted before state write: expected '${boundUpstreamSha}', got '${finalUpstream.upstream.commit}'`
        );
      }
    }

    // --- STEP 4: ATOMIC PUBLICATION ---
    // Architecture Decision M-R6-02: Final Freshness Seal immediately before atomic publication.
    // Zero ordinary awaited I/O after this fence.
    if (semanticCanonicalRepo && semanticIdentities && semanticManifest) {
      verifyFileIdentityFence(semanticCanonicalRepo, semanticIdentities, semanticManifest);
    }
    assertNoSymlinkAncestors(store.repoDir, targetPath);
    renameSync(stagedRunPath, targetPath);
    stagedPublished = true;

    try {
      const dirHandle = openSync(runDir, "r");
      fsyncSync(dirHandle);
      closeSync(dirHandle);
    } catch {
      // best effort fsync of parent dir
    }

    return nextRun;
  } finally {
    if (stagedRunPath && !stagedPublished) {
      try {
        rmSync(stagedRunPath, { force: true });
      } catch {
        // cleanup best effort
      }
    }
    await store.releaseRunLock(runDir, ownerId).catch(() => {});
  }
}
