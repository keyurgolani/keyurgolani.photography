import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readRegistry } from '../identity/registry';
import type { Registry } from '../identity/types';
import { dataRootStatus } from '../storage/config';
import type { VersionedWriteHooks } from '../storage/document';
import { realpathLoose } from '../storage/fsx';
import { LockTimeoutError, withLock, type LockContext } from '../storage/lock';
import { SERIES_ID_RE } from './schema';
import type { AuthoredSeries, AuthoredSite, FocalPoint } from './types';
import { readActivePointer, readAuthoredRecord, readAuthoredSeries } from './working-layer';
import { AUTHORED_LEASE_MS, AUTHORED_LOCK, AUTHORED_WAIT_MS, AuthoredWriteError, writeAuthoredRecord, type ReviewInputs } from './working-layer-writer';

/**
 * The sequence operations: the only code that changes authored order besides
 * an owner's JSON edit, #13's rebase, #13's draft:init, and #16's "use the
 * published value". The watcher can't reach this module (a lint rule and an
 * import-graph test check that), so ingestion never authors order.
 *
 * Each operation is a pure function over one record, and applySequenceOp()
 * runs it under the `authored` lock and writes the result with
 * compare-and-swap on `version`.
 */

/** Where a photo goes, by its neighbor, as the inbox offers it. */
export type Placement = 'start' | 'end' | { after: string };

export type SeriesOp =
    | { kind: 'setSequence'; seriesId: string; photoIds: string[] }
    | { kind: 'insert' | 'move'; seriesId: string; photoId: string; at: Placement }
    | { kind: 'remove'; seriesId: string; photoId: string }
    /** Omit `focalPoint` to keep the current cover's, or pass null to clear it. */
    | { kind: 'setCover'; seriesId: string; photoId: string; focalPoint?: FocalPoint | null }
    | { kind: 'setOpeningPhoto'; seriesId: string; photoId: string | null }
    | { kind: 'addChapter'; seriesId: string; title: string; startPhotoId: string }
    | { kind: 'moveChapterStart'; seriesId: string; chapterId: string; startPhotoId: string }
    | { kind: 'removeChapter'; seriesId: string; chapterId: string };

export type SiteOp = { kind: 'setSeriesOrder' | 'setFeaturedSeries'; seriesIds: string[] };

export type SequenceOp = SeriesOp | SiteOp;

/** Who asked. #14 stores it with its decision. There is no operation journal. */
export interface Actor {
    kind: 'editor' | 'inbox-approval' | 'policy';
    ref?: string;
}

/** Something an operation changed besides what it was asked to, so callers can report it. */
export interface Consequence {
    kind: 'cover-cleared' | 'focal-point-dropped' | 'opening-cleared' | 'chapter-anchor-moved';
    seriesId: string;
    chapterId?: string;
    fromPhotoId?: string;
    toPhotoId?: string;
}

export type OrderErrorCode =
    | 'version-conflict'
    | 'authored-locked'
    | 'unknown-series'
    | 'unknown-photo'
    | 'duplicate-id'
    | 'anchor-not-found'
    | 'not-a-member'
    | 'already-a-member'
    | 'membership-conflict'
    | 'anchor-conflict'
    | 'anchor-order'
    | 'chapter-would-be-empty'
    | 'position-out-of-range'
    | 'series-unreadable';

export interface OrderError {
    code: OrderErrorCode;
    /** The series ID, or `site`. */
    recordId: string;
    /** The operation field at fault, such as `photoIds[3]`. */
    field?: string;
    message: string;
}

/** What a pure operation needs to know beyond the record it changes. */
export interface SequenceContext {
    /** Whether #10's registry has a record of the photo. */
    isKnownPhoto(photoId: string): boolean;
    /** Published series other than `seriesId` that list the photo. */
    publishedSeriesWith(photoId: string, seriesId: string): string[];
    /** Whether the series exists, readable or not, as refs.series-order counts it. */
    seriesExists(seriesId: string): boolean;
    /** Series whose record exists but can't be read, so their visibility and members are unknown. */
    unreadableSeries: readonly string[];
    newChapterId(): string;
}

