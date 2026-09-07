/**
 * Shopify's Storefront MCP server.
 *
 * Every Shopify storefront exposes `/api/mcp` over JSON-RPC with no
 * authentication, which is why the brief can say "a dev store is fine" — the
 * catalog is simply open.
 *
 * Three things here were established against a live storefront rather than read,
 * and each would otherwise be a defect (docs/platform-findings.md §6):
 *
 *   1. Tool names are discovered, never hardcoded. The assignment names
 *      `search_shop_catalog`; no storefront serves that any more. `tools/list`
 *      returns `search_catalog`. A rename should degrade to "that capability is
 *      unavailable", not to a silent wrong answer.
 *
 *   2. The two catalog tools disagree about shape. `search_catalog` returns a
 *      `variants` array and prices as numbers in minor units (2900);
 *      `get_product_details` returns `selectedOrFirstAvailableVariant` and
 *      prices as strings in major units ("29.0"). Handling one shape silently
 *      produces empty prices from the other.
 *
 *   3. `update_cart` returns an `instructions` field: natural-language
 *      directives addressed to the agent. It is third-party text arriving inside
 *      a tool result, so it is dropped here and never reaches the model. Tool
 *      output is data; only the operator writes instructions.
 */

export type McpToolName =
  | 'search_catalog'
  | 'get_product_details'
  | 'get_cart'
  | 'update_cart'
  | 'search_shop_policies_and_faqs';

export type McpFailure = {
  /** A protocol error means the operation did not happen. */
  kind: 'protocol' | 'transport';
  message: string;
};

export type McpResult<T> = { ok: true; value: T } | { ok: false; error: McpFailure };

const RPC_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

export class McpClient {
  private tools: Set<string> | null = null;
  private reachable = true;
  private nextId = 1;

  constructor(
    private readonly domain: string,
    private readonly timeoutMs = 20_000,
  ) {}

  /**
   * Which Tools this storefront actually serves. Availability is per-store and
   * cannot be assumed: of four storefronts tested during earlier work, three
   * exposed cart tools and one exposed only policy search. The Agent Loop offers
   * the model only what came back from here.
   */
  async discover(): Promise<string[]> {
    const result = await this.rpc<{ tools: { name: string }[] }>('tools/list');
    if (!result.ok) {
      /**
       * Discovery failing is not the same as the store having no tools, and
       * conflating them is dangerous. If an unreachable store reports "no
       * capabilities", the Agent Loop offers the model nothing — and a model
       * with no tools and a question about stock will answer from imagination.
       * A transient outage would silently turn the Concierge into a fabricator.
       *
       * So an unreachable store stays optimistic: the Tools are still offered,
       * every call fails loudly, and the failure reaches the Customer as words.
       * A visible error beats a confident invention.
       */
      this.reachable = false;
      this.tools = null;
      return [];
    }
    this.reachable = true;
    this.tools = new Set(result.value.tools.map((t) => t.name));
    return [...this.tools];
  }

  /** Whether the store offers a Tool. Unknown counts as yes — see `discover`. */
  has(tool: McpToolName): boolean {
    if (this.tools === null) return true;
    return this.tools.has(tool);
  }

  /** False when discovery could not reach the store at all. */
  isReachable(): boolean {
    return this.reachable;
  }

  /**
   * Calls a Tool and returns its data-bearing payload.
   *
   * Shopify replies in one of two shapes — a `structuredContent` object, or a
   * `content` array whose first element carries JSON as text — so both are
   * unwrapped here rather than in every caller.
   */
  async call<T = unknown>(tool: McpToolName, args: unknown): Promise<McpResult<T>> {
    if (this.tools && !this.tools.has(tool)) {
      return { ok: false, error: { kind: 'protocol', message: `${tool} is not offered by this store` } };
    }

    const result = await this.rpc<{
      structuredContent?: Record<string, unknown>;
      content?: { text?: string }[];
    }>('tools/call', { name: tool, arguments: args });

    if (!result.ok) return result;

    const payload = unwrap(result.value);
    if (payload === undefined) {
      return { ok: false, error: { kind: 'protocol', message: `${tool} returned no readable payload` } };
    }

    return { ok: true, value: stripInstructions(payload) as T };
  }

  private async rpc<T>(method: string, params?: unknown): Promise<McpResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`https://${this.domain}/api/mcp`, {
        method: 'POST',
        headers: RPC_HEADERS,
        signal: controller.signal,
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, ...(params ? { params } : {}) }),
      });

      if (!res.ok) {
        return { ok: false, error: { kind: 'transport', message: `${method} returned HTTP ${res.status}` } };
      }

      const parsed = (await res.json()) as { result?: T; error?: { message?: string } };
      if (parsed.error) {
        return { ok: false, error: { kind: 'protocol', message: parsed.error.message ?? 'unknown error' } };
      }
      if (parsed.result === undefined) {
        return { ok: false, error: { kind: 'protocol', message: `${method} returned no result` } };
      }
      return { ok: true, value: parsed.result };
    } catch (error) {
      const message = (error as Error).name === 'AbortError' ? 'timed out' : (error as Error).message;
      return { ok: false, error: { kind: 'transport', message: `${method} failed: ${message}` } };
    } finally {
      clearTimeout(timer);
    }
  }
}

function unwrap(result: {
  structuredContent?: Record<string, unknown>;
  content?: { text?: string }[];
}): Record<string, unknown> | undefined {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.[0]?.text;
  if (typeof text !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    // Policy search answers with a bare array; wrap it so callers see one shape.
    return Array.isArray(parsed) ? { results: parsed } : (parsed as Record<string, unknown>);
  } catch {
    return { text };
  }
}

/**
 * Removes the `instructions` field before anything the model can read.
 *
 * Shopify populates it with sentences like "Ask if the customer has found
 * everything they need... prompt them to select a shipping option". Harmless in
 * intent, but it is an external service writing into our agent's context. The
 * boundary is the same one the signature check defends: content arriving from
 * outside is data, and only the operator gets to give instructions.
 */
function stripInstructions(payload: Record<string, unknown>): Record<string, unknown> {
  if (!('instructions' in payload)) return payload;
  const { instructions: _dropped, ...rest } = payload;
  return rest;
}
