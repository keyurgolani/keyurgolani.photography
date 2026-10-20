// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runTsx } from '../../../test/helpers/runTsx';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { getImagePaths } from '../../../utils/imageOptimizer';
import { DATA_ROOT_FILE, dataRootState } from '../../storage/config';
import { withLock } from '../../storage/lock';
import { ApplyRefusedError, legacyUrls, migrateApply, type AppliedMapping, type ApplyOptions } from '../apply';
import { migrateDryRun } from '../migration';
import { runReconcilePass } from '../pass';
import { identityPaths, readRegistry } from '../registry';
import { sequentialIds } from './reconcileFixtures';

const isRoot = process.getuid?.() === 0;
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
/** Files written just now count as settled an hour from now. */
const later = () => Date.now() + 3_600_000;
const APPLIED_AT = Date.parse('2026-07-01T08:00:00.000Z');

let images: Buffer[];
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
    images = await Promise.all([30, 90, 150, 210].map((r) => sharp({ create: { width: 48, height: 32, channels: 3, background: { r, g: 120, b: 255 - r } } }).png().toBuffer()));
});

afterEach(async () => {
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Setup {
    lib: TempLibrary;
    data: TempDataRoot;
    planPath: string;
    plan: Awaited<ReturnType<typeof migrateDryRun>>['plan'];
    apply(options?: Partial<ApplyOptions>): ReturnType<typeof migrateApply>;
}

/** A library of `files` (name to image index), a data root, and a dry-run plan for them. */
async function setup(files: Record<string, number>, { state = 'uninitialized' as 'uninitialized' | 'ready' } = {}): Promise<Setup> {
    const lib = await createTempLibrary();
    cleanups.push(() => lib.cleanup());
    const data = createTempDataRoot({ state });
    cleanups.push(() => data.cleanup());
    for (const [file, index] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(lib.file(file)), { recursive: true });
        fs.writeFileSync(lib.file(file), images[index]);
    }
    const dryRun = await migrateDryRun({ clock: later, logger: quiet });
    const apply = (options: Partial<ApplyOptions> = {}) => migrateApply({ planPath: dryRun.planPath, clock: later, appliedAt: () => APPLIED_AT, idGen: sequentialIds(700), logger: quiet, dockerenvPath: path.join(data.root, '..', 'no-dockerenv'), ...options });
    return { lib, data, planPath: dryRun.planPath, plan: dryRun.plan, apply };
}

const mappingOf = (data: TempDataRoot, file: string): AppliedMapping => JSON.parse(fs.readFileSync(file, 'utf8')) as AppliedMapping;

/** Rewrite the setup's plan file through `change`, and return its path. */
function edit(s: Setup, change: (plan: Record<string, unknown>) => Record<string, unknown>): string {
    fs.writeFileSync(s.planPath, JSON.stringify(change(JSON.parse(fs.readFileSync(s.planPath, 'utf8')) as Record<string, unknown>)));
    return s.planPath;
}

describe('migrateApply', () => {
    it('writes a registry with exactly the plan IDs, initializes the data root, and maps paths and legacy URLs', async () => {
        const s = await setup({ 'x.jpg': 0, 'x.png': 1, 'y.jpg': 2, 'series/z.jpg': 3 });
        const before = s.data.files();
        const result = await s.apply();
        expect(result).toMatchObject({ status: 'applied', planId: s.plan.planId, photos: 4 });

        const registry = await readRegistry(s.data.root);
        const byPath = Object.fromEntries(Object.values(registry.photos).map((photo) => [photo.source.path, photo]));
        expect(Object.keys(registry.photos).sort()).toEqual(s.plan.photos.map((photo) => photo.photoId).sort());
        for (const planned of s.plan.photos) {
            expect(byPath[planned.path]).toMatchObject({ photoId: planned.photoId, sourceHealth: 'present', source: { observedRevision: planned.assetRevision } });
        }
        // Every migrated photo is new to the ledger, and the facts wait for the watcher to deliver them.
        expect(registry.pendingFacts.map((fact) => `${fact.type} ${fact.path}`).sort()).toEqual(['new series/z.jpg', 'new x.jpg', 'new x.png', 'new y.jpg']);
        expect(registry.pendingFacts.map((fact) => fact.factId)).toEqual(['00000000-0000-4000-8000-000000000700', '00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000702', '00000000-0000-4000-8000-000000000703']);

        expect(dataRootState({ write: true })).toBe('ready');
        expect(JSON.parse(fs.readFileSync(s.data.file(DATA_ROOT_FILE), 'utf8'))).toEqual({ schemaVersion: 1, initializedAt: '2026-07-01T08:00:00.000Z' });

        // No derivatives: the worker builds them.
        expect(fs.existsSync(s.data.file('assets'))).toBe(false);
        expect(s.data.files().filter((file) => !before.includes(file)).sort()).toEqual([
            DATA_ROOT_FILE,
            'identity/migration/applied-2026-07-01T08-00-00-000Z.json',
            'identity/registry.json',
            'identity/stat-cache.json',
        ]);

        const mapping = mappingOf(s.data, result.status === 'applied' ? result.mappingPath : '');
        const ids = (file: string) => ({ photoId: byPath[file].photoId, assetRevision: byPath[file].source.observedRevision });
        expect(mapping).toMatchObject({ schemaVersion: 1, planId: s.plan.planId, appliedAt: '2026-07-01T08:00:00.000Z' });
        expect(mapping.paths).toEqual({ 'series/z.jpg': ids('series/z.jpg'), 'x.jpg': ids('x.jpg'), 'x.png': ids('x.png'), 'y.jpg': ids('y.jpg') });
        const yUrls = legacyUrls('y.jpg');
        expect(Object.keys(mapping.urls).sort()).toEqual(['/assets/photos/series/z.jpg', '/assets/photos/x.jpg', '/assets/photos/x.png', ...yUrls].sort());
        for (const url of yUrls) expect(mapping.urls[url]).toEqual(ids('y.jpg'));
        expect(mapping.urls['/assets/photos/series/z.jpg']).toEqual(ids('series/z.jpg'));
        // x.jpg and x.png share every derivative URL, so none of them can point at one photo.
        expect(mapping.unmappable).toEqual(Object.fromEntries(legacyUrls('x.jpg').filter((url) => url !== '/assets/photos/x.jpg').map((url) => [url, ['x.jpg', 'x.png']])));
    }, 60_000);

    it('names the URLs the legacy site served, and only originals for nested files', () => {
        const legacy = getImagePaths('y.jpg');
        expect(legacyUrls('y.jpg')).toEqual([legacy.original, legacy.thumbnail, legacy.medium, legacy.optimized, legacy.thumbnailAvif, legacy.mediumAvif, legacy.optimizedAvif, legacy.lqip]);
        expect(legacyUrls('series/z.jpg')).toEqual(['/assets/photos/series/z.jpg']);
    });

    it('leaves a dry run afterwards with nothing to report', async () => {
        const s = await setup({ 'x.jpg': 0, 'y.jpg': 1 });
        await s.apply();
        const after = await migrateDryRun({ clock: later, logger: quiet });
        expect(after.plan.facts).toEqual([]);
        expect(after.plan.photos.map((photo) => photo.status)).toEqual(['existing', 'existing']);
    }, 60_000);

    it('reports a plan already applied and changes nothing', async () => {
        const s = await setup({ 'x.jpg': 0 });
        const first = await s.apply();
        const registry = fs.readFileSync(identityPaths(s.data.root).registry);
        const files = s.data.files();
        const again = await s.apply({ appliedAt: () => APPLIED_AT + 60_000 });
        expect(again).toEqual({ status: 'already-applied', planId: s.plan.planId, mappingPath: first.status === 'applied' ? first.mappingPath : '' });
        expect(fs.readFileSync(identityPaths(s.data.root).registry).equals(registry)).toBe(true);
        expect(s.data.files()).toEqual(files);
    }, 60_000);

    it('applies a later plan made against the applied registry', async () => {
        const s = await setup({ 'x.jpg': 0 });
        const first = await s.apply();
        fs.writeFileSync(s.lib.file('y.jpg'), images[1]);
        const second = await migrateDryRun({ clock: later, logger: quiet });
        expect(second.plan).toMatchObject({ registryVersion: 1, photos: [{ path: 'x.jpg', status: 'existing' }, { path: 'y.jpg', status: 'new' }] });
        const applied = await migrateApply({ planPath: second.planPath, clock: later, appliedAt: () => APPLIED_AT + 60_000, logger: quiet, dockerenvPath: path.join(s.data.root, '..', 'no-dockerenv') });
        expect(applied).toMatchObject({ status: 'applied', planId: second.plan.planId, photos: 2 });
        if (applied.status !== 'applied' || first.status !== 'applied') throw new Error('not applied');
        expect(applied.mappingPath).not.toBe(first.mappingPath);
        expect(Object.keys(mappingOf(s.data, applied.mappingPath).paths)).toEqual(['x.jpg', 'y.jpg']);
    }, 60_000);

    it('keeps an existing data-root.json', async () => {
        const s = await setup({ 'x.jpg': 0 }, { state: 'ready' });
        const marker = fs.readFileSync(s.data.file(DATA_ROOT_FILE));
        expect(await s.apply()).toMatchObject({ status: 'applied' });
        expect(fs.readFileSync(s.data.file(DATA_ROOT_FILE)).equals(marker)).toBe(true);
    }, 60_000);

    describe('refuses, writing nothing,', () => {
        async function expectRefused(s: Setup, apply: Promise<unknown>, message: RegExp | string, exitCode = 1): Promise<void> {
            const before = s.data.files();
            const error = await apply.catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(ApplyRefusedError);
            expect((error as ApplyRefusedError).message).toMatch(message);
            expect((error as ApplyRefusedError).exitCode).toBe(exitCode);
            expect(s.data.files()).toEqual(before);
        }

        it.each([
            ['a source changed', (s: Setup) => fs.writeFileSync(s.lib.file('x.jpg'), images[3]), /x\.jpg changed since the dry run/],
            ['a source was added', (s: Setup) => fs.writeFileSync(s.lib.file('new.jpg'), images[3]), /new\.jpg is new since the dry run/],
            ['a source was removed', (s: Setup) => fs.rmSync(s.lib.file('y.jpg')), /y\.jpg is gone since the dry run/],
        ])('when %s', async (_name, change, message) => {
            const s = await setup({ 'x.jpg': 0, 'y.jpg': 1 });
            change(s);
            await expectRefused(s, s.apply(), message);
        }, 60_000);

        it("when the plan's photos don't follow from its sources", async () => {
            const s = await setup({ 'x.jpg': 0, 'y.jpg': 1 });
            const edited = { ...s.plan, photos: s.plan.photos.map((photo, index) => (index === 0 ? { ...photo, duplicateOf: s.plan.photos[1].photoId } : photo)) };
            fs.writeFileSync(s.planPath, JSON.stringify(edited));
            await expectRefused(s, s.apply(), /Scanning the library again gives different photos than the plan/);
        }, 60_000);

        it('when the registry changed since the dry run', async () => {
            const s = await setup({ 'x.jpg': 0 }, { state: 'ready' });
            const pass = await runReconcilePass({ clock: later, logger: quiet });
            expect(pass.status).toBe('committed');
            await expectRefused(s, s.apply(), /The registry is at version 1, and the plan was made at version 0/);
        }, 60_000);

        it('in a container whose data root is on its own filesystem, not a mounted volume', async () => {
            const s = await setup({ 'x.jpg': 0 });
            const dockerenv = path.join(s.data.root, '..', '.dockerenv');
            fs.writeFileSync(dockerenv, '');
            await expectRefused(s, s.apply({ dockerenvPath: dockerenv, deviceOf: () => 7 }), /is on the container's own filesystem/);
            // A volume is another device, and applies.
            expect(await s.apply({ dockerenvPath: dockerenv, deviceOf: (dir) => (dir === '/' ? 7 : 8) })).toMatchObject({ status: 'applied' });
        }, 60_000);

        it('while another process holds the registry lock', async () => {
            const s = await setup({ 'x.jpg': 0 });
            fs.mkdirSync(identityPaths(s.data.root).dir, { recursive: true });
            const before = s.data.files();
            const error = await withLock('registry', { root: s.data.root }, () => s.apply().catch((caught: unknown) => caught));
            expect(error).toBeInstanceOf(ApplyRefusedError);
            expect((error as Error).message).toMatch(/The registry is busy/);
            expect(s.data.files()).toEqual(before);
        }, 60_000);

        it('when data-root.json is there but not valid', async () => {
            const s = await setup({ 'x.jpg': 0 });
            fs.writeFileSync(s.data.file(DATA_ROOT_FILE), '{ nope');
            await expectRefused(s, s.apply(), /data-root\.json is not valid JSON/);
        }, 60_000);

        it.skipIf(isRoot)('when the data root is unwritable', async () => {
            const s = await setup({ 'x.jpg': 0 });
            fs.chmodSync(s.data.root, 0o555);
            try {
                await expectRefused(s, s.apply(), /The data root is unwritable/);
            } finally {
                fs.chmodSync(s.data.root, 0o755);
            }
        }, 60_000);

        it('when the data root is unset', async () => {
            const s = await setup({ 'x.jpg': 0 });
            vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
            vi.stubEnv('NODE_ENV', 'production');
            await expectRefused(s, s.apply(), /The data root is unset/);
        }, 60_000);

        it.each([
            ['missing', (s: Setup) => path.join(s.data.root, 'nope.json'), /There is no plan at/],
            ['not JSON', (s: Setup) => { const file = path.join(s.data.root, '..', 'bad.json'); fs.writeFileSync(file, '{'); return file; }, /is not a migration plan/],
            ['not a plan', (s: Setup) => { const file = path.join(s.data.root, '..', 'other.json'); fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1 })); return file; }, /is not a migration plan: it has no planId/],
            ['from a newer build', (s: Setup) => edit(s, (plan) => ({ ...plan, schemaVersion: 2 })), /its schemaVersion is not 1/],
            ['without a registry version', (s: Setup) => edit(s, (plan) => ({ ...plan, registryVersion: 'zero' })), /it has no registryVersion/],
            ['with malformed sources', (s: Setup) => edit(s, (plan) => ({ ...plan, sources: [{ path: 'x.jpg', size: 1, assetRevision: 'sha256-x' }] })), /its sources are malformed/],
            ['with malformed photos', (s: Setup) => edit(s, (plan) => ({ ...plan, photos: [{ photoId: 'ph_1', path: 'x.jpg', assetRevision: 'r', status: 'new' }] })), /its photos are malformed/],
        ])('when the plan file is %s', async (_name, planFile, message) => {
            const s = await setup({ 'x.jpg': 0 });
            await expectRefused(s, s.apply({ planPath: planFile(s) }), message, 2);
        }, 60_000);
    });
});

