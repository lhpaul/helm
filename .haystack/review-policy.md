# Review Policies

## Dispatch route and runtime lifecycle changes
- **Paths**: `apps/api/src/routes/dispatch.ts`, `packages/orchestrator/**`
- **Severity**: high
- **Reason**: Dispatch and runtime lifecycle changes can introduce hung waits, duplicate job execution, or incorrect failure handling that unit tests may miss without end-to-end scenario judgment.

## Filesystem persistence semantics
- **Paths**: `packages/api/src/**/item-store*`, `packages/storage/**`, `apps/api/src/**/jobs*`
- **Severity**: high
- **Reason**: Small persistence changes can break atomicity, error contracts, or path-safety under real concurrency and production data layouts in ways static checks cannot fully validate.

## GitHub adapter and webhook handling
- **Paths**: `packages/adapters/src/github-projects/**`, `apps/api/src/routes/webhooks*`, `packages/adapters/src/**/webhook*`
- **Severity**: critical
- **Reason**: Webhook verification and external API pagination/parsing mistakes can silently drop events or accept untrusted input; correctness depends on integration behavior AI cannot fully simulate.

## Instructions
- If a change removes or weakens a validation guard, fallback boundary, or defensive copy, require human review to confirm the new risk tradeoff is intentional.
- If a PR changes whether failures are surfaced to clients versus hidden behind generic responses, require human judgment on operability, security, and API contract impact.
- If file-not-found fallback behavior is broadened beyond a narrowly owned file boundary, require human review to ensure missing-dependency errors are not being masked.
- If GraphQL pagination/window limits are changed, require human review to confirm required fields still load completely for real repositories and account types.
- If `apps/api/src/routes/dispatch.ts` changes without corresponding updates to `apps/api/src/routes/dispatch.test.ts`, require human review before approval.
