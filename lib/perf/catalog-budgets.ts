import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogContent, ReaderMeta } from '../catalog/reader';
import { KIB, SCREEN_BUDGETS, type Screen } from './budgets';

/**
 * #6's publish warning (item 13), the half plain Node can load: the shape of
 * measureCatalogBudgets()'s answer, the lines `photos validate` prints from
 * it, and measureInChild(), which gets that answer for a catalog. The reader
 * and the projections carry `server-only`, which throws under Node's default
 * conditions, and the CLI, the watcher and Playwright never reach them
 * (lib/catalog/__tests__/clientImports.test.ts). So the measuring runs in a
 * child process of its own, lib/perf/budgets-cli.ts, under
 * `--conditions=react-server`, and in the image as dist/scripts/budgets-cli.mjs,
 * bundled that way.
 */

/** A model kind measureCatalogBudgets() reads: one per SCREEN_BUDGETS entry. */
export type CatalogBudgetScreen = Screen;

export interface CatalogBudgetRow {
    screen: CatalogBudgetScreen;
    /** The SCREEN_BUDGETS entry whose `gzipBytes` it answers to. */
    budget: Screen;
    /** Which model: Home's featured photographs, Work's series, a series' slug and range, or a photo ID. */
    subject: string;
    /** Photo records in it. */
    records: number;
    bytes: number;
    gzipBytes: number;
    /** The budget, in gzip bytes. */
    limit: number;
}

export interface CatalogBudgetMeasurement {
    revisionId: string;
    /** For each kind: how many models were measured, and the largest. */
    screens: Record<CatalogBudgetScreen, { count: number; largest: CatalogBudgetRow | null }>;
    /** Every model over its budget, in the order measured. */
    over: CatalogBudgetRow[];
    /**
     * Home's ID list (limit 25): the featured photographs it lists, what each
     * costs in gzip bytes, and about how many Home's budget would hold at that
     * cost. Null with nothing featured.
     */
    home: { featuredPhotos: number; bytesPerPhoto: number; photosAtBudget: number } | null;
}

const kib = (bytes: number) => `${(bytes / KIB).toFixed(1)} KiB`;
const budgetKiB = (limit: number) => `${Number((limit / KIB).toFixed(1))} KiB`;
const count = (n: number) => n.toLocaleString('en-US');
const WARNING = '[photos] BUDGET_WARNING:';
const NOT_A_RULE = 'A warning, not a rule: publish still takes it. lib/perf/budgets.ts says what to try first.';
/** Warnings printed before the rest are counted. */
const MAX_WARNINGS = 20;

/** What an over-budget model is called in a warning. */
function nameOf(row: CatalogBudgetRow): string {
    switch (row.screen) {
        case 'home':
            return 'Home';
        case 'work':
            return 'Work';
        case 'seriesFirstPage':
            return `The first response of ${row.subject}`;
        case 'seriesContinuationPage':
            return `The continuation page of ${row.subject}`;
        case 'viewer':
            return `The Viewer for ${row.subject}`;
    }
}

/** The lines `photos validate` prints: each screen's size beside its budget, then a warning per model over it. */
export function budgetLines(measurement: CatalogBudgetMeasurement | Error): string[] {
    if (measurement instanceof Error) return [`Budgets: not measured (${measurement.message}).`];
    const { screens, home } = measurement;
    const of = (row: CatalogBudgetRow) => `${kib(row.gzipBytes)} of ${budgetKiB(row.limit)}`;
    const largest = (screen: CatalogBudgetScreen, across: (n: number) => string) => {
        const entry = screens[screen];
        return entry.largest ? `largest ${of(entry.largest)} (${entry.largest.subject}), across ${across(entry.count)}` : 'none';
    };
    const lines = ['Budgets (gzip, lib/perf/budgets.ts):'];
    const homeRow = screens.home.largest;
    lines.push(`  Home: ${homeRow ? of(homeRow) : 'none'}${homeRow && home ? `, ${count(home.featuredPhotos)} featured photographs at about ${Math.round(home.bytesPerPhoto)} B each` : ''}`);
    const workRow = screens.work.largest;
    lines.push(`  Work: ${workRow ? `${of(workRow)}, ${workRow.subject}` : 'none'}`);
    lines.push(`  Series, first response: ${largest('seriesFirstPage', (n) => `${count(n)} series`)}`);
    lines.push(`  Series, continuation page: ${largest('seriesContinuationPage', (n) => `${count(n)} pages`)}`);
    lines.push(`  Viewer: ${largest('viewer', (n) => `${count(n)} photographs`)}`);
    for (const row of measurement.over.slice(0, MAX_WARNINGS)) lines.push(`${WARNING} ${nameOf(row)} is ${kib(row.gzipBytes)}, over its ${budgetKiB(row.limit)} budget. ${NOT_A_RULE}`);
    if (measurement.over.length > MAX_WARNINGS) lines.push(`${WARNING} and ${count(measurement.over.length - MAX_WARNINGS)} more models over budget.`);
    return lines;
}

/** How long the child may take: every Viewer model of a large library is a few seconds. */
const CHILD_TIMEOUT_MS = 120_000;

/**
 * The child to run: lib/perf/budgets-cli.ts beside this file under tsx, or
 * dist/scripts/budgets-cli.mjs beside the bundle this code was bundled into.
 */
function childEntry(): string {
    const here = fileURLToPath(import.meta.url);
    return path.join(path.dirname(here), here.endsWith('.ts') ? 'budgets-cli.ts' : 'budgets-cli.mjs');
}

/**
 * measureCatalogBudgets() for `content`, run in budgets-cli under
 * `--conditions=react-server`. This process's own Node flags go first, so
 * under tsx the child loads TypeScript the same way. Rejects when the child
 * can't run or answers anything but its measurement.
 */
export function measureInChild(content: CatalogContent, meta: ReaderMeta, budgets: typeof SCREEN_BUDGETS = SCREEN_BUDGETS): Promise<CatalogBudgetMeasurement> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [...process.execArgv, '--conditions=react-server', childEntry()], { stdio: ['pipe', 'pipe', 'pipe'], timeout: CHILD_TIMEOUT_MS });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
        child.once('error', (error) => reject(new Error(`the measuring process didn't start: ${error.message}`)));
        child.once('close', (code, signal) => {
            if (code !== 0) return reject(new Error(`the measuring process exited ${code ?? signal}${stderr.trim() ? `: ${stderr.trim().split('\n')[0]}` : ''}`));
            try {
                resolve(JSON.parse(stdout) as CatalogBudgetMeasurement);
            } catch {
                reject(new Error('the measuring process answered something other than its measurement'));
            }
        });
        // A child that exits before reading all of it closes the pipe; its exit code says why.
        child.stdin.on('error', () => undefined);
        child.stdin.end(JSON.stringify({ content, meta, budgets }));
    });
}
