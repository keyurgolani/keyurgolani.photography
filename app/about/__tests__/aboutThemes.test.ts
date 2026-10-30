// @vitest-environment node
import postcss, { type Declaration, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';
import { ABOUT_THEMES_CSS } from '../aboutThemes';

// About in Light, Bright and Dark (spec §5, R2-P1-2, P3-3), from the stylesheet AboutPage hoists: every text pair at
// 4.5:1 and the link rule at 3:1 on the paper, and the caption on what sits under it. Dark sets nothing (today's).

function themeTokens(theme: string) {
  const found: Record<string, string> = {};
  postcss.parse(ABOUT_THEMES_CSS).walkRules((rule: Rule) => {
    if (rule.selector.startsWith(`html[data-theme=${theme}]`)) rule.walkDecls((decl: Declaration) => void (found[decl.prop] = decl.value));
  });
  return found;
}

type Rgba = [number, number, number, number];
function rgba(color: string): Rgba {
  const short = /^#([0-9a-f]{3})$/i.exec(color);
  if (short) return [...short[1]].map((h) => parseInt(h + h, 16)).concat(1) as Rgba;
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) return [0, 2, 4].map((at) => parseInt(hex[1].slice(at, at + 2), 16)).concat(1) as Rgba;
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

/** The near-black ground inside the portrait's frame, under the caption band (about.module.css's --about-frame-ground). */
const FRAME_GROUND = rgba('#101311');

describe('About in each theme', () => {
  it('sets nothing for Dark, which is today\'s About', () => {
    expect(ABOUT_THEMES_CSS).not.toMatch(/data-theme=black|:not\(/);
  });

  it.each(['light', 'bright'])('%s reads: ink and ink soft at 4.5:1 and the link rule at 3:1 on its paper, the caption at 4.5:1 on its band', (theme) => {
    const t = themeTokens(theme);
    const paper = rgba(t['--lts-paper']);
    expect(contrast(over(t['--lts-ink'], paper), paper), 'ink').toBeGreaterThanOrEqual(4.5);
    expect(contrast(over(t['--lts-ink-soft'], paper), paper), 'ink soft').toBeGreaterThanOrEqual(4.5);
    expect(contrast(over(t['--lts-link-rule'], paper), paper), 'link rule').toBeGreaterThanOrEqual(3);
    const band = over(t['--lts-caption-bg'], FRAME_GROUND);
    expect(contrast(over(t['--lts-caption-ink'], band), band), 'caption').toBeGreaterThanOrEqual(4.5);
    // The body's ground under the page is the paper.
    expect(themeTokens(theme)['--gah-about-ground']).toBe(t['--lts-paper']);
  });

  it("puts Bright's caption on the white mat under the print (P3-3), not on a band", () => {
    const t = themeTokens('bright');
    expect(t['--lts-caption-bg']).toBe(t['--lts-frame']);
  });
});
