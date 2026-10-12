import { resolve, relative, isAbsolute, sep, join } from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import {
  CindyState,
  PathTraversalError,
  TransitionRejectedError,
  type DirtyTreeOwnershipResult,
} from "./types.ts";
import { canonicalizeRepoDir } from "./path-safety.ts";

/**
 * Validates a single scope entry path against directory traversal, absolute paths,
 * null bytes, repository escape, and escaping symlinks (R2-06, Decision R).
 * Scope entries MUST use forward slash '/' and MUST NOT contain backslashes '\'.
 */
export function validateScopeEntry(rawEntry: string, repoDir: string = process.cwd()): string {
  if (typeof rawEntry !== "string" || rawEntry.length === 0) {
    throw new PathTraversalError("Scope entry must be a non-empty string");
  }

  if (rawEntry.includes("\0")) {
    throw new PathTraversalError("Scope entry cannot contain null bytes");
  }

  if (rawEntry.includes("\\")) {
    throw new PathTraversalError(
      `INVALID_SCOPE_ENTRY: Scope entry '${rawEntry}' cannot contain backslash '\\'; must use forward slash '/'`
    );
  }

  if (
    isAbsolute(rawEntry) ||
    rawEntry.startsWith("/") ||
    /^[a-zA-Z]:\//.test(rawEntry)
  ) {
    throw new PathTraversalError(`Scope entry '${rawEntry}' cannot be absolute; must be repository-relative`);
  }

  const segments = rawEntry.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      throw new PathTraversalError(`Scope entry '${rawEntry}' contains parent traversal '..'`);
    }
    if (seg === ".") {
      throw new PathTraversalError(`Scope entry '${rawEntry}' contains invalid segment '.'`);
    }
  }

  const canonicalRepo = canonicalizeRepoDir(repoDir);
  const resolved = resolve(canonicalRepo, rawEntry);
  const rel = relative(canonicalRepo, resolved);
  if (rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("../") || isAbsolute(rel)) {
    throw new PathTraversalError(`Scope entry '${rawEntry}' escapes repository root`);
  }

  // Symlink scope validation:
  // If any existing component in the scope path is a symlink that resolves outside canonicalRepo
  let curr = canonicalRepo;
  const parts = rel.split(sep);
  for (const part of parts) {
    if (!part || part === ".") continue;
    curr = join(curr, part);
    if (existsSync(curr)) {
      try {
        const stat = lstatSync(curr);
        if (stat.isSymbolicLink()) {
          const real = realpathSync.native ? realpathSync.native(curr) : realpathSync(curr);
          const relReal = relative(canonicalRepo, real);
          if (relReal === ".." || relReal.startsWith(".." + sep) || relReal.startsWith("../") || isAbsolute(relReal)) {
            throw new PathTraversalError(
              `Scope entry '${rawEntry}' traverses symlink '${curr}' escaping repository root`
            );
          }
        }
      } catch (err: unknown) {
        if (err instanceof PathTraversalError) throw err;
      }
    }
  }

  const hasTrailingSlash = rawEntry.endsWith("/");
  return hasTrailingSlash ? `${rel}/` : rel;
}

export function validateAllowedScope(scope: string[], repoDir: string = process.cwd()): string[] {
  return scope.map((entry) => validateScopeEntry(entry, repoDir));
}

/**
 * Checks whether a repository-relative file path is authorized by a normalized scope entry.
 * Strictly respects path boundaries (e.g. tools/cindy does NOT authorize tools/cindy-malicious/a.ts).
 * In Git/POSIX repository semantics (Decision R), backslash '\' in a Git file path is a literal
 * filename character, NOT a directory separator.
 */
export function isFileInScope(file: string, scopeEntry: string): boolean {
  const normFile = file.startsWith("/") ? file.replace(/^\/+/, "") : file;
  const normScope = scopeEntry.startsWith("/") ? scopeEntry.replace(/^\/+/, "") : scopeEntry;

  if (normScope.endsWith("/")) {
    const dir = normScope.slice(0, -1);
    if (normFile === dir) return true;
    return normFile.startsWith(normScope);
  }

  // Scope entry has no trailing slash: could match exact file or directory contents
  if (normFile === normScope) return true;
  return normFile.startsWith(`${normScope}/`);
}

/**
 * Asserts that a caller-provided scope does not broaden the authoritative task scope.
 * Fails closed with TransitionRejectedError if any caller entry is not permitted by authoritative scope.
 */
export function assertScopeNotBroadened(
  callerScope: string[],
  authoritativeScope: string[],
  repoDir: string = process.cwd()
): void {
  const validatedAuth = authoritativeScope.map((s) => validateScopeEntry(s, repoDir));
  const validatedCaller = callerScope.map((s) => validateScopeEntry(s, repoDir));

  if (validatedAuth.length === 0 && validatedCaller.length > 0) {
    throw new TransitionRejectedError("Caller cannot broaden empty authoritative scope");
  }

  for (const callerEntry of validatedCaller) {
    const normCaller = callerEntry.startsWith("/") ? callerEntry.replace(/^\/+/, "") : callerEntry;
    const isCovered = validatedAuth.some((authEntry) => {
      const normAuth = authEntry.startsWith("/") ? authEntry.replace(/^\/+/, "") : authEntry;
      if (normAuth.endsWith("/")) {
        const authDir = normAuth.slice(0, -1);
        return (
          normCaller === authDir ||
          normCaller === normAuth ||
          normCaller.startsWith(normAuth)
        );
      }
      return (
        normCaller === normAuth ||
        normCaller.startsWith(`${normAuth}/`)
      );
    });

    if (!isCovered) {
      throw new TransitionRejectedError(
        `Caller scope entry '${callerEntry}' broadens authoritative task scope`
      );
    }
  }
}

/**
 * Checks whether dirty files in the working tree are fully explained by the allowed scope.
 * Empty allowedScope = [] means "no dirty files permitted" (fail closed if any dirty file exists).
 * Git-emitted file paths preserve backslashes as literal characters without conversion.
 */
export function checkDirtyTreeOwnership(
  allowedScope: string[],
  dirtyFiles: string[],
  repoDir?: string
): DirtyTreeOwnershipResult {
  const effectiveRepo = repoDir ?? process.cwd();
  const normalizedScopes = allowedScope.map((s) => validateScopeEntry(s, effectiveRepo));

  if (normalizedScopes.length === 0) {
    const ok = dirtyFiles.length === 0;
    return {
      ok,
      dirtyFiles,
      unexplainedFiles: ok ? [] : [...dirtyFiles],
      stopReason: ok ? null : CindyState.DIRTY_TREE_UNEXPLAINED,
    };
  }

  const unexplainedFiles: string[] = [];

  for (const rawFile of dirtyFiles) {
    const file = rawFile.startsWith("/") ? rawFile.replace(/^\/+/, "") : rawFile;
    const isAllowed = normalizedScopes.some((scope) => isFileInScope(file, scope));

    if (!isAllowed) {
      unexplainedFiles.push(rawFile);
    }
  }

  const ok = unexplainedFiles.length === 0;

  return {
    ok,
    dirtyFiles,
    unexplainedFiles,
    stopReason: ok ? null : CindyState.DIRTY_TREE_UNEXPLAINED,
  };
}
