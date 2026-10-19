import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Product } from '@helm/shared';
import type {
  ExternalReviewAdapter,
  ExternalReviewContext,
  ExternalReviewResult,
} from '../types.js';

type Invocation = {
  command: string;
  backend: 'codex' | 'http';
  mode: 'ordinary' | 'strict';
  timeoutSec: number;
  ctx: ExternalReviewContext;
};
type Execution = { stdout: string; exitCode: number; evidence: unknown };
export type LocalAiReviewerDeps = {
  executeLocalAiReview?: (input: Invocation) => Promise<Execution>;
};

const unavailable = (providerReason: string): ExternalReviewResult => ({
  status: 'skipped',
  reason: 'unavailable',
  providerReason,
});

/** Execute an operator-trusted command; PR data is positional, never shell source. */
export async function executeLocalAiReview(input: Invocation): Promise<Execution> {
  const directory = await mkdtemp(join(tmpdir(), 'helm-local-review-'));
  const evidenceFile = join(directory, 'evidence.json');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const execution = await new Promise<{ stdout: string; exitCode: number }>((resolve, reject) => {
      const child = spawn(
        '/bin/sh',
        [
          '-c',
          `exec ${input.command} "$@"`,
          'helm-local-review',
          String(input.ctx.prNumber),
          input.ctx.owner,
          input.ctx.repo,
          '--timeout',
          String(input.timeoutSec),
          '--repo-root',
          '.',
        ],
        {
          detached: true,
          signal: controller.signal,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: {
            ...process.env,
            LOCAL_AI_REVIEWER_BACKEND: input.backend,
            LOCAL_AI_REVIEWER_MODE: input.mode,
            LOCAL_AI_REVIEWER_TIMEOUT: String(input.timeoutSec),
            LOCAL_AI_REVIEWER_EVIDENCE_FILE: evidenceFile,
            REVIEWED_HEAD: input.ctx.targetRevision,
          },
        },
      );
      let stdout = '';
      let failed = false;
      const stop = () => {
        if (!child.pid) return;
        const pid = child.pid;
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          /* Already exited. */
        }
        killTimer = setTimeout(() => {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            /* Already exited. */
          }
        }, 100);
      };
      controller.signal.addEventListener('abort', stop, { once: true });
      timer = setTimeout(() => controller.abort(), input.timeoutSec * 1000);
      child.stdout.on('data', (chunk: Buffer) => {
        if (failed) return;
        if (Buffer.byteLength(stdout) + chunk.length > 1024 * 1024) {
          failed = true;
          controller.abort();
          return;
        }
        stdout += chunk.toString('utf8');
      });
      // Bun's transitive Node types can omit ChildProcess event overloads;
      // the spawned process implements Node EventEmitter at runtime.
      const events = child as unknown as EventEmitter;
      events.on('error', () => {
        failed = true;
        // Abort errors arrive before close. Wait for close to avoid reading
        // partial evidence or removing a directory still in use by the child.
      });
      events.on('close', (code: number | null) => {
        if (timer) clearTimeout(timer);
        controller.signal.removeEventListener('abort', stop);
        if (failed || controller.signal.aborted) reject(new Error('execution_unavailable'));
        else resolve({ stdout, exitCode: code ?? -1 });
      });
    });
    const evidenceText = await readFile(evidenceFile, 'utf8');
    if (Buffer.byteLength(evidenceText) > 1024 * 1024) throw new Error('evidence_oversized');
    return { ...execution, evidence: JSON.parse(evidenceText) as unknown };
  } finally {
    if (timer) clearTimeout(timer);
    // Keep the group kill armed after abort, even if the shell exited first.
    if (killTimer) await new Promise((resolve) => setTimeout(resolve, 120));
    await rm(directory, { recursive: true, force: true });
  }
}

