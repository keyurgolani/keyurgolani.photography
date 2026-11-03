import { homeSeriesPhotosFrom } from '@/lib/catalog/projections/home';
import { getActiveCatalog } from '@/lib/catalog/public-reader';
import { catalogError, catalogJson, errorName } from '@/lib/catalog/validators';

/**
 * Home's later records (#6), across its loop of featured series (v1.5.0):
 * the named photograph of the named series and its neighbor on each side, in
 * the order Home plays them, wrapping inside the series and on into the next
 * one, from the revision Home rendered. That revision comes as `?revision=`,
 * and the route answers 409 once another one is served, so Home never mixes
 * two. It answers only for a series that is featured and published in that
 * revision, so it never lists a draft, hidden or unfeatured one.
 *
 * | answer | when |
 * | --- | --- |
 * | 404 | a malformed series or photo ID, a series that isn't featured and published, a photograph it doesn't hold, or legacy mode |
 * | 400 | no `revision`, more than one, or a malformed one |
 * | 409 | `revision` isn't the one being served, whatever the series |
 * | 503 | the catalog is unavailable |
 * | 200 | `{ revisionId, photos }`, or 304 on `If-None-Match` |
 *
 * On a 200 the body depends only on the path and the served revision, so
 * catalogJson()'s ETag fits as it is. Errors are `no-store` with no ETag.
 */
export const dynamic = 'force-dynamic';

const ROUTE = '/api/catalog/home/series/[seriesId]/photos/[photoId]';

interface Context {
    params: Promise<{ seriesId: string; photoId: string }>;
}

export async function GET(request: Request, { params }: Context): Promise<Response> {
    try {
        const { seriesId, photoId } = await params;
        const revisions = new URL(request.url).searchParams.getAll('revision');
        const result = await homeSeriesPhotosFrom(getActiveCatalog, seriesId, photoId, revisions.length === 1 ? revisions[0] : null);
        switch (result.kind) {
            case 'ok':
                return await catalogJson(request, result.window.revisionId, () => result.window);
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
