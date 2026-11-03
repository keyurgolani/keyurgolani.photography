// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { currentProfileId } from '../../lib/identity/profile';
import type { Registry } from '../../lib/identity/types';
import { fixtureFiles } from '../../test/fixtures/makeLibrary';
import { newestRegistryVersion, readNewestRegistry } from '../../test/helpers/registryFiles';
import { createTempDataRoot, type TempDataRoot } from '../../test/helpers/tempDataRoot';
import { createTempLibrary, type TempLibrary } from '../../test/helpers/tempLibrary';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

let lib: TempLibrary | undefined;
let data: TempDataRoot | undefined;
const children: ChildProcess[] = [];

afterEach(async () => {
    for (const child of children.splice(0)) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await data?.cleanup();
    data = undefined;
    await lib?.cleanup();
    lib = undefined;
});

/**
 * Start `scripts/imageWatcher.ts` the way `npm run images:process` and
 * `images:watch` do, in a child process. Its data root is a path inside the
 * library's temp folder that doesn't exist, so the identity step stays off
 * and never reads the repository's portfolio-data. With no legacy step, such
 * a watcher does nothing but watch.
 */
function startWatcher(root: string, ...args: string[]) {
    return spawnWatcher(args, { PHOTOGRAPHY_LIBRARY_DIR: root, PHOTOGRAPHY_DATA_DIR: path.join(path.dirname(root), 'no-data-root') });
}

function spawnWatcher(args: string[], env: Record<string, string>) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/imageWatcher.ts', ...args], {
        cwd: REPO_ROOT,
        env: { ...process.env, ...env },
    });
    children.push(child);
    let output = '';
    const onOutput: (() => void)[] = [];
    const collect = (chunk: Buffer) => {
        output += chunk.toString();
        onOutput.forEach((check) => check());
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const exited = new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve(code));
    });

    return {
        child,
        exited,
        get output() {
            return output;
        },
        /** Resolve once the output contains `text`. */
        waitFor(text: string, timeoutMs = 60_000): Promise<void> {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`No "${text}" within ${timeoutMs} ms:\n${output}`)), timeoutMs);
                const check = () => {
                    if (output.includes(text)) {
                        clearTimeout(timer);
                        resolve();
                    }
                };
                onOutput.push(check);
                check();
                void exited.then(() => {
                    clearTimeout(timer);
                    if (!output.includes(text)) reject(new Error(`Exited before "${text}":\n${output}`));
                });
            });
        },
    };
}

async function runOnce(root: string, ...args: string[]): Promise<{ code: number | null; output: string }> {
    const run = startWatcher(root, '--once', ...args);
    const code = await run.exited;
    return { code, output: run.output };
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms)),
    ]);
}

/** `--once` with the identity step on, over the data root at `dataRoot`. */
async function runOnceWithIdentity(root: string, dataRoot: string): Promise<{ code: number | null; output: string }> {
    const run = spawnWatcher(['--once'], { PHOTOGRAPHY_LIBRARY_DIR: root, PHOTOGRAPHY_DATA_DIR: dataRoot });
    const code = await run.exited;
    return { code, output: run.output };
}

function readRegistryFile(root: string): Registry {
    return readNewestRegistry(root) as unknown as Registry;
}

/** The library paths of photos whose current revision has a ready set. */
function readySets(root: string): string[] {
    if (newestRegistryVersion(root) === 0) return [];
    return Object.values(readRegistryFile(root).photos)
        .filter((photo) => photo.revisions[photo.source.observedRevision]?.profiles[currentProfileId()]?.state === 'ready')
        .map((photo) => photo.source.path)
        .sort();
}

/** Every file in the asset store with its bytes. */
function assetStore(root: string): Record<string, string> {
    const store = path.join(root, 'assets');
    const files: Record<string, string> = {};
    for (const relativePath of fs.readdirSync(store, { recursive: true, encoding: 'utf8' }).sort()) {
        const file = path.join(store, relativePath);
        if (fs.statSync(file).isFile()) files[relativePath] = fs.readFileSync(file).toString('base64');
    }
    return files;
}

