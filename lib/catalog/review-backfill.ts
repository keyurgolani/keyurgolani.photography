import fs from 'node:fs';
import path from 'node:path';
import { atomicCreateJson } from '../storage/atomicWrite';
import { ensureDirectory, hasErrorCode } from '../storage/fsx';
import { backfillKey, type ReviewBackfill } from './review';
import { authoredPaths, readWorkingLayer } from './working-layer';

export type { ReviewBackfill } from './review';

/**
 * #16's one-time review backfill, as a point in time. The first command
 * after the upgrade that takes the authored lock (any tool write, a rebase,
 * or a publish) writes `authored/review-backfill.json` once: every record
 * that has no `review` then, at the version it has then. Never rewritten.
 *
 * A record without `review` reads as reviewed by `migration` when its newest
 * version was written by a tool, or before the marker exists, or at the
 * version the marker lists for it. So everything that existed at the
 * backfill counts as reviewed, records the owner made by hand before the
 * upgrade included, and only a version made by hand after it, without
 * `review`, reads as unreviewed. A marker that can't be read counts as
 * listing nothing, so it never lets a hand edit through.
 */

export const REVIEW_BACKFILL_FILE = 'review-backfill.json';

export const reviewBackfillPath = (root: string) => path.join(/*turbopackIgnore: true*/ authoredPaths(root).dir, REVIEW_BACKFILL_FILE);

function parse(text: string): ReviewBackfill {
    try {
        const value = JSON.parse(text) as Partial<ReviewBackfill>;
        const records = value?.records;
        if (value?.schemaVersion === 1 && typeof value.backfilledAt === 'string' && records && typeof records === 'object' && !Array.isArray(records)
            && Object.values(records).every((version) => Number.isInteger(version) && version > 0)) {
            return { schemaVersion: 1, backfilledAt: value.backfilledAt, records: { ...records } };
        }
    } catch {
        // Falls through to the empty marker.
    }
    return { schemaVersion: 1, backfilledAt: '', records: {} };
}

/** The marker, or null before the backfill. Read-only, so `photos validate` reads it too. */
export async function readReviewBackfill(root: string): Promise<ReviewBackfill | null> {
    try {
        return parse(await fs.promises.readFile(reviewBackfillPath(root), 'utf8'));
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return null;
        return parse('');
    }
}

/**
 * The marker, written first if it doesn't exist yet. The caller holds the
 * authored lock, so no tool write lands while the records are listed, and
 * the file is created whole or not at all, so a crash leaves it absent and
 * the next command writes it.
 */
export async function ensureReviewBackfill(root: string, clock: () => number = Date.now): Promise<ReviewBackfill> {
    const existing = await readReviewBackfill(root);
    if (existing) return existing;
    const layer = await readWorkingLayer(root);
    const records: Record<string, number> = {};
    for (const record of [layer.site, ...layer.series, ...layer.photos]) {
        if (record !== null && record.review === undefined) records[backfillKey(record)] = record.version;
    }
    const marker: ReviewBackfill = { schemaVersion: 1, backfilledAt: new Date(clock()).toISOString(), records };
    await ensureDirectory(authoredPaths(root).dir);
    await atomicCreateJson(reviewBackfillPath(root), marker);
    return (await readReviewBackfill(root)) ?? marker;
}
