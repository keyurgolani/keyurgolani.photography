// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { RevisionChanges } from '@/lib/catalog/history';
import {
    blockedText,
    blockingReasons,
    doneView,
    editorialText,
    historyView,
    HISTORY_LEAD,
    impactLines,
    LIVE_TEXT,
    localize,
    publishWords,
    restorableRevisions,
    restoreResult,
    restoreWords,
    SINGLE_LEAD,
    UNCHECKED_TEXT,
    UNREADABLE_TEXT,
    type EntryInput,
    type HistoryViewInput,
    type OutcomeFacts,
    type PlanStatus,
} from '../publish-history';

// #15's 15-4: History's view and copy from 15-2's results, without a data
// root. The list (kinds, lines, eligibility per row kind, the planning
// budget's Check, Show older), the impact list, the refusal reasons, and the
// dialog's answer for every rollback() outcome (spec revision 2).

const rev = (n: number) => `rev_${String(n).padStart(8, '0')}${'a'.repeat(56)}`;
const none = { added: [], removed: [], changed: [] };
const changes = (patch: Partial<RevisionChanges> = {}): RevisionChanges => ({ series: { ...none }, photos: { ...none }, site: false, ...patch });

interface Row {
    sequence: number;
    revision: number;
    kind?: 'publish' | 'rollback';
    status?: 'committed' | 'pending' | 'abandoned';
    previous?: number | null;
    actor?: string;
    reason?: string;
    at?: string;
    live?: boolean;
    unreadable?: boolean;
    parent?: number | null;
    parentChanges?: RevisionChanges | null;
    replaced?: RevisionChanges | null;
}

function row(input: Row): EntryInput {
    const interrupted = input.status === 'pending' || input.status === 'abandoned';
    const previous = input.previous === undefined ? (input.revision > 1 ? input.revision - 1 : null) : input.previous;
    const parent = input.parent === undefined ? previous : input.parent;
    return {
        activation: {
            sequence: input.sequence,
            kind: input.kind ?? 'publish',
            status: input.status ?? 'committed',
            revisionId: rev(input.revision),
            revisionNumber: input.revision,
            previousRevisionId: previous === null ? null : rev(previous),
            actor: input.actor ?? 'curator:web',
            reason: input.reason ?? 'Publish screen',
            startedAt: input.at ?? '2026-10-26T14:05:00.000Z',
            ...(interrupted ? {} : { committedAt: input.at ?? '2026-10-26T14:05:00.000Z' }),
            acceptedRules: [],
            lockTakeover: null,
        },
        state: interrupted ? 'interrupted' : 'committed',
        live: Boolean(input.live),
        summary: input.unreadable ? null : { parentRevisionId: parent === null ? null : rev(parent), seriesCount: 3, photoCount: 26, changes: input.parentChanges === undefined ? changes({ photos: { added: ['ph_a', 'ph_b'], removed: ['ph_c'], changed: [] }, series: { added: [], removed: [], changed: ['ser_x'] } }) : input.parentChanges },
        ...(input.replaced !== undefined ? { replaced: input.replaced } : {}),
    };
}

/** Every day and time token named in UTC, as the screen names them before hydration. */
// 'Etc/UTC' is UTC without the label the server's own render adds ('UTC'), so these read as plain times.
const local = <T,>(value: T): T => JSON.parse(JSON.stringify(value), (_, entry: unknown) => (typeof entry === 'string' ? localize(entry, 'Etc/UTC') : entry)) as T;

const view = (rows: EntryInput[], planned: Record<number, PlanStatus> = {}, shown = 10, extra: Partial<HistoryViewInput> = {}) =>
    local(historyView({
        rows,
        shown,
        planned: new Map(Object.entries(planned).map(([n, status]) => [rev(Number(n)), status])),
        plans: {},
        hrefs: { check: (revision, sequence) => `/c?check=${revision}#entry-${sequence}-title`, more: (count, first) => `/c?history=${count}#entry-${first}-title` },
        ...extra,
    }));

