import { execFileSync } from "node:child_process";
import {
  ArtifactKind,
  ArtifactValidationError,
  CindyState,
  CindyStopReason,
  InvalidCommittedClosureError,
  TaskPacketNotCommittedError,
  type ValidatedGitAuthorityContext,
} from "./types.ts";
import { validateArtifactBoundary } from "./schema-validator.ts";
import { checkDirtyTreeOwnership, validateScopeEntry } from "./ownership.ts";
import { validateTaskId } from "./path-safety.ts";

export interface GitStatusEntry {
  x: string;
  y: string;
  path: string;
  origPath?: string | undefined;
  isStaged: boolean;
  isUnstaged: boolean;
  isUntracked: boolean;
  isDeleted: boolean;
  isRenamed: boolean;
}

export interface GitStatusSummary {
  isClean: boolean;
  entries: GitStatusEntry[];
  dirtyFiles: string[];
}

export interface GitUpstreamInfo {
  remote: string;
  branch: string;
  commit: string;
  ref?: string | undefined;
}

export type GitUpstreamDivergence = "equal" | "ahead" | "behind" | "diverged" | "missing";

export interface GitUpstreamStatusResult {
  upstream: GitUpstreamInfo | null;
  divergence: GitUpstreamDivergence;
  aheadCount: number;
  behindCount: number;
}

/**
 * Module-private read-only git command runner (Architecture Decision S).
 * Strictly whitelist allowed read-only subcommands with fixed argv.
 * Not exported outside this module to prevent generic execution.
 */
