import path from 'node:path';
import { dismissEvent } from '../curation/actions';
import { settledByPlacement, type CurationEvent } from '../curation/events';
import { listEvents, withCurationLock } from '../curation/repository';
import { photoEntryName } from '../a11y/photoName';
import { canonicalJson } from '../identity/ids';
import { readRegistry } from '../identity/registry';
import type { Registry } from '../identity/types';
import { dataRootStatus, libraryRoot } from '../storage/config';
import { LockLostError, LockTimeoutError, withLock, type LockContext } from '../storage/lock';
import { legacyEntries, legacySitePhotos } from './photos-api';
import { checkLayer } from './publish';
import { hashValue, stampWrite } from './review';
import { CARRY_OVER_SERIES_ID, parseAuthoredRecord } from './schema';
import type { CommandResult, LayerHandle } from './sequence-commands';
import type { AuthoredPhoto, AuthoredRecord, AuthoredSeries, AuthoredSite, ExcludedMember, Issue, WorkingLayer } from './types';
import { readActivePointer, readWorkingLayer } from './working-layer';
import { AUTHORED_LEASE_MS, AUTHORED_LOCK, AUTHORED_WAIT_MS, AuthoredWriteError, writeAuthoredRecord } from './working-layer-writer';

/**
 * `photos carry-over`, the one-time step before the launch publish (owner,
 * 2026-10-28): every photo the legacy Gallery lists today goes into one
 * published series, "Gallery", in the Gallery's order, featured on Home and
 * alone in Work's order, so no photo leaves the site at the launch.
 *
 * The source of truth is legacyEntries() (photos-api.ts), the list legacy
 * /api/photos serves and the legacy Gallery shows in that order. What counts
 * as on the site is legacySitePhotos(), as publish's launch count has it, so
 * a photo the Gallery can't show for want of its legacy files can't carry,
 * and has to be accepted by name like any photo that leaves at the launch. Each photo
 * keeps the name the Gallery gives it today, "Photograph N of T": its record
 * gets no description, only the carry-over marker with the owner's direction,
 * and a marked photo with no alt compiles to the `position` alt, which the
 * screens name by place and the description rule lets publish. The series
 * has the marker too, so it may go without a statement until he writes one.
 * No prose is written in his name.
 *
 * The new photographs' inbox items close the way any placement closes them
 * (settledByPlacement()), with nothing written to them. One placement can't
 * settle, because its photo moved to other bytes since the item opened, is
 * dismissed with the owner's direction as the reason.
 *
 * It refuses when the working layer already holds the owner's own curation:
 * any other series, or a Work order or featured series it would replace. A
 * second run changes nothing. The dry run, the default, writes nothing at
 * all, and prints the plan and what `photos publish --dry-run` would then
 * find. A photo it can't carry is listed by name with why, and the command
 * exits 1 unless `--allow-missing` names every one of them.
 */

export const CARRY_OVER_SERIES = { id: CARRY_OVER_SERIES_ID, slug: 'gallery', title: 'Gallery' } as const;
/** The owner's direction, quoted exactly, which the marker and every dismissal record as the reason. */
export const OWNER_DIRECTION = 'Whatever photos the current photography site uses, should remain as they are. I will curate new photos that I add.';
export const CARRY_OVER_REASON = `Carried over from the legacy Gallery at the launch. The owner: "${OWNER_DIRECTION}"`;

export interface CarriedPhoto {
    photoId: string;
    sourcePath: string;
    /** 1-based, in the Gallery's order. */
    position: number;
    /** The name the site gives it: "Photograph N of T" until it has a description, its description's entry name after. */
    name: string;
    /** What happens to its photo record: created, given the marker, or already as planned. */
    record: 'create' | 'mark' | 'keep';
    /** Its description when it already has a reviewed one or is decorative, which the carry-over keeps. */
    description: string | null;
}

export interface UncarriedPhoto {
    photoId: string;
    sourcePath: string;
    reason: string;
    /** Named in `--allow-missing`. */
    allowed: boolean;
}

export interface ClosedItem {
    eventId: string;
    sourcePath: string;
    /** `placement`: the series settles it, with nothing written. `dismiss`: a recorded dismissal. */
    how: 'placement' | 'dismiss';
    version: number;
}

