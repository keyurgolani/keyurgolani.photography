import { currentProfileId } from '../identity/profile';
import { readRegistry } from '../identity/registry';
import { printable } from './commands';
import { needsJudgment, shortPhotoId, waitingReason, type CurationEvent } from './events';
import { photoHolders, type ReferenceCache } from './holders';
import { ageText } from './inbox-view';
import { heldMissingIds, libraryCauseText, LIBRARY_EVENT_ID } from './library';
import { placedItems } from './placement';
import { listEvents } from './repository';

/**
 * #17's alerting: the open missing sources and failures in the curation
 * inbox, for #13 slice D's `photos status` (lib/catalog/owner-status.ts):
 * inboxAlerts() for `--json` and inboxAlertLines() for the text. It reads
 * only, takes no lock, and prints no absolute path. An item stays listed
 * until the watcher or the curator settles it, so status shows it on every
 * run; the watcher retries failed builds at its start, and `curation retry`
 * builds one again.
 *
 * #14 and #17 in v2.0.0 (A2) add the counts `photos status` prints and
 * `--check` reads: what needs review, counted as `curation list` and the
 * Inbox count it, the open missing, failed and ambiguous items, and the
 * stale approvals, whose photo no series or the live revision holds now.
 *
 * A6 adds the open `library-unavailable` item and the missing items it
 * holds (lib/curation/library.ts): those count as held, not missing, since
 * the library, not each photo, is what's wrong.
 */

const STILL_OPEN = new Set(['open', 'deferred', 'failed']);

export interface InboxAlert {
    eventId: string;
    version: number;
    type: CurationEvent['type'];
    status: CurationEvent['status'];
    photoId: string | null;
    /** Library-relative, the last path for a missing source. */
    sourcePath: string;
    /** When the inbox first saw it. */
    since: string;
    /** How long ago that was, in whole seconds, by the reader's clock. */
    ageSeconds: number;
    /** For a missing source: who still shows the photograph, or null when the data root can't tell. */
    shownBy?: string[] | null;
    /** For a failure: what failed, without a host path. */
    failure?: string;
    /** For a stale approval: the series its last approval named. */
    series?: string;
}

export interface InboxCounts {
    /** Items that need the curator's judgment, as `curation list` and the Inbox count them (needsJudgment()). */
    needsReview: number;
    missing: number;
    /** A6: missing items the open library-unavailable item holds. */
    held: number;
    failed: number;
    ambiguous: number;
    /** Approvals whose photo no series or the live revision holds now. */
    stale: number;
}

/** A6: the open library-unavailable item. */
export interface LibraryAlert {
    eventId: string;
    version: number;
    cause: string;
    /** What the cause means, without a path. */
    causeText: string;
    since: string;
    ageSeconds: number;
}

export interface InboxAlerts {
    counts: InboxCounts;
    /** A6: the open library-unavailable item, or null. */
    library: LibraryAlert | null;
    missing: InboxAlert[];
    /** A6: the missing items it holds. */
    held: InboxAlert[];
    failed: InboxAlert[];
    /** Open ambiguous items: a file the watcher holds in doubt between photographs. */
    ambiguous: InboxAlert[];
    /** Approvals no series or the live revision holds now, which `curation show` says how to place again. */
    stale: InboxAlert[];
    /** Inbox items that can't be read, which `curation list` names. */
    unreadable: number;
    /** The placement lookup couldn't tell which photographs are placed, so needs-review and stale count by stored status. */
    placementUnknown: boolean;
}

/**
 * A failure in the inbox: a failed processing item or set, open or left in draft. A set refused as `superseded` on
 * an item left in draft is none: the source moved on, and the newer bytes' own item reviews them (#17). The watcher
 * closes an open or failed one once the source holds other bytes, so one still open or failed has its bytes back,
 * refused under an older profile, and needs a retry, which counts.
 */
function failureOf(event: CurationEvent): string | null {
    if (!STILL_OPEN.has(event.status)) return null;
    if (event.candidate?.state === 'failed') {
        return event.candidate.failure === 'superseded' && event.status === 'deferred' ? null : `derivative set ${event.candidate.failure ?? 'build'}`;
    }
    if (event.type === 'processing-failure') return event.derivedFacts.failure ?? 'processing failed';
    return event.status === 'failed' ? 'failed' : null;
}

const byAge = (a: InboxAlert, b: InboxAlert) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.eventId < b.eventId ? -1 : 1);

