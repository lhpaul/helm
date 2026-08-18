/** Normalized external review finding (ADR-036). */
export type NormalizedFinding = {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  blocking: boolean;
  path?: string;
  summary: string;
  detail?: string;
  fixHint?: string;
};

export type ExternalReviewContext = {
  owner: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  defaultBranch: string;
  targetRevision?: string;
};

export type ExternalReviewResult =
  | {
      status: 'clean';
      blockers: [];
      advisories: NormalizedFinding[];
      policy?: { needsHumanReview: boolean; disposition: string };
    }
  | {
      status: 'needs_fixes';
      blockers: NormalizedFinding[];
      advisories: NormalizedFinding[];
    }
  | {
      status: 'skipped';
      reason: 'not_configured' | 'unavailable' | 'not_implemented';
      /**
       * Provider-specific detail behind `unavailable` (e.g. Codex reporting its
       * usage limit vs a missing cloud environment). Carried into the
       * `external_repeated_skip` escalation so the human who receives it can
       * tell a misconfiguration from a quota stop.
       */
      providerReason?: string;
    }
  | {
      status: 'deferred';
      reason: 'analysis_pending';
      providerReason?: string;
    }
  | { status: 'escalate'; reason: string };

export interface ExternalReviewAdapter {
  readonly provider: string;
  reviewPullRequest(ctx: ExternalReviewContext): Promise<ExternalReviewResult>;
}
