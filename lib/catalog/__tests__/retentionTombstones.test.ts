// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stagingLockName } from '../../identity/derivatives';
import { readStoredRegistry, writeRegistry } from '../../identity/registry';
import { readDirectoryManifest, manifestFiles } from '../../storage/publish';
import { withLock } from '../../storage/lock';
import { versionFile, versionText } from '../../storage/document';
import type { CurationEvent } from '../../curation/events';
import { runStatusCommand } from '../owner-status';
import { runPurge, runRevoke } from '../purge';
import { CATALOG_LOCK } from '../repository';
import { runPurgeCommand, purgeArgs } from '../purge-cli';
import { references } from '../references';
import { GC_EXIT_CODES, planDigest, runGc, trashName, type GcEntry, type GcOptions, type GcResult } from '../retention';
import { gcArgs, runGcCommand } from '../retention-cli';
import { removeAbandonedStaging } from '../../identity/derivatives';
import { dataRootStatus } from '../../storage/config';
import { runVerifyCommand } from '../verify-cli';
import { readTombstones, TOMBSTONE_GRACE_MS, tombstonesDir } from '../tombstones';
import { addAssetRevision, B2, cleanupPurgeTemplates, purgeFixture, quiet, snapshot, stamps, writeOpenEvent, writeRevoke, writeStaging, writeTombstone, type PurgeFixture } from './purgeFixtures';

/**
 * #181's A10: GC's `tombstoned` and `unreferenced` classes, and every one of
 * #15's GC fail-safes with its own test: the always-protected set (AC 8)
 * even when tombstoned, the override and its limits, the 7-day grace, a
 * revoke, the dry run, the digest, the plain line before the first delete,
 * the abort when something comes to protect a folder, the library, and the
 * log. Test values only.
 */

// The grace runs from the later of a tombstone's createdAt and its file's ctime, so the clock starts at the real time.
// An hour past the grace leaves every test in this file time to run.
const DAY = 24 * 60 * 60 * 1000;
const T0 = Math.ceil(Date.now() / 1000) * 1000;
const at = (ms: number) => () => ms;
const PAST_GRACE = T0 + TOMBSTONE_GRACE_MS + 60 * 60 * 1000;
const UUID = '0f0f0f0f-0000-4000-8000-00000000a10b';
/** A second asset revision for D, with a set of its own. */
const D2 = `sha256-${'d2'.repeat(32)}`;

const cleanups: (() => void)[] = [];
let library = '';

beforeAll(() => {
    library = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-library-'));
});

// No test here reaches a real library: PHOTOGRAPHY_LIBRARY_DIR is an empty temp folder unless a test sets another.
beforeEach(() => {
    vi.stubEnv('PHOTOGRAPHY_LIBRARY_DIR', library);
});

afterEach(() => {
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

afterAll(() => {
    cleanupPurgeTemplates();
});

async function fixture(): Promise<PurgeFixture> {
    const built = await purgeFixture(15);
    cleanups.push(built.cleanup);
    return built;
}

function gc(root: string, now: number, options: Partial<GcOptions> = {}): Promise<GcResult> {
    return runGc({ dataRoot: root, clock: at(now), logger: quiet, waitMs: 200, ...options });
}

async function command(root: string, args: string[], now: number, options: Partial<GcOptions> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const exitCode = await runGcCommand(root, gcArgs(args), { out: (line) => out.push(line), err: (line) => err.push(line) }, { clock: at(now), logger: quiet, waitMs: 200, ...options });
    return { exitCode, out, err };
}

/** Purge D, the photo only revision 1, its candidate and its own record show, at T0. */
async function purgeD(built: PurgeFixture): Promise<string> {
    const result = await runPurge({ dataRoot: built.root, photoId: built.d, reason: 'model release withdrawn', actor: 'owner', yes: true, clock: at(T0), idGen: () => UUID, logger: quiet });
    if (result.outcome !== 'PURGED' || !result.tombstone) throw new Error(result.message);
    return result.tombstone.tombstoneId;
}

const folderOf = (built: PurgeFixture, photoId: string, assetRevision = built.first[photoId]) => `assets/${photoId}/${assetRevision}`;
const assetsOf = (root: string) => new Map([...snapshot(root)].filter(([file]) => file.startsWith('assets/')));
/**
 * What every report says of a folder set aside whole: the owner's real steps
 * (items 25 and 29a). Anything in its place goes into the data root's trash/
 * with photos gc --set-aside, then the exact rename back.
 */
function wholeText(aside: string, original: string, occupied: boolean, then = 'then revoke, or rerun photos gc'): string {
    const back = `rename it back with mv ${aside} ${original}, from the data root in image-watcher's container; ${then}`;
    return occupied
        ? `set aside whole at ${aside}, and something else is at ${original}: set that aside with photos gc --set-aside ${original}, then ${back}`
        : `set aside whole at ${aside}: ${back}`;
}

/** What every report says to do with a partial or unknown leftover (item 29a). */
const leftoverStep = (aside: string) => `set it aside with photos gc --set-aside ${aside}, then rerun photos gc`;

/** GC's per-run markers for a tombstone, by file name. */
const markers = (root: string, tombstoneId: string) => fs.readdirSync(tombstonesDir(root)).filter((name) => name.startsWith(`${tombstoneId}.collected.`)).sort();
const readMarker = (root: string, name: string) => JSON.parse(fs.readFileSync(path.join(tombstonesDir(root), name), 'utf8')) as { planDigest: string; paths: { path: string; bytes: number; newestMs: number; files: { name: string; bytes: number }[] }[] };

/** D with a second asset revision, D2, and a set for it, then purged whole, so its tombstone lists both. */
async function purgeTwo(built: PurgeFixture): Promise<string> {
    await addAssetRevision(built.root, built.d, built.first[built.d], built.profileId, D2);
    return purgeD(built);
}

function revoke(built: PurgeFixture, tombstoneId: string) {
    return runRevoke({ dataRoot: built.root, tombstoneId, reason: 'released after all', actor: 'owner', yes: true, clock: at(PAST_GRACE), logger: quiet });
}

/** An Inbox item with no photo ID yet whose facts name `photoIds`, as an ambiguous match leaves one. */
function writeAmbiguousEvent(root: string, photoIds: string[], assetRevision: string, n = 7): CurationEvent {
    const event: CurationEvent = {
        schemaVersion: 1,
        version: 1,
        id: `evt_${n.toString(16).padStart(24, '0')}`,
        key: `ambiguous:${assetRevision}`,
        type: 'ambiguous',
        photoId: null,
        sourceFingerprint: `fp_${'a'.repeat(64)}`,
        assetRevision,
        observedAt: '2026-10-01T00:00:00.000Z',
        lastObservedAt: '2026-10-01T00:00:00.000Z',
        factIds: ['fact-1'],
        status: 'open',
        derivedFacts: { factType: 'ambiguous', sourcePath: 'fixture-copy.jpg', folder: '', candidates: photoIds },
        suggestions: { series: null, placement: null },
        edits: null,
        decisions: [],
        reviewedAt: null,
        reviewedBy: null,
    };
    const dir = path.join(root, 'curation', 'events', event.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(versionFile(dir, 1), versionText(event, 1));
    return event;
}

describe("GC's override: a standing tombstone past its grace", { timeout: 120_000 }, () => {
    it('deletes an asset only older revisions, a candidate and its own record reference, at 7 days', async () => {
        const built = await fixture();
        await purgeD(built);
        const refs = await references(built.root, { live: true });
        expect(new Set(refs.filter((ref) => ref.photoId === built.d).map((ref) => ref.source))).toEqual(new Set(['revision', 'candidate', 'working-layer-photo']));

        const planned = await gc(built.root, PAST_GRACE);
        expect(planned.outcome).toBe('PLANNED');
        expect(planned.plan?.delete).toEqual([expect.objectContaining({ class: 'tombstoned', path: folderOf(built, built.d), rule: 'gc.tombstoned.past-grace', tombstoneIds: [`tomb_${UUID}`] })]);
        const before = snapshot(built.root);
        const applied = await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest });
        expect(applied).toMatchObject({ outcome: 'APPLIED', deleted: [folderOf(built, built.d)] });
        expect(fs.existsSync(path.join(built.root, folderOf(built, built.d)))).toBe(false);
        // Only that folder went. Its tombstone stays, with GC's marker beside it.
        const after = snapshot(built.root);
        for (const [file, value] of before) {
            if (file === folderOf(built, built.d) || file.startsWith(`${folderOf(built, built.d)}/`)) continue;
            expect(after.get(file), file).toBe(value);
        }
        expect(markers(built.root, `tomb_${UUID}`)).toHaveLength(1);
    });

    it('keeps it at 6 days, and at exactly 7, as within its grace', async () => {
        const built = await fixture();
        await purgeD(built);
        const before = assetsOf(built.root);
        for (const now of [T0 + 6 * DAY, T0 + TOMBSTONE_GRACE_MS]) {
            const planned = await gc(built.root, now);
            expect(planned.plan?.delete).toEqual([]);
            expect(planned.plan?.kept).toContainEqual({ class: 'tombstoned', path: folderOf(built, built.d), reason: 'tombstone-within-grace', tombstoneIds: [`tomb_${UUID}`] });
            const applied = await gc(built.root, now, { apply: planned.plan?.digest });
            expect(applied.deleted).toEqual([]);
        }
        expect(assetsOf(built.root)).toEqual(before);
    });

    it('overrides nothing for a revoked tombstone: it protects nothing and deletes nothing', async () => {
        const built = await fixture();
        const id = await purgeD(built);
        writeRevoke(built.root, id);
        const before = assetsOf(built.root);
        const planned = await gc(built.root, PAST_GRACE);
        expect(planned.plan?.delete).toEqual([]);
        expect(planned.plan?.kept.filter((kept) => kept.class === 'tombstoned')).toEqual([]);
        expect(planned.plan?.tombstones).toBe(0);
        await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest });
        expect(assetsOf(built.root)).toEqual(before);
    });
});

