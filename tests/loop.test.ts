import { describe, expect, it } from 'vitest';
import { ESCALATION, runTurn } from '../src/agent/loop.ts';
import { ScriptedProvider, type Step } from '../src/agent/provider.ts';
import type { McpClient } from '../src/mcp/client.ts';

/**
 * The loop is tested by scripting the model's trajectory and asserting the loop
 * honoured it. That is the only way to reach the interesting states — budget
 * exhaustion, a failing Tool mid-sequence — reliably, and it keeps the tests
 * about the loop rather than about any particular model's mood.
 *
 * The store is faked here, at the MCP client, so a Tool can be made to fail on
 * demand. The real store is exercised separately in shop.live.test.ts.
 */

const use = (name: string, input: Record<string, unknown> = {}): Step => ({
  kind: 'tool_use',
  id: `call-${name}`,
  name,
  input,
});
const say = (text: string): Step => ({ kind: 'text', text });

/** An MCP client whose every call resolves to whatever the test supplies. */
function fakeMcp(responses: Record<string, unknown>, failing: string[] = []): McpClient {
  return {
    has: () => true,
    discover: async () => Object.keys(responses),
    call: async (tool: string) => {
      if (failing.includes(tool)) {
        return { ok: false as const, error: { kind: 'transport' as const, message: 'store unreachable' } };
      }
      return { ok: true as const, value: responses[tool] ?? {} };
    },
  } as unknown as McpClient;
}

const CATALOG = {
  search_catalog: {
    products: [
      {
        id: 'gid://shopify/Product/1',
        title: 'Vintner Red Blend',
        description: { html: '<p>A bold California red.</p>' },
        price_range: { min: { amount: '29.0', currency: 'USD' }, max: { amount: '29.0', currency: 'USD' } },
      },
    ],
  },
  get_product_details: {
    product: {
      product_id: 'gid://shopify/Product/1',
      title: 'Vintner Red Blend',
      description: 'A bold California red.',
      selectedOrFirstAvailableVariant: { variant_id: 'gid://shopify/ProductVariant/9', price: '29.0' },
    },
  },
  update_cart: {
    cart: {
      id: 'gid://shopify/Cart/abc',
      total_amount: { amount: '49.3', currency: 'USD' },
      subtotal_amount: { amount: '58.0', currency: 'USD' },
      checkout_url: 'https://shop.example/cart/c/abc',
      lines: [],
    },
  },
  search_shop_policies_and_faqs: [{ question: 'Shipping?', answer: 'Two to five business days.' }],
};

const run = (script: Step[][], mcp: McpClient, toolBudget = 3) =>
  runTurn({
    provider: new ScriptedProvider(script),
    system: 'You are a concierge.',
    history: [{ role: 'user', content: 'hello' }],
    context: { mcp },
    toolBudget,
  });

