// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

// The shell paints from the theme's tokens alone (styles/themes.css): the nav
// and the theme control name no theme to paint and read no legacy variable,
// and the ground under them is body's --gah-ground, which the theme sets.
// Before the five themes (#21) these pinned one look for both; the tokens now
// carry each theme's look, and nothing in the shell's own rules does.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const source = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const parse = (file: string) => postcss.parse(source(file), { from: file });

/** The legacy theme variables app/globals.css swaps per theme. */
const LEGACY_VARIABLES = (() => {
  const names = new Set<string>();
  parse('app/globals.css').walkRules((rule) => {
    if (rule.selector !== ':root' && !rule.selector.includes('data-theme')) return;
    rule.walkDecls((decl) => {
      if (decl.prop.startsWith('--') && !decl.prop.startsWith('--focus-ring') && !decl.prop.startsWith('--font-')) names.add(decl.prop);
    });
  });
  return [...names];
})();

const SHELL_CSS = ['components/site/SiteNav.module.css', 'styles/theme-menu-popover.css'];
const SHELL_TSX = ['components/site/SiteNav.tsx', 'components/ThemeMenu.tsx'];

/** The rules whose selector names a theme. */
function themedRules(file: string): Rule[] {
  const found: Rule[] = [];
  parse(file).walkRules((rule) => {
    if (rule.selector.includes('data-theme')) found.push(rule);
  });
  return found;
}

describe('the legacy theme variables', () => {
  it('are found, so the checks below have something to look for', () => {
    expect(LEGACY_VARIABLES).toEqual(expect.arrayContaining(['--background-color', '--primary-color', '--overlay-bg-color']));
  });
});

describe.each(SHELL_CSS)('%s', (file) => {
  it('reads no legacy theme variable', () => {
    const css = source(file);
    expect(LEGACY_VARIABLES.filter((name) => new RegExp(`var\\(\\s*${name}\\b`).test(css))).toEqual([]);
  });

  it('names no theme to paint: the tokens do', () => {
    const problems: string[] = [];
    for (const rule of themedRules(file)) {
      rule.walkDecls((decl) => {
        if (!(decl.prop === 'display' && decl.value === 'none')) problems.push(`${rule.selector} sets ${decl.prop}: ${decl.value}`);
      });
    }
    expect(problems).toEqual([]);
  });
});

describe("styles/themes.css's theme control rules", () => {
  // The button's rules live in the global themes.css (the chunking trap), beside the theme blocks themselves.
  const declarations: string[] = [];
  parse('styles/themes.css').walkRules((rule) => {
    if (!rule.selector.includes('theme-menu')) return;
    rule.walkDecls((decl) => {
      declarations.push(`${rule.selector} { ${decl.prop}: ${decl.value} }`);
    });
  });

  it('are found', () => {
    expect(declarations.length).toBeGreaterThan(10);
  });

  it('read no legacy theme variable', () => {
    expect(declarations.filter((line) => LEGACY_VARIABLES.some((name) => new RegExp(`var\\(\\s*${name}\\b`).test(line)))).toEqual([]);
  });
});

describe.each(SHELL_TSX)('%s', (file) => {
  it('has no dark: variant', () => {
    expect(source(file)).not.toMatch(/\bdark:/);
  });
});

describe('the ground under the shell', () => {
  const globals = parse('app/globals.css');

  /** Every background-color the bare `html` and `body` rules set, and every one a themed rule sets on either. */
  function grounds() {
    const plain: { selector: string; value: string }[] = [];
    const themed: string[] = [];
    globals.walkRules((rule) => {
      for (const selector of rule.selectors) {
        const target = selector.trim().split(/\s+/).at(-1);
        if (target !== 'html' && target !== 'body' && !/\[data-theme[^\]]*\]$/.test(selector.trim())) continue;
        rule.walkDecls(/^background(-color)?$/, (decl) => {
          if (selector.includes('data-theme')) themed.push(`${selector} sets ${decl.prop}: ${decl.value}`);
          else plain.push({ selector: selector.trim(), value: decl.value });
        });
      }
    });
    return { plain, themed };
  }

  // html stays unpainted, so the canvas takes body's ground: the window's edge, overscroll included, shows About's
  // paper and the Viewer's ground where their body rules override it, and --gah-ground everywhere else.
  it("is --gah-ground on body alone, so the nav glass and the strip below a short page read the theme's ground", () => {
    const { plain } = grounds();
    expect(plain).toEqual([{ selector: 'body', value: 'var(--gah-ground)' }]);
  });

  it("gives body the shell's ink, so text that sets no color of its own reads on that ground in every theme", () => {
    const colors: string[] = [];
    globals.walkRules((rule) => {
      if (!rule.selectors.some((selector) => selector.trim() === 'body')) return;
      rule.walkDecls('color', (decl) => {
        colors.push(decl.value);
      });
    });
    expect(colors).toEqual(['var(--gah-ink)']);
  });

  it('is never set per theme in globals: the theme reaches it through --gah-ground', () => {
    expect(grounds().themed).toEqual([]);
  });
});
