import { viewerPeekFrom } from '@/lib/catalog/projections/viewer';
import { getActiveCatalog } from '@/lib/catalog/public-reader';
import { catalogError, catalogJson, errorName } from '@/lib/catalog/validators';

/**
 * One photograph of a published series as the Viewer peeks at it beside the
 * one under the finger (9a): its derivative set and accent, from the
 * revision the Viewer rendered. That revision comes as `?revision=`, and the
 * route answers 409 once another one is served, so the peek never shows a
 * photograph from another revision. The Viewer asks only after a visitor
 * touches the photograph, never on a first load (#6).
 *
 * | answer | when |
 * | --- | --- |
 * | 404 | whatever the Viewer route answers not-found, a former slug, or legacy mode |
 * | 400 | no `revision`, more than one, or a malformed one |
 * | 409 | `revision` isn't the one being served |
 * | 503 | the catalog is unavailable |
 * | 200 | `{ revisionId, photoId, image, accent }`, or 304 on `If-None-Match` |
 *
 * On a 200 the body depends only on the path and the served revision, so
 * catalogJson()'s ETag fits as it is. Errors are `no-store` with no ETag and
 * never echo the request.
 */
export const dynamic = 'force-dynamic';

const ROUTE = '/api/catalog/series/[slug]/photos/[photoId]';

interface Context {
    params: Promise<{ slug: string; photoId: string }>;
}

export async function GET(request: Request, { params }: Context): Promise<Response> {
    try {
        const { slug, photoId } = await params;
        const revisions = new URL(request.url).searchParams.getAll('revision');
        const result = await viewerPeekFrom(getActiveCatalog, slug, photoId, revisions.length === 1 ? revisions[0] : null);
        switch (result.kind) {
            case 'ok':
                return await catalogJson(request, result.peek.revisionId, () => result.peek);
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
