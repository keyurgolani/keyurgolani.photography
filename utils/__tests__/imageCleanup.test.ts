// @vitest-environment node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runImageCleanup } from '../../scripts/imageCleanup';
import { createTempLibrary, derivativePaths, type TempLibrary } from '../../test/helpers/tempLibrary';
import { applyOrphanCleanup, ensureDirectories, planOrphanCleanup, processImage, STALE_TEMP_FILE_MS } from '../imageOptimizer';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const STALE_TEMP = 'thumbnails/.landscape.4242.0a1b2c3d.tmp';
const YOUNG_TEMP = 'medium/.portrait.4242.0a1b2c3e.tmp';
const DYNAMIC_CACHE = 'cache/dynamic/landscape-800-85.webp';

const libraries: TempLibrary[] = [];

afterEach(async () => {
    for (const library of libraries.splice(0).reverse()) await library.cleanup();
});

async function newLibrary(options?: Parameters<typeof createTempLibrary>[0]): Promise<TempLibrary> {
    const library = await createTempLibrary(options);
    libraries.push(library);
    return library;
}

function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, output: { log: (line: string) => { out.push(line); }, error: (line: string) => { err.push(line); } } };
}

function write(lib: TempLibrary, relativePath: string, data: string | Buffer, mtimeMs?: number): void {
    fs.mkdirSync(path.dirname(lib.file(relativePath)), { recursive: true });
    fs.writeFileSync(lib.file(relativePath), data);
    if (mtimeMs !== undefined) fs.utimesSync(lib.file(relativePath), new Date(mtimeMs), new Date(mtimeMs));
}

/**
 * A processed library with one orphan of each kind: square.webp's source is
 * gone, a temp file is past the age limit, another is fresh, and /api/image
 * left a cache file. landscape.jpg was swapped for landscape.png, which shares its outputs.
 */
async function libraryWithOrphans(): Promise<TempLibrary> {
    const lib = await newLibrary({ fixtures: 'basic' });
    for (const name of ['landscape.jpg', 'portrait.png', 'square.webp']) await processImage(name);
    fs.renameSync(lib.file('landscape.jpg'), lib.file('landscape.png'));
    fs.unlinkSync(lib.file('square.webp'));
    write(lib, STALE_TEMP, 'partial', Date.now() - STALE_TEMP_FILE_MS - 60_000);
    write(lib, YOUNG_TEMP, 'partial');
    write(lib, DYNAMIC_CACHE, 'cached');
    return lib;
}

const SQUARE = derivativePaths('square');
const KEPT = [...derivativePaths('landscape'), ...derivativePaths('portrait'), YOUNG_TEMP, 'landscape.png', 'portrait.png'];

