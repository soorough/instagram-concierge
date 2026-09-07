import { describe, expect, it } from 'vitest';
import { addToCart } from '../src/mcp/shop.ts';
import { executeTool } from '../src/agent/tools.ts';
import type { McpClient } from '../src/mcp/client.ts';

/**
 * A promotion the store applied at the *line* level, which the cart total hides.
 *
 * This payload is a real `update_cart` reply from onehopewine.com: two Reserve
 * Paso Robles Cabernet at $40, discounted to $68. Note what it does with the
 * numbers — `cost.subtotal_amount` has already had the discount folded in, so it
 * equals `cost.total_amount`, and `discounts` is an empty object. The only trace
 * of the $12 is the gap inside `lines[0].cost`.
 *
 * So a cart-level `subtotal !== total` check is not merely incomplete here, it
 * is dead code: it can never fire for an automatic line discount, which is the
 * common kind. The Concierge reported no promotion on a cart that had one.
 */
const LIVE_DISCOUNTED_CART = {
  cart: {
    id: 'gid://shopify/Cart/abc123',
    checkout_url: 'https://onehopewine.com/cart/c/abc123',
    cost: {
      total_amount: { amount: '68.0', currency: 'USD' },
      subtotal_amount: { amount: '68.0', currency: 'USD' },
    },
    discounts: {},
    lines: [
      {
        quantity: 2,
        // The variant title is "Default Title" on a single-variant product; the
        // name a customer would recognise is one level down, on the product.
        merchandise: {
          title: 'Default Title',
          product: { id: 'gid://p/1', title: 'Reserve Paso Robles Cabernet Sauvignon' },
        },
        cost: {
          total_amount: { amount: '68.0', currency: 'USD' },
          subtotal_amount: { amount: '80.0', currency: 'USD' },
        },
        // The store names its own promotion. Far better than inferring one from
        // a price gap — this is a fact, and the model is allowed to repeat it.
        applied_discounts: [
          {
            title: '15% Sitewide Sale',
            discounted_amount: { amount: '12.0', currency: 'USD' },
            value: { amount: '15.0', type: 'percentage' },
          },
        ],
      },
    ],
  },
};

const clientReturning = (value: unknown): McpClient =>
  ({
    has: () => true,
    discover: async () => [],
    call: async () => ({ ok: true as const, value }),
  }) as unknown as McpClient;

describe('line-level discounts', () => {
  it('reads what the store charged per line, not only the cart total', async () => {
    const result = await addToCart(clientReturning(LIVE_DISCOUNTED_CART), 'gid://v/1', 2);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const line = result.value.lines[0];
    expect(line?.subtotal).toBe('$80.00');
    expect(line?.total).toBe('$68.00');
    // Not "Default Title".
    expect(line?.title).toBe('Reserve Paso Robles Cabernet Sauvignon');
    expect(line?.discounts).toEqual([{ title: '15% Sitewide Sale', amount: '$12.00' }]);
  });

  it('tells the model a discount was applied when the cart total hides it', async () => {
    const outcome = await executeTool(
      'add_to_cart',
      { product_id: 'gid://p/1', quantity: 2 },
      {
        mcp: clientReturning({
          ...LIVE_DISCOUNTED_CART,
          product: {
            product_id: 'gid://p/1',
            title: 'Reserve Paso Robles Cabernet Sauvignon',
            description: 'Bold.',
            selectedOrFirstAvailableVariant: { variant_id: 'gid://v/1', price: '40.0' },
          },
        }),
      },
    );

    expect(outcome.ok).toBe(true);
    // The store's own numbers, both of them — never arithmetic we did ourselves.
    expect(outcome.text).toContain('$80.00');
    expect(outcome.text).toContain('$68.00');
    // The promotion by name, so the concierge can answer "is there a promo?"
    // with the store's own answer rather than "I could not find one".
    expect(outcome.text).toContain('15% Sitewide Sale');
    expect(outcome.text).toContain('$12.00');
    expect(outcome.text).not.toContain('Default Title');
  });

  it('says nothing about a discount when the store applied none', async () => {
    const outcome = await executeTool(
      'add_to_cart',
      { product_id: 'gid://p/1', quantity: 1 },
      {
        mcp: clientReturning({
          product: {
            product_id: 'gid://p/1',
            title: 'Reserve Monterey Pinot Noir',
            description: 'Bright.',
            selectedOrFirstAvailableVariant: { variant_id: 'gid://v/2', price: '35.0' },
          },
          cart: {
            id: 'gid://shopify/Cart/def456',
            checkout_url: 'https://onehopewine.com/cart/c/def456',
            cost: {
              total_amount: { amount: '35.0', currency: 'USD' },
              subtotal_amount: { amount: '35.0', currency: 'USD' },
            },
            lines: [
              {
                quantity: 1,
                merchandise: { title: 'Reserve Monterey Pinot Noir' },
                cost: {
                  total_amount: { amount: '35.0', currency: 'USD' },
                  subtotal_amount: { amount: '35.0', currency: 'USD' },
                },
              },
            ],
          },
        }),
      },
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.text.toLowerCase()).not.toContain('discount');
  });
});
