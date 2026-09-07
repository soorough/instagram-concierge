import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createConcierge } from '../src/concierge.ts';
import { ScriptedProvider, type Step } from '../src/agent/provider.ts';
import { RecordingDispatcher } from '../src/channel/dispatcher.ts';
import type { InboundComment, InboundMessage } from '../src/channel/parse.ts';
import type { McpClient } from '../src/mcp/client.ts';
import { NoEnricher, type Enricher, type Enrichment } from '../src/channel/enrich.ts';
import { historyFor, REPLY_WINDOW_MS } from '../src/store/conversation.ts';
import { decisionsFor } from '../src/opener/policy.ts';
import { migrate, type DB } from '../src/store/db.ts';

/**
 * End-to-end through the Concierge: an Event in, a recorded send out. The model
 * and the store are scripted so the assertions are about what the system chose
 * to do, not about what a model happened to say.
 */

const BRAND = ['17841400000000000'];

const say = (text: string): Step => ({ kind: 'text', text });
const use = (name: string, input: Record<string, unknown> = {}): Step => ({
  kind: 'tool_use',
  id: `c-${name}`,
  name,
  input,
});

const mcp = {
  has: () => true,
  discover: async () => [],
  call: async () => ({
    ok: true as const,
    value: {
      products: [
        {
          id: 'gid://shopify/Product/1',
          title: 'Field to Table Red Blend',
          description: { html: 'A Central Coast red.' },
          price_range: { min: { amount: '29.0', currency: 'USD' } },
        },
      ],
    },
  }),
} as unknown as McpClient;

const message = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  kind: 'message',
  eventId: 'mid-1',
  customerId: 'customer-1',
  text: 'do you have anything for a steak dinner?',
  at: Date.now(),
  ...over,
});

const comment = (over: Partial<InboundComment> = {}): InboundComment => ({
  kind: 'comment',
  eventId: 'comment-1',
  customerId: 'customer-2',
  username: 'maya.runs',
  text: 'obsessed with this colorway 😍 is it still available?',
  mediaId: 'media-1',
  mediaProductType: 'FEED',
  at: Date.now(),
  ...over,
});

