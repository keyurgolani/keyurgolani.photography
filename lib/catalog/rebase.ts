import path from 'node:path';
import { canonicalJson } from '../identity/ids';
import { readRegistry } from '../identity/registry';
import type { Registry } from '../identity/types';
import { withLock, type LockContext } from '../storage/lock';
import { candidateAlt } from './compile';
import { rebaseSeriesOrder } from './order';
import { assertRevisionId, readRevisionFile } from './repository';
import type { AuthoredPhoto, AuthoredSeries, AuthoredSite, Conflict, PublicPhotoRecord, RevisionFile, SeriesRecord, WorkingLayer } from './types';
import { AUTHORED_LEASE_MS, AUTHORED_LOCK, AUTHORED_WAIT_MS, writeRebasedRecord } from './working-layer-writer';
import { readWorkingLayer } from './working-layer';

/**
 * rebaseWorkingLayer(): move every authored record onto a newly active
 * revision. For each record on another base, every field compile publishes,
 * and a series' published state, is merged three ways: the record's base,
 * the target, and the record as it is now. A field the curator left alone
 * takes the target's value, a curator change stays, and a field both sides
 * changed, differently, keeps the curator's value and gets a `conflicts`
 * entry, which blocks publish until someone settles it. #8's
 * rebaseSeriesOrder() merges the Work order.
 *
 * Fields compare as compile publishes them: blank optional text counts as
 * absent, and a photo's capture date as its authored override or else #10's
 * date. A record the base or the target doesn't publish has nothing to
 * compare there, so its fields stay as they are.
 */

export interface RebaseOptions {
    root: string;
    targetRevisionId: string;
    /**
     * The working layer the target was compiled from: publish's step 2
     * snapshot. Records in it merge against it instead of their own base
     * revision, so edits made while the publish ran stay.
     */
    snapshot?: WorkingLayer;
    /** A live authored hold to reuse. Without one, the rebase takes the lock and waits up to `waitMs`. */
    lock?: LockContext;
    waitMs?: number;
    /** #10's registry, for capture dates. Read from the data root when absent. */
    registry?: Registry | null;
}

