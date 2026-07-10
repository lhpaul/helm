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

    it('issue_comment with wrong action → unknown', () => {
      const result = parseGitHubWebhook(
        ctx('issue_comment', { action: 'deleted', comment: { body: 'x' }, issue: { number: 1 } }),
      );
      expect(result.type).toBe('unknown');
    });
  });

  describe('pull_request events', () => {
    it('pull_request closed+merged:true → pull_request_merged with headRef', () => {
      const result = parseGitHubWebhook(
        ctx('pull_request', {
          action: 'closed',
          pull_request: { merged: true, head: { ref: 'helm/spec/issue_42' } },
        }),
      );
      expect(result).toMatchObject({
        type: 'pull_request_merged',
        headRef: 'helm/spec/issue_42',
      });
      expect('timestamp' in result).toBe(true);
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

    it('pull_request action:opened → unknown', () => {
      const result = parseGitHubWebhook(
        ctx('pull_request', {
          action: 'opened',
          pull_request: { merged: false, head: { ref: 'helm/spec/issue_42' } },
        }),
      );
      expect(result.type).toBe('unknown');
    });

    it('pull_request action:synchronize → pull_request_synchronized with headRef', () => {
      const result = parseGitHubWebhook(
        ctx('pull_request', {
          action: 'synchronize',
          pull_request: { merged: false, head: { ref: 'helm/impl/LEA-192' } },
        }),
      );
      expect(result).toEqual({
        type: 'pull_request_synchronized',
        headRef: 'helm/impl/LEA-192',
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
        senderLogin: null,
      });
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
          pull_request: { merged: true, head: { ref: 'feature/some-other-branch' } },
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
