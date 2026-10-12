/**
 * Cindy Orchestrator Types and Enums
 * Product Baseline: docs/development/cindy-orchestration.md
 * Task: CINDY-ORCH-MVP
 */

export const CindyState = {
  // Active / Normal states
  RECONCILING: "RECONCILING",
  TASK_INITIALIZED: "TASK_INITIALIZED",
  READY_FOR_BUILDER: "READY_FOR_BUILDER",
  BUILDING: "BUILDING",
  BUILDER_COMPLETE: "BUILDER_COMPLETE",
  TESTING: "TESTING",
  READY_FOR_REVIEW: "READY_FOR_REVIEW",
  REVIEWING: "REVIEWING",
  FINAL_GATE: "FINAL_GATE",
  READY_TO_COMMIT: "READY_TO_COMMIT",
  COMMITTING: "COMMITTING",
  PUSHING: "PUSHING",
  CLOSED: "CLOSED",
  NEXT_TASK_SELECTED: "NEXT_TASK_SELECTED",

  // Repair states
  REPAIR_INITIALIZED: "REPAIR_INITIALIZED",
  REPAIR_BUILDING: "REPAIR_BUILDING",

  // Pause / Stop states
  PRODUCT_DECISION_REQUIRED: "PRODUCT_DECISION_REQUIRED",
  BLOCKED: "BLOCKED",
  CONTRACT_CONFLICT: "CONTRACT_CONFLICT",
  DIRTY_TREE_UNEXPLAINED: "DIRTY_TREE_UNEXPLAINED",
  GIT_SAFETY_STOP: "GIT_SAFETY_STOP",
  MIGRATION_OR_SECURITY_AMBIGUITY: "MIGRATION_OR_SECURITY_AMBIGUITY",
} as const;

export type CindyState = (typeof CindyState)[keyof typeof CindyState];

export const CindyStopReason = {
  PRODUCT_DECISION_REQUIRED: "PRODUCT_DECISION_REQUIRED",
  BLOCKED: "BLOCKED",
  CONTRACT_CONFLICT: "CONTRACT_CONFLICT",
  DIRTY_TREE_UNEXPLAINED: "DIRTY_TREE_UNEXPLAINED",
  GIT_SAFETY_STOP: "GIT_SAFETY_STOP",
  MIGRATION_OR_SECURITY_AMBIGUITY: "MIGRATION_OR_SECURITY_AMBIGUITY",
  HEAD_MISMATCH: "HEAD_MISMATCH",
  HEAD_DRIFT: "HEAD_DRIFT",
  BASELINE_DRIFT: "BASELINE_DRIFT",
  BASELINE_MISMATCH: "BASELINE_MISMATCH",
  BRANCH_MISMATCH: "BRANCH_MISMATCH",
  UPSTREAM_MISSING: "UPSTREAM_MISSING",
  UPSTREAM_DRIFT: "UPSTREAM_DRIFT",
  UPSTREAM_AHEAD: "UPSTREAM_AHEAD",
  UPSTREAM_BEHIND: "UPSTREAM_BEHIND",
  UPSTREAM_DIVERGED: "UPSTREAM_DIVERGED",
  INVALID_COMMITTED_CLOSURE: "INVALID_COMMITTED_CLOSURE",
  TASK_PACKET_NOT_COMMITTED: "TASK_PACKET_NOT_COMMITTED",
  AMBIGUOUS_ACTIVE_RUN: "AMBIGUOUS_ACTIVE_RUN",
  ACTIVE_RUN_EXISTS: "ACTIVE_RUN_EXISTS",
  INVALID_RUN_RECORD: "INVALID_RUN_RECORD",
  RUN_GIT_SNAPSHOT_INCOMPLETE: "RUN_GIT_SNAPSHOT_INCOMPLETE",
  TASK_BASELINE_DRIFT: "TASK_BASELINE_DRIFT",
  TASK_PACKET_DRIFT: "TASK_PACKET_DRIFT",
  CONCURRENT_INIT: "CONCURRENT_INIT",
  CURRENT_TASK_UNRESOLVED: "CURRENT_TASK_UNRESOLVED",
} as const;

