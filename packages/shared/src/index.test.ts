import { describe, expect, it } from 'vitest';
import { HELM_VERSION } from './index.js';

describe('HELM_VERSION', () => {
  it('is the current semver string', () => {
    expect(HELM_VERSION).toBe('0.0.0');
  });
});