async function waitUntil(check: () => boolean, timeoutMs: number, what: string, output: () => string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`${what} within ${timeoutMs} ms:\n${output()}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
}

const LEGACY_FOLDERS = ['thumbnails', 'medium', 'optimized', 'thumbnails-avif', 'medium-avif', 'optimized-avif', 'lqip', 'cache'];

describe('imageWatcher --once', { timeout: 120_000 }, () => {
    it('builds every set in the data root and writes nothing in the library, not even a folder', async () => {
        lib = await createTempLibrary({ fixtures: 'basic' });
        data = createTempDataRoot();
        const before = lib.snapshot();

        const run = await runOnceWithIdentity(lib.root, data.root);

        expect(run.code, run.output).toBe(0);
        expect(readySets(data.root)).toEqual(['landscape.jpg', 'portrait.png', 'square.webp']);
        expect(lib.snapshot()).toEqual(before);
        expect(LEGACY_FOLDERS.filter((folder) => fs.existsSync(lib!.file(folder)))).toEqual([]);
        expect(run.output).not.toContain('[ImageWatcher] Processing');
    });

    it('writes legacyDerivatives: false into the heartbeat', async () => {
        lib = await createTempLibrary({ fixtures: 'basic' });
        data = createTempDataRoot();

        const run = await runOnceWithIdentity(lib.root, data.root);

        expect(run.code, run.output).toBe(0);
        expect(JSON.parse(fs.readFileSync(data.file('status', 'watcher.json'), 'utf8'))).toMatchObject({ lastPassResult: 'committed', legacyDerivatives: false });
    });

    it('leaves a v1.6 library\'s legacy derivatives exactly as they are, and never reads them as photos', async () => {
        lib = await createTempLibrary({ fixtures: 'basic' });
        data = createTempDataRoot();
        for (const folder of LEGACY_FOLDERS) fs.mkdirSync(lib.file(folder));
        fs.copyFileSync(lib.file('square.webp'), lib.file('optimized', 'square.webp'));
        fs.writeFileSync(lib.file('lqip', 'square.txt'), 'data:image/webp;base64,AAAA');
        fs.writeFileSync(lib.file('cache', 'upright-v1.json'), '{}');
        const before = lib.snapshot();

        const run = await runOnceWithIdentity(lib.root, data.root);

        expect(run.code, run.output).toBe(0);
        expect(lib.snapshot()).toEqual(before);
        expect(readySets(data.root)).toEqual(['landscape.jpg', 'portrait.png', 'square.webp']);
    });

    it('exits 1 on a missing library root and creates nothing', async () => {
        lib = await createTempLibrary({ missingRoot: true });
        data = createTempDataRoot();
        const run = await runOnceWithIdentity(lib.root, data.root);

        expect(run.code, run.output).toBe(1);
        expect(run.output).toContain(`Library root not found: ${lib.root}`);
        expect(fs.existsSync(lib.root)).toBe(false);
        expect(newestRegistryVersion(data.root)).toBe(0);
    });

    it.each(['--once', '--watch'])('%s exits 1 when PHOTOGRAPHY_LIBRARY_DIR is unset, naming it, and never falls back to public/assets/photos', async (mode) => {
        data = createTempDataRoot();
        const run = spawnWatcher([mode], { PHOTOGRAPHY_LIBRARY_DIR: '', PHOTOGRAPHY_DATA_DIR: data.root, NODE_ENV: 'production' });
        const code = await within(run.exited, 30_000, 'Exiting with no library');

        expect(code, run.output).toBe(1);
        expect(run.output).toContain('[ImageWatcher] PHOTOGRAPHY_LIBRARY_DIR is not set. Point it at the photo library: /data/library in both compose files. Nothing was processed.');
        expect(run.output).not.toContain('public/assets/photos');
        expect(newestRegistryVersion(data.root)).toBe(0);
    });

    it('exits 2 on a mistyped flag and processes nothing', async () => {
        lib = await createTempLibrary({ fixtures: 'basic' });
        const run = await runOnce(lib.root, '--froce');

        expect(run.code, run.output).toBe(2);
        expect(run.output).toContain("Unknown option '--froce'");
        expect(fs.readdirSync(lib.root).sort()).toEqual(['landscape.jpg', 'portrait.png', 'square.webp']);
    });

    it('exits 2 on --force, which rebuilt the legacy derivatives the watcher no longer writes', async () => {
        lib = await createTempLibrary({ fixtures: 'basic' });
        data = createTempDataRoot();
        const before = lib.snapshot();
        const run = spawnWatcher(['--once', '--force'], { PHOTOGRAPHY_LIBRARY_DIR: lib.root, PHOTOGRAPHY_DATA_DIR: data.root });
        const code = await run.exited;

        expect(code, run.output).toBe(2);
        expect(run.output).toContain('[ImageWatcher] --force rebuilt the legacy derivatives, which the watcher no longer writes (v1.7.0). Run it without --force.');
        expect(lib.snapshot()).toEqual(before);
        expect(newestRegistryVersion(data.root)).toBe(0);
    });

    it.each(['--once', '--watch'])('%s with no data root in production exits 1, since there is nothing left to do, and writes nothing', async (mode) => {
        lib = await createTempLibrary({ fixtures: 'basic' });
        const before = lib.snapshot();
        const repoDataRoot = path.join(REPO_ROOT, 'portfolio-data');
        const existedBefore = fs.existsSync(repoDataRoot);

        const run = spawnWatcher([mode], { PHOTOGRAPHY_LIBRARY_DIR: lib.root, PHOTOGRAPHY_DATA_DIR: '', NODE_ENV: 'production' });
        const code = await within(run.exited, 30_000, 'Exiting with no data root');

        expect(code, run.output).toBe(1);
        expect(run.output).toContain('[ImageWatcher] PHOTOGRAPHY_DATA_DIR is not set, and the watcher writes nothing but the data root, so it has nothing to do. Set it to the data root: /data/portfolio in both compose files.');
        expect(lib.snapshot()).toEqual(before);
        expect(fs.existsSync(repoDataRoot)).toBe(existedBefore);
    });

    it('exits 1 on a data root the migration has not initialized, writing only its heartbeat there', async () => {
        lib = await createTempLibrary({ fixtures: 'basic' });
        data = createTempDataRoot({ state: 'uninitialized' });
        const before = lib.snapshot();

        const run = await runOnceWithIdentity(lib.root, data.root);

        expect(run.code, run.output).toBe(1);
        expect(run.output).toContain('[identity] Identity step off: the data root is uninitialized (data-root.json is missing). Nothing is processed until it is ready.');
        expect(lib.snapshot()).toEqual(before);
        expect(fs.readdirSync(data.root).sort()).toEqual(['status']);
    });
});

describe('imageWatcher --watch', { timeout: 120_000 }, () => {
    it('exits 1 when the library root disappears', async () => {
        lib = await createTempLibrary({ fixtures: 'basic' });
        const watcher = startWatcher(lib.root, '--watch');
        await watcher.waitFor('Initial scan complete');

        fs.rmSync(lib.root, { recursive: true, force: true });

        expect(await within(watcher.exited, 30_000, 'Exiting after the root disappeared'), watcher.output).toBe(1);
        expect(watcher.output).toMatch(/Library root (removed|disappeared): /);
    });

    it('exits 0 on SIGTERM after closing the watcher', async () => {
        lib = await createTempLibrary({ fixtures: 'basic' });
        const watcher = startWatcher(lib.root, '--watch');
        await watcher.waitFor('Initial scan complete');

        watcher.child.kill('SIGTERM');

        expect(await within(watcher.exited, 15_000, 'Shutting down'), watcher.output).toBe(0);
        expect(watcher.output).toContain('[ImageWatcher] Received SIGTERM. Shutting down...');
        expect(watcher.output).toContain('[ImageWatcher] Watcher closed.');
    });
});

describe('the identity step', { timeout: 180_000 }, () => {
    it('--once builds a set for every photo, keeps the IDs and sets on the next run, and deletes nothing in the asset store after a source is removed', async () => {
        lib = await createTempLibrary({ fixtures: 'basic' });
        data = createTempDataRoot();

        const first = await runOnceWithIdentity(lib.root, data.root);
        expect(first.code, first.output).toBe(0);
        expect(first.output).toContain('[identity] Done: 3 built, 0 kept, 0 failed.');
        expect(readySets(data.root)).toEqual(['landscape.jpg', 'portrait.png', 'square.webp']);
        expect(JSON.parse(fs.readFileSync(data.file('status', 'watcher.json'), 'utf8'))).toMatchObject({ hostname: os.hostname(), lastPassResult: 'committed' });
        const ids = Object.keys(readRegistryFile(data.root).photos).sort();
        const store = assetStore(data.root);

        const second = await runOnceWithIdentity(lib.root, data.root);
        expect(second.code, second.output).toBe(0);
        expect(Object.keys(readRegistryFile(data.root).photos).sort()).toEqual(ids);
        expect(assetStore(data.root)).toEqual(store);

        fs.unlinkSync(lib.file('landscape.jpg'));
        const third = await runOnceWithIdentity(lib.root, data.root);
        expect(third.code, third.output).toBe(0);
        expect(Object.values(readRegistryFile(data.root).photos).find((photo) => photo.source.path === 'landscape.jpg')?.sourceHealth).toBe('missing');
        expect(assetStore(data.root)).toEqual(store);
    });

    it('--watch builds a set for a photo added at the top and one in a nested folder, and writes nothing in the library', async () => {
        lib = await createTempLibrary({ fixtures: 'basic' });
        data = createTempDataRoot();
        const root = data.root;
        const watcher = spawnWatcher(['--watch'], { PHOTOGRAPHY_LIBRARY_DIR: lib.root, PHOTOGRAPHY_DATA_DIR: root });
        await watcher.waitFor('Initial scan complete');
        await waitUntil(() => readySets(root).length === 3, 90_000, 'No sets for the three photos', () => watcher.output);

        const edited = (await fixtureFiles({ extras: true })).get('landscape-edited.jpg') as Buffer;
        fs.writeFileSync(lib.file('added.jpg'), edited);
        fs.mkdirSync(lib.file('trips'));
        fs.writeFileSync(lib.file('trips', 'ridge.jpg'), edited);
        const after = lib.snapshot();
        await waitUntil(() => readySets(root).includes('added.jpg') && readySets(root).includes('trips/ridge.jpg'), 90_000, 'No set for added.jpg and trips/ridge.jpg', () => watcher.output);

        expect(lib.snapshot()).toEqual(after);
        expect(LEGACY_FOLDERS.filter((folder) => fs.existsSync(lib!.file(folder)))).toEqual([]);
        expect(JSON.parse(fs.readFileSync(data.file('status', 'watcher.json'), 'utf8'))).toMatchObject({ legacyDerivatives: false });
        watcher.child.kill('SIGTERM');
        expect(await within(watcher.exited, 15_000, 'Shutting down'), watcher.output).toBe(0);
    });
});
