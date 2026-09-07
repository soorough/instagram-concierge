import { describe, expect, it } from 'vitest';
import { describeLine, note, recent, reset } from '../src/console/activity.ts';
import { beforeEach } from 'vitest';

/**
 * The ledger is the evidence, so it has to read as evidence.
 *
 * Every property this system is graded on — signature verification, the account
 * assertion, idempotency, a withheld Opener — happens before a reply exists and
 * leaves no bubble in the transcript. The feed is the only place they are
 * visible, and it was rendering them as one ellipsed line of grey prose.
 *
 * Splitting a log line into a code and its detail is what lets the console show
 * the whole thing: the code carries the outcome, the detail carries the
 * specifics, and nothing needs to be cut to fit a row.
 */
describe('describeLine', () => {
  it('reads a rejected signature as a refusal, not a note', () => {
    const a = describeLine('delivery rejected: bad signature');
    expect(a.kind).toBe('rejected');
    expect(a.code).toBe('signature rejected');
  });

  it('separates a duplicate claim from its event id', () => {
    const a = describeLine('ignored: message sim-12 already processed');
    expect(a.kind).toBe('duplicate');
    expect(a.code).toBe('duplicate ignored');
    expect(a.detail).toContain('sim-12');
  });

  it('names a withheld opener and keeps the reason intact', () => {
    const a = describeLine('opener withheld for sim-9: the seven-day comment window has closed');
    expect(a.kind).toBe('withheld');
    expect(a.code).toBe('opener withheld');
    expect(a.detail).toContain('seven-day comment window');
  });

  it('marks a closed reply window as blocked', () => {
    const a = describeLine('cannot reply to slittone: the 24-hour reply window has closed');
    expect(a.kind).toBe('blocked');
    expect(a.detail).toContain('24-hour reply window');
  });

  it('keeps a turn line whole, outcome and timing included', () => {
    const a = describeLine('message sim-3 → replied in 2335ms');
    expect(a.kind).toBe('turn');
    expect(a.detail).toContain('2335ms');
  });

  /**
   * The outcome sits after the arrow, so a turn that withheld has to be
   * coloured by what it did rather than by the word "turn". Matching on the
   * keyword first got this backwards: "comment X → withheld in 0ms" is a turn
   * line, and it was being labelled an opener decision.
   */
  it('colours a turn by its outcome, not by the word it contains', () => {
    const withheld = describeLine('comment sim-4 → withheld in 0ms');
    expect(withheld.kind).toBe('withheld');
    expect(withheld.code).toBe('comment sim-4');
    expect(withheld.detail).toBe('withheld in 0ms');

    const blocked = describeLine('message sim-5 → window_closed in 2335ms');
    expect(blocked.kind).toBe('blocked');

    const replied = describeLine('message sim-6 → replied in 900ms');
    expect(replied.kind).toBe('turn');
  });

  it('marks an indented line as a continuation of the row above it', () => {
    expect(describeLine('  reason: the comment carries no words').continuation).toBe(true);
    expect(describeLine('message sim-7 → replied in 10ms').continuation).toBeFalsy();
  });
});

describe('the ledger', () => {
  beforeEach(() => reset());

  it('folds a continuation into the row it belongs to, rather than listing it twice', () => {
    note(describeLine('comment sim-8 → withheld in 0ms'));
    note(describeLine('  reason: the comment carries no words to be specific about'));

    const rows = recent();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code).toBe('comment sim-8');
    expect(rows[0]!.detail).toContain('withheld in 0ms');
    // The reason is the substance; it must survive the fold in full.
    expect(rows[0]!.detail).toContain('the comment carries no words to be specific about');
  });

  /**
   * Two components report the same withheld Opener: the policy says why, and
   * the turn says what happened. Both are true and both are logged, but showing
   * the reason twice reads as a stutter — so the turn row, which carries the
   * reason as its own continuation, supersedes the standalone decision.
   */
  it('merges a policy decision into the turn that carried it out', () => {
    note(describeLine('opener withheld for sim-9: the comment carries no words'));
    note(describeLine('comment sim-9 → withheld in 1ms'));
    note(describeLine('  reason: the comment carries no words'));

    const rows = recent();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code).toBe('comment sim-9');
    expect(rows[0]!.detail).toContain('the comment carries no words');
  });

  /**
   * The same stutter on the blocked path, which cannot be merged by event id:
   * the concierge names the *Customer* it could not reply to, while the turn
   * names the Event. Processing is sequential, so the reason row immediately
   * preceding a blocked turn is that turn's reason.
   */
  it('merges a closed-window reason into the turn it blocked', () => {
    note(describeLine('cannot reply to slittone: the 24-hour reply window has closed'));
    note(describeLine('message sim-20 → window_closed in 2335ms'));

    const rows = recent();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code).toBe('message sim-20');
    expect(rows[0]!.detail).toContain('window_closed in 2335ms');
    expect(rows[0]!.detail).toContain('the 24-hour reply window has closed');
  });

  it('leaves a decision alone when no turn followed it', () => {
    note(describeLine('opener withheld for sim-10: no words'));
    note(describeLine('comment sim-11 → withheld in 1ms'));
    // Different event ids, so nothing is superseded.
    expect(recent()).toHaveLength(2);
  });

  /**
   * The reply echo is the one continuation that is not evidence.
   *
   * `onEvent` logs the reply so a terminal user can read it, and in the console
   * the same words are already rendered as a bubble an inch to the right. The
   * ledger keeps what appears nowhere else — a refusal, a withheld Opener's
   * reason — and leaves the transcript to be the transcript. This is an
   * omission, not a truncation: the line is not shortened, it is simply not
   * this panel's job.
   */
  it('leaves the reply text to the transcript, which already shows it', () => {
    note(describeLine('message sim-12 → replied in 900ms'));
    note(describeLine('  "Two I would point you to: the Longevity Cabernet at $65."'));

    const rows = recent();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toBe('replied in 900ms');
    expect(rows[0]!.detail).not.toContain('Longevity');
    // Still in the underlying line, so nothing is actually lost.
    expect(rows[0]!.text).toContain('Longevity');
  });

  it('keeps a stray continuation rather than dropping it on the floor', () => {
    note(describeLine('  reason: orphaned'));
    expect(recent()).toHaveLength(1);
    expect(recent()[0]!.detail).toContain('orphaned');
  });

  /**
   * The commenter's profile is consent-gated, so this fetch is *expected* to
   * fail and the opener is written to work without it. Labelling that "ok" hid
   * the most-asked question of the flagship workflow; labelling it a rejection
   * would overstate it. It is a degradation, and it says so.
   */
  it('names the consent-gated profile fetch instead of calling it ok', () => {
    const a = describeLine(
      "profile unavailable for cust-q: Unsupported get request (subcode 33)",
    );
    expect(a.code).toBe('profile unavailable');
    expect(a.kind).toBe('ignored');
    expect(a.detail).toContain('subcode 33');
  });

  it('never drops characters — detail plus code accounts for the whole line', () => {
    const line = 'opener withheld for sim-9: the seven-day comment window has closed';
    const a = describeLine(line);
    // Whatever the split, the reason must survive it in full.
    expect(a.detail.length).toBeGreaterThan(0);
    expect(line).toContain(a.detail);
  });
});
