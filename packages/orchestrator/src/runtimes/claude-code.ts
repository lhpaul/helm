import type {
  AgentMessage,
  AgentResult,
  AgentSession,
  AgentStatus,
  IAgentRuntime,
  SpawnParams,
} from '../runtime.js';

// ── Subprocess abstraction ────────────────────────────────────────────────────
// A minimal interface over Bun.Subprocess so tests can inject a fake process.
// The real implementation calls Bun.spawn; no bun-types dep is needed in this
// package because ClaudeCodeRuntime only runs inside apps/api (which has Bun).

export interface SubprocessLike {
  readonly stdout: ReadableStream<Uint8Array>;
  /** Captured stderr — used for diagnostics when no result line is emitted. */
  readonly stderr: ReadableStream<Uint8Array>;
  kill(): void;
  readonly exited: Promise<number>;
}

export type SpawnFn = (args: string[], cwd: string, env: Record<string, string>) => SubprocessLike;

/** Default timeout: 5 minutes. Enough for a spec-writer run; override in tests. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Builds the subprocess environment from the host `process.env`, applying two
 * transformations:
 *
 *  1. **Token scrub**: `GITHUB_TOKEN` and `GH_TOKEN` are deleted so that a
 *     compromised agent subprocess cannot exfiltrate the host's git credentials
 *     via tool calls.  The implementer workspace is provisioned with the token
 *     before the agent starts; the agent never needs the raw token.
 *
 *  2. **Extra env**: caller-provided key/value pairs are merged on top (used by
 *     future specialists that need their own env vars, e.g. API keys).
 *
 * Returns a plain `Record<string, string>` — all values are guaranteed to be
 * strings (undefined entries from `process.env` are filtered out).
 */
export function buildSubprocessEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  // Scrub credentials — agents must not have access to the host token.
  delete env['GITHUB_TOKEN'];
  delete env['GH_TOKEN'];
  // Merge caller-provided overrides last so they can set whatever the specialist needs.
  if (extra) Object.assign(env, extra);
  return env;
}

/**
 * Default spawn: delegates to Bun.spawn with stdout and stderr piped.
 * Using globalThis cast to avoid a bun-types dev-dependency in this package.
 */
function defaultSpawn(args: string[], cwd: string, env: Record<string, string>): SubprocessLike {
  const bun = (globalThis as Record<string, unknown>)['Bun'] as
    | {
        spawn(
          args: string[],
          options: { cwd: string; stdout: 'pipe'; stderr: 'pipe'; env: Record<string, string> },
        ): SubprocessLike;
      }
    | undefined;
  if (!bun) throw new Error('ClaudeCodeRuntime requires the Bun runtime');
  return bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe', env });
}

// ── JSONL message shapes (minimal — only fields we act on) ────────────────────

type ClaudeAssistantMessage = {
  type: 'assistant';
  message: {
    content: Array<
      | { type: 'thinking'; thinking: string }
      | { type: 'text'; text: string }
      | { type: 'tool_use'; name: string; input: unknown }
    >;
  };
};

type ClaudeResultMessage = {
  type: 'result';
  subtype: string;
  is_error: boolean;
  total_cost_usd: number;
  duration_ms: number;
  result: string;
  permission_denials: unknown[];
};

// ── Session ───────────────────────────────────────────────────────────────────

class ClaudeCodeSession implements AgentSession {
  readonly id: string;
  status: AgentStatus = 'spawning';

  private readonly handlers: Array<(m: AgentMessage) => void> = [];
  private readonly resultPromise: Promise<AgentResult>;
  private resolveResult!: (r: AgentResult) => void;
  private settled = false;
  // Initialized at construction so cancel() durationMs is correct even if
  // cancel() is called before run() has a chance to set startMs itself.
  private readonly startMs = Date.now();

