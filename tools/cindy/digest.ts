import { createHash } from "node:crypto";
import fs, { readFileSync, existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname, normalize } from "node:path";
import {
  getGitHead,
  getGitBranch,
  getGitUpstream,
  getGitStatus,
  getGitDiffHead,
  getGitUntrackedFiles,
  readCommittedFileAtHead,
  readCommittedFileAtCommit,
  getTrackedFilesAtCommit,
  evaluateGitAuthority,
  validateStrictCommitSha,
} from "./git.ts";
import { canonicalizeRepoDir, validateTaskId } from "./path-safety.ts";
import { loadArtifactSchema, validateDraft2020 } from "./schema-validator.ts";
import {
  CINDY_EXECUTION_SNAPSHOT_V1,
  CINDY_EXECUTION_INPUTS_V1,
  SymlinkEscapeError,
  UnsupportedFileTypeSnapshotError,
  FilesystemSnapshotError,
  ExecutionInputsValidationError,
  TransitionRejectedError,
} from "./types.ts";
import type {
  SnapshotEntry,
  SnapshotRegularEntry,
  SnapshotSymlinkEntry,
  SnapshotDeletedEntry,
  ExecutionSnapshotManifest,
  ExecutionSnapshotResult,
  FileIdentityRecord,
  IgnoredInputDeclarationMetadata,
  ExecutionInputsDeclaration,
} from "./types.ts";

export {
  CINDY_EXECUTION_SNAPSHOT_V1,
  CINDY_EXECUTION_INPUTS_V1,
  SymlinkEscapeError,
  UnsupportedFileTypeSnapshotError,
  FilesystemSnapshotError,
  ExecutionInputsValidationError,
};
export type {
  SnapshotEntry,
  SnapshotRegularEntry,
  SnapshotSymlinkEntry,
  SnapshotDeletedEntry,
  ExecutionSnapshotManifest,
  ExecutionSnapshotResult,
  IgnoredInputDeclarationMetadata,
  ExecutionInputsDeclaration,
};

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function computeFileHash(filePath: string): string {
  if (!existsSync(filePath)) {
    return "<DELETED>";
  }
  try {
    const buf = fs.readFileSync(filePath);
    return sha256(buf);
  } catch {
    return "<UNREADABLE>";
  }
}

/**
 * Checks whether a relative path falls into Cindy's strictly excluded runtime/git namespaces.
 */
export function isExcludedSnapshotPath(relPath: string): boolean {
  return (
    relPath === ".git" ||
    relPath.startsWith(".git/") ||
    relPath === ".agent/runtime" ||
    relPath.startsWith(".agent/runtime/") ||
    relPath === ".agent/.cindy-init-staging" ||
    relPath.startsWith(".agent/.cindy-init-staging/")
  );
}

function isInsideRepo(canonicalRepoRoot: string, targetPath: string): boolean {
  const rel = relative(canonicalRepoRoot, targetPath);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) {
    return false;
  }
  return true;
}

/**
 * Strictly validates that an execution input path is in canonical POSIX form (Architecture Decision M-R4-01 Layer 1).
 * Rejects non-string, empty strings, null bytes, absolute paths, and any path component that is '.', '..', or ''.
 * Rejects paths entering reserved namespaces (.git, .agent/runtime, .agent/.cindy-init-staging).
 * Backslash '\' is treated strictly as an ordinary POSIX character, NOT a path separator.
 */
export function validateCanonicalInputPath(relPath: string): void {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new FilesystemSnapshotError("Path must be a non-empty string");
  }
  if (relPath.includes("\0")) {
    throw new FilesystemSnapshotError("Path contains null bytes");
  }
  if (isAbsolute(relPath) || relPath.startsWith("/")) {
    throw new FilesystemSnapshotError(`Absolute path rejected: '${relPath}'`);
  }

  // Canonical POSIX form: components separated by '/' must not be '.', '..', or empty.
  const segments = relPath.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      throw new SymlinkEscapeError(
        `Path '${relPath}' is not in canonical POSIX form (contains component '${seg}') and escapes repository root`
      );
    }
    if (seg === "" || seg === ".") {
      throw new FilesystemSnapshotError(
        `Path '${relPath}' is not in canonical POSIX form (contains component '${seg}')`
      );
    }
  }

  // Raw reserved namespace guard
  if (isExcludedSnapshotPath(relPath)) {
    throw new SymlinkEscapeError(
      `Excluded path cannot enter execution snapshot: '${relPath}'`
    );
  }
}

interface WalkSegment {
  name: string;
  activeSymlinks: string[];
}

/**
 * Validates that an entire path and its ancestor/target resolution chain remain strictly
 * within the canonical repository root without escaping via ancestor symlinks or nested symlinks.
 * Guarantees NO outside component is ever inspected with lstat, readlink, or realpath (Architecture Decision CO).
 * Enforces immediate fail-closed guard against reserved namespaces before ANY filesystem syscall (MEDIUM-03).
 * Uses active expansion chain to avoid false positive loop detection on legitimate repeated traversals (HIGH-02).
 * Throws SymlinkEscapeError, UnsupportedFileTypeSnapshotError, or FilesystemSnapshotError fail closed.
 */
