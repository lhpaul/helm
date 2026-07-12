import { z } from 'zod';
import { WORKFLOW_STAGES } from '@helm/workflow';

// ── Issue Tracker (discriminated union on `provider`) ────────────────────────

const GitHubProjectsTrackerSchema = z
  .object({
    provider: z.literal('github_projects'),
    org: z.string().min(1),
    project_number: z.number().int().positive(),
    custom_field_name: z.string().default('Helm Stage'),
  })
  .strict();

const LinearTrackerSchema = z
  .object({
    provider: z.literal('linear'),
    api_key_env: z.string().min(1),
    team_key: z.string().min(1),
    webhook_secret_env: z.string().min(1),
  })
  .strict();

const IssueTrackerSchema = z.discriminatedUnion('provider', [
  GitHubProjectsTrackerSchema,
  LinearTrackerSchema,
]);

// ── Code Repo ────────────────────────────────────────────────────────────────

const CodeRepoSchema = z
  .object({
    url: z.string().url(),
    default_branch: z.string().min(1),
    role: z.enum(['app', 'docs', 'infra']),
  })
  .strict();

// ── Workflow ─────────────────────────────────────────────────────────────────
// WORKFLOW_STAGES is the single source of truth — defined in @helm/workflow.

const WorkflowStageSchema = z.enum(WORKFLOW_STAGES);

// ── Specialists ──────────────────────────────────────────────────────────────
// runtime enum (v0: claude_code | codex); extended to deepseek | anthropic_api | ollama in v1+

const SpecialistSchema = z
  .object({
    runtime: z.enum(['claude_code', 'codex']),
    model: z.string().min(1),
    /**
     * Optional reminders injected as a `## Hints` section into this
     * specialist's prompt for this product. Free-form prose; one line per
     * reminder. Use for patterns the specialist tends to miss (e.g. "Pin
     * exact runtime dep versions", "Use singleQuote: true in Prettier").
     *
     * `.trim()` runs before the length check, so a whitespace-only hint is
     * rejected (not silently rendered as an empty bullet) and stored trimmed.
     */
    extra_hints: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  })
  .strict();

const SpecialistsSchema = z
  .object({
    'spec-writer': SpecialistSchema,
    'plan-writer': SpecialistSchema,
    implementer: SpecialistSchema,
    'code-reviewer': SpecialistSchema,
    'security-reviewer': SpecialistSchema,
    'test-reviewer': SpecialistSchema,
    // Early-stage remediators (ADR-024): iterate an already-published spec/plan
    // PR in-place from operator feedback, mirroring the code-review remediation
    // pattern. Each reads its own extra_hints.
    'spec-remediator': SpecialistSchema,
    'plan-remediator': SpecialistSchema,
    // Renamed from `remediation` (ADR-024) so all three remediators form a
    // coherent kebab-case family. The legacy `remediation` key is detected in
    // product-parser with an actionable migration message (mirrors ADR-022).
    'code-remediator': SpecialistSchema,
    /** Optional — when configured, runs before remediation in the review loop (ADR-037). */
    'review-adjudicator': SpecialistSchema.optional(),
  })
  .strict()
  // H1 constraint: the dispatcher creates ONE runtime per product (selected from
  // spec-writer.runtime) and reuses it for every specialist, so all specialists
  // must share the same runtime. Reject mixed runtimes at validation instead of
  // silently running every stage on spec-writer's runtime. Per-specialist
  // runtimes require per-spawn runtime creation — deferred to H3 (see ADR-021).
  .superRefine((specialists, ctx) => {
    const runtimes = new Set(Object.values(specialists).map((s) => s.runtime));
    if (runtimes.size > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['specialists'],
        message:
          `All specialists must use the same runtime (found: ${[...runtimes].sort().join(', ')}). ` +
          `Mixed per-specialist runtimes are not supported yet — the dispatcher uses one runtime ` +
          `per product. See ADR-021.`,
      });
    }
  });

// ── Root Product Schema ───────────────────────────────────────────────────────

