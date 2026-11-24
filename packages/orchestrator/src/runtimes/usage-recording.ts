import type {
  AgentResult,
  AgentSession,
  AgentUsage,
  IAgentRuntime,
  SpawnParams,
  UsageTokens,
} from '../runtime.js';
import { unknownUsage } from '../runtime.js';
import type { UsageStage } from '../dispatcher.js';

/**
 * One usage record per agent session (#151, ADR-046). Holds only the fields
 * below — never prompts, outputs, paths, env values or credentials. `null`
 * means the runtime did not report the value; `0` only ever means a measured
 * zero.
 */
export interface UsageRecord {
  productSlug: string;
  externalId: string;
  jobId: string;
  /** The session's own specialist (raw; the stage comes from the job). */
  specialistId: string;
  stage: UsageStage;
  runtime: string;
  model: string | null;
  startedAt: string;
  endedAt: string;
  /** Wall clock measured by Helm around spawn → wait. */
  durationMs: number;
  status: AgentResult['status'];
  tokens: UsageTokens;
  costUsd: number | null;
  costSource: AgentUsage['costSource'];
}

export interface UsageRecordingContext {
  jobId: string;
  /** Stage of the job's specialist; every session of the job inherits it. */
  stage: UsageStage;
  /** Runtime label stamped on records, e.g. `claude-code`, `codex`. */
  runtime: string;
  /**
   * Receives one record per finished session. Must start its write
   * synchronously (so ordering follows session order); may reject.
   */
  onUsage: (record: UsageRecord) => Promise<void>;
  /** Best-effort hook called when `onUsage` fails, so the loss is visible. */
  onCaptureFailure?: () => Promise<void>;
}

/**
 * Decorator that records one {@link UsageRecord} per session without touching
 * any specialist: it hooks `wait()` at spawn time and hands the record to the
 * injected sink. A failing sink is logged (metadata only) and never fails or
 * alters the session.
 */
export class UsageRecordingRuntime implements IAgentRuntime {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly inner: IAgentRuntime,
    private readonly ctx: UsageRecordingContext,
  ) {}

  async spawn(params: SpawnParams): Promise<AgentSession> {
    const startedMs = Date.now();
    const session = await this.inner.spawn(params);
    this.track(this.record(params, session, startedMs));
    return session;
  }

  /** Resolves once every record started so far has been handed to the sink. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  private track(p: Promise<void>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  private async record(
    params: SpawnParams,
    session: AgentSession,
    startedMs: number,
  ): Promise<void> {
    let status: AgentResult['status'] = 'error';
    let usage: AgentUsage = unknownUsage();
    try {
      const result = await session.wait();
      status = result.status;
      usage = result.usage ?? unknownUsage();
    } catch {
      // wait() rejected: the session produced no usage report.
    }
    const endedMs = Date.now();
    const record: UsageRecord = {
      productSlug: params.productSlug,
      externalId: params.externalId,
      jobId: this.ctx.jobId,
      specialistId: params.specialistId,
      stage: this.ctx.stage,
      runtime: this.ctx.runtime,
      model: usage.model ?? params.model ?? null,
      startedAt: new Date(startedMs).toISOString(),
      endedAt: new Date(endedMs).toISOString(),
      durationMs: Math.max(0, endedMs - startedMs),
      status,
      tokens: { ...usage.tokens },
      costUsd: usage.costUsd,
      costSource: usage.costSource,
    };
    try {
      await this.ctx.onUsage(record);
    } catch (err) {
      // Metadata only: error class, never message/payload.
      console.error(
        `[usage] capture failed (${err instanceof Error ? err.name : 'unknown'}) job=${this.ctx.jobId}`,
      );
      try {
        await this.ctx.onCaptureFailure?.();
      } catch {
        // Both the record and the counter failed: only the log above remains.
      }
    }
  }
}
