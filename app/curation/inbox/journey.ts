/**
 * What the Inbox keeps across its own page loads, in this tab's
 * sessionStorage, so moving between items stays where the curator is
 * (owner, 2026-10-25):
 * - the row a phone left the list from, and how far down the list was, so
 *   "Back to inbox" and the browser's Back return there with that row focused;
 * - the answer to an approval or Decide later, carried to the next item it
 *   opens, so the page can say what happened once it's there.
 * Nothing in it is sent anywhere. What's read back is checked before use,
 * since anything in the tab could have written it.
 */

const RETURN_KEY = 'curation-inbox:return';
const ARRIVAL_KEY = 'curation-inbox:arrival';
/** An arrival older than this is left over from an earlier visit, not the page that set it. */
const ARRIVAL_MS = 30_000;
const EVENT_ID = /^evt_[0-9a-f]{24}$/;

export interface ListReturn {
    /** The row's event ID. */
    id: string;
    scrollY: number;
}

export interface Arrival {
    /** The item it opens, or null for the empty state. */
    to: string | null;
    /** The item just decided, and its file name, for "Open … again". */
    from: string;
    fromName: string;
    /** The action's own answer. */
    message: string;
    at: number;
}

/** Where the page goes next. A seam, so the tests can see where without leaving the page. */
export const navigation = {
    replace(url: string): void {
        window.location.replace(url);
    },
};

function read(key: string): unknown {
    try {
        const raw = window.sessionStorage.getItem(key);
        return raw === null ? null : JSON.parse(raw);
    } catch {
        return null;
    }
}

function write(key: string, value: unknown): void {
    try {
        window.sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Storage can be full or off. The page still works; it just doesn't return to the row.
    }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export function rememberRow(id: string, scrollY: number): void {
    if (EVENT_ID.test(id)) write(RETURN_KEY, { id, scrollY: Math.max(0, Math.round(scrollY)) });
}

export function rememberedRow(): ListReturn | null {
    const value = read(RETURN_KEY);
    if (!isObject(value) || typeof value.id !== 'string' || !EVENT_ID.test(value.id) || typeof value.scrollY !== 'number' || !Number.isFinite(value.scrollY)) return null;
    return { id: value.id, scrollY: Math.max(0, value.scrollY) };
}

/** The URL that opens an item, the same one every row links to. */
export const itemUrl = (id: string) => `/curation/inbox?item=${id}#item`;

/**
 * Open the item an approval or Decide later leads to, or the empty inbox,
 * carrying the answer along. It replaces the history entry, so Back from the
 * next item goes to the list, not to the item just decided. The row the
 * list returns to becomes the one opened.
 */
export function moveOn(arrival: Omit<Arrival, 'at'>): void {
    write(ARRIVAL_KEY, { ...arrival, at: Date.now() });
    if (arrival.to !== null) {
        const row = rememberedRow();
        rememberRow(arrival.to, row?.scrollY ?? 0);
    }
    navigation.replace(arrival.to === null ? '/curation/inbox' : itemUrl(arrival.to));
}

/** The arrival meant for this page (`to`, the item it shows, or null for none), once: reading it clears it. */
export function takeArrival(to: string | null): Arrival | null {
    const value = read(ARRIVAL_KEY);
    if (!isObject(value)) return null;
    const ok =
        (value.to === null || (typeof value.to === 'string' && EVENT_ID.test(value.to))) &&
        typeof value.from === 'string' &&
        EVENT_ID.test(value.from) &&
        typeof value.fromName === 'string' &&
        typeof value.message === 'string' &&
        typeof value.at === 'number';
    if (!ok || value.to !== to) return null;
    try {
        window.sessionStorage.removeItem(ARRIVAL_KEY);
    } catch {
        // As write().
    }
    const at = value.at as number;
    if (Date.now() - at > ARRIVAL_MS || at > Date.now() + 1_000) return null;
    return { to, from: value.from as string, fromName: (value.fromName as string).slice(0, 300), message: (value.message as string).slice(0, 1_000), at };
}
