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
import { CATALOG_LEASE_MS, publish, type PublishOptions, type PublishResult } from '../publish';
import { CATALOG_LOCK, CatalogIntegrityError, listActivations, readRevisionFile, revisionFilePath } from '../repository';
import { acceptanceCheck, planRollback, rollback, ROLLBACK_EXIT_CODES, type RollbackOptions, type RollbackResult } from '../rollback';
import { registerRule } from '../rules';
import { createTestCatalog, type TestCatalog, type TestCatalogOptions } from '../testing';
import type { Activation, ActivePointer, AuthoredPhoto } from '../types';
import { AUTHORED_LOCK, writeAuthoredRecord } from '../working-layer-writer';
import { authoredPaths, catalogPaths, readActivePointer, readWorkingLayer } from '../working-layer';
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

/** A second editorial rule, so a target can carry two and a rollback accept only one. */
let secondEditorialOn: string | null = null;
registerRule({
    id: 'test.rollback-editorial-b',
    version: 1,
    severity: 'error',
    gate: 'publish',
    rollbackClass: 'editorial',
    check: (ctx) => (secondEditorialOn !== null && ctx.authored === null && ctx.active?.revisionId === secondEditorialOn
        ? [{ record: { kind: 'site', id: 'site' }, field: 'featuredSeriesIds', message: 'A second test editorial error.' }]
        : []),
});

