// @vitest-environment node
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { versionFile } from '../../storage/document';
import { revisionIdOf } from '../schema';
import { blockingIssues, publish, validateStored, validateWorkingLayer, type PublishResult } from '../publish';
import { readRevisionFile } from '../repository';
import { hashValue } from '../review';
import { rollback } from '../rollback';
import { registeredRules, runRules } from '../ruleset';
import { applySequenceOp } from '../sequence';
import { createTestCatalog, type TestCatalogOptions } from '../testing';
import type { AuthoredPhoto, AuthoredRecord, AuthoredSeries, AuthoredSite, Issue, RevisionFile } from '../types';
import { writeAuthoredRecord } from '../working-layer-writer';
import { authoredRecordDir, readAuthoredRecord } from '../working-layer';
import { VARIANT_BYTES } from './catalogFixtures';

/**
 * #16's review stamps on disk: what writeAuthoredRecord() stamps, what a
 * rebase keeps, and the publish gate that reads them, through publish(),
 * validate, and #15's rollback.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

const quiet = { log: () => undefined };
const ACTOR = 'curator:test';
const AT = '2026-05-01T00:00:00.000Z';

async function fixture(options: TestCatalogOptions = { photos: 4, series: 1 }) {
    const catalog = await createTestCatalog({ variantBytes: VARIANT_BYTES, ...options });
    cleanups.push(() => catalog.cleanup());
    const root = catalog.root;
    const read = async <R extends AuthoredRecord>(kind: R['kind'], id: string) => (await readAuthoredRecord(root, kind, id)) as unknown as R;
    return {
        catalog,
        root,
        read,
        publish: (extra: Partial<Parameters<typeof publish>[0]> = {}) => publish({ dataRoot: root, actor: 'test', confirmLaunch: true, logger: quiet, ...extra }),
        /** Write through the writer, as #13 slice D's commands do. */
        async edit<R extends AuthoredRecord>(kind: R['kind'], id: string, change: (record: R) => void, options: Partial<Parameters<typeof writeAuthoredRecord>[1]> = {}) {
            const found = await read<R>(kind, id);
            const next = structuredClone(found);
            change(next);
            return writeAuthoredRecord(next as never, { expectedVersion: found.version, root, ...options }) as Promise<R>;
        },
        /** A hand edit: the newest version copied to the next number and changed, as docs/data-root.md describes. */
        async handEdit<R extends AuthoredRecord>(kind: R['kind'], id: string, change: (record: Record<string, unknown>) => void) {
            const found = await read<R>(kind, id);
            const dir = authoredRecordDir(root, kind, id);
            const copy = JSON.parse(fs.readFileSync(versionFile(dir, found.version), 'utf8')) as Record<string, unknown>;
            change(copy);
            // The copy keeps the stamp it was copied with, which names the version before it: a version made by hand.
            fs.writeFileSync(versionFile(dir, found.version + 1), `${JSON.stringify(copy, null, 2)}\n`, { mode: 0o600 });
        },
    };
}

const reviewIssues = (result: { issues: Issue[] }) => result.issues.filter((issue) => issue.code.startsWith('review.'));
const published = (result: PublishResult) => {
    expect(result.outcome, result.message).toBe('PUBLISHED');
    return result.revisionId as string;
};

