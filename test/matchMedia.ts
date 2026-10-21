/**
 * A window.matchMedia stub that dispatches change events, since jsdom has
 * none. vitest.setup.ts installs it before each test with reduced motion off.
 */

const REDUCE = '(prefers-reduced-motion: reduce)';
const NO_PREFERENCE = '(prefers-reduced-motion: no-preference)';

type Listener = (event: MediaQueryListEvent) => void;

let reduce = false;
const listeners = new Map<string, Set<Listener>>();

/** Every change listener added and removed since the last install, so a test can check they balance. */
export const mediaListenerCounts = { added: 0, removed: 0 };

const normalize = (query: string) => query.replace(/\s+/g, ' ').trim();

function matchesQuery(query: string): boolean {
    if (query === REDUCE) return reduce;
    if (query === NO_PREFERENCE) return !reduce;
    return false;
}

function listFor(rawQuery: string): MediaQueryList {
    const media = normalize(rawQuery);
    const own = () => {
        let set = listeners.get(media);
        if (!set) listeners.set(media, (set = new Set()));
        return set;
    };
    const add = (listener: Listener) => {
        mediaListenerCounts.added += 1;
        own().add(listener);
    };
    const remove = (listener: Listener) => {
        mediaListenerCounts.removed += 1;
        own().delete(listener);
    };
    return {
        media,
        get matches() {
            return matchesQuery(media);
        },
        onchange: null,
        addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => add(listener as Listener),
        removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => remove(listener as Listener),
        addListener: (listener: Listener | null) => listener && add(listener),
        removeListener: (listener: Listener | null) => listener && remove(listener),
        dispatchEvent: () => true,
    } as unknown as MediaQueryList;
}

export function installMatchMedia(): void {
    reduce = false;
    listeners.clear();
    mediaListenerCounts.added = 0;
    mediaListenerCounts.removed = 0;
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: listFor });
}

/** Switches prefers-reduced-motion and tells every listener, like a live system setting change. */
export function setPrefersReducedMotion(matches: boolean): void {
    if (reduce === matches) return;
    reduce = matches;
    for (const [media, set] of listeners) {
        if (media !== REDUCE && media !== NO_PREFERENCE) continue;
        for (const listener of [...set]) listener({ matches: matchesQuery(media), media } as MediaQueryListEvent);
    }
}