function runGitReadOnlyInternal(args: string[], repoDir: string = process.cwd()): string {
  const allowedSubcommands = new Set([
    "rev-parse",
    "rev-list",
    "branch",
    "status",
    "diff",
    "ls-files",
    "cat-file",
    "hash-object",
    "log",
    "merge-base",
    "ls-tree",
  ]);

  const sub = args[0];
  if (!sub || !allowedSubcommands.has(sub)) {
    throw new Error(`Unauthorized or non-read-only git command: git ${args.join(" ")}`);
  }

  try {
    return execFileSync("git", args, {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (error: unknown) {
    // If upstream doesn't exist, rev-parse or rev-list might exit with 128
    if (args.includes("@{upstream}") || args.includes("--abbrev-ref") || args.some((a) => a.includes("@{upstream}"))) {
      return "";
    }
    throw error;
  }
}

export function getGitBranch(repoDir: string = process.cwd()): string {
  const out = runGitReadOnlyInternal(["branch", "--show-current"], repoDir).trim();
  if (out) return out;
  // If detached HEAD, check rev-parse
  return runGitReadOnlyInternal(["rev-parse", "--abbrev-ref", "HEAD"], repoDir).trim();
}

export const getCurrentBranch = getGitBranch;

export function getGitHead(repoDir: string = process.cwd()): string {
  return runGitReadOnlyInternal(["rev-parse", "HEAD"], repoDir).trim();
}

export const getHeadCommit = getGitHead;

export function getGitUpstream(repoDir: string = process.cwd()): GitUpstreamInfo | null {
  const ref = runGitReadOnlyInternal(["rev-parse", "--abbrev-ref", "@{upstream}"], repoDir).trim();
  if (!ref || ref.includes("@{upstream}")) {
    return null;
  }
  const parts = ref.split("/");
  const remote = parts[0] ?? "origin";
  const branch = parts.slice(1).join("/");
  const commit = runGitReadOnlyInternal(["rev-parse", "@{upstream}"], repoDir).trim();
  if (!commit || commit.length !== 40) {
    return null;
  }
  return { remote, branch, commit, ref };
}

export function getUpstreamRef(repoDir: string = process.cwd()): string | null {
  return getGitUpstream(repoDir)?.ref ?? null;
}

export function getUpstreamCommit(repoDir: string = process.cwd()): string | null {
  return getGitUpstream(repoDir)?.commit ?? null;
}

export function checkGitUpstreamStatus(repoDir: string = process.cwd()): GitUpstreamStatusResult {
  const upstream = getGitUpstream(repoDir);
  if (!upstream || !upstream.commit) {
    return { upstream: null, divergence: "missing", aheadCount: 0, behindCount: 0 };
  }

  try {
    const counts = runGitReadOnlyInternal(
      ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
      repoDir
    ).trim();
    if (!counts) {
      return { upstream, divergence: "missing", aheadCount: 0, behindCount: 0 };
    }
    const [leftStr, rightStr] = counts.split(/\s+/);
    const aheadCount = parseInt(leftStr ?? "0", 10) || 0;
    const behindCount = parseInt(rightStr ?? "0", 10) || 0;

    let divergence: GitUpstreamDivergence = "equal";
    if (aheadCount > 0 && behindCount > 0) {
      divergence = "diverged";
    } else if (aheadCount > 0) {
      divergence = "ahead";
    } else if (behindCount > 0) {
      divergence = "behind";
    }

    return { upstream, divergence, aheadCount, behindCount };
  } catch {
    return { upstream, divergence: "missing", aheadCount: 0, behindCount: 0 };
  }
}

/**
 * Parse git status --porcelain=v1 -z -uall output deterministically
 */
export function getGitStatus(repoDir: string = process.cwd()): GitStatusSummary {
  const raw = runGitReadOnlyInternal(["status", "--porcelain=v1", "-z", "-uall"], repoDir);
  if (!raw || raw.length === 0) {
    return { isClean: true, entries: [], dirtyFiles: [] };
  }

  const entries: GitStatusEntry[] = [];
  const dirtyFiles = new Set<string>();

  const parts = raw.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    if (!item || item.length < 3) continue;

    const x = item[0]!;
    const y = item[1]!;
    const path = item.slice(3);

    let origPath: string | undefined;
    const isRenamed = x === "R" || y === "R" || x === "C" || y === "C";
    if (isRenamed) {
      // In -z mode, renamed entry is followed by the original path in the next null chunk
      i++;
      origPath = parts[i];
    }

    const isUntracked = x === "?" && y === "?";
    const isStaged = x !== " " && x !== "?";
    const isUnstaged = y !== " " && y !== "?";
    const isDeleted = x === "D" || y === "D";

    entries.push({
      x,
      y,
      path,
      origPath,
      isStaged,
      isUnstaged,
      isUntracked,
      isDeleted,
      isRenamed,
    });

    dirtyFiles.add(path);
    if (origPath) {
      dirtyFiles.add(origPath);
    }
  }

  const sortedDirtyFiles = Array.from(dirtyFiles).sort((a, b) => a.localeCompare(b));

  return {
    isClean: entries.length === 0,
    entries,
    dirtyFiles: sortedDirtyFiles,
  };
}

export const getGitWorkingTreeStatus = getGitStatus;

export function getGitDiffHead(repoDir: string = process.cwd()): string {
  return runGitReadOnlyInternal(["diff", "HEAD"], repoDir);
}

export function getGitUntrackedFiles(repoDir: string = process.cwd()): string[] {
  const raw = runGitReadOnlyInternal(["ls-files", "--others", "--exclude-standard", "-z"], repoDir);
  if (!raw) return [];
  return raw
    .split("\0")
    .filter((f) => f.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

export function getGitIndexBlobSha(path: string, repoDir: string = process.cwd()): string | null {
  try {
    const out = runGitReadOnlyInternal(["ls-files", "-s", "--", path], repoDir).trim();
    if (!out) return null;
    // Format: 100644 <blob-sha> 0	<path>
    const match = out.match(/^\d+\s+([0-9a-f]{40})\s+\d+/);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

/**
 * Read the committed content of a repository-relative file path at HEAD.
 * Returns the file content string, or null if the file does not exist in HEAD.
 * Throws if Git execution fails for reasons other than path non-existence.
 */
export function readCommittedFileAtHead(relPath: string, repoDir: string = process.cwd()): string | null {
  const normalized = relPath.startsWith("/") ? relPath.replace(/^\/+/, "") : relPath;
  try {
    return runGitReadOnlyInternal(["cat-file", "-p", `HEAD:${normalized}`], repoDir);
  } catch (error: unknown) {
    const stderr = (error as { stderr?: string }).stderr?.toString() ?? "";
    const msg = error instanceof Error ? error.message : String(error);
    const combined = `${msg} ${stderr}`;
    if (
      combined.includes("does not exist in 'HEAD'") ||
      combined.includes("Not a valid object name HEAD") ||
      combined.includes("fatal: path") ||
      combined.includes("fatal: Not a valid object name")
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * Validates that a string is a strict 40-character lowercase hexadecimal commit SHA.
 * Rejects symbolic references, revision expressions, and non-hex characters.
 */
export function validateStrictCommitSha(commitSha: unknown): asserts commitSha is string {
  if (typeof commitSha !== "string") {
    throw new Error(`Invalid commit SHA: expected string, got ${typeof commitSha}`);
  }
  const trimmed = commitSha.trim();
  if (trimmed.length !== 40 || !/^[0-9a-f]{40}$/.test(trimmed) || commitSha !== trimmed) {
    throw new Error(
      `Invalid commit SHA: '${commitSha}'; must be strictly a 40-character lowercase hex SHA without revision expressions`
    );
  }
}

/**
 * Read the committed content of a repository-relative file path at a specific immutable commit SHA.
 * Enforces strict 40-character hex commit SHA validation (rejects HEAD, main, A^{tree}, etc.).
 * Returns the file content string, or null if the file does not exist in that commit.
 */
export function readCommittedFileAtCommit(
  repoDir: string,
  commitSha: string,
  repoRelativePath: string
): string | null {
  validateStrictCommitSha(commitSha);

  if (!repoRelativePath || typeof repoRelativePath !== "string") {
    throw new Error("Repository-relative path must be a non-empty string");
  }
  if (repoRelativePath.includes("\0")) {
    throw new Error("Repository-relative path contains null bytes");
  }
  if (repoRelativePath.startsWith("/") || repoRelativePath.startsWith("\\")) {
    throw new Error(`Repository-relative path cannot be absolute: '${repoRelativePath}'`);
  }

  const normalized = repoRelativePath;
  try {
    return runGitReadOnlyInternal(["cat-file", "-p", `${commitSha}:${normalized}`], repoDir);
  } catch (error: unknown) {
    const stderr = (error as { stderr?: string }).stderr?.toString() ?? "";
    const msg = error instanceof Error ? error.message : String(error);
    const combined = `${msg} ${stderr}`;
    if (
      combined.includes("does not exist in") ||
      combined.includes("Not a valid object name") ||
      combined.includes("fatal: path") ||
      combined.includes("fatal: Not a valid object name")
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * Returns complete list of tracked repository entries at a specific immutable commit SHA using `git ls-tree -r -z`.
 * Enforces strict 40-character hex commit SHA validation.
 * NUL-safe and preserves filenames with whitespace, special characters, etc.
 */
export function getTrackedFilesAtCommit(commitSha: string, repoDir: string = process.cwd()): string[] {
  validateStrictCommitSha(commitSha);
  const raw = runGitReadOnlyInternal(["ls-tree", "-r", "-z", commitSha], repoDir);
  if (!raw || raw.length === 0) {
    return [];
  }

  const entries: string[] = [];
  const parts = raw.split("\0");
  for (const part of parts) {
    if (!part || part.length === 0) continue;
    // Format: <mode> SP <type> SP <object>\t<path>
    const tabIdx = part.indexOf("\t");
    if (tabIdx === -1) continue;
    const path = part.slice(tabIdx + 1);
    if (path.length > 0) {
      entries.push(path);
    }
  }

  return entries;
}

export interface CommittedClosureResult {
  isClosed: boolean;
  closureData?: Record<string, unknown> | undefined;
}

/**
 * Reads and verifies the authoritative committed closure for a task directly from Git HEAD.
 * Fails closed if the closure JSON is malformed, schema invalid, missing required fields,
 * or if taskId does not match (R2-03, Decision E).
 */
export function readCommittedClosure(
  taskId: string,
  repoDir: string = process.cwd(),
  commitSha?: string
): CommittedClosureResult {
  validateTaskId(taskId);
  const targetSha = commitSha ?? getGitHead(repoDir);
  validateStrictCommitSha(targetSha);

  // Authoritative committed closure MUST come from Git commit targetSha:
  // targetSha:.agent/tasks/<taskId>/artifacts/closeout.json
  const closeoutRel = `.agent/tasks/${taskId}/artifacts/closeout.json`;
  const rawCloseout = readCommittedFileAtCommit(repoDir, targetSha, closeoutRel);

  if (rawCloseout === null) {
    return { isClosed: false };
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(rawCloseout) as Record<string, unknown>;
  } catch (err: unknown) {
    throw new InvalidCommittedClosureError(
      `Malformed committed closeout artifact at ${targetSha}:${closeoutRel}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new InvalidCommittedClosureError(
      `Committed closeout artifact at ${targetSha}:${closeoutRel} must be a non-null JSON object`
    );
  }

  if (typeof data.taskId !== "string" || data.taskId !== taskId) {
    throw new InvalidCommittedClosureError(
      `Committed closeout artifact taskId mismatch: expected '${taskId}', got '${String(data.taskId)}'`
    );
  }

  try {
    validateArtifactBoundary(repoDir, ArtifactKind.CLOSEOUT, data, {
      runId: typeof data.runId === "string" ? data.runId : "",
      taskId,
    });
  } catch (err: unknown) {
    throw new InvalidCommittedClosureError(
      `Committed closeout schema/semantic validation failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (data.status === "CLOSED") {
    return { isClosed: true, closureData: data };
  }

  return { isClosed: false, closureData: data };
}

export interface CommittedTaskPacketResult {
  taskPacket: Record<string, unknown>;
  taskAuthorityCommit: string;
  [key: string]: unknown;
}

/**
 * Reads and verifies canonical Task Packet strictly at an immutable commit SHA (Architecture Decision CM).
 * Derives taskAuthorityCommit from Git history anchored to commitSha (last commit modifying task.json reachable from commitSha).
 * Committed Task Packet MUST contain a valid taskId equal to requested taskId.
 */
export function readCanonicalTaskPacketAtCommit(
  repoDir: string,
  taskId: string,
  commitSha: string
): CommittedTaskPacketResult {
  validateTaskId(taskId);
  validateStrictCommitSha(commitSha);

  const primaryRel = `.agent/tasks/${taskId}/task.json`;
  const raw = readCommittedFileAtCommit(repoDir, commitSha, primaryRel);

  if (raw === null) {
    throw new TaskPacketNotCommittedError(taskId);
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch (err: unknown) {
    throw new ArtifactValidationError(
      `Malformed committed task packet at ${commitSha}:${primaryRel}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ArtifactValidationError(
      `Committed task packet at ${commitSha}:${primaryRel} must be a non-null JSON object`
    );
  }

  // Schema validation against cindy-task-packet.schema.json
  validateArtifactBoundary(repoDir, ArtifactKind.TASK_PACKET, data, {
    runId: "",
    taskId,
  });

  const rawTaskId = data.taskId;

  if (!rawTaskId || typeof rawTaskId !== "string") {
    throw new ArtifactValidationError(
      `Committed task packet at ${commitSha}:${primaryRel} is missing required 'taskId'`
    );
  }

  validateTaskId(rawTaskId);

  if (rawTaskId !== taskId) {
    throw new ArtifactValidationError(
      `Committed task packet taskId mismatch: expected '${taskId}', got '${String(rawTaskId)}'`
    );
  }

  const branch = data.branch;
  if (typeof branch !== "string" || branch.trim().length === 0 || branch === "HEAD" || /[\x00-\x1f\x7f]/.test(branch)) {
    throw new ArtifactValidationError(
      `Committed task packet at ${commitSha}:${primaryRel} has invalid 'branch': '${String(branch)}'`
    );
  }

  const baseCommit = data.baseCommit;
  if (typeof baseCommit !== "string" || !/^[0-9a-f]{40}$/.test(baseCommit)) {
    throw new ArtifactValidationError(
      `Committed task packet at ${commitSha}:${primaryRel} has invalid 'baseCommit': '${String(baseCommit)}' (must be 40-char lowercase hex)`
    );
  }

  if (!("allowedScope" in data) || !Array.isArray(data.allowedScope)) {
    throw new ArtifactValidationError(
      `INVALID_COMMITTED_TASK_PACKET: Committed task packet at ${commitSha}:${primaryRel} is missing required canonical scope 'allowedScope'`
    );
  }

  for (const entry of data.allowedScope) {
    if (typeof entry !== "string") {
      throw new ArtifactValidationError(
        `Committed task packet at ${commitSha}:${primaryRel} allowedScope entry must be string, got ${typeof entry}`
      );
    }
    validateScopeEntry(entry, repoDir);
  }

  // Derivation of task authority commit strictly anchored to commitSha (not symbolic HEAD!)
  const authCommit = runGitReadOnlyInternal(["log", "-1", "--format=%H", commitSha, "--", primaryRel], repoDir).trim();
  if (!authCommit || authCommit.length !== 40) {
    throw new ArtifactValidationError(
      `Could not determine task authority commit for '${primaryRel}' from ${commitSha} history`
    );
  }

  const result: CommittedTaskPacketResult = {
    ...data,
    taskPacket: data,
    taskAuthorityCommit: authCommit,
  };

  return result;
}

/**
 * Reads and verifies the authoritative committed Task Packet from Git HEAD or targetSha (R2-04, R2-06, Decision L, Decision T, Decision CM).
 * Derives taskAuthorityCommit from Git history (last commit modifying the task packet reachable from targetSha).
 * Committed Task Packet MUST contain a valid taskId equal to requested taskId.
 */
export function readCommittedTaskPacket(
  taskId: string,
  repoDir: string = process.cwd(),
  commitSha?: string
): CommittedTaskPacketResult | null {
  validateTaskId(taskId);
  const targetSha = commitSha ?? getGitHead(repoDir);
  validateStrictCommitSha(targetSha);

  try {
    return readCanonicalTaskPacketAtCommit(repoDir, taskId, targetSha);
  } catch (err: unknown) {
    if (err instanceof TaskPacketNotCommittedError) {
      return null;
    }
    throw err;
  }
}

export function getTaskAuthorityCommit(taskId: string, repoDir: string = process.cwd(), commitSha?: string): string | null {
  validateTaskId(taskId);
  const packet = readCommittedTaskPacket(taskId, repoDir, commitSha);
  return packet?.taskAuthorityCommit ?? null;
}

/**
 * Checks whether ancestorCommit is an ancestor of (or equal to) descendantCommit in Git history.
 */
export function isGitAncestor(
  ancestorCommit: string,
  descendantCommit: string,
  repoDir: string = process.cwd()
): boolean {
  if (!ancestorCommit || !descendantCommit) return false;
  if (ancestorCommit === descendantCommit) return true;
  try {
    runGitReadOnlyInternal(["merge-base", "--is-ancestor", ancestorCommit, descendantCommit], repoDir);
    return true;
  } catch {
    return false;
  }
}

export interface EvaluateGitAuthorityOptions {
  repoDir?: string | undefined;
  taskId: string;
  runSnapshot?: {
    branch?: string | undefined;
    headCommit?: string | undefined;
    baseCommit?: string | undefined;
    taskAuthorityCommit?: string | undefined;
    upstreamSha?: string | undefined;
    upstreamRef?: string | undefined;
    upstreamCommit?: string | undefined;
    allowedScope?: string[] | undefined;
  } | undefined;
  callerAssertions?: {
    expectedBranch?: string | undefined;
    expectedBaseCommit?: string | undefined;
    expectedUpstreamSha?: string | undefined;
    allowedScope?: string[] | undefined;
  } | undefined;
}

export interface GitAuthorityEvaluation {
  ok: boolean;
  actualBranch: string;
  actualHead: string;
  actualUpstream: GitUpstreamInfo | null;
  upstreamDivergence: GitUpstreamDivergence;
  actualStatus: GitStatusSummary;
  taskPacket: Record<string, unknown> | null;
  taskAuthorityCommit?: string | null | undefined;
  closure: CommittedClosureResult | null;
  stopState: CindyState | null;
  stopReason: CindyStopReason | null;
  stopExplanation: string | null;
  authorityContext?: ValidatedGitAuthorityContext | null | undefined;
}

/**
 * Pure evaluation function checking live Git authority facts against:
 * 1. Committed Task Packet at HEAD
 * 2. Run's recorded Git snapshot
 * 3. Caller assertions (narrowing/validating only)
 * 4. HEAD vs Upstream relationship (equal / ahead / behind / diverged)
 *
 * Shared identically across initRun, resumeRun, and reconcileCurrentState.
 */
export function evaluateGitAuthority(options: EvaluateGitAuthorityOptions): GitAuthorityEvaluation {
  const repoDir = options.repoDir ?? process.cwd();
  const taskId = options.taskId;
  validateTaskId(taskId);
  const runSnapshot = options.runSnapshot;
  const caller = options.callerAssertions;

  const actualBranch = getGitBranch(repoDir);
  const actualHead = getGitHead(repoDir);
  validateStrictCommitSha(actualHead);
  const upstreamStatus = checkGitUpstreamStatus(repoDir);
  const actualUpstream = upstreamStatus.upstream;
  let currentStatus = getGitStatus(repoDir);

  const makeResult = (
    ok: boolean,
    taskPacket: Record<string, unknown> | null,
    closure: CommittedClosureResult | null,
    stopState: CindyState | null = null,
    stopReason: CindyStopReason | null = null,
    stopExplanation: string | null = null,
    taskAuthorityCommit: string | null = null
  ): GitAuthorityEvaluation => {
    const authorityContext: ValidatedGitAuthorityContext | null = ok
      ? {
          headCommit: actualHead,
          branch: actualBranch,
          upstreamRef: actualUpstream?.ref ?? null,
          upstreamCommit: actualUpstream?.commit ?? null,
          aheadCount: upstreamStatus.aheadCount,
          behindCount: upstreamStatus.behindCount,
          divergence: upstreamStatus.divergence,
          taskPacket,
          taskAuthorityCommit,
          actualStatus: {
            isClean: currentStatus.isClean,
            dirtyFiles: [...currentStatus.dirtyFiles],
            entries: [...currentStatus.entries],
          },
          closure: closure ? { isClosed: closure.isClosed, closureData: closure.closureData } : null,
        }
      : null;

    return {
      ok,
      actualBranch,
      actualHead,
      actualUpstream,
      upstreamDivergence: upstreamStatus.divergence,
      actualStatus: currentStatus,
      taskPacket,
      taskAuthorityCommit,
      closure,
      stopState,
      stopReason,
      stopExplanation,
      authorityContext,
    };
  };

  // 1. Detached HEAD check
  if (!actualBranch || actualBranch === "HEAD") {
    return makeResult(
      false,
      null,
      null,
      CindyState.GIT_SAFETY_STOP,
      CindyStopReason.BRANCH_MISMATCH,
      "Detached HEAD is not permitted in Cindy control plane"
    );
  }

  // 2. Authoritative committed closure validation from immutable actualHead (Architecture Decision CM)
  let closure: CommittedClosureResult | null = null;
  try {
    closure = readCommittedClosure(taskId, repoDir, actualHead);
  } catch (err: unknown) {
    return makeResult(
      false,
      null,
      null,
      CindyState.CONTRACT_CONFLICT,
      CindyStopReason.INVALID_COMMITTED_CLOSURE,
      `INVALID_COMMITTED_CLOSURE: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 3. Authoritative canonical task packet from immutable actualHead (Architecture Decision CM)
  let committedPacketResult: CommittedTaskPacketResult | null = null;
  try {
    committedPacketResult = readCanonicalTaskPacketAtCommit(repoDir, taskId, actualHead);
  } catch (err: unknown) {
    if (err instanceof TaskPacketNotCommittedError) {
      return makeResult(
        false,
        null,
        closure,
        CindyState.CONTRACT_CONFLICT,
        CindyStopReason.TASK_PACKET_NOT_COMMITTED,
        `TASK_PACKET_NOT_COMMITTED: Authoritative task packet for '${taskId}' not found in ${actualHead}`
      );
    }
    return makeResult(
      false,
      null,
      closure,
      CindyState.CONTRACT_CONFLICT,
      CindyStopReason.CONTRACT_CONFLICT,
      `Failed to parse committed task packet: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!committedPacketResult) {
    return makeResult(
      false,
      null,
      closure,
      CindyState.CONTRACT_CONFLICT,
      CindyStopReason.TASK_PACKET_NOT_COMMITTED,
      `TASK_PACKET_NOT_COMMITTED: Authoritative task packet for '${taskId}' not found in ${actualHead}`
    );
  }

  const taskPacket = committedPacketResult.taskPacket;
  const taskAuthorityCommit = committedPacketResult.taskAuthorityCommit;
  const taskBranch = taskPacket.branch as string;
  const taskBase = taskPacket.baseCommit as string;
  const taskScope = taskPacket.allowedScope as string[];

  // 4. Caller assertion conflicts check (Finding 6, Decision L)
  if (caller) {
    if (caller.expectedBranch && caller.expectedBranch !== actualBranch) {
      return makeResult(
        false,
        taskPacket,
        closure,
        CindyState.GIT_SAFETY_STOP,
        CindyStopReason.BRANCH_MISMATCH,
        `BRANCH_MISMATCH: Caller expectedBranch '${caller.expectedBranch}' does not match actual branch '${actualBranch}'`
      );
    }
    if (caller.expectedBranch && taskBranch && caller.expectedBranch !== taskBranch) {
      return makeResult(
        false,
        taskPacket,
        closure,
        CindyState.GIT_SAFETY_STOP,
        CindyStopReason.BRANCH_MISMATCH,
        `BRANCH_MISMATCH: Caller expectedBranch '${caller.expectedBranch}' cannot override committed task branch '${taskBranch}'`
      );
    }

    if (caller.expectedBaseCommit && caller.expectedBaseCommit !== taskBase) {
      return makeResult(
        false,
        taskPacket,
        closure,
        CindyState.GIT_SAFETY_STOP,
        CindyStopReason.BASELINE_MISMATCH,
        `BASELINE_MISMATCH: Caller expectedBaseCommit '${caller.expectedBaseCommit}' does not match committed task baseCommit '${taskBase}'`
      );
    }
    if (caller.expectedUpstreamSha) {
      if (!actualUpstream || actualUpstream.commit !== caller.expectedUpstreamSha) {
        return makeResult(
          false,
          taskPacket,
          closure,
          CindyState.GIT_SAFETY_STOP,
          CindyStopReason.UPSTREAM_DRIFT,
          `UPSTREAM_DRIFT: Upstream drift detected: Caller expectedUpstreamSha '${caller.expectedUpstreamSha}' does not match actual upstream '${actualUpstream?.commit ?? "none"}'`
        );
      }
    }
  }

  // Task baseline historical declaration vs Git-derived authority ancestry check (Architecture Decision X)
  if (taskBase && !isGitAncestor(taskBase, taskAuthorityCommit, repoDir)) {
    return makeResult(
      false,
      taskPacket,
      closure,
      CindyState.GIT_SAFETY_STOP,
      CindyStopReason.BASELINE_DRIFT,
      `BASELINE_DRIFT: Committed task baseCommit '${taskBase}' is not an ancestor of task authority commit '${taskAuthorityCommit}'`
    );
  }

  // 5. Branch validation
  if (taskBranch && actualBranch !== taskBranch) {
    return makeResult(
      false,
      taskPacket,
      closure,
      CindyState.GIT_SAFETY_STOP,
      CindyStopReason.BRANCH_MISMATCH,
      `BRANCH_MISMATCH: Actual Git branch '${actualBranch}' does not match committed task branch '${taskBranch}'`
    );
  }
  if (runSnapshot?.branch && actualBranch !== runSnapshot.branch) {
    return makeResult(
      false,
      taskPacket,
      closure,
      CindyState.GIT_SAFETY_STOP,
      CindyStopReason.BRANCH_MISMATCH,
      `BRANCH_MISMATCH: Actual Git branch '${actualBranch}' does not match run bound branch '${runSnapshot.branch}'`
    );
  }

  // 6. Upstream checks (missing, drift, ahead, behind, diverged)
  if (!actualUpstream || !actualUpstream.commit || !actualUpstream.ref) {
    return makeResult(
      false,
      taskPacket,
      closure,
      CindyState.GIT_SAFETY_STOP,
      CindyStopReason.UPSTREAM_MISSING,
      `UPSTREAM_MISSING: No upstream branch configured for branch '${actualBranch}'`
    );
  }

  if (runSnapshot) {
    // Check snapshot completeness (Decision I, J, Q)
    if (
      !runSnapshot.upstreamRef ||
      !runSnapshot.upstreamCommit ||
      runSnapshot.upstreamCommit.length !== 40 ||
      !runSnapshot.taskAuthorityCommit ||
      typeof runSnapshot.taskAuthorityCommit !== "string" ||
      runSnapshot.taskAuthorityCommit.length !== 40
    ) {
      return makeResult(
        false,
        taskPacket,
        closure,
        CindyState.GIT_SAFETY_STOP,
        CindyStopReason.RUN_GIT_SNAPSHOT_INCOMPLETE,
        "RUN_GIT_SNAPSHOT_INCOMPLETE: Run Git authority snapshot missing upstreamRef, upstreamCommit, or taskAuthorityCommit"
      );
    }

    // Live Task Authority & Declared Baseline Equations (Architecture Decision X):
    // A - Live Task Authority:
    // run.taskAuthorityCommit == currentTask.taskAuthorityCommit == run.headCommit == actualHead
    if (runSnapshot.taskAuthorityCommit !== taskAuthorityCommit) {
      return makeResult(
        false,
        taskPacket,
        closure,
        CindyState.GIT_SAFETY_STOP,
        CindyStopReason.TASK_PACKET_DRIFT,
        `TASK_PACKET_DRIFT: Run bound taskAuthorityCommit '${runSnapshot.taskAuthorityCommit}' does not match current task authority commit '${taskAuthorityCommit}'`
      );
    }
    if (runSnapshot.headCommit !== runSnapshot.taskAuthorityCommit) {
      return makeResult(
        false,
        taskPacket,
        closure,
        CindyState.GIT_SAFETY_STOP,
        CindyStopReason.BASELINE_MISMATCH,
        `BASELINE_MISMATCH: Run bound headCommit '${runSnapshot.headCommit}' does not match taskAuthorityCommit '${runSnapshot.taskAuthorityCommit}'`
      );
    }
    if (actualHead !== runSnapshot.headCommit) {
      return makeResult(
        false,
        taskPacket,
        closure,
        CindyState.GIT_SAFETY_STOP,
        CindyStopReason.HEAD_DRIFT,
        `HEAD_DRIFT: Actual Git HEAD '${actualHead}' does not match run bound HEAD '${runSnapshot.headCommit}'`
      );
    }
    if (actualHead !== taskAuthorityCommit) {
      return makeResult(
        false,
        taskPacket,
        closure,
        CindyState.GIT_SAFETY_STOP,
        CindyStopReason.BASELINE_DRIFT,
        `BASELINE_DRIFT: Actual Git HEAD '${actualHead}' does not match task authority commit '${taskAuthorityCommit}'`
      );
    }

    // B - Declared Task Baseline:
    // run.baseCommit == currentTask.baseCommit (does NOT require run.baseCommit == taskAuthorityCommit)
    if (runSnapshot.baseCommit !== taskBase) {
      return makeResult(
        false,
        taskPacket,
        closure,
        CindyState.GIT_SAFETY_STOP,
        CindyStopReason.BASELINE_MISMATCH,
        `BASELINE_MISMATCH: Run bound baseCommit '${runSnapshot.baseCommit}' does not match committed task baseCommit '${taskBase}'`
      );
    }
    if (runSnapshot.baseCommit && !isGitAncestor(runSnapshot.baseCommit, runSnapshot.taskAuthorityCommit, repoDir)) {
      return makeResult(
        false,
        taskPacket,
        closure,
        CindyState.GIT_SAFETY_STOP,
        CindyStopReason.BASELINE_DRIFT,
        `BASELINE_DRIFT: Run bound baseCommit '${runSnapshot.baseCommit}' is not an ancestor of task authority commit '${runSnapshot.taskAuthorityCommit}'`
      );
    }

    const boundUpstreamSha = runSnapshot.upstreamCommit ?? runSnapshot.upstreamSha;
    if (boundUpstreamSha && actualUpstream.commit !== boundUpstreamSha) {
      return makeResult(
        false,
        taskPacket,
        closure,
        CindyState.GIT_SAFETY_STOP,
        CindyStopReason.UPSTREAM_DRIFT,
        `UPSTREAM_DRIFT: Upstream drift detected: expected upstream SHA ${boundUpstreamSha} but found ${actualUpstream.commit}`
      );
    }

    if (runSnapshot.upstreamRef && actualUpstream.ref && actualUpstream.ref !== runSnapshot.upstreamRef) {
      return makeResult(
        false,
        taskPacket,
        closure,
        CindyState.GIT_SAFETY_STOP,
        CindyStopReason.UPSTREAM_DRIFT,
        `UPSTREAM_DRIFT: Upstream ref drift detected: expected ref ${runSnapshot.upstreamRef} but found ${actualUpstream.ref}`
      );
    }

    if (upstreamStatus.divergence === "ahead") {
      return makeResult(
        false,
        taskPacket,
        closure,
        CindyState.GIT_SAFETY_STOP,
        CindyStopReason.UPSTREAM_AHEAD,
        `UPSTREAM_AHEAD: Local branch '${actualBranch}' is ahead of upstream by ${upstreamStatus.aheadCount} commit(s)`
      );
    }
    if (upstreamStatus.divergence === "behind") {
      return makeResult(
        false,
        taskPacket,
        closure,
        CindyState.GIT_SAFETY_STOP,
        CindyStopReason.UPSTREAM_BEHIND,
        `UPSTREAM_BEHIND: Local branch '${actualBranch}' is behind upstream by ${upstreamStatus.behindCount} commit(s)`
      );
    }
    if (upstreamStatus.divergence === "diverged") {
      return makeResult(
        false,
        taskPacket,
        closure,
        CindyState.GIT_SAFETY_STOP,
        CindyStopReason.UPSTREAM_DIVERGED,
        `UPSTREAM_DIVERGED: Local branch '${actualBranch}' and upstream have diverged (+${upstreamStatus.aheadCount}/-${upstreamStatus.behindCount})`
      );
    }
  } else {
    if (upstreamStatus.divergence === "ahead") {
      return makeResult(
        false,
        taskPacket,
        closure,
        CindyState.GIT_SAFETY_STOP,
        CindyStopReason.UPSTREAM_AHEAD,
        `UPSTREAM_AHEAD: Local branch '${actualBranch}' is ahead of upstream by ${upstreamStatus.aheadCount} commit(s)`
      );
    }
    if (upstreamStatus.divergence === "behind") {
      return makeResult(
        false,
        taskPacket,
        closure,
        CindyState.GIT_SAFETY_STOP,
        CindyStopReason.UPSTREAM_BEHIND,
        `UPSTREAM_BEHIND: Local branch '${actualBranch}' is behind upstream by ${upstreamStatus.behindCount} commit(s)`
      );
    }
    if (upstreamStatus.divergence === "diverged") {
      return makeResult(
        false,
        taskPacket,
        closure,
        CindyState.GIT_SAFETY_STOP,
        CindyStopReason.UPSTREAM_DIVERGED,
        `UPSTREAM_DIVERGED: Local branch '${actualBranch}' and upstream have diverged (+${upstreamStatus.aheadCount}/-${upstreamStatus.behindCount})`
      );
    }

    // Architecture Decision H & L: Exact Commit Equality at init/without run
    if (actualHead !== taskAuthorityCommit) {
      return makeResult(
        false,
        taskPacket,
        closure,
        CindyState.GIT_SAFETY_STOP,
        CindyStopReason.BASELINE_DRIFT,
        `BASELINE_DRIFT: Actual Git HEAD '${actualHead}' does not match task authority commit '${taskAuthorityCommit}'`
      );
    }
  }

  // 8. Dirty tree ownership validation
  if (!currentStatus.isClean) {
    const scope = runSnapshot?.allowedScope ?? taskScope;
    const ownership = checkDirtyTreeOwnership(scope, currentStatus.dirtyFiles, repoDir);
    if (!ownership.ok) {
      return makeResult(
        false,
        taskPacket,
        closure,
        CindyState.DIRTY_TREE_UNEXPLAINED,
        CindyStopReason.DIRTY_TREE_UNEXPLAINED,
        `DIRTY_TREE_UNEXPLAINED: Unexplained dirty files in working tree: ${ownership.unexplainedFiles.join(", ")}`
      );
    }
  }

  // 9. Final Authority Fence (Architecture Decision CM + DD)
  // Architecture Decision DD: The final authority fence MUST fresh-reread the dirty working-tree
  // ownership and status. Using the initial actualStatus is insufficient — new outside-scope files
  // may have been added between the initial read and this fence.
  const finalBranch = getGitBranch(repoDir);
  const finalHead = getGitHead(repoDir);
  const finalUpstreamStatus = checkGitUpstreamStatus(repoDir);
  const finalUpstream = finalUpstreamStatus.upstream;

  if (finalBranch !== actualBranch || finalHead !== actualHead) {
    return makeResult(
      false,
      taskPacket,
      closure,
      CindyState.GIT_SAFETY_STOP,
      CindyStopReason.HEAD_DRIFT,
      `HEAD_DRIFT: Live repository authority drifted during evaluation: branch (${actualBranch} -> ${finalBranch}) or HEAD (${actualHead} -> ${finalHead}) changed`
    );
  }

  if (
    finalUpstreamStatus.divergence !== upstreamStatus.divergence ||
    finalUpstream?.ref !== actualUpstream?.ref ||
    finalUpstream?.commit !== actualUpstream?.commit ||
    finalUpstreamStatus.aheadCount !== upstreamStatus.aheadCount ||
    finalUpstreamStatus.behindCount !== upstreamStatus.behindCount
  ) {
    return makeResult(
      false,
      taskPacket,
      closure,
      CindyState.GIT_SAFETY_STOP,
      CindyStopReason.UPSTREAM_DRIFT,
      `UPSTREAM_DRIFT: Live upstream authority drifted during evaluation`
    );
  }

  // Architecture Decision DD: Fresh dirty-tree re-read in final authority fence.
  // Must recompute from live filesystem — initial actualStatus may be stale.
  const finalStatus = getGitStatus(repoDir);
  currentStatus = finalStatus;
  if (!finalStatus.isClean) {
    const finalScope = runSnapshot?.allowedScope ?? taskScope;
    const finalOwnership = checkDirtyTreeOwnership(finalScope, finalStatus.dirtyFiles, repoDir);
    if (!finalOwnership.ok) {
      return makeResult(
        false,
        taskPacket,
        closure,
        CindyState.DIRTY_TREE_UNEXPLAINED,
        CindyStopReason.DIRTY_TREE_UNEXPLAINED,
        `DIRTY_TREE_UNEXPLAINED: Dirty file(s) added outside allowed scope during evaluation window: ${finalOwnership.unexplainedFiles.join(", ")}`
      );
    }
  }

  return makeResult(true, taskPacket, closure, null, null, null, taskAuthorityCommit);
}
