import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/**
 * Next's route announcer (#247). Next 16.4.2's AppRouterAnnouncer
 * (`next/dist/client/components/app-router-announcer.js`) appends a
 * `<next-route-announcer>` to `body` in its own mount effect, which runs after
 * the page's effects, so on a direct load it comes after the Viewer has
 * mounted. In its shadow root is an assertive `role="alert"` div, and on every
 * change of the router's tree it writes the new `document.title` there, with
 * no opt-out. Each Viewer move is a navigation, so it would say every move
 * before the Viewer's own polite line.
 *
 * `quietRouteAnnouncer()` marks that host `aria-hidden="true"`, which hides
 * the shadow root's alert with it, and any host Next appends later, until the
 * last caller releases it. The release takes off only the marks it put on,
 * and empties first what Next wrote under them (#255), so a host is never
 * shown holding a title it took while hidden.
 * The Viewer holds it from a layout effect: on the way out, the release runs
 * in the commit that removes the Viewer, before the announcer's own effect
 * for that commit writes the next page's title, so that title is spoken.
 *
 * A return that lands with focus on the series heading (#255) takes the
 * landing hold, useLandingHold(), instead: the heading says the page's name,
 * so the announcer mustn't say it too.
 */
const HOST = 'next-route-announcer';

let holders = 0;
let observer: MutationObserver | null = null;
const marked = new Set<Element>();

function markHosts(): void {
    for (const host of document.getElementsByTagName(HOST)) {
        if (marked.has(host) || host.getAttribute('aria-hidden') === 'true') continue;
        host.setAttribute('aria-hidden', 'true');
        marked.add(host);
    }
}

/**
 * Empties the text Next wrote into `host`'s alert, in the shape Next 16.4.2 renders (app-router-announcer.js:15-35): an
 * open shadow root holding one `aria-live` div, which holds only text. Any other shape, as a Next upgrade might make,
 * is left as it is. React sets that text node's value afresh on Next's next write and never reads it back, so the next
 * page change is written, and heard, as before.
 */
function emptyAlert(host: Element): void {
    const root = host.shadowRoot;
    if (root === null || root.childNodes.length !== 1) return;
    const alert = root.firstChild;
    if (!(alert instanceof Element) || !alert.hasAttribute('aria-live')) return;
    const texts = [...alert.childNodes];
    if (!texts.every((node): node is Text => node.nodeType === Node.TEXT_NODE)) return;
    for (const text of texts) text.data = '';
}

/** Keeps Next's route announcer from speaking until the returned release is called. Each release counts once. */
export function quietRouteAnnouncer(): () => void {
    holders += 1;
    if (holders === 1) {
        markHosts();
        // Next's host is a child of body, and a new one replaces it if its announcer mounts again.
        observer = new MutationObserver(markHosts);
        observer.observe(document.body, { childList: true });
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        holders -= 1;
        if (holders > 0) return;
        observer?.disconnect();
        observer = null;
        // A screen reader can read an alert out as it's shown, so the title Next wrote while it was hidden goes first.
        for (const host of marked) {
            emptyAlert(host);
            host.removeAttribute('aria-hidden');
        }
        marked.clear();
    };
}

/**
 * The landing hold (#255): for a navigation that lands with focus on a heading naming the page, keeps Next's route
 * announcer from saying that name too. Call the returned function from a passive effect of the commit the navigation
 * lands in, as focus moves to the heading.
 *
 * How the timing holds, against Next 16.4.2's AppRouterAnnouncer
 * (`next/dist/client/components/app-router-announcer.js:50-69`): for each new router tree, its passive effect reads
 * the title and calls `setRouteAnnouncement`, and the write lands in the commit that update makes. The hold marks the
 * host hidden at once (quietRouteAnnouncer) and sets this hook's own state in the same passive flush. React runs one
 * commit's passive effects in one flush, with one update priority and no transition (`flushPassiveEffects`), so both
 * updates take the same lane and render in one commit. Its mutations write the announcer's text, then this hook's
 * layout effect, in that commit, lets the host go, and the release empties that text first, so it never sits beside
 * the heading in the reading order. When the title didn't change, there's no write and the same commit just lets the
 * host go. The host is never left hidden: that commit always comes, and an unmount, or
 * Suspense hiding the page, lets it go first.
 */
export function useLandingHold(): () => void {
    const [landing, setLanding] = useState(0);
    const release = useRef<(() => void) | null>(null);
    useLayoutEffect(() => {
        const held = release.current;
        if (held === null) return;
        release.current = null;
        held();
    }, [landing]);
    useLayoutEffect(
        () => () => {
            release.current?.();
            release.current = null;
        },
        [],
    );
    return useCallback(() => {
        release.current ??= quietRouteAnnouncer();
        setLanding((count) => count + 1);
    }, []);
}
