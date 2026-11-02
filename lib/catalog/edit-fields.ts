// The record's editable fields and the cleaning of its public text, shared by `photos edit` (edit-record.ts) and the
// curator's Series screen (#150). Pure, with no file system or process: edit-record.ts also opens an editor, and a
// server module that imported it would trace the whole project into the standalone build.
import { codePointName, FIELD_LIMITS, plainText } from './plain-text';
import type { AuthoredKind } from './schema';
import { MANAGED_FIELDS } from './working-layer-writer';

// `photos carry-over`'s marker is the tools' too: the writer keeps it, and refuses one added by hand.
const HIDDEN = new Set<string>([...MANAGED_FIELDS, 'stamp', 'carryOver']);

/** What the owner edits: the record without its managed fields and stamp. The curator's Series screen edits the same (#150). */
export function editable(record: object): Record<string, unknown> {
    return Object.fromEntries(Object.entries(record).filter(([key]) => !HIDDEN.has(key)));
}

/** A slug for a new series' ID: its words, joined by single hyphens. */
export function slugFor(id: string): string {
    return id.slice('ser_'.length).replace(/[_-]+/g, '-').replace(/^-|-$/g, '');
}

/** The text a new series opens with: a draft with every field the owner fills in. The curator's New series starts from it too (#150). */
export function newSeries(id: string): Record<string, unknown> {
    return { kind: 'series', id, slug: slugFor(id), title: '', statement: '', shortStatement: '', photoIds: [], chapters: [], cover: null, visibility: 'draft' };
}

type TextRule = { limit: number; lineBreaks?: boolean };

/** The public text fields an edit can set, by kind, and their rules. */
const TEXT_FIELDS: Record<AuthoredKind, Record<string, TextRule>> = {
    site: {},
    series: { title: { limit: FIELD_LIMITS.title }, statement: { limit: FIELD_LIMITS.statement, lineBreaks: true }, shortStatement: { limit: FIELD_LIMITS.shortStatement } },
    photo: { title: { limit: FIELD_LIMITS.title }, caption: { limit: FIELD_LIMITS.caption, lineBreaks: true }, credit: { limit: FIELD_LIMITS.title }, location: { limit: FIELD_LIMITS.title } },
};

/**
 * Run the edit's public text through plainText(), storing what it returns.
 * Non-string values are left for the schema. Returns the problems, field by
 * field, or none, each starting with the field's name. The curator's Series
 * screen cleans its text with it too, so both store the same text (#150).
 */
export function checkText(record: Record<string, unknown>, kind: AuthoredKind): string[] {
    const problems: string[] = [];
    const check = (value: unknown, field: string, rule: TextRule, store: (text: string) => void) => {
        if (typeof value !== 'string') return;
        const checked = plainText(value, rule);
        if (checked.ok) return store(checked.text);
        const { problem } = checked;
        if (problem.kind === 'character') problems.push(`${field} has ${codePointName(problem.codePoint)}, ${problem.why}, at character ${problem.index}.`);
        else if (problem.kind === 'line-break') problems.push(`${field} has a line break, which it can't hold.`);
        else problems.push(`${field} is ${problem.length} characters long, over its limit of ${problem.limit}.`);
    };
    for (const [field, rule] of Object.entries(TEXT_FIELDS[kind])) check(record[field], field, rule, (value) => { record[field] = value; });
    if (kind === 'photo' && typeof record.alt === 'object' && record.alt !== null && (record.alt as { kind?: unknown }).kind === 'described') {
        const alt = record.alt as { text?: unknown };
        check(alt.text, 'alt.text', { limit: FIELD_LIMITS.alt }, (value) => { alt.text = value; });
    }
    if (kind === 'series' && Array.isArray(record.chapters)) {
        record.chapters.forEach((chapter: unknown, index) => {
            if (typeof chapter !== 'object' || chapter === null) return;
            const entry = chapter as { title?: unknown };
            check(entry.title, `chapters[${index}].title`, { limit: FIELD_LIMITS.title }, (value) => { entry.title = value; });
        });
    }
    return problems;
}
