// @vitest-environment node
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch, unstable_getResponseFromNextConfig } from 'next/experimental/testing/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nextConfig from '../next.config.mjs';
import { CURATOR_FRAME_POLICY, CURATOR_RESPONSE_HEADERS } from '../lib/curation/auth/policy';
import { config, proxy } from '../proxy';

// proxy.ts on the curator paths (#14's 14-2): the flag, the Host allowlist,
// the Origin on a mutation, the curator headers, and every other path
// refusing anything but a read.

/** A 42-hex server action ID, the shape Next sends in Next-Action. */
const ACTION_ID = '7f'.repeat(21);
const CURATOR_HOST = '127.0.0.1:3001';
const CURATOR_ORIGIN = `http://${CURATOR_HOST}`;

// proxy() is async: it reads the catalog mode for /assets/photos and /_next/image.
async function send(pathname: string, init: { method?: string; headers?: Record<string, string> } = {}) {
    const headers = new Headers({ host: CURATOR_HOST, ...init.headers });
    return proxy(new NextRequest(new URL(pathname, `http://${headers.get('host') || CURATOR_HOST}`), { method: init.method ?? 'GET', headers }));
}

const passes = (response: Response) => response.headers.get('x-middleware-next') === '1';

function expectCuratorHeaders(response: Response) {
    for (const [name, value] of Object.entries(CURATOR_RESPONSE_HEADERS)) expect(response.headers.get(name)).toBe(value);
}

