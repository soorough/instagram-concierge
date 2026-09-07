/**
 * A small ring of recent events, so the trust boundary is watchable.
 *
 * Signature checks, account assertions and duplicate claims all happen before a
 * reply exists, and they are the properties this system is most graded on —
 * which makes them exactly the things invisible in a transcript. A rejected
 * Delivery leaves no bubble; a duplicate leaves no second bubble. Without this,
 * the most important behaviour is the least demonstrable.
 *
 * In memory on purpose. It is a window on the last few minutes, not a record —
 * the database already holds anything that mattered.
 */

export type ActivityKind =
  | 'inbound'
  | 'verified'
  | 'rejected'
  | 'duplicate'
  | 'ignored'
  | 'turn'
  | 'withheld'
  | 'blocked';

export type Activity = {
  at: number;
  kind: ActivityKind;
  /** The outcome, in two or three words. What the row is *about*. */
  code: string;
  /** The specifics — ids, reasons, timings. Rendered in full, never clipped. */
  detail: string;
  /** The original line, kept whole so nothing depends on the split being right. */
  text: string;
  /**
   * True for an indented log line, which belongs to the row above it.
   *
   * `onEvent` writes an outcome and then, on its own line, the reason or the
   * reply text. Those are one event described in two writes, and listing them
   * as two rows said the same thing twice and separated a decision from its
   * justification.
   */
  continuation?: boolean;
  /** A continuation that merely repeats the reply. Recorded, but not shown. */
  echo?: boolean;
};

const RING = 60;
const entries: Activity[] = [];

export function note(activity: Omit<Activity, 'at'>): void {
  const previous = entries[entries.length - 1];

  // Fold a continuation into the row it explains, keeping every character.
  if (activity.continuation && previous) {
    // The full line is always kept; only the rendered detail skips the echo.
    previous.text = `${previous.text}\n${activity.text}`;
    if (!activity.echo) {
      previous.detail = previous.detail
        ? `${previous.detail}\n${activity.detail}`
        : activity.detail;
    }
    return;
  }

  /**
   * A turn supersedes the policy decision it carried out.
   *
   * `opener withheld for <id>: <reason>` and `comment <id> → withheld in 1ms`
   * describe one event from two components, and the turn row already folds the
   * reason in as its continuation. Keeping both printed the reason twice in a
   * row, which reads as a stutter in the one panel meant to be scanned.
   */
  const eventId = eventIdOf(activity.code);
  if (eventId) {
    const supersededAt = entries.findIndex((e) => e.text.startsWith(`opener withheld for ${eventId}`));
    if (supersededAt !== -1) entries.splice(supersededAt, 1);

    /**
     * The blocked path cannot be matched by event id — the concierge names the
     * Customer it could not reply to, while the turn names the Event. Events
     * are processed one at a time, so a bare reason row sitting immediately
     * before a blocked turn is that turn's reason, and it is folded in rather
     * than printed again underneath.
     */
    const last = entries[entries.length - 1];
    if (last && last.kind === activity.kind && last.code === 'blocked' && !eventIdOf(last.code)) {
      entries.pop();
      activity = { ...activity, detail: `${activity.detail}\n${last.detail}` };
    }
  }

  entries.push({ at: Date.now(), ...activity });
  if (entries.length > RING) entries.shift();
}

/** The event id in a turn's code — "comment sim-9" → "sim-9". */
function eventIdOf(code: string): string | undefined {
  const match = /^(?:message|comment)\s+(\S+)$/.exec(code.trim());
  return match?.[1];
}

/** Empties the ring. For tests, and for a console reset. */
export function reset(): void {
  entries.length = 0;
}

export function recent(): Activity[] {
  return [...entries].reverse();
}

/**
 * Splits a log line into the outcome and its specifics.
 *
 * The feed used to render each line as one clipped string, which is the worst
 * possible treatment for the only surface that shows the trust boundary
 * working: "delivery rejected: bad signat…" is a row that proves nothing.
 * Separating the two lets the console give the outcome weight and colour and
 * still print the reason in full.
 *
 * The whole line is carried alongside, so a line this does not recognise
 * degrades to "shown verbatim" rather than to a wrong label.
 */