describe('writeAuthoredRecord() stamps', { timeout: 60_000 }, () => {
    it('stamps every field a new record carries, against the active revision, as the CLI with no review inputs', async () => {
        const f = await fixture();
        const first = published(await f.publish());
        const photo = f.catalog.photos[0];
        const id = 'ph_00000000-0000-4000-8000-00000000c0de';
        const written = await writeAuthoredRecord({ kind: 'photo', id, assetRevision: photo.assetRevision, alt: { kind: 'described', text: 'Fixture typed.', reviewed: true }, title: 'Fixture title.' }, { expectedVersion: 0, root: f.root });
        expect(Object.keys(written.review?.fields ?? {}).sort()).toEqual(['alt', 'assetRevision', 'title']);
        expect(written.review?.fields.title).toEqual({ valueHash: hashValue('Fixture title.'), origin: 'curator', baseRevisionId: first, assetRevision: photo.assetRevision, actor: 'cli', reviewedAt: expect.any(String) });
    });

    it('restamps only what a write changed, with the review inputs it was given, and keeps every other stamp as it was', async () => {
        const f = await fixture();
        const first = published(await f.publish());
        const id = f.catalog.photos[0].id;
        const titled = await f.edit<AuthoredPhoto>('photo', id, (photo) => {
            photo.title = 'Fixture title, first.';
        });
        const captioned = await f.edit<AuthoredPhoto>('photo', id, (photo) => {
            photo.caption = 'Fixture caption.';
        }, { review: { baseRevisionId: first, event: { id: 'evt_000000000000000000000abc', version: 3 }, actor: ACTOR, reviewedAt: AT } });
        expect(captioned.review?.fields.title).toEqual(titled.review?.fields.title);
        expect(captioned.review?.fields.caption).toEqual({ valueHash: hashValue('Fixture caption.'), origin: 'curator', baseRevisionId: first, assetRevision: titled.assetRevision, event: { id: 'evt_000000000000000000000abc', version: 3 }, actor: ACTOR, reviewedAt: AT });
        expect(captioned.review?.fields.caption).not.toHaveProperty('asset');
    });

    it('keeps the asset inputs for assetRevision alone', async () => {
        const f = await fixture();
        published(await f.publish());
        const photo = f.catalog.photos[0];
        const other = f.catalog.photos[1].assetRevision;
        const written = await f.edit<AuthoredPhoto>('photo', photo.id, (record) => {
            record.assetRevision = other;
            record.title = 'Fixture title.';
        }, { review: { baseRevisionId: null, asset: { from: photo.assetRevision, to: other, profileId: f.catalog.profileId }, actor: ACTOR, reviewedAt: AT } });
        expect(written.review?.fields.assetRevision).toMatchObject({ asset: { from: photo.assetRevision, to: other, profileId: f.catalog.profileId }, assetRevision: other });
        expect(written.review?.fields.title).not.toHaveProperty('asset');
        expect(written.review?.fields.title).toMatchObject({ assetRevision: other });
    });

    it('writes an existing record when the active pointer can\'t be read, stamping it against the record\'s base', async () => {
        const f = await fixture();
        const first = published(await f.publish());
        const id = f.catalog.photos[0].id;
        const before = await f.read<AuthoredPhoto>('photo', id);
        fs.writeFileSync(versionFile(`${f.root}/catalog/active`, 2), '{"schemaVersion": 1, "version": 2}\n', { mode: 0o600 });
        const written = await f.edit<AuthoredPhoto>('photo', id, (photo) => {
            photo.caption = 'Fixture caption.';
        });
        expect(written.version).toBe(before.version + 1);
        expect(written.review?.fields.caption).toMatchObject({ baseRevisionId: first });
    });

    it('stamps a suggested description as generated, until the curator marks it reviewed', async () => {
        const f = await fixture();
        published(await f.publish());
        const id = f.catalog.photos[0].id;
        const suggested = await f.edit<AuthoredPhoto>('photo', id, (photo) => {
            photo.alt = { kind: 'described', text: 'Fixture suggested.', reviewed: false };
        });
        expect(suggested.review?.fields.alt).toMatchObject({ origin: 'generated' });
        const accepted = await f.edit<AuthoredPhoto>('photo', id, (photo) => {
            photo.alt = { kind: 'described', text: 'Fixture suggested.', reviewed: true };
        });
        expect(accepted.review?.fields.alt).toMatchObject({ origin: 'curator' });
    });

    it('owns the stamps: a caller\'s review field is dropped, as every managed field is', async () => {
        const f = await fixture();
        published(await f.publish());
        const id = f.catalog.photos[0].id;
        const written = await f.edit<AuthoredPhoto>('photo', id, (photo) => {
            photo.caption = 'Fixture caption.';
            (photo as { review?: unknown }).review = { fields: { caption: { valueHash: '0'.repeat(64), origin: 'curator', baseRevisionId: null, actor: 'forged', reviewedAt: AT } } };
        });
        expect(written.review?.fields.caption).toMatchObject({ valueHash: hashValue('Fixture caption.'), actor: 'cli' });
    });

    it('stores the backfill for the fields the first write of a record without stamps leaves alone, once', async () => {
        const f = await fixture();
        const id = f.catalog.photos[0].id;
        expect((await f.read<AuthoredPhoto>('photo', id)).review).toBeUndefined();
        const written = await f.edit<AuthoredPhoto>('photo', id, (photo) => {
            photo.caption = 'Fixture caption.';
        });
        expect(written.review?.fields.alt).toMatchObject({ origin: 'migration', actor: 'migration', valueHash: hashValue(written.alt), baseRevisionId: null });
        expect(written.review?.fields.caption).toMatchObject({ origin: 'curator', actor: 'cli' });
        const again = await f.edit<AuthoredPhoto>('photo', id, (photo) => {
            photo.title = 'Fixture title.';
        });
        expect(again.review?.fields.alt).toEqual(written.review?.fields.alt);
    });

    it('stamps a field whose conflict a write settles, though its value stays', async () => {
        const f = await fixture();
        published(await f.publish());
        const id = f.catalog.photos[0].id;
        await f.handEdit<AuthoredPhoto>('photo', id, (photo) => {
            photo.conflicts = [{ field: 'title', base: null, active: 'Fixture title, theirs.' }];
        });
        const before = await f.read<AuthoredPhoto>('photo', id);
        const settled = await f.edit<AuthoredPhoto>('photo', id, (photo) => {
            delete photo.conflicts;
        }, { review: { baseRevisionId: null, actor: ACTOR, reviewedAt: AT } });
        expect(settled.review?.fields.title).toMatchObject({ actor: ACTOR, reviewedAt: AT, valueHash: hashValue(before.title) });
    });

    it('stamps a policy write through #8\'s operations as generated, and an editor\'s as curator', async () => {
        const f = await fixture({ photos: 4, series: [{ photos: 3 }, { photos: 1 }] });
        published(await f.publish());
        const [a] = f.catalog.series;
        const move = (seriesId: string, photoId: string, kind: 'policy' | 'editor', version: number) =>
            applySequenceOp({ dataRoot: f.root }, { kind: 'move', seriesId, photoId, at: 'end' }, { expectedVersion: version, actor: { kind, ref: 'fixture' } });
        expect(await move(a.id, a.photoIds[0], 'policy', (await f.read<AuthoredSeries>('series', a.id)).version)).toMatchObject({ ok: true, changed: true });
        expect((await f.read<AuthoredSeries>('series', a.id)).review?.fields.photoIds).toMatchObject({ origin: 'generated', actor: 'policy:fixture' });
        expect(await move(a.id, a.photoIds[1], 'editor', (await f.read<AuthoredSeries>('series', a.id)).version)).toMatchObject({ ok: true, changed: true });
        expect((await f.read<AuthoredSeries>('series', a.id)).review?.fields.photoIds).toMatchObject({ origin: 'curator', actor: 'cli' });
    });

    it('records the cover photo\'s pinned revision on a series cover', async () => {
        const f = await fixture();
        published(await f.publish());
        const series = f.catalog.series[0];
        const cover = series.photoIds[1];
        const written = await f.edit<AuthoredSeries>('series', series.id, (record) => {
            record.cover = { photoId: cover };
        });
        expect(written.review?.fields.cover).toMatchObject({ assetRevision: (await f.read<AuthoredPhoto>('photo', cover)).assetRevision });
    });
});

