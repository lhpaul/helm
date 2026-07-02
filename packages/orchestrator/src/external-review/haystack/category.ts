import type { NormalizedFinding } from '../types.js';

/** Maps Haystack finding categories to blocking vs advisory (haystack-reviewer.sh). */
export function isHaystackCategoryBlocking(
  category: string | null | undefined,
  majorIsBlocking: boolean,
): boolean {
  const normalized = category?.trim() ?? '';
  if (!normalized) return true;

  switch (normalized) {
    case 'Logic error':
    case 'Critical':
      return true;
    case 'Major':
      return majorIsBlocking;
    case 'Minor':
    case 'Advisory':
    case 'Nitpick':
    case 'Trivial':
    case 'Weak test coverage':
    case 'Rules violation':
    case 'Code contract violation':
      return false;
    default:
      return true;
  }
}

/** Maps Haystack categories to normalized severities for remediation ordering. */
export function haystackCategoryToSeverity(
  category: string | null | undefined,
): NormalizedFinding['severity'] {
  const normalized = category?.trim() ?? '';
  switch (normalized) {
    case 'Logic error':
    case 'Critical':
      return 'critical';
    case 'Major':
      return 'high';
    case 'Minor':
    case 'Weak test coverage':
    case 'Code contract violation':
      return 'medium';
    case 'Advisory':
    case 'Rules violation':
      return 'low';
    case 'Nitpick':
    case 'Trivial':
      return 'info';
    default:
      return 'high';
  }
}
