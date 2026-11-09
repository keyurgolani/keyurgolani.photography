import fs from 'node:fs';
import path from 'node:path';
import { BROWSER_BUDGETS, FIRST_IMAGE_MS, KIB, SCREEN_BUDGETS, type BrowserProfile, type BrowserScreen } from './budgets';
import type { CatalogBudgetMeasurement, CatalogBudgetScreen } from './catalog-budgets';
import { BUDGET_PHOTOS, BUDGET_VARIANT_BYTES } from './fixture';

/**
 * `npm run test:budgets`' report (#6 items 9, 14 and 15): every value beside
 * its budget, in `.perf/report.json` at the repository root. The catalog half
 * is measureCatalogBudgets() on the served revision, the browser half what
 * e2e/budgets/budgets.spec.ts measured. Plain Node: the runner and the spec
 * both load it.
 */

/** Where the report goes, from the repository root. Git ignores `.perf/`. */
export const PERF_REPORT_FILE = path.join('.perf', 'report.json');

const toKiB = (bytes: number) => Math.round((bytes / KIB) * 10) / 10;

export interface CatalogReportRow {
    screen: CatalogBudgetScreen;
    /** The largest model of its kind. */
    subject: string;
    /** How many models of its kind were measured. */
    models: number;
    gzipKiB: number;
    budgetKiB: number;
    over: boolean;
}

export interface CatalogSection {
    revisionId: string;
    rows: CatalogReportRow[];
    /** Models over their budget, of every kind. */
    over: number;
    /** Home's ID list: featured photographs, gzip bytes each, and about how many Home's budget holds (limit 25). */
    home: CatalogBudgetMeasurement['home'];
}

/** The report's catalog half: each kind's largest model beside its budget. Kinds with nothing measured are left out. */
export function catalogSection(measurement: CatalogBudgetMeasurement): CatalogSection {
    const rows = Object.values(measurement.screens).flatMap(({ count, largest }) =>
        largest ? [{ screen: largest.screen, subject: largest.subject, models: count, gzipKiB: toKiB(largest.gzipBytes), budgetKiB: toKiB(largest.limit), over: largest.gzipBytes > largest.limit }] : [],
    );
    return { revisionId: measurement.revisionId, rows, over: measurement.over.length, home: measurement.home };
}

/** What the browser spec measured for one screen at one profile. */
export interface BrowserMeasurement {
    /** The HTML document as sent, compressed. */
    documentBytes: number;
    /** `/media` images the first load asked for, at the bytes the server declared, and how many. */
    eagerImageBytes: number;
    eagerImages: number;
    /** Every other image. */
    otherImageBytes: number;
    /** When the first catalog image's request started, in ms after the document finished. Null when none was asked for. */
    firstImageMs: number | null;
}

export type BrowserMetric = keyof BrowserMeasurement;

export interface BrowserRow {
    screen: BrowserScreen;
    profile: BrowserProfile;
    metric: BrowserMetric;
    value: number | null;
    /** Null where the value is reported, not held. */
    budget: number | null;
    /** The first image's 300 ms target, reported beside its gate. */
    target?: number;
    overTarget?: boolean;
    over: boolean;
}

/** Screens whose opening image the first-image gate holds: Work's covers are a list. */
const FIRST_IMAGE_SCREENS: readonly BrowserScreen[] = ['home', 'seriesFirstPage', 'viewer'];

/** One screen's browser rows at one profile, each value beside its budget. */
export function browserChecks(screen: BrowserScreen, profile: BrowserProfile, measured: BrowserMeasurement): BrowserRow[] {
    const budgets: { documentBytes: number; eagerImageBytes?: Record<BrowserProfile, number>; otherImageBytes?: number } = BROWSER_BUDGETS[screen];
    const held = (metric: BrowserMetric, budget: number | null): BrowserRow => {
        const value = measured[metric];
        return { screen, profile, metric, value, budget, over: budget !== null && value !== null && value > budget };
    };
    const rows = [
        held('documentBytes', budgets.documentBytes),
        held('eagerImageBytes', budgets.eagerImageBytes?.[profile] ?? null),
        held('eagerImages', screen === 'home' ? SCREEN_BUDGETS.home.eagerFullSizeDerivatives : null),
        held('otherImageBytes', budgets.otherImageBytes ?? null),
    ];
    const gated = FIRST_IMAGE_SCREENS.includes(screen);
    const { firstImageMs } = measured;
    rows.push({
        screen,
        profile,
        metric: 'firstImageMs',
        value: firstImageMs,
        budget: gated ? FIRST_IMAGE_MS.gate : null,
        ...(gated ? { target: FIRST_IMAGE_MS.target, overTarget: firstImageMs === null || firstImageMs > FIRST_IMAGE_MS.target } : {}),
        over: gated && (firstImageMs === null || firstImageMs > FIRST_IMAGE_MS.gate),
    });
    return rows;
}