describe('images:cleanup', { timeout: 30_000 }, () => {
    it('dry run lists every orphan with its reason and deletes nothing', async () => {
        const lib = await libraryWithOrphans();
        const before = lib.hashes([...SQUARE, ...KEPT, STALE_TEMP, DYNAMIC_CACHE]);
        const { out, err, output } = capture();

        expect(runImageCleanup([], output)).toBe(0);

        expect(err).toEqual([]);
        expect(out[0]).toBe(`Library root: ${lib.root}`);
        expect(out.filter((line) => /^Would delete \S+ \(/.test(line)).sort()).toEqual([
            `Would delete ${DYNAMIC_CACHE} (unused since /api/image was removed)`,
            ...SQUARE.map((relativePath) => `Would delete ${relativePath} (no source named square.*)`),
            `Would delete ${STALE_TEMP} (stale temp file)`,
        ].sort());
        expect(out).toContainEqual(expect.stringMatching(/^Would delete 9 files, \d+ bytes.*This was a dry run\. Re-run with --apply to delete\.$/));
        expect(out).toContain('Kept 1 temp file under 10 minutes old, since a running job may still own them.');
        expect(lib.hashes(Object.keys(before))).toEqual(before);
    });

    it('--apply deletes what the dry run lists and nothing else', async () => {
        const lib = await libraryWithOrphans();
        const kept = lib.hashes(KEPT);
        const { out, output } = capture();

        expect(runImageCleanup(['--apply'], output)).toBe(0);

        expect(out.filter((line) => /^Deleted \S+ \(/.test(line))).toHaveLength(9);
        expect(out).toContainEqual(expect.stringMatching(/^Deleted 9 files, \d+ bytes/));
        for (const relativePath of [...SQUARE, STALE_TEMP, DYNAMIC_CACHE]) {
            expect(fs.existsSync(lib.file(relativePath)), relativePath).toBe(false);
        }
        expect(lib.hashes(KEPT)).toEqual(kept);
    });

    it('--apply re-checks each path and skips ones that stopped qualifying', async () => {
        const lib = await libraryWithOrphans();
        const plan = planOrphanCleanup();
        expect(plan.entries).toHaveLength(9);
        expect(plan.youngTempFiles).toEqual([YOUNG_TEMP]);

        // After the plan, square.webp comes back and the stale temp file is written to again
        write(lib, 'square.webp', fs.readFileSync(lib.file('portrait.png')));
        fs.utimesSync(lib.file(STALE_TEMP), new Date(), new Date());

        const result = applyOrphanCleanup(plan);

        expect(result.deleted.map((entry) => entry.relativePath)).toEqual([DYNAMIC_CACHE]);
        expect(result.skipped.map((entry) => entry.relativePath).sort()).toEqual([...SQUARE, STALE_TEMP].sort());
        expect(result.failed).toEqual([]);
        for (const relativePath of [...SQUARE, STALE_TEMP]) {
            expect(fs.existsSync(lib.file(relativePath)), relativePath).toBe(true);
        }
    });

    it('--apply keeps derivatives if every source disappears after the plan', async () => {
        const lib = await libraryWithOrphans();
        const plan = planOrphanCleanup();
        fs.unlinkSync(lib.file('landscape.png'));
        fs.unlinkSync(lib.file('portrait.png'));

        const result = applyOrphanCleanup(plan);

        expect(result.deleted.map((entry) => entry.relativePath).sort()).toEqual([DYNAMIC_CACHE, STALE_TEMP].sort());
        for (const relativePath of SQUARE) expect(fs.existsSync(lib.file(relativePath)), relativePath).toBe(true);
    });

    it('refuses a missing library root, even with --allow-empty-library', async () => {
        const lib = await newLibrary({ missingRoot: true });
        for (const args of [[], ['--apply'], ['--allow-empty-library'], ['--apply', '--allow-empty-library']]) {
            const { err, output } = capture();
            expect(runImageCleanup(args, output), args.join(' ')).toBe(2);
            expect(err.join('\n')).toContain(`Refusing to clean up: library root not found: ${lib.root}`);
        }
        expect(fs.existsSync(lib.root)).toBe(false);
    });

    it('refuses a library with no sources unless --allow-empty-library is passed', async () => {
        const lib = await newLibrary();
        ensureDirectories();
        write(lib, 'optimized/old.webp', 'derivative');

        for (const args of [[], ['--apply']]) {
            const { err, output } = capture();
            expect(runImageCleanup(args, output)).toBe(2);
            expect(err.join('\n')).toContain('has no source photos');
        }
        expect(fs.existsSync(lib.file('optimized/old.webp'))).toBe(true);

        const dryRun = capture();
        expect(runImageCleanup(['--allow-empty-library'], dryRun.output)).toBe(0);
        expect(dryRun.out).toContain('Would delete optimized/old.webp (no source named old.*)');
        expect(fs.existsSync(lib.file('optimized/old.webp'))).toBe(true);

        expect(runImageCleanup(['--apply', '--allow-empty-library'], capture().output)).toBe(0);
        expect(fs.existsSync(lib.file('optimized/old.webp'))).toBe(false);
    });

    it('rejects unknown options with exit code 2', async () => {
        await newLibrary({ fixtures: 'basic' });
        const { err, output } = capture();
        expect(runImageCleanup(['--force'], output)).toBe(2);
        expect(err[0]).toBe('Unknown option: --force');
    });

    it('exits 2 from the command line on a missing root', async () => {
        const lib = await newLibrary({ missingRoot: true });
        const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/imageCleanup.ts', '--apply'], {
            cwd: REPO_ROOT,
            env: { ...process.env, PHOTOGRAPHY_LIBRARY_DIR: lib.root },
            encoding: 'utf8',
        });
        expect(run.status, run.stderr).toBe(2);
        expect(run.stderr).toContain('Refusing to clean up: library root not found');
        expect(fs.existsSync(lib.root)).toBe(false);
    });
});