describe("GC's always-protected set, even when tombstoned (#15's AC 8)", { timeout: 120_000 }, () => {
    /** Tombstone `photoId` straight to disk, past its grace, as purge would refuse to, then plan and apply. */
    async function survives(built: PurgeFixture, photoId: string, assetRevision: string, reason: string): Promise<void> {
        writeTombstone(built.root, { photoId, assetRevisions: [assetRevision], createdAt: new Date(T0).toISOString() });
        const before = assetsOf(built.root);
        const planned = await gc(built.root, PAST_GRACE);
        expect(planned.plan?.kept).toContainEqual(expect.objectContaining({ class: 'tombstoned', path: folderOf(built, photoId, assetRevision), reason }));
        expect(planned.plan?.delete.filter((entry) => entry.class === 'tombstoned')).toEqual([]);
        const applied = await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest });
        expect(applied.outcome).toBe('APPLIED');
        expect(assetsOf(built.root)).toEqual(before);
    }

    it('keeps an asset the live revision holds', async () => {
        const built = await fixture();
        await survives(built, built.a, built.first[built.a], 'active-revision');
    });

    it('keeps an asset a draft series lists at that asset revision', async () => {
        const built = await fixture();
        await survives(built, built.c, built.first[built.c], 'working-layer-series');
    });

    it('keeps an asset an open Inbox item names, deferred and failed ones too', async () => {
        for (const status of ['open', 'deferred', 'failed'] as const) {
            const built = await fixture();
            writeOpenEvent(built.root, built.d, built.first[built.d], status);
            await survives(built, built.d, built.first[built.d], 'open-inbox');
        }
    });

    it('keeps an asset a staging folder is building', async () => {
        const built = await fixture();
        writeStaging(built.root, 'live-build', { photoId: built.d, assetRevision: built.first[built.d], profileId: built.profileId });
        await withLock(stagingLockName('live-build'), { root: built.root, waitMs: 0 }, () => survives(built, built.d, built.first[built.d], 'live-staging'));
    });

    it("doesn't count a series that lists the photo at another asset revision, as for B1 with the record at B2", async () => {
        const built = await fixture();
        writeTombstone(built.root, { photoId: built.b, assetRevision: built.first[built.b], assetRevisions: [built.first[built.b]], createdAt: new Date(T0).toISOString() });
        const planned = await gc(built.root, PAST_GRACE);
        expect(planned.plan?.delete.map((entry) => entry.path)).toEqual([folderOf(built, built.b)]);
        // B2, live and listed, stays.
        expect(planned.plan?.kept).not.toContainEqual(expect.objectContaining({ path: folderOf(built, built.b, B2) }));
        await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest });
        expect(fs.existsSync(path.join(built.root, folderOf(built, built.b, B2)))).toBe(true);
    });

    it('keeps every asset revision of the photos an open Inbox item with no photo ID names (N1)', async () => {
        const built = await fixture();
        await addAssetRevision(built.root, built.d, built.first[built.d], built.profileId, D2);
        // The item's own asset revision is the new file's, which none of the photos it names has.
        const event = writeAmbiguousEvent(built.root, [built.d], `sha256-${'f'.repeat(64)}`);
        const live = await references(built.root, { live: true });
        expect(live).toContainEqual({ source: 'open-inbox', holder: event.id, photoId: built.d, assetRevision: null, profileId: null });
        writeTombstone(built.root, { photoId: built.d, assetRevisions: [built.first[built.d], D2], createdAt: new Date(T0).toISOString() });
        const planned = await gc(built.root, PAST_GRACE);
        expect(planned.plan?.delete.filter((entry) => entry.class === 'tombstoned')).toEqual([]);
        expect(planned.plan?.kept.filter((kept) => kept.class === 'tombstoned').map((kept) => [kept.path, kept.reason])).toEqual([
            [folderOf(built, built.d), 'open-inbox'],
            [folderOf(built, built.d, D2), 'open-inbox'],
        ]);
    });

    it('tags open Inbox items and staging entries in references() when asked, and not otherwise', async () => {
        const built = await fixture();
        const event = writeOpenEvent(built.root, built.d, built.first[built.d]);
        writeOpenEvent(built.root, built.c, built.first[built.c], 'dismissed', 2);
        writeStaging(built.root, 'live-build', { photoId: built.a, assetRevision: built.first[built.a], profileId: built.profileId });
        const live = await references(built.root, { live: true });
        expect(live).toContainEqual({ source: 'open-inbox', holder: event.id, photoId: built.d, assetRevision: built.first[built.d], profileId: null });
        expect(live).toContainEqual({ source: 'live-staging', holder: 'live-build', photoId: built.a, assetRevision: built.first[built.a], profileId: built.profileId });
        expect(live.filter((ref) => ref.source === 'open-inbox')).toHaveLength(1);
        const plain = await references(built.root);
        expect(plain.some((ref) => ref.source === 'open-inbox' || ref.source === 'live-staging')).toBe(false);
    });
});

describe('photos gc with tombstones, the dry run and the apply', { timeout: 120_000 }, () => {
    it('is a dry run by default: prints the plan and its digest, and deletes nothing', async () => {
        const built = await fixture();
        await purgeD(built);
        const before = snapshot(built.root);
        const { exitCode, out } = await command(built.root, [], PAST_GRACE);
        expect(exitCode).toBe(0);
        expect(snapshot(built.root)).toEqual(before);
        expect(out[0]).toBe('[photos] PLANNED: 1 path can go. Nothing was deleted.');
        expect(out).toContainEqual(expect.stringMatching(new RegExp(`^Delete ${folderOf(built, built.d)}: tombstoned, \\d+\\.\\d kB \\(\\d+ bytes\\) its manifests list\\. gc\\.tombstoned\\.past-grace: tomb_${UUID} took it down more than 7 days ago`)));
        expect(out).toContainEqual(expect.stringMatching(/^GC deletes 1 asset folder, each one a standing tombstone took down more than 7 days ago\. Every other asset stays/));
        expect(out).toContainEqual(expect.stringMatching(/^Bytes: deletes \d+\.\d kB, unreferenced 0 bytes\. Kept for the live revision [\d.]+ kB, older revisions [\d.]+ kB/));
        expect(out.at(-1)).toMatch(/^Run photos gc --apply gc_[0-9a-f]{64} to delete exactly these\.$/);
    });

    it('prints one plain line before the first delete, then logs each deletion', async () => {
        const built = await fixture();
        await purgeD(built);
        const planned = await gc(built.root, PAST_GRACE);
        const out: string[] = [];
        const events: Record<string, unknown>[] = [];
        let seenBeforeDelete: string[] = [];
        const exitCode = await runGcCommand(built.root, { apply: planned.plan?.digest }, { out: (line) => out.push(line), err: (line) => out.push(line) }, {
            clock: at(PAST_GRACE),
            waitMs: 200,
            logger: { log: (line) => events.push(JSON.parse(line) as Record<string, unknown>) },
            hooks: { beforeDelete: () => {
                seenBeforeDelete = [...out];
            } },
        });
        expect(exitCode).toBe(0);
        expect(seenBeforeDelete).toEqual([expect.stringMatching(/^Deletes 1 asset folder, \d+\.\d kB, from 1 tombstone\.$/)]);
        expect(out.slice(1)).toEqual(['[photos] APPLIED: Deleted 1 path.', `Deleted ${folderOf(built, built.d)}`]);
        expect(events.find((event) => event.event === 'catalog.gc.deleted')).toMatchObject({ class: 'tombstoned', path: folderOf(built, built.d), rule: 'gc.tombstoned.past-grace', tombstoneIds: [`tomb_${UUID}`] });
    });

    it('stops, deleting nothing, with a changed plan when the tombstone was revoked after the dry run', async () => {
        const built = await fixture();
        const id = await purgeD(built);
        const planned = await gc(built.root, PAST_GRACE);
        writeRevoke(built.root, id);
        const before = snapshot(built.root);
        const { exitCode, err } = await command(built.root, ['--apply', planned.plan?.digest ?? ''], PAST_GRACE);
        expect(exitCode).toBe(3);
        expect(err[0]).toMatch(/^\[photos\] PLAN_CHANGED: /);
        expect(snapshot(built.root)).toEqual(before);
    });

    it('aborts with exit 4, deleting and marking nothing, when a planned folder is always protected now', async () => {
        const built = await fixture();
        await purgeD(built);
        const planned = await gc(built.root, PAST_GRACE);
        let event = '';
        const result = await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest, hooks: { afterPlan: () => {
            event = writeOpenEvent(built.root, built.d, built.first[built.d]).id;
        } } });
        expect(result.outcome).toBe('NOW_PROTECTED');
        expect(GC_EXIT_CODES.NOW_PROTECTED).toBe(4);
        expect(result.message).toBe(`${folderOf(built, built.d)} is protected now: the open Inbox item ${event} names it. GC deleted nothing. Run the dry run again.`);
        expect(result.deleted).toEqual([]);
        expect(fs.existsSync(path.join(built.root, folderOf(built, built.d)))).toBe(true);
        expect(markers(built.root, `tomb_${UUID}`)).toEqual([]);
    });

    it('reports unreferenced sets with their bytes, and never deletes them', async () => {
        const built = await fixture();
        const stray = path.join(built.root, 'assets', 'ph_00000000-0000-4000-8000-0000000000ee', `sha256-${'e'.repeat(64)}`, built.profileId);
        fs.mkdirSync(stray, { recursive: true });
        fs.writeFileSync(path.join(stray, 'w400.webp'), Buffer.alloc(2048));
        const planned = await gc(built.root, PAST_GRACE);
        expect(planned.plan?.unreferenced).toEqual([{ path: path.relative(built.root, stray).split(path.sep).join('/'), bytes: 2048 }]);
        expect(planned.plan?.bytes.unreferenced).toBe(2048);
        await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest });
        expect(fs.existsSync(path.join(stray, 'w400.webp'))).toBe(true);
    });

    it('stops, deleting nothing, on a revoke file it cannot read', async () => {
        const built = await fixture();
        const id = await purgeD(built);
        fs.writeFileSync(path.join(built.root, 'catalog', 'tombstones', `${id}.revoked.json`), '{"tombstoneId":');
        const before = snapshot(built.root);
        const { exitCode, err } = await command(built.root, [], PAST_GRACE);
        expect(exitCode).toBe(4);
        expect(err[0]).toMatch(/^\[photos\] INTEGRITY_MISMATCH: catalog\/tombstones\/tomb_[^ ]+\.revoked\.json: it is not valid JSON, so GC can't tell what is taken down/);
        expect(snapshot(built.root)).toEqual(before);
    });
});

