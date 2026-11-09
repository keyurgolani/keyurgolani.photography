// @vitest-environment node
/**
 * C1, #12's burst row: 50 fetches of a series page while 20 publishes
 * run one after another, on a copy of .next/standalone with its own data
 * root and server. `npm run test:prod` builds first; plain `npm test` skips
 * it unless RUN_PROD_TESTS=1.
 *
 * Publish i sets the series' short statement to `Burst statement i.`, so the
 * page says which revision it came from in two ways. Inside each publish's
 * step 10 hook two fetches start, not awaited, and inside step 13 of every
 * even publish one more: 40 and 10. The agent alternates between a browser
 * and Twitterbot. Every fetch must get a 200 whose meta tag and main name
 * one revision X once each, every rev_ in it X, X one of R0 to R20, every
 * `Burst statement N.` in it X's N, and its one description that statement.
 * X must also be one the fetch could have met: servableRevisions(), the
 * window rule, in test/helpers/standaloneServer.ts.
 *
 * Across the run: no catalog.read.failed in the server's output, and at
 * least two distinct revisions served. How many fetches straddled a
 * pointer write is logged, not asserted.
 */
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VARIANT_BYTES } from '../../lib/catalog/__tests__/catalogFixtures';
import { publish } from '../../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../../lib/catalog/testing';
import {
    blockingText,
    copyStandalone,
    editSeries,
    get,
    markers,
    meta,
    servableRevisions,
    startStandalone,
    type Agent,
    type Fetched,
    type PublishTimes,
    type StandaloneCopy,
    type StandaloneServer,
} from '../helpers/standaloneServer';

const PUBLISHES = 20;
const SLUG = 'burst';
const statement = (n: number) => `Burst statement ${n}.`;
const STATEMENT_RE = /Burst statement (\d+)\./g;
const quiet = { log: () => undefined };

interface Sample {
    agent: Agent;
    /** Which publish's hook started it, and at which step. */
    from: string;
    fetched?: Fetched;
    error?: string;
}

