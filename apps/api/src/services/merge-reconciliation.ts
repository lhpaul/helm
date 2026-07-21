import { WorkflowTransitionError, type WorkflowStage } from '@helm/workflow';
import { parseArtifactBranch, type ArtifactBranchKind, type Product } from '@helm/shared';
import { getItemStore, getProductConfig } from './index.js';
import { ItemNotFoundError, StageMismatchError } from './errors.js';
import { parseGitHubRepoUrl } from './github-pr.js';
import { transitionItemIfCurrentStageResult } from './item-service.js';
import type {
  CurrentPullRequestState,
  GitHubPullRequestRepository,
} from './github-pull-requests.js';
import type { ItemState } from './types.js';

type ArtifactTransition = {
  fromStage: WorkflowStage;
  toStage: WorkflowStage;
  triggeredBy: string;
};

const ARTIFACT_TRANSITIONS: Record<ArtifactBranchKind, ArtifactTransition> = {
  spec: {
    fromStage: 'spec-draft',
    toStage: 'spec-ready',
    triggeredBy: 'webhook:knowledge-repo',
  },
  plan: {
    fromStage: 'plan-draft',
    toStage: 'plan-ready',
    triggeredBy: 'webhook:knowledge-repo',
  },
  impl: {
    fromStage: 'code-review',
    toStage: 'merged',
    triggeredBy: 'webhook:code-repo',
  },
};

export type MergeReconciliationInput = {
  repository: GitHubPullRequestRepository | null;
  pullRequestId: number | null;
  pullRequestNumber: number | null;
  headRef: string;
  merged: boolean;
  expectedExternalId?: string;
  source: 'webhook' | 'operator';
};

export type MergeReconciliationResult =
  | {
      status: 'advanced';
      externalId: string;
      artifactKind: ArtifactBranchKind;
      fromStage: WorkflowStage;
      toStage: WorkflowStage;
      item: ItemState;
      idempotencyKey: string;
    }
  | {
      status: 'already-reconciled';
      externalId: string;
      artifactKind: ArtifactBranchKind;
      fromStage: WorkflowStage;
      toStage: WorkflowStage;
      item: ItemState;
      idempotencyKey: string;
    }
  | {
      status: 'ignored';
      reason:
        | 'not-merged'
        | 'unsupported-artifact-branch'
        | 'external-id-mismatch'
        | 'repository-not-allowed'
        | 'unstable-pr-identity'
        | 'item-not-found'
        | 'wrong-product'
        | 'invalid-predecessor-stage';
      externalId?: string;
      currentStage?: WorkflowStage;
    };

export function mergeReconciliationKey(input: {
  repository: GitHubPullRequestRepository;
  pullRequestId: number;
  expectedStage: WorkflowStage;
}): string {
  const repo = `${input.repository.owner}/${input.repository.repo}`;
  return `merge-reconciliation:${repo}#id:${input.pullRequestId}:${input.expectedStage}`;
}

export function reconciliationInputFromCurrentPullRequestState(
  pr: CurrentPullRequestState,
  expectedExternalId?: string,
): MergeReconciliationInput {
  return {
    repository: pr.repository,
    pullRequestId: pr.pullRequestId,
    pullRequestNumber: pr.pullRequestNumber,
    headRef: pr.headRef,
    merged: pr.merged,
    expectedExternalId,
    source: 'operator',
  };
}

