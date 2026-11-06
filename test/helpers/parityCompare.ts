/**
 * The pure half of Dark's parity gate (e2e/themes/computed.ts): the walk's shape, the comparison and its verdict, and
 * the no-JS segment completion the walk runs in the page. Here, not in e2e/, so __tests__/paritySegments.test.ts can
 * test it: .dockerignore leaves e2e/ out of the image, and the image's `next build` type-checks every .ts it has
 * (A8's CI). e2e/themes/computed.ts re-exports all of it, so the gate's own imports are unchanged.
 */

/** Boxes must match exactly; every non-zero delta is logged, and the largest per page is in the summary. */
export const GEOMETRY_SLACK = 0;

export interface Walked {
    path: string;
    styles: string[];
    /** Each pseudo-element that renders, by name: content and computed.ts's PROPERTIES. */
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
 * Without JavaScript, React leaves each segment it streamed late in a hidden `<div id="S:n">` at the end of the body,
 * with a `<template id="P:n">` where it goes, for its `$RS` script to move. Which parts stream late follows the size of
 * the page's payload, not its structure: A8's Inbox, with more on the page, streamed its rows one by one, where today's
 * streams the item's facts alone. So inside content no-JS never shows (the Inbox's list and item stream in behind its
 * loading state), this puts every segment where it goes, as `$RS` would, in both builds, and the walk compares the
 * page as it's built. A placeholder in content the page shows is left alone: there no-JS really shows the hole. Only
 * React's own segments count, each a `<div hidden id="S:n">` straight in `<body>`, and only placeholders inside one,
 * so the app's own hidden content, or an element of its own with an ID like S:1, is never touched (the review of
 * bbf1e280). Runs in the page with no arguments (page.evaluate), and returns how many segments it moved.
 */
export function completeHiddenSegments(): number {
    // Inline, since page.evaluate sends this function alone.
    const isSegment = (el: Element | null | undefined): el is HTMLElement =>
        !!el && el.localName === 'div' && el.parentElement === document.body && /^S:[0-9a-f]+$/.test(el.id) && el.getAttribute('hidden') === '';
    let moved = 0;
    for (let again = true; again; ) {
        again = false;
        for (const placeholder of document.querySelectorAll('template[id^="P:"]')) {
            const segment = document.getElementById(`S:${placeholder.id.slice(2)}`);
            const within = placeholder.parentElement?.closest('[id^="S:"]');
            if (!isSegment(segment) || !isSegment(within) || segment.contains(placeholder)) continue;
            // As React's $RS: the segment's container goes, and its children take the placeholder's place.
            const nodes = [...segment.childNodes];
            segment.remove();
            placeholder.replaceWith(...nodes);
            moved++;
            again = true;
        }
    }
    return moved;
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
        for (const which of new Set([...Object.keys(b.pseudos), ...Object.keys(h.pseudos)])) {
            // Only a list item has a ::marker, so a sanctioned `display` that leaves list-item, or comes to it, takes the
            // marker with it, listed with the departure (A8's Inbox rows). Under any other sanction it fails as before.
            if (which === '::marker' && sanctioned[b.path]?.includes('display') && !b.pseudos[which] !== !h.pseudos[which]) {
                result.sanctioned.push(`${b.path}::marker: ${b.pseudos[which] ? 'present' : 'absent'} against ${h.pseudos[which] ? 'present' : 'absent'}, with its display`);
                continue;
            }
            lines(which, b.pseudos[which] ?? null, h.pseudos[which] ?? null);
        }
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
