import { EVENT_STATUSES, EVENT_TYPES, type CurationEventStatus, type CurationEventType } from './events';
import { ageText, BADGE_LABELS, fileParts, itemName, type InboxItem } from './inbox-view';

/**
 * #14 (A8): the Inbox list's Status and Type filters, its pages of 50, its
 * age labels, which rows a bulk action can take, and a name of its own for
 * every row. Pure: the page (a server component) and the loader use it, and
 * nothing here reads or writes. The filters are built from EVENT_STATUSES and
 * EVENT_TYPES, so a type a later PR adds, as A6 added `library-unavailable`,
 * is listed without a change here.
 */

export const INBOX_PAGE_SIZE = 50;

/** The highest page the URL may name. Far past any real inbox: a larger number is junk, and reads as page 1. */
const MAX_PAGE = 9_999;

export interface InboxQuery {
    status: CurationEventStatus | null;
    type: CurationEventType | null;
    page: number;
}

export const ANY_QUERY: InboxQuery = { status: null, type: null, page: 1 };

/** The Status filter's words, one per stored status. Not STATUS_LABELS, whose "Draft only" is a new photograph's. */
const STATUS_FILTER_LABELS: Record<CurationEventStatus, string> = {
    open: 'Open',
    deferred: 'Left for later',
    dismissed: 'Dismissed',
    approved: 'Approved or confirmed',
    failed: 'Not processed',
    resolved: 'Resolved',
};

export const STATUS_FILTERS: readonly { value: CurationEventStatus; label: string }[] = EVENT_STATUSES.map((value) => ({ value, label: STATUS_FILTER_LABELS[value] }));
export const TYPE_FILTERS: readonly { value: CurationEventType; label: string }[] = EVENT_TYPES.map((value) => ({ value, label: BADGE_LABELS[value] }));

const one = (value: string | string[] | undefined): string | null => (typeof value === 'string' ? value : null);

/**
 * The list's query, from the page's search params. Anything it doesn't know, or a value given twice, is the default,
 * never an error: a hand-typed URL still shows the inbox.
 */
export function parseInboxQuery(params: Record<string, string | string[] | undefined>): InboxQuery {
    const status = one(params.status);
    const type = one(params.type);
    const page = one(params.page);
    return {
        status: status !== null && (EVENT_STATUSES as readonly string[]).includes(status) ? (status as CurationEventStatus) : null,
        type: type !== null && (EVENT_TYPES as readonly string[]).includes(type) ? (type as CurationEventType) : null,
        page: page !== null && /^[1-9]\d{0,3}$/.test(page) && Number(page) <= MAX_PAGE ? Number(page) : 1,
    };
}

/** The query as the URL carries it, `?status=…&type=…&page=…` then `extra`, defaults left out; '' with nothing to say. */
export function inboxQueryString(query: InboxQuery, extra: Record<string, string> = {}): string {
    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    if (query.type) params.set('type', query.type);
    if (query.page > 1) params.set('page', String(query.page));
    for (const [name, value] of Object.entries(extra)) params.set(name, value);
    const text = params.toString();
    return text ? `?${text}` : '';
}

export function matchesQuery(item: Pick<InboxItem, 'status' | 'type'>, query: Pick<InboxQuery, 'status' | 'type'>): boolean {
    return (query.status === null || item.status === query.status) && (query.type === null || item.type === query.type);
}

export interface ListPage<T> {
    items: T[];
    /** How many items the filters keep. */
    total: number;
    /** The page shown: the one asked for, or the last one when that's past the end. */
    page: number;
    pages: number;
    /** 1-based, and 0 for both when nothing matches. */
    from: number;
    to: number;
}

/** The items the filters keep, in the list's order, `INBOX_PAGE_SIZE` at a time. */
export function listPage<T extends Pick<InboxItem, 'status' | 'type'>>(items: readonly T[], query: InboxQuery): ListPage<T> {
    const kept = items.filter((item) => matchesQuery(item, query));
    const pages = Math.max(1, Math.ceil(kept.length / INBOX_PAGE_SIZE));
    const page = Math.min(query.page, pages);
    const start = (page - 1) * INBOX_PAGE_SIZE;
    const shown = kept.slice(start, start + INBOX_PAGE_SIZE);
    return { items: shown, total: kept.length, page, pages, from: shown.length === 0 ? 0 : start + 1, to: start + shown.length };
}

/**
 * How long ago the item opened, from when the page read the inbox: "Opened 3 h ago", in ageText()'s short words. A
 * stamp ahead of the server's clock reads as under a minute, and one that isn't a time says nothing.
 */
export function ageLabel(readAt: string, observedAt: string): string {
    const now = Date.parse(readAt);
    const then = Date.parse(observedAt);
    if (Number.isNaN(now) || Number.isNaN(then)) return '';
    return `Opened ${ageText(Math.max(0, now - then))} ago`;
}

/**
 * Which bulk action a row's item could take, as the writers decide it before their lock: Decide later takes an open
 * or failed item (deferEvent()'s states), and Leave unassigned a new photograph's open or deferred item that no
 * series holds now (an approval never takes a photograph out of one). The server checks each again, version and all.
 */
export function bulkChoices(item: Pick<InboxItem, 'type' | 'status' | 'group'>): { defer: boolean; unassigned: boolean } {
    return {
        defer: item.status === 'open' || item.status === 'failed',
        unassigned: item.type === 'new' && (item.status === 'open' || item.status === 'deferred') && item.group !== 'placed' && item.group !== 'unplaced',
    };
}

/**
 * A name of its own for every row on the page, for its checkbox and the bulk error summary (contract rule 2): the
 * file's name, and for two alike, the first of these that tells them apart: the item's title, its folder, both, the
 * photo ID's head and tail, then its place on the page.
 */
export function rowLabels(items: readonly InboxItem[]): Map<string, string> {
    const ways: ((item: InboxItem, index: number) => string)[] = [
        (item) => itemName(item),
        (item) => `${itemName(item)}, ${item.title}`,
        (item) => `${itemName(item)} in ${fileParts(item.sourcePath).folder ?? 'the top folder'}`,
        (item) => `${itemName(item)} in ${fileParts(item.sourcePath).folder ?? 'the top folder'}, ${item.title}`,
        (item) => `${itemName(item)}, ${item.title}, ${item.shortId}`,
        (item, index) => `${itemName(item)}, ${item.title}, row ${index + 1}`,
    ];
    const labels = new Map<string, string>();
    const byName = new Map<string, number[]>();
    items.forEach((item, index) => byName.set(itemName(item), [...(byName.get(itemName(item)) ?? []), index]));
    for (const indexes of byName.values()) {
        const way = ways.find((make) => new Set(indexes.map((index) => make(items[index], index))).size === indexes.length) ?? ways[ways.length - 1];
        for (const index of indexes) labels.set(items[index].id, way(items[index], index));
    }
    return labels;
}