export async function reconcileMergedArtifactPullRequest(
  input: MergeReconciliationInput,
): Promise<MergeReconciliationResult> {
  if (!input.merged) {
    return { status: 'ignored', reason: 'not-merged' };
  }

  const parsed = parseArtifactBranch(input.headRef);
  if (!parsed) {
    return { status: 'ignored', reason: 'unsupported-artifact-branch' };
  }

  if (input.expectedExternalId && input.expectedExternalId !== parsed.externalId) {
    return {
      status: 'ignored',
      reason: 'external-id-mismatch',
      externalId: parsed.externalId,
    };
  }

  const transition = ARTIFACT_TRANSITIONS[parsed.kind];
  const config = await getProductConfig();
  const repository = input.repository;
  if (!repository || !isRepositoryAllowedForArtifact(config, parsed.kind, repository)) {
    return {
      status: 'ignored',
      reason: 'repository-not-allowed',
      externalId: parsed.externalId,
    };
  }
  if (input.pullRequestId === null) {
    return {
      status: 'ignored',
      reason: 'unstable-pr-identity',
      externalId: parsed.externalId,
    };
  }

  const idempotencyKey = mergeReconciliationKey({
    repository,
    pullRequestId: input.pullRequestId,
    expectedStage: transition.toStage,
  });
  const note = `${idempotencyKey}; source:${input.source}; branch:${input.headRef}`;

  const store = await getItemStore();
  const existing = await store.get(parsed.externalId);
  if (!existing) {
    return { status: 'ignored', reason: 'item-not-found', externalId: parsed.externalId };
  }
  if (existing.productSlug !== config.product.slug) {
    return { status: 'ignored', reason: 'wrong-product', externalId: parsed.externalId };
  }

  // Stage / idempotency checks run inside transitionItemIfCurrentStageResult
  // (per-item lock). Avoid redundant unlocked pre-checks that race with overlap.
  try {
    const { item: updated, applied } = await transitionItemIfCurrentStageResult({
      externalId: parsed.externalId,
      fromStage: transition.fromStage,
      toStage: transition.toStage,
      triggeredBy: transition.triggeredBy,
      note,
      idempotencyKey,
    });

    if (!applied || updated.currentStage !== transition.toStage) {
      return alreadyReconciled(parsed.kind, parsed.externalId, transition, updated, idempotencyKey);
    }

    return {
      status: 'advanced',
      externalId: parsed.externalId,
      artifactKind: parsed.kind,
      fromStage: transition.fromStage,
      toStage: transition.toStage,
      item: updated,
      idempotencyKey,
    };
  } catch (err) {
    if (err instanceof StageMismatchError || err instanceof WorkflowTransitionError) {
      const current = await store.get(parsed.externalId);
      if (current?.currentStage === transition.toStage) {
        return alreadyReconciled(
          parsed.kind,
          parsed.externalId,
          transition,
          current,
          idempotencyKey,
        );
      }
      return {
        status: 'ignored',
        reason: 'invalid-predecessor-stage',
        externalId: parsed.externalId,
        currentStage: current?.currentStage,
      };
    }
    if (err instanceof ItemNotFoundError) {
      return { status: 'ignored', reason: 'item-not-found', externalId: parsed.externalId };
    }
    throw err;
  }
}

/**
 * True when `repository` is the product knowledge repo or any configured code
 * repo. Used by the operator recovery endpoint to block GitHub lookups against
 * arbitrary owner/repo pairs before the shared token is used.
 */
export function isRepositoryConfiguredForProduct(
  product: Product,
  repository: GitHubPullRequestRepository,
): boolean {
  const urls = [product.knowledge_repo.url, ...product.code_repos.map((repo) => repo.url)];
  return urls.some((url) => repositoryMatchesUrl(repository, url));
}

function isRepositoryAllowedForArtifact(
  product: Product,
  artifactKind: ArtifactBranchKind,
  repository: GitHubPullRequestRepository | null,
): boolean {
  if (!repository) return false;

  const allowedRepos =
    artifactKind === 'impl'
      ? product.code_repos.map((repo) => repo.url)
      : [product.knowledge_repo.url];

  return allowedRepos.some((url) => repositoryMatchesUrl(repository, url));
}

function repositoryMatchesUrl(repository: GitHubPullRequestRepository, url: string): boolean {
  try {
    const allowed = parseGitHubRepoUrl(url);
    return (
      allowed.owner.toLowerCase() === repository.owner.toLowerCase() &&
      allowed.repo.toLowerCase() === repository.repo.toLowerCase()
    );
  } catch {
    return false;
  }
}

function alreadyReconciled(
  artifactKind: ArtifactBranchKind,
  externalId: string,
  transition: ArtifactTransition,
  item: ItemState,
  idempotencyKey: string,
): MergeReconciliationResult {
  return {
    status: 'already-reconciled',
    externalId,
    artifactKind,
    fromStage: transition.fromStage,
    toStage: transition.toStage,
    item: { ...item, history: [...item.history] },
    idempotencyKey,
  };
}
