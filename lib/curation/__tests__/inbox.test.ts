// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { folderBytes } from '../../../test/helpers/folderBytes';
import { setDataDir, writeDataRootMarker } from '../../../test/helpers/tempDataRoot';
import { authoredRecordDir, readAuthoredRecord } from '../../catalog/working-layer';
import { AUTHORED_LOCK, writeAuthoredRecord } from '../../catalog/working-layer-writer';
import { writeDecision } from '../../identity/decisions';
import { profileIdOf } from '../../identity/ids';
import { PROFILE_1 } from '../../identity/profile';
import { identityPaths, readRegistry, writeRegistry } from '../../identity/registry';
import type { IdentityFact } from '../../identity/types';
import { withLock } from '../../storage/lock';
import { approveEvent, deferEvent, reopenEvent } from '../actions';
import { eventIdOf, eventKey, type CurationEvent, type CurationEventType } from '../events';
import { printable, runCurationCli } from '../commands';
import { loadInbox } from '../inbox';
import { pageWording, runInboxAction, WEB_ACTOR } from '../inbox-form';
import {
    bindAnswer,
    CONFIRM_UNAVAILABLE,
    defaultDescription,
    defaultPlacement,
    defaultSeries,
    DONE_ANSWER,
    formSeries,
    MISSING_HINT,
    parsePlacementValue,
    placementValue,
    REPLACEMENT_HINT,
    summaryText,
    type InboxActionState,
    type InboxView,
} from '../inbox-view';
import { EventMovedError, eventDir, listEvents, readEvent, withCurationLock, writeEvent } from '../repository';
import { createCurationSink } from '../sink';
import { createCurationFixture, DRAFT, GPS, PUBLISHED, SERIAL, writeRules, type CurationFixture } from './curationFixtures';
import { createMissingWorld, removeMissingTemplate, type MissingWorld } from './missingWorld';
import { createWorld, makeImages, P_PATH, photoRecord, removeTemplate, SERIES, served, type Images, type World } from './replacementWorld';

// The real writers, which a #118 test can fail once to land a fault after an archive's series changed.
vi.mock('../../identity/decisions', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../identity/decisions')>();
    return { ...actual, writeDecision: vi.fn(actual.writeDecision) };
});
vi.mock('../repository', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../repository')>();
    return { ...actual, writeEvent: vi.fn(actual.writeEvent) };
});

// #14's 14-3: what the Inbox page reads, and what its forms do through
// 14-1's actions. The server actions in app/curation/inbox/actions.ts call
// runInboxAction() once requireCurator() passes; the route-inventory test
// covers the refusals.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };

const TYPE_OF: Record<IdentityFact['type'], CurationEventType> = {
    new: 'new', replaced: 'replacement', 'metadata-changed': 'replacement', missing: 'missing', reappeared: 'reappeared', ambiguous: 'ambiguous', 'processing-failed': 'processing-failure', renamed: 'new',
};

/** A fixture, served as the data root, with the events the sink opened from `facts`. */
async function inbox(facts: (f: CurationFixture) => IdentityFact[], options: Parameters<typeof createCurationFixture>[0] & { rules?: unknown } = {}) {
    const f = await createCurationFixture(options);
    cleanups.push(() => f.cleanup());
    cleanups.push(setDataDir(f.root));
    if (options.rules !== undefined) writeRules(f.root, options.rules);
    const made = facts(f);
    await createCurationSink({ root: f.root, logger: quiet })(made);
    const ids = made.map((fact) => eventIdOf(eventKey(TYPE_OF[fact.type], fact)));
    return { f, ids };
}

const ready = (view: InboxView) => {
    if (view.state !== 'ready') throw new Error(`The inbox is ${view.state}`);
    return view;
};

function form(fields: Record<string, string | undefined>): FormData {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) if (value !== undefined) data.set(name, value);
    return data;
}

/** The fields every item form carries, as the page fills them. */
function itemForm(event: Pick<CurationEvent, 'id' | 'version'>, base: string | null, extra: Record<string, string | undefined> = {}): FormData {
    return form({ eventId: event.id, version: String(event.version), base: base ?? 'none', ...extra });
}

const layers = (root: string) => ({ catalog: folderBytes(path.join(root, 'catalog')), authored: folderBytes(path.join(root, 'authored')) });

const done = (state: InboxActionState) => expect(state).toMatchObject({ status: 'done' });

