import { config as loadDotenv } from 'dotenv';

loadDotenv({ quiet: true });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — copy .env.example to .env and fill it in`);
  return value;
}

/**
 * The Brand Account, expressed as every identifier Meta might use for it.
 *
 * There are two, and they are not interchangeable. The App Dashboard shows the
 * Instagram professional account id; `GET /me` returns a different, app-scoped
 * id for the same account. Which of them appears in `entry[].id` on a live
 * Delivery is unknown, because test Deliveries carry the placeholder "0" (see
 * docs/platform-findings.md §8).
 *
 * Guessing would produce a Receiver that silently drops every real Delivery, so
 * the assertion accepts either and the Receiver logs which one it saw. The first
 * live Delivery settles it, and this collapses to one value.
 */
export function brandAccountIds(): string[] {
  return [required('IG_ACCOUNT_ID'), required('IG_APP_SCOPED_USER_ID')];
}

export const config = {
  /**
   * Signs and verifies Deliveries. This is the *Instagram* app secret, not the
   * Meta app secret — a distinction that costs an afternoon if you get it wrong,
   * since both exist in the same dashboard and only one reproduces Meta's
   * signature.
   */
  igAppSecret: () => required('IG_APP_SECRET'),
  igAccessToken: () => required('IG_ACCESS_TOKEN'),
  verifyToken: () => required('IG_VERIFY_TOKEN'),
  shopDomain: () => required('SHOPIFY_STORE_DOMAIN'),
  anthropicKey: () => required('ANTHROPIC_API_KEY'),

  dbPath: () => process.env.DB_PATH ?? './data/concierge.db',
  port: () => Number(process.env.PORT ?? 8787),

  /**
   * How many Tools one Turn may call before the Agent Loop gives up and
   * escalates. A budget, not a safety valve: without it, a model that keeps
   * finding reasons to look something up turns a fixed-cost Turn into an
   * unbounded one, and the cost tail is what makes per-Conversation pricing
   * unpredictable.
   */
  toolBudget: () => Number(process.env.TOOL_BUDGET ?? 3),
};
