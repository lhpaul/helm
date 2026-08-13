import { z } from 'zod';
import { parseArtifactBranch } from '@helm/shared';
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
  comment: z.object({
    body: z.string(),
    user: z.object({ login: z.string() }).optional(),
  }),
  issue: z.object({
    number: z.number().int().positive(),
    pull_request: z.unknown().optional(),
  }),
  repository: z
    .object({
      name: z.string(),
      owner: z.object({ login: z.string() }),
    })
    .optional(),
});

// No .strict() — GitHub adds fields to pull_request objects without notice.
const PullRequestWebhookSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    id: z.number().int().positive().optional(),
    number: z.number().int().positive().optional(),
    merged: z.boolean(),
    head: z.object({
      ref: z.string(),
      sha: z.string().optional(),
      repo: z
        .object({
          name: z.string(),
          owner: z.object({ login: z.string() }),
        })
        .nullable()
        .optional(),
    }),
  }),
  repository: z
    .object({
      name: z.string(),
      owner: z.object({ login: z.string() }),
    })
    .optional(),
  sender: z.object({ login: z.string() }).optional(),
});

// No .strict() — GitHub adds fields to release objects without notice.
const ReleaseWebhookSchema = z.object({
  action: z.string(),
  release: z.object({ tag_name: z.string() }),
});

const CheckRunWebhookSchema = z.object({
  action: z.string(),
  check_run: z.object({
    name: z.string(),
    status: z.string().optional(),
    conclusion: z.string().nullable().optional(),
    head_sha: z.string(),
    app: z.object({ slug: z.string().optional(), name: z.string().optional() }).optional(),
    pull_requests: z
      .array(
        z.object({
          number: z.number().int().positive(),
          head: z.object({ ref: z.string().optional(), sha: z.string().optional() }).optional(),
        }),
      )
      .optional(),
  }),
  repository: z
    .object({
      name: z.string(),
      owner: z.object({ login: z.string() }),
    })
    .optional(),
});

/** Exact check-run name allowlist — never substring-match provider identity. */
const BUGBOT_CHECK_NAMES = new Set([
  'bugbot',
  'bugbot / review',
  'cursor / bugbot',
  'cursor / bugbot review',
  'cursor bugbot',
]);

/**
 * Trusted Bugbot GitHub App identities (slug or display name).
 * Option B trust boundary: readiness requires provider-owned app identity,
 * not a human-readable check name alone.
 */
const BUGBOT_APP_IDENTITIES = new Set([
  'bugbot',
  'cursor',
  'cursor[bot]',
  'cursor bot',
  'cursor bugbot',
  'cursor-ai',
  'cursor-agent',
]);

const NonEmptyString = z.string().trim().min(1);

export type ExternalReviewWebhookTrustConfig = {
  bugbot?: {
    checkNames?: string[];
    trustedAppIdentities?: string[];
  };
  coderabbit?: {
    statusContexts?: string[];
    trustedIdentities?: string[];
  };
};

const StatusWebhookSchema = z
  .object({
    id: z.number().int().optional(),
    sha: NonEmptyString,
    name: z.string().nullable().optional(),
    context: NonEmptyString,
    state: NonEmptyString,
    description: z.string().nullable().optional(),
    target_url: z.string().nullable().optional(),
    url: z.string().optional(),
    avatar_url: z.string().nullable().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    commit: z.unknown().optional(),
    branches: z.unknown().optional(),
    organization: z.unknown().optional(),
    installation: z.unknown().optional(),
    enterprise: z.unknown().optional(),
    sender: z.object({ login: NonEmptyString }).optional(),
    repository: z
      .object({
        name: NonEmptyString,
        owner: z.object({ login: NonEmptyString }),
      })
      .optional(),
  })
  .strict();

const DEFAULT_CODERABBIT_STATUS_CONTEXTS = new Set(['coderabbit']);
const DEFAULT_CODERABBIT_TRUSTED_IDENTITIES = new Set([
  'coderabbitai[bot]',
  'coderabbitai',
  'coderabbitai-pro[bot]',
]);

