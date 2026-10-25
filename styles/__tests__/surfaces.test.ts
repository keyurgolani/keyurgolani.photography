// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss, { type Container, type Declaration, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const STYLES = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string) => postcss.parse(fs.readFileSync(path.join(STYLES, file), 'utf8'), { from: file });

const SURFACES = [
  { file: 'surfaces/light-takes-shape.css', attribute: "[data-surface='about']" },
  { file: 'surfaces/chromatic-chapters.css', attribute: "[data-surface='viewer']" },
] as const;

/** The surface-only colors, which the all-routes tokens may not carry. The shared rgba(255, 255, 255, 0.17) neutral is fine. */
const SURFACE_HEXES = ['#f4ecd7', '#292a28', '#5b564c', '#111513', '#101413', '#151918', '#f6f4ee', '#d3d6d1', '#a9b3ae'];

/** Every rule in `root`, with whether it sits inside an at-rule other than @media. */
function rules(root: Container) {
  const found: { rule: Rule; outsideMedia: boolean }[] = [];
  root.walkRules((rule) => {
    let outsideMedia = false;
    for (let parent = rule.parent; parent && parent.type !== 'root'; parent = parent.parent) {
      if (parent.type === 'atrule' && (parent as { name: string }).name !== 'media') outsideMedia = true;
    }
    found.push({ rule, outsideMedia });
  });
  return found;
}

function hexToRgb(hex: string) {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function luminance([r, g, b]: number[]) {
  const [R, G, B] = [r, g, b].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(hexToRgb(a)), luminance(hexToRgb(b))].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

describe('styles/tokens.css', () => {
  it('holds no Light Takes Shape or Chromatic Chapters color, since it applies on every route', () => {
    const css = fs.readFileSync(path.join(STYLES, 'tokens.css'), 'utf8').toLowerCase();
    expect(SURFACE_HEXES.filter((hex) => css.includes(hex))).toEqual([]);
  });
});

describe.each(SURFACES)('$file', ({ file, attribute }) => {
  const root = read(file);

  it(`declares only custom properties, under selectors that start with ${attribute}`, () => {
    const problems: string[] = [];
    for (const { rule, outsideMedia } of rules(root)) {
      if (outsideMedia) problems.push(`${rule.selector} sits in an at-rule other than @media`);
      for (const selector of rule.selectors) {
        if (!selector.trim().startsWith(attribute)) problems.push(`${selector} doesn't start with ${attribute}`);
      }
      rule.each((node) => {
        if (node.type === 'decl' && !(node as Declaration).prop.startsWith('--')) problems.push(`${rule.selector} sets ${(node as Declaration).prop}`);
      });
    }
    root.each((node) => {
      if (node.type === 'decl') problems.push(`a top-level ${node.prop}`);
    });
    expect(problems).toEqual([]);
  });
});

describe('the Light Takes Shape paper', () => {
  const values = new Map<string, string>();
  read('surfaces/light-takes-shape.css').walkDecls((decl) => {
    if (!values.has(decl.prop)) values.set(decl.prop, decl.value);
  });

  it.each(['--lts-ink', '--lts-ink-soft'])('keeps %s at 4.5:1 on --lts-paper', (ink) => {
    expect(contrast(values.get(ink)!, values.get('--lts-paper')!)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the Chromatic Chapters text', () => {
  const values = new Map<string, string>();
  read('surfaces/chromatic-chapters.css').walkDecls((decl) => {
    if (!values.has(decl.prop)) values.set(decl.prop, decl.value);
  });

  // The Viewer sets text on the ground and both bands, and on --cc-chrome over them, which is darker still.
  it.each(['--cc-ink', '--cc-ink-soft', '--cc-label'].flatMap((ink) => ['--cc-ground', '--cc-band-edge', '--cc-band-mid'].map((ground) => [ink, ground])))(
    'keeps %s at 4.5:1 on %s',
    (ink, ground) => {
      expect(contrast(values.get(ink)!, values.get(ground)!)).toBeGreaterThanOrEqual(4.5);
    },
  );
});