export interface RebaseReport {
    /** Records written onto the target. */
    rebased: number;
    /** The conflicts this rebase added, by record and field. */
    conflicts: { kind: 'site' | 'series' | 'photo'; id: string; field: string }[];
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

type Merge<T> = { value: T; conflict: Conflict | null; changed: boolean };

/** Three-way merge of one field: the curator's value `mine`, the base's, and the target's. */
function threeWay<T>(field: string, mine: T, base: T, target: T): Merge<T> {
    if (same(mine, target)) return { value: mine, conflict: null, changed: false };
    if (same(mine, base)) return { value: target, conflict: null, changed: true };
    if (same(target, base)) return { value: mine, conflict: null, changed: false };
    return { value: mine, conflict: { field, base: (base ?? null) as Conflict['base'], active: (target ?? null) as Conflict['active'] }, changed: false };
}

const presentText = (value: string | undefined) => (value !== undefined && /\S/.test(value) ? value : undefined);

/** A record's conflicts with `added` replacing any older entry for the same field. */
function withConflicts(existing: readonly Conflict[] | undefined, added: readonly Conflict[]): Conflict[] | undefined {
    if (added.length === 0) return existing ? [...existing] : undefined;
    const fields = new Set(added.map((conflict) => conflict.field));
    return [...(existing ?? []).filter((conflict) => !fields.has(conflict.field)), ...added];
}

// Photos.

const PHOTO_TEXT = ['title', 'caption', 'credit', 'location'] as const;
const PHOTO_PLAIN = ['focalPoint', 'crop', 'accent'] as const;

interface PhotoView {
    assetRevision: string;
    alt: unknown;
    title?: string;
    caption?: string;
    credit?: string;
    location?: string;
    focalPoint?: unknown;
    crop?: unknown;
    accent?: string;
    capturedAt?: string;
}

function registryDate(registry: Registry | null, photoId: string, assetRevision: string): string | undefined {
    return registry?.photos[photoId]?.revisions[assetRevision]?.derived.capturedDate?.value ?? undefined;
}

/** A photo record as compile would publish its authored half. */
function authoredPhotoView(photo: AuthoredPhoto, registry: Registry | null): PhotoView {
    const view: PhotoView = { assetRevision: photo.assetRevision, alt: candidateAlt(photo.alt) };
    for (const key of PHOTO_TEXT) view[key] = presentText(photo[key]);
    view.focalPoint = photo.focalPoint;
    view.crop = photo.crop;
    view.accent = photo.accent;
    view.capturedAt = photo.capturedAt ?? registryDate(registry, photo.id, photo.assetRevision);
    return view;
}

function publishedPhotoView(photo: PublicPhotoRecord): PhotoView {
    const view: PhotoView = { assetRevision: photo.assetRevision, alt: photo.alt };
    for (const key of PHOTO_TEXT) view[key] = photo[key];
    view.focalPoint = photo.focalPoint;
    view.crop = photo.crop;
    view.accent = photo.accent;
    view.capturedAt = photo.capturedAt;
    return view;
}

function mergePhoto(photo: AuthoredPhoto, base: PhotoView | null, target: PhotoView | null, registry: Registry | null): { record: AuthoredPhoto; conflicts: Conflict[] } {
    if (base === null || target === null) return { record: photo, conflicts: [] };
    const mine = authoredPhotoView(photo, registry);
    const next: AuthoredPhoto = { ...photo };
    const conflicts: Conflict[] = [];
    const take = <K extends keyof PhotoView>(field: K, apply: (value: PhotoView[K]) => void) => {
        const merged = threeWay(field, mine[field], base[field], target[field]);
        if (merged.conflict) conflicts.push(merged.conflict);
        if (merged.changed) apply(merged.value);
    };
    take('assetRevision', (value) => {
        next.assetRevision = value;
    });
    take('alt', (value) => {
        const alt = value as PublicPhotoRecord['alt'];
        next.alt = alt.kind === 'described' ? { kind: 'described', text: alt.text, reviewed: true } : { kind: 'decorative' };
    });
    for (const key of [...PHOTO_TEXT, ...PHOTO_PLAIN]) {
        take(key, (value) => {
            if (value === undefined) delete next[key];
            else (next as Record<string, unknown>)[key] = value;
        });
    }
    take('capturedAt', (value) => {
        // A date #10 knows stays #10's: only a different one is an override.
        if (value === undefined || value === registryDate(registry, next.id, next.assetRevision)) delete next.capturedAt;
        else next.capturedAt = value;
    });
    return { record: next, conflicts };
}

// Series.

const SERIES_FIELDS = ['slug', 'slugAliases', 'title', 'statement', 'shortStatement', 'photoIds', 'chapters', 'openingPhotoId', 'cover', 'accent'] as const;
type SeriesField = (typeof SERIES_FIELDS)[number];
interface SeriesView {
    published: boolean;
    /** Null when the side doesn't publish the series, so its fields are unknown. */
    values: Partial<Record<SeriesField, unknown>> | null;
}

function authoredSeriesView(series: AuthoredSeries): SeriesView {
    return { published: series.visibility === 'published', values: Object.fromEntries(SERIES_FIELDS.map((field) => [field, series[field]])) };
}

function publishedSeriesView(series: SeriesRecord | undefined): SeriesView {
    return series ? { published: true, values: Object.fromEntries(SERIES_FIELDS.map((field) => [field, series[field]])) } : { published: false, values: null };
}

function mergeSeries(series: AuthoredSeries, base: SeriesView, target: SeriesView): { record: AuthoredSeries; conflicts: Conflict[] } {
    const mine = authoredSeriesView(series);
    const next: AuthoredSeries = { ...series };
    const conflicts: Conflict[] = [];
    const published = threeWay('visibility', mine.published, base.published, target.published);
    if (published.conflict) conflicts.push({ field: 'visibility', base: base.published ? 'published' : null, active: target.published ? 'published' : null });
    // Unpublished by the target, a once-public series is hidden; one the curator kept as a draft stays a draft.
    if (published.changed) next.visibility = published.value ? 'published' : series.visibility === 'published' ? 'hidden' : series.visibility;
    if (base.values !== null && target.values !== null && mine.values !== null) {
        for (const field of SERIES_FIELDS) {
            const merged = threeWay(field, mine.values[field], base.values[field], target.values[field]);
            if (merged.conflict) conflicts.push(merged.conflict);
            if (!merged.changed) continue;
            if (merged.value === undefined) delete (next as Record<string, unknown>)[field];
            else (next as Record<string, unknown>)[field] = merged.value;
        }
    }
    return { record: next, conflicts };
}

// The site.

/**
 * The site record's merge. `base` is what the record is merged against: the
 * publish's snapshot, or else the record's base revision (none when that
 * revision is null, missing, or damaged). `snapshot` is the snapshot's site
 * record, whose `seriesOrder` the target was compiled from.
 */
function mergeSite(
    site: AuthoredSite,
    base: { featuredSeriesIds: string[]; seriesIds: string[] },
    target: RevisionFile,
    snapshot: AuthoredSite | null,
): { record: AuthoredSite; conflicts: Conflict[] } {
    const next: AuthoredSite = { ...site };
    const conflicts: Conflict[] = [];
    const featured = threeWay('featuredSeriesIds', site.featuredSeriesIds, base.featuredSeriesIds, target.content.site.featuredSeriesIds);
    if (featured.conflict) conflicts.push(featured.conflict);
    if (featured.changed) next.featuredSeriesIds = [...featured.value];
    const order = rebaseSeriesOrder({
        authored: site.seriesOrder,
        baseAuthored: snapshot ? snapshot.seriesOrder : site.baseSeriesOrder,
        base: base.seriesIds,
        target: target.content.series.map((series) => series.id),
    });
    next.seriesOrder = order.seriesOrder;
    // writeRebasedRecord() stores it, the one write that does.
    next.baseSeriesOrder = order.baseSeriesOrder;
    if (order.conflict) conflicts.push(order.conflict);
    return { record: next, conflicts };
}

const EMPTY_BASE: Pick<RevisionFile, 'content'> = { content: { site: { featuredSeriesIds: [] }, series: [], photos: [] } };

/**
 * Rebase the working layer onto `targetRevisionId`, under the authored lock.
 * Throws LockTimeoutError when it can't get the lock, and
 * CatalogIntegrityError when the target revision is missing or damaged. A
 * base revision that is gone counts as empty, so its records keep their
 * fields and only move their base.
 */
export async function rebaseWorkingLayer(options: RebaseOptions): Promise<RebaseReport> {
    const root = path.resolve(options.root);
    assertRevisionId(options.targetRevisionId);
    const run = async (lock: LockContext): Promise<RebaseReport> => {
        const target = await readRevisionFile(root, options.targetRevisionId);
        if (target === null) throw new Error(`The revision ${options.targetRevisionId} has no revision file, so nothing can rebase onto it.`);
        const registry = options.registry !== undefined ? options.registry : await readRegistry(root).catch(() => null);
        const layer = await readWorkingLayer(root);
        const bases = new Map<string, Pick<RevisionFile, 'content'>>();
        const baseOf = async (revisionId: string | null): Promise<Pick<RevisionFile, 'content'>> => {
            if (revisionId === null) return EMPTY_BASE;
            let base = bases.get(revisionId);
            if (!base) {
                base = (await readRevisionFile(root, revisionId).catch(() => null)) ?? EMPTY_BASE;
                bases.set(revisionId, base);
            }
            return base;
        };
        const snapshot = options.snapshot;
        const snapshotSeries = new Map((snapshot?.series ?? []).map((series) => [series.id, series]));
        const snapshotPhotos = new Map((snapshot?.photos ?? []).map((photo) => [photo.id, photo]));
        const targetSeries = new Map(target.content.series.map((series) => [series.id, series]));
        const targetPhotos = new Map(target.content.photos.map((photo) => [photo.id, photo]));
        const report: RebaseReport = { rebased: 0, conflicts: [] };
        const write = async <R extends AuthoredSite | AuthoredSeries | AuthoredPhoto>(record: R, merged: { record: R; conflicts: Conflict[] }) => {
            const conflicts = withConflicts(record.conflicts, merged.conflicts);
            const next = { ...merged.record } as R;
            if (conflicts) next.conflicts = conflicts;
            else delete next.conflicts;
            await writeRebasedRecord(next as never, { expectedVersion: record.version, lock, baseRevisionId: target.revisionId });
            report.rebased++;
            const id = record.kind === 'site' ? 'site' : (record as AuthoredSeries | AuthoredPhoto).id;
            for (const conflict of merged.conflicts) report.conflicts.push({ kind: record.kind, id, field: conflict.field });
        };

        if (layer.site && layer.site.baseRevisionId !== target.revisionId) {
            const base = snapshot?.site
                ? { featuredSeriesIds: snapshot.site.featuredSeriesIds, seriesIds: target.content.series.map((series) => series.id) }
                : await baseOf(layer.site.baseRevisionId).then((revision) => ({
                    featuredSeriesIds: revision.content.site.featuredSeriesIds,
                    seriesIds: revision.content.series.map((series) => series.id),
                }));
            await write(layer.site, mergeSite(layer.site, base, target, snapshot?.site ?? null));
        }
        for (const series of layer.series) {
            if (series.baseRevisionId === target.revisionId) continue;
            const fromSnapshot = snapshotSeries.get(series.id);
            const base = fromSnapshot
                ? authoredSeriesView(fromSnapshot)
                : publishedSeriesView((await baseOf(series.baseRevisionId)).content.series.find((entry) => entry.id === series.id));
            await write(series, mergeSeries(series, base, publishedSeriesView(targetSeries.get(series.id))));
        }
        for (const photo of layer.photos) {
            if (photo.baseRevisionId === target.revisionId) continue;
            const fromSnapshot = snapshotPhotos.get(photo.id);
            let base: PhotoView | null;
            if (fromSnapshot) base = authoredPhotoView(fromSnapshot, registry);
            else {
                const published = (await baseOf(photo.baseRevisionId)).content.photos.find((entry) => entry.id === photo.id);
                base = published ? publishedPhotoView(published) : null;
            }
            const published = targetPhotos.get(photo.id);
            await write(photo, mergePhoto(photo, base, published ? publishedPhotoView(published) : null, registry));
        }
        return report;
    };
    if (options.lock) {
        if (options.lock.name !== AUTHORED_LOCK || options.lock.signal.aborted) throw new Error('rebaseWorkingLayer() needs a live hold on the authored lock.');
        return run(options.lock);
    }
    return withLock(AUTHORED_LOCK, { root, leaseMs: AUTHORED_LEASE_MS, waitMs: options.waitMs ?? AUTHORED_WAIT_MS }, (lock) => run(lock));
}
