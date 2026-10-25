import { mintPhotoId } from './ids';
import type { ImageInspection, Inspection } from './inspect';
import { folderOf, isUnder, keyOf, type LibraryScan, type ScanEntry } from './scan';
import type { DecisionFile, DecisionOutcome, IdentityDecision } from './decisions';
import type { AssetRevisionRecord, DerivativeJob, Hold, IdentityFact, PhotoRecord, ProfileEntry, Registry, SourceHealth } from './types';

/** A file changed this recently waits for the next pass. */
export const STABILITY_MS = 5_000;

/**
 * Whether a file changed within STABILITY_MS of `observedAt`, either way, so
 * it may still be being written or moved. Each timestamp counts on its own: a
 * rename or copy changes only the ctime, and a copy that keeps its source's
 * mtime can bring one from any time, even the future, which must not hide a
 * ctime from a moment ago.
 */
export function isStillChanging(entry: Pick<ScanEntry, 'mtimeMs' | 'ctimeMs'>, observedAt: number): boolean {
    return Math.abs(observedAt - entry.mtimeMs) < STABILITY_MS || Math.abs(observedAt - entry.ctimeMs) < STABILITY_MS;
}

/** A fact before it is committed. The pass that commits it mints its factId. */
export type FactDraft = Omit<IdentityFact, 'factId'>;

export interface ReconcileContext {
    /** UUID v4 source for new photo IDs. */
    idGen: () => string;
    /** The derivative profile new revisions are queued for. */
    profileId: string;
    /** Identity decisions to apply before classifying, in order. */
    decisions?: readonly DecisionFile[];
}

/** What a pass saw but couldn't classify, for logs and the migration report. */
export interface ReconcileReport {
    unstable: string[];
    unreadable: string[];
    unsupported: string[];
    collisions: string[];
    undecodable: string[];
    /** Groups of present paths that differ only by case or Unicode form. */
    keyCollisions: string[][];
    /** True when a just-changed file deferred every `missing` transition. */
    missingDeferred: boolean;
}

export interface ReconcileResult {
    registry: Registry;
    facts: FactDraft[];
    jobs: DerivativeJob[];
    report: ReconcileReport;
    /** Set when a file was too fresh to classify, so the caller should run another pass after this long. */
    retryAfterMs: number | null;
    /** What became of each decision, in order. */
    decisions: DecisionOutcome[];
}

/** A decision's result before it is tied to its file. */
type Decided = { status: 'applied'; detail: string } | { status: 'rejected'; reason: string } | { status: 'deferred'; reason: string };

/** The inspection of a scanned file, or undefined if it wasn't read this pass. */
export type InspectLookup = (entry: ScanEntry) => Inspection | undefined;

type SeenState = 'image' | 'unstable' | 'unreadable' | 'collision';

interface Seen {
    entry: ScanEntry;
    state: SeenState;
    inspection?: ImageInspection;
}

interface ImageSeen extends Seen {
    state: 'image';
    inspection: ImageInspection;
}

function isImage(seen: Seen): seen is ImageSeen {
    return seen.state === 'image' && seen.inspection !== undefined;
}

function byPath<T extends { path: string }>(a: T, b: T): number {
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
    const set = map.get(key);
    if (set) set.add(value);
    else map.set(key, new Set([value]));
}

/**
 * Classify one library snapshot against the registry, following the rows of
 * the identity table in order over the whole snapshot. Pure: it reads files
 * only through `inspect`, mints IDs only through `context.idGen`, and returns
 * the next registry, the facts to commit, and the derivative jobs to queue.
 *
 * Bound paths are classified first (rows 1 to 6) against the registry as it
 * was before the pass, then unbound paths (rows 7 to 12) against the state
 * those rows left, then sources that vanished (row 13). Row 14, a digest that
 * matches a revision of a different size, is checked before everything.
 * Ambiguous evidence binds and merges nothing: it becomes a hold, which ends
 * only with a decision, a byte change at the held path, or the path vanishing.
 * A hold on paths that differ only by case or Unicode form also ends once one
 * of them is left, and that one is classified as a plain rename would be.
 *
 * Two departures from the table. A photo whose bound path holds another
 * photo's bytes (row 6) may have moved, so rows 7 and 9 count it as
 * sourceless, in the pass that finds it and for as long as the hold on that
 * path lasts. Once rows 7 or 10 rebind it, the hold on its old path ends and
 * that path is classified as an unbound one, so a renumbered series, such as
 * `mv 3 4; mv 2 3; mv 1 2`, resolves as renames. And a file with the bytes or
 * pixels of a photo whose bound path is still changing may be that photo
 * moving, so rows 8, 11, and 12 make no new photo of it until that path
 * settles, which a series renumbered while a pass runs needs.
 */
