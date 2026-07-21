import { Hono } from 'hono';
import {
  verifyGitHubSignature,
  verifyLinearSignature,
  parseGitHubWebhook,
  type NormalizedEvent,
} from '@helm/adapters';
import { WorkflowTransitionError } from '@helm/workflow';
import { parseArtifactBranch } from '@helm/shared';
import { EXTERNAL_ID_REGEX } from '../services/types.js';
import {
  getGitHubAdapter,
  getIssueTrackerAdapter,
  getItemStore,
  getProductConfig,
} from '../services/index.js';
import { createItem, transitionItem } from '../services/item-service.js';
import {
  scheduleItemDispatch,
  persistReviewDispatchIntent,
} from '../services/dispatch-scheduler.js';
import { ItemAlreadyExistsError, ItemNotFoundError } from '../services/errors.js';
import {
  authorHasWriteAccess,
  getPrimaryCodeRepo,
  listPrIssueComments,
  resolveOpenPrMetadata,
} from '../services/github-pr.js';
import { readGitHubTokenFromEnv } from '../lib/github-token.js';
import { reconcileMergedArtifactPullRequest } from '../services/merge-reconciliation.js';

/** GitHub logins that push via Helm orchestration — ignore their PR synchronize webhooks. */
const ORCHESTRATOR_SENDER_LOGINS = new Set(['helm-bot']);

function isOrchestratorSender(login: string | null): boolean {
  return login !== null && ORCHESTRATOR_SENDER_LOGINS.has(login);
}

const PRODUCT_DECISION_MARKER = '<!-- helm:product-decision -->';

type ProductDecisionComment = {
  conflictKind: string;
  conflictTitle: string;
  chosenOption: string;
};

type AdjudicationConflictRecord = ProductDecisionComment & {
  body: string;
};

function fieldFromDecisionBody(body: string, names: string[]): string | null {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = body.match(
      new RegExp(
        `^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*:\\s*(?:\\*\\*)?\\s*(.+?)\\s*(?:\\*\\*)?\\s*$`,
        'im',
      ),
    );
    const value = match?.[1]?.replace(/\*\*$/u, '').trim();
    if (value) return value;
  }
  return null;
}

function conflictFromDecisionMarkdown(
  body: string,
): Pick<ProductDecisionComment, 'conflictKind' | 'conflictTitle'> | null {
  const match = body.match(/^\s*[-*]\s*\*\*(product_decision|doc_conflict)\*\*\s*·\s*(.+?)\s*$/im);
  const conflictKind = match?.[1]?.trim();
  const conflictTitle = match?.[2]?.trim();
  if (!conflictKind || !conflictTitle) return null;
  return { conflictKind, conflictTitle };
}

function conflictFromDecisionField(
  body: string,
): Pick<ProductDecisionComment, 'conflictKind' | 'conflictTitle'> | null {
  const conflict = fieldFromDecisionBody(body, ['Conflict']);
  const match = conflict?.match(/^(product_decision|doc_conflict)\s*(?:·|-|:)\s*(.+?)$/iu);
  const conflictKind = match?.[1]?.trim();
  const conflictTitle = match?.[2]?.trim();
  if (!conflictKind || !conflictTitle) return null;
  return { conflictKind, conflictTitle };
}

function parseProductDecisionComment(body: string): ProductDecisionComment | null {
  if (!body.includes(PRODUCT_DECISION_MARKER)) return null;
  const markdownConflict = conflictFromDecisionMarkdown(body);
  const labeledConflict = conflictFromDecisionField(body);
  const conflictKind =
    markdownConflict?.conflictKind ??
    labeledConflict?.conflictKind ??
    fieldFromDecisionBody(body, ['Conflict kind', 'conflict_kind']);
  const conflictTitle =
    markdownConflict?.conflictTitle ??
    labeledConflict?.conflictTitle ??
    fieldFromDecisionBody(body, ['Conflict title', 'conflict_title']);
  const chosenOption = fieldFromDecisionBody(body, ['Chosen option', 'chosen_option', 'Chosen']);
  if (!conflictKind || !conflictTitle || !chosenOption) return null;
  return { conflictKind, conflictTitle, chosenOption };
}

