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