  constructor(
    private readonly proc: SubprocessLike,
    private readonly params: SpawnParams,
    private readonly timeoutMs: number,
  ) {
    this.id = `claude-code-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.resultPromise = new Promise<AgentResult>((resolve) => {
      this.resolveResult = resolve;
    });
  }

  onMessage(handler: (m: AgentMessage) => void): void {
    this.handlers.push(handler);
  }

  /**
   * mid-flight send is not supported in one-shot (--print -p) mode.
   * Interactive mode with file-polling is tracked in ADR-007 for a future session.
   */
  async send(instruction: string): Promise<void> {
    void instruction; // one-shot mode — mid-flight send is not supported
    throw new Error('mid-flight send not supported in one-shot mode (--print -p). See ADR-007.');
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

  /** Called by ClaudeCodeRuntime after returning the session to the caller. */
  async run(): Promise<void> {
    this.status = 'running';

    // ── Timeout guard ───────────────────────────────────────────────────────
    // If no `result` line arrives within timeoutMs, kill the process and settle
    // with an error so wait() is never left unresolved.
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

    // ── Read stderr concurrently ────────────────────────────────────────────
    // Accumulated for diagnostics when the process exits without a result line
    // (e.g. spawn failure, crash). Not included in the happy path.
    const stderrPromise = this.readStderr();

    // ── Read stdout (JSONL) ─────────────────────────────────────────────────
    let buffer = '';
    try {
      const reader = this.proc.stdout.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Split on newlines; keep the last (potentially incomplete) segment buffered.
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) this.processLine(trimmed);
        }
      }

      // Flush any remaining buffered content (no trailing newline edge case).
      const remaining = buffer.trim();
      if (remaining) this.processLine(remaining);
    } catch {
      // Stream error — process was killed (timeout/cancel) or crashed.
    }

    // Always clear the timeout so it does not fire after normal completion.
    clearTimeout(timeoutHandle);

    // Drain stderr before settling — ensures the stream is fully consumed
    // and gives us diagnostic content when the process exited abnormally.
    const stderrContent = await stderrPromise;

    // If the process ended without emitting a `result` line (unexpected exit,
    // spawn failure, etc.), settle now and include stderr for diagnostics.
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
      // Raw content is intentionally NOT logged: JSONL lines can contain prompt
      // text or tool payloads that must not appear in application logs.
      console.error('[claude-code] Malformed JSON line (skipped)');
      return;
    }
    this.handleMessage(parsed);
  }

  private handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as Record<string, unknown>;

    switch (msg['type']) {
      case 'system':
        // hook_started, hook_response, init — informational only, ignore.
        return;

      case 'assistant': {
        const m = msg as ClaudeAssistantMessage;
        const content = m.message?.content;
        if (!Array.isArray(content)) return;

        for (const item of content) {
          if (!item || typeof item !== 'object') continue;
          const c = item as Record<string, unknown>;

          if (c['type'] === 'text' && typeof c['text'] === 'string') {
            this.emit({
              role: 'agent',
              content: c['text'],
              timestamp: new Date().toISOString(),
            });
          } else if (c['type'] === 'tool_use' && typeof c['name'] === 'string') {
            const inputStr = c['input'] ? JSON.stringify(c['input']) : '';
            this.emit({
              role: 'tool',
              content: `[${c['name']}] ${inputStr}`.trimEnd(),
              timestamp: new Date().toISOString(),
            });
          }
          // 'thinking' → intentionally ignored (internal CoT scratchpad)
        }
        return;
      }

      case 'user':
        // tool_result messages — intermediate state, not surfaced to callers.
        return;

      case 'rate_limit_event':
        // Informational rate-limit status — ignored.
        return;

      case 'result': {
        const r = msg as ClaudeResultMessage;
        // SUCCESS DETERMINATION (refined after Session 10 smoke test):
        //   Neither `subtype` nor `permission_denials` are reliable failure
        //   signals — an agent can be denied one tool yet complete the task via
        //   another path (observed: spec-writer wrote the spec despite a denial).
        //   The ONLY ground truth for success is whether the artifact exists,
        //   which the specialist's post-completion handler verifies. The runtime
        //   therefore reports only a hard protocol error (`is_error`). Permission
        //   denials are surfaced in finalOutput for diagnostics, not as a verdict.
        const denials = Array.isArray(r.permission_denials) ? r.permission_denials.length : 0;
        const baseOutput = typeof r.result === 'string' ? r.result : '';
        const finalOutput =
          denials > 0
            ? `${baseOutput}\n[note] ${denials} permission denial(s) occurred during the run.`
            : baseOutput;

        this.settle({
          status: r.is_error ? 'error' : 'done',
          finalOutput,
          totalCostUsd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : 0,
          durationMs: typeof r.duration_ms === 'number' ? r.duration_ms : 0,
        });
        return;
      }

      default:
        // Unknown message type — future-proof ignore.
        return;
    }
  }

  private emit(msg: AgentMessage): void {
    for (const h of this.handlers) h(msg);
  }
}

// ── Runtime ───────────────────────────────────────────────────────────────────

/**
 * Real IAgentRuntime implementation that spawns Claude Code CLI in one-shot
 * headless mode (`--print -p`).
 *
 * Key design decisions (see ADR-007 for full rationale):
 * - `--permission-mode acceptEdits`: auto-accepts file writes/edits without
 *   prompting, while still requiring explicit approval for arbitrary Bash.
 *   This is the minimum viable permission set for spec-writer (files only).
 * - `--output-format stream-json --verbose`: emits one JSONL line per event.
 * - Runtime verdict is driven by `result.is_error` only (`done` vs `error`).
 *   `permission_denials` are diagnostic — appended to `finalOutput` as a note.
 * - Artifact existence is the ground truth for task success; validated
 *   downstream in `handleSpecWriterResult` via `fs.access` — NOT here.
 * - Cost comes from `result.total_cost_usd` directly (no per-model pricing table).
 *
 * @param spawnFn   Override the subprocess factory (used in tests to inject
 *                  fake processes without spawning the real `claude` binary).
 * @param options   Runtime options. `timeoutMs` controls how long to wait for
 *                  a result line before killing the process (default: 5 min).
 *
 * Inject a custom `spawnFn` for tests to avoid spawning the real `claude` binary.
 */
export class ClaudeCodeRuntime implements IAgentRuntime {
  private readonly spawnFn: SpawnFn;
  private readonly timeoutMs: number;

  constructor(spawnFn?: SpawnFn, options?: { timeoutMs?: number }) {
    this.spawnFn = spawnFn ?? defaultSpawn;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async spawn(params: SpawnParams): Promise<AgentSession> {
    const permissionMode = params.permissionMode ?? 'acceptEdits';
    const timeoutMs = params.timeoutMs ?? this.timeoutMs;

    const args = [
      'claude',
      '--print',
      '-p',
      params.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      permissionMode,
    ];
    if (params.model) {
      args.push('--model', params.model);
    }

    // Build a sanitized subprocess environment: host env with GITHUB_TOKEN and
    // GH_TOKEN scrubbed, then merged with any caller-provided overrides.
    const env = buildSubprocessEnv(params.env);

    const proc = this.spawnFn(args, params.workdir, env);
    const session = new ClaudeCodeSession(proc, params, timeoutMs);
    // Run asynchronously — same pattern as MockAgentRuntime.
    // The first `await reader.read()` in run() yields naturally, so callers
    // can register onMessage handlers before any messages are emitted.
    void session.run();
    return session;
  }
}
