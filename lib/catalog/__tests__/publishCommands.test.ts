// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTsx, type TsxRun } from '../../../test/helpers/runTsx';
import { withLock } from '../../storage/lock';
import { CATALOG_LOCK, listActivations, revisionFilePath } from '../repository';
import { createTestCatalog, type TestCatalog } from '../testing';
import { writeAuthoredRecord } from '../working-layer-writer';
import { readActivePointer, readWorkingLayer } from '../working-layer';
import { VARIANT_BYTES } from './catalogFixtures';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(seed: number): Promise<TestCatalog> {
    const catalog = await createTestCatalog({ seed, photos: 3, series: 1, variantBytes: VARIANT_BYTES });
    cleanups.push(() => catalog.cleanup());
    return catalog;
}

/** photos <args> against `root`, with no PHOTOS_ACTOR unless `env` sets one. */
const photos = (root: string, args: string[], env: Record<string, string | undefined> = {}): Promise<TsxRun> =>
    runTsx('scripts/photos.ts', args, { env: { PHOTOGRAPHY_DATA_DIR: root, PHOTOS_ACTOR: undefined, ...env } });

const candidateOf = (output: string) => /^Candidate: (rev_[0-9a-f]{64})$/m.exec(output)?.[1] ?? null;
const eventsOf = (stdout: string) => stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => (JSON.parse(line) as { event: string; outcome?: string }));

async function breakAlt(catalog: TestCatalog): Promise<string> {
    const photo = (await readWorkingLayer(catalog.root)).photos[0];
    await writeAuthoredRecord({ ...photo, alt: null }, { expectedVersion: photo.version, root: catalog.root });
    return photo.id;
}

describe('photos validate', { timeout: 120_000 }, () => {
    it('prints the candidate and exits 0 when nothing but warnings remain, writing nothing', async () => {
        const catalog = await fixture(101);
        const run = await photos(catalog.root, ['validate']);
        expect(run.code, run.stderr).toBe(0);
        expect(run.stdout).toContain('[photos] VALID: The working layer passes, with 0 errors and 0 warnings.');
        expect(candidateOf(run.stdout)).toBe(catalog.revisionId);
        expect(fs.existsSync(path.join(catalog.root, 'catalog'))).toBe(false);
    });

    it('prints each issue and exits 1 on an error', async () => {
        const catalog = await fixture(102);
        const photoId = await breakAlt(catalog);
        const run = await photos(catalog.root, ['validate']);
        expect(run.code).toBe(1);
        expect(run.stderr).toMatch(/^\[photos\] VALIDATION_FAILED: The working layer has \d+ errors? and \d+ warnings?\.$/m);
        expect(run.stderr).toMatch(new RegExp(`^error photo ${photoId} alt: .+ \\(description\\.[a-z-]+\\)$`, 'm'));
        expect(run.stderr).not.toContain(catalog.root);
    });

    it('exits 3 when the data root isn\'t there, and 2 on a usage error', async () => {
        const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-cli-')), 'missing');
        cleanups.push(() => fs.promises.rm(path.dirname(missing), { recursive: true, force: true }));
        const notReady = await photos(missing, ['validate']);
        expect(notReady.code).toBe(3);
        expect(notReady.stderr).toContain('[photos] DATA_ROOT_NOT_READY: The data root is unavailable');
        const usage = await photos(missing, ['validate', '--fast']);
        expect(usage.code).toBe(2);
        expect(usage.stderr).toContain('Usage:');
    });
});