/**
 * A context over one registry snapshot and the working layer's series, both
 * read under the caller's hold. `unreadable` names the series the read listed
 * as problems: those with a series ID exist, so the Work order may name them,
 * and no published series can take a new member while any of them might hold it.
 */
export function sequenceContext({ registry, series, unreadable = [], newChapterId = () => `ch_${randomUUID()}` }: {
    registry: Registry;
    series: readonly AuthoredSeries[];
    unreadable?: readonly string[];
    newChapterId?: () => string;
}): SequenceContext {
    const published = new Map<string, string[]>();
    for (const entry of series) {
        if (entry.visibility !== 'published') continue;
        for (const photoId of new Set(entry.photoIds)) published.set(photoId, [...(published.get(photoId) ?? []), entry.id]);
    }
    // A misnamed folder entry (an old-layout `ser_x.json` file, an upper-case folder) is a problem
    // but not a series ID, so it can't be named. It still counts as unreadable below.
    const ids = new Set([...series.map((entry) => entry.id), ...unreadable.filter((id) => SERIES_ID_RE.test(id))]);
    return {
        isKnownPhoto: (photoId) => Object.hasOwn(registry.photos, photoId),
        publishedSeriesWith: (photoId, seriesId) => (published.get(photoId) ?? []).filter((id) => id !== seriesId),
        seriesExists: (seriesId) => ids.has(seriesId),
        unreadableSeries: [...new Set(unreadable)].sort(),
        newChapterId,
    };
}

export type OpResult<R> =
    | { ok: true; record: R; changed: boolean; consequences: Consequence[] }
    | { ok: false; error: OrderError };

const fail = (code: OrderErrorCode, recordId: string, message: string, field?: string): { ok: false; error: OrderError } => ({
    ok: false,
    error: { code, recordId, message, ...(field ? { field } : {}) },
});

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index]);
const samePoint = (a: FocalPoint | undefined, b: FocalPoint | undefined) => a?.x === b?.x && a?.y === b?.y;

/** `list` with `photoId` at `at`, or the anchor it can't find. */
function placed(list: readonly string[], photoId: string, at: Placement): string[] | { missingAnchor: string } {
    const rest = list.filter((id) => id !== photoId);
    if (at === 'start') return [photoId, ...rest];
    if (at === 'end') return [...rest, photoId];
    const index = rest.indexOf(at.after);
    if (index === -1) return { missingAnchor: at.after };
    return [...rest.slice(0, index + 1), photoId, ...rest.slice(index + 1)];
}

function anchorMessage(anchor: string, photoId: string): string {
    return anchor === photoId ? `${photoId} can't be placed after itself.` : `${anchor} is not in the series, so nothing can go after it.`;
}

/** Whether chapter starts are strictly increasing in `photoIds`. A start outside it counts as out of order. */
function anchorsInOrder(photoIds: readonly string[], chapters: readonly { startPhotoId: string }[]): boolean {
    let previous = -1;
    for (const { startPhotoId } of chapters) {
        const index = photoIds.indexOf(startPhotoId);
        if (index <= previous) return false;
        previous = index;
    }
    return true;
}

/**
 * The chapters after `photoId` leaves its place: a chapter it starts goes to
 * the next photo in that chapter. Fails when the chapter has no other photo.
 */
function handOff(series: AuthoredSeries, photoId: string): { chapters: AuthoredSeries['chapters']; consequences: Consequence[] } | { ok: false; error: OrderError } {
    const started = series.chapters.find((entry) => entry.startPhotoId === photoId);
    if (!started) return { chapters: series.chapters, consequences: [] };
    const next = series.photoIds[series.photoIds.indexOf(photoId) + 1];
    if (next === undefined || series.chapters.some((entry) => entry.startPhotoId === next)) {
        return fail('chapter-would-be-empty', series.id, `${photoId} is the only photograph in chapter ${started.id}. Move another photograph into it, or remove the chapter, first.`);
    }
    return {
        chapters: series.chapters.map((entry) => (entry === started ? { ...entry, startPhotoId: next } : entry)),
        consequences: [{ kind: 'chapter-anchor-moved', seriesId: series.id, chapterId: started.id, fromPhotoId: photoId, toPhotoId: next }],
    };
}

