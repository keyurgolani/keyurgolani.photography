import { REVISION_ID_RE, SERIES_ID_RE } from './schema';

/**
 * #6's series continuation cursor: where the next page of one series starts,
 * in one revision. The server makes every cursor; a client only hands back
 * one it was given. It is opaque (base64url of `1.<revisionId>.<seriesId>.<offset>`)
 * and unsigned: it names a position, not a permission. A changed cursor can
 * only name the active revision (else the route answers 409), the series in
 * the path (else 400), and a page offset in range (else 400), so the page it
 * gets is one Show more reaches anyway, from records the revision already
 * publishes. `.` appears in no revision ID, series ID, or offset, so the
 * split is unambiguous.
 */

export interface SeriesCursor {
    revisionId: string;
    seriesId: string;
    /** 0-based index of the page's first entry among the series' resolved members. Always positive: page 1 is server-rendered. */
    offset: number;
}

const VERSION = '1';
/** Longer than any cursor encode() makes (about 200 characters), so a bigger input is refused before it's decoded. */
export const MAX_CURSOR_LENGTH = 256;
const MAX_OFFSET = 9_999_999;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const DECODED_RE = /^1\.(rev_[0-9a-f]{64})\.(ser_[a-z0-9][a-z0-9_-]{1,62})\.([1-9][0-9]{0,6})$/;

export function encodeSeriesCursor({ revisionId, seriesId, offset }: SeriesCursor): string {
    if (!REVISION_ID_RE.test(revisionId)) throw new TypeError('A cursor needs a revision ID, rev_ plus 64 hex.');
    if (!SERIES_ID_RE.test(seriesId)) throw new TypeError('A cursor needs a series ID.');
    if (!Number.isInteger(offset) || offset < 1 || offset > MAX_OFFSET) throw new RangeError(`A cursor offset is an integer from 1 to ${MAX_OFFSET}.`);
    return Buffer.from(`${VERSION}.${revisionId}.${seriesId}.${offset}`, 'ascii').toString('base64url');
}

/**
 * The cursor `text` names, or null for anything encode() wouldn't have made:
 * too long, outside base64url, a second encoding of the same bytes, another
 * version, or a field out of shape. Nothing here reads the catalog.
 */
export function decodeSeriesCursor(text: unknown): SeriesCursor | null {
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_CURSOR_LENGTH || !BASE64URL_RE.test(text)) return null;
    const bytes = Buffer.from(text, 'base64url');
    // Canonical only: padding, stray bits in the last character, or anything Node's decoder skipped would re-encode differently.
    if (bytes.toString('base64url') !== text) return null;
    const match = DECODED_RE.exec(bytes.toString('latin1'));
    if (match === null) return null;
    const [, revisionId, seriesId, offset] = match;
    if (!SERIES_ID_RE.test(seriesId)) return null;
    return { revisionId, seriesId, offset: Number(offset) };
}