export const ProductSchema = z
  .object({
    helm_version: z.literal('0'),
    product: z
      .object({
        slug: z
          .string()
          .min(1)
          .regex(/^[a-z0-9-]+$/, 'must be lowercase alphanumeric with hyphens only'),
        name: z.string().min(1),
      })
      .strict(),
    issue_tracker: IssueTrackerSchema,
    code_repos: z.array(CodeRepoSchema).min(1, 'at least one code_repo is required'),
    knowledge_repo: z
      .object({
        url: z.string().url(),
        default_branch: z.string().min(1),
      })
      .strict(),
    workflow: z
      .object({
        stages_enabled: z.array(WorkflowStageSchema).min(1),
        designer_gate: z.enum(['skip', 'optional', 'required']).default('skip'),
        qa_gate: z.enum(['skip', 'smoke', 'regression']).default('skip'),
        /**
         * Pre-dispatch product-readiness gate (ADR-026). Before running the
         * spec-writer, Helm checks that every app-role code repo carries a
         * README and agent instructions (AGENTS.md / AGENT.md / CLAUDE.md) so
         * the spec-writer fails loudly instead of inventing context.
         *   - `skip`     — no check (default; backward compatible).
         *   - `warn`     — check and log warnings, but proceed with dispatch.
         *   - `required` — block dispatch with 422 + missing_context when not ready.
         */
        readiness_gate: z.enum(['skip', 'warn', 'required']).default('skip'),
        /**
         * Terminal stage for this product (ADR-032). The workflow always has
         * the `merged → released` edge; this field gates whether the product
         * ever fires the release trigger:
         *   - `released` (default) — items advance to `released` once shipped,
         *     via the operator endpoint or the GitHub release.published webhook.
         *   - `merged` — the product has no user-facing release step (e.g. the
         *     playground). Items terminate at `merged`; the release endpoint
         *     returns 409 and the release webhook is a no-op for this product.
         */
        final_stage: z.enum(['merged', 'released']).default('released'),
        /**
         * Per-stage override of the native tracker Status, resolved by Linear
         * workflow-state **id** (ADR-035). Maps a Helm stage to an exact Linear
         * state id, overriding the by-**type** 2-bucket default (ADR-034) for
         * that stage:
         *   - keys are Helm workflow stages (validated against WORKFLOW_STAGES);
         *   - values are Linear workflow-state ids (opaque UUIDs — use the
         *     `list-linear-states` helper to discover them).
         *
         * Unmapped stages, and products without a `native_state_map`, fall back
         * to the by-type default — so this is additive and backward-compatible.
         * Resolved by id (not display name) so it survives a state rename in
         * Linear. Linear-only: ignored for GitHub Projects (native Status
         * mirroring there is still deferred).
         */
        native_state_map: z.record(WorkflowStageSchema, z.string().min(1)).optional(),
      })
      .strict(),
    specialists: SpecialistsSchema,
    notifications: z
      .object({
        slack_webhook: z.string().url().optional(),
      })
      .strict()
      .optional(),
    /**
     * PR review loop configuration (ADR-036). Optional — defaults apply when omitted.
     */
    review: z
      .object({
        external: z
          .object({
            provider: z.enum(['haystack']).optional(),
            haystack: z
              .object({
                major_is_blocking: z.boolean().default(false),
                poll_interval_sec: z.number().int().positive().default(15),
                timeout_sec: z.number().int().positive().default(120),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        loop: z
          .object({
            max_cycles: z.number().int().positive().default(5),
            adjudication: z
              .object({
                enabled: z.boolean().default(true),
              })
              .strict()
              .optional(),
            stop_rule: z
              .object({
                no_progress_cycles: z.number().int().positive().default(2),
              })
              .strict()
              .optional(),
            /** Minimum internal finding severity that triggers remediation (ADR-036 revisit). */
            remediate_severity: z
              .enum(['critical_high', 'medium_and_above'])
              .default('critical_high'),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      data.review?.loop?.adjudication?.enabled === true &&
      !data.specialists['review-adjudicator']
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['review', 'loop', 'adjudication', 'enabled'],
        message:
          'review-adjudicator specialist must be configured when loop adjudication is enabled',
      });
    }
  });

// ── Exported types ────────────────────────────────────────────────────────────

export type Product = z.infer<typeof ProductSchema>;
export type IssueTracker = z.infer<typeof IssueTrackerSchema>;
export type CodeRepo = z.infer<typeof CodeRepoSchema>;
// WorkflowStage is re-exported from @helm/workflow via config/index.ts — not redefined here.
export type Specialist = z.infer<typeof SpecialistSchema>;
