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

// #255: text Next wrote while the host was hidden is stale by the time the host is shown, and a screen reader can read
// an alert out as it's shown. So the last release empties it first, in the shape Next 16.4.2 renders: one aria-live
// div in the shadow root, holding only text. Any other shape is left as it is, and the mark still comes off.
describe('the last release, and the text a host took while it was hidden', () => {
    /** A host as Next makes it, holding `text` in its alert. */
    function hostWith(text: string): HTMLElement {
        const host = appendHost();
        host.shadowRoot?.firstElementChild?.append(text);
        return host;
    }

    it('empties it before taking the mark off', () => {
        const host = appendHost();
        const release = quietRouteAnnouncer();
        // Next writes while the host is hidden.
        host.shadowRoot?.firstElementChild?.append('Fixture series, photograph 2 of 3 · Site');
        const seen: string[] = [];
        const observer = new MutationObserver(() => undefined);
        observer.observe(host, { attributes: true, attributeFilter: ['aria-hidden'] });
        observer.observe(host.shadowRoot as ShadowRoot, { characterData: true, childList: true, subtree: true });
        release();
        for (const record of observer.takeRecords()) seen.push(record.type === 'attributes' ? 'shown' : 'emptied');
        observer.disconnect();
        expect(seen).toEqual(['emptied', 'shown']);
        expect(host.shadowRoot?.textContent).toBe('');
        expect(host).not.toHaveAttribute('aria-hidden');
    });

    it('keeps the text node, so React\'s next write lands in it', () => {
        const host = hostWith('Old title');
        const node = host.shadowRoot?.firstElementChild?.firstChild as Text;
        quietRouteAnnouncer()();
        expect(node.isConnected).toBe(true);
        node.nodeValue = 'Next title';
        expect(host.shadowRoot?.textContent).toBe('Next title');
    });

    it('empties nothing while another holder still holds', () => {
        const host = hostWith('Old title');
        const one = quietRouteAnnouncer();
        const two = quietRouteAnnouncer();
        one();
        expect(host.shadowRoot?.textContent).toBe('Old title');
        two();
        expect(host.shadowRoot?.textContent).toBe('');
    });

    it('leaves a host it didn\'t mark as it is', () => {
        const host = hostWith('Old title');
        host.setAttribute('aria-hidden', 'true');
        quietRouteAnnouncer()();
        expect(host.shadowRoot?.textContent).toBe('Old title');
    });

    describe('in a shape other than Next 16.4.2\'s, it empties nothing, throws nothing, and still takes the mark off', () => {
        const shapes: [string, () => HTMLElement][] = [
            [
                'no shadow root',
                () => {
                    const host = document.createElement('next-route-announcer');
                    host.textContent = 'Old title';
                    document.body.appendChild(host);
                    return host;
                },
            ],
            [
                'no aria-live node',
                () => {
                    const host = document.createElement('next-route-announcer');
                    const alert = document.createElement('div');
                    alert.setAttribute('role', 'alert');
                    alert.textContent = 'Old title';
                    host.attachShadow({ mode: 'open' }).appendChild(alert);
                    document.body.appendChild(host);
                    return host;
                },
            ],
            [
                'an element inside the live node',
                () => {
                    const host = appendHost();
                    const span = document.createElement('span');
                    span.textContent = 'Old title';
                    host.shadowRoot?.firstElementChild?.append(span);
                    return host;
                },
            ],
            [
                'two nodes in the shadow root',
                () => {
                    const host = hostWith('Old title');
                    host.shadowRoot?.append(document.createElement('style'));
                    return host;
                },
            ],
        ];

        it.each(shapes)('%s', (_shape, make) => {
            const host = make();
            const before = host.shadowRoot?.textContent ?? host.textContent;
            const release = quietRouteAnnouncer();
            expect(host).toHaveAttribute('aria-hidden', 'true');
            expect(() => release()).not.toThrow();
            expect(host.shadowRoot?.textContent ?? host.textContent).toBe(before);
            expect(before).toContain('Old title');
            expect(host).not.toHaveAttribute('aria-hidden');
        });
    });
});