describe('GC and the photo library', { timeout: 120_000 }, () => {
    it('never deletes inside the library, even a tombstoned folder the data root keeps there', async () => {
        const built = await fixture();
        await purgeD(built);
        const planned = await gc(built.root, PAST_GRACE);
        // The library set to a folder that holds the data root: every path GC deletes is inside it.
        vi.stubEnv('PHOTOGRAPHY_LIBRARY_DIR', path.dirname(built.root));
        const before = snapshot(built.root);
        const result = await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest });
        expect(['UNSAFE_PATH', 'DATA_ROOT_NOT_READY']).toContain(result.outcome);
        expect(result.deleted).toEqual([]);
        expect(snapshot(built.root)).toEqual(before);
    });

    it('leaves a library elsewhere byte for byte as it was', async () => {
        const built = await fixture();
        await purgeD(built);
        const library = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-library-'));
        fs.mkdirSync(path.join(library, 'thumbnails'));
        fs.writeFileSync(path.join(library, 'original.jpg'), "the owner's original");
        fs.writeFileSync(path.join(library, 'thumbnails', 'original.webp'), 'a legacy derivative');
        vi.stubEnv('PHOTOGRAPHY_LIBRARY_DIR', library);
        const before = snapshot(library);
        const planned = await gc(built.root, PAST_GRACE);
        const result = await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest });
        expect(result.outcome).toBe('APPLIED');
        expect(snapshot(library)).toEqual(before);
    });

    it('keeps a tombstoned folder that is a symlink, and what it points to', async () => {
        const built = await fixture();
        await purgeD(built);
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-outside-'));
        fs.writeFileSync(path.join(outside, 'keep.jpg'), 'not GC\'s');
        const folder = path.join(built.root, folderOf(built, built.d));
        fs.renameSync(folder, `${folder}.moved`);
        fs.symlinkSync(outside, folder);
        const planned = await gc(built.root, PAST_GRACE);
        expect(planned.plan?.kept).toContainEqual(expect.objectContaining({ class: 'tombstoned', path: folderOf(built, built.d), reason: 'not-a-folder' }));
        await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest });
        expect(fs.readFileSync(path.join(outside, 'keep.jpg'), 'utf8')).toBe('not GC\'s');
    });
});

describe('a revoke after GC', { timeout: 120_000 }, () => {
    it('exits 1, writing nothing, once GC has deleted the asset folder', async () => {
        const built = await fixture();
        const id = await purgeD(built);
        const planned = await gc(built.root, PAST_GRACE);
        await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest });
        const before = snapshot(built.root);
        const out: string[] = [];
        const exitCode = await runPurgeCommand(built.root, purgeArgs(['--revoke', id, '--reason', 'too late', '--yes'], { PHOTOS_ACTOR: 'owner' }), { out: (line) => out.push(line), err: (line) => out.push(line) }, { clock: at(PAST_GRACE), logger: quiet });
        expect(exitCode).toBe(1);
        expect(out.at(-1)).toMatch(new RegExp(`^\\[photos\\] ALREADY_COLLECTED: photos gc --apply began deleting ${folderOf(built, built.d)} for ${id}, and it's gone or cut short now`));
        expect(snapshot(built.root)).toEqual(before);
    });
});

describe("GC's per-run markers and revoke (S1)", { timeout: 120_000 }, () => {
    it('writes one marker per run, before the first delete, with each exact path, its bytes and its newest change', async () => {
        const built = await fixture();
        const id = await purgeTwo(built);
        const planned = await gc(built.root, PAST_GRACE);
        expect(planned.plan?.delete.map((entry) => entry.path)).toEqual([folderOf(built, built.d), folderOf(built, built.d, D2)]);
        let seen: string[] = [];
        const result = await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest, hooks: { beforeDelete: () => {
            seen = markers(built.root, id);
        } } });
        expect(result.outcome).toBe('APPLIED');
        const digest = planned.plan?.digest ?? '';
        expect(seen).toEqual([`${id}.collected.${digest.slice(3, 19)}.json`]);
        const marker = readMarker(built.root, seen[0]);
        expect(marker.planDigest).toBe(digest);
        expect(marker.paths).toEqual(planned.plan?.delete.map((entry) => ({ path: entry.path, bytes: entry.bytes, newestMs: entry.newestMs, files: entry.files })));
        // Every file, the manifests included, by name and size.
        expect(marker.paths[0].files).toContainEqual({ name: `${built.profileId}/manifest.json`, bytes: expect.any(Number) });
    });

    it('lets a revoke through when a marker is there but nothing was deleted, and a listed revision never had a folder', async () => {
        const built = await fixture();
        // D3 is in the registry with no set, so no folder: it never counts as gone.
        const stored = await readStoredRegistry(built.root);
        if (!stored) throw new Error('No registry.');
        const registry = structuredClone(stored.registry);
        const d3 = `sha256-${'d3'.repeat(32)}`;
        registry.photos[built.d].revisions[d3] = { ...structuredClone(registry.photos[built.d].revisions[built.first[built.d]]), assetRevision: d3 };
        await writeRegistry(built.root, registry, stored.registry.version);
        const id = await purgeD(built);
        const planned = await gc(built.root, PAST_GRACE);
        const stopped = await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest, hooks: { beforeDelete: () => {
            throw new Error('a fault before the first delete');
        } } });
        expect(stopped.deleted).toEqual([]);
        expect(markers(built.root, id)).toHaveLength(1);
        const revoked = await revoke(built, id);
        expect(revoked.outcome).toBe('REVOKED');
    });

    it('refuses a revoke once a run deleted one folder of a two-revision tombstone, naming exactly that folder', async () => {
        const built = await fixture();
        const id = await purgeTwo(built);
        const planned = await gc(built.root, PAST_GRACE);
        let n = 0;
        const stopped = await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest, hooks: { beforeDelete: () => {
            n += 1;
            if (n === 2) throw new Error('a fault before the second delete');
        } } });
        expect(stopped.deleted).toEqual([folderOf(built, built.d)]);
        const before = snapshot(built.root);
        const refused = await revoke(built, id);
        expect(refused.outcome).toBe('ALREADY_COLLECTED');
        expect(refused.message).toContain(folderOf(built, built.d));
        expect(refused.message).not.toContain(folderOf(built, built.d, D2));
        expect(snapshot(built.root)).toEqual(before);
    });

    it("records a later run's paths too, and a revoke then names every folder either run deleted", async () => {
        const built = await fixture();
        const id = await purgeTwo(built);
        const first = await gc(built.root, PAST_GRACE);
        let n = 0;
        await gc(built.root, PAST_GRACE, { apply: first.plan?.digest, hooks: { beforeDelete: () => {
            n += 1;
            if (n === 2) throw new Error('a fault before the second delete');
        } } });
        const second = await gc(built.root, PAST_GRACE);
        expect(second.plan?.delete.map((entry) => entry.path)).toEqual([folderOf(built, built.d, D2)]);
        const applied = await gc(built.root, PAST_GRACE, { apply: second.plan?.digest });
        expect(applied.deleted).toEqual([folderOf(built, built.d, D2)]);
        const names = markers(built.root, id);
        expect(names).toHaveLength(2);
        // The first run planned both, so its marker names both. The second planned D2 only.
        const recorded = names.map((name) => readMarker(built.root, name)).map((marker) => [marker.planDigest, marker.paths.map((entry) => entry.path)]);
        expect(recorded).toEqual(expect.arrayContaining([
            [first.plan?.digest, [folderOf(built, built.d), folderOf(built, built.d, D2)]],
            [second.plan?.digest, [folderOf(built, built.d, D2)]],
        ]));
        const refused = await revoke(built, id);
        expect(refused.outcome).toBe('ALREADY_COLLECTED');
        expect(refused.message).toContain(`${folderOf(built, built.d)}, ${folderOf(built, built.d, D2)}`);
    });

    /** Purge D, plan, and stop the apply after its marker is written, with `change` made to D's set first. */
    async function changedAfterMarker(built: PurgeFixture, change: (set: string, file: string) => void): Promise<string> {
        const id = await purgeD(built);
        const planned = await gc(built.root, PAST_GRACE);
        await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest, hooks: { beforeDelete: () => {
            const set = path.join(built.root, folderOf(built, built.d), built.profileId);
            const [file] = fs.readdirSync(set).filter((name) => name !== 'manifest.json').sort();
            change(set, file);
            throw new Error('stop after the change');
        } } });
        expect(markers(built.root, id)).toHaveLength(1);
        return id;
    }

    it('lets a revoke through when a recorded folder only grew: a longer file, an extra file, a newer change (item 13)', async () => {
        const built = await fixture();
        const id = await changedAfterMarker(built, (set, file) => {
            fs.appendFileSync(path.join(set, file), 'x');
            fs.writeFileSync(path.join(set, 'owner-extra.txt'), 'an extra file');
        });
        expect((await revoke(built, id)).outcome).toBe('REVOKED');
    });

    it('refuses a revoke when a listed file of a recorded folder is shorter than recorded (item 13)', async () => {
        const built = await fixture();
        const id = await changedAfterMarker(built, (set, file) => fs.truncateSync(path.join(set, file), 10));
        const refused = await revoke(built, id);
        expect(refused.outcome).toBe('ALREADY_COLLECTED');
        expect(refused.message).toContain(folderOf(built, built.d));
    });

    it('refuses a revoke when a listed file of a recorded folder is missing (item 13)', async () => {
        const built = await fixture();
        const elsewhere = fs.mkdtempSync(path.join(path.dirname(built.root), 'moved-'));
        const id = await changedAfterMarker(built, (set, file) => fs.renameSync(path.join(set, file), path.join(elsewhere, file)));
        const refused = await revoke(built, id);
        expect(refused.outcome).toBe('ALREADY_COLLECTED');
        expect(refused.message).toContain(folderOf(built, built.d));
    });
});