function walkSafeComponentChain(
  canonicalRepoRoot: string,
  rawPath: string,
  depth: number = 0
): { finalPath: string; exists: boolean } {
  if (depth > 40) {
    throw new SymlinkEscapeError("Symlink loop or excessive nesting depth detected");
  }

  if (rawPath.includes("\0")) {
    throw new FilesystemSnapshotError("Path contains null bytes");
  }

  let rawSegs: string[];
  if (isAbsolute(rawPath)) {
    if (rawPath === canonicalRepoRoot) {
      rawSegs = [];
    } else if (rawPath.startsWith(canonicalRepoRoot + "/")) {
      rawSegs = rawPath.slice(canonicalRepoRoot.length + 1).split("/");
    } else {
      throw new SymlinkEscapeError(`Absolute path outside repository root: '${rawPath}'`);
    }
  } else {
    rawSegs = rawPath.split("/");
  }

  const segments: WalkSegment[] = rawSegs.map((name) => ({ name, activeSymlinks: [] }));

  let currentDir = canonicalRepoRoot;
  let linkHops = depth;

  while (segments.length > 0) {
    const { name: seg, activeSymlinks } = segments.shift()!;
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      if (currentDir === canonicalRepoRoot) {
        throw new SymlinkEscapeError(`Path escapes repository root via '..': '${rawPath}'`);
      }
      currentDir = dirname(currentDir);
      continue;
    }

    const currentPath = resolve(currentDir, seg);
    if (currentPath !== canonicalRepoRoot && !currentPath.startsWith(canonicalRepoRoot + "/")) {
      throw new SymlinkEscapeError(`Component escapes repository root: '${currentPath}'`);
    }

    // Architecture Decision CZ / MEDIUM-03: Reserved namespace component guard.
    // Before ANY filesystem call (lstat, readlink, readFile), verify whether currentPath
    // enters any reserved namespace relative to canonicalRepoRoot. Fail closed immediately.
    const relCurrent = relative(canonicalRepoRoot, currentPath);
    if (isExcludedSnapshotPath(relCurrent)) {
      throw new SymlinkEscapeError(`Path component enters reserved namespace: '${relCurrent}'`);
    }

    let stat;
    try {
      stat = fs.lstatSync(currentPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        if (currentDir !== canonicalRepoRoot && !currentDir.startsWith(canonicalRepoRoot + "/")) {
          throw new SymlinkEscapeError(`Path ancestor escapes repository root: '${rawPath}'`);
        }
        if (segments.length === 0) {
          return { finalPath: currentPath, exists: false };
        }
        // There are remaining segments after an ENOENT.
        // In POSIX semantics, navigating through or popping out of a non-existent path is impossible.
        // If any remaining segment is '..' or attempts to escape, fail closed!
        for (const rem of segments) {
          if (rem.name === ".." || rem.name === "." || rem.name === "") {
            throw new SymlinkEscapeError(
              `Path traverses '${rem.name}' through non-existent component '${seg}': '${rawPath}'`
            );
          }
        }
        // Verify hypothetical path doesn't enter reserved namespaces
        let checkPath = currentPath;
        for (const rem of segments) {
          checkPath = resolve(checkPath, rem.name);
          const relCheck = relative(canonicalRepoRoot, checkPath);
          if (isExcludedSnapshotPath(relCheck)) {
            throw new SymlinkEscapeError(
              `Path component enters reserved namespace: '${relCheck}'`
            );
          }
        }
        return { finalPath: checkPath, exists: false };
      }
      throw new FilesystemSnapshotError(
        `Failed to lstat '${currentPath}': ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (stat.isSymbolicLink()) {
      // HIGH-02: Check active expansion chain instead of global visited set.
      if (activeSymlinks.includes(currentPath)) {
        throw new SymlinkEscapeError(`Symlink loop detected: '${currentPath}'`);
      }

      linkHops++;
      if (linkHops > 40) {
        throw new SymlinkEscapeError("Symlink loop or excessive nesting depth detected");
      }

      let rawTarget: string;
      try {
        rawTarget = fs.readlinkSync(currentPath);
      } catch (err: unknown) {
        throw new FilesystemSnapshotError(
          `Failed to readlink '${currentPath}': ${err instanceof Error ? err.message : String(err)}`
        );
      }

      if (rawTarget.includes("\0")) {
        throw new FilesystemSnapshotError("Symlink target contains null bytes");
      }

      if (rawTarget.length === 0) {
        throw new FilesystemSnapshotError("Empty symlink target");
      }

      const nextActive = [...activeSymlinks, currentPath];

      // Architecture Decision CY:
      // Symlink target MUST be walked as raw POSIX components.
      // - For ABSOLUTE targets: target must start with canonicalRepoRoot. If outside repo,
      //   IMMEDIATE SymlinkEscapeError without touching outside filesystem.
      // - For RELATIVE targets: target is resolved component-by-component starting from currentDir.
      //   Never path.resolve() beforehand — this avoids collapsing '..' in targets like 'hop/../safe'.
      if (isAbsolute(rawTarget)) {
        if (rawTarget !== canonicalRepoRoot && !rawTarget.startsWith(canonicalRepoRoot + "/")) {
          throw new SymlinkEscapeError(
            `Symlink target escapes repository root: '${currentPath}' -> '${rawTarget}'`
          );
        }
        currentDir = canonicalRepoRoot;
        const targetSegs = rawTarget === canonicalRepoRoot
          ? []
          : rawTarget.slice(canonicalRepoRoot.length + 1).split("/");
        const targetItems: WalkSegment[] = targetSegs.map((name) => ({ name, activeSymlinks: nextActive }));
        segments.unshift(...targetItems);
      } else {
        const targetSegs = rawTarget.split("/");
        const targetItems: WalkSegment[] = targetSegs.map((name) => ({ name, activeSymlinks: nextActive }));
        segments.unshift(...targetItems);
      }
    } else if (stat.isDirectory()) {
      currentDir = currentPath;
    } else if (stat.isFile()) {
      if (segments.length > 0) {
        throw new FilesystemSnapshotError(
          `Intermediate segment '${seg}' is a regular file, cannot be an ancestor directory`
        );
      }
      return { finalPath: currentPath, exists: true };
    } else {
      throw new UnsupportedFileTypeSnapshotError(
        `Unsupported special file type at '${currentPath}'`
      );
    }
  }

  return { finalPath: currentDir, exists: true };
}

/**
 * Validates that an entire path and its ancestor/target resolution chain remain strictly
 * within the canonical repository root without escaping via ancestor symlinks or nested symlinks.
 * Also checks that the RESOLVED final path does not enter reserved namespaces (Architecture Decision CZ).
 * Throws SymlinkEscapeError or FilesystemSnapshotError fail closed.
 */
export function assertSnapshotPathContained(
  repoRoot: string,
  rawRepoRelativePath: string
): { finalPath: string; exists: boolean } {
  const canonicalRepoRoot = canonicalizeRepoDir(repoRoot);
  validateCanonicalInputPath(rawRepoRelativePath);

  const result = walkSafeComponentChain(canonicalRepoRoot, rawRepoRelativePath);

  // Architecture Decision CZ: Resolved reserved namespace guard.
  // After symlink resolution, the final path must also not enter reserved namespaces.
  // A symlink alias such as `runtime-alias -> .agent/runtime` would pass the raw declaration
  // check but the resolved path lands inside .agent/runtime — which is reserved.
  if (result.exists && result.finalPath) {
    const resolvedRel = relative(canonicalRepoRoot, result.finalPath);
    if (isExcludedSnapshotPath(resolvedRel)) {
      throw new SymlinkEscapeError(
        `Symlink resolves into reserved namespace: '${rawRepoRelativePath}' -> '${resolvedRel}'`
      );
    }
  }
  return result;
}

/**
 * Returns the validated resolved terminal path on disk for a repository relative path.
 * Throws if the path escapes repository root, enters reserved namespaces, or does not exist.
 */
export function resolveSnapshotTerminalPath(
  repoRoot: string,
  rawRepoRelativePath: string
): string {
  const canonicalRepoRoot = canonicalizeRepoDir(repoRoot);
  const result = assertSnapshotPathContained(canonicalRepoRoot, rawRepoRelativePath);
  if (!result.exists) {
    throw new FilesystemSnapshotError(`File not found: '${rawRepoRelativePath}'`);
  }
  return result.finalPath;
}

/**
 * Validates and inspects a single execution snapshot entry on disk.
 * Uses lstat to identify symlinks vs regular files.
 * Enforces raw POSIX path safety, static symlink escape prevention, and fail-closed
 * handling of unsupported special files (FIFO, socket, block/char device, directory).
 */
export function inspectSnapshotEntry(
  rawRepoDir: string,
  relPath: string,
  options: { allowMissing?: boolean } = {}
): SnapshotEntry {
  const canonicalRepoDir = canonicalizeRepoDir(rawRepoDir);

  // Layer 1: Canonical POSIX input path validation (M-R4-01)
  validateCanonicalInputPath(relPath);

  // Layer 2 & 4: STATIC SYMLINK CONTAINMENT & reserved namespace early guard
  const containment = assertSnapshotPathContained(canonicalRepoDir, relPath);

  // Raw POSIX semantics: resolve against canonicalRepoDir, guaranteed canonical and non-escaping
  const fullPath = resolve(canonicalRepoDir, relPath);
  const rel = relative(canonicalRepoDir, fullPath);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) {
    throw new FilesystemSnapshotError(`Path escapes repository root: '${relPath}'`);
  }

  let stat;
  try {
    stat = fs.lstatSync(fullPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      if (options.allowMissing) {
        return { path: relPath, entryType: "deleted" };
      }
      throw new FilesystemSnapshotError(`File not found: '${relPath}'`);
    }
    throw new FilesystemSnapshotError(
      `Failed to lstat '${relPath}': ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (stat.isSymbolicLink()) {
    let target: string;
    try {
      target = fs.readlinkSync(fullPath);
    } catch (err: unknown) {
      throw new FilesystemSnapshotError(
        `Failed to readlink '${relPath}': ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return {
      path: relPath,
      entryType: "symlink",
      target,
    };
  }

  if (stat.isFile()) {
    const executable = (stat.mode & 0o111) !== 0;
    // Architecture Decision M-R5-03: Unify validated resolved terminal path,
    // containment verification path, and actual file read path.
    // Avoid non-native fs.realpathSync lexical mismatch on nested ancestor symlinks.
    const terminalPath = containment.finalPath;
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(terminalPath) : fs.realpathSync(terminalPath);
      if (!isInsideRepo(canonicalRepoDir, real)) {
        throw new SymlinkEscapeError(`File resolves outside repository root: '${relPath}' -> '${real}'`);
      }
    } catch (err: unknown) {
      if (err instanceof SymlinkEscapeError) throw err;
      throw new FilesystemSnapshotError(
        `Failed to resolve realpath for '${relPath}': ${err instanceof Error ? err.message : String(err)}`
      );
    }

    let contentBuf: Buffer;
    try {
      contentBuf = fs.readFileSync(terminalPath);
    } catch (err: unknown) {
      throw new FilesystemSnapshotError(
        `Failed to read file '${relPath}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const contentSha256 = sha256(contentBuf);
    return {
      path: relPath,
      entryType: "regular",
      contentSha256,
      executable,
    };
  }

  if (stat.isDirectory()) {
    throw new UnsupportedFileTypeSnapshotError(
      `Directory path '${relPath}' cannot be hashed as a single file entry without explicit expansion`
    );
  }

  if (
    stat.isFIFO() ||
    stat.isSocket() ||
    stat.isBlockDevice() ||
    stat.isCharacterDevice()
  ) {
    throw new UnsupportedFileTypeSnapshotError(
      `Unsupported special file type for execution input '${relPath}'`
    );
  }

  throw new UnsupportedFileTypeSnapshotError(
    `Unsupported file type for execution input '${relPath}'`
  );
}

/**
 * Deterministically serializes an ExecutionSnapshotManifest into collision-safe canonical JSON.
 * Sorts entries by raw UTF-8 byte comparison of repo-relative path (Buffer.compare).
 * Guarantees fixed key ordering and proper string escaping.
 */
export function canonicalizeSnapshotManifest(
  manifest: ExecutionSnapshotManifest
): string {
  const sortedEntries = [...manifest.entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path, "utf-8"), Buffer.from(b.path, "utf-8"))
  );

  const serializedEntries = sortedEntries.map((entry) => {
    if (entry.entryType === "regular") {
      return {
        contentSha256: entry.contentSha256,
        entryType: "regular",
        executable: entry.executable,
        path: entry.path,
      };
    } else if (entry.entryType === "symlink") {
      return {
        entryType: "symlink",
        path: entry.path,
        target: entry.target,
      };
    } else if (entry.entryType === "deleted") {
      return {
        entryType: "deleted",
        path: entry.path,
      };
    }
    throw new UnsupportedFileTypeSnapshotError(
      `Unsupported entryType: ${(entry as { entryType: string }).entryType}`
    );
  });

  const canonicalObj: Record<string, unknown> = {
    entries: serializedEntries,
    headCommit: manifest.headCommit,
  };

  if (manifest.ignoredInputDeclaration) {
    canonicalObj.ignoredInputDeclaration = {
      authorityCommit: manifest.ignoredInputDeclaration.authorityCommit,
      contentSha256: manifest.ignoredInputDeclaration.contentSha256,
      path: manifest.ignoredInputDeclaration.path,
      source: manifest.ignoredInputDeclaration.source,
      version: manifest.ignoredInputDeclaration.version,
    };
  }

  canonicalObj.version = manifest.version;

  return JSON.stringify(canonicalObj);
}

/**
 * Validates a single ignored path entry declared in execution-inputs.json.
 * Enforces raw POSIX semantics, path safety, and prevents reserved paths.
 */
export function validateIgnoredPathEntry(
  relPath: string,
  canonicalRepoDir: string,
  taskId: string
): void {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new ExecutionInputsValidationError("Ignored path entry must be a non-empty string");
  }
  if (relPath.includes("\0")) {
    throw new ExecutionInputsValidationError("Ignored path contains null byte");
  }
  // Raw POSIX semantics: do not trim, do not auto-convert backslash to slash
  if (isAbsolute(relPath) || relPath.startsWith("/")) {
    throw new ExecutionInputsValidationError(`Ignored path cannot be absolute: '${relPath}'`);
  }

  const checkReserved = (targetPath: string) => {
    // Architecture Decision DA: POSIX backslash is data, NOT a path separator.
    // Do NOT convert '\' to '/' before checking reserved namespaces.
    // A filename like '.git\config' is a single valid POSIX file at repo root,
    // not '.git/config'. Converting backslash would incorrectly reject it.
    const declarationRel = `.agent/tasks/${taskId}/execution-inputs.json`;
    const taskJsonRel = `.agent/tasks/${taskId}/task.json`;
    if (
      targetPath === ".git" ||
      targetPath.startsWith(".git/") ||
      targetPath === ".agent/runtime" ||
      targetPath.startsWith(".agent/runtime/") ||
      targetPath === ".agent/.cindy-init-staging" ||
      targetPath.startsWith(".agent/.cindy-init-staging/") ||
      targetPath === declarationRel ||
      targetPath === taskJsonRel
    ) {
      throw new ExecutionInputsValidationError(
        `Reserved or authority path cannot be declared as an ignored input: '${targetPath}'`
      );
    }
  };

  // Pre-normalization check on raw relPath
  checkReserved(relPath);

  // Contract path syntax: strictly reject ambiguous alias segments
  const segments = relPath.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new ExecutionInputsValidationError(
        `Ignored path '${relPath}' contains invalid or non-canonical path segment '${seg}' and escapes repository root`
      );
    }
  }

  // MVP prohibitions: glob, regex, negative patterns, env expansion, ~, ${HOME}
  if (
    relPath.includes("*") ||
    relPath.includes("?") ||
    relPath.includes("[") ||
    relPath.includes("]") ||
    relPath.startsWith("!") ||
    relPath.startsWith("~") ||
    relPath.includes("${") ||
    relPath.includes("$")
  ) {
    throw new ExecutionInputsValidationError(
      `Ignored path '${relPath}' contains unsupported glob, regex, tilde, or environment syntax`
    );
  }

  // Traversal check
  const fullPath = resolve(canonicalRepoDir, relPath);
  const rel = relative(canonicalRepoDir, fullPath);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) {
    throw new ExecutionInputsValidationError(`Ignored path escapes repository root: '${relPath}'`);
  }

  // Post-normalization checks
  checkReserved(rel);
  const normalizedLexical = normalize(relPath);
  checkReserved(normalizedLexical);
}

