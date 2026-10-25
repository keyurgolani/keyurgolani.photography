// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { publish } from '../../catalog/publish';
import { rollback } from '../../catalog/rollback';
import { authoredRecordDir, readAuthoredRecord } from '../../catalog/working-layer';
import { writeAuthoredRecord } from '../../catalog/working-layer-writer';
import { buildDerivativeSet, stagingRoot, type WriterFaults } from '../../identity/derivatives';
import { readRegistry } from '../../identity/registry';
import { runIdentityOnce } from '../../identity/watcherStep';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../../identity/variants';
import { MANIFEST_FILE } from '../../storage/publish';
import { writeVersionedDocument } from '../../storage/document';
import { approveEvent, deferEvent, reopenEvent, retryEvent } from '../actions';
import { createCandidateSink, replacementEventIds, settleCandidates, settlingAfterBuild } from '../candidates';
import { curationUsage, runCurationCli } from '../commands';
import { eventIdOf, eventKey, type CurationEvent } from '../events';
import { listEvents, readEvent, withCurationLock, writeEvent } from '../repository';
import { confirmReplacement, leaveInDraft } from '../resolutions';
import { createCurationSink } from '../sink';
import {
    createWorld,
    makeImages,
    OWNER,
    P_COPY,
    P_PATH,
    photoRecord,
    quiet,
    removeTemplate,
    replacementEventId,
    SERIES,
    served,
    setDir,
    treeBytes,
    type Images,
    type World,
} from './replacementWorld';

/**
 * #17-1 on temp roots, through #10's real writer and #13's real publish:
 * replacement success, a fault at each point of the build, a crash after
 * the rename, the active catalog served at every fault point, rename,
 * simultaneous and duplicate events, what confirming keeps, and an
 * unchanged second run writing nothing.
 */

let images: Images;
const worlds: World[] = [];

beforeAll(async () => {
    images = await makeImages();
}, 60_000);

afterEach(async () => {
    vi.restoreAllMocks();
    for (const world of worlds.splice(0)) await world.cleanup();
});

afterAll(() => removeTemplate());

async function world(): Promise<World> {
    const made = await createWorld(images);
    worlds.push(made);
    return made;
}

const ACTOR = 'curator:test';
const VARIANT_NAMES = VARIANT_WIDTHS.flatMap((width) => VARIANT_FORMATS.map((format) => `${width}.${format}`));

const confirm = (w: World, event: CurationEvent, extra: Partial<Parameters<typeof confirmReplacement>[0]> = {}) =>
    confirmReplacement({ root: w.root, eventId: event.id, expectedVersion: event.version, expectedBase: w.revisionId, actor: ACTOR, ...extra });

/** What #17 writes, and what visitors read: everything a run that changes nothing must leave byte-identical. */
const layers = (w: World) => ({
    curation: treeBytes(path.join(w.root, 'curation')),
    authored: treeBytes(path.join(w.root, 'authored')),
    catalog: treeBytes(path.join(w.root, 'catalog')),
    assets: treeBytes(path.join(w.root, 'assets')),
    staging: treeBytes(stagingRoot(w.root)),
});

const profileState = async (w: World, assetRevision: string) => (await readRegistry(w.root)).photos[w.p].revisions[assetRevision]?.profiles[w.profileId];

const otherRef = (w: World) => ({ photoId: w.p, assetRevision: w.b, profileId: w.profileId });

const NOTHING_SETTLED = { ready: [], failed: [], reopened: [] };

describe('a replacement that builds', { timeout: 60_000 }, () => {
    it('opens as building, turns ready once its set is committed, and confirms onto the same photo, series, and position', async () => {
        const w = await world();
        const before = await served(w, otherRef(w));
        expect(before.photo).toMatchObject({ id: w.p, assetRevision: w.a, title: P_COPY.title, caption: P_COPY.caption });
        expect(before.order).toEqual([w.q, w.p]);
        expect(before.other).toBe(404);
        expect(await w.event()).toMatchObject({ type: 'replacement', status: 'open', assetRevision: w.b });
        expect((await w.event()).candidate).toBeUndefined();

        expect(await w.build(w.job(w.b))).toEqual({ status: 'ready', reused: false });
        const ready = await w.event();
        expect(ready).toMatchObject({ status: 'open', candidate: { state: 'ready', profileId: w.profileId } });
        // Ready to confirm is not public: the active revision serves A, and B's set stays unreachable.
        expect(await served(w, otherRef(w))).toEqual(before);

        const seriesBefore = treeBytes(authoredRecordDir(w.root, 'series', SERIES));
        const recordBefore = await photoRecord(w);
        const catalogBefore = treeBytes(path.join(w.root, 'catalog'));
        const confirmed = await confirm(w, ready);
        expect(confirmed).toMatchObject({
            ok: true,
            event: { status: 'approved', reviewedBy: ACTOR, decisions: [{ action: 'confirm', fromRevision: w.a, baseRevisionId: w.revisionId, writes: [{ record: `photo:${w.p}`, version: recordBefore.version + 1 }] }] },
        });
        // Only the photo record's asset revision moved. Its series, its position, and every authored field stay.
        const { version: _before, assetRevision: _was, ...keptBefore } = recordBefore;
        const { version, assetRevision, ...keptAfter } = await photoRecord(w);
        void _before;
        void _was;
        expect({ version, assetRevision }).toEqual({ version: recordBefore.version + 1, assetRevision: w.b });
        expect(keptAfter).toEqual(keptBefore);
        expect(treeBytes(authoredRecordDir(w.root, 'series', SERIES))).toEqual(seriesBefore);
        expect(treeBytes(path.join(w.root, 'catalog'))).toEqual(catalogBefore);
        expect(await served(w)).toEqual({ ...before, other: null });

        // Only a #13 publish makes B public, still second in the series, with P's copy.
        expect((await publish({ dataRoot: w.root, actor: OWNER, logger: { log: () => undefined } })).outcome).toBe('PUBLISHED');
        const after = await served(w);
        expect(after.photo).toEqual({ id: w.p, assetRevision: w.b, profileId: w.profileId, title: P_COPY.title, caption: P_COPY.caption });
        expect(after.order).toEqual([w.q, w.p]);
        expect(Object.values(after.media).every((entry) => entry.status === 200)).toBe(true);
        // A's set stays, for rollback.
        expect(fs.existsSync(path.join(setDir(w, w.a), MANIFEST_FILE))).toBe(true);
    });

    it('refuses to confirm while the set is building, and writes nothing', async () => {
        const w = await world();
        const before = layers(w);
        const event = await w.event();
        expect(await confirm(w, event)).toMatchObject({ ok: false, code: 'not-ready', message: expect.stringMatching(/only after all derivatives succeed/) });
        expect(layers(w)).toEqual(before);
    });

    it('leaves the current revision in draft with defer, and confirms later from there', async () => {
        const w = await world();
        await w.build(w.job(w.b));
        const event = await w.event();
        const deferred = await deferEvent({ root: w.root, eventId: event.id, expectedVersion: event.version, expectedBase: w.revisionId, actor: ACTOR });
        expect(deferred).toMatchObject({ ok: true, event: { status: 'deferred' } });
        expect((await photoRecord(w)).assetRevision).toBe(w.a);
        // Nothing to publish: the draft still pins A.
        expect((await publish({ dataRoot: w.root, actor: OWNER, logger: { log: () => undefined } })).outcome).toBe('NO_CHANGES');
        expect((await served(w)).photo.assetRevision).toBe(w.a);
        expect(await confirm(w, (deferred as { event: CurationEvent }).event)).toMatchObject({ ok: true });
        expect((await photoRecord(w)).assetRevision).toBe(w.b);
    });
});

