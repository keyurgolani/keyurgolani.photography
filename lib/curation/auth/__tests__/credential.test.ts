// @vitest-environment node
import { createHmac, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeCuratorSecrets, type TestCuratorSecrets } from '../../../../test/helpers/curatorSecrets';
import { attemptLogin, FAILURE_WINDOW_MS, LOCK_MS, loginLocked, MAX_FAILURES, resetLoginForTests } from '../login';
import { hashPassphrase, MAX_PASSPHRASE_BYTES, MIN_PASSPHRASE_CHARS, newPassphraseProblem, parsePassphraseHash, passphraseProblem, verifyPassphrase, type PassphraseHash } from '../passphrase';
import { evaluateCuratorRequest, type CuratorEnv, type CuratorRequest } from '../policy';
import { readCuratorSecrets } from '../secrets';
import {
    clearedSessionCookie,
    createSession,
    deleteSession,
    resetSessionsForTests,
    SESSION_COOKIE,
    sessionCookie,
    sessionFromCookies,
    signSessionId,
    verifiedSessionId,
} from '../sessions';

// The passphrase and session layer of #14's 14-2: the hash format, the
// lockout, sessions and their cookie, the secret files, and where the
// session check sits in the order. Test values only, made fresh per run.

let secrets: TestCuratorSecrets;
let hash: PassphraseHash;

beforeAll(async () => {
    secrets = await makeCuratorSecrets();
    hash = parsePassphraseHash(fs.readFileSync(secrets.hashFile, 'utf8'))!;
});

afterAll(() => secrets.cleanup());

afterEach(() => {
    resetLoginForTests();
    resetSessionsForTests();
});

describe('the passphrase hash', () => {
    it('is one line of scrypt N=32768, r=8, p=1, a 16-byte salt and a 32-byte key', async () => {
        const line = await hashPassphrase('a test passphrase');
        expect(line).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}\n$/);
        const parsed = parsePassphraseHash(line)!;
        expect(parsed.salt).toHaveLength(16);
        expect(parsed.key).toHaveLength(32);
    });

    it('gets a new salt every time, so the same passphrase never hashes the same', async () => {
        const [a, b] = await Promise.all([hashPassphrase('same'), hashPassphrase('same')]);
        expect(a).not.toBe(b);
        expect(parsePassphraseHash(a)!.salt.equals(parsePassphraseHash(b)!.salt)).toBe(false);
    });

    // A known answer at N=32768, r=8, p=1, checked against Python's hashlib.scrypt
    // too, so a cheaper derive behind the same prefix can't pass.
    const KNOWN = {
        passphrase: 'known answer passphrase',
        salt: 'AAECAwQFBgcICQoLDA0ODw',
        key: 'z9TAeN5Uc-zHg2iuZORcVjkrkVRvPo1ofLjoJf-p8_Q',
    };

    it('verifies a known answer at N=32768, r=8, p=1', async () => {
        const known = parsePassphraseHash(`scrypt$32768$8$1$${KNOWN.salt}$${KNOWN.key}\n`)!;
        expect(known.key.toString('hex')).toBe('cfd4c078de5473ecc78368ae64e45c56392b91546f3e8d687cb8e825ffa9f3f4');
        expect(await verifyPassphrase(KNOWN.passphrase, known)).toBe(true);
        expect(await verifyPassphrase(`${KNOWN.passphrase}.`, known)).toBe(false);
    });

    it('hashes at exactly the parameters its prefix names', async () => {
        const parsed = parsePassphraseHash(await hashPassphrase(KNOWN.passphrase))!;
        const expected = scryptSync(KNOWN.passphrase, parsed.salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
        expect(parsed.key.equals(expected)).toBe(true);
        for (const cheaper of [{ N: 1024, r: 8, p: 1 }, { N: 32768, r: 4, p: 1 }, { N: 16384, r: 8, p: 1 }]) {
            expect(parsed.key.equals(scryptSync(KNOWN.passphrase, parsed.salt, 32, { ...cheaper, maxmem: 64 * 1024 * 1024 }))).toBe(false);
        }
    });

    it('verifies the passphrase it was made from, and nothing else', async () => {
        expect(await verifyPassphrase(secrets.passphrase, hash)).toBe(true);
        for (const other of ['', `${secrets.passphrase} `, secrets.passphrase.slice(0, -1), secrets.passphrase.toUpperCase(), 'x'.repeat(MAX_PASSPHRASE_BYTES + 1)]) {
            expect(await verifyPassphrase(other, hash), JSON.stringify(other.slice(0, 8))).toBe(false);
        }
    });

    it('compares a composed and a decomposed spelling as one passphrase', async () => {
        const line = await hashPassphrase('café');
        expect(await verifyPassphrase('café', parsePassphraseHash(line)!)).toBe(true);
    });

    it('refuses an empty passphrase, a line break, and one over the limit', () => {
        expect(passphraseProblem('')).toMatch(/empty/);
        expect(passphraseProblem('a\nb')).toMatch(/line break/);
        expect(passphraseProblem('a\rb')).toMatch(/line break/);
        expect(passphraseProblem('é'.repeat(MAX_PASSPHRASE_BYTES / 2 + 1))).toMatch(/longer/);
        expect(passphraseProblem('ok')).toBeNull();
    });

    it('signs in with a short passphrase hashed before the minimum, which only the hash command enforces', async () => {
        expect(newPassphraseProblem('short')).toBe('The passphrase is 5 characters long. Use at least 12.');
        expect(newPassphraseProblem('a'.repeat(MIN_PASSPHRASE_CHARS))).toBeNull();
        // The secret files as a hash made before the minimum left them, read and tried as the login route does.
        const short = await makeCuratorSecrets({ passphrase: 'short' });
        try {
            const read = readCuratorSecrets(short.env);
            if (!('secrets' in read)) throw new Error(read.problem);
            expect(await attemptLogin('short', read.secrets.passphrase)).toMatchObject({ ok: true, sessionId: expect.any(String) });
        } finally {
            short.cleanup();
        }
    });

    it.each([
        ['cheaper scrypt parameters', (line: string) => line.replace('scrypt$32768$8$1$', 'scrypt$1024$8$1$')],
        ['another p', (line: string) => line.replace('$8$1$', '$8$2$')],
        ['another algorithm name', (line: string) => line.replace('scrypt$', 'bcrypt$')],
        ['a truncated key', (line: string) => line.trimEnd().slice(0, -2)],
        ['a short salt', (line: string) => line.replace(/\$[A-Za-z0-9_-]{22}\$/, '$AAAA$')],
        ['an extra field', (line: string) => `${line.trimEnd()}$AAAA`],
        ['a second line', (line: string) => `${line}${line}`],
        ['base64 padding', (line: string) => `${line.trimEnd()}=`],
        ['standard base64 characters', (line: string) => line.replace(/[-_]/g, '+')],
    ])('parses nothing from a file with %s', async (_, mutate) => {
        const line = await hashPassphrase('p');
        const mutated = mutate(line);
        if (mutated !== line) expect(parsePassphraseHash(mutated)).toBeNull();
    });
});

