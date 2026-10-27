import { requireCurator } from '@/lib/curation/auth';
import { previewMediaUrls } from '@/lib/catalog/preview-reader';
import { viewerPeekFrom } from '@/lib/catalog/projections/viewer';
import { previewForSubresource, previewJson } from '../../../../../../../../preview';

/**
 * 9a's Viewer peek endpoint, mirrored inside the draft preview (#16): one
 * photograph of a draft series as the Viewer peeks at it beside the one under
 * the finger, with the public endpoint's statuses, `?revision=` being the
 * draft ID. Every answer is `no-store` with no ETag, outside #15's
 * validators, and its image paths point at the preview's media route.
 *
 * | answer | when |
 * | --- | --- |
 * | 404 | a malformed draft ID; whatever the preview's Viewer answers not-found |
 * | 400 | no `revision`, more than one, or a malformed one |
 * | 409 | the draft isn't the current candidate, or `revision` names another draft |
 * | 503 | the draft can't be read |
 * | 200 | `{ revisionId, photoId, image, accent }` |
 */
export const dynamic = 'force-dynamic';

const ROUTE = '/curation/preview/[draftId]/site/api/catalog/series/[slug]/photos/[photoId]';

interface Context {
    params: Promise<{ draftId: string; slug: string; photoId: string }>;
}

export async function GET(request: Request, { params }: Context): Promise<Response> {
    await requireCurator({ read: true });
    try {
        const { draftId, slug, photoId } = await params;
        const preview = await previewForSubresource(draftId);
        if (preview === null) return previewJson(404, { reason: 'not-found' });
        const { catalog, routes } = preview;
        if (catalog.state === 'not-current') return previewJson(409, { reason: 'revision-changed' });
        if (catalog.state === 'unavailable') return previewJson(503, { reason: catalog.reason });
        const revisions = new URL(request.url).searchParams.getAll('revision');
        const result = await viewerPeekFrom(async () => catalog, slug, photoId, revisions.length === 1 ? revisions[0] : null);
        switch (result.kind) {
            case 'ok':
                return previewJson(200, previewMediaUrls(result.peek, routes));
            case 'not-found':
                return previewJson(404, { reason: 'not-found' });
            case 'bad-request':
                return previewJson(400, { reason: 'bad-request' });
            case 'revision-changed':
                return previewJson(409, { reason: 'revision-changed' });
            case 'unavailable':
                return previewJson(503, { reason: result.reason });
        }
    } catch (error) {
        console.error(JSON.stringify({ event: 'catalog.preview.response.failed', route: ROUTE, error: error instanceof Error ? error.name : 'Error' }));
        return previewJson(500, { reason: 'internal' });
    }
}
