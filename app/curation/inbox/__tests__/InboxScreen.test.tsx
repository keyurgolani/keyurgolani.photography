import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BULK_IDLE, type InboxActionState, type InboxBulkState, type InboxDetail, type InboxItem, type InboxView, type ReadyInboxSummary, type SeriesOption } from '@/lib/curation/inbox-view';
import { INBOX_WATCH_INTERVAL_MS } from '@/lib/curation/inbox-watch';

// #14's A8 on the Inbox's pieces: the filters, paging and age labels, the bulk actions and their error summary, an
// item's error summary, the stale alert that keeps unsaved edits, and the poll with its offline state. The server
// actions are stood in for, as in InboxView.test.tsx; what they do is lib/curation/__tests__/inboxScreen.test.ts's.

const sent = vi.hoisted(() => ({
    forms: [] as { action: string; fields: [string, string][] }[],
    answer: null as InboxActionState | null,
    bulk: null as InboxBulkState | null,
}));

vi.mock('../actions', () => {
    const make = (action: string) => async (_previous: InboxActionState, form: FormData): Promise<InboxActionState> => {
        sent.forms.push({ action, fields: [...form.entries()].map(([name, value]) => [name, String(value)]) });
        return sent.answer ?? { status: 'done', action: action as 'approve', eventId: String(form.get('eventId')), message: 'Done.', serial: sent.forms.length };
    };
    return {
        approveItem: make('approve'),
        editItem: make('edit'),
        deferItem: make('defer'),
        dismissItem: make('dismiss'),
        retryItem: make('retry'),
        reopenItem: make('reopen'),
        confirmItem: make('confirm'),
        bindItem: make('bind'),
        archiveItem: make('archive'),
        bulkItems: async (_previous: InboxBulkState, form: FormData): Promise<InboxBulkState> => {
            sent.forms.push({ action: 'bulk', fields: [...form.entries()].map(([name, value]) => [name, String(value)]) });
            return sent.bulk ?? BULK_IDLE;
        },
    };
});

const { default: InboxList } = await import('../InboxList');
const { default: InboxDetailView } = await import('../InboxDetailView');
const { default: InboxWatch } = await import('../InboxWatch');

if (typeof Element.prototype.scrollIntoView !== 'function') Element.prototype.scrollIntoView = () => undefined;
window.scrollTo = (() => undefined) as typeof window.scrollTo;

beforeEach(() => {
    sent.forms = [];
    sent.answer = null;
    sent.bulk = null;
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/');
});

const P = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const EVT = (n: number) => `evt_${String(n).padStart(24, '0')}`;
const REV = `sha256-${'a'.repeat(64)}`;
const ACTIVE = `rev_${'b'.repeat(64)}`;
const READ_AT = '2026-02-01T03:00:00.000Z';
const SERIES: SeriesOption[] = [{ id: 'ser_harbor', label: 'Harbor', visibility: 'published', members: [] }];

function item(n: number, overrides: Partial<InboxItem> = {}): InboxItem {
    return { id: EVT(n), version: 2, type: 'new', status: 'open', group: 'judgment', title: 'Uncurated photograph', photoId: P(n), shortId: `ph_0000…${String(n).padStart(4, '0')}`, sourcePath: `trips/photo-${n}.jpg`, thumbnailUrl: null, waiting: null, placedBy: null, unplacedSeries: null, observedAt: '2026-02-01T00:00:00.000Z', ...overrides };
}

function detail(overrides: Partial<InboxDetail> = {}): InboxDetail {
    return {
        ...item(1),
        assetRevision: REV,
        lastObservedAt: '2026-02-01T00:00:00.000Z',
        capturedDate: null,
        fromPath: null,
        identity: 'Source present',
        derivatives: 'p_1 ready',
        previewUrl: null,
        facts: [],
        failure: null,
        failureCode: null,
        candidates: [],
        references: [],
        suggestions: { series: null, placement: null },
        edits: null,
        placed: null,
        lastApprovedSeries: null,
        decisions: [],
        reviewedAt: null,
        reviewedBy: null,
        can: { approve: true, edit: true, defer: true, dismiss: true, retry: false, reopen: false, confirm: false, bind: false, archive: false },
        primaryUnavailable: null,
        confirmUnavailable: null,
        linkedFiles: [],
        replacement: null,
        resolvedBy: null,
        bindWaiting: null,
        ...overrides,
    };
}

