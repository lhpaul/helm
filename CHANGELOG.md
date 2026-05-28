# Changelog

All notable changes to Helm will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Linear adapter (Session 20):** Helm can now track issues in Linear as an alternative to GitHub Projects, enabling the MOME pilot.
  - `LinearAdapter` in `packages/adapters/src/linear/` — implements `IssueTrackerAdapter` in full: `ensureSubStages` (creates `helm:*` labels in the configured Linear team), `getItem`, `listItems`, `setSubStage` (swaps `helm:*` labels atomically), `setStatus`, `comment`, `parseWebhook`, and `registerWebhook` (no-op; webhook configured manually in Linear UI per ADR-020).
  - Auth: raw `Authorization: {api_key}` header without `Bearer` prefix — Linear PATs are rejected by `@linear/sdk` and `linear-mcp@1.2.0` because they add the prefix; the adapter uses `fetch` directly with the raw key.
  - `externalId` = Linear `identifier` (e.g. `MOM-123`); adapter maintains an `identifier → UUID` cache for GraphQL mutations.
  - `verifyLinearSignature` — HMAC-SHA256 verification for the `Linear-Signature` header (raw hex, no `sha256=` prefix).
  - `POST /api/webhooks/linear` route — mirrors the GitHub route: signature check, `item_created` → store, `item_updated` with `subStage` → transition, `comment_added` → no-op.
  - `getIssueTrackerAdapter()` factory in `apps/api/src/services/index.ts` — dispatches to `GitHubProjectsAdapter` or `LinearAdapter` based on `product.issue_tracker.provider`; `getGitHubAdapter()` kept for backward compatibility.
  - `IssueTrackerSchema` discriminated union updated: `LinearTrackerSchema` now has `api_key_env`, `team_key`, `webhook_secret_env` (removed old `workspace` / `label_prefix` fields that were pre-draft stubs).

- **Remediation gate (Session 19c):** After the parallel reviewer fan-out, Helm parses severity findings and, when the security or test reviewer reports a CRITICAL or HIGH finding, runs a remediation agent that applies mechanical fixes before the item waits for human merge.
  - `parseFindings(reviewBody)` and the `Findings` type (`{ critical, high, medium, low, info }`) — count `**SEVERITY** ·` tags in a `review.md` body. Robust to surrounding markdown; bare bold (without the `·` separator) is not counted.
  - `ReviewerResult` extended with `findings?` and `commentBody?` — both populated only when a comment was posted, so downstream code can gate on severity and reuse the exact review text.
  - `shouldRemediate(results)` — returns true iff a `security` or `test` reviewer carries `findings.critical > 0 || findings.high > 0`. The code-reviewer is excluded (it already pushes its own fixes per ADR-018); MEDIUM/LOW/INFO never trigger remediation.
  - `remediation.ts` specialist mirroring the implementer: `buildRemediationParams(externalId, product, workspacePath, prUrl, findingsByKind)` injects the security/test review bodies and instructs the agent to write `remediation.md` (Applied/Deferred sections) without committing or pushing; `handleRemediationResult(...)` reads `remediation.md`, pushes via `pushReviewerPatches` as `helm-bot`, appends the commit SHA to the PR comment, and posts it. `REMEDIATION_TIMEOUT_MS` is 15 min (between reviewer 10 min and implementer 20 min). The GitHub token never enters the agent subprocess.
  - `pushReviewerPatches` gained an optional `commitMessage`; remediation passes `chore(remediation): apply fixes for {externalId}` while the code-reviewer keeps its default message.
  - Dispatcher `reviewer-fanout` branch wires the gate: no high findings → item stays in `code-review` (waits for human merge); otherwise `code-review → remediation`, run the agent, then `remediation → code-review` on success. Cost is summed across fan-out + remediation, duration is the max (parallel wall-clock); reviewers are not re-run after remediation, and a remediation failure leaves the item in `remediation`.
  - ADR-019: documents the sec/test-only gate, composite single-Job dispatch, no-reviewer-re-run decision, and gated severities. Opened as PR against the knowledge repo.

