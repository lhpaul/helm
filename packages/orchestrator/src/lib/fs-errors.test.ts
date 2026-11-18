import { describe, expect, it } from 'vitest';

import { isEnoentError } from './fs-errors.js';

describe('isEnoentError', () => {
  it('returns true for ENOENT errors', () => {
    expect(isEnoentError(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe(true);
  });

  it('returns false for other I/O errors', () => {
    expect(isEnoentError(Object.assign(new Error('denied'), { code: 'EACCES' }))).toBe(false);
  });
});
