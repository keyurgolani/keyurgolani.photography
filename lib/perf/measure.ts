import { gzipSync } from 'node:zlib';
import { homeRouteOf } from '../catalog/projections/home';
import { viewerPeekOf } from '../catalog/projections/viewer';
import { createRouteBuilder, type CatalogReader, type RouteBuilder } from '../catalog/reader';
import { SCREEN_BUDGETS, type Screen } from './budgets';
import type { CatalogBudgetMeasurement, CatalogBudgetRow, CatalogBudgetScreen } from './catalog-budgets';

/** A read model's size as it would leave the server. Node only. */
export interface PayloadSize {
    /** UTF-8 bytes of `JSON.stringify(model)`. */
    bytes: number;
    /** The same bytes through `gzipSync` at zlib's default level. */
    gzipBytes: number;
}

export function payloadSize(model: unknown): PayloadSize {
    const json = Buffer.from(JSON.stringify(model), 'utf8');
    return { bytes: json.length, gzipBytes: gzipSync(json).length };
}

/** A shipped image: anything in a model that carries a variant ladder. */
export interface ShippedImage {
    width: unknown;
    height: unknown;
    variants: unknown;
}

/** Every image in `model`, depth first, so a test can count photo records and check their geometry. */
export function imagesIn(model: unknown): ShippedImage[] {
    const found: ShippedImage[] = [];
    const walk = (value: unknown) => {
        if (Array.isArray(value)) {
            value.forEach(walk);
        } else if (typeof value === 'object' && value !== null) {
            if ('variants' in value) found.push(value as ShippedImage);
            Object.values(value).forEach(walk);
        }
    };
    walk(model);
    return found;
}

/** How many arrays `model` holds at any depth, itself included, so a test can tell a sequence from a single record. */
export function arraysIn(model: unknown): number {
    let count = 0;
    const walk = (value: unknown) => {
        if (Array.isArray(value)) {
            count += 1;
            value.forEach(walk);
        } else if (typeof value === 'object' && value !== null) {
            Object.values(value).forEach(walk);
        }
    };
    walk(model);
    return count;
}

/**
 * Each screen's read models for one catalog, measured against `budgets`:
 * Home from each featured series it can open on, Work, every series' first
 * response and continuation page, and every photograph's Viewer. Keeps the
 * largest of each kind and every model over its budget, and works out Home's
 * cost per featured photograph (limit 25). The Vitest budgets and
 * `npm run test:budgets` read it on the fixture, and `photos validate` on the
 * candidate, through budgets-cli.ts. It reaches the projections, which carry
 * `server-only`: plain Node loads it only through that child.
 */
export function measureCatalogBudgets(reader: CatalogReader, options: { budgets?: typeof SCREEN_BUDGETS; routes?: RouteBuilder } = {}): CatalogBudgetMeasurement {
    const budgets = options.budgets ?? SCREEN_BUDGETS;
    const routes = options.routes ?? createRouteBuilder();
    const screens = Object.fromEntries((['home', 'work', 'seriesFirstPage', 'seriesContinuationPage', 'viewer', 'viewerPeek'] as const).map((screen) => [screen, { count: 0, largest: null }])) as CatalogBudgetMeasurement['screens'];
    const over: CatalogBudgetRow[] = [];
    const measure = (screen: CatalogBudgetScreen, budget: Screen, subject: string, model: unknown): CatalogBudgetRow => {
        const size = payloadSize(model);
        const row: CatalogBudgetRow = { screen, budget, subject, records: imagesIn(model).length, ...size, limit: budgets[budget].gzipBytes };
        const entry = screens[screen];
        entry.count += 1;
        if (!entry.largest || row.gzipBytes > entry.largest.gzipBytes) entry.largest = row;
        if (row.gzipBytes > row.limit) over.push(row);
        return row;
    };

    // Home: one model per featured series it can open on, since each opens on its own three records.
    let home: CatalogBudgetMeasurement['home'] = null;
    const homeOf = (start: number) => {
        const result = homeRouteOf({ state: 'ok', reader }, routes, (count) => Math.min(start, count - 1));
        if (result.kind !== 'home') throw new Error(`Home answered ${result.kind}`);
        return result.home;
    };
    const first = homeOf(0);
    const starts = first.featuredSeries ? 1 + (first.followingSeries?.length ?? 0) : 1;
    for (let start = 0; start < starts; start += 1) {
        const model = start === 0 ? first : homeOf(start);
        const loop = model.featuredSeries ? [model.featuredSeries, ...(model.followingSeries ?? [])] : [];
        const featuredPhotos = loop.reduce((sum, series) => sum + series.photoIds.length, 0);
        const row = measure('home', 'home', `${featuredPhotos.toLocaleString('en-US')} featured photographs`, model);
        if (start === 0 && featuredPhotos > 0) {
            // What the ID lists cost: the model against itself with every list emptied.
            const bytesPerPhoto = (row.gzipBytes - payloadSize(withoutPhotoIds(model)).gzipBytes) / featuredPhotos;
            const photosAtBudget = featuredPhotos + Math.floor((budgets.home.gzipBytes - row.gzipBytes) / bytesPerPhoto);
            home = { featuredPhotos, bytesPerPhoto: Math.round(bytesPerPhoto * 10) / 10, photosAtBudget };
        }
    }

    measure('work', 'work', `${reader.listSeries().length.toLocaleString('en-US')} series`, reader.getWorkSummaries(routes));

    for (const series of reader.listSeries()) {
        const firstPage = reader.getSeriesPage(series.slug, routes);
        if (firstPage.kind !== 'ok') continue;
        measure('seriesFirstPage', 'seriesFirstPage', series.slug, firstPage.page);
        let shown = firstPage.page.entries.length;
        let nextHref = firstPage.page.nextHref;
        while (nextHref !== null) {
            const page = reader.getSeriesContinuation(series.slug, nextHref.slice(nextHref.lastIndexOf('/') + 1), routes);
            if (page.kind !== 'ok') break;
            const { entries } = page.page;
            measure('seriesContinuationPage', 'seriesContinuationPage', `${series.slug}, photographs ${shown + 1} to ${shown + entries.length}`, page.page);
            shown += entries.length;
            nextHref = page.page.nextHref;
        }
        for (const photo of reader.photosOf(series.id)) {
            const viewer = reader.getViewerPhoto(series.slug, photo.id);
            if (viewer.kind !== 'ok') continue;
            measure('viewer', 'viewer', photo.id, viewer.viewer);
            // The peek endpoint's body for the same photograph (/api/catalog/series/<slug>/photos/<photoId>).
            measure('viewerPeek', 'viewer', photo.id, viewerPeekOf(viewer.viewer));
        }
    }
    return { revisionId: reader.revision().revisionId, screens, over, home };
}

/** `model` with every `photoIds` array emptied, at any depth. */
function withoutPhotoIds(model: unknown): unknown {
    if (Array.isArray(model)) return model.map(withoutPhotoIds);
    if (typeof model !== 'object' || model === null) return model;
    return Object.fromEntries(Object.entries(model).map(([key, value]) => [key, key === 'photoIds' && Array.isArray(value) ? [] : withoutPhotoIds(value)]));
}
