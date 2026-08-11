import { createHash } from 'node:crypto';
import { DEFAULT_CODERABBIT_BLOCKING_SEVERITIES, type Product } from '@helm/shared';
import type {
  ExternalReviewAdapter,
  ExternalReviewContext,
  ExternalReviewResult,
  NormalizedFinding,
} from '../types.js';
import type {
  CodeRabbitReviewCommentPayload,
  CodeRabbitReviewConfig,
  CodeRabbitReviewPayload,
  CodeRabbitReviewThreadPayload,
  CodeRabbitSeverity,
  CodeRabbitStatusPayload,
  LoadCodeRabbitReview,
} from './types.js';

export type CodeRabbitAdapterDeps = {
  loadCodeRabbitReview?: LoadCodeRabbitReview;
};

const DEFAULT_DEFER_WHEN_PENDING = true;
const SEVERITIES: CodeRabbitSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function resolveCodeRabbitReviewConfig(product: Product): CodeRabbitReviewConfig {
  return {
    blockingSeverities: product.review?.external?.coderabbit?.blocking_severities ?? [
      ...DEFAULT_CODERABBIT_BLOCKING_SEVERITIES,
    ],
    deferWhenPending: product.review?.external?.defer_when_pending ?? DEFAULT_DEFER_WHEN_PENDING,
  };
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSeverity(value: string | undefined): CodeRabbitSeverity {
  const normalized = value?.trim().toLowerCase();
  if (normalized && (SEVERITIES as string[]).includes(normalized)) {
    return normalized as CodeRabbitSeverity;
  }
  if (normalized === 'failure' || normalized === 'warning' || normalized === 'major') {
    return 'medium';
  }
  if (normalized === 'minor' || normalized === 'nit' || normalized === 'nitpick') return 'low';
  if (normalized === 'notice' || normalized === 'trivial') return 'info';
  return 'medium';
}

function severityFromBody(body: string | undefined): CodeRabbitSeverity {
  if (!body) return 'medium';
  const markdownMatch = body.match(
    /\*\*\s*(critical|high|medium|low|info|major|minor|nitpick|nit)\s*\*\*/i,
  );
  if (markdownMatch?.[1]) return normalizeSeverity(markdownMatch[1]);
  const labelMatch = body.match(
    /\b(?:severity|priority)\s*[:=-]\s*(critical|high|medium|low|info|major|minor)\b/i,
  );
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
        .replace(/^<!--[\s\S]*?-->/g, '')
        .trim(),
    )
    .find((line) => line.length > 0 && !line.startsWith('<'));
  if (!firstLine) return fallback;
  return firstLine.slice(0, 180);
}

function stableCodeRabbitFindingId(input: {
  nativeId?: string;
  path?: string;
  line?: number;
  summary: string;
}): string {
  const source = [input.nativeId, input.path, input.line, input.summary]
    .map((part) => `${part ?? ''}`)
    .join('\0');
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
  return `coderabbit:${digest}`;
}

function makeFinding(
  input: {
    nativeId?: string;
    path?: string | null;
    line?: number | null;
    summary: string;
    detail?: string;
    severity: CodeRabbitSeverity;
  },
  config: CodeRabbitReviewConfig,
): NormalizedFinding {
  const path = text(input.path ?? undefined);
  const line = typeof input.line === 'number' ? input.line : undefined;
  const summary = text(input.summary) ?? 'CodeRabbit finding';
  const blocking = config.blockingSeverities.includes(input.severity);
  return {
    id: stableCodeRabbitFindingId({ nativeId: input.nativeId, path, line, summary }),
    severity: input.severity,
    blocking,
    path,
    summary,
    detail: text(input.detail),
  };
}

function findingFromComment(
  comment: CodeRabbitReviewCommentPayload,
  config: CodeRabbitReviewConfig,
  thread?: CodeRabbitReviewThreadPayload,
): NormalizedFinding | null {
  const body = text(comment.body);
  if (!body) return null;
  // Skip pure HTML/meta walkthrough comments that are not actionable findings.
  if (/no actionable comments/i.test(body) || /review limit reach/i.test(body)) {
    return null;
  }
  const fallbackNativeId = text(`${comment.id ?? thread?.id ?? ''}`);
  return makeFinding(
    {
      nativeId: text(comment.node_id) ?? fallbackNativeId,
      path: comment.path ?? thread?.path,
      line: comment.line ?? comment.original_line ?? thread?.line,
      summary: summarize(body, 'CodeRabbit review comment'),
      detail: body,
      severity: severityFromBody(body),
    },
    config,
  );
}

