import { z } from 'zod';

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
    workspace: z.string().min(1),
    team_key: z.string().min(1),
    label_prefix: z.string().default('helm:'),
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

const WorkflowStageSchema = z.enum([
  'discovery',
  'spec-draft',
  'spec-ready',
  'plan-draft',
  'plan-ready',
  'in-development',
  'code-review',
  'remediation',
  'released',
]);

// ── Specialists ──────────────────────────────────────────────────────────────
// runtime enum is intentionally narrow in v0; extended to deepseek | anthropic_api | ollama in v1+

const SpecialistSchema = z
  .object({
    runtime: z.enum(['claude_code']),
    model: z.string().min(1),
  })
  .strict();

const SpecialistsSchema = z
  .object({
    spec_writer: SpecialistSchema,
    plan_writer: SpecialistSchema,
    implementer: SpecialistSchema,
    code_reviewer: SpecialistSchema,
    security_reviewer: SpecialistSchema,
    test_reviewer: SpecialistSchema,
    remediation: SpecialistSchema,
  })
  .strict();

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
export type WorkflowStage = z.infer<typeof WorkflowStageSchema>;
export type Specialist = z.infer<typeof SpecialistSchema>;
