/**
 * One value per process, kept on globalThis under a Symbol.for() key, so a
 * module that Next or vitest loads more than once in one process still sees
 * the same value. Every module's process-wide state goes through here: it is
 * the one place that reads the global object by a computed key, which the
 * delete-call rail allowlists (#181's A10 review, item 48's N4).
 */
export function globalSlot<T>(key: SlotKey<T>, init: () => T): T {
    const holder = globalThis as unknown as Record<symbol, T | undefined>;
    holder[key] ??= init();
    return holder[key] as T;
}

declare const holds: unique symbol;

/**
 * A slot's key: a Symbol.for() key that carries the type of the value its
 * slot holds, both ways, so a slot can't be made or read as another type,
 * a wider one included, and a bare symbol keys no slot.
 */
export type SlotKey<T> = symbol & { readonly [holds]: (value: T) => T };

/**
 * The key for a slot holding a `T`: `key` itself, typed. The caller passes
 * Symbol.for() with a plain name, which keeps every registered key's name
 * in the open (see eslint.config.js). Each slot's own module makes its key,
 * under a name no other slot uses; a test pins both.
 */
export const slotKey = <T>(key: symbol): SlotKey<T> => key as SlotKey<T>;
