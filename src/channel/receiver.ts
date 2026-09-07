import Fastify, { type FastifyInstance } from 'fastify';
import type { DB } from '../store/db.ts';
import { claimEvent } from '../store/events.ts';
import { parseDelivery, type InboundEvent } from './parse.ts';
import { verifySignature } from './signature.ts';

export type ReceiverOptions = {
  db: DB;
  appSecret: string;
  verifyToken: string;
  /** Every identifier that means "our Brand Account". */
  accountIds: readonly string[];
  /**
   * Called once per Event that survived verification and was claimed. It is
   * invoked after the response is sent, so a slow Turn cannot delay the
   * acknowledgement.
   */
  onEvent: (event: InboundEvent) => void | Promise<void>;
  log?: (line: string) => void;
};

/**
 * The Receiver: the only way into this system, and the whole trust boundary.
 *
 * Order matters here, and every step earns its place.
 *
 *   1. Verify the signature over the raw bytes. Fastify would happily parse the
 *      body first, but re-serialising parsed JSON does not reproduce what Meta
 *      hashed, so the raw buffer is preserved and parsing happens after.
 *   2. Assert the Brand Account. A valid signature proves Meta sent this; it
 *      does not prove whose account it concerns, since one app secret signs
 *      every surface on the app. Skipping this is the difference between
 *      "authenticated" and "authorised".
 *   3. Claim each Event. Meta redelivers, and a duplicate must not produce a
 *      second reply.
 *   4. Acknowledge, then work. A slow 200 is precisely what triggers the retry
 *      the claim in step 3 exists to absorb.
 *
 * Identity comes from this pipeline and from nowhere else. Nothing downstream
 * reads a name out of message text, because a Customer can type anything.
 */
export function buildReceiver(options: ReceiverOptions): FastifyInstance {
  const log = options.log ?? (() => {});
  const app = Fastify({ logger: false });

  // Keep the exact bytes Meta signed. Without this the signature can never match.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  /** Meta's subscription handshake. Proves we control the callback URL. */
  app.get('/webhooks/instagram', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    if (
      query['hub.mode'] === 'subscribe' &&
      query['hub.verify_token'] === options.verifyToken &&
      query['hub.challenge']
    ) {
      return reply.code(200).type('text/plain').send(query['hub.challenge']);
    }
    return reply.code(403).send('forbidden');
  });

  app.post('/webhooks/instagram', async (request, reply) => {
    const raw = request.body as Buffer;
    const signature = request.headers['x-hub-signature-256'];

    if (!verifySignature(raw, typeof signature === 'string' ? signature : undefined, options.appSecret)) {
      log('delivery rejected: bad signature');
      return reply.code(403).send({ error: 'bad signature' });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      log('delivery rejected: body is not JSON');
      return reply.code(400).send({ error: 'malformed body' });
    }

    const { events, ignored } = parseDelivery(payload, options.accountIds);
    for (const reason of ignored) log(`ignored: ${reason}`);

    /**
     * Claim before acknowledging. If the process dies between the 200 and the
     * work, that Event is lost — deliberately. The alternative is claiming after
     * the work, which turns every crash into a duplicate reply, and duplicates
     * are the failure Customers actually notice.
     */
    const claimed = events.filter((event) => {
      const first = claimEvent(options.db, event.eventId, event.kind);
      if (!first) log(`ignored: ${event.kind} ${event.eventId} already processed`);
      return first;
    });

    // Acknowledge now; the Turn runs afterwards.
    void reply.code(200).send({ received: events.length, accepted: claimed.length });

    for (const event of claimed) {
      try {
        await options.onEvent(event);
      } catch (error) {
        // A failed Turn must not surface as a non-200, or Meta redelivers an
        // Event we have already claimed and will therefore refuse to retry.
        log(`turn failed for ${event.kind} ${event.eventId}: ${(error as Error).message}`);
      }
    }
  });

  return app;
}
