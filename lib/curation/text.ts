import { codePointName, FIELD_LIMITS, plainText } from '../catalog/plain-text';

/**
 * Owner text the curation commands store: a description or a reason. It
 * follows #13's plain-text rules for owner copy (lib/catalog/plain-text.ts):
 * trimmed, NFC, one line, and none of the characters a reader can't see. On
 * top of those, the inbox keeps its own limits: the text must say something,
 * it holds no markup, and a reason is at most MAX_REASON_LENGTH characters.
 * A description takes `alt`'s limit, since approval stores it as the alt.
 */

export const MAX_DESCRIPTION_LENGTH = FIELD_LIMITS.alt;
export const MAX_REASON_LENGTH = 500;

const MARKUP = /<[^>]*>/u;

export type TextCheck = { ok: true; text: string } | { ok: false; problem: string };

export function ownerText(value: string, { field, max }: { field: string; max: number }): TextCheck {
    const checked = plainText(value, { limit: max });
    if (!checked.ok) {
        const { problem } = checked;
        if (problem.kind === 'line-break') return { ok: false, problem: `${field} can't hold a line break.` };
        if (problem.kind === 'length') return { ok: false, problem: `${field} is ${problem.length} characters, and the most is ${problem.limit}.` };
        return { ok: false, problem: `${field} can't hold ${problem.why} (${codePointName(problem.codePoint)} at character ${problem.index}).` };
    }
    const { text } = checked;
    if (text.length === 0) return { ok: false, problem: `${field} needs some text.` };
    if (MARKUP.test(text)) return { ok: false, problem: `${field} is plain text, so it can't hold markup.` };
    return { ok: true, text };
}
