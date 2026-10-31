import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

// What the perf run's specs share (surround-perf.spec.ts, lcp.spec.ts): a built tree served on loopback, a tree served
// from a copy so the original is only read, the stand-in prints every image request is answered with, and the phase log.

export interface Server {
    origin: string;
    stop: () => Promise<void>;
}

/** `next start` from `tree` on 127.0.0.1, on the catalog. Stopped by its process group's PID, never by name. */
export async function serve(tree: string, port: number, root: string, library: string, siteConfig: string): Promise<Server> {
    const kept = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PHOTOGRAPHY_') && !name.startsWith('CURAT') && name !== 'SITE_URL'));
    const child: ChildProcess = spawn(process.execPath, [path.join(tree, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
        cwd: tree,
        env: { ...kept, NODE_ENV: 'production', ALLOW_PROVISIONAL_COPY: '1', NEXT_TELEMETRY_DISABLED: '1', PHOTOGRAPHY_DATA_DIR: root, PHOTOGRAPHY_LIBRARY_DIR: library, PHOTOGRAPHY_SITE_CONFIG_DIR: siteConfig },
        detached: true,
        stdio: 'ignore',
    });
    const kill = (signal: NodeJS.Signals) => {
        try {
            if (child.pid) process.kill(-child.pid, signal);
        } catch {
            // Gone already.
        }
    };
    process.once('exit', () => kill('SIGKILL'));
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        if ((await fetch(`${origin}/api/ready`).then((r) => r.status, () => 0)) === 200) {
            return {
                origin,
                stop: () =>
                    new Promise<void>((resolve) => {
                        if (child.exitCode !== null) return resolve();
                        const force = setTimeout(() => kill('SIGKILL'), 5000);
                        child.once('exit', () => {
                            clearTimeout(force);
                            resolve();
                        });
                        kill('SIGTERM');
                    }),
            };
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    kill('SIGKILL');
    throw new Error(`${tree} never answered on ${port}`);
}

/**
 * A tree to serve `tree`'s build from without writing to it: its `.next` cloned (APFS copy-on-write, so it's quick and
 * takes no space), everything else linked. `next start` writes only under `.next` (its cache), so the original build
 * is only read, and is never rebuilt. The clone is forced: a volume that can't clone fails the run instead of copying
 * the bytes (the 2026-10-31 disk fill).
 */
export function readOnlyTree(tree: string, into: string): string {
    if (!fs.existsSync(path.join(tree, '.next', 'BUILD_ID'))) throw new Error(`${tree} has no build`);
    fs.mkdirSync(into, { recursive: true });
    for (const entry of fs.readdirSync(tree)) {
        if (entry === '.next' || entry === '.git') continue;
        fs.symlinkSync(path.join(tree, entry), path.join(into, entry));
    }
    fs.cpSync(path.join(tree, '.next'), path.join(into, '.next'), { recursive: true, mode: fs.constants.COPYFILE_FICLONE_FORCE, verbatimSymlinks: true });
    return into;
}

/** One valid file per format, of one flat colour, which every variant request is answered with. */
export async function standInPrints(width: number, height: number): Promise<Record<string, Buffer>> {
    const source = sharp({ create: { width, height, channels: 3, background: { r: 120, g: 132, b: 128 } } });
    return { webp: await source.clone().webp().toBuffer(), avif: await source.clone().avif().toBuffer(), jpeg: await source.clone().jpeg().toBuffer() };
}

/** Variant requests, `/…/w<width>.<format>`, which the stand-in prints answer. */
export const VARIANT_REQUEST = /\/w\d+\.(webp|avif|jpe?g)(\?|$)/;

/** The stand-in print of the request's format. */
export function variantFormat(url: string): string {
    return /\.(webp|avif|jpe?g)/.exec(url)![1].replace('jpg', 'jpeg');
}

/** A timestamped line per phase, so a run that runs out of time says where (perf4 hit its cap with no clue). */
export const phase = (what: string) => console.log(`[perf ${new Date().toISOString().slice(11, 19)}, load ${os.loadavg()[0].toFixed(1)}] ${what}`);
