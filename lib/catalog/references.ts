import fs from 'node:fs';
import path from 'node:path';
import { dataRootStatus } from '../storage/config';
import { hasErrorCode } from '../storage/fsx';
import { parseCandidateFile, parseRevisionFile, type ParseResult, type SchemaIssue } from './schema';
import type { CandidateContent } from './types';
import { authoredPaths, catalogPaths, readActivePointer, readWorkingLayer, type RecordProblem } from './working-layer';

/**
 * What destructive cleanup has to keep: every asset a revision, a candidate,
 * or the working layer names. #15's GC and purge and #17's staging cleanup
 * call references() while they hold the catalog lock. It takes no lock and
 * writes nothing. It fails closed: a file it can't read or parse throws, since
 * nobody can tell what that file references.
 */

export type ReferenceSource = 'active-revision' | 'revision' | 'candidate' | 'working-layer-series' | 'working-layer-photo';

const SOURCE_ORDER: readonly ReferenceSource[] = ['active-revision', 'revision', 'candidate', 'working-layer-series', 'working-layer-photo'];

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

export type ReferenceScanReason = 'not-ready' | 'unreadable' | 'invalid-json' | 'unknown-schema-version' | 'invalid' | 'file-name' | 'missing';

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
    for (const name of names.filter((entry) => !entry.startsWith('.') && entry.endsWith('.json')).sort()) {
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

function problemFile(problem: RecordProblem): string {
    if (problem.kind === 'site') return 'authored/site.json';
    return `authored/${problem.kind === 'series' ? 'series' : 'photos'}/${problem.id}.json`;
}

/**
 * Every asset reference in the data root, each listed once, sorted by source,
 * holder, photo, asset revision, and profile. Revisions and candidates name
 * exact profiles. The working layer names asset revisions, so its references
 * keep every profile.
 */
export async function references(dataRoot: string): Promise<AssetReference[]> {
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
            ? new ReferenceScanError('catalog/active.json', 'unreadable', `the file can't be read (${code})`)
            : new ReferenceScanError('catalog/active.json', 'invalid', (error as Error).message);
    }

    const revisions = await readStored(dataRoot, paths.revisionsDir, parseRevisionFile);
    if (activeRevisionId !== null && !revisions.some((revision) => revision.revisionId === activeRevisionId)) {
        throw new ReferenceScanError(`catalog/revisions/${activeRevisionId}.json`, 'missing', 'catalog/active.json names it, but it does not exist');
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

    let layer: Awaited<ReturnType<typeof readWorkingLayer>>;
    try {
        layer = await readWorkingLayer(dataRoot);
    } catch (error) {
        throw new ReferenceScanError(path.relative(dataRoot, authoredPaths(dataRoot).dir), 'unreadable', `a folder can't be listed (${errorCode(error)})`);
    }
    const [problem] = layer.problems;
    if (problem) throw new ReferenceScanError(problemFile(problem), problem.reason, issueSummary(problem.issues));
    const pinned = new Map(layer.photos.map((photo) => [photo.id, photo.assetRevision]));
    for (const series of layer.series) {
        const members = [...series.photoIds, ...(series.cover ? [series.cover.photoId] : []), ...(series.openingPhotoId ? [series.openingPhotoId] : [])];
        for (const photoId of members) {
            add({ source: 'working-layer-series', holder: series.id, photoId, assetRevision: pinned.get(photoId) ?? null, profileId: null });
        }
    }
    for (const photo of layer.photos) {
        add({ source: 'working-layer-photo', holder: photo.id, photoId: photo.id, assetRevision: photo.assetRevision, profileId: null });
    }
    return [...found.values()].sort(byReference);
}

/** The references that keep one derivative set. */
export function referencesTo(list: readonly AssetReference[], asset: { photoId: string; assetRevision: string; profileId: string }): AssetReference[] {
    return list.filter((reference) => reference.photoId === asset.photoId
        && (reference.assetRevision === null || reference.assetRevision === asset.assetRevision)
        && (reference.profileId === null || reference.profileId === asset.profileId));
}
