/**
 * helm usage — prints the usage aggregate (#151) as a table, for operators
 * without curl. Calls the same service function as the API (no network).
 *
 * Usage:
 *   pnpm --filter @helm/api usage -- <productSlug> [externalId]
 *     [--from <iso>] [--to <iso>] [--group-by item|stage|month]
 *
 * Optional env vars:
 *   HELM_DATA_DIR — defaults to ./data relative to CWD
 */
import { getJobStore } from '../services/index.js';
import { GROUP_BY_VALUES, buildUsageReport, formatUsageTable } from '../services/usage.js';
import type { UsageGroupBy } from '../services/usage.js';
import { parseUsageDate } from '../routes/usage.js';
import { EXTERNAL_ID_REGEX } from '../services/types.js';

const USAGE = `Usage: pnpm --filter @helm/api usage -- <productSlug> [externalId] [--from <iso>] [--to <iso>] [--group-by ${GROUP_BY_VALUES.join('|')}]`;

function fail(message: string): never {
  console.error(`Error: ${message}\n${USAGE}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const positional: string[] = [];
  let from: Date | undefined;
  let to: Date | undefined;
  let groupBy: UsageGroupBy | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--from' || arg === '--to' || arg === '--group-by') {
      const value = args[++i];
      if (value === undefined) fail(`${arg} requires a value`);
      if (arg === '--group-by') {
        if (!(GROUP_BY_VALUES as readonly string[]).includes(value)) fail(`invalid ${arg}`);
        groupBy = value as UsageGroupBy;
      } else {
        const d = parseUsageDate(value);
        if (!d) fail(`invalid ${arg}: expected an ISO date or date-time`);
        if (arg === '--from') from = d;
        else to = d;
      }
    } else if (arg.startsWith('--')) {
      fail(`unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const [slug, externalId, ...rest] = positional;
  if (!slug || rest.length > 0) fail('expected <productSlug> [externalId]');
  if (!/^[a-z0-9-]+$/.test(slug)) fail('invalid productSlug');
  if (externalId !== undefined) {
    if (!EXTERNAL_ID_REGEX.test(externalId) || externalId === '.' || externalId === '..') {
      fail('invalid externalId');
    }
  }
  if (from && to && from.getTime() >= to.getTime()) fail('--from must be before --to');

  const store = await getJobStore();
  const jobs = externalId
    ? await store.listJobsForItem(slug, externalId)
    : await store.listJobsForProduct(slug);
  console.log(
    formatUsageTable(buildUsageReport(jobs, { productSlug: slug, externalId, from, to, groupBy })),
  );
}

main().catch((err) => {
  console.error('usage failed:', err instanceof Error ? err.name : 'unknown error');
  process.exit(1);
});