export function describeLine(line: string): Omit<Activity, 'at'> {
  /**
   * An indented line continues the one before it. Detected before anything
   * else, because its text would otherwise match a keyword and be classified
   * as an event in its own right — which is how a withheld Opener came to be
   * listed twice, once as the decision and once as its reason.
   */
  if (/^\s+\S/.test(line)) {
    const trimmed = line.trim();
    return {
      kind: 'verified',
      code: '',
      detail: trimmed.replace(/^reason:\s*/, ''),
      text: line,
      continuation: true,
      /**
       * A quoted continuation is the reply itself, which the transcript renders
       * as a bubble beside this panel. The ledger carries what is visible
       * nowhere else; repeating the reply here only pushed the refusals and
       * withheld Openers off the screen.
       */
      echo: trimmed.startsWith('"'),
    };
  }

  /** What the Customer actually said, which is the evidence for everything after it. */
  const inbound = /^(message|comment) from (\S+): "([\s\S]*)"$/.exec(line);
  if (inbound) {
    return {
      kind: 'inbound',
      code: `${inbound[1]} from ${inbound[2]}`,
      detail: inbound[3] ?? '',
      text: line,
    };
  }

  /**
   * A turn line names its outcome after the arrow, and that outcome is what
   * should colour it. Reading the keyword first got this backwards: a line
   * saying "comment X → withheld in 0ms" is a turn that withheld, not an
   * opener-policy entry, and it was being labelled as one.
   */
  const arrow = line.indexOf('→');
  if (arrow !== -1) {
    const after = line.slice(arrow + 1).trim();
    const outcome = after.split(/\s+/)[0] ?? '';
    const turnKind: ActivityKind =
      outcome === 'withheld'
        ? 'withheld'
        : outcome === 'window_closed' || outcome === 'send_failed'
          ? 'blocked'
          : 'turn';

    return { kind: turnKind, code: line.slice(0, arrow).trim(), detail: after, text: line };
  }

  /**
   * Enrichment failing is the normal case, not an error: the User Profile API
   * is consent-gated and a commenter has not consented. The opener is grounded
   * in the post's caption and their own words instead. Naming it here answers
   * the question the flagship workflow always draws.
   */
  if (line.startsWith('profile unavailable')) {
    const at = line.indexOf(':');
    return {
      kind: 'ignored',
      code: 'profile unavailable',
      detail: at === -1 ? line : line.slice(at + 1).trim(),
      text: line,
    };
  }

  const kind = classify(line);

  /** `<prefix>: <rest>` is the shape most of these already have. */
  const split = (label: string): Omit<Activity, 'at'> => {
    const at = line.indexOf(':');
    const detail = at === -1 ? line : line.slice(at + 1).trim();
    return { kind, code: label, detail, text: line };
  };

  if (kind === 'rejected') return { kind, code: 'signature rejected', detail: line, text: line };
  if (kind === 'duplicate') {
    // "ignored: message sim-12 already processed" — the id is the interesting part.
    return { kind, code: 'duplicate ignored', detail: line.replace(/^ignored:\s*/, ''), text: line };
  }
  if (kind === 'withheld') {
    const at = line.indexOf(':');
    return {
      kind,
      code: 'opener withheld',
      detail: at === -1 ? line : line.slice(at + 1).trim(),
      text: line,
    };
  }
  if (kind === 'blocked') return split('blocked');
  if (kind === 'ignored') return split('ignored');
  return { kind, code: 'ok', detail: line, text: line };
}

/**
 * Classifies a log line so the console can colour it.
 *
 * Reading the log rather than instrumenting every call site keeps this one
 * concern in one file: the Receiver stays a Receiver, and nothing in the hot
 * path knows a console exists.
 */
export function classify(line: string): Activity['kind'] {
  if (line.includes('bad signature')) return 'rejected';
  if (line.includes('already processed')) return 'duplicate';
  if (line.startsWith('ignored:')) return 'ignored';
  if (line.includes('withheld')) return 'withheld';
  if (
    line.includes('window has closed') ||
    line.includes('send failed') ||
    line.includes('holding reply')
  ) {
    return 'blocked';
  }
  if (line.includes('→')) return 'turn';
  return 'verified';
}
