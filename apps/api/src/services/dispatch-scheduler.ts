import { join } from 'node:path';
import { GitHubNotFoundError, LinearNotFoundError } from '@helm/adapters';
import {
  dispatchStageHandler,
  resolveSpecialistId,
  type DeferredExternalReviewIntent,
  type RunExternalReviewDeps,
} from '@helm/orchestrator';
import { parseArtifactBranch, type Product } from '@helm/shared';
import { WORKFLOW_STAGES, type WorkflowStage } from '@helm/workflow';
import { createRuntimeForProduct } from './runtime-factory.js';
import { transitionItem } from './item-service.js';
import { getIssueTrackerAdapter, getJobStore, getProductRegistry, getItemStore } from './index.js';
import { readGitHubTokenFromEnv } from '../lib/github-token.js';
import type { Job } from './job-store.js';
import type { ItemState } from './types.js';
import { EXTERNAL_ID_REGEX } from './types.js';
import {
  getReviewDispatchOutbox,
  type PendingExternalReviewIntent,
  type ReviewDispatchIntent,
} from './review-dispatch-outbox.js';
import {
  getExternalReviewReadinessStore,
  isExternalReviewReadinessKeySafe,
  type ExternalReviewReadinessNote,
} from './external-review-readiness.js';
import {
  GitHubPrError,
  getPrimaryCodeRepo,
  parseGitHubRepoUrl,
  resolveOpenPrMetadata,
  resolveOpenPrMetadataForRepo,
} from './github-pr.js';
import { createGitHubBugbotReviewLoader } from './bugbot-review-loader.js';
import { createGitHubCodeRabbitReviewLoader } from './coderabbit-review-loader.js';
import { createGitHubCodexGitHubReviewLoader } from './codex-github-review-loader.js';

const DISPATCH_UNAVAILABLE = 'Unable to schedule dispatch';
export const DUPLICATE_TARGET_REVISION = 'Duplicate target revision';
export const DRAFT_REVIEWER_NO_LONGER_APPLICABLE = 'Draft reviewer no longer applicable';
export const NO_MATCHING_PENDING_EXTERNAL_REVIEW = 'No matching pending external review';
/** Parked early-loop intents may be replayed before the item reaches draft stage. */
const DRAFT_REVIEWER_NOT_YET_APPLICABLE = 'Draft reviewer not yet applicable';

function draftReviewerSkipReason(input: {
  earlyLoopEnabled: boolean;
  itemStage: string;
  draftStage: 'spec-draft' | 'plan-draft';
}): typeof DRAFT_REVIEWER_NO_LONGER_APPLICABLE | typeof DRAFT_REVIEWER_NOT_YET_APPLICABLE | null {
  if (!input.earlyLoopEnabled) return DRAFT_REVIEWER_NO_LONGER_APPLICABLE;
  if (input.itemStage === input.draftStage) return null;
  const itemRank = WORKFLOW_STAGES.indexOf(input.itemStage as WorkflowStage);
  const draftRank = WORKFLOW_STAGES.indexOf(input.draftStage);
  // Unknown stages are treated as past-draft so we clear rather than strand forever.
  if (itemRank < 0 || draftRank < 0) return DRAFT_REVIEWER_NO_LONGER_APPLICABLE;
  if (itemRank < draftRank) return DRAFT_REVIEWER_NOT_YET_APPLICABLE;
  return DRAFT_REVIEWER_NO_LONGER_APPLICABLE;
}

/**
 * Builds the loader deps for the product's configured external reviewer.
 *
 * Exactly one provider is wired per product (ADR-036) — an unset provider, an
 * unknown one, or a missing GitHub token yields `undefined`, which the adapter
 * layer reads as `skipped`.
 */
export function externalReviewDepsForProduct(
  product: Product,
  githubToken: string | undefined,
): RunExternalReviewDeps | undefined {
  if (!githubToken) return undefined;
  const provider = product.review?.external?.provider;
  if (provider === 'bugbot') {
    return { loadBugbotReview: createGitHubBugbotReviewLoader({ product, githubToken }) };
  }
  if (provider === 'coderabbit') {
    return { loadCodeRabbitReview: createGitHubCodeRabbitReviewLoader({ product, githubToken }) };
  }
  if (provider === 'codex-github') {
    return {
      loadCodexGitHubReview: createGitHubCodexGitHubReviewLoader({ product, githubToken }),
    };
  }
  return undefined;
}

function isSafeWorkdirSegment(value: string): boolean {
  return EXTERNAL_ID_REGEX.test(value) && value !== '.' && value !== '..';
}

function logErrorMetadata(scope: string, err: unknown): void {
  const name = err instanceof Error ? err.name : 'Error';
  const code =
    err !== null && typeof err === 'object' && 'code' in err
      ? String((err as NodeJS.ErrnoException).code)
      : 'none';
  console.error(`[${scope}] errorType=${name} errorCode=${code}`);
}

export type ScheduleItemDispatchResult =
  | { scheduled: true; jobId: string }
  | { scheduled: false; reason: string };

function dataRootFromEnv(): string {
  const envDataDir = process.env.HELM_DATA_DIR?.trim();
  return envDataDir || join(process.cwd(), 'data');
}

function parseGitHubPrNumber(prUrl: string | undefined): number | null {
  const match = prUrl?.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)$/);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10);
}

function inferEarlyLoopDraftReviewer(
  product: Product,
  item: ItemState,
): 'spec-draft-reviewer' | 'plan-draft-reviewer' | undefined {
  if (product.review?.early_loop?.enabled !== true) return undefined;
  if (item.currentStage === 'spec-draft') return 'spec-draft-reviewer';
  if (item.currentStage === 'plan-draft') return 'plan-draft-reviewer';
  return undefined;
}

function draftReviewerFromTriggeredBy(
  triggeredBy: string | undefined,
): 'spec-draft-reviewer' | 'plan-draft-reviewer' | undefined {
  if (!triggeredBy) return undefined;
  if (triggeredBy.includes('spec-pr-sync') || triggeredBy.includes('awaiting-spec-draft')) {
    return 'spec-draft-reviewer';
  }
  if (triggeredBy.includes('plan-pr-sync') || triggeredBy.includes('awaiting-plan-draft')) {
    return 'plan-draft-reviewer';
  }
  return undefined;
}

