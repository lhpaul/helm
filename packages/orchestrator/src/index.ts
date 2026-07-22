export type {
  IAgentRuntime,
  SpawnParams,
  AgentSession,
  AgentStatus,
  AgentMessage,
  AgentResult,
} from './runtime.js';

export { MockAgentRuntime } from './runtimes/mock.js';
export type { MockScript, MockScriptMessage } from './runtimes/mock.js';

export { ClaudeCodeRuntime } from './runtimes/claude-code.js';
export type { SubprocessLike, SpawnFn } from './runtimes/claude-code.js';

export { CodexRuntime } from './runtimes/codex.js';

export { dispatchStageHandler, resolveSpecialistId } from './dispatcher.js';
export type { DispatchInput, DispatchResult, DispatchOptions } from './dispatcher.js';
export {
  decisionMatchesLatestAdjudication,
  parseHumanProductDecisionComment,
  suppressSettledConflicts,
} from './review-loop/adjudication.js';
export type {
  AdjudicationConflict,
  NormalizedProductDecision,
  StoredResolvedProductDecision,
} from './review-loop/adjudication.js';

// Product-readiness gate (ADR-026)
export { checkProductReadiness } from './readiness.js';
export type { ReadinessResult, MissingContextEntry } from './readiness.js';

export type {
  ItemTransitionFn,
  SpecWriterResult,
  SpecPublishOptions,
} from './specialists/spec-writer.js';
export {
  buildSpecWriterPrompt,
  buildSpecWriterParams,
  handleSpecWriterResult,
} from './specialists/spec-writer.js';

export {
  fetchProductContext,
  materializeProductContext,
  parseGitHubRepoUrl,
  AGENT_INSTRUCTION_FILES,
} from './specialists/fetch-product-context.js';
export type {
  ProductContext,
  MaterializedProductContext,
  FetchFn,
} from './specialists/fetch-product-context.js';

export { publishSpecToPR } from './specialists/spec-publisher.js';
export type {
  PublishSpecOpts,
  PublishSpecResult,
  RunGit,
  RunGh,
} from './specialists/spec-publisher.js';

// Early-stage remediators (ADR-024)
export {
  runEarlyRemediation,
  buildEarlyRemediatorParams,
  buildEarlyRemediatorPrompt,
  EARLY_REMEDIATION_TIMEOUT_MS,
} from './specialists/early-remediator.js';
export type {
  EarlyRemediatorKind,
  EarlyRemediationResult,
  RunEarlyRemediationParams,
} from './specialists/early-remediator.js';
export {
  buildSpecRemediatorPrompt,
  buildSpecRemediatorParams,
  runSpecRemediation,
} from './specialists/spec-remediator.js';
export {
  buildPlanRemediatorPrompt,
  buildPlanRemediatorParams,
  runPlanRemediation,
} from './specialists/plan-remediator.js';
