import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { LinearAdapter } from './adapter.js';
import type { LinearTrackerConfig } from './adapter.js';
import { LinearAuthError, LinearAPIError, LinearNotFoundError } from './errors.js';
import type {
  GetTeamByKeyResponse,
  ListTeamIssuesResponse,
  GetIssueByIdentifierResponse,
  ListTeamLabelsResponse,
  ListTeamStatesResponse,
  CreateLabelResponse,
  IssueAddLabelResponse,
  IssueRemoveLabelResponse,
  UpdateIssueStateResponse,
  CreateCommentResponse,
} from './graphql-types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CONFIG: LinearTrackerConfig = {
  provider: 'linear',
  api_key_env: 'LINEAR_API_KEY',
  team_key: 'MOM',
  webhook_secret_env: 'LINEAR_WEBHOOK_SECRET',
};

const TEAM_ID = 'team-uuid-1';
const ISSUE_UUID = 'issue-uuid-abc';
const ISSUE_IDENTIFIER = 'MOM-42';

function teamRes(): GetTeamByKeyResponse {
  return { teams: { nodes: [{ id: TEAM_ID, key: 'MOM', name: 'MOME' }] } };
}

function statesRes(): ListTeamStatesResponse {
  return {
    workflowStates: {
      nodes: [
        { id: 'state-backlog', name: 'Backlog', type: 'backlog' },
        { id: 'state-started', name: 'In Progress', type: 'started' },
        { id: 'state-done', name: 'Done', type: 'completed' },
        { id: 'state-cancelled', name: 'Cancelled', type: 'cancelled' },
      ],
    },
  };
}

function labelsRes(extra: Array<{ id: string; name: string }> = []): ListTeamLabelsResponse {
  return {
    issueLabels: {
      nodes: [
        { id: 'label-disc', name: 'helm:discovery' },
        { id: 'label-spec-draft', name: 'helm:spec-draft' },
        ...extra,
      ],
    },
  };
}

function issueRes(
  overrides: Partial<{
    id: string;
    identifier: string;
    stateType: string;
    labelNames: string[];
  }> = {},
): GetIssueByIdentifierResponse {
  const {
    id = ISSUE_UUID,
    identifier = ISSUE_IDENTIFIER,
    stateType = 'started',
    labelNames = [],
  } = overrides;
  return {
    issue: {
      id,
      identifier,
      title: 'Test issue',
      description: 'Some description',
      url: `https://linear.app/mom/issue/${identifier}`,
      state: { id: 'state-started', name: 'In Progress', type: stateType },
      labels: { nodes: labelNames.map((name, i) => ({ id: `label-${i}`, name })) },
    },
  };
}

function listIssuesRes(issues: Array<{ identifier: string; id: string }>): ListTeamIssuesResponse {
  return {
    issues: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: issues.map(({ identifier, id }) => ({
        id,
        identifier,
        title: `Issue ${identifier}`,
        description: null,
        url: `https://linear.app/mom/issue/${identifier}`,
        state: { id: 'state-started', name: 'In Progress', type: 'started' },
        labels: { nodes: [] },
      })),
    },
  };
}

// ── Test helper ───────────────────────────────────────────────────────────────

function mockFetch(responses: unknown[]): Mock {
  let call = 0;
  return vi.fn().mockImplementation(() => {
    const data = responses[call++] ?? { data: {} };
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data }),
    });
  });
}

function makeAdapter(fetchMock: Mock): LinearAdapter {
  return new LinearAdapter(CONFIG, 'test-api-key', { _fetch: fetchMock, ttlMs: 0 });
}

// ── Constructor ───────────────────────────────────────────────────────────────

describe('LinearAdapter constructor', () => {
  it('throws LinearAuthError when apiKey is blank', () => {
    expect(() => new LinearAdapter(CONFIG, '')).toThrow(LinearAuthError);
  });

  it('throws LinearAuthError when apiKey is whitespace only', () => {
    expect(() => new LinearAdapter(CONFIG, '   ')).toThrow(LinearAuthError);
  });
});

// ── getItem ───────────────────────────────────────────────────────────────────

