import { resolve, relative, isAbsolute, sep, normalize, join } from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import {
  ArtifactKind,
  InvalidRunIdError,
  InvalidTaskIdError,
  PathTraversalError,
  ArtifactValidationError,
  InvalidRepositoryRootError,
} from "./types.ts";

const RUN_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const TASK_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const CYCLIC_ARTIFACT_KINDS: ReadonlySet<ArtifactKind> = new Set([
  ArtifactKind.TEST_RESULT,
  ArtifactKind.REVIEW_REQUEST,
  ArtifactKind.REVIEW_RESULT,
  ArtifactKind.REPAIR_INIT,
]);

export const STRICT_NON_CYCLIC_KINDS: ReadonlySet<ArtifactKind> = new Set([
  ArtifactKind.RUN,
  ArtifactKind.BASELINE,
  ArtifactKind.CLOSEOUT,
  ArtifactKind.GIT_RECEIPT,
  ArtifactKind.NEXT_TASK,
  ArtifactKind.TASK_PACKET,
]);

export function isCyclicArtifactKind(kind: ArtifactKind): boolean {
  return CYCLIC_ARTIFACT_KINDS.has(kind);
}

/**
 * Strictly validate that a runId cannot escape runtime directories.
 */
export function validateRunId(runId: string): void {
  if (!runId || typeof runId !== "string") {
    throw new InvalidRunIdError("runId must be a non-empty string");
  }

  if (runId === "." || runId === "..") {
    throw new InvalidRunIdError(`Illegal runId: '${runId}' cannot be '.' or '..'`);
  }

  if (runId.includes("/") || runId.includes("\\") || runId.includes("\0")) {
    throw new InvalidRunIdError(`Illegal runId: '${runId}' contains path separators or null bytes`);
  }

  if (isAbsolute(runId) || normalize(runId) !== runId || runId.includes("..")) {
    throw new InvalidRunIdError(`Illegal runId: '${runId}' contains path traversal or absolute path`);
  }

  if (!RUN_ID_REGEX.test(runId)) {
    throw new InvalidRunIdError(
      `Illegal runId: '${runId}' does not match required format ^[a-zA-Z0-9][a-zA-Z0-9._-]*$`
    );
  }
}

/**
 * Strictly validate taskId across all entry points: filesystem, Git, runtime, lookup.
 * Rejects traversal, path separators, hidden files, empty, whitespace, and special characters.
 */
export function validateTaskId(taskId: string): void {
  if (!taskId || typeof taskId !== "string") {
    throw new InvalidTaskIdError("taskId must be a non-empty string");
  }

  if (taskId === "." || taskId === "..") {
    throw new InvalidTaskIdError(`Illegal taskId: '${taskId}' cannot be '.' or '..'`);
  }

  if (taskId.trim() !== taskId) {
    throw new InvalidTaskIdError(`Illegal taskId: '${taskId}' cannot have leading or trailing whitespace`);
  }

  if (
    taskId.includes("/") ||
    taskId.includes("\\") ||
    taskId.includes("\0") ||
    taskId.includes("\n") ||
    taskId.includes("\r") ||
    taskId.includes("\t")
  ) {
    throw new InvalidTaskIdError(`Illegal taskId: '${taskId}' contains illegal characters or path separators`);
  }

  if (!TASK_ID_REGEX.test(taskId)) {
    throw new InvalidTaskIdError(
      `Illegal taskId: '${taskId}' does not match required format ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`
    );
  }
}

/**
 * Canonicalizes a repository root directory path once at startup / boundary.
 * Resolves symlinks using realpathSync. Fails closed with InvalidRepositoryRootError
 * if repoDir does not exist or is not a real directory.
 * NO lexical fallback is allowed.
 */
export function canonicalizeRepoDir(repoDir: string): string {
  if (!repoDir || typeof repoDir !== "string") {
    throw new InvalidRepositoryRootError("INVALID_REPOSITORY_ROOT: repoDir must be a non-empty string");
  }
  try {
    const canonical = realpathSync(repoDir);
    const stat = lstatSync(canonical);
    if (!stat.isDirectory()) {
      throw new InvalidRepositoryRootError(`INVALID_REPOSITORY_ROOT: Repository root is not a directory: ${repoDir}`);
    }
    return canonical;
  } catch (err: unknown) {
    if (err instanceof InvalidRepositoryRootError) throw err;
    throw new InvalidRepositoryRootError(
      `INVALID_REPOSITORY_ROOT: Repository root does not exist or cannot be resolved: ${repoDir} (${err instanceof Error ? err.message : String(err)})`
    );
  }
}

