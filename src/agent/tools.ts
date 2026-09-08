import type { McpClient, McpToolName } from '../mcp/client.ts';
import { addToCart, getCart, productDetails, searchCatalog, searchPolicies } from '../mcp/shop.ts';
import type { Cart } from '../mcp/shop.ts';
import type { ToolSpec } from './provider.ts';

/**
 * The Tools the model may choose from, and how their results are rendered back
 * to it.
 *
 * Two rules hold throughout.
 *
 * Results are rendered as prose, not JSON. The model's job is to talk to a
 * Customer, and prose is what it is good at reasoning over; handing it raw
 * payloads invites it to quote identifiers at people.
 *
 * A failure is rendered too, in the same channel, as a sentence. It never
 * throws. That is what makes "degrade gracefully in-conversation" the default
 * behaviour rather than something bolted on: the model simply reads that the
 * catalog is unavailable and says so.
 */

export type ToolContext = {
  mcp: McpClient;
  /** The Cart this Conversation is already building, if any. Read-only here. */
  readonly cartId?: string;
};

/**
 * What a Tool did, and anything the Turn needs to carry forward.
 *
 * `cart` is how adding to a cart tells the loop which Cart now exists, rather
 * than reaching back and mutating the context it was handed. A Tool that edits
 * its caller's state is a side channel: it makes the loop's behaviour depend on
 * something no signature mentions, and it is why the Cart silently failed to
 * persist between Turns in the first place.
 */
export type ToolOutcome = {
  text: string;
  ok: boolean;
  cart?: { id: string; checkoutUrl: string };
};

const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'search_catalog',
    description:
      'Search the brand catalog. Use the customer’s own words. Pass their situation as intent ' +
      '("buying for a steak dinner") — it improves relevance.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'what to search for' },
        intent: { type: 'string', description: 'the customer’s situation, in your words' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_product',
    description:
      'Full detail and the current price for one product, by the id returned from search. ' +
      'Call this before adding anything to a cart.',
    input_schema: {
      type: 'object',
      properties: { product_id: { type: 'string' } },
      required: ['product_id'],
    },
  },
  {
    name: 'add_to_cart',
    description:
      'Add a product to the cart and get a checkout link. Takes the product id; the variant is ' +
      'resolved for you. The store prices the cart — never state a total you calculated yourself.',
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'string' },
        quantity: { type: 'number', description: 'defaults to 1' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'view_cart',
    description:
      'Show what is already in the customer’s cart, with the current total and checkout link. ' +
      'Use it when they ask what they have added, or before checkout.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_policies',
    description:
      'Search the brand’s shipping, returns and refund policies. If it finds nothing, say so — ' +
      'do not answer a policy question from general knowledge.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
];

/**
 * The Tools this store can actually serve.
 *
 * Capability is per-store and not guaranteed: Ridge Wallet exposes only policy
 * search — no catalog, no cart. Offering a model tools that can only fail wastes
 * budget on a guaranteed error and invites it to promise a cart the store cannot
 * build. Better to never mention them.
 */
