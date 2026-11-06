// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPublishFixture, editBehindThePage, LOW_TIDE, PIER_LAMPS, reopenBreakwater, SALT_ROADS, BREAKWATER, type PublishFixture } from '../../../test/helpers/publishFixture';
import { changeId, diffCatalog, type CatalogChange } from '../diff';
import { compileCandidate } from '../compile';
import { reviewArgs, runDiffCommand, runReviewCommand } from '../ledger-cli';
import { UsageError } from '../owner-cli';
import { validateWorkingLayer } from '../publish';
import { readRevisionFile } from '../repository';
import { hashValue } from '../review';
import { readReviewContext } from '../review-context';
import { ReviewRefusedError } from '../review-write';
import { assetGuard, authoredFromPublished, publishedValueOffer, USE_PUBLISHED_FIELDS } from '../use-published-rules';
import { writePublishedValue } from '../use-published';
import { readActivePointer, readAuthoredRecord, readWorkingLayer } from '../working-layer';
import { AuthoredWriteError, writeAuthoredRecord } from '../working-layer-writer';
import { readRegistry } from '../../identity/registry';
import type { AuthoredPhoto, AuthoredSeries, RevisionContent, WorkingLayer } from '../types';

/**
 * A9's "Use the published value" (#182): one writer in lib/catalog that the
 * Publish screen and `photos review --use-published` share. It writes the
 * live revision's value back into the draft as an authored write, under the
 * authored lock with the record's version, and only for a field whose review
 * went stale because the live revision moved, or that a restore's rebase left
 * in conflict. On the Publish screen's fixture, Salt Roads' order was
 * reviewed against revision 1 and revision 2 published it differently.
 */

let fixture: PublishFixture;

beforeEach(async () => {
    fixture = await createPublishFixture();
}, 60_000);

afterEach(async () => {
    await fixture.cleanup();
});

const MOVED = changeId({ kind: 'series', id: SALT_ROADS }, `photoIds[${PIER_LAMPS}]`, 'moved');
const ADDED = changeId({ kind: 'photo', id: BREAKWATER }, '', 'new');
const SHORT = changeId({ kind: 'series', id: LOW_TIDE }, 'shortStatement', 'authored');

/** The diff as the Publish screen and photos diff read it. */
async function read() {
    const root = fixture.root;
    const layer = await readWorkingLayer(root);
    const registry = await readRegistry(root);
    const pointer = await readActivePointer(root);
    const active = pointer ? await readRevisionFile(root, pointer.revisionId) : null;
    const compiled = await compileCandidate({ layer, registry, root, active });
    const review = await readReviewContext(root, layer, active?.revisionId ?? null);
    const diff = diffCatalog({ active, candidate: compiled.content, authored: layer, registry, review });
    return { layer, active, review, diff, candidateId: compiled.candidateId };
}

const rowOf = (diff: { changes: CatalogChange[] }, id: string) => {
    const change = diff.changes.find((entry) => entry.id === id);
    if (!change) throw new Error(`No row ${id}`);
    return change;
};

async function series(id: string): Promise<AuthoredSeries> {
    return (await readAuthoredRecord(fixture.root, 'series', id)) as AuthoredSeries;
}

const inputFor = async (field: 'photoIds' | 'shortStatement', id = SALT_ROADS) => {
    const record = await series(id);
    return { root: fixture.root, record: { kind: 'series' as const, id }, field, version: record.version, valueHash: hashValue(record[field]), baseRevisionId: fixture.revisions[1], actor: 'keyur' };
};

