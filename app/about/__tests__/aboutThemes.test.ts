// @vitest-environment node
import postcss, { type Declaration, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';
import { ABOUT_THEMES_CSS } from '../aboutThemes';

// About in Light, Bright and Black (spec §5, R2-P1-2, P3-3; Black from the OLED spec's round 2), from the stylesheet AboutPage hoists: every text pair at
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
  if (color === 'transparent') return [0, 0, 0, 0];
  // #rgb, #rgba, #rrggbb and #rrggbbaa.
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

/** The near-black ground inside the portrait's frame, under the caption band (about.module.css's --about-frame-ground). */
const FRAME_GROUND = rgba('#101311');

describe('About in each theme', () => {
  it('sets nothing for Dark, which is today\'s About', () => {
    expect(ABOUT_THEMES_CSS).not.toMatch(/data-theme=dark|:not\(/);
  });

  it.each(['light', 'bright', 'black'])('%s reads: ink and ink soft at 4.5:1 and the link rule at 3:1 on its paper, the caption at 4.5:1 on its band', (theme) => {
    const t = themeTokens(theme);
    const paper = rgba(t['--lts-paper']);
    expect(contrast(over(t['--lts-ink'], paper), paper), 'ink').toBeGreaterThanOrEqual(4.5);
    expect(contrast(over(t['--lts-ink-soft'], paper), paper), 'ink soft').toBeGreaterThanOrEqual(4.5);
    // Black draws no rule round a link at rest; the brand's line lights it on hover and focus.
    if (theme !== 'black') expect(contrast(over(t['--lts-link-rule'], paper), paper), 'link rule').toBeGreaterThanOrEqual(3);
    // The nav's edge, the strong rule, still reads where it's drawn.
    expect(contrast(over(t['--lts-rule-strong'], paper), paper), 'strong rule').toBeGreaterThanOrEqual(3);
    // Black puts the frame's ground on its own black (--lts-frame-ground, which about.module.css reads).
    const band = over(t['--lts-caption-bg'], t['--lts-frame-ground'] ? rgba(t['--lts-frame-ground']) : FRAME_GROUND);
    expect(contrast(over(t['--lts-caption-ink'], band), band), 'caption').toBeGreaterThanOrEqual(4.5);
    // The body's ground under the page is the paper.
    expect(themeTokens(theme)['--gah-about-ground']).toBe(t['--lts-paper']);
  });

  it('puts Black on the screen\'s black: no paper, no ribs, no mat, no shadow, and the caption on the black', () => {
    const t = themeTokens('black');
    expect([t['--lts-paper'], t['--lts-frame'], t['--lts-frame-ground'], t['--gah-about-ground']]).toEqual(['#000', '#000', '#000', '#000']);
    expect([t['--lts-ribs'], t['--lts-shadow'], t['--lts-caption-bg']]).toEqual(['none', 'none', 'transparent']);
  });

  it('draws no line in Black: no hairline under the nav (C2-5), and no box or resting glow round a link', () => {
    const t = themeTokens('black');
    // --lts-rule's only reader is the About nav's bottom edge (SiteNav.module.css).
    expect([t['--lts-rule'], t['--lts-link-rule'], t['--about-glow-rest']]).toEqual(['transparent', 'transparent', '0']);
  });

  it("puts Bright's caption on the white mat under the print (P3-3), not on a band", () => {
    const t = themeTokens('bright');
    expect(t['--lts-caption-bg']).toBe(t['--lts-frame']);
  });
});
