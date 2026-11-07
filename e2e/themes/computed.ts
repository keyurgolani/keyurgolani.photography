import type { Page } from '@playwright/test';

/**
 * The parity gate for Dark, today's site (the lead's ruling, 2026-10-29): computed style, element by element, against the base. The base
 * doesn't render the same pixels twice (its own photos, the intro's ripples, a focus ring's edge), so pixels can't be
 * the gate; what Dark is made of, its tokens and every element's computed paint, type and box, can be compared
 * exactly. What this can't see is raster-only: how the browser draws a blur, a resample, an antialiased edge. The pixel
 * passes in dark-parity.spec.ts report those, as an artefact, not a gate.
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
 * Named allowances, each for one element on one page, at one width or at every width: a box that may move by up to
 * `maxDelta` over GEOMETRY_SLACK, or `properties` that may differ from the base, a sanctioned departure from today's
 * site that spec §10 records. Each departure is listed in the report, never silent.
 */
export interface Allowance {
    page: string;
    /** One width, or every width when it's left out. */
    width?: number;
    /** The element, by a selector the walk resolves to its path. */
    selector: string;
    /** The most its box may move, in CSS px. */
    maxDelta?: number;
    /** Computed properties that may differ, by name. */
    properties?: readonly string[];
    /** `maxDelta` covers every element under it too, for a departure that moves a whole section's layout. */
    subtree?: boolean;
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
    /** Each folded element that paints anything its parent doesn't, by its parent's path. Fail. */
    folded: string[];
    /** Each pinned paint a focused folded element's pseudo-element showed, as WalkOptions.fold pinned it. Sanctioned, and listed. */
    foldedPinned: string[];
}

/**
 * What a folded element may not paint for itself (WalkOptions.fold): it takes its parent's ink and type, takes no room
 * of its own, and draws no fill, line, outline, band, decoration, clip, mask or compositing, so leaving it out of the
 * walk hides nothing. `pseudo` is what its ::before and ::after, where they render, may not paint either.
 * A border is read by its widths, not its styles: the reset (Tailwind's preflight) gives every element and its
 * ::before and ::after `border: 0 solid`, which draws nothing, and a style of none or hidden computes its width to 0,
 * so a width of 0 is no border either way (B3's CI).
 */
export const FOLD_PAINT = {
    inherited: [
        'color', 'visibility', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant',
        'font-feature-settings', 'font-variation-settings', 'line-height', 'letter-spacing', 'word-spacing', 'text-transform',
        '-webkit-font-smoothing', '-webkit-text-fill-color', '-webkit-text-stroke-width', '-webkit-text-stroke-color', 'text-shadow',
    ],
    neutral: {
        display: 'inline',
        position: 'static',
        'background-color': 'rgba(0, 0, 0, 0)',
        'background-image': 'none',
        'border-top-width': '0px', 'border-right-width': '0px', 'border-bottom-width': '0px', 'border-left-width': '0px',
        'border-image-source': 'none',
        'outline-style': 'none',
        'box-shadow': 'none',
        'text-decoration-line': 'none',
        opacity: '1',
        filter: 'none',
        'backdrop-filter': 'none',
        'mix-blend-mode': 'normal',
        transform: 'none',
        'clip-path': 'none',
        'mask-image': 'none',
        'vertical-align': 'baseline',
        'margin-top': '0px', 'margin-right': '0px', 'margin-bottom': '0px', 'margin-left': '0px',
        'padding-top': '0px', 'padding-right': '0px', 'padding-bottom': '0px', 'padding-left': '0px',
    },
    pseudo: {
        'background-color': 'rgba(0, 0, 0, 0)',
        'background-image': 'none',
        'border-top-width': '0px', 'border-right-width': '0px', 'border-bottom-width': '0px', 'border-left-width': '0px',
        'border-image-source': 'none',
        'outline-style': 'none',
        'box-shadow': 'none',
        opacity: '1',
        filter: 'none',
        'backdrop-filter': 'none',
        'clip-path': 'none',
        'mask-image': 'none',
    },
} as const;

/** A folded element's pseudo-element paint, pinned by property, for while the element matches :focus-visible. */
export type FoldedFocus = Partial<Record<'::before' | '::after', Record<string, string>>>;

export interface WalkOptions {
    /**
     * Elements walked under another tag, so the subtree they hold keeps the base's paths: a head that turns a link into
     * a box round the same content (dark-parity.spec.ts's RETAGGED). Their own styles and boxes are still compared.
     */
    retag?: readonly { selector: string; as: string }[];
    /**
     * Elements left out of the walk where they are, with no layout change: an inline wrapper the head adds round its
     * parent's text, which the base had as the parent's own (dark-parity.spec.ts's FOLDED). It must hold no elements and
     * paint nothing its parent doesn't (FOLD_PAINT); anything else is a `folded` failure. Its ::before and ::after,
     * where they render, must paint nothing either (FOLD_PAINT.pseudo), except, while the element matches
     * :focus-visible, the properties `focused` pins, which must equal their pinned values exactly and are listed as
     * `foldedPinned`, a sanctioned departure.
     */
    fold?: readonly { selector: string; focused?: FoldedFocus }[];
}

/**
 * Every element under body, in the page and in any same-origin frame, by a path of tag and nth-of-type (no class
 * names, which differ between builds). The theme control and its popover, and today's toggle with its description,
 * are left out with their subtrees, and don't count toward their siblings' positions. The slot that holds only them
 * (SiteNav's end) stays, compared by style alone. `leaveOut` names more elements left out the same way: ones the head
 * adds that the base never had (dark-parity.spec.ts's HEAD_ONLY). `options` retags or folds elements a head has
 * reshaped (WalkOptions).
 */