/** Both the companion output and its fresh artifact must agree before passing. */
export function parseLocalAiReview(
  execution: Execution,
  ctx: ExternalReviewContext,
): ExternalReviewResult {
  const fields = new Map<string, string>();
  for (const line of execution.stdout.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    if (fields.has(match[1]!)) return unavailable('duplicate_output');
    fields.set(match[1]!, match[2]!);
  }
  const evidence = execution.evidence;
  if (!evidence || typeof evidence !== 'object') return unavailable('missing_evidence');
  const artifact = evidence as Record<string, unknown>;
  if (
    !ctx.targetRevision ||
    artifact.reviewed_head !== ctx.targetRevision ||
    fields.get('REVIEWED_HEAD') !== ctx.targetRevision
  )
    return unavailable('head_mismatch');
  if (
    artifact.schema_version !== 'local_ai_reviewer_evidence.v1' ||
    artifact.owner !== ctx.owner ||
    artifact.repo !== ctx.repo ||
    artifact.pr_number !== ctx.prNumber
  ) {
    return unavailable('invalid_evidence');
  }
  const result = fields.get('RESULT');
  if (artifact.result !== result) return unavailable('verdict_mismatch');
  if (result !== 'clean' && result !== 'needs_fixes') return unavailable('no_terminal_verdict');
  if (execution.exitCode !== 0 && !(result === 'needs_fixes' && execution.exitCode === 1)) {
    return unavailable('command_failed');
  }
  const countText = fields.get('BLOCKING_COUNT') ?? '';
  if (!/^(0|[1-9]\d*)$/.test(countText)) return unavailable('invalid_blocking_count');
  const count = Number(countText);
  const counts = artifact.counts as Record<string, unknown> | undefined;
  if (
    !counts ||
    counts.blocking !== count ||
    count > 1000 ||
    (result === 'clean' && count !== 0) ||
    (result === 'needs_fixes' && count === 0)
  ) {
    return unavailable('inconsistent_blocking_count');
  }
  const blockerIndexes = [...fields.keys()].flatMap((key) => {
    const match = /^BLOCKING_(\d+)_/.exec(key);
    return match ? [Number(match[1])] : [];
  });
  if (blockerIndexes.some((index) => index < 1 || index > count))
    return unavailable('unexpected_blocker');
  const blockers = [];
  for (let index = 1; index <= count; index++) {
    const body = fields.get(`BLOCKING_${index}_BODY`)?.replace(/\\n/g, '\n').trim();
    const path = fields.get(`BLOCKING_${index}_PATH`);
    if (!body) return unavailable('missing_blocker_body');
    blockers.push({
      id: `local-ai-reviewer:${createHash('sha256')
        .update(`${path ?? ''}\n${body}`)
        .digest('hex')
        .slice(0, 24)}`,
      severity: 'high' as const,
      blocking: true,
      ...(path ? { path } : {}),
      summary: body,
    });
  }
  return result === 'clean'
    ? { status: 'clean', blockers: [], advisories: [] }
    : { status: 'needs_fixes', blockers, advisories: [] };
}

export function createLocalAiReviewerAdapter(
  product: Product,
  deps?: LocalAiReviewerDeps,
): ExternalReviewAdapter {
  const config = product.review?.external?.local_ai_reviewer;
  return {
    provider: 'local-ai-reviewer',
    async reviewPullRequest(ctx) {
      if (!ctx.targetRevision || !/^[a-f\d]{40}$/.test(ctx.targetRevision))
        return unavailable('missing_target_revision');
      try {
        const execution = await (deps?.executeLocalAiReview ?? executeLocalAiReview)({
          command: config?.command ?? 'local-ai-reviewer.sh',
          backend: config?.backend ?? 'codex',
          mode: config?.mode ?? 'ordinary',
          timeoutSec: config?.timeout_sec ?? 900,
          ctx,
        });
        return parseLocalAiReview(execution, ctx);
      } catch {
        // Never expose command output, filesystem paths, or credentials.
        return unavailable('execution_unavailable');
      }
    },
  };
}
