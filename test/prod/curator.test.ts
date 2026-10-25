// @vitest-environment node
/**
 * #14's curator boundary on the standalone build, which `npm run test:prod`
 * makes first. Plain `npm test` skips it unless RUN_PROD_TESTS=1.
 *
 * It serves a copy of .next/standalone on 127.0.0.1 twice, as web (the flag
 * off) and as the curator (the flag on, with the test's port as the tunnel
 * port, since the allowlist answers to 3001 and the test can't take it, and
 * test secret files). For each it checks the curator paths' status and
 * headers, posts a server action ID to `/` and to `/curation/inbox` with
 * the Host, Origin and session checks failing, and checks the data root and
 * the library are byte-identical after. On the curator it signs in with the
 * test passphrase, uses the session, logs out, and replays the cookie. Then
 * it starts the curator with a bad setting and checks the process stops
 * with a message, and without a secret file and checks every path is a 503.
 *
 * PROD_TEST_PORT_BASE pins the ports it listens on, counting up from it, for
 * a machine that hands out ranges; by default they're free ones.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeCuratorSecrets, type TestCuratorSecrets } from '../helpers/curatorSecrets';
import { folderBytes } from '../helpers/folderBytes';

const STANDALONE = path.resolve(import.meta.dirname, '../../.next/standalone');
const ACTION_ID = '7f'.repeat(21);

let pinned = Number(process.env.PROD_TEST_PORT_BASE);

async function freePort(): Promise<number> {
    if (Number.isInteger(pinned) && pinned > 0) return pinned++;
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address() as net.AddressInfo;
    probe.close();
    await once(probe, 'close');
    return port;
}

interface Answer {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
}

/** One request to 127.0.0.1:`port` with exactly these headers, Host included, which fetch won't send. */
function send(port: number, pathname: string, options: { method?: string; headers?: Record<string, string>; address?: string; body?: string } = {}): Promise<Answer> {
    return new Promise((resolve, reject) => {
        const body = options.body ?? (options.method === 'POST' ? '[]' : undefined);
        const request = http.request(
            {
                host: options.address ?? '127.0.0.1',
                port,
                path: pathname,
                method: options.method ?? 'GET',
                headers: { host: `127.0.0.1:${port}`, ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }), ...options.headers },
            },
            (response) => {
                let text = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => (text += chunk));
                response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
            },
        );
        request.on('error', reject);
        request.end(body);
    });
}

interface Server {
    port: number;
    child: ChildProcess;
    output: () => string;
    stop: () => Promise<void>;
}

function spawnServer(cwd: string, port: number, env: Record<string, string>): Server {
    const base = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith('PHOTOGRAPHY_') && !name.startsWith('CURATION_') && !name.startsWith('CURATOR_')),
    );
    const child = spawn(process.execPath, ['server.js'], {
        cwd,
        env: { ...base, NODE_ENV: 'production', PORT: String(port), HOSTNAME: '127.0.0.1', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => (output += chunk));
    child.stderr?.on('data', (chunk) => (output += chunk));
    const stop = async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit');
        child.kill();
        await exited;
    };
    return { port, child, output: () => output, stop };
}