type Ready = Extract<InboxView, { state: 'ready' }>;
function view(overrides: Partial<Ready> = {}): Ready {
    const items = overrides.items ?? [item(1), item(2)];
    return { state: 'ready', watcher: { state: 'running' }, readAt: READ_AT, activeRevisionId: ACTIVE, needsJudgment: items.length, waiting: 0, placed: 0, unplaced: 0, placementUnknown: false, items, problems: [], series: SERIES, seriesProblem: null, selected: detail(), missingSelection: null, ...overrides };
}

const ANY = { status: null, type: null, page: 1 } as const;

async function press(button: HTMLElement) {
    await act(async () => {
        fireEvent.click(button);
    });
}

describe('the filters, paging and age labels', () => {
    it('filter by Status and Type with a plain GET form, the Type list built from every event type', () => {
        render(<InboxList view={view()} query={ANY} />);
        const form = screen.getByRole('search', { name: 'Filter the inbox' });
        expect(form).toHaveAttribute('method', 'get');
        expect(form).toHaveAttribute('action', '/curation/inbox');
        const type = within(form).getByRole('combobox', { name: 'Type' });
        const types = within(type).getAllByRole('option').map((option) => option.textContent);
        expect(types).toEqual(['Any type', 'New photograph', 'Replacement', 'Missing source', 'Source reappeared', 'Ambiguous match', 'Processing failure', 'Library unavailable']);
        const status = within(form).getByRole('combobox', { name: 'Status' });
        expect(within(status).getAllByRole('option')).toHaveLength(7);
        expect(within(form).getByRole('button', { name: 'Apply filters' })).toHaveAttribute('type', 'submit');
        expect(screen.queryByRole('link', { name: 'Clear filters' })).toBeNull();
    });

    it('show the filters in force, a way to clear them, and keep them on every row link and on Refresh', () => {
        const query = { status: 'open' as const, type: 'new' as const, page: 1 };
        render(<InboxList view={view()} query={query} />);
        expect(screen.getByRole('combobox', { name: 'Type' })).toHaveValue('new');
        expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('open');
        expect(screen.getByRole('link', { name: 'Clear filters' })).toHaveAttribute('href', '/curation/inbox');
        expect(screen.getByRole('link', { name: /photo-1\.jpg/ })).toHaveAttribute('href', `/curation/inbox?status=open&type=new&item=${EVT(1)}#item`);
        const refresh = screen.getByRole('button', { name: 'Refresh inbox' }).closest('form') as HTMLFormElement;
        expect(Object.fromEntries(new FormData(refresh))).toMatchObject({ status: 'open', type: 'new' });
    });

    it('page 50 items at a time, with Previous and Next page links that keep the filters', () => {
        const items = Array.from({ length: 120 }, (_, index) => item(index + 1));
        render(<InboxList view={view({ items, selected: null })} query={{ status: null, type: 'new', page: 2 }} />);
        expect(screen.getAllByRole('link', { name: /photo-\d+\.jpg/ })).toHaveLength(50);
        expect(screen.getByText('Showing 51 to 100 of 120 items')).toBeInTheDocument();
        const pager = screen.getByRole('navigation', { name: 'Inbox pages' });
        expect(within(pager).getByRole('link', { name: 'Previous page' })).toHaveAttribute('href', '/curation/inbox?type=new');
        expect(within(pager).getByRole('link', { name: 'Next page' })).toHaveAttribute('href', '/curation/inbox?type=new&page=3');
        expect(within(pager).getByText('Page 2 of 3')).toBeInTheDocument();
    });

    it('say when nothing matches the filters, apart from an empty inbox', () => {
        render(<InboxList view={view({ selected: null })} query={{ status: 'resolved', type: null, page: 1 }} />);
        expect(screen.getByText('No item matches these filters.')).toBeInTheDocument();
        expect(screen.queryByRole('navigation', { name: 'Inbox pages' })).toBeNull();
    });

    it('label each row with how long ago it opened, from the time the page read the inbox', () => {
        render(<InboxList view={view({ items: [item(1), item(2, { observedAt: '2026-01-20T00:00:00.000Z' })] })} query={ANY} />);
        const rows = screen.getAllByRole('link', { name: /photo-\d\.jpg/ });
        expect(within(rows[0]).getByText('Opened 3 h ago')).toBeInTheDocument();
        expect(within(rows[1]).getByText('Opened 12 days ago').closest('time')).toHaveAttribute('dateTime', '2026-01-20T00:00:00.000Z');
    });

    it('list the library-unavailable item by the library, and show it in full', () => {
        const library = item(7, { type: 'library-unavailable', title: 'Library unavailable', photoId: null, shortId: 'no photo ID', sourcePath: '.' });
        const v = view({ items: [library], selected: detail({ ...library, facts: [{ label: 'Cause', value: 'The library root is missing' }], can: { approve: false, edit: true, defer: true, dismiss: true, retry: false, reopen: false, confirm: false, bind: false, archive: false } }) });
        render(
            <main>
                <InboxList view={v} query={{ status: null, type: 'library-unavailable', page: 1 }} />
                <InboxDetailView view={v} />
            </main>,
        );
        expect(screen.getByRole('link', { name: /The photo library/ })).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 2, name: 'The photo library' })).toBeInTheDocument();
        expect(screen.getByText('The library root is missing')).toBeInTheDocument();
    });
});

