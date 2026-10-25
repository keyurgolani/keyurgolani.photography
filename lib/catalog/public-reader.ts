import 'server-only';
import path from 'node:path';
import { dataRoot } from '../storage/config';
import { checkCatalogMode } from './mode';
import { createCatalogReader, createRouteBuilder, type CatalogReader } from './reader';
import { listActivations, readRevisionFile } from './repository';
import { forRequest } from './request';
import type { PublicPhotoRecord, RevisionFile } from './types';
import { readActivePointer } from './working-layer';

/**
 * The one read path for public routes and APIs. It reads `catalog/active.json`
 * once per request and only the revision it names, so no response mixes two
 * revisions. The web process imports it; the CLI never does.
 */

/** The public routes: `/`, `/work`, `/work/<slug>`, and `/work/<slug>/photo/<photoId>`. */
export const publicRoutes = createRouteBuilder();

/**
 * Why nothing can be served, with no revision loaded before: `catalog/`
 * can't be read well enough to tell whether the site cut over, the pointer
 * can't be read or is gone, or the revision it names can't be read.
 */
export type CatalogUnavailableReason = 'catalog-unreadable' | 'active-unreadable' | 'revision-unreadable';

export interface ActiveRevision {
    revisionId: string;
    /** Null when the activation that named it can't be read. */
    revisionNumber: number | null;
    activationId: string;
    /** When that activation committed, or started if recovery hasn't marked it committed yet. Null when it can't be read. */
    activatedAt: string | null;
}

export type ActiveCatalog =
    | { mode: 'legacy' }
    /** `degraded` serves the last revision this process loaded, since the current pointer or revision can't be read. */
    | { mode: 'catalog'; state: 'ok' | 'degraded'; reader: CatalogReader<PublicPhotoRecord>; active: ActiveRevision }
    | { mode: 'catalog'; state: 'unavailable'; reason: CatalogUnavailableReason };

/** What a page throws when the catalog is unavailable, so the visitor gets an error page, never the legacy site. */
export class CatalogUnavailableError extends Error {
    constructor(readonly reason: CatalogUnavailableReason) {
        super(`The catalog is unavailable: ${reason}.`);
        this.name = 'CatalogUnavailableError';
    }
}

class ReadFailure extends Error {
    constructor(readonly reason: CatalogUnavailableReason, readonly detail: string) {
        super(detail);
    }
}

interface Loaded {
    reader: CatalogReader<PublicPhotoRecord>;
    active: ActiveRevision;
}

/** How many parsed revisions a process keeps, by data root and revision ID. */
export const REVISION_CACHE_SIZE = 3;

/** How long a pending or unlisted activation's answer is kept, so requests in a burst share one read of the activations. */
export const UNSETTLED_ACTIVATION_TTL_MS = 1_000;

const revisions = new Map<string, RevisionFile>();
/** Revision reads under way, so concurrent cold requests read, parse, and hash a revision once. */
const reading = new Map<string, Promise<RevisionFile>>();
const activations = new Map<string, Pick<ActiveRevision, 'revisionNumber' | 'activatedAt'>>();
const unsettled = new Map<string, { value: Pick<ActiveRevision, 'revisionNumber' | 'activatedAt'>; until: number }>();
const lastLoaded = new Map<string, Loaded>();
const failing = new Map<string, string>();

/** A short, path-free name for what went wrong, for the log line. */
function errorName(error: unknown): string {
    if (typeof error === 'object' && error !== null && typeof (error as NodeJS.ErrnoException).code === 'string') return (error as NodeJS.ErrnoException).code as string;
    return error instanceof Error ? error.name : 'Error';
}

async function revisionFor(root: string, revisionId: string): Promise<RevisionFile> {
    const key = `${root}\0${revisionId}`;
    const cached = revisions.get(key);
    if (cached) {
        // Most recently used goes last, so the oldest is evicted first.
        revisions.delete(key);
        revisions.set(key, cached);
        return cached;
    }
    const pending = reading.get(key);
    if (pending) return pending;
    const read = (async () => {
        let revision: RevisionFile | null;
        try {
            revision = await readRevisionFile(root, revisionId);
        } catch (error) {
            throw new ReadFailure('revision-unreadable', errorName(error));
        }
        if (revision === null) throw new ReadFailure('revision-unreadable', 'missing');
        revisions.set(key, revision);
        while (revisions.size > REVISION_CACHE_SIZE) revisions.delete(revisions.keys().next().value as string);
        return revision;
    })();
    reading.set(key, read);
    try {
        return await read;
    } finally {
        // A failed read isn't kept, so the next request tries again.
        reading.delete(key);
    }
}

