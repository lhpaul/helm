import { graphql as graphqlLib } from '@octokit/graphql';
import { z } from 'zod';
import type { WorkflowStage } from '@helm/workflow';
import { WORKFLOW_STAGES } from '@helm/workflow';
import type { IssueTracker } from '@helm/shared';
import type { IssueTrackerAdapter } from '../interface.js';
import type { ItemFilter, NormalizedEvent, NormalizedItem } from '../types.js';
import {
  GitHubAuthError,
  GitHubAPIError,
  GitHubConfigError,
  GitHubNotFoundError,
} from './errors.js';
import {
  GET_PROJECT,
  GET_PROJECT_FIELDS,
  CREATE_SINGLE_SELECT_FIELD,
  GET_PROJECT_ITEMS,
  UPDATE_PROJECT_ITEM_FIELD,
  CLOSE_ISSUE,
  REOPEN_ISSUE,
  ADD_COMMENT,
} from './graphql-queries.js';
import type {
  GetProjectResponse,
  GetProjectFieldsResponse,
  CreateSingleSelectFieldResponse,
  GetProjectItemsResponse,
  UpdateProjectItemFieldResponse,
  CloseIssueResponse,
  ReopenIssueResponse,
  AddCommentResponse,
  GitHubSingleSelectField,
  GitHubFieldOption,
  GitHubProjectItemNode,
} from './graphql-types.js';
import { isSingleSelectField, isSingleSelectValue, isIssueContent } from './graphql-types.js';
import { parseGitHubWebhook } from './webhook-parser.js';

export type GitHubProjectsConfig = Extract<IssueTracker, { provider: 'github_projects' }>;

// Callable signature shared between the real @octokit/graphql and test doubles.
export type GraphqlFn = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

// Minimal fetch signature for REST calls — injectable for tests.
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_TTL_MS = 5 * 60 * 1000;

// Zod schema for projects_v2_item.edited webhook payloads.
const ProjectsV2ItemEditedSchema = z.object({
  action: z.literal('edited'),
  changes: z.object({
    field_value: z.object({
      field_node_id: z.string(),
      field_type: z.string(),
      to: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
    }),
  }),
  projects_v2_item: z.object({
    content_node_id: z.string(),
    content_type: z.string(),
  }),
});

export class GitHubProjectsAdapter implements IssueTrackerAdapter {
  private readonly graphql: GraphqlFn;
  private readonly config: GitHubProjectsConfig;
  private readonly ttlMs: number;
  private readonly token: string;
  private readonly fetchFn: FetchFn;
  private readonly webhookSecret: string | undefined;

  // Stable metadata (fetched once, not TTL-evicted)
  private projectId: string | null = null;
  private fieldId: string | null = null;
  private readonly stageToOptionId = new Map<WorkflowStage, string>();
  private readonly optionIdToStage = new Map<string, WorkflowStage>();
  private mapsReady = false;
  private setupPromise: Promise<void> | null = null;

  // Internal maps for write ops and parseWebhook — rebuilt on each fetchAll
  private readonly externalIdToNodeIds = new Map<string, { itemId: string; issueId: string }>();
  private readonly issueNodeIdToExternalId = new Map<string, string>();

  // Item cache (TTL-evicted)
  private cache: { items: NormalizedItem[]; expiresAt: number } | null = null;
  private refreshPromise: Promise<void> | null = null;

