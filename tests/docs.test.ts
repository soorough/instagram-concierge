import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The docs count things, and counts go stale silently.
 *
 * Three separate numbers drifted while this project was being written: the
 * "four assumptions that were wrong" became nine and stayed four in two files,
 * a cart total quoted in the README was superseded by a corrected one, and the
 * test count sat at 102 through twenty-four new tests. Nothing failed, because
 * prose is not executed.
 *
 * These assert the parts a machine can settle: that a stated count matches the
 * number of things actually listed, and that every file stating it agrees. They
 * cannot check that a quoted price is still what the store charges — that needs
 * the store — so the rule this encodes is narrower than "the docs are true".
 * It is "the docs do not contradict themselves", which is where the rot starts.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/**
 * Some documents are kept out of the published repo — the defense guide and the
 * demo script are working notes, not deliverables. They still deserve checking
 * when they are present, so they are read optionally and their assertions skip
 * when they are not. A test that fails on a fresh clone because a file was
 * deliberately excluded is a broken test, not a finding.
 */
const readIfPresent = (path: string): string | undefined => {
  try {
    return read(path);
  } catch {
    return undefined;
  }
};

const README = read('README.md');
const NOTES = read('NOTES.md');
const DEFENSE = readIfPresent('docs/defense-guide.md');
const DEMO = readIfPresent('docs/demo-script.md');

const WORD_TO_NUMBER: Record<string, number> = {
  three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** "Nine assumptions were disproved…" → 9 */
function statedCount(text: string, pattern: RegExp): number | undefined {
  const word = pattern.exec(text)?.[1]?.toLowerCase();
  return word ? WORD_TO_NUMBER[word] : undefined;
}

/** The body of a `## Heading` section, up to the next `## `. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, `section not found: ${heading}`).toBeGreaterThan(-1);
  const rest = text.slice(start + heading.length);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('the wrong-before-right list', () => {
  const readmeSection = section(README, '## Things that were wrong before they were right');
  const defenseSection = DEFENSE
    ? section(DEFENSE, '## 14. The things that were wrong before they were right')
    : undefined;

  /** Entries are `**Bold claim.** explanation` at the start of a line. */
  const readmeEntries = readmeSection.match(/^\*\*[^*]+\*\*/gm) ?? [];
  /** Entries are `1.`–`9.` at the start of a line. */
  const defenseEntries = defenseSection?.match(/^\d+\. /gm) ?? [];

  it('lists as many findings as the README claims', () => {
    const claimed = statedCount(README, /(\w+) assumptions were disproved/i);
    expect(claimed, 'README no longer states a count — update this test or restore it').toBeDefined();
    expect(readmeEntries).toHaveLength(claimed!);
  });

  it('agrees with NOTES.md, which states the same count', () => {
    const readmeClaim = statedCount(README, /(\w+) assumptions were disproved/i);
    const notesClaim = statedCount(NOTES, /(\w+) assumptions were wrong/i);
    expect(notesClaim, 'NOTES.md no longer states a count').toBeDefined();
    expect(notesClaim).toBe(readmeClaim);
  });

  it.runIf(DEFENSE)('agrees with the defense guide, which numbers them', () => {
    const claimed = statedCount(README, /(\w+) assumptions were disproved/i);
    expect(defenseEntries).toHaveLength(claimed!);
  });

  it.runIf(DEFENSE)('numbers the defense guide list consecutively from one', () => {
    // A renumbering slip is how 5,6,7,8 became 5,6,7,8,8 the first time.
    const numbers = defenseEntries.map((e) => Number.parseInt(e, 10));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });
});

describe('the stated test count', () => {
  /**
   * Every `# N tests` comment in the README, which appears twice — once under
   * setup and once under Tests. They drifted apart before.
   *
   * The absolute number is deliberately *not* asserted against the suite.
   * Counting `it(` statically gives 119 against a real 126, because two
   * `it.each` blocks expand to nine cases between them, and a check that is
   * quietly wrong is worse than no check. Anyone tempted to add that grep later:
   * this is why it isn't here.
   */
  const claims = [...README.matchAll(/#\s*(\d+) tests/g)].map((m) => Number(m[1]));

  it('is stated at least twice, so this test is actually guarding something', () => {
    expect(claims.length).toBeGreaterThanOrEqual(2);
  });

  it('is the same number everywhere it appears', () => {
    expect(new Set(claims).size, `README states different test counts: ${claims.join(', ')}`).toBe(1);
  });
});

describe('cross-document claims', () => {
  it('quotes one cart total, not two', () => {
    /**
     * The README, NOTES and the demo script each narrate the same cart. When the
     * discount fix changed what the store returns, one of them kept the old
     * figure — so every dollar amount attached to "two bottles" has to match.
     */
    const totals = new Set(
      [README, NOTES, DEMO].filter((d): d is string => d !== undefined)
        .flatMap((doc) => [...doc.matchAll(/\$(\d+\.\d\d)\s+instead of|came back as \$(\d+\.\d\d)|comes? to \$(\d+\.\d\d)/g)])
        .map((m) => m[1] ?? m[2] ?? m[3]),
    );
    expect(totals.size, `documents quote different cart totals: ${[...totals].join(', ')}`).toBeLessThanOrEqual(1);
  });

  it('does not still claim the superseded $212.50 example anywhere', () => {
    // The figure that was right by luck and wrong in its explanation.
    for (const [name, doc] of Object.entries({ README, NOTES, DEFENSE, DEMO })) {
      if (doc === undefined) continue;
      expect(doc, `${name} still quotes the superseded total`).not.toContain('212.50');
    }
  });
});
