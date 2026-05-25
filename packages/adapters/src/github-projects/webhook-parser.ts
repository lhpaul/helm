import { z } from 'zod';
import type { NormalizedEvent } from '../types.js';

// ── Context schema ────────────────────────────────────────────────────────────
// The webhook route bundles header + body into this shape before calling parseWebhook.

const WebhookContextSchema = z.object({
  eventType: z.string(),
  payload: z.unknown(),
});

// ── Event schemas (no .strict() — GitHub adds fields without notice) ──────────

const IssuesWebhookSchema = z.object({
  action: z.string(),
  issue: z.object({
    number: z.number().int().positive(),
    node_id: z.string(),
  }),
});

const IssueCommentWebhookSchema = z.object({
  action: z.literal('created'),
  comment: z.object({ body: z.string() }),
  issue: z.object({ number: z.number().int().positive() }),
});

// No .strict() — GitHub adds fields to pull_request objects without notice.
const PullRequestWebhookSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    merged: z.boolean(),
    head: z.object({ ref: z.string() }),
  }),
});

// ── Pure parser (handles issues.* and issue_comment.*) ───────────────────────

/**
 * Parses a GitHub webhook event into a Helm NormalizedEvent.
 *
 * Expects rawEvent to be { eventType: string, payload: unknown } —
 * constructed by the webhook route from X-GitHub-Event header + parsed body.
 *
 * Never throws — unrecognised or malformed payloads return { type: 'unknown' }.
 * projects_v2_item.* events are handled by GitHubProjectsAdapter.parseWebhook
 * which has access to the internal option/node-ID maps.
 */
export function parseGitHubWebhook(rawEvent: unknown): NormalizedEvent {
  try {
    const ctx = WebhookContextSchema.safeParse(rawEvent);
    if (!ctx.success) return { type: 'unknown', raw: rawEvent };

    const { eventType, payload } = ctx.data;
    const timestamp = new Date().toISOString();

    if (eventType === 'issues') {
      const parsed = IssuesWebhookSchema.safeParse(payload);
      if (!parsed.success) return { type: 'unknown', raw: rawEvent };
      const { action, issue } = parsed.data;
      const externalId = `issue_${issue.number}`;

      if (action === 'opened') {
        return { type: 'item_created', externalId, timestamp };
      }
      if (action === 'closed') {
        return { type: 'item_updated', externalId, status: 'closed', timestamp };
      }
      if (action === 'reopened') {
        return { type: 'item_updated', externalId, status: 'open', timestamp };
      }
      return { type: 'unknown', raw: rawEvent };
    }

    if (eventType === 'issue_comment') {
      const parsed = IssueCommentWebhookSchema.safeParse(payload);
      if (!parsed.success) return { type: 'unknown', raw: rawEvent };
      return {
        type: 'comment_added',
        externalId: `issue_${parsed.data.issue.number}`,
        body: parsed.data.comment.body,
        timestamp,
      };
    }

    if (eventType === 'pull_request') {
      const parsed = PullRequestWebhookSchema.safeParse(payload);
      if (!parsed.success) return { type: 'unknown', raw: rawEvent };
      const { action, pull_request: pr } = parsed.data;
      // Only a closed+merged PR is actionable; any other action is noise.
      if (action === 'closed' && pr.merged === true) {
        return { type: 'pull_request_merged', headRef: pr.head.ref, timestamp };
      }
      return { type: 'unknown', raw: rawEvent };
    }

    return { type: 'unknown', raw: rawEvent };
  } catch {
    // Never throw — catch any unexpected runtime error
    return { type: 'unknown', raw: rawEvent };
  }
}
