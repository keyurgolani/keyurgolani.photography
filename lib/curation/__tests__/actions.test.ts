// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { folderBytes } from '../../../test/helpers/folderBytes';
import { authoredRecordDir, catalogPaths, readAuthoredRecord } from '../../catalog/working-layer';
import { AUTHORED_LOCK, writeAuthoredRecord } from '../../catalog/working-layer-writer';
import { readPendingDecisions } from '../../identity/decisions';
import { readRegistry, writeRegistry } from '../../identity/registry';
import type { IdentityFact } from '../../identity/types';
import { readVersionedDocument, versionFile, versionText, writeVersionedDocument } from '../../storage/document';
import { withLock } from '../../storage/lock';
import { approveEvent, deferEvent, dismissEvent, editEvent, reopenEvent, retryEvent, type ActionInput } from '../actions';
import { eventIdOf, eventKey, type CurationEvent, type CurationEventType } from '../events';
import { readEvent } from '../repository';
import { createCurationSink } from '../sink';
import { createCurationFixture, DRAFT, GPS, holdingCuration, PUBLISHED, SERIAL, writeRules, type CurationFixture } from './curationFixtures';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const ACTOR = 'curator:test';

interface Opened {
    f: CurationFixture;
    event: CurationEvent;
    input: ActionInput;
}

const TYPE_OF: Record<IdentityFact['type'], CurationEventType> = {
    new: 'new', replaced: 'replacement', 'metadata-changed': 'replacement', missing: 'missing', reappeared: 'reappeared', ambiguous: 'ambiguous', 'processing-failed': 'processing-failure', renamed: 'new',
};

/** A fixture with one event the sink opened from `fact`. */
async function opened(make: (f: CurationFixture) => IdentityFact, options: Parameters<typeof createCurationFixture>[0] & { rules?: unknown } = {}): Promise<Opened> {
    const f = await createCurationFixture(options);
    cleanups.push(() => f.cleanup());
    if (options.rules !== undefined) writeRules(f.root, options.rules);
    const fact = make(f);
    await createCurationSink({ root: f.root, logger: quiet })([fact]);
    const event = await readEvent(f.root, eventIdOf(eventKey(TYPE_OF[fact.type], fact))) as CurationEvent;
    expect(event).not.toBeNull();
    return { f, event, input: { root: f.root, eventId: event.id, expectedVersion: event.version, actor: ACTOR } };
}

/** Every file under catalog/ and authored/, so a test can show an action changed nothing there. */
const layers = (root: string) => ({ catalog: folderBytes(path.join(root, 'catalog')), authored: folderBytes(path.join(root, 'authored')) });

