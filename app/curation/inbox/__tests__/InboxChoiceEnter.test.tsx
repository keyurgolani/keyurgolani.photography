import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BULK_IDLE, type InboxActionState, type InboxBulkState, type InboxDetail, type InboxItem, type InboxView, type SeriesOption } from '@/lib/curation/inbox-view';

// Enter on a checkbox, a radio or a select in an Inbox form. In Chromium it sends the form by its first enabled submit
// button: Decide later on selected from a ticked row box, Save edits from Decorative, Bind from a file to bind. Each form
// stops that one default, so the key does nothing there, and leaves every other key and control as it was: Enter in a
// text field still sends its form, Enter on a button still presses it, Space still ticks and the arrows still move
// between radios. jsdom never sends a form from a key, so what's checked here is whether the key's default is
// stopped; e2e/curation-inbox-enter.spec.ts checks in Chromium that nothing is sent.

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
        bulkItems: async (_previous: InboxBulkState, form: FormData): Promise<InboxBulkState> => {
            sent.forms.push({ action: 'bulk', fields: Object.fromEntries([...form.entries()].map(([name, value]) => [name, String(value)])) });
            return BULK_IDLE;
        },
    };
});

const { default: InboxList } = await import('../InboxList');
const { default: InboxDetailView } = await import('../InboxDetailView');
const { keepEnterOffChoices } = await import('../useHydrated');

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
const ANY = { status: null, type: null, page: 1 } as const;

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
    const items = overrides.items ?? [item(1), item(2)];
    return { state: 'ready', watcher: { state: 'running' }, readAt: '2026-02-01T03:00:00.000Z', cursor: 0, activeRevisionId: ACTIVE, needsJudgment: items.length, held: 0, library: null, waiting: 0, placed: 0, unplaced: 0, placementUnknown: false, items, problems: [], series: SERIES, seriesProblem: null, selected: detail(), missingSelection: null, ...overrides };
}

/** Whether `key` on `element` had its default stopped, as a press of it would in a browser. */
const stopped = (element: Element, key: string) => !fireEvent.keyDown(element, { key, code: key === ' ' ? 'Space' : key });

/** A missing source with a file at its last path, a suggested file, and "Another file in the library". */
const missing = (overrides: Partial<InboxDetail> = {}) =>
    detail({
        ...item(1, { type: 'missing', title: 'Source file missing', sourcePath: 'harbor/landscape.jpg' }),
        can: { ...NONE, defer: true, bind: true, archive: true, dismiss: true },
        linkedFiles: [{ id: EVT(30), path: 'harbor/landscape.jpg' }],
        suggestedFiles: [{ id: EVT(31), path: 'edits/landscape.jpg', libraryPath: 'edits/landscape.jpg', by: 'basename' }],
        ...overrides,
    });