/** The open missing, failed and ambiguous items and the stale approvals, oldest first, and the counts. */
export async function inboxAlerts(root: string, clock: () => number = Date.now): Promise<InboxAlerts> {
    const { events, problems } = await listEvents(root);
    const cache: ReferenceCache = {};
    const now = clock();
    const missing: InboxAlert[] = [];
    const failed: InboxAlert[] = [];
    const ambiguous: InboxAlert[] = [];
    const stale: InboxAlert[] = [];
    const held: InboxAlert[] = [];
    const libraryItem = events.find((event) => event.id === LIBRARY_EVENT_ID && event.type === 'library-unavailable') ?? null;
    const holding = new Set(heldMissingIds(events, libraryItem));
    let library: LibraryAlert | null = null;
    // The same lookups `curation list` makes, so status counts what needs review as the list and the Inbox do.
    const registry = events.length > 0 ? await readRegistry(root).catch(() => null) : null;
    const profileId = currentProfileId();
    const placements = await placedItems(root, events);
    let needsReview = 0;
    for (const event of events) {
        const ageSeconds = Math.max(0, Math.floor((now - Date.parse(event.observedAt)) / 1000));
        const base = { eventId: event.id, version: event.version, type: event.type, status: event.status, photoId: event.photoId, sourcePath: event.derivedFacts.sourcePath, since: event.observedAt, ageSeconds };
        if (needsJudgment(event, waitingReason(event, registry, profileId), placements.placed.has(event.id))) needsReview++;
        const series = placements.unplaced.get(event.id);
        if (series !== undefined) {
            stale.push({ ...base, series });
            continue;
        }
        if (event.type === 'library-unavailable') {
            if (event.status === 'open') {
                const since = event.derivedFacts.library?.since ?? event.lastObservedAt;
                library = { eventId: event.id, version: event.version, cause: event.derivedFacts.library?.cause ?? 'unknown', causeText: libraryCauseText(event.derivedFacts.library), since, ageSeconds: Math.max(0, Math.floor((now - Date.parse(since)) / 1000)) };
            }
            continue;
        }
        if (holding.has(event.id)) {
            held.push(base);
            continue;
        }
        if (event.type === 'missing' && STILL_OPEN.has(event.status)) {
            const found = event.photoId === null ? { holders: [] } : await photoHolders(root, event.photoId, cache);
            missing.push({ ...base, shownBy: 'holders' in found ? found.holders : null });
            continue;
        }
        if (event.type === 'ambiguous' && STILL_OPEN.has(event.status)) {
            ambiguous.push(base);
            continue;
        }
        const failure = failureOf(event);
        if (failure !== null) failed.push({ ...base, failure });
    }
    return {
        counts: { needsReview, missing: missing.length, held: held.length, failed: failed.length, ambiguous: ambiguous.length, stale: stale.length },
        library,
        missing: missing.sort(byAge),
        held: held.sort(byAge),
        failed: failed.sort(byAge),
        ambiguous: ambiguous.sort(byAge),
        stale: stale.sort(byAge),
        unreadable: problems.length,
        placementUnknown: placements.unknown !== null,
    };
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const ago = (item: InboxAlert) => `${ageText(item.ageSeconds * 1000)} ago`;

/** The status lines: the counts, then one line per item. */
export function inboxAlertLines(alerts: InboxAlerts): string[] {
    const { counts, missing, failed, ambiguous, stale, unreadable, library, held } = alerts;
    const heldText = counts.held > 0 ? `, ${counts.held} held` : '';
    const lines = [
        `Inbox: ${counts.needsReview} ${counts.needsReview === 1 ? 'needs' : 'need'} review, ${count(counts.missing, 'missing source')}${heldText}, ${count(counts.failed, 'failure')}, ${counts.ambiguous} ambiguous, ${counts.stale} stale${unreadable > 0 ? `, ${count(unreadable, 'item')} unreadable (curation list names them)` : ''}`,
    ];
    if (library) {
        lines.push(`  library unavailable since ${library.since}, ${ageText(library.ageSeconds * 1000)} ago: ${library.causeText}; ${count(held.length, 'missing source')} held until a pass finds the library again or confirm-missing runs  (${library.eventId}@${library.version})`);
    }
    for (const item of held) {
        lines.push(`  held     ${shortPhotoId(item.photoId)}  ${printable(item.sourcePath)}  since ${item.since}, ${ago(item)}, ${item.status}  (${item.eventId}@${item.version})`);
    }
    for (const item of missing) {
        const shown = item.shownBy === null || item.shownBy === undefined
            ? "the data root can't show whether anything references it"
            : item.shownBy.length === 0 ? 'nothing references it' : `${item.shownBy.join(' and ')} still ${item.shownBy.length === 1 ? 'shows' : 'show'} it`;
        lines.push(`  missing  ${shortPhotoId(item.photoId)}  ${printable(item.sourcePath)}  since ${item.since}, ${ago(item)}, ${item.status}; ${shown}  (${item.eventId}@${item.version})`);
    }
    for (const item of failed) {
        lines.push(`  failed   ${shortPhotoId(item.photoId)}  ${printable(item.sourcePath)}  since ${item.since}, ${ago(item)}, ${item.type}: ${item.failure}  (${item.eventId}@${item.version})`);
    }
    for (const item of ambiguous) {
        lines.push(`  ambiguous  ${shortPhotoId(item.photoId)}  ${printable(item.sourcePath)}  since ${item.since}, ${ago(item)}, ${item.status}  (${item.eventId}@${item.version})`);
    }
    for (const item of stale) {
        lines.push(`  stale    ${shortPhotoId(item.photoId)}  ${printable(item.sourcePath)}  since ${item.since}, approved into ${item.series}, but no series or the live revision holds it now  (${item.eventId}@${item.version})`);
    }
    if (alerts.placementUnknown) lines.push("  A revision or series can't be read, so needs-review and stale count every item by its stored status. curation list says which file.");
    if (library || missing.length > 0 || held.length > 0 || failed.length > 0 || ambiguous.length > 0 || stale.length > 0) lines.push('  photos curation show <eventId> says what each one needs.');
    return lines;
}
