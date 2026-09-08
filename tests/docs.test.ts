import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The two documents that ship, checked for the things a machine can settle.
 *
 * Prose is not executed, so it rots quietly. Three separate numbers drifted while
 * this was being written: a count of findings that grew from four to nine and
 * stayed four in two files, a cart total superseded by a corrected one, and a
 * test count that sat still through twenty-four new tests. Nothing failed.
 *
 * These cannot check that a quoted price is still what the store charges — that
 * needs the store. The rule they encode is narrower: the docs must not contradict
 * each other or themselves, which is where the rot starts.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const README = read('README.md');
const NOTES = read('NOTES.md');

describe('the two shipped documents', () => {
  /**
   * The brief asks for "a short written note (half a page)". An earlier draft
   * was 961 words — four times that, and a scoping signal in the wrong
   * direction. The ceiling is generous on purpose; the point is to catch it
   * growing back into a second README, not to police a word.
   */
  it('keeps NOTES.md to about half a page', () => {
    const words = NOTES.split(/\s+/).filter(Boolean).length;
    expect(words, `NOTES.md is ${words} words — the brief asks for half a page`).toBeLessThan(500);
  });

  /** The README is a README. It stopped being one at 4,500 words. */
  it('keeps the README readable in one sitting', () => {
    const words = README.split(/\s+/).filter(Boolean).length;
    expect(words, `README.md is ${words} words`).toBeLessThan(2500);
  });

  /**
   * Both documents shipped once pointing at `docs/`, which is not published.
   * A link a reader cannot follow is worse than no link.
   */
  it('links nothing that is not in the repo', () => {
    for (const [name, doc] of Object.entries({ README, NOTES })) {
      expect(doc, `${name} points at docs/, which is gitignored`).not.toContain('docs/');
    }
  });

  it('covers what the brief asks a README to cover', () => {
    for (const heading of ['## Run it', '## How it', '## What I', 'Tests']) {
      expect(README, `README is missing a section for: ${heading}`).toContain(heading);
    }
  });
});

describe('claims that appear in both documents', () => {
  it('quotes one cart total, not two', () => {
    /**
     * Both narrate the same cart. When the discount fix changed what the store
     * returns, one of them kept the old figure — so every dollar amount attached
     * to two bottles has to agree.
     */
    const totals = new Set(
      [README, NOTES]
        .flatMap((doc) => [...doc.matchAll(/\$(\d+\.\d\d)\s+instead of|came back as \$(\d+\.\d\d)|charged \$?(\d+\.\d\d)/g)])
        .map((m) => m[1] ?? m[2] ?? m[3]),
    );
    expect(totals.size, `different cart totals quoted: ${[...totals].join(', ')}`).toBeLessThanOrEqual(1);
  });

  it('does not still claim the superseded $212.50 example', () => {
    // The figure that was right by luck and wrong in its explanation.
    for (const [name, doc] of Object.entries({ README, NOTES })) {
      expect(doc, `${name} still quotes the superseded total`).not.toContain('212.50');
    }
  });

  /**
   * NOTES states a count and then names a handful as examples. The count is the
   * kind of claim that goes stale — it was four for a while after it became
   * nine — and it is now stated in only one place, so what is checkable is that
   * the sentence still carries a number and still backs it with specifics.
   */
  it('states how many assumptions were wrong, and names some', () => {
    const word = /(\w+) assumptions turned out to be wrong/i.exec(NOTES)?.[1];
    expect(word, 'NOTES.md no longer states a count').toBeDefined();
    expect(['three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']).toContain(
      word!.toLowerCase(),
    );

    // Named examples carry a backtick or a proper noun; a bare count is a claim.
    const named = NOTES.slice(NOTES.indexOf(word!)).split('.').filter((s) => /`|Meta|Instagram|Shopify|Catalog/.test(s));
    expect(named.length, 'the count is stated but nothing is named').toBeGreaterThanOrEqual(3);
  });
});
