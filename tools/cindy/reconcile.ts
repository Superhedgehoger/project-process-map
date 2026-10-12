import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  getGitBranch,
  getGitHead,
  getGitUpstream,
  getGitStatus,
  evaluateGitAuthority,
  readCommittedTaskPacket,
} from "./git.ts";
import {
  CindyState,
  CindyStopReason,
  AmbiguousActiveRunError,
  InvalidRunRecordError,
  RunGitSnapshotIncompleteError,
  ArtifactValidationError,
  type ReconcileResult,
  type LegacyTaskRecord,
  type CindyRun,
} from "./types.ts";
import { canonicalizeRepoDir, validateTaskId } from "./path-safety.ts";
import { RuntimeArtifactStore } from "./artifact-store.ts";

export interface ReconcileOptions {
  repoDir?: string | undefined;
  taskId?: string | undefined;
  expectedBaseCommit?: string | undefined;
  expectedBranch?: string | undefined;
  expectedUpstreamSha?: string | undefined;
}

/**
 * Reconcile current pointer against authoritative Git state, committed task/closure at HEAD,
 * and the run's recorded Git snapshot (R2-04, Decisions H & I).
 * Precedence:
 * 1. Git branch / HEAD / upstream (read directly from Git objects, not working tree)
 * 2. Committed Task / closure artifacts at HEAD
 * 3. Unique active run's recorded Git authority snapshot (.agent/runtime)
 * 4. .agent/current.json (rebuildable pointer/hint only)
 */
