// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BROWSER_BUDGETS, FIRST_IMAGE_MS, KIB, SCREEN_BUDGETS } from '../budgets';
import type { CatalogBudgetMeasurement } from '../catalog-budgets';
import { BUDGET_VARIANT_BYTES } from '../fixture';
import { browserChecks, browserFailures, catalogSection, declaredMediaBytes, openingPhotoId, parseBudgetsArgs, PERF_REPORT_FILE, reportMarkdown, writePerfReport, type BrowserRow, type PerfReport } from '../report';

// `npm run test:budgets`' report (#6 item 14): `.perf/report.json`, each
// value beside its budget, from the catalog layer and the browser layer.

const scratch: string[] = [];
afterEach(async () => {
    for (const dir of scratch.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

const row = (screen: CatalogBudgetMeasurement['over'][number]['screen'], gzipKiB: number, limitKiB: number, subject: string = screen) => ({
    screen,
    budget: screen,
    subject,
    records: 1,
    bytes: 4 * gzipKiB * KIB,
    gzipBytes: gzipKiB * KIB,
    limit: limitKiB * KIB,
});

const MEASUREMENT: CatalogBudgetMeasurement = {
    revisionId: 'rev_x',
    screens: {
        home: { count: 1, largest: row('home', 2.5, 50, '100 featured photographs') },
        work: { count: 1, largest: row('work', 120, 100, '100 series') },
        seriesFirstPage: { count: 100, largest: row('seriesFirstPage', 12, 100, 'fixture-02') },
        seriesContinuationPage: { count: 0, largest: null },
        viewer: { count: 5_000, largest: row('viewer', 0.7, 10, 'ph_x') },
        viewerPeek: { count: 5_000, largest: { ...row('viewer', 0.5, 10, 'ph_y'), screen: 'viewerPeek' } },
    },
    over: [row('work', 120, 100, '100 series')],
    home: { featuredPhotos: 100, bytesPerPhoto: 20, photosAtBudget: 2_500 },
};

describe('catalogSection()', () => {
    it('puts each screen\'s largest model beside its budget, in KiB, and counts what is over', () => {
        const section = catalogSection(MEASUREMENT);
        expect(section.rows).toEqual([
            { screen: 'home', subject: '100 featured photographs', models: 1, gzipKiB: 2.5, budgetKiB: 50, over: false },
            { screen: 'work', subject: '100 series', models: 1, gzipKiB: 120, budgetKiB: 100, over: true },
            { screen: 'seriesFirstPage', subject: 'fixture-02', models: 100, gzipKiB: 12, budgetKiB: 100, over: false },
            { screen: 'viewer', subject: 'ph_x', models: 5_000, gzipKiB: 0.7, budgetKiB: 10, over: false },
            { screen: 'viewerPeek', subject: 'ph_y', models: 5_000, gzipKiB: 0.5, budgetKiB: 10, over: false },
        ]);
        expect(section.over).toBe(1);
        expect(section.home).toEqual(MEASUREMENT.home);
        expect(section.revisionId).toBe('rev_x');
    });
});

describe('browserChecks()', () => {
    it('holds Home to its document, eager and other image bytes, and the first image\'s gate, and reports the target', () => {
        const rows = browserChecks('home', 'phone', { documentBytes: 40 * KIB, eagerImageBytes: 700 * KIB, eagerImages: 2, otherImageBytes: 200 * KIB, firstImageMs: 450 });
        const by = (metric: string) => rows.find((entry) => entry.metric === metric);
        expect(by('documentBytes')).toMatchObject({ value: 40 * KIB, budget: BROWSER_BUDGETS.home.documentBytes, over: false });
        expect(by('eagerImageBytes')).toMatchObject({ value: 700 * KIB, budget: BROWSER_BUDGETS.home.eagerImageBytes.phone, over: false });
        expect(by('otherImageBytes')).toMatchObject({ value: 200 * KIB, budget: BROWSER_BUDGETS.home.otherImageBytes, over: true });
        // Over the 300 ms target is reported, not failed; the 1,000 ms gate fails.
        expect(by('firstImageMs')).toMatchObject({ value: 450, budget: FIRST_IMAGE_MS.gate, target: FIRST_IMAGE_MS.target, over: false, overTarget: true });
        expect(by('eagerImages')).toMatchObject({ value: 2, budget: SCREEN_BUDGETS.home.eagerFullSizeDerivatives, over: false });
    });

    it('reports Work\'s images without a cap, and has no first-image gate there', () => {
        const rows = browserChecks('work', 'desktop', { documentBytes: 300 * KIB, eagerImageBytes: 2_000 * KIB, eagerImages: 9, otherImageBytes: 0, firstImageMs: 1_500 });
        expect(rows.find((entry) => entry.metric === 'documentBytes')).toMatchObject({ budget: BROWSER_BUDGETS.work.documentBytes, over: true });
        expect(rows.find((entry) => entry.metric === 'eagerImageBytes')).toMatchObject({ budget: null, over: false });
        expect(rows.find((entry) => entry.metric === 'firstImageMs')).toMatchObject({ budget: null, over: false });
    });

    it('holds the series and the Viewer to the first image\'s gate, and the Viewer to its eager bytes per profile', () => {
        expect(browserChecks('seriesFirstPage', 'phone', { documentBytes: 1, eagerImageBytes: 1, eagerImages: 1, otherImageBytes: 0, firstImageMs: 1_200 }).find((entry) => entry.metric === 'firstImageMs')).toMatchObject({ over: true });
        const viewer = browserChecks('viewer', 'desktop', { documentBytes: 1, eagerImageBytes: 740 * KIB, eagerImages: 1, otherImageBytes: 0, firstImageMs: null });
        expect(viewer.find((entry) => entry.metric === 'eagerImageBytes')).toMatchObject({ budget: BROWSER_BUDGETS.viewer.eagerImageBytes.desktop, over: false });
        // No image asked for is a failure of its own where a first image is gated.
        expect(viewer.find((entry) => entry.metric === 'firstImageMs')).toMatchObject({ value: null, over: true });
    });
});

describe('parseBudgetsArgs()', () => {
    it('defaults to the 5,000-photograph fixture on port 3200', () => {
        expect(parseBudgetsArgs([])).toEqual({ dataRoot: null, photos: 5_000, port: 3200, build: false });
        expect(parseBudgetsArgs(['--photos', '500'])).toEqual({ dataRoot: null, photos: 500, port: 3200, build: false });
        expect(parseBudgetsArgs(['--data-root', 'copy'], { BUDGETS_PORT: '3210' })).toEqual({ dataRoot: path.resolve('copy'), photos: 5_000, port: 3210, build: false });
        // --build makes a fresh production build even when .next holds one.
        expect(parseBudgetsArgs(['--build', '--photos', '500'])).toEqual({ dataRoot: null, photos: 500, port: 3200, build: true });
    });

    it('refuses what it can\'t use', () => {
        expect(() => parseBudgetsArgs(['--photos', 'many'])).toThrow(/--photos/);
        expect(() => parseBudgetsArgs(['--data-root'])).toThrow(/--data-root/);
        expect(() => parseBudgetsArgs(['--data-root', 'a', '--photos', '500'])).toThrow(/--photos/);
        expect(() => parseBudgetsArgs(['--watch'])).toThrow(/--watch/);
    });
});

describe('the fixture\'s media in the browser', () => {
    it('counts a /media request at the bytes the fixture declares for its rung and format, and nothing else', () => {
        const media = '/media/ph_0b6f5d0e-3a8b-4c2d-9e1f-2a3b4c5d6e7f/sha256-abc/p1';
        expect(declaredMediaBytes(`${media}/w1920.avif`)).toBe(BUDGET_VARIANT_BYTES.w1920.avif);
        expect(declaredMediaBytes(`${media}/w400.webp`)).toBe(BUDGET_VARIANT_BYTES.w400.webp);
        expect(declaredMediaBytes(`${media}/w640.avif`)).toBeNull();
        expect(declaredMediaBytes('/about/portrait/0123/w400.avif')).toBeNull();
    });

    it('names the opening photograph from the preload\'s srcset', () => {
        const id = 'ph_0b6f5d0e-3a8b-4c2d-9e1f-2a3b4c5d6e7f';
        expect(openingPhotoId(`/media/${id}/sha256-abc/p1/w400.avif 400w, /media/${id}/sha256-abc/p1/w800.avif 800w`)).toBe(id);
        expect(openingPhotoId('/about/portrait/0123/w400.avif 400w')).toBeNull();
        expect(openingPhotoId(null)).toBeNull();
    });
});

describe('browserFailures()', () => {
    const over: BrowserRow = { screen: 'home', profile: 'phone', metric: 'documentBytes', value: 200 * KIB, budget: 130 * KIB, over: true };
    const fine: BrowserRow = { ...over, value: 1, over: false };

    it('names each row over budget in fixture mode, and a crash beside them when rows are missing', () => {
        expect(browserFailures({ mode: 'fixture', exitCode: 1, rows: [over, fine], expectedRows: 2 })).toEqual(['home/phone documentBytes: 204800 against 133120']);
        expect(browserFailures({ mode: 'fixture', exitCode: 1, rows: [over], expectedRows: 2 })).toEqual(['home/phone documentBytes: 204800 against 133120', 'the browser layer exited 1 with 1 of 2 rows']);
        expect(browserFailures({ mode: 'fixture', exitCode: 1, rows: [fine, fine], expectedRows: 2 })).toEqual(['the browser layer exited 1 with 2 of 2 rows']);
        expect(browserFailures({ mode: 'fixture', exitCode: 0, rows: [fine, fine], expectedRows: 2 })).toEqual([]);
    });

    it('fails nothing on a budget in report mode, but still a run that didn\'t finish', () => {
        expect(browserFailures({ mode: 'report', exitCode: 0, rows: [over, fine], expectedRows: 2 })).toEqual([]);
        expect(browserFailures({ mode: 'report', exitCode: 1, rows: [over], expectedRows: 2 })).toEqual(['the browser layer exited 1 with 1 of 2 rows']);
    });
});

describe('reportMarkdown()', () => {
    it('gives the step summary each value beside its budget, and what failed', () => {
        const report: PerfReport = {
            generatedAt: '2026-11-05T00:00:00.000Z',
            mode: 'fixture',
            library: { photos: 5_000, series: 100, revisionId: 'rev_x' },
            catalog: catalogSection(MEASUREMENT),
            browser: browserChecks('home', 'desktop', { documentBytes: 40 * KIB, eagerImageBytes: 700 * KIB, eagerImages: 2, otherImageBytes: 10 * KIB, firstImageMs: 12 }),
            failed: ['work 100 series: 122880 B gzip, over 102400'],
        };
        const markdown = reportMarkdown(report);
        expect(markdown).toContain('### #6 budgets: fixture, 5,000 photographs in 100 series');
        expect(markdown).toContain('| work | 100 series | 1 | 120 | 100 | **over** |');
        expect(markdown).toContain('| home | desktop | eagerImageBytes | 700 KiB | 750 KiB | |');
        expect(markdown).toContain('| home | desktop | firstImageMs | 12 ms | 1000 ms | |');
        expect(markdown).toContain('- work 100 series: 122880 B gzip, over 102400');
    });
});

describe('writePerfReport()', () => {
    it('writes .perf/report.json under the given root, creating the folder', async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'perf-report-'));
        scratch.push(root);
        expect(PERF_REPORT_FILE).toBe(path.join('.perf', 'report.json'));
        const report: PerfReport = { generatedAt: '2026-11-05T00:00:00.000Z', mode: 'fixture', library: { photos: 5_000, series: 100, revisionId: 'rev_x' }, catalog: catalogSection(MEASUREMENT), browser: [], failed: ['work'] };
        const file = await writePerfReport(root, report);
        expect(file).toBe(path.join(root, '.perf', 'report.json'));
        expect(JSON.parse(await fs.promises.readFile(file, 'utf8'))).toEqual(report);
        // Beside it, the step summary CI appends.
        expect(await fs.promises.readFile(path.join(root, '.perf', 'report.md'), 'utf8')).toBe(reportMarkdown(report));
    });
});
