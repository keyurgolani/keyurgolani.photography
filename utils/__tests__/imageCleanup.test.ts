// @vitest-environment node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runImageCleanup } from '../../scripts/imageCleanup';
import { createTempLibrary, derivativePaths, type TempLibrary } from '../../test/helpers/tempLibrary';
import {
    applyOrphanCleanup,
    ensureDirectories,
    planOrphanCleanup,
    processImage,
    STALE_TEMP_FILE_MS,
    tempFilePrefix,
} from '../imageOptimizer';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const STALE_TEMP = `thumbnails/${tempFilePrefix('landscape')}4242.0a1b2c3d.tmp`;
const YOUNG_TEMP = `medium/${tempFilePrefix('portrait')}4242.0a1b2c3e.tmp`;
const DYNAMIC_CACHE = 'cache/dynamic/landscape-800-85.webp';

const libraries: TempLibrary[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
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

/** Run a dry run and return the plan hash it printed. */
function dryRunHash(args: string[] = []): string {
    const { out, output } = capture();
    expect(runImageCleanup(args, output)).toBe(0);
    const line = out.find((entry) => entry.startsWith('Plan '));
    const hash = line?.match(/^Plan ([0-9a-f]{12})\./)?.[1];
    if (!hash) throw new Error(`The dry run printed no plan hash:\n${out.join('\n')}`);
    return hash;
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
const PER_PATH = /^(Would delete|Deleted) \S+ \(/;

describe('images:cleanup', { timeout: 30_000 }, () => {
    it('dry run lists every orphan with its reason, prints a plan hash, and deletes nothing', async () => {
        const lib = await libraryWithOrphans();
        const before = lib.hashes([...SQUARE, ...KEPT, STALE_TEMP, DYNAMIC_CACHE]);
        const { out, err, output } = capture();

        expect(runImageCleanup([], output)).toBe(0);

        expect(err).toEqual([]);
        expect(out[0]).toBe(`Library root: ${lib.root}`);
        expect(out.filter((line) => PER_PATH.test(line)).sort()).toEqual([
            `Would delete ${DYNAMIC_CACHE} (unused since /api/image was removed)`,
            ...SQUARE.map((relativePath) => `Would delete ${relativePath} (no source named square.*)`),
            `Would delete ${STALE_TEMP} (stale temp file)`,
        ].sort());
        expect(out).toContainEqual(expect.stringMatching(/^Would delete 9 files, \d+ bytes.*\. This was a dry run\.$/));
        expect(out).toContainEqual(expect.stringMatching(
            /^Plan ([0-9a-f]{12})\. To delete exactly these files, re-run with --apply --plan \1$/,
        ));
        expect(out).toContain('Kept 1 temp file under 10 minutes old, since a running job may still own them.');
        expect(lib.hashes(Object.keys(before))).toEqual(before);
    });

    it('--apply --plan deletes what that dry run listed and nothing else', async () => {
        const lib = await libraryWithOrphans();
        const kept = lib.hashes(KEPT);
        const hash = dryRunHash();
        const { out, output } = capture();

        expect(runImageCleanup(['--apply', '--plan', hash], output)).toBe(0);

        expect(out.filter((line) => PER_PATH.test(line))).toHaveLength(9);
        expect(out).toContainEqual(expect.stringMatching(/^Deleted 9 files, \d+ bytes/));
        for (const relativePath of [...SQUARE, STALE_TEMP, DYNAMIC_CACHE]) {
            expect(fs.existsSync(lib.file(relativePath)), relativePath).toBe(false);
        }
        expect(lib.hashes(KEPT)).toEqual(kept);
    });

    it('--apply refuses without a plan, with a wrong plan, and after the library changed', async () => {
        const lib = await libraryWithOrphans();
        const hash = dryRunHash();
        const before = lib.hashes([...SQUARE, STALE_TEMP, DYNAMIC_CACHE]);

        const noPlan = capture();
        expect(runImageCleanup(['--apply'], noPlan.output)).toBe(2);
        expect(noPlan.err[0]).toBe('--apply needs --plan <hash> from a dry run, so it deletes only what you reviewed.');

        const wrongPlan = capture();
        expect(runImageCleanup(['--apply', '--plan', '000000000000'], wrongPlan.output)).toBe(2);
        expect(wrongPlan.err[0]).toMatch(/^Refusing to clean up: the library changed since the dry run that printed plan 000000000000/);

        // Another photo goes away after the review, so its derivatives would be new deletions
        fs.unlinkSync(lib.file('portrait.png'));
        const changed = capture();
        expect(runImageCleanup(['--apply', '--plan', hash], changed.output)).toBe(2);
        expect(changed.err[0]).toContain(`plan ${hash}`);

        expect(lib.hashes(Object.keys(before))).toEqual(before);
        expect(Object.keys(lib.hashes(derivativePaths('portrait')))).toHaveLength(7);
    });

    it('--only limits the plan and the deletion to one photo', async () => {
        const lib = await libraryWithOrphans();
        fs.unlinkSync(lib.file('portrait.png'));
        write(lib, `optimized/${tempFilePrefix('square')}4242.0a1b2c3f.tmp`, 'partial', Date.now() - STALE_TEMP_FILE_MS - 60_000);
        write(lib, 'cache/dynamic/square-400-80.webp', 'cached');

        const { out, output } = capture();
        expect(runImageCleanup(['--only', 'square.webp'], output)).toBe(0);
        expect(out).toContain('Only files for: square');
        expect(out.filter((line) => PER_PATH.test(line)).sort()).toEqual([
            'Would delete cache/dynamic/square-400-80.webp (unused since /api/image was removed)',
            ...SQUARE.map((relativePath) => `Would delete ${relativePath} (no source named square.*)`),
            `Would delete optimized/${tempFilePrefix('square')}4242.0a1b2c3f.tmp (stale temp file)`,
        ].sort());

        const hash = dryRunHash(['--only', 'square']);
        expect(runImageCleanup(['--only', 'square', '--apply', '--plan', hash], capture().output)).toBe(0);
        for (const relativePath of SQUARE) expect(fs.existsSync(lib.file(relativePath)), relativePath).toBe(false);
        expect(Object.keys(lib.hashes(derivativePaths('portrait')))).toHaveLength(7);
        expect(fs.existsSync(lib.file(STALE_TEMP))).toBe(true);
        expect(fs.existsSync(lib.file(DYNAMIC_CACHE))).toBe(true);
    });

    it('re-checks each path and skips ones that stopped qualifying', async () => {
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

    it('keeps derivatives if every source disappears after the plan', async () => {
        const lib = await libraryWithOrphans();
        const plan = planOrphanCleanup();
        fs.unlinkSync(lib.file('landscape.png'));
        fs.unlinkSync(lib.file('portrait.png'));

        const result = applyOrphanCleanup(plan);

        expect(result.deleted.map((entry) => entry.relativePath).sort()).toEqual([DYNAMIC_CACHE, STALE_TEMP].sort());
        for (const relativePath of SQUARE) expect(fs.existsSync(lib.file(relativePath)), relativePath).toBe(true);
    });

    it('keeps everything if the library can no longer be read', async () => {
        const lib = await libraryWithOrphans();
        const plan = planOrphanCleanup();
        const realReaddirSync = fs.readdirSync;
        vi.spyOn(fs, 'readdirSync').mockImplementation(((target: fs.PathLike, options?: unknown) => {
            if (String(target) === lib.root) throw Object.assign(new Error('EIO: i/o error, scandir'), { code: 'EIO' });
            return (realReaddirSync as (target: fs.PathLike, options?: unknown) => unknown)(target, options);
        }) as unknown as typeof fs.readdirSync);

        const result = applyOrphanCleanup(plan);

        expect(result.deleted).toEqual([]);
        expect(result.skipped).toHaveLength(9);
        for (const entry of plan.entries) expect(fs.existsSync(entry.path), entry.relativePath).toBe(true);
    });

    it('never enters a symlinked folder, so it never deletes outside the library', async () => {
        const lib = await libraryWithOrphans();
        const outside = path.join(path.dirname(lib.root), 'outside');
        fs.mkdirSync(path.join(outside, 'cache-target'), { recursive: true });
        fs.writeFileSync(path.join(outside, 'square.webp'), 'not ours');
        fs.writeFileSync(path.join(outside, 'cache-target', 'square-400-80.webp'), 'not ours either');
        fs.rmSync(lib.file('optimized'), { recursive: true });
        fs.symlinkSync(outside, lib.file('optimized'));
        fs.rmSync(lib.file('cache'), { recursive: true });
        fs.mkdirSync(path.join(outside, 'cache-root'));
        fs.symlinkSync(path.join(outside, 'cache-root'), lib.file('cache'));
        fs.symlinkSync(path.join(outside, 'cache-target'), path.join(outside, 'cache-root', 'dynamic'));

        const { out, output } = capture();
        expect(runImageCleanup([], output)).toBe(0);
        expect(out).toContain('Skipped optimized/, which is a symlink or not a folder, so cleanup stays inside the library.');
        expect(out).toContain('Skipped cache/, which is a symlink or not a folder, so cleanup stays inside the library.');
        expect(out.some((line) => line.includes('optimized/square.webp') || line.includes('square-400-80'))).toBe(false);

        const hash = dryRunHash();
        expect(runImageCleanup(['--apply', '--plan', hash], capture().output)).toBe(0);
        expect(fs.existsSync(path.join(outside, 'square.webp'))).toBe(true);
        expect(fs.existsSync(path.join(outside, 'cache-target', 'square-400-80.webp'))).toBe(true);
    });

    it('matches sources without regard to case, so a case-only rename keeps the derivatives', async () => {
        const lib = await newLibrary({ fixtures: 'basic' });
        await processImage('landscape.jpg');
        fs.renameSync(lib.file('landscape.jpg'), lib.file('tmp-rename.jpg'));
        fs.renameSync(lib.file('tmp-rename.jpg'), lib.file('Landscape.JPG'));

        const plan = planOrphanCleanup();

        expect(plan.entries.filter((entry) => entry.relativePath.includes('landscape'))).toEqual([]);
    });

    it('refuses a missing library root, even with --allow-empty-library', async () => {
        const lib = await newLibrary({ missingRoot: true });
        const plan = ['--apply', '--plan', '000000000000'];
        for (const args of [[], plan, ['--allow-empty-library'], [...plan, '--allow-empty-library']]) {
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
        // An AppleDouble file is not a photo, so it doesn't make the library look populated
        write(lib, '._old.jpg', 'AppleDouble metadata');

        for (const args of [[], ['--apply', '--plan', '000000000000']]) {
            const { err, output } = capture();
            expect(runImageCleanup(args, output)).toBe(2);
            expect(err.join('\n')).toContain('has no source photos');
        }
        expect(fs.existsSync(lib.file('optimized/old.webp'))).toBe(true);

        const dryRun = capture();
        expect(runImageCleanup(['--allow-empty-library'], dryRun.output)).toBe(0);
        expect(dryRun.out).toContain('Would delete optimized/old.webp (no source named old.*)');
        expect(fs.existsSync(lib.file('optimized/old.webp'))).toBe(true);

        const hash = dryRunHash(['--allow-empty-library']);
        expect(runImageCleanup(['--allow-empty-library', '--apply', '--plan', hash], capture().output)).toBe(0);
        expect(fs.existsSync(lib.file('optimized/old.webp'))).toBe(false);
    });

    it('rejects bad options with exit code 2', async () => {
        await newLibrary({ fixtures: 'basic' });
        for (const [args, message] of [
            [['--force'], 'Unknown option: --force'],
            [['--plan', '000000000000'], '--plan goes with --apply.'],
            [['--apply', '--plan', 'short'], '--plan needs the 12-character hash a dry run printed.'],
            [['--only'], '--only needs a photo name, such as landscape or landscape.jpg.'],
            [['--only', '../landscape'], '--only needs a photo name, such as landscape or landscape.jpg.'],
        ] as const) {
            const { err, output } = capture();
            expect(runImageCleanup([...args], output), args.join(' ')).toBe(2);
            expect(err[0]).toBe(message);
        }
    });

    it('exits 2 from the command line on a missing root', async () => {
        const lib = await newLibrary({ missingRoot: true });
        const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/imageCleanup.ts', '--apply', '--plan', '000000000000'], {
            cwd: REPO_ROOT,
            env: { ...process.env, PHOTOGRAPHY_LIBRARY_DIR: lib.root },
            encoding: 'utf8',
        });
        expect(run.status, run.stderr).toBe(2);
        expect(run.stderr).toContain('Refusing to clean up: library root not found');
        expect(fs.existsSync(lib.root)).toBe(false);
    });
});
