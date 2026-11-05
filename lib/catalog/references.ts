import fs from 'node:fs';
import path from 'node:path';
import { listEvents } from '../curation/repository';
import { ASSET_REVISION_RE, PHOTO_ID_RE, PROFILE_ID_RE } from '../identity/ids';
import { readRegistry } from '../identity/registry';
import { dataRootStatus } from '../storage/config';
import { hasErrorCode } from '../storage/fsx';
import { MANIFEST_FILE } from '../storage/publish';
import { parseCandidateFile, parseRevisionFile, type ParseResult, type SchemaIssue } from './schema';
import type { CandidateContent } from './types';
import { ACTIVE_POINTER_NAME, authoredPaths, catalogPaths, readActivePointer, readWorkingLayer, type RecordProblem } from './working-layer';

/**
 * What destructive cleanup has to keep: every asset a revision, a candidate,
 * or the working layer's newest record versions name. It takes no lock and
 * writes nothing, so #15's GC and purge and #17's staging cleanup must hold the
 * `authored` lock, as well as the catalog lock, from this scan through their
 * delete, or a write in between could pin an asset they delete. It fails
 * closed: a file it can't read or parse throws, since nobody can tell what
 * that file references.
 */

export type ReferenceSource = 'active-revision' | 'revision' | 'candidate' | 'working-layer-series' | 'working-layer-photo' | 'open-inbox' | 'live-staging';

const SOURCE_ORDER: readonly ReferenceSource[] = ['active-revision', 'revision', 'candidate', 'working-layer-series', 'working-layer-photo', 'open-inbox', 'live-staging'];

/**
 * #15's always-protected set (AC 8): what no cleanup deletes, even for a
 * tombstoned asset. For one, a working-layer series counts only where it
 * lists the photo at that asset revision, and the photo's own record not at
 * all. The other sources, older revisions, candidates and the photo's own
 * record, a standing tombstone past its grace overrides, and nothing else.
 */
export const ALWAYS_PROTECTED: readonly ReferenceSource[] = ['active-revision', 'working-layer-series', 'open-inbox', 'live-staging'];

/**
 * The first of the always-protected set, in its order, that holds
 * `photoId`'s `assetRevision`: a reference naming that revision, or every
 * revision of the photo. Null when none does. GC, `photos gc --set-aside` and
 * `photos status` ask it the same way.
 */
export function alwaysHolder(refs: readonly AssetReference[], photoId: string, assetRevision: string): AssetReference | null {
    for (const source of ALWAYS_PROTECTED) {
        const found = refs.find((ref) => ref.source === source && ref.photoId === photoId && (ref.assetRevision === null || ref.assetRevision === assetRevision));
        if (found) return found;
    }
    return null;
}

/** Who protects an asset, in words. */
export function protectedText(ref: Pick<AssetReference, 'source' | 'holder'>): string {
    switch (ref.source) {
        case 'active-revision':
            return `the live revision, ${ref.holder}, shows it`;
        case 'working-layer-series':
            return `the draft's series ${ref.holder} lists it`;
        case 'open-inbox':
            return `the open Inbox item ${ref.holder} names it`;
        case 'live-staging':
            return `the build in staging/${ref.holder} may be writing it`;
        case 'revision':
            return `revision ${ref.holder} shows it`;
        case 'candidate':
            return `candidate ${ref.holder} shows it`;
        case 'working-layer-photo':
            return 'its own photo record pins it';
    }
}

/** The Inbox states #14 still shows as open: an item not yet settled. */
const OPEN_EVENT_STATUSES = new Set(['open', 'deferred', 'failed']);

/** `staging/`, and the names a build gives its folders there (lib/identity/derivatives.ts, which this module mustn't import: it pulls in the encoder). */
const STAGING_DIR = 'staging';
const STAGING_NAME = /^[a-z0-9-]+$/;

export interface AssetReference {
    source: ReferenceSource;
    /** The revision or candidate ID, or the ID of the authored series or photo record. */
    holder: string;
    photoId: string;
    /** Null for a series member with no photo record to pin one, which keeps every asset revision of the photo. */
    assetRevision: string | null;
    /** Null for the working layer, which pins an asset revision but no profile, so it keeps every profile. */
    profileId: string | null;
}

