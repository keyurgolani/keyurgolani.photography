// @vitest-environment node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixtureFiles } from '../../../test/fixtures/makeLibrary';
import { runTsx } from '../../../test/helpers/runTsx';
import { createTempDataRoot, writeDataRootMarker, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { UnsupportedSchemaError } from '../../storage/document';
import { PHOTO_ID_RE, sha256, type Hasher } from '../ids';
import { DryRunRefusedError, migrateDryRun, REPORT_SECTIONS, type DryRunOptions } from '../migration';
import { runReconcilePass } from '../pass';
import { identityPaths } from '../registry';
import { sequentialIds } from './reconcileFixtures';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isRoot = process.getuid?.() === 0;

let fixtures: Map<string, Buffer>;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
    fixtures = await fixtureFiles({ extras: true });
});

afterEach(async () => {
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(name: string): Buffer {
    const bytes = fixtures.get(name);
    if (!bytes) throw new Error(`No fixture ${name}`);
    return bytes;
}

async function library(files: Record<string, Buffer | string>): Promise<TempLibrary> {
    const lib = await createTempLibrary();
    cleanups.push(() => lib.cleanup());
    for (const [relativePath, bytes] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(lib.file(relativePath)), { recursive: true });
        fs.writeFileSync(lib.file(relativePath), bytes);
    }
    return lib;
}

function dataRoot(state: 'ready' | 'uninitialized' | 'missing' = 'ready'): TempDataRoot {
    const data = createTempDataRoot({ state });
    cleanups.push(() => data.cleanup());
    return data;
}

function tempOut(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photography-out-'));
    cleanups.push(() => fs.promises.rm(dir, { recursive: true, force: true }));
    return path.join(dir, 'migration');
}

/** Every file and folder under `root` with a hash of each file, to prove a run changed nothing else. */
function tree(root: string): Record<string, string> {
    if (!fs.existsSync(root)) return {};
    const result: Record<string, string> = {};
    for (const relativePath of fs.readdirSync(root, { recursive: true, encoding: 'utf8' }).sort()) {
        const absolute = path.join(root, relativePath);
        const stat = fs.lstatSync(absolute);
        result[relativePath] = stat.isFile()
            ? `${createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')} ${stat.mtimeMs}`
            : 'dir';
    }
    return result;
}

const options = (extra: DryRunOptions = {}): DryRunOptions => ({
    // Files written just now would still be settling, so the run happens a minute later.
    clock: () => Date.now() + 60_000,
    idGen: sequentialIds(),
    ...extra,
});

describe('photos:migrate --dry-run', () => {
    it('lists top-level base names that differ only by case or Unicode form as basename collisions', async () => {
        await library({
            'Beach.jpg': fixture('landscape.jpg'),
            'beach.png': fixture('portrait.png'),
            // café in NFC, then in NFD.
            'café.jpg': fixture('landscape-edited.jpg'),
            'cafe\u0301.webp': fixture('square.webp'),
            'series/Beach.webp': fixture('landscape-rot6.jpg'),
        });
        // Unset in production, so the dry run reads no data root, not <cwd>/portfolio-data.
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
        vi.stubEnv('NODE_ENV', 'production');

        const { report } = await migrateDryRun(options({ outDir: tempOut() }));
        const lines = report.split('## Basename collisions\n')[1].split('\n## ')[0].split('\n').filter((line) => line.startsWith('- '));
        expect(lines).toHaveLength(2);
        expect(lines).toContain('- `Beach.jpg`, `beach.png`');
        expect(lines.find((line) => line.includes('`café.jpg`'))).toContain('`cafe\u0301.webp`');
    });

    it('writes only its plan and report to --out, and the report lists every migration category', async () => {
        const lib = await library({
            'landscape.jpg': fixture('landscape.jpg'),
            'copies/landscape again.jpg': fixture('landscape.jpg'),
            'square.webp': fixture('square.webp'),
            'square.jpg': fixture('landscape-edited.jpg'),
            'landscape-rot6.jpg': fixture('landscape-rot6.jpg'),
            'corrupt.jpg': fixture('corrupt.jpg'),
            'raw/IMG_0001.heic': 'not a real heic',
            'series/thumbnails/kept.jpg': fixture('portrait.png'),
            'thumbnails/landscape.webp': 'legacy derivative, skipped',
        });
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
        vi.stubEnv('NODE_ENV', 'production');
        const out = tempOut();
        const libraryBefore = tree(lib.root);

        const result = await migrateDryRun(options({ outDir: out }));

        expect(tree(lib.root)).toEqual(libraryBefore);
        expect(fs.readdirSync(out).sort()).toEqual([path.basename(result.planPath), path.basename(result.reportPath)].sort());
        expect(path.basename(result.planPath)).toMatch(/^plan-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/);
        expect(path.basename(result.reportPath)).toBe(path.basename(result.planPath).replace(/^plan-(.*)\.json$/, 'report-$1.md'));
        expect(fs.readFileSync(result.reportPath, 'utf8')).toBe(result.report);
        expect(JSON.parse(fs.readFileSync(result.planPath, 'utf8'))).toEqual(result.plan);
        // Both name every library path, so only their owner can read them.
        const mode = (file: string) => fs.statSync(file).mode & 0o777;
        expect([mode(out), mode(result.planPath), mode(result.reportPath)]).toEqual([0o700, 0o600, 0o600]);

        const headings = result.report.split('\n').filter((line) => line.startsWith('## ')).map((line) => line.slice(3));
        expect(headings).toEqual([...REPORT_SECTIONS]);
        const sectionOf = (title: string) => result.report.split(`## ${title}\n`)[1].split('\n## ')[0];
        expect(sectionOf('Fact counts')).toContain('| new | 7 |');
        expect(sectionOf('Fact counts')).toContain('| processing-failed | 2 |');
        expect(sectionOf('Duplicate-byte groups')).toContain('`copies/landscape again.jpg`, `landscape.jpg`');
        expect(sectionOf('Basename collisions')).toContain('`square.jpg`, `square.webp`');
        expect(sectionOf('Unsupported files')).toContain('`raw/IMG_0001.heic`');
        expect(sectionOf('Orientation-tagged files')).toContain('`landscape-rot6.jpg`: orientation 6');
        expect(sectionOf('Undecodable files')).toContain('`corrupt.jpg`');
        expect(sectionOf('Unreadable files')).toContain('None.');
        expect(sectionOf('Ambiguous items')).toContain('None.');
        expect(sectionOf('Files still changing')).toContain('None.');
        expect(result.report).toContain('(unset)');

        const { plan } = result;
        expect(plan).toMatchObject({ schemaVersion: 1, dataRoot: null, dataRootState: 'unset', registryVersion: 0, libraryRoot: lib.root });
        expect(plan.planId).toMatch(UUID);
        expect(plan.photos).toHaveLength(7);
        for (const photo of plan.photos) {
            expect(photo.photoId).toMatch(PHOTO_ID_RE);
            expect(photo.status).toBe('new');
        }
        expect(plan.photos.find((photo) => photo.path === 'copies/landscape again.jpg')?.duplicateOf).toBeUndefined();
        expect(plan.photos.find((photo) => photo.path === 'landscape.jpg')?.duplicateOf)
            .toBe(plan.photos.find((photo) => photo.path === 'copies/landscape again.jpg')?.photoId);
        expect(plan.sources.map((source) => source.path)).toEqual([
            'copies/landscape again.jpg', 'corrupt.jpg', 'landscape-rot6.jpg', 'landscape.jpg', 'raw/IMG_0001.heic', 'series/thumbnails/kept.jpg', 'square.jpg', 'square.webp',
        ]);
        expect(plan.sources.every((source) => source.assetRevision?.startsWith('sha256-'))).toBe(true);
    });

    it('lists only the top-level orientation-tagged photos, the ones the rebuild turns upright', async () => {
        await library({ 'landscape-rot6.jpg': fixture('landscape-rot6.jpg'), 'series/rot6.jpg': fixture('landscape-rot6.jpg') });
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
        vi.stubEnv('NODE_ENV', 'production');

        const { report } = await migrateDryRun(options({ outDir: tempOut() }));
        const section = report.split('## Orientation-tagged files\n')[1].split('\n## ')[0];
        expect(section).toContain('`landscape-rot6.jpg`: orientation 6');
        expect(section).not.toContain('series/rot6.jpg');
    });

    it.skipIf(isRoot)("lists the top-level photos it couldn't read, or that were still changing, as not checked for orientation", async () => {
        const lib = await library({
            'incoming.jpg': fixture('landscape-rot6.jpg'),
            'unreadable.jpg': fixture('landscape-rot6.jpg'),
            'series/rot6.jpg': fixture('landscape-rot6.jpg'),
        });
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
        vi.stubEnv('NODE_ENV', 'production');
        // Modified right when the run looks, so it counts as still being written
        const looked = new Date(Date.now() + 60_000);
        fs.utimesSync(lib.file('incoming.jpg'), looked, looked);
        fs.chmodSync(lib.file('unreadable.jpg'), 0o000);
        try {
            const { report } = await migrateDryRun(options({ outDir: tempOut(), sleep: async () => undefined }));
            const section = report.split('## Orientation-tagged files\n')[1].split('\n## ')[0];
            expect(section.trim().split('\n')).toEqual([
                'None among the photos it read.',
                '',
                "Not checked, since they couldn't be read or were still changing:",
                '',
                '- `incoming.jpg`',
                '- `unreadable.jpg`',
            ]);
        } finally {
            fs.chmodSync(lib.file('unreadable.jpg'), 0o644);
        }
    });

    it('escapes a pipe in a path, so the Proposed photo IDs table keeps its columns', async () => {
        await library({ 'a|b.jpg': fixture('landscape.jpg') });
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
        vi.stubEnv('NODE_ENV', 'production');

        const result = await migrateDryRun(options({ outDir: tempOut() }));

        const [photo] = result.plan.photos;
        expect(result.report.split('\n')).toContain(`| \`a\\|b.jpg\` | \`${photo.photoId}\` |  |`);
    });

    it('writes into identity/migration/ of a usable data root and nothing else there', async () => {
        await library({ 'landscape.jpg': fixture('landscape.jpg') });
        const data = dataRoot('uninitialized');
        const result = await migrateDryRun(options());
        expect(path.dirname(result.planPath)).toBe(identityPaths(data.root).migration);
        expect(data.files()).toEqual([
            `identity/migration/${path.basename(result.planPath)}`,
            `identity/migration/${path.basename(result.reportPath)}`,
        ]);
        expect(result.plan.dataRootState).toBe('uninitialized');
    });

    it('requires --out when the data root is missing, and creates nothing', async () => {
        await library({ 'landscape.jpg': fixture('landscape.jpg') });
        const data = dataRoot('missing');
        const error = await migrateDryRun(options()).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(DryRunRefusedError);
        expect((error as DryRunRefusedError).exitCode).toBe(2);
        expect((error as Error).message).toMatch(/--out <dir> is required because the data root is unavailable/);
        expect(fs.existsSync(data.root)).toBe(false);
    });

    it.skipIf(isRoot)('requires --out when the data root is unwritable', async () => {
        await library({ 'landscape.jpg': fixture('landscape.jpg') });
        const data = dataRoot();
        fs.chmodSync(data.root, 0o555);
        await expect(migrateDryRun(options())).rejects.toThrow(/data root is unwritable/);
        const out = tempOut();
        const result = await migrateDryRun(options({ outDir: out }));
        expect(path.dirname(result.planPath)).toBe(out);
        expect(data.files()).toEqual(['data-root.json']);
    });

    it('refuses an --out inside the library or public/, and writes nothing', async () => {
        const lib = await library({ 'landscape.jpg': fixture('landscape.jpg') });
        dataRoot('missing');
        const libraryBefore = tree(lib.root);
        for (const out of [lib.file('reports'), lib.root]) {
            const error = await migrateDryRun(options({ outDir: out })).catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(DryRunRefusedError);
            expect(error).toMatchObject({ exitCode: 2, message: expect.stringContaining(`is inside ${lib.root}`) });
        }
        expect(tree(lib.root)).toEqual(libraryBefore);

        // public/ under a temp working directory, so the repository's own public/ is never touched.
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'photography-cwd-'));
        cleanups.push(() => fs.promises.rm(cwd, { recursive: true, force: true }));
        const spy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
        cleanups.push(async () => spy.mockRestore());
        const error = await migrateDryRun(options({ outDir: path.join(cwd, 'public', 'reports') })).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ name: 'DryRunRefusedError', exitCode: 2, message: expect.stringContaining(`is inside ${path.join(cwd, 'public')}`) });
        expect(fs.readdirSync(cwd)).toEqual([]);
    });

    it('refuses, even with --out, a data root or registry written by a newer build', async () => {
        await library({ 'landscape.jpg': fixture('landscape.jpg') });
        const data = dataRoot();
        const out = tempOut();
        writeDataRootMarker(data.root, { schemaVersion: 2 });
        await expect(migrateDryRun(options({ outDir: out }))).rejects.toMatchObject({ name: 'DryRunRefusedError', exitCode: 1 });

        writeDataRootMarker(data.root);
        fs.mkdirSync(identityPaths(data.root).dir);
        fs.writeFileSync(identityPaths(data.root).registry, JSON.stringify({ schemaVersion: 2, version: 3 }));
        await expect(migrateDryRun(options({ outDir: out }))).rejects.toBeInstanceOf(UnsupportedSchemaError);
        expect(fs.existsSync(out)).toBe(false);
    });

    it('keeps existing IDs, reports zero facts after a committed pass, and leaves the registry alone', async () => {
        await library({ 'landscape.jpg': fixture('landscape.jpg'), 'portrait.png': fixture('portrait.png'), 'raw/a.heic': 'raw' });
        const data = dataRoot();
        const pass = await runReconcilePass({ clock: () => Date.now() + 60_000, idGen: sequentialIds(500) });
        expect(pass.status).toBe('committed');
        const before = tree(data.root);

        const result = await migrateDryRun(options());
        expect(result.plan.facts).toEqual([]);
        expect(result.plan.registryVersion).toBe(1);
        expect(result.plan.photos.map((photo) => photo.status)).toEqual(['existing', 'existing']);
        const after = tree(data.root);
        for (const [relativePath, digest] of Object.entries(before)) expect(after[relativePath], relativePath).toBe(digest);
        expect(Object.keys(after).filter((relativePath) => !(relativePath in before)).sort()).toEqual([
            path.join('identity', 'migration'),
            path.join('identity', 'migration', path.basename(result.planPath)),
            path.join('identity', 'migration', path.basename(result.reportPath)),
        ].sort());
    });

    it('lists ambiguous evidence: a file matching two missing duplicates', async () => {
        const lib = await library({ 'a.jpg': fixture('landscape.jpg'), 'b.jpg': fixture('landscape.jpg') });
        dataRoot();
        const commit = (start: number) => runReconcilePass({ clock: () => Date.now() + 60_000, idGen: sequentialIds(start) });
        const first = await commit(100);
        const ids = first.status === 'committed' ? Object.keys(first.registry.photos).sort() : [];
        fs.rmSync(lib.file('a.jpg'));
        fs.rmSync(lib.file('b.jpg'));
        await commit(200);
        fs.writeFileSync(lib.file('c.jpg'), fixture('landscape.jpg'));

        const result = await migrateDryRun(options());
        expect(result.plan.holds).toMatchObject([{ path: 'c.jpg', candidates: ids }]);
        expect(result.report.split('## Ambiguous items\n')[1]).toContain(`\`c.jpg\` is held. Candidates: \`${ids[0]}\`, \`${ids[1]}\`.`);
        expect(result.report).toContain('| ambiguous | 1 |');
    });

    it.skipIf(isRoot)('lists a folder it cannot list in the plan and the Unreadable section', async () => {
        const lib = await library({ 'landscape.jpg': fixture('landscape.jpg'), 'series/a.jpg': fixture('portrait.png') });
        dataRoot('missing');
        fs.chmodSync(lib.file('series'), 0o000);
        try {
            const result = await migrateDryRun(options({ outDir: tempOut() }));
            expect(result.plan.unreadableFolders).toEqual(['series']);
            expect(result.plan.sources.map((source) => source.path)).toEqual(['landscape.jpg']);
            expect(result.report.split('## Unreadable files\n')[1].split('\n## ')[0])
                .toContain("- `series/`: this folder can't be listed, so none of its files are in this plan.");
        } finally {
            fs.chmodSync(lib.file('series'), 0o755);
        }
    });

    it('keeps the failures it found while it waited for a file still being written', async () => {
        const lib = await library({
            'raw.dng': 'not a real dng',
            'landscape.jpg': fixture('landscape.jpg'),
            'portrait.png': fixture('portrait.png'),
            'incoming.jpg': fixture('landscape-edited.jpg'),
        });
        dataRoot('missing');
        // portrait.png's bytes get landscape.jpg's digest, though their sizes differ.
        const real = (name: string) => sha256([fixture(name)]);
        const hasher: Hasher = (chunks) => {
            const digest = sha256(chunks);
            return chunks.length === 1 && digest === real('portrait.png') ? real('landscape.jpg') : digest;
        };
        let now = Date.now() + 60_000;
        fs.utimesSync(lib.file('incoming.jpg'), new Date(now), new Date(now));
        const sleeps: number[] = [];
        const result = await migrateDryRun({
            outDir: tempOut(),
            idGen: sequentialIds(),
            hasher,
            clock: () => now,
            sleep: async (ms) => {
                sleeps.push(ms);
                now += ms + 1_000;
            },
        });

        expect(sleeps).toEqual([5_000]);
        expect(result.plan.facts.map((fact) => [fact.type, fact.reason ?? '', fact.path].join(' ')).sort()).toEqual([
            'new  incoming.jpg',
            'processing-failed digest-collision landscape.jpg',
            'processing-failed digest-collision portrait.png',
            'processing-failed unsupported-format raw.dng',
        ]);
        expect(result.report).toContain('| processing-failed | 3 |');
        expect(result.report.split('## Files still changing\n')[1]).toContain('None.');
    });

    it('waits a bounded time for files still being written, then reports them', async () => {
        await library({ 'incoming.jpg': fixture('landscape.jpg') });
        dataRoot('missing');
        const sleeps: number[] = [];
        const result = await migrateDryRun({
            outDir: tempOut(),
            clock: Date.now,
            settleMs: 10_000,
            sleep: async (ms) => { sleeps.push(ms); },
        });
        expect(sleeps).toEqual([5_000, 5_000]);
        expect(result.plan.sources).toEqual([{ path: 'incoming.jpg', size: fixture('landscape.jpg').length, assetRevision: null }]);
        expect(result.report.split('## Files still changing\n')[1]).toContain('`incoming.jpg`');
    });
});