describe('which rows offer it', () => {
    it("offers it on a stale order's move, naming the whole field it puts back, and not on a suggested description or a reviewed row", async () => {
        const { layer, active, review, diff } = await read();
        const moved = publishedValueOffer(rowOf(diff, MOVED), { layer, active: active?.content ?? null, review });
        expect(moved).toMatchObject({ ok: true, target: { record: { kind: 'series', id: SALT_ROADS }, field: 'photoIds', version: (await series(SALT_ROADS)).version } });
        expect(publishedValueOffer(rowOf(diff, ADDED), { layer, active: active?.content ?? null, review })).toMatchObject({ ok: false });
        expect(publishedValueOffer(rowOf(diff, SHORT), { layer, active: active?.content ?? null, review })).toMatchObject({ ok: false });
    });

    it('lists the fields it can put back, and never a route, the Work order, the bytes or the capture date', () => {
        expect(USE_PUBLISHED_FIELDS.photo).toEqual(['alt', 'title', 'caption', 'credit', 'location', 'focalPoint', 'crop', 'accent']);
        expect(USE_PUBLISHED_FIELDS.series).toEqual(['title', 'statement', 'shortStatement', 'cover', 'chapters', 'openingPhotoId', 'accent', 'photoIds']);
        expect(USE_PUBLISHED_FIELDS.site).toEqual(['featuredSeriesIds']);
        for (const field of ['slug', 'slugAliases', 'visibility', 'seriesOrder', 'assetRevision', 'capturedAt']) {
            expect([...USE_PUBLISHED_FIELDS.photo, ...USE_PUBLISHED_FIELDS.series, ...USE_PUBLISHED_FIELDS.site]).not.toContain(field);
        }
    });

    it('turns a published value into the authored one: a description is reviewed, an absent field goes, and a place-named photo has nothing to put back', async () => {
        const photo = { kind: 'photo', alt: { kind: 'described', text: 'Old words', reviewed: false }, caption: 'A caption' } as unknown as AuthoredPhoto;
        expect(authoredFromPublished(photo, 'alt', { kind: 'described', text: 'Published words' })).toEqual({ ok: true, value: { kind: 'described', text: 'Published words', reviewed: true } });
        expect(authoredFromPublished(photo, 'alt', { kind: 'decorative' })).toEqual({ ok: true, value: { kind: 'decorative' } });
        expect(authoredFromPublished(photo, 'alt', { kind: 'position' })).toMatchObject({ ok: false });
        expect(authoredFromPublished(photo, 'caption', null)).toEqual({ ok: true, value: undefined });
        const record = await series(SALT_ROADS);
        // The order only when the members are the same: putting back a list without a new photograph would take it off the series.
        expect(authoredFromPublished(record, 'photoIds', [...record.photoIds].reverse())).toMatchObject({ ok: true });
        expect(authoredFromPublished(record, 'photoIds', record.photoIds.slice(1))).toMatchObject({ ok: false });
        expect(authoredFromPublished(record, 'slug', 'other')).toMatchObject({ ok: false });
    });
});

