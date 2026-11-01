// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss, { type Declaration, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

// Black, OLED (the OLED spec, round 2): its tokens in styles/themes.css, and the rules its pages add, read from the
// stylesheets themselves. Dark sets none of them, so it stays today's (e2e/themes/dark-parity.spec.ts).

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const parse = (file: string) => postcss.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'), { from: file });

/** Every declaration under a selector that names Black, as `selector { prop: value }`. */
function blackRules(file: string) {
    const found: Record<string, Record<string, string>> = {};
    parse(file).walkRules((rule: Rule) => {
        if (!/data-theme=['"]?black/.test(rule.selector)) return;
        rule.walkDecls((decl: Declaration) => void ((found[rule.selector] ??= {})[decl.prop] = decl.value));
    });
    return found;
}

const tokens = () => Object.assign({}, ...Object.entries(blackRules('styles/themes.css')).filter(([selector]) => selector === "html[data-theme='black']").map(([, decls]) => decls));

describe("Black's tokens", () => {
    const t = tokens();

    it("are the screen's own black, with no surface, rule or mat", () => {
        expect([t['--gah-ground'], t['--gah-surface'], t['--gah-raised'], t['--gah-mat-fill']]).toEqual(['#000000', '#000000', '#000000', '#000000']);
        expect(t['--gah-rule']).toBe('transparent');
        expect(t['--gah-photo-radius']).toBe('0px');
    });

    it("draw the action, keep the focus ring's dark band, and fill the KG mark", () => {
        expect([t['--gah-action'], t['--gah-action-rule'], t['--gah-action-ink']]).toEqual(['transparent', '#f5f5f5', '#f5f5f5']);
        expect([t['--focus-ring-light'], t['--focus-ring-dark']]).toEqual(['#ffffff', '#000000']);
        expect([t['--gah-mark-fill'], t['--gah-mark-ink']]).toEqual(['#ffffff', '#000000']);
        // The menu's own: a black sheet with a white accent.
        expect([t['--gah-raised'], t['--gah-accent']]).toEqual(['#000000', '#ffffff']);
    });

    it('leave Dark with only the menu tokens it had as today', () => {
        const dark: Record<string, string> = {};
        parse('styles/themes.css').walkRules((rule: Rule) => {
            if (rule.selector === "html[data-theme='dark']") rule.walkDecls((decl) => void (dark[decl.prop] = decl.value));
        });
        expect(dark).toEqual({ '--gah-raised': '#151917', '--gah-accent': '#eff4f1' });
    });
});

describe("Black's pages", () => {
    it("Home's intro has no grain, and the portrait no ring or rim light", () => {
        expect(blackRules('components/HeroReveal.module.css')['[data-theme="black"] .grainTexture']).toEqual({ opacity: '0' });
        expect(blackRules('components/ProfilePicture.module.css')["[data-theme='black'] .face,\n[data-theme='black'] .face::after"]).toEqual({ 'box-shadow': 'none' });
    });

    it("Home's slides dip to black where motion is allowed: each half of the crossfade", () => {
        const rules = blackRules('components/home/HomeSequence.module.css');
        expect(rules[":global(html[data-theme='black']) .slide"]).toEqual({ 'transition-duration': 'calc(var(--transition-duration) / 2)' });
        expect(rules[":global(html[data-theme='black']) .slide.active"]).toEqual({ 'transition-delay': 'calc(var(--transition-duration) / 2)' });
    });

    it("Work's covers and a series' cover run to the screen's edge, and a missing photograph keeps an edge", () => {
        const work = blackRules('components/work/SeriesCatalog.module.css');
        expect(work[":global(html[data-theme='black']) .list"]['margin-inline']).toBe('calc(-1 * var(--site-gutter))');
        expect(work[":global(html[data-theme='black']) .fallback"]).toEqual({ 'box-shadow': 'inset 0 0 0 1px var(--gah-rule-strong)' });
        const series = blackRules('components/series/SeriesPage.module.css');
        expect(series[":global(html[data-theme='black']) .stage"]['margin-inline']).toBe('calc(-1 * var(--site-gutter))');
    });

    it("draws the focus ring on Work and the series cover inside, above the print, with the outline kept for forced colours", () => {
        const work = blackRules('components/work/SeriesCatalog.module.css');
        expect(work[":global(html[data-theme='black']) .entry:focus-visible"]).toEqual({ 'outline-color': 'transparent', 'outline-offset': 'calc(-1 * var(--focus-ring-width))', 'box-shadow': 'none' });
        expect(work[":global(html[data-theme='black']) .entry:focus-visible::after"]).toMatchObject({ position: 'absolute', 'z-index': '1', inset: '0' });
        const series = blackRules('components/series/SeriesPage.module.css');
        expect(series[":global(html[data-theme='black']) .coverLink:focus-visible"]).toEqual({ 'outline-color': 'transparent', 'outline-offset': 'calc(-1 * var(--focus-ring-width))' });
        expect(series[":global(html[data-theme='black']) .coverLink:focus-visible .coverFrame::after"]).toMatchObject({ position: 'absolute', 'z-index': '1' });
        expect(series[":global(html[data-theme='black']) .coverLink:hover:not(:focus-visible) .coverFrame::after"]).toMatchObject({ 'box-shadow': 'inset 0 0 0 1px var(--gah-rule-strong)' });
        expect(series[":global(html[data-theme='black']) .stageNote"]).toEqual({ 'padding-inline': 'var(--site-gutter)' });
    });

    it("keeps a missing photograph's edge and diagonal in the strong rule", () => {
        const fallback = blackRules('components/series/SeriesPage.module.css')[":global(html[data-theme='black']) .thumbFrame.fallback,\n:global(html[data-theme='black']) .coverFrame.fallback"];
        expect(fallback['box-shadow']).toBe('inset 0 0 0 1px var(--gah-rule-strong)');
        expect(fallback.background).toContain('var(--gah-rule-strong) calc(50% - 0.5px)');
    });

    it('the 503 is black, with no header rule and the KG filled', () => {
        const source = fs.readFileSync(path.join(ROOT, 'lib/curation/auth/unavailable.ts'), 'utf8');
        expect(source).toContain("'html[data-theme=black]{color-scheme:dark;--g:#000;");
        expect(source).toContain('--r:transparent');
        expect(source).toContain("'html[data-theme=black] .mark{border-color:#fff;background:#fff;color:#000}'");
    });
});
