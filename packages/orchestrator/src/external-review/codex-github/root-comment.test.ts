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

  /**
   * The marker is parsed from unquoted prose only. Quoting one and following it
   * with approval prose is otherwise a way for a single trusted comment to forge
   * clean evidence for the current head — the exact trust boundary this file is
   * responsible for.
   */
  it('ignores a marker that only appears quoted', () => {
    const quoted = [
      '```\nReviewed commit: `' + HEAD + '`\n```\n\nNo issues found.',
      '``Reviewed commit: `' + HEAD + '` ``\n\nNo issues found.',
      '> Reviewed commit: `' + HEAD + '`\n\nNo issues found.',
      '```\nReviewed commit: `aaaaaaa`\n```\n\nNo issues found.',
    ];

    for (const body of quoted) {
      expect(reviewedCommitFromBody(body)).toBeUndefined();
      expect(classify(body)).toEqual({ kind: 'ancillary' });
    }
  });

  /**
   * GFM lazy continuation: a quote's paragraph runs onto following non-blank
   * lines with no `>` of their own, so the marker below renders inside the quote
   * while looking unquoted in source. Parsing it as prose let one trusted
   * comment spoof head-pinned evidence.
   */
  it('rejects a marker on a lazy block-quote continuation line', () => {
    const spoof = [
      '> Prior quoted content\nReviewed commit: `' + HEAD + '`\n\nLGTM',
      '> Prior quoted content\nstill quoted\nReviewed commit: `' + HEAD + '`\n\nNo issues found.',
      '  > indented quote\nReviewed commit: `' + HEAD + '`\n\nLooks good.',
    ];

    for (const body of spoof) {
      expect(reviewedCommitFromBody(body)).toBeUndefined();
      expect(classify(body)).toEqual({ kind: 'ancillary' });
    }
  });

  it('reads a marker again once a blank line has closed the quote', () => {
    // The lazy continuation must not swallow the rest of the comment: a blank
    // line ends the quote's paragraph, and prose after it is prose again.
    const body = '> Prior quoted content\n\nReviewed commit: `' + HEAD + '`\n\nNo issues found.';
    expect(classify(body)).toEqual({ kind: 'terminal', reviewedSha: HEAD, verdict: 'clean' });
  });

  /**
   * Only *matched* delimiter pairs are stripped, so an unterminated fence would
   * otherwise leave its marker eligible — and Markdown renders an unclosed fence
   * as quoted through end of document anyway.
   */
  it('fails closed on an unclosed fence, tilde block, or multi-backtick span', () => {
    const unclosed = [
      '```\nReviewed commit: `' + HEAD + '`\n\nNo issues found.',
      '~~~\nReviewed commit: `' + HEAD + '`\n\nNo issues found.',
      '``Reviewed commit: `' + HEAD + '`\n\nNo issues found.',
      'Notes below.\n```\nReviewed commit: `' + HEAD + '`\nLGTM.',
    ];

    for (const body of unclosed) {
      expect(reviewedCommitFromBody(body)).toBeUndefined();
      expect(classify(body)).toEqual({ kind: 'ancillary' });
    }
  });

  /**
   * CommonMark closes a fence only on a same-character run at least as long as
   * the opener. A regex pair treats the short run as a closer and exposes
   * content the renderer still shows inside the block — quoted to a human,
   * live evidence to Helm.
   */
  it('does not let a short closer expose content inside a longer fence', () => {
    const spoof = [
      '````\nfoo\n```\nReviewed commit: `' + HEAD + '`\n\nNo issues found.',
      '~~~~\nfoo\n~~~\nReviewed commit: `' + HEAD + '`\n\nLGTM',
      '````\nReviewed commit: `' + HEAD + '`\n```\nLooks good.',
    ];

    for (const body of spoof) {
      expect(reviewedCommitFromBody(body)).toBeUndefined();
      expect(classify(body)).toEqual({ kind: 'ancillary' });
    }
  });

  it('does not treat a tilde run as closing a backtick fence', () => {
    const body = '```\nfoo\n~~~\nReviewed commit: `' + HEAD + '`\n\nNo issues found.';
    expect(classify(body)).toEqual({ kind: 'ancillary' });
  });

  it('reads a marker after a fence that is properly closed', () => {
    // The length rule must not over-strip: an equal-length closer ends the
    // block, and prose after it is prose again.
    const body = '````\nfoo\n````\n\nReviewed commit: `' + HEAD + '`\n\nNo issues found.';
    expect(classify(body)).toEqual({ kind: 'terminal', reviewedSha: HEAD, verdict: 'clean' });
  });

  it('keeps a marker that precedes an unclosed delimiter', () => {
    const body = 'Reviewed commit: `' + HEAD + '`\n\nNo issues found.\n\n```\ntrailing';
    expect(classify(body)).toEqual({ kind: 'terminal', reviewedSha: HEAD, verdict: 'clean' });
  });

  it('still reads a real marker beside a quoted one', () => {
    const body =
      '```\nReviewed commit: `bbbbbbb`\n```\n\nReviewed commit: `' + HEAD + '`\n\nNo issues found.';
    expect(classify(body)).toEqual({ kind: 'terminal', reviewedSha: HEAD, verdict: 'clean' });
  });

  it('reads a head-pinned quota notice as a usage limit, not an unparseable verdict', () => {
    expect(
      classify(`Reviewed commit: \`${HEAD}\`\n\nYou have reached your Codex usage limits.`),
    ).toEqual({ kind: 'usage_limit' });
  });

  it('keeps a head-pinned blocker ahead of quota wording in the same comment', () => {
    expect(
      classify(
        `Reviewed commit: \`${HEAD}\`\n\n[P1] Unbounded retry loop. You have reached your Codex usage limits.`,
      ),
    ).toMatchObject({ kind: 'terminal', verdict: 'blocking' });
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
