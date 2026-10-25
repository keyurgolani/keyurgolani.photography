import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { expect } from '@playwright/test';

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

/**
 * Serve the build with `dataRoot` as its data root, and wait until it
 * answers. `port` pins the port, for a machine that hands out ranges; it
 * defaults to a free one.
 */
export async function startCatalogServer(dataRoot: string, port?: number): Promise<CatalogServer> {
    const library = process.env.E2E_EMPTY_LIBRARY;
    if (!library) throw new Error('playwright.config.ts sets E2E_EMPTY_LIBRARY, so the server never reads a real photo library');
    const listen = port ?? (await freePort());
    // Only these roots, whatever this shell points PHOTOGRAPHY_* at.
    const kept = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PHOTOGRAPHY_')));
    const env: NodeJS.ProcessEnv = { ...kept, NODE_ENV: 'production', PHOTOGRAPHY_DATA_DIR: dataRoot, PHOTOGRAPHY_LIBRARY_DIR: library };
    const next = path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next');
    // Its own process group, so stopping it also stops any process it starts.
    const child = spawn(process.execPath, [next, 'start', '--port', String(listen), '--hostname', '127.0.0.1'], { cwd: process.cwd(), env, detached: true });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const signal = (name: NodeJS.Signals) => {
        try {
            if (child.pid) process.kill(-child.pid, name);
        } catch {
            // The group is already gone.
        }
    };
    const stop = () =>
        new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            const force = setTimeout(() => signal('SIGKILL'), STOP_TIMEOUT);
            child.once('exit', () => {
                clearTimeout(force);
                resolve();
            });
            signal('SIGTERM');
        });
    const origin = `http://127.0.0.1:${listen}`;
    try {
        await expect
            .poll(async () => {
                try {
                    // /api/ready answers 200 only once the catalog it serves is readable.
                    return (await fetch(`${origin}/api/ready`)).status;
                } catch {
                    return 0;
                }
            }, { timeout: READY_TIMEOUT })
            .toBe(200);
    } catch (error) {
        // No hook gets the server back to stop it, so a failed start stops its own.
        await stop();
        throw new Error(`The catalog server did not get ready:\n${output}`, { cause: error });
    }
    return { origin, output: () => output, stop };
}
