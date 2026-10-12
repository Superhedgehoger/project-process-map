import { CindyState, TransitionRejectedError, isPrivilegedState } from "./types.ts";

const PAUSE_STATES: ReadonlySet<CindyState> = new Set([
  CindyState.PRODUCT_DECISION_REQUIRED,
  CindyState.BLOCKED,
  CindyState.CONTRACT_CONFLICT,
  CindyState.DIRTY_TREE_UNEXPLAINED,
  CindyState.GIT_SAFETY_STOP,
  CindyState.MIGRATION_OR_SECURITY_AMBIGUITY,
]);

/**
 * Valid target states from each source state.
 * Any non-pause state can transition to any pause state if triggered.
 * Privileged states (FINAL_GATE, READY_TO_COMMIT, COMMITTING, PUSHING, CLOSED, NEXT_TASK_SELECTED)
 * are sealed in Control Plane MVP (Decision A) and have no executable transition path.
 */
const BASE_TRANSITIONS: Record<CindyState, CindyState[]> = {
  [CindyState.RECONCILING]: [
    CindyState.TASK_INITIALIZED,
    CindyState.READY_FOR_BUILDER,
    CindyState.BUILDING,
    CindyState.BUILDER_COMPLETE,
    CindyState.TESTING,
    CindyState.READY_FOR_REVIEW,
    CindyState.REVIEWING,
    CindyState.REPAIR_INITIALIZED,
    CindyState.REPAIR_BUILDING,
  ],
  [CindyState.TASK_INITIALIZED]: [CindyState.READY_FOR_BUILDER],
  [CindyState.READY_FOR_BUILDER]: [CindyState.BUILDING],
  [CindyState.BUILDING]: [CindyState.BUILDER_COMPLETE, CindyState.TESTING],
  [CindyState.BUILDER_COMPLETE]: [CindyState.TESTING],
  [CindyState.TESTING]: [CindyState.READY_FOR_REVIEW],
  [CindyState.READY_FOR_REVIEW]: [CindyState.REVIEWING],
  [CindyState.REVIEWING]: [
    CindyState.REPAIR_INITIALIZED, // On review FAIL. Review PASS remains REVIEWING in Control Plane MVP
  ],
  [CindyState.REPAIR_INITIALIZED]: [CindyState.REPAIR_BUILDING],
  [CindyState.REPAIR_BUILDING]: [CindyState.TESTING],
  [CindyState.FINAL_GATE]: [], // Sealed in Control Plane MVP (Decision A)
  [CindyState.READY_TO_COMMIT]: [], // Sealed in Control Plane MVP (Decision A)
  [CindyState.COMMITTING]: [], // Sealed in Control Plane MVP (Decision A)
  [CindyState.PUSHING]: [], // Sealed in Control Plane MVP (Decision A)
  [CindyState.CLOSED]: [], // Sealed in Control Plane MVP (Decision A)
  [CindyState.NEXT_TASK_SELECTED]: [], // Sealed in Control Plane MVP (Decision A)

  // Pause states CANNOT transition to any non-pause state (including RECONCILING) via generic transition (Decision K)
  // Exit from pause requires explicit, controlled resumeRun()
  [CindyState.PRODUCT_DECISION_REQUIRED]: [],
  [CindyState.BLOCKED]: [],
  [CindyState.CONTRACT_CONFLICT]: [],
  [CindyState.DIRTY_TREE_UNEXPLAINED]: [],
  [CindyState.GIT_SAFETY_STOP]: [],
  [CindyState.MIGRATION_OR_SECURITY_AMBIGUITY]: [],
};

export const EVIDENCE_GATED_STATES: ReadonlySet<CindyState> = new Set([
  CindyState.READY_FOR_REVIEW,
  CindyState.REVIEWING,
  CindyState.FINAL_GATE,
  CindyState.READY_TO_COMMIT,
  CindyState.CLOSED,
]);

export function isEvidenceGatedState(state: CindyState): boolean {
  return EVIDENCE_GATED_STATES.has(state);
}

export function isPauseState(state: CindyState): boolean {
  return PAUSE_STATES.has(state);
}

export function isValidCindyState(state: string): state is CindyState {
  return Object.values(CindyState).includes(state as CindyState);
}

/**
 * Validates whether transition from `from` to `to` is permitted.
 * If `from === to`, returns true (idempotent replay).
 */
export function canTransition(from: CindyState, to: CindyState): boolean {
  if (from === to) {
    return true;
  }
  // Architecture Decision A: Privileged states are sealed in Control Plane MVP
  if (isPrivilegedState(to)) {
    return false;
  }
  // Architecture Decision K & O: Pause states can NEVER transition via generic transition
  // (neither to non-pause states nor to other pause states). Pause reason is immutable until resume.
  if (isPauseState(from)) {
    return false;
  }
  // Any non-pause state can transition into any pause state
  if (isPauseState(to)) {
    return true;
  }

  const allowed = BASE_TRANSITIONS[from];
  if (!allowed) {
    return false;
  }
  return allowed.includes(to);
}

export function validateTransition(
  from: CindyState,
  to: CindyState,
  options: { allowEvidenceGated?: boolean | undefined } = {}
): void {
  if (!isValidCindyState(from)) {
    throw new TransitionRejectedError(`Unknown source state: ${from}`);
  }
  if (!isValidCindyState(to)) {
    throw new TransitionRejectedError(`Unknown target state: ${to}`);
  }
  if (from === to) {
    return;
  }
  // Architecture Decision A: Privileged states are sealed in Control Plane MVP
  if (isPrivilegedState(to)) {
    throw new TransitionRejectedError(
      `Transition to privileged state '${to}' is sealed and prohibited in Control Plane MVP`
    );
  }
  if (isPauseState(from)) {
    if (isPauseState(to)) {
      throw new TransitionRejectedError(
        `Generic transition from pause state '${from}' to pause state '${to}' is rejected; pause reason is immutable until successful resume`
      );
    }
    throw new TransitionRejectedError(
      `Generic transition from pause state '${from}' to '${to}' is rejected; must use explicit controlled resumeRun()`
    );
  }
  if (!options.allowEvidenceGated && isEvidenceGatedState(to)) {
    throw new TransitionRejectedError(
      `Direct unverified transition to dangerous state '${to}' rejected; must use dedicated evidence-aware operation`
    );
  }
  if (!canTransition(from, to)) {
    throw new TransitionRejectedError(`Illegal state transition rejected: ${from} -> ${to}`);
  }
}
