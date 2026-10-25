/**
 * Interface copy the catalog pages show beside authored text. It imports
 * nothing, so any component can use it without reaching the reader or a
 * projection, which are server-only (#3).
 */

/** The count line under a Work entry's statement: interface copy, not authored. */
export function photoCountLabel(count: number): string {
    return count === 1 ? '1 photograph' : `${count} photographs`;
}
