// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runTsx } from '../../../test/helpers/runTsx';
import { readRevisionFile } from '../../catalog/repository';
import { applySequenceOp } from '../../catalog/sequence';
import type { AuthoredPhoto, AuthoredSeries } from '../../catalog/types';
import { authoredRecordDir, readActivePointer, readAuthoredRecord } from '../../catalog/working-layer';
import { writeAuthoredRecord } from '../../catalog/working-layer-writer';
import { runReconcilePass } from '../../identity/pass';
import { runStatusCommand } from '../../catalog/owner-status';
import { createDecision, writeDecision } from '../../identity/decisions';
import { identityPaths } from '../../identity/registry';
import { buildDerivativeSet } from '../../identity/derivatives';
import type { DerivativeJob, IdentityFact, Registry } from '../../identity/types';
import { approveEvent, reopenEvent, retryEvent } from '../actions';
import { pendingMergeOf } from '../binds';
import { withCurationLock } from '../repository';
import { inboxAlertLines, inboxAlerts } from '../alerts';
import { pageWording, runInboxAction } from '../inbox-form';
import { loadInbox } from '../inbox';
import { BIND_WAITING_NEXT, seriesName, systemResponse, type InboxDetail, type InboxView } from '../inbox-view';
import { rollback } from '../../catalog/rollback';
import { parseCurationArgs, runCurationCli } from '../commands';
import type { CurationEvent } from '../events';
import { listEvents } from '../repository';
import { archiveMissing, bindReplacement, holdRefusal, MANAGED_PHOTO_FIELDS, OWNER_FIELDS } from '../resolutions';
import { authoredPhotoSchema } from '../../catalog/schema';
import { publish, validateWorkingLayer } from '../../catalog/publish';
import { createSourcesSink, failureEventId, recordingFailuresAfterBuild, settleSources } from '../sources';
import { clock, createMissingWorld, missingEventId, removeMissingTemplate, type MissingWorld } from './missingWorld';
import { makeImages, P_PATH, Q_PATH, quiet, replacementEventId, SERIES, served, treeBytes, type Images } from './replacementWorld';