function looksLikeImplReviewTrigger(triggeredBy: string | undefined): boolean {
  if (!triggeredBy) return false;
  return (
    triggeredBy.includes('impl-pr-sync') ||
    triggeredBy.includes('pr-decision-comment') ||
    triggeredBy.includes('implementer') ||
    triggeredBy.includes('reviewer-fanout')
  );
}

function isDraftReviewSpecialist(
  specialistId: string | undefined,
): specialistId is 'spec-draft-reviewer' | 'plan-draft-reviewer' {
  return specialistId === 'spec-draft-reviewer' || specialistId === 'plan-draft-reviewer';
}

function isTerminalPullRequestLookupError(err: unknown): boolean {
  return err instanceof GitHubPrError && err.code === 'pr_not_open';
}

async function inferPendingReviewSpecialist(input: {
  productSlug: string;
  externalId: string;
  specialistId?: string;
}): Promise<string | undefined> {
  if (input.specialistId) return input.specialistId;

  const [products, store] = await Promise.all([
    getProductRegistry(),
    getItemStore(input.productSlug),
  ]);
  const product = products.find((p) => p.product.slug === input.productSlug);
  if (!product) return undefined;
  const item = await store.get(input.externalId);
  if (!item || item.productSlug !== input.productSlug) return undefined;
  return inferEarlyLoopDraftReviewer(product, item);
}

async function resolveReviewDispatchReplaySpecialist(intent: {
  productSlug: string;
  externalId: string;
  specialistId?: string;
  triggeredBy?: string;
}): Promise<string> {
  if (intent.specialistId) return intent.specialistId;

  const fromTrigger = draftReviewerFromTriggeredBy(intent.triggeredBy);
  if (fromTrigger) return fromTrigger;
  if (looksLikeImplReviewTrigger(intent.triggeredBy)) return 'reviewer-fanout';

  return (
    (await inferPendingReviewSpecialist(intent).catch((err) => {
      logErrorMetadata('dispatch pending replay specialist inference', err);
      return undefined;
    })) ?? 'reviewer-fanout'
  );
}

async function persistPendingReviewDispatch(input: {
  dataRoot: string;
  productSlug: string;
  externalId: string;
  specialistId?: string;
  prNumber?: number;
  targetRevision?: string;
  expiresAt?: string;
  triggeredBy: string;
}): Promise<void> {
  const outbox = await getReviewDispatchOutbox(input.dataRoot);
  await outbox.put({
    kind: 'review_dispatch',
    productSlug: input.productSlug,
    externalId: input.externalId,
    specialistId: input.specialistId,
    prNumber: input.prNumber,
    targetRevision: input.targetRevision,
    expiresAt: input.expiresAt,
    triggeredBy: input.triggeredBy,
  });
}

async function persistPendingExternalReview(input: {
  dataRoot: string;
  intent: DeferredExternalReviewIntent;
  triggeredBy: string;
}): Promise<PendingExternalReviewIntent> {
  if (!input.intent.targetRevision) {
    throw new Error('Cannot persist pending external review without target revision');
  }
  const outbox = await getReviewDispatchOutbox(input.dataRoot);
  const now = Date.now();
  const stored = await outbox.put({
    kind: 'pending_external_review',
    productSlug: input.intent.productSlug,
    externalId: input.intent.externalId,
    specialistId: input.intent.specialistId,
    prNumber: input.intent.prNumber,
    targetRevision: input.intent.targetRevision,
    provider: input.intent.provider,
    reason: input.intent.reason,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + input.intent.maxDeferSec * 1000).toISOString(),
    triggeredBy: input.triggeredBy,
  });
  return stored as PendingExternalReviewIntent;
}

/** Exported for webhook handlers that must durable-store before ACK. */
export async function persistReviewDispatchIntent(input: {
  productSlug: string;
  externalId: string;
  specialistId?: string;
  prNumber?: number;
  targetRevision?: string;
  expiresAt?: string;
  triggeredBy: string;
}): Promise<void> {
  await persistPendingReviewDispatch({
    dataRoot: dataRootFromEnv(),
    ...input,
  });
}

export async function resumePendingExternalReview(input: {
  productSlug: string;
  externalId: string;
  specialistId?: string;
  provider: string;
  prNumber: number;
  targetRevision: string;
  triggeredBy: string;
}): Promise<ScheduleItemDispatchResult> {
  const outbox = await getReviewDispatchOutbox(dataRootFromEnv());
  const intent = await outbox.findPendingExternalReview(input);
  if (!intent) {
    return { scheduled: false, reason: NO_MATCHING_PENDING_EXTERNAL_REVIEW };
  }
  return finalizePendingExternalReviewResume(outbox, intent, input.triggeredBy, dataRootFromEnv());
}

/** Look up a pending intent by SHA without scheduling (for webhook preconditions). */
export async function peekPendingExternalReviewByRevision(input: {
  productSlug: string;
  provider: string;
  targetRevision: string;
}): Promise<PendingExternalReviewIntent | null> {
  const outbox = await getReviewDispatchOutbox(dataRootFromEnv());
  return outbox.findPendingExternalReviewByRevision(input);
}

/** Resume when readiness has a SHA but no PR metadata (empty check_run.pull_requests). */
export async function resumePendingExternalReviewByRevision(input: {
  productSlug: string;
  provider: string;
  targetRevision: string;
  triggeredBy: string;
}): Promise<ScheduleItemDispatchResult & { externalId?: string }> {
  const outbox = await getReviewDispatchOutbox(dataRootFromEnv());
  const intent = await outbox.findPendingExternalReviewByRevision(input);
  if (!intent) {
    return { scheduled: false, reason: NO_MATCHING_PENDING_EXTERNAL_REVIEW };
  }
  const outcome = await finalizePendingExternalReviewResume(
    outbox,
    intent,
    input.triggeredBy,
    dataRootFromEnv(),
  );
  return { ...outcome, externalId: intent.externalId };
}