describe.skipIf(process.env.RUN_PROD_TESTS !== '1')('C1: a series page during a burst of publishes', () => {
    let copy: StandaloneCopy | undefined;
    let catalog: TestCatalog | undefined;
    let server: StandaloneServer | undefined;

    beforeAll(async () => {
        copy = copyStandalone('burst');
        catalog = await createTestCatalog({
            seed: 71,
            photos: 3,
            variantBytes: VARIANT_BYTES,
            series: [{ slug: SLUG, title: 'Burst', statement: 'A series published twenty times over.', shortStatement: statement(0), photos: 3 }],
        });
    }, 180_000);

    afterAll(async () => {
        await server?.stop();
        await catalog?.cleanup();
        copy?.cleanup();
    });

    it('serves one whole revision the fetch could have met to each of 50 fetches during 20 publishes', async () => {
        const root = catalog!.root;
        const seriesId = catalog!.series[0].id;
        const pathname = `/work/${SLUG}`;

        // R0, then the server, warmed by both agents.
        const launch = await publish({ dataRoot: root, actor: 'test', confirmLaunch: true, logger: quiet });
        expect(launch.outcome, blockingText(launch)).toBe('PUBLISHED');
        const revisions = [launch.revisionId!];
        server = await startStandalone({ cwd: copy!.dir, dataRoot: root, library: copy!.library });
        for (const agent of ['browser', 'bot'] as const) {
            const warm = await get(server.base, pathname, agent);
            expect(warm.status, warm.html.slice(0, 500)).toBe(200);
            expect(markers(warm.html).meta).toEqual([revisions[0]]);
        }

        const times: PublishTimes[] = [];
        const samples: Promise<Sample>[] = [];
        const fetchOnce = (from: string) => {
            const agent: Agent = samples.length % 2 === 0 ? 'browser' : 'bot';
            // Started, never awaited here: the publish goes on while it runs. A failure is kept, not thrown.
            samples.push(get(server!.base, pathname, agent).then(
                (fetched): Sample => ({ agent, from, fetched }),
                (error: unknown): Sample => ({ agent, from, error: String(error) }),
            ));
        };

        const started = performance.now();
        for (let i = 1; i <= PUBLISHES; i++) {
            await editSeries(root, seriesId, { shortStatement: statement(i) });
            const entry: PublishTimes = { afterStep10: Number.NaN, afterStep11: Number.NaN };
            const result = await publish({
                dataRoot: root,
                actor: 'test',
                logger: quiet,
                hooks: {
                    afterStep(step) {
                        if (step === 10) {
                            entry.afterStep10 = performance.now();
                            fetchOnce(`publish ${i}, step 10`);
                            fetchOnce(`publish ${i}, step 10`);
                        } else if (step === 11) {
                            entry.afterStep11 = performance.now();
                        } else if (step === 13 && i % 2 === 0) {
                            fetchOnce(`publish ${i}, step 13`);
                        }
                    },
                },
            });
            expect(result.outcome, blockingText(result)).toBe('PUBLISHED');
            expect(Number.isFinite(entry.afterStep10) && Number.isFinite(entry.afterStep11), `publish ${i} ran steps 10 and 11`).toBe(true);
            revisions.push(result.revisionId!);
            times.push(entry);
        }
        const settled = await Promise.all(samples);
        const elapsed = Math.round(performance.now() - started);
        expect(settled).toHaveLength(50);
        expect(new Set(revisions).size, 'every publish made a new revision').toBe(PUBLISHES + 1);

        const problems: string[] = [];
        const served = new Set<string>();
        let straddled = 0;
        for (const [index, sample] of settled.entries()) {
            const where = `fetch ${index} (${sample.from}, ${sample.agent})`;
            if (!sample.fetched) {
                problems.push(`${where}: ${sample.error}`);
                continue;
            }
            const { status, html, t0, t1 } = sample.fetched;
            if (status !== 200) {
                problems.push(`${where}: ${status}`);
                continue;
            }
            const found = markers(html);
            if (found.meta.length !== 1 || found.main.length !== 1 || found.meta[0] !== found.main[0]) {
                problems.push(`${where}: meta ${JSON.stringify(found.meta)}, main ${JSON.stringify(found.main)}`);
                continue;
            }
            const revision = found.meta[0];
            served.add(revision);
            if (found.revisions.length !== 1 || found.revisions[0] !== revision) problems.push(`${where}: names ${found.revisions.join(', ')}, not only ${revision}`);
            const k = revisions.indexOf(revision);
            if (k === -1) {
                problems.push(`${where}: ${revision} is none of R0 to R${PUBLISHES}`);
                continue;
            }
            // The statement, wherever the page repeats it (the description, og:description, the Flight payload), is R_k's.
            const numbers = new Set([...html.matchAll(STATEMENT_RE)].map((match) => Number(match[1])));
            if (numbers.size !== 1 || !numbers.has(k)) problems.push(`${where}: R${k} with statements ${[...numbers].join(', ') || 'none'}`);
            const descriptions = meta(html, 'description');
            if (descriptions.length !== 1 || descriptions[0] !== statement(k)) problems.push(`${where}: R${k} with descriptions ${JSON.stringify(descriptions)}`);
            const allowed = servableRevisions(times, t0, t1);
            if (!allowed.includes(k)) problems.push(`${where}: R${k} outside its window, which allowed ${allowed.map((n) => `R${n}`).join(', ')}`);
            if (allowed.length > 1) straddled++;
        }

        console.log(`C1: ${settled.length} fetches during ${PUBLISHES} publishes in ${elapsed} ms; ${served.size} distinct revisions served; ${straddled} straddled a pointer write.`);
        expect(problems).toEqual([]);
        expect(served.size, 'distinct revisions served').toBeGreaterThanOrEqual(2);
        expect(server.output()).not.toContain('catalog.read.failed');
    }, 120_000);
});
