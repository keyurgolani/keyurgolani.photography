// @vitest-environment node
import os from 'node:os';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeCuratorSecrets, type TestCuratorSecrets } from '../../../../test/helpers/curatorSecrets';
import {
    bindProblem,
    externalInterfaceCount,
    curatorHosts,
    curatorStartupProblem,
    evaluateCuratorRequest,
    isCurationEnabled,
    isCuratorPath,
    listenTarget,
    type BindProbe,
    type CuratorEnv,
    type CuratorRequest,
} from '../policy';

/** argv for the standalone server.js, which listens on HOSTNAME. */
const SERVER_JS = ['/usr/local/bin/node', '/app/server.js'];
/** What the checks see of the process. No socket list, so the settings decide, as before the server listens. */
const notContainer: BindProbe = { containerized: () => false, sockets: () => null, interfaces: () => 1 };
const container: BindProbe = { containerized: () => true, sockets: () => null, interfaces: () => 1 };
/** argv of the child process `next dev` forks, which gets --hostname over IPC, not in argv or HOSTNAME. */
const DEV_CHILD = ['/usr/local/bin/node', '/repo/node_modules/next/dist/server/lib/start-server.js'];
const DEV_ENV = { __NEXT_DEV_SERVER: '1', NEXT_PRIVATE_WORKER: '1' };
const listening = (...addresses: string[]): BindProbe => ({ containerized: () => false, sockets: () => addresses, interfaces: () => 1 });

/** The curator on, with test secret files, which beforeAll adds. */
const ON: CuratorEnv = { CURATION_ENABLED: 'true', HOSTNAME: '127.0.0.1' };
let secrets: TestCuratorSecrets;

beforeAll(async () => {
    secrets = await makeCuratorSecrets();
    Object.assign(ON, secrets.env);
});

afterAll(() => secrets.cleanup());

function request(overrides: Partial<CuratorRequest> = {}): CuratorRequest {
    return { host: '127.0.0.1:3001', origin: null, forwardedHost: null, mutation: false, session: 'not-checked', ...overrides };
}

const evaluate = (overrides: Partial<CuratorRequest>, env: CuratorEnv = ON, probe: BindProbe = notContainer) =>
    evaluateCuratorRequest(request(overrides), env, SERVER_JS, probe);

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

describe('the socket the server listens on', () => {
    it.each([
        ['every IPv4 interface, with HOSTNAME on loopback', { HOSTNAME: '127.0.0.1' }, '0.0.0.0'],
        ['every interface, with HOSTNAME on localhost', { HOSTNAME: 'localhost' }, '::'],
        ['every interface, with no HOSTNAME', {}, '::'],
        ['a LAN address, with HOSTNAME on loopback', { HOSTNAME: '127.0.0.1' }, '192.168.1.20'],
    ])('refuses a next dev server listening on %s', (_, env, address) => {
        // The message names no address.
        expect(bindProblem({ ...DEV_ENV, ...env }, DEV_CHILD, listening(address))).toBe('the server listens on an address other than 127.0.0.1, ::1 or localhost');
    });

    it('refuses a next dev server whose socket it cannot read, rather than trusting HOSTNAME', () => {
        expect(bindProblem({ ...DEV_ENV, HOSTNAME: '127.0.0.1' }, DEV_CHILD, notContainer)).toContain("can't be read");
        expect(bindProblem({ ...DEV_ENV, HOSTNAME: '127.0.0.1' }, DEV_CHILD, listening())).toContain("can't be read");
    });

    it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('takes a next dev server listening on %s, with or without HOSTNAME', (address) => {
        expect(bindProblem(DEV_ENV, DEV_CHILD, listening(address))).toBeNull();
        expect(bindProblem({ ...DEV_ENV, HOSTNAME: '0.0.0.0' }, DEV_CHILD, listening(address))).toBeNull();
    });

    it('refuses server.js on a socket beyond loopback, whatever HOSTNAME says', () => {
        expect(bindProblem({ HOSTNAME: '127.0.0.1' }, SERVER_JS, listening('0.0.0.0'))).toContain('listens on an address other than');
        expect(bindProblem({ HOSTNAME: '127.0.0.1' }, SERVER_JS, listening('127.0.0.1', '0.0.0.0'))).toContain('listens on an address other than');
        expect(bindProblem({ HOSTNAME: '127.0.0.1' }, SERVER_JS, listening('127.0.0.1'))).toBeNull();
    });

    it('still reads the settings once the socket checks out', () => {
        expect(bindProblem({}, SERVER_JS, listening('127.0.0.1'))).toContain('HOSTNAME is unset');
    });

    it('takes the in-container wildcard socket, but not with more than one network interface, as under host networking', () => {
        const env = { HOSTNAME: '0.0.0.0', CURATION_BIND_SCOPE: 'container' };
        const inside = (interfaces: number): BindProbe => ({ containerized: () => true, sockets: () => ['0.0.0.0'], interfaces: () => interfaces });
        expect(bindProblem(env, SERVER_JS, inside(1))).toBeNull();
        expect(bindProblem(env, SERVER_JS, inside(2))).toContain('more than one network interface');
        expect(bindProblem(env, SERVER_JS, { ...container, interfaces: () => 3 })).toContain('more than one network interface');
        expect(bindProblem(env, SERVER_JS, { ...inside(1), containerized: () => false })).toContain("isn't in a container");
    });
});

describe('externalInterfaceCount', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const v4 = (address: string, internal = false) => ({ address, netmask: '255.0.0.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal, cidr: null });
    const v6 = (address: string, internal = false) => ({ address, netmask: 'ffff::', family: 'IPv6' as const, mac: '00:00:00:00:00:00', internal, cidr: null, scopeid: 0 });
    const LO = { lo: [v4('127.0.0.1', true), v6('::1', true)] };

    it.each([
        ['loopback alone', LO, 0],
        ['loopback and one IPv4 interface, as on its own Compose network', { ...LO, eth0: [v4('172.18.0.2')] }, 1],
        ['loopback and one interface with IPv4, IPv6 and a link-local address', { ...LO, eth0: [v4('172.18.0.2'), v6('fd00::2'), v6('fe80::2')] }, 1],
        ['two interfaces', { ...LO, eth0: [v4('172.18.0.2')], eth1: [v4('172.19.0.2')] }, 2],
    ])('counts %s as %i, never counting loopback', (_, interfaces, count) => {
        vi.spyOn(os, 'networkInterfaces').mockReturnValue(interfaces);
        expect(externalInterfaceCount()).toBe(count);
    });

    it('lets the in-container wildcard through with one interface, and not with two, by the real counter', () => {
        const env = { HOSTNAME: '0.0.0.0', CURATION_BIND_SCOPE: 'container' };
        const probe: BindProbe = { containerized: () => true, sockets: () => ['0.0.0.0'] };
        vi.spyOn(os, 'networkInterfaces').mockReturnValue({ ...LO, eth0: [v4('172.18.0.2')] });
        expect(bindProblem(env, SERVER_JS, probe)).toBeNull();
        vi.spyOn(os, 'networkInterfaces').mockReturnValue({ ...LO, eth0: [v4('192.168.1.20')], docker0: [v4('172.17.0.1')] });
        expect(bindProblem(env, SERVER_JS, probe)).toContain('more than one network interface');
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