describe('the one-time review backfill', { timeout: 60_000 }, () => {
    const marker = (root: string) => JSON.parse(fs.readFileSync(`${root}/authored/review-backfill.json`, 'utf8')) as { records: Record<string, number> };

    it('counts a record the owner made by hand before the upgrade as reviewed, so the first publish goes through', async () => {
        const f = await fixture();
        const id = f.catalog.photos[0].id;
        // Before any 16-1 command: a copy at the next version, edited, with no review stamps.
        await f.handEdit<AuthoredPhoto>('photo', id, (photo) => {
            photo.caption = 'Fixture caption, by hand before the upgrade.';
        });
        expect(fs.existsSync(`${f.root}/authored/review-backfill.json`)).toBe(false);
        expect(reviewIssues(await validateWorkingLayer({ dataRoot: f.root }))).toEqual([]);
        published(await f.publish());
        // The first command that took the authored lock recorded it at the version it had then.
        expect(marker(f.root).records[`photo:${id}`]).toBe(2);
    });

    it('refuses a version made by hand after the backfill that drops review, and a record folder made by hand', async () => {
        const f = await fixture();
        published(await f.publish());
        const id = f.catalog.photos[0].id;
        await f.handEdit<AuthoredPhoto>('photo', id, (photo) => {
            delete photo.review;
            photo.title = 'Fixture title, by hand, stamps dropped.';
        });
        const series = f.catalog.series[0];
        const made = 'ser_by-hand';
        fs.mkdirSync(authoredRecordDir(f.root, 'series', made), { recursive: true, mode: 0o700 });
        fs.writeFileSync(versionFile(authoredRecordDir(f.root, 'series', made), 1), `${JSON.stringify({
            schemaVersion: 1, version: 1, baseRevisionId: null, kind: 'series', id: made, slug: 'by-hand', title: 'Fixture by hand', statement: 'Fixture statement.',
            shortStatement: 'Fixture short.', photoIds: [], chapters: [], cover: null, visibility: 'hidden',
        }, null, 2)}\n`, { mode: 0o600 });
        const refused = await f.publish();
        expect(refused.outcome).toBe('VALIDATION_FAILED');
        expect(reviewIssues(refused)).toEqual([expect.objectContaining({ record: { kind: 'photo', id }, field: 'title', message: expect.stringContaining('written outside the tools') })]);
        // A hidden series shows nothing, so it needs no review, but published by hand it does.
        await f.handEdit<AuthoredSeries>('series', made, (record) => {
            record.visibility = 'published';
            record.photoIds = [series.photoIds[0]];
            record.cover = { photoId: series.photoIds[0] };
        });
        await f.edit<AuthoredSeries>('series', series.id, (record) => {
            record.photoIds = record.photoIds.slice(1);
            record.cover = { photoId: record.photoIds[0] };
        });
        await f.edit<AuthoredSite>('site', 'site', (site) => {
            site.seriesOrder = [...site.seriesOrder, made];
        });
        const fields = reviewIssues(await validateWorkingLayer({ dataRoot: f.root })).map((issue) => `${issue.record.kind}:${issue.record.id}:${issue.field}`);
        expect(fields).toEqual(expect.arrayContaining([`photo:${id}:title`, `series:${made}:visibility`, `series:${made}:title`, `series:${made}:photoIds`]));
    });

    it('is written once, by the first command that takes the authored lock, and never again', async () => {
        const f = await fixture();
        published(await f.publish());
        const text = fs.readFileSync(`${f.root}/authored/review-backfill.json`, 'utf8');
        expect(Object.keys(marker(f.root).records).length).toBe(f.catalog.photos.length + f.catalog.series.length + 1);
        await f.edit<AuthoredPhoto>('photo', f.catalog.photos[0].id, (photo) => {
            photo.caption = 'Fixture caption.';
        });
        published(await f.publish());
        expect((await f.publish()).outcome).toBe('NO_CHANGES');
        expect(fs.readFileSync(`${f.root}/authored/review-backfill.json`, 'utf8')).toBe(text);
    });
});

