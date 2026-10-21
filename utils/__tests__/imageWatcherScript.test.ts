// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { dominantChannel, fixtureFiles } from '../../test/fixtures/makeLibrary';
import { createTempLibrary, derivativePaths, type TempLibrary } from '../../test/helpers/tempLibrary';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ALL_OUTPUTS = ['landscape', 'portrait', 'square'].flatMap(derivativePaths);

let lib: TempLibrary | undefined;
const children: ChildProcess[] = [];

afterEach(async () => {
    for (const child of children.splice(0)) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await lib?.cleanup();
    lib = undefined;
});

/** Start `scripts/imageWatcher.ts` the way `npm run images:process` and `images:watch` do, in a child process. */
function startWatcher(root: string, ...args: string[]) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/imageWatcher.ts', ...args], {
        cwd: REPO_ROOT,
        env: { ...process.env, PHOTOGRAPHY_LIBRARY_DIR: root },
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

describe('imageWatcher --once', { timeout: 120_000 }, () => {
    it('deletes nothing after a source is removed', async () => {
        lib = await createTempLibrary({ fixtures: 'basic' });
        const first = await runOnce(lib.root);
        expect(first.code, first.output).toBe(0);
        const before = lib.hashes(ALL_OUTPUTS);
        expect(Object.keys(before)).toHaveLength(21);

        fs.unlinkSync(lib.file('landscape.jpg'));
        const second = await runOnce(lib.root);

        expect(second.code, second.output).toBe(0);
        expect(lib.hashes(ALL_OUTPUTS)).toEqual(before);
        expect(fs.existsSync(lib.file('portrait.png'))).toBe(true);
        expect(fs.existsSync(lib.file('square.webp'))).toBe(true);
    });

    it('exits 1 on a missing library root and creates nothing', async () => {
        lib = await createTempLibrary({ missingRoot: true });
        const run = await runOnce(lib.root);

        expect(run.code, run.output).toBe(1);
        expect(run.output).toContain(`Library root not found: ${lib.root}`);
        expect(fs.existsSync(lib.root)).toBe(false);
    });

    it('exits 2 on a mistyped flag and processes nothing', async () => {
        lib = await createTempLibrary({ fixtures: 'basic' });
        const run = await runOnce(lib.root, '--froce');

        expect(run.code, run.output).toBe(2);
        expect(run.output).toContain("Unknown option '--froce'");
        expect(fs.readdirSync(lib.root).sort()).toEqual(['landscape.jpg', 'portrait.png', 'square.webp']);
    });

    it('exits 1 when a photo fails, after processing the others', async () => {
        lib = await createTempLibrary({ fixtures: 'extras' });
        const run = await runOnce(lib.root);

        expect(run.code, run.output).toBe(1);
        expect(run.output).toContain('[ImageWatcher] Error processing corrupt.jpg:');
        const decodable = ['landscape', 'portrait', 'square', 'landscape-edited', 'landscape-rot6'];
        expect(Object.keys(lib.hashes(decodable.flatMap(derivativePaths)))).toHaveLength(35);
    });

    it('--force regenerates a replacement that has an older mtime', async () => {
        lib = await createTempLibrary({ fixtures: 'basic' });
        expect((await runOnce(lib.root)).code).toBe(0);
        const before = lib.hashes(derivativePaths('landscape'));

        // A re-export copied in with its original, older mtime, as `rsync -a` would
        const edited = (await fixtureFiles({ extras: true })).get('landscape-edited.jpg') as Buffer;
        fs.writeFileSync(lib.file('landscape.jpg'), edited);
        const old = new Date('2001-01-01T00:00:00Z');
        fs.utimesSync(lib.file('landscape.jpg'), old, old);

        expect((await runOnce(lib.root)).code).toBe(0);
        expect(lib.hashes(derivativePaths('landscape'))).toEqual(before);

        const forced = await runOnce(lib.root, '--force');
        expect(forced.code, forced.output).toBe(0);
        expect(await dominantChannel(fs.readFileSync(lib.file('optimized/landscape.webp')))).toBe('blue');
        expect(await dominantChannel(fs.readFileSync(lib.file('thumbnails-avif/landscape.avif')))).toBe('blue');
    });
});

describe('imageWatcher --watch', { timeout: 120_000 }, () => {
    it('exits 1 when the library root disappears', async () => {
        lib = await createTempLibrary({ fixtures: 'basic' });
        const watcher = startWatcher(lib.root, '--watch');
        await watcher.waitFor('Initial scan complete');
        await watcher.waitFor('[ImageWatcher] Completed:');

        fs.rmSync(lib.root, { recursive: true, force: true });

        expect(await within(watcher.exited, 30_000, 'Exiting after the root disappeared'), watcher.output).toBe(1);
        expect(watcher.output).toMatch(/Library root (removed|disappeared): /);
    });

    it('exits 0 on SIGTERM after closing the watcher', async () => {
        lib = await createTempLibrary({ fixtures: 'basic' });
        const watcher = startWatcher(lib.root, '--watch');
        await watcher.waitFor('Initial scan complete');
        await watcher.waitFor('[ImageWatcher] Completed:');

        watcher.child.kill('SIGTERM');

        expect(await within(watcher.exited, 15_000, 'Shutting down'), watcher.output).toBe(0);
        expect(watcher.output).toContain('[ImageWatcher] Received SIGTERM. Shutting down...');
        expect(watcher.output).toContain('[ImageWatcher] Watcher closed.');
    });
});