export async function clearPendingExternalReview(input: {
  productSlug: string;
  externalId?: string;
  specialistId?: string;
  provider: string;
  prNumber?: number;
  targetRevision: string;
}): Promise<boolean> {
  return clearPendingExternalReviewIn(await getReviewDispatchOutbox(dataRootFromEnv()), input);
}

/**
 * Same clear, against an explicit outbox. The in-job hook that drops a
 * provisional intent runs with the dispatch context's `dataRoot`, matching the
 * write side, instead of re-reading the environment.
 */
async function clearPendingExternalReviewIn(
  outbox: Awaited<ReturnType<typeof getReviewDispatchOutbox>>,
  input: {
    productSlug: string;
    externalId?: string;
    specialistId?: string;
    provider: string;
    prNumber?: number;
    targetRevision: string;
  },
): Promise<boolean> {
  const intent =
    input.externalId !== undefined && input.prNumber !== undefined
      ? await outbox.findPendingExternalReview({
          productSlug: input.productSlug,
          externalId: input.externalId,
          specialistId: input.specialistId,
          provider: input.provider,
          prNumber: input.prNumber,
          targetRevision: input.targetRevision,
        })
      : await outbox.findPendingExternalReviewByRevision({
          productSlug: input.productSlug,
          provider: input.provider,
          targetRevision: input.targetRevision,
        });
  if (!intent) return false;
  if (input.externalId !== undefined && intent.externalId !== input.externalId) return false;
  if (input.prNumber !== undefined && intent.prNumber !== input.prNumber) return false;
  return outbox.removeIfMatches(intent.productSlug, intent.externalId, {
    kind: 'pending_external_review',
    updatedAt: intent.updatedAt,
    targetRevision: intent.targetRevision,
    specialistId: intent.specialistId,
    provider: intent.provider,
    reason: intent.reason,
    prNumber: intent.prNumber,
  });
}

/** Minimum gap between opportunistic expiry sweeps on the dispatch hot path. */
const PENDING_EXTERNAL_SWEEP_MIN_INTERVAL_MS = 60_000;
let lastPendingExternalSweepAt = 0;

export async function sweepExpiredPendingExternalReviews(): Promise<number> {
  const outbox = await getReviewDispatchOutbox(dataRootFromEnv());
  return outbox.removeExpiredPendingExternalReviews();
}

async function maybeSweepExpiredPendingExternalReviews(): Promise<void> {
  const now = Date.now();
  if (now - lastPendingExternalSweepAt < PENDING_EXTERNAL_SWEEP_MIN_INTERVAL_MS) return;
  lastPendingExternalSweepAt = now;
  await sweepExpiredPendingExternalReviews();
  await (await getExternalReviewReadinessStore(dataRootFromEnv())).removeExpired();
}

const DEFAULT_EXTERNAL_MAX_DEFER_SEC = 30 * 60;

function shortRevision(revision: string): string {
  return revision.slice(0, 12);
}

function isDraftReviewerSpecialist(specialistId: string | undefined): boolean {
  return specialistId === 'spec-draft-reviewer' || specialistId === 'plan-draft-reviewer';
}

/** The repository whose PR an intent reviews: knowledge repo for drafts, code repo otherwise. */
function expectedRepoForIntent(
  product: Product,
  intent: PendingExternalReviewIntent,
): { owner: string; repo: string } | null {
  try {
    return isDraftReviewerSpecialist(intent.specialistId)
      ? parseGitHubRepoUrl(product.knowledge_repo.url)
      : getPrimaryCodeRepo(product);
  } catch {
    return null;
  }
}

/**
 * A readiness note only stands in for the webhook when everything the webhook
 * carried agrees with the intent. Fields the payload lacked (check runs often
 * omit PR metadata) are not checked; fields it had must match.
 */
function readinessNoteMatchesIntent(
  note: ExternalReviewReadinessNote,
  intent: PendingExternalReviewIntent,
  product: Product,
): boolean {
  if (
    note.productSlug !== intent.productSlug ||
    note.provider !== intent.provider ||
    note.targetRevision !== intent.targetRevision
  ) {
    return false;
  }
  if (note.prNumber !== undefined && note.prNumber !== intent.prNumber) return false;
  if (note.owner !== undefined || note.repo !== undefined) {
    const expected = expectedRepoForIntent(product, intent);
    if (!expected || note.owner !== expected.owner || note.repo !== expected.repo) return false;
  }
  if (note.headRef !== undefined) {
    const parsed = parseArtifactBranch(note.headRef);
    const expectedKind =
      intent.specialistId === 'spec-draft-reviewer'
        ? 'spec'
        : intent.specialistId === 'plan-draft-reviewer'
          ? 'plan'
          : 'impl';
    if (parsed?.externalId !== intent.externalId || parsed.kind !== expectedKind) return false;
  }
  return true;
}

/**
 * Replays a recorded readiness note against a pending intent through the same
 * resume path the webhook uses, then drops the note. Returns `null` when the
 * note does not belong to this intent (the note is kept for its own intent).
 */
async function replayReadinessNote(input: {
  dataRoot: string;
  product: Product;
  intent: PendingExternalReviewIntent;
  note: ExternalReviewReadinessNote;
  triggeredBy: string;
}): Promise<ScheduleItemDispatchResult | null> {
  const { intent, note } = input;
  if (!readinessNoteMatchesIntent(note, intent, input.product)) {
    console.info(
      `[dispatch-scheduler] early external review readiness kept — does not match the pending intent for ${intent.externalId}`,
    );
    return null;
  }
  const outbox = await getReviewDispatchOutbox(input.dataRoot);
  const outcome = await finalizePendingExternalReviewResume(
    outbox,
    intent,
    input.triggeredBy,
    input.dataRoot,
  );
  const store = await getExternalReviewReadinessStore(input.dataRoot);
  await store.remove(note);
  console.info(
    `[dispatch-scheduler] early external review readiness replayed for ${intent.externalId} (${note.provider} ${shortRevision(note.targetRevision)}): ${
      outcome.scheduled ? `scheduled ${outcome.jobId}` : outcome.reason
    }`,
  );
  return outcome;
}

