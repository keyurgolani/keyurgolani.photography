// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runTsx } from '../../../test/helpers/runTsx';
import { readRevisionFile } from '../../catalog/repository';
import { applySequenceOp } from '../../catalog/sequence';
import type { AuthoredPhoto, AuthoredSeries } from '../../catalog/types';
import { readActivePointer, readAuthoredRecord } from '../../catalog/working-layer';
import { writeAuthoredRecord } from '../../catalog/working-layer-writer';
import { identityPaths } from '../../identity/registry';
import type { DerivativeJob } from '../../identity/types';
import { retryEvent } from '../actions';
import { inboxAlertLines, inboxAlerts } from '../alerts';
import { parseCurationArgs, runCurationCli } from '../commands';
import type { CurationEvent } from '../events';
import { listEvents } from '../repository';
import { archiveMissing, bindReplacement } from '../resolutions';
import { failureEventId, settleSources } from '../sources';
import { createMissingWorld, removeMissingTemplate, type MissingWorld } from './missingWorld';
import { makeImages, P_PATH, Q_PATH, quiet, replacementEventId, SERIES, served, treeBytes, type Images } from './replacementWorld';

/**
 * #17-2 on temp roots, through #10's real reconcile, writer, and worker,
 * #14's sink, and #13's real publish: disappearance, reappearance with the
 * same and with different bytes, a deletion made while the watcher was
 * stopped, an unrelated publish and a restart keeping the photo public,
 * archive then publish, failed builds and their retry, the status lines,
 * the library guard, and nothing deleted anywhere.
 */

let images: Images;
const worlds: MissingWorld[] = [];

beforeAll(async () => {
    images = await makeImages();
}, 60_000);

afterEach(async () => {
    for (const world of worlds.splice(0)) await world.cleanup();
});

afterAll(() => removeMissingTemplate());

async function world(): Promise<MissingWorld> {
    const made = await createMissingWorld(images);
    worlds.push(made);
    return made;
}

const ACTOR = 'curator:test';

/** What visitors read and what #17 must never remove. */
const kept = (w: MissingWorld) => ({
    assets: treeBytes(path.join(w.root, 'assets')),
    revisions: treeBytes(path.join(w.root, 'catalog', 'revisions')),
});

const layers = (w: MissingWorld) => ({
    ...kept(w),
    catalog: treeBytes(path.join(w.root, 'catalog')),
    authored: treeBytes(path.join(w.root, 'authored')),
});

const removeP = (w: MissingWorld) => fs.rmSync(w.lib.file(P_PATH));
/** The #10 decisions waiting for the next pass. */
function pendingDecisions(w: MissingWorld): unknown[] {
    const dir = identityPaths(w.root).decisions;
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf8')));
}
const series = async (w: MissingWorld, id = SERIES) => (await readAuthoredRecord(w.root, 'series', id)) as AuthoredSeries;
const show = async (w: MissingWorld, id: string) => (await runCurationCli(['show', id], { dataRoot: w.root, libraryRoot: w.lib.root }, {})).output;

/** Publish a change to Q alone, as an owner's unrelated edit. */
async function editQ(w: MissingWorld): Promise<void> {
    const record = (await readAuthoredRecord(w.root, 'photo', w.q)) as AuthoredPhoto;
    await writeAuthoredRecord({ ...record, title: 'Another fixture title for Q' }, { expectedVersion: record.version, root: w.root });
}

describe('a source that disappears', { timeout: 60_000 }, () => {
    it('opens one missing item on its stable identity, keeps every asset, and leaves the photo public', async () => {
        const w = await world();
        const before = layers(w);
        const visible = await served(w);
        removeP(w);
        const facts = await w.pass();
        expect(facts).toEqual([expect.objectContaining({ type: 'missing', photoId: w.p, assetRevision: w.a, path: P_PATH })]);

        const item = await w.event(w.missingId);
        expect(item).toMatchObject({ type: 'missing', status: 'open', photoId: w.p, assetRevision: w.a, derivedFacts: { sourcePath: P_PATH } });
        const registry = await w.registry();
        expect(registry.photos[w.p]).toMatchObject({ sourceHealth: 'missing', source: { path: P_PATH, present: false, observedRevision: w.a } });
        expect(registry.photos[w.p].revisions[w.a].profiles[w.profileId]).toMatchObject({ state: 'ready' });
        // Nothing a visitor reads changed, and every asset is where it was.
        expect(layers(w)).toEqual(before);
        expect(await served(w)).toEqual(visible);

        // Another pass, or the same fact again, adds nothing.
        await w.pass();
        expect((await w.event(w.missingId)).version).toBe(item.version);
        expect((await listEvents(w.root)).events.filter((event) => event.type === 'missing')).toHaveLength(1);
    });

    it('says the published output is protected, and offers the three ways to settle it', async () => {
        const w = await world();
        removeP(w);
        await w.pass();
        const text = await show(w, w.missingId);
        expect(text).toContain('Published output protected');
        expect(text).toContain('Locate or restore source file');
        expect(text).toContain(`curation bind ${w.missingId} --path <library path>`);
        expect(text).toContain(`curation archive ${w.missingId}, then photos publish. That is the takedown.`);
        expect(text).toContain('immutable');
        expect(text).not.toContain(w.root);
    });
});

