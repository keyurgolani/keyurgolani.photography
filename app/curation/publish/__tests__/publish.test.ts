// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashValue } from '@/lib/catalog/review';
import { rollback } from '@/lib/catalog/rollback';
import { createTestCatalog } from '@/lib/catalog/testing';
import { readActivePointer, readAuthoredRecord } from '@/lib/catalog/working-layer';
import { writeAuthoredRecord } from '@/lib/catalog/working-layer-writer';
import { readEvent } from '@/lib/curation/repository';
import { displayFacts, IDLE_STATE, resultCopy, type Answer, type LedgerRow, type PublishState, type ScreenView } from '@/lib/curation/publish-facts';
import { setDataDir } from '@/test/helpers/tempDataRoot';
import {
    blockRevisionFile,
    BREAKWATER,
    BREAKWATER_TITLE,
    createPublishFixture,
    editBehindThePage,
    fixBoth,
    holdCatalogLock,
    LOW_TIDE,
    LOW_TIDE_IDS,
    publishFromCli,
    reopenBreakwater,
    SALT_ROADS,
    type PublishFixture,
} from '@/test/helpers/publishFixture';

// #16's Publish screen (16-3) on real data roots: the page's read, the join
// of rows and blockers, and every answer the one server action gives, through
// the same publish() the CLI runs. requireCurator() is the boundary's, tested
// with the login; here it lets every call through. Test values only.

const revalidated: string[] = [];
vi.mock('@/lib/curation/auth', async (importOriginal) => ({ ...(await importOriginal<object>()), requireCurator: async () => ({}) }));
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => void revalidated.push(path) }));
// The next publish() the action runs stops after this step, as a crash there would, through publish()'s own test hook.
const crash: { after: number | null } = { after: null };
vi.mock('@/lib/catalog/publish', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/catalog/publish')>();
    return {
        ...actual,
        publish: (options: Parameters<typeof actual.publish>[0]) => {
            const after = crash.after;
            crash.after = null;
            if (after === null) return actual.publish(options);
            return actual.publish({ ...options, hooks: { afterStep: (step) => { if (step === after) throw new Error(`Test: the publish stops after step ${after}.`); } } });
        },
    };
});
const quiet = { log: () => undefined };

const { loadPublishPage } = await import('../load');
const { publishAction } = await import('../actions');

let fixture: PublishFixture;
let restore: () => void;

beforeEach(async () => {
    fixture = await createPublishFixture();
    restore = setDataDir(fixture.root);
    revalidated.length = 0;
}, 60_000);

afterEach(async () => {
    restore();
    await fixture.cleanup();
});

async function view(): Promise<ScreenView> {
    const page = await loadPublishPage();
    if (page.state !== 'ready') throw new Error(`The page is ${page.state}`);
    return page.view;
}

const rowsOf = (screen: Pick<ScreenView, 'ledger'>): LedgerRow[] => [...screen.ledger.authored, ...screen.ledger.derived, ...screen.ledger.health];
const rowAbout = (screen: Pick<ScreenView, 'ledger'>, summary: string | RegExp) => {
    const row = rowsOf(screen).find((entry) => (typeof summary === 'string' ? entry.summary === summary : summary.test(entry.summary)));
    if (!row) throw new Error(`No row says ${String(summary)}: ${rowsOf(screen).map((entry) => entry.summary).join(' | ')}`);
    return row;
};

function form(fields: Record<string, string | number>): FormData {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.set(name, String(value));
    return data;
}

async function act(screen: ScreenView, intent: 'validate' | 'publish', previous: PublishState = IDLE_STATE, extra: Record<string, string> = {}) {
    return publishAction(previous, form({ intent, draftId: screen.draftId, active: screen.active.revisionId, ...(intent === 'publish' ? { validated: screen.draftId } : {}), ...extra }));
}

const answerOf = (state: PublishState): Answer => {
    if (!state.answer) throw new Error('No answer');
    return state.answer;
};

