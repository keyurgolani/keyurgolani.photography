// The curator in Dark (today's curator), Light, Bright and Black: its contrast rows, read from the stylesheets
// themselves (styles/tokens.css, styles/themes.css, app/curation/curator.module.css and the sign-in's, the 503's
// inline style), so a token change that breaks a pair fails here. WCAG 2: text 4.5:1, a control's edge or a state's outline 3:1, translucent colours composited over their ground.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
const declarations = (body: string) => Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
/** The custom properties of the first rule whose selector is exactly `selector`, and that declares `needs` if given. */
function block(css: string, selector: string, needs?: string): Record<string, string> {
    for (let at = css.indexOf(selector); at >= 0; at = css.indexOf(selector, at + 1)) {
        const open = css.indexOf('{', at);
        if (css.slice(at, open).trim() !== selector) continue;
        const body = css.slice(open + 1, css.indexOf('}', open));
        if (!needs || body.includes(`${needs}:`)) return declarations(body);
    }
    throw new Error(`no rule ${selector}${needs ? ` declaring ${needs}` : ''}`);
}

type Rgba = [number, number, number, number];
function parse(value: string): Rgba {
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
    if (short) return parse(`#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`);
    const hex = /^#([0-9a-f]{6})$/i.exec(value);
    if (hex) return [0, 2, 4].map((k) => parseInt(hex[1].slice(k, k + 2), 16)).concat(1) as Rgba;
    const rgb = /^rgba?\(([^)]+)\)$/.exec(value);
    if (rgb) {
        const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        return [parts[0], parts[1], parts[2], parts[3] ?? 1];
    }
    throw new Error(`can't read ${value}`);
}
const over = (top: Rgba, bottom: Rgba): Rgba => [0, 1, 2].map((k) => top[k] * top[3] + bottom[k] * (1 - top[3])).concat(1) as Rgba;
const luminance = ([r, g, b]: Rgba) => {
    const f = (v: number) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a: Rgba, b: Rgba) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
};

const tokens = read('styles/tokens.css');
const themes = read('styles/themes.css');
const curator = read('app/curation/curator.module.css');
const today = { ...block(tokens, ':root', '--gah-ink'), ...block(curator, '.page', '--curator-header') };
const THEMES: Record<string, Record<string, string>> = {
    // Dark is today's curator: tokens.css's :root and the module's own block, with no override.
    dark: today,
    light: { ...today, ...block(themes, "html[data-theme='light']", '--gah-ink'), ...block(curator, ":global(html[data-theme='light']) .page"), '--curator-page': block(curator, ":global(html[data-theme='light']):has(.page)")['--curator-page'] },
    bright: { ...today, ...block(themes, "html[data-theme='bright']", '--gah-ink'), ...block(curator, ":global(html[data-theme='bright']) .page"), '--curator-page': block(curator, ":global(html[data-theme='bright']):has(.page)")['--curator-page'] },    // Black sets no page ground of its own: the fallback, its --gah-surface, is already #000.
    black: { ...today, ...block(themes, "html[data-theme='black']", '--gah-ink'), ...block(curator, ":global(html[data-theme='black']) .page") },
};

