import { defaultRunHaystack } from './cli.js';
import { buildHaystackPrRef, parseHaystackJson } from './normalize.js';
import type { ExternalReviewContext } from '../types.js';
import type { HaystackPrStatusJson, RunHaystack } from './types.js';

/** Evidence that Haystack may have findings even when triage was skipped/unavailable. */
export type HaystackSkipEvidence = {
  kind: 'analysis_ready' | 'rating_present';
  detail: string;
};

export function haystackSkipEvidenceFromPrStatus(
  payload: HaystackPrStatusJson | null,
): HaystackSkipEvidence | null {
  if (!payload) return null;

  const analysisStatus = (
    payload.inputs?.analysisStatus ??
    payload.analysisStatus ??
    ''
  ).toLowerCase();
  if (analysisStatus === 'ready') {
    return {
      kind: 'analysis_ready',
      detail: 'Haystack analysisStatus=ready while triage was unavailable',
    };
  }

  const rating = payload.inputs?.haystackRating ?? payload.haystackRating;
  if (rating !== undefined && rating !== null && `${rating}`.trim() !== '') {
    return {
      kind: 'rating_present',
      detail: `Haystack haystackRating=${rating} present while triage was unavailable`,
    };
  }

  return null;
}

/** Fetches Haystack pr-status when triage skipped — ADR-036 §6 evidence check. */
export async function fetchHaystackSkipEvidence(
  ctx: ExternalReviewContext,
  runHaystack: RunHaystack = defaultRunHaystack,
): Promise<HaystackSkipEvidence | null> {
  const prRef = buildHaystackPrRef(ctx);
  let result: { stdout: string; exitCode: number };
  try {
    result = await runHaystack(['pr-status', prRef, '--json'], { timeoutMs: 30_000 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return null;
    throw err;
  }

  if (result.exitCode !== 0) return null;
  return haystackSkipEvidenceFromPrStatus(parseHaystackJson<HaystackPrStatusJson>(result.stdout));
}