describe('the same bytes back', { timeout: 60_000 }, () => {
    it.each([
        ['at its path', P_PATH, 'reappeared'],
        ['at a new path', 'harbor/moved.jpg', 'renamed'],
    ])('close the missing item %s, even a pass after the delete, and once only', async (_label, back, factType) => {
        const w = await world();
        const visible = await served(w);
        removeP(w);
        await w.pass();
        await w.pass(); // A delete and a copy that span a poll arrive apart.
        fs.writeFileSync(w.lib.file(back), images.original);
        const facts = await w.pass();
        expect(facts).toEqual(expect.arrayContaining([expect.objectContaining({ type: factType, photoId: w.p, assetRevision: w.a })]));

        const item = await w.event(w.missingId);
        expect(item.status).toBe('resolved');
        expect(item.decisions.at(-1)).toMatchObject({ action: 'close', by: 'watcher', reason: expect.stringContaining('with the same bytes') });
        expect((await w.registry()).photos[w.p]).toMatchObject({ sourceHealth: 'present', source: { path: back, present: true, observedRevision: w.a } });
        expect(await served(w)).toEqual(visible);

        // Idempotent: the next pass writes nothing to it.
        await w.pass();
        expect((await w.event(w.missingId)).version).toBe(item.version);
    });

    it('open the resolved item again when the source goes missing again', async () => {
        const w = await world();
        removeP(w);
        await w.pass();
        fs.writeFileSync(w.lib.file(P_PATH), images.original);
        await w.pass();
        expect((await w.event(w.missingId)).status).toBe('resolved');
        removeP(w);
        await w.pass();
        const item = await w.event(w.missingId);
        expect(item.status).toBe('open');
        expect(item.decisions.at(-1)).toMatchObject({ action: 'reopen', by: 'watcher' });
    });
});

