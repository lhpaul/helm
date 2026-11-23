# Local Dev Operations

## API bind address

The API (`apps/api`, port 3001) listens on `127.0.0.1` by default, so only
processes on the same machine can reach it. Loopback is not authentication:
every `/api/*` route except the webhooks, and `/ws`, also require the operator
token (see [API authentication](#api-authentication)).

To listen on another interface, set `HELM_API_HOST` in the API environment and
restart it, for example `HELM_API_HOST=0.0.0.0` (all IPv4 interfaces) or a LAN
address. Empty values use the default. When the host is not a loopback address
the API logs a warning at startup. Prefer a firewall or an authenticated proxy
over exposing the API directly.

The Vite dev proxy (`apps/web`) follows `HELM_API_HOST` from the shell that
starts `pnpm dev`: `127.0.0.1` by default and for `0.0.0.0`, `[::1]` for `::`,
and the given address otherwise. `apps/api/.env` is only read by the API, so
when you override the host there, also export it in the shell (for example
`HELM_API_HOST=192.168.1.10 pnpm dev`).

Anything else that forwards to the API on the same machine (a tunnel, a reverse
proxy) should target `127.0.0.1:3001`. A `localhost` target can resolve to
`::1` first and miss an IPv4-only listener.

## Cross-origin protection

The API rejects browser requests from other sites to its state-changing routes
(#162), so a page open in your browser cannot trigger a dispatch. This guard
runs before [API authentication](#api-authentication) and stays in place with
it. For every `/api/*` request that is not `GET`,
`HEAD` or `OPTIONS`:

- The GitHub and Linear webhooks (`/api/webhooks/github`,
  `/api/webhooks/linear`) are not checked; they are verified by signature.
- With an `Origin` header, the origin must be allowed. `Origin: null` is
  always rejected. The check never trusts the `Host` header.
- Without `Origin`, a `Sec-Fetch-Site` of `cross-site` or `same-site` is
  rejected; `same-origin` and `none` pass.
- With neither header the request passes. Browsers always send `Origin` on
  cross-origin `POST`/`PUT`/`PATCH`/`DELETE`, so this keeps `curl` and scripts
  working without changes.

Rejected requests get `403 {"error":"Cross-origin request rejected"}` and a
warning in the API log.

Allowed origins are the local UI dev server (`http://localhost:5173`,
`http://127.0.0.1:5173`, `http://[::1]:5173`) plus any origin listed in
`HELM_ALLOWED_ORIGINS` (comma-separated, for example
`HELM_ALLOWED_ORIGINS=http://192.168.1.10:5173,https://helm.example.com`).
Entries must be bare `http`/`https` origins (no path, query or wildcard);
invalid entries are ignored with a startup warning. Set it in the API
environment and restart the API. Add the UI origin here when you serve the UI
from another host or port, for example after exposing it with `HELM_API_HOST`
and `vite --host`.

## API authentication

Every `/api/*` route, reads and writes alike, and the `GET /ws` upgrade
require the operator token (#160, ADR-045):

```bash
curl -H "Authorization: Bearer $HELM_API_TOKEN" http://127.0.0.1:3001/api/products
```

- **Not protected:** `GET /health` and the signed webhooks
  (`/api/webhooks/github`, `/api/webhooks/linear`), which keep their signature
  checks. Any other path under `/api/webhooks/` needs the token.
- **Header only:** `Authorization: Bearer <token>` (scheme in any case). Tokens
  in the query string, cookies or other headers are not accepted. The token is
  compared in constant time.
- **Failure:** `401 {"error":"Unauthorized"}` with `WWW-Authenticate: Bearer`,
  and one warning line in the API log with method and path (never the token).

### Configure the token

Set `HELM_API_TOKEN` in the API environment (`apps/api/.env`, through the
`HELM_API_TOKEN=op://…` line of your product input file and `pnpm sync-env`;
see `apps/api/.env.example`) and restart the API. It must have at least 32
characters; generate one with:

```bash
openssl rand -hex 32
```

**Fail closed:** when `HELM_API_TOKEN` is unset, blank or shorter than 32
characters, the API still starts (webhooks and `/health` keep working) but
logs a startup error naming the variable, and every protected route answers
`401`.

### Dashboard

The Vite dev proxy adds `Authorization: Bearer <token>` to the `/api` and
`/ws` requests it forwards when `HELM_API_TOKEN` is set in the shell that runs
`pnpm dev` (Turbo passes it through), as with `HELM_API_HOST`:

```bash
export HELM_API_TOKEN=...   # same value as in apps/api/.env
pnpm dev
```

The token stays in the dev server: it is not a `VITE_` variable and never
reaches the browser or the bundle. Without it, the dashboard loads but shows
errors for every API call. Keep the dev server on `localhost`: with
`vite --host` it would hand the token's authority to your LAN. A UI built and
served elsewhere (`VITE_API_URL`) is not covered; it needs a proxy that adds
the header.

### Rotation

Change the token, restart the API and `pnpm dev`, and update scripts. Only one
token is accepted at a time, so callers with the old token get `401` until
they switch.

### Opt-out (`HELM_API_AUTH=disabled`)

`HELM_API_AUTH=disabled` (case-insensitive) turns authentication off and logs
a warning at every startup. Any other value is ignored with a warning and
authentication stays on. Disabling it reopens every operator read and write
to any client that reaches the API, so use it only on a single-user machine or
for a rollback, and **only after** closing every path to the listener other
than loopback:

- **Public ingress** (tunnel or reverse proxy): confirm from outside that it
  only serves `/api/webhooks/*` and `/health`, or that an authenticated proxy
  is in front of it.
- **Non-loopback bind** (`HELM_API_HOST` set to a LAN or wildcard address):
  move the API back to loopback (unset `HELM_API_HOST` or set it to
  `127.0.0.1`, restart) or block the API port to everything but loopback at
  the host firewall, and confirm from another host that the port is
  unreachable. The ingress rule does not stop direct LAN clients.

Prefer fixing the token over disabling authentication.

## Cost per item (usage records)

Every agent session leaves one usage record on its job (`data/jobs/<jobId>.json`,
field `usage`; ADR-046): item, job, specialist, stage (`spec`, `plan`, `code`,
`review`, taken from the job's specialist), runtime, model, start/end,
duration, tokens and cost. Records hold no prompts, outputs, paths or secrets.
Retention is the same as `data/`; there is no cap.

Read the aggregate (both routes are `GET`, read-only and behind
`HELM_API_TOKEN` like every `/api/*` route; no new variables):

```bash
# One item, with a per-stage breakdown
curl -H "Authorization: Bearer $HELM_API_TOKEN" \
  http://127.0.0.1:3001/api/products/<slug>/items/<externalId>/usage

# A product over a period: from inclusive, to exclusive, ISO date or date-time
curl -H "Authorization: Bearer $HELM_API_TOKEN" \
  "http://127.0.0.1:3001/api/products/<slug>/usage?from=2026-11-01&to=2026-12-01&groupBy=item"

# Same numbers as a table, straight from the job files (no network)
pnpm --filter @helm/api usage -- <slug> [externalId] [--from <iso>] [--to <iso>] [--group-by item|stage|month]
```

`groupBy` is `item`, `stage` or `month`; invalid dates or parameters return
`400`. `from`/`to` filter sessions on the session's start and job-level
figures (`reviewRounds`, `jobsInterrupted`, `jobsNotInstrumented`,
`jobsWithCaptureGaps`) on the job's start, so a job that straddles a boundary
counts its rounds wholly in the period where it started.

How to read it:

- **Unknown is never zero.** A figure the runtime did not report is `null` on
  the record and is left out of the sums. Every total ships with its
  denominator: `tokens.<counter>.sessionsReported`, `costUsd.sessionsWithCost`
  and `costUsd.sessionsUnknown`. Codex reports tokens but no USD, so an
  all-Codex item shows `costUsd.total: 0` with `sessionsUnknown` equal to its
  session count. That `0` means "nothing known", not "free". Codex `input`
  tokens include the cached portion (`cacheRead`).
- **Estimated USD is a separate, labelled block (#168).** `costUsd` is only
  what the runtime reported. `estimatedCostUsd` is computed when the report is
  read, from each session's tokens and model and the per-model price table in
  `apps/api/src/services/usage-price-table.ts` (public list prices, each entry
  with its source URL and date; nothing is stored on the record). It is never
  added to or substituted for `costUsd`, and it appears in the overall block,
  every `byStage` entry and every `groups` entry, each with `priceTable`
  (`version`, `asOf`) and the `note`: _what this usage would cost at public API
  list price, not a billed amount; all cache writes use a single rate_. For
  Codex (subscription) it means the API-list-price equivalent, useful for
  comparison, not for budgeting. It has its own denominator:
  `sessionsEstimated + sessionsNotEstimated = sessions`, independent of
  `costUsd.sessionsWithCost`. A session is not estimated (never `0`) when it
  has no tokens (`noTokens`), no model (`noModel`), several models
  (`multiModel`), a model missing from the table (`noPrice`, listed in
  `unpricedModels`: add a price or an alias), a required counter missing
  (`incompleteTokens`) or inconsistent counters (`inconsistentTokens`); the
  counts per reason are in `notEstimatedReasons`. A bare `total: 0` with
  `sessionsEstimated: 0` means nothing could be estimated. Updating the table
  is a normal PR that cites the source and date; it is reviewed monthly, and
  past estimates move when the table changes (the table version says which).
- **Review rounds** are the sum of `cyclesCompleted` over the item's
  `reviewer-fanout` jobs. Cycles of the early spec/plan review loops are not
  counted as rounds; their sessions count under `spec`/`plan`. Code
  remediation inside the review loop counts as `review`.
- **Gaps are visible.** `jobsInterrupted` counts jobs closed as `orphaned`
  after a restart (the session in flight at that moment leaves no record;
  sessions that had already finished are kept). `jobsNotInstrumented` counts
  jobs written before this feature (no `usage` field; their sessions are not
  known). `jobsWithCaptureGaps` counts jobs where a record could not be
  written. If both the record write and the counter update fail (for example
  an unwritable data directory), only the server log shows it and the
  aggregate cannot report it.
- The external reviewer runs outside Helm's runtimes: the response carries
  `external-review: not measured` instead of a number. Human wait time is not
  measured.

## Recover A Missed Artifact PR Merge

Helm normally advances an item when GitHub delivers a merged pull request webhook
for an artifact branch:

- `helm/spec/<externalId>` advances `spec-draft` to `spec-ready`
- `helm/plan/<externalId>` advances `plan-draft` to `plan-ready`
- `helm/impl/<externalId>` advances `code-review` to `merged`

Use the recovery endpoint when webhook delivery is unavailable, a local/dev merge
was missed, or a prior automatic attempt failed before the item advanced:

```bash
curl -X POST "http://127.0.0.1:3001/api/items/HLM-1/merge-reconciliation" \
  -H "Authorization: Bearer $HELM_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"repository":{"owner":"lhpaul","repo":"helm"},"pullRequestNumber":123}'
```

The endpoint reads the current pull request state from GitHub, verifies that the
PR is merged and uses a supported artifact branch, then runs the same guarded
transition path as the webhook handler. Repeating the same request after success
is safe: Helm returns an already-reconciled no-op and does not append duplicate
history.

## Item storage layout

Workflow state is stored one JSON file per item at
`$HELM_DATA_DIR/items/<productSlug>/<externalId>.json`, so products sharing a data
root never collide on `externalId` (ADR-004). Older flat files
(`items/<externalId>.json`) are moved into their product directory automatically
the first time the server (or the writeback-backfill script) touches the store;
the move is idempotent and never overwrites an existing file. Files that cannot
be migrated safely (invalid JSON, missing/unsafe `productSlug`) stay in place and
are reported in the server log. To roll back, move the files from each
`items/<productSlug>/` directory back up into `items/`.