export type CindyStopReason = (typeof CindyStopReason)[keyof typeof CindyStopReason];

export interface StateTransitionEvent {
  fromState: CindyState;
  toState: CindyState;
  timestamp: string;
  reason?: string | undefined;
}

export interface InitRunOptions {
  runId: string;
  taskId: string;
  baseCommit?: string | undefined;
  branch?: string | undefined;
  allowedScope?: string[] | undefined;
}

export interface CindyRun {
  runId: string;
  taskId: string;
  version: number;
  state: CindyState;
  currentCycle: number;
  branch: string;
  baseCommit: string;
  headCommit: string;
  taskAuthorityCommit: string;
  upstreamRef: string;
  upstreamCommit: string;
  upstreamSha?: string | undefined;
  allowedScope: string[];
  boundTreeDigest?: string | undefined;
  boundDiffDigest?: string | undefined;
  pausedFrom?: CindyState | null | undefined;
  stopReason?: CindyStopReason | CindyState | null | undefined;
  stopExplanation?: string | null | undefined;
  history: StateTransitionEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface BaselineArtifact {
  runId: string;
  taskId: string;
  branch: string;
  baseCommit: string;
  taskAuthorityCommit: string;
  upstreamRef: string;
  upstreamCommit: string;
  upstreamSha?: string | null;
  initialTreeClean: boolean;
  initialTreeDigest: string;
  recordedAt: string;
}

export const CINDY_EXECUTION_SNAPSHOT_V1 = "CINDY_EXECUTION_SNAPSHOT_V1";
export type CINDY_EXECUTION_SNAPSHOT_V1 = typeof CINDY_EXECUTION_SNAPSHOT_V1;

export const CINDY_EXECUTION_INPUTS_V1 = "CINDY_EXECUTION_INPUTS_V1";
export type CINDY_EXECUTION_INPUTS_V1 = typeof CINDY_EXECUTION_INPUTS_V1;

export interface ExecutionInputsDeclaration {
  version: typeof CINDY_EXECUTION_INPUTS_V1;
  taskId: string;
  ignoredPaths: string[];
}

export interface IgnoredInputDeclarationMetadata {
  version: typeof CINDY_EXECUTION_INPUTS_V1;
  source: "COMMITTED_TASK_SCOPED_FILE" | "ABSENT_EMPTY";
  path: string;
  authorityCommit: string;
  contentSha256: string | null;
}

export type SnapshotEntryType = "regular" | "symlink" | "deleted";

export interface SnapshotRegularEntry {
  path: string;
  entryType: "regular";
  contentSha256: string;
  executable: boolean;
}

export interface SnapshotSymlinkEntry {
  path: string;
  entryType: "symlink";
  target: string;
}

export interface SnapshotDeletedEntry {
  path: string;
  entryType: "deleted";
}

export type SnapshotEntry = SnapshotRegularEntry | SnapshotSymlinkEntry | SnapshotDeletedEntry;

export interface ExecutionSnapshotManifest {
  version: typeof CINDY_EXECUTION_SNAPSHOT_V1;
  headCommit: string;
  ignoredInputDeclaration?: IgnoredInputDeclarationMetadata | undefined;
  entries: SnapshotEntry[];
}

export interface FileIdentityRecord {
  path: string;
  entryType: "regular" | "symlink" | "deleted";
  ino?: number | undefined;
  dev?: number | undefined;
  size?: number | undefined;
  mtimeMs?: number | undefined;
  ctimeMs?: number | undefined;
  mode?: number | undefined;
  target?: string | undefined;
}

export interface ExecutionSnapshotResult {
  version: typeof CINDY_EXECUTION_SNAPSHOT_V1;
  digest: string;
  manifest: ExecutionSnapshotManifest;
  fileIdentities?: Map<string, FileIdentityRecord> | undefined;
}

export interface DiffManifestArtifact {
  runId: string;
  taskId: string;
  baseCommit: string;
  changedFiles: string[];
  untrackedFiles: string[];
  stagedFiles: string[];
  unstagedFiles: string[];
  deletedFiles: string[];
  renamedFiles: Array<{ from: string; to: string }>;
  allowedScope: string[];
  isWithinScope: boolean;
  unexplainedFiles: string[];
  diffDigest: string;
  executionSnapshotVersion: typeof CINDY_EXECUTION_SNAPSHOT_V1;
  executionSnapshotDigest: string;
  boundTreeDigest: string;
  recordedAt: string;
  trustClassification?: EvidenceTrustClassification | undefined;
}

export interface DirtyTreeOwnershipResult {
  ok: boolean;
  dirtyFiles: string[];
  unexplainedFiles: string[];
  stopReason: CindyState | null;
}

export type EvidenceTrustClassification = "UNVERIFIED_EXTERNAL" | "STRUCTURE_VALID_EXTERNAL";

export interface ReconcileResult {
  reconciled: boolean;
  currentTaskId: string | null;
  taskAlreadyClosed: boolean;
  resolvedStatus: string;
  branch: string;
  headCommit: string;
  upstream?: { remote: string; branch: string; commit: string; ref?: string | undefined } | null | undefined;
  stopReason: CindyState | CindyStopReason | null;
  detailedStopReason?: CindyStopReason | null | undefined;
  stopExplanation: string | null;
  pointerHealth?: "OK" | "MISSING" | "STALE" | "CORRUPT" | "MISMATCH" | null | undefined;
}

export interface LegacyTaskRecord {
  taskId: string;
  status: string;
  branch?: string | undefined;
  baseCommit?: string | undefined;
  reviewHistory: Array<{
    review?: string | undefined;
    verdict?: string | undefined;
    repairTaskId?: string | undefined;
    findings?: unknown;
    closure?: unknown;
  }>;
  closeoutCommit?: string | undefined;
  [key: string]: unknown;
}

export const ArtifactKind = {
  RUN: "run",
  BASELINE: "baseline",
  DIFF_MANIFEST: "diff-manifest",
  TEST_RESULT: "test-result",
  REVIEW_REQUEST: "review-request",
  REVIEW_RESULT: "review-result",
  REPAIR_INIT: "repair-init",
  CLOSEOUT: "closeout",
  GIT_RECEIPT: "git-receipt",
  NEXT_TASK: "next-task",
  TASK_PACKET: "task-packet",
  EXECUTION_INPUTS: "execution-inputs",
} as const;

export type ArtifactKind = (typeof ArtifactKind)[keyof typeof ArtifactKind];

export const PRIVILEGED_STATES: ReadonlySet<CindyState> = new Set([
  CindyState.FINAL_GATE,
  CindyState.READY_TO_COMMIT,
  CindyState.COMMITTING,
  CindyState.PUSHING,
  CindyState.CLOSED,
  CindyState.NEXT_TASK_SELECTED,
]);

export function isPrivilegedState(state: CindyState): boolean {
  return PRIVILEGED_STATES.has(state);
}

export const RESUME_TARGET_WHITELIST: ReadonlySet<CindyState> = new Set([
  CindyState.TASK_INITIALIZED,
  CindyState.READY_FOR_BUILDER,
  CindyState.BUILDING,
  CindyState.BUILDER_COMPLETE,
  CindyState.TESTING,
  CindyState.READY_FOR_REVIEW,
  CindyState.REVIEWING,
  CindyState.REPAIR_INITIALIZED,
  CindyState.REPAIR_BUILDING,
]);

export function isAllowedResumeTarget(state: CindyState): boolean {
  return RESUME_TARGET_WHITELIST.has(state);
}

export const ADMINISTRATIVE_PAUSE_TARGETS: ReadonlySet<CindyState> = new Set([
  CindyState.BLOCKED,
  CindyState.PRODUCT_DECISION_REQUIRED,
  CindyState.CONTRACT_CONFLICT,
  CindyState.MIGRATION_OR_SECURITY_AMBIGUITY,
]);

export function isAdministrativePauseTarget(state: string): state is CindyState {
  return (ADMINISTRATIVE_PAUSE_TARGETS as ReadonlySet<string>).has(state);
}

export const STATE_DRIVING_ARTIFACT_KINDS: ReadonlySet<string> = new Set([
  ArtifactKind.BASELINE,
  ArtifactKind.TEST_RESULT,
  ArtifactKind.DIFF_MANIFEST,
  ArtifactKind.REVIEW_REQUEST,
  ArtifactKind.REVIEW_RESULT,
  ArtifactKind.REPAIR_INIT,
  ArtifactKind.CLOSEOUT,
  ArtifactKind.NEXT_TASK,
]);

export function isStateDrivingArtifactKind(kind: string): boolean {
  return STATE_DRIVING_ARTIFACT_KINDS.has(kind);
}

export interface TestResultArtifact {
  runId: string;
  taskId: string;
  cycle: number;
  command: string;
  startedAt: string;
  completedAt: string;
  exitCode: number;
  executionSnapshotVersion: typeof CINDY_EXECUTION_SNAPSHOT_V1;
  executionSnapshotDigest: string;
  boundTreeDigest: string;
  logDigest: string;
  status: "PASS" | "FAIL";
  trustClassification?: EvidenceTrustClassification | undefined;
}

export interface ReviewFinding {
  id: string;
  severity: "BLOCKER" | "HIGH" | "MEDIUM" | "LOW";
  title: string;
  description?: string;
  reproduction?: string;
  requirement?: string;
  disposition?: "OPEN" | "CLOSED";
}

export interface ReviewResultArtifact {
  runId: string;
  taskId: string;
  reviewedBaseCommit: string;
  cycle: number;
  reviewer: {
    identity: string;
    session: string;
    readOnlyConfirmed: boolean;
  };
  executionSnapshotVersion: typeof CINDY_EXECUTION_SNAPSHOT_V1;
  executionSnapshotDigest: string;
  reviewedTreeDigest: string;
  reviewedDiffDigest: string;
  verdict: "PASS" | "FAIL";
  findings: ReviewFinding[];
  recordedAt: string;
  trustClassification?: EvidenceTrustClassification | undefined;
}

export interface CloseoutArtifact {
  runId: string;
  taskId: string;
  status: "CLOSED";
  finalTreeDigest: string;
  finalGate: "PASS";
  reviewHistory?: unknown[];
  closedAt: string;
}

export interface RepairInitArtifact {
  runId: string;
  taskId: string;
  cycle: number;
  boundTreeDigest: string;
  reasons: string[];
  findings?: unknown[];
  recordedAt: string;
  trustClassification?: EvidenceTrustClassification | undefined;
}

export interface ReviewRequestArtifact {
  runId: string;
  taskId: string;
  baseCommit: string;
  cycle: number;
  reviewer: {
    identity: string;
    session: string;
    readOnlyConfirmed?: boolean;
    readOnlyRequired: boolean;
  };
  executionSnapshotVersion: typeof CINDY_EXECUTION_SNAPSHOT_V1;
  executionSnapshotDigest: string;
  boundTreeDigest: string;
  requestedAt: string;
  trustClassification?: EvidenceTrustClassification | undefined;
}

export interface GitReceiptArtifact {
  runId: string;
  taskId: string;
  commit: string;
  branch: string;
  remote?: string;
  prePushSha?: string | null;
  postPushSha?: string | null;
  finalTreeClean: boolean;
  recordedAt: string;
  trustClassification?: EvidenceTrustClassification | undefined;
}

export interface NextTaskArtifact {
  runId: string;
  taskId: string;
  nextTaskId: string;
  selectionReason?: string;
  selectedAt: string;
}

export class InvalidRepositoryRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRepositoryRootError";
  }
}

