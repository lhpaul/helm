# Review Policies

## Git auth and token handling changes
- **Paths**: `packages/orchestrator/src/specialists/git-helpers.ts`, `packages/orchestrator/src/specialists/code-workspace.ts`, `packages/orchestrator/src/specialists/spec-publisher.ts`, `packages/orchestrator/src/specialists/spec-writer.ts`
- **Severity**: critical
- **Reason**: Small auth changes can leak repository tokens or break clone and push behavior in production workflows.

## API validation and error mapping paths
- **Paths**: `apps/api/src/routes/dispatch.ts`, `apps/api/src/routes/rollback.ts`, `apps/api/src/routes/release.ts`, `apps/api/src/lib/http-errors.ts`
- **Severity**: high
- **Reason**: Route validation and error mapping changes can silently break client contracts even when tests still pass.

## State transition and bypass logic
- **Paths**: `packages/workflow/**`, `packages/orchestrator/src/**/dispatcher*.ts`, `apps/api/src/routes/rollback.ts`, `apps/api/src/routes/release.ts`
- **Severity**: high
- **Reason**: Transition or bypass edits can move items into wrong lifecycle stages and require operator recovery.

## Runtime spawn and CLI invocation
- **Paths**: `packages/orchestrator/src/runtimes/**`
- **Severity**: high
- **Reason**: Subprocess invocation changes can cause hangs, wrong working directory execution, or silent agent failures.

## Filesystem path and write safety
- **Paths**: `apps/api/src/storage/**`, `packages/storage/**`
- **Severity**: high
- **Reason**: Path handling and atomic write mistakes can allow traversal or data clobbering under concurrent load.

## Instructions
- If a change converts thrown errors into null or default values, a human must confirm the loss of error visibility is acceptable.
- If a change touches workspace provisioning or branch checkout flow, a human must verify it cannot overwrite the wrong branch.
- If webhook branch parsing or stage mapping changes, a human must verify lifecycle transitions still match operator intent.
- If logging changes around agent output, prompts, or spec content, a human must verify no sensitive text can be exposed.
- If runtime spawn arguments or stdin handling changes, a human must judge reliability tradeoffs that tests may miss.
