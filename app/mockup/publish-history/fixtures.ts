import type { Ledger, PublishState, RevisionFacts, ScreenView } from '@/lib/curation/publish-facts';
import type { DialogState, Entry, HistoryModel, Plan, Result } from './model';

/**
 * The 15-4 mockup's states (spec, States and Every result), one per
 * `?state=` name. Fixture data only: generated images, made-up times, and
 * revision IDs built from their short hashes. Not for merge.
 */

const SITE = '/mockup/publish-history/site';

const rev = (number: number, hash: string): RevisionFacts => ({ revisionId: `rev_${hash}${'0'.repeat(56)}`, number, hash });

const R = {
    1: rev(1, 'e8f4a019'),
    2: rev(2, '5d21c8aa'),
    3: rev(3, '0b6e2f94'),
    4: rev(4, '77c0e5a1'),
    5: rev(5, '9a1b33c0'),
    6: rev(6, '3fa1c2d9'),
    7: rev(7, 'c41d09e2'),
} as const;

const EMPTY_LEDGER: Ledger = { authored: [], derived: [], health: [] };

/** Nothing to publish: the working catalog matches the live revision. */
function nothingView(active: RevisionFacts, previous: RevisionFacts | null): ScreenView {
    return {
        draftId: active.revisionId,
        draftNumber: active.number,
        draftHash: active.hash,
        active,
        previous,
        kind: 'nothing',
        ledger: EMPTY_LEDGER,
        blockers: [],
        panel: { count: 'Low Tide Hours: 6 photographs', copyLine: 'What visitors see now.', draftSrc: null, liveSrc: SITE },
    };
}

/** A draft is pending: revision 7 against the live one, two reviewed changes and a recount. */
function draftView(active: RevisionFacts, conflict = false): ScreenView {
    const ledger: Ledger = {
        authored: [
            {
                id: 'chg-0000000000000001',
                kind: 'New',
                review: 'reviewed',
                summary: 'Add Breakwater, first light to Low Tide Hours after photograph 04',
                blocks: false,
                compare: { type: 'text', before: null, after: 'Six wooden posts stand in calm water at sunrise, the sun low over a flat horizon.' },
            },
            {
                id: 'chg-0000000000000002',
                kind: 'Changed',
                review: conflict ? 'conflict' : 'reviewed',
                summary: 'Low Tide Hours: the short statement changes',
                ...(conflict ? { detail: `Your draft and revision ${active.number} both changed it.` } : {}),
                blocks: conflict,
                compare: { type: 'text', before: 'Five mornings on the estuary before the water comes back.', after: 'Six mornings on the estuary before the water comes back.' },
                ...(conflict ? { fix: { type: 'hint' as const, text: 'Keep one statement with photos edit, which clears the conflict, then validate again.' } } : {}),
            },
        ],
        derived: [{ id: 'chg-0000000000000003', kind: 'Recalculated', review: 'automatic', summary: 'Low Tide Hours: 7 photographs, was 6', blocks: false }],
        health: [],
    };
    return {
        draftId: R[7].revisionId,
        draftNumber: 7,
        draftHash: R[7].hash,
        active,
        previous: null,
        kind: 'ledger',
        ledger,
        blockers: conflict
            ? [{ key: 'b1', rowId: 'chg-0000000000000002', record: 'Low Tide Hours', field: 'statement', message: 'This field changed both here and in the active revision, in different ways.', link: { type: 'row', record: 'Low Tide Hours' } }]
            : [],
        panel: { count: 'Low Tide Hours: 7 photographs, was 6', copyLine: 'Draft revision 7, not public.', draftSrc: SITE, liveSrc: SITE },
    };
}

// The entries. Newest first, by sequence.

const LIVE_TEXT = "This is what visitors see, so there's nothing to restore.";

