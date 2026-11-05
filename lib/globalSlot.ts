/**
 * One value per process, kept on globalThis under a Symbol.for() key, so a
 * module that Next or vitest loads more than once in one process still sees
 * the same value. Every module's process-wide state goes through here: it is
 * the one place that reads the global object by a computed key, which the
 * delete-call rail allowlists (#181's A10 review, item 48's N4).
 */
export function globalSlot<T>(key: symbol, init: () => T): T {
    const holder = globalThis as unknown as Record<symbol, T | undefined>;
    holder[key] ??= init();
    return holder[key] as T;
}