describe('leave in draft after a confirm', { timeout: 60_000 }, () => {
    const leave = (w: World, event: CurationEvent, extra: Partial<Parameters<typeof leaveInDraft>[0]> = {}) =>
        leaveInDraft({ root: w.root, eventId: event.id, expectedVersion: event.version, expectedBase: w.revisionId, actor: ACTOR, ...extra });
    const reopen = async (w: World, event: CurationEvent, base = w.revisionId) => {
        const reopened = await reopenEvent({ root: w.root, eventId: event.id, expectedVersion: event.version, expectedBase: base, actor: ACTOR });
        if (!reopened.ok) throw new Error(reopened.message);
        return reopened.event;
    };
    /**
     * Record P's new item as approved, as the curator would have before the
     * first publish, so the inbox records that it pinned A. The world wrote
     * P's record directly, and its source holds B now, so approve itself
     * would be stale.
     */
    const approveP = async (w: World) => {
        const id = eventIdOf(eventKey('new', { photoId: w.p, assetRevision: w.a, key: `new:${w.p}:${w.a}` }));
        const item = await w.event(id);
        const at = new Date(Date.now() - 3_600_000).toISOString();
        await withCurationLock(w.root, {}, (hold) => writeEvent(w.root, {
            ...item,
            status: 'approved',
            decisions: [...item.decisions, { action: 'approve', at, by: ACTOR, baseRevisionId: null, seriesId: SERIES, writes: [] }],
            reviewedAt: at,
            reviewedBy: ACTOR,
        }, item.version, hold));
    };
    const kept = (record: Awaited<ReturnType<typeof photoRecord>>) => {
        const { version: _version, assetRevision: _revision, ...rest } = record;
        void _version;
        void _revision;
        return rest;
    };

    it('puts the photo record back on the revision the confirm replaced, so the next publish ships it', async () => {
        const w = await world();
        await w.build(w.job(w.b));
        const before = await photoRecord(w);
        const confirmed = await confirm(w, await w.event());
        expect(confirmed).toMatchObject({ ok: true });
        const reopened = await reopen(w, (confirmed as { event: CurationEvent }).event);
        expect((await photoRecord(w)).assetRevision).toBe(w.b);

        const left = await leave(w, reopened);
        expect(left).toMatchObject({ ok: true, event: { status: 'deferred' } });
        expect(left.ok && left.event.decisions.at(-1)).toMatchObject({ action: 'defer', fromRevision: w.a, writes: [{ record: `photo:${w.p}`, version: before.version + 2 }] });
        expect(left.ok && left.notes.join(' ')).toContain(`back on ${w.a}, in place of ${w.b}`);
        const after = await photoRecord(w);
        expect(after.assetRevision).toBe(w.a);
        expect(kept(after)).toEqual(kept(before));

        const published = await publish({ dataRoot: w.root, actor: OWNER, logger: { log: () => undefined } });
        expect(['PUBLISHED', 'NO_CHANGES']).toContain(published.outcome);
        expect((await served(w)).photo).toMatchObject({ id: w.p, assetRevision: w.a, title: P_COPY.title });
        // Confirm from there pins B again.
        expect(await confirm(w, (left as { event: CurationEvent }).event)).toMatchObject({ ok: true, event: { decisions: expect.arrayContaining([expect.objectContaining({ action: 'confirm', fromRevision: w.a })]) } });
        expect((await photoRecord(w)).assetRevision).toBe(w.b);
    });

    it('puts A back after B went live, and the next publish ships A', async () => {
        const w = await world();
        await w.build(w.job(w.b));
        const confirmed = await confirm(w, await w.event());
        const live = await publish({ dataRoot: w.root, actor: OWNER, logger: { log: () => undefined } });
        expect(live.outcome).toBe('PUBLISHED');
        expect((await served(w)).photo.assetRevision).toBe(w.b);
        const reopened = await reopen(w, (confirmed as { event: CurationEvent }).event, live.revisionId as string);
        expect(await leave(w, reopened, { expectedBase: live.revisionId })).toMatchObject({ ok: true, event: { status: 'deferred' } });
        expect((await publish({ dataRoot: w.root, actor: OWNER, logger: { log: () => undefined } })).outcome).toBe('PUBLISHED');
        expect((await served(w)).photo).toMatchObject({ assetRevision: w.a, title: P_COPY.title });
    });

    it('after confirm, reopen, and confirm again, still puts back the revision the first confirm replaced', async () => {
        const w = await world();
        await w.build(w.job(w.b));
        const first = await confirm(w, await w.event());
        expect(first).toMatchObject({ ok: true });
        const again = await confirm(w, await reopen(w, (first as { event: CurationEvent }).event));
        expect(again).toMatchObject({ ok: true, event: { status: 'approved' } });
        // The record pinned B already, so this confirm wrote nothing, and records what the first one replaced.
        expect(again.ok && again.event.decisions.at(-1)).toMatchObject({ action: 'confirm', fromRevision: w.a, writes: [] });
        expect(again.ok && again.notes.join(' ')).toContain(`already pins ${w.b}, as the last confirm left it`);
        expect(again.ok && again.notes.join(' ')).toContain(`in place of ${w.a}`);

        const left = await leave(w, await reopen(w, (again as { event: CurationEvent }).event));
        expect(left).toMatchObject({ ok: true, event: { status: 'deferred' } });
        expect(left.ok && left.event.decisions.at(-1)).toMatchObject({ action: 'defer', fromRevision: w.a, writes: [{ record: `photo:${w.p}` }] });
        expect(left.ok && left.notes.join(' ')).toContain(`back on ${w.a}, in place of ${w.b}`);
        expect(left.ok && left.notes.join(' ')).not.toContain('so the draft keeps it');
        expect((await photoRecord(w)).assetRevision).toBe(w.a);
        expect(['PUBLISHED', 'NO_CHANGES']).toContain((await publish({ dataRoot: w.root, actor: OWNER, logger: { log: () => undefined } })).outcome);
        expect((await served(w)).photo).toMatchObject({ assetRevision: w.a, title: P_COPY.title });
    });

    it('refuses once the photo record has moved since the confirm, and writes nothing', async () => {
        const w = await world();
        await w.build(w.job(w.b));
        const confirmed = await confirm(w, await w.event());
        const reopened = await reopen(w, (confirmed as { event: CurationEvent }).event);
        const record = await photoRecord(w);
        const elsewhere = `sha256-${'c'.repeat(64)}`;
        await writeAuthoredRecord({ ...record, assetRevision: elsewhere }, { expectedVersion: record.version, root: w.root });
        const before = layers(w);
        expect(await leave(w, reopened)).toMatchObject({ ok: false, code: 'stale', message: expect.stringContaining(`pins ${elsewhere} now, not ${w.b}`) });
        expect(layers(w)).toEqual(before);
    });

    it('keeps the record where it is when it already went back, as a crash between the put back and the event leaves it', async () => {
        const w = await world();
        await w.build(w.job(w.b));
        const confirmed = await confirm(w, await w.event());
        const reopened = await reopen(w, (confirmed as { event: CurationEvent }).event);
        await expect(leave(w, reopened, { faults: { afterWrite: () => { throw new Error('killed'); } } })).rejects.toThrow('killed');
        expect((await photoRecord(w)).assetRevision).toBe(w.a);
        expect(await w.event()).toEqual(reopened);
        const authored = treeBytes(path.join(w.root, 'authored'));
        const left = await leave(w, reopened);
        expect(left).toMatchObject({ ok: true, event: { status: 'deferred' } });
        expect(left.ok && left.event.decisions.at(-1)).toMatchObject({ action: 'defer', fromRevision: w.a });
        expect(treeBytes(path.join(w.root, 'authored'))).toEqual(authored);
    });

    it('after a crash between confirm\'s two writes, leaves the record on the new bytes with no write, and says nothing was put back', async () => {
        const w = await world();
        await approveP(w);
        await w.build(w.job(w.b));
        const open = await w.event();
        await expect(confirm(w, open, { faults: { afterWrite: () => { throw new Error('killed'); } } })).rejects.toThrow('killed');
        // The record took B, but the event never recorded the confirm.
        expect((await photoRecord(w)).assetRevision).toBe(w.b);
        expect(await w.event()).toEqual(open);

        // Pins alone can't tell this from a hand edit or a rollback, so leave in draft guesses nothing.
        const authored = treeBytes(path.join(w.root, 'authored'));
        const left = await leave(w, open);
        expect(left).toMatchObject({ ok: true, event: { status: 'deferred' } });
        expect(left.ok && left.event.decisions.at(-1)).toMatchObject({ action: 'defer' });
        expect(left.ok && left.event.decisions.at(-1)).not.toHaveProperty('fromRevision');
        expect(left.ok && left.event.decisions.at(-1)).not.toHaveProperty('writes');
        expect(left.ok && left.notes.join(' ')).toContain(`already pins ${w.b}, by an edit or rollback this item didn't make, or a confirm of it that was never recorded, so nothing was put back. The inbox last pinned ${w.a}.`);
        expect(treeBytes(path.join(w.root, 'authored'))).toEqual(authored);
    });

    it('leaves a record moved onto the item\'s bytes by hand where it is, with no write', async () => {
        const w = await world();
        await approveP(w);
        await w.build(w.job(w.b));
        // An edit outside the inbox, as a hand edit of authored/ or #15's rollback moves it.
        const record = await photoRecord(w);
        await writeAuthoredRecord({ ...record, assetRevision: w.b }, { expectedVersion: record.version, root: w.root });
        const authored = treeBytes(path.join(w.root, 'authored'));
        const left = await leave(w, await w.event());
        expect(left).toMatchObject({ ok: true, event: { status: 'deferred' } });
        expect(left.ok && left.event.decisions.at(-1)).not.toHaveProperty('fromRevision');
        expect(left.ok && left.notes.join(' ')).toContain(`already pins ${w.b}, by an edit or rollback this item didn't make`);
        expect(left.ok && left.notes.join(' ')).toContain('so nothing was put back');
        expect(left.ok && left.notes.join(' ')).toContain(`The draft keeps ${w.b}, and the next photos publish ships it.`);
        expect(treeBytes(path.join(w.root, 'authored'))).toEqual(authored);
        expect((await photoRecord(w)).assetRevision).toBe(w.b);
    });

    it('after a crash between confirm\'s two writes, a confirm again records nothing to put back, so reopen and leave in draft keep the new bytes', async () => {
        const w = await world();
        await approveP(w);
        await w.build(w.job(w.b));
        await expect(confirm(w, await w.event(), { faults: { afterWrite: () => { throw new Error('killed'); } } })).rejects.toThrow('killed');
        const authored = treeBytes(path.join(w.root, 'authored'));
        // Nothing on record tells this crash from a rollback or a photos edit onto B, so the confirm guesses no revision to put back.
        const again = await confirm(w, await w.event());
        expect(again).toMatchObject({ ok: true, event: { status: 'approved' } });
        expect(again.ok && again.event.decisions.at(-1)).toMatchObject({ action: 'confirm', writes: [] });
        expect(again.ok && again.event.decisions.at(-1)).not.toHaveProperty('fromRevision');
        expect(again.ok && again.notes.join(' ')).toContain(`already pins ${w.b}, though the inbox last pinned ${w.a}, so nothing in the working layer changed.`);
        expect(again.ok && again.notes.join(' ')).toContain(`recorded as confirmed with nothing to put back, and leaving it in draft later keeps ${w.b}. To use ${w.a} again, set assetRevision back with photos edit ${w.p}.`);
        expect(again.ok && again.notes.join(' ')).not.toContain('puts back');
        const reopened = await reopenEvent({ root: w.root, eventId: w.eventId, expectedVersion: (again as { event: CurationEvent }).event.version, expectedBase: w.revisionId, actor: ACTOR });
        expect(reopened.ok && reopened.notes.join(' ')).toContain('recorded nothing to put back, so leaving it in draft (defer) keeps them too');
        const left = await leave(w, (reopened as { event: CurationEvent }).event);
        expect(left).toMatchObject({ ok: true, event: { status: 'deferred' } });
        expect(left.ok && left.event.decisions.at(-1)).not.toHaveProperty('fromRevision');
        expect(left.ok && left.event.decisions.at(-1)).not.toHaveProperty('writes');
        expect(left.ok && left.notes.join(' ')).toContain(`pins ${w.b}, as it did before this item's last confirm, which recorded nothing to put back, so the draft keeps it.`);
        expect(treeBytes(path.join(w.root, 'authored'))).toEqual(authored);
        expect((await photoRecord(w)).assetRevision).toBe(w.b);
    });

    it('after #15\'s rollback puts the record back on the item\'s bytes, confirm, reopen, and leave in draft put back nothing', async () => {
        const w = await world();
        const log = { log: () => undefined };
        await w.build(w.job(w.b));
        // B is confirmed in place of A and published.
        const b = await confirm(w, await w.event());
        expect(b.ok && b.event.decisions.at(-1)).toMatchObject({ action: 'confirm', fromRevision: w.a });
        const servedB = await publish({ dataRoot: w.root, actor: OWNER, logger: log });
        expect(servedB.outcome).toBe('PUBLISHED');
        const bRevision = servedB.revisionId as string;
        // C replaces B's file, is confirmed in place of B, and published.
        fs.writeFileSync(w.lib.file(P_PATH), images.third);
        const c = (await w.pass()).find((fact) => fact.type === 'replaced' && fact.photoId === w.p)?.assetRevision;
        if (!c) throw new Error('The pass reported no replacement.');
        expect(await w.build(w.job(c))).toEqual({ status: 'ready', reused: false });
        const cConfirmed = await confirm(w, await w.event(replacementEventId(w.p, c)), { expectedBase: bRevision });
        expect(cConfirmed.ok && cConfirmed.event.decisions.at(-1)).toMatchObject({ action: 'confirm', fromRevision: w.b });
        const servedC = await publish({ dataRoot: w.root, actor: OWNER, logger: log });
        expect(servedC.outcome).toBe('PUBLISHED');
        expect((await served(w)).photo.assetRevision).toBe(c);

        // The owner rolls back to the revision that served B. Its rebase puts the record back on B, with no inbox decision.
        const rolled = await rollback({ dataRoot: w.root, revisionId: bRevision, expectedActiveRevisionId: servedC.revisionId as string, actor: OWNER, reason: 'C was the wrong edit', logger: log });
        expect(rolled).toMatchObject({ outcome: 'ROLLED_BACK', rebased: true, conflicts: [] });
        expect((await photoRecord(w)).assetRevision).toBe(w.b);
        expect((await served(w)).photo.assetRevision).toBe(w.b);
        // B's bytes come back to the source, so B's item can be confirmed again. The record pins them, so the pass leaves the item approved.
        fs.writeFileSync(w.lib.file(P_PATH), images.replacement);
        await w.pass();
        const bItem = await reopen(w, await w.event(), bRevision);
        const authored = treeBytes(path.join(w.root, 'authored'));

        // The inbox last pinned C, but nothing shows a confirm of B's item put the record on B, so nothing is recorded to put back.
        const confirmed = await confirm(w, bItem, { expectedBase: bRevision });
        expect(confirmed).toMatchObject({ ok: true, event: { status: 'approved' } });
        expect(confirmed.ok && confirmed.event.decisions.at(-1)).toMatchObject({ action: 'confirm', writes: [] });
        expect(confirmed.ok && confirmed.event.decisions.at(-1)).not.toHaveProperty('fromRevision');
        expect(confirmed.ok && confirmed.notes.join(' ')).toContain(`already pins ${w.b}, though the inbox last pinned ${c}, so nothing in the working layer changed.`);
        expect(confirmed.ok && confirmed.notes.join(' ')).toContain(`a rollback, a photos edit, and a confirm whose event a crash lost all leave it this way.`);
        expect(confirmed.ok && confirmed.notes.join(' ')).toContain(`leaving it in draft later keeps ${w.b}. To use ${c} again, set assetRevision back with photos edit ${w.p}.`);
        expect(confirmed.ok && confirmed.notes.join(' ')).not.toContain('puts back');
        expect(treeBytes(path.join(w.root, 'authored'))).toEqual(authored);

        const reopened = await reopenEvent({ root: w.root, eventId: bItem.id, expectedVersion: (confirmed as { event: CurationEvent }).event.version, expectedBase: bRevision, actor: ACTOR });
        expect(reopened.ok && reopened.notes.join(' ')).toContain('recorded nothing to put back, so leaving it in draft (defer) keeps them too');
        expect(reopened.ok && reopened.notes.join(' ')).not.toContain('to put back the one a confirm replaced');
        const left = await leave(w, (reopened as { event: CurationEvent }).event, { expectedBase: bRevision });
        expect(left).toMatchObject({ ok: true, event: { status: 'deferred' } });
        expect(left.ok && left.event.decisions.at(-1)).toMatchObject({ action: 'defer' });
        expect(left.ok && left.event.decisions.at(-1)).not.toHaveProperty('fromRevision');
        expect(left.ok && left.event.decisions.at(-1)).not.toHaveProperty('writes');
        expect(left.ok && left.notes.join(' ')).toContain(`pins ${w.b}, as it did before this item's last confirm, which recorded nothing to put back, so the draft keeps it.`);
        // Neither C, which the owner rolled away from, nor A, which B's first confirm replaced, comes back.
        expect(treeBytes(path.join(w.root, 'authored'))).toEqual(authored);
        expect((await photoRecord(w)).assetRevision).toBe(w.b);
        expect((await publish({ dataRoot: w.root, actor: OWNER, logger: log })).outcome).toBe('NO_CHANGES');
        expect((await served(w)).photo.assetRevision).toBe(w.b);
    });

    it('after a crash between confirm\'s two writes with no earlier pin in the inbox, says the draft keeps the new bytes', async () => {
        const w = await world();
        await w.build(w.job(w.b));
        await expect(confirm(w, await w.event(), { faults: { afterWrite: () => { throw new Error('killed'); } } })).rejects.toThrow('killed');
        const authored = treeBytes(path.join(w.root, 'authored'));
        const left = await leave(w, await w.event());
        expect(left).toMatchObject({ ok: true, event: { status: 'deferred' } });
        expect(left.ok && left.notes.join(' ')).toContain(`already pins ${w.b}, by an edit or rollback this item didn't make, or a confirm of it that was never recorded, so nothing was put back. The draft keeps ${w.b}`);
        expect(treeBytes(path.join(w.root, 'authored'))).toEqual(authored);
    });

    it('after a later item\'s confirm is left in draft, reopen and show say leaving the earlier item in draft keeps its bytes, which it does', async () => {
        const w = await world();
        const cli = (args: string[]) => runCurationCli(args, { dataRoot: w.root }, { PHOTOS_ACTOR: ACTOR });
        await w.build(w.job(w.b));
        // X: B confirmed in place of A.
        const x = await confirm(w, await w.event());
        expect(x.ok && x.event.decisions.at(-1)).toMatchObject({ action: 'confirm', fromRevision: w.a });
        // Y: C replaces B's file and is confirmed in place of B.
        fs.writeFileSync(w.lib.file(P_PATH), images.third);
        const c = (await w.pass()).find((fact) => fact.type === 'replaced' && fact.photoId === w.p)?.assetRevision;
        if (!c) throw new Error('The pass reported no replacement.');
        expect(await w.build(w.job(c))).toEqual({ status: 'ready', reused: false });
        const yId = replacementEventId(w.p, c);
        const y = await confirm(w, await w.event(yId));
        expect(y.ok && y.event.decisions.at(-1)).toMatchObject({ action: 'confirm', fromRevision: w.b });
        // Y is reopened and left in draft, which puts B back.
        const yLeft = await leave(w, await reopen(w, await w.event(yId)));
        expect(yLeft.ok && yLeft.notes.join(' ')).toContain(`back on ${w.b}, in place of ${c}`);
        expect((await photoRecord(w)).assetRevision).toBe(w.b);
        const authored = treeBytes(path.join(w.root, 'authored'));

        // X is reopened. Y's Leave in draft set the record last, so leaving X in draft keeps B, and reopen and show say so.
        const xItem = await w.event();
        const reopened = await reopenEvent({ root: w.root, eventId: xItem.id, expectedVersion: xItem.version, expectedBase: w.revisionId, actor: ACTOR });
        const note = reopened.ok ? reopened.notes.join(' ') : '';
        expect(note).toContain(`Leaving it in draft (defer) keeps ${w.b}: ${yId}'s defer set ${w.p}'s photo record on it last, not a confirm of this item, so it puts nothing back.`);
        expect(note).toContain(`To use ${w.a} again, which this item's confirm replaced, set assetRevision with photos edit ${w.p}.`);
        expect(note).not.toContain('to put back');
        const shown = (await cli(['show', xItem.id])).output;
        expect(shown).toContain(`Leaving it in draft (defer) keeps ${w.b}: ${yId}'s defer set`);
        expect(shown).not.toContain('puts back');

        const left = await leave(w, (reopened as { event: CurationEvent }).event);
        expect(left).toMatchObject({ ok: true, event: { status: 'deferred' } });
        expect(left.ok && left.event.decisions.at(-1)).not.toHaveProperty('fromRevision');
        expect(left.ok && left.event.decisions.at(-1)).not.toHaveProperty('writes');
        expect(left.ok && left.notes.join(' ')).toContain(`pins ${w.b}, as ${yId}'s defer set it, so the draft keeps it.`);
        expect(treeBytes(path.join(w.root, 'authored'))).toEqual(authored);
        expect((await photoRecord(w)).assetRevision).toBe(w.b);
    });

    it('leaves an item never confirmed in draft with no write', async () => {
        const w = await world();
        await w.build(w.job(w.b));
        const before = treeBytes(path.join(w.root, 'authored'));
        const left = await leave(w, await w.event());
        expect(left).toMatchObject({ ok: true, event: { status: 'deferred' } });
        expect(left.ok && left.notes.join(' ')).toContain(`keeps ${w.a}`);
        expect(treeBytes(path.join(w.root, 'authored'))).toEqual(before);
    });
});

