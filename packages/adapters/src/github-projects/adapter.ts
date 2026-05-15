import { graphql as graphqlLib } from '@octokit/graphql';
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
} from './graphql-queries.js';
import type {
  GetProjectResponse,
  GetProjectFieldsResponse,
  CreateSingleSelectFieldResponse,
  GetProjectItemsResponse,
  GitHubSingleSelectField,
  GitHubFieldOption,
  GitHubProjectItemNode,
} from './graphql-types.js';
import { isSingleSelectField, isSingleSelectValue, isIssueContent } from './graphql-types.js';

export type GitHubProjectsConfig = Extract<IssueTracker, { provider: 'github_projects' }>;

// Callable signature shared between the real @octokit/graphql and test doubles.
export type GraphqlFn = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class GitHubProjectsAdapter implements IssueTrackerAdapter {
  private readonly graphql: GraphqlFn;
  private readonly config: GitHubProjectsConfig;
  private readonly ttlMs: number;

  // Stable metadata (fetched once, not TTL-evicted)
  private projectId: string | null = null;
  private fieldId: string | null = null;
  private readonly stageToOptionId = new Map<WorkflowStage, string>();
  private readonly optionIdToStage = new Map<string, WorkflowStage>();
  private mapsReady = false;
  private setupPromise: Promise<void> | null = null;

  // Item cache (TTL-evicted)
  private cache: { items: NormalizedItem[]; expiresAt: number } | null = null;
  private refreshPromise: Promise<void> | null = null;

  constructor(
    config: GitHubProjectsConfig,
    token: string,
    options?: { ttlMs?: number; _graphql?: GraphqlFn },
  ) {
    if (!token.trim()) {
      throw new GitHubAuthError(
        'token is blank — pass a non-empty GitHub PAT as the second constructor argument',
      );
    }
    this.config = config;
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.graphql =
      options?._graphql ??
      (graphqlLib.defaults({
        headers: { authorization: `token ${token}` },
      }) as unknown as GraphqlFn);
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
    // Invalidate item cache — field options may have changed
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

  // ── IssueTrackerAdapter: Block 3 stubs ─────────────────────────────────────

  async setSubStage(): Promise<void> {
    throw new Error('Not implemented yet — Block 3');
  }

  async setStatus(): Promise<void> {
    throw new Error('Not implemented yet — Block 3');
  }

  async comment(): Promise<void> {
    throw new Error('Not implemented yet — Block 3');
  }

  // NOTE: parseWebhook must never throw per the IssueTrackerAdapter contract.
  // Block 3 will implement full webhook parsing with Zod validation.
  parseWebhook(rawEvent: unknown): NormalizedEvent {
    return { type: 'unknown', raw: rawEvent };
  }

  async registerWebhook(): Promise<void> {
    throw new Error('Not implemented yet — Block 3');
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
    let subStage: WorkflowStage | null = null;
    for (const fv of node.fieldValues.nodes) {
      if (isSingleSelectValue(fv) && this.optionIdToStage.has(fv.optionId)) {
        subStage = this.optionIdToStage.get(fv.optionId) ?? null;
        break;
      }
    }
    return {
      externalId: `issue_${issue.number}`,
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

  // Expose option lookup for Block 3 (write operations)
  getOptionId(stage: WorkflowStage): string | undefined {
    return this.stageToOptionId.get(stage);
  }

  getFieldId(): string | null {
    return this.fieldId;
  }
}

// Re-export field option type for callers that need it
export type { GitHubFieldOption };
