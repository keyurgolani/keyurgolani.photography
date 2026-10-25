import type { BuildOptions } from '../identity/derivatives';
import type { FactSink } from '../identity/pass';
import { currentProfileId } from '../identity/profile';
import { readRegistry } from '../identity/registry';
import { folderOf } from '../identity/scan';
import { PHOTO_ID_RE } from '../identity/ids';
import type { DerivativeJob, IdentityFact, PhotoRecord, Registry } from '../identity/types';
import { dataRootStatus } from '../storage/config';
import { candidateOf, readUsableEvent, replacementEventIds, type BuildFunction, type OwedSettles } from './candidates';
import {
    CURATION_SCHEMA_VERSION,
    eventIdOf,
    eventKey,
    fingerprintOf,
    type Candidate,
    type CurationDecision,
    type CurationEvent,
} from './events';
import { EventMovedError, EventUnusableError, InvalidEventError, listEvents, withCurationLock, writeEvent } from './repository';
import { SINK_WAIT_MS } from './sink';

/**
 * #17's missing sources and failed builds, on the watcher's side. #14's sink
 * opens a `missing` item when #10 reports a source gone; this module then
 * keeps the inbox in step with #10's registry on every pass:
 *
 * - A missing item closes as `resolved` once its photo's source is present
 *   again. The same bytes back at any path, after a delete and a later copy
 *   or while the watcher was stopped, rebind the photo through #10's rows, so
 *   this is the same-content close. Other bytes come back only through the
 *   curator's `bind`, after which #10 reports `replaced` and the photo's
 *   replacement item reviews them. An item the watcher closed, here or in
 *   #14's sink, whose source goes missing again opens again, whether or not
 *   anything shows the photo.
 * - A `new` item closes once a `bind` merged its photo into the missing one.
 * - A `new` item closes once its photo is archived, approved or not.
 * - A build #10's worker left failed, after its retry at start, gets a
 *   `processing-failure` item, unless a replacement item already carries it.
 *   It closes once the set builds, as after #14's retry, or once the photo
 *   moves on to other bytes or is retired.
 *
 * The sink's first delivery, at the watcher's start, looks at every item
 * once, which recovers what a crash left unsettled. Each later one reads
 * the registry once and settles only the photos the pass's facts name, the
 * photos whose settle after a build failed, and the photos retired since
 * the last delivery, since an archive or a merge #10 applies names no fact
 * of its own.
 *
 * Nothing here deletes, archives, unpublishes, or writes anything outside
 * `curation/`. It reads the registry without its lock and takes only the
 * curation lock, so the lock order stays `registry` then `curation`, and it
 * looks first without the lock, so an unchanged pass writes nothing.
 */

type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

const STILL_OPEN = new Set(['open', 'deferred', 'failed']);

/** Failures a build item is opened for. `superseded` is the source moving on, and `undecodable` has #14's own item. */
const ITEM_FAILURES = new Set(['build', 'integrity']);

/** The watcher input of a failed build's item, in the shape of #10's fact keys. */
export function failureKeyOf(photoId: string, assetRevision: string): string {
    return `build-failed:${photoId}:${assetRevision}`;
}

/** The item for a failed build of a photo's revision. */
export function failureEventId(photoId: string, assetRevision: string): string {
    return eventIdOf(eventKey('processing-failure', { photoId, assetRevision, key: failureKeyOf(photoId, assetRevision) }));
}

function isFailureItem(event: CurationEvent): boolean {
    return event.type === 'processing-failure' && event.photoId !== null && event.assetRevision !== null
        && event.key === eventKey('processing-failure', { photoId: event.photoId, assetRevision: event.assetRevision, key: failureKeyOf(event.photoId, event.assetRevision) });
}

const isRetired = (photo: PhotoRecord) => photo.sourceHealth === 'archived' || photo.mergedInto !== undefined;
const isPresent = (photo: PhotoRecord) => !isRetired(photo) && photo.sourceHealth === 'present' && photo.source.present;
const photoOf = (registry: Registry, photoId: string | null) => (photoId !== null && Object.hasOwn(registry.photos, photoId) ? registry.photos[photoId] : undefined);

