import { describe, expect, it } from 'vitest';
import { haystackSkipEvidenceFromPrStatus } from './skip-evidence.js';
import type { HaystackPrStatusJson } from './types.js';

describe('haystackSkipEvidenceFromPrStatus', () => {
  it('returns analysis_ready when analysisStatus is ready', () => {
    const payload: HaystackPrStatusJson = { analysisStatus: 'ready' };
    expect(haystackSkipEvidenceFromPrStatus(payload)).toEqual({
      kind: 'analysis_ready',
      detail: 'Haystack analysisStatus=ready while triage was unavailable',
    });
  });

  it('reads analysisStatus from inputs', () => {
    const payload: HaystackPrStatusJson = { inputs: { analysisStatus: 'ready' } };
    expect(haystackSkipEvidenceFromPrStatus(payload)?.kind).toBe('analysis_ready');
  });

  it('returns rating_present when haystackRating is set', () => {
    const payload: HaystackPrStatusJson = { haystackRating: 3 };
    expect(haystackSkipEvidenceFromPrStatus(payload)).toEqual({
      kind: 'rating_present',
      detail: 'Haystack haystackRating=3 present while triage was unavailable',
    });
  });

  it('returns null when pr-status has no evidence signals', () => {
    expect(haystackSkipEvidenceFromPrStatus({ analysisStatus: 'pending' })).toBeNull();
    expect(haystackSkipEvidenceFromPrStatus(null)).toBeNull();
  });
});
