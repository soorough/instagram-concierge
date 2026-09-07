import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { recent, reset as resetActivity } from './activity.ts';
import {
  resetDisabledReason,
  simulate,
  simulationDisabledReason,
  type SimulateRequest,
} from './simulate.ts';
import { resetAll, type DB } from '../store/db.ts';

/**
 * A read-only window onto what the Concierge actually did.
 *
 * Outbound sends are gated while the app holds Standard Access, so a reply that
 * is correct, grounded and stored still cannot cross the last hop into
 * Instagram. This renders the Conversation from the database instead, beside the
 * Tool calls that produced each reply — including the Openers that were withheld
 * and never sent at all, which are invisible by definition anywhere else.
 *
 * It reads, with one exception: `/api/simulate` fires a Delivery so the demo can
 * be driven from the browser. That takes the long way round — building, signing
 * and POSTing at our own webhook — so the trust boundary runs in full rather than
 * being stepped over for convenience. It refuses entirely when the dispatcher is
 * live.
 */

const here = dirname(fileURLToPath(import.meta.url));

type MessageRow = { role: 'customer' | 'concierge'; text: string; at: number };
type ToolRow = {
  turn_id: number | null;
  tool: string;
  ok: number;
  duration_ms: number;
  at: number;
  arguments: string;
};
type TurnRow = {
  id: number;
  model_calls: number;
  model_ms: number;
  tool_ms: number;
  escalated: number;
  reply: string;
  at: number;
};
type DecisionRow = { comment_id: string; decision: string; reason: string; at: number };

export type ConsoleDeps = {
  appSecret: string;
  accountId: string;
  mediaId?: string;
  endpoint: string;
  /**
   * The three identities the console has to keep straight, because conflating
   * them is exactly what confused people reading it.
   *
   * `brandName` is who the Concierge speaks as. `accountHandle` is the
   * Instagram account it speaks *through* — the inbox Meta delivers to, which
   * is not the brand and should never be shown as though it were. `tester*` is
   * the Customer on the other end of the demo.
   */
  brandName: string;
  /** Where the brand's rules came from, so a deploy can prove they arrived. */
  brandRules: 'file' | 'env' | 'none';
  accountHandle: string;
  testerHandle: string;
  testerCustomerId: string;
};