describe('times', () => {
    it("name a day and a time in the owner's zone, UTC before the browser says which", () => {
        const text = localize('Published {{day:2026-10-27T03:30:00.000Z}} at {{time:2026-10-27T03:30:00.000Z}}.');
        // The server's render, and a page without JavaScript, say the time is UTC (build design review P3-5).
        expect(text).toBe('Published 27 October at 03:30 UTC.');
        expect(localize('Published {{day:2026-10-27T03:30:00.000Z}} at {{time:2026-10-27T03:30:00.000Z}}.', 'America/Los_Angeles')).toBe('Published 26 October at 20:30.');
    });
});

describe('one convention for dates', () => {
    // Build design review P2-2: one evening reads as one day on the whole screen, in the owner's zone.
    it("names History's day in the owner's zone, as the ledger's, so a late evening isn't the next day", () => {
        const at = '2026-10-28T00:27:00.000Z';
        const rows = [row({ sequence: 1, revision: 1, at, live: true, previous: null, parent: null })];
        const entry = historyView({ rows, shown: 10, planned: new Map(), plans: {}, hrefs: { check: () => '', more: () => '' } }).entries[0];
        expect(localize(entry.when, 'America/Los_Angeles')).toBe('Published 27 October at 17:27, from this screen.');
        expect(localize(entry.when)).toBe('Published 28 October at 00:27 UTC, from this screen.');
    });
});

describe('the change lines', () => {
    it('lead with the change and put the noun on the first count only', () => {
        expect(publishWords(changes({ photos: { added: ['a', 'b'], removed: ['c'], changed: [] }, series: { added: [], removed: [], changed: ['s'] } }))).toBe('2 photographs added, 1 removed, 1 series changed');
        expect(restoreWords(changes({ photos: { added: ['a'], removed: ['b', 'c'], changed: [] }, series: { added: [], removed: [], changed: ['s'] } }))).toBe('removed 2 photographs, brought back 1, changed 1 series');
        expect(publishWords(changes({ site: true }))).toBe("Home's featured series or the order of series on Work changed");
        // Read apart, as the dialog reads them (build design review P3-1).
        expect(publishWords(changes({ site: true }), { featured: true, order: false })).toBe("Home's featured series changed");
        expect(publishWords(changes({ site: true }), { featured: false, order: true })).toBe('the order of series on Work changed');
        expect(restoreWords(changes({ site: true }), { featured: true, order: true })).toBe("changed Home's featured series, changed the order of series on Work");
        expect(publishWords(changes())).toBeNull();
    });
});

