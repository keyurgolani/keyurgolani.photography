// @vitest-environment node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss, { type AtRule, type Container, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

// #4's All bodies of work (v2.0.0 B7's CI fix), from CatalogHome.module.css itself. On a phone at default text it sits
// beside Enter the series rather than under it, so the story is no taller than next's: under it, the copy rose 52 px
// and Dark's fixed phone wash, which stays today's, left the title at 4.03:1 over a white photograph on Pixel 7.

const CSS = fs.readFileSync(fileURLToPath(new URL('../CatalogHome.module.css', import.meta.url)), 'utf8');
const sheet = postcss.parse(CSS);

/** The declarations on `selector` directly inside `container`, with `!important` kept on the value. */
function declarations(container: Container, selector: string): Record<string, string> {
  const found: Record<string, string> = {};
  container.each((node) => {
    if (node.type === 'rule' && (node as Rule).selectors.includes(selector)) {
      (node as Rule).walkDecls((decl) => void (found[decl.prop] = decl.important ? `${decl.value} !important` : decl.value));
    }
  });
  return found;
}

/** The at-rule `name` with `params` directly inside `container`. */
function atRule(container: Container, name: string, params: string): AtRule | undefined {
  let found: AtRule | undefined;
  container.each((node) => {
    if (node.type === 'atrule' && (node as AtRule).name === name && (node as AtRule).params === params) found = node as AtRule;
  });
  return found;
}

const px = (value: string) => {
  const match = /^(-?[\d.]+)(px|rem)$/.exec(value.trim());
  if (!match) throw new Error(`not a length: ${value}`);
  return parseFloat(match[1]) * (match[2] === 'rem' ? 16 : 1);
};

const PHONE = '(min-width: 22.5rem) and (max-width: 39.99rem)';
const WORK = ':global(main:not([data-text-enlarged])) .work';

describe('All bodies of work on a phone', () => {
  const enter = declarations(sheet, '.enter');
  const work = declarations(sheet, '.work');
  const phone = atRule(sheet, 'media', PHONE);

  it('keeps both a full 44 px target, stacked 0.5rem apart from 40rem up', () => {
    expect(enter['min-height']).toBe('44px');
    expect(work['min-height']).toBe('44px');
    expect(work['margin-top']).toBe('0.5rem');
  });

  it('sits beside Enter the series from 360 px to the phone breakpoint, at default text', () => {
    expect(phone, `@media ${PHONE}`).toBeDefined();
    expect(px('22.5rem')).toBe(360);
    // Beside Enter, top to top, the desktop pair's 0.5rem apart: Enter is the anchor.
    expect(enter['anchor-name']).toBe('--home-enter');
    const anchored = declarations(atRule(phone!, 'supports', '(anchor-name: --home-enter)')!, WORK);
    expect(anchored).toMatchObject({ position: 'absolute', 'position-anchor': '--home-enter', top: 'anchor(top)', left: 'anchor(right)', 'margin-top': '0', 'margin-left': '0.5rem' });
  });

  it("adds no height to the story column there, so the copy sits where next's did", () => {
    // Anchored, it's out of the column's flow.
    expect(declarations(atRule(phone!, 'supports', '(anchor-name: --home-enter)')!, WORK).position).toBe('absolute');
    // Where anchoring isn't supported, it rides Enter's row at the column's end: a margin that takes back its height.
    const fallback = declarations(atRule(phone!, 'supports', 'not (anchor-name: --home-enter)')!, WORK);
    expect(fallback['align-self']).toBe('flex-end');
    expect(px(fallback['margin-top']) + px(work['min-height'])).toBe(0);
  });

  it('keeps it under Enter at enlarged text, where Dark’s wash follows the copy as it does today', () => {
    // Only `main:not([data-text-enlarged])` moves it, and nothing else in the phone query touches it.
    const selectors: string[] = [];
    phone?.walkRules((rule: Rule) => void selectors.push(...rule.selectors));
    expect(selectors.filter((selector) => selector.includes('.work'))).toEqual([WORK, WORK]);
  });
});

// Dark's phone wash, from HomeChrome.module.css. From 380 px it's today's fixed wash at default text, pixel for pixel
// (Dark parity). Under 380 px that wash left the title at 4.319:1 over a white photograph at 360 px, so there it
// follows the copy at every text size, as it does at enlarged text everywhere on a phone.
const CHROME = postcss.parse(fs.readFileSync(fileURLToPath(new URL('../HomeChrome.module.css', import.meta.url)), 'utf8'));

const DARK = ":global(html[data-theme='dark'])";
const TODAY = 'linear-gradient(0deg, rgb(8 10 9 / 0.92) 0%, rgb(8 10 9 / 0.28) 66%, rgb(8 10 9 / 0.12) 100%)';

/** Every top-level `@media (max-width: …)` query's width in px. */
const maxWidths = () => {
  const found: { query: AtRule; px: number }[] = [];
  CHROME.each((node) => {
    const match = node.type === 'atrule' && (node as AtRule).name === 'media' && /^\(max-width: ([\d.]+(?:px|rem))\)$/.exec((node as AtRule).params);
    if (match) found.push({ query: node as AtRule, px: px(match[1]) });
  });
  return found;
};

describe("Dark's phone wash under 380 px", () => {
  const phone = atRule(CHROME, 'media', '(max-width: 39.99rem)')!;
  const enlarged = declarations(phone, `${DARK} .root[data-text-enlarged] .vignette`);
  const narrow = maxWidths().filter(({ px: width }) => width >= 379 && width < 380);

  it("keeps today's fixed wash on a phone from 380 px", () => {
    expect(declarations(phone, '.vignette').background).toBe(TODAY);
  });

  it('follows the copy below 380 px at default text, as at enlarged text', () => {
    expect(narrow, 'one query for 379 px and under').toHaveLength(1);
    const wash = declarations(narrow[0].query, `${DARK} .vignette`);
    expect(enlarged['--home-hold-at']).toBe('calc(100% - var(--home-copy-top, 66%) + 1.5rem)');
    expect(wash['--home-hold-at']).toBe(enlarged['--home-hold-at']);
    expect(wash.background).toBe(enlarged.background);
    // At 0.86 up to the copy's top, and a step past it.
    expect(wash.background).toMatch(/rgb\(8 10 9 \/ 0\.86\) var\(--home-hold-at\)/);
  });

  it('touches only Dark there', () => {
    const selectors: string[] = [];
    narrow[0]?.query.walkRules((rule: Rule) => void selectors.push(...rule.selectors));
    expect(selectors).toEqual([`${DARK} .vignette`]);
  });
});
