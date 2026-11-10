import { afterEach, describe, expect, it } from 'vitest';
import { quietRouteAnnouncer } from '../routeAnnouncer';

// #247: the mark on Next's <next-route-announcer> host, which the Viewer holds while it's mounted.

afterEach(() => {
    document.body.innerHTML = '';
});

/** A host as Next 16.4.2 makes it: on body, with the alert in an open shadow root. */
function appendHost(): HTMLElement {
    const host = document.createElement('next-route-announcer');
    const alert = document.createElement('div');
    alert.setAttribute('role', 'alert');
    alert.setAttribute('aria-live', 'assertive');
    host.attachShadow({ mode: 'open' }).appendChild(alert);
    document.body.appendChild(host);
    return host;
}

/** Lets the MutationObserver's records arrive. */
const microtask = () => Promise.resolve();

describe('quietRouteAnnouncer', () => {
    it('marks a host already there at once, and takes the mark off on release', () => {
        const host = appendHost();
        const release = quietRouteAnnouncer();
        expect(host).toHaveAttribute('aria-hidden', 'true');
        release();
        expect(host).not.toHaveAttribute('aria-hidden');
    });

    it('marks a host Next appends later, and a new one that replaces it', async () => {
        const release = quietRouteAnnouncer();
        const first = appendHost();
        await microtask();
        expect(first).toHaveAttribute('aria-hidden', 'true');
        first.remove();
        const second = appendHost();
        await microtask();
        expect(second).toHaveAttribute('aria-hidden', 'true');
        release();
        expect(second).not.toHaveAttribute('aria-hidden');
        // Released, it watches no more.
        const third = appendHost();
        await microtask();
        expect(third).not.toHaveAttribute('aria-hidden');
    });

    it('keeps the mark until the last holder releases, and a second release of the same holder counts once', () => {
        const host = appendHost();
        const one = quietRouteAnnouncer();
        const two = quietRouteAnnouncer();
        one();
        one();
        expect(host).toHaveAttribute('aria-hidden', 'true');
        two();
        expect(host).not.toHaveAttribute('aria-hidden');
    });

    it('leaves a mark it didn\'t put on, and marks nothing else', () => {
        const host = appendHost();
        host.setAttribute('aria-hidden', 'true');
        const other = document.createElement('div');
        document.body.appendChild(other);
        const release = quietRouteAnnouncer();
        release();
        expect(host).toHaveAttribute('aria-hidden', 'true');
        expect(other).not.toHaveAttribute('aria-hidden');
    });
});
