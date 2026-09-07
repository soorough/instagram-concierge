import { AnthropicProvider } from '../agent/anthropic.ts';
import { runTurn, type TurnResult } from '../agent/loop.ts';
import { openerPrompt, systemPrompt } from '../agent/prompt.ts';
import type { Turn } from '../agent/provider.ts';
import type { InboundComment } from '../channel/parse.ts';
import { config } from '../config.ts';
import { McpClient } from '../mcp/client.ts';
import { CASES, type EvalCase } from './cases.ts';

/**
 * Runs the suite against the real model and a real store.
 *
 * Deliberately not part of `npm test`: it costs money, needs the network, and is
 * non-deterministic in wording — three properties that would make the fast suite
 * worse. It is what you run after changing a prompt, a tool description, or the
 * model, because those are the changes unit tests cannot see.
 *
 *   npm run evals                              the configured store
 *   npm run evals -- cart                      one case
 *   SHOPIFY_STORE_DOMAIN=x.com npm run evals   another store
 *
 * Capability is per-store: one storefront tested serves only policy search. A
 * case that needs a catalog is skipped there rather than failed, because a store
 * without a catalog is a different shape, not a broken agent.
 */

const BRAND = process.env.BRAND_NAME ?? 'ONEHOPE';
const UNREACHABLE = 'store-that-does-not-exist.invalid';

const comment = (text: string): InboundComment => ({
  kind: 'comment',
  eventId: 'eval-comment',
  customerId: 'eval-customer',
  username: 'slittone',
  text,
  mediaId: process.env.IG_MEDIA_ID ?? '',
  mediaProductType: 'FEED',
  at: Date.now(),
});

/** Runs every input in order, threading history and cart as a real Conversation would. */
async function runCase(kase: EvalCase, mcp: McpClient): Promise<TurnResult[]> {
  const provider = new AnthropicProvider(config.anthropicKey());
  const system =
    kase.kind === 'comment'
      ? openerPrompt(BRAND, comment(kase.commentText ?? ''))
      : systemPrompt(BRAND);

  const history: Turn[] = [];
  const results: TurnResult[] = [];
  let cartId: string | undefined;

  for (const input of kase.inputs) {
    const content =
      kase.kind === 'comment' ? `They commented: "${kase.commentText}". Write the opener.` : input;

    const turn = await runTurn({
      provider,
      system,
      history: [...history, { role: 'user', content }],
      context: { mcp, ...(cartId ? { cartId } : {}) },
      toolBudget: config.toolBudget(),
    });

    results.push(turn);
    cartId = turn.cartId ?? cartId;
    history.push({ role: 'user', content }, { role: 'assistant', steps: [{ kind: 'text', text: turn.reply }] });
  }

  return results;
}

async function main(): Promise<void> {
  const filter = process.argv[2];
  const cases = filter ? CASES.filter((c) => c.id.includes(filter)) : CASES;

  const domain = config.shopDomain();
  const mcp = new McpClient(domain);
  const available = await mcp.discover();

  // A store that serves nothing at all is a setup problem, not a result.
  if (available.length === 0) {
    console.error(`${domain} serves no MCP tools — check the domain`);
    process.exit(1);
  }

  const offlineMcp = new McpClient(UNREACHABLE, 4_000);
  await offlineMcp.discover();

  console.log(`\n${BRAND} · ${domain}`);
  console.log(`${available.length} tools · budget ${config.toolBudget()} · ${cases.length} case(s)\n`);

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const latencies: number[] = [];

  /**
   * A pause between cases. The storefront MCP is called anonymously, the tier
   * Shopify rate-limits hardest, and a dozen cases back to back is a burst no
   * real conversation produces.
   */
  const pauseMs = Number(process.env.EVAL_PAUSE_MS ?? 2000);

  for (const [index, kase] of cases.entries()) {
    const missing = (kase.requires ?? []).filter((t) => !mcp.has(t));
    if (missing.length > 0) {
      console.log(`⊘ ${kase.id.padEnd(14)} skipped — this store has no ${missing.join(', ')}`);
      skipped += 1;
      continue;
    }

    if (index > 0) await new Promise((r) => setTimeout(r, pauseMs));

    const started = Date.now();
    let turns: TurnResult[];
    try {
      turns = await runCase(kase, kase.offline ? offlineMcp : mcp);
    } catch (error) {
      console.log(`✗ ${kase.id.padEnd(14)} threw: ${(error as Error).message}\n`);
      failed += 1;
      continue;
    }

    const elapsed = Date.now() - started;
    latencies.push(elapsed);

    const turn = turns.at(-1)!;
    const failures = kase.checks
      .map((check) => ({ name: check.name, reason: check.run({ turn, turns }) }))
      .filter((r) => r.reason !== undefined);

    const tools = turns.flatMap((t) => t.trace.map((c) => c.tool));
    console.log(
      `${failures.length === 0 ? '✓' : '✗'} ${kase.id.padEnd(14)} ${String(elapsed).padStart(5)}ms  ` +
        `[${tools.join(' → ') || 'no tools'}]`,
    );
    console.log(`    "${turn.reply.replace(/\n/g, ' ').slice(0, 120)}"`);
    for (const f of failures) console.log(`    ✗ ${f.name}: ${f.reason}`);
    console.log();

    if (failures.length === 0) passed += 1;
    else failed += 1;
  }

  const sorted = latencies.sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  console.log(
    `${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''} — median ${median}ms`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

void main();
