import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { SERIES_ID_RE } from '../catalog/schema';
import { isLibraryPath } from '../identity/decisions';
import { canonicalJson } from '../storage/canonical';
import type { Suggestions } from './events';

/**
 * Suggestions for a new photograph, from the owner's `curation/rules.json`
 * (CURATION_MODEL.md, "Assignment rules"): a configured folder or a filename
 * tag may suggest a series, and the EXIF capture date may narrow it. The
 * insertion point is the end of the suggested series. Everything here is
 * pure and local: it reads nothing but its arguments and makes no network
 * request. No description is suggested.
 *
 *   { "schemaVersion": 1, "series": [
 *     { "seriesId": "ser_x", "folders": ["trips/2024"], "filenameTags": ["harbor"],
 *       "capturedBetween": { "from": "2024-01-01", "to": "2024-12-31" } } ] }
 */

export const RULES_SCHEMA_VERSION = 1;

const tag = z.string().regex(/^[\p{L}\p{N}]+$/u, 'must be letters and digits only');
const folder = z.string().refine(isLibraryPath, 'must be a library-relative folder');

export const rulesSchema = z.strictObject({
    schemaVersion: z.literal(RULES_SCHEMA_VERSION),
    series: z.array(z.strictObject({
        seriesId: z.string().regex(SERIES_ID_RE, 'must be a series ID'),
        folders: z.array(folder).default([]),
        filenameTags: z.array(tag).default([]),
        capturedBetween: z.strictObject({ from: z.iso.date().optional(), to: z.iso.date().optional() }).optional(),
    })),
});
export type CurationRules = z.infer<typeof rulesSchema>;

export type LoadedRules =
    | { state: 'none' }
    | { state: 'valid'; rules: CurationRules; producedBy: string }
    | { state: 'invalid'; reason: string };

/** Check what `curation/rules.json` held: null when there is none. */
export function loadRules(value: unknown | null): LoadedRules {
    if (value === null) return { state: 'none' };
    const parsed = rulesSchema.safeParse(value);
    if (!parsed.success) {
        const [issue] = parsed.error.issues;
        return { state: 'invalid', reason: `${issue.path.join('.') || '(file)'}: ${issue.message}` };
    }
    const digest = createHash('sha256').update(canonicalJson(parsed.data)).digest('hex').slice(0, 12);
    return { state: 'valid', rules: parsed.data, producedBy: `rules@${digest}` };
}

/** A path's key for matching, as #10 keys paths: NFC and case-folded. */
const keyOf = (value: string) => value.normalize('NFC').toLowerCase();

/** The filename stem's tokens, split on `-`, `_`, `.`, and spaces, case-folded. */
export function filenameTokens(sourcePath: string): string[] {
    const stem = path.posix.basename(sourcePath).replace(/\.[^.]*$/, '');
    return keyOf(stem).split(/[-_.\s]+/u).filter((token) => token.length > 0);
}

function inFolder(sourceFolder: string, configured: string): boolean {
    const source = keyOf(sourceFolder);
    const target = keyOf(configured);
    return source === target || source.startsWith(`${target}/`);
}

function dateFits(date: string, range: { from?: string; to?: string } | undefined): boolean {
    if (!range) return true;
    return (range.from === undefined || date >= range.from) && (range.to === undefined || date <= range.to);
}

export interface SuggestInput {
    rules: LoadedRules;
    /** The source's library-relative path and folder. */
    sourcePath: string;
    folder: string;
    /** The EXIF capture date, `YYYY-MM-DD`, or null. */
    capturedDate: string | null;
    /** The series the working layer holds, by ID. A rule naming another is skipped. */
    knownSeries: ReadonlySet<string>;
    /** Their titles, for the evidence. */
    seriesTitles?: ReadonlyMap<string, string>;
    producedAt: string;
}

/** The series and placement suggestions for a new photograph. Pure: no I/O and no network. */
export function suggestForNew(input: SuggestInput): Suggestions {
    const { rules, producedAt } = input;
    const unassigned = (producedBy: string, evidence: string[]): Suggestions => ({
        series: { producedBy, producedAt, confidence: 'low', value: null, evidence },
        placement: null,
    });
    if (rules.state === 'none') return unassigned('rules@none', ['There is no curation/rules.json, so no series is suggested.']);
    if (rules.state === 'invalid') return unassigned('rules@invalid', [`curation/rules.json is not valid (${rules.reason}), so no series is suggested.`]);

    const { producedBy } = rules;
    const evidence: string[] = [];
    const usable = rules.rules.series.filter((rule) => {
        if (input.knownSeries.has(rule.seriesId)) return true;
        evidence.push(`curation/rules.json names ${rule.seriesId}, which has no authored record, so it is skipped.`);
        return false;
    });
    const tokens = new Set(filenameTokens(input.sourcePath));
    const byFolder = usable.filter((rule) => rule.folders.some((configured) => inFolder(input.folder, configured)));
    const byTag = usable.filter((rule) => rule.filenameTags.some((configured) => tokens.has(keyOf(configured))));
    const matched = byFolder.length > 0 ? byFolder : byTag;
    const how = byFolder.length > 0 ? 'folder' : 'tag';
    const describe = (seriesId: string) => {
        const title = input.seriesTitles?.get(seriesId);
        return title ? `${seriesId} (${title})` : seriesId;
    };
    for (const rule of matched) {
        evidence.push(how === 'folder'
            ? `The folder ${input.folder || '(library root)'} is configured for ${describe(rule.seriesId)}.`
            : `The filename has a tag configured for ${describe(rule.seriesId)}.`);
    }
    if (matched.length === 0) return unassigned(producedBy, [...evidence, 'No configured folder or filename tag matches, so leave it unassigned or choose a series.']);

    let narrowed = matched;
    if (input.capturedDate !== null) {
        narrowed = matched.filter((rule) => dateFits(input.capturedDate as string, rule.capturedBetween));
        if (narrowed.length < matched.length) evidence.push(`The EXIF capture date ${input.capturedDate} narrows it to ${narrowed.map((rule) => rule.seriesId).join(', ') || 'none of them'}.`);
    }
    if (narrowed.length !== 1) {
        const which = narrowed.length === 0 ? 'none of them fits' : `${narrowed.map((rule) => rule.seriesId).join(' and ')} all match`;
        return unassigned(producedBy, [...evidence, `${which}, so no series is suggested.`]);
    }
    const [chosen] = narrowed;
    return {
        series: { producedBy, producedAt, confidence: how === 'folder' ? 'high' : 'medium', value: chosen.seriesId, evidence },
        placement: {
            producedBy: 'placement@1',
            producedAt,
            confidence: 'low',
            value: 'end',
            evidence: [`Places it after the last photograph of ${describe(chosen.seriesId)}. Choose another position before approving if it belongs elsewhere.`],
        },
    };
}
