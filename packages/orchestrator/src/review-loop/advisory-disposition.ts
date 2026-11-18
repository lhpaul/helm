import type { NormalizedFinding } from '../external-review/types.js';
import type { WorkflowStage } from '@helm/workflow';
import { matchesFalsePositiveFinding, type FalsePositiveEntry } from './false-positives.js';
import { acceptedFindingMatchesExternal } from './accept-finding.js';

/** ADR-036 §5 advisory disposition values. */
export type AdvisoryDisposition = 'Addressed' | 'Accepted' | 'Deferred' | 'Rejected';

export type AdvisoryWithDisposition = {
  finding: NormalizedFinding;
  disposition: AdvisoryDisposition;
  rationale: string;
};

const DEFAULT_DEFERRED_RATIONALE =
  'Non-blocking advisory — recorded for human merge gate (ADR-036 v1 auto-disposition).';

/**
 * Assigns orchestrator dispositions: an operator accept → Accepted; a catalogued
 * pattern → Rejected; else Deferred. Does not re-run external review to clear
 * advisories.
 *
 * Accept is checked first (ADR-043 §4): a named human decision on this item
 * outranks a heuristic catalogue match, and `Accepted` says something different
 * to the merge gate than `Rejected` does — the finding was real and someone
 * chose to ship anyway.
 */
export function resolveAdvisoryDispositions(
  advisories: NormalizedFinding[],
  catalog: FalsePositiveEntry[],
  stage: WorkflowStage,
  acceptedFindings: readonly { fingerprint: string; rationale?: string }[] = [],
): AdvisoryWithDisposition[] {
  return advisories.map((finding) => {
    if (acceptedFindingMatchesExternal(acceptedFindings, finding)) {
      const accepted = acceptedFindings.find((entry) =>
        acceptedFindingMatchesExternal([entry], finding),
      );
      return {
        finding,
        disposition: 'Accepted',
        rationale: accepted?.rationale?.trim()
          ? `Accepted by operator: ${accepted.rationale.trim()}`
          : 'Accepted by operator (ADR-043 §4).',
      };
    }
    const match = catalog.find(
      (entry) =>
        (entry.appliesTo === undefined || entry.appliesTo.includes(stage)) &&
        matchesFalsePositiveFinding(entry, finding),
    );
    if (match) {
      return {
        finding,
        disposition: 'Rejected',
        rationale: match.rationale,
      };
    }
    return {
      finding,
      disposition: 'Deferred',
      rationale: DEFAULT_DEFERRED_RATIONALE,
    };
  });
}
