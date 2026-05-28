import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyLinearSignature } from './webhook-signature.js';

const SECRET = 'super-secret';
const PAYLOAD = '{"action":"create","type":"Issue"}';

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifyLinearSignature', () => {
  it('returns true for a valid signature', () => {
    expect(verifyLinearSignature(PAYLOAD, sign(PAYLOAD, SECRET), SECRET)).toBe(true);
  });

  it('returns false when the secret is wrong', () => {
    expect(verifyLinearSignature(PAYLOAD, sign(PAYLOAD, 'wrong-secret'), SECRET)).toBe(false);
  });

  it('returns false when the signature header is undefined', () => {
    expect(verifyLinearSignature(PAYLOAD, undefined, SECRET)).toBe(false);
  });

  it('returns false when the hex string has the wrong length', () => {
    expect(verifyLinearSignature(PAYLOAD, 'tooshort', SECRET)).toBe(false);
  });

  it('returns false when the header has a sha256= prefix (unlike GitHub, Linear sends raw hex)', () => {
    const withPrefix = 'sha256=' + sign(PAYLOAD, SECRET);
    expect(verifyLinearSignature(PAYLOAD, withPrefix, SECRET)).toBe(false);
  });

  it('returns false when the secret is empty', () => {
    expect(verifyLinearSignature(PAYLOAD, sign(PAYLOAD, ''), '')).toBe(false);
  });

  it('returns false for non-hex characters in signature', () => {
    const invalidHex = 'z'.repeat(64);
    expect(verifyLinearSignature(PAYLOAD, invalidHex, SECRET)).toBe(false);
  });
});