describe('scripts/photos.ts', { timeout: 120_000 }, () => {
    it('migrate --dry-run prints both paths and exits 0', async () => {
        const lib = await library({ 'landscape.jpg': fixture('landscape.jpg'), 'portrait.png': fixture('portrait.png') });
        const out = tempOut();
        const run = await runTsx('scripts/photos.ts', ['migrate', '--dry-run', '--out', out], {
            env: { PHOTOGRAPHY_LIBRARY_DIR: lib.root, PHOTOGRAPHY_DATA_DIR: path.join(out, '..', 'no-data-root') },
        });
        expect(run.code, run.stderr).toBe(0);
        const planPath = run.stdout.match(/^Plan: (.+)$/m)?.[1];
        const reportPath = run.stdout.match(/^Report: (.+)$/m)?.[1];
        expect(planPath && fs.existsSync(planPath)).toBe(true);
        expect(reportPath && fs.existsSync(reportPath)).toBe(true);
        expect(run.stdout).toContain('new 2');
    });

    it('migrate --dry-run takes --out=<dir> too', async () => {
        const lib = await library({ 'landscape.jpg': fixture('landscape.jpg') });
        const out = tempOut();
        const run = await runTsx('scripts/photos.ts', ['migrate', '--dry-run', `--out=${out}`], {
            env: { PHOTOGRAPHY_LIBRARY_DIR: lib.root, PHOTOGRAPHY_DATA_DIR: path.join(out, '..', 'no-data-root') },
        });
        expect(run.code, run.stderr).toBe(0);
        expect(run.stdout).toContain(`Plan: ${out}`);
    });

    it.each([
        [['migrate'], /only with --dry-run/],
        [['migrate', '--dry-run', '--out'], /Option '--out <value>' argument missing/],
        [['migrate', '--dry-run', '--out='], /--out needs a value/],
        [['migrate', '--dry-run', '--out', '--json'], /Option '--out' argument is ambiguous/],
        [['migrate', '--dry-run', '--apply'], /Unknown option '--apply'/],
        [['migrate', '--dry-run', 'extra'], /Unexpected argument 'extra'/],
        [['identity', 'status', '--verbose'], /Unknown option '--verbose'/],
        [['identity', 'status', 'extra'], /Unexpected argument 'extra'/],
        [['identity', 'bind'], /Unknown identity command/],
        [[], /No command given/],
    ])('exits 2 with usage for %j', async (args, message) => {
        const run = await runTsx('scripts/photos.ts', args);
        expect(run.code).toBe(2);
        expect(run.stderr).toMatch(message);
        expect(run.stderr).toContain('Usage:');
    });

    it('exits 1 without writing anything when the library root is missing', async () => {
        const out = tempOut();
        const run = await runTsx('scripts/photos.ts', ['migrate', '--dry-run', '--out', out], {
            env: { PHOTOGRAPHY_LIBRARY_DIR: path.join(out, '..', 'not-mounted'), PHOTOGRAPHY_DATA_DIR: path.join(out, '..', 'no-data-root') },
        });
        expect(run.code).toBe(1);
        expect(run.stderr).toContain('Library root not found');
        expect(fs.existsSync(out)).toBe(false);
    });

    it('identity status --json reports a ready data root and exits 0, and an unset one exits 1', async () => {
        const lib = await library({ 'landscape.jpg': fixture('landscape.jpg') });
        const data = dataRoot();
        await runReconcilePass({ clock: () => Date.now() + 60_000, idGen: sequentialIds() });
        const ready = await runTsx('scripts/photos.ts', ['identity', 'status', '--json'], { env: { PHOTOGRAPHY_LIBRARY_DIR: lib.root, PHOTOGRAPHY_DATA_DIR: data.root } });
        expect(ready.code, ready.stderr).toBe(0);
        expect(JSON.parse(ready.stdout)).toMatchObject({
            dataRoot: { state: 'ready', root: data.root },
            registry: { version: 1 },
            photos: { total: 1, bySourceHealth: { present: 1, missing: 0, ambiguous: 0, archived: 0 } },
            holds: [],
            failedProfiles: [],
            pendingJobs: 1,
            pendingFacts: 1,
            watcher: null,
        });

        const unset = await runTsx('scripts/photos.ts', ['identity', 'status'], { env: { PHOTOGRAPHY_DATA_DIR: '', NODE_ENV: 'production' } });
        expect(unset.code).toBe(1);
        expect(unset.stdout).toContain('Data root: not set (unset');
    });
});
