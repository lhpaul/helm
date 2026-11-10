import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../../scripts/ensure-review-labels.sh');

describe('ensure-review-labels.sh', () => {
  let dir: string;
  let log: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'helm-labels-'));
    log = join(dir, 'calls.log');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(existing: string, args: string[] = [], failCreate = false) {
    const gh = join(dir, 'gh');
    writeFileSync(
      gh,
      `#!/usr/bin/env bash
echo "$@" >> "${log}"
if [[ "$2" == "list" ]]; then printf '%s' "${existing}"; exit 0; fi
if [[ "$2" == "create" && "${failCreate ? 1 : 0}" == 1 ]]; then exit 1; fi
exit 0
`,
    );
    chmodSync(gh, 0o755);
    const result = spawnSync('bash', [SCRIPT, ...args], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    let calls = '';
    try {
      calls = readFileSync(log, 'utf8');
    } catch {
      /* no calls */
    }
    return { ...result, calls };
  }

  it('creates the gate label when missing', () => {
    const r = run('bug\n');
    expect(r.status).toBe(0);
    expect(r.calls).toContain('label create ready-for-human-review --repo lhpaul/helm');
  });

  it('is a no-op when the label already exists', () => {
    const r = run('bug\nready-for-human-review\n');
    expect(r.status).toBe(0);
    expect(r.calls).not.toContain('label create');
    expect(r.stdout).toContain('ok: ready-for-human-review exists');
  });

  it('does not create in --dry-run', () => {
    const r = run('', ['--dry-run']);
    expect(r.status).toBe(0);
    expect(r.calls).not.toContain('label create');
    expect(r.stdout).toContain('would create: ready-for-human-review');
  });

  it('honors --repo', () => {
    const r = run('', ['--repo', 'o/r']);
    expect(r.calls).toContain('--repo o/r');
  });

  it('fails when gh create fails', () => {
    const r = run('', [], true);
    expect(r.status).not.toBe(0);
  });
});
