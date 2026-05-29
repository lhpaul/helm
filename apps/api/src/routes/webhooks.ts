import { Hono } from 'hono';
import {
  verifyGitHubSignature,
  verifyLinearSignature,
  parseGitHubWebhook,
  type NormalizedEvent,
} from '@helm/adapters';
import { WorkflowTransitionError, type WorkflowStage } from '@helm/workflow';
import { parseArtifactBranch, type ArtifactBranchKind } from '@helm/shared';
import { EXTERNAL_ID_REGEX } from '../services/types.js';
import {
  getGitHubAdapter,
  getIssueTrackerAdapter,
  getItemStore,
  getProductConfig,
} from '../services/index.js';
import { ItemAlreadyExistsError, ItemNotFoundError } from '../services/errors.js';

// ── Artifact branch routing ───────────────────────────────────────────────────

/** Maps artifact branch kind to the workflow stage it should transition to. */
const ARTIFACT_STAGE_MAP: Record<ArtifactBranchKind, WorkflowStage> = {
  spec: 'spec-ready',
  plan: 'plan-ready',
  impl: 'released',
};

/** Maps artifact branch kind to the triggeredBy source identifier.
 *  spec/plan PRs live in the knowledge repo; impl PRs live in the code repo. */
const ARTIFACT_TRIGGERED_BY_MAP: Record<ArtifactBranchKind, string> = {
  spec: 'webhook:knowledge-repo',
  plan: 'webhook:knowledge-repo',
  impl: 'webhook:code-repo',
};

export const webhooksRouter = new Hono();

webhooksRouter.post('/webhooks/github', async (c) => {
  // a. Guard: secret must be configured before accepting any payload.
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret) {
    console.error('[webhooks/github] GITHUB_WEBHOOK_SECRET is not configured');
    return c.json({ error: 'Webhook endpoint not configured' }, 503);
  }

  // b. Read raw body as text — MUST happen before JSON parse so the original
  //    byte sequence is preserved for signature verification.
  const rawBody = await c.req.text();

  // c. Verify HMAC-SHA256 signature before touching the payload.
  const sigHeader = c.req.header('x-hub-signature-256');
  if (!verifyGitHubSignature(rawBody, sigHeader, secret)) {
    // Return no body — don't leak which check failed.
    return c.body(null, 401);
  }

  // d. JSON parse only after signature is confirmed.
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // e. Parse into a NormalizedEvent.
  const eventType = c.req.header('x-github-event') ?? '';
  let event: NormalizedEvent;
  if (eventType === 'pull_request') {
    // Tracker-agnostic — pure parser. The knowledge/code repos are always on
    // GitHub regardless of the issue tracker, so PR merge events (helm/spec/*,
    // helm/plan/*, helm/impl/*) must process for Linear products too.
    event = parseGitHubWebhook({ eventType, payload: body });
  } else {
    // issues / issue_comment / projects_v2_item — require the GitHub Projects
    // adapter. For a non-GitHub-Projects product (e.g. Linear) this is the wrong
    // route: issue events arrive via /api/webhooks/linear. Reject that known
    // misroute explicitly with 400 so GitHub does not retry a permanently-
    // misrouted delivery. Genuine server-side faults (missing token, internal
    // adapter/parse errors) are NOT caught here — they surface as a framework
    // 500 so the delivery is retried.
    const config = await getProductConfig();
    if (config.issue_tracker.provider !== 'github_projects') {
      console.error(
        `[webhooks/github] Event type '${eventType}' not supported for provider '${config.issue_tracker.provider}'`,
      );
      return c.json(
        {
          error:
            'Event type requires a GitHub Projects product; Linear products receive issue events via /api/webhooks/linear',
        },
        400,
      );
    }
    const adapter = await getGitHubAdapter();
    event = adapter.parseWebhook({ eventType, payload: body });
  }

  // f. Defense-in-depth: validate externalId from webhook payload before using it.
  if (event.type !== 'unknown') {
    const externalId = 'externalId' in event ? event.externalId : null;
    if (typeof externalId === 'string' && !EXTERNAL_ID_REGEX.test(externalId)) {
      console.error(`[webhooks/github] Rejected invalid externalId from event: ${event.type}`);
      // Return 200 — this is not a delivery problem GitHub should retry.
      return c.json({ processed: true });
    }
  }

  // g. Dispatch.
  if (event.type === 'item_created') {
    const [itemStore, config] = await Promise.all([getItemStore(), getProductConfig()]);
    try {
      await itemStore.create({
        externalId: event.externalId,
        productSlug: config.product.slug,
        triggeredBy: 'webhook:github-projects',
      });
    } catch (err) {
      if (err instanceof ItemAlreadyExistsError) {
        // Idempotent — item already exists, treat as success.
      } else {
        console.error('[webhooks/github] Unexpected error creating item:', err);
        return c.json({ error: 'Internal server error' }, 500);
      }
    }
  } else if (event.type === 'item_updated' && event.subStage != null) {
    const itemStore = await getItemStore();
    try {
      await itemStore.transition({
        externalId: event.externalId,
        toStage: event.subStage,
        triggeredBy: 'webhook:github-projects',
      });
    } catch (err) {
      if (err instanceof WorkflowTransitionError || err instanceof ItemNotFoundError) {
        // Not a delivery problem — log and return 200.
        console.error('[webhooks/github] Transition not applied:', err.message);
      } else {
        console.error('[webhooks/github] Unexpected error during transition:', err);
        return c.json({ error: 'Internal server error' }, 500);
      }
    }
  } else if (event.type === 'comment_added') {
    console.info(`[webhooks/github] comment_added on ${event.externalId} — no action in v0`);
  } else if (event.type === 'pull_request_merged') {
    // Interpret the head ref: if it matches a Helm artifact branch prefix
    // (helm/spec/, helm/plan/, helm/impl/), advance the item to the
    // corresponding stage.  Any other branch (feature/, main, …) is silently
    // ignored — it belongs to a different workflow.
    const parsed = parseArtifactBranch(event.headRef);
    if (parsed !== null) {
      const toStage = ARTIFACT_STAGE_MAP[parsed.kind];
      const triggeredBy = ARTIFACT_TRIGGERED_BY_MAP[parsed.kind];
      const itemStore = await getItemStore();
      try {
        await itemStore.transition({
          externalId: parsed.externalId,
          toStage,
          triggeredBy,
        });
      } catch (err) {
        if (err instanceof WorkflowTransitionError || err instanceof ItemNotFoundError) {
          // Not a delivery problem — item may already be in the target stage or
          // may not exist in this Helm instance.  Log and return 200 (idempotent).
          console.error('[webhooks/github] Artifact merge transition not applied:', err.message);
        } else {
          console.error(
            '[webhooks/github] Unexpected error during artifact merge transition:',
            err,
          );
          return c.json({ error: 'Internal server error' }, 500);
        }
      }
    }
  }

  return c.json({ processed: true });
});

