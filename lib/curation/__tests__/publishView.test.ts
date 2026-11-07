import { describe, expect, it } from 'vitest';
import type { CatalogChange, CatalogDiff } from '../../catalog/diff';
import type { FieldReviewReason, FieldReviewState, ReviewContext } from '../../catalog/review';
import type { CandidateContent, Issue, RevisionContent, WorkingLayer } from '../../catalog/types';
import { actorPhrase, countLine, displayFacts, orderRuns, resultCopy, rollbackStakes, rollbackWarning, timeOf, type Ledger, type PublishWarning, type ScreenView } from '../publish-facts';
import { localize } from '../publish-history';
import { buildLedger } from '../publish-view';

// #16's Publish screen (16-3): the join over 16-1's reason list, and the
// facts each state shows, on hand-made inputs. The real data roots are in
// app/curation/publish/__tests__/publish.test.ts. Test values only.

const PHOTO = 'ph_00000000-0000-4000-8000-000000000001';
const SERIES = 'ser_view-test';
const REV = (n: number) => `rev_${String(n).repeat(64).slice(0, 64)}`;

const content: RevisionContent = {
    site: { featuredSeriesIds: [SERIES] },
    series: [{ id: SERIES, slug: 'view-test', slugAliases: [], title: 'View test', statement: 'S', shortStatement: 'S', photoIds: [PHOTO], chapters: [], cover: { photoId: PHOTO }, derived: { photoCount: 1 } }],
    photos: [],
};
const layer = {
    site: { kind: 'site', featuredSeriesIds: [SERIES], seriesOrder: [SERIES], version: 1 },
    // A real record always has `cover` (the schema's default is null), which the review reads.
    series: [{ kind: 'series', id: SERIES, title: 'View test', version: 3, photoIds: [PHOTO], statement: 'S', cover: null }],
    photos: [{ kind: 'photo', id: PHOTO, title: 'Pier lamps', version: 2, alt: { kind: 'described', text: 'Words', reviewed: false } }],
} as unknown as WorkingLayer;
const review: ReviewContext = { bases: new Map(), inbox: new Map(), unreadable: new Set() };

function change(reason: FieldReviewReason, overrides: Partial<CatalogChange> = {}): CatalogChange {
    const entry: FieldReviewState =
        reason === 'generated'
            ? { record: { kind: 'photo', id: PHOTO }, field: 'alt', state: 'unreviewed', reason, at: '2026-10-25T08:30:00.000Z' }
            : { record: { kind: 'series', id: SERIES }, field: 'statement', state: reason.startsWith('item') || reason === 'newer-item' || ['active-moved', 'base-unreadable', 'asset-replaced', 'cover-replaced', 'inbox-unread'].includes(reason) ? 'stale' : 'unreviewed', reason, ...(reason.startsWith('item') || reason === 'newer-item' ? { eventId: 'evt_0123456789abcdef01234567' } : {}) };
    return {
        id: `0000${reason.length.toString(16).padStart(12, '0')}`,
        record: entry.record,
        field: entry.field,
        category: 'authored',
        before: 'Was',
        after: 'Now',
        visible: true,
        surfaces: ['series'],
        provenance: reason === 'generated' ? 'generated' : 'authored',
        review: { state: entry.state, fields: [entry] },
        stale: entry.state === 'stale',
        summary: 'raw',
        ...overrides,
    };
}

const ledgerFor = (changes: CatalogChange[], issues: Parameters<typeof buildLedger>[0]['issues'] = null, diagnostics: readonly Issue[] | null = null) => {
    const diff: CatalogDiff = { activeRevisionId: REV(2), empty: false, changes };
    return buildLedger({ diff, layer, active: content, candidate: content as CandidateContent, registry: null, review, activations: [], issues, diagnostics, media: { draft: (url) => `/draft${url}`, live: (url) => url } });
};

