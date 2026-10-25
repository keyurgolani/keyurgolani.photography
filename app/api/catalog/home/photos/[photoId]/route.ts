import { homePhotosFrom } from '@/lib/catalog/projections/home';
import { getActiveCatalog } from '@/lib/catalog/public-reader';
import { catalogError, catalogJson, errorName } from '@/lib/catalog/validators';

/**
 * Home's later records (#6): the named photograph of the featured series and
 * its neighbor on each side, in authored order, wrapping as Home does, from
 * the revision Home rendered. That revision comes as `?revision=`, and the
 * route answers 409 once another one is served, so Home never mixes two.
 *
 * | answer | when |
 * | --- | --- |
 * | 404 | a malformed photo ID, one the featured series doesn't hold, nothing featured, or legacy mode |
 * | 400 | no `revision`, more than one, or a malformed one |
 * | 409 | `revision` isn't the one being served |
 * | 503 | the catalog is unavailable |
 * | 200 | `{ revisionId, photos }`, or 304 on `If-None-Match` |
 *
 * On a 200 the body depends only on the path and the served revision, so
 * catalogJson()'s ETag fits as it is. Errors are `no-store` with no ETag.
 */
export const dynamic = 'force-dynamic';

const ROUTE = '/api/catalog/home/photos/[photoId]';

interface Context {
    params: Promise<{ photoId: string }>;
}

export async function GET(request: Request, { params }: Context): Promise<Response> {
    try {
        const { photoId } = await params;
        const revisions = new URL(request.url).searchParams.getAll('revision');
        const result = await homePhotosFrom(getActiveCatalog, photoId, revisions.length === 1 ? revisions[0] : null);
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
