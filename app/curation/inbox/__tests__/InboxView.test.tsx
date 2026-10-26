import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCurationFixture } from '@/lib/curation/__tests__/curationFixtures';
import { eventIdOf, eventKey } from '@/lib/curation/events';
import { loadInbox } from '@/lib/curation/inbox';
import type { InboxActionState, InboxDetail, InboxItem, InboxView, SeriesOption } from '@/lib/curation/inbox-view';
import { createCurationSink } from '@/lib/curation/sink';
import { setDataDir } from '@/test/helpers/tempDataRoot';

// The Inbox's pieces as the curator sees them: the list and its states, the
// detail by type, and the forms, with the server actions stood in for, so
// what each form sends is checked here and what each action does is
// lib/curation/__tests__/inbox.test.ts's.

const sent = vi.hoisted(() => ({ forms: [] as { action: string; fields: Record<string, string> }[], answer: null as InboxActionState | null }));

vi.mock('../actions', () => {
    const make = (action: string) => async (_previous: InboxActionState, form: FormData): Promise<InboxActionState> => {
        sent.forms.push({ action, fields: Object.fromEntries([...form.entries()].map(([name, value]) => [name, String(value)])) });
        return sent.answer ?? { status: 'done', action: action as 'approve', eventId: String(form.get('eventId')), message: 'Done.', serial: sent.forms.length };
    };
    return { approveItem: make('approve'), editItem: make('edit'), deferItem: make('defer'), dismissItem: make('dismiss'), retryItem: make('retry'), reopenItem: make('reopen') };
});

const { default: InboxList } = await import('../InboxList');
const { default: InboxDetailView } = await import('../InboxDetailView');
const { rememberRow } = await import('../journey');

beforeEach(() => {
    sent.forms = [];
    sent.answer = null;
    window.sessionStorage.clear();
});

const P = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const EVT = (n: number) => `evt_${String(n).padStart(24, '0')}`;
const REV = `sha256-${'a'.repeat(64)}`;
const ACTIVE = `rev_${'b'.repeat(64)}`;

const THUMB = (n: number) => `/api/curation/media/${P(n)}/${REV}/p_${'c'.repeat(16)}/w400.webp`;
const SHORT = (n: number) => `ph_0000…${String(n).padStart(4, '0')}`;
const SERIES: SeriesOption[] = [
    { id: 'ser_harbor', label: 'Harbor', visibility: 'published', members: [{ photoId: P(1), shortId: SHORT(1) }, { photoId: P(2), shortId: SHORT(2) }] },
    { id: 'ser_draft', label: 'Draft series', visibility: 'draft', members: [] },
];

function item(overrides: Partial<InboxItem> = {}): InboxItem {
    return { id: EVT(1), version: 3, type: 'new', status: 'open', group: 'judgment', title: 'Uncurated photograph', photoId: P(9), shortId: SHORT(9), sourcePath: 'trips/harbor-1.jpg', thumbnailUrl: THUMB(9), waiting: null, placedBy: null, unplacedSeries: null, ...overrides };
}

function detail(overrides: Partial<InboxDetail> = {}): InboxDetail {
    return {
        ...item(),
        assetRevision: REV,
        observedAt: '2026-02-01T00:00:00.000Z',
        lastObservedAt: '2026-02-01T00:00:00.000Z',
        capturedDate: '2024-06-01',
        fromPath: null,
        identity: `${P(9)}, source present`,
        derivatives: 'p_1 ready',
        previewUrl: `/api/curation/media/${P(9)}/${REV}/p_${'c'.repeat(16)}/w800.webp`,
        facts: [{ label: 'Capture date', value: '2024-06-01' }],
        failure: null,
        candidates: [],
        references: [],
        suggestions: {
            series: { value: 'ser_harbor', confidence: 'high', producedBy: 'rules@abc', producedAt: '2026-02-01T00:00:00.000Z', evidence: ['folder trips'] },
            placement: { value: { after: P(1) }, confidence: 'low', producedBy: 'rules@abc', producedAt: '2026-02-01T00:00:00.000Z', evidence: [] },
        },
        edits: null,
        placed: null,
        lastApprovedSeries: null,
        decisions: [],
        reviewedAt: null,
        reviewedBy: null,
        can: { approve: true, edit: true, defer: true, dismiss: true, retry: false, reopen: false },
        primaryUnavailable: null,
        ...overrides,
    };
}

