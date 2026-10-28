// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listActivations } from '@/lib/catalog/repository';
import { readActivePointer, readAuthoredRecord } from '@/lib/catalog/working-layer';
import { IDLE_STATE, type Answer, type ScreenView } from '@/lib/curation/publish-facts';
import { localize, RESTORE_IDLE, type HistoryView, type RestoreState } from '@/lib/curation/publish-history';
import { resetLoginForTests } from '@/lib/curation/auth/login';
import { resetSessionsForTests } from '@/lib/curation/auth/sessions';
import { makeCuratorSecrets, type TestCuratorSecrets } from '@/test/helpers/curatorSecrets';
import { folderBytes } from '@/test/helpers/folderBytes';
import { setDataDir } from '@/test/helpers/tempDataRoot';
import { createHistoryFixture, createPublishFixture, createRemovalsFixture, fixBoth, holdCatalogLock, SALT_ROADS, SALT_ROADS_IDS, SALT_ROADS_TITLES, setAssetsAside, type PublishFixture } from '@/test/helpers/publishFixture';

// #15's 15-4 on real data roots, through the real curator boundary: the
// page's History read, the restore action's guards (anonymous, a wrong
// Origin, a missing reason, a stale precondition, a made-up ID) with a spy
// that shows rollback() never ran, and each answer from 15-2's own
// rollback(): done, done with a draft pending and its conflict in the
// ledger, changed under you, lock held, refused, already live. Then 16-3's
// Publish answer carrying History read again. Test values only.

/** The request headers requireCurator() reads. */
let requestHeaders = new Headers();
vi.mock('next/headers', () => ({ headers: async () => requestHeaders }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/lib/catalog/rollback', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/catalog/rollback')>();
    return { ...actual, rollback: vi.fn(actual.rollback) };
});

const { rollback } = await import('@/lib/catalog/rollback');
const { loadPublishPage } = await import('../load');
const { publishAction, restoreAction } = await import('../actions');

const HOST = '127.0.0.1:3001';
const ACTION = { host: HOST, origin: `http://${HOST}`, 'next-action': '7f'.repeat(21) };

let secrets: TestCuratorSecrets;
let fixture: PublishFixture;
let restoreDir: () => void;

beforeAll(async () => {
    secrets = await makeCuratorSecrets();
});
afterAll(() => secrets.cleanup());

function signedIn(extra: Record<string, string> = {}) {
    requestHeaders = new Headers({ ...ACTION, cookie: secrets.cookie(), ...extra });
}

async function onRoot(build: () => Promise<PublishFixture>) {
    fixture = await build();
    restoreDir = setDataDir(fixture.root);
    vi.stubEnv('PHOTOGRAPHY_LIBRARY_DIR', fixture.library);
}

beforeEach(() => {
    vi.stubEnv('CURATION_ENABLED', 'true');
    vi.stubEnv('HOSTNAME', '127.0.0.1');
    vi.stubEnv('CURATOR_TUNNEL_PORT', '');
    vi.stubEnv('CURATION_BIND_SCOPE', '');
    for (const [name, value] of Object.entries(secrets.env)) vi.stubEnv(name, value);
    vi.mocked(rollback).mockClear();
    signedIn();
});

afterEach(async () => {
    restoreDir?.();
    await fixture?.cleanup();
    vi.unstubAllEnvs();
    requestHeaders = new Headers();
    resetSessionsForTests();
    resetLoginForTests();
});

async function page(query: Parameters<typeof loadPublishPage>[0] = {}): Promise<{ view: ScreenView; history: HistoryView }> {
    const read = await loadPublishPage(query);
    if (read.state !== 'ready') throw new Error(`The page is ${read.state}`);
    return { view: read.view, history: read.history };
}

function form(fields: Record<string, string>): FormData {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.set(name, value);
    return data;
}

/** Restore `revision` against the plan the page showed for it. */
async function restore(history: HistoryView, revision: number, reason = 'The new order reads wrong.', patch: Record<string, string> = {}): Promise<RestoreState> {
    const plan = history.plans[revision];
    if (!plan) throw new Error(`No plan for revision ${revision}: ${Object.keys(history.plans).join(', ')}`);
    return restoreAction(RESTORE_IDLE, form({ revisionId: plan.revisionId, expectedActive: plan.activeRevisionId, reason, ...patch }));
}

