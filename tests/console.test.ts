import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

/**
 * The console, loaded as a page.
 *
 * Everything else in this suite asserts on what leaves the system — a signed
 * delivery in, a recorded send out. That seam is right for the server and blind
 * to the console, which is 500 lines of DOM code that until now had neither
 * types nor tests. Every defect of the last few days lived there: a hardcoded
 * customer id racing its own configuration, a button re-enabled by the wrong
 * branch, and a lock screen that set `hidden` without hiding.
 *
 * That last one is why this file exists. `.lock { display: grid }` and the
 * browser's `[hidden] { display: none }` carry equal specificity, so the author
 * sheet won and the attribute stopped doing anything. The element reported
 * `hidden === true` throughout, which meant a test asserting on the property
 * would have passed while the lock sat on screen at full height.
 *
 * jsdom cannot reproduce that conflict — it applies `hidden` semantically
 * rather than through the cascade — so the rule is checked against the
 * stylesheet itself further down. A rendered assertion here would pass with the
 * bug present, which is how the first draft of this file was green against a
 * page that was broken.
 */

const HTML = readFileSync(new URL('../src/console/index.html', import.meta.url), 'utf8');

/** Renders the page far enough to inspect its cascade. Scripts do not run. */
const render = (): JSDOM => new JSDOM(HTML, { runScripts: 'outside-only' });

const displayOf = (dom: JSDOM, selector: string): string => {
  const el = dom.window.document.querySelector(selector);
  expect(el, `${selector} is missing from the page`).not.toBeNull();
  return dom.window.getComputedStyle(el as Element).display;
};

describe('the lock screen', () => {
  it('covers the page rather than sitting in the flow', () => {
    const dom = render();
    const lock = dom.window.document.querySelector('.lock') as HTMLElement;
    lock.hidden = false;
    const style = dom.window.getComputedStyle(lock);

    // It shipped once with no CSS at all, rendering as bare markup at the top.
    expect(style.position).toBe('fixed');
    expect(style.display).toBe('grid');
  });

  it('carries the field and the button it needs', () => {
    const { window } = render();
    expect(window.document.querySelector('#lock-form')).not.toBeNull();
    expect(window.document.querySelector('#lock-input')).not.toBeNull();
    expect(window.document.querySelector('#lock-error')).not.toBeNull();
    expect(window.document.querySelector('.lock__field button[type=submit]')).not.toBeNull();
  });
});

