// @vitest-environment node
/**
 * #14's curator boundary on the standalone build, which `npm run test:prod`
 * makes first. Plain `npm test` skips it unless RUN_PROD_TESTS=1.
 *
 * It serves a copy of .next/standalone on 127.0.0.1 twice, as web (the flag
 * off) and as the curator (the flag on, with the test's port as the tunnel
 * port, since the allowlist answers to 3001 and the test can't take it). For
 * each it checks the curator paths' status and headers, posts a server
 * action ID to `/` and to `/curation/inbox` with the Host and Origin checks
 * failing, and checks the data root and the library are byte-identical
 * after. Then it starts the curator with a bad setting and checks the
 * process stops with a message.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { folderBytes } from '../helpers/folderBytes';

const STANDALONE = path.resolve(import.meta.dirname, '../../.next/standalone');
const ACTION_ID = '7f'.repeat(21);

async function freePort(): Promise<number> {
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
}

/** One request to 127.0.0.1:`port` with exactly these headers, Host included, which fetch won't send. */
function send(port: number, pathname: string, options: { method?: string; headers?: Record<string, string>; address?: string } = {}): Promise<Answer> {
    return new Promise((resolve, reject) => {
        const request = http.request(
            { host: options.address ?? '127.0.0.1', port, path: pathname, method: options.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...options.headers } },
            (response) => {
                response.resume();
                response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers }));
            },
        );
        request.on('error', reject);
        request.end(options.method === 'POST' ? '[]' : undefined);
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
    const servers: Server[] = [];

    beforeAll(() => {
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
        for (const pathname of ['/curation', '/curation/inbox', '/api/curation/events']) {
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

    it('serves /curation on the curator only to an allowed Host, with its headers, and refuses mutations that fail the checks', async () => {
        const port = await freePort();
        const server = spawnServer(served, port, {
            PHOTOGRAPHY_DATA_DIR: dataRoot,
            PHOTOGRAPHY_LIBRARY_DIR: library,
            CURATION_ENABLED: 'true',
            CURATOR_TUNNEL_PORT: String(port),
        });
        servers.push(server);
        await waitUntilAnswering(server);
        const before = snapshot();

        const page = await send(port, '/curation');
        expect(page.status).toBe(200);
        expectCuratorHeaders(page, 'GET /curation');

        const rebound = await send(port, '/curation', { headers: { host: `rebound.example:${port}` } });
        expect(rebound.status).toBe(421);
        expectCuratorHeaders(rebound, 'GET /curation, rebound');

        const action = { 'next-action': ACTION_ID, 'content-type': 'text/plain;charset=UTF-8' };
        const refused: [string, Record<string, string>, number][] = [
            ['/curation/inbox', { ...action }, 403],
            ['/curation/inbox', { ...action, origin: 'https://attacker.example' }, 403],
            ['/curation/inbox', { ...action, origin: 'null' }, 403],
            ['/curation/inbox', { ...action, host: `rebound.example:${port}`, origin: `http://rebound.example:${port}` }, 421],
            ['/curation', { ...action }, 403],
            ['/', { ...action }, 404],
            ['/', { ...action, origin: `http://127.0.0.1:${port}` }, 404],
        ];
        for (const [pathname, headers, status] of refused) {
            const answer = await send(port, pathname, { method: 'POST', headers });
            expect(answer.status, `POST ${pathname} ${JSON.stringify(headers)}`).toBe(status);
        }
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