describe('LinearAdapter.getItem', () => {
  it('returns NormalizedItem for a found issue', async () => {
    const fetch = mockFetch([issueRes()]);
    const adapter = makeAdapter(fetch);
    const item = await adapter.getItem(ISSUE_IDENTIFIER);
    expect(item).not.toBeNull();
    expect(item?.externalId).toBe(ISSUE_IDENTIFIER);
    expect(item?.status).toBe('open');
    expect(item?.subStage).toBeNull();
  });

  it('returns null when issue is not found', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { issue: null } }),
    });
    const adapter = makeAdapter(fetch);
    const item = await adapter.getItem('MOM-999');
    expect(item).toBeNull();
  });

  it('maps helm:* label to subStage', async () => {
    const fetch = mockFetch([issueRes({ labelNames: ['helm:discovery', 'other-label'] })]);
    const adapter = makeAdapter(fetch);
    const item = await adapter.getItem(ISSUE_IDENTIFIER);
    expect(item?.subStage).toBe('discovery');
  });

  it('maps completed state to closed status', async () => {
    const fetch = mockFetch([issueRes({ stateType: 'completed' })]);
    const adapter = makeAdapter(fetch);
    const item = await adapter.getItem(ISSUE_IDENTIFIER);
    expect(item?.status).toBe('closed');
  });

  it('maps cancelled state to closed status', async () => {
    const fetch = mockFetch([issueRes({ stateType: 'cancelled' })]);
    const adapter = makeAdapter(fetch);
    const item = await adapter.getItem(ISSUE_IDENTIFIER);
    expect(item?.status).toBe('closed');
  });
});

// ── listItems ─────────────────────────────────────────────────────────────────

describe('LinearAdapter.listItems', () => {
  it('returns all items when no filter', async () => {
    const fetch = mockFetch([
      listIssuesRes([
        { id: 'id-1', identifier: 'MOM-1' },
        { id: 'id-2', identifier: 'MOM-2' },
      ]),
    ]);
    const adapter = makeAdapter(fetch);
    const items = await adapter.listItems();
    expect(items).toHaveLength(2);
  });

  it('filters by status', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          data: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'id-1',
                  identifier: 'MOM-1',
                  title: 'Open',
                  description: null,
                  url: 'https://linear.app/mom/issue/MOM-1',
                  state: { id: 's1', name: 'Backlog', type: 'backlog' },
                  labels: { nodes: [] },
                },
                {
                  id: 'id-2',
                  identifier: 'MOM-2',
                  title: 'Done',
                  description: null,
                  url: 'https://linear.app/mom/issue/MOM-2',
                  state: { id: 's2', name: 'Done', type: 'completed' },
                  labels: { nodes: [] },
                },
              ],
            },
          },
        }),
    });
    const adapter = makeAdapter(fetch);
    const closed = await adapter.listItems({ status: 'closed' });
    expect(closed).toHaveLength(1);
    expect(closed[0]?.externalId).toBe('MOM-2');
  });

  it('paginates when hasNextPage is true', async () => {
    let call = 0;
    const fetch = vi.fn().mockImplementation(() => {
      call++;
      const isFirst = call === 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: {
              issues: {
                pageInfo: { hasNextPage: isFirst, endCursor: isFirst ? 'cursor-1' : null },
                nodes: isFirst
                  ? [
                      {
                        id: 'id-1',
                        identifier: 'MOM-1',
                        title: 'First',
                        description: null,
                        url: 'u',
                        state: { id: 's', name: 'Backlog', type: 'backlog' },
                        labels: { nodes: [] },
                      },
                    ]
                  : [
                      {
                        id: 'id-2',
                        identifier: 'MOM-2',
                        title: 'Second',
                        description: null,
                        url: 'u',
                        state: { id: 's', name: 'Backlog', type: 'backlog' },
                        labels: { nodes: [] },
                      },
                    ],
              },
            },
          }),
      });
    });
    const adapter = makeAdapter(fetch);
    const items = await adapter.listItems();
    expect(items).toHaveLength(2);
    expect(call).toBe(2);
  });
});

// ── setSubStage ───────────────────────────────────────────────────────────────

