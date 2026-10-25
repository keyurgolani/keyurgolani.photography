/**
 * Owner text the curation commands store: a description or a reason. It is
 * plain text: trimmed, with no control characters and no markup, and it
 * must say something.
 *
 * TODO(restack): 13D (`feat/13d-owner-authoring`) adds the plain-text rules
 * for owner-authored copy. It is stacked on 13C and isn't reachable from this
 * base, so this is a local stand-in. Once 13D lands, use its helper here and
 * drop this one.
 */

export const MAX_DESCRIPTION_LENGTH = 1_000;
export const MAX_REASON_LENGTH = 500;

// C0 and C1 controls, the bidi marks and overrides that can disguise text, the line and paragraph
// separators, and zero-width characters. Plain spaces only.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/u;
const MARKUP = /<[^>]*>/u;

export type TextCheck = { ok: true; text: string } | { ok: false; problem: string };

export function ownerText(value: string, { field, max }: { field: string; max: number }): TextCheck {
    const text = value.normalize('NFC').trim();
    if (text.length === 0) return { ok: false, problem: `${field} needs some text.` };
    if (CONTROL.test(text)) return { ok: false, problem: `${field} can't hold control characters, line breaks, or invisible characters.` };
    if (MARKUP.test(text)) return { ok: false, problem: `${field} is plain text, so it can't hold markup.` };
    if (text.length > max) return { ok: false, problem: `${field} is ${text.length} characters, and the most is ${max}.` };
    return { ok: true, text };
}
