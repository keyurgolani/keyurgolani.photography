// @vitest-environment node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { dominantChannel, fixtureFiles } from '../../test/fixtures/makeLibrary';
import { createTempLibrary, derivativePaths, type TempLibrary } from '../../test/helpers/tempLibrary';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ALL_OUTPUTS = ['landscape', 'portrait', 'square'].flatMap(derivativePaths);

let lib: TempLibrary | undefined;

afterEach(async () => {
    await lib?.cleanup();
    lib = undefined;
});

/** Run `scripts/imageWatcher.ts` the way `npm run images:process` does, in a child process. */
function runWatcher(root: string, ...args: string[]): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/imageWatcher.ts', ...args], {
            cwd: REPO_ROOT,
            env: { ...process.env, PHOTOGRAPHY_LIBRARY_DIR: root },
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, output }));
    });
}

describe('imageWatcher --once', { timeout: 120_000 }, () => {
    it('deletes nothing after a source is removed', async () => {
        lib = await createTempLibrary({ fixtures: 'basic' });
        const first = await runWatcher(lib.root, '--once');
        expect(first.code, first.output).toBe(0);
        const before = lib.hashes(ALL_OUTPUTS);
        expect(Object.keys(before)).toHaveLength(21);

        fs.unlinkSync(lib.file('landscape.jpg'));
        const second = await runWatcher(lib.root, '--once');

        expect(second.code, second.output).toBe(0);
        expect(lib.hashes(ALL_OUTPUTS)).toEqual(before);
        expect(fs.existsSync(lib.file('portrait.png'))).toBe(true);
        expect(fs.existsSync(lib.file('square.webp'))).toBe(true);
    });

    it('exits 1 on a missing library root and creates nothing', async () => {
        lib = await createTempLibrary({ missingRoot: true });
        const run = await runWatcher(lib.root, '--once');

        expect(run.code, run.output).toBe(1);
        expect(run.output).toContain(`Library root not found: ${lib.root}`);
        expect(fs.existsSync(lib.root)).toBe(false);
    });

    it('--force regenerates a replacement that has an older mtime', async () => {
        lib = await createTempLibrary({ fixtures: 'basic' });
        expect((await runWatcher(lib.root, '--once')).code).toBe(0);
        const before = lib.hashes(derivativePaths('landscape'));

        // A re-export copied in with its original, older mtime, as `rsync -a` would
        const edited = (await fixtureFiles({ extras: true })).get('landscape-edited.jpg') as Buffer;
        fs.writeFileSync(lib.file('landscape.jpg'), edited);
        const old = new Date('2001-01-01T00:00:00Z');
        fs.utimesSync(lib.file('landscape.jpg'), old, old);

        expect((await runWatcher(lib.root, '--once')).code).toBe(0);
        expect(lib.hashes(derivativePaths('landscape'))).toEqual(before);

        const forced = await runWatcher(lib.root, '--once', '--force');
        expect(forced.code, forced.output).toBe(0);
        expect(await dominantChannel(fs.readFileSync(lib.file('optimized/landscape.webp')))).toBe('blue');
        expect(await dominantChannel(fs.readFileSync(lib.file('thumbnails-avif/landscape.avif')))).toBe('blue');
    });
});
