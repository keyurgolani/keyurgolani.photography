/**
 * The plain-text rules for public copy the owner commands take in:
 * `describe --import`'s alt, title, and caption, and `sequence chapter add`'s
 * title. What passes is stored as written and, for imported descriptions,
 * marked reviewed, so anything a reader can't see is refused rather than
 * carried along.
 */

/**
 * The most characters (code points, after NFC) each text field takes. A
 * chapter title takes `title`'s. The description rules still warn about alt
 * text past 250.
 */
export const FIELD_LIMITS = { alt: 1000, title: 200, caption: 2000 } as const;

export const codePointName = (codePoint: number) => `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;

/** Format characters a script or an emoji needs: ZWNJ, ZWJ, LRM, and RLM. */
const KEPT_FORMAT = new Set([0x200c, 0x200d, 0x200e, 0x200f]);

const FORMAT = /^\p{Cf}$/u;
const PRIVATE_USE = /^\p{Co}$/u;
const UNASSIGNED = /^\p{Cn}$/u;
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;

const isTagSpec = (codePoint: number) => codePoint >= 0xe0020 && codePoint <= 0xe007e;
const CANCEL_TAG = 0xe007f;

/** Why a code point is refused, or null. Named reasons first, then the general categories. */
function reasonFor(codePoint: number, character: string): string | null {
    if (codePoint === 0x0a) return null;
    if (codePoint < 0x20 || codePoint === 0x7f) return 'a control character';
    if (codePoint >= 0x80 && codePoint <= 0x9f) return 'a C1 control character';
    if (codePoint >= 0x202a && codePoint <= 0x202e) return 'a bidi embedding or override';
    if (codePoint >= 0x2066 && codePoint <= 0x2069) return 'a bidi isolate';
    if (codePoint === 0x200b) return 'a zero-width space';
    if (codePoint === 0x2060) return 'a word joiner';
    if (codePoint === 0xfeff) return 'a byte order mark';
    if (codePoint === 0x00ad) return 'a soft hyphen';
    if (codePoint === 0x2028 || codePoint === 0x2029) return 'a Unicode line or paragraph separator, where a plain line break goes';
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 'half of a surrogate pair';
    if (codePoint === 0xfffd) return 'the replacement character, which a broken text conversion leaves';
    if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return 'a tag character, which hides text outside an emoji flag';
    if (FORMAT.test(character)) return KEPT_FORMAT.has(codePoint) ? null : 'an invisible format character';
    if (PRIVATE_USE.test(character)) return 'a private-use character';
    if (UNASSIGNED.test(character)) return 'an unassigned code point';
    return null;
}

/**
 * The first character `value` may not hold, with its 1-based position and
 * why, or null. Refused: C0 and C1 controls but the line feed, DEL, every
 * format character (Cf) but ZWNJ, ZWJ, LRM, and RLM, private use (Co),
 * unassigned code points and noncharacters (Cn), lone surrogates, U+2028 and
 * U+2029, and U+FFFD. Tag characters pass only as an emoji tag sequence: a
 * pictographic emoji, tags from U+E0020 to U+E007E, and the cancel tag
 * U+E007F, as the England, Scotland, and Wales flags are written.
 */
export function refusedCharacter(value: string): { codePoint: number; index: number; why: string } | null {
    const characters = [...value];
    for (let i = 0; i < characters.length; i++) {
        const character = characters[i];
        const codePoint = character.codePointAt(0) ?? 0;
        if (PICTOGRAPHIC.test(character)) {
            let end = i + 1;
            while (end < characters.length && isTagSpec(characters[end].codePointAt(0) ?? 0)) end++;
            if (end > i + 1 && characters[end]?.codePointAt(0) === CANCEL_TAG) {
                i = end;
                continue;
            }
        }
        const why = reasonFor(codePoint, character);
        if (why !== null) return { codePoint, index: i + 1, why };
    }
    return null;
}

export type PlainTextProblem =
    | { kind: 'character'; codePoint: number; index: number; why: string }
    | { kind: 'line-break' }
    | { kind: 'length'; length: number; limit: number };

/**
 * `value` as it is stored: line breaks as LF, trimmed, checked by
 * refusedCharacter(), NFC, and at most `limit` characters (code points). A
 * line break is refused unless `lineBreaks`. An empty result is `''`.
 */
export function plainText(value: string, { limit, lineBreaks = false }: { limit: number; lineBreaks?: boolean }): { ok: true; text: string } | { ok: false; problem: PlainTextProblem } {
    const text = value.replace(/\r\n?/g, '\n').trim();
    const refused = refusedCharacter(text);
    if (refused) return { ok: false, problem: { kind: 'character', ...refused } };
    if (!lineBreaks && text.includes('\n')) return { ok: false, problem: { kind: 'line-break' } };
    const normalized = text.normalize('NFC');
    const length = [...normalized].length;
    if (length > limit) return { ok: false, problem: { kind: 'length', length, limit } };
    return { ok: true, text: normalized };
}
