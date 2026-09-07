import { describe, expect, it } from 'vitest';
import { composeInstructions, loadBrand, type BrandConfig } from '../src/config/brand.ts';
import { afterEach } from 'vitest';

/**
 * Brand config is *rules from the operator* — the same trust level as the rest
 * of `.env`, and deliberately never fetched from the store, where third-party
 * text becoming our instructions is the injection surface the MCP client
 * already closes by dropping `update_cart`'s `instructions` field.
 *
 * What moving it out of a single env string buys is that the shipping
 * restriction stops being a sentence. It is the one rule here that is *data*:
 * it has a correct answer, it carries legal weight, and it can be asserted
 * without spending a model call. So it is a list, and these tests read it.
 */
const brand: BrandConfig = {
  name: 'ONEHOPE',
  voice: ['Every bottle funds a cause — mention it when it fits, never as a sales line.'],
  shipping: { prohibitedUsStates: ['UT', 'MS'] },
};

describe('brand config', () => {
  it('carries the brand voice through verbatim', () => {
    expect(composeInstructions(brand)).toContain('Every bottle funds a cause');
  });

  it('names every prohibited state, so none can be quietly dropped', () => {
    const text = composeInstructions(brand);
    expect(text).toContain('Utah');
    expect(text).toContain('Mississippi');
  });

  it('refuses to confirm the states it does not list, rather than approving them', () => {
    /**
     * The store's policy search answers at country granularity ("...UA, US,
     * VA"), so "we ship to the US" is the only thing it can say — and reading
     * that as a yes for a specific state is exactly the defect this exists to
     * stop. Absence from the prohibited list is not evidence of legality.
     */
    const text = composeInstructions(brand).toLowerCase();
    expect(text).toContain('checkout');
    expect(text).toMatch(/do not confirm|never confirm/);
  });

  it('says nothing about shipping when the operator restricted nothing', () => {
    const unrestricted = composeInstructions({ ...brand, shipping: { prohibitedUsStates: [] } });
    expect(unrestricted).not.toMatch(/cannot ship/i);
    expect(unrestricted).toContain('Every bottle funds a cause');
  });

  it('rejects a state code it cannot name, rather than emitting a bare code', () => {
    // A typo in a compliance list must fail loudly at boot, not ship as "ZZ".
    expect(() => composeInstructions({ ...brand, shipping: { prohibitedUsStates: ['ZZ'] } }))
      .toThrow(/ZZ/);
  });
});

/**
 * The loader reads a *relative* path and swallows a read failure, which is right
 * — a deployment configured entirely through the environment is valid. But the
 * same silence covers a genuine mistake: a working directory that is not the
 * repository root means the file is not found, `instructions` is `undefined`,
 * and the shipping restriction disappears with no error anywhere.
 *
 * The rule it carries is the one with legal weight, so its absence must be
 * loud. Boot says which source was used, and says plainly when there is none.
 */
describe('where the rules came from', () => {
  const before = process.env.BRAND_INSTRUCTIONS;
  afterEach(() => {
    if (before === undefined) delete process.env.BRAND_INSTRUCTIONS;
    else process.env.BRAND_INSTRUCTIONS = before;
  });

  it('reports the file when it is found', () => {
    delete process.env.BRAND_INSTRUCTIONS;
    const loaded = loadBrand('./config/brand.json');
    expect(loaded.source).toBe('file');
    expect(loaded.instructions).toContain('Utah');
  });

  it('reports the environment when it overrides the file', () => {
    process.env.BRAND_INSTRUCTIONS = 'Say less.';
    expect(loadBrand('./config/brand.json').source).toBe('env');
  });

  it('reports having no rules at all, rather than pretending', () => {
    delete process.env.BRAND_INSTRUCTIONS;
    const loaded = loadBrand('./config/does-not-exist.json');
    expect(loaded.source).toBe('none');
    expect(loaded.instructions).toBeUndefined();
  });
});
