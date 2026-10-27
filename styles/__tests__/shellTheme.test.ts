// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

// #21: the shell looks the same under both themes, and the light theme drives
// only the legacy variables and dark: variants. These read the shell's own
// stylesheets and the ground under it, so no theme value reaches the nav, its
// toggle, or the html and body the nav's glass sits over.

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

const SHELL_CSS = ['components/site/SiteNav.module.css', 'components/ThemeToggle.module.css'];
const SHELL_TSX = ['components/site/SiteNav.tsx', 'components/ThemeToggle.tsx'];

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

  it('names a theme only to swap the toggle icon and name, never to paint', () => {
    const problems: string[] = [];
    for (const rule of themedRules(file)) {
      rule.walkDecls((decl) => {
        if (!(decl.prop === 'display' && decl.value === 'none')) problems.push(`${rule.selector} sets ${decl.prop}: ${decl.value}`);
      });
    }
    expect(problems).toEqual([]);
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

  it('is --gah-ground on html and body, so the nav glass and the strip below a short page read the same in both themes', () => {
    const { plain } = grounds();
    expect(plain).toEqual([
      { selector: 'html', value: 'var(--gah-ground)' },
      { selector: 'body', value: 'var(--gah-ground)' },
    ]);
  });

  it('never changes with the theme', () => {
    expect(grounds().themed).toEqual([]);
  });
});