describe('GC deletes by manifest only (S2)', { timeout: 120_000 }, () => {
    it.each([
        ['beside the sets', (folder: string) => path.join(folder, 'owner-notes.txt')],
        ['inside a set', (folder: string, profileId: string) => path.join(folder, profileId, 'owner-original.jpg')],
    ])('keeps a whole tombstoned folder byte for byte when an owner file is %s, and names it', async (_where, place) => {
        const built = await fixture();
        await purgeD(built);
        const folder = path.join(built.root, folderOf(built, built.d));
        const owner = place(folder, built.profileId);
        fs.writeFileSync(owner, "the owner's own file");
        const before = snapshot(built.root);
        const { exitCode, out } = await command(built.root, [], PAST_GRACE);
        expect(exitCode).toBe(0);
        const relative = path.relative(built.root, owner).split(path.sep).join('/');
        const planned = await gc(built.root, PAST_GRACE);
        expect(planned.plan?.delete.filter((entry) => entry.class === 'tombstoned')).toEqual([]);
        expect(planned.plan?.kept).toContainEqual(expect.objectContaining({ class: 'tombstoned', path: folderOf(built, built.d), reason: 'unexpected-content', detail: relative }));
        expect(out.join('\n')).toContain(relative);
        await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest });
        expect(snapshot(built.root)).toEqual(before);
    });

    it('keeps a folder whose set has no manifest, or a manifest for another set', async () => {
        const built = await fixture();
        await purgeTwo(built);
        fs.renameSync(path.join(built.root, folderOf(built, built.d), built.profileId, 'manifest.json'), path.join(built.root, folderOf(built, built.d), built.profileId, 'manifest.old'));
        const other = path.join(built.root, folderOf(built, built.d, D2), built.profileId, 'manifest.json');
        fs.writeFileSync(other, fs.readFileSync(other, 'utf8').replace(D2, built.first[built.d]));
        const planned = await gc(built.root, PAST_GRACE);
        expect(planned.plan?.delete.filter((entry) => entry.class === 'tombstoned')).toEqual([]);
        expect(planned.plan?.kept.filter((kept) => kept.class === 'tombstoned').map((kept) => kept.reason)).toEqual(['unexpected-content', 'unexpected-content']);
    });

    it('counts only the bytes the manifests list in what it deletes', async () => {
        const built = await fixture();
        await purgeD(built);
        const set = path.join(built.root, folderOf(built, built.d), built.profileId);
        const manifest = await readDirectoryManifest(set);
        if (!manifest) throw new Error('No manifest.');
        const listed = manifestFiles(manifest).reduce((sum, file) => sum + file.bytes, 0);
        const planned = await gc(built.root, PAST_GRACE);
        expect(planned.plan?.delete).toEqual([expect.objectContaining({ path: folderOf(built, built.d), bytes: listed })]);
        expect(planned.plan?.bytes.delete).toBe(listed);
    });
});

describe("GC's library guard, by identity (S3)", { timeout: 120_000 }, () => {
    it('refuses a tombstoned folder that holds the library, the data root still ready', async () => {
        const built = await fixture();
        await purgeD(built);
        const planned = await gc(built.root, PAST_GRACE);
        vi.stubEnv('PHOTOGRAPHY_LIBRARY_DIR', path.join(built.root, folderOf(built, built.d), built.profileId));
        const before = snapshot(built.root);
        const result = await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest });
        expect(result.outcome).toBe('UNSAFE_PATH');
        expect(result.message).toMatch(/photo library/);
        expect(result.deleted).toEqual([]);
        expect(snapshot(built.root)).toEqual(before);
    });

    it("refuses when the library can't be checked, since it can't tell what it would reach", async () => {
        const built = await fixture();
        await purgeD(built);
        const planned = await gc(built.root, PAST_GRACE);
        vi.stubEnv('PHOTOGRAPHY_LIBRARY_DIR', path.join(path.dirname(built.root), 'not-mounted'));
        const before = snapshot(built.root);
        const result = await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest });
        expect(result.outcome).toBe('UNSAFE_PATH');
        expect(result.deleted).toEqual([]);
        expect(snapshot(built.root)).toEqual(before);
    });
});

describe('GC sets a folder aside, checks again, then deletes (S4)', { timeout: 120_000 }, () => {
    it('renames a folder aside before the last check, and puts it back when something protects it now', async () => {
        const built = await fixture();
        const id = await purgeD(built);
        const planned = await gc(built.root, PAST_GRACE);
        const before = snapshot(built.root);
        const asides: string[] = [];
        let event = '';
        const result = await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest, hooks: {
            // Opened after the first check, before the folder is set aside: only the check after the rename sees it.
            beforeDelete: () => {
                event = writeOpenEvent(built.root, built.d, built.first[built.d]).id;
            },
            afterAside: (_entry, aside) => {
                asides.push(path.relative(fs.realpathSync(built.root), aside).split(path.sep).join('/'));
                expect(fs.existsSync(path.join(built.root, folderOf(built, built.d)))).toBe(false);
            },
        } });
        expect(result.outcome).toBe('NOW_PROTECTED');
        expect(GC_EXIT_CODES[result.outcome]).toBe(4);
        // The run's digest prefix is in the name, so a revoke can tie the folder to this run's marker.
        expect(asides).toEqual([expect.stringMatching(new RegExp(`^assets/${built.d}/\\.gc-${built.first[built.d]}-${planned.plan?.digest.slice(3, 19)}-[0-9a-f-]{36}$`))]);
        expect(result.message).toContain(`the open Inbox item ${event} names it`);
        expect(result.deleted).toEqual([]);
        // Back where it was, byte for byte. Only the Inbox item and GC's marker are new.
        const after = snapshot(built.root);
        for (const [file, value] of before) expect(after.get(file), file).toBe(value);
        expect([...after.keys()].filter((file) => !before.has(file) && !/^curation(?:\/|$)/.test(file)).sort()).toEqual([`catalog/tombstones/${markers(built.root, id)[0]}`]);
        expect((await revoke(built, id)).outcome).toBe('REVOKED');
    });

    it('leaves the folder aside, says so, and exits 4 when it cannot put it back', async () => {
        const built = await fixture();
        const id = await purgeD(built);
        const planned = await gc(built.root, PAST_GRACE);
        let aside = '';
        const original = assetsOf(built.root);
        const out: string[] = [];
        const exitCode = await runGcCommand(built.root, { apply: planned.plan?.digest }, { out: (line) => out.push(line), err: (line) => out.push(line) }, { clock: at(PAST_GRACE), logger: quiet, waitMs: 200, hooks: {
            afterAside: (_entry, at) => {
                aside = path.relative(fs.realpathSync(built.root), at).split(path.sep).join('/');
                writeOpenEvent(built.root, built.d, built.first[built.d]);
                // Something now in its place, so the rename back fails.
                fs.mkdirSync(path.join(built.root, folderOf(built, built.d), 'in-the-way'), { recursive: true });
            },
        } });
        expect(exitCode).toBe(4);
        const whole = wholeText(aside, folderOf(built, built.d), true);
        expect(out.join('\n')).toContain(whole);
        // Everything that was in it is in the folder set aside, byte for byte.
        const moved = assetsOf(built.root);
        for (const [file, value] of original) {
            if (!file.startsWith(`${folderOf(built, built.d)}/`)) continue;
            expect(moved.get(file.replace(folderOf(built, built.d), aside)), file).toBe(value);
        }

        // Item 12: a whole folder set aside isn't permanent. Revoke, status --check and the plan all say how to bring it back.
        const refused = await revoke(built, id);
        expect(refused.outcome).toBe('SET_ASIDE');
        expect(refused.message).toContain(whole);
        expect(refused.message).not.toMatch(/permanent/);
        const status = await runStatusCommand({ dataRoot: built.root }, { check: true });
        expect(status.output).toContain(whole);
        expect((await command(built.root, [], PAST_GRACE)).out.join('\n')).toContain(whole);
        // Done as it says, by renames only, the revoke goes through.
        fs.renameSync(path.join(built.root, folderOf(built, built.d)), path.join(path.dirname(built.root), 'in-the-way-moved'));
        fs.renameSync(path.join(built.root, aside), path.join(built.root, folderOf(built, built.d)));
        expect((await revoke(built, id)).outcome).toBe('REVOKED');
    });

    it("reports a leftover .gc- folder in the dry run and photos status --check, and never deletes one it didn't make", async () => {
        const built = await fixture();
        const leftover = path.join(built.root, 'assets', built.d, `.gc-${built.first[built.d]}-0f0f0f0f-0000-4000-8000-0000000000ff`);
        fs.mkdirSync(leftover, { recursive: true });
        fs.writeFileSync(path.join(leftover, 'w400.webp'), 'what a stopped run left');
        const relative = path.relative(built.root, leftover).split(path.sep).join('/');
        const before = snapshot(built.root);
        const { out } = await command(built.root, [], PAST_GRACE);
        expect(out.join('\n')).toContain(relative);
        const planned = await gc(built.root, PAST_GRACE);
        expect(planned.plan?.leftovers.map((each) => each.path)).toEqual([relative]);
        await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest });
        expect(snapshot(built.root)).toEqual(before);
        const status = await runStatusCommand({ dataRoot: built.root }, { check: true });
        expect(status.exitCode).toBe(1);
        expect(status.output).toContain(relative);
    });
});