function findingFromStatusFailure(
  status: CodeRabbitStatusPayload,
  config: CodeRabbitReviewConfig,
): NormalizedFinding {
  return makeFinding(
    {
      nativeId: `status:${status.context ?? 'CodeRabbit'}:${status.state ?? 'failure'}`,
      summary:
        text(status.description ?? undefined) ??
        `CodeRabbit status concluded ${status.state ?? 'failure'}`,
      detail: [status.description, status.target_url].filter(Boolean).join('\n'),
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

function isPendingStatusState(state: string | undefined): boolean {
  const normalized = state?.trim().toLowerCase();
  return normalized === 'pending' || normalized === 'expected';
}

function isTerminalSuccessState(state: string | undefined): boolean {
  return state?.trim().toLowerCase() === 'success';
}

function isTerminalFailureState(state: string | undefined): boolean {
  const normalized = state?.trim().toLowerCase();
  return normalized === 'failure' || normalized === 'error';
}

export function normalizeCodeRabbitReviewPayload(
  payload: CodeRabbitReviewPayload,
  config: CodeRabbitReviewConfig,
): ExternalReviewResult {
  if (payload.unavailable) return { status: 'skipped', reason: 'unavailable' };
  if (payload.error) return { status: 'escalate', reason: `coderabbit ${payload.error}` };

  const status = payload.status;
  const statusState = text(status?.state)?.toLowerCase();
  const description = text(status?.description ?? undefined) ?? '';

  if (status && isPendingStatusState(statusState)) {
    if (!config.deferWhenPending) {
      return { status: 'escalate', reason: `coderabbit status ${statusState}` };
    }
    return {
      status: 'deferred',
      reason: 'analysis_pending',
      providerReason: `coderabbit status ${statusState}`,
    };
  }

  // Rate-limit success is not a clean bill — treat as skipped so the loop does
  // not clear blockers based on a non-review.
  if (isTerminalSuccessState(statusState) && /rate\s*limit/i.test(description)) {
    return { status: 'skipped', reason: 'unavailable' };
  }

  const findings = { blockers: [] as NormalizedFinding[], advisories: [] as NormalizedFinding[] };
  const seen = new Set<string>();

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

  if (status && isTerminalFailureState(statusState)) {
    const finding = findingFromStatusFailure(status, config);
    return {
      status: 'needs_fixes',
      blockers: [{ ...finding, blocking: true }],
      advisories: findings.advisories,
    };
  }

  if (status && isTerminalSuccessState(statusState)) {
    return { status: 'clean', blockers: [], advisories: findings.advisories };
  }

  // No trusted status context for this SHA — CodeRabbit not installed or not run.
  if (!status) {
    return { status: 'skipped', reason: 'unavailable' };
  }

  return { status: 'skipped', reason: 'unavailable' };
}

/** CodeRabbit external review adapter (ADR-036). */
export class CodeRabbitExternalReviewAdapter implements ExternalReviewAdapter {
  readonly provider = 'coderabbit';

  constructor(
    private readonly product: Product,
    private readonly deps: CodeRabbitAdapterDeps = {},
  ) {}

  async reviewPullRequest(ctx: ExternalReviewContext): Promise<ExternalReviewResult> {
    if (!this.deps.loadCodeRabbitReview) {
      return { status: 'skipped', reason: 'unavailable' };
    }
    const payload = await this.deps.loadCodeRabbitReview(ctx);
    if (!payload) return { status: 'skipped', reason: 'unavailable' };
    return normalizeCodeRabbitReviewPayload(payload, resolveCodeRabbitReviewConfig(this.product));
  }
}

export function createCodeRabbitExternalReviewAdapter(
  product: Product,
  deps?: CodeRabbitAdapterDeps,
): CodeRabbitExternalReviewAdapter {
  return new CodeRabbitExternalReviewAdapter(product, deps);
}
