// @vitest-environment node
import fs from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { attemptLogin, LOCK_MS, MAX_FAILURES, resetLoginForTests } from '../lib/curation/auth/login';
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
    it('ends the session, clears the cookie, and sends the curator to the login page, which says so', async () => {
        const cookie = cookieFrom(await postLogin(form(secrets.passphrase)))!;
        requestHeaders = new Headers({ host: HOST, origin: ORIGIN, cookie });
        const response = await logout();
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe('/curation/login?signed-out=1');
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

    /** The passphrase field's own tag. */
    const field = (html: string) => /<input[^>]*id="curator-passphrase"[^>]*>/.exec(html)?.[0] ?? '';
    /** The notice's text, with tags dropped and entities read. */
    const notice = (html: string) =>
        (/<p id="curator-login-notice"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '')
            .replace(/<[^>]+>/g, '')
            .replace(/&#x27;/g, "'");
    const hash = () => parsePassphraseHash(fs.readFileSync(secrets.hashFile, 'utf8'))!;

    it('is a form that posts the passphrase to /api/curation/login, with a button that waits for the page to hydrate', async () => {
        const html = await render();
        expect(html).toContain('action="/api/curation/login"');
        expect(html).toContain('method="post"');
        expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Sign in<\/button>/);
        expect(html).toMatch(/<label[^>]*for="curator-passphrase"/);
        expect(field(html)).toMatch(/type="password"/);
        expect(field(html)).toMatch(/name="passphrase"/);
        expect(field(html)).toMatch(/autoComplete="current-password"|autocomplete="current-password"/);
        expect(field(html)).not.toMatch(/aria-invalid|aria-describedby/);
        expect(html).not.toContain('role="alert"');
        expect(html).not.toContain('curator-login-notice');
    });

    it('says "Sign in" throughout, under the curator\'s wordmark', async () => {
        const html = await render();
        expect(html).toContain('<h1');
        expect(html).toMatch(/<h1[^>]*>Sign in to curation<\/h1>/);
        expect(html).toMatch(/<header[^>]*>[\s\S]*Portfolio curation[\s\S]*<\/header>/);
        // The words a reader sees, not the paths in the markup.
        expect(html.replace(/<[^>]+>/g, ' ')).not.toMatch(/log ?in/i);
    });

    it('carries a fixed username for password managers, hidden, out of the tab order, and not sent as anything the handler reads', async () => {
        const html = await render();
        const username = /<input[^>]*name="username"[^>]*>/.exec(html)?.[0] ?? '';
        expect(username).toMatch(/autoComplete="username"|autocomplete="username"/);
        expect(username).toContain('value="curator"');
        expect(username).toContain('hidden=""');
        expect(username).toContain('aria-hidden="true"');
        expect(username).toContain('tabindex="-1"');
        expect(username).toMatch(/readOnly=""|readonly=""/);
        // It comes before the passphrase, where password managers look for it.
        expect(html.indexOf('name="username"')).toBeLessThan(html.indexOf('name="passphrase"'));
    });

    it('says a login failed, without saying why, under the field, and ties it to the field', async () => {
        const html = await render({ failed: '1' });
        expect(notice(html)).toBe("That didn't sign you in. Check the passphrase and try again.");
        expect(field(html)).toContain('aria-invalid="true"');
        expect(field(html)).toContain('aria-describedby="curator-login-notice"');
        // Under the field, before the button.
        expect(html.indexOf('id="curator-passphrase"')).toBeLessThan(html.indexOf('id="curator-login-notice"'));
        expect(html.indexOf('id="curator-login-notice"')).toBeLessThan(html.indexOf('<button'));
        expect(html).not.toMatch(/paused/);
    });

    it.each([
        ['the right passphrase', () => secrets.passphrase],
        ['a wrong one', () => 'still not the passphrase'],
    ])('while the lock is on, answers %s with the lock notice alone, how long it has left, and the restart', async (_, passphrase) => {
        for (let i = 0; i < MAX_FAILURES; i++) await postLogin(form('not the passphrase'));
        const response = await postLogin(form(passphrase()));
        expect(response.headers.get('location')).toBe('/curation/login?failed=1');
        expect(response.headers.get('set-cookie')).toBeNull();
        const html = await render({ failed: '1' });
        const text = notice(html);
        // The time left comes first.
        expect(text).toMatch(/^Sign-in is paused for about 15 more minutes, after five wrong passphrases\. Until then no passphrase is checked, the right one included\./);
        expect(text).toContain('Restarting curator on the server also ends it.');
        expect(text).toContain("If those tries weren't yours, someone else can reach the curator.");
        expect(html).not.toContain('Check the passphrase');
        expect(html).not.toContain("didn't sign you in");
        expect(html).not.toContain(secrets.passphrase);
        // The field may hold the right passphrase, so it isn't marked invalid, but the notice describes it.
        expect(field(html)).not.toContain('aria-invalid');
        expect(field(html)).toContain('aria-describedby="curator-login-notice"');
    });

    it('rounds the time left up to whole minutes, and says a minute when that is all that is left', async () => {
        const start = Date.now();
        for (let i = 0; i < MAX_FAILURES; i++) await attemptLogin('not the passphrase', hash(), () => start);
        const spy = vi.spyOn(Date, 'now');
        try {
            spy.mockReturnValue(start + 3 * 60_000 + 1);
            expect(notice(await render())).toMatch(/^Sign-in is paused for about 12 more minutes,/);
            spy.mockReturnValue(start + LOCK_MS - 30_000);
            expect(notice(await render())).toMatch(/^Sign-in is paused for about one more minute,/);
            spy.mockReturnValue(start + LOCK_MS);
            expect(await render()).not.toContain('curator-login-notice');
        } finally {
            spy.mockRestore();
        }
    });

    it('says the lock is on to a fresh load as well, with nothing about any passphrase', async () => {
        for (let i = 0; i < MAX_FAILURES; i++) await attemptLogin('not the passphrase', hash());
        const html = await render();
        expect(notice(html)).toMatch(/^Sign-in is paused/);
        expect(html).not.toContain(secrets.passphrase);
    });

    it.each([
        [{ 'signed-out': '1' }, "You're signed out."],
        [{ ended: '1' }, 'Your session ended. Sign in again.'],
    ])('for %j, says %j in a status line above the form', async (search, text) => {
        const html = await render(search);
        expect(notice(html)).toBe(text);
        expect(html).toMatch(/<p id="curator-login-notice"[^>]*role="status"/);
        expect(html.indexOf('id="curator-login-notice"')).toBeLessThan(html.indexOf('<form'));
        expect(field(html)).not.toContain('aria-invalid');
        expect(field(html)).toContain('aria-describedby="curator-login-notice"');
    });

    it('puts a failure ahead of a session note, and the lock ahead of both', async () => {
        expect(notice(await render({ failed: '1', ended: '1', 'signed-out': '1' }))).toMatch(/^That didn't sign you in/);
        for (let i = 0; i < MAX_FAILURES; i++) await attemptLogin('not the passphrase', hash());
        expect(notice(await render({ failed: '1', ended: '1' }))).toMatch(/^Sign-in is paused/);
    });

    it('sends a signed-in curator on to /curation', async () => {
        const cookie = `${SESSION_COOKIE}=${signSessionId(createSession(), secrets.sessionKey)}`;
        const outcome = await render({}, cookie).catch((error: unknown) => error);
        expect(String((outcome as { digest?: string }).digest)).toMatch(/^NEXT_REDIRECT;replace;\/curation;/);
    });
});