// ── POST /api/webhooks/linear ─────────────────────────────────────────────────

webhooksRouter.post('/webhooks/linear', async (c) => {
  // a. Guard: product must use Linear and have a webhook secret configured.
  const config = await getProductConfig();
  if (config.issue_tracker.provider !== 'linear') {
    console.error('[webhooks/linear] Product is not configured with provider linear');
    return c.json({ error: 'Webhook endpoint not configured for this provider' }, 503);
  }

  const secretEnv = config.issue_tracker.webhook_secret_env;
  const secret = process.env[secretEnv]?.trim();
  if (!secret) {
    console.error(`[webhooks/linear] ${secretEnv} is not configured`);
    return c.json({ error: 'Webhook endpoint not configured' }, 503);
  }

  // b. Read raw body as text — MUST happen before JSON parse so the original
  //    byte sequence is preserved for signature verification.
  const rawBody = await c.req.text();

  // c. Verify HMAC-SHA256 signature before touching the payload.
  //    Linear sends the hex digest in Linear-Signature (no prefix).
  const sigHeader = c.req.header('linear-signature');
  if (!verifyLinearSignature(rawBody, sigHeader, secret)) {
    return c.body(null, 401);
  }

  // d. JSON parse only after signature is confirmed.
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // e. Parse into a NormalizedEvent.
  const adapter = await getIssueTrackerAdapter();
  const event = adapter.parseWebhook(body);

  // f. Defense-in-depth: validate externalId from webhook payload before using it.
  if (event.type !== 'unknown') {
    const externalId = 'externalId' in event ? event.externalId : null;
    if (typeof externalId === 'string' && !EXTERNAL_ID_REGEX.test(externalId)) {
      console.error(`[webhooks/linear] Rejected invalid externalId from event: ${event.type}`);
      return c.json({ processed: true });
    }
  }

  // g. Dispatch.
  if (event.type === 'item_created') {
    const itemStore = await getItemStore();
    try {
      await itemStore.create({
        externalId: event.externalId,
        productSlug: config.product.slug,
        triggeredBy: 'webhook:linear',
      });
    } catch (err) {
      if (err instanceof ItemAlreadyExistsError) {
        // Idempotent — item already exists, treat as success.
      } else {
        console.error('[webhooks/linear] Unexpected error creating item:', err);
        return c.json({ error: 'Internal server error' }, 500);
      }
    }
  } else if (event.type === 'item_updated' && event.subStage != null) {
    const itemStore = await getItemStore();
    try {
      await itemStore.transition({
        externalId: event.externalId,
        toStage: event.subStage,
        triggeredBy: 'webhook:linear',
      });
    } catch (err) {
      if (err instanceof WorkflowTransitionError || err instanceof ItemNotFoundError) {
        console.error('[webhooks/linear] Transition not applied:', err.message);
      } else {
        console.error('[webhooks/linear] Unexpected error during transition:', err);
        return c.json({ error: 'Internal server error' }, 500);
      }
    }
  } else if (event.type === 'comment_added') {
    console.info(`[webhooks/linear] comment_added on ${event.externalId} — no action in v0`);
  }

  return c.json({ processed: true });
});
