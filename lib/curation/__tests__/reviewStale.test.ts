// @vitest-environment node
import fs from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { publish, validateWorkingLayer } from '../../catalog/publish';
import type { AuthoredPhoto, Issue } from '../../catalog/types';
import { readAuthoredRecord } from '../../catalog/working-layer';
import { writeAuthoredRecord } from '../../catalog/working-layer-writer';
import { approveEvent } from '../actions';
import { eventIdOf, eventKey, type CurationEvent } from '../events';
import { confirmReplacement, leaveInDraft } from '../resolutions';
import { createWorld, makeImages, OWNER, photoRecord, removeTemplate, replacementEventId, SERIES, served, type Images, type World } from './replacementWorld';

/**
 * #16's staleness after #17's replacements, through the inbox, #10's real
 * writer, and #13's real publish: an approval stays reviewed when it is
 * written, goes stale once the photograph's source is replaced again, and
 * blocks a publish until the curator settles the newer item.
 */

let images: Images;
const worlds: World[] = [];

beforeAll(async () => {
    images = await makeImages();
}, 60_000);

afterEach(async () => {
    for (const world of worlds.splice(0)) await world.cleanup();
});

afterAll(() => removeTemplate());

async function world(): Promise<World> {
    const made = await createWorld(images);
    worlds.push(made);
    return made;
}

const ACTOR = 'curator:test';
const log = { log: () => undefined };
const review = (issues: Issue[]) => issues.filter((issue) => issue.code === 'review.authored-change');
const confirm = (w: World, event: CurationEvent, base = w.revisionId) =>
    confirmReplacement({ root: w.root, eventId: event.id, expectedVersion: event.version, expectedBase: base, actor: ACTOR });

describe('a stale approval after a #17 replacement', { timeout: 120_000 }, () => {
    it('keeps a confirm reviewed when it is written, and makes it stale once the source is replaced again, until the newer item is settled', async () => {
        const w = await world();
        await w.build(w.job(w.b));
        const confirmed = await confirm(w, await w.event());
        expect(confirmed).toMatchObject({ ok: true });
        // Written, the confirm is a reviewed asset change.
        expect(review((await validateWorkingLayer({ dataRoot: w.root })).issues)).toEqual([]);

        // P's source is replaced again before B is published. Its new item waits for the curator.
        fs.writeFileSync(w.lib.file('harbor/landscape.jpg'), images.third);
        const c = (await w.pass()).find((fact) => fact.type === 'replaced' && fact.photoId === w.p)?.assetRevision;
        if (!c) throw new Error('The pass reported no replacement.');
        const newer = replacementEventId(w.p, c);
        expect((await w.event(newer)).status).toBe('open');

        const blocked = await publish({ dataRoot: w.root, actor: OWNER, logger: log });
        expect(blocked.outcome).toBe('VALIDATION_FAILED');
        expect(review(blocked.issues)).toEqual([
            expect.objectContaining({ record: { kind: 'photo', id: w.p }, field: 'assetRevision', message: expect.stringContaining(`the replacement item ${newer} still waits for the curator`) }),
        ]);
        expect((await served(w)).photo.assetRevision).toBe(w.a);

        // Leaving the newer item in draft keeps B, which the curator confirmed, and B publishes.
        await w.build(w.job(c));
        const item = await w.event(newer);
        expect(await leaveInDraft({ root: w.root, eventId: newer, expectedVersion: item.version, expectedBase: w.revisionId, actor: ACTOR })).toMatchObject({ ok: true, event: { status: 'deferred' } });
        const shipped = await publish({ dataRoot: w.root, actor: OWNER, logger: log });
        expect(shipped.outcome, shipped.message).toBe('PUBLISHED');
        expect((await served(w)).photo.assetRevision).toBe(w.b);
    });

    it('makes an approval of a new photograph stale once its source is replaced before it is published, and its description once new bytes are confirmed', async () => {
        const w = await world();
        const fresh = 'harbor/fresh.jpg';
        fs.writeFileSync(w.lib.file(fresh), images.fresh);
        const [added] = await w.pass();
        expect(added).toMatchObject({ type: 'new' });
        const photoId = added.photoId as string;
        const first = { photoId, assetRevision: added.assetRevision, profileId: w.profileId, path: fresh };
        expect(await w.build(first)).toMatchObject({ status: 'ready' });
        const newId = eventIdOf(eventKey('new', added));
        const item = await w.event(newId);
        const approved = await approveEvent({
            root: w.root, eventId: newId, expectedVersion: item.version, expectedBase: w.revisionId, actor: ACTOR,
            choices: { seriesId: SERIES, placement: 'end', description: { kind: 'described', text: 'Fixture description typed for the first bytes.' } },
        });
        expect(approved).toMatchObject({ ok: true, event: { status: 'approved' } });
        // Written, the approval is reviewed, so the new photograph could publish now.
        expect(review((await validateWorkingLayer({ dataRoot: w.root })).issues)).toEqual([]);

        // The file is replaced before the publish: what was approved isn't what the source holds any more.
        fs.writeFileSync(w.lib.file(fresh), images.freshReplacement);
        const replaced = (await w.pass()).find((fact) => fact.type === 'replaced' && fact.photoId === photoId)?.assetRevision;
        if (!replaced) throw new Error('The pass reported no replacement.');
        const replacement = replacementEventId(photoId, replaced);
        const stale = await publish({ dataRoot: w.root, actor: OWNER, logger: log });
        expect(stale.outcome).toBe('VALIDATION_FAILED');
        const fields = review(stale.issues).map((issue) => `${issue.record.kind}:${issue.record.id}:${issue.field}`);
        expect(fields).toEqual(expect.arrayContaining([`photo:${photoId}:alt`, `photo:${photoId}:assetRevision`, `series:${SERIES}:photoIds`]));
        for (const issue of review(stale.issues)) expect(issue.message).toContain(replacement);

        // Confirming the new bytes settles the item, but the description was reviewed for the first bytes, so it stays stale.
        expect(await w.build({ ...first, assetRevision: replaced })).toMatchObject({ status: 'ready' });
        expect(await confirm(w, await w.event(replacement))).toMatchObject({ ok: true });
        const described = await publish({ dataRoot: w.root, actor: OWNER, logger: log });
        expect(described.outcome).toBe('VALIDATION_FAILED');
        expect(review(described.issues)).toEqual([expect.objectContaining({ record: { kind: 'photo', id: photoId }, field: 'alt', message: expect.stringContaining('Stale review') })]);

        // Described again for the new bytes, it publishes, on them.
        const record = (await readAuthoredRecord(w.root, 'photo', photoId)) as AuthoredPhoto;
        await writeAuthoredRecord({ ...record, alt: { kind: 'described', text: 'Fixture description checked against the new bytes.', reviewed: true } }, { expectedVersion: record.version, root: w.root });
        const shipped = await publish({ dataRoot: w.root, actor: OWNER, logger: log });
        expect(shipped.outcome, shipped.message).toBe('PUBLISHED');
        expect(((await readAuthoredRecord(w.root, 'photo', photoId)) as AuthoredPhoto).assetRevision).toBe(replaced);
        expect((await photoRecord(w)).assetRevision).toBe(w.a);
    });
});
