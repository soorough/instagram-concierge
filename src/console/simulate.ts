import { buildDelivery, sign } from '../replay/payload.ts';

/**
 * Lets the console fire a Delivery, so the demo can be driven from the browser
 * instead of a second terminal.
 *
 * It takes the long way round on purpose. Rather than calling the Concierge
 * directly, it builds the bytes, signs them with the real app secret, and POSTs
 * them over real HTTP at our own `/webhooks/instagram`. Everything then runs
 * exactly as it would for Meta: signature verification, the Brand Account
 * assertion, echo filtering, the idempotency claim. A console that called
 * `handle(event)` directly would be a demo of a different system to the one
 * being described.
 *
 * Refused when the dispatcher is live. Simulating inbound events into a system
 * that really sends messages would put fabricated conversations in front of real
 * people, and no demo is worth that.
 */

export type SimulateRequest = {
  kind: 'message' | 'comment' | 'forged';
  text?: string;
  eventId?: string;
  customerId?: string;
  username?: string;
  /**
   * How far in the past to date the Event, in hours.
   *
   * The only way to demonstrate the platform's two clocks. A Conversation's
   * `last_seen_at` is written from the Event's timestamp and the opener policy
   * reads the comment's, so an aged Delivery closes the 24-hour reply window or
   * the 7-day comment window through the ordinary path — no endpoint that
   * reaches into the database, and no branch in the Concierge that exists only
   * for demos.
   */
  ageHours?: number;
};

export type SimulateResult = {
  ok: boolean;
  status: number;
  body: string;
  eventId: string;
  /** What was sent, so the console can show the bytes if asked. */
  sent: string;
};

export type SimulateDeps = {
  appSecret: string;
  accountId: string;
  mediaId?: string;
  endpoint: string;
};

export function simulationDisabledReason(): string | undefined {
  return process.env.DISPATCH === 'live'
    ? 'simulation is disabled while DISPATCH=live — it would send fabricated conversations to real people'
    : undefined;
}

/**
 * Clearing history is refused for the same reason simulating is, but the stake
 * is different and worse.
 *
 * `opener_decision` is the permanent record that a comment has already spent
 * its one Private Reply. Wiping it against a live dispatcher does not replay a
 * demo — it hands back an allowance that the platform grants exactly once, and
 * the next comment webhook sends a second DM to someone who commented once.
 * There is no way to take that back.
 */
export function resetDisabledReason(): string | undefined {
  return process.env.DISPATCH === 'live'
    ? 'clearing history is disabled while DISPATCH=live — it would hand back Openers that have already been spent'
    : undefined;
}

export async function simulate(
  request: SimulateRequest,
  deps: SimulateDeps,
): Promise<SimulateResult> {
  const eventId = request.eventId?.trim() || `sim-${Date.now()}`;

  /**
   * A deliberately invalid signature, so the boundary can be demonstrated. It is
   * the only case that does not sign correctly, and it exists precisely to be
   * rejected.
   */
  const forged = request.kind === 'forged';
  const age = Number(request.ageHours);
  const at = Number.isFinite(age) && age > 0 ? Date.now() - age * 60 * 60 * 1000 : undefined;

  const body = forged
    ? JSON.stringify({ object: 'instagram', entry: [] })
    : buildDelivery({
        kind: request.kind === 'comment' ? 'comment' : 'message',
        text: request.text ?? '',
        eventId,
        customerId: request.customerId?.trim() || 'console-customer',
        ...(request.username ? { username: request.username } : {}),
        accountId: deps.accountId,
        ...(deps.mediaId ? { mediaId: deps.mediaId } : {}),
        ...(at !== undefined ? { at } : {}),
      });

  const signature = forged ? `sha256=${'0'.repeat(64)}` : sign(body, deps.appSecret);

  const response = await fetch(deps.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body,
  });

  return {
    ok: response.ok,
    status: response.status,
    body: await response.text(),
    eventId,
    sent: body,
  };
}
