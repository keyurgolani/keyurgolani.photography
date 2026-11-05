import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { SERIES_ID_RE } from '../catalog/schema';
import { isLibraryPath } from '../identity/decisions';
import { canonicalJson } from '../storage/canonical';
import type { Placement, Suggestions } from './events';

/**
 * Suggestions for a new photograph, from the owner's `curation/rules.json`
 * (CURATION_MODEL.md, "Assignment rules"): a configured folder or a filename
 * tag may suggest a series, and the EXIF capture date may narrow it. The
 * insertion point (#14, A8) is among the series' dated photographs by capture
 * date, at `medium`; an undated photograph, or a series with no dated
 * photograph, goes at the end at `low`. Everything here is
 * pure and local: it reads nothing but its arguments and makes no network
 * request. No description is suggested.
 *
 *   { "schemaVersion": 1, "series": [
 *     { "seriesId": "ser_x", "folders": ["trips/2024"], "filenameTags": ["harbor"],
 *       "capturedBetween": { "from": "2024-01-01", "to": "2024-12-31" } } ] }
 */

export const RULES_SCHEMA_VERSION = 1;
/** The most series rules.json may configure, and the most folders or tags one may list. */
export const MAX_RULE_SERIES = 500;
export const MAX_RULE_ENTRIES = 100;

const tag = z.string().regex(/^[\p{L}\p{N}]+$/u, 'must be letters and digits only');
const folder = z.string().refine(isLibraryPath, 'must be a library-relative folder');

export const rulesSchema = z.strictObject({
    schemaVersion: z.literal(RULES_SCHEMA_VERSION),
    series: z.array(z.strictObject({
        seriesId: z.string().regex(SERIES_ID_RE, 'must be a series ID'),
        folders: z.array(folder).max(MAX_RULE_ENTRIES).default([]),
        filenameTags: z.array(tag).max(MAX_RULE_ENTRIES).default([]),
        capturedBetween: z.strictObject({ from: z.iso.date().optional(), to: z.iso.date().optional() }).optional(),
    })).max(MAX_RULE_SERIES),
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
    /** Each series' photographs in authored order, with the capture date #10 read for each, or null (#14, A8). */
    seriesMembers?: ReadonlyMap<string, readonly SeriesMember[]>;
    /** The photograph being placed, left out of its series' members (A8 review N8). */
    photoId?: string | null;
    producedAt: string;
}

export interface SeriesMember {
    photoId: string;
    /** `YYYY-MM-DD`, or null when the photograph holds none. */
    capturedDate: string | null;
}

/** Who makes insertion suggestions. 2 is A8's capture-date rule; 1 was always the end. */
export const PLACEMENT_PRODUCER = 'placement@2';

/**
 * #14 (A8): where a new photograph goes in a series, by capture date. A dated photograph goes after the last member
 * captured on or before it, in authored order, at `medium`: undated members are passed over, never compared. One
 * captured before every dated member goes just before the first of them, which is the start when that member leads.
 * One after them all goes at the end when the last dated member is last. An undated photograph, or a series with no
 * dated member, goes at the end at `low`. Evidence names dates, never files.
 *
 * Dates are #10's `YYYY-MM-DD` capture dates, the camera's own wall-clock day with no zone (A8 review N9), compared as
 * text. So two photographs of the same day are a tie, whatever the hour or the zone, and a tie goes after the one
 * already there. `photoId`, the photograph being placed, is left out of `members` when the series already lists it
 * (N8), so it never goes after itself.
 */
export function placementFor(capturedDate: string | null, all: readonly SeriesMember[], seriesName: string, producedAt: string, photoId: string | null = null): NonNullable<Suggestions['placement']> {
    const members = photoId === null ? all : all.filter((member) => member.photoId !== photoId);
    const dated = members.map((member, index) => ({ ...member, index })).filter((member): member is SeriesMember & { index: number; capturedDate: string } => member.capturedDate !== null);
    const atEnd = (why: string): NonNullable<Suggestions['placement']> => ({
        producedBy: PLACEMENT_PRODUCER,
        producedAt,
        confidence: 'low',
        value: 'end',
        evidence: [`${why} Places it after the last photograph of ${seriesName}. Choose another position before approving if it belongs elsewhere.`],
    });
    if (capturedDate === null) return atEnd('The photograph has no capture date, so nothing dates its place.');
    if (dated.length === 0) return atEnd(`No photograph in ${seriesName} has a capture date to place it among.`);
    const before = dated.filter((member) => member.capturedDate <= capturedDate).at(-1);
    const medium = (value: Placement, why: string): NonNullable<Suggestions['placement']> => ({
        producedBy: PLACEMENT_PRODUCER,
        producedAt,
        confidence: 'medium',
        value,
        evidence: [`It was captured ${capturedDate}. ${why} Choose another position before approving if it belongs elsewhere.`],
    });
    if (before === undefined) {
        const first = dated[0];
        const value: Placement = first.index === 0 ? 'start' : { after: members[first.index - 1].photoId };
        return medium(value, `The earliest dated photograph in ${seriesName} was captured ${first.capturedDate}, so it goes just before that one.`);
    }
    const value: Placement = before.index === members.length - 1 ? 'end' : { after: before.photoId };
    const next = dated.find((member) => member.index > before.index);
    const between = next ? ` and before the next dated one, captured ${next.capturedDate}` : '';
    return medium(value, `It goes after the photograph in ${seriesName} captured ${before.capturedDate}${between}.`);
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
        placement: placementFor(input.capturedDate, input.seriesMembers?.get(chosen.seriesId) ?? [], describe(chosen.seriesId), producedAt, input.photoId ?? null),
    };
}
