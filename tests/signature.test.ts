import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifySignature } from '../src/channel/signature.ts';

/**
 * Two kinds of test live here, and the split matters.
 *
 * The first kind signs its own bodies with a throwaway secret. It proves the
 * mechanics — tampering, wrong secret, malformed headers, non-ASCII — and runs
 * anywhere, for anyone, with no credentials.
 *
 * The second kind verifies real Deliveries captured from Meta's App Dashboard
 * test facility, against the signature Meta itself generated. Only this can
 * prove we agree with Meta rather than merely with ourselves, and capturing it
 * corrected two things we had wrong by inference: that the Meta app secret signs
 * Deliveries (it does not — the Instagram one does), and that the payload
 * carries a `messaging` array (it carries `changes`). It needs the real secret,
 * so it reads IG_APP_SECRET from the environment and skips when absent. The
 * secret is never committed.
 */

const TEST_SECRET = 'f'.repeat(32);
const sign = (raw: Buffer, secret: string) =>
  'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');

describe('verifySignature — mechanics', () => {
  const body = Buffer.from(JSON.stringify({ object: 'instagram', entry: [] }), 'utf8');

  it('accepts a signature over the exact bytes', () => {
    expect(verifySignature(body, sign(body, TEST_SECRET), TEST_SECRET)).toBe(true);
  });

  it('rejects a body altered after signing', () => {
    const signature = sign(body, TEST_SECRET);
    const tampered = Buffer.from(body.toString('utf8').replace('instagram', 'attacker'), 'utf8');
    expect(verifySignature(tampered, signature, TEST_SECRET)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifySignature(body, sign(body, 'a'.repeat(32)), TEST_SECRET)).toBe(false);
  });

  it('rejects a header missing the sha256= prefix', () => {
    const bare = sign(body, TEST_SECRET).replace('sha256=', '');
    expect(verifySignature(body, bare, TEST_SECRET)).toBe(false);
  });

  it('rejects a missing header rather than throwing', () => {
    expect(verifySignature(body, undefined, TEST_SECRET)).toBe(false);
  });

  it('rejects a short signature without throwing', () => {
    // timingSafeEqual throws on a length mismatch, so the guard must precede it.
    // A forged header must never be able to turn a rejection into a 500.
    expect(verifySignature(body, 'sha256=abc', TEST_SECRET)).toBe(false);
  });

  /**
   * Non-ASCII is where naive implementations diverge, and the flagship
   * workflow's own example comment carries an emoji — so this is not
   * hypothetical.
   */
  it('verifies a body containing an emoji', () => {
    const raw = Buffer.from(
      JSON.stringify({ text: 'obsessed with this colorway 😍', username: 'maya' }),
      'utf8',
    );
    expect(verifySignature(raw, sign(raw, TEST_SECRET), TEST_SECRET)).toBe(true);
  });
});

describe('verifySignature — against real Meta Deliveries', () => {
  const secret = process.env.IG_APP_SECRET;
  const load = (field: 'messages' | 'comments') =>
    JSON.parse(readFileSync(`fixtures/meta-${field}.json`, 'utf8')) as {
      body: string;
      signature: string;
    };

  it.runIf(Boolean(secret)).each(['messages', 'comments'] as const)(
    'accepts the real %s Delivery Meta signed',
    (field) => {
      const { body, signature } = load(field);
      expect(verifySignature(Buffer.from(body, 'utf8'), signature, secret!)).toBe(true);
    },
  );

  it('the captured fixtures are well-formed regardless of credentials', () => {
    for (const field of ['messages', 'comments'] as const) {
      const { body, signature } = load(field);
      expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
      const parsed = JSON.parse(body) as { object: string; entry: { changes: unknown[] }[] };
      expect(parsed.object).toBe('instagram');
      // Instagram-Login Deliveries carry `changes`, not the `messaging` array
      // documented for Facebook-Login. Asserting it keeps the parser honest.
      expect(parsed.entry[0]?.changes).toBeInstanceOf(Array);
    }
  });
});
