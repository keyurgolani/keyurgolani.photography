import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeriesActionState, SeriesDetail, SeriesRow } from '@/lib/curation/series-view';

// The Series screen's pieces as the curator sees them: the list, New series, and a series' page, with the server
// actions stood in for, so what each form sends is checked here and what each action does is
// lib/curation/__tests__/seriesForm.test.ts's.

// `answer` is what the next action answers; `hold`, when set, keeps every action pending until the test lets it go.
const sent = vi.hoisted(() => ({ forms: [] as { action: string; fields: Record<string, string> }[], answer: null as SeriesActionState | null, hold: null as Promise<void> | null }));

vi.mock('../actions', () => {
    const make = (action: 'create' | 'edit') => async (_previous: SeriesActionState, form: FormData): Promise<SeriesActionState> => {
        sent.forms.push({ action, fields: Object.fromEntries([...form.entries()].map(([name, value]) => [name, String(value)])) });
        if (sent.hold) await sent.hold;
        return sent.answer ?? { status: 'done', action, seriesId: 'ser_harbor', message: 'Done.', serial: sent.forms.length };
    };
    return { createSeries: make('create'), saveSeries: make('edit') };
});

const { default: SeriesList } = await import('../SeriesList');
const { default: NewSeriesForm } = await import('../NewSeriesForm');
const { default: SeriesEditForm } = await import('../SeriesEditForm');

beforeEach(() => {
    sent.forms = [];
    sent.answer = null;
    sent.hold = null;
});

function row(overrides: Partial<SeriesRow> = {}): SeriesRow {
    return { id: 'ser_harbor', title: 'Harbor', slug: 'harbor', visibility: 'published', photoCount: 12, carriedOver: false, inWorkOrder: true, href: '/curation/series/ser_harbor', ...overrides };
}

function detail(overrides: Partial<SeriesDetail> = {}): SeriesDetail {
    return { id: 'ser_harbor', version: 4, title: 'Harbor', slug: 'harbor', statement: 'The harbor before the ferries.\n\nA second paragraph.', shortStatement: 'The harbor before the ferries.', visibility: 'published', photoCount: 12, carriedOver: false, inWorkOrder: true, ...overrides };
}

const answer = (status: Exclude<SeriesActionState, { status: 'idle' }>['status'], action: 'create' | 'edit', message: string, extra: Partial<Exclude<SeriesActionState, { status: 'idle' }>> = {}): SeriesActionState => ({ status, action, seriesId: 'ser_harbor', message, serial: 1, ...extra });

async function submit(button: HTMLElement) {
    await act(async () => {
        fireEvent.click(button);
    });
}

describe('the series list', () => {
    it('shows every series by its title, linking to its page, with its visibility, its photographs, and whether it was carried over', () => {
        render(
            <SeriesList
                rows={[
                    row(),
                    row({ id: 'ser_gallery', title: 'Gallery', slug: 'gallery', photoCount: 1, carriedOver: true, href: '/curation/series/ser_gallery' }),
                    row({ id: 'ser_draft', title: '', slug: 'draft', visibility: 'draft', photoCount: 0, inWorkOrder: false, href: '/curation/series/ser_draft' }),
                    row({ id: 'ser_hidden', title: 'Old roads', slug: 'old-roads', visibility: 'hidden', photoCount: 3, href: '/curation/series/ser_hidden' }),
                ]}
                unreadable={0}
            />,
        );
        const list = screen.getByRole('list', { name: 'Series' });
        const items = within(list).getAllByRole('listitem');
        expect(items).toHaveLength(4);
        expect(within(items[0]).getByRole('link', { name: 'Harbor' })).toHaveAttribute('href', '/curation/series/ser_harbor');
        expect(items[0]).toHaveTextContent('Published');
        expect(items[0]).toHaveTextContent('12 photographs');
        expect(items[0]).not.toHaveTextContent('Carried over');
        expect(within(items[1]).getByRole('link', { name: 'Gallery' })).toBeInTheDocument();
        expect(items[1]).toHaveTextContent('1 photograph');
        expect(items[1]).toHaveTextContent('Carried over');
        // A series with no title yet is named as such, never by its ID.
        expect(within(items[2]).getByRole('link', { name: 'Untitled series' })).toHaveAttribute('href', '/curation/series/ser_draft');
        expect(items[2]).toHaveTextContent('Draft');
        expect(items[2]).toHaveTextContent('No photographs');
        expect(items[2]).toHaveTextContent('Not in Work order');
        expect(items[3]).toHaveTextContent('Hidden');
        expect(list).not.toHaveTextContent(/ser_/);
    });

    it("says when there's no series yet, and when some can't be read", () => {
        const { rerender } = render(<SeriesList rows={[]} unreadable={0} />);
        expect(screen.getByText('No series yet. Make the first one with New series.')).toBeInTheDocument();
        rerender(<SeriesList rows={[row()]} unreadable={2} />);
        expect(screen.getByText("2 series can't be read, so they aren't listed. The server log names them.")).toBeInTheDocument();
    });
});