export function toolsFor(mcp: McpClient): ToolSpec[] {
  const backing: Record<string, McpToolName> = {
    search_catalog: 'search_catalog',
    get_product: 'get_product_details',
    add_to_cart: 'update_cart',
    view_cart: 'get_cart',
    search_policies: 'search_shop_policies_and_faqs',
  };
  return TOOL_SPECS.filter((spec) => mcp.has(backing[spec.name]!));
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolOutcome> {
  switch (name) {
    case 'search_catalog':
      return renderSearch(context, String(input['query'] ?? ''), asOptionalString(input['intent']));
    case 'get_product':
      return renderProduct(context, String(input['product_id'] ?? ''));
    case 'add_to_cart':
      return renderAddToCart(
        context,
        String(input['product_id'] ?? ''),
        typeof input['quantity'] === 'number' ? input['quantity'] : 1,
      );
    case 'view_cart':
      return renderViewCart(context);
    case 'search_policies':
      return renderPolicies(context, String(input['query'] ?? ''));
    default:
      return { ok: false, text: `There is no tool called ${name}.`, };
  }
}

const asOptionalString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

async function renderSearch(
  context: ToolContext,
  query: string,
  intent?: string,
): Promise<ToolOutcome> {
  const result = await searchCatalog(context.mcp, query, intent);
  if (!result.ok) {
    return { ok: false, text: `The catalog could not be searched right now (${result.error.message}).` };
  }
  if (result.value.length === 0) {
    return { ok: true, text: `Nothing in the catalog matches "${query}".` };
  }

  const lines = result.value.slice(0, 5).map((p) => {
    const blurb = p.description.length > 180 ? `${p.description.slice(0, 180)}…` : p.description;
    return `- ${p.title} — ${p.priceRange || 'price on request'} (id: ${p.id})\n  ${blurb}`;
  });
  return { ok: true, text: `Catalog matches for "${query}":\n${lines.join('\n')}` };
}

async function renderProduct(context: ToolContext, productId: string): Promise<ToolOutcome> {
  const result = await productDetails(context.mcp, productId);
  if (!result.ok) {
    return { ok: false, text: `That product could not be looked up (${result.error.message}).` };
  }
  const { product, price } = result.value;
  return {
    ok: true,
    text: `${product.title} — ${price || product.priceRange}\n${product.description}`,
  };
}

async function renderAddToCart(
  context: ToolContext,
  productId: string,
  quantity: number,
): Promise<ToolOutcome> {
  const detail = await productDetails(context.mcp, productId);
  if (!detail.ok) {
    return { ok: false, text: `That product could not be added (${detail.error.message}).` };
  }

  const cart = await addToCart(context.mcp, detail.value.variantId, quantity, context.cartId);
  if (!cart.ok) {
    return { ok: false, text: `The cart could not be updated (${cart.error.message}).` };
  }

  const discount = describeDiscount(cart.value);

  const notices = cart.value.notices.length
    ? `\nThe store also says: ${cart.value.notices.join('; ')}.`
    : '';

  return {
    ok: true,
    cart: { id: cart.value.id, checkoutUrl: cart.value.checkoutUrl },
    text:
      `Cart updated. ${quantity} × ${detail.value.product.title}. ` +
      `Total ${cart.value.total}${discount}.\nCheckout link: ${cart.value.checkoutUrl}${notices}`,
  };
}

async function renderViewCart(context: ToolContext): Promise<ToolOutcome> {
  if (!context.cartId) {
    return { ok: true, text: 'The customer has no cart yet — nothing has been added.' };
  }

  const cart = await getCart(context.mcp, context.cartId);
  if (!cart.ok) {
    /**
     * An expired Cart arrives here, and the store answers it as a *successful*
     * response carrying a not_found notice rather than as an error — so both
     * paths have to be readable as words. Either way the Customer is told the
     * cart is gone instead of being handed a dead link.
     */
    return { ok: false, text: `The cart could not be read (${cart.error.message}). It may have expired.` };
  }

  const lines = cart.value.lines.length
    ? cart.value.lines
        .map((l) => {
          const cut = l.subtotal && l.total && l.subtotal !== l.total ? ` — ${l.total}, down from ${l.subtotal}` : '';
          return `- ${l.quantity} × ${l.title}${cut}`;
        })
        .join('\n')
    : '(the cart is empty)';
  const notices = cart.value.notices.length ? `\nThe store says: ${cart.value.notices.join('; ')}.` : '';

  return {
    ok: true,
    text:
      `Cart:\n${lines}\nTotal ${cart.value.total}${describeDiscount(cart.value)}\n` +
      `Checkout link: ${cart.value.checkoutUrl}${notices}`,
  };
}

async function renderPolicies(context: ToolContext, query: string): Promise<ToolOutcome> {
  const result = await searchPolicies(context.mcp, query);
  if (!result.ok) {
    return { ok: false, text: `The policy pages could not be searched (${result.error.message}).` };
  }
  if (result.value.length === 0) {
    /**
     * An empty result is a real answer. Policy search matches literally, so
     * "returns" can find nothing on a store whose "refund policy" is published.
     * The model is told plainly, so it says it does not know instead of
     * reaching for general knowledge about how shops usually work.
     */
    return {
      ok: true,
      text: `The brand publishes nothing about "${query}". Tell the customer you could not find it rather than guessing.`,
    };
  }

  return {
    ok: true,
    text: result.value
      .slice(0, 3)
      .map((r) => `Q: ${r.question}\nA: ${r.answer}`)
      .join('\n\n'),
  };
}

/**
 * What the store knocked off, in the store's own words and numbers.
 *
 * Three places carry a promotion and only one of them is obvious.
 *
 * A quantity break can surface at cart level, where subtotal and total
 * disagree. An automatic line discount does not: Shopify folds it into the cart
 * subtotal before reporting, leaving `$68.00` against `$68.00` and an empty
 * top-level `discounts` object, with the gap visible only inside the line. And
 * the line also *names* the promotion in `applied_discounts` — "15% Sitewide
 * Sale" — which is strictly better than a gap, because it is a fact the model
 * may repeat rather than an inference it has to draw.
 *
 * Nothing here is computed. Every figure quoted is one the store sent, which is
 * what lets the prompt's rail hold: the model may never state a discount it was
 * not given, so this has to hand it one.
 *
 * This is also the answer to "is there a promo on?" — the policy FAQ has no
 * such page, so a cart is the only place the store will say so.
 */
function describeDiscount(cart: Cart): string {
  // What each line ended up costing against what it would have, in store figures.
  const cut = cart.lines
    .filter((l) => l.subtotal && l.total && l.subtotal !== l.total)
    .map((l) => `${l.title} is ${l.total}, down from ${l.subtotal}`);

  const named = cart.lines.flatMap((l) => l.discounts).filter((d) => d.title);
  if (named.length > 0) {
    const unique = [...new Map(named.map((d) => [d.title, d])).values()];
    const promos = unique.map((d) => (d.amount ? `${d.title} (−${d.amount})` : d.title)).join(', ');
    // Name first — it is what a customer asking "is there a promo?" wants —
    // then the prices, so the model can quote either without doing sums.
    return ` (the store applied ${promos}${cut.length ? `: ${cut.join('; ')}` : ''})`;
  }

  if (cut.length > 0) {
    return ` (the store applied a discount: ${cut.join('; ')})`;
  }

  return cart.subtotal && cart.subtotal !== cart.total
    ? ` (down from ${cart.subtotal} — the store applied a discount)`
    : '';
}
