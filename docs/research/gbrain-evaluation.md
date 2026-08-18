# Research note: gbrain (garrytan/gbrain) — what Helm should take from it

**Status:** Complete — recommendation recorded, no implementation.
**Date:** 2026-08-18
**Issue:** [lhpaul/helm#81](https://github.com/lhpaul/helm/issues/81)
**Scope:** Comparison and prioritization only. No architecture change, no
dependency, no workflow change. Follow-ups below are _proposals_, not filed
items.
**Subject reviewed:** [`garrytan/gbrain`](https://github.com/garrytan/gbrain) @
`master`, read 2026-08-18 (MIT, TypeScript/Bun, created 2026-04-05, actively
pushed the day of review, ~28.7k stars).

---

## 1. What gbrain is, and what it is not

gbrain is a **personal/company knowledge brain for agents**: a daemon plus CLI
plus MCP server that ingests a person's world (meetings, email, X, calendar,
voice), files it as markdown pages in a private git repo, derives a Postgres or
PGLite index over that markdown, and answers questions with _synthesized, cited
prose_ rather than a ranked list of chunks. Its two differentiators, per its own
[README](https://github.com/garrytan/gbrain/blob/master/README.md), are a
synthesis layer that returns an answer plus an explicit statement of what the
brain does _not_ know yet, and a self-wiring typed knowledge graph built on every
page write with no LLM calls. A nightly "dream cycle" plus ~20 cron jobs keep the
corpus enriched, consolidated, and de-stale-ified while the operator sleeps.

gbrain is **not** a development workflow orchestrator. It has no notion of a
spec, a plan, an implementation gate, a reviewer, a tracker item, or a merge. It
is the memory layer _underneath_ an agent, and it is explicitly positioned as a
retrieval upgrade for coding agents ("your coding agent stops being amnesiac
about everything that isn't code") — the layer Helm currently fills with a
knowledge repo read by convention. The overlap with Helm is therefore narrow and
specific: **how durable knowledge is stored, retrieved, attributed, and kept
honest** — not how work moves from idea to merged PR. One documentation
expectation from the issue is worth correcting up front: gbrain's `DESIGN.md` is
a _UI design system_ for its admin SPA (color tokens, type scale, chart
renderers), not an architecture document. The architecture lives in
[`CLAUDE.md`](https://github.com/garrytan/gbrain/blob/master/CLAUDE.md) and
[`docs/architecture/`](https://github.com/garrytan/gbrain/tree/master/docs/architecture).

## 2. The one real gap this investigation surfaced

Worth stating plainly, because it is the reason several rows below are "adapt"
rather than "discard": **Helm does not currently read most of the knowledge
surfaces ADR-007 promises it reads.**

`packages/orchestrator/src/specialists/fetch-product-context.ts` materializes
exactly four things into a specialist worktree: the code repo's `README.md` and
its agent-instructions file (each truncated to 2 000 chars), plus
`specs/{externalId}.md` and `plans/{externalId}.md` fetched by path convention
from the knowledge repo. `strategy.md`, `learnings/`, `decisions/`, and `wiki/`
are named in ADR-007 as inputs to Spec Writer, Plan Writer, and Implementer, and
no code path fetches any of them. ADR-007 anticipated this exact failure —
"Specialists need retrieval discipline; dumping every file into context will
waste tokens" — and left the retrieval side unbuilt. gbrain's answer to that
problem (a resolver: a routing table that says which document to load when a
task of type X appears) is the single most directly transferable idea in the
repo, and it needs no gbrain code to apply.

## 3. Verdict by capability

| Capability                                                                                                                                                                                | Verdict                                     | Why                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Resolver — "task type X → load document Y first"** ([`THIN_HARNESS_FAT_SKILLS.md`](https://github.com/garrytan/gbrain/blob/master/docs/ethos/THIN_HARNESS_FAT_SKILLS.md), Definition 3) | **Adapt the idea**                          | Closes the §2 gap with a lookup table, not an index. Highest value per unit of work in this whole review.                                                                                                                                                                                                                                                                              |
| **Executable eval floors** ([BrainBench](https://github.com/garrytan/gbrain/blob/master/docs/eval/BRAINBENCH.md))                                                                         | **Adapt the idea**                          | The transferable mechanic is governance, not the metrics: expectations _pre-registered before the first run_, floors asserted as a test against the committed baseline, and an explicit "a threshold violation can no longer be banked by blessing a new baseline". Helm's external-review contract (ADR-036) is exactly the kind of thing that decays without this.                   |
| **Seam disclosure in benchmark rows** (BrainBench `seam` column: production vs contract)                                                                                                  | **Adapt the idea**                          | Every row states whether it exercised shipped code or a simulated contract, with the deviations listed. Directly applicable to how Helm reports dogfood evidence (cf. #100). Cheap, purely a reporting discipline.                                                                                                                                                                     |
| **Source attribution / citation discipline** ([`source-attribution.md`](https://github.com/garrytan/gbrain/blob/master/docs/guides/source-attribution.md))                                | **Adapt the idea**                          | Every claim carries who/where/when, with a source-priority order and an explicit rule to record conflicts rather than silently resolve them. Helm's `learnings/` entries have no provenance contract; a one-line "captured from item X, PR Y, finding Z" header is the 90% version.                                                                                                    |
| **Gap analysis — say what the corpus does _not_ know**                                                                                                                                    | **Adapt the idea**                          | The "heads up: nothing has been added since April 22" move maps onto the spec-writer's open-questions section and the readiness gate (ADR-026): naming missing context beats silently drafting around it.                                                                                                                                                                              |
| **Contradiction probe** ([`contradictions.md`](https://github.com/garrytan/gbrain/blob/master/docs/contradictions.md))                                                                    | **Adapt the idea (low priority)**           | Two principles carry over to the review adjudicator (ADR-037/041): the probe **never mutates** — it emits paste-ready commands and lets the operator decide — and findings carry a severity rubric plus a confidence interval, with an explicit "n < 30 is too small to act on". The LLM-judge machinery itself is not worth rebuilding.                                               |
| **System-of-record contract** ([`system-of-record.md`](https://github.com/garrytan/gbrain/blob/master/docs/architecture/system-of-record.md))                                             | **Already held — borrow the CI gate later** | gbrain's rule ("the repo is the system of record, the DB is a derived cache, we rebuild rather than back up") _is_ ADR-007 rule 5. The part Helm does not have is the enforcement: a CI gate that fails any PR adding a direct write to a derived table outside the reconciler. Only relevant if Helm ever builds the index ADR-007 leaves open — file it against that day, not today. |
| **Self-wiring knowledge graph (typed entity edges)**                                                                                                                                      | **Discard for now**                         | Helm's corpus is a few hundred reviewed markdown files with stable path conventions and an issue ID as the join key. Typed edges across people/companies solve a problem Helm's `specs/{id}.md` ↔ `plans/{id}.md` ↔ tracker item convention already solves. Revisit only if the knowledge repo outgrows path lookup.                                                                   |
| **Synthesis layer (answer-with-citations over the corpus)**                                                                                                                               | **Discard for now**                         | Real value, wrong altitude: it needs the index, the embeddings, and the enrichment pipeline underneath. The cheap 80% is the resolver row above.                                                                                                                                                                                                                                       |
| **Dream cycle / cron consolidation**                                                                                                                                                      | **Discard for now**                         | Helm's `pulse-reports/` already occupies the "periodic operational rollup" slot, and the nightly-daemon shape assumes a hosted server and a metered API budget that v0 deliberately does not have. The genuinely appealing sub-idea — consolidating scattered `learnings/` into durable ones — is a workflow change needing its own ADR, not a borrow.                                 |
| **Takes vs facts epistemology** ([`takes-vs-facts.md`](https://github.com/garrytan/gbrain/blob/master/docs/takes-vs-facts.md))                                                            | **Discard**                                 | A two-tier belief store (who believes what, with weight and time) is meaningful for a brain modelling people. Helm's artifacts are reviewed and approved, not weighted. The one invariant worth stealing — supersession _never_ auto-applies — Helm already holds by construction, since every knowledge write goes through a PR.                                                      |
| **Company-brain multi-tenant scoping** (per-login visibility, source isolation gated at zero violations)                                                                                  | **Discard**                                 | Helm has no shared database to leak across. Per-product knowledge repos plus GitHub permissions are the isolation boundary, and `.helm/products.yaml` already carries the multi-product registry.                                                                                                                                                                                      |
| **Skillpacks / recipes as installable markdown**                                                                                                                                          | **Discard (already covered)**               | Helm inherits protocol-first, markdown-as-contract from `ai-dev-framework-template`. gbrain's packaging (marketplace, plugin manifests, persona-curated subsets) serves a distribution problem Helm does not have.                                                                                                                                                                     |
| **Adopting gbrain as a dependency or fork**                                                                                                                                               | **Discard**                                 | MIT means ideas are free to take, so the licence is not the constraint — the ops surface is: a Postgres/PGLite brain, an embedding provider, an enrichment pipeline, 100+ MCP operations, and a cron fleet, against a v0 that explicitly ships with no database. Every row above is reachable by cherry-picking.                                                                       |

## 4. Proposed backlog follow-ups

Titles and one-line rationales only — none of these are filed, and none are
implied by this note being merged.

1. **Materialize the ADR-007 knowledge surfaces into specialist context** — Spec
   Writer and Plan Writer are documented as reading `strategy.md`, `decisions/`,
   `learnings/`, and `wiki/`, and no code path fetches them (§2); a resolver-style
   path table is the bounded version that does not require an index.
2. **Executable floors for the external-review contract** — turn ADR-036's
   clean/blocking/unavailable classification rules into fixtures with
   pre-registered expectations and a floor test, so a regression cannot be banked
   by updating the baseline.
3. **Provenance header on `learnings/` entries** — a reusable learning that does
   not say which item, PR, and finding produced it is unauditable six months
   later, which is the exact failure gbrain's citation rules exist to prevent.
4. **Seam disclosure in dogfood evidence** — when Helm reports that a provider or
   gate "works", state whether the evidence came from shipped code end-to-end or
   from a contract-shaped simulation, and list the deviations.

Items 1 and 2 are the ones worth filing if only two get filed.

## 5. Cost, risk, and what was not evaluated

Adoption cost for everything recommended is a documentation-and-plumbing change
inside Helm; nothing above adds a runtime dependency, a database, a cron, or an
API bill. The risk being managed is the opposite one — **scope creep**: gbrain is
a large, fast-moving product with its own opinionated model of pages, entities,
takes, and facts, and adopting that model wholesale would import a knowledge
architecture Helm's workflow does not need, on top of the knowledge repo it
already has. The verdicts above deliberately keep every borrow at the level of a
principle or a lookup table.

Not evaluated, and out of scope for this note: gbrain's retrieval quality claims
(P@5 49.1% / R@5 97.9%) are self-reported, measured on the author's own
Opus-generated corpus, with scorecards in a sibling repo — no independent
reproduction was attempted, and none of the recommendations depend on those
numbers holding. Also unread: the source tree itself (the review covered
`README.md`, `AGENTS.md`, `DESIGN.md`, and the architecture, ethos, eval, and
guide docs), the skillpack contents, and the MCP surface.
