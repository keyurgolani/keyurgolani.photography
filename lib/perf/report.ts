import fs from 'node:fs';
import path from 'node:path';
import { BROWSER_BUDGETS, FIRST_IMAGE_MS, KIB, SCREEN_BUDGETS, type BrowserProfile, type BrowserScreen } from './budgets';
import type { CatalogBudgetMeasurement, CatalogBudgetScreen } from './catalog-budgets';
import { BUDGET_PHOTOS } from './fixture';

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

/** Write `report` to `.perf/report.json` under `root`. Returns the file. */
export async function writePerfReport(root: string, report: PerfReport): Promise<string> {
    const file = path.join(root, PERF_REPORT_FILE);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
    return file;
}

export interface BudgetsArgs {
    /** A copy of a real data root to report on, or null for the generated fixture. */
    dataRoot: string | null;
    /** The fixture's photographs. */
    photos: number;
    port: number;
}

/**
 * `npm run test:budgets -- [--photos <n>] [--data-root <copy>]`. The port is
 * BUDGETS_PORT, 3200 by default. `--photos` sizes the generated fixture, so
 * it means nothing beside `--data-root`.
 */
export function parseBudgetsArgs(argv: readonly string[], env: Record<string, string | undefined> = process.env): BudgetsArgs {
    const args: BudgetsArgs = { dataRoot: null, photos: BUDGET_PHOTOS, port: Number(env.BUDGETS_PORT || 3200) };
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
        } else {
            throw new Error(`${flag} isn't an option. Use --photos <n> or --data-root <copy>.`);
        }
    }
    if (args.dataRoot !== null && photosGiven) throw new Error('--photos sizes the generated fixture, so it goes without --data-root.');
    if (!Number.isInteger(args.port) || args.port <= 0) throw new Error(`BUDGETS_PORT must be a port number, got ${env.BUDGETS_PORT}.`);
    return args;
}
