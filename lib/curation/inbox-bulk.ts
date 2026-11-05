import { REVISION_ID_RE } from '../catalog/schema';
import { dataRootStatus } from '../storage/config';
import { EVENT_ID_RE } from './events';
import { runInboxAction } from './inbox-form';
import { DONE_ANSWER, type BulkKind, type BulkResult, type InboxBulkState } from './inbox-view';
import { BULK_DEFER_TYPES, INBOX_PAGE_SIZE } from './inbox-list';
import { readEvent } from './repository';

/**
 * #14 (A8): the Inbox list's bulk actions, Decide later (the mockup's "Leave
 * in draft") and Leave unassigned, on the rows the curator checked. Each row
 * sends its own item and the version the page showed (`items`, as
 * `evt_…:<version>`), and the form the active revision, so each item is
 * checked under the lock against what the curator saw, as a single action is.
 * The server is the gate: each item runs through runInboxAction(), one after
 * another, and one that moved, or that its writer refuses, is left as it is
 * while the rest go through. app/curation/inbox/actions.ts calls this only
 * after requireCurator() lets the request in.
 *
 * - Decide later is the page's own defer: #17's leaveInDraft(), and only for
 *   a new photograph or a file the watcher couldn't process (A8 review S1).
 *   Any other type is refused here, item by item: what Decide later does to
 *   a replacement's draft or the library is decided on that item alone.
 * - Leave unassigned approves a new photograph into the draft with no series
 *   (14-1's approve, with `keepPlaced`, so a photograph a series holds is
 *   refused), keeping any description saved on the item. An item with a
 *   series saved on it is refused under the lock (`keepSavedSeries`, S2).
 *
 * An item that went through with an answer of its own, such as an approval
 * that says publishing waits for a description, is marked `note`, so the page
 * lists it.
 */

/** What bulk Decide later answers for a type it doesn't take (A8 review S1). */
export const DEFER_TYPE_REFUSAL = "Decide later on selected takes new photographs and files the watcher couldn't process. Open this item to decide it on its own. Nothing was written.";

/** As many as one page of the list shows, which is all a curator can check at once. */
export const MAX_BULK_ITEMS = INBOX_PAGE_SIZE;

const ENTRY_RE = /^(evt_[0-9a-f]{24}):([1-9]\d{0,9})$/;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

let serial = 0;

/**
 * What the whole action says, by how many went through. What was left alone is the error summary's alone (N1), and
 * each item's own answer is in `results`.
 */
function headline(kind: BulkKind, done: number, total: number): string {
    if (kind === 'defer') {
        if (done === 0) return 'Nothing was left for later.';
        return `Left ${done === total ? plural(done, 'item', 'items') : `${done} of ${plural(total, 'item', 'items')}`} for later.`;
    }
    if (done === 0) return 'Nothing was approved.';
    const count = done === total ? plural(done, 'new photograph', 'new photographs') : `${done} of ${plural(total, 'new photograph', 'new photographs')}`;
    return `Approved ${count} into the draft, unassigned. Nothing is published until you publish.`;
}

/** The answer an item gets when nothing more needs saying; any other done answer is a note (S1). */
const PLAIN: Record<BulkKind, string> = { defer: DONE_ANSWER.defer, unassigned: DONE_ANSWER.approve };

/** Run one bulk action from its form. Never throws for anything the form or the data holds. */
export async function runInboxBulk(kind: BulkKind, form: unknown, options: Parameters<typeof runInboxAction>[2] = {}): Promise<InboxBulkState> {
    serial += 1;
    const safeKind: BulkKind = kind === 'unassigned' ? 'unassigned' : 'defer';
    const refuse = (message: string): InboxBulkState => ({ status: 'invalid', kind: safeKind, message, field: 'items', results: [], serial });
    if (kind !== 'defer' && kind !== 'unassigned') return refuse('That bulk action is not one the inbox offers. Refresh the inbox. Nothing was written.');
    if (!(form instanceof FormData)) return refuse('The form was empty. Refresh the inbox. Nothing was written.');
    const base = form.get('base');
    if (typeof base !== 'string' || (base !== 'none' && !REVISION_ID_RE.test(base))) return refuse("The form carries no active revision. Refresh the inbox. Nothing was written.");
    const entries = form.getAll('items');
    if (entries.length === 0) return refuse('Select at least one item first. Nothing was written.');
    if (entries.length > MAX_BULK_ITEMS) return refuse(`A bulk action takes at most ${MAX_BULK_ITEMS} items, one page of the list. Nothing was written.`);
    const items: { eventId: string; version: string }[] = [];
    for (const entry of entries) {
        const match = typeof entry === 'string' ? ENTRY_RE.exec(entry) : null;
        if (match === null || !EVENT_ID_RE.test(match[1])) return refuse('A selected item carries no item or version the inbox can read. Refresh the inbox. Nothing was written.');
        if (items.some((item) => item.eventId === match[1])) return refuse('An item is selected more than once. Refresh the inbox. Nothing was written.');
        items.push({ eventId: match[1], version: match[2] });
    }
    const results: BulkResult[] = [];
    const root = dataRootStatus().root;
    for (const { eventId, version } of items) {
        if (kind === 'defer' && root !== null) {
            // A type never changes, so this read needs no lock: a moved item is still the writer's to call stale.
            const type = await readEvent(root, eventId).then((event) => event?.type ?? null, () => null);
            if (type !== null && !BULK_DEFER_TYPES.has(type)) {
                results.push({ eventId, status: 'refused', message: DEFER_TYPE_REFUSAL });
                continue;
            }
        }
        const single = new FormData();
        single.set('eventId', eventId);
        single.set('version', version);
        single.set('base', base);
        if (kind === 'unassigned') {
            // As the item's own form sends an approval left unassigned, with nothing typed: a saved description stays.
            single.set('series', 'unassigned');
            single.set('decorative', 'off');
        }
        const answer = await runInboxAction(kind === 'defer' ? 'defer' : 'approve', single, { ...options, ...(kind === 'unassigned' ? { keepSavedSeries: true } : {}) });
        if (answer.status === 'idle') results.push({ eventId, status: 'failed', message: "The inbox couldn't finish that. Nothing was written." });
        else results.push({ eventId, status: answer.status, message: answer.message, ...(answer.status === 'done' && answer.message !== PLAIN[kind] ? { note: true } : {}) });
    }
    const done = results.filter((result) => result.status === 'done').length;
    return { status: done === results.length ? 'done' : done === 0 ? 'refused' : 'partial', kind, message: headline(kind, done, results.length), results, serial };
}
