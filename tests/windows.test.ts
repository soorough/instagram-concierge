import { describe, expect, it } from 'vitest';
import { ageToTimestamp, buildDelivery } from '../src/replay/payload.ts';
import { parseDelivery } from '../src/channel/parse.ts';
import { decideOpener, COMMENT_WINDOW_MS } from '../src/opener/policy.ts';
import { REPLY_WINDOW_MS } from '../src/store/conversation.ts';

/**
 * Making the platform's two clocks demonstrable.
 *
 * Both windows were enforced from the start and neither could be *shown*: the
 * console always stamped an Event with the current time, so the 24-hour reply
 * window was permanently fresh and the 7-day comment window permanently open.
 * A rule that cannot be triggered is one a walkthrough has to take on trust.
 *
 * The lever is the Event's own timestamp rather than a hidden endpoint that
 * edits rows. `last_seen_at` is written from `event.at`, and the opener policy
 * reads `comment.at`, so backdating the Delivery closes both — and it stays
 * within what Replay is allowed to do (ADR 0001: substitute Event contents,
 * never the transport or the signature).
 */
const ACCOUNT = '17841400000000000';

describe('backdated deliveries', () => {
  it('stamps a message with the time it is given, not the time it is built', () => {
    const at = Date.now() - 25 * 60 * 60 * 1000;
    const { events } = parseDelivery(
      JSON.parse(
        buildDelivery({
          kind: 'message',
          text: 'still there?',
          eventId: 'm-1',
          customerId: 'cust-1',
          accountId: ACCOUNT,
          at,
        }),
      ),
      [ACCOUNT],
    );

    expect(events).toHaveLength(1);
    // Within a second: entry.time has whole-second resolution.
    expect(Math.abs(events[0]!.at - at)).toBeLessThan(1000);
  });

  it('puts a 25-hour-old message outside the 24-hour reply window', () => {
    const at = Date.now() - 25 * 60 * 60 * 1000;
    // What `withinReplyWindow` will compare, once `last_seen_at` is written from it.
    expect(Date.now() - at).toBeGreaterThan(REPLY_WINDOW_MS);
  });

  it('withholds an opener for a comment older than seven days', () => {
    const at = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const { events } = parseDelivery(
      JSON.parse(
        buildDelivery({
          kind: 'comment',
          text: 'is this still available?',
          eventId: 'c-1',
          customerId: 'cust-2',
          username: 'slittone',
          accountId: ACCOUNT,
          at,
        }),
      ),
      [ACCOUNT],
    );

    const comment = events[0];
    expect(comment?.kind).toBe('comment');

    const decision = decideOpener({
      comment: comment as never,
      brandAccountIds: [ACCOUNT],
      hasConversation: false,
    });

    expect(decision.decision).toBe('withhold');
    expect(decision.reason).toContain('seven-day');
  });

  it('still opens for a comment inside the window', () => {
    const at = Date.now() - (COMMENT_WINDOW_MS - 60_000);
    const { events } = parseDelivery(
      JSON.parse(
        buildDelivery({
          kind: 'comment',
          text: 'obsessed with this red blend, is it good with steak?',
          eventId: 'c-2',
          customerId: 'cust-3',
          username: 'slittone',
          accountId: ACCOUNT,
          at,
        }),
      ),
      [ACCOUNT],
    );

    const decision = decideOpener({
      comment: events[0] as never,
      brandAccountIds: [ACCOUNT],
      hasConversation: false,
    });
    expect(decision.decision).toBe('send');
  });

  /**
   * The replay CLI and the console are meant to be two doors onto one payload
   * builder — `payload.ts` is shared precisely so they cannot drift into
   * disagreeing about what Instagram sends. The console gained an age control
   * and the CLI did not, which is exactly that drift, so the CLI parses one too.
   */
  it('accepts an age in hours from the CLI, the same as the console', () => {
    const at = ageToTimestamp('25');
    expect(at).toBeDefined();
    expect(Date.now() - at!).toBeGreaterThan(REPLY_WINDOW_MS);
  });

  it('ignores an age that is absent, zero or not a number', () => {
    expect(ageToTimestamp(undefined)).toBeUndefined();
    expect(ageToTimestamp('')).toBeUndefined();
    expect(ageToTimestamp('0')).toBeUndefined();
    expect(ageToTimestamp('soon')).toBeUndefined();
  });

  it('defaults to now when no time is given, so normal sends are unaffected', () => {
    const { events } = parseDelivery(
      JSON.parse(
        buildDelivery({
          kind: 'message',
          text: 'hello',
          eventId: 'm-2',
          customerId: 'cust-4',
          accountId: ACCOUNT,
        }),
      ),
      [ACCOUNT],
    );
    expect(Math.abs(events[0]!.at - Date.now())).toBeLessThan(2000);
  });
});
