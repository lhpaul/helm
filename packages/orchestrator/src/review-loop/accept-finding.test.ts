import { describe, expect, it } from 'vitest';
import {
  ACCEPT_FINDING_MARKER,
  acceptedFindingMatchesExternal,
  acceptedFindingMatchesTitle,
  isAcceptableSeverity,
  parseAcceptFindingComment,
} from './accept-finding.js';

const comment = (lines: string[]) => [ACCEPT_FINDING_MARKER, ...lines].join('\n');

describe('parseAcceptFindingComment', () => {
  it('parses the documented marker shape', () => {
    const parsed = parseAcceptFindingComment(
      comment([
        '**Finding title:** Unit smoke does not exercise Expo Router navigation',
        '**Severity:** MEDIUM',
        '**Rationale:** AC #4 closed on the Vitest smoke; Maestro is separate work.',
      ]),
    );

    expect(parsed).toEqual({
      fingerprint: 'test-fidelity',
      findingTitle: 'Unit smoke does not exercise Expo Router navigation',
      severity: 'MEDIUM',
      rationale: 'AC #4 closed on the Vitest smoke; Maestro is separate work.',
    });
  });

  it('accepts checklist and plain-field variants', () => {
    const parsed = parseAcceptFindingComment(
      [
        '- [x] Finding: Coverage gap in apps/api/src/routes/debts.ts',
        '- Reason: covered by the contract test suite',
      ].join('\n'),
    );

    expect(parsed?.findingTitle).toBe('Coverage gap in apps/api/src/routes/debts.ts');
    expect(parsed?.rationale).toBe('covered by the contract test suite');
    expect(parsed?.severity).toBeUndefined();
  });

  it('returns null for a comment that is not an accept', () => {
    expect(parseAcceptFindingComment('LGTM, merging')).toBeNull();
    expect(parseAcceptFindingComment(ACCEPT_FINDING_MARKER)).toBeNull();
    // Title without a rationale is not enough — an accept has to say why.
    expect(
      parseAcceptFindingComment(comment(['**Finding title:** Missing e2e coverage'])),
    ).toBeNull();
    // A generic `Title:`/`Why:` pair with no marker is somebody else's comment.
    expect(parseAcceptFindingComment('Title: something\nWhy: because')).toBeNull();
  });
});

describe('isAcceptableSeverity', () => {
  it.each(['MEDIUM', 'medium', 'LOW', 'INFO'])('allows %s', (severity) => {
    expect(isAcceptableSeverity(severity)).toBe(true);
  });

  it.each(['CRITICAL', 'HIGH'])('refuses %s', (severity) => {
    expect(isAcceptableSeverity(severity)).toBe(false);
  });

  it('refuses an unstated severity rather than assuming one', () => {
    expect(isAcceptableSeverity(undefined)).toBe(false);
  });
});

describe('matching', () => {
  const accepted = [{ fingerprint: 'test-fidelity' }];

  it('covers a reworded restatement of the same sticky ask', () => {
    expect(
      acceptedFindingMatchesTitle(accepted, 'Missing Maestro flow for the onboarding screen'),
    ).toBe(true);
    expect(acceptedFindingMatchesTitle(accepted, 'SQL injection in the debts route')).toBe(false);
  });

  it('matches an external finding by summary or id', () => {
    expect(
      acceptedFindingMatchesExternal(accepted, {
        id: 'cr-1',
        severity: 'medium',
        blocking: true,
        summary: 'No end-to-end coverage for this flow',
      }),
    ).toBe(true);
    expect(
      acceptedFindingMatchesExternal(accepted, {
        id: 'cr-2',
        severity: 'medium',
        blocking: true,
        summary: 'Unvalidated input reaches the query builder',
      }),
    ).toBe(false);
  });

  it('never matches when nothing is accepted', () => {
    expect(acceptedFindingMatchesTitle([], 'No end-to-end coverage')).toBe(false);
  });
});
