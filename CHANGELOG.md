# Changelog

All notable changes to Helm will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
