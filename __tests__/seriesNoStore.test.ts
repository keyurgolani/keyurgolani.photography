// @vitest-environment node
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { proxy, SERIES_CACHE_CONTROL } from '../proxy';

// The series page and the Viewer answer 308s that a rollback can undo (#5, #7), so the proxy sets their
// Cache-Control itself, as /gallery's does, rather than leave it to force-dynamic: a later `revalidate` or PPR would
// change Next's header without a word. Next keeps a Cache-Control the proxy set (its page handler writes one only when
// none is there), on the 200 and the redirect alike. The value is the one Next gives a dynamic page, so a 200 reads as
// it did.

function respond(pathname: string, method = 'GET') {
    return proxy(new NextRequest(new URL(pathname, 'http://localhost:3000'), { method }));
}

describe('Cache-Control on the series and Viewer paths', () => {
    it('is never stored', () => {
        expect(SERIES_CACHE_CONTROL).toBe('private, no-cache, no-store, max-age=0, must-revalidate');
    });

    it.each([
        '/work/harbor',
        '/work/Harbor',
        '/work/old-harbor?utm_source=mail',
        '/work/harbor/photo/ph_00000000-0000-4000-8000-000000000001',
        '/work/Harbor/photo/PH_00000000-0000-4000-8000-000000000001?x=1',
        '/work/no-such-series',
    ])('passes %s on with it, for a read', async (pathname) => {
        for (const method of ['GET', 'HEAD']) {
            const response = await respond(pathname, method);
            expect(response.headers.get('x-middleware-next'), `${method} ${pathname}`).toBe('1');
            expect(response.headers.get('cache-control'), `${method} ${pathname}`).toBe(SERIES_CACHE_CONTROL);
        }
    });

    it.each(['/work', '/', '/about', '/work/harbor/photo', '/work/harbor/photo/x/more', '/work/harbor/extra'])('leaves %s to its own route', async (pathname) => {
        expect((await respond(pathname)).headers.get('cache-control'), pathname).toBeNull();
    });
});
