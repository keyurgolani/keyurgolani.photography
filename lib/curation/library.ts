import { createHash } from 'node:crypto';
import { massMissing, type LibraryVerdict } from '../identity/library';
import { readRegistry } from '../identity/registry';
import type { Registry } from '../identity/types';
import { dataRootStatus } from '../storage/config';
import type { LockContext } from '../storage/lock';
import { CLOSE_REASONS, CURATION_SCHEMA_VERSION, eventIdOf, type CurationEvent, type LibraryFacts } from './events';
import { listEvents, readEvent, withCurationLock, writeEvent } from './repository';

/**
 * A6 (#17): the curation inbox's one `library-unavailable` item, and the
 * hold it puts on missing items.
 *
 * - The watcher's identity step reports each pass's verdict here
 *   (createLibraryReporter()): a library root that is missing, empty while
 *   the registry has present photos, or unreadable opens the item, or
 *   reopens it, with the cause and when the outage began. Those passes
 *   change nothing, so no photo goes missing while the mount is gone.
 * - #14's sink opens it too (openMassMissing()) when one pass marks at
 *   least 20 bound sources and over 10% of them missing
 *   (lib/identity/library.ts), before it writes their missing items.
 * - While it is open, a missing item whose source went missing since the
 *   outage began is held (heldMissingIds()): `photos status` counts it as
 *   held rather than missing, and `--check` fails on the library instead.
 *   `curation confirm-missing` releases one item, and dismissing this item
 *   releases them all.
 * - A pass that gets through closes it, unless the sources it holds are
 *   still missing past the same thresholds. Closing releases what it held,
 *   so a source that is really gone then counts as missing.
 *
 * It is one item, reopened for each outage, so a library that stays gone
 * writes nothing more, however often the watcher looks. It writes only
 * under `curation/`, and never reads or writes the library.
 */

type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

/** The item's idempotency key and ID. It has no photo or bytes, so the key names the library. */
export const LIBRARY_EVENT_KEY = 'library-unavailable|library';
export const LIBRARY_EVENT_ID = eventIdOf(LIBRARY_EVENT_KEY);
/** Its subject, in the shape of a source fingerprint, since the schema asks for one: a digest of the key. */
const LIBRARY_FINGERPRINT = `fp_${createHash('sha256').update(LIBRARY_EVENT_KEY, 'utf8').digest('hex')}`;

const iso = (ms: number) => new Date(ms).toISOString();

/** How long a report waits for the curation lock, as #14's sink does (SINK_WAIT_MS). */
const LIBRARY_WAIT_MS = 5_000;

/** The item, or null before the first outage. A damaged one throws, as readEvent() does. */
export function readLibraryItem(root: string): Promise<CurationEvent | null> {
    return readEvent(root, LIBRARY_EVENT_ID);
}

/** Whether `item` is the library item, open. */
export function libraryOpen(item: CurationEvent | null | undefined): item is CurationEvent {
    return item?.type === 'library-unavailable' && item.status === 'open';
}

/** When the open item's outage began. */
function sinceOf(item: CurationEvent): string {
    return item.derivedFacts.library?.since ?? item.lastObservedAt;
}

/**
 * The missing items the open library item holds: open or deferred, gone
 * missing since its outage began, and with no `confirm-missing`. None while
 * it is closed.
 */
export function heldMissingIds(events: readonly CurationEvent[], item: CurationEvent | null | undefined): string[] {
    if (!libraryOpen(item)) return [];
    const since = sinceOf(item);
    return events
        .filter((event) => event.type === 'missing' && (event.status === 'open' || event.status === 'deferred') && event.lastObservedAt >= since
            && !event.decisions.some((decision) => decision.action === 'confirm-missing'))
        .map((event) => event.id);
}

