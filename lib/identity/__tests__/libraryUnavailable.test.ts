// @vitest-environment node
import fs from 'node:fs';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { newestRegistryVersion } from '../../../test/helpers/registryFiles';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, setLibraryDir, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { checkWatcherHealth, watcherStatusFile } from '../heartbeat';
import { ASSET_REVISION_RE } from '../ids';
import { LIBRARY_UNAVAILABLE_BOUND, LIBRARY_UNAVAILABLE_SHARE, massMissing, type LibraryVerdict } from '../library';
import { runReconcilePass, type PassOutcome } from '../pass';
import { readRegistry } from '../registry';
import { IO_ERROR_AFTER_PASSES } from '../reconcile';
import type { IdentityFact } from '../types';
import { createIdentityStep, LIBRARY_RETRY_MAX_MS, LIBRARY_RETRY_MS, type PassReason } from '../watcherStep';
import { sequentialIds } from './reconcileFixtures';

/**
 * A6 (#17): `library-unavailable`. A missing, empty, or unreadable library
 * root refuses the pass, changes nothing, and tells the watcher's library
 * hook, which the curation inbox turns into one item. The watcher looks
 * again with a backoff, logging once per cause. A file that reads EACCES,
 * EPERM or EIO for three passes in a row is reported as `processing-failed`
 * with `io-error`.
 */

const NOW = Date.parse('2026-05-04T08:00:00.000Z');
const isRoot = process.getuid?.() === 0;
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };

let images: Buffer[];
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
    images = await Promise.all([30, 110, 190].map((tint) =>
        sharp({ create: { width: 240, height: 160, channels: 3, background: { r: tint, g: 255 - tint, b: 70 } } }).jpeg().toBuffer()));
});