describe('loadInbox', () => {
    it('is ready and empty when the watcher has opened nothing', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-empty-'));
        cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
        writeDataRootMarker(root);
        cleanups.push(setDataDir(root));
        const view = ready(await loadInbox(null));
        expect(view).toMatchObject({ needsJudgment: 0, waiting: 0, items: [], problems: [], selected: null, activeRevisionId: null });
        expect(summaryText(view)).toBe('0 items require judgment');
    });

    it('is not-ready, and reads nothing, when the data root is not set up', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-bare-'));
        cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
        cleanups.push(setDataDir(root));
        const view = await loadInbox(null);
        expect(view).toMatchObject({ state: 'not-ready', message: expect.stringMatching(/uninitialized/) });
        expect(JSON.stringify(view)).not.toContain(root);
    });

    it('lists every type, those that need judgment first, and counts what waits on the watcher', async () => {
        const { f, ids } = await inbox(
            (fx) => [
                fx.fact('new', fx.fresh[0]),
                fx.fact('missing', fx.catalog.photos[0].id),
                fx.fact('processing-failed', null, { reason: 'unsupported-format', path: 'trips/unbound.heic' }),
                fx.fact('ambiguous', null, { candidates: [fx.fresh[1], fx.catalog.photos[1].id], path: 'trips/copy.jpg' }),
                fx.fact('reappeared', fx.catalog.photos[2].id),
            ],
            { published: true },
        );
        // A replacement whose new bytes are still building waits.
        const registry = await readRegistry(f.root);
        const photo = registry.photos[f.catalog.photos[3].id];
        const next = `sha256-${'c'.repeat(64)}`;
        photo.revisions[next] = { ...Object.values(photo.revisions)[0], assetRevision: next, profiles: { [f.catalog.profileId]: { state: 'pending', attempts: 0 } } };
        await writeRegistry(f.root, registry, registry.version);
        const replaced = f.fact('replaced', f.catalog.photos[3].id, { assetRevision: next });
        await createCurationSink({ root: f.root, logger: quiet })([replaced]);

        const view = ready(await loadInbox(null));
        expect(view.items.map((item) => item.group)).toEqual(['judgment', 'judgment', 'judgment', 'judgment', 'judgment', 'waiting']);
        expect(view.items.slice(0, 5).map((item) => item.type).sort()).toEqual(['ambiguous', 'missing', 'new', 'processing-failure', 'reappeared']);
        expect(view.items[5].type).toBe('replacement');
        expect(summaryText(view)).toBe('5 of 6 items require judgment, 1 waiting');
        expect(view.items[5]).toMatchObject({ title: 'Replacement building', waiting: 'its new derivatives are still building' });
        // With no selection, the first item that needs judgment shows.
        expect(view.selected?.id).toBe(view.items[0].id);
        expect(ids).toContain(view.selected?.id);
        expect(view.activeRevisionId).toBe(f.catalog.revisionId);
    });

    it('keeps a placed new photograph out of "requires judgment", counting as `curation list` does', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0]), fx.fact('new', fx.fresh[1])]);
        // The owner put the first photo in a series by hand, so its item is settled by placement.
        const draft = (await readAuthoredRecord(f.root, 'series', DRAFT))!;
        await writeAuthoredRecord({ ...draft, photoIds: [...draft.photoIds, f.fresh[0]] }, { expectedVersion: draft.version, root: f.root });
        const view = ready(await loadInbox(null));
        const placed = view.items.find((item) => item.photoId === f.fresh[0])!;
        expect(placed).toMatchObject({ group: 'placed', placedBy: `its photo is in the series ${DRAFT}` });
        expect(view.items.find((item) => item.photoId === f.fresh[1])?.group).toBe('judgment');
        expect(view).toMatchObject({ needsJudgment: 1, placed: 1, unplaced: 0 });
        expect(summaryText(view)).toBe('1 of 2 items requires judgment, 1 already placed');
        const listed = JSON.parse((await runCurationCli(['list', '--json'], { dataRoot: f.root })).output);
        expect({ needsJudgment: listed.needsJudgment, placed: listed.placed, unplaced: listed.unplaced }).toEqual({ needsJudgment: view.needsJudgment, placed: view.placed, unplaced: view.unplaced });
        expect(view.selected?.id).toBe(ids[1]);
    });

    it('shows an approval no longer placed the way `curation show` describes it', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        const event = (await readEvent(f.root, ids[0]))!;
        done(await runInboxAction('approve', itemForm(event, null, { series: DRAFT, decorative: 'off' })));
        // A rollback or a `sequence remove` takes it out of the series; the item still reads approved.
        const draft = (await readAuthoredRecord(f.root, 'series', DRAFT))!;
        await writeAuthoredRecord({ ...draft, photoIds: draft.photoIds.filter((id) => id !== f.fresh[0]) }, { expectedVersion: draft.version, root: f.root });
        const view = ready(await loadInbox(ids[0]));
        expect(view.selected).toMatchObject({ group: 'unplaced', unplacedSeries: DRAFT, title: 'Approved, no longer placed', can: { reopen: true } });
        expect(view).toMatchObject({ unplaced: 1, needsJudgment: 0 });
        expect(summaryText(view)).toBe('0 of 1 item requires judgment, 1 approved but no longer placed');
        const shown = (await runCurationCli(['show', ids[0]], { dataRoot: f.root })).output;
        expect(shown).toContain(`No longer placed: it was approved into ${DRAFT}`);
        const listed = JSON.parse((await runCurationCli(['list', '--json'], { dataRoot: f.root })).output);
        expect(listed.unplaced).toBe(view.unplaced);
    });

    it('shows source facts and suggestions apart, with no GPS, serial, curator-only EXIF, or host path', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])], { published: true, rules: { schemaVersion: 1, series: [{ seriesId: DRAFT, folders: ['trips'] }] } });
        const view = ready(await loadInbox(ids[0]));
        const detail = view.selected!;
        expect(detail).toMatchObject({ type: 'new', sourcePath: 'trips/harbor-1.jpg', status: 'open', can: { approve: true, edit: true, defer: true, dismiss: true, retry: false, reopen: false } });
        expect(detail.suggestions.series).toMatchObject({ value: DRAFT, confidence: expect.any(String), producedBy: expect.stringMatching(/^rules@/) });
        expect(detail.references).toEqual([]);
        // The fixture's derivatives are pending, so there is no preview.
        expect(detail.previewUrl).toBeNull();
        const text = JSON.stringify(view);
        for (const leaked of [String(GPS.latitude), String(GPS.longitude), SERIAL, 'Fixture Artist', '05:06:07', f.root, os.tmpdir()]) expect(text).not.toContain(leaked);
        expect(view.series.map((option) => option.id).sort()).toEqual([DRAFT, PUBLISHED].sort());
    });

    it('links a ready derivative set through the curator-only media route', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        const registry = await readRegistry(f.root);
        const event = (await readEvent(f.root, ids[0]))!;
        registry.photos[event.photoId!].revisions[event.assetRevision!].profiles[f.catalog.profileId] = { state: 'ready', attempts: 1 };
        await writeRegistry(f.root, registry, registry.version);
        const view = ready(await loadInbox(ids[0]));
        const detail = view.selected!;
        expect(detail.previewUrl).toBe(`/api/curation/media/${event.photoId}/${event.assetRevision}/${f.catalog.profileId}/w800.webp`);
        // Its row's thumbnail is the same set's smallest WebP, never the original.
        expect(view.items[0].thumbnailUrl).toBe(`/api/curation/media/${event.photoId}/${event.assetRevision}/${f.catalog.profileId}/w400.webp`);
    });

    it("prefers the current profile's set when an older profile's is ready too, whichever the registry lists first", async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        const registry = await readRegistry(f.root);
        const event = (await readEvent(f.root, ids[0]))!;
        const revision = registry.photos[event.photoId!].revisions[event.assetRevision!];
        const older = profileIdOf(PROFILE_1, { sharp: '0.0.1', vips: '0.0.1' });
        expect(older).not.toBe(f.catalog.profileId);
        revision.profiles = { [older]: { state: 'ready', attempts: 1 }, [f.catalog.profileId]: { state: 'ready', attempts: 1 } };
        await writeRegistry(f.root, registry, registry.version);
        const view = ready(await loadInbox(ids[0]));
        expect(view.selected!.previewUrl).toBe(`/api/curation/media/${event.photoId}/${event.assetRevision}/${f.catalog.profileId}/w800.webp`);
        expect(view.items[0].thumbnailUrl).toBe(`/api/curation/media/${event.photoId}/${event.assetRevision}/${f.catalog.profileId}/w400.webp`);
        // With only the older one ready, it's that one.
        revision.profiles = { [older]: { state: 'ready', attempts: 1 }, [f.catalog.profileId]: { state: 'pending', attempts: 0 } };
        await writeRegistry(f.root, registry, (await readRegistry(f.root)).version);
        expect(ready(await loadInbox(ids[0])).items[0].thumbnailUrl).toBe(`/api/curation/media/${event.photoId}/${event.assetRevision}/${older}/w400.webp`);
    });

    it('gives a row no thumbnail while no derivative set is ready, or when nothing was made from the file', async () => {
        const { ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0]), fx.fact('processing-failed', null, { reason: 'unsupported-format' })]);
        const view = ready(await loadInbox(ids[0]));
        expect(view.items).toHaveLength(2);
        // The fixture's derivatives are pending, and the failed file has no photo ID.
        expect(view.items.map((item) => item.thumbnailUrl)).toEqual([null, null]);
    });

    it('selects nothing when nothing needs judgment, so the page shows its empty state', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        const event = (await readEvent(f.root, ids[0]))!;
        expect(await deferEvent({ root: f.root, eventId: ids[0], expectedVersion: event.version, actor: 'curator:cli' })).toMatchObject({ ok: true });
        const view = ready(await loadInbox(null));
        expect(view.items.map((item) => item.group)).toEqual(['deferred']);
        expect(view).toMatchObject({ needsJudgment: 0, selected: null, missingSelection: null });
        // Asked for by ID, it still opens.
        expect(ready(await loadInbox(ids[0])).selected?.id).toBe(ids[0]);
    });

    it("shows a missing item #17 resolved without the unavailable recovery action, whose Decide later it doesn't offer", async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('missing', fx.catalog.photos[0].id)], { published: true });
        const stored = (await readEvent(f.root, ids[0]))!;
        expect(ready(await loadInbox(ids[0])).selected).toMatchObject({ type: 'missing', group: 'judgment', primaryUnavailable: expect.stringContaining('Decide later') });
        await withCurationLock(f.root, {}, (hold) => writeEvent(f.root, { ...stored, status: 'resolved' }, stored.version, hold));
        // Its source is back, so the page offers no Reopen either: reopened, it would say the source is missing (#17).
        expect(ready(await loadInbox(ids[0])).selected).toMatchObject({ type: 'missing', group: 'settled', primaryUnavailable: null, can: { defer: false, reopen: false } });
    });

    it("doesn't reopen a resolved missing item from the page, even from an old form, while `curation reopen` still does", async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('missing', fx.catalog.photos[0].id)], { published: true });
        const stored = (await readEvent(f.root, ids[0]))!;
        await withCurationLock(f.root, {}, (hold) => writeEvent(f.root, { ...stored, status: 'resolved' }, stored.version, hold));
        const resolved = (await readEvent(f.root, ids[0]))!;
        const before = layers(f.root);
        expect(await runInboxAction('reopen', itemForm(resolved, f.catalog.revisionId))).toMatchObject({
            status: 'refused',
            message: "Its source is back, so this item stays resolved, and the inbox doesn't reopen it. Nothing was written.",
        });
        expect(await readEvent(f.root, ids[0])).toMatchObject({ status: 'resolved', version: resolved.version });
        expect(layers(f.root)).toEqual(before);
        // The CLI keeps its own behaviour.
        const run = await runCurationCli(['reopen', ids[0], '--version', String(resolved.version), '--base', f.catalog.revisionId], { dataRoot: f.root });
        expect(run.exitCode).toBe(0);
        expect(await readEvent(f.root, ids[0])).toMatchObject({ status: 'open' });
    });

    it('drops the Decide later hint from a confirmed replacement, which offers no Decide later', async () => {
        const { f } = await inbox(() => [], { published: true });
        const registry = await readRegistry(f.root);
        const photo = registry.photos[f.catalog.photos[3].id];
        const next = `sha256-${'d'.repeat(64)}`;
        photo.revisions[next] = { ...Object.values(photo.revisions)[0], assetRevision: next };
        await writeRegistry(f.root, registry, registry.version);
        const replaced = f.fact('replaced', f.catalog.photos[3].id, { assetRevision: next });
        await createCurationSink({ root: f.root, logger: quiet })([replaced]);
        const id = eventIdOf(eventKey('replacement', replaced));
        expect(ready(await loadInbox(id)).selected).toMatchObject({ type: 'replacement', status: 'open', can: { defer: true }, primaryUnavailable: expect.stringContaining('Decide later') });
        const stored = (await readEvent(f.root, id))!;
        await withCurationLock(f.root, {}, (hold) => writeEvent(f.root, { ...stored, status: 'approved' }, stored.version, hold));
        expect(ready(await loadInbox(id)).selected).toMatchObject({ type: 'replacement', status: 'approved', group: 'settled', can: { defer: false }, primaryUnavailable: null });
    });

    it('lists an item #17 resolved as settled, with nothing to judge but Reopen, and reopens it from the page', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        const stored = (await readEvent(f.root, ids[0]))!;
        await withCurationLock(f.root, {}, (hold) => writeEvent(f.root, { ...stored, status: 'resolved' }, stored.version, hold));
        const view = ready(await loadInbox(ids[0]));
        expect(view.selected).toMatchObject({ status: 'resolved', group: 'settled', can: { approve: false, edit: false, defer: false, dismiss: false, retry: false, reopen: true } });
        expect(view).toMatchObject({ needsJudgment: 0, placed: 0, unplaced: 0 });
        // The page's Reopen takes it back, as `curation reopen` does.
        const event = (await readEvent(f.root, ids[0]))!;
        done(await runInboxAction('reopen', itemForm(event, null)));
        expect(await readEvent(f.root, ids[0])).toMatchObject({ status: 'open', version: event.version + 1 });
        expect(ready(await loadInbox(ids[0])).selected).toMatchObject({ group: 'judgment', can: { approve: true, reopen: false } });
        // A form sent for it after it was resolved hears so in page words.
        expect(pageWording(`The event ${ids[0]} is resolved, so it can't be approved. Reopen it first.`)).toBe("This item is resolved, so it can't be approved. Refresh the inbox.");
    });

    it('says so when the URL names an item the inbox lacks, and never echoes a malformed one', async () => {
        await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        expect(ready(await loadInbox(`evt_${'0'.repeat(24)}`))).toMatchObject({ selected: null, missingSelection: `evt_${'0'.repeat(24)}` });
        const odd = ready(await loadInbox('<script>'));
        expect(odd).toMatchObject({ selected: null, missingSelection: 'that item' });
        expect(JSON.stringify(odd)).not.toContain('<script>');
    });

    it('lists an unreadable event by ID without its path', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        fs.writeFileSync(path.join(eventDir(f.root, ids[0]), 'v2.json'), 'not json');
        const view = ready(await loadInbox(null));
        expect(view.items).toEqual([]);
        expect(view.problems).toEqual([{ id: ids[0], message: expect.stringMatching(/^invalid-json/) }]);
        expect(JSON.stringify(view)).not.toContain(f.root);
    });
});

