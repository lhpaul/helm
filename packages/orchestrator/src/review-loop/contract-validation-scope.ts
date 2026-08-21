import { defaultRunGh, type RunGh } from '../specialists/git-helpers.js';

export type SeverityCounts = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
};

/**
 * Paths that activate ADR-027 §4 contract validation.
 *
 * Intentionally narrow: a `/schema/` directory, a `/migration(s)/` directory,
 * or a `.sql` file. Application modules that merely *use* the schema must not
 * trip this (LEA-110: auth.ts + trusted-origin.ts are not schema).
 */
export function isContractValidationPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  if (/(^|\/)migrations?\//i.test(normalized)) return true;
  if (/(^|\/)schema\//i.test(normalized)) return true;
  if (/\.sql$/i.test(normalized)) return true;
  return false;
}

export function selectContractValidationFiles(changedPaths: readonly string[]): string[] {
  return [...new Set(changedPaths.filter(isContractValidationPath))];
}

const PR_URL_RE = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;

export function parsePullRequestUrl(
  prUrl: string,
): { owner: string; repo: string; number: string } | null {
  const match = prUrl.match(PR_URL_RE);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]!, number: match[3]! };
}

/**
 * Lists paths changed on the PR. Best-effort: throws on unparseable URL or
 * gh failure so the caller can leave the scope unset (prose gate remains).
 */
export async function listPullRequestChangedPaths(
  prUrl: string,
  githubToken: string,
  runGh: RunGh = defaultRunGh,
): Promise<string[]> {
  const parsed = parsePullRequestUrl(prUrl);
  if (!parsed) {
    throw new Error(`Cannot parse pull request URL: ${prUrl}`);
  }

  const result = await runGh(
    [
      'api',
      '--paginate',
      `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/files`,
      '--jq',
      '.[].filename',
    ],
    { env: { GITHUB_TOKEN: githubToken } },
  );

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function formatContractValidationScopeBlock(schemaFiles: string[] | undefined): string {
  if (schemaFiles === undefined) {
    return [
      '**Scope gate:** Only invoke contract validation when the diff includes at least one file matching schema/migration/entity-type globs. If the diff is purely application code with no schema impact, skip contract validation entirely (no Pass/Fail line needed).',
    ].join('\n');
  }

  if (schemaFiles.length === 0) {
    return [
      '**Scope gate (computed — do not override):** Schema files in this diff: none.',
      'Do **not** open `CLAUDE.md` §4 to audit the existing model.',
      'Do **not** emit any `Contract drift §4` finding. Pre-existing schema drift that this PR did not introduce is a follow-up ticket, not a blocker.',
    ].join('\n');
  }

  return [
    '**Scope gate (computed):** Schema files in this diff (validate only these against §4):',
    ...schemaFiles.map((file) => `- \`${file}\``),
    'Do not emit `Contract drift §4` for tables or columns that appear only in `CLAUDE.md` and not in these files.',
  ].join('\n');
}

export function formatSubsequentReviewPassBlock(subsequentReviewPass: boolean): string {
  const lines = [
    '',
    '### Finding scope (diff + cycle freeze)',
    '',
    '- HIGH and MEDIUM findings must cite a path that appears in this PR diff (or a file the remediator just changed). Pre-existing drift not introduced by this item is **INFO** plus “open a follow-up”, never HIGH.',
    '- Do not treat `CLAUDE.md` as a license to re-review the whole repository.',
  ];

  if (subsequentReviewPass) {
    lines.push(
      '- **Subsequent review pass:** this is not the first code-review fan-out for the item. New findings must be (a) a regression of the last remediator commit, or (b) a previously open blocker still unmet. A brand-new quality theme is **LOW** or **INFO**. Do not start a fresh quality pass.',
    );
  }

  return lines.join('\n');
}

const CONTRACT_DRIFT_TAG = 'Contract drift §4';
const OFF_DIFF_LABEL = 'Off-diff contract drift (suppressed):';

/**
 * Mechanically demotes `Contract drift §4` findings when the orchestrator
 * already knows the PR did not touch schema files. Unlike the catalogue
 * (ADR-043, MEDIUM ceiling), this is a computed skip and may demote HIGH.
 */
export function suppressOffDiffContractDrift(
  reviewContent: string,
  findings: SeverityCounts,
  schemaFiles: string[] | undefined,
): { reviewContent: string; findings: SeverityCounts } {
  if (schemaFiles === undefined || schemaFiles.length > 0) {
    return { reviewContent, findings };
  }

  const next: SeverityCounts = { ...findings };
  let suppressedCount = 0;
  const rewritten = reviewContent.replace(
    /\*\*(CRITICAL|HIGH|MEDIUM|LOW|INFO)\*\*\s*·\s*([^\n]+)/g,
    (line, rawSeverity: string, summary: string) => {
      if (summary.startsWith(OFF_DIFF_LABEL)) return line;
      if (!summary.includes(CONTRACT_DRIFT_TAG)) return line;

      const severity = rawSeverity.toLowerCase() as keyof SeverityCounts;
      if (next[severity] > 0) next[severity] -= 1;
      next.info += 1;
      suppressedCount += 1;
      return `**INFO** · ${OFF_DIFF_LABEL} ${summary}`;
    },
  );

  if (suppressedCount === 0) {
    return { reviewContent, findings };
  }

  const status = next.critical + next.high + next.medium > 0 ? 'CHANGES_REQUESTED' : 'APPROVED';
  const withStatus = rewriteReviewStatus(rewritten, status);
  return { reviewContent: withStatus, findings: next };
}

function rewriteReviewStatus(reviewContent: string, status: 'APPROVED' | 'CHANGES_REQUESTED') {
  const statusSection = /(^##\s+Status\s*\n)\s*(?:APPROVED|CHANGES_REQUESTED)\b/im;
  if (statusSection.test(reviewContent)) {
    return reviewContent.replace(statusSection, `$1${status}`);
  }
  return `${reviewContent.trimEnd()}\n\n## Status\n${status}`;
}