describe('rebase and review stamps', { timeout: 60_000 }, () => {
    it('keeps a publish\'s stamps and moves their base to the revision it published', async () => {
        const f = await fixture();
        const first = published(await f.publish());
        const id = f.catalog.photos[0].id;
        const edited = await f.edit<AuthoredPhoto>('photo', id, (photo) => {
            photo.caption = 'Fixture caption.';
        });
        const second = published(await f.publish());
        const after = await f.read<AuthoredPhoto>('photo', id);
        expect(edited.review?.fields.caption?.baseRevisionId).toBe(first);
        expect(after.review?.fields.caption).toEqual({ ...edited.review?.fields.caption, baseRevisionId: second });
    });

    it('drops the stamp of a field a rollback moves, and keeps the others with the base they were reviewed against', async () => {
        const f = await fixture();
        const first = published(await f.publish());
        const id = f.catalog.photos[0].id;
        await f.edit<AuthoredPhoto>('photo', id, (photo) => {
            photo.caption = 'Fixture caption, published second.';
        });
        const second = published(await f.publish());
        const titled = await f.edit<AuthoredPhoto>('photo', id, (photo) => {
            photo.title = 'Fixture title, a draft.';
        });
        expect(await rollback({ dataRoot: f.root, revisionId: first, expectedActiveRevisionId: second, actor: 'test', reason: 'test', logger: quiet })).toMatchObject({ outcome: 'ROLLED_BACK', rebased: true });
        const after = await f.read<AuthoredPhoto>('photo', id);
        expect(after.caption).toBeUndefined();
        expect(after.review?.fields).not.toHaveProperty('caption');
        expect(after.review?.fields.title).toEqual(titled.review?.fields.title);
        expect(after.review?.fields.title?.baseRevisionId).toBe(second);
        // The title is the draft's only change, and the rollback publishes it as the revision it was reviewed against did.
        const plan = await validateWorkingLayer({ dataRoot: f.root });
        expect(reviewIssues(plan)).toEqual([]);
        expect(published(await f.publish())).not.toBe(first);
    });
});

