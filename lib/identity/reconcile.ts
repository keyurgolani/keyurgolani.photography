import { mintPhotoId } from './ids';
import type { ImageInspection, Inspection } from './inspect';
import { folderOf, isUnder, keyOf, type LibraryScan, type ScanEntry } from './scan';
import type { AssetRevisionRecord, DerivativeJob, Hold, IdentityFact, PhotoRecord, Registry, SourceHealth } from './types';

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
}

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

    // Present, non-retired photos by the key of their bound path.
    const boundByKey = new Map<string, string>();
    for (const id of originalIds) {
        const photo = photos[id];
        if (photo.source.present && !isRetired(photo) && !boundByKey.has(photo.source.key)) boundByKey.set(photo.source.key, id);
    }

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
            photoId: boundByKey.get(item.entry.key) ?? null,
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

    const nextHolds = new Map<string, Hold>();
    const newHolds = new Set<string>();

    function hold(item: ImageSeen, candidates: string[]): void {
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
        });
        newHolds.add(item.entry.path);
    }

    // Existing holds persist while their path holds the same bytes, or can't be read right now.
    for (const existing of registry.holds) {
        const group = byKey.get(keyOf(existing.path)) ?? [];
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
        if (group.length < 2) continue;
        report.keyCollisions.push(group.map((item) => item.entry.path));
        const bound = boundByKey.get(key);
        for (const item of group) {
            inKeyCollision.add(item.entry.path);
            if (!nextHolds.has(item.entry.path) && isImage(item)) hold(item, bound ? [bound] : []);
        }
    }

    const isHeld = (item: Seen) => nextHolds.has(item.entry.path);
    const unboundAtStart = seen.filter((item): item is ImageSeen =>
        isImage(item) && !boundByKey.has(item.entry.key) && !isHeld(item) && !inKeyCollision.has(item.entry.path));

    // Owners of each revision before this pass. "Belongs" ignores reassigned revisions.
    const ownersBefore = new Map<string, Set<string>>();
    for (const id of originalIds) {
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

    // 2. Bound paths, rows 1 to 6.
    const sourceless = new Set<string>();
    for (const id of originalIds) {
        const photo = photos[id];
        if (!photo.source.present || isRetired(photo) || boundByKey.get(photo.source.key) !== id) continue;
        const group = byKey.get(photo.source.key);
        if (!group) {
            if (!underUnreadableDir(photo.source.path)) sourceless.add(id);
            continue;
        }
        if (group.length > 1) continue; // A key collision. The binding stays, and the photo is a hold candidate.
        const [item] = group;
        if (isHeld(item) || !isImage(item)) continue; // Held, fresh, unreadable, or colliding: unchanged for now.
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
        const others = [...(ownersBefore.get(assetRevision) ?? [])].filter((owner) => owner !== id && !isRetired(photos[owner]));
        if (others.length > 0) {
            hold(item, [id, ...others]);
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
    const isSourceless = (id: string) => !isRetired(photos[id]) && (!photos[id].source.present || sourceless.has(id));
    const unbound = unboundAtStart.filter((item) => !isHeld(item));
    // How many unbound paths, held ones included, show each byte and pixel digest, for row 7's uniqueness check.
    const bytesSeen = new Map<string, number>();
    const pixelsSeen = new Map<string, number>();
    const unboundPaths = new Set(unbound.map((item) => item.entry.path));
    for (const item of seen) {
        if (!isImage(item) || inKeyCollision.has(item.entry.path) || !(isHeld(item) || unboundPaths.has(item.entry.path))) continue;
        bytesSeen.set(item.inspection.assetRevision, (bytesSeen.get(item.inspection.assetRevision) ?? 0) + 1);
        if (item.inspection.pixelDigest !== null) pixelsSeen.set(item.inspection.pixelDigest, (pixelsSeen.get(item.inspection.pixelDigest) ?? 0) + 1);
    }

    interface Claim { item: ImageSeen; photoId: string; by: 'bytes' | 'pixels' }
    const claims: Claim[] = [];
    const fresh: ImageSeen[] = [];
    for (const item of unbound) {
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
    const rebound = new Set<string>();
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
    }

    /** The earliest-created photo among `ids`, the one a duplicate points at. */
    function original(ids: Iterable<string>): string {
        return [...ids].sort((a, b) =>
            photos[a].createdAt < photos[b].createdAt ? -1 : photos[a].createdAt > photos[b].createdAt ? 1 : a < b ? -1 : a > b ? 1 : 0)[0];
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
    return { registry: next, facts, jobs, report, retryAfterMs: retry ? STABILITY_MS : null };
}
