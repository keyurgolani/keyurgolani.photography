// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LAUNCH_ORDER_RULE_IDS, ORDER_RULES } from '../order-rules';
import { registeredRules, registerRule, runRules } from '../rules';
import { createTestCatalog, type TestCatalog } from '../testing';
import type { AuthoredSeries, Issue, RuleContext } from '../types';

let catalog: TestCatalog;
let clean: RuleContext;

beforeAll(async () => {
    catalog = await createTestCatalog({ seed: 88, photos: 8, series: 2 });
    clean = await catalog.context();
});

afterAll(async () => {
    await catalog.cleanup();
});

const context = (): RuleContext => structuredClone(clean);
const seriesAt = (ctx: RuleContext, index: number): AuthoredSeries => {
    const series = ctx.authored?.series[index];
    if (!series) throw new Error(`No series ${index}`);
    return series;
};
const record = (series: AuthoredSeries) => ({ kind: 'series' as const, id: series.id });
const UNKNOWN = 'ph_00000000-0000-4000-8000-000000000999';

/** Make the photo's pinned asset revision ready under the profile the candidate chose. */
function readyProfile(ctx: RuleContext, photoId: string): void {
    const pinned = ctx.authored?.photos.find((photo) => photo.id === photoId)?.assetRevision;
    const chosen = ctx.candidate.photos.find((photo) => photo.id === photoId)?.profileId;
    const revision = pinned && ctx.registry?.photos[photoId].revisions[pinned];
    if (!revision || !chosen) throw new Error(`Can't ready ${photoId}`);
    revision.profiles[chosen] = { state: 'ready', attempts: 1, readyAt: '2026-01-01T00:00:00.000Z' };
}

function setHealth(ctx: RuleContext, photoId: string, health: 'present' | 'missing' | 'ambiguous' | 'archived'): void {
    const photo = ctx.registry?.photos[photoId];
    if (!photo) throw new Error(`No registry record for ${photoId}`);
    photo.sourceHealth = health;
}

interface Row {
    code: string;
    gate: 'render' | 'publish';
    severity: 'error' | 'warning';
    breakIt(ctx: RuleContext): { record: Issue['record']; field: string };
}

const rows: Row[] = [
    { code: 'order.duplicate-photo', gate: 'render', severity: 'error', breakIt: (ctx) => {
        const series = seriesAt(ctx, 0);
        series.photoIds = [...series.photoIds, series.photoIds[1]];
        return { record: record(series), field: 'photoIds[4]' };
    } },
    { code: 'order.unknown-photo', gate: 'render', severity: 'error', breakIt: (ctx) => {
        const series = seriesAt(ctx, 0);
        series.photoIds = [series.photoIds[0], UNKNOWN, ...series.photoIds.slice(1)];
        return { record: record(series), field: 'photoIds[1]' };
    } },
    { code: 'order.unpublishable-member', gate: 'render', severity: 'error', breakIt: (ctx) => {
        const series = seriesAt(ctx, 1);
        setHealth(ctx, series.photoIds[2], 'ambiguous');
        return { record: record(series), field: 'photoIds[2]' };
    } },
    { code: 'order.cover', gate: 'render', severity: 'error', breakIt: (ctx) => {
        const series = seriesAt(ctx, 0);
        series.cover = null;
        return { record: record(series), field: 'cover' };
    } },
    { code: 'order.opening', gate: 'render', severity: 'error', breakIt: (ctx) => {
        const series = seriesAt(ctx, 0);
        series.openingPhotoId = seriesAt(ctx, 1).photoIds[0];
        return { record: record(series), field: 'openingPhotoId' };
    } },
    { code: 'order.chapter-anchor', gate: 'render', severity: 'error', breakIt: (ctx) => {
        const series = seriesAt(ctx, 1);
        series.chapters = [{ id: 'ch_fixture-a', title: 'Fixture chapter A', startPhotoId: series.photoIds[2] }, { id: 'ch_fixture-b', title: 'Fixture chapter B', startPhotoId: series.photoIds[1] }];
        return { record: record(series), field: 'chapters[1].startPhotoId' };
    } },
    { code: 'order.empty-series', gate: 'publish', severity: 'error', breakIt: (ctx) => {
        const series = seriesAt(ctx, 1);
        series.photoIds = [];
        series.cover = null;
        return { record: record(series), field: 'photoIds' };
    } },
    { code: 'order.source-missing', gate: 'publish', severity: 'warning', breakIt: (ctx) => {
        const series = seriesAt(ctx, 0);
        setHealth(ctx, series.photoIds[3], 'missing');
        readyProfile(ctx, series.photoIds[3]);
        return { record: record(series), field: 'photoIds[3]' };
    } },
];

