// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withExifOrientation } from '../../../test/fixtures/makeLibrary';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { resolveAsset } from '../../media/manifest';
import { assetDir, mediaFilePath } from '../../media/path';
import { IntegrityError } from '../../storage/publish';
import { buildDerivativeSet, removeAbandonedStaging, stagingLockName, stagingRoot, type BuildOptions, type WriterFaults } from '../derivatives';
import { runReconcilePass, type PassOptions } from '../pass';
import { currentProfileId } from '../profile';
import { readRegistry, writeRegistry } from '../registry';
import type { AssetManifest, DerivativeJob, Registry } from '../types';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../variants';
import { sequentialIds } from './reconcileFixtures';

const VARIANT_NAMES = VARIANT_WIDTHS.flatMap((width) => VARIANT_FORMATS.map((format) => `${width}.${format}`));
const NOW = Date.parse('2026-03-01T12:00:00.000Z');

let landscape: Buffer;
let edited: Buffer;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
    // Small, so every variant is the oriented width and the AVIF encodes stay quick.
    const gradient = (width: number, height: number, tint: number) => {
        const data = Buffer.alloc(width * height * 3);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([tint, (x * 255) / width, (y * 255) / height], (y * width + x) * 3);
        return sharp(data, { raw: { width, height, channels: 3 } });
    };
    landscape = await gradient(300, 200, 200).jpeg({ quality: 90 }).toBuffer();
    edited = await gradient(300, 200, 40).jpeg({ quality: 90 }).toBuffer();
});

afterEach(async () => {
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Setup {
    lib: TempLibrary;
    data: TempDataRoot;
    pass(): Promise<DerivativeJob[]>;
    job(name: string): Promise<DerivativeJob>;
    build(job: DerivativeJob, options?: Partial<BuildOptions>): ReturnType<typeof buildDerivativeSet>;
}

async function setup(files: Record<string, Buffer> = { 'landscape.jpg': landscape }): Promise<Setup> {
    const lib = await createTempLibrary();
    cleanups.push(() => lib.cleanup());
    const data = createTempDataRoot();
    cleanups.push(() => data.cleanup());
    for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(lib.file(name), bytes);
    const ids = sequentialIds();
    const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
    const passOptions: PassOptions = { clock: () => Date.now() + 60_000, idGen: ids, logger: quiet };
    const pass = async () => {
        const outcome = await runReconcilePass(passOptions);
        if (outcome.status !== 'committed') throw new Error(JSON.stringify(outcome));
        return outcome.jobs;
    };
    await pass();
    const job = async (name: string) => {
        const registry = await readRegistry(data.root);
        const photo = Object.values(registry.photos).find((entry) => entry.source.path === name);
        if (!photo) throw new Error(`No photo at ${name}`);
        return { photoId: photo.photoId, assetRevision: photo.source.observedRevision, profileId: currentProfileId(), path: name };
    };
    const build = (target: DerivativeJob, options: Partial<BuildOptions> = {}) => buildDerivativeSet(target, { clock: () => NOW, logger: quiet, ...options });
    return { lib, data, pass, job, build };
}

const profileOf = (registry: Registry, job: DerivativeJob) => registry.photos[job.photoId].revisions[job.assetRevision].profiles[job.profileId];

/** The registry with one profile entry and the bookkeeping fields set aside, to show nothing else changed. */
function withoutProfile(registry: Registry, job: DerivativeJob) {
    const copy = structuredClone(registry);
    delete copy.photos[job.photoId].revisions[job.assetRevision].profiles[job.profileId];
    return { ...copy, version: 0, updatedAt: null };
}

function stagingEntries(data: TempDataRoot): string[] {
    const dir = stagingRoot(data.root);
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

/** The lock files builds hold for their staging folders. */
function buildLocks(data: TempDataRoot): string[] {
    const dir = data.file('locks');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith(stagingLockName(''))).sort() : [];
}

function snapshot(dir: string): Record<string, { bytes: string; mtimeMs: number }> {
    return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => {
        const file = path.join(dir, name);
        return [name, { bytes: fs.readFileSync(file).toString('base64'), mtimeMs: fs.statSync(file).mtimeMs }];
    }));
}