describe('the join, over 16-1 reasons', () => {
    const cases: [FieldReviewReason, string][] = [
        ['generated', 'description'],
        ['active-moved', 'restamp'],
        ['base-unreadable', 'restamp'],
        ['asset-replaced', 'restamp'],
        ['cover-replaced', 'restamp'],
        ['edited', 'restamp'],
        ['no-stamp', 'restamp'],
        ['item-reopened', 'inbox'],
        ['newer-item', 'inbox'],
        ['item-unreadable', 'inbox'],
        ['no-record', 'hint'],
        ['backfill-unreadable', 'hint'],
        ['inbox-unread', 'hint'],
    ];
    it.each(cases)('gives a %s row the %s fix, marks exactly that row, and lists one blocker for it', (reason, fix) => {
        const { ledger, blockers } = ledgerFor([change(reason)]);
        const rows = [...ledger.authored, ...ledger.derived];
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ blocks: true, fix: { type: fix } });
        expect(blockers.map((blocker) => blocker.rowId)).toEqual([rows[0].id]);
        const link = blockers[0].link.type;
        expect(link).toBe({ description: 'description', restamp: 'restamp', inbox: 'inbox', hint: 'row' }[fix]);
    });

    it('marks the row a diagnostic names after Validate, and lists a diagnostic with no row on its own, with no link', () => {
        const generated = change('generated');
        const { ledger, blockers } = ledgerFor([generated, change('edited', { review: { state: 'reviewed', fields: [{ record: { kind: 'series', id: SERIES }, field: 'statement', state: 'reviewed' }] }, provenance: 'authored' })], [
            { code: 'description.required', severity: 'error', record: { kind: 'photo', id: PHOTO }, field: 'alt', message: 'Nobody has reviewed this suggested description yet.' },
            { code: 'order.unknown-photo', severity: 'error', record: { kind: 'series', id: 'ser_elsewhere' }, field: 'photoIds', message: 'An unknown photo.', hint: 'Remove it.' },
            { code: 'review.empty-diff', severity: 'warning', record: { kind: 'site', id: 'site' }, field: '', message: 'Only a warning.' },
        ]);
        const rows = [...ledger.authored, ...ledger.derived];
        expect(rows.filter((row) => row.blocks).map((row) => row.summary)).toEqual(['Pier lamps: the description changes']);
        expect(blockers).toHaveLength(2);
        expect(blockers[1]).toMatchObject({ rowId: null, record: 'ser_elsewhere', link: { type: 'none' }, message: 'An unknown photo. Remove it.' });
    });

    it('never blocks a reviewed row, and lists source health apart, as no change', () => {
        const reviewed = change('edited', { review: { state: 'reviewed', fields: [{ record: { kind: 'series', id: SERIES }, field: 'statement', state: 'reviewed', by: 'curator:web', at: '2026-10-26T14:05:00.000Z' }] } });
        const missing = change('edited', { id: 'aaaaaaaaaaaaaaaa', category: 'missing', field: 'source', record: { kind: 'photo', id: PHOTO }, visible: false, provenance: 'derived', review: { state: 'not-required', fields: [] } });
        const { ledger, blockers } = ledgerFor([reviewed, missing]);
        expect(blockers).toEqual([]);
        expect(localize(ledger.authored[0].detail ?? '')).toBe('Reviewed from this screen on 26 October.');
        // The day is named where it's rendered, in the owner's zone, as History's are (15-4 build design review P2-2).
        const late = change('edited', { review: { state: 'reviewed', fields: [{ record: { kind: 'series', id: SERIES }, field: 'statement', state: 'reviewed', by: 'curator:web', at: '2026-10-28T00:27:00.000Z' }] } });
        const lateRow = ledgerFor([late]).ledger.authored[0];
        expect(localize(lateRow.detail ?? '', 'America/Los_Angeles')).toBe('Reviewed from this screen on 27 October.');
        expect(localize(lateRow.detail ?? '')).toBe('Reviewed from this screen on 28 October.');
        expect(ledger.authored[0]).toMatchObject({ review: 'reviewed', blocks: false });
        expect(ledger.health[0]).toMatchObject({ kind: 'Source health', summary: 'Pier lamps: source missing; last published image kept' });
    });
});

