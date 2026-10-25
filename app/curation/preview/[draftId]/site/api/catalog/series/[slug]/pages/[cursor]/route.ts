import { requireCurator } from '@/lib/curation/auth';
import { previewMediaUrls } from '@/lib/catalog/preview-reader';
import { seriesContinuationFrom } from '@/lib/catalog/projections/series';
import { previewForSubresource, previewJson } from '../../../../../../../../preview';

/**
 * #6's continuation endpoint, mirrored inside the draft preview (#16): the
 * same projection on the candidate, with the public endpoint's statuses, so
 * #6's Show more behaves the same. Every answer is `no-store` with no ETag:
 * it stays out of #15's validators, and nothing about a draft is cached.
 *
 * | answer | when |
 * | --- | --- |
 * | 404 | a malformed draft ID; a malformed, unknown, former, draft, hidden, or removed slug |
 * | 400 | a malformed cursor, one for another series, or an offset out of range |
 * | 409 | the draft isn't the current candidate, or the cursor names another draft |
 * | 503 | the draft can't be read |
 * | 200 | `{ revisionId, entries, nextHref }`, `revisionId` the draft ID |
 */
export const dynamic = 'force-dynamic';

const ROUTE = '/curation/preview/[draftId]/site/api/catalog/series/[slug]/pages/[cursor]';

interface Context {
    params: Promise<{ draftId: string; slug: string; cursor: string }>;
}

export async function GET(_request: Request, { params }: Context): Promise<Response> {
    await requireCurator({ read: true });
    try {
        const { draftId, slug, cursor } = await params;
        const preview = await previewForSubresource(draftId);
        if (preview === null) return previewJson(404, { reason: 'not-found' });
        const { catalog, routes } = preview;
        if (catalog.state === 'not-current') return previewJson(409, { reason: 'revision-changed' });
        if (catalog.state === 'unavailable') return previewJson(503, { reason: catalog.reason });
        const result = await seriesContinuationFrom(async () => catalog, slug, cursor, routes);
        switch (result.kind) {
            case 'ok':
                return previewJson(200, previewMediaUrls(result.page, routes));
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
