// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Both secret comparisons in #14's 14-2, the passphrase key and the cookie's
// tag, go through crypto.timingSafeEqual on two buffers of equal length,
// never through === or Buffer.equals, which stop at the first difference.

const calls = vi.hoisted(() => [] as [Buffer, Buffer][]);

vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:crypto')>();
    const timingSafeEqual = (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
        calls.push([Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)]);
        return actual.timingSafeEqual(a, b);
    };
    return { ...actual, default: { ...actual, timingSafeEqual }, timingSafeEqual };
});

const { hashPassphrase, parsePassphraseHash, verifyPassphrase } = await import('../passphrase');
const { createSession, resetSessionsForTests, signSessionId, verifiedSessionId } = await import('../sessions');

beforeEach(() => {
    calls.length = 0;
});

afterEach(() => resetSessionsForTests());

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
