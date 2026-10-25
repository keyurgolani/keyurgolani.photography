import 'server-only';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { loadPreviewCatalog, previewDraftId, previewRoutes, SUBRESOURCE_MAX_AGE_MS, type PreviewCatalog, type PreviewUnavailableReason } from '@/lib/catalog/preview-reader';
import type { RouteBuilder } from '@/lib/catalog/routes';

/**
 * What every route under /curation/preview shares (#16). Each page, layout,
 * generateMetadata and handler calls requireCurator() itself, first, and
 * only then these.
 */

/** A draft the page can render: its ID, its RouteBuilder, and the candidate. */
export interface OpenPreview {
    draftId: string;
    routes: RouteBuilder;
    catalog: Extract<PreviewCatalog, { state: 'ok' }>;
}

/** What a preview page throws when the draft can't be read, so the preview's error page renders. */
export class PreviewUnavailableError extends Error {
    constructor(readonly reason: PreviewUnavailableReason) {
        super(`The draft preview is unavailable: ${reason}.`);
        this.name = 'PreviewUnavailableError';
    }
}

/** The page's one compile of the draft in this request, shared with its generateMetadata. */
const previewFor = cache((draftId: string) => loadPreviewCatalog(draftId));

/**
 * The draft `rawDraftId` names, for a page: a malformed ID is not-found
 * before anything is read, and so is one that isn't the current candidate.
 * Throws PreviewUnavailableError when the draft can't be read.
 */
export async function openPreview(rawDraftId: unknown): Promise<OpenPreview> {
    const draftId = previewDraftId(rawDraftId);
    if (draftId === null) notFound();
    const catalog = await previewFor(draftId);
    if (catalog.state === 'not-current') notFound();
    if (catalog.state === 'unavailable') throw new PreviewUnavailableError(catalog.reason);
    return { draftId, routes: previewRoutes(draftId), catalog };
}

/** The same for a page's generateMetadata: null where the page answers not-found or throws, so the metadata says nothing. */
export async function peekPreview(rawDraftId: unknown): Promise<OpenPreview | null> {
    const draftId = previewDraftId(rawDraftId);
    if (draftId === null) return null;
    const catalog = await previewFor(draftId);
    if (catalog.state !== 'ok') return null;
    return { draftId, routes: previewRoutes(draftId), catalog };
}

/**
 * The draft for a subresource handler (load-more, Home's records, an
 * image), which may reuse a compile from the last SUBRESOURCE_MAX_AGE_MS. A
 * malformed ID is null before anything is read.
 */
export async function previewForSubresource(rawDraftId: unknown): Promise<{ draftId: string; routes: RouteBuilder; catalog: PreviewCatalog } | null> {
    const draftId = previewDraftId(rawDraftId);
    if (draftId === null) return null;
    return { draftId, routes: previewRoutes(draftId), catalog: await loadPreviewCatalog(draftId, { maxAgeMs: SUBRESOURCE_MAX_AGE_MS }) };
}

/**
 * Every preview page's metadata: a "Preview · " title, never indexed or
 * followed, and none of the root layout's share metadata or a canonical
 * link, so nothing treats a preview as the site.
 */
export function previewMetadata(title: string | null): Metadata {
    return {
        title: title === null ? 'Preview' : `Preview · ${title}`,
        robots: { index: false, follow: false },
        openGraph: null,
        twitter: null,
        alternates: null,
    };
}

/** A preview endpoint's JSON: never stored, and no ETag, so it stays out of #15's validators. */
export function previewJson(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
    });
}
