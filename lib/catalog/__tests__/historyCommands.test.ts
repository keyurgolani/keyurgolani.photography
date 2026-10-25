// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTsx, type TsxRun } from '../../../test/helpers/runTsx';
import { publish } from '../publish';
import { listActivations } from '../repository';
import { rollback } from '../rollback';
import { createTestCatalog, type TestCatalog } from '../testing';
import { writeAuthoredRecord } from '../working-layer-writer';
import { catalogPaths, readActivePointer, readWorkingLayer } from '../working-layer';
import { VARIANT_BYTES } from './catalogFixtures';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

const quiet = { log: () => undefined };

/** A data root with revision 1 and revision 2 published, which differ in one photo's caption. */
async function twoRevisions(seed: number): Promise<{ catalog: TestCatalog; one: string; two: string; changed: string }> {
    const catalog = await createTestCatalog({ seed, photos: 3, series: 1, variantBytes: VARIANT_BYTES });
    cleanups.push(() => catalog.cleanup());
    const first = await publish({ dataRoot: catalog.root, actor: 'test', confirmLaunch: true, logger: quiet });
    const photo = (await readWorkingLayer(catalog.root)).photos[0];
    await writeAuthoredRecord({ ...photo, caption: 'A caption revision 2 publishes.' }, { expectedVersion: photo.version, root: catalog.root });
    const second = await publish({ dataRoot: catalog.root, actor: 'test', logger: quiet });
    if (first.outcome !== 'PUBLISHED' || second.outcome !== 'PUBLISHED') throw new Error(`Publishing ended ${first.outcome} and ${second.outcome}.`);
    return { catalog, one: first.revisionId ?? '', two: second.revisionId ?? '', changed: photo.id };
}

/** photos <args> against `root`, in a new process, with no PHOTOS_ACTOR unless `env` sets one. Its stdin is not a terminal. */
const photos = (root: string, args: string[], env: Record<string, string | undefined> = {}): Promise<TsxRun> =>
    runTsx('scripts/photos.ts', args, { env: { PHOTOGRAPHY_DATA_DIR: root, PHOTOS_ACTOR: undefined, ...env } });