describe('the review fixes (A9 review)', () => {
    const A = `sha256-${'a'.repeat(64)}`;
    const B = `sha256-${'b'.repeat(64)}`;
    const P = 'ph_00000000-0000-4000-8000-000000000001';
    const Q = 'ph_00000000-0000-4000-8000-000000000002';
    const R = 'ph_00000000-0000-4000-8000-000000000003';
    const stamp = (assetRevision?: string) => ({ valueHash: hashValue('Old caption'), origin: 'curator' as const, baseRevisionId: null, ...(assetRevision ? { assetRevision } : {}), actor: 'keyur', reviewedAt: '2026-10-01T00:00:00.000Z' });
    const photo = (assetRevision: string, stamped?: string) => ({ kind: 'photo', id: P, assetRevision, caption: 'Old caption', alt: null, review: { fields: { caption: stamp(stamped) } } }) as unknown as AuthoredPhoto;
    const live = (assetRevision: string): RevisionContent => ({ site: { featuredSeriesIds: [] }, series: [], photos: [{ id: P, assetRevision } as never] });
    const layerWith = (...records: object[]): WorkingLayer => ({ site: null, series: records.filter((record) => (record as { kind: string }).kind === 'series') as never, photos: records.filter((record) => (record as { kind: string }).kind === 'photo') as never, problems: [] });

    it('refuses to put back a field that describes the image once the photograph has new bytes, live or since its review (should-fix 6)', () => {
        const replaced = photo(B, A);
        expect(assetGuard(replaced, 'caption', layerWith(replaced), live(A))).toMatchObject({ ok: false, why: expect.stringMatching(/new image/) });
        // The live revision has the draft's bytes, but the review was of others.
        expect(assetGuard(replaced, 'caption', layerWith(replaced), live(B))).toMatchObject({ ok: false });
        const same = photo(A, A);
        expect(assetGuard(same, 'caption', layerWith(same), live(A))).toEqual({ ok: true });
        // A field that doesn't describe the image isn't held back.
        expect(assetGuard(replaced, 'credit', layerWith(replaced), live(A))).toEqual({ ok: true });
    });

    it("refuses a series cover whose photograph has new bytes (should-fix 6)", () => {
        const coverPhoto = { kind: 'photo', id: P, assetRevision: B, alt: null } as unknown as AuthoredPhoto;
        const series = { kind: 'series', id: 'ser_x', photoIds: [P], cover: { photoId: P }, chapters: [], review: { fields: { cover: { ...stamp(A), valueHash: hashValue({ photoId: P }) } } } } as unknown as AuthoredSeries;
        expect(assetGuard(series, 'cover', layerWith(series, coverPhoto), live(A))).toMatchObject({ ok: false, why: expect.stringMatching(/new image/) });
        const settled = { ...coverPhoto, assetRevision: A } as AuthoredPhoto;
        expect(assetGuard(series, 'cover', layerWith(series, settled), live(A))).toEqual({ ok: true });
    });

    it("refuses chapters, a cover or an opening photograph naming a photograph the draft's series doesn't hold, and names it (should-fix 7)", () => {
        const series = { kind: 'series', id: 'ser_x', photoIds: [P, Q], chapters: [], cover: { photoId: P } } as unknown as AuthoredSeries;
        expect(authoredFromPublished(series, 'chapters', [{ id: 'ch', title: 'Dawn', startPhotoId: R }])).toMatchObject({ ok: false, why: expect.stringContaining(R) });
        expect(authoredFromPublished(series, 'cover', { photoId: R })).toMatchObject({ ok: false, why: expect.stringContaining(R) });
        expect(authoredFromPublished(series, 'openingPhotoId', R)).toMatchObject({ ok: false, why: expect.stringContaining(R) });
        expect(authoredFromPublished(series, 'chapters', [{ id: 'ch', title: 'Dawn', startPhotoId: Q }])).toMatchObject({ ok: true });
        expect(authoredFromPublished(series, 'cover', { photoId: Q })).toMatchObject({ ok: true });
        expect(authoredFromPublished(series, 'openingPhotoId', Q)).toMatchObject({ ok: true });
    });
});

