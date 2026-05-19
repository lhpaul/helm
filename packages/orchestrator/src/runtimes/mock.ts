import type {
  AgentMessage,
  AgentResult,
  AgentSession,
  AgentStatus,
  IAgentRuntime,
  SpawnParams,
} from '../runtime.js';

// ── Script types ──────────────────────────────────────────────────────────────

export type MockScriptMessage = AgentMessage & {
  /** Milliseconds to wait before emitting this message. */
  delayMs?: number;
};

export type MockScript = {
  messages: MockScriptMessage[];
  /** Terminal status when all messages have been emitted. Default: 'done'. */
  outcome?: AgentResult['status'];
  /** Returned as AgentResult.finalOutput. Defaults to last message content. */
  finalOutput?: string;
  /**
   * Side effects run after all messages are emitted but before the session
   * resolves. Useful for writing files the specialist expects to find (e.g.
   * the mock spec-writer creating specs/{externalId}.md).
   */
  sideEffects?: (workdir: string) => Promise<void>;
};

// ── Session ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class MockAgentSession implements AgentSession {
  readonly id: string;
  status: AgentStatus = 'spawning';

  private readonly handlers: Array<(m: AgentMessage) => void> = [];
  private readonly resultPromise: Promise<AgentResult>;
  private resolveResult!: (r: AgentResult) => void;
  private cancelled = false;
  private startMs = 0;

  constructor(
    private readonly script: MockScript,
    private readonly params: SpawnParams,
  ) {
    this.id = `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.resultPromise = new Promise<AgentResult>((resolve) => {
      this.resolveResult = resolve;
    });
  }

  onMessage(handler: (m: AgentMessage) => void): void {
    this.handlers.push(handler);
  }

  async send(instruction: string): Promise<void> {
    this.emit({
      role: 'system',
      content: `[mid-flight] ${instruction}`,
      timestamp: new Date().toISOString(),
    });
  }

  async cancel(): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    this.status = 'cancelled';
    this.resolveResult({
      status: 'cancelled',
      finalOutput: '',
      totalCostUsd: 0,
      durationMs: Date.now() - this.startMs,
    });
  }

  wait(): Promise<AgentResult> {
    return this.resultPromise;
  }

  /** Called by MockAgentRuntime after returning the session to the caller. */
  async run(): Promise<void> {
    this.startMs = Date.now();
    this.status = 'running';
    let totalCost = 0;
    let lastContent = '';

    for (const msg of this.script.messages) {
      if (this.cancelled) return;
      // Always await (even 0 ms) so spawn() can return and callers can register
      // onMessage handlers before any messages are emitted.
      await sleep(msg.delayMs ?? 0);
      const clean: AgentMessage = {
        role: msg.role,
        content: msg.content,
        costUsd: msg.costUsd,
        timestamp: msg.timestamp,
      };
      this.emit(clean);
      totalCost += clean.costUsd ?? 0;
      lastContent = clean.content;
    }

    if (!this.cancelled && this.script.sideEffects) {
      await this.script.sideEffects(this.params.workdir);
    }

    if (this.cancelled) return;

    const outcome = this.script.outcome ?? 'done';
    this.status = outcome === 'done' ? 'done' : 'error';
    this.resolveResult({
      status: outcome,
      finalOutput: this.script.finalOutput ?? lastContent,
      totalCostUsd: totalCost,
      durationMs: Date.now() - this.startMs,
    });
  }

  private emit(msg: AgentMessage): void {
    for (const h of this.handlers) h(msg);
  }
}

// ── Runtime ───────────────────────────────────────────────────────────────────

/**
 * In-memory scriptable IAgentRuntime implementation for unit/integration tests.
 *
 * Usage:
 *   const runtime = new MockAgentRuntime({
 *     messages: [{ role: 'agent', content: 'Writing spec…', timestamp: '…' }],
 *     sideEffects: async (workdir) => {
 *       await mkdir(join(workdir, 'specs'), { recursive: true });
 *       await writeFile(join(workdir, 'specs', 'issue_1.md'), '# Spec');
 *     },
 *   });
 *   const session = await runtime.spawn(params);
 *   const result = await session.wait();
 */
export class MockAgentRuntime implements IAgentRuntime {
  constructor(private readonly script: MockScript) {}

  async spawn(params: SpawnParams): Promise<AgentSession> {
    const session = new MockAgentSession(this.script, params);
    // Run asynchronously so the caller can register onMessage handlers first.
    void session.run();
    return session;
  }
}
