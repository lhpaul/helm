import { Hono } from 'hono';
import { verifyGitHubSignature } from '@helm/adapters';
import { WorkflowTransitionError, type WorkflowStage } from '@helm/workflow';
import { parseArtifactBranch, type ArtifactBranchKind } from '@helm/shared';
import { EXTERNAL_ID_REGEX } from '../services/types.js';
import { getGitHubAdapter, getItemStore, getProductConfig } from '../services/index.js';
import { ItemAlreadyExistsError, ItemNotFoundError } from '../services/errors.js';

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
  const adapter = await getGitHubAdapter();
  const event = adapter.parseWebhook({ eventType, payload: body });

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
    const ARTIFACT_STAGE_MAP: Record<ArtifactBranchKind, WorkflowStage> = {
      spec: 'spec-ready',
      plan: 'plan-ready',
      impl: 'released',
    };
    // spec and plan PRs live in the knowledge repo; impl PRs live in the code repo.
    const ARTIFACT_TRIGGERED_BY_MAP: Record<ArtifactBranchKind, string> = {
      spec: 'webhook:knowledge-repo',
      plan: 'webhook:knowledge-repo',
      impl: 'webhook:code-repo',
    };

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
