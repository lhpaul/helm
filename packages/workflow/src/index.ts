export { WORKFLOW_STAGES, WorkflowTransitionError } from './types.js';
export type { WorkflowStage } from './types.js';
export {
  INITIAL_STAGE,
  canTransition,
  getValidNextStages,
  validateTransition,
  isWorkflowStage,
  nativeStateTypeForStage,
} from './state-machine.js';
export type { NativeStateType } from './state-machine.js';
