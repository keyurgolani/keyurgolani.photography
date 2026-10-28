import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publish } from '../../lib/catalog/publish';
import { CATALOG_LOCK, readRevisionFile, revisionFilePath } from '../../lib/catalog/repository';
import { hashValue } from '../../lib/catalog/review';
import { createTestCatalog, type TestCatalog } from '../../lib/catalog/testing';
import type { AuthoredPhoto } from '../../lib/catalog/types';
import { authoredRecordDir, readActivePointer, readAuthoredRecord } from '../../lib/catalog/working-layer';
import { writeAuthoredRecord } from '../../lib/catalog/working-layer-writer';
import { approveEvent, reopenEvent } from '../../lib/curation/actions';
import { eventIdOf, eventKey } from '../../lib/curation/events';
import { readEvent } from '../../lib/curation/repository';
import { createCurationSink } from '../../lib/curation/sink';
import { assetDir } from '../../lib/media/path';
import { withLock } from '../../lib/storage/lock';

/**
 * #16's Publish screen (16-3) on a real data root: two published series and
 * two activations, then a draft with the changes the approved mockup shows.
 * A new photograph approved through the Inbox with a suggested description
 * nobody has reviewed, a short statement edited with photos edit, a Salt
 * Roads order reviewed against revision 1 that revision 2 published
 * differently (a stale review), and Home's featured order. The helpers move
 * the data root into each of the screen's states the way the CLI, the
 * watcher and the Inbox would. Sample values only; nothing here is real.
 */

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const LOW_TIDE = 'ser_e2e-publish-low-tide';
export const SALT_ROADS = 'ser_e2e-publish-salt-roads';
export const LOW_TIDE_TITLES = ['Low tide 01', 'Low tide 02', 'Harbor wall', 'Low tide 04', 'Low tide 05'];
export const SALT_ROADS_TITLES = ['Coast road', 'Dune fence', 'Salt pans', 'Tide gauge', 'Net sheds', 'Slipway', 'Pier lamps', 'Ferry steps'];
export const LOW_TIDE_IDS = LOW_TIDE_TITLES.map((_, index) => id(101 + index));
export const SALT_ROADS_IDS = SALT_ROADS_TITLES.map((_, index) => id(201 + index));
export const BREAKWATER = id(301);
export const BREAKWATER_TITLE = 'Breakwater, first light';
export const PIER_LAMPS = SALT_ROADS_IDS[6];
export const GENERATED_ALT = 'Six wooden posts stand in calm water at sunrise, the sun low over a flat horizon.';

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };

export interface PublishFixture {
    root: string;
    library: string;
    catalog: TestCatalog;
    /** Revision 1 and revision 2, the active one. */
    revisions: [string, string];
    /** The Inbox item that approved the new photograph. */
    breakwaterEvent: string;
    cleanup(): Promise<void>;
}

async function rewrite<K extends 'site' | 'series' | 'photo'>(root: string, kind: K, recordId: string, change: (record: never) => object, review?: Parameters<typeof writeAuthoredRecord>[1]['review']) {
    const record = await readAuthoredRecord(root, kind, recordId);
    if (record === null) throw new Error(`The fixture has no ${kind} ${recordId}`);
    await writeAuthoredRecord(change(record as never) as never, { expectedVersion: record.version, root, ...(review ? { review } : {}) });
}

/** The Salt Roads order with Pier lamps moved from 7 to 2. */
export function movedSaltRoads(order: readonly string[]): string[] {
    const rest = order.filter((photoId) => photoId !== PIER_LAMPS);
    return [rest[0], PIER_LAMPS, ...rest.slice(1)];
}

/**
 * `dir`: build it in this folder, emptied first, so a server already started
 * on `<dir>/data` and `<dir>/library` serves the fresh fixture (the e2e spec
 * does, between tests). By default a new temp folder.
 */
