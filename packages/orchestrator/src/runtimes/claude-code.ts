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
  kill(): void;
  readonly exited: Promise<number>;
}

export type SpawnFn = (args: string[], cwd: string) => SubprocessLike;

/**
 * Default spawn: delegates to Bun.spawn with stdout piped.
 * Using globalThis cast to avoid a bun-types dev-dependency in this package.
 */
function defaultSpawn(args: string[], cwd: string): SubprocessLike {
  const bun = (globalThis as Record<string, unknown>)['Bun'] as
    | {
        spawn(
          args: string[],
          options: { cwd: string; stdout: 'pipe'; stderr: 'ignore' },
        ): SubprocessLike;
      }
    | undefined;
  if (!bun) throw new Error('ClaudeCodeRuntime requires the Bun runtime');
  return bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'ignore' });
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
  private startMs = 0;

  constructor(
    private readonly proc: SubprocessLike,
    private readonly params: SpawnParams,
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
    this.startMs = Date.now();
    this.status = 'running';
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
      // Stderr / stream error (e.g., cancel() killed the process).
    }

    // If the process ended without emitting a `result` line (unexpected exit,
    // cancel, etc.), settle now so wait() always resolves.
    if (!this.settled) {
      this.settle({
        status: 'error',
        finalOutput: '',
        totalCostUsd: 0,
        durationMs: Date.now() - this.startMs,
      });
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

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
      console.error('[claude-code] Malformed JSON line (skipped):', line.slice(0, 120));
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
        // SUCCESS DETERMINATION:
        //   `subtype: 'success'` and `is_error: false` appear in BOTH the real
        //   success case AND the permission-denied case (finding #2 from fixtures).
        //   Actual success requires: is_error===false AND permission_denials empty.
        const permissionDenied =
          Array.isArray(r.permission_denials) && r.permission_denials.length > 0;
        const status: AgentResult['status'] = r.is_error || permissionDenied ? 'error' : 'done';

        this.settle({
          status,
          finalOutput: typeof r.result === 'string' ? r.result : '',
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
 * - Success is determined by `permission_denials.length === 0` AND the
 *   artifact check in handleSpecWriterResult — NOT by `result.subtype`.
 * - Cost comes from `result.total_cost_usd` directly (no per-model pricing table).
 *
 * Inject a custom `spawnFn` for tests to avoid spawning the real `claude` binary.
 */
export class ClaudeCodeRuntime implements IAgentRuntime {
  private readonly spawnFn: SpawnFn;

  constructor(spawnFn?: SpawnFn) {
    this.spawnFn = spawnFn ?? defaultSpawn;
  }

  async spawn(params: SpawnParams): Promise<AgentSession> {
    const args = [
      'claude',
      '--print',
      '-p',
      params.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
    ];
    if (params.model) {
      args.push('--model', params.model);
    }

    const proc = this.spawnFn(args, params.workdir);
    const session = new ClaudeCodeSession(proc, params);
    // Run asynchronously — same pattern as MockAgentRuntime.
    // The first `await reader.read()` in run() yields naturally, so callers
    // can register onMessage handlers before any messages are emitted.
    void session.run();
    return session;
  }
}
