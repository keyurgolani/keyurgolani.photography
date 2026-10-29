import type { Page } from '@playwright/test';

/**
 * Black parity's gate (the lead's ruling, 2026-10-29): computed style, element by element, against the base. The base
 * doesn't render the same pixels twice (its own photos, the intro's ripples, a focus ring's edge), so pixels can't be
 * the gate; what Black is made of, its tokens and every element's computed paint, type and box, can be compared
 * exactly. What this can't see is raster-only: how the browser draws a blur, a resample, an antialiased edge. The pixel
 * passes in black-parity.spec.ts report those, as an artefact, not a gate.
 */

/** Compared exactly on every element and on its ::before and ::after. */
export const PROPERTIES = [
    'color', 'background-color', 'background-image',
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
    'outline-color', 'outline-width', 'outline-style', 'outline-offset',
    'box-shadow', 'text-shadow',
    'opacity', 'filter', 'backdrop-filter', 'mix-blend-mode',
    'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
    'fill', 'stroke', 'caret-color', 'accent-color',
    'visibility', 'display',
] as const;

/** Box positions may differ by this much, in CSS px; every non-zero delta is logged. */
export const GEOMETRY_SLACK = 0.5;

export interface Walked {
    path: string;
    styles: string[];
    before: string[] | null;
    after: string[] | null;
    rect: [number, number, number, number];
}

export interface Walk {
    /** The custom properties on :root and body, resolved, by name. */
    tokens: { root: Record<string, string>; body: Record<string, string> };
    elements: Walked[];
}

/**
 * Every element under body, in the page and in any same-origin frame, by a path of tag and nth-of-type (no class
 * names, which differ between builds). The theme control and its popover, and today's toggle, are left out with their
 * subtrees, and don't count toward their siblings' positions.
 */
export function walk(page: Page): Promise<Walk> {
    return page.evaluate((properties) => {
        const skip = new Set(['SCRIPT', 'STYLE', 'LINK', 'NOSCRIPT', 'TEMPLATE', 'META']);
        const isControl = (el: Element) =>
            el.matches('[data-theme-control], .theme-menu-popover') || (el.tagName === 'BUTTON' && /^Switch to/.test((el.textContent ?? '').trim()));
        const read = (style: CSSStyleDeclaration) => properties.map((name) => `${name}: ${style.getPropertyValue(name)}`);
        // Every custom property any stylesheet declares, and any the computed style lists, read resolved.
        const names = new Set<string>();
        const collect = (rules: CSSRuleList) => {
            for (const rule of rules) {
                if (rule instanceof CSSStyleRule) for (let i = 0; i < rule.style.length; i++) if (rule.style.item(i).startsWith('--')) names.add(rule.style.item(i));
                if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) collect((rule as CSSGroupingRule).cssRules);
            }
        };
        for (const sheet of [...document.styleSheets, ...document.adoptedStyleSheets]) {
            try {
                collect(sheet.cssRules);
            } catch {
                // A cross-origin sheet: none here.
            }
        }
        const tokens = (style: CSSStyleDeclaration) => {
            for (let i = 0; i < style.length; i++) if (style.item(i).startsWith('--')) names.add(style.item(i));
            const found: Record<string, string> = {};
            for (const name of names) {
                const value = style.getPropertyValue(name).trim();
                if (value !== '') found[name] = value;
            }
            return found;
        };
        const elements: { path: string; styles: string[]; before: string[] | null; after: string[] | null; rect: [number, number, number, number] }[] = [];
        const visit = (el: Element, path: string, dx: number, dy: number) => {
            const view = el.ownerDocument.defaultView!;
            const pseudo = (which: '::before' | '::after') => {
                const style = view.getComputedStyle(el, which);
                const content = style.getPropertyValue('content');
                return content === 'none' || content === 'normal' ? null : [`content: ${content}`, ...read(style)];
            };
            const box = el.getBoundingClientRect();
            elements.push({ path, styles: read(view.getComputedStyle(el)), before: pseudo('::before'), after: pseudo('::after'), rect: [box.x + dx, box.y + dy, box.width, box.height] });
            if (el.tagName === 'IFRAME') {
                const doc = (el as HTMLIFrameElement).contentDocument;
                if (doc?.body) visit(doc.body, `${path}>#document>body`, dx + box.x + (el as HTMLElement).clientLeft, dy + box.y + (el as HTMLElement).clientTop);
                return;
            }
            const counts = new Map<string, number>();
            for (const child of el.children) {
                if (skip.has(child.tagName) || isControl(child)) continue;
                const tag = child.tagName.toLowerCase();
                const n = (counts.get(tag) ?? 0) + 1;
                counts.set(tag, n);
                visit(child, `${path}>${tag}:nth-of-type(${n})`, dx, dy);
            }
        };
        visit(document.body, 'body', 0, 0);
        return {
            tokens: { root: tokens(getComputedStyle(document.documentElement)), body: tokens(getComputedStyle(document.body)) },
            elements,
        };
    }, [...PROPERTIES]);
}

