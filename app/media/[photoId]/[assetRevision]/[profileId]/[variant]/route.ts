import { getActiveCatalog, isAssetPublic } from '@/lib/catalog/public-reader';
import { createTombstoneIndex } from '@/lib/catalog/tombstones';
import { activeRevisionAccess, withTombstones } from '@/lib/media/access';
import { createMediaHandler } from '@/lib/media/handler';
import { dataRoot } from '@/lib/storage/config';

/**
 * Derivative sets from the data root, public only while the catalog revision
 * being served holds them, so nothing is public before the first activation.
 * A set a standing tombstone lists answers 410, `no-store` (#15's purge). See
 * lib/media/handler.ts.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const isTombstoned = createTombstoneIndex({ root: dataRoot });

export const GET = createMediaHandler({
    access: withTombstones(isTombstoned, activeRevisionAccess(async ({ photoId, assetRevision, profileId }) => isAssetPublic(photoId, assetRevision, profileId, await getActiveCatalog()))),
});
