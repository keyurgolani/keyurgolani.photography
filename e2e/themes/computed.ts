import type { Page } from '@playwright/test';

/**
 * Black parity's gate (the lead's ruling, 2026-10-29): computed style, element by element, against the base. The base
 * doesn't render the same pixels twice (its own photos, the intro's ripples, a focus ring's edge), so pixels can't be
 * the gate; what Black is made of, its tokens and every element's computed paint, type and box, can be compared
 * exactly. What this can't see is raster-only: how the browser draws a blur, a resample, an antialiased edge. The pixel
 * passes in black-parity.spec.ts report those, as an artefact, not a gate.
 */

/** Compared exactly on every element and on its ::before, ::after, ::placeholder (inputs), ::marker (list items) and ::backdrop (a modal dialog). */
export const PROPERTIES = [
    'color', 'background-color', 'background-image',
    'background-size', 'background-position', 'background-repeat', 'background-clip', 'background-blend-mode',
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
    'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
    'outline-color', 'outline-width', 'outline-style', 'outline-offset',
    'box-shadow', 'text-shadow',
    'opacity', 'filter', 'backdrop-filter', 'mix-blend-mode',
    'object-fit', 'object-position', 'clip-path', 'mask-image', '-webkit-mask-image',
    'overflow-x', 'overflow-y', 'z-index', 'position', 'transform',
    'color-scheme',
    'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant', 'font-feature-settings', 'font-variation-settings',
    'line-height', 'letter-spacing', 'word-spacing', 'text-transform', 'text-align', '-webkit-font-smoothing',
    'text-decoration-line', 'text-decoration-color', 'text-decoration-style', 'text-decoration-thickness', 'text-underline-offset',
    '-webkit-text-fill-color', '-webkit-text-stroke-width', '-webkit-text-stroke-color',
    'fill', 'stroke', 'stroke-width', 'stroke-opacity', 'fill-opacity', 'stop-color', 'stop-opacity',
    'caret-color', 'accent-color',
    'visibility', 'display',
] as const;

/** Boxes must match exactly; every non-zero delta is logged, and the largest per page is in the summary. */
export const GEOMETRY_SLACK = 0;

/**
 * Named allowances over GEOMETRY_SLACK, each for one element on one page at one width. Only the curator's KG ring at
 * 390 (spec §10): the monogram in the Inbox's header, whose sub-pixel cause is still open; the curator PR owns it.
 */
export interface Allowance {
    page: string;
    width: number;
    /** The element, by a selector the walk resolves to its path. */
    selector: string;
    /** The most its box may move, in CSS px. */
    maxDelta: number;
    why: string;
}

export interface Walked {
    path: string;
    styles: string[];
    /** Each pseudo-element that renders, by name: content and PROPERTIES. */
    pseudos: Record<string, string[]>;
    rect: [number, number, number, number];
    /** The control's slot: compared by style, not by box, since it collapses with the control without JavaScript. */
    slot: boolean;
}

export interface Walk {
    /** The custom properties on :root and body, resolved, by name. */
    tokens: { root: Record<string, string>; body: Record<string, string> };
    elements: Walked[];
    /** The paths the selectors given to the walk resolved to. */
    resolved: Record<string, string>;
}

/**
 * Every element under body, in the page and in any same-origin frame, by a path of tag and nth-of-type (no class
 * names, which differ between builds). The theme control and its popover, and today's toggle with its description,
 * are left out with their subtrees, and don't count toward their siblings' positions. The slot that holds only them
 * (SiteNav's end) stays, compared by style alone.
 */
