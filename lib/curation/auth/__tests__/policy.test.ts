// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
    bindProblem,
    curatorHosts,
    curatorStartupProblem,
    evaluateCuratorRequest,
    isCurationEnabled,
    isCuratorPath,
    listenTarget,
    type CuratorEnv,
    type CuratorRequest,
} from '../policy';

/** argv for the standalone server.js, which listens on HOSTNAME. */
const SERVER_JS = ['/usr/local/bin/node', '/app/server.js'];
const notContainer = () => false;
const container = () => true;

const ON: CuratorEnv = { CURATION_ENABLED: 'true', HOSTNAME: '127.0.0.1' };

function request(overrides: Partial<CuratorRequest> = {}): CuratorRequest {
    return { host: '127.0.0.1:3001', origin: null, forwardedHost: null, mutation: false, ...overrides };
}

const evaluate = (overrides: Partial<CuratorRequest>, env: CuratorEnv = ON, containerized = notContainer) =>
    evaluateCuratorRequest(request(overrides), env, SERVER_JS, containerized);

describe('CURATION_ENABLED', () => {
    it.each([undefined, '', 'false', 'TRUE', 'True', '1', 'yes', ' true', 'true ', 'on'])('is off for %j', (value) => {
        expect(isCurationEnabled({ CURATION_ENABLED: value })).toBe(false);
        expect(evaluate({}, { ...ON, CURATION_ENABLED: value })).toEqual({ status: 404, reason: 'off' });
    });

    it('is on only for the exact value true', () => {
        expect(isCurationEnabled({ CURATION_ENABLED: 'true' })).toBe(true);
        expect(evaluate({})).toBeNull();
    });

    it('refuses with 404 before it reads anything else, even a right Host and Origin', () => {
        expect(evaluate({ origin: 'http://127.0.0.1:3001', mutation: true }, { CURATION_ENABLED: 'false', HOSTNAME: '127.0.0.1' })).toEqual({
            status: 404,
            reason: 'off',
        });
    });
});

describe('the Host allowlist', () => {
    it('answers to 127.0.0.1:3001 and localhost:3001 only, by default', () => {
        expect(curatorHosts({})).toEqual({ hosts: new Set(['127.0.0.1:3001', 'localhost:3001']) });
    });

    it('adds the tunnel port when CURATOR_TUNNEL_PORT names one', () => {
        expect(curatorHosts({ CURATOR_TUNNEL_PORT: '4011' })).toEqual({
            hosts: new Set(['127.0.0.1:3001', 'localhost:3001', '127.0.0.1:4011', 'localhost:4011']),
        });
        expect(evaluate({ host: 'localhost:4011' }, { ...ON, CURATOR_TUNNEL_PORT: '4011' })).toBeNull();
    });

    it.each(['0', '65536', '-1', '3001x', ' 3001', '08080', 'abc', '1e3'])('refuses every request for CURATOR_TUNNEL_PORT=%j', (value) => {
        expect(curatorHosts({ CURATOR_TUNNEL_PORT: value })).toEqual({ problem: expect.stringContaining('CURATOR_TUNNEL_PORT') });
        expect(evaluate({}, { ...ON, CURATOR_TUNNEL_PORT: value })).toEqual({ status: 503, reason: 'misconfigured' });
    });

    it.each(['127.0.0.1:3001', 'localhost:3001', 'LOCALHOST:3001'])('lets %s in', (host) => {
        expect(evaluate({ host })).toBeNull();
    });

    it.each([
        ['a missing Host', null],
        ['an empty Host', ''],
        ['a rebound name', 'rebound.example:3001'],
        ['a rebound name on a tunnel port nobody set', 'localhost:4011'],
        ['no port', '127.0.0.1'],
        ['the container port', '127.0.0.1:3000'],
        ['the IPv6 loopback', '[::1]:3001'],
        ['another loopback address', '127.0.0.2:3001'],
        ['a LAN address', '192.168.1.20:3001'],
        ['a name that ends in localhost', 'evil.localhost:3001'],
        ['a trailing dot', 'localhost.:3001'],
    ])('refuses %s with 421', (_, host) => {
        expect(evaluate({ host })).toEqual({ status: 421, reason: 'host' });
    });

    it('refuses an X-Forwarded-Host that differs from Host, and takes one that matches', () => {
        expect(evaluate({ forwardedHost: 'rebound.example:3001' })).toEqual({ status: 421, reason: 'host' });
        expect(evaluate({ forwardedHost: '127.0.0.1:3001' })).toBeNull();
    });
});

