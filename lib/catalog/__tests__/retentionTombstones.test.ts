// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { stagingLockName } from '../../identity/derivatives';
import { withLock } from '../../storage/lock';
import { runPurge } from '../purge';
import { runPurgeCommand, purgeArgs } from '../purge-cli';
import { references } from '../references';
import { GC_EXIT_CODES, runGc, type GcOptions, type GcResult } from '../retention';
import { gcArgs, runGcCommand } from '../retention-cli';
import { collectedFile, TOMBSTONE_GRACE_MS } from '../tombstones';
import { B2, cleanupPurgeTemplates, purgeFixture, quiet, snapshot, writeOpenEvent, writeRevoke, writeStaging, writeTombstone, type PurgeFixture } from './purgeFixtures';

/**
 * #181's A10: GC's `tombstoned` and `unreferenced` classes, and every one of
 * #15's GC fail-safes with its own test: the always-protected set (AC 8)
 * even when tombstoned, the override and its limits, the 7-day grace, a
 * revoke, the dry run, the digest, the plain line before the first delete,
 * the abort when something comes to protect a folder, the library, and the
 * log. Test values only.
 */

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number) => () => ms;
const PAST_GRACE = T0 + TOMBSTONE_GRACE_MS + 60_000;
const UUID = '0f0f0f0f-0000-4000-8000-00000000a10b';

const cleanups: (() => void)[] = [];

afterEach(() => {
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

afterAll(() => cleanupPurgeTemplates());

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
        expect(fs.existsSync(collectedFile(built.root, `tomb_${UUID}`))).toBe(true);
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
        expect(out).toContainEqual(expect.stringMatching(new RegExp(`^Delete ${folderOf(built, built.d)}: tombstoned, \\d+\\.\\d kB \\(\\d+ bytes\\)\\. gc\\.tombstoned\\.past-grace: tomb_${UUID} took it down more than 7 days ago`)));
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
        expect(fs.existsSync(collectedFile(built.root, `tomb_${UUID}`))).toBe(false);
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
        cleanups.push(() => fs.rmSync(library, { recursive: true, force: true }));
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
        cleanups.push(() => fs.rmSync(outside, { recursive: true, force: true }));
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
        expect(out.at(-1)).toMatch(new RegExp(`^\\[photos\\] ALREADY_COLLECTED: photos gc deleted ${folderOf(built, built.d)} for ${id}`));
        expect(snapshot(built.root)).toEqual(before);
    });
});