export interface PerfReport {
    generatedAt: string;
    /** `fixture` fails on a budget; `report`, a real library's copy, reports only. */
    mode: 'fixture' | 'report';
    library: { photos: number; series: number; revisionId: string };
    catalog: CatalogSection;
    browser: BrowserRow[];
    /** What failed: a catalog kind or `<screen>/<profile> <metric>`. Empty in report mode, where nothing fails. */
    failed: string[];
}

/** Write `report` to `.perf/report.json` under `root`, and reportMarkdown() beside it as `report.md`. Returns the JSON file. */
export async function writePerfReport(root: string, report: PerfReport): Promise<string> {
    const file = path.join(root, PERF_REPORT_FILE);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
    await fs.promises.writeFile(path.join(path.dirname(file), 'report.md'), reportMarkdown(report));
    return file;
}

const unitOf = (metric: BrowserMetric) => (metric === 'firstImageMs' ? 'ms' : metric === 'eagerImages' ? '' : 'KiB');
function shown(value: number | null, metric: BrowserMetric): string {
    if (value === null) return 'none';
    const unit = unitOf(metric);
    return unit === 'KiB' ? `${toKiB(value)} KiB` : unit ? `${value} ${unit}` : String(value);
}

/** The report as Markdown, for CI's step summary: each value beside its budget, and what failed. */
export function reportMarkdown(report: PerfReport): string {
    const { library, catalog } = report;
    const lines = [
        `### #6 budgets: ${report.mode}, ${library.photos.toLocaleString('en-US')} photographs in ${library.series.toLocaleString('en-US')} series`,
        '',
        '| Catalog model | Largest | Models | gzip KiB | Budget KiB | |',
        '| --- | --- | --- | --- | --- | --- |',
        ...catalog.rows.map((row) => `| ${row.screen} | ${row.subject} | ${row.models} | ${row.gzipKiB} | ${row.budgetKiB} |${row.over ? ' **over** ' : ' '}|`),
        '',
        '| Screen | Profile | Metric | Value | Budget | |',
        '| --- | --- | --- | --- | --- | --- |',
        ...report.browser.map((row) => `| ${row.screen} | ${row.profile} | ${row.metric} | ${shown(row.value, row.metric)} | ${row.budget === null ? 'reported' : shown(row.budget, row.metric)} |${row.over ? ' **over** ' : ' '}|`),
    ];
    if (report.failed.length > 0) lines.push('', '**Failed:**', '', ...report.failed.map((entry) => `- ${entry}`));
    return `${lines.join('\n')}\n`;
}

const MEDIA_RUNG = /^\/media\/ph_[^/]+\/[^/]+\/[^/]+\/(w\d+)\.(avif|webp)$/;

/** How many times a load may re-read, with fetch(), the /media files it asked for as images: the copy tone's measures today. */
export const MAX_TONE_REREADS_PER_IMAGE = 2;

/**
 * A load's eager catalog images, from its finished requests: every `/media` request but a `fetch()`, at the bytes
 * the caller counted. A `fetch()` of `/media` is the copy tone's re-read of a file the slide already shows
 * (components/badgePlace.ts canvasSampler()), `only-if-cached`: a cache hit or no request at all in a real browser,
 * 0 B in the A/B's cache-on loads. budgets.spec.ts's fixture routes /media, and Playwright's routing turns the cache
 * off, so there it reaches the route and would count as a second download (#208's CI). It's left out only while it
 * re-reads a path the same load asked for as an image, at most MAX_TONE_REREADS_PER_IMAGE times per image; anything
 * else is a problem, so the exclusion can't hide another file or a loop.
 */
