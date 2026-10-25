import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxActionState, InboxDetail, InboxItem, InboxView, SeriesOption } from '@/lib/curation/inbox-view';

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

beforeEach(() => {
    sent.forms = [];
    sent.answer = null;
});

const P = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const EVT = (n: number) => `evt_${String(n).padStart(24, '0')}`;
const REV = `sha256-${'a'.repeat(64)}`;
const ACTIVE = `rev_${'b'.repeat(64)}`;

const SERIES: SeriesOption[] = [
    { id: 'ser_harbor', label: 'Harbor', visibility: 'published', members: [{ photoId: P(1), shortId: P(1).slice(0, 11) }, { photoId: P(2), shortId: P(2).slice(0, 11) }] },
    { id: 'ser_draft', label: 'Draft series', visibility: 'draft', members: [] },
];

function item(overrides: Partial<InboxItem> = {}): InboxItem {
    return { id: EVT(1), version: 3, type: 'new', status: 'open', group: 'judgment', title: 'Uncurated photograph', photoId: P(9), shortId: P(9).slice(0, 11), waiting: null, placedBy: null, unplacedSeries: null, ...overrides };
}

function detail(overrides: Partial<InboxDetail> = {}): InboxDetail {
    return {
        ...item(),
        assetRevision: REV,
        observedAt: '2026-02-01T00:00:00.000Z',
        lastObservedAt: '2026-02-01T00:00:00.000Z',
        sourcePath: 'trips/harbor-1.jpg',
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

const renderInbox = (v = view()) =>
    render(
        <main>
            <InboxList view={v} />
            <InboxDetailView view={v} />
        </main>,
    );

describe('the list', () => {
    it('says how many items need judgment, links each, and marks the open one', () => {
        renderInbox(view({ items: [item(), item({ id: EVT(2), type: 'replacement', group: 'waiting', title: 'Replacement building', waiting: 'its new derivatives are still building' })], waiting: 1 }));
        expect(screen.getByRole('heading', { level: 1, name: 'Curation inbox' })).toBeInTheDocument();
        expect(screen.getByText('1 item requires judgment, 1 waiting')).toBeInTheDocument();
        const links = screen.getAllByRole('link', { name: /photograph|Replacement/ });
        expect(links.map((link) => link.getAttribute('href'))).toEqual([`/curation/inbox?item=${EVT(1)}`, `/curation/inbox?item=${EVT(2)}`]);
        expect(links[0]).toHaveAttribute('aria-current', 'true');
        expect(links[1]).not.toHaveAttribute('aria-current');
        expect(screen.getByRole('heading', { name: 'Waiting' })).toBeInTheDocument();
        expect(screen.getByText('Waiting: its new derivatives are still building')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Refresh inbox' }).closest('form')).toHaveAttribute('method', 'get');
    });

    it('shows the empty state when nothing is in the inbox', () => {
        renderInbox(view({ items: [], needsJudgment: 0, selected: null }));
        expect(screen.getByRole('heading', { name: 'Nothing requires judgment' })).toBeInTheDocument();
        expect(screen.getByText('0 items require judgment')).toBeInTheDocument();
        expect(screen.queryByRole('form')).toBeNull();
    });

    it('lists an unreadable item by ID', () => {
        renderInbox(view({ problems: [{ id: EVT(7), message: 'invalid-json: its newest version is not a JSON object' }] }));
        expect(screen.getByRole('heading', { name: "1 item can't be read" })).toBeInTheDocument();
        expect(screen.getByText(EVT(7))).toBeInTheDocument();
    });
});

describe('the detail', () => {
    it('shows the photograph, its identity, the system response, and the locked statement', () => {
        renderInbox();
        expect(screen.getByRole('img', { name: `Candidate photograph ${P(9).slice(0, 11)}` })).toHaveAttribute('src', expect.stringMatching(/^\/api\/curation\/media\//));
        expect(screen.getByRole('heading', { level: 2, name: P(9) })).toBeInTheDocument();
        expect(screen.getByText('Stable photo identity')).toBeInTheDocument();
        expect(screen.getByText('Asset revision')).toBeInTheDocument();
        expect(screen.getByText('System response')).toBeInTheDocument();
        expect(screen.getByText('Draft only')).toBeInTheDocument();
        expect(screen.getByText('Published statement remains unchanged.')).toBeInTheDocument();
        // Source facts sit apart from the suggestion the curator edits.
        expect(screen.getByRole('heading', { name: 'Source facts' })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Reviewable suggestion' })).toBeInTheDocument();
        expect(screen.getByText(/high confidence, by rules@abc/)).toBeInTheDocument();
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
            `After photograph 01 (${P(1).slice(0, 11)})`,
            `After photograph 02 (${P(2).slice(0, 11)})`,
            'Choose in sequence editor',
        ]);
    });

    it('shows a replacement and a missing source with their own boxes and no primary action yet', () => {
        const { unmount } = renderInbox(view({ selected: detail({ type: 'replacement', title: 'Replacement ready', can: { approve: false, edit: true, defer: true, dismiss: true, retry: false, reopen: false }, primaryUnavailable: "Confirming new bytes isn't in the inbox yet." }) }));
        expect(screen.getByRole('heading', { name: 'Identity-preserving replacement' })).toBeInTheDocument();
        expect(screen.getByText('Use the new bytes only after all derivatives succeed')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Confirm new asset revision' })).toBeDisabled();
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
        await press(screen.getByRole('button', { name: 'Review series suggestion' }));
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
        await press(screen.getByRole('button', { name: 'Review series suggestion' }));
        expect(sent.forms[0].fields).toMatchObject({ placement: 'start', series: 'ser_harbor', intent: 'approve' });
        expect(sent.forms[0].fields.seriesTouched).toBeUndefined();
    });

    it('send the decorative flag instead of text', async () => {
        renderInbox();
        fireEvent.click(screen.getByRole('checkbox', { name: /Decorative/ }));
        await press(screen.getByRole('button', { name: 'Review series suggestion' }));
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
        await press(screen.getByRole('button', { name: 'Review series suggestion' }));
        expect(await screen.findByText(/can’t hold markup/)).toBeInTheDocument();
        expect(series().value).toBe('ser_draft');
        sent.answer = null;
        fireEvent.change(screen.getByRole('textbox', { name: 'Draft description' }), { target: { value: 'Fixed.' } });
        await press(screen.getByRole('button', { name: 'Review series suggestion' }));
        expect(sent.forms[1].fields.series).toBe(series().value);
    });

    it('send "Leave unassigned" when it is the shown default, as it is with no rules file', async () => {
        renderInbox(view({ selected: detail({ suggestions: { series: { value: null, confidence: 'low', producedBy: 'rules@none', producedAt: '2026-02-01T00:00:00.000Z', evidence: [] }, placement: null } }) }));
        expect(screen.getByRole('combobox', { name: 'Suggested series' })).toHaveValue('unassigned');
        await press(screen.getByRole('button', { name: 'Review series suggestion' }));
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
        await press(screen.getByRole('button', { name: 'Review series suggestion' }));
        expect(sent.forms[0].fields).toMatchObject({ series: 'ser_harbor', decorative: 'off', descriptionWas: 'decorative', description: '' });
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
        await press(screen.getByRole('button', { name: 'Review series suggestion' }));
        expect(await screen.findByText(/changed since the page loaded/)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Refresh and review again' })).toHaveAttribute('href', `/curation/inbox?item=${EVT(1)}`);
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
        expect(screen.queryByRole('button', { name: 'Review series suggestion' })).toBeNull();
        await press(screen.getByRole('button', { name: 'Reopen' }));
        expect(sent.forms[1].fields).toMatchObject({ intent: 'reopen', version: '3' });
    });
});
