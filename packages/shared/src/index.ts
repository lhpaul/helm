// tipos y utilidades compartidas entre @helm/api y @helm/web
export const HELM_VERSION = '0.0.0';
export * from './config/index.js';
// Artifact branch naming convention — shared between orchestrator (spec-publisher,
// plan-publisher) and API (webhook handler).
export {
  SPEC_BRANCH_PREFIX,
  specBranchName,
  PLAN_BRANCH_PREFIX,
  planBranchName,
  IMPL_BRANCH_PREFIX,
  implBranchName,
  parseArtifactBranch,
} from './spec-branch.js';
export type { ArtifactBranchKind } from './spec-branch.js';