describe('Concierge', () => {
  let db: DB;
  let dispatcher: RecordingDispatcher;

  const build = (script: Step[][]) =>
    createConcierge({
      db,
      mcp,
      provider: new ScriptedProvider(script),
      dispatcher,
      enricher: new NoEnricher(),
      brandName: 'ONEHOPE',
      brandAccountIds: BRAND,
      toolBudget: 3,
    });

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    dispatcher = new RecordingDispatcher();
  });

  describe('messages', () => {
    it('replies in the thread and records both sides', async () => {
      const handle = build([[say('We have a lovely Central Coast red.')]]);
      const result = await handle(message());

      expect(result.outcome).toBe('replied');
      expect(dispatcher.sent).toEqual([
        { to: 'customer-1', kind: 'message', text: 'We have a lovely Central Coast red.' },
      ]);
      expect(historyFor(db, 'customer-1')).toHaveLength(2);
    });

    it('carries the Conversation across separate Events', async () => {
      await build([[say('First reply.')]])(message({ eventId: 'mid-1', text: 'hello' }));
      const provider = new ScriptedProvider([[say('Second reply.')]]);

      await createConcierge({
        db,
        mcp,
        provider,
        dispatcher,
        enricher: new NoEnricher(),
        brandName: 'ONEHOPE',
        brandAccountIds: BRAND,
        toolBudget: 3,
      })(message({ eventId: 'mid-2', text: 'and the other one?' }));

      // The second Turn saw the first exchange, so the thread reads continuously.
      const turns = provider.requests[0]?.turns ?? [];
      expect(turns.map((t) => ('content' in t ? t.content : 'assistant'))).toEqual([
        'hello',
        'assistant',
        'and the other one?',
      ]);
    });

    it('records the Tool trajectory behind a reply', async () => {
      const handle = build([[use('search_catalog', { query: 'red' })], [say('Here you go.')]]);
      await handle(message());

      const calls = db.prepare('select tool, ok from tool_call').all() as {
        tool: string;
        ok: number;
      }[];
      expect(calls).toEqual([{ tool: 'search_catalog', ok: 1 }]);
    });

    it('does not store a reply it failed to send', async () => {
      const failing = {
        sendMessage: async () => ({ ok: false as const, reason: 'gated', retryable: false }),
        sendPrivateReply: async () => ({ ok: false as const, reason: 'gated', retryable: false }),
      };
      const handle = createConcierge({
        db,
        mcp,
        provider: new ScriptedProvider([[say('never arrives')]]),
        dispatcher: failing,
        enricher: new NoEnricher(),
        brandName: 'ONEHOPE',
        brandAccountIds: BRAND,
        toolBudget: 3,
      });

      const result = await handle(message());

      expect(result).toMatchObject({ outcome: 'send_failed', reason: 'gated' });
      // Only the Customer's message is stored; claiming we replied would be a lie.
      expect(historyFor(db, 'customer-1')).toHaveLength(1);
    });
  });

  describe('comment to Opener', () => {
    it('sends one Opener as a Private Reply addressed by comment', async () => {
      const handle = build([[say('Hey Maya! It is still in stock — trail or road?')]]);
      const result = await handle(comment());

      expect(result.outcome).toBe('opened');
      expect(dispatcher.sent).toEqual([
        {
          to: 'comment-1',
          kind: 'private_reply',
          text: 'Hey Maya! It is still in stock — trail or road?',
        },
      ]);
    });

    it('seeds the Conversation so their reply continues the thread', async () => {
      await build([[say('Hey Maya!')]])(comment());

      const history = historyFor(db, 'customer-2');
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({ role: 'user' });
    });

    it('gives the model only what the comment carried', async () => {
      const provider = new ScriptedProvider([[say('hi')]]);
      await createConcierge({
        db,
        mcp,
        provider,
        dispatcher,
        enricher: new NoEnricher(),
        brandName: 'ONEHOPE',
        brandAccountIds: BRAND,
        toolBudget: 3,
      })(comment());

      const system = provider.requests[0]?.system ?? '';
      expect(system).toContain('@maya.runs');
      expect(system).toContain('obsessed with this colorway');
      // Follow status is consent-gated and unavailable at this moment. The prompt
      // must say so rather than let the model imply familiarity it lacks.
      expect(system).toContain('could not be read');
      expect(system).not.toContain('They already follow');
    });

    it('withholds and sends nothing when the comment has no words', async () => {
      const result = await build([[say('should never send')]])(comment({ text: '🔥🔥' }));

      expect(result).toMatchObject({ outcome: 'withheld' });
      expect(dispatcher.sent).toEqual([]);
      expect(decisionsFor(db, 'comment-1')).toMatchObject({ decision: 'withhold' });
    });

    /**
     * The platform grants one Private Reply per comment, permanently. A
     * redelivery, a restart or a replay must not produce a second.
     */
    it('never sends a second Opener for the same comment', async () => {
      const handle = build([[say('Hey Maya!')]]);
      await handle(comment());
      const second = await handle(comment());

      expect(second).toMatchObject({ outcome: 'withheld', reason: expect.stringContaining('already') });
      expect(dispatcher.sent).toHaveLength(1);
    });

    it('does not open a second conversation with someone already talking to us', async () => {
      await build([[say('reply')]])(message({ customerId: 'customer-2' }));
      dispatcher.sent.length = 0;

      const result = await build([[say('should never send')]])(comment());

      expect(result).toMatchObject({
        outcome: 'withheld',
        reason: expect.stringContaining('already has an open conversation'),
      });
      expect(dispatcher.sent).toEqual([]);
    });

    it('records the decision even when the send is refused by the platform', async () => {
      const handle = createConcierge({
        db,
        mcp,
        provider: new ScriptedProvider([[say('hi')]]),
        dispatcher: {
          sendMessage: async () => ({ ok: false as const, reason: 'x', retryable: false }),
          sendPrivateReply: async () => ({
            ok: false as const,
            reason: 'subcode 2534066',
            retryable: false,
          }),
        },
        enricher: new NoEnricher(),
        brandName: 'ONEHOPE',
        brandAccountIds: BRAND,
        toolBudget: 3,
      });

      const result = await handle(comment());

      expect(result).toMatchObject({ outcome: 'send_failed' });
      // The allowance is spent either way — the decision was made, so retrying
      // later must not produce a second attempt.
      expect(decisionsFor(db, 'comment-1')).toMatchObject({ decision: 'send' });
    });
  });
});