describe('a delete that fails partway (S5)', { timeout: 120_000 }, () => {
    it('reports "partly deleted", stops, and a rerun and a revoke both see it', async () => {
        const built = await fixture();
        const id = await purgeTwo(built);
        const planned = await gc(built.root, PAST_GRACE);
        let n = 0;
        const out: string[] = [];
        const exitCode = await runGcCommand(built.root, { apply: planned.plan?.digest }, { out: (line) => out.push(line), err: (line) => out.push(line) }, { clock: at(PAST_GRACE), logger: quiet, waitMs: 200, hooks: {
            // GC's own delete does the deleting: the test makes no delete call of its own.
            remove: async (target, removeAt) => {
                n += 1;
                if (n === 1) return removeAt(target);
                // Half of it goes, then the delete fails.
                const set = path.join(target, built.profileId);
                const [file] = fs.readdirSync(set).filter((name) => name !== 'manifest.json');
                await removeAt(path.join(set, file));
                throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
            },
        } });
        expect(exitCode).toBe(4);
        expect(out.join('\n')).toContain(`partly deleted: ${folderOf(built, built.d, D2)}`);
        expect(out).toContainEqual(`Deleted ${folderOf(built, built.d)}`);

        // The rerun lists what is left and deletes none of it.
        const rerun = await gc(built.root, PAST_GRACE);
        expect(rerun.plan?.delete.filter((entry) => entry.class === 'tombstoned')).toEqual([]);
        expect(rerun.plan?.leftovers).toEqual([expect.objectContaining({ path: expect.stringMatching(new RegExp(`^assets/${built.d}/\\.gc-${D2}-`)), state: 'partial' })]);
        // Item 12: only what's left of a partial delete is permanent, and every place says so.
        const permanent = /partly deleted.*permanent.*[Ss]et it aside with photos gc --set-aside assets\/[^ ]+, then rerun photos gc/;
        expect((await command(built.root, [], PAST_GRACE)).out.join('\n')).toMatch(permanent);
        expect((await runStatusCommand({ dataRoot: built.root }, { check: true })).output).toMatch(permanent);
        const before = snapshot(built.root);
        await gc(built.root, PAST_GRACE, { apply: rerun.plan?.digest });
        expect(snapshot(built.root)).toEqual(before);

        const refused = await revoke(built, id);
        expect(refused.outcome).toBe('ALREADY_COLLECTED');
        expect(refused.message).toContain(`${folderOf(built, built.d)}, ${folderOf(built, built.d, D2)}`);
    });
});

describe("the grace can't be shortened (S6)", { timeout: 120_000 }, () => {
    it('starts the grace from the tombstone file, not a back-dated createdAt', async () => {
        const built = await fixture();
        writeTombstone(built.root, { photoId: built.d, assetRevisions: [built.first[built.d]], createdAt: '2020-01-01T00:00:00.000Z' });
        const early = await gc(built.root, T0 + DAY);
        expect(early.plan?.delete.filter((entry) => entry.class === 'tombstoned')).toEqual([]);
        expect(early.plan?.kept).toContainEqual(expect.objectContaining({ path: folderOf(built, built.d), reason: 'tombstone-within-grace' }));
        const late = await gc(built.root, PAST_GRACE);
        expect(late.plan?.delete.map((entry) => entry.path)).toEqual([folderOf(built, built.d)]);
    });

    it.each(['2026-10-01', '2026-10-01T00:00:00+02:00', '2026-10-01 00:00:00Z', 'Oct 1 2026', '2026-02-30T00:00:00.000Z'])('stops on a createdAt that is not strict ISO-8601 with Z: %s', async (createdAt) => {
        const built = await fixture();
        writeTombstone(built.root, { photoId: built.d, assetRevisions: [built.first[built.d]], createdAt });
        expect((await readTombstones(built.root)).problems).toEqual([expect.objectContaining({ reason: 'invalid', detail: expect.stringMatching(/createdAt/) })]);
        const before = snapshot(built.root);
        const result = await gc(built.root, PAST_GRACE);
        expect(result.outcome).toBe('INTEGRITY_MISMATCH');
        expect(snapshot(built.root)).toEqual(before);
    });
});

describe('the fail-safes that had no test (S7)', { timeout: 120_000 }, () => {
    it('stops, deleting nothing, when assets/ is a symlink while a tombstone stands', async () => {
        const built = await fixture();
        await purgeD(built);
        const elsewhere = path.join(path.dirname(built.root), 'assets-elsewhere');
        fs.renameSync(path.join(built.root, 'assets'), elsewhere);
        fs.symlinkSync(elsewhere, path.join(built.root, 'assets'));
        const before = snapshot(elsewhere);
        const { exitCode, err } = await command(built.root, [], PAST_GRACE);
        expect(exitCode).toBe(1);
        expect(err[0]).toMatch(/^\[photos\] UNSAFE_PATH: assets is a symlink/);
        expect(snapshot(elsewhere)).toEqual(before);
    });

    it("keeps a photo folder that is a symlink while a tombstone stands, and what it points to", async () => {
        const built = await fixture();
        await purgeD(built);
        const elsewhere = path.join(path.dirname(built.root), 'photo-elsewhere');
        fs.renameSync(path.join(built.root, 'assets', built.d), elsewhere);
        fs.symlinkSync(elsewhere, path.join(built.root, 'assets', built.d));
        const before = snapshot(elsewhere);
        const planned = await gc(built.root, PAST_GRACE);
        expect(planned.plan?.kept).toContainEqual(expect.objectContaining({ class: 'tombstoned', path: folderOf(built, built.d), reason: 'not-a-folder' }));
        expect(planned.plan?.delete.filter((entry) => entry.class === 'tombstoned')).toEqual([]);
        await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest });
        expect(snapshot(elsewhere)).toEqual(before);
    });

    it('leaves an owner file beside a tombstoned folder, and a library next to the data root, byte for byte, through purge and GC', async () => {
        const built = await fixture();
        const beside = path.join(built.root, 'assets', built.d, 'owner-notes.txt');
        fs.writeFileSync(beside, "the owner's notes, beside the sets");
        const nextTo = path.join(path.dirname(built.root), 'library');
        fs.mkdirSync(path.join(nextTo, 'trips'), { recursive: true });
        fs.writeFileSync(path.join(nextTo, 'trips', 'original.jpg'), "the owner's original");
        fs.writeFileSync(path.join(nextTo, 'original.webp'), 'a legacy derivative');
        vi.stubEnv('PHOTOGRAPHY_LIBRARY_DIR', nextTo);
        const sha = (file: string) => snapshot(path.dirname(file)).get(path.basename(file));
        const besideBefore = sha(beside);
        const libraryBefore = snapshot(nextTo);
        await purgeD(built);
        const planned = await gc(built.root, PAST_GRACE);
        const applied = await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest });
        expect(applied.deleted).toEqual([folderOf(built, built.d)]);
        expect(sha(beside)).toBe(besideBefore);
        expect(snapshot(nextTo)).toEqual(libraryBefore);
    });
});

describe('when restore stops being possible, in words (S8)', { timeout: 120_000 }, () => {
    const PERMANENT = /photos gc --apply deletes .*Once photos gc --apply has deleted a folder a tombstone lists, that takedown is permanent.*can never be rolled back to.*only a backup of the data root brings/;

    it("says it in the dry run's kept line for a tombstone still in its grace", async () => {
        const built = await fixture();
        await purgeD(built);
        const { out } = await command(built.root, [], T0 + DAY);
        expect(out.find((line) => line.startsWith('Kept '))).toMatch(PERMANENT);
        expect(out.join('\n')).not.toMatch(/delete (it|them) by hand|rm -rf/);
    });

    it("says it in purge's success line and its losing-revisions line", async () => {
        const built = await fixture();
        const out: string[] = [];
        const exitCode = await runPurgeCommand(built.root, purgeArgs([built.d, '--reason', 'x', '--yes'], { PHOTOS_ACTOR: 'owner' }), { out: (line) => out.push(line), err: (line) => out.push(line) }, { clock: at(T0), idGen: () => UUID, logger: quiet });
        expect(exitCode).toBe(0);
        expect(out.at(-1)).toMatch(PERMANENT);
        expect(out.find((line) => line.startsWith('No rollback can return'))).toMatch(PERMANENT);
    });
});

describe('a revoke that leaves other takedowns standing (N3)', { timeout: 120_000 }, () => {
    it('says which asset revisions another standing tombstone still takes down', async () => {
        const built = await fixture();
        const id = await purgeD(built);
        const other = writeTombstone(built.root, { photoId: built.d, assetRevision: built.first[built.d], assetRevisions: [built.first[built.d]], createdAt: new Date(T0).toISOString() }, 5);
        const result = await runRevoke({ dataRoot: built.root, tombstoneId: id, reason: 'x', actor: 'owner', clock: at(T0), logger: quiet });
        expect(result.outcome).toBe('REVOKE_PLANNED');
        expect(result.revokePlan?.summary).toContain(`${other.tombstoneId} still takes down ${built.first[built.d]}`);
        expect(result.revokePlan?.summary).not.toMatch(/serves their sets again wherever/);
    });

    it("says a folder GC deleted for another tombstone stays gone", async () => {
        const built = await fixture();
        const old = writeTombstone(built.root, { photoId: built.d, assetRevisions: [built.first[built.d]], createdAt: new Date(T0).toISOString() }, 6);
        const planned = await gc(built.root, PAST_GRACE);
        await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest });
        writeRevoke(built.root, old.tombstoneId);
        const fresh = writeTombstone(built.root, { photoId: built.d, assetRevisions: [built.first[built.d]], createdAt: new Date(PAST_GRACE).toISOString() }, 8);
        const result = await runRevoke({ dataRoot: built.root, tombstoneId: fresh.tombstoneId, reason: 'x', actor: 'owner', clock: at(PAST_GRACE), logger: quiet });
        expect(result.outcome).toBe('REVOKE_PLANNED');
        expect(result.revokePlan?.summary).toContain(`photos gc --apply deleted ${folderOf(built, built.d)} for ${old.tombstoneId}`);
    });
});

describe('gc without --apply only lists (coordinator line 9)', { timeout: 120_000 }, () => {
    it('deletes nothing and writes nothing, with every class it deletes ready to go', async () => {
        const built = await fixture();
        await purgeD(built);
        const staging = path.join(built.root, 'staging', 'killed-build');
        fs.mkdirSync(staging, { recursive: true });
        fs.writeFileSync(path.join(staging, 'w400.webp'), 'partial');
        const old = new Date(T0 - 30 * DAY);
        fs.utimesSync(path.join(staging, 'w400.webp'), old, old);
        fs.utimesSync(staging, old, old);
        const before = snapshot(built.root);
        const times = stamps(built.root);
        const { exitCode, out } = await command(built.root, [], PAST_GRACE);
        expect(exitCode).toBe(0);
        expect(out.filter((line) => line.startsWith('Delete ')).map((line) => line.split(':')[0])).toEqual(['Delete staging/killed-build', `Delete ${folderOf(built, built.d)}`]);
        expect(snapshot(built.root)).toEqual(before);
        expect(stamps(built.root)).toEqual(times);
    });
});

