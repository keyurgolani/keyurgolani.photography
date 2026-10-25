// @vitest-environment node
import fs from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { attemptLogin, MAX_FAILURES, resetLoginForTests } from '../lib/curation/auth/login';
import { parsePassphraseHash } from '../lib/curation/auth/passphrase';
import { evaluateCuratorRequest } from '../lib/curation/auth/policy';
import { createSession, resetSessionsForTests, SESSION_COOKIE, sessionFromCookies, signSessionId } from '../lib/curation/auth/sessions';
import { makeCuratorSecrets, type TestCuratorSecrets } from '../test/helpers/curatorSecrets';

// #14's 14-2 login and logout handlers and the login page, called the way
// Next calls them, with next/headers giving the request's headers. Test
// values only.

let requestHeaders = new Headers();
vi.mock('next/headers', () => ({ headers: async () => requestHeaders }));

const HOST = '127.0.0.1:3001';
const ORIGIN = `http://${HOST}`;

let secrets: TestCuratorSecrets;

beforeAll(async () => {
    secrets = await makeCuratorSecrets();
});

afterAll(() => secrets.cleanup());

beforeEach(() => {
    vi.stubEnv('CURATION_ENABLED', 'true');
    vi.stubEnv('HOSTNAME', '127.0.0.1');
    vi.stubEnv('CURATOR_TUNNEL_PORT', '');
    vi.stubEnv('CURATION_BIND_SCOPE', '');
    for (const [name, value] of Object.entries(secrets.env)) vi.stubEnv(name, value);
});

afterEach(() => {
    vi.unstubAllEnvs();
    requestHeaders = new Headers();
    resetSessionsForTests();
    resetLoginForTests();
});

const { POST: login } = await import('../app/api/curation/login/route');
const { POST: logout } = await import('../app/api/curation/logout/route');
const { default: LoginPage } = await import('../app/curation/login/page');

/** POSTs the login form the way a browser does, with the curator's Host and Origin unless told otherwise. */
async function postLogin(body: string | null, headers: Record<string, string> = {}) {
    requestHeaders = new Headers({ host: HOST, origin: ORIGIN, ...headers });
    const request = new Request(`${ORIGIN}/api/curation/login`, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(body === null ? {} : { 'content-length': String(Buffer.byteLength(body)) }), ...headers },
    });
    return login(request);
}

const form = (passphrase: string) => new URLSearchParams({ passphrase }).toString();
const cookieFrom = (response: Response) => response.headers.get('set-cookie')?.split(';')[0] ?? null;

/** Everything about a response a client can see, for comparing two answers. */
async function answer(response: Response) {
    return { status: response.status, headers: [...response.headers.entries()].sort(), body: await response.text() };
}