describe('other bytes back', { timeout: 60_000 }, () => {
    /** P deleted, then other pixels saved at its path. */
    async function otherBytes(w: MissingWorld): Promise<{ n: string; newItem: CurationEvent }> {
        removeP(w);
        await w.pass();
        fs.writeFileSync(w.lib.file(P_PATH), images.third);
        const facts = await w.pass();
        const fresh = facts.find((fact) => fact.type === 'new');
        if (!fresh?.photoId) throw new Error(`Expected a new photo, got ${JSON.stringify(facts)}`);
        expect(fresh).toMatchObject({ samePathAs: w.p, path: P_PATH });
        const { events } = await listEvents(w.root);
        return { n: fresh.photoId, newItem: events.find((event) => event.type === 'new' && event.photoId === fresh.photoId) as CurationEvent };
    }

    it('stay a new photograph linked to the missing item, which nothing binds on its own', async () => {
        const w = await world();
        const visible = await served(w);
        const { n, newItem } = await otherBytes(w);
        expect(newItem).toMatchObject({ status: 'open', derivedFacts: { samePathAs: w.p } });
        const registry = await w.registry();
        expect(registry.photos[w.p].sourceHealth).toBe('missing');
        expect(registry.photos[n].sourceHealth).toBe('present');
        expect(registry.photos[n].mergedInto).toBeUndefined();
        expect((await w.event(w.missingId)).status).toBe('open');
        const text = await show(w, w.missingId);
        expect(text).toContain(`Linked: ${P_PATH} holds other bytes at its last path`);
        expect(text).toContain(`curation bind ${w.missingId},`);
        await w.pass();
        expect((await w.registry()).photos[w.p].sourceHealth).toBe('missing');
        expect(await served(w)).toEqual(visible);
    });

    it("bind with #10's decision, which closes both items and opens the photo's replacement item, and changes nothing public", async () => {
        const w = await world();
        const visible = await served(w);
        const { n, newItem } = await otherBytes(w);
        const item = await w.event(w.missingId);
        const bound = await bindReplacement({ root: w.root, eventId: item.id, expectedVersion: item.version, expectedBase: w.revisionId, actor: ACTOR });
        expect(bound).toMatchObject({ ok: true, event: { status: 'open', decisions: [expect.objectContaining({ action: 'bind', path: P_PATH, by: ACTOR })] } });
        expect(pendingDecisions(w)).toEqual([expect.objectContaining({ type: 'bind', path: P_PATH, photoId: w.p, merge: n })]);

        const facts = await w.pass();
        const replaced = facts.find((fact) => fact.type === 'replaced' && fact.photoId === w.p);
        expect(replaced).toBeDefined();
        const registry = await w.registry();
        expect(registry.photos[w.p]).toMatchObject({ sourceHealth: 'present', source: { path: P_PATH, observedRevision: replaced?.assetRevision } });
        expect(registry.photos[n].mergedInto).toBe(w.p);
        expect(await w.event(w.missingId)).toMatchObject({ status: 'resolved', decisions: expect.arrayContaining([expect.objectContaining({ action: 'close', reason: expect.stringContaining('other bytes') })]) });
        expect(await w.event(newItem.id)).toMatchObject({ status: 'resolved', decisions: [expect.objectContaining({ action: 'close', reason: expect.stringContaining(w.p) })] });

        // The new bytes go public only through 17-1's confirm and a publish.
        const replacement = await w.event(replacementEventId(w.p, replaced?.assetRevision as string));
        expect(replacement.status).toBe('open');
        const job: DerivativeJob = { photoId: w.p, assetRevision: replaced?.assetRevision as string, profileId: w.profileId, path: P_PATH };
        expect((await w.build(job)).status).toBe('ready');
        expect((await w.event(replacement.id)).candidate).toMatchObject({ state: 'ready' });
        expect(((await readAuthoredRecord(w.root, 'photo', w.p)) as AuthoredPhoto).assetRevision).toBe(w.a);
        expect(await served(w)).toEqual(visible);
    });

    it('refuse a bind that would merge a photograph a series already shows, writing nothing', async () => {
        const w = await world();
        const { n } = await otherBytes(w);
        await writeAuthoredRecord({ kind: 'photo', id: n, assetRevision: (await w.registry()).photos[n].source.observedRevision, alt: { kind: 'decorative' } }, { expectedVersion: 0, root: w.root });
        const harbor = await series(w);
        expect(await applySequenceOp({ dataRoot: w.root }, { kind: 'insert', seriesId: SERIES, photoId: n, at: 'end' }, { expectedVersion: harbor.version, actor: { kind: 'editor' } })).toMatchObject({ ok: true });
        const item = await w.event(w.missingId);
        const bound = await bindReplacement({ root: w.root, eventId: item.id, expectedVersion: item.version, actor: ACTOR });
        expect(bound).toMatchObject({ ok: false, code: 'refused', message: expect.stringContaining(`the series ${SERIES}`) });
        expect(pendingDecisions(w)).toEqual([]);
        expect((await w.event(w.missingId)).version).toBe(item.version);
    });

    it('need a path when nothing is linked, and take one anywhere in the library', async () => {
        const w = await world();
        removeP(w);
        await w.pass();
        const item = await w.event(w.missingId);
        expect(await bindReplacement({ root: w.root, eventId: item.id, expectedVersion: item.version, actor: ACTOR })).toMatchObject({ ok: false, code: 'needs-choice' });
        // A file the watcher hasn't seen yet would only be rejected out of sight on its next pass.
        fs.writeFileSync(w.lib.file('harbor/elsewhere.jpg'), images.third);
        expect(await bindReplacement({ root: w.root, eventId: item.id, expectedVersion: item.version, actor: ACTOR, path: 'harbor/elsewhere.jpg' })).toMatchObject({ ok: false, code: 'refused', message: expect.stringContaining("hasn't seen") });
        expect(pendingDecisions(w)).toEqual([]);
        await w.pass();
        const again = await w.event(w.missingId);
        const bound = await bindReplacement({ root: w.root, eventId: again.id, expectedVersion: again.version, actor: ACTOR, path: 'harbor/elsewhere.jpg' });
        expect(bound).toMatchObject({ ok: true });
        expect(pendingDecisions(w)).toEqual([expect.objectContaining({ type: 'bind', path: 'harbor/elsewhere.jpg', photoId: w.p })]);
    });
});

