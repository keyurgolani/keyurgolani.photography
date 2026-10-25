import { NextResponse } from 'next/server';
import { catalogPhotos, legacyPhotos, type ImageItem } from '@/lib/catalog/photos-api';
import { getActiveCatalog } from '@/lib/catalog/public-reader';
import { catalogError, catalogJson, errorName } from '@/lib/catalog/validators';
import { dataRoot } from '@/lib/storage/config';

/**
 * The photo list the legacy Gallery and Home read, as a bare array. Before
 * the first activation it comes from the #10 registry, and after it from the
 * active revision, with no fallback either way. Every response names its
 * mode and revision, and nothing here is prerendered or cached by Next.
 * Catalog mode sends a revision ETag and answers `If-None-Match` with 304
 * (lib/catalog/validators.ts). Legacy mode sends `no-cache` and no ETag.
 */
export const dynamic = 'force-dynamic';

function legacyListed(items: ImageItem[]): NextResponse {
    return NextResponse.json(items, {
        headers: { 'Cache-Control': 'no-cache', 'X-Catalog-Mode': 'legacy', 'X-Catalog-Revision': 'legacy' },
    });
}

function unavailable(mode: 'legacy' | 'catalog', reason: string): Response {
    return catalogError(503, { reason }, { 'X-Catalog-Mode': mode });
}

/** Anything the route doesn't handle, in either mode, gets a 500 with `no-store` and no ETag, not Next's bare 500. */
export async function GET(request: Request): Promise<Response> {
    let mode: 'legacy' | 'catalog' | undefined;
    try {
        const catalog = await getActiveCatalog();
        mode = catalog.mode;
        if (catalog.mode === 'legacy') {
            const root = dataRoot();
            const photos = root === null ? { ok: false as const, reason: 'registry-missing' } : await legacyPhotos(root);
            return photos.ok ? legacyListed(photos.items) : unavailable('legacy', photos.reason);
        }
        if (catalog.state === 'unavailable') return unavailable('catalog', catalog.reason);
        return await catalogJson(request, catalog.active.revisionId, () => catalogPhotos(catalog.reader), { headers: { 'X-Catalog-Mode': 'catalog' } });
    } catch (error) {
        console.error(JSON.stringify({ event: 'catalog.response.failed', route: '/api/photos', error: errorName(error) }));
        return catalogError(500, { reason: 'internal' }, mode === undefined ? {} : { 'X-Catalog-Mode': mode });
    }
}