export type ReferenceScanReason = 'not-ready' | 'unreadable' | 'invalid-json' | 'unknown-schema-version' | 'invalid' | 'file-name' | 'edited-in-place' | 'missing';

/** A file or folder references() couldn't use. `file` is relative to the data root, and `.` is the root itself. */
export class ReferenceScanError extends Error {
    readonly file: string;
    readonly reason: ReferenceScanReason;

    constructor(file: string, reason: ReferenceScanReason, detail: string) {
        super(`Can't tell what ${file} references: ${detail}. Nothing was deleted.`);
        this.name = 'ReferenceScanError';
        this.file = file;
        this.reason = reason;
    }
}

const compare = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1);

function byReference(a: AssetReference, b: AssetReference): number {
    return SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source)
        || compare(a.holder, b.holder)
        || compare(a.photoId, b.photoId)
        || compare(a.assetRevision, b.assetRevision)
        || compare(a.profileId, b.profileId);
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code ?? 'an I/O error';

/** The first few schema issues, for the error message. */
const issueSummary = (issues: readonly SchemaIssue[]) => issues.slice(0, 3).map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join('; ');

interface StoredFile {
    revisionId: string;
    content: CandidateContent;
}

/** Every revision or candidate file in `dir`, parsed. Dot-files and other names are temp files or OS metadata. */
async function readStored(root: string, dir: string, parse: (value: unknown) => ParseResult<StoredFile>): Promise<StoredFile[]> {
    const relativeDir = path.relative(root, dir).split(path.sep).join('/');
    let names: string[];
    try {
        names = await fs.promises.readdir(dir);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return [];
        throw new ReferenceScanError(relativeDir, 'unreadable', `the folder can't be listed (${errorCode(error)})`);
    }
    const stored: StoredFile[] = [];
    // `.JSON` too: a case-insensitive disk may hand it out as `.json`, so it fails the name check rather than go unread.
    for (const name of names.filter((entry) => !entry.startsWith('.') && /\.json$/i.test(entry)).sort()) {
        const file = `${relativeDir}/${name}`;
        let text: string;
        try {
            text = await fs.promises.readFile(path.join(dir, name), 'utf8');
        } catch (error) {
            // Gone since the listing, so it references nothing now.
            if (hasErrorCode(error, 'ENOENT')) continue;
            throw new ReferenceScanError(file, 'unreadable', `the file can't be read (${errorCode(error)})`);
        }
        let value: unknown;
        try {
            value = JSON.parse(text);
        } catch {
            throw new ReferenceScanError(file, 'invalid-json', 'the file is not valid JSON');
        }
        const parsed = parse(value);
        if (!parsed.ok) throw new ReferenceScanError(file, parsed.error.reason, issueSummary(parsed.error.issues));
        if (`${parsed.value.revisionId}.json` !== name) throw new ReferenceScanError(file, 'file-name', `it holds ${parsed.value.revisionId}`);
        stored.push(parsed.value);
    }
    return stored;
}

/** The record's version folder, relative to the data root. */
function problemFile(problem: RecordProblem): string {
    if (problem.kind === 'site') return 'authored/site';
    return `authored/${problem.kind === 'series' ? 'series' : 'photos'}/${problem.id}`;
}

/**
 * Every asset reference in the data root, each listed once, sorted by source,
 * holder, photo, asset revision, and profile. Revisions and candidates name
 * exact profiles. The working layer names asset revisions, so its references
 * keep every profile.
 */
export interface ReferenceOptions {
    /**
     * #181's A10: also tag open Inbox items (`open-inbox`) and staging
     * entries (`live-staging`), which #15's always-protected set keeps even
     * for a tombstoned asset. Off by default, so the curator's callers see
     * what they always saw. GC and purge turn it on.
     */
    live?: boolean;
}