describe('photos history and photos rollback, as commands', { timeout: 180_000 }, () => {
    it('rolls back from the command line only with --yes and --expect-active, and a new process sees it live', async () => {
        const { catalog, one, two, changed } = await twoRevisions(301);
        const root = catalog.root;

        const noActor = await photos(root, ['rollback', '--to', '1', '--reason', 'caption']);
        expect(noActor.code).toBe(2);
        expect(noActor.stderr).toContain('photos rollback needs --actor <name> or PHOTOS_ACTOR.');
        const yesAlone = await photos(root, ['rollback', '--to', '1', '--reason', 'caption', '--yes'], { PHOTOS_ACTOR: 'curator' });
        expect(yesAlone.code).toBe(2);
        expect(yesAlone.stderr).toContain('--yes needs --expect-active <revisionId>');

        const unconfirmed = await photos(root, ['rollback', '--to', '1', '--reason', 'caption'], { PHOTOS_ACTOR: 'curator' });
        expect(unconfirmed.code).toBe(3);
        expect(unconfirmed.stdout).toContain(`[photos] READY: Ready to roll back from revision 2 (${two}) to revision 1 (${one}).`);
        expect(unconfirmed.stdout).toContain(`Changes 1 photo: ${changed}`);
        expect(unconfirmed.stderr).toContain(`--yes --expect-active ${two}`);
        expect(await listActivations(root)).toHaveLength(2);

        const rolled = await photos(root, ['rollback', '--to', '1', '--reason', 'caption', '--actor', 'curator', '--yes', '--expect-active', two]);
        expect(rolled.code, rolled.stderr).toBe(0);
        expect(rolled.stdout).toContain(`[photos] ROLLED_BACK: Rolled back to revision 1 (${one}) from revision 2 (${two}).`);
        expect(rolled.stdout).toContain(`Active: ${one}, revision 1`);

        // A restart: a new process reads the same history and pointer.
        const history = await photos(root, ['history']);
        expect(history.code, history.stderr).toBe(0);
        expect(history.stdout).toContain(`[photos] 3 activations, oldest first. Live: revision 1, ${one}, from #3.`);
        expect(history.stdout).toMatch(/^#3 revision 1: rollback, committed, LIVE$/m);
        expect(history.stdout).toMatch(/^ {4}\S+ by curator: caption$/m);
        expect(history.stdout).not.toContain(root);

        const again = await photos(root, ['rollback', '--to', one, '--reason', 'caption', '--actor', 'curator']);
        expect(again.code).toBe(0);
        expect(again.stdout).toContain(`[photos] NO_CHANGES: revision 1 (${one}) is already active.`);
        const never = await photos(root, ['rollback', '--to', '9', '--reason', 'caption', '--actor', 'curator']);
        expect(never.code).toBe(1);
        expect(never.stderr).toContain('[photos] NOT_ELIGIBLE: No revision 9 has been active.');
        const badTarget = await photos(root, ['rollback', '--to', 'latest', '--reason', 'caption', '--actor', 'curator']);
        expect(badTarget.code).toBe(2);
    });

    it('shows a rollback a crash interrupted after the pointer moved as live after a restart, and the next publish settles it', async () => {
        const { catalog, one, two } = await twoRevisions(302);
        const root = catalog.root;
        const crashed = await rollback({
            dataRoot: root, revisionId: one, expectedActiveRevisionId: two, actor: 'curator', reason: 'caption', logger: quiet,
            hooks: { afterStep: (step) => { if (step === 11) throw new Error('crash after step 11'); } },
        });
        expect(crashed.outcome).toBe('STORAGE_ERROR');

        const history = await photos(root, ['history']);
        expect(history.code, history.stderr).toBe(0);
        expect(history.stdout).toMatch(/^#3 revision 1: rollback, committed, LIVE$/m);
        expect(history.stdout).toContain('its record still says pending.');

        const published = await photos(root, ['publish', '--actor', 'test']);
        expect(published.code, published.stderr).toBe(0);
        expect(published.stdout).toContain(`[photos] NO_CHANGES: ${one} is already active.`);
        expect((await listActivations(root)).map((activation) => activation.status)).toEqual(['committed', 'committed', 'committed']);
        expect(await readActivePointer(root)).toMatchObject({ revisionId: one });
    });

    it.skipIf(process.getuid?.() === 0)('prints history on a data root it can only read, writing nothing', async () => {
        const { catalog, two } = await twoRevisions(304);
        const root = catalog.root;
        const directories = [
            ...fs.readdirSync(root, { recursive: true, encoding: 'utf8' }).map((relative) => path.join(root, relative)).filter((entry) => fs.lstatSync(entry).isDirectory()).sort().reverse(),
            root,
        ];
        const modes = new Map(directories.map((dir) => [dir, fs.statSync(dir).mode & 0o7777]));
        cleanups.unshift(async () => {
            for (const [dir, mode] of [...modes].reverse()) fs.chmodSync(dir, mode);
        });
        for (const dir of directories) fs.chmodSync(dir, 0o500);
        const history = await photos(root, ['history']);
        expect(history.code, history.stderr).toBe(0);
        expect(history.stdout).toContain(`Live: revision 2, ${two}, from #2.`);
    });

    it('exits 4 on a damaged revision file, 3 without a data root, and 2 on a usage error', async () => {
        const { catalog, one } = await twoRevisions(303);
        const root = catalog.root;
        fs.writeFileSync(path.join(catalogPaths(root).revisionsDir, `${one}.json`), '{ not json');
        const damaged = await photos(root, ['history']);
        expect(damaged.code).toBe(4);
        expect(damaged.stderr).toContain(`Its revision can't be read: catalog/revisions/${one}.json is not valid JSON.`);
        expect(damaged.stderr).toContain('[photos] INTEGRITY_MISMATCH: 1 activation names a revision that can\'t be read.');

        const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-history-')), 'missing');
        cleanups.push(() => fs.promises.rm(path.dirname(missing), { recursive: true, force: true }));
        const notReady = await photos(missing, ['history']);
        expect(notReady.code).toBe(3);
        expect(notReady.stderr).toContain('[photos] DATA_ROOT_NOT_READY');
        expect((await photos(missing, ['history', '--json'])).code).toBe(2);
    });
});