export type RecordEarlyExternalReviewReadinessResult =
  | { recorded: false; reason: string }
  | { recorded: true; replayed?: ScheduleItemDispatchResult };

/**
 * Called by the readiness webhook when no pending intent matched its revision
 * (#135, TD-002). The provider can finish before the review loop parks its
 * intent — it starts on the push, and the loop parks only when it enters the
 * external wait. Rather than dropping the signal, keep a short-lived note the
 * loop consumes when it defers on this revision.
 *
 * Write-then-check: after the note is stored, look for an intent once more. The
 * loop's defer hook does the mirror image (write intent, then look for a note),
 * so when the two interleave at least one side sees the other.
 */
export async function recordEarlyExternalReviewReadiness(input: {
  product: Product;
  provider: string;
  targetRevision: string;
  prNumber?: number;
  owner?: string | null;
  repo?: string | null;
  headRef?: string;
  triggeredBy: string;
}): Promise<RecordEarlyExternalReviewReadinessResult> {
  const productSlug = input.product.product.slug;
  if (!isExternalReviewReadinessKeySafe(productSlug, input.provider, input.targetRevision)) {
    console.info('[dispatch-scheduler] early external review readiness not recorded — unsafe key');
    return { recorded: false, reason: 'Unsafe readiness key' };
  }
  const dataRoot = dataRootFromEnv();
  const maxDeferSec =
    input.product.review?.external?.max_defer_sec ?? DEFAULT_EXTERNAL_MAX_DEFER_SEC;
  const now = Date.now();
  const store = await getExternalReviewReadinessStore(dataRoot);
  const note = await store.put({
    productSlug,
    provider: input.provider,
    targetRevision: input.targetRevision,
    ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
    ...(input.owner ? { owner: input.owner } : {}),
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.headRef ? { headRef: input.headRef } : {}),
    receivedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + maxDeferSec * 1000).toISOString(),
  });
  console.info(
    `[dispatch-scheduler] external review readiness recorded before its pending intent (${input.provider} ${shortRevision(input.targetRevision)}) — replayed when the review loop defers on this revision`,
  );

  const outbox = await getReviewDispatchOutbox(dataRoot);
  const intent = await outbox.findPendingExternalReviewByRevision({
    productSlug,
    provider: input.provider,
    targetRevision: input.targetRevision,
  });
  if (!intent) return { recorded: true };
  const replayed = await replayReadinessNote({
    dataRoot,
    product: input.product,
    intent,
    note,
    triggeredBy: `${input.triggeredBy}:recheck`,
  });
  return replayed ? { recorded: true, replayed } : { recorded: true };
}

/**
 * Defer-side half of the rendezvous: the loop just upserted its intent, so a
 * readiness note recorded earlier for this revision is replayed now instead of
 * waiting for a webhook that already came. Best effort — a failure leaves the
 * deferral intact (the next readiness webhook or a re-dispatch still resumes it).
 */
async function replayEarlyReadinessOnDefer(input: {
  dataRoot: string;
  product: Product;
  intent: PendingExternalReviewIntent;
}): Promise<void> {
  try {
    const store = await getExternalReviewReadinessStore(input.dataRoot);
    const note = await store.find({
      productSlug: input.intent.productSlug,
      provider: input.intent.provider,
      targetRevision: input.intent.targetRevision,
    });
    if (!note) return;
    await replayReadinessNote({
      ...input,
      note,
      triggeredBy: 'webhook:external-review-ready:early',
    });
  } catch (err) {
    logErrorMetadata('dispatch early readiness replay', err);
  }
}

/**
 * True when the "duplicate target revision" the scheduler reported is a job
 * that is *still running* on that revision — i.e. the dispatch that parked this
 * pending intent, currently sitting in its external-review wait. A duplicate
 * against a job that already finished means the readiness signal is spent; a
 * duplicate against the running job does not.
 */
async function isRevisionHeldByRunningJob(intent: PendingExternalReviewIntent): Promise<boolean> {
  try {
    const jobStore = await getJobStore();
    const running = await jobStore.getRunningJobForItem(intent.productSlug, intent.externalId);
    return running?.targetRevision === intent.targetRevision;
  } catch (err) {
    logErrorMetadata('dispatch running job lookup', err);
    return false;
  }
}

