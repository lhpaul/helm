/**
 * Single source of truth for the knowledge-repo artifact branch naming
 * convention (spec and plan branches).
 *
 * All code that creates, matches, or parses `helm/spec/{externalId}` or
 * `helm/plan/{externalId}` branches must go through these helpers so the
 * convention stays in sync across the orchestrator (spec-publisher,
 * plan-publisher) and the API (webhook handler).
 */

/**
 * Prefix used for all spec branches in the knowledge repo.
 * Example branch: `helm/spec/HLM-42`
 */
export const SPEC_BRANCH_PREFIX = 'helm/spec/';

/**
 * Valid externalId characters — must match the same constraint as
 * EXTERNAL_ID_REGEX in apps/api/src/services/types.ts and
 * EXTERNAL_ID_SAFE in packages/orchestrator/src/specialists/spec-publisher.ts.
 * Duplicated here to keep @helm/shared free of cross-package app dependencies.
 */
const VALID_EXTERNAL_ID = /^(?!\.)[A-Za-z0-9._-]+$/;

/**
 * Returns the knowledge-repo branch name for a given externalId.
 *
 * @example specBranchName('HLM-42') // → 'helm/spec/HLM-42'
 */
export function specBranchName(externalId: string): string {
  return `${SPEC_BRANCH_PREFIX}${externalId}`;
}

/**
 * Prefix used for all plan branches in the knowledge repo.
 * Example branch: `helm/plan/HLM-42`
 */
export const PLAN_BRANCH_PREFIX = 'helm/plan/';

/**
 * Returns the knowledge-repo branch name for a plan artifact.
 *
 * @example planBranchName('HLM-42') // → 'helm/plan/HLM-42'
 */
export function planBranchName(externalId: string): string {
  return `${PLAN_BRANCH_PREFIX}${externalId}`;
}

/**
 * Prefix used for all implementation branches in the code repo.
 * Example branch: `helm/impl/HLM-42`
 */
export const IMPL_BRANCH_PREFIX = 'helm/impl/';

/**
 * Returns the code-repo branch name for an implementation artifact.
 *
 * @example implBranchName('HLM-42') // → 'helm/impl/HLM-42'
 */
export function implBranchName(externalId: string): string {
  return `${IMPL_BRANCH_PREFIX}${externalId}`;
}

/**
 * Discriminates between the three kinds of artifact branches tracked by Helm.
 * Used by `parseArtifactBranch` to communicate which workflow artifact
 * type a git ref belongs to.
 *
 * - `'spec'`  — knowledge-repo spec branch (`helm/spec/{externalId}`)
 * - `'plan'`  — knowledge-repo plan branch (`helm/plan/{externalId}`)
 * - `'impl'`  — code-repo implementation branch (`helm/impl/{externalId}`)
 */
export type ArtifactBranchKind = 'spec' | 'plan' | 'impl';

/**
 * Parses a git ref and returns the artifact kind and externalId if the ref is
 * a valid spec, plan, or impl branch, or `null` if it is not.
 *
 * A valid artifact branch:
 *   - Starts with `helm/spec/` (kind: 'spec'), `helm/plan/` (kind: 'plan'),
 *     or `helm/impl/` (kind: 'impl')
 *   - Has a non-empty suffix that passes the externalId regex
 *     (blocks leading dots, slashes, spaces, and other unsafe characters)
 *
 * @example
 *   parseArtifactBranch('helm/spec/HLM-42')  // → { kind: 'spec', externalId: 'HLM-42' }
 *   parseArtifactBranch('helm/plan/HLM-42')  // → { kind: 'plan', externalId: 'HLM-42' }
 *   parseArtifactBranch('helm/impl/HLM-42')  // → { kind: 'impl', externalId: 'HLM-42' }
 *   parseArtifactBranch('helm/spec/../x')    // → null  (dot-segment traversal)
 *   parseArtifactBranch('feature/foo')       // → null  (not an artifact branch)
 */
export function parseArtifactBranch(
  ref: string,
): { kind: ArtifactBranchKind; externalId: string } | null {
  if (ref.startsWith(SPEC_BRANCH_PREFIX)) {
    const externalId = ref.slice(SPEC_BRANCH_PREFIX.length);
    if (!VALID_EXTERNAL_ID.test(externalId)) return null;
    return { kind: 'spec', externalId };
  }
  if (ref.startsWith(PLAN_BRANCH_PREFIX)) {
    const externalId = ref.slice(PLAN_BRANCH_PREFIX.length);
    if (!VALID_EXTERNAL_ID.test(externalId)) return null;
    return { kind: 'plan', externalId };
  }
  if (ref.startsWith(IMPL_BRANCH_PREFIX)) {
    const externalId = ref.slice(IMPL_BRANCH_PREFIX.length);
    if (!VALID_EXTERNAL_ID.test(externalId)) return null;
    return { kind: 'impl', externalId };
  }
  return null;
}
