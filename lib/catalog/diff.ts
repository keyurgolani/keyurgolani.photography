import { createHash } from 'node:crypto';
import type { Registry } from '../identity/types';
import { canonicalJson } from '../storage/canonical';
import { fieldReview, type FieldRef, type FieldReviewState, type ReviewContext } from './review';
import type { AuthoredPhoto, AuthoredSeries, CandidateContent, CandidatePhotoRecord, IssueRecord, PublicPhotoRecord, RevisionFile, SeriesRecord, WorkingLayer } from './types';

/**
 * #16's diff engine: what a publish of the candidate would change for
 * visitors, against the revision the active pointer names (null before the
 * first activation). Pure: it reads nothing, writes nothing, and gives the
 * same changes in the same order for the same input. The working layer's
 * `baseRevisionId` is only a staleness input, since #13 rebases the working
 * layer onto every newly active revision.
 *
 * Every change has a stable ID, the record and field it is about, before and
 * after values, a category, whether visitors see it and where, its
 * provenance, and its review state with a stale flag.
 *
 * Categories:
 * - `authored`: title, statement, short statement, caption, description,
 *   cover, chapters, opening photo, accent, credit, location, an authored
 *   capture date, and Home's featured series.
 * - `derived`: dimensions, derivative sets and their checksums' URLs, LQIP,
 *   allowlisted EXIF, a capture date #10 read, counts and date ranges. One
 *   row per record, listing the fields.
 * - `asset`: new bytes for a photo that keeps its photo ID. Authored, since
 *   only #17's confirm changes the revision a record pins, so it is reviewed
 *   at confirm time; the Publish screen lists it with the derived group.
 * - `new` and `removed`: a series or a photograph arriving on or leaving the
 *   site. A photo leaving every published series is `removed`.
 * - `moved`: a photo in another position of its series, a photo in another
 *   series, or a new Work order. A move is never also an add and a remove.
 * - `visibility`: a published series made hidden or draft.
 * - `route`: a series' slug or aliases.
 * - `missing`: a published photo whose source is missing. Source health,
 *   not a change: #17 keeps the published asset, so visitors see nothing.
 */

export const CHANGE_CATEGORIES = ['authored', 'derived', 'asset', 'new', 'missing', 'moved', 'visibility', 'route', 'removed'] as const;
export type ChangeCategory = (typeof CHANGE_CATEGORIES)[number];
/** `generated`: a suggestion in an authored field nobody has reviewed. */
export type Provenance = 'authored' | 'generated' | 'derived';
export type Surface = 'home' | 'work' | 'series' | 'viewer';
/** `not-required` for derived rows and source health, and for any row of a diff between stored revisions, which were reviewed when published. */
export type ReviewState = 'reviewed' | 'unreviewed' | 'stale' | 'not-required';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface CatalogChange {
    /** The first 16 hex of the SHA-256 of the record kind, record ID, field, and category. */
    id: string;
    record: IssueRecord;
    /** '' for the record itself, `photoIds[<photoId>]` for a member, `derived` for a derived row, `source` for source health. */
    field: string;
    category: ChangeCategory;
    /** Null when absent. */
    before: Json;
    after: Json;
    /** A derived row's fields. */
    fields?: string[];
    /** The change that brought this one, as new bytes bring new derivatives. */
    causedBy?: string;
    visible: boolean;
    surfaces: Surface[];
    provenance: Provenance;
    review: { state: ReviewState; fields: FieldReviewState[] };
    /** True when a review this change relies on is stale. */
    stale: boolean;
    /** One line for the ledger. */
    summary: string;
}

export interface CatalogDiff {
    activeRevisionId: string | null;
    /** True when nothing visitors see would change. */
    empty: boolean;
    changes: CatalogChange[];
}

export const EMPTY_DIFF_MESSAGE = 'No visitor-visible changes. Edits to hidden or draft series stay saved and publish when the series becomes visible.';

export interface DiffInput {
    /** The active revision, or null before the first activation. */
    active: RevisionFile | null;
    candidate: CandidateContent;
    /** The working layer the candidate was compiled from. Null to compare stored revisions, whose rows need no review. */
    authored: WorkingLayer | null;
    /** #10's registry, for source health. */
    registry: Registry | null;
    /** The review bases and the inbox, from readReviewContext(). Without it, a review that settled an inbox item reads as stale. */
    review?: ReviewContext;
}