describe('the Origin check on a mutation', () => {
    it('lets a mutation in when Origin names the same allowed host over http', () => {
        expect(evaluate({ mutation: true, origin: 'http://127.0.0.1:3001' })).toBeNull();
        expect(evaluate({ mutation: true, host: 'localhost:3001', origin: 'http://localhost:3001' })).toBeNull();
    });

    it.each([
        ['no Origin', null],
        ['Origin null', 'null'],
        ['another site', 'https://attacker.example'],
        ['the other allowed name', 'http://localhost:3001'],
        ['https', 'https://127.0.0.1:3001'],
        ['another port', 'http://127.0.0.1:3000'],
        ['a path', 'http://127.0.0.1:3001/curation'],
        ['a trailing slash', 'http://127.0.0.1:3001/'],
        ['credentials', 'http://user@127.0.0.1:3001'],
        ['not a URL', '127.0.0.1:3001'],
    ])('refuses %s with 403', (_, origin) => {
        expect(evaluate({ mutation: true, origin })).toEqual({ status: 403, reason: 'origin' });
    });

    it('reads no Origin for a read', () => {
        expect(evaluate({ mutation: false, origin: 'https://attacker.example' })).toBeNull();
    });
});

describe('the bind rule', () => {
    it.each(['127.0.0.1', '::1', 'localhost'])('takes HOSTNAME=%s', (address) => {
        expect(bindProblem({ HOSTNAME: address }, SERVER_JS, notContainer)).toBeNull();
    });

    it.each([
        ['unset', undefined, 'HOSTNAME is unset'],
        ['empty', '', 'HOSTNAME is unset'],
        ['every IPv4 interface', '0.0.0.0', 'HOSTNAME is not'],
        ['every IPv6 interface', '::', 'HOSTNAME is not'],
        ['a LAN address', '192.168.1.20', 'HOSTNAME is not'],
        ['a hostname', 'photography-host', 'HOSTNAME is not'],
        ['another loopback address', '127.0.0.2', 'HOSTNAME is not'],
    ])('refuses HOSTNAME %s', (_, address, message) => {
        expect(bindProblem({ HOSTNAME: address }, SERVER_JS, container)).toContain(message);
    });

    it('takes a wildcard only with CURATION_BIND_SCOPE=container, and only in a container', () => {
        for (const address of ['0.0.0.0', '::']) {
            expect(bindProblem({ HOSTNAME: address, CURATION_BIND_SCOPE: 'container' }, SERVER_JS, container)).toBeNull();
            expect(bindProblem({ HOSTNAME: address, CURATION_BIND_SCOPE: 'container' }, SERVER_JS, notContainer)).toContain("isn't in a container");
        }
    });

    it('never takes a LAN address or an unset bind, whatever CURATION_BIND_SCOPE says', () => {
        expect(bindProblem({ HOSTNAME: '192.168.1.20', CURATION_BIND_SCOPE: 'container' }, SERVER_JS, container)).not.toBeNull();
        expect(bindProblem({ CURATION_BIND_SCOPE: 'container' }, SERVER_JS, container)).not.toBeNull();
    });

    it.each(['host', 'any', 'CONTAINER', 'container '])('refuses CURATION_BIND_SCOPE=%j', (scope) => {
        expect(bindProblem({ HOSTNAME: '127.0.0.1', CURATION_BIND_SCOPE: scope }, SERVER_JS, container)).toContain('CURATION_BIND_SCOPE');
    });

    it('reads --hostname under the Next CLI, and ignores HOSTNAME there', () => {
        const next = (...args: string[]) => ['/usr/local/bin/node', '/app/node_modules/next/dist/bin/next', ...args];
        expect(listenTarget({ HOSTNAME: '0.0.0.0' }, next('start', '--hostname', '127.0.0.1'))).toEqual({ address: '127.0.0.1', source: '--hostname' });
        expect(listenTarget({}, next('start', '-H', '::1'))).toEqual({ address: '::1', source: '--hostname' });
        expect(listenTarget({}, next('start', '--hostname=localhost'))).toEqual({ address: 'localhost', source: '--hostname' });
        expect(bindProblem({ HOSTNAME: '127.0.0.1' }, next('start'), notContainer)).toContain('--hostname is unset');
        expect(bindProblem({ HOSTNAME: '127.0.0.1' }, next('start', '--hostname', '0.0.0.0'), notContainer)).toContain('--hostname is not');
        expect(bindProblem({}, ['/usr/local/bin/node', '/repo/node_modules/.bin/next', 'start', '--hostname', '127.0.0.1'], notContainer)).toBeNull();
    });

    it("reads HOSTNAME for server.js, whatever its arguments say, since server.js reads no --hostname", () => {
        expect(bindProblem({}, [...SERVER_JS, '--hostname', '127.0.0.1'], notContainer)).toContain('HOSTNAME is unset');
    });

    it('refuses every request with 503 while the bind is wrong, so the time before the process exits is covered', () => {
        expect(evaluate({}, { CURATION_ENABLED: 'true', HOSTNAME: '0.0.0.0' })).toEqual({ status: 503, reason: 'misconfigured' });
        expect(evaluate({}, { CURATION_ENABLED: 'true' })).toEqual({ status: 503, reason: 'misconfigured' });
    });
});