const resultOf = (state: RestoreState) => {
    if (state.answer?.kind !== 'result') throw new Error(`Not a result: ${JSON.stringify(state.answer)}`);
    return state.answer.result;
};

const isNotFound = (error: unknown) => typeof error === 'object' && error !== null && 'digest' in error && String((error as { digest: unknown }).digest).startsWith('NEXT_HTTP_ERROR_FALLBACK;404');

describe('the page read', () => {
    it('lists every activation newest first, the live one marked with no Restore, and plans the one it can restore, with the draft line', async () => {
        await onRoot(() => createPublishFixture());
        const { history } = await page();
        expect(history.entries.map((entry) => [entry.title, entry.kind, entry.badge?.text ?? null, entry.eligibility.type])).toEqual([
            ['Revision 2', 'Publish', 'Live now', 'text'],
            ['Revision 1', 'Publish', null, 'restore'],
        ]);
        expect(localize(history.entries[0].when)).toMatch(/^Published \d+ \w+ at \d\d:\d\d UTC by keyur, with photos publish\.$/);
        expect(history.entries[0].reason).toEqual({ text: 'fixture revision 2', quoted: false });
        expect(history.entries[0].from).toBe('Replaced revision 1: 1 series changed.');
        const plan = history.plans[1];
        expect(plan).toMatchObject({ revision: 1, active: 2, impact: [{ text: 'Changes 1 series: Salt Roads' }] });
        expect(plan.draftNote).toMatch(/^Your draft stays, and this screen then compares it against revision 1\./);
    });
});

