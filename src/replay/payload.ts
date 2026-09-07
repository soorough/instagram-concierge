import { createHmac } from 'node:crypto';

/**
 * Builds the bytes a Delivery is made of, and signs them.
 *
 * Shared by the replay CLI and the console, so the two cannot drift into
 * disagreeing about what Instagram sends. A demo surface that builds its own
 * slightly-different payload is a demo that stops proving anything.
 *
 * The envelope is copied from a real capture — `changes`, not the `messaging`
 * array Instagram messaging is usually documented with. See
 * docs/platform-findings.md §8.
 */

export type DeliverySpec = {
  kind: 'message' | 'comment';
  text: string;
  eventId: string;
  customerId: string;
  username?: string;
  accountId: string;
  mediaId?: string;
  /**
   * When the Event happened, in epoch ms. Defaults to now.
   *
   * This is the lever that makes the platform's two clocks demonstrable. A
   * Conversation's `last_seen_at` is written from the Event's own timestamp, and
   * the opener policy reads the comment's, so backdating here closes the
   * 24-hour reply window or the 7-day comment window without a single row being
   * edited behind the system's back. It is Event contents and nothing else,
   * which is the only substitution Replay permits (ADR 0001).
   */
  at?: number;
};

export function buildDelivery(spec: DeliverySpec): string {
  const at = spec.at ?? Date.now();

  const value =
    spec.kind === 'message'
      ? {
          sender: { id: spec.customerId },
          recipient: { id: spec.accountId },
          timestamp: String(at),
          message: { mid: spec.eventId, text: spec.text },
        }
      : {
          from: { id: spec.customerId, username: spec.username ?? '' },
          media: { id: spec.mediaId ?? 'media-1', media_product_type: 'FEED' },
          id: spec.eventId,
          text: spec.text,
        };

  return JSON.stringify({
    object: 'instagram',
    entry: [
      {
        id: spec.accountId,
        // Whole seconds, as Meta sends it. A comment's age is read from here.
        time: Math.floor(at / 1000),
        changes: [{ field: spec.kind === 'message' ? 'messages' : 'comments', value }],
      },
    ],
  });
}

/** Signed with the real app secret, so the Receiver's verification genuinely runs. */
export function sign(body: string, appSecret: string): string {
  return 'sha256=' + createHmac('sha256', appSecret).update(Buffer.from(body, 'utf8')).digest('hex');
}

/**
 * Turns an age in hours into the timestamp an Event should carry.
 *
 * Lives here rather than in either caller because both the replay CLI and the
 * console need it, and this file exists to stop those two drifting into
 * disagreeing about what Instagram sends. A missing, zero or unparseable age
 * means "now" — the ordinary case must never be affected by a demo affordance.
 */
export function ageToTimestamp(hours: string | number | undefined): number | undefined {
  const n = Number(hours);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Date.now() - n * 60 * 60 * 1000;
}
