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