/**
 * Loads and validates the task-scoped execution-inputs.json strictly from committed Git HEAD.
 * Returns authoritative metadata and ignored paths list.
 * If absent from committed HEAD, returns empty authoritative set (ABSENT_EMPTY).
 */
export function loadCommittedExecutionInputs(
  canonicalRepoDir: string,
  taskId: string,
  headCommit: string
): { declarationMeta: IgnoredInputDeclarationMetadata; ignoredPaths: string[] } {
  validateTaskId(taskId);
  validateStrictCommitSha(headCommit);
  const declarationRel = `.agent/tasks/${taskId}/execution-inputs.json`;
  const raw = readCommittedFileAtCommit(canonicalRepoDir, headCommit, declarationRel);

  if (raw === null) {
    return {
      declarationMeta: {
        authorityCommit: headCommit,
        contentSha256: null,
        path: declarationRel,
        source: "ABSENT_EMPTY",
        version: CINDY_EXECUTION_INPUTS_V1,
      },
      ignoredPaths: [],
    };
  }

  const contentSha256 = sha256(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    throw new ExecutionInputsValidationError(
      `Malformed committed execution-inputs JSON at ${headCommit}:${declarationRel}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ExecutionInputsValidationError(
      `Committed execution-inputs at ${headCommit}:${declarationRel} must be a JSON object`
    );
  }

  // Validate against schemas/cindy-execution-inputs.schema.json
  const schema = loadArtifactSchema(canonicalRepoDir, "cindy-execution-inputs.schema.json");
  const errors = validateDraft2020(parsed, schema);
  if (errors.length > 0) {
    throw new ExecutionInputsValidationError(
      `Schema validation failed for ${headCommit}:${declarationRel}: ${errors.join("; ")}`
    );
  }

  const record = parsed as Record<string, unknown>;
  if (record.version !== CINDY_EXECUTION_INPUTS_V1) {
    throw new ExecutionInputsValidationError(
      `Committed execution-inputs version mismatch: got '${String(record.version)}', expected '${CINDY_EXECUTION_INPUTS_V1}'`
    );
  }

  if (record.taskId !== taskId) {
    throw new ExecutionInputsValidationError(
      `Committed execution-inputs taskId mismatch: file declared '${String(record.taskId)}', expected '${taskId}'`
    );
  }

  const paths = record.ignoredPaths as string[];
  const seen = new Set<string>();
  for (const p of paths) {
    if (seen.has(p)) {
      throw new ExecutionInputsValidationError(
        `Duplicate ignored path entry in ${headCommit}:${declarationRel}: '${p}'`
      );
    }
    seen.add(p);
    validateIgnoredPathEntry(p, canonicalRepoDir, taskId);
  }

  return {
    declarationMeta: {
      authorityCommit: headCommit,
      contentSha256,
      path: declarationRel,
      source: "COMMITTED_TASK_SCOPED_FILE",
      version: CINDY_EXECUTION_INPUTS_V1,
    },
    ignoredPaths: paths,
  };
}

function computeExecutionSnapshotInternal(
  canonicalRepo: string,
  headCommit: string,
  options: {
    declaredIgnoredInputs?: string[] | undefined;
    declarationMeta?: IgnoredInputDeclarationMetadata | undefined;
  } = {}
): ExecutionSnapshotResult {
  const status = getGitStatus(canonicalRepo);
  const entriesMap = new Map<string, SnapshotEntry>();

  // A. Complete tracked repository entries from immutable headCommit
  const trackedPaths = getTrackedFilesAtCommit(headCommit, canonicalRepo);
  for (const p of trackedPaths) {
    if (isExcludedSnapshotPath(p)) continue;
    const inspected = inspectSnapshotEntry(canonicalRepo, p, { allowMissing: true });
    entriesMap.set(p, inspected);
  }

  // B. Tracked working tree additions, renames, deletions from git status (Decision CN)
  // Working filesystem identity overrides git status metadata:
  // Only when lstat truly throws ENOENT does entryType = 'deleted'.
  for (const entry of status.entries) {
    if (isExcludedSnapshotPath(entry.path)) continue;

    const inspected = inspectSnapshotEntry(canonicalRepo, entry.path, { allowMissing: true });
    entriesMap.set(entry.path, inspected);

    if (entry.origPath && !entriesMap.has(entry.origPath)) {
      if (!isExcludedSnapshotPath(entry.origPath)) {
        const inspectedOrig = inspectSnapshotEntry(canonicalRepo, entry.origPath, { allowMissing: true });
        entriesMap.set(entry.origPath, inspectedOrig);
      }
    }
  }

  // C. Explicitly declared ignored execution inputs
  if (options.declaredIgnoredInputs && options.declaredIgnoredInputs.length > 0) {
    for (const ignoredPath of options.declaredIgnoredInputs) {
      if (isExcludedSnapshotPath(ignoredPath)) {
        throw new FilesystemSnapshotError(
          `Excluded path cannot enter execution snapshot: '${ignoredPath}'`
        );
      }
      const inspected = inspectSnapshotEntry(canonicalRepo, ignoredPath, {
        allowMissing: false,
      });
      entriesMap.set(ignoredPath, inspected);
    }
  }

  const entries = Array.from(entriesMap.values()).sort((a, b) =>
    Buffer.compare(Buffer.from(a.path, "utf-8"), Buffer.from(b.path, "utf-8"))
  );

  const manifest: ExecutionSnapshotManifest = {
    entries,
    headCommit,
    version: CINDY_EXECUTION_SNAPSHOT_V1,
  };

  if (options.declarationMeta) {
    manifest.ignoredInputDeclaration = options.declarationMeta;
  }

  const canonicalString = canonicalizeSnapshotManifest(manifest);
  const digest = sha256(canonicalString);

  const fileIdentities = collectFileIdentities(canonicalRepo, manifest);

  return {
    digest,
    manifest,
    version: CINDY_EXECUTION_SNAPSHOT_V1,
    fileIdentities,
  };
}

export interface ComputeExecutionSnapshotOptions {
  declaredIgnoredInputs?: string[] | undefined;
}

/**
 * Computes deterministic Execution Snapshot V1 (Decision BP, BQ, BR, BS, BT, BU, BX).
 * Low-level pure helper or test helper.
 */
export async function computeExecutionSnapshot(
  repoDir: string = process.cwd(),
  options: ComputeExecutionSnapshotOptions = {}
): Promise<ExecutionSnapshotResult> {
  const canonicalRepo = canonicalizeRepoDir(repoDir);
  const headCommit = getGitHead(canonicalRepo);
  return computeExecutionSnapshotInternal(canonicalRepo, headCommit, {
    declaredIgnoredInputs: options.declaredIgnoredInputs,
  });
}

/**
 * Trusted production entrypoint for computing authoritative execution snapshot.
 * Reads authoritative ignored inputs strictly from committed HEAD (.agent/tasks/<taskId>/execution-inputs.json).
 * Working tree copy is NEVER used as authority.
 */
export async function computeAuthoritativeExecutionSnapshot(
  repoDir: string = process.cwd(),
  taskId: string,
  options: {
    expectedHeadCommit?: string;
    prevalidatedAuthority?: ReturnType<typeof evaluateGitAuthority>;
  } = {}
): Promise<ExecutionSnapshotResult> {
  const canonicalRepo = canonicalizeRepoDir(repoDir);
  validateTaskId(taskId);

  // 1. Initial Git facts and authority head
  let authorityHead: string;
  let branchBefore: string;
  let upstreamBefore: ReturnType<typeof getGitUpstream>;

  if (options.prevalidatedAuthority) {
    if (!options.prevalidatedAuthority.ok) {
      throw new FilesystemSnapshotError(
        `Git authority check failed before snapshot computation: ${options.prevalidatedAuthority.stopExplanation}`
      );
    }
    authorityHead = options.prevalidatedAuthority.actualHead;
    branchBefore = options.prevalidatedAuthority.actualBranch;
    upstreamBefore = options.prevalidatedAuthority.actualUpstream;
  } else {
    branchBefore = getGitBranch(canonicalRepo);
    authorityHead = getGitHead(canonicalRepo);
    upstreamBefore = getGitUpstream(canonicalRepo);
  }

  validateStrictCommitSha(authorityHead);

  if (options.expectedHeadCommit && options.expectedHeadCommit !== authorityHead) {
    throw new FilesystemSnapshotError(
      `HEAD commit drift during execution snapshot computation: expected '${options.expectedHeadCommit}', got '${authorityHead}'`
    );
  }

  // 2. Read declaration strictly from immutable commit authorityHead
  const { declarationMeta, ignoredPaths } = loadCommittedExecutionInputs(
    canonicalRepo,
    taskId,
    authorityHead
  );

  // 3. Compute execution snapshot anchored to immutable authorityHead and working tree
  const snapshotResult = computeExecutionSnapshotInternal(canonicalRepo, authorityHead, {
    declaredIgnoredInputs: ignoredPaths,
    declarationMeta,
  });

  // 4. Final authority fence: re-evaluate fresh Git facts
  const headAfter = getGitHead(canonicalRepo);
  const branchAfter = getGitBranch(canonicalRepo);
  const upstreamAfter = getGitUpstream(canonicalRepo);

  if (headAfter !== authorityHead) {
    throw new FilesystemSnapshotError(
      `HEAD commit drifted during execution snapshot computation: was '${authorityHead}', now '${headAfter}'`
    );
  }
  if (branchAfter !== branchBefore) {
    throw new FilesystemSnapshotError(
      `Git branch changed during execution snapshot computation: was '${branchBefore}', now '${branchAfter}'`
    );
  }
  if (
    upstreamAfter?.ref !== upstreamBefore?.ref ||
    upstreamAfter?.commit !== upstreamBefore?.commit
  ) {
    throw new FilesystemSnapshotError(
      `Git upstream drifted during execution snapshot computation`
    );
  }
  if (options.expectedHeadCommit && headAfter !== options.expectedHeadCommit) {
    throw new FilesystemSnapshotError(
      `HEAD commit drift after execution snapshot computation: expected '${options.expectedHeadCommit}', got '${headAfter}'`
    );
  }

  return snapshotResult;
}

/**
 * Computes deterministic working tree digest synchronously backed by CINDY_EXECUTION_SNAPSHOT_V1.
 * Guarantees identical input set, identical canonical ordering, identical symlink/file treatment,
 * and identical hash result as async computeTreeDigest.
 */
export function computeTreeDigestSync(repoDir: string = process.cwd()): string {
  const canonicalRepo = canonicalizeRepoDir(repoDir);
  const headCommit = getGitHead(canonicalRepo);
  const snapshot = computeExecutionSnapshotInternal(canonicalRepo, headCommit);
  return snapshot.digest;
}

/**
 * Collects filesystem identity metadata for all entries in a snapshot manifest.
 * Records {ino, dev, size, mtimeMs, ctimeMs, mode, target} from lstatSync for each entry.
 * Used to build a post-read identity fence (Architecture Decision M-R6-01/M-R6-02).
 * Fails closed on any lstat error.
 */
export function collectFileIdentities(
  canonicalRepoDir: string,
  manifest: ExecutionSnapshotManifest
): Map<string, FileIdentityRecord> {
  const identities = new Map<string, FileIdentityRecord>();
  for (const entry of manifest.entries) {
    const fullPath = resolve(canonicalRepoDir, entry.path);
    if (entry.entryType === "regular") {
      let stat;
      try {
        stat = fs.lstatSync(fullPath);
      } catch (err: unknown) {
        throw new FilesystemSnapshotError(
          `File identity fence: failed to lstat '${entry.path}': ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (!stat.isFile()) {
        throw new FilesystemSnapshotError(
          `File identity fence: '${entry.path}' is no longer a regular file (type changed during scan)`
        );
      }
      identities.set(entry.path, {
        path: entry.path,
        entryType: "regular",
        ino: stat.ino,
        dev: stat.dev,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        mode: stat.mode,
      });
    } else if (entry.entryType === "symlink") {
      let target: string;
      try {
        target = fs.readlinkSync(fullPath);
      } catch (err: unknown) {
        throw new FilesystemSnapshotError(
          `File identity fence: failed to readlink '${entry.path}': ${err instanceof Error ? err.message : String(err)}`
        );
      }
      identities.set(entry.path, {
        path: entry.path,
        entryType: "symlink",
        target,
      });
    } else if (entry.entryType === "deleted") {
      identities.set(entry.path, {
        path: entry.path,
        entryType: "deleted",
      });
    }
  }
  return identities;
}

