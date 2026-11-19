import { Hono } from 'hono';
import { z } from 'zod';
import { getJobStore } from '../services/index.js';
import { GROUP_BY_VALUES, buildUsageReport } from '../services/usage.js';
import { validateExternalId } from '../lib/http-errors.js';

export const usageRouter = new Hono();

const SlugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9-]+$/);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses an ISO date (`2026-11-01`) or ISO date-time with offset
 * (`2026-11-01T10:00:00Z`). Date-only values are UTC midnight. Returns null for
 * anything else, including impossible dates such as `2026-02-31`.
 */
export function parseUsageDate(value: string): Date | null {
  if (DATE_ONLY.test(value)) {
    const d = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value) ? d : null;
  }
  if (!z.string().datetime({ offset: true }).safeParse(value).success) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parsePeriod(
  query: Record<string, string>,
  allowed: readonly string[],
): Parsed<{ from?: Date; to?: Date; groupBy?: (typeof GROUP_BY_VALUES)[number] }> {
  const unknown = Object.keys(query).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) return { ok: false, error: 'Unknown query parameter' };

  const out: { from?: Date; to?: Date; groupBy?: (typeof GROUP_BY_VALUES)[number] } = {};
  for (const key of ['from', 'to'] as const) {
    const raw = query[key];
    if (raw === undefined) continue;
    const d = raw.trim() === '' ? null : parseUsageDate(raw.trim());
    if (!d) return { ok: false, error: `Invalid "${key}": expected an ISO date or date-time` };
    out[key] = d;
  }
  if (out.from && out.to && out.from.getTime() >= out.to.getTime()) {
    return { ok: false, error: '"from" must be before "to"' };
  }
  if (query['groupBy'] !== undefined) {
    const parsed = z.enum(GROUP_BY_VALUES).safeParse(query['groupBy']);
    if (!parsed.success) {
      return {
        ok: false,
        error: `Invalid "groupBy": expected one of ${GROUP_BY_VALUES.join(', ')}`,
      };
    }
    out.groupBy = parsed.data;
  }
  return { ok: true, value: out };
}

/**
 * GET /api/products/:slug/items/:externalId/usage
 * Aggregate usage for one item, with a per-stage breakdown. Read-only; behind
 * the operator token (ADR-045) like every /api/* route.
 */
usageRouter.get('/products/:slug/items/:externalId/usage', async (c) => {
  const slug = c.req.param('slug');
  if (!SlugSchema.safeParse(slug).success) {
    return c.json({ error: 'Invalid product slug' }, 400);
  }
  const idResult = validateExternalId(c.req.param('externalId'));
  if (!idResult.ok) {
    return c.json(idResult.response.body, idResult.response.status);
  }
  const period = parsePeriod(c.req.query(), []);
  if (!period.ok) return c.json({ error: period.error }, 400);

  try {
    const jobs = await (await getJobStore()).listJobsForItem(slug, idResult.value);
    return c.json(buildUsageReport(jobs, { productSlug: slug, externalId: idResult.value }), 200);
  } catch (err) {
    console.error('[usage] Failed to build item usage:', err);
    return c.json({ error: 'Failed to read usage' }, 500);
  }
});

/**
 * GET /api/products/:slug/usage?from=&to=&groupBy=item|stage|month
 * Aggregate usage for a product over a period (`from` inclusive, `to`
 * exclusive; default all time).
 */
usageRouter.get('/products/:slug/usage', async (c) => {
  const slug = c.req.param('slug');
  if (!SlugSchema.safeParse(slug).success) {
    return c.json({ error: 'Invalid product slug' }, 400);
  }
  const period = parsePeriod(c.req.query(), ['from', 'to', 'groupBy']);
  if (!period.ok) return c.json({ error: period.error }, 400);

  try {
    const jobs = await (await getJobStore()).listJobsForProduct(slug);
    return c.json(buildUsageReport(jobs, { productSlug: slug, ...period.value }), 200);
  } catch (err) {
    console.error('[usage] Failed to build product usage:', err);
    return c.json({ error: 'Failed to read usage' }, 500);
  }
});
