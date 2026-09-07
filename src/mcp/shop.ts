import type { McpClient, McpResult } from './client.ts';

/**
 * The store, expressed as the handful of things the Concierge needs to say.
 *
 * Everything here returns plain data or a plain reason. Nothing throws, because
 * a Tool failure has to become words in a Conversation rather than a stack
 * trace — that is the "degrade gracefully in-conversation" property the brief
 * grades, and it is easier to honour if failure is a value.
 */

export type Product = {
  id: string;
  title: string;
  description: string;
  priceRange: string;
  url?: string;
};

/**
 * A line, and what the store charged for it.
 *
 * `subtotal` and `total` differ when an automatic discount applied. They are
 * carried per-line because that is the only place the gap survives: Shopify
 * folds line discounts into the *cart* subtotal before reporting it, so a
 * cart-level comparison sees `$68.00` against `$68.00` and concludes there was
 * no promotion. See tests/discount.test.ts for the live payload that proves it.
 */
export type CartLine = {
  title: string;
  quantity: number;
  subtotal: string;
  total: string;
  /** The promotions the store says it applied, by its own name for them. */
  discounts: { title: string; amount: string }[];
};

export type Cart = {
  id: string;
  total: string;
  subtotal: string;
  checkoutUrl: string;
  lines: CartLine[];
  /**
   * What the store wants the Customer told — stock reduced, cart expired. These
   * arrive on a *successful* response, so a caller that only checks for errors
   * reports a healthy cart that no longer exists.
   */
  notices: string[];
};

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

/**
 * Money, from a store that sends it two different ways.
 *
 * `search_catalog` returns `{ amount: 2900 }` — a number in **minor units**.
 * `get_product_details` returns `"29.0"` — a string in **major units**. Same
 * store, same currency, same request. Handling only one shape is how a catalog
 * of real wines renders as "price on request", which is what this did until a
 * live reply exposed it.
 *
 * The type is the discriminator, which is uncomfortable but is the only signal
 * the payload actually carries.
 */
function money(value: unknown): string {
  const m = asRecord(value);
  const raw = m['amount'];
  const currency = asString(m['currency']) || 'USD';
  const symbol = currency === 'USD' ? '$' : `${currency} `;

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return '';
    return `${symbol}${(raw / 100).toFixed(2)}`;
  }

  const parsed = Number(asString(raw));
  if (!asString(raw) || !Number.isFinite(parsed)) return '';
  return `${symbol}${parsed.toFixed(2)}`;
}

export async function searchCatalog(
  mcp: McpClient,
  query: string,
  intent?: string,
): Promise<McpResult<Product[]>> {
  /**
   * `context.intent` is free text the store uses as a relevance signal. Passing
   * the Customer's actual situation through — "buying for a steak dinner" —
   * gets better results than the query alone, and costs nothing.
   */
  const result = await mcp.call<{ products?: unknown[] }>('search_catalog', {
    catalog: { query, ...(intent ? { context: { intent } } : {}) },
  });
  if (!result.ok) return result;

  const products = (result.value.products ?? []).map((raw): Product => {
    const p = asRecord(raw);
    const description = asRecord(p['description']);
    return {
      id: asString(p['id']) || asString(p['product_id']),
      title: asString(p['title']),
      // Descriptions arrive as `{ html }` on search and as a string elsewhere.
      description: stripHtml(asString(description['html']) || asString(p['description'])),
      priceRange: priceRange(p['price_range']),
      ...(asString(p['url']) ? { url: asString(p['url']) } : {}),
    };
  });

  return { ok: true, value: products };
}

export async function productDetails(
  mcp: McpClient,
  productId: string,
): Promise<McpResult<{ product: Product; variantId: string; price: string }>> {
  const result = await mcp.call<Record<string, unknown>>('get_product_details', {
    product_id: productId,
  });
  if (!result.ok) return result;

  const product = asRecord(result.value['product'] ?? result.value);
  // `get_product_details` narrows to one variant here rather than returning a
  // `variants` array — unlike `search_catalog`, which does return one. Reading
  // the wrong key finds nothing while still reporting success.
  const variant = asRecord(product['selectedOrFirstAvailableVariant']);
  const variantId = asString(variant['variant_id']) || asString(variant['id']);

  if (!variantId) {
    return { ok: false, error: { kind: 'protocol', message: 'product has no purchasable variant' } };
  }

  return {
    ok: true,
    value: {
      product: {
        id: asString(product['product_id']) || productId,
        title: asString(product['title']),
        description: stripHtml(asString(asRecord(product['description'])['html']) || asString(product['description'])),
        priceRange: priceRange(product['price_range']),
      },
      variantId,
      price: asString(variant['price']) ? `$${Number(asString(variant['price'])).toFixed(2)}` : '',
    },
  };
}

