import { z } from 'zod';
import type { WorkflowStage } from '@helm/workflow';
import { WORKFLOW_STAGES } from '@helm/workflow';
import type { IssueTracker } from '@helm/shared';
import type { IssueTrackerAdapter } from '../interface.js';
import type { ItemFilter, NormalizedEvent, NormalizedItem } from '../types.js';
import {
  LinearAuthError,
  LinearAPIError,
  LinearConfigError,
  LinearNotFoundError,
} from './errors.js';
import {
  LIST_TEAM_ISSUES,
  GET_ISSUE_BY_IDENTIFIER,
  LIST_TEAM_LABELS,
  LIST_TEAM_STATES,
  CREATE_LABEL,
  GET_TEAM_BY_KEY,
  ISSUE_ADD_LABEL,
  ISSUE_REMOVE_LABEL,
  UPDATE_ISSUE_STATE,
  CREATE_COMMENT,
} from './graphql-queries.js';
import type {
  ListTeamIssuesResponse,
  GetIssueByIdentifierResponse,
  ListTeamLabelsResponse,
  ListTeamStatesResponse,
  GetTeamByKeyResponse,
  CreateLabelResponse,
  IssueAddLabelResponse,
  IssueRemoveLabelResponse,
  UpdateIssueStateResponse,
  CreateCommentResponse,
  LinearIssue,
} from './graphql-types.js';
import { helmStatusFromStateType } from './graphql-types.js';
import { parseLinearWebhook } from './webhook-parser.js';

export type LinearTrackerConfig = Extract<IssueTracker, { provider: 'linear' }>;

// Injectable fetch for testing.
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const LINEAR_GQL_ENDPOINT = 'https://api.linear.app/graphql';
const HELM_LABEL_PREFIX = 'helm:';
const HELM_LABEL_COLOR = '#7C3AED';
const DEFAULT_TTL_MS = 5 * 60 * 1000;

// Zod schema for validating GraphQL error responses.
const GQLErrorSchema = z.object({
  errors: z.array(z.object({ message: z.string() })).optional(),
});

type IssueEntry = {
  /** Linear UUID for GraphQL mutations */
  id: string;
  /** Cached state IDs for open/close transitions */
  stateIds: { open: string; closed: string } | null;
};

export class LinearAdapter implements IssueTrackerAdapter {
  private readonly config: LinearTrackerConfig;
  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;
  private readonly ttlMs: number;

  // Team UUID (fetched once)
  private teamId: string | null = null;
  private teamInitPromise: Promise<void> | null = null;

  // Label cache: name → id (for all labels in the team)
  private readonly labelNameToId = new Map<string, string>();
  private labelsReady = false;
  private labelsInitPromise: Promise<void> | null = null;

  // State IDs for this team (fetched once)
  private openStateId: string | null = null;
  private closedStateId: string | null = null;
  private statesReady = false;
  private statesInitPromise: Promise<void> | null = null;

  // Issue cache: identifier → entry with UUID and cached state IDs
  private readonly identifierToEntry = new Map<string, IssueEntry>();
  private itemCache: { items: NormalizedItem[]; expiresAt: number } | null = null;
  private cacheRefreshPromise: Promise<void> | null = null;

  constructor(
    config: LinearTrackerConfig,
    apiKey: string,
    options?: { ttlMs?: number; _fetch?: FetchFn },
  ) {
    if (!apiKey.trim()) {
      throw new LinearAuthError(
        'apiKey is blank — pass a non-empty Linear PAT as the second constructor argument',
      );
    }
    this.config = config;
    this.apiKey = apiKey;
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchFn =
      options?._fetch ??
      ((url, init) =>
        fetch(url, {
          ...init,
          headers: {
            // IMPORTANT: Linear PATs use raw Authorization without "Bearer" prefix.
            // @linear/sdk and linear-mcp@1.2.0 both send "Bearer <token>", which
            // Linear rejects for PATs — discovered during MOME agent-hq integration.
            Authorization: this.apiKey,
            'Content-Type': 'application/json',
            ...init?.headers,
          },
        }));
  }

  // ── IssueTrackerAdapter: ensureSubStages ──────────────────────────────────

