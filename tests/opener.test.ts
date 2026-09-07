import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { InboundComment } from '../src/channel/parse.ts';
import { fitToLimit, RecordingDispatcher, TEXT_LIMIT_BYTES } from '../src/channel/dispatcher.ts';
import {
  alreadyDecided,
  COMMENT_WINDOW_MS,
  decideOpener,
  decisionsFor,
  recordDecision,
} from '../src/opener/policy.ts';
import { migrate, type DB } from '../src/store/db.ts';

const BRAND = ['17841400000000000', '38097900000000000'];

const comment = (over: Partial<InboundComment> = {}): InboundComment => ({
  kind: 'comment',
  eventId: 'comment-1',
  customerId: 'customer-1',
  username: 'maya.runs',
  text: 'obsessed with this colorway 😍',
  mediaId: 'media-1',
  mediaProductType: 'FEED',
  at: Date.now(),
  ...over,
});

const decide = (over: Partial<InboundComment> = {}, hasConversation = false) =>
  decideOpener({ comment: comment(over), brandAccountIds: BRAND, hasConversation });

describe('Opener policy', () => {
  it('sends for a first-time commenter who left something specific', () => {
    expect(decide()).toMatchObject({ decision: 'send' });
  });

  describe('withholds', () => {
    it('when the comment is the brand’s own', () => {
      expect(decide({ customerId: BRAND[0]! })).toMatchObject({
        decision: 'withhold',
        reason: expect.stringContaining('brand’s own'),
      });
    });

    /**
     * A reply to another comment is usually two other people talking. Opening a
     * DM off the back of it reads as eavesdropping, and spends the one message
     * that comment will ever earn.
     */
    it('when the comment replies to another comment', () => {
      expect(decide({ parentId: 'comment-0' })).toMatchObject({
        decision: 'withhold',
        reason: expect.stringContaining('replies to another comment'),
      });
    });

    it('when the seven-day window has closed', () => {
      expect(decide({ at: Date.now() - COMMENT_WINDOW_MS - 1000 })).toMatchObject({
        decision: 'withhold',
        reason: expect.stringContaining('seven-day'),
      });
    });

    it('when the customer is already mid-conversation', () => {
      expect(decide({}, true)).toMatchObject({
        decision: 'withhold',
        reason: expect.stringContaining('already has an open conversation'),
      });
    });

    /**
     * The heart of the rail. "🔥🔥🔥" is enthusiasm, but there is nothing in it
     * to be specific about, and a generic DM is worse than silence — it spends
     * the single allowance to say something anyone could have said.
     */
    it.each(['🔥🔥🔥', '!!!', '😍', '  ', '❤️'])('when the comment is just %s', (text) => {
      expect(decide({ text })).toMatchObject({
        decision: 'withhold',
        reason: expect.stringContaining('no words'),
      });
    });

    it.each([
      'check my page for free followers',
      'follow me back!!',
      'buy here https://spam.example',
    ])('when the comment looks like spam: %s', (text) => {
      expect(decide({ text })).toMatchObject({
        decision: 'withhold',
        reason: expect.stringContaining('spam'),
      });
    });
  });

  it('sends when a comment carries words alongside emoji', () => {
    expect(decide({ text: 'is the sage one waterproof? 😍' })).toMatchObject({ decision: 'send' });
  });

  /** Judging enthusiasm is the model's job. This rail only asks if we can answer at all. */
  it('does not withhold merely because a comment is unenthusiastic', () => {
    expect(decide({ text: 'how much is this' })).toMatchObject({ decision: 'send' });
  });
});

describe('Opener decisions are recorded', () => {
  let db: DB;
  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
  });

  it('records a withheld Opener with its reason, so silence is accountable', () => {
    const c = comment({ text: '🔥' });
    const decision = decideOpener({ comment: c, brandAccountIds: BRAND, hasConversation: false });
    recordDecision(db, c, decision);

    expect(decisionsFor(db, c.eventId)).toEqual({
      decision: 'withhold',
      reason: expect.stringContaining('no words'),
    });
  });

  /**
   * The record is what makes the one-Opener rule survive a restart. Holding it
   * in memory would hand back a fresh allowance on every deploy.
   */
  it('reports a comment as decided so a second Opener is never attempted', () => {
    const c = comment();
    expect(alreadyDecided(db, c.eventId)).toBe(false);

    recordDecision(db, c, { decision: 'send', reason: 'first-time commenter' });

    expect(alreadyDecided(db, c.eventId)).toBe(true);
  });

  it('keeps the first decision when the same comment is decided twice', () => {
    const c = comment();
    recordDecision(db, c, { decision: 'send', reason: 'first' });
    recordDecision(db, c, { decision: 'withhold', reason: 'second' });

    expect(decisionsFor(db, c.eventId)).toMatchObject({ decision: 'send', reason: 'first' });
  });
});

describe('Dispatcher limits', () => {
  it('leaves a short reply untouched', () => {
    expect(fitToLimit('hello there')).toBe('hello there');
  });

  /** The limit is bytes. Emoji cost four each, so this is well under 1000 characters. */
  it('trims by bytes, not characters', () => {
    const emoji = '😍'.repeat(400);
    expect(emoji.length).toBeLessThan(TEXT_LIMIT_BYTES);
    expect(Buffer.byteLength(emoji, 'utf8')).toBeGreaterThan(TEXT_LIMIT_BYTES);

    const fitted = fitToLimit(emoji);
    expect(Buffer.byteLength(fitted, 'utf8')).toBeLessThanOrEqual(TEXT_LIMIT_BYTES);
  });

  it('never splits a character in half', () => {
    const fitted = fitToLimit('😍'.repeat(400));
    expect(fitted).not.toContain('�');
    expect([...fitted].every((c) => c === '😍' || c === '…')).toBe(true);
  });

  it('records what it would have sent, already fitted', async () => {
    const dispatcher = new RecordingDispatcher();
    await dispatcher.sendPrivateReply('comment-1', '😍'.repeat(400));

    expect(dispatcher.sent[0]?.kind).toBe('private_reply');
    expect(Buffer.byteLength(dispatcher.sent[0]!.text, 'utf8')).toBeLessThanOrEqual(TEXT_LIMIT_BYTES);
  });
});
