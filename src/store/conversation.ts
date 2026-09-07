import type { Turn } from '../agent/provider.ts';
import type { DB } from './db.ts';

/**
 * The Conversation: the whole ongoing relationship with one Customer.
 *
 * It is keyed on the Customer identifier the transport asserted, never on
 * anything they typed. That is the same rule the Receiver enforces, carried
 * through to storage — if identity could be written from message content,
 * verifying the Delivery would have bought nothing.
 */

export type StoredMessage = { role: 'customer' | 'concierge'; text: string; at: number };

export function ensureConversation(
  db: DB,
  customerId: string,
  username: string | undefined,
  now = Date.now(),
): void {
  db.prepare(
    `insert into conversation (customer_id, username, created_at, last_seen_at)
     values (?, ?, ?, ?)
     on conflict (customer_id) do update set
       last_seen_at = excluded.last_seen_at,
       -- Keep a username once known; a later Event may not carry one.
       username = coalesce(excluded.username, conversation.username)`,
  ).run(customerId, username ?? null, now, now);
}

export function hasConversation(db: DB, customerId: string): boolean {
  return db.prepare('select 1 from conversation where customer_id = ?').get(customerId) !== undefined;
}

export function appendMessage(
  db: DB,
  customerId: string,
  role: 'customer' | 'concierge',
  text: string,
  now = Date.now(),
): void {
  db.prepare('insert into message (customer_id, role, text, at) values (?, ?, ?, ?)').run(
    customerId,
    role,
    text,
    now,
  );
}

/**
 * Conversation history as the model sees it.
 *
 * Only the plain exchange is replayed — not the Tool calls that produced it.
 * Those are recorded for audit, but feeding old Tool results back would spend
 * context on stale prices and let the model quote a total the store no longer
 * charges. Anything still true can be looked up again; that is what the budget
 * is for.
 *
 * The window is a message count rather than a token budget because Instagram
 * messages are short and the cap is about relevance, not cost: a Customer who
 * asked about shipping forty messages ago is not asking now.
 */
export function historyFor(db: DB, customerId: string, limit = 20): Turn[] {
  const rows = db
    .prepare('select role, text, at from message where customer_id = ? order by at desc, id desc limit ?')
    .all(customerId, limit) as StoredMessage[];

  return rows
    .reverse()
    .map((row): Turn =>
      row.role === 'customer'
        ? { role: 'user', content: row.text }
        : { role: 'assistant', steps: [{ kind: 'text', text: row.text }] },
    );
}

/** Records the Turn, and returns its id so its Tool calls can point at it. */
export function recordTurn(
  db: DB,
  customerId: string,
  turn: {
    eventId: string;
    kind: string;
    modelCalls: number;
    modelMs: number;
    toolMs: number;
    escalated: boolean;
    reply: string;
  },
  now = Date.now(),
): number {
  const result = db
    .prepare(
      `insert into turn (customer_id, event_id, kind, model_calls, model_ms, tool_ms, escalated, reply, at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      customerId,
      turn.eventId,
      turn.kind,
      turn.modelCalls,
      turn.modelMs,
      turn.toolMs,
      turn.escalated ? 1 : 0,
      turn.reply,
      now,
    );
  return Number(result.lastInsertRowid);
}

export function recordToolCall(
  db: DB,
  customerId: string,
  turnId: number,
  entry: { tool: string; input: unknown; ok: boolean; result: string; durationMs: number },
  now = Date.now(),
): void {
  db.prepare(
    `insert into tool_call (turn_id, customer_id, tool, arguments, ok, result, duration_ms, at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    turnId,
    customerId,
    entry.tool,
    JSON.stringify(entry.input),
    entry.ok ? 1 : 0,
    entry.result.slice(0, 2000),
    entry.durationMs,
    now,
  );
}

/**
 * The 24-hour Reply Window.
 *
 * Instagram allows the Concierge to reply freely for 24 hours after the Customer
 * last wrote; after that the thread is closed to us. Replies are normally sent
 * seconds later, so this rarely fires — but a Turn delayed by a slow Tool, a
 * retry, or a restart can land outside it, and the platform answers that with an
 * error rather than a warning.
 *
 * Measured from the Customer's own last message. Measuring from any activity
 * would let the Concierge hold its own window open by talking.
 */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function withinReplyWindow(db: DB, customerId: string, now = Date.now()): boolean {
  const row = db
    .prepare('select last_seen_at from conversation where customer_id = ?')
    .get(customerId) as { last_seen_at: number } | undefined;
  if (!row) return false;
  return now - row.last_seen_at <= REPLY_WINDOW_MS;
}

/** The Cart this Conversation is building, if any. */
export function cartIdFor(db: DB, customerId: string): string | undefined {
  const row = db.prepare('select cart_id from conversation where customer_id = ?').get(customerId) as
    | { cart_id: string | null }
    | undefined;
  return row?.cart_id ?? undefined;
}

export function rememberCart(db: DB, customerId: string, cartId: string): void {
  db.prepare('update conversation set cart_id = ? where customer_id = ?').run(cartId, customerId);
}