describe('LinearAdapter.setSubStage', () => {
  it('removes existing helm:* labels and adds the new one', async () => {
    const addLabelRes: IssueAddLabelResponse = {
      issueAddLabel: {
        success: true,
        issue: { id: ISSUE_UUID, identifier: ISSUE_IDENTIFIER, labels: { nodes: [] } },
      },
    };
    const removeLabelRes: IssueRemoveLabelResponse = {
      issueRemoveLabel: {
        success: true,
        issue: { id: ISSUE_UUID, identifier: ISSUE_IDENTIFIER, labels: { nodes: [] } },
      },
    };

    let call = 0;
    const fetch = vi.fn().mockImplementation(() => {
      call++;
      let data: unknown;
      if (call === 1) {
        // resolveIssueId: GET_ISSUE_BY_IDENTIFIER
        data = issueRes({ labelNames: ['helm:discovery'] }).issue
          ? { issue: issueRes({ labelNames: ['helm:discovery'] }).issue }
          : {};
      } else if (call === 2) {
        // ensureLabels: LIST_TEAM_LABELS — includes spec-draft
        data = labelsRes([
          { id: 'label-spec-draft', name: 'helm:spec-draft' },
          { id: 'label-plan-draft', name: 'helm:plan-draft' },
          { id: 'label-spec-ready', name: 'helm:spec-ready' },
          { id: 'label-plan-ready', name: 'helm:plan-ready' },
          { id: 'label-in-development', name: 'helm:in-development' },
          { id: 'label-code-review', name: 'helm:code-review' },
          { id: 'label-remediation', name: 'helm:remediation' },
          { id: 'label-released', name: 'helm:released' },
        ]);
      } else if (call === 3) {
        // GET_ISSUE_BY_IDENTIFIER to get current labels
        data = { issue: issueRes({ labelNames: ['helm:discovery'] }).issue };
      } else if (call === 4) {
        // ISSUE_REMOVE_LABEL for existing helm:discovery
        data = removeLabelRes;
      } else {
        // ISSUE_ADD_LABEL for helm:spec-draft
        data = addLabelRes;
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data }),
      });
    });

    const adapter = makeAdapter(fetch);
    await expect(adapter.setSubStage(ISSUE_IDENTIFIER, 'spec-draft')).resolves.toBeUndefined();
    // Remove called for existing helm:discovery, add called for helm:spec-draft
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});

// ── setStatus ─────────────────────────────────────────────────────────────────

describe('LinearAdapter.setStatus', () => {
  it('calls UPDATE_ISSUE_STATE with the closed state ID', async () => {
    const updateRes: UpdateIssueStateResponse = {
      issueUpdate: {
        success: true,
        issue: {
          id: ISSUE_UUID,
          identifier: ISSUE_IDENTIFIER,
          state: { id: 'state-done', name: 'Done', type: 'completed' },
        },
      },
    };
    let call = 0;
    const fetch = vi.fn().mockImplementation(() => {
      call++;
      let data: unknown;
      if (call === 1)
        data = { issue: issueRes().issue }; // resolveIssueId
      else if (call === 2)
        data = statesRes(); // ensureStates → LIST_TEAM_STATES
      else data = updateRes; // UPDATE_ISSUE_STATE
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data }) });
    });
    const adapter = makeAdapter(fetch);
    await expect(adapter.setStatus(ISSUE_IDENTIFIER, 'closed')).resolves.toBeUndefined();
  });

  it('calls UPDATE_ISSUE_STATE with the open state ID', async () => {
    const updateRes: UpdateIssueStateResponse = {
      issueUpdate: {
        success: true,
        issue: {
          id: ISSUE_UUID,
          identifier: ISSUE_IDENTIFIER,
          state: { id: 'state-backlog', name: 'Backlog', type: 'backlog' },
        },
      },
    };
    let call = 0;
    const fetch = vi.fn().mockImplementation(() => {
      call++;
      let data: unknown;
      if (call === 1) data = { issue: issueRes().issue };
      else if (call === 2) data = statesRes();
      else data = updateRes;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data }) });
    });
    const adapter = makeAdapter(fetch);
    await expect(adapter.setStatus(ISSUE_IDENTIFIER, 'open')).resolves.toBeUndefined();
  });
});

// ── setWorkflowStateByType (ADR-034) ────────────────────────────────────────────

