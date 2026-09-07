import { AnthropicProvider } from './agent/anthropic.ts';
import { GraphEnricher, NoEnricher } from './channel/enrich.ts';
import { buildReceiver } from './channel/receiver.ts';
import { describeLine, note } from './console/activity.ts';
import { registerGate } from './console/gate.ts';
import { registerConsole } from './console/routes.ts';
import {
  InstagramDispatcher,
  RecordingDispatcher,
  type Dispatcher,
} from './channel/dispatcher.ts';
import { brandAccountIds, config } from './config.ts';
import { loadBrand } from './config/brand.ts';
import { createConcierge } from './concierge.ts';
import { McpClient } from './mcp/client.ts';
import { getDb } from './store/db.ts';

/**
 * Wiring, and nothing else. Every decision worth defending lives in the module
 * that owns it; this file only chooses implementations and starts listening.
 */

const log = (line: string) => {
  console.log(`[concierge] ${line}`);
  note(describeLine(line));
};

/**
 * Outbound is gated while the app holds Standard Access, so recording is the
 * default and sending is opt-in. The alternative — attempt sends and swallow the
 * failures — produces a demo that looks like it works and quietly does not.
 * DISPATCH=live turns it on the day Advanced Access exists.
 */
function chooseDispatcher(): Dispatcher {
  if (process.env.DISPATCH === 'live') {
    log('dispatcher: live — replies will be sent to Instagram');
    return new InstagramDispatcher(config.igAccessToken());
  }
  log('dispatcher: recording — replies are logged, not sent (set DISPATCH=live to send)');
  return new RecordingDispatcher();
}

const db = getDb();
const mcp = new McpClient(config.shopDomain());

/**
 * Rules from the operator. `config/brand.json` separates the brand's voice from
 * the shipping restriction, because the latter is data with a correct answer
 * rather than a matter of tone. `BRAND_INSTRUCTIONS` still overrides it.
 */
const brand = loadBrand();
log(
  brand.source === 'none'
    ? `brand ${brand.name}: NO RULES LOADED — config/brand.json not found and BRAND_INSTRUCTIONS unset. ` +
        'The shipping restriction is not in force.'
    : `brand ${brand.name}: rules from ${brand.source === 'file' ? 'config/brand.json' : 'BRAND_INSTRUCTIONS'}`,
);

const handle = createConcierge({
  db,
  mcp,
  provider: new AnthropicProvider(config.anthropicKey()),
  dispatcher: chooseDispatcher(),
  // Reading the post works on Standard Access; reading a commenter's profile
  // does not, and the opener is written to expect that.
  enricher: process.env.IG_ACCESS_TOKEN
    ? new GraphEnricher(config.igAccessToken())
    : new NoEnricher(),
  brandName: brand.name,
  ...(brand.instructions ? { brandInstructions: brand.instructions } : {}),
  brandAccountIds: brandAccountIds(),
  toolBudget: config.toolBudget(),
  log,
});

const app = buildReceiver({
  db,
  appSecret: config.igAppSecret(),
  verifyToken: config.verifyToken(),
  accountIds: brandAccountIds(),
  log,
  onEvent: async (event) => {
    const started = Date.now();
    const result = await handle(event);
    const total = Date.now() - started;
    const t = 'turn' in result ? result.turn : undefined;
    const breakdown = t
      ? ` (model ${t.modelMs}ms × ${t.modelCalls}, tools ${t.toolMs}ms, other ${total - t.modelMs - t.toolMs}ms)`
      : '';
    log(`${event.kind} ${event.eventId} → ${result.outcome} in ${total}ms${breakdown}`);
    if (result.outcome === 'withheld') log(`  reason: ${result.reason}`);
    if (result.outcome === 'replied' || result.outcome === 'opened') log(`  "${result.text}"`);
  },
});

/**
 * The console, including its ability to fire a Delivery at us. It posts to our
 * own public endpoint rather than calling inward, so what it triggers is
 * indistinguishable from what Meta triggers.
 */
/**
 * The gate goes on before the console's routes, so an unauthorised request is
 * refused without any of them running. The webhook is deliberately outside it —
 * it authenticates with a signature, which is stronger.
 */
await registerGate(app);

registerConsole(app, db, {
  appSecret: config.igAppSecret(),
  accountId: process.env.IG_ACCOUNT_ID ?? '0',
  ...(process.env.IG_MEDIA_ID ? { mediaId: process.env.IG_MEDIA_ID } : {}),
  endpoint: `http://127.0.0.1:${config.port()}/webhooks/instagram`,
  brandName: brand.name,
  brandRules: brand.source,
  accountHandle: process.env.IG_ACCOUNT_HANDLE ?? 'daakiyah',
  testerHandle: process.env.IG_TESTER_HANDLE ?? 'slittone',
  testerCustomerId: process.env.IG_TESTER_ID ?? 'slittone-1',
});

/**
 * Listen before talking to anyone else.
 *
 * Tool discovery used to run first, which put a third party's network call
 * between boot and the open port — and a platform healthcheck cannot tell that
 * apart from a hang. The container was killed before it ever listened, and
 * because the kill is a signal rather than an exception, the logs showed a
 * restart loop with no error in it at all.
 *
 * So the port opens first and discovery follows. Nothing is lost by the gap:
 * `McpClient.has()` treats "not yet discovered" as optimistic, so a turn
 * arriving in that window is offered every tool and any failure reaches the
 * customer as words — which is the same behaviour as an unreachable store.
 */
await app.listen({ port: config.port(), host: '0.0.0.0' });
log(`listening on :${config.port()}`);

void mcp
  .discover()
  .then((tools) =>
    log(`store ${config.shopDomain()} offers: ${tools.join(', ') || '(nothing — is it reachable?)'}`),
  )
  .catch((error: unknown) =>
    log(`store ${config.shopDomain()} could not be reached at boot: ${(error as Error).message}`),
  );
log(`conversations at http://localhost:${config.port()}/`);
