// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeWatcherHeartbeat } from '../../identity/heartbeat';
import { readRegistry, writeRegistry } from '../../identity/registry';
import { versionFile } from '../../storage/document';
import { LockLostError, withLock } from '../../storage/lock';
import { initDrafts, runDraftInit } from '../draft-init';
import { listPhotos, ownerStatus, runListCommand, runStatusCommand } from '../owner-status';
import { publish, type PublishOptions } from '../publish';
import { listActivations } from '../repository';
import { createTestCatalog, type TestCatalog, type TestCatalogOptions } from '../testing';
import { authoredPaths, authoredRecordDir, catalogPaths, readActivePointer, readAuthoredRecord, readWorkingLayer } from '../working-layer';
import { AUTHORED_LOCK, writeAuthoredRecord } from '../working-layer-writer';
import { newestRecordFile, VARIANT_BYTES } from './catalogFixtures';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(options: TestCatalogOptions = {}): Promise<TestCatalog> {
    const catalog = await createTestCatalog({ seed: 1310, photos: 4, series: [{ photos: 3 }], variantBytes: VARIANT_BYTES, ...options });
    cleanups.push(() => catalog.cleanup());
    return catalog;
}

const quiet = { log: () => undefined };
const run = (catalog: TestCatalog, options: Partial<PublishOptions> = {}) => publish({ dataRoot: catalog.root, actor: 'test', confirmLaunch: true, logger: quiet, ...options });

