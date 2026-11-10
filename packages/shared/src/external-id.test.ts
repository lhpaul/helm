import { describe, expect, it } from 'vitest';
import { EXTERNAL_ID_REGEX, isValidExternalId } from './external-id.js';

describe('isValidExternalId', () => {
  it.each(['HLM-42', 'issue_129', 'a.b-c_d', 'x', 'v1.2.3', 'a..b'])('accepts %s', (v) => {
    expect(isValidExternalId(v)).toBe(true);
    expect(EXTERNAL_ID_REGEX.test(v)).toBe(true);
  });

  it.each(['', '.', '..', '.hidden', 'a/b', '../x', 'a b', 'a:b', 'a@b', 'a\nb', 'é'])(
    'rejects %j',
    (v) => {
      expect(isValidExternalId(v)).toBe(false);
      expect(EXTERNAL_ID_REGEX.test(v)).toBe(false);
    },
  );
});