export async function createPublishFixture({ dir }: { dir?: string } = {}): Promise<PublishFixture> {
    if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
    }
    const temp = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'publish-screen-'));
    const root = path.join(temp, 'data');
    const library = path.join(temp, 'library');
    fs.mkdirSync(library, { recursive: true });
    const photo = (photoId: string, title: string, sourcePath: string) => ({ id: photoId, title, width: 1200, height: 800, sourcePath });
    const catalog = await createTestCatalog({
        root,
        seed: 16,
        withAssets: true,
        photos: [
            ...LOW_TIDE_IDS.map((photoId, index) => photo(photoId, LOW_TIDE_TITLES[index], `low-tide/frame-${index + 1}.jpg`)),
            ...SALT_ROADS_IDS.map((photoId, index) => photo(photoId, SALT_ROADS_TITLES[index], `salt-roads/frame-${index + 1}.jpg`)),
            photo(BREAKWATER, BREAKWATER_TITLE, 'low-tide/breakwater.jpg'),
        ],
        series: [
            { id: LOW_TIDE, slug: 'low-tide-hours', title: 'Low Tide Hours', statement: 'Mornings on the estuary, in the hour before the water comes back.', shortStatement: 'Five mornings on the estuary before the water comes back.', photoIds: [...LOW_TIDE_IDS] },
            { id: SALT_ROADS, slug: 'salt-roads', title: 'Salt Roads', statement: 'The coast road and what stands beside it.', shortStatement: 'The coast road, west to east.', photoIds: [...SALT_ROADS_IDS] },
        ],
        featuredSeriesIds: [LOW_TIDE],
    });
    // The new photograph reaches the registry and the asset store only, as the watcher leaves it.
    const breakwaterRecord = catalog.photos.find((entry) => entry.id === BREAKWATER) as AuthoredPhoto;
    fs.rmSync(authoredRecordDir(root, 'photo', BREAKWATER), { recursive: true, force: true });

    const first = await publish({ dataRoot: root, actor: 'keyur', reason: 'fixture revision 1', confirmLaunch: true, logger: quiet });
    if (first.outcome !== 'PUBLISHED') throw new Error(`The publish fixture's revision 1 didn't publish: ${first.outcome}: ${first.message}`);
    // Revision 2 swaps two Salt Roads photographs, so a review of the order made against revision 1 is stale.
    await rewrite(root, 'series', SALT_ROADS, (series: { photoIds: string[] }) => {
        const order = [...series.photoIds];
        [order[3], order[4]] = [order[4], order[3]];
        return { ...series, photoIds: order };
    });
    const second = await publish({ dataRoot: root, actor: 'keyur', reason: 'fixture revision 2', logger: quiet });
    if (second.outcome !== 'PUBLISHED') throw new Error(`The publish fixture's revision 2 didn't publish: ${second.outcome}: ${second.message}`);
    const r1 = first.revisionId as string;
    const r2 = second.revisionId as string;

    // The draft. The short statement, edited with photos edit.
    await rewrite(root, 'series', LOW_TIDE, (series: object) => ({ ...series, shortStatement: 'Six mornings on the estuary before the water comes back.' }));
    // Home features Salt Roads first.
    await rewrite(root, 'site', 'site', (site: object) => ({ ...site, featuredSeriesIds: [SALT_ROADS, LOW_TIDE] }));
    // Pier lamps from 7 to 2, reviewed against revision 1.
    await rewrite(root, 'series', SALT_ROADS, (series: { photoIds: string[] }) => ({ ...series, photoIds: movedSaltRoads(series.photoIds) }), {
        baseRevisionId: r1,
        actor: 'keyur',
        reviewedAt: '2026-10-24T09:12:00.000Z',
    });
    // The new photograph: a suggested description nobody has reviewed, then approved in the Inbox after photograph 04.
    const { review: _review, version: _version, ...bare } = breakwaterRecord as AuthoredPhoto & { review?: unknown };
    void _review;
    void _version;
    await writeAuthoredRecord({ ...bare, alt: { kind: 'described', text: GENERATED_ALT, reviewed: false } } as never, {
        expectedVersion: 0,
        root,
        // The writer stamps a described alt with `reviewed: false` as generated by itself; the rest is the watcher's record.
        review: { baseRevisionId: r2, actor: 'rules', reviewedAt: '2026-10-25T08:30:00.000Z' },
    });
    const assetRevision = catalog.registry.photos[BREAKWATER].source.observedRevision;
    const key = `new:${BREAKWATER}:${assetRevision}`;
    await createCurationSink({ root, logger: quiet })([
        { type: 'new', factId: randomUUID(), key, photoId: BREAKWATER, assetRevision, path: 'low-tide/breakwater.jpg', folder: 'low-tide', observedAt: '2026-10-25T08:30:00.000Z' },
    ]);
    const breakwaterEvent = eventIdOf(eventKey('new', { photoId: BREAKWATER, assetRevision, key }));
    const event = await readEvent(root, breakwaterEvent);
    if (event === null) throw new Error('The publish fixture has no Inbox item for the new photograph');
    const approved = await approveEvent({ root, eventId: breakwaterEvent, expectedVersion: event.version, expectedBase: r2, actor: 'curator:web', choices: { seriesId: LOW_TIDE, placement: { after: LOW_TIDE_IDS[3] } } });
    if (!approved.ok) throw new Error(`The publish fixture's approval didn't go through: ${approved.code}: ${approved.message}`);
    return { root, library, catalog, revisions: [r1, r2], breakwaterEvent, cleanup: async () => fs.rmSync(temp, { recursive: true, force: true }) };
}