type PhotoLike = CandidatePhotoRecord | PublicPhotoRecord;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const canon = (value: unknown) => canonicalJson(value ?? null);
const same = (a: unknown, b: unknown) => canon(a) === canon(b);
const json = (value: unknown): Json => (value === undefined ? null : (JSON.parse(canon(value)) as Json));
const RECORD_ORDER: Record<IssueRecord['kind'], number> = { site: 0, series: 1, photo: 2 };

export function changeId(record: IssueRecord, field: string, category: ChangeCategory): string {
    return createHash('sha256').update(canonicalJson([record.kind, record.id, field, category])).digest('hex').slice(0, 16);
}

/** Photo fields compile copies from the photo record. The rest of a public photo record is derived, a capture date #10 read included. */
const AUTHORED_PHOTO_FIELDS = ['alt', 'title', 'caption', 'focalPoint', 'crop', 'accent', 'credit', 'location'] as const;
/** Series fields with their own rows. Any other field but `id`, `photoIds`, and `derived` is authored too, by its own name. */
const ROUTE_FIELDS = new Set(['slug', 'slugAliases']);
const SERIES_SURFACES: Record<string, Surface[]> = {
    slug: ['work', 'series'],
    slugAliases: ['series'],
    title: ['work', 'series'],
    shortStatement: ['work'],
    statement: ['series'],
    cover: ['work', 'series'],
    chapters: ['series'],
    openingPhotoId: ['series'],
    accent: ['series'],
};

interface Row {
    record: IssueRecord;
    field: string;
    category: ChangeCategory;
    before: unknown;
    after: unknown;
    fields?: string[];
    causedBy?: { record: IssueRecord; field: string; category: ChangeCategory };
    visible?: boolean;
    surfaces: Surface[];
    provenance: Provenance;
    /** The authored fields whose reviews the change relies on. */
    refs: FieldRef[];
    summary: string;
}

const site: IssueRecord = { kind: 'site', id: 'site' };
const seriesRef = (id: string): IssueRecord => ({ kind: 'series', id });
const photoRef = (id: string): IssueRecord => ({ kind: 'photo', id });
const ref = (record: IssueRecord, field: string): FieldRef => ({ record, field });

/**
 * The IDs in both lists that a reorder moved: those outside a longest run
 * kept in order, found as the longest increasing subsequence of the
 * candidate positions in active order. A photo inserted or removed elsewhere
 * moves nothing.
 */
export function movedIds(before: readonly string[], after: readonly string[]): Set<string> {
    const position = new Map(after.map((id, index) => [id, index]));
    const common = before.filter((id) => position.has(id));
    const keep = new Set(lis(common.map((id) => position.get(id) as number)).map((index) => common[index]));
    return new Set(common.filter((id) => !keep.has(id)));
}

/** The indices of one longest strictly increasing subsequence of `values`, in order. */
function lis(values: readonly number[]): number[] {
    const tails: number[] = [];
    const previous: number[] = new Array(values.length).fill(-1);
    for (let index = 0; index < values.length; index++) {
        let low = 0;
        let high = tails.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (values[tails[middle]] < values[index]) low = middle + 1;
            else high = middle;
        }
        if (low > 0) previous[index] = tails[low - 1];
        tails[low] = index;
    }
    const out: number[] = [];
    for (let index = tails.length ? tails[tails.length - 1] : -1; index !== -1; index = previous[index]) out.push(index);
    return out.reverse();
}

/** Where each photo sits: the first series that lists it, and its 1-based position there. */
function placements(series: readonly SeriesRecord[]): Map<string, { seriesId: string; position: number }> {
    const out = new Map<string, { seriesId: string; position: number }>();
    for (const entry of series) {
        entry.photoIds.forEach((photoId, index) => {
            if (!out.has(photoId)) out.set(photoId, { seriesId: entry.id, position: index + 1 });
        });
    }
    return out;
}

const present = (record: object, field: string) => (record as Record<string, unknown>)[field] !== undefined;

