// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderBytes } from '../../../test/helpers/folderBytes';
import { readRegistry, writeRegistry } from '../../identity/registry';
import { mediaFilePath } from '../../media/path';
import { MAX_LEASE_MS, withLock, type LockRecord } from '../../storage/lock';
import { historyState, knownGood, readHistory } from '../history';
import { historyLines, rollbackArgs, runHistoryCommand, runRollbackCommand, type RollbackArgs, type RollbackIo } from '../history-cli';
import { publish, type PublishOptions, type PublishResult } from '../publish';
import { CATALOG_LOCK, CatalogIntegrityError, listActivations, readRevisionFile, revisionFilePath } from '../repository';
import { planRollback, rollback, ROLLBACK_EXIT_CODES, type RollbackOptions, type RollbackResult } from '../rollback';
import { registerRule } from '../rules';
import { createTestCatalog, type TestCatalog, type TestCatalogOptions } from '../testing';
import type { Activation, ActivePointer, AuthoredPhoto } from '../types';
import { AUTHORED_LOCK, writeAuthoredRecord } from '../working-layer-writer';
import { catalogPaths, readActivePointer, readWorkingLayer } from '../working-layer';
import { VARIANT_BYTES } from './catalogFixtures';

const cleanups: (() => Promise<void>)[] = [];

/** The revision test.rollback-editorial reports an editorial error on while it's set, so a stored revision can carry one. */
let editorialErrorOn: string | null = null;
registerRule({
    id: 'test.rollback-editorial',
    version: 1,
    severity: 'error',
    gate: 'publish',
    rollbackClass: 'editorial',
    check: (ctx) => (editorialErrorOn !== null && ctx.authored === null && ctx.active?.revisionId === editorialErrorOn
        ? [{ record: { kind: 'site', id: 'site' }, field: 'featuredSeriesIds', message: 'A test editorial error.' }]
        : []),
});

