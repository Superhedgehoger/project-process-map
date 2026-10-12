import {
  CindyState,
  CindyStopReason,
  ArtifactKind,
  TransitionRejectedError,
  ArtifactDigestMismatchError,
  ArtifactValidationError,
  AmbiguousActiveRunError,
  ConcurrentRunUpdateError,
  ConflictingArtifactError,
  RESUME_TARGET_WHITELIST,
  CINDY_EXECUTION_SNAPSHOT_V1,
  type CindyRun,
  type BaselineArtifact,
  type DirtyTreeOwnershipResult,
  type ReconcileResult,
  type TestResultArtifact,
  type ReviewResultArtifact,
  type ReviewRequestArtifact,
  type CloseoutArtifact,
  type DiffManifestArtifact,
  type InitRunOptions,
} from "./types.ts";
import { validateTransition, isPauseState } from "./state-machine.ts";
import {
  getGitBranch,
  getGitHead,
  getGitUpstream,
  getGitStatus,
  evaluateGitAuthority,
} from "./git.ts";
import {
  computeTreeDigest,
  computeDiffDigest,
  computeExecutionSnapshot,
  computeAuthoritativeExecutionSnapshot,
  type ComputeExecutionSnapshotOptions,
  type ExecutionSnapshotResult,
} from "./digest.ts";
import {
  checkDirtyTreeOwnership,
  validateScopeEntry,
} from "./ownership.ts";
import {
  RuntimeArtifactStore,
  executeSemanticTransition,
  canonicalizeJson,
  type RecordArtifactOptions,
  type RecordArtifactResult,
} from "./artifact-store.ts";
import { reconcileCurrentState } from "./reconcile.ts";
import { validateRunId, isCyclicArtifactKind, canonicalizeRepoDir } from "./path-safety.ts";

export type { InitRunOptions };

const SNAPSHOT_DIGEST_REGEX = /^[0-9a-f]{64}$/;

export interface TransitionOptions {
  reason?: string | undefined;
  boundTreeDigest?: string | undefined;
  expectedVersion?: number | undefined;
  stopReason?: CindyStopReason | CindyState | undefined;
}

export class CindyOrchestrator {
  public readonly repoDir: string;
  public readonly artifactStore: RuntimeArtifactStore;

  constructor(options: { repoDir?: string } = {}) {
    this.repoDir = canonicalizeRepoDir(options.repoDir ?? process.cwd());
    this.artifactStore = new RuntimeArtifactStore({ repoDir: this.repoDir });
  }

  /**
   * Initializes a new Cindy run with strict runId/taskId validation, version 1,
   * Git authority checking, committed Task Packet baseline and scope binding,
   * and baseline artifact recorded in ignored runtime directory.
   * If task is already CLOSED in committed closure at HEAD, fails closed.
   * Delegated directly to artifactStore.initializeRunSafely (Decision U).
   */
  public async initRun(options: InitRunOptions): Promise<CindyRun> {
    return this.artifactStore.initializeRunSafely(options);
  }

  public async getRun(runId: string): Promise<CindyRun> {
    return this.artifactStore.getRun(runId);
  }

  /**
   * Controlled pause transition to an approved pause state.
   * Forward execution states cannot be entered via this method.
   */
  public async pauseRun(
    runId: string,
    targetState: CindyState,
    options: TransitionOptions = {}
  ): Promise<CindyRun> {
    if (!isPauseState(targetState)) {
      throw new TransitionRejectedError(
        `Cannot pause run into non-pause state '${targetState}'; pause operation only accepts approved pause states`
      );
    }
    if (
      targetState === CindyState.GIT_SAFETY_STOP ||
      targetState === CindyState.DIRTY_TREE_UNEXPLAINED
    ) {
      throw new TransitionRejectedError(
        `Target state '${targetState}' is a derived safety stop and cannot be requested by caller; safety stops must be derived internally by system`
      );
    }
    return this.artifactStore.applyAdministrativeTransition(runId, targetState, options);
  }

  public async deriveSafetyStop(
    runId: string,
    options: { expectedVersion?: number | undefined } = {}
  ): Promise<CindyRun> {
    return executeSemanticTransition(this.artifactStore, runId, {
      type: "deriveSafetyStop",
      ...options,
    });
  }

  /**
   * Generic transition is restricted: forward execution states are rejected.
   * Only approved pause states are accepted and delegated to pauseRun().
   */
  public async transition(
    runId: string,
    targetState: CindyState,
    options: TransitionOptions = {}
  ): Promise<CindyRun> {
    const run = await this.getRun(runId);
    if (isPauseState(run.state)) {
      throw new TransitionRejectedError(
        `Generic transition from pause state '${run.state}' to '${targetState}' is rejected; pause reason is immutable until successful resume via controlled resumeRun()`
      );
    }
    if (!isPauseState(targetState)) {
      throw new TransitionRejectedError(
        `Direct transition to forward execution state '${targetState}' via generic transition() is prohibited; use dedicated semantic operations (e.g. markReadyForBuilder, startBuilding, completeBuilding, startTesting, prepareForReview, startReview, etc.)`
      );
    }
    return this.artifactStore.applyAdministrativeTransition(runId, targetState, options);
  }

  public async markReadyForBuilder(
    runId: string,
    options: TransitionOptions = {}
  ): Promise<CindyRun> {
    return executeSemanticTransition(this.artifactStore, runId, {
      type: "markReadyForBuilder",
      reason: options.reason,
      boundTreeDigest: options.boundTreeDigest,
      expectedVersion: options.expectedVersion,
    });
  }

  public async startBuilding(
    runId: string,
    options: TransitionOptions = {}
  ): Promise<CindyRun> {
    return executeSemanticTransition(this.artifactStore, runId, {
      type: "startBuilding",
      reason: options.reason,
      boundTreeDigest: options.boundTreeDigest,
      expectedVersion: options.expectedVersion,
    });
  }

  public async completeBuilding(
    runId: string,
    options: TransitionOptions = {}
  ): Promise<CindyRun> {
    return executeSemanticTransition(this.artifactStore, runId, {
      type: "completeBuilding",
      reason: options.reason,
      boundTreeDigest: options.boundTreeDigest,
      expectedVersion: options.expectedVersion,
    });
  }