export function diffCatalog(input: DiffInput): CatalogDiff {
    const { active, candidate, authored, registry } = input;
    const before = active?.content ?? { site: { featuredSeriesIds: [] }, series: [], photos: [] };
    const rows: Row[] = [];
    const authoredSeries = new Map((authored?.series ?? []).map((series) => [series.id, series]));
    const authoredPhotos = new Map((authored?.photos ?? []).map((photo) => [photo.id, photo]));
    const featured = new Set([...before.site.featuredSeriesIds, ...candidate.site.featuredSeriesIds]);
    const withHome = (seriesId: string, surfaces: Surface[]): Surface[] => (featured.has(seriesId) && (surfaces.includes('work') || surfaces.includes('series')) ? ['home', ...surfaces] : surfaces);

    // The site: Home's featured series and the Work order.
    if (!same(before.site.featuredSeriesIds, candidate.site.featuredSeriesIds)) {
        rows.push({
            record: site, field: 'featuredSeriesIds', category: 'authored', before: before.site.featuredSeriesIds, after: candidate.site.featuredSeriesIds,
            surfaces: ['home'], provenance: 'authored', refs: [ref(site, 'featuredSeriesIds')], summary: 'Home features other series.',
        });
    }
    const activeIds = before.series.map((series) => series.id);
    const candidateIds = candidate.series.map((series) => series.id);
    const kept = activeIds.filter((id) => candidateIds.includes(id));
    const keptAfter = candidateIds.filter((id) => activeIds.includes(id));
    if (!same(kept, keptAfter)) {
        rows.push({
            record: site, field: 'seriesOrder', category: 'moved', before: kept, after: keptAfter,
            surfaces: ['work'], provenance: 'authored', refs: [ref(site, 'seriesOrder')], summary: 'The Work order changes.',
        });
    }

    // Series.
    const activeSeries = new Map(before.series.map((series) => [series.id, series]));
    const candidateSeries = new Map(candidate.series.map((series) => [series.id, series]));
    for (const id of [...new Set([...activeSeries.keys(), ...candidateSeries.keys()])].sort(compare)) {
        const was = activeSeries.get(id);
        const now = candidateSeries.get(id);
        const record = seriesRef(id);
        const working = authoredSeries.get(id);
        if (!was && now) {
            const fields = working ? Object.keys(now).filter((field) => !['id', 'derived'].includes(field) && present(working, field)) : [];
            rows.push({
                record, field: '', category: 'new', before: null, after: { slug: now.slug, title: now.title, photoCount: now.derived.photoCount },
                surfaces: withHome(id, ['work', 'series']), provenance: 'authored',
                refs: [ref(site, 'seriesOrder'), ref(record, 'visibility'), ...fields.map((field) => ref(record, field))],
                summary: `${now.title || id} is published, with ${now.derived.photoCount} ${now.derived.photoCount === 1 ? 'photograph' : 'photographs'}.`,
            });
            continue;
        }
        if (was && !now) {
            const hidden = working !== undefined && working.visibility !== 'published';
            rows.push({
                record, field: hidden ? 'visibility' : '', category: hidden ? 'visibility' : 'removed',
                before: hidden ? 'published' : { slug: was.slug, title: was.title }, after: hidden ? (working as AuthoredSeries).visibility : null,
                surfaces: withHome(id, ['work', 'series']), provenance: 'authored', refs: seriesRemoval(id, working),
                summary: hidden ? `${was.title || id} is ${(working as AuthoredSeries).visibility}, so it leaves the site.` : `${was.title || id} leaves the site.`,
            });
            continue;
        }
        if (!was || !now) continue;
        for (const field of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort(compare)) {
            if (field === 'id' || field === 'photoIds' || field === 'derived') continue;
            const a = (was as Record<string, unknown>)[field];
            const b = (now as Record<string, unknown>)[field];
            if (same(a, b)) continue;
            rows.push({
                record, field, category: ROUTE_FIELDS.has(field) ? 'route' : 'authored', before: a, after: b,
                surfaces: withHome(id, SERIES_SURFACES[field] ?? ['series']), provenance: 'authored', refs: [ref(record, field)],
                summary: `${now.title || id}: ${field} changes.`,
            });
        }
        const derived = [...new Set([...Object.keys(was.derived), ...Object.keys(now.derived)])].sort(compare)
            .filter((field) => !same((was.derived as Record<string, unknown>)[field], (now.derived as Record<string, unknown>)[field]));
        if (derived.length > 0) {
            rows.push({
                record, field: 'derived', category: 'derived', fields: derived,
                before: Object.fromEntries(derived.map((field) => [field, (was.derived as Record<string, unknown>)[field] ?? null])),
                after: Object.fromEntries(derived.map((field) => [field, (now.derived as Record<string, unknown>)[field] ?? null])),
                surfaces: withHome(id, ['work', 'series']), provenance: 'derived', refs: [], summary: `${now.title || id}: its counts or dates are recalculated.`,
            });
        }
        const moved = movedIds(was.photoIds, now.photoIds);
        for (const photoId of [...moved].sort(compare)) {
            rows.push({
                record, field: `photoIds[${photoId}]`, category: 'moved',
                before: { position: was.photoIds.indexOf(photoId) + 1 }, after: { position: now.photoIds.indexOf(photoId) + 1 },
                surfaces: ['series', 'viewer'], provenance: 'authored', refs: [ref(record, 'photoIds')],
                summary: `${photoId} moves from position ${was.photoIds.indexOf(photoId) + 1} to ${now.photoIds.indexOf(photoId) + 1} in ${now.title || id}.`,
            });
        }
    }

    /** The authored fields behind a series leaving the site. */
    function seriesRemoval(id: string, working: AuthoredSeries | undefined): FieldRef[] {
        const record = seriesRef(id);
        if (!working) return [ref(record, '')];
        if (working.visibility !== 'published') return [ref(record, 'visibility')];
        if (!(authored?.site?.seriesOrder ?? []).includes(id)) return [ref(site, 'seriesOrder')];
        if (working.cover === null) return [ref(record, 'cover')];
        return [ref(record, 'photoIds')];
    }

    // Photos.
    const wasAt = placements(before.series);
    const nowAt = placements(candidate.series);
    const activePhotos = new Map<string, PhotoLike>(before.photos.map((photo) => [photo.id, photo]));
    const candidatePhotos = new Map<string, PhotoLike>(candidate.photos.map((photo) => [photo.id, photo]));
    for (const id of [...new Set([...activePhotos.keys(), ...candidatePhotos.keys()])].sort(compare)) {
        const was = activePhotos.get(id);
        const now = candidatePhotos.get(id);
        const record = photoRef(id);
        const working = authoredPhotos.get(id);
        const from = wasAt.get(id);
        const to = nowAt.get(id);
        if (!was && now) {
            const fields = working ? ['assetRevision', ...AUTHORED_PHOTO_FIELDS, 'capturedAt'].filter((field) => present(working, field)) : [];
            rows.push({
                record, field: '', category: 'new', before: null, after: to ? { seriesId: to.seriesId, position: to.position } : null,
                surfaces: ['series', 'viewer'], provenance: generated(working) ? 'generated' : 'authored',
                refs: [...(to ? [ref(seriesRef(to.seriesId), 'photoIds')] : []), ...(working ? fields.map((field) => ref(record, field)) : [ref(record, '')])],
                summary: to ? `${id} is added to ${to.seriesId} at position ${to.position}.` : `${id} is added.`,
            });
        } else if (was && !now) {
            const series = before.series.filter((entry) => entry.photoIds.includes(id)).map((entry) => entry.id);
            rows.push({
                record, field: '', category: 'removed', before: from ? { seriesId: from.seriesId, position: from.position } : null, after: null,
                surfaces: ['series', 'viewer'], provenance: 'authored',
                refs: series.flatMap((seriesId) => (candidateSeries.has(seriesId) ? [ref(seriesRef(seriesId), 'photoIds')] : seriesRemoval(seriesId, authoredSeries.get(seriesId)))),
                summary: `${id} leaves the site${from ? `, from ${from.seriesId}` : ''}.`,
            });
        } else if (was && now) {
            photoRows(id, was, now, working, from, to);
        }
        // Source health: the published image stays, so visitors see nothing.
        const health = registry?.photos[id]?.sourceHealth;
        if (now && health === 'missing') {
            rows.push({
                record, field: 'source', category: 'missing', before: null, after: null, visible: false,
                surfaces: [], provenance: 'derived', refs: [], summary: 'Source missing; last published image kept.',
            });
        }
    }

    function photoRows(id: string, was: PhotoLike, now: PhotoLike, working: AuthoredPhoto | undefined, from?: { seriesId: string; position: number }, to?: { seriesId: string; position: number }): void {
        const record = photoRef(id);
        if (from && to && from.seriesId !== to.seriesId) {
            rows.push({
                record, field: 'series', category: 'moved', before: from, after: to, surfaces: ['series', 'viewer'], provenance: 'authored',
                refs: [ref(seriesRef(to.seriesId), 'photoIds'), ...(authoredSeries.has(from.seriesId) ? [ref(seriesRef(from.seriesId), 'photoIds')] : [])],
                summary: `${id} moves from ${from.seriesId} to ${to.seriesId}.`,
            });
        }
        const asset = was.assetRevision !== now.assetRevision;
        if (asset) {
            rows.push({
                record, field: 'assetRevision', category: 'asset', before: was.assetRevision, after: now.assetRevision,
                surfaces: ['series', 'viewer'], provenance: 'authored', refs: [ref(record, 'assetRevision')],
                summary: `${id} gets new bytes, ${now.assetRevision}, in place of ${was.assetRevision}.`,
            });
        }
        // A capture date is authored while the record overrides it, and so is dropping an override: the record has a
        // stamp for it, or the active revision published a date #10 didn't read.
        const registryDate = registry?.photos[id]?.revisions[was.assetRevision]?.derived.capturedDate?.value;
        const overridden = was.capturedAt !== undefined && registryDate !== undefined && was.capturedAt !== registryDate;
        const capturedAuthored = working?.capturedAt !== undefined || working?.review?.fields.capturedAt !== undefined || overridden;
        const authoredFields: string[] = [...AUTHORED_PHOTO_FIELDS, ...(capturedAuthored ? ['capturedAt'] : [])];
        for (const field of authoredFields) {
            const a = (was as Record<string, unknown>)[field];
            const b = (now as Record<string, unknown>)[field];
            if (same(a, b)) continue;
            rows.push({
                record, field, category: 'authored', before: a, after: b, surfaces: ['viewer'],
                provenance: field === 'alt' && generated(working) ? 'generated' : 'authored', refs: [ref(record, field)],
                summary: field === 'alt' ? altSummary(id, a, b) : `${id}: ${field} changes.`,
            });
        }
        const skip = new Set(['id', 'assetRevision', ...authoredFields]);
        const derived = [...new Set([...Object.keys(was), ...Object.keys(now)])].sort(compare)
            .filter((field) => !skip.has(field) && !same((was as Record<string, unknown>)[field], (now as Record<string, unknown>)[field]));
        if (derived.length > 0) {
            rows.push({
                record, field: 'derived', category: 'derived', fields: derived,
                before: Object.fromEntries(derived.map((field) => [field, (was as Record<string, unknown>)[field] ?? null])),
                after: Object.fromEntries(derived.map((field) => [field, (now as Record<string, unknown>)[field] ?? null])),
                ...(asset ? { causedBy: { record, field: 'assetRevision', category: 'asset' as const } } : {}),
                surfaces: ['series', 'viewer'], provenance: 'derived', refs: [],
                summary: asset ? `${id}: its derivatives and facts come from the new bytes.` : `${id}: ${derived.join(', ')} recalculated.`,
            });
        }
    }

    const env = authored ? { layer: authored, active: active ? { revisionId: active.revisionId, content: active.content } : null, review: input.review } : null;
    const changes = rows.map((row): CatalogChange => {
        const visible = row.visible ?? true;
        const reviews = env && row.provenance !== 'derived' ? row.refs.map((entry) => fieldReview(entry, env)) : [];
        const state: ReviewState = !env || row.provenance === 'derived'
            ? 'not-required'
            : reviews.some((entry) => entry.state === 'stale') ? 'stale' : reviews.some((entry) => entry.state === 'unreviewed') ? 'unreviewed' : 'reviewed';
        return {
            id: changeId(row.record, row.field, row.category),
            record: row.record,
            field: row.field,
            category: row.category,
            before: json(row.before),
            after: json(row.after),
            ...(row.fields ? { fields: row.fields } : {}),
            ...(row.causedBy ? { causedBy: changeId(row.causedBy.record, row.causedBy.field, row.causedBy.category) } : {}),
            visible,
            surfaces: row.surfaces,
            provenance: row.provenance,
            review: { state, fields: reviews },
            stale: state === 'stale',
            summary: row.summary,
        };
    });
    changes.sort((a, b) => RECORD_ORDER[a.record.kind] - RECORD_ORDER[b.record.kind] || compare(a.record.id, b.record.id) || compare(a.field, b.field) || compare(a.category, b.category));
    return { activeRevisionId: active?.revisionId ?? null, empty: !changes.some((change) => change.visible), changes };
}

/** A photo whose described alt is a suggestion nobody has reviewed. */
function generated(photo: AuthoredPhoto | undefined): boolean {
    return photo?.alt?.kind === 'described' && !photo.alt.reviewed;
}

function altSummary(id: string, before: unknown, after: unknown): string {
    const kind = (value: unknown) => (value as { kind?: string } | undefined)?.kind;
    if (kind(before) !== kind(after) && (kind(before) === 'decorative' || kind(after) === 'decorative')) {
        return kind(after) === 'decorative' ? `${id}'s description becomes decorative.` : `${id}'s decorative photograph gets a description.`;
    }
    return `${id}'s description changes.`;
}