describe('a deletion made while the watcher was stopped', { timeout: 60_000 }, () => {
    it("arrives through the startup reconcile, and so does the file's return", async () => {
        const w = await world();
        const before = kept(w);
        const visible = await served(w);
        removeP(w);
        expect(await w.restart()).toBe(0);
        expect(await w.event(w.missingId)).toMatchObject({ status: 'open', photoId: w.p });
        expect(kept(w)).toEqual(before);
        expect(await served(w)).toEqual(visible);

        fs.writeFileSync(w.lib.file(P_PATH), images.original);
        expect(await w.restart()).toBe(0);
        expect((await w.event(w.missingId)).status).toBe('resolved');
        expect(kept(w)).toEqual(before);
    });
});

describe('a missing source and the public site', { timeout: 60_000 }, () => {
    it('keeps the photo public through an unrelated publish and a restart', async () => {
        const w = await world();
        const before = kept(w);
        const visible = await served(w);
        removeP(w);
        await w.pass();

        await editQ(w);
        const published = await w.publish();
        expect(published).toMatchObject({ outcome: 'PUBLISHED', removed: [] });
        expect(published.revisionId).not.toBe(w.revisionId);
        const revision = await readRevisionFile(w.root, published.revisionId as string);
        const old = await readRevisionFile(w.root, w.revisionId);
        expect(revision?.content.photos.find((photo) => photo.id === w.p)).toEqual(old?.content.photos.find((photo) => photo.id === w.p));
        const after = await served(w);
        expect(after.revisionId).toBe(published.revisionId);
        expect({ ...after, revisionId: null }).toEqual({ ...visible, revisionId: null });

        // A restart: the worker's start, which retries and sweeps staging, then the startup pass.
        expect(await w.restart()).toBe(0);
        expect(await served(w)).toEqual(after);
        expect((await w.event(w.missingId)).status).toBe('open');
        const assets = kept(w).assets;
        expect(assets).toEqual(before.assets);
    });
});