  public async startTesting(
    runId: string,
    options: TransitionOptions = {}
  ): Promise<CindyRun> {
    return executeSemanticTransition(this.artifactStore, runId, {
      type: "startTesting",
      reason: options.reason,
      boundTreeDigest: options.boundTreeDigest,
      expectedVersion: options.expectedVersion,
    });
  }

  public async startRepairBuilding(
    runId: string,
    options: TransitionOptions = {}
  ): Promise<CindyRun> {
    return executeSemanticTransition(this.artifactStore, runId, {
      type: "startRepairBuilding",
      reason: options.reason,
      boundTreeDigest: options.boundTreeDigest,
      expectedVersion: options.expectedVersion,
    });
  }

  public async completeRepairBuilding(
    runId: string,
    options: TransitionOptions = {}
  ): Promise<CindyRun> {
    return this.startTesting(runId, {
      ...options,
      reason: options.reason ?? "Repair building complete; proceeding to testing",
    });
  }

  /**
   * Controlled reconcile-driven resume from a pause state (Architecture Decision K & O).
   * Authoritative Git and task validation, stop-reason policy and state machine integrity
   * are enforced at the storage/atomic lock boundary in applyResumeTransition.
   * On failure or persisting stop conditions, the run is NOT modified and remains in its
   * original state, stopReason, and pausedFrom.
   * No intermediate RECONCILING state is written or exposed.
   */
  public async resumeRun(runId: string): Promise<CindyRun> {
    const run = await this.getRun(runId);
    if (!isPauseState(run.state)) {
      throw new TransitionRejectedError(
        `Cannot resume run '${runId}'; run is in active state '${run.state}', not a pause state`
      );
    }

    const pausedFromState = run.pausedFrom as CindyState;
    if (!pausedFromState || !RESUME_TARGET_WHITELIST.has(pausedFromState)) {
      throw new TransitionRejectedError(
        `Corrupted or prohibited pausedFrom state '${String(pausedFromState)}'; cannot resume`
      );
    }

    try {
      const treeDigest = await computeTreeDigest(this.repoDir);
      return await this.artifactStore.applyResumeTransition(runId, {
        reason: `Reconcile safety checks passed; resumed to ${pausedFromState}`,
        boundTreeDigest: treeDigest,
      });
    } catch (err: unknown) {
      if (err instanceof TransitionRejectedError && err.message.startsWith("Cannot resume run:")) {
        // Stop condition persists or live authority checks failed.
        // As per AD-O, keep original state, stopReason, pausedFrom untouched.
        return run;
      }
      throw err;
    }
  }

  // =========================================================================
  // Consumption-time Evidence Validation
  // =========================================================================

  /**
   * Re-validates that an artifact can legitimately serve as trusted evidence
   * against the current live working tree, task, base commit, and cycle.
   */
  public async readValidatedEvidence<T = unknown>(
    runId: string,
    artifactType: string,
    options: { cycle?: number | undefined; expectedState?: CindyState | undefined } = {}
  ): Promise<T> {
    const run = await this.getRun(runId);
    const currentTree = await computeTreeDigest(this.repoDir);

    const targetCycle =
      options.cycle !== undefined
        ? options.cycle
        : (isCyclicArtifactKind(artifactType as ArtifactKind) || artifactType === ArtifactKind.DIFF_MANIFEST)
        ? run.currentCycle
        : undefined;

    let raw = await this.artifactStore.readArtifact<T>(runId, artifactType, targetCycle);
    if (!raw && artifactType === ArtifactKind.DIFF_MANIFEST && targetCycle !== undefined) {
      raw = await this.artifactStore.readArtifact<T>(runId, artifactType);
    }
    if (!raw) {
      throw new ArtifactValidationError(
        `Evidence artifact '${artifactType}' not found for run '${runId}'`
      );
    }

    const record = raw as Record<string, unknown>;

    // 0. Trust classification check for state-driving artifacts
    const stateDrivingKinds = new Set<string>([
      ArtifactKind.BASELINE,
      ArtifactKind.TEST_RESULT,
      ArtifactKind.DIFF_MANIFEST,
      ArtifactKind.REVIEW_REQUEST,
      ArtifactKind.REVIEW_RESULT,
      ArtifactKind.REPAIR_INIT,
      ArtifactKind.CLOSEOUT,
      ArtifactKind.NEXT_TASK,
    ]);
    if (stateDrivingKinds.has(artifactType)) {
      if (record.trustClassification !== "STRUCTURE_VALID_EXTERNAL") {
        throw new ArtifactValidationError(
          `Evidence artifact '${artifactType}' has unverified trust classification '${String(record.trustClassification)}'; must be STRUCTURE_VALID_EXTERNAL`
        );
      }
    }

    // 1. runId binding
    if (typeof record.runId === "string" && record.runId !== run.runId) {
      throw new ArtifactValidationError(
        `Evidence artifact '${artifactType}' runId mismatch: payload has '${record.runId}', expected '${run.runId}'`
      );
    }

    // 2. taskId binding
    if (typeof record.taskId === "string" && record.taskId !== run.taskId) {
      throw new ArtifactValidationError(
        `Evidence artifact '${artifactType}' taskId mismatch: payload has '${record.taskId}', expected '${run.taskId}'`
      );
    }

    // 3. cycle binding for cyclic kinds
    if (isCyclicArtifactKind(artifactType as ArtifactKind)) {
      if (record.cycle !== targetCycle) {
        throw new ArtifactValidationError(
          `Evidence artifact '${artifactType}' cycle mismatch: payload has cycle ${String(record.cycle)}, expected ${targetCycle}`
        );
      }
    }

    // 4. base commit binding
    const baseCommit = (record.baseCommit ?? record.reviewedBaseCommit) as string | undefined;
    if (baseCommit && baseCommit !== run.baseCommit) {
      throw new ArtifactValidationError(
        `Evidence artifact '${artifactType}' base commit mismatch: payload has '${baseCommit}', expected '${run.baseCommit}'`
      );
    }

    // 5. tree digest matching against live working tree
    const boundTree = (record.boundTreeDigest ??
      record.reviewedTreeDigest ??
      record.finalTreeDigest ??
      record.treeDigest) as string | undefined;
    if (boundTree && boundTree !== currentTree) {
      throw new ArtifactDigestMismatchError(
        `Evidence artifact '${artifactType}' tree digest ('${boundTree}') does not match authoritative working tree digest ('${currentTree}')`
      );
    }

    // 5b. execution snapshot matching against live snapshot
    const liveSnapshot = await computeAuthoritativeExecutionSnapshot(
      this.repoDir,
      run.taskId,
      { expectedHeadCommit: run.headCommit }
    );
    if (record.executionSnapshotVersion && record.executionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1) {
      throw new ArtifactValidationError(
        `Evidence artifact '${artifactType}' executionSnapshotVersion ('${String(record.executionSnapshotVersion)}') does not match authoritative snapshot version ('${CINDY_EXECUTION_SNAPSHOT_V1}')`
      );
    }
    if (record.executionSnapshotDigest && record.executionSnapshotDigest !== liveSnapshot.digest) {
      throw new ArtifactDigestMismatchError(
        `Evidence artifact '${artifactType}' executionSnapshotDigest ('${String(record.executionSnapshotDigest)}') does not match authoritative execution snapshot digest ('${liveSnapshot.digest}')`
      );
    }

    // 6. Test result specific evidence validation
    if (artifactType === ArtifactKind.TEST_RESULT) {
      const testRes = raw as unknown as TestResultArtifact;
      if (testRes.status !== "PASS") {
        throw new ArtifactValidationError(
          `Test result status is '${testRes.status}', expected 'PASS'`
        );
      }
      if (testRes.exitCode !== 0) {
        throw new ArtifactValidationError(
          `Test result status is 'PASS' but exitCode is ${testRes.exitCode}; must be 0 for PASS`
        );
      }
    }

    // 7. Review result specific evidence validation
    if (artifactType === ArtifactKind.REVIEW_RESULT) {
      const revRes = raw as unknown as ReviewResultArtifact;
      if (revRes.verdict !== "PASS") {
        throw new ArtifactValidationError(
          `Review result verdict is '${revRes.verdict}', expected 'PASS'`
        );
      }
      if (revRes.reviewer?.readOnlyConfirmed !== true) {
        throw new ArtifactValidationError(
          `Review result reviewer.readOnlyConfirmed must be true`
        );
      }

      // Review result must bind to genuine review-request
      const req = await this.artifactStore.readArtifact<ReviewRequestArtifact>(
        runId,
        ArtifactKind.REVIEW_REQUEST,
        targetCycle
      );
      if (!req) {
        throw new ArtifactValidationError(
          `No review-request found for review-result in cycle ${targetCycle}`
        );
      }
      if (req.reviewer.identity !== revRes.reviewer.identity) {
        throw new ArtifactValidationError(
          `Review result reviewer identity ('${revRes.reviewer.identity}') does not match review request reviewer ('${req.reviewer.identity}')`
        );
      }

      // Session binding: if the review-request recorded a session,
      // the review-result must provide the same session.
      // Same identity + different session = rejected (M01 fix).
      if (req.reviewer.session && revRes.reviewer.session !== req.reviewer.session) {
        throw new ArtifactValidationError(
          `Review result reviewer session mismatch: expected '${req.reviewer.session}', got '${String(revRes.reviewer.session)}'`
        );
      }
    }

    return raw;
  }