function watcherDecision(action: CurationDecision['action'], at: string, reason: string): CurationDecision {
    return { action, at, by: 'watcher', baseRevisionId: null, reason };
}

const withDecision = (event: CurationEvent, decision: CurationDecision, extra: Partial<CurationEvent>): CurationEvent => ({
    ...event,
    ...extra,
    decisions: [...event.decisions, decision],
});

/**
 * A missing item with the registry's news, or null when nothing changes:
 * resolved once the photo is present again, and open again once the source
 * of an item the watcher closed is missing again with the revision the item
 * names. #14's sink reopens one only while something shows the photo.
 */
export function missingChange(event: CurationEvent, registry: Registry, at: string): CurationEvent | null {
    if (event.type !== 'missing') return null;
    const photo = photoOf(registry, event.photoId);
    if (!photo) return null;
    if (STILL_OPEN.has(event.status) && isPresent(photo)) {
        const where = photo.source.path === event.derivedFacts.sourcePath ? 'at its path' : `at ${photo.source.path}`;
        const reason = photo.source.observedRevision === event.assetRevision
            ? `The source is back ${where} with the same bytes, so nothing changed.`
            : `The source is back ${where} with other bytes, which its replacement item reviews.`;
        return withDecision(event, watcherDecision('close', at, reason), { status: 'resolved' });
    }
    // Closed by the watcher: resolved here, or dismissed by #14's sink when the same bytes came back at the same path.
    const last = event.decisions.at(-1);
    const closedByWatcher = last?.by === 'watcher'
        && ((event.status === 'resolved' && last.action === 'close') || (event.status === 'dismissed' && last.action === 'dismiss'));
    if (closedByWatcher && photo.sourceHealth === 'missing' && photo.source.observedRevision === event.assetRevision) {
        return withDecision(event, watcherDecision('reopen', at, 'The source went missing again.'), { status: 'open' });
    }
    return null;
}

/** A `new` item whose photo a `bind` merged into another, resolved, or null. */
export function mergedChange(event: CurationEvent, registry: Registry, at: string): CurationEvent | null {
    if (event.type !== 'new' || !STILL_OPEN.has(event.status)) return null;
    const into = photoOf(registry, event.photoId)?.mergedInto;
    if (into === undefined) return null;
    return withDecision(event, watcherDecision('close', at, `A bind gave these bytes to ${into}, whose replacement item reviews them.`), { status: 'resolved' });
}

/**
 * A `new` item whose photo is archived, resolved, or null. It closes open,
 * deferred, failed, or approved, since an archived photo has nothing left to
 * judge or place: without this, the takedown's publish would leave its item
 * asking for judgment, or flagged as an approval no longer placed with advice
 * to approve it again, which #10 refuses for an archived photo. Reopening it
 * works as for any resolved item.
 */
export function archivedChange(event: CurationEvent, registry: Registry, at: string): CurationEvent | null {
    if (event.type !== 'new' || !(STILL_OPEN.has(event.status) || event.status === 'approved')) return null;
    const photo = photoOf(registry, event.photoId);
    if (photo?.sourceHealth !== 'archived' || photo.mergedInto !== undefined) return null;
    return withDecision(event, watcherDecision('close', at, 'The photograph is archived.'), { status: 'resolved' });
}

const sameFailure = (a: Candidate | undefined, b: Candidate) => a?.state === b.state && a.profileId === b.profileId && a.failure === b.failure;

/**
 * A failed build's item for `photo`'s observed revision, given what the
 * listing holds: a new one, an update, or null. `existing` is the item, if
 * there is one, and `covered` says a replacement item carries the revision.
 */
