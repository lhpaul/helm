import { createHash } from 'node:crypto';
import { DEFAULT_BUGBOT_BLOCKING_SEVERITIES, type Product } from '@helm/shared';
import type {
  ExternalReviewAdapter,
  ExternalReviewContext,
  ExternalReviewResult,
  NormalizedFinding,
} from '../types.js';
import type {
  BugbotAnnotationPayload,
  BugbotReviewCommentPayload,
  BugbotReviewConfig,
  BugbotReviewPayload,
  BugbotReviewThreadPayload,
  BugbotSeverity,
  LoadBugbotReview,
} from './types.js';

export type BugbotAdapterDeps = {
  loadBugbotReview?: LoadBugbotReview;
};

const DEFAULT_DEFER_WHEN_PENDING = true;
const SEVERITIES: BugbotSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function resolveBugbotReviewConfig(product: Product): BugbotReviewConfig {
  return {
    blockingSeverities: product.review?.external?.bugbot?.blocking_severities ?? [
      ...DEFAULT_BUGBOT_BLOCKING_SEVERITIES,
    ],
    deferWhenPending: product.review?.external?.defer_when_pending ?? DEFAULT_DEFER_WHEN_PENDING,
  };
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSeverity(value: string | undefined): BugbotSeverity {
  const normalized = value?.trim().toLowerCase();
  if (normalized && (SEVERITIES as string[]).includes(normalized)) {
    return normalized as BugbotSeverity;
  }
  if (normalized === 'failure' || normalized === 'warning') return 'medium';
  if (normalized === 'notice') return 'info';
  return 'medium';
}

function severityFromBody(body: string | undefined): BugbotSeverity {
  if (!body) return 'medium';
  const markdownMatch = body.match(/\*\*\s*(critical|high|medium|low|info)\s*\*\*/i);
  if (markdownMatch?.[1]) return normalizeSeverity(markdownMatch[1]);
  const labelMatch = body.match(/\bseverity\s*[:=-]\s*(critical|high|medium|low|info)\b/i);
  if (labelMatch?.[1]) return normalizeSeverity(labelMatch[1]);
  return 'medium';
}

function summarize(body: string | undefined, fallback: string): string {
  if (!body) return fallback;
  const firstLine = body
    .split('\n')
    .map((line) =>
      line
        .replace(/\*\*/g, '')
        .replace(/^[-*]\s*/, '')
        .trim(),
    )
    .find((line) => line.length > 0);
  if (!firstLine) return fallback;
  return firstLine.slice(0, 180);
}

function stableBugbotFindingId(input: {
  nativeId?: string;
  path?: string;
  line?: number;
  summary: string;
}): string {
  const source = [input.nativeId, input.path, input.line, input.summary]
    .map((part) => `${part ?? ''}`)
    .join('\0');
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
  return `bugbot:${digest}`;
}

function makeFinding(
  input: {
    nativeId?: string;
    path?: string | null;
    line?: number | null;
    summary: string;
    detail?: string;
    severity: BugbotSeverity;
  },
  config: BugbotReviewConfig,
): NormalizedFinding {
  const path = text(input.path ?? undefined);
  const line = typeof input.line === 'number' ? input.line : undefined;
  const summary = text(input.summary) ?? 'Bugbot finding';
  const blocking = config.blockingSeverities.includes(input.severity);
  return {
    id: stableBugbotFindingId({ nativeId: input.nativeId, path, line, summary }),
    severity: input.severity,
    blocking,
    path,
    summary,
    detail: text(input.detail),
  };
}

function findingFromAnnotation(
  annotation: BugbotAnnotationPayload,
  config: BugbotReviewConfig,
): NormalizedFinding {
  const detail = text(annotation.raw_details) ?? text(annotation.message);
  return makeFinding(
    {
      path: annotation.path,
      line: annotation.start_line ?? annotation.end_line,
      summary: text(annotation.title) ?? text(annotation.message) ?? 'Bugbot annotation',
      detail,
      severity: normalizeSeverity(annotation.annotation_level ?? undefined),
    },
    config,
  );
}

function findingFromComment(
  comment: BugbotReviewCommentPayload,
  config: BugbotReviewConfig,
  thread?: BugbotReviewThreadPayload,
): NormalizedFinding | null {
  const body = text(comment.body);
  if (!body) return null;
  const fallbackNativeId = text(`${comment.id ?? thread?.id ?? ''}`);
  return makeFinding(
    {
      nativeId: text(comment.node_id) ?? fallbackNativeId,
      path: comment.path ?? thread?.path,
      line: comment.line ?? comment.original_line ?? thread?.line,
      summary: summarize(body, 'Bugbot review comment'),
      detail: body,
      severity: severityFromBody(body),
    },
    config,
  );
}

function findingFromCheckRunConclusion(
  checkRun: NonNullable<BugbotReviewPayload['checkRun']>,
  conclusion: string,
  config: BugbotReviewConfig,
): NormalizedFinding {
  const output = checkRun.output;
  const detail = [output?.title, output?.summary, output?.text]
    .map((part) => text(part ?? undefined))
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
  return makeFinding(
    {
      nativeId: `check-run:${checkRun.name ?? 'bugbot'}:${conclusion}`,
      summary:
        text(output?.title ?? undefined) ??
        text(output?.summary ?? undefined) ??
        `Bugbot check run concluded ${conclusion}`,
      detail,
      severity: 'high',
    },
    config,
  );
}

function appendFinding(
  finding: NormalizedFinding,
  target: { blockers: NormalizedFinding[]; advisories: NormalizedFinding[] },
  seen: Set<string>,
): void {
  if (seen.has(finding.id)) return;
  seen.add(finding.id);
  if (finding.blocking) target.blockers.push(finding);
  else target.advisories.push(finding);
}

export function normalizeBugbotReviewPayload(
  payload: BugbotReviewPayload,
  config: BugbotReviewConfig,
): ExternalReviewResult {
  if (payload.unavailable) return { status: 'skipped', reason: 'unavailable' };
  if (payload.error) return { status: 'escalate', reason: `bugbot ${payload.error}` };

  const analysisStatus = text(payload.analysisStatus)?.toLowerCase();
  if (analysisStatus && ['queued', 'pending', 'in_progress', 'running'].includes(analysisStatus)) {
    if (!config.deferWhenPending) {
      return { status: 'escalate', reason: `bugbot ${analysisStatus}` };
    }
    return {
      status: 'deferred',
      reason: 'analysis_pending',
      providerReason: `bugbot ${analysisStatus}`,
    };
  }

  const checkRun = payload.checkRun;
  if (checkRun?.status && checkRun.status !== 'completed') {
    if (!config.deferWhenPending) {
      return { status: 'escalate', reason: `bugbot check_run ${checkRun.status}` };
    }
    return {
      status: 'deferred',
      reason: 'analysis_pending',
      providerReason: `bugbot check_run ${checkRun.status}`,
    };
  }

  const findings = { blockers: [] as NormalizedFinding[], advisories: [] as NormalizedFinding[] };
  const seen = new Set<string>();

  for (const annotation of checkRun?.output?.annotations ?? []) {
    appendFinding(findingFromAnnotation(annotation, config), findings, seen);
  }

  for (const thread of payload.reviewThreads ?? []) {
    const resolved = thread.isResolved ?? thread.is_resolved ?? false;
    for (const comment of thread.comments ?? []) {
      const finding = findingFromComment(comment, config, thread);
      if (!finding) continue;
      if (resolved) {
        seen.add(finding.id);
      } else {
        appendFinding(finding, findings, seen);
      }
    }
  }
  for (const comment of payload.reviewComments ?? []) {
    const finding = findingFromComment(comment, config);
    if (finding) appendFinding(finding, findings, seen);
  }

  if (findings.blockers.length > 0) {
    return { status: 'needs_fixes', blockers: findings.blockers, advisories: findings.advisories };
  }

  const conclusion = checkRun?.conclusion?.toLowerCase();
  if (conclusion && ['cancelled', 'skipped', 'stale'].includes(conclusion)) {
    return { status: 'skipped', reason: 'unavailable' };
  }
  if (checkRun && conclusion && !['success', 'neutral'].includes(conclusion)) {
    const finding = findingFromCheckRunConclusion(checkRun, conclusion, config);
    return {
      status: 'needs_fixes',
      blockers: [{ ...finding, blocking: true }],
      advisories: findings.advisories,
    };
  }

  return { status: 'clean', blockers: [], advisories: findings.advisories };
}

/** Bugbot external review adapter (ADR-036). */
export class BugbotExternalReviewAdapter implements ExternalReviewAdapter {
  readonly provider = 'bugbot';

  constructor(
    private readonly product: Product,
    private readonly deps: BugbotAdapterDeps = {},
  ) {}

  async reviewPullRequest(ctx: ExternalReviewContext): Promise<ExternalReviewResult> {
    if (!this.deps.loadBugbotReview) {
      return { status: 'skipped', reason: 'unavailable' };
    }
    const payload = await this.deps.loadBugbotReview(ctx);
    if (!payload) return { status: 'skipped', reason: 'unavailable' };
    return normalizeBugbotReviewPayload(payload, resolveBugbotReviewConfig(this.product));
  }
}

export function createBugbotExternalReviewAdapter(
  product: Product,
  deps?: BugbotAdapterDeps,
): BugbotExternalReviewAdapter {
  return new BugbotExternalReviewAdapter(product, deps);
}
