// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTsx } from '../../../test/helpers/runTsx';
import { folderBytes } from '../../../test/helpers/folderBytes';
import { identityPaths, readRegistry, writeRegistry } from '../../identity/registry';
import { versionFile, versionText } from '../../storage/document';
import { withLock } from '../../storage/lock';
import { runRules } from '../rules';
import { applySeriesOp, applySequenceOp, sequenceContext, type Actor, type ApplyOptions, type SeriesOp, type SequenceOp } from '../sequence';
import { createTestCatalog, type TestCatalog } from '../testing';
import type { AuthoredSeries } from '../types';
import { authoredRecordDir, readAuthoredRecord, readAuthoredSeries } from '../working-layer';

const P = Array.from({ length: 10 }, (_, index) => `ph_00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
const UNKNOWN = 'ph_00000000-0000-4000-8000-000000000999';
const S1 = 'ser_fixture-01';
const S2 = 'ser_fixture-02';
const S3 = 'ser_fixture-03';
const FOCAL = { x: 0.25, y: 0.75 };
const EDITOR: Actor = { kind: 'editor' };
const chapter = (id: string, startPhotoId: string) => ({ id, title: `Fixture chapter ${id.slice(3)}`, startPhotoId });

let catalog: TestCatalog;

beforeEach(async () => {
    // S1: P0 to P4, three chapters (one: P0 P1, two: P2 P3, three: P4), cover P0 with a focal point, opening P3.
    // S2: published, P5 and P6. S3: a draft, P7. P8 and P9 are in no series.
    catalog = await createTestCatalog({
        seed: 9,
        photos: P.map((id) => ({ id })),
        series: [
            {
                id: S1,
                photoIds: P.slice(0, 5),
                cover: { photoId: P[0], focalPoint: FOCAL },
                openingPhotoId: P[3],
                chapters: [chapter('ch_one', P[0]), chapter('ch_two', P[2]), chapter('ch_three', P[4])],
            },
            { id: S2, photoIds: [P[5], P[6]] },
            { id: S3, photoIds: [P[7]], visibility: 'draft' },
        ],
    });
});

afterEach(async () => {
    await catalog.cleanup();
});

const layer = () => ({ dataRoot: catalog.root });
const kindOf = (op: SequenceOp) => ('seriesId' in op ? 'series' as const : 'site' as const);
const idOf = (op: SequenceOp) => ('seriesId' in op ? op.seriesId : 'site');

async function series(id = S1): Promise<AuthoredSeries> {
    const record = await readAuthoredRecord(catalog.root, 'series', id);
    if (!record) throw new Error(`No series ${id}`);
    return record;
}

async function versionOf(kind: 'series' | 'site', id: string): Promise<number> {
    return (await readAuthoredRecord(catalog.root, kind, id))?.version ?? 0;
}

/** Apply `op` at the record's current version, unless `options` says otherwise. */
async function apply(op: SequenceOp, options: Partial<ApplyOptions> = {}) {
    return applySequenceOp(layer(), op, { expectedVersion: await versionOf(kindOf(op), idOf(op)), actor: EDITOR, ...options });
}

/** Every file in a record's version folder, or null when it has none. */
const bytes = (kind: 'series' | 'site', id: string) => folderBytes(authoredRecordDir(catalog.root, kind, id));

/** Every authored file's bytes, version history included, for checking an operation wrote nothing. */
const authoredBytes = () => folderBytes(path.join(catalog.root, 'authored'));

async function expectRejected(op: SequenceOp, code: string, extra: Record<string, unknown> = {}, options: Partial<ApplyOptions> = {}) {
    const before = authoredBytes();
    const result = await apply(op, options);
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code, recordId: idOf(op), ...extra }) });
    if (!result.ok) expect(result.error.message.length).toBeGreaterThan(0);
    expect(authoredBytes()).toEqual(before);
}

async function expectUnchanged(op: SequenceOp) {
    const before = authoredBytes();
    const version = await versionOf(kindOf(op), idOf(op));
    expect(await apply(op)).toEqual({ ok: true, changed: false, version, actor: EDITOR, consequences: [] });
    expect(authoredBytes()).toEqual(before);
}

async function expectApplied(op: SequenceOp, consequences: unknown[] = []) {
    const version = await versionOf(kindOf(op), idOf(op));
    expect(await apply(op)).toEqual({ ok: true, changed: true, version: version + 1, actor: EDITOR, consequences });
}

describe('insert', () => {
    it.each([
        ['the start', 'start' as const, [P[8], ...P.slice(0, 5)]],
        ['the middle', { after: P[1] }, [P[0], P[1], P[8], P[2], P[3], P[4]]],
        ['the end', 'end' as const, [...P.slice(0, 5), P[8]]],
    ])('places a new photo at %s', async (_label, at, expected) => {
        await expectApplied({ kind: 'insert', seriesId: S1, photoId: P[8], at });
        expect((await series()).photoIds).toEqual(expected);
    });

    it.each([
        ['start', 'start' as const, P[0]],
        ['after its neighbor', { after: P[1] }, P[2]],
        ['end', 'end' as const, P[4]],
    ])('changes nothing for a member already at the %s', async (_label, at, photoId) => {
        await expectUnchanged({ kind: 'insert', seriesId: S1, photoId, at });
    });

    it('rejects a member placed anywhere else', async () => {
        await expectRejected({ kind: 'insert', seriesId: S1, photoId: P[2], at: 'end' }, 'already-a-member');
    });

    it('rejects a photo #10 has no record of', async () => {
        await expectRejected({ kind: 'insert', seriesId: S1, photoId: UNKNOWN, at: 'end' }, 'unknown-photo');
    });

    it('rejects an anchor that is not a member', async () => {
        await expectRejected({ kind: 'insert', seriesId: S1, photoId: P[8], at: { after: P[9] } }, 'anchor-not-found');
    });

    it('rejects a series that does not exist', async () => {
        await expectRejected({ kind: 'insert', seriesId: 'ser_fixture-09', photoId: P[8], at: 'end' }, 'unknown-series');
    });

    it('rejects a photo another published series holds, and names that series', async () => {
        const before = authoredBytes();
        const result = await apply({ kind: 'insert', seriesId: S1, photoId: P[5], at: 'end' });
        expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'membership-conflict', recordId: S1, message: expect.stringContaining(S2) }) });
        expect(authoredBytes()).toEqual(before);
    });

    it('lets a draft series take a photo a published series holds', async () => {
        await expectApplied({ kind: 'insert', seriesId: S3, photoId: P[5], at: 'end' });
    });

    it('places a photo with no photo record yet, and an archived one: publication rules decide later', async () => {
        fs.rmSync(authoredRecordDir(catalog.root, 'photo', P[8]), { recursive: true });
        const registry = await readRegistry(catalog.root);
        registry.photos[P[9]].sourceHealth = 'archived';
        await writeRegistry(catalog.root, registry, registry.version);
        await expectApplied({ kind: 'insert', seriesId: S1, photoId: P[8], at: 'end' });
        await expectApplied({ kind: 'insert', seriesId: S1, photoId: P[9], at: 'end' });
    });
});

describe('move', () => {
    it.each([
        ['the start', P[3], 'start' as const, [P[3], P[0], P[1], P[2], P[4]]],
        ['the middle', P[3], { after: P[0] }, [P[0], P[3], P[1], P[2], P[4]]],
        ['the end', P[1], 'end' as const, [P[0], P[2], P[3], P[4], P[1]]],
    ])('moves a photo to %s', async (_label, photoId, at, expected) => {
        await expectApplied({ kind: 'move', seriesId: S1, photoId, at });
        expect((await series()).photoIds).toEqual(expected);
    });

    it.each([
        ['start', P[0], 'start' as const],
        ['after its neighbor', P[3], { after: P[2] }],
        ['end', P[4], 'end' as const],
    ])('changes nothing for a photo already at the %s', async (_label, photoId, at) => {
        await expectUnchanged({ kind: 'move', seriesId: S1, photoId, at });
    });

    it('hands a moved start photo\'s chapter to the next photo in the chapter', async () => {
        await expectApplied({ kind: 'move', seriesId: S1, photoId: P[0], at: 'end' }, [
            { kind: 'chapter-anchor-moved', seriesId: S1, chapterId: 'ch_one', fromPhotoId: P[0], toPhotoId: P[1] },
        ]);
        const after = await series();
        expect(after.photoIds).toEqual([P[1], P[2], P[3], P[4], P[0]]);
        expect(after.chapters.map((entry) => [entry.id, entry.startPhotoId])).toEqual([['ch_one', P[1]], ['ch_two', P[2]], ['ch_three', P[4]]]);
    });

    it.each([P[4], P[2]])('rejects moving %s, the last photo of its chapter, and writes nothing', async (photoId) => {
        if (photoId === P[2]) {
            // Make chapter two a single photo: move P3 out of it first.
            await expectApplied({ kind: 'move', seriesId: S1, photoId: P[3], at: { after: P[0] } });
        }
        await expectRejected({ kind: 'move', seriesId: S1, photoId, at: 'start' }, 'chapter-would-be-empty', { message: expect.stringMatching(/ch_(three|two)/) });
    });

    it('rejects a photo that is not a member', async () => {
        await expectRejected({ kind: 'move', seriesId: S1, photoId: P[8], at: 'end' }, 'not-a-member');
    });

    it.each([P[9], P[2]])('rejects an anchor of %s when it is missing or the photo itself', async (anchor) => {
        await expectRejected({ kind: 'move', seriesId: S1, photoId: P[2], at: { after: anchor } }, 'anchor-not-found');
    });
});

describe('remove', () => {
    it('removes a photo from the middle', async () => {
        await expectApplied({ kind: 'remove', seriesId: S1, photoId: P[1] });
        expect((await series()).photoIds).toEqual([P[0], P[2], P[3], P[4]]);
    });

    it('clears the cover and its focal point when the cover photo goes, picks no new one, and blocks publication', async () => {
        await expectApplied({ kind: 'remove', seriesId: S1, photoId: P[0] }, [
            { kind: 'cover-cleared', seriesId: S1, fromPhotoId: P[0] },
            { kind: 'focal-point-dropped', seriesId: S1, fromPhotoId: P[0] },
            { kind: 'chapter-anchor-moved', seriesId: S1, chapterId: 'ch_one', fromPhotoId: P[0], toPhotoId: P[1] },
        ]);
        expect((await series()).cover).toBeNull();
        expect(runRules(await catalog.context()).map((issue) => issue.code)).toContain('order.cover');
    });

    it('clears the opening photo when it goes', async () => {
        await expectApplied({ kind: 'remove', seriesId: S1, photoId: P[3] }, [{ kind: 'opening-cleared', seriesId: S1, fromPhotoId: P[3] }]);
        expect((await series()).openingPhotoId).toBeUndefined();
    });

    it('rejects removing the last photo of a chapter, and names the chapter', async () => {
        await expectRejected({ kind: 'remove', seriesId: S1, photoId: P[4] }, 'chapter-would-be-empty', { message: expect.stringContaining('ch_three') });
    });

    it('rejects a photo that is not a member', async () => {
        await expectRejected({ kind: 'remove', seriesId: S1, photoId: P[8] }, 'not-a-member');
    });

    it('runs as a pure function over several series under one hold without writing, as an archive does', async () => {
        const before = authoredBytes();
        const registry = await readRegistry(catalog.root);
        const { series: all } = await readAuthoredSeries(catalog.root);
        const context = sequenceContext({ registry, series: all });
        const results = all.map((entry) => applySeriesOp(entry, { kind: 'remove', seriesId: entry.id, photoId: P[4] }, context));
        expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual(['chapter-would-be-empty', 'not-a-member', 'not-a-member']);
        expect(authoredBytes()).toEqual(before);
    });
});

describe('setSequence', () => {
    it('sets a whole new order', async () => {
        const next = [P[4], P[0], P[1], P[2], P[3]];
        // P4 starts chapter three, so it can't lead: anchors must stay in order.
        await expectRejected({ kind: 'setSequence', seriesId: S1, photoIds: next }, 'anchor-order');
        await expectApplied({ kind: 'setSequence', seriesId: S1, photoIds: [P[0], P[1], P[8], P[2], P[3], P[4]] });
        expect((await series()).photoIds).toEqual([P[0], P[1], P[8], P[2], P[3], P[4]]);
    });

    it('clears the cover, its focal point, and the opening photo for photos it drops, and hands no anchor off', async () => {
        await apply({ kind: 'setCover', seriesId: S1, photoId: P[1], focalPoint: FOCAL });
        await expectApplied({ kind: 'setSequence', seriesId: S1, photoIds: [P[0], P[2], P[4]] }, [
            { kind: 'cover-cleared', seriesId: S1, fromPhotoId: P[1] },
            { kind: 'focal-point-dropped', seriesId: S1, fromPhotoId: P[1] },
            { kind: 'opening-cleared', seriesId: S1, fromPhotoId: P[3] },
        ]);
        const after = await series();
        expect(after.cover).toBeNull();
        expect(after.openingPhotoId).toBeUndefined();
        expect(after.chapters.map((entry) => entry.startPhotoId)).toEqual([P[0], P[2], P[4]]);
    });

    it('rejects dropping a chapter start photo, and names the chapter', async () => {
        await expectRejected({ kind: 'setSequence', seriesId: S1, photoIds: [P[0], P[1], P[3], P[4]] }, 'anchor-order', { message: expect.stringContaining('ch_two') });
    });

    it('rejects a repeated photo', async () => {
        await expectRejected({ kind: 'setSequence', seriesId: S1, photoIds: [...P.slice(0, 5), P[1]] }, 'duplicate-id', { field: 'photoIds[5]' });
    });

    it('rejects a photo #10 has no record of', async () => {
        await expectRejected({ kind: 'setSequence', seriesId: S1, photoIds: [...P.slice(0, 5), UNKNOWN] }, 'unknown-photo', { field: 'photoIds[5]' });
    });

    it('rejects a photo another published series holds', async () => {
        await expectRejected({ kind: 'setSequence', seriesId: S1, photoIds: [...P.slice(0, 5), P[6]] }, 'membership-conflict');
    });

    it('changes nothing for the same order', async () => {
        await expectUnchanged({ kind: 'setSequence', seriesId: S1, photoIds: P.slice(0, 5) });
    });
});

describe('setCover', () => {
    it('drops the old focal point when the cover changes, and takes the new one given', async () => {
        await expectApplied({ kind: 'setCover', seriesId: S1, photoId: P[2] }, [{ kind: 'focal-point-dropped', seriesId: S1, fromPhotoId: P[0], toPhotoId: P[2] }]);
        expect((await series()).cover).toEqual({ photoId: P[2] });
        await expectApplied({ kind: 'setCover', seriesId: S1, photoId: P[3], focalPoint: { x: 0.5, y: 0.5 } });
        expect((await series()).cover).toEqual({ photoId: P[3], focalPoint: { x: 0.5, y: 0.5 } });
    });

    it('changes only the focal point on the current cover', async () => {
        await expectUnchanged({ kind: 'setCover', seriesId: S1, photoId: P[0] });
        await expectUnchanged({ kind: 'setCover', seriesId: S1, photoId: P[0], focalPoint: FOCAL });
        await expectApplied({ kind: 'setCover', seriesId: S1, photoId: P[0], focalPoint: { x: 0.1, y: 0.9 } });
        expect((await series()).cover).toEqual({ photoId: P[0], focalPoint: { x: 0.1, y: 0.9 } });
        await expectApplied({ kind: 'setCover', seriesId: S1, photoId: P[0], focalPoint: null });
        expect((await series()).cover).toEqual({ photoId: P[0] });
        await expectUnchanged({ kind: 'setCover', seriesId: S1, photoId: P[0], focalPoint: null });
    });

    it('sets a cover on a series that has none', async () => {
        await apply({ kind: 'remove', seriesId: S1, photoId: P[0] });
        await expectApplied({ kind: 'setCover', seriesId: S1, photoId: P[1] });
        expect(runRules(await catalog.context()).map((issue) => issue.code)).not.toContain('order.cover');
    });

    it('rejects a photo that is not a member', async () => {
        await expectRejected({ kind: 'setCover', seriesId: S1, photoId: P[5] }, 'not-a-member');
    });
});

describe('setOpeningPhoto', () => {
    it('sets, keeps, and clears the opening photo', async () => {
        await expectApplied({ kind: 'setOpeningPhoto', seriesId: S1, photoId: P[1] });
        await expectUnchanged({ kind: 'setOpeningPhoto', seriesId: S1, photoId: P[1] });
        await expectApplied({ kind: 'setOpeningPhoto', seriesId: S1, photoId: null });
        expect((await series()).openingPhotoId).toBeUndefined();
        await expectUnchanged({ kind: 'setOpeningPhoto', seriesId: S1, photoId: null });
    });

    it('rejects a photo that is not a member', async () => {
        await expectRejected({ kind: 'setOpeningPhoto', seriesId: S1, photoId: P[8] }, 'not-a-member');
    });
});

describe('chapters', () => {
    it('adds a chapter in sequence order with a new ID', async () => {
        await expectApplied({ kind: 'addChapter', seriesId: S1, title: 'Fixture chapter added', startPhotoId: P[3] });
        const chapters = (await series()).chapters;
        expect(chapters.map((entry) => entry.startPhotoId)).toEqual([P[0], P[2], P[3], P[4]]);
        expect(chapters[2]).toEqual({ id: expect.stringMatching(/^ch_[0-9a-f-]{36}$/), title: 'Fixture chapter added', startPhotoId: P[3] });
    });

    it('rejects a chapter on a photo that already starts one, or on a non-member', async () => {
        await expectRejected({ kind: 'addChapter', seriesId: S1, title: 'Fixture chapter', startPhotoId: P[2] }, 'anchor-conflict');
        await expectRejected({ kind: 'addChapter', seriesId: S1, title: 'Fixture chapter', startPhotoId: P[8] }, 'not-a-member');
    });

    it('moves a chapter start within its place in the order', async () => {
        await expectApplied({ kind: 'moveChapterStart', seriesId: S1, chapterId: 'ch_two', startPhotoId: P[3] });
        expect((await series()).chapters.map((entry) => entry.startPhotoId)).toEqual([P[0], P[3], P[4]]);
        await expectUnchanged({ kind: 'moveChapterStart', seriesId: S1, chapterId: 'ch_two', startPhotoId: P[3] });
    });

    it('rejects moving a chapter start onto another chapter\'s start, past it, or to an unknown chapter', async () => {
        await expectRejected({ kind: 'moveChapterStart', seriesId: S1, chapterId: 'ch_two', startPhotoId: P[4] }, 'anchor-conflict');
        await expectRejected({ kind: 'moveChapterStart', seriesId: S1, chapterId: 'ch_one', startPhotoId: P[3] }, 'anchor-order');
        await expectRejected({ kind: 'moveChapterStart', seriesId: S1, chapterId: 'ch_nine', startPhotoId: P[3] }, 'anchor-not-found');
        await expectRejected({ kind: 'moveChapterStart', seriesId: S1, chapterId: 'ch_two', startPhotoId: P[8] }, 'not-a-member');
    });

    it('removes a chapter, and rejects one that does not exist', async () => {
        await expectApplied({ kind: 'removeChapter', seriesId: S1, chapterId: 'ch_two' });
        expect((await series()).chapters.map((entry) => entry.id)).toEqual(['ch_one', 'ch_three']);
        await expectRejected({ kind: 'removeChapter', seriesId: S1, chapterId: 'ch_two' }, 'anchor-not-found');
    });
});

describe('Work order and featured order', () => {
    it.each(['setSeriesOrder', 'setFeaturedSeries'] as const)('%s sets the order, and changes nothing for the same order', async (kind) => {
        await expectApplied({ kind, seriesIds: [S2, S1] });
        const site = await readAuthoredRecord(catalog.root, 'site', 'site');
        expect(kind === 'setSeriesOrder' ? site?.seriesOrder : site?.featuredSeriesIds).toEqual([S2, S1]);
        await expectUnchanged({ kind, seriesIds: [S2, S1] });
    });

    it.each(['setSeriesOrder', 'setFeaturedSeries'] as const)('%s rejects an unknown or repeated series', async (kind) => {
        await expectRejected({ kind, seriesIds: [S1, 'ser_fixture-09'] }, 'unknown-series', { field: 'seriesIds[1]' });
        await expectRejected({ kind, seriesIds: [S1, S2, S1] }, 'duplicate-id', { field: 'seriesIds[2]' });
    });

    it('lets a draft series hold a Work order slot', async () => {
        await expectApplied({ kind: 'setSeriesOrder', seriesIds: [S3, S1, S2] });
    });

    it('creates the site record at version 0 when there is none', async () => {
        fs.rmSync(authoredRecordDir(catalog.root, 'site', 'site'), { recursive: true });
        expect(await apply({ kind: 'setSeriesOrder', seriesIds: [S1] }, { expectedVersion: 0 })).toMatchObject({ ok: true, changed: true, version: 1 });
        expect(await readAuthoredRecord(catalog.root, 'site', 'site')).toMatchObject({ seriesOrder: [S1], featuredSeriesIds: [] });
    });
});

describe('compare-and-swap', () => {
    it('rejects a stale expectedVersion with version-conflict and writes nothing', async () => {
        const version = await versionOf('series', S1);
        await expectRejected({ kind: 'remove', seriesId: S1, photoId: P[1] }, 'version-conflict', {}, { expectedVersion: version - 1 });
        await expectRejected({ kind: 'setSeriesOrder', seriesIds: [S2, S1] }, 'version-conflict', {}, { expectedVersion: 7 });
    });

    it('checks the version before deciding an operation changes nothing', async () => {
        await expectRejected({ kind: 'move', seriesId: S1, photoId: P[4], at: 'end' }, 'version-conflict', {}, { expectedVersion: 0 });
    });

    it('lets one of two writers with the same expectedVersion through', async () => {
        const expectedVersion = await versionOf('series', S1);
        const results = await Promise.all([
            applySequenceOp(layer(), { kind: 'insert', seriesId: S1, photoId: P[8], at: 'end' }, { expectedVersion, actor: EDITOR }),
            applySequenceOp(layer(), { kind: 'insert', seriesId: S1, photoId: P[9], at: 'end' }, { expectedVersion, actor: EDITOR }),
        ]);
        expect(results.map((result) => (result.ok ? 'ok' : result.error.code)).sort()).toEqual(['ok', 'version-conflict']);
        const after = await series();
        expect(after.version).toBe(expectedVersion + 1);
        expect(after.photoIds.filter((id) => id === P[8] || id === P[9])).toHaveLength(1);
    });

    it('turns the writer\'s own compare-and-swap failure into version-conflict, and writes nothing', async () => {
        // A version lands after the in-hold check, while the op's write is staged: a hand copy, or a writer past its
        // lease. Only the writer's compare-and-swap can see it, and its VERSION_CONFLICT must come back as a result.
        const stored = await series();
        const dir = authoredRecordDir(catalog.root, 'series', S1);
        const handMade = versionText({ ...stored, title: 'Fixture hand edit' }, stored.version + 1);
        const before = bytes('series', S1);
        const result = await apply({ kind: 'move', seriesId: S1, photoId: P[1], at: 'end' }, {
            hooks: { afterStage: () => fs.writeFileSync(versionFile(dir, stored.version + 1), handMade) },
        });
        expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'version-conflict', recordId: S1, message: expect.stringContaining(`version ${stored.version + 1}`) }) });
        expect(bytes('series', S1)).toEqual({ ...before, [`v${stored.version + 1}.json`]: handMade });
        expect(await series()).toMatchObject({ version: stored.version + 1, title: 'Fixture hand edit', photoIds: stored.photoIds });
    });

    it('lets writers on different records both through', async () => {
        const results = await Promise.all([
            apply({ kind: 'move', seriesId: S1, photoId: P[1], at: 'end' }),
            apply({ kind: 'move', seriesId: S2, photoId: P[5], at: 'end' }),
            apply({ kind: 'setFeaturedSeries', seriesIds: [S2] }),
        ]);
        expect(results.map((result) => result.ok && result.changed)).toEqual([true, true, true]);
    });

    it('lets only one of two published series take the same photo at once', async () => {
        const results = await Promise.all([
            apply({ kind: 'insert', seriesId: S1, photoId: P[8], at: 'end' }),
            apply({ kind: 'insert', seriesId: S2, photoId: P[8], at: 'end' }),
        ]);
        expect(results.map((result) => (result.ok ? 'ok' : result.error.code)).sort()).toEqual(['membership-conflict', 'ok']);
        const holders = (await readAuthoredSeries(catalog.root)).series.filter((entry) => entry.photoIds.includes(P[8]));
        expect(holders).toHaveLength(1);
    });
});

describe('the authored lock', () => {
    it('reuses a hold the caller passes', async () => {
        const expectedVersion = await versionOf('series', S1);
        const result = await withLock('authored', { root: catalog.root, leaseMs: 10_000 }, (hold) =>
            applySequenceOp(layer(), { kind: 'remove', seriesId: S1, photoId: P[1] }, { expectedVersion, actor: { kind: 'inbox-approval', ref: 'fixture-decision' }, lock: hold }));
        expect(result).toEqual({ ok: true, changed: true, version: expectedVersion + 1, actor: { kind: 'inbox-approval', ref: 'fixture-decision' }, consequences: [] });
    });

    it('refuses a hold of another lock', async () => {
        await expect(withLock('registry', { root: catalog.root, leaseMs: 10_000 }, async (hold) =>
            applySequenceOp(layer(), { kind: 'remove', seriesId: S1, photoId: P[1] }, { expectedVersion: 1, actor: EDITOR, lock: hold }))).rejects.toThrow(/authored lock/);
    });

    it('returns authored-locked after waitMs while another process holds the lock, and writes nothing', async () => {
        const log = path.join(path.dirname(catalog.root), 'lock.log');
        const holder = runTsx('test/helpers/storageWorker.ts', ['lock', JSON.stringify({ root: catalog.root, name: 'authored', leaseMs: 10_000, waitMs: 0, holdMs: 4_000, log, id: 'holder', startAt: 0 })]);
        while (!fs.existsSync(log) || !fs.readFileSync(log, 'utf8').includes('enter holder')) await new Promise((resolve) => setTimeout(resolve, 25));
        const before = authoredBytes();
        const started = Date.now();
        const result = await apply({ kind: 'remove', seriesId: S1, photoId: P[1] }, { waitMs: 200 });
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'authored-locked', recordId: S1, message: expect.stringContaining('held by') }) });
        expect(authoredBytes()).toEqual(before);
        expect((await holder).code).toBe(0);
    }, 20_000);
});

describe('the operation contract', () => {
    it('returns the actor it was given', async () => {
        const actor: Actor = { kind: 'policy', ref: 'fixture-policy' };
        expect(await apply({ kind: 'move', seriesId: S1, photoId: P[1], at: 'end' }, { actor })).toMatchObject({ ok: true, actor });
    });

    it('refuses an unknown actor kind', async () => {
        await expect(apply({ kind: 'move', seriesId: S1, photoId: P[1], at: 'end' }, { actor: { kind: 'watcher' } as unknown as Actor })).rejects.toThrow(TypeError);
    });

    it('refuses a data root that is not ready, before taking a lock in it', async () => {
        fs.rmSync(path.join(catalog.root, 'data-root.json'));
        await expect(apply({ kind: 'move', seriesId: S1, photoId: P[1], at: 'end' }, { expectedVersion: 1 })).rejects.toThrow(/data root/);
        expect(fs.existsSync(path.join(catalog.root, 'locks'))).toBe(false);
    });

    it('never changes the record a pure operation is given', async () => {
        const record = await series();
        const copy = structuredClone(record);
        const context = sequenceContext({ registry: await readRegistry(catalog.root), series: [record] });
        const ops: SeriesOp[] = [
            { kind: 'remove', seriesId: S1, photoId: P[0] },
            { kind: 'move', seriesId: S1, photoId: P[0], at: 'end' },
            { kind: 'setSequence', seriesId: S1, photoIds: [P[0], P[2], P[4]] },
            { kind: 'setCover', seriesId: S1, photoId: P[2], focalPoint: { x: 0, y: 1 } },
            { kind: 'addChapter', seriesId: S1, title: 'Fixture chapter', startPhotoId: P[1] },
        ];
        for (const op of ops) applySeriesOp(record, op, context);
        expect(record).toEqual(copy);
    });

    it('leaves the registry alone', async () => {
        const before = folderBytes(identityPaths(catalog.root).registry);
        await apply({ kind: 'insert', seriesId: S1, photoId: P[8], at: 'end' });
        expect(folderBytes(identityPaths(catalog.root).registry)).toEqual(before);
        expect(bytes('series', S2)).not.toBeNull();
    });
});