function normalizeDecisionText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function extractMarkdownSection(body: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = body.match(
    new RegExp(`(?:^|\\n)##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, 'i'),
  );
  return match?.[1]?.trim() ?? '';
}

function adjudicationExternalId(body: string): string | null {
  return body.match(/^#\s+Review Adjudication:\s*(.+?)\s*$/im)?.[1]?.trim() ?? null;
}

function adjudicationStatus(body: string): string | null {
  return (
    extractMarkdownSection(body, 'Status').match(/^(AUTO_REMEDIATE|HUMAN_REQUIRED)\b/i)?.[1] ?? null
  );
}

function parseAdjudicationConflicts(body: string): AdjudicationConflictRecord[] {
  const conflicts = extractMarkdownSection(body, 'Conflicts');
  if (!conflicts) return [];

  const records: AdjudicationConflictRecord[] = [];
  const lines = conflicts.split(/\r?\n/);
  let current: {
    conflictKind: string;
    conflictTitle: string;
    lines: string[];
  } | null = null;

  const flush = () => {
    if (!current) return;
    records.push({
      conflictKind: current.conflictKind,
      conflictTitle: current.conflictTitle,
      chosenOption: '',
      body: current.lines.join('\n'),
    });
  };

  for (const line of lines) {
    const match = line.match(/^\s*-\s*\*\*(product_decision|doc_conflict)\*\*\s*·\s*(.+?)\s*$/i);
    if (match) {
      flush();
      current = {
        conflictKind: match[1] ?? '',
        conflictTitle: match[2]?.trim() ?? '',
        lines: [line],
      };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();

  return records;
}

function productDecisionMatchesAdjudication(
  decision: ProductDecisionComment,
  externalId: string,
  adjudicationBody: string,
): boolean {
  if (adjudicationExternalId(adjudicationBody) !== externalId) return false;
  if (adjudicationStatus(adjudicationBody)?.toUpperCase() !== 'HUMAN_REQUIRED') return false;

  const expectedKind = normalizeDecisionText(decision.conflictKind);
  const expectedTitle = normalizeDecisionText(decision.conflictTitle);
  const expectedOption = normalizeDecisionText(decision.chosenOption);

  return parseAdjudicationConflicts(adjudicationBody).some((record) => {
    return (
      normalizeDecisionText(record.conflictKind) === expectedKind &&
      normalizeDecisionText(record.conflictTitle) === expectedTitle &&
      normalizeDecisionText(record.body).includes(expectedOption)
    );
  });
}

function hasMatchingLatestAdjudication(
  decision: ProductDecisionComment,
  externalId: string,
  commentBodies: string[],
): boolean {
  const latestAdjudication = [...commentBodies]
    .reverse()
    .find((body) => adjudicationExternalId(body) === externalId);
  return latestAdjudication
    ? productDecisionMatchesAdjudication(decision, externalId, latestAdjudication)
    : false;
}

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
  try {
    if (eventType === 'pull_request' || eventType === 'release' || eventType === 'issue_comment') {
      // Tracker-agnostic — pure parser. The knowledge/code repos are always on
      // GitHub regardless of the issue tracker, so PR merge events (helm/spec/*,
      // helm/plan/*, helm/impl/*) AND release.published events must process for
      // Linear products too (a Linear product still ships via GitHub releases).
      event = parseGitHubWebhook({ eventType, payload: body });
    } else {
      // issues / projects_v2_item — require the GitHub Projects
      // adapter. For a non-GitHub-Projects product (e.g. Linear) this is the wrong
      // route: issue events arrive via /api/webhooks/linear. Reject that known
      // misroute explicitly with 400 so GitHub does not retry a permanently-
      // misrouted delivery.
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
  } catch (err) {
    console.error('[webhooks/github] Failed to parse webhook event:', err);
    return c.json({ error: 'Internal server error' }, 500);
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
    try {
      // getProductConfig() is inside the try so a config-load failure is caught
      // and returned as a controlled 500 rather than escaping the handler.
      const config = await getProductConfig();
      // createItem applies writeback, but webhook:github-projects is
      // tracker-originated → anti-echo skips it (the tracker already has the item).
      await createItem({
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
    try {
      // transitionItem applies writeback, but webhook:github-projects is
      // tracker-originated → anti-echo skips it, preventing a tracker→store→
      // tracker echo loop.
      await transitionItem({
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
  } else if (event.type === 'pull_request_comment_created') {
    const decision = parseProductDecisionComment(event.body);
    if (!decision) {
      console.info('[webhooks/github] PR comment ignored — no structured Helm decision');
    } else {
      try {
        const [config, itemStore] = await Promise.all([getProductConfig(), getItemStore()]);
        const repo = getPrimaryCodeRepo(config);
        if (event.owner !== repo.owner || event.repo !== repo.repo) {
          console.info('[webhooks/github] PR decision ignored — repository mismatch');
          return c.json({ processed: true });
        }

        const githubToken = readGitHubTokenFromEnv();
        if (!githubToken) {
          // Without credentials we cannot authorize or resolve the impl item.
          // Return 503 so GitHub retries — do not ACK a droppable decision.
          console.error('[webhooks/github] GITHUB_TOKEN is not configured for PR decision');
          return c.json({ error: 'GITHUB_TOKEN is not configured' }, 503);
        }

        if (!event.authorLogin) {
          console.info('[webhooks/github] PR decision ignored — missing author login');
          return c.json({ processed: true });
        }
        const authorized = await authorHasWriteAccess({
          product: config,
          login: event.authorLogin,
          githubToken,
        });
        if (!authorized) {
          console.info(
            `[webhooks/github] PR decision ignored — unauthorized author '${event.authorLogin}'`,
          );
          return c.json({ processed: true });
        }

        const pr = await resolveOpenPrMetadata({
          product: config,
          prNumber: event.prNumber,
          githubToken,
        });
        if (pr.owner !== event.owner || pr.repo !== event.repo || pr.number !== event.prNumber) {
          console.info('[webhooks/github] PR decision ignored — PR metadata mismatch');
          return c.json({ processed: true });
        }

        const parsed = parseArtifactBranch(pr.headRef);
        if (parsed?.kind !== 'impl') {
          console.info('[webhooks/github] PR decision ignored — PR is not an impl branch');
          return c.json({ processed: true });
        }

        const item = await itemStore.get(parsed.externalId);
        if (item?.productSlug !== config.product.slug || item.currentStage !== 'code-review') {
          console.info(
            `[webhooks/github] PR decision ignored — item stage '${item?.currentStage ?? 'missing'}'`,
          );
          return c.json({ processed: true });
        }

        const comments = await listPrIssueComments({
          product: config,
          prNumber: pr.number,
          githubToken,
        });
        const decisionMatchesRecord = hasMatchingLatestAdjudication(
          decision,
          parsed.externalId,
          comments.map((comment) => comment.body),
        );
        if (!decisionMatchesRecord) {
          console.info('[webhooks/github] PR decision ignored — no matching adjudication record');
          return c.json({ processed: true });
        }

        const outcome = await scheduleItemDispatch({
          productSlug: config.product.slug,
          externalId: parsed.externalId,
          specialistId: 'reviewer-fanout',
          targetRevision: pr.headSha,
          prNumber: pr.number,
          triggeredBy: 'webhook:pr-decision-comment',
        });
        if (!outcome.scheduled && outcome.reason !== 'Duplicate target revision') {
          await persistReviewDispatchIntent({
            productSlug: config.product.slug,
            externalId: parsed.externalId,
            prNumber: pr.number,
            targetRevision: pr.headSha,
            triggeredBy: 'webhook:pr-decision-comment',
          });
          console.info(
            `[webhooks/github] PR decision dispatch deferred for ${parsed.externalId}: ${outcome.reason}`,
          );
        }
      } catch (err) {
        console.error(
          '[webhooks/github] Failed to process PR decision comment:',
          err instanceof Error ? err.message : String(err),
        );
        // Transient failure after an authorized decision — ask GitHub to retry.
        return c.json({ error: 'Temporary failure processing PR decision' }, 503);
      }
    }
  } else if (event.type === 'pull_request_synchronized') {
    if (isOrchestratorSender(event.senderLogin)) {
      console.info(
        `[webhooks/github] impl PR sync ignored — orchestrator sender '${event.senderLogin}'`,
      );
    } else {
      const parsed = parseArtifactBranch(event.headRef);
      if (parsed?.kind === 'impl') {
        try {
          const [itemStore, config] = await Promise.all([getItemStore(), getProductConfig()]);
          const item = await itemStore.get(parsed.externalId);
          if (item?.currentStage === 'code-review') {
            const outcome = await scheduleItemDispatch({
              productSlug: config.product.slug,
              externalId: parsed.externalId,
              specialistId: 'reviewer-fanout',
              targetRevision: event.headSha,
              prNumber: event.prNumber,
              triggeredBy: 'webhook:impl-pr-sync',
            });
            if (!outcome.scheduled && outcome.reason !== 'Duplicate target revision') {
              if (event.headSha || event.prNumber !== undefined) {
                await persistReviewDispatchIntent({
                  productSlug: config.product.slug,
                  externalId: parsed.externalId,
                  prNumber: event.prNumber,
                  targetRevision: event.headSha,
                  triggeredBy: 'webhook:impl-pr-sync',
                });
              }
              console.info(
                `[webhooks/github] impl PR sync for ${parsed.externalId} — dispatch deferred: ${outcome.reason}`,
              );
            }
          } else {
            console.info(
              `[webhooks/github] impl PR sync for ${parsed.externalId} ignored — stage '${item?.currentStage ?? 'missing'}' (expected code-review)`,
            );
          }
        } catch (err) {
          console.error(
            '[webhooks/github] Failed to schedule impl PR sync dispatch:',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
  } else if (event.type === 'pull_request_merged') {
    try {
      await reconcileMergedArtifactPullRequest({
        repository: event.owner && event.repo ? { owner: event.owner, repo: event.repo } : null,
        pullRequestId: event.pullRequestId,
        pullRequestNumber: event.prNumber,
        headRef: event.headRef,
        merged: true,
        source: 'webhook',
      });
    } catch (err) {
      console.error(
        '[webhooks/github] Unexpected error during artifact merge reconciliation:',
        err,
      );
      return c.json({ error: 'Internal server error' }, 500);
    }
  } else if (event.type === 'release_published') {
    // ADR-032: a published GitHub release ships the instance product. Bulk-
    // promote every item currently in `merged` to `released`. Single-product
    // instance, so no repo→product resolution is needed.
    //
    // The whole branch is wrapped: getItemStore()/getProductConfig()/list() run
    // before the per-item guard, so a throw there must still produce controlled
    // logging + a clean 500 rather than escaping to the default handler.
    try {
      const [itemStore, config] = await Promise.all([getItemStore(), getProductConfig()]);

      // Opt-out: a product whose terminal stage is `merged` has no user-facing
      // release step — the release event is a no-op for it.
      if (config.workflow.final_stage === 'merged') {
        console.info(
          `[webhooks/github] release '${event.tag}' ignored — product '${config.product.slug}' has final_stage=merged (no released stage)`,
        );
        return c.json({ processed: true });
      }

      const merged = (await itemStore.list()).filter((item) => item.currentStage === 'merged');
      let promoted = 0;
      for (const item of merged) {
        try {
          // webhook:release is NOT tracker-originated → transitionItem writes the
          // released stage back to the tracker for each promoted item.
          await transitionItem({
            externalId: item.externalId,
            toStage: 'released',
            triggeredBy: 'webhook:release',
          });
          promoted++;
        } catch (err) {
          if (err instanceof WorkflowTransitionError || err instanceof ItemNotFoundError) {
            // Idempotent: the item moved or vanished between list() and transition().
            // Not a delivery problem — log and keep promoting the rest.
            console.error('[webhooks/github] Release promotion not applied:', err.message);
          } else {
            console.error('[webhooks/github] Unexpected error during release promotion:', err);
            return c.json({ error: 'Internal server error' }, 500);
          }
        }
      }
      console.info(
        `[webhooks/github] release '${event.tag}' promoted ${promoted}/${merged.length} merged item(s) → released`,
      );
    } catch (err) {
      console.error('[webhooks/github] Failed to process release_published event:', err);
      return c.json({ error: 'Internal server error' }, 500);
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
    try {
      // webhook:linear is tracker-originated → createItem's writeback is
      // anti-echo-skipped (the issue already exists in Linear).
      await createItem({
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
    try {
      // webhook:linear is tracker-originated → transitionItem's writeback is
      // anti-echo-skipped, preventing a tracker→store→tracker echo loop.
      await transitionItem({
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
