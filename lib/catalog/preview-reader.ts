// The curator process's routes under app/curation/preview/ import this, and
// lib/catalog's tests. ESLint keeps every other importer out (#16), and a
// client bundle that reaches it fails the build.
import 'server-only';
import { readRegistry } from '../identity/registry';
import type { MediaAccessPolicy } from '../media/access';
import { dataRootStatus } from '../storage/config';
import { compileCandidate, type CompileResult } from './compile';
import { createCatalogReader, type CatalogReader } from './reader';
import { readRevisionFile } from './repository';
import { createRouteBuilder, type RouteBuilder } from './routes';
import { REVISION_ID_RE } from './schema';
import type { CandidatePhotoRecord } from './types';
import { readActivePointer, readWorkingLayer } from './working-layer';

/**
 * #16's draft preview reader: the working layer compiled now, as a publish
 * would compile it, read through the same reader and projections the public
 * site uses. A `draftId` is the candidate's content hash, which is also its
 * future revision ID, so it names exactly one catalog. Only the current
 * candidate is served: any other ID, unknown or from before an edit, is
 * not-current, so the preview can't say which drafts ever existed.
 *
 * It reads only the data root, never the active pointer's revision through
 * the public reader, and writes nothing. Every caller checks the curator
 * session first (requireCurator()) and validates the ID with previewDraftId()
 * before calling anything else here, so a malformed ID reads nothing.
 */

/** Where the preview lives. The frame is `<prefix>/<draftId>`, the visitor site under it at `/site`. */
export const PREVIEW_PREFIX = '/curation/preview';

/** The draft ID when `value` is one (#13's `REVISION_ID_RE`), else null. Pure, so a malformed ID touches nothing. */
export function previewDraftId(value: unknown): string | null {
    return typeof value === 'string' && REVISION_ID_RE.test(value) ? value : null;
}

/** The curator frame's path for a draft. */
export function previewFrameHref(draftId: string): string {
    return `${PREVIEW_PREFIX}/${checked(draftId)}`;
}

/** The visitor site's `basePath` inside the preview of `draftId`. */
export function previewBasePath(draftId: string): string {
    return `${previewFrameHref(draftId)}/site`;
}

/** The preview's RouteBuilder: the public routes, `/media` and the catalog endpoints under previewBasePath(). */
export function previewRoutes(draftId: string): RouteBuilder {
    return createRouteBuilder({ basePath: previewBasePath(draftId) });
}

function checked(draftId: string): string {
    if (previewDraftId(draftId) === null) throw new TypeError('A preview needs a draft ID, rev_ plus 64 hex.');
    return draftId;
}

export type PreviewUnavailableReason = 'data-root-not-ready' | 'draft-unreadable';

export type PreviewCatalog =
    /** The current candidate, read as `draftId` with no revision number. The shape every projection's route function takes. */
    | { mode: 'catalog'; state: 'ok'; draftId: string; reader: CatalogReader<CandidatePhotoRecord> }
    /** Not the current candidate: unknown, or the working layer changed since. */
    | { mode: 'catalog'; state: 'not-current' }
    /** The data root isn't ready, or a file the compile reads can't be read. Pages throw, so the error page renders. */
    | { mode: 'catalog'; state: 'unavailable'; reason: PreviewUnavailableReason };

/**
 * How long a subresource (load-more, Home's records, an image) may use a
 * compile of the same draft from before. The content is addressed by its
 * hash, so a kept copy is exactly that draft; only whether it's still the
 * current one can lag, by this much, and only for a signed-in curator.
 * Pages and their RSC requests always compile again.
 */
export const SUBRESOURCE_MAX_AGE_MS = 60_000;

/** How many compiled drafts a process keeps. */
const KEPT_DRAFTS = 2;

interface Kept {
    reader: CatalogReader<CandidatePhotoRecord>;
    at: number;
}

interface PreviewReaderState {
    /** Compiled drafts, by data root and draft ID, oldest first. */
    kept: Map<string, Kept>;
    /** Compiles under way, by data root: a compile doesn't depend on the ID asked for, so concurrent requests share one. */
    compiling: Map<string, Promise<CompileResult>>;
}

/**
 * Where the process keeps its compiles. Next bundles each route on its own,
 * so a module-level map would be one per route: a page that finds a draft
 * no longer current couldn't drop it from the media or records handlers'
 * maps, and concurrent compiles would be shared per route only. So the maps
 * live on `globalThis`, one for the process, whichever bundle loaded this
 * module.
 */
export const PREVIEW_READER_STATE_KEY = Symbol.for('kg.catalog.previewReader');

function sharedState(): PreviewReaderState {
    const global = globalThis as typeof globalThis & { [PREVIEW_READER_STATE_KEY]?: PreviewReaderState };
    global[PREVIEW_READER_STATE_KEY] ??= { kept: new Map(), compiling: new Map() };
    return global[PREVIEW_READER_STATE_KEY];
}

const { kept, compiling } = sharedState();

/** A short, path-free name for what went wrong, for the log line. */
function errorName(error: unknown): string {
    if (typeof error === 'object' && error !== null && typeof (error as NodeJS.ErrnoException).code === 'string') return (error as NodeJS.ErrnoException).code as string;
    return error instanceof Error ? error.name : 'Error';
}

