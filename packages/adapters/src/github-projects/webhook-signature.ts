import { createHmac, timingSafeEqual } from 'node:crypto';

const SHA256_PREFIX = 'sha256=';
// GitHub's HMAC-SHA256 digest is always 32 bytes = 64 hex chars.
const HMAC_HEX_LENGTH = 64;

/**
 * Verifies the X-Hub-Signature-256 header from a GitHub webhook delivery.
 *
 * Security invariants:
 * - Uses timingSafeEqual to prevent timing attacks.
 * - Returns false (never throws) for any malformed input.
 * - Does NOT log the secret, the computed hash, or the received signature.
 */
export function verifyGitHubSignature(
  payload: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith(SHA256_PREFIX)) return false;
  if (!secret) return false;

  const receivedHex = signatureHeader.slice(SHA256_PREFIX.length);
  // Reject anything that isn't a 64-char hex string before buffer allocation.
  if (receivedHex.length !== HMAC_HEX_LENGTH) return false;

  const expected = createHmac('sha256', secret).update(payload).digest();
  const received = Buffer.from(receivedHex, 'hex');

  // Buffer.from with invalid hex can produce a shorter buffer — guard before timingSafeEqual.
  if (received.length !== expected.length) return false;

  return timingSafeEqual(expected, received);
}