function view(overrides: Partial<Extract<InboxView, { state: 'ready' }>> = {}): Extract<InboxView, { state: 'ready' }> {
    return { state: 'ready', activeRevisionId: ACTIVE, needsJudgment: 1, waiting: 0, placed: 0, unplaced: 0, placementUnknown: false, items: [item()], problems: [], series: SERIES, seriesProblem: null, selected: detail(), missingSelection: null, ...overrides };
}

const tree = (v: ReturnType<typeof view>, listView = false) => (
    <main>
        <InboxList view={v} listView={listView} />
        <InboxDetailView view={v} />
    </main>
);
const renderInbox = (v = view(), listView = false) => render(tree(v, listView));

describe('the list', () => {
    it('says how many items need judgment, links each, and marks the open one', () => {
        renderInbox(view({ items: [item(), item({ id: EVT(2), type: 'replacement', group: 'waiting', title: 'Replacement building', waiting: 'its new derivatives are still building' })], waiting: 1 }));
        expect(screen.getByRole('heading', { level: 1, name: 'Curation inbox' })).toBeInTheDocument();
        expect(screen.getByText('1 of 2 items requires judgment, 1 waiting')).toBeInTheDocument();
        // A phone's way back lands on the open item's row.
        expect(screen.getByRole('link', { name: 'Back to inbox' })).toHaveAttribute('href', `/curation/inbox#row-${EVT(1)}`);
        const links = screen.getAllByRole('link', { name: /photograph|Replacement/ });
        // Each lands on the item itself, past the list, on a phone and for a keyboard alike.
        expect(links.map((link) => link.getAttribute('href'))).toEqual([`/curation/inbox?item=${EVT(1)}#item`, `/curation/inbox?item=${EVT(2)}#item`]);
        expect(document.getElementById('item')).toHaveAttribute('aria-labelledby', 'item-heading');
        expect(links[0]).toHaveAttribute('aria-current', 'true');
        expect(links[1]).not.toHaveAttribute('aria-current');
        expect(screen.getByRole('heading', { name: 'Waiting' })).toBeInTheDocument();
        expect(screen.getByText('Waiting: its new derivatives are still building')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Refresh inbox' }).closest('form')).toHaveAttribute('method', 'get');
    });

    it('brings the item into view, and its heading into focus, when the URL asks for it, as a row link does', () => {
        const scrolled = vi.fn();
        const original = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = scrolled;
        window.location.hash = '#item';
        try {
            renderInbox();
            const target = document.getElementById('item')!;
            expect(scrolled).toHaveBeenCalledTimes(1);
            expect(scrolled.mock.contexts[0]).toBe(target);
            // The heading names the photograph, so a screen reader says which one opened.
            const heading = screen.getByRole('heading', { level: 2, name: 'harbor-1.jpg' });
            expect(heading).toHaveFocus();
            expect(heading).toHaveAttribute('tabindex', '-1');
            expect(target).not.toHaveAttribute('tabindex');
        } finally {
            window.location.hash = '';
            Element.prototype.scrollIntoView = original;
        }
    });

    it('leaves the scroll and focus alone without #item', () => {
        const scrolled = vi.fn();
        const original = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = scrolled;
        try {
            renderInbox();
            expect(scrolled).not.toHaveBeenCalled();
            expect(screen.getByRole('heading', { level: 2, name: 'harbor-1.jpg' })).not.toHaveFocus();
        } finally {
            Element.prototype.scrollIntoView = original;
        }
    });

    it('tells rows apart by source file and the ID head and tail', () => {
        renderInbox(view({ items: [item(), item({ id: EVT(2), photoId: P(10), shortId: SHORT(10), sourcePath: 'trips/harbor-2.jpg' })] }));
        const links = screen.getAllByRole('link', { name: /Uncurated photograph/ });
        expect(within(links[0]).getByText('trips/harbor-1.jpg')).toBeInTheDocument();
        expect(within(links[0]).getByText('ph_0000…0009')).toBeInTheDocument();
        expect(within(links[1]).getByText('trips/harbor-2.jpg')).toBeInTheDocument();
        expect(within(links[1]).getByText('ph_0000…0010')).toBeInTheDocument();
    });

    it('shows the empty state once, with where photographs go in', () => {
        renderInbox(view({ items: [], needsJudgment: 0, selected: null }));
        expect(screen.getByRole('heading', { name: 'Nothing requires judgment' })).toBeInTheDocument();
        expect(screen.getByText('0 items require judgment')).toBeInTheDocument();
        expect(screen.getAllByText(/library folder/)).toHaveLength(1);
        expect(screen.queryByText(/its suggestion shows here/)).toBeNull();
        expect(screen.queryByRole('form')).toBeNull();
        // The detail side keeps one quiet line, so a wide screen isn't blank, and doesn't repeat the list.
        const pane = screen.getByRole('region', { name: 'Item' });
        expect(pane).toHaveTextContent('Nothing to review. A new photograph opens here once the watcher picks it up.');
        expect(within(pane).queryByRole('heading')).toBeNull();
        expect(screen.getAllByText(/Nothing requires judgment/)).toHaveLength(1);
    });

    it('names the total beside the count needing judgment once settled items are listed too', () => {
        renderInbox(view({ items: [item(), item({ id: EVT(2), status: 'approved', group: 'settled' }), item({ id: EVT(3), status: 'dismissed', group: 'settled' })] }));
        expect(screen.getByText('1 of 3 items requires judgment')).toBeInTheDocument();
    });

    it('shows a source name with control, bidi, and zero-width characters escaped, in its row and its heading', async () => {
        const f = await createCurationFixture();
        const restore = setDataDir(f.root);
        try {
            // A synced library file can carry any name; #10 doesn't filter them.
            const name = 'evil\u202egpj.exe\u0007\u200b\u2066.jpg';
            const fact = f.fact('new', f.fresh[0], { path: `trips/${name}`, folder: 'trips' });
            await createCurationSink({ root: f.root, logger: { log: () => undefined, warn: () => undefined, error: () => undefined } })([fact]);
            const loaded = await loadInbox(eventIdOf(eventKey('new', fact)));
            if (loaded.state !== 'ready') throw new Error(`The inbox is ${loaded.state}`);
            renderInbox(loaded);
            const escaped = 'evil\\u202egpj.exe\\u0007\\u200b\\u2066.jpg';
            const row = screen.getByRole('link', { name: /Uncurated photograph/ });
            const heading = screen.getByRole('heading', { level: 2, name: escaped });
            for (const shown of [row, heading]) {
                expect(shown.textContent).toContain(escaped);
                // eslint-disable-next-line no-control-regex
                expect(shown.textContent).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u);
            }
            expect(within(row).getByText(`trips/${escaped}`)).toBeInTheDocument();
        } finally {
            restore();
            await f.cleanup();
        }
    });

    it('lists an unreadable item by ID', () => {
        renderInbox(view({ problems: [{ id: EVT(7), message: 'invalid-json: its newest version is not a JSON object' }] }));
        expect(screen.getByRole('heading', { name: "1 item can't be read" })).toBeInTheDocument();
        expect(screen.getByText(EVT(7))).toBeInTheDocument();
    });
});

