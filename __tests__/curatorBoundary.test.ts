// @vitest-environment node
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch, unstable_getResponseFromNextConfig } from 'next/experimental/testing/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import nextConfig from '../next.config.mjs';
import { makeCuratorSecrets, type TestCuratorSecrets } from '../test/helpers/curatorSecrets';
import { resetLoginForTests } from '../lib/curation/auth/login';
import { CURATOR_FRAME_POLICY, CURATOR_RESPONSE_HEADERS } from '../lib/curation/auth/policy';
import { deleteSession, resetSessionsForTests, SESSION_COOKIE, signSessionId, createSession } from '../lib/curation/auth/sessions';
import { config, proxy } from '../proxy';

// proxy.ts on the curator paths (#14's 14-2): the flag, the Host allowlist,
// the Origin on a mutation, the session, the curator headers, and every
// other path refusing anything but a read.

/** A 42-hex server action ID, the shape Next sends in Next-Action. */
const ACTION_ID = '7f'.repeat(21);
const CURATOR_HOST = '127.0.0.1:3001';
const CURATOR_ORIGIN = `http://${CURATOR_HOST}`;

function send(pathname: string, init: { method?: string; headers?: Record<string, string> } = {}) {
    const headers = new Headers({ host: CURATOR_HOST, ...init.headers });
    return proxy(new NextRequest(new URL(pathname, `http://${headers.get('host') || CURATOR_HOST}`), { method: init.method ?? 'GET', headers }));
}

const passes = (response: Response) => response.headers.get('x-middleware-next') === '1';

function expectCuratorHeaders(response: Response) {
    for (const [name, value] of Object.entries(CURATOR_RESPONSE_HEADERS)) expect(response.headers.get(name)).toBe(value);
}

let secrets: TestCuratorSecrets;
/** A Cookie header for a live session under the test secret. */
let signedIn: string;

beforeAll(async () => {
    secrets = await makeCuratorSecrets();
});

afterAll(() => secrets.cleanup());

beforeEach(() => {
    vi.stubEnv('HOSTNAME', '127.0.0.1');
    vi.stubEnv('CURATOR_TUNNEL_PORT', '');
    vi.stubEnv('CURATION_BIND_SCOPE', '');
    for (const [name, value] of Object.entries(secrets.env)) vi.stubEnv(name, value);
    signedIn = secrets.cookie();
});

afterEach(() => {
    vi.unstubAllEnvs();
    resetSessionsForTests();
    resetLoginForTests();
});

describe('proxy.ts with CURATION_ENABLED off', () => {
    it.each([undefined, '', 'false', 'TRUE', '1'])('404s every curator path for %j, with the curator headers', (value) => {
        vi.stubEnv('CURATION_ENABLED', value);
        for (const pathname of ['/curation', '/curation/inbox', '/api/curation/events', '/Curation', '/%63uration/inbox']) {
            for (const method of ['GET', 'HEAD', 'POST']) {
                const response = send(pathname, { method, headers: { origin: CURATOR_ORIGIN } });
                expect(response.status, `${method} ${pathname}`).toBe(404);
                expectCuratorHeaders(response);
                expect(response.headers.get('content-security-policy')).toBe(CURATOR_FRAME_POLICY['Content-Security-Policy']);
            }
        }
    });

    it('reads the flag on every request, so a restart with it on is all it takes', () => {
        vi.stubEnv('CURATION_ENABLED', 'false');
        expect(send('/curation').status).toBe(404);
        vi.stubEnv('CURATION_ENABLED', 'true');
        expect(passes(send('/curation', { headers: { cookie: signedIn } }))).toBe(true);
        vi.stubEnv('CURATION_ENABLED', 'false');
        expect(send('/curation').status).toBe(404);
    });
});