const empty: Ledger = { authored: [], derived: [], health: [] };
const row = (blocks = false) => ({ id: 'chg-0000000000000001', kind: 'Changed' as const, review: 'reviewed' as const, summary: 's', blocks });
const view = (overrides: Partial<ScreenView> = {}): ScreenView => ({
    draftId: REV(3),
    draftNumber: 19,
    draftHash: '33333333',
    active: { revisionId: REV(2), number: 18, hash: '22222222' },
    previous: { revisionId: REV(1), number: 17, hash: '11111111' },
    kind: 'ledger',
    ledger: { authored: [row(true), row()], derived: [row()], health: [row()] },
    blockers: [],
    panel: { count: 'Low Tide Hours: 6 photographs, was 5', copyLine: 'The short statement changes.', draftSrc: '/curation/preview/x/site/work/a/photo/b', liveSrc: '/work/a/photo/b' },
    rollbackReady: { state: 'live-ok' },
    ...overrides,
});
const live19 = { revisionId: REV(3), number: 19, hash: '33333333' };
const was18 = { revisionId: REV(2), number: 18, hash: '22222222' };

describe('facts by state', () => {
    it('counts in the owner’s words, with the singular forms, and leaves the blocking sentence out at none', () => {
        expect(countLine({ authored: [row()], derived: [], health: [row()] }, 1)).toBe('1 change for visitors: 1 authored, 0 derived. 1 blocks publishing.');
        expect(countLine({ authored: [row(), row()], derived: [row()], health: [] }, 0)).toBe('3 changes for visitors: 2 authored, 1 derived.');
        expect(countLine(empty, 0, true)).toBe('0 changes went live: 0 authored, 0 derived.');
    });

    it('names a pending draft as the approved mockup does', () => {
        const facts = displayFacts(view(), null, '/curation/preview/x');
        expect(facts).toMatchObject({
            mode: 'draft',
            heading: 'Preview catalog revision 19',
            countLine: '3 changes for visitors: 2 authored, 1 derived. 1 blocks publishing.',
            revision: { current: 'Current public revision 18', hashes: 'Draft 33333333 · Live 22222222' },
            groups: { authored: 'Authored · requires judgment', derived: 'Derived · recalculated automatically' },
            compareLabels: { before: 'Published', after: 'This draft' },
            panel: { title: 'Visitor preview', link: { label: 'Open full preview' }, marker: 'Preview · not public', rollback: 'Last-known-good revision 18 remains rollback-ready.' },
            bar: { validate: 'available', publish: 'unavailable', reason: '1 change blocks publishing. Fix it, then validate.' },
        });
    });

    it("says the publish didn't finish on the first screen when the pointer moved, and keeps Publish as the way to finish", () => {
        const facts = displayFacts(view(), { kind: 'failed', heading: "Revision 19 is live, but the publish didn't finish", body: 'b', live: live19, previous: was18, retry: 'publish' }, null);
        expect(facts).toMatchObject({
            mode: 'live',
            heading: 'Revision 19 is live',
            countLine: "The publish didn't finish. Publish again to finish it.",
            countAlert: true,
            bar: { validate: 'hidden', publish: 'available', reason: 'Visitors already see revision 19. Publishing again finishes the switch.' },
            panel: { marker: 'Live, revision 19', rollback: 'Revision 18 is kept. Restore it from History, below.' },
            // Publish is the way to finish, so it goes with the validation it ran on, and the server doesn't refuse it.
            validated: true,
        });
    });

    it('drops the draft facts from the panel and keeps one action when the ledger is out of date', () => {
        const facts = displayFacts(view(), { kind: 'someone-published', live: live19, previous: was18, by: { actor: 'keyur', kind: 'publish', at: '2026-10-27T14:05:00.000Z' } }, null);
        expect(facts.panel).toEqual(expect.objectContaining({ frameSrc: null, link: null, rollback: 'Revision 18 is kept. Restore it from History, below.' }));
        expect(facts.panel.count).toBeUndefined();
        expect(facts.panel.copyLine).toBeUndefined();
        expect(facts.bar).toEqual({ validate: 'hidden', publish: 'hidden', loadUpdated: true });
    });

    it('clears every badge once Validate passes, whatever the page predicted', () => {
        const facts = displayFacts(view(), { kind: 'valid', stakes: 'x' }, null);
        expect([...facts.ledger.authored, ...facts.ledger.derived].some((entry) => entry.blocks)).toBe(false);
        expect(facts.countLine).toBe('3 changes for visitors: 2 authored, 1 derived.');
        expect(facts.bar).toMatchObject({ publish: 'available' });
        expect(facts.bar?.reason).toBeUndefined();
    });

    it('keeps the approved result lines word for word', () => {
        expect(resultCopy({ kind: 'valid', stakes: 'x' }, view())).toEqual({ tone: 'done', heading: 'Catalog revision is valid', body: ['All references resolve. The previous public revision remains live.', 'x'] });
        expect(resultCopy({ kind: 'published', live: live19, previous: was18 }, view())).toEqual({ tone: 'done', heading: 'Revision 19 is live', body: ['Visitors get it on their next page load.'] });
    });

    it('opens the order windows one either side of both ends, merging windows that touch', () => {
        expect(orderRuns({ before: Array(8).fill('x'), after: Array(8).fill('x'), from: 7, to: 2 })).toEqual([[1, 2, 3], [6, 7, 8]]);
        expect(orderRuns({ before: ['a', 'b'], after: ['b', 'a'], from: 2, to: 1 })).toEqual([[1, 2]]);
        expect(orderRuns({ before: Array(5).fill('x'), after: Array(5).fill('x'), from: 4, to: 2 })).toEqual([[1, 2, 3, 4, 5]]);
    });

    it('says what made a revision live: the command line, this screen in another tab, or a rollback', () => {
        const at = '2026-10-27T14:05:00.000Z';
        expect(resultCopy({ kind: 'someone-published', live: live19, previous: was18, by: { actor: 'keyur', kind: 'publish', at } }, view())).toEqual({
            tone: 'change',
            heading: 'Revision 19 went live from the command line',
            body: ['You published it from the command line at 14:05. Nothing was published from here.'],
        });
        expect(resultCopy({ kind: 'someone-published', live: live19, previous: was18, by: { actor: 'curator:web', kind: 'publish', at } }, view())).toEqual({
            tone: 'change',
            heading: 'Revision 19 went live from another page',
            body: ['You published it from this screen at 14:05, in another tab or window. Nothing was published from here.'],
        });
        const back = { number: 17, revisionId: REV(7), hash: '77777777' };
        expect(resultCopy({ kind: 'someone-published', live: back, previous: was18, by: { actor: 'keyur', kind: 'rollback', at } }, view())).toEqual({
            tone: 'change',
            heading: 'Revision 17 is live again',
            body: ['You restored it from the command line at 14:05. Nothing was published from here.'],
        });
        expect(resultCopy({ kind: 'already-live', live: live19, previous: was18, by: { actor: 'curator:web', kind: 'publish', at } }, view())?.body).toEqual(['You published it from this screen at 14:05. Nothing more to publish, and nothing new was written.']);
    });

    it('names the lock that is held, and says the times in the zone it is given', () => {
        const at = '2026-10-27T14:05:00.000Z';
        expect(resultCopy({ kind: 'busy', lock: 'catalog', since: at, retry: 'publish' }, view())).toEqual({ tone: 'change', heading: 'Another publish or restore is running', body: ['It started at 14:05. Nothing changed here. Publish again when it finishes.'] });
        expect(resultCopy({ kind: 'busy', lock: 'authored', since: null, retry: 'validate' }, view())).toEqual({ tone: 'change', heading: 'Another change to the working catalog is being saved', body: ['Nothing changed here. Validate again when it finishes.'] });
        expect(timeOf(at, 'America/Los_Angeles')).toBe('07:05');
        expect(resultCopy({ kind: 'busy', lock: 'catalog', since: at, retry: 'publish' }, view(), 'Asia/Kolkata')?.body).toEqual(['It started at 19:35. Nothing changed here. Publish again when it finishes.']);
    });

    it('says No visitor-visible changes for a candidate visitors would see no difference in, with no bar', () => {
        const facts = displayFacts({ ...view(), kind: 'no-visible-change' }, null, null);
        expect(facts).toMatchObject({ mode: 'nothing', heading: 'Nothing to publish', lead: 'No visitor-visible changes. Edits to hidden or draft series stay saved and publish when the series becomes visible.', bar: null, showFixes: false });
    });

    // #117: the line shows while the live checks pass, verified or not, and a warning that names the fix takes its place on any evidence of a problem.
    it('shows the rollback-ready line while the live revision passes, verified or never checked', () => {
        for (const rollbackReady of [{ state: 'verified' }, { state: 'live-ok' }] as const) {
            const facts = displayFacts(view({ rollbackReady }), null, null);
            expect(facts.panel.rollback).toBe('Last-known-good revision 18 remains rollback-ready.');
            expect(facts.panel.rollbackTone).toBeUndefined();
            expect(rollbackStakes(18, rollbackReady)).toBe(' Revision 18 stays rollback-ready.');
        }
    });

    it('replaces the line with a warning that names the fix, on the draft and the out-of-date ledger, and in the Validate stakes', () => {
        const cases = [
            ['last-verify', "Revision 18 failed its last check, so it isn't rollback-ready. Run `photos verify` to see what to fix."],
            ['live-check', "Revision 18 fails the checks a restore runs, so it isn't rollback-ready. Run `photos verify` to see what to fix."],
            ['record-damaged', "Revision 18 isn't rollback-ready: the record of its last check can't be read. Run `photos verify` in the watcher's container to write it again."],
            ['chain', "Revision 18 isn't rollback-ready: the activation records don't show it going live. Run `photos verify` to check the active pointer, or restore a revision from History, below."],
        ] as const;
        for (const [reason, warning] of cases) {
            const screen = view({ rollbackReady: { state: 'failed', reason } });
            expect(displayFacts(screen, null, null).panel).toMatchObject({ rollback: warning, rollbackTone: 'alert' });
            expect(displayFacts(screen, { kind: 'changed', body: 'b' }, null).panel).toMatchObject({ rollback: warning, rollbackTone: 'alert' });
            expect(rollbackWarning(18, reason)).toBe(warning);
            expect(rollbackStakes(18, { state: 'failed', reason })).toBe(` ${warning}`);
        }
        expect(displayFacts(view({ rollbackReady: { state: 'failed', reason: 'last-verify' } }), null, null).panel.rollback).not.toContain('remains rollback-ready');
    });

    it("drops the line and the stakes clause when it can't tell, and keeps the restore line once nothing is pending", () => {
        const unknown = view({ rollbackReady: { state: 'unknown' } });
        expect(displayFacts(unknown, null, null).panel.rollback).toBeNull();
        expect(rollbackStakes(18, { state: 'unknown' })).toBe('');
        // Live and Nothing name the revision before the active one, which the gate doesn't cover.
        const failed = view({ rollbackReady: { state: 'failed', reason: 'last-verify' } });
        expect(displayFacts({ ...failed, kind: 'nothing' }, null, null).panel).toMatchObject({ rollback: 'Revision 17 is kept. Restore it from History, below.' });
        expect(displayFacts(failed, { kind: 'published', live: live19, previous: was18 }, null).panel.rollbackTone).toBeUndefined();
    });

    it('says who did a thing without a producer ID', () => {
        expect(actorPhrase('curator:web')).toBe('from this screen');
        expect(actorPhrase('keyur')).toBe('from the command line');
    });
});

