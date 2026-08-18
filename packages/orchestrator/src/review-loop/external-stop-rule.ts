import type { ExternalReviewResult } from '../external-review/types.js';
import type { StopRuleEscalationReason } from './stop-rule.js';

export type ExternalReviewStopDecision =
  | { action: 'continue'; result: ExternalReviewResult }
  | {
      action: 'defer';
      reason: 'analysis_pending';
      providerReason?: string;
    }
  | { action: 'retry'; skipAttempt: number }
  | {
      action: 'escalate';
      reason: StopRuleEscalationReason;
      message: string;
      skipAttempt: number;
      externalReason?: string;
    };

/**
 * Decides whether to retry external review, escalate, or accept the outcome.
 * ADR-036 §6: escalate on adapter `escalate` or repeated skips.
 */
export function evaluateExternalReviewStopRule(input: {
  result: ExternalReviewResult;
  skipAttempt: number;
  maxSkipAttempts: number;
}): ExternalReviewStopDecision {
  const { result, skipAttempt, maxSkipAttempts } = input;

  if (result.status === 'escalate') {
    return {
      action: 'escalate',
      reason: 'external_escalate',
      message: `External review escalated: ${result.reason}`,
      skipAttempt,
      externalReason: result.reason,
    };
  }

  if (result.status === 'deferred') {
    return {
      action: 'defer',
      reason: result.reason,
      providerReason: result.providerReason,
    };
  }

  if (result.status === 'needs_fixes' || result.status === 'clean') {
    return { action: 'continue', result };
  }

  if (result.reason === 'not_configured') {
    return { action: 'continue', result };
  }

  if (skipAttempt >= maxSkipAttempts) {
    // A provider that knows *why* it is unavailable says so — a Codex quota stop
    // and a missing Codex environment both read as `unavailable` otherwise, and
    // the human receiving the escalation needs to tell them apart.
    const detail = result.providerReason
      ? `${result.reason}: ${result.providerReason}`
      : result.reason;
    return {
      action: 'escalate',
      reason: 'external_repeated_skip',
      message: `External review skipped ${skipAttempt} time(s) (${detail}); escalating per stop-rule`,
      skipAttempt,
      externalReason: detail,
    };
  }

  return { action: 'retry', skipAttempt };
}