export async function reconcileCurrentState(options: ReconcileOptions = {}): Promise<ReconcileResult> {
  const repoDir = canonicalizeRepoDir(options.repoDir ?? process.cwd());
  const branch = getGitBranch(repoDir);
  const headCommit = getGitHead(repoDir);
  const upstream = getGitUpstream(repoDir);
  const store = new RuntimeArtifactStore({ repoDir });

  const currentPath = join(repoDir, ".agent", "current.json");
  let currentJson: Record<string, unknown> | null = null;
  let pointerHealth: "OK" | "MISSING" | "STALE" | "CORRUPT" | "MISMATCH" = "MISSING";

  if (existsSync(currentPath)) {
    try {
      const raw = await readFile(currentPath, "utf8");
      currentJson = JSON.parse(raw);
      if (!currentJson || typeof currentJson !== "object" || Array.isArray(currentJson)) {
        pointerHealth = "CORRUPT";
        currentJson = null;
      } else {
        pointerHealth = "OK";
      }
    } catch {
      pointerHealth = "CORRUPT";
      currentJson = null;
    }
  }

  let taskId: string | undefined = options.taskId;
  let runSnapshot: CindyRun | null = null;

  if (taskId) {
    // Explicit taskId requested by caller (Architecture Decision AC - Rule A: authority target=T)
    validateTaskId(taskId);
    try {
      runSnapshot = await store.resolveActiveRunForTask(taskId);
    } catch (err: unknown) {
      if (err instanceof AmbiguousActiveRunError) {
        return {
          reconciled: false,
          currentTaskId: taskId,
          taskAlreadyClosed: false,
          resolvedStatus: "AMBIGUOUS_RUN",
          branch,
          headCommit,
          upstream,
          stopReason: CindyState.GIT_SAFETY_STOP,
          detailedStopReason: CindyStopReason.AMBIGUOUS_ACTIVE_RUN,
          stopExplanation: err.message,
          pointerHealth,
        };
      }
      if (err instanceof InvalidRunRecordError) {
        return {
          reconciled: false,
          currentTaskId: taskId,
          taskAlreadyClosed: false,
          resolvedStatus: "INVALID_RUN_RECORD",
          branch,
          headCommit,
          upstream,
          stopReason: CindyState.CONTRACT_CONFLICT,
          detailedStopReason: CindyStopReason.INVALID_RUN_RECORD,
          stopExplanation: err.message,
          pointerHealth,
        };
      }
      if (err instanceof RunGitSnapshotIncompleteError) {
        return {
          reconciled: false,
          currentTaskId: taskId,
          taskAlreadyClosed: false,
          resolvedStatus: "INCOMPLETE_SNAPSHOT",
          branch,
          headCommit,
          upstream,
          stopReason: CindyState.GIT_SAFETY_STOP,
          detailedStopReason: CindyStopReason.RUN_GIT_SNAPSHOT_INCOMPLETE,
          stopExplanation: err.message,
          pointerHealth,
        };
      }
      throw err;
    }

    // Diagnostic-only check for current.json pointer consistency; pointer cannot veto explicit taskId
    if (currentJson) {
      const hintRunId = currentJson.runId as string | undefined;
      const hintTask = (currentJson.task ?? currentJson.taskId) as string | undefined;
      if (
        (hintRunId && runSnapshot && hintRunId !== runSnapshot.runId) ||
        (hintTask && hintTask !== taskId)
      ) {
        pointerHealth = "MISMATCH";
      }
    }
  } else {
    // No explicit taskId: scan authoritative active runs across runtime
    let allActiveRuns: CindyRun[];
    try {
      allActiveRuns = await store.resolveAllActiveRuns();
    } catch (scanErr: unknown) {
      if (scanErr instanceof InvalidRunRecordError) {
        return {
          reconciled: false,
          currentTaskId: null,
          taskAlreadyClosed: false,
          resolvedStatus: "INVALID_RUN_RECORD",
          branch,
          headCommit,
          upstream,
          stopReason: CindyState.CONTRACT_CONFLICT,
          detailedStopReason: CindyStopReason.INVALID_RUN_RECORD,
          stopExplanation: scanErr.message,
          pointerHealth,
        };
      }
      if (scanErr instanceof RunGitSnapshotIncompleteError) {
        return {
          reconciled: false,
          currentTaskId: null,
          taskAlreadyClosed: false,
          resolvedStatus: "INCOMPLETE_SNAPSHOT",
          branch,
          headCommit,
          upstream,
          stopReason: CindyState.GIT_SAFETY_STOP,
          detailedStopReason: CindyStopReason.RUN_GIT_SNAPSHOT_INCOMPLETE,
          stopExplanation: scanErr.message,
          pointerHealth,
        };
      }
      throw scanErr;
    }

    if (allActiveRuns.length === 1) {
      // Architecture Decision AC - Rule B: unique active run T -> authority target=T
      runSnapshot = allActiveRuns[0]!;
      taskId = runSnapshot.taskId;

      if (currentJson) {
        const hintRunId = currentJson.runId as string | undefined;
        const hintTask = (currentJson.task ?? currentJson.taskId) as string | undefined;
        if (
          (hintRunId && hintRunId !== runSnapshot.runId) ||
          (hintTask && hintTask !== taskId)
        ) {
          pointerHealth = "MISMATCH";
        }
      }
    } else if (allActiveRuns.length > 1) {
      // Architecture Decision AC - Rule D: >1 active -> AMBIGUOUS_ACTIVE_RUN; pointer cannot disambiguate
      return {
        reconciled: false,
        currentTaskId: null,
        taskAlreadyClosed: false,
        resolvedStatus: "AMBIGUOUS_ACTIVE_RUN",
        branch,
        headCommit,
        upstream,
        stopReason: CindyState.GIT_SAFETY_STOP,
        detailedStopReason: CindyStopReason.AMBIGUOUS_ACTIVE_RUN,
        stopExplanation: `AMBIGUOUS_ACTIVE_RUN: Multiple active runs found across repository (${allActiveRuns.map((r) => r.runId).join(", ")})`,
        pointerHealth,
      };
    } else {
      // Architecture Decision AC - Rule C: 0 active + no explicit taskId -> CURRENT_TASK_UNRESOLVED, even if pointer points to T
      return {
        reconciled: false,
        currentTaskId: null,
        taskAlreadyClosed: false,
        resolvedStatus: "CURRENT_TASK_UNRESOLVED",
        branch,
        headCommit,
        upstream,
        stopReason: CindyState.BLOCKED,
        detailedStopReason: CindyStopReason.CURRENT_TASK_UNRESOLVED,
        stopExplanation: "No active run exists and no explicit taskId provided; current task is unresolved",
        pointerHealth,
      };
    }
  }

  // Evaluate Git authority facts (Decisions H, I, J, L)
  const evalResult = evaluateGitAuthority({
    repoDir,
    taskId,
    runSnapshot: runSnapshot
      ? {
          branch: runSnapshot.branch,
          headCommit: runSnapshot.headCommit,
          baseCommit: runSnapshot.baseCommit,
          taskAuthorityCommit: runSnapshot.taskAuthorityCommit,
          upstreamSha: runSnapshot.upstreamSha,
          upstreamRef: runSnapshot.upstreamRef,
          upstreamCommit: runSnapshot.upstreamCommit,
          allowedScope: runSnapshot.allowedScope,
        }
      : undefined,
    callerAssertions: {
      expectedBranch: options.expectedBranch,
      expectedBaseCommit: options.expectedBaseCommit,
      expectedUpstreamSha: options.expectedUpstreamSha,
    },
  });

  const taskAlreadyClosed = evalResult.closure?.isClosed ?? false;
  let resolvedStatus = taskAlreadyClosed ? "CLOSED" : (runSnapshot?.state as string ?? "READY");

  if (evalResult.stopReason === CindyStopReason.INVALID_COMMITTED_CLOSURE) {
    resolvedStatus = "CORRUPT_CLOSURE";
  } else if (evalResult.stopReason === CindyStopReason.TASK_PACKET_NOT_COMMITTED) {
    resolvedStatus = "NON_EXISTENT";
  }

  if (!evalResult.ok) {
    return {
      reconciled: taskAlreadyClosed,
      currentTaskId: taskId,
      taskAlreadyClosed,
      resolvedStatus,
      branch: evalResult.actualBranch,
      headCommit: evalResult.actualHead,
      upstream: evalResult.actualUpstream,
      stopReason: evalResult.stopState,
      detailedStopReason: evalResult.stopReason,
      stopExplanation: evalResult.stopExplanation,
      pointerHealth,
    };
  }

  return {
    reconciled: true,
    currentTaskId: taskId,
    taskAlreadyClosed,
    resolvedStatus,
    branch: evalResult.actualBranch,
    headCommit: evalResult.actualHead,
    upstream: evalResult.actualUpstream,
    stopReason: null,
    detailedStopReason: null,
    stopExplanation: null,
    pointerHealth,
  };
}

