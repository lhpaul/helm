import type { NormalizedFinding } from '../external-review/types.js';
import type { FalsePositiveEntry } from './false-positives.js';

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
 * Assigns v1 orchestrator dispositions: catalogued patterns → Rejected; else Deferred.
 * Does not re-run external review to clear advisories.
 */
export function resolveAdvisoryDispositions(
  advisories: NormalizedFinding[],
  catalog: FalsePositiveEntry[],
): AdvisoryWithDisposition[] {
  return advisories.map((finding) => {
    const match = catalog.find((entry) => entry.matchesSummary(finding.summary));
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
