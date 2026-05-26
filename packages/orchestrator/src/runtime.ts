/**
 * IAgentRuntime — uniform interface for spawning AI agent sessions.
 *
 * Design principles (see ADR-005 for full rationale):
 * - spawn() is async and returns an AgentSession immediately; the agent
 *   runs in the background.
 * - onMessage() uses a callback rather than AsyncIterator so the session
 *   can buffer messages before any consumer is registered, and because
 *   mid-flight inspection/injection doesn't fit the pull-based iterator model.
 * - send() enables mid-flight instructions without coupling to a specific
 *   runtime's stdin/IPC mechanism.
 * - wait() returns a single Promise<AgentResult> — callers that only care
 *   about the final outcome don't need to consume the message stream.
 * - The interface deliberately avoids Claude Code-isms (no --print flags,
 *   no stream-json format, no Bun-specific APIs) so it can be backed by
 *   any runtime: Claude Code spawn, Anthropic API, local Ollama, etc.
 */

export interface IAgentRuntime {
  spawn(params: SpawnParams): Promise<AgentSession>;
}

export interface SpawnParams {
  /** 'spec-writer', 'plan-writer', 'implementer', etc. */
  specialistId: string;
  /** Initial prompt sent to the agent. */
  prompt: string;
  /** Absolute path to the working directory where the agent reads/writes files. */
  workdir: string;
  /** Which Product this run belongs to. */
  productSlug: string;
  /** Which Item this run is processing. */
  externalId: string;
  /** Optional runtime hint, e.g. 'claude-sonnet-4-6'. */
  model?: string;
  /**
   * Claude Code permission mode for this spawn.
   * - `'acceptEdits'` (default): auto-accepts file writes; requires approval for Bash.
   * - `'bypassPermissions'`: skips all permission prompts (needed for the implementer
   *   which runs arbitrary code in its workspace).
   */
  permissionMode?: 'acceptEdits' | 'bypassPermissions';
  /**
   * Per-spawn timeout override in milliseconds.
   * Overrides the runtime-level `timeoutMs` option for this specific session.
   */
  timeoutMs?: number;
  /**
   * Additional environment variables to set in the agent subprocess.
   * Merged on top of the base subprocess environment.
   * The base environment is derived from `process.env` with GITHUB_TOKEN and
   * GH_TOKEN scrubbed (so leaked credentials cannot be accessed from tool calls).
   */
  env?: Record<string, string>;
}

export interface AgentSession {
  readonly id: string;
  readonly status: AgentStatus;
  /** Register a callback invoked for each message the agent emits. */
  onMessage(handler: (m: AgentMessage) => void): void;
  /** Send a mid-flight instruction to the running agent. */
  send(instruction: string): Promise<void>;
  /** Cancel the running session. Resolves when the session has stopped. */
  cancel(): Promise<void>;
  /** Resolves when the session reaches a terminal state (done/error/cancelled). */
  wait(): Promise<AgentResult>;
}

export type AgentStatus = 'spawning' | 'running' | 'paused' | 'done' | 'error' | 'cancelled';

export interface AgentMessage {
  role: 'agent' | 'tool' | 'system';
  content: string;
  /** Cost attributed to this message turn, if known. */
  costUsd?: number;
  /** ISO 8601. */
  timestamp: string;
}

export interface AgentResult {
  status: 'done' | 'error' | 'cancelled';
  /** Last substantive output from the agent (may be empty on error/cancel). */
  finalOutput: string;
  /** Sum of all costUsd values across messages in this session. */
  totalCostUsd: number;
  durationMs: number;
}
