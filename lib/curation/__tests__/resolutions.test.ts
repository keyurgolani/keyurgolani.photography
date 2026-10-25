// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { authoredRecordDir, catalogPaths } from '../../catalog/working-layer';
import { writeAuthoredRecord } from '../../catalog/working-layer-writer';
import { readRegistry, writeRegistry } from '../../identity/registry';
import { readVersionedDocument, writeVersionedDocument } from '../../storage/document';
import { reopenEvent } from '../actions';
import { eventIdOf, eventKey, type CurationEvent } from '../events';
import { readEvent } from '../repository';
import { confirmReplacement, leaveInDraft } from '../resolutions';
import { createWorld, makeImages, P_PATH, photoRecord, removeTemplate, setDir, treeBytes, type Images, type World } from './replacementWorld';

// The real writer, watched, so a test can read what each resolution handed it.
vi.mock('../../catalog/working-layer-writer', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../catalog/working-layer-writer')>();
    return { ...actual, writeAuthoredRecord: vi.fn(actual.writeAuthoredRecord) };
});

/**
 * One test for each of confirm's guards in lib/curation/resolutions.ts, so
 * removing any of them fails here: the active revision checked again under
 * the authored lock, a merged or missing source, the strict manifest read,
 * no photo record, an event that isn't a replacement, and the review inputs
 * handed to #13's writer for #16.
 */

let images: Images;
const worlds: World[] = [];
const writer = vi.mocked(writeAuthoredRecord);

beforeAll(async () => {
    images = await makeImages();
}, 60_000);


afterEach(async () => {
    for (const world of worlds.splice(0)) await world.cleanup();
});

afterAll(() => removeTemplate());

async function readyWorld(): Promise<World> {
    const made = await createWorld(images);
    worlds.push(made);
    expect(await made.build(made.job(made.b))).toEqual({ status: 'ready', reused: false });
    // The world's own records went through the writer too.
    writer.mockClear();
    return made;
}

const ACTOR = 'curator:test';

const confirm = (w: World, event: CurationEvent, extra: Partial<Parameters<typeof confirmReplacement>[0]> = {}) =>
    confirmReplacement({ root: w.root, eventId: event.id, expectedVersion: event.version, expectedBase: w.revisionId, actor: ACTOR, ...extra });

const authored = (w: World) => treeBytes(path.join(w.root, 'authored'));

/** Confirm, expecting `expected`, and that neither the photo record nor the event changed. */
async function refused(w: World, expected: { code: string; message: string | RegExp }, extra: Partial<Parameters<typeof confirmReplacement>[0]> = {}, event?: CurationEvent) {
    const item = event ?? await w.event();
    const before = authored(w);
    const result = await confirm(w, item, extra);
    expect(result).toMatchObject({ ok: false, code: expected.code });
    expect(!result.ok && result.message).toMatch(expected.message);
    expect(authored(w)).toEqual(before);
    expect(await readEvent(w.root, item.id)).toEqual(item);
    expect(writer).not.toHaveBeenCalled();
}

