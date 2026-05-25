/**
 * Single source of truth for the knowledge-repo spec branch naming convention.
 *
 * All code that creates, matches, or parses `helm/spec/{externalId}` branches
 * must go through these helpers so the convention stays in sync across the
 * orchestrator (spec-publisher) and the API (webhook handler).
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
 * Parses a git ref and returns the externalId if the ref is a valid spec branch,
 * or `null` if it is not.
 *
 * A valid spec branch:
 *   - Starts with `helm/spec/`
 *   - Has a non-empty suffix that passes the externalId regex
 *     (blocks leading dots, slashes, spaces, and other unsafe characters)
 *
 * @example
 *   parseSpecBranch('helm/spec/HLM-42')  // → 'HLM-42'
 *   parseSpecBranch('helm/spec/../x')    // → null  (dot-segment traversal)
 *   parseSpecBranch('feature/foo')       // → null  (not a spec branch)
 */
export function parseSpecBranch(ref: string): string | null {
  if (!ref.startsWith(SPEC_BRANCH_PREFIX)) return null;
  const externalId = ref.slice(SPEC_BRANCH_PREFIX.length);
  if (!VALID_EXTERNAL_ID.test(externalId)) return null;
  return externalId;
}