describe('the list', () => {
    const rows = [
        row({ sequence: 1, revision: 1, actor: 'keyur', reason: 'Launch', previous: null, at: '2026-09-03T20:15:00.000Z' }),
        row({ sequence: 2, revision: 2, at: '2026-09-20T09:03:00.000Z' }),
        row({ sequence: 3, revision: 3, status: 'abandoned', actor: 'keyur', at: '2026-10-02T13:58:00.000Z' }),
        row({ sequence: 4, revision: 3, unreadable: true, actor: 'keyur' }),
        row({ sequence: 5, revision: 4, actor: 'keyur', reason: 'Salt Roads order' }),
        row({ sequence: 6, revision: 5, at: '2026-10-25T18:40:00.000Z' }),
        row({ sequence: 7, revision: 6, at: '2026-10-26T14:05:00.000Z', live: true }),
    ];

    it('shows newest first with noun kinds, the owner phrases, and the live entry marked in text with no Restore', () => {
        const history = view(rows, { 5: { outcome: 'READY' }, 4: { outcome: 'VALIDATION_FAILED', reasons: ['a description in it names a file on this computer'] }, 2: { outcome: 'READY' }, 1: { outcome: 'READY' } });
        expect(history.lead).toBe(HISTORY_LEAD);
        expect(history.entries.map((entry) => entry.sequence)).toEqual([7, 6, 5, 4, 3, 2, 1]);
        const [live, five, four, three, interrupted, two, one] = history.entries;
        expect(live).toMatchObject({ title: 'Revision 6', badge: { text: 'Live now', tone: 'done' }, kind: 'Publish', when: 'Published 26 October at 14:05, from this screen.', facts: `Entry 7 · ${rev(6).slice(4, 12)}`, eligibility: { type: 'text', text: LIVE_TEXT, tone: 'quiet' } });
        expect(live.reason).toBeUndefined();
        expect(live.from).toBe('Replaced revision 5: 2 photographs added, 1 removed, 1 series changed.');
        expect(live.held).toBe('3 series, 26 photographs in all.');
        expect(five.eligibility).toEqual({ type: 'restore', revision: 5 });
        expect(four).toMatchObject({ when: 'Published 26 October at 14:05 by keyur, with photos publish.', reason: { text: 'Salt Roads order', quoted: false } });
        expect(four.eligibility).toEqual({ type: 'text', text: "It can't come back as it was: a description in it names a file on this computer.", tone: 'alert' });
        expect(three.eligibility).toEqual({ type: 'text', text: UNREADABLE_TEXT, tone: 'alert' });
        expect(three.held).toBeUndefined();
        expect(interrupted).toMatchObject({ title: "A publish that didn't finish", badge: { text: "Didn't finish", tone: 'quiet' }, kind: 'Publish', when: 'Started 2 October at 13:58 by keyur, with photos publish.', from: 'It never went live, so visitors never saw it.', facts: 'Entry 3', eligibility: { type: 'none' } });
        expect(two.eligibility).toEqual({ type: 'restore', revision: 2 });
        expect(one).toMatchObject({ from: 'The first revision.', reason: { text: 'Launch', quoted: false }, eligibility: { type: 'restore', revision: 1 } });
        expect(history.count).toBeNull();
        expect(history.more).toBeNull();
    });

    it('lists the restorable revisions newest first, once each, without the live one, an unreadable one, or an interrupted one', () => {
        expect(restorableRevisions(rows, 10)).toEqual([rev(5), rev(4), rev(2), rev(1)]);
        expect(restorableRevisions(rows, 3)).toEqual([rev(5), rev(4)]);
    });

    it('offers Check revision N for a restorable revision with no plan, past the budget', () => {
        const history = view(rows, { 5: { outcome: 'READY' } });
        expect(history.entries.find((entry) => entry.sequence === 2)?.eligibility).toEqual({ type: 'check', revision: 2, href: '/c?check=2#entry-2-title' });
    });

    it("says a plan that couldn't be made can't be checked", () => {
        const history = view(rows, { 5: { outcome: 'INTEGRITY_MISMATCH' } });
        expect(history.entries.find((entry) => entry.sequence === 6)?.eligibility).toEqual({ type: 'text', text: UNCHECKED_TEXT, tone: 'alert' });
    });

    it('after a restore: the restore reads against the revision it replaced, quoted, and the older entry for it points up by date', () => {
        const after = [
            ...rows.map((entry) => ({ ...entry, live: false })),
            row({ sequence: 8, revision: 5, kind: 'rollback', previous: 6, parent: 4, reason: 'The new cover is cropped wrong.', at: '2026-10-27T09:12:00.000Z', live: true, replaced: changes({ photos: { added: ['a'], removed: ['b', 'c'], changed: [] }, series: { added: [], removed: [], changed: ['s'] } }) }),
        ];
        const history = view(after, { 6: { outcome: 'READY' } });
        const [restore, six, five] = history.entries;
        expect(restore).toMatchObject({ title: 'Revision 5', kind: 'Restore', when: 'Restored 27 October at 09:12, from this screen.', reason: { text: 'The new cover is cropped wrong.', quoted: true }, from: 'Replaced revision 6: removed 2 photographs, brought back 1, changed 1 series.', eligibility: { type: 'text', text: LIVE_TEXT, tone: 'quiet' } });
        expect(six.eligibility).toEqual({ type: 'restore', revision: 6 });
        expect(five.eligibility).toEqual({ type: 'text', text: 'Live now: restored on 27 October, above.', tone: 'quiet' });
    });

    it('sends an older entry for a revision to its newest entry, so each Restore name is unique', () => {
        const restored = [
            row({ sequence: 1, revision: 1, previous: null, live: false }),
            row({ sequence: 2, revision: 2, live: false }),
            row({ sequence: 3, revision: 1, kind: 'rollback', previous: 2, live: false, replaced: null, at: '2026-10-20T10:00:00.000Z' }),
            row({ sequence: 4, revision: 3, previous: 1, live: true }),
        ];
        const history = view(restored, { 1: { outcome: 'READY' }, 2: { outcome: 'READY' } });
        expect(history.entries.find((entry) => entry.sequence === 3)?.eligibility).toEqual({ type: 'restore', revision: 1 });
        expect(history.entries.find((entry) => entry.sequence === 1)?.eligibility).toEqual({ type: 'text', text: 'Restore it from its newest entry, 20 October, above.', tone: 'quiet' });
        expect(history.entries.find((entry) => entry.sequence === 3)?.from).toBe('Replaced revision 2.');
    });

    it('has the single-revision lead for one live entry', () => {
        const history = view([row({ sequence: 1, revision: 1, previous: null, live: true })]);
        expect(history.lead).toBe(SINGLE_LEAD);
        expect(history.entries[0].eligibility).toEqual({ type: 'text', text: LIVE_TEXT, tone: 'quiet' });
    });

    it('shows 10 with Show 10 older entries, names the last partial step, and stops at the cap', () => {
        const many = Array.from({ length: 48 }, (_, index) => row({ sequence: index + 1, revision: index + 1, previous: index === 0 ? null : index, live: index === 47 }));
        const first = view(many);
        expect(first.entries).toHaveLength(10);
        expect(first.count).toBe('Showing the newest 10 of 48 entries.');
        expect(first.more).toEqual({ label: 'Show 10 older entries', href: '/c?history=20#entry-38-title' });
        const last = view(many, {}, 40);
        expect(last.more).toEqual({ label: 'Show the last 8 entries', href: '/c?history=48#entry-8-title' });
        const all = view(many, {}, 48);
        expect(all.count).toBeNull();
        const huge = Array.from({ length: 130 }, (_, index) => row({ sequence: index + 1, revision: index + 1, previous: index === 0 ? null : index, live: index === 129 }));
        const capped = view(huge, {}, 100);
        expect(capped.more).toBeNull();
        expect(capped.count).toBe('Showing the newest 100 of 130 entries. photos history lists the rest.');
    });
});

