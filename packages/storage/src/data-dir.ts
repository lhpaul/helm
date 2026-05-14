import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Absolute paths to the well-known subdirectories under data/.
 * Populated by ensureDataDir — all paths are guaranteed to exist.
 */
export type DataPaths = {
  /** data/ root */
  root: string;
  /** data/agent-runs/ — one subdir per run-id */
  agentRuns: string;
  /** data/worktrees/code/ — worktrees for code repos */
  worktreesCode: string;
  /** data/worktrees/knowledge/ — worktrees for knowledge repos */
  worktreesKnowledge: string;
  /** data/linear-cache/ — root for Linear cache; items live in items/ subdir */
  linearCache: string;
  /** data/reviewers/ — fan-out tracker files per PR */
  reviewers: string;
  /** data/items/ — one JSON file per tracked item (workflow state + history) */
  items: string;
};

/**
 * Creates the data/ directory structure if it does not exist.
 * Idempotent — safe to call on every server start.
 * Also pre-creates linear-cache/items/ since it is the only known subdir.
 */
export async function ensureDataDir(rootPath: string): Promise<DataPaths> {
  const paths: DataPaths = {
    root: rootPath,
    agentRuns: join(rootPath, 'agent-runs'),
    worktreesCode: join(rootPath, 'worktrees', 'code'),
    worktreesKnowledge: join(rootPath, 'worktrees', 'knowledge'),
    linearCache: join(rootPath, 'linear-cache'),
    reviewers: join(rootPath, 'reviewers'),
    items: join(rootPath, 'items'),
  };

  await Promise.all([
    mkdir(paths.agentRuns, { recursive: true }),
    mkdir(paths.worktreesCode, { recursive: true }),
    mkdir(paths.worktreesKnowledge, { recursive: true }),
    mkdir(join(rootPath, 'linear-cache', 'items'), { recursive: true }),
    mkdir(paths.reviewers, { recursive: true }),
    mkdir(paths.items, { recursive: true }),
  ]);

  return paths;
}

// ── Agent Run path helpers ────────────────────────────────────────────────────
// These are pure functions — they compute paths but do NOT create directories.

/** Returns the directory path for a specific agent run. */
export function getAgentRunDir(rootPath: string, runId: string): string {
  return join(rootPath, 'agent-runs', runId);
}

/** {runDir}/meta.json — specialist, model, status, timestamps, worktree_path */
export function getMetaPath(runDir: string): string {
  return join(runDir, 'meta.json');
}

/** {runDir}/log.txt — stdout/stderr of the agent process (append-only) */
export function getLogPath(runDir: string): string {
  return join(runDir, 'log.txt');
}

/** {runDir}/costs.jsonl — one line per PostToolUse hook event */
export function getCostsPath(runDir: string): string {
  return join(runDir, 'costs.jsonl');
}

/** {runDir}/instructions.txt — mid-flight instruction channel (server writes, agent reads) */
export function getInstructionsPath(runDir: string): string {
  return join(runDir, 'instructions.txt');
}

// ── Linear Cache path helpers ─────────────────────────────────────────────────

/**
 * Returns the cache file path for a specific Linear item.
 * Pattern: {root}/linear-cache/items/{linearId}.json
 */
export function getLinearItemCachePath(rootPath: string, linearId: string): string {
  return join(rootPath, 'linear-cache', 'items', `${linearId}.json`);
}