export interface CarryOverPlan {
    /** `refused`: the working layer holds the owner's own curation, or can't be read. `done`: nothing left to change. */
    state: 'ready' | 'done' | 'refused';
    refusals: string[];
    photos: CarriedPhoto[];
    uncarried: UncarriedPhoto[];
    closes: ClosedItem[];
    /** Inbox items about carried photos that stay open, such as a replacement, with why. */
    stays: { eventId: string; sourcePath: string; reason: string }[];
    /** Photos in the library the legacy Gallery doesn't show today, left as they are, with why. They aren't on the site, so none leaves it. */
    notOnSite: { photoId: string; sourcePath: string; reason: string }[];
    /** Names `--allow-missing` gave that match no photo the plan can't carry. */
    unmatchedAllow: string[];
    /** What `photos publish --dry-run` would find once it's applied. */
    predicted: { gone: number | null; published: number; errors: Issue[] } | null;
    /** The records apply writes, with the version each was read at (0 for a new one). */
    writes: { record: AuthoredRecord; expectedVersion: number }[];
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** The managed fields a write sets itself, left out when two records are compared. */
const MANAGED = new Set(['schemaVersion', 'version', 'baseRevisionId', 'baseSeriesOrder', 'review', 'conflicts']);

/** A record as compared: parsed, so defaults count, without the fields the writer manages. */
function comparable(record: AuthoredRecord): string {
    // A planned record has no managed fields yet, so they're filled in for the parse and left out after.
    const parsed = parseAuthoredRecord(record.kind, Object.assign({ schemaVersion: 1, version: 1, baseRevisionId: null }, record));
    const value = (parsed.ok ? parsed.value : record) as Record<string, unknown>;
    return canonicalJson(Object.fromEntries(Object.entries(value).filter(([key]) => !MANAGED.has(key))));
}

/**
 * A planned record as writeAuthoredRecord() would store it, for the check
 * the plan runs in memory: the managed fields, and #16's stamps for what it
 * changes, reviewed by `actor` against `base`. The writer computes them
 * again when it writes.
 */
function asWritten(record: AuthoredRecord, existing: AuthoredRecord | undefined, base: string | null, actor: string, reviewedAt: string, coverOf: (record: AuthoredRecord | undefined) => string | null): AuthoredRecord {
    if (existing && comparable(existing) === comparable(record)) return existing;
    const managed = { schemaVersion: 1, version: (existing?.version ?? 0) + 1, baseRevisionId: existing ? existing.baseRevisionId : base };
    const parsed = parseAuthoredRecord(record.kind, Object.assign({}, record, managed, { review: undefined }));
    if (!parsed.ok) throw new Error(`The carry-over planned an invalid ${record.kind} record: ${parsed.error.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
    const next = parsed.value as AuthoredRecord;
    const review = stampWrite(existing ?? null, next, { baseRevisionId: base, origin: 'curator', actor, reviewedAt, ...reviewedValuesOf(next) }, { next: coverOf(next), existing: coverOf(existing) });
    return { ...next, review } as AuthoredRecord;
}

/**
 * The owner's review of a carried photo's name: its alt stays null, and the
 * carry-over's write stamps that null as reviewed by him, so the review rules
 * read the `position` name it publishes as his decision, not as a hand edit.
 */
function reviewedValuesOf(record: AuthoredRecord): { reviewedValues?: Record<string, string> } {
    return record.kind === 'photo' && record.alt === null && record.carryOver !== undefined ? { reviewedValues: { alt: hashValue(null) } } : {};
}

const EXCLUDED_REASON: Record<ExcludedMember['reason'], string> = {
    'no-record': 'it has no photo record',
    'unknown-photo': "the registry doesn't know it",
    'unknown-revision': "the registry doesn't have the version its record pins",
    'not-ready': "its catalog derivative set isn't ready yet. The watcher builds it, so run this again once photos status shows no pending jobs",
    'no-manifest': "its catalog derivative set has no manifest, so photos identity retry has to build it again",
};

/** Why the working layer can't take a carry-over: the owner's own curation, which a one-time step must never replace. */
function refusalsOf(layer: WorkingLayer, carried: AuthoredSeries | undefined): string[] {
    const refusals: string[] = [];
    for (const problem of layer.problems) refusals.push(`The ${problem.kind} record ${problem.id} can't be read (${problem.reason}). Fix it first: nothing here replaces a record it can't read.`);
    const others = layer.series.filter((series) => series.id !== CARRY_OVER_SERIES.id);
    if (others.length > 0) refusals.push(`The working layer already has ${plural(others.length, 'series')} of yours: ${others.map((series) => `${series.id}${series.title ? ` ("${series.title}")` : ''}`).join(', ')}. The carry-over only runs on a working layer with no series yet.`);
    const own = layer.series.find((series) => series.id === CARRY_OVER_SERIES.id);
    if (own && own.carryOver === undefined) refusals.push(`${CARRY_OVER_SERIES.id} already exists, and photos carry-over didn't make it, so it's yours.`);
    const allowed = (ids: readonly string[]) => ids.length === 0 || (ids.length === 1 && ids[0] === CARRY_OVER_SERIES.id && carried !== undefined);
    if (layer.site && !allowed(layer.site.seriesOrder)) refusals.push(`Work's order is already set: ${layer.site.seriesOrder.join(', ')}. The carry-over would replace it.`);
    if (layer.site && !allowed(layer.site.featuredSeriesIds)) refusals.push(`The featured series is already set: ${layer.site.featuredSeriesIds.join(', ')}. The carry-over would replace it.`);
    return refusals;
}

/** The photos in Gallery order, each with its planned record, or why it can't come. */
function photoPlans(entries: { photoId: string; sourcePath: string }[], records: Map<string, AuthoredPhoto>, registry: Registry, marker: NonNullable<AuthoredPhoto['carryOver']>) {
    const planned: { photoId: string; sourcePath: string; record: AuthoredPhoto; expectedVersion: number; existing: AuthoredPhoto | undefined }[] = [];
    const uncarried: Omit<UncarriedPhoto, 'allowed'>[] = [];
    for (const { photoId, sourcePath } of entries) {
        const observed = registry.photos[photoId].source.observedRevision;
        const existing = records.get(photoId);
        if (existing && existing.assetRevision !== observed) {
            uncarried.push({ photoId, sourcePath, reason: `its photo record pins ${existing.assetRevision}, not ${observed}, the version the Gallery shows. Settle its replacement in the Inbox first` });
            continue;
        }
        if (existing?.alt?.kind === 'described' && !existing.alt.reviewed) {
            uncarried.push({ photoId, sourcePath, reason: 'its photo record has a suggested description nobody has reviewed. Review it in the Inbox, or clear it, first' });
            continue;
        }
        // Only a photo with no alt carries the marker: one he already described or marked decorative keeps that as it is.
        const record: AuthoredPhoto = existing
            ? existing.alt === null ? { ...existing, carryOver: existing.carryOver ?? marker } : existing
            : ({ kind: 'photo', id: photoId, assetRevision: observed, alt: null, carryOver: marker } as AuthoredPhoto);
        planned.push({ photoId, sourcePath, record, expectedVersion: existing?.version ?? 0, existing });
    }
    return { planned, uncarried };
}

/**
 * The carry-over's plan for the data root as it is now. Reads only. `allow`
 * holds the photo IDs or library paths `--allow-missing` names.
 */
export async function planCarryOver(dataRoot: string, { allow = [], clock = Date.now, actor = 'cli' }: { allow?: readonly string[]; clock?: () => number; actor?: string } = {}): Promise<CarryOverPlan> {
    const root = path.resolve(dataRoot);
    const empty: CarryOverPlan = { state: 'refused', refusals: [], photos: [], uncarried: [], closes: [], stays: [], notOnSite: [], unmatchedAllow: [], predicted: null, writes: [] };
    const layer = await readWorkingLayer(root);
    const registry = await readRegistry(root);
    const pointer = await readActivePointer(root);
    const carried = layer.series.find((series) => series.id === CARRY_OVER_SERIES.id && series.carryOver !== undefined);
    const refusals = refusalsOf(layer, carried);
    if (pointer !== null && carried === undefined) refusals.push(`Revision ${pointer.revisionId} is live already, so the launch has run. The carry-over only runs before it.`);
    if (refusals.length > 0) return { ...empty, refusals };

    const marker = carried?.carryOver ?? { reason: CARRY_OVER_REASON, at: new Date(clock()).toISOString() };
    const library = libraryRoot();
    const { entries, unlisted } = await legacyEntries(registry, library);
    // A photo hidden behind another's shared set isn't on the site. One the Gallery can't show for want of its legacy
    // files still counts as on it, as publish's launch count has it, so it can't carry and needs --allow-missing.
    const hidden = new Set(legacySitePhotos(registry, library).hidden.map((photo) => photo.photoId));
    const records = new Map(layer.photos.map((photo) => [photo.id, photo]));
    const plans = photoPlans(entries, records, registry, marker);
    const { uncarried } = plans;
    for (const photo of unlisted) if (!hidden.has(photo.photoId)) uncarried.push({ ...photo, reason: `${photo.reason} today, though the site still counts it as on it` });
    let { planned } = plans;

    // Compile the layer as it would be, so a photo that can't publish is named now, not dropped at the launch.
    const build = (members: typeof planned) => {
        const photoIds = members.map((entry) => entry.photoId);
        const series = {
            ...(carried ?? { kind: 'series', id: CARRY_OVER_SERIES.id, slug: CARRY_OVER_SERIES.slug, slugAliases: [], title: CARRY_OVER_SERIES.title, statement: '', shortStatement: '', chapters: [], visibility: 'published', publicationPolicy: 'review-required' }),
            photoIds,
            // The Gallery's first photo, as the carry-over sets it, so a cover the owner chose reads as his change.
            cover: photoIds.length === 0 ? null : { photoId: photoIds[0] },
            carryOver: marker,
        } as AuthoredSeries;
        const site = { ...(layer.site ?? { kind: 'site', baseSeriesOrder: null }), featuredSeriesIds: [CARRY_OVER_SERIES.id], seriesOrder: [CARRY_OVER_SERIES.id] } as AuthoredSite;
        // The layer as the writes would leave it, stamps and all, so the review rules read it as they will.
        const base = pointer?.revisionId ?? null;
        const at = new Date(clock()).toISOString();
        const photos = new Map(records);
        for (const entry of members) photos.set(entry.photoId, asWritten(entry.record, entry.existing, base, actor, at, () => null) as AuthoredPhoto);
        const coverOf = (record: AuthoredRecord | undefined) => (record?.kind === 'series' && record.cover ? photos.get(record.cover.photoId)?.assetRevision ?? null : null);
        const next: WorkingLayer = {
            site: asWritten(site, layer.site ?? undefined, base, actor, at, () => null) as AuthoredSite,
            series: [...layer.series.filter((entry) => entry.id !== CARRY_OVER_SERIES.id), asWritten(series, carried, base, actor, at, coverOf) as AuthoredSeries].sort((a, b) => compare(a.id, b.id)),
            photos: [...photos.values()].sort((a, b) => compare(a.id, b.id)),
            problems: [],
        };
        return { next, series, site };
    };
    let built = build(planned);
    let checked = await checkLayer(root, built.next);
    const excluded = new Map(checked.compiled.excluded.filter((member) => member.seriesId === CARRY_OVER_SERIES.id).map((member) => [member.photoId, member]));
    if (excluded.size > 0) {
        for (const entry of planned) {
            const member = excluded.get(entry.photoId);
            if (member) uncarried.push({ photoId: entry.photoId, sourcePath: entry.sourcePath, reason: EXCLUDED_REASON[member.reason] });
        }
        planned = planned.filter((entry) => !excluded.has(entry.photoId));
        built = build(planned);
        checked = await checkLayer(root, built.next);
    }
    // Before the launch, a Gallery the carry-over made is the plan, or a crash left it out. Anything else is his now.
    if (carried && pointer === null && comparable(carried) !== comparable(built.series)) {
        return { ...empty, refusals: [changedRefusal(carried, built.series, records)] };
    }
    // A crash leaves the site absent or as it was before the carry-over. One he changed since is his, even emptied.
    if (carried?.carryOver && pointer === null && layer.site && comparable(layer.site) !== comparable(built.site)) {
        const since = Date.parse(carried.carryOver.at);
        const site = layer.site;
        const changed = (['seriesOrder', 'featuredSeriesIds'] as const).filter((field) => {
            const stamp = site.review?.fields[field];
            return stamp !== undefined && Date.parse(stamp.reviewedAt) > since;
        });
        if (changed.length > 0) {
            const what = changed.length === 2 ? "Work's order and the featured series" : changed[0] === 'seriesOrder' ? "Work's order" : 'The featured series';
            return { ...empty, refusals: [`${what} changed since the carry-over. ${changed.length === 2 ? "They're" : "It's"} yours now, so the carry-over doesn't put ${changed.length === 2 ? 'them' : 'it'} back. Nothing was written.`] };
        }
    }
    const allowed = new Set(allow);
    const named = uncarried.map((photo) => ({ ...photo, allowed: allowed.has(photo.photoId) || allowed.has(photo.sourcePath) })).sort((a, b) => compare(a.sourcePath, b.sourcePath));
    const unmatchedAllow = [...allowed].filter((name) => !uncarried.some((photo) => photo.photoId === name || photo.sourcePath === name));
    const notOnSite = [...unlisted.filter((photo) => hidden.has(photo.photoId)), ...offSite(registry, new Set(entries.map((entry) => entry.photoId)), new Set(unlisted.map((photo) => photo.photoId)))].sort((a, b) => compare(a.sourcePath, b.sourcePath));

    const total = planned.length;
    const photos: CarriedPhoto[] = planned.map((entry, index) => {
        const alt = entry.record.alt;
        const description = alt?.kind === 'described' ? alt.text : alt?.kind === 'decorative' ? 'decorative' : null;
        return {
            photoId: entry.photoId,
            sourcePath: entry.sourcePath,
            position: index + 1,
            name: photoEntryName({ alt: alt?.kind === 'described' ? { kind: 'described', text: alt.text, reviewed: true } : undefined, position: index + 1, total }),
            record: entry.existing === undefined ? 'create' : comparable(entry.existing) === comparable(entry.record) ? 'keep' : 'mark',
            description,
        };
    });

    // The writes: changed photo records, then the series, then the site, each only when it differs.
    const writes: CarryOverPlan['writes'] = [];
    for (const entry of planned) if (!entry.existing || comparable(entry.existing) !== comparable(entry.record)) writes.push({ record: entry.record, expectedVersion: entry.expectedVersion });
    if (planned.length > 0) {
        if (!carried || comparable(carried) !== comparable(built.series)) writes.push({ record: built.series, expectedVersion: carried?.version ?? 0 });
        if (!layer.site || comparable(layer.site) !== comparable(built.site)) writes.push({ record: built.site, expectedVersion: layer.site?.version ?? 0 });
    }

    // The new photographs' items placement settles, the ones it can't, and the other items about carried photos.
    const { events } = await listEvents(root);
    const carriedIds = new Map(planned.map((entry) => [entry.photoId, entry]));
    const closes: ClosedItem[] = [];
    const stays: CarryOverPlan['stays'] = [];
    for (const event of events.sort((a, b) => compare(a.id, b.id))) {
        const entry = event.photoId === null ? undefined : carriedIds.get(event.photoId);
        if (!entry || (event.status !== 'open' && event.status !== 'deferred' && event.status !== 'failed')) continue;
        if (event.type === 'new') {
            const settled = settledByPlacement(event, { holders: [CARRY_OVER_SERIES.id], assetRevisions: new Set([entry.record.assetRevision]) });
            closes.push({ eventId: event.id, sourcePath: entry.sourcePath, how: settled ? 'placement' : 'dismiss', version: event.version });
        } else {
            stays.push({ eventId: event.id, sourcePath: entry.sourcePath, reason: `${itemKind(event)} stays open: the carry-over doesn't decide it` });
        }
    }

    const errors = checked.issues.filter((issue) => issue.severity === 'error');
    const idle = writes.length === 0 && closes.every((item) => item.how === 'placement');
    // After the launch it never writes: Gallery and the new photos are his to curate.
    if (pointer !== null && !idle) {
        return { ...empty, refusals: [`Revision ${pointer.revisionId} is live, so the launch has run. The carry-over only runs before it, and Gallery is yours now. Nothing was written.`] };
    }
    const predicted = { gone: checked.launch?.gone ?? null, published: checked.compiled.content.photos.length, errors };
    return { state: idle ? 'done' : 'ready', refusals: [], photos, uncarried: named, closes, stays, notOnSite, unmatchedAllow, predicted, writes };
}

/**
 * How the carried-over Gallery differs from the plan, for the refusal: what
 * the owner changed, and what changed in the legacy Gallery itself, such as a
 * photo that arrived after the carry-over. Only the carry-over writes a
 * photo's marker, so a photo with one was carried.
 */
function changesOf(carried: AuthoredSeries, planned: AuthoredSeries, records: ReadonlyMap<string, AuthoredPhoto>): { owner: string[]; legacy: string[] } {
    const owner: string[] = [];
    const legacy: string[] = [];
    const marked = (photoId: string) => records.get(photoId)?.carryOver !== undefined;
    const now = new Set(carried.photoIds);
    const plan = new Set(planned.photoIds);
    const extra = carried.photoIds.filter((photoId) => !plan.has(photoId));
    const missing = planned.photoIds.filter((photoId) => !now.has(photoId));
    const added = extra.filter((photoId) => !marked(photoId)).length;
    const departed = extra.length - added;
    const removed = missing.filter(marked).length;
    const arrived = missing.length - removed;
    if (added > 0) owner.push(`${plural(added, 'photo')} added that the legacy Gallery doesn't show`);
    if (removed > 0) owner.push(`${plural(removed, 'photo')} the legacy Gallery shows ${removed === 1 ? 'is' : 'are'} out of it`);
    const kept = carried.photoIds.filter((photoId) => plan.has(photoId));
    if (kept.join() !== planned.photoIds.filter((photoId) => now.has(photoId)).join()) owner.push('the photos are in another order');
    for (const field of ['title', 'slug', 'visibility', 'statement', 'shortStatement'] as const) if (carried[field] !== planned[field]) owner.push(`its ${field === 'shortStatement' ? 'short statement' : field} changed`);
    if (canonicalJson(carried.chapters) !== canonicalJson(planned.chapters) || carried.openingPhotoId !== planned.openingPhotoId) owner.push('its chapters or opening photo changed');
    if (arrived > 0) legacy.push(`it shows ${plural(arrived, 'photo')} ${CARRY_OVER_SERIES.id} doesn't have`);
    if (departed > 0) legacy.push(`${plural(departed, 'photo')} carried into ${CARRY_OVER_SERIES.id} ${departed === 1 ? "isn't" : "aren't"} on it now`);
    // The carry-over's cover is the first photo, so one that follows the first photo moved with the list, not by hand.
    const coverMoved = canonicalJson(carried.cover) !== canonicalJson(planned.cover);
    if (coverMoved && (owner.length > 0 || legacy.length === 0 || carried.cover?.photoId !== carried.photoIds[0])) owner.push('its cover changed');
    if (owner.length === 0 && legacy.length === 0) owner.push('a field the carry-over sets changed');
    return { owner, legacy };
}

/** The refusal when the carried-over Gallery no longer matches the plan, blaming the owner only for what he changed. */
function changedRefusal(carried: AuthoredSeries, planned: AuthoredSeries, records: ReadonlyMap<string, AuthoredPhoto>): string {
    const { owner, legacy } = changesOf(carried, planned, records);
    const since = legacy.length > 0 ? `The legacy Gallery changed since the carry-over: ${legacy.join('; ')}.` : '';
    if (owner.length === 0) return `${since} The carry-over doesn't change a Gallery it already made, so place those photos yourself. photos publish --dry-run counts any that would leave the site. Nothing was written.`;
    return `${CARRY_OVER_SERIES.id} has changed since the carry-over made it: ${owner.join('; ')}.${since ? ` ${since}` : ''} It's yours now, so the carry-over doesn't put it back. Nothing was written.`;
}

/** Photos in the registry the legacy Gallery doesn't show and legacyEntries() didn't already explain, with why. */
function offSite(registry: Registry, shown: ReadonlySet<string>, explained: ReadonlySet<string>): CarryOverPlan['notOnSite'] {
    const out: CarryOverPlan['notOnSite'] = [];
    for (const photo of Object.values(registry.photos)) {
        if (shown.has(photo.photoId) || explained.has(photo.photoId) || photo.mergedInto !== undefined || photo.sourceHealth === 'archived') continue;
        const revision = photo.revisions[photo.source.observedRevision];
        const reason = !photo.source.present || photo.sourceHealth !== 'present'
            ? "its file isn't in the library now"
            : photo.source.path.includes('/')
                ? 'it is in a folder, and the legacy Gallery shows only the top level of the library'
                : revision === undefined || revision.width === null || revision.height === null
                    ? "the watcher can't read it"
                    : "the legacy Gallery doesn't list it";
        out.push({ photoId: photo.photoId, sourcePath: photo.source.path, reason });
    }
    return out;
}

function itemKind(event: CurationEvent): string {
    switch (event.type) {
        case 'replacement':
            return 'Its replacement item';
        case 'missing':
            return 'Its missing-source item';
        default:
            return 'Its item';
    }
}

export interface ApplyResult {
    plan: CarryOverPlan;
    written: string[];
    dismissed: string[];
    /** Dismissals that didn't go through, with why. The records are written by then. */
    failedDismissals: { eventId: string; message: string }[];
}

/** A plan that leaves photos behind that `--allow-missing` didn't name, or that would still block the publish. */
function blockers(plan: CarryOverPlan): string[] {
    const lines: string[] = [];
    const unnamed = plan.uncarried.filter((photo) => !photo.allowed);
    if (unnamed.length > 0) lines.push(`${plural(unnamed.length, 'photo')} on the site today can't carry over, and --allow-missing doesn't name ${unnamed.length === 1 ? 'it' : 'them'}.`);
    if (plan.unmatchedAllow.length > 0) lines.push(`--allow-missing names ${plan.unmatchedAllow.join(', ')}, which the plan doesn't list as a photo it can't carry.`);
    // Only what he accepted by name may leave the site: anything else leaving is a photo the plan lost.
    const accepted = plan.uncarried.filter((photo) => photo.allowed).length;
    if (plan.predicted && plan.predicted.gone !== null && plan.predicted.gone !== accepted && unnamed.length === 0) {
        lines.push(`photos publish would take ${plural(plan.predicted.gone, 'photo')} off the site, and --allow-missing accepts ${accepted} by name. Nothing leaves the site that you didn't name.`);
    }
    if (plan.predicted && plan.predicted.errors.length > 0) lines.push(`photos publish --dry-run would still find ${plural(plan.predicted.errors.length, 'error')}.`);
    if (plan.photos.length === 0) lines.push('No photo would carry over.');
    return lines;
}

export class CarryOverRefused extends Error {
    readonly plan: CarryOverPlan;
    readonly reasons: string[];

    constructor(plan: CarryOverPlan, reasons: string[]) {
        super(reasons.join(' '));
        this.plan = plan;
        this.reasons = reasons;
    }
}

/**
 * Apply the plan under the curation lock, then the authored lock, the order
 * #14's approve takes them in, planning again under both so it writes against
 * one snapshot. Every record is written with compare-and-swap and #16's
 * review stamp: by `actor`, against the active revision. Dismissals go after
 * both locks are let go, each through dismissEvent() with its own.
 */
export async function applyCarryOver(layer: LayerHandle, { actor, allow = [], clock = Date.now, hooks }: { actor: string; allow?: readonly string[]; clock?: () => number; hooks?: Parameters<typeof writeAuthoredRecord>[1]['hooks'] }): Promise<ApplyResult> {
    const root = path.resolve(layer.dataRoot);
    const waitMs = layer.waitMs ?? AUTHORED_WAIT_MS;
    const { plan, written } = await withCurationLock(root, { waitMs }, async () =>
        withLock(AUTHORED_LOCK, { root, leaseMs: AUTHORED_LEASE_MS, waitMs }, async (lock: LockContext) => {
            const current = await planCarryOver(root, { allow, clock, actor });
            if (current.state === 'refused') throw new CarryOverRefused(current, current.refusals);
            const stop = blockers(current);
            if (stop.length > 0) throw new CarryOverRefused(current, stop);
            const base = (await readActivePointer(root))?.revisionId ?? null;
            const reviewedAt = new Date(clock()).toISOString();
            const done: string[] = [];
            for (const { record, expectedVersion } of current.writes) {
                lock.signal.throwIfAborted();
                await writeAuthoredRecord(record as never, { expectedVersion, lock, root, hooks, review: { baseRevisionId: base, origin: 'curator', actor, reviewedAt, ...reviewedValuesOf(record) }, carryOver: true });
                done.push(record.kind === 'site' ? 'site' : record.id);
            }
            return { plan: current, written: done };
        }),
    );
    const dismissed: string[] = [];
    const failedDismissals: ApplyResult['failedDismissals'] = [];
    for (const item of plan.closes.filter((entry) => entry.how === 'dismiss')) {
        const outcome = await dismissEvent({ root, eventId: item.eventId, expectedVersion: item.version, actor, reason: CARRY_OVER_REASON, clock });
        if (outcome.ok) dismissed.push(item.eventId);
        else failedDismissals.push({ eventId: item.eventId, message: outcome.message });
    }
    return { plan, written, dismissed, failedDismissals };
}

/** How many entries a list prints before it only counts the rest. */
const LISTED = 500;
const listed = (lines: string[]) => (lines.length > LISTED ? [...lines.slice(0, LISTED), `  and ${lines.length - LISTED} more`] : lines);

function planLines(plan: CarryOverPlan): string[] {
    const lines: string[] = [];
    const total = plan.photos.length;
    lines.push(`Series: ${CARRY_OVER_SERIES.id}, "${CARRY_OVER_SERIES.title}", published, with ${plural(total, 'photo')} in the legacy Gallery's order, and no statement.`);
    lines.push(`Home's featured series and Work's order: ${CARRY_OVER_SERIES.id} alone.`);
    lines.push(
        `The photos keep the names the Gallery gives them today, "Photograph N of ${total}", and get no description. Each record says it was carried over, with your direction as the reason: "${OWNER_DIRECTION}" A publish doesn't wait for their descriptions. You can describe any of them any time, with photos describe --import or photos edit, and the description then replaces the name.`,
    );
    lines.push('', 'Photos, by position:');
    lines.push(...listed(plan.photos.map((photo) => `  ${String(photo.position).padStart(String(total).length)}. ${photo.sourcePath} (${photo.photoId}): ${photo.description === null ? `"${photo.name}", no description yet` : photo.description === 'decorative' ? 'decorative, as its record already says' : `keeps its description, "${photo.description}"`}${photo.record === 'create' ? '' : photo.record === 'keep' ? ', record already as planned' : ', record gets the marker'}`)));
    lines.push('', plan.closes.length === 0 ? 'Inbox: no open item is about these photos.' : `Inbox items it closes (${plan.closes.length}):`);
    lines.push(...listed(plan.closes.map((item) => `  ${item.eventId} ${item.sourcePath}: ${item.how === 'placement' ? 'settled by the series, with nothing written to it' : 'dismissed, with your direction as the reason, since its photo moved to other bytes after it opened'}`)));
    if (plan.stays.length > 0) lines.push(`Inbox items that stay open (${plan.stays.length}):`, ...listed(plan.stays.map((item) => `  ${item.eventId} ${item.sourcePath}: ${item.reason}`)));
    if (plan.uncarried.length > 0) {
        lines.push('', `Photos on the site today that can't carry over (${plan.uncarried.length}):`);
        lines.push(...listed(plan.uncarried.map((photo) => `  ${photo.sourcePath} (${photo.photoId}): ${photo.reason}.${photo.allowed ? ' Accepted with --allow-missing.' : ''}`)));
        const accepted = plan.uncarried.filter((photo) => photo.allowed);
        if (accepted.length > 0) lines.push(`Accepted by name with --allow-missing, so ${accepted.length === 1 ? 'it leaves' : 'they leave'} the site at the launch: ${accepted.map((photo) => photo.sourcePath).join(', ')}.`);
    }
    if (plan.notOnSite.length > 0) {
        lines.push('', `In the library but not on the site today, left as they are (${plan.notOnSite.length}):`);
        lines.push(...listed(plan.notOnSite.map((photo) => `  ${photo.sourcePath} (${photo.photoId}): ${photo.reason}.`)));
    }
    if (plan.predicted) {
        const { gone, published, errors } = plan.predicted;
        const accepted = plan.uncarried.filter((photo) => photo.allowed).length;
        const leaving = gone === null ? 'not a launch' : gone > 0 && gone === accepted ? `${gone} leaving the site (GONE_COUNT ${gone}, all accepted by name)` : `${gone} leaving the site (GONE_COUNT ${gone})`;
        lines.push('', `Then photos publish --dry-run: ${plural(published, 'photo')} published, ${leaving}, ${plural(errors.length, 'error')}.`);
        lines.push(...listed(errors.map((issue) => `  ${issue.code} ${issue.record ? `${issue.record.kind} ${issue.record.id}` : ''}: ${issue.message}`)));
    }
    return lines;
}

/** `photos carry-over [--apply] [--allow-missing <photoId or path>,...] [--actor <name>]`. Never throws. */
export async function runCarryOver(layer: LayerHandle, { apply = false, actor = '', allow = [], clock }: { apply?: boolean; actor?: string; allow?: readonly string[]; clock?: () => number } = {}): Promise<CommandResult> {
    const root = path.resolve(layer.dataRoot);
    const status = dataRootStatus({ write: apply, root });
    if (status.state !== 'ready') return { exitCode: 1, output: `Error: The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}. Nothing was written.\n` };
    try {
        if (!apply) {
            const plan = await planCarryOver(root, { allow, clock });
            if (plan.state === 'refused') return { exitCode: 1, output: `${['Refused, and nothing was written:', ...plan.refusals.map((line) => `  ${line}`)].join('\n')}\n` };
            const stop = blockers(plan);
            const head = plan.state === 'done' ? 'The carry-over is already done: running it again changes nothing.' : 'Dry run: nothing was written. photos carry-over --apply --actor <name> writes this.';
            const tail = stop.length > 0 ? ['', ...stop, '--apply refuses until then. --allow-missing <photoId or path>,... accepts the photos above by name.'] : [];
            return { exitCode: stop.length > 0 ? 1 : 0, output: `${[head, '', ...planLines(plan), ...tail].join('\n')}\n` };
        }
        const result = await applyCarryOver(layer, { actor, allow, clock });
        const { plan } = result;
        const lines = [
            result.written.length === 0 && result.dismissed.length === 0 ? 'The carry-over is already done: nothing changed.' : `Carried over: wrote ${plural(result.written.length, 'record')}${result.dismissed.length > 0 ? `, and dismissed ${plural(result.dismissed.length, 'inbox item')}` : ''}.`,
            '',
            ...planLines(plan),
        ];
        if (result.failedDismissals.length > 0) lines.push('', 'These inbox items could not be dismissed, and stay open. The records are written. Run photos carry-over --apply again to try them again:', ...result.failedDismissals.map((item) => `  ${item.eventId}: ${item.message}`));
        lines.push('', 'Nothing is published yet. Next: photos publish --dry-run, then photos publish --confirm-launch.');
        return { exitCode: result.failedDismissals.length > 0 ? 1 : 0, output: `${lines.join('\n')}\n` };
    } catch (error) {
        if (error instanceof CarryOverRefused) {
            const detail = error.plan.state === 'refused' ? [] : ['', ...planLines(error.plan)];
            return { exitCode: 1, output: `${['Refused, and nothing was written:', ...error.reasons.map((line) => `  ${line}`), ...detail].join('\n')}\n` };
        }
        if (error instanceof LockTimeoutError) return { exitCode: 3, output: `Error (locked): ${error.message} Nothing was written.\n` };
        const rest = 'Records written before it stay, and running photos carry-over --apply again finishes the rest.';
        if (error instanceof LockLostError) return { exitCode: 3, output: `Error (LOCK_LOST): ${error.message} ${rest}\n` };
        if (error instanceof AuthoredWriteError) return { exitCode: ['VERSION_CONFLICT', 'AUTHORED_LOCKED', 'LOCK_NOT_HELD'].includes(error.code) ? 3 : 1, output: `Error (${error.code}): ${error.message} ${rest}\n` };
        return { exitCode: 4, output: `Error: ${(error as Error).message}${apply ? ` ${rest}` : ''}\n` };
    }
}
