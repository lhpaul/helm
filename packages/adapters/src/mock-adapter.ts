import type { WorkflowStage } from '@helm/workflow';
import type { IssueTrackerAdapter } from './interface.js';
import type { ItemFilter, NormalizedEvent, NormalizedItem } from './types.js';

export class MockAdapter implements IssueTrackerAdapter {
  private items = new Map<string, NormalizedItem>();
  private comments = new Map<string, string[]>();

  seed(item: NormalizedItem): void {
    this.items.set(item.externalId, { ...item });
    if (!this.comments.has(item.externalId)) {
      this.comments.set(item.externalId, []);
    }
  }

  getComments(externalId: string): string[] {
    return [...(this.comments.get(externalId) ?? [])];
  }

  async ensureSubStages(): Promise<void> {}

  async getItem(externalId: string): Promise<NormalizedItem | null> {
    return this.items.get(externalId) ?? null;
  }

  async listItems(filter?: ItemFilter): Promise<NormalizedItem[]> {
    const all = Array.from(this.items.values());
    if (!filter) return all;
    return all.filter((item) => {
      if (filter.status !== undefined && item.status !== filter.status) return false;
      if (filter.subStage !== undefined && item.subStage !== filter.subStage) return false;
      return true;
    });
  }

  async setSubStage(externalId: string, subStage: WorkflowStage): Promise<void> {
    const item = this.items.get(externalId);
    if (!item) throw new Error(`Item not found: ${externalId}`);
    this.items.set(externalId, { ...item, subStage });
  }

  async setStatus(externalId: string, status: 'open' | 'closed'): Promise<void> {
    const item = this.items.get(externalId);
    if (!item) throw new Error(`Item not found: ${externalId}`);
    this.items.set(externalId, { ...item, status });
  }

  async comment(externalId: string, body: string): Promise<void> {
    const item = this.items.get(externalId);
    if (!item) throw new Error(`Item not found: ${externalId}`);
    const list = this.comments.get(externalId) ?? [];
    list.push(body);
    this.comments.set(externalId, list);
  }

  // NOTE: This mock implementation trusts the rawEvent shape. Real adapters
  // (e.g., GitHubProjectsAdapter in Block 2) MUST validate rawEvent with Zod
  // before returning a NormalizedEvent — webhook payloads come from external
  // sources and must not be trusted.
  parseWebhook(rawEvent: unknown): NormalizedEvent {
    if (
      rawEvent !== null &&
      typeof rawEvent === 'object' &&
      'type' in rawEvent &&
      (rawEvent as { type: unknown }).type !== 'unknown'
    ) {
      return rawEvent as NormalizedEvent;
    }
    return { type: 'unknown', raw: rawEvent };
  }

  async registerWebhook(): Promise<void> {}
}