describe('proxy.ts with CURATION_ENABLED=true', () => {
    beforeEach(() => {
        vi.stubEnv('CURATION_ENABLED', 'true');
    });

    it('passes a read on an allowed Host, with the curator headers', () => {
        for (const host of ['127.0.0.1:3001', 'localhost:3001']) {
            const response = send('/curation', { headers: { host, cookie: signedIn } });
            expect(passes(response)).toBe(true);
            expectCuratorHeaders(response);
        }
    });

    it('421s another Host, as after a DNS rebinding', () => {
        for (const host of ['rebound.example:3001', '127.0.0.1:3000', 'example.com']) {
            const response = send('/curation', { headers: { host } });
            expect(response.status, host).toBe(421);
            expectCuratorHeaders(response);
        }
    });

    it('421s an X-Forwarded-Host that differs from Host', () => {
        expect(send('/curation', { headers: { 'x-forwarded-host': 'rebound.example' } }).status).toBe(421);
    });

    it('403s a mutation without an Origin naming the same host', () => {
        for (const origin of [undefined, 'null', 'https://attacker.example', 'http://localhost:3001']) {
            for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
                const headers: Record<string, string> = origin === undefined ? {} : { origin };
                const response = send('/curation/inbox', { method, headers });
                expect(response.status, `${method} with Origin ${origin}`).toBe(403);
                expectCuratorHeaders(response);
            }
        }
    });

    it('checks a GET carrying Next-Action as a mutation', () => {
        expect(send('/curation', { headers: { 'next-action': ACTION_ID } }).status).toBe(403);
    });

    it('passes a mutation whose Origin names the same allowed host', () => {
        expect(passes(send('/curation/inbox', { method: 'POST', headers: { origin: CURATOR_ORIGIN, 'next-action': ACTION_ID, cookie: signedIn } }))).toBe(true);
    });

    it('503s every curator request while the bind is wrong', () => {
        for (const hostname of ['0.0.0.0', '']) {
            vi.stubEnv('HOSTNAME', hostname);
            expect(send('/curation').status).toBe(503);
        }
    });

    it('holds every path on the curator process to the Host allowlist, the public ones too', () => {
        for (const pathname of ['/', '/gallery', '/api/photos', '/api/health', '/media/p/r/w/x.webp', '/assets/photos/optimized/a.webp']) {
            for (const host of ['keyurgolani.photography', 'rebound.example:3001', '127.0.0.1:3000']) {
                const response = send(pathname, { headers: { host } });
                expect(response.status, `${pathname} on ${host}`).toBe(421);
                expect(response.headers.get('cache-control')).toBe('no-store');
            }
            // 13E closed every /assets/photos path, legacy derivatives included.
            if (pathname.startsWith('/assets/photos/')) expect(send(pathname).status, pathname).toBe(404);
            else expect(passes(send(pathname)), pathname).toBe(true);
        }
    });

    it('serves its public paths to an allowed Host, read-only as on web', () => {
        expect(passes(send('/api/health', { headers: { host: 'localhost:3001' } }))).toBe(true);
        expect(send('/', { method: 'POST', headers: { origin: CURATOR_ORIGIN } }).status).toBe(404);
    });

    it('503s every path while the bind is wrong', () => {
        vi.stubEnv('HOSTNAME', '0.0.0.0');
        expect(send('/api/health').status).toBe(503);
    });
});

