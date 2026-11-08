// @vitest-environment node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

// A photograph authored `contain` is shown whole, so it has no crop for a focal point to steer. Work's cover and the
// series page's cover centre it, as Home does (HomeSequence.module.css), from the stylesheets themselves. On Work, where
// the frame's shape isn't the photograph's, its LQIP stays inside the print and goes once the print has decoded.

const read = (path: string) => fs.readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

/** The declarations on `selector` in `css`, outside any at-rule, with `!important` kept on the value. */
function declarations(css: string, selector: string): Record<string, string> {
  const found: Record<string, string> = {};
  postcss.parse(css).walkRules((rule: Rule) => {
    if (rule.parent?.type === 'root' && rule.selectors.includes(selector)) {
      rule.walkDecls((decl) => void (found[decl.prop] = decl.important ? `${decl.value} !important` : decl.value));
    }
  });
  return found;
}

describe('contain framing', () => {
  it("Work's cover cuts a cover crop on the focal point and centres a contain photograph", () => {
    const css = read('../SeriesCatalog.module.css');
    expect(declarations(css, '.cover')['object-position']).toBe('var(--focal-x, 50%) var(--focal-y, 50%)');
    const contain = declarations(css, ".frame[data-cover='contain'] .cover");
    expect(contain['object-fit']).toBe('contain');
    expect(contain['object-position']).toBe('center');
  });

  it("Work's contain cover keeps its LQIP inside the print while it loads, and drops it once the print has decoded", () => {
    const css = read('../SeriesCatalog.module.css');
    const contain = declarations(css, ".frame[data-cover='contain'] .cover");
    // ResponsivePhoto draws the LQIP as an inline `background-size: cover` across the whole box, which only `!important`
    // outranks. Without it the LQIP fills the bands beside the print.
    expect(contain['background-size']).toBe('contain !important');
    expect(contain['background-repeat']).toBe('no-repeat');
    // The LQIP's own shape drifts from the photograph's, so even inside the print's box it would show as a strip.
    expect(declarations(css, ".frame[data-cover='contain'][data-decoded] .cover")['background-image']).toBe('none !important');
    // A cover crop's LQIP sits under the print and never shows, so it keeps it.
    expect(declarations(css, '.cover')['background-image']).toBeUndefined();
  });

  it("the series page's cover cuts a cover crop on the focal point and centres a contain photograph", () => {
    const css = read('../../series/SeriesPage.module.css');
    expect(declarations(css, '.coverFrame .image')['object-position']).toBe('var(--focal-x, 50%) var(--focal-y, 50%)');
    const contain = declarations(css, ".coverFrame[data-photo='contain'] .image");
    expect(contain['object-fit']).toBe('contain');
    expect(contain['object-position']).toBe('center');
  });
});
