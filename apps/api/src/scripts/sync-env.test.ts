import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../scripts/sync-env-from-1password.sh');

const VALID_INPUT = [
  'HELM_KNOWLEDGE_REPO_PATH=/tmp/knowledge',
  'HELM_DATA_DIR=/tmp/data',
  'GITHUB_TOKEN=op://vault/item/field',
  '',
].join('\n');

// The script writes <its dir>/../.env. Running a copy inside a temp tree keeps
// the real apps/api/.env untouched, and a stub `op` replaces the real CLI.
describe('sync-env-from-1password.sh', () => {
  let dir: string;
  let apiDir: string;
  let log: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'helm-sync-env-'));
    apiDir = join(dir, 'api');
    mkdirSync(join(apiDir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'bin'));
    copyFileSync(SCRIPT, join(apiDir, 'scripts', 'sync-env.sh'));
    log = join(dir, 'op-calls.log');
    const op = join(dir, 'bin', 'op');
    writeFileSync(
      op,
      `#!/usr/bin/env bash
echo "$@" >> "${log}"
if [[ "$1" == "account" ]]; then exit 0; fi
if [[ "$1" == "inject" ]]; then
  sed -E 's#op://[^[:space:]]+#resolved-secret#' "$3" > "$5"
  exit 0
fi
exit 1
`,
    );
    chmodSync(op, 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(args: string[]) {
    const result = spawnSync('bash', [join(apiDir, 'scripts', 'sync-env.sh'), ...args], {
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
    return { ...result, calls };
  }

  it.each(['helm', 'acme-platform', 'a', '0product', 'x'.repeat(64)])(
    'accepts slug %s and writes .env from .env.<slug>',
    (slug) => {
      writeFileSync(join(apiDir, `.env.${slug}`), VALID_INPUT);
      const r = run(['--', slug]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`Product: ${slug}`);
      const out = readFileSync(join(apiDir, '.env'), 'utf8');
      expect(out).toContain('GITHUB_TOKEN=resolved-secret');
      expect(out).not.toContain('op://');
    },
  );

  it('accepts the slug without the leading "--"', () => {
    writeFileSync(join(apiDir, '.env.helm'), VALID_INPUT);
    expect(run(['helm']).status).toBe(0);
  });

  it.each([
    'Helm',
    'ACME',
    '-helm',
    'helm_dev',
    'helm.dev',
    '../helm',
    'a/b',
    'helm ',
    ' helm',
    'helm\nx',
    'prodúct',
    'x'.repeat(65),
  ])('rejects invalid slug %j before calling op', (slug) => {
    const r = run(['--', slug]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('invalid product slug');
    expect(r.calls).toBe('');
    expect(existsSync(join(apiDir, '.env'))).toBe(false);
  });

  it('rejects the reserved "example" slug before calling op', () => {
    const r = run(['--', 'example']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("'example' is reserved");
    expect(r.calls).toBe('');
  });

  it('prints usage when no slug is given', () => {
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Usage: pnpm sync-env -- <product>');
    expect(r.calls).toBe('');
  });

  it('fails clearly when the input file is missing', () => {
    const r = run(['--', 'acme-platform']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('.env.acme-platform');
    expect(r.calls).not.toContain('inject');
    expect(existsSync(join(apiDir, '.env'))).toBe(false);
  });
});