describe('POST /api/curation/login', () => {
    it('starts a session for the right passphrase, and sends the curator to /curation with the cookie', async () => {
        const response = await postLogin(form(secrets.passphrase));
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe('/curation');
        const setCookie = response.headers.get('set-cookie')!;
        expect(setCookie.split('; ').slice(1).sort()).toEqual(['HttpOnly', 'Max-Age=43200', 'Path=/', 'SameSite=Strict', 'Secure']);
        expect(sessionFromCookies(cookieFrom(response), secrets.sessionKey)).not.toBeNull();
        expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it('gives a new session ID at every login, and ends the one the request carried', async () => {
        const first = cookieFrom(await postLogin(form(secrets.passphrase)))!;
        const second = cookieFrom(await postLogin(form(secrets.passphrase), { cookie: first }))!;
        expect(second).not.toBe(first);
        expect(sessionFromCookies(first, secrets.sessionKey)).toBeNull();
        expect(sessionFromCookies(second, secrets.sessionKey)).not.toBeNull();
    });

    it('answers a wrong passphrase with the login page again and no cookie', async () => {
        const response = await postLogin(form('not the passphrase'));
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe('/curation/login?failed=1');
        expect(response.headers.get('set-cookie')).toBeNull();
    });

    it('answers the lock exactly as it answers a wrong passphrase, even for the right one', async () => {
        const wrong = await answer(await postLogin(form('not the passphrase')));
        for (let i = 1; i < MAX_FAILURES; i++) await postLogin(form('not the passphrase'));
        const locked = await answer(await postLogin(form(secrets.passphrase)));
        expect(locked).toEqual(wrong);
    });

    it.each([
        ['no passphrase field', 'other=1'],
        ['an empty passphrase', 'passphrase='],
        ['a body that is no form', '{"passphrase":"x"}'],
    ])('treats %s as a failed login that counts', async (_, body) => {
        const wrong = await answer(await postLogin(form('not the passphrase')));
        resetLoginForTests();
        for (let i = 0; i < MAX_FAILURES; i++) expect(await answer(await postLogin(body))).toEqual(wrong);
        expect((await postLogin(form(secrets.passphrase))).headers.get('set-cookie')).toBeNull();
    });

    it('refuses a body too big for a passphrase form, the same way', async () => {
        const response = await postLogin(form(`${secrets.passphrase}${'x'.repeat(20_000)}`));
        expect(response.headers.get('location')).toBe('/curation/login?failed=1');
    });

    it.each([
        ['no Origin', { origin: '' }],
        ['another Origin', { origin: 'https://attacker.example' }],
        ['another Host', { host: 'rebound.example:3001', origin: 'http://rebound.example:3001' }],
    ])('starts nothing with %s', async (_, headers) => {
        const outcome = await postLogin(form(secrets.passphrase), headers).catch((error: unknown) => error);
        expect(String((outcome as { digest?: string }).digest)).toMatch(/^NEXT_HTTP_ERROR_FALLBACK;404/);
    });

    it("starts nothing while a secret file can't be read", async () => {
        vi.stubEnv('CURATOR_PASSPHRASE_HASH_FILE', `${secrets.hashFile}.missing`);
        const outcome = await postLogin(form(secrets.passphrase)).catch((error: unknown) => error);
        expect(String((outcome as { digest?: string }).digest)).toMatch(/^NEXT_HTTP_ERROR_FALLBACK;404/);
    });
});

describe('POST /api/curation/logout', () => {
    it('ends the session, clears the cookie, and sends the curator to the login page', async () => {
        const cookie = cookieFrom(await postLogin(form(secrets.passphrase)))!;
        requestHeaders = new Headers({ host: HOST, origin: ORIGIN, cookie });
        const response = await logout();
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe('/curation/login');
        expect(response.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=; .*Max-Age=0`));
        expect(sessionFromCookies(cookie, secrets.sessionKey)).toBeNull();
    });

    it('leaves a cookie replayed after it worth nothing, at the proxy too', async () => {
        const cookie = cookieFrom(await postLogin(form(secrets.passphrase)))!;
        requestHeaders = new Headers({ host: HOST, origin: ORIGIN, cookie });
        await logout();
        const replay = evaluateCuratorRequest({ host: HOST, origin: ORIGIN, forwardedHost: null, mutation: true, session: { cookie } }, process.env, process.argv);
        expect(replay).toEqual({ status: 401, reason: 'session' });
        requestHeaders = new Headers({ host: HOST, origin: ORIGIN, cookie });
        const again = await logout().catch((error: unknown) => error);
        expect(String((again as { digest?: string }).digest)).toMatch(/^NEXT_HTTP_ERROR_FALLBACK;404/);
    });

    it('ends nothing without the Origin, so another site can\'t sign the curator out', async () => {
        const cookie = cookieFrom(await postLogin(form(secrets.passphrase)))!;
        requestHeaders = new Headers({ host: HOST, cookie });
        const outcome = await logout().catch((error: unknown) => error);
        expect(String((outcome as { digest?: string }).digest)).toMatch(/^NEXT_HTTP_ERROR_FALLBACK;404/);
        expect(sessionFromCookies(cookie, secrets.sessionKey)).not.toBeNull();
    });
});

describe('the login page', () => {
    async function render(search: Record<string, string> = {}, cookie?: string) {
        requestHeaders = new Headers({ host: HOST, ...(cookie ? { cookie } : {}) });
        return renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(search) }));
    }

    it('is a form that posts the passphrase to /api/curation/login', async () => {
        const html = await render();
        expect(html).toContain('action="/api/curation/login"');
        expect(html).toContain('method="post"');
        expect(html).toMatch(/<label[^>]*for="curator-passphrase"/);
        expect(html).toMatch(/<input[^>]*type="password"[^>]*>/);
        expect(html).toMatch(/<input[^>]*name="passphrase"/);
        expect(html).not.toContain('role="alert"');
    });

    it('says a login failed, without saying why', async () => {
        const html = await render({ failed: '1' });
        expect(html).toContain('role="alert"');
        expect(html).toContain('That didn&#x27;t sign you in.');
        expect(html).not.toMatch(/paused/);
    });

    it('says the lock is on while it is, and nothing about any passphrase', async () => {
        const hash = parsePassphraseHash(fs.readFileSync(secrets.hashFile, 'utf8'))!;
        for (let i = 0; i < MAX_FAILURES; i++) await attemptLogin('not the passphrase', hash);
        const html = await render({ failed: '1' });
        expect(html).toContain('Login is paused for 15 minutes');
        expect(html).toContain('That didn&#x27;t sign you in.');
        expect(html).not.toContain(secrets.passphrase);
    });

    it('sends a signed-in curator on to /curation', async () => {
        const cookie = `${SESSION_COOKIE}=${signSessionId(createSession(), secrets.sessionKey)}`;
        const outcome = await render({}, cookie).catch((error: unknown) => error);
        expect(String((outcome as { digest?: string }).digest)).toMatch(/^NEXT_REDIRECT;replace;\/curation;/);
    });
});
