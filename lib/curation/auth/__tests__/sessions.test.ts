// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { plainLanRequest, type CuratorEnv } from '../policy';
import { clearedSessionCookie, createSession, resetSessionsForTests, SESSION_COOKIE, sessionCookie, signSessionId } from '../sessions';

// The session cookie's attributes per mode and scheme (LAN mode). `Secure`
// goes only for a LAN-mode Host over plain http; loopback and https keep it.
// Everything else is the same in every mode. Test values only.

const key = randomBytes(32);

afterEach(() => resetSessionsForTests());

const attributes = (header: string) => header.split('; ').slice(1).sort();
const SECURE = ['HttpOnly', 'Max-Age=43200', 'Path=/', 'SameSite=Strict', 'Secure'];
const PLAIN = ['HttpOnly', 'Max-Age=43200', 'Path=/', 'SameSite=Strict'];
const CLEAR_SECURE = ['HttpOnly', 'Max-Age=0', 'Path=/', 'SameSite=Strict', 'Secure'];
const CLEAR_PLAIN = ['HttpOnly', 'Max-Age=0', 'Path=/', 'SameSite=Strict'];

describe('the session cookie', () => {
    it('carries the signed session ID, with or without Secure', () => {
        const id = createSession();
        for (const secure of [true, false]) {
            const header = sessionCookie(id, key, { secure });
            expect(header.split('; ')[0]).toBe(`${SESSION_COOKIE}=${signSessionId(id, key)}`);
            expect(attributes(header)).toEqual(secure ? SECURE : PLAIN);
            const cleared = clearedSessionCookie({ secure });
            expect(cleared.split('; ')[0]).toBe(`${SESSION_COOKIE}=`);
            expect(attributes(cleared)).toEqual(secure ? CLEAR_SECURE : CLEAR_PLAIN);
        }
    });

    const LOOPBACK: CuratorEnv = {};
    const LAN: CuratorEnv = { CURATOR_PUBLISH: '192.168.86.250', CURATOR_EXTRA_HOSTS: 'homelab.local:3001' };

    it.each([
        ['loopback mode, http on 127.0.0.1', LOOPBACK, '127.0.0.1:3001', 'http', SECURE, CLEAR_SECURE],
        ['loopback mode, http on localhost, with no X-Forwarded-Proto', LOOPBACK, 'localhost:3001', null, SECURE, CLEAR_SECURE],
        ['loopback mode, https', LOOPBACK, '127.0.0.1:3001', 'https', SECURE, CLEAR_SECURE],
        ['loopback mode, a LAN Host sent anyway', LOOPBACK, '192.168.86.250:3001', 'http', SECURE, CLEAR_SECURE],
        ['LAN mode, http on the LAN address', LAN, '192.168.86.250:3001', 'http', PLAIN, CLEAR_PLAIN],
        ['LAN mode, the LAN address with no X-Forwarded-Proto', LAN, '192.168.86.250:3001', null, PLAIN, CLEAR_PLAIN],
        ['LAN mode, http on a listed extra host', LAN, 'homelab.local:3001', 'http', PLAIN, CLEAR_PLAIN],
        ['LAN mode, https on the LAN address', LAN, '192.168.86.250:3001', 'https', SECURE, CLEAR_SECURE],
        ['LAN mode, https on a listed extra host', LAN, 'homelab.local:3001', 'https', SECURE, CLEAR_SECURE],
        ['LAN mode, http on 127.0.0.1', LAN, '127.0.0.1:3001', 'http', SECURE, CLEAR_SECURE],
        ['LAN mode, http on localhost', LAN, 'localhost:3001', 'http', SECURE, CLEAR_SECURE],
        ['LAN mode, an unlisted Host', LAN, 'other.local:3001', 'http', SECURE, CLEAR_SECURE],
        ['a misconfigured CURATOR_PUBLISH', { CURATOR_PUBLISH: '0.0.0.0' }, '192.168.86.250:3001', 'http', SECURE, CLEAR_SECURE],
    ])('in %s, is set and cleared with the matching attributes', (_, env, host, forwardedProto, set, cleared) => {
        const secure = !plainLanRequest({ host, forwardedProto }, env);
        expect(attributes(sessionCookie(createSession(), key, { secure }))).toEqual(set);
        expect(attributes(clearedSessionCookie({ secure }))).toEqual(cleared);
    });
});