describe('the page read', () => {
    it('shows the draft as the approved mockup does: rows in visitor terms, two blockers known on load, and the panel on the new photograph', async () => {
        const screen = await view();
        expect(screen.kind).toBe('ledger');
        expect(screen.draftNumber).toBe(3);
        expect(screen.active).toMatchObject({ number: 2, revisionId: fixture.revisions[1] });
        expect(screen.previous).toMatchObject({ number: 1 });
        const added = rowAbout(screen, `Add ${BREAKWATER_TITLE} to Low Tide Hours after photograph 04`);
        expect(added).toMatchObject({ kind: 'New', review: 'generated', blocks: true, fix: { type: 'description', photoId: BREAKWATER, text: expect.stringMatching(/^Six wooden posts/) } });
        expect(added.fix?.type === 'description' && added.fix.inboxItem).toBe(fixture.breakwaterEvent);
        const moved = rowAbout(screen, 'Pier lamps moves from position 7 to 2 in Salt Roads');
        expect(moved).toMatchObject({ kind: 'Moved', review: 'stale', blocks: true, detail: 'Reviewed against revision 1. Revision 2 published it differently.', fix: { type: 'restamp', label: 'Still right, mark reviewed', record: 'Pier lamps position in Salt Roads' } });
        expect(moved.compare).toMatchObject({ type: 'list', moved: 'Pier lamps', from: 7, to: 2 });
        expect(rowAbout(screen, 'Home features Salt Roads first')).toMatchObject({ review: 'reviewed', blocks: false });
        expect(rowAbout(screen, 'Low Tide Hours: the short statement changes')).toMatchObject({ review: 'reviewed', compare: { type: 'text', before: expect.stringMatching(/^Five/), after: expect.stringMatching(/^Six/) } });
        // No row names a raw ID or a hash.
        for (const row of rowsOf(screen)) expect(row.summary).not.toMatch(/ph_|rev_|sha256-/);
        // The blockers the page knows on load are exactly the rows that say so.
        expect(screen.blockers.map((blocker) => blocker.rowId).sort()).toEqual(rowsOf(screen).filter((row) => row.blocks).map((row) => row.id).sort());
        expect(screen.blockers.map((blocker) => blocker.link.type).sort()).toEqual(['description', 'restamp']);
        const facts = displayFacts(screen, null, '/curation/preview/x');
        expect(facts.countLine).toMatch(/^\d+ changes for visitors: \d+ authored, \d+ derived\. 2 block publishing\.$/);
        expect(facts.bar).toMatchObject({ validate: 'available', publish: 'unavailable', reason: '2 changes block publishing. Fix them, then validate.' });
        // The frame opens on the most affected series page and scrolls its own window to the new photograph, never by a fragment.
        expect(screen.panel.draftSrc).toBe(`/curation/preview/${screen.draftId}/site/work/low-tide-hours`);
        expect(screen.panel.liveSrc).toBe('/work/low-tide-hours');
        expect(screen.panel.scrollToId).toBe(`photo-${BREAKWATER}`);
        expect(screen.panel.count).toBe('Low Tide Hours: 6 photographs, was 5');
        expect(facts.panel.rollback).toBe('Last-known-good revision 2 remains rollback-ready.');
    });

    it('says nothing to publish once the working catalog is the live revision, with the rollback line one back', async () => {
        await fixBoth(fixture);
        await publishFromCli(fixture);
        const screen = await view();
        expect(screen.kind).toBe('nothing');
        const facts = displayFacts(screen, null, null);
        expect(facts).toMatchObject({ mode: 'nothing', heading: 'Nothing to publish', bar: null, panel: { title: 'Live site', marker: 'Live, revision 3', rollback: 'Revision 2 is kept. `photos rollback` returns to it.' } });
    });
});