describe('archive, then publish', { timeout: 60_000 }, () => {
    it('takes the photo out of every series in the draft, writes the archive decision, and changes nothing public until a publish', async () => {
        const w = await world();
        const visible = await served(w);
        removeP(w);
        await w.pass();
        const item = await w.event(w.missingId);
        expect(await archiveMissing({ root: w.root, eventId: item.id, expectedVersion: item.version, actor: ACTOR })).toMatchObject({ ok: false, code: 'needs-choice' });

        const catalog = treeBytes(path.join(w.root, 'catalog'));
        const archived = await archiveMissing({ root: w.root, eventId: item.id, expectedVersion: item.version, expectedBase: w.revisionId, actor: ACTOR, reason: 'Fixture takedown' });
        expect(archived).toMatchObject({ ok: true, event: { status: 'approved', decisions: [expect.objectContaining({ action: 'archive', writes: [expect.objectContaining({ record: `series:${SERIES}` })] })] } });
        if (!archived.ok) return;
        expect(archived.notes.join('\n')).toContain('photos publish --dry-run lists it as removed');
        expect((await series(w)).photoIds).toEqual([w.q]);
        expect(pendingDecisions(w)).toEqual([expect.objectContaining({ type: 'archive', photoId: w.p })]);
        expect(treeBytes(path.join(w.root, 'catalog'))).toEqual(catalog);
        expect(await served(w)).toEqual(visible);

        // The dry run shows the removal, and still writes no pointer.
        const pointer = await readActivePointer(w.root);
        const dry = await w.publish({ dryRun: true });
        expect(dry).toMatchObject({ outcome: 'DRY_RUN_OK', removed: [{ photoId: w.p, series: [SERIES] }] });
        expect(await readActivePointer(w.root)).toEqual(pointer);
        const cli = await runTsx('scripts/photos.ts', ['publish', '--dry-run', '--actor', 'owner:test']);
        expect(cli.code).toBe(0);
        expect(cli.stdout).toContain('Removed: 1 photograph the active revision shows leaves the site if this publishes:');
        expect(cli.stdout).toContain(`  ${w.p}, from ${SERIES}`);

        // The watcher applies the archive; the item stays settled.
        await w.pass();
        expect((await w.registry()).photos[w.p].sourceHealth).toBe('archived');
        expect((await w.event(w.missingId)).status).toBe('approved');
        expect(pendingDecisions(w)).toEqual([]);

        const assets = kept(w).assets;
        const published = await w.publish();
        expect(published).toMatchObject({ outcome: 'PUBLISHED', removed: [{ photoId: w.p, series: [SERIES] }] });
        const revision = await readRevisionFile(w.root, published.revisionId as string);
        expect(revision?.content.photos.map((photo) => photo.id)).toEqual([w.q]);
        expect(revision?.content.series.find((entry) => entry.id === SERIES)?.photoIds).toEqual([w.q]);
        // /media stops serving P's set, which stays on disk: nothing was deleted.
        const pRef = { photoId: w.p, assetRevision: w.a, profileId: w.profileId };
        expect((await served({ root: w.root, p: w.q }, pRef)).other).toBe(404);
        expect(kept(w).assets).toEqual(assets);
    });

    it('checks every removal before writing any, so a refused one leaves the working layer as it was', async () => {
        const w = await world();
        await writeAuthoredRecord({
            kind: 'series',
            id: 'ser_other',
            slug: 'other',
            title: 'Fixture other',
            statement: 'Fixture statement.',
            shortStatement: 'Fixture short statement.',
            photoIds: [w.q, w.p],
            chapters: [{ id: 'ch_last', title: 'Fixture chapter', startPhotoId: w.p }],
            cover: { photoId: w.q },
            visibility: 'draft',
        }, { expectedVersion: 0, root: w.root });
        removeP(w);
        await w.pass();
        const authored = treeBytes(path.join(w.root, 'authored'));
        const item = await w.event(w.missingId);
        const archived = await archiveMissing({ root: w.root, eventId: item.id, expectedVersion: item.version, expectedBase: w.revisionId, actor: ACTOR });
        expect(archived).toMatchObject({ ok: false, code: 'refused', message: expect.stringContaining('chapter-would-be-empty') });
        expect(treeBytes(path.join(w.root, 'authored'))).toEqual(authored);
        expect(pendingDecisions(w)).toEqual([]);
        expect((await w.event(w.missingId)).version).toBe(item.version);
    });

    it('is only for a missing item, and the CLI takes it with the version and base show printed', async () => {
        const w = await world();
        const { events } = await listEvents(w.root);
        expect(events.length).toBeGreaterThan(0);
        const other = events[0];
        expect(await archiveMissing({ root: w.root, eventId: other.id, expectedVersion: other.version, expectedBase: w.revisionId, actor: ACTOR })).toMatchObject({ ok: false });
        removeP(w);
        await w.pass();
        const item = await w.event(w.missingId);
        const run = await runCurationCli(['archive', item.id, '--version', String(item.version), '--base', w.revisionId], { dataRoot: w.root, libraryRoot: w.lib.root }, {});
        expect(run.exitCode).toBe(0);
        expect(run.output).toContain(`Took ${w.p} out of ${SERIES} in the draft`);
        expect(run.output).not.toContain(w.root);
    });
});

