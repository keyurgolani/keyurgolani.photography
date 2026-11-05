// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publish } from '@/lib/catalog/publish';
import { hashValue } from '@/lib/catalog/review';
import { rollback } from '@/lib/catalog/rollback';
import { createTestCatalog } from '@/lib/catalog/testing';
import { readActivePointer, readAuthoredRecord } from '@/lib/catalog/working-layer';
import { writeAuthoredRecord } from '@/lib/catalog/working-layer-writer';
import { displayFacts, IDLE_STATE, type LedgerRow, type PublishState, type ScreenView } from '@/lib/curation/publish-facts';
import { folderBytes } from '@/test/helpers/folderBytes';
import { setDataDir } from '@/test/helpers/tempDataRoot';
import { createPublishFixture, fixBoth, LOW_TIDE, publishFromCli, reopenBreakwater, SALT_ROADS, type PublishFixture } from '@/test/helpers/publishFixture';

// A9 (#182) on the Publish screen's real data roots: "Use the published
// value" through the screen's one action and the shared writer, the watch
// that re-reads stale rows and the live revision every 60 s, chapter and
// positions rows in the screen's words, and the r1, r2, rollback walk of the
// revision numbers. requireCurator() runs first in every action: here it
// lets a call through, or refuses it as the boundary would.

const revalidated: string[] = [];
const session = { anonymous: false };
class Refused extends Error {}
vi.mock('@/lib/curation/auth', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    requireCurator: async () => {
        if (session.anonymous) throw new Refused('NEXT_NOT_FOUND');
        return {};
    },
}));
vi.mock('next/cache', () => ({ revalidatePath: (at: string) => void revalidated.push(at) }));
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };

const { loadPublishPage } = await import('../load');
const { publishAction, watchPublish } = await import('../actions');

let fixture: PublishFixture;
let restore: () => void;