describe('a replacement whose build fails', { timeout: 60_000 }, () => {
    /**
     * Build B with `faults`, checking at the fault that visitors still get
     * A, then that the failure left A's set and the catalog byte-identical,
     * removed only the attempt's staging folder, and turned the item failed.
     */
    async function failsAt(w: World, faults: (atFault: () => Promise<void>) => WriterFaults): Promise<void> {
        const before = await served(w, otherRef(w));
        const aSet = treeBytes(setDir(w, w.a));
        const catalog = treeBytes(path.join(w.root, 'catalog'));
        const authored = treeBytes(path.join(w.root, 'authored'));
        let checked = 0;
        const atFault = async () => {
            expect(await served(w, otherRef(w))).toEqual(before);
            checked++;
        };
        const outcome = await w.build(w.job(w.b), faults(atFault));
        expect(outcome.status).toBe('failed');
        expect(checked).toBe(1);
        expect(await served(w, otherRef(w))).toEqual(before);
        expect(treeBytes(setDir(w, w.a))).toEqual(aSet);
        expect(treeBytes(path.join(w.root, 'catalog'))).toEqual(catalog);
        expect(treeBytes(path.join(w.root, 'authored'))).toEqual(authored);
        expect(fs.readdirSync(stagingRoot(w.root))).toEqual([]);
        expect(fs.existsSync(setDir(w, w.b))).toBe(false);
        expect(await profileState(w, w.b)).toMatchObject({ state: 'failed' });
        const event = await w.event();
        expect(event).toMatchObject({ status: 'failed', candidate: { state: 'failed', profileId: w.profileId, failure: 'build' } });
        expect(await confirm(w, event)).toMatchObject({ ok: false, code: 'refused', message: expect.stringMatching(/derivative set failed: building it failed/) });
        expect(treeBytes(path.join(w.root, 'authored'))).toEqual(authored);
    }

    it.each(VARIANT_NAMES)('at %s', async (name) => {
        const w = await world();
        await failsAt(w, (atFault) => ({
            async afterVariant(written) {
                if (written !== name) return;
                await atFault();
                throw new Error(`fault after ${written}`);
            },
        }));
    });

    it('at validation, when a variant comes out empty', async () => {
        const w = await world();
        await failsAt(w, (atFault) => ({
            async afterEncode(name) {
                if (name !== 'w800.avif') return;
                await atFault();
                return Buffer.alloc(0);
            },
        }));
    });

    it('at the manifest write', async () => {
        const w = await world();
        await failsAt(w, (atFault) => ({
            async writeFile(file, data) {
                if (path.basename(file) === MANIFEST_FILE) {
                    await atFault();
                    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
                }
                await fs.promises.writeFile(file, data, { flag: 'wx' });
            },
        }));
    });

    it('at the rename into the asset store', async () => {
        const w = await world();
        const rename = fs.promises.rename.bind(fs.promises);
        let atFault: () => Promise<void> = async () => undefined;
        vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
            if (String(to) !== setDir(w, w.b)) return rename(from, to);
            await atFault();
            throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
        });
        await failsAt(w, (check) => {
            atFault = check;
            return {};
        });
    });

    it('turns open again when #14\'s retry builds it', async () => {
        const w = await world();
        await w.build(w.job(w.b), { afterVariant: (name) => { if (name === 'w400.webp') throw new Error('fault'); } });
        const failed = await w.event();
        expect(failed.status).toBe('failed');
        const retried = await retryEvent({ root: w.root, eventId: failed.id, expectedVersion: failed.version, expectedBase: w.revisionId, actor: ACTOR });
        expect(retried).toMatchObject({ ok: true });
        await w.pass();
        expect(await profileState(w, w.b)).toMatchObject({ state: 'pending' });
        expect(await w.build(w.job(w.b))).toEqual({ status: 'ready', reused: false });
        expect(await w.event()).toMatchObject({ status: 'open', candidate: { state: 'ready' } });
    });

    it('keeps an item left in draft while building deferred when its set fails, and show reports the failure', async () => {
        const w = await world();
        const building = await w.event();
        const deferred = await deferEvent({ root: w.root, eventId: building.id, expectedVersion: building.version, expectedBase: w.revisionId, actor: ACTOR });
        expect(deferred).toMatchObject({ ok: true, event: { status: 'deferred' } });
        expect(await w.build(w.job(w.b), { afterVariant: (name) => { if (name === 'w400.webp') throw new Error('fault'); } })).toMatchObject({ status: 'failed' });
        const event = await w.event();
        expect(event).toMatchObject({ status: 'deferred', candidate: { state: 'failed', profileId: w.profileId, failure: 'build' } });
        expect(event.decisions.map((decision) => decision.action)).toEqual(['defer']);
        const shown = await runCurationCli(['show', event.id], { dataRoot: w.root }, { PHOTOS_ACTOR: ACTOR });
        expect(shown.output).toContain(`deferred`);
        expect(shown.output).toContain(`New derivative set: failed under ${w.profileId}: building it failed.`);
    });

    it('keeps a failed item deferred once the curator leaves it in draft', async () => {
        const w = await world();
        await w.build(w.job(w.b), { beforeManifest: () => { throw new Error('fault'); } });
        const failed = await w.event();
        const deferred = await deferEvent({ root: w.root, eventId: failed.id, expectedVersion: failed.version, expectedBase: w.revisionId, actor: ACTOR });
        expect(deferred).toMatchObject({ ok: true, event: { status: 'deferred' } });
        const before = layers(w);
        await w.pass();
        expect(await settleCandidates(w.root, { logger: quiet })).toEqual(NOTHING_SETTLED);
        expect(layers(w)).toEqual(before);
    });
});

