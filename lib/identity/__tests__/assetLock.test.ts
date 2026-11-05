// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeDataRootMarker } from '../../../test/helpers/tempDataRoot';
import { withLock } from '../../storage/lock';
import { assetLockName, buildDerivativeSet, stagingRoot } from '../derivatives';
import { runReconcilePass } from '../pass';
import { currentProfileId } from '../profile';
import { readRegistry } from '../registry';
import { sequentialIds } from './reconcileFixtures';

/**
 * #181's A10 review, item 40a: "create staging for X" and "photos gc
 * --set-aside X" are exclusive. A build takes X's asset lock before its
 * staging folder exists and holds it through the publish, and --set-aside
 * takes the same lock, so neither can start while the other runs. Temp
 * folders only, and the test deletes nothing.
 */

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };

afterEach(() => vi.unstubAllEnvs());

async function pendingJob() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-lock-'));
    const root = path.join(dir, 'data');
    const library = path.join(dir, 'library');
    fs.mkdirSync(root);
    fs.mkdirSync(library);
    writeDataRootMarker(root);
    vi.stubEnv('PHOTOGRAPHY_DATA_DIR', root);
    vi.stubEnv('PHOTOGRAPHY_LIBRARY_DIR', library);
    const bytes = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg({ quality: 90 }).toBuffer();
    fs.writeFileSync(path.join(library, 'landscape.jpg'), bytes);
    const outcome = await runReconcilePass({ clock: () => Date.now() + 60_000, idGen: sequentialIds(), logger: quiet });
    if (outcome.status !== 'committed') throw new Error(JSON.stringify(outcome));
    const registry = await readRegistry(root);
    const [photo] = Object.values(registry.photos);
    return { root, job: { photoId: photo.photoId, assetRevision: photo.source.observedRevision, profileId: currentProfileId(), path: 'landscape.jpg' } };
}

describe("a build and --set-aside exclude each other by the asset's lock (item 40a)", { timeout: 60_000 }, () => {
    it('makes no staging folder for an asset whose lock another command holds, and stays pending', async () => {
        const { root, job } = await pendingJob();
        const outcome = await withLock(assetLockName(job.photoId, job.assetRevision), { root, waitMs: 0 }, () => buildDerivativeSet(job, { logger: quiet }));
        expect(outcome).toEqual({ status: 'pending', reason: 'locked' });
        expect(fs.existsSync(stagingRoot(root)) ? fs.readdirSync(stagingRoot(root)) : []).toEqual([]);
    });

    it('holds the asset lock from before its staging folder exists through the publish', async () => {
        const { root, job } = await pendingJob();
        let held = false;
        const outcome = await buildDerivativeSet(job, { logger: quiet, faults: { beforePublish: async () => {
            held = await withLock(assetLockName(job.photoId, job.assetRevision), { root, waitMs: 0 }, async () => false).catch(() => true);
        } } });
        expect(outcome).toMatchObject({ status: 'ready' });
        expect(held).toBe(true);
        // And lets it go once done.
        expect(await withLock(assetLockName(job.photoId, job.assetRevision), { root, waitMs: 0 }, async () => 'free')).toBe('free');
    });
});
