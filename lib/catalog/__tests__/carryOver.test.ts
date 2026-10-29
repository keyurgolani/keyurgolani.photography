// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { processImage } from '../../../utils/imageOptimizer';
import { placedItems } from '../../curation/placement';
import { listEvents } from '../../curation/repository';
import { createCurationSink } from '../../curation/sink';
import { readRegistry } from '../../identity/registry';
import { runIdentityOnce } from '../../identity/watcherStep';
import { CARRY_OVER_REASON, CARRY_OVER_SERIES, OWNER_DIRECTION, planCarryOver, runCarryOver } from '../carry-over';
import { legacyList } from '../photos-api';
import { publish } from '../publish';
import { createCatalogReader } from '../reader';
import { readRevisionFile } from '../repository';
import { readActivePointer, readAuthoredRecord, readWorkingLayer } from '../working-layer';
import { writeAuthoredRecord } from '../working-layer-writer';
import { publishedHomeOf } from '../projections/home';
import { seriesPageOf } from '../projections/series';
import { viewerPhotoOf } from '../projections/viewer';
import { photoEntryName } from '../../a11y/photoName';
import { altOf } from '../../../components/series/seriesLabels';
import { createRouteBuilder } from '../routes';

// `photos carry-over` on a real library and data root: the watcher's legacy
// derivatives and its catalog sets, the registry, and the inbox items its
// curation sink opens. Test files only.

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined, info: () => undefined };
const ACTOR = 'keyur';

let images: Record<string, Buffer>;

async function jpeg(day: string | null, color: { r: number; g: number; b: number }): Promise<Buffer> {
    const image = sharp({ create: { width: 60, height: 40, channels: 3, background: color } });
    return (day ? image.withExif({ IFD2: { DateTimeOriginal: `${day.replace(/-/g, ':')} 12:00:00` } }) : image).jpeg().toBuffer();
}

beforeAll(async () => {
    // Newest capture first, undated last: the Gallery's order is newer.jpg, older.jpg, undated.jpg.
    images = {
        'older.jpg': await jpeg('2023-03-04', { r: 200, g: 40, b: 40 }),
        'newer.jpg': await jpeg('2024-06-01', { r: 40, g: 200, b: 40 }),
        'undated.jpg': await jpeg(null, { r: 40, g: 40, b: 200 }),
    };
}, 60_000);

interface World {
    lib: TempLibrary;
    data: TempDataRoot;
    root: string;
    ids: Record<string, string>;
    tree(): Record<string, string>;
}

const worlds: World[] = [];

afterEach(async () => {
    for (const world of worlds.splice(0)) {
        await world.data.cleanup();
        await world.lib.cleanup();
    }
});

/** Every file under `dir`, as bytes in hex, so a dry run can be shown to write nothing. */
function treeOf(dir: string): Record<string, string> {
    if (!fs.existsSync(dir)) return {};
    const out: Record<string, string> = {};
    for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const file = path.join(entry.parentPath, entry.name);
        out[path.relative(dir, file)] = fs.readFileSync(file).toString('hex');
    }
    return out;
}

/** The library as the legacy site and the watcher leave it: legacy derivatives, IDs, catalog sets, and inbox items. */
async function world({ unreadable = false, photos = images }: { unreadable?: boolean; photos?: Record<string, Buffer> } = {}): Promise<World> {
    const lib = await createTempLibrary();
    const data = createTempDataRoot();
    for (const [name, bytes] of Object.entries(photos)) fs.writeFileSync(lib.file(name), bytes);
    if (unreadable) fs.writeFileSync(lib.file('broken.jpg'), 'not a photograph');
    for (const name of Object.keys(photos)) await processImage(name);
    expect(await runIdentityOnce({ sinks: [createCurationSink({ logger: quiet })], logger: quiet, pass: { clock: () => Date.now() + 60_000 } })).toBe(0);
    const registry = await readRegistry(data.root);
    const ids = Object.fromEntries(Object.values(registry.photos).map((photo) => [photo.source.path, photo.photoId]));
    const made: World = { lib, data, root: data.root, ids, tree: () => ({ authored: JSON.stringify(treeOf(path.join(data.root, 'authored'))), curation: JSON.stringify(treeOf(path.join(data.root, 'curation'))), catalog: JSON.stringify(treeOf(path.join(data.root, 'catalog'))) }) };
    worlds.push(made);
    return made;
}

/** What the screens read from a revision: the reader, with the revision's ID, as the public reader builds it. */
const readerOf = (revision: { revisionId: string; content: Parameters<typeof createCatalogReader>[0] }) => ({ ...createCatalogReader(revision.content, { revisionId: revision.revisionId, revisionNumber: null }), revisionId: revision.revisionId });