export function walk(page: Page, selectors: string[] = []): Promise<Walk> {
    return page.evaluate(([properties, wanted]) => {
        const skip = new Set(['SCRIPT', 'STYLE', 'LINK', 'NOSCRIPT', 'TEMPLATE', 'META']);
        const isToggle = (el: Element) => el.tagName === 'BUTTON' && /^Switch to/.test((el.textContent ?? '').trim());
        // Today's toggle comes with a hidden description beside it; the control with its popover.
        const isPart = (el: Element) => el.matches('[data-theme-control], .theme-menu-popover') || isToggle(el) || (el.matches('span[hidden]') && [...(el.parentElement?.children ?? [])].some(isToggle));
        // The control's slot: an element holding the control and nothing else (SiteNav's end), which collapses with it
        // where it's hidden (no JavaScript). In the curator's header, which holds more, only the control goes.
        const isSlot = (el: Element) => el.children.length > 0 && [...el.children].every(isPart);
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
        const elements: { path: string; styles: string[]; pseudos: Record<string, string[]>; rect: [number, number, number, number]; slot: boolean }[] = [];
        const marked = new Map<Element, string>();
        for (const selector of wanted) for (const el of document.querySelectorAll(selector)) marked.set(el, selector);
        const resolved: Record<string, string> = {};
        const visit = (el: Element, path: string, dx: number, dy: number) => {
            const view = el.ownerDocument.defaultView!;
            if (marked.has(el)) resolved[marked.get(el)!] = path;
            const pseudos: Record<string, string[]> = {};
            for (const which of ['::before', '::after']) {
                const style = view.getComputedStyle(el, which);
                const content = style.getPropertyValue('content');
                if (content !== 'none' && content !== 'normal') pseudos[which] = [`content: ${content}`, ...read(style)];
            }
            if (el.matches('input, textarea')) pseudos['::placeholder'] = read(view.getComputedStyle(el, '::placeholder'));
            if (view.getComputedStyle(el).display === 'list-item') pseudos['::marker'] = read(view.getComputedStyle(el, '::marker'));
            // A modal dialog's backdrop, which the modal Viewer paints (#126's review, L2).
            if (el.matches('dialog:modal')) pseudos['::backdrop'] = read(view.getComputedStyle(el, '::backdrop'));
            const box = el.getBoundingClientRect();
            const slot = isSlot(el);
            elements.push({ path, styles: read(view.getComputedStyle(el)), pseudos, rect: [box.x + dx, box.y + dy, box.width, box.height], slot });
            if (slot) return;
            if (el.tagName === 'IFRAME') {
                const doc = (el as HTMLIFrameElement).contentDocument;
                if (doc?.body) visit(doc.body, `${path}>#document>body`, dx + box.x + (el as HTMLElement).clientLeft, dy + box.y + (el as HTMLElement).clientTop);
                return;
            }
            const counts = new Map<string, number>();
            for (const child of el.children) {
                if (skip.has(child.tagName) || isPart(child)) continue;
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
            resolved,
        };
    }, [[...PROPERTIES], selectors] as const);
}

export interface Comparison {
    /** Elements in one build and not the other, by path. Fail. */
    structural: string[];
    /** `path [pseudo] property: base against head`. Fail. */
    styles: string[];
    /** Boxes off by more than GEOMETRY_SLACK, or than their allowance. Fail. */
    geometry: string[];
    /** Every box off at all, for the record. */
    deltas: string[];
    /** The largest box delta on the page, allowed or not. */
    largest: number;
    /** Base tokens the head resolves differently, or lacks. Fail. */
    tokens: string[];
    /** Tokens the head has and the base doesn't. Allowed, and listed. */
    added: string[];
}

/** `allowances` maps a path to the most its box may move; every other box must match exactly. */
export function compare(base: Walk, head: Walk, allowances: Record<string, number> = {}): Comparison {
    const result: Comparison = { structural: [], styles: [], geometry: [], deltas: [], largest: 0, tokens: [], added: [] };
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
        for (const which of new Set([...Object.keys(b.pseudos), ...Object.keys(h.pseudos)])) lines(which, b.pseudos[which] ?? null, h.pseudos[which] ?? null);
        if (b.slot !== h.slot) result.structural.push(`the control's slot in one build only: ${b.path}`);
        if (b.slot || h.slot) continue;
        const delta = Math.max(...b.rect.map((value, i) => Math.abs(value - h.rect[i])));
        if (delta > 0) {
            const allowed = allowances[b.path] ?? GEOMETRY_SLACK;
            const line = `${b.path}: ${b.rect.map((v) => +v.toFixed(3)).join(' ')} against ${h.rect.map((v) => +v.toFixed(3)).join(' ')} (${+delta.toFixed(3)} px${b.path in allowances ? `, allowed ${allowed}` : ''})`;
            result.deltas.push(line);
            result.largest = Math.max(result.largest, delta);
            if (delta > allowed) result.geometry.push(line);
        }
    }
    return result;
}

/** The gate's verdict on one comparison: the lines that fail it. */
export const failures = (c: Comparison) => [...c.structural, ...c.styles, ...c.geometry, ...c.tokens];
