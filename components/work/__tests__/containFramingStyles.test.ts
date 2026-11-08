// @vitest-environment node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

// A photograph authored `contain` is shown whole, so it has no crop for a focal point to steer. Work's cover and the
// series page's cover centre it, as Home does (HomeSequence.module.css), from the stylesheets themselves.

const read = (path: string) => fs.readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

/** The declarations on `selector` in `css`, outside any at-rule. */
function declarations(css: string, selector: string): Record<string, string> {
  const found: Record<string, string> = {};
  postcss.parse(css).walkRules((rule: Rule) => {
    if (rule.parent?.type === 'root' && rule.selectors.includes(selector)) {
      rule.walkDecls((decl) => void (found[decl.prop] = decl.value));
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

  it("the series page's cover cuts a cover crop on the focal point and centres a contain photograph", () => {
    const css = read('../../series/SeriesPage.module.css');
    expect(declarations(css, '.coverFrame .image')['object-position']).toBe('var(--focal-x, 50%) var(--focal-y, 50%)');
    const contain = declarations(css, ".coverFrame[data-photo='contain'] .image");
    expect(contain['object-fit']).toBe('contain');
    expect(contain['object-position']).toBe('center');
  });
});
