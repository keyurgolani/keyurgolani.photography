// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../test/helpers/runTsx';
import { SCREEN_BUDGETS } from '../../perf/budgets';
import { CATALOG_ENDPOINTS, type CatalogEndpoint } from '../endpoints';

// #6's endpoint inventory: every catalog JSON route, public or the draft
// preview's mirror, with its path, method, query, budget key and cache
// policy. Each route.ts under the two catalog trees must be listed, and its
// source must do what its entry says.

/** The folders a catalog JSON route can live in: the public API, and #16's preview of it. */
const TREES = ['app/api/catalog', 'app/curation/preview/[draftId]/site/api/catalog'];

/** Every route.ts under the catalog trees, as the path Next serves it at. */
function routeFiles(): Map<string, string> {
    const found = new Map<string, string>();
    for (const tree of TREES) {
        const dir = path.join(REPO_ROOT, tree);
        for (const relative of fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
            if (path.basename(relative) !== 'route.ts') continue;
            const file = path.join(tree, relative);
            found.set(`/${path.dirname(file).split(path.sep).slice(1).join('/')}`, file);
        }
    }
    return found;
}

/** ci/check-prerender.mjs's DYNAMIC_PATHS, read as text: lib/ may not import ci/, which the image build drops. */
function dynamicPaths(): string[] {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'ci', 'check-prerender.mjs'), 'utf8');
    const list = /export const DYNAMIC_PATHS = (\[[^\]]*\]);/.exec(source)?.[1];
    if (!list) throw new Error('ci/check-prerender.mjs has no DYNAMIC_PATHS list');
    return JSON.parse(list.replaceAll("'", '"')) as string[];
}

const sourceOf = (file: string) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const endpoint = (route: string): CatalogEndpoint | undefined => CATALOG_ENDPOINTS.find((entry) => entry.path === route);

describe('the catalog endpoint inventory', () => {
    const files = routeFiles();

    it('finds the catalog routes on disk', () => {
        expect(files.size).toBeGreaterThanOrEqual(6);
        expect([...files.keys()]).toContain('/api/catalog/series/[slug]/pages/[cursor]');
    });

    it('lists every catalog route, and nothing that isn\'t one', () => {
        expect(CATALOG_ENDPOINTS.map((entry) => entry.path).sort()).toEqual([...files.keys()].sort());
        expect(new Set(CATALOG_ENDPOINTS.map((entry) => entry.path)).size).toBe(CATALOG_ENDPOINTS.length);
    });

    it('fails on a route it doesn\'t list', () => {
        const unlisted = [...files.keys(), '/api/catalog/probe'].filter((route) => !endpoint(route));
        expect(unlisted).toEqual(['/api/catalog/probe']);
    });

    it.each(CATALOG_ENDPOINTS.map((entry) => [entry.path, entry] as const))('%s: the route does what its entry says', (route, entry) => {
        const file = files.get(route);
        if (!file) throw new Error(`${route} is listed but has no route.ts`);
        const source = sourceOf(file);
        // Methods: exactly the handlers the file exports.
        expect([...source.matchAll(/^export (?:async )?function (GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b/gm)].map((match) => match[1]), route).toEqual([entry.method]);
        // Query: exactly the parameters it reads.
        expect([...new Set([...source.matchAll(/searchParams\.(?:get|getAll|has)\('([^']+)'\)/g)].map((match) => match[1]))].sort(), route).toEqual([...entry.query].sort());
        // Per request, never cached by a CDN or a build.
        expect(source, route).toMatch(/^export const dynamic = 'force-dynamic';$/m);
        expect(source, route).not.toMatch(/\brevalidate\b|s-maxage|stale-while-revalidate|unstable_cache|'use cache'/);
        // The budget names an entry in lib/perf/budgets.ts.
        expect(Object.keys(SCREEN_BUDGETS), route).toContain(entry.budget);
        if (entry.cache === 'catalog-validators') {
            // #15's validators: a 200 with the revision ETag and no-cache, every error no-store.
            expect(entry.audience, route).toBe('public');
            expect(source, route).toMatch(/\bcatalogJson\(/);
            expect(source, route).toMatch(/\bcatalogError\(/);
            expect(source, route).not.toMatch(/\bpreviewJson\(/);
        } else {
            // The preview caches nothing about a draft.
            expect(entry.audience, route).toBe('curator-preview');
            expect(source, route).toMatch(/\bpreviewJson\(/);
            expect(source, route).not.toMatch(/\bcatalogJson\(/);
        }
    });

    it('has each public route in ci/check-prerender.mjs, so no build prerenders one', () => {
        const dynamic = dynamicPaths();
        for (const entry of CATALOG_ENDPOINTS.filter((candidate) => candidate.audience === 'public')) expect(dynamic, entry.path).toContain(entry.path);
        // The preview's routes are under /curation, which the list holds as a whole.
        expect(dynamic).toContain('/curation');
        for (const entry of CATALOG_ENDPOINTS.filter((candidate) => candidate.audience === 'curator-preview')) expect(entry.path.startsWith('/curation/')).toBe(true);
    });

    it('holds the continuation pages, Home\'s later records, and the Viewer\'s peek to their screens\' budgets', () => {
        expect(Object.fromEntries(CATALOG_ENDPOINTS.filter((entry) => entry.audience === 'public').map((entry) => [entry.path, [entry.method, entry.query, entry.budget, entry.cache]]))).toEqual({
            '/api/catalog/series/[slug]/pages/[cursor]': ['GET', [], 'seriesFirstPage', 'catalog-validators'],
            '/api/catalog/home/series/[seriesId]/photos/[photoId]': ['GET', ['revision'], 'home', 'catalog-validators'],
            '/api/catalog/series/[slug]/photos/[photoId]': ['GET', ['revision'], 'viewer', 'catalog-validators'],
        });
    });
});
