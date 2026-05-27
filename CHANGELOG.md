# Changelog

All notable changes to Helm will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