async function finalizePendingExternalReviewResume(
  outbox: Awaited<ReturnType<typeof getReviewDispatchOutbox>>,
  intent: PendingExternalReviewIntent,
  triggeredBy: string,
  /** Root the parked review_dispatch is written to — the same one `outbox` reads. */
  dataRoot: string,
): Promise<ScheduleItemDispatchResult> {
  const pendingIntentMatch = {
    kind: 'pending_external_review' as const,
    updatedAt: intent.updatedAt,
    targetRevision: intent.targetRevision,
    specialistId: intent.specialistId,
    provider: intent.provider,
    reason: intent.reason,
    prNumber: intent.prNumber,
  };

  if (Date.parse(intent.expiresAt) <= Date.now()) {
    await outbox.removeIfMatches(intent.productSlug, intent.externalId, pendingIntentMatch);
    return { scheduled: false, reason: 'Pending external review expired' };
  }

  const specialistId = await inferPendingReviewSpecialist(intent);
  const outcome = await scheduleItemDispatch({
    productSlug: intent.productSlug,
    externalId: intent.externalId,
    specialistId,
    targetRevision: intent.targetRevision,
    prNumber: intent.prNumber,
    triggeredBy,
  });
  if (outcome.scheduled) {
    await outbox.removeIfMatches(intent.productSlug, intent.externalId, pendingIntentMatch);
    return outcome;
  }
  // Readiness that arrives while the deferring job is still running is reported
  // as a duplicate revision, because that job already holds this revision. It is
  // not spent work — it is the signal that job is waiting for — so it is routed
  // to the same park-and-replay path as a different-revision conflict below.
  const heldByRunningJob =
    outcome.reason === DUPLICATE_TARGET_REVISION && (await isRevisionHeldByRunningJob(intent));
  if (outcome.reason === DUPLICATE_TARGET_REVISION && !heldByRunningJob) {
    await outbox.removeIfMatches(intent.productSlug, intent.externalId, pendingIntentMatch);
    return outcome;
  }
  if (outcome.reason === DRAFT_REVIEWER_NO_LONGER_APPLICABLE) {
    await outbox.removeIfMatches(intent.productSlug, intent.externalId, pendingIntentMatch);
    return outcome;
  }

  // Draft external readiness arrived before the item reached the matching
  // draft stage. Re-park a review_dispatch intent so the next stage-transition
  // replay can resume instead of leaving the pending_external_review stranded
  // until expiry.
  if (outcome.reason === DRAFT_REVIEWER_NOT_YET_APPLICABLE) {
    await persistPendingReviewDispatch({
      dataRoot,
      productSlug: intent.productSlug,
      externalId: intent.externalId,
      specialistId,
      prNumber: intent.prNumber,
      targetRevision: intent.targetRevision,
      triggeredBy: `${triggeredBy}:awaiting-draft-stage`,
    });
    await outbox.removeIfMatches(intent.productSlug, intent.externalId, pendingIntentMatch);
    return {
      scheduled: false,
      reason: 'Draft reviewer not yet applicable — queued review dispatch for stage transition',
    };
  }

  // Readiness arrived while another job is still running (often the deferred
  // job exiting). Park a review_dispatch intent so the post-job replay path
  // schedules fanout after the conflict clears — do not drop the signal.
  if (outcome.reason === DISPATCH_UNAVAILABLE || heldByRunningJob) {
    await persistPendingReviewDispatch({
      dataRoot,
      productSlug: intent.productSlug,
      externalId: intent.externalId,
      specialistId,
      prNumber: intent.prNumber,
      targetRevision: intent.targetRevision,
      triggeredBy: `${triggeredBy}:awaiting-job-exit`,
    });
    await outbox.removeIfMatches(intent.productSlug, intent.externalId, pendingIntentMatch);
    return {
      scheduled: false,
      reason: 'Job already running — queued review dispatch for replay after exit',
    };
  }

  return outcome;
}

async function replayPendingReviewDispatch(input: {
  product: Product;
  productSlug: string;
  externalId: string;
  dataRoot: string;
  githubToken: string | undefined;
}): Promise<void> {
  const githubToken = input.githubToken;
  if (!githubToken) return;
  const outbox = await getReviewDispatchOutbox(input.dataRoot);
  const intents = await outbox.listReviewDispatch(input.productSlug, input.externalId);
  for (const intent of intents) {
    try {
      await replayOnePendingReviewDispatch({ ...input, githubToken, outbox, intent });
    } catch (err) {
      logErrorMetadata('dispatch pending replay intent', err);
    }
  }
}