describe('the lockout', () => {
    const wrong = 'not the passphrase';
    let now = 1_000_000;
    const clock = () => now;

    afterEach(() => {
        now = 1_000_000;
    });

    it(`locks after ${MAX_FAILURES} failures within 15 minutes, and refuses even the right passphrase then`, async () => {
        for (let i = 0; i < MAX_FAILURES - 1; i++) expect(await attemptLogin(wrong, hash, clock)).toEqual({ ok: false });
        expect(loginLocked(now)).toBe(false);
        expect(await attemptLogin(wrong, hash, clock)).toEqual({ ok: false });
        expect(loginLocked(now)).toBe(true);
        expect(await attemptLogin(secrets.passphrase, hash, clock)).toEqual({ ok: false });
    });

    it('lifts the lock 15 minutes after it began, not before', async () => {
        for (let i = 0; i < MAX_FAILURES; i++) await attemptLogin(wrong, hash, clock);
        now += LOCK_MS - 1;
        expect(await attemptLogin(secrets.passphrase, hash, clock)).toEqual({ ok: false });
        now += 1;
        expect(loginLocked(now)).toBe(false);
        expect(await attemptLogin(secrets.passphrase, hash, clock)).toMatchObject({ ok: true });
    });

    it('neither counts nor extends attempts made during the lock', async () => {
        for (let i = 0; i < MAX_FAILURES; i++) await attemptLogin(wrong, hash, clock);
        now += LOCK_MS / 2;
        for (let i = 0; i < 20; i++) await attemptLogin(wrong, hash, clock);
        now += LOCK_MS / 2;
        expect(loginLocked(now)).toBe(false);
        // A fresh count: four more failures don't lock it again.
        for (let i = 0; i < MAX_FAILURES - 1; i++) await attemptLogin(wrong, hash, clock);
        expect(loginLocked(now)).toBe(false);
    });

    it('forgets failures older than 15 minutes', async () => {
        for (let i = 0; i < MAX_FAILURES - 1; i++) await attemptLogin(wrong, hash, clock);
        now += FAILURE_WINDOW_MS + 1;
        await attemptLogin(wrong, hash, clock);
        expect(loginLocked(now)).toBe(false);
    });

    it('clears the count on a success', async () => {
        for (let i = 0; i < MAX_FAILURES - 1; i++) await attemptLogin(wrong, hash, clock);
        expect(await attemptLogin(secrets.passphrase, hash, clock)).toMatchObject({ ok: true });
        for (let i = 0; i < MAX_FAILURES - 1; i++) await attemptLogin(wrong, hash, clock);
        expect(loginLocked(now)).toBe(false);
    });

    it('holds a burst sent together to the same count, so the right passphrase after five failures is refused', async () => {
        const burst = [...Array.from({ length: MAX_FAILURES }, () => attemptLogin(wrong, hash, clock)), attemptLogin(secrets.passphrase, hash, clock)];
        const outcomes = await Promise.all(burst);
        expect(outcomes.every((outcome) => !outcome.ok)).toBe(true);
        expect(loginLocked(now)).toBe(true);
    });

    it('is one lock for the whole curator, whoever sends the attempts', async () => {
        // attemptLogin takes no client: every attempt counts against the same lock.
        expect(attemptLogin.length).toBeLessThanOrEqual(3);
        for (let i = 0; i < MAX_FAILURES; i++) await attemptLogin(wrong, hash, clock);
        expect(await attemptLogin(secrets.passphrase, hash, clock)).toEqual({ ok: false });
    });
});

