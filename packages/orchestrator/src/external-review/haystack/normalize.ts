import type { Product } from '@helm/shared';
import type { ExternalReviewContext } from '../types.js';
import { haystackCategoryToSeverity, isHaystackCategoryBlocking } from './category.js';
import { extractHaystackFindingPath, stableHaystackFindingId } from './finding-id.js';
import type {
  HaystackPrStatusJson,
  HaystackReviewConfig,
  HaystackTriageFinding,
  HaystackTriageJson,
} from './types.js';
import type { NormalizedFinding } from '../types.js';

const DEFAULT_MAJOR_IS_BLOCKING = false;
const DEFAULT_POLL_INTERVAL_SEC = 15;
const DEFAULT_TIMEOUT_SEC = 120;

/** Reads `review.external.haystack` with ADR-036 defaults. */
export function resolveHaystackReviewConfig(product: Product): HaystackReviewConfig {
  const haystack = product.review?.external?.haystack;
  return {
    majorIsBlocking: haystack?.major_is_blocking ?? DEFAULT_MAJOR_IS_BLOCKING,
    pollIntervalSec: haystack?.poll_interval_sec ?? DEFAULT_POLL_INTERVAL_SEC,
    timeoutSec: haystack?.timeout_sec ?? DEFAULT_TIMEOUT_SEC,
  };
}

export function buildHaystackPrRef(ctx: ExternalReviewContext): string {
  return `${ctx.owner}/${ctx.repo}#${ctx.prNumber}`;
}

export function parseHaystackJson<T>(stdout: string): T | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

export function haystackTriageAuthErrorReason(
  payload: HaystackTriageJson,
): 'unauthorized' | 'forbidden' | null {
  if (payload.status !== 'error') return null;
  const message = payload.message ?? '';
  if (message === 'HTTP 401') return 'unauthorized';
  if (message === 'HTTP 403') return 'forbidden';
  return null;
}

/** Completed analysis has no `status` field; transient states carry one. */
export function haystackTriageCompletionState(
  payload: HaystackTriageJson,
): 'completed' | 'none' | 'transient' {
  const status = payload.status;
  if (status === undefined || status === null || status === '') return 'completed';
  if (status === 'none') return 'none';
  return 'transient';
}

export function normalizeHaystackFindings(
  findings: HaystackTriageFinding[] | undefined,
  config: HaystackReviewConfig,
): { blockers: NormalizedFinding[]; advisories: NormalizedFinding[] } {
  const blockers: NormalizedFinding[] = [];
  const advisories: NormalizedFinding[] = [];

  for (const finding of findings ?? []) {
    const blocking = isHaystackCategoryBlocking(finding.category, config.majorIsBlocking);
    const normalized: NormalizedFinding = {
      id: stableHaystackFindingId(finding),
      severity: haystackCategoryToSeverity(finding.category),
      blocking,
      path: extractHaystackFindingPath(finding),
      summary: finding.summary?.trim() || 'Haystack finding',
      detail: finding.detail?.trim() || undefined,
      fixHint: finding.agentFixPrompt?.trim() || undefined,
    };
    if (blocking) blockers.push(normalized);
    else advisories.push(normalized);
  }

  return { blockers, advisories };
}

export function resolveHaystackPolicy(
  payload: HaystackPrStatusJson | null,
): { needsHumanReview: boolean; disposition: string } | undefined {
  if (!payload) return undefined;

  const verdict = payload.inputs?.analysisVerdict ?? payload.analysisVerdict ?? '';
  const needsHumanRaw = payload.inputs?.needsHumanReview ?? payload.needsHumanReview ?? false;
  const needsHuman = needsHumanRaw === true || `${needsHumanRaw}` === 'true';

  const verdictRequiresReview = !['', 'pass', 'passed', 'clean', 'approved'].includes(verdict);
  const reviewRequired = needsHuman || verdictRequiresReview;

  return {
    needsHumanReview: reviewRequired,
    disposition: reviewRequired ? 'policy-human-review' : 'good-to-merge',
  };
}

export function buildHaystackExternalResult(
  triage: HaystackTriageJson,
  config: HaystackReviewConfig,
  policyPayload: HaystackPrStatusJson | null,
): import('../types.js').ExternalReviewResult {
  const { blockers, advisories } = normalizeHaystackFindings(triage.findings, config);
  const policy = resolveHaystackPolicy(policyPayload);

  if (blockers.length > 0) {
    return { status: 'needs_fixes', blockers, advisories };
  }

  return {
    status: 'clean',
    blockers: [],
    advisories,
    policy,
  };
}
