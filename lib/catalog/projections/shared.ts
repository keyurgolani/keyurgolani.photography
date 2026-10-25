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
 * variant fails. Nothing here reads the catalog, and a param never reaches
 * a path. The not-found redirect rule runs it on a canonical slug too: a
 * former slug never 308s to one the route would refuse.
 */
export function seriesParams(slug: unknown): { slug: string } | null {
    if (typeof slug !== 'string') return null;
    if (slug.length > MAX_SLUG_LENGTH || !SLUG_RE.test(slug)) return null;
    return { slug };
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
 * the server-only public reader.
 */
export type ScreenCatalog<R, Reason extends string = string> =
    | { mode: 'legacy' }
    | { mode: 'catalog'; state: 'ok' | 'degraded'; reader: R }
    | { mode: 'catalog'; state: 'unavailable'; reason: Reason };