async function replayOnePendingReviewDispatch(input: {
  product: Product;
  productSlug: string;
  externalId: string;
  dataRoot: string;
  githubToken: string;
  outbox: Awaited<ReturnType<typeof getReviewDispatchOutbox>>;
  intent: ReviewDispatchIntent;
}): Promise<void> {
  const { intent, outbox } = input;
  if ((intent.kind ?? 'review_dispatch') !== 'review_dispatch') return;

  const removeIntent = () =>
    outbox.removeIfMatches(intent.productSlug, intent.externalId, {
      updatedAt: intent.updatedAt,
      targetRevision: intent.targetRevision,
      specialistId: intent.specialistId,
    });
  const reparkDraftIntent = async (updatedTargetRevision: string) => {
    if (!isDraftReviewSpecialist(replaySpecialist)) return;
    // Same specialist-scoped slot is overwritten by put. Removing afterward can
    // delete the freshly written row when updatedAt collides within one ms.
    // Only remove first when migrating legacy/unscoped → specialist-scoped.
    if (intent.specialistId !== replaySpecialist) {
      await removeIntent();
    }
    await outbox.put({
      kind: 'review_dispatch',
      productSlug: intent.productSlug,
      externalId: intent.externalId,
      specialistId: replaySpecialist,
      prNumber: intent.prNumber,
      targetRevision: updatedTargetRevision,
      triggeredBy: `outbox:${intent.triggeredBy}:awaiting-draft-stage`,
    });
  };
  const handleReplayOutcome = async (
    outcome: ScheduleItemDispatchResult,
    updatedTargetRevision: string,
  ) => {
    if (
      outcome.scheduled ||
      outcome.reason === DUPLICATE_TARGET_REVISION ||
      outcome.reason === DRAFT_REVIEWER_NO_LONGER_APPLICABLE
    ) {
      await removeIntent();
      return;
    }
    if (outcome.reason === DRAFT_REVIEWER_NOT_YET_APPLICABLE) {
      await reparkDraftIntent(updatedTargetRevision);
    }
  };

  let targetRevision = intent.targetRevision;
  const replaySpecialist = await resolveReviewDispatchReplaySpecialist(intent);
  if (
    isDraftReviewSpecialist(replaySpecialist) &&
    input.product.review?.early_loop?.enabled !== true
  ) {
    console.info(
      `[dispatch-scheduler] pending replay skipped — ${replaySpecialist} requires review.early_loop.enabled=true`,
    );
    await removeIntent();
    return;
  }
  if (intent.prNumber !== undefined) {
    if (replaySpecialist !== 'reviewer-fanout') {
      const artifactKind =
        replaySpecialist === 'spec-draft-reviewer'
          ? 'spec'
          : replaySpecialist === 'plan-draft-reviewer'
            ? 'plan'
            : undefined;
      if (artifactKind) {
        let pr: Awaited<ReturnType<typeof resolveOpenPrMetadataForRepo>>;
        try {
          pr = await resolveOpenPrMetadataForRepo({
            repo: parseGitHubRepoUrl(input.product.knowledge_repo.url),
            prNumber: intent.prNumber,
            githubToken: input.githubToken,
          });
        } catch (err) {
          if (isTerminalPullRequestLookupError(err)) {
            console.info(
              `[dispatch-scheduler] pending replay skipped — artifact PR #${intent.prNumber} is no longer open`,
            );
            await removeIntent();
            return;
          }
          throw err;
        }
        const expectedHeadRef = `helm/${artifactKind}/${intent.externalId}`;
        if (pr.headRef !== expectedHeadRef) {
          // Never reuse a knowledge-repo PR number against the code repo.
          // Impl intents without a specialistId are routed to reviewer-fanout
          // before this draft branch via looksLikeImplReviewTrigger.
          console.info(
            `[dispatch-scheduler] pending replay skipped — headRef '${pr.headRef}' !== '${expectedHeadRef}'`,
          );
          await removeIntent();
          return;
        }
        targetRevision = pr.headSha;
        if (!targetRevision) return;
        const outcome = await scheduleItemDispatch({
          productSlug: intent.productSlug,
          externalId: intent.externalId,
          specialistId: replaySpecialist,
          targetRevision,
          prNumber: intent.prNumber,
          triggeredBy: `outbox:${intent.triggeredBy}`,
        });
        await handleReplayOutcome(outcome, targetRevision);
        return;
      } else {
        if (!targetRevision) return;
        const outcome = await scheduleItemDispatch({
          productSlug: intent.productSlug,
          externalId: intent.externalId,
          specialistId: replaySpecialist,
          targetRevision,
          prNumber: intent.prNumber,
          triggeredBy: `outbox:${intent.triggeredBy}`,
        });
        await handleReplayOutcome(outcome, targetRevision);
        return;
      }
    }
    if (replaySpecialist === 'reviewer-fanout') {
      let pr: Awaited<ReturnType<typeof resolveOpenPrMetadata>>;
      try {
        pr = await resolveOpenPrMetadata({
          product: input.product,
          prNumber: intent.prNumber,
          githubToken: input.githubToken,
        });
      } catch (err) {
        if (isTerminalPullRequestLookupError(err)) {
          console.info(
            `[dispatch-scheduler] pending replay skipped — implementation PR #${intent.prNumber} is no longer open`,
          );
          await removeIntent();
          return;
        }
        throw err;
      }
      const expectedHeadRef = `helm/impl/${intent.externalId}`;
      if (pr.headRef !== expectedHeadRef) {
        console.info(
          `[dispatch-scheduler] pending replay skipped — headRef '${pr.headRef}' !== '${expectedHeadRef}'`,
        );
        await removeIntent();
        return;
      }
      // Prefer the live PR head so replay tracks the newest SHA after headRef validation.
      targetRevision = pr.headSha;
    }
  }
  if (!targetRevision) return;

  const outcome = await scheduleItemDispatch({
    productSlug: intent.productSlug,
    externalId: intent.externalId,
    specialistId: replaySpecialist,
    targetRevision,
    prNumber: intent.prNumber,
    triggeredBy: `outbox:${intent.triggeredBy}`,
  });
  await handleReplayOutcome(outcome, targetRevision);
}

/** Replay a parked review dispatch after an external state transition. */
export async function replayPendingReviewDispatchForItem(input: {
  product: Product;
  productSlug: string;
  externalId: string;
}): Promise<void> {
  await replayPendingReviewDispatch({
    product: input.product,
    productSlug: input.productSlug,
    externalId: input.externalId,
    dataRoot: dataRootFromEnv(),
    githubToken: readGitHubTokenFromEnv(),
  });
}

async function scheduleReviewAfterImplementerCompletion(input: {
  product: Product;
  item: ItemState;
  dataRoot: string;
  prUrl: string | undefined;
  githubToken: string | undefined;
}): Promise<void> {
  const prNumber = parseGitHubPrNumber(input.prUrl);
  if (!input.githubToken) {
    await persistPendingReviewDispatch({
      dataRoot: input.dataRoot,
      productSlug: input.item.productSlug,
      externalId: input.item.externalId,
      specialistId: 'reviewer-fanout',
      prNumber: prNumber ?? undefined,
      triggeredBy: 'agent:implementer:missing-token',
    });
    return;
  }
  if (prNumber === null) {
    await persistPendingReviewDispatch({
      dataRoot: input.dataRoot,
      productSlug: input.item.productSlug,
      externalId: input.item.externalId,
      specialistId: 'reviewer-fanout',
      triggeredBy: 'agent:implementer:missing-pr-url',
    });
    return;
  }

  try {
    const pr = await resolveOpenPrMetadata({
      product: input.product,
      prNumber,
      githubToken: input.githubToken,
    });
    const expectedHeadRef = `helm/impl/${input.item.externalId}`;
    if (pr.headRef !== expectedHeadRef) {
      await persistPendingReviewDispatch({
        dataRoot: input.dataRoot,
        productSlug: input.item.productSlug,
        externalId: input.item.externalId,
        specialistId: 'reviewer-fanout',
        prNumber,
        triggeredBy: 'agent:implementer:head-ref-mismatch',
      });
      return;
    }
    const outcome = await scheduleItemDispatch({
      productSlug: input.item.productSlug,
      externalId: input.item.externalId,
      specialistId: 'reviewer-fanout',
      targetRevision: pr.headSha,
      prNumber,
      triggeredBy: 'agent:implementer:code-review',
    });
    if (!outcome.scheduled && outcome.reason !== DUPLICATE_TARGET_REVISION) {
      await persistPendingReviewDispatch({
        dataRoot: input.dataRoot,
        productSlug: input.item.productSlug,
        externalId: input.item.externalId,
        specialistId: 'reviewer-fanout',
        prNumber,
        targetRevision: pr.headSha,
        triggeredBy: 'agent:implementer:code-review',
      });
    }
  } catch {
    await persistPendingReviewDispatch({
      dataRoot: input.dataRoot,
      productSlug: input.item.productSlug,
      externalId: input.item.externalId,
      specialistId: 'reviewer-fanout',
      prNumber,
      triggeredBy: 'agent:implementer:lookup-failed',
    });
  }
}

