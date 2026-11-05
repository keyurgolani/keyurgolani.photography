/**
 * Publish a small test catalog, with decodable assets, into an empty data
 * root, for the smoke tests:
 *
 *   npx tsx ci/publish-fixture.ts <empty data root>
 *
 * It publishes twice: the launch, then a second revision (#15's A11) that
 * retitles the published series, so both revisions hold the same sets and
 * `photos rollback --to 1` has somewhere to go. Prints one JSON line: the
 * live revision, the second, as `revisionId`, the first as
 * `firstRevisionId`, the `/media` URL of a set both revisions hold, that of
 * a set whose files exist but which no revision holds, a photo of a draft
 * series, so it must 404, and the IDs of the featured series and of a photo
 * in it, for #6's Home records endpoint. Never touches the real data root:
 * the root has to be empty and outside this repository.
 */
import { publish } from '../lib/catalog/publish';
import { createTestCatalog } from '../lib/catalog/testing';
import { readAuthoredRecord } from '../lib/catalog/working-layer';
import { writeAuthoredRecord } from '../lib/catalog/working-layer-writer';
import { mediaUrl } from '../lib/media/url';

async function main(): Promise<number> {
    const root = process.argv[2];
    if (!root) {
        console.error('Usage: npx tsx ci/publish-fixture.ts <empty data root>');
        return 2;
    }
    const catalog = await createTestCatalog({ root, withAssets: true, photos: 3, series: [{ photos: 2 }, { photos: 1, visibility: 'draft' }] });
    const logger = { log: () => undefined };
    const first = await publish({ dataRoot: catalog.root, actor: 'ci', confirmLaunch: true, logger });
    if (first.outcome !== 'PUBLISHED') {
        console.error(`Publishing the fixture failed: ${first.outcome}: ${first.message}`);
        return 1;
    }
    // The second revision changes only a title, so every set the first holds, the second holds too, and no other.
    const shownId = catalog.content.series[0]?.id;
    const shown = shownId ? await readAuthoredRecord(catalog.root, 'series', shownId) : null;
    if (!shown) {
        console.error('The fixture has no published series to retitle.');
        return 1;
    }
    await writeAuthoredRecord({ ...shown, title: `${shown.title}, revision 2` }, { expectedVersion: shown.version, root: catalog.root });
    const outcome = await publish({ dataRoot: catalog.root, actor: 'ci', reason: 'fixture revision 2', logger });
    if (outcome.outcome !== 'PUBLISHED') {
        console.error(`Publishing the fixture's second revision failed: ${outcome.outcome}: ${outcome.message}`);
        return 1;
    }
    const active = catalog.content.photos[0];
    const inactive = catalog.photos.find((photo) => !catalog.content.photos.some((published) => published.id === photo.id));
    const featuredSeries = catalog.content.site.featuredSeriesIds[0];
    const featured = catalog.content.series.find((series) => series.id === featuredSeries)?.photoIds[0];
    if (!active || !inactive || !featured) {
        console.error('The fixture has no published photo, no unpublished one, or no featured photo.');
        return 1;
    }
    console.log(JSON.stringify({
        revisionId: outcome.revisionId,
        firstRevisionId: first.revisionId,
        active: mediaUrl({ photoId: active.id, assetRevision: active.assetRevision, profileId: active.profileId }, 'w800', 'webp'),
        inactive: mediaUrl({ photoId: inactive.id, assetRevision: inactive.assetRevision, profileId: catalog.profileId }, 'w800', 'webp'),
        featuredSeries,
        featured,
    }));
    return 0;
}

main().then((code) => {
    process.exitCode = code;
}, (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
