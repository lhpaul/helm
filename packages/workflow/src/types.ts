/**
 * The 9 canonical workflow sub-stages for Helm v0.
 * This is the single source of truth — @helm/shared imports from here.
 */
export const WORKFLOW_STAGES = [
  'discovery',
  'spec-draft',
  'spec-ready',
  'plan-draft',
  'plan-ready',
  'in-development',
  'code-review',
  'remediation',
  'released',
] as const;

export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

/**
 * Thrown when a requested stage transition is not permitted.
 * Carries `from` and `to` as typed properties for programmatic handling.
 */
export class WorkflowTransitionError extends Error {
  constructor(
    message: string,
    public readonly from: WorkflowStage,
    public readonly to: WorkflowStage,
  ) {
    super(message);
    this.name = 'WorkflowTransitionError';
  }
}