describe('every stop after the rename puts the folder back (item 14, and the locks)', { timeout: 120_000 }, () => {
    async function stoppedAfterRename(hooks: (built: PurgeFixture) => GcOptions['hooks']) {
        const built = await fixture();
        await purgeD(built);
        const planned = await gc(built.root, PAST_GRACE);
        const before = assetsOf(built.root);
        const result = await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest, hooks: hooks(built) });
        return { built, before, result };
    }

    it('puts it back when a stop comes between the last check and the delete', async () => {
        const { built, before, result } = await stoppedAfterRename(() => ({ beforeRemove: () => {
            throw new Error('a fault just before the delete');
        } }));
        expect(GC_EXIT_CODES[result.outcome]).toBe(4);
        expect(result.deleted).toEqual([]);
        expect(result.message).toContain(`GC put ${folderOf(built, built.d)} back`);
        expect(assetsOf(built.root)).toEqual(before);
    });

    it('checks it still holds its locks between the rename and the delete, and puts the folder back when it lost one', async () => {
        const { built, before, result } = await stoppedAfterRename((each) => ({ beforeRemove: () => {
            // Another process broke this run's lease and took the lock: a new file at the same path.
            const lockFile = path.join(each.root, 'locks', `${CATALOG_LOCK}.lock`);
            fs.renameSync(lockFile, `${lockFile}.broken`);
            const now = new Date().toISOString();
            fs.writeFileSync(lockFile, `${JSON.stringify({ owner: 'other', hostname: 'other-host', pid: 1, acquiredAt: now, heartbeatAt: now, leaseMs: 60_000 })}\n`);
        } }));
        expect(result.outcome).toBe('LOCK_LOST');
        expect(result.message).toContain(`GC put ${folderOf(built, built.d)} back`);
        expect(assetsOf(built.root)).toEqual(before);
    });

    it("exits 4 and names the folder when what is set aside isn't the folder it moved, and puts nothing in its place", async () => {
        let aside = '';
        let moved = '';
        const { built, before, result } = await stoppedAfterRename((each) => ({ beforeRemove: (_entry, at) => {
            aside = path.relative(fs.realpathSync(each.root), at).split(path.sep).join('/');
            moved = path.join(path.dirname(each.root), 'swapped-out');
            fs.renameSync(at, moved);
            fs.mkdirSync(at);
        } }));
        expect(GC_EXIT_CODES[result.outcome]).toBe(4);
        expect(result.message).toContain(`GC can't find the folder it set aside; what is at ${aside} isn't it.`);
        // Not GC's folder, so it is never called whole or permanent.
        expect(result.message).not.toMatch(/permanent|set aside whole/);
        expect(result.deleted).toEqual([]);
        expect(fs.existsSync(path.join(built.root, folderOf(built, built.d)))).toBe(false);
        // What GC set aside is whole where the swap put it.
        const whole = snapshot(moved);
        for (const [file, value] of before) {
            if (file.startsWith(`${folderOf(built, built.d)}/`)) expect(whole.get(file.slice(folderOf(built, built.d).length + 1)), file).toBe(value);
        }
    });
});

describe("the library guard's identity half, as a bind mount looks (item 15)", { timeout: 120_000 }, () => {
    afterEach(() => vi.restoreAllMocks());

    /** Make statSync report `as`'s dev and inode for `file`, as a bind mount of `as` at `file` would. Every other path stats as it is. */
    function bindMount(file: string, as: string): void {
        const real = fs.statSync;
        const fake = real(as);
        const target = fs.realpathSync(file);
        vi.spyOn(fs, 'statSync').mockImplementation(((each: fs.PathLike, options?: fs.StatSyncOptions) => {
            const stat = real(each, options as fs.StatSyncOptions & { bigint?: false });
            if (typeof each !== 'string' || path.resolve(each) !== target || !stat) return stat;
            return Object.assign(Object.create(Object.getPrototypeOf(stat) as object) as fs.Stats, stat, { dev: fake.dev, ino: fake.ino });
        }) as typeof fs.statSync);
    }

    it('refuses a target inside the library by identity, the paths apart: the library is the photo folder bound elsewhere', async () => {
        const built = await fixture();
        await purgeD(built);
        const planned = await gc(built.root, PAST_GRACE);
        const elsewhere = fs.mkdtempSync(path.join(path.dirname(built.root), 'bound-library-'));
        vi.stubEnv('PHOTOGRAPHY_LIBRARY_DIR', elsewhere);
        bindMount(elsewhere, path.join(built.root, 'assets', built.d));
        const before = snapshot(built.root);
        const result = await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest });
        expect(result.outcome).toBe('UNSAFE_PATH');
        expect(result.message).toMatch(/photo library/);
        expect(snapshot(built.root)).toEqual(before);
    });

    it('refuses a target that holds the library by identity, the paths apart: a folder above the library is the target bound elsewhere', async () => {
        const built = await fixture();
        await purgeD(built);
        const planned = await gc(built.root, PAST_GRACE);
        const above = fs.mkdtempSync(path.join(path.dirname(built.root), 'bound-above-'));
        const library = path.join(above, 'library');
        fs.mkdirSync(library);
        vi.stubEnv('PHOTOGRAPHY_LIBRARY_DIR', library);
        bindMount(above, path.join(built.root, folderOf(built, built.d)));
        const before = snapshot(built.root);
        const result = await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest });
        expect(result.outcome).toBe('UNSAFE_PATH');
        expect(result.message).toMatch(/holds the photo library/);
        expect(snapshot(built.root)).toEqual(before);
    });
});

describe("manifests account for every byte, and the window after the rename is closed (item 19)", { timeout: 120_000 }, () => {
    async function listedFile(built: PurgeFixture): Promise<string> {
        const set = path.join(built.root, folderOf(built, built.d), built.profileId);
        const manifest = await readDirectoryManifest(set);
        if (!manifest) throw new Error('No manifest.');
        return path.join(set, manifestFiles(manifest)[0].name);
    }

    it("keeps a folder whose listed file has a derivative's name and size but other bytes", async () => {
        const built = await fixture();
        await purgeD(built);
        const file = await listedFile(built);
        fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size, 7));
        const before = snapshot(built.root);
        const planned = await gc(built.root, PAST_GRACE);
        expect(planned.plan?.kept).toContainEqual(expect.objectContaining({ path: folderOf(built, built.d), reason: 'unexpected-content', detail: path.relative(built.root, file).split(path.sep).join('/') }));
        await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest });
        expect(snapshot(built.root)).toEqual(before);
    });

    it('keeps a folder whose listed file has another link, such as an owner file hard-linked in', async () => {
        const built = await fixture();
        await purgeD(built);
        const file = await listedFile(built);
        const owners = fs.mkdtempSync(path.join(path.dirname(built.root), 'owner-'));
        fs.linkSync(file, path.join(owners, 'my-copy.webp'));
        const planned = await gc(built.root, PAST_GRACE);
        expect(planned.plan?.delete.filter((entry) => entry.class === 'tombstoned')).toEqual([]);
        expect(planned.plan?.kept).toContainEqual(expect.objectContaining({ path: folderOf(built, built.d), reason: 'unexpected-content' }));
    });

    it('checks the folder set aside again before the delete, and puts it back when an owner file appeared in it', async () => {
        const built = await fixture();
        await purgeD(built);
        const planned = await gc(built.root, PAST_GRACE);
        const result = await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest, hooks: { afterAside: (_entry, aside) => {
            fs.writeFileSync(path.join(aside, 'owner-notes.txt'), "the owner's notes");
        } } });
        expect(result.outcome).toBe('PLAN_CHANGED');
        expect(result.deleted).toEqual([]);
        expect(fs.readFileSync(path.join(built.root, folderOf(built, built.d), 'owner-notes.txt'), 'utf8')).toBe("the owner's notes");
    });
});

describe('a whole folder set aside beats "reached" (item 21)', { timeout: 120_000 }, () => {
    /**
     * The reviewer's scenario: run A sets D's folder aside, and a rebuilt copy
     * lands in its place, so A's put-back fails ENOTEMPTY and A exits 4.
     */
    async function stuckAside(built: PurgeFixture) {
        const id = await purgeD(built);
        const planned = await gc(built.root, PAST_GRACE);
        let aside = '';
        const result = await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest, hooks: { beforeRemove: (_entry, at) => {
            aside = path.relative(fs.realpathSync(built.root), at).split(path.sep).join('/');
            // A build rebuilds the set where it was.
            fs.cpSync(at, path.join(built.root, folderOf(built, built.d)), { recursive: true });
            throw new Error('a fault just before the delete');
        } } });
        expect(GC_EXIT_CODES[result.outcome]).toBe(4);
        expect(result.message).toContain('ENOTEMPTY');
        return { id, aside, whole: wholeText(aside, folderOf(built, built.d), true) };
    }

    it('keeps the rebuilt folder in run B as set-aside-leftover, and revoke and status --check then agree', async () => {
        const built = await fixture();
        const { id, aside, whole } = await stuckAside(built);
        const before = snapshot(built.root);
        const planned = await gc(built.root, PAST_GRACE);
        expect(planned.plan?.delete.filter((entry) => entry.class === 'tombstoned')).toEqual([]);
        expect(planned.plan?.kept).toContainEqual(expect.objectContaining({ class: 'tombstoned', path: folderOf(built, built.d), reason: 'set-aside-leftover', detail: aside }));
        const applied = await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest });
        expect(applied.deleted).toEqual([]);
        expect(snapshot(built.root)).toEqual(before);
        const refused = await revoke(built, id);
        expect(refused.outcome).toBe('SET_ASIDE');
        expect(refused.message).toContain(whole);
        expect((await runStatusCommand({ dataRoot: built.root }, { check: true })).output).toContain(whole);
    });

    it('answers SET_ASIDE, never ALREADY_COLLECTED, while a whole aside holds what was recorded, though another run reached the folder', async () => {
        const built = await fixture();
        const { id, whole } = await stuckAside(built);
        // Another run's marker recorded the rebuilt copy, which is cut short now.
        const [first] = markers(built.root, id);
        const recorded = readMarker(built.root, first).paths[0];
        const digest = `gc_${'e'.repeat(64)}`;
        fs.writeFileSync(path.join(tombstonesDir(built.root), `${id}.collected.${digest.slice(3, 19)}.json`), JSON.stringify({ tombstoneId: id, planDigest: digest, startedAt: new Date(PAST_GRACE).toISOString(), paths: [recorded] }));
        const set = path.join(built.root, folderOf(built, built.d), built.profileId);
        const [file] = fs.readdirSync(set).filter((name) => name !== 'manifest.json').sort();
        fs.truncateSync(path.join(set, file), 1);
        const refused = await revoke(built, id);
        expect(refused.outcome).toBe('SET_ASIDE');
        expect(refused.message).toContain(whole);
        expect(refused.message).not.toMatch(/permanent/);
    });
});

