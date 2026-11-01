import { spawn } from 'node:child_process';
import fs from 'node:fs';
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
    /**
     * A server whose catalog can't be read on purpose (the error page's tests): ready once /api/ready answers 503
     * `unavailable`, which is the state it serves in, instead of 200.
     */
    unavailable?: boolean;
    /**
     * A site config folder of its own, for a spec that takes the portrait
     * away while the harness's servers keep theirs. Defaults to theirs.
     */
    siteConfig?: string;
    /**
     * Serve `.next/standalone/server.js`, as the image does, instead of
     * `next start`: config headers, `/_next/image`, and `public/` behave
     * there as in production (#16 checks them). Its `.next/static` and
     * `public/` (without the default photo library) are copied in as the
     * Dockerfile copies them, once per build.
     */
    standalone?: boolean;
}

const STANDALONE = path.join(process.cwd(), '.next', 'standalone');

/** Copy `from` to `to` through a temp sibling and a rename, so parallel workers never see half a copy. */
function copyOnce(from: string, to: string, filter?: (source: string) => boolean): void {
    const temp = `${to}.copy-${process.pid}-${Math.random().toString(36).slice(2)}`;
    fs.cpSync(from, temp, { recursive: true, filter });
    try {
        fs.renameSync(temp, to);
    } catch (error) {
        fs.rmSync(temp, { recursive: true, force: true });
        // Another worker got there first.
        if (!fs.existsSync(to)) throw error;
    }
}

/** The standalone build, with this build's static files and `public/` in place. */
function standaloneDir(): string {
    if (!fs.existsSync(path.join(STANDALONE, 'server.js'))) throw new Error('There is no .next/standalone/server.js. Run npm run build first.');
    const buildId = fs.readFileSync(path.join(process.cwd(), '.next', 'BUILD_ID'), 'utf8').trim();
    const marker = path.join(STANDALONE, '.e2e-build-id');
    if (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== buildId) {
        for (const stale of [path.join(STANDALONE, '.next', 'static'), path.join(STANDALONE, 'public')]) fs.rmSync(stale, { recursive: true, force: true });
        copyOnce(path.join(process.cwd(), '.next', 'static'), path.join(STANDALONE, '.next', 'static'));
        const library = path.join(process.cwd(), 'public', 'assets', 'photos');
        copyOnce(path.join(process.cwd(), 'public'), path.join(STANDALONE, 'public'), (source) => source !== library && !source.startsWith(`${library}${path.sep}`));
        fs.writeFileSync(marker, buildId);
    }
    return STANDALONE;
}

/** The settings that turn a server into the curator. A plain catalog server never inherits them from this shell. */
const CURATOR_SETTINGS = [
    'CURATION_ENABLED',
    'CURATOR_TUNNEL_PORT',
    'CURATOR_PUBLISH',
    'CURATOR_HOST_PORT',
    'CURATOR_EXTRA_HOSTS',
    'CURATION_BIND_SCOPE',
    'CURATOR_PASSPHRASE_HASH_FILE',
    'CURATOR_SESSION_SECRET_FILE',
];

/**
 * Serve the build with `dataRoot` as its data root, and wait until it
 * answers. `port` pins the port, for a machine that hands out ranges; it
 * defaults to a free one. `siteUrl` sets SITE_URL for this server only; it
 * is unset otherwise, whatever this shell has. `siteConfig` gives it a site
 * config folder of its own, for a spec that takes the portrait away while
 * the harness's servers keep theirs; it defaults to theirs.
 */
export async function startCatalogServer(dataRoot: string, port?: number, options: CatalogServerOptions = {}): Promise<CatalogServer> {
    const library = options.library ?? process.env.E2E_EMPTY_LIBRARY;
    const siteConfig = options.siteConfig ?? process.env.E2E_SITE_CONFIG_DIR;
    if (!library) throw new Error('playwright.config.ts sets E2E_EMPTY_LIBRARY, so the server never reads a real photo library');
    if (!siteConfig) throw new Error("playwright.config.ts sets E2E_SITE_CONFIG_DIR, so the server reads the stand-in portrait, never the checkout's site config folder");
    const listen = port ?? (await freePort());
    // Only these roots, whatever this shell points PHOTOGRAPHY_* at, and the curator only when asked.
    const kept = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PHOTOGRAPHY_') && !CURATOR_SETTINGS.includes(name)));
    const curator: Record<string, string> = options.curator ? { CURATION_ENABLED: 'true', CURATOR_TUNNEL_PORT: String(listen) } : {};
    const env: NodeJS.ProcessEnv = { ...kept, ...curator, ...options.env, NODE_ENV: 'production', PHOTOGRAPHY_DATA_DIR: dataRoot, PHOTOGRAPHY_LIBRARY_DIR: library, PHOTOGRAPHY_SITE_CONFIG_DIR: siteConfig };
    delete env.SITE_URL;
    if (options.siteUrl) env.SITE_URL = options.siteUrl;
    const next = path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next');
    // Its own process group, so stopping it also stops any process it starts. Either way it listens on 127.0.0.1 only.
    const child = options.standalone
        ? spawn(process.execPath, ['server.js'], { cwd: standaloneDir(), env: { ...env, PORT: String(listen), HOSTNAME: '127.0.0.1' }, detached: true })
        : spawn(process.execPath, [next, 'start', '--port', String(listen), '--hostname', '127.0.0.1'], { cwd: process.cwd(), env, detached: true });
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
        }, () => LISTENING.test(output), options.unavailable ? 503 : 200);
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
async function waitUntilReady(origin: string, failure: () => string | null, listening: () => boolean, ready = 200): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT;
    while (Date.now() < deadline) {
        const before = failure();
        if (before) throw new Error(`next start ${before}`);
        let status = 0;
        try {
            // /api/ready answers 200 only once the catalog it serves is readable, and 503 while it can't be.
            status = (await fetch(`${origin}/api/ready`, { signal: AbortSignal.timeout(POLL_INTERVAL * 8) })).status;
        } catch {
            // Not listening yet.
        }
        const after = failure();
        if (after) throw new Error(`next start ${after}`);
        if (status === ready && listening()) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }
    throw new Error(`next start did not answer ${ready} on /api/ready within ${READY_TIMEOUT} ms`);
}