describe('the order rules', () => {
    it('find nothing wrong with a clean fixture', () => {
        expect(runRules(clean)).toEqual([]);
    });

    it('are all registered, each with one row here, and the launch set is all but order.source-missing', () => {
        const ids = ORDER_RULES.map((rule) => rule.id).sort();
        expect(ids).toEqual(rows.map((row) => row.code).sort());
        expect(registeredRules().filter((rule) => rule.id.startsWith('order.')).map((rule) => rule.id)).toEqual(ids);
        expect([...LAUNCH_ORDER_RULE_IDS].sort()).toEqual(ids.filter((id) => id !== 'order.source-missing'));
    });

    it('leave no room for a stand-in: registering one throws', () => {
        expect(() => registerRule({ id: 'order.cover', version: 1, severity: 'error', rollbackClass: 'integrity', gate: 'render', check: () => [] })).toThrow(/already registered/);
    });

    it.each(rows)('$code: reports the broken series and field, and only that', (row) => {
        const ctx = context();
        const { record: expected, field } = row.breakIt(ctx);
        expect(registeredRules().find((rule) => rule.id === row.code)).toMatchObject({ gate: row.gate, severity: row.severity, rollbackClass: 'integrity', version: 1 });
        const issues = runRules(ctx);
        expect(issues).toEqual([expect.objectContaining({ code: row.code, severity: row.severity, record: expected, field })]);
        expect(issues[0].message).not.toMatch(/\/|\\/);
    });

    it.each(rows)('$code: reports nothing for a stored revision, with no working layer', (row) => {
        const ctx = context();
        row.breakIt(ctx);
        expect(runRules({ ...ctx, authored: null }).filter((issue) => issue.code.startsWith('order.'))).toEqual([]);
    });

    it.each(['draft', 'hidden'] as const)('leave a %s series alone', (visibility) => {
        const ctx = context();
        const series = seriesAt(ctx, 1);
        series.visibility = visibility;
        series.photoIds = [...series.photoIds, UNKNOWN, series.photoIds[0]];
        series.cover = null;
        series.openingPhotoId = UNKNOWN;
        if (ctx.authored?.site) ctx.authored.site.featuredSeriesIds = [seriesAt(ctx, 0).id];
        expect(runRules(ctx).filter((issue) => issue.code.startsWith('order.'))).toEqual([]);
    });
});

describe('the member checks', () => {
    // Positions 0, 2, and 3 of a 4-photo series: the start, the middle, and the end.
    it.each([0, 2, 3])('order.unknown-photo: an entry with no registry record at position %i', (index) => {
        const ctx = context();
        const series = seriesAt(ctx, 0);
        const photoId = series.photoIds[index];
        if (ctx.registry) delete ctx.registry.photos[photoId];
        expect(runRules(ctx)).toEqual([expect.objectContaining({ code: 'order.unknown-photo', field: `photoIds[${index}]` })]);
    });

    it.each([0, 2, 3])('order.unknown-photo: an entry with no authored photo record at position %i', (index) => {
        const ctx = context();
        const series = seriesAt(ctx, 0);
        const photoId = series.photoIds[index];
        if (ctx.authored) ctx.authored.photos = ctx.authored.photos.filter((photo) => photo.id !== photoId);
        expect(runRules(ctx)).toEqual([expect.objectContaining({ code: 'order.unknown-photo', field: `photoIds[${index}]` })]);
    });

    it.each([[0, 'archived'], [2, 'ambiguous'], [3, 'archived']] as const)('order.unpublishable-member: a member at position %i that is %s', (index, health) => {
        const ctx = context();
        setHealth(ctx, seriesAt(ctx, 0).photoIds[index], health);
        expect(runRules(ctx)).toEqual([expect.objectContaining({ code: 'order.unpublishable-member', field: `photoIds[${index}]` })]);
    });

    it.each([0, 2, 3])('order.duplicate-photo: a repeat of the photo at position %i, reported where it repeats', (index) => {
        const ctx = context();
        const series = seriesAt(ctx, 0);
        series.photoIds = [...series.photoIds, series.photoIds[index]];
        expect(runRules(ctx)).toEqual([expect.objectContaining({ code: 'order.duplicate-photo', field: 'photoIds[4]' })]);
    });

    it('order.source-missing: only warns while the pinned chosen profile is ready', () => {
        const ctx = context();
        const photoId = seriesAt(ctx, 0).photoIds[0];
        setHealth(ctx, photoId, 'missing');
        expect(runRules(ctx)).toEqual([]);
        readyProfile(ctx, photoId);
        expect(runRules(ctx)).toEqual([expect.objectContaining({ code: 'order.source-missing', severity: 'warning', field: 'photoIds[0]' })]);
    });

    it('order.source-missing: checks the asset revision the photo record pins, not the newest', () => {
        const ctx = context();
        const photoId = seriesAt(ctx, 0).photoIds[0];
        setHealth(ctx, photoId, 'missing');
        readyProfile(ctx, photoId);
        const photo = ctx.authored?.photos.find((entry) => entry.id === photoId);
        if (photo) photo.assetRevision = `sha256-${'c'.repeat(64)}`;
        expect(runRules(ctx).filter((issue) => issue.code === 'order.source-missing')).toEqual([]);
    });
});

