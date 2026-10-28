import { seriesContinuationFrom } from '@/lib/catalog/projections/series';
import { getActiveCatalog, publicRoutes } from '@/lib/catalog/public-reader';
import { catalogError, catalogJson, errorName } from '@/lib/catalog/validators';

/**
 * One continuation page of a published series (#6): the entries after the
 * server-rendered first page, `SERIES_PAGE_SIZE` at a time, from the active
 * revision only. The cursor is in the path because the body depends on it
 * and catalogJson()'s ETag covers the pathname, not the query.
 *
 * | answer | when |
 * | --- | --- |
 * | 404 | a malformed, unknown, former, draft, hidden, or removed slug; legacy mode (#5's not-found set) |
 * | 400 | a malformed cursor, one for another series, or an offset out of range |
 * | 409 | the cursor's revision isn't the one being served |
 * | 503 | the catalog is unavailable |
 * | 200 | `{ revisionId, entries, nextHref }`, or 304 on `If-None-Match` |
 *
 * The 409 is checked before the series, so neither it nor the 404 says
 * whether a series the revision doesn't publish exists. Errors are
 * `no-store` with no ETag and never echo the request.
 */
export const dynamic = 'force-dynamic';

const ROUTE = '/api/catalog/series/[slug]/pages/[cursor]';

interface Context {
    params: Promise<{ slug: string; cursor: string }>;
}

export async function GET(request: Request, { params }: Context): Promise<Response> {
    try {
        const { slug, cursor } = await params;
        const result = await seriesContinuationFrom(getActiveCatalog, slug, cursor, publicRoutes);
        switch (result.kind) {
            case 'ok':
                return await catalogJson(request, result.page.revisionId, () => result.page);
            case 'not-found':
                return catalogError(404, { reason: 'not-found' });
            case 'bad-request':
                return catalogError(400, { reason: 'bad-request' });
            case 'revision-changed':
                return catalogError(409, { reason: 'revision-changed' });
            case 'unavailable':
                return catalogError(503, { reason: result.reason });
        }
    } catch (error) {
        console.error(JSON.stringify({ event: 'catalog.response.failed', route: ROUTE, error: errorName(error) }));
        return catalogError(500, { reason: 'internal' });
    }
}