/** base64url's alphabet in order. The last of 43 characters for 32 bytes carries two unused bits. */
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

describe('sessions', () => {
    const key = randomBytes(32);
    const cookieOf = (id: string, with_ = key) => `${SESSION_COOKIE}=${signSessionId(id, with_)}`;

    it('are 32 random bytes, a new one each time', () => {
        const ids = new Set(Array.from({ length: 50 }, () => createSession()));
        expect(ids.size).toBe(50);
        for (const id of ids) expect(Buffer.from(id, 'base64url')).toHaveLength(32);
    });

    it('live 12 hours after they start, and not a millisecond longer', () => {
        const start = 5_000_000;
        const id = createSession(start);
        expect(sessionFromCookies(cookieOf(id), key, start + 12 * 3600_000 - 1)).toBe(id);
        expect(sessionFromCookies(cookieOf(id), key, start + 12 * 3600_000)).toBeNull();
        // Expired is gone, so going back in time doesn't revive it.
        expect(sessionFromCookies(cookieOf(id), key, start)).toBeNull();
    });

    it('end at logout, so the same cookie replayed after it counts for nothing', () => {
        const id = createSession();
        const cookie = cookieOf(id);
        expect(sessionFromCookies(cookie, key)).toBe(id);
        deleteSession(id);
        expect(sessionFromCookies(cookie, key)).toBeNull();
    });

    it('end at a restart, which empties the store', () => {
        const id = createSession();
        resetSessionsForTests();
        expect(sessionFromCookies(cookieOf(id), key)).toBeNull();
    });

    it('need a cookie the session secret signed', () => {
        const id = createSession();
        const value = signSessionId(id, key);
        const [idPart, tag] = value.split('.');
        const flip = (text: string, at: number) => text.slice(0, at) + (text[at] === 'A' ? 'B' : 'A') + text.slice(at + 1);
        const other = createSession();
        const cases: [string, string][] = [
            ['a tampered tag', `${idPart}.${flip(tag, 5)}`],
            ['a tampered ID', `${flip(idPart, 5)}.${tag}`],
            ['a truncated tag', `${idPart}.${tag.slice(0, -1)}`],
            ['a tag cut to half', `${idPart}.${tag.slice(0, 21)}`],
            ['no tag', idPart],
            ['an empty tag', `${idPart}.`],
            ['a tag under another secret', signSessionId(id, randomBytes(32))],
            // The tag covers a context string too, so a plain HMAC of the ID under the same secret doesn't count.
            ['a tag made without the context string', `${idPart}.${createHmac('sha256', key).update(idPart).digest('base64url')}`],
            ['another live session with this tag', `${other}.${tag}`],
            ['a tag padded out', `${idPart}.${tag}=`],
            ['a tag that decodes to the same bytes but is written otherwise', `${idPart}.${tag.slice(0, -1)}${B64URL[B64URL.indexOf(tag.at(-1)!) ^ 1]}`],
            ['an ID that decodes to the same bytes but is written otherwise', `${idPart.slice(0, -1)}${B64URL[B64URL.indexOf(idPart.at(-1)!) ^ 1]}.${tag}`],
            ['the parts swapped', `${tag}.${idPart}`],
        ];
        for (const [label, bad] of cases) {
            expect(verifiedSessionId(bad, key), label).toBeNull();
            expect(sessionFromCookies(`${SESSION_COOKIE}=${bad}`, key), label).toBeNull();
        }
        expect(verifiedSessionId(value, key)).toBe(id);
    });

    it('refuse a tag that is right for an ID no longer in the store', () => {
        const id = createSession();
        const cookie = cookieOf(id);
        deleteSession(id);
        expect(verifiedSessionId(cookie.split('=')[1], key)).toBe(id);
        expect(sessionFromCookies(cookie, key)).toBeNull();
    });

    it('take exactly one curator_session cookie, among others', () => {
        const id = createSession();
        expect(sessionFromCookies(`theme=dark; ${cookieOf(id)}; other=1`, key)).toBe(id);
        expect(sessionFromCookies(`${cookieOf(id)}; ${cookieOf(id)}`, key)).toBeNull();
        expect(sessionFromCookies(`${cookieOf(id)}; ${SESSION_COOKIE}=junk`, key)).toBeNull();
        expect(sessionFromCookies(null, key)).toBeNull();
        expect(sessionFromCookies('', key)).toBeNull();
        expect(sessionFromCookies(`x${cookieOf(id)}`, key)).toBeNull();
    });

    it('go out in an HttpOnly, Secure, SameSite=Strict cookie for 12 hours on Path=/', () => {
        const id = createSession();
        const header = sessionCookie(id, key, { secure: true });
        const [pair, ...attributes] = header.split('; ');
        expect(pair).toBe(`${SESSION_COOKIE}=${signSessionId(id, key)}`);
        expect(attributes.sort()).toEqual(['HttpOnly', 'Max-Age=43200', 'Path=/', 'SameSite=Strict', 'Secure']);
        const [cleared, ...clearing] = clearedSessionCookie({ secure: true }).split('; ');
        expect(cleared).toBe(`${SESSION_COOKIE}=`);
        expect(clearing.sort()).toEqual(['HttpOnly', 'Max-Age=0', 'Path=/', 'SameSite=Strict', 'Secure']);
    });
});