describe('Enter on a choice in an Inbox form', () => {
    it('does nothing on the row checkboxes, which belong to the bulk form by their form attribute, so Decide later on selected stays unpressed', async () => {
        render(<InboxList view={view()} query={ANY} />);
        const bulk = screen.getByRole('form', { name: 'Bulk actions' }) as HTMLFormElement;
        const box = screen.getByRole('checkbox', { name: 'Select photo-1.jpg' }) as HTMLInputElement;
        expect(box.form).toBe(bulk);
        fireEvent.click(box);
        expect(box.checked).toBe(true);
        expect(stopped(box, 'Enter'), 'Enter on a ticked row box').toBe(true);
        // Space still ticks, and nothing about the box or the form changes for the key.
        expect(stopped(box, ' '), 'Space on a row box').toBe(false);
        expect(box.checked).toBe(true);
        expect(bulk).toHaveAttribute('data-submit-gate', 'ready');
        expect(sent.forms).toEqual([]);
        // The buttons still send it, Enter on one included, which presses it.
        const defer = screen.getByRole('button', { name: 'Decide later on selected' });
        expect(stopped(defer, 'Enter'), 'Enter on Decide later on selected').toBe(false);
        await act(async () => {
            fireEvent.click(defer);
        });
        expect(sent.forms).toEqual([{ action: 'bulk', fields: expect.objectContaining({ items: `${EVT(1)}:2`, intent: 'defer' }) }]);
    });

    it("leaves a checkbox that isn't the bulk form's alone", () => {
        render(<InboxList view={view()} query={ANY} />);
        const other = document.createElement('form');
        const box = document.createElement('input');
        box.type = 'checkbox';
        other.append(box);
        document.body.append(other);
        try {
            expect(stopped(box, 'Enter')).toBe(false);
        } finally {
            other.remove();
        }
    });

    it("does nothing on Decorative, the series and position selects, or a sequence radio in Review, so Save edits stays unpressed", async () => {
        render(<InboxDetailView view={view()} />);
        const review = screen.getByRole('form', { name: 'Review' });
        const decorative = within(review).getByRole('checkbox', { name: /Decorative/ }) as HTMLInputElement;
        const series = within(review).getByRole('combobox', { name: 'Suggested series' });
        expect(stopped(decorative, 'Enter'), 'Enter on Decorative').toBe(true);
        expect(decorative.checked).toBe(false);
        expect(stopped(series, 'Enter'), 'Enter on Suggested series').toBe(true);
        fireEvent.change(series, { target: { value: 'ser_harbor' } });
        const position = within(review).getByRole('combobox', { name: 'Proposed sequence position' });
        expect(stopped(position, 'Enter'), 'Enter on Proposed sequence position').toBe(true);
        fireEvent.change(position, { target: { value: 'editor' } });
        const start = within(within(review).getByRole('group', { name: 'Place it in Harbor' })).getByRole('radio', { name: 'At the start' });
        expect(stopped(start, 'Enter'), 'Enter on a sequence radio').toBe(true);
        // Space ticks Decorative, the arrows move a radio and a select, and Tab moves on, as before.
        expect(stopped(decorative, ' '), 'Space on Decorative').toBe(false);
        for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Tab']) expect(stopped(start, key), `${key} on a sequence radio`).toBe(false);
        for (const key of ['ArrowDown', ' ', 'Tab']) expect(stopped(series, key), `${key} on Suggested series`).toBe(false);
        expect(review).toHaveAttribute('data-submit-gate', 'ready');
        expect(sent.forms).toEqual([]);
        // Enter on a button still presses it, and the press still sends what the form shows.
        const save = within(review).getByRole('button', { name: 'Save edits' });
        expect(stopped(save, 'Enter'), 'Enter on Save edits').toBe(false);
        await act(async () => {
            fireEvent.click(save);
        });
        expect(sent.forms.map((form) => form.fields.intent)).toEqual(['edit']);
    });

    it('does nothing on any of the sequence radios, the start, after a photograph and the end', () => {
        const members = [P(7), P(8), P(9)].map((photoId, index) => ({ photoId, shortId: `ph_0000…000${index + 7}` }));
        render(<InboxDetailView view={view({ series: [{ ...SERIES[0], members }] })} />);
        const review = screen.getByRole('form', { name: 'Review' });
        fireEvent.change(within(review).getByRole('combobox', { name: 'Suggested series' }), { target: { value: 'ser_harbor' } });
        fireEvent.change(within(review).getByRole('combobox', { name: 'Proposed sequence position' }), { target: { value: 'editor' } });
        const slots = within(within(review).getByRole('group', { name: 'Place it in Harbor' })).getAllByRole('radio');
        expect(slots.map((slot) => slot.closest('label')?.textContent)).toEqual(['At the start', 'After photograph 01', 'After photograph 02', 'At the end']);
        for (const slot of slots) expect(stopped(slot, 'Enter'), `Enter on ${slot.closest('label')?.textContent}`).toBe(true);
        expect(sent.forms).toEqual([]);
    });

    it("leaves Enter in the description to its own handler, which adds no line break, and Enter on Restore's button alone", () => {
        const { unmount } = render(<InboxDetailView view={view()} />);
        // The description's own handler already stops Enter: a description is one line, as the server stores it.
        expect(stopped(screen.getByRole('textbox', { name: 'Draft description' }), 'Enter')).toBe(true);
        unmount();
        render(<InboxDetailView view={view({ selected: detail({ restores: { name: 'landscape.jpg' } }) })} />);
        expect(stopped(screen.getByRole('button', { name: 'Restore' }), 'Enter')).toBe(false);
    });

    it("does nothing on Bind's radios, the file at its last path, a suggested file and Another file, while Enter in Library path still sends Bind", async () => {
        render(<InboxDetailView view={view({ selected: missing() })} />);
        const bind = screen.getByRole('form', { name: 'Bind' });
        const radios = within(within(bind).getByRole('group', { name: 'File to bind' })).getAllByRole('radio') as HTMLInputElement[];
        expect(radios.map((radio) => radio.closest('label')?.textContent)).toEqual(['harbor/landscape.jpg, the new file at its last path', 'edits/landscape.jpg: same file name, different pixels', 'Another file in the library']);
        for (const radio of radios) expect(stopped(radio, 'Enter'), `Enter on ${radio.closest('label')?.textContent}`).toBe(true);
        for (const radio of radios) for (const key of ['ArrowDown', 'ArrowUp', ' ', 'Tab']) expect(stopped(radio, key), `${key} on ${radio.closest('label')?.textContent}`).toBe(false);
        expect(radios[0].checked).toBe(true);
        expect(bind).toHaveAttribute('data-submit-gate', 'ready');
        expect(sent.forms).toEqual([]);
        // The path field is a text field, where Enter sends the form, as the browser does by itself.
        const path = within(bind).getByRole('textbox', { name: 'Library path' });
        expect(stopped(path, 'Enter'), 'Enter in Library path').toBe(false);
        expect(stopped(within(bind).getByRole('button', { name: 'Bind' }), 'Enter'), 'Enter on Bind').toBe(false);
        await act(async () => {
            fireEvent.click(radios[1]);
        });
        expect(path).toHaveValue('edits/landscape.jpg');
        await act(async () => {
            fireEvent.click(within(bind).getByRole('button', { name: 'Bind' }));
        });
        expect(sent.forms).toEqual([{ action: 'bind', fields: expect.objectContaining({ bindTo: 'typed', path: 'edits/landscape.jpg', intent: 'bind' }) }]);
    });

    it("leaves Enter in the text fields that send their form alone: Release's and Dismiss's reasons", () => {
        render(<InboxDetailView view={view({ selected: missing({ held: true, release: true }) })} />);
        const release = screen.getByRole('form', { name: 'Release' });
        expect(stopped(within(release).getByRole('textbox', { name: 'Reason for releasing' }), 'Enter'), "Enter in Release's reason").toBe(false);
        expect(stopped(within(release).getByRole('button', { name: 'Release' }), 'Enter'), 'Enter on Release').toBe(false);
        expect(stopped(screen.getByRole('textbox', { name: 'Reason' }), 'Enter'), "Enter in Dismiss's reason").toBe(false);
    });

    it("leaves Enter in Archive's reason to its own handler, which opens the second step", () => {
        render(<InboxDetailView view={view({ selected: missing() })} />);
        const reason = screen.getByRole('textbox', { name: 'Reason for archiving' });
        fireEvent.change(reason, { target: { value: 'Gone for good.' } });
        expect(stopped(reason, 'Enter')).toBe(true);
        expect(screen.getByRole('button', { name: 'Yes, archive it' })).toBeInTheDocument();
        expect(sent.forms).toEqual([]);
    });
});

