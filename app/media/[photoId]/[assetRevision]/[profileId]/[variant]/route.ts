import { getActiveCatalog, isAssetPublic } from '@/lib/catalog/public-reader';
import { activeRevisionAccess } from '@/lib/media/access';
import { createMediaHandler } from '@/lib/media/handler';

/**
 * Derivative sets from the data root, public only while the catalog revision
 * being served holds them, so nothing is public before the first activation.
 * See lib/media/handler.ts.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = createMediaHandler({
    access: activeRevisionAccess(async ({ photoId, assetRevision, profileId }) => isAssetPublic(photoId, assetRevision, profileId, await getActiveCatalog())),
});