describe('the secret files', () => {
    it('read when both are in place', () => {
        const read = readCuratorSecrets(secrets.env);
        expect('secrets' in read && read.secrets.sessionKey.equals(secrets.sessionKey)).toBe(true);
    });

    describe('when one is wrong', () => {
        const replace = (file: string, bytes: Buffer | string, mode = 0o400) => {
            fs.rmSync(file, { force: true });
            fs.writeFileSync(file, bytes, { mode });
            fs.chmodSync(file, mode);
        };

        it.each([
            ['the hash file missing', (s: TestCuratorSecrets) => fs.rmSync(s.hashFile), 'passphrase hash'],
            ['the secret file missing', (s: TestCuratorSecrets) => fs.rmSync(s.keyFile), 'session secret'],
            ['the hash file readable by others', (s: TestCuratorSecrets) => fs.chmodSync(s.hashFile, 0o644), 'others'],
            ['the secret file readable by its group', (s: TestCuratorSecrets) => fs.chmodSync(s.keyFile, 0o440), 'others'],
            ['the hash file unreadable', (s: TestCuratorSecrets) => fs.chmodSync(s.hashFile, 0o000), 'passphrase hash'],
            ['a hash file that is no hash', (s: TestCuratorSecrets) => replace(s.hashFile, 'hunter2\n'), "isn't one"],
            ['an empty hash file', (s: TestCuratorSecrets) => replace(s.hashFile, ''), "isn't one"],
            ['a session secret of 31 bytes', (s: TestCuratorSecrets) => replace(s.keyFile, randomBytes(31)), 'fewer than 32'],
            ['an empty session secret', (s: TestCuratorSecrets) => replace(s.keyFile, Buffer.alloc(0)), 'fewer than 32'],
            ['a folder where the hash should be', (s: TestCuratorSecrets) => {
                fs.rmSync(s.hashFile);
                fs.mkdirSync(s.hashFile, { mode: 0o700 });
            }, 'regular file'],
        ])('give no secrets and a 503 with %s, and name no value', async (_, breakIt, message) => {
            const fresh = await makeCuratorSecrets();
            try {
                breakIt(fresh);
                const read = readCuratorSecrets(fresh.env);
                expect('problem' in read).toBe(true);
                const problem = (read as { problem: string }).problem;
                expect(problem).toContain(message);
                expect(problem).not.toContain(fresh.passphrase);
                expect(problem).not.toContain(fresh.dir);
                const env: CuratorEnv = { CURATION_ENABLED: 'true', HOSTNAME: '127.0.0.1', ...fresh.env };
                const request: CuratorRequest = { host: '127.0.0.1:3001', origin: null, forwardedHost: null, mutation: false, session: { cookie: fresh.cookie() } };
                const probe = { containerized: () => false, sockets: () => null, interfaces: () => 1 };
                expect(evaluateCuratorRequest(request, env, ['node', 'server.js'], probe)).toEqual({ status: 503, reason: 'misconfigured' });
                expect(evaluateCuratorRequest({ ...request, session: 'not-checked' }, env, ['node', 'server.js'], probe)).toEqual({ status: 503, reason: 'misconfigured' });
            } finally {
                fs.rmSync(fresh.hashFile, { recursive: true, force: true });
                fresh.cleanup();
            }
        });

        it('default to the curator mount, which isn\'t here, so an unset setting is a 503 too', () => {
            expect('problem' in readCuratorSecrets({})).toBe(true);
        });

        it('leave the flag off a 404 whatever the files hold', () => {
            const probe = { containerized: () => false, sockets: () => null, interfaces: () => 1 };
            const request: CuratorRequest = { host: '127.0.0.1:3001', origin: null, forwardedHost: null, mutation: false, session: { cookie: null } };
            expect(evaluateCuratorRequest(request, { CURATION_ENABLED: 'false', HOSTNAME: '127.0.0.1' }, ['node', 'server.js'], probe)).toEqual({ status: 404, reason: 'off' });
        });
    });
});

