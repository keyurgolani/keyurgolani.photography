/**
 * What the Inbox keeps across its own page loads, in this tab's
 * sessionStorage, so moving between items stays where the curator is
 * (owner, 2026-10-25): the row a phone left the list from, and how far down
 * the list was, so "Back to inbox" and the browser's Back return there with
 * that row focused. Nothing in it is sent anywhere. What's read back is
 * checked before use, since anything in the tab could have written it.
 */

const RETURN_KEY = 'curation-inbox:return';
const EVENT_ID = /^evt_[0-9a-f]{24}$/;

export interface ListReturn {
    /** The row's event ID. */
    id: string;
    scrollY: number;
}

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
