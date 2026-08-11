import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Product } from '@helm/shared';
import type { AgentResult, AgentSession, IAgentRuntime, SpawnParams } from '../runtime.js';
import type { RunGh, RunGit } from '../specialists/git-helpers.js';
import { artifactFileFor } from '../specialists/code-workspace.js';
import { runEarlyArtifactReviewLoop } from './code-review-loop.js';

const PR_URL = 'https://github.com/test-org/test-knowledge/pull/71';

function makeProduct(): Product {
  return {
    helm_version: '0',
    product: { slug: 'test-product', name: 'Test Product' },
    issue_tracker: {
      provider: 'github_projects',
      org: 'test-org',
      project_number: 1,
      custom_field_name: 'Helm Stage',
    },
    code_repos: [
      {
        url: 'https://github.com/test-org/test-repo',
        default_branch: 'main',
        role: 'app',
      },
    ],
    knowledge_repo: {
      url: 'https://github.com/test-org/test-knowledge',
      default_branch: 'main',
    },
    review: {
      early_loop: { enabled: true },
    },
    workflow: {
      stages_enabled: [
        'spec-draft',
        'plan-draft',
        'plan-ready',
        'in-development',
        'code-review',
        'released',
      ],
      designer_gate: 'skip',
      qa_gate: 'skip',
      readiness_gate: 'skip',
      final_stage: 'released',
    },
    specialists: {
      'spec-writer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
      'plan-writer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
      implementer: { runtime: 'claude_code', model: 'claude-opus-4-7' },
      'code-reviewer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
      'security-reviewer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
      'test-reviewer': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
      'spec-remediator': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
      'plan-remediator': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
      'code-remediator': { runtime: 'claude_code', model: 'claude-sonnet-4-6' },
    },
  };
}

function makeRuntime(expectedBranch: string): IAgentRuntime {
  return {
    spawn: vi.fn().mockImplementation(async (params: SpawnParams): Promise<AgentSession> => {
      await expect(readFile(`${params.workdir}/artifact-branch.txt`, 'utf-8')).resolves.toBe(
        `${expectedBranch}\n`,
      );
      const file = artifactFileFor(params.workdir, params.specialistId);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(
        file,
        [`# ${params.specialistId}: issue_71`, '', '## Findings', '', '## Status', 'APPROVED'].join(
          '\n',
        ),
      );

      const result: AgentResult = {
        status: 'done',
        finalOutput: 'Review complete.',
        totalCostUsd: 0.01,
        durationMs: 100,
      };

      return {
        id: `mock-${params.specialistId}`,
        status: 'done',
        onMessage: vi.fn(),
        send: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(result),
      };
    }),
  };
}

describe('runEarlyArtifactReviewLoop provisioning', () => {
  it.each([
    { kind: 'spec' as const, expectedBranch: 'helm/spec/issue_71' },
    { kind: 'plan' as const, expectedBranch: 'helm/plan/issue_71' },
  ])(
    'clones the $kind draft artifact branch through provisionReviewerWorkspace',
    async ({ kind, expectedBranch }) => {
      const cloneCalls: string[][] = [];
      const runGit: RunGit = vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'clone') {
          cloneCalls.push([...args]);
          const dest = args[args.length - 1]!;
          const branch = args[args.indexOf('--branch') + 1]!;
          await mkdir(`${dest}/.git`, { recursive: true });
          await writeFile(`${dest}/artifact-branch.txt`, `${branch}\n`);
        }
        return { stdout: '' };
      });
      const runGh: RunGh = vi.fn().mockResolvedValue({ stdout: '' });
      const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 404 })) as typeof fetch;

      const result = await runEarlyArtifactReviewLoop({
        kind,
        externalId: 'issue_71',
        product: makeProduct(),
        prUrl: PR_URL,
        githubToken: 'test-token',
        runtime: makeRuntime(expectedBranch),
        transition: vi.fn(),
        runGit,
        runGh,
        fetchFn,
      });

      expect(result.status).toBe('done');
      expect(result.newStage).toBeUndefined();
      expect(cloneCalls.length).toBeGreaterThan(0);
      for (const cloneArgs of cloneCalls) {
        expect(cloneArgs).toContain('--branch');
        expect(cloneArgs).toContain(expectedBranch);
        expect(cloneArgs.join(' ')).toContain('github.com/test-org/test-knowledge');
      }
    },
  );
});
