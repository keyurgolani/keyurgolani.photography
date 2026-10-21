/**
 * A name folded the way a case-insensitive disk such as APFS compares names.
 * It folds every letter that has an uppercase or lowercase form, so this
 * lowers, uppers, and lowers again, in NFC: that takes the capital sharp s to
 * ß, then to SS, then to ss, so Straße and strasse fold alike, and the long s
 * to s. The proxy, the identity scan, and the derivative pipeline all compare
 * names through it, so none of them tells apart two names the disk doesn't.
 */
export function foldName(name: string): string {
    return name.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().normalize('NFC');
}