export interface Comparison {
    /** Elements in one build and not the other, by path. Fail. */
    structural: string[];
    /** `path [pseudo] property: base against head`. Fail. */
    styles: string[];
    /** Boxes off by more than GEOMETRY_SLACK. Fail. */
    geometry: string[];
    /** Every box off at all, for the record. */
    deltas: string[];
    /** Base tokens the head resolves differently, or lacks. Fail. */
    tokens: string[];
    /** Tokens the head has and the base doesn't. Allowed, and listed. */
    added: string[];
}

export function compare(base: Walk, head: Walk): Comparison {
    const result: Comparison = { structural: [], styles: [], geometry: [], deltas: [], tokens: [], added: [] };
    for (const where of ['root', 'body'] as const) {
        const [b, h] = [base.tokens[where], head.tokens[where]];
        for (const [name, value] of Object.entries(b)) {
            if (!(name in h)) result.tokens.push(`${where} ${name}: ${value} against nothing`);
            else if (h[name] !== value) result.tokens.push(`${where} ${name}: ${value} against ${h[name]}`);
        }
        for (const name of Object.keys(h)) if (!(name in b)) result.added.push(`${where} ${name}: ${h[name]}`);
    }
    const heads = new Map(head.elements.map((element) => [element.path, element]));
    const bases = new Set(base.elements.map((element) => element.path));
    for (const element of head.elements) if (!bases.has(element.path)) result.structural.push(`only in the head: ${element.path}`);
    for (const b of base.elements) {
        const h = heads.get(b.path);
        if (!h) {
            result.structural.push(`only in the base: ${b.path}`);
            continue;
        }
        const lines = (label: string, left: string[] | null, right: string[] | null) => {
            if (left === null && right === null) return;
            if (left === null || right === null) {
                result.styles.push(`${b.path}${label}: ${left === null ? 'absent' : 'present'} against ${right === null ? 'absent' : 'present'}`);
                return;
            }
            left.forEach((line, i) => {
                if (line !== right[i]) result.styles.push(`${b.path}${label} ${line} against ${right[i].slice(right[i].indexOf(':') + 2)}`);
            });
        };
        lines('', b.styles, h.styles);
        lines('::before', b.before, h.before);
        lines('::after', b.after, h.after);
        const delta = Math.max(...b.rect.map((value, i) => Math.abs(value - h.rect[i])));
        if (delta > 0) {
            const line = `${b.path}: ${b.rect.map((v) => +v.toFixed(3)).join(' ')} against ${h.rect.map((v) => +v.toFixed(3)).join(' ')} (${+delta.toFixed(3)} px)`;
            result.deltas.push(line);
            if (delta > GEOMETRY_SLACK) result.geometry.push(line);
        }
    }
    return result;
}

/** The gate's verdict on one comparison: the lines that fail it. */
export const failures = (c: Comparison) => [...c.structural, ...c.styles, ...c.geometry, ...c.tokens];