describe('Agent Loop', () => {
  it('answers without a Tool when none is needed', async () => {
    const result = await run([[say('Hey! What are you shopping for?')]], fakeMcp(CATALOG));

    expect(result.reply).toBe('Hey! What are you shopping for?');
    expect(result.trace).toEqual([]);
    expect(result.modelCalls).toBe(1);
    expect(result.escalated).toBe(false);
  });

  it('lets the model choose the Tool, then answers from its result', async () => {
    const result = await run(
      [[use('search_catalog', { query: 'red wine' })], [say('The Vintner Red Blend is $29.')]],
      fakeMcp(CATALOG),
    );

    expect(result.trace.map((t) => t.tool)).toEqual(['search_catalog']);
    expect(result.reply).toContain('Vintner Red Blend');
    expect(result.modelCalls).toBe(2);
  });

  it('carries a multi-step trajectory through to a cart', async () => {
    const result = await run(
      [
        [use('search_catalog', { query: 'red' })],
        [use('add_to_cart', { product_id: 'gid://shopify/Product/1', quantity: 2 })],
        [say('Two bottles are in your cart.')],
      ],
      fakeMcp(CATALOG),
    );

    expect(result.trace.map((t) => t.tool)).toEqual(['search_catalog', 'add_to_cart']);
    expect(result.checkoutUrl).toBe('https://shop.example/cart/c/abc');
    expect(result.escalated).toBe(false);
  });

  /**
   * The store priced this cart: two bottles at $29 total $49.30. The model could
   * not have derived that, and the Tool result says so explicitly so the model
   * can pass the discount on rather than quoting arithmetic it invented.
   */
  it('reports the store’s own total and its discount', async () => {
    const result = await run(
      [[use('add_to_cart', { product_id: 'gid://shopify/Product/1', quantity: 2 })], [say('done')]],
      fakeMcp(CATALOG),
    );

    const cartCall = result.trace.find((t) => t.tool === 'add_to_cart');
    expect(cartCall?.result).toContain('$49.30');
    expect(cartCall?.result).toContain('down from $58.00');
  });

  describe('graceful degradation', () => {
    it('turns a Tool failure into words the model can use, not an exception', async () => {
      const result = await run(
        [[use('search_catalog', { query: 'red' })], [say('I cannot reach the catalog just now.')]],
        fakeMcp(CATALOG, ['search_catalog']),
      );

      expect(result.trace[0]?.ok).toBe(false);
      expect(result.trace[0]?.result).toContain('could not be searched');
      expect(result.reply).toContain('cannot reach the catalog');
    });

    it('passes an empty policy result through instead of inventing one', async () => {
      const result = await run(
        [[use('search_policies', { query: 'wine club' })], [say('I could not find that policy.')]],
        fakeMcp({ ...CATALOG, search_shop_policies_and_faqs: [] }),
      );

      expect(result.trace[0]?.ok).toBe(true);
      expect(result.trace[0]?.result).toContain('publishes nothing');
      expect(result.trace[0]?.result).toContain('rather than guessing');
    });

    it('keeps going after one Tool fails mid-trajectory', async () => {
      const result = await run(
        [
          [use('search_policies', { query: 'shipping' })],
          [use('search_catalog', { query: 'red' })],
          [say('Shipping is unavailable to check, but here is a wine.')],
        ],
        fakeMcp(CATALOG, ['search_shop_policies_and_faqs']),
      );

      expect(result.trace.map((t) => t.ok)).toEqual([false, true]);
      expect(result.escalated).toBe(false);
    });

    it('names an unknown Tool rather than crashing on it', async () => {
      const result = await run([[use('teleport')], [say('ok')]], fakeMcp(CATALOG));

      expect(result.trace[0]?.ok).toBe(false);
      expect(result.trace[0]?.result).toContain('no tool called teleport');
    });
  });

  describe('budget', () => {
    it('escalates when the model never stops calling Tools', async () => {
      const result = await run([[use('search_catalog', { query: 'x' })]], fakeMcp(CATALOG), 3);

      expect(result.trace).toHaveLength(3);
      expect(result.escalated).toBe(true);
      expect(result.reply).toBe(ESCALATION);
    });

    it('never spends more Tool calls than the budget allows', async () => {
      const result = await run([[use('search_catalog', { query: 'x' })]], fakeMcp(CATALOG), 1);
      expect(result.trace).toHaveLength(1);
    });

    it('tells the model how much budget is left, so it can pace itself', async () => {
      const provider = new ScriptedProvider([[use('search_catalog', { query: 'x' })], [say('done')]]);
      await runTurn({
        provider,
        system: 'You are a concierge.',
        history: [{ role: 'user', content: 'hi' }],
        context: { mcp: fakeMcp(CATALOG) },
        toolBudget: 3,
      });

      expect(provider.requests[0]?.system).toContain('Tool calls remaining this turn: 3');
      expect(provider.requests[1]?.system).toContain('Tool calls remaining this turn: 2');
    });

    /**
     * On the last pass the model is offered no Tools at all. Leaving them
     * available would invite a request the loop can only refuse, wasting the one
     * chance it has to answer from what it already learned.
     */
    it('offers no Tools once the budget is spent, forcing an answer', async () => {
      const provider = new ScriptedProvider([
        [use('search_catalog', { query: 'x' })],
        [say('Here is what I found.')],
      ]);
      await runTurn({
        provider,
        system: 'You are a concierge.',
        history: [{ role: 'user', content: 'hi' }],
        context: { mcp: fakeMcp(CATALOG) },
        toolBudget: 1,
      });

      expect(provider.requests[0]?.tools.length).toBeGreaterThan(0);
      expect(provider.requests[1]?.tools).toEqual([]);
    });

    it('escalates rather than sending an empty reply', async () => {
      const result = await run([[say('   ')]], fakeMcp(CATALOG));

      expect(result.reply).toBe(ESCALATION);
      expect(result.escalated).toBe(true);
    });
  });

  it('records every Tool call with its arguments and duration', async () => {
    const result = await run(
      [[use('search_catalog', { query: 'red wine', intent: 'steak dinner' })], [say('ok')]],
      fakeMcp(CATALOG),
    );

    expect(result.trace[0]).toMatchObject({
      tool: 'search_catalog',
      input: { query: 'red wine', intent: 'steak dinner' },
      ok: true,
    });
    expect(result.trace[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});