describe('the form defaults', () => {
    const detail = (overrides: Partial<Parameters<typeof defaultPlacement>[0]> = {}) => ({
        edits: null,
        suggestions: {
            series: { value: DRAFT, confidence: 'high' as const, producedBy: 'rules@x', producedAt: '2026-01-01T00:00:00.000Z', evidence: [] },
            placement: { value: 'start' as const, confidence: 'low' as const, producedBy: 'rules@x', producedAt: '2026-01-01T00:00:00.000Z', evidence: [] },
        },
        ...overrides,
    });

    it('resolve the series and the position the way an approval would', () => {
        expect(defaultSeries(detail())).toBe(DRAFT);
        expect(defaultPlacement(detail(), DRAFT)).toBe('start');
        // Another series takes no suggested position of its own.
        expect(defaultPlacement(detail(), PUBLISHED)).toBe('end');
        const edited = detail({ edits: { seriesId: PUBLISHED, placement: { after: 'ph_x' }, editedAt: '2026-01-01T00:00:00.000Z', editedBy: 'me' } });
        expect(defaultSeries(edited)).toBe(PUBLISHED);
        expect(defaultPlacement(edited, PUBLISHED)).toEqual({ after: 'ph_x' });
        expect(defaultSeries(detail({ suggestions: { series: null, placement: null } }))).toBeUndefined();
    });

    it('round-trip a position through its form value, and refuse anything else', () => {
        const after = { after: 'ph_00000000-0000-4000-8000-000000000001' };
        for (const placement of ['start', 'end', after] as const) expect(parsePlacementValue(placementValue(placement))).toEqual(placement);
        for (const value of ['', 'middle', 'after:', 'after:../x', 'after:ph_1']) expect(parsePlacementValue(value)).toBeNull();
    });
});

