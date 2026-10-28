/**
 * Publish a small test catalog, with decodable assets, into an empty data
 * root, for the smoke tests:
 *
 *   npx tsx ci/publish-fixture.ts <empty data root>
 *
 * Prints one JSON line: the revision it activated, the `/media` URL of a set
 * that revision holds, and that of a set whose files exist but which no
 * revision holds, a photo of a draft series, so it must 404. Never touches
 * the real data root: the root has to be empty and outside this repository.
 */
import { publish } from '../lib/catalog/publish';
import { createTestCatalog } from '../lib/catalog/testing';
import { mediaUrl } from '../lib/media/url';

async function main(): Promise<number> {
    const root = process.argv[2];
    if (!root) {
        console.error('Usage: npx tsx ci/publish-fixture.ts <empty data root>');
        return 2;
    }
    const catalog = await createTestCatalog({ root, withAssets: true, photos: 3, series: [{ photos: 2 }, { photos: 1, visibility: 'draft' }] });
    const outcome = await publish({ dataRoot: catalog.root, actor: 'ci', confirmLaunch: true, logger: { log: () => undefined } });
    if (outcome.outcome !== 'PUBLISHED') {
        console.error(`Publishing the fixture failed: ${outcome.outcome}: ${outcome.message}`);
        return 1;
    }
    const active = catalog.content.photos[0];
    const inactive = catalog.photos.find((photo) => !catalog.content.photos.some((published) => published.id === photo.id));
    if (!active || !inactive) {
        console.error('The fixture has no published photo, or no unpublished one.');
        return 1;
    }
    console.log(JSON.stringify({
        revisionId: outcome.revisionId,
        active: mediaUrl({ photoId: active.id, assetRevision: active.assetRevision, profileId: active.profileId }, 'w800', 'webp'),
        inactive: mediaUrl({ photoId: inactive.id, assetRevision: inactive.assetRevision, profileId: catalog.profileId }, 'w800', 'webp'),
    }));
    return 0;
}

main().then((code) => {
    process.exitCode = code;
}, (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
