# Changelog

All notable changes to Helm will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Monorepo bootstrap: pnpm workspaces + Turborepo, 4 packages (`@helm/api`, `@helm/web`, `@helm/shared`, `@helm/storage` placeholder)
- TypeScript strict shared config (`tsconfig.base.json`), ESLint 9 flat config, Prettier, Vitest, Husky + lint-staged pre-commit hook
- `apps/api`: Hono v4 + Bun with `GET /health` (returns status, version, timestamp, uptime) and `GET /ws` WebSocket endpoint via `hono/bun`
- `apps/web`: React 18 + Vite 5 + Tailwind v4 with WebSocket hook (connects to api `/ws`, displays connection status)
- `HELM_VERSION` constant in `@helm/shared` — consumed by api `/health` and available to web