/**
 * Verifies that filesystem identity metadata for all previously-collected entries
 * has not changed since collection. Detects concurrent file modification, replacement, or deletion.
 * Architecture Decision M-R6-01/M-R6-02: Post-read identity fence.
 * Fails closed on any identity drift with TransitionRejectedError.
 */
export function verifyFileIdentityFence(
  canonicalRepoDir: string,
  identities: Map<string, FileIdentityRecord>,
  manifest: ExecutionSnapshotManifest
): void {
  for (const [relPath, before] of identities) {
    const fullPath = resolve(canonicalRepoDir, relPath);
    let stat;
    try {
      stat = fs.lstatSync(fullPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        if (before.entryType === "deleted") {
          continue;
        }
        throw new TransitionRejectedError(
          `STALE_TREE_BINDING: File identity fence verification failed: '${relPath}' disappeared after scan`
        );
      }
      throw new TransitionRejectedError(
        `STALE_TREE_BINDING: File identity fence verification failed: failed to lstat '${relPath}': ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (before.entryType === "deleted") {
      throw new TransitionRejectedError(
        `STALE_TREE_BINDING: File identity fence verification failed: deleted file '${relPath}' was recreated`
      );
    }

    if (before.entryType === "regular") {
      if (stat.isSymbolicLink()) {
        throw new TransitionRejectedError(
          `STALE_TREE_BINDING: File identity fence verification failed: regular file '${relPath}' was replaced with a symlink`
        );
      }
      if (!stat.isFile()) {
        throw new TransitionRejectedError(
          `STALE_TREE_BINDING: File identity fence verification failed: '${relPath}' is no longer a regular file`
        );
      }
      if (before.ino !== undefined && stat.ino !== before.ino) {
        throw new TransitionRejectedError(
          `STALE_TREE_BINDING: File identity fence verification failed: '${relPath}' inode changed (was ${before.ino}, now ${stat.ino}); file was replaced`
        );
      }
      if (before.dev !== undefined && stat.dev !== before.dev) {
        throw new TransitionRejectedError(
          `STALE_TREE_BINDING: File identity fence verification failed: '${relPath}' device changed (was ${before.dev}, now ${stat.dev})`
        );
      }
      if (before.size !== undefined && stat.size !== before.size) {
        throw new TransitionRejectedError(
          `STALE_TREE_BINDING: File identity fence verification failed: '${relPath}' size changed (was ${before.size}, now ${stat.size}); file was modified`
        );
      }
      if (before.mtimeMs !== undefined && stat.mtimeMs !== before.mtimeMs) {
        throw new TransitionRejectedError(
          `STALE_TREE_BINDING: File identity fence verification failed: '${relPath}' mtime changed (was ${before.mtimeMs}, now ${stat.mtimeMs}); file was modified`
        );
      }
      if (before.ctimeMs !== undefined && stat.ctimeMs !== before.ctimeMs) {
        throw new TransitionRejectedError(
          `STALE_TREE_BINDING: File identity fence verification failed: '${relPath}' ctime changed (was ${before.ctimeMs}, now ${stat.ctimeMs}); file was modified`
        );
      }
      if (before.mode !== undefined && stat.mode !== before.mode) {
        throw new TransitionRejectedError(
          `STALE_TREE_BINDING: File identity fence verification failed: '${relPath}' mode changed (was ${before.mode}, now ${stat.mode})`
        );
      }
    } else if (before.entryType === "symlink") {
      if (!stat.isSymbolicLink()) {
        throw new TransitionRejectedError(
          `STALE_TREE_BINDING: File identity fence verification failed: symlink '${relPath}' is no longer a symlink`
        );
      }
      let target: string;
      try {
        target = fs.readlinkSync(fullPath);
      } catch (err: unknown) {
        throw new TransitionRejectedError(
          `STALE_TREE_BINDING: File identity fence verification failed: failed to readlink '${relPath}': ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (before.target !== undefined && target !== before.target) {
        throw new TransitionRejectedError(
          `STALE_TREE_BINDING: File identity fence verification failed: symlink '${relPath}' retargeted (was '${before.target}', now '${target}')`
        );
      }
    }
  }
}

export function computeTreeSnapshotSync(repoDir: string = process.cwd()): ExecutionSnapshotResult {
  const canonicalRepo = canonicalizeRepoDir(repoDir);
  const headCommit = getGitHead(canonicalRepo);
  return computeExecutionSnapshotInternal(canonicalRepo, headCommit);
}

/**
 * Computes deterministic working tree digest backed by CINDY_EXECUTION_SNAPSHOT_V1.
 */
export async function computeTreeDigest(repoDir: string = process.cwd()): Promise<string> {
  return computeTreeDigestSync(repoDir);
}

/**
 * Computes deterministic diff digest (git diff HEAD + untracked file contents).
 */
export async function computeDiffDigest(repoDir: string = process.cwd()): Promise<string> {
  const diffHead = getGitDiffHead(repoDir);
  const untracked = getGitUntrackedFiles(repoDir);

  const untrackedLines = untracked.map((filePath) => {
    const fullPath = resolve(repoDir, filePath);
    const fileHash = computeFileHash(fullPath);
    return `${filePath}:${fileHash}`;
  });

  const canonical = `${diffHead}\n--- UNTRACKED ---\n${untrackedLines.join("\n")}`;
  return sha256(canonical);
}
