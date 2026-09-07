import { readFileSync } from 'node:fs';
import { config } from '../config.ts';
import { ageToTimestamp, buildDelivery, sign } from './payload.ts';

/**
 * Replay: how this system is driven while the app holds Standard Access.
 *
 * It is not a mock. Each Fixture is a Delivery Meta actually sent, and this
 * signs the bytes it POSTs with the real Instagram app secret, over real HTTP,
 * at the real Receiver. The Receiver cannot tell the difference and is given no
 * opportunity to: signature verification, the Brand Account assertion,
 * idempotency and parsing all run exactly as they would in production.
 *
 * What Replay substitutes is the *contents* of an Event — the sender, the text,
 * the comment id — so a Fixture full of Meta's placeholders becomes the real
 * post and comment on the test account. See the README's "Honest limits".
 *
 *   npm run replay -- message "do you have anything for a steak dinner?"
 *   npm run replay -- comment "obsessed with this colorway 😍" --id comment-42
 *   npm run replay -- message "still there?" --age-hours 25    # closes the 24h window
 *   npm run replay -- comment "still in stock?" --age-hours 192 # closes the 7d window
 *   npm run replay -- raw fixtures/meta-messages.json
 */

type Args = {
  kind: 'message' | 'comment' | 'raw';
  text: string;
  eventId: string;
  customerId: string;
  username: string;
  target: string;
  /** Epoch ms for the Event, when `--age-hours` dated it in the past. */
  at?: number;
};

function parseArgs(argv: string[]): Args {
  const [kind = 'message', ...rest] = argv;
  const flags = new Map<string, string>();
  const words: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (token.startsWith('--')) {
      flags.set(token.slice(2), rest[++i] ?? '');
    } else {
      words.push(token);
    }
  }

  const stamp = Date.now();
  return {
    kind: kind as Args['kind'],
    text: words.join(' ') || 'hello',
    eventId: flags.get('id') ?? `replay-${stamp}`,
    /**
     * Defaults to the configured tester account, so a bare `npm run replay`
     * continues the demo conversation rather than creating a stray thread — it
     * used to invent "replay-customer-1", mid-demo. Reading it from the
     * environment keeps one account name in one place instead of hardcoding a
     * handle that appears on screen.
     */
    customerId: flags.get('from') ?? process.env.IG_TESTER_ID ?? 'tester',
    username: flags.get('username') ?? process.env.IG_TESTER_HANDLE ?? 'tester',
    target: flags.get('url') ?? `http://127.0.0.1:${config.port()}/webhooks/instagram`,
    /**
     * Dates the Event in the past, so the platform's two clocks can be reached
     * from here as well as from the console. `--age-hours 25` closes the
     * 24-hour reply window; `--age-hours 192` closes the 7-day comment window.
     */
    ...(ageToTimestamp(flags.get('age-hours')) !== undefined
      ? { at: ageToTimestamp(flags.get('age-hours'))! }
      : {}),
  };
}

function buildBody(args: Args): string {
  if (args.kind === 'raw') {
    const fixture = JSON.parse(readFileSync(args.text, 'utf8')) as { body: string };
    return fixture.body;
  }

  return buildDelivery({
    kind: args.kind,
    text: args.text,
    eventId: args.eventId,
    customerId: args.customerId,
    username: args.username,
    accountId: process.env.IG_ACCOUNT_ID ?? '0',
    ...(process.env.IG_MEDIA_ID ? { mediaId: process.env.IG_MEDIA_ID } : {}),
    ...(args.at !== undefined ? { at: args.at } : {}),
  });
}

const args = parseArgs(process.argv.slice(2));
const body = buildBody(args);

// Signed with the real secret, so the Receiver's verification is genuinely
// exercised rather than bypassed for convenience.
const signature = sign(body, config.igAppSecret());

const response = await fetch(args.target, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
  body,
});

console.log(`→ ${args.kind} ${args.eventId}`);
console.log(`← ${response.status} ${await response.text()}`);
