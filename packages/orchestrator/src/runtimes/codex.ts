import type {
  AgentMessage,
  AgentResult,
  AgentSession,
  AgentStatus,
  IAgentRuntime,
  SpawnParams,
} from '../runtime.js';
import { GIT_CREDENTIAL_KEYS, buildSubprocessEnv, defaultSpawn } from './_env.js';
import type { SpawnFn, SubprocessLike } from './_env.js';

/**
 * CodexRuntime — structural sibling of ClaudeCodeRuntime that spawns the OpenAI
 * Codex CLI in non-interactive (headless) mode. Motivated by Anthropic moving
 * `claude -p` off the subscription onto metered API billing; Codex headless runs
 * against the ChatGPT subscription, leaving the marginal cost ~$0 (see ADR-021).
 *
 * ── Discovery findings (Codex CLI v0.133.0, captured 2026-05-29) ─────────────
 *
 * Headless command: `codex exec [PROMPT]` (alias `codex e`). Non-interactive —
 *   there are NO interactive approval prompts in exec mode, so the implementer
 *   can run bash autonomously. This was verified end-to-end: under
 *   `--sandbox workspace-write` the agent ran `printf … > file`, `ls`, and
 *   `git status` without any prompt. → No specialist needs to be excluded.
 *
 * Streaming: `--json` emits one JSON object per line (JSONL) on stdout. Observed
 *   event types:
 *     {"type":"thread.started","thread_id":"…"}                  (informational)
 *     {"type":"turn.started"}                                    (informational)
 *     {"type":"item.started","item":{…}}                         (item begins)
 *     {"type":"item.completed","item":{…}}                       (item finished)
 *     {"type":"turn.completed","usage":{input_tokens,…}}         (TERMINAL ok)
 *     {"type":"turn.failed","error":{"message":"…"}}             (TERMINAL error)
 *     {"type":"error","message":"…"}                             (error detail)
 *   Item types we act on:
 *     {id,type:"agent_message",text}                  → role:'agent'
 *     {id,type:"command_execution",command,exit_code} → role:'tool'
 *   stderr carries non-JSON noise ("Reading additional input from stdin…", MCP
 *   transport warnings, "Shell cwd was reset …"); stdout is pure JSONL.
 *
 * Exit code: codex exec exits 0 even on a failed turn, so the verdict MUST come
 *   from the terminal event (turn.completed vs turn.failed), never the exit code.
 *
 * Permission/sandbox model: `-s/--sandbox <read-only|workspace-write|
 *   danger-full-access>` plus `--dangerously-bypass-approvals-and-sandbox`.
 *   Mapped from SpawnParams.permissionMode:
 *     'acceptEdits'       → --sandbox workspace-write  (writes scoped to workspace)
 *     'bypassPermissions' → --dangerously-bypass-approvals-and-sandbox (full access)
 *
 * Cost: the output reports token usage only (turn.completed.usage), never a USD
 *   figure, because subscription runs are billed in bulk. AgentResult.totalCostUsd
 *   is therefore 0 — meaning "covered by the ChatGPT subscription", NOT that the
 *   run was free in any absolute sense.
 *
 * Credential scrubbing: subscription auth lives on disk in `~/.codex/auth.json`
 *   (CODEX_HOME) — that is required and left intact. The env-borne OpenAI/Codex
 *   credentials are scrubbed from the subprocess so (a) a compromised agent can't
 *   exfiltrate them via a tool call and (b) subscription auth is used rather than
 *   metered API billing. Git tokens are scrubbed too (same as ClaudeCodeRuntime).
 */

/** Default timeout: 10 minutes. Implementer/reviewer runs are longer than spec. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Credentials scrubbed from the Codex subprocess env: git tokens (shared with
 * ClaudeCodeRuntime) plus the OpenAI/Codex API keys and access token. Stripping
 * the latter forces subscription auth (auth.json on disk) and prevents leaking
 * an API key into the agent's tool sandbox. The on-disk token (CODEX_HOME) is
 * intentionally NOT scrubbed — it is how subscription auth works.
 */
