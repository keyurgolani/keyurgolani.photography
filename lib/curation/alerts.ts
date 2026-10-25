import { printable } from './commands';
import { shortPhotoId, type CurationEvent } from './events';
import { photoHolders, type ReferenceCache } from './holders';
import { listEvents } from './repository';

/**
 * #17's alerting: the open missing sources and failures in the curation
 * inbox, for `photos status`. #13 slice D's `photos status`
 * (lib/catalog/owner-status.ts on `feat/13d-owner-authoring`) isn't on this
 * branch's base, so this is the one function its status calls: inboxAlerts()
 * for `--json`, inboxAlertLines() for the text. It reads only, takes no
 * lock, and prints no absolute path.
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
    /** For a missing source: who still shows the photograph, or null when the data root can't tell. */
    shownBy?: string[] | null;
    /** For a failure: what failed, without a host path. */
    failure?: string;
}

export interface InboxAlerts {
    missing: InboxAlert[];
    failed: InboxAlert[];
    /** Inbox items that can't be read, which `curation list` names. */
    unreadable: number;
}

/** A failure in the inbox: a failed processing item or set, open or left in draft. */
function failureOf(event: CurationEvent): string | null {
    if (!STILL_OPEN.has(event.status)) return null;
    if (event.candidate?.state === 'failed') return `derivative set ${event.candidate.failure ?? 'build'}`;
    if (event.type === 'processing-failure') return event.derivedFacts.failure ?? 'processing failed';
    return event.status === 'failed' ? 'failed' : null;
}

const byAge = (a: InboxAlert, b: InboxAlert) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.eventId < b.eventId ? -1 : 1);

/** The open missing and failed items, oldest first. */
export async function inboxAlerts(root: string): Promise<InboxAlerts> {
    const { events, problems } = await listEvents(root);
    const cache: ReferenceCache = {};
    const missing: InboxAlert[] = [];
    const failed: InboxAlert[] = [];
    for (const event of events) {
        const base = { eventId: event.id, version: event.version, type: event.type, status: event.status, photoId: event.photoId, sourcePath: event.derivedFacts.sourcePath, since: event.observedAt };
        if (event.type === 'missing' && STILL_OPEN.has(event.status)) {
            const found = event.photoId === null ? { holders: [] } : await photoHolders(root, event.photoId, cache);
            missing.push({ ...base, shownBy: 'holders' in found ? found.holders : null });
            continue;
        }
        const failure = failureOf(event);
        if (failure !== null) failed.push({ ...base, failure });
    }
    return { missing: missing.sort(byAge), failed: failed.sort(byAge), unreadable: problems.length };
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** The status lines: a summary, then one line per item. */
export function inboxAlertLines(alerts: InboxAlerts): string[] {
    const { missing, failed, unreadable } = alerts;
    const lines = [`Inbox: ${count(missing.length, 'missing source')}, ${count(failed.length, 'failure')} open${unreadable > 0 ? `, ${count(unreadable, 'item')} unreadable (curation list names them)` : ''}`];
    for (const item of missing) {
        const shown = item.shownBy === null || item.shownBy === undefined
            ? "the data root can't show whether anything references it"
            : item.shownBy.length === 0 ? 'nothing references it' : `${item.shownBy.join(' and ')} still ${item.shownBy.length === 1 ? 'shows' : 'show'} it`;
        lines.push(`  missing  ${shortPhotoId(item.photoId)}  ${printable(item.sourcePath)}  since ${item.since}, ${item.status}; ${shown}  (${item.eventId}@${item.version})`);
    }
    for (const item of failed) {
        lines.push(`  failed   ${shortPhotoId(item.photoId)}  ${printable(item.sourcePath)}  since ${item.since}, ${item.type}: ${item.failure}  (${item.eventId}@${item.version})`);
    }
    if (missing.length > 0 || failed.length > 0) lines.push('  curation show <eventId> says what each one needs.');
    return lines;
}