describe('a build that stays failed', { timeout: 60_000 }, () => {
    const R_PATH = 'harbor/third.jpg';

    /** A new photograph R whose first build fails at a variant. */
    async function failedR(w: MissingWorld): Promise<{ r: string; job: DerivativeJob }> {
        fs.writeFileSync(w.lib.file(R_PATH), images.third);
        const facts = await w.pass();
        const r = facts.find((fact) => fact.type === 'new')?.photoId as string;
        const job: DerivativeJob = { photoId: r, assetRevision: (await w.registry()).photos[r].source.observedRevision, profileId: w.profileId, path: R_PATH };
        const outcome = await w.build(job, { afterVariant: () => { throw new Error('Fixture encoder fault'); } });
        expect(outcome.status).toBe('failed');
        return { r, job };
    }

    it("gets a failed item right after the build, which #14's retry and the next build close", async () => {
        const w = await world();
        const { r, job } = await failedR(w);
        const id = failureEventId(r, job.assetRevision);
        const item = await w.event(id);
        expect(item).toMatchObject({ type: 'processing-failure', status: 'failed', photoId: r, candidate: { state: 'failed', failure: 'build' }, derivedFacts: { sourcePath: R_PATH } });
        expect(JSON.stringify(item)).not.toContain('Fixture encoder fault');
        expect(await show(w, id)).toContain('curation retry builds it again');

        // Settling again writes nothing.
        await w.pass();
        expect((await w.event(id)).version).toBe(item.version);

        const retried = await retryEvent({ root: w.root, eventId: id, expectedVersion: item.version, actor: ACTOR });
        expect(retried).toMatchObject({ ok: true });
        expect(pendingDecisions(w)).toEqual([expect.objectContaining({ type: 'retry', photoId: r })]);
        await w.pass();
        expect((await w.registry()).photos[r].revisions[job.assetRevision].profiles[w.profileId].state).toBe('pending');
        expect((await w.build(job)).status).toBe('ready');
        expect(await w.event(id)).toMatchObject({ status: 'resolved', candidate: { state: 'ready' }, decisions: expect.arrayContaining([expect.objectContaining({ action: 'close', by: 'watcher' })]) });
    });

    it("closes once #10's worker retries it at start and it builds", async () => {
        const w = await world();
        const { r, job } = await failedR(w);
        expect((await w.event(failureEventId(r, job.assetRevision))).status).toBe('failed');
        expect(await w.restart()).toBe(0);
        expect((await w.registry()).photos[r].revisions[job.assetRevision].profiles[w.profileId].state).toBe('ready');
        expect((await w.event(failureEventId(r, job.assetRevision))).status).toBe('resolved');
    });

    it("gets no second item when a replacement item already carries the failure", async () => {
        const w = await world();
        fs.writeFileSync(w.lib.file(P_PATH), images.replacement);
        const facts = await w.pass();
        const b = facts.find((fact) => fact.type === 'replaced')?.assetRevision as string;
        const job: DerivativeJob = { photoId: w.p, assetRevision: b, profileId: w.profileId, path: P_PATH };
        expect((await w.build(job, { afterVariant: () => { throw new Error('Fixture encoder fault'); } })).status).toBe('failed');
        await settleSources(w.root, { logger: quiet });
        expect((await w.event(replacementEventId(w.p, b))).status).toBe('failed');
        expect((await listEvents(w.root)).events.find((event) => event.id === failureEventId(w.p, b))).toBeUndefined();
    });
});

describe('photos status lines', { timeout: 60_000 }, () => {
    it('list each open missing source and failure, what still shows it, and no host path', async () => {
        const w = await world();
        expect(inboxAlertLines(await inboxAlerts(w.root))).toEqual(['Inbox: 0 missing sources, 0 failures open']);
        removeP(w);
        await w.pass();
        fs.writeFileSync(w.lib.file('harbor/third.jpg'), images.third);
        const facts = await w.pass();
        const r = facts.find((fact) => fact.type === 'new')?.photoId as string;
        const assetRevision = (await w.registry()).photos[r].source.observedRevision;
        await w.build({ photoId: r, assetRevision, profileId: w.profileId, path: 'harbor/third.jpg' }, { afterVariant: () => { throw new Error('Fixture encoder fault'); } });

        const alerts = await inboxAlerts(w.root);
        expect(alerts.missing).toEqual([expect.objectContaining({ eventId: w.missingId, photoId: w.p, sourcePath: P_PATH, shownBy: [`the active revision ${w.revisionId}`, `the series ${SERIES}`] })]);
        expect(alerts.failed).toEqual([expect.objectContaining({ eventId: failureEventId(r, assetRevision), failure: 'derivative set build' })]);
        const lines = inboxAlertLines(alerts);
        expect(lines[0]).toBe('Inbox: 1 missing source, 1 failure open');
        expect(lines[1]).toMatch(new RegExp(`^  missing  ${w.p.slice(0, 11)}  ${P_PATH}  since .+, open; the active revision ${w.revisionId} and the series ${SERIES} still show it  \\(${w.missingId}@\\d+\\)$`));
        expect(lines[2]).toContain('failed   ');
        expect(lines.join('\n')).not.toContain(w.root);
        expect(lines.join('\n')).not.toContain(w.lib.root);

        // Once the source is back, the missing line goes.
        fs.writeFileSync(w.lib.file(P_PATH), images.original);
        await w.pass();
        expect((await inboxAlerts(w.root)).missing).toEqual([]);
    });
});

