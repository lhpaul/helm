import { Hono } from 'hono';
import { z } from 'zod';
import { WORKFLOW_STAGES } from '@helm/workflow';
import { EXTERNAL_ID_REGEX } from '../services/types.js';
import { mapErrorToResponse, validateExternalId } from '../lib/http-errors.js';
import { getItemStore, getProductConfig } from '../services/index.js';
import { createItem, transitionItem } from '../services/item-service.js';
import { readGitHubTokenFromEnv } from '../lib/github-token.js';
import {
  GitHubPullRequestLookupError,
  type GitHubPullRequestLookupErrorCode,
  resolveCurrentPullRequestState,
} from '../services/github-pull-requests.js';
import {
  reconcileMergedArtifactPullRequest,
  reconciliationInputFromCurrentPullRequestState,
} from '../services/merge-reconciliation.js';

// NOTE: No authentication in v0. This server is self-hosted single-user.
// Authentication and authorization enter in v1+ with multi-tenant support.

export const itemsRouter = new Hono();

// ── Request schemas ───────────────────────────────────────────────────────────

const CreateItemBodySchema = z
  .object({
    externalId: z.string().regex(EXTERNAL_ID_REGEX, 'Invalid externalId format'),
    triggeredBy: z.string().min(1),
  })
  .strict();

const TransitionBodySchema = z
  .object({
    toStage: z.enum(WORKFLOW_STAGES),
    triggeredBy: z.string().min(1),
    note: z.string().optional(),
  })
  .strict();

const ReconcilePullRequestBodySchema = z
  .object({
    repository: z
      .object({
        owner: z
          .string()
          .min(1)
          .regex(/^[A-Za-z0-9_.-]+$/),
        repo: z
          .string()
          .min(1)
          .regex(/^[A-Za-z0-9_.-]+$/),
      })
      .strict(),
    pullRequestNumber: z.number().int().positive(),
  })
  .strict();

function mapGitHubPullRequestLookupError(err: GitHubPullRequestLookupError): {
  body: { error: string; code: GitHubPullRequestLookupErrorCode };
  status: 404 | 502 | 503 | 504;
} {
  switch (err.code) {
    case 'not_found':
      return { body: { error: 'Pull request not found', code: err.code }, status: 404 };
    case 'rate_limited':
      return { body: { error: 'GitHub rate limit exceeded', code: err.code }, status: 503 };
    case 'timeout':
      return {
        body: { error: 'GitHub pull request lookup timed out', code: err.code },
        status: 504,
      };
    case 'unauthorized':
    case 'forbidden':
    case 'bad_response':
    case 'upstream_failure':
      return { body: { error: 'Failed to resolve pull request', code: err.code }, status: 502 };
  }
}

// ── Error → HTTP status mapping ───────────────────────────────────────────────
// 400 Bad Request:          Zod validation failure, invalid externalId path param
// 404 Not Found:            ItemNotFoundError
// 409 Conflict:             ItemAlreadyExistsError
// 422 Unprocessable Entity: WorkflowTransitionError (item exists + inputs valid,
//                           but the specific transition is not permitted right now)
// 500 Internal Server Error: product config unavailable, unexpected errors

// ── POST /api/items ───────────────────────────────────────────────────────────

itemsRouter.post('/items', async (c) => {
  const bodyResult = CreateItemBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!bodyResult.success) {
    return c.json({ error: 'Invalid request body', details: bodyResult.error.issues }, 400);
  }

  // productSlug comes from the loaded Product config — NOT from the request body.
  // Callers cannot create items with arbitrary product slugs.
  let productSlug: string;
  try {
    const config = await getProductConfig();
    productSlug = config.product.slug;
  } catch (err) {
    // Log full error server-side for operator diagnostics; return a generic
    // message to the client to avoid leaking filesystem paths or config details.
    console.error('[items] Failed to load product config:', err);
    return c.json({ error: 'Failed to load product config' }, 500);
  }

  try {
    // createItem wraps store.create with best-effort tracker writeback of the
    // initial stage label (ADR-033). API creates are not tracker-originated, so
    // the discovery label is written back.
    const item = await createItem({
      externalId: bodyResult.data.externalId,
      productSlug,
      triggeredBy: bodyResult.data.triggeredBy,
    });
    return c.json(item, 201);
  } catch (err) {
    const mapped = mapErrorToResponse(err);
    // Unrecognised errors keep flowing to Hono's default handler (preserves the
    // existing generic 500). Only the canonical error classes map to JSON here.
    if (mapped.status === 500) throw err;
    return c.json(mapped.body, mapped.status);
  }
});

// ── GET /api/items ────────────────────────────────────────────────────────────

itemsRouter.get('/items', async (c) => {
  const store = await getItemStore();
  const items = await store.list();
  return c.json(items);
});

// ── POST /api/items/:externalId/transitions ───────────────────────────────────

itemsRouter.post('/items/:externalId/transitions', async (c) => {
  const idResult = validateExternalId(c.req.param('externalId'));
  if (!idResult.ok) {
    return c.json(idResult.response.body, idResult.response.status);
  }
  const externalId = idResult.value;

  const bodyResult = TransitionBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!bodyResult.success) {
    return c.json({ error: 'Invalid request body', details: bodyResult.error.issues }, 400);
  }

  try {
    // transitionItem wraps store.transition with best-effort tracker writeback
    // of the new stage (ADR-033).
    const item = await transitionItem({
      externalId,
      toStage: bodyResult.data.toStage,
      triggeredBy: bodyResult.data.triggeredBy,
      note: bodyResult.data.note,
    });
    return c.json(item);
  } catch (err) {
    const mapped = mapErrorToResponse(err);
    if (mapped.status === 500) throw err;
    return c.json(mapped.body, mapped.status);
  }
});

// ── POST /api/items/:externalId/merge-reconciliation ─────────────────────────

itemsRouter.post('/items/:externalId/merge-reconciliation', async (c) => {
  const idResult = validateExternalId(c.req.param('externalId'));
  if (!idResult.ok) {
    return c.json(idResult.response.body, idResult.response.status);
  }
  const externalId = idResult.value;

  const bodyResult = ReconcilePullRequestBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!bodyResult.success) {
    return c.json({ error: 'Invalid request body', details: bodyResult.error.issues }, 400);
  }

  const githubToken = readGitHubTokenFromEnv();
  if (!githubToken) {
    return c.json({ error: 'GITHUB_TOKEN is not configured' }, 503);
  }

  try {
    const pr = await resolveCurrentPullRequestState({
      repository: bodyResult.data.repository,
      pullRequestNumber: bodyResult.data.pullRequestNumber,
      githubToken,
    });
    const result = await reconcileMergedArtifactPullRequest(
      reconciliationInputFromCurrentPullRequestState(pr, externalId),
    );
    return c.json(result);
  } catch (err) {
    if (err instanceof GitHubPullRequestLookupError) {
      console.error('[items] Failed to resolve pull request for merge reconciliation:', err);
      const mapped = mapGitHubPullRequestLookupError(err);
      return c.json(mapped.body, mapped.status);
    }
    const mapped = mapErrorToResponse(err);
    if (mapped.status === 500) throw err;
    return c.json(mapped.body, mapped.status);
  }
});
