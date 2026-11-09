import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RELEASE_HINT, restoreHint, type InboxActionState, type InboxDetail, type InboxItem, type InboxView, type SeriesOption } from '@/lib/curation/inbox-view';

// #17's pieces of the Inbox as the curator sees them: Restore in Approve's place on a new photograph whose bytes are
// an archived one's, Bind's suggested files, Release on a held missing item, the Status filter's Held, the held count
// and the library banner. The server actions are stood in for, so what each form sends is checked here, and what each
// action does is lib/curation/__tests__/inboxHeld.test.ts's and inboxRestoreSuggest.test.ts's.

const sent = vi.hoisted(() => ({ forms: [] as { action: string; fields: Record<string, string> }[] }));

vi.mock('../actions', () => {
    const make = (action: string) => async (_previous: InboxActionState, form: FormData): Promise<InboxActionState> => {
        sent.forms.push({ action, fields: Object.fromEntries([...form.entries()].map(([name, value]) => [name, String(value)])) });
        return { status: 'done', action: action as 'approve', eventId: String(form.get('eventId')), message: 'Done.', serial: sent.forms.length };
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
        bulkItems: async () => ({ status: 'idle' }),
    };
});

const { default: InboxList } = await import('../InboxList');
const { default: InboxDetailView } = await import('../InboxDetailView');
const { default: InboxWatch } = await import('../InboxWatch');

if (typeof Element.prototype.scrollIntoView !== 'function') Element.prototype.scrollIntoView = () => undefined;
window.scrollTo = (() => undefined) as typeof window.scrollTo;

beforeEach(() => {
    sent.forms = [];
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/');
});

const P = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const EVT = (n: number) => `evt_${String(n).padStart(24, '0')}`;
const REV = `sha256-${'a'.repeat(64)}`;
const ACTIVE = `rev_${'b'.repeat(64)}`;
const SERIES: SeriesOption[] = [{ id: 'ser_harbor', label: 'Harbor', visibility: 'published', members: [] }];
const NONE = { approve: false, edit: false, defer: false, dismiss: false, retry: false, reopen: false, confirm: false, bind: false, archive: false };

type Ready = Extract<InboxView, { state: 'ready' }>;

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
        can: { ...NONE, approve: true, edit: true, defer: true, dismiss: true },
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

function view(overrides: Partial<Ready> = {}): Ready {
    const items = overrides.items ?? [item(1)];
    return { state: 'ready', watcher: { state: 'running' }, readAt: '2026-02-01T03:00:00.000Z', cursor: 0, activeRevisionId: ACTIVE, needsJudgment: items.length, held: 0, library: null, waiting: 0, placed: 0, unplaced: 0, placementUnknown: false, items, problems: [], series: SERIES, seriesProblem: null, selected: detail(), missingSelection: null, ...overrides };
}

async function press(button: HTMLElement) {
    await act(async () => {
        fireEvent.click(button);
    });
}

const restorable = () => detail({ ...item(1, { sourcePath: 'returned/landscape.jpg' }), restores: { name: 'landscape.jpg' } });