export function reconcile(scan: LibraryScan, registry: Registry, inspect: InspectLookup, context: ReconcileContext): ReconcileResult {
    const now = new Date(scan.observedAt).toISOString();
    const next = structuredClone(registry);
    next.updatedAt = now;
    const photos = next.photos;
    const originalIds = Object.keys(photos).sort();
    const previousHealth = new Map<string, SourceHealth>(originalIds.map((id) => [id, photos[id].sourceHealth]));
    const facts: FactDraft[] = [];
    const jobs: DerivativeJob[] = [];
    const report: ReconcileReport = {
        unstable: [], unreadable: [], unsupported: [], collisions: [], undecodable: [], keyCollisions: [], missingDeferred: false,
    };

    const isRetired = (photo: PhotoRecord) => photo.sourceHealth === 'archived' || photo.mergedInto !== undefined;

    function fact(draft: Omit<FactDraft, 'key' | 'folder' | 'observedAt'>): void {
        const { type, photoId, assetRevision, path, ...extra } = draft;
        facts.push({
            type,
            key: `${type}:${photoId ?? assetRevision}:${assetRevision}`,
            photoId,
            assetRevision,
            path,
            folder: folderOf(path),
            observedAt: now,
            ...extra,
        });
    }

    /** Present, non-retired photos by the key of their bound path. The first of `ids` wins a key two of them share. */
    function boundKeys(ids: readonly string[]): Map<string, string> {
        const bound = new Map<string, string>();
        for (const id of ids) {
            const photo = photos[id];
            if (photo.source.present && !isRetired(photo) && !bound.has(photo.source.key)) bound.set(photo.source.key, id);
        }
        return bound;
    }
    const boundBefore = boundKeys(originalIds);

    // 1. Observe every scanned file. Fresh, changing, and unreadable files are not classified.
    const seen: Seen[] = [];
    for (const entry of scan.entries) {
        const inspection = isStillChanging(entry, scan.observedAt) ? undefined : inspect(entry);
        if (entry.kind === 'unsupported') {
            if (!inspection || inspection.kind === 'changed') report.unstable.push(entry.path);
            else if (inspection.kind === 'unreadable') report.unreadable.push(entry.path);
            else if (inspection.kind === 'unsupported') {
                report.unsupported.push(entry.path);
                fact({ type: 'processing-failed', photoId: null, assetRevision: inspection.assetRevision, path: entry.path, reason: 'unsupported-format' });
            }
            continue;
        }
        if (!inspection || inspection.kind === 'changed') {
            seen.push({ entry, state: 'unstable' });
            report.unstable.push(entry.path);
        } else if (inspection.kind === 'image') {
            seen.push({ entry, state: 'image', inspection });
        } else {
            seen.push({ entry, state: 'unreadable' });
            report.unreadable.push(entry.path);
        }
    }

    // 14 (first). A digest that matches a revision of another size is a collision. Skip the file until its bytes change.
    const knownSizes = new Map<string, Set<number>>();
    for (const photo of Object.values(photos)) {
        for (const revision of Object.values(photo.revisions)) addTo(knownSizes, revision.assetRevision, revision.sourceBytes);
    }
    const snapshotSizes = new Map<string, Set<number>>();
    for (const item of seen) if (isImage(item)) addTo(snapshotSizes, item.inspection.assetRevision, item.inspection.sourceBytes);
    for (const item of seen) {
        if (!isImage(item)) continue;
        const { assetRevision, sourceBytes } = item.inspection;
        const known = knownSizes.get(assetRevision);
        const collides = known ? !known.has(sourceBytes) : (snapshotSizes.get(assetRevision)?.size ?? 0) > 1;
        if (!collides) continue;
        (item as Seen).state = 'collision';
        report.collisions.push(item.entry.path);
        fact({
            type: 'processing-failed',
            photoId: boundBefore.get(item.entry.key) ?? null,
            assetRevision,
            path: item.entry.path,
            reason: 'digest-collision',
        });
    }

    const byKey = new Map<string, Seen[]>();
    for (const item of seen) {
        const group = byKey.get(item.entry.key);
        if (group) group.push(item);
        else byKey.set(item.entry.key, [item]);
    }
    const underUnreadableDir = (relativePath: string) => scan.unreadableDirs.some((dir) => isUnder(relativePath, dir));

    const decided = {
        applied: (detail: string): Decided => ({ status: 'applied', detail }),
        rejected: (reason: string): Decided => ({ status: 'rejected', reason }),
        deferred: (reason: string): Decided => ({ status: 'deferred', reason }),
    };

    // Decisions, in file order, each against the state the ones before it left. They run before the
    // rows, which then find a path a decision bound already holding its photo's observed revision.
    const liveHolds: Hold[] = registry.holds.map((held) => ({ ...held, candidates: [...held.candidates] }));
    const decisionOutcomes: DecisionOutcome[] = [];
    for (const file of context.decisions ?? []) {
        // A file that can't be read right now waits: rejecting it would replace it with a record of nothing.
        const outcome: Decided = file.decision
            ? decide(file.decision)
            : file.raw === null
                ? decided.deferred(file.invalid ?? "it can't be read")
                : decided.rejected(file.invalid ?? 'it is not a valid decision');
        decisionOutcomes.push({ name: file.name, decisionId: file.decision?.decisionId ?? null, ...outcome });
    }
    // Decisions can move bindings, so the rows below start from what they left.
    const ids = Object.keys(photos).sort();
    const boundByKey = boundKeys(ids);

    const nextHolds = new Map<string, Hold>();
    const newHolds = new Set<string>();

    function hold(item: ImageSeen, candidates: string[], keyCollision = false): void {
        const existing = nextHolds.get(item.entry.path);
        if (existing) {
            existing.candidates = [...new Set([...existing.candidates, ...candidates])].sort();
            return;
        }
        nextHolds.set(item.entry.path, {
            path: item.entry.path,
            assetRevision: item.inspection.assetRevision,
            candidates: [...new Set(candidates)].sort(),
            since: now,
            ...(keyCollision ? { keyCollision: true as const } : {}),
        });
        newHolds.add(item.entry.path);
    }

    // Keys two or more present paths share. A key-collision hold whose folder can't be listed right now
    // counts as one of them, since its file may still be there.
    const collidingKeys = new Set([...byKey].filter(([, group]) => group.length > 1).map(([key]) => key));
    for (const existing of liveHolds) {
        if (existing.keyCollision === true && underUnreadableDir(existing.path)) collidingKeys.add(keyOf(existing.path));
    }

    // Existing holds persist while their path holds the same bytes, or can't be read right now.
    for (const existing of liveHolds) {
        const group = byKey.get(keyOf(existing.path)) ?? [];
        if (existing.keyCollision === true) {
            // A key-collision hold also lasts only as long as the collision, and stays at its own path. Once the
            // key has one path again, that path is classified afresh below, as a plain rename would be.
            const own = group.find((item) => item.entry.path === existing.path);
            const lasts = own
                ? collidingKeys.has(own.entry.key) && (!isImage(own) || own.inspection.assetRevision === existing.assetRevision)
                : underUnreadableDir(existing.path);
            if (lasts) nextHolds.set(existing.path, { ...existing });
            continue;
        }
        const match = group.find((item) => item.entry.path === existing.path) ?? (group.length === 1 ? group[0] : undefined);
        if (!match) {
            if (underUnreadableDir(existing.path)) nextHolds.set(existing.path, { ...existing });
            continue; // The held path vanished. Its candidates are reclassified below.
        }
        if (!isImage(match) || match.inspection.assetRevision === existing.assetRevision) {
            nextHolds.set(match.entry.path, { ...existing, path: match.entry.path });
        }
        // A byte change ends the hold, and the path is classified afresh below.
    }

    // Two present files that differ only by case or Unicode form are ambiguous.
    const inKeyCollision = new Set<string>();
    for (const [key, group] of byKey) {
        if (!collidingKeys.has(key)) continue;
        if (group.length > 1) report.keyCollisions.push(group.map((item) => item.entry.path));
        const bound = boundByKey.get(key);
        for (const item of group) {
            inKeyCollision.add(item.entry.path);
            if (!nextHolds.has(item.entry.path) && isImage(item)) hold(item, bound ? [bound] : [], true);
        }
    }

    const isHeld = (item: Seen) => nextHolds.has(item.entry.path);
    const unboundAtStart = seen.filter((item): item is ImageSeen =>
        isImage(item) && !boundByKey.has(item.entry.key) && !isHeld(item) && !inKeyCollision.has(item.entry.path));

    // Owners of each revision before the rows run. "Belongs" ignores reassigned revisions.
    const ownersBefore = new Map<string, Set<string>>();
    for (const id of ids) {
        for (const revision of Object.values(photos[id].revisions)) {
            if (!revision.reassignedTo) addTo(ownersBefore, revision.assetRevision, id);
        }
    }

    function queue(photo: PhotoRecord, assetRevision: string, at: string): void {
        jobs.push({ photoId: photo.photoId, assetRevision, profileId: context.profileId, path: at });
    }

    /** A revision becomes current again (a revert): requeue it if it was waiting, or if it was superseded. */
    function requeueIfNeeded(photo: PhotoRecord, assetRevision: string, at: string): void {
        const profile = photo.revisions[assetRevision].profiles[context.profileId];
        if (!profile) return; // Older profiles stay as they are. A new profile applies only to revisions first seen after it.
        if (profile.state === 'failed' && profile.error === 'source-superseded') {
            photo.revisions[assetRevision].profiles[context.profileId] = { state: 'pending', attempts: 0 };
            queue(photo, assetRevision, at);
        } else if (profile.state === 'pending') {
            queue(photo, assetRevision, at);
        }
    }

    function bindTo(photo: PhotoRecord, item: ImageSeen, assetRevision: string): void {
        photo.source = { path: item.entry.path, key: item.entry.key, present: true, observedRevision: assetRevision, lastSeenAt: now };
    }

    function addRevision(photo: PhotoRecord, item: ImageSeen): void {
        const inspection = item.inspection;
        const undecodable = inspection.pixelDigest === null;
        const record: AssetRevisionRecord = {
            assetRevision: inspection.assetRevision,
            pixelDigest: inspection.pixelDigest,
            firstSeenAt: now,
            firstSeenPath: item.entry.path,
            sourceBytes: inspection.sourceBytes,
            sourceFormat: inspection.sourceFormat,
            width: inspection.width,
            height: inspection.height,
            orientation: inspection.orientation,
            derived: structuredClone(inspection.derived),
            curatorOnly: structuredClone(inspection.curatorOnly),
            profiles: {
                [context.profileId]: undecodable ? { state: 'failed', attempts: 0, error: 'undecodable' } : { state: 'pending', attempts: 0 },
            },
        };
        photo.revisions[inspection.assetRevision] = record;
        bindTo(photo, item, inspection.assetRevision);
        if (undecodable) {
            report.undecodable.push(item.entry.path);
            fact({ type: 'processing-failed', photoId: photo.photoId, assetRevision: inspection.assetRevision, path: item.entry.path, reason: 'undecodable' });
        } else {
            queue(photo, inspection.assetRevision, item.entry.path);
        }
    }

    /** The current profile's first entry for a revision another photo gives up: built afresh under its new photo. */
    function freshProfile(revision: AssetRevisionRecord): ProfileEntry {
        return revision.pixelDigest === null ? { state: 'failed', attempts: 0, error: 'undecodable' } : { state: 'pending', attempts: 0 };
    }

    /**
     * Give `photo` a copy of `revision`, which another photo gives up, with a
     * fresh profile entry. A revision coming back to the photo it was taken
     * from, as when a bind undoes a `new`, gets that photo's own record back,
     * profiles and all, instead of staying marked as given away.
     */
    function adoptRevision(photo: PhotoRecord, revision: AssetRevisionRecord, from: PhotoRecord): 'copied' | 'restored' {
        const earlier = photo.revisions[revision.assetRevision];
        if (earlier) delete earlier.reassignedTo;
        else photo.revisions[revision.assetRevision] = { ...structuredClone(revision), profiles: { [context.profileId]: freshProfile(revision) } };
        revision.reassignedTo = photo.photoId;
        if (from.source.observedRevision === revision.assetRevision) {
            const own = Object.values(from.revisions).filter((candidate) => !candidate.reassignedTo);
            const latest = own.sort((a, b) => (a.firstSeenAt < b.firstSeenAt ? 1 : a.firstSeenAt > b.firstSeenAt ? -1 : 0))[0];
            if (latest) from.source.observedRevision = latest.assetRevision;
        }
        return earlier ? 'restored' : 'copied';
    }

    /** The present, non-retired photo bound to `key`, in the order the rows use. */
    function boundAt(key: string): PhotoRecord | undefined {
        const id = Object.keys(photos).sort().find((candidate) => {
            const photo = photos[candidate];
            return photo.source.present && !isRetired(photo) && photo.source.key === key;
        });
        return id === undefined ? undefined : photos[id];
    }

    function endHold(heldPath: string): void {
        const index = liveHolds.findIndex((held) => held.path === heldPath);
        if (index >= 0) liveHolds.splice(index, 1);
    }

    /**
     * Take a photo a decision settled out of every hold. A hold left with no
     * candidate ends, so its path is classified afresh below. A key-collision
     * hold stays, since it lasts as long as the collision does.
     */
    function leaveHolds(photoId: string): void {
        for (let index = liveHolds.length - 1; index >= 0; index--) {
            const held = liveHolds[index];
            held.candidates = held.candidates.filter((candidate) => candidate !== photoId);
            if (held.candidates.length === 0 && held.keyCollision !== true) liveHolds.splice(index, 1);
        }
    }

    /** The one readable image at `target` this pass, or why a decision about it can't run now. */
    function imageAt(target: string): ImageSeen | Decided {
        const group = byKey.get(keyOf(target)) ?? [];
        if (group.length === 0) {
            return underUnreadableDir(target) ? decided.deferred(`the folder holding ${target} can't be listed right now`) : decided.rejected(`there is no image at ${target}`);
        }
        if (group.length > 1) return decided.rejected(`${group.length} files share the name ${target} apart from case or Unicode form`);
        const [item] = group;
        if (item.state === 'unstable') return decided.deferred(`${item.entry.path} is still changing`);
        if (item.state === 'collision') return decided.rejected(`${item.entry.path} has a digest collision`);
        if (!isImage(item)) return decided.rejected(`${item.entry.path} can't be read`);
        return item;
    }

    /**
     * bind: give a present path to X, a non-archived photo that is sourceless
     * or a hold candidate. New bytes become a replacement revision. Refused if
     * X is present elsewhere, or another present photo N holds the path, with
     * two exceptions. When the decision names N to merge and N was minted
     * there, N's revision moves to X, and N is archived with `mergedInto: X`.
     * When the path's hold lists both N and X, as after one photo's file was
     * moved over another's, N loses the path and is classified like any
     * photo whose path is gone. X leaves every hold it was in. Every refusal
     * comes before anything changes.
     */
    function bind(target: string, photoId: string, merge: string | undefined): Decided {
        const found = imageAt(target);
        if (!('entry' in found)) return found;
        const item = found;
        const x = photos[photoId];
        if (!x) return decided.rejected(`there is no photo ${photoId}`);
        if (isRetired(x)) return decided.rejected(`${photoId} is archived`);
        const { key, path: at } = item.entry;
        const revision = item.inspection.assetRevision;
        const holder = boundAt(key);
        if (holder === x && x.source.observedRevision === revision) {
            endHold(at);
            return decided.applied(`${at} was already bound to ${photoId}`);
        }
        if (holder !== x && x.sourceHealth === 'present' && x.source.present && byKey.has(x.source.key)) {
            return decided.rejected(`${photoId} is present at ${x.source.path}`);
        }
        if (merge !== undefined && holder?.photoId !== merge) {
            return decided.rejected(`the decision merges ${merge}, but ${at} is ${holder ? `bound to ${holder.photoId}` : 'bound to no other photo'}`);
        }
        // What becomes of N, decided before anything changes.
        let plan: { kind: 'unbind'; holder: PhotoRecord } | { kind: 'merge'; holder: PhotoRecord; revision: AssetRevisionRecord } | null = null;
        if (holder && holder !== x) {
            const held = liveHolds.find((candidate) => candidate.path === at);
            if (merge === undefined && held?.candidates.includes(holder.photoId) && held.candidates.includes(photoId)) {
                // The hold already doubts N's claim to the path, so N gives it up and keeps everything else.
                plan = { kind: 'unbind', holder };
            } else {
                if (merge === undefined) return decided.rejected(`${at} is bound to ${holder.photoId}. To merge ${holder.photoId} into ${photoId}, name it with --merge`);
                const own = Object.values(holder.revisions).filter((candidate) => !candidate.reassignedTo);
                if (own.length !== 1 || keyOf(own[0].firstSeenPath) !== key) {
                    return decided.rejected(`${holder.photoId} has more than the one revision first seen at ${at}, so it can't be merged`);
                }
                plan = { kind: 'merge', holder, revision: own[0] };
            }
        }
        // X's record of these bytes, if a `new` gave them to another photo, comes back only with that photo merged.
        const given = x.revisions[revision]?.reassignedTo;
        if (given !== undefined && !(plan?.kind === 'merge' && plan.revision.assetRevision === revision)) {
            return decided.rejected(`${at} holds ${revision}, which ${photoId} gave to ${given}`);
        }

        let copied = false;
        if (plan?.kind === 'unbind') {
            plan.holder.source.present = false;
        } else if (plan?.kind === 'merge') {
            copied = adoptRevision(x, plan.revision, plan.holder) === 'copied' && plan.revision.assetRevision === revision;
            // mergedInto retires it, so it reads as archived from here on.
            plan.holder.mergedInto = x.photoId;
            plan.holder.source.present = false;
        }

        const fromPath = x.source.key === key ? {} : { fromPath: x.source.path };
        const lastRevision = x.source.observedRevision;
        if (x.revisions[revision] && !copied) {
            // X's own bytes, its record back from a merged photo included: its observed revision at a new path, or an older one back.
            bindTo(x, item, revision);
            requeueIfNeeded(x, revision, at);
            if (revision === lastRevision) fact({ type: 'fromPath' in fromPath ? 'renamed' : 'reappeared', photoId, assetRevision: revision, path: at, ...fromPath });
            else fact({ type: 'replaced', photoId, assetRevision: revision, path: at, revert: true, ...fromPath });
        } else if (x.revisions[revision]) {
            // A copy of the merged photo's revision, with a fresh profile entry.
            bindTo(x, item, revision);
            requeueIfNeeded(x, revision, at);
            fact({ type: 'replaced', photoId, assetRevision: revision, path: at, ...fromPath });
        } else {
            addRevision(x, item);
            fact({ type: 'replaced', photoId, assetRevision: revision, path: at, ...fromPath });
        }
        endHold(at);
        leaveHolds(photoId);
        if (plan?.kind === 'merge') return decided.applied(`bound ${at} to ${photoId} and merged ${plan.holder.photoId} into it`);
        return decided.applied(plan?.kind === 'unbind' ? `bound ${at} to ${photoId}, which ${plan.holder.photoId} no longer holds` : `bound ${at} to ${photoId}`);
    }

    /**
     * new: give a held or bound path its own photo, with the ID the decision
     * carries. A revision the path's photo X had there moves to the new photo
     * and is built again under it, and X, without a path now, is classified
     * like any photo whose path is gone.
     */
    function newPhoto(target: string, photoId: string): Decided {
        const found = imageAt(target);
        if (!('entry' in found)) return found;
        const item = found;
        const { key, path: at } = item.entry;
        const existing = photos[photoId];
        if (existing) {
            if (existing.source.present && existing.source.key === key) {
                endHold(at);
                return decided.applied(`${at} already has its own photo ${photoId}`);
            }
            return decided.rejected(`${photoId} is already a photo`);
        }
        const x = boundAt(key);
        if (!x && !liveHolds.some((held) => held.path === at)) {
            return decided.rejected(`${at} is neither held nor bound, so a pass gives it a photo ID by itself`);
        }
        const { assetRevision: revision, pixelDigest } = item.inspection;
        const photo: PhotoRecord = {
            photoId,
            createdAt: now,
            source: { path: at, key, present: true, observedRevision: revision, lastSeenAt: now },
            sourceHealth: 'present',
            duplicateOf: null,
            revisions: {},
        };
        const taken = x?.revisions[revision];
        if (x && taken && !taken.reassignedTo) {
            adoptRevision(photo, taken, x);
            photos[photoId] = photo;
            bindTo(photo, item, revision);
            if (photo.revisions[revision].profiles[context.profileId].state === 'pending') queue(photo, revision, at);
        } else {
            const owners = new Set<string>();
            for (const [id, candidate] of Object.entries(photos)) {
                if (Object.values(candidate.revisions).some((record) => !record.reassignedTo && record.assetRevision === revision)) owners.add(id);
            }
            if (owners.size === 0 && pixelDigest !== null) {
                for (const [id, candidate] of Object.entries(photos)) {
                    if (Object.values(candidate.revisions).some((record) => !record.reassignedTo && record.pixelDigest === pixelDigest)) owners.add(id);
                }
            }
            photo.duplicateOf = owners.size > 0 ? original(owners) : null;
            photos[photoId] = photo;
            addRevision(photo, item);
        }
        if (x) x.source.present = false;
        endHold(at);
        fact({ type: 'new', photoId, assetRevision: revision, path: at, ...(photo.duplicateOf ? { duplicateOf: photo.duplicateOf } : {}) });
        return decided.applied(`gave ${at} its own photo ${photoId}`);
    }

    /** The first path this pass, by path, that holds one of `x`'s revisions or its pixels and that no hold or other photo has. */
    function returnedTo(x: PhotoRecord): string | undefined {
        const own = Object.values(x.revisions).filter((revision) => !revision.reassignedTo);
        const bytes = new Set(own.map((revision) => revision.assetRevision));
        const pixels = new Set(own.flatMap((revision) => (revision.pixelDigest === null ? [] : [revision.pixelDigest])));
        const held = new Set(liveHolds.map((hold) => hold.path));
        const match = seen.find((item) => {
            if (!isImage(item) || held.has(item.entry.path)) return false;
            const holder = boundAt(item.entry.key);
            if (holder !== undefined && holder !== x) return false;
            return bytes.has(item.inspection.assetRevision) || (item.inspection.pixelDigest !== null && pixels.has(item.inspection.pixelDigest));
        });
        return match?.entry.path;
    }

    /** archive: retire a photo whose file is gone, so it stops being reported missing. Everything is kept. */
    function archive(photoId: string): Decided {
        const x = photos[photoId];
        if (!x) return decided.rejected(`there is no photo ${photoId}`);
        if (isRetired(x)) return decided.applied(`${photoId} was already archived`);
        if (x.source.present) {
            if (byKey.has(x.source.key)) return decided.rejected(`${photoId} is present at ${x.source.path}, and archive is for a photo whose file is gone`);
            if (underUnreadableDir(x.source.path)) return decided.deferred(`the folder holding ${x.source.path} can't be listed right now`);
        }
        // Its file back at a path no other photo holds, moved or edited only in its metadata: the rows give the
        // path back to it this pass, which they can't once it is archived, so it would come back as a duplicate.
        const back = returnedTo(x);
        if (back !== undefined) return decided.rejected(`${photoId}'s file is back at ${back}, and archive is for a photo whose file is gone`);
        x.sourceHealth = 'archived';
        x.source.present = false;
        leaveHolds(photoId);
        return decided.applied(`archived ${photoId}`);
    }

    /** retry: put failed entries for the current profile back to pending, but not source-superseded unless the bytes are back. */
    function retryFailed(photoId: string, assetRevision: string | undefined): Decided {
        const x = photos[photoId];
        if (!x) return decided.rejected(`there is no photo ${photoId}`);
        if (isRetired(x)) return decided.rejected(`${photoId} is archived`);
        const own = Object.values(x.revisions).filter((revision) => !revision.reassignedTo);
        const targets = assetRevision === undefined ? own : own.filter((revision) => revision.assetRevision === assetRevision);
        if (assetRevision !== undefined && targets.length === 0) return decided.rejected(`${photoId} has no revision ${assetRevision}`);
        const group = x.source.present ? byKey.get(x.source.key) : undefined;
        const bytesHere = group?.length === 1 && isImage(group[0]) ? group[0].inspection.assetRevision : null;
        let requeued = 0;
        for (const revision of targets) {
            const entry = revision.profiles[context.profileId];
            if (entry?.state !== 'failed') continue;
            if (entry.error === 'source-superseded' && bytesHere !== revision.assetRevision) continue;
            revision.profiles[context.profileId] = { state: 'pending', attempts: entry.attempts };
            if (x.source.present) queue(x, revision.assetRevision, x.source.path);
            requeued++;
        }
        return decided.applied(`put ${requeued} failed ${requeued === 1 ? 'entry' : 'entries'} of ${photoId} back to pending`);
    }

    /** reprofile: queue the current profile for present photos' observed revisions that don't have it. */
    function reprofile(photoId: string | undefined): Decided {
        if (photoId !== undefined) {
            const x = photos[photoId];
            if (!x) return decided.rejected(`there is no photo ${photoId}`);
            if (isRetired(x) || x.sourceHealth !== 'present' || !x.source.present) return decided.rejected(`${photoId} is not present`);
        }
        let queued = 0;
        for (const id of photoId === undefined ? Object.keys(photos).sort() : [photoId]) {
            const photo = photos[id];
            if (isRetired(photo) || photo.sourceHealth !== 'present' || !photo.source.present) continue;
            const revision = photo.revisions[photo.source.observedRevision];
            if (!revision || revision.reassignedTo || revision.pixelDigest === null || revision.profiles[context.profileId]) continue;
            revision.profiles[context.profileId] = { state: 'pending', attempts: 0 };
            queue(photo, revision.assetRevision, photo.source.path);
            queued++;
        }
        return decided.applied(`queued the current profile for ${queued} ${queued === 1 ? 'revision' : 'revisions'}`);
    }

    function decide(decision: IdentityDecision): Decided {
        switch (decision.type) {
            case 'bind':
                return bind(decision.path, decision.photoId, decision.merge);
            case 'new':
                return newPhoto(decision.path, decision.photoId);
            case 'archive':
                return archive(decision.photoId);
            case 'retry':
                return retryFailed(decision.photoId, decision.assetRevision);
            case 'reprofile':
                return reprofile(decision.photoId);
        }
    }

    // 2. Bound paths, rows 1 to 6.
    const sourceless = new Set<string>();
    // Photos whose bound path holds another photo's bytes (row 6), with that path's file. Each may have
    // moved away, as when a series is renumbered, so rows 7 and 9 count it as sourceless.
    const displaced = new Map<string, ImageSeen>();
    // Photos whose bound path is still changing. One may be moving, so rows 8, 11, and 12 make no new photo
    // from its bytes or pixels until the path settles.
    const unsettled = new Set<string>();
    const othersOwning = (assetRevision: string, id: string) =>
        [...(ownersBefore.get(assetRevision) ?? [])].filter((owner) => owner !== id && !isRetired(photos[owner]));
    for (const id of ids) {
        const photo = photos[id];
        if (!photo.source.present || isRetired(photo) || boundByKey.get(photo.source.key) !== id) continue;
        const group = byKey.get(photo.source.key);
        if (!group) {
            if (!underUnreadableDir(photo.source.path)) sourceless.add(id);
            continue;
        }
        if (collidingKeys.has(photo.source.key)) continue; // A key collision. The binding stays, and the photo is a hold candidate.
        const [item] = group;
        if (!isImage(item)) {
            // Fresh, unreadable, or colliding: unchanged for now.
            if (item.state === 'unstable') unsettled.add(id);
            continue;
        }
        if (isHeld(item)) {
            // Held, and unchanged for now. While the path still holds another photo's bytes, as row 6 found it, the
            // photo stays displaced, so a later pass that finds its bytes elsewhere rebinds it.
            if (othersOwning(item.inspection.assetRevision, id).length > 0) displaced.set(id, item);
            continue;
        }
        if (item.entry.path !== photo.source.path) photo.source.path = item.entry.path; // A case-only or Unicode-only rename.

        const { assetRevision, pixelDigest } = item.inspection;
        // 1. P holds X's observedRevision.
        if (assetRevision === photo.source.observedRevision) {
            photo.source.lastSeenAt = now;
            continue;
        }
        // 2. P holds an older X revision.
        const own = photo.revisions[assetRevision];
        if (own && !own.reassignedTo) {
            bindTo(photo, item, assetRevision);
            requeueIfNeeded(photo, assetRevision, item.entry.path);
            fact({ type: 'replaced', photoId: id, assetRevision, path: item.entry.path, revert: true });
            continue;
        }
        // 6. P holds Y's bytes.
        const others = othersOwning(assetRevision, id);
        if (others.length > 0) {
            hold(item, [id, ...others]);
            displaced.set(id, item);
            continue;
        }
        // 3. New bytes, same pixels: a metadata edit.
        const observed = photo.revisions[photo.source.observedRevision];
        if (pixelDigest !== null && observed?.pixelDigest === pixelDigest) {
            addRevision(photo, item);
            fact({ type: 'metadata-changed', photoId: id, assetRevision, path: item.entry.path });
            continue;
        }
        // 4. New bytes, and X's observedRevision turned up at an unbound path.
        const movedOld = unboundAtStart.filter((other) => other.inspection.assetRevision === photo.source.observedRevision);
        if (movedOld.length > 0) {
            hold(item, [id]);
            for (const other of movedOld) hold(other, [id]);
            continue;
        }
        // 5. New bytes, new pixels: a replacement.
        addRevision(photo, item);
        fact({ type: 'replaced', photoId: id, assetRevision, path: item.entry.path });
    }

    // 3. Unbound paths, rows 7 to 12, against the state rows 1 to 6 left.
    const byteOwners = new Map<string, Set<string>>();
    const pixelOwners = new Map<string, Set<string>>();
    for (const id of Object.keys(photos)) {
        for (const revision of Object.values(photos[id].revisions)) {
            if (revision.reassignedTo) continue;
            addTo(byteOwners, revision.assetRevision, id);
            if (revision.pixelDigest !== null) addTo(pixelOwners, revision.pixelDigest, id);
        }
    }
    const rebound = new Set<string>();
    // A displaced photo counts too. One rebound this pass has a path again, so a later round can't move it.
    const isSourceless = (id: string) => !isRetired(photos[id]) && !rebound.has(id) && (!photos[id].source.present || sourceless.has(id) || displaced.has(id));
    // How many unbound paths, held ones included, show each byte and pixel digest, for row 7's uniqueness
    // check. A bound path doesn't count, even held: row 7 asks only that no other U shares the evidence.
    const bytesSeen = new Map<string, number>();
    const pixelsSeen = new Map<string, number>();
    const countSeen = (item: ImageSeen) => {
        bytesSeen.set(item.inspection.assetRevision, (bytesSeen.get(item.inspection.assetRevision) ?? 0) + 1);
        if (item.inspection.pixelDigest !== null) pixelsSeen.set(item.inspection.pixelDigest, (pixelsSeen.get(item.inspection.pixelDigest) ?? 0) + 1);
    };
    for (const item of seen) {
        if (isImage(item) && !inKeyCollision.has(item.entry.path) && !boundByKey.has(item.entry.key)) countSeen(item);
    }

    interface Claim { item: ImageSeen; photoId: string; by: 'bytes' | 'pixels' }
    const fresh: ImageSeen[] = [];
    // In rounds. Rebinding a displaced photo frees its old path: that path's hold ends, and the next round
    // classifies it as an unbound path, so a renumbered series resolves one rename at a time.
    let round = unboundAtStart.filter((item) => !isHeld(item));
    while (round.length > 0) {
        const claims: Claim[] = [];
        for (const item of round) {
            const { assetRevision, pixelDigest } = item.inspection;
            const owners = [...(byteOwners.get(assetRevision) ?? [])];
            if (owners.length > 0) {
                const loose = owners.filter(isSourceless).sort();
                if (loose.length === 1) claims.push({ item, photoId: loose[0], by: 'bytes' }); // 7, if unique
                else if (loose.length > 1) hold(item, loose); // 9
                else fresh.push(item); // 8
                continue;
            }
            if (pixelDigest !== null) {
                const loose = [...(pixelOwners.get(pixelDigest) ?? [])].filter(isSourceless).sort();
                if (loose.length === 1) {
                    claims.push({ item, photoId: loose[0], by: 'pixels' }); // 10, if unique
                    continue;
                }
                if (loose.length > 1) {
                    hold(item, loose); // 9
                    continue;
                }
            }
            fresh.push(item); // 11 or 12
        }

        const claimsPerPhoto = new Map<string, number>();
        for (const claim of claims) claimsPerPhoto.set(claim.photoId, (claimsPerPhoto.get(claim.photoId) ?? 0) + 1);
        const freed: ImageSeen[] = [];
        for (const claim of claims) {
            const { assetRevision, pixelDigest } = claim.item.inspection;
            const sharesEvidence = (bytesSeen.get(assetRevision) ?? 0) > 1 || (pixelDigest !== null && (pixelsSeen.get(pixelDigest) ?? 0) > 1);
            const contested = (claimsPerPhoto.get(claim.photoId) ?? 0) > 1;
            if (sharesEvidence || contested) {
                hold(claim.item, [claim.photoId]); // 9: fails row 7's uniqueness
                continue;
            }
            const photo = photos[claim.photoId];
            const lastPath = photo.source.path;
            const lastKey = photo.source.key;
            const lastRevision = photo.source.observedRevision;
            rebound.add(claim.photoId);
            if (claim.by === 'bytes') {
                // 7. Rebind X. `reappeared` at X's last path, else `renamed`.
                bindTo(photo, claim.item, assetRevision);
                if (assetRevision !== lastRevision) requeueIfNeeded(photo, assetRevision, claim.item.entry.path);
                const reappeared = lastKey === claim.item.entry.key;
                fact({
                    type: reappeared ? 'reappeared' : 'renamed',
                    photoId: photo.photoId,
                    assetRevision,
                    path: claim.item.entry.path,
                    ...(reappeared ? {} : { fromPath: lastPath }),
                    ...(assetRevision !== lastRevision ? { revert: true } : {}),
                });
            } else {
                // 10. Rebind X with a new revision.
                addRevision(photo, claim.item);
                fact({ type: 'metadata-changed', photoId: photo.photoId, assetRevision, path: claim.item.entry.path, fromPath: lastPath });
            }
            addTo(byteOwners, assetRevision, photo.photoId);
            if (pixelDigest !== null) addTo(pixelOwners, pixelDigest, photo.photoId);
            const left = displaced.get(claim.photoId);
            if (left) {
                // Its old path holds another photo's bytes, and with this photo gone from it, nothing is bound there.
                displaced.delete(claim.photoId);
                nextHolds.delete(left.entry.path);
                newHolds.delete(left.entry.path);
                freed.push(left);
            }
        }
        for (const item of freed) countSeen(item);
        round = freed;
    }

    /** The path a photo was first seen at: that of its earliest revision. */
    function firstSeenPath(photo: PhotoRecord): string {
        let earliest: AssetRevisionRecord | undefined;
        for (const revision of Object.values(photo.revisions)) {
            if (!earliest || revision.firstSeenAt < earliest.firstSeenAt || (revision.firstSeenAt === earliest.firstSeenAt && revision.firstSeenPath < earliest.firstSeenPath)) {
                earliest = revision;
            }
        }
        return earliest?.firstSeenPath ?? photo.source.path;
    }

    /**
     * The earliest-created photo among `ids`, the one a duplicate points at.
     * Photos created in one pass go by the path each was first seen at, so the
     * first of them by path is the original, whatever their IDs.
     */
    function original(ids: Iterable<string>): string {
        const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
        return [...ids].sort((a, b) =>
            compare(photos[a].createdAt, photos[b].createdAt) || compare(firstSeenPath(photos[a]), firstSeenPath(photos[b])) || compare(a, b))[0];
    }

    /** The most recently seen photo that went missing from this key before the pass. */
    function missingAt(key: string): string | undefined {
        const matches = originalIds.filter((id) => previousHealth.get(id) === 'missing' && !rebound.has(id) && photos[id].source.key === key);
        return matches.sort((a, b) => (photos[a].source.lastSeenAt < photos[b].source.lastSeenAt ? 1 : -1))[0];
    }

    // 8, 11, 12. New photos, in path order, so a later identical file points at an earlier one.
    for (const item of fresh) {
        const { assetRevision, pixelDigest } = item.inspection;
        const byBytes = byteOwners.get(assetRevision);
        const byPixels = pixelDigest !== null ? pixelOwners.get(pixelDigest) : undefined;
        // It may be a photo whose path is still changing, moving here. The next pass, once that path settles, tells.
        if ([...(byBytes ?? []), ...(byPixels ?? [])].some((owner) => unsettled.has(owner))) continue;
        const duplicateOf = byBytes?.size ? original(byBytes) : byPixels?.size ? original(byPixels) : null;
        const samePathAs = duplicateOf === null ? missingAt(item.entry.key) : undefined;

        const photoId = mintPhotoId(context.idGen);
        if (photos[photoId]) throw new Error(`The ID generator repeated ${photoId}. Photo IDs are never reissued.`);
        const photo: PhotoRecord = {
            photoId,
            createdAt: now,
            source: { path: item.entry.path, key: item.entry.key, present: true, observedRevision: assetRevision, lastSeenAt: now },
            sourceHealth: 'present',
            duplicateOf,
            revisions: {},
        };
        photos[photoId] = photo;
        fact({
            type: 'new',
            photoId,
            assetRevision,
            path: item.entry.path,
            ...(duplicateOf ? { duplicateOf } : {}),
            ...(samePathAs ? { samePathAs } : {}),
        });
        addRevision(photo, item);
        addTo(byteOwners, assetRevision, photoId);
        if (pixelDigest !== null) addTo(pixelOwners, pixelDigest, photoId);
    }

    // 13. A bound path that is gone, and nothing rebound its photo. A fresh file anywhere defers this.
    const waiting = seen.some((item) => item.state === 'unstable');
    for (const id of sourceless) {
        if (rebound.has(id)) continue;
        if (waiting) {
            report.missingDeferred = true;
            continue;
        }
        photos[id].source.present = false;
    }

    // Holds' facts, now that their candidates are final.
    for (const heldPath of [...newHolds].sort()) {
        const held = nextHolds.get(heldPath) as Hold;
        fact({
            type: 'ambiguous',
            photoId: held.candidates.length === 1 ? held.candidates[0] : null,
            assetRevision: held.assetRevision,
            path: held.path,
            candidates: held.candidates,
        });
    }

    // Recompute health. A candidate of a live hold is ambiguous; everything else is present or missing.
    const candidates = new Set([...nextHolds.values()].flatMap((held) => held.candidates));
    for (const id of Object.keys(photos).sort()) {
        const photo = photos[id];
        const before = previousHealth.get(id);
        const health: SourceHealth = isRetired(photo) ? 'archived' : candidates.has(id) ? 'ambiguous' : photo.source.present ? 'present' : 'missing';
        photo.sourceHealth = health;
        if (health === 'missing' && before !== undefined && before !== 'missing' && before !== 'archived') {
            fact({ type: 'missing', photoId: id, assetRevision: photo.source.observedRevision, path: photo.source.path });
        }
    }

    next.holds = [...nextHolds.values()].sort(byPath);
    const retry = report.unstable.length > 0;
    return { registry: next, facts, jobs, report, retryAfterMs: retry ? STABILITY_MS : null, decisions: decisionOutcomes };
}