describe('Validate and Publish', () => {
    it('blocks with one list item per blocking row, then validates and publishes once both fixes are made from their rows', async () => {
        const screen = await view();
        const blocked = await act(screen, 'validate');
        const answer = answerOf(blocked);
        if (answer.kind !== 'blocked') throw new Error(`Validate answered ${answer.kind}`);
        expect(answer.lead).toBe('2 changes need you before revision 3 can publish. Revision 2 stays live.');
        // The join: every blocker has exactly one row that says so, and every blocking row a blocker.
        const blocking = rowsOf(answer).filter((row) => row.blocks).map((row) => row.id).sort();
        expect(answer.blockers.map((blocker) => blocker.rowId).sort()).toEqual(blocking);
        expect(answer.blockers.find((blocker) => blocker.link.type === 'restamp')).toMatchObject({ record: 'Salt Roads', field: 'order (Pier lamps)', link: { name: 'Pier lamps position in Salt Roads' } });

        // Mark description ready, from the row.
        const added = rowAbout(screen, `Add ${BREAKWATER_TITLE} to Low Tide Hours after photograph 04`);
        if (added.fix?.type !== 'description') throw new Error('No description fix');
        const marked = await publishAction(blocked, form({ intent: 'mark-description', rowId: added.id, photoId: added.fix.photoId, version: added.fix.version, valueHash: added.fix.valueHash, active: screen.active.revisionId }));
        expect(marked.answer).toEqual({ kind: 'fixed', rowId: added.id });
        expect(marked.result).toBeNull();
        expect(revalidated).toContain('/curation/publish');
        expect((await readAuthoredRecord(fixture.root, 'photo', BREAKWATER))?.alt).toMatchObject({ reviewed: true });

        // Still right, mark reviewed: only the stamp moves, never the value.
        const moved = rowAbout(await view(), 'Pier lamps moves from position 7 to 2 in Salt Roads');
        if (moved.fix?.type !== 'restamp') throw new Error('No restamp fix');
        const before = await readAuthoredRecord(fixture.root, 'series', SALT_ROADS);
        const restamped = await publishAction(marked, form({ intent: 'mark-reviewed', rowId: moved.id, kind: moved.fix.target.kind, id: moved.fix.target.id, version: moved.fix.target.version, hashes: JSON.stringify(moved.fix.target.hashes), field: moved.fix.field, active: screen.active.revisionId }));
        expect(restamped.answer).toEqual({ kind: 'fixed', rowId: moved.id });
        const after = await readAuthoredRecord(fixture.root, 'series', SALT_ROADS);
        expect(after?.photoIds).toEqual(before?.photoIds);
        expect(after?.review?.fields.photoIds).toMatchObject({ origin: 'curator', actor: 'curator:web', baseRevisionId: fixture.revisions[1], valueHash: hashValue(before?.photoIds) });

        const fixed = await view();
        expect(fixed.blockers).toEqual([]);
        expect(rowAbout(fixed, 'Pier lamps moves from position 7 to 2 in Salt Roads')).toMatchObject({ review: 'reviewed', blocks: false, detail: expect.stringMatching(/^Reviewed from this screen on /) });
        const valid = await act(fixed, 'validate', restamped);
        expect(valid.answer).toMatchObject({ kind: 'valid', stakes: expect.stringMatching(/^Publishing makes these \d+ changes live on every page\. Revision 2 stays rollback-ready\.$/) });
        expect(displayFacts(fixed, valid.result, null).bar).toMatchObject({ publish: 'available' });

        const published = await act(fixed, 'publish', valid);
        expect(published.answer).toMatchObject({ kind: 'published', live: { number: 3, revisionId: fixed.draftId }, previous: { number: 2 } });
        expect((await readActivePointer(fixture.root))?.revisionId).toBe(fixed.draftId);
        // The page isn't rendered again from the new pointer, which would read as Nothing to publish in place of the answer.
        expect(revalidated.filter((entry) => entry === '/' || entry === '/curation/publish')).toEqual(['/curation/publish', '/curation/publish']);
        const live = displayFacts(fixed, published.result, null);
        expect(live).toMatchObject({ mode: 'live', heading: 'Revision 3 is live', bar: null, groups: { authored: 'Authored', derived: 'Derived' }, compareLabels: { before: 'Before', after: 'Now live' }, panel: { title: 'Live site', marker: 'Live, revision 3', rollback: 'Revision 2 is kept. `photos rollback` returns to it.' } });
        expect(JSON.stringify({ ...live, ledger: undefined })).not.toMatch(/draft|preview/i);
    });

    it("won't publish without a passing validation of this candidate, even when the form skips the page's gate", async () => {
        const screen = await view();
        const state = await publishAction(IDLE_STATE, form({ intent: 'publish', draftId: screen.draftId, active: screen.active.revisionId }));
        expect(state.answer).toEqual({ kind: 'not-validated' });
        expect((await readActivePointer(fixture.root))?.revisionId).toBe(fixture.revisions[1]);
    });

    it('blocks at publish when a review goes stale after Validate, and the stale row says so with its Inbox fix', async () => {
        await fixBoth(fixture);
        const screen = await view();
        const valid = await act(screen, 'validate');
        expect(valid.answer?.kind).toBe('valid');
        await reopenBreakwater(fixture);
        const stopped = await act(screen, 'publish', valid);
        const answer = answerOf(stopped);
        if (answer.kind !== 'blocked-at-publish') throw new Error(`Publish answered ${answer.kind}`);
        expect(answer.lead).toBe('1 change went stale since you validated. Revision 2 stays live.');
        const row = rowAbout(answer, `Add ${BREAKWATER_TITLE} to Low Tide Hours after photograph 04`);
        expect(row).toMatchObject({ review: 'stale', blocks: true, detail: 'Its Inbox item needs a decision again.', fix: { type: 'inbox', eventId: fixture.breakwaterEvent } });
        expect(answer.blockers).toEqual([expect.objectContaining({ rowId: row.id, record: BREAKWATER_TITLE, field: 'place in Low Tide Hours', link: { type: 'inbox', record: BREAKWATER_TITLE, eventId: fixture.breakwaterEvent } })]);
        expect((await readActivePointer(fixture.root))?.revisionId).toBe(fixture.revisions[1]);
        expect(displayFacts(screen, stopped.result, null).bar).toMatchObject({ publish: 'unavailable', reason: 'Fix the change above, then validate again.' });
    });

    it('stops with the working catalog changed, and keeps revision 2 on every line', async () => {
        await fixBoth(fixture);
        const screen = await view();
        const valid = await act(screen, 'validate');
        await editBehindThePage(fixture);
        const changed = await act(screen, 'publish', valid);
        expect(changed.answer).toEqual({ kind: 'changed', body: 'It changed after this page loaded, so nothing was published. Revision 2 stays live.' });
        const facts = displayFacts(screen, changed.result, null);
        expect(facts).toMatchObject({ mode: 'out-of-date', heading: 'Preview your draft', ledgerHeading: 'Change ledger, out of date', showFixes: false, bar: { loadUpdated: true, validate: 'hidden', publish: 'hidden' }, revision: { current: 'Current public revision 2' } });
        expect(facts.panel).toMatchObject({ frameSrc: null, frameNote: 'Load the updated ledger to preview the new draft.' });
        expect(facts.panel.count).toBeUndefined();
    });

    it('says who published from the command line meanwhile, with the new pointer on the page', async () => {
        await fixBoth(fixture);
        const screen = await view();
        const valid = await act(screen, 'validate');
        await editBehindThePage(fixture);
        await publishFromCli(fixture, 'keyur');
        const answer = answerOf(await act(screen, 'publish', valid));
        expect(answer).toMatchObject({ kind: 'someone-published', live: { number: 3 }, previous: { number: 2 }, by: { actor: 'keyur', kind: 'publish', at: expect.any(String) } });
        const facts = displayFacts(screen, answer, null);
        expect(facts.revision.current).toBe('Current public revision 3');
        expect(facts.panel.rollback).toBe('Revision 2 is kept. `photos rollback` returns to it.');
        expect(facts.heading).toBe('Preview your draft');
    });

    it('says already live when this candidate went live meanwhile, and writes nothing more', async () => {
        await fixBoth(fixture);
        const screen = await view();
        const valid = await act(screen, 'validate');
        const live = await publishFromCli(fixture, 'keyur');
        expect(live).toBe(screen.draftId);
        const answer = answerOf(await act(screen, 'publish', valid));
        expect(answer).toMatchObject({ kind: 'already-live', live: { number: 3, revisionId: screen.draftId }, by: { actor: 'keyur', kind: 'publish' } });
        expect(displayFacts(screen, answer, null)).toMatchObject({ mode: 'live', ledgerHeading: 'Live in revision 3' });
    });

    it('answers busy while another process holds the catalog lock, and the validation still holds for the retry', async () => {
        await fixBoth(fixture);
        const screen = await view();
        const valid = await act(screen, 'validate');
        const release = await holdCatalogLock(fixture);
        try {
            const busy = await act(screen, 'publish', valid);
            expect(busy.answer).toMatchObject({ kind: 'busy', lock: 'catalog', retry: 'publish', since: expect.any(String) });
            expect(displayFacts(screen, busy.result, null)).toMatchObject({ validated: true, bar: { publish: 'available' } });
            const validating = await act(screen, 'validate', valid);
            expect(validating.answer).toMatchObject({ kind: 'busy', retry: 'validate' });
            expect(displayFacts(screen, validating.result, null).bar).toMatchObject({ publish: 'unavailable' });
        } finally {
            await release();
        }
        expect((await readActivePointer(fixture.root))?.revisionId).toBe(fixture.revisions[1]);
        // Once the other process lets go, the retry goes through on the validation that still holds.
        expect((await act(screen, 'publish', valid)).answer).toMatchObject({ kind: 'published', live: { number: 3 } });
    });

    it('answers failed when the publish stops before the switch, and Publish stays the retry', async () => {
        await fixBoth(fixture);
        const screen = await view();
        const valid = await act(screen, 'validate');
        const undo = blockRevisionFile(fixture, screen.draftId);
        let failed: PublishState;
        try {
            failed = await act(screen, 'publish', valid);
        } finally {
            undo();
        }
        expect(failed.answer).toMatchObject({ kind: 'failed', heading: 'The publish stopped before revision 3 went live', body: 'Revision 2 is still live, and visitors see no change. The server log names what failed. Publish again to retry.', live: null });
        expect(displayFacts(screen, failed.result, null)).toMatchObject({ mode: 'draft', validated: true, bar: { publish: 'available' } });
        expect((await readActivePointer(fixture.root))?.revisionId).toBe(fixture.revisions[1]);
        // The retry goes through.
        expect((await act(screen, 'publish', failed)).answer).toMatchObject({ kind: 'published', live: { number: 3 } });
    });
});

