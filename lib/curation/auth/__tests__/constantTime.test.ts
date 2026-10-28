// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Both secret comparisons in #14's 14-2, the passphrase key and the cookie's
// tag, go through crypto.timingSafeEqual on two buffers of equal length,
// never through === or Buffer.equals, which stop at the first difference.
// And a login while the lock is on still derives the key, once, like a
// wrong passphrase, so the lock doesn't show in the time it takes.

const calls = vi.hoisted(() => [] as [Buffer, Buffer][]);
const derivations = vi.hoisted(() => ({ count: 0 }));

vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:crypto')>();
    const timingSafeEqual = (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
        calls.push([Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)]);
        return actual.timingSafeEqual(a, b);
    };
    const scrypt = ((...args: Parameters<typeof actual.scrypt>) => {
        derivations.count++;
        return (actual.scrypt as (...rest: unknown[]) => void)(...args);
    }) as typeof actual.scrypt;
    return { ...actual, default: { ...actual, timingSafeEqual, scrypt }, timingSafeEqual, scrypt };
});

const { hashPassphrase, parsePassphraseHash, verifyPassphrase } = await import('../passphrase');
const { createSession, resetSessionsForTests, signSessionId, verifiedSessionId } = await import('../sessions');
const { attemptLogin, loginLocked, MAX_FAILURES, resetLoginForTests } = await import('../login');

beforeEach(() => {
    calls.length = 0;
    derivations.count = 0;
});

afterEach(() => {
    resetSessionsForTests();
    resetLoginForTests();
});

describe('a login while the lock is on', () => {
    it('derives the key once, compares it, and answers as a wrong passphrase does, whatever the passphrase', async () => {
        const hash = parsePassphraseHash(await hashPassphrase('the right passphrase'))!;
        derivations.count = 0;
        const wrong = await attemptLogin('not it', hash);
        expect(derivations.count).toBe(1);
        for (let i = 1; i < MAX_FAILURES; i++) await attemptLogin('not it', hash);
        expect(loginLocked()).toBe(true);
        for (const passphrase of ['not it', 'the right passphrase']) {
            derivations.count = 0;
            calls.length = 0;
            expect(await attemptLogin(passphrase, hash)).toEqual(wrong);
            expect(derivations.count, passphrase).toBe(1);
            expect(calls, passphrase).toHaveLength(1);
        }
    });
});

describe('the constant-time compare', () => {
    it('checks a passphrase by timingSafeEqual on two 32-byte keys, right or wrong', async () => {
        const hash = parsePassphraseHash(await hashPassphrase('the test passphrase'))!;
        calls.length = 0;
        expect(await verifyPassphrase('the test passphrase', hash)).toBe(true);
        expect(await verifyPassphrase('not it', hash)).toBe(false);
        expect(calls).toHaveLength(2);
        for (const [a, b] of calls) {
            expect(a).toHaveLength(32);
            expect(b).toHaveLength(32);
        }
        expect(calls.every(([, stored]) => stored.equals(hash.key))).toBe(true);
    });

    it('still compares when the passphrase has a shape it refuses, so it takes as long', async () => {
        const hash = parsePassphraseHash(await hashPassphrase('p'))!;
        calls.length = 0;
        expect(await verifyPassphrase('', hash)).toBe(false);
        expect(calls).toHaveLength(1);
    });

    it("checks a cookie's tag by timingSafeEqual on two 32-byte tags", () => {
        const key = randomBytes(32);
        const id = createSession();
        const value = signSessionId(id, key);
        expect(verifiedSessionId(value, key)).toBe(id);
        expect(verifiedSessionId(signSessionId(id, randomBytes(32)), key)).toBeNull();
        expect(calls).toHaveLength(2);
        for (const [a, b] of calls) {
            expect(a).toHaveLength(32);
            expect(b).toHaveLength(32);
        }
    });

    it('never compares a tag of the wrong length, which it refuses by shape first', () => {
        const key = randomBytes(32);
        const id = createSession();
        const [idPart, tag] = signSessionId(id, key).split('.');
        expect(verifiedSessionId(`${idPart}.${tag.slice(0, 30)}`, key)).toBeNull();
        expect(calls).toHaveLength(0);
    });
});
