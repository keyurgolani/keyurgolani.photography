// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch, unstable_getResponseFromNextConfig } from 'next/experimental/testing/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import nextConfig from '../next.config.mjs';
import { makeCuratorSecrets, type TestCuratorSecrets } from '../test/helpers/curatorSecrets';
import { resetLoginForTests } from '../lib/curation/auth/login';
import { CURATOR_FRAME_POLICY, CURATOR_RESPONSE_HEADERS } from '../lib/curation/auth/policy';
import { deleteSession, resetSessionsForTests, SESSION_COOKIE, signSessionId, createSession } from '../lib/curation/auth/sessions';
import { THEME_INIT_SCRIPT } from '../components/site/themeScript';
import { UNAVAILABLE_CSP, UNAVAILABLE_HTML } from '../lib/curation/auth/unavailable';
import { config, proxy } from '../proxy';

// proxy.ts on the curator paths (#14's 14-2): the flag, the Host allowlist,
// the Origin on a mutation, the session, the curator headers, and every
// other path refusing anything but a read.

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
    vi.stubEnv('CURATOR_PUBLISH', '');
    vi.stubEnv('CURATOR_HOST_PORT', '');
    vi.stubEnv('CURATOR_EXTRA_HOSTS', '');
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
        expect(passes(await send('/curation', { headers: { cookie: signedIn } }))).toBe(true);
        vi.stubEnv('CURATION_ENABLED', 'false');
        expect((await send('/curation')).status).toBe(404);
    });
});