describe('warnings, which never block a publish', () => {
    const issue = (code: string, severity: Issue['severity'], record: Issue['record'], field: string, message: string, hint?: string): Issue => ({ code, severity, record, field, message, ...(hint ? { hint } : {}) });
    // The three warning rules at once, in the words the rules give them and the CLI prints.
    const three: Issue[] = [
        issue('description.camera-tokens', 'warning', { kind: 'photo', id: PHOTO }, 'alt.text', 'The description mentions camera details.', 'Screen readers read the description aloud. The camera details are stored separately.'),
        issue('description.length', 'warning', { kind: 'photo', id: PHOTO }, 'alt.text', 'The description runs 301 characters, past 250.', 'Keep it to what the photograph shows.'),
        issue('series.duplicate-title', 'warning', { kind: 'series', id: SERIES }, 'title', 'The series view-test and view-other share this title, so Work shows 2 links with the same name.', 'Give each series its own title. This is a warning only; nothing is blocked.'),
    ];
    const listed = (warnings: readonly PublishWarning[]) => warnings.map(({ record, field, message, hint, link }) => ({ record, field, message, hint, link }));
    // A series is named with its slug, so two of one title can be told apart, and links to its page.
    const seriesLink = { type: 'series', href: `/curation/series/${SERIES}`, name: 'View test (view-test)' };
    const expected = [
        { record: 'Pier lamps', field: 'description', message: three[0].message, hint: three[0].hint, link: null },
        { record: 'Pier lamps', field: 'description', message: three[1].message, hint: three[1].hint, link: null },
        { record: 'View test (view-test)', field: 'title', message: three[2].message, hint: three[2].hint, link: seriesLink },
    ];
    const blocking = issue('description.required', 'error', { kind: 'series', id: SERIES }, 'statement', 'A published series needs a statement.');

    it("lists every warning in an answer's issues in the rule's own words, naming its record and linking a series to its page, apart from the blockers", () => {
        const { blockers, warnings } = ledgerFor([], three);
        expect(blockers).toEqual([]);
        expect(listed(warnings)).toEqual(expected);
        expect(new Set(warnings.map((warning) => warning.key)).size).toBe(3);
        // An error among them still blocks, and the warnings stay listed beside it.
        const mixed = ledgerFor([], [...three, blocking]);
        expect(mixed.blockers).toHaveLength(1);
        expect(listed(mixed.warnings)).toEqual(expected);
    });

    it("lists a page load's warnings from its own check of the draft, whose errors the review state predicts instead", () => {
        const { blockers, warnings } = ledgerFor([], null, [...three, blocking]);
        expect(blockers).toEqual([]);
        expect(listed(warnings)).toEqual(expected);
    });

    it('lists none when there are none, or no check has run', () => {
        expect(ledgerFor([], []).warnings).toEqual([]);
        expect(ledgerFor([], null, null).warnings).toEqual([]);
        expect(ledgerFor([], [blocking]).warnings).toEqual([]);
    });

    it('tells two series of one title apart by their slugs, in the label and the link', () => {
        const other = 'ser_view-other';
        const twin = { ...content.series[0], id: other, slug: 'view-other' };
        const candidate = { ...content, series: [content.series[0], twin] };
        const twinLayer = { ...layer, series: [...layer.series, { ...layer.series[0], id: other }] } as unknown as WorkingLayer;
        const diff: CatalogDiff = { activeRevisionId: REV(2), empty: false, changes: [] };
        const shared = [SERIES, other].map((id) => issue('series.duplicate-title', 'warning', { kind: 'series', id }, 'title', three[2].message, three[2].hint));
        const { warnings } = buildLedger({ diff, layer: twinLayer, active: candidate, candidate: candidate as CandidateContent, registry: null, review, activations: [], issues: shared, media: { draft: (url) => url, live: (url) => url } });
        expect(warnings.map((warning) => [warning.record, warning.link])).toEqual([
            ['View test (view-test)', { type: 'series', href: `/curation/series/${SERIES}`, name: 'View test (view-test)' }],
            ['View test (view-other)', { type: 'series', href: `/curation/series/${other}`, name: 'View test (view-other)' }],
        ]);
    });

    it("links a series only from an ID a series has, and a photograph by the fix its ledger row already offers", () => {
        // An ID no series could have, as a damaged diagnostic might hold: named, never linked.
        const odd = ledgerFor([], [issue('series.duplicate-title', 'warning', { kind: 'series', id: 'ser_../../curation' }, 'title', three[2].message)]);
        expect(odd.warnings[0].link).toBeNull();
        // A description waiting on review: the row's own Review the description.
        const generated = change('generated');
        const described = ledgerFor([generated], [three[0]]);
        const rowId = described.ledger.authored[0]?.id;
        expect(rowId).toMatch(/^chg-/);
        expect(described.warnings[0].link).toEqual({ type: 'description', rowId, name: 'Pier lamps' });
        // An Inbox item waiting on the photograph: its Decide it in the Inbox.
        const eventId = 'evt_0123456789abcdef01234567';
        const reopened = change('item-reopened', { record: { kind: 'photo', id: PHOTO }, field: 'alt', review: { state: 'stale', fields: [{ record: { kind: 'photo', id: PHOTO }, field: 'alt', state: 'stale', reason: 'item-reopened', eventId }] } });
        expect(ledgerFor([reopened], [three[0]]).warnings[0].link).toEqual({ type: 'inbox', eventId, name: 'Pier lamps' });
        // No row about it: named, with no link.
        expect(ledgerFor([], [three[0]]).warnings[0].link).toBeNull();
    });

    it("shows the latest check's warnings, a passing or a blocked one, else the page's, with Publish open after a pass, and none once nothing is pending", () => {
        const fromPage: PublishWarning[] = [{ key: 'k', record: 'View test (view-test)', field: 'title', message: three[2].message, hint: null, link: null }];
        const fromAnswer: PublishWarning[] = ledgerFor([], three).warnings;
        expect(displayFacts(view({ warnings: fromPage }), null, null).warnings).toEqual(fromPage);
        const valid = displayFacts(view({ warnings: fromPage }), { kind: 'valid', stakes: 'S', warnings: fromAnswer }, null);
        expect(valid.warnings).toEqual(fromAnswer);
        expect(valid.bar).toMatchObject({ validate: 'available', publish: 'available' });
        for (const kind of ['blocked', 'blocked-at-publish'] as const) {
            expect(displayFacts(view({ warnings: fromPage }), { kind, lead: 'L', blockers: [], ledger: empty, warnings: fromAnswer }, null).warnings, kind).toEqual(fromAnswer);
        }
        expect(displayFacts(view(), null, null).warnings).toEqual([]);
        expect(displayFacts(view({ kind: 'nothing', warnings: fromPage }), null, null).warnings).toEqual([]);
    });

    it('says in the answer, where the focus lands, how many warnings are listed above, singular or plural, and nothing when there are none', () => {
        const one = ledgerFor([], [three[0]]).warnings;
        const all = ledgerFor([], three).warnings;
        const body = (answer: Parameters<typeof resultCopy>[0]) => resultCopy(answer, view())?.body ?? [];
        expect(body({ kind: 'valid', stakes: 'S', warnings: one })).toContain("1 warning, listed above, which doesn't block publishing.");
        expect(body({ kind: 'valid', stakes: 'S', warnings: all })).toContain("3 warnings, listed above, which don't block publishing.");
        expect(body({ kind: 'blocked', lead: 'L', blockers: [], ledger: empty, warnings: all })).toContain("3 warnings, listed above, which don't block publishing.");
        expect(body({ kind: 'blocked-at-publish', lead: 'L', blockers: [], ledger: empty, warnings: one })).toContain("1 warning, listed above, which doesn't block publishing.");
        for (const answer of [{ kind: 'valid' as const, stakes: 'S', warnings: [] }, { kind: 'valid' as const, stakes: 'S' }]) expect(body(answer).join(' ')).not.toMatch(/warning/);
    });
});
