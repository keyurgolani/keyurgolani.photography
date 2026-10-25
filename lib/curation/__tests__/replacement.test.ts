// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { publish } from '../../catalog/publish';
import { authoredRecordDir, readAuthoredRecord } from '../../catalog/working-layer';
import { buildDerivativeSet, stagingRoot, type WriterFaults } from '../../identity/derivatives';
import { readRegistry } from '../../identity/registry';
import { runIdentityOnce } from '../../identity/watcherStep';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../../identity/variants';
import { MANIFEST_FILE } from '../../storage/publish';
import { writeVersionedDocument } from '../../storage/document';
import { deferEvent, retryEvent } from '../actions';
import { createCandidateSink, settleCandidates, settlingAfterBuild } from '../candidates';
import { runCurationCli } from '../commands';
import type { CurationEvent } from '../events';
import { listEvents, readEvent, withCurationLock } from '../repository';
import { confirmReplacement } from '../resolutions';
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
        expect(await settleCandidates(w.root, { logger: quiet })).toEqual({ ready: [], failed: [] });
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
        expect(await settleCandidates(w.root, { logger: quiet, only: w.job(w.b) })).toEqual({ ready: [], failed: [] });
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
        expect(await settleCandidates(w.root, { logger: quiet })).toEqual({ ready: [], failed: [] });
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
});