describe('New series', () => {
    it('sends the title and the web address, and labels both', async () => {
        render(<NewSeriesForm />);
        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Night ferries' } });
        fireEvent.change(screen.getByLabelText(/Web address/), { target: { value: 'ferries-at-night' } });
        await submit(screen.getByRole('button', { name: 'Make series' }));
        expect(sent.forms).toEqual([{ action: 'create', fields: { title: 'Night ferries', slug: 'ferries-at-night' } }]);
        expect(screen.getByLabelText('Title')).toHaveAttribute('maxLength', '200');
        expect(screen.getByLabelText(/Web address/)).toHaveAccessibleDescription(/Leave it empty to make one from the title/);
    });

    it('announces a made series with a way to open it, takes focus there, and empties the form', async () => {
        sent.answer = answer('done', 'create', 'Made Night ferries, a draft. Nothing is public until you publish.', { seriesId: 'ser_night-ferries', href: '/curation/series/ser_night-ferries', title: 'Night ferries' });
        render(<NewSeriesForm />);
        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Night ferries' } });
        await submit(screen.getByRole('button', { name: 'Make series' }));
        const status = screen.getByRole('status');
        expect(status).toHaveTextContent('Made Night ferries, a draft. Nothing is public until you publish.');
        expect(within(status).getByRole('link', { name: 'Open Night ferries' })).toHaveAttribute('href', '/curation/series/ser_night-ferries');
        expect(status).toHaveFocus();
        expect(screen.getByLabelText('Title')).toHaveValue('');
    });

    it('shows a refusal by the field it is about, marks the field, and moves focus to it', async () => {
        sent.answer = answer('invalid', 'create', 'Another series has that web address already. Choose another. Nothing was written.', { field: 'slug', seriesId: null });
        render(<NewSeriesForm />);
        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Night ferries' } });
        fireEvent.change(screen.getByLabelText(/Web address/), { target: { value: 'harbor' } });
        await submit(screen.getByRole('button', { name: 'Make series' }));
        const slug = screen.getByLabelText(/Web address/);
        expect(slug).toHaveAttribute('aria-invalid', 'true');
        expect(slug).toHaveAccessibleDescription(/Another series has that web address already/);
        expect(slug).toHaveFocus();
        // What the curator typed stays, so the fix is one change.
        expect(slug).toHaveValue('harbor');
        expect(screen.getByLabelText('Title')).toHaveValue('Night ferries');
    });

    it('announces a busy answer in its region, and focuses it', async () => {
        sent.answer = answer('busy', 'create', 'Another change is being written right now, so nothing was written. Try again in a moment.', { seriesId: null });
        render(<NewSeriesForm />);
        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Night ferries' } });
        await submit(screen.getByRole('button', { name: 'Make series' }));
        const status = screen.getByRole('status');
        expect(status.querySelector('[data-state="busy"]')).toHaveTextContent('Try again in a moment.');
        expect(status).toHaveFocus();
    });

    it("keeps the button focusable and says it can't act while the action is out", async () => {
        let release = () => undefined as void;
        sent.hold = new Promise<void>((resolve) => {
            release = resolve;
        });
        render(<NewSeriesForm />);
        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Night ferries' } });
        const button = screen.getByRole('button', { name: 'Make series' });
        button.focus();
        await submit(button);
        expect(button).toHaveAttribute('aria-disabled', 'true');
        expect(button).not.toBeDisabled();
        expect(button).toHaveFocus();
        // A second press while it's out sends nothing more.
        await submit(button);
        expect(sent.forms).toHaveLength(1);
        await act(async () => release());
        expect(button).not.toHaveAttribute('aria-disabled');
    });
});

