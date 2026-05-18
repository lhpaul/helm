import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { GitHubProjectsAdapter } from './adapter.js';
import type { GitHubProjectsConfig, GraphqlFn, FetchFn } from './adapter.js';
import {
  GitHubAuthError,
  GitHubAPIError,
  GitHubConfigError,
  GitHubNotFoundError,
} from './errors.js';
import type {
  GetProjectResponse,
  GetProjectFieldsResponse,
  CreateSingleSelectFieldResponse,
  GetProjectItemsResponse,
} from './graphql-types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CONFIG: GitHubProjectsConfig = {
  provider: 'github_projects',
  org: 'test-org',
  project_number: 3,
  custom_field_name: 'Helm Stage',
};

const PROJECT_ID = 'PVT_abc123';
const FIELD_ID = 'PVTSSF_field1';
const OPTION_DISCOVERY = { id: 'opt-disc', name: 'discovery' };
const OPTION_SPEC_READY = { id: 'opt-spec', name: 'spec-ready' };

function projectRes(): GetProjectResponse {
  return {
    repositoryOwner: { __typename: 'Organization', projectV2: { id: PROJECT_ID, title: 'Helm' } },
  };
}

function projectResUser(): GetProjectResponse {
  return { repositoryOwner: { __typename: 'User', projectV2: { id: PROJECT_ID, title: 'Helm' } } };
}

function fieldsRes(fieldName?: string): GetProjectFieldsResponse {
  if (!fieldName) return { node: { fields: { nodes: [] } } };
  return {
    node: {
      fields: {
        nodes: [
          {
            __typename: 'ProjectV2SingleSelectField',
            id: FIELD_ID,
            name: fieldName,
            options: [OPTION_DISCOVERY, OPTION_SPEC_READY],
          },
        ],
      },
    },
  };
}

function createFieldRes(): CreateSingleSelectFieldResponse {
  return {
    createProjectV2Field: {
      projectV2Field: {
        __typename: 'ProjectV2SingleSelectField',
        id: FIELD_ID,
        name: 'Helm Stage',
        options: [OPTION_DISCOVERY, OPTION_SPEC_READY],
      },
    },
  };
}

function itemsPage(
  issues: Array<{ number: number; title: string; state: 'OPEN' | 'CLOSED'; optionId?: string }>,
  hasNextPage: boolean,
  endCursor: string | null,
): GetProjectItemsResponse {
  return {
    node: {
      items: {
        pageInfo: { hasNextPage, endCursor },
        nodes: issues.map((iss) => ({
          id: `PVTI_${iss.number}`,
          fieldValues: {
            nodes: iss.optionId
              ? [
                  {
                    __typename: 'ProjectV2ItemFieldSingleSelectValue' as const,
                    field: { name: 'Helm Stage' },
                    name: iss.optionId === 'opt-disc' ? 'discovery' : 'spec-ready',
                    optionId: iss.optionId,
                  },
                ]
              : [],
          },
          content: {
            __typename: 'Issue' as const,
            id: `I_${iss.number}`,
            number: iss.number,
            title: iss.title,
            url: `https://github.com/test-org/repo/issues/${iss.number}`,
            state: iss.state,
          },
        })),
      },
    },
  };
}

function makeApiError(status: number): { response: { status: number }; message: string } {
  return { response: { status }, message: `HTTP ${status}` };
}

// ── Test setup ────────────────────────────────────────────────────────────────

function makeAdapter(options?: { ttlMs?: number }): {
  adapter: GitHubProjectsAdapter;
  gql: Mock;
} {
  const gql = vi.fn() as Mock;
  const adapter = new GitHubProjectsAdapter(CONFIG, 'test-token', {
    ttlMs: options?.ttlMs,
    _graphql: gql as unknown as GraphqlFn,
  });
  return { adapter, gql };
}

