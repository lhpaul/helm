# Changelog

All notable changes to Helm will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Spec merge loop (Session 13):** Helm now automatically advances items from `spec-draft` → `spec-ready` when their spec PR is merged in the knowledge repo. The existing `/api/webhooks/github` endpoint handles `pull_request` events (action `closed` + `merged: true`); when the head branch matches `helm/spec/{externalId}`, the item transitions with `triggeredBy: webhook:knowledge-repo`. Idempotent — duplicate deliveries and already-transitioned items return 200 without error.
- `@helm/shared` exports `specBranchName` / `parseSpecBranch` / `SPEC_BRANCH_PREFIX` — single source of truth for the `helm/spec/` branch naming convention used by both the spec publisher and the webhook handler.
- `NormalizedEvent` extended with `pull_request_merged` variant (`headRef`, `timestamp`) — adapter emits the raw ref; interpretation of Helm-specific conventions is the route's responsibility.
- ADR-010: documents the webhook-based merge detection decision, alternatives considered (polling, new endpoint, payload repo validation), and known limitations.
- Monorepo bootstrap: pnpm workspaces + Turborepo, 4 packages (`@helm/api`, `@helm/web`, `@helm/shared`, `@helm/storage` placeholder)
- TypeScript strict shared config (`tsconfig.base.json`), ESLint 9 flat config, Prettier, Vitest, Husky + lint-staged pre-commit hook
- `apps/api`: Hono v4 + Bun with `GET /health` (returns status, version, timestamp, uptime) and `GET /ws` WebSocket endpoint via `hono/bun`
- `apps/web`: React 18 + Vite 5 + Tailwind v4 with WebSocket hook (connects to api `/ws`, displays connection status)
- `HELM_VERSION` constant in `@helm/shared` — consumed by api `/health` and available to web