describe('proxy.ts and the curator session', () => {
    beforeEach(() => {
        vi.stubEnv('CURATION_ENABLED', 'true');
    });

    const anonymous: [string, Record<string, string>][] = [
        ['no cookie', {}],
        ['an empty cookie', { cookie: `${SESSION_COOKIE}=` }],
        ['a made-up cookie', { cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}.${'B'.repeat(43)}` }],
    ];

    it.each(anonymous)('sends a page request with %s to the login page, with the curator headers', (_, headers) => {
        for (const pathname of ['/curation', '/curation/inbox', '/Curation', '/curation/login/', '/curation/Login', '/curation/%6cogin']) {
            for (const method of ['GET', 'HEAD']) {
                const response = send(pathname, { method, headers });
                expect(response.status, `${method} ${pathname}`).toBe(307);
                expect(response.headers.get('location')).toBe(`http://${CURATOR_HOST}/curation/login`);
                expectCuratorHeaders(response);
            }
        }
    });

    it.each(anonymous)('401s a route handler, /api/curation/media and a server action with %s', (_, headers) => {
        const cases: [string, string, Record<string, string>][] = [
            ['GET', '/api/curation/events', {}],
            ['GET', '/api/curation/media/ph_x/sha256-x/p_x/w800.webp', {}],
            ['HEAD', '/api/curation/media/ph_x/sha256-x/p_x/w800.webp', {}],
            ['POST', '/api/curation/logout', { origin: CURATOR_ORIGIN }],
            ['POST', '/curation/inbox', { origin: CURATOR_ORIGIN, 'next-action': ACTION_ID }],
            // An action ID posted to the login page needs a session like any other, and so does any other write to it.
            ['POST', '/curation/login', { origin: CURATOR_ORIGIN, 'next-action': ACTION_ID }],
            ['POST', '/curation/login', { origin: CURATOR_ORIGIN }],
            ['PUT', '/curation/login', { origin: CURATOR_ORIGIN }],
            ['GET', '/curation/login', { 'next-action': ACTION_ID, origin: CURATOR_ORIGIN }],
            ['DELETE', '/api/curation/login', { origin: CURATOR_ORIGIN }],
            ['POST', '/api/curation/login', { origin: CURATOR_ORIGIN, 'next-action': ACTION_ID }],
        ];
        for (const [method, pathname, extra] of cases) {
            const response = send(pathname, { method, headers: { ...headers, ...extra } });
            expect(response.status, `${method} ${pathname} ${JSON.stringify(extra)}`).toBe(401);
            expectCuratorHeaders(response);
        }
    });

    it('builds the login redirect on the allowed Host it came in on', () => {
        expect(send('/curation', { headers: { host: 'LOCALHOST:3001' } }).headers.get('location')).toBe('http://localhost:3001/curation/login');
    });

    it('lets the login page and its form through without a session, and nothing else', () => {
        expect(passes(send('/curation/login'))).toBe(true);
        expect(passes(send('/curation/login', { method: 'HEAD' }))).toBe(true);
        expect(passes(send('/api/curation/login', { method: 'POST', headers: { origin: CURATOR_ORIGIN } }))).toBe(true);
        // The form still needs its Origin, and the page its Host.
        expect(send('/api/curation/login', { method: 'POST' }).status).toBe(403);
        expect(send('/api/curation/login', { method: 'POST', headers: { origin: 'https://attacker.example' } }).status).toBe(403);
        expect(send('/curation/login', { headers: { host: 'rebound.example:3001' } }).status).toBe(421);
        expect(send('/api/curation/login').status).toBe(401);
    });

    it('passes a page, a handler and an action with a live session', () => {
        expect(passes(send('/curation', { headers: { cookie: signedIn } }))).toBe(true);
        expect(passes(send('/api/curation/media/ph_x/sha256-x/p_x/w800.webp', { headers: { cookie: signedIn } }))).toBe(true);
        expect(passes(send('/api/curation/logout', { method: 'POST', headers: { cookie: signedIn, origin: CURATOR_ORIGIN } }))).toBe(true);
    });

    it('refuses a cookie once its session ends, replayed or not', () => {
        const id = createSession();
        const cookie = `${SESSION_COOKIE}=${signSessionId(id, secrets.sessionKey)}`;
        expect(passes(send('/curation', { headers: { cookie } }))).toBe(true);
        deleteSession(id);
        expect(send('/curation', { headers: { cookie } }).status).toBe(307);
        expect(send('/api/curation/events', { headers: { cookie } }).status).toBe(401);
    });

    it('refuses a cookie past its 12 hours', () => {
        const cookie = secrets.cookie(Date.now() - 12 * 3600_000 - 1);
        expect(send('/curation', { headers: { cookie } }).status).toBe(307);
        expect(send('/api/curation/events', { headers: { cookie } }).status).toBe(401);
    });

    it('refuses a cookie signed under another secret', () => {
        const cookie = `${SESSION_COOKIE}=${signSessionId(createSession(), Buffer.alloc(32, 7))}`;
        expect(send('/api/curation/events', { headers: { cookie } }).status).toBe(401);
    });

    it('checks Host and Origin before the session, so a cross-site post without one is a 403, not a 401', () => {
        expect(send('/curation/inbox', { method: 'POST', headers: { 'next-action': ACTION_ID } }).status).toBe(403);
        expect(send('/curation', { headers: { host: 'rebound.example:3001' } }).status).toBe(421);
    });

    it('503s every path, the login page and the public ones too, while a secret file is missing', () => {
        vi.stubEnv('CURATOR_SESSION_SECRET_FILE', `${secrets.dir}/missing.key`);
        for (const pathname of ['/curation', '/curation/login', '/api/curation/login', '/api/curation/media/x', '/', '/api/health']) {
            const response = send(pathname, { headers: { cookie: signedIn } });
            expect(response.status, pathname).toBe(503);
        }
        expect(send('/api/curation/login', { method: 'POST', headers: { origin: CURATOR_ORIGIN } }).status).toBe(503);
        vi.stubEnv('CURATION_ENABLED', 'false');
        expect(send('/curation').status).toBe(404);
    });
});

describe('proxy.ts on web, with CURATION_ENABLED off', () => {
    it('leaves the public site to any Host', () => {
        vi.stubEnv('CURATION_ENABLED', 'false');
        for (const host of ['keyurgolani.photography', 'rebound.example:3001', 'localhost:3000']) {
            expect(passes(send('/', { headers: { host } })), host).toBe(true);
            expect(passes(send('/api/photos', { headers: { host } })), host).toBe(true);
        }
    });
});