describe('photos publish', { timeout: 120_000 }, () => {
    it('needs an actor, from --actor or PHOTOS_ACTOR, and a well-formed --expect', async () => {
        const catalog = await fixture(103);
        const noActor = await photos(catalog.root, ['publish', '--confirm-launch']);
        expect(noActor.code).toBe(2);
        expect(noActor.stderr).toContain('photos publish needs --actor <name> or PHOTOS_ACTOR.');
        const badExpect = await photos(catalog.root, ['publish', '--actor', 'test', '--expect', 'latest']);
        expect(badExpect.code).toBe(2);
        expect(fs.existsSync(path.join(catalog.root, 'catalog'))).toBe(false);
    });

    it('asks to confirm the launch, publishes once confirmed, and then has nothing to publish', async () => {
        const catalog = await fixture(104);
        const unconfirmed = await photos(catalog.root, ['publish'], { PHOTOS_ACTOR: 'cli-test' });
        expect(unconfirmed.code).toBe(3);
        expect(unconfirmed.stderr).toContain('[photos] LAUNCH_CONFIRMATION_REQUIRED: This is the first publish: 3 photographs replace the legacy Home and Gallery.');
        expect(unconfirmed.stderr).toContain('Launch: this revision replaces the legacy Home and Gallery with 3 photographs. Every photograph in the library is in it.');
        expect(unconfirmed.stderr).toContain('Run it again with --confirm-launch to publish it.');

        const published = await photos(catalog.root, ['publish', '--confirm-launch', '--reason', 'launch'], { PHOTOS_ACTOR: 'cli-test' });
        expect(published.code, published.stderr).toBe(0);
        expect(published.stdout).toContain(`[photos] PUBLISHED: Published ${catalog.revisionId} as revision 1.`);
        expect(published.stdout).toContain(`Active: ${catalog.revisionId}, revision 1`);
        expect(eventsOf(published.stdout).map((entry) => entry.event)).toEqual(['catalog.publish.started', 'catalog.publish.validated', 'catalog.publish.activated']);
        expect((await listActivations(catalog.root))[0]).toMatchObject({ actor: 'cli-test', reason: 'launch' });

        const again = await photos(catalog.root, ['publish', '--actor', 'cli-test']);
        expect(again.code).toBe(0);
        expect(again.stdout).toContain(`[photos] NO_CHANGES: ${catalog.revisionId} is already active.`);
    });

    it('exits 1 on validation errors and 4 on a damaged revision file', async () => {
        const catalog = await fixture(105);
        expect((await photos(catalog.root, ['publish', '--actor', 'test', '--confirm-launch'])).code).toBe(0);
        const photoId = await breakAlt(catalog);
        const invalid = await photos(catalog.root, ['publish', '--actor', 'test']);
        expect(invalid.code).toBe(1);
        expect(invalid.stderr).toMatch(new RegExp(`^error photo ${photoId} alt: `, 'm'));

        const photo = (await readWorkingLayer(catalog.root)).photos.find((entry) => entry.id === photoId);
        if (!photo) throw new Error('No photo record.');
        await writeAuthoredRecord({ ...photo, alt: { kind: 'decorative' } }, { expectedVersion: photo.version, root: catalog.root });
        const dryRun = await photos(catalog.root, ['publish', '--actor', 'test', '--dry-run']);
        expect(dryRun.code, dryRun.stderr).toBe(0);
        const candidateId = candidateOf(dryRun.stdout);
        if (!candidateId) throw new Error(`No candidate in ${dryRun.stdout}`);
        fs.writeFileSync(revisionFilePath(catalog.root, candidateId), '{"revisionId": "half');
        const damaged = await photos(catalog.root, ['publish', '--actor', 'test', '--expect', candidateId]);
        expect(damaged.code).toBe(4);
        expect(damaged.stderr).toContain(`[photos] INTEGRITY_MISMATCH: catalog/revisions/${candidateId}.json is not valid JSON.`);
        expect((await readActivePointer(catalog.root))?.revisionId).toBe(catalog.revisionId);
    });

    it('names the holder when another publish has the catalog lock', async () => {
        const catalog = await fixture(106);
        const { run, holder } = await withLock(CATALOG_LOCK, { root: catalog.root }, async () => {
            const record = JSON.parse(fs.readFileSync(path.join(catalog.root, 'locks', `${CATALOG_LOCK}.lock`), 'utf8')) as { acquiredAt: string };
            return { run: await photos(catalog.root, ['publish', '--actor', 'test', '--confirm-launch']), holder: record };
        });
        expect(run.code).toBe(3);
        expect(run.stderr).toContain(`[photos] CATALOG_LOCKED: Another publish holds the catalog lock: `);
        expect(run.stderr).toContain(`(pid ${process.pid} on ${os.hostname()}, since ${holder.acquiredAt})`);
    });

    it('lets two processes publishing at once end in one activation: PUBLISHED, and CATALOG_LOCKED or NO_CHANGES', async () => {
        const catalog = await fixture(107);
        const runs = await Promise.all([1, 2].map(() => photos(catalog.root, ['publish', '--actor', 'test', '--confirm-launch'])));
        const outcomes = runs.map((run) => /^\[photos\] ([A-Z_]+):/m.exec(`${run.stdout}${run.stderr}`)?.[1]).sort();
        expect(outcomes.includes('PUBLISHED')).toBe(true);
        expect([['CATALOG_LOCKED', 'PUBLISHED'], ['NO_CHANGES', 'PUBLISHED']]).toContainEqual(outcomes);
        expect(runs.map((run) => run.code).sort()).toEqual(outcomes[0] === 'CATALOG_LOCKED' ? [0, 3] : [0, 0]);
        expect((await listActivations(catalog.root)).filter((activation) => activation.status === 'committed')).toHaveLength(1);
    });
});