describe('photos migrate --apply', { timeout: 120_000 }, () => {
    it('applies the plan, then reports it already applied, exiting 0 both times', async () => {
        const lib = await createTempLibrary();
        cleanups.push(() => lib.cleanup());
        const data = createTempDataRoot({ state: 'uninitialized' });
        cleanups.push(() => data.cleanup());
        fs.writeFileSync(lib.file('x.jpg'), images[0]);
        const { planPath } = await migrateDryRun({ clock: later, logger: quiet });
        const env = { PHOTOGRAPHY_LIBRARY_DIR: lib.root, PHOTOGRAPHY_DATA_DIR: data.root };
        // The command's scan runs on the real clock, so wait out the stability window first.
        await new Promise((resolve) => setTimeout(resolve, 5_500));
        const first = await runTsx('scripts/photos.ts', ['migrate', '--apply', '--plan', planPath], { env });
        expect(first.stderr).toBe('');
        expect(first.code).toBe(0);
        expect(first.stdout).toMatch(/Applied plan .*: 1 photo\. The watcher builds the derivatives\./);
        const second = await runTsx('scripts/photos.ts', ['migrate', '--apply', '--plan', planPath], { env });
        expect(second.code).toBe(0);
        expect(second.stdout).toContain('already applied');
    });

    it('exits 2 with the reason when there is no plan at the path, and 1 when the apply is refused', async () => {
        const lib = await createTempLibrary();
        cleanups.push(() => lib.cleanup());
        const data = createTempDataRoot({ state: 'uninitialized' });
        cleanups.push(() => data.cleanup());
        const env = { PHOTOGRAPHY_LIBRARY_DIR: lib.root, PHOTOGRAPHY_DATA_DIR: data.root };
        const missing = await runTsx('scripts/photos.ts', ['migrate', '--apply', '--plan', path.join(data.root, 'none.json')], { env });
        expect(missing.code).toBe(2);
        expect(missing.stderr).toContain('There is no plan at');
        fs.writeFileSync(lib.file('x.jpg'), images[0]);
        const { planPath } = await migrateDryRun({ clock: later, logger: quiet });
        fs.writeFileSync(lib.file('x.jpg'), images[1]);
        const drifted = await runTsx('scripts/photos.ts', ['migrate', '--apply', '--plan', planPath], { env });
        expect(drifted.code).toBe(1);
        expect(drifted.stderr).toContain('changed since the dry run');
    });

    it.each([
        [['migrate', '--apply'], /--apply needs --plan <file>/],
        [['migrate', '--dry-run', '--apply', '--plan', 'p.json'], /--dry-run and --apply don't go together/],
        [['migrate', '--plan', 'p.json'], /photos migrate needs --dry-run or --apply/],
        [['migrate', '--apply', '--plan'], /Option '--plan <value>' argument missing/],
        [['migrate', '--apply', '--plan='], /--apply needs --plan <file>/],
        [['migrate', '--apply', '--plan', 'p.json', '--out', 'x'], /--out goes with --dry-run/],
        [['migrate', '--dry-run', '--plan', 'p.json'], /--plan goes with --apply/],
        [['migrate', '--apply', '--plan', 'p.json', 'extra'], /Unexpected argument 'extra'/],
    ])('exits 2 on %j', async (args, message) => {
        const run = await runTsx('scripts/photos.ts', args);
        expect(run.code).toBe(2);
        expect(run.stderr).toMatch(message);
    });
});