export function failureChange(photo: PhotoRecord, registry: Registry, existing: CurationEvent | null, covered: boolean, at: string, profileId: string): CurationEvent | null {
    const assetRevision = photo.source.observedRevision;
    const view = candidateOf(registry, photo.photoId, assetRevision, profileId);
    if (view.state === 'failed' && ITEM_FAILURES.has(view.failure) && !isRetired(photo) && !covered) {
        const candidate: Candidate = { state: 'failed', profileId: view.profileId, failure: view.failure, at };
        if (existing === null) {
            const key = eventKey('processing-failure', { photoId: photo.photoId, assetRevision, key: failureKeyOf(photo.photoId, assetRevision) });
            const revision = photo.revisions[assetRevision];
            return {
                schemaVersion: CURATION_SCHEMA_VERSION,
                version: 1,
                id: eventIdOf(key),
                key,
                type: 'processing-failure',
                photoId: photo.photoId,
                sourceFingerprint: fingerprintOf(assetRevision),
                assetRevision,
                observedAt: at,
                lastObservedAt: at,
                factIds: [],
                status: 'failed',
                derivedFacts: {
                    factType: 'processing-failed',
                    sourcePath: photo.source.path,
                    folder: folderOf(photo.source.path),
                    // Only #10's public tier, as #14's sink keeps it.
                    ...(revision ? { capturedDate: revision.derived.capturedDate?.value ?? null, width: revision.width, height: revision.height, sourceFormat: revision.sourceFormat } : {}),
                },
                suggestions: { series: null, placement: null },
                edits: null,
                candidate,
                decisions: [],
                reviewedAt: null,
                reviewedBy: null,
            };
        }
        if (STILL_OPEN.has(existing.status)) {
            return sameFailure(existing.candidate, candidate) ? null : { ...existing, candidate, lastObservedAt: at };
        }
        if (existing.status === 'resolved') {
            return withDecision(existing, watcherDecision('reopen', at, 'Its derivative set failed again.'), { status: 'failed', candidate, lastObservedAt: at });
        }
        return null;
    }
    if (view.state === 'ready' && existing !== null && STILL_OPEN.has(existing.status)) {
        return withDecision(existing, watcherDecision('close', at, `Its derivative set built under ${view.profileId}.`), {
            status: 'resolved',
            candidate: { state: 'ready', profileId: view.profileId, at },
        });
    }
    return null;
}

/** A failed build's item whose photo moved on to other bytes, or was retired, resolved, or null. */
export function staleFailureChange(event: CurationEvent, registry: Registry, at: string): CurationEvent | null {
    if (!isFailureItem(event) || !STILL_OPEN.has(event.status)) return null;
    const photo = photoOf(registry, event.photoId);
    if (photo && !isRetired(photo) && photo.source.observedRevision === event.assetRevision) return null;
    const reason = !photo ? 'The registry no longer holds the photograph.' : isRetired(photo) ? 'The photograph is archived.' : 'The source holds other bytes now, which the photograph\'s newer items cover.';
    return withDecision(event, watcherDecision('close', at, reason), { status: 'resolved' });
}

export interface SourcesOptions {
    /** Settle only these photos' items, as after a build or for a pass's facts. Otherwise every item. */
    only?: Pick<DerivativeJob, 'photoId'> | readonly string[];
    clock?: () => number;
    logger?: Logger;
    /** How long to wait for the curation lock. A busy lock throws LockTimeoutError, and nothing is written. */
    waitMs?: number;
    /** #10's current profile. Defaults to currentProfileId(). */
    profileId?: string;
    /** The registry as the caller just read it, for the first look. Under the lock it is read again. */
    registry?: Registry;
}

export interface SourcesResult {
    /** Item IDs closed as resolved. */
    resolved: string[];
    /** Item IDs opened again. */
    reopened: string[];
    /** Failed-build item IDs opened. */
    failed: string[];
    /** Failed-build item IDs whose failure changed. */
    updated: string[];
}

/** Every change the registry calls for, against one listing, which holds only `only`'s items when it is set. Pure. */
function changesFor(events: readonly CurationEvent[], registry: Registry, at: string, profileId: string, only?: readonly string[]): CurationEvent[] {
    const byId = new Map(events.map((event) => [event.id, event]));
    const changes: CurationEvent[] = [];
    for (const event of events) {
        const next = missingChange(event, registry, at) ?? mergedChange(event, registry, at) ?? archivedChange(event, registry, at) ?? staleFailureChange(event, registry, at);
        if (next) changes.push(next);
    }
    const photos = only === undefined ? Object.values(registry.photos) : only.map((photoId) => photoOf(registry, photoId)).filter((photo): photo is PhotoRecord => photo !== undefined);
    for (const photo of photos) {
        if (isRetired(photo)) continue;
        const revision = photo.source.observedRevision;
        const covered = replacementEventIds(photo.photoId, revision).some((id) => byId.has(id));
        const next = failureChange(photo, registry, byId.get(failureEventId(photo.photoId, revision)) ?? null, covered, at, profileId);
        if (next) changes.push(next);
    }
    return changes;
}