describe('the library guard', { timeout: 60_000 }, () => {
    /** Everything but the watcher's heartbeat. */
    const everything = (w: MissingWorld) => {
        const files = treeBytes(w.root) ?? {};
        return Object.fromEntries(Object.entries(files).filter(([name]) => !name.startsWith('status/')));
    };

    it('with the library root gone, creates no folder, deletes nothing, and unpublishes nothing', async () => {
        const w = await world();
        const before = everything(w);
        const away = `${w.lib.root}-away`;
        fs.renameSync(w.lib.root, away);
        try {
            expect(await w.restart()).toBe(1);
            expect(fs.existsSync(w.lib.root)).toBe(false);
            expect(everything(w)).toEqual(before);
        } finally {
            fs.renameSync(away, w.lib.root);
        }
    });

    it('with the library root unreadable, writes nothing', async () => {
        const w = await world();
        const before = everything(w);
        fs.chmodSync(w.lib.root, 0o000);
        try {
            expect(await w.restart()).toBe(1);
        } finally {
            fs.chmodSync(w.lib.root, 0o755);
        }
        expect(everything(w)).toEqual(before);
    });

    it('with the library root empty, reports every photo missing and keeps the site and every asset as they were', async () => {
        const w = await world();
        const before = layers(w);
        const visible = await served(w);
        fs.rmSync(w.lib.file('harbor'), { recursive: true });
        expect(await w.restart()).toBe(0);
        expect(fs.readdirSync(w.lib.root)).toEqual([]);
        const registry = await w.registry();
        expect([registry.photos[w.p].sourceHealth, registry.photos[w.q].sourceHealth]).toEqual(['missing', 'missing']);
        const missing = (await listEvents(w.root)).events.filter((event) => event.type === 'missing');
        expect(missing.map((event) => event.photoId).sort()).toEqual([w.p, w.q].sort());
        expect(layers(w)).toEqual(before);
        expect(await served(w)).toEqual(visible);
        expect(pendingDecisions(w)).toEqual([]);
    });
});

describe('nothing deleted anywhere', { timeout: 120_000 }, () => {
    it('keeps every asset and revision through disappearance, an unrelated publish, a restart, archive, and the takedown publish', async () => {
        const w = await world();
        const before = kept(w);
        const library = treeBytes(w.lib.root) ?? {};
        removeP(w);
        await w.pass();
        await editQ(w);
        expect((await w.publish()).outcome).toBe('PUBLISHED');
        expect(await w.restart()).toBe(0);
        const item = await w.event(w.missingId);
        const active = (await readActivePointer(w.root))?.revisionId ?? null;
        expect(await archiveMissing({ root: w.root, eventId: item.id, expectedVersion: item.version, expectedBase: active, actor: ACTOR })).toMatchObject({ ok: true });
        await w.pass();
        expect((await w.publish()).outcome).toBe('PUBLISHED');
        expect(await w.restart()).toBe(0);

        const after = kept(w);
        for (const kind of ['assets', 'revisions'] as const) {
            expect(Object.keys(after[kind] ?? {})).toEqual(expect.arrayContaining(Object.keys(before[kind] ?? {})));
            for (const [name, bytes] of Object.entries(before[kind] ?? {})) expect(after[kind]?.[name]).toBe(bytes);
        }
        const { [P_PATH]: _gone, ...rest } = library;
        void _gone;
        expect(treeBytes(w.lib.root)).toEqual(rest);
        expect(Object.keys(rest)).toContain(Q_PATH);
        const registry = await w.registry();
        expect(registry.photos[w.p].revisions[w.a].profiles[w.profileId].state).toBe('ready');
    });
});

describe('the bind and archive arguments', () => {
    it('take a version, a base, a reason, and for bind a library path', () => {
        const id = `evt_${'a'.repeat(24)}`;
        expect(parseCurationArgs(['archive', id, '--version', '2', '--base', 'none', '--reason', 'Takedown'])).toEqual({ command: 'archive', eventId: id, version: 2, base: null, reason: 'Takedown' });
        expect(parseCurationArgs(['bind', id, '--version', '1', '--path', 'harbor/new.jpg'])).toEqual({ command: 'bind', eventId: id, version: 1, path: 'harbor/new.jpg' });
        expect(() => parseCurationArgs(['bind', id, '--version', '1', '--path', '../outside.jpg'])).toThrow(/relative to the library/);
        expect(() => parseCurationArgs(['archive', id, '--version', '1', '--path', 'harbor/new.jpg'])).toThrow(/doesn't go with curation archive/);
    });
});
