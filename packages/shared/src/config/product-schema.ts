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
    remediation: SpecialistSchema,
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
      })
      .strict(),
    specialists: SpecialistsSchema,
    notifications: z
      .object({
        slack_webhook: z.string().url().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// ── Exported types ────────────────────────────────────────────────────────────

export type Product = z.infer<typeof ProductSchema>;
export type IssueTracker = z.infer<typeof IssueTrackerSchema>;
export type CodeRepo = z.infer<typeof CodeRepoSchema>;
// WorkflowStage is re-exported from @helm/workflow via config/index.ts — not redefined here.
export type Specialist = z.infer<typeof SpecialistSchema>;
