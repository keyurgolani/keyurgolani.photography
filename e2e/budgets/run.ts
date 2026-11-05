/**
 * `npm run test:budgets`: #6's budgets on one library, in two layers, with
 * every value beside its budget in `.perf/report.json`.
 *
 *   npm run test:budgets [-- --photos 5000]
 *   npm run test:budgets -- --data-root <a copy of a data root>
 *
 * 1. The library: by default the budget fixture (lib/perf/fixture.ts),
 *    written to a temp data root outside the repository and published. With
 *    `--data-root`, the copy as it is, read and served, never written: report
 *    mode, which fails nothing. Point it at a copy, never the live root.
 * 2. The catalog layer: measureCatalogBudgets() on the revision the root
 *    serves, through lib/perf/budgets-cli.ts, as `photos validate` runs it.
 * 3. The browser layer: e2e/budgets/budgets.config.ts on 127.0.0.1:3200
 *    (BUDGETS_PORT), Chromium only, over Home, Work, the longest series and
 *    its middle photograph's Viewer. It serves the production build in
 *    `.next`, and runs `npm run build` first only when there is none, so in
 *    CI it takes the one `npm run test:e2e` made.
 *
 * Nothing here reaches the network: the library is generated, the server is
 * on loopback, Playwright's Chromium is already installed, and Next's
 * telemetry is off. Exits 1 when a budget fails in fixture mode, or when a
 * layer can't run in either mode.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCREEN_BUDGETS, type Screen } from '../../lib/perf/budgets';
import { measureInChild } from '../../lib/perf/catalog-budgets';
import { catalogSection, parseBudgetsArgs, writePerfReport, type BrowserRow, type PerfReport } from '../../lib/perf/report';
import { activeRevision, publishBudgetLibrary } from './library';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Run `command` from the repository root with `env`, its output passed through. Resolves to its exit code. */
function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: REPO_ROOT, env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
}

/** The settings that turn a server into the curator, or point it at another root. Never inherited from this shell. */
const DROPPED = /^(PHOTOGRAPHY_|CURATION_|CURATOR_)/;

const args = parseBudgetsArgs(process.argv.slice(2));
const mode: PerfReport['mode'] = args.dataRoot ? 'report' : 'fixture';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'budgets-'));
const failed: string[] = [];
try {
    // 1. The library.
    let root: string;
    if (args.dataRoot) {
        root = args.dataRoot;
        console.log(`[budgets] Reporting on ${root}, read only. Use a copy, never the live data root.`);
    } else {
        root = path.join(scratch, 'data');
        const started = performance.now();
        await publishBudgetLibrary(root, { photos: args.photos });
        console.log(`[budgets] Published the ${args.photos.toLocaleString('en-US')}-photograph budget library in ${Math.round((performance.now() - started) / 1000)} s.`);
    }
    const { revisionId, content } = await activeRevision(root);

    // 2. The catalog layer.
    const measurement = await measureInChild(content, { revisionId, revisionNumber: null });
    const catalog = catalogSection(measurement);
    console.table(catalog.rows);
    if (mode === 'fixture') for (const row of measurement.over) failed.push(`${row.screen} ${row.subject}: ${row.gzipBytes} B gzip, over ${row.limit}`);

    // 3. The browser layer: the longest series and the photograph in its middle, the fixture's real-length one.
    const longest = [...content.series].sort((a, b) => b.photoIds.length - a.photoIds.length)[0];
    if (!longest) throw new Error(`${root} publishes no series.`);
    const middle = longest.photoIds[Math.floor(longest.photoIds.length / 2)];
    const screens: { screen: Screen; path: string }[] = [
        { screen: 'home', path: '/' },
        { screen: 'work', path: '/work' },
        { screen: 'seriesFirstPage', path: `/work/${longest.slug}` },
        { screen: 'viewer', path: `/work/${longest.slug}/photo/${middle}` },
    ];
    const targets = path.join(scratch, 'targets.json');
    const browserOut = path.join(scratch, 'browser.json');
    fs.writeFileSync(targets, JSON.stringify({ mode, screens }));
    const library = path.join(scratch, 'library');
    fs.mkdirSync(library);
    const siteConfig = path.join(scratch, 'site-config');
    const env: NodeJS.ProcessEnv = {
        ...(Object.fromEntries(Object.entries(process.env).filter(([name]) => !DROPPED.test(name))) as NodeJS.ProcessEnv),
        NEXT_TELEMETRY_DISABLED: '1',
        // The Playwright servers' settings (playwright.config.ts): About's placeholder copy and stand-in portrait, and no photo library.
        ALLOW_PROVISIONAL_COPY: '1',
        PHOTOGRAPHY_LIBRARY_DIR: library,
        PHOTOGRAPHY_SITE_CONFIG_DIR: siteConfig,
        PHOTOGRAPHY_DATA_DIR: root,
        BUDGETS_PORT: String(args.port),
        BUDGETS_TARGETS: targets,
        BUDGETS_BROWSER_OUT: browserOut,
    };
    if ((await run('npx', ['tsx', 'e2e/support/write-site-config.ts', siteConfig], env)) !== 0) throw new Error('Writing the stand-in site config failed.');
    if (!fs.existsSync(path.join(REPO_ROOT, '.next', 'BUILD_ID'))) {
        console.log('[budgets] No production build in .next, so building one first.');
        const buildEnv: NodeJS.ProcessEnv = { ...env };
        delete buildEnv.PHOTOGRAPHY_DATA_DIR;
        if ((await run('npm', ['run', 'build'], buildEnv)) !== 0) throw new Error('npm run build failed.');
    }
    const playwright = await run('npx', ['playwright', 'test', '-c', 'e2e/budgets/budgets.config.ts'], env);
    const browser: BrowserRow[] = fs.existsSync(browserOut) ? JSON.parse(fs.readFileSync(browserOut, 'utf8')) : [];
    const overRows = mode === 'fixture' ? browser.filter((entry) => entry.over) : [];
    for (const row of overRows) failed.push(`${row.screen}/${row.profile} ${row.metric}: ${row.value} against ${row.budget}`);
    // Any other failure of the spec, a server that didn't start or a page that didn't load, fails in either mode.
    if (playwright !== 0 && overRows.length === 0) failed.push(`the browser layer exited ${playwright}`);

    const report: PerfReport = {
        generatedAt: new Date().toISOString(),
        mode,
        library: { photos: content.photos.length, series: content.series.length, revisionId },
        catalog,
        browser,
        failed,
    };
    const file = await writePerfReport(REPO_ROOT, report);
    console.log(`[budgets] Wrote ${path.relative(REPO_ROOT, file)}: ${catalog.rows.length} catalog rows against SCREEN_BUDGETS (${Object.keys(SCREEN_BUDGETS).length} screens), ${browser.length} browser rows.`);
} catch (error) {
    failed.push(error instanceof Error ? error.message : String(error));
} finally {
    // Only the scratch folder this run made: the library under it, never a --data-root.
    fs.rmSync(scratch, { recursive: true, force: true });
}
if (failed.length > 0) {
    console.error(`[budgets] ${mode === 'report' ? 'Could not report' : 'Over budget or failed'}:\n  ${failed.join('\n  ')}`);
    process.exitCode = 1;
} else {
    console.log(`[budgets] ${mode === 'report' ? 'Reported; report mode fails nothing.' : 'Every budget held.'}`);
}