/**
 * Regressions for three gaps found by auditing against the assignment brief
 * after the build was otherwise working.
 */
describe('windows and cart persistence', () => {
  let db: DB;
  let dispatcher: RecordingDispatcher;

  const build = (script: Step[][], mcpOverride?: McpClient) =>
    createConcierge({
      db,
      mcp: mcpOverride ?? mcp,
      provider: new ScriptedProvider(script),
      dispatcher,
      enricher: new NoEnricher(),
      brandName: 'ONEHOPE',
      brandAccountIds: BRAND,
      toolBudget: 3,
    });

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    dispatcher = new RecordingDispatcher();
  });

  /**
   * The bug this pins: cartId lived on per-Turn context, so a follow-up message
   * started a second cart and the checkout link quietly lost everything the
   * Customer had already chosen.
   */
  it('carries the cart into the next message', async () => {
    const seen: (string | undefined)[] = [];
    const cartMcp = {
      has: () => true,
      discover: async () => [],
      call: async (tool: string, args: Record<string, unknown>) => {
        if (tool === 'update_cart') seen.push(args['cart_id'] as string | undefined);
        return {
          ok: true as const,
          value:
            tool === 'update_cart'
              ? { cart: { id: 'gid://shopify/Cart/kept', total_amount: { amount: 2900, currency: 'USD' }, checkout_url: 'https://s/c/kept', lines: [] } }
              : { product: { product_id: 'p1', title: 'Wine', selectedOrFirstAvailableVariant: { variant_id: 'v1', price: '29.0' } } },
        };
      },
    } as unknown as McpClient;

    const add: Step[][] = [[use('add_to_cart', { product_id: 'p1' })], [say('added')]];
    await build(add, cartMcp)(message({ eventId: 'm1', text: 'add one' }));
    await build(add, cartMcp)(message({ eventId: 'm2', text: 'add another' }));

    // First call opens a cart; the second must extend that same cart.
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBe('gid://shopify/Cart/kept');
  });

  it('offers the model a way to read the cart back', async () => {
    const provider = new ScriptedProvider([[say('hi')]]);
    await createConcierge({
      db, mcp, provider, dispatcher, enricher: new NoEnricher(),
      brandName: 'ONEHOPE', brandAccountIds: BRAND, toolBudget: 3,
    })(message());

    expect(provider.requests[0]?.tools.map((t) => t.name)).toContain('view_cart');
  });

  /**
   * Instagram closes the thread 24 hours after the Customer last wrote. A Turn
   * delayed past it must report that rather than attempt a send the platform
   * will refuse.
   */
  it('refuses to reply once the 24-hour window has closed', async () => {
    const old = Date.now() - REPLY_WINDOW_MS - 60_000;
    const result = await build([[say('too late')]])(message({ at: old }));

    expect(result).toMatchObject({
      outcome: 'window_closed',
      reason: expect.stringContaining('24-hour'),
    });
    expect(dispatcher.sent).toEqual([]);
  });

  it('replies normally inside the window', async () => {
    const result = await build([[say('in time')]])(message({ at: Date.now() - 60_000 }));
    expect(result.outcome).toBe('replied');
    expect(dispatcher.sent).toHaveLength(1);
  });
});

/**
 * The brief's flagship pipeline is comment → fetch profile → compose opener, and
 * names "which post it was under" as part of the personalisation surface. Both
 * are covered here, including the case that actually happens.
 */
