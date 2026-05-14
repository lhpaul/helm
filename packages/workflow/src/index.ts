export { WORKFLOW_STAGES, WorkflowTransitionError } from './types.js';
export type { WorkflowStage } from './types.js';
export {
  INITIAL_STAGE,
  canTransition,
  getValidNextStages,
  validateTransition,
  isWorkflowStage,
} from './state-machine.js';