- **Real reviewer prompts and code-reviewer push (Session 19b):** Reviewer agents now produce structured findings with severity tags; the code-reviewer can apply mechanical fixes directly to the impl branch.
  - `REVIEW_MD_FORMAT` — canonical `review.md` structure shared across all three reviewer prompts. Each finding carries a `**SEVERITY** ·` tag (followed by a space; `CRITICAL | HIGH | MEDIUM | LOW | INFO`) parseable by the 19c remediation gate. Matches the agent-hq severity-tag convention for zero-translation compatibility.
  - Three real domain-focused prompts in `buildReviewerParams`: **code** (code quality, conventions, anti-patterns, applies mechanical fixes), **security** (injection, auth, secrets, input validation — comment-only), **test** (coverage vs spec ACs, edge cases, test quality — comment-only). All include the spec (if available) and the full `REVIEW_MD_FORMAT` template.
  - `fetchSpecForPlan` called best-effort in `fanoutReviewers` before provisioning workspaces; spec injected into all three reviewer prompts as `## Spec` context. Null return or fetch error → graceful fallback (reviewers run without spec context).
  - `pushReviewerPatches({ externalId, codeRepo, workspacePath, githubToken })` — new helper in `code-workspace.ts`. Stages all changes, commits as `helm-bot` (`chore(review): apply code-reviewer patches for {externalId}`), pushes fast-forward to the remote impl branch. Returns `{ pushed: false }` when workspace is clean (no-op). Token sanitized from all error paths.
  - `handleReviewerResult` wires the push for `kind === 'code'` only: push is attempted before posting the PR comment; if patches were applied, the commit SHA is appended to the comment body. Push failure is non-fatal — comment is still posted, result carries `status: 'error'` and `commentPosted: true`.
  - ADR-018: documents the review format, domain focus decisions, spec injection approach, and single-pusher rationale. Opened as PR against the knowledge repo.

- **Reviewer fan-out foundation (Session 19a):** Helm can now run code, security, and test reviewers in parallel on the open implementation PR when an item reaches `code-review`.
  - `findCodePRUrl({ codeRepo, externalId, githubToken })` — queries `gh pr list` for the open `helm/impl/{externalId}` PR; returns null if not found (GitHub is source of truth, not ItemState).
  - `postPRComment({ prUrl, body, githubToken })` — posts a review comment on the implementation PR as the orchestrator (token never enters agent subprocess).
  - `fanoutReviewers(externalId, product, prUrl, githubToken, runtime)` — provisions three isolated workspaces (one per reviewer kind), spawns code/security/test reviewers in parallel via `Promise.allSettled`, reads each `review.md` produced by the agent, posts it as a PR comment, cleans up all workspaces in `finally`. Single-pusher invariant: only the `code-reviewer` may commit+push patches (TODO 19b); security and test reviewers are comment-only by design.
  - `STAGE_TO_SPECIALIST['code-review'] = 'reviewer-fanout'` — the dispatcher now routes items in `code-review` to the reviewer fan-out. The item stays in `code-review` during the entire fan-out; the remediation gate (Session 19c) decides the next move based on findings severity.
  - `DispatchResult` aggregation: `costUsd` = sum of all reviewer costs; `durationMs` = max of reviewer durations (parallel wall-clock).
  - ADR-017: documents fan-out design decisions. Opened as PR against the knowledge repo.