export async function references(dataRoot: string, options: ReferenceOptions = {}): Promise<AssetReference[]> {
    // A missing or uninitialized root reads as empty, which would leave everything unprotected.
    const status = dataRootStatus({ root: dataRoot });
    if (status.state !== 'ready') throw new ReferenceScanError('.', 'not-ready', `the data root is ${status.cause ?? status.state}`);

    const paths = catalogPaths(dataRoot);
    const found = new Map<string, AssetReference>();
    const add = (reference: AssetReference) => found.set(JSON.stringify(reference), reference);

    let activeRevisionId: string | null = null;
    try {
        activeRevisionId = (await readActivePointer(dataRoot))?.revisionId ?? null;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        throw code
            ? new ReferenceScanError(ACTIVE_POINTER_NAME, 'unreadable', `the pointer can't be read (${code})`)
            : new ReferenceScanError(ACTIVE_POINTER_NAME, 'invalid', (error as Error).message);
    }

    const revisions = await readStored(dataRoot, paths.revisionsDir, parseRevisionFile);
    if (activeRevisionId !== null && !revisions.some((revision) => revision.revisionId === activeRevisionId)) {
        throw new ReferenceScanError(`catalog/revisions/${activeRevisionId}.json`, 'missing', `${ACTIVE_POINTER_NAME} names it, but it does not exist`);
    }
    for (const revision of revisions) {
        const source = revision.revisionId === activeRevisionId ? 'active-revision' : 'revision';
        for (const photo of revision.content.photos) {
            add({ source, holder: revision.revisionId, photoId: photo.id, assetRevision: photo.assetRevision, profileId: photo.profileId });
        }
    }
    for (const candidate of await readStored(dataRoot, paths.candidatesDir, parseCandidateFile)) {
        for (const photo of candidate.content.photos) {
            add({ source: 'candidate', holder: candidate.revisionId, photoId: photo.id, assetRevision: photo.assetRevision, profileId: photo.profileId });
        }
    }

    // A commit lands whole as its record's newest version, so the newest of each record is all there is to read.
    let layer: Awaited<ReturnType<typeof readWorkingLayer>>;
    try {
        layer = await readWorkingLayer(dataRoot);
    } catch (error) {
        throw new ReferenceScanError(path.relative(dataRoot, authoredPaths(dataRoot).dir), 'unreadable', `a folder can't be listed (${errorCode(error)})`);
    }
    const [problem] = layer.problems;
    if (problem) throw new ReferenceScanError(problemFile(problem), problem.reason, issueSummary(problem.issues));
    const photos = layer.photos;
    const pinned = new Map<string, Set<string>>();
    for (const photo of photos) pinned.set(photo.id, new Set([...(pinned.get(photo.id) ?? []), photo.assetRevision]));
    for (const series of layer.series) {
        const members = [
            ...series.photoIds,
            ...(series.cover ? [series.cover.photoId] : []),
            ...(series.openingPhotoId ? [series.openingPhotoId] : []),
            ...series.chapters.map((chapter) => chapter.startPhotoId),
        ];
        for (const photoId of members) {
            const revisions = pinned.get(photoId);
            for (const assetRevision of revisions ? [...revisions] : [null]) {
                add({ source: 'working-layer-series', holder: series.id, photoId, assetRevision, profileId: null });
            }
        }
    }
    for (const photo of photos) {
        add({ source: 'working-layer-photo', holder: photo.id, photoId: photo.id, assetRevision: photo.assetRevision, profileId: null });
    }
    if (options.live) {
        for (const reference of await liveReferences(dataRoot)) add(reference);
    }
    return [...found.values()].sort(byReference);
}

const EVENT_REASONS = new Set<ReferenceScanReason>(['unreadable', 'invalid-json', 'edited-in-place', 'file-name', 'unknown-schema-version', 'invalid']);

/**
 * The references #15's always-protected set adds to references(): every
 * open Inbox item, and every staging entry. Fails closed like the rest.
 *
 * - An open, deferred, or failed `CurationEvent` keeps its photo at its
 *   asset revision, every one when it names none, at the profile its
 *   candidate set names or any. One with no photo ID yet keeps the photos
 *   its facts name.
 * - Every folder in `staging/` counts as a live build: telling one from a
 *   killed build would take its lock, and this scan writes nothing. A build
 *   writes its manifest last, so one that has it keeps that set. One that
 *   doesn't keeps every set the registry still has pending, the only ones a
 *   build starts.
 */