const E = {
    restored5: {
        sequence: 8,
        title: 'Revision 5',
        badge: { text: 'Live now', tone: 'done' },
        kind: 'Restore',
        when: 'Restored 27 October at 09:12, from this screen.',
        reason: { text: 'The new Harbor Nights cover is cropped wrong on phones.', quoted: true },
        from: 'Replaced revision 6: removed 2 photographs, brought back 1, changed 1 series.',
        held: '3 series, 25 photographs in all.',
        facts: 'Entry 8 · 9a1b33c0',
        eligibility: { type: 'text', text: LIVE_TEXT, tone: 'quiet' },
    },
    rev6Live: {
        sequence: 7,
        title: 'Revision 6',
        badge: { text: 'Live now', tone: 'done' },
        kind: 'Publish',
        when: 'Published 26 October at 14:05, from this screen.',
        from: 'Replaced revision 5: 2 photographs added, 1 removed, 1 series changed.',
        held: '3 series, 26 photographs in all.',
        facts: 'Entry 7 · 3fa1c2d9',
        eligibility: { type: 'text', text: LIVE_TEXT, tone: 'quiet' },
    },
    rev5: {
        sequence: 6,
        title: 'Revision 5',
        kind: 'Publish',
        when: 'Published 25 October at 18:40, from this screen.',
        from: 'Replaced revision 4: 1 series added, 7 photographs added.',
        held: '3 series, 25 photographs in all.',
        facts: 'Entry 6 · 9a1b33c0',
        eligibility: { type: 'restore', revision: 5 },
    },
    rev4Blocked: {
        sequence: 5,
        title: 'Revision 4',
        kind: 'Publish',
        when: 'Published 14 October at 10:22 by keyur, with photos publish.',
        reason: { text: 'Salt Roads order after the print review', quoted: false },
        from: "Replaced revision 3: Home's featured series changed.",
        held: '2 series, 18 photographs in all.',
        facts: 'Entry 5 · 77c0e5a1',
        eligibility: { type: 'text', text: "It can't come back as it was: a description in it names a file on this computer.", tone: 'alert' },
    },
    rev3Unreadable: {
        sequence: 4,
        title: 'Revision 3',
        kind: 'Publish',
        when: 'Published 2 October at 14:11 by keyur, with photos publish.',
        from: 'Replaced revision 2.',
        facts: 'Entry 4 · 0b6e2f94',
        eligibility: { type: 'text', text: "Its saved copy can't be read, so it can't come back. The server log names what failed.", tone: 'alert' },
    },
    interrupted: {
        sequence: 3,
        title: "A publish that didn't finish",
        badge: { text: "Didn't finish", tone: 'quiet' },
        kind: 'Publish',
        when: 'Started 2 October at 13:58 by keyur, with photos publish.',
        from: 'It never went live, so visitors never saw it.',
        facts: 'Entry 3',
        eligibility: { type: 'none' },
    },
    rev2: {
        sequence: 2,
        title: 'Revision 2',
        kind: 'Publish',
        when: 'Published 20 September at 09:03, from this screen.',
        from: 'Replaced revision 1: 4 photographs added.',
        held: '2 series, 18 photographs in all.',
        facts: 'Entry 2 · 5d21c8aa',
        eligibility: { type: 'restore', revision: 2 },
    },
    rev1: {
        sequence: 1,
        title: 'Revision 1',
        kind: 'Publish',
        when: 'Published 3 September at 20:15 by keyur, with photos publish.',
        reason: { text: 'Launch', quoted: false },
        from: 'The first revision.',
        held: '2 series, 14 photographs in all.',
        facts: 'Entry 1 · e8f4a019',
        eligibility: { type: 'restore', revision: 1 },
    },
} satisfies Record<string, Entry>;

const LIST: Entry[] = [E.rev6Live, E.rev5, E.rev4Blocked, E.rev3Unreadable, E.interrupted, E.rev2, E.rev1];

// After restoring revision 5: a new entry at the top, revision 6 can come back, and entry 6 points at entry 8.
const AFTER: Entry[] = [
    E.restored5,
    { ...E.rev6Live, badge: undefined, eligibility: { type: 'restore', revision: 6 } },
    { ...E.rev5, eligibility: { type: 'text', text: 'Live now: restored on 27 October, above.', tone: 'quiet' } },
    E.rev4Blocked,
    E.rev3Unreadable,
    E.interrupted,
    E.rev2,
    E.rev1,
];

const LEAD = 'Every publish and restore, newest first. Restoring one makes it live again as a new entry. Nothing is deleted.';

// After Publish revision 7 from this screen: the answer carries History read again (spec, History by 16-3 state).
const AFTER_PUBLISH: Entry[] = [
    {
        sequence: 8,
        title: 'Revision 7',
        badge: { text: 'Live now', tone: 'done' },
        kind: 'Publish',
        when: 'Published 27 October at 10:02, from this screen.',
        from: 'Replaced revision 6: 1 photograph added, 1 series changed.',
        held: '3 series, 27 photographs in all.',
        facts: 'Entry 8 · c41d09e2',
        eligibility: { type: 'text', text: LIVE_TEXT, tone: 'quiet' },
    },
    { ...E.rev6Live, badge: undefined, eligibility: { type: 'restore', revision: 6 } },
    E.rev5,
    E.rev4Blocked,
    E.rev3Unreadable,
    E.interrupted,
    E.rev2,
    E.rev1,
];

const PLAN_5: Plan = {
    revision: 5,
    hash: R[5].hash,
    active: 6,
    activeHash: R[6].hash,
    impact: [
        { text: 'Removes 2 photographs: Night ferry, Harbor wall at dusk' },
        { text: 'Brings back 1 photograph: Tide gauge' },
        { text: 'Changes 1 series: Harbor Nights' },
        { text: "Changes Home's featured series." },
    ],
};