describe('confirm\'s guards', { timeout: 60_000 }, () => {
    it('checks the active revision again under the authored lock, so a publish while it waited is stale', async () => {
        const w = await readyWorld();
        await refused(w, { code: 'stale', message: /active revision moved while the confirm waited for the authored lock/ }, {
            faults: {
                // A publish lands after the event and its base were checked, before the authored lock is held.
                async beforeAuthoredLock() {
                    const stored = await readVersionedDocument(catalogPaths(w.root).active);
                    if (!stored) throw new Error('Nothing is active.');
                    await writeVersionedDocument(catalogPaths(w.root).active, { ...stored.value, schemaVersion: stored.value.schemaVersion as number, version: stored.version + 1, revisionId: `rev_${'f'.repeat(64)}` }, stored.version);
                },
            },
        });
    });

    it('refuses a source merged into another photo', async () => {
        const w = await readyWorld();
        const registry = await readRegistry(w.root);
        registry.photos[w.p].mergedInto = w.q;
        await writeRegistry(w.root, registry, registry.version);
        await refused(w, { code: 'stale', message: `${w.p} was merged into ${w.q}` });
    });

    it('refuses a source that went missing', async () => {
        const w = await readyWorld();
        fs.rmSync(w.lib.file(P_PATH));
        await w.pass();
        expect((await readRegistry(w.root)).photos[w.p]).toMatchObject({ sourceHealth: 'missing', source: { observedRevision: w.b } });
        await refused(w, { code: 'stale', message: `${w.p} is missing` });
    });

    it('refuses a set folder that is a symlink, even to a copy that checks out file by file', async () => {
        const w = await readyWorld();
        const dir = setDir(w, w.b);
        const copy = `${dir}-copy`;
        fs.cpSync(dir, copy, { recursive: true });
        fs.rmSync(dir, { recursive: true });
        fs.symlinkSync(copy, dir, 'dir');
        await refused(w, { code: 'damaged', message: /no valid manifest/ });
    });

    it('refuses a set with one byte changed at the same size, which only the hash shows', async () => {
        const w = await readyWorld();
        const file = path.join(setDir(w, w.b), 'w400.webp');
        const bytes = fs.readFileSync(file);
        bytes[bytes.length >> 1] ^= 0xff;
        fs.chmodSync(file, 0o600);
        fs.writeFileSync(file, bytes);
        await refused(w, { code: 'damaged', message: /doesn't check out/ });
    });

    it('refuses a photo with no photo record', async () => {
        const w = await readyWorld();
        fs.rmSync(authoredRecordDir(w.root, 'photo', w.p), { recursive: true });
        await refused(w, { code: 'refused', message: `${w.p} has no photo record in the working layer` });
    });

    it('refuses an event that is not a replacement', async () => {
        const w = await readyWorld();
        const newItem = await w.event(eventIdOf(eventKey('new', { photoId: w.p, assetRevision: w.a, key: `new:${w.p}:${w.a}` })));
        expect(newItem).toMatchObject({ type: 'new', status: 'open' });
        await refused(w, { code: 'refused', message: 'Only a replacement is confirmed. A new event is settled another way.' }, {}, newItem);
    });
});

describe('the review inputs handed to #13\'s writer', { timeout: 60_000 }, () => {
    it('name the base, the event version reviewed, the asset move, the actor, and when, for confirm and for leave in draft', async () => {
        const w = await readyWorld();
        const event = await w.event();
        const confirmed = await confirm(w, event);
        expect(confirmed).toMatchObject({ ok: true });
        expect(writer).toHaveBeenCalledTimes(1);
        const [record, options] = writer.mock.calls[0];
        expect(record).toMatchObject({ kind: 'photo', id: w.p, assetRevision: w.b });
        expect(options.review).toEqual({
            baseRevisionId: w.revisionId,
            event: { id: event.id, version: event.version },
            asset: { from: w.a, to: w.b, profileId: w.profileId },
            actor: ACTOR,
            reviewedAt: (confirmed as { event: CurationEvent }).event.reviewedAt,
        });

        const reopened = await reopenEvent({ root: w.root, eventId: event.id, expectedVersion: (confirmed as { event: CurationEvent }).event.version, expectedBase: w.revisionId, actor: ACTOR });
        if (!reopened.ok) throw new Error(reopened.message);
        writer.mockClear();
        const left = await leaveInDraft({ root: w.root, eventId: event.id, expectedVersion: reopened.event.version, expectedBase: w.revisionId, actor: 'curator:other' });
        expect(left).toMatchObject({ ok: true, event: { status: 'deferred' } });
        expect(writer).toHaveBeenCalledTimes(1);
        expect(writer.mock.calls[0][0]).toMatchObject({ id: w.p, assetRevision: w.a });
        expect(writer.mock.calls[0][1].review).toEqual({
            baseRevisionId: w.revisionId,
            event: { id: event.id, version: reopened.event.version },
            asset: { from: w.b, to: w.a, profileId: w.profileId },
            actor: 'curator:other',
            reviewedAt: (left as { event: CurationEvent }).event.reviewedAt,
        });
        expect((await photoRecord(w)).assetRevision).toBe(w.a);
    });

    it('are not handed for a write that never happens', async () => {
        const w = await readyWorld();
        const record = await photoRecord(w);
        await writeAuthoredRecord({ ...record, assetRevision: w.b }, { expectedVersion: record.version, root: w.root });
        writer.mockClear();
        expect(await confirm(w, await w.event())).toMatchObject({ ok: true, event: { decisions: [{ action: 'confirm', writes: [] }] } });
        expect(writer).not.toHaveBeenCalled();
    });
});