/**
 * Runs a dispatch job asynchronously. Must never throw — a job must never stay
 * stuck in 'running' status.
 */
export async function runDispatchJob(
  job: Job,
  ctx: {
    product: Product;
    item: ItemState;
    workdir: string;
    dataRoot: string;
    specialistId: string | undefined;
    feedback: string | undefined;
    githubToken: string | undefined;
  },
): Promise<void> {
  const jobStore = await getJobStore();
  try {
    const runtime = createRuntimeForProduct(ctx.product, ctx.item.externalId, ctx.workdir);
    const fetchTask = async (
      taskExternalId: string,
    ): Promise<{ title: string; body?: string } | null> => {
      try {
        const adapter = await getIssueTrackerAdapter();
        const trackerItem = await adapter.getItem(taskExternalId);
        if (!trackerItem) return null;
        return { title: trackerItem.title, body: trackerItem.body };
      } catch (err) {
        if (err instanceof GitHubNotFoundError || err instanceof LinearNotFoundError) {
          return null;
        }
        logErrorMetadata('dispatch fetchTask', err);
        throw err;
      }
    };

    // Re-read item state so decisions recorded after enqueue are visible in this run.
    const store = await getItemStore(ctx.item.productSlug);
    const freshItem = (await store.get(ctx.item.externalId)) ?? ctx.item;

    const result = await dispatchStageHandler(
      {
        externalId: freshItem.externalId,
        productSlug: freshItem.productSlug,
        currentStage: freshItem.currentStage,
      },
      ctx.product,
      runtime,
      (transition) => transitionItem({ ...transition, productSlug: freshItem.productSlug }),
      {
        workdir: ctx.workdir,
        dataRoot: ctx.dataRoot,
        specialistId: ctx.specialistId,
        githubToken: ctx.githubToken,
        fetchTask,
        feedback: ctx.feedback,
        resolvedProductDecisions: [...(freshItem.resolvedProductDecisions ?? [])],
        loadResolvedProductDecisions: async () => {
          const latest = await store.get(freshItem.externalId);
          if (latest === null) {
            throw new Error(
              `Item not found while reloading settled decisions: ${freshItem.externalId}`,
            );
          }
          return [...(latest.resolvedProductDecisions ?? [])];
        },
        // ADR-043 §4 — an accept posted while this job runs lands next cycle.
        acceptedFindings: [...(freshItem.acceptedFindings ?? [])],
        loadAcceptedFindings: async () => {
          const latest = await store.get(freshItem.externalId);
          if (latest === null) {
            throw new Error(
              `Item not found while reloading accepted findings: ${freshItem.externalId}`,
            );
          }
          return [...(latest.acceptedFindings ?? [])];
        },
        targetRevision: job.targetRevision,
        // ADR-042 — lifetime review budget: seeded from the item and written
        // back per cycle so a manual re-dispatch cannot restart it at zero.
        reviewLoopLedger: freshItem.reviewLoopLedger,
        persistReviewLoopLedger: async ({ lane, update }) => {
          await store.updateReviewLoopLedger({
            externalId: freshItem.externalId,
            lane,
            update,
            triggeredBy: 'review-loop:cumulative-budget',
          });
        },
        // Provisional park: written before the loop's first provider poll so a
        // readiness webhook that lands mid-poll has an intent to match. Same
        // outbox slot as the defer write below, so that one is an upsert.
        onExternalReviewPending: async (intent) => {
          await persistPendingExternalReview({
            dataRoot: ctx.dataRoot,
            intent,
            triggeredBy: 'external-review:analysis-wait',
          });
        },
        onExternalReviewSettled: async (intent) => {
          const targetRevision = intent.targetRevision;
          if (!targetRevision) return;
          await clearPendingExternalReviewIn(await getReviewDispatchOutbox(ctx.dataRoot), {
            productSlug: intent.productSlug,
            externalId: intent.externalId,
            specialistId: intent.specialistId,
            provider: intent.provider,
            prNumber: intent.prNumber,
            targetRevision,
          });
          // This pass saw the provider finish, so an early readiness note for
          // the revision has nothing left to resume (#135).
          await (
            await getExternalReviewReadinessStore(ctx.dataRoot)
          ).remove({
            productSlug: intent.productSlug,
            provider: intent.provider,
            targetRevision,
          });
        },
        onExternalReviewDeferred: async (intent) => {
          const stored = await persistPendingExternalReview({
            dataRoot: ctx.dataRoot,
            intent,
            triggeredBy: 'external-review:analysis-pending',
          });
          // Readiness may have arrived before any intent existed (#135): replay it.
          await replayEarlyReadinessOnDefer({
            dataRoot: ctx.dataRoot,
            product: ctx.product,
            intent: stored,
          });
        },
        externalReviewDeps: externalReviewDepsForProduct(ctx.product, ctx.githubToken),
      },
    );

    const now = new Date().toISOString();
    await jobStore.updateJob(job.jobId, {
      status: result.status,
      result,
      finishedAt: now,
    });
    try {
      if (
        result.status === 'done' &&
        result.newStage === 'code-review' &&
        ctx.specialistId === 'implementer'
      ) {
        await scheduleReviewAfterImplementerCompletion({
          product: ctx.product,
          item: { ...ctx.item, currentStage: 'code-review' },
          dataRoot: ctx.dataRoot,
          prUrl: result.prUrl,
          githubToken: ctx.githubToken,
        });
      }
      // Always replay parked review_dispatch intents — including after a
      // deferred external-review job — so readiness that raced the exit is not lost.
      await replayPendingReviewDispatch({
        product: ctx.product,
        productSlug: ctx.item.productSlug,
        externalId: ctx.item.externalId,
        dataRoot: ctx.dataRoot,
        githubToken: ctx.githubToken,
      });
    } catch (handoffErr) {
      logErrorMetadata('dispatch review handoff', handoffErr);
    }
  } catch (err) {
    const now = new Date().toISOString();
    const message = err instanceof Error ? err.message : String(err);
    try {
      await jobStore.updateJob(job.jobId, {
        status: 'error',
        error: message,
        finishedAt: now,
      });
    } catch (updateErr) {
      logErrorMetadata('dispatch job update', updateErr);
    }
    try {
      await replayPendingReviewDispatch({
        product: ctx.product,
        productSlug: ctx.item.productSlug,
        externalId: ctx.item.externalId,
        dataRoot: ctx.dataRoot,
        githubToken: ctx.githubToken,
      });
    } catch (replayErr) {
      logErrorMetadata('dispatch pending replay', replayErr);
    }
  }
}

