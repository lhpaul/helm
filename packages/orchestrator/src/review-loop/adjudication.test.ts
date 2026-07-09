import { describe, expect, it } from 'vitest';

import { parseAdjudicationBody } from './adjudication.js';

describe('parseAdjudicationBody', () => {
  it('parses AUTO_REMEDIATE with unified plan', () => {
    const body = `# Review Adjudication: LEA-192

## Summary
Aligned on CSRF fix.

## Unified remediation plan
- **AUTO** · Add trusted origin guard on POST /api/sync

## Status
AUTO_REMEDIATE`;

    expect(parseAdjudicationBody(body)).toMatchObject({
      status: 'AUTO_REMEDIATE',
      unifiedPlan: '- **AUTO** · Add trusted origin guard on POST /api/sync',
    });
  });

  it('forces HUMAN_REQUIRED when product_decision conflicts remain', () => {
    const body = `# Review Adjudication: LEA-192

## Conflicts
- **product_decision** · Vacancy on empty Core search
  Code reviewer: vacate all. Haystack: add guard.

## Unified remediation plan
- **DEFERRED** · Vacancy semantics — awaiting human decision

## Status
AUTO_REMEDIATE`;

    expect(parseAdjudicationBody(body).status).toBe('HUMAN_REQUIRED');
  });

  it('parses AUTO_REMEDIATE when status line includes trailing commentary', () => {
    const body = `# Review Adjudication: LEA-192

## Status
AUTO_REMEDIATE — aligned reviewers, no open conflicts

## Unified remediation plan
- **AUTO** · Add CSRF guard`;

    expect(parseAdjudicationBody(body)).toMatchObject({
      status: 'AUTO_REMEDIATE',
    });
  });

  it('extracts unified plan sections containing the letter Z without truncating', () => {
    const body = `# Review Adjudication: LEA-192

## Unified remediation plan
- **AUTO** · Normalize timezone offsets (UTC+0) for zero-balance vouchers

## Status
AUTO_REMEDIATE`;

    expect(parseAdjudicationBody(body)).toMatchObject({
      status: 'AUTO_REMEDIATE',
      unifiedPlan: '- **AUTO** · Normalize timezone offsets (UTC+0) for zero-balance vouchers',
    });
  });

  it('defaults to HUMAN_REQUIRED when status is missing', () => {
    expect(
      parseAdjudicationBody('# Review Adjudication: X\n\n## Summary\nIncomplete'),
    ).toMatchObject({
      status: 'HUMAN_REQUIRED',
    });
  });
});
