/**
 * The catalog Home fixture, published: the featured series and a second one
 * from e2e/support/catalog-home.ts, with decodable derivatives, so /media
 * serves real images. publish() activates the first revision the way the
 * owner's launch publish would. playwright.config.ts's catalog server serves
 * it from publish-home-fixture.ts, and a spec with a server of its own
 * publishes its own copy.
 */
import { publish } from '../../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../../lib/catalog/testing';
import { HOME_OPENING, HOME_ORDER, HOME_OTHER_PHOTO_ID, HOME_PHOTO_IDS, HOME_SERIES } from './catalog-home';

/** Publishes the fixture into `root`, an empty data root outside the repository, or a temp one without it. */
export async function publishHomeFixture(root?: string): Promise<{ catalog: TestCatalog; revisionId: string }> {
    const catalog = await createTestCatalog({
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
    const result = await publish({ dataRoot: catalog.root, actor: 'e2e', reason: 'fixture', confirmLaunch: true, logger: { log: () => undefined } });
    if (result.outcome !== 'PUBLISHED' || result.revisionId === null) throw new Error(`The Home fixture didn't publish: ${result.outcome}: ${result.message} ${result.issues.map((issue) => issue.code).join(', ')}`);
    return { catalog, revisionId: result.revisionId };
}