export async function liveReferences(dataRoot: string): Promise<AssetReference[]> {
    const found: AssetReference[] = [];

    let listed: Awaited<ReturnType<typeof listEvents>>;
    try {
        listed = await listEvents(dataRoot);
    } catch (error) {
        throw new ReferenceScanError('curation/events', 'unreadable', `the folder can't be listed (${errorCode(error)})`);
    }
    const [eventProblem] = listed.problems;
    if (eventProblem) {
        throw new ReferenceScanError(`curation/events/${eventProblem.id}`, EVENT_REASONS.has(eventProblem.reason) ? eventProblem.reason : 'invalid', eventProblem.message);
    }
    for (const event of listed.events) {
        if (!OPEN_EVENT_STATUSES.has(event.status)) continue;
        const facts = event.derivedFacts;
        const photoIds = event.photoId !== null
            ? [event.photoId]
            : [...new Set([...(facts.candidates ?? []), ...(facts.duplicateOf ? [facts.duplicateOf] : []), ...(facts.samePathAs ? [facts.samePathAs] : [])])];
        for (const photoId of photoIds) {
            // With no photo ID yet, the item's own asset revision is the new file's, not one of the photos it names has, so it keeps every one.
            const named = event.photoId !== null;
            found.push({ source: 'open-inbox', holder: event.id, photoId, assetRevision: named ? event.assetRevision : null, profileId: named ? event.candidate?.profileId ?? null : null });
        }
    }

    const staging = path.join(/*turbopackIgnore: true*/ dataRoot, STAGING_DIR);
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(staging, { withFileTypes: true });
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) entries = [];
        else throw new ReferenceScanError(STAGING_DIR, 'unreadable', `the folder can't be listed (${errorCode(error)})`);
    }
    let pending: AssetReference[] | null = null;
    for (const entry of entries.filter((each) => each.isDirectory() && STAGING_NAME.test(each.name)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const target = await stagedManifest(path.join(staging, entry.name));
        if (target !== null) {
            found.push({ source: 'live-staging', holder: entry.name, ...target });
            continue;
        }
        pending ??= await pendingSets(dataRoot);
        for (const reference of pending) found.push({ ...reference, holder: entry.name });
    }
    return found;
}

/** The set a staging folder's manifest names, or null when it has none yet or it can't be read as one. */
async function stagedManifest(dir: string): Promise<{ photoId: string; assetRevision: string; profileId: string } | null> {
    const file = path.join(dir, MANIFEST_FILE);
    try {
        if (!(await fs.promises.lstat(file)).isFile()) return null;
        const value = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Record<string, unknown> | null;
        const { photoId, assetRevision, profileId } = value ?? {};
        if (typeof photoId !== 'string' || !PHOTO_ID_RE.test(photoId)) return null;
        if (typeof assetRevision !== 'string' || !ASSET_REVISION_RE.test(assetRevision)) return null;
        if (typeof profileId !== 'string' || !PROFILE_ID_RE.test(profileId)) return null;
        return { photoId, assetRevision, profileId };
    } catch {
        // Half written or gone: the folder then keeps every pending set instead.
        return null;
    }
}

/** Every set the registry has pending, as a staging folder with no manifest yet keeps them. */
async function pendingSets(dataRoot: string): Promise<AssetReference[]> {
    let registry: Awaited<ReturnType<typeof readRegistry>>;
    try {
        registry = await readRegistry(dataRoot);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        throw new ReferenceScanError('identity/registry', code ? 'unreadable' : 'invalid', code ? `the registry can't be read (${code})` : (error as Error).message);
    }
    const sets: AssetReference[] = [];
    for (const [photoId, photo] of Object.entries(registry.photos)) {
        for (const [assetRevision, revision] of Object.entries(photo.revisions)) {
            for (const [profileId, profile] of Object.entries(revision.profiles)) {
                if (profile.state === 'pending') sets.push({ source: 'live-staging', holder: '', photoId, assetRevision, profileId });
            }
        }
    }
    return sets;
}

/** The references that keep one derivative set. */
export function referencesTo(list: readonly AssetReference[], asset: { photoId: string; assetRevision: string; profileId: string }): AssetReference[] {
    return list.filter((reference) => reference.photoId === asset.photoId
        && (reference.assetRevision === null || reference.assetRevision === asset.assetRevision)
        && (reference.profileId === null || reference.profileId === asset.profileId));
}