describe('accepted rules', () => {
    it('says what a restore accepted in words, never a rule ID', () => {
        const restored = row({ sequence: 4, revision: 2, kind: 'rollback', previous: 3, live: true, replaced: null });
        restored.activation.acceptedRules = ['accent.contrast'];
        const [entry] = view([row({ sequence: 3, revision: 3, previous: 2 }), restored]).entries;
        expect(entry.extra).toBe("Accepted at restore: an accent color that's hard to read on the Viewer's dark bands.");
        expect(entry.extra).not.toMatch(/accent\./);
    });
});

describe('the refusal reasons', () => {
    it('says each rule family once in owner words, with the photographs named', () => {
        const reasons = blockingReasons(
            [
                { code: 'assets.variant', record: { kind: 'photo', id: 'ph_1' } },
                { code: 'assets.size', record: { kind: 'photo', id: 'ph_2' } },
                { code: 'assets.variant', record: { kind: 'photo', id: 'ph_1' } },
                { code: 'privacy.path', record: { kind: 'photo', id: 'ph_3' } },
                { code: 'refs.featured', record: { kind: 'site', id: 'site' } },
            ],
            (id) => ({ ph_1: 'Tide gauge', ph_2: 'Ferry steps' })[id] ?? id,
        );
        expect(reasons).toEqual(['2 of its photographs no longer have their image files: Tide gauge, Ferry steps', 'a description in it names a file on this computer', "today's checks refuse it (refs.featured)"]);
        expect(blockedText(reasons)).toBe("It can't come back as it was: 2 of its photographs no longer have their image files: Tide gauge, Ferry steps, and 2 more problems.");
    });
});

