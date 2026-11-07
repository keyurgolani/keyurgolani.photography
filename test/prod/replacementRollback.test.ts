// @vitest-environment node
/**
 * #17's rollback after a replacement on the standalone build (#15's shared
 * row, v2.0.0), which `npm run test:prod` makes first. Plain `npm test`
 * skips it unless RUN_PROD_TESTS=1.
 *
 * It serves a copy of .next/standalone on 127.0.0.1 over #17's replacement
 * world (lib/curation/__tests__/replacementWorld.ts): a temp library and
 * data root where P, published at asset revision A in revision 1, has had
 * its file replaced by other pixels, B, and one watcher pass has opened the
 * replacement item. B's set is built and the item confirmed, the way the
 * watcher and `curation confirm` do it, and a publish makes revision 2. The
 * server serves B's URLs, none with any of A's bytes, and 404s A's. A
 * watcher pass then keeps A's set, and after #15's rollback to revision 1,
 * from this process, the server serves A's URLs again, with the same bytes as
 * before, and 404s B's, with no restart. The Home records endpoint names the
 * URLs of the revision served at each step.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publish } from '../../lib/catalog/publish';
import { rollback } from '../../lib/catalog/rollback';
import { createWorld, makeImages, OWNER, quiet, removeTemplate, SERIES, setDir, type World } from '../../lib/curation/__tests__/replacementWorld';
import { confirmReplacement } from '../../lib/curation/resolutions';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../../lib/identity/variants';
import { mediaUrl } from '../../lib/media/url';
import { MANIFEST_FILE } from '../../lib/storage/publish';

const STANDALONE = path.resolve(import.meta.dirname, '../../.next/standalone');
const IMMUTABLE = 'public, max-age=31536000, immutable';
const ACTOR = 'curator:test';

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

interface Server {
    base: string;
    process: ChildProcess;
    stop: () => Promise<void>;
}

/** Serve the standalone copy at `cwd` on 127.0.0.1 with only these temp roots, and wait until it answers. */
async function startServer(cwd: string, dataRoot: string, library: string): Promise<Server> {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    // Only the temp roots, whatever this shell points PHOTOGRAPHY_* at.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PHOTOGRAPHY_')));
    const child = spawn(process.execPath, ['server.js'], {
        cwd,
        env: { ...env, NODE_ENV: 'production', PORT: String(port), HOSTNAME: '127.0.0.1', PHOTOGRAPHY_DATA_DIR: dataRoot, PHOTOGRAPHY_LIBRARY_DIR: library },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => (output += chunk));
    child.stderr?.on('data', (chunk) => (output += chunk));
    const stop = async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit');
        child.kill();
        await exited;
    };
    const deadline = Date.now() + 60_000;
    for (;;) {
        if (child.exitCode !== null) throw new Error(`The server exited with ${child.exitCode}:\n${output}`);
        try {
            await (await fetch(`${base}/api/health`)).arrayBuffer();
            break;
        } catch {
            // Not listening yet.
        }
        if (Date.now() > deadline) {
            await stop();
            throw new Error(`The server did not answer within 60 s:\n${output}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { base, process: child, stop };
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe.skipIf(process.env.RUN_PROD_TESTS !== '1')('a rollback after a replacement publish, on the standalone build', () => {
    let world: World | undefined;
    let served: string | undefined;
    let server: Server | undefined;

    beforeAll(async () => {
        if (!fs.existsSync(path.join(STANDALONE, 'server.js'))) {
            throw new Error('There is no .next/standalone/server.js. Run npm run test:prod, which builds first.');
        }
        served = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-test-replacement-'));
        fs.cpSync(STANDALONE, served, { recursive: true, verbatimSymlinks: true });
        world = await createWorld(await makeImages());
        server = await startServer(served, world.root, world.lib.root);
    }, 180_000);

    afterAll(async () => {
        await server?.stop();
        await world?.cleanup();
        removeTemplate();
        if (served) fs.rmSync(served, { recursive: true, force: true });
    });

    /** P's URL for every variant of `assetRevision`'s set. */
    function urlsOf(assetRevision: string): string[] {
        const ref = { photoId: world!.p, assetRevision, profileId: world!.profileId };
        return VARIANT_WIDTHS.flatMap((width) => VARIANT_FORMATS.map((format) => mediaUrl(ref, width, format)));
    }

    async function ready(): Promise<Record<string, unknown>> {
        const response = await fetch(`${server!.base}/api/ready`);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        return (await response.json()) as Record<string, unknown>;
    }

    /** Each URL answers 200, `immutable`, and the SHA-256 of its bytes, by URL. */
    async function servedBytes(urls: readonly string[]): Promise<Record<string, string>> {
        const digests: Record<string, string> = {};
        for (const url of urls) {
            const response = await fetch(`${server!.base}${url}`);
            expect(response.status, url).toBe(200);
            expect(response.headers.get('cache-control'), url).toBe(IMMUTABLE);
            digests[url] = sha256(Buffer.from(await response.arrayBuffer()));
        }
        return digests;
    }

    /** Each URL answers a 404 nothing caches. */
    async function refused(urls: readonly string[]): Promise<void> {
        for (const url of urls) {
            const response = await fetch(`${server!.base}${url}`);
            expect(response.status, url).toBe(404);
            expect(response.headers.get('cache-control'), url).toBe('no-store');
            await response.arrayBuffer();
        }
    }

    /** The Home records for P in `revisionId`, as text, after checking they're that revision's. */
    async function homeRecords(revisionId: string): Promise<string> {
        const response = await fetch(`${server!.base}/api/catalog/home/series/${SERIES}/photos/${world!.p}?revision=${revisionId}`);
        expect(response.status).toBe(200);
        expect(response.headers.get('x-catalog-revision')).toBe(revisionId);
        return response.text();
    }

    it('serves the new set after the replacement publish, and the old URLs again, with the same bytes, after a rollback', async () => {
        const w = world!;
        const pid = server!.process.pid;
        const [oldUrls, newUrls] = [urlsOf(w.a), urlsOf(w.b)];

        // Revision 1 serves A. B's set is built and confirmed into the draft, and still not public.
        expect(await w.build(w.job(w.b))).toEqual({ status: 'ready', reused: false });
        const item = await w.event();
        expect(item).toMatchObject({ type: 'replacement', status: 'open', candidate: { state: 'ready' } });
        const confirmed = await confirmReplacement({ root: w.root, eventId: item.id, expectedVersion: item.version, expectedBase: w.revisionId, actor: ACTOR });
        expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
        expect(await ready()).toMatchObject({ state: 'ok', revisionId: w.revisionId, revisionNumber: 1 });
        const before = await servedBytes(oldUrls);
        await refused(newUrls);
        const firstRecords = await homeRecords(w.revisionId);
        for (const url of oldUrls) expect(firstRecords).toContain(url);
        for (const url of newUrls) expect(firstRecords).not.toContain(url);

        // The replacement publish: revision 2 serves B, with other bytes, and A's URLs answer 404.
        const second = await publish({ dataRoot: w.root, actor: OWNER, logger: quiet });
        expect(second.outcome, second.message).toBe('PUBLISHED');
        expect(await ready()).toMatchObject({ state: 'ok', revisionId: second.revisionId, revisionNumber: 2 });
        const replaced = await servedBytes(newUrls);
        // Other pixels in every variant: no B file has any A file's bytes.
        for (const digest of Object.values(replaced)) expect(Object.values(before)).not.toContain(digest);
        await refused(oldUrls);
        const secondRecords = await homeRecords(second.revisionId!);
        for (const url of newUrls) expect(secondRecords).toContain(url);
        for (const url of oldUrls) expect(secondRecords).not.toContain(url);

        // The watcher's next pass, as image-watcher would run one between the publish and the rollback, keeps A's set:
        // only revision 1 holds it now, and nothing but #15's GC, from the CLI, ever removes a set.
        await w.pass();
        expect(fs.existsSync(path.join(setDir(w, w.a), MANIFEST_FILE)), "A's set after the watcher's pass").toBe(true);

        // #15's rollback to revision 1: the old URLs serve again, byte for byte, and B's answer 404.
        const rolled = await rollback({ dataRoot: w.root, revisionId: w.revisionId, expectedActiveRevisionId: second.revisionId!, actor: OWNER, reason: 'back to A', logger: quiet });
        expect(rolled.outcome, rolled.message).toBe('ROLLED_BACK');
        expect(await ready()).toMatchObject({ state: 'ok', revisionId: w.revisionId, revisionNumber: 1 });
        expect(await servedBytes(oldUrls)).toEqual(before);
        await refused(newUrls);
        const rolledRecords = await homeRecords(w.revisionId);
        for (const url of oldUrls) expect(rolledRecords).toContain(url);
        for (const url of newUrls) expect(rolledRecords).not.toContain(url);

        expect(server!.process.exitCode).toBeNull();
        expect(server!.process.pid).toBe(pid);
    }, 120_000);
});
