export { ProductSchema } from './product-schema.js';
export type {
  Product,
  IssueTracker,
  CodeRepo,
  WorkflowStage,
  Specialist,
} from './product-schema.js';
export {
  parseProductConfig,
  parseProductConfigFromFile,
  ProductConfigError,
} from './product-parser.js';
