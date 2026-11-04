/**
 * Canonical JSON, used for content hashes. It lives here, not in lib/identity,
 * so lib/storage can hash a document without importing identity code.
 */

function canonicalize(value: unknown, at: string): unknown {
    if (typeof value === 'string') return value.normalize('NFC');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: ${at} is ${value}, which JSON can't hold`);
        return value;
    }
    // Array.from visits holes too, as undefined, which JSON would turn into null.
    if (Array.isArray(value)) return Array.from(value, (inner, index) => canonicalize(inner, `${at}[${index}]`));
    if (typeof value === 'object') {
        const prototype = Object.getPrototypeOf(value) as unknown;
        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError(`canonicalJson: ${at} is a ${(value as { constructor?: { name?: string } }).constructor?.name || 'class instance'}, not plain JSON`);
        }
        const entries = Object.entries(value)
            .filter(([, inner]) => inner !== undefined)
            .map(([key, inner]): [string, unknown] => [key.normalize('NFC'), canonicalize(inner, `${at}.${key}`)])
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return Object.fromEntries(entries);
    }
    throw new TypeError(`canonicalJson: ${at} is ${value === undefined ? 'undefined' : `a ${typeof value}`}, not plain JSON`);
}

/**
 * JSON with object keys sorted at every level, array order kept, absent
 * optionals left out, strings and keys in NFC, and no whitespace, so equal
 * values always serialize the same way. Throws a TypeError for anything that
 * isn't plain JSON, such as a Date, a Map, a class instance, a function, a
 * bigint, a non-finite number, or undefined anywhere but as an object's
 * value, rather than serializing it as something else.
 */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(canonicalize(value, 'the value'));
}

/** Equal as plain JSON with every string the same, absent optionals left out: a cheap check before canonicalJson()'s. */
function identical(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a)) {
        if (!Array.isArray(b) || a.length !== b.length) return false;
        for (let index = 0; index < a.length; index++) if (!identical(a[index], b[index])) return false;
        return true;
    }
    if (Array.isArray(b)) return false;
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    let count = 0;
    for (const key in left) {
        if (!Object.hasOwn(left, key) || left[key] === undefined) continue;
        if (!Object.hasOwn(right, key) || !identical(left[key], right[key])) return false;
        count++;
    }
    for (const key in right) if (Object.hasOwn(right, key) && right[key] !== undefined) count--;
    return count === 0;
}

/**
 * Whether two values have the same canonicalJson(), with null standing in
 * for an absent one. Values that are the same plain JSON, string for
 * string, answer at once, so comparing large unchanged records doesn't
 * build their canonical text. Anything else is compared as canonicalJson()
 * would, NFC and all.
 */
export function sameCanonical(a: unknown, b: unknown): boolean {
    const left = a ?? null;
    const right = b ?? null;
    return identical(left, right) || canonicalJson(left) === canonicalJson(right);
}