/** What a cause means, without a path, for `photos status` and the item. */
export function libraryCauseText(facts: LibraryFacts | undefined): string {
    switch (facts?.cause) {
        case 'missing':
            return 'the library root is missing';
        case 'empty':
            return 'the library root is empty while the registry has present photos';
        case 'unreadable':
            return `the library root can't be read (${facts.detail ?? 'unknown'})`;
        case 'mass-missing':
            return `one pass found ${facts.missing ?? 0} of ${facts.bound ?? 0} bound sources missing`;
        default:
            return 'the library is unavailable';
    }
}

const isRetired = (photo: Registry['photos'][string]) => photo.sourceHealth === 'archived' || photo.mergedInto !== undefined;

/** The bound sources a pass would count now: present photos, not retired. */
export function boundSources(registry: Registry): number {
    return Object.values(registry.photos).filter((photo) => !isRetired(photo) && photo.source.present).length;
}

/** Whether the sources the open item holds are still missing past the thresholds, so a pass that got through leaves it open. */
async function stillHeld(root: string, item: CurationEvent): Promise<boolean> {
    const registry = await readRegistry(root);
    const { events } = await listEvents(root);
    const held = new Set(heldMissingIds(events, item));
    const gone = events.filter((event) => held.has(event.id) && event.photoId !== null && registry.photos[event.photoId]?.sourceHealth === 'missing').length;
    return massMissing(gone, boundSources(registry) + gone);
}

function fresh(at: string, library: LibraryFacts): CurationEvent {
    return {
        schemaVersion: CURATION_SCHEMA_VERSION,
        version: 1,
        id: LIBRARY_EVENT_ID,
        key: LIBRARY_EVENT_KEY,
        type: 'library-unavailable',
        photoId: null,
        sourceFingerprint: LIBRARY_FINGERPRINT,
        assetRevision: null,
        observedAt: at,
        lastObservedAt: at,
        factIds: [],
        status: 'open',
        derivedFacts: { factType: 'library-unavailable', sourcePath: '.', folder: '', library },
        suggestions: { series: null, placement: null },
        edits: null,
        decisions: [],
        reviewedAt: null,
        reviewedBy: null,
    };
}

const sameCause = (a: LibraryFacts | undefined, b: Omit<LibraryFacts, 'since'>) => a?.cause === b.cause && a.detail === b.detail && a.missing === b.missing && a.bound === b.bound;

/**
 * The item for an outage with `facts`, beginning at `at`, given the item as
 * it is: a new one, the open one with the new cause (keeping when its
 * outage began), the closed one opened again, or null when it already says so.
 */
function unavailable(current: CurationEvent | null, at: string, facts: Omit<LibraryFacts, 'since'>): { event: CurationEvent; change: 'opened' | 'updated' | 'reopened' } | null {
    if (current === null) return { event: fresh(at, { ...facts, since: at }), change: 'opened' };
    if (current.status === 'open') {
        if (sameCause(current.derivedFacts.library, facts)) return null;
        const since = current.derivedFacts.library?.since ?? at;
        return { event: { ...current, lastObservedAt: at > current.lastObservedAt ? at : current.lastObservedAt, derivedFacts: { ...current.derivedFacts, library: { ...facts, since: since < at ? since : at } } }, change: 'updated' };
    }
    return {
        event: {
            ...current,
            status: 'open',
            lastObservedAt: at,
            derivedFacts: { ...current.derivedFacts, library: { ...facts, since: at } },
            decisions: [...current.decisions, { action: 'reopen', at, by: 'watcher', baseRevisionId: null, reason: `The library is unavailable again: ${libraryCauseText({ ...facts, since: at })}.` }],
        },
        change: 'reopened',
    };
}

export interface LibraryStateOptions {
    /** Defaults to the data root. */
    root?: string;
    clock?: () => number;
    logger?: Logger;
    /** How long to wait for the curation lock. A busy lock throws, and the next pass reports again. */
    waitMs?: number;
}