describe('the bulk actions', () => {
    const three = () => [item(1), item(2, { version: 5 }), item(3, { type: 'missing', title: 'Source file missing', sourcePath: 'trips/gone.jpg' }), item(4, { status: 'approved', group: 'settled' })];

    it('put a checkbox on each row a bulk action can take, named for the row, and none on a settled one', () => {
        render(<InboxList view={view({ items: three() })} query={ANY} />);
        const boxes = screen.getAllByRole('checkbox');
        expect(boxes.map((box) => box.getAttribute('aria-label') ?? box.closest('label')?.textContent)).toEqual(['Select photo-1.jpg', 'Select photo-2.jpg', 'Select gone.jpg']);
        expect(boxes.map((box) => (box as HTMLInputElement).value)).toEqual([`${EVT(1)}:2`, `${EVT(2)}:5`, `${EVT(3)}:2`]);
        expect(screen.getByRole('button', { name: 'Decide later on selected' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Leave selected unassigned' })).toHaveAccessibleDescription(/approves each selected new photograph into the draft with no series/i);
        // No checkbox inside a row's link: no nested interactive elements.
        for (const box of boxes) expect(box.closest('a')).toBeNull();
    });

    it('send one version per checked item, the active revision, and which action', async () => {
        render(<InboxList view={view({ items: three() })} query={ANY} />);
        fireEvent.click(screen.getByRole('checkbox', { name: 'Select photo-1.jpg' }));
        fireEvent.click(screen.getByRole('checkbox', { name: 'Select photo-2.jpg' }));
        await press(screen.getByRole('button', { name: 'Decide later on selected' }));
        expect(sent.forms).toEqual([{ action: 'bulk', fields: expect.arrayContaining([['base', ACTIVE], ['items', `${EVT(1)}:2`], ['items', `${EVT(2)}:5`], ['intent', 'defer']]) }]);
        expect(sent.forms[0].fields.filter(([name]) => name === 'items')).toHaveLength(2);
    });

    it('say a finished bulk action once in a polite region, and list each item it left alone in an error summary that links it and takes focus', async () => {
        sent.bulk = {
            status: 'partial',
            kind: 'defer',
            message: 'Left 1 of 2 items for later. 1 was left as it is.',
            results: [
                { eventId: EVT(1), status: 'done', message: 'Left for later.' },
                { eventId: EVT(2), status: 'stale', message: 'This item changed since the page loaded, so nothing was written. Refresh and review it again.' },
            ],
            serial: 1,
        };
        render(<InboxList view={view({ items: three() })} query={ANY} />);
        fireEvent.click(screen.getByRole('checkbox', { name: 'Select photo-1.jpg' }));
        fireEvent.click(screen.getByRole('checkbox', { name: 'Select photo-2.jpg' }));
        await press(screen.getByRole('button', { name: 'Decide later on selected' }));
        const region = screen.getByRole('status', { name: 'Bulk answer' });
        expect(region).toHaveTextContent('Left 1 of 2 items for later. 1 was left as it is.');
        const summary = screen.getByRole('region', { name: '1 item was left as it is' });
        expect(summary).toHaveFocus();
        expect(within(summary).getByRole('link', { name: /photo-2\.jpg/ })).toHaveAttribute('href', `/curation/inbox?item=${EVT(2)}#item`);
        expect(within(summary).getByText(/changed since the page loaded/)).toBeInTheDocument();
        // Said once: the summary isn't inside the live region, and the region doesn't repeat the summary.
        expect(region.contains(summary)).toBe(false);
        expect(region).not.toHaveTextContent('changed since the page loaded');
    });

    it('link the checkboxes from the summary when nothing was selected', async () => {
        sent.bulk = { status: 'invalid', kind: 'defer', message: 'Select at least one item first. Nothing was written.', field: 'items', results: [], serial: 1 };
        render(<InboxList view={view({ items: three() })} query={ANY} />);
        await press(screen.getByRole('button', { name: 'Decide later on selected' }));
        const summary = screen.getByRole('region', { name: 'Select at least one item first. Nothing was written.' });
        const link = within(summary).getByRole('link', { name: 'The items to select' });
        await press(link);
        expect(screen.getByRole('checkbox', { name: 'Select photo-1.jpg' })).toHaveFocus();
    });
});

describe("an item's answers", () => {
    const renderItem = (d = detail()) => {
        const v = view({ selected: d });
        return render(
            <main>
                <InboxList view={v} query={ANY} />
                <InboxDetailView view={v} />
            </main>,
        );
    };

    it('show a refused submit as one error summary that links the item', async () => {
        sent.answer = { status: 'refused', action: 'approve', eventId: EVT(1), message: "This photograph is already in a series, and approving doesn't take it out of one. Nothing was written.", serial: 1 };
        renderItem();
        await press(screen.getByRole('button', { name: 'Approve into draft' }));
        const summary = screen.getByRole('region', { name: /already in a series/ });
        expect(within(summary).getByRole('link', { name: 'Item: photo-1.jpg' })).toHaveAttribute('href', '#item-heading');
        expect(screen.getAllByText(/already in a series/)).toHaveLength(1);
    });

    it('link the field a refusal is about from the summary, which takes it to the field', async () => {
        sent.answer = { status: 'invalid', action: 'approve', eventId: EVT(1), message: "The description can’t hold markup.", field: 'description', serial: 1 };
        renderItem();
        await press(screen.getByRole('button', { name: 'Approve into draft' }));
        const summary = screen.getByRole('region', { name: 'There is a problem with this item' });
        expect(within(summary).getByRole('link', { name: 'Item: photo-1.jpg' })).toBeInTheDocument();
        const toField = within(summary).getByRole('link', { name: 'Draft description' });
        expect(toField).toHaveAttribute('href', '#item-description');
        // The field takes focus and reads its own error, so the summary is no live region: it's said once.
        expect(summary.closest('[aria-live]')).toBeNull();
        fireEvent.blur(screen.getByRole('textbox', { name: 'Draft description' }));
        await press(toField);
        expect(screen.getByRole('textbox', { name: 'Draft description' })).toHaveFocus();
    });

    it('show a stale answer as an alert, outside the polite region, that says the unsaved edits are kept', async () => {
        sent.answer = { status: 'stale', action: 'approve', eventId: EVT(1), message: 'This item changed since the page loaded, so nothing was written. Refresh and review it again.', serial: 1 };
        renderItem();
        fireEvent.change(screen.getByRole('textbox', { name: 'Draft description' }), { target: { value: 'Typed, not saved.' } });
        await press(screen.getByRole('button', { name: 'Approve into draft' }));
        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent('changed since the page loaded');
        expect(alert).toHaveTextContent('Your edits are still in the form');
        expect(alert.closest('[aria-live="polite"]')).toBeNull();
        expect(within(alert).getByRole('link', { name: 'Refresh and review again' })).toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: 'Draft description' })).toHaveValue('Typed, not saved.');
    });

    it('raise the same alert when the poll sees the open item change, and keep what was typed', async () => {
        renderItem();
        fireEvent.change(screen.getByRole('textbox', { name: 'Draft description' }), { target: { value: 'Still typing.' } });
        await act(async () => {
            window.dispatchEvent(new CustomEvent('curation-inbox:item-changed', { detail: { id: EVT(2) } }));
        });
        expect(screen.queryByRole('alert')).toBeNull();
        await act(async () => {
            window.dispatchEvent(new CustomEvent('curation-inbox:item-changed', { detail: { id: EVT(1) } }));
        });
        expect(screen.getByRole('alert')).toHaveTextContent(/changed since the page loaded.*Your edits are still in the form/);
        expect(screen.getByRole('textbox', { name: 'Draft description' })).toHaveValue('Still typing.');
    });
});

