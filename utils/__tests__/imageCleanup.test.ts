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

/** landscape.jpg processed, then renamed to Landscape.JPG, a name that differs only in case. */
async function libraryWithCaseRename(): Promise<TempLibrary> {
    const lib = await newLibrary({ fixtures: 'basic' });
    await processImage('landscape.jpg');
    fs.renameSync(lib.file('landscape.jpg'), lib.file('tmp-rename.jpg'));
    fs.renameSync(lib.file('tmp-rename.jpg'), lib.file('Landscape.JPG'));
    return lib;
}

/** Whether the disk under `lib` treats names that differ only in case as one file, as macOS does by default. */
function caseInsensitive(lib: TempLibrary): boolean {
    fs.writeFileSync(lib.file('Case-Probe'), '');
    try {
        return fs.existsSync(lib.file('case-probe'));
    } finally {
        fs.unlinkSync(lib.file('Case-Probe'));
    }
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
        const planLine = out.findIndex((line) => /^Plan [0-9a-f]{12}\. To delete exactly these files, run one of:$/.test(line));
        expect(planLine, out.join('\n')).toBeGreaterThan(-1);
        const hash = out[planLine].slice('Plan '.length, 'Plan '.length + 12);
        expect(out.slice(planLine + 1, planLine + 3)).toEqual([
            `  npm run images:cleanup -- --apply --plan ${hash}`,
            `  npx tsx scripts/imageCleanup.ts --apply --plan ${hash}`,
        ]);
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
        expect(wrongPlan.err[0]).toBe(
            `Refusing to clean up: this run plans ${hash}, not 000000000000. Files may have changed since that dry run, ` +
            'or temp files passed the 10-minute mark. Run the dry run again with the same flags and review it.',
        );

        // Another photo goes away after the review, so its derivatives would be new deletions
        fs.unlinkSync(lib.file('portrait.png'));
        const changed = capture();
        expect(runImageCleanup(['--apply', '--plan', hash], changed.output)).toBe(2);
        expect(changed.err[0]).toMatch(new RegExp(`^Refusing to clean up: this run plans [0-9a-f]{12}, not ${hash}\\.`));

        expect(lib.hashes(Object.keys(before))).toEqual(before);
        expect(Object.keys(lib.hashes(derivativePaths('portrait')))).toHaveLength(7);
    });

    it('--apply refuses once a kept temp file passes the age limit, and says that can be why', async () => {
        const lib = await libraryWithOrphans();
        const hash = dryRunHash();
        // The young temp file from the dry run is now old enough to delete, so the plan grew
        fs.utimesSync(lib.file(YOUNG_TEMP), new Date(Date.now() - STALE_TEMP_FILE_MS - 60_000), new Date(Date.now() - STALE_TEMP_FILE_MS - 60_000));

        const { err, output } = capture();
        expect(runImageCleanup(['--apply', '--plan', hash], output)).toBe(2);
        expect(err[0]).toContain('or temp files passed the 10-minute mark. Run the dry run again');
        expect(fs.existsSync(lib.file(YOUNG_TEMP))).toBe(true);
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

    it("skips a folder it can't list, keeping what is in it, and still plans the rest and a takedown", async () => {
        const lib = await libraryWithOrphans();
        const dynamic = lib.file('cache/dynamic');
        const realReaddirSync = fs.readdirSync;
        vi.spyOn(fs, 'readdirSync').mockImplementation(((target: fs.PathLike, options?: unknown) => {
            if (String(target) === dynamic) throw Object.assign(new Error('EACCES: permission denied, scandir'), { code: 'EACCES' });
            return (realReaddirSync as (target: fs.PathLike, options?: unknown) => unknown)(target, options);
        }) as unknown as typeof fs.readdirSync);

        const plan = planOrphanCleanup();
        expect(plan.skippedFolders).toEqual(['cache/dynamic']);
        expect(plan.entries.map((entry) => entry.relativePath)).not.toContain(DYNAMIC_CACHE);
        expect(plan.entries.map((entry) => entry.relativePath)).toEqual(expect.arrayContaining([STALE_TEMP, ...SQUARE]));

        const { out, output } = capture();
        expect(runImageCleanup(['--only', 'square'], output)).toBe(0);
        expect(out).toContain("Skipped cache/dynamic/, which is a symlink, not a folder, or can't be listed, so cleanup deletes nothing in it.");
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
        expect(out).toContain("Skipped optimized/, which is a symlink, not a folder, or can't be listed, so cleanup deletes nothing in it.");
        expect(out).toContain("Skipped cache/, which is a symlink, not a folder, or can't be listed, so cleanup deletes nothing in it.");
        expect(out.some((line) => line.includes('optimized/square.webp') || line.includes('square-400-80'))).toBe(false);

        const hash = dryRunHash();
        expect(runImageCleanup(['--apply', '--plan', hash], capture().output)).toBe(0);
        expect(fs.existsSync(path.join(outside, 'square.webp'))).toBe(true);
        expect(fs.existsSync(path.join(outside, 'cache-target', 'square-400-80.webp'))).toBe(true);
    });

    it('keeps derivatives for a name that differs only in case when this disk resolves both names to one file', async () => {
        const lib = await libraryWithCaseRename();

        const planned = planOrphanCleanup().entries.filter((entry) => entry.relativePath.includes('landscape'));

        if (caseInsensitive(lib)) {
            // As on macOS: both names are one file here, so the set stays until the
            // watcher regenerates it under the new spelling, Landscape.*
            expect(planned).toEqual([]);
        } else {
            // As on Linux: Landscape.JPG gets its own Landscape.* set, so no source needs landscape.*
            expect(planned.map((entry) => entry.relativePath).sort()).toEqual([...derivativePaths('landscape')].sort());
        }
    });

    it('treats a name that differs only in case as another photo on a case-sensitive disk', async () => {
        const lib = await libraryWithCaseRename();
        // The lowercase name finds nothing, as on a case-sensitive disk, whatever disk this runs on
        const realLstatSync = fs.lstatSync;
        vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
            if (String(target) === lib.file('landscape.JPG')) {
                if (options?.throwIfNoEntry === false) return undefined;
                throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${String(target)}'`), { code: 'ENOENT' });
            }
            return realLstatSync(target, options);
        }) as unknown as typeof fs.lstatSync);

        const planned = planOrphanCleanup().entries.filter((entry) => entry.relativePath.includes('landscape'));

        expect(planned.map((entry) => entry.relativePath).sort()).toEqual([...derivativePaths('landscape')].sort());
        expect(planned.every((entry) => entry.reason === 'no source named landscape.*')).toBe(true);
    });

    it('--only matches the exact name and hints at names that differ only in case', async () => {
        const lib = await newLibrary({ fixtures: 'basic' });
        await processImage('landscape.jpg');
        fs.unlinkSync(lib.file('landscape.jpg'));

        const variant = capture();
        expect(runImageCleanup(['--only', 'Landscape'], variant.output)).toBe(0);
        expect(variant.out.filter((line) => PER_PATH.test(line))).toEqual([]);
        expect(variant.out).toContain(
            'No file is named exactly Landscape, but landscape differs only in case or Unicode form. --only matches the exact name.',
        );
        expect(variant.out).toContain('Nothing to delete.');

        const exact = capture();
        expect(runImageCleanup(['--only', 'landscape'], exact.output)).toBe(0);
        expect(exact.out.filter((line) => PER_PATH.test(line))).toHaveLength(7);
        expect(exact.out.some((line) => line.startsWith('No file is named exactly'))).toBe(false);
    });

    it('quotes the --only name in the printed commands, so it survives the shell', async () => {
        const lib = await newLibrary({ fixtures: 'basic' });
        const name = "it's $HOME";
        fs.copyFileSync(lib.file('landscape.jpg'), lib.file(`${name}.jpg`));
        await processImage(`${name}.jpg`);
        fs.unlinkSync(lib.file(`${name}.jpg`));

        const { out, output } = capture();
        expect(runImageCleanup(['--only', name], output)).toBe(0);
        const npmLine = out.find((line) => line.startsWith('  npm run images:cleanup -- '));
        const quoted = npmLine?.match(/ --only=(.+) --apply --plan [0-9a-f]{12}$/)?.[1];
        expect(quoted, out.join('\n')).toBeDefined();

        const echoed = spawnSync('sh', ['-c', `printf '%s' ${quoted}`], { encoding: 'utf8' });
        expect(echoed.stdout).toBe(name);
    });

    it('quotes a name that starts with =, and takes one that starts with a dash as --only=<name>', async () => {
        const lib = await newLibrary({ fixtures: 'basic' });
        for (const name of ['=odd', '-dash']) {
            fs.copyFileSync(lib.file('landscape.jpg'), lib.file(`${name}.jpg`));
            await processImage(`${name}.jpg`);
            fs.unlinkSync(lib.file(`${name}.jpg`));
        }

        const equals = capture();
        expect(runImageCleanup(['--only', '=odd'], equals.output)).toBe(0);
        expect(equals.out).toContainEqual(expect.stringMatching(/^ {2}npm run images:cleanup -- --only='=odd' --apply --plan [0-9a-f]{12}$/));

        const dash = capture();
        expect(runImageCleanup(['--only=-dash'], dash.output)).toBe(0);
        expect(dash.out.filter((line) => PER_PATH.test(line))).toHaveLength(7);
        expect(dash.out).toContainEqual(expect.stringMatching(/^ {2}npx tsx scripts\/imageCleanup\.ts --only=-dash --apply --plan [0-9a-f]{12}$/));
    });

    it('--only matches an exact base name first, then one without a source extension', async () => {
        const lib = await newLibrary({ fixtures: 'basic' });
        // notes.jpg.png has the base notes.jpg, and notes.png the base notes
        for (const name of ['notes.jpg.png', 'notes.png']) {
            fs.copyFileSync(lib.file('portrait.png'), lib.file(name));
            await processImage(name);
            fs.unlinkSync(lib.file(name));
        }

        const exact = capture();
        expect(runImageCleanup(['--only', 'notes.jpg'], exact.output)).toBe(0);
        expect(exact.out).toContain('Only files for: notes.jpg');
        expect(exact.out.filter((line) => PER_PATH.test(line)).sort()).toEqual(
            derivativePaths('notes.jpg').map((relativePath) => `Would delete ${relativePath} (no source named notes.jpg.*)`).sort(),
        );

        const stripped = capture();
        expect(runImageCleanup(['--only', 'notes.png'], stripped.output)).toBe(0);
        expect(stripped.out).toContain('Only files for: notes');
        expect(stripped.out.filter((line) => PER_PATH.test(line)).sort()).toEqual(
            derivativePaths('notes').map((relativePath) => `Would delete ${relativePath} (no source named notes.*)`).sort(),
        );
    });

    it('--only plans a set a sibling shares, and says the watcher rebuilds it from the sibling', async () => {
        const lib = await newLibrary({ fixtures: 'basic' });
        // a.jpg is taken down, and a.png, a different photo with the same base, stays
        fs.copyFileSync(lib.file('landscape.jpg'), lib.file('a.jpg'));
        await processImage('a.jpg');
        fs.unlinkSync(lib.file('a.jpg'));
        fs.copyFileSync(lib.file('portrait.png'), lib.file('a.png'));
        expect(planOrphanCleanup().entries.filter((entry) => entry.relativePath.includes('/a.'))).toEqual([]);

        const { out, output } = capture();
        expect(runImageCleanup(['--only', 'a'], output)).toBe(0);
        expect(out.filter((line) => PER_PATH.test(line)).sort()).toEqual(
            derivativePaths('a').map((relativePath) => `Would delete ${relativePath} (rebuilt from a.png when the watcher starts)`).sort(),
        );

        const hash = dryRunHash(['--only', 'a']);
        expect(runImageCleanup(['--only', 'a', '--apply', '--plan', hash], capture().output)).toBe(0);
        expect(lib.hashes(derivativePaths('a'))).toEqual({});
        expect(fs.existsSync(lib.file('a.png'))).toBe(true);
    });

    it('--only names the other sets with no source, which may be earlier names of the photo', async () => {
        const lib = await libraryWithOrphans();
        fs.unlinkSync(lib.file('portrait.png'));

        const { out, output } = capture();
        expect(runImageCleanup(['--only', 'portrait'], output)).toBe(0);

        expect(out).toContain(
            'Other sets with no source, which may be earlier names of this photo: square. The dry run without --only lists their files.',
        );
    });

    it("keeps the set of a source it can see but can't read, and lists that source", async () => {
        const lib = await libraryWithOrphans();
        // A dangling symlink: lstat sees it, stat can't follow it
        fs.unlinkSync(lib.file('portrait.png'));
        fs.symlinkSync(lib.file('missing-target.png'), lib.file('portrait.png'));

        const { out, output } = capture();
        expect(runImageCleanup([], output)).toBe(0);

        expect(out.filter((line) => PER_PATH.test(line) && line.includes('portrait'))).toEqual([]);
        expect(out).toContain("Kept the set for portrait.png, a source that can't be read (ENOENT).");
        expect(Object.keys(lib.hashes(derivativePaths('portrait')))).toHaveLength(7);
    });

    it("keeps a set when lstat can't tell whether two spellings are one file", async () => {
        const lib = await libraryWithCaseRename();
        const realLstatSync = fs.lstatSync;
        vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
            if (String(target) === lib.file('landscape.JPG')) {
                throw Object.assign(new Error(`EACCES: permission denied, lstat '${String(target)}'`), { code: 'EACCES' });
            }
            return realLstatSync(target, options);
        }) as unknown as typeof fs.lstatSync);

        expect(planOrphanCleanup().entries.filter((entry) => entry.relativePath.includes('landscape'))).toEqual([]);
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
            [['--force'], "Unknown option '--force'"],
            [['--plan', '000000000000'], '--plan goes with --apply.'],
            [['--apply', '--plan', 'short'], '--plan needs the 12-character hash a dry run printed.'],
            [['--only'], "Option '--only <value>' argument missing"],
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