describe('the detail', () => {
    it('leads with the file name, its folder and capture date, and the photograph; the full IDs sit in Source facts', () => {
        renderInbox();
        expect(screen.getByRole('img', { name: 'Candidate photograph harbor-1.jpg' })).toHaveAttribute('src', expect.stringMatching(/^\/api\/curation\/media\//));
        expect(screen.getByRole('heading', { level: 2, name: 'harbor-1.jpg' })).toBeInTheDocument();
        expect(screen.getByText('In trips, captured 1 June 2024')).toBeInTheDocument();
        const top = screen.getByRole('heading', { level: 2, name: 'harbor-1.jpg' }).closest('header')!.nextElementSibling as HTMLElement;
        expect(within(top).getByText('Stable photo identity').nextElementSibling).toHaveTextContent('ph_0000…0009');
        expect(within(top).getByText('Asset revision').nextElementSibling).toHaveTextContent('sha256-aaaa…aaaa');
        expect(within(top).getByText('System response')).toBeInTheDocument();
        expect(screen.getByText('Draft only')).toBeInTheDocument();
        expect(screen.getByText('Published statement remains unchanged.')).toBeInTheDocument();
        // Source facts sit apart from the suggestion the curator edits, and keep the full values.
        const facts = screen.getByRole('region', { name: 'Source facts' });
        expect(within(facts).getByText(REV)).toBeInTheDocument();
        expect(within(facts).getByText(`${P(9)}, source present`)).toBeInTheDocument();
        expect(within(facts).getByText('Referenced by').nextElementSibling).toHaveTextContent('Nothing');
        expect(screen.getByRole('heading', { name: 'Reviewable suggestion' })).toBeInTheDocument();
        expect(screen.getByText(/high confidence, by rules@abc/)).toBeInTheDocument();
        // On a phone, a way back to the list from the top of the detail, to this item's row.
        expect(screen.getByRole('link', { name: 'Back to inbox' })).toHaveAttribute('href', `/curation/inbox#row-${EVT(1)}`);
        expect(screen.getByRole('link', { name: 'Back to inbox' }).compareDocumentPosition(screen.getByRole('img', { name: /^Candidate photograph/ })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(document.getElementById('inbox-list')).toBeInTheDocument();
    });

    it('names series by title and keeps the live revision apart, for a replacement and in Source facts', () => {
        renderInbox(view({ selected: detail({ type: 'replacement', photoId: P(2), shortId: SHORT(2), references: [{ kind: 'revision', id: ACTIVE }, { kind: 'series', id: 'ser_harbor' }, { kind: 'series', id: 'ser_draft' }], can: { approve: false, edit: true, defer: true, dismiss: false, retry: false, reopen: false }, primaryUnavailable: 'Not yet.' }) }));
        expect(screen.getByText('Series membership').nextElementSibling).toHaveTextContent('Harbor, position 02; Draft series');
        expect(screen.getByText('Title, description, and story stay attached to ph_0000…0002')).toBeInTheDocument();
        expect(screen.getByText('Referenced by').nextElementSibling).toHaveTextContent('The live revision (rev_bbbb…bbbb); series Harbor and Draft series (draft)');
        expect(screen.queryByText(/ser_harbor/)).toBeNull();
    });

    it('never calls an approval no longer placed approved', () => {
        renderInbox(view({ selected: detail({ status: 'approved', group: 'unplaced', unplacedSeries: 'ser_draft', lastApprovedSeries: 'ser_draft', placed: { alt: null, seriesIds: [] }, can: { approve: false, edit: false, defer: false, dismiss: false, retry: false, reopen: true } }) }));
        expect(screen.queryByText('Suggestion approved')).toBeNull();
        expect(screen.getByText('Approved, no longer placed')).toBeInTheDocument();
        expect(screen.getByText('System response').nextElementSibling).toHaveTextContent(/approved into Draft series, but nothing holds its photo now/);
        expect(screen.queryByText(/waits here as a draft suggestion/)).toBeNull();
    });

    it('says once that an approval is in the draft, and where', () => {
        renderInbox(view({ selected: detail({ status: 'approved', group: 'settled', placed: { alt: null, seriesIds: ['ser_draft'] }, lastApprovedSeries: 'ser_draft', can: { approve: false, edit: false, defer: false, dismiss: false, retry: false, reopen: true } }) }));
        expect(screen.getByText('Suggestion approved')).toBeInTheDocument();
        expect(screen.getByText('System response').nextElementSibling).toHaveTextContent('In the draft, in Draft series. Nothing publishes until you publish.');
        expect(screen.queryAllByText(/Approved into the draft/)).toHaveLength(0);
    });

    it('offers the suggested series, Leave unassigned, and the positions in that series', () => {
        renderInbox();
        const series = screen.getByRole('combobox', { name: 'Suggested series' });
        expect(series).toHaveValue('ser_harbor');
        expect(within(series).getAllByRole('option').map((option) => option.textContent)).toEqual(['Harbor', 'Draft series (draft)', 'Leave unassigned']);
        const position = screen.getByRole('combobox', { name: 'Proposed sequence position' });
        expect(position).toHaveValue(`after:${P(1)}`);
        expect(within(position).getAllByRole('option').map((option) => option.textContent)).toEqual([
            'At the start',
            'At the end',
            `After photograph 01 (${SHORT(1)})`,
            `After photograph 02 (${SHORT(2)})`,
            'Choose in sequence editor',
        ]);
    });

    it('shows a replacement and a missing source with their own boxes and no primary action yet', () => {
        const { unmount } = renderInbox(view({ selected: detail({ type: 'replacement', title: 'Replacement ready', can: { approve: false, edit: true, defer: true, dismiss: true, retry: false, reopen: false }, primaryUnavailable: "Confirming new bytes isn't in the inbox yet." }) }));
        expect(screen.getByRole('heading', { name: 'Identity-preserving replacement' })).toBeInTheDocument();
        expect(screen.getByText('Use the new bytes only after all derivatives succeed')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Confirm new asset revision' })).toBeDisabled();
        // The live action takes the primary place; the unavailable one sits before it, quieter.
        const row = screen.getByRole('button', { name: 'Decide later' }).parentElement!;
        expect(within(row).getAllByRole('button').map((button) => button.textContent)).toEqual(['Confirm new asset revision', 'Decide later']);
        expect(screen.queryByRole('combobox', { name: 'Suggested series' })).toBeNull();
        unmount();
        renderInbox(view({ selected: detail({ type: 'missing', can: { approve: false, edit: true, defer: true, dismiss: true, retry: false, reopen: false }, primaryUnavailable: "Locating isn't in the inbox yet." }) }));
        expect(screen.getByRole('heading', { name: 'Published output protected' })).toBeInTheDocument();
        expect(screen.getByText('Archive after removing series references')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Resolve source or archive intentionally' })).toBeDisabled();
    });

    it('says so when the URL names an item the inbox lacks', () => {
        renderInbox(view({ selected: null, missingSelection: EVT(4) }));
        expect(screen.getByText(/isn't in the inbox any more/)).toBeInTheDocument();
    });
});

/** Submit with `button` and wait for the action's answer. */
async function press(button: HTMLElement) {
    await act(async () => {
        fireEvent.click(button);
    });
}

describe('the forms', () => {
    it('send the item, its version, the active revision, and the shown series, and leave an untouched position out', async () => {
        renderInbox();
        await press(screen.getByRole('button', { name: 'Approve into draft' }));
        expect(sent.forms).toEqual([{ action: 'approve', fields: { eventId: EVT(1), version: '3', base: ACTIVE, series: 'ser_harbor', description: '', decorative: 'off', intent: 'approve' } }]);
        expect(await screen.findByText('Done.')).toBeInTheDocument();
    });

    it('send only what the curator changed, and a typed description', async () => {
        renderInbox();
        fireEvent.change(screen.getByRole('combobox', { name: 'Suggested series' }), { target: { value: 'ser_draft' } });
        fireEvent.change(screen.getByRole('textbox', { name: 'Draft description' }), { target: { value: 'Typed by me.' } });
        await press(screen.getByRole('button', { name: 'Save edits' }));
        expect(sent.forms[0]).toEqual({ action: 'edit', fields: { eventId: EVT(1), version: '3', base: ACTIVE, series: 'ser_draft', seriesTouched: '1', description: 'Typed by me.', decorative: 'off', intent: 'edit' } });
    });

    it('send a position picked in the sequence editor', async () => {
        renderInbox();
        fireEvent.change(screen.getByRole('combobox', { name: 'Proposed sequence position' }), { target: { value: 'editor' } });
        const editor = screen.getByRole('group', { name: 'Place it in Harbor' });
        fireEvent.click(within(editor).getByRole('radio', { name: 'At the start' }));
        await press(screen.getByRole('button', { name: 'Approve into draft' }));
        expect(sent.forms[0].fields).toMatchObject({ placement: 'start', series: 'ser_harbor', intent: 'approve' });
        expect(sent.forms[0].fields.seriesTouched).toBeUndefined();
    });

    it('send the decorative flag instead of text', async () => {
        renderInbox();
        fireEvent.click(screen.getByRole('checkbox', { name: /Decorative/ }));
        await press(screen.getByRole('button', { name: 'Approve into draft' }));
        expect(sent.forms[0].fields).toMatchObject({ decorative: 'on' });
        // The disabled field isn't sent; the flag stands for the description.
        expect(sent.forms[0].fields.description).toBeUndefined();
    });

    it('send an unchecked Decorative box as off, with the saved flag, so a saved flag can be cleared', async () => {
        renderInbox(view({ selected: detail({ edits: { description: { kind: 'decorative' }, editedAt: '2026-02-01T00:00:00.000Z', editedBy: 'curator:web' } }) }));
        const box = screen.getByRole('checkbox', { name: /Decorative/ });
        expect(box).toBeChecked();
        fireEvent.click(box);
        await press(screen.getByRole('button', { name: 'Save edits' }));
        expect(sent.forms[0].fields).toMatchObject({ decorative: 'off', descriptionWas: 'decorative', description: '' });
    });

    it('keep the shown series and the sent series the same after a refused answer', async () => {
        sent.answer = { status: 'invalid', action: 'approve', eventId: EVT(1), message: 'The description is plain text, so it can’t hold markup.', serial: 1 };
        renderInbox();
        const series = () => screen.getByRole('combobox', { name: 'Suggested series' }) as HTMLSelectElement;
        fireEvent.change(series(), { target: { value: 'ser_draft' } });
        fireEvent.change(screen.getByRole('textbox', { name: 'Draft description' }), { target: { value: '<b>x</b>' } });
        await press(screen.getByRole('button', { name: 'Approve into draft' }));
        expect(await screen.findByText(/can’t hold markup/)).toBeInTheDocument();
        expect(series().value).toBe('ser_draft');
        sent.answer = null;
        fireEvent.change(screen.getByRole('textbox', { name: 'Draft description' }), { target: { value: 'Fixed.' } });
        await press(screen.getByRole('button', { name: 'Approve into draft' }));
        expect(sent.forms[1].fields.series).toBe(series().value);
    });

    it('send "Leave unassigned" when it is the shown default, as it is with no rules file', async () => {
        renderInbox(view({ selected: detail({ suggestions: { series: { value: null, confidence: 'low', producedBy: 'rules@none', producedAt: '2026-02-01T00:00:00.000Z', evidence: [] }, placement: null } }) }));
        expect(screen.getByRole('combobox', { name: 'Suggested series' })).toHaveValue('unassigned');
        await press(screen.getByRole('button', { name: 'Approve into draft' }));
        expect(sent.forms[0].fields).toMatchObject({ series: 'unassigned', intent: 'approve' });
        expect(sent.forms[0].fields.seriesTouched).toBeUndefined();
    });

    it('fill a reopened item from its photo record and series, so unchecking the flag clears it', async () => {
        const noRules = { series: { value: null, confidence: 'low' as const, producedBy: 'rules@none', producedAt: '2026-02-01T00:00:00.000Z', evidence: [] }, placement: null };
        const approved = [{ action: 'approve', at: '2026-02-01T00:00:00.000Z', by: 'curator:web', detail: '' }, { action: 'reopen', at: '2026-02-01T00:01:00.000Z', by: 'curator:web', detail: '' }];
        renderInbox(view({ selected: detail({ suggestions: noRules, decisions: approved, placed: { alt: { kind: 'decorative' }, seriesIds: ['ser_harbor'] } }) }));
        expect(screen.getByRole('combobox', { name: 'Suggested series' })).toHaveValue('ser_harbor');
        const box = screen.getByRole('checkbox', { name: /Decorative/ });
        expect(box).toBeChecked();
        fireEvent.click(box);
        await press(screen.getByRole('button', { name: 'Approve into draft' }));
        expect(sent.forms[0].fields).toMatchObject({ series: 'ser_harbor', decorative: 'off', descriptionWas: 'decorative', description: '' });
    });

    it('start a reopened item that is no longer placed on the series it was approved into, and send it', async () => {
        const noRules = { series: { value: null, confidence: 'low' as const, producedBy: 'rules@none', producedAt: '2026-02-01T00:00:00.000Z', evidence: [] }, placement: null };
        const approved = [{ action: 'approve', at: '2026-02-01T00:00:00.000Z', by: 'curator:web', detail: '' }, { action: 'reopen', at: '2026-02-01T00:01:00.000Z', by: 'curator:web', detail: '' }];
        renderInbox(view({ selected: detail({ suggestions: noRules, decisions: approved, placed: { alt: { kind: 'described', text: 'Harbor wall at dusk.' }, seriesIds: [] }, lastApprovedSeries: 'ser_harbor' }) }));
        expect(screen.getByRole('combobox', { name: 'Suggested series' })).toHaveValue('ser_harbor');
        // The captions say what the form starts from, not the suggestion it no longer shows.
        expect(screen.getByText('Starts on Harbor, where it was approved. No series rule is set up (curation/rules.json), so nothing is suggested.')).toBeInTheDocument();
        expect(screen.queryByText(/Suggested leaving it unassigned/)).toBeNull();
        expect(screen.getByRole('textbox', { name: 'Draft description' })).toHaveAccessibleDescription('The description it was approved with, stored as reviewed. Clear it to withdraw it.');
        expect(screen.queryByText(/^Nothing is suggested/)).toBeNull();
        await press(screen.getByRole('button', { name: 'Approve into draft' }));
        expect(sent.forms[0].fields).toMatchObject({ series: 'ser_harbor', intent: 'approve' });
        expect(sent.forms[0].fields.seriesTouched).toBeUndefined();
    });

    it('say once that no series rule is set up, without the internal producer name', () => {
        renderInbox(view({ selected: detail({ suggestions: { series: { value: null, confidence: 'low', producedBy: 'rules@none', producedAt: '2026-02-01T00:00:00.000Z', evidence: ['There is no curation/rules.json, so no series is suggested.'] }, placement: null } }) }));
        expect(screen.getByText('No series rule is set up (curation/rules.json), so nothing is suggested.')).toBeInTheDocument();
        expect(screen.queryByText(/rules@none/)).toBeNull();
        expect(screen.queryByText(/There is no curation\/rules.json/)).toBeNull();
    });

    it('show a refused description by the description field, mark the field, and move focus to it', async () => {
        sent.answer = { status: 'invalid', action: 'approve', eventId: EVT(1), message: 'The description is plain text, so it can’t hold markup.', field: 'description', serial: 1 };
        renderInbox();
        const field = screen.getByRole('textbox', { name: 'Draft description' });
        fireEvent.change(field, { target: { value: '<b>x</b>' } });
        await press(screen.getByRole('button', { name: 'Approve into draft' }));
        expect(field).toHaveAttribute('aria-invalid', 'true');
        expect(field).toHaveAccessibleDescription(/can’t hold markup/);
        expect(field).toHaveFocus();
        // Shown once, by the field, and not again under the buttons.
        expect(screen.getAllByText(/can’t hold markup/)).toHaveLength(1);
        const error = screen.getByText(/can’t hold markup/);
        expect(error.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
        expect(error.compareDocumentPosition(screen.getByRole('checkbox', { name: /Decorative/ })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('put an answer right under the buttons that produced it, above Dismiss', async () => {
        sent.answer = { status: 'stale', action: 'approve', eventId: EVT(1), message: 'This item changed since the page loaded, so nothing was written.', serial: 1 };
        renderInbox();
        await press(screen.getByRole('button', { name: 'Approve into draft' }));
        const notice = await screen.findByText(/changed since the page loaded/);
        const dismiss = screen.getByText('Dismiss with a reason');
        expect(notice.compareDocumentPosition(screen.getByRole('button', { name: 'Approve into draft' })) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
        expect(notice.compareDocumentPosition(dismiss) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('put a refused dismissal inside Dismiss, by its button', async () => {
        sent.answer = { status: 'refused', action: 'dismiss', eventId: EVT(1), message: 'Something still shows this photograph, so it can’t be dismissed.', serial: 1 };
        renderInbox();
        fireEvent.change(screen.getByRole('textbox', { name: 'Reason' }), { target: { value: 'A duplicate.' } });
        await press(screen.getByRole('button', { name: 'Dismiss' }));
        const notice = await screen.findByText(/can’t be dismissed/);
        expect(notice.closest('details')).not.toBeNull();
    });

    it('fill a reopened item with its reviewed description', () => {
        renderInbox(view({ selected: detail({ placed: { alt: { kind: 'described', text: 'Typed at the first approval.' }, seriesIds: [] } }) }));
        expect(screen.getByRole('textbox', { name: 'Draft description' })).toHaveValue('Typed at the first approval.');
    });

    it('post every form, so a click before hydration never puts the typed text in a URL', () => {
        renderInbox();
        for (const form of document.querySelectorAll('form')) {
            if (form.querySelector('[aria-label="Refresh inbox"]')) continue;
            expect(form.getAttribute('method')).toBe('post');
        }
    });

    it('take the description on one line, as the server stores it', () => {
        renderInbox();
        expect(screen.getByRole('textbox', { name: 'Draft description' }).tagName).toBe('INPUT');
    });

    it('show a stale answer with a way to refresh, and keep what the curator typed', async () => {
        sent.answer = { status: 'stale', action: 'approve', eventId: EVT(1), message: 'This item changed since the page loaded, so nothing was written.', serial: 1 };
        renderInbox();
        fireEvent.change(screen.getByRole('textbox', { name: 'Draft description' }), { target: { value: 'Still here.' } });
        await press(screen.getByRole('button', { name: 'Approve into draft' }));
        expect(await screen.findByText(/changed since the page loaded/)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Refresh and review again' })).toHaveAttribute('href', `/curation/inbox?item=${EVT(1)}#item`);
        expect(screen.getByRole('textbox', { name: 'Draft description' })).toHaveValue('Still here.');
    });

    it('dismiss with a reason, and offer reopen and retry only where they can work', async () => {
        const { unmount } = renderInbox();
        expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Retry processing' })).toBeNull();
        fireEvent.change(screen.getByRole('textbox', { name: 'Reason' }), { target: { value: 'A duplicate.' } });
        await press(screen.getByRole('button', { name: 'Dismiss' }));
        expect(sent.forms[0].fields).toMatchObject({ intent: 'dismiss', reason: 'A duplicate.', eventId: EVT(1) });
        unmount();
        renderInbox(view({ selected: detail({ status: 'approved', can: { approve: false, edit: false, defer: false, dismiss: false, retry: false, reopen: true } }) }));
        expect(screen.getByText('Suggestion approved')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Approve into draft' })).toBeNull();
        await press(screen.getByRole('button', { name: 'Reopen' }));
        expect(sent.forms[1].fields).toMatchObject({ intent: 'reopen', version: '3' });
    });
});

describe('thumbnails in the list', () => {
    it('show the ready set\'s w400 WebP at a fixed size, lazily, with an empty alt beside the file name', () => {
        renderInbox();
        const row = screen.getByRole('link', { name: /Uncurated photograph/ });
        const thumb = row.querySelector('img')!;
        expect(thumb).toHaveAttribute('src', THUMB(9));
        expect(thumb.getAttribute('src')).toMatch(/^\/api\/curation\/media\/.+\/w400\.webp$/);
        expect(thumb).toHaveAttribute('alt', '');
        expect(thumb).toHaveAttribute('loading', 'lazy');
        expect(thumb).toHaveAttribute('width', '56');
        expect(thumb).toHaveAttribute('height', '56');
        // The file name names the row, not the picture.
        expect(row).toHaveAccessibleName(/trips\/harbor-1\.jpg/);
        expect(within(row).queryByRole('img')).toBeNull();
    });

    it('hold the place with a neutral square when no set is ready', () => {
        renderInbox(view({ items: [item({ type: 'processing-failure', title: 'Processing failed', photoId: null, shortId: 'no photo ID', thumbnailUrl: null })], selected: null, needsJudgment: 1 }));
        const row = screen.getByRole('link', { name: /Processing failed/ });
        expect(row.querySelector('img')).toBeNull();
        const placeholder = row.querySelector('[data-thumb="none"]')!;
        expect(placeholder).toHaveAttribute('aria-hidden', 'true');
        expect(row.firstElementChild).toBe(placeholder);
    });
});

describe('one item at a time on a phone', () => {
    it('links every row to its item, and names each row for the way back', () => {
        renderInbox(view({ items: [item(), item({ id: EVT(2) })] }));
        const rows = screen.getAllByRole('link', { name: /Uncurated photograph/ });
        expect(rows.map((row) => row.id)).toEqual([`row-${EVT(1)}`, `row-${EVT(2)}`]);
        expect(rows.map((row) => row.dataset.row)).toEqual([EVT(1), EVT(2)]);
    });

    it('offers Back to inbox for an item the inbox no longer has', () => {
        renderInbox(view({ selected: null, missingSelection: EVT(4) }));
        expect(screen.getByRole('link', { name: 'Back to inbox' })).toHaveAttribute('href', '/curation/inbox');
    });

    it('remembers the row a tap leaves the list from, and how far down the list was', () => {
        renderInbox(view({ items: [item(), item({ id: EVT(2) })] }));
        window.scrollY = 640;
        try {
            const row = screen.getAllByRole('link', { name: /Uncurated photograph/ })[1];
            row.addEventListener('click', (event) => event.preventDefault(), { once: true });
            fireEvent.click(within(row).getByText('Uncurated photograph'));
            expect(JSON.parse(window.sessionStorage.getItem('curation-inbox:return')!)).toEqual({ id: EVT(2), scrollY: 640 });
        } finally {
            window.scrollY = 0;
        }
    });

    it('returns Back to inbox to the remembered scroll, with the row it came from focused', () => {
        const scrolledTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
        // In view once scrolled back, so nothing else moves it.
        const box = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: 200, bottom: 272, left: 0, right: 390, width: 390, height: 72, x: 0, y: 200, toJSON: () => ({}) });
        const scrolled = vi.fn();
        const original = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = scrolled;
        rememberRow(EVT(2), 640);
        window.location.hash = `#row-${EVT(2)}`;
        try {
            renderInbox(view({ items: [item(), item({ id: EVT(2) })] }), true);
            expect(scrolledTo).toHaveBeenCalledWith(0, 640);
            expect(scrolled.mock.contexts).not.toContain(document.getElementById(`row-${EVT(2)}`));
            expect(document.getElementById(`row-${EVT(2)}`)).toHaveFocus();
        } finally {
            window.location.hash = '';
            scrolledTo.mockRestore();
            box.mockRestore();
            Element.prototype.scrollIntoView = original;
        }
    });

    it('scrolls a row it has no memory of into view, and focuses it', () => {
        const scrolled = vi.fn();
        const original = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = scrolled;
        window.location.hash = `#row-${EVT(2)}`;
        try {
            renderInbox(view({ items: [item(), item({ id: EVT(2) })] }), true);
            const row = document.getElementById(`row-${EVT(2)}`)!;
            expect(scrolled.mock.contexts).toContain(row);
            expect(row).toHaveFocus();
        } finally {
            window.location.hash = '';
            Element.prototype.scrollIntoView = original;
        }
    });

    it('leaves a plain visit to the list alone', () => {
        const scrolledTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
        rememberRow(EVT(2), 640);
        try {
            renderInbox(view({ items: [item(), item({ id: EVT(2) })] }), true);
            expect(scrolledTo).not.toHaveBeenCalled();
            expect(document.getElementById(`row-${EVT(2)}`)).not.toHaveFocus();
        } finally {
            scrolledTo.mockRestore();
        }
    });
});