afterEach(async () => {
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function roots(photos = 2): Promise<{ lib: TempLibrary; data: TempDataRoot }> {
    const lib = await createTempLibrary();
    cleanups.push(() => lib.cleanup());
    const data = createTempDataRoot();
    cleanups.push(() => data.cleanup());
    for (let index = 0; index < photos; index++) fs.writeFileSync(lib.file(`photo-${index + 1}.jpg`), images[index]);
    return { lib, data };
}

/** A pass an hour ahead, so files written by the test count as settled, delivering to `facts`. */
function passWith(facts: IdentityFact[] = [], idGen = sequentialIds()) {
    let hour = 0;
    return () => runReconcilePass({ clock: () => Date.now() + 3_600_000 * ++hour, idGen, logger: quiet, sinks: [(delivered) => { facts.push(...delivered); }], clearDelivered: true });
}

describe('thresholds', () => {
    it('are 20 bound sources and over 10% of them, as decided', () => {
        expect(LIBRARY_UNAVAILABLE_BOUND).toBe(20);
        expect(LIBRARY_UNAVAILABLE_SHARE).toBe(0.1);
        expect(massMissing(20, 199)).toBe(true);
        expect(massMissing(19, 20)).toBe(false);
        expect(massMissing(20, 200)).toBe(false);
        expect(massMissing(21, 200)).toBe(true);
        expect(massMissing(0, 0)).toBe(false);
    });
});

describe('a pass over an unavailable library', { timeout: 60_000 }, () => {
    it('refuses a missing root, changing nothing', async () => {
        const { lib, data } = await roots();
        const pass = passWith();
        expect((await pass()).status).toBe('committed');
        const version = newestRegistryVersion(data.root);
        const before = lib.snapshot();
        const gone = `${lib.root}-unmounted`;
        cleanups.push(async () => setLibraryDir(lib.root)());
        setLibraryDir(gone);
        const outcome = await pass();
        expect(outcome).toEqual({ status: 'skipped', reason: 'library-unavailable', cause: 'missing' } satisfies PassOutcome);
        expect(newestRegistryVersion(data.root)).toBe(version);
        // Review nit: the watcher wrote nothing under the library, and nothing where it was.
        expect(lib.snapshot()).toEqual(before);
        expect(fs.existsSync(gone)).toBe(false);
    });

    it.skipIf(isRoot)('refuses an unreadable root, naming the errno and no path', async () => {
        const { lib, data } = await roots();
        const pass = passWith();
        await pass();
        const version = newestRegistryVersion(data.root);
        fs.chmodSync(lib.root, 0o000);
        cleanups.push(async () => fs.chmodSync(lib.root, 0o755));
        const outcome = await pass();
        expect(outcome).toEqual({ status: 'skipped', reason: 'library-unavailable', cause: 'unreadable', detail: 'EACCES' });
        expect(newestRegistryVersion(data.root)).toBe(version);
        expect(Object.values((await readRegistry(data.root)).photos).map((photo) => photo.sourceHealth)).toEqual(['present', 'present']);
    });
});

describe('the identity step', { timeout: 60_000 }, () => {
    function step(lib: TempLibrary, options: { library?: (state: LibraryVerdict) => void } = {}) {
        const lines: string[] = [];
        const push = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
        const requests: { reason: PassReason; delayMs?: number }[] = [];
        const verdicts: LibraryVerdict[] = [];
        const created = createIdentityStep({
            logger: { log: push, warn: push, error: push },
            clock: () => NOW,
            requestPass: (reason, delayMs) => { requests.push(delayMs === undefined ? { reason } : { reason, delayMs }); },
            library: async (state) => {
                verdicts.push(state);
                options.library?.(state);
            },
            pass: { clock: () => Date.now() + 3_600_000, idGen: sequentialIds() },
        });
        cleanups.push(async () => {
            created.stop();
            await created.idle();
        });
        return { step: created, lines, requests, verdicts };
    }

    it('tells the library hook, looks again with a backoff, and logs once per cause', async () => {
        const { lib, data } = await roots();
        const s = step(lib);
        expect((await s.step.pass('startup')).status).toBe('committed');
        expect(s.verdicts).toEqual([{ available: true }]);

        const gone = `${lib.root}-unmounted`;
        cleanups.push(async () => setLibraryDir(lib.root)());
        setLibraryDir(gone);
        for (let index = 0; index < 6; index++) {
            expect(await s.step.pass('library-unavailable')).toEqual({ status: 'refused', reason: 'library-unavailable', cause: 'missing' });
        }
        expect(s.verdicts.slice(1)).toEqual(Array(6).fill({ available: false, cause: 'missing' }));
        expect(s.requests.filter((request) => request.reason === 'library-unavailable').map((request) => request.delayMs)).toEqual([
            LIBRARY_RETRY_MS, LIBRARY_RETRY_MS * 2, LIBRARY_RETRY_MS * 4, LIBRARY_RETRY_MS * 8, LIBRARY_RETRY_MAX_MS, LIBRARY_RETRY_MAX_MS,
        ]);
        expect(s.lines.filter((line) => line.includes('The library root is missing'))).toHaveLength(1);
        expect(s.lines.join('\n')).not.toContain(gone);
        const heartbeat = JSON.parse(fs.readFileSync(watcherStatusFile(data.root), 'utf8')) as { lastPassResult: string };
        expect(heartbeat.lastPassResult).toBe('library-unavailable');
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', data.root);
        expect(await checkWatcherHealth({ clock: () => NOW })).toEqual({ healthy: false, message: expect.stringContaining('library') });

        // Back again: the hook hears so, the backoff starts over, and the next outage logs again.
        setLibraryDir(lib.root);
        expect((await s.step.pass('timer')).status).toBe('committed');
        expect(s.verdicts.at(-1)).toEqual({ available: true });
        expect(s.lines.filter((line) => line.includes('The library is back'))).toHaveLength(1);
        setLibraryDir(gone);
        await s.step.pass('event');
        expect(s.requests.at(-1)).toEqual({ reason: 'library-unavailable', delayMs: LIBRARY_RETRY_MS });
        expect(s.lines.filter((line) => line.includes('The library root is missing'))).toHaveLength(2);
    });

    it('reports an emptied library as unavailable too, keeping library-empty in the heartbeat for older readers', async () => {
        const { lib, data } = await roots();
        const s = step(lib);
        await s.step.pass('startup');
        for (const name of fs.readdirSync(lib.root)) fs.renameSync(lib.file(name), `${data.root}/${name}.aside`);
        expect(await s.step.pass('event')).toMatchObject({ status: 'refused', reason: 'library-empty' });
        expect(s.verdicts.at(-1)).toEqual({ available: false, cause: 'empty' });
        expect((JSON.parse(fs.readFileSync(watcherStatusFile(data.root), 'utf8')) as { lastPassResult: string }).lastPassResult).toBe('library-empty');
    });

    it('keeps passing when the hook throws, and logs it', async () => {
        const { lib } = await roots();
        const s = step(lib, { library: () => { throw new Error('the inbox is busy'); } });
        expect((await s.step.pass('startup')).status).toBe('committed');
        expect(s.lines.some((line) => line.includes('the inbox is busy'))).toBe(true);
    });
});

describe.skipIf(isRoot)('a file that stays unreadable', { timeout: 60_000 }, () => {
    it('is reported once as processing-failed with io-error on its third skipped pass', async () => {
        const { lib } = await roots(2);
        const facts: IdentityFact[] = [];
        const pass = passWith(facts);
        await pass();
        const bound = Object.values((await readRegistry(process.env.PHOTOGRAPHY_DATA_DIR as string)).photos).find((photo) => photo.source.path === 'photo-2.jpg');
        fs.chmodSync(lib.file('photo-2.jpg'), 0o000);
        fs.writeFileSync(lib.file('photo-3.jpg'), images[2]);
        fs.chmodSync(lib.file('photo-3.jpg'), 0o000);
        cleanups.push(async () => {
            fs.chmodSync(lib.file('photo-2.jpg'), 0o644);
            fs.chmodSync(lib.file('photo-3.jpg'), 0o644);
        });
        facts.length = 0;
        expect(IO_ERROR_AFTER_PASSES).toBe(3);
        for (let skipped = 1; skipped < IO_ERROR_AFTER_PASSES; skipped++) {
            await pass();
            expect(facts.filter((fact) => fact.type === 'processing-failed'), `skipped ${skipped}`).toEqual([]);
        }
        await pass();
        const failed = facts.filter((fact) => fact.type === 'processing-failed');
        expect(failed).toEqual([
            expect.objectContaining({ photoId: bound?.photoId, assetRevision: bound?.source.observedRevision, path: 'photo-2.jpg', reason: 'io-error' }),
            expect.objectContaining({ photoId: null, path: 'photo-3.jpg', reason: 'io-error', assetRevision: expect.stringMatching(ASSET_REVISION_RE) }),
        ]);
        // The photo it was stays as it was: present, with nothing marked missing.
        expect((await readRegistry(process.env.PHOTOGRAPHY_DATA_DIR as string)).photos[bound?.photoId as string].sourceHealth).toBe('present');
        facts.length = 0;
        await pass();
        expect(facts.filter((fact) => fact.type === 'processing-failed')).toEqual([]);
    });

    it('starts the count over once the file reads again', async () => {
        const { lib } = await roots(1);
        const facts: IdentityFact[] = [];
        const pass = passWith(facts);
        await pass();
        cleanups.push(async () => fs.chmodSync(lib.file('photo-1.jpg'), 0o644));
        for (const round of [1, 2]) {
            fs.chmodSync(lib.file('photo-1.jpg'), 0o000);
            await pass();
            await pass();
            fs.chmodSync(lib.file('photo-1.jpg'), 0o644);
            await pass();
            expect(facts.filter((fact) => fact.type === 'processing-failed'), `round ${round}`).toEqual([]);
        }
    });
});