describe('the review fixes', () => {
    it('refuses Mark description ready with nothing written once the description moved, and keeps the result in place', async () => {
        const screen = await view();
        const blocked = await act(screen, 'validate');
        const added = rowAbout(screen, `Add ${BREAKWATER_TITLE} to Low Tide Hours after photograph 04`);
        if (added.fix?.type !== 'description') throw new Error('No description fix');
        const record = await readAuthoredRecord(fixture.root, 'photo', BREAKWATER);
        if (record === null) throw new Error('No photo record');
        await writeAuthoredRecord({ ...record, alt: { kind: 'described', text: 'Changed in the Inbox meanwhile.', reviewed: false } }, { expectedVersion: record.version, root: fixture.root });
        const refused = await publishAction(blocked, form({ intent: 'mark-description', rowId: added.id, photoId: BREAKWATER, version: added.fix.version, valueHash: added.fix.valueHash, active: screen.active.revisionId }));
        expect(refused.answer).toEqual({ kind: 'fix-refused', rowId: added.id, text: 'The description changed since the page loaded, so nothing was written.' });
        expect(refused.result).toBe(blocked.result);
        expect((await readAuthoredRecord(fixture.root, 'photo', BREAKWATER))?.alt).toMatchObject({ text: 'Changed in the Inbox meanwhile.', reviewed: false });
        expect(revalidated).not.toContain('/curation/publish');
    });

    it('refuses Still right, mark reviewed once the order moved, and stamps nothing', async () => {
        const screen = await view();
        const moved = rowAbout(screen, 'Pier lamps moves from position 7 to 2 in Salt Roads');
        if (moved.fix?.type !== 'restamp') throw new Error('No restamp fix');
        const series = await readAuthoredRecord(fixture.root, 'series', SALT_ROADS);
        if (series === null) throw new Error('No series');
        const reordered = [...series.photoIds].reverse();
        await writeAuthoredRecord({ ...series, photoIds: reordered }, { expectedVersion: series.version, root: fixture.root });
        const stamped = (await readAuthoredRecord(fixture.root, 'series', SALT_ROADS))?.review?.fields.photoIds;
        const refused = await publishAction(IDLE_STATE, form({ intent: 'mark-reviewed', rowId: moved.id, kind: 'series', id: SALT_ROADS, version: moved.fix.target.version, hashes: JSON.stringify(moved.fix.target.hashes), field: moved.fix.field, active: screen.active.revisionId }));
        expect(refused.answer).toEqual({ kind: 'fix-refused', rowId: moved.id, text: 'The order changed since the page loaded, so nothing was written.' });
        expect((await readAuthoredRecord(fixture.root, 'series', SALT_ROADS))?.review?.fields.photoIds).toEqual(stamped);
    });

    it("refuses a stamp for a value the screen didn't show, even at the version it read", async () => {
        const screen = await view();
        const moved = rowAbout(screen, 'Pier lamps moves from position 7 to 2 in Salt Roads');
        if (moved.fix?.type !== 'restamp') throw new Error('No restamp fix');
        const refused = await publishAction(IDLE_STATE, form({ intent: 'mark-reviewed', rowId: moved.id, kind: 'series', id: SALT_ROADS, version: moved.fix.target.version, hashes: JSON.stringify({ photoIds: hashValue(LOW_TIDE_IDS) }), field: 'order', active: screen.active.revisionId }));
        expect(refused.answer).toMatchObject({ kind: 'fix-refused' });
        expect(rowAbout(await view(), 'Pier lamps moves from position 7 to 2 in Salt Roads')).toMatchObject({ review: 'stale', blocks: true });
    });
});