describe('approve', () => {
    it('writes the photo record and its place through #8, and leaves catalog/ byte-identical', async () => {
        const { f, event, input } = await opened((fx) => fx.fact('new', fx.fresh[0]), { published: true, rules: { schemaVersion: 1, series: [{ seriesId: DRAFT, folders: ['trips'] }] } });
        const catalogBefore = layers(f.root).catalog;
        const draftBefore = await readAuthoredRecord(f.root, 'series', DRAFT);
        const result = await approveEvent({ ...input, expectedBase: f.catalog.revisionId, choices: {} });
        expect(result).toMatchObject({ ok: true, event: { status: 'approved', version: 2, reviewedBy: ACTOR } });
        expect(layers(f.root).catalog).toEqual(catalogBefore);
        const photoId = event.photoId as string;
        const photo = await readAuthoredRecord(f.root, 'photo', photoId);
        expect(photo).toEqual({ schemaVersion: 1, version: 1, baseRevisionId: f.catalog.revisionId, kind: 'photo', id: photoId, assetRevision: event.assetRevision, alt: null });
        const draft = await readAuthoredRecord(f.root, 'series', DRAFT);
        expect(draft?.photoIds).toEqual([...(draftBefore?.photoIds ?? []), photoId]);
        expect(draft?.version).toBe((draftBefore?.version ?? 0) + 1);
        const decision = result.ok ? result.event.decisions.at(-1) : null;
        expect(decision).toMatchObject({ action: 'approve', seriesId: DRAFT, placement: 'end', baseRevisionId: f.catalog.revisionId, writes: [{ record: `photo:${photoId}`, version: 1 }, { record: `series:${DRAFT}`, version: 2 }] });
        // Without a reviewed description it is placed, and #13's description gate holds it back from a publish.
        expect(result.ok && result.notes.join(' ')).toMatch(/no description yet/);
    });

    it('copies no EXIF or other derived fact into the working layer', async () => {
        const { f, input } = await opened((fx) => fx.fact('new', fx.fresh[0]));
        expect(await approveEvent({ ...input, choices: { seriesId: DRAFT, placement: 'start', description: { kind: 'described', text: 'Typed by the curator.' } } })).toMatchObject({ ok: true });
        const authored = JSON.stringify(layers(f.root).authored);
        for (const leaked of [String(GPS.latitude), String(GPS.longitude), SERIAL, 'Fixture Artist', '2024-06-01', 'trips/harbor-1.jpg']) expect(authored).not.toContain(leaked);
    });

    it('stores only typed text as reviewed', async () => {
        const { f, event, input } = await opened((fx) => fx.fact('new', fx.fresh[0]));
        await approveEvent({ ...input, choices: { seriesId: DRAFT, description: { kind: 'described', text: 'Typed by the curator.' } } });
        expect((await readAuthoredRecord(f.root, 'photo', event.photoId as string))?.alt).toEqual({ kind: 'described', text: 'Typed by the curator.', reviewed: true });
    });

    it('uses the saved edits over the suggestion, and edit itself writes only the event', async () => {
        const { f, event, input } = await opened((fx) => fx.fact('new', fx.fresh[0]), { rules: { schemaVersion: 1, series: [{ seriesId: DRAFT, folders: ['trips'] }] } });
        const before = layers(f.root);
        const anchor = f.catalog.series.find((series) => series.id === DRAFT)?.photoIds[0] as string;
        const edited = await editEvent({ ...input, choices: { placement: { after: anchor }, description: { kind: 'decorative' } } });
        expect(edited).toMatchObject({ ok: true, event: { version: 2, edits: { placement: { after: anchor }, description: { kind: 'decorative' }, editedBy: ACTOR } } });
        expect(layers(f.root)).toEqual(before);
        expect(await approveEvent({ ...input, expectedVersion: 2, choices: {} })).toMatchObject({ ok: true });
        const draft = await readAuthoredRecord(f.root, 'series', DRAFT);
        expect(draft?.photoIds.indexOf(event.photoId as string)).toBe(1);
        expect((await readAuthoredRecord(f.root, 'photo', event.photoId as string))?.alt).toEqual({ kind: 'decorative' });
    });

    it('needs a choice when nothing suggests a series, and Leave unassigned writes only the photo record', async () => {
        const { f, event, input } = await opened((fx) => fx.fact('new', fx.fresh[0]));
        const before = layers(f.root);
        expect(await approveEvent({ ...input, choices: {} })).toMatchObject({ ok: false, code: 'needs-choice' });
        expect(layers(f.root)).toEqual(before);
        expect(await approveEvent({ ...input, choices: { seriesId: null } })).toMatchObject({ ok: true, event: { status: 'approved' } });
        const after = layers(f.root);
        expect(Object.keys(after.authored ?? {}).filter((name) => !(name in (before.authored ?? {})))).toEqual([`photos/${event.photoId}/v1.json`]);
    });

    it('refuses a placement #8 refuses and writes nothing', async () => {
        const { f, event, input } = await opened((fx) => fx.fact('new', fx.fresh[0]));
        // The photograph already belongs to the published series, so a second published one can't take it.
        const series = await readAuthoredRecord(f.root, 'series', PUBLISHED);
        await writeAuthoredRecord({ ...series!, id: 'ser_fixture-other', slug: 'fixture-other', photoIds: [event.photoId as string] }, { expectedVersion: 0, root: f.root });
        const before = layers(f.root);
        const result = await approveEvent({ ...input, choices: { seriesId: PUBLISHED } });
        expect(result).toMatchObject({ ok: false, code: 'refused', message: expect.stringMatching(/membership-conflict.*Nothing was written/) });
        expect(layers(f.root)).toEqual(before);
        expect(await readEvent(f.root, event.id)).toEqual(event);
    });

    it.each<[IdentityFact['type'], RegExp]>([
        ['missing', /#17/],
        ['replaced', /#17/],
        ['ambiguous', /photos identity bind or photos identity new/],
        ['reappeared', /dismiss/],
        ['processing-failed', /dismiss/],
    ])('refuses a %s event, naming what settles it, and writes nothing', async (type, owner) => {
        const { f, input } = await opened((fx) => fx.fact(type, type === 'ambiguous' || type === 'processing-failed' ? fx.fresh[0] : fx.catalog.photos[0].id, {
            ...(type === 'replaced' ? { assetRevision: `sha256-${'d'.repeat(64)}` } : {}),
            ...(type === 'ambiguous' ? { candidates: [fx.fresh[0], fx.catalog.photos[0].id] } : {}),
            ...(type === 'processing-failed' ? { reason: 'undecodable' as const } : {}),
        }));
        const before = layers(f.root);
        expect(await approveEvent({ ...input, choices: { seriesId: DRAFT } })).toMatchObject({ ok: false, code: 'refused', message: expect.stringMatching(owner) });
        expect(layers(f.root)).toEqual(before);
    });
});

describe('a stale action', () => {
    it('fails without writing when the event moved since it was shown', async () => {
        const { f, event, input } = await opened((fx) => fx.fact('new', fx.fresh[0]));
        await createCurationSink({ root: f.root, logger: quiet })([{ ...f.fact('new', f.fresh[0]), factId: 'again' }]);
        const before = layers(f.root);
        const moved = await readEvent(f.root, event.id);
        for (const run of [
            () => approveEvent({ ...input, choices: { seriesId: DRAFT } }),
            () => editEvent({ ...input, choices: { seriesId: DRAFT } }),
            () => deferEvent(input),
            () => dismissEvent({ ...input, reason: 'Not this one.' }),
            () => retryEvent(input),
        ]) {
            expect(await run()).toMatchObject({ ok: false, code: 'stale' });
        }
        expect(layers(f.root)).toEqual(before);
        expect(await readEvent(f.root, event.id)).toEqual(moved);
        expect(await readPendingDecisions(f.root)).toEqual([]);
    });

    it('fails without writing when the active revision is not the one it was reviewed against', async () => {
        const { f, input } = await opened((fx) => fx.fact('new', fx.fresh[0]), { published: true });
        const before = layers(f.root);
        expect(await approveEvent({ ...input, expectedBase: null, choices: { seriesId: DRAFT } })).toMatchObject({ ok: false, code: 'stale', message: expect.stringMatching(/publish or rollback/) });
        expect(await deferEvent({ ...input, expectedBase: `rev_${'0'.repeat(64)}` })).toMatchObject({ ok: false, code: 'stale' });
        expect(layers(f.root)).toEqual(before);
        expect(await deferEvent({ ...input, expectedBase: f.catalog.revisionId })).toMatchObject({ ok: true });
    });

    it('fails approval without writing when the source moved to new bytes', async () => {
        const { f, event, input } = await opened((fx) => fx.fact('new', fx.fresh[0]));
        const registry = await readRegistry(f.root);
        registry.photos[event.photoId as string].source.observedRevision = `sha256-${'c'.repeat(64)}`;
        await writeRegistry(f.root, registry, registry.version);
        const before = layers(f.root);
        expect(await approveEvent({ ...input, choices: { seriesId: DRAFT } })).toMatchObject({ ok: false, code: 'stale', message: expect.stringMatching(/source changed/) });
        expect(layers(f.root)).toEqual(before);
    });

    it('lets only one of two approvals at one version through', async () => {
        const { f, event, input } = await opened((fx) => fx.fact('new', fx.fresh[0]));
        const results = await Promise.all([
            approveEvent({ ...input, choices: { seriesId: DRAFT, placement: 'start' } }),
            approveEvent({ ...input, choices: { seriesId: DRAFT, placement: 'end' } }),
        ]);
        expect(results.filter((result) => result.ok)).toHaveLength(1);
        expect(results.filter((result) => !result.ok)).toEqual([expect.objectContaining({ code: 'stale' })]);
        const draft = await readAuthoredRecord(f.root, 'series', DRAFT);
        expect(draft?.photoIds.filter((id) => id === event.photoId)).toHaveLength(1);
    });

    it('fails as locked when another curator holds the inbox', async () => {
        const { f, input } = await opened((fx) => fx.fact('new', fx.fresh[0]));
        await holdingCuration(f.root, async () => {
            expect(await deferEvent({ ...input, waitMs: 0 })).toMatchObject({ ok: false, code: 'locked' });
        });
    });
});

describe('defer, dismiss, and reopen', () => {
    it('move an event between states and record who and when', async () => {
        const { f, event, input } = await opened((fx) => fx.fact('new', fx.fresh[0]));
        const clock = () => Date.parse('2026-04-01T00:00:00.000Z');
        expect(await deferEvent({ ...input, clock })).toMatchObject({ ok: true, event: { status: 'deferred', reviewedAt: '2026-04-01T00:00:00.000Z', reviewedBy: ACTOR } });
        expect(await dismissEvent({ ...input, expectedVersion: 2, reason: '' })).toMatchObject({ ok: false, code: 'needs-choice' });
        expect(await dismissEvent({ ...input, expectedVersion: 2, reason: 'A test frame.' })).toMatchObject({ ok: true, event: { status: 'dismissed' } });
        expect(await deferEvent({ ...input, expectedVersion: 3 })).toMatchObject({ ok: false, code: 'refused', message: expect.stringMatching(/Reopen it first/) });
        const reopened = await reopenEvent({ ...input, expectedVersion: 3 });
        expect(reopened).toMatchObject({ ok: true, event: { status: 'open', version: 4 } });
        const stored = await readEvent(f.root, event.id);
        expect(stored?.decisions.map((decision) => [decision.action, decision.by])).toEqual([['defer', ACTOR], ['dismiss', ACTOR], ['reopen', ACTOR]]);
        expect(stored?.decisions[1].reason).toBe('A test frame.');
    });

    it('keep a missing photograph that is still referenced from being dismissed', async () => {
        const { f, input } = await opened((fx) => fx.fact('missing', fx.catalog.series[0].photoIds[0]), { published: true });
        const before = layers(f.root);
        expect(await dismissEvent({ ...input, reason: 'Gone.' })).toMatchObject({ ok: false, code: 'refused', message: expect.stringMatching(/active revision.*can't be dismissed/) });
        expect(layers(f.root)).toEqual(before);
    });

    it('let a missing photograph nothing references be dismissed', async () => {
        const { f, input } = await opened((fx) => fx.fact('missing', fx.fresh[0]));
        expect(await dismissEvent({ ...input, reason: 'Removed on purpose.' })).toMatchObject({ ok: true, event: { status: 'dismissed' } });
        expect(fs.existsSync(path.join(f.root, 'authored', 'photos', f.fresh[0]))).toBe(false);
    });
});

describe('retry', () => {
    it('writes one #10 retry decision and nothing in the working layer', async () => {
        const { f, event, input } = await opened((fx) => fx.fact('processing-failed', fx.fresh[0], { reason: 'undecodable' }));
        expect(event.status).toBe('failed');
        const before = layers(f.root);
        const result = await retryEvent({ ...input, reason: 'Re-exported the file.' });
        expect(result).toMatchObject({ ok: true, event: { status: 'failed', version: 2 } });
        const pending = await readPendingDecisions(f.root);
        expect(pending.map((file) => file.decision)).toEqual([expect.objectContaining({ type: 'retry', photoId: event.photoId, assetRevision: event.assetRevision, actor: ACTOR, reason: 'Re-exported the file.' })]);
        expect(result.ok && result.event.decisions.at(-1)?.identityDecisionId).toBe(pending[0].decision?.decisionId);
        expect(layers(f.root)).toEqual(before);
    });

    it('retries a new photograph whose derivatives failed', async () => {
        const { f, event, input } = await opened((fx) => fx.fact('new', fx.fresh[0]));
        expect(await retryEvent(input)).toMatchObject({ ok: false, code: 'refused', message: expect.stringMatching(/Nothing failed/) });
        const registry = await readRegistry(f.root);
        registry.photos[event.photoId as string].revisions[event.assetRevision as string].profiles[f.catalog.profileId] = { state: 'failed', attempts: 3, error: 'fixture failure' };
        await writeRegistry(f.root, registry, registry.version);
        expect(await retryEvent(input)).toMatchObject({ ok: true });
        expect(await readPendingDecisions(f.root)).toHaveLength(1);
    });

    it.each([
        ['an unsupported format', 'unsupported-format' as const],
        ['a digest collision', 'digest-collision' as const],
    ])('refuses %s, which retrying cannot fix', async (_label, reason) => {
        const { f, input } = await opened((fx) => fx.fact('processing-failed', fx.fresh[0], { reason }));
        expect(await retryEvent(input)).toMatchObject({ ok: false, code: 'refused' });
        expect(await readPendingDecisions(f.root)).toEqual([]);
    });

    it('refuses a file with no photo ID', async () => {
        const { f, input } = await opened((fx) => fx.fact('processing-failed', null, { reason: 'undecodable', path: 'trips/broken.jpg' }));
        expect(await retryEvent(input)).toMatchObject({ ok: false, code: 'refused', message: expect.stringMatching(/no photo ID/) });
        expect(await readPendingDecisions(f.root)).toEqual([]);
    });
});

describe('every action', () => {
    it('leaves catalog/ byte-identical, with an active revision in place', async () => {
        const { f, input } = await opened((fx) => fx.fact('new', fx.fresh[0]), { published: true });
        const catalog = layers(f.root).catalog;
        expect(catalog).not.toBeNull();
        const steps = [
            () => editEvent({ ...input, choices: { seriesId: DRAFT } }),
            () => deferEvent({ ...input, expectedVersion: 2 }),
            () => reopenEvent({ ...input, expectedVersion: 3 }),
            () => approveEvent({ ...input, expectedVersion: 4, expectedBase: f.catalog.revisionId, choices: {} }),
            () => reopenEvent({ ...input, expectedVersion: 5 }),
            () => dismissEvent({ ...input, expectedVersion: 6, reason: 'Changed my mind.' }),
        ];
        for (const step of steps) {
            expect(await step()).toMatchObject({ ok: true });
            expect(layers(f.root).catalog).toEqual(catalog);
        }
    });

    it('reports an unknown event without writing', async () => {
        const { f } = await opened((fx) => fx.fact('new', fx.fresh[0]));
        expect(await deferEvent({ root: f.root, eventId: `evt_${'0'.repeat(24)}`, expectedVersion: 1, actor: ACTOR })).toMatchObject({ ok: false, code: 'not-found' });
    });
});

describe('approve, round 1', () => {
    it('keeps a photograph already in the series where it is, unless a position flag or a saved edit picks one', async () => {
        const { f, event, input } = await opened((fx) => fx.fact('new', fx.fresh[0]), { rules: { schemaVersion: 1, series: [{ seriesId: DRAFT, folders: ['trips'] }] } });
        const photoId = event.photoId as string;
        const draft = await readAuthoredRecord(f.root, 'series', DRAFT);
        // The owner placed it by hand first, at the start.
        await writeAuthoredRecord({ ...draft!, photoIds: [photoId, ...(draft?.photoIds ?? [])] }, { expectedVersion: draft?.version ?? 0, root: f.root });
        const placed = await readAuthoredRecord(f.root, 'series', DRAFT);
        const result = await approveEvent({ ...input, choices: {} });
        expect(result).toMatchObject({ ok: true });
        expect(result.ok && result.notes.join(' ')).toMatch(/kept its place/);
        expect(await readAuthoredRecord(f.root, 'series', DRAFT)).toEqual(placed);
        // Reopened and approved again with nothing picked, it still stays.
        await reopenEvent({ ...input, expectedVersion: 2 });
        expect(await approveEvent({ ...input, expectedVersion: 3, choices: {} })).toMatchObject({ ok: true });
        expect(await readAuthoredRecord(f.root, 'series', DRAFT)).toEqual(placed);
        // A flag moves it.
        await reopenEvent({ ...input, expectedVersion: 4 });
        expect(await approveEvent({ ...input, expectedVersion: 5, choices: { placement: 'end' } })).toMatchObject({ ok: true });
        expect((await readAuthoredRecord(f.root, 'series', DRAFT))?.photoIds.at(-1)).toBe(photoId);
        // So does a saved edit.
        await reopenEvent({ ...input, expectedVersion: 6 });
        await editEvent({ ...input, expectedVersion: 7, choices: { placement: 'start' } });
        expect(await approveEvent({ ...input, expectedVersion: 8, choices: {} })).toMatchObject({ ok: true });
        expect((await readAuthoredRecord(f.root, 'series', DRAFT))?.photoIds[0]).toBe(photoId);
    });

    it('needs --base once an active revision exists, and names it', async () => {
        const { f, input } = await opened((fx) => fx.fact('new', fx.fresh[0]), { published: true });
        const before = layers(f.root);
        const result = await approveEvent({ ...input, choices: { seriesId: DRAFT } });
        expect(result).toMatchObject({ ok: false, code: 'needs-choice', message: expect.stringContaining(`--base ${f.catalog.revisionId}`) });
        expect(layers(f.root)).toEqual(before);
    });

    it('fails as stale when the active pointer moves while it waits for the authored lock', async () => {
        const { f, input } = await opened((fx) => fx.fact('new', fx.fresh[0]), { published: true });
        let result: Awaited<ReturnType<typeof approveEvent>> | undefined;
        await withLock(AUTHORED_LOCK, { root: f.root, waitMs: 1_000 }, async () => {
            void approveEvent({ ...input, expectedBase: f.catalog.revisionId, waitMs: 10_000, choices: { seriesId: DRAFT } }).then((value) => {
                result = value;
            });
            await new Promise((resolve) => setTimeout(resolve, 400));
            expect(result).toBeUndefined();
            const active = catalogPaths(f.root).active;
            fs.writeFileSync(versionFile(active, 2), versionText({ schemaVersion: 1, revisionId: `rev_${'9'.repeat(64)}`, activationId: 'act_00000000-0000-4000-8000-000000000002' }, 2));
        });
        await vi.waitFor(() => expect(result).toBeDefined(), { timeout: 5_000 });
        expect(result).toMatchObject({ ok: false, code: 'stale', message: expect.stringMatching(/active revision moved/) });
        expect(fs.existsSync(path.join(f.root, 'authored', 'photos', f.fresh[0]))).toBe(false);
    });

    it('refuses when the photo record pins another revision, and writes nothing', async () => {
        const { f, event, input } = await opened((fx) => fx.fact('new', fx.fresh[0]));
        await writeAuthoredRecord({ kind: 'photo', id: event.photoId as string, assetRevision: `sha256-${'f'.repeat(64)}`, alt: null }, { expectedVersion: 0, root: f.root });
        const before = layers(f.root);
        expect(await approveEvent({ ...input, choices: { seriesId: DRAFT } })).toMatchObject({ ok: false, code: 'refused', message: expect.stringMatching(/pins sha256-f+, not this event's/) });
        expect(layers(f.root)).toEqual(before);
    });

    it('says exactly what landed when the series write fails after the photo record, and approving again finishes it', async () => {
        const { f, event, input } = await opened((fx) => fx.fact('new', fx.fresh[0]));
        const photoId = event.photoId as string;
        const dir = authoredRecordDir(f.root, 'series', DRAFT);
        const result = await approveEvent({
            ...input,
            choices: { seriesId: DRAFT },
            faults: {
                // A writer past its lease commits the series between the photo record and the placement.
                async beforePlacement() {
                    const stored = await readVersionedDocument(dir);
                    await writeVersionedDocument(dir, { ...(stored?.value as { version: number; schemaVersion: number }), title: 'Fixture title from elsewhere' }, stored?.version ?? 0);
                },
            },
        });
        expect(result).toMatchObject({ ok: false, code: 'stale', writes: [{ record: `photo:${photoId}`, version: 1 }] });
        expect(!result.ok && result.message).toMatch(new RegExp(`photo:${photoId} v1 landed.*${DRAFT} did not change.*Approve again`));
        expect(await readEvent(f.root, event.id)).toMatchObject({ version: 1, status: 'open' });
        const again = await approveEvent({ ...input, choices: { seriesId: DRAFT } });
        expect(again).toMatchObject({ ok: true, event: { status: 'approved' } });
        expect(again.ok && again.event.decisions.at(-1)?.writes).toEqual([{ record: `series:${DRAFT}`, version: 3 }]);
        expect((await readAuthoredRecord(f.root, 'series', DRAFT))?.photoIds).toContain(photoId);
    });
});

describe('approve, round 2', () => {
    it('uses up a saved position, so reopen and approve again keeps a hand reorder', async () => {
        const { f, event, input } = await opened((fx) => fx.fact('new', fx.fresh[0]));
        const photoId = event.photoId as string;
        await editEvent({ ...input, choices: { seriesId: DRAFT, placement: 'start' } });
        const approved = await approveEvent({ ...input, expectedVersion: 2, choices: {} });
        expect(approved).toMatchObject({ ok: true });
        expect(approved.ok && approved.event.edits?.placement).toBeUndefined();
        expect(approved.ok && approved.event.edits?.seriesId).toBe(DRAFT);
        expect((await readAuthoredRecord(f.root, 'series', DRAFT))?.photoIds[0]).toBe(photoId);
        // The curator reorders by hand.
        const draft = await readAuthoredRecord(f.root, 'series', DRAFT);
        const reordered = [...(draft?.photoIds ?? []).filter((id) => id !== photoId), photoId];
        await writeAuthoredRecord({ ...draft!, photoIds: reordered }, { expectedVersion: draft?.version ?? 0, root: f.root });
        const reopened = await reopenEvent({ ...input, expectedVersion: 3 });
        expect(reopened.ok && reopened.notes.join(' ')).toMatch(/approve with a position flag to move it/);
        expect(await approveEvent({ ...input, expectedVersion: 4, choices: {} })).toMatchObject({ ok: true });
        expect((await readAuthoredRecord(f.root, 'series', DRAFT))?.photoIds).toEqual(reordered);
    });
});

describe('round 3: a file replaced before its first approval', () => {
    /** Point the registry's photo at new bytes, as a reconcile pass does for a replacement, and return them. */
    async function replaceBytes(f: CurationFixture, photoId: string, state: 'pending' | 'ready' = 'pending'): Promise<string> {
        const registry = await readRegistry(f.root);
        const photo = registry.photos[photoId];
        const old = photo.revisions[photo.source.observedRevision];
        const assetRevision = `sha256-${'7'.repeat(64)}`;
        photo.revisions[assetRevision] = { ...old, assetRevision, width: 4000, height: 3000, profiles: { [f.catalog.profileId]: state === 'ready' ? { state, attempts: 1, readyAt: '2026-02-01T00:00:00.000Z' } : { state, attempts: 0 } } };
        photo.source.observedRevision = assetRevision;
        await writeRegistry(f.root, registry, registry.version);
        return assetRevision;
    }

    it('moves the open new item to the newest bytes and bumps its version, so approve takes them and an older version is stale', async () => {
        const { f, event, input } = await opened((fx) => fx.fact('new', fx.fresh[0]));
        const photoId = event.photoId as string;
        const newer = await replaceBytes(f, photoId);
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('replaced', photoId, { assetRevision: newer })]);
        const moved = await readEvent(f.root, event.id) as CurationEvent;
        expect(moved).toMatchObject({ version: 2, type: 'new', status: 'open', assetRevision: newer, derivedFacts: { factType: 'new', width: 4000, height: 3000 } });
        const before = layers(f.root);
        // Reviewed against the older bytes: refused, and nothing is written.
        expect(await approveEvent({ ...input, choices: { seriesId: DRAFT } })).toMatchObject({ ok: false, code: 'stale' });
        expect(layers(f.root)).toEqual(before);
        // Shown the newer bytes: approved at them.
        expect(await approveEvent({ ...input, expectedVersion: 2, choices: { seriesId: DRAFT } })).toMatchObject({ ok: true, event: { status: 'approved', assetRevision: newer } });
        expect((await readAuthoredRecord(f.root, 'photo', photoId))?.assetRevision).toBe(newer);
    });

    it('leaves the new item alone once a photo record exists, which only a confirm may move', async () => {
        const { f, event } = await opened((fx) => fx.fact('new', fx.fresh[0]));
        const photoId = event.photoId as string;
        await writeAuthoredRecord({ kind: 'photo', id: photoId, assetRevision: event.assetRevision as string, alt: null }, { expectedVersion: 0, root: f.root });
        const newer = await replaceBytes(f, photoId);
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('replaced', photoId, { assetRevision: newer })]);
        expect(await readEvent(f.root, event.id)).toEqual(event);
    });

    it('leaves an approved or dismissed new item alone', async () => {
        const { f, event, input } = await opened((fx) => fx.fact('new', fx.fresh[0]));
        expect(await dismissEvent({ ...input, reason: 'Not this one.' })).toMatchObject({ ok: true });
        const dismissed = await readEvent(f.root, event.id);
        const newer = await replaceBytes(f, event.photoId as string);
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('replaced', event.photoId as string, { assetRevision: newer })]);
        expect(await readEvent(f.root, event.id)).toEqual(dismissed);
    });
});
