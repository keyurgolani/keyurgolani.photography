// @vitest-environment node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss, { type Declaration, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

// The Viewer in each theme (spec §3 and §5, R2-P1-1), from StoryViewer.module.css itself: Black sets nothing and
// falls back to today's values, the other three each set their whole room, and every text and control pair reads.

const CSS = fs.readFileSync(fileURLToPath(new URL('../StoryViewer.module.css', import.meta.url)), 'utf8');
const SURFACE = fs.readFileSync(fileURLToPath(new URL('../../../styles/surfaces/chromatic-chapters.css', import.meta.url)), 'utf8');
const root = postcss.parse(CSS);

/** Every custom property a theme's rules declare, the shared rule included. */
function tokens(theme: string, scope: '.viewer' | ':has') {
  const found: Record<string, string> = {};
  root.walkRules((rule: Rule) => {
    const mine = rule.selectors.some((selector) => selector.includes(`[data-theme='${theme}']`) && (scope === ':has' ? selector.includes(':has(') : selector.endsWith(' .viewer')));
    if (mine) rule.walkDecls((decl: Declaration) => void (found[decl.prop] = decl.value));
  });
  return found;
}

/** A declaration's value on a selector, outside any at-rule. */
function value(selector: string, prop: string) {
  let found: string | undefined;
  root.walkRules((rule: Rule) => {
    if (rule.parent?.type === 'root' && rule.selectors.includes(selector)) rule.walkDecls(prop, (decl) => void (found = decl.value));
  });
  return found;
}

function rgba(color: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) return [0, 2, 4].map((at) => parseInt(hex[1].slice(at, at + 2), 16)).concat(1) as [number, number, number, number];
  const parts = /^rgba?\(([^)]+)\)$/.exec(color)![1].split(/[\s,/]+/).map(Number);
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}
const over = (top: string, under: [number, number, number, number]): [number, number, number, number] => {
  const [r, g, b, a] = rgba(top);
  return [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a), 1];
};
const luminance = ([r, g, b]: number[]) =>
  [r, g, b].map((channel) => (channel / 255 <= 0.03928 ? channel / 255 / 12.92 : ((channel / 255 + 0.055) / 1.055) ** 2.4)).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a: number[], b: number[]) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

const THEMES = ['dark', 'light', 'bright'] as const;
const CC = ['--cc-ground', '--cc-ink', '--cc-ink-soft', '--cc-caption-ink', '--cc-label', '--cc-chrome', '--cc-rule', '--cc-rule-strong'];

describe('the Viewer in Black', () => {
  it('has no rule of its own and no branch against it, so it is today\'s Viewer', () => {
    expect(CSS).not.toMatch(/data-theme='black'|data-theme="black"|:not\(\[data-theme/);
  });

  it("falls back to v1.2.0's own values", () => {
    expect(value(':global(body):has(.viewer)', 'background-color')).toBe('var(--gah-viewer-ground, #111513)');
    expect(value('.viewer::backdrop', 'background')).toBe('var(--gah-viewer-ground, #111513)');
    expect(value('.viewer', 'color-scheme')).toBe('var(--gah-color-scheme, dark)');
    expect(value('.image', 'outline')).toBe('var(--gah-viewer-image-outline, 1px solid var(--cc-rule))');
    expect(value('.image', 'object-fit')).toBe('var(--gah-viewer-fit, fill)');
    expect(value('.frame', 'box-shadow')).toBe('var(--viewer-surround)');
    expect(value('.caption', 'color')).toBe('var(--cc-caption-ink, inherit)');
    // Today's bands are the surface's.
    expect(SURFACE).toContain('--cc-bands: linear-gradient(');
  });
});

describe.each(THEMES)('the Viewer in %s', (theme) => {
  const viewer = tokens(theme, '.viewer');
  const html = tokens(theme, ':has');

  it('sets its whole room: no bands, its own inks, a solid panel, a matted print and no hairline', () => {
    for (const name of CC) expect(viewer[name], name).toBeDefined();
    expect(viewer['--cc-bands']).toBe('none');
    expect(viewer['--gah-viewer-image-outline']).toBe('none');
    expect(viewer['--gah-viewer-fit']).toBe('contain');
    expect(viewer['--gah-surround-lg']).toBeDefined();
    expect(rgba(viewer['--cc-chrome'])[3], 'the bars are solid').toBe(1);
    // The body and the modal's backdrop are the same ground.
    expect(html['--gah-viewer-ground']).toBe(viewer['--cc-ground']);
  });

  it("reserves the lg surround's real thickness", () => {
    const spreads = [...viewer['--gah-surround-lg'].matchAll(/0 0 0 (\d+)px/g)].map((match) => Number(match[1]));
    expect(`${Math.max(...spreads)}px`).toBe(viewer['--gah-room-lg']);
  });

  it('reads: every text pair at 4.5:1 and the control edge at 3:1, on the ground and on the bars', () => {
    const ground = rgba(viewer['--cc-ground']);
    const chrome = over(viewer['--cc-chrome'], ground);
    for (const [ink, on, min] of [
      ['--cc-ink', chrome, 4.5],
      ['--cc-ink-soft', chrome, 4.5],
      ['--cc-caption-ink', ground, 4.5],
      ['--cc-label', chrome, 4.5],
      ['--cc-label', ground, 4.5],
      ['--cc-rule-strong', ground, 3],
    ] as const) {
      expect(contrast(over(viewer[ink], on), on), `${ink} in ${theme}`).toBeGreaterThanOrEqual(min);
    }
  });
});