const PLANS: Record<number, Plan> = {
    5: PLAN_5,
    2: {
        revision: 2,
        hash: R[2].hash,
        active: 6,
        activeHash: R[6].hash,
        impact: [
            { text: 'Removes 1 series: Harbor Nights' },
            { text: 'Removes 8 photographs: Night ferry, Harbor wall at dusk, Pier lamps at night, Ferry steps, Lamp post', more: ['Quay at dusk', 'Harbor lights', 'Tide gauge'] },
            { text: 'Changes 1 series: Salt Roads' },
            { text: "Changes Home's featured series." },
            { text: 'Changes the order of series on Work.' },
        ],
        editorial: "Today's checks flag Salt Roads' accent color: it's hard to read on the Viewer's dark bands.",
    },
    1: {
        revision: 1,
        hash: R[1].hash,
        active: 6,
        activeHash: R[6].hash,
        impact: [
            { text: 'Removes 1 series: Harbor Nights' },
            { text: 'Removes 12 photographs: Night ferry, Harbor wall at dusk, Pier lamps at night, Ferry steps, Lamp post', more: ['Quay at dusk', 'Harbor lights', 'Tide gauge', 'Coast road', 'Dune fence', 'Salt pans', 'Slipway'] },
            { text: 'Changes 2 series: Low Tide Hours, Salt Roads' },
            { text: "Changes Home's featured series." },
        ],
    },
};

const DRAFT_NOTE = 'Your draft stays, and this screen then compares it against revision 5. If a change in it clashes with revision 5, Publish stays locked until you settle that change.';
const REASON = 'The new Harbor Nights cover is cropped wrong on phones.';

const history = (extra: Partial<HistoryModel> = {}): HistoryModel => ({ lead: LEAD, entries: LIST, plans: PLANS, ...extra });

const dialog = (phase: DialogState['phase'], result?: Result, plan: Plan = PLAN_5, reason = REASON): DialogState => ({ plan, opener: plan.revision === 5 ? 6 : plan.revision, phase, reason, ...(result ? { result } : {}) });

// Long history: entries 48 to 39, publishes from this screen every few days, with one restore among them.
const LONG: Entry[] = Array.from({ length: 10 }, (_, index) => {
    const sequence = 48 - index;
    const number = sequence - 7;
    const day = 27 - index * 2;
    const hash = ((sequence * 2654435761) >>> 0).toString(16).padStart(8, '0').slice(0, 8);
    const live = index === 0;
    const restore = index === 3;
    return {
        sequence,
        title: `Revision ${restore ? number - 12 : number}`,
        ...(live ? { badge: { text: 'Live now', tone: 'done' as const } } : {}),
        kind: restore ? ('Restore' as const) : ('Publish' as const),
        when: `${restore ? 'Restored' : 'Published'} ${day} October at ${String(9 + (index % 8)).padStart(2, '0')}:${String((index * 7) % 60).padStart(2, '0')}, from this screen.`,
        ...(restore ? { reason: { text: 'Put the old Salt Roads order back for the show.', quoted: true } } : {}),
        from: restore
            ? `Replaced revision ${number - 1}: removed 3 photographs, changed the order of series on Work.`
            : `Replaced revision ${number - 1}: ${index % 3 === 0 ? '1 photograph added' : index % 3 === 1 ? '2 photographs changed' : '1 series changed'}.`,
        held: `4 series, ${40 - index} photographs in all.`,
        facts: `Entry ${sequence} · ${hash}`,
        eligibility: live ? { type: 'text' as const, text: LIVE_TEXT, tone: 'quiet' as const } : { type: 'restore' as const, revision: restore ? number - 12 : number },
    };
});

export interface MockState {
    screen: 'ready' | 'not-launched' | 'unreadable';
    view?: ScreenView;
    history?: HistoryModel;
    /** A state after one of 16-3's own answers. */
    answer?: PublishState;
}

const ready = (view: ScreenView, model: HistoryModel): MockState => ({ screen: 'ready', view, history: model });

const LIST_VIEW = nothingView(R[6], R[5]);

