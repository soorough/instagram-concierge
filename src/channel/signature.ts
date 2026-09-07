import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Proves that a Delivery came from Meta.
 *
 * Three details cause most implementations of this to be quietly wrong.
 *
 * 1. It must run over the *raw* request bytes. Re-serialising parsed JSON does
 *    not reproduce what Meta hashed — key order and whitespace differ — so the
 *    Receiver has to keep the body untouched until this has run.
 *
 * 2. The comparison must be constant-time. A byte-by-byte early return leaks
 *    how much of a forged signature was correct, which is enough to construct
 *    one given patience.
 *
 * 3. `timingSafeEqual` throws when the two buffers differ in length, so length
 *    is checked before it is called. A malformed header is a rejection, never
 *    an exception — an attacker should not be able to turn a bad signature into
 *    a 500.
 *
 * Note the secret: Instagram-Login apps are signed with the *Instagram* app
 * secret, not the Meta app secret. The two are different values in the same
 * dashboard. This was established by reproducing Meta's own signature over a
 * captured Delivery, not from documentation — see docs/platform-findings.md §8.
 *
 * A valid signature proves Meta sent this. It does NOT prove which account the
 * Delivery concerns: one app secret signs every surface on the app. Asserting
 * the Brand Account is a separate check, and the Receiver performs it.
 */
export function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header?.startsWith('sha256=')) return false;

  const provided = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();

  // Guard before timingSafeEqual, which throws on a length mismatch.
  if (provided.length !== expected.length) return false;

  return timingSafeEqual(provided, expected);
}
