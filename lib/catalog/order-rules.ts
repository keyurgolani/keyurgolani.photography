import type { AuthoredSeries, Rule, RuleContext, RuleFinding } from './types';

/**
 * #8's sequence rules, in #13's rule shape, for rules.ts to register. Type-only
 * imports, so this module adds nothing to whatever imports it.
 *
 * They read membership and order from the working layer: compile drops
 * unresolvable photoIds entries, and `cover: null` exists only there. Only
 * published series are checked, since only they compile. With no working
 * layer (a stored revision, for #15's rollback or photos:verify), they report
 * nothing. #13 owns the description, asset, membership, featuredSeriesIds,
 * seriesOrder, and chapter-ID uniqueness rules.
 */

/** The order rules #13's first activation needs registered. */
export const LAUNCH_ORDER_RULE_IDS = [
    'order.duplicate-photo',
    'order.unknown-photo',
    'order.unpublishable-member',
    'order.cover',
    'order.opening',
    'order.chapter-anchor',
    'order.empty-series',
] as const;

const seriesRecord = (series: AuthoredSeries) => ({ kind: 'series' as const, id: series.id });

function publishedSeries(ctx: RuleContext): AuthoredSeries[] {
    return ctx.authored ? ctx.authored.series.filter((series) => series.visibility === 'published') : [];
}

/** One finding per member that `test` flags, at its position. */
function eachMember(ctx: RuleContext, test: (photoId: string) => string | null): RuleFinding[] {
    return publishedSeries(ctx).flatMap((series) => series.photoIds.flatMap((photoId, index) => {
        const message = test(photoId);
        return message === null ? [] : [{ record: seriesRecord(series), field: `photoIds[${index}]`, message }];
    }));
}

const rule = (definition: Omit<Rule, 'version' | 'rollbackClass'>): Rule => ({ version: 1, rollbackClass: 'integrity', ...definition });

export const ORDER_RULES: readonly Rule[] = [
    rule({
        id: 'order.duplicate-photo',
        severity: 'error',
        gate: 'render',
        check: (ctx) => publishedSeries(ctx).flatMap((series) => {
            const first = new Map<string, number>();
            return series.photoIds.flatMap((photoId, index) => {
                const earlier = first.get(photoId);
                if (earlier === undefined) {
                    first.set(photoId, index);
                    return [];
                }
                return [{ record: seriesRecord(series), field: `photoIds[${index}]`, message: `${photoId} is already at position ${earlier + 1}.`, hint: 'A photograph appears once in a series.' }];
            });
        }),
    }),
    rule({
        id: 'order.unknown-photo',
        severity: 'error',
        gate: 'render',
        check: (ctx) => {
            const records = new Set((ctx.authored?.photos ?? []).map((photo) => photo.id));
            return eachMember(ctx, (photoId) => {
                if (!ctx.registry?.photos[photoId]) return `${photoId} is not a photo the library knows.`;
                if (!records.has(photoId)) return `${photoId} has no photo record.`;
                return null;
            });
        },
    }),
    rule({
        id: 'order.unpublishable-member',
        severity: 'error',
        gate: 'render',
        check: (ctx) => eachMember(ctx, (photoId) => {
            const health = ctx.registry?.photos[photoId]?.sourceHealth;
            if (health === 'ambiguous') return `${photoId} is ambiguous: its source could be more than one file.`;
            if (health === 'archived') return `${photoId} is archived.`;
            return null;
        }),
    }),
    rule({
        id: 'order.cover',
        severity: 'error',
        gate: 'render',
        check: (ctx) => publishedSeries(ctx).flatMap((series): RuleFinding[] => {
            if (series.photoIds.length === 0) return [];
            if (series.cover === null) return [{ record: seriesRecord(series), field: 'cover', message: 'The series has no cover.', hint: 'Set a cover from its photographs.' }];
            if (!series.photoIds.includes(series.cover.photoId)) return [{ record: seriesRecord(series), field: 'cover.photoId', message: `The cover, ${series.cover.photoId}, is not in the series.` }];
            return [];
        }),
    }),
    rule({
        id: 'order.opening',
        severity: 'error',
        gate: 'render',
        check: (ctx) => publishedSeries(ctx)
            .filter((series) => series.openingPhotoId !== undefined && !series.photoIds.includes(series.openingPhotoId))
            .map((series) => ({ record: seriesRecord(series), field: 'openingPhotoId', message: `The opening photograph, ${series.openingPhotoId}, is not in the series.` })),
    }),
    rule({
        id: 'order.chapter-anchor',
        severity: 'error',
        gate: 'render',
        check: (ctx) => publishedSeries(ctx).flatMap((series) => {
            const position = new Map<string, number>();
            series.photoIds.forEach((photoId, index) => {
                if (!position.has(photoId)) position.set(photoId, index);
            });
            let previous = -1;
            return series.chapters.flatMap((chapter, index) => {
                const field = `chapters[${index}].startPhotoId`;
                const at = position.get(chapter.startPhotoId);
                if (at === undefined) return [{ record: seriesRecord(series), field, message: `The chapter starts on ${chapter.startPhotoId}, which is not in the series.` }];
                if (at <= previous) return [{ record: seriesRecord(series), field, message: 'The chapter starts at or before the chapter above it.', hint: 'Chapters start in sequence order, each on a later photograph.' }];
                previous = at;
                return [];
            });
        }),
    }),
    rule({
        id: 'order.empty-series',
        severity: 'error',
        gate: 'publish',
        check: (ctx) => publishedSeries(ctx)
            .filter((series) => series.photoIds.length === 0)
            .map((series) => ({ record: seriesRecord(series), field: 'photoIds', message: 'A published series needs at least one photograph.' })),
    }),
    rule({
        id: 'order.source-missing',
        severity: 'warning',
        gate: 'publish',
        check: (ctx) => {
            const pinned = new Map((ctx.authored?.photos ?? []).map((photo) => [photo.id, photo.assetRevision]));
            const chosen = new Map(ctx.candidate.photos.map((photo) => [photo.id, photo.profileId]));
            return eachMember(ctx, (photoId) => {
                const photo = ctx.registry?.photos[photoId];
                const assetRevision = pinned.get(photoId);
                const profileId = chosen.get(photoId);
                if (photo?.sourceHealth !== 'missing' || !assetRevision || !profileId) return null;
                // Without a ready derivative set, #13's asset rule blocks instead.
                if (photo.revisions[assetRevision]?.profiles[profileId]?.state !== 'ready') return null;
                return `The source file of ${photoId} is missing. Its published derivatives still serve it, but they can't be rebuilt.`;
            });
        },
    }),
];