/** The cover and opening photo once `dropped` leave the series, with what that cleared. Never picks a replacement. */
function withoutDropped(series: AuthoredSeries, dropped: ReadonlySet<string>): { series: AuthoredSeries; consequences: Consequence[] } {
    const consequences: Consequence[] = [];
    const next = { ...series };
    if (series.cover && dropped.has(series.cover.photoId)) {
        consequences.push({ kind: 'cover-cleared', seriesId: series.id, fromPhotoId: series.cover.photoId });
        if (series.cover.focalPoint) consequences.push({ kind: 'focal-point-dropped', seriesId: series.id, fromPhotoId: series.cover.photoId });
        next.cover = null;
    }
    if (series.openingPhotoId !== undefined && dropped.has(series.openingPhotoId)) {
        consequences.push({ kind: 'opening-cleared', seriesId: series.id, fromPhotoId: series.openingPhotoId });
        delete next.openingPhotoId;
    }
    return { series: next, consequences };
}

function membershipConflict(series: AuthoredSeries, photoIds: readonly string[], context: SequenceContext, field: (index: number) => string) {
    if (series.visibility !== 'published') return null;
    for (const [index, photoId] of photoIds.entries()) {
        if (series.photoIds.includes(photoId)) continue;
        const unreadable = context.unreadableSeries.filter((id) => id !== series.id);
        if (unreadable.length > 0) {
            return fail(
                'series-unreadable',
                series.id,
                `The series ${unreadable.join(', ')} can't be read, so nothing shows whether it holds ${photoId}. A photograph belongs to one published series. Fix that record first.`,
                field(index),
            );
        }
        const others = context.publishedSeriesWith(photoId, series.id);
        if (others.length > 0) {
            return fail('membership-conflict', series.id, `${photoId} is already in the published series ${others.join(', ')}. A photograph belongs to one published series.`, field(index));
        }
    }
    return null;
}

const changedTo = (record: AuthoredSeries, consequences: Consequence[] = []): OpResult<AuthoredSeries> => ({ ok: true, record, changed: true, consequences });
const unchanged = (record: AuthoredSeries): OpResult<AuthoredSeries> => ({ ok: true, record, changed: false, consequences: [] });

