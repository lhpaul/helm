/**
 * Single source of truth for `externalId` validation (TD-001, #129).
 *
 * An externalId is used to build filesystem paths and git branch names, so it
 * must be a safe path component: only `[A-Za-z0-9._-]`, at least one character,
 * and no leading dot (the `(?!\.)` lookahead blocks `.`, `..`, `.hidden`, …).
 *
 * Do not copy this regex into other packages — import it from `@helm/shared`.
 */
export const EXTERNAL_ID_REGEX = /^(?!\.)[A-Za-z0-9._-]+$/;

/** Returns true when `value` is a safe externalId (see {@link EXTERNAL_ID_REGEX}). */
export function isValidExternalId(value: string): boolean {
  return EXTERNAL_ID_REGEX.test(value);
}
