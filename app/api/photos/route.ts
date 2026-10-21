import { NextResponse } from 'next/server';
import { catalogPhotos, legacyPhotos, type ImageItem } from '@/lib/catalog/photos-api';
import { getActiveCatalog } from '@/lib/catalog/public-reader';
import { dataRoot } from '@/lib/storage/config';

/**
 * The photo list the legacy Gallery and Home read, as a bare array. Before
 * the first activation it comes from the #10 registry, and after it from the
 * active revision, with no fallback either way. Every response names its
 * mode and revision, and nothing here is prerendered or cached.
 */
export const dynamic = 'force-dynamic';

function listed(items: ImageItem[], mode: 'legacy' | 'catalog', revision: string): NextResponse {
    return NextResponse.json(items, {
        headers: { 'Cache-Control': 'no-cache', 'X-Catalog-Mode': mode, 'X-Catalog-Revision': revision },
    });
}

function unavailable(mode: 'legacy' | 'catalog', reason: string): NextResponse {
    return NextResponse.json({ reason }, { status: 503, headers: { 'Cache-Control': 'no-store', 'X-Catalog-Mode': mode } });
}

export async function GET(): Promise<NextResponse> {
    const catalog = await getActiveCatalog();
    if (catalog.mode === 'legacy') {
        const root = dataRoot();
        const photos = root === null ? { ok: false as const, reason: 'registry-missing' } : await legacyPhotos(root);
        return photos.ok ? listed(photos.items, 'legacy', 'legacy') : unavailable('legacy', photos.reason);
    }
    if (catalog.state === 'unavailable') return unavailable('catalog', catalog.reason);
    return listed(catalogPhotos(catalog.reader), 'catalog', catalog.active.revisionId);
}
