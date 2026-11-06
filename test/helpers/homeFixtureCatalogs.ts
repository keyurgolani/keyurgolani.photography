/**
 * The Home and variety fixtures' catalogs, as e2e/support/homeFixture.ts publishes them, less their root. Here, not
 * under e2e/, so a unit test can use them: the image build type-checks every test and leaves e2e/ out.
 */
import type { TestCatalogOptions } from '../../lib/catalog/testing';
import { HOME_OPENING, HOME_ORDER, HOME_OTHER_PHOTO_ID, HOME_PHOTO_IDS, HOME_SERIES, VARIETY_PHOTO_IDS, VARIETY_SERIES, VARIETY_UNFEATURED } from './catalogHome';

/** The Home fixture's catalog, as publishHomeFixture() creates it, less its root. */
export const HOME_FIXTURE_CATALOG = {
    withAssets: true,
    seed: 4,
    photos: [...HOME_PHOTO_IDS, HOME_OTHER_PHOTO_ID].map((id) => ({ id })),
    series: [
        { ...HOME_SERIES, photoIds: [...HOME_ORDER], openingPhotoId: HOME_OPENING },
        { slug: 'e2e-other', title: 'Another fixture series', photoIds: [HOME_OTHER_PHOTO_ID] },
    ],
    featuredSeriesIds: [HOME_SERIES.id],
} satisfies TestCatalogOptions;

/** The variety fixture's catalog, as publishHomeVarietyFixture() creates it, less its root. */
export const VARIETY_FIXTURE_CATALOG = {
    withAssets: true,
    seed: 5,
    photos: VARIETY_PHOTO_IDS.map((id) => ({ id })),
    series: [{ ...VARIETY_UNFEATURED, photoIds: [...VARIETY_UNFEATURED.photoIds] }, ...VARIETY_SERIES.map((series) => ({ ...series, photoIds: [...series.photoIds] }))],
    featuredSeriesIds: VARIETY_SERIES.map((series) => series.id),
} satisfies TestCatalogOptions;
