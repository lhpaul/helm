import { describe, expect, it } from 'vitest';
import { classifyCodexRootComment, reviewedCommitFromBody, shaMatches } from './root-comment.js';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function classify(body: string, targetRevision: string | undefined = HEAD) {
  return classifyCodexRootComment({ body, targetRevision });
}

describe('reviewedCommitFromBody', () => {
  it('takes the last marker in the body', () => {
    expect(reviewedCommitFromBody('Reviewed commit: `bbbbbbb`\n\nReviewed commit: `ccccccc`')).toBe(
      'ccccccc',
    );
  });

  it('ignores prose that names a commit without the marker', () => {
    expect(reviewedCommitFromBody('I looked at `aaaaaaa` briefly.')).toBeUndefined();
  });
});

describe('shaMatches', () => {
  it('matches an abbreviated SHA against the full one, in either direction', () => {
    expect(shaMatches('aaaaaaa', HEAD)).toBe(true);
    expect(shaMatches(HEAD, 'aaaaaaa')).toBe(true);
  });

  it('rejects a different revision and anything too short to be a SHA', () => {
    expect(shaMatches('bbbbbbb', HEAD)).toBe(false);
    expect(shaMatches('aaa', HEAD)).toBe(false);
    expect(shaMatches(undefined, HEAD)).toBe(false);
  });
});

describe('classifyCodexRootComment', () => {
  it('reads a SHA-pinned approval as terminal and clean', () => {
    expect(classify(`Reviewed commit: \`${HEAD}\`\n\nNo issues found.`)).toEqual({
      kind: 'terminal',
      reviewedSha: HEAD,
      verdict: 'clean',
    });
  });

  it('reads a SHA-pinned finding as terminal and blocking', () => {
    expect(classify(`Reviewed commit: \`aaaaaaa\`\n\n[P1] Unbounded retry loop.`)).toMatchObject({
      kind: 'terminal',
      verdict: 'blocking',
    });
  });

  it('treats a negated approval as unrecognized rather than clean', () => {
    for (const body of [
      'This change is not approved.',
      'This change remains unapproved.',
      'Looks good at a glance, but this should not be merged until tests pass.',
      'This is **not** yet approved.',
    ]) {
      expect(classify(`Reviewed commit: \`${HEAD}\`\n\n${body}`)).toMatchObject({
        kind: 'terminal',
        verdict: expect.stringMatching(/blocking|unrecognized/),
      });
    }
  });

  it('reads a P3-only summary as an advisory, not a blocker', () => {
    expect(classify(`Reviewed commit: \`${HEAD}\`\n\n[P3] Nit: stale wording.`)).toMatchObject({
      kind: 'terminal',
      verdict: 'advisory',
    });
  });

  it('keeps an explicit blocker blocking even next to a low label', () => {
    expect(
      classify(`Reviewed commit: \`${HEAD}\`\n\n[P3] Nit: wording. Must fix before merge.`),
    ).toMatchObject({ kind: 'terminal', verdict: 'blocking' });
  });

  it('is ancillary when the marker names another revision', () => {
    expect(classify('Reviewed commit: `bbbbbbb`\n\nNo issues found.')).toEqual({
      kind: 'ancillary',
    });
  });

  it('is ancillary for an acknowledgement with no marker', () => {
    expect(classify('👍 Starting a review now.')).toEqual({ kind: 'ancillary' });
  });

  it('detects the missing-environment and usage-limit notices', () => {
    expect(classify('To use Codex here, create an environment for this repo.')).toEqual({
      kind: 'environment_missing',
    });
    expect(classify('You have reached your Codex usage limits.')).toEqual({
      kind: 'usage_limit',
    });
  });

  /**
   * A Codex review *of this classifier* quotes the very phrases it matches on.
   * Reading quoted text as a live verdict turns a clean review into a false
   * `unavailable`, so quoted spans are stripped and multi-backtick runs — which
   * the single-pair strip cannot handle — disqualify the body entirely.
   */
  it('ignores unavailability wording that only appears quoted', () => {
    expect(
      classify('The docs correctly explain `You have reached your Codex usage limits.` here.'),
    ).toEqual({ kind: 'ancillary' });
    expect(
      classify('```\nTo use Codex here, create an environment for this repo.\n```\nLooks fine.'),
    ).toEqual({ kind: 'ancillary' });
    expect(classify('`` To use Codex here, create an environment for this repo. ``')).toEqual({
      kind: 'ancillary',
    });
  });
});