const CODEX_SCRUB_KEYS = [
  ...GIT_CREDENTIAL_KEYS,
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
] as const;

// ── JSONL event shapes (minimal — only fields we act on) ──────────────────────

type CodexAgentMessageItem = {
  type: 'agent_message';
  text: string;
};

type CodexCommandExecutionItem = {
  type: 'command_execution';
  command: string;
  exit_code: number | null;
  status: string;
};

type CodexItemEvent = {
  type: 'item.completed' | 'item.started';
  item: { type: string } & Record<string, unknown>;
};

type CodexTurnFailed = {
  type: 'turn.failed';
  error?: { message?: string };
};

// ── Session ───────────────────────────────────────────────────────────────────

class CodexSession implements AgentSession {
  readonly id: string;
  status: AgentStatus = 'spawning';

  private readonly handlers: Array<(m: AgentMessage) => void> = [];
  private readonly resultPromise: Promise<AgentResult>;
  private resolveResult!: (r: AgentResult) => void;
  private settled = false;
  private readonly startMs = Date.now();
  /** Text of the most recent agent_message — used as finalOutput on success. */
  private lastAgentText = '';

  constructor(
    private readonly proc: SubprocessLike,
    private readonly params: SpawnParams,
    private readonly timeoutMs: number,
  ) {
    void this.params;
    this.id = `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.resultPromise = new Promise<AgentResult>((resolve) => {
      this.resolveResult = resolve;
    });
  }

  onMessage(handler: (m: AgentMessage) => void): void {
    this.handlers.push(handler);
  }

  /**
   * mid-flight send is not supported in one-shot (`codex exec`) mode — same
   * constraint as ClaudeCodeRuntime's `--print -p`. See ADR-021 / ADR-007.
   */
  async send(instruction: string): Promise<void> {
    void instruction;
    throw new Error('mid-flight send not supported in one-shot mode (codex exec). See ADR-021.');
  }

  async cancel(): Promise<void> {
    if (this.settled) return;
    this.proc.kill();
    this.settle({
      status: 'cancelled',
      finalOutput: '',
      totalCostUsd: 0,
      durationMs: Date.now() - this.startMs,
    });
  }

  wait(): Promise<AgentResult> {
    return this.resultPromise.then((r) => ({ ...r }));
  }

  /** Called by CodexRuntime after returning the session to the caller. */
  async run(): Promise<void> {
    this.status = 'running';

    // Timeout guard: if no terminal turn event arrives, kill and settle error.
    const timeoutHandle = setTimeout(() => {
      if (!this.settled) {
        this.proc.kill();
        this.settle({
          status: 'error',
          finalOutput: `[timeout] No result received within ${this.timeoutMs}ms`,
          totalCostUsd: 0,
          durationMs: Date.now() - this.startMs,
        });
      }
    }, this.timeoutMs);

    const stderrPromise = this.readStderr();

    let buffer = '';
    try {
      const reader = this.proc.stdout.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) this.processLine(trimmed);
        }
      }

      const remaining = buffer.trim();
      if (remaining) this.processLine(remaining);
    } catch {
      // Stream error — process was killed (timeout/cancel) or crashed.
    }

    clearTimeout(timeoutHandle);

    const stderrContent = await stderrPromise;

    // No terminal turn event (unexpected exit, spawn failure): settle with stderr.
    if (!this.settled) {
      this.settle({
        status: 'error',
        finalOutput: stderrContent ? `[stderr] ${stderrContent}` : '',
        totalCostUsd: 0,
        durationMs: Date.now() - this.startMs,
      });
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async readStderr(): Promise<string> {
    const reader = this.proc.stderr.getReader();
    const decoder = new TextDecoder();
    let content = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        content += decoder.decode(value, { stream: true });
      }
    } catch {
      // Stream closed (process killed or exited).
    }
    return content.trim();
  }

  private settle(result: AgentResult): void {
    if (this.settled) return;
    this.settled = true;
    this.status = result.status;
    this.resolveResult(result);
  }

  private processLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Malformed JSON — log and skip; do not crash the session.
      // Raw content is intentionally NOT logged: event payloads can contain
      // prompt text or command output that must not appear in application logs.
      console.error('[codex] Malformed JSON line (skipped)');
      return;
    }
    this.handleEvent(parsed);
  }

  private handleEvent(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const evt = raw as Record<string, unknown>;

    switch (evt['type']) {
      case 'item.completed': {
        const item = (evt as CodexItemEvent).item;
        if (!item || typeof item !== 'object') return;

        if (item.type === 'agent_message') {
          const text = (item as unknown as CodexAgentMessageItem).text;
          if (typeof text === 'string') {
            this.lastAgentText = text;
            this.emit({ role: 'agent', content: text, timestamp: new Date().toISOString() });
          }
        } else if (item.type === 'command_execution') {
          const cmd = item as unknown as CodexCommandExecutionItem;
          const exit = typeof cmd.exit_code === 'number' ? ` (exit ${cmd.exit_code})` : '';
          this.emit({
            role: 'tool',
            content: `[exec] ${cmd.command ?? ''}${exit}`.trimEnd(),
            timestamp: new Date().toISOString(),
          });
        }
        return;
      }

      case 'turn.completed': {
        // SUCCESS: the turn finished without a protocol error. Mirroring
        // ClaudeCodeRuntime, the runtime reports only hard failure; whether the
        // task actually succeeded (artifact exists) is the specialist's concern.
        // Cost is 0 — covered by the ChatGPT subscription, not free in absolute
        // terms (no USD figure is emitted for subscription runs).
        this.settle({
          status: 'done',
          finalOutput: this.lastAgentText,
          totalCostUsd: 0,
          durationMs: Date.now() - this.startMs,
        });
        return;
      }

      case 'turn.failed': {
        const err = (evt as CodexTurnFailed).error;
        const message = typeof err?.message === 'string' ? err.message : 'unknown error';
        this.settle({
          status: 'error',
          finalOutput: `[turn.failed] ${message}`,
          totalCostUsd: 0,
          durationMs: Date.now() - this.startMs,
        });
        return;
      }

      // thread.started, turn.started, item.started, error (non-terminal detail),
      // and any future event types are informational — ignored.
      default:
        return;
    }
  }

  private emit(msg: AgentMessage): void {
    for (const h of this.handlers) h(msg);
  }
}

// ── Runtime ───────────────────────────────────────────────────────────────────

/**
 * Real IAgentRuntime implementation that spawns the Codex CLI in non-interactive
 * mode (`codex exec --json`). See the discovery findings block at the top of this
 * file and ADR-021 for the full rationale.
 *
 * @param spawnFn  Override the subprocess factory (used in tests to inject fake
 *                 processes without spawning the real `codex` binary).
 * @param options  Runtime options. `timeoutMs` controls how long to wait for a
 *                 terminal turn event before killing the process (default 10 min).
 */
export class CodexRuntime implements IAgentRuntime {
  private readonly spawnFn: SpawnFn;
  private readonly timeoutMs: number;

  constructor(spawnFn?: SpawnFn, options?: { timeoutMs?: number }) {
    this.spawnFn = spawnFn ?? defaultSpawn;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async spawn(params: SpawnParams): Promise<AgentSession> {
    const permissionMode = params.permissionMode ?? 'acceptEdits';
    const timeoutMs = params.timeoutMs ?? this.timeoutMs;

    const args = ['codex', 'exec', '--json', '--skip-git-repo-check'];
    if (permissionMode === 'bypassPermissions') {
      // Full access — no sandbox, no approvals. Needed for the implementer which
      // runs builds/tests/git in its workspace.
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      // acceptEdits → writes scoped to the workspace; commands run sandboxed but
      // without interactive prompts (verified in discovery).
      args.push('--sandbox', 'workspace-write');
    }
    if (params.model) {
      args.push('--model', params.model);
    }
    // Prompt as the trailing positional argument (stdin is left at EOF).
    args.push(params.prompt);

    const env = buildSubprocessEnv(params.env, CODEX_SCRUB_KEYS);

    const proc = this.spawnFn(args, params.workdir, env);
    const session = new CodexSession(proc, params, timeoutMs);
    void session.run();
    return session;
  }
}