/** Apply one operation to a series record. Pure: it returns a new record and never changes the one it gets. */
export function applySeriesOp(series: AuthoredSeries, op: SeriesOp, context: SequenceContext): OpResult<AuthoredSeries> {
    const id = series.id;
    const isMember = (photoId: string) => series.photoIds.includes(photoId);
    const notMember = (photoId: string, field = 'photoId') => fail('not-a-member', id, `${photoId} is not in the series.`, field);

    switch (op.kind) {
        case 'insert': {
            if (!context.isKnownPhoto(op.photoId)) return fail('unknown-photo', id, `${op.photoId} is not a photo the library knows.`, 'photoId');
            const next = placed(series.photoIds, op.photoId, op.at);
            if (!Array.isArray(next)) return fail('anchor-not-found', id, anchorMessage(next.missingAnchor, op.photoId), 'at');
            if (isMember(op.photoId)) {
                if (sameList(next, series.photoIds)) return unchanged(series);
                return fail('already-a-member', id, `${op.photoId} is already in the series. Move it instead.`, 'photoId');
            }
            const conflict = membershipConflict(series, [op.photoId], context, () => 'photoId');
            if (conflict) return conflict;
            return changedTo({ ...series, photoIds: next });
        }
        case 'move': {
            if (!isMember(op.photoId)) return notMember(op.photoId);
            const next = placed(series.photoIds, op.photoId, op.at);
            if (!Array.isArray(next)) return fail('anchor-not-found', id, anchorMessage(next.missingAnchor, op.photoId), 'at');
            if (sameList(next, series.photoIds)) return unchanged(series);
            const handed = handOff(series, op.photoId);
            if ('ok' in handed) return handed;
            return changedTo({ ...series, photoIds: next, chapters: handed.chapters }, handed.consequences);
        }
        case 'remove': {
            if (!isMember(op.photoId)) return notMember(op.photoId);
            const handed = handOff(series, op.photoId);
            if ('ok' in handed) return handed;
            const cleared = withoutDropped(series, new Set([op.photoId]));
            return changedTo(
                { ...cleared.series, photoIds: series.photoIds.filter((photoId) => photoId !== op.photoId), chapters: handed.chapters },
                [...cleared.consequences, ...handed.consequences],
            );
        }
        case 'setSequence': {
            const seen = new Set<string>();
            for (const [index, photoId] of op.photoIds.entries()) {
                if (seen.has(photoId)) return fail('duplicate-id', id, `${photoId} is listed twice.`, `photoIds[${index}]`);
                seen.add(photoId);
            }
            for (const [index, photoId] of op.photoIds.entries()) {
                if (!context.isKnownPhoto(photoId)) return fail('unknown-photo', id, `${photoId} is not a photo the library knows.`, `photoIds[${index}]`);
            }
            const conflict = membershipConflict(series, op.photoIds, context, (index) => `photoIds[${index}]`);
            if (conflict) return conflict;
            if (sameList(op.photoIds, series.photoIds)) return unchanged(series);
            const droppedStart = series.chapters.find((entry) => !seen.has(entry.startPhotoId));
            if (droppedStart) {
                return fail('anchor-order', id, `${droppedStart.startPhotoId} starts chapter ${droppedStart.id}, so the new sequence must keep it. Move or remove the chapter first.`, 'photoIds');
            }
            if (!anchorsInOrder(op.photoIds, series.chapters)) {
                return fail('anchor-order', id, 'The new sequence puts chapter starts out of order. Each chapter must start after the one above it.', 'photoIds');
            }
            const dropped = new Set(series.photoIds.filter((photoId) => !seen.has(photoId)));
            const cleared = withoutDropped(series, dropped);
            return changedTo({ ...cleared.series, photoIds: [...op.photoIds] }, cleared.consequences);
        }
        case 'setCover': {
            if (!isMember(op.photoId)) return notMember(op.photoId);
            const current = series.cover;
            if (current?.photoId === op.photoId) {
                if (op.focalPoint === undefined) return unchanged(series);
                const focalPoint = op.focalPoint ?? undefined;
                if (samePoint(current.focalPoint, focalPoint)) return unchanged(series);
                return changedTo({ ...series, cover: { photoId: op.photoId, ...(focalPoint ? { focalPoint } : {}) } });
            }
            const consequences: Consequence[] = current?.focalPoint
                ? [{ kind: 'focal-point-dropped', seriesId: id, fromPhotoId: current.photoId, toPhotoId: op.photoId }]
                : [];
            return changedTo({ ...series, cover: { photoId: op.photoId, ...(op.focalPoint ? { focalPoint: op.focalPoint } : {}) } }, consequences);
        }
        case 'setOpeningPhoto': {
            if (op.photoId === null) {
                if (series.openingPhotoId === undefined) return unchanged(series);
                const next = { ...series };
                delete next.openingPhotoId;
                return changedTo(next);
            }
            if (!isMember(op.photoId)) return notMember(op.photoId);
            if (series.openingPhotoId === op.photoId) return unchanged(series);
            return changedTo({ ...series, openingPhotoId: op.photoId });
        }
        case 'addChapter': {
            if (!/\S/.test(op.title)) throw new TypeError('A chapter needs a title.');
            if (!isMember(op.startPhotoId)) return notMember(op.startPhotoId, 'startPhotoId');
            if (series.chapters.some((entry) => entry.startPhotoId === op.startPhotoId)) {
                return fail('anchor-conflict', id, `${op.startPhotoId} already starts a chapter.`, 'startPhotoId');
            }
            const at = series.photoIds.indexOf(op.startPhotoId);
            const before = series.chapters.filter((entry) => series.photoIds.indexOf(entry.startPhotoId) < at);
            const after = series.chapters.filter((entry) => series.photoIds.indexOf(entry.startPhotoId) >= at);
            return changedTo({ ...series, chapters: [...before, { id: context.newChapterId(), title: op.title, startPhotoId: op.startPhotoId }, ...after] });
        }
        case 'moveChapterStart': {
            const moving = series.chapters.find((entry) => entry.id === op.chapterId);
            if (!moving) return fail('anchor-not-found', id, `The series has no chapter ${op.chapterId}.`, 'chapterId');
            if (!isMember(op.startPhotoId)) return notMember(op.startPhotoId, 'startPhotoId');
            if (moving.startPhotoId === op.startPhotoId) return unchanged(series);
            const other = series.chapters.find((entry) => entry !== moving && entry.startPhotoId === op.startPhotoId);
            if (other) return fail('anchor-conflict', id, `${op.startPhotoId} already starts chapter ${other.id}.`, 'startPhotoId');
            const chapters = series.chapters.map((entry) => (entry === moving ? { ...entry, startPhotoId: op.startPhotoId } : entry));
            if (!anchorsInOrder(series.photoIds, chapters)) {
                return fail('anchor-order', id, `Chapter ${op.chapterId} would start out of order. Each chapter must start after the one above it.`, 'startPhotoId');
            }
            return changedTo({ ...series, chapters });
        }
        case 'removeChapter': {
            if (!series.chapters.some((entry) => entry.id === op.chapterId)) return fail('anchor-not-found', id, `The series has no chapter ${op.chapterId}.`, 'chapterId');
            return changedTo({ ...series, chapters: series.chapters.filter((entry) => entry.id !== op.chapterId) });
        }
    }
}