describe("a series' page", () => {
    it('opens on what the series holds, and sends every field with the version the page showed', async () => {
        render(<SeriesEditForm detail={detail()} />);
        expect(screen.getByLabelText('Title')).toHaveValue('Harbor');
        expect(screen.getByLabelText('Statement')).toHaveValue('The harbor before the ferries.\n\nA second paragraph.');
        expect(screen.getByLabelText('Short statement')).toHaveValue('The harbor before the ferries.');
        const visibility = screen.getByRole('radiogroup', { name: 'Visibility' });
        expect(within(visibility).getAllByRole('radio').map((radio) => (radio as HTMLInputElement).value)).toEqual(['published', 'draft', 'hidden']);
        expect(within(visibility).getByRole('radio', { name: /Published/ })).toBeChecked();
        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Harbor at first light' } });
        fireEvent.click(within(visibility).getByRole('radio', { name: /Hidden/ }));
        await submit(screen.getByRole('button', { name: 'Save' }));
        expect(sent.forms).toEqual([
            {
                action: 'edit',
                fields: { seriesId: 'ser_harbor', version: '4', title: 'Harbor at first light', statement: 'The harbor before the ferries.\n\nA second paragraph.', shortStatement: 'The harbor before the ferries.', visibility: 'hidden' },
            },
        ]);
        // Nothing the 2b ordering owns, nor the photographs or the carry-over marker, is a field here.
        for (const name of ['photoIds', 'cover', 'chapters', 'openingPhotoId', 'carryOver', 'slug']) expect(document.querySelector(`[name="${name}"]`), name).toBeNull();
    });

    it('caps each field at its limit and labels each one', () => {
        render(<SeriesEditForm detail={detail()} />);
        expect(screen.getByLabelText('Title')).toHaveAttribute('maxLength', '200');
        expect(screen.getByLabelText('Statement')).toHaveAttribute('maxLength', '2000');
        expect(screen.getByLabelText('Short statement')).toHaveAttribute('maxLength', '500');
        expect(screen.getByLabelText('Short statement')).toHaveAccessibleDescription(/Work/);
    });

    it("says a carried-over series is one, and what a statement does to that", () => {
        render(<SeriesEditForm detail={detail({ title: 'Gallery', carriedOver: true, statement: '', shortStatement: '' })} />);
        expect(screen.getByText(/carried over from the legacy Gallery/)).toBeInTheDocument();
    });

    it('answers a stale form with a way to refresh, and focuses the answer', async () => {
        sent.answer = answer('stale', 'edit', 'This series changed since the page loaded, so nothing was written. Refresh to see what it holds now, and edit it again.');
        render(<SeriesEditForm detail={detail()} />);
        await submit(screen.getByRole('button', { name: 'Save' }));
        const status = screen.getByRole('status');
        expect(status.querySelector('[data-state="stale"]')).toHaveTextContent('This series changed since the page loaded');
        expect(within(status).getByRole('link', { name: 'Refresh' })).toHaveAttribute('href', '/curation/series/ser_harbor');
        expect(status).toHaveFocus();
    });

    it('shows a refused field by the field, and moves focus to it', async () => {
        sent.answer = answer('invalid', 'edit', "The short statement has a line break, which it can't hold. Nothing was written.", { field: 'shortStatement' });
        render(<SeriesEditForm detail={detail()} />);
        await submit(screen.getByRole('button', { name: 'Save' }));
        const field = screen.getByLabelText('Short statement');
        expect(field).toHaveAttribute('aria-invalid', 'true');
        expect(field).toHaveAccessibleDescription(/has a line break/);
        expect(field).toHaveFocus();
        expect(screen.getByLabelText('Title')).not.toHaveAttribute('aria-invalid');
    });

    it('announces a save, and focuses the answer once the refreshed form is in', async () => {
        sent.answer = answer('done', 'edit', 'Saved to the draft. Nothing is public until you publish.');
        const { rerender } = render(<SeriesEditForm detail={detail()} />);
        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Harbor at first light' } });
        await submit(screen.getByRole('button', { name: 'Save' }));
        // The page's refresh brings the next version, which the form opens on.
        rerender(<SeriesEditForm detail={detail({ version: 5, title: 'Harbor at first light' })} />);
        const status = screen.getByRole('status');
        expect(status).toHaveTextContent('Saved to the draft. Nothing is public until you publish.');
        expect(status).toHaveFocus();
        expect(screen.getByLabelText('Title')).toHaveValue('Harbor at first light');
        expect(document.querySelector('input[name="version"]')).toHaveValue('5');
    });
});