function readyRoot(root: string | undefined): string {
    const status = dataRootStatus({ versioned: true, ...(root === undefined ? {} : { root }) });
    if (status.state !== 'ready' || status.root === null) throw new Error(`The data root is ${status.state}, so the inbox can't record library-unavailable.`);
    return status.root;
}

/**
 * Record one pass's verdict on the item: open, update or reopen it for an
 * unavailable library, close it for an available one unless what it holds
 * is still missing. Looks first without the lock, so a pass that changes
 * nothing writes nothing. Returns what it did, or null.
 */
export async function recordLibraryState(verdict: LibraryVerdict, options: LibraryStateOptions = {}): Promise<'opened' | 'updated' | 'reopened' | 'closed' | null> {
    const { clock = Date.now, logger = console, waitMs = LIBRARY_WAIT_MS } = options;
    const root = readyRoot(options.root);
    const at = iso(clock());
    const looked = await readLibraryItem(root);
    if (verdict.available) {
        if (!libraryOpen(looked) || await stillHeld(root, looked)) return null;
    } else if (unavailable(looked, at, { cause: verdict.cause, ...(verdict.detail === undefined ? {} : { detail: verdict.detail }) }) === null) {
        return null;
    }
    return withCurationLock(root, { waitMs }, async (hold) => {
        const current = await readLibraryItem(root);
        if (verdict.available) {
            if (!libraryOpen(current) || await stillHeld(root, current)) return null;
            const closed: CurationEvent = {
                ...current,
                status: 'resolved',
                lastObservedAt: at > current.lastObservedAt ? at : current.lastObservedAt,
                decisions: [...current.decisions, { action: 'close', at, by: 'watcher', baseRevisionId: null, reason: CLOSE_REASONS.available }],
                reviewedAt: at,
                reviewedBy: 'watcher',
            };
            hold.signal.throwIfAborted();
            await writeEvent(root, closed, current.version, hold);
            logger.log(`[curation] Inbox: library-unavailable closed. ${CLOSE_REASONS.available}`);
            return 'closed';
        }
        const next = unavailable(current, at, { cause: verdict.cause, ...(verdict.detail === undefined ? {} : { detail: verdict.detail }) });
        if (next === null) return null;
        hold.signal.throwIfAborted();
        await writeEvent(root, next.event, current?.version ?? 0, hold);
        logger.log(`[curation] Inbox: library-unavailable ${next.change}: ${libraryCauseText(next.event.derivedFacts.library)}.`);
        return next.change;
    });
}

/**
 * #14's sink, under its curation lock: open the item for one pass that
 * marked `missing` of `bound` bound sources missing at `at`, before the
 * sink writes their missing items, so they are held from the start. An
 * open item keeps when its outage began; a closed one opens again. Returns
 * whether it wrote.
 */
export async function openMassMissing(root: string, hold: LockContext, { at, missing, bound }: { at: string; missing: number; bound: number }, logger: Logger = console): Promise<boolean> {
    const current = await readLibraryItem(root);
    if (libraryOpen(current) && current.derivedFacts.library?.cause === 'mass-missing') return false;
    const next = unavailable(current, at, { cause: 'mass-missing', missing, bound });
    if (next === null) return false;
    hold.signal.throwIfAborted();
    await writeEvent(root, next.event, current?.version ?? 0, hold);
    logger.log(`[curation] Inbox: library-unavailable ${next.change}: ${libraryCauseText(next.event.derivedFacts.library)}. Their missing items are held.`);
    return true;
}

/**
 * The watcher's library hook (lib/identity/watcherStep.ts): records each
 * verdict, and logs a failure instead of throwing, so the next pass reports
 * again.
 */
export function createLibraryReporter(options: LibraryStateOptions = {}): (verdict: LibraryVerdict) => Promise<void> {
    const { logger = console } = options;
    return async (verdict) => {
        try {
            await recordLibraryState(verdict, options);
        } catch (error) {
            logger.warn(`[curation] Could not record library-unavailable in the inbox; the next pass tries again: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
}
