// @vitest-environment node
/**
 * `npm run test:prod` builds, then runs this against .next/standalone. Plain
 * `npm test` skips it unless RUN_PROD_TESTS=1, since it needs that build.
 *
 * It serves the build on a temp data root and library, publishes twice and
 * rolls back once, and checks after each step that /api/ready, /api/photos,
 * and /media follow the active revision with the same server process.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activateRevision, publish, type PublishResult } from '../../lib/catalog/publish';
import { CATALOG_LOCK } from '../../lib/catalog/repository';
import { createTestCatalog, type TestCatalog } from '../../lib/catalog/testing';
import { writeAuthoredRecord } from '../../lib/catalog/working-layer-writer';
import { readWorkingLayer } from '../../lib/catalog/working-layer';
import { mediaUrl } from '../../lib/media/url';
import { withLock } from '../../lib/storage/lock';

const STANDALONE = path.resolve(import.meta.dirname, '../../.next/standalone');
const IMMUTABLE = 'public, max-age=31536000, immutable';
const quiet = { log: () => undefined };

/** A port nothing on 127.0.0.1 listens on right now. */
async function freePort(): Promise<number> {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address() as net.AddressInfo;
    probe.close();
    await once(probe, 'close');
    return port;
}

describe.skipIf(process.env.RUN_PROD_TESTS !== '1')('the standalone build', () => {
    let catalog: TestCatalog | undefined;
    let library: string | undefined;
    let server: ChildProcess | undefined;
    let output = '';
    let base = '';

    beforeAll(async () => {
        if (!fs.existsSync(path.join(STANDALONE, 'server.js'))) {
            throw new Error('There is no .next/standalone/server.js. Run npm run test:prod, which builds first.');
        }
        catalog = await createTestCatalog({ withAssets: true, photos: 3, series: [{ photos: 2 }, { photos: 1, visibility: 'draft' }], seed: 47 });
        library = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-test-library-'));
        const port = await freePort();
        base = `http://127.0.0.1:${port}`;
        // Only the temp roots, whatever this shell points PHOTOGRAPHY_* at.
        const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PHOTOGRAPHY_')));
        server = spawn(process.execPath, ['server.js'], {
            cwd: STANDALONE,
            env: { ...env, NODE_ENV: 'production', PORT: String(port), HOSTNAME: '127.0.0.1', PHOTOGRAPHY_DATA_DIR: catalog.root, PHOTOGRAPHY_LIBRARY_DIR: library },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        server.stdout?.on('data', (chunk) => (output += chunk));
        server.stderr?.on('data', (chunk) => (output += chunk));
        const deadline = Date.now() + 60_000;
        for (;;) {
            if (server.exitCode !== null) throw new Error(`The server exited with ${server.exitCode}:\n${output}`);
            try {
                if ((await fetch(`${base}/api/health`)).ok) break;
            } catch {
                // Not listening yet.
            }
            if (Date.now() > deadline) throw new Error(`The server did not answer within 60 s:\n${output}`);
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }, 120_000);

    afterAll(async () => {
        if (server && server.exitCode === null) {
            server.kill();
            await once(server, 'exit');
        }
        await catalog?.cleanup();
        if (library) fs.rmSync(library, { recursive: true, force: true });
    });

    async function ready(): Promise<Record<string, unknown>> {
        const response = await fetch(`${base}/api/ready`);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        return (await response.json()) as Record<string, unknown>;
    }

    /** The `medium` URL of each listed photo, in list order, after checking the mode and revision headers. */
    async function listed(mode: 'legacy' | 'catalog', revision: string): Promise<string[]> {
        const response = await fetch(`${base}/api/photos`);
        expect(response.status).toBe(200);
        expect(response.headers.get('x-catalog-mode')).toBe(mode);
        expect(response.headers.get('x-catalog-revision')).toBe(revision);
        return ((await response.json()) as { medium: string }[]).map((item) => item.medium);
    }

    async function expectServed(url: string): Promise<void> {
        const response = await fetch(`${base}${url}`);
        expect(response.status, url).toBe(200);
        expect(response.headers.get('cache-control')).toBe(IMMUTABLE);
        expect(response.headers.get('content-type')).toBe('image/webp');
        await response.arrayBuffer();
    }

    async function expectRefused(url: string): Promise<void> {
        const response = await fetch(`${base}${url}`);
        expect(response.status, url).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
        await response.arrayBuffer();
    }

    async function published(): Promise<PublishResult> {
        const result = await publish({ dataRoot: catalog!.root, actor: 'test', confirmLaunch: true, logger: quiet });
        expect(result.outcome, result.message).toBe('PUBLISHED');
        return result;
    }

    it('follows each activation and a rollback without a restart', async () => {
        const root = catalog!.root;
        const pid = server!.pid;
        const [shown, draft] = catalog!.series;
        const urlOf = (photoId: string) => {
            const photo = catalog!.photos.find((entry) => entry.id === photoId)!;
            return mediaUrl({ photoId, assetRevision: photo.assetRevision!, profileId: catalog!.profileId }, 'w800', 'webp');
        };
        const firstUrls = shown.photoIds.map(urlOf);
        const draftUrl = urlOf(draft.photoIds[0]);

        // Before the first activation: legacy mode, and an empty library lists nothing.
        expect(await ready()).toEqual({ mode: 'legacy', state: 'ok', revisionId: null, revisionNumber: null, activatedAt: null });
        expect(await listed('legacy', 'legacy')).toEqual([]);
        for (const url of [...firstUrls, draftUrl]) await expectRefused(url);

        // The first publish lists and serves the published series only.
        const first = await published();
        expect(await ready()).toMatchObject({ mode: 'catalog', state: 'ok', revisionId: first.revisionId, revisionNumber: 1 });
        expect(await listed('catalog', first.revisionId!)).toEqual(firstUrls);
        for (const url of firstUrls) await expectServed(url);
        await expectRefused(draftUrl);

        // Publishing the draft series adds its photo.
        const layer = await readWorkingLayer(root);
        const record = layer.series.find((entry) => entry.id === draft.id)!;
        await writeAuthoredRecord({ ...structuredClone(record), visibility: 'published' }, { expectedVersion: record.version, root });
        const second = await published();
        expect(await ready()).toMatchObject({ mode: 'catalog', state: 'ok', revisionId: second.revisionId, revisionNumber: 2 });
        expect(await listed('catalog', second.revisionId!)).toEqual([...firstUrls, draftUrl]);
        await expectServed(draftUrl);

        // Rolling back to the first revision takes it away again.
        const rollback = await withLock(CATALOG_LOCK, { root }, (lock) => activateRevision({
            lock,
            revisionId: first.revisionId!,
            expectedActiveRevisionId: second.revisionId!,
            kind: 'rollback',
            actor: 'test',
            reason: 'rollback',
        }));
        expect(rollback.outcome, rollback.message).toBe('ACTIVATED');
        expect(await ready()).toEqual({
            mode: 'catalog',
            state: 'ok',
            revisionId: first.revisionId,
            revisionNumber: 1,
            activatedAt: rollback.activation!.committedAt,
        });
        expect(await listed('catalog', first.revisionId!)).toEqual(firstUrls);
        for (const url of firstUrls) await expectServed(url);
        await expectRefused(draftUrl);

        expect(server!.exitCode).toBeNull();
        expect(server!.pid).toBe(pid);
    }, 120_000);
});
