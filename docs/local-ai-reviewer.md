# Local external review

`review.external.provider: local-ai-reviewer` invokes the ADF local companion
only when Helm's existing internal review/remediation gate reaches the external
slot. Internal reviewers and bounded loop stop rules stay in place. Omitting
`review.external.provider` still runs internals alone.

Install [ai-dev-framework-template](https://github.com/lhpaul/ai-dev-framework-template)
with its companion dependencies (Bash, gh, jq, Codex CLI and authenticated login).
Add its `scripts/development-workflow` directory to the runner's PATH; retain
that directory's companion files together. Helm references those scripts rather
than vendoring a second copy. See the upstream
[integration contract](https://github.com/lhpaul/ai-dev-framework-template/blob/develop/docs/workflow/development-workflow/integrations/local-ai-reviewer.md).
No new secret is required for the default Codex backend.

```yaml
review:
  external:
    provider: local-ai-reviewer
    local_ai_reviewer:
      command: local-ai-reviewer.sh
      backend: codex
      timeout_sec: 900
      mode: ordinary
```

`command` is trusted operator configuration: a shell command naming the ADF
companion or a wrapper, optionally with fixed arguments. PR identity is passed
as separate positional arguments, followed by `--timeout N --repo-root .`.
The runner must execute in the intended checkout at the PR head. For a server
whose working directory is not that checkout, configure an executable wrapper
that selects the correct checkout, changes directory and forwards all arguments
to the ADF companion. The companion checks origin and HEAD; a wrong checkout
fails closed. Do not put machine-specific paths or credentials in public config.

The adapter exports `LOCAL_AI_REVIEWER_BACKEND`, `LOCAL_AI_REVIEWER_MODE`,
`LOCAL_AI_REVIEWER_TIMEOUT`, `REVIEWED_HEAD`, and a unique
`LOCAL_AI_REVIEWER_EVIDENCE_FILE`. HTTP is opt-in and requires the existing ADF
HTTP environment setup; credentials never belong in product YAML. Mode values
are `ordinary` and `strict`; stage-specific strict passes remain upstream
advisory diagnostics and do not replace the ordinary terminal verdict.

Both stdout KV output and the fresh `local_ai_reviewer_evidence.v1` artifact
must name the complete target SHA and agree on verdict/blocking count. The
artifact must also identify the PR/repository. `clean` requires zero blockers
and exit 0. `needs_fixes` requires blocker bodies, a positive count, and exit
0 or the companion's expected exit 1. Each blocker receives a stable identity
and maps conservatively to high severity; optional strict/advisory diagnostics
are not converted to blockers. Missing target, stale or malformed evidence,
nonterminal output, command failure, missing installation and timeout become
`skipped:unavailable`, consuming the existing repeated-skip budget rather than
passing the gate. Output is bounded to 1 MiB; expiry aborts the process group.
Temporary artifacts are removed after parsing. The local reviewer posts no
GitHub comments; operators can persist separate review artifacts for PR evidence.

Rollback: select `codex-github` or `coderabbit` in product config (their adapters
and settings remain available). For CodeRabbit, also re-enable
`.coderabbit.yaml` `reviews.auto_review.enabled` if automatic reviews are wanted.
Disabling its App auto-review is what avoids analysis on intermediate pushes;
Helm's internal-first call order alone never controlled that billing.