export const STATES: Record<string, MockState> = {
    // The section on its own, nothing pending.
    list: ready(LIST_VIEW, history()),
    // A draft is pending: History sits under the ledger, below the bar.
    'with-draft': ready(draftView(R[6]), history()),
    single: ready(nothingView(R[1], null), {
        lead: 'Revision 1 is the first, and the only one so far. Each publish adds an entry here, and any earlier one can be restored.',
        entries: [{ ...E.rev1, badge: { text: 'Live now', tone: 'done' }, eligibility: { type: 'text', text: LIVE_TEXT, tone: 'quiet' } }],
        plans: {},
    }),
    long: ready(nothingView(rev(41, LONG[0].facts.slice(-8)), rev(40, LONG[1].facts.slice(-8))), {
        lead: LEAD,
        entries: LONG,
        total: 48,
        more: { label: 'Show 10 older entries', href: '/mockup/publish-history?state=long#entry-38-title' },
        plans: {},
    }),
    empty: { screen: 'not-launched' },
    unreadable: { screen: 'unreadable' },
    // The dialog, then every answer to it.
    dialog: ready(LIST_VIEW, history({ dialog: dialog('review', undefined, PLAN_5, '') })),
    'dialog-editorial': ready(LIST_VIEW, history({ dialog: { ...dialog('review', undefined, PLANS[2], ''), opener: 2 } })),
    'dialog-draft': ready(draftView(R[6]), history({ dialog: dialog('review', undefined, { ...PLAN_5, draftNote: DRAFT_NOTE }, '') })),
    'reason-missing': ready(LIST_VIEW, history({ dialog: dialog('reason-missing', undefined, PLAN_5, '') })),
    restoring: ready(LIST_VIEW, history({ dialog: dialog('pending') })),
    done: ready(nothingView(R[5], R[6]), {
        lead: LEAD,
        entries: AFTER,
        plans: { 6: { ...PLAN_5, revision: 6, hash: R[6].hash, active: 5, activeHash: R[5].hash } },
        done: { heading: 'Revision 5 is live again', body: ['Visitors see it on their next page load. Revision 6 is kept in History.'] },
    }),
    'done-draft': ready(draftView(R[5], true), {
        lead: LEAD,
        entries: AFTER,
        plans: {},
        done: {
            heading: 'Revision 5 is live again',
            body: ['Visitors see it on their next page load. Revision 6 is kept in History.', '1 change in your draft clashes with revision 5.'],
            jump: { label: 'Go to the change: Low Tide Hours', target: 'chg-0000000000000002-summary' },
        },
    }),
    changed: ready(
        LIST_VIEW,
        history({
            dialog: dialog('result', {
                tone: 'change',
                heading: 'Revision 7 went live while this was open',
                body: ['keyur published it at 09:10, with photos publish. The list above is out of date, so nothing was restored.'],
                actions: ['close-reload', 'reload'],
                moved: { impact: 'past' },
            }),
        }),
    ),
    locked: ready(
        LIST_VIEW,
        history({
            dialog: dialog('result', { tone: 'change', clock: true, heading: 'Another publish or restore is running', body: ['It started at 09:10. Nothing changed, and revision 6 stays live. Restore again once it finishes, usually within a minute.'], actions: ['cancel', 'retry'] }),
        }),
    ),
    refused: ready(
        LIST_VIEW,
        history({
            dialog: dialog('result', {
                tone: 'alert',
                heading: "Revision 5 can't come back",
                body: ["Today's checks refuse it, so nothing was restored. Revision 6 stays live."],
                list: ['2 of its photographs no longer have their image files: Tide gauge, Ferry steps.'],
                actions: ['close', 'reload'],
            }),
        }),
    ),
    'already-live': ready(
        LIST_VIEW,
        history({ dialog: dialog('result', { tone: 'done', heading: 'Revision 5 is already live', body: ['It went live at 09:11, from this screen. Nothing more to do.'], actions: ['close-reload'], moved: { impact: 'hide' } }) }),
    ),
    interrupted: ready(
        LIST_VIEW,
        history({
            dialog: dialog('result', {
                tone: 'alert',
                heading: 'The restore stopped before revision 5 went live',
                body: ['Revision 6 is still live, and visitors see no change. The server log names what failed. Restore again to retry.'],
                actions: ['cancel', 'retry'],
            }),
        }),
    ),
    'interrupted-live': ready(
        LIST_VIEW,
        history({
            dialog: dialog('result', { tone: 'alert', heading: "Revision 5 is live, but the restore didn't finish", body: ['Visitors see revision 5. Finish restoring it so History records it.'], actions: ['close-reload', 'finish'], moved: { impact: 'hide' } }),
        }),
    ),
    // Published from this screen (16-3's answer in place): History comes back with the answer, revision 7 marked live, no Restore on it.
    'after-publish': {
        ...ready(draftView(R[6]), history({ afterAnswer: { lead: LEAD, entries: AFTER_PUBLISH, plans: { 6: { ...PLAN_5, revision: 6, hash: R[6].hash, active: 7, activeHash: R[7].hash } } } })),
        answer: { serial: 1, intent: 'publish', answer: { kind: 'published', live: R[7], previous: R[6] }, result: { kind: 'published', live: R[7], previous: R[6] } },
    },
};

export const STATE_ORDER = Object.keys(STATES);