export function walk(page: Page, selectors: string[] = [], leaveOut: string[] = [], { retag = [], fold = [] }: WalkOptions = {}): Promise<Walk> {
    return page.evaluate(([properties, wanted, added, retagged, foldedAway, paint]) => {
        const skip = new Set(['SCRIPT', 'STYLE', 'LINK', 'NOSCRIPT', 'TEMPLATE', 'META']);
        const isToggle = (el: Element) => el.tagName === 'BUTTON' && /^Switch to/.test((el.textContent ?? '').trim());
        // Today's toggle comes with a hidden description beside it; the control with its popover.
        const isControl = (el: Element) =>
            el.matches('[data-theme-control], .theme-menu-popover') || isToggle(el) || (el.matches('span[hidden]') && [...(el.parentElement?.children ?? [])].some(isToggle));
        const isPart = (el: Element) => isControl(el) || added.some((selector) => el.matches(selector));
        // The control's slot: an element holding the control and nothing else (SiteNav's end), which collapses with it
        // where it's hidden (no JavaScript). In the curator's header, which holds more, only the control goes. An element
        // whose only elements are ones the head adds (HEAD_ONLY), beside text of its own, holds no control, so it's no
        // slot, and its box is compared.
        const isSlot = (el: Element) => el.children.length > 0 && [...el.children].every(isPart) && [...el.children].some(isControl);
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
        const tags = new Map<Element, string>();
        for (const { selector, as } of retagged) for (const el of document.querySelectorAll(selector)) tags.set(el, as);
        const folds = new Map<Element, Record<string, Record<string, string>>>();
        for (const { selector, focused } of foldedAway) for (const el of document.querySelectorAll(selector)) folds.set(el, focused ?? {});
        const folded: string[] = [];
        const foldedPinned: string[] = [];
        /** A folded element's own paint against its parent's, and its pseudo-elements' against nothing, by the parent's path. */
        const checkFold = (el: Element, parentPath: string, focused: Record<string, Record<string, string>>) => {
            const view = el.ownerDocument.defaultView!;
            const own = view.getComputedStyle(el);
            const parent = view.getComputedStyle(el.parentElement!);
            const where = `${parentPath}>${el.tagName.toLowerCase()} (folded)`;
            if (el.children.length > 0) folded.push(`${where}: holds ${el.children.length} element(s), which the walk would miss`);
            for (const name of paint.inherited) {
                const [mine, theirs] = [own.getPropertyValue(name), parent.getPropertyValue(name)];
                if (mine !== theirs) folded.push(`${where} ${name}: ${mine} against its parent's ${theirs}`);
            }
            for (const [name, value] of Object.entries(paint.neutral)) {
                const mine = own.getPropertyValue(name);
                if (mine !== value) folded.push(`${where} ${name}: ${mine}, where a folded element paints ${value}`);
            }
            const ringOn = el.matches(':focus-visible');
            for (const which of ['::before', '::after']) {
                const style = view.getComputedStyle(el, which);
                const content = style.getPropertyValue('content');
                if (content === 'none' || content === 'normal') continue;
                const pinned = ringOn ? (focused[which] ?? {}) : {};
                for (const [name, value] of Object.entries(pinned)) {
                    const mine = style.getPropertyValue(name);
                    if (mine === value) foldedPinned.push(`${where}${which} ${name}: ${mine}, pinned while focused`);
                    else folded.push(`${where}${which} ${name}: ${mine}, where it's pinned to ${value} while focused`);
                }
                for (const [name, value] of Object.entries(paint.pseudo)) {
                    if (name in pinned) continue;
                    const mine = style.getPropertyValue(name);
                    if (mine !== value) folded.push(`${where}${which} ${name}: ${mine}, where a folded element's ${which} paints ${value}`);
                }
            }
        };
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
                const fold = folds.get(child);
                if (fold) {
                    checkFold(child, path, fold);
                    continue;
                }
                const tag = tags.get(child) ?? child.tagName.toLowerCase();
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
            folded,
            foldedPinned,
        };
    }, [[...PROPERTIES], selectors, leaveOut, [...retag], [...fold], FOLD_PAINT] as const);
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
    /** Differences a named allowance sanctions. Allowed, and listed. */
    sanctioned: string[];
    /** Tokens the head has and the base doesn't. Allowed, and listed. */
    added: string[];
}

/**
 * `allowances` maps a path to the most its box may move, and `sanctioned` a path to the properties that may differ;
 * every other box and property must match exactly.
 */
export function compare(base: Walk, head: Walk, allowances: Record<string, number> = {}, sanctioned: Record<string, readonly string[]> = {}): Comparison {
    const result: Comparison = { structural: [], styles: [], geometry: [], deltas: [], largest: 0, tokens: [], added: [], sanctioned: [] };
    // A folded element that paints for itself is a style the walk can't compare, so it fails as one.
    result.styles.push(...(base.folded ?? []).map((line) => `base ${line}`), ...(head.folded ?? []).map((line) => `head ${line}`));
    result.sanctioned.push(...(base.foldedPinned ?? []).map((line) => `base ${line}`), ...(head.foldedPinned ?? []).map((line) => `head ${line}`));
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
                if (line === right[i]) return;
                const difference = `${b.path}${label} ${line} against ${right[i].slice(right[i].indexOf(':') + 2)}`;
                if (label === '' && sanctioned[b.path]?.includes(line.slice(0, line.indexOf(':')))) result.sanctioned.push(difference);
                else result.styles.push(difference);
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
