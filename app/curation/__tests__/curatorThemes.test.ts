// The curator in Dark (today's curator), Light and Bright: its contrast rows, read from the stylesheets themselves
// (styles/tokens.css, styles/themes.css, app/curation/curator.module.css), so a token change that breaks a pair fails
// here. WCAG 2: text 4.5:1, a control's edge or a state's outline 3:1, translucent colours composited over their ground.
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
    bright: { ...today, ...block(themes, "html[data-theme='bright']", '--gah-ink'), ...block(curator, ":global(html[data-theme='bright']) .page"), '--curator-page': block(curator, ":global(html[data-theme='bright']):has(.page)")['--curator-page'] },
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

const login = read('app/curation/login/login.module.css');
const LOGIN: Record<string, Record<string, string>> = {
    dark: { ...today, ...block(login, '.page', '--login-header') },
    light: { ...THEMES.light, ...block(login, '.page', '--login-header'), ...block(login, ":global(html[data-theme='light']) .page") },
    bright: { ...THEMES.bright, ...block(login, '.page', '--login-header'), ...block(login, ":global(html[data-theme='bright']) .page") },
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