describe('the series checks', () => {
    it('order.cover: a cover outside photoIds', () => {
        const ctx = context();
        const series = seriesAt(ctx, 0);
        series.cover = { photoId: seriesAt(ctx, 1).photoIds[0] };
        expect(runRules(ctx)).toEqual([expect.objectContaining({ code: 'order.cover', field: 'cover.photoId' })]);
    });

    it.each([0, 2, 3])('order.chapter-anchor: a start photo outside photoIds after a chapter at position %i', (index) => {
        const ctx = context();
        const series = seriesAt(ctx, 0);
        series.chapters = [
            { id: 'ch_fixture-a', title: 'Fixture chapter A', startPhotoId: series.photoIds[index] },
            { id: 'ch_fixture-b', title: 'Fixture chapter B', startPhotoId: UNKNOWN },
        ];
        expect(runRules(ctx)).toEqual([expect.objectContaining({ code: 'order.chapter-anchor', field: 'chapters[1].startPhotoId' })]);
    });

    it('order.chapter-anchor: two chapters starting on the same photo are not strictly increasing', () => {
        const ctx = context();
        const series = seriesAt(ctx, 0);
        series.chapters = [
            { id: 'ch_fixture-a', title: 'Fixture chapter A', startPhotoId: series.photoIds[1] },
            { id: 'ch_fixture-b', title: 'Fixture chapter B', startPhotoId: series.photoIds[1] },
        ];
        expect(runRules(ctx)).toEqual([expect.objectContaining({ code: 'order.chapter-anchor', field: 'chapters[1].startPhotoId' })]);
    });

    it('order.chapter-anchor: anchors at the start, middle, and end in order pass', () => {
        const ctx = context();
        const series = seriesAt(ctx, 0);
        series.chapters = [0, 2, 3].map((index) => ({ id: `ch_fixture-${index}`, title: `Fixture chapter ${index}`, startPhotoId: series.photoIds[index] }));
        expect(runRules(ctx)).toEqual([]);
    });

    it('order.empty-series: an empty series gets only that, not order.cover', () => {
        const ctx = context();
        const series = seriesAt(ctx, 1);
        series.photoIds = [];
        series.cover = null;
        expect(runRules(ctx).map((issue) => issue.code)).toEqual(['order.empty-series']);
        expect(runRules(ctx, { gates: ['render'] })).toEqual([]);
    });

    it('report an undescribed member once, through #13\'s description rule', () => {
        const ctx = context();
        const photoId = seriesAt(ctx, 0).photoIds[1];
        const photo = ctx.authored?.photos.find((entry) => entry.id === photoId);
        if (photo) photo.alt = null;
        const candidate = ctx.candidate.photos.find((entry) => entry.id === photoId);
        if (candidate) candidate.alt = { kind: 'pending' };
        expect(runRules(ctx).map((issue) => issue.code)).toEqual(['description.required']);
    });
});

describe('validation time', () => {
    it('runs every registered rule over 5,000 photos in 100 series in under 500 ms', async () => {
        const big = await createTestCatalog({ seed: 5, photos: 5_000, series: 100 });
        try {
            const ctx = await big.context();
            let best = Infinity;
            for (let round = 0; round < 3; round++) {
                const started = performance.now();
                const issues = runRules(ctx);
                best = Math.min(best, performance.now() - started);
                expect(issues).toEqual([]);
            }
            expect(best).toBeLessThan(500);
        } finally {
            await big.cleanup();
        }
    }, 60_000);
});
