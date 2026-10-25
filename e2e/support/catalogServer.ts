import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

/**
 * A second `next start` from the build the harness made, on 127.0.0.1, with
 * its own data root, so a spec can see the site in catalog mode while the
 * harness server stays in legacy mode. It serves #1's empty photo library,
 * like the harness's own server.
 */

/** How long a server gets to answer, and to exit before it's killed. */
export const READY_TIMEOUT = 30_000;
const STOP_TIMEOUT = 5_000;

/** A port nothing on 127.0.0.1 listens on right now. */
function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as net.AddressInfo;
            server.close(() => resolve(port));
        });
    });
}

export interface CatalogServer {
    origin: string;
    output: () => string;
    stop: () => Promise<void>;
}

export interface CatalogServerOptions {
    /** A fixture library outside the repository, instead of #1's empty one. */
    library?: string;
    /**
     * Serve as the curator (#14): `CURATION_ENABLED=true`, with the port it
     * listens on as `CURATOR_TUNNEL_PORT`, so the Host allowlist takes
     * `127.0.0.1:<port>` and `localhost:<port>`. Still `next start
     * --hostname 127.0.0.1`, so the bind checks pass the way they do for the
     * owner's tunnel. Its secret files come from `env`
     * (e2e/support/curatorServer.ts makes test ones).
     */
    curator?: boolean;
    /** More settings for the server, such as the curator's secret file paths. */
    env?: Record<string, string>;
    /** SITE_URL for this server only. Unset otherwise, whatever this shell has. */
    siteUrl?: string;
}

/** The settings that turn a server into the curator. A plain catalog server never inherits them from this shell. */
const CURATOR_SETTINGS = ['CURATION_ENABLED', 'CURATOR_TUNNEL_PORT', 'CURATION_BIND_SCOPE', 'CURATOR_PASSPHRASE_HASH_FILE', 'CURATOR_SESSION_SECRET_FILE'];

/**
 * Serve the build with `dataRoot` as its data root, and wait until it
 * answers. `port` pins the port, for a machine that hands out ranges; it
 * defaults to a free one. `siteUrl` sets SITE_URL for this server only; it
 * is unset otherwise, whatever this shell has.
 */
export async function startCatalogServer(dataRoot: string, port?: number, options: CatalogServerOptions = {}): Promise<CatalogServer> {
    const library = options.library ?? process.env.E2E_EMPTY_LIBRARY;
    if (!library) throw new Error('playwright.config.ts sets E2E_EMPTY_LIBRARY, so the server never reads a real photo library');
    const siteConfig = process.env.E2E_SITE_CONFIG_DIR;
    if (!siteConfig) throw new Error("playwright.config.ts sets E2E_SITE_CONFIG_DIR, so the server reads the stand-in portrait, never the checkout's site config folder");
    const listen = port ?? (await freePort());
    // Only these roots, whatever this shell points PHOTOGRAPHY_* at, and the curator only when asked.
    const kept = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PHOTOGRAPHY_') && !CURATOR_SETTINGS.includes(name)));
    const curator: Record<string, string> = options.curator ? { CURATION_ENABLED: 'true', CURATOR_TUNNEL_PORT: String(listen) } : {};
    const env: NodeJS.ProcessEnv = { ...kept, ...curator, ...options.env, NODE_ENV: 'production', PHOTOGRAPHY_DATA_DIR: dataRoot, PHOTOGRAPHY_LIBRARY_DIR: library, PHOTOGRAPHY_SITE_CONFIG_DIR: siteConfig };
    delete env.SITE_URL;
    if (options.siteUrl) env.SITE_URL = options.siteUrl;
    const next = path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next');
    // Its own process group, so stopping it also stops any process it starts.
    const child = spawn(process.execPath, [next, 'start', '--port', String(listen), '--hostname', '127.0.0.1'], { cwd: process.cwd(), env, detached: true });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    let spawnError: Error | undefined;
    child.once('error', (error) => (spawnError = error));
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const signal = (name: NodeJS.Signals) => {
        try {
            if (child.pid) process.kill(-child.pid, name);
        } catch {
            // The group is already gone.
        }
    };
    // The group is detached, so Ctrl-C or a worker that dies before afterAll
    // wouldn't reach it. Exit handlers run synchronously, so this kills outright.
    const killOnExit = () => signal('SIGKILL');
    process.once('exit', killOnExit);
    child.once('exit', () => process.removeListener('exit', killOnExit));
    const stop = () =>
        new Promise<void>((resolve) => {
            if (exited() || !child.pid) return resolve();
            const force = setTimeout(() => signal('SIGKILL'), STOP_TIMEOUT);
            child.once('exit', () => {
                clearTimeout(force);
                resolve();
            });
            signal('SIGTERM');
        });
    const origin = `http://127.0.0.1:${listen}`;
    try {
        await waitUntilReady(origin, () => {
            if (spawnError) return `could not start: ${spawnError.message}`;
            if (exited()) return `exited (${child.exitCode ?? child.signalCode}) before it answered`;
            return null;
        }, () => LISTENING.test(output));
    } catch (error) {
        // No hook gets the server back to stop it, so a failed start stops its own.
        await stop();
        throw new Error(`The catalog server did not get ready:\n${output}`, { cause: error });
    }
    return { origin, output: () => output, stop };
}

/** What `next start` logs once its own server listens. A port taken by something else exits it before this. */
const LISTENING = /Ready in /;
const POLL_INTERVAL = 250;

/**
 * Poll `/api/ready` until it answers 200 while the child is still running
 * and has logged that it listens, so a 200 from whatever else holds a pinned
 * port never counts. Fails as soon as `failure` names a reason.
 */
async function waitUntilReady(origin: string, failure: () => string | null, listening: () => boolean): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT;
    while (Date.now() < deadline) {
        const before = failure();
        if (before) throw new Error(`next start ${before}`);
        let status = 0;
        try {
            // /api/ready answers 200 only once the catalog it serves is readable.
            status = (await fetch(`${origin}/api/ready`, { signal: AbortSignal.timeout(POLL_INTERVAL * 8) })).status;
        } catch {
            // Not listening yet.
        }
        const after = failure();
        if (after) throw new Error(`next start ${after}`);
        if (status === 200 && listening()) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }
    throw new Error(`next start did not answer 200 on /api/ready within ${READY_TIMEOUT} ms`);
}
