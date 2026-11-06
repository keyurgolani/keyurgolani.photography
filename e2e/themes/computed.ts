// The Dark parity walk and its comparison, from test/helpers/parityWalk.ts, where the unit tests under test/ read them
// too: e2e/ isn't in the image, which type-checks test/.
export * from '../../test/helpers/parityWalk';

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