describe('proxy.ts with CURATION_ENABLED=true', () => {
    let emptyDataRoot = '';

    beforeAll(() => {
        emptyDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-data-root-'));
    });

    afterAll(() => {
        fs.rmSync(emptyDataRoot, { recursive: true, force: true });
    });

    beforeEach(() => {
        vi.stubEnv('CURATION_ENABLED', 'true');
    });

    it('passes a read on an allowed Host, with the curator headers', async () => {
        for (const host of ['127.0.0.1:3001', 'localhost:3001']) {
            const response = await send('/curation', { headers: { host, cookie: signedIn } });
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
        expect(passes(await send('/curation/inbox', { method: 'POST', headers: { origin: CURATOR_ORIGIN, 'next-action': ACTION_ID, cookie: signedIn } }))).toBe(true);
    });

    it('503s every curator request while the bind is wrong', async () => {
        for (const hostname of ['0.0.0.0', '']) {
            vi.stubEnv('HOSTNAME', hostname);
            expect((await send('/curation')).status).toBe(503);
        }
    });

    it('holds every path on the curator process to the Host allowlist, the public ones too', async () => {
        // An empty data root, so the legacy derivative below passes on an allowed Host (legacy mode).
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', emptyDataRoot);
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

describe('proxy.ts and the curator session', () => {
    beforeEach(() => {
        vi.stubEnv('CURATION_ENABLED', 'true');
    });

    const anonymous: [string, Record<string, string>][] = [
        ['no cookie', {}],
        ['an empty cookie', { cookie: `${SESSION_COOKIE}=` }],
        ['a made-up cookie', { cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}.${'B'.repeat(43)}` }],
    ];

    it.each(anonymous)('sends a page request with %s to the login page, with the curator headers', async (_, headers) => {
        // Only a cookie that was sent and no longer counts gets ?ended=1, so the page can say the session ended.
        const login = headers.cookie && headers.cookie !== `${SESSION_COOKIE}=` ? '/curation/login?ended=1' : '/curation/login';
        for (const pathname of ['/curation', '/curation/inbox', '/Curation', '/curation/login/', '/curation/Login', '/curation/%6cogin']) {
            for (const method of ['GET', 'HEAD']) {
                const response = await send(pathname, { method, headers });
                expect(response.status, `${method} ${pathname}`).toBe(307);
                expect(response.headers.get('location')).toBe(`http://${CURATOR_HOST}${login}`);
                expectCuratorHeaders(response);
            }
        }
    });

    it('says ended for a session that ended, and for a cookie past its 12 hours, but adds nothing else', async () => {
        const id = createSession();
        const cookie = `${SESSION_COOKIE}=${signSessionId(id, secrets.sessionKey)}`;
        deleteSession(id);
        expect((await send('/curation', { headers: { cookie } })).headers.get('location')).toBe(`http://${CURATOR_HOST}/curation/login?ended=1`);
        const old = secrets.cookie(Date.now() - 12 * 3600_000 - 1);
        expect((await send('/curation/inbox', { headers: { cookie: old } })).headers.get('location')).toBe(`http://${CURATOR_HOST}/curation/login?ended=1`);
        expect((await send('/curation', { headers: { cookie: 'theme=dark' } })).headers.get('location')).toBe(`http://${CURATOR_HOST}/curation/login`);
        // A handler still gets its bare 401.
        expect((await send('/api/curation/events', { headers: { cookie } })).status).toBe(401);
    });

    it.each(anonymous)('401s a route handler, /api/curation/media and a server action with %s', async (_, headers) => {
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
            const response = await send(pathname, { method, headers: { ...headers, ...extra } });
            expect(response.status, `${method} ${pathname} ${JSON.stringify(extra)}`).toBe(401);
            expectCuratorHeaders(response);
        }
    });

    it('builds the login redirect on the allowed Host it came in on', async () => {
        expect((await send('/curation', { headers: { host: 'LOCALHOST:3001' } })).headers.get('location')).toBe('http://localhost:3001/curation/login');
    });

    it('lets the login page and its form through without a session, and nothing else', async () => {
        expect(passes(await send('/curation/login'))).toBe(true);
        expect(passes(await send('/curation/login', { method: 'HEAD' }))).toBe(true);
        expect(passes(await send('/api/curation/login', { method: 'POST', headers: { origin: CURATOR_ORIGIN } }))).toBe(true);
        // The form still needs its Origin, and the page its Host.
        expect((await send('/api/curation/login', { method: 'POST' })).status).toBe(403);
        expect((await send('/api/curation/login', { method: 'POST', headers: { origin: 'https://attacker.example' } })).status).toBe(403);
        expect((await send('/curation/login', { headers: { host: 'rebound.example:3001' } })).status).toBe(421);
        expect((await send('/api/curation/login')).status).toBe(401);
    });

    it('passes a page, a handler and an action with a live session', async () => {
        expect(passes(await send('/curation', { headers: { cookie: signedIn } }))).toBe(true);
        expect(passes(await send('/api/curation/media/ph_x/sha256-x/p_x/w800.webp', { headers: { cookie: signedIn } }))).toBe(true);
        expect(passes(await send('/api/curation/logout', { method: 'POST', headers: { cookie: signedIn, origin: CURATOR_ORIGIN } }))).toBe(true);
    });

    it('refuses a cookie once its session ends, replayed or not', async () => {
        const id = createSession();
        const cookie = `${SESSION_COOKIE}=${signSessionId(id, secrets.sessionKey)}`;
        expect(passes(await send('/curation', { headers: { cookie } }))).toBe(true);
        deleteSession(id);
        expect((await send('/curation', { headers: { cookie } })).status).toBe(307);
        expect((await send('/api/curation/events', { headers: { cookie } })).status).toBe(401);
    });

    it('refuses a cookie past its 12 hours', async () => {
        const cookie = secrets.cookie(Date.now() - 12 * 3600_000 - 1);
        expect((await send('/curation', { headers: { cookie } })).status).toBe(307);
        expect((await send('/api/curation/events', { headers: { cookie } })).status).toBe(401);
    });

    it('refuses a cookie signed under another secret', async () => {
        const cookie = `${SESSION_COOKIE}=${signSessionId(createSession(), Buffer.alloc(32, 7))}`;
        expect((await send('/api/curation/events', { headers: { cookie } })).status).toBe(401);
    });

    it('checks Host and Origin before the session, so a cross-site post without one is a 403, not a 401', async () => {
        expect((await send('/curation/inbox', { method: 'POST', headers: { 'next-action': ACTION_ID } })).status).toBe(403);
        expect((await send('/curation', { headers: { host: 'rebound.example:3001' } })).status).toBe(421);
    });

    it('503s every path, the login page and the public ones too, while a secret file is missing, with one page that says where to look', async () => {
        vi.stubEnv('CURATOR_SESSION_SECRET_FILE', `${secrets.dir}/missing.key`);
        const answers: Response[] = [];
        for (const pathname of ['/curation', '/curation/login', '/api/curation/login', '/api/curation/media/x', '/', '/api/health', '/curation?x=<script>']) {
            const response = await send(pathname, { headers: { cookie: signedIn } });
            expect(response.status, pathname).toBe(503);
            answers.push(response);
        }
        answers.push(await send('/api/curation/login', { method: 'POST', headers: { origin: CURATOR_ORIGIN } }));
        answers.push(await send('/curation', { method: 'HEAD' }));
        const [first] = answers;
        const body = await first.text();
        expect(body).toBe(UNAVAILABLE_HTML);
        for (const response of answers) {
            expect(response.status).toBe(503);
            expectCuratorHeaders(response);
            expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
            expect(response.headers.get('x-content-type-options')).toBe('nosniff');
            expect(response.headers.get('content-security-policy')).toBe(UNAVAILABLE_CSP);
            if (response !== first) expect(await response.text()).toBe(body);
        }
        // What it says: a secret file, the log, the docs and a restart, and not which file or setting.
        expect(body).toContain("The curator can't sign you in yet");
        expect(body).toContain('A secret file it needs is missing, unreadable, readable by anyone but its owner, or not in the format the setup commands write');
        expect(body).toContain("The curator's log names the setting");
        expect(body).toContain('docs/curator.md');
        expect(body).toContain('restart curator on the server');
        // (The theme script, pinned byte for byte below, reads a storage event's `e.key`.)
        expect(body.replace(/<script>[\s\S]*?<\/script>/, '')).not.toMatch(/CURATOR_|_FILE|\.key|secrets\/|missing\.key/);
        // It loads nothing, and runs only the theme script, inline, which the policy allows by its hash, byte for byte, so
        // the page paints in the visitor's theme (P3-9). It sits after the charset and before the style.
        const scripts = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
        expect(scripts).toEqual([THEME_INIT_SCRIPT]);
        expect(body.replace(/<script>[\s\S]*?<\/script>/, '')).not.toMatch(/<script|<link|<img|src=|href=|url\(|@import/i);
        expect(body.indexOf('<meta charset')).toBeLessThan(body.indexOf('<script>'));
        expect(body.indexOf('<script>')).toBeLessThan(body.indexOf('<style>'));
        // Its one style element is the one the policy allows by hash, and the policy allows nothing else.
        const style = /<style>([\s\S]*?)<\/style>/.exec(body)![1];
        const { createHash } = await import('node:crypto');
        const sha = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
        expect(UNAVAILABLE_CSP).toBe(
            `default-src 'none'; script-src ${sha(THEME_INIT_SCRIPT)}; style-src ${sha(style)}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        );
        // Pinned, so a change to the page's style or the theme script shows up here and in review as a new hash.
        expect(UNAVAILABLE_CSP).toContain("script-src 'sha256-pMyO2mbBmfmwymS5MXxwmBXN1Dz7DlvdbhqEXcCfKP8=';");
        expect(UNAVAILABLE_CSP).toContain("style-src 'sha256-EHgSSYxo+QHtVIWwJmGdLJPf/dQw5neR4YRsrH+htn4=';");
        expect(body.match(/<style>/g)).toHaveLength(1);
        vi.stubEnv('CURATION_ENABLED', 'false');
        expect((await send('/curation')).status).toBe(404);
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

    it("keeps frame-ancestors in entries of their own, 'none' on the curator but #16's preview site, and 'self' site-wide before it", async () => {
        const entries = await nextConfig.headers!();
        const framing = entries.filter((entry) => entry.headers.some((header) => header.key === 'Content-Security-Policy'));
        expect(framing.length).toBeGreaterThan(0);
        for (const entry of framing) {
            const self = entry.source === '/:path*' || entry.source.startsWith('/curation/preview/:draftId/site');
            const value = self ? "frame-ancestors 'self'" : "frame-ancestors 'none'";
            expect(entry.headers, entry.source).toEqual([{ key: 'Content-Security-Policy', value }]);
        }
        expect(framing.filter((entry) => entry.headers[0].value === "frame-ancestors 'self'").map((entry) => entry.source))
            .toEqual(['/:path*', '/curation/preview/:draftId/site', '/curation/preview/:draftId/site/:path*']);
    });

    // Today no visitor or curator policy sends script-src, so the inline theme script runs unhashed (spec §7). The day
    // one does, it has to allow the script by its hash, or every page paints Black before a stored Light choice.
    it("allows the theme script by its hash in any policy that sends script-src", async () => {
        const { createHash } = await import('node:crypto');
        const hash = `'sha256-${createHash('sha256').update(THEME_INIT_SCRIPT).digest('base64')}'`;
        const entries = await nextConfig.headers!();
        const policies = [
            ...entries.flatMap((entry) => entry.headers.filter((header) => header.key.toLowerCase() === 'content-security-policy').map((header) => header.value)),
            ...Object.entries(CURATOR_RESPONSE_HEADERS).filter(([key]) => key.toLowerCase() === 'content-security-policy').map(([, value]) => value),
        ];
        expect(policies.length).toBeGreaterThan(0);
        for (const policy of policies) if (/(^|;)\s*script-src\b/.test(policy)) expect(policy).toContain(hash);
    });

    it('holds the same values as lib/curation/auth/policy.ts', async () => {
        const entries = await nextConfig.headers!();
        // The site-wide entries (siteHeaders.test.ts) and #16's preview site aside.
        const curator = entries.filter((entry) => entry.source !== '/:path*' && !entry.source.startsWith('/curation/preview/'));
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
            expect(response.headers.get('cache-control'), pathname).toBeNull();
            expect(response.headers.get('referrer-policy'), pathname).toBe('strict-origin-when-cross-origin');
            // The site's own framing policy, never the curator's 'none'.
            expect(response.headers.get('content-security-policy'), pathname).toBe("frame-ancestors 'self'");
        }
    });
});

describe('proxy.ts in LAN mode', () => {
    beforeEach(() => {
        vi.stubEnv('CURATION_ENABLED', 'true');
        vi.stubEnv('CURATOR_PUBLISH', '192.168.86.250');
        vi.stubEnv('CURATOR_EXTRA_HOSTS', 'homelab.local:3443');
    });

    it('sends a page without a session to the login on the scheme it came in on: https only from a TLS proxy on a LAN name', async () => {
        const login = async (host: string, proto?: string) =>
            (await send('/curation', { headers: { host, ...(proto ? { 'x-forwarded-proto': proto } : {}) } })).headers.get('location');
        expect(await login('homelab.local:3443', 'https')).toBe('https://homelab.local:3443/curation/login');
        // A TLS proxy on 443 passes on the Host the browser sent, with no port.
        vi.stubEnv('CURATOR_EXTRA_HOSTS', 'homelab.local:3443,homelab.local:443');
        expect(await login('homelab.local', 'https')).toBe('https://homelab.local/curation/login');
        expect((await send('/curation', { headers: { host: 'homelab.local' } })).status).toBe(421);
        expect(await login('192.168.86.250:3001', 'http')).toBe('http://192.168.86.250:3001/curation/login');
        expect(await login('192.168.86.250:3001')).toBe('http://192.168.86.250:3001/curation/login');
        // The loopback names keep today's http, whatever the header says.
        expect(await login(CURATOR_HOST, 'https')).toBe(`http://${CURATOR_HOST}/curation/login`);
    });

    it('takes a mutation with an https Origin on a LAN name, and refuses one on another host', async () => {
        const post = (origin: string) =>
            send('/api/curation/events', { method: 'POST', headers: { host: 'homelab.local:3443', origin, 'x-forwarded-proto': 'https', cookie: signedIn } });
        expect(passes(await post('https://homelab.local:3443'))).toBe(true);
        expect((await post('https://attacker.example')).status).toBe(403);
    });
});
