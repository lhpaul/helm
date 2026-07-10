import type { Findings, ReviewerResult } from '../specialists/reviewer-fanout.js';

/** Minimum severity that gates remediation and stop-rule blocker counts (ADR-036 / ADR-037 revisit). */
export type RemediateSeverity = 'critical_high' | 'medium_and_above';

export const DEFAULT_REMEDIATE_SEVERITY: RemediateSeverity = 'critical_high';

/** Counts findings at or above the configured remediation gate severity. */
export function countGateFindings(
  findings: Findings,
  severity: RemediateSeverity = DEFAULT_REMEDIATE_SEVERITY,
): number {
  const criticalHigh = findings.critical + findings.high;
  if (severity === 'critical_high') {
    return criticalHigh;
  }
  return criticalHigh + findings.medium;
}

/** True when any reviewer has gate-severity findings (replaces legacy CRITICAL/HIGH-only check). */
export function shouldRemediateForSeverity(
  results: ReviewerResult[],
  severity: RemediateSeverity = DEFAULT_REMEDIATE_SEVERITY,
): boolean {
  return results.some(
    (r) => r.findings !== undefined && countGateFindings(r.findings, severity) > 0,
  );
}