/** Both fixes, as the screen makes them: the description marked ready, and the order reviewed again against revision 2. */
export async function fixBoth(fixture: PublishFixture): Promise<void> {
    const [, r2] = fixture.revisions;
    await rewrite(fixture.root, 'photo', BREAKWATER, (photo: AuthoredPhoto) => ({ ...photo, alt: { kind: 'described', text: GENERATED_ALT, reviewed: true } }), { baseRevisionId: r2, origin: 'curator', actor: 'curator:web', reviewedAt: new Date().toISOString() });
    const series = await readAuthoredRecord(fixture.root, 'series', SALT_ROADS);
    if (series === null) throw new Error('The fixture has no Salt Roads');
    await writeAuthoredRecord(series, { expectedVersion: series.version, root: fixture.root, review: { baseRevisionId: r2, origin: 'curator', actor: 'curator:web', reviewedAt: new Date().toISOString(), reviewedValues: { photoIds: hashValue(series.photoIds) } } });
}

/** A photos edit behind the page's back: the candidate changes, the active revision doesn't. */
export async function editBehindThePage(fixture: PublishFixture, statement = 'Mornings on the estuary, before the water comes back.'): Promise<void> {
    await rewrite(fixture.root, 'series', LOW_TIDE, (series: object) => ({ ...series, statement }));
}

/** A publish from the command line, by `actor`, of whatever the working layer holds now. */
export async function publishFromCli(fixture: PublishFixture, actor = 'keyur'): Promise<string> {
    const result = await publish({ dataRoot: fixture.root, actor, reason: 'from the command line', logger: quiet });
    if (result.outcome !== 'PUBLISHED') throw new Error(`The CLI publish didn't go through: ${result.outcome}: ${result.message}`);
    return result.revisionId as string;
}

/** Hold the catalog lock, as a publish or rollback in another process would. Returns the release. */
export async function holdCatalogLock(fixture: PublishFixture): Promise<() => Promise<void>> {
    let release: () => void = () => undefined;
    let held: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => (held = resolve));
    const done = withLock(CATALOG_LOCK, { root: fixture.root, leaseMs: 120_000, waitMs: 0 }, () => {
        held();
        return new Promise<void>((resolve) => (release = resolve));
    });
    await ready;
    return async () => {
        release();
        await done;
    };
}

