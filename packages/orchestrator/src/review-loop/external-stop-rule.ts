import type { ExternalReviewResult } from '../external-review/types.js';
import type { HaystackSkipEvidence } from '../external-review/haystack/skip-evidence.js';
import type { StopRuleEscalationReason } from './stop-rule.js';

export type ExternalReviewStopDecision =
  | { action: 'continue'; result: ExternalReviewResult }
  | { action: 'retry'; skipAttempt: number }
  | {
      action: 'escalate';
      reason: StopRuleEscalationReason;
      message: string;
      skipAttempt: number;
      evidence?: HaystackSkipEvidence;
      externalReason?: string;
    };

/**
 * Decides whether to retry external review, escalate, or accept the outcome.
 * ADR-036 §6: escalate on adapter `escalate`, skip evidence, or repeated skips.
 */
export function evaluateExternalReviewStopRule(input: {
  result: ExternalReviewResult;
  skipAttempt: number;
  maxSkipAttempts: number;
  evidence: HaystackSkipEvidence | null;
}): ExternalReviewStopDecision {
  const { result, skipAttempt, maxSkipAttempts, evidence } = input;

  if (result.status === 'escalate') {
    return {
      action: 'escalate',
      reason: 'external_escalate',
      message: `External review escalated: ${result.reason}`,
      skipAttempt,
      externalReason: result.reason,
      evidence: evidence ?? undefined,
    };
  }

  if (result.status === 'needs_fixes' || result.status === 'clean') {
    return { action: 'continue', result };
  }

  if (result.reason === 'not_configured') {
    return { action: 'continue', result };
  }

  if (evidence) {
    return {
      action: 'escalate',
      reason: 'external_skip_evidence',
      message: `External review skipped (${result.reason}) with evidence: ${evidence.detail}`,
      skipAttempt,
      evidence,
      externalReason: result.reason,
    };
  }

  if (skipAttempt >= maxSkipAttempts) {
    return {
      action: 'escalate',
      reason: 'external_repeated_skip',
      message: `External review skipped ${skipAttempt} time(s) (${result.reason}); escalating per stop-rule`,
      skipAttempt,
      externalReason: result.reason,
    };
  }

  return { action: 'retry', skipAttempt };
}