describe('LinearAdapter.setWorkflowStateByType', () => {
  const updateRes: UpdateIssueStateResponse = {
    issueUpdate: {
      success: true,
      issue: {
        id: ISSUE_UUID,
        identifier: ISSUE_IDENTIFIER,
        state: { id: 'state-started', name: 'In Progress', type: 'started' },
      },
    },
  };

  // The GraphQL variables sent on a given fetch call (body = {query, variables}).
  function variablesOf(fetch: Mock, callIndex: number): Record<string, unknown> {
    const body = fetch.mock.calls[callIndex]?.[1]?.body as string;
    return JSON.parse(body).variables;
  }

  it('resolves the started-type stateId and calls UPDATE_ISSUE_STATE', async () => {
    // call 1 resolveIssueId, call 2 ensureStates → LIST_TEAM_STATES, call 3 UPDATE_ISSUE_STATE
    const fetch = mockFetch([{ issue: issueRes().issue }, statesRes(), updateRes]);
    const adapter = makeAdapter(fetch);
    await expect(
      adapter.setWorkflowStateByType(ISSUE_IDENTIFIER, 'started'),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
    // started → first state of type 'started' in statesRes() == 'state-started'
    expect(variablesOf(fetch, 2)).toMatchObject({ issueId: ISSUE_UUID, stateId: 'state-started' });
  });

  it('resolves the completed-type stateId and calls UPDATE_ISSUE_STATE', async () => {
    const fetch = mockFetch([{ issue: issueRes().issue }, statesRes(), updateRes]);
    const adapter = makeAdapter(fetch);
    await adapter.setWorkflowStateByType(ISSUE_IDENTIFIER, 'completed');
    // completed → first state of type 'completed' in statesRes() == 'state-done'
    expect(variablesOf(fetch, 2)).toMatchObject({ issueId: ISSUE_UUID, stateId: 'state-done' });
  });

  it('throws LinearNotFoundError when the team has no state of the requested type', async () => {
    // states with no 'completed'-type node — requesting completed must throw.
    const statesNoCompleted: ListTeamStatesResponse = {
      workflowStates: {
        nodes: [
          { id: 'state-backlog', name: 'Backlog', type: 'backlog' },
          { id: 'state-started', name: 'In Progress', type: 'started' },
        ],
      },
    };
    const fetch = mockFetch([{ issue: issueRes().issue }, statesNoCompleted]);
    const adapter = makeAdapter(fetch);
    await expect(adapter.setWorkflowStateByType(ISSUE_IDENTIFIER, 'completed')).rejects.toThrow(
      LinearNotFoundError,
    );
    // resolveIssueId + ensureStates only — no UPDATE_ISSUE_STATE call.
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('picks the FIRST state of a type when a team has several (ADR-034: first by position)', async () => {
    // Two 'started'-type states — Linear returns them ordered by position, so the
    // adapter must resolve the first ('state-started-1'), not a later one.
    const statesMultiStarted: ListTeamStatesResponse = {
      workflowStates: {
        nodes: [
          { id: 'state-backlog', name: 'Backlog', type: 'backlog' },
          { id: 'state-started-1', name: 'In Development', type: 'started' },
          { id: 'state-started-2', name: 'In Review', type: 'started' },
          { id: 'state-done', name: 'Done', type: 'completed' },
        ],
      },
    };
    const fetch = mockFetch([{ issue: issueRes().issue }, statesMultiStarted, updateRes]);
    const adapter = makeAdapter(fetch);
    await adapter.setWorkflowStateByType(ISSUE_IDENTIFIER, 'started');
    expect(variablesOf(fetch, 2)).toMatchObject({
      issueId: ISSUE_UUID,
      stateId: 'state-started-1',
    });
  });
});

// ── comment ───────────────────────────────────────────────────────────────────

describe('LinearAdapter.comment', () => {
  it('calls CREATE_COMMENT with issue UUID and body', async () => {
    const commentRes: CreateCommentResponse = {
      commentCreate: { comment: { id: 'comment-1' }, success: true },
    };
    let call = 0;
    const fetch = vi.fn().mockImplementation(() => {
      call++;
      const data = call === 1 ? { issue: issueRes().issue } : commentRes;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data }) });
    });
    const adapter = makeAdapter(fetch);
    await expect(adapter.comment(ISSUE_IDENTIFIER, 'Hello!')).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

// ── ensureSubStages ───────────────────────────────────────────────────────────

describe('LinearAdapter.ensureSubStages', () => {
  it('creates missing helm:* labels and skips existing ones', async () => {
    // labelsRes() has discovery + spec-draft. The adapter will create 8 more
    // (10 canonical stages − 2 existing). ADR-032 added `merged`.
    const createRes: CreateLabelResponse = {
      issueLabelCreate: { issueLabel: { id: 'new-label', name: 'helm:spec-ready' }, success: true },
    };
    let call = 0;
    const fetch = vi.fn().mockImplementation(() => {
      call++;
      let data: unknown;
      if (call === 1)
        data = teamRes(); // ensureTeamId → GET_TEAM_BY_KEY
      else if (call === 2)
        data = labelsRes(); // loadLabels → LIST_TEAM_LABELS
      else data = createRes; // CREATE_LABEL for each missing stage (8 calls)
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data }) });
    });
    const adapter = makeAdapter(fetch);
    await adapter.ensureSubStages(CONFIG);
    // 1 team + 1 labels + 8 creates = 10 total
    expect(fetch).toHaveBeenCalledTimes(10);
  });

  it('is idempotent when all labels exist', async () => {
    const allLabels = [
      'discovery',
      'spec-draft',
      'spec-ready',
      'plan-draft',
      'plan-ready',
      'in-development',
      'code-review',
      'remediation',
      'merged',
      'released',
    ].map((s, i) => ({ id: `label-${i}`, name: `helm:${s}` }));

    let call = 0;
    const fetch = vi.fn().mockImplementation(() => {
      call++;
      const data = call === 1 ? teamRes() : { issueLabels: { nodes: allLabels } };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data }) });
    });
    const adapter = makeAdapter(fetch);
    await adapter.ensureSubStages(CONFIG);
    // Only team + labels calls, no creates
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('throws LinearConfigError when provider is not linear', async () => {
    const fetch = vi.fn();
    const adapter = makeAdapter(fetch);
    await expect(
      adapter.ensureSubStages({
        provider: 'github_projects',
        org: 'x',
        project_number: 1,
        custom_field_name: 'S',
      }),
    ).rejects.toThrow('LinearAdapter requires provider');
  });
});