/** Apply one operation to the site record. Pure. */
export function applySiteOp(site: AuthoredSite, op: SiteOp, context: SequenceContext): OpResult<AuthoredSite> {
    const seen = new Set<string>();
    for (const [index, seriesId] of op.seriesIds.entries()) {
        if (seen.has(seriesId)) return fail('duplicate-id', 'site', `${seriesId} is listed twice.`, `seriesIds[${index}]`);
        seen.add(seriesId);
        if (!context.seriesExists(seriesId)) return fail('unknown-series', 'site', `There is no series ${seriesId}.`, `seriesIds[${index}]`);
    }
    const field = op.kind === 'setSeriesOrder' ? 'seriesOrder' : 'featuredSeriesIds';
    if (sameList(site[field], op.seriesIds)) return { ok: true, record: site, changed: false, consequences: [] };
    return { ok: true, record: { ...site, [field]: [...op.seriesIds] }, changed: true, consequences: [] };
}

export interface ApplyOptions {
    /** The record's version the caller read, or 0 for a site record that doesn't exist yet. */
    expectedVersion: number;
    actor: Actor;
    /** The caller's `authored` hold, as #14's approvals already have one. */
    lock?: LockContext;
    /** How long to wait for the lock when not given one. Defaults to 10 s. */
    waitMs?: number;
    /** Test hooks, passed to the writer's writeVersionedDocument(). */
    hooks?: VersionedWriteHooks;
    /**
     * What the curator reviewed, for #16's stamps, as #14's approvals pass it.
     * A `policy` actor's write is stamped as generated, since nobody chose it.
     */
    review?: ReviewInputs;
}

export type ApplyResult =
    | { ok: true; changed: boolean; version: number; actor: Actor; consequences: Consequence[] }
    | { ok: false; error: OrderError };

const ACTOR_KINDS = new Set(['editor', 'inbox-approval', 'policy']);
const isSiteOp = (op: SequenceOp): op is SiteOp => op.kind === 'setSeriesOrder' || op.kind === 'setFeaturedSeries';