/** Registers the standard 3-call sequence: GET_PROJECT + GET_PROJECT_FIELDS (no field) + GET_PROJECT_ITEMS */
function setupReadMocks(
  gql: Mock,
  issues: Array<{ number: number; title: string; state: 'OPEN' | 'CLOSED'; optionId?: string }>,
  fieldName = 'Helm Stage',
): void {
  gql
    .mockResolvedValueOnce(projectRes())
    .mockResolvedValueOnce(fieldsRes(fieldName))
    .mockResolvedValueOnce(itemsPage(issues, false, null));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GitHubProjectsAdapter', () => {
  describe('constructor', () => {
    it('throws GitHubAuthError when token is empty string', () => {
      expect(() => new GitHubProjectsAdapter(CONFIG, '')).toThrow(GitHubAuthError);
    });

    it('throws GitHubAuthError when token is blank whitespace', () => {
      expect(() => new GitHubProjectsAdapter(CONFIG, '   ')).toThrow(GitHubAuthError);
    });
  });

  describe('personal account support (repositoryOwner polymorphic query)', () => {
    it('resolves projectId for a personal (User) account', async () => {
      const { adapter, gql } = makeAdapter();
      gql
        .mockResolvedValueOnce(projectResUser())
        .mockResolvedValueOnce(fieldsRes('Helm Stage'))
        .mockResolvedValueOnce(
          itemsPage([{ number: 1, title: 'Item', state: 'OPEN' }], false, null),
        );

      const item = await adapter.getItem('issue_1');
      expect(item?.externalId).toBe('issue_1');
    });

    it('resolves projectId for an org (Organization) account', async () => {
      const { adapter, gql } = makeAdapter();
      gql
        .mockResolvedValueOnce(projectRes())
        .mockResolvedValueOnce(fieldsRes('Helm Stage'))
        .mockResolvedValueOnce(
          itemsPage([{ number: 1, title: 'Item', state: 'OPEN' }], false, null),
        );

      const item = await adapter.getItem('issue_1');
      expect(item?.externalId).toBe('issue_1');
    });

    it('throws GitHubNotFoundError when repositoryOwner is null', async () => {
      const { adapter, gql } = makeAdapter();
      gql.mockResolvedValueOnce({ repositoryOwner: null });
      await expect(adapter.getItem('issue_1')).rejects.toThrow(GitHubNotFoundError);
    });

    it('throws GitHubNotFoundError when project is not found under the owner', async () => {
      const { adapter, gql } = makeAdapter();
      gql.mockResolvedValueOnce({ repositoryOwner: { __typename: 'User', projectV2: null } });
      await expect(adapter.getItem('issue_1')).rejects.toThrow(GitHubNotFoundError);
    });

    it('regression: dual org+user query threw partial-data error on personal accounts — repositoryOwner fixes this', async () => {
      // The previous GET_PROJECT queried `organization` + `user` in parallel.
      // When `organization(login: 'lhpaul')` fails, GitHub returns BOTH data AND errors[].
      // @octokit/graphql throws GraphqlResponseError on any errors[], so the user fallback
      // was never reached. repositoryOwner resolves without errors for personal accounts.
      const { adapter, gql } = makeAdapter();
      gql
        .mockResolvedValueOnce(projectResUser())
        .mockResolvedValueOnce(fieldsRes('Helm Stage'))
        .mockResolvedValueOnce(
          itemsPage([{ number: 5, title: 'Hello world endpoint', state: 'OPEN' }], false, null),
        );

      const item = await adapter.getItem('issue_5');
      expect(item?.externalId).toBe('issue_5');
      expect(item?.title).toBe('Hello world endpoint');
    });
  });

  describe('ensureSubStages', () => {
    it('creates the Helm Stage field when it does not exist', async () => {
      const { adapter, gql } = makeAdapter();
      gql
        .mockResolvedValueOnce(projectRes())
        .mockResolvedValueOnce(fieldsRes()) // empty — field missing
        .mockResolvedValueOnce(createFieldRes());

      await adapter.ensureSubStages(CONFIG);

      expect(gql).toHaveBeenCalledTimes(3);
      expect(gql.mock.calls[2]![0]).toContain('createProjectV2Field');
    });

    it('does not create the field when it already exists (idempotent)', async () => {
      const { adapter, gql } = makeAdapter();
      gql.mockResolvedValueOnce(projectRes()).mockResolvedValueOnce(fieldsRes('Helm Stage'));

      await adapter.ensureSubStages(CONFIG);

      expect(gql).toHaveBeenCalledTimes(2);
      expect(gql.mock.calls[1]![0]).not.toContain('createProjectV2Field');
    });

    it('throws GitHubConfigError when provider is not github_projects', async () => {
      const { adapter } = makeAdapter();
      const linearConfig = {
        provider: 'linear',
        workspace: 'w',
        team_key: 'T',
        label_prefix: 'helm:',
      } as const;
      await expect(adapter.ensureSubStages(linearConfig)).rejects.toThrow(GitHubConfigError);
    });

    it('maps a 401 API error to GitHubAuthError', async () => {
      const { adapter, gql } = makeAdapter();
      gql.mockRejectedValueOnce(makeApiError(401));
      await expect(adapter.ensureSubStages(CONFIG)).rejects.toThrow(GitHubAuthError);
    });

    it('maps a 500 API error to GitHubAPIError', async () => {
      const { adapter, gql } = makeAdapter();
      gql.mockRejectedValueOnce(makeApiError(500));
      await expect(adapter.ensureSubStages(CONFIG)).rejects.toThrow(GitHubAPIError);
    });
  });

  describe('getItem', () => {
    it('returns a normalized item by externalId', async () => {
      const { adapter, gql } = makeAdapter();
      setupReadMocks(gql, [{ number: 42, title: 'Fix bug', state: 'OPEN' }]);

      const item = await adapter.getItem('issue_42');

      expect(item).toEqual({
        externalId: 'issue_42',
        title: 'Fix bug',
        subStage: null,
        status: 'open',
        url: 'https://github.com/test-org/repo/issues/42',
      });
    });

    it('returns null when externalId is not found', async () => {
      const { adapter, gql } = makeAdapter();
      setupReadMocks(gql, [{ number: 1, title: 'Item', state: 'OPEN' }]);

      expect(await adapter.getItem('issue_999')).toBeNull();
    });

    it('uses the cache on second call within TTL (no extra fetch)', async () => {
      const { adapter, gql } = makeAdapter();
      setupReadMocks(gql, [{ number: 1, title: 'Item', state: 'OPEN' }]);

      await adapter.getItem('issue_1');
      await adapter.getItem('issue_1');

      // 3 calls: GET_PROJECT + GET_PROJECT_FIELDS + GET_PROJECT_ITEMS — not 6
      expect(gql).toHaveBeenCalledTimes(3);
    });

    it('re-fetches items after TTL expires', async () => {
      const { adapter, gql } = makeAdapter({ ttlMs: 0 });
      setupReadMocks(gql, [{ number: 1, title: 'Item', state: 'OPEN' }]);
      // Second batch: setup is already done, only GET_PROJECT_ITEMS again
      gql.mockResolvedValueOnce(
        itemsPage([{ number: 1, title: 'Item', state: 'OPEN' }], false, null),
      );

      await adapter.getItem('issue_1');
      await adapter.getItem('issue_1');

      // 3 (setup+page1) + 1 (page2 only — setup skipped)
      expect(gql).toHaveBeenCalledTimes(4);
    });

    it('single-flight: concurrent calls result in one fetch', async () => {
      const { adapter, gql } = makeAdapter();
      setupReadMocks(gql, [{ number: 1, title: 'Item', state: 'OPEN' }]);

      await Promise.all([adapter.getItem('issue_1'), adapter.getItem('issue_1')]);

      expect(gql).toHaveBeenCalledTimes(3);
    });
  });

  describe('listItems', () => {
    beforeEach(() => {});

    it('returns all items when no filter given', async () => {
      const { adapter, gql } = makeAdapter();
      setupReadMocks(gql, [
        { number: 1, title: 'Open', state: 'OPEN' },
        { number: 2, title: 'Closed', state: 'CLOSED' },
      ]);

      const items = await adapter.listItems();
      expect(items).toHaveLength(2);
    });

    it('filters by status', async () => {
      const { adapter, gql } = makeAdapter();
      setupReadMocks(gql, [
        { number: 1, title: 'Open', state: 'OPEN' },
        { number: 2, title: 'Closed', state: 'CLOSED' },
      ]);

      const open = await adapter.listItems({ status: 'open' });
      expect(open).toHaveLength(1);
      expect(open[0]!.externalId).toBe('issue_1');
    });

    it('filters by subStage', async () => {
      const { adapter, gql } = makeAdapter();
      setupReadMocks(gql, [
        { number: 1, title: 'No stage', state: 'OPEN' },
        { number: 2, title: 'Discovery', state: 'OPEN', optionId: 'opt-disc' },
      ]);

      const disc = await adapter.listItems({ subStage: 'discovery' });
      expect(disc).toHaveLength(1);
      expect(disc[0]!.externalId).toBe('issue_2');
    });

    it('returns defensive copies — mutations do not affect cache', async () => {
      const { adapter, gql } = makeAdapter();
      setupReadMocks(gql, [{ number: 1, title: 'Original', state: 'OPEN' }]);

      const items = await adapter.listItems();
      items[0]!.title = 'Mutated';

      const items2 = await adapter.listItems();
      expect(items2[0]!.title).toBe('Original');
    });

    it('paginates across multiple pages and collects all items', async () => {
      const { adapter, gql } = makeAdapter();
      gql
        .mockResolvedValueOnce(projectRes())
        .mockResolvedValueOnce(fieldsRes('Helm Stage'))
        .mockResolvedValueOnce(
          itemsPage(
            [
              { number: 1, title: 'Item 1', state: 'OPEN' },
              { number: 2, title: 'Item 2', state: 'OPEN' },
            ],
            true,
            'cursor_abc',
          ),
        )
        .mockResolvedValueOnce(
          itemsPage(
            [
              { number: 3, title: 'Item 3', state: 'CLOSED' },
              { number: 4, title: 'Item 4', state: 'OPEN' },
            ],
            false,
            null,
          ),
        );

      const items = await adapter.listItems();

      expect(items).toHaveLength(4);
      // 4 calls: GET_PROJECT + GET_PROJECT_FIELDS + page-1 + page-2
      expect(gql).toHaveBeenCalledTimes(4);
      // Second GET_PROJECT_ITEMS call must carry the cursor
      expect(gql.mock.calls[3]![1]).toMatchObject({ after: 'cursor_abc' });
    });
  });

  describe('subStage decoding', () => {
    it('decodes optionId to the correct WorkflowStage via the lookup map', async () => {
      const { adapter, gql } = makeAdapter();
      setupReadMocks(gql, [
        { number: 5, title: 'In discovery', state: 'OPEN', optionId: 'opt-disc' },
      ]);

      const item = await adapter.getItem('issue_5');
      expect(item?.subStage).toBe('discovery');
    });
  });

  describe('parseWebhook (never throws)', () => {
    it('returns unknown for unrecognised shape and never throws', () => {
      const { adapter } = makeAdapter();
      expect(adapter.parseWebhook({ type: 'push' })).toMatchObject({ type: 'unknown' });
      expect(adapter.parseWebhook(null)).toMatchObject({ type: 'unknown', raw: null });
    });
  });

  describe('error mapping', () => {
    it('maps a 404 API error to GitHubNotFoundError', async () => {
      const { adapter, gql } = makeAdapter();
      gql.mockRejectedValueOnce(makeApiError(404));
      await expect(adapter.getItem('issue_1')).rejects.toThrow(GitHubNotFoundError);
    });
  });

  describe('write operations', () => {
    /** Seeds item cache with one issue so node maps are populated. */
    function seedCache(gql: Mock): void {
      gql
        .mockResolvedValueOnce(projectRes())
        .mockResolvedValueOnce(fieldsRes('Helm Stage'))
        .mockResolvedValueOnce(
          itemsPage(
            [{ number: 1, title: 'Item', state: 'OPEN', optionId: 'opt-disc' }],
            false,
            null,
          ),
        );
    }

    describe('setSubStage', () => {
      it('calls updateProjectV2ItemFieldValue with correct args and invalidates cache', async () => {
        const { adapter, gql } = makeAdapter();
        seedCache(gql);
        // Populate cache (and node maps)
        await adapter.getItem('issue_1');
        // Mock the mutation
        gql.mockResolvedValueOnce({
          updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } },
        });

        await adapter.setSubStage('issue_1', 'spec-ready');

        expect(gql.mock.calls.at(-1)![0]).toContain('updateProjectV2ItemFieldValue');
        expect(gql.mock.calls.at(-1)![1]).toMatchObject({
          itemId: 'PVTI_1',
          fieldId: FIELD_ID,
          value: { singleSelectOptionId: 'opt-spec' },
        });
        // Cache should be invalidated
        expect((adapter as unknown as { cache: unknown }).cache).toBeNull();
      });

      it('throws GitHubNotFoundError when externalId not in cache', async () => {
        const { adapter, gql } = makeAdapter();
        seedCache(gql);
        await adapter.getItem('issue_1'); // populate cache
        await expect(adapter.setSubStage('issue_999', 'discovery')).rejects.toThrow(
          GitHubNotFoundError,
        );
      });

      it('throws GitHubNotFoundError when stage has no option ID (maps not populated)', async () => {
        const { adapter, gql } = makeAdapter();
        // Seed with empty fields so stageToOptionId stays empty
        gql
          .mockResolvedValueOnce(projectRes())
          .mockResolvedValueOnce(fieldsRes()) // no Helm Stage field
          .mockResolvedValueOnce(
            itemsPage([{ number: 1, title: 'X', state: 'OPEN' }], false, null),
          );
        await adapter.getItem('issue_1');
        await expect(adapter.setSubStage('issue_1', 'discovery')).rejects.toThrow(
          GitHubNotFoundError,
        );
      });
    });

    describe('setStatus', () => {
      it('calls closeIssue when status is closed', async () => {
        const { adapter, gql } = makeAdapter();
        seedCache(gql);
        await adapter.getItem('issue_1');
        gql.mockResolvedValueOnce({ closeIssue: { issue: { state: 'CLOSED' } } });

        await adapter.setStatus('issue_1', 'closed');

        expect(gql.mock.calls.at(-1)![0]).toContain('closeIssue');
        expect(gql.mock.calls.at(-1)![1]).toMatchObject({ issueId: 'I_1' });
      });

      it('calls reopenIssue when status is open', async () => {
        const { adapter, gql } = makeAdapter();
        seedCache(gql);
        await adapter.getItem('issue_1');
        gql.mockResolvedValueOnce({ reopenIssue: { issue: { state: 'OPEN' } } });

        await adapter.setStatus('issue_1', 'open');

        expect(gql.mock.calls.at(-1)![0]).toContain('reopenIssue');
      });
    });

    describe('comment', () => {
      it('calls addComment with the issue node ID and body', async () => {
        const { adapter, gql } = makeAdapter();
        seedCache(gql);
        await adapter.getItem('issue_1');
        gql.mockResolvedValueOnce({ addComment: { commentEdge: { node: { id: 'comment_1' } } } });

        await adapter.comment('issue_1', 'LGTM');

        expect(gql.mock.calls.at(-1)![0]).toContain('addComment');
        expect(gql.mock.calls.at(-1)![1]).toMatchObject({ subjectId: 'I_1', body: 'LGTM' });
      });

      it('throws GitHubNotFoundError when externalId not found', async () => {
        const { adapter, gql } = makeAdapter();
        seedCache(gql);
        await adapter.getItem('issue_1');
        await expect(adapter.comment('issue_999', 'hi')).rejects.toThrow(GitHubNotFoundError);
      });
    });

    describe('registerWebhook', () => {
      it('POSTs to the GitHub org hooks endpoint with correct payload', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 201 });
        const gqlMock = vi.fn().mockResolvedValueOnce(projectRes()); // ensureProjectId call
        const adapterWithWebhook = new GitHubProjectsAdapter(CONFIG, 'test-token', {
          _graphql: gqlMock as unknown as GraphqlFn,
          _fetch: fetchMock as unknown as FetchFn,
          webhookSecret: 'my-secret',
        });

        await adapterWithWebhook.registerWebhook('https://example.com/hook');

        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toContain('/orgs/test-org/hooks');
        const body = JSON.parse(init.body as string);
        expect(body.events).toContain('projects_v2_item');
        expect(body.config.url).toBe('https://example.com/hook');
      });

      it('throws GitHubConfigError for personal account (user) projects', async () => {
        const gqlMock = vi.fn().mockResolvedValueOnce(projectResUser());
        const adapterPersonal = new GitHubProjectsAdapter(CONFIG, 'test-token', {
          _graphql: gqlMock as unknown as GraphqlFn,
          _fetch: vi.fn() as unknown as FetchFn,
          webhookSecret: 'my-secret',
        });
        await expect(adapterPersonal.registerWebhook('https://example.com/hook')).rejects.toThrow(
          /personal account/,
        );
      });

      it('throws GitHubConfigError when webhookSecret is not set', async () => {
        const { adapter } = makeAdapter();
        await expect(adapter.registerWebhook('https://example.com/hook')).rejects.toThrow(
          GitHubConfigError,
        );
      });
    });

    describe('parseWebhook (projects_v2_item.edited)', () => {
      it('resolves subStage from internal map when cache is seeded', async () => {
        const { adapter, gql } = makeAdapter();
        seedCache(gql);
        await adapter.getItem('issue_1'); // populates issueNodeIdToExternalId

        const raw = {
          eventType: 'projects_v2_item',
          payload: {
            action: 'edited',
            changes: {
              field_value: {
                field_node_id: FIELD_ID,
                field_type: 'single_select',
                to: { id: 'opt-disc', name: 'discovery' },
              },
            },
            projects_v2_item: { content_node_id: 'I_1', content_type: 'Issue' },
          },
        };
        const event = adapter.parseWebhook(raw);
        expect(event).toMatchObject({
          type: 'item_updated',
          externalId: 'issue_1',
          subStage: 'discovery',
        });
      });

      it('returns unknown when issueNodeIdToExternalId map is empty (cache not seeded)', () => {
        const { adapter } = makeAdapter();
        const raw = {
          eventType: 'projects_v2_item',
          payload: {
            action: 'edited',
            changes: {
              field_value: {
                field_node_id: FIELD_ID,
                field_type: 'single_select',
                to: { id: 'opt-disc', name: 'discovery' },
              },
            },
            projects_v2_item: { content_node_id: 'I_unknown', content_type: 'Issue' },
          },
        };
        expect(adapter.parseWebhook(raw).type).toBe('unknown');
      });
    });
  });
});