beforeEach(() => {
    vi.stubEnv('HOSTNAME', '127.0.0.1');
    vi.stubEnv('CURATOR_TUNNEL_PORT', '');
    vi.stubEnv('CURATION_BIND_SCOPE', '');
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('proxy.ts with CURATION_ENABLED off', () => {
    it.each([undefined, '', 'false', 'TRUE', '1'])('404s every curator path for %j, with the curator headers', async (value) => {
        vi.stubEnv('CURATION_ENABLED', value);
        for (const pathname of ['/curation', '/curation/inbox', '/api/curation/events', '/Curation', '/%63uration/inbox']) {
            for (const method of ['GET', 'HEAD', 'POST']) {
                const response = await send(pathname, { method, headers: { origin: CURATOR_ORIGIN } });
                expect(response.status, `${method} ${pathname}`).toBe(404);
                expectCuratorHeaders(response);
                expect(response.headers.get('content-security-policy')).toBe(CURATOR_FRAME_POLICY['Content-Security-Policy']);
            }
        }
    });

    it('reads the flag on every request, so a restart with it on is all it takes', async () => {
        vi.stubEnv('CURATION_ENABLED', 'false');
        expect((await send('/curation')).status).toBe(404);
        vi.stubEnv('CURATION_ENABLED', 'true');
        expect(passes(await send('/curation'))).toBe(true);
        vi.stubEnv('CURATION_ENABLED', 'false');
        expect((await send('/curation')).status).toBe(404);
    });
});

describe('proxy.ts with CURATION_ENABLED=true', () => {
    beforeEach(() => {
        vi.stubEnv('CURATION_ENABLED', 'true');
    });

    it('passes a read on an allowed Host, with the curator headers', async () => {
        for (const host of ['127.0.0.1:3001', 'localhost:3001']) {
            const response = await send('/curation', { headers: { host } });
            expect(passes(response)).toBe(true);
            expectCuratorHeaders(response);
        }
    });

    it('421s another Host, as after a DNS rebinding', async () => {
        for (const host of ['rebound.example:3001', '127.0.0.1:3000', 'example.com']) {
            const response = await send('/curation', { headers: { host } });
            expect(response.status, host).toBe(421);
            expectCuratorHeaders(response);
        }
    });

    it('421s an X-Forwarded-Host that differs from Host', async () => {
        expect((await send('/curation', { headers: { 'x-forwarded-host': 'rebound.example' } })).status).toBe(421);
    });

    it('403s a mutation without an Origin naming the same host', async () => {
        for (const origin of [undefined, 'null', 'https://attacker.example', 'http://localhost:3001']) {
            for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
                const headers: Record<string, string> = origin === undefined ? {} : { origin };
                const response = await send('/curation/inbox', { method, headers });
                expect(response.status, `${method} with Origin ${origin}`).toBe(403);
                expectCuratorHeaders(response);
            }
        }
    });

    it('checks a GET carrying Next-Action as a mutation', async () => {
        expect((await send('/curation', { headers: { 'next-action': ACTION_ID } })).status).toBe(403);
    });

    it('passes a mutation whose Origin names the same allowed host', async () => {
        expect(passes(await send('/curation/inbox', { method: 'POST', headers: { origin: CURATOR_ORIGIN, 'next-action': ACTION_ID } }))).toBe(true);
    });

    it('503s every curator request while the bind is wrong', async () => {
        for (const hostname of ['0.0.0.0', '']) {
            vi.stubEnv('HOSTNAME', hostname);
            expect((await send('/curation')).status).toBe(503);
        }
    });

    it('holds every path on the curator process to the Host allowlist, the public ones too', async () => {
        for (const pathname of ['/', '/gallery', '/api/photos', '/api/health', '/media/p/r/w/x.webp', '/assets/photos/optimized/a.webp']) {
            for (const host of ['keyurgolani.photography', 'rebound.example:3001', '127.0.0.1:3000']) {
                const response = await send(pathname, { headers: { host } });
                expect(response.status, `${pathname} on ${host}`).toBe(421);
                expect(response.headers.get('cache-control')).toBe('no-store');
            }
            expect(passes(await send(pathname)), pathname).toBe(true);
        }
    });

    it('serves its public paths to an allowed Host, read-only as on web', async () => {
        expect(passes(await send('/api/health', { headers: { host: 'localhost:3001' } }))).toBe(true);
        expect((await send('/', { method: 'POST', headers: { origin: CURATOR_ORIGIN } })).status).toBe(404);
    });

    it('503s every path while the bind is wrong', async () => {
        vi.stubEnv('HOSTNAME', '0.0.0.0');
        expect((await send('/api/health')).status).toBe(503);
    });
});

describe('proxy.ts on web, with CURATION_ENABLED off', () => {
    it('leaves the public site to any Host', async () => {
        vi.stubEnv('CURATION_ENABLED', 'false');
        for (const host of ['keyurgolani.photography', 'rebound.example:3001', 'localhost:3000']) {
            expect(passes(await send('/', { headers: { host } })), host).toBe(true);
            expect(passes(await send('/api/photos', { headers: { host } })), host).toBe(true);
        }
    });
});

describe('a curator action ID posted outside the curator paths', () => {
    it.each([
        ['false', 404],
        ['true', 421],
    ])('is refused with CURATION_ENABLED=%s, whatever its Host and Origin', async (flag, otherHost) => {
        vi.stubEnv('CURATION_ENABLED', flag);
        for (const pathname of ['/', '/gallery', '/about', '/api/photos', '/media/p/r/w/x.webp']) {
            const cases: [Record<string, string>, number][] = [
                [{}, 404],
                [{ origin: CURATOR_ORIGIN }, 404],
                [{ host: 'keyurgolani.photography', origin: 'https://keyurgolani.photography' }, otherHost],
            ];
            for (const [headers, status] of cases) {
                const response = await send(pathname, { method: 'POST', headers: { 'next-action': ACTION_ID, ...headers } });
                expect(response.status, `${pathname} ${JSON.stringify(headers)}`).toBe(status);
            }
        }
    });

    it('404s every other non-read method there too, and passes GET, HEAD and OPTIONS', async () => {
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect((await send('/', { method })).status, method).toBe(404);
        for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(passes(await send('/', { method })), method).toBe(true);
    });

    it('is a 404 on /curation/inbox too when the Host or Origin checks fail, flag on or off', async () => {
        for (const flag of ['false', 'true']) {
            vi.stubEnv('CURATION_ENABLED', flag);
            for (const headers of [{ host: 'rebound.example:3001', origin: 'http://rebound.example:3001' }, {}, { origin: 'https://attacker.example' }] as Record<string, string>[]) {
                const response = await send('/curation/inbox', { method: 'POST', headers: { 'next-action': ACTION_ID, ...headers } });
                expect(passes(response), `${flag} ${JSON.stringify(headers)}`).toBe(false);
                expect([403, 404, 421]).toContain(response.status);
            }
        }
    });
});

describe("proxy.ts's matcher", () => {
    it.each(['/curation', '/curation/inbox', '/api/curation/events', '/'])('runs on %s', (url) => {
        expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
    });
});

describe("next.config.mjs's curator headers", () => {
    it.each(['/curation', '/curation/inbox', '/api/curation', '/api/curation/events/x'])('sends every curator header on %s', async (pathname) => {
        const response = await unstable_getResponseFromNextConfig({ url: `http://${CURATOR_HOST}${pathname}`, nextConfig });
        expectCuratorHeaders(response);
        expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    });

    it('keeps frame-ancestors in an entry of its own, so #16 can override it', async () => {
        const entries = await nextConfig.headers!();
        const framing = entries.filter((entry) => entry.headers.some((header) => header.key === 'Content-Security-Policy'));
        expect(framing.length).toBeGreaterThan(0);
        for (const entry of framing) expect(entry.headers).toEqual([{ key: 'Content-Security-Policy', value: "frame-ancestors 'none'" }]);
    });

    it('holds the same values as lib/curation/auth/policy.ts', async () => {
        const entries = await nextConfig.headers!();
        const sent = Object.fromEntries(entries.flatMap((entry) => entry.headers.map((header) => [header.key, header.value])));
        expect(sent).toEqual({ ...CURATOR_RESPONSE_HEADERS, ...CURATOR_FRAME_POLICY });
    });

    it('adds no curator header to the public site', async () => {
        for (const pathname of ['/', '/gallery', '/api/photos']) {
            const response = await unstable_getResponseFromNextConfig({ url: `http://localhost:3000${pathname}`, nextConfig });
            expect(response.headers.get('x-robots-tag'), pathname).toBeNull();
            expect(response.headers.get('content-security-policy'), pathname).toBeNull();
        }
    });
});