describe('a curator action ID posted outside the curator paths', () => {
    it.each([
        ['false', 404],
        ['true', 421],
    ])('is refused with CURATION_ENABLED=%s, whatever its Host and Origin', (flag, otherHost) => {
        vi.stubEnv('CURATION_ENABLED', flag);
        for (const pathname of ['/', '/gallery', '/about', '/api/photos', '/media/p/r/w/x.webp']) {
            const cases: [Record<string, string>, number][] = [
                [{}, 404],
                [{ origin: CURATOR_ORIGIN }, 404],
                [{ host: 'keyurgolani.photography', origin: 'https://keyurgolani.photography' }, otherHost],
            ];
            for (const [headers, status] of cases) {
                const response = send(pathname, { method: 'POST', headers: { 'next-action': ACTION_ID, ...headers } });
                expect(response.status, `${pathname} ${JSON.stringify(headers)}`).toBe(status);
            }
        }
    });

    it('404s every other non-read method there too, and passes GET, HEAD and OPTIONS', () => {
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(send('/', { method }).status, method).toBe(404);
        for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(passes(send('/', { method })), method).toBe(true);
    });

    it('is a 404 on /curation/inbox too when the Host or Origin checks fail, flag on or off', () => {
        for (const flag of ['false', 'true']) {
            vi.stubEnv('CURATION_ENABLED', flag);
            for (const headers of [{ host: 'rebound.example:3001', origin: 'http://rebound.example:3001' }, {}, { origin: 'https://attacker.example' }] as Record<string, string>[]) {
                const response = send('/curation/inbox', { method: 'POST', headers: { 'next-action': ACTION_ID, ...headers } });
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

    it("keeps frame-ancestors in entries of their own, 'none' everywhere but #16's preview site", async () => {
        const entries = await nextConfig.headers!();
        const framing = entries.filter((entry) => entry.headers.some((header) => header.key === 'Content-Security-Policy'));
        expect(framing.length).toBeGreaterThan(0);
        for (const entry of framing) {
            const value = entry.source.startsWith('/curation/preview/:draftId/site') ? "frame-ancestors 'self'" : "frame-ancestors 'none'";
            expect(entry.headers, entry.source).toEqual([{ key: 'Content-Security-Policy', value }]);
        }
        expect(framing.filter((entry) => entry.headers[0].value === "frame-ancestors 'self'").map((entry) => entry.source))
            .toEqual(['/curation/preview/:draftId/site', '/curation/preview/:draftId/site/:path*']);
    });

    it('holds the same values as lib/curation/auth/policy.ts', async () => {
        const entries = await nextConfig.headers!();
        const curator = entries.filter((entry) => !entry.source.startsWith('/curation/preview/'));
        const sent = Object.fromEntries(curator.flatMap((entry) => entry.headers.map((header) => [header.key, header.value])));
        expect(sent).toEqual({ ...CURATOR_RESPONSE_HEADERS, ...CURATOR_FRAME_POLICY });
    });

    it.each(['/curation/preview/rev_x/site', '/curation/preview/rev_x/site/work/a', '/curation/preview/rev_x/site/media/a/b/c/w400.avif'])(
        "lets the same origin frame #16's preview site at %s, with every other curator header",
        async (pathname) => {
            const response = await unstable_getResponseFromNextConfig({ url: `http://${CURATOR_HOST}${pathname}`, nextConfig });
            expectCuratorHeaders(response);
            expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
        },
    );

    it.each(['/curation/preview', '/curation/preview/rev_x', '/curation/preview/rev_x/sitex', '/curation/preview/rev_x/other/site', '/curation/previews/rev_x/site'])(
        "keeps frame-ancestors 'none' on %s, outside the preview site",
        async (pathname) => {
            const response = await unstable_getResponseFromNextConfig({ url: `http://${CURATOR_HOST}${pathname}`, nextConfig });
            expectCuratorHeaders(response);
            expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
        },
    );

    it('adds no curator header to the public site', async () => {
        for (const pathname of ['/', '/gallery', '/api/photos']) {
            const response = await unstable_getResponseFromNextConfig({ url: `http://localhost:3000${pathname}`, nextConfig });
            expect(response.headers.get('x-robots-tag'), pathname).toBeNull();
            expect(response.headers.get('content-security-policy'), pathname).toBeNull();
        }
    });
});