/** #13's snapshot read without a lock, as `photos:validate` reads, and the compile publish would run. */
async function compileWorkingLayer(root: string): Promise<CompileResult> {
    const layer = await readWorkingLayer(root);
    const registry = await readRegistry(root);
    const pointer = await readActivePointer(root);
    const active = pointer ? await readRevisionFile(root, pointer.revisionId) : null;
    if (pointer && active === null) throw new Error('The active pointer names a revision with no file.');
    return compileCandidate({ layer, registry, root, active });
}

async function compileShared(root: string): Promise<CompileResult> {
    const pending = compiling.get(root);
    if (pending) return pending;
    const run = compileWorkingLayer(root);
    compiling.set(root, run);
    try {
        return await run;
    } finally {
        compiling.delete(root);
    }
}

function keep(key: string, reader: CatalogReader<CandidatePhotoRecord>, now: number): void {
    kept.delete(key);
    kept.set(key, { reader, at: now });
    while (kept.size > KEPT_DRAFTS) kept.delete(kept.keys().next().value as string);
}

export interface LoadPreviewOptions {
    /** Use a compile of this draft from at most this long ago. 0, the default, always compiles. */
    maxAgeMs?: number;
    /** For tests. */
    now?: () => number;
}

/**
 * The preview catalog for `draftId`, read now. A malformed ID is
 * not-current before anything is read, for a caller that skipped
 * previewDraftId().
 */
export async function loadPreviewCatalog(draftId: string, options: LoadPreviewOptions = {}): Promise<PreviewCatalog> {
    if (previewDraftId(draftId) === null) return { mode: 'catalog', state: 'not-current' };
    const now = options.now ?? Date.now;
    const status = dataRootStatus();
    if (status.state !== 'ready' || status.root === null) return { mode: 'catalog', state: 'unavailable', reason: 'data-root-not-ready' };
    const key = `${status.root}\0${draftId}`;
    const maxAge = options.maxAgeMs ?? 0;
    const recent = kept.get(key);
    if (maxAge > 0 && recent && now() - recent.at <= maxAge) return { mode: 'catalog', state: 'ok', draftId, reader: recent.reader };
    let compiled: CompileResult;
    try {
        compiled = await compileShared(status.root);
    } catch (error) {
        console.error(JSON.stringify({ event: 'catalog.preview.failed', error: errorName(error) }));
        return { mode: 'catalog', state: 'unavailable', reason: 'draft-unreadable' };
    }
    if (compiled.candidateId !== draftId) {
        kept.delete(key);
        return { mode: 'catalog', state: 'not-current' };
    }
    const reader = createCatalogReader(compiled.content, { revisionId: draftId, revisionNumber: null });
    keep(key, reader, now());
    return { mode: 'catalog', state: 'ok', draftId, reader };
}

/**
 * The current candidate's ID, compiled now, for `/curation/preview` to send
 * the curator on to. Null when the data root isn't ready or can't be read.
 */
export async function currentDraftId(options: Pick<LoadPreviewOptions, 'now'> = {}): Promise<string | null> {
    const status = dataRootStatus();
    if (status.state !== 'ready' || status.root === null) return null;
    let compiled: CompileResult;
    try {
        compiled = await compileShared(status.root);
    } catch (error) {
        console.error(JSON.stringify({ event: 'catalog.preview.failed', error: errorName(error) }));
        return null;
    }
    keep(`${status.root}\0${compiled.candidateId}`, createCatalogReader(compiled.content, { revisionId: compiled.candidateId, revisionNumber: null }), (options.now ?? Date.now)());
    return compiled.candidateId;
}

/** Forget every kept compile. For tests. */
export function resetPreviewReaderForTests(): void {
    kept.clear();
    compiling.clear();
}

/** A `/media` variant path as revisions store it (#10's mediaUrl()). */
const MEDIA_PATH_RE = /^\/media\/[^/?#]+\/[^/?#]+\/[^/?#]+\/[^/?#]+$/;

/**
 * `model` with every string that is exactly a `/media` path moved under the
 * preview's `basePath`, so each image loads through the preview's own media
 * route, never the public one. Revisions store `/media` URLs and the
 * projections check them as stored, so this runs on what a projection
 * returns. A copy: the projection's output and the content it shares are
 * left as they are.
 */
export function previewMediaUrls<T>(model: T, routes: Pick<RouteBuilder, 'mediaHref'>): T {
    const visit = (value: unknown): unknown => {
        if (typeof value === 'string') return MEDIA_PATH_RE.test(value) ? routes.mediaHref(value) : value;
        if (Array.isArray(value)) return value.map(visit);
        if (typeof value === 'object' && value !== null) {
            const copy: Record<string, unknown> = {};
            for (const [name, field] of Object.entries(value)) copy[name] = visit(field);
            return copy;
        }
        return value;
    };
    return visit(model) as T;
}

/**
 * Who may fetch a derivative set from the preview's media route: `private`
 * (`private, no-store`) while the draft holds the photo at that asset
 * revision and profile, `deny` (404) otherwise, whether the draft is
 * unknown, changed, or doesn't hold the set. The route calls
 * requireCurator() and previewDraftId() first.
 */
export function previewMediaAccess(draftId: string, options: LoadPreviewOptions = {}): MediaAccessPolicy {
    return async ({ photoId, assetRevision, profileId }) => {
        const preview = await loadPreviewCatalog(draftId, { maxAgeMs: SUBRESOURCE_MAX_AGE_MS, ...options });
        if (preview.state !== 'ok') return 'deny';
        const photo = preview.reader.photo(photoId);
        return photo !== null && photo.assetRevision === assetRevision && photo.profileId === profileId ? 'private' : 'deny';
    };
}