- **Close release loop (Session 18):** The pipeline is now completable end-to-end — Helm can take an item from `discovery` all the way to `released` without manual intervention.
  - **State machine:** `code-review` now lists `released` as a valid next stage (alongside `in-development` and `remediation`). Previously `released` was unreachable from any automated path.
  - **`ArtifactBranchKind`** extended from `'spec' | 'plan'` to `'spec' | 'plan' | 'impl'`. `parseArtifactBranch` now recognises `helm/impl/{externalId}` branches with the same traversal/injection guards applied to spec and plan branches.
  - **Webhook `pull_request_merged` handler** replaced the previous two-way handling (`spec→spec-ready` | `plan→plan-ready`) with an exhaustive three-way `Record<ArtifactBranchKind, WorkflowStage>` map (`spec→spec-ready`, `plan→plan-ready`, `impl→released`); impl merges use `triggeredBy: 'webhook:code-repo'` while spec/plan retain `'webhook:knowledge-repo'`. TypeScript enforces exhaustiveness at compile time.
  - **Implementer PR body** corrected: "advance the item to **code-review**" → "advance the item to **released**". When the code-repo PR is merged, the webhook now transitions directly to `released`.
  - ADR-016: documents the close-release-loop design decisions. Opened as PR against the knowledge repo.

- **Task ingestion into spec-writer (Session 17):** The spec-writer now reads the issue title and description from the tracker and injects them as a `## Task` section at the top of its prompt, so it specifies the real task rather than inventing a placeholder.
  - `NormalizedItem.body?: string` — optional field added to the tracker-agnostic `NormalizedItem` type. GitHub Issues expose a body; trackers with no description leave it `undefined`.
  - `GET_PROJECT_ITEMS` GraphQL query extended with `body` in the `... on Issue` fragment. `GitHubIssueContent.body: string` added to the GraphQL type. `normalizeItem` in `GitHubProjectsAdapter` propagates `body` to the `NormalizedItem`.
  - `buildSpecWriterPrompt(externalId, product, task?, context?)` — new optional `task?: { title: string; body?: string }` parameter (3rd, before `context`). When present, a `## Task` section is injected and the instruction says "based on the task described above". Missing/empty body falls back to "(no description provided)". When absent, the prompt is unchanged (backward-compatible).
  - `buildSpecWriterParams` passes `task` through to the prompt builder.
  - `DispatchOptions.fetchTask?: (externalId) => Promise<{ title; body? } | null>` — injectable fetch function (same pattern as `transition`). Called best-effort in the spec-writer branch; `null` return or any thrown error → graceful fallback (spec written without `## Task`).
  - `apps/api` `dispatch.ts`: `fetchTask` wired from `getGitHubAdapter().getItem(externalId)`, mapping `NormalizedItem` → `{ title, body }`. Wrapped in best-effort `try/catch` returning `null` on any failure.
  - ADR-015: documents the fetch-at-dispatch decision (Approach B vs persist-at-creation A), the injected-function decoupling pattern, `NormalizedItem.body`, graceful degradation, and spec-only ingestion scope. Opened as PR against the knowledge repo.

- **Implementer hardening (Session 16b):** Robustness and verification improvements on top of the Session 16a implementer foundation.
  - _Transition order fix:_ `provisionCodeWorkspace` now runs **before** the `plan-ready → in-development` transition. A clone/network failure leaves the item in `plan-ready` (re-dispatchable) rather than stuck in `in-development` with no agent and no workspace to clean up. The in-development transition still fires before the agent is spawned, preserving the "work in progress" signal.
  - _Auto-verification prompt:_ `buildImplementerPrompt` instructs the agent to locate test and lint commands (from `AGENT.md`, `CLAUDE.md`, `README.md`, `package.json`, `Makefile`), run them, and not finish until they pass. If green is unachievable the agent must report what is failing, whether it is pre-existing, and what was attempted — not claim success with failing tests.
  - _Timeout increase:_ `IMPLEMENTER_TIMEOUT_MS` raised from 15 to 20 minutes (exported constant) to accommodate test-run time within the implementation phase.
  - _`implementer.test.ts`:_ Dedicated unit tests for `buildImplementerParams` (prompt content, auto-verification instructions, `permissionMode`, model, timeout) and `handleImplementerResult` (success, no publishOpts, agent error/cancelled, no changes, PR failure, transition failure with prUrl preserved).
  - ADR-014: documents the auto-verification-by-prompt decision (including the explicit deferral of an orchestrator-level gate) and the provisioning-before-transition refinement. Opened as PR against the knowledge repo.

