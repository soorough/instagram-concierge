import { describe, expect, it } from 'vitest';
import { McpClient } from '../src/mcp/client.ts';
import { addToCart, productDetails, searchCatalog, searchPolicies } from '../src/mcp/shop.ts';

/**
 * These run against the real storefront.
 *
 * Stubbing Shopify here would defeat the point: the milestone is "commerce
 * capabilities arrive via MCP", and a recorded response proves only that we can
 * parse yesterday's bytes. Every assumption this file encodes — the tool names,
 * where variants live, that the store prices the cart — was wrong in some
 * earlier draft and was corrected by running exactly these calls.
 *
 * They need the network, so they skip without SHOPIFY_STORE_DOMAIN. The fast
 * suite never depends on them.
 */
const domain = process.env.SHOPIFY_STORE_DOMAIN;
const live = describe.runIf(Boolean(domain));

live('Shopify MCP, live', () => {
  const mcp = new McpClient(domain!);

  it('discovers tool names rather than trusting the brief', async () => {
    const tools = await mcp.discover();

    expect(tools).toContain('search_catalog');
    expect(tools).toContain('search_shop_policies_and_faqs');
    // The assignment names this one. No storefront serves it any more.
    expect(tools).not.toContain('search_shop_catalog');
  });

  it('refuses a tool the store does not offer, instead of calling it', async () => {
    await mcp.discover();
    const result = await mcp.call('search_shop_catalog' as never, {});

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('not offered');
  });

  it('finds products for a described occasion', async () => {
    await mcp.discover();
    const result = await searchCatalog(mcp, 'bold red wine', 'customer wants something for a steak dinner');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThan(0);
    expect(result.value[0]?.title).toBeTruthy();
    expect(result.value[0]?.description).toBeTruthy();
  });

  it('resolves a purchasable variant from a product', async () => {
    await mcp.discover();
    const found = await searchCatalog(mcp, 'red blend');
    expect(found.ok).toBe(true);
    if (!found.ok || !found.value[0]) return;

    const detail = await productDetails(mcp, found.value[0].id);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.value.variantId).toMatch(/^gid:\/\/shopify\/ProductVariant\//);
  });

  /**
   * The store prices the Cart, not the Concierge. On this catalog two bottles at
   * $29.00 total $49.30, because the store applies its own promotion — a number
   * no model could derive and none should try to.
   */
  it('lets the store price the cart and hand back a checkout link', async () => {
    await mcp.discover();
    const found = await searchCatalog(mcp, 'red blend');
    if (!found.ok || !found.value[0]) return;
    const detail = await productDetails(mcp, found.value[0].id);
    if (!detail.ok) return;

    const cart = await addToCart(mcp, detail.value.variantId, 2);
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    expect(cart.value.id).toContain('gid://shopify/Cart/');
    expect(cart.value.total).toMatch(/^\$\d+\.\d{2}$/);
    expect(cart.value.checkoutUrl).toContain('/cart/');
  });

  it('answers a policy question from the brand’s own pages', async () => {
    await mcp.discover();
    const result = await searchPolicies(mcp, 'refund policy');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThan(0);
    expect(result.value[0]?.answer).toBeTruthy();
  });

  /**
   * Kept deliberately. "wine club" finds nothing on this store while "shipping"
   * finds plenty, so this is a real query with a real empty result — the fixture
   * for making the Concierge say it does not know instead of inventing.
   */
  it('returns an empty result for a policy the store does not publish', async () => {
    await mcp.discover();
    const result = await searchPolicies(mcp, 'wine club');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it('never exposes the store’s instructions field to the model', async () => {
    await mcp.discover();
    const found = await searchCatalog(mcp, 'red blend');
    if (!found.ok || !found.value[0]) return;
    const detail = await productDetails(mcp, found.value[0].id);
    if (!detail.ok) return;

    const raw = await mcp.call<Record<string, unknown>>('update_cart', {
      add_items: [{ product_variant_id: detail.value.variantId, quantity: 1 }],
    });

    expect(raw.ok).toBe(true);
    // Shopify sends natural-language directives addressed to the agent. They are
    // third-party text and must not reach the model's context.
    if (raw.ok) expect(Object.keys(raw.value)).not.toContain('instructions');
  });
});

describe('Shopify MCP, offline behaviour', () => {
  it('reports a transport failure rather than throwing', async () => {
    const mcp = new McpClient('this-domain-does-not-exist.invalid', 2_000);
    const result = await mcp.call('search_catalog', { catalog: { query: 'x' } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('transport');
  });

  /**
   * An unreachable store must not be reported as a store with no capabilities.
   *
   * Conflating them is dangerous: if discovery failure meant "no tools", the
   * Agent Loop would offer the model nothing, and a model with no tools and a
   * question about stock answers from imagination. A transient outage would
   * silently turn the Concierge into a fabricator. So capability stays
   * optimistic and the failure surfaces loudly on the call instead.
   */
  it('reports unreachable rather than empty, and keeps offering tools', async () => {
    const mcp = new McpClient('this-domain-does-not-exist.invalid', 2_000);

    expect(await mcp.discover()).toEqual([]);
    expect(mcp.isReachable()).toBe(false);
    expect(mcp.has('search_catalog')).toBe(true);

    const result = await mcp.call('search_catalog', { catalog: { query: 'x' } });
    expect(result.ok).toBe(false);
  });
});
