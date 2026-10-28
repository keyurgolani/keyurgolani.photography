import { NextResponse } from 'next/server';
import { legacyPhotos } from '@/lib/catalog/photos-api';
import { getActiveCatalog } from '@/lib/catalog/public-reader';
import { dataRoot } from '@/lib/storage/config';

/**
 * `GET /api/ready`: whether the public catalog can be served, and which
 * revision. 200 for `ok` and `degraded`, 503 for `unavailable`, never
 * cached, and naming no path. Before the first activation it answers for the
 * #10 registry the legacy site reads, with null revision fields. Compose
 * healthchecks stay on /api/health, which answers whenever the server does.
 */
export const dynamic = 'force-dynamic';

interface Readiness {
    mode: 'legacy' | 'catalog';
    state: 'ok' | 'degraded' | 'unavailable';
    revisionId: string | null;
    revisionNumber: number | null;
    activatedAt: string | null;
    reason?: string;
}

const NO_REVISION = { revisionId: null, revisionNumber: null, activatedAt: null };

async function readiness(): Promise<Readiness> {
    const catalog = await getActiveCatalog();
    if (catalog.mode === 'legacy') {
        const root = dataRoot();
        const photos = root === null ? { ok: false as const, reason: 'registry-missing' } : await legacyPhotos(root);
        return photos.ok ? { mode: 'legacy', state: 'ok', ...NO_REVISION } : { mode: 'legacy', state: 'unavailable', ...NO_REVISION, reason: photos.reason };
    }
    if (catalog.state === 'unavailable') return { mode: 'catalog', state: 'unavailable', ...NO_REVISION, reason: catalog.reason };
    const { revisionId, revisionNumber, activatedAt } = catalog.active;
    return { mode: 'catalog', state: catalog.state, revisionId, revisionNumber, activatedAt };
}

export async function GET(): Promise<NextResponse> {
    const body = await readiness();
    return NextResponse.json(body, {
        status: body.state === 'unavailable' ? 503 : 200,
        headers: { 'Cache-Control': 'no-store', 'X-Catalog-Mode': body.mode, ...(body.revisionId ? { 'X-Catalog-Revision': body.revisionId } : {}) },
    });
}