describe('curatorStartupProblem', () => {
    it('is null while the curator is off, wherever the server listens', () => {
        expect(curatorStartupProblem({ HOSTNAME: '0.0.0.0' }, SERVER_JS, notContainer)).toBeNull();
    });

    it('names the setting and never its value', () => {
        const problem = curatorStartupProblem({ CURATION_ENABLED: 'true', HOSTNAME: '203.0.113.9' }, SERVER_JS, notContainer);
        expect(problem).toContain('HOSTNAME');
        expect(problem).not.toContain('203.0.113.9');
        const port = curatorStartupProblem({ ...ON, CURATOR_TUNNEL_PORT: 'secret-ish' }, SERVER_JS, notContainer);
        expect(port).toContain('CURATOR_TUNNEL_PORT');
        expect(port).not.toContain('secret-ish');
    });

    it('is null for the compose curator service', () => {
        const env = { CURATION_ENABLED: 'true', HOSTNAME: '0.0.0.0', CURATION_BIND_SCOPE: 'container' };
        expect(curatorStartupProblem(env, SERVER_JS, container)).toBeNull();
    });
});

describe('isCuratorPath', () => {
    it.each([
        '/curation',
        '/curation/',
        '/curation/inbox',
        '/curation/inbox/evt_1',
        '/api/curation',
        '/api/curation/events',
        '/Curation',
        '/CURATION/inbox',
        '/API/Curation/x',
        '/%63uration',
        '/curation%2Finbox',
        '//curation',
        '/x/../curation',
        '/curation.rsc',
        '/curation.segments/inbox.segment.rsc',
        '/curations',
    ])('counts %s', (pathname) => {
        expect(isCuratorPath(pathname)).toBe(true);
    });

    it.each(['/', '/gallery', '/about', '/api/photos', '/api/health', '/media/p/r/w/x.webp', '/curat', '/x/curation', '/api/x/curation'])(
        "doesn't count %s",
        (pathname) => {
            expect(isCuratorPath(pathname)).toBe(false);
        },
    );
});