describe('the watcher\'s --once', { timeout: 60_000 }, () => {
    it('builds the replacement and leaves its item ready, with the candidate sink and the settling build', async () => {
        const w = await world();
        const before = await served(w, otherRef(w));
        const code = await runIdentityOnce({
            sinks: [createCurationSink({ logger: quiet }), createCandidateSink({ logger: quiet })],
            worker: { build: settlingAfterBuild(buildDerivativeSet, { logger: quiet }) },
            logger: quiet,
            pass: { clock: () => Date.now() + 60_000 },
        });
        expect(code).toBe(0);
        expect(await w.event()).toMatchObject({ status: 'open', candidate: { state: 'ready', profileId: w.profileId } });
        expect(await served(w, otherRef(w))).toEqual(before);
    });
});

describe('a crash', { timeout: 60_000 }, () => {
    it('after the rename leaves the set unreachable and the item building, and the next build makes it ready', async () => {
        const w = await world();
        const before = await served(w, otherRef(w));
        await expect(w.build(w.job(w.b), { beforeRecord: async () => {
            expect(await served(w, otherRef(w))).toEqual(before);
            throw new Error('killed');
        } })).rejects.toThrow('killed');
        // The set is in place, but the registry still calls it pending, so nothing can confirm or publish it.
        expect(fs.existsSync(path.join(setDir(w, w.b), MANIFEST_FILE))).toBe(true);
        expect(await profileState(w, w.b)).toMatchObject({ state: 'pending' });
        expect((await w.event()).candidate).toBeUndefined();
        expect(await confirm(w, await w.event())).toMatchObject({ ok: false, code: 'not-ready' });
        expect(await served(w, otherRef(w))).toEqual(before);
        await w.pass();
        expect((await w.event()).candidate).toBeUndefined();

        // The restarted worker finds the set in place and records it.
        expect(await w.build(w.job(w.b))).toEqual({ status: 'ready', reused: true });
        expect(await w.event()).toMatchObject({ status: 'open', candidate: { state: 'ready' } });
        expect(await confirm(w, await w.event())).toMatchObject({ ok: true });
    });

    it('between the registry\'s ready and the item\'s write is settled when the watcher starts again', async () => {
        const w = await world();
        await w.pass();
        // The writer alone, as if the watcher died before the item was written.
        expect(await buildDerivativeSet(w.job(w.b), { logger: quiet })).toEqual({ status: 'ready', reused: false });
        expect((await w.event()).candidate).toBeUndefined();
        // A later pass of the same process names no fact for it, so it reads no item.
        await w.pass();
        expect((await w.event()).candidate).toBeUndefined();
        // The restarted watcher's first pass looks at every item once.
        await w.restartPass();
        expect(await w.event()).toMatchObject({ status: 'open', candidate: { state: 'ready', profileId: w.profileId } });
    });

    it('in a delivery is settled when the pass delivers the fact again, and a pass settles only the revisions its facts name', async () => {
        const w = await world();
        const sink = createCandidateSink({ root: w.root, logger: quiet, waitMs: 100 });
        // The watcher's start: every item is looked at, and B's is still building.
        await sink([]);
        expect((await w.event()).candidate).toBeUndefined();
        expect(await buildDerivativeSet(w.job(w.b), { logger: quiet })).toEqual({ status: 'ready', reused: false });
        const before = layers(w);
        const fact = (photoId: string, assetRevision: string, factId: string) => ({ type: 'replaced' as const, factId, key: `replaced:${photoId}:${assetRevision}`, photoId, assetRevision, path: P_PATH, folder: 'harbor', observedAt: new Date().toISOString() });
        // A pass with no facts, or with facts for other revisions, leaves B's item alone.
        await sink([]);
        await sink([fact(w.q, `sha256-${'e'.repeat(64)}`, 'other'), { ...fact(w.p, w.b, 'new-one'), type: 'new' as const }]);
        expect(layers(w)).toEqual(before);
        // A delivery that fails writes nothing, and the pass keeps the fact pending.
        await withCurationLock(w.root, {}, async () => {
            await expect(sink([fact(w.p, w.b, 'named')])).rejects.toThrow();
        });
        expect(layers(w)).toEqual(before);
        // Delivered again, it settles.
        await sink([fact(w.p, w.b, 'named')]);
        expect(await w.event()).toMatchObject({ status: 'open', candidate: { state: 'ready', profileId: w.profileId } });
    });
});

