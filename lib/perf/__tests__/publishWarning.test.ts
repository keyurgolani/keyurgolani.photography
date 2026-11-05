// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { runTsx, type TsxRun } from '../../../test/helpers/runTsx';
import { createTestCatalog, type TestCatalog, type TestCatalogOptions } from '../../catalog/testing';
import type { CatalogBudgetMeasurement } from '../catalog-budgets';
import { budgetLines } from '../catalog-budgets';
import { KIB } from '../budgets';
import { BUDGET_VARIANT_BYTES } from '../fixture';

// #6's publish warning (item 13): `photos validate` prints each screen's
// read-model size for the candidate, from measureCatalogBudgets(), and warns
// when one is over its budget. A warning, not a rule: the exit code is
// validate's own.

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(options: TestCatalogOptions): Promise<TestCatalog> {
    const catalog = await createTestCatalog({ variantBytes: BUDGET_VARIANT_BYTES, ...options });
    cleanups.push(() => catalog.cleanup());
    return catalog;
}

const validate = (root: string): Promise<TsxRun> => runTsx('scripts/photos.ts', ['validate'], { env: { PHOTOGRAPHY_DATA_DIR: root, PHOTOS_ACTOR: undefined } });

/** Seeded syllables, which gzip about as badly as prose can. */
function noise(length: number, seed = 9): string {
    let state = seed;
    let text = '';
    while (text.length < length) {
        state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
        text += `${'bcdfghklmnprstvz'[state % 16]}${'aeiou'[(state >>> 8) % 5]}${(state >>> 16) % 7 === 0 ? ' ' : ''}`;
    }
    return text.slice(0, length);
}

describe('photos validate', { timeout: 120_000 }, () => {
    it('prints each screen\'s size beside its budget, and no warning when every one is within it', async () => {
        const catalog = await fixture({ seed: 1101, photos: 6, series: 2 });
        const run = await validate(catalog.root);
        expect(run.code, run.stderr).toBe(0);
        expect(run.stdout).toContain('[photos] VALID: The working layer passes');
        expect(run.stdout).toMatch(/^Budgets \(gzip, lib\/perf\/budgets\.ts\):$/m);
        expect(run.stdout).toMatch(/^ {2}Home: \d+\.\d KiB of 50 KiB, 3 featured photographs at about \d+ B each$/m);
        expect(run.stdout).toMatch(/^ {2}Work: \d+\.\d KiB of 100 KiB, 2 series$/m);
        expect(run.stdout).toMatch(/^ {2}Series, first response: largest \d+\.\d KiB of 100 KiB \(fixture-0[12]\), across 2 series$/m);
        expect(run.stdout).toMatch(/^ {2}Series, continuation page: none$/m);
        expect(run.stdout).toMatch(/^ {2}Viewer: largest \d+\.\d KiB of 10 KiB \(ph_[0-9a-f-]+\), across 6 photographs$/m);
        expect(run.stdout).not.toContain('BUDGET_WARNING');
    });

    it('warns, naming the photograph, when a Viewer model is over its budget, and still exits 0', async () => {
        const catalog = await fixture({ seed: 1102, photos: [{}, { caption: noise(40_000) }, {}], series: 1 });
        const heavy = catalog.photos[1].id;
        const run = await validate(catalog.root);
        expect(run.code, run.stderr).toBe(0);
        expect(run.stdout).toMatch(new RegExp(`^\\[photos\\] BUDGET_WARNING: The Viewer for ${heavy} is \\d+\\.\\d KiB, over its 10 KiB budget\\.`, 'm'));
        expect(run.stdout).toContain('A warning, not a rule: publish still takes it. lib/perf/budgets.ts says what to try first.');
        expect(run.stdout.match(/BUDGET_WARNING/g)).toHaveLength(1);
    });

    it('says when the sizes couldn\'t be measured, and keeps validate\'s exit code', () => {
        expect(budgetLines(new Error('the child exited 1'))).toEqual(['Budgets: not measured (the child exited 1).']);
    });
});

describe('budgetLines()', () => {
    const row = (screen: CatalogBudgetMeasurement['over'][number]['screen'], subject: string, gzipKiB: number, limitKiB: number) => ({
        screen,
        budget: screen === 'seriesContinuationPage' ? ('seriesFirstPage' as const) : screen,
        subject,
        records: 1,
        bytes: gzipKiB * 4 * KIB,
        gzipBytes: gzipKiB * KIB,
        limit: limitKiB * KIB,
    });

    it('lists each model over its budget, Work and a series by name, and stops after 20', () => {
        const over = [row('work', '100 series', 120, 100), row('seriesFirstPage', 'big-one', 101, 100), ...Array.from({ length: 25 }, (_, n) => row('viewer', `ph_${n}`, 11, 10))];
        const measurement: CatalogBudgetMeasurement = {
            revisionId: 'rev_x',
            screens: {
                home: { count: 1, largest: row('home', '1 featured series', 1, 50) },
                work: { count: 1, largest: over[0] },
                seriesFirstPage: { count: 1, largest: over[1] },
                seriesContinuationPage: { count: 0, largest: null },
                viewer: { count: 25, largest: over[2] },
            },
            over,
            home: { featuredPhotos: 1, bytesPerPhoto: 20, photosAtBudget: 2_400 },
        };
        const lines = budgetLines(measurement);
        expect(lines).toContain('[photos] BUDGET_WARNING: Work is 120.0 KiB, over its 100 KiB budget. A warning, not a rule: publish still takes it. lib/perf/budgets.ts says what to try first.');
        expect(lines).toContain('[photos] BUDGET_WARNING: The first response of big-one is 101.0 KiB, over its 100 KiB budget. A warning, not a rule: publish still takes it. lib/perf/budgets.ts says what to try first.');
        expect(lines.filter((line) => line.includes('budget. A warning, not a rule'))).toHaveLength(20);
        expect(lines.at(-1)).toBe('[photos] BUDGET_WARNING: and 7 more models over budget.');
    });
});
