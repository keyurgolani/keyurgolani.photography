// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderBytes } from '../../../test/helpers/folderBytes';
import { setDataDir, writeDataRootMarker } from '../../../test/helpers/tempDataRoot';
import { readAuthoredRecord } from '../../catalog/working-layer';
import { readRegistry, writeRegistry } from '../../identity/registry';
import type { IdentityFact } from '../../identity/types';
import { deferEvent } from '../actions';
import { eventIdOf, eventKey, type CurationEvent, type CurationEventType } from '../events';
import { loadInbox } from '../inbox';
import { runInboxAction, WEB_ACTOR } from '../inbox-form';
import { defaultPlacement, defaultSeries, parsePlacementValue, placementValue, summaryText, type InboxActionState, type InboxView } from '../inbox-view';
import { eventDir, readEvent, withCurationLock } from '../repository';
import { createCurationSink } from '../sink';
import { createCurationFixture, DRAFT, GPS, PUBLISHED, SERIAL, writeRules, type CurationFixture } from './curationFixtures';

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
        expect(summaryText(view)).toBe('5 items require judgment, 1 waiting');
        expect(view.items[5]).toMatchObject({ title: 'Replacement building', waiting: 'its new derivatives are still building' });
        // With no selection, the first item that needs judgment shows.
        expect(view.selected?.id).toBe(view.items[0].id);
        expect(ids).toContain(view.selected?.id);
        expect(view.activeRevisionId).toBe(f.catalog.revisionId);
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
        const detail = ready(await loadInbox(ids[0])).selected!;
        expect(detail.previewUrl).toBe(`/api/curation/media/${event.photoId}/${event.assetRevision}/${f.catalog.profileId}/w800.webp`);
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
        done(await runInboxAction('edit', itemForm(event, null, { series: DRAFT, placement: 'end', description: 'Saved for later.' })));
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
