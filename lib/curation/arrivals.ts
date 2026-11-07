import path from 'node:path';
import { readVersionedDocument, writeVersionedDocument } from '../storage/document';
import type { LockContext } from '../storage/lock';
import { EVENT_ID_RE, type CurationEventStatus } from './events';

/**
 * #14 (A8 review, 4a): the curation inbox's arrival sequence, the order the
 * server owns in which items came to need judgment. The Inbox's poll asks
 * how many arrived after a cursor this answered before, so an item opened
 * while another was decided elsewhere still counts, and no clock, the
 * watcher's or the browser's, decides it.
 *
 * It's one version folder, `curation/arrivals/` (lib/storage/document.ts),
 * whose version number is the sequence: every arrival commits the next
 * version, which records that item's sequence. It's written only by
 * writeEvent(), under the curation lock that write already holds, so two
 * arrivals never share a number, even in the same millisecond. An item
 * arrives when it is written open or failed (the statuses that can need
 * judgment) from nothing, or from any other status, as a reopen does. An
 * edit or a fact folded into an open item doesn't move it. It holds only
 * event IDs and numbers, nothing a v1.7.x build reads: `curation/events/`
 * is unchanged, so the event schema's version stays 2.
 *
 * An item written before this build has no sequence and never counts as an
 * arrival, so an upgrade announces nothing. A failed write here is logged and
 * leaves the event written: that item then isn't announced, which costs a
 * line, never a write.
 */

export const ARRIVALS_SCHEMA_VERSION = 1;

/** The statuses an item can need judgment in. Moving into one of them from outside is an arrival. */
const ARRIVING: ReadonlySet<CurationEventStatus> = new Set(['open', 'failed']);

export function arrivalsDir(root: string): string {
    return path.join(/*turbopackIgnore: true*/ root, 'curation', 'arrivals');
}

export interface Arrivals {
    /** The newest sequence the server issued, 0 before any. */
    cursor: number;
    /** Each item's latest arrival. */
    seqOf: ReadonlyMap<string, number>;
}

interface ArrivalsDocument {
    schemaVersion: number;
    version: number;
    items: Record<string, number>;
}

function itemsOf(value: Record<string, unknown> | undefined): Map<string, number> {
    const items = value?.items;
    const map = new Map<string, number>();
    if (typeof items !== 'object' || items === null || Array.isArray(items)) return map;
    for (const [id, seq] of Object.entries(items)) {
        if (EVENT_ID_RE.test(id) && typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0) map.set(id, seq);
    }
    return map;
}

/** The sequence as the summary reads it. A folder that isn't there is cursor 0, with no arrivals. */
export async function readArrivals(root: string): Promise<Arrivals> {
    const stored = await readVersionedDocument(arrivalsDir(root));
    if (stored === null) return { cursor: 0, seqOf: new Map() };
    return { cursor: stored.version, seqOf: itemsOf(stored.value) };
}

/** Whether a write that takes an item from `previous` (null for a new item) to `next` is an arrival. */
export function arrives(previous: CurationEventStatus | null, next: CurationEventStatus): boolean {
    return ARRIVING.has(next) && (previous === null || !ARRIVING.has(previous));
}

/** Record `eventId`'s arrival as the next sequence. Only writeEvent() calls it, under its hold on the curation lock. */
export async function recordArrival(root: string, eventId: string, hold: LockContext): Promise<number> {
    if (hold.signal.aborted) throw new Error('An arrival is recorded only under a live hold on the curation lock.');
    const dir = arrivalsDir(root);
    const stored = await readVersionedDocument(dir);
    const items = Object.fromEntries(itemsOf(stored?.value));
    const version = stored?.version ?? 0;
    items[eventId] = version + 1;
    const next: ArrivalsDocument = { schemaVersion: ARRIVALS_SCHEMA_VERSION, version: version + 1, items };
    await writeVersionedDocument(dir, next, version);
    return version + 1;
}

/** A cursor the server issued: a whole number from 0 up to its newest sequence. Anything else is refused. */
export function cursorIssued(since: number, arrivals: Pick<Arrivals, 'cursor'>): boolean {
    return Number.isSafeInteger(since) && since >= 0 && since <= arrivals.cursor;
}