export async function addToCart(
  mcp: McpClient,
  variantId: string,
  quantity: number,
  cartId?: string,
): Promise<McpResult<Cart>> {
  const result = await mcp.call<Record<string, unknown>>('update_cart', {
    ...(cartId ? { cart_id: cartId } : {}),
    add_items: [{ product_variant_id: variantId, quantity }],
  });
  if (!result.ok) return result;

  const cart = asRecord(result.value['cart']);
  if (!asString(cart['id'])) {
    return { ok: false, error: { kind: 'protocol', message: 'store returned no cart' } };
  }
  return { ok: true, value: readCart(cart, result.value) };
}

function readCart(cart: Record<string, unknown>, envelope: Record<string, unknown>): Cart {
  const cost = asRecord(cart['total_amount'] ? cart : cart['cost']);
  return {
    id: asString(cart['id']),
    total: money(cost['total_amount']),
    subtotal: money(cost['subtotal_amount']),
    checkoutUrl: asString(cart['checkout_url']) || asString(cart['continue_url']),
    lines: (Array.isArray(cart['lines']) ? cart['lines'] : []).map((raw): CartLine => {
      const line = asRecord(raw);
      // Same two shapes as the cart: nested under `cost`, or flat on the line.
      const lineCost = asRecord(line['total_amount'] ? line : line['cost']);
      const merchandise = asRecord(line['merchandise']);
      /**
       * The product's name, not the variant's. A single-variant product — most
       * of a wine catalog — titles its variant "Default Title", so reading the
       * merchandise title puts that phrase in front of a customer.
       */
      const title =
        asString(asRecord(merchandise['product'])['title']) || asString(merchandise['title']);

      const applied = Array.isArray(line['applied_discounts']) ? line['applied_discounts'] : [];

      return {
        title,
        quantity: typeof line['quantity'] === 'number' ? line['quantity'] : 0,
        subtotal: money(lineCost['subtotal_amount']),
        total: money(lineCost['total_amount']),
        discounts: applied
          .map((entry) => {
            const d = asRecord(entry);
            return { title: asString(d['title']), amount: money(d['discounted_amount']) };
          })
          .filter((d) => d.title || d.amount),
      };
    }),
    notices: notices(envelope),
  };
}

export async function getCart(mcp: McpClient, cartId: string): Promise<McpResult<Cart>> {
  const result = await mcp.call<Record<string, unknown>>('get_cart', { cart_id: cartId });
  if (!result.ok) return result;
  return { ok: true, value: readCart(asRecord(result.value['cart']), result.value) };
}

export async function searchPolicies(
  mcp: McpClient,
  query: string,
): Promise<McpResult<{ question: string; answer: string }[]>> {
  const result = await mcp.call<{ results?: unknown[] }>('search_shop_policies_and_faqs', { query });
  if (!result.ok) return result;

  /**
   * An empty array is a real answer, not a failure. Policy search matches
   * literally: "refund policy" returns content while "returns" returns nothing
   * on the same store. The Concierge must say it could not find the policy
   * rather than invent one, so emptiness is passed through intact.
   */
  const rows = (result.value.results ?? []).map((raw) => {
    const r = asRecord(raw);
    return { question: asString(r['question']), answer: asString(r['answer']) };
  });

  return { ok: true, value: rows };
}

function priceRange(value: unknown): string {
  const range = asRecord(value);
  const min = money(range['min'] ?? range['min_variant_price']);
  const max = money(range['max'] ?? range['max_variant_price']);
  if (min && max && min !== max) return `${min}–${max}`;
  return min || max;
}

/** Business outcomes ride on a successful response; surface them as sentences. */
function notices(payload: Record<string, unknown>): string[] {
  const source = payload['errors'] ?? asRecord(payload['cart'])['messages'] ?? payload['messages'];
  if (!Array.isArray(source)) return [];
  return source
    .map((raw) => {
      const m = asRecord(raw);
      return asString(m['message']) || asString(m['code']) || asString(m['type']);
    })
    .filter(Boolean);
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