describe('the impact list', () => {
    const names = { seriesName: (id: string) => ({ ser_h: 'Harbor Nights', ser_s: 'Salt Roads' })[id] ?? id, photoName: (id: string) => `Photo ${id.slice(3)}` };

    it('lists removals, then what comes back, then changes, with the featured series and the Work order apart', () => {
        const { lines, note } = impactLines({
            impact: changes({ photos: { added: ['ph_t'], removed: ['ph_n', 'ph_w'], changed: [] }, series: { added: [], removed: [], changed: ['ser_h'] }, site: true }),
            activeProblem: false,
            target: 5,
            active: 6,
            ...names,
            featuredChanged: true,
            orderChanged: false,
        });
        expect(note).toBeUndefined();
        expect(lines.map((line) => line.text)).toEqual(['Removes 2 photographs: Photo n, Photo w', 'Brings back 1 photograph: Photo t', 'Changes 1 series: Harbor Nights', "Changes Home's featured series."]);
    });

    it('puts names past 5 behind "and N more"', () => {
        const removed = ['ph_1', 'ph_2', 'ph_3', 'ph_4', 'ph_5', 'ph_6', 'ph_7', 'ph_8'];
        const { lines } = impactLines({ impact: changes({ photos: { added: [], removed, changed: [] } }), activeProblem: false, target: 2, active: 6, ...names, featuredChanged: false, orderChanged: true });
        expect(lines[0]).toEqual({ text: 'Removes 8 photographs: Photo 1, Photo 2, Photo 3, Photo 4, Photo 5', more: ['Photo 6', 'Photo 7', 'Photo 8'] });
        expect(lines[1]).toEqual({ text: 'Changes the order of series on Work.' });
    });

    it('lists everything the target publishes when the live revision can\'t be read, and says when nothing differs', () => {
        const unread = impactLines({ impact: changes({ series: { added: ['ser_h'], removed: [], changed: [] } }), activeProblem: true, target: 5, active: 6, ...names, featuredChanged: false, orderChanged: false });
        expect(unread.note).toBe("The live revision can't be read, so this lists everything revision 5 publishes.");
        expect(unread.lines).toEqual([{ text: 'Publishes 1 series: Harbor Nights' }]);
        const same = impactLines({ impact: changes(), activeProblem: false, target: 5, active: 6, ...names, featuredChanged: false, orderChanged: false });
        expect(same.lines).toEqual([{ text: "Its series and photographs are the same as revision 6's." }]);
    });

    it('names an editorial rule the restore accepts', () => {
        expect(editorialText([{ code: 'accent.contrast', record: { kind: 'series', id: 'ser_s' } }], ['accent.contrast'], names.seriesName)).toBe("Today's checks flag Salt Roads' accent color: it's hard to read on the Viewer's dark bands.");
        expect(editorialText([], [], names.seriesName)).toBeUndefined();
    });
});