export function registerConsole(app: FastifyInstance, db: DB, deps: ConsoleDeps): void {
  app.get('/api/simulate', async () => ({
    enabled: simulationDisabledReason() === undefined,
    reason: simulationDisabledReason() ?? null,
  }));

  app.post('/api/simulate', async (request, reply) => {
    const disabled = simulationDisabledReason();
    if (disabled) return reply.code(409).send({ error: disabled });

    /**
     * The Receiver registers a raw-Buffer parser for application/json, because a
     * signature must be checked against the exact bytes Meta hashed. Fastify
     * content-type parsers are per-instance, so that applies here too and this
     * route parses its own body.
     *
     * The alternative — parsing globally and stashing the raw bytes on the
     * request — would mean parsing untrusted input before the signature is
     * checked. Cheaper, and it gives up the ordering the trust boundary is built
     * on. Not worth it for a console.
     */
    const body = parseBody(request.body);
    if (!body?.kind) return reply.code(400).send({ error: 'kind is required' });

    return simulate(body, deps);
  });

  /** Who is who, so the page does not hardcode a handle it cannot see change. */
  /**
   * Liveness, for the platform's healthcheck.
   *
   * Reports what a deploy most often gets wrong rather than a bare `ok`: whether
   * the store was reachable at boot and whether outbound is recording or live.
   * A deploy that is "up" with an unreachable store is the failure that looks
   * like success.
   */
  app.get('/api/health', async () => ({
    ok: true,
    dispatch: process.env.DISPATCH === 'live' ? 'live' : 'recording',
    simulation: simulationDisabledReason() === undefined,
    // 'none' means the shipping restriction is not in force. Visible, not silent.
    brandRules: deps.brandRules,
  }));

  app.get('/api/identity', async () => ({
    brandName: deps.brandName,
    accountHandle: deps.accountHandle,
    testerHandle: deps.testerHandle,
    testerCustomerId: deps.testerCustomerId,
  }));

  app.get('/api/reset', async () => ({
    enabled: resetDisabledReason() === undefined,
    reason: resetDisabledReason() ?? null,
  }));

  /**
   * Clears every Conversation, Turn, Tool call and Opener decision, so a demo
   * starts from nothing rather than from the last run's scrollback.
   *
   * Refused while the dispatcher is live. `opener_decision` is the permanent
   * record that a comment has spent its one Private Reply, and handing that
   * allowance back to a system that really sends would DM someone a second
   * time. The read-only nature of the rest of this console is why the guard
   * lives here rather than being left to whoever clicks.
   */
  app.post('/api/reset', async (_request, reply) => {
    const disabled = resetDisabledReason();
    if (disabled) return reply.code(409).send({ error: disabled });

    resetAll(db);
    // The ledger is part of "everything" — leaving it would show a receiver
    // busy with Conversations that no longer exist.
    resetActivity();
    return { cleared: true };
  });

  /**
   * The page is read from disk on every request and told not to be cached.
   *
   * Without that header a browser caches it heuristically, and a deploy that
   * changes the console silently does not reach anyone who has opened it
   * before — they keep running the previous build against the current server.
   * That is a confusing failure to be on the wrong side of: the password is
   * right, the API is right, and the page still behaves as though neither is,
   * because the page is older than both. It cost a round of debugging here.
   *
   * It is one small HTML document on a demo console, so re-reading it per
   * request costs nothing worth measuring.
   */
  /**
   * The console's compiled client.
   *
   * `here` is the directory of *this* module, which is `dist/console` in a build
   * and `src/console` under tsx. The compiler only emits into `dist`, so the
   * development path looks there explicitly rather than pretending the file
   * sits next to the source it came from.
   */
  app.get('/client.js', async (_req, reply) => {
    const compiled = join(here, 'client.js');
    const path = existsSync(compiled) ? compiled : join(here, '../../dist/console/client.js');

    if (!existsSync(path)) {
      // Says what to do rather than 404-ing into a blank page.
      return reply.code(503).type('text/plain').send('console client not built — run `npm run build`');
    }
    return reply
      .type('text/javascript')
      .header('cache-control', 'no-store, must-revalidate')
      .send(readFileSync(path, 'utf8'));
  });

  app.get('/', async (_req, reply) =>
    reply
      .type('text/html')
      .header('cache-control', 'no-store, must-revalidate')
      .send(readFileSync(join(here, 'index.html'), 'utf8')),
  );

  app.get('/api/activity', async () => recent());

  app.get('/api/threads', async () => {
    const rows = db
      .prepare(
        `select c.customer_id, c.username, c.last_seen_at,
                (select count(*) from message m where m.customer_id = c.customer_id) as messages
         from conversation c
         order by c.last_seen_at desc`,
      )
      .all() as { customer_id: string; username: string | null; last_seen_at: number; messages: number }[];

    return rows.map((r) => ({
      customerId: r.customer_id,
      username: r.username,
      lastSeenAt: r.last_seen_at,
      messages: r.messages,
    }));
  });

  /** Withheld Openers never became a Conversation, so they are listed separately. */
  app.get('/api/withheld', async () =>
    (
      db
        .prepare(
          `select comment_id, decision, reason, at from opener_decision
           where decision = 'withhold' order by at desc limit 20`,
        )
        .all() as DecisionRow[]
    ).map((r) => ({ commentId: r.comment_id, reason: r.reason, at: r.at })),
  );

  app.get('/api/threads/:customerId', async (request) => {
    const { customerId } = request.params as { customerId: string };

    const messages = db
      .prepare('select role, text, at from message where customer_id = ? order by at, id')
      .all(customerId) as MessageRow[];

    const tools = db
      .prepare(
        'select turn_id, tool, ok, duration_ms, at, arguments from tool_call where customer_id = ? order by at, id',
      )
      .all(customerId) as ToolRow[];

    const turns = db
      .prepare(
        `select id, model_calls, model_ms, tool_ms, escalated, reply, at
         from turn where customer_id = ? order by at, id`,
      )
      .all(customerId) as TurnRow[];

    /**
     * A Turn is a row now, so each reply carries its own Tool calls by
     * foreign key rather than by guessing from timestamps. Matching a stored
     * reply to its Turn is by text, which is exact here because the reply is
     * written from the Turn that produced it.
     */
    const withTrace = messages.map((m) => {
      if (m.role !== 'concierge') return { ...m, trace: [] as ToolRow[], stats: undefined };
      const turn = turns.find((t) => t.reply === m.text);
      return {
        ...m,
        trace: turn ? tools.filter((t) => t.turn_id === turn.id) : [],
        stats: turn
          ? {
              modelCalls: turn.model_calls,
              modelMs: turn.model_ms,
              toolMs: turn.tool_ms,
              escalated: turn.escalated === 1,
            }
          : undefined,
      };
    });

    return {
      customerId,
      username: (
        db.prepare('select username from conversation where customer_id = ?').get(customerId) as
          | { username: string | null }
          | undefined
      )?.username,
      messages: withTrace.map((m) => ({
        role: m.role,
        text: m.text,
        at: m.at,
        stats: m.stats,
        trace: m.trace.map((t) => ({
          tool: t.tool,
          ok: t.ok === 1,
          ms: t.duration_ms,
          args: safeParse(t.arguments),
        })),
      })),
    };
  });
}

function parseBody(raw: unknown): SimulateRequest | undefined {
  if (Buffer.isBuffer(raw)) {
    try {
      return JSON.parse(raw.toString('utf8')) as SimulateRequest;
    } catch {
      return undefined;
    }
  }
  return raw as SimulateRequest | undefined;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}
