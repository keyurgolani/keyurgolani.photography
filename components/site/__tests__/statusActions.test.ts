// @vitest-environment node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss, { type Declaration, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

// The status page's secondary action in every theme (#126's Delta 1, L5'): global-error.tsx's way home, which no
// browser test reaches, since a root layout that throws can't be staged in e2e. It is StatusPage's plain action: its
// edge the strong rule and its label the ink, on the ground. Read from the stylesheets themselves and resolved against
// each theme's own tokens, so a theme that moves its ground or its strong rule has to keep the pair readable.

const read = (relative: string) => postcss.parse(fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'));
const STATUS = read('../StatusPage.module.css');
const TOKENS = read('../../../styles/tokens.css');
const THEMES = read('../../../styles/themes.css');

/** Every top-level declaration on a selector, later ones winning. */
function declared(root: postcss.Root, selector: string) {
  const found: Record<string, string> = {};
  root.walkRules((rule: Rule) => {
    if (rule.parent?.type === 'root' && rule.selectors.includes(selector)) rule.walkDecls((decl: Declaration) => void (found[decl.prop] = decl.value));
  });
  return found;
}

/** A theme's tokens: today's in tokens.css, under its own block in themes.css. */
const themeTokens = (theme: string) => ({ ...declared(TOKENS, ':root'), ...declared(THEMES, `html[data-theme='${theme}']`) });

function resolve(value: string, tokens: Record<string, string>): string {
  return value.replace(/var\((--[a-z0-9-]+)(?:,\s*([^)]+))?\)/g, (_, name: string, fallback?: string) => {
    const found = tokens[name] ?? fallback;
    if (found === undefined) throw new Error(`${name} is unset`);
    return resolve(found, tokens);
  });
}

type Rgba = [number, number, number, number];
function rgba(color: string): Rgba {
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join('') : hex;
    const [r, g, b, a = 255] = (full.match(/../g) ?? []).map((pair) => parseInt(pair, 16));
    return [r, g, b, a / 255];
  }
  const parts = /^rgba?\(([^)]+)\)$/.exec(color)![1].split(/[\s,/]+/).map(Number);
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}
const over = (top: string, under: Rgba): Rgba => {
  const [r, g, b, a] = rgba(top);
  return [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a), 1];
};
const luminance = ([r, g, b]: number[]) =>
  [r, g, b].map((channel) => (channel / 255 <= 0.03928 ? channel / 255 / 12.92 : ((channel / 255 + 0.055) / 1.055) ** 2.4)).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a: number[], b: number[]) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

describe("the status page's secondary action", () => {
  const action = declared(STATUS, '.actions > a');
  const page = declared(STATUS, '.page');

  it('is the plain action: no fill, the ink, the strong rule, on the page ground', () => {
    expect(action.background).toBe('none');
    expect(action.color).toBe('var(--gah-ink)');
    expect(action.border).toBe('1px solid var(--gah-rule-strong)');
    expect(page.background).toBe('var(--gah-ground)');
  });

  it.each(['dark', 'black', 'light', 'bright'])('reads in %s: its edge at 3:1 and its label at 4.5:1 on the ground', (theme) => {
    const tokens = themeTokens(theme);
    const ground = rgba(resolve(page.background, tokens));
    const edge = resolve(action.border.replace(/^1px solid /, ''), tokens);
    expect(contrast(over(edge, ground), ground), `the edge in ${theme}`).toBeGreaterThanOrEqual(3);
    expect(contrast(over(resolve(action.color, tokens), ground), ground), `the label in ${theme}`).toBeGreaterThanOrEqual(4.5);
  });
});