describe("the dialog's answers", () => {
    const facts = (patch: Partial<OutcomeFacts> = {}): OutcomeFacts => ({ target: 5, active: 6, activeRevisionId: rev(6), pointer: { revisionId: rev(6), number: 6 }, targetRevisionId: rev(5), liveBy: null, holderSince: null, reasons: [], settled: false, ...patch });

    it('changed under you: says who made the new one live, keeps the impact as what it would have changed, and offers one way on', () => {
        const result = local(restoreResult('ACTIVE_CHANGED', facts({ pointer: { revisionId: rev(7), number: 7 }, liveBy: { actor: 'keyur', kind: 'publish', at: '2026-10-27T09:10:00.000Z' } })));
        expect(result).toEqual({ tone: 'change', heading: 'Revision 7 went live while this was open', body: ['keyur published it at 09:10, with photos publish. This page is out of date, so nothing was restored.'], actions: ['reload'], moved: { impact: 'past' } });
    });

    it('lock held: when it started, what stays live, and the retry', () => {
        expect(local(restoreResult('CATALOG_LOCKED', facts({ holderSince: '2026-10-27T09:10:00.000Z' })))).toEqual({
            tone: 'change',
            clock: true,
            heading: 'Another publish or restore is running',
            body: ['It started at 09:10. Nothing changed, and revision 6 stays live. Restore again once it finishes, usually within a minute.'],
            actions: ['cancel', 'retry'],
        });
    });

    it("lock held by a command that already moved the pointer: says what's live now and offers the reload, not the retry", () => {
        const result = local(restoreResult('CATALOG_LOCKED', facts({ pointer: { revisionId: rev(7), number: 7 }, liveBy: { actor: 'keyur', kind: 'publish', at: '2026-10-27T09:10:00.000Z' }, holderSince: '2026-10-27T09:10:00.000Z' })));
        expect(result).toEqual({
            tone: 'change',
            heading: 'Revision 7 went live while this was open',
            body: ['keyur published it at 09:10, with photos publish. Another command is still finishing, and nothing was restored. Load the updated page once it does.'],
            actions: ['reload'],
            moved: { impact: 'past' },
        });
    });

    it('refused by the checks: the reasons, and Load the updated page so the entry picks up its reason', () => {
        expect(local(restoreResult('VALIDATION_FAILED', facts({ reasons: ['2 of its photographs no longer have their image files: Tide gauge, Ferry steps'] })))).toEqual({
            tone: 'alert',
            heading: "Revision 5 can't come back",
            body: ["Today's checks refuse it, so nothing was restored. Revision 6 stays live."],
            list: ['2 of its photographs no longer have their image files: Tide gauge, Ferry steps.'],
            actions: ['close', 'reload'],
        });
        expect(local(restoreResult('NOT_ELIGIBLE', facts())).heading).toBe("Revision 5 never went live, so it can't come back");
        expect(local(restoreResult('NOTHING_ACTIVE', facts())).actions).toEqual(['reload']);
        expect(local(restoreResult('DATA_ROOT_NOT_READY', facts())).heading).toBe("The catalog folder isn't ready");
    });

    it('already live: moved facts, nothing more to do, and Load the updated page', () => {
        const result = local(restoreResult('NO_CHANGES', facts({ pointer: { revisionId: rev(5), number: 5 }, liveBy: { actor: 'curator:web', kind: 'rollback', at: '2026-10-27T09:11:00.000Z' }, settled: true })));
        expect(result).toEqual({ tone: 'done', heading: 'Revision 5 is already live', body: ['It was restored from this screen at 09:11. Nothing more to do.', 'History now records the restore that was interrupted.'], actions: ['reload'], moved: { impact: 'hide' } });
    });

    it('interrupted: before the switch, the retry; after it, Finish restoring', () => {
        expect(local(restoreResult('STORAGE_ERROR', facts()))).toEqual({ tone: 'alert', heading: 'The restore stopped before revision 5 went live', body: ['Revision 6 is still live, and visitors see no change. The server log names what failed. Restore again to retry.'], actions: ['cancel', 'retry'] });
        for (const outcome of ['STORAGE_ERROR', 'INTEGRITY_MISMATCH', 'LOCK_LOST'] as const) {
            expect(local(restoreResult(outcome, facts({ pointer: { revisionId: rev(5), number: 5 } })))).toEqual({ tone: 'alert', heading: "Revision 5 is live, but the restore didn't finish", body: ['Visitors see revision 5. Finish restoring it so History records it.'], actions: ['reload', 'finish'], moved: { impact: 'hide' } });
        }
    });
});

describe('the done notice', () => {
    const restore = row({ sequence: 8, revision: 5, kind: 'rollback', previous: 6, live: true, replaced: null });

    it('shows only for a committed restore that is live, with the conflict and the way to it', () => {
        expect(doneView(restore, 6, null, 0)).toEqual({ heading: 'Revision 5 is live again', body: ['Visitors see it on their next page load. Revision 6 is kept in History.'] });
        expect(doneView(restore, 6, { rowId: 'chg-1', record: 'Salt Roads' }, 1)).toEqual({
            heading: 'Revision 5 is live again',
            body: ['Visitors see it on their next page load. Revision 6 is kept in History.', '1 change in your draft clashes with revision 5.'],
            jump: { label: 'Go to the change: Salt Roads', target: 'chg-1-summary' },
        });
        // Two clashes: the link goes to the first; a rebase that waited says when the draft moves.
        expect(doneView(restore, 6, { rowId: 'chg-1', record: 'Salt Roads' }, 2, false)).toEqual({
            heading: 'Revision 5 is live again',
            body: ['Visitors see it on their next page load. Revision 6 is kept in History.', 'Your draft moves onto revision 5 at the next publish.', '2 changes in your draft clash with revision 5.'],
            jump: { label: 'Go to the first change: Salt Roads', target: 'chg-1-summary' },
        });
        expect(doneView({ ...restore, live: false }, 6, null, 0)).toBeUndefined();
        expect(doneView(row({ sequence: 8, revision: 5, live: true }), 4, null, 0)).toBeUndefined();
        expect(doneView(undefined, null, null, 0)).toBeUndefined();
    });
});
