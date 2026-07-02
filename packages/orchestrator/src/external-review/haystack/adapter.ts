import type { Product } from '@helm/shared';
import type {
  ExternalReviewAdapter,
  ExternalReviewContext,
  ExternalReviewResult,
} from '../types.js';
import { defaultRunHaystack } from './cli.js';
import {
  buildHaystackExternalResult,
  buildHaystackPrRef,
  parseHaystackJson,
  resolveHaystackReviewConfig,
} from './normalize.js';
import {
  defaultSleep,
  mapPollFailureToExternalResult,
  pollHaystackTriage,
  type PollHaystackTriageResult,
} from './triage-poll.js';
import type { HaystackPrStatusJson, RunHaystack, SleepFn } from './types.js';

export type HaystackAdapterDeps = {
  runHaystack?: RunHaystack;
  sleep?: SleepFn;
  now?: () => number;
};

const PR_STATUS_TIMEOUT_SEC = 30;

async function fetchHaystackPrStatus(
  ctx: ExternalReviewContext,
  runHaystack: RunHaystack,
): Promise<HaystackPrStatusJson | null> {
  const prRef = buildHaystackPrRef(ctx);
  let result: { stdout: string; exitCode: number };
  try {
    result = await runHaystack(['pr-status', prRef, '--json'], {
      timeoutMs: PR_STATUS_TIMEOUT_SEC * 1000,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return null;
    throw err;
  }

  if (result.exitCode !== 0) return null;
  return parseHaystackJson<HaystackPrStatusJson>(result.stdout);
}

/** Haystack external review adapter (ADR-036). */
export class HaystackExternalReviewAdapter implements ExternalReviewAdapter {
  readonly provider = 'haystack';

  constructor(
    private readonly product: Product,
    private readonly deps: HaystackAdapterDeps = {},
  ) {}

  async reviewPullRequest(ctx: ExternalReviewContext): Promise<ExternalReviewResult> {
    const config = resolveHaystackReviewConfig(this.product);
    const runHaystack = this.deps.runHaystack ?? defaultRunHaystack;
    const sleep = this.deps.sleep ?? defaultSleep;
    const now = this.deps.now ?? Date.now;

    const pollResult = await pollHaystackTriage(ctx, config, runHaystack, sleep, now);
    if (pollResult.kind !== 'completed') {
      return mapPollFailureToExternalResult(
        pollResult as Exclude<PollHaystackTriageResult, { kind: 'completed' }>,
      );
    }

    const policyPayload = await fetchHaystackPrStatus(ctx, runHaystack);
    return buildHaystackExternalResult(pollResult.payload, config, policyPayload);
  }
}

export function createHaystackExternalReviewAdapter(
  product: Product,
  deps?: HaystackAdapterDeps,
): HaystackExternalReviewAdapter {
  return new HaystackExternalReviewAdapter(product, deps);
}