describe('runInboxAction', () => {
    it('approves into the draft with the typed description as reviewed, and leaves catalog/ byte-identical', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])], { published: true });
        const event = (await readEvent(f.root, ids[0]))!;
        const before = layers(f.root).catalog;
        const state = await runInboxAction('approve', itemForm(event, f.catalog.revisionId, { series: DRAFT, placement: 'start', description: 'Harbor at first light, typed by the curator.' }));
        done(state);
        expect(layers(f.root).catalog).toEqual(before);
        const photo = await readAuthoredRecord(f.root, 'photo', event.photoId!);
        expect(photo?.alt).toEqual({ kind: 'described', text: 'Harbor at first light, typed by the curator.', reviewed: true });
        expect((await readAuthoredRecord(f.root, 'series', DRAFT))?.photoIds[0]).toBe(event.photoId);
        expect(await readEvent(f.root, ids[0])).toMatchObject({ status: 'approved', reviewedBy: WEB_ACTOR, version: 2 });
    });

    it('stores no description when the curator typed none, whatever else the form carries', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        const event = (await readEvent(f.root, ids[0]))!;
        // Fields the page never sends, as a forged post might: none of them reaches the action.
        const state = await runInboxAction('approve', itemForm(event, null, { series: DRAFT, alt: 'Generated text', reviewed: 'true', suggestedDescription: 'Generated text' }));
        done(state);
        expect(state).toMatchObject({ message: expect.stringMatching(/no description yet/) });
        expect((await readAuthoredRecord(f.root, 'photo', event.photoId!))?.alt).toBeNull();
    });

    it('stores the decorative flag as the description', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        const event = (await readEvent(f.root, ids[0]))!;
        done(await runInboxAction('approve', itemForm(event, null, { series: 'unassigned', decorative: 'on', description: 'ignored' })));
        expect((await readAuthoredRecord(f.root, 'photo', event.photoId!))?.alt).toEqual({ kind: 'decorative' });
    });

    it('clears a saved decorative flag the curator unchecks, so the description gate holds the photo back', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])], { published: true });
        let event = (await readEvent(f.root, ids[0]))!;
        done(await runInboxAction('edit', itemForm(event, f.catalog.revisionId, { decorative: 'on', description: '' })));
        event = (await readEvent(f.root, ids[0]))!;
        expect(event.edits?.description).toEqual({ kind: 'decorative' });
        // Unchecked: the page sends the box's state and that a description was saved.
        const unchecked = { decorative: 'off', description: '', descriptionWas: 'decorative' };
        done(await runInboxAction('edit', itemForm(event, f.catalog.revisionId, unchecked)));
        event = (await readEvent(f.root, ids[0]))!;
        expect(event.edits?.description).toBeNull();
        const approved = await runInboxAction('approve', itemForm(event, f.catalog.revisionId, { series: PUBLISHED, ...unchecked }));
        done(approved);
        // 14-1's note for #13's description gate. The e2e runs the gate itself on a catalog with ready assets.
        expect(approved).toMatchObject({ message: expect.stringMatching(/no description yet, so publishing it waits/) });
        expect((await readAuthoredRecord(f.root, 'photo', event.photoId!))?.alt).toBeNull();
    });

    it('clears a decorative flag on a reopened item, whose photo record already holds it', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])], { published: true });
        let event = (await readEvent(f.root, ids[0]))!;
        // Approved as decorative without saving edits first, then reopened.
        done(await runInboxAction('approve', itemForm(event, f.catalog.revisionId, { series: PUBLISHED, decorative: 'on' })));
        event = (await readEvent(f.root, ids[0]))!;
        done(await runInboxAction('reopen', itemForm(event, f.catalog.revisionId)));
        // The page fills the reopened form from the photo record.
        const detail = ready(await loadInbox(ids[0])).selected!;
        expect(detail.placed).toEqual({ alt: { kind: 'decorative' }, seriesIds: [PUBLISHED] });
        event = (await readEvent(f.root, ids[0]))!;
        const approved = await runInboxAction('approve', itemForm(event, f.catalog.revisionId, { series: PUBLISHED, decorative: 'off', description: '', descriptionWas: 'decorative' }));
        done(approved);
        expect(approved).toMatchObject({ message: expect.stringMatching(/no description yet/) });
        expect((await readAuthoredRecord(f.root, 'photo', event.photoId!))?.alt).toBeNull();
    });

    it('refuses to leave a reopened photo unassigned while a series still holds it, in page words', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        let event = (await readEvent(f.root, ids[0]))!;
        done(await runInboxAction('approve', itemForm(event, null, { series: DRAFT, decorative: 'off' })));
        event = (await readEvent(f.root, ids[0]))!;
        done(await runInboxAction('reopen', itemForm(event, null)));
        event = (await readEvent(f.root, ids[0]))!;
        expect(ready(await loadInbox(ids[0])).selected?.placed?.seriesIds).toEqual([DRAFT]);
        const state = await runInboxAction('approve', itemForm(event, null, { series: 'unassigned', decorative: 'off' }));
        expect(state).toMatchObject({ status: 'refused', message: expect.stringMatching(/already in a series/) });
        expect(state.status !== 'idle' && state.message).not.toMatch(/evt_|ph_|rev_|ser_|sha256-/);
        expect((await readEvent(f.root, ids[0]))?.version).toBe(event.version);
    });

    it('starts a reopened form from the working layer, not from a saved edit the approval overrode', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        let event = (await readEvent(f.root, ids[0]))!;
        done(await runInboxAction('edit', itemForm(event, null, { series: DRAFT, seriesTouched: '1', decorative: 'off', description: 'Saved A' })));
        event = (await readEvent(f.root, ids[0]))!;
        done(await runInboxAction('approve', itemForm(event, null, { series: PUBLISHED, decorative: 'off', description: 'Typed B', descriptionWas: 'described' })));
        event = (await readEvent(f.root, ids[0]))!;
        expect(event.edits?.seriesId).toBeUndefined();
        expect(event.edits?.description).toBeUndefined();
        done(await runInboxAction('reopen', itemForm(event, null)));
        const detail = ready(await loadInbox(ids[0])).selected!;
        expect(defaultSeries(detail)).toBe(PUBLISHED);
        expect(defaultDescription(detail)).toEqual({ kind: 'described', text: 'Typed B' });
    });

    it('takes the suggestion on a first approval, from the CLI and the page alike, even when a series already holds the photo', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])], { rules: { schemaVersion: 1, series: [{ seriesId: DRAFT, folders: ['trips'] }] } });
        const event = (await readEvent(f.root, ids[0]))!;
        // The owner put it in the published series by hand before anyone approved it.
        const published = (await readAuthoredRecord(f.root, 'series', PUBLISHED))!;
        await writeAuthoredRecord({ ...published, photoIds: [...published.photoIds, event.photoId!] }, { expectedVersion: published.version, root: f.root });
        expect(defaultSeries(ready(await loadInbox(ids[0])).selected!)).toBe(DRAFT);
        const result = await approveEvent({ root: f.root, eventId: event.id, expectedVersion: event.version, actor: 'curator:cli', choices: {} });
        expect(result).toMatchObject({ ok: true });
        expect(result.ok && result.event.decisions.at(-1)?.seriesId).toBe(DRAFT);
    });

    it('keeps a reopened item that was approved unassigned unassigned, unless a series now holds it', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])], { rules: { schemaVersion: 1, series: [{ seriesId: DRAFT, folders: ['trips'] }] } });
        let event = (await readEvent(f.root, ids[0]))!;
        done(await runInboxAction('approve', itemForm(event, null, { series: 'unassigned', decorative: 'off' })));
        event = (await readEvent(f.root, ids[0]))!;
        done(await runInboxAction('reopen', itemForm(event, null)));
        event = (await readEvent(f.root, ids[0]))!;
        expect(defaultSeries(ready(await loadInbox(ids[0])).selected!)).toBeNull();
        expect(formSeries(ready(await loadInbox(ids[0])).selected!, [DRAFT, PUBLISHED])).toBeNull();
        const again = await approveEvent({ root: f.root, eventId: event.id, expectedVersion: event.version, actor: 'curator:cli', choices: {} });
        expect(again.ok && again.event.decisions.at(-1)?.seriesId).toBeNull();
        expect((await readAuthoredRecord(f.root, 'series', DRAFT))?.photoIds).not.toContain(event.photoId);
        // Once a series holds it, a reopen starts from that series.
        const reopened = (await reopenEvent({ root: f.root, eventId: event.id, expectedVersion: event.version + 1, actor: 'curator:cli' }));
        expect(reopened).toMatchObject({ ok: true });
        const draft = (await readAuthoredRecord(f.root, 'series', DRAFT))!;
        await writeAuthoredRecord({ ...draft, photoIds: [...draft.photoIds, event.photoId!] }, { expectedVersion: draft.version, root: f.root });
        expect(defaultSeries(ready(await loadInbox(ids[0])).selected!)).toBe(DRAFT);
    });

    it("refuses a bare re-approve from the CLI when the series that might hold the photo can't be read, rather than recording it unassigned", async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        let event = (await readEvent(f.root, ids[0]))!;
        expect((await approveEvent({ root: f.root, eventId: event.id, expectedVersion: event.version, actor: 'curator:cli', choices: { seriesId: DRAFT } })).ok).toBe(true);
        event = (await readEvent(f.root, ids[0]))!;
        expect((await reopenEvent({ root: f.root, eventId: event.id, expectedVersion: event.version, actor: 'curator:cli' })).ok).toBe(true);
        event = (await readEvent(f.root, ids[0]))!;
        // The newest version of the series that holds it can't be read, so nothing shows the photo is free.
        const dir = authoredRecordDir(f.root, 'series', DRAFT);
        const newest = Math.max(...fs.readdirSync(dir).filter((name) => /^v\d+\.json$/.test(name)).map((name) => Number(name.slice(1, -5))));
        fs.writeFileSync(path.join(dir, `v${newest + 1}.json`), '{ not json');
        const before = layers(f.root);
        const again = await approveEvent({ root: f.root, eventId: event.id, expectedVersion: event.version, actor: 'curator:cli', choices: {} });
        expect(again).toMatchObject({ ok: false, code: 'refused', message: expect.stringMatching(new RegExp(`${DRAFT} can't be read`)) });
        expect(layers(f.root)).toEqual(before);
        expect(await readEvent(f.root, ids[0])).toMatchObject({ status: 'open', version: event.version });
    });

    it('reads the series that hold the photo under the authored lock, so a bare re-approve sees a removal made while it waited', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])], { rules: { schemaVersion: 1, series: [{ seriesId: DRAFT, folders: ['trips'] }] } });
        let event = (await readEvent(f.root, ids[0]))!;
        expect((await approveEvent({ root: f.root, eventId: event.id, expectedVersion: event.version, actor: 'curator:cli', choices: {} })).ok).toBe(true);
        event = (await readEvent(f.root, ids[0]))!;
        expect((await reopenEvent({ root: f.root, eventId: event.id, expectedVersion: event.version, actor: 'curator:cli' })).ok).toBe(true);
        event = (await readEvent(f.root, ids[0]))!;
        const photoId = event.photoId!;
        let pending: ReturnType<typeof approveEvent> | undefined;
        await withLock(AUTHORED_LOCK, { root: f.root }, async (lock) => {
            pending = approveEvent({ root: f.root, eventId: event.id, expectedVersion: event.version, actor: 'curator:cli', choices: {}, waitMs: 10_000 });
            // Long enough for an approval that read the series before taking the lock to have read them.
            await new Promise((resolve) => setTimeout(resolve, 500));
            const draft = (await readAuthoredRecord(f.root, 'series', DRAFT))!;
            expect(draft.photoIds).toContain(photoId);
            await writeAuthoredRecord({ ...draft, photoIds: draft.photoIds.filter((id) => id !== photoId) }, { expectedVersion: draft.version, lock, root: f.root });
        });
        const again = await pending!;
        expect(again).toMatchObject({ ok: true });
        expect(again.ok && again.event.decisions.at(-1)?.seriesId).toBeNull();
        expect((await readAuthoredRecord(f.root, 'series', DRAFT))?.photoIds).not.toContain(photoId);
    });

    it('starts a first approval on the suggestion even when a photo record and a series already hold the photo', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])], { rules: { schemaVersion: 1, series: [{ seriesId: DRAFT, folders: ['trips'] }] } });
        const event = (await readEvent(f.root, ids[0]))!;
        // Written outside the inbox, with no approval on this item: the page sees a photo record and the series holding it.
        await writeAuthoredRecord({ kind: 'photo', id: event.photoId!, assetRevision: event.assetRevision!, alt: null }, { expectedVersion: 0, root: f.root });
        const published = (await readAuthoredRecord(f.root, 'series', PUBLISHED))!;
        await writeAuthoredRecord({ ...published, photoIds: [...published.photoIds, event.photoId!] }, { expectedVersion: published.version, root: f.root });
        const detail = ready(await loadInbox(ids[0])).selected!;
        expect(detail.placed?.seriesIds).toEqual([PUBLISHED]);
        expect(defaultSeries(detail)).toBe(DRAFT);
    });

    it('starts the reopened form of an approval no longer placed on the series it was approved into, while a bare CLI approve stays unassigned', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        let event = (await readEvent(f.root, ids[0]))!;
        done(await runInboxAction('approve', itemForm(event, null, { series: DRAFT, decorative: 'off' })));
        // A sequence remove takes it out of the series, so nothing holds the photo now.
        const draft = (await readAuthoredRecord(f.root, 'series', DRAFT))!;
        await writeAuthoredRecord({ ...draft, photoIds: draft.photoIds.filter((id) => id !== event.photoId) }, { expectedVersion: draft.version, root: f.root });
        let detail = ready(await loadInbox(ids[0])).selected!;
        expect(detail).toMatchObject({ group: 'unplaced', unplacedSeries: DRAFT, lastApprovedSeries: DRAFT });
        event = (await readEvent(f.root, ids[0]))!;
        done(await runInboxAction('reopen', itemForm(event, null)));
        const view = ready(await loadInbox(ids[0]));
        detail = view.selected!;
        expect(detail.unplacedSeries).toBeNull();
        expect(defaultSeries(detail)).toBeNull();
        expect(formSeries(detail, view.series.map((option) => option.id))).toBe(DRAFT);
        // Not once the series is gone from the options, and not over a saved "Leave unassigned".
        expect(formSeries(detail, [])).toBeNull();
        expect(formSeries({ ...detail, edits: { seriesId: null, editedAt: detail.observedAt, editedBy: WEB_ACTOR } }, [DRAFT])).toBeNull();
        // The form sends what it shows, so the page approves into the series; the CLI's bare approve keeps to the working layer.
        event = (await readEvent(f.root, ids[0]))!;
        const cli = await approveEvent({ root: f.root, eventId: event.id, expectedVersion: event.version, actor: 'curator:cli', choices: {} });
        expect(cli.ok && cli.event.decisions.at(-1)?.seriesId).toBeNull();
    });

    it('logs a failed action without the data root path', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        const event = (await readEvent(f.root, ids[0]))!;
        const registry = path.join(f.root, 'identity', 'registry');
        const newest = Math.max(...fs.readdirSync(registry).filter((name) => /^v\d+\.json$/.test(name)).map((name) => Number(name.slice(1, -5))));
        fs.writeFileSync(path.join(registry, `v${newest + 1}.json`), '{ not json');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const state = await runInboxAction('approve', itemForm(event, null, { series: DRAFT, decorative: 'off' }));
            expect(state).toMatchObject({ status: 'failed' });
            const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n');
            expect(logged).toContain('[curation]');
            expect(logged).not.toContain(f.root);
        } finally {
            warn.mockRestore();
        }
    });

    it("refuses an unassigned approval when a series that might hold the photo can't be read", async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        let event = (await readEvent(f.root, ids[0]))!;
        done(await runInboxAction('approve', itemForm(event, null, { series: DRAFT, decorative: 'off' })));
        event = (await readEvent(f.root, ids[0]))!;
        done(await runInboxAction('reopen', itemForm(event, null)));
        event = (await readEvent(f.root, ids[0]))!;
        const dir = authoredRecordDir(f.root, 'series', DRAFT);
        const newest = Math.max(...fs.readdirSync(dir).filter((name) => /^v\d+\.json$/.test(name)).map((name) => Number(name.slice(1, -5))));
        fs.writeFileSync(path.join(dir, `v${newest + 1}.json`), '{ not json');
        const state = await runInboxAction('approve', itemForm(event, null, { series: 'unassigned', decorative: 'off' }));
        expect(state).toMatchObject({ status: 'refused', message: expect.stringMatching(/can't be read/) });
        expect(state.status !== 'idle' && state.message).not.toMatch(/evt_|ph_|rev_|ser_|sha256-/);
        expect((await readEvent(f.root, ids[0]))?.version).toBe(event.version);
    });

    it('answers stale and other refusals without internal IDs or CLI phrasing', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])], { published: true });
        const event = (await readEvent(f.root, ids[0]))!;
        const answers = [
            await runInboxAction('defer', itemForm({ ...event, version: 99 }, f.catalog.revisionId)),
            await runInboxAction('defer', itemForm(event, `rev_${'0'.repeat(64)}`)),
            await runInboxAction('retry', itemForm(event, f.catalog.revisionId)),
            await runInboxAction('approve', itemForm(event, f.catalog.revisionId, { series: 'ser_nope-nope', decorative: 'off' })),
            await runInboxAction('reopen', itemForm(event, f.catalog.revisionId)),
        ];
        expect(answers.map((state) => state.status)).toEqual(['stale', 'stale', 'refused', 'refused', 'refused']);
        for (const state of answers) expect(state.status !== 'idle' && state.message).not.toMatch(/evt_|ph_|rev_|ser_|sha256-|Show it again|--[a-z]/);
    });

    it('approves "Leave unassigned" when no rules file suggests a series and the page shows it as the choice', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        const event = (await readEvent(f.root, ids[0]))!;
        expect(event.suggestions.series?.value).toBeNull();
        done(await runInboxAction('approve', itemForm(event, null, { series: 'unassigned', decorative: 'off' })));
        expect(await readEvent(f.root, ids[0])).toMatchObject({ status: 'approved', decisions: [expect.objectContaining({ action: 'approve', seriesId: null })] });
    });

    it('answers a missing choice in page wording, never with CLI flags', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        const event = (await readEvent(f.root, ids[0]))!;
        const state = await runInboxAction('approve', itemForm(event, null));
        expect(state).toMatchObject({ status: 'invalid' });
        expect(state.status !== 'idle' && state.message).not.toMatch(/--[a-z]/);
        expect(state.status !== 'idle' && state.message).toMatch(/Choose a series/);
    });

    it('names the description field when it refuses the description, and the reason field for a reason', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        const event = (await readEvent(f.root, ids[0]))!;
        const refused = await runInboxAction('approve', itemForm(event, null, { series: DRAFT, decorative: 'off', description: '<b>Harbor</b>' }));
        expect(refused).toMatchObject({ status: 'invalid', field: 'description', message: expect.stringMatching(/markup/) });
        expect(await runInboxAction('dismiss', itemForm(event, null, { reason: '<i>dup</i>' }))).toMatchObject({ status: 'invalid', field: 'reason' });
        // A refusal that isn't about one field names none.
        expect(await runInboxAction('approve', itemForm(event, null))).not.toHaveProperty('field');
        expect(await readEvent(f.root, ids[0])).toEqual(event);
    });

    it('counts a series on Save edits only when the curator changed it', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        const event = (await readEvent(f.root, ids[0]))!;
        expect(await runInboxAction('edit', itemForm(event, null, { series: 'unassigned', decorative: 'off' }))).toMatchObject({ status: 'invalid', message: /Nothing changed/ });
        done(await runInboxAction('edit', itemForm(event, null, { series: DRAFT, seriesTouched: '1', decorative: 'off' })));
        expect((await readEvent(f.root, ids[0]))?.edits?.seriesId).toBe(DRAFT);
    });

    it('takes the suggestion as it stands when the curator changes nothing', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])], { rules: { schemaVersion: 1, series: [{ seriesId: DRAFT, folders: ['trips'] }] } });
        const event = (await readEvent(f.root, ids[0]))!;
        done(await runInboxAction('approve', itemForm(event, null)));
        expect((await readAuthoredRecord(f.root, 'series', DRAFT))?.photoIds).toContain(event.photoId);
    });

    it('is stale, and writes nothing, when the item moved since the page loaded', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        const shown = (await readEvent(f.root, ids[0]))!;
        // Another curator, or the CLI, acts first.
        expect(await deferEvent({ root: f.root, eventId: shown.id, expectedVersion: shown.version, actor: 'curator:cli' })).toMatchObject({ ok: true });
        const before = { ...layers(f.root), event: folderBytes(eventDir(f.root, shown.id)) };
        const state = await runInboxAction('approve', itemForm(shown, null, { series: DRAFT, description: 'Typed.' }));
        expect(state).toMatchObject({ status: 'stale', eventId: shown.id, message: expect.stringMatching(/changed since the page loaded/) });
        expect({ ...layers(f.root), event: folderBytes(eventDir(f.root, shown.id)) }).toEqual(before);
    });

    it('is stale, and writes nothing, when a publish moved the active revision', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])], { published: true });
        const event = (await readEvent(f.root, ids[0]))!;
        const before = { ...layers(f.root), event: folderBytes(eventDir(f.root, event.id)) };
        const state = await runInboxAction('defer', itemForm(event, null));
        expect(state).toMatchObject({ status: 'stale' });
        expect({ ...layers(f.root), event: folderBytes(eventDir(f.root, event.id)) }).toEqual(before);
    });

    it('is busy, and writes nothing, while another writer holds the curation lock', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        const event = (await readEvent(f.root, ids[0]))!;
        const state = await withCurationLock(f.root, { leaseMs: 60_000 }, () => runInboxAction('defer', itemForm(event, null), { waitMs: 200 }));
        expect(state).toMatchObject({ status: 'busy' });
        expect((await readEvent(f.root, ids[0]))?.version).toBe(1);
    });

    it('defers, dismisses with a reason, and reopens, each against the version it saw', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        let event = (await readEvent(f.root, ids[0]))!;
        done(await runInboxAction('defer', itemForm(event, null)));
        event = (await readEvent(f.root, ids[0]))!;
        expect(event.status).toBe('deferred');
        expect(await runInboxAction('dismiss', itemForm(event, null, { reason: '  ' }))).toMatchObject({ status: 'invalid', message: 'Dismissing needs a reason.' });
        done(await runInboxAction('dismiss', itemForm(event, null, { reason: 'A duplicate of a frame already in the series.' })));
        event = (await readEvent(f.root, ids[0]))!;
        expect(event).toMatchObject({ status: 'dismissed', decisions: [expect.anything(), expect.objectContaining({ action: 'dismiss', reason: 'A duplicate of a frame already in the series.' })] });
        done(await runInboxAction('reopen', itemForm(event, null)));
        expect((await readEvent(f.root, ids[0]))?.status).toBe('open');
    });

    it('saves edits without touching the working layer', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        const event = (await readEvent(f.root, ids[0]))!;
        const before = layers(f.root);
        expect(await runInboxAction('edit', itemForm(event, null))).toMatchObject({ status: 'invalid', message: /Nothing changed/ });
        done(await runInboxAction('edit', itemForm(event, null, { series: DRAFT, seriesTouched: '1', placement: 'end', description: 'Saved for later.' })));
        expect(layers(f.root)).toEqual(before);
        expect((await readEvent(f.root, ids[0]))?.edits).toMatchObject({ seriesId: DRAFT, placement: 'end', description: { kind: 'described', text: 'Saved for later.' }, editedBy: WEB_ACTOR });
    });

    it('asks the watcher to retry an undecodable file', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('processing-failed', fx.fresh[0], { reason: 'undecodable' })]);
        const detail = ready(await loadInbox(ids[0])).selected!;
        expect(detail.can.retry).toBe(true);
        const event = (await readEvent(f.root, ids[0]))!;
        done(await runInboxAction('retry', itemForm(event, null)));
        expect(fs.readdirSync(path.join(f.root, 'identity', 'decisions')).filter((name) => name.endsWith('.json'))).toHaveLength(1);
    });

    it('refuses to dismiss a missing photograph a series still shows, and says why', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('missing', fx.catalog.photos[0].id)], { published: true });
        const event = (await readEvent(f.root, ids[0]))!;
        expect(ready(await loadInbox(ids[0])).selected?.can).toMatchObject({ dismiss: false, defer: true });
        const state = await runInboxAction('dismiss', itemForm(event, f.catalog.revisionId, { reason: 'Gone.' }));
        expect(state).toMatchObject({ status: 'refused', message: expect.stringMatching(/can't be dismissed/) });
        expect((await readEvent(f.root, ids[0]))?.version).toBe(1);
    });

    it.each([
        ['no event', { version: '1', base: 'none' }],
        ['a malformed event ID', { eventId: '../evt', version: '1', base: 'none' }],
        ['no version', { eventId: `evt_${'0'.repeat(24)}`, base: 'none' }],
        ['a malformed base', { eventId: `evt_${'0'.repeat(24)}`, version: '1', base: 'rev_x' }],
    ])('refuses a form with %s before reading anything', async (_label, fields) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-form-'));
        cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
        writeDataRootMarker(root);
        cleanups.push(setDataDir(root));
        expect(await runInboxAction('defer', form(fields))).toMatchObject({ status: 'invalid' });
        expect(fs.readdirSync(root)).toEqual(['data-root.json']);
    });

    it('refuses an unknown series and a position for another photograph ID shape', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        const event = (await readEvent(f.root, ids[0]))!;
        expect(await runInboxAction('approve', itemForm(event, null, { series: '../../etc' }))).toMatchObject({ status: 'invalid' });
        expect(await runInboxAction('approve', itemForm(event, null, { series: DRAFT, placement: 'after:ph_nope' }))).toMatchObject({ status: 'invalid' });
        expect(await runInboxAction('approve', itemForm(event, null, { series: 'ser_not-there' }))).toMatchObject({ status: 'refused' });
        expect((await readEvent(f.root, ids[0]))?.version).toBe(1);
    });

    it('answers with no host path, even for a damaged event', async () => {
        const { f, ids } = await inbox((fx) => [fx.fact('new', fx.fresh[0])]);
        const event = (await readEvent(f.root, ids[0]))!;
        fs.writeFileSync(path.join(eventDir(f.root, ids[0]), 'v2.json'), 'not json');
        const state = await runInboxAction('defer', itemForm(event, null));
        expect(state).toMatchObject({ status: 'failed' });
        expect(JSON.stringify(state)).not.toContain(f.root);
    });
});

