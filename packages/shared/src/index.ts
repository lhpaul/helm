// tipos y utilidades compartidas entre @helm/api y @helm/web
export const HELM_VERSION = '0.0.0';
export * from './config/index.js';
// Spec branch naming convention — shared between orchestrator (spec-publisher) and API (webhook handler).
export { SPEC_BRANCH_PREFIX, specBranchName, parseSpecBranch } from './spec-branch.js';