describe.each(Object.entries(THEMES))('the curator in %s', (_, t) => {
    const color = (name: string) => parse(t[name]);
    const page = parse(t['--curator-page'] ?? t['--gah-surface']);
    const on = (fg: string, ground: Rgba) => ratio(over(parse(fg), ground), ground);

    it('reads: the ink and its soft and muted steps at 4.5:1 on every surface', () => {
        for (const surface of ['--curator-header', '--curator-list', '--curator-box', '--curator-field', '--curator-active']) {
            const ground = over(color(surface), page);
            for (const ink of ['--gah-ink', '--gah-ink-soft', '--gah-ink-muted']) expect(on(t[ink], ground), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
    });

    it("outlines the selected row and tab at 3:1 against both their fill and the list (P2-8)", () => {
        const outline = t['--curator-selected-rule'] ?? t['--gah-rule-strong'];
        const list = over(color('--curator-list'), page);
        const active = over(color('--curator-active'), list);
        expect(on(outline, active), 'the outline on the selected fill').toBeGreaterThanOrEqual(3);
        expect(on(outline, list), 'the outline against the list').toBeGreaterThanOrEqual(3);
    });

    it('hovers the primary with a fill that differs from its rest, its ink still at 4.5:1 (P2-2)', () => {
        const hover = t['--curator-primary-hover'] ?? t['--gah-ink'];
        expect(parse(hover), 'the hover is not the rest fill').not.toEqual(color('--curator-primary'));
        expect(ratio(color('--curator-primary-ink'), parse(hover)), 'the ink on the hover').toBeGreaterThanOrEqual(4.5);
    });

    it("draws a field's edge at 3:1", () => {
        expect(on(t['--gah-rule-strong'], over(color('--curator-field'), page))).toBeGreaterThanOrEqual(3);
    });

    it('reads the primary, the badges and the lock', () => {
        expect(ratio(color('--curator-primary-ink'), color('--curator-primary')), 'the primary').toBeGreaterThanOrEqual(4.5);
        for (const tone of ['new', 'change', 'alert', 'settled']) {
            expect(ratio(color(`--curator-tone-${tone}-ink`), color(`--curator-tone-${tone}-bg`)), `the ${tone} badge`).toBeGreaterThanOrEqual(4.5);
        }
        expect(ratio(color('--curator-approved-ink'), color('--curator-approved-bg')), 'the approved note').toBeGreaterThanOrEqual(4.5);
        expect(ratio(color('--curator-lock-icon'), color('--curator-lock-bg')), "the lock's icon").toBeGreaterThanOrEqual(3);
    });
});

describe('the curator in Dark', () => {
    it("is today's curator: the module's own block, with no Dark override", () => {
        expect(curator).not.toMatch(/data-theme='dark'/);
    });
});

// The design review's P2-1: the selected row's outline lies on the rules around it, so no edge reads as two lines.
describe("the selected row's outline", () => {
    const rule = [...curator.matchAll(/\n\.item\[aria-current='true'\] \{([^}]*)\}/g)].map((m) => m[1]).find((body) => body.includes('box-shadow')) ?? '';
    const outline = 'var(--curator-selected-row-rule, var(--curator-selected-rule, var(--gah-rule-strong)))';

    it("takes the row's own separator as its bottom edge", () => {
        expect(rule).toContain(`border-bottom-color: ${outline};`);
    });

    it("covers the separator above and the list column's rule, and draws the left edge inside", () => {
        const shadow = rule.replace(/\s+/g, ' ');
        expect(shadow).toContain(`0 -1px 0 0 ${outline}`);
        expect(shadow).toContain(`1px -1px 0 0 ${outline}`);
        expect(shadow, 'the right edge down to the bottom corner').toContain(`1px 0 0 0 ${outline}`);
        expect(shadow).toContain(`inset 1px 0 0 0 ${outline}`);
        expect(shadow, 'no full inset ring beside the rules').not.toContain('inset 0 0 0 1px');
    });

    // Delta 1's D1-1: painted over rules, a translucent colour stacks into a different tone per edge.
    it.each(Object.entries(THEMES))('is one opaque colour in %s: the tab\'s outline as drawn on the row\'s fill, at 3:1', (_, t) => {
        const row = parse(t['--curator-selected-row-rule']);
        expect(row[3], 'opaque').toBe(1);
        const page = parse(t['--curator-page'] ?? t['--gah-surface']);
        const list = over(parse(t['--curator-list']), page);
        const active = over(parse(t['--curator-active']), list);
        const drawn = over(parse(t['--curator-selected-rule'] ?? t['--gah-rule-strong']), active);
        row.slice(0, 3).forEach((channel, k) => expect(Math.abs(channel - drawn[k]), `channel ${k}`).toBeLessThanOrEqual(1));
        expect(ratio(row, active), 'on the fill').toBeGreaterThanOrEqual(3);
        expect(ratio(row, list), 'against the list').toBeGreaterThanOrEqual(3);
    });

    it("gives the phone's list view its plain separator back", () => {
        expect(curator).toMatch(/\.body\[data-view='list'\] \.item\[aria-current='true'\] \{\s*border-bottom-color: var\(--curator-rule\);/);
    });
});

const login = read('app/curation/login/login.module.css');
const LOGIN: Record<string, Record<string, string>> = {
    dark: { ...today, ...block(login, '.page', '--login-header') },
    light: { ...THEMES.light, ...block(login, '.page', '--login-header'), ...block(login, ":global(html[data-theme='light']) .page") },
    bright: { ...THEMES.bright, ...block(login, '.page', '--login-header'), ...block(login, ":global(html[data-theme='bright']) .page") },    black: { ...THEMES.black, ...block(login, '.page', '--login-header'), ...block(login, ":global(html[data-theme='black']) .page") },
};

describe.each(Object.entries(LOGIN))('the sign-in in %s', (_, t) => {
    const page = parse(t['--curator-page'] ?? t['--gah-surface']);
    const on = (fg: string, ground: Rgba) => ratio(over(parse(fg), ground), ground);

    it('reads: the ink on its header, its ground and its field; the field\'s edge at 3:1', () => {
        for (const surface of ['--login-header', '--login-field']) expect(on(t['--gah-ink'], over(parse(t[surface]), page)), surface).toBeGreaterThanOrEqual(4.5);
        expect(on(t['--gah-ink-soft'], page), 'soft ink on the ground').toBeGreaterThanOrEqual(4.5);
        expect(on(t['--gah-rule-strong'], over(parse(t['--login-field']), page)), "the field's edge").toBeGreaterThanOrEqual(3);
    });

    it('reads its notices', () => {
        expect(ratio(parse(t['--login-alert-ink']), parse(t['--login-alert-bg'])), 'the alert').toBeGreaterThanOrEqual(4.5);
        expect(on(t['--gah-ink'], parse(t['--login-done-bg'])), 'the done notice').toBeGreaterThanOrEqual(4.5);
    });
});

// Black, OLED (photography-themes-oled-spec.md §3, the round 2 review's C2-4 and C2-5): no surfaces, #3a3a3a hairlines,
// the current tab drawn, the primary filled white, and no plain rule on the sign-in or the 503.
describe('the curator in Black', () => {
    const t = THEMES.black;
    const black = parse('#000000');
    const on = (fg: string, ground: Rgba) => ratio(over(parse(fg), ground), ground);

    it("has no surfaces: the header, the list, the boxes and the fields are the screen's own black", () => {
        expect(parse(t['--gah-surface'])).toEqual(black);
        for (const surface of ['--curator-header', '--curator-list', '--curator-box', '--curator-field']) expect(parse(t[surface]), surface).toEqual(black);
        expect(t['--curator-page'], 'no page ground of its own').toBeUndefined();
    });

    it('tells its working structure apart by #3a3a3a hairlines, and the selected row by a faint lift', () => {
        expect(t['--curator-rule']).toBe('#3a3a3a');
        expect(t['--curator-active']).toBe('#1a1a1a');
        // Decoration, not a state on its own: the row's state is aria-current and P2-8's outline, checked above.
        expect(ratio(parse('#3a3a3a'), black)).toBeLessThan(3);
    });

    it('draws the current tab: no fill, the white .40 line at 3:1 on the header (C2-4)', () => {
        expect(curator).toMatch(/:global\(html\[data-theme='black'\]\) \.screen\[aria-current='page'\] \{\s*background: transparent;\s*\}/);
        expect(t['--curator-selected-rule'], "the outline is the strong rule, as Dark's").toBeUndefined();
        expect(on(t['--gah-rule-strong'], parse(t['--curator-header']))).toBeGreaterThanOrEqual(3);
        expect(on(t['--gah-ink'], parse(t['--curator-header'])), "the tab's ink").toBeGreaterThanOrEqual(4.5);
    });

    it('keeps the primary filled white, black ink, at rest and hovered (owner question 3)', () => {
        expect([t['--curator-primary'], t['--curator-primary-ink']]).toEqual(['#f5f5f5', '#000000']);
        expect(ratio(parse(t['--curator-primary-ink']), parse(t['--curator-primary-hover'])), 'hovered').toBeGreaterThanOrEqual(4.5);
        // The hover steps down, so it shows against the rest state.
        expect(luminance(parse(t['--curator-primary-hover']))).toBeLessThan(luminance(parse(t['--curator-primary'])));
    });

    it('fills the KG through the shared mark tokens: a white disc, black letters', () => {
        expect(curator).toMatch(/\.monogram \{[^}]*background: var\(--gah-mark-fill, none\)/);
        expect(ratio(parse(t['--gah-mark-ink']), parse(t['--gah-mark-fill']))).toBeGreaterThanOrEqual(4.5);
    });

    it("keeps the Preview frame's toolbar edge, the strong rule, at 3:1 on the ground", () => {
        const frame = read('components/curation/PreviewFrame.module.css');
        expect(frame).toMatch(/\.toolbar \{[^}]*border-bottom: 1px solid var\(--gah-rule-strong\)/);
        expect(on(t['--gah-rule-strong'], parse(t['--gah-ground']))).toBeGreaterThanOrEqual(3);
    });

    it("closes Publish's embedded preview with the same strong line, in Black only (P2-3)", () => {
        const frame = read('components/curation/PreviewFrame.module.css');
        expect(frame).toMatch(/:global\(html\[data-theme='black'\]\) \.frame\[data-embedded='true'\] \{\s*border-bottom: 1px solid var\(--gah-rule-strong\);\s*\}/);
        expect(frame).not.toMatch(/data-theme='dark'/);
        expect(parse(t['--gah-rule-strong'])[3]).toBeCloseTo(0.4);
    });
});

describe('the sign-in in Black', () => {
    const t = LOGIN.black;

    it("has no header rule and no surfaces (C2-5): the header and the field are the screen's own black", () => {
        expect(t['--login-rule']).toBe('transparent');
        expect([t['--login-header'], t['--login-field']]).toEqual(['#000000', '#000000']);
    });
});

describe('the 503 in Black', () => {
    const source = read('lib/curation/auth/unavailable.ts');
    const rule = /'html\[data-theme=black\]\{([^}]*)\}'/.exec(source);
    const t = Object.fromEntries([...(rule?.[1] ?? '').matchAll(/(--[a-z]+):([^;]+)/g)].map((m) => [m[1], m[2]]));
    const on = (fg: string, ground: string) => ratio(over(parse(fg), parse(ground)), parse(ground));

    it("is the screen's own black, with no header rule, and reads", () => {
        expect([t['--g'], t['--h'], t['--r']]).toEqual(['#000', '#000', 'transparent']);
        expect(on(t['--i'], t['--g']), 'the ink').toBeGreaterThanOrEqual(4.5);
        expect(on(t['--s'], t['--g']), 'the soft ink').toBeGreaterThanOrEqual(4.5);
        expect(on(t['--m'], t['--g']), "the mark's ring").toBeGreaterThanOrEqual(3);
    });

    it('fills the KG mark', () => {
        expect(source).toContain("'html[data-theme=black] .mark{border-color:#fff;background:#fff;color:#000}'");
    });
});