/** The output with the data root replaced, which must then hold no absolute path. */
function withoutRoot(output: string, root: string): string {
    const replaced = output.split(root).join('<root>').split(fs.realpathSync(root)).join('<root>');
    expect(replaced).not.toContain(os.tmpdir());
    expect(replaced).not.toContain(fs.realpathSync(os.tmpdir()));
    expect(replaced).not.toMatch(/(^|[\s("'])\/(?!>)/m);
    return replaced;
}

async function editCaption(catalog: TestCatalog, caption: string): Promise<void> {
    const photo = await readAuthoredRecord(catalog.root, 'photo', catalog.content.photos[0].id);
    if (!photo) throw new Error('no photo record');
    await writeAuthoredRecord({ ...photo, caption }, { expectedVersion: photo.version, root: catalog.root });
}

const crashAfter = (stepNumber: number): Partial<PublishOptions> => ({
    hooks: {
        afterStep(step) {
            if (step === stepNumber) throw new Error(`crash after step ${stepNumber}`);
        },
    },
});

describe('photos status', () => {
    it('reports the data root, the catalog, the registry, and the working layer, with no absolute path but the root', async () => {
        const catalog = await fixture();
        const clock = () => Date.parse('2026-10-24T12:01:00.000Z');
        await writeWatcherHeartbeat(catalog.root, { pid: 1, hostname: 'fixture', lastPassAt: null, lastPassResult: null, passStartedAt: null, heartbeatAt: '2026-10-24T12:00:00.000Z' });
        const result = await runStatusCommand({ dataRoot: catalog.root }, { clock });
        expect(result.exitCode).toBe(0);
        const text = withoutRoot(result.output, catalog.root);
        expect(text).toContain('Data root: <root> (ready)');
        expect(text).toContain('Catalog: legacy mode, nothing published yet, so the site lists the registry\'s photos');
        expect(text).toContain('Last publish: none yet');
        expect(text).toContain('Photos: 4 in the registry (present 4, missing 0, ambiguous 0, archived 0)');
        expect(text).toContain('Working layer: site.json, 1 series record (published 1, draft 0, hidden 0), 4 photo records');
        expect(text).toContain('Unassigned: 1 photo in the library that no series lists');
        expect(text).toContain('Watcher heartbeat: 60 s ago (2026-10-24T12:00:00.000Z)');
    });

    it('prints JSON with the same facts', async () => {
        const catalog = await fixture();
        await run(catalog);
        const result = await runStatusCommand({ dataRoot: catalog.root }, { json: true });
        const status = JSON.parse(result.output) as Awaited<ReturnType<typeof ownerStatus>>;
        expect(Object.keys(status)).toEqual(['identity', 'catalog', 'working']);
        expect(status.catalog).toMatchObject({ mode: 'catalog', active: { revisionNumber: 1, status: 'committed', kind: 'publish', actor: 'test' }, lastPublish: { outcome: 'PUBLISHED' } });
        expect(status.working).toMatchObject({ site: true, photoRecords: 4, unassigned: [catalog.photos[3].id] });
    });

    it('prints its report and exits 1 when the data root is missing or unset', async () => {
        const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kg13d-status-')), 'missing');
        cleanups.push(() => fs.promises.rm(path.dirname(missing), { recursive: true, force: true }));
        const result = await runStatusCommand({ dataRoot: missing });
        expect(result).toEqual({ exitCode: 1, output: `Data root: ${missing} (unavailable: it does not exist)\n` });
        const unset = await runStatusCommand({ dataRoot: null });
        expect(unset).toEqual({ exitCode: 1, output: 'Data root: not set (unset: PHOTOGRAPHY_DATA_DIR is not set)\n' });
    });

    it('reports the revision the pointer names as live after a first publish crashes past the switch', async () => {
        const catalog = await fixture();
        expect((await run(catalog, crashAfter(11))).outcome).not.toBe('PUBLISHED');
        expect(await readActivePointer(catalog.root)).toMatchObject({ revisionId: catalog.revisionId });
        const status = await ownerStatus({ dataRoot: catalog.root });
        expect(status.catalog.active).toMatchObject({ revisionId: catalog.revisionId, revisionNumber: 1, status: 'pending' });
        const { output } = await runStatusCommand({ dataRoot: catalog.root });
        expect(output).toContain(`revision 1 (${catalog.revisionId}) is live`);
        expect(output).toContain('Activation 1 is pending. The next photos publish settles it.');
        expect(output).not.toContain('nothing published yet');
    });

    it('reports the new revision as live after a later publish crashes past the switch', async () => {
        const catalog = await fixture();
        expect((await run(catalog)).outcome).toBe('PUBLISHED');
        await editCaption(catalog, 'Fixture caption, edited.');
        const crashed = await run(catalog, crashAfter(11));
        expect(crashed.outcome).not.toBe('PUBLISHED');
        const pointer = await readActivePointer(catalog.root);
        expect(pointer?.revisionId).not.toBe(catalog.revisionId);
        const { output } = await runStatusCommand({ dataRoot: catalog.root });
        expect(output).toContain(`revision 2 (${pointer?.revisionId}) is live`);
        expect(output).toContain('Activation 2 is pending. The next photos publish settles it.');
        // The next publish settles it, and status says so.
        expect((await run(catalog)).outcome).toBe('NO_CHANGES');
        expect((await runStatusCommand({ dataRoot: catalog.root })).output).toContain(`Catalog: catalog mode, revision 2 (${pointer?.revisionId}) active since `);
        expect((await listActivations(catalog.root)).map((activation) => activation.status)).toEqual(['committed', 'committed']);
    });
});

describe('photos status with a pointer its activation disagrees with', () => {
    it('reports the revision the pointer names, which the site serves, with a note', async () => {
        const catalog = await fixture();
        expect((await run(catalog)).outcome).toBe('PUBLISHED');
        await editCaption(catalog, 'Fixture caption, edited.');
        const second = await run(catalog);
        expect(second.outcome).toBe('PUBLISHED');
        // A torn restore: the pointer names revision 1 but still names activation 2.
        const pointer = await readActivePointer(catalog.root);
        // A hand-made pointer version, as a torn restore or a copy by hand leaves it: no stamp, so it reads as made by hand.
        const newest = Math.max(...fs.readdirSync(catalogPaths(catalog.root).active).flatMap((name) => /^v(\d+)\.json$/.exec(name)?.[1] ?? []).map(Number));
        fs.writeFileSync(versionFile(catalogPaths(catalog.root).active, newest + 1), `${JSON.stringify({ ...pointer, version: newest + 1, revisionId: catalog.revisionId }, null, 2)}\n`);
        const status = await ownerStatus({ dataRoot: catalog.root });
        expect(status.catalog.active).toMatchObject({ revisionId: catalog.revisionId, activationId: pointer?.activationId, status: 'mismatch' });
        const { output } = await runStatusCommand({ dataRoot: catalog.root });
        expect(output).toContain(`Catalog: catalog mode, ${catalog.revisionId} is live, but the pointer names activation 2, which activated ${second.revisionId}`);
        expect(output).toContain("  The pointer and its activation record disagree. The next photos publish repairs them, unless that revision's rules block it.");
    });
});

describe('photos list', () => {
    it('lists each photo with its source, date, series, description state, and set, relative to the data root', async () => {
        const catalog = await fixture();
        const rows = await listPhotos({ dataRoot: catalog.root });
        expect(rows).toHaveLength(4);
        expect(rows.map((row) => row.source)).toEqual([...rows.map((row) => row.source)].sort());
        const member = rows.find((row) => row.photoId === catalog.series[0].photoIds[0]);
        expect(member).toMatchObject({ sourceHealth: 'present', series: [catalog.series[0].id], alt: 'described' });
        expect(member?.w400).toMatch(new RegExp(`^assets/${member?.photoId}/[^/]+/${catalog.profileId}/w400\\.webp$`));
        expect(fs.existsSync(path.join(catalog.root, member?.w400 ?? 'none'))).toBe(true);
        const result = await runListCommand({ dataRoot: catalog.root });
        expect(result.exitCode).toBe(0);
        const lines = withoutRoot(result.output, catalog.root).trimEnd().split('\n');
        expect(lines[0]).toBe('photoId  source  captured  series  alt  w400');
        expect(lines).toHaveLength(5);
    });

    it('keeps only the photos no series lists with --unassigned, and prints JSON', async () => {
        const catalog = await fixture();
        const result = await runListCommand({ dataRoot: catalog.root }, { unassigned: true, json: true });
        expect((JSON.parse(result.output) as { photoId: string }[]).map((row) => row.photoId)).toEqual([catalog.photos[3].id]);
    });

    it('marks a photo with no ready set and one with no record', async () => {
        const catalog = await fixture({ variantBytes: undefined });
        fs.rmSync(authoredRecordDir(catalog.root, 'photo', catalog.photos[3].id), { recursive: true });
        const rows = await listPhotos({ dataRoot: catalog.root });
        expect(rows.every((row) => row.w400 === null)).toBe(true);
        expect(rows.find((row) => row.photoId === catalog.photos[3].id)?.alt).toBe('no record');
        expect((await runListCommand({ dataRoot: catalog.root })).output).toContain('no ready set');
    });

    it('exits 1 when the data root is not ready', async () => {
        const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kg13d-list-')), 'missing');
        cleanups.push(() => fs.promises.rm(path.dirname(missing), { recursive: true, force: true }));
        expect(await runListCommand({ dataRoot: missing })).toEqual({ exitCode: 1, output: 'Error: The data root is unavailable: it does not exist.\n' });
    });
});

describe('photos draft:init', () => {
    /** A catalog with a registry of eight photos and authored records for none of them, and no site.json. */
    async function bare(): Promise<{ catalog: TestCatalog; ids: string[] }> {
        const catalog = await fixture({ photos: 8, series: [{ photos: 0, visibility: 'draft' }] });
        const paths = authoredPaths(catalog.root);
        fs.rmSync(paths.photosDir, { recursive: true });
        fs.mkdirSync(paths.photosDir);
        fs.rmSync(authoredRecordDir(catalog.root, 'site', 'site'), { recursive: true });
        const ids = catalog.photos.map((photo) => photo.id).sort();
        return { catalog, ids };
    }

    it('creates site.json and a record for each photo, pinning its bound revision with no description', async () => {
        const { catalog, ids } = await bare();
        const result = await runDraftInit({ dataRoot: catalog.root });
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain('Created site.json. Created 8 photo records, and 0 photos already had one.');
        const layer = await readWorkingLayer(catalog.root);
        expect(layer.site).toMatchObject({ featuredSeriesIds: [], seriesOrder: [], version: 1 });
        expect(layer.photos.map((photo) => photo.id).sort()).toEqual(ids);
        const registry = await readRegistry(catalog.root);
        for (const photo of layer.photos) expect(photo).toMatchObject({ assetRevision: registry.photos[photo.id].source.observedRevision, alt: null, version: 1 });
    });

    it('never overwrites a record, leaves an unreadable one alone, and skips what it can\'t describe', async () => {
        const { catalog, ids } = await bare();
        const registry = await readRegistry(catalog.root);
        const [kept, broken, merged, archived, ambiguous, given] = ids;
        await writeAuthoredRecord({ kind: 'photo', id: kept, assetRevision: registry.photos[kept].source.observedRevision, alt: { kind: 'decorative' } }, { expectedVersion: 0, root: catalog.root });
        const keptBytes = fs.readFileSync(newestRecordFile(catalog.root, 'photo', kept));
        fs.mkdirSync(authoredRecordDir(catalog.root, 'photo', broken));
        fs.writeFileSync(versionFile(authoredRecordDir(catalog.root, 'photo', broken), 1), '{ not json');
        registry.photos[merged].mergedInto = kept;
        registry.photos[archived].sourceHealth = 'archived';
        registry.photos[ambiguous].sourceHealth = 'ambiguous';
        registry.photos[given].revisions[registry.photos[given].source.observedRevision].reassignedTo = kept;
        await writeRegistry(catalog.root, registry, registry.version);
        const result = await initDrafts({ dataRoot: catalog.root });
        expect(result).toMatchObject({ siteCreated: true, created: ids.slice(6), existing: 1 });
        expect(result.skipped).toEqual([
            { photoId: broken, reason: 'its record file exists but can\'t be read' },
            { photoId: merged, reason: `merged into ${kept}` },
            { photoId: archived, reason: 'archived' },
            { photoId: ambiguous, reason: 'its source is ambiguous until an identity decision settles it' },
            { photoId: given, reason: 'its bound asset revision belongs to another photo' },
        ]);
        expect(fs.readFileSync(newestRecordFile(catalog.root, 'photo', kept))).toEqual(keptBytes);
        expect(fs.readFileSync(versionFile(authoredRecordDir(catalog.root, 'photo', broken), 1), 'utf8')).toBe('{ not json');
        const again = await initDrafts({ dataRoot: catalog.root });
        expect(again).toMatchObject({ siteCreated: false, created: [], existing: 3 });
    });

    it('exits 1 when the data root is not ready, and 3 while the authored lock is held', async () => {
        const { catalog } = await bare();
        const missing = path.join(catalog.root, 'missing');
        expect((await runDraftInit({ dataRoot: missing })).exitCode).toBe(1);
        const locked = await withLock(AUTHORED_LOCK, { root: catalog.root }, () => runDraftInit({ dataRoot: catalog.root, waitMs: 100 }));
        expect(locked.exitCode).toBe(3);
        expect(fs.existsSync(authoredRecordDir(catalog.root, 'site', 'site'))).toBe(false);
    });

    it('says a failed write left the records before it, and a rerun finishes', async () => {
        const { catalog, ids } = await bare();
        let writes = 0;
        const hooks = { afterStage() { if (++writes === 3) throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' }); } };
        const result = await runDraftInit({ dataRoot: catalog.root }, { hooks });
        expect(result.exitCode).toBe(4);
        expect(result.output).toBe('Error: EIO: i/o error, write Records written before it stay, and running draft:init again finishes the rest.\n');
        expect((await readWorkingLayer(catalog.root)).photos).toHaveLength(1);
        const rerun = await runDraftInit({ dataRoot: catalog.root });
        expect(rerun.output).toContain('Created 7 photo records, and 1 photo already had one.');
        expect((await readWorkingLayer(catalog.root)).photos.map((photo) => photo.id).sort()).toEqual(ids);
    });

    it('exits 3 when it loses the authored lock part way', async () => {
        const { catalog } = await bare();
        const hooks = { afterStage() { throw new LockLostError(AUTHORED_LOCK, null); } };
        const result = await runDraftInit({ dataRoot: catalog.root }, { hooks });
        expect(result.exitCode).toBe(3);
        expect(result.output).toContain('LOCK_LOST');
    });
});
