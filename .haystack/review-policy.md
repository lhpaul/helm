# Review Policies

## Auth and webhook verification changes
- **Paths**: `apps/api/src/routes/webhooks/**`, `packages/adapters/src/**/webhook*`, `packages/adapters/src/**/github-projects/**`
- **Severity**: critical
- **Reason**: Signature verification and external auth/webhook parsing can appear type-safe in diff but still be bypassed in real integrations; human review is needed to validate end-to-end trust boundaries.

## File persistence concurrency safety
- **Paths**: `apps/api/src/services/item-store.ts`, `packages/storage/**`, `apps/api/src/services/**`
- **Severity**: high
- **Reason**: Small persistence changes can introduce race conditions, partial writes, or silent data corruption that unit tests may miss under real concurrent workloads.

## Automation and CI config edits
- **Paths**: `.github/workflows/**`, `.coderabbit.yaml`, `turbo.json`, `pnpm-workspace.yaml`
- **Severity**: high
- **Reason**: Changes to CI and automation can alter enforcement, release behavior, or repository-wide execution with impact beyond the touched package.

## GitHub GraphQL query limit updates
- **Paths**: `packages/adapters/src/**/graphql-queries.ts`, `packages/adapters/src/**/github-projects/**`
- **Severity**: high
- **Reason**: Query field and pagination limit changes can silently drop required data or create duplicates in production despite passing local tests.

## Instructions
- If a PR changes route request-body parsing, a human must verify malformed JSON and validation failures still return explicit 400 errors rather than silent defaults.
- If a PR adds or modifies ENOENT fallback logic in config or registry loading, a human must confirm only the intended missing-file case is swallowed and all other errors surface.
- If a PR touches stateful async runtime or session lifecycle code, a human must verify terminal-state guards and wait completion guarantees under thrown internal errors.
- If a PR changes create paths in file-backed stores, a human must judge whether atomicity and duplicate-create behavior remain safe under concurrency.
- If a PR changes API routes, adapters, or stores without corresponding updates to their established paired test files, a human must decide whether the unchanged tests still give adequate coverage.