describe('a busy curation lock', { timeout: 60_000 }, () => {
    it('at the settle after a build is settled by the next pass, with no restart', async () => {
        const w = await world();
        // The watcher's start: B's fact was delivered already, and its item is building.
        await w.pass();
        expect((await w.event()).candidate).toBeUndefined();
        const warn = vi.fn();
        const build = settlingAfterBuild(buildDerivativeSet, { logger: { ...quiet, warn }, waitMs: 100, owed: w.owed });
        // A curator action holds the curation lock through the build's settle, and through the next pass, whose own settle fails too.
        await withCurationLock(w.root, {}, async () => {
            expect(await build(w.job(w.b), { logger: quiet })).toEqual({ status: 'ready', reused: false });
            expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Could not record the set for ${w.p} ${w.b} on its replacement item yet; the next pass settles it`));
            expect((await w.pass()).filter((fact) => fact.photoId === w.p)).toEqual([]);
        });
        // That failed settle leaves B owed still.
        expect((await w.event()).candidate).toBeUndefined();

        // The next pass names no fact for B, and settles it all the same.
        expect((await w.pass()).filter((fact) => fact.photoId === w.p)).toEqual([]);
        expect(await w.event()).toMatchObject({ status: 'open', candidate: { state: 'ready', profileId: w.profileId } });
        // Owed no longer, so a pass after that writes nothing.
        const before = layers(w);
        await w.pass();
        expect(layers(w)).toEqual(before);
    });
});

describe('an older revision\'s bytes', { timeout: 60_000 }, () => {
    it('come back ready on the set already committed for them, with no build', async () => {
        const w = await world();
        await w.build(w.job(w.b));
        expect(await confirm(w, await w.event())).toMatchObject({ ok: true });
        expect((await publish({ dataRoot: w.root, actor: OWNER, logger: { log: () => undefined } })).outcome).toBe('PUBLISHED');
        const live = await served(w);
        expect(live.photo.assetRevision).toBe(w.b);

        const aSet = treeBytes(setDir(w, w.a));
        fs.writeFileSync(w.lib.file(P_PATH), images.original);
        const facts = await w.pass();
        expect(facts).toEqual([expect.objectContaining({ type: 'replaced', photoId: w.p, assetRevision: w.a, revert: true })]);
        // Nothing to build: A's set is still committed, and the item is ready in the same pass.
        expect(await profileState(w, w.a)).toMatchObject({ state: 'ready' });
        expect(fs.readdirSync(stagingRoot(w.root))).toEqual([]);
        expect(treeBytes(setDir(w, w.a))).toEqual(aSet);
        const revert = await w.event(replacementEventId(w.p, w.a));
        expect(revert).toMatchObject({ type: 'replacement', status: 'open', assetRevision: w.a, derivedFacts: { revert: true }, candidate: { state: 'ready', profileId: w.profileId } });
        expect(await served(w)).toEqual(live);

        expect(await confirm(w, revert, { expectedBase: live.revisionId })).toMatchObject({ ok: true, event: { decisions: [{ action: 'confirm', fromRevision: w.b }] } });
        expect((await photoRecord(w)).assetRevision).toBe(w.a);
    });

    it('reopen the item confirmed for them when they come back while the record pins another: B confirmed, A confirmed, B copied back', async () => {
        const w = await world();
        await w.build(w.job(w.b));
        expect(await confirm(w, await w.event())).toMatchObject({ ok: true });
        fs.writeFileSync(w.lib.file(P_PATH), images.original);
        await w.pass();
        expect(await confirm(w, await w.event(replacementEventId(w.p, w.a)))).toMatchObject({ ok: true });
        expect((await photoRecord(w)).assetRevision).toBe(w.a);
        const confirmed = await w.event();
        expect(confirmed).toMatchObject({ status: 'approved', candidate: { state: 'ready' } });
        const served0 = await served(w);

        fs.writeFileSync(w.lib.file(P_PATH), images.replacement);
        expect(await w.pass()).toEqual([expect.objectContaining({ type: 'replaced', photoId: w.p, assetRevision: w.b, revert: true })]);
        // The fact folds into B's item, and the settle opens it again with a fresh candidate.
        const reopened = await w.event();
        expect(reopened).toMatchObject({ status: 'open', version: confirmed.version + 2, candidate: { state: 'ready', profileId: w.profileId } });
        expect(reopened.candidate?.at).not.toBe(confirmed.candidate?.at);
        expect(reopened.decisions.at(-1)).toMatchObject({ action: 'reopen', by: 'watcher', reason: `The source holds ${w.b} again, while the photo record pins ${w.a}.` });
        // Reopening reads the working layer only: the record keeps A, and visitors keep what they had.
        expect((await photoRecord(w)).assetRevision).toBe(w.a);
        expect(await served(w)).toEqual(served0);
        // A pass that names it again changes nothing more.
        const before = layers(w);
        await w.restartPass();
        expect(await settleCandidates(w.root, { logger: quiet, only: w.job(w.b) })).toEqual(NOTHING_SETTLED);
        expect(layers(w)).toEqual(before);
        expect(await confirm(w, reopened)).toMatchObject({ ok: true, event: { status: 'approved', decisions: expect.arrayContaining([expect.objectContaining({ action: 'confirm', fromRevision: w.a })]) } });
        expect((await photoRecord(w)).assetRevision).toBe(w.b);
    });

    it('leave the item confirmed for them approved when they come back while the record still pins them', async () => {
        const w = await world();
        await w.build(w.job(w.b));
        expect(await confirm(w, await w.event())).toMatchObject({ ok: true });
        fs.writeFileSync(w.lib.file(P_PATH), images.original);
        await w.pass();
        fs.writeFileSync(w.lib.file(P_PATH), images.replacement);
        await w.pass();
        expect(await w.event()).toMatchObject({ status: 'approved' });
        expect((await photoRecord(w)).assetRevision).toBe(w.b);
    });

    it('that the photo record still pins confirm with nothing written', async () => {
        const w = await world();
        await w.build(w.job(w.b));
        fs.writeFileSync(w.lib.file(P_PATH), images.original);
        await w.pass();
        const revert = await w.event(replacementEventId(w.p, w.a));
        expect(revert.candidate).toMatchObject({ state: 'ready' });
        // B's item is stale now: the source holds A again.
        expect(await confirm(w, await w.event())).toMatchObject({ ok: false, code: 'stale' });
        const authored = treeBytes(path.join(w.root, 'authored'));
        const result = await confirm(w, revert);
        expect(result).toMatchObject({ ok: true, event: { status: 'approved', decisions: [{ action: 'confirm', writes: [] }] } });
        expect(result.ok && result.notes.join(' ')).toMatch(/already pins/);
        expect(treeBytes(path.join(w.root, 'authored'))).toEqual(authored);
    });
});

describe('a file replaced before its first approval', { timeout: 60_000 }, () => {
    it('folds into its new item, so the approval pins the new bytes and nothing is left for confirm or the settle', async () => {
        const w = await world();
        fs.writeFileSync(w.lib.file('harbor/fresh.jpg'), images.fresh);
        const [added] = await w.pass();
        expect(added).toMatchObject({ type: 'new' });
        const photoId = added.photoId as string;
        const newId = eventIdOf(eventKey('new', added));
        fs.writeFileSync(w.lib.file('harbor/fresh.jpg'), images.freshReplacement);
        const [replaced] = await w.pass();
        expect(replaced).toMatchObject({ type: 'replaced', photoId });
        const moved = await w.event(newId);
        expect(moved).toMatchObject({ type: 'new', status: 'open', assetRevision: replaced.assetRevision });
        // No replacement item opened beside it.
        for (const id of replacementEventIds(photoId, replaced.assetRevision)) expect(await readEvent(w.root, id)).toBeNull();

        const approved = await approveEvent({ root: w.root, eventId: newId, expectedVersion: moved.version, expectedBase: w.revisionId, actor: ACTOR, choices: { seriesId: null } });
        expect(approved).toMatchObject({ ok: true, event: { status: 'approved', assetRevision: replaced.assetRevision } });
        expect((await readAuthoredRecord(w.root, 'photo', photoId))?.assetRevision).toBe(replaced.assetRevision);
        // The new bytes' build, a settle of them, and a restarted watcher's look at every item find nothing to do.
        const job = { photoId, assetRevision: replaced.assetRevision, profileId: w.profileId, path: 'harbor/fresh.jpg' };
        expect(await w.build(job)).toEqual({ status: 'ready', reused: false });
        expect(await settleCandidates(w.root, { logger: quiet, only: job })).toEqual(NOTHING_SETTLED);
        await w.restartPass();
        const { events } = await listEvents(w.root);
        expect(events.filter((event) => event.photoId === photoId).map((event) => [event.type, event.status])).toEqual([['new', 'approved']]);
    });
});

describe('rename, duplicate, and simultaneous events', { timeout: 60_000 }, () => {
    it('keeps one item through a rename, with its new path, and confirms it', async () => {
        const w = await world();
        fs.renameSync(w.lib.file(P_PATH), w.lib.file('harbor/landscape-renamed.jpg'));
        const facts = await w.pass();
        expect(facts.map((fact) => fact.type)).toEqual(['renamed']);
        expect(await w.build({ ...w.job(w.b), path: 'harbor/landscape-renamed.jpg' })).toEqual({ status: 'ready', reused: false });
        const event = await w.event();
        expect(event).toMatchObject({ status: 'open', derivedFacts: { sourcePath: 'harbor/landscape-renamed.jpg' }, candidate: { state: 'ready' } });
        const { events } = await listEvents(w.root);
        expect(events.filter((entry) => entry.type === 'replacement')).toHaveLength(1);
        expect(await confirm(w, event)).toMatchObject({ ok: true });
        expect((await photoRecord(w)).assetRevision).toBe(w.b);
    });

    it('returns the same item for a fact delivered again, and writes nothing', async () => {
        const w = await world();
        await w.build(w.job(w.b));
        const ready = await w.event();
        const fact = { type: 'replaced' as const, factId: 'delivered-again', key: `replaced:${w.p}:${w.b}`, photoId: w.p, assetRevision: w.b, path: P_PATH, folder: 'harbor', observedAt: new Date().toISOString() };
        const deliver = async () => {
            for (const sink of [createCurationSink({ logger: quiet, root: w.root }), createCandidateSink({ logger: quiet, root: w.root })]) await sink([fact]);
        };
        // The same evidence under a new fact ID folds into the same item, which keeps its ready set.
        await deliver();
        const once = await w.event();
        expect(once).toMatchObject({ id: ready.id, version: ready.version + 1, status: 'open', candidate: ready.candidate });
        expect(once.factIds).toContain('delivered-again');
        // That fact again, and a settle again, change nothing.
        const before = layers(w);
        await deliver();
        expect(await settleCandidates(w.root, { logger: quiet, only: w.job(w.b) })).toEqual(NOTHING_SETTLED);
        expect(layers(w)).toEqual(before);
        const { events } = await listEvents(w.root);
        expect(events.filter((entry) => entry.type === 'replacement')).toHaveLength(1);
    });

    it('records a set once when the build, its settle, and a pass run at the same time', async () => {
        const w = await world();
        const version = (await w.event()).version;
        const [outcome] = await Promise.all([w.build(w.job(w.b)), w.pass(), w.pass()]);
        expect(outcome).toEqual({ status: 'ready', reused: false });
        await Promise.all([settleCandidates(w.root, { logger: quiet }), settleCandidates(w.root, { logger: quiet, only: w.job(w.b) }), w.pass()]);
        const event = await w.event();
        expect(event).toMatchObject({ version: version + 1, candidate: { state: 'ready' } });
    });

    it('lets one of two simultaneous confirms through, and the other writes nothing', async () => {
        const w = await world();
        await w.build(w.job(w.b));
        const event = await w.event();
        const record = await photoRecord(w);
        const results = await Promise.all([confirm(w, event), confirm(w, event)]);
        expect(results.filter((result) => result.ok)).toHaveLength(1);
        expect(results.find((result) => !result.ok)).toMatchObject({ code: 'stale' });
        expect((await photoRecord(w)).version).toBe(record.version + 1);
    });

    it('settles nothing and writes nothing on an unchanged second run', async () => {
        const w = await world();
        await w.build(w.job(w.b));
        await w.pass();
        const before = layers(w);
        expect(await w.pass()).toEqual([]);
        expect(await settleCandidates(w.root, { logger: quiet })).toEqual(NOTHING_SETTLED);
        expect(await w.build(w.job(w.b))).toEqual({ status: 'skipped', reason: 'not-pending' });
        expect(layers(w)).toEqual(before);
    });
});

describe('confirm', { timeout: 60_000 }, () => {
    it('refuses a stale item, base, or source, and writes nothing', async () => {
        const w = await world();
        await w.build(w.job(w.b));
        const event = await w.event();
        const before = layers(w);
        expect(await confirm(w, event, { expectedVersion: event.version - 1 })).toMatchObject({ ok: false, code: 'stale' });
        expect(await confirm(w, event, { expectedBase: null })).toMatchObject({ ok: false, code: 'stale' });
        expect(await confirm(w, event, { expectedBase: undefined })).toMatchObject({ ok: false, code: 'needs-choice', message: expect.stringContaining(`--base ${w.revisionId}`) });
        expect(layers(w)).toEqual(before);

        // Newer bytes again: B's item is stale, and the source's own item is the one to review.
        fs.writeFileSync(w.lib.file(P_PATH), images.third);
        await w.pass();
        expect(await confirm(w, event)).toMatchObject({ ok: false, code: 'stale', message: expect.stringMatching(/now holds/) });
        expect(treeBytes(path.join(w.root, 'authored'))).toEqual(before.authored);
    });

    it('refuses a photo record that moved under the lock, through the writer\'s compare-and-swap', async () => {
        const w = await world();
        await w.build(w.job(w.b));
        const event = await w.event();
        const record = await photoRecord(w);
        const result = await confirm(w, event, {
            faults: {
                // A writer past its lease commits the next version between confirm's read and its write.
                beforeWrite: async () => {
                    const { schemaVersion, version, baseRevisionId, ...rest } = record;
                    await writeVersionedDocument(authoredRecordDir(w.root, 'photo', w.p), { schemaVersion, version: version + 1, baseRevisionId, ...rest, title: 'Moved' }, version);
                },
            },
        });
        expect(result).toMatchObject({ ok: false, code: 'stale' });
        expect(await photoRecord(w)).toMatchObject({ version: record.version + 1, assetRevision: w.a, title: 'Moved' });
        expect(await readEvent(w.root, event.id)).toEqual(event);
    });

    it('refuses a set that no longer checks out against its manifest', async () => {
        const w = await world();
        await w.build(w.job(w.b));
        fs.appendFileSync(path.join(setDir(w, w.b), 'w400.webp'), 'x');
        const authored = treeBytes(path.join(w.root, 'authored'));
        expect(await confirm(w, await w.event())).toMatchObject({ ok: false, code: 'damaged', message: expect.stringMatching(/doesn't check out/) });
        expect(treeBytes(path.join(w.root, 'authored'))).toEqual(authored);
    });

    it('refuses a set superseded before it was built', async () => {
        const w = await world();
        fs.writeFileSync(w.lib.file(P_PATH), images.third);
        await w.pass();
        expect(await w.build(w.job(w.b))).toMatchObject({ status: 'failed', error: 'source-superseded' });
        const event = await w.event();
        expect(event).toMatchObject({ status: 'failed', candidate: { state: 'failed', failure: 'superseded' } });
        expect(await confirm(w, event)).toMatchObject({ ok: false, code: 'stale' });
    });

    it('works from the CLI, and show says what confirming keeps', async () => {
        const w = await world();
        const event = await w.event();
        const cli = (args: string[]) => runCurationCli(['curation', ...args].slice(1), { dataRoot: w.root }, { PHOTOS_ACTOR: ACTOR });
        expect(await cli(['show', event.id])).toMatchObject({ exitCode: 0, output: expect.stringContaining('New derivative set: still building.') });
        expect(await cli(['confirm', event.id, '--version', String(event.version), '--base', w.revisionId])).toMatchObject({ exitCode: 3, output: expect.stringContaining('Error (not-ready)') });
        expect(await cli(['confirm', event.id, '--version', String(event.version), '--reason', 'no'])).toMatchObject({ exitCode: 2 });
        await w.build(w.job(w.b));
        const ready = await w.event();
        const shown = await cli(['show', ready.id]);
        expect(shown.output).toContain(`New derivative set: ready under ${w.profileId}`);
        expect(shown.output).toContain(`Photo record pins: ${w.a}`);
        expect(shown.output).toContain('keeps');
        expect(shown.output).not.toContain(w.root);
        const done = await cli(['confirm', ready.id, '--version', String(ready.version), '--base', w.revisionId]);
        expect(done).toMatchObject({ exitCode: 0, output: expect.stringContaining(`Confirmed ${w.b} for ${w.p}`) });
        expect((await cli(['show', ready.id])).output).toContain(`confirm by ${ACTOR}: wrote photo:${w.p}`);
        expect((await readAuthoredRecord(w.root, 'photo', w.p))?.assetRevision).toBe(w.b);
    });

    it('is undone from the CLI by reopen and defer, which put the earlier revision back', async () => {
        const w = await world();
        await w.build(w.job(w.b));
        const cli = (args: string[]) => runCurationCli(args, { dataRoot: w.root }, { PHOTOS_ACTOR: ACTOR });
        const at = async () => String((await w.event()).version);
        expect(await cli(['confirm', w.eventId, '--version', await at(), '--base', w.revisionId])).toMatchObject({ exitCode: 0 });
        const reopened = await cli(['reopen', w.eventId, '--version', await at(), '--base', w.revisionId]);
        expect(reopened).toMatchObject({ exitCode: 0, output: expect.stringContaining(`Leaving it in draft (defer) puts back ${w.a}, the revision this item's confirm replaced.`) });
        expect((await cli(['show', w.eventId])).output).toContain(`Leaving it in draft (defer) puts back ${w.a}, the revision this item's confirm replaced.`);
        const deferred = await cli(['defer', w.eventId, '--version', await at(), '--base', w.revisionId]);
        expect(deferred).toMatchObject({ exitCode: 0, output: expect.stringContaining(`back on ${w.a}, in place of ${w.b}`) });
        expect((await photoRecord(w)).assetRevision).toBe(w.a);
        const shown = (await cli(['show', w.eventId])).output;
        expect(shown).toMatch(new RegExp(`defer by ${ACTOR}: wrote photo:${w.p} v\\d+, put back ${w.a}`));
        expect(shown).toContain(`Leaving it in draft (defer) keeps ${w.a}, the revision ${w.p}'s photo record pins.`);
        expect(shown).not.toContain('puts back');
        expect(curationUsage()).toContain('reopen and then defer put back the revision the confirm replaced');
        expect(curationUsage()).not.toContain('To keep the current revision instead');
    });
});

