import { describe, expect, it } from 'vitest';
import { seedFromReviewLoopLedger } from './cumulative-ledger.js';

describe('seedFromReviewLoopLedger', () => {
  it('starts from zero for a lane with no history', () => {
    expect(seedFromReviewLoopLedger(undefined)).toEqual({
      priorCycles: 0,
      noProgressStreak: 0,
      bestBlockerCount: null,
    });
  });

  it('carries cycles, streak, and best blocker count across dispatches', () => {
    expect(
      seedFromReviewLoopLedger({
        cyclesTotal: 7,
        noProgressStreak: 1,
        bestBlockerCount: 2,
        updatedAt: '2026-08-13T00:00:00.000Z',
      }),
    ).toEqual({ priorCycles: 7, noProgressStreak: 1, bestBlockerCount: 2 });
  });

  it('treats a missing bestBlockerCount as no baseline rather than zero blockers', () => {
    // null means "nothing to compare against"; 0 would claim a clean best and
    // make every later cycle look like a regression.
    expect(
      seedFromReviewLoopLedger({
        cyclesTotal: 3,
        noProgressStreak: 0,
        updatedAt: '2026-08-13T00:00:00.000Z',
      }).bestBlockerCount,
    ).toBeNull();
  });
});
