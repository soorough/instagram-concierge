import { describe, expect, it } from 'vitest';
import { searchCatalog, productDetails } from '../src/mcp/shop.ts';
import type { McpClient } from '../src/mcp/client.ts';

/**
 * The same store sends money two ways, and handling only one renders a catalog
 * of real wines as "price on request". That is not hypothetical — it is what
 * shipped until a live reply exposed it, so both shapes are pinned here.
 */
const clientReturning = (value: unknown): McpClient =>
  ({ has: () => true, discover: async () => [], call: async () => ({ ok: true as const, value }) }) as unknown as McpClient;

describe('money shapes', () => {
  it('reads search prices as numbers in minor units', async () => {
    const mcp = clientReturning({
      products: [
        {
          id: 'gid://p/1',
          title: 'Vintner Red Blend',
          description: { html: '<p>Bold.</p>' },
          price_range: { min: { amount: 2900, currency: 'USD' }, max: { amount: 2900, currency: 'USD' } },
        },
      ],
    });

    const result = await searchCatalog(mcp, 'red');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]?.priceRange).toBe('$29.00');
  });

  it('reads product-detail prices as strings in major units', async () => {
    const mcp = clientReturning({
      product: {
        product_id: 'gid://p/1',
        title: 'Vintner Red Blend',
        description: 'Bold.',
        selectedOrFirstAvailableVariant: { variant_id: 'gid://v/9', price: '29.0' },
      },
    });

    const result = await productDetails(mcp, 'gid://p/1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.price).toBe('$29.00');
  });

  it('shows a range when a product spans prices', async () => {
    const mcp = clientReturning({
      products: [
        {
          id: 'gid://p/2',
          title: 'Mixed case',
          description: 'x',
          price_range: { min: { amount: 2900, currency: 'USD' }, max: { amount: 5800, currency: 'USD' } },
        },
      ],
    });

    const result = await searchCatalog(mcp, 'case');
    if (result.ok) expect(result.value[0]?.priceRange).toBe('$29.00–$58.00');
  });

  it('says nothing rather than $NaN when a price is missing', async () => {
    const mcp = clientReturning({
      products: [{ id: 'gid://p/3', title: 'Unpriced', description: 'x', price_range: {} }],
    });

    const result = await searchCatalog(mcp, 'x');
    if (result.ok) expect(result.value[0]?.priceRange).toBe('');
  });
});