describe('opener enrichment', () => {
  let db: DB;
  let dispatcher: RecordingDispatcher;

  const withEnricher = (enricher: Enricher, provider: ScriptedProvider) =>
    createConcierge({
      db, mcp, provider, dispatcher, enricher,
      brandName: 'ONEHOPE', brandAccountIds: BRAND, toolBudget: 3,
    });

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    dispatcher = new RecordingDispatcher();
  });

  const enricherOf = (value: Enrichment): Enricher => ({ forComment: async () => value });

  it('asks for the profile and the post before composing', async () => {
    const asked: [string, string][] = [];
    const provider = new ScriptedProvider([[say('hi')]]);
    await withEnricher(
      { forComment: async (c, m) => { asked.push([c, m]); return {}; } },
      provider,
    )(comment());

    expect(asked).toEqual([['customer-2', 'media-1']]);
  });

  it('grounds the opener in the post it was left under', async () => {
    const provider = new ScriptedProvider([[say('hi')]]);
    await withEnricher(
      enricherOf({ post: { caption: 'Field to Table Red Blend 2021\n2021, Central Coast' } }),
      provider,
    )(comment());

    expect(provider.requests[0]?.system).toContain('Field to Table Red Blend 2021');
  });

  it('uses follow status when the profile is readable', async () => {
    const provider = new ScriptedProvider([[say('hi')]]);
    await withEnricher(
      enricherOf({ profile: { username: 'maya.runs', name: 'Maya', followsBrand: true, followerCount: 812 } }),
      provider,
    )(comment());

    const system = provider.requests[0]?.system ?? '';
    expect(system).toContain('They already follow ONEHOPE');
    expect(system).toContain('812 followers');
  });

  /**
   * The normal case. A commenter has given no consent, so the profile endpoint
   * refuses — and the prompt must say so rather than let the model assume a
   * relationship.
   */
  it('states the profile is unknown when consent has not been given', async () => {
    const provider = new ScriptedProvider([[say('hi')]]);
    await withEnricher(
      enricherOf({ profileUnavailable: 'user consent is required (subcode 2534022)' }),
      provider,
    )(comment());

    const system = provider.requests[0]?.system ?? '';
    expect(system).toContain('could not be read');
    expect(system).toContain('Do not');
    expect(system).not.toContain('They already follow');
  });

  it('still sends the opener when enrichment fails entirely', async () => {
    const result = await withEnricher(
      { forComment: async () => ({ profileUnavailable: 'timed out' }) },
      new ScriptedProvider([[say('Hey! Saw your comment.')]]),
    )(comment());

    expect(result.outcome).toBe('opened');
    expect(dispatcher.sent).toHaveLength(1);
  });
});

/**
 * The brief describes the loop as running with "brand instructions". A brand
 * must be able to set its own voice — and must not be able to use that to
 * override the rails.
 */
describe('brand instructions', () => {
  let db: DB;
  let dispatcher: RecordingDispatcher;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    dispatcher = new RecordingDispatcher();
  });

  const withInstructions = (instructions: string | undefined, provider: ScriptedProvider) =>
    createConcierge({
      db, mcp, provider, dispatcher, enricher: new NoEnricher(),
      brandName: 'ONEHOPE',
      ...(instructions ? { brandInstructions: instructions } : {}),
      brandAccountIds: BRAND, toolBudget: 3,
    });

  it('carries the brand’s own words into the conversation prompt', async () => {
    const provider = new ScriptedProvider([[say('hi')]]);
    await withInstructions('Every bottle funds a cause. Never compare us to other wineries.', provider)(
      message(),
    );

    const system = provider.requests[0]?.system ?? '';
    expect(system).toContain('What ONEHOPE wants you to know');
    expect(system).toContain('Never compare us to other wineries');
  });

  it('carries them into the opener too', async () => {
    const provider = new ScriptedProvider([[say('hi')]]);
    await withInstructions('Every bottle funds a cause.', provider)(comment());

    expect(provider.requests[0]?.system).toContain('Every bottle funds a cause');
  });

  /**
   * Instructions are appended after the rails, so a brand sets the voice but
   * cannot authorise inventing a price.
   */
  it('places them after the rails, not before', async () => {
    const provider = new ScriptedProvider([[say('hi')]]);
    await withInstructions('Say whatever sells.', provider)(message());

    const system = provider.requests[0]?.system ?? '';
    expect(system.indexOf('Never state a price')).toBeLessThan(system.indexOf('Say whatever sells'));
  });

  it('omits the section entirely when a brand sets none', async () => {
    const provider = new ScriptedProvider([[say('hi')]]);
    await withInstructions(undefined, provider)(message());

    expect(provider.requests[0]?.system).not.toContain('wants you to know');
  });
});
