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

export { dispatchStageHandler } from './dispatcher.js';
export type { DispatchInput, DispatchResult, DispatchOptions } from './dispatcher.js';

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

export { fetchProductContext, parseGitHubRepoUrl } from './specialists/fetch-product-context.js';
export type { ProductContext, FetchFn } from './specialists/fetch-product-context.js';

export { publishSpecToPR } from './specialists/spec-publisher.js';
export type {
  PublishSpecOpts,
  PublishSpecResult,
  RunGit,
  RunGh,
} from './specialists/spec-publisher.js';