/**
 * Read-only import of legacy .agent task specification and review history.
 * Preserves historical FAIL entries without mutating existing files.
 */
export async function importLegacyTask(
  taskId: string,
  options: { repoDir?: string | undefined } = {}
): Promise<LegacyTaskRecord> {
  validateTaskId(taskId);
  const repoDir = options.repoDir ?? process.cwd();
  const legacyFlat = join(repoDir, ".agent", "tasks", `${taskId}.json`);
  const legacyDir = join(repoDir, ".agent", "tasks", taskId, "task.json");

  let taskJsonPath: string | null = null;
  if (existsSync(legacyFlat)) {
    taskJsonPath = legacyFlat;
  } else if (existsSync(legacyDir)) {
    taskJsonPath = legacyDir;
  }

  if (!taskJsonPath) {
    throw new Error(`Legacy task file does not exist: ${legacyDir}`);
  }

  let raw: string;
  try {
    raw = await readFile(taskJsonPath, "utf8");
  } catch (err: unknown) {
    throw new ArtifactValidationError(`Failed to read legacy task file: ${err instanceof Error ? err.message : String(err)}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err: unknown) {
    throw new ArtifactValidationError(`Malformed JSON in legacy task file: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ArtifactValidationError("Legacy task file must contain a JSON object");
  }

  const recordObj = data as Record<string, unknown>;
  const fileTaskId = recordObj["taskId"];

  if (typeof fileTaskId !== "string" || !fileTaskId) {
    throw new ArtifactValidationError(`Legacy task file is missing required 'taskId'`);
  }

  validateTaskId(fileTaskId);

  if (fileTaskId !== taskId) {
    throw new ArtifactValidationError(
      `Legacy task file taskId mismatch: expected '${taskId}', found '${fileTaskId}'`
    );
  }

  const record: LegacyTaskRecord = {
    ...recordObj,
    taskId: fileTaskId,
    status: typeof recordObj["status"] === "string" ? recordObj["status"] : "UNKNOWN",
    reviewHistory: Array.isArray(recordObj["reviewHistory"])
      ? (recordObj["reviewHistory"] as LegacyTaskRecord["reviewHistory"])
      : [],
  };

  return record;
}
