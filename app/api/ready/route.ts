import { NextResponse } from 'next/server';
import { getActiveCatalog } from '@/lib/catalog/public-reader';

/**
 * `GET /api/ready`: whether the public catalog can be served, and which
 * revision. 200 for `ok` and `degraded`, 503 for `unavailable`, never
 * cached, and naming no path. Before the first activation, or with no data
 * root, it answers 503 with `not-published` and null revision fields: since
 * #13's slice E there is no legacy site to report on. `mode` is always
 * `catalog` now, kept so a check written against an earlier release still
 * reads it. Compose healthchecks stay on /api/health, which answers whenever
 * the server does.
 */
export const dynamic = 'force-dynamic';

interface Readiness {
    mode: 'catalog';
    state: 'ok' | 'degraded' | 'unavailable';
    revisionId: string | null;
    revisionNumber: number | null;
    activatedAt: string | null;
    reason?: string;
}

const NO_REVISION = { revisionId: null, revisionNumber: null, activatedAt: null };

async function readiness(): Promise<Readiness> {
    const catalog = await getActiveCatalog();
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