/** The items this module settles for one photo: per revision, its missing, new, and failed-build items, and the observed revision's replacement items. */
function itemIdsOf(photo: PhotoRecord): string[] {
    const { photoId } = photo;
    const perRevision = Object.keys(photo.revisions).flatMap((assetRevision) => [
        eventIdOf(eventKey('missing', { photoId, assetRevision, key: `missing:${photoId}:${assetRevision}` })),
        eventIdOf(eventKey('new', { photoId, assetRevision, key: `new:${photoId}:${assetRevision}` })),
        failureEventId(photoId, assetRevision),
    ]);
    return [...perRevision, failureEventId(photoId, photo.source.observedRevision), ...replacementEventIds(photoId, photo.source.observedRevision)];
}

/** The items `only`'s photos could need, read one by one, or every item. Damaged ones are left out, as #14's sink leaves them. */
async function eventsFor(root: string, registry: Registry, only: readonly string[] | undefined): Promise<CurationEvent[]> {
    if (only === undefined) return (await listEvents(root)).events;
    const ids = new Set(only.flatMap((photoId) => {
        const photo = photoOf(registry, photoId);
        return photo ? itemIdsOf(photo) : [];
    }));
    const found: CurationEvent[] = [];
    for (const id of ids) {
        const event = await readUsableEvent(root, id);
        if (event) found.push(event);
    }
    return found;
}

/**
 * Bring missing and failed-build items in step with #10's registry. It looks
 * without the curation lock and takes it only when an item needs a write.
 * Under the lock it reads the registry and the items again and writes each
 * with compare-and-swap, a new item only if none exists. A damaged item is
 * skipped, as #14's sink skips one. I/O errors and a busy lock are thrown.
 */
export async function settleSources(root: string, options: SourcesOptions = {}): Promise<SourcesResult> {
    const { clock = Date.now, logger = console, waitMs = SINK_WAIT_MS } = options;
    const profileId = options.profileId ?? currentProfileId();
    const only = options.only === undefined ? undefined : 'photoId' in options.only ? [options.only.photoId] : [...new Set(options.only as readonly string[])];
    const result: SourcesResult = { resolved: [], reopened: [], failed: [], updated: [] };
    if (only !== undefined && only.length === 0) return result;
    const at = () => new Date(clock()).toISOString();

    const looked = options.registry ?? await readRegistry(root);
    const due = changesFor(await eventsFor(root, looked, only), looked, at(), profileId, only);
    if (due.length === 0) return result;

    await withCurationLock(root, { waitMs }, async (hold) => {
        const registry = await readRegistry(root);
        const current = await eventsFor(root, registry, only);
        const byId = new Map(current.map((event) => [event.id, event]));
        const wanted = new Set(due.map((event) => event.id));
        for (const next of changesFor(current, registry, at(), profileId, only)) {
            if (!wanted.has(next.id)) continue;
            const before = byId.get(next.id) ?? null;
            hold.signal.throwIfAborted();
            try {
                await writeEvent(root, next, before?.version ?? 0, hold);
            } catch (error) {
                // Only a writer past its lease gets between the read and the write. The next pass looks again.
                if (error instanceof EventMovedError) continue;
                if (error instanceof InvalidEventError || (error instanceof EventUnusableError && error.problem.reason !== 'unreadable')) {
                    logger.error(`[curation] Could not update ${next.id}: ${error.message}`);
                    continue;
                }
                throw error;
            }
            if (before === null) result.failed.push(next.id);
            else if (next.status === 'resolved' && before.status !== 'resolved') result.resolved.push(next.id);
            else if (next.status !== before.status) result.reopened.push(next.id);
            else result.updated.push(next.id);
        }
    });
    const total = result.resolved.length + result.reopened.length + result.failed.length + result.updated.length;
    if (total > 0) {
        logger.log(`[curation] Sources: ${result.resolved.length} resolved, ${result.reopened.length} reopened, ${result.failed.length} failed builds opened, ${result.updated.length} updated.`);
    }
    return result;
}