// The real pendingMergeOf, which a test can wrap once to land a watcher pass inside a curator action.
vi.mock('../binds', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../binds')>();
    return { ...actual, pendingMergeOf: vi.fn(actual.pendingMergeOf) };
});

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
/** The inbox page's view of one item, and its system response, as the page reads them. */
async function pageItem(id: string): Promise<{ detail: InboxDetail; response: string; view: Extract<InboxView, { state: 'ready' }> }> {
    const view = await loadInbox(id);
    if (view.state !== 'ready' || view.selected === null) throw new Error(`The inbox can't show ${id}: ${JSON.stringify(view)}`);
    const detail = view.selected;
    return { detail, response: systemResponse(detail, (seriesId) => seriesName(view.series, seriesId)), view };
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

/**
 * Closed by the watcher because the same bytes came back: resolved by the
 * sources sink, or, at the same path once 14-1's round 5 lands, dismissed by
 * #14's sink, which then opens no reappeared item.
 */
function expectClosedAsBack(item: CurationEvent): void {
    expect(['resolved', 'dismissed']).toContain(item.status);
    expect(item.decisions.at(-1)).toMatchObject({ action: item.status === 'resolved' ? 'close' : 'dismiss', by: 'watcher', reason: expect.stringMatching(/same bytes/i) });
}

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
        expectClosedAsBack(item);
        expect((await w.registry()).photos[w.p]).toMatchObject({ sourceHealth: 'present', source: { path: back, present: true, observedRevision: w.a } });
        expect(await served(w)).toEqual(visible);

        // Idempotent: the next pass writes nothing to it.
        await w.pass();
        expect((await w.event(w.missingId)).version).toBe(item.version);
    });

    it('read on the page as the same file back, with no Reopen, which would say the source is missing', async () => {
        const w = await world();
        removeP(w);
        await w.pass();
        const open = await pageItem(w.missingId);
        // Its photograph is live, so it isn't a new photograph's "Draft only".
        expect(open.detail).toMatchObject({ status: 'open', title: 'Source file missing', can: { reopen: false } });
        fs.writeFileSync(w.lib.file('harbor/moved.jpg'), images.original);
        await w.pass();
        const back = await pageItem(w.missingId);
        expect(back.detail).toMatchObject({ status: 'resolved', group: 'settled', title: 'Source file back', resolvedBy: { kind: 'same-file' }, can: { reopen: false } });
        expect(back.response).toBe('The same file came back, so nothing a visitor sees changed.');
        expect(back.view.items.find((entry) => entry.id === w.missingId)).toMatchObject({ title: 'Source file back' });
    });

    it("read on the page as the same file back at its own path, which the watcher dismisses, and refuse an old form's Reopen, while `curation reopen` still takes it", async () => {
        const w = await world();
        removeP(w);
        await w.pass();
        fs.writeFileSync(w.lib.file(P_PATH), images.original);
        await w.pass();
        const dismissed = await w.event(w.missingId);
        expect(dismissed).toMatchObject({ status: 'dismissed' });
        expect(dismissed.decisions.at(-1)).toMatchObject({ action: 'dismiss', by: 'watcher' });

        const back = await pageItem(w.missingId);
        expect(back.detail).toMatchObject({ status: 'dismissed', group: 'settled', title: 'Source file back', resolvedBy: { kind: 'same-file' }, can: { reopen: false }, primaryUnavailable: null });
        expect(back.response).toBe('The same file came back at its path, so nothing a visitor sees changed.');
        expect(back.view.items.find((entry) => entry.id === w.missingId)).toMatchObject({ title: 'Source file back' });

        // A form from before the page stopped offering Reopen: refused under the lock, writing nothing.
        const base = (await readActivePointer(w.root))?.revisionId as string;
        const form = new FormData();
        for (const [name, value] of Object.entries({ eventId: dismissed.id, version: String(dismissed.version), base })) form.set(name, value);
        const before = layers(w);
        expect(await runInboxAction('reopen', form)).toMatchObject({
            status: 'refused',
            message: "The same file is back at its path, so this item stays closed, and the inbox doesn't reopen it. Nothing was written.",
        });
        expect(await w.event(w.missingId)).toMatchObject({ status: 'dismissed', version: dismissed.version });
        expect(layers(w)).toEqual(before);

        // The CLI keeps its own behaviour.
        const run = await runCurationCli(['reopen', dismissed.id, '--version', String(dismissed.version), '--base', base], { dataRoot: w.root, libraryRoot: w.lib.root }, {});
        expect(run.exitCode).toBe(0);
        expect(await w.event(w.missingId)).toMatchObject({ status: 'open' });
    });

    it('open the closed item again when the source goes missing again', async () => {
        const w = await world();
        removeP(w);
        await w.pass();
        fs.writeFileSync(w.lib.file(P_PATH), images.original);
        await w.pass();
        expectClosedAsBack(await w.event(w.missingId));
        removeP(w);
        await w.pass();
        const item = await w.event(w.missingId);
        expect(item.status).toBe('open');
        expect(item.decisions.at(-1)).toMatchObject({ action: 'reopen', by: 'watcher' });
    });

    it.each([
        ['at its path', 'harbor/third.jpg'],
        ['at a new path', 'harbor/third-moved.jpg'],
    ])('open the item again for a draft photo nothing shows, back %s and then gone again', async (_label, back) => {
        const w = await world();
        const R_PATH = 'harbor/third.jpg';
        fs.writeFileSync(w.lib.file(R_PATH), images.third);
        const r = (await w.pass()).find((fact) => fact.type === 'new')?.photoId as string;
        const id = missingEventId(r, (await w.registry()).photos[r].source.observedRevision);
        fs.rmSync(w.lib.file(R_PATH));
        await w.pass();
        expect(await w.event(id)).toMatchObject({ status: 'open', photoId: r });
        fs.writeFileSync(w.lib.file(back), images.third);
        await w.pass();
        expectClosedAsBack(await w.event(id));
        // Nothing shows R, so only the sources sink's rule opens its item again.
        fs.rmSync(w.lib.file(back));
        await w.pass();
        const item = await w.event(id);
        expect(item.status).toBe('open');
        expect(item.decisions.at(-1)).toMatchObject({ action: 'reopen', by: 'watcher', reason: 'The source went missing again.' });
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

    it('word both items a bind closed by what closed them, and offer neither a Reopen that would read untrue', async () => {
        const w = await world();
        const { newItem } = await otherBytes(w);
        const item = await w.event(w.missingId);
        expect(await bindReplacement({ root: w.root, eventId: item.id, expectedVersion: item.version, expectedBase: w.revisionId, actor: ACTOR })).toMatchObject({ ok: true });
        await w.pass();

        const missing = await pageItem(w.missingId);
        expect(missing.detail).toMatchObject({ status: 'resolved', resolvedBy: { kind: 'bound' }, title: 'Bound to a new file', can: { reopen: false } });
        expect(missing.response).toBe('Bound to the new file, so its replacement item reviews the new version. Visitors keep the current one until you confirm it and publish.');
        const merged = await pageItem(newItem.id);
        expect(merged.detail).toMatchObject({ status: 'resolved', resolvedBy: { kind: 'merged', into: P_PATH }, can: { reopen: false } });
        // The file replaced P's in place, so the sentence says "this path" rather than naming its own file as the other.
        expect(merged.response).toBe("A bind made this file the new version of the photograph that was at this path, so that photograph's replacement item reviews it.");
        for (const response of [missing.response, merged.response]) expect(response).not.toMatch(/\b(ph|evt)_|needs no judgment/);
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
        if (bound.ok) return;
        // Only in the draft, so taking it out of the series is a way forward, unless a revision rollback can reach lists it.
        expect(bound.message).toContain(`Take it out of ${SERIES} first, or keep it as its own photograph`);
        expect(bound.message).toContain('a revision photos rollback can go back to');
        expect(pendingDecisions(w)).toEqual([]);
        expect((await w.event(w.missingId)).version).toBe(item.version);
    });

    it('refuse a bind that would merge a photograph only an older retained revision lists, naming it, so its rollback stays possible', async () => {
        const w = await world();
        const { n } = await otherBytes(w);
        const nRevision = (await w.registry()).photos[n].source.observedRevision;
        expect((await w.build({ photoId: n, assetRevision: nRevision, profileId: w.profileId, path: P_PATH })).status).toBe('ready');
        await writeAuthoredRecord({ kind: 'photo', id: n, assetRevision: nRevision, alt: { kind: 'decorative' } }, { expectedVersion: 0, root: w.root });
        const inserted = await applySequenceOp({ dataRoot: w.root }, { kind: 'insert', seriesId: SERIES, photoId: n, at: 'end' }, { expectedVersion: (await series(w)).version, actor: { kind: 'editor' } });
        expect(inserted).toMatchObject({ ok: true });
        const showing = await w.publish();
        expect(showing).toMatchObject({ outcome: 'PUBLISHED' });
        // While the live site shows it, taking it out wouldn't help: the revision that showed it stays one rollback can reach.
        const live = await w.event(w.missingId);
        const onSite = await bindReplacement({ root: w.root, eventId: live.id, expectedVersion: live.version, actor: ACTOR, path: P_PATH });
        expect(onSite).toMatchObject({ ok: false, code: 'refused', message: expect.stringContaining(`the active revision ${showing.revisionId}`) });
        if (onSite.ok) return;
        expect(onSite.message).toContain("A photograph visitors see can't be merged, even once it's taken out");
        expect(onSite.message).not.toContain('Take it out');
        const removed = await applySequenceOp({ dataRoot: w.root }, { kind: 'remove', seriesId: SERIES, photoId: n }, { expectedVersion: (await series(w)).version, actor: { kind: 'editor' } });
        expect(removed).toMatchObject({ ok: true });
        expect(await w.publish()).toMatchObject({ outcome: 'PUBLISHED', removed: [{ photoId: n }] });

        const item = await w.event(w.missingId);
        const bound = await bindReplacement({ root: w.root, eventId: item.id, expectedVersion: item.version, actor: ACTOR, path: P_PATH });
        expect(bound).toMatchObject({ ok: false, code: 'refused', message: expect.stringContaining(`the retained catalog revision ${showing.revisionId} lists`) });
        if (bound.ok) return;
        expect(bound.message).toContain(`moves its asset revision to ${w.p}, so photos rollback could never bring that revision back`);
        expect(pendingDecisions(w)).toEqual([]);
        expect((await w.event(w.missingId)).version).toBe(item.version);
        await w.pass();
        expect((await w.registry()).photos[n].mergedInto).toBeUndefined();
    });

    it("let a bind merge a photograph only a revision that never went live lists, as a crashed publish leaves one", async () => {
        const w = await world();
        const { n } = await otherBytes(w);
        const nRevision = (await w.registry()).photos[n].source.observedRevision;
        expect((await w.build({ photoId: n, assetRevision: nRevision, profileId: w.profileId, path: P_PATH })).status).toBe('ready');
        await writeAuthoredRecord({ kind: 'photo', id: n, assetRevision: nRevision, alt: { kind: 'decorative' } }, { expectedVersion: 0, root: w.root });
        expect(await applySequenceOp({ dataRoot: w.root }, { kind: 'insert', seriesId: SERIES, photoId: n, at: 'end' }, { expectedVersion: (await series(w)).version, actor: { kind: 'editor' } })).toMatchObject({ ok: true });
        // The publish writes its revision file, then stops before anything goes live.
        const crashed = await publish({ dataRoot: w.root, actor: ACTOR, logger: { log: () => undefined }, hooks: { afterStep(step) { if (step === 9) throw new Error('Fixture crash after the revision file'); } } });
        expect(crashed.outcome).not.toBe('PUBLISHED');
        expect((await readActivePointer(w.root))?.revisionId).toBe(w.revisionId);
        const never = fs.readdirSync(path.join(w.root, 'catalog', 'revisions')).filter((name) => !name.startsWith(w.revisionId));
        expect(never).toHaveLength(1);
        // Out of the series, and the record back to bare, so only that revision file names it.
        expect(await applySequenceOp({ dataRoot: w.root }, { kind: 'remove', seriesId: SERIES, photoId: n }, { expectedVersion: (await series(w)).version, actor: { kind: 'editor' } })).toMatchObject({ ok: true });
        const record = (await readAuthoredRecord(w.root, 'photo', n)) as AuthoredPhoto;
        await writeAuthoredRecord({ kind: 'photo', id: n, assetRevision: nRevision, alt: null }, { expectedVersion: record.version, root: w.root });

        const item = await w.event(w.missingId);
        const bound = await bindReplacement({ root: w.root, eventId: item.id, expectedVersion: item.version, actor: ACTOR, path: P_PATH });
        expect(bound).toMatchObject({ ok: true });
        expect(pendingDecisions(w)).toEqual([expect.objectContaining({ type: 'bind', photoId: w.p, merge: n })]);
    });

    it.each([
        ['alt', { kind: 'described', text: 'Fixture description of N.', reviewed: true }, 'description'],
        ['alt', { kind: 'decorative' }, 'decorative flag'],
        ['title', 'Fixture title for N', 'title'],
        ['caption', 'Fixture caption for N.', 'caption'],
        ['focalPoint', { x: 0.25, y: 0.75 }, 'focal point'],
        ['crop', 'contain', 'crop'],
        ['accent', '#336699', 'accent'],
        ['credit', 'Fixture credit', 'credit'],
        ['location', 'Fixture harbor', 'location'],
        ['capturedAt', '2020-02-02', 'capture date'],
    ] as const)('refuse a bind that would merge a photograph whose record holds the owner\'s %s (%s)', async (field, value, name) => {
        const w = await world();
        const { n } = await otherBytes(w);
        await writeAuthoredRecord({ kind: 'photo', id: n, assetRevision: (await w.registry()).photos[n].source.observedRevision, alt: null, [field]: value } as Parameters<typeof writeAuthoredRecord>[0], { expectedVersion: 0, root: w.root });
        const item = await w.event(w.missingId);
        const bound = await bindReplacement({ root: w.root, eventId: item.id, expectedVersion: item.version, actor: ACTOR });
        expect(bound).toMatchObject({ ok: false, code: 'refused', message: expect.stringContaining(`with the owner's ${name}.`) });
        expect(pendingDecisions(w)).toEqual([]);
    });

    it('count every photo record field as the owner\'s copy, or as one the tools manage', () => {
        expect([...Object.keys(OWNER_FIELDS), ...MANAGED_PHOTO_FIELDS].sort()).toEqual(Object.keys(authoredPhotoSchema.shape).sort());
    });

    it('refuse a bind that would merge a photograph with a photo record in the draft, so its copy isn\'t dropped', async () => {
        const w = await world();
        const { n } = await otherBytes(w);
        await writeAuthoredRecord({ kind: 'photo', id: n, assetRevision: (await w.registry()).photos[n].source.observedRevision, title: 'Fixture title for N', alt: null }, { expectedVersion: 0, root: w.root });
        const item = await w.event(w.missingId);
        const bound = await bindReplacement({ root: w.root, eventId: item.id, expectedVersion: item.version, actor: ACTOR });
        expect(bound).toMatchObject({ ok: false, code: 'refused', message: expect.stringContaining(`${n}, which has a photo record in the draft with the owner's title`) });
        expect(pendingDecisions(w)).toEqual([]);
        expect((await w.event(w.missingId)).version).toBe(item.version);
    });

    it('let a bind merge a photograph whose record draft:init wrote bare, saying the merge leaves it unused', async () => {
        const w = await world();
        const { n } = await otherBytes(w);
        // draft:init's record: the bound revision and nothing the owner set.
        await writeAuthoredRecord({ kind: 'photo', id: n, assetRevision: (await w.registry()).photos[n].source.observedRevision, alt: null }, { expectedVersion: 0, root: w.root });
        const recordDir = authoredRecordDir(w.root, 'photo', n);
        const record = treeBytes(recordDir);
        // #16's review stamp is the writer's metadata, not the owner's copy, so it doesn't block the merge alone.
        expect((await readAuthoredRecord(w.root, 'photo', n))?.review?.fields.assetRevision).toMatchObject({ origin: 'curator' });
        const item = await w.event(w.missingId);
        const bound = await bindReplacement({ root: w.root, eventId: item.id, expectedVersion: item.version, actor: ACTOR });
        expect(bound).toMatchObject({ ok: true });
        if (!bound.ok) return;
        expect(bound.notes.join('\n')).toContain(`${n}'s photo record holds nothing the owner set, as draft:init writes it, so the merge leaves it unused`);
        expect(pendingDecisions(w)).toEqual([expect.objectContaining({ type: 'bind', photoId: w.p, merge: n })]);

        await w.pass();
        expect((await w.registry()).photos[n].mergedInto).toBe(w.p);
        // Dropped from the catalog, never deleted: the record stays as it was, and a publish leaves it out.
        expect(treeBytes(recordDir)).toEqual(record);
        await editQ(w);
        const dry = await w.publish({ dryRun: true });
        expect(dry.outcome).toBe('DRY_RUN_OK');
        expect(dry.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
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

    it('refuse a bind #10 would reject, for a photo with more than the one revision first seen at the path, writing nothing', async () => {
        const w = await world();
        const { n } = await otherBytes(w);
        fs.writeFileSync(w.lib.file(P_PATH), images.replacement);
        await w.pass();
        expect(Object.keys((await w.registry()).photos[n].revisions)).toHaveLength(2);
        const item = await w.event(w.missingId);
        const bound = await bindReplacement({ root: w.root, eventId: item.id, expectedVersion: item.version, actor: ACTOR, path: P_PATH });
        expect(bound).toMatchObject({ ok: false, code: 'refused', message: expect.stringContaining(`${n}, which has more than the one revision first seen there`) });
        expect(pendingDecisions(w)).toEqual([]);
        expect((await w.event(w.missingId)).version).toBe(item.version);
    });

    it("refuse approving the photo a pending bind merges, so the merge can't strand it in a series", async () => {
        const w = await world();
        const { n, newItem } = await otherBytes(w);
        const item = await w.event(w.missingId);
        expect(await bindReplacement({ root: w.root, eventId: item.id, expectedVersion: item.version, actor: ACTOR })).toMatchObject({ ok: true });
        expect(await show(w, newItem.id)).toContain(`merges this photograph into ${w.p} on the watcher's next pass, so approve refuses it`);

        const authored = treeBytes(path.join(w.root, 'authored'));
        const approve = () => approveEvent({ root: w.root, eventId: newItem.id, expectedVersion: newItem.version, expectedBase: w.revisionId, actor: ACTOR, choices: { seriesId: SERIES, placement: 'end' } });
        const refused = await approve();
        expect(refused).toMatchObject({ ok: false, code: 'refused', message: expect.stringContaining(`${n} is merged into ${w.p} by the bind decision`) });
        // The inbox page says why, with no ID in it.
        expect(pageWording((refused as { message: string }).message)).toBe(`A bind waiting for the watcher's next pass makes this file the new version of another photograph, so it can't be approved. ${BIND_WAITING_NEXT} Nothing was written.`);
        const run = await runCurationCli(['approve', newItem.id, '--version', String(newItem.version), '--base', w.revisionId, '--series', SERIES, '--end'], { dataRoot: w.root, libraryRoot: w.lib.root }, {});
        expect(run.exitCode).toBe(1);
        expect(treeBytes(path.join(w.root, 'authored'))).toEqual(authored);
        expect((await w.event(newItem.id)).version).toBe(newItem.version);

        // The pass merges N, and nothing in the draft names it.
        await w.pass();
        expect((await w.registry()).photos[n].mergedInto).toBe(w.p);
        expect((await series(w)).photoIds).not.toContain(n);
        expect(await readAuthoredRecord(w.root, 'photo', n)).toBeNull();
        expect(await w.event(newItem.id)).toMatchObject({ status: 'resolved' });
    });

    it("show the pending bind on both items before any click, and don't offer approve while it waits", async () => {
        const w = await world();
        const { newItem } = await otherBytes(w);
        expect((await pageItem(newItem.id)).detail).toMatchObject({ can: { approve: true }, bindWaiting: null, primaryUnavailable: null });
        const item = await w.event(w.missingId);
        expect(await bindReplacement({ root: w.root, eventId: item.id, expectedVersion: item.version, actor: ACTOR })).toMatchObject({ ok: true });

        // The new photograph: no approve, and the hint says why and what to do, as the refusal ends.
        const fresh = (await pageItem(newItem.id)).detail;
        expect(fresh).toMatchObject({ can: { approve: false, edit: true, defer: true }, bindWaiting: { kind: 'merge', into: P_PATH } });
        expect(fresh.primaryUnavailable).toBe(`A bind waiting for the watcher's next pass makes this file the new version of the photograph that was at this path. ${BIND_WAITING_NEXT}`);
        expect(fresh.primaryUnavailable).not.toMatch(/\b(ph|evt)_/);
        // The missing item says a bind waits.
        expect((await pageItem(w.missingId)).detail).toMatchObject({ bindWaiting: { kind: 'bind', path: P_PATH } });

        // Once the watcher applies it, neither says so, and the new item is closed.
        await w.pass();
        expect((await pageItem(newItem.id)).detail).toMatchObject({ status: 'resolved', bindWaiting: null, primaryUnavailable: null });
        expect((await pageItem(w.missingId)).detail).toMatchObject({ status: 'resolved', bindWaiting: null });
    });

    it("claim no waiting bind when a decision file can't be read, and leave approve to refuse under the lock", async () => {
        const w = await world();
        const { newItem } = await otherBytes(w);
        const dir = identityPaths(w.root).decisions;
        fs.mkdirSync(dir, { recursive: true });
        const unreadable = path.join(dir, 'zz-unreadable.json');
        fs.writeFileSync(unreadable, '{}');
        fs.chmodSync(unreadable, 0o000);
        try {
            // The page can't tell whether that file merges the photograph, so it says nothing about one and offers approve.
            expect((await pageItem(newItem.id)).detail).toMatchObject({ can: { approve: true }, bindWaiting: null, primaryUnavailable: null });
            expect((await pageItem(w.missingId)).detail).toMatchObject({ bindWaiting: null });
            const authored = treeBytes(path.join(w.root, 'authored'));
            const approved = await approveEvent({ root: w.root, eventId: newItem.id, expectedVersion: newItem.version, expectedBase: w.revisionId, actor: ACTOR, choices: { seriesId: SERIES, placement: 'end' } });
            expect(approved).toMatchObject({ ok: false, code: 'damaged' });
            expect(treeBytes(path.join(w.root, 'authored'))).toEqual(authored);
            expect((await w.event(newItem.id)).version).toBe(newItem.version);
        } finally {
            fs.chmodSync(unreadable, 0o600);
        }
    });

    it('refuse approving the photo a pending bind merges when the watcher applies the bind during the approval', async () => {
        const w = await world();
        const { n, newItem } = await otherBytes(w);
        const item = await w.event(w.missingId);
        expect(await bindReplacement({ root: w.root, eventId: item.id, expectedVersion: item.version, actor: ACTOR })).toMatchObject({ ok: true });
        const authored = treeBytes(path.join(w.root, 'authored'));
        // The watcher commits the bind's merge just as approve looks for a pending one.
        const actual = (await vi.importActual<typeof import('../binds')>('../binds')).pendingMergeOf;
        vi.mocked(pendingMergeOf).mockImplementationOnce(async (root, photoId) => {
            await w.bareRegistryPass();
            return actual(root, photoId);
        });
        const approved = await approveEvent({ root: w.root, eventId: newItem.id, expectedVersion: newItem.version, expectedBase: w.revisionId, actor: ACTOR, choices: { seriesId: SERIES, placement: 'end' } });
        expect((await w.registry()).photos[n].mergedInto).toBe(w.p);
        expect(approved).toMatchObject({ ok: false, code: 'stale' });
        expect(treeBytes(path.join(w.root, 'authored'))).toEqual(authored);
        expect((await series(w)).photoIds).not.toContain(n);
    });

    it('refuse archiving the photo while a bind for it waits for the watcher, writing nothing', async () => {
        const w = await world();
        await otherBytes(w);
        const item = await w.event(w.missingId);
        const bound = await bindReplacement({ root: w.root, eventId: item.id, expectedVersion: item.version, actor: ACTOR });
        expect(bound).toMatchObject({ ok: true });
        const after = await w.event(w.missingId);
        const before = layers(w);
        const decisions = pendingDecisions(w);
        const archived = await archiveMissing({ root: w.root, eventId: after.id, expectedVersion: after.version, expectedBase: w.revisionId, actor: ACTOR });
        expect(archived).toMatchObject({ ok: false, code: 'refused', message: expect.stringContaining(`A bind for ${w.p} waits for the watcher's next pass`) });
        expect(layers(w)).toEqual(before);
        expect(pendingDecisions(w)).toEqual(decisions);
        expect((await w.event(w.missingId)).version).toBe(after.version);
    });

    it('refuse a second bind that would merge the photo a pending bind already merges, writing nothing', async () => {
        const w = await world();
        const { n } = await otherBytes(w);
        // Q goes missing too.
        fs.rmSync(w.lib.file(Q_PATH));
        await w.pass();
        const qItem = await w.event(missingEventId(w.q, w.qa));
        const item = await w.event(w.missingId);
        expect(await bindReplacement({ root: w.root, eventId: item.id, expectedVersion: item.version, actor: ACTOR })).toMatchObject({ ok: true });
        // Before the watcher's next pass, the owner points Q's bind at the same file.
        const decisions = pendingDecisions(w);
        const bound = await bindReplacement({ root: w.root, eventId: qItem.id, expectedVersion: qItem.version, actor: ACTOR, path: P_PATH });
        expect(bound).toMatchObject({ ok: false, code: 'refused', message: expect.stringContaining(`${n} is already merged into ${w.p} by the pending bind decision`) });
        expect(pendingDecisions(w)).toEqual(decisions);
        expect((await w.event(qItem.id)).version).toBe(qItem.version);
    });

    it('say when #10 refuses the bind, and offer it again', async () => {
        const w = await world();
        await otherBytes(w);
        const item = await w.event(w.missingId);
        const run = await runCurationCli(['bind', item.id, '--version', String(item.version)], { dataRoot: w.root, libraryRoot: w.lib.root }, {});
        expect(run.exitCode).toBe(0);
        expect(run.output).toContain('If the watcher accepts it');
        expect(run.output).not.toContain('closes then');
        const [decision] = pendingDecisions(w) as { decisionId: string }[];
        expect(await show(w, w.missingId)).toContain(`Bind pending: the watcher applies the decision ${decision.decisionId} for ${P_PATH}`);

        // The file goes before the watcher's next pass, so #10 rejects the decision.
        removeP(w);
        await w.pass();
        expect(fs.readdirSync(path.join(identityPaths(w.root).decisions, 'rejected')).some((name) => name.includes(decision.decisionId))).toBe(true);
        expect((await w.registry()).photos[w.p].sourceHealth).toBe('missing');
        expect((await w.event(w.missingId)).status).toBe('open');
        const text = await show(w, w.missingId);
        expect(text).toContain(`Bind refused: the watcher rejected the decision ${decision.decisionId} for ${P_PATH}: there is no image at ${P_PATH}.`);
        expect(text).toContain(`curation bind ${w.missingId} --path <library path>`);
        expect(text).not.toContain('Bind pending');
        expect(text).not.toContain(w.root);
        expect(text).not.toContain(w.lib.root);
    });
});

describe('a file copied over another photo', { timeout: 60_000 }, () => {
    const R_PATH = 'harbor/third.jpg';

    it("binds through #10's hold, so the photo at the path gives it up and keeps its identity instead of being merged", async () => {
        const w = await world();
        fs.writeFileSync(w.lib.file(R_PATH), images.third);
        const r = (await w.pass()).find((fact) => fact.type === 'new')?.photoId as string;
        const rRevision = (await w.registry()).photos[r].source.observedRevision;
        const rItem = (await listEvents(w.root)).events.find((event) => event.type === 'new' && event.photoId === r) as CurationEvent;
        removeP(w);
        await w.pass();
        // The owner restores P by copying its file over R's.
        fs.writeFileSync(w.lib.file(R_PATH), images.original);
        await w.pass();
        expect((await w.registry()).holds).toEqual([expect.objectContaining({ path: R_PATH, candidates: expect.arrayContaining([w.p, r]) })]);

        const item = await w.event(w.missingId);
        const run = await runCurationCli(['bind', item.id, '--version', String(item.version), '--path', R_PATH], { dataRoot: w.root, libraryRoot: w.lib.root }, {});
        expect(run.exitCode).toBe(0);
        expect(run.output).toContain(`${r}, which #10 holds that path in doubt for, gives it up and keeps its own identity`);
        expect(run.output).toContain('own bytes');
        const decisions = pendingDecisions(w);
        expect(decisions).toEqual([expect.objectContaining({ type: 'bind', path: R_PATH, photoId: w.p })]);
        expect(decisions[0]).not.toHaveProperty('merge');

        const facts = await w.pass();
        expect(facts).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'renamed', photoId: w.p, path: R_PATH }),
            expect.objectContaining({ type: 'missing', photoId: r }),
        ]));
        const registry = await w.registry();
        expect(registry.photos[w.p]).toMatchObject({ sourceHealth: 'present', source: { path: R_PATH, observedRevision: w.a } });
        expect(Object.keys(registry.photos[w.p].revisions)).toEqual([w.a]);
        expect(registry.photos[r]).toMatchObject({ sourceHealth: 'missing' });
        expect(registry.photos[r].mergedInto).toBeUndefined();
        expect((await w.event(w.missingId)).status).toBe('resolved');
        // R keeps its own items: none closes saying a bind gave its bytes away, and its disappearance gets one.
        const rNew = await w.event(rItem.id);
        expect(rNew.status).not.toBe('resolved');
        expect(JSON.stringify(rNew.decisions)).not.toContain('A bind gave these bytes');
        expect(await w.event(missingEventId(r, rRevision))).toMatchObject({ status: 'open', photoId: r });
    });
});