  async ensureSubStages(config: IssueTracker): Promise<void> {
    if (config.provider !== 'linear') {
      throw new LinearConfigError(
        `LinearAdapter requires provider 'linear', got '${config.provider}'`,
      );
    }
    await this.ensureTeamId();
    await this.loadLabels();

    for (const stage of WORKFLOW_STAGES) {
      const labelName = `${HELM_LABEL_PREFIX}${stage}`;
      if (!this.labelNameToId.has(labelName)) {
        await this.createHelmLabel(labelName);
      }
    }
  }

  // ── IssueTrackerAdapter: reads ────────────────────────────────────────────

  async getItem(externalId: string): Promise<NormalizedItem | null> {
    const res = await this.executeGraphQL<GetIssueByIdentifierResponse>(GET_ISSUE_BY_IDENTIFIER, {
      identifier: externalId,
    });
    if (!res.issue) return null;
    const item = this.normalizeIssue(res.issue);
    this.identifierToEntry.set(item.externalId, { id: res.issue.id, stateIds: null });
    return item;
  }

  async listItems(filter?: ItemFilter): Promise<NormalizedItem[]> {
    await this.ensureItemCache();
    const all = this.itemCache!.items;
    if (!filter) return all.map((i) => ({ ...i }));
    return all
      .filter((item) => {
        if (filter.status !== undefined && item.status !== filter.status) return false;
        if (filter.subStage !== undefined && item.subStage !== filter.subStage) return false;
        return true;
      })
      .map((i) => ({ ...i }));
  }

  // ── IssueTrackerAdapter: writes ───────────────────────────────────────────

  async setSubStage(externalId: string, subStage: WorkflowStage): Promise<void> {
    const issueId = await this.resolveIssueId(externalId);
    await this.ensureLabels();

    const newLabelName = `${HELM_LABEL_PREFIX}${subStage}`;
    const newLabelId = this.labelNameToId.get(newLabelName);
    if (!newLabelId) {
      // Label is missing — create it and retry once.
      await this.ensureSubStages(this.config);
      const retryId = this.labelNameToId.get(newLabelName);
      if (!retryId) {
        throw new LinearNotFoundError(
          `Helm label '${newLabelName}' not found even after ensureSubStages`,
        );
      }
    }

    // Fetch current labels so we know which helm:* labels to remove.
    const issueRes = await this.executeGraphQL<GetIssueByIdentifierResponse>(
      GET_ISSUE_BY_IDENTIFIER,
      { identifier: externalId },
    );
    const currentLabels = issueRes.issue?.labels.nodes ?? [];
    const helmLabels = currentLabels.filter((l) => l.name.startsWith(HELM_LABEL_PREFIX));

    // Remove all existing helm:* labels (except the one we're about to add).
    for (const label of helmLabels) {
      if (label.id !== this.labelNameToId.get(newLabelName)) {
        await this.executeGraphQL<IssueRemoveLabelResponse>(ISSUE_REMOVE_LABEL, {
          issueId,
          labelId: label.id,
        });
      }
    }

    // Add the new label (if not already present).
    const alreadyPresent = currentLabels.some((l) => l.name === newLabelName);
    if (!alreadyPresent) {
      const labelId = this.labelNameToId.get(newLabelName)!;
      await this.executeGraphQL<IssueAddLabelResponse>(ISSUE_ADD_LABEL, { issueId, labelId });
    }

    this.itemCache = null;
  }

  async setStatus(externalId: string, status: 'open' | 'closed'): Promise<void> {
    const issueId = await this.resolveIssueId(externalId);
    await this.ensureStates();

    const stateId = status === 'closed' ? this.closedStateId : this.openStateId;
    if (!stateId) {
      throw new LinearNotFoundError(
        `No ${status} workflow state found for team '${this.config.team_key}'`,
      );
    }
    await this.executeGraphQL<UpdateIssueStateResponse>(UPDATE_ISSUE_STATE, { issueId, stateId });
    this.itemCache = null;
  }

  async comment(externalId: string, body: string): Promise<void> {
    const issueId = await this.resolveIssueId(externalId);
    await this.executeGraphQL<CreateCommentResponse>(CREATE_COMMENT, { issueId, body });
  }