describe('the order of the checks', () => {
    const probe = { containerized: () => false, sockets: () => null, interfaces: () => 1 };
    const argv = ['node', 'server.js'];
    const env = (): CuratorEnv => ({ CURATION_ENABLED: 'true', HOSTNAME: '127.0.0.1', ...secrets.env });
    const good = (): CuratorRequest => ({
        host: '127.0.0.1:3001',
        origin: 'http://127.0.0.1:3001',
        forwardedHost: null,
        mutation: true,
        session: { cookie: secrets.cookie() },
    });
    const bad = { host: 'rebound.example:3001', origin: 'https://attacker.example', session: { cookie: null } } as const;

    it('passes a request that clears every check', () => {
        expect(evaluateCuratorRequest(good(), env(), argv, probe)).toBeNull();
    });

    it('is the flag, then the setup, then Host, then Origin, then the session', () => {
        const everythingBad = { ...good(), ...bad };
        expect(evaluateCuratorRequest(everythingBad, { ...env(), CURATION_ENABLED: 'false' }, argv, probe)).toEqual({ status: 404, reason: 'off' });
        expect(evaluateCuratorRequest(everythingBad, { ...env(), HOSTNAME: '0.0.0.0' }, argv, probe)).toEqual({ status: 503, reason: 'misconfigured' });
        expect(evaluateCuratorRequest(everythingBad, env(), argv, probe)).toEqual({ status: 421, reason: 'host' });
        expect(evaluateCuratorRequest({ ...everythingBad, host: '127.0.0.1:3001' }, env(), argv, probe)).toEqual({ status: 403, reason: 'origin' });
        expect(evaluateCuratorRequest({ ...good(), session: bad.session }, env(), argv, probe)).toEqual({ status: 401, reason: 'session' });
    });

    it('asks a read for no Origin, but still for the session', () => {
        expect(evaluateCuratorRequest({ ...good(), origin: null, mutation: false }, env(), argv, probe)).toBeNull();
        expect(evaluateCuratorRequest({ ...good(), origin: null, mutation: false, session: { cookie: null } }, env(), argv, probe)).toEqual({ status: 401, reason: 'session' });
    });

    it('skips only the session for a caller that says not-checked', () => {
        const login = { ...good(), session: 'not-checked' } as const;
        expect(evaluateCuratorRequest(login, env(), argv, probe)).toBeNull();
        expect(evaluateCuratorRequest({ ...login, origin: null }, env(), argv, probe)).toEqual({ status: 403, reason: 'origin' });
        expect(evaluateCuratorRequest({ ...login, host: bad.host }, env(), argv, probe)).toEqual({ status: 421, reason: 'host' });
    });

    it('refuses a cookie signed under another secret', () => {
        const id = createSession();
        const foreign = `${SESSION_COOKIE}=${signSessionId(id, randomBytes(32))}`;
        expect(evaluateCuratorRequest({ ...good(), session: { cookie: foreign } }, env(), argv, probe)).toEqual({ status: 401, reason: 'session' });
    });
});