/**
 * #118: Confirm, Bind and Archive from the page, on #17's worlds (real images, #10's writer and passes, #13's
 * publish), through runInboxAction() as the server actions call it once requireCurator() lets them in. Each answer
 * is the page's: no host path, internal ID, CLI flag or command.
 */
describe('confirm, bind and archive from the page (#118)', { timeout: 60_000 }, () => {
    let images: Images;

    beforeAll(async () => {
        images = await makeImages();
    }, 60_000);

    afterAll(() => {
        removeTemplate();
        removeMissingTemplate();
    });

    async function replacement(): Promise<World> {
        const w = await createWorld(images);
        cleanups.push(() => w.cleanup());
        return w;
    }

    async function missing(): Promise<MissingWorld> {
        const w = await createMissingWorld(images);
        cleanups.push(() => w.cleanup());
        return w;
    }

    const shown = async (id: string) => ready(await loadInbox(id)).selected!;
    /** #10's decisions waiting for the watcher's next pass. */
    const pendingDecisions = (root: string) => {
        const dir = identityPaths(root).decisions;
        return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))) : [];
    };
    /** Everything an action could write: the catalog, the working layer, the inbox, and #10's decisions. */
    const written = (root: string) => ({ ...layers(root), curation: folderBytes(path.join(root, 'curation')), decisions: pendingDecisions(root) });

    /** The answer, as the page would show it: no host path, internal ID, CLI flag or command, and no generic fallback. */
    function inPageWords(state: InboxActionState, roots: string[]): string {
        if (state.status === 'idle') throw new Error('No answer');
        for (const root of roots) expect(JSON.stringify(state)).not.toContain(root);
        expect(JSON.stringify(state)).not.toContain(os.tmpdir());
        expect(state.message).not.toMatch(/\b(evt|ph|rev|ser|act|fp)_[0-9a-z]|sha256-|(^|\s)--[a-z]|\bphotos (identity|publish|curation)\b|\bcuration (show|bind|archive|confirm)\b|Show it again|#10/);
        expect(state.message).not.toMatch(/can't do that with this item as it stands|needs another choice first/);
        return state.message;
    }

    describe('Confirm on a replacement', () => {
        it('is offered once the new derivatives are built, and says why it waits before then', async () => {
            const w = await replacement();
            const building = await shown(w.eventId);
            expect(building).toMatchObject({ type: 'replacement', group: 'waiting', can: { confirm: false, defer: true }, confirmUnavailable: CONFIRM_UNAVAILABLE.building });
            await w.build(w.job(w.b));
            const built = await shown(w.eventId);
            expect(built).toMatchObject({ group: 'judgment', can: { confirm: true, defer: true, bind: false, archive: false }, confirmUnavailable: null, primaryUnavailable: REPLACEMENT_HINT.keeps });
            // A failed build has nothing to confirm.
            const registry = await readRegistry(w.root);
            registry.photos[w.p].revisions[w.b].profiles[w.profileId] = { state: 'failed', attempts: 3, error: 'fixture' };
            await writeRegistry(w.root, registry, registry.version);
            expect(await shown(w.eventId)).toMatchObject({ can: { confirm: false }, confirmUnavailable: CONFIRM_UNAVAILABLE.failed });
        });

        it('puts the new version in the draft only, keeping everything public, and then offers Reopen alone', async () => {
            const w = await replacement();
            await w.build(w.job(w.b));
            const visible = await served(w);
            const catalog = layers(w.root).catalog;
            const event = await w.event();
            const state = await runInboxAction('confirm', itemForm(event, w.revisionId));
            expect(state).toMatchObject({ status: 'done', action: 'confirm', eventId: w.eventId, message: DONE_ANSWER.confirm });
            inPageWords(state, [w.root, w.lib.root]);
            expect((await photoRecord(w)).assetRevision).toBe(w.b);
            expect(await w.event()).toMatchObject({ status: 'approved', reviewedBy: WEB_ACTOR, decisions: expect.arrayContaining([expect.objectContaining({ action: 'confirm', fromRevision: w.a })]) });
            expect(layers(w.root).catalog).toEqual(catalog);
            expect(await served(w)).toEqual(visible);
            expect(await shown(w.eventId)).toMatchObject({ status: 'approved', can: { confirm: false, defer: false, reopen: true }, confirmUnavailable: null });
            // Once more from the same page: the item moved on, so nothing is written.
            const again = await runInboxAction('confirm', itemForm(event, w.revisionId));
            expect(again).toMatchObject({ status: 'stale' });
        });

        it('offers no Confirm on a settled replacement, and an open one with no photo record says why without promising Confirm', async () => {
            const w = await replacement();
            await w.build(w.job(w.b));
            fs.rmSync(authoredRecordDir(w.root, 'photo', w.p), { recursive: true, force: true });
            const open = await shown(w.eventId);
            expect(open).toMatchObject({ can: { confirm: false }, confirmUnavailable: CONFIRM_UNAVAILABLE.noRecord, primaryUnavailable: REPLACEMENT_HINT.noRecord });
            expect(open.primaryUnavailable).not.toMatch(/Confirm/);
            const stored = await w.event();
            await withCurationLock(w.root, {}, (hold) => writeEvent(w.root, { ...stored, status: 'dismissed' }, stored.version, hold));
            expect(await shown(w.eventId)).toMatchObject({ status: 'dismissed', can: { confirm: false }, confirmUnavailable: null });
        });

        it('refuses one whose derivatives are still building, in page words, writing nothing', async () => {
            const w = await replacement();
            const before = written(w.root);
            const state = await runInboxAction('confirm', itemForm(await w.event(), w.revisionId));
            expect(state).toMatchObject({ status: 'refused', message: `${CONFIRM_UNAVAILABLE.building} Nothing was written.` });
            inPageWords(state, [w.root, w.lib.root]);
            expect(written(w.root)).toEqual(before);
        });

        it('turns one away, writing nothing, when the item, the active revision, or the lock moved since the page loaded', async () => {
            const w = await replacement();
            await w.build(w.job(w.b));
            const event = await w.event();
            const before = written(w.root);
            const answers = [
                await runInboxAction('confirm', itemForm({ ...event, version: event.version + 4 }, w.revisionId)),
                await runInboxAction('confirm', itemForm(event, `rev_${'0'.repeat(64)}`)),
                await withCurationLock(w.root, { leaseMs: 60_000 }, () => runInboxAction('confirm', itemForm(event, w.revisionId), { waitMs: 200 })),
            ];
            expect(answers.map((state) => state.status)).toEqual(['stale', 'stale', 'busy']);
            expect(answers[0]).toMatchObject({ message: expect.stringMatching(/changed since the page loaded/) });
            expect(answers[1]).toMatchObject({ message: expect.stringMatching(/A publish or rollback happened/) });
            for (const state of answers) inPageWords(state, [w.root, w.lib.root]);
            expect(written(w.root)).toEqual(before);
            expect((await photoRecord(w)).assetRevision).toBe(w.a);
        });
    });

    describe('Bind and Archive on a missing source', () => {
        const removeP = (w: MissingWorld) => fs.rmSync(w.lib.file(P_PATH));
        /** P deleted, then other pixels saved at its path, which link to P's missing item. */
        async function otherBytes(w: MissingWorld): Promise<void> {
            removeP(w);
            await w.pass();
            fs.writeFileSync(w.lib.file(P_PATH), images.third);
            await w.pass();
        }

        it('are offered on an open missing item, with the file at its last path linked for Bind', async () => {
            const w = await missing();
            removeP(w);
            await w.pass();
            expect(await shown(w.missingId)).toMatchObject({ type: 'missing', can: { bind: true, archive: true, defer: true, dismiss: false, confirm: false }, linkedFiles: [], primaryUnavailable: MISSING_HINT.open });
            fs.writeFileSync(w.lib.file(P_PATH), images.third);
            await w.pass();
            const linkedItem = (await listEvents(w.root)).events.find((entry) => entry.type === 'new' && entry.derivedFacts.samePathAs === w.p)!;
            expect(await shown(w.missingId)).toMatchObject({ can: { bind: true, archive: true }, linkedFiles: [{ id: linkedItem.id, path: P_PATH }] });
        });

        it('binds the linked file, and the item stays open, waiting for the watcher, with Archive refused until then', async () => {
            const w = await missing();
            await otherBytes(w);
            const event = await w.event(w.missingId);
            const catalog = layers(w.root).catalog;
            const [linked] = (await shown(w.missingId)).linkedFiles;
            const state = await runInboxAction('bind', itemForm(event, w.revisionId, { bindTo: linked.id }));
            expect(state).toMatchObject({ status: 'done', action: 'bind', message: bindAnswer(P_PATH, false) });
            inPageWords(state, [w.root, w.lib.root]);
            // Not done: the watcher applies it, so the item is open until its next pass.
            expect(await w.event(w.missingId)).toMatchObject({ status: 'open', version: event.version + 1, decisions: expect.arrayContaining([expect.objectContaining({ action: 'bind', path: P_PATH, by: WEB_ACTOR })]) });
            expect(pendingDecisions(w.root)).toEqual([expect.objectContaining({ type: 'bind', path: P_PATH, photoId: w.p })]);
            expect(layers(w.root).catalog).toEqual(catalog);
            const waiting = await shown(w.missingId);
            expect(waiting).toMatchObject({ status: 'open', group: 'judgment', bindWaiting: { kind: 'bind', path: P_PATH }, can: { bind: false, archive: false, defer: true }, primaryUnavailable: MISSING_HINT.bindWaiting });

            // Archive while the bind waits: refused, and nothing is written.
            const before = written(w.root);
            const archived = await runInboxAction('archive', itemForm(await w.event(w.missingId), w.revisionId, { reason: 'Gone for good.', confirmed: 'yes' }));
            expect(archived).toMatchObject({ status: 'refused', message: "A bind waiting for the watcher's next pass gives this photograph a file, so it can't be archived yet. Refresh after the watcher runs, and archive it then if the bind didn't go through. Nothing was written." });
            inPageWords(archived, [w.root, w.lib.root]);
            expect(written(w.root)).toEqual(before);

            // The watcher's next pass applies the bind and closes the item.
            await w.pass();
            expect(await shown(w.missingId)).toMatchObject({ status: 'resolved', resolvedBy: { kind: 'bound' }, can: { bind: false, archive: false } });
        });

        it('binds a typed library path the watcher has seen', async () => {
            const w = await missing();
            removeP(w);
            await w.pass();
            fs.writeFileSync(w.lib.file('harbor/elsewhere.jpg'), images.third);
            await w.pass();
            const state = await runInboxAction('bind', itemForm(await w.event(w.missingId), w.revisionId, { bindTo: 'typed', path: '  harbor/elsewhere.jpg ' }));
            expect(state).toMatchObject({ status: 'done', message: bindAnswer('harbor/elsewhere.jpg', false) });
            expect(pendingDecisions(w.root)).toEqual([expect.objectContaining({ type: 'bind', path: 'harbor/elsewhere.jpg', photoId: w.p })]);
        });

        it('refuses a typed path outside the library, one the watcher has not seen, and none at all, by the path field, writing nothing', async () => {
            const w = await missing();
            removeP(w);
            await w.pass();
            fs.writeFileSync(w.lib.file('harbor/elsewhere.jpg'), images.third);
            const event = await w.event(w.missingId);
            const before = written(w.root);
            const outside = "That isn't a path inside the library. Type it from the library's top folder, such as harbor/landscape.jpg. Nothing was written.";
            for (const typed of ['../outside.jpg', `${w.lib.root}/harbor/elsewhere.jpg`, '/etc/hosts', 'harbor//elsewhere.jpg', './harbor/elsewhere.jpg', 'harbor/../harbor/elsewhere.jpg', 'harbor/\0.jpg']) {
                const state = await runInboxAction('bind', itemForm(event, w.revisionId, { bindTo: 'typed', path: typed }));
                expect(state, typed).toMatchObject({ status: 'invalid', field: 'path', message: outside });
                inPageWords(state, [w.root, w.lib.root]);
            }
            expect(await runInboxAction('bind', itemForm(event, w.revisionId, { bindTo: 'typed', path: '  ' }))).toMatchObject({
                status: 'invalid',
                field: 'path',
                message: "Type the library path of the file that replaces it. Nothing was written.",
            });
            // In the library, but not a file the watcher has seen yet.
            const unseen = await runInboxAction('bind', itemForm(event, w.revisionId, { bindTo: 'typed', path: 'harbor/elsewhere.jpg' }));
            expect(unseen).toMatchObject({ status: 'refused', field: 'path', message: "The watcher hasn't seen a photograph at that path. Check it, or wait for the watcher's next pass after copying the file there. Nothing was written." });
            // Nothing is linked, and no path is typed.
            const none = await runInboxAction('bind', itemForm(event, w.revisionId));
            expect(none).toMatchObject({ status: 'invalid', field: 'path', message: 'No file is linked to this photograph. Type the library path of the file that replaces it. Nothing was written.' });
            for (const state of [unseen, none]) inPageWords(state, [w.root, w.lib.root]);
            expect(written(w.root)).toEqual(before);
        });

        it('binds one of several linked files whose names hold a backslash or a bidi control, by the item the page names, never its escaped path', async () => {
            for (const name of ['harbor/back\\slash.jpg', 'harbor/\u202Egpj.jpg']) {
                const w = await missing();
                removeP(w);
                await w.pass();
                fs.writeFileSync(w.lib.file(name), images.third);
                fs.writeFileSync(w.lib.file('harbor/plain.jpg'), images.second);
                await w.pass();
                // Both link to P's missing item, as other bytes at its last path do.
                for (const entry of (await listEvents(w.root)).events.filter((item) => item.type === 'new' && [name, 'harbor/plain.jpg'].includes(item.derivedFacts.sourcePath))) {
                    await withCurationLock(w.root, {}, (hold) => writeEvent(w.root, { ...entry, derivedFacts: { ...entry.derivedFacts, samePathAs: w.p } }, entry.version, hold));
                }
                const detail = await shown(w.missingId);
                expect(detail.linkedFiles.map((file) => file.path).sort()).toEqual([printable(name), 'harbor/plain.jpg'].sort());
                const odd = detail.linkedFiles.find((file) => file.path === printable(name))!;
                expect(odd.path, name).not.toBe(name);
                const event = await w.event(w.missingId);
                const before = written(w.root);
                // None chosen, or a file no longer linked: the page says so by the files, and writes nothing.
                expect(await runInboxAction('bind', itemForm(event, w.revisionId))).toMatchObject({ status: 'invalid', field: 'bindTo', message: 'More than one file is linked to this photograph. Choose the one that replaces it. Nothing was written.' });
                expect(await runInboxAction('bind', itemForm(event, w.revisionId, { bindTo: event.id }))).toMatchObject({ status: 'invalid', field: 'bindTo', message: "That file isn't linked to this photograph any more. Refresh the inbox. Nothing was written." });
                expect(written(w.root)).toEqual(before);
                const state = await runInboxAction('bind', itemForm(event, w.revisionId, { bindTo: odd.id }));
                expect(state, name).toMatchObject({ status: 'done', message: bindAnswer(printable(name), false) });
                inPageWords(state, [w.root, w.lib.root]);
                expect(pendingDecisions(w.root)).toEqual([expect.objectContaining({ type: 'bind', path: name, photoId: w.p })]);
            }
        });

        it('withdraws Bind and Archive while an archive waits for the watcher, as after a reopen, and refuses an old form in page words', async () => {
            const w = await missing();
            removeP(w);
            await w.pass();
            fs.writeFileSync(w.lib.file('harbor/elsewhere.jpg'), images.third);
            await w.pass();
            const shownFirst = await w.event(w.missingId);
            expect(await runInboxAction('archive', itemForm(shownFirst, w.revisionId, { reason: 'Gone for good.', confirmed: 'yes' }))).toMatchObject({ status: 'done' });
            expect(await runInboxAction('reopen', itemForm(await w.event(w.missingId), w.revisionId))).toMatchObject({ status: 'done' });
            expect(await shown(w.missingId)).toMatchObject({ status: 'open', can: { bind: false, archive: false, defer: true }, primaryUnavailable: MISSING_HINT.archiveWaiting });
            const event = await w.event(w.missingId);
            const before = written(w.root);
            const refusal = "An archive waiting for the watcher's next pass takes this photograph down already, so it can't be bound or archived again. Refresh after the watcher runs. Nothing was written.";
            const answers = [
                await runInboxAction('bind', itemForm(event, w.revisionId, { bindTo: 'typed', path: 'harbor/elsewhere.jpg' })),
                await runInboxAction('archive', itemForm(event, w.revisionId, { reason: 'Again.', confirmed: 'yes' })),
            ];
            for (const state of answers) {
                expect(state).toMatchObject({ status: 'refused', message: refusal });
                inPageWords(state, [w.root, w.lib.root]);
            }
            expect(written(w.root)).toEqual(before);
        });

        it('names the series an archive left by title, and what leaving changed there', async () => {
            const w = await missing();
            removeP(w);
            await w.pass();
            // P leads the series, as its cover, its opening photograph, and a chapter's start.
            const series = (await readAuthoredRecord(w.root, 'series', SERIES))!;
            await writeAuthoredRecord(
                { ...series, photoIds: [w.p, w.q], cover: { photoId: w.p, focalPoint: { x: 0.5, y: 0.5 } }, openingPhotoId: w.p, chapters: [{ id: 'chapter-1', title: 'Fixture chapter', startPhotoId: w.p }] },
                { expectedVersion: series.version, root: w.root },
            );
            const state = await runInboxAction('archive', itemForm(await w.event(w.missingId), w.revisionId, { reason: 'Gone for good.', confirmed: 'yes' }));
            expect(state).toMatchObject({ status: 'done' });
            const message = inPageWords(state, [w.root, w.lib.root]);
            expect(message.startsWith(DONE_ANSWER.archive)).toBe(true);
            for (const note of [
                'Fixture harbor has no cover now. A published series needs one, so set another before publishing.',
                "Fixture harbor's cover focal point went with it.",
                'Fixture harbor has no opening photograph now.',
                'A chapter in Fixture harbor starts at the next photograph now.',
            ]) expect(message).toContain(note);
        });

        it('says an archive stopped part way, never that nothing was written, when it fails after the series changed', async () => {
            for (const fault of ['the decision', 'the event'] as const) {
                const w = await missing();
                removeP(w);
                await w.pass();
                const event = await w.event(w.missingId);
                if (fault === 'the decision') vi.mocked(writeDecision).mockRejectedValueOnce(Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' }));
                else vi.mocked(writeEvent).mockImplementationOnce(async (_root, next, expected) => {
                    throw new EventMovedError(next.id, expected, expected + 1);
                });
                const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
                const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
                try {
                    const state = await runInboxAction('archive', itemForm(event, w.revisionId, { reason: 'Gone for good.', confirmed: 'yes' }));
                    expect((await readAuthoredRecord(w.root, 'series', SERIES))?.photoIds, fault).not.toContain(w.p);
                    expect(await w.event(w.missingId), fault).toEqual(event);
                    expect(state, fault).toMatchObject({
                        status: 'failed',
                        message: fault === 'the decision'
                            ? "The archive stopped part way: this photograph is out of the draft's series, but it isn't archived, and the item hasn't changed. Refresh, then archive it again to finish it."
                            : "The archive stopped part way: it's written, but the item hasn't changed. The watcher applies it on its next pass. Refresh after it runs.",
                    });
                    inPageWords(state, [w.root, w.lib.root]);
                    expect(pendingDecisions(w.root), fault).toEqual(fault === 'the decision' ? [] : [expect.objectContaining({ type: 'archive', photoId: w.p })]);
                } finally {
                    warn.mockRestore();
                    error.mockRestore();
                }
            }
        });

        it('archives with a reason and a second confirm, out of every series in the draft, and nothing public until a publish', async () => {
            const w = await missing();
            removeP(w);
            await w.pass();
            const event = await w.event(w.missingId);
            const visible = await served(w);
            const catalog = layers(w.root).catalog;
            const before = written(w.root);
            expect(await runInboxAction('archive', itemForm(event, w.revisionId, { reason: ' ', confirmed: 'yes' }))).toMatchObject({ status: 'invalid', field: 'reason', message: 'Archiving needs a reason.' });
            expect(await runInboxAction('archive', itemForm(event, w.revisionId, { reason: 'Gone for good.' }))).toMatchObject({ status: 'invalid', message: 'Confirm the archive at its second step first. Nothing was written.' });
            expect(written(w.root)).toEqual(before);

            const state = await runInboxAction('archive', itemForm(event, w.revisionId, { reason: 'Gone for good.', confirmed: 'yes' }));
            expect(state).toMatchObject({ status: 'done', action: 'archive', message: DONE_ANSWER.archive });
            inPageWords(state, [w.root, w.lib.root]);
            expect((await readAuthoredRecord(w.root, 'series', SERIES))?.photoIds).not.toContain(w.p);
            expect(await w.event(w.missingId)).toMatchObject({ status: 'approved', decisions: expect.arrayContaining([expect.objectContaining({ action: 'archive', reason: 'Gone for good.', by: WEB_ACTOR })]) });
            expect(pendingDecisions(w.root)).toEqual([expect.objectContaining({ type: 'archive', photoId: w.p })]);
            // The takedown is the next publish's: nothing a visitor reads changed yet.
            expect(layers(w.root).catalog).toEqual(catalog);
            expect(await served(w)).toEqual(visible);
            expect(await shown(w.missingId)).toMatchObject({ status: 'approved', can: { bind: false, archive: false, reopen: true } });
        });

        it('turns an archive away, writing nothing, when the item, the active revision, or the lock moved since the page loaded', async () => {
            const w = await missing();
            removeP(w);
            await w.pass();
            const event = await w.event(w.missingId);
            const fields = { reason: 'Gone for good.', confirmed: 'yes' };
            const before = written(w.root);
            const answers = [
                await runInboxAction('archive', itemForm({ ...event, version: event.version + 4 }, w.revisionId, fields)),
                await runInboxAction('archive', itemForm(event, `rev_${'0'.repeat(64)}`, fields)),
                await withCurationLock(w.root, { leaseMs: 60_000 }, () => runInboxAction('archive', itemForm(event, w.revisionId, fields), { waitMs: 200 })),
                await withLock(AUTHORED_LOCK, { root: w.root, leaseMs: 60_000 }, () => runInboxAction('archive', itemForm(event, w.revisionId, fields), { waitMs: 200 })),
            ];
            expect(answers.map((state) => state.status)).toEqual(['stale', 'stale', 'busy', 'busy']);
            expect(answers[1]).toMatchObject({ message: expect.stringMatching(/A publish or rollback happened/) });
            for (const state of answers) inPageWords(state, [w.root, w.lib.root]);
            expect(written(w.root)).toEqual(before);
            expect((await readAuthoredRecord(w.root, 'series', SERIES))?.photoIds).toContain(w.p);
        });
    });

    it("words the writers' refusals that name a CLI flag or command for the page", () => {
        const P = 'ph_00000000-0000-4000-8000-000000000001';
        const E = `evt_${'0'.repeat(24)}`;
        const R = `rev_${'1'.repeat(64)}`;
        const base = "The page didn't carry the active revision. Refresh the inbox and review it again. Nothing was written.";
        const cases: [string, string][] = [
            [`confirm needs --base ${R}, the active revision it was reviewed against. Show it again if that isn't the one. Nothing was written.`, base],
            [`archive needs --base ${R}, the active revision it was reviewed against. Show it again if that isn't the one. Nothing was written.`, base],
            [`No file is linked to ${P}. Other bytes at its last path link here by themselves; for a file anywhere else, pass --path <library path>. Nothing was written.`, 'No file is linked to this photograph. Type the library path of the file that replaces it. Nothing was written.'],
            [`2 files are linked to ${P}: a.jpg, b.jpg. Pass --path with the one that replaces it. Nothing was written.`, 'More than one file is linked to this photograph. Choose the one that replaces it. Nothing was written.'],
            [`A bind for ${P} waits for the watcher's next pass: the decision d gives it a.jpg. Archive after the watcher applies it, or once it refuses it; curation show ${E} says which. Nothing was written.`, "A bind waiting for the watcher's next pass gives this photograph a file, so it can't be archived yet. Refresh after the watcher runs, and archive it then if the bind didn't go through. Nothing was written."],
            [`#10 holds a.jpg in doubt: it may still be ${P}'s file, and a bind would merge ${P} into ${P}. Settle that path's ambiguous item first, with photos identity bind or photos identity new, then bind again. Nothing was written.`, "The watcher isn't sure whose file that is. Settle that path's ambiguous item first, then bind again. Nothing was written."],
            [`A bind for ${P} already waits for the watcher's next pass: the decision d gives it a.jpg. Wait for that pass, or for the watcher to refuse it; curation show ${E} says which. Nothing was written.`, "A bind waiting for the watcher's next pass already gives this photograph a file. Refresh after the watcher runs. Nothing was written."],
            [`An archive of ${P} waits for the watcher's next pass: the decision d. Nothing can be bound to it, and it needs no second archive. Nothing was written.`, "An archive waiting for the watcher's next pass takes this photograph down already, so it can't be bound or archived again. Refresh after the watcher runs. Nothing was written."],
            [`${P}'s photo record pins sha256-${'a'.repeat(64)}, not this event's sha256-${'b'.repeat(64)}. Confirming new bytes for a photograph is #17's. Nothing was written.`, "Its photo record holds another version of this photograph, so approving can't place these bytes. Confirm the new version on its replacement item instead. Nothing was written."],
            [`The event ${E} is approved, so it can't be confirmed. Reopen it first.`, "This item is approved, so it can't be confirmed. Refresh the inbox."],
            [`The event ${E} is approved, so it can't be archived. Reopen it first.`, "This item is approved, so it can't be archived. Refresh the inbox."],
        ];
        for (const [message, page] of cases) {
            expect(pageWording(message), message).toBe(page);
            expect(page).not.toMatch(/--[a-z]|\b(ph|evt|rev)_|photos |curation |#\d/);
        }
    });
});
