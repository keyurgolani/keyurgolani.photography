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

/** The reviewed alt createTestCatalog writes for the photograph at `index` in its photo list. */
const fixtureAlt = (index: number) => `Fixture description of photograph ${String(index + 1).padStart(4, '0')}.`;

/** The alt of a photograph by ID. */
export const altOf = (photoId: string) => fixtureAlt(HOME_PHOTO_IDS.findIndex((other) => other === photoId));
