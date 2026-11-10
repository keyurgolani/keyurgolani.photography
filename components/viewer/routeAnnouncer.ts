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
 * last caller releases it. The release takes off only the marks it put on.
 * The Viewer holds it from a layout effect: on the way out, the release runs
 * in the commit that removes the Viewer, before the announcer's own effect
 * for that commit writes the next page's title, so that title is spoken.
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
        for (const host of marked) host.removeAttribute('aria-hidden');
        marked.clear();
    };
}
