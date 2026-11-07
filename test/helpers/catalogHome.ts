/**
 * The published catalog the catalog Home browser tests serve, shared by
 * e2e/support/publish-home-fixture.ts, which publishes it, and
 * e2e/home-catalog.spec.ts, which checks it. Pure data, so the spec imports
 * none of the catalog code.
 */

/** The catalog-mode server playwright.config.ts starts. */
export const CATALOG_ORIGIN = `http://127.0.0.1:${process.env.E2E_CATALOG_PORT || '3101'}`;

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Four photographs, in ID order, which is also their capture order. */
export const HOME_PHOTO_IDS = [id(1), id(2), id(3), id(4)] as const;

/** The one photograph of a second, unfeatured series. */
export const HOME_OTHER_PHOTO_ID = id(5);

/** The featured series' authored order, which ID order and capture dates both disagree with. */
export const HOME_ORDER = [id(3), id(1), id(4), id(2)] as const;

/** It opens on the third authored photograph. */
export const HOME_OPENING = id(4);

export const HOME_SERIES = {
    id: 'ser_e2e-featured',
    slug: 'e2e-featured',
    title: 'Fixture series for Home',
    shortStatement: 'A fixture statement, in plain text.',
} as const;

/**
 * #4's framing (v2.0.0 B7), for e2e/home-framing.spec.ts: the Home fixture with the opening photograph cropped to
 * `contain`, and the one after it framed on a focal point. Only publishHomeFramingFixture() in homeFixture.ts
 * publishes them, so every other Home spec, Dark parity's included, keeps centred cover crops.
 */
export const HOME_FRAMING = {
    contain: HOME_OPENING,
    /**
     * The contain opening's size: 1500 by 2400, so createTestCatalog's 20 px LQIP comes out 13 by 20, a little wider
     * than the print, and a pillarboxed contain slide that kept it would show it either side of the print.
     */
    containSize: { width: 1500, height: 2400 },
    focal: { photoId: HOME_ORDER[(HOME_ORDER.indexOf(HOME_OPENING) + 1) % HOME_ORDER.length], focalPoint: { x: 0.25, y: 0.75 } },
} as const;

/** The reviewed alt createTestCatalog writes for the photograph at `index` in its photo list. */
const fixtureAlt = (index: number) => `Fixture description of photograph ${String(index + 1).padStart(4, '0')}.`;

/** The alt of a photograph by ID. */
export const altOf = (photoId: string) => fixtureAlt(HOME_PHOTO_IDS.findIndex((other) => other === photoId));

/**
 * Home's loop of featured series (v1.5.0), for e2e/home-variety.spec.ts:
 * three featured series, in this order, each opening somewhere else in its
 * own order. publishHomeVarietyFixture() in homeFixture.ts publishes them.
 */
export const VARIETY_SERIES = [
    { id: 'ser_e2e-variety-one', slug: 'e2e-variety-one', title: 'Variety series one', shortStatement: 'The first featured series.', photoIds: [id(101), id(102), id(103)], openingPhotoId: id(102) },
    { id: 'ser_e2e-variety-two', slug: 'e2e-variety-two', title: 'Variety series two', shortStatement: 'The second featured series.', photoIds: [id(104), id(105)], openingPhotoId: id(104) },
    { id: 'ser_e2e-variety-three', slug: 'e2e-variety-three', title: 'Variety series three', shortStatement: 'The third featured series.', photoIds: [id(106), id(107), id(108)], openingPhotoId: id(108) },
] as const;

/** A published series that isn't featured, which Home never plays. */
export const VARIETY_UNFEATURED = { id: 'ser_e2e-variety-other', slug: 'e2e-variety-other', title: 'Variety series, not featured', photoIds: [id(109)] } as const;

/** Every photograph the variety fixture publishes, in its photo list's order. */
export const VARIETY_PHOTO_IDS = [...VARIETY_SERIES.flatMap((series) => series.photoIds), ...VARIETY_UNFEATURED.photoIds];

/** The alt of a variety fixture photograph by ID. */
export const varietyAltOf = (photoId: string) => fixtureAlt(VARIETY_PHOTO_IDS.indexOf(photoId));