describe('the poll', () => {
    const summary = (overrides: Partial<ReadyInboxSummary> = {}): ReadyInboxSummary => ({ state: 'ready', readAt: READ_AT, needsJudgment: 2, waiting: 0, placed: 0, unplaced: 0, total: 2, unreadable: 0, watcher: { state: 'running' }, item: { id: EVT(1), version: 2, status: 'open' }, ...overrides });
    let fetcher: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        fetcher = vi.fn(async () => ({ status: 200, ok: true, type: 'basic', json: async () => summary() }) as Response);
        vi.stubGlobal('fetch', fetcher);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    const tick = async (ms: number) => {
        await act(async () => {
            await vi.advanceTimersByTimeAsync(ms);
        });
    };

    it('asks again every 60 s, and says new items once in its polite region, with a way to refresh', async () => {
        render(<InboxWatch watcher={{ state: 'running' }} needsJudgment={2} item={{ id: EVT(1), version: 2 }} />);
        expect(fetcher).not.toHaveBeenCalled();
        fetcher.mockImplementation(async () => ({ status: 200, ok: true, type: 'basic', json: async () => summary({ needsJudgment: 4 }) }) as Response);
        await tick(INBOX_WATCH_INTERVAL_MS);
        expect(fetcher).toHaveBeenCalledTimes(1);
        const region = screen.getByRole('status', { name: 'Inbox updates' });
        expect(region).toHaveTextContent('2 new items need judgment. Refresh the inbox to see them.');
        expect(within(region).getByRole('link', { name: 'Refresh the inbox' })).toBeInTheDocument();
        await tick(INBOX_WATCH_INTERVAL_MS);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(region).toHaveTextContent('2 new items need judgment.');
    });

    it('shows the watcher strip when the watcher stops checking in while the page is open', async () => {
        render(<InboxWatch watcher={{ state: 'running' }} needsJudgment={2} item={null} />);
        expect(screen.queryByRole('region', { name: 'Watcher' })).toBeNull();
        fetcher.mockImplementation(async () => ({ status: 200, ok: true, type: 'basic', json: async () => summary({ watcher: { state: 'missing' }, item: null }) }) as Response);
        await tick(INBOX_WATCH_INTERVAL_MS);
        expect(screen.getByRole('region', { name: 'Watcher' })).toBeInTheDocument();
        expect(screen.getByRole('status', { name: 'Inbox updates' })).toHaveTextContent(/watcher stopped checking in/);
    });

    it('tells the open item when it changed, for its alert', async () => {
        const heard = vi.fn();
        window.addEventListener('curation-inbox:item-changed', heard);
        try {
            render(<InboxWatch watcher={{ state: 'running' }} needsJudgment={2} item={{ id: EVT(1), version: 2 }} />);
            fetcher.mockImplementation(async () => ({ status: 200, ok: true, type: 'basic', json: async () => summary({ item: { id: EVT(1), version: 3, status: 'deferred' } }) }) as Response);
            await tick(INBOX_WATCH_INTERVAL_MS);
            await tick(INBOX_WATCH_INTERVAL_MS);
            expect(heard).toHaveBeenCalledTimes(1);
            expect((heard.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: EVT(1) });
        } finally {
            window.removeEventListener('curation-inbox:item-changed', heard);
        }
    });

    it('shows an offline state when the browser goes offline or the server cannot be reached, and clears it once back', async () => {
        render(<InboxWatch watcher={{ state: 'running' }} needsJudgment={2} item={null} />);
        await act(async () => {
            window.dispatchEvent(new Event('offline'));
        });
        const offline = screen.getByRole('region', { name: 'Offline' });
        expect(offline).toHaveTextContent(/can't check for changes/);
        expect(screen.getByRole('status', { name: 'Inbox updates' })).toHaveTextContent(/^You're offline/);
        await act(async () => {
            window.dispatchEvent(new Event('online'));
        });
        await tick(0);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('region', { name: 'Offline' })).toBeNull();
        expect(screen.getByRole('status', { name: 'Inbox updates' })).toHaveTextContent('Back online.');
        fetcher.mockImplementation(async () => Promise.reject(new TypeError('Failed to fetch')));
        await tick(INBOX_WATCH_INTERVAL_MS);
        expect(screen.getByRole('region', { name: 'Offline' })).toBeInTheDocument();
    });

    it('stops quietly once the session is gone, and never asks again', async () => {
        fetcher.mockImplementation(async () => ({ status: 401, ok: false, type: 'basic', json: async () => ({}) }) as Response);
        render(<InboxWatch watcher={{ state: 'running' }} needsJudgment={2} item={null} />);
        await tick(INBOX_WATCH_INTERVAL_MS);
        await tick(10 * INBOX_WATCH_INTERVAL_MS);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('status', { name: 'Inbox updates' })).toHaveTextContent('');
        expect(screen.queryByRole('region', { name: 'Offline' })).toBeNull();
    });

    it('waits while the tab is hidden, and checks on coming back', async () => {
        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        try {
            render(<InboxWatch watcher={{ state: 'running' }} needsJudgment={2} item={null} />);
            await tick(5 * INBOX_WATCH_INTERVAL_MS);
            expect(fetcher).not.toHaveBeenCalled();
            hidden.mockReturnValue(false);
            await act(async () => {
                document.dispatchEvent(new Event('visibilitychange'));
            });
            await tick(0);
            expect(fetcher).toHaveBeenCalledTimes(1);
        } finally {
            hidden.mockRestore();
        }
    });
});
