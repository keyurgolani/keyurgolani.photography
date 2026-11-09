import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BULK_IDLE, type InboxActionState, type InboxBulkState, type InboxDetail, type InboxItem, type InboxView, type ReadyInboxSummary, type SeriesOption } from '@/lib/curation/inbox-view';
import { INBOX_WATCH_INTERVAL_MS, INBOX_WATCH_ONLINE_GAP_MS, OFFLINE_TEXT } from '@/lib/curation/inbox-watch';
import { SUBMIT_GATE_SCRIPT } from '@/components/site/submitGateScript';

// #14's A8 on the Inbox's pieces: the filters, paging and age labels, the bulk actions and their error summary, an
// item's error summary, the stale alert that keeps unsaved edits, and the poll with its offline state. The server
// actions are stood in for, as in InboxView.test.tsx; what they do is lib/curation/__tests__/inboxScreen.test.ts's.

const sent = vi.hoisted(() => ({
    forms: [] as { action: string; fields: [string, string][] }[],
    answer: null as InboxActionState | null,
    bulk: null as InboxBulkState | null,
    hold: null as Promise<void> | null,
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
        restoreItem: make('restore'),
        releaseItem: make('release'),
        bulkItems: async (_previous: InboxBulkState, form: FormData): Promise<InboxBulkState> => {
            sent.forms.push({ action: 'bulk', fields: [...form.entries()].map(([name, value]) => [name, String(value)]) });
            if (sent.hold) await sent.hold;
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
    sent.hold = null;
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
    return { id: EVT(n), version: 2, type: 'new', status: 'open', group: 'judgment', title: 'Uncurated photograph', photoId: P(n), shortId: `ph_0000…${String(n).padStart(4, '0')}`, sourcePath: `trips/photo-${n}.jpg`, thumbnailUrl: null, waiting: null, placedBy: null, unplacedSeries: null, observedAt: '2026-02-01T00:00:00.000Z', seriesChosen: false, held: false, ...overrides };
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
        suggestedFiles: [],
        restores: null,
        release: false,
        ...overrides,
    };
}

type Ready = Extract<InboxView, { state: 'ready' }>;
function view(overrides: Partial<Ready> = {}): Ready {
    const items = overrides.items ?? [item(1), item(2)];
    return { state: 'ready', watcher: { state: 'running' }, readAt: READ_AT, cursor: 0, activeRevisionId: ACTIVE, needsJudgment: items.length, held: 0, library: null, waiting: 0, placed: 0, unplaced: 0, placementUnknown: false, items, problems: [], series: SERIES, seriesProblem: null, selected: detail(), missingSelection: null, ...overrides };
}

const ANY = { status: null, type: null, page: 1 } as const;

/** Every form that sends an action: one with an intent button, and Archive's, whose first step has none. */
const actionForms = (root: ParentNode) => [...root.querySelectorAll('form')].filter((form) => form.querySelector('button[name="intent"], #archive-reason'));
/** What's disabled, by what it is, so the server's markup and the mounted page can be compared. */
const disabledSet = (root: ParentNode) =>
    [...root.querySelectorAll('[disabled]')].map((el) => `${el.localName}${el.getAttribute('name') ? ` ${el.getAttribute('name')}` : ''}${el.getAttribute('value') ? `=${el.getAttribute('value')}` : ''} ${(el.textContent ?? '').trim().slice(0, 30)}`);

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
        // Any status, the six stored ones, and #17's Held.
        expect(within(status).getAllByRole('option')).toHaveLength(8);
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

    it('put a checkbox on each row a bulk action can take, named for the row, and none on a settled one, a missing source (S1) or a saved series it would drop (S2)', () => {
        render(<InboxList view={view({ items: [...three(), item(5, { seriesChosen: true, status: 'deferred', group: 'deferred' })] })} query={ANY} />);
        const boxes = screen.getAllByRole('checkbox');
        expect(boxes.map((box) => box.getAttribute('aria-label') ?? box.closest('label')?.textContent)).toEqual(['Select photo-1.jpg', 'Select photo-2.jpg']);
        expect(boxes.map((box) => (box as HTMLInputElement).value)).toEqual([`${EVT(1)}:2`, `${EVT(2)}:5`]);
        expect(screen.getByRole('button', { name: 'Decide later on selected' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Leave selected unassigned' })).toHaveAccessibleDescription(/approves each selected new photograph into the draft with no series/i);
        // No checkbox inside a row's link: no nested interactive elements.
        for (const box of boxes) expect(box.closest('a')).toBeNull();
    });

    it("keep the rows where next has them, in the list's own lists, with each checkbox in the bulk form by its form attribute (A8's CI, Dark parity)", () => {
        const { container } = render(<InboxList view={view({ items: three() })} query={ANY} />);
        const list = container.querySelector('#inbox-list') as HTMLElement;
        const bulk = screen.getByRole('form', { name: 'Bulk actions' }) as HTMLFormElement;
        // next's rows: a ul of the list's own, or of a group's, and never inside a form.
        const rows = [...list.querySelectorAll('a[data-row]')];
        expect(rows).toHaveLength(4);
        expect(list.querySelectorAll(':scope > ul > li > a[data-row], :scope > div > ul > li > a[data-row]')).toHaveLength(4);
        for (const row of rows) expect(row.closest('form')).toBeNull();
        for (const box of screen.getAllByRole('checkbox') as HTMLInputElement[]) {
            expect(box.closest('form')).toBeNull();
            expect(box.form).toBe(bulk);
        }
        // The form, with its buttons and answers, sits above the rows it acts on.
        expect(bulk.compareDocumentPosition(rows[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
            message: 'Left 1 of 2 items for later.',
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
        // Said once (N1): what was left is the summary's alone.
        expect(region).toHaveTextContent(/^Left 1 of 2 items for later\.$/);
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

describe('the bulk answers (A8 review)', () => {
    it('list in the polite region each item that went through with an answer of its own (S1)', async () => {
        sent.bulk = {
            status: 'done',
            kind: 'unassigned',
            message: 'Approved 2 new photographs into the draft, unassigned. Nothing is published until you publish.',
            results: [
                { eventId: EVT(1), status: 'done', message: 'Approved into the draft. Nothing is published until you publish.' },
                { eventId: EVT(2), status: 'done', message: 'Approved into the draft. Nothing is published until you publish. It has no description yet, so publishing it waits until one is added and reviewed.', note: true },
            ],
            serial: 1,
        };
        render(<InboxList view={view()} query={ANY} />);
        fireEvent.click(screen.getByRole('checkbox', { name: 'Select photo-1.jpg' }));
        await press(screen.getByRole('button', { name: 'Leave selected unassigned' }));
        const region = screen.getByRole('status', { name: 'Bulk answer' });
        const noted = within(region).getByRole('link', { name: 'photo-2.jpg' });
        expect(noted).toHaveAttribute('href', `/curation/inbox?item=${EVT(2)}#item`);
        expect(within(region).getByText(/no description yet/)).toBeInTheDocument();
        expect(within(region).queryByRole('link', { name: 'photo-1.jpg' })).toBeNull();
        expect(screen.queryByRole('region', { name: /left as/ })).toBeNull();
    });

    it('never disable anything for the submit gate: the bulk form waits at it in the server HTML, its buttons and the row checkboxes enabled, and nothing else disabled than once mounted', () => {
        const html = document.createElement('div');
        html.innerHTML = renderToString(<InboxList view={view()} query={ANY} />);
        const form = html.querySelector('#inbox-bulk') as HTMLFormElement;
        const buttons = [...form.querySelectorAll('button[name="intent"]')] as HTMLButtonElement[];
        expect(buttons.map((button) => button.value)).toEqual(['defer', 'unassigned']);
        // Without JavaScript nothing gates, so nothing is disabled for want of it; with it, the head's script drops a
        // press until the form says it's ready.
        for (const button of buttons) expect(button).toBeEnabled();
        const boxes = [...html.querySelectorAll('input[type="checkbox"][form="inbox-bulk"]')];
        expect(boxes.length).toBeGreaterThan(0);
        for (const box of boxes) expect(box).toBeEnabled();
        expect(form).toHaveAttribute('data-submit-gate', 'waiting');
        const { container, unmount } = render(<InboxList view={view()} query={ANY} />);
        expect(disabledSet(html)).toEqual(disabledSet(container));
        unmount();
    });

    it('mark the bulk form ready once it has mounted, with its buttons enabled', () => {
        render(<InboxList view={view()} query={ANY} />);
        expect(document.getElementById('inbox-bulk')).toHaveAttribute('data-submit-gate', 'ready');
        expect(screen.getByRole('button', { name: 'Decide later on selected' })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Leave selected unassigned' })).toBeEnabled();
    });

    it('keep a pressed bulk button enabled and focused while its action is out, aria-disabled only', async () => {
        let release = () => undefined as void;
        sent.hold = new Promise<void>((done) => {
            release = done;
        });
        render(<InboxList view={view()} query={ANY} />);
        const button = screen.getByRole('button', { name: 'Decide later on selected' });
        try {
            button.focus();
            await press(button);
            expect(button).toHaveAttribute('aria-disabled', 'true');
            expect(button).toBeEnabled();
            expect(button).toHaveFocus();
        } finally {
            await act(async () => {
                release();
            });
        }
        expect(button).not.toHaveAttribute('aria-disabled');
    });

    it("send nothing for a submit no bulk button made, as Enter in a checkbox does (N5)", async () => {
        render(<InboxList view={view()} query={ANY} />);
        await act(async () => {
            fireEvent.submit(document.getElementById('inbox-bulk') as HTMLFormElement);
        });
        expect(sent.forms).toEqual([]);
    });
});

describe('a change by script before the page is ready', () => {
    // The head's script holds typing, ticks and select keys until a form is ready, but a script can still set a value
    // (selectOption, el.value =). Hydration and the re-render once each form is ready write React's state back to
    // every controlled field, so what the screen shows is what the form sends: the server's state, not the script's.
    const fields = (form: HTMLFormElement) => [...new FormData(form).entries()].map(([name, value]) => [name, String(value)]).sort();
    async function hydrateAfter(d: InboxDetail, change: (holder: HTMLElement) => void) {
        const tree = <InboxDetailView view={view({ selected: d })} />;
        const pristine = document.createElement('div');
        pristine.innerHTML = renderToString(tree);
        const holder = document.createElement('div');
        document.body.append(holder);
        holder.innerHTML = renderToString(tree);
        change(holder);
        const errors: unknown[] = [];
        let root: Root | undefined;
        await act(async () => {
            root = hydrateRoot(holder, tree, { onRecoverableError: (error) => errors.push(error) });
        });
        return {
            pristine,
            holder,
            errors,
            unmount: async () => {
                await act(async () => root?.unmount());
                holder.remove();
            },
        };
    }
    const review = (root: ParentNode) => root.querySelector('form[aria-label="Review"]') as HTMLFormElement;

    it("shows and sends the server's state once ready, after a script set the series, the description and Decorative", async () => {
        const { pristine, holder, errors, unmount } = await hydrateAfter(detail(), (root) => {
            const form = review(root);
            const select = form.querySelector('select') as HTMLSelectElement;
            select.value = [...select.options].find((option) => option.value !== select.value)!.value;
            (form.querySelector('textarea') as HTMLTextAreaElement).value = 'Set by a script before the page was ready.';
            const decorative = within(form).getByRole('checkbox', { name: /Decorative/ }) as HTMLInputElement;
            decorative.checked = !decorative.checked;
        });
        try {
            expect(errors).toEqual([]);
            const shown = review(holder);
            const was = review(pristine);
            expect((shown.querySelector('select') as HTMLSelectElement).value).toBe((was.querySelector('select') as HTMLSelectElement).value);
            expect((shown.querySelector('textarea') as HTMLTextAreaElement).value).toBe((was.querySelector('textarea') as HTMLTextAreaElement).value);
            expect((within(shown).getByRole('checkbox', { name: /Decorative/ }) as HTMLInputElement).checked).toBe((within(was).getByRole('checkbox', { name: /Decorative/ }) as HTMLInputElement).checked);
            expect(fields(shown)).toEqual(fields(was));
            await press(within(shown).getByRole('button', { name: 'Save edits' }));
            expect(sent.forms).toHaveLength(1);
            expect(sent.forms[0].fields.filter(([name]) => name !== 'intent').sort()).toEqual(fields(was));
        } finally {
            await unmount();
        }
    });

    it('keeps a saved description when a script edits it before the page is ready', async () => {
        const saved = 'A harbour wall at low tide.';
        const { holder, errors, unmount } = await hydrateAfter(detail({ edits: { description: { kind: 'described', text: saved } } as InboxDetail['edits'] }), (root) => {
            const area = review(root).querySelector('textarea') as HTMLTextAreaElement;
            expect(area.value).toBe(saved);
            area.value = 'Overwritten before the page was ready.';
        });
        try {
            expect(errors).toEqual([]);
            expect((review(holder).querySelector('textarea') as HTMLTextAreaElement).value).toBe(saved);
            expect(fields(review(holder))).toContainEqual(['description', saved]);
        } finally {
            await unmount();
        }
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

    // Every item form posts by hand, so the head's script drops a press until the form has mounted. Nothing is disabled
    // for it, so with no JavaScript, where nothing gates, the server's markup is all there is.
    const everyForm = () => detail({ can: { approve: true, edit: true, defer: true, dismiss: true, retry: true, reopen: true, confirm: false, bind: true, archive: true } });
    const replacement = () => detail({ type: 'replacement', title: 'Replacement ready', can: { approve: false, edit: false, defer: true, dismiss: false, retry: false, reopen: false, confirm: true, bind: false, archive: false }, primaryUnavailable: null });
    const submits = (root: ParentNode) => [...root.querySelectorAll('form button[type="submit"]')] as HTMLButtonElement[];

    it('never disable anything for the submit gate: what the server disables is what the mounted page does for the same state, and the controls the gate covers are enabled', () => {
        for (const [d, intents] of [
            [everyForm(), ['edit', 'defer', 'approve', 'retry', 'reopen', 'bind', 'dismiss']],
            [replacement(), ['defer', 'confirm']],
        ] as const) {
            const html = document.createElement('div');
            html.innerHTML = renderToString(<InboxDetailView view={view({ selected: d })} />);
            const forms = actionForms(html);
            expect(forms.length).toBeGreaterThan(0);
            for (const form of forms) expect(form).toHaveAttribute('data-submit-gate', 'waiting');
            // The controls the gate covers, in their enabled state: its submit buttons and Archive's reason.
            const covered = forms.flatMap((form) => [...form.querySelectorAll<HTMLButtonElement>('button[name="intent"]')]);
            expect(covered.map((button) => button.value)).toEqual(intents);
            for (const button of covered) expect(button).toBeEnabled();
            if (d.can.archive) expect(html.querySelector('#archive-reason')).toBeEnabled();
            // Anything else the server disables is the item's own state (a position with no series, the description when
            // Decorative, an action it can't take yet), and the mounted page disables the same.
            const { container, unmount } = render(<InboxDetailView view={view({ selected: d })} />);
            expect(disabledSet(html)).toEqual(disabledSet(container));
            unmount();
        }
    });

    it('take a press at once in the forms the client mounts after an answer, as the next item after Decide later, never waiting at the gate', async () => {
        // The head's script, as the page runs it, so a form that waited would drop the press.
        new Function(SUBMIT_GATE_SCRIPT)();
        const all = { approve: true, edit: true, defer: true, dismiss: true, retry: true, reopen: true, confirm: false, bind: true, archive: true };
        const first = detail({ can: all });
        const next = detail({ ...item(2), can: all });
        const { container, rerender } = render(<InboxDetailView view={view({ selected: first })} />);
        const before = container.querySelector('form[aria-label="Review"]');
        const flips = new MutationObserver(() => undefined);
        flips.observe(container, { subtree: true, attributes: true, attributeFilter: ['data-submit-gate'], attributeOldValue: true });
        // The refresh after an answer shows the next item: ItemActions is keyed by the item, so its forms mount anew.
        rerender(<InboxDetailView view={view({ selected: next })} />);
        const waited = flips.takeRecords().map((record) => `${(record.target as Element).getAttribute('aria-label') ?? 'a form'}: ${record.oldValue} then ${(record.target as Element).getAttribute('data-submit-gate')}`);
        flips.disconnect();
        expect(container.querySelector('form[aria-label="Review"]')).not.toBe(before);
        // Mounted ready: no form of the new item ever said `waiting`, so there was no moment a press would drop.
        expect(waited).toEqual([]);
        const forms = actionForms(container);
        expect(forms.length).toBeGreaterThan(1);
        for (const form of forms) expect(form).toHaveAttribute('data-submit-gate', 'ready');
        await press(within(container.querySelector('form[aria-label="Review"]') as HTMLElement).getByRole('button', { name: 'Decide later' }));
        expect(sent.forms.map((form) => form.action)).toEqual(['defer']);
        expect(sent.forms[0].fields).toContainEqual(['eventId', EVT(2)]);
    });

    it('mark every action form ready once it has mounted, with every submit button enabled', async () => {
        for (const d of [everyForm(), replacement()]) {
            const { container, unmount } = render(<InboxDetailView view={view({ selected: d })} />);
            const buttons = submits(container);
            expect(buttons.length).toBeGreaterThan(0);
            for (const button of buttons) expect(button).toBeEnabled();
            for (const form of actionForms(container)) expect(form).toHaveAttribute('data-submit-gate', 'ready');
            // Archive's own submit shows once its first press asks to confirm, after hydration, and is enabled too.
            const archive = screen.queryByRole('button', { name: /^Archive/ });
            if (archive) {
                const reason = screen.getByRole('textbox', { name: 'Reason for archiving' });
                expect(reason).toBeEnabled();
                fireEvent.change(reason, { target: { value: 'Taken down at the owner’s request.' } });
                await press(archive);
                for (const button of submits(container)) expect(button).toBeEnabled();
                expect(submits(container).map((button) => button.value)).toContain('archive');
            }
            unmount();
        }
    });

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
            window.dispatchEvent(new CustomEvent('curation-inbox:item-changed', { detail: { id: EVT(2), version: 2 } }));
        });
        expect(screen.queryByRole('alert')).toBeNull();
        await act(async () => {
            window.dispatchEvent(new CustomEvent('curation-inbox:item-changed', { detail: { id: EVT(1), version: 2 } }));
        });
        expect(screen.getByRole('alert')).toHaveTextContent(/changed since the page loaded.*Your edits are still in the form/);
        expect(screen.getByRole('textbox', { name: 'Draft description' })).toHaveValue('Still typing.');
    });

    it('raise the alert only for the version the page shows, so a poll in flight during the curator’s own Save says nothing (S4)', async () => {
        const v = (version: number) => view({ selected: detail({ version }) });
        const tree = (version: number) => (
            <main>
                <InboxList view={v(version)} query={ANY} />
                <InboxDetailView view={v(version)} />
            </main>
        );
        const { rerender } = render(tree(2));
        // The curator's Save landed: the page shows version 3, and a poll that compared against 2 answers late.
        rerender(tree(3));
        await act(async () => {
            window.dispatchEvent(new CustomEvent('curation-inbox:item-changed', { detail: { id: EVT(1), version: 2 } }));
        });
        expect(screen.queryByRole('alert')).toBeNull();
        // A real move of version 3 does raise it, and a refresh that shows the next version takes it away.
        await act(async () => {
            window.dispatchEvent(new CustomEvent('curation-inbox:item-changed', { detail: { id: EVT(1), version: 3 } }));
        });
        expect(screen.getByRole('alert')).toBeInTheDocument();
        rerender(tree(4));
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('take the stale answer away once the page shows a newer version (S4)', async () => {
        sent.answer = { status: 'stale', action: 'approve', eventId: EVT(1), message: 'This item changed since the page loaded, so nothing was written. Refresh and review it again.', serial: 1 };
        const v = (version: number) => view({ selected: detail({ version }) });
        const { rerender } = render(
            <main>
                <InboxList view={v(2)} query={ANY} />
                <InboxDetailView view={v(2)} />
            </main>,
        );
        await press(screen.getByRole('button', { name: 'Approve into draft' }));
        expect(screen.getByRole('alert')).toBeInTheDocument();
        rerender(
            <main>
                <InboxList view={v(3)} query={ANY} />
                <InboxDetailView view={v(3)} />
            </main>,
        );
        expect(screen.queryByRole('alert')).toBeNull();
    });
});

describe('the poll', () => {
    const summary = (overrides: Partial<ReadyInboxSummary> = {}): ReadyInboxSummary => ({ state: 'ready', readAt: READ_AT, cursor: 7, arrived: 0, needsJudgment: 2, waiting: 0, placed: 0, unplaced: 0, total: 2, unreadable: 0, watcher: { state: 'running' }, item: { id: EVT(1), version: 2, status: 'open' }, ...overrides });
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
        render(<InboxWatch watcher={{ state: 'running' }} cursor={7} needsJudgment={2} item={{ id: EVT(1), version: 2 }} />);
        expect(fetcher).not.toHaveBeenCalled();
        // Two arrived while one was decided elsewhere: the net count says 3, the arrivals say 2 (B4).
        fetcher.mockImplementation(async () => ({ status: 200, ok: true, type: 'basic', json: async () => summary({ needsJudgment: 3, arrived: 2 }) }) as Response);
        await tick(INBOX_WATCH_INTERVAL_MS);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher.mock.calls[0][0]).toBe(`/api/curation/inbox/summary?item=${EVT(1)}&since=7`);
        const region = screen.getByRole('status', { name: 'Inbox updates' });
        expect(region).toHaveTextContent('2 new items need judgment.');
        expect(within(region).getByRole('link', { name: 'Refresh the inbox' })).toBeInTheDocument();
        // C1 review: the region says "Refresh the inbox" once, as the link, not again in the sentence before it.
        expect(region.textContent?.match(/Refresh the inbox/g)).toHaveLength(1);
        const said = region.querySelector('p');
        await tick(INBOX_WATCH_INTERVAL_MS);
        expect(fetcher).toHaveBeenCalledTimes(2);
        // Said once (N3): the same node, not a new one with the same words.
        expect(region.querySelector('p')).toBe(said);
    });

    it('keeps the new-items line and its link when a later check says only something about the watcher, and adds that beside it', async () => {
        render(<InboxWatch watcher={{ state: 'running' }} cursor={7} needsJudgment={2} item={null} />);
        fetcher.mockImplementation(async () => ({ status: 200, ok: true, type: 'basic', json: async () => summary({ needsJudgment: 3, arrived: 1, item: null }) }) as Response);
        await tick(INBOX_WATCH_INTERVAL_MS);
        const region = screen.getByRole('status', { name: 'Inbox updates' });
        const arrival = within(region).getByText(/1 new item needs judgment\./);
        // The same arrival, said already, and now the watcher stopped: only the watcher is news.
        fetcher.mockImplementation(async () => ({ status: 200, ok: true, type: 'basic', json: async () => summary({ needsJudgment: 3, arrived: 1, item: null, watcher: { state: 'missing' } }) }) as Response);
        await tick(INBOX_WATCH_INTERVAL_MS);
        expect(region).toHaveTextContent(/watcher stopped checking in/);
        // The arrival line stays where it was, the same node, and its link is still there once. The region isn't atomic,
        // so a screen reader reads what was added beside it, not the whole region with the arrival again.
        expect(within(region).getByText(/1 new item needs judgment\./)).toBe(arrival);
        expect(within(region).getByRole('link', { name: 'Refresh the inbox' })).toBeInTheDocument();
        expect(region.textContent?.match(/Refresh the inbox/g)).toHaveLength(1);
        expect(region.textContent?.match(/1 new item needs judgment\./g)).toHaveLength(1);
        // A third word about the watcher replaces the second, beside the arrival, which still holds.
        fetcher.mockImplementation(async () => ({ status: 200, ok: true, type: 'basic', json: async () => summary({ needsJudgment: 3, arrived: 1, item: null }) }) as Response);
        await tick(INBOX_WATCH_INTERVAL_MS);
        expect(region).toHaveTextContent('The watcher is checking in again.');
        expect(region).not.toHaveTextContent(/watcher stopped checking in/);
        expect(within(region).getByText(/1 new item needs judgment\./)).toBe(arrival);
        expect(region.textContent?.match(/Refresh the inbox/g)).toHaveLength(1);
    });

    it('keeps only the new-items sentence beside its link: what else that answer said is the other line, which a later word replaces', async () => {
        render(<InboxWatch watcher={{ state: 'running' }} cursor={7} needsJudgment={2} item={null} />);
        fetcher.mockImplementation(async () => ({ status: 200, ok: true, type: 'basic', json: async () => summary({ needsJudgment: 3, arrived: 1, item: null, watcher: { state: 'missing' } }) }) as Response);
        await tick(INBOX_WATCH_INTERVAL_MS);
        const region = screen.getByRole('status', { name: 'Inbox updates' });
        const arrival = within(region).getByRole('link', { name: 'Refresh the inbox' }).closest('p') as HTMLElement;
        expect(arrival).toHaveTextContent(/^1 new item needs judgment\. Refresh the inbox$/);
        expect(region).toHaveTextContent(/watcher stopped checking in/);
        fetcher.mockImplementation(async () => ({ status: 200, ok: true, type: 'basic', json: async () => summary({ needsJudgment: 3, arrived: 1, item: null }) }) as Response);
        await tick(INBOX_WATCH_INTERVAL_MS);
        expect(region).toHaveTextContent('The watcher is checking in again.');
        expect(region).not.toHaveTextContent(/watcher stopped checking in/);
        expect(within(region).getByRole('link', { name: 'Refresh the inbox' }).closest('p')).toBe(arrival);
    });

    it('says "Back online." beside the new-items line, not in it, so going offline again replaces it', async () => {
        render(<InboxWatch watcher={{ state: 'running' }} cursor={7} needsJudgment={2} item={null} />);
        await act(async () => {
            window.dispatchEvent(new Event('offline'));
        });
        fetcher.mockImplementation(async () => ({ status: 200, ok: true, type: 'basic', json: async () => summary({ needsJudgment: 3, arrived: 1, item: null }) }) as Response);
        await act(async () => {
            window.dispatchEvent(new Event('online'));
        });
        await tick(INBOX_WATCH_ONLINE_GAP_MS);
        const region = screen.getByRole('status', { name: 'Inbox updates' });
        const arrival = within(region).getByRole('link', { name: 'Refresh the inbox' }).closest('p') as HTMLElement;
        expect(arrival).toHaveTextContent(/^1 new item needs judgment\. Refresh the inbox$/);
        expect(region).toHaveTextContent('Back online.');
        await act(async () => {
            window.dispatchEvent(new Event('offline'));
        });
        expect(region).toHaveTextContent(OFFLINE_TEXT);
        expect(region).not.toHaveTextContent('Back online.');
        expect(within(region).getByRole('link', { name: 'Refresh the inbox' }).closest('p')).toBe(arrival);
    });

    it('replaces the new-items line with a new one when more items arrive, and clears the watcher line beside the old one', async () => {
        render(<InboxWatch watcher={{ state: 'running' }} cursor={7} needsJudgment={2} item={null} />);
        fetcher.mockImplementation(async () => ({ status: 200, ok: true, type: 'basic', json: async () => summary({ needsJudgment: 3, arrived: 1, item: null }) }) as Response);
        await tick(INBOX_WATCH_INTERVAL_MS);
        const region = screen.getByRole('status', { name: 'Inbox updates' });
        const first = within(region).getByRole('link', { name: 'Refresh the inbox' }).closest('p') as HTMLElement;
        fetcher.mockImplementation(async () => ({ status: 200, ok: true, type: 'basic', json: async () => summary({ needsJudgment: 3, arrived: 1, item: null, watcher: { state: 'missing' } }) }) as Response);
        await tick(INBOX_WATCH_INTERVAL_MS);
        expect(region).toHaveTextContent(/watcher stopped checking in/);
        // One more arrived, and the watcher is still stopped, which was said: only the new count is news.
        fetcher.mockImplementation(async () => ({ status: 200, ok: true, type: 'basic', json: async () => summary({ needsJudgment: 4, arrived: 2, item: null, watcher: { state: 'missing' } }) }) as Response);
        await tick(INBOX_WATCH_INTERVAL_MS);
        const second = within(region).getByRole('link', { name: 'Refresh the inbox' }).closest('p') as HTMLElement;
        expect(second).toHaveTextContent(/^2 new items need judgment\. Refresh the inbox$/);
        // A new node, so the region reads the new count as an addition.
        expect(second).not.toBe(first);
        expect(first.isConnected).toBe(false);
        expect(region).not.toHaveTextContent(/watcher stopped checking in/);
        expect(region).not.toHaveTextContent('1 new item needs judgment.');
        expect(region.querySelectorAll('p')).toHaveLength(1);
        expect(region.textContent?.match(/Refresh the inbox/g)).toHaveLength(1);
    });

    it('puts each new word on the other line in a node of its own, offline and then the watcher, beside the new-items line', async () => {
        render(<InboxWatch watcher={{ state: 'running' }} cursor={7} needsJudgment={2} item={null} />);
        fetcher.mockImplementation(async () => ({ status: 200, ok: true, type: 'basic', json: async () => summary({ needsJudgment: 3, arrived: 1, item: null }) }) as Response);
        await tick(INBOX_WATCH_INTERVAL_MS);
        const region = screen.getByRole('status', { name: 'Inbox updates' });
        const arrival = within(region).getByRole('link', { name: 'Refresh the inbox' }).closest('p') as HTMLElement;
        await act(async () => {
            window.dispatchEvent(new Event('offline'));
        });
        const offline = within(region).getByText(OFFLINE_TEXT);
        expect(offline).not.toBe(arrival);
        // A check gets through: back online, and the watcher stopped meanwhile.
        fetcher.mockImplementation(async () => ({ status: 200, ok: true, type: 'basic', json: async () => summary({ needsJudgment: 3, arrived: 1, item: null, watcher: { state: 'missing' } }) }) as Response);
        await act(async () => {
            window.dispatchEvent(new Event('online'));
        });
        await tick(INBOX_WATCH_ONLINE_GAP_MS);
        const watcher = within(region).getByText(/watcher stopped checking in/);
        expect(watcher).toHaveTextContent(/^Back online\./);
        expect(watcher).not.toBe(offline);
        expect(offline.isConnected).toBe(false);
        expect(region).not.toHaveTextContent(OFFLINE_TEXT);
        expect(within(region).getByRole('link', { name: 'Refresh the inbox' }).closest('p')).toBe(arrival);
        expect(region.querySelectorAll('p')).toHaveLength(2);
    });

    it('puts "Back online." before the new-items line when one answer brings both, so it is read first', async () => {
        render(<InboxWatch watcher={{ state: 'running' }} cursor={7} needsJudgment={2} item={null} />);
        await act(async () => {
            window.dispatchEvent(new Event('offline'));
        });
        fetcher.mockImplementation(async () => ({ status: 200, ok: true, type: 'basic', json: async () => summary({ needsJudgment: 3, arrived: 1, item: null }) }) as Response);
        await act(async () => {
            window.dispatchEvent(new Event('online'));
        });
        await tick(INBOX_WATCH_ONLINE_GAP_MS);
        const region = screen.getByRole('status', { name: 'Inbox updates' });
        expect([...region.querySelectorAll('p')].map((line) => line.textContent)).toEqual(['Back online. The inbox is checking for changes again.', '1 new item needs judgment. Refresh the inbox']);
    });

    it('reads only what changed in its region: a status is atomic by default, so it says aria-atomic="false"', () => {
        render(<InboxWatch watcher={{ state: 'running' }} cursor={7} needsJudgment={2} item={null} />);
        // role="status" implies aria-atomic="true", and Chromium honours it: with two lines, a change to one would make
        // NVDA or JAWS read the whole region again, the new-items line and its link included.
        expect(screen.getByRole('status', { name: 'Inbox updates' })).toHaveAttribute('aria-atomic', 'false');
    });

    it("puts its strips straight into the page, with no wrapper of its own, where next's watcher strip was (A8's CI, Dark parity)", () => {
        render(
            <div data-testid="page">
                <InboxWatch watcher={{ state: 'missing' }} cursor={7} needsJudgment={2} item={null} />
            </div>,
        );
        const page = screen.getByTestId('page');
        expect(screen.getByRole('region', { name: 'Watcher' }).parentElement).toBe(page);
        expect(screen.getByRole('status', { name: 'Inbox updates' }).parentElement).toBe(page);
    });

    it('shows the watcher strip when the watcher stops checking in while the page is open', async () => {
        render(<InboxWatch watcher={{ state: 'running' }} cursor={7} needsJudgment={2} item={null} />);
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
            render(<InboxWatch watcher={{ state: 'running' }} cursor={7} needsJudgment={2} item={{ id: EVT(1), version: 2 }} />);
            fetcher.mockImplementation(async () => ({ status: 200, ok: true, type: 'basic', json: async () => summary({ item: { id: EVT(1), version: 3, status: 'deferred' } }) }) as Response);
            await tick(INBOX_WATCH_INTERVAL_MS);
            await tick(INBOX_WATCH_INTERVAL_MS);
            expect(heard).toHaveBeenCalledTimes(1);
            expect((heard.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: EVT(1), version: 2 });
        } finally {
            window.removeEventListener('curation-inbox:item-changed', heard);
        }
    });

    it('shows an offline state when the browser goes offline or the server cannot be reached, and clears it once back', async () => {
        render(<InboxWatch watcher={{ state: 'running' }} cursor={7} needsJudgment={2} item={null} />);
        await act(async () => {
            window.dispatchEvent(new Event('offline'));
        });
        const offline = screen.getByRole('region', { name: 'Offline' });
        // One wording for the notice and the line (N6).
        expect(offline).toHaveTextContent(OFFLINE_TEXT);
        expect(screen.getByRole('status', { name: 'Inbox updates' })).toHaveTextContent(OFFLINE_TEXT);
        await act(async () => {
            window.dispatchEvent(new Event('online'));
        });
        // The page load was the last check, moments ago, so online checks once its 2 s are up, not after a refocus's 15 s.
        await tick(INBOX_WATCH_ONLINE_GAP_MS - 1);
        expect(fetcher).toHaveBeenCalledTimes(0);
        // The browser being online says nothing about the server: the notice stays until a check gets through.
        expect(screen.getByRole('region', { name: 'Offline' })).toBeInTheDocument();
        await tick(1);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('region', { name: 'Offline' })).toBeNull();
        expect(screen.getByRole('status', { name: 'Inbox updates' })).toHaveTextContent('Back online.');
        fetcher.mockImplementation(async () => Promise.reject(new TypeError('Failed to fetch')));
        await tick(INBOX_WATCH_INTERVAL_MS);
        expect(screen.getByRole('region', { name: 'Offline' })).toBeInTheDocument();
    });

    it('clears the offline notice once the check kept from coming back online while hidden gets through, after the tab is back', async () => {
        render(<InboxWatch watcher={{ state: 'running' }} cursor={7} needsJudgment={2} item={null} />);
        await act(async () => {
            window.dispatchEvent(new Event('offline'));
        });
        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        try {
            await act(async () => {
                window.dispatchEvent(new Event('online'));
            });
            await tick(5 * INBOX_WATCH_ONLINE_GAP_MS);
            expect(fetcher).not.toHaveBeenCalled();
            expect(screen.getByRole('region', { name: 'Offline' })).toBeInTheDocument();
        } finally {
            hidden.mockRestore();
        }
        await act(async () => {
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await tick(0);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('region', { name: 'Offline' })).toBeNull();
        expect(screen.getByRole('status', { name: 'Inbox updates' })).toHaveTextContent('Back online.');
    });

    it('stays stopped when the browser comes back online after the session ended', async () => {
        fetcher.mockImplementation(async () => ({ status: 401, ok: false, type: 'basic', json: async () => ({}) }) as Response);
        render(<InboxWatch watcher={{ state: 'running' }} cursor={7} needsJudgment={2} item={null} />);
        const region = screen.getByRole('status', { name: 'Inbox updates' });
        await tick(INBOX_WATCH_INTERVAL_MS);
        expect(region).toHaveAttribute('data-watch', 'stopped');
        await act(async () => {
            window.dispatchEvent(new Event('online'));
        });
        await tick(10 * INBOX_WATCH_INTERVAL_MS);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(region).toHaveAttribute('data-watch', 'stopped');
    });

    it('keeps the offline notice when the check the browser coming back online sends fails', async () => {
        render(<InboxWatch watcher={{ state: 'running' }} cursor={7} needsJudgment={2} item={null} />);
        await act(async () => {
            window.dispatchEvent(new Event('offline'));
        });
        fetcher.mockImplementation(async () => Promise.reject(new TypeError('Failed to fetch')));
        await act(async () => {
            window.dispatchEvent(new Event('online'));
        });
        await tick(INBOX_WATCH_ONLINE_GAP_MS);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('region', { name: 'Offline' })).toBeInTheDocument();
    });

    it('clears the offline notice when a check gets through, even with no online event (S5)', async () => {
        fetcher.mockImplementationOnce(async () => Promise.reject(new TypeError('Failed to fetch')));
        render(<InboxWatch watcher={{ state: 'running' }} cursor={7} needsJudgment={2} item={null} />);
        await tick(INBOX_WATCH_INTERVAL_MS);
        expect(screen.getByRole('region', { name: 'Offline' })).toBeInTheDocument();
        await tick(2 * INBOX_WATCH_INTERVAL_MS);
        expect(screen.queryByRole('region', { name: 'Offline' })).toBeNull();
    });

    it('reads again without its cursor when the server refuses it, and counts from the new one (4a)', async () => {
        fetcher.mockImplementation(async (url: string) =>
            url.includes('since=7')
                ? ({ status: 400, ok: false, type: 'basic', json: async () => ({ error: 'bad-cursor' }) } as Response)
                : ({ status: 200, ok: true, type: 'basic', json: async () => summary({ cursor: 3, arrived: url.includes('since=3') ? 1 : null, item: null }) } as Response),
        );
        render(<InboxWatch watcher={{ state: 'running' }} cursor={7} needsJudgment={2} item={null} />);
        await tick(INBOX_WATCH_INTERVAL_MS);
        expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/curation/inbox/summary?since=7', '/api/curation/inbox/summary']);
        expect(screen.getByRole('status', { name: 'Inbox updates' })).toHaveTextContent(/^The inbox has changed since this page loaded\. Refresh the inbox$/);
        await tick(INBOX_WATCH_INTERVAL_MS);
        expect(fetcher.mock.calls.at(-1)?.[0]).toBe('/api/curation/inbox/summary?since=3');
        expect(screen.getByRole('status', { name: 'Inbox updates' })).toHaveTextContent('1 new item needs judgment.');
    });

    it('says the inbox changed, with its one Refresh link, when the server refuses the cursor after new items, never a count from the new cursor', async () => {
        render(<InboxWatch watcher={{ state: 'running' }} cursor={7} needsJudgment={2} item={null} />);
        fetcher.mockImplementation(async () => ({ status: 200, ok: true, type: 'basic', json: async () => summary({ needsJudgment: 5, arrived: 3, item: null }) }) as Response);
        await tick(INBOX_WATCH_INTERVAL_MS);
        const region = screen.getByRole('status', { name: 'Inbox updates' });
        expect(region).toHaveTextContent('3 new items need judgment.');
        // The data root was restored: the server refuses since=7, and the read without it counts from its own cursor.
        // Even with a count in that answer, it's against a history the page never saw, so it isn't said.
        fetcher.mockImplementation(async (url: string) =>
            url.includes('since=7')
                ? ({ status: 400, ok: false, type: 'basic', json: async () => ({ error: 'bad-cursor' }) } as Response)
                : ({ status: 200, ok: true, type: 'basic', json: async () => summary({ cursor: 3, needsJudgment: 6, arrived: url.includes('since=3') ? 3 : 1, item: null }) } as Response),
        );
        await tick(INBOX_WATCH_INTERVAL_MS);
        expect(fetcher.mock.calls.slice(-2).map(([url]) => url)).toEqual(['/api/curation/inbox/summary?since=7', '/api/curation/inbox/summary']);
        const changed = within(region).getByRole('link', { name: 'Refresh the inbox' }).closest('p') as HTMLElement;
        expect(changed).toHaveTextContent(/^The inbox has changed since this page loaded\. Refresh the inbox$/);
        expect(region).not.toHaveTextContent('1 new item needs judgment.');
        expect(region).not.toHaveTextContent('3 new items need judgment.');
        expect(region.textContent?.match(/Refresh the inbox/g)).toHaveLength(1);
        // From the new cursor on, a count is said, even one the page said before the restore, but the page is stale until
        // it refreshes, so the count follows the sentence that says so, in the same line, a new node.
        await tick(INBOX_WATCH_INTERVAL_MS);
        expect(fetcher.mock.calls.at(-1)?.[0]).toBe('/api/curation/inbox/summary?since=3');
        const counted = within(region).getByRole('link', { name: 'Refresh the inbox' }).closest('p') as HTMLElement;
        expect(counted).toHaveTextContent(/^The inbox has changed since this page loaded\. 3 new items need judgment\. Refresh the inbox$/);
        expect(counted).not.toBe(changed);
        expect(region.querySelectorAll('p')).toHaveLength(1);
        expect(region.textContent?.match(/The inbox has changed/g)).toHaveLength(1);
        expect(region.textContent?.match(/Refresh the inbox/g)).toHaveLength(1);
    });

    it('stops quietly once the session is gone, and never asks again', async () => {
        fetcher.mockImplementation(async () => ({ status: 401, ok: false, type: 'basic', json: async () => ({}) }) as Response);
        render(<InboxWatch watcher={{ state: 'running' }} cursor={7} needsJudgment={2} item={null} />);
        await tick(INBOX_WATCH_INTERVAL_MS);
        await tick(10 * INBOX_WATCH_INTERVAL_MS);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('status', { name: 'Inbox updates' })).toHaveTextContent('');
        expect(screen.queryByRole('region', { name: 'Offline' })).toBeNull();
    });

    it('marks the updates region data-watch="armed" once its first check is scheduled, and "stopped" once the session ends, with no change to what it says', async () => {
        fetcher.mockImplementation(async () => ({ status: 401, ok: false, type: 'basic', json: async () => ({}) }) as Response);
        render(<InboxWatch watcher={{ state: 'running' }} cursor={7} needsJudgment={2} item={null} />);
        const region = screen.getByRole('status', { name: 'Inbox updates' });
        expect(region).toHaveAttribute('data-watch', 'armed');
        await tick(INBOX_WATCH_INTERVAL_MS);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(region).toHaveAttribute('data-watch', 'stopped');
        // Invisible to everyone: no ARIA attribute beyond its name and its aria-atomic="false", and nothing said.
        expect(region.getAttributeNames().filter((name) => name.startsWith('aria-')).sort()).toEqual(['aria-atomic', 'aria-label']);
        expect(region).toHaveTextContent('');
    });

    it('waits while the tab is hidden, and checks on coming back', async () => {
        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        try {
            render(<InboxWatch watcher={{ state: 'running' }} cursor={7} needsJudgment={2} item={null} />);
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