describe('the page', () => {
  it('loads its client as a module rather than inlining it', () => {
    const script = render().window.document.querySelector('script[type=module]');
    expect(script?.getAttribute('src')).toBe('./client.js');
  });

  it('has no inline script left to drift out of type-checking', () => {
    for (const s of render().window.document.querySelectorAll('script')) {
      expect(s.textContent?.trim(), 'inline script found — it would be unchecked').toBeFalsy();
    }
  });

  /**
   * `$('id')` throws when an element is absent, so a renamed id is a runtime
   * failure rather than a silent no-op. That trade only pays if the ids the
   * client reaches for actually exist, which is what this checks.
   */
  it('contains every element the client addresses by id', () => {
    const client = readFileSync(new URL('../src/console/client.ts', import.meta.url), 'utf8');
    const ids = [...client.matchAll(/\$(?:<[^>]+>)?\('([a-z-]+)'\)/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(5);

    const { window } = render();
    const missing = [...new Set(ids)].filter((id) => !window.document.getElementById(id));
    expect(missing, `client reads ids the page does not define: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('elements that toggle hidden', () => {
  /**
   * This is a static check on the stylesheet, and it has to be.
   *
   * The bug was a cascade conflict: `.lock { display: grid }` and the browser's
   * `[hidden] { display: none }` carry equal specificity, so the author sheet
   * won and `hidden` stopped hiding. jsdom cannot reproduce that — it applies
   * `hidden` semantically rather than through the cascade, so it reports
   * `display: none` whatever the stylesheet says. A rendered assertion there
   * passes with the bug present, which is exactly how the first version of this
   * file was green against a page that was broken.
   *
   * So the invariant is checked where it actually lives: if a selector gives an
   * element its own `display`, that element needs an explicit `[hidden]` rule to
   * win the tie. Catching it needs either this or a real browser.
   */
  const styles = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));
  const client = readFileSync(new URL('../src/console/client.ts', import.meta.url), 'utf8');

  /** Classes the client hides by setting `hidden`, found via the id it uses. */
  const hiddenClasses = [...client.matchAll(/\$(?:<[^>]+>)?\('([a-z-]+)'\)\.hidden\s*=/g)]
    .map((m) => m[1]!)
    .map((id) => {
      const el = render().window.document.getElementById(id);
      expect(el, `#${id} is toggled by the client but absent from the page`).not.toBeNull();
      return { id, classes: [...(el as Element).classList] };
    });

  it('finds the elements the client toggles', () => {
    expect(hiddenClasses.length).toBeGreaterThan(0);
  });

  it('gives every one an explicit [hidden] rule when it sets its own display', () => {
    const offenders: string[] = [];

    for (const { id, classes } of hiddenClasses) {
      for (const cls of classes) {
        // Does this class set a display of its own?
        const rule = new RegExp(`\\.${cls}\\s*\\{[^}]*display\\s*:`, 'm');
        if (!rule.test(styles)) continue;

        // Then it must also concede to [hidden], or the attribute does nothing.
        const concedes = new RegExp(`\\.${cls}\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none`, 'm');
        if (!concedes.test(styles)) {
          offenders.push(`#${id} (.${cls}) sets display but has no .${cls}[hidden] rule`);
        }
      }
    }

    expect(offenders, offenders.join('; ')).toEqual([]);
  });
});

/**
 * The panes must be bounded, or nothing inside them can scroll.
 *
 * This is the second layout defect in this file with the same shape, and jsdom
 * cannot catch either — it does not lay anything out, so a pane that grows to
 * ten thousand pixels reports exactly what a correct one does.
 *
 * The bug: `.shell` and `.thread` both set `min-height: 100vh`, which is a floor
 * and not a ceiling. The ledger records every delivery and grows all evening, so
 * the rail grew, the shell grew with it, and the composer — which follows the
 * log in the flow — scrolled off the bottom mid-demo. `overflow-y: auto` on the
 * log did nothing, because a flex child only scrolls when its container has a
 * height to be constrained by.
 *
 * So what is asserted is the invariant that actually failed: the shell fixes a
 * height rather than a minimum, and every pane that holds unbounded content can
 * both shrink and scroll.
 */
describe('the layout', () => {
  const styles = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));

  /** The body of the first `selector { … }` rule outside any media query. */
  const ruleFor = (selector: string): string => {
    const desktop = styles.slice(0, styles.indexOf('@media'));
    const m = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(desktop);
    expect(m, `no rule for ${selector}`).not.toBeNull();
    return m![1]!;
  };

  it('gives the shell a fixed height, not a floor it can grow past', () => {
    const shell = ruleFor('.shell');
    expect(shell, '.shell sets min-height, so both panes grow with their content').not.toMatch(
      /min-height\s*:\s*100/,
    );
    expect(shell, '.shell has no bounded height, so nothing inside it can scroll').toMatch(
      /(^|[^-])height\s*:\s*100(vh|dvh)/,
    );
  });

  it('lets the ledger scroll itself rather than pushing the page down', () => {
    // The rail holds the activity feed, which grows for as long as the demo runs.
    const rail = ruleFor('.rail');
    expect(rail, '.rail must scroll its own overflow').toMatch(/overflow-y\s*:\s*auto/);
    expect(rail, '.rail must be allowed to shrink below its content').toMatch(/min-height\s*:\s*0/);
  });

  it('keeps the composer in view by bounding the thread pane', () => {
    const thread = ruleFor('.thread');
    expect(thread, '.thread grows past the viewport, taking the composer with it').not.toMatch(
      /min-height\s*:\s*100/,
    );
    expect(thread).toMatch(/min-height\s*:\s*0/);
  });

  it('still scrolls as one page when the panes stack', () => {
    // Two panes cannot each own a viewport once they are on top of each other.
    const mobile = styles.slice(styles.indexOf('@media (max-width: 920px)'));
    expect(mobile, 'the stacked layout inherits a fixed height it cannot use').toMatch(
      /height\s*:\s*auto/,
    );
  });
});