  /**
   * Consumes and re-validates a Review PASS artifact against the authoritative live working tree.
   * Fully validates task, base, session, cycle, and tree bindings against review-request and live Git state.
   * Does NOT advance run to FINAL_GATE; run remains in REVIEWING.
   */
  public async consumeReviewPass(runId: string, cycle?: number): Promise<ReviewResultArtifact> {
    const run = await this.getRun(runId);
    const targetCycle = cycle !== undefined ? cycle : run.currentCycle;
    const runDir = this.artifactStore.getRunDir(runId);
    const { ownerId } = await this.artifactStore.acquireRunLock(runDir);

    try {
      // 0. Live Git authority validation against run bound snapshot (Architecture Decision CR)
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
      if (!authority.ok && authority.stopState !== CindyState.DIRTY_TREE_UNEXPLAINED) {
        throw new TransitionRejectedError(
          `Live Git authority check failed during consumeReviewPass: ${authority.stopExplanation}`
        );
      }

      // 1. Read current Git tree digest
      const currentTree = await computeTreeDigest(this.repoDir);

      // 2. Read review-result artifact
      const reviewResult = await this.artifactStore.readArtifact<ReviewResultArtifact>(
        runId,
        ArtifactKind.REVIEW_RESULT,
        targetCycle
      );
      if (!reviewResult) {
        throw new ArtifactValidationError(
          `Review result not found for run '${runId}' cycle ${targetCycle}`
        );
      }
      if (reviewResult.trustClassification !== "STRUCTURE_VALID_EXTERNAL") {
        throw new ArtifactValidationError(
          `Review result has unverified trust classification '${String(reviewResult.trustClassification)}'; must be STRUCTURE_VALID_EXTERNAL`
        );
      }

      // 3. Read review-request artifact
      const reviewRequest = await this.artifactStore.readArtifact<ReviewRequestArtifact>(
        runId,
        ArtifactKind.REVIEW_REQUEST,
        targetCycle
      );
      if (!reviewRequest) {
        throw new ArtifactValidationError(
          `Review request not found for run '${runId}' cycle ${targetCycle}`
        );
      }
      if (reviewRequest.trustClassification !== "STRUCTURE_VALID_EXTERNAL") {
        throw new ArtifactValidationError(
          `Review request has unverified trust classification '${String(reviewRequest.trustClassification)}'; must be STRUCTURE_VALID_EXTERNAL`
        );
      }

      // 4. Validate verdict is PASS
      if (reviewResult.verdict !== "PASS") {
        throw new ArtifactValidationError(
          `Review result verdict is '${reviewResult.verdict}', expected 'PASS'`
        );
      }

      // 5. runId binding: request.runId == result.runId == run.runId
      if (reviewRequest.runId !== run.runId || reviewResult.runId !== run.runId) {
        throw new ArtifactValidationError(
          `Review runId binding mismatch: request='${reviewRequest.runId}', result='${reviewResult.runId}', run='${run.runId}'`
        );
      }

      // 6. taskId binding: request.taskId == result.taskId == run.taskId
      if (reviewRequest.taskId !== run.taskId || reviewResult.taskId !== run.taskId) {
        throw new ArtifactValidationError(
          `Review taskId binding mismatch: request='${reviewRequest.taskId}', result='${reviewResult.taskId}', run='${run.taskId}'`
        );
      }

      // 7. baseCommit binding: request.baseCommit == result.reviewedBaseCommit == run.baseCommit
      const resultBase = reviewResult.reviewedBaseCommit;
      if (reviewRequest.baseCommit !== run.baseCommit || resultBase !== run.baseCommit) {
        throw new ArtifactValidationError(
          `Review baseCommit binding mismatch: request='${reviewRequest.baseCommit}', result='${resultBase}', run='${run.baseCommit}'`
        );
      }

      // 8. cycle binding: request.cycle == result.cycle == run.currentCycle
      if (reviewRequest.cycle !== run.currentCycle || reviewResult.cycle !== run.currentCycle) {
        throw new ArtifactValidationError(
          `Review cycle binding mismatch: request=${reviewRequest.cycle}, result=${reviewResult.cycle}, run=${run.currentCycle}`
        );
      }

      // 9. treeDigest binding: request.treeDigest == result.reviewedTreeDigest == current trusted tree digest
      const requestTree = reviewRequest.boundTreeDigest;
      if (requestTree !== currentTree || reviewResult.reviewedTreeDigest !== currentTree) {
        throw new ArtifactDigestMismatchError(
          `Review tree digest mismatch against live tree: request='${requestTree}', result='${reviewResult.reviewedTreeDigest}', live='${currentTree}'`
        );
      }

      // 9a. diffDigest binding
      const currentDiff = await computeDiffDigest(this.repoDir);
      if (reviewResult.reviewedDiffDigest !== currentDiff) {
        throw new ArtifactDigestMismatchError(
          `Review result reviewedDiffDigest ('${reviewResult.reviewedDiffDigest}') does not match authoritative live diff digest ('${currentDiff}')`
        );
      }

      // 9b. executionSnapshot binding
      const liveSnapshot = await computeAuthoritativeExecutionSnapshot(
        this.repoDir,
        run.taskId,
        { expectedHeadCommit: run.headCommit }
      );

      if (
        !reviewRequest.executionSnapshotVersion ||
        reviewRequest.executionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1
      ) {
        throw new ArtifactValidationError(
          `Review request missing or invalid executionSnapshotVersion: expected '${CINDY_EXECUTION_SNAPSHOT_V1}'`
        );
      }
      if (
        !reviewRequest.executionSnapshotDigest ||
        !SNAPSHOT_DIGEST_REGEX.test(reviewRequest.executionSnapshotDigest)
      ) {
        throw new ArtifactValidationError(
          `Review request missing or malformed executionSnapshotDigest: expected 64-char hex digest`
        );
      }
      if (
        !reviewResult.executionSnapshotVersion ||
        reviewResult.executionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1
      ) {
        throw new ArtifactValidationError(
          `Review result missing or invalid executionSnapshotVersion: expected '${CINDY_EXECUTION_SNAPSHOT_V1}'`
        );
      }
      if (
        !reviewResult.executionSnapshotDigest ||
        !SNAPSHOT_DIGEST_REGEX.test(reviewResult.executionSnapshotDigest)
      ) {
        throw new ArtifactValidationError(
          `Review result missing or malformed executionSnapshotDigest: expected 64-char hex digest`
        );
      }

      if (reviewRequest.executionSnapshotDigest !== liveSnapshot.digest) {
        throw new ArtifactDigestMismatchError(
          `Review request execution snapshot digest ('${reviewRequest.executionSnapshotDigest}') does not match live snapshot digest ('${liveSnapshot.digest}')`
        );
      }
      if (reviewResult.executionSnapshotDigest !== liveSnapshot.digest) {
        throw new ArtifactDigestMismatchError(
          `Review result execution snapshot digest ('${reviewResult.executionSnapshotDigest}') does not match live snapshot digest ('${liveSnapshot.digest}')`
        );
      }
      if (reviewRequest.executionSnapshotDigest !== reviewResult.executionSnapshotDigest) {
        throw new ArtifactDigestMismatchError(
          `Review snapshot digest mismatch: request='${reviewRequest.executionSnapshotDigest}', result='${reviewResult.executionSnapshotDigest}'`
        );
      }

      // 10. reviewer identity binding: request.reviewerIdentity == result.reviewerIdentity
      if (reviewRequest.reviewer.identity !== reviewResult.reviewer.identity) {
        throw new ArtifactValidationError(
          `Reviewer identity mismatch: request='${reviewRequest.reviewer.identity}', result='${reviewResult.reviewer.identity}'`
        );
      }

      // 11. reviewer session binding: request.reviewerSession == result.reviewerSession
      if (
        !reviewRequest.reviewer.session ||
        !reviewResult.reviewer.session ||
        reviewRequest.reviewer.session !== reviewResult.reviewer.session
      ) {
        throw new ArtifactValidationError(
          `Reviewer session mismatch: request='${reviewRequest.reviewer.session}', result='${reviewResult.reviewer.session}'`
        );
      }

      // 12. readOnlyRequired and readOnlyConfirmed
      const reqReadOnly = reviewRequest.reviewer.readOnlyRequired ?? reviewRequest.reviewer.readOnlyConfirmed;
      if (reqReadOnly !== true) {
        throw new ArtifactValidationError(
          `Review request readOnlyRequired must be true`
        );
      }
      if (reviewResult.reviewer.readOnlyConfirmed !== true) {
        throw new ArtifactValidationError(
          `Review result readOnlyConfirmed must be true`
        );
      }

      // Double Snapshot Fence: SNAPSHOT_FINAL (Architecture Decision CQ)
      const snapshotFinal = await computeAuthoritativeExecutionSnapshot(
        this.repoDir,
        run.taskId,
        { expectedHeadCommit: run.headCommit }
      );
      if (snapshotFinal.digest !== liveSnapshot.digest) {
        throw new ArtifactDigestMismatchError(
          `Execution snapshot drifted before completing consumeReviewPass (before ${liveSnapshot.digest}, final ${snapshotFinal.digest})`
        );
      }

      // Final Authority Fence (Architecture Decision CR)
      const finalAuthority = evaluateGitAuthority({
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
      if (!finalAuthority.ok) {
        throw new TransitionRejectedError(
          `Live Git authority drifted before completing consumeReviewPass: ${finalAuthority.stopExplanation}`
        );
      }

      return reviewResult;
    } finally {
      await this.artifactStore.releaseRunLock(runDir, ownerId).catch(() => {});
    }
  }

  // =========================================================================
  // Evidence-aware operations
  // =========================================================================

  /**
   * Records a validated test execution result artifact with STRUCTURE_VALID_EXTERNAL trust classification.
   *
   * Architecture Decision CU — NO BACKFILL AT PUBLIC EVIDENCE ENTRYPOINTS:
   * Caller MUST provide executionSnapshotVersion and executionSnapshotDigest.
   * Missing or unknown version, or missing/malformed digest → immediate reject.
   * The orchestrator never computes or fills missing snapshot identity on behalf of the caller.
   */
  public async recordTestResult(
    runId: string,
    testResult: {
      command: string;
      exitCode: number;
      status: "PASS" | "FAIL";
      startedAt: string;
      completedAt: string;
      logDigest: string;
      cycle?: number;
      boundTreeDigest?: string;
      taskId?: string;
      runId?: string;
      executionSnapshotVersion: string;
      executionSnapshotDigest: string;
    },
    options: RecordArtifactOptions = {}
  ): Promise<RecordArtifactResult> {
    // AD CU: Validate caller-provided snapshot identity before any live computation.
    if (!testResult.executionSnapshotVersion) {
      throw new ArtifactValidationError(
        "recordTestResult: executionSnapshotVersion is required; caller must provide the snapshot version bound to this evidence"
      );
    }
    if (testResult.executionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1) {
      throw new ArtifactValidationError(
        `recordTestResult: unknown executionSnapshotVersion '${testResult.executionSnapshotVersion}'; expected '${CINDY_EXECUTION_SNAPSHOT_V1}'`
      );
    }
    if (!testResult.executionSnapshotDigest) {
      throw new ArtifactValidationError(
        "recordTestResult: executionSnapshotDigest is required; caller must provide the snapshot digest bound to this evidence"
      );
    }
    if (!SNAPSHOT_DIGEST_REGEX.test(testResult.executionSnapshotDigest)) {
      throw new ArtifactValidationError(
        "recordTestResult: executionSnapshotDigest is malformed; expected 64-character lowercase hex string"
      );
    }
    return this.artifactStore.recordTestResult(
      runId,
      testResult,
      options
    );
  }

  /**
   * Computes authoritative live diff and tree digests, validates scope ownership,
   * and records a diff-manifest artifact with STRUCTURE_VALID_EXTERNAL trust classification.
   *
   * Architecture Decision CU — NO BACKFILL AT PUBLIC EVIDENCE ENTRYPOINTS:
   * Caller MUST provide executionSnapshotVersion and executionSnapshotDigest.
   * Missing or unknown version, or missing/malformed digest → immediate reject.
   * Three-way consistency (artifact snapshot, expected snapshot assertions, live snapshot) is
   * enforced in the store, but the artifact itself must not be missing snapshot identity.
   */
  public async recordDiffManifest(
    runId: string,
    options: {
      cycle?: number;
      expectedTreeDigest?: string;
      expectedBaseCommit?: string;
      expectedExecutionSnapshotVersion?: string;
      expectedExecutionSnapshotDigest?: string;
      executionSnapshotVersion: string;
      executionSnapshotDigest: string;
    }
  ): Promise<RecordArtifactResult> {
    // AD CU: Validate caller-provided snapshot identity before any live computation.
    if (!options.executionSnapshotVersion) {
      throw new ArtifactValidationError(
        "recordDiffManifest: executionSnapshotVersion is required; caller must provide the snapshot version bound to this evidence"
      );
    }
    if (options.executionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1) {
      throw new ArtifactValidationError(
        `recordDiffManifest: unknown executionSnapshotVersion '${options.executionSnapshotVersion}'; expected '${CINDY_EXECUTION_SNAPSHOT_V1}'`
      );
    }
    if (!options.executionSnapshotDigest) {
      throw new ArtifactValidationError(
        "recordDiffManifest: executionSnapshotDigest is required; caller must provide the snapshot digest bound to this evidence"
      );
    }
    if (!SNAPSHOT_DIGEST_REGEX.test(options.executionSnapshotDigest)) {
      throw new ArtifactValidationError(
        "recordDiffManifest: executionSnapshotDigest is malformed; expected 64-character lowercase hex string"
      );
    }
    return this.artifactStore.recordDiffManifest(runId, options);
  }

  /**
   * Records a validated review-request artifact with STRUCTURE_VALID_EXTERNAL trust classification.
   *
   * Architecture Decision CU — NO BACKFILL AT PUBLIC EVIDENCE ENTRYPOINTS:
   * Caller MUST provide executionSnapshotVersion and executionSnapshotDigest.
   * Missing or unknown version, or missing/malformed digest → immediate reject.
   * When called internally from startReview(), the caller explicitly computes the live snapshot
   * and passes it — this is the approved AD-CV "create internal input" pattern.
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
      executionSnapshotVersion: string;
      executionSnapshotDigest: string;
    }
  ): Promise<RecordArtifactResult> {
    // AD CU: Validate caller-provided snapshot identity before any live computation.
    if (!options.executionSnapshotVersion) {
      throw new ArtifactValidationError(
        "recordReviewRequest: executionSnapshotVersion is required; caller must provide the snapshot version bound to this evidence"
      );
    }
    if (options.executionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1) {
      throw new ArtifactValidationError(
        `recordReviewRequest: unknown executionSnapshotVersion '${options.executionSnapshotVersion}'; expected '${CINDY_EXECUTION_SNAPSHOT_V1}'`
      );
    }
    if (!options.executionSnapshotDigest) {
      throw new ArtifactValidationError(
        "recordReviewRequest: executionSnapshotDigest is required; caller must provide the snapshot digest bound to this evidence"
      );
    }
    if (!SNAPSHOT_DIGEST_REGEX.test(options.executionSnapshotDigest)) {
      throw new ArtifactValidationError(
        "recordReviewRequest: executionSnapshotDigest is malformed; expected 64-character lowercase hex string"
      );
    }
    return this.artifactStore.recordReviewRequest(runId, options);
  }

  /**
   * Advance from TESTING to READY_FOR_REVIEW upon validated test PASS and diff-manifest evidence.
   * Revalidates live Git authority on mutation boundary (Architecture Decision Z).
   */
  public async prepareForReview(runId: string): Promise<CindyRun> {
    return executeSemanticTransition(this.artifactStore, runId, {
      type: "prepareForReview",
    });
  }

  /**
   * Start review session, recording review-request binding reviewer identity.
   */
  public async startReview(
    runId: string,
    options?: {
      reviewer?: {
        identity: string;
        session?: string;
        readOnlyConfirmed: boolean;
        readOnlyRequired?: boolean;
      };
      executionSnapshotVersion?: string;
      executionSnapshotDigest?: string;
    }
  ): Promise<CindyRun> {
    const currentRun = await this.getRun(runId);
    if (currentRun.state !== CindyState.READY_FOR_REVIEW) {
      throw new TransitionRejectedError(
        `Cannot start review from state '${currentRun.state}'; run must be in READY_FOR_REVIEW`
      );
    }

    if (options?.reviewer) {
      const liveSnapshot = await this.computeCurrentExecutionSnapshot(currentRun.taskId);
      const version = options.executionSnapshotVersion ?? liveSnapshot.version;
      const digest = options.executionSnapshotDigest ?? liveSnapshot.digest;
      if (options.executionSnapshotVersion && options.executionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1) {
        throw new ArtifactValidationError(
          `startReview executionSnapshotVersion ('${options.executionSnapshotVersion}') does not match authoritative snapshot version ('${CINDY_EXECUTION_SNAPSHOT_V1}')`
        );
      }
      if (options.executionSnapshotDigest) {
        if (!SNAPSHOT_DIGEST_REGEX.test(options.executionSnapshotDigest)) {
          throw new ArtifactValidationError(
            "startReview executionSnapshotDigest must be a 64-character lowercase hex string"
          );
        }
        if (options.executionSnapshotDigest !== liveSnapshot.digest) {
          throw new ArtifactDigestMismatchError(
            `startReview executionSnapshotDigest ('${options.executionSnapshotDigest}') does not match authoritative snapshot digest ('${liveSnapshot.digest}')`
          );
        }
      }
      await this.recordReviewRequest(runId, {
        reviewer: options.reviewer,
        cycle: currentRun.currentCycle,
        executionSnapshotVersion: version,
        executionSnapshotDigest: digest,
      });
    }

    return executeSemanticTransition(this.artifactStore, runId, {
      type: "startReview",
      reviewer: options?.reviewer,
    });
  }

  /**
   * Record validated review result.
   * If verdict is PASS and all bindings match authoritative Git state:
   * Control Plane MVP seals privileged state FINAL_GATE: run remains in REVIEWING,
   * with immutable review-result evidence saved.
   * If verdict is FAIL, transitions to REPAIR_INITIALIZED.
   */
  public async recordValidatedReviewResult(
    runId: string,
    review: ReviewResultArtifact
  ): Promise<CindyRun> {
    // AD CU — NO BACKFILL AT PUBLIC EVIDENCE ENTRYPOINTS (Architecture Decision DF):
    // External evidence shape validation MUST happen before any Store access.
    // Caller must supply executionSnapshotVersion and executionSnapshotDigest.
    // Missing, unknown, or malformed → reject immediately, before Store.getRun or any other Store method.
    if (!review.executionSnapshotVersion) {
      throw new ArtifactValidationError(
        "recordValidatedReviewResult: executionSnapshotVersion is required; caller must provide the snapshot version bound to this evidence"
      );
    }
    if (review.executionSnapshotVersion !== CINDY_EXECUTION_SNAPSHOT_V1) {
      throw new ArtifactValidationError(
        `recordValidatedReviewResult: unknown executionSnapshotVersion '${review.executionSnapshotVersion}'; expected '${CINDY_EXECUTION_SNAPSHOT_V1}'`
      );
    }
    if (!review.executionSnapshotDigest) {
      throw new ArtifactValidationError(
        "recordValidatedReviewResult: executionSnapshotDigest is required; caller must provide the snapshot digest bound to this evidence"
      );
    }
    if (!SNAPSHOT_DIGEST_REGEX.test(review.executionSnapshotDigest)) {
      throw new ArtifactValidationError(
        "recordValidatedReviewResult: executionSnapshotDigest is malformed; expected 64-character lowercase hex string"
      );
    }

    // Store access happens ONLY after external evidence shape validation passes (Architecture Decision DF).
    const run = await this.getRun(runId);

    const liveSnapshot = await computeAuthoritativeExecutionSnapshot(
      this.repoDir,
      run.taskId,
      { expectedHeadCommit: run.headCommit }
    );

    // Now validate caller's claimed snapshot matches live authoritative snapshot.
    if (review.executionSnapshotDigest !== liveSnapshot.digest) {
      throw new ArtifactDigestMismatchError(
        `Review result executionSnapshotDigest ('${review.executionSnapshotDigest}') does not match live snapshot digest ('${liveSnapshot.digest}')`
      );
    }

    // effectiveReview carries caller's snapshot fields as-is (no backfill).
    const effectiveReview: ReviewResultArtifact = { ...review };

    // M01 / AD-BA: Preflight comparison against any existing on-disk review result for this cycle
    const existingReview = await this.artifactStore.readArtifact<ReviewResultArtifact>(
      runId,
      ArtifactKind.REVIEW_RESULT,
      effectiveReview.cycle
    );

    if (existingReview) {
      // Must compare on-disk artifact against incoming review
      const normalizedIncoming: ReviewResultArtifact = {
        ...effectiveReview,
        runId: run.runId,
        taskId: run.taskId,
        cycle: effectiveReview.cycle,
        executionSnapshotVersion: effectiveReview.executionSnapshotVersion,
        executionSnapshotDigest: effectiveReview.executionSnapshotDigest,
        trustClassification: "STRUCTURE_VALID_EXTERNAL",
      };
      if (canonicalizeJson(existingReview) !== canonicalizeJson(normalizedIncoming)) {
        throw new ConflictingArtifactError(
          `Conflicting review result artifact for cycle ${effectiveReview.cycle}: cannot overwrite existing ${existingReview.verdict} result with differing findings or verdict`
        );
      }

      // Architecture Decision BK / BO: identical existingReview is a duplicate candidate, NOT an early return bypass.
      // Must proceed to locked revalidation through recordReviewResult and executeSemanticTransition.
    }

    const isReplayingFailedCycle =
      run.state === CindyState.REPAIR_INITIALIZED &&
      review.cycle === run.currentCycle - 1 &&
      review.verdict === "FAIL" &&
      existingReview !== null;

    if (run.state !== CindyState.REVIEWING && !isReplayingFailedCycle) {
      throw new TransitionRejectedError(
        `Cannot record review result from state '${run.state}'; run must be in REVIEWING`
      );
    }

    if (review.reviewer?.readOnlyConfirmed !== true) {
      throw new ArtifactValidationError("Reviewer must confirm read-only mode");
    }

    if (
      !review.reviewer?.identity ||
      typeof review.reviewer.identity !== "string" ||
      review.reviewer.identity.trim().length === 0
    ) {
      throw new ArtifactValidationError("Reviewer identity must be a non-empty string");
    }

    if (
      !review.reviewer?.session ||
      typeof review.reviewer.session !== "string" ||
      review.reviewer.session.trim().length === 0
    ) {
      throw new ArtifactValidationError("Reviewer session must be a non-empty string");
    }

    // Must bind to genuine existing review-request
    const reviewRequest = await this.readValidatedEvidence<ReviewRequestArtifact>(
      runId,
      ArtifactKind.REVIEW_REQUEST,
      { cycle: review.cycle }
    );

    if (
      !reviewRequest.reviewer?.identity ||
      typeof reviewRequest.reviewer.identity !== "string" ||
      reviewRequest.reviewer.identity.trim().length === 0
    ) {
      throw new ArtifactValidationError("Review request reviewer identity must be a non-empty string");
    }

    if (
      !reviewRequest.reviewer?.session ||
      typeof reviewRequest.reviewer.session !== "string" ||
      reviewRequest.reviewer.session.trim().length === 0
    ) {
      throw new ArtifactValidationError("Review request reviewer session must be a non-empty string");
    }

    if (review.reviewer.identity !== reviewRequest.reviewer.identity) {
      throw new ArtifactValidationError(
        `Review result reviewer identity ('${review.reviewer.identity}') does not match review request reviewer ('${reviewRequest.reviewer.identity}')`
      );
    }

    if (review.reviewer.session !== reviewRequest.reviewer.session) {
      throw new ArtifactValidationError(
        `Review result reviewer session mismatch: expected '${reviewRequest.reviewer.session}', got '${review.reviewer.session}'`
      );
    }

    // Validate bindings
    if (effectiveReview.runId !== run.runId || reviewRequest.runId !== run.runId) {
      throw new ArtifactValidationError(
        `Review result runId mismatch: payload has '${effectiveReview.runId}', expected '${run.runId}'`
      );
    }

    if (effectiveReview.taskId !== run.taskId || reviewRequest.taskId !== run.taskId) {
      throw new ArtifactValidationError(
        `Review result taskId mismatch: payload has '${effectiveReview.taskId}', expected '${run.taskId}'`
      );
    }

    if (effectiveReview.cycle !== reviewRequest.cycle || (!isReplayingFailedCycle && effectiveReview.cycle !== run.currentCycle)) {
      throw new ArtifactValidationError(
        `Review result cycle mismatch: payload has cycle ${effectiveReview.cycle}, expected ${run.currentCycle}`
      );
    }

    const reviewBase = effectiveReview.reviewedBaseCommit;
    if (reviewBase !== run.baseCommit || reviewRequest.baseCommit !== run.baseCommit) {
      throw new ArtifactValidationError(
        `Review result base commit mismatch: payload has '${reviewBase}', expected '${run.baseCommit}'`
      );
    }

    const currentTreeDigest = await computeTreeDigest(this.repoDir);
    if (effectiveReview.reviewedTreeDigest !== currentTreeDigest || reviewRequest.boundTreeDigest !== currentTreeDigest) {
      throw new ArtifactDigestMismatchError(
        `Review result reviewedTreeDigest ('${effectiveReview.reviewedTreeDigest}') does not match authoritative working tree digest ('${currentTreeDigest}')`
      );
    }

    const currentDiffDigest = await computeDiffDigest(this.repoDir);
    if (effectiveReview.reviewedDiffDigest !== currentDiffDigest) {
      throw new ArtifactDigestMismatchError(
        `Review result reviewedDiffDigest ('${effectiveReview.reviewedDiffDigest}') does not match authoritative diff digest ('${currentDiffDigest}')`
      );
    }

    await this.artifactStore.recordReviewResult(runId, effectiveReview);

    const normalizedReview: ReviewResultArtifact = {
      ...effectiveReview,
      runId: run.runId,
      taskId: run.taskId,
      cycle: effectiveReview.cycle,
      trustClassification: "STRUCTURE_VALID_EXTERNAL",
    };

    if (effectiveReview.verdict === "PASS") {
      // Control Plane MVP (Decision A): Review PASS does NOT advance to FINAL_GATE.
      // Privileged states remain sealed. Run remains in REVIEWING with review-result saved.
      return executeSemanticTransition(this.artifactStore, runId, {
        type: "recordValidatedReviewResult",
        verdict: "PASS",
        review: normalizedReview,
        expectedVersion: run.version,
      });
    }

    // On FAIL: enter REPAIR_INITIALIZED and advance currentCycle for repair loop
    return executeSemanticTransition(this.artifactStore, runId, {
      type: "recordValidatedReviewResult",
      verdict: "FAIL",
      review: normalizedReview,
      expectedVersion: run.version,
    });
  }

  /**
   * Records validated review PASS evidence.
   * State remains in REVIEWING in Control Plane MVP (privileged states sealed).
   * Validates bindings and throws if verdict is not PASS.
   */
  public async recordReviewPass(
    runId: string,
    review: ReviewResultArtifact
  ): Promise<CindyRun> {
    if (review.verdict !== "PASS") {
      throw new ArtifactValidationError(
        `recordReviewPass requires verdict 'PASS', but got '${review.verdict}'`
      );
    }
    return this.recordValidatedReviewResult(runId, review);
  }

  /**
   * Record validated final gate result.
   *
   * SEALED IN CONTROL PLANE MVP (Decision A):
   * This method is structurally present for future Safe Closeout phase,
   * but is NOT executable in the current MVP. Any call to this method
   * from any public API caller is unconditionally rejected with
   * FEATURE_NOT_AVAILABLE_IN_CONTROL_PLANE_MVP.
   *
   * Rationale: The current MVP has no trusted Gate Executor.
   * Gate automation will be explicitly opened in a future phase with
   * proper trust and evidence architecture.
   */
  public async recordValidatedFinalGateResult(
    _runId: string,
    _gateResult: {
      verdict: "PASS" | "FAIL";
      boundTreeDigest: string;
      reasons?: string[];
    }
  ): Promise<CindyRun> {
    throw new TransitionRejectedError(
      "FEATURE_NOT_AVAILABLE_IN_CONTROL_PLANE_MVP: recordValidatedFinalGateResult() is sealed in this phase. " +
      "Gate automation is a non-goal of Control Plane MVP. " +
      "Privileged states FINAL_GATE and READY_TO_COMMIT cannot be entered via public API."
    );
  }

  /**
   * Record validated closeout artifact and transition to CLOSED.
   *
   * SEALED IN CONTROL PLANE MVP (Decision A):
   * This method is structurally present for the future Safe Closeout phase,
   * but is NOT executable in the current MVP.
   *
   * Rationale:
   * - The MVP has no trusted commit/push mechanism.
   * - The safe closeout must establish reviewed pre-commit tree ↔ resulting commit tree
   *   ↔ git receipt mapping — this requires a future dedicated phase.
   * - Closeout digest mapping (M02) must not rely on pre/post-commit HEAD comparison.
   *
   * Deferred to Safe Closeout phase.
   */
  public async recordCloseout(
    _runId: string,
    _closeoutData?: Partial<CloseoutArtifact>
  ): Promise<CindyRun> {
    throw new TransitionRejectedError(
      "FEATURE_NOT_AVAILABLE_IN_CONTROL_PLANE_MVP: recordCloseout() is sealed in this phase. " +
      "Automated closeout, commit, and push are non-goals of Control Plane MVP. " +
      "Privileged states COMMITTING, PUSHING, and CLOSED cannot be entered via public API."
    );
  }

  public async recordArtifact<T extends object>(
    runId: string,
    artifactType: string,
    data: T,
    options: RecordArtifactOptions = {}
  ): Promise<RecordArtifactResult> {
    if (artifactType === ArtifactKind.RUN) {
      throw new ArtifactValidationError(
        `Artifact kind 'run' cannot be recorded via recordArtifact; run state is managed strictly by orchestrator operations`
      );
    }

    const currentTree = await computeTreeDigest(this.repoDir);

    const record = data as Record<string, unknown>;
    const declaredTree = (record.boundTreeDigest ??
      record.reviewedTreeDigest ??
      record.finalTreeDigest ??
      record.treeDigest) as string | undefined;

    if (declaredTree && declaredTree !== currentTree) {
      throw new ArtifactDigestMismatchError(
        `Artifact declared tree digest ('${declaredTree}') does not match authoritative working tree digest ('${currentTree}')`
      );
    }

    return this.artifactStore.recordArtifact(runId, artifactType, data, {
      ...options,
      expectedTreeDigest: options.expectedTreeDigest ?? currentTree,
    });
  }

  public async readArtifact<T = unknown>(
    runId: string,
    artifactType: string,
    cycle?: number
  ): Promise<T | null> {
    return this.artifactStore.readArtifact<T>(runId, artifactType, cycle);
  }

  public async reconcile(): Promise<ReconcileResult> {
    return reconcileCurrentState({ repoDir: this.repoDir });
  }

  public async computeCurrentTreeDigest(): Promise<string> {
    return computeTreeDigest(this.repoDir);
  }

  public async computeCurrentExecutionSnapshot(
    taskIdOrOptions?: string | ComputeExecutionSnapshotOptions,
    options?: { expectedHeadCommit?: string }
  ): Promise<ExecutionSnapshotResult> {
    if (typeof taskIdOrOptions === "string") {
      return computeAuthoritativeExecutionSnapshot(this.repoDir, taskIdOrOptions, options);
    }
    return computeExecutionSnapshot(this.repoDir, taskIdOrOptions);
  }

  public async computeCurrentDiffDigest(): Promise<string> {
    return computeDiffDigest(this.repoDir);
  }

  public async checkScopeOwnership(allowedScope: string[]): Promise<DirtyTreeOwnershipResult> {
    const status = getGitStatus(this.repoDir);
    return checkDirtyTreeOwnership(allowedScope, status.dirtyFiles, this.repoDir);
  }

  public async getStatus(runId?: string) {
    const branch = getGitBranch(this.repoDir);
    const headCommit = getGitHead(this.repoDir);
    const upstream = getGitUpstream(this.repoDir);
    const status = getGitStatus(this.repoDir);

    let run: CindyRun | null = null;
    if (runId) {
      run = await this.artifactStore.readArtifact<CindyRun>(runId, ArtifactKind.RUN);
    }

    const treeDigest = await computeTreeDigest(this.repoDir);
    const liveSnapshot = run
      ? await computeAuthoritativeExecutionSnapshot(this.repoDir, run.taskId, {
          expectedHeadCommit: run.headCommit,
        })
      : await computeExecutionSnapshot(this.repoDir);

    return {
      branch,
      headCommit,
      upstream,
      isClean: status.isClean,
      dirtyFiles: status.dirtyFiles,
      treeDigest,
      executionSnapshotVersion: CINDY_EXECUTION_SNAPSHOT_V1,
      executionSnapshotDigest: liveSnapshot.digest,
      run,
    };
  }
}