- **Implementer execution foundation (Session 16a):** Helm can now spawn an agent to write production code from an approved plan. When an item reaches `plan-ready`, the `implementer` specialist: (1) fetches `plans/{externalId}.md` from the knowledge repo, (2) transitions the item to `in-development`, (3) shallow-clones the primary code repo into an isolated temp directory on the `helm/impl/{externalId}` branch, (4) spawns Claude Code with `bypassPermissions` and a 15-minute timeout, (5) commits and force-pushes all changes as `helm-bot`, opens an idempotent PR, and (6) transitions to `code-review`. GITHUB_TOKEN is scrubbed from the agent subprocess env — the token is used only by the orchestrator for workspace provisioning and PR creation.
- `provisionCodeWorkspace` / `openCodePR` in `@helm/orchestrator` — `code-workspace.ts` provides two composable helpers: shallow-clone + branch-create, and stage-all + commit + push + idempotent-PR. Both share `buildAuthenticatedUrl` / `sanitizeToken` from the new `git-helpers.ts` module.
- `git-helpers.ts` in `@helm/orchestrator` — extracted `RunGit`, `RunGh`, `defaultRunGit`, `defaultRunGh`, `buildAuthenticatedUrl`, `sanitizeToken` from `spec-publisher.ts` into a shared module. `spec-publisher.ts` re-exports `RunGit`/`RunGh` for backward compatibility.
- `fetchPlanForImplementer` in `fetch-product-context.ts` — fetches `plans/{externalId}.md` from the knowledge repo (mirror of `fetchSpecForPlan`; same 32,000-char cap, same traversal guard, null on 404).
- `@helm/shared` exports `IMPL_BRANCH_PREFIX = 'helm/impl/'` and `implBranchName` — single source of truth for `helm/impl/` branch naming alongside spec/plan helpers.
- `SpawnParams` extended with `permissionMode?`, `timeoutMs?`, `env?` — per-spawn overrides for permission mode, timeout, and additional subprocess env vars.
- `buildSubprocessEnv()` in `ClaudeCodeRuntime` — builds a sanitized subprocess env from `process.env` with `GITHUB_TOKEN` and `GH_TOKEN` scrubbed, then merges caller-provided overrides. All spawns now pass this env to the subprocess; the real Bun spawn receives it via the `env` option.
- ADR-013: documents the implementer execution foundation design decisions. Opened as PR against the knowledge repo.

- **Plan merge loop (Session 15):** Helm now automatically advances items from `plan-draft` → `plan-ready` when their plan PR (`helm/plan/{externalId}`) is merged in the knowledge repo. Uses the same `/api/webhooks/github` endpoint and `pull_request_merged` event already handling spec merges. Idempotent — duplicate deliveries and already-transitioned items return 200.
- `parseArtifactBranch` in `@helm/shared` — single generic parser replacing `parseSpecBranch`. Accepts both `helm/spec/` and `helm/plan/` refs; returns `{ kind: 'spec' | 'plan', externalId }` or `null`. Includes the same traversal/injection guards as the predecessor. `parseSpecBranch` removed (no other consumers).
- ADR-012: documents the plan merge loop design and the `parseArtifactBranch` generalization decision. Opened as PR against the knowledge repo (not direct-pushed to main).