describe("the files GC compares (item 23)", { timeout: 120_000 }, () => {
    it('gives a plan whose folders differ only in their files another digest', () => {
        const entry: GcEntry = { class: 'tombstoned', path: `assets/ph_00000000-0000-4000-8000-000000000001/sha256-${'a'.repeat(64)}`, rule: 'gc.tombstoned.past-grace', bytes: 10, newestMs: 1, tombstoneIds: [`tomb_${UUID}`], files: [{ name: 'p_0000000000000001/manifest.json', bytes: 300 }, { name: 'p_0000000000000001/w400.webp', bytes: 10 }] };
        const other = { ...entry, files: [{ name: 'p_0000000000000001/manifest.json', bytes: 301 }, { name: 'p_0000000000000001/w400.webp', bytes: 10 }] };
        expect(planDigest(TOMBSTONE_GRACE_MS, [entry])).not.toBe(planDigest(TOMBSTONE_GRACE_MS, [other]));
        expect(planDigest(TOMBSTONE_GRACE_MS, [entry])).toBe(planDigest(TOMBSTONE_GRACE_MS, [structuredClone(entry)]));
    });

    it("stops before the rename when a folder's files differ from the plan, its bytes and newest change the same", async () => {
        const built = await fixture();
        await purgeD(built);
        const planned = await gc(built.root, PAST_GRACE);
        const folder = path.join(built.root, folderOf(built, built.d));
        const set = path.join(folder, built.profileId);
        const result = await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest, hooks: { beforeDelete: () => {
            // The same manifest, reformatted: a valid set, the same listed bytes, and the times put back.
            const file = path.join(set, 'manifest.json');
            const stamps = [file, set, folder].map((each) => [each, fs.statSync(each)] as const);
            fs.writeFileSync(file, `${JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')))}\n`);
            for (const [each, stat] of stamps) fs.utimesSync(each, stat.atime, stat.mtime);
        } } });
        expect(result.outcome).toBe('PLAN_CHANGED');
        expect(result.message).toContain(`${folderOf(built, built.d)} holds other files than the plan.`);
        expect(fs.existsSync(folder)).toBe(true);
    });
});

describe("the owner's way out, followed step by step (item 25)", { timeout: 120_000 }, () => {
    /** Run A sets D aside, a rebuilt copy lands in its place, and A's put-back fails ENOTEMPTY. Returns the aside. */
    async function stuck(built: PurgeFixture) {
        const id = await purgeD(built);
        const planned = await gc(built.root, PAST_GRACE);
        let aside = '';
        await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest, hooks: { beforeRemove: (_entry, at) => {
            aside = path.relative(fs.realpathSync(built.root), at).split(path.sep).join('/');
            fs.cpSync(at, path.join(built.root, folderOf(built, built.d)), { recursive: true });
            throw new Error('a fault just before the delete');
        } } });
        return { id, aside, whole: wholeText(aside, folderOf(built, built.d), true) };
    }

    it('gives the same real steps in revoke, status --check, the plan and its kept line', async () => {
        const built = await fixture();
        const { id, whole } = await stuck(built);
        expect((await revoke(built, id)).message).toContain(whole);
        expect((await runStatusCommand({ dataRoot: built.root }, { check: true })).output).toContain(whole);
        const { out } = await command(built.root, [], PAST_GRACE);
        expect(out.find((line) => line.startsWith('Kept '))).toContain(whole);
        expect(out.find((line) => line.startsWith('Left by '))).toContain(whole);
        expect(out.join('\n')).not.toMatch(/\brm -|rm -rf|~\/\.Trash/);
    });

    /** The steps, as the messages give them: photos gc --set-aside what is in its place, then the rename back. */
    async function followSteps(built: PurgeFixture, aside: string): Promise<void> {
        const io = { out: () => undefined, err: () => undefined };
        expect(await runGcCommand(built.root, gcArgs(['--set-aside', folderOf(built, built.d)]), io, { clock: at(PAST_GRACE), logger: quiet, waitMs: 200 })).toBe(0);
        fs.renameSync(path.join(built.root, aside), path.join(built.root, folderOf(built, built.d)));
    }

    it('ends in a revoke when the owner sets aside what is in its place with photos gc --set-aside and renames the folder back', async () => {
        const built = await fixture();
        const { id, aside } = await stuck(built);
        await followSteps(built, aside);
        expect((await revoke(built, id)).outcome).toBe('REVOKED');
    });

    it('ends in a finished takedown when the owner takes the same steps and reruns photos gc instead', async () => {
        const built = await fixture();
        const { aside } = await stuck(built);
        await followSteps(built, aside);
        const planned = await gc(built.root, PAST_GRACE);
        expect(planned.plan?.delete.map((entry) => entry.path)).toEqual([folderOf(built, built.d)]);
        const applied = await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest });
        expect(applied.deleted).toEqual([folderOf(built, built.d)]);
    });
});

describe("item 21's reporting (item 26)", { timeout: 120_000 }, () => {
    it('S1: a delete that fails before removing anything leaves the folder whole, reported as whole, not partly deleted', async () => {
        const built = await fixture();
        const id = await purgeD(built);
        const planned = await gc(built.root, PAST_GRACE);
        let aside = '';
        const result = await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest, hooks: { remove: async (target) => {
            aside = path.relative(fs.realpathSync(built.root), target).split(path.sep).join('/');
            throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        } } });
        expect(GC_EXIT_CODES[result.outcome]).toBe(4);
        expect(result.partial).toEqual([]);
        expect(result.message).not.toMatch(/partly deleted/);
        expect(result.message).toContain(wholeText(aside, folderOf(built, built.d), false));
        expect((await revoke(built, id)).outcome).toBe('SET_ASIDE');
    });

    it('S2: one folder reached and another set aside whole keeps ALREADY_COLLECTED, and names the whole one to rename back and rerun gc', async () => {
        const built = await fixture();
        const id = await purgeTwo(built);
        const planned = await gc(built.root, PAST_GRACE);
        let n = 0;
        let aside = '';
        const run = await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest, hooks: { remove: async (target, removeAt) => {
            n += 1;
            if (n === 1) return removeAt(target);
            aside = path.relative(fs.realpathSync(built.root), target).split(path.sep).join('/');
            throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        } } });
        const refused = await revoke(built, id);
        expect(refused.outcome).toBe('ALREADY_COLLECTED');
        expect(refused.message).toContain(folderOf(built, built.d));
        // Item 30: revoke, status, the plan and GC's own stop all say "then rerun photos gc", never "revoke", since a folder of the tombstone was reached.
        const said = wholeText(aside, folderOf(built, built.d, D2), false, 'then rerun photos gc');
        expect(refused.message).toContain(said);
        expect(run.message).toContain(said);
        expect((await runStatusCommand({ dataRoot: built.root }, { check: true })).output).toContain(said);
        expect((await command(built.root, [], PAST_GRACE)).out.join('\n')).toContain(said);
    });

    it("M7: a partial leftover with an incomplete copy in its place reads permanent in revoke, status and the plan", async () => {
        const built = await fixture();
        const id = await purgeD(built);
        const saved = fs.mkdtempSync(path.join(path.dirname(built.root), 'saved-'));
        fs.cpSync(path.join(built.root, folderOf(built, built.d)), path.join(saved, 'copy'), { recursive: true });
        const planned = await gc(built.root, PAST_GRACE);
        await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest, hooks: { remove: async (target, removeAt) => {
            const set = path.join(target, built.profileId);
            const [file] = fs.readdirSync(set).filter((name) => name !== 'manifest.json');
            await removeAt(path.join(set, file));
            throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        } } });
        // A copy in its place, cut short, so nothing there holds what was recorded.
        const place = path.join(built.root, folderOf(built, built.d));
        fs.cpSync(path.join(saved, 'copy'), place, { recursive: true });
        const [file] = fs.readdirSync(path.join(place, built.profileId)).filter((name) => name !== 'manifest.json').sort();
        fs.truncateSync(path.join(place, built.profileId, file), 1);
        const refused = await revoke(built, id);
        expect(refused.outcome).toBe('ALREADY_COLLECTED');
        for (const text of [refused.message, (await runStatusCommand({ dataRoot: built.root }, { check: true })).output, (await command(built.root, [], PAST_GRACE)).out.join('\n')]) {
            expect(text).toMatch(/permanent/);
        }
    });

    it("S3 and S4: a partial leftover isn't permanent while the folder's place holds what was recorded, revoke, status and the plan agree, and it keeps the folder", async () => {
        const built = await fixture();
        const id = await purgeD(built);
        const saved = fs.mkdtempSync(path.join(path.dirname(built.root), 'saved-'));
        fs.cpSync(path.join(built.root, folderOf(built, built.d)), path.join(saved, 'copy'), { recursive: true });
        const planned = await gc(built.root, PAST_GRACE);
        let aside = '';
        await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest, hooks: { remove: async (target, removeAt) => {
            aside = path.relative(fs.realpathSync(built.root), target).split(path.sep).join('/');
            const set = path.join(target, built.profileId);
            const [file] = fs.readdirSync(set).filter((name) => name !== 'manifest.json');
            await removeAt(path.join(set, file));
            throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        } } });
        // A rebuilt copy holding everything recorded is in its place.
        fs.cpSync(path.join(saved, 'copy'), path.join(built.root, folderOf(built, built.d)), { recursive: true });
        const step = leftoverStep(aside);

        const planned2 = await gc(built.root, PAST_GRACE);
        expect(planned2.plan?.kept).toContainEqual(expect.objectContaining({ path: folderOf(built, built.d), reason: 'set-aside-leftover' }));
        const plan = (await command(built.root, [], PAST_GRACE)).out.join('\n');
        const status = (await runStatusCommand({ dataRoot: built.root }, { check: true })).output;
        const dry = await runRevoke({ dataRoot: built.root, tombstoneId: id, reason: 'x', actor: 'owner', clock: at(PAST_GRACE), logger: quiet });
        expect(dry.outcome).toBe('REVOKE_PLANNED');
        for (const text of [plan, status, dry.revokePlan?.summary ?? '']) {
            expect(text).toContain(step);
            expect(text).not.toMatch(/permanent/);
        }
    });
});