  // ── IssueTrackerAdapter: webhook ──────────────────────────────────────────

  parseWebhook(rawEvent: unknown): NormalizedEvent {
    return parseLinearWebhook(rawEvent);
  }

  // Linear webhooks are configured manually in the Linear UI — see ADR-020.
  async registerWebhook(): Promise<void> {
    console.warn(
      '[LinearAdapter] registerWebhook is a no-op — Linear webhooks are configured manually ' +
        'in the Linear UI (Settings → API → Webhooks). See ADR-020 for details.',
    );
  }

  // ── Private: GraphQL client ───────────────────────────────────────────────

  private async executeGraphQL<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(LINEAR_GQL_ENDPOINT, {
        method: 'POST',
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new LinearAPIError(`Linear API request failed — ${message}`);
    }

    if (res.status === 401) {
      console.error('[LinearAdapter] Authentication error');
      throw new LinearAuthError(
        'Linear API authentication failed — verify the API key is a valid PAT ' +
          'and that it is passed WITHOUT "Bearer" prefix (Linear PATs require raw Authorization header)',
      );
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new LinearAPIError(`Linear API returned non-JSON response (HTTP ${res.status})`);
    }

    if (!res.ok) {
      const parsed = GQLErrorSchema.safeParse(json);
      const detail = parsed.success ? (parsed.data.errors?.[0]?.message ?? '') : '';
      console.error(`[LinearAdapter] API error (${res.status}):`, detail || json);
      throw new LinearAPIError(`Linear API error${detail ? ` — ${detail}` : ''}`, res.status);
    }

    const parsed = json as { data?: T; errors?: Array<{ message: string }> };
    if (parsed.errors?.length) {
      const detail = parsed.errors[0]?.message ?? 'unknown GraphQL error';
      console.error('[LinearAdapter] GraphQL error:', detail);
      throw new LinearAPIError(`Linear GraphQL error — ${detail}`);
    }

    return parsed.data as T;
  }

  // ── Private: team bootstrap ───────────────────────────────────────────────

  private async ensureTeamId(): Promise<void> {
    if (this.teamId !== null) return;
    if (this.teamInitPromise) return this.teamInitPromise;
    this.teamInitPromise = this.fetchTeamId().finally(() => {
      this.teamInitPromise = null;
    });
    return this.teamInitPromise;
  }

  private async fetchTeamId(): Promise<void> {
    const res = await this.executeGraphQL<GetTeamByKeyResponse>(GET_TEAM_BY_KEY, {
      teamKey: this.config.team_key,
    });
    const team = res.teams.nodes[0];
    if (!team) {
      throw new LinearNotFoundError(
        `Linear team with key '${this.config.team_key}' not found — verify team_key in product config`,
      );
    }
    this.teamId = team.id;
  }

  // ── Private: label cache ──────────────────────────────────────────────────

  private async ensureLabels(): Promise<void> {
    if (this.labelsReady) return;
    if (this.labelsInitPromise) return this.labelsInitPromise;
    this.labelsInitPromise = this.loadLabels().finally(() => {
      this.labelsInitPromise = null;
    });
    return this.labelsInitPromise;
  }

  private async loadLabels(): Promise<void> {
    const res = await this.executeGraphQL<ListTeamLabelsResponse>(LIST_TEAM_LABELS, {
      teamKey: this.config.team_key,
    });
    this.labelNameToId.clear();
    for (const label of res.issueLabels.nodes) {
      this.labelNameToId.set(label.name, label.id);
    }
    this.labelsReady = true;
  }

  private async createHelmLabel(name: string): Promise<void> {
    if (!this.teamId) await this.ensureTeamId();
    const res = await this.executeGraphQL<CreateLabelResponse>(CREATE_LABEL, {
      teamId: this.teamId,
      name,
      color: HELM_LABEL_COLOR,
    });
    this.labelNameToId.set(
      res.issueLabelCreate.issueLabel.name,
      res.issueLabelCreate.issueLabel.id,
    );
  }

  // ── Private: state cache ──────────────────────────────────────────────────