- **Plan-writer specialist (Session 14):** Helm now generates implementation plans from approved specs. When an item reaches `spec-ready`, the `plan-writer` specialist fetches the approved spec from the knowledge repo, generates a structured implementation plan (`plans/{externalId}.md`), publishes it as a PR to the knowledge repo (`helm/plan/{externalId}` branch), and advances the item to `plan-draft`. Unlike the spec-writer, the plan-writer requires `GITHUB_TOKEN` (needed to fetch the spec and publish the plan); a missing token or spec is a hard error, not a silent skip.
- `publishPlanToPR` / `publishArtifactToPR` — `spec-publisher.ts` refactored into a generic `publishArtifactToPR(kind)` core parameterised by `ArtifactKind = 'spec' | 'plan'`. All security guarantees (token sanitization, SSH guard, temp-clone isolation, path-traversal validation) apply identically to both kinds. `publishSpecToPR` remains a thin backward-compatible wrapper; `publishPlanToPR` is the new plan wrapper.
- `fetchSpecForPlan` — fetches `specs/{externalId}.md` from the knowledge repo's default branch (32,000-char cap, returns `null` on 404 — callers treat this as a hard error). `fetchRawFile` is now exported for reuse across specialists.
- `@helm/shared` exports `planBranchName` / `PLAN_BRANCH_PREFIX` — single source of truth for `helm/plan/` branch naming alongside the existing spec helpers.
- ADR-011: documents the plan-writer specialist design, publisher generalization, and spec-mandatory-vs-context-best-effort distinction.

- **Spec merge loop (Session 13):** Helm now automatically advances items from `spec-draft` → `spec-ready` when their spec PR is merged in the knowledge repo. The existing `/api/webhooks/github` endpoint handles `pull_request` events (action `closed` + `merged: true`); when the head branch matches `helm/spec/{externalId}`, the item transitions with `triggeredBy: webhook:knowledge-repo`. Idempotent — duplicate deliveries and already-transitioned items return 200 without error.
- `@helm/shared` exports `specBranchName` / `parseSpecBranch` / `SPEC_BRANCH_PREFIX` — single source of truth for the `helm/spec/` branch naming convention used by both the spec publisher and the webhook handler.
- `NormalizedEvent` extended with `pull_request_merged` variant (`headRef`, `timestamp`) — adapter emits the raw ref; interpretation of Helm-specific conventions is the route's responsibility.
- ADR-010: documents the webhook-based merge detection decision, alternatives considered (polling, new endpoint, payload repo validation), and known limitations.
- Monorepo bootstrap: pnpm workspaces + Turborepo, 4 packages (`@helm/api`, `@helm/web`, `@helm/shared`, `@helm/storage` placeholder)
- TypeScript strict shared config (`tsconfig.base.json`), ESLint 9 flat config, Prettier, Vitest, Husky + lint-staged pre-commit hook
- `apps/api`: Hono v4 + Bun with `GET /health` (returns status, version, timestamp, uptime) and `GET /ws` WebSocket endpoint via `hono/bun`
- `apps/web`: React 18 + Vite 5 + Tailwind v4 with WebSocket hook (connects to api `/ws`, displays connection status)
- `HELM_VERSION` constant in `@helm/shared` — consumed by api `/health` and available to web

### Fixed

- **Honest dispatch status (fix/dispatch-status-honesty):** `DispatchResult.status` now reflects the entire pipeline outcome — agent run **plus** post-agent steps (publish, PR creation, stage transition) — not just the raw agent exit code. Previously a `'done'` agent result was forwarded verbatim even when the publish or transition step had failed, causing jobs to report `status: 'done'` with no PR and an item stuck in an intermediate stage.
  - `resolveStatus(agentResult, handlerOutcome)` — new shared helper in `dispatcher.ts`. Rules: agent cancelled/errored → propagate directly; agent done + handler `error` field defined → `'error'`; agent done + handler succeeded → `'done'`. The helper is called in all three specialist branches (spec-writer, plan-writer, implementer).
  - `dispatcher.test.ts` — updated one existing assertion (spec file not created was already an error path but wrongly expected `'done'`); added 6 new test cases: spec-writer transition fails, spec-writer publish clone fails, plan-writer plan file not written, plan-writer publish clone fails, implementer no file changes (the exact e2e scenario that surfaced the bug), and implementer PR opened but code-review transition fails (verifies `prUrl` is preserved in error result).
