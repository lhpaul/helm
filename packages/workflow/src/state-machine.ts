import { WORKFLOW_STAGES, WorkflowStage, WorkflowTransitionError } from './types.js';

// ── Initial stage ─────────────────────────────────────────────────────────────

/** Every new item enters the workflow here. */
export const INITIAL_STAGE: WorkflowStage = 'discovery';

// ── Transition map ────────────────────────────────────────────────────────────
//
// Forward edges follow the primary flow; backward edges allow bounded
// retries and rework within the workflow without skipping stages:
//
//   discovery → spec-draft → spec-ready → plan-draft → plan-ready
//            ← (discovery)  ← (spec-draft)  ← (spec-ready)  ← (plan-draft)
//
//   plan-ready → in-development → code-review → merged → released (terminal)
//                ← (plan-draft)              ↗ ↘ remediation ↗
//
// The code-review → released edge was removed in ADR-032: approved review now
// lands in `merged` (impl PR merged), and `released` (shipped to users) is
// reached only via the release trigger (manual endpoint or release.published
// webhook). The merged → released edge always exists; whether a product fires
// the trigger is gated by workflow.final_stage, not by the state machine.

const VALID_TRANSITIONS: Record<WorkflowStage, readonly WorkflowStage[]> = {
  discovery: ['spec-draft'],
  'spec-draft': ['spec-ready', 'discovery'], // fwd | back if story needs rediscovery
  'spec-ready': ['plan-draft', 'spec-draft'], // fwd | back to reopen spec
  'plan-draft': ['plan-ready', 'spec-ready'], // fwd | back if spec is incomplete
  'plan-ready': ['in-development', 'plan-draft'], // fwd | back to revise plan before dev
  'in-development': ['code-review'],
  'code-review': ['in-development', 'remediation', 'merged'], // minor changes | CRITICAL/HIGH | approved → merged
  remediation: ['code-review'], // after fix, return to review
  merged: ['released'], // PR merged → shipped (gated by trigger + workflow.final_stage)
  released: [], // terminal — no outgoing transitions
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns true if the transition from → to is explicitly permitted.
 */
export function canTransition(from: WorkflowStage, to: WorkflowStage): boolean {
  return (VALID_TRANSITIONS[from] as WorkflowStage[]).includes(to);
}

/**
 * Returns the list of stages reachable from the given stage.
 * Returns an empty array for terminal stages (e.g. 'released').
 * Returns a copy so callers cannot mutate the internal transition map.
 */
export function getValidNextStages(from: WorkflowStage): readonly WorkflowStage[] {
  return [...VALID_TRANSITIONS[from]];
}

/**
 * Throws WorkflowTransitionError if the transition is not permitted.
 * The error message lists the valid next stages for actionable feedback.
 */
export function validateTransition(from: WorkflowStage, to: WorkflowStage): void {
  if (!canTransition(from, to)) {
    const valid = getValidNextStages(from);
    const validStr = valid.length > 0 ? valid.map((s) => `'${s}'`).join(', ') : 'none';
    throw new WorkflowTransitionError(
      `Cannot transition from '${from}' to '${to}'. Valid next stages: [${validStr}]`,
      from,
      to,
    );
  }
}

/**
 * Runtime type guard — validates that an arbitrary string is a known WorkflowStage.
 * Use this at API boundaries before calling canTransition / validateTransition.
 */
export function isWorkflowStage(s: string): s is WorkflowStage {
  return (WORKFLOW_STAGES as ReadonlyArray<string>).includes(s);
}
