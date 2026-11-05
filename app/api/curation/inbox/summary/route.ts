import { requireCurator } from '@/lib/curation/auth';
import { loadInboxSummary } from '@/lib/curation/inbox';

/**
 * #14 (v2.0.0 A8): the Inbox's summary, which the page's 60 s poll reads
 * (lib/curation/inbox-watch.ts): the counts, the watcher, and for the item
 * the page has open, its ID, version and status. Only what the Inbox page
 * already shows, so never a path, a file name, a photo ID or a revision.
 * It also answers `cursor`, the newest arrival sequence (lib/curation/
 * arrivals.ts), and given `since`, a cursor it answered before, how many
 * items needing judgment arrived after it. A cursor it didn't issue, ahead
 * of its own or not a whole number, is a 400 (A8 review, 4a).
 *
 * requireCurator() runs first, before the query or the data root is read, so
 * on `web`, where the flag is never on, and for any request the boundary
 * refuses, nothing here runs; proxy.ts has already answered one without a
 * session with a 401. It reads and writes nothing else, takes GET only (Next
 * answers any other method with a 405), and every answer is `no-store`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEADERS = { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };

const EVENT_ID_RE = /^evt_[0-9a-f]{24}$/;
/** A cursor as the summary writes it: a whole number, no sign, no leading zero, at most 15 digits. */
const SINCE_RE = /^(0|[1-9]\d{0,14})$/;

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: HEADERS });

export async function GET(request: Request): Promise<Response> {
    await requireCurator({ read: true });
    // The query takes one optional `item`, an event ID, and one optional `since`, a whole number, and nothing else.
    const { searchParams } = new URL(request.url);
    const names = [...searchParams.keys()];
    const items = searchParams.getAll('item');
    const since = searchParams.getAll('since');
    if (
        names.some((name) => name !== 'item' && name !== 'since') ||
        items.length > 1 ||
        (items.length === 1 && !EVENT_ID_RE.test(items[0])) ||
        since.length > 1 ||
        (since.length === 1 && !SINCE_RE.test(since[0]))
    ) {
        return answer(400, { error: 'bad-query' });
    }
    try {
        const summary = await loadInboxSummary(items[0] ?? null, { since: since.length === 1 ? Number(since[0]) : null });
        if (summary.state === 'bad-cursor') return answer(400, { error: 'bad-cursor' });
        return summary.state === 'ready' ? answer(200, summary) : answer(503, { state: 'not-ready' });
    } catch (error) {
        // A read error can name a host path, so the answer says only that it failed. The server log keeps the rest.
        console.error('[curation] The inbox summary could not be read:', error);
        return answer(500, { error: 'unreadable' });
    }
}