describe('the fixes keep the Inbox in charge of what it settled', () => {
    /**
     * Salt Roads' order stamped as an Inbox approval made while revision 1 was
     * live would stamp it: naming the new photograph's item, against revision
     * 1. Revision 2 publishes the order differently, so the stale base reads
     * first and would hide that item if it were reopened (high review H1).
     */
    async function orderSettledByTheInbox(): Promise<void> {
        const event = await readEvent(fixture.root, fixture.breakwaterEvent);
        const series = await readAuthoredRecord(fixture.root, 'series', SALT_ROADS);
        if (event === null || series === null) throw new Error('The fixture has no Inbox item or no Salt Roads');
        await writeAuthoredRecord(series, {
            expectedVersion: series.version,
            root: fixture.root,
            review: { baseRevisionId: fixture.revisions[0], origin: 'curator', event: { id: event.id, version: event.version }, reviewedValues: { photoIds: hashValue(series.photoIds) }, actor: 'curator:web', reviewedAt: new Date().toISOString() },
        });
    }

    /** A row whose fix is Still right, mark reviewed, posted as the screen posts it. */
    async function stillRight(screen: ScreenView, row: LedgerRow): Promise<PublishState> {
        if (row.fix?.type !== 'restamp') throw new Error(`${row.summary} has no restamp fix`);
        const { target } = row.fix;
        return publishAction(IDLE_STATE, form({ intent: 'mark-reviewed', rowId: row.id, kind: target.kind, id: target.id, version: target.version, hashes: JSON.stringify(target.hashes), field: row.fix.field, active: screen.active.revisionId }));
    }

    it('refuses to mark reviewed a field whose Inbox item was reopened, even when the client names it, and writes nothing', async () => {
        await reopenBreakwater(fixture);
        const screen = await view();
        const series = await readAuthoredRecord(fixture.root, 'series', LOW_TIDE);
        if (series === null) throw new Error('No Low Tide Hours');
        const refused = await publishAction(IDLE_STATE, form({ intent: 'mark-reviewed', rowId: 'chg-0000000000000000', kind: 'series', id: LOW_TIDE, version: series.version, hashes: JSON.stringify({ photoIds: hashValue(series.photoIds) }), field: 'order', active: screen.active.revisionId }));
        expect(refused.answer).toEqual({ kind: 'fix-refused', rowId: 'chg-0000000000000000', text: 'Its Inbox item needs a decision again, so nothing was written. Decide it in the Inbox first.' });
        expect(await readAuthoredRecord(fixture.root, 'series', LOW_TIDE)).toEqual(series);
    });

    it('Still right on a stale base keeps the Inbox link, so a later reopen still blocks, and the row says Decide it in the Inbox', async () => {
        await orderSettledByTheInbox();
        const screen = await view();
        const moved = rowAbout(screen, 'Pier lamps moves from position 7 to 2 in Salt Roads');
        expect(moved).toMatchObject({ review: 'stale', blocks: true, fix: { type: 'restamp', label: 'Still right, mark reviewed' } });
        expect((await stillRight(screen, moved)).answer).toEqual({ kind: 'fixed', rowId: moved.id });
        expect((await readAuthoredRecord(fixture.root, 'series', SALT_ROADS))?.review?.fields.photoIds).toMatchObject({ baseRevisionId: fixture.revisions[1], actor: 'curator:web', event: { id: fixture.breakwaterEvent } });
        await reopenBreakwater(fixture);
        expect(rowAbout(await view(), 'Pier lamps moves from position 7 to 2 in Salt Roads')).toMatchObject({ review: 'stale', blocks: true, detail: 'Its Inbox item needs a decision again.', fix: { type: 'inbox', eventId: fixture.breakwaterEvent } });
    });

    it('refuses Still right once the Inbox item is reopened, where the stale base would have hidden it, and writes nothing', async () => {
        await orderSettledByTheInbox();
        const screen = await view();
        const moved = rowAbout(screen, 'Pier lamps moves from position 7 to 2 in Salt Roads');
        await reopenBreakwater(fixture);
        const before = await readAuthoredRecord(fixture.root, 'series', SALT_ROADS);
        const refused = await stillRight(screen, moved);
        expect(refused.answer).toEqual({ kind: 'fix-refused', rowId: moved.id, text: 'Its Inbox item needs a decision again, so nothing was written. Decide it in the Inbox first.' });
        expect(await readAuthoredRecord(fixture.root, 'series', SALT_ROADS)).toEqual(before);
    });

    it('offers Decide it in the Inbox from the start when a reopened item hides behind a stale base', async () => {
        await orderSettledByTheInbox();
        await reopenBreakwater(fixture);
        const screen = await view();
        const moved = rowAbout(screen, 'Pier lamps moves from position 7 to 2 in Salt Roads');
        expect(moved).toMatchObject({ blocks: true, detail: 'Its Inbox item needs a decision again.', fix: { type: 'inbox', eventId: fixture.breakwaterEvent } });
        expect(screen.blockers.find((blocker) => blocker.rowId === moved.id)?.link).toMatchObject({ type: 'inbox', eventId: fixture.breakwaterEvent });
    });

    it('refuses a fix once the live revision moved since the page loaded, so a stamp never names a revision nobody compared against', async () => {
        const screen = await view();
        const moved = rowAbout(screen, 'Pier lamps moves from position 7 to 2 in Salt Roads');
        await fixBoth(fixture);
        await publishFromCli(fixture);
        const series = await readAuthoredRecord(fixture.root, 'series', SALT_ROADS);
        const refused = await stillRight(screen, { ...moved, fix: moved.fix?.type === 'restamp' ? { ...moved.fix, target: { ...moved.fix.target, version: series?.version ?? 0, hashes: { photoIds: hashValue(series?.photoIds) } } } : moved.fix });
        expect(refused.answer).toEqual({ kind: 'fix-refused', rowId: moved.id, text: 'The live revision changed since the page loaded, so nothing was written.' });
        expect(await readAuthoredRecord(fixture.root, 'series', SALT_ROADS)).toEqual(series);
    });
});