export class TransitionRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionRejectedError";
  }
}

export class ConflictingArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictingArtifactError";
  }
}

export class ArtifactDigestMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactDigestMismatchError";
  }
}

export class DirtyTreeUnexplainedError extends Error {
  public readonly unexplainedFiles: string[];
  constructor(unexplainedFiles: string[]) {
    super(`Dirty tree unexplained files: ${unexplainedFiles.join(", ")}`);
    this.name = "DirtyTreeUnexplainedError";
    this.unexplainedFiles = unexplainedFiles;
  }
}

export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathTraversalError";
  }
}

export class InvalidRunIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRunIdError";
  }
}

export class ArtifactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactValidationError";
  }
}

export class InvalidTaskIdError extends ArtifactValidationError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTaskIdError";
  }
}

export class StateDrivingArtifactRequiresTypedWriterError extends ArtifactValidationError {
  public readonly kind: string;

  constructor(kind: string) {
    super(
      `STATE_DRIVING_ARTIFACT_REQUIRES_TYPED_WRITER: Artifact kind '${kind}' is state-driving and cannot be recorded via generic recordArtifact. Use the dedicated typed writer.`
    );
    this.name = "StateDrivingArtifactRequiresTypedWriterError";
    this.kind = kind;
  }
}

export class ArtifactBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactBindingError";
  }
}

