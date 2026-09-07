import { readFileSync } from 'node:fs';

/**
 * The brand's standing rules, and where they come from.
 *
 * These are *rules*, never facts. Prices, stock, policies and what the brand
 * sells are fetched from the store every turn, because they change and the
 * store is the authority on them; a fact typed in here goes stale silently and
 * the Concierge has no way to know. `README.md` §"Brand instructions" argues
 * the boundary in full.
 *
 * They are also operator-authored, which is the property that matters for
 * trust — not the file they live in. Text from the store becoming our model's
 * instructions is the injection surface the MCP client already closes by
 * dropping `update_cart`'s `instructions` field, and reading brand voice over
 * MCP would reopen it. A checked-in file is the same trust level as `.env`.
 *
 * What the file buys over a single env string is that `prohibitedUsStates`
 * stops being prose. It is the one rule here that is data: it has a correct
 * answer, it carries legal weight, and it can be tested without a model call.
 *
 * This is deliberately one brand. The assignment puts multi-brand support
 * explicitly out of scope, so nothing here reaches for it.
 */

export type BrandConfig = {
  name: string;
  /** Voice and conduct, in the brand's own words. Passed through verbatim. */
  voice: string[];
  shipping: {
    /**
     * US states the brand may not ship wine to, as two-letter codes.
     *
     * Owned by the operator and no one else — DTC alcohol statutes are
     * per-state and they change, so this list must be confirmed against
     * compliance counsel rather than inherited from a default.
     */
    prohibitedUsStates: string[];
  };
};

/** Only the states this system might be asked about. Unknown codes are an error. */
const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};

/**
 * Renders the config into the prose the model reads.
 *
 * The shipping paragraph says two things, and the second is the one that was
 * missing. Naming the prohibited states stops a wrong yes for those. Refusing
 * to confirm the rest stops a wrong yes for everywhere else — because the store
 * answers shipping at *country* granularity ("...UA, US, VA") and returns
 * nothing at all for "shipping states", so "we ship to the US" is the only
 * thing the Concierge can truthfully learn, and reading that as approval for a
 * particular state is precisely the defect. Absence from the list is not
 * evidence of legality; it is absence of evidence.
 */
export function composeInstructions(brand: BrandConfig): string {
  const codes = brand.shipping.prohibitedUsStates;

  const unknown = codes.filter((code) => !US_STATES[code.toUpperCase()]);
  if (unknown.length > 0) {
    // Loud at boot beats a bare "ZZ" reaching a customer in a compliance answer.
    throw new Error(`brand config: unknown US state code(s): ${unknown.join(', ')}`);
  }

  const rules = [...brand.voice];

  if (codes.length > 0) {
    const named = codes.map((code) => US_STATES[code.toUpperCase()]!).join(', ');
    rules.push(
      `Wine shipping in the US is regulated state by state, and the store only publishes ` +
        `the countries we ship to — never read a country list as an answer about a state. ` +
        `We cannot ship wine to ${named}. If someone names one of those, tell them plainly ` +
        `we cannot ship there. For any other US state, do not confirm it yourself — say ` +
        `shipping is confirmed at checkout once they enter an address.`,
    );
  }

  return rules.join(' ');
}

/**
 * Reads the brand file, falling back to the environment.
 *
 * `BRAND_INSTRUCTIONS` still wins when set, so an operator can override without
 * editing a file and nothing that already relied on it breaks.
 */
export function loadBrand(
  path = './config/brand.json',
): { name: string; instructions?: string; source: 'file' | 'env' | 'none' } {
  const envInstructions = process.env.BRAND_INSTRUCTIONS?.trim();

  let file: BrandConfig | undefined;
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as BrandConfig;
  } catch {
    // No file is fine: the environment alone is a complete configuration.
    file = undefined;
  }

  const name = process.env.BRAND_NAME ?? file?.name ?? 'ONEHOPE';
  const instructions = envInstructions || (file ? composeInstructions(file) : undefined);

  /**
   * Which source won, so a deployment can prove its rules arrived.
   *
   * The path above is relative, and a working directory that is not the
   * repository root reads as "no file" — identical, from in here, to a
   * deliberate env-only setup. That silence would take the shipping
   * restriction with it, which is the one rule that carries legal weight, so
   * the caller is told and boot logs it.
   */
  const source = envInstructions ? 'env' : file ? 'file' : 'none';

  return { name, source, ...(instructions ? { instructions } : {}) };
}
