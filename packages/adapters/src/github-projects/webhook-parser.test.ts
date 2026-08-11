import { describe, expect, it } from 'vitest';
import { parseGitHubWebhook } from './webhook-parser.js';

function ctx(eventType: string, payload: unknown): unknown {
  return { eventType, payload };
}

describe('parseGitHubWebhook', () => {
  describe('issues events', () => {
    it('issues.opened → item_created', () => {
      const result = parseGitHubWebhook(
        ctx('issues', { action: 'opened', issue: { number: 42, node_id: 'I_x' } }),
      );
      expect(result).toMatchObject({ type: 'item_created', externalId: 'issue_42' });
    });

    it('issues.closed → item_updated with status closed', () => {
      const result = parseGitHubWebhook(
        ctx('issues', { action: 'closed', issue: { number: 7, node_id: 'I_y' } }),
      );
      expect(result).toMatchObject({
        type: 'item_updated',
        externalId: 'issue_7',
        status: 'closed',
      });
    });

    it('issues.reopened → item_updated with status open', () => {
      const result = parseGitHubWebhook(
        ctx('issues', { action: 'reopened', issue: { number: 3, node_id: 'I_z' } }),
      );
      expect(result).toMatchObject({ type: 'item_updated', externalId: 'issue_3', status: 'open' });
    });

    it('issues.edited → unknown (not actionable)', () => {
      const result = parseGitHubWebhook(
        ctx('issues', { action: 'edited', issue: { number: 1, node_id: 'I_a' } }),
      );
      expect(result.type).toBe('unknown');
    });

    it('issues with missing issue number → unknown', () => {
      const result = parseGitHubWebhook(ctx('issues', { action: 'opened', issue: {} }));
      expect(result.type).toBe('unknown');
    });
  });

  describe('issue_comment events', () => {
    it('issue_comment.created → comment_added', () => {
      const result = parseGitHubWebhook(
        ctx('issue_comment', {
          action: 'created',
          comment: { body: 'LGTM' },
          issue: { number: 5 },
        }),
      );
      expect(result).toMatchObject({ type: 'comment_added', externalId: 'issue_5', body: 'LGTM' });
    });

    it('issue_comment.created on a PR → pull_request_comment_created', () => {
      const result = parseGitHubWebhook(
        ctx('issue_comment', {
          action: 'created',
          comment: { body: '<!-- helm:product-decision -->', user: { login: 'maintainer' } },
          issue: { number: 42, pull_request: { url: 'https://api.github.com/pr' } },
          repository: { name: 'repo', owner: { login: 'owner' } },
        }),
      );
      expect(result).toEqual({
        type: 'pull_request_comment_created',
        owner: 'owner',
        repo: 'repo',
        prNumber: 42,
        body: '<!-- helm:product-decision -->',
        authorLogin: 'maintainer',
        timestamp: expect.any(String),
      });
    });

    it('issue_comment.created free-form on a PR still emits PR comment for route filtering', () => {
      const result = parseGitHubWebhook(
        ctx('issue_comment', {
          action: 'created',
          comment: { body: 'LGTM' },
          issue: { number: 42, pull_request: { url: 'https://api.github.com/pr' } },
          repository: { name: 'repo', owner: { login: 'owner' } },
        }),
      );
      expect(result).toMatchObject({
        type: 'pull_request_comment_created',
        body: 'LGTM',
        authorLogin: null,
      });
    });

    it('issue_comment with wrong action → unknown', () => {
      const result = parseGitHubWebhook(
        ctx('issue_comment', { action: 'deleted', comment: { body: 'x' }, issue: { number: 1 } }),
      );
      expect(result.type).toBe('unknown');
    });

    it('edited PR comment with marker → unknown', () => {
      const result = parseGitHubWebhook(
        ctx('issue_comment', {
          action: 'edited',
          comment: { body: '<!-- helm:product-decision -->' },
          issue: { number: 42, pull_request: { url: 'https://api.github.com/pr' } },
          repository: { name: 'repo', owner: { login: 'owner' } },
        }),
      );
      expect(result.type).toBe('unknown');
    });

    it('PR comment missing repository metadata → unknown', () => {
      const result = parseGitHubWebhook(
        ctx('issue_comment', {
          action: 'created',
          comment: { body: '<!-- helm:product-decision -->' },
          issue: { number: 42, pull_request: { url: 'https://api.github.com/pr' } },
        }),
      );
      expect(result.type).toBe('unknown');
    });
  });

  describe('pull_request events', () => {
    it('pull_request closed+merged:true → pull_request_merged with headRef', () => {
      const result = parseGitHubWebhook(
        ctx('pull_request', {
          action: 'closed',
          pull_request: { id: 1042, merged: true, head: { ref: 'helm/spec/issue_42' } },
        }),
      );
      expect(result).toMatchObject({
        type: 'pull_request_merged',
        headRef: 'helm/spec/issue_42',
        pullRequestId: 1042,
      });
      expect('timestamp' in result).toBe(true);
    });

    it('pull_request closed+merged:true without id → unknown', () => {
      const result = parseGitHubWebhook(
        ctx('pull_request', {
          action: 'closed',
          pull_request: { merged: true, head: { ref: 'helm/spec/issue_42' } },
        }),
      );
      expect(result.type).toBe('unknown');
    });

    it('pull_request closed+merged:false → unknown (not a merge)', () => {
      const result = parseGitHubWebhook(
        ctx('pull_request', {
          action: 'closed',
          pull_request: { merged: false, head: { ref: 'helm/spec/issue_42' } },
        }),
      );
      expect(result.type).toBe('unknown');
    });

    it('pull_request action:opened on early artifact branch → pull_request_synchronized with headRef', () => {
      const result = parseGitHubWebhook(
        ctx('pull_request', {
          action: 'opened',
          pull_request: {
            number: 42,
            merged: false,
            head: { ref: 'helm/spec/issue_42', sha: 'abc123' },
          },
          repository: { name: 'repo', owner: { login: 'owner' } },
        }),
      );
      expect(result).toEqual({
        type: 'pull_request_synchronized',
        headRef: 'helm/spec/issue_42',
        owner: 'owner',
        repo: 'repo',
        headOwner: null,
        headRepo: null,
        prNumber: 42,
        headSha: 'abc123',
        senderLogin: null,
        timestamp: expect.any(String),
      });
    });

    it('pull_request action:opened on helm/plan artifact branch → pull_request_synchronized', () => {
      const result = parseGitHubWebhook(
        ctx('pull_request', {
          action: 'opened',
          pull_request: {
            number: 43,
            merged: false,
            head: { ref: 'helm/plan/issue_42', sha: 'def456' },
          },
          repository: { name: 'repo', owner: { login: 'owner' } },
        }),
      );
      expect(result).toEqual({
        type: 'pull_request_synchronized',
        headRef: 'helm/plan/issue_42',
        owner: 'owner',
        repo: 'repo',
        headOwner: null,
        headRepo: null,
        prNumber: 43,
        headSha: 'def456',
        senderLogin: null,
        timestamp: expect.any(String),
      });
    });

    it('pull_request action:reopened on early artifact branch → pull_request_synchronized', () => {
      const result = parseGitHubWebhook(
        ctx('pull_request', {
          action: 'reopened',
          pull_request: {
            number: 44,
            merged: false,
            head: { ref: 'helm/spec/issue_42', sha: 'ghi789' },
          },
          repository: { name: 'repo', owner: { login: 'owner' } },
        }),
      );
      expect(result).toEqual({
        type: 'pull_request_synchronized',
        headRef: 'helm/spec/issue_42',
        owner: 'owner',
        repo: 'repo',
        headOwner: null,
        headRepo: null,
        prNumber: 44,
        headSha: 'ghi789',
        senderLogin: null,
        timestamp: expect.any(String),
      });
    });

    it('pull_request action:synchronize → pull_request_synchronized with headRef', () => {
      const result = parseGitHubWebhook(
        ctx('pull_request', {
          action: 'synchronize',
          pull_request: {
            number: 12,
            merged: false,
            head: { ref: 'helm/impl/LEA-192', sha: 'abc123' },
          },
          repository: { name: 'repo', owner: { login: 'owner' } },
        }),
      );
      expect(result).toEqual({
        type: 'pull_request_synchronized',
        headRef: 'helm/impl/LEA-192',
        owner: 'owner',
        repo: 'repo',
        headOwner: null,
        headRepo: null,
        prNumber: 12,
        headSha: 'abc123',
        senderLogin: null,
        timestamp: expect.any(String),
      });
    });

    it('pull_request action:synchronize includes senderLogin when sender is present', () => {
      const result = parseGitHubWebhook(
        ctx('pull_request', {
          action: 'synchronize',
          pull_request: { merged: false, head: { ref: 'helm/impl/LEA-192' } },
          sender: { login: 'human-dev' },
        }),
      );
      expect(result).toMatchObject({
        type: 'pull_request_synchronized',
        headRef: 'helm/impl/LEA-192',
        owner: null,
        repo: null,
        senderLogin: 'human-dev',
      });
    });

    it('pull_request action:synchronize on non-artifact branch → pull_request_synchronized (route filters)', () => {
      const result = parseGitHubWebhook(
        ctx('pull_request', {
          action: 'synchronize',
          pull_request: { merged: false, head: { ref: 'feature/foo' } },
        }),
      );
      expect(result).toMatchObject({
        type: 'pull_request_synchronized',
        headRef: 'feature/foo',
        owner: null,
        repo: null,
        senderLogin: null,
      });
    });

    it('pull_request action:opened on non-artifact branch → unknown', () => {
      const result = parseGitHubWebhook(
        ctx('pull_request', {
          action: 'opened',
          pull_request: {
            number: 12,
            merged: false,
            head: { ref: 'feature/foo', sha: 'abc123' },
          },
        }),
      );
      expect(result.type).toBe('unknown');
    });

    it('pull_request action:reopened on non-artifact branch → unknown', () => {
      const result = parseGitHubWebhook(
        ctx('pull_request', {
          action: 'reopened',
          pull_request: {
            number: 12,
            merged: false,
            head: { ref: 'feature/foo', sha: 'abc123' },
          },
        }),
      );
      expect(result.type).toBe('unknown');
    });

    it('pull_request with missing pull_request field → unknown (no throw)', () => {
      const result = parseGitHubWebhook(ctx('pull_request', { action: 'closed' }));
      expect(result.type).toBe('unknown');
    });

    it('pull_request with non-spec branch → pull_request_merged with that headRef (interpretation is route responsibility)', () => {
      // The parser emits the raw headRef without filtering — the route decides
      // what to do with non-spec branches.
      const result = parseGitHubWebhook(
        ctx('pull_request', {
          action: 'closed',
          pull_request: { id: 1043, merged: true, head: { ref: 'feature/some-other-branch' } },
        }),
      );
      expect(result).toMatchObject({
        type: 'pull_request_merged',
        headRef: 'feature/some-other-branch',
      });
    });
  });

  describe('release events', () => {
    it('release.published → release_published with tag', () => {
      const result = parseGitHubWebhook(
        ctx('release', { action: 'published', release: { tag_name: 'v1.2.0' } }),
      );
      expect(result).toMatchObject({ type: 'release_published', tag: 'v1.2.0' });
      expect('timestamp' in result).toBe(true);
    });

    it('release.created → unknown (only published ships)', () => {
      const result = parseGitHubWebhook(
        ctx('release', { action: 'created', release: { tag_name: 'v1.2.0' } }),
      );
      expect(result.type).toBe('unknown');
    });

    it('release.edited → unknown', () => {
      const result = parseGitHubWebhook(
        ctx('release', { action: 'edited', release: { tag_name: 'v1.2.0' } }),
      );
      expect(result.type).toBe('unknown');
    });

    it('release with missing release field → unknown (no throw)', () => {
      const result = parseGitHubWebhook(ctx('release', { action: 'published' }));
      expect(result.type).toBe('unknown');
    });

    it('release with missing tag_name → unknown (no throw)', () => {
      const result = parseGitHubWebhook(ctx('release', { action: 'published', release: {} }));
      expect(result.type).toBe('unknown');
    });
  });

  describe('external review readiness events', () => {
    it('check_run.completed success for Haystack emits external_review_ready', () => {
      const result = parseGitHubWebhook(
        ctx('check_run', {
          action: 'completed',
          check_run: {
            name: 'Haystack / Review',
            status: 'completed',
            conclusion: 'success',
            head_sha: 'abc123',
            app: { slug: 'haystack-code-reviewer-pr-hook' },
            pull_requests: [{ number: 42, head: { ref: 'helm/impl/issue_42' } }],
          },
          repository: { name: 'repo', owner: { login: 'owner' } },
        }),
      );

      expect(result).toEqual({
        type: 'external_review_ready',
        provider: 'haystack',
        owner: 'owner',
        repo: 'repo',
        prNumber: 42,
        targetRevision: 'abc123',
        headRef: 'helm/impl/issue_42',
        timestamp: expect.any(String),
      });
    });

    it('check_run.completed success without pull_requests still emits readiness by SHA', () => {
      const result = parseGitHubWebhook(
        ctx('check_run', {
          action: 'completed',
          check_run: {
            name: 'Haystack / Review',
            status: 'completed',
            conclusion: 'success',
            head_sha: 'abc123',
            app: {
              slug: 'haystack-code-reviewer-pr-hook',
              name: 'Haystack Code Reviewer - PR Hook',
            },
            pull_requests: [],
          },
          repository: { name: 'repo', owner: { login: 'owner' } },
        }),
      );

      expect(result).toEqual({
        type: 'external_review_ready',
        provider: 'haystack',
        owner: 'owner',
        repo: 'repo',
        targetRevision: 'abc123',
        timestamp: expect.any(String),
      });
    });

    it('rejects check names that only substring-match haystack', () => {
      const result = parseGitHubWebhook(
        ctx('check_run', {
          action: 'completed',
          check_run: {
            name: 'my-haystack-helper',
            status: 'completed',
            conclusion: 'success',
            head_sha: 'abc123',
            app: { slug: 'haystack-code-reviewer-pr-hook' },
            pull_requests: [{ number: 42, head: { ref: 'helm/impl/issue_42' } }],
          },
          repository: { name: 'repo', owner: { login: 'owner' } },
        }),
      );
      expect(result.type).toBe('unknown');
    });

    it('rejects matching check name without a trusted GitHub App identity', () => {
      const result = parseGitHubWebhook(
        ctx('check_run', {
          action: 'completed',
          check_run: {
            name: 'Haystack / Review',
            status: 'completed',
            conclusion: 'success',
            head_sha: 'abc123',
            app: { slug: 'spoofed-haystack' },
            pull_requests: [{ number: 42, head: { ref: 'helm/impl/issue_42' } }],
          },
          repository: { name: 'repo', owner: { login: 'owner' } },
        }),
      );
      expect(result.type).toBe('unknown');
    });

    it('check_run.completed action_required remains unknown', () => {
      const result = parseGitHubWebhook(
        ctx('check_run', {
          action: 'completed',
          check_run: {
            name: 'Haystack / Review',
            status: 'completed',
            conclusion: 'action_required',
            head_sha: 'abc123',
            app: { slug: 'haystack-code-reviewer-pr-hook' },
            pull_requests: [{ number: 42, head: { ref: 'helm/impl/issue_42' } }],
          },
        }),
      );

      expect(result.type).toBe('unknown');
    });

    it('check_run.completed success for Bugbot emits external_review_ready', () => {
      const result = parseGitHubWebhook(
        ctx('check_run', {
          action: 'completed',
          check_run: {
            name: 'Bugbot / Review',
            status: 'completed',
            conclusion: 'neutral',
            head_sha: 'abc123',
            app: { slug: 'bugbot', name: 'Bugbot' },
            pull_requests: [{ number: 42, head: { ref: 'helm/impl/issue_42' } }],
          },
          repository: { name: 'repo', owner: { login: 'owner' } },
        }),
      );

      expect(result).toEqual({
        type: 'external_review_ready',
        provider: 'bugbot',
        owner: 'owner',
        repo: 'repo',
        prNumber: 42,
        targetRevision: 'abc123',
        headRef: 'helm/impl/issue_42',
        timestamp: expect.any(String),
      });
    });

    it('rejects Bugbot check names without a trusted Cursor/Bugbot app identity', () => {
      const result = parseGitHubWebhook(
        ctx('check_run', {
          action: 'completed',
          check_run: {
            name: 'Bugbot / Review',
            status: 'completed',
            conclusion: 'success',
            head_sha: 'abc123',
            app: { slug: 'spoofed-bugbot' },
            pull_requests: [{ number: 42, head: { ref: 'helm/impl/issue_42' } }],
          },
          repository: { name: 'repo', owner: { login: 'owner' } },
        }),
      );
      expect(result.type).toBe('unknown');
    });

    it('status.success for non-CodeRabbit contexts stays unknown (Option B)', () => {
      const result = parseGitHubWebhook(
        ctx('status', {
          context: 'Bugbot / Review',
          state: 'success',
          sha: 'abc123',
          target_url: 'https://github.com/owner/repo/pull/42/checks',
          branches: [{ name: 'helm/impl/issue_42' }],
          repository: { name: 'repo', owner: { login: 'owner' } },
        }),
      );

      expect(result.type).toBe('unknown');
    });

    it('status.success for allowlisted CodeRabbit context emits external_review_ready', () => {
      const result = parseGitHubWebhook(
        ctx('status', {
          context: 'CodeRabbit',
          state: 'success',
          description: 'Review completed',
          sha: 'abc123def',
          sender: { login: 'coderabbitai[bot]' },
          repository: { name: 'repo', owner: { login: 'owner' } },
        }),
      );

      expect(result).toEqual({
        type: 'external_review_ready',
        provider: 'coderabbit',
        owner: 'owner',
        repo: 'repo',
        targetRevision: 'abc123def',
        timestamp: expect.any(String),
      });
    });

    it('accepts common GitHub status metadata while keeping the top-level schema strict', () => {
      const result = parseGitHubWebhook(
        ctx('status', {
          context: 'CodeRabbit',
          state: 'success',
          description: 'Review completed',
          sha: 'abc123def',
          sender: { login: 'coderabbitai[bot]' },
          repository: { name: 'repo', owner: { login: 'owner' } },
          organization: { login: 'owner' },
          installation: { id: 123 },
          enterprise: { slug: 'enterprise' },
        }),
      );

      expect(result).toMatchObject({
        type: 'external_review_ready',
        provider: 'coderabbit',
        owner: 'owner',
        repo: 'repo',
        targetRevision: 'abc123def',
      });
    });

    it('rejects CodeRabbit status without a trusted sender login', () => {
      const result = parseGitHubWebhook(
        ctx('status', {
          context: 'CodeRabbit',
          state: 'success',
          sha: 'abc123def',
          sender: { login: 'malicious-bot' },
          repository: { name: 'repo', owner: { login: 'owner' } },
        }),
      );
      expect(result.type).toBe('unknown');
    });

    it('rejects CodeRabbit status with empty trust inputs', () => {
      const result = parseGitHubWebhook(
        ctx('status', {
          context: ' ',
          state: 'success',
          sha: ' ',
          sender: { login: 'coderabbitai[bot]' },
          repository: { name: 'repo', owner: { login: 'owner' } },
        }),
      );
      expect(result.type).toBe('unknown');
    });

    it('rejects CodeRabbit status payloads with unexpected fields', () => {
      const result = parseGitHubWebhook(
        ctx('status', {
          context: 'CodeRabbit',
          state: 'success',
          sha: 'abc123def',
          sender: { login: 'coderabbitai[bot]' },
          repository: { name: 'repo', owner: { login: 'owner' } },
          unexpected: 'spoofed',
        }),
      );
      expect(result.type).toBe('unknown');
    });
  });

  describe('unknown / malformed inputs', () => {
    it('unknown event type → unknown', () => {
      expect(parseGitHubWebhook(ctx('push', {}))).toMatchObject({ type: 'unknown' });
    });

    it('null rawEvent → unknown (no throw)', () => {
      expect(parseGitHubWebhook(null)).toMatchObject({ type: 'unknown' });
    });

    it('rawEvent without eventType → unknown', () => {
      expect(parseGitHubWebhook({ payload: {} })).toMatchObject({ type: 'unknown' });
    });

    it('payload that is not an object → unknown', () => {
      expect(parseGitHubWebhook(ctx('issues', 'not-an-object'))).toMatchObject({ type: 'unknown' });
    });
  });
});