async function waitUntilAnswering(server: Server): Promise<void> {
    const deadline = Date.now() + 60_000;
    for (;;) {
        if (server.child.exitCode !== null) throw new Error(`The server exited with ${server.child.exitCode}:\n${server.output()}`);
        try {
            await send(server.port, '/api/health');
            return;
        } catch {
            // Not listening yet.
        }
        if (Date.now() > deadline) throw new Error(`The server did not answer within 60 s:\n${server.output()}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}

/** Waits for the process to exit, poking it with a request now and then in case Next runs instrumentation on the first one. */
async function waitForExit(server: Server, address = '127.0.0.1'): Promise<number | null> {
    const deadline = Date.now() + 60_000;
    while (server.child.exitCode === null && Date.now() < deadline) {
        await send(server.port, '/', { address }).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return server.child.exitCode;
}

function expectCuratorHeaders(answer: Answer, label: string) {
    expect(String(answer.headers['cache-control']).split(',').map((part) => part.trim()), label).toContain('no-store');
    expect(answer.headers['x-robots-tag'], label).toBe('noindex, nofollow');
    expect(answer.headers['referrer-policy'], label).toBe('no-referrer');
    expect(answer.headers['content-security-policy'], label).toBe("frame-ancestors 'none'");
}

describe.skipIf(process.env.RUN_PROD_TESTS !== '1')('the curator boundary on the standalone build', () => {
    let served = '';
    let roots = '';
    let dataRoot = '';
    let library = '';
    let secrets: TestCuratorSecrets;
    const servers: Server[] = [];

    beforeAll(async () => {
        secrets = await makeCuratorSecrets();
        if (!fs.existsSync(path.join(STANDALONE, 'server.js'))) {
            throw new Error('There is no .next/standalone/server.js. Run npm run test:prod, which builds first.');
        }
        served = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-standalone-'));
        fs.cpSync(STANDALONE, served, { recursive: true, verbatimSymlinks: true });
        roots = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-roots-'));
        dataRoot = path.join(roots, 'data');
        library = path.join(roots, 'library');
        fs.mkdirSync(path.join(dataRoot, 'curation'), { recursive: true });
        fs.writeFileSync(path.join(dataRoot, 'curation', 'keep.json'), '{}\n');
        fs.mkdirSync(library);
        fs.writeFileSync(path.join(library, 'a.jpg'), 'jpeg bytes');
    }, 120_000);

    afterAll(async () => {
        for (const server of servers) await server.stop();
        if (served) fs.rmSync(served, { recursive: true, force: true });
        if (roots) fs.rmSync(roots, { recursive: true, force: true });
        secrets?.cleanup();
    });

    const snapshot = () => ({ data: folderBytes(dataRoot), library: folderBytes(library) });

    async function start(env: Record<string, string>): Promise<Server> {
        const port = await freePort();
        const server = spawnServer(served, port, { PHOTOGRAPHY_DATA_DIR: dataRoot, PHOTOGRAPHY_LIBRARY_DIR: library, ...env });
        servers.push(server);
        await waitUntilAnswering(server);
        return server;
    }

    it('404s every curator path on web, and posts to / and /curation/inbox write nothing', async () => {
        const web = await start({});
        const before = snapshot();
        for (const pathname of ['/curation', '/curation/inbox', '/curation/login', '/api/curation/events', '/api/curation/login']) {
            const answer = await send(web.port, pathname);
            expect(answer.status, pathname).toBe(404);
            expectCuratorHeaders(answer, pathname);
        }
        for (const pathname of ['/', '/curation/inbox']) {
            for (const headers of [{}, { origin: `http://127.0.0.1:${web.port}` }, { host: 'rebound.example', origin: 'http://rebound.example' }] as Record<string, string>[]) {
                const answer = await send(web.port, pathname, { method: 'POST', headers: { 'next-action': ACTION_ID, 'content-type': 'text/plain;charset=UTF-8', ...headers } });
                expect(answer.status, `${pathname} ${JSON.stringify(headers)}`).toBe(404);
            }
        }
        expect(snapshot()).toEqual(before);
        await web.stop();
    }, 120_000);

    it('serves /curation on the curator only to an allowed Host and a session, with its headers, and refuses mutations that fail the checks', async () => {
        const port = await freePort();
        const server = spawnServer(served, port, {
            PHOTOGRAPHY_DATA_DIR: dataRoot,
            PHOTOGRAPHY_LIBRARY_DIR: library,
            CURATION_ENABLED: 'true',
            CURATOR_TUNNEL_PORT: String(port),
            ...secrets.env,
        });
        servers.push(server);
        await waitUntilAnswering(server);
        const before = snapshot();
        const origin = `http://127.0.0.1:${port}`;

        // Without a session: a page, and its RSC payload, go to the login, and a handler is a 401.
        for (const [pathname, headers] of [
            ['/curation', {}],
            ['/curation', { rsc: '1' }],
            ['/curation/inbox', { rsc: '1', 'next-router-prefetch': '1' }],
        ] as [string, Record<string, string>][]) {
            const anonymous = await send(port, pathname, { headers });
            expect(anonymous.status, `GET ${pathname} ${JSON.stringify(headers)}`).toBe(307);
            expect(new URL(String(anonymous.headers.location), origin).href).toBe(`${origin}/curation/login`);
            expect(anonymous.body).not.toContain('signed in');
            expectCuratorHeaders(anonymous, `GET ${pathname}, anonymous`);
        }
        for (const pathname of ['/api/curation/events', '/api/curation/media/ph_x/sha256-x/p_x/w800.webp']) {
            const answer = await send(port, pathname);
            expect(answer.status, `GET ${pathname}`).toBe(401);
        }
        const login = await send(port, '/curation/login');
        expect(login.status).toBe(200);
        expectCuratorHeaders(login, 'GET /curation/login');
        expect(login.body).toContain('action="/api/curation/login"');

        const rebound = await send(port, '/curation/login', { headers: { host: `rebound.example:${port}` } });
        expect(rebound.status).toBe(421);
        expectCuratorHeaders(rebound, 'GET /curation, rebound');

        const action = { 'next-action': ACTION_ID, 'content-type': 'text/plain;charset=UTF-8' };
        const refused: [string, Record<string, string>, number][] = [
            ['/curation/inbox', { ...action }, 403],
            ['/curation/inbox', { ...action, origin: 'https://attacker.example' }, 403],
            ['/curation/inbox', { ...action, origin: 'null' }, 403],
            ['/curation/inbox', { ...action, host: `rebound.example:${port}`, origin: `http://rebound.example:${port}` }, 421],
            ['/curation/inbox', { ...action, origin }, 401],
            ['/curation/login', { ...action, origin }, 401],
            ['/curation', { ...action }, 403],
            ['/', { ...action }, 404],
            ['/', { ...action, origin }, 404],
        ];
        for (const [pathname, headers, status] of refused) {
            const answer = await send(port, pathname, { method: 'POST', headers });
            expect(answer.status, `POST ${pathname} ${JSON.stringify(headers)}`).toBe(status);
        }
        expect(snapshot()).toEqual(before);

        // Signing in: a wrong passphrase gets no cookie, the right one gets a session.
        const form = (passphrase: string) => new URLSearchParams({ passphrase }).toString();
        const post = (passphrase: string, headers: Record<string, string> = {}) =>
            send(port, '/api/curation/login', { method: 'POST', body: form(passphrase), headers: { origin, 'content-type': 'application/x-www-form-urlencoded', ...headers } });
        const wrong = await post('not the passphrase');
        expect(wrong.status).toBe(303);
        expect(wrong.headers.location).toBe('/curation/login?failed=1');
        expect(wrong.headers['set-cookie']).toBeUndefined();
        expect((await post(secrets.passphrase, { origin: 'https://attacker.example' })).headers['set-cookie']).toBeUndefined();
        const signedIn = await post(secrets.passphrase);
        expect(signedIn.status).toBe(303);
        expect(signedIn.headers.location).toBe('/curation');
        const [setCookie] = signedIn.headers['set-cookie'] ?? [];
        expect(setCookie.split('; ').slice(1).sort()).toEqual(['HttpOnly', 'Max-Age=43200', 'Path=/', 'SameSite=Strict', 'Secure']);
        const cookie = setCookie.split(';')[0];
        const page = await send(port, '/curation', { headers: { cookie } });
        expect(page.status).toBe(200);
        expectCuratorHeaders(page, 'GET /curation, signed in');
        expect((await send(port, '/curation', { headers: { cookie, rsc: '1' } })).status).toBe(200);
        expect((await send(port, '/curation/login', { headers: { cookie } })).status).toBe(307);

        // Logout ends it, so the same cookie replayed is anonymous again.
        expect((await send(port, '/api/curation/logout', { method: 'POST', body: '', headers: { cookie } })).status).toBe(403);
        const out = await send(port, '/api/curation/logout', { method: 'POST', body: '', headers: { cookie, origin } });
        expect(out.status).toBe(303);
        expect(out.headers['set-cookie']?.[0]).toMatch(/^curator_session=; .*Max-Age=0/);
        expect((await send(port, '/curation', { headers: { cookie } })).status).toBe(307);
        expect((await send(port, '/api/curation/events', { headers: { cookie } })).status).toBe(401);
        expect(snapshot()).toEqual(before);

        // Its public paths answer the curator's Host, and no other.
        expect((await send(port, '/api/health')).status).toBe(200);
        expect((await send(port, '/api/health', { headers: { host: `rebound.example:${port}` } })).status).toBe(421);
        expect((await send(port, '/', { headers: { host: 'keyurgolani.photography' } })).status).toBe(421);
        await server.stop();
    }, 120_000);

    it('stops the curator at startup on a bad tunnel port, with a message naming the setting', async () => {
        const port = await freePort();
        const server = spawnServer(served, port, {
            PHOTOGRAPHY_DATA_DIR: dataRoot,
            PHOTOGRAPHY_LIBRARY_DIR: library,
            CURATION_ENABLED: 'true',
            CURATOR_TUNNEL_PORT: 'not-a-port',
        });
        servers.push(server);
        expect(await waitForExit(server)).toBe(1);
        expect(server.output()).toContain('CURATION_ENABLED is true, but CURATOR_TUNNEL_PORT must be a port number');
        expect(server.output()).not.toContain('not-a-port');
    }, 120_000);

    it('answers 503 on every path while a secret file is missing, and says so at startup without a value', async () => {
        const port = await freePort();
        const server = spawnServer(served, port, {
            PHOTOGRAPHY_DATA_DIR: dataRoot,
            PHOTOGRAPHY_LIBRARY_DIR: library,
            CURATION_ENABLED: 'true',
            CURATOR_TUNNEL_PORT: String(port),
            ...secrets.env,
            CURATOR_SESSION_SECRET_FILE: path.join(secrets.dir, 'missing.key'),
        });
        servers.push(server);
        const deadline = Date.now() + 60_000;
        let health = 0;
        while (Date.now() < deadline) {
            health = await send(port, '/api/health').then((answer) => answer.status, () => 0);
            if (health !== 0) break;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        expect(health).toBe(503);
        for (const pathname of ['/curation', '/curation/login', '/api/curation/events', '/']) expect((await send(port, pathname)).status, pathname).toBe(503);
        const login = await send(port, '/api/curation/login', {
            method: 'POST',
            body: new URLSearchParams({ passphrase: secrets.passphrase }).toString(),
            headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded' },
        });
        expect(login.status).toBe(503);
        expect(login.headers['set-cookie']).toBeUndefined();
        expect(server.output()).toContain('CURATOR_SESSION_SECRET_FILE');
        expect(server.output()).not.toContain(secrets.passphrase);
        await server.stop();
    }, 120_000);

    // 127.0.0.2 is loopback on Linux, where CI runs, so this binds nothing
    // beyond loopback, but the rule takes only 127.0.0.1, ::1 and localhost.
    it.skipIf(process.platform !== 'linux')('stops the curator at startup when HOSTNAME is not one of the loopback names', async () => {
        const port = await freePort();
        const server = spawnServer(served, port, { PHOTOGRAPHY_DATA_DIR: dataRoot, PHOTOGRAPHY_LIBRARY_DIR: library, CURATION_ENABLED: 'true', HOSTNAME: '127.0.0.2' });
        servers.push(server);
        expect(await waitForExit(server, '127.0.0.2')).toBe(1);
        expect(server.output()).toContain('CURATION_ENABLED is true, but HOSTNAME is not 127.0.0.1, ::1 or localhost');
    }, 120_000);
});