export function eagerMedia(finished: readonly { resourceType: string; pathname: string; bytes: number }[]): { bytes: number; count: number; rereads: number; problems: string[] } {
    const media = finished.filter(({ pathname }) => pathname.startsWith('/media/'));
    const images = media.filter(({ resourceType }) => resourceType !== 'fetch');
    const rereads = media.filter(({ resourceType }) => resourceType === 'fetch');
    const asked = new Set(images.map(({ pathname }) => pathname));
    const problems = [...new Set(rereads.map(({ pathname }) => pathname).filter((pathname) => !asked.has(pathname)))].map((pathname) => `${pathname} was fetched, but this load never asked for it as an image`);
    if (rereads.length > MAX_TONE_REREADS_PER_IMAGE * images.length) problems.push(`${rereads.length} re-reads of /media files by fetch(), more than ${MAX_TONE_REREADS_PER_IMAGE} for each of the load's ${images.length} images`);
    return { bytes: images.reduce((sum, { bytes }) => sum + bytes, 0), count: images.length, rereads: rereads.length, problems };
}

/** What the fixture declares a `/media` path's file to be, by its rung and format, or null for any other path. */
export function declaredMediaBytes(pathname: string): number | null {
    const match = MEDIA_RUNG.exec(pathname);
    if (!match) return null;
    const rung = BUDGET_VARIANT_BYTES[match[1] as keyof typeof BUDGET_VARIANT_BYTES];
    return rung ? rung[match[2] as 'avif' | 'webp'] : null;
}

/** The photograph a catalog preload's `imagesrcset` names: the opening one. Null for anything else. */
export function openingPhotoId(imagesrcset: string | null): string | null {
    return imagesrcset ? (/(?:^|[\s,])\/media\/(ph_[0-9a-f-]+)\//.exec(imagesrcset)?.[1] ?? null) : null;
}

/**
 * What the browser layer failed on. In fixture mode, each row over its
 * budget. In either mode, a run that exited non-zero with no row over, or
 * with fewer rows than it should have written: a server that didn't start,
 * or a page that didn't load.
 */
export function browserFailures({ mode, exitCode, rows, expectedRows }: { mode: PerfReport['mode']; exitCode: number; rows: readonly BrowserRow[]; expectedRows: number }): string[] {
    const over = mode === 'fixture' ? rows.filter((row) => row.over) : [];
    const failed = over.map((row) => `${row.screen}/${row.profile} ${row.metric}: ${row.value} against ${row.budget}`);
    if (exitCode !== 0 && (over.length === 0 || rows.length < expectedRows)) failed.push(`the browser layer exited ${exitCode} with ${rows.length} of ${expectedRows} rows`);
    return failed;
}

export interface BudgetsArgs {
    /** A copy of a real data root to report on, or null for the generated fixture. */
    dataRoot: string | null;
    /** The fixture's photographs. */
    photos: number;
    port: number;
    /** Build `.next` fresh even when it holds a build. */
    build: boolean;
}

/**
 * `npm run test:budgets -- [--photos <n>] [--data-root <copy>] [--build]`. The port is
 * BUDGETS_PORT, 3200 by default. `--photos` sizes the generated fixture, so
 * it means nothing beside `--data-root`.
 */
export function parseBudgetsArgs(argv: readonly string[], env: Record<string, string | undefined> = process.env): BudgetsArgs {
    const args: BudgetsArgs = { dataRoot: null, photos: BUDGET_PHOTOS, port: Number(env.BUDGETS_PORT || 3200), build: false };
    let photosGiven = false;
    for (let at = 0; at < argv.length; at += 1) {
        const flag = argv[at];
        const value = argv[at + 1];
        if (flag === '--data-root') {
            if (!value || value.startsWith('--')) throw new Error('--data-root needs the path of a copy of a data root.');
            args.dataRoot = path.resolve(value);
            at += 1;
        } else if (flag === '--photos') {
            if (!value || !/^\d+$/.test(value)) throw new Error('--photos needs a whole number of photographs.');
            args.photos = Number(value);
            photosGiven = true;
            at += 1;
        } else if (flag === '--build') {
            args.build = true;
        } else {
            throw new Error(`${flag} isn't an option. Use --photos <n>, --data-root <copy> or --build.`);
        }
    }
    if (args.dataRoot !== null && photosGiven) throw new Error('--photos sizes the generated fixture, so it goes without --data-root.');
    if (!Number.isInteger(args.port) || args.port <= 0) throw new Error(`BUDGETS_PORT must be a port number, got ${env.BUDGETS_PORT}.`);
    return args;
}