describe('the review publish gate', { timeout: 60_000 }, () => {
    it('registers its two rules as editorial publish-gate errors', () => {
        for (const id of ['review.authored-change', 'review.empty-diff']) {
            expect(registeredRules().find((rule) => rule.id === id)).toMatchObject({ severity: 'error', gate: 'publish', rollbackClass: 'editorial', version: 1 });
        }
    });

    it('never trips on a fresh edit through a tool', async () => {
        const f = await fixture();
        published(await f.publish());
        await f.edit<AuthoredPhoto>('photo', f.catalog.photos[0].id, (photo) => {
            photo.caption = 'Fixture caption.';
        });
        await f.edit<AuthoredSite>('site', 'site', (site) => {
            site.featuredSeriesIds = [...site.featuredSeriesIds];
        });
        published(await f.publish());
    });

    it('refuses a change made by hand, naming the record and field, until it goes through a tool', async () => {
        const f = await fixture();
        published(await f.publish());
        const id = f.catalog.photos[0].id;
        await f.edit<AuthoredPhoto>('photo', id, (photo) => {
            photo.title = 'Fixture title.';
        });
        published(await f.publish());
        // By hand: the title a tool wrote, and a caption only the backfill stamped, while it was absent.
        await f.handEdit<AuthoredPhoto>('photo', id, (photo) => {
            photo.title = 'Fixture title, by hand.';
            photo.caption = 'Fixture caption, by hand.';
        });
        const validated = await validateWorkingLayer({ dataRoot: f.root });
        const refused = await f.publish();
        expect(refused.outcome).toBe('VALIDATION_FAILED');
        for (const result of [validated, refused]) {
            expect(reviewIssues(result)).toEqual([
                expect.objectContaining({ code: 'review.authored-change', severity: 'error', record: { kind: 'photo', id }, field: 'caption', message: expect.stringContaining('changed outside the tools since it was last reviewed') }),
                expect.objectContaining({ code: 'review.authored-change', severity: 'error', record: { kind: 'photo', id }, field: 'title', message: expect.stringContaining('changed outside the tools since it was last reviewed') }),
            ]);
        }
        for (const issue of reviewIssues(refused)) expect(issue.hint).toContain('photos edit');
        // Written through the writer, both are reviewed as they are written.
        await f.edit<AuthoredPhoto>('photo', id, (photo) => {
            photo.title = 'Fixture title.';
            photo.caption = 'Fixture caption, through the tool.';
        });
        expect((await f.read<AuthoredPhoto>('photo', id)).review?.fields.title?.actor).toBe('cli');
        published(await f.publish());
    });

    it('leaves a suggested description to description.required, so it is reported once', async () => {
        const f = await fixture();
        published(await f.publish());
        const id = f.catalog.photos[0].id;
        await f.edit<AuthoredPhoto>('photo', id, (photo) => {
            photo.alt = { kind: 'described', text: 'Fixture suggested description.', reviewed: false };
        });
        const refused = await f.publish();
        expect(refused.outcome).toBe('VALIDATION_FAILED');
        expect(refused.issues.filter((issue) => issue.record.id === id && issue.field === 'alt').map((issue) => issue.code)).toEqual(['description.required']);
    });

    it('goes stale after a rollback publishes a field differently from what it was reviewed against, and only that field', async () => {
        // P is published with a caption, taken off the site, and published without it. Its caption is then rewritten
        // and it goes back in its series, both reviewed against the revision without it. The rollback to the revision
        // that showed P can't merge P's fields (the base revision doesn't publish P), so nothing conflicts, but the
        // caption it publishes is not what the curator reviewed against.
        const f = await fixture({ photos: 4, series: [{ photos: 4 }] });
        const series = f.catalog.series[0];
        const id = series.photoIds[2];
        await f.edit<AuthoredPhoto>('photo', id, (photo) => {
            photo.caption = 'Fixture caption, first.';
        });
        const first = published(await f.publish());
        const removed = await applySequenceOp({ dataRoot: f.root }, { kind: 'remove', seriesId: series.id, photoId: id }, { expectedVersion: (await f.read<AuthoredSeries>('series', series.id)).version, actor: { kind: 'editor' } });
        expect(removed).toMatchObject({ ok: true, changed: true });
        const second = published(await f.publish());
        await f.edit<AuthoredPhoto>('photo', id, (photo) => {
            photo.caption = 'Fixture caption, rewritten.';
        });
        await f.edit<AuthoredPhoto>('photo', f.catalog.photos.find((photo) => photo.id === series.photoIds[0])?.id as string, (photo) => {
            photo.title = 'Fixture title, unrelated.';
        });
        const back = await applySequenceOp({ dataRoot: f.root }, { kind: 'insert', seriesId: series.id, photoId: id, at: { after: series.photoIds[1] } }, { expectedVersion: (await f.read<AuthoredSeries>('series', series.id)).version, actor: { kind: 'editor' } });
        expect(back).toMatchObject({ ok: true, changed: true });

        expect(await rollback({ dataRoot: f.root, revisionId: first, expectedActiveRevisionId: second, actor: 'test', reason: 'test', logger: quiet })).toMatchObject({ outcome: 'ROLLED_BACK', conflicts: [] });
        const refused = await f.publish();
        expect(refused.outcome).toBe('VALIDATION_FAILED');
        expect(reviewIssues(refused)).toEqual([
            expect.objectContaining({ code: 'review.authored-change', record: { kind: 'photo', id }, field: 'caption', message: expect.stringContaining('Stale review') }),
        ]);
        // Written again, against what is live now, it publishes.
        await f.edit<AuthoredPhoto>('photo', id, (photo) => {
            photo.caption = 'Fixture caption, checked against the rollback.';
        });
        published(await f.publish());
    });

    it('is silent for a stored revision, so a rollback\'s eligibility and a repair are never blocked by it', async () => {
        const f = await fixture();
        const first = published(await f.publish());
        await f.handEdit<AuthoredPhoto>('photo', f.catalog.photos[0].id, (photo) => {
            photo.caption = 'Fixture caption, by hand.';
        });
        const revision = (await readRevisionFile(f.root, first)) as RevisionFile;
        const stored = validateStored(f.root, revision, f.catalog.registry);
        expect(reviewIssues(stored)).toEqual([]);
        expect(blockingIssues(stored.issues)).toEqual([]);
        // Even a stored revision equal to nothing active: the rules need a working layer.
        const ctx = { candidate: { site: { featuredSeriesIds: [] }, series: [], photos: [] }, authored: null, active: null, registry: null, roots: { dataRoot: null, libraryRoot: null } };
        expect(runRules(ctx).filter((issue) => issue.code.startsWith('review.'))).toEqual([]);
    });

    describe('review.empty-diff', () => {
        const layer = { site: null, series: [], photos: [], problems: [] };
        const empty = { site: { featuredSeriesIds: [] }, series: [], photos: [] };
        const codes = (ctx: Parameters<typeof runRules>[0]) => runRules(ctx).filter((issue) => issue.code.startsWith('review.')).map((issue) => issue.code);
        const revision = (revisionId: string, content = empty): RevisionFile => ({ revisionId, schemaVersion: 1, baseRevisionId: null, compiledAt: AT, content });
        const roots = { dataRoot: null, libraryRoot: null };

        it('refuses a candidate that differs from the active revision but changes nothing visitors see', () => {
            // Before the first activation, an empty catalog publishes nothing.
            expect(codes({ candidate: empty, authored: layer, active: null, registry: null, roots })).toEqual(['review.empty-diff']);
            // A revision file whose ID isn't its content's hash, with the same content.
            expect(codes({ candidate: empty, authored: layer, active: revision(`rev_${'1'.repeat(64)}`), registry: null, roots })).toEqual(['review.empty-diff']);
        });

        it('is silent for the active revision\'s own content, which publish stops at NO_CHANGES, and for a stored revision', () => {
            expect(codes({ candidate: empty, authored: layer, active: revision(revisionIdOf(empty)), registry: null, roots })).toEqual([]);
            expect(codes({ candidate: empty, authored: null, active: null, registry: null, roots })).toEqual([]);
        });

        it('is silent once anything visitors see changes', async () => {
            const f = await fixture();
            const ctx = await f.catalog.context();
            expect(runRules(ctx).map((issue) => issue.code)).not.toContain('review.empty-diff');
        });
    });
});

describe('a publish that changes nothing', { timeout: 60_000 }, () => {
    it('stops at NO_CHANGES and writes no revision or activation', async () => {
        const f = await fixture();
        published(await f.publish());
        const listing = () => fs.readdirSync(`${f.root}/catalog/revisions`).concat(fs.readdirSync(`${f.root}/catalog/activations`)).sort();
        const before = listing();
        expect((await f.publish()).outcome).toBe('NO_CHANGES');
        expect(listing()).toEqual(before);
    });
});
