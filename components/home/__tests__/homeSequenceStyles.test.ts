// @vitest-environment node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss, { type AtRule, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

// #4's framing (v2.0.0 B7), from HomeSequence.module.css itself: a cover crop is cut on the photograph's focal point,
// a contain one sits whole on the theme's mat, and the sheet keeps no class Home doesn't render (#6 item 17).

const read = (name: string) => fs.readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');
const CSS = read('HomeSequence.module.css');
const root = postcss.parse(CSS);

/** The declarations on `selector`, outside any at-rule, with `!important` kept on the value. */
function declarations(selector: string): Record<string, string> {
  const found: Record<string, string> = {};
  root.walkRules((rule: Rule) => {
    if (rule.parent?.type === 'root' && rule.selectors.includes(selector)) {
      rule.walkDecls((decl) => void (found[decl.prop] = decl.important ? `${decl.value} !important` : decl.value));
    }
  });
  return found;
}

describe("Home's slide framing", () => {
  it("cuts a cover crop on the photograph's focal point, centred when it has none", () => {
    const image = declarations('.slideImage');
    expect(image['object-fit']).toBe('cover');
    expect(image['object-position']).toBe('var(--focal-x, 50%) var(--focal-y, 50%)');
    // The LQIP under the opening photograph crops where the image will (ResponsivePhoto's --photo-lqip-position).
    expect(declarations('.slide')['--photo-lqip-position']).toBe('var(--focal-x, 50%) var(--focal-y, 50%)');
  });

  it("shows a contain crop whole and centred on the theme's mat, its LQIP inside the print and not across the mat", () => {
    const slide = declarations(".slide[data-crop='contain']");
    expect(slide['--photo-lqip-position']).toBe('center');
    const image = declarations(".slide[data-crop='contain'] .slideImage");
    expect(image['object-fit']).toBe('contain');
    expect(image['object-position']).toBe('center');
    // ResponsivePhoto draws the LQIP as an inline `background-size: cover`, which only `!important` outranks.
    expect(image['background-size']).toBe('contain !important');
    expect(image['background-repeat']).toBe('no-repeat');
    // Once the print has decoded, the LQIP goes: its own shape drifts from the photograph's, so it would show as a strip on
    // the mat around the print (B7 review).
    expect(declarations(".slide[data-crop='contain'][data-decoded] .slideImage")['background-image']).toBe('none !important');
    // The mat is the carousel's ground: each theme's --gah-mat-fill (HomeChrome.module.css), Dark's and Black's black.
    expect(declarations('.carousel')['background-color']).toBe('var(--gah-mat-fill, #000)');
    expect(declarations('.slide').background).toBeUndefined();
    expect(declarations('.slide')['background-color']).toBeUndefined();
  });

  it("gives Light and Bright a mat of their own, and leaves Dark's and Black's to the carousel's black", () => {
    const chrome = postcss.parse(read('HomeChrome.module.css'));
    const mat = (theme: string) => {
      let value: string | undefined;
      chrome.walkRules((rule: Rule) => {
        if (rule.selectors.some((selector) => selector === `:global(html[data-theme='${theme}']) .root`)) rule.walkDecls('--gah-mat-fill', (decl) => void (value = decl.value));
      });
      return value;
    };
    expect([mat('light'), mat('bright'), mat('dark'), mat('black')]).toEqual(['#f8f5ee', '#fff', undefined, undefined]);
  });
});

describe("Home's slide stylesheet", () => {
  it('has none of the dead thumbnail, optimized-layer or placeholder classes, nor their shimmer', () => {
    for (const name of ['thumbnailLayer', 'optimizedLayer', 'slidePlaceholder']) expect(CSS, name).not.toMatch(new RegExp(`\\.${name}\\b`));
    const keyframes: string[] = [];
    root.walkAtRules('keyframes', (rule: AtRule) => void keyframes.push(rule.params));
    expect(keyframes).toEqual(['home-slow-zoom']);
  });

  it('defines only classes CatalogSequence renders', () => {
    const classes = new Set<string>();
    root.walkRules((rule: Rule) => {
      for (const match of rule.selector.replace(/:global\([^)]*\)/g, '').matchAll(/\.([A-Za-z][\w-]*)/g)) classes.add(match[1]);
    });
    const source = read('CatalogSequence.tsx');
    expect([...classes].filter((name) => !source.includes(`styles.${name}`))).toEqual([]);
  });
});
