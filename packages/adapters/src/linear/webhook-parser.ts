import { z } from 'zod';
import { WORKFLOW_STAGES } from '@helm/workflow';
import type { NormalizedEvent } from '../types.js';
import { helmStatusFromStateType } from './graphql-types.js';

// ── Label schema ──────────────────────────────────────────────────────────────

const LabelNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
});

// ── Issue event schema ────────────────────────────────────────────────────────
// No .strict() — Linear adds fields without notice.

const LinearIssueDataSchema = z.object({
  identifier: z.string(),
  labelIds: z.array(z.string()).optional(),
  stateId: z.string().optional(),
  state: z
    .object({
      type: z.string(),
    })
    .optional(),
  labels: z.array(LabelNodeSchema).optional(),
});

const LinearIssueWebhookSchema = z.object({
  action: z.enum(['create', 'update', 'remove']),
  type: z.literal('Issue'),
  data: LinearIssueDataSchema,
  updatedFrom: z
    .object({
      labelIds: z.array(z.string()).optional(),
      stateId: z.string().optional(),
    })
    .optional(),
  createdAt: z.string().optional(),
});

// ── Comment event schema ──────────────────────────────────────────────────────

const LinearCommentDataSchema = z.object({
  body: z.string(),
  issue: z.object({ identifier: z.string() }).optional(),
  issueId: z.string().optional(),
});

const LinearCommentWebhookSchema = z.object({
  action: z.enum(['create', 'update', 'remove']),
  type: z.literal('Comment'),
  data: LinearCommentDataSchema,
  createdAt: z.string().optional(),
});

// ── Top-level type discriminator ──────────────────────────────────────────────

const LinearWebhookTypeSchema = z.object({
  type: z.string(),
  action: z.string(),
});

// ── Helm label prefix ─────────────────────────────────────────────────────────

const HELM_PREFIX = 'helm:';

function extractSubStageFromLabels(
  labels: ReadonlyArray<{ name: string }>,
): (typeof WORKFLOW_STAGES)[number] | null {
  for (const label of labels) {
    if (label.name.startsWith(HELM_PREFIX)) {
      const stage = label.name.slice(HELM_PREFIX.length);
      if ((WORKFLOW_STAGES as ReadonlyArray<string>).includes(stage)) {
        return stage as (typeof WORKFLOW_STAGES)[number];
      }
    }
  }
  return null;
}

/**
 * Parses a raw Linear webhook payload into a Helm NormalizedEvent.
 * Never throws — unrecognised or malformed payloads return { type: 'unknown' }.
 *
 * Linear webhook envelope: { action, type, data, updatedFrom?, createdAt? }
 * - type: 'Issue' | 'Comment' | ...
 * - action: 'create' | 'update' | 'remove'
 * - updatedFrom: previous values for changed fields (present on 'update' action)
 */
export function parseLinearWebhook(rawEvent: unknown): NormalizedEvent {
  try {
    const top = LinearWebhookTypeSchema.safeParse(rawEvent);
    if (!top.success) return { type: 'unknown', raw: rawEvent };

    const timestamp = new Date().toISOString();

    if (top.data.type === 'Issue') {
      const parsed = LinearIssueWebhookSchema.safeParse(rawEvent);
      if (!parsed.success) return { type: 'unknown', raw: rawEvent };

      const { action, data, updatedFrom } = parsed.data;
      const externalId = data.identifier;

      if (action === 'create') {
        return { type: 'item_created', externalId, timestamp };
      }

      if (action === 'update') {
        const changes: {
          subStage?: (typeof WORKFLOW_STAGES)[number] | null;
          status?: 'open' | 'closed';
        } = {};

        // Detect label change: updatedFrom.labelIds differs from current data.labelIds
        const labelsChanged =
          updatedFrom?.labelIds !== undefined &&
          JSON.stringify([...(data.labelIds ?? [])].sort()) !==
            JSON.stringify([...(updatedFrom.labelIds ?? [])].sort());

        if (labelsChanged && data.labels) {
          changes.subStage = extractSubStageFromLabels(data.labels);
        }

        // Detect state change: updatedFrom.stateId differs from current data.stateId
        const stateChanged =
          updatedFrom?.stateId !== undefined && updatedFrom.stateId !== data.stateId;

        if (stateChanged && data.state) {
          changes.status = helmStatusFromStateType(data.state.type);
        }

        if (Object.keys(changes).length === 0) {
          return { type: 'unknown', raw: rawEvent };
        }

        return { type: 'item_updated', externalId, ...changes, timestamp };
      }

      return { type: 'unknown', raw: rawEvent };
    }

    if (top.data.type === 'Comment') {
      const parsed = LinearCommentWebhookSchema.safeParse(rawEvent);
      if (!parsed.success) return { type: 'unknown', raw: rawEvent };

      const { action, data } = parsed.data;
      if (action !== 'create') return { type: 'unknown', raw: rawEvent };

      // Issue identifier is nested in data.issue.identifier
      const externalId = data.issue?.identifier;
      if (!externalId) return { type: 'unknown', raw: rawEvent };

      return { type: 'comment_added', externalId, body: data.body, timestamp };
    }

    return { type: 'unknown', raw: rawEvent };
  } catch {
    return { type: 'unknown', raw: rawEvent };
  }
}