function normalizedSet(values: string[] | undefined, fallback: Set<string>): Set<string> {
  const normalized = (values ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  return normalized.length > 0 ? new Set(normalized) : fallback;
}

function providerFromTrustedCheckRun(
  name: string,
  appSlug?: string,
  appName?: string,
  trustConfig?: ExternalReviewWebhookTrustConfig,
): string | null {
  const normalizedName = name.trim().toLowerCase();
  const identities = [appSlug, appName]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());
  const bugbotCheckNames = normalizedSet(trustConfig?.bugbot?.checkNames, BUGBOT_CHECK_NAMES);
  if (bugbotCheckNames.has(normalizedName)) {
    const bugbotAppIdentities = normalizedSet(
      trustConfig?.bugbot?.trustedAppIdentities,
      BUGBOT_APP_IDENTITIES,
    );
    return identities.some((identity) => bugbotAppIdentities.has(identity)) ? 'bugbot' : null;
  }
  return null;
}

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
export function parseGitHubWebhook(
  rawEvent: unknown,
  trustConfig?: ExternalReviewWebhookTrustConfig,
): NormalizedEvent {
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
      if (parsed.data.issue.pull_request !== undefined) {
        const repo = parsed.data.repository;
        if (!repo) return { type: 'unknown', raw: rawEvent };
        return {
          type: 'pull_request_comment_created',
          owner: repo.owner.login,
          repo: repo.name,
          prNumber: parsed.data.issue.number,
          body: parsed.data.comment.body,
          authorLogin: parsed.data.comment.user?.login ?? null,
          timestamp,
        };
      }
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
        if (pr.id === undefined) return { type: 'unknown', raw: rawEvent };
        return {
          type: 'pull_request_merged',
          headRef: pr.head.ref,
          owner: parsed.data.repository?.owner.login ?? null,
          repo: parsed.data.repository?.name ?? null,
          prNumber: pr.number ?? null,
          pullRequestId: pr.id ?? null,
          timestamp,
        };
      }
      if (
        action === 'synchronize' ||
        ((action === 'opened' || action === 'reopened') && isEarlyDraftArtifactBranch(pr.head.ref))
      ) {
        return {
          type: 'pull_request_synchronized',
          headRef: pr.head.ref,
          owner: parsed.data.repository?.owner.login ?? null,
          repo: parsed.data.repository?.name ?? null,
          headOwner: pr.head.repo?.owner.login ?? null,
          headRepo: pr.head.repo?.name ?? null,
          prNumber: pr.number,
          headSha: pr.head.sha,
          senderLogin: parsed.data.sender?.login ?? null,
          timestamp,
        };
      }
      return { type: 'unknown', raw: rawEvent };
    }

    if (eventType === 'release') {
      const parsed = ReleaseWebhookSchema.safeParse(payload);
      if (!parsed.success) return { type: 'unknown', raw: rawEvent };
      const { action, release } = parsed.data;
      // Only a published release ships items; drafted/edited/deleted/etc. are noise.
      if (action === 'published') {
        return { type: 'release_published', tag: release.tag_name, timestamp };
      }
      return { type: 'unknown', raw: rawEvent };
    }

    if (eventType === 'check_run') {
      const parsed = CheckRunWebhookSchema.safeParse(payload);
      if (!parsed.success) return { type: 'unknown', raw: rawEvent };
      const { action, check_run: checkRun } = parsed.data;
      if (action !== 'completed' || checkRun.status !== 'completed') {
        return { type: 'unknown', raw: rawEvent };
      }
      if (!['success', 'neutral'].includes(checkRun.conclusion ?? '')) {
        return { type: 'unknown', raw: rawEvent };
      }
      const provider = providerFromTrustedCheckRun(
        checkRun.name,
        checkRun.app?.slug,
        checkRun.app?.name,
        trustConfig,
      );
      if (!provider) return { type: 'unknown', raw: rawEvent };
      const pr = checkRun.pull_requests?.[0];
      // GitHub often omits pull_requests on check_run; still emit readiness so
      // the webhook route can match a pending intent by head SHA alone.
      return {
        type: 'external_review_ready',
        provider,
        owner: parsed.data.repository?.owner.login ?? null,
        repo: parsed.data.repository?.name ?? null,
        ...(pr?.number !== undefined ? { prNumber: pr.number } : {}),
        targetRevision: checkRun.head_sha,
        ...(pr?.head?.ref ? { headRef: pr.head.ref } : {}),
        timestamp,
      };
    }

    if (eventType === 'status') {
      // Option B still applies to generic statuses. Option C: allowlist exact
      // CodeRabbit status context + sender login (statuses have no check app).
      const parsed = StatusWebhookSchema.safeParse(payload);
      if (!parsed.success) return { type: 'unknown', raw: rawEvent };
      const { state, context, sha, sender } = parsed.data;
      if (!['success', 'failure', 'error'].includes(state)) {
        return { type: 'unknown', raw: rawEvent };
      }
      const statusContexts = normalizedSet(
        trustConfig?.coderabbit?.statusContexts,
        DEFAULT_CODERABBIT_STATUS_CONTEXTS,
      );
      if (!statusContexts.has(context.trim().toLowerCase())) {
        return { type: 'unknown', raw: rawEvent };
      }
      const trustedLogins = normalizedSet(
        trustConfig?.coderabbit?.trustedIdentities,
        DEFAULT_CODERABBIT_TRUSTED_IDENTITIES,
      );
      const senderLogin = sender?.login?.trim().toLowerCase() ?? '';
      if (!senderLogin || !trustedLogins.has(senderLogin)) {
        return { type: 'unknown', raw: rawEvent };
      }
      return {
        type: 'external_review_ready',
        provider: 'coderabbit',
        owner: parsed.data.repository?.owner.login ?? null,
        repo: parsed.data.repository?.name ?? null,
        targetRevision: sha,
        timestamp,
      };
    }

    return { type: 'unknown', raw: rawEvent };
  } catch {
    // Never throw — catch any unexpected runtime error
    return { type: 'unknown', raw: rawEvent };
  }
}

function isEarlyDraftArtifactBranch(headRef: string): boolean {
  const parsed = parseArtifactBranch(headRef);
  return parsed?.kind === 'spec' || parsed?.kind === 'plan';
}