describe('keepEnterOffChoices()', () => {
    // What each control does with it, should one take it: a choice stops Enter, and nothing else stops anything.
    const control = (html: string) => {
        const holder = document.createElement('form');
        holder.innerHTML = html;
        return holder.firstElementChild as HTMLElement;
    };
    const stops = (element: HTMLElement, key: string) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        element.addEventListener('keydown', keepEnterOffChoices, { once: true });
        element.dispatchEvent(event);
        return event.defaultPrevented;
    };

    it('stops Enter on a checkbox, a radio and a select', () => {
        for (const html of ['<input type="checkbox">', '<input type="radio" name="r">', '<select><option>a</option></select>', '<select multiple><option>a</option></select>']) expect(stops(control(html), 'Enter'), html).toBe(true);
    });

    it('leaves every other key on them alone', () => {
        for (const html of ['<input type="checkbox">', '<input type="radio" name="r">', '<select><option>a</option></select>']) for (const key of [' ', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Tab', 'Escape']) expect(stops(control(html), key), `${key} on ${html}`).toBe(false);
    });

    it('leaves Enter in a text field, a text area and on a button alone', () => {
        for (const html of ['<input>', '<input type="text">', '<input type="search">', '<input type="number">', '<textarea></textarea>', '<button type="submit">Send</button>', '<button type="button">Open</button>', '<input type="submit">']) expect(stops(control(html), 'Enter'), html).toBe(false);
    });
});