describe('a bind to a path #10 holds in doubt', { timeout: 60_000 }, () => {
    const R_PATH = 'harbor/third.jpg';
    const S_PATH = 'harbor/fourth.jpg';
    const newPhotoAt = (registry: Registry, at: string) => Object.values(registry.photos).find((photo) => photo.source.path === at && photo.source.present)?.photoId as string;

    it('is refused when the hold lists two other photos, writing nothing, so neither is merged', async () => {
        const w = await world();
        fs.writeFileSync(w.lib.file(R_PATH), images.third);
        fs.writeFileSync(w.lib.file(S_PATH), images.fresh);
        await w.pass();
        const registry = await w.registry();
        const [r, s] = [newPhotoAt(registry, R_PATH), newPhotoAt(registry, S_PATH)];
        removeP(w);
        await w.pass();
        // S's file goes, and a copy of it lands over R's.
        fs.rmSync(w.lib.file(S_PATH));
        await w.pass();
        fs.writeFileSync(w.lib.file(R_PATH), images.fresh);
        await w.pass();
        const held = (await w.registry()).holds.find((hold) => hold.path === R_PATH);
        expect(held?.candidates).toEqual(expect.arrayContaining([s, r]));
        expect(held?.candidates).not.toContain(w.p);

        const item = await w.event(w.missingId);
        const bound = await bindReplacement({ root: w.root, eventId: item.id, expectedVersion: item.version, actor: ACTOR, path: R_PATH });
        expect(bound).toMatchObject({ ok: false, code: 'refused', message: expect.stringContaining(`#10 holds ${R_PATH} in doubt`) });
        expect(pendingDecisions(w)).toEqual([]);
        expect((await w.event(w.missingId)).version).toBe(item.version);
        await w.pass();
        const after = await w.registry();
        expect(after.photos[r].mergedInto).toBeUndefined();
        expect(after.photos[r].sourceHealth).not.toBe('archived');
        expect(after.photos[w.p].sourceHealth).toBe('missing');
    });

    it('is refused when the hold names only the photo whose file may have moved, saying so, and writing nothing', async () => {
        const w = await world();
        fs.writeFileSync(w.lib.file(R_PATH), images.third);
        await w.pass();
        const r = newPhotoAt(await w.registry(), R_PATH);
        removeP(w);
        await w.pass();
        // In one pass, R's file moves, and other bytes land where it was.
        fs.renameSync(w.lib.file(R_PATH), w.lib.file('harbor/moved-third.jpg'));
        fs.writeFileSync(w.lib.file(R_PATH), images.fresh);
        await w.pass();
        expect((await w.registry()).holds.find((hold) => hold.path === R_PATH)?.candidates).toEqual([r]);

        const item = await w.event(w.missingId);
        const bound = await bindReplacement({ root: w.root, eventId: item.id, expectedVersion: item.version, actor: ACTOR, path: R_PATH });
        expect(bound).toMatchObject({ ok: false, code: 'refused', message: holdRefusal(R_PATH, [r], w.p) });
        if (bound.ok) return;
        expect(bound.message).toContain(`it may still be ${r}'s file, and a bind would merge ${r} into ${w.p}`);
        expect(bound.message).not.toContain('between');
        expect(pendingDecisions(w)).toEqual([]);
        expect((await w.event(w.missingId)).version).toBe(item.version);
    });

    it('words the refusal for a hold that names no photo, one, or several', () => {
        const none = holdRefusal('harbor/a.jpg', [], 'ph_p');
        expect(none).toContain('#10 holds harbor/a.jpg without naming a photograph it might be');
        expect(none).not.toMatch(/between\s*[,.]/);
        expect(none).not.toContain('between');
        expect(holdRefusal('harbor/a.jpg', ['ph_r'], 'ph_p')).toContain("#10 holds harbor/a.jpg in doubt: it may still be ph_r's file, and a bind would merge ph_r into ph_p.");
        expect(holdRefusal('harbor/a.jpg', ['ph_r', 'ph_s'], 'ph_p')).toContain('in doubt between ph_r and ph_s, so it can\'t tell whose file it is, and a bind would merge one of them into ph_p.');
        for (const text of [none, holdRefusal('x.jpg', ['ph_r'], 'ph_p')]) expect(text).toMatch(/Settle that path's ambiguous item first, with photos identity bind or photos identity new, then bind again\. Nothing was written\.$/);
    });

    it("is refused when the path holds bytes the photo gave to another photo, writing nothing", async () => {
        const w = await world();
        fs.writeFileSync(w.lib.file(R_PATH), images.third);
        await w.pass();
        const r = newPhotoAt(await w.registry(), R_PATH);
        // #10's new gives P's file, and its bytes, a photo of its own, M.
        await writeDecision(w.root, createDecision({ type: 'new', path: P_PATH, actor: ACTOR, reason: 'Fixture split' }, { clock }));
        await w.pass();
        const m = newPhotoAt(await w.registry(), P_PATH);
        expect(m).not.toBe(w.p);
        expect((await w.registry()).photos[w.p].revisions[w.a].reassignedTo).toBe(m);
        expect((await w.event(w.missingId)).status).toBe('open');
        // M's file goes, and a copy of it lands over R's.
        removeP(w);
        await w.pass();
        fs.writeFileSync(w.lib.file(R_PATH), images.original);
        await w.pass();

        const item = await w.event(w.missingId);
        const bound = await bindReplacement({ root: w.root, eventId: item.id, expectedVersion: item.version, actor: ACTOR, path: R_PATH });
        expect(bound).toMatchObject({ ok: false, code: 'refused', message: expect.stringContaining(`which ${w.p} gave to ${m}`) });
        expect(pendingDecisions(w)).toEqual([]);
        expect((await w.event(w.missingId)).version).toBe(item.version);
        expect((await w.registry()).photos[r].mergedInto).toBeUndefined();
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
        expectClosedAsBack(await w.event(w.missingId));
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
    it('names a reopened archive\'s curation show with what settles it again, archiving or leaving it in draft', async () => {
        const w = await world();
        removeP(w);
        await w.pass();
        const item = await w.event(w.missingId);
        const archived = await archiveMissing({ root: w.root, eventId: item.id, expectedVersion: item.version, expectedBase: w.revisionId, actor: ACTOR });
        expect(archived).toMatchObject({ ok: true });
        const reopened = await reopenEvent({ root: w.root, eventId: item.id, expectedVersion: (await w.event(item.id)).version, expectedBase: w.revisionId, actor: ACTOR });
        expect(reopened).toMatchObject({ ok: true, event: { status: 'open' } });

        const issues = (await validateWorkingLayer({ dataRoot: w.root })).issues.filter((issue) => issue.code === 'review.authored-change');
        expect(issues).toEqual([expect.objectContaining({ record: { kind: 'series', id: SERIES }, field: 'photoIds', message: expect.stringContaining(`It settled the inbox item ${item.id}, which is open again.`) })]);
        expect(issues[0].hint).toBe(`Run curation show ${item.id}, then archive it again or leave it in draft.`);
    });

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
        // #16: the removal is stamped with the missing item it settled, so it goes stale if that item opens again.
        expect((await series(w)).review?.fields.photoIds).toMatchObject({ event: { id: item.id, version: item.version }, actor: ACTOR, baseRevisionId: w.revisionId });
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

    it('refuses when a publish moves the active revision while it waits for the authored lock, writing nothing', async () => {
        const w = await world();
        removeP(w);
        await w.pass();
        const item = await w.event(w.missingId);
        let authored: ReturnType<typeof treeBytes> = null;
        const archived = await archiveMissing({
            root: w.root,
            eventId: item.id,
            expectedVersion: item.version,
            expectedBase: w.revisionId,
            actor: ACTOR,
            faults: {
                beforeAuthoredLock: async () => {
                    await editQ(w);
                    expect((await w.publish()).outcome).toBe('PUBLISHED');
                    authored = treeBytes(path.join(w.root, 'authored'));
                },
            },
        });
        expect(archived).toMatchObject({ ok: false, code: 'stale', message: expect.stringContaining('The active revision moved while the archive waited for the authored lock') });
        expect(authored).not.toBeNull();
        expect(treeBytes(path.join(w.root, 'authored'))).toEqual(authored);
        expect((await series(w)).photoIds).toContain(w.p);
        expect(pendingDecisions(w)).toEqual([]);
        expect((await w.event(w.missingId)).version).toBe(item.version);
    });

    it("refuses when a series record can't be read, since it may list the photo, writing nothing", async () => {
        const w = await world();
        await writeAuthoredRecord({
            kind: 'series',
            id: 'ser_other',
            slug: 'other',
            title: 'Fixture other',
            statement: 'Fixture statement.',
            shortStatement: 'Fixture short statement.',
            photoIds: [w.q, w.p],
            cover: { photoId: w.q },
            visibility: 'draft',
        }, { expectedVersion: 0, root: w.root });
        const dir = authoredRecordDir(w.root, 'series', 'ser_other');
        for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.json'))) fs.writeFileSync(path.join(dir, name), '{ not json');
        removeP(w);
        await w.pass();
        const authored = treeBytes(path.join(w.root, 'authored'));
        const item = await w.event(w.missingId);
        const archived = await archiveMissing({ root: w.root, eventId: item.id, expectedVersion: item.version, expectedBase: w.revisionId, actor: ACTOR });
        expect(archived).toMatchObject({ ok: false, code: 'damaged', message: expect.stringContaining('ser_other') });
        expect(treeBytes(path.join(w.root, 'authored'))).toEqual(authored);
        expect((await series(w)).photoIds).toContain(w.p);
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

describe("archiving a missing photo and its new item", { timeout: 60_000 }, () => {
    /**
     * What the page sentence promises while a draft series lists the archived photo: nothing publishes. Here the draft
     * is the live revision, so a publish finds it already active; with any other change, it refuses the photo by name.
     */
    async function expectNothingPublishes(w: MissingWorld): Promise<void> {
        expect(await w.publish({ dryRun: true })).toMatchObject({ outcome: 'NO_CHANGES' });
        await editQ(w);
        expect(await w.publish({ dryRun: true })).toMatchObject({
            outcome: 'VALIDATION_FAILED',
            issues: expect.arrayContaining([expect.objectContaining({ code: 'order.unpublishable-member', severity: 'error', message: `${w.p} is archived.` })]),
        });
    }

    const cli = async (w: MissingWorld, ...args: string[]) => runCurationCli(args, { dataRoot: w.root, libraryRoot: w.lib.root }, {});
    const newItemOf = async (w: MissingWorld) => (await listEvents(w.root)).events.find((event) => event.type === 'new' && event.photoId === w.p) as CurationEvent;

    /** Remove P, archive it from its missing item, let the watcher apply it, and publish the takedown. */
    async function takeDown(w: MissingWorld): Promise<void> {
        removeP(w);
        await w.pass();
        const item = await w.event(w.missingId);
        expect(await archiveMissing({ root: w.root, eventId: item.id, expectedVersion: item.version, expectedBase: w.revisionId, actor: ACTOR })).toMatchObject({ ok: true });
        await w.pass();
        expect((await w.registry()).photos[w.p].sourceHealth).toBe('archived');
        // The pass that applies the archive closes the new item, before any publish.
        expect((await newItemOf(w)).status).toBe('resolved');
        expect(await w.publish()).toMatchObject({ outcome: 'PUBLISHED', removed: [{ photoId: w.p, series: [SERIES] }] });
        await w.pass();
    }

    for (const approved of [false, true]) {
        it(`closes the photo's ${approved ? 'approved' : 'open'} new item, so nothing asks for judgment or advises approving an archived photo`, async () => {
            const w = await world();
            let item = await newItemOf(w);
            expect(item.status).toBe('open');
            if (approved) {
                expect(await approveEvent({ root: w.root, eventId: item.id, expectedVersion: item.version, expectedBase: w.revisionId, actor: ACTOR, choices: { seriesId: SERIES, placement: 'end' } })).toMatchObject({ ok: true });
            }
            await takeDown(w);

            item = await w.event(item.id);
            expect(item).toMatchObject({ status: 'resolved' });
            expect(item.decisions.at(-1)).toMatchObject({ action: 'close', by: 'watcher', reason: 'The photograph is archived.' });
            const list = (await cli(w, 'list')).output;
            expect(list).toContain('0 items require judgment');
            expect(list).not.toContain('no longer placed');
            const shown = (await cli(w, 'show', item.id)).output;
            expect(shown).not.toContain('No longer placed');
            expect(shown).not.toContain('curation approve');
            expect(await w.publish({ dryRun: true })).toMatchObject({ outcome: 'NO_CHANGES' });
        });
    }

    it("words the archived photo's new item by its cause, and the archived missing item's Reopen as undoing nothing", async () => {
        const w = await world();
        const fresh = await newItemOf(w);
        await takeDown(w);
        const closed = await pageItem(fresh.id);
        expect(closed.detail).toMatchObject({ status: 'resolved', resolvedBy: { kind: 'archived' }, can: { reopen: true } });
        expect(closed.response).toBe('The photograph is archived, so this file needs no judgment.');
        const archived = await pageItem(w.missingId);
        expect(archived.detail).toMatchObject({ status: 'approved', group: 'settled', title: 'Photograph archived', references: [], can: { reopen: true } });
        expect(archived.response).toBe('Archived, and nothing shows it any more.');
    });

    it("says an archived photo is listed again once photos sequence insert puts it back in a draft series, never 'out of every series'", async () => {
        const w = await world();
        removeP(w);
        await w.pass();
        const item = await w.event(w.missingId);
        expect(await archiveMissing({ root: w.root, eventId: item.id, expectedVersion: item.version, expectedBase: w.revisionId, actor: ACTOR })).toMatchObject({ ok: true });
        await w.pass();
        expect((await pageItem(w.missingId)).response).toBe('Archived and out of every series in the draft. The live site shows it until you publish.');
        // #8's insert takes an archived photo (known limit 3).
        expect(await applySequenceOp({ dataRoot: w.root }, { kind: 'insert', seriesId: SERIES, photoId: w.p, at: 'end' }, { expectedVersion: (await series(w)).version, actor: { kind: 'editor' } })).toMatchObject({ ok: true });
        const listed = await pageItem(w.missingId);
        const title = seriesName(listed.view.series, SERIES);
        expect(listed.response).toBe(`Archived, but the draft lists it in ${title} again, so nothing publishes until it's taken out. The live site still shows it.`);
        // What the sentence says a publish does.
        await expectNothingPublishes(w);
    });

    it("says an archived photo is listed again after a rollback to a revision that showed it, never 'out of every series'", async () => {
        const w = await world();
        await takeDown(w);
        expect((await pageItem(w.missingId)).response).toBe('Archived, and nothing shows it any more.');
        // The owner undoes the takedown: the working layer rebases onto a revision whose series list P.
        const active = (await readActivePointer(w.root))?.revisionId as string;
        expect(await rollback({ dataRoot: w.root, revisionId: w.revisionId, expectedActiveRevisionId: active, actor: 'owner:test', reason: 'Undo the takedown', logger: { log: () => undefined } })).toMatchObject({ outcome: 'ROLLED_BACK' });
        expect((await w.registry()).photos[w.p].sourceHealth).toBe('archived');
        const after = await pageItem(w.missingId);
        expect(after.detail).toMatchObject({ status: 'approved', references: expect.arrayContaining([{ kind: 'revision', id: w.revisionId }, { kind: 'series', id: SERIES }]) });
        expect(after.response).toBe(`Archived, but the draft lists it in ${seriesName(after.view.series, SERIES)} again, so nothing publishes until it's taken out. The live site still shows it.`);
        await expectNothingPublishes(w);
    });

    it('lets the curator reopen the closed item, as before', async () => {
        const w = await world();
        let item = await newItemOf(w);
        expect(await approveEvent({ root: w.root, eventId: item.id, expectedVersion: item.version, expectedBase: w.revisionId, actor: ACTOR, choices: { seriesId: SERIES, placement: 'end' } })).toMatchObject({ ok: true });
        await takeDown(w);
        item = await w.event(item.id);
        const run = await cli(w, 'reopen', item.id, '--version', String(item.version), '--base', (await readActivePointer(w.root))?.revisionId as string);
        expect(run.exitCode).toBe(0);
        expect(run.output).toContain('Reopened.');
        expect((await w.event(item.id)).status).toBe('open');
        expect(await w.publish({ dryRun: true })).toMatchObject({ outcome: 'NO_CHANGES' });
    });

    it("keeps #16's review stamps on an archived photo, and its takedown publishes when the closed new item is reopened first", async () => {
        const w = await world();
        // R, new: approve its item with a description, so the photo record's stamps name that item, and publish it.
        const R_PATH = 'harbor/third.jpg';
        fs.writeFileSync(w.lib.file(R_PATH), images.third);
        const r = (await w.pass()).find((fact) => fact.type === 'new')?.photoId as string;
        const rRevision = (await w.registry()).photos[r].source.observedRevision;
        expect((await w.build({ photoId: r, assetRevision: rRevision, profileId: w.profileId, path: R_PATH })).status).toBe('ready');
        await w.pass();
        let item = (await listEvents(w.root)).events.find((event) => event.type === 'new' && event.photoId === r) as CurationEvent;
        expect(await approveEvent({ root: w.root, eventId: item.id, expectedVersion: item.version, expectedBase: w.revisionId, actor: ACTOR, choices: { seriesId: SERIES, placement: 'end', description: { kind: 'described', text: 'Fixture description of R.' } } })).toMatchObject({ ok: true });
        const shown = await w.publish();
        expect(shown).toMatchObject({ outcome: 'PUBLISHED' });
        const stamped = (await readAuthoredRecord(w.root, 'photo', r)) as AuthoredPhoto;
        expect(stamped.review?.fields.alt).toMatchObject({ origin: 'curator', event: { id: item.id } });

        // Gone and archived: the pass that applies the archive closes the new item and leaves the record's stamps as they were.
        fs.rmSync(w.lib.file(R_PATH));
        await w.pass();
        const missing = await w.event(missingEventId(r, rRevision));
        const base = shown.revisionId as string;
        expect(await archiveMissing({ root: w.root, eventId: missing.id, expectedVersion: missing.version, expectedBase: base, actor: ACTOR })).toMatchObject({ ok: true });
        await w.pass();
        item = await w.event(item.id);
        expect(item.status).toBe('resolved');
        expect(((await readAuthoredRecord(w.root, 'photo', r)) as AuthoredPhoto).review).toEqual(stamped.review);

        // Reopened before the takedown publish, the item those stamps name is open again, so they read as stale. The
        // takedown's removed row reviews only the series' photoIds, which archive stamped against the missing item, so
        // review.authored-change doesn't hold it, and the takedown still publishes.
        const reopened = await cli(w, 'reopen', item.id, '--version', String(item.version), '--base', base);
        expect(reopened.exitCode).toBe(0);
        expect((await w.event(item.id)).status).toBe('open');
        const dry = await w.publish({ dryRun: true });
        expect(dry).toMatchObject({ outcome: 'DRY_RUN_OK' });
        expect(dry.issues.filter((issue) => issue.code.startsWith('review.'))).toEqual([]);
        expect(await w.publish()).toMatchObject({ outcome: 'PUBLISHED', removed: [{ photoId: r, series: [SERIES] }] });

        // After it, the draft is the active revision's content: NO_CHANGES, and review.empty-diff stays silent.
        await w.pass();
        expect(await w.publish({ dryRun: true })).toMatchObject({ outcome: 'NO_CHANGES' });
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

    it('gets its item on the next pass when the settle after the build finds the curation lock busy', async () => {
        const w = await world();
        fs.writeFileSync(w.lib.file(R_PATH), images.third);
        const facts = await w.pass();
        const r = facts.find((fact) => fact.type === 'new')?.photoId as string;
        const job: DerivativeJob = { photoId: r, assetRevision: (await w.registry()).photos[r].source.observedRevision, profileId: w.profileId, path: R_PATH };
        const warn = vi.fn();
        const build = recordingFailuresAfterBuild(buildDerivativeSet, { logger: { ...quiet, warn }, clock, waitMs: 100, owed: w.owedSources });
        // A curator action holds the curation lock through the build's settle.
        await withCurationLock(w.root, {}, async () => {
            expect((await build(job, { logger: quiet, faults: { afterVariant: () => { throw new Error('Fixture encoder fault'); } } })).status).toBe('failed');
        });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Could not record the build of ${r} ${job.assetRevision} in the inbox yet; the next pass settles it, or the watcher's next start if this process ends first`));
        const id = failureEventId(r, job.assetRevision);
        expect((await listEvents(w.root)).events.find((event) => event.id === id)).toBeUndefined();

        // The next pass names no fact for R, and opens the item all the same.
        expect((await w.pass()).filter((fact) => fact.photoId === r)).toEqual([]);
        expect(await w.event(id)).toMatchObject({ status: 'failed', candidate: { state: 'failed', failure: 'build' } });
        // Owed no longer, so a pass after that writes nothing.
        const before = layers(w);
        await w.pass();
        expect(layers(w)).toEqual(before);
    });

    it("closes once #10's worker retries it at start and it builds", async () => {
        const w = await world();
        const { r, job } = await failedR(w);
        expect((await w.event(failureEventId(r, job.assetRevision))).status).toBe('failed');
        expect(await w.restart()).toBe(0);
        expect((await w.registry()).photos[r].revisions[job.assetRevision].profiles[w.profileId].state).toBe('ready');
        expect((await w.event(failureEventId(r, job.assetRevision))).status).toBe('resolved');
    });

    it('closes once the photo moves on to other bytes', async () => {
        const w = await world();
        const { r, job } = await failedR(w);
        fs.writeFileSync(w.lib.file(R_PATH), images.replacement);
        const facts = await w.pass();
        expect(facts).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'replaced', photoId: r })]));
        expect(await w.event(failureEventId(r, job.assetRevision))).toMatchObject({
            status: 'resolved',
            decisions: [expect.objectContaining({ action: 'close', by: 'watcher', reason: expect.stringContaining('other bytes') })],
        });
    });

    it('closes once the photo is archived, which #10 applies without a fact', async () => {
        const w = await world();
        const { r, job } = await failedR(w);
        fs.rmSync(w.lib.file(R_PATH));
        await w.pass();
        const missing = await w.event(missingEventId(r, job.assetRevision));
        expect(await archiveMissing({ root: w.root, eventId: missing.id, expectedVersion: missing.version, expectedBase: w.revisionId, actor: ACTOR })).toMatchObject({ ok: true });
        expect((await w.event(failureEventId(r, job.assetRevision))).status).toBe('failed');
        expect(await w.pass()).toEqual([]);
        expect((await w.registry()).photos[r].sourceHealth).toBe('archived');
        expect(await w.event(failureEventId(r, job.assetRevision))).toMatchObject({
            status: 'resolved',
            decisions: [expect.objectContaining({ action: 'close', by: 'watcher', reason: 'The photograph is archived.' })],
        });
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

        // photos status prints the same lines, and --json carries the same alerts. Open items don't fail it.
        const status = await runStatusCommand({ dataRoot: w.root });
        expect(status.exitCode).toBe(0);
        expect(status.output).toContain(`\n${lines.join('\n')}\n`);
        expect(status.output.split(w.root).join('<root>')).not.toContain(w.lib.root);
        const json = await runStatusCommand({ dataRoot: w.root }, { json: true });
        expect(json.exitCode).toBe(0);
        expect((JSON.parse(json.output) as { inbox: unknown }).inbox).toEqual(JSON.parse(JSON.stringify(alerts)));

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

describe('the sources sink', { timeout: 60_000 }, () => {
    it("looks at every item on its first delivery, then only at the photos a pass's facts name", async () => {
        const w = await world();
        removeP(w);
        await w.pass();
        const sink = createSourcesSink({ root: w.root, logger: quiet, clock, waitMs: 100 });
        // The watcher's start: every item is looked at, and P is still missing.
        await sink([]);
        expect((await w.event(w.missingId)).status).toBe('open');

        // P's file back under another name, in a pass whose facts no sources sink saw.
        fs.writeFileSync(w.lib.file('harbor/moved.jpg'), images.original);
        expect(await runReconcilePass({ clock, logger: quiet, sinks: [], clearDelivered: true })).toMatchObject({ status: 'committed' });
        expect((await w.registry()).photos[w.p].sourceHealth).toBe('present');
        const before = layers(w);
        const renamed = (photoId: string, assetRevision: string, factId: string): IdentityFact => ({
            type: 'renamed', factId, key: `renamed:${photoId}:${assetRevision}`, photoId, assetRevision, path: 'harbor/moved.jpg', folder: 'harbor', observedAt: new Date().toISOString(), fromPath: P_PATH,
        });
        // A pass with no facts, or with facts for other photos, leaves P's item alone.
        await sink([]);
        await sink([renamed(w.q, w.qa, '00000000-0000-4000-8000-00000000aaa1')]);
        expect(layers(w)).toEqual(before);
        expect((await w.event(w.missingId)).status).toBe('open');
        // A delivery that fails writes nothing, and the pass keeps the fact pending.
        await withCurationLock(w.root, {}, async () => {
            await expect(sink([renamed(w.p, w.a, '00000000-0000-4000-8000-00000000aaa2')])).rejects.toThrow();
        });
        expect((await w.event(w.missingId)).status).toBe('open');
        // Delivered again, it settles.
        await sink([renamed(w.p, w.a, '00000000-0000-4000-8000-00000000aaa2')]);
        expect(await w.event(w.missingId)).toMatchObject({ status: 'resolved', decisions: expect.arrayContaining([expect.objectContaining({ action: 'close', by: 'watcher' })]) });
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
