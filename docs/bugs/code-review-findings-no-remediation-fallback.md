# Bug: code-reviewer findings have no remediation safety net

**Status:** open
**Severity:** HIGH — code-reviewer findings silently survive when the
code-reviewer does not self-apply fixes; the PR looks remediated but the
code-review HIGHs remain.
**Discovered:** 2026-06-01, Arriendo Fácil pilot, item LEA-104, PR
`lhpaul/leasity-tenants#3`.
**Components:** `packages/orchestrator/src/specialists/reviewer-fanout.ts`,
`packages/orchestrator/src/specialists/remediation.ts`,
`packages/orchestrator/src/specialists/code-workspace.ts`
(`pushReviewerPatches`).

> **Note:** an earlier draft of this doc claimed a single-pusher _race_ that
> lost the remediation commit. That was wrong — it was diagnosed from a stale
> local clone. After fetching, the branch is linear and the remediation commit
> landed correctly. The real bug is narrower (see below).

## Symptom

After `reviewer-fanout` ran on LEA-104:

- Security reviewer: APPROVED.
- Test reviewer: 1 HIGH (PGlite, not real PostgreSQL) + 1 MEDIUM (narrow
  isolation coverage). **Both were remediated correctly.**
- Code reviewer: 2 HIGH (tenant email not unique; money helper not
  currency-aware and reused for `area`). **Neither was remediated.**

The item transitioned `code-review → remediation → code-review` and looked done.
The two code-review HIGHs are still present at branch HEAD (`55f4c00`):

- `packages/db/src/schema/tenants.ts:9` — `email: text('email').notNull()` with
  no unique constraint (`z.email()` is format-only, not uniqueness).
- `packages/db/src/schema/shared.ts:31` — `moneyAmountColumn` returns a
  hard-coded `numeric(14, 2)`; `packages/db/src/schema/properties.ts:47` uses it
  for `areaSquareMeters` (area is not money).

## Evidence

Branch `helm/impl/LEA-104` is **linear** (no divergence, no lost commit):

```
55f4c00 chore(remediation): apply fixes for LEA-104     ← tip; real test fixes
382675e chore(review): apply code-reviewer patches      ← review.md only (leak)
77287ff feat: implement LEA-104
```

- `55f4c00` (remediation) touched `packages/db/test/fixture.ts` (+153,
  PGlite→PostgreSQL), `packages/db/test/database.test.ts` (+264, isolation
  matrix), `packages/db/README.md`, and `remediation.md` (+18). The test-review
  findings were genuinely fixed.
- `382675e` (code-reviewer) changed **only `review.md`** (`+6 / -8`). The
  code-reviewer applied no source fixes; its `review.md` artifact is the entire
  commit.
- The code-review HIGHs were never addressed by anything on the branch.

## Root cause

Code-review findings have **no remediation fallback**:

1. The **code-reviewer is expected to self-apply** its mechanical fixes via
   `pushReviewerPatches` during the fan-out. When it instead only writes
   `review.md` (no source edits), its findings are not fixed by anyone.
2. The **remediation specialist only ingests security + test findings**
   (`remediation.ts:74` — `for (const kind of ['security', 'test'] as const)`).
   It never receives code-review findings, so it cannot pick up the slack.
3. Nothing detects the gap. `pushReviewerPatches` happily commits the
   `review.md`-only "patch" (`382675e`) and reports success, so the remediation
   gate treats the code-reviewer as handled.

Net: when the code-reviewer fails to self-apply, its HIGH findings silently
survive review.

### Secondary bug — `pushReviewerPatches` commits scratch artifacts

`code-workspace.ts:510` runs `git add -A`, which stages the reviewer/remediation
agent's own summary file (`review.md` / `remediation.md`, written into the
workspace root). So:

- a code-reviewer that changed no source still produces a commit (`382675e`)
  containing only `review.md`; and
- the remediation commit carries `remediation.md` into the code repo.

These scratch files should never land in the impl branch.

## Proposed fix

1. **Feed code-review findings into the remediation specialist**, or give the
   remediation gate a way to confirm code-review findings were actually
   addressed (e.g. require the code-reviewer commit to touch source, not just
   `review.md`). Without this, code-review HIGHs can pass through unfixed.
2. **Stop committing scratch artifacts.** Write `review.md` / `remediation.md`
   outside the workspace (or `.git/info/exclude` them) and stage only real
   source changes. If there are no code changes, return `{ pushed: false }` and
   post a comment-only review — no empty artifact commit.

## State of LEA-104 at time of writing

- Test-review findings: fixed (on branch).
- Code-review HIGHs: **still open** — `tenants.email` uniqueness and the money
  helper / `area` misuse need fixing before merge.
- Branch tree also contains the `review.md` / `remediation.md` scratch artifacts
  (secondary bug above).
- **No force-reset of the branch** — it holds the good remediation fixes. Clean
  up only the scratch artifacts and apply the two remaining code fixes.
