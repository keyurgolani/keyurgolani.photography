// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// What happened, in order, and the render forRequest() runs in. React's real cache() keys on a
// request scope only the server renderer has, so this stand-in keys on `scope.current`.
const events = vi.hoisted(() => [] as string[]);
const scope = vi.hoisted(() => ({ current: 0 }));

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

beforeEach(() => {
    events.length = 0;
    scope.current += 1;
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

        scope.current += 1;
        expect(await get()).not.toBe(layout);
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('passes a failed load to every caller in the request', async () => {
        const get = forRequest(async () => {
            throw new Error('catalog unavailable');
        });
        await expect(get()).rejects.toThrow('catalog unavailable');
        await expect(get()).rejects.toThrow('catalog unavailable');
    });
});