describe('the restore action guards', () => {
    beforeEach(async () => onRoot(() => createHistoryFixture()));

    it.each([
        ['an anonymous post', () => (requestHeaders = new Headers({ ...ACTION }))],
        ['a wrong Origin', () => signedIn({ origin: 'https://attacker.example' })],
        ['Origin null, as a post without JavaScript sends', () => signedIn({ origin: 'null' })],
    ])('refuses %s before reading a field, and writes nothing', async (_, set) => {
        const { history } = await page();
        set();
        const before = folderBytes(fixture.root);
        const plan = history.plans[2];
        const outcome = await restoreAction(RESTORE_IDLE, form({ revisionId: plan.revisionId, expectedActive: plan.activeRevisionId, reason: 'test' })).catch((error: unknown) => error);
        expect(isNotFound(outcome)).toBe(true);
        expect(rollback).not.toHaveBeenCalled();
        expect(folderBytes(fixture.root)).toEqual(before);
    });

    it('asks for a reason without calling rollback() when it is blank', async () => {
        const { history } = await page();
        expect((await restore(history, 2, '   ')).answer).toEqual({ kind: 'reason-missing' });
        expect(rollback).not.toHaveBeenCalled();
    });

    it('refuses a made-up revision ID without calling rollback()', async () => {
        const { history } = await page();
        const state = await restore(history, 2, 'test', { revisionId: 'rev_nothex' });
        expect(resultOf(state).heading).toMatch(/never went live, so it can't come back$/);
        expect(rollback).not.toHaveBeenCalled();
    });

    it('passes the shown live revision as the precondition, so a stale one restores nothing', async () => {
        const { history } = await page();
        const before = (await listActivations(fixture.root)).length;
        const [r1] = fixture.revisions;
        const state = await restore(history, 2, 'test', { expectedActive: r1 });
        expect(vi.mocked(rollback).mock.calls[0][0]).toMatchObject({ actor: 'curator:web', expectedActiveRevisionId: r1, waitMs: 0, reason: 'test' });
        expect(resultOf(state)).toMatchObject({ tone: 'change', heading: 'Revision 3 went live while this was open', actions: ['reload'], moved: { impact: 'past' } });
        expect((await listActivations(fixture.root)).length).toBe(before);
        expect((await readActivePointer(fixture.root))?.revisionId).toBe((fixture as PublishFixture & { live: string }).live);
    });
});

describe('the answers', () => {
    it('restores, then the page shows it done at the top of History, the new entry live, and the replaced one restorable', async () => {
        await onRoot(() => createHistoryFixture());
        const { history } = await page();
        const state = await restore(history, 2, 'The new order reads wrong.');
        expect(state.answer).toEqual({ kind: 'restored', sequence: 4, rebased: true });
        const [, r2] = fixture.revisions;
        expect((await readActivePointer(fixture.root))?.revisionId).toBe(r2);
        const after = await page({ restored: 4 });
        expect(after.history.done).toEqual({ heading: 'Revision 2 is live again', body: ['Visitors see it on their next page load. Revision 3 is kept in History.'] });
        const [top, three, two] = after.history.entries;
        expect(top).toMatchObject({ title: 'Revision 2', kind: 'Restore', badge: { text: 'Live now' }, reason: { text: 'The new order reads wrong.', quoted: true }, eligibility: { type: 'text' } });
        expect(localize(top.when)).toMatch(/^Restored \d+ \w+ at \d\d:\d\d UTC, from this screen\.$/);
        expect(top.from).toMatch(/^Replaced revision 3: /);
        expect(three.eligibility).toEqual({ type: 'restore', revision: 3 });
        expect(two.eligibility.type === 'text' && localize(two.eligibility.text)).toMatch(/^Live now: restored on \d+ \w+, above\.$/);
        // A stale or made-up ?restored= claims nothing.
        expect((await page({ restored: 3 })).history.done).toBeUndefined();
    });

    it('restores with a draft pending: the draft stays, the clashing order is a conflict in the ledger, and the done notice links to it', async () => {
        await onRoot(() => createPublishFixture());
        const { history } = await page();
        const state = await restore(history, 1);
        expect(state.answer?.kind).toBe('restored');
        const sequence = state.answer?.kind === 'restored' ? state.answer.sequence : 0;
        const series = await readAuthoredRecord(fixture.root, 'series', SALT_ROADS);
        expect(series?.conflicts?.map((conflict) => conflict.field)).toEqual(['photoIds']);
        const after = await page({ restored: sequence });
        const conflicted = [...after.view.ledger.authored, ...after.view.ledger.derived].filter((row) => row.review === 'conflict');
        expect(conflicted.length).toBeGreaterThan(0);
        expect(conflicted[0]).toMatchObject({ blocks: true, detail: 'Your draft and revision 1 both changed it.', fix: { type: 'hint', command: `photos edit ${SALT_ROADS}` } });
        expect(after.history.done?.body[1]).toBe(`${conflicted.length === 1 ? '1 change in your draft clashes' : `${conflicted.length} changes in your draft clash`} with revision 1.`);
        // More than one clash: the link says it goes to the first.
        expect(after.history.done?.jump).toEqual({ label: `${conflicted.length > 1 ? 'Go to the first change' : 'Go to the change'}: Salt Roads`, target: `${conflicted[0].id}-summary` });
    });

    it('answers lock held at once, with what stays live, and writes nothing', async () => {
        await onRoot(() => createHistoryFixture());
        const { history } = await page();
        const release = await holdCatalogLock(fixture);
        try {
            const before = (await listActivations(fixture.root)).length;
            const result = resultOf(await restore(history, 2));
            expect(result).toMatchObject({ tone: 'change', clock: true, heading: 'Another publish or restore is running', actions: ['cancel', 'retry'] });
            expect(localize(result.body[0])).toMatch(/^It started at \d\d:\d\d UTC\. Nothing changed, and revision 3 stays live\./);
            expect((await listActivations(fixture.root)).length).toBe(before);
        } finally {
            await release();
        }
    });

    it("refuses a revision today's checks refuse, after the page loaded, and names the photograph", async () => {
        await onRoot(() => createHistoryFixture());
        const { history } = await page();
        const [, r2] = fixture.revisions;
        const undo = await setAssetsAside(fixture, r2, SALT_ROADS_IDS[3]);
        try {
            const result = resultOf(await restore(history, 2));
            expect(result).toMatchObject({ tone: 'alert', heading: "Revision 2 can't come back", actions: ['close', 'reload'] });
            expect(result.list?.[0]).toBe(`1 of its photographs no longer has its image files: ${SALT_ROADS_TITLES[3]}.`);
            // The row says so too, once the page is loaded again.
            const again = await page();
            expect(again.history.entries.find((entry) => entry.title === 'Revision 2')?.eligibility).toMatchObject({ type: 'text', tone: 'alert', text: expect.stringMatching(/^It can't come back as it was: 1 of its photographs/) });
        } finally {
            undo();
        }
    });

    it('says already live when the target went live meanwhile, with the moved facts', async () => {
        await onRoot(() => createHistoryFixture());
        const { history } = await page();
        expect((await restore(history, 2)).answer?.kind).toBe('restored');
        const result = resultOf(await restore(history, 2));
        expect(result).toMatchObject({ tone: 'done', heading: 'Revision 2 is already live', actions: ['close-reload'], moved: { impact: 'hide' } });
    });
});

describe("16-3's answer carries History", () => {
    it('after Publish from this screen: the new revision live with no Restore, and Restore on the one it replaced', async () => {
        await onRoot(() => createPublishFixture());
        await fixBoth(fixture);
        const { view } = await page();
        const fields = { draftId: view.draftId, active: view.active.revisionId };
        const validated = await publishAction(IDLE_STATE, form({ intent: 'validate', ...fields }));
        const published = await publishAction(validated, form({ intent: 'publish', ...fields, validated: view.draftId }));
        const answer = published.answer as Answer;
        expect(answer.kind).toBe('published');
        const history = answer.kind === 'published' ? answer.history : undefined;
        expect(history?.entries.map((entry) => [entry.title, entry.badge?.text ?? null, entry.eligibility.type])).toEqual([
            ['Revision 3', 'Live now', 'text'],
            ['Revision 2', null, 'restore'],
            ['Revision 1', null, 'restore'],
        ]);
        expect(localize(history?.entries[0].when ?? '')).toMatch(/, from this screen\.$/);
        expect(history?.plans[2]?.draftNote).toBeUndefined();
    });

    it('not after Changed meanwhile, which moved only the candidate', async () => {
        await onRoot(() => createPublishFixture());
        await fixBoth(fixture);
        const { view } = await page();
        const fields = { draftId: view.draftId, active: view.active.revisionId };
        const validated = await publishAction(IDLE_STATE, form({ intent: 'validate', ...fields }));
        const { editBehindThePage } = await import('@/test/helpers/publishFixture');
        await editBehindThePage(fixture);
        const answer = (await publishAction(validated, form({ intent: 'publish', ...fields, validated: view.draftId }))).answer as Answer;
        expect(answer.kind).toBe('changed');
        expect('history' in answer).toBe(false);
    });
});

describe('History follows every 16-3 answer that moved the pointer, and only those (spec, History by 16-3 state)', () => {
    async function validated(): Promise<{ view: ScreenView; fields: Record<string, string>; valid: Awaited<ReturnType<typeof publishAction>> }> {
        await onRoot(() => createPublishFixture());
        await fixBoth(fixture);
        const { view } = await page();
        const fields = { draftId: view.draftId, active: view.active.revisionId };
        return { view, fields, valid: await publishAction(IDLE_STATE, form({ intent: 'validate', ...fields })) };
    }
    const historyOf = (answer: Answer) => ('history' in answer ? answer.history : undefined);

    it('someone published from the command line: the new live entry, and plans that still say a draft is pending', async () => {
        const { view, fields, valid } = await validated();
        const { editBehindThePage, publishFromCli } = await import('@/test/helpers/publishFixture');
        await editBehindThePage(fixture);
        await publishFromCli(fixture, 'keyur');
        const answer = (await publishAction(valid, form({ intent: 'publish', ...fields, validated: view.draftId }))).answer as Answer;
        expect(answer.kind).toBe('someone-published');
        const history = historyOf(answer);
        expect(history?.entries[0]).toMatchObject({ title: 'Revision 3', badge: { text: 'Live now' } });
        expect(history?.plans[2]?.draftNote).toMatch(/^Your draft stays/);
    });

    it('already live: History read again, the candidate live', async () => {
        const { view, fields, valid } = await validated();
        const { publishFromCli } = await import('@/test/helpers/publishFixture');
        await publishFromCli(fixture, 'keyur');
        const answer = (await publishAction(valid, form({ intent: 'publish', ...fields, validated: view.draftId }))).answer as Answer;
        expect(answer.kind).toBe('already-live');
        expect(historyOf(answer)?.entries[0]).toMatchObject({ title: 'Revision 3', badge: { text: 'Live now' } });
    });

    it('busy and not validated leave History as loaded: no History comes with them', async () => {
        const { view, fields, valid } = await validated();
        const release = await holdCatalogLock(fixture);
        try {
            const busy = (await publishAction(valid, form({ intent: 'publish', ...fields, validated: view.draftId }))).answer as Answer;
            expect(busy.kind).toBe('busy');
            expect(historyOf(busy)).toBeUndefined();
        } finally {
            await release();
        }
        const unvalidated = (await publishAction(IDLE_STATE, form({ intent: 'publish', ...fields }))).answer as Answer;
        expect(unvalidated.kind).toBe('not-validated');
        expect(historyOf(unvalidated)).toBeUndefined();
    });

    it('keeps the entries the page showed and the revision it checked', async () => {
        const { view, fields, valid } = await validated();
        const answer = (await publishAction(valid, form({ intent: 'publish', ...fields, validated: view.draftId, historyShown: '20', historyCheck: '1' }))).answer as Answer;
        expect(answer.kind).toBe('published');
        expect(historyOf(answer)?.entries).toHaveLength(3);
        expect(historyOf(answer)?.plans[1]).toBeDefined();
    });
});

const actualRollback = (await vi.importActual<typeof import('@/lib/catalog/rollback')>('@/lib/catalog/rollback')).rollback;

describe('an interrupted restore, through the action (high review M5)', () => {
    const actual = actualRollback;
    /** The next rollback() stops right after `step`, as a crash there would, through its own test hook. */
    const crashAfter = (step: number) =>
        vi.mocked(rollback).mockImplementationOnce((options) =>
            actual({ ...options, hooks: { afterStep: (at) => { if (at === step) throw new Error(`Test: the restore stops after step ${step}.`); } } }),
        );
    const errors = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

    it('stopped before the switch: the retry, nothing committed, and revision 3 still live', async () => {
        await onRoot(() => createHistoryFixture());
        const { history } = await page();
        const quiet = errors();
        crashAfter(10);
        const before = (await listActivations(fixture.root)).filter((entry) => entry.status === 'committed').length;
        const result = resultOf(await restore(history, 2));
        quiet.mockRestore();
        expect(localize(result.heading)).toBe('The restore stopped before revision 2 went live');
        expect(result.actions).toEqual(['cancel', 'retry']);
        expect((await listActivations(fixture.root)).filter((entry) => entry.status === 'committed').length).toBe(before);
        expect((await readActivePointer(fixture.root))?.revisionId).toBe((fixture as PublishFixture & { live: string }).live);
    });

    it('stopped after the switch: Finish restoring, and running the same form again settles it as already live', async () => {
        await onRoot(() => createHistoryFixture());
        const { history } = await page();
        const [, r2] = fixture.revisions;
        const quiet = errors();
        crashAfter(11);
        const stopped = resultOf(await restore(history, 2));
        quiet.mockRestore();
        expect(stopped).toMatchObject({ heading: "Revision 2 is live, but the restore didn't finish", actions: ['close-reload', 'finish'], moved: { impact: 'hide' } });
        expect((await readActivePointer(fixture.root))?.revisionId).toBe(r2);
        // Finish restoring posts the same form: the restore settles under the lock and reads as already live.
        const finished = resultOf(await restore(history, 2));
        expect(finished).toMatchObject({ tone: 'done', heading: 'Revision 2 is already live' });
        expect(finished.body).toContain('History now records the restore that was interrupted.');
        const restores = (await listActivations(fixture.root)).filter((entry) => entry.kind === 'rollback' && entry.status === 'committed');
        expect(restores).toHaveLength(1);
    });
});

describe('a forged target', () => {
    it('refuses a well-formed ID that never went live, the draft candidate, with nothing written', async () => {
        await onRoot(() => createPublishFixture());
        const { view, history } = await page();
        const before = folderBytes(fixture.root);
        const result = resultOf(await restore(history, 1, 'test', { revisionId: view.draftId }));
        expect(result.heading).toBe("Revision 3 never went live, so it can't come back");
        expect(folderBytes(fixture.root)).toEqual(before);
    });
});

describe('a restore that removes many photographs', () => {
    it('names the first 5 in the impact list and puts the rest behind "and 3 more"', async () => {
        await onRoot(() => createRemovalsFixture());
        const { history } = await page();
        const plan = Object.values(history.plans).find((entry) => entry.impact.some((line) => line.more));
        expect(plan?.impact).toEqual(
            expect.arrayContaining([
                { text: 'Removes 1 series: Salt Roads' },
                { text: `Removes 8 photographs: ${SALT_ROADS_TITLES.slice(0, 5).join(', ')}`, more: SALT_ROADS_TITLES.slice(5) },
            ]),
        );
    });
});