beforeEach(async () => {
    fixture = await createPublishFixture();
    restore = setDataDir(fixture.root);
    revalidated.length = 0;
    session.anonymous = false;
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

/** The form the row's "Use the published value" posts. */
function publishedForm(screen: ScreenView, row: LedgerRow, overrides: Record<string, string | number> = {}): FormData {
    const target = row.usePublished;
    if (!target) throw new Error(`The row ${row.summary} offers no published value`);
    return form({ intent: 'use-published', rowId: row.id, kind: target.kind, id: target.id, field: target.field, version: target.version, valueHash: target.valueHash, active: screen.active.revisionId, ...overrides });
}

const MOVED = 'Pier lamps moves from position 7 to 2 in Salt Roads';

describe('the rows (A9)', () => {
    it("words the positions a move shifts in the series' derived row", async () => {
        const screen = await view();
        expect(rowAbout(screen, /^Salt Roads: 5 other photographs shift one place later$/)).toMatchObject({ kind: 'Recalculated', review: 'automatic', blocks: false });
        expect(rowAbout(screen, /^Low Tide Hours: 6 photographs, was 5\. 1 other photograph shifts one place later$/)).toMatchObject({ kind: 'Recalculated' });
    });

    it('offers Use the published value on the stale order, with the record in its name, and on nothing that is reviewed or a suggestion', async () => {
        const screen = await view();
        const moved = rowAbout(screen, MOVED);
        expect(moved.usePublished).toMatchObject({ kind: 'series', id: SALT_ROADS, field: 'photoIds', record: 'the order of Salt Roads' });
        expect(moved.usePublished?.note).toBe('This puts back the whole published order of Salt Roads.');
        const others = rowsOf(screen).filter((row) => row.id !== moved.id && row.usePublished);
        expect(others).toEqual([]);
    });

    it('shows a text change as words removed and added', async () => {
        const row = rowAbout(await view(), 'Low Tide Hours: the short statement changes');
        expect(row.compare).toMatchObject({ type: 'text', diff: [{ type: 'removed', text: 'Five' }, { type: 'added', text: 'Six' }, { type: 'same', text: ' mornings on the estuary before the water comes back.' }] });
    });
});

describe('Use the published value (A9)', () => {
    it("puts the live revision's order back, says so, and the page reads the ledger again", async () => {
        const screen = await view();
        const state = await publishAction(IDLE_STATE, publishedForm(screen, rowAbout(screen, MOVED)));
        expect(state.answer).toEqual({ kind: 'reverted', text: 'The published order of Salt Roads is back in the draft. Validate again before you publish.' });
        expect(state.result).toBeNull();
        expect(revalidated).toEqual(['/curation/publish']);
        const after = await view();
        expect(rowsOf(after).some((row) => row.summary === MOVED)).toBe(false);
        expect(after.draftId).not.toBe(screen.draftId);
    });

    it('refuses with nothing written when the record moved since the page loaded, or the live revision did', async () => {
        const screen = await view();
        const row = rowAbout(screen, MOVED);
        const before = folderBytes(fixture.root);
        const moved = await publishAction(IDLE_STATE, publishedForm(screen, row, { version: (row.usePublished?.version ?? 1) + 5 }));
        expect(moved.answer).toMatchObject({ kind: 'fix-refused', rowId: row.id, text: 'The order changed since the page loaded, so nothing was written.' });
        const live = await publishAction(IDLE_STATE, publishedForm(screen, row, { active: fixture.revisions[0] }));
        expect(live.answer).toMatchObject({ kind: 'fix-refused', text: 'The live revision changed since the page loaded, so nothing was written.' });
        expect(folderBytes(fixture.root)).toEqual(before);
    });

    it('drops junk the form could carry before the writer sees it: a field outside the list, a bad hash, an ID too long', async () => {
        const screen = await view();
        const row = rowAbout(screen, MOVED);
        const before = folderBytes(fixture.root);
        const junks: Record<string, string>[] = [{ field: 'slug' }, { field: 'photoIds[x]' }, { valueHash: 'not-a-hash' }, { id: 'x'.repeat(300) }, { kind: 'activation' }, { rowId: '<script>' }];
        for (const junk of junks) {
            const state = await publishAction(IDLE_STATE, publishedForm(screen, row, junk));
            expect(state.answer?.kind, JSON.stringify(junk)).toBe('fix-refused');
        }
        expect(folderBytes(fixture.root)).toEqual(before);
    });

    it('refuses while an Inbox item the field rests on needs a decision again', async () => {
        await reopenBreakwater(fixture);
        const screen = await view();
        const row = rowAbout(screen, MOVED);
        const record = await readAuthoredRecord(fixture.root, 'series', LOW_TIDE);
        const state = await publishAction(IDLE_STATE, publishedForm(screen, row, { id: LOW_TIDE, version: record?.version ?? 0, valueHash: hashValue(record?.kind === 'series' ? record.photoIds : null) }));
        expect(state.answer).toMatchObject({ kind: 'fix-refused', text: 'Its Inbox item needs a decision again, so nothing was written. Decide it in the Inbox first.' });
    });

    it('runs requireCurator() first: an anonymous post is refused before a field is read, and writes nothing', async () => {
        const screen = await view();
        const before = folderBytes(fixture.root);
        session.anonymous = true;
        await expect(publishAction(IDLE_STATE, publishedForm(screen, rowAbout(screen, MOVED)))).rejects.toBeInstanceOf(Refused);
        expect(folderBytes(fixture.root)).toEqual(before);
    });
});

describe('the watch (A9)', () => {
    it('answers with the rows that are stale now, by their row IDs, and nothing moved', async () => {
        const screen = await view();
        const answer = await watchPublish({ draftId: screen.draftId, active: screen.active.revisionId });
        expect(answer).toMatchObject({ kind: 'ok', draftChanged: false });
        if (answer.kind !== 'ok') throw new Error(answer.kind);
        expect(answer.stale.map((entry) => entry.rowId)).toEqual([rowAbout(screen, MOVED).id]);
    });

    it('finds the rows a reopened Inbox item makes stale after the page loaded', async () => {
        const screen = await view();
        await reopenBreakwater(fixture);
        const answer = await watchPublish({ draftId: screen.draftId, active: screen.active.revisionId });
        if (answer.kind !== 'ok') throw new Error(answer.kind);
        expect(answer.stale.length).toBeGreaterThan(1);
        expect(answer.stale.map((entry) => entry.summary)).toEqual(expect.arrayContaining([expect.stringMatching(/Breakwater, first light/)]));
    });

    it('says the base moved once another revision is live, with its number', async () => {
        const screen = await view();
        await fixBoth(fixture);
        await publishFromCli(fixture);
        expect(await watchPublish({ draftId: screen.draftId, active: screen.active.revisionId })).toMatchObject({ kind: 'base-moved', live: { number: 3 } });
    });

    it('answers unavailable for input it did not send, and writes nothing either way', async () => {
        const before = folderBytes(fixture.root);
        for (const input of [{ draftId: 'x', active: 'y' }, null, 'rev_', { draftId: `rev_${'0'.repeat(64)}`, active: 7 }]) {
            expect(await watchPublish(input as never)).toEqual({ kind: 'unavailable' });
        }
        expect(folderBytes(fixture.root)).toEqual(before);
    });

    it('runs requireCurator() first', async () => {
        const screen = await view();
        session.anonymous = true;
        await expect(watchPublish({ draftId: screen.draftId, active: screen.active.revisionId })).rejects.toBeInstanceOf(Refused);
    });

    it('shows Base moved: the ledger goes out of date and the bar offers only Load the updated ledger', async () => {
        const screen = await view();
        const facts = displayFacts(screen, null, '/curation/preview/x', { revisionId: `rev_${'b'.repeat(64)}`, number: 3, hash: 'bbbbbbbb' });
        expect(facts).toMatchObject({ mode: 'out-of-date', revision: { current: 'Current public revision 3' }, bar: { loadUpdated: true } });
        expect(facts.outOfDate).toBe('Base moved. Revision 3 went live after this page loaded, so this compares the draft against revision 2.');
    });
});

describe('the r1, r2, rollback walk (A9)', () => {
    it('names the live revision and the next one: 1 after the rollback, 2 for a draft equal to r2, and 3 for a new one', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-walk-'));
        const root = path.join(dir, 'data');
        const catalog = await createTestCatalog({ root, photos: 4, series: 1, withAssets: true });
        const undo = setDataDir(root);
        try {
            const r1 = await publish({ dataRoot: root, actor: 'keyur', reason: 'walk r1', confirmLaunch: true, logger: quiet });
            if (r1.outcome !== 'PUBLISHED') throw new Error(`${r1.outcome}: ${r1.message}`);
            const seriesId = catalog.series[0].id;
            const retitle = async (title: string) => {
                const record = await readAuthoredRecord(root, 'series', seriesId);
                if (record?.kind !== 'series') throw new Error('No series');
                await writeAuthoredRecord({ ...record, title }, { expectedVersion: record.version, root });
            };
            await retitle('Walk title two');
            const r2 = await publish({ dataRoot: root, actor: 'keyur', reason: 'walk r2', logger: quiet });
            if (r2.outcome !== 'PUBLISHED') throw new Error(`${r2.outcome}: ${r2.message}`);
            const back = await rollback({ dataRoot: root, revisionId: r1.revisionId as string, expectedActiveRevisionId: r2.revisionId as string, actor: 'keyur', reason: 'walk back', logger: quiet });
            expect(back.outcome).toBe('ROLLED_BACK');
            expect((await readActivePointer(root))?.revisionId).toBe(r1.revisionId);
            await retitle('Walk title two');
            const equal = await view();
            expect(equal.draftId).toBe(r2.revisionId);
            expect(displayFacts(equal, null, null)).toMatchObject({ heading: 'Preview catalog revision 2', revision: { current: 'Current public revision 1' } });
            await retitle('Walk title three');
            const fresh = await view();
            expect(fresh.draftNumber).toBe(3);
            expect(displayFacts(fresh, null, null).revision.current).toBe('Current public revision 1');
        } finally {
            undo();
            await catalog.cleanup();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);
});

// Keep the state type in use, so a change to it shows here first.
export type { PublishState };