  constructor(
    config: GitHubProjectsConfig,
    token: string,
    options?: { ttlMs?: number; _graphql?: GraphqlFn; _fetch?: FetchFn; webhookSecret?: string },
  ) {
    if (!token.trim()) {
      throw new GitHubAuthError(
        'token is blank — pass a non-empty GitHub PAT as the second constructor argument',
      );
    }
    this.config = config;
    this.token = token;
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.webhookSecret = options?.webhookSecret;
    this.graphql =
      options?._graphql ??
      (graphqlLib.defaults({
        headers: { authorization: `token ${token}` },
      }) as unknown as GraphqlFn);
    this.fetchFn =
      options?._fetch ??
      ((url, init) =>
        fetch(url, {
          ...init,
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            ...init?.headers,
          },
        }));
  }

  // ── IssueTrackerAdapter: ensureSubStages ────────────────────────────────────

  async ensureSubStages(config: IssueTracker): Promise<void> {
    if (config.provider !== 'github_projects') {
      throw new GitHubConfigError(
        `GitHubProjectsAdapter requires provider 'github_projects', got '${config.provider}'`,
      );
    }
    await this.ensureProjectId();
    const fields = await this.fetchFields();
    const existing = fields.find((f) => f.name === this.config.custom_field_name);
    if (existing) {
      this.populateMaps(existing);
    } else {
      const created = await this.createHelmStageField();
      this.populateMaps(created);
    }
    this.mapsReady = true;
    this.cache = null;
  }

  // ── IssueTrackerAdapter: reads ──────────────────────────────────────────────

  async getItem(externalId: string): Promise<NormalizedItem | null> {
    await this.ensureItemCache();
    const item = this.cache!.items.find((i) => i.externalId === externalId);
    return item ? { ...item } : null;
  }

  async listItems(filter?: ItemFilter): Promise<NormalizedItem[]> {
    await this.ensureItemCache();
    const all = this.cache!.items;
    const filtered = !filter
      ? all
      : all.filter((item) => {
          if (filter.status !== undefined && item.status !== filter.status) return false;
          if (filter.subStage !== undefined && item.subStage !== filter.subStage) return false;
          return true;
        });
    return filtered.map((item) => ({ ...item }));
  }

  // ── IssueTrackerAdapter: writes ─────────────────────────────────────────────

  async setSubStage(externalId: string, subStage: WorkflowStage): Promise<void> {
    await this.ensureItemCache();
    const nodeIds = this.externalIdToNodeIds.get(externalId);
    if (!nodeIds) throw new GitHubNotFoundError(`Item not found in project: ${externalId}`);

    await this.ensureSetup();
    const optionId = this.stageToOptionId.get(subStage);
    if (!optionId) {
      throw new GitHubNotFoundError(
        `Stage '${subStage}' has no option ID — call ensureSubStages first`,
      );
    }
    if (!this.fieldId) {
      throw new GitHubAPIError('Helm Stage field ID not set — call ensureSubStages first');
    }

    try {
      await this.graphql<UpdateProjectItemFieldResponse>(UPDATE_PROJECT_ITEM_FIELD, {
        projectId: this.projectId,
        itemId: nodeIds.itemId,
        fieldId: this.fieldId,
        value: { singleSelectOptionId: optionId },
      });
    } catch (err) {
      this.mapError(err);
    }
    // Intentional full-cache invalidation — per-item invalidation is v1.
    this.cache = null;
  }

  async setStatus(externalId: string, status: 'open' | 'closed'): Promise<void> {
    await this.ensureItemCache();
    const nodeIds = this.externalIdToNodeIds.get(externalId);
    if (!nodeIds) throw new GitHubNotFoundError(`Item not found in project: ${externalId}`);

    try {
      if (status === 'closed') {
        await this.graphql<CloseIssueResponse>(CLOSE_ISSUE, { issueId: nodeIds.issueId });
      } else {
        await this.graphql<ReopenIssueResponse>(REOPEN_ISSUE, { issueId: nodeIds.issueId });
      }
    } catch (err) {
      this.mapError(err);
    }
    this.cache = null;
  }

  async comment(externalId: string, body: string): Promise<void> {
    await this.ensureItemCache();
    const nodeIds = this.externalIdToNodeIds.get(externalId);
    if (!nodeIds) throw new GitHubNotFoundError(`Item not found in project: ${externalId}`);

    try {
      await this.graphql<AddCommentResponse>(ADD_COMMENT, {
        subjectId: nodeIds.issueId,
        body,
      });
    } catch (err) {
      this.mapError(err);
    }
    // Comments don't affect item state — no cache invalidation.
  }

  async registerWebhook(callbackUrl: string): Promise<void> {
    if (!this.webhookSecret) {
      throw new GitHubConfigError(
        'webhookSecret is required for registerWebhook — pass it in constructor options',
      );
    }
    const url = `https://api.github.com/orgs/${this.config.org}/hooks`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      body: JSON.stringify({
        name: 'web',
        active: true,
        events: ['projects_v2_item', 'issues', 'issue_comment'],
        config: {
          url: callbackUrl,
          content_type: 'json',
          secret: this.webhookSecret,
        },
      }),
    });
    if (!res.ok) {
      if (res.status === 401) {
        console.error('[GitHubProjectsAdapter] registerWebhook: authentication failed');
        throw new GitHubAuthError('GitHub API authentication failed during webhook registration');
      }
      console.error(`[GitHubProjectsAdapter] registerWebhook: HTTP ${res.status}`);
      throw new GitHubAPIError('GitHub webhook registration failed', res.status);
    }
  }

  // ── IssueTrackerAdapter: parseWebhook ───────────────────────────────────────

  // Never throws per IssueTrackerAdapter contract.
  parseWebhook(rawEvent: unknown): NormalizedEvent {
    try {
      // Route projects_v2_item events through the stateful handler that can
      // resolve content_node_id → externalId via the internal map.
      const ctx = this.extractContext(rawEvent);
      if (ctx?.eventType === 'projects_v2_item') {
        return this.parseProjectsV2ItemEvent(ctx.payload, rawEvent);
      }
      // Delegate issues.* and issue_comment.* to the pure parser.
      return parseGitHubWebhook(rawEvent);
    } catch {
      return { type: 'unknown', raw: rawEvent };
    }
  }

  // ── Private: parseWebhook helpers ──────────────────────────────────────────

  private extractContext(raw: unknown): { eventType: string; payload: unknown } | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.eventType !== 'string') return null;
    return { eventType: obj.eventType, payload: obj.payload };
  }

  private parseProjectsV2ItemEvent(payload: unknown, rawEvent: unknown): NormalizedEvent {
    const parsed = ProjectsV2ItemEditedSchema.safeParse(payload);
    if (!parsed.success) return { type: 'unknown', raw: rawEvent };

    const { changes, projects_v2_item: item } = parsed.data;
    const toOptionId = changes.field_value.to?.id;
    if (!toOptionId) return { type: 'unknown', raw: rawEvent };

    // Only emit if this optionId belongs to the Helm Stage field.
    const subStage = this.optionIdToStage.get(toOptionId);
    if (!subStage) return { type: 'unknown', raw: rawEvent };

    // Resolve externalId from the internal map (populated by fetchAll).
    // Returns unknown if the cache hasn't been seeded yet — known limitation, v1 TODO.
    const externalId = this.issueNodeIdToExternalId.get(item.content_node_id);
    if (!externalId) return { type: 'unknown', raw: rawEvent };

    return {
      type: 'item_updated',
      externalId,
      subStage,
      timestamp: new Date().toISOString(),
    };
  }

  // ── Private: lazy setup (projectId + field maps) ────────────────────────────

  private async ensureSetup(): Promise<void> {
    if (this.mapsReady) return;
    if (this.setupPromise) return this.setupPromise;
    this.setupPromise = this.setup().finally(() => {
      this.setupPromise = null;
    });
    return this.setupPromise;
  }

  private async setup(): Promise<void> {
    await this.ensureProjectId();
    const fields = await this.fetchFields();
    const helmField = fields.find((f) => f.name === this.config.custom_field_name);
    if (helmField) {
      this.populateMaps(helmField);
      this.fieldId = helmField.id;
    }
    this.mapsReady = true;
  }

  private async ensureProjectId(): Promise<void> {
    if (this.projectId !== null) return;
    try {
      const res = await this.graphql<GetProjectResponse>(GET_PROJECT, {
        login: this.config.org,
        number: this.config.project_number,
      });
      if (!res.organization?.projectV2) {
        throw new GitHubNotFoundError(
          `GitHub project #${this.config.project_number} not found in org '${this.config.org}'`,
        );
      }
      this.projectId = res.organization.projectV2.id;
    } catch (err) {
      if (err instanceof GitHubNotFoundError) throw err;
      this.mapError(err);
    }
  }

  private async fetchFields(): Promise<GitHubSingleSelectField[]> {
    try {
      const res = await this.graphql<GetProjectFieldsResponse>(GET_PROJECT_FIELDS, {
        projectId: this.projectId,
      });
      const nodes = res.node?.fields.nodes ?? [];
      return nodes.filter(isSingleSelectField);
    } catch (err) {
      this.mapError(err);
    }
  }

  private async createHelmStageField(): Promise<GitHubSingleSelectField> {
    const options = WORKFLOW_STAGES.map((s) => ({ name: s, color: 'BLUE', description: '' }));
    try {
      const res = await this.graphql<CreateSingleSelectFieldResponse>(CREATE_SINGLE_SELECT_FIELD, {
        projectId: this.projectId,
        name: this.config.custom_field_name,
        options,
      });
      const field = res.createProjectV2Field.projectV2Field;
      if (!isSingleSelectField(field)) {
        throw new GitHubAPIError('createProjectV2Field returned unexpected field type');
      }
      return field;
    } catch (err) {
      if (err instanceof GitHubAPIError) throw err;
      this.mapError(err);
    }
  }

  private populateMaps(field: GitHubSingleSelectField): void {
    this.stageToOptionId.clear();
    this.optionIdToStage.clear();
    this.fieldId = field.id;
    for (const opt of field.options) {
      const stage = WORKFLOW_STAGES.find((s) => s === opt.name);
      if (stage) {
        this.stageToOptionId.set(stage, opt.id);
        this.optionIdToStage.set(opt.id, stage);
      }
    }
  }

  // ── Private: item cache ─────────────────────────────────────────────────────

  private async ensureItemCache(): Promise<void> {
    if (this.cache && Date.now() < this.cache.expiresAt) return;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.fetchAll().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async fetchAll(): Promise<void> {
    await this.ensureSetup();
    const items: NormalizedItem[] = [];
    // Clear node maps before rebuild to evict removed items.
    this.externalIdToNodeIds.clear();
    this.issueNodeIdToExternalId.clear();
    let cursor: string | null = null;
    do {
      const page: GetProjectItemsResponse = await this.graphql<GetProjectItemsResponse>(
        GET_PROJECT_ITEMS,
        {
          projectId: this.projectId,
          first: 100,
          after: cursor,
        },
      );
      const nodes = page.node?.items.nodes ?? [];
      for (const node of nodes) {
        const item = this.normalizeItem(node);
        if (item) items.push(item);
      }
      cursor =
        page.node?.items.pageInfo.hasNextPage === true
          ? (page.node.items.pageInfo.endCursor ?? null)
          : null;
    } while (cursor !== null);
    this.cache = { items, expiresAt: Date.now() + this.ttlMs };
  }

  private normalizeItem(node: GitHubProjectItemNode): NormalizedItem | null {
    if (!isIssueContent(node.content)) return null;
    const issue = node.content;
    const externalId = `issue_${issue.number}`;

    // Populate write-op and parseWebhook lookup maps.
    this.externalIdToNodeIds.set(externalId, { itemId: node.id, issueId: issue.id });
    this.issueNodeIdToExternalId.set(issue.id, externalId);

    let subStage: WorkflowStage | null = null;
    for (const fv of node.fieldValues.nodes) {
      if (isSingleSelectValue(fv) && this.optionIdToStage.has(fv.optionId)) {
        subStage = this.optionIdToStage.get(fv.optionId) ?? null;
        break;
      }
    }
    return {
      externalId,
      title: issue.title,
      subStage,
      status: issue.state === 'OPEN' ? 'open' : 'closed',
      url: issue.url,
    };
  }

  // ── Private: error mapping ──────────────────────────────────────────────────

  private mapError(err: unknown): never {
    if (err !== null && typeof err === 'object' && 'response' in err) {
      const status = (err as { response: { status: number } }).response.status;
      if (status === 401) {
        console.error('[GitHubProjectsAdapter] Authentication error:', err);
        throw new GitHubAuthError('GitHub API authentication failed — verify the token is valid');
      }
      if (status === 404) {
        console.error('[GitHubProjectsAdapter] Resource not found:', err);
        throw new GitHubNotFoundError('GitHub resource not found');
      }
      console.error(`[GitHubProjectsAdapter] API error (${status}):`, err);
      throw new GitHubAPIError(`GitHub API error`, status);
    }
    console.error('[GitHubProjectsAdapter] Unexpected error:', err);
    throw new GitHubAPIError('GitHub API request failed');
  }

  getOptionId(stage: WorkflowStage): string | undefined {
    return this.stageToOptionId.get(stage);
  }

  getFieldId(): string | null {
    return this.fieldId;
  }
}

export type { GitHubFieldOption };