afterEach(async () => {
    editorialErrorOn = null;
    secondEditorialOn = null;
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

    /** Everything a refused rollback must leave as it was: the catalog (activations, pointer, revisions), the working layer, and the locks. */
    const untouched = (root: string) => ({ catalog: folderBytes(catalogPaths(root).dir), authored: folderBytes(authoredPaths(root).dir), locks: folderBytes(path.join(root, 'locks')) });

    it('refuses anything unaccepted even on a plan with no target, and calls a READY plan without one an error', () => {
        const revisionId = `rev_${'a'.repeat(64)}`;
        const ready = { outcome: 'READY' as const, message: '', target: null, active: null, impact: null, seriesTitles: {}, issues: [], blocking: [], editorial: ['accent.contrast'] };
        expect(acceptanceCheck(ready, [], revisionId)).toEqual({
            outcome: 'ACCEPTANCE_REQUIRED',
            unaccepted: ['accent.contrast'],
            message: `${revisionId} has editorial errors a rollback brings back only when you accept each one: accent.contrast. Run it again with --accept accent.contrast. Nothing was rolled back.`,
        });
        expect(acceptanceCheck(ready, ['accent.contrast'], revisionId)).toMatchObject({ outcome: 'STORAGE_ERROR', message: expect.stringContaining('names no target') });
        const target = { revisionId, revisionNumber: 4 };
        expect(acceptanceCheck({ ...ready, target }, ['accent.contrast'], revisionId)).toBeNull();
        expect(acceptanceCheck({ ...ready, target }, [], revisionId)).toMatchObject({ outcome: 'ACCEPTANCE_REQUIRED', message: expect.stringMatching(/^Revision 4 \(rev_a+\) has editorial errors/) });
    });

    it('refuses a target with editorial errors nobody accepted, ACCEPTANCE_REQUIRED, exit 1, writing nothing', async () => {
        const { root, rollTo, one, two, events } = await twoRevisions({ seed: 216 });
        editorialErrorOn = one;
        const planned = await planRollback({ dataRoot: root, to: { revisionNumber: 1 } });
        // The plan stays READY, with its editorial list, so History keeps Restore and the dialog asks for each one.
        expect(planned).toMatchObject({ outcome: 'READY', editorial: ['test.rollback-editorial'], blocking: [] });
        expect(planned.issues).toEqual([expect.objectContaining({ code: 'test.rollback-editorial', severity: 'error' })]);
        const before = untouched(root);

        const result = await rollTo(one, two);
        expect(result).toMatchObject({ outcome: 'ACCEPTANCE_REQUIRED', activation: null, unaccepted: ['test.rollback-editorial'] });
        expect(result.message).toBe(`Revision 1 (${one}) has editorial errors a rollback brings back only when you accept each one: test.rollback-editorial. Run it again with --accept test.rollback-editorial. Nothing was rolled back.`);
        expect(ROLLBACK_EXIT_CODES[result.outcome]).toBe(1);
        expect(untouched(root)).toEqual(before);
        expect(await readActivePointer(root)).toMatchObject({ revisionId: two });
        expect(events.find((event) => event.event === 'catalog.rollback.started')).toMatchObject({ acceptedRules: [] });
        expect(events.find((event) => event.event === 'catalog.rollback.failed')).toMatchObject({ outcome: 'ACCEPTANCE_REQUIRED', unaccepted: ['test.rollback-editorial'] });
    });

    it('rolls back once the editorial error is accepted, and records exactly the flagged rules', async () => {
        const { root, rollTo, one, two, events } = await twoRevisions({ seed: 217 });
        editorialErrorOn = one;
        const result = await rollTo(one, two, { acceptedRules: ['test.rollback-editorial'] });
        expect(result.outcome).toBe('ROLLED_BACK');
        expect(result.activation).toMatchObject({ acceptedRules: ['test.rollback-editorial'], validation: { errors: 1 } });
        expect(await readActivePointer(root)).toMatchObject({ revisionId: one });
        expect(events.find((event) => event.event === 'catalog.rollback.started')).toMatchObject({ acceptedRules: ['test.rollback-editorial'] });
        expect(events.find((event) => event.event === 'catalog.rollback.activated')).toMatchObject({ acceptedRules: ['test.rollback-editorial'] });
    });

    it('refuses with two editorial errors and one accepted, naming the other, writing nothing', async () => {
        const { root, rollTo, one, two } = await twoRevisions({ seed: 218 });
        editorialErrorOn = one;
        secondEditorialOn = one;
        expect((await planRollback({ dataRoot: root, to: { revisionNumber: 1 } })).editorial).toEqual(['test.rollback-editorial', 'test.rollback-editorial-b']);
        const before = untouched(root);
        const result = await rollTo(one, two, { acceptedRules: ['test.rollback-editorial'] });
        expect(result).toMatchObject({ outcome: 'ACCEPTANCE_REQUIRED', unaccepted: ['test.rollback-editorial-b'] });
        expect(result.message).toContain('accept each one: test.rollback-editorial-b. Run it again with --accept test.rollback-editorial-b.');
        expect(untouched(root)).toEqual(before);

        const both = await rollTo(one, two, { acceptedRules: ['test.rollback-editorial-b', 'test.rollback-editorial'] });
        expect(both.outcome).toBe('ROLLED_BACK');
        expect(both.activation?.acceptedRules).toEqual(['test.rollback-editorial', 'test.rollback-editorial-b']);
    });

    it("doesn't record an accept for a rule that isn't flagged", async () => {
        const { rollTo, one, two } = await twoRevisions({ seed: 219 });
        editorialErrorOn = one;
        const result = await rollTo(one, two, { acceptedRules: ['test.rollback-editorial', 'test.rollback-editorial-b', 'accent.format'] });
        expect(result.outcome).toBe('ROLLED_BACK');
        expect(result.activation?.acceptedRules).toEqual(['test.rollback-editorial']);
        // A target with nothing flagged records no accepts at all.
        const back = await rollTo(two, one, { acceptedRules: ['accent.format'] });
        expect(back.outcome).toBe('ROLLED_BACK');
        expect(back.activation?.acceptedRules).toEqual([]);
    });

    it('still refuses an integrity error with VALIDATION_FAILED, whatever it accepts', async () => {
        const { root, rollTo, one, two } = await twoRevisions({ seed: 220 });
        editorialErrorOn = one;
        const photo = (await readRevisionFile(root, one))?.content.photos[0];
        if (!photo) throw new Error('Revision 1 has no photo.');
        fs.rmSync(mediaFilePath({ photoId: photo.id, assetRevision: photo.assetRevision, profileId: photo.profileId }, 'w400', 'webp', root));
        const before = untouched(root);
        const result = await rollTo(one, two, { acceptedRules: ['test.rollback-editorial', 'assets.variant'] });
        expect(result.outcome).toBe('VALIDATION_FAILED');
        expect(result.message).toContain('(assets.variant)');
        expect(untouched(root)).toEqual(before);
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
    const args = (overrides: Partial<RollbackArgs> = {}): RollbackArgs => ({ to: { revisionNumber: 1 }, reason: 'roll back the caption', actor: 'curator', accept: [], yes: false, ...overrides });

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
    const args = (overrides: Partial<RollbackArgs> = {}): RollbackArgs => ({ to: { revisionNumber: 1 }, reason: 'roll back', actor: 'curator', accept: [], yes: false, ...overrides });

    it('rolls back off a live revision whose file is damaged, listing everything the target publishes', async () => {
        const { catalog, root, one, two } = await twoRevisions({ seed: 251 });
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
            `[photos] ROLLED_BACK: Rolled back to revision 1 (${one}) from revision 2 (${two}). The rebase raised 1 working-layer conflict, so the next publish stops until it's settled.`,
        ]));
        expect(terminal.asked).toHaveLength(1);
        expect(terminal.lines).toContain(`Conflict: photo ${catalog.photos[0].id} caption`);
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

describe('fix round 2', { timeout: 60_000 }, () => {
    const args = (overrides: Partial<RollbackArgs> = {}): RollbackArgs => ({ to: { revisionNumber: 1 }, reason: 'roll back', actor: 'curator', accept: [], yes: false, ...overrides });

    it('names a damaged registry relative to the data root', async () => {
        const { root } = await twoRevisions({ seed: 261 });
        const registryDir = path.join(root, 'identity', 'registry');
        const newest = fs.readdirSync(registryDir).filter((name) => /^v\d+\.json$/.test(name)).sort((a, b) => Number(b.slice(1, -5)) - Number(a.slice(1, -5)))[0];
        fs.writeFileSync(path.join(registryDir, newest), '{ not json');
        const planned = await planRollback({ dataRoot: root, to: { revisionNumber: 1 } });
        expect(planned.outcome).toBe('STORAGE_ERROR');
        expect(planned.message).toContain(`identity/registry/${newest} is not a valid document`);
        expect(planned.message).not.toContain(root);
        expect(planned.message).not.toContain(fs.realpathSync(root));
    });

    it('prints a lease end from its own lease when the holder\'s record claims none', async () => {
        const { root, rollTo, one, two } = await twoRevisions({ seed: 262 });
        const heartbeat = new Date();
        const record = { owner: 'old-owner', hostname: 'host', pid: 1, acquiredAt: heartbeat.toISOString(), heartbeatAt: heartbeat.toISOString() };
        fs.writeFileSync(path.join(root, 'locks', `${CATALOG_LOCK}.lock`), `${JSON.stringify(record)}\n`);
        const result = await rollTo(one, two, { waitMs: 100 });
        expect(result.outcome).toBe('CATALOG_LOCKED');
        expect(result.message).toContain(`Its lease runs until ${new Date(heartbeat.getTime() + CATALOG_LEASE_MS).toISOString()} unless it renews it.`);
    });

    it('says nothing was settled, without mentioning a confirmation, when another revision went live before a rerun took the lock', async () => {
        const { rollTo, one, two } = await twoRevisions({ seed: 263 });
        const result = await rollTo(one, one);
        expect(result.outcome).toBe('ACTIVE_CHANGED');
        expect(result.message).toBe(`revision 2 (${two}) went live since ${one} was checked, so nothing was settled or rolled back. Run the rollback again to see what it would change now.`);
    });

    it('prints the Active and Target lines when a rerun settles, and says it committed the record when the working layer is busy', async () => {
        const { root, rollTo, one, two } = await twoRevisions({ seed: 264 });
        await rollTo(one, two, { hooks: { afterStep: (step) => { if (step === 11) throw new Error('crash after step 11'); } } });
        const terminal = io(null);
        const code = await withLock(AUTHORED_LOCK, { root }, () => runRollbackCommand(root, args(), terminal, { authoredWaitMs: 50 }));
        expect(code).toBe(0);
        expect(terminal.lines).toEqual([
            `[photos] NO_CHANGES: revision 1 (${one}) is already active. Recorded the interrupted activation as committed. The working layer was busy, so the next publish rebases it.`,
            `Active: ${one}, revision 1`,
            `Target: ${one}, revision 1`,
        ]);
        expect(await statuses(root)).toEqual(['1:publish:committed:1', '2:publish:committed:2', '3:rollback:committed:1']);
        expect(await bases(root)).toEqual([two]);
    });
});

describe('after a rollback off a damaged live revision', { timeout: 60_000 }, () => {
    it('blocks the next publish on a conflict instead of bringing the damaged revision\'s caption back', async () => {
        const { catalog, root, rollTo, publishNow, editPhoto, one, two } = await twoRevisions({ seed: 271 });
        const captioned = catalog.photos[0].id;
        const secondCaption = 'A caption revision 2 publishes.';
        fs.writeFileSync(revisionFilePath(root, two), '{ not json');

        const rolled = await rollTo(one, two);
        expect(rolled.outcome).toBe('ROLLED_BACK');
        expect(await readActivePointer(root)).toMatchObject({ revisionId: one });
        // The working record can't be compared with the damaged base, so its caption stays only as a conflict to settle.
        const record = (await readWorkingLayer(root)).photos.find((photo) => photo.id === captioned);
        expect(record?.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'caption' })]));

        // The result says so, rather than reading as a clean rollback.
        const layer = await readWorkingLayer(root);
        const conflicts = [layer.site, ...layer.series, ...layer.photos].reduce((total, entry) => total + (entry?.conflicts?.length ?? 0), 0);
        expect(conflicts).toBeGreaterThan(0);
        expect(rolled.conflicts).toHaveLength(conflicts);
        expect(rolled.message).toBe(`Rolled back to revision 1 (${one}) from revision 2 (${two}). The rebase raised ${conflicts} working-layer ${conflicts === 1 ? 'conflict' : 'conflicts'}, so the next publish stops until ${conflicts === 1 ? "it's" : "they're"} settled.`);

        // An unrelated edit, then a publish.
        await editPhoto(catalog.photos[1].id, (photo) => {
            photo.caption = 'An unrelated caption after the rollback.';
        });
        const activations = await listActivations(root);
        const result = await publishNow();
        expect(result.outcome).toBe('VALIDATION_FAILED');
        expect(result.issues).toContainEqual(expect.objectContaining({ code: 'working.conflicts', record: { kind: 'photo', id: captioned }, field: 'caption' }));
        expect(await readActivePointer(root)).toMatchObject({ revisionId: one });
        expect(await listActivations(root)).toEqual(activations);
        // No revision but the damaged one ever held revision 2's caption.
        for (const name of fs.readdirSync(catalogPaths(root).revisionsDir).filter((entry) => entry !== `${two}.json`)) {
            expect(fs.readFileSync(path.join(catalogPaths(root).revisionsDir, name), 'utf8')).not.toContain(secondCaption);
        }
    });
});