/**
 * Enqueues a background dispatch when preconditions are met. Used by webhook
 * re-dispatch on impl PR synchronize (item must be in `code-review`).
 */
export async function scheduleItemDispatch(input: {
  productSlug: string;
  externalId: string;
  specialistId?: string;
  targetRevision?: string;
  prNumber?: number;
  triggeredBy: string;
}): Promise<ScheduleItemDispatchResult> {
  if (!isSafeWorkdirSegment(input.externalId) || !isSafeWorkdirSegment(input.productSlug)) {
    console.info('[dispatch-scheduler] skip: unsafe path segment in dispatch request');
    return { scheduled: false, reason: DISPATCH_UNAVAILABLE };
  }

  await maybeSweepExpiredPendingExternalReviews();

  const products = await getProductRegistry();
  const product = products.find((p) => p.product.slug === input.productSlug);
  if (!product) {
    console.info(`[dispatch-scheduler] skip: product not found (${input.productSlug})`);
    return { scheduled: false, reason: DISPATCH_UNAVAILABLE };
  }

  const store = await getItemStore(input.productSlug);
  const item = await store.get(input.externalId);
  if (!item || item.productSlug !== input.productSlug) {
    console.info(
      `[dispatch-scheduler] skip: item not found (${input.productSlug}/${input.externalId})`,
    );
    return { scheduled: false, reason: DISPATCH_UNAVAILABLE };
  }

  const requestedSpecialist = input.specialistId ?? inferEarlyLoopDraftReviewer(product, item);
  const resolvedSpecialist = resolveSpecialistId(item.currentStage, requestedSpecialist);
  const dispatchSpecialist = resolvedSpecialist ?? requestedSpecialist;
  const draftReviewerStage =
    dispatchSpecialist === 'spec-draft-reviewer'
      ? 'spec-draft'
      : dispatchSpecialist === 'plan-draft-reviewer'
        ? 'plan-draft'
        : undefined;
  if (draftReviewerStage) {
    const skipReason = draftReviewerSkipReason({
      earlyLoopEnabled: product.review?.early_loop?.enabled === true,
      itemStage: item.currentStage,
      draftStage: draftReviewerStage,
    });
    if (skipReason) {
      console.info(
        `[dispatch-scheduler] skip: ${dispatchSpecialist} ${skipReason} (stage '${item.currentStage}', need '${draftReviewerStage}') (${input.productSlug}/${input.externalId})`,
      );
      return {
        scheduled: false,
        reason: skipReason,
      };
    }
  }
  if (!dispatchSpecialist) {
    console.info(
      `[dispatch-scheduler] skip: no specialist for stage '${item.currentStage}' (${input.productSlug}/${input.externalId})`,
    );
    return {
      scheduled: false,
      reason: DISPATCH_UNAVAILABLE,
    };
  }

  const githubToken = readGitHubTokenFromEnv();
  if (!githubToken) {
    console.error('[dispatch-scheduler] GITHUB_TOKEN is not configured — dispatch skipped');
    if (input.targetRevision || input.prNumber !== undefined) {
      try {
        await persistPendingReviewDispatch({
          dataRoot: dataRootFromEnv(),
          productSlug: input.productSlug,
          externalId: input.externalId,
          specialistId: dispatchSpecialist,
          prNumber: input.prNumber,
          targetRevision: input.targetRevision,
          triggeredBy: input.triggeredBy,
        });
      } catch (err) {
        logErrorMetadata('dispatch-scheduler persist pending (no token)', err);
      }
    }
    return { scheduled: false, reason: DISPATCH_UNAVAILABLE };
  }

  const dataRoot = dataRootFromEnv();
  const workdir = join(dataRoot, 'worktrees', input.productSlug, input.externalId);

  const jobStore = await getJobStore();
  const outcome = await jobStore.createJobIfNoRunning({
    productSlug: input.productSlug,
    externalId: input.externalId,
    specialistId: dispatchSpecialist,
    targetRevision: input.targetRevision,
  });
  if ('duplicate' in outcome) {
    console.info(
      `[dispatch-scheduler] dispatch skipped — target revision already scheduled (${outcome.existingJobId})`,
    );
    return {
      scheduled: false,
      reason: DUPLICATE_TARGET_REVISION,
    };
  }
  if ('conflict' in outcome) {
    if (input.targetRevision || input.prNumber !== undefined) {
      await persistPendingReviewDispatch({
        dataRoot,
        productSlug: input.productSlug,
        externalId: input.externalId,
        specialistId: dispatchSpecialist,
        prNumber: input.prNumber,
        targetRevision: input.targetRevision,
        triggeredBy: input.triggeredBy,
      });
    }
    console.info(
      `[dispatch-scheduler] dispatch skipped — job already running (${outcome.runningJobId})`,
    );
    return {
      scheduled: false,
      reason: DISPATCH_UNAVAILABLE,
    };
  }

  console.info(
    `[dispatch-scheduler] ${input.triggeredBy} → job ${outcome.job.jobId} for ${input.productSlug}/${input.externalId} (${dispatchSpecialist})`,
  );

  void runDispatchJob(outcome.job, {
    product,
    item,
    workdir,
    dataRoot,
    specialistId: dispatchSpecialist,
    feedback: undefined,
    githubToken,
  }).catch((err) => {
    logErrorMetadata('dispatch-scheduler runDispatchJob', err);
  });

  return { scheduled: true, jobId: outcome.job.jobId };
}