export class ConcurrentRunUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrentRunUpdateError";
  }
}

export class StaleRunLockError extends ConcurrentRunUpdateError {
  constructor(message: string = "STALE_RUN_LOCK_REQUIRES_RECONCILIATION") {
    super(message);
    this.name = "StaleRunLockError";
  }
}

export class ConcurrentInitError extends ConcurrentRunUpdateError {
  constructor(message: string = "CONCURRENT_INIT") {
    super(message);
    this.name = "ConcurrentInitError";
  }
}

export class StaleInitLockError extends ConcurrentRunUpdateError {
  constructor(message: string = "STALE_INIT_LOCK_REQUIRES_RECONCILIATION") {
    super(message);
    this.name = "StaleInitLockError";
  }
}

export class ArtifactCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactCorruptionError";
  }
}

export class InvalidCommittedClosureError extends ArtifactValidationError {
  constructor(message: string) {
    super(`INVALID_COMMITTED_CLOSURE: ${message}`);
    this.name = "InvalidCommittedClosureError";
  }
}

export class TaskPacketNotCommittedError extends TransitionRejectedError {
  constructor(taskId: string) {
    super(`TASK_PACKET_NOT_COMMITTED: Authoritative task packet for '${taskId}' not found in HEAD`);
    this.name = "TaskPacketNotCommittedError";
  }
}