describe('a slug rename (#5)', { timeout: 60_000 }, () => {
    /** Give the fixture's one series a new slug and aliases in the working layer. Returns its old slug. */
    async function readdress(root: string, slug: string, slugAliases: (old: string) => string[]): Promise<string> {
        const record = (await readWorkingLayer(root)).series[0];
        if (!record) throw new Error('The fixture has no series');
        await writeAuthoredRecord({ ...structuredClone(record), slug, slugAliases: slugAliases(record.slug) }, { expectedVersion: record.version, root });
        return record.slug;
    }

    it('refuses a publish that drops the old slug, and takes it with the old slug as an alias', async () => {
        const { root, publishNow } = await setup({ seed: 260 });
        const first = await publishNow();
        expect(first.outcome).toBe('PUBLISHED');
        const old = await readdress(root, 'fixture-renamed', () => []);
        const refused = await publishNow();
        expect(refused.outcome).toBe('VALIDATION_FAILED');
        expect(refused.issues).toContainEqual(expect.objectContaining({ code: 'route.slug-change', severity: 'error', field: 'slug', message: expect.stringContaining(`from /work/${old} to /work/fixture-renamed`) }));
        expect(await readActivePointer(root)).toMatchObject({ revisionId: first.revisionId });

        await readdress(root, 'fixture-renamed', () => [old]);
        expect(await publishNow()).toMatchObject({ outcome: 'PUBLISHED', revisionNumber: 2 });
    });

    it("rolls back across it only with an accept, as an editorial rule and never an integrity one, and photos rollback exits 1 without it", async () => {
        const { root, publishNow, rollTo } = await setup({ seed: 261 });
        const one = (await publishNow()).revisionId ?? '';
        const old = await readdress(root, 'fixture-renamed', (slug) => [slug]);
        const two = (await publishNow()).revisionId ?? '';

        // Revision 1 has the old slug and no alias for the new one, so going back drops /work/fixture-renamed.
        const planned = await planRollback({ dataRoot: root, to: { revisionNumber: 1 } });
        expect(planned).toMatchObject({ outcome: 'READY', editorial: ['route.slug-change'], blocking: [] });
        expect(planned.issues).toEqual([expect.objectContaining({ code: 'route.slug-change', field: 'slug', message: expect.stringContaining(`from /work/fixture-renamed to /work/${old}`) })]);

        const headless = io(null);
        const code = await runRollbackCommand(root, { to: { revisionNumber: 1 }, reason: 'undo the rename', actor: 'curator', accept: [], yes: true, expectActive: two }, headless);
        expect(code).toBe(1);
        const printed = [...headless.lines, ...headless.errors].join('\n');
        expect(printed).toContain('--accept route.slug-change');
        // A stored revision can't be edited, so the hint is the accept, not the publish fix.
        expect(printed).toContain('    A rollback brings this back only once you accept it: --accept route.slug-change with photos rollback, or its box in Restore on the Publish screen.');
        expect(printed).not.toContain('to slugAliases with photos edit');
        expect(await readActivePointer(root)).toMatchObject({ revisionId: two });

        const back = await rollTo(one, two, { acceptedRules: ['route.slug-change'] });
        expect(back.outcome).toBe('ROLLED_BACK');
        expect(back.activation).toMatchObject({ revisionId: one, acceptedRules: ['route.slug-change'], validation: { errors: 1 } });
    });

    it('refuses a second rename that keeps only the newest old slug', async () => {
        const { root, publishNow } = await setup({ seed: 263 });
        await publishNow();
        const first = await readdress(root, 'fixture-renamed', (slug) => [slug]);
        expect((await publishNow()).outcome).toBe('PUBLISHED');
        await readdress(root, 'fixture-renamed-again', () => ['fixture-renamed']);
        const refused = await publishNow();
        expect(refused.outcome).toBe('VALIDATION_FAILED');
        expect(refused.issues).toContainEqual(expect.objectContaining({ code: 'route.slug-change', field: 'slugAliases', message: expect.stringContaining(`drops /work/${first}`) }));
        await readdress(root, 'fixture-renamed-again', () => [first, 'fixture-renamed']);
        expect((await publishNow()).outcome).toBe('PUBLISHED');
    });

    it("doesn't flag a rollback whose target keeps every live slug", async () => {
        const { root, publishNow, rollTo } = await setup({ seed: 262 });
        await publishNow();
        const old = await readdress(root, 'fixture-renamed', (slug) => [slug]);
        const two = (await publishNow()).revisionId ?? '';
        // Back to the old slug, keeping the new one as an alias: nothing breaks, so nothing asks.
        await readdress(root, old, () => ['fixture-renamed']);
        const three = (await publishNow()).revisionId ?? '';
        const forward = await planRollback({ dataRoot: root, to: { revisionNumber: 2 } });
        expect(forward).toMatchObject({ outcome: 'READY', editorial: [] });
        expect((await rollTo(two, three)).outcome).toBe('ROLLED_BACK');
    });
});

