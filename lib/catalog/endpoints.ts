import type { SCREEN_BUDGETS } from '../perf/budgets';

/**
 * #6's catalog endpoint inventory: every JSON route that answers from a
 * catalog, the public ones under `app/api/catalog/` and #16's draft preview
 * mirrors of them, with what each takes and how it may be cached.
 * `lib/catalog/__tests__/endpoints.test.ts` globs both trees and fails on a
 * route.ts this list doesn't hold, and on one whose source doesn't do what
 * its entry says. A new catalog route adds its entry here, its path to
 * `ci/check-prerender.mjs`'s DYNAMIC_PATHS (the public ones), and a budget
 * test for its body.
 */

export interface CatalogEndpoint {
    /** The path pattern Next serves the route at, as `ci/check-prerender.mjs` lists it. */
    path: string;
    method: 'GET';
    /** The query parameters the route reads. It ignores any other. */
    query: readonly string[];
    /** The entry in lib/perf/budgets.ts its 200 body is held to. */
    budget: keyof typeof SCREEN_BUDGETS;
    /**
     * `catalog-validators`: #15's catalogJson(), a 200 with the revision's
     * weak ETag and `no-cache`, and catalogError()'s `no-store` for every
     * error. `no-store`: every answer, since nothing about a draft is cached.
     */
    cache: 'catalog-validators' | 'no-store';
    /** `public` serves the active revision. `curator-preview` serves the current candidate, behind requireCurator(). */
    audience: 'public' | 'curator-preview';
}

const PREVIEW = '/curation/preview/[draftId]/site';

/** The public routes, as the preview mirrors them. */
const PUBLIC: readonly CatalogEndpoint[] = [
    // #6's Show more: one page after the server-rendered first. The cursor is in the path, so the ETag covers it.
    { path: '/api/catalog/series/[slug]/pages/[cursor]', method: 'GET', query: [], budget: 'seriesFirstPage', cache: 'catalog-validators', audience: 'public' },
    // Home's later records as it moves, from the revision it rendered.
    { path: '/api/catalog/home/series/[seriesId]/photos/[photoId]', method: 'GET', query: ['revision'], budget: 'home', cache: 'catalog-validators', audience: 'public' },
    // The Viewer's peek beside the photograph under the finger (9a), from the revision it rendered.
    { path: '/api/catalog/series/[slug]/photos/[photoId]', method: 'GET', query: ['revision'], budget: 'viewer', cache: 'catalog-validators', audience: 'public' },
];

export const CATALOG_ENDPOINTS: readonly CatalogEndpoint[] = [
    ...PUBLIC,
    ...PUBLIC.map((entry): CatalogEndpoint => ({ ...entry, path: `${PREVIEW}${entry.path}`, cache: 'no-store', audience: 'curator-preview' })),
];
