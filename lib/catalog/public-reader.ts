import 'server-only';
import path from 'node:path';
import { dataRoot } from '../storage/config';
import { catalogMode } from './mode';
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

/** Why nothing can be served: the pointer or the revision it names can't be read, and no revision loaded before. */
export type CatalogUnavailableReason = 'active-unreadable' | 'revision-unreadable';

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

const revisions = new Map<string, RevisionFile>();
const activations = new Map<string, Pick<ActiveRevision, 'revisionNumber' | 'activatedAt'>>();
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
}

/** The number and time of the activation the pointer names. Only metadata, so an unreadable one leaves them null. */
async function activationFor(root: string, activationId: string): Promise<Pick<ActiveRevision, 'revisionNumber' | 'activatedAt'>> {
    const key = `${root}\0${activationId}`;
    const cached = activations.get(key);
    if (cached) return cached;
    try {
        const activation = (await listActivations(root)).find((candidate) => candidate.activationId === activationId);
        if (!activation) return { revisionNumber: null, activatedAt: null };
        const found = { revisionNumber: activation.revisionNumber, activatedAt: activation.committedAt ?? activation.startedAt };
        // A pending one gets its committedAt when recovery commits it, so only a committed one is kept.
        if (activation.status === 'committed') activations.set(key, found);
        return found;
    } catch {
        // The revision itself read fine, so serve it without the number.
        return { revisionNumber: null, activatedAt: null };
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
    if (await catalogMode(resolved) === 'legacy') return { mode: 'legacy' };
    try {
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