afterEach(async () => {
    editorialErrorOn = null;
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

type Event = { event: string; [key: string]: unknown };

interface Setup {
    catalog: TestCatalog;
    root: string;
    events: Event[];
    publishNow(options?: Partial<PublishOptions>): Promise<PublishResult>;
    rollTo(revisionId: string, expectedActiveRevisionId: string, options?: Partial<RollbackOptions>): Promise<RollbackResult>;
    editPhoto(id: string, change: (photo: AuthoredPhoto) => void): Promise<AuthoredPhoto>;
}

async function setup(options: TestCatalogOptions = {}): Promise<Setup> {
    const catalog = await createTestCatalog({ variantBytes: VARIANT_BYTES, photos: 4, series: 1, ...options });
    cleanups.push(() => catalog.cleanup());
    const root = catalog.root;
    const events: Event[] = [];
    const logger = { log: (line: string) => events.push(JSON.parse(line) as Event) };
    return {
        catalog,
        root,
        events,
        publishNow: (overrides = {}) => publish({ dataRoot: root, actor: 'test', confirmLaunch: true, logger, ...overrides }),
        rollTo: (revisionId, expectedActiveRevisionId, overrides = {}) =>
            rollback({ dataRoot: root, revisionId, expectedActiveRevisionId, actor: 'curator', reason: 'roll back', logger, ...overrides }),
        async editPhoto(id, change) {
            const record = (await readWorkingLayer(root)).photos.find((photo) => photo.id === id);
            if (!record) throw new Error(`No photo record ${id}`);
            const next = structuredClone(record);
            change(next);
            return writeAuthoredRecord(next, { expectedVersion: record.version, root });
        },
    };
}

/** Publish revision 1, change a caption, and publish revision 2. */
async function twoRevisions(options: TestCatalogOptions = {}): Promise<Setup & { first: PublishResult; second: PublishResult; one: string; two: string }> {
    const context = await setup(options);
    const first = await context.publishNow();
    if (first.outcome !== 'PUBLISHED') throw new Error(`The first publish ended ${first.outcome}: ${first.message}`);
    await context.editPhoto(context.catalog.photos[0].id, (photo) => {
        photo.caption = 'A caption revision 2 publishes.';
    });
    const second = await context.publishNow();
    if (second.outcome !== 'PUBLISHED') throw new Error(`The second publish ended ${second.outcome}: ${second.message}`);
    context.events.length = 0;
    return { ...context, first, second, one: first.revisionId ?? '', two: second.revisionId ?? '' };
}

async function bases(root: string): Promise<(string | null | undefined)[]> {
    const layer = await readWorkingLayer(root);
    return [...new Set([layer.site, ...layer.series, ...layer.photos].map((record) => record?.baseRevisionId))];
}

/** The bytes of every revision file and activation record, so a later write to either shows. */
function stored(root: string): { revisions: Record<string, Buffer>; activations: Record<string, Buffer> } {
    const read = (dir: string) => (fs.existsSync(dir) ? Object.fromEntries(fs.readdirSync(dir).sort().map((name) => [name, fs.readFileSync(path.join(dir, name))])) : {});
    return { revisions: read(catalogPaths(root).revisionsDir), activations: read(catalogPaths(root).activationsDir) };
}

const statuses = async (root: string) => (await listActivations(root)).map((activation) => `${activation.sequence}:${activation.kind}:${activation.status}:${activation.revisionNumber}`);

function io(answer: boolean | null = null, onAsk?: () => Promise<void>): RollbackIo & { out: (line: string) => void; lines: string[]; errors: string[]; asked: string[]; events: Event[] } {
    const lines: string[] = [];
    const errors: string[] = [];
    const asked: string[] = [];
    const events: Event[] = [];
    return {
        lines,
        errors,
        asked,
        events,
        out: (line) => lines.push(line),
        err: (line) => errors.push(line),
        confirm: answer === null ? null : async (question) => {
            asked.push(question);
            await onAsk?.();
            return answer;
        },
        logger: { log: (line) => events.push(JSON.parse(line) as Event) },
    };
}

describe('photos history', { timeout: 60_000 }, () => {
    it('orders activations by sequence, not time, marks the live one, and summarizes each revision against its parent', async () => {
        const context = await setup({ seed: 201 });
        // Each activation gets an earlier clock than the one before, as a container with a slow clock would give it.
        let now = Date.parse('2026-06-01T00:00:00.000Z');
        const clock = () => (now -= 60_000);
        const first = await context.publishNow({ clock });
        const [captioned] = context.catalog.photos.map((photo) => photo.id);
        await context.editPhoto(captioned, (photo) => {
            photo.caption = 'A caption revision 2 publishes.';
        });
        const second = await context.publishNow({ clock });
        // A publish that crashes after writing its pending activation leaves an interrupted record.
        await context.editPhoto(captioned, (photo) => {
            photo.caption = 'A caption that never goes live.';
        });
        const crashed = await context.publishNow({ clock, hooks: { afterStep: (step) => { if (step === 10) throw new Error('crash after step 10'); } } });
        expect(crashed.outcome).toBe('STORAGE_ERROR');
        const rolled = await context.rollTo(first.revisionId ?? '', second.revisionId ?? '', { clock });
        expect(rolled.outcome).toBe('ROLLED_BACK');

        const history = await readHistory(context.root);
        expect(history.rows.map((row) => `${row.activation.sequence}:${row.activation.kind}:${row.state}${row.live ? ':live' : ''}`)).toEqual([
            '1:publish:committed',
            '2:publish:committed',
            '3:publish:interrupted',
            '4:rollback:committed:live',
        ]);
        const times = history.rows.map((row) => Date.parse(row.activation.committedAt ?? row.activation.startedAt));
        expect([...times].sort((a, b) => a - b)).toEqual([...times].reverse());
        expect(history.rows[0].summary).toMatchObject({ parentRevisionId: null, seriesCount: 1, photoCount: 4, changes: null });
        expect(history.rows[1].summary).toMatchObject({ parentRevisionId: first.revisionId, changes: { photos: { added: [], removed: [], changed: [captioned] }, series: { added: [], removed: [], changed: [] }, site: false } });

        const text = historyLines(history).join('\n');
        expect(text).toContain(`[photos] 4 activations, oldest first. Live: revision 1, ${first.revisionId}, from #4.`);
        expect(text).toMatch(/^#4 revision 1: rollback, committed, LIVE$/m);
        expect(text).toMatch(/^#2 revision 2: publish, committed$/m);
        expect(text).toMatch(/^#3 not activated: publish, interrupted$/m);
        expect(text).toContain('Interrupted: it never moved the active pointer, and a later command set it aside.');
        expect(text).toContain(`Against its parent ${first.revisionId}: photos 1 changed`);
        expect(text).toContain(`Rolled back from ${second.revisionId}`);
        expect(text).toContain('by curator: roll back');
        expect(text).not.toContain(context.root);
    });

    it('marks nothing live, and says so, when the pointer names an activation no committed record holds', async () => {
        const { root, two, second } = await twoRevisions({ seed: 203 });
        fs.rmSync(path.join(catalogPaths(root).activationsDir, `000002-${second.activationId}.json`));
        const history = await readHistory(root);
        expect(history.rows.map((row) => row.live)).toEqual([false]);
        expect(historyLines(history)).toEqual(expect.arrayContaining([
            '[photos] 1 activation, oldest first. No committed activation is live.',
            `The active pointer names ${two} through ${second.activationId}, which no committed activation records. The next publish repairs it or says what blocks it.`,
        ]));
    });

    it('says nothing has been published on a data root with no activations', async () => {
        const { root } = await setup({ seed: 202 });
        expect(historyLines(await readHistory(root))).toEqual(['[photos] Nothing has been published yet.']);
    });
});

describe('photos rollback', { timeout: 60_000 }, () => {
    it('rolls back, rolls forward, and publishes on, as new activations that copy, edit, renumber, and erase nothing', async () => {
        const { catalog, root, rollTo, publishNow, editPhoto, one, two, second, events } = await twoRevisions({ seed: 211 });
        const before = stored(root);

        const back = await rollTo(one, two);
        expect(back).toMatchObject({ outcome: 'ROLLED_BACK', rebased: true });
        expect(back.message).toBe(`Rolled back to revision 1 (${one}) from revision 2 (${two}).`);
        expect(back.activation).toMatchObject({
            kind: 'rollback', status: 'committed', sequence: 3, revisionId: one, revisionNumber: 1, previousRevisionId: two, previousActivationId: second.activationId,
            actor: 'curator', reason: 'roll back', acceptedRules: [], lockTakeover: null, validation: { errors: 0 },
        });
        expect(await readActivePointer(root)).toMatchObject({ revisionId: one, activationId: back.activation?.activationId });
        expect(await bases(root)).toEqual([one]);
        expect(events.map((entry) => entry.event)).toEqual(['catalog.rollback.started', 'catalog.rollback.activated']);

        const forward = await rollTo(two, one, { reason: 'roll forward' });
        expect(forward.outcome).toBe('ROLLED_BACK');
        expect(forward.activation).toMatchObject({ kind: 'rollback', revisionId: two, revisionNumber: 2, previousRevisionId: one, reason: 'roll forward' });
        expect(await bases(root)).toEqual([two]);

        // Nothing earlier was rewritten: the revision files are the same bytes, and so are the first two records.
        const after = stored(root);
        expect(after.revisions).toEqual(before.revisions);
        for (const [name, bytes] of Object.entries(before.activations)) expect(after.activations[name]).toEqual(bytes);
        expect(Object.keys(after.activations)).toHaveLength(4);

        await editPhoto(catalog.photos[1].id, (photo) => {
            photo.caption = 'A caption revision 3 publishes.';
        });
        const third = await publishNow();
        expect(third).toMatchObject({ outcome: 'PUBLISHED', revisionNumber: 3 });
        expect(await statuses(root)).toEqual(['1:publish:committed:1', '2:publish:committed:2', '3:rollback:committed:1', '4:rollback:committed:2', '5:publish:committed:3']);
        // The third revision's parent is the one live when it was compiled.
        expect((await readRevisionFile(root, third.revisionId ?? ''))?.baseRevisionId).toBe(two);
    });

    it('takes a revision number from history or a revision ID, and only a revision that was active before', async () => {
        const context = await twoRevisions({ seed: 212 });
        const { root, one, two, editPhoto, catalog, publishNow } = context;
        expect(await planRollback({ dataRoot: root, to: { revisionNumber: 1 } })).toMatchObject({ outcome: 'READY', target: { revisionId: one, revisionNumber: 1 }, active: { revisionId: two, revisionNumber: 2 } });
        expect(await planRollback({ dataRoot: root, to: { revisionId: one } })).toMatchObject({ outcome: 'READY', target: { revisionId: one, revisionNumber: 1 } });
        expect(await planRollback({ dataRoot: root, to: { revisionNumber: 2 } })).toMatchObject({ outcome: 'NO_CHANGES', message: `revision 2 (${two}) is already active.` });
        const unknown = await planRollback({ dataRoot: root, to: { revisionNumber: 7 } });
        expect(unknown).toMatchObject({ outcome: 'NOT_ELIGIBLE', message: 'No revision 7 has been active. photos history lists the ones that have.' });
        expect(ROLLBACK_EXIT_CODES[unknown.outcome]).toBe(1);

        // A publish that crashed after writing its revision file leaves a revision that was never active.
        await editPhoto(catalog.photos[1].id, (photo) => {
            photo.caption = 'A caption that never goes live.';
        });
        const crashed = await publishNow({ hooks: { afterStep: (step) => { if (step === 9) throw new Error('crash after step 9'); } } });
        const never = crashed.candidateId ?? '';
        expect(fs.existsSync(revisionFilePath(root, never))).toBe(true);
        expect(await planRollback({ dataRoot: root, to: { revisionId: never } })).toMatchObject({ outcome: 'NOT_ELIGIBLE' });
        const files = stored(root);
        expect(await context.rollTo(never, two)).toMatchObject({ outcome: 'NOT_ELIGIBLE' });
        expect(stored(root)).toEqual(files);
    });

    it('refuses with NOTHING_ACTIVE before the first publish, writing nothing', async () => {
        const { catalog, root, rollTo } = await setup({ seed: 213 });
        expect(await planRollback({ dataRoot: root, to: { revisionNumber: 1 } })).toMatchObject({ outcome: 'NOTHING_ACTIVE' });
        expect((await rollTo(catalog.revisionId, catalog.revisionId)).outcome).toBe('NOTHING_ACTIVE');
        expect(fs.existsSync(catalogPaths(root).activationsDir)).toBe(false);
    });

    it.each([
        ['is missing', (file: string) => fs.rmSync(file), 'assets.variant', 'variants.w400.webp'],
        ['has the wrong size', (file: string) => fs.truncateSync(file, 10), 'assets.size', 'variants.w400.webp.bytes'],
    ])('refuses a target whose derivative %s, writing nothing', async (_label, damage, code, field) => {
        const { root, rollTo, one, two } = await twoRevisions({ seed: 214 });
        const photo = (await readRevisionFile(root, one))?.content.photos[0];
        if (!photo) throw new Error('Revision 1 has no photo.');
        damage(mediaFilePath({ photoId: photo.id, assetRevision: photo.assetRevision, profileId: photo.profileId }, 'w400', 'webp', root));
        const pointer = folderBytes(catalogPaths(root).active);
        const files = stored(root);

        const planned = await planRollback({ dataRoot: root, to: { revisionNumber: 1 } });
        expect(planned.outcome).toBe('VALIDATION_FAILED');
        expect(planned.message).toBe(`1 error keeps revision 1 (${one}) from going live again (${code}). Nothing was rolled back.`);
        expect(planned.blocking).toEqual([expect.objectContaining({ code, record: { kind: 'photo', id: photo.id }, field })]);
        const result = await rollTo(one, two);
        expect(result.outcome).toBe('VALIDATION_FAILED');
        expect(ROLLBACK_EXIT_CODES[result.outcome]).toBe(1);
        expect(folderBytes(catalogPaths(root).active)).toEqual(pointer);
        expect(stored(root)).toEqual(files);
    });

    it('refuses a target a privacy rule now fails: a caption that names a source file since renamed to it', async () => {
        const context = await setup({ seed: 215 });
        const { root, catalog, editPhoto, publishNow, rollTo } = context;
        const [named] = catalog.photos.map((photo) => photo.id);
        await editPhoto(named, (photo) => {
            photo.caption = 'Scanned from dsc-0042.jpg.';
        });
        const first = await publishNow();
        expect(first.outcome).toBe('PUBLISHED');
        await editPhoto(named, (photo) => {
            delete photo.caption;
        });
        const second = await publishNow();
        expect(second.outcome).toBe('PUBLISHED');
        // The source file is renamed to the name revision 1's caption holds.
        const registry = await readRegistry(root);
        registry.photos[named].source.path = 'dsc-0042.jpg';
        await writeRegistry(root, registry, registry.version);
        const files = stored(root);

        const result = await rollTo(first.revisionId ?? '', second.revisionId ?? '');
        expect(result.outcome).toBe('VALIDATION_FAILED');
        expect(result.message).toContain('(privacy.source-name)');
        expect(result.issues[0]).toMatchObject({ code: 'privacy.source-name', record: { kind: 'photo', id: named }, field: 'caption' });
        expect(await readActivePointer(root)).toMatchObject({ revisionId: second.revisionId });
        expect(stored(root)).toEqual(files);
    });

    it('rolls back to a target with only editorial errors, prints them, and records them as accepted', async () => {
        const { root, rollTo, one, two } = await twoRevisions({ seed: 216 });
        editorialErrorOn = one;
        const planned = await planRollback({ dataRoot: root, to: { revisionNumber: 1 } });
        expect(planned).toMatchObject({ outcome: 'READY', editorial: ['test.rollback-editorial'], blocking: [] });
        expect(planned.issues).toEqual([expect.objectContaining({ code: 'test.rollback-editorial', severity: 'error' })]);

        const result = await rollTo(one, two);
        expect(result.outcome).toBe('ROLLED_BACK');
        expect(result.activation).toMatchObject({ acceptedRules: ['test.rollback-editorial'], validation: { errors: 1 } });
        expect(await readActivePointer(root)).toMatchObject({ revisionId: one });
    });

    describe('when it is interrupted', () => {
        it('leaves the previous pointer valid after a crash before the pointer moves, shows the record as interrupted, and a retry finishes', async () => {
            const { root, rollTo, one, two } = await twoRevisions({ seed: 221 });
            const pointer = folderBytes(catalogPaths(root).active);
            const crashed = await rollTo(one, two, { hooks: { afterStep: (step) => { if (step === 10) throw new Error('crash after step 10'); } } });
            expect(crashed.outcome).toBe('STORAGE_ERROR');
            expect(crashed.message).toBe('crash after step 10. Nothing was rolled back.');
            expect(folderBytes(catalogPaths(root).active)).toEqual(pointer);
            expect(await readRevisionFile(root, two)).not.toBeNull();
            const pending = (await listActivations(root)).find((activation) => activation.status === 'pending');
            const history = await readHistory(root);
            expect(history.rows.map((row) => `${row.state}${row.live ? ':live' : ''}`)).toEqual(['committed', 'committed:live', 'interrupted']);
            expect(historyLines(history).join('\n')).toContain('Interrupted: it never moved the active pointer. The next publish or rollback sets it aside.');

            const retry = await rollTo(one, two);
            expect(retry).toMatchObject({ outcome: 'ROLLED_BACK', recovery: { abandoned: [pending?.activationId] } });
            expect(await statuses(root)).toEqual(['1:publish:committed:1', '2:publish:committed:2', '3:rollback:abandoned:1', '4:rollback:committed:1']);
        });

        it('counts a pending record the pointer names as live after a crash once the pointer moved, and the next publish records it and rebases', async () => {
            const { root, rollTo, publishNow, one, two } = await twoRevisions({ seed: 222 });
            const crashed = await rollTo(one, two, { hooks: { afterStep: (step) => { if (step === 11) throw new Error('crash after step 11'); } } });
            expect(crashed.outcome).toBe('STORAGE_ERROR');
            expect(crashed.message).toBe(`crash after step 11. ${one} is live, and the next publish or rollback finishes recording it.`);
            expect(await readActivePointer(root)).toMatchObject({ revisionId: one });
            const history = await readHistory(root);
            expect(history.rows.at(-1)).toMatchObject({ state: 'committed', unsettled: true, live: true, activation: { status: 'pending', kind: 'rollback' } });
            expect(historyLines(history).join('\n')).toContain('its record still says pending. The next publish or rollback records it as committed.');
            expect(await bases(root)).toEqual([two]);

            const next = await publishNow();
            expect(next).toMatchObject({ outcome: 'NO_CHANGES', revisionId: one, revisionNumber: 1 });
            expect(next.recovery?.committed).toBe(history.rows.at(-1)?.activation.activationId);
            expect(await bases(root)).toEqual([one]);
            expect(await statuses(root)).toEqual(['1:publish:committed:1', '2:publish:committed:2', '3:rollback:committed:1']);
        });

        it('leaves the rebase to the next publish after a crash once the activation is committed', async () => {
            const { root, rollTo, publishNow, one, two } = await twoRevisions({ seed: 223 });
            const crashed = await rollTo(one, two, { hooks: { afterStep: (step) => { if (step === 12) throw new Error('crash after step 12'); } } });
            expect(crashed.outcome).toBe('STORAGE_ERROR');
            expect(await bases(root)).toEqual([two]);
            const next = await publishNow();
            expect(next.outcome).toBe('NO_CHANGES');
            expect(next.recovery?.rebased?.rebased).toBeGreaterThan(0);
            expect(await bases(root)).toEqual([one]);
        });

        it('still rolls back when the working layer is busy, and the next publish rebases it', async () => {
            const { root, rollTo, publishNow, one, two } = await twoRevisions({ seed: 224 });
            const result = await withLock(AUTHORED_LOCK, { root }, () => rollTo(one, two, { authoredWaitMs: 50 }));
            expect(result).toMatchObject({ outcome: 'ROLLED_BACK', rebased: false });
            expect(result.message).toContain('The working layer was busy, so the next publish rebases it.');
            expect(await bases(root)).toEqual([two]);
            expect((await publishNow()).outcome).toBe('NO_CHANGES');
            expect(await bases(root)).toEqual([one]);
        });
    });

    describe('the catalog lock', () => {
        it('waits for a publish that holds it, then refuses with ACTIVE_CHANGED when that publish moved the active revision', async () => {
            const { catalog, root, rollTo, publishNow, editPhoto, one, two } = await twoRevisions({ seed: 231 });
            await editPhoto(catalog.photos[1].id, (photo) => {
                photo.caption = 'A caption revision 3 publishes.';
            });
            const paused = deferred();
            const resume = deferred();
            const publishing = publishNow({ hooks: { async afterStep(step) { if (step === 9) { paused.resolve(); await resume.promise; } } } });
            await paused.promise;
            const rolling = rollTo(one, two, { waitMs: 20_000 });
            await new Promise((done) => setTimeout(done, 300));
            resume.resolve();
            const [published, rolled] = await Promise.all([publishing, rolling]);
            expect(published).toMatchObject({ outcome: 'PUBLISHED', revisionNumber: 3 });
            expect(rolled.outcome).toBe('ACTIVE_CHANGED');
            expect(rolled.message).toMatch(/^revision 3 \(rev_[0-9a-f]{64}\) is active now, not rev_[0-9a-f]{64}, so the impact you confirmed is out of date\. Nothing was rolled back\./);
            expect(await statuses(root)).toEqual(['1:publish:committed:1', '2:publish:committed:2', '3:publish:committed:3']);
        });

        it('stops a publish that starts while it holds the lock, and that publish then finds the rollback live', async () => {
            const { rollTo, publishNow, one, two } = await twoRevisions({ seed: 232 });
            let blocked: PublishResult | null = null;
            const result = await rollTo(one, two, { hooks: { async afterStep(step) { if (step === 10) blocked = await publishNow(); } } });
            expect(result.outcome).toBe('ROLLED_BACK');
            expect(blocked).toMatchObject({ outcome: 'CATALOG_LOCKED' });
            const after = await publishNow();
            expect(after).toMatchObject({ outcome: 'NO_CHANGES', revisionId: one, revisionNumber: 1 });
        });

        it('names a live holder when it gives up waiting, and nothing breaks that lock', async () => {
            const { root, rollTo, one, two } = await twoRevisions({ seed: 233 });
            const result = await withLock(CATALOG_LOCK, { root }, async () => {
                const record = JSON.parse(fs.readFileSync(path.join(root, 'locks', `${CATALOG_LOCK}.lock`), 'utf8')) as LockRecord;
                return { rolled: await rollTo(one, two, { waitMs: 300 }), record };
            });
            expect(result.rolled.outcome).toBe('CATALOG_LOCKED');
            expect(ROLLBACK_EXIT_CODES[result.rolled.outcome]).toBe(3);
            expect(result.rolled.holder).toMatchObject({ owner: result.record.owner, pid: process.pid });
            expect(result.rolled.message).toContain(`Another command holds the catalog lock: ${result.record.owner} (pid ${process.pid} on `);
            expect(result.rolled.message).toMatch(/Its lease runs until \d{4}-\d\d-\d\dT[\d:.]+Z unless it renews it\. .* Nothing was rolled back\.$/);
            expect(await readActivePointer(root)).toMatchObject({ revisionId: two });
        });

        it('takes over a lease that expired, and records the takeover on the rollback', async () => {
            const { root, rollTo, events, one, two } = await twoRevisions({ seed: 234 });
            const stale: LockRecord = { owner: 'crashed-owner', hostname: 'old-host', pid: 999_999, acquiredAt: '2026-01-01T00:00:00.000Z', heartbeatAt: '2026-01-01T00:00:00.000Z', leaseMs: 60_000 };
            fs.writeFileSync(path.join(root, 'locks', `${CATALOG_LOCK}.lock`), `${JSON.stringify(stale)}\n`);
            const result = await rollTo(one, two, { waitMs: 0 });
            const takeover = { previousOwner: 'crashed-owner', previousAcquiredAt: stale.acquiredAt };
            expect(result.outcome).toBe('ROLLED_BACK');
            expect(result.activation?.lockTakeover).toEqual(takeover);
            expect(events).toContainEqual({ event: 'catalog.lock.takeover', lock: CATALOG_LOCK, ...takeover });
            expect(historyLines(await readHistory(root)).join('\n')).toContain('Took over the catalog lock from crashed-owner, held since 2026-01-01T00:00:00.000Z, after its lease expired');
        });
    });
});

describe('runRollbackCommand', { timeout: 60_000 }, () => {
    const args = (overrides: Partial<RollbackArgs> = {}): RollbackArgs => ({ to: { revisionNumber: 1 }, reason: 'roll back the caption', actor: 'curator', yes: false, ...overrides });

    it('prints the impact list, asks, and rolls back on yes against the active revision it showed', async () => {
        const { catalog, root, two, one } = await twoRevisions({ seed: 241 });
        const terminal = io(true);
        const code = await runRollbackCommand(root, args(), terminal);
        expect(code).toBe(0);
        expect(terminal.lines).toEqual(expect.arrayContaining([
            `[photos] READY: Ready to roll back from revision 2 (${two}) to revision 1 (${one}).`,
            `Active: ${two}, revision 2`,
            `Target: ${one}, revision 1`,
            `Changes 1 photo: ${catalog.photos[0].id}`,
            `[photos] ROLLED_BACK: Rolled back to revision 1 (${one}) from revision 2 (${two}).`,
        ]));
        expect(terminal.asked).toEqual(['Roll back to revision 1? Type yes to confirm: ']);
        expect(terminal.errors).toEqual([]);
        expect((await listActivations(root)).at(-1)).toMatchObject({ kind: 'rollback', actor: 'curator', reason: 'roll back the caption', revisionNumber: 1 });
    });

    it('lists the series and photos a rollback brings back and removes', async () => {
        const context = await setup({ seed: 242, photos: 4, series: [{ id: 'ser_first', title: 'Fixture First', photos: 2 }, { id: 'ser_second', title: 'Fixture Second', photos: 2 }] });
        const { root, publishNow } = context;
        const first = await publishNow();
        const series = (await readWorkingLayer(root)).series.find((entry) => entry.id === 'ser_second');
        if (!series) throw new Error('No ser_second.');
        await writeAuthoredRecord({ ...series, visibility: 'draft' }, { expectedVersion: series.version, root });
        const second = await publishNow();
        expect(second.outcome, second.message).toBe('PUBLISHED');
        const removed = (await readRevisionFile(root, first.revisionId ?? ''))?.content.series.find((entry) => entry.id === 'ser_second')?.photoIds ?? [];

        const terminal = io(false);
        expect(await runRollbackCommand(root, args(), terminal)).toBe(3);
        expect(terminal.lines).toEqual(expect.arrayContaining([
            'Brings back 1 series: ser_second "Fixture Second"',
            `Brings back 2 photos: ${[...removed].sort().join(', ')}`,
        ]));
        expect(terminal.errors).toEqual(['[photos] DECLINED: Nothing was rolled back.']);
        expect(await readActivePointer(root)).toMatchObject({ revisionId: second.revisionId });
    });

    it('needs a terminal or --yes with --expect-active, and refuses an --expect-active that is out of date', async () => {
        const { root, one, two } = await twoRevisions({ seed: 243 });
        const files = stored(root);
        const headless = io(null);
        expect(await runRollbackCommand(root, args(), headless)).toBe(3);
        expect(headless.errors).toEqual([`[photos] CONFIRMATION_REQUIRED: A rollback needs confirmation. Run it in a terminal to answer, or run it again with --yes --expect-active ${two} to roll back exactly this. --expect-active stops it if another revision goes live first.`]);

        const stale = io(null);
        expect(await runRollbackCommand(root, args({ yes: true, expectActive: one }), stale)).toBe(3);
        expect(stale.errors.at(-1)).toMatch(/^\[photos\] ACTIVE_CHANGED: /);
        expect(stored(root)).toEqual(files);

        const confirmed = io(null);
        expect(await runRollbackCommand(root, args({ yes: true, expectActive: two }), confirmed)).toBe(0);
        expect(await readActivePointer(root)).toMatchObject({ revisionId: one });
    });

    it('refuses when another revision went live while the curator was answering', async () => {
        const context = await twoRevisions({ seed: 244 });
        const { catalog, root, editPhoto, publishNow } = context;
        await editPhoto(catalog.photos[1].id, (photo) => {
            photo.caption = 'A caption revision 3 publishes.';
        });
        const terminal = io(true, async () => {
            expect((await publishNow()).outcome).toBe('PUBLISHED');
        });
        expect(await runRollbackCommand(root, args(), terminal)).toBe(3);
        expect(terminal.errors.at(-1)).toMatch(/^\[photos\] ACTIVE_CHANGED: revision 3 \(rev_[0-9a-f]{64}\) is active now/);
        expect((await listActivations(root)).map((activation) => activation.kind)).toEqual(['publish', 'publish', 'publish']);
    });
});

describe('fix round 1', { timeout: 60_000 }, () => {
    const args = (overrides: Partial<RollbackArgs> = {}): RollbackArgs => ({ to: { revisionNumber: 1 }, reason: 'roll back', actor: 'curator', yes: false, ...overrides });

    it('rolls back off a live revision whose file is damaged, listing everything the target publishes', async () => {
        const { root, one, two } = await twoRevisions({ seed: 251 });
        fs.writeFileSync(revisionFilePath(root, two), '{ not json');
        const planned = await planRollback({ dataRoot: root, to: { revisionNumber: 1 } });
        expect(planned).toMatchObject({ outcome: 'READY', target: { revisionId: one }, active: { revisionId: two }, activeProblem: `catalog/revisions/${two}.json is not valid JSON` });
        const target = await readRevisionFile(root, one);
        const terminal = io(true);
        expect(await runRollbackCommand(root, args(), terminal)).toBe(0);
        expect(terminal.lines).toEqual(expect.arrayContaining([
            `The live revision can't be read (catalog/revisions/${two}.json is not valid JSON), so this lists everything the target publishes.`,
            `Publishes 1 series: ${target?.content.series.map((series) => `${series.id} "${series.title}"`).join(', ')}`,
            `Publishes 4 photos: ${target?.content.photos.map((photo) => photo.id).sort().join(', ')}`,
            `[photos] ROLLED_BACK: Rolled back to revision 1 (${one}) from revision 2 (${two}).`,
        ]));
        expect(terminal.asked).toHaveLength(1);
        expect(await readActivePointer(root)).toMatchObject({ revisionId: one });
    });

    it('still needs --expect-active with --yes when the live revision is damaged', async () => {
        const { root, two } = await twoRevisions({ seed: 260 });
        fs.writeFileSync(revisionFilePath(root, two), '{ not json');
        const headless = io(null);
        expect(await runRollbackCommand(root, args(), headless)).toBe(3);
        expect(headless.errors.at(-1)).toMatch(/^\[photos\] CONFIRMATION_REQUIRED: /);
        expect(await readActivePointer(root)).toMatchObject({ revisionId: two });
        expect(() => rollbackArgs(['--to', '1', '--reason', 'r', '--actor', 'a', '--yes'])).toThrow(/--yes needs --expect-active/);
    });

    it('settles a rollback that crashed after the pointer moved when it runs again: the record is committed and the working layer rebased', async () => {
        const { root, rollTo, one, two } = await twoRevisions({ seed: 252 });
        const crashed = await rollTo(one, two, { hooks: { afterStep: (step) => { if (step === 11) throw new Error('crash after step 11'); } } });
        expect(crashed.outcome).toBe('STORAGE_ERROR');
        expect(await bases(root)).toEqual([two]);

        const terminal = io(null);
        expect(await runRollbackCommand(root, args(), terminal)).toBe(0);
        expect(terminal.errors).toEqual([]);
        expect(terminal.lines).toEqual(expect.arrayContaining([
            `[photos] NO_CHANGES: revision 1 (${one}) is already active. Recorded the interrupted activation as committed, and rebased the working layer onto it.`,
        ]));
        expect(await statuses(root)).toEqual(['1:publish:committed:1', '2:publish:committed:2', '3:rollback:committed:1']);
        expect(await bases(root)).toEqual([one]);
    });

    it('settles a rollback that crashed after it committed when it runs again: the working layer is rebased', async () => {
        const { root, rollTo, one, two } = await twoRevisions({ seed: 253 });
        await rollTo(one, two, { hooks: { afterStep: (step) => { if (step === 12) throw new Error('crash after step 12'); } } });
        expect(await bases(root)).toEqual([two]);
        const again = await rollTo(one, one);
        expect(again.outcome).toBe('NO_CHANGES');
        expect(again.message).toBe(`revision 1 (${one}) is already active. Rebased the working layer onto it.`);
        expect(await bases(root)).toEqual([one]);
    });

    it.skipIf(process.getuid?.() === 0)('names a file it can\'t read relative to the data root, as STORAGE_ERROR, in a plan and in history', async () => {
        const { root } = await twoRevisions({ seed: 254 });
        const dir = catalogPaths(root).activationsDir;
        fs.chmodSync(dir, 0o000);
        cleanups.push(async () => fs.chmodSync(dir, 0o700));
        const planned = await planRollback({ dataRoot: root, to: { revisionNumber: 1 } });
        expect(planned.outcome).toBe('STORAGE_ERROR');
        expect(planned.message).toBe('EACCES on catalog/activations. Nothing was rolled back.');
        expect(await runHistoryCommand(root)).toEqual({ exitCode: 4, output: '[photos] STORAGE_ERROR: EACCES on catalog/activations.\n' });
    });

    it('says the target is live when a failure after the pointer moved is a damaged file', async () => {
        const { rollTo, one, two } = await twoRevisions({ seed: 255 });
        const result = await rollTo(one, two, { hooks: { afterStep: (step) => { if (step === 12) throw new CatalogIntegrityError('catalog/revisions/x.json', 'catalog/revisions/x.json is damaged.'); } } });
        expect(result.outcome).toBe('INTEGRITY_MISMATCH');
        expect(result.message).toBe(`catalog/revisions/x.json is damaged. ${one} is live, and the next publish or rollback finishes recording it.`);
    });

    it('prints a lease end the lock\'s lease cap allows, not the longer one a holder claims', async () => {
        const { root, rollTo, one, two } = await twoRevisions({ seed: 256 });
        const heartbeat = new Date();
        const claimed: LockRecord = { owner: 'greedy-owner', hostname: 'host', pid: 1, acquiredAt: heartbeat.toISOString(), heartbeatAt: heartbeat.toISOString(), leaseMs: 24 * 60 * 60_000 };
        fs.writeFileSync(path.join(root, 'locks', `${CATALOG_LOCK}.lock`), `${JSON.stringify(claimed)}\n`);
        const result = await rollTo(one, two, { waitMs: 100 });
        expect(result.outcome).toBe('CATALOG_LOCKED');
        expect(result.message).toContain(`Its lease runs until ${new Date(heartbeat.getTime() + MAX_LEASE_MS).toISOString()} unless it renews it.`);
    });

    it('refuses a revision whose publish crashed after writing its pending record, which never went live', async () => {
        const { catalog, root, rollTo, publishNow, editPhoto, two } = await twoRevisions({ seed: 257 });
        await editPhoto(catalog.photos[1].id, (photo) => {
            photo.caption = 'A caption that never goes live.';
        });
        const crashed = await publishNow({ hooks: { afterStep: (step) => { if (step === 10) throw new Error('crash after step 10'); } } });
        const never = crashed.candidateId ?? '';
        expect((await listActivations(root)).at(-1)).toMatchObject({ status: 'pending', revisionId: never });
        const files = stored(root);
        expect(await planRollback({ dataRoot: root, to: { revisionId: never } })).toMatchObject({ outcome: 'NOT_ELIGIBLE' });
        expect(await planRollback({ dataRoot: root, to: { revisionNumber: 3 } })).toMatchObject({ outcome: 'NOT_ELIGIBLE' });
        expect(await rollTo(never, two)).toMatchObject({ outcome: 'NOT_ELIGIBLE' });
        expect(stored(root)).toEqual(files);
        expect(await readActivePointer(root)).toMatchObject({ revisionId: two });
    });

    it('lists the series and photos a rollback removes', async () => {
        const context = await setup({ seed: 258, photos: 4, series: [{ id: 'ser_first', title: 'Fixture First', photos: 2 }, { id: 'ser_second', title: 'Fixture Second', photos: 2, visibility: 'draft' }] });
        const { root, publishNow } = context;
        const first = await publishNow();
        expect(first.outcome, first.message).toBe('PUBLISHED');
        const series = (await readWorkingLayer(root)).series.find((entry) => entry.id === 'ser_second');
        if (!series) throw new Error('No ser_second.');
        await writeAuthoredRecord({ ...series, visibility: 'published' }, { expectedVersion: series.version, root });
        const second = await publishNow();
        expect(second.outcome, second.message).toBe('PUBLISHED');
        const added = (await readRevisionFile(root, second.revisionId ?? ''))?.content.series.find((entry) => entry.id === 'ser_second')?.photoIds ?? [];
        expect(added).toHaveLength(2);

        const terminal = io(false);
        expect(await runRollbackCommand(root, args(), terminal)).toBe(3);
        expect(terminal.lines).toEqual(expect.arrayContaining([
            'Removes 1 series: ser_second "Fixture Second"',
            `Removes 2 photos: ${[...added].sort().join(', ')}`,
        ]));
    });

    it('waits for a held catalog lock by default instead of giving up at once', async () => {
        const { root, rollTo, one, two } = await twoRevisions({ seed: 259 });
        const held = deferred();
        const release = deferred();
        const holding = withLock(CATALOG_LOCK, { root }, async () => {
            held.resolve();
            await release.promise;
        });
        await held.promise;
        const rolling = rollTo(one, two);
        setTimeout(() => release.resolve(), 300);
        await holding;
        expect((await rolling).outcome).toBe('ROLLED_BACK');
    });

    it('reads a pending record as interrupted when the pointer names its activation ID but another revision', () => {
        const pending = { activationId: 'act_a', revisionId: 'rev_one', status: 'pending', revisionNumber: 3 } as unknown as Activation;
        const pointer = { activationId: 'act_a', revisionId: 'rev_two' } as unknown as ActivePointer;
        expect(historyState(pending, pointer)).toEqual({ state: 'interrupted', unsettled: false });
        expect(historyState(pending, { ...pointer, revisionId: 'rev_one' })).toEqual({ state: 'committed', unsettled: true });
        expect(knownGood([pending], pointer).size).toBe(0);
    });
});
