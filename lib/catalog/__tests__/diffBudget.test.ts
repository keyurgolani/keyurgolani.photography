// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { diffCatalog } from '../diff';
import { revisionIdOf } from '../schema';
import { createTestCatalog } from '../testing';
import type { CandidateContent, RevisionFile } from '../types';

/**
 * #16's diff budget: a ledger over 5,000 photographs in 100 series, with a
 * change in every photograph and a reorder in every series, under 1 s. The
 * Publish screen and `photos diff` compute it on every read, and the publish
 * gate on every validation. Every record is reviewed against an older
 * revision than the live one, as after a rollback, so each row's review reads
 * the field's published value in both revisions.
 */

describe('the diff budget', () => {
    it('diffs 5,000 photos in 100 series, each changed, in under 1 s', async () => {
        const big = await createTestCatalog({ seed: 7, photos: 5_000, series: 100 });
        try {
            const content = structuredClone(big.content) as RevisionFile['content'];
            const active: RevisionFile = { revisionId: revisionIdOf(content), schemaVersion: 1, baseRevisionId: null, compiledAt: '2026-02-01T00:00:00.000Z', content };
            // The revision the records were reviewed against: the live one with every title different, so every title row reads both and goes stale.
            const older = structuredClone(content);
            for (const photo of older.photos) photo.title = `${photo.id} before`;
            const olderId = revisionIdOf(older);
            const on = <T extends { baseRevisionId: string | null }>(record: T): T => ({ ...structuredClone(record), baseRevisionId: olderId });
            const layer = { site: on(big.site), series: big.series.map(on), photos: big.photos.map(on), problems: [] };
            const candidate = structuredClone(big.content) as CandidateContent;
            // Every photograph retitled, every series reversed, and the last photograph of each series gone.
            for (const photo of candidate.photos) photo.title = `${photo.title ?? photo.id} again`;
            for (const photo of layer.photos) photo.title = `${photo.title ?? photo.id} again`;
            const gone = new Set(candidate.series.map((series) => series.photoIds[series.photoIds.length - 1]));
            for (const series of [...candidate.series, ...layer.series]) series.photoIds = series.photoIds.filter((id) => !gone.has(id)).reverse();
            for (const series of candidate.series) series.derived.photoCount = series.photoIds.length;
            candidate.photos = candidate.photos.filter((photo) => !gone.has(photo.id));
            const input = { active, candidate, authored: layer, registry: big.registry, review: { bases: new Map([[olderId, older]]), inbox: new Map(), unreadable: new Set<string>() } };

            let best = Infinity;
            let rows = 0;
            let stale = 0;
            for (let round = 0; round < 3; round++) {
                const started = performance.now();
                const changes = diffCatalog(input).changes;
                best = Math.min(best, performance.now() - started);
                rows = changes.length;
                stale = changes.filter((change) => change.review.fields.some((field) => field.reason === 'active-moved')).length;
            }
            // A title row per photograph that stays, a removal per one that goes, and the moves the reversals make.
            expect(rows).toBeGreaterThan(9_000);
            // Each title row compared the two revisions' titles, and found them different.
            expect(stale).toBeGreaterThan(4_000);
            expect(best).toBeLessThan(1_000);
        } finally {
            await big.cleanup();
        }
    }, 120_000);
});