/**
 * #181's fault matrix, the steps the tests above don't reach: a fault after
 * the lock, after eligibility, and at unlock; the pointer's temp written but
 * not linked, a crash just after the link, and ENOSPC on the pointer write,
 * through the pointer-write seam; and a rollback on top of a crashed
 * publish's pending record. Each leaves the activations, the pointer and the
 * working layer byte-identical, or recoverable on the next run.
 */
describe('the fault matrix (#181)', { timeout: 60_000 }, () => {
    /** The activations, the pointer, and the working layer. */
    const state = (root: string) => ({ activations: folderBytes(catalogPaths(root).activationsDir), pointer: folderBytes(catalogPaths(root).active), authored: folderBytes(authoredPaths(root).dir) });
    const lockFile = (root: string) => path.join(root, 'locks', `${CATALOG_LOCK}.lock`);
    const crash = (where: string) => () => {
        throw new Error(`crash ${where}`);
    };

    it('a fault after it takes the lock writes nothing, releases the lock, and the next run rolls back', async () => {
        const { root, rollTo, one, two } = await twoRevisions({ seed: 281 });
        const before = state(root);
        const crashed = await rollTo(one, two, { hooks: { afterLock: crash('after the lock') } });
        expect(crashed).toMatchObject({ outcome: 'STORAGE_ERROR', message: 'crash after the lock. Nothing was rolled back.', activation: null });
        expect(state(root)).toEqual(before);
        expect(fs.existsSync(lockFile(root))).toBe(false);
        expect((await rollTo(one, two)).outcome).toBe('ROLLED_BACK');
    });

    it('a fault after eligibility, before the pending record, writes nothing, and the next run rolls back', async () => {
        const { root, rollTo, one, two } = await twoRevisions({ seed: 282 });
        const before = state(root);
        let planned: unknown = null;
        const crashed = await rollTo(one, two, { hooks: { afterEligibility: (plan) => { planned = plan.outcome; throw new Error('crash after eligibility'); } } });
        expect(planned).toBe('READY');
        expect(crashed).toMatchObject({ outcome: 'STORAGE_ERROR', message: 'crash after eligibility. Nothing was rolled back.' });
        expect(state(root)).toEqual(before);
        expect(fs.existsSync(lockFile(root))).toBe(false);
        expect((await rollTo(one, two)).outcome).toBe('ROLLED_BACK');
    });

    it('a fault at unlock still reports the finished rollback, and the next command takes the lock once its lease runs out', async () => {
        const { root, rollTo, events, one, two } = await twoRevisions({ seed: 283 });
        const result = await rollTo(one, two, { leaseMs: 400, hooks: { lock: { beforeRelease: crash('at unlock') } } });
        expect(result.outcome).toBe('ROLLED_BACK');
        expect(ROLLBACK_EXIT_CODES[result.outcome]).toBe(0);
        expect(result.message).toBe(`Rolled back to revision 1 (${one}) from revision 2 (${two}). The catalog lock couldn't be released (crash at unlock), so the next publish or rollback may wait until its lease runs out.`);
        expect(await statuses(root)).toEqual(['1:publish:committed:1', '2:publish:committed:2', '3:rollback:committed:1']);
        expect(await readActivePointer(root)).toMatchObject({ revisionId: one });
        expect(await bases(root)).toEqual([one]);
        expect(fs.existsSync(lockFile(root))).toBe(true);
        expect(events.filter((event) => event.event === 'catalog.rollback.activated')).toHaveLength(1);
        // The left lock's lease runs out and the next one takes it over.
        const next = await rollTo(two, one, { waitMs: 5_000 });
        expect(next.outcome).toBe('ROLLED_BACK');
        expect(next.activation?.lockTakeover).toMatchObject({ previousOwner: expect.any(String) });
    });

    it('a crash with the pointer temp written but not linked leaves the old pointer live, and the next run sets the record aside', async () => {
        const { root, rollTo, one, two } = await twoRevisions({ seed: 284 });
        const pointer = folderBytes(catalogPaths(root).active);
        const authored = folderBytes(authoredPaths(root).dir);
        let left: { file: string; bytes: Buffer } | null = null;
        const crashed = await rollTo(one, two, {
            hooks: {
                pointer: {
                    beforeLink: (temp) => {
                        // A hard crash leaves the temp behind; the writer's own cleanup runs only on a throw.
                        left = { file: temp, bytes: fs.readFileSync(temp) };
                        throw new Error('crash before the link');
                    },
                },
            },
        });
        expect(crashed).toMatchObject({ outcome: 'STORAGE_ERROR', message: 'crash before the link. Nothing was rolled back.' });
        const leftover = left as { file: string; bytes: Buffer } | null;
        if (!leftover) throw new Error('The pointer write never staged a temp.');
        fs.writeFileSync(leftover.file, leftover.bytes);
        expect(await readActivePointer(root)).toMatchObject({ revisionId: two });
        expect(folderBytes(catalogPaths(root).active)).toEqual({ ...pointer, [path.basename(leftover.file)]: leftover.bytes.toString('utf8') });
        expect(folderBytes(authoredPaths(root).dir)).toEqual(authored);
        expect((await readHistory(root)).rows.map((row) => `${row.state}${row.live ? ':live' : ''}`)).toEqual(['committed', 'committed:live', 'interrupted']);

        const retry = await rollTo(one, two);
        expect(retry.outcome).toBe('ROLLED_BACK');
        expect(await statuses(root)).toEqual(['1:publish:committed:1', '2:publish:committed:2', '3:rollback:abandoned:1', '4:rollback:committed:1']);
        expect(await readActivePointer(root)).toMatchObject({ revisionId: one });
    });

    it('a crash just after the pointer link leaves the target live, and the next run records it', async () => {
        const { root, rollTo, one, two } = await twoRevisions({ seed: 285 });
        const crashed = await rollTo(one, two, { hooks: { pointer: { afterLink: crash('after the link') } } });
        expect(crashed).toMatchObject({ outcome: 'STORAGE_ERROR', message: `crash after the link. ${one} is live, and the next publish or rollback finishes recording it.` });
        expect(await readActivePointer(root)).toMatchObject({ revisionId: one });
        const again = await rollTo(one, one);
        expect(again.outcome).toBe('NO_CHANGES');
        expect(await statuses(root)).toEqual(['1:publish:committed:1', '2:publish:committed:2', '3:rollback:committed:1']);
        expect(await bases(root)).toEqual([one]);
    });

    it('ENOSPC on the pointer write leaves the pointer and the working layer as they were, and a pending record the next run sets aside', async () => {
        const { root, rollTo, one, two } = await twoRevisions({ seed: 286 });
        const pointer = folderBytes(catalogPaths(root).active);
        const authored = folderBytes(authoredPaths(root).dir);
        const crashed = await rollTo(one, two, {
            hooks: {
                pointer: {
                    beforeWrite: (temp) => {
                        throw Object.assign(new Error(`ENOSPC: no space left on device, write '${temp}'`), { code: 'ENOSPC', path: temp });
                    },
                },
            },
        });
        expect(crashed.outcome).toBe('STORAGE_ERROR');
        expect(crashed.message).toMatch(/^ENOSPC on catalog\/active\/\.v\d+\.\d+\.[0-9a-f-]+\.tmp\. Nothing was rolled back\.$/);
        expect(crashed.message).not.toContain(root);
        expect(folderBytes(catalogPaths(root).active)).toEqual(pointer);
        expect(folderBytes(authoredPaths(root).dir)).toEqual(authored);
        expect(await readActivePointer(root)).toMatchObject({ revisionId: two });
        expect((await listActivations(root)).at(-1)).toMatchObject({ status: 'pending', kind: 'rollback', revisionId: one });

        const retry = await rollTo(one, two);
        expect(retry.outcome).toBe('ROLLED_BACK');
        expect(await statuses(root)).toEqual(['1:publish:committed:1', '2:publish:committed:2', '3:rollback:abandoned:1', '4:rollback:committed:1']);
    });

    it("rolls back on top of a crashed publish's pending record, which never went live, setting it aside first", async () => {
        const { catalog, root, rollTo, publishNow, editPhoto, one, two } = await twoRevisions({ seed: 287 });
        await editPhoto(catalog.photos[1].id, (photo) => {
            photo.caption = 'A caption that never goes live.';
        });
        const crashed = await publishNow({ hooks: { afterStep: (step) => { if (step === 10) throw new Error('crash after step 10'); } } });
        expect(crashed.outcome).toBe('STORAGE_ERROR');
        const pending = (await listActivations(root)).at(-1);
        expect(pending).toMatchObject({ status: 'pending', kind: 'publish' });

        const result = await rollTo(one, two);
        expect(result).toMatchObject({ outcome: 'ROLLED_BACK', recovery: { abandoned: [pending?.activationId] } });
        expect(await statuses(root)).toEqual(['1:publish:committed:1', '2:publish:committed:2', '3:publish:abandoned:3', '4:rollback:committed:1']);
        expect(await readActivePointer(root)).toMatchObject({ revisionId: one });
    });

    it("rolls back on top of a crashed publish's pending record the pointer names, recording it committed first", async () => {
        const { catalog, root, rollTo, publishNow, editPhoto, one } = await twoRevisions({ seed: 288 });
        await editPhoto(catalog.photos[1].id, (photo) => {
            photo.caption = 'A caption revision 3 publishes.';
        });
        const crashed = await publishNow({ hooks: { afterStep: (step) => { if (step === 11) throw new Error('crash after step 11'); } } });
        const three = crashed.revisionId ?? crashed.candidateId ?? '';
        expect(await readActivePointer(root)).toMatchObject({ revisionId: three });
        const pending = (await listActivations(root)).at(-1);
        expect(pending).toMatchObject({ status: 'pending', kind: 'publish', revisionNumber: 3 });

        const planned = await planRollback({ dataRoot: root, to: { revisionNumber: 1 } });
        expect(planned).toMatchObject({ outcome: 'READY', active: { revisionId: three, revisionNumber: 3 } });
        const result = await rollTo(one, three);
        expect(result).toMatchObject({ outcome: 'ROLLED_BACK', recovery: { committed: pending?.activationId } });
        expect(await statuses(root)).toEqual(['1:publish:committed:1', '2:publish:committed:2', '3:publish:committed:3', '4:rollback:committed:1']);
        expect((await listActivations(root)).at(-1)).toMatchObject({ previousRevisionId: three, previousActivationId: pending?.activationId });
    });
});