describe('photos carry-over', { timeout: 120_000 }, () => {
    it("plans the legacy Gallery's photos in its own order, names each by its place, and writes nothing on a dry run", async () => {
        const w = await world();
        const before = w.tree();
        const gallery = await legacyList(await readRegistry(w.root), w.lib.root);
        const plan = await planCarryOver(w.root);
        expect(plan.state).toBe('ready');
        // The order legacy /api/photos serves, which the Gallery shows.
        expect(plan.photos.map((photo) => photo.sourcePath)).toEqual(['newer.jpg', 'older.jpg', 'undated.jpg']);
        expect(plan.photos.map((photo) => photo.photoId)).toEqual(gallery.map((item) => w.ids[decodeURIComponent(item.optimized.replace('/assets/photos/optimized/', '').replace(/\.webp$/, '.jpg'))]));
        expect(plan.photos.map((photo) => photo.name)).toEqual(['Photograph 1 of 3', 'Photograph 2 of 3', 'Photograph 3 of 3']);
        expect(plan.photos.every((photo) => photo.description === null && photo.record === 'create')).toBe(true);
        expect(plan.closes).toHaveLength(3);
        expect(plan.closes.every((item) => item.how === 'placement')).toBe(true);
        expect(plan.uncarried).toEqual([]);
        expect(plan.predicted).toMatchObject({ gone: 0, published: 3, errors: [] });

        const run = await runCarryOver({ dataRoot: w.root });
        expect(run.exitCode).toBe(0);
        expect(run.output).toContain('Dry run: nothing was written.');
        expect(run.output).toContain(`Series: ${CARRY_OVER_SERIES.id}, "Gallery", published, with 3 photos`);
        expect(run.output).toContain('keep the names the Gallery gives them today, "Photograph N of 3", and get no description');
        expect(run.output).toContain(OWNER_DIRECTION);
        expect(run.output).toContain('You can describe any of them any time');
        expect(run.output).toMatch(/1\. newer\.jpg \(ph_[^)]+\): "Photograph 1 of 3", no description yet/);
        expect(run.output).toContain('GONE_COUNT 0');
        expect(w.tree()).toEqual(before);
    });

    it('applies it: the series, the site, the marked records with their stamps, and the inbox settled, then publishes with no photo gone', async () => {
        const w = await world();
        const applied = await runCarryOver({ dataRoot: w.root }, { apply: true, actor: ACTOR });
        expect(applied.output).toContain('Carried over: wrote 5 records.');
        expect(applied.exitCode).toBe(0);
        const layer = await readWorkingLayer(w.root);
        const order = [w.ids['newer.jpg'], w.ids['older.jpg'], w.ids['undated.jpg']];
        expect(layer.site).toMatchObject({ featuredSeriesIds: [CARRY_OVER_SERIES.id], seriesOrder: [CARRY_OVER_SERIES.id] });
        expect(layer.series).toHaveLength(1);
        expect(layer.series[0]).toMatchObject({ id: CARRY_OVER_SERIES.id, slug: 'gallery', title: 'Gallery', statement: '', shortStatement: '', visibility: 'published', photoIds: order, cover: { photoId: order[0] }, carryOver: { reason: CARRY_OVER_REASON } });
        for (const photo of layer.photos) {
            expect(photo).toMatchObject({ alt: null, carryOver: { reason: CARRY_OVER_REASON } });
            // #16's stamp: reviewed by the owner, before the first activation.
            expect(photo.review?.fields.alt).toMatchObject({ origin: 'curator', actor: ACTOR, baseRevisionId: null });
        }
        // The new photographs' items are settled by the series, with nothing written to them.
        const { events } = await listEvents(w.root);
        const placed = await placedItems(w.root, events);
        expect(events.filter((event) => event.type === 'new').every((event) => placed.placed.has(event.id) && event.status === 'open')).toBe(true);

        const dry = await publish({ dataRoot: w.root, actor: ACTOR, dryRun: true, logger: { log: () => undefined } });
        expect(dry.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
        expect(dry.launch).toEqual({ published: 3, gone: 0 });
        const live = await publish({ dataRoot: w.root, actor: ACTOR, confirmLaunch: true, logger: { log: () => undefined } });
        expect(live.outcome).toBe('PUBLISHED');

        // The served revision names each carried photo by its place, once, on Home and in the Viewer.
        const pointer = await readActivePointer(w.root);
        const revision = (await readRevisionFile(w.root, pointer!.revisionId))!;
        expect(revision.content.photos.every((photo) => photo.alt.kind === 'position')).toBe(true);
        expect(revision.content.series[0]).toMatchObject({ carryOver: true, statement: '', shortStatement: '' });
        const reader = readerOf(revision);
        const viewer = viewerPhotoOf(reader, 'gallery', order[1]);
        if (viewer.kind !== 'ok') throw new Error(viewer.kind);
        expect(viewer.viewer.photo).toMatchObject({ alt: 'Photograph 2 of 3', description: null, descriptionPending: false });
        const home = publishedHomeOf(reader, createRouteBuilder({}));
        expect(home.featuredSeries?.records.map((record) => record.alt)).toEqual(expect.arrayContaining(['Photograph 1 of 3']));
        for (const record of home.featuredSeries?.records ?? []) expect(record.alt).toMatch(/^Photograph [1-3] of 3$/);

        // The series page carries no text for them, so each entry's name is its place alone, never doubled.
        const page = seriesPageOf(reader, 'gallery', createRouteBuilder({}));
        if (page.kind !== 'ok') throw new Error(page.kind);
        expect(page.page.entries.map((entry) => photoEntryName({ alt: altOf(entry.description), position: entry.position, total: page.page.entries.length }))).toEqual(['Photograph 1 of 3', 'Photograph 2 of 3', 'Photograph 3 of 3']);

        // A second run changes nothing, and says so.
        const versions = (await readWorkingLayer(w.root)).photos.map((photo) => photo.version);
        const again = await runCarryOver({ dataRoot: w.root }, { apply: true, actor: ACTOR });
        expect(again.exitCode).toBe(0);
        expect(again.output).toContain('The carry-over is already done: nothing changed.');
        expect((await readWorkingLayer(w.root)).photos.map((photo) => photo.version)).toEqual(versions);
        expect((await runCarryOver({ dataRoot: w.root })).output).toContain('already done');
    });

    it('keeps the order and the names past single digits, at the size of a real Gallery, in one run', { timeout: 300_000 }, async () => {
        const TOTAL = 115;
        // 115 photographs, as many as the live Gallery has: dated across three years, two sharing a day, and six undated, which the Gallery puts last.
        const many: Record<string, Buffer> = {};
        for (let n = 0; n < TOTAL; n++) {
            const day = n >= TOTAL - 6 ? null : n === 7 ? '2024-01-08' : `20${22 + (n % 3)}-${String(1 + (n % 12)).padStart(2, '0')}-${String(1 + (n % 28)).padStart(2, '0')}`;
            many[`photo-${String(n).padStart(3, '0')}.jpg`] = await jpeg(day, { r: (7 * n) % 256, g: 120, b: (250 - 3 * n + 256) % 256 });
        }
        const w = await world({ photos: many });
        const gallery = await legacyList(await readRegistry(w.root), w.lib.root);
        expect(gallery).toHaveLength(TOTAL);
        const galleryIds = gallery.map((item) => w.ids[decodeURIComponent(item.optimized.replace('/assets/photos/optimized/', '').replace(/\.webp$/, '.jpg'))]);
        const plan = await planCarryOver(w.root);
        expect(plan.photos.map((photo) => photo.photoId)).toEqual(galleryIds);
        expect(plan.photos.map((photo) => photo.name)).toEqual(galleryIds.map((_, index) => `Photograph ${index + 1} of ${TOTAL}`));
        expect(plan.predicted).toMatchObject({ gone: 0, published: TOTAL, errors: [] });
        const dry = await runCarryOver({ dataRoot: w.root });
        expect(dry.output).toContain(`"Photograph N of ${TOTAL}"`);
        for (const index of [0, 9, 99, TOTAL - 1]) {
            expect(dry.output).toMatch(new RegExp(`\\n {1,2}${String(index + 1).padStart(3)}\\. [^\\n]+ \\(${galleryIds[index]}\\): "Photograph ${index + 1} of ${TOTAL}", no description yet`));
        }

        const applied = await runCarryOver({ dataRoot: w.root }, { apply: true, actor: ACTOR });
        expect(applied.output).toContain(`Carried over: wrote ${TOTAL + 2} records.`);
        expect((await readWorkingLayer(w.root)).series[0].photoIds).toEqual(galleryIds);
        expect((await publish({ dataRoot: w.root, actor: ACTOR, confirmLaunch: true, logger: { log: () => undefined } })).outcome).toBe('PUBLISHED');
        const revision = (await readRevisionFile(w.root, (await readActivePointer(w.root))!.revisionId))!;
        const reader = readerOf(revision);
        for (const index of [0, 8, 9, 10, 98, 99, 100, TOTAL - 1]) {
            const viewer = viewerPhotoOf(reader, 'gallery', galleryIds[index]);
            if (viewer.kind !== 'ok') throw new Error(viewer.kind);
            expect(viewer.viewer.photo.alt).toBe(`Photograph ${index + 1} of ${TOTAL}`);
            expect(viewer.viewer).toMatchObject({ position: index + 1, total: TOTAL });
        }
        const page = seriesPageOf(reader, 'gallery', createRouteBuilder({}));
        if (page.kind !== 'ok') throw new Error(page.kind);
        expect(page.page.total).toBe(TOTAL);
    });

    it('lets a description written later replace the name, under the normal rules', async () => {
        const w = await world();
        expect((await runCarryOver({ dataRoot: w.root }, { apply: true, actor: ACTOR })).exitCode).toBe(0);
        const id = w.ids['older.jpg'];
        const record = (await readAuthoredRecord(w.root, 'photo', id))!;
        await writeAuthoredRecord({ ...record, alt: { kind: 'described', text: 'A red field under a flat sky.', reviewed: true } }, { expectedVersion: record.version, root: w.root });
        const live = await publish({ dataRoot: w.root, actor: ACTOR, confirmLaunch: true, logger: { log: () => undefined } });
        expect(live.outcome).toBe('PUBLISHED');
        const revision = (await readRevisionFile(w.root, (await readActivePointer(w.root))!.revisionId))!;
        expect(revision.content.photos.find((photo) => photo.id === id)?.alt).toEqual({ kind: 'described', text: 'A red field under a flat sky.' });
        const viewer = viewerPhotoOf(readerOf(revision), 'gallery', id);
        if (viewer.kind !== 'ok') throw new Error(viewer.kind);
        expect(viewer.viewer.photo).toMatchObject({ alt: 'A red field under a flat sky.', description: 'A red field under a flat sky.' });
    });

    it("refuses a working layer with the owner's own series, Work order, or featured series, and says what's there", async () => {
        const w = await world();
        await writeAuthoredRecord({ kind: 'series', id: 'ser_mine', slug: 'mine', title: 'Mine', visibility: 'draft' }, { expectedVersion: 0, root: w.root });
        await writeAuthoredRecord({ kind: 'site', featuredSeriesIds: ['ser_mine'], seriesOrder: ['ser_mine'] }, { expectedVersion: 0, root: w.root });
        const before = w.tree();
        for (const apply of [false, true]) {
            const run = await runCarryOver({ dataRoot: w.root }, { apply, actor: ACTOR });
            expect(run.exitCode).toBe(1);
            expect(run.output).toContain('Refused, and nothing was written:');
            expect(run.output).toContain('1 series of yours: ser_mine ("Mine")');
            expect(run.output).toContain("Work's order is already set: ser_mine.");
            expect(run.output).toContain('The featured series is already set: ser_mine.');
        }
        expect(w.tree()).toEqual(before);
    });

    it('names a photo it cannot carry, exits 1 until --allow-missing names it, and never drops it silently', async () => {
        const w = await world({ unreadable: true });
        // older.jpg's legacy thumbnail is gone, so the Gallery doesn't list it today.
        const thumbnail = fs.readdirSync(w.lib.file('thumbnails')).find((name) => name.startsWith('older'))!;
        fs.renameSync(w.lib.file('thumbnails', thumbnail), w.lib.file(`moved-${thumbnail}`));
        const dry = await runCarryOver({ dataRoot: w.root });
        expect(dry.exitCode).toBe(1);
        expect(dry.output).toContain(`older.jpg (${w.ids['older.jpg']}): its seven legacy derivatives aren't all built, so the Gallery doesn't show it, so it isn't on the site today.`);
        expect(dry.output).toContain('--apply refuses until then.');
        const refused = await runCarryOver({ dataRoot: w.root }, { apply: true, actor: ACTOR });
        expect(refused.exitCode).toBe(1);
        expect((await readWorkingLayer(w.root)).series).toEqual([]);
        const accepted = await runCarryOver({ dataRoot: w.root }, { apply: true, actor: ACTOR, allow: ['older.jpg'] });
        expect(accepted.exitCode).toBe(0);
        expect(accepted.output).toContain('Accepted with --allow-missing.');
        const layer = await readWorkingLayer(w.root);
        expect(layer.series[0].photoIds).toEqual([w.ids['newer.jpg'], w.ids['undated.jpg']]);
    });
});
