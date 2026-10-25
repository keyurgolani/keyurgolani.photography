/**
 * Publishes the catalog Home fixture into an empty data root, for the
 * catalog-mode server in playwright.config.ts:
 *
 *   npx tsx e2e/support/publish-home-fixture.ts <empty data root outside the repository>
 *
 * createTestCatalog writes decodable derivatives, so /media serves real
 * images, and publish() activates the first revision the way the owner's
 * launch publish would. The featured series' order and opening come from
 * e2e/support/catalog-home.ts, which the specs check against.
 */
import { publish } from '../../lib/catalog/publish';
import { createTestCatalog } from '../../lib/catalog/testing';
import { HOME_OPENING, HOME_ORDER, HOME_OTHER_PHOTO_ID, HOME_PHOTO_IDS, HOME_SERIES } from './catalog-home';

const root = process.argv[2];
if (!root) throw new Error('Usage: publish-home-fixture.ts <empty data root>');

await createTestCatalog({
    root,
    withAssets: true,
    seed: 4,
    photos: [...HOME_PHOTO_IDS, HOME_OTHER_PHOTO_ID].map((id) => ({ id })),
    series: [
        { ...HOME_SERIES, photoIds: [...HOME_ORDER], openingPhotoId: HOME_OPENING },
        { slug: 'e2e-other', title: 'Another fixture series', photoIds: [HOME_OTHER_PHOTO_ID] },
    ],
    featuredSeriesIds: [HOME_SERIES.id],
});
const result = await publish({ dataRoot: root, actor: 'e2e', reason: 'fixture', confirmLaunch: true, logger: { log: () => undefined } });
if (result.outcome !== 'PUBLISHED') throw new Error(`The Home fixture didn't publish: ${result.outcome}: ${result.message} ${result.issues.map((issue) => issue.code).join(', ')}`);
console.log(`Published the Home fixture as ${result.revisionId}.`);