describe('buildDerivativeSet', () => {
    it('writes all eight variants and the LQIP from one read of the source, then the manifest, and records the profile ready', async () => {
        const s = await setup();
        const job = await s.job('landscape.jpg');
        const order: string[] = [];
        const faults: WriterFaults = {
            afterVariant: (name) => { order.push(name); },
            beforeManifest: () => {
                order.push('manifest');
                // The manifest goes last: none exists while the variants are written.
                const [staging] = stagingEntries(s.data);
                expect(fs.existsSync(path.join(stagingRoot(s.data.root), staging, 'manifest.json'))).toBe(false);
                // The build holds its staging folder's lock for as long as the folder exists.
                expect(buildLocks(s.data)).toEqual([`${stagingLockName(staging)}.lock`]);
            },
        };
        expect(await s.build(job, { faults })).toEqual({ status: 'ready', reused: false });
        expect(order).toEqual([...VARIANT_NAMES, 'manifest']);
        expect(buildLocks(s.data)).toEqual([]);

        const resolved = await resolveAsset(job);
        expect(resolved.state).toBe('ready');
        if (resolved.state !== 'ready') return;
        expect(resolved.manifest).toMatchObject({ schemaVersion: 1, photoId: job.photoId, assetRevision: job.assetRevision, profileId: job.profileId, createdAt: new Date(NOW).toISOString() });
        expect(resolved.manifest.lqip).toMatch(/^data:image\/webp;base64,/);
        for (const width of VARIANT_WIDTHS) {
            for (const format of VARIANT_FORMATS) {
                const file = fs.readFileSync(mediaFilePath(job, width, format));
                const metadata = await sharp(file).metadata();
                expect(metadata.format, `${width}.${format}`).toBe(format === 'avif' ? 'heif' : 'webp');
                expect([metadata.width, metadata.height]).toEqual([300, 200]);
                expect(metadata.exif ?? metadata.xmp ?? metadata.iptc).toBeUndefined();
                expect(resolved.manifest.variants[width][format]).toMatchObject({ width: 300, height: 200, bytes: file.length });
            }
        }
        expect(profileOf(await readRegistry(s.data.root), job)).toEqual({ state: 'ready', attempts: 1, readyAt: new Date(NOW).toISOString() });
        expect(stagingEntries(s.data)).toEqual([]);
    }, 60_000);

    it.each([6, 8])('turns an orientation %i photo upright, with its oriented dimensions', async (orientation) => {
        const s = await setup({ 'turned.jpg': withExifOrientation(landscape, orientation) });
        const job = await s.job('turned.jpg');
        const registry = await readRegistry(s.data.root);
        expect(registry.photos[job.photoId].revisions[job.assetRevision]).toMatchObject({ width: 200, height: 300, orientation });
        expect(await s.build(job)).toEqual({ status: 'ready', reused: false });
        const resolved = await resolveAsset(job);
        if (resolved.state !== 'ready') throw new Error('not ready');
        for (const width of VARIANT_WIDTHS) {
            const metadata = await sharp(fs.readFileSync(mediaFilePath(job, width, 'webp'))).metadata();
            expect([metadata.width, metadata.height, metadata.orientation]).toEqual([200, 300, undefined]);
            expect(resolved.manifest.variants[width].avif).toMatchObject({ width: 200, height: 300 });
        }
        // A 90-degree turn moves the bright edge: sample the decoded corners to show the pixels turned.
        const raw = await sharp(fs.readFileSync(mediaFilePath(job, 'w400', 'webp'))).raw().toBuffer({ resolveWithObject: true });
        const pixel = (x: number, y: number) => raw.data[(y * raw.info.width + x) * raw.info.channels + 1];
        const upright = await sharp(landscape).rotate(orientation === 6 ? 90 : 270).raw().toBuffer({ resolveWithObject: true });
        const expected = (x: number, y: number) => upright.data[(y * upright.info.width + x) * upright.info.channels + 1];
        for (const [x, y] of [[5, 5], [194, 5], [5, 294], [194, 294]]) expect(Math.abs(pixel(x, y) - expected(x, y))).toBeLessThan(40);
    }, 60_000);

    describe('a fault before the set is published', () => {
        const cases: [string, (fail: () => never) => WriterFaults][] = [
            ...VARIANT_NAMES.map((name): [string, (fail: () => never) => WriterFaults] => [`after ${name}`, (fail) => ({ afterVariant: (written) => { if (written === name) fail(); } })]),
            ['before the manifest', (fail) => ({ beforeManifest: fail })],
            ['before the rename', (fail) => ({ beforePublish: fail })],
            ['ENOSPC on the third file', () => {
                let writes = 0;
                return {
                    writeFile: async (file, bytes) => {
                        if (++writes === 3) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
                        await fs.promises.writeFile(file, bytes);
                    },
                };
            }],
        ];

        it.each(cases)('%s leaves no final directory, no staging, and no registry change but failed', async (_label, faultsFor) => {
            const s = await setup();
            const job = await s.job('landscape.jpg');
            const before = await readRegistry(s.data.root);
            const outcome = await s.build(job, { faults: faultsFor(() => { throw new Error('injected fault'); }) });
            expect(outcome).toMatchObject({ status: 'failed', error: expect.stringMatching(/injected fault|ENOSPC/) });
            expect(fs.existsSync(assetDir(job))).toBe(false);
            expect(stagingEntries(s.data)).toEqual([]);
            expect(buildLocks(s.data)).toEqual([]);
            const after = await readRegistry(s.data.root);
            expect(profileOf(after, job)).toEqual({ state: 'failed', attempts: 1, error: expect.stringMatching(/injected fault|ENOSPC/) });
            expect(withoutProfile(after, job)).toEqual(withoutProfile(before, job));
        }, 60_000);
    });

    it("keeps its staging folder when a worker starting meanwhile clears out killed builds' folders", async () => {
        const s = await setup();
        const job = await s.job('landscape.jpg');
        let removed: string[] | null = null;
        const outcome = await s.build(job, {
            idGen: () => 'a-live-build',
            faults: {
                async afterVariant() {
                    removed ??= await removeAbandonedStaging(s.data.root, { logger: { log: () => undefined, warn: () => undefined, error: () => undefined } });
                },
            },
        });
        expect(removed).toEqual([]);
        expect(outcome).toEqual({ status: 'ready', reused: false });
        expect((await resolveAsset(job)).state).toBe('ready');
        expect(stagingEntries(s.data)).toEqual([]);
        expect(buildLocks(s.data)).toEqual([]);
    }, 60_000);

    it('publishes nothing once another process has taken its staging lock over', async () => {
        const s = await setup();
        const job = await s.job('landscape.jpg');
        const lockFile = s.data.file('locks', `${stagingLockName('stalled')}.lock`);
        let taken = false;
        const outcome = await s.build(job, {
            idGen: () => 'stalled',
            lock: { leaseMs: 200 },
            faults: {
                async afterVariant() {
                    if (taken) return;
                    taken = true;
                    // As if this build stalled past its lease and a starting worker took the lock.
                    const at = new Date().toISOString();
                    fs.writeFileSync(`${lockFile}.new`, JSON.stringify({ owner: 'a starting worker', hostname: 'elsewhere', pid: 1, acquiredAt: at, heartbeatAt: at, leaseMs: 60_000 }));
                    fs.renameSync(`${lockFile}.new`, lockFile);
                    // Long enough for a renewal, every 50 ms, to see it.
                    await new Promise((resolve) => setTimeout(resolve, 300));
                },
            },
        });
        expect(outcome).toMatchObject({ status: 'failed', error: expect.stringContaining('taken over by a starting worker') });
        expect(fs.existsSync(assetDir(job))).toBe(false);
        expect(stagingEntries(s.data)).toEqual([]);
    }, 60_000);

    describe('checks every encoded file before it is written', () => {
        const replacements: [string, () => Promise<Buffer>, RegExp][] = [
            ['the wrong width', () => sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).webp().toBuffer(), /w800\.webp is 10x10, expected 300 wide/],
            ['bytes that don\'t decode', async () => Buffer.from('not an image'), /w800\.webp doesn't decode/],
            ['the wrong format', () => sharp(landscape).avif({ effort: 0 }).toBuffer(), /w800\.webp decodes as heif/],
            ['metadata', () => sharp(landscape).webp().withExif({ IFD0: { Copyright: 'fixture owner' } }).toBuffer(), /w800\.webp carries metadata/],
            ['nothing', async () => Buffer.alloc(0), /w800\.webp is empty/],
        ];

        it.each(replacements)('and fails a file with %s, writing nothing', async (_label, replacement, message) => {
            const s = await setup();
            const job = await s.job('landscape.jpg');
            const bytes = await replacement();
            const outcome = await s.build(job, { faults: { afterEncode: (name) => (name === 'w800.webp' ? bytes : undefined) } });
            expect(outcome).toMatchObject({ status: 'failed', error: expect.stringMatching(message) });
            expect(fs.existsSync(assetDir(job))).toBe(false);
            expect(stagingEntries(s.data)).toEqual([]);
        }, 60_000);
    });

    it('leaves an entry another writer changed during the build as that writer left it', async () => {
        const s = await setup();
        const job = await s.job('landscape.jpg');
        const outcome = await s.build(job, {
            faults: {
                beforeRecord: async () => {
                    // A decision moves this revision to another photo while the set is being published.
                    const registry = await readRegistry(s.data.root);
                    registry.photos[job.photoId].revisions[job.assetRevision].reassignedTo = 'ph_00000000-0000-4000-8000-000000000099';
                    await writeRegistry(s.data.root, registry, registry.version);
                },
            },
        });
        expect(outcome).toEqual({ status: 'ready', reused: false });
        const revision = (await readRegistry(s.data.root)).photos[job.photoId].revisions[job.assetRevision];
        expect(revision.reassignedTo).toBe('ph_00000000-0000-4000-8000-000000000099');
        expect(revision.profiles[job.profileId]).toEqual({ state: 'pending', attempts: 0 });
    }, 60_000);

    it('keeps a valid set it finds already in place: no encoding, no writes, and the profile ready', async () => {
        const s = await setup();
        const job = await s.job('landscape.jpg');
        await s.build(job);
        const dir = assetDir(job);
        const before = snapshot(dir);
        await resetToPending(s.data, job);
        const encoded: string[] = [];
        expect(await s.build(job, { faults: { afterVariant: (name) => { encoded.push(name); } } })).toEqual({ status: 'ready', reused: true });
        expect(encoded).toEqual([]);
        expect(snapshot(dir)).toEqual(before);
        expect(stagingEntries(s.data)).toEqual([]);
        expect(profileOf(await readRegistry(s.data.root), job)).toMatchObject({ state: 'ready' });
    }, 60_000);

    it('refuses an invalid set it finds in place with an integrity error, and leaves it byte-identical', async () => {
        const s = await setup();
        const job = await s.job('landscape.jpg');
        await s.build(job);
        const dir = assetDir(job);
        fs.writeFileSync(path.join(dir, 'w800.webp'), Buffer.from('not the encoded bytes'));
        const before = snapshot(dir);
        await resetToPending(s.data, job);
        const encoded: string[] = [];
        const outcome = await s.build(job, { faults: { afterVariant: (name) => { encoded.push(name); } } });
        expect(encoded).toEqual([]);
        expect(outcome).toMatchObject({ status: 'failed', error: expect.stringMatching(/^integrity:/) });
        expect(outcome.status === 'failed' && outcome.cause).toBeInstanceOf(IntegrityError);
        expect(snapshot(dir)).toEqual(before);
        expect(profileOf(await readRegistry(s.data.root), job)).toMatchObject({ state: 'failed', error: expect.stringMatching(/^integrity:/) });
    }, 60_000);

    it.each([
        ['fewer variants', 'lists no w1920.avif, which the profile builds', (manifest: AssetManifest, dir: string) => {
            delete (manifest.variants.w1920 as Partial<AssetManifest['variants']['w1920']>).avif;
            fs.rmSync(path.join(dir, 'w1920.avif'));
        }],
        ['a variant the profile never builds', "lists w2560.webp, which the profile doesn't build", (manifest: AssetManifest, dir: string) => {
            (manifest.variants as Record<string, unknown>).w2560 = { webp: manifest.variants.w1920.webp };
            fs.copyFileSync(path.join(dir, 'w1920.webp'), path.join(dir, 'w2560.webp'));
        }],
    ])('refuses a set in place whose own manifest checks out but lists %s, and leaves it byte-identical', async (_label, problem, change) => {
        const s = await setup();
        const job = await s.job('landscape.jpg');
        await s.build(job);
        const dir = assetDir(job);
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as AssetManifest;
        change(manifest, dir);
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
        const before = snapshot(dir);
        await resetToPending(s.data, job);

        const outcome = await s.build(job);
        expect(outcome).toMatchObject({ status: 'failed', error: `integrity: ${problem}` });
        expect(snapshot(dir)).toEqual(before);
        expect(profileOf(await readRegistry(s.data.root), job)).toMatchObject({ state: 'failed', error: `integrity: ${problem}` });
    }, 60_000);

    it('after a crash between publishing and recording, a restart skips encoding and marks the profile ready', async () => {
        const s = await setup();
        const job = await s.job('landscape.jpg');
        await expect(s.build(job, { faults: { beforeRecord: () => { throw new Error('crash after the rename'); } } })).rejects.toThrow('crash after the rename');
        expect((await resolveAsset(job)).state).toBe('ready');
        expect(profileOf(await readRegistry(s.data.root), job)).toEqual({ state: 'pending', attempts: 0 });

        const encoded: string[] = [];
        expect(await s.build(job, { faults: { afterVariant: (name) => { encoded.push(name); } } })).toEqual({ status: 'ready', reused: true });
        expect(encoded).toEqual([]);
        expect(profileOf(await readRegistry(s.data.root), job)).toMatchObject({ state: 'ready' });
    }, 60_000);

    it('leaves the entry pending and asks for a pass when the source no longer matches its digest', async () => {
        const s = await setup();
        const job = await s.job('landscape.jpg');
        fs.writeFileSync(s.lib.file('landscape.jpg'), edited);
        const before = await readRegistry(s.data.root);
        expect(await s.build(job)).toEqual({ status: 'pending', reason: 'digest-mismatch' });
        expect(await readRegistry(s.data.root)).toEqual(before);
        expect(fs.existsSync(assetDir(job))).toBe(false);
        expect(stagingEntries(s.data)).toEqual([]);
    });

    it('fails with source-superseded once the bound path holds another revision', async () => {
        const s = await setup();
        const job = await s.job('landscape.jpg');
        fs.writeFileSync(s.lib.file('landscape.jpg'), edited);
        await s.pass();
        expect(await s.build(job)).toEqual({ status: 'failed', error: 'source-superseded' });
        expect(profileOf(await readRegistry(s.data.root), job)).toMatchObject({ state: 'failed', error: 'source-superseded' });
    });

    it('waits, changing nothing, while the source is missing', async () => {
        const s = await setup();
        const job = await s.job('landscape.jpg');
        fs.rmSync(s.lib.file('landscape.jpg'));
        await s.pass();
        const before = await readRegistry(s.data.root);
        expect(await s.build(job)).toEqual({ status: 'skipped', reason: 'source-missing' });
        expect(await readRegistry(s.data.root)).toEqual(before);
    });

    it('builds a re-copied file by its bytes, whatever its mtime says', async () => {
        const s = await setup();
        const first = await s.job('landscape.jpg');
        await s.build(first);
        const old = fs.statSync(s.lib.file('landscape.jpg')).mtime;
        // A copy tool that keeps an older mtime: new bytes, with a timestamp earlier than the file it replaces.
        fs.rmSync(s.lib.file('landscape.jpg'));
        fs.writeFileSync(s.lib.file('landscape.jpg'), edited);
        fs.utimesSync(s.lib.file('landscape.jpg'), new Date(old.getTime() - 86_400_000), new Date(old.getTime() - 86_400_000));
        await s.pass();
        const second = await s.job('landscape.jpg');
        expect(second.assetRevision).not.toBe(first.assetRevision);
        expect(await s.build(second)).toEqual({ status: 'ready', reused: false });
        expect((await resolveAsset(first)).state).toBe('ready');
        expect((await resolveAsset(second)).state).toBe('ready');
    }, 60_000);

    it('skips a revision that moved to another photo, and an entry that is not pending', async () => {
        const s = await setup();
        const job = await s.job('landscape.jpg');
        const registry = await readRegistry(s.data.root);
        registry.photos[job.photoId].revisions[job.assetRevision].reassignedTo = 'ph_00000000-0000-4000-8000-000000000099';
        await writeRegistry(s.data.root, registry, registry.version);
        expect(await s.build(job)).toEqual({ status: 'skipped', reason: 'reassigned' });
        delete registry.photos[job.photoId].revisions[job.assetRevision].reassignedTo;
        registry.photos[job.photoId].revisions[job.assetRevision].profiles[job.profileId] = { state: 'failed', attempts: 1, error: 'earlier' };
        await writeRegistry(s.data.root, registry, registry.version + 1);
        expect(await s.build(job)).toEqual({ status: 'skipped', reason: 'not-pending' });
        expect(await s.build({ ...job, photoId: 'ph_00000000-0000-4000-8000-000000000098' })).toEqual({ status: 'skipped', reason: 'unknown' });
    });

    it.each(['uninitialized', 'missing'] as const)('does nothing against a data root that is %s', async (state) => {
        const s = await setup();
        const job = await s.job('landscape.jpg');
        const other = createTempDataRoot({ state });
        cleanups.push(() => other.cleanup());
        expect(await s.build(job)).toEqual({ status: 'skipped', reason: 'data-root' });
        expect(fs.existsSync(path.join(other.root, 'assets'))).toBe(false);
    });

    it('does nothing when PHOTOGRAPHY_DATA_DIR is unset in production', async () => {
        const s = await setup();
        const job = await s.job('landscape.jpg');
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
        vi.stubEnv('NODE_ENV', 'production');
        expect(await s.build(job)).toEqual({ status: 'skipped', reason: 'data-root' });
        vi.unstubAllEnvs();
        expect(fs.existsSync(path.join(s.data.root, 'assets'))).toBe(false);
        expect(profileOf(await readRegistry(s.data.root), job)).toEqual({ state: 'pending', attempts: 0 });
    });

    it.skipIf(process.getuid?.() === 0)('does nothing against an unwritable data root', async () => {
        const s = await setup();
        const job = await s.job('landscape.jpg');
        fs.chmodSync(s.data.root, 0o555);
        expect(await s.build(job)).toEqual({ status: 'skipped', reason: 'data-root' });
        expect(fs.existsSync(path.join(s.data.root, 'assets'))).toBe(false);
        expect(fs.existsSync(stagingRoot(s.data.root))).toBe(false);
    });
});

async function resetToPending(data: TempDataRoot, job: DerivativeJob): Promise<void> {
    const registry = await readRegistry(data.root);
    registry.photos[job.photoId].revisions[job.assetRevision].profiles[job.profileId] = { state: 'pending', attempts: 0 };
    await writeRegistry(data.root, registry, registry.version);
}