/** The number and time of the activation the pointer names. Only metadata, so an unreadable one leaves them null. */
async function activationFor(root: string, activationId: string): Promise<Pick<ActiveRevision, 'revisionNumber' | 'activatedAt'>> {
    const key = `${root}\0${activationId}`;
    const cached = activations.get(key);
    if (cached) return cached;
    const brief = unsettled.get(key);
    if (brief && Date.now() < brief.until) return brief.value;
    unsettled.delete(key);
    // A pending one gets its committedAt when recovery commits it, and a missing one may show up, so either is kept only briefly.
    const keepBriefly = (value: Pick<ActiveRevision, 'revisionNumber' | 'activatedAt'>) => {
        unsettled.set(key, { value, until: Date.now() + UNSETTLED_ACTIVATION_TTL_MS });
        return value;
    };
    try {
        const activation = (await listActivations(root)).find((candidate) => candidate.activationId === activationId);
        if (!activation) return keepBriefly({ revisionNumber: null, activatedAt: null });
        const found = { revisionNumber: activation.revisionNumber, activatedAt: activation.committedAt ?? activation.startedAt };
        if (activation.status !== 'committed') return keepBriefly(found);
        activations.set(key, found);
        return found;
    } catch {
        // The revision itself read fine, so serve it without the number.
        return keepBriefly({ revisionNumber: null, activatedAt: null });
    }
}

function logFailure(root: string, failure: ReadFailure): void {
    // One line when reads start failing, or fail for a new reason, not one per request.
    const key = `${failure.reason}:${failure.detail}`;
    if (failing.get(root) === key) return;
    failing.set(root, key);
    console.error(JSON.stringify({ event: 'catalog.read.failed', reason: failure.reason, error: failure.detail }));
}

/**
 * The active catalog of `root`, read now. Pages and routes go through
 * getActiveCatalog() instead, which reads once per request.
 */
export async function loadActiveCatalog(root: string | null = dataRoot()): Promise<ActiveCatalog> {
    if (root === null) return { mode: 'legacy' };
    const resolved = path.resolve(/*turbopackIgnore: true*/ root);
    const mode = await checkCatalogMode(resolved);
    if (mode.mode === 'legacy') return { mode: 'legacy' };
    try {
        // Not known to have cut over, but it can't be ruled out, so serve nothing new.
        if (mode.unreadable !== undefined) throw new ReadFailure('catalog-unreadable', mode.unreadable);
        let pointer;
        try {
            pointer = await readActivePointer(resolved);
        } catch (error) {
            throw new ReadFailure('active-unreadable', errorName(error));
        }
        if (pointer === null) throw new ReadFailure('active-unreadable', 'missing');
        const revision = await revisionFor(resolved, pointer.revisionId);
        const { revisionNumber, activatedAt } = await activationFor(resolved, pointer.activationId);
        const active: ActiveRevision = { revisionId: revision.revisionId, revisionNumber, activationId: pointer.activationId, activatedAt };
        const loaded: Loaded = { reader: createCatalogReader(revision.content, { revisionId: revision.revisionId, revisionNumber }), active };
        lastLoaded.set(resolved, loaded);
        failing.delete(resolved);
        return { mode: 'catalog', state: 'ok', ...loaded };
    } catch (error) {
        if (!(error instanceof ReadFailure)) throw error;
        logFailure(resolved, error);
        const last = lastLoaded.get(resolved);
        if (last) return { mode: 'catalog', state: 'degraded', ...last };
        return { mode: 'catalog', state: 'unavailable', reason: error.reason };
    }
}

/** The active catalog for this request. The layout, page, and generateMetadata of one request share one read. */
export const getActiveCatalog = forRequest(() => loadActiveCatalog());

/**
 * Whether `/media` may serve this set publicly: only when the revision being
 * served holds the photo at that asset revision and profile. Always false in
 * legacy mode, and while the catalog is unavailable.
 */
export async function isAssetPublic(photoId: string, assetRevision: string, profileId: string, catalog?: ActiveCatalog): Promise<boolean> {
    const active = catalog ?? await loadActiveCatalog();
    if (active.mode !== 'catalog' || active.state === 'unavailable') return false;
    const photo = active.reader.photo(photoId);
    return photo !== null && photo.assetRevision === assetRevision && photo.profileId === profileId;
}