describe('writePublishedValue()', () => {
    it("writes the live revision's order back as an authored write, so the stale rows go and the draft changes", async () => {
        const before = await read();
        const published = (before.active?.content.series.find((entry) => entry.id === SALT_ROADS) as { photoIds: string[] }).photoIds;
        const old = await series(SALT_ROADS);
        const written = await writePublishedValue(await inputFor('photoIds'));
        expect(written.version).toBe(old.version + 1);
        const now = await series(SALT_ROADS);
        expect(now.photoIds).toEqual(published);
        expect(now.review?.fields.photoIds).toMatchObject({ origin: 'curator', baseRevisionId: fixture.revisions[1], actor: 'keyur', valueHash: hashValue(published) });
        const after = await read();
        expect(after.diff.changes.some((change) => change.record.id === SALT_ROADS && change.category === 'moved')).toBe(false);
        expect(after.candidateId).not.toBe(before.candidateId);
    });

    it('refuses and writes nothing when the version, the value or the live revision moved', async () => {
        const input = await inputFor('photoIds');
        const version = (await series(SALT_ROADS)).version;
        await expect(writePublishedValue({ ...input, version: input.version - 1 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
        await expect(writePublishedValue({ ...input, valueHash: hashValue(['ph_other']) })).rejects.toBeInstanceOf(AuthoredWriteError);
        await expect(writePublishedValue({ ...input, baseRevisionId: fixture.revisions[0] })).rejects.toMatchObject({ code: 'active-moved' });
        expect((await series(SALT_ROADS)).version).toBe(version);
    });

    it("refuses a field whose review isn't stale against the live revision, and one it can't put back", async () => {
        await expect(writePublishedValue(await inputFor('shortStatement', LOW_TIDE))).rejects.toBeInstanceOf(ReviewRefusedError);
        const record = await series(SALT_ROADS);
        await expect(writePublishedValue({ ...(await inputFor('photoIds')), field: 'slug', valueHash: hashValue(record.slug) })).rejects.toMatchObject({ code: 'not-clearable' });
    });

    it('refuses a field an Inbox item that needs a decision again rests on, before anything else', async () => {
        await reopenBreakwater(fixture);
        const version = (await series(LOW_TIDE)).version;
        await expect(writePublishedValue(await inputFor('photoIds', LOW_TIDE))).rejects.toMatchObject({ code: 'inbox' });
        expect((await series(LOW_TIDE)).version).toBe(version);
    });

    it("settles a restore's conflict: the live value goes in and the conflict entry goes", async () => {
        const record = await series(LOW_TIDE);
        const live = (await read()).active?.content.series.find((entry) => entry.id === LOW_TIDE)?.shortStatement;
        await writeAuthoredRecord({ ...record, conflicts: [{ field: 'shortStatement', base: 'Base words.', active: live ?? null }] }, { expectedVersion: record.version, root: fixture.root });
        const conflicted = await series(LOW_TIDE);
        await writePublishedValue({ root: fixture.root, record: { kind: 'series', id: LOW_TIDE }, field: 'shortStatement', version: conflicted.version, valueHash: hashValue(conflicted.shortStatement), baseRevisionId: fixture.revisions[1], actor: 'keyur' });
        const settled = await series(LOW_TIDE);
        expect(settled.shortStatement).toBe(live);
        expect(settled.conflicts ?? []).toEqual([]);
    });
});

describe('photos review --use-published', () => {
    const candidate = async () => {
        const result = await validateWorkingLayer({ dataRoot: fixture.root });
        return result.candidateId as string;
    };

    it('takes one change ID, with the same --expect and --expect-active as photos review', () => {
        const expectId = `rev_${'a'.repeat(64)}`;
        expect(reviewArgs([MOVED, '--use-published', '--expect', expectId, '--expect-active', 'none', '--actor', 'keyur'])).toMatchObject({ changeIds: [MOVED], usePublished: true });
        expect(() => reviewArgs([MOVED, ADDED, '--use-published', '--expect', expectId, '--expect-active', 'none', '--actor', 'keyur'])).toThrow(UsageError);
        expect(reviewArgs([MOVED, '--expect', expectId, '--expect-active', 'none', '--actor', 'keyur']).usePublished).toBe(false);
    });

    it('puts the published order back through the same writer, and says the draft changed', async () => {
        const result = await runReviewCommand(fixture.root, { changeIds: [MOVED], expect: await candidate(), expectActive: fixture.revisions[1], actor: 'keyur', usePublished: true });
        expect(result.exitCode).toBe(0);
        expect(result.output).toMatch(/^\[photos\] USED_PUBLISHED: /);
        expect(result.output).toContain('Salt Roads');
        expect(result.output).toContain('photos diff');
        expect(result.output).not.toContain(fixture.root);
        const published = (await read()).active?.content.series.find((entry) => entry.id === SALT_ROADS)?.photoIds;
        expect((await series(SALT_ROADS)).photoIds).toEqual(published);
    });

    it('refuses a row it can\'t put back with exit 1, and a draft that moved with exit 3, writing nothing', async () => {
        const version = (await series(SALT_ROADS)).version;
        const refused = await runReviewCommand(fixture.root, { changeIds: [ADDED], expect: await candidate(), expectActive: fixture.revisions[1], actor: 'keyur', usePublished: true });
        expect(refused.exitCode).toBe(1);
        const stale = await candidate();
        await editBehindThePage(fixture);
        const moved = await runReviewCommand(fixture.root, { changeIds: [MOVED], expect: stale, expectActive: fixture.revisions[1], actor: 'keyur', usePublished: true });
        expect(moved.exitCode).toBe(3);
        expect((await series(SALT_ROADS)).version).toBe(version);
    });

    it('is named in photos diff, in the text and in the JSON', async () => {
        const text = await runDiffCommand(fixture.root, { json: false });
        expect(text.output).toContain(`photos review --use-published ${MOVED} --expect `);
        const out = JSON.parse((await runDiffCommand(fixture.root, { json: true })).output) as { schemaVersion: number; rows: { id: string; usePublished: boolean }[] };
        expect(out.schemaVersion).toBe(1);
        expect(out.rows.find((row) => row.id === MOVED)?.usePublished).toBe(true);
        expect(out.rows.find((row) => row.id === ADDED)?.usePublished).toBe(false);
    });
});