export interface SourcesSinkOptions extends Omit<SourcesOptions, 'only' | 'registry'> {
    /** Defaults to the data root at each delivery. */
    root?: string;
    /**
     * The photos whose settle after a build failed, shared between the sink
     * and recordingFailuresAfterBuild(), as 17-1's candidate sink shares its
     * own. The sink settles them on its next delivery.
     */
    owed?: OwedSettles;
}

function readyRoot(root: string | undefined): string {
    const status = dataRootStatus({ versioned: true, ...(root === undefined ? {} : { root }) });
    if (status.state !== 'ready' || status.root === null) throw new Error(`The data root is ${status.state}, so the curation inbox can't be written.`);
    return status.root;
}

/** The photos a pass's facts name, each once. A fact without a well-formed photo ID is left out. */
export function namedPhotos(facts: readonly IdentityFact[]): string[] {
    return [...new Set(facts.flatMap((fact) => (typeof fact.photoId === 'string' && PHOTO_ID_RE.test(fact.photoId) ? [fact.photoId] : [])))];
}

const retiredIn = (registry: Registry) => new Set(Object.values(registry.photos).filter(isRetired).map((photo) => photo.photoId));

/**
 * A fact sink that runs after #14's sink has opened the pass's items. Its
 * first delivery settles every item, which recovers what a crash left
 * unsettled. Each later one reads the registry once and settles only the
 * photos the facts name, those `owed` holds, whose settle after a build
 * failed, and those retired since the last delivery that succeeded, since
 * #10 applies an archive, or retires a merged photo, without a fact for it.
 * The pass delivers its pending facts until every sink has them, so a
 * delivery that failed names them again, and an owed photo stays owed until
 * a delivery settles it. Like #14's sink, an I/O or lock error fails the
 * delivery.
 */
export function createSourcesSink(options: SourcesSinkOptions = {}): FactSink {
    const { root, owed, ...rest } = options;
    let retired: Set<string> | null = null;
    return async (facts) => {
        const at = readyRoot(root);
        const registry = await readRegistry(at);
        const now = retiredIn(registry);
        const known = retired;
        const taken = owed?.take();
        if (known === null) await settleSources(at, { ...rest, registry });
        else {
            const owedPhotos = (taken?.refs ?? []).map((ref) => ref.photoId);
            await settleSources(at, { ...rest, registry, only: [...namedPhotos(facts), ...owedPhotos, ...[...now].filter((photoId) => !known.has(photoId))] });
        }
        taken?.settled();
        retired = now;
    };
}

/**
 * `build`, then settle the built photo's failed-build item, for #10's
 * worker, so a failure that stays shows without waiting for the next pass.
 * A build that throws settles nothing, and a settle that fails is logged and
 * added to `owed`, so the sources sink settles it on its next delivery, the
 * next pass's. When the process ends first, as `--once` can, or
 * with no `owed`, the watcher's next start does, since its first delivery
 * looks at every item. Neither ever
 * changes the build's outcome.
 */
export function recordingFailuresAfterBuild(build: BuildFunction, options: Omit<SourcesSinkOptions, 'root'> = {}): BuildFunction {
    const { logger = console, owed, ...settleOptions } = options;
    return async (job: DerivativeJob, buildOptions: BuildOptions) => {
        const outcome = await build(job, buildOptions);
        if (outcome.status !== 'ready' && outcome.status !== 'failed') return outcome;
        try {
            await settleSources(readyRoot(buildOptions.root), { ...settleOptions, logger, only: job });
        } catch (error) {
            owed?.add(job);
            const when = owed ? "the next pass settles it, or the watcher's next start if this process ends first, as --once can" : "the watcher's next start settles it";
            logger.warn(`[curation] Could not record the build of ${job.photoId} ${job.assetRevision} in the inbox yet; ${when}: ${error instanceof Error ? error.message : String(error)}`);
        }
        return outcome;
    };
}
