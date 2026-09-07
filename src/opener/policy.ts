import type { InboundComment } from '../channel/parse.ts';
import type { DB } from '../store/db.ts';

/**
 * Whether a comment has earned the one Opener it will ever be allowed.
 *
 * The platform grants exactly one Private Reply per comment, permanently. That
 * makes sending the interesting decision rather than the default one: a DM to
 * someone who wrote "🔥" is not a conversation starter, it is an unsolicited
 * message from a brand, and it spends the only chance that person will ever give
 * us to say something better.
 *
 * So this returns send-or-withhold with a reason, and the reason is recorded
 * either way. A Withheld Opener is an outcome the system chose and can account
 * for — not an absence, and not a failure.
 *
 * The checks below are deliberately about *addressability*, never about
 * sentiment. Judging whether a comment is enthusiastic enough is the model's
 * business; whether we are permitted and able to answer at all is ours.
 */

export type OpenerDecision =
  | { decision: 'send'; reason: string }
  | { decision: 'withhold'; reason: string };

/** Meta's window: seven days from the comment, not from when we received it. */
export const COMMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Shorter than this and there is nothing specific to be personal about. */
const MIN_MEANINGFUL_LENGTH = 3;

export type PolicyInput = {
  comment: InboundComment;
  /** Identifiers of the Brand Account, so we never open a Conversation with ourselves. */
  brandAccountIds: readonly string[];
  /** True when this Customer already has an open Conversation. */
  hasConversation: boolean;
  now?: number;
};

export function decideOpener(input: PolicyInput): OpenerDecision {
  const { comment, brandAccountIds, hasConversation } = input;
  const now = input.now ?? Date.now();

  if (brandAccountIds.includes(comment.customerId)) {
    return { decision: 'withhold', reason: 'the comment is the brand’s own' };
  }

  /**
   * A reply to another comment is usually a conversation between two other
   * people. Opening a DM off the back of it reads as eavesdropping.
   */
  if (comment.parentId) {
    return { decision: 'withhold', reason: 'the comment replies to another comment, not to the post' };
  }

  if (now - comment.at > COMMENT_WINDOW_MS) {
    return { decision: 'withhold', reason: 'the seven-day comment window has closed' };
  }

  /**
   * Someone already talking to us does not need an Opener; they need a reply in
   * the Conversation they already have. Sending one anyway would spend the
   * comment's single allowance to say hello to someone mid-sentence.
   */
  if (hasConversation) {
    return { decision: 'withhold', reason: 'this customer already has an open conversation' };
  }

  const text = comment.text.trim();

  if (stripDecoration(text).length < MIN_MEANINGFUL_LENGTH) {
    return {
      decision: 'withhold',
      reason: 'the comment carries no words to be specific about',
    };
  }

  if (isLikelySpam(text)) {
    return { decision: 'withhold', reason: 'the comment looks like promotion or spam' };
  }

  return { decision: 'send', reason: 'a first-time commenter left something specific to answer' };
}

/** Records the decision. Written before any send is attempted, never after. */
export function recordDecision(
  db: DB,
  comment: InboundComment,
  decision: OpenerDecision,
  now = Date.now(),
): void {
  db.prepare(
    `insert or ignore into opener_decision (comment_id, customer_id, decision, reason, at)
     values (?, ?, ?, ?, ?)`,
  ).run(comment.eventId, comment.customerId, decision.decision, decision.reason, now);
}

/** True when this comment has already been decided — its one chance is spent. */
export function alreadyDecided(db: DB, commentId: string): boolean {
  return db.prepare('select 1 from opener_decision where comment_id = ?').get(commentId) !== undefined;
}

export function decisionsFor(db: DB, commentId: string): OpenerDecision | undefined {
  const row = db
    .prepare('select decision, reason from opener_decision where comment_id = ?')
    .get(commentId) as { decision: 'send' | 'withhold'; reason: string } | undefined;
  return row ? ({ decision: row.decision, reason: row.reason } as OpenerDecision) : undefined;
}

/**
 * Emoji, punctuation and whitespace removed, to ask what words are left. "🔥🔥🔥"
 * and "!!!" both collapse to nothing, which is the honest answer about how much
 * there is to personalise against.
 */
function stripDecoration(text: string): string {
  return text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
    .replace(/[^\p{Letter}\p{Number}]/gu, '')
    .trim();
}

function isLikelySpam(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /https?:\/\//.test(lower) ||
    /\b(follow|check|dm)\s+(me|my|back)\b/.test(lower) ||
    /\bfree\s+(followers|likes)\b/.test(lower)
  );
}
