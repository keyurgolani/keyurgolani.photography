import fs from 'node:fs';
import path from 'node:path';
import { atomicCreateJson } from '../storage/atomicWrite';
import { ensureDirectory, hasErrorCode } from '../storage/fsx';
import { backfillKey, hashValue, STAMPED_FIELDS, type BackfilledRecord, type ReviewBackfill } from './review';
import { authoredPaths, readWorkingLayer } from './working-layer';

export type { ReviewBackfill } from './review';

/**
 * #16's one-time review backfill, as a point in time. The first command
 * after the upgrade that takes the authored lock (any tool write, a rebase,
 * or a publish) writes `authored/review-backfill.json` once: every record
 * that has no `review` then, at the version it has then. Never rewritten.
 *
 * It also records the hash of each stamped field's value then. A record
 * without `review` reads as reviewed by `migration` when its newest version
 * was written by a tool, or before the marker exists, or, when the marker
 * lists it, for each field still holding the value the marker recorded. So
 * everything that existed at the backfill counts as reviewed, records the
 * owner made by hand before the upgrade included, and only what changed by
 * hand after it reads as unreviewed: a field of a listed record, however its
 * version was made (an in-place edit that strips the stamp included), and
 * every field of a record made by hand after it. A marker that can't be
 * read counts as listing nothing, so it never lets a hand edit through, and
 * the gate says the marker is why.
 */

export const REVIEW_BACKFILL_FILE = 'review-backfill.json';

export const reviewBackfillPath = (root: string) => path.join(/*turbopackIgnore: true*/ authoredPaths(root).dir, REVIEW_BACKFILL_FILE);

const HEX_64 = /^[0-9a-f]{64}$/;

function isRecordEntry(entry: unknown): boolean {
    const value = entry as { version?: unknown; fields?: unknown } | null;
    return typeof value === 'object' && value !== null && Number.isInteger(value.version) && (value.version as number) > 0
        && typeof value.fields === 'object' && value.fields !== null && !Array.isArray(value.fields)
        && Object.values(value.fields).every((hash) => typeof hash === 'string' && HEX_64.test(hash));
}

function parse(text: string): ReviewBackfill {
    try {
        const value = JSON.parse(text) as Partial<ReviewBackfill>;
        const records = value?.records;
        if (value?.schemaVersion === 1 && typeof value.backfilledAt === 'string' && records && typeof records === 'object' && !Array.isArray(records)
            && Object.values(records).every(isRecordEntry)) {
            return { schemaVersion: 1, backfilledAt: value.backfilledAt, records: { ...records } };
        }
    } catch {
        // Falls through to the damaged marker.
    }
    return { schemaVersion: 1, backfilledAt: '', records: {}, damaged: true };
}

/** The last marker read, by path, size, and mtime: it lists every record, and every write reads it. */
let cached: { file: string; size: number; mtimeMs: number; marker: ReviewBackfill } | null = null;

/** The marker, or null before the backfill. Read-only, so `photos validate` reads it too. */
export async function readReviewBackfill(root: string): Promise<ReviewBackfill | null> {
    const file = reviewBackfillPath(root);
    try {
        const stat = await fs.promises.stat(file);
        if (cached && cached.file === file && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.marker;
        const marker = parse(await fs.promises.readFile(file, 'utf8'));
        cached = { file, size: stat.size, mtimeMs: stat.mtimeMs, marker };
        return marker;
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
    const records: Record<string, BackfilledRecord> = {};
    for (const record of [layer.site, ...layer.series, ...layer.photos]) {
        if (record === null || record.review !== undefined) continue;
        const fields = Object.fromEntries(STAMPED_FIELDS[record.kind].map((field) => [field, hashValue((record as unknown as Record<string, unknown>)[field])]));
        records[backfillKey(record)] = { version: record.version, fields };
    }
    const marker: ReviewBackfill = { schemaVersion: 1, backfilledAt: new Date(clock()).toISOString(), records };
    await ensureDirectory(authoredPaths(root).dir);
    await atomicCreateJson(reviewBackfillPath(root), marker);
    return (await readReviewBackfill(root)) ?? marker;
}
