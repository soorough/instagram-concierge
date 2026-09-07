/**
 * Turns a verified Delivery into the Events the Concierge acts on.
 *
 * The shape below is not the one Meta's own reference implies for Instagram
 * messaging. Facebook-Login apps receive a `messaging` array; Instagram-Login
 * apps — which is what we use, because it needs no linked Facebook Page —
 * receive `changes`, each with a `field` and a `value`. This was established by
 * capturing real Deliveries rather than by reading, and coding to the assumption
 * would have failed on the first event. See docs/platform-findings.md §8.
 */

export type InboundMessage = {
  kind: 'message';
  eventId: string;
  customerId: string;
  text: string;
  at: number;
};

export type InboundComment = {
  kind: 'comment';
  eventId: string;
  customerId: string;
  username: string;
  text: string;
  mediaId: string;
  mediaProductType: string;
  /** Present when the comment replies to another comment rather than the post. */
  parentId?: string;
  at: number;
};

export type InboundEvent = InboundMessage | InboundComment;

export type ParseResult = {
  /** Events worth acting on, in the order Meta sent them. */
  events: InboundEvent[];
  /** Why anything was dropped. Surfaced so silence is never unexplained. */
  ignored: string[];
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  typeof v === 'object' && v !== null ? (v as Json) : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * @param accountIds every identifier that means "our Brand Account". A valid
 * signature proves Meta sent the Delivery; it does not prove which account the
 * Delivery concerns, because one app secret signs every surface on the app. So
 * the account is asserted here, separately, and a Delivery for anyone else is
 * dropped rather than answered.
 */
export function parseDelivery(payload: unknown, accountIds: readonly string[]): ParseResult {
  const events: InboundEvent[] = [];
  const ignored: string[] = [];

  const root = obj(payload);
  if (root?.['object'] !== 'instagram') {
    return { events, ignored: [`unexpected object "${String(root?.['object'])}"`] };
  }

  const entries = Array.isArray(root['entry']) ? root['entry'] : [];
  for (const rawEntry of entries) {
    const entry = obj(rawEntry);
    if (!entry) continue;

    const accountId = str(entry['id']);
    if (!accountId || !accountIds.includes(accountId)) {
      ignored.push(`delivery for account ${accountId ?? '(missing)'} is not ours`);
      continue;
    }

    const time = typeof entry['time'] === 'number' ? entry['time'] * 1000 : Date.now();
    const changes = Array.isArray(entry['changes']) ? entry['changes'] : [];

    for (const rawChange of changes) {
      const change = obj(rawChange);
      const field = str(change?.['field']);
      const value = obj(change?.['value']);
      if (!field || !value) continue;

      if (field === 'messages') {
        const parsed = parseMessage(value, time, ignored);
        if (parsed) events.push(parsed);
      } else if (field === 'comments') {
        const parsed = parseComment(value, time, ignored);
        if (parsed) events.push(parsed);
      } else {
        ignored.push(`field "${field}" is not subscribed behaviour`);
      }
    }
  }

  return { events, ignored };
}

function parseMessage(value: Json, time: number, ignored: string[]): InboundMessage | undefined {
  const message = obj(value['message']);

  /**
   * Meta echoes the Brand Account's own outgoing messages back to us. Without
   * this the Concierge answers itself, and because each reply is itself echoed
   * the loop does not terminate on its own.
   */
  if (message?.['is_echo'] === true) {
    ignored.push('echo of our own message');
    return undefined;
  }

  const eventId = str(message?.['mid']);
  const customerId = str(obj(value['sender'])?.['id']);
  const text = str(message?.['text']);

  if (!eventId || !customerId) {
    ignored.push('message without a mid or sender');
    return undefined;
  }
  if (text === undefined) {
    // Attachments, reactions and shares arrive here. Out of scope, but the
    // Customer still deserves a reply eventually, so it is reported not hidden.
    ignored.push('message carries no text');
    return undefined;
  }

  const at = Number(str(value['timestamp']) ?? time);
  return { kind: 'message', eventId, customerId, text, at: Number.isFinite(at) ? at : time };
}

function parseComment(value: Json, time: number, ignored: string[]): InboundComment | undefined {
  const eventId = str(value['id']);
  const from = obj(value['from']);
  const customerId = str(from?.['id']);
  const username = str(from?.['username']);
  const text = str(value['text']);
  const media = obj(value['media']);

  if (!eventId || !customerId || text === undefined) {
    ignored.push('comment without an id, author or text');
    return undefined;
  }

  return {
    kind: 'comment',
    eventId,
    customerId,
    username: username ?? '',
    text,
    mediaId: str(media?.['id']) ?? '',
    mediaProductType: str(media?.['media_product_type']) ?? '',
    ...(str(value['parent_id']) ? { parentId: str(value['parent_id'])! } : {}),
    at: time,
  };
}
