// @vitest-environment node
/**
 * #12's freshness rows in production mode (B12). `npm run test:prod` builds,
 * then this serves a copy of .next/standalone on a temp data root, with
 * SITE_URL set, and reads the pages' raw HTML as a browser and as Twitterbot
 * (test/helpers/standaloneServer.ts says why both). Plain `npm test` skips it
 * unless RUN_PROD_TESTS=1.
 *
 * In order, on one server started before the launch, so its pid only changes
 * where a row says it restarts (F5):
 * - E1: before anything is published, the series and Viewer error pages are
 *   Next's bare error shell: no title, meta tag or filled hidden segment
 *   after </head>, and tag for tag the body /work sends. Then the same on a second server whose
 *   first request meets a damaged active pointer.
 * - F1, F3, F6: the launch, then a publish that changes the series
 *   statement. After each, Work's one marker (`ul[data-catalog-revision]`,
 *   B3), Home's ready `main` (B6), and the series page's meta tag, main and
 *   statement show the revision /api/ready names.
 * - H1, H2: the series head (title, description, canonical, og:image,
 *   catalog-revision) is all inside <head>, for Twitterbot and a browser.
 * - S1, the series half: the canonical URL, an alias and a case variant, an
 *   unknown slug and a draft, with the same status, Location and
 *   Cache-Control for both agents, and every 404 the not-found page.
 * - F4: a rollback to R1 from this process shows on Home.
 * - F5: a restart, and Home still shows R1.
 * - F2, F7 (Home, Work and the series page): after a third publish shows on
 *   all three, a rollback to R1 through the photos CLI, in a child process,
 *   shows on the first GET of each.
 *
 * The rows that wait on other PRs are todos at the end, each naming the PR.
 */
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VARIANT_BYTES } from '../../lib/catalog/__tests__/catalogFixtures';
import { activateRevision, publish, type PublishResult } from '../../lib/catalog/publish';
import { CATALOG_LOCK } from '../../lib/catalog/repository';
import { createTestCatalog, type TestCatalog, type TestCatalogOptions } from '../../lib/catalog/testing';
import { catalogPaths, readActivePointer } from '../../lib/catalog/working-layer';
import { versionFile } from '../../lib/storage/document';
import { withLock } from '../../lib/storage/lock';
import { runTsx } from '../helpers/runTsx';
import {
    bodyOf,
    copyStandalone,
    DYNAMIC_CACHE_CONTROL,
    editSeries,
    errorShellProblems,
    get,
    headOf,
    links,
    markers,
    meta,
    restart,
    skeleton,
    startStandalone,
    withoutScripts,
    type Agent,
    type StandaloneCopy,
    type StandaloneServer,
} from '../helpers/standaloneServer';

const SITE_URL = 'https://photos.example.test';
const AGENTS: Agent[] = ['bot', 'browser'];
const SLUG = 'harbor-light';
const ALIAS = 'old-harbor-light';
const DRAFT_SLUG = 'quiet-rooms';
const TITLE = 'Harbor light';
const SHORT = 'Harbor light, in short.';
/** The statement revision `n` publishes, so the page shows which revision it came from. */
const statement = (n: number) => `Harbor light, as revision ${n} has it.`;
const quiet = { log: () => undefined };

/**
 * A featured three-photo series with an alias, a second series (B8's moved
 * photo goes there), and a draft. Sparse variants, so the profile is ready
 * and the cover has a share image without writing image files.
 */
const fixture = (seed: number): TestCatalogOptions => ({
    seed,
    photos: 6,
    variantBytes: VARIANT_BYTES,
    series: [
        { slug: SLUG, slugAliases: [ALIAS], title: TITLE, statement: statement(1), shortStatement: SHORT, photos: 3 },
        { slug: 'salt-flats', title: 'Salt flats', statement: 'Salt flats.', shortStatement: 'Salt flats, in short.', photos: 2 },
        { slug: DRAFT_SLUG, title: 'Quiet rooms', visibility: 'draft', photos: 1 },
    ],
});