export class AmbiguousActiveRunError extends Error {
  constructor(message: string = "AMBIGUOUS_ACTIVE_RUN") {
    super(message);
    this.name = "AmbiguousActiveRunError";
  }
}

export class ActiveRunExistsError extends TransitionRejectedError {
  constructor(message: string = "ACTIVE_RUN_EXISTS") {
    super(message);
    this.name = "ActiveRunExistsError";
  }
}

export class InvalidRunRecordError extends Error {
  constructor(message: string = "INVALID_RUN_RECORD") {
    super(message);
    this.name = "InvalidRunRecordError";
  }
}

export class RunGitSnapshotIncompleteError extends Error {
  constructor(message: string = "RUN_GIT_SNAPSHOT_INCOMPLETE") {
    super(message);
    this.name = "RunGitSnapshotIncompleteError";
  }
}

export class SymlinkEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SymlinkEscapeError";
  }
}

export class UnsupportedFileTypeSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFileTypeSnapshotError";
  }
}

export class FilesystemSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilesystemSnapshotError";
  }
}

export class ExecutionInputsValidationError extends ArtifactValidationError {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionInputsValidationError";
  }
}

export interface ValidatedGitAuthorityContext {
  headCommit: string;
  branch: string;
  upstreamRef: string | null;
  upstreamCommit: string | null;
  aheadCount: number;
  behindCount: number;
  divergence: "equal" | "ahead" | "behind" | "diverged" | "missing";
  taskPacket: Record<string, unknown> | null;
  taskAuthorityCommit: string | null;
  actualStatus: {
    isClean: boolean;
    dirtyFiles: string[];
    entries: unknown[];
  };
  closure: {
    isClosed: boolean;
    closureData?: Record<string, unknown> | undefined;
  } | null;
}
