/**
 * Accessible names for photographs, per contract rule 2 in
 * docs/accessibility-contract.md. PhotoAlt matches PublicPhotoRecord.alt in
 * #13, and the first PR that imports both deletes this copy.
 */
export type PhotoAlt = { kind: 'described'; text: string; reviewed?: true } | { kind: 'decorative' };

type Input = {
    alt?: PhotoAlt;
    /** 1-based. */
    position: number;
    total: number;
};

/** Trailing whitespace and the punctuation that would double up before ", photograph N of T". */
const TRAILING = /[\s.,;:]+$/;

/** "N of T". Throws unless both are whole numbers with 1 <= position <= total. */
function counter({ position, total }: Input): string {
    if (!Number.isInteger(total) || total < 1) {
        throw new RangeError(`A photo set needs a whole-number total of at least 1, not ${total}.`);
    }
    if (!Number.isInteger(position) || position < 1 || position > total) {
        throw new RangeError(`Photo position must be a whole number from 1 to ${total}, not ${position}.`);
    }
    return `${position} of ${total}`;
}

/**
 * The trimmed description, or undefined when there's none to use: no text,
 * text that isn't a string, or a draft that #14 marks reviewed: false.
 * Records can arrive as JSON, so this checks the fields the type promises.
 */
function description(alt: PhotoAlt | undefined): string | undefined {
    if (alt?.kind !== 'described') return undefined;
    const { text, reviewed } = alt as { text?: unknown; reviewed?: unknown };
    if (typeof text !== 'string' || (reviewed !== undefined && reviewed !== true)) return undefined;
    const trimmed = text.trim();
    return trimmed.replace(TRAILING, '') ? trimmed : undefined;
}

/**
 * The name of the control that opens a photograph. described: "<text>,
 * photograph N of T", without the text's trailing punctuation. decorative,
 * unreviewed, or no alt on a legacy surface: "Photograph N of T".
 */
export function photoEntryName(input: Input): string {
    const position = counter(input);
    const text = description(input.alt);
    return text ? `${text.replace(TRAILING, '')}, photograph ${position}` : `Photograph ${position}`;
}

/**
 * The image's own alt. described: "<text>". decorative: "". Unreviewed, or no
 * alt, which only legacy surfaces have: "Photograph N of T".
 */
export function photoImageAlt(input: Input): string {
    const position = counter(input);
    if (input.alt?.kind === 'decorative') return '';
    return description(input.alt) ?? `Photograph ${position}`;
}
