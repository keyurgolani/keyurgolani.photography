// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { processImage } from '../../../utils/imageOptimizer';
import { placedItems } from '../../curation/placement';
import { listEvents } from '../../curation/repository';
import { createCurationSink } from '../../curation/sink';
import { readRegistry, writeRegistry } from '../../identity/registry';
import { eventIdOf, eventKey } from '../../curation/events';
import { readEvent, withCurationLock, writeEvent } from '../../curation/repository';
import { withLock } from '../../storage/lock';
import { runTsx } from '../../../test/helpers/runTsx';
import { runEditRecord } from '../edit-record';
import { AUTHORED_LEASE_MS, AUTHORED_LOCK } from '../working-layer-writer';
import { runIdentityOnce } from '../../identity/watcherStep';
import { CARRY_OVER_REASON, CARRY_OVER_SERIES, OWNER_DIRECTION, planCarryOver, runCarryOver } from '../carry-over';
import { legacyList } from '../photos-api';
import { checkLayer, publish } from '../publish';
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

// dismissEvent(), wrapped, so a test can make one dismissal fail and the next run retry it.
const dismissal = vi.hoisted(() => ({ fail: false }));
vi.mock('../../curation/actions', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../curation/actions')>();
    return {
        ...actual,
        dismissEvent: async (input: Parameters<typeof actual.dismissEvent>[0]) => (dismissal.fail ? { ok: false as const, code: 'stale' as const, message: 'The event changed meanwhile. Nothing was written.' } : actual.dismissEvent(input)),
    };
});

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
        // 115 photographs, as many as the live Gallery has: dated across three years, where photo n shares its day with n + 84,
        // so those ties fall back to the photo-ID order, and six undated, which the Gallery puts last, by photo ID too.
        const many: Record<string, Buffer> = {};
        for (let n = 0; n < TOTAL; n++) {
            const day = n >= TOTAL - 6 ? null : `20${22 + (n % 3)}-${String(1 + (n % 12)).padStart(2, '0')}-${String(1 + (n % 28)).padStart(2, '0')}`;
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

    it('lists photos that are not on the site today as left alone, and never counts them as gone', async () => {
        const w = await world({ unreadable: true });
        const dry = await runCarryOver({ dataRoot: w.root });
        expect(dry.exitCode).toBe(0);
        expect(dry.output).toContain('In the library but not on the site today, left as they are (1):');
        expect(dry.output).toMatch(/broken\.jpg \(ph_[^)]+\): the watcher can't read it\./);
        expect(dry.output).toContain('GONE_COUNT 0');
        expect((await planCarryOver(w.root)).photos.map((photo) => photo.sourcePath)).toEqual(['newer.jpg', 'older.jpg', 'undated.jpg']);
    });

    it("counts a photo the Gallery can't show for want of its legacy files as on the site, so it needs --allow-missing", async () => {
        const w = await world();
        // older.jpg's legacy thumbnail is gone, so the Gallery can't list it today. The registry still puts it on the site.
        const thumbnail = fs.readdirSync(w.lib.file('thumbnails')).find((name) => name.startsWith('older'))!;
        fs.renameSync(w.lib.file('thumbnails', thumbnail), w.lib.file(`moved-${thumbnail}`));
        const dry = await runCarryOver({ dataRoot: w.root });
        expect(dry.exitCode).toBe(1);
        expect(dry.output).toContain("Photos on the site today that can't carry over (1):");
        expect(dry.output).toContain(`older.jpg (${w.ids['older.jpg']}): its seven legacy derivatives aren't all built, so the Gallery doesn't show it today, though the site still counts it as on it.`);
        expect(dry.output).toContain("1 photo on the site today can't carry over, and --allow-missing doesn't name it.");
        expect(dry.output).toContain('GONE_COUNT 1');
        const accepted = await runCarryOver({ dataRoot: w.root }, { apply: true, actor: ACTOR, allow: ['older.jpg'] });
        expect(accepted.exitCode).toBe(0);
        expect(accepted.output).toContain('GONE_COUNT 1, all accepted by name');
        expect((await readWorkingLayer(w.root)).series[0].photoIds).toEqual([w.ids['newer.jpg'], w.ids['undated.jpg']]);
        expect((await publish({ dataRoot: w.root, actor: ACTOR, dryRun: true, logger: { log: () => undefined } })).launch).toEqual({ published: 2, gone: 1 });
    });

    it('counts by the registry, so an empty library folder still gives every photo on the site as gone', async () => {
        const w = await world();
        // The image ships an assets folder with no photographs in it, which a publish without the library mount sees.
        const empty = await createTempLibrary();
        try {
            expect((await checkLayer(w.root, await readWorkingLayer(w.root))).launch).toEqual({ published: 0, gone: 3 });
            const plan = await planCarryOver(w.root);
            expect(plan.predicted?.gone).toBe(3);
            expect(plan.uncarried.map((photo) => photo.sourcePath)).toEqual(['newer.jpg', 'older.jpg', 'undated.jpg']);
            const dry = await runCarryOver({ dataRoot: w.root });
            expect(dry.exitCode).toBe(1);
            expect(dry.output).toContain('GONE_COUNT 3');
        } finally {
            await empty.cleanup();
        }
    });

    it("leaves the hidden half of a shared legacy set off the site, as today's Gallery does, and doesn't count it as gone", async () => {
        // newer.jpg and newer.png share the legacy set named newer: the Gallery lists the first by path, newer.jpg, alone.
        const w = await world({ photos: { ...images, 'newer.png': await sharp({ create: { width: 60, height: 40, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer() } });
        const gallery = await legacyList(await readRegistry(w.root), w.lib.root);
        expect(gallery).toHaveLength(3);
        const dry = await runCarryOver({ dataRoot: w.root });
        expect(dry.exitCode).toBe(0);
        expect(dry.output).toContain(`newer.png (${w.ids['newer.png']}): it shares its legacy derivative set with newer.jpg, so the Gallery shows that one instead.`);
        expect(dry.output).toContain('GONE_COUNT 0');
        expect((await planCarryOver(w.root)).photos.map((photo) => photo.sourcePath)).toEqual(['newer.jpg', 'older.jpg', 'undated.jpg']);
    });

    it('names a photo the Gallery shows that it cannot carry, exits 1 until --allow-missing names it, and ties GONE_COUNT to the names', async () => {
        const w = await world();
        // older.jpg is on the Gallery, but its catalog set failed to build, so no revision can publish it.
        const registry = await readRegistry(w.root);
        const photo = registry.photos[w.ids['older.jpg']];
        const revision = photo.revisions[photo.source.observedRevision];
        for (const profile of Object.keys(revision.profiles)) revision.profiles[profile] = { state: 'failed', attempts: 3, error: 'fixture' };
        await writeRegistry(w.root, registry, registry.version);
        const dry = await runCarryOver({ dataRoot: w.root });
        expect(dry.exitCode).toBe(1);
        expect(dry.output).toContain(`older.jpg (${w.ids['older.jpg']}): its catalog derivative set isn't ready yet.`);
        expect(dry.output).toContain('--apply refuses until then.');
        const refused = await runCarryOver({ dataRoot: w.root }, { apply: true, actor: ACTOR });
        expect(refused.exitCode).toBe(1);
        expect((await readWorkingLayer(w.root)).series).toEqual([]);
        // A name that matches nothing is refused, so his list and what's accepted never drift apart.
        const stale = await runCarryOver({ dataRoot: w.root }, { allow: ['older.jpg', 'no-such.jpg'] });
        expect(stale.exitCode).toBe(1);
        expect(stale.output).toContain("--allow-missing names no-such.jpg, which the plan doesn't list as a photo it can't carry.");
        const accepted = await runCarryOver({ dataRoot: w.root }, { apply: true, actor: ACTOR, allow: ['older.jpg'] });
        expect(accepted.exitCode).toBe(0);
        expect(accepted.output).toContain('Accepted by name with --allow-missing, so it leaves the site at the launch: older.jpg.');
        expect(accepted.output).toContain('GONE_COUNT 1, all accepted by name');
        expect((await readWorkingLayer(w.root)).series[0].photoIds).toEqual([w.ids['newer.jpg'], w.ids['undated.jpg']]);
        expect((await publish({ dataRoot: w.root, actor: ACTOR, dryRun: true, logger: { log: () => undefined } })).launch).toEqual({ published: 2, gone: 1 });
    });

    it("refuses once the owner has changed the carried-over Gallery, saying what changed, and writes nothing", async () => {
        const w = await world();
        expect((await runCarryOver({ dataRoot: w.root }, { apply: true, actor: ACTOR })).exitCode).toBe(0);
        const gallery = (await readAuthoredRecord(w.root, 'series', CARRY_OVER_SERIES.id))!;
        await writeAuthoredRecord({ ...gallery, photoIds: [...gallery.photoIds].reverse().slice(0, 2), cover: { photoId: gallery.photoIds[2] } }, { expectedVersion: gallery.version, root: w.root });
        const before = w.tree();
        for (const apply of [false, true]) {
            const run = await runCarryOver({ dataRoot: w.root }, { apply, actor: ACTOR });
            expect(run.exitCode).toBe(1);
            expect(run.output).toContain('ser_gallery has changed since the carry-over made it: 1 photo the legacy Gallery shows is out of it; the photos are in another order; its cover changed.');
        }
        expect(w.tree()).toEqual(before);
    });

    it("says the legacy Gallery changed, not the owner, when a photo arrives after the carry-over, and writes nothing", async () => {
        const w = await world();
        expect((await runCarryOver({ dataRoot: w.root }, { apply: true, actor: ACTOR })).exitCode).toBe(0);
        fs.writeFileSync(w.lib.file('later.jpg'), await jpeg('2025-02-02', { r: 90, g: 90, b: 90 }));
        await processImage('later.jpg');
        expect(await runIdentityOnce({ sinks: [createCurationSink({ logger: quiet })], logger: quiet, pass: { clock: () => Date.now() + 60_000 } })).toBe(0);
        const before = w.tree();
        for (const apply of [false, true]) {
            const run = await runCarryOver({ dataRoot: w.root }, { apply, actor: ACTOR });
            expect(run.exitCode).toBe(1);
            expect(run.output).toContain("The legacy Gallery changed since the carry-over: it shows 1 photo ser_gallery doesn't have. The carry-over doesn't change a Gallery it already made, so place those photos yourself.");
            expect(run.output).not.toContain('has changed since the carry-over made it');
        }
        expect(w.tree()).toEqual(before);
    });

    it("refuses to put back a Work order and featured series the owner cleared after the carry-over", async () => {
        const w = await world();
        // The carry-over ran a minute ago, so the owner's writes are stamped after it.
        expect((await runCarryOver({ dataRoot: w.root }, { apply: true, actor: ACTOR, clock: () => Date.now() - 60_000 })).exitCode).toBe(0);
        const site = (await readAuthoredRecord(w.root, 'site', 'site'))!;
        await writeAuthoredRecord({ ...site, seriesOrder: [], featuredSeriesIds: [] }, { expectedVersion: site.version, root: w.root });
        const before = w.tree();
        for (const apply of [false, true]) {
            const run = await runCarryOver({ dataRoot: w.root }, { apply, actor: ACTOR });
            expect(run.exitCode).toBe(1);
            expect(run.output).toContain("Work's order and the featured series changed since the carry-over. They're yours now, so the carry-over doesn't put them back. Nothing was written.");
        }
        expect(w.tree()).toEqual(before);
        const cleared = (await readAuthoredRecord(w.root, 'site', 'site'))!;
        expect([cleared.seriesOrder, cleared.featuredSeriesIds]).toEqual([[], []]);
    });

    it('never writes after the launch: a photo added later stays his, and the plan says the launch has run', async () => {
        const w = await world();
        expect((await runCarryOver({ dataRoot: w.root }, { apply: true, actor: ACTOR })).exitCode).toBe(0);
        expect((await publish({ dataRoot: w.root, actor: ACTOR, confirmLaunch: true, logger: { log: () => undefined } })).outcome).toBe('PUBLISHED');
        expect((await runCarryOver({ dataRoot: w.root })).output).toContain('already done');
        fs.writeFileSync(w.lib.file('later.jpg'), await jpeg('2025-02-02', { r: 90, g: 90, b: 90 }));
        await processImage('later.jpg');
        expect(await runIdentityOnce({ sinks: [createCurationSink({ logger: quiet })], logger: quiet, pass: { clock: () => Date.now() + 60_000 } })).toBe(0);
        const before = w.tree();
        for (const apply of [false, true]) {
            const run = await runCarryOver({ dataRoot: w.root }, { apply, actor: ACTOR });
            expect(run.exitCode).toBe(1);
            expect(run.output).toMatch(/Revision rev_[0-9a-f]{64} is live, so the launch has run\. The carry-over only runs before it, and Gallery is yours now\./);
        }
        expect(w.tree()).toEqual(before);
    });

    it('dismisses a new item whose photo moved to other bytes, with the reason, retries a dismissal that failed, and lists the items it leaves open', async () => {
        const w = await world();
        const { events } = await listEvents(w.root);
        const moved = events.find((event) => event.type === 'new' && event.photoId === w.ids['older.jpg'])!;
        const other = `sha256-${'7'.repeat(64)}`;
        const replacementKey = `replaced:${w.ids['newer.jpg']}:${other}`;
        await withCurationLock(w.root, {}, async (hold) => {
            // As the sink folds new bytes into an open new item: its key keeps the revision it opened at.
            await writeEvent(w.root, { ...moved, assetRevision: `sha256-${'6'.repeat(64)}` }, moved.version, hold);
            const template = events.find((event) => event.type === 'new' && event.photoId === w.ids['newer.jpg'])!;
            await writeEvent(w.root, { ...template, id: eventIdOf(eventKey('replacement', { photoId: w.ids['newer.jpg'], assetRevision: other, key: replacementKey })), key: replacementKey, type: 'replacement', assetRevision: other, decisions: [] }, 0, hold);
        });
        const plan = await planCarryOver(w.root);
        expect(plan.closes.find((item) => item.eventId === moved.id)).toMatchObject({ how: 'dismiss' });
        expect(plan.stays).toEqual([expect.objectContaining({ sourcePath: 'newer.jpg', reason: "Its replacement item stays open: the carry-over doesn't decide it" })]);
        dismissal.fail = true;
        const first = await runCarryOver({ dataRoot: w.root }, { apply: true, actor: ACTOR });
        expect(first.exitCode).toBe(1);
        expect(first.output).toContain('These inbox items could not be dismissed, and stay open. The records are written.');
        expect((await readWorkingLayer(w.root)).series).toHaveLength(1);
        dismissal.fail = false;
        const second = await runCarryOver({ dataRoot: w.root }, { apply: true, actor: ACTOR });
        expect(second.exitCode).toBe(0);
        expect(second.output).toContain('Carried over: wrote 0 records, and dismissed 1 inbox item.');
        expect(await readEvent(w.root, moved.id)).toMatchObject({ status: 'dismissed', decisions: expect.arrayContaining([expect.objectContaining({ action: 'dismiss', reason: CARRY_OVER_REASON })]) });
        const third = await runCarryOver({ dataRoot: w.root }, { apply: true, actor: ACTOR });
        expect(third.output).toContain('The carry-over is already done: nothing changed.');
    });

    it('answers 3 while the authored lock stays busy, and writes nothing', async () => {
        const w = await world();
        const before = w.tree();
        let run: Awaited<ReturnType<typeof runCarryOver>> | undefined;
        await withLock(AUTHORED_LOCK, { root: w.root, leaseMs: AUTHORED_LEASE_MS, waitMs: 1_000 }, async () => {
            run = await runCarryOver({ dataRoot: w.root, waitMs: 200 }, { apply: true, actor: ACTOR });
        });
        expect(run).toMatchObject({ exitCode: 3, output: expect.stringMatching(/^Error \(locked\): .* Nothing was written\.\n$/) });
        expect(w.tree()).toEqual(before);
    });

    it('takes --apply or --dry-run, not both, and needs an actor to apply', async () => {
        const w = await world();
        const cli = (args: string[]) => runTsx('scripts/photos.ts', ['carry-over', ...args], { env: { PHOTOGRAPHY_DATA_DIR: w.root, PHOTOGRAPHY_LIBRARY_DIR: w.lib.root, PHOTOS_ACTOR: undefined } });
        const both = await cli(['--apply', '--dry-run', '--actor', ACTOR]);
        expect(both.code).toBe(2);
        expect(both.stderr).toContain('photos carry-over takes --apply or --dry-run, not both.');
        const nobody = await cli(['--apply']);
        expect(nobody.code).toBe(2);
        expect(nobody.stderr).toContain('photos carry-over --apply needs --actor <name> or PHOTOS_ACTOR.');
        const empty = await cli(['--allow-missing', ' , ']);
        expect(empty.code).toBe(2);
        expect((await readWorkingLayer(w.root)).series).toEqual([]);
    });
});

describe("the carry-over marker", { timeout: 120_000 }, () => {
    it('is written only by the carry-over: photos edit and every other write refuse one added by hand', async () => {
        const w = await world();
        expect((await runCarryOver({ dataRoot: w.root }, { apply: true, actor: ACTOR })).exitCode).toBe(0);
        const marker = (await readAuthoredRecord(w.root, 'photo', w.ids['newer.jpg']))!.carryOver;
        await writeAuthoredRecord({ kind: 'series', id: 'ser_mine', slug: 'mine', title: 'Mine', visibility: 'draft' }, { expectedVersion: 0, root: w.root });
        await expect(writeAuthoredRecord({ kind: 'series', id: 'ser_mine', slug: 'mine', title: 'Mine', visibility: 'draft', carryOver: marker }, { expectedVersion: 1, root: w.root })).rejects.toMatchObject({ code: 'INVALID_RECORD', message: expect.stringContaining('Only photos carry-over writes the carry-over marker') });
        const file = path.join(w.data.root, '..', 'edit.json');
        fs.writeFileSync(file, JSON.stringify({ kind: 'series', id: 'ser_mine', slug: 'mine', title: 'Mine', visibility: 'draft', carryOver: marker }));
        const edited = await runEditRecord({ dataRoot: w.root }, { kind: 'series', id: 'ser_mine' }, { file, expectVersion: 1 });
        expect(edited.exitCode).toBe(1);
        expect(edited.output).toContain('Only photos carry-over writes the carry-over marker');
        expect((await readAuthoredRecord(w.root, 'series', 'ser_mine'))!.carryOver).toBeUndefined();
        // Any other write of a marked record keeps the marker, even one that leaves it out.
        const record = (await readAuthoredRecord(w.root, 'photo', w.ids['newer.jpg']))!;
        const rest: Partial<typeof record> = { ...record };
        delete rest.carryOver;
        await writeAuthoredRecord({ ...(rest as typeof record), title: 'Harbor' }, { expectedVersion: record.version, root: w.root });
        expect((await readAuthoredRecord(w.root, 'photo', w.ids['newer.jpg']))!.carryOver).toEqual(marker);
    });

    it('goes once a description is written, so clearing it later blocks the publish like any photo', async () => {
        const w = await world();
        expect((await runCarryOver({ dataRoot: w.root }, { apply: true, actor: ACTOR })).exitCode).toBe(0);
        const id = w.ids['older.jpg'];
        let record = (await readAuthoredRecord(w.root, 'photo', id))!;
        await writeAuthoredRecord({ ...record, alt: { kind: 'described', text: 'A red field under a flat sky.', reviewed: true } }, { expectedVersion: record.version, root: w.root });
        record = (await readAuthoredRecord(w.root, 'photo', id))!;
        expect(record.carryOver).toBeUndefined();
        await writeAuthoredRecord({ ...record, alt: null }, { expectedVersion: record.version, root: w.root });
        const dry = await publish({ dataRoot: w.root, actor: ACTOR, dryRun: true, logger: { log: () => undefined } });
        expect(dry.issues).toContainEqual(expect.objectContaining({ code: 'description.required', record: { kind: 'photo', id } }));
    });

    it('names a photo by its place only while Gallery alone publishes it, and drops the series marker once a statement is written', async () => {
        const w = await world();
        expect((await runCarryOver({ dataRoot: w.root }, { apply: true, actor: ACTOR })).exitCode).toBe(0);
        const id = w.ids['undated.jpg'];
        await writeAuthoredRecord({ kind: 'series', id: 'ser_mine', slug: 'mine', title: 'Mine', statement: 'Mine.', shortStatement: 'Mine.', visibility: 'published', photoIds: [id], cover: { photoId: id } }, { expectedVersion: 0, root: w.root });
        const site = (await readAuthoredRecord(w.root, 'site', 'site'))!;
        await writeAuthoredRecord({ ...site, seriesOrder: [CARRY_OVER_SERIES.id, 'ser_mine'] }, { expectedVersion: site.version, root: w.root });
        const dry = await publish({ dataRoot: w.root, actor: ACTOR, dryRun: true, logger: { log: () => undefined } });
        expect(dry.issues).toContainEqual(expect.objectContaining({ code: 'description.required', record: { kind: 'photo', id } }));
        // A statement written for Gallery drops its marker, so the normal rule asks for both.
        const gallery = (await readAuthoredRecord(w.root, 'series', CARRY_OVER_SERIES.id))!;
        await writeAuthoredRecord({ ...gallery, statement: 'Photographs from before.' }, { expectedVersion: gallery.version, root: w.root });
        expect((await readAuthoredRecord(w.root, 'series', CARRY_OVER_SERIES.id))!.carryOver).toBeUndefined();
        const again = await publish({ dataRoot: w.root, actor: ACTOR, dryRun: true, logger: { log: () => undefined } });
        expect(again.issues).toContainEqual(expect.objectContaining({ code: 'description.series-copy', record: { kind: 'series', id: CARRY_OVER_SERIES.id }, field: 'shortStatement' }));
        // With both written and his series back in draft, Gallery alone lists them: they keep their names by place.
        const written = (await readAuthoredRecord(w.root, 'series', CARRY_OVER_SERIES.id))!;
        await writeAuthoredRecord({ ...written, shortStatement: 'Before.' }, { expectedVersion: written.version, root: w.root });
        const mine = (await readAuthoredRecord(w.root, 'series', 'ser_mine'))!;
        await writeAuthoredRecord({ ...mine, visibility: 'draft' }, { expectedVersion: mine.version, root: w.root });
        const last = await publish({ dataRoot: w.root, actor: ACTOR, dryRun: true, logger: { log: () => undefined } });
        expect(last.outcome).toBe('DRY_RUN_OK');
        expect(last.issues.filter((issue) => issue.code === 'description.required' || issue.code === 'description.series-copy')).toEqual([]);
        const { compiled } = await checkLayer(w.root, await readWorkingLayer(w.root));
        expect(compiled.content.photos.map((photo) => photo.alt)).toEqual([{ kind: 'position' }, { kind: 'position' }, { kind: 'position' }]);
    });
});
