import { createHmac, timingSafeEqual } from 'node:crypto';

const HMAC_HEX_LENGTH = 64;

/**
 * Verifies the Linear-Signature header from a Linear webhook delivery.
 * Linear signs the raw request body with HMAC-SHA256 and sends the hex digest
 * in the Linear-Signature header (no prefix, unlike GitHub's "sha256=" prefix).
 *
 * Security invariants (mirror of verifyGitHubSignature):
 * - Uses timingSafeEqual to prevent timing attacks.
 * - Returns false (never throws) for any malformed input.
 * - Does NOT log the secret, the computed hash, or the received signature.
 */
export function verifyLinearSignature(
  payload: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  if (!secret) return false;

  // Reject anything that isn't a 64-char hex string before buffer allocation.
  if (signatureHeader.length !== HMAC_HEX_LENGTH) return false;

  const expected = createHmac('sha256', secret).update(payload).digest();
  const received = Buffer.from(signatureHeader, 'hex');

  // Buffer.from with invalid hex can produce a shorter buffer — guard before timingSafeEqual.
  if (received.length !== expected.length) return false;

  return timingSafeEqual(expected, received);
}
