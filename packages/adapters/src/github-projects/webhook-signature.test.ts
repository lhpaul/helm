import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyGitHubSignature } from './webhook-signature.js';

const SECRET = 'super-secret';
const PAYLOAD = '{"action":"opened"}';

function sign(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifyGitHubSignature', () => {
  it('returns true for a valid signature', () => {
    expect(verifyGitHubSignature(PAYLOAD, sign(PAYLOAD, SECRET), SECRET)).toBe(true);
  });

  it('returns false when the secret is wrong', () => {
    expect(verifyGitHubSignature(PAYLOAD, sign(PAYLOAD, 'wrong-secret'), SECRET)).toBe(false);
  });

  it('returns false when the signature header is undefined', () => {
    expect(verifyGitHubSignature(PAYLOAD, undefined, SECRET)).toBe(false);
  });

  it('returns false when the header lacks the sha256= prefix', () => {
    const bare = createHmac('sha256', SECRET).update(PAYLOAD).digest('hex');
    expect(verifyGitHubSignature(PAYLOAD, bare, SECRET)).toBe(false);
  });

  it('returns false when the hex string has the wrong length', () => {
    expect(verifyGitHubSignature(PAYLOAD, 'sha256=tooshort', SECRET)).toBe(false);
  });

  it('returns false when the secret is empty', () => {
    expect(verifyGitHubSignature(PAYLOAD, sign(PAYLOAD, ''), '')).toBe(false);
  });
});
