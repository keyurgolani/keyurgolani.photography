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
