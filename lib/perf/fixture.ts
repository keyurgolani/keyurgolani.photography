import { buildTestCatalog, type TestCatalogContent, type TestCatalogOptions, type VariantByteTable } from '../catalog/testing';

/**
 * #6's large fixture library: 5,000 photographs across 100 series, built by
 * #13's test catalog with declared variant sizes, so no image data exists or
 * goes into Git. Test-only; nothing in the app imports it. The first series
 * holds 250 photographs and is featured (the helper's default), so the
 * Series page bound and Home's narrowing have something to bind (#6 PR 2):
 * three pages of 100, 100, and 50, and a featured sequence far longer than
 * Home's three records. The other 99 split the remaining 4,750 (47 or 48
 * each), with the helper's obvious fixture copy.
 */

/** The featured series' size: more than two pages, so there's a page between the first and the last. */
export const LONG_SERIES_PHOTOS = 250;

const KIB = 1024;

/** Declared AVIF and WebP sizes per rung, in bytes, from #6's refined fixture table. Screens don't ship them (see ladder.ts). */
export const BUDGET_VARIANT_BYTES: VariantByteTable = {
    w400: { avif: 30 * KIB, webp: 42 * KIB },
    w800: { avif: 90 * KIB, webp: 126 * KIB },
    w1200: { avif: 170 * KIB, webp: 238 * KIB },
    w1920: { avif: 350 * KIB, webp: 490 * KIB },
};

export const BUDGET_FIXTURE = {
    photos: 5_000,
    series: [{ photos: LONG_SERIES_PHOTOS }, ...Array.from({ length: 99 }, () => ({}))],
    seed: 6,
    variantBytes: BUDGET_VARIANT_BYTES,
} as const satisfies TestCatalogOptions;

/**
 * The fixture's content and reader, in memory, for the Vitest budgets.
 * `createTestCatalog(BUDGET_FIXTURE)` writes the same catalog to a data
 * root, manifests and sparse variant files included, for a browser run;
 * that's about 45,000 files and takes minutes on a loaded machine.
 */
export function buildBudgetFixture(): Promise<TestCatalogContent> {
    return buildTestCatalog(BUDGET_FIXTURE);
}