/**
 * Make the publish of `draftId` stop at its revision file, the way a full
 * disk would: a folder where the file goes, which no process can write
 * through, root or not. The pointer doesn't move. Returns the undo.
 */
export function blockRevisionFile(fixture: PublishFixture, draftId: string): () => void {
    const file = revisionFilePath(fixture.root, draftId);
    fs.mkdirSync(file, { recursive: true });
    return () => fs.rmSync(file, { recursive: true, force: true });
}

/** Reopen the new photograph's Inbox item after its approval, so the reviews that settled it go stale. */
export async function reopenBreakwater(fixture: PublishFixture): Promise<void> {
    const event = await readEvent(fixture.root, fixture.breakwaterEvent);
    if (event === null) throw new Error('The fixture has no Inbox item for the new photograph');
    const pointer = await readActivePointer(fixture.root);
    const reopened = await reopenEvent({ root: fixture.root, eventId: event.id, expectedVersion: event.version, expectedBase: pointer?.revisionId ?? null, actor: 'curator:web' });
    if (!reopened.ok) throw new Error(`The reopen didn't go through: ${reopened.code}: ${reopened.message}`);
}

// 15-4's History.

/**
 * The publish fixture with its draft fixed and published from the command
 * line: revisions 1 to 3 committed, revision 3 live, nothing pending, so a
 * restore rebases a working layer with no edits of its own.
 */
export async function createHistoryFixture({ dir }: { dir?: string } = {}): Promise<PublishFixture & { live: string }> {
    const fixture = await createPublishFixture({ dir });
    await fixBoth(fixture);
    const live = await publishFromCli(fixture);
    return { ...fixture, live };
}

/**
 * Set a photograph's derivative set aside, as a lost disk would leave it, so
 * a stored revision that publishes it fails the asset rules. Returns the undo.
 */
export async function setAssetsAside(fixture: PublishFixture, revisionId: string, photoId: string): Promise<() => void> {
    const revision = await readRevisionFile(fixture.root, revisionId);
    const photo = revision?.content.photos.find((entry) => entry.id === photoId);
    if (!photo) throw new Error(`${revisionId} doesn't publish ${photoId}`);
    const dir = assetDir({ photoId, assetRevision: photo.assetRevision, profileId: photo.profileId }, fixture.root);
    fs.renameSync(dir, `${dir}.aside`);
    return () => fs.renameSync(`${dir}.aside`, dir);
}

/**
 * History with a restore that takes many photographs away: Salt Roads (8
 * photographs) is hidden and dropped from Home as revision 4, then shown
 * again as the live revision, so restoring revision 4 removes it and its 8
 * photographs. The dialog names 5 and puts the rest behind "and 3 more".
 */
export async function createRemovalsFixture({ dir }: { dir?: string } = {}): Promise<PublishFixture & { live: string; hidden: string }> {
    const fixture = await createHistoryFixture({ dir });
    const stamp = async () => ({ baseRevisionId: (await readActivePointer(fixture.root))?.revisionId ?? null, origin: 'curator' as const, actor: 'curator:web', reviewedAt: new Date().toISOString() });
    const site = await readAuthoredRecord(fixture.root, 'site', 'site');
    const featured = site?.kind === 'site' ? site.featuredSeriesIds : [];
    await rewrite(fixture.root, 'site', 'site', (record: object) => ({ ...record, featuredSeriesIds: featured.filter((id) => id !== SALT_ROADS) }), await stamp());
    await rewrite(fixture.root, 'series', SALT_ROADS, (record: object) => ({ ...record, visibility: 'hidden' }), await stamp());
    const hidden = await publishFromCli(fixture);
    await rewrite(fixture.root, 'series', SALT_ROADS, (record: object) => ({ ...record, visibility: 'published' }), await stamp());
    await rewrite(fixture.root, 'site', 'site', (record: object) => ({ ...record, featuredSeriesIds: featured }), await stamp());
    const live = await publishFromCli(fixture);
    return { ...fixture, live, hidden };
}