  private async ensureStates(): Promise<void> {
    if (this.statesReady) return;
    if (this.statesInitPromise) return this.statesInitPromise;
    this.statesInitPromise = this.loadStates().finally(() => {
      this.statesInitPromise = null;
    });
    return this.statesInitPromise;
  }

  private async loadStates(): Promise<void> {
    const res = await this.executeGraphQL<ListTeamStatesResponse>(LIST_TEAM_STATES, {
      teamKey: this.config.team_key,
    });
    const states = res.workflowStates.nodes;
    // Prefer "backlog" → "unstarted" → "triage" for open state.
    const openPreference = ['backlog', 'unstarted', 'triage', 'started'];
    for (const preferred of openPreference) {
      const s = states.find((st) => st.type === preferred);
      if (s) {
        this.openStateId = s.id;
        break;
      }
    }
    // Prefer "completed" for closed state; fall back to "cancelled".
    const closedPreference = ['completed', 'cancelled'];
    for (const preferred of closedPreference) {
      const s = states.find((st) => st.type === preferred);
      if (s) {
        this.closedStateId = s.id;
        break;
      }
    }
    this.statesReady = true;
  }

  // ── Private: issue ID resolution ──────────────────────────────────────────

  private async resolveIssueId(externalId: string): Promise<string> {
    const cached = this.identifierToEntry.get(externalId);
    if (cached) return cached.id;

    // Not in cache — fetch directly.
    const res = await this.executeGraphQL<GetIssueByIdentifierResponse>(GET_ISSUE_BY_IDENTIFIER, {
      identifier: externalId,
    });
    if (!res.issue) {
      throw new LinearNotFoundError(`Linear issue not found: ${externalId}`);
    }
    this.identifierToEntry.set(externalId, { id: res.issue.id, stateIds: null });
    return res.issue.id;
  }

  // ── Private: item cache ───────────────────────────────────────────────────

  private async ensureItemCache(): Promise<void> {
    if (this.itemCache && Date.now() < this.itemCache.expiresAt) return;
    if (this.cacheRefreshPromise) return this.cacheRefreshPromise;
    this.cacheRefreshPromise = this.fetchAllItems().finally(() => {
      this.cacheRefreshPromise = null;
    });
    return this.cacheRefreshPromise;
  }

  private async fetchAllItems(): Promise<void> {
    const items: NormalizedItem[] = [];
    const nextEntries = new Map<string, IssueEntry>();
    let cursor: string | null = null;

    do {
      const res: ListTeamIssuesResponse = await this.executeGraphQL<ListTeamIssuesResponse>(
        LIST_TEAM_ISSUES,
        {
          teamKey: this.config.team_key,
          after: cursor ?? undefined,
        },
      );
      for (const issue of res.issues.nodes) {
        const item = this.normalizeIssue(issue);
        items.push(item);
        nextEntries.set(issue.identifier, { id: issue.id, stateIds: null });
      }
      cursor =
        res.issues.pageInfo.hasNextPage === true ? (res.issues.pageInfo.endCursor ?? null) : null;
    } while (cursor !== null);

    // Atomic swap.
    this.identifierToEntry.clear();
    for (const [k, v] of nextEntries) this.identifierToEntry.set(k, v);
    this.itemCache = { items, expiresAt: Date.now() + this.ttlMs };
  }

  // ── Private: normalization ────────────────────────────────────────────────

  private normalizeIssue(issue: LinearIssue): NormalizedItem {
    const helmLabels = issue.labels.nodes.filter((l) => l.name.startsWith(HELM_LABEL_PREFIX));
    let subStage: WorkflowStage | null = null;
    for (const label of helmLabels) {
      const stage = label.name.slice(HELM_LABEL_PREFIX.length);
      if ((WORKFLOW_STAGES as ReadonlyArray<string>).includes(stage)) {
        subStage = stage as WorkflowStage;
        break;
      }
    }
    return {
      externalId: issue.identifier,
      title: issue.title,
      body: issue.description ?? undefined,
      subStage,
      status: helmStatusFromStateType(issue.state.type),
      url: issue.url,
    };
  }
}