/**
 * Asserts that no component from repoDir down to targetPath is a symbolic link.
 * Every existing component in the ancestor chain must be a real directory or file, not a symlink.
 * Fails closed with PathTraversalError if any symlink (including dangling symlink) is encountered.
 */
export function assertNoSymlinkAncestors(repoDir: string, targetPath: string): void {
  const resolvedRepo = canonicalizeRepoDir(repoDir);
  const resolvedTarget = resolve(targetPath);

  const rel = relative(resolvedRepo, resolvedTarget);
  if (rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("../") || isAbsolute(rel)) {
    throw new PathTraversalError(
      `Target path '${resolvedTarget}' escapes repository root '${resolvedRepo}'`
    );
  }

  try {
    const repoStat = lstatSync(resolvedRepo);
    if (repoStat.isSymbolicLink()) {
      throw new PathTraversalError(`Repository root is a symlink: '${resolvedRepo}'`);
    }
  } catch (err: unknown) {
    if (err instanceof PathTraversalError) throw err;
  }

  const parts = rel.split(sep);
  let current = resolvedRepo;

  for (const part of parts) {
    if (!part || part === ".") continue;
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new PathTraversalError(`Symlink detected in path component: '${current}'`);
      }
    } catch (err: unknown) {
      if (err instanceof PathTraversalError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        break;
      }
      throw err;
    }
  }

  // Check target itself for dangling symlink or existing symlink
  try {
    const targetStat = lstatSync(resolvedTarget);
    if (targetStat.isSymbolicLink()) {
      throw new PathTraversalError(
        `Artifact target cannot be a symbolic link: '${resolvedTarget}'`
      );
    }
  } catch (err: unknown) {
    if (err instanceof PathTraversalError) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Parses raw kind string and optional cycle into validated ArtifactKind and safe cycle.
 * For cyclic kinds, strictly validates safe positive integer cycle.
 * For non-cyclic kinds, rejects any explicit cycle fail closed.
 */
export function parseArtifactKindAndCycle(
  rawKind: string,
  explicitCycle?: number
): { kind: ArtifactKind; cycle?: number | undefined } {
  let kind: ArtifactKind | undefined;
  let parsedCycle: number | undefined;

  if (Object.values(ArtifactKind).includes(rawKind as ArtifactKind)) {
    kind = rawKind as ArtifactKind;
  } else {
    const match = rawKind.match(/^([a-z-]+)-cycle-([1-9]\d*)$/);
    if (match) {
      const matchedKind = match[1]!;
      if (Object.values(ArtifactKind).includes(matchedKind as ArtifactKind)) {
        kind = matchedKind as ArtifactKind;
        parsedCycle = parseInt(match[2]!, 10);
      }
    }
  }

  if (!kind) {
    throw new ArtifactValidationError(
      `Unknown or unauthorized artifactKind: '${rawKind}'. Allowed: ${Object.values(ArtifactKind).join(", ")}`
    );
  }

  const cycle = explicitCycle !== undefined ? explicitCycle : parsedCycle;

  if (STRICT_NON_CYCLIC_KINDS.has(kind)) {
    if (cycle !== undefined) {
      throw new ArtifactValidationError(
        `Artifact kind '${kind}' is not a cycle artifact and does not accept a cycle`
      );
    }
    return { kind, cycle: undefined };
  }

  if (isCyclicArtifactKind(kind)) {
    if (cycle === undefined) {
      throw new ArtifactValidationError(
        `Artifact kind '${kind}' requires a positive safe integer cycle >= 1`
      );
    }
    if (
      typeof cycle !== "number" ||
      Number.isNaN(cycle) ||
      !Number.isFinite(cycle) ||
      !Number.isSafeInteger(cycle) ||
      cycle < 1 ||
      cycle > Number.MAX_SAFE_INTEGER
    ) {
      throw new ArtifactValidationError(
        `Artifact kind '${kind}' requires a positive safe integer cycle >= 1, got: ${String(cycle)}`
      );
    }
    const cycleStr = cycle.toString(10);
    if (cycleStr.includes("e") || cycleStr.includes("E")) {
      throw new ArtifactValidationError(
        `Artifact kind '${kind}' cycle cannot use exponential notation: ${cycleStr}`
      );
    }
    return { kind, cycle };
  }

  // DIFF_MANIFEST supports both single diff-manifest.json and per-cycle diff-manifest-cycle-N.json
  if (kind === ArtifactKind.DIFF_MANIFEST) {
    if (cycle !== undefined) {
      if (
        typeof cycle !== "number" ||
        Number.isNaN(cycle) ||
        !Number.isFinite(cycle) ||
        !Number.isSafeInteger(cycle) ||
        cycle < 1 ||
        cycle > Number.MAX_SAFE_INTEGER
      ) {
        throw new ArtifactValidationError(
          `Artifact kind '${kind}' requires a positive safe integer cycle, got: ${String(cycle)}`
        );
      }
      const cycleStr = cycle.toString(10);
      if (cycleStr.includes("e") || cycleStr.includes("E")) {
        throw new ArtifactValidationError(
          `Artifact kind '${kind}' cycle cannot use exponential notation: ${cycleStr}`
        );
      }
      return { kind, cycle };
    }
    return { kind, cycle: undefined };
  }

  return { kind, cycle };
}

/**
 * Maps closed ArtifactKind and safe cycle integer to deterministic filename.
 */
export function getArtifactFilename(rawKind: string, explicitCycle?: number): string {
  const { kind, cycle } = parseArtifactKindAndCycle(rawKind, explicitCycle);

  switch (kind) {
    case ArtifactKind.RUN:
      return "run.json";
    case ArtifactKind.BASELINE:
      return "baseline.json";
    case ArtifactKind.DIFF_MANIFEST:
      return cycle !== undefined ? `diff-manifest-cycle-${cycle}.json` : "diff-manifest.json";
    case ArtifactKind.CLOSEOUT:
      return "closeout.json";
    case ArtifactKind.GIT_RECEIPT:
      return "git-receipt.json";
    case ArtifactKind.NEXT_TASK:
      return "next-task.json";

    // Cyclic artifacts
    case ArtifactKind.TEST_RESULT:
    case ArtifactKind.REVIEW_REQUEST:
    case ArtifactKind.REVIEW_RESULT:
    case ArtifactKind.REPAIR_INIT:
      return `${kind}-cycle-${cycle}.json`;

    default:
      throw new ArtifactValidationError(
        `Unknown or unauthorized artifactKind: '${rawKind}'. Allowed: ${Object.values(ArtifactKind).join(", ")}`
      );
  }
}

/**
 * Resolves and validates the run directory, ensuring it cannot escape .agent/runtime/
 * and none of its ancestors are symbolic links.
 *
 * THREAT MODEL NOTE (Decision B - Approved):
 * The Control Plane MVP canonicalizes repoRoot once here using realpathSync().
 * This resolves any symlinks in the caller-provided repoDir before all subsequent
 * path operations. If the caller passes a symlinked repo path, it is resolved to the
 * true canonical root or explicitly rejected.
 *
 * The MVP does NOT claim to defend against an adversarial OS-level process that can
 * perform active TOCTOU attacks between lstat() and filesystem syscalls on the same
 * UID — such a process already has direct filesystem write access to the repo.
 */
export function resolveSafeRunDir(repoDir: string, runId: string): string {
  validateRunId(runId);

  const resolvedRepo = canonicalizeRepoDir(repoDir);
  const runtimeRoot = resolve(resolvedRepo, ".agent", "runtime");
  const runDir = resolve(runtimeRoot, runId);

  // String containment check
  const rel = relative(runtimeRoot, runDir);
  if (rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("../") || isAbsolute(rel) || rel === "" || rel.includes(sep)) {
    throw new PathTraversalError(`runDir '${runDir}' escapes runtime root '${runtimeRoot}'`);
  }

  if (!runDir.startsWith(runtimeRoot + sep)) {
    throw new PathTraversalError(`runDir '${runDir}' is outside runtime root '${runtimeRoot}'`);
  }

  assertNoSymlinkAncestors(resolvedRepo, runDir);

  return runDir;
}

/**
 * Resolves safe artifact path, strictly enforcing closed enum, cycle validation,
 * path containment and symlink escape defenses.
 */
export function resolveSafeArtifactPath(
  repoDir: string,
  runId: string,
  kind: string,
  cycle?: number
): string {
  const resolvedRepo = canonicalizeRepoDir(repoDir);
  const runDir = resolveSafeRunDir(resolvedRepo, runId);
  const filename = getArtifactFilename(kind, cycle);
  const targetPath = resolve(runDir, filename);

  // Containment check
  const rel = relative(runDir, targetPath);
  if (rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("../") || isAbsolute(rel) || rel.includes(sep)) {
    throw new PathTraversalError(`Target path '${targetPath}' escapes run directory '${runDir}'`);
  }

  if (!targetPath.startsWith(runDir + sep)) {
    throw new PathTraversalError(`Target path '${targetPath}' is outside run directory '${runDir}'`);
  }

  assertNoSymlinkAncestors(resolvedRepo, targetPath);

  return targetPath;
}
