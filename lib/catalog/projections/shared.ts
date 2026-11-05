import { MAX_SLUG_LENGTH, SLUG_RE } from '../schema';
import type { FocalPoint, SeriesRecord } from '../types';

/**
 * The guards and series rules every screen projection shares, so Home, Work,
 * the series page, and the Viewer read a record the same way. Pure, and no
 * `server-only`: the projections that import it carry that line themselves,
 * and client code takes only types from them.
 */

/** The focal point a photo without a usable one gets. */
export const CENTER: FocalPoint = Object.freeze({ x: 0.5, y: 0.5 });

/** Authored text only when it holds something. */
export function text(value: unknown): string | null {
    return typeof value === 'string' && /\S/.test(value) ? value : null;
}

/** An authored focal point when both coordinates fall in 0 to 1, else null. */
export function focal(value: unknown): FocalPoint | null {
    if (typeof value !== 'object' || value === null) return null;
    const { x, y } = value as Record<string, unknown>;
    const unit = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
    return unit(x) && unit(y) ? { x, y } : null;
}

/** A positive integer: a size, a byte count, or a published count. */
export const dimension = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

/**
 * A series slug param when it is in #13's shape. Exact, so a letter-case
 * variant fails: the continuation endpoint and the peek take only the
 * canonical slug, and routeSlug() is the routes' own check. Nothing here
 * reads the catalog, and a param never reaches a path. The not-found
 * redirect rule runs it on a canonical slug too: a former slug never 308s to
 * one the route would refuse.
 */
export function seriesParams(slug: unknown): { slug: string } | null {
    if (typeof slug !== 'string') return null;
    if (slug.length > MAX_SLUG_LENGTH || !SLUG_RE.test(slug)) return null;
    return { slug };
}

/**
 * `value` with its ASCII letters lowered and nothing else touched. Not
 * toLowerCase(), which folds the Kelvin sign into `k` and `İ` into two
 * characters, so only a plain letter-case variant ever folds onto a slug or
 * a photo ID.
 */
export function foldLetterCase(value: string): string {
    return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * The series slug a route param names, letter case aside (#5, decided: a
 * letter-case variant answers 308 to the canonical URL): seriesParams() on
 * the folded param, and whether the param was already that. Null for
 * anything seriesParams() refuses once folded, so a malformed param still
 * never reads the catalog. The folded slug only looks a series up; a
 * redirect's Location is always the series' own slug.
 */
export function routeSlug(slug: unknown): { slug: string; exact: boolean } | null {
    if (typeof slug !== 'string') return null;
    const params = seriesParams(foldLetterCase(slug));
    return params === null ? null : { slug: params.slug, exact: params.slug === slug };
}

/** What openableSeries() reads. Every screen's source has it. */
export interface OpenableSource {
    listSeries(): readonly SeriesRecord[];
    photosOf(seriesId: string): readonly unknown[];
}

/**
 * Whether #5's series page would open this series: its ID appears once,
 * its published count is a positive integer, and at least one member
 * resolves. Work lists only these, the series page and the Viewer answer
 * not-found for any other, and Home shows its empty state. Compile never
 * writes anything else; a hand-written revision can. A repeated ID matters
 * because the reader indexes members by ID, so two records under one ID
 * would pair one record's copy with the other's photos.
 */
export function openableSeries(source: OpenableSource, series: SeriesRecord): boolean {
    if (source.listSeries().filter((record) => record.id === series.id).length !== 1) return false;
    if (!dimension(series.derived?.photoCount)) return false;
    // order.duplicate-photo blocks a repeated member at render, so no preview or revision holds one.
    return source.photosOf(series.id).length > 0;
}

/**
 * The parts of #13's ActiveCatalog a screen's route reads, with the reader
 * narrowed to what that screen calls (`R`), so a projection stays clear of
 * the server-only public reader. There is no legacy mode since #13's slice E:
 * a site with nothing published is `unavailable` too.
 */
export type ScreenCatalog<R, Reason extends string = string> =
    | { state: 'ok' | 'degraded'; reader: R }
    | { state: 'unavailable'; reason: Reason };