// ── parseWebhook ──────────────────────────────────────────────────────────────

describe('LinearAdapter.parseWebhook', () => {
  it('delegates to parseLinearWebhook — Issue.create', () => {
    const fetch = vi.fn();
    const adapter = makeAdapter(fetch);
    const result = adapter.parseWebhook({
      type: 'Issue',
      action: 'create',
      data: { identifier: 'MOM-1' },
    });
    expect(result).toMatchObject({ type: 'item_created', externalId: 'MOM-1' });
  });

  it('delegates to parseLinearWebhook — unknown payload', () => {
    const fetch = vi.fn();
    const adapter = makeAdapter(fetch);
    const result = adapter.parseWebhook(null);
    expect(result.type).toBe('unknown');
  });
});

// ── registerWebhook ───────────────────────────────────────────────────────────

describe('LinearAdapter.registerWebhook', () => {
  it('is a no-op that resolves without error', async () => {
    const fetch = vi.fn();
    const adapter = makeAdapter(fetch);
    await expect(adapter.registerWebhook()).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe('LinearAdapter error handling', () => {
  it('throws LinearAuthError on HTTP 401', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({}),
    });
    const adapter = makeAdapter(fetch);
    await expect(adapter.getItem(ISSUE_IDENTIFIER)).rejects.toThrow(LinearAuthError);
  });

  it('throws LinearAPIError on HTTP 500', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });
    const adapter = makeAdapter(fetch);
    await expect(adapter.getItem(ISSUE_IDENTIFIER)).rejects.toThrow(LinearAPIError);
  });

  it('throws LinearAPIError on GraphQL errors array', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ errors: [{ message: 'Not authenticated' }] }),
    });
    const adapter = makeAdapter(fetch);
    await expect(adapter.getItem(ISSUE_IDENTIFIER)).rejects.toThrow(LinearAPIError);
  });

  it('throws LinearAPIError on network failure', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('network down'));
    const adapter = makeAdapter(fetch);
    await expect(adapter.getItem(ISSUE_IDENTIFIER)).rejects.toThrow(LinearAPIError);
  });
});
