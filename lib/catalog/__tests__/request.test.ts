// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// What happened, in order, and the render forRequest() runs in. React's real cache() keys on a
// render scope only the server renderer has, so this stand-in keys on `scope.current`. One request
// can take two renders (the page's, then the error page's head after a throw), so the request is
// its own object, as Next keeps the request's headers object for all of it.
const events = vi.hoisted(() => [] as string[]);
const scope = vi.hoisted(() => ({ current: 0 }));
const request = vi.hoisted(() => ({ current: {} as object }));

vi.mock('next/headers', () => ({ headers: vi.fn(async () => request.current) }));

vi.mock('next/server', () => ({
    connection: vi.fn(async () => {
        events.push('connection');
    }),
}));

vi.mock('react', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        cache: <T>(fn: () => T) => {
            const results = new Map<number, T>();
            return () => {
                if (!results.has(scope.current)) results.set(scope.current, fn());
                return results.get(scope.current) as T;
            };
        },
    };
});

const { forRequest } = await import('../request');

/** The next request: a new headers object, and a new render. */
function nextRequest(): void {
    request.current = {};
    scope.current += 1;
}

beforeEach(() => {
    events.length = 0;
    nextRequest();
});

describe('forRequest', () => {
    it('awaits connection() before it loads, on every call', async () => {
        const load = vi.fn(async () => {
            events.push('load');
            return { revisionId: 'rev_fixture' };
        });
        const get = forRequest(load);
        await get();
        await get();
        expect(events).toEqual(['connection', 'load', 'connection']);
    });

    it('loads once per request, shared by every caller in it, and again in the next request', async () => {
        const load = vi.fn(async () => ({ request: scope.current }));
        const get = forRequest(load);
        const [layout, page, metadata] = await Promise.all([get(), get(), get()]);
        expect(layout).toBe(page);
        expect(page).toBe(metadata);
        expect(load).toHaveBeenCalledTimes(1);

        nextRequest();
        expect(await get()).not.toBe(layout);
        expect(load).toHaveBeenCalledTimes(2);
    });

    // Modelled on work-routes.test.tsx's one read per request. When the page throws, Next renders the error page's
    // head in a second render of the same request, where cache() starts empty. A fresh read there lands the metadata
    // after the shell, and Next streams the title and meta tags into the body (B12's E1, the series and Viewer pages
    // as a browser). Kept by the request, the answer is the page's, at once.
    it("keeps the request's read for a later render of it, as the error page's head, and reads again in the next request", async () => {
        let readable = false;
        const load = vi.fn(async () => ({ state: readable ? 'ok' : 'unavailable' }));
        const get = forRequest(load);
        // The page and its generateMetadata, in the page's render.
        const [page, metadata] = await Promise.all([get(), get()]);
        expect(page).toBe(metadata);
        expect(page).toEqual({ state: 'unavailable' });

        // The error page's render, with the catalog readable by then: it still answers for this request's read.
        scope.current += 1;
        readable = true;
        expect(await get()).toBe(page);
        expect(load).toHaveBeenCalledTimes(1);

        nextRequest();
        expect(await get()).toEqual({ state: 'ok' });
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('answers a later render of the request before any I/O could land', async () => {
        // A read that takes a timer, as a file read takes the event loop.
        const get = forRequest(() => new Promise<{ read: number }>((resolve) => setTimeout(() => resolve({ read: scope.current }), 5)));
        const first = await get();
        scope.current += 1;
        const winner = await Promise.race([get().then((answer) => answer), new Promise<'io'>((resolve) => setImmediate(() => resolve('io')))]);
        expect(winner).toBe(first);
    });

    it('passes a failed load to every caller in the request', async () => {
        const get = forRequest(async () => {
            throw new Error('catalog unavailable');
        });
        await expect(get()).rejects.toThrow('catalog unavailable');
        await expect(get()).rejects.toThrow('catalog unavailable');
    });
});