describe.skipIf(process.env.RUN_PROD_TESTS !== '1')('the pages in production mode follow the served revision', () => {
    let copy: StandaloneCopy | undefined;
    let catalog: TestCatalog | undefined;
    let server: StandaloneServer | undefined;
    /** The server every row but E1's damaged pointer uses, and its pid, which no row here changes. */
    let pid = 0;
    let seriesId = '';
    let viewerPath = '';
    /** F6's two revisions, for the rows after it. */
    let r1 = '';
    let r2 = '';
    let r3 = '';
    const extra: (() => Promise<void> | void)[] = [];

    beforeAll(async () => {
        copy = copyStandalone('freshness');
        catalog = await createTestCatalog(fixture(61));
        const series = catalog.series.find((entry) => entry.slug === SLUG)!;
        seriesId = series.id;
        viewerPath = `/work/${SLUG}/photo/${series.photoIds[1]}`;
        server = await startStandalone({ cwd: copy.dir, dataRoot: catalog.root, library: copy.library, siteUrl: SITE_URL });
        pid = server.pid;
    }, 180_000);

    afterAll(async () => {
        await server?.stop();
        for (const cleanup of extra.splice(0).reverse()) await cleanup();
        await catalog?.cleanup();
        copy?.cleanup();
    });

    const base = () => server!.base;

    async function published(confirmLaunch = false): Promise<PublishResult> {
        const result = await publish({ dataRoot: catalog!.root, actor: 'test', confirmLaunch, logger: quiet });
        expect(result.outcome, result.message).toBe('PUBLISHED');
        return result;
    }

    /** /api/ready's revision, from its header and its body, which must agree. */
    async function readyRevision(at = base()): Promise<string | null> {
        const ready = await get(at, '/api/ready', 'browser');
        const header = ready.headers.get('x-catalog-revision');
        expect(header, ready.html).toBe((JSON.parse(ready.html) as { revisionId: string | null }).revisionId);
        return header;
    }

    /** The server answered every row from one process. */
    function expectSameProcess(): void {
        expect(server!.process.exitCode, server!.output()).toBeNull();
        expect(server!.pid).toBe(pid);
    }

    /**
     * `pathname` as `agent` is Next's bare error shell with a 500: nothing
     * after </head> but the scripts and an empty boundary's hidden div
     * (errorShellProblems()), and, given `reference`, that body's tags.
     */
    async function expectErrorShell(at: string, pathname: string, agent: Agent, reference?: string[]): Promise<string[]> {
        const page = await get(at, pathname, agent);
        const where = `${pathname} as ${agent}`;
        expect(page.status, where).toBe(500);
        expect(page.headers.get('content-type'), where).toContain('text/html');
        expect(page.html, where).toMatch(/<html\b[^>]*\bid="__next_error__"/);
        const body = bodyOf(page.html);
        expect(errorShellProblems(body), `${where}: ${withoutScripts(body)}`).toEqual([]);
        const tags = skeleton(body);
        if (reference) expect(tags, `${where} has /work's error body`).toEqual(reference);
        return tags;
    }

    /** The series and Viewer error pages on `at`, as both agents, each tag for tag what /work sends that agent. */
    async function expectErrorPages(at: string, viewer: string): Promise<void> {
        for (const agent of AGENTS) {
            const work = await expectErrorShell(at, '/work', agent);
            await expectErrorShell(at, `/work/${SLUG}`, agent, work);
            await expectErrorShell(at, viewer, agent, work);
        }
    }

    /** The series page as each agent comes from `revision`: its meta tag, its main, every rev_ in it, and its statement. */
    async function expectSeriesAt(revision: string, shown: string, gone: string[]): Promise<void> {
        for (const agent of AGENTS) {
            const page = await get(base(), `/work/${SLUG}`, agent);
            const where = `/work/${SLUG} as ${agent}`;
            expect(page.status, where).toBe(200);
            const found = markers(page.html);
            expect(found.meta, `${where}: <meta name="catalog-revision">`).toEqual([revision]);
            expect(found.main, `${where}: main[data-catalog-revision]`).toEqual([revision]);
            expect(found.revisions, `${where}: every rev_ in it`).toEqual([revision]);
            expect(withoutScripts(page.html), where).toContain(`<p>${shown}</p>`);
            for (const text of gone) expect(page.html.includes(text), `${where} still shows "${text}"`).toBe(false);
        }
    }

    /**
     * Work as each agent comes from `revision`: the list's marker is the page's
     * only one (B3), and every rev_ in the page is that revision.
     */
    async function expectWorkAt(revision: string): Promise<void> {
        for (const agent of AGENTS) {
            const page = await get(base(), '/work', agent);
            const where = `/work as ${agent}`;
            expect(page.status, where).toBe(200);
            const found = markers(page.html);
            expect(found.list, `${where}: ul[data-catalog-revision]`).toEqual([revision]);
            expect(withoutScripts(page.html).match(/\sdata-catalog-revision=/g), `${where}: one marker`).toHaveLength(1);
            expect(found.revisions, `${where}: every rev_ in it`).toEqual([revision]);
        }
    }

    /** Home as each agent comes from `revision`: one marker on its main, the ready state (B6), and every rev_ that one. */
    async function expectHomeAt(revision: string): Promise<void> {
        for (const agent of AGENTS) {
            const page = await get(base(), '/', agent);
            const where = `/ as ${agent}`;
            expect(page.status, where).toBe(200);
            const found = markers(page.html);
            expect(found.main, `${where}: main[data-catalog-revision]`).toEqual([revision]);
            expect(found.homeState, `${where}: main[data-home-state]`).toEqual(['ready']);
            expect(found.revisions, `${where}: every rev_ in it`).toEqual([revision]);
        }
    }

    it('E1: answers the series and Viewer pages with /work\'s bare error shell before the launch', async () => {
        const ready = await get(base(), '/api/ready', 'browser');
        expect(ready.status).toBe(503);
        expect(JSON.parse(ready.html)).toMatchObject({ state: 'unavailable', reason: 'not-published' });
        await expectErrorPages(base(), viewerPath);
        expectSameProcess();
    }, 60_000);

    it('E1: answers them with the same shell when a new server\'s first read meets a damaged pointer', async () => {
        const damaged = await createTestCatalog(fixture(67));
        extra.push(() => damaged.cleanup());
        const result = await publish({ dataRoot: damaged.root, actor: 'test', confirmLaunch: true, logger: quiet });
        expect(result.outcome, result.message).toBe('PUBLISHED');
        // The newest pointer version, the one readActivePointer() reads, before any server has loaded the revision.
        const pointer = await readActivePointer(damaged.root);
        fs.writeFileSync(versionFile(catalogPaths(damaged.root).active, pointer!.version), 'not json');
        const started = await startStandalone({ cwd: copy!.dir, dataRoot: damaged.root, library: copy!.library, siteUrl: SITE_URL });
        extra.push(() => started.stop());
        const ready = await get(started.base, '/api/ready', 'browser');
        expect(ready.status, started.output()).toBe(503);
        expect(JSON.parse(ready.html)).toMatchObject({ state: 'unavailable', revisionId: null });
        // The slug comes from the spec; the photo IDs from the seed, so the Viewer path is this root's own.
        const series = damaged.series.find((entry) => entry.slug === SLUG)!;
        await expectErrorPages(started.base, `/work/${SLUG}/photo/${series.photoIds[1]}`);
        expect(started.output()).not.toContain(damaged.root);
    }, 120_000);

    it('F1, F3, F6: shows the launch and a statement publish on Work, Home and the series page, as /api/ready names them', async () => {
        // The launch, on a server that was up before it. Each page first, so nothing else warmed the reader for it.
        r1 = (await published(true)).revisionId!;
        await expectWorkAt(r1);
        await expectHomeAt(r1);
        await expectSeriesAt(r1, statement(1), [statement(2)]);
        expect(await readyRevision()).toBe(r1);

        await editSeries(catalog!.root, seriesId, { statement: statement(2) });
        r2 = (await published()).revisionId!;
        expect(r2).not.toBe(r1);
        await expectWorkAt(r2);
        // F3: Home's marker is the new revision, ready.
        await expectHomeAt(r2);
        await expectSeriesAt(r2, statement(2), [statement(1)]);
        expect(await readyRevision()).toBe(r2);
        expectSameProcess();
    }, 120_000);

    it('H1, H2: keeps the series head in <head>, for Twitterbot and a browser alike', async () => {
        expect(r2, 'F1, F3, F6 published').not.toBe('');
        for (const agent of AGENTS) {
            const page = await get(base(), `/work/${SLUG}`, agent);
            const where = `/work/${SLUG} as ${agent}`;
            expect(page.status, where).toBe(200);
            const head = headOf(page.html);
            const body = bodyOf(page.html);
            const titles = [...withoutScripts(head).matchAll(/<title>([^<]*)<\/title>/g)].map((match) => match[1]);
            expect(titles, `${where}: the title`).toHaveLength(1);
            expect(titles[0], where).toContain(TITLE);
            expect(meta(head, 'description'), where).toEqual([SHORT]);
            expect(links(head, 'canonical'), where).toEqual([`${SITE_URL}/work/${SLUG}`]);
            const images = meta(head, 'og:image');
            expect(images, `${where}: og:image`).toHaveLength(1);
            expect(images[0], where).toMatch(new RegExp(`^${SITE_URL.replace(/\./g, '\\.')}/media/`));
            expect(meta(head, 'catalog-revision'), where).toEqual([r2]);
            // Nothing of it streamed in after </head>.
            expect(withoutScripts(body), `${where}: a title after </head>`).not.toMatch(/<title[\s>]/i);
            for (const name of ['description', 'og:image', 'catalog-revision']) expect(meta(body, name), `${where}: ${name} after </head>`).toEqual([]);
            expect(links(body, 'canonical'), `${where}: canonical after </head>`).toEqual([]);
        }
        expectSameProcess();
    }, 60_000);

    it('S1: answers the series URLs with the same status, Location and Cache-Control for both agents', async () => {
        expect(r2, 'F1, F3, F6 published').not.toBe('');
        const canonical = `/work/${SLUG}`;
        const rows: { path: string; status: number; location?: string }[] = [
            { path: canonical, status: 200 },
            { path: `/work/${ALIAS}?from=card&photo=2`, status: 308, location: `${canonical}?from=card&photo=2` },
            { path: '/work/Harbor-Light', status: 308, location: canonical },
            { path: '/work/HARBOR-LIGHT?from=card', status: 308, location: `${canonical}?from=card` },
            { path: '/work/no-such-series', status: 404 },
            { path: `/work/${DRAFT_SLUG}`, status: 404 },
        ];
        for (const row of rows) {
            const answers: { status: number; location: string | null; cacheControl: string | null }[] = [];
            for (const agent of AGENTS) {
                const page = await get(base(), row.path, agent);
                const where = `${row.path} as ${agent}`;
                expect(page.status, where).toBe(row.status);
                expect(page.headers.get('cache-control'), where).toBe(DYNAMIC_CACHE_CONTROL);
                const location = page.headers.get('location');
                if (row.location === undefined) {
                    expect(location, where).toBeNull();
                } else {
                    // Next may send the path alone or against the request's origin; either way it's this one.
                    const target = new URL(location!, base());
                    expect(target.origin, where).toBe(base());
                    expect(`${target.pathname}${target.search}`, where).toBe(row.location);
                }
                if (row.status === 404) {
                    expect(withoutScripts(page.html), where).toContain('Page not found');
                    expect(meta(headOf(page.html), 'robots').some((value) => value.includes('noindex')), `${where}: noindex in <head>`).toBe(true);
                }
                answers.push({ status: page.status, location, cacheControl: page.headers.get('cache-control') });
            }
            expect(answers[1], `${row.path}: the browser's answer is Twitterbot's`).toEqual(answers[0]);
        }
        expectSameProcess();
    }, 60_000);

    it('F4: shows a rollback from this process on Home', async () => {
        expect(r2, 'F1, F3, F6 published').not.toBe('');
        const rollback = await withLock(CATALOG_LOCK, { root: catalog!.root }, (lock) => activateRevision({
            lock,
            revisionId: r1,
            expectedActiveRevisionId: r2,
            kind: 'rollback',
            actor: 'test',
            reason: 'F4',
        }));
        expect(rollback.outcome, rollback.message).toBe('ACTIVATED');
        await expectHomeAt(r1);
        expect(await readyRevision()).toBe(r1);
        expectSameProcess();
    }, 60_000);

    it('F5: still shows the rollback on Home after a restart', async () => {
        expect(r2, 'F1, F3, F6 published').not.toBe('');
        expect(server!.output()).not.toContain('catalog.read.failed');
        // The one row that restarts: a new process on the same copy, roots and SITE_URL.
        server = await restart(server!);
        expect(server.pid).not.toBe(pid);
        pid = server.pid;
        await expectHomeAt(r1);
        expect(await readyRevision()).toBe(r1);
        expectSameProcess();
    }, 120_000);

    it('F2, F7: shows a rollback by the photos CLI on the first GET of Home, Work and the series page', async () => {
        expect(r2, 'F1, F3, F6 published').not.toBe('');
        // A third revision, shown on every page, so the rollback below is a change each page has to follow.
        await editSeries(catalog!.root, seriesId, { statement: statement(3) });
        r3 = (await published()).revisionId!;
        expect([r1, r2]).not.toContain(r3);
        await expectHomeAt(r3);
        await expectWorkAt(r3);
        await expectSeriesAt(r3, statement(3), [statement(1), statement(2)]);
        expect(await readyRevision()).toBe(r3);

        // #15's rollback, in its own process, as the curator runs it.
        const rolled = await runTsx('scripts/photos.ts', ['rollback', '--to', r1, '--reason', 'F7', '--actor', 'test', '--yes', '--expect-active', r3], {
            env: { PHOTOGRAPHY_DATA_DIR: catalog!.root, PHOTOS_ACTOR: undefined },
        });
        expect(rolled.code, rolled.stderr).toBe(0);
        expect(rolled.stdout).toContain(`ROLLED_BACK: Rolled back to revision 1 (${r1})`);
        // Each page's first GET since, as both agents, before /api/ready asks.
        await expectHomeAt(r1);
        await expectWorkAt(r1);
        await expectSeriesAt(r1, statement(1), [statement(2), statement(3)]);
        expect(await readyRevision()).toBe(r1);
        expectSameProcess();
        expect(server!.output()).not.toContain('catalog.read.failed');
        expect(server!.output()).not.toContain(catalog!.root);
    }, 120_000);

    // Waiting on other PRs: each lands with the markers or routes it needs.
    it.todo("F8 (waits on B8): on a copied root, the Viewer's meta tag follows a caption publish and a rollback, and the original root is byte-identical");
    it.todo("F9 (waits on B8): Home, Work, the series page and the Viewer all show F7's target after a restart");
    it.todo("H3 (waits on B8): the Viewer's h1 with its sr-only position, the aria-hidden counter, caption, alt, AVIF and WebP srcsets and the full head, for both agents");
    it.todo('S1, the Viewer half (waits on B8): 200, 308s from an alias, a case variant and a moved photo, and 404s for an unknown id and a draft, alike for both agents');
});