describe('answers about what really happened', () => {
    it('after a publish fails past the switch, Publish finishes it, and the retry answers already live', async () => {
        await fixBoth(fixture);
        const screen = await view();
        const valid = await act(screen, 'validate');
        crash.after = 11;
        const failed = await act(screen, 'publish', valid);
        expect(failed.answer).toMatchObject({ kind: 'failed', heading: "Revision 3 is live, but the publish didn't finish", live: { number: 3, revisionId: screen.draftId }, retry: 'publish' });
        const facts = displayFacts(screen, failed.result, null);
        expect(facts).toMatchObject({ mode: 'live', validated: true, bar: { publish: 'available' } });
        // The screen posts the validation with the retry, as its bar does when facts.validated is true.
        const retried = await act(screen, 'publish', failed);
        expect(retried.answer).toMatchObject({ kind: 'already-live', live: { number: 3, revisionId: screen.draftId } });
    });

    it('names a rollback from the command line as one, with the older revision live again', async () => {
        await fixBoth(fixture);
        const r3 = await publishFromCli(fixture);
        await editBehindThePage(fixture);
        const screen = await view();
        const valid = await act(screen, 'validate');
        expect(valid.answer?.kind).toBe('valid');
        const result = await rollback({ dataRoot: fixture.root, revisionId: fixture.revisions[1], expectedActiveRevisionId: r3, actor: 'keyur', reason: 'from the command line', logger: quiet });
        expect(result.outcome).toBe('ROLLED_BACK');
        await editBehindThePage(fixture, 'The estuary at first light, once more.');
        const answer = answerOf(await act(screen, 'publish', valid));
        expect(answer).toMatchObject({ kind: 'someone-published', live: { number: 2 }, by: { actor: 'keyur', kind: 'rollback' } });
        expect(resultCopy(answer, screen)?.heading).toBe('Revision 2 is live again');
    });

    it('names a publish from this screen in another tab as this screen, not the command line', async () => {
        await fixBoth(fixture);
        const first = await view();
        const valid = await act(first, 'validate');
        // Another tab validates and publishes a newer draft from this screen.
        await editBehindThePage(fixture);
        const other = await view();
        expect((await act(other, 'publish', await act(other, 'validate'))).answer?.kind).toBe('published');
        const answer = answerOf(await act(first, 'publish', valid));
        expect(answer).toMatchObject({ kind: 'someone-published', by: { actor: 'curator:web', kind: 'publish' } });
        expect(resultCopy(answer, first)).toMatchObject({ heading: 'Revision 3 went live from another page', body: [expect.stringMatching(/^It went live from this screen at \d\d:\d\d, in another tab or window\. /)] });
    });
});

describe('the whole-page states', () => {
    it('says Not launched before the first activation', async () => {
        const blank = await createTestCatalog({ seed: 16, withAssets: true });
        const back = setDataDir(blank.root);
        try {
            expect(await loadPublishPage()).toEqual({ state: 'not-launched' });
        } finally {
            back();
            await blank.cleanup();
        }
    });

    it('says Unreadable, with nothing from the data root on the page, when its marker is gone', async () => {
        fs.renameSync(path.join(fixture.root, 'data-root.json'), path.join(fixture.root, 'data-root.json.aside'));
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            expect(await loadPublishPage()).toEqual({ state: 'unreadable' });
        } finally {
            errors.mockRestore();
            fs.renameSync(path.join(fixture.root, 'data-root.json.aside'), path.join(fixture.root, 'data-root.json'));
        }
    });
});
