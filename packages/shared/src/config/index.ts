export { ProductSchema } from './product-schema.js';
export type { Product, IssueTracker, CodeRepo, Specialist } from './product-schema.js';
export {
  parseProductConfig,
  parseProductConfigFromFile,
  ProductConfigError,
} from './product-parser.js';
// WorkflowStage and WORKFLOW_STAGES originate in @helm/workflow; re-exported
// here so consumers of @helm/shared don't need to know the source package.
export { WORKFLOW_STAGES, type WorkflowStage } from '@helm/workflow';