describe('a .gc- name GC only half reads keeps the folder (item 28)', { timeout: 120_000 }, () => {
    it.each([
        ['a revision but no run', (built: PurgeFixture) => `.gc-${built.first[built.d]}-not-a-run`],
        ['no revision at all', () => '.gc-left-by-hand'],
        // M10: a full revision with junk run straight on, no dash.
        ['a revision with junk after it', (built: PurgeFixture) => `.gc-${built.first[built.d]}junk`],
    ])('keeps the tombstoned folder for %s', async (_what, name) => {
        const built = await fixture();
        await purgeD(built);
        fs.mkdirSync(path.join(built.root, 'assets', built.d, name(built)));
        const planned = await gc(built.root, PAST_GRACE);
        expect(planned.plan?.delete.filter((entry) => entry.class === 'tombstoned')).toEqual([]);
        expect(planned.plan?.kept).toContainEqual(expect.objectContaining({ path: folderOf(built, built.d), reason: 'set-aside-leftover', detail: `assets/${built.d}/${name(built)}` }));
    });
});

describe('photos gc --set-aside, the data root trash/ (item 29a)', { timeout: 120_000 }, () => {
    afterEach(() => vi.restoreAllMocks());

    async function setAside(built: PurgeFixture, target: string, now = PAST_GRACE) {
        const out: string[] = [];
        const exitCode = await runGcCommand(built.root, gcArgs(['--set-aside', target]), { out: (line) => out.push(line), err: (line) => out.push(line) }, { clock: at(now), logger: quiet, waitMs: 200 });
        return { exitCode, text: out.join('\n') };
    }

    /** D purged, and a rebuilt copy of its set in a .gc- aside, as a stopped run could leave one. */
    async function withLeftover(built: PurgeFixture): Promise<string> {
        await purgeD(built);
        const aside = `assets/${built.d}/.gc-${built.first[built.d]}-0f0f0f0f0f0f0f0f-0f0f0f0f-0000-4000-8000-0000000000aa`;
        fs.cpSync(path.join(built.root, folderOf(built, built.d)), path.join(built.root, aside), { recursive: true });
        return aside;
    }

    it("renames a tombstoned folder into trash/, inside the data root and on its device, and deletes nothing", async () => {
        const built = await fixture();
        await purgeD(built);
        const before = snapshot(built.root);
        const { exitCode, text } = await setAside(built, folderOf(built, built.d));
        expect(exitCode).toBe(0);
        const name = trashName(built.d, built.first[built.d], PAST_GRACE);
        const trash = path.join(built.root, 'trash');
        expect(fs.existsSync(path.join(built.root, folderOf(built, built.d)))).toBe(false);
        // On the persisted data-root volume: under the data root, on its device, not on a container's own disk.
        expect(fs.lstatSync(trash).dev).toBe(fs.lstatSync(built.root).dev);
        expect(fs.lstatSync(path.join(trash, name)).dev).toBe(fs.lstatSync(built.root).dev);
        expect(path.relative(fs.realpathSync(built.root), fs.realpathSync(path.join(trash, name)))).toBe(`trash/${name}`);
        // Every byte is there, under trash/.
        const after = snapshot(built.root);
        for (const [file, value] of before) {
            const moved = file.startsWith(`${folderOf(built, built.d)}/`) ? `trash/${name}/${file.slice(folderOf(built, built.d).length + 1)}` : file === folderOf(built, built.d) ? `trash/${name}` : file;
            expect(after.get(moved), file).toBe(value);
        }
        expect(text).toContain(`trash/${name}`);
        expect(text).toMatch(/Emptying trash\/ is your own step/);
        expect(text).not.toMatch(/\brm\b|~\/\.Trash/);
    });

    it('sets aside a .gc- leftover too', async () => {
        const built = await fixture();
        const aside = await withLeftover(built);
        expect((await setAside(built, aside)).exitCode).toBe(0);
        expect(fs.existsSync(path.join(built.root, aside))).toBe(false);
    });

    it.each([
        ['a catalog folder', () => 'catalog/revisions'],
        ['the registry', () => 'identity'],
        ['a photo folder', (built: PurgeFixture) => `assets/${built.d}`],
        ['a profile folder', (built: PurgeFixture) => `${folderOf(built, built.d)}/${built.profileId}`],
        ['a path out of the data root', () => '../library'],
        ['a library path', (built: PurgeFixture) => path.join(path.dirname(built.root), 'library')],
        ['trash/ itself', () => 'trash'],
    ])('refuses %s, exits 1, and changes nothing', async (_what, target) => {
        const built = await fixture();
        await purgeD(built);
        fs.mkdirSync(path.join(path.dirname(built.root), 'library'), { recursive: true });
        const before = snapshot(built.root);
        const { exitCode, text } = await setAside(built, target(built));
        expect(exitCode).toBe(1);
        expect(text).toMatch(/NOT_AN_ASSET_PATH/);
        expect(snapshot(built.root)).toEqual(before);
    });

    it('refuses a folder the photo library holds, by the library guard', async () => {
        const built = await fixture();
        await purgeD(built);
        vi.stubEnv('PHOTOGRAPHY_LIBRARY_DIR', path.join(built.root, folderOf(built, built.d), built.profileId));
        const before = snapshot(built.root);
        const { exitCode, text } = await setAside(built, folderOf(built, built.d));
        expect(exitCode).toBe(1);
        expect(text).toMatch(/photo library/);
        expect(snapshot(built.root)).toEqual(before);
    });

    it('refuses a folder no standing tombstone takes down, such as one the live revision shows', async () => {
        const built = await fixture();
        const before = snapshot(built.root);
        const { exitCode, text } = await setAside(built, folderOf(built, built.a));
        expect(exitCode).toBe(1);
        expect(text).toMatch(/NOT_TAKEN_DOWN/);
        expect(snapshot(built.root)).toEqual(before);
    });

    it('refuses a destination that is there already', async () => {
        const built = await fixture();
        await purgeD(built);
        fs.mkdirSync(path.join(built.root, 'trash', trashName(built.d, built.first[built.d], PAST_GRACE)), { recursive: true });
        const before = snapshot(built.root);
        const { exitCode, text } = await setAside(built, folderOf(built, built.d));
        expect(exitCode).toBe(1);
        expect(text).toMatch(/EXISTS/);
        expect(snapshot(built.root)).toEqual(before);
    });

    it('refuses a move across devices, as trash/ on another disk would be', async () => {
        const built = await fixture();
        await purgeD(built);
        const target = fs.realpathSync(path.join(built.root, folderOf(built, built.d)));
        const real = fs.lstatSync;
        vi.spyOn(fs, 'lstatSync').mockImplementation(((each: fs.PathLike, options?: fs.StatSyncOptions) => {
            const stat = real(each, options as fs.StatSyncOptions & { bigint?: false });
            if (typeof each !== 'string' || path.resolve(each) !== target || !stat) return stat;
            return Object.assign(Object.create(Object.getPrototypeOf(stat) as object) as fs.Stats, stat, { dev: stat.dev + 1 });
        }) as typeof fs.lstatSync);
        const before = snapshot(built.root);
        const { exitCode, text } = await setAside(built, folderOf(built, built.d));
        expect(exitCode).toBe(1);
        expect(text).toMatch(/CROSS_DEVICE/);
        vi.restoreAllMocks();
        expect(snapshot(built.root)).toEqual(before);
    });

    it('runs under the catalog lock: a held lock exits 3 and moves nothing', async () => {
        const built = await fixture();
        await purgeD(built);
        const before = snapshot(built.root);
        const result = await withLock(CATALOG_LOCK, { root: built.root, waitMs: 0 }, () => setAside(built, folderOf(built, built.d)));
        expect(result.exitCode).toBe(3);
        expect(snapshot(built.root)).toEqual(before);
    });

    it('is skipped by every walker: gc, references, verify, the staging clear and the data-root check', async () => {
        const built = await fixture();
        await purgeD(built);
        await setAside(built, folderOf(built, built.d));
        const trash = snapshot(path.join(built.root, 'trash'));
        const planned = await gc(built.root, PAST_GRACE);
        const named = JSON.stringify(planned.plan);
        expect(named).not.toContain('trash/');
        expect(JSON.stringify(await references(built.root, { live: true }))).not.toContain('trash');
        const lines: string[] = [];
        const verified = await runVerifyCommand(built.root, { json: false }, { out: (line) => lines.push(line), err: (line) => lines.push(line) });
        expect(verified).toBe(0);
        expect(lines.join('\n')).not.toContain('trash');
        expect(await removeAbandonedStaging(built.root, { logger: { log: () => undefined, warn: () => undefined, error: () => undefined } })).toEqual([]);
        expect(dataRootStatus({ root: built.root }).state).toBe('ready');
        await gc(built.root, PAST_GRACE, { apply: planned.plan?.digest });
        expect(snapshot(path.join(built.root, 'trash'))).toEqual(trash);
    });

    it("is named in photos status, with what is in it and its size, and emptying it is the owner's own step", async () => {
        const built = await fixture();
        await purgeD(built);
        await setAside(built, folderOf(built, built.d));
        const name = trashName(built.d, built.first[built.d], PAST_GRACE);
        const { output } = await runStatusCommand({ dataRoot: built.root });
        expect(output).toMatch(new RegExp(`Trash: 1 folder, \\d+\\.\\d kB, in trash/: ${name}\\. Emptying trash/ is your own step\\.`));
        expect(output).not.toMatch(/\brm\b/);
    });
});