async function applyUnderHold(root: string, op: SequenceOp, options: ApplyOptions, hold: LockContext): Promise<ApplyResult> {
    const recordId = isSiteOp(op) ? 'site' : op.seriesId;
    const versionConflict = (found: number): ApplyResult => fail('version-conflict', recordId, `The ${isSiteOp(op) ? 'site' : 'series'} record ${recordId} is at version ${found}, not ${options.expectedVersion}. Read it again and retry.`);

    let current: AuthoredSeries | AuthoredSite | null;
    if (isSiteOp(op)) {
        current = await readAuthoredRecord(root, 'site', 'site');
    } else {
        current = await readAuthoredRecord(root, 'series', op.seriesId);
        if (current === null) return fail('unknown-series', recordId, `There is no series ${op.seriesId}.`, 'seriesId');
    }
    // The version check comes before any no-op check, so a retry always re-reads.
    const found = current?.version ?? 0;
    if (found !== options.expectedVersion) return versionConflict(found);

    const [registry, { series, problems }] = await Promise.all([readRegistry(root), readAuthoredSeries(root)]);
    // Every series problem, misnamed entries included: sequenceContext decides which ones the Work order may name.
    const context = sequenceContext({ registry, series, unreadable: problems.filter((problem) => problem.kind === 'series').map((problem) => problem.id) });
    const result = isSiteOp(op)
        ? applySiteOp((current as AuthoredSite | null) ?? { schemaVersion: 1, version: 0, baseRevisionId: null, kind: 'site', featuredSeriesIds: [], seriesOrder: [], baseSeriesOrder: null }, op, context)
        : applySeriesOp(current as AuthoredSeries, op, context);
    if (!result.ok) return result;
    if (!result.changed) return { ok: true, changed: false, version: found, actor: options.actor, consequences: [] };

    const record: AuthoredSite | AuthoredSeries = result.record;
    const policy = options.actor.kind === 'policy';
    const review: ReviewInputs | undefined = options.review || policy
        ? {
            baseRevisionId: options.review ? options.review.baseRevisionId : (await readActivePointer(root))?.revisionId ?? null,
            actor: options.review?.actor ?? `policy${options.actor.ref ? `:${options.actor.ref}` : ''}`,
            reviewedAt: options.review?.reviewedAt ?? new Date().toISOString(),
            ...(options.review?.event ? { event: options.review.event } : {}),
            ...(policy ? { origin: 'generated' as const } : {}),
        }
        : undefined;
    const writeOptions = { expectedVersion: found, lock: hold, root, hooks: options.hooks, ...(review ? { review } : {}) };
    try {
        const written = record.kind === 'site' ? await writeAuthoredRecord(record, writeOptions) : await writeAuthoredRecord(record, writeOptions);
        return { ok: true, changed: true, version: written.version, actor: options.actor, consequences: result.consequences };
    } catch (error) {
        // Under the hold only a hand edit, or a writer past its lease, can get in between, and it wins.
        if (error instanceof AuthoredWriteError && error.code === 'VERSION_CONFLICT') return versionConflict(error.foundVersion ?? found);
        throw error;
    }
}

/**
 * Apply one operation to the working layer. Takes the `authored` lock, or
 * reuses `options.lock`, reads the record, checks `expectedVersion`, runs the
 * pure operation against the registry and every series as they are under the
 * hold, and writes the result unless it changed nothing. A rejected
 * operation writes nothing. Throws only for I/O and programming errors: a
 * data root that isn't ready, a record that can't be read, or a bad hold.
 */
export async function applySequenceOp(layer: { dataRoot: string }, op: SequenceOp, options: ApplyOptions): Promise<ApplyResult> {
    if (!ACTOR_KINDS.has(options.actor?.kind)) throw new TypeError(`Unknown actor kind ${JSON.stringify(options.actor?.kind)}.`);
    const root = path.resolve(layer.dataRoot);
    const status = dataRootStatus({ write: true, root });
    if (status.state !== 'ready') throw new Error(`The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}.`);

    if (options.lock) {
        const { lock } = options;
        if (lock.name !== AUTHORED_LOCK || realpathLoose(lock.root) !== realpathLoose(root) || lock.signal.aborted) {
            throw new Error('The hold passed in is not a live hold on this data root\'s authored lock.');
        }
        return applyUnderHold(root, op, options, lock);
    }
    try {
        return await withLock(AUTHORED_LOCK, { root, leaseMs: AUTHORED_LEASE_MS, waitMs: options.waitMs ?? AUTHORED_WAIT_MS }, (hold) => applyUnderHold(root, op, options, hold));
    } catch (error) {
        if (error instanceof LockTimeoutError) return fail('authored-locked', isSiteOp(op) ? 'site' : op.seriesId, `${error.message} Nothing was written.`);
        throw error;
    }
}
