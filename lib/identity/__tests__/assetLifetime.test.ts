// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary } from '../../../test/helpers/tempLibrary';
import { GET as photosRoute } from '../../../app/api/photos/route';
import { processImage } from '../../../utils/imageOptimizer';
import { resolveAsset } from '../../media/manifest';
import { assetsRoot } from '../../media/path';
import type { AssetRef } from '../../media/url';
import { runReconcilePass } from '../pass';
import { currentProfileId } from '../profile';
import { readRegistry } from '../registry';
import { createWorker } from '../worker';
import { sequentialIds } from './reconcileFixtures';

vi.mock('next/server', async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    // Outside Next there is no request scope, and the route only needs it to wait.
    connection: vi.fn(async () => undefined),
}));

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
let images: Buffer[];
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
    images = await Promise.all([20, 140, 230].map((r) =>
        sharp({ create: { width: 320, height: 240, channels: 3, background: { r, g: 255 - r, b: 60 } } }).jpeg().toBuffer()));
});

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function identity() {
    const lib = await createTempLibrary();
    cleanups.push(() => lib.cleanup());
    const data = createTempDataRoot();
    cleanups.push(() => data.cleanup());
    const idGen = sequentialIds();
    const worker = createWorker({ logger: quiet });
    cleanups.push(async () => {
        worker.stop();
        await worker.idle();
    });
    /** One watcher step: a pass, then the worker builds what it left pending. Files count as settled. */
    const step = async () => {
        const outcome = await runReconcilePass({ clock: () => Date.now() + 3_600_000, idGen, logger: quiet });
        if (outcome.status !== 'committed') throw new Error(JSON.stringify(outcome));
        const started = await worker.start();
        if (!started.started) throw new Error(JSON.stringify(started));
        await worker.enqueuePending();
        await worker.idle();
    };
    return { lib, data, step };
}

/** Every file in the asset store with its bytes, to show nothing in it changes. */
function assetStore(root: string): Record<string, string> {
    const store = assetsRoot(root);
    const files: Record<string, string> = {};
    for (const relative of fs.readdirSync(store, { recursive: true, encoding: 'utf8' }).sort()) {
        const file = path.join(store, relative);
        if (fs.statSync(file).isFile()) files[relative] = fs.readFileSync(file).toString('base64');
    }
    return files;
}

describe('a revision a catalog refers to', () => {
    it('stays ready through a replacement, a rename, and the source being deleted', async () => {
        const s = await identity();
        fs.writeFileSync(s.lib.file('ridge.jpg'), images[0]);
        await s.step();
        const [photo] = Object.values((await readRegistry(s.data.root)).photos);
        const first: AssetRef = { photoId: photo.photoId, assetRevision: photo.source.observedRevision, profileId: currentProfileId() };
        expect((await resolveAsset(first)).state).toBe('ready');

        // Replaced: the photo gets a new revision with its own set, and the first set stays.
        fs.writeFileSync(s.lib.file('ridge.jpg'), images[1]);
        await s.step();
        const replaced = (await readRegistry(s.data.root)).photos[photo.photoId];
        expect(replaced.source.observedRevision).not.toBe(first.assetRevision);
        const second: AssetRef = { ...first, assetRevision: replaced.source.observedRevision };
        expect((await resolveAsset(first)).state).toBe('ready');
        expect((await resolveAsset(second)).state).toBe('ready');
        const store = assetStore(s.data.root);

        // Renamed, then deleted: nothing in the asset store changes, and both revisions still resolve.
        fs.mkdirSync(s.lib.file('trips'));
        fs.renameSync(s.lib.file('ridge.jpg'), s.lib.file('trips', 'ridge-at-dawn.jpg'));
        await s.step();
        expect((await readRegistry(s.data.root)).photos[photo.photoId].source).toMatchObject({ path: 'trips/ridge-at-dawn.jpg', present: true });
        fs.rmSync(s.lib.file('trips', 'ridge-at-dawn.jpg'));
        await s.step();
        expect((await readRegistry(s.data.root)).photos[photo.photoId].sourceHealth).toBe('missing');
        for (const ref of [first, second]) expect(await resolveAsset(ref)).toMatchObject({ state: 'ready', manifest: { photoId: photo.photoId, assetRevision: ref.assetRevision } });
        expect(assetStore(s.data.root)).toEqual(store);
    }, 120_000);
});

describe('/api/photos', () => {
    it('lists the photos the identity step records, at their legacy URLs, and the next step changes nothing', async () => {
        const s = await identity();
        for (const [index, name] of ['dawn.jpg', 'dusk.jpg', 'night.jpg'].entries()) {
            fs.writeFileSync(s.lib.file(name), images[index]);
            await processImage(name);
        }
        const read = async () => {
            const response = await photosRoute();
            return { status: response.status, headers: Object.fromEntries(response.headers), body: (await response.json()) as unknown };
        };
        // It lists from the registry the step writes, so there is nothing to list yet.
        expect(await read()).toMatchObject({ status: 503, body: { reason: 'registry-missing' } });
        const library = fs.readdirSync(s.lib.root, { recursive: true, encoding: 'utf8' }).sort();

        await s.step();
        expect(Object.keys(assetStore(s.data.root)).filter((file) => file.endsWith('manifest.json'))).toHaveLength(3);
        const listed = await read();
        expect(listed.status).toBe(200);
        expect((listed.body as { src: string }[]).map((item) => item.src).sort())
            .toEqual(['dawn', 'dusk', 'night'].map((name) => `/assets/photos/optimized/${name}.webp`));
        await s.step();
        expect(await read()).toEqual(listed);
        // The identity step wrote only to the data root.
        expect(fs.readdirSync(s.lib.root, { recursive: true, encoding: 'utf8' }).sort()).toEqual(library);
    }, 120_000);
});
