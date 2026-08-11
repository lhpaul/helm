import type { NormalizedFinding } from '../external-review/types.js';
import type { WorkflowStage } from '@helm/workflow';
import { upsertPRCommentByMarker } from '../specialists/pr-helpers.js';
import type { RunGh } from '../specialists/git-helpers.js';
import type { AdvisoryWithDisposition } from './advisory-disposition.js';
import { resolveAdvisoryDispositions } from './advisory-disposition.js';
import type { FalsePositiveEntry } from './false-positives.js';

export const REVIEW_LOOP_SUMMARY_MARKER = '<!-- helm:review-loop-summary -->';

export function formatReviewLoopSummaryComment(input: {
  cyclesCompleted: number;
  externalProvider?: string;
  advisories: AdvisoryWithDisposition[];
}): string {
  const provider = input.externalProvider ?? 'none';
  const lines = [
    REVIEW_LOOP_SUMMARY_MARKER,
    '## Review Loop Summary',
    '',
    `**Result:** clean (0 blockers, ${input.advisories.length} advisory/advisories)`,
    `**Cycles completed:** ${input.cyclesCompleted}`,
    `**External review:** ${provider}`,
    '',
    '### Advisory dispositions',
    '',
    '| ID | Summary | Disposition | Rationale |',
    '| --- | --- | --- | --- |',
  ];

  for (const row of input.advisories) {
    lines.push(
      `| \`${escapeTableCell(row.finding.id)}\` | ${escapeTableCell(row.finding.summary)} | **${row.disposition}** | ${escapeTableCell(row.rationale)} |`,
    );
  }

  lines.push(
    '',
    '_Do not re-run external review solely to clear advisories (ADR-036 §5)._',
    '',
    '*Posted by Helm review loop.*',
  );
  return lines.join('\n');
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

export function buildAdvisorySummaryRows(
  advisories: NormalizedFinding[],
  catalog: FalsePositiveEntry[],
  stage: WorkflowStage,
): AdvisoryWithDisposition[] {
  return resolveAdvisoryDispositions(advisories, catalog, stage);
}

export async function upsertReviewLoopSummaryComment(input: {
  prUrl: string;
  githubToken: string;
  cyclesCompleted: number;
  externalProvider?: string;
  advisories: NormalizedFinding[];
  catalog: FalsePositiveEntry[];
  stage: WorkflowStage;
  runGh?: RunGh;
}): Promise<void> {
  if (input.advisories.length === 0) return;

  const rows = buildAdvisorySummaryRows(input.advisories, input.catalog, input.stage);
  const body = formatReviewLoopSummaryComment({
    cyclesCompleted: input.cyclesCompleted,
    externalProvider: input.externalProvider,
    advisories: rows,
  });

  await upsertPRCommentByMarker(
    {
      prUrl: input.prUrl,
      body,
      githubToken: input.githubToken,
      marker: REVIEW_LOOP_SUMMARY_MARKER,
    },
    input.runGh,
  );
}