describe('Restore, in Approve\'s place (#17)', () => {
    it('takes Approve\'s place on a new photograph whose bytes are an archived one\'s, with the series, position and description fields hidden, and Dismiss still there', () => {
        render(<InboxDetailView view={view({ selected: restorable() })} />);
        const review = screen.getByRole('form', { name: 'Review' });
        const restore = within(review).getByRole('button', { name: 'Restore' });
        expect(restore).toHaveAttribute('type', 'submit');
        expect(restore).toHaveAttribute('value', 'restore');
        expect(within(review).queryByRole('button', { name: 'Approve into draft' })).toBeNull();
        expect(within(review).queryByRole('button', { name: 'Save edits' })).toBeNull();
        expect(within(review).queryByRole('combobox', { name: 'Suggested series' })).toBeNull();
        expect(within(review).queryByRole('combobox', { name: 'Proposed sequence position' })).toBeNull();
        expect(within(review).queryByRole('textbox', { name: 'Draft description' })).toBeNull();
        expect(within(review).queryByRole('checkbox', { name: /Decorative/ })).toBeNull();
        expect(within(review).getByRole('button', { name: 'Decide later' })).toBeInTheDocument();
        const hint = 'This file matches landscape.jpg, an archived photograph. Restore brings it back with its original details, outside any series. Add it to a series from the Series screen afterwards.';
        expect(restoreHint('landscape.jpg')).toBe(hint);
        expect(screen.getByText(hint)).toHaveAttribute('id', 'restore-hint');
        expect(restore).toHaveAccessibleDescription(hint);
        expect(screen.getByText('Dismiss with a reason')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    });

    it('sends Restore with the item and the versions the page showed, and no series, position or description', async () => {
        render(<InboxDetailView view={view({ selected: restorable() })} />);
        await press(screen.getByRole('button', { name: 'Restore' }));
        expect(sent.forms.map((form) => form.action)).toEqual(['restore']);
        expect(sent.forms[0].fields).toEqual({ eventId: EVT(1), version: '2', base: ACTIVE, intent: 'restore' });
    });

    it('keeps Approve and the fields on a new photograph that restores nothing', () => {
        render(<InboxDetailView view={view({ selected: detail() })} />);
        expect(screen.getByRole('button', { name: 'Approve into draft' })).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Suggested series' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
        expect(screen.queryByText(/an archived photograph\. Restore brings it back/)).toBeNull();
    });
});

describe("Bind's suggested files (#17)", () => {
    const missing = (overrides: Partial<InboxDetail> = {}) =>
        detail({
            ...item(1, { type: 'missing', title: 'Source file missing', sourcePath: 'harbor/landscape.jpg' }),
            can: { ...NONE, defer: true, bind: true, archive: true },
            suggestedFiles: [
                { id: EVT(31), path: 'edits/landscape.jpg', libraryPath: 'edits/landscape.jpg', by: 'basename' },
                { id: EVT(32), path: 'ed\\\\its/frame.jpg', libraryPath: 'ed\\its/frame.jpg', by: 'capture-time' },
            ],
            ...overrides,
        });
    const radios = () => within(screen.getByRole('group', { name: 'File to bind' })).getAllByRole('radio') as HTMLInputElement[];
    const labels = () => radios().map((radio) => radio.closest('label')?.textContent);

    it('lists them after the linked files and before "Another file in the library", with their labels', () => {
        render(<InboxDetailView view={view({ selected: missing({ linkedFiles: [{ id: EVT(30), path: 'harbor/landscape.jpg' }] }) })} />);
        expect(labels()).toEqual([
            'harbor/landscape.jpg, the new file at its last path',
            'edits/landscape.jpg: same file name, different pixels',
            'ed\\\\its/frame.jpg: taken at the same moment, different pixels',
            'Another file in the library',
        ]);
    });

    it('never chooses a suggestion for the curator, with a linked file or without one', () => {
        for (const linkedFiles of [[{ id: EVT(30), path: 'harbor/landscape.jpg' }], [{ id: EVT(30), path: 'a.jpg' }, { id: EVT(33), path: 'b.jpg' }], []]) {
            const { unmount } = render(<InboxDetailView view={view({ selected: missing({ linkedFiles }) })} />);
            const suggestions = radios().slice(linkedFiles.length, -1);
            expect(suggestions).toHaveLength(2);
            for (const radio of suggestions) expect(radio.checked, `${linkedFiles.length} linked`).toBe(false);
            expect(screen.getByRole('textbox', { name: 'Library path' })).toHaveValue('');
            unmount();
        }
    });

    it('sends a chosen suggestion as its path, unescaped, as `curation bind --path` takes it', async () => {
        render(<InboxDetailView view={view({ selected: missing() })} />);
        const odd = radios()[1];
        await act(async () => {
            fireEvent.click(odd);
        });
        expect(odd.checked).toBe(true);
        expect(screen.getByRole('textbox', { name: 'Library path' })).toHaveValue('ed\\its/frame.jpg');
        await press(screen.getByRole('button', { name: 'Bind' }));
        expect(sent.forms.map((form) => form.action)).toEqual(['bind']);
        expect(sent.forms[0].fields).toMatchObject({ bindTo: 'typed', path: 'ed\\its/frame.jpg' });
        // Typing over it chooses Another file in the library, so what's sent is what the field shows.
        fireEvent.change(screen.getByRole('textbox', { name: 'Library path' }), { target: { value: 'harbor/other.jpg' } });
        expect(radios().at(-1)?.checked).toBe(true);
    });
});

describe('Release, on a held missing item (#17)', () => {
    const held = (overrides: Partial<InboxDetail> = {}) =>
        detail({ ...item(1, { type: 'missing', title: 'Source file missing', sourcePath: 'bulk/photo-1.jpg', held: true }), can: { ...NONE, defer: true, bind: true, archive: true }, release: true, ...overrides });

    it('offers Release with its hint and an optional reason, in a form at the Inbox\'s submit gate, ready once mounted', () => {
        const html = document.createElement('div');
        html.innerHTML = renderToString(<InboxDetailView view={view({ selected: held() })} />);
        expect(html.querySelector('form[aria-label="Release"]')).toHaveAttribute('data-submit-gate', 'waiting');
        render(<InboxDetailView view={view({ selected: held() })} />);
        const form = screen.getByRole('form', { name: 'Release' });
        expect(form).toHaveAttribute('data-submit-gate', 'ready');
        expect(within(form).getByText(RELEASE_HINT)).toBeInTheDocument();
        const reason = within(form).getByRole('textbox', { name: 'Reason for releasing' });
        expect(reason).not.toBeRequired();
        const release = within(form).getByRole('button', { name: 'Release' });
        expect(release).toHaveAccessibleDescription(RELEASE_HINT);
        expect(RELEASE_HINT).toBe("This item is on hold because the library can't be reached. Release it only if its file is really gone: it then counts as missing, and Bind or Archive settles it.");
    });

    it('sends confirm-missing\'s release with the reason typed, or none', async () => {
        render(<InboxDetailView view={view({ selected: held() })} />);
        const form = screen.getByRole('form', { name: 'Release' });
        await press(within(form).getByRole('button', { name: 'Release' }));
        fireEvent.change(within(form).getByRole('textbox', { name: 'Reason for releasing' }), { target: { value: 'Deleted on purpose.' } });
        await press(within(form).getByRole('button', { name: 'Release' }));
        expect(sent.forms.map((entry) => [entry.action, entry.fields.reason])).toEqual([
            ['release', ''],
            ['release', 'Deleted on purpose.'],
        ]);
        expect(sent.forms[0].fields).toMatchObject({ eventId: EVT(1), version: '2', base: ACTIVE, intent: 'release' });
    });

    it('offers no Release on a missing item that isn\'t held', () => {
        render(<InboxDetailView view={view({ selected: held({ held: false, release: false }) })} />);
        expect(screen.queryByRole('form', { name: 'Release' })).toBeNull();
        expect(screen.queryByText(RELEASE_HINT)).toBeNull();
    });
});

describe('the held count, the Held filter and the library banner (#17)', () => {
    it('says the held items apart from the judgment count: "5 items require judgment, 3 held"', () => {
        const items = [1, 2, 3, 4, 5].map((n) => item(n));
        render(<InboxList view={view({ items, needsJudgment: 5, held: 3, selected: null })} />);
        expect(screen.getByText('5 items require judgment, 3 held')).toBeInTheDocument();
    });

    it('lists Held last in the Status filter, as ?status=held', () => {
        render(<InboxList view={view()} query={{ status: 'held', type: null, page: 1 }} />);
        const status = screen.getByRole('combobox', { name: 'Status' });
        const options = within(status).getAllByRole('option') as HTMLOptionElement[];
        expect(options.at(-1)).toMatchObject({ value: 'held', textContent: 'Held' });
        expect(status).toHaveValue('held');
    });

    it('shows the banner on the first load, above the list and the item, linking to the library item', () => {
        const library = { cause: 'the library root is missing', held: 3, itemId: EVT(7) };
        const html = document.createElement('div');
        html.innerHTML = renderToString(<InboxWatch watcher={{ state: 'running' }} needsJudgment={0} cursor={0} item={null} library={library} />);
        for (const root of [html, render(<InboxWatch watcher={{ state: 'running' }} needsJudgment={0} cursor={0} item={null} library={library} />).container]) {
            const banner = root.querySelector('section#library');
            expect(banner).toHaveAttribute('aria-label', 'Library');
            expect(banner).toHaveAttribute('data-tone', 'alert');
            expect(banner).not.toHaveAttribute('role');
            expect(banner).not.toHaveAttribute('aria-live');
            expect(banner?.textContent).toBe("The library can't be reached (the library root is missing), so nothing changes until it's back. 3 missing items are on hold.");
            expect(within(banner as HTMLElement).getByRole('link', { name: "The library can't be reached" })).toHaveAttribute('href', `/curation/inbox?item=${EVT(7)}#item`);
        }
    });

    it('says how many missing items are on hold only when some are: none, one, and several', () => {
        const banner = (held: number) => {
            const { container, unmount } = render(<InboxWatch watcher={{ state: 'running' }} needsJudgment={0} cursor={0} item={null} library={{ cause: 'the library root is missing', held, itemId: EVT(7) }} />);
            const text = container.querySelector('section#library')?.textContent;
            const link = within(container.querySelector('section#library') as HTMLElement).getByRole('link', { name: "The library can't be reached" });
            expect(link).toHaveAttribute('href', `/curation/inbox?item=${EVT(7)}#item`);
            unmount();
            return text;
        };
        // With nothing held, the banner stays, with its first sentence alone.
        expect(banner(0)).toBe("The library can't be reached (the library root is missing), so nothing changes until it's back.");
        expect(banner(1)).toBe("The library can't be reached (the library root is missing), so nothing changes until it's back. 1 missing item is on hold.");
        expect(banner(20)).toBe("The library can't be reached (the library root is missing), so nothing changes until it's back. 20 missing items are on hold.");
    });

    it("says in the library item's own box that each held item has Release, beside the command", () => {
        const library = detail({ ...item(7, { type: 'library-unavailable', title: 'Library unavailable', photoId: null, shortId: 'no photo ID', sourcePath: '.' }), can: { ...NONE, edit: true, defer: true, dismiss: true }, facts: [{ label: 'Cause', value: 'The library root is missing' }] });
        render(<InboxDetailView view={view({ items: [library], selected: library })} />);
        const box = screen.getByRole('region', { name: 'Library unavailable' });
        expect(box.querySelector('p')?.textContent).toBe(
            "While the watcher can't see the library, or can't read its files, it changes nothing, and the missing items it found since the outage began wait here instead of counting as missing. A pass that reads the library again closes this item and releases them. Release each held item, or run curation confirm-missing, to release one that's really gone.",
        );
        expect(within(box).getByText('curation confirm-missing').tagName).toBe('CODE');
    });

    it('shows no banner while the library is available', () => {
        const { container } = render(<InboxWatch watcher={{ state: 'running' }} needsJudgment={0} cursor={0} item={null} library={null} />);
        expect(container.querySelector('#library')).toBeNull();
        expect(screen.queryByRole('region', { name: 'Library' })).toBeNull();
    });
});
