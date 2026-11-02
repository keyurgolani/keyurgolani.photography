import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderActionState, SeriesDetail, SeriesOrderView, WorkOrderView } from '@/lib/curation/series-view';

// #150's 2b: a series' page's ordering sections and the Series screen's Work order and featured boxes, as the curator
// sees them, with the server actions stood in for, so what each control sends, where focus goes after each answer,
// and what's read out are checked here, and what each action does is lib/curation/__tests__/seriesOrder.test.ts's.
// Every control is a native button or form field, so the keyboard reaches and works each one; e2e/curation-series
// presses the keys.

// `answer` is what the next action answers; `hold`, when set, keeps every action pending until the test lets it go.
const sent = vi.hoisted(() => ({ forms: [] as { action: string; fields: Record<string, string | string[]> }[], answer: null as OrderActionState | null, hold: null as Promise<void> | null }));

vi.mock('../actions', () => {
    const make = (action: string) => async (_previous: OrderActionState, form: FormData): Promise<OrderActionState> => {
        const fields: Record<string, string | string[]> = {};
        for (const name of new Set(form.keys())) {
            const values = form.getAll(name).map(String);
            fields[name] = values.length === 1 && name !== 'featured' ? values[0] : values;
        }
        sent.forms.push({ action, fields });
        if (sent.hold) await sent.hold;
        return sent.answer ?? { status: 'done', action: (fields.op ?? 'move') as never, message: 'Done.', serial: sent.forms.length };
    };
    return { createSeries: make('create'), saveSeries: make('edit'), orderSeries: make('series'), orderWork: make('work') };
});

const { default: SequenceEditor } = await import('../SequenceEditor');
const { default: CoverForm } = await import('../CoverForm');
const { default: ChapterEditor } = await import('../ChapterEditor');
const { WorkOrderEditor, FeaturedForm } = await import('../WorkOrder');
const { default: SeriesEditForm } = await import('../SeriesEditForm');

const LIVE = `rev_${'b'.repeat(64)}`;
const P = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SERIES = 'ser_harbor';
const CARRIED = { seriesId: SERIES, version: '7', base: LIVE };

beforeEach(() => {
    sent.forms = [];
    sent.answer = null;
    sent.hold = null;
});

function order(overrides: Partial<SeriesOrderView> = {}): SeriesOrderView {
    return {
        version: 7,
        published: true,
        photos: [
            { id: P(1), name: 'Ferry at dawn', thumbnailUrl: `/api/curation/media/${P(1)}/sha256-${'a'.repeat(64)}/p_${'c'.repeat(16)}/w400.webp` },
            { id: P(2), name: 'harbor-2.jpg', thumbnailUrl: null },
            { id: P(3), name: 'harbor-3.jpg', thumbnailUrl: null },
        ],
        cover: { photoId: P(1), focalPoint: { x: 0.4, y: 0.255 } },
        openingPhotoId: P(2),
        chapters: [{ id: 'ch_dawn', title: 'Dawn', startPhotoId: P(1) }, { id: 'ch_dusk', title: 'Dusk', startPhotoId: P(3) }],
        addable: [
            { id: P(4), name: 'Night ferry', thumbnailUrl: null, heldBy: null },
            { id: P(5), name: 'salt-1.jpg', thumbnailUrl: null, heldBy: 'Salt roads' },
        ],
        ...overrides,
    };
}

const answer = (status: Exclude<OrderActionState, { status: 'idle' }>['status'], action: Exclude<OrderActionState, { status: 'idle' }>['action'], message: string, extra: Partial<Exclude<OrderActionState, { status: 'idle' }>> = {}): OrderActionState => ({ status, action, message, serial: 1, ...extra });

async function press(button: HTMLElement) {
    await act(async () => {
        fireEvent.click(button);
    });
}

const sequence = () => screen.getByRole('list', { name: 'Photographs in order' });

describe("a series' sequence", () => {
    it('lists the photographs in order, each by its place and name with its thumbnail, and what it is to the series, never by ID', () => {
        render(<SequenceEditor seriesId={SERIES} order={order()} activeRevisionId={LIVE} />);
        const rows = within(sequence()).getAllByRole('listitem');
        expect(rows.map((row) => row.querySelector('[class*="memberName"]')?.textContent)).toEqual(['1. Ferry at dawn', '2. harbor-2.jpg', '3. harbor-3.jpg']);
        expect(rows[0]).toHaveTextContent('Cover');
        expect(rows[0]).toHaveTextContent('Starts the chapter Dawn');
        expect(rows[1]).toHaveTextContent('Opening photograph');
        expect(rows[2]).toHaveTextContent('Starts the chapter Dusk');
        // The curator-only route's thumbnail, with an empty alt since the name beside it names it; a square holds the place of one not ready.
        const thumb = rows[0].querySelector('img');
        expect(thumb).toHaveAttribute('src', expect.stringMatching(/^\/api\/curation\/media\/.+\/w400\.webp$/));
        expect(thumb).toHaveAttribute('alt', '');
        expect(rows[1].querySelector('img')).toBeNull();
        expect(rows[1].querySelector('[data-thumb="none"]')).toHaveAttribute('aria-hidden', 'true');
        expect(sequence()).not.toHaveTextContent(/ph_|ser_|ch_/);
    });

    it("gives each row's buttons names of their own that start with what they say, as native buttons the keyboard works, even when titles repeat", () => {
        // Two photographs titled alike: the place tells their buttons apart (contract rule 2).
        const photos = order().photos.map((photo, index) => (index < 2 ? { ...photo, name: 'Dusk' } : photo));
        render(<SequenceEditor seriesId={SERIES} order={order({ photos })} activeRevisionId={LIVE} />);
        const buttons = within(sequence()).getAllByRole('button');
        const names = buttons.map((button) => button.getAttribute('aria-label'));
        expect(names).toEqual(['Move up: 1. Dusk', 'Move down: 1. Dusk', 'Remove: 1. Dusk', 'Move up: 2. Dusk', 'Move down: 2. Dusk', 'Remove: 2. Dusk', 'Move up: 3. harbor-3.jpg', 'Move down: 3. harbor-3.jpg', 'Remove: 3. harbor-3.jpg']);
        expect(new Set(names).size).toBe(names.length);
        for (const button of buttons) {
            // The name starts with the words the button shows (WCAG 2.5.3).
            expect(button.getAttribute('aria-label')?.startsWith(`${button.textContent}: `), button.textContent ?? '').toBe(true);
            expect(button).toHaveAttribute('type', 'button');
            expect(button).not.toBeDisabled();
            expect(button).not.toHaveAttribute('tabindex');
        }
        // The first can't go up nor the last down: they say so, and stay focusable where they are.
        expect(screen.getByRole('button', { name: 'Move up: 1. Dusk' })).toHaveAttribute('aria-disabled', 'true');
        expect(screen.getByRole('button', { name: 'Move down: 3. harbor-3.jpg' })).toHaveAttribute('aria-disabled', 'true');
        expect(screen.getByRole('button', { name: 'Move down: 1. Dusk' })).not.toHaveAttribute('aria-disabled');
    });

    it('moves a photograph up or down by its position, with the version and the live revision the page showed', async () => {
        render(<SequenceEditor seriesId={SERIES} order={order()} activeRevisionId={LIVE} />);
        await press(screen.getByRole('button', { name: 'Move down: 1. Ferry at dawn' }));
        await press(screen.getByRole('button', { name: 'Move up: 3. harbor-3.jpg' }));
        await press(screen.getByRole('button', { name: 'Remove: 2. harbor-2.jpg' }));
        // The first one's Move up sends nothing.
        await press(screen.getByRole('button', { name: 'Move up: 1. Ferry at dawn' }));
        expect(sent.forms).toEqual([
            { action: 'series', fields: { ...CARRIED, op: 'move', photoId: P(1), position: '2' } },
            { action: 'series', fields: { ...CARRIED, op: 'move', photoId: P(3), position: '2' } },
            { action: 'series', fields: { ...CARRIED, op: 'remove', photoId: P(2) } },
        ]);
    });

    it('keeps focus on the button pressed, on the moved photograph\'s new row, and reads the answer out', async () => {
        sent.answer = answer('done', 'move', 'Moved Ferry at dawn to position 2 of 3. Nothing is public until you publish.');
        const { rerender } = render(<SequenceEditor seriesId={SERIES} order={order()} activeRevisionId={LIVE} />);
        const down = screen.getByRole('button', { name: 'Move down: 1. Ferry at dawn' });
        down.focus();
        await press(down);
        // The page's refresh brings the next version, in the new order.
        const [first, second, third] = order().photos;
        rerender(<SequenceEditor seriesId={SERIES} order={order({ version: 8, photos: [second, first, third] })} activeRevisionId={LIVE} />);
        // Its name follows it to its new place.
        expect(screen.getByRole('button', { name: 'Move down: 2. Ferry at dawn' })).toHaveFocus();
        expect(within(sequence()).getAllByRole('listitem')[1]).toHaveTextContent('2. Ferry at dawn');
        const status = screen.getAllByRole('status')[0];
        expect(status).toHaveAttribute('aria-live', 'polite');
        expect(status).toHaveTextContent('Moved Ferry at dawn to position 2 of 3.');
        // And the next press carries the new version.
        await press(screen.getByRole('button', { name: 'Move down: 2. Ferry at dawn' }));
        expect(sent.forms.at(-1)?.fields).toMatchObject({ version: '8', position: '3' });
    });

    it('focuses the answer after a remove, and after a stale move, with a way to refresh', async () => {
        sent.answer = answer('done', 'remove', 'Took harbor-2.jpg out of the series. Nothing is public until you publish.');
        const { unmount } = render(<SequenceEditor seriesId={SERIES} order={order()} activeRevisionId={LIVE} />);
        await press(screen.getByRole('button', { name: 'Remove: 2. harbor-2.jpg' }));
        expect(screen.getAllByRole('status')[0]).toHaveFocus();
        expect(screen.getAllByRole('status')[0]).toHaveTextContent('Took harbor-2.jpg out of the series.');
        unmount();
        sent.answer = answer('stale', 'move', 'This series changed since the page loaded, so nothing was written. Refresh to see what it holds now, and edit it again.');
        render(<SequenceEditor seriesId={SERIES} order={order()} activeRevisionId={LIVE} />);
        await press(screen.getByRole('button', { name: 'Move down: 1. Ferry at dawn' }));
        const status = screen.getAllByRole('status')[0];
        expect(status).toHaveFocus();
        expect(within(status).getByRole('link', { name: 'Refresh' })).toHaveAttribute('href', `/curation/series/${SERIES}`);
    });

    it('keeps every button focusable and sends nothing more while an action is out', async () => {
        let release = () => undefined as void;
        sent.hold = new Promise<void>((resolve) => {
            release = resolve;
        });
        render(<SequenceEditor seriesId={SERIES} order={order()} activeRevisionId={LIVE} />);
        const down = screen.getByRole('button', { name: 'Move down: 1. Ferry at dawn' });
        down.focus();
        await press(down);
        expect(down).toHaveFocus();
        for (const button of within(sequence()).getAllByRole('button')) expect(button).toHaveAttribute('aria-disabled', 'true');
        await press(screen.getByRole('button', { name: 'Remove: 2. harbor-2.jpg' }));
        expect(sent.forms).toHaveLength(1);
        await act(async () => release());
        expect(screen.getByRole('button', { name: 'Remove: 2. harbor-2.jpg' })).not.toHaveAttribute('aria-disabled');
    });

    it("keeps focus on the first press's row when a second press comes while the first is out", async () => {
        let release = () => undefined as void;
        sent.hold = new Promise<void>((resolve) => {
            release = resolve;
        });
        sent.answer = answer('done', 'move', 'Moved Ferry at dawn to position 2 of 3. Nothing is public until you publish.');
        const { rerender } = render(<SequenceEditor seriesId={SERIES} order={order()} activeRevisionId={LIVE} />);
        await press(screen.getByRole('button', { name: 'Move down: 1. Ferry at dawn' }));
        // A second press, on another row, before the first answer: it sends nothing, and changes nothing.
        await press(screen.getByRole('button', { name: 'Move down: 2. harbor-2.jpg' }));
        expect(sent.forms).toHaveLength(1);
        await act(async () => release());
        const [first, second, third] = order().photos;
        rerender(<SequenceEditor seriesId={SERIES} order={order({ version: 8, photos: [second, first, third] })} activeRevisionId={LIVE} />);
        expect(screen.getByRole('button', { name: 'Move down: 2. Ferry at dawn' })).toHaveFocus();
    });

    it('adds an approved photograph at the position chosen, grouped by where it is now, and empties the form after', async () => {
        sent.answer = answer('done', 'insert', 'Added Night ferry at position 2 of 4. Nothing is public until you publish.');
        const { rerender } = render(<SequenceEditor seriesId={SERIES} order={order()} activeRevisionId={LIVE} />);
        const add = within(screen.getByRole('form', { name: 'Add a photograph' }));
        const photo = add.getByLabelText('Photograph') as HTMLSelectElement;
        expect(add.getByRole('group', { name: 'In no series' })).toHaveTextContent('Night ferry');
        expect(add.getByRole('group', { name: 'In another series' })).toHaveTextContent('salt-1.jpg, in Salt roads');
        const position = add.getByLabelText('Position') as HTMLSelectElement;
        expect([...position.options].map((option) => option.textContent)).toEqual(['1, the start', '2, after Ferry at dawn', '3, after harbor-2.jpg', '4, the end']);
        expect(position).toHaveValue('4');
        fireEvent.change(photo, { target: { value: P(4) } });
        fireEvent.change(position, { target: { value: '2' } });
        await press(add.getByRole('button', { name: 'Add' }));
        expect(sent.forms).toEqual([{ action: 'series', fields: { photoId: P(4), position: '2', ...CARRIED, op: 'insert' } }]);
        // The page's refresh brings the series with four photographs, and the form opens empty on the new end.
        const [first, second, third] = order().photos;
        rerender(<SequenceEditor seriesId={SERIES} order={order({ version: 8, photos: [first, { id: P(4), name: 'Night ferry', thumbnailUrl: null }, second, third], addable: [order().addable[1]] })} activeRevisionId={LIVE} />);
        expect(screen.getAllByRole('status')[0]).toHaveFocus();
        expect(add.getByLabelText('Photograph')).toHaveValue('');
        const after = add.getByLabelText('Position') as HTMLSelectElement;
        expect([...after.options].map((option) => option.textContent)).toEqual(['1, the start', '2, after Ferry at dawn', '3, after Night ferry', '4, after harbor-2.jpg', '5, the end']);
        expect(after).toHaveValue('5');
        // So the next Add, left as it opens, goes last.
        fireEvent.change(add.getByLabelText('Photograph'), { target: { value: P(5) } });
        await press(add.getByRole('button', { name: 'Add' }));
        expect(sent.forms.at(-1)?.fields).toMatchObject({ photoId: P(5), position: '5', version: '8' });
    });

    it('shows a refused photograph by the field, marks it, and moves focus there', async () => {
        sent.answer = answer('invalid', 'insert', 'Choose a photograph to add. Nothing was written.', { field: 'addPhoto' });
        render(<SequenceEditor seriesId={SERIES} order={order()} activeRevisionId={LIVE} />);
        const add = within(screen.getByRole('form', { name: 'Add a photograph' }));
        await press(add.getByRole('button', { name: 'Add' }));
        const photo = add.getByLabelText('Photograph');
        expect(photo).toHaveFocus();
        expect(photo).toHaveAttribute('aria-invalid', 'true');
        expect(photo).toHaveAccessibleDescription(/Choose a photograph to add/);
    });

    it('moves a photograph straight to a position, for a long series', async () => {
        render(<SequenceEditor seriesId={SERIES} order={order()} activeRevisionId={LIVE} />);
        const form = within(screen.getByRole('form', { name: 'Move to a position' }));
        fireEvent.change(form.getByLabelText('Photograph'), { target: { value: P(3) } });
        fireEvent.change(form.getByLabelText('To position'), { target: { value: '1' } });
        await press(form.getByRole('button', { name: 'Move' }));
        expect(sent.forms).toEqual([{ action: 'series', fields: { photoId: P(3), position: '1', ...CARRIED, op: 'move' } }]);
    });

    it('says when nothing is free to add, and when the series has no photographs', () => {
        render(<SequenceEditor seriesId={SERIES} order={order({ photos: [], addable: [], cover: null, chapters: [], openingPhotoId: null })} activeRevisionId={null} />);
        expect(screen.getByText('No photographs yet. Add one below.')).toBeInTheDocument();
        expect(screen.getByText(/No approved photograph is free to add/)).toBeInTheDocument();
        expect(screen.queryByRole('form', { name: 'Move to a position' })).toBeNull();
    });
});

describe('the cover and the opening photograph', () => {
    it('opens on the cover and its focal point as percentages, and sets them with the version the page showed', async () => {
        render(<CoverForm seriesId={SERIES} order={order()} activeRevisionId={LIVE} />);
        const form = within(screen.getByRole('form', { name: 'Cover' }));
        expect(form.getByLabelText('Cover photograph')).toHaveValue(P(1));
        expect(form.getByRole('radio', { name: 'At the point below' })).toBeChecked();
        expect(form.getByLabelText('Across, %')).toHaveValue(40);
        expect(form.getByLabelText('Down, %')).toHaveValue(25.5);
        expect(form.getByRole('group', { name: 'Focal point' })).toHaveAccessibleDescription(/0% across is the left edge/);
        fireEvent.change(form.getByLabelText('Cover photograph'), { target: { value: P(2) } });
        fireEvent.change(form.getByLabelText('Across, %'), { target: { value: '60' } });
        await press(form.getByRole('button', { name: 'Set cover' }));
        expect(sent.forms).toEqual([{ action: 'series', fields: { photoId: P(2), focal: 'set', focalX: '60', focalY: '25.5', ...CARRIED, op: 'cover' } }]);
        expect(screen.getByRole('status')).toHaveFocus();
    });

    it('sets the opening photograph, or none', async () => {
        render(<CoverForm seriesId={SERIES} order={order()} activeRevisionId={LIVE} />);
        const form = within(screen.getByRole('form', { name: 'Opening photograph' }));
        const select = form.getByLabelText('Opening photograph') as HTMLSelectElement;
        expect(select).toHaveValue(P(2));
        expect(select.options[0]).toHaveTextContent('None: open on the first photograph');
        fireEvent.change(select, { target: { value: 'none' } });
        await press(form.getByRole('button', { name: 'Set opening photograph' }));
        expect(sent.forms).toEqual([{ action: 'series', fields: { photoId: 'none', ...CARRIED, op: 'opening' } }]);
    });

    it('shows a refused focal point by its fields, and moves focus there', async () => {
        sent.answer = answer('invalid', 'cover', 'A focal point is two numbers from 0 to 100: how far across the photograph, and how far down. Nothing was written.', { field: 'focal' });
        render(<CoverForm seriesId={SERIES} order={order()} activeRevisionId={LIVE} />);
        await press(screen.getByRole('button', { name: 'Set cover' }));
        const across = screen.getByLabelText('Across, %');
        expect(across).toHaveFocus();
        expect(across).toHaveAttribute('aria-invalid', 'true');
        expect(across).toHaveAccessibleDescription(/two numbers from 0 to 100/);
    });

    it('asks for photographs first when the series has none', () => {
        render(<CoverForm seriesId={SERIES} order={order({ photos: [], cover: null, openingPhotoId: null, chapters: [] })} activeRevisionId={LIVE} />);
        expect(screen.getByText(/Add photographs first/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Set cover' })).toBeNull();
    });
});

describe('chapters', () => {
    it('lists each chapter by its title and start, and moves its start or removes it', async () => {
        render(<ChapterEditor seriesId={SERIES} order={order()} activeRevisionId={LIVE} />);
        const list = screen.getByRole('list', { name: 'Chapters' });
        const [dawn, dusk] = within(list).getAllByRole('listitem');
        expect(dawn).toHaveTextContent('Dawn');
        expect(dawn).toHaveTextContent('Starts at 1. Ferry at dawn');
        expect(dusk).toHaveTextContent('Starts at 3. harbor-3.jpg');
        expect(list).not.toHaveTextContent(/ch_|ph_/);
        fireEvent.change(within(dusk).getByLabelText('Starts at: Dusk (at 3)'), { target: { value: P(2) } });
        await press(within(dusk).getByRole('button', { name: 'Move start: Dusk (at 3)' }));
        await press(within(dawn).getByRole('button', { name: 'Remove chapter: Dawn (at 1)' }));
        expect(sent.forms).toEqual([
            { action: 'series', fields: { startPhotoId: P(2), ...CARRIED, op: 'chapter-move', chapterId: 'ch_dusk' } },
            { action: 'series', fields: { ...CARRIED, op: 'chapter-remove', chapterId: 'ch_dawn' } },
        ]);
    });

    it('names two chapters titled alike by where each starts, so no two controls share a name', () => {
        render(<ChapterEditor seriesId={SERIES} order={order({ chapters: [{ id: 'ch_a', title: 'Dawn', startPhotoId: P(1) }, { id: 'ch_b', title: 'Dawn', startPhotoId: P(3) }] })} activeRevisionId={LIVE} />);
        const list = screen.getByRole('list', { name: 'Chapters' });
        const named = [...within(list).getAllByRole('button'), ...within(list).getAllByRole('combobox'), ...within(list).getAllByRole('form')].map((element) => element.getAttribute('aria-label'));
        expect(named).toEqual(['Move start: Dawn (at 1)', 'Remove chapter: Dawn (at 1)', 'Move start: Dawn (at 3)', 'Remove chapter: Dawn (at 3)', 'Starts at: Dawn (at 1)', 'Starts at: Dawn (at 3)', 'Move the start of Dawn (at 1)', 'Move the start of Dawn (at 3)']);
        expect(new Set(named).size).toBe(named.length);
    });

    it('adds a chapter with a title and a start, and empties the form after', async () => {
        sent.answer = answer('done', 'chapter-add', 'Added the chapter Noon, starting at harbor-2.jpg. Nothing is public until you publish.');
        render(<ChapterEditor seriesId={SERIES} order={order()} activeRevisionId={LIVE} />);
        const form = within(screen.getByRole('form', { name: 'Add a chapter' }));
        fireEvent.change(form.getByLabelText('Chapter title'), { target: { value: 'Noon' } });
        fireEvent.change(form.getByLabelText('Starts at'), { target: { value: P(2) } });
        await press(form.getByRole('button', { name: 'Add chapter' }));
        expect(sent.forms).toEqual([{ action: 'series', fields: { title: 'Noon', startPhotoId: P(2), ...CARRIED, op: 'chapter-add' } }]);
        const status = screen.getByRole('status');
        expect(status).toHaveFocus();
        expect(status).toHaveTextContent('Added the chapter Noon');
        expect(form.getByLabelText('Chapter title')).toHaveValue('');
    });

    it("shows a refused title by the field, keeping what was typed, and a refused move's start in the answer", async () => {
        sent.answer = answer('invalid', 'chapter-add', "The chapter title has a line break, which it can't hold. Nothing was written.", { field: 'chapterTitle' });
        const { unmount } = render(<ChapterEditor seriesId={SERIES} order={order()} activeRevisionId={LIVE} />);
        const form = within(screen.getByRole('form', { name: 'Add a chapter' }));
        fireEvent.change(form.getByLabelText('Chapter title'), { target: { value: 'Noon' } });
        await press(form.getByRole('button', { name: 'Add chapter' }));
        const title = form.getByLabelText('Chapter title');
        expect(title).toHaveFocus();
        expect(title).toHaveAttribute('aria-invalid', 'true');
        expect(title).toHaveAccessibleDescription(/has a line break/);
        expect(title).toHaveValue('Noon');
        unmount();
        sent.answer = answer('invalid', 'chapter-move', 'The chapter Dusk would start out of order: each chapter starts after the one above it. Nothing was written.', { field: 'chapterStart' });
        render(<ChapterEditor seriesId={SERIES} order={order()} activeRevisionId={LIVE} />);
        await press(screen.getByRole('button', { name: 'Move start: Dusk (at 3)' }));
        const status = screen.getByRole('status');
        expect(status).toHaveFocus();
        expect(status).toHaveTextContent('The chapter Dusk would start out of order');
    });
});

describe("the Series screen's Work order and featured series", () => {
    const WORK: WorkOrderView = {
        version: 3,
        order: [
            { id: 'ser_harbor', title: 'Harbor', visibility: 'published' },
            { id: 'ser_coast', title: 'Coast', visibility: 'published' },
        ],
        offWork: [{ id: 'ser_roads', title: 'Salt roads', visibility: 'draft' }],
        all: [
            { id: 'ser_harbor', title: 'Harbor', visibility: 'published' },
            { id: 'ser_coast', title: 'Coast', visibility: 'published' },
            { id: 'ser_roads', title: 'Salt roads', visibility: 'draft' },
        ],
        featured: ['ser_harbor'],
    };
    const SITE = { version: '3', base: LIVE };

    it('lists Work order by title, moves a series by keyboard-operable buttons, and keeps focus on the one pressed', async () => {
        sent.answer = answer('done', 'work-order', 'Moved Coast to place 1 of 2 in Work order. Nothing is public until you publish.');
        const { rerender } = render(<WorkOrderEditor work={WORK} activeRevisionId={LIVE} />);
        const list = screen.getByRole('list', { name: 'Work order' });
        expect(within(list).getAllByRole('listitem').map((row) => row.textContent)).toEqual([expect.stringMatching(/^1\. Harbor/), expect.stringMatching(/^2\. Coast/)]);
        expect(list).not.toHaveTextContent(/ser_/);
        const up = screen.getByRole('button', { name: 'Move up: 2. Coast' });
        up.focus();
        await press(up);
        expect(sent.forms).toEqual([{ action: 'work', fields: { ...SITE, op: 'work-order', seriesId: 'ser_coast', move: 'up' } }]);
        rerender(<WorkOrderEditor work={{ ...WORK, version: 4, order: [WORK.order[1], WORK.order[0]] }} activeRevisionId={LIVE} />);
        expect(screen.getByRole('button', { name: 'Move up: 1. Coast' })).toHaveFocus();
        expect(screen.getByRole('button', { name: 'Move up: 1. Coast' })).toHaveAttribute('aria-disabled', 'true');
        expect(screen.getByRole('status')).toHaveTextContent('Moved Coast to place 1 of 2 in Work order.');
    });

    it('names two series titled alike by their place, so no two buttons share a name', () => {
        render(<WorkOrderEditor work={{ ...WORK, order: [WORK.order[0], { ...WORK.order[1], title: 'Harbor' }] }} activeRevisionId={LIVE} />);
        const names = within(screen.getByRole('list', { name: 'Work order' })).getAllByRole('button').map((button) => button.getAttribute('aria-label'));
        expect(names).toEqual(['Move up: 1. Harbor', 'Move down: 1. Harbor', 'Take off Work: 1. Harbor', 'Move up: 2. Harbor', 'Move down: 2. Harbor', 'Take off Work: 2. Harbor']);
    });

    it("keeps focus on the first press's row when a second press comes while the first is out", async () => {
        let release = () => undefined as void;
        sent.hold = new Promise<void>((resolve) => {
            release = resolve;
        });
        sent.answer = answer('done', 'work-order', 'Moved Coast to place 1 of 2 in Work order. Nothing is public until you publish.');
        const { rerender } = render(<WorkOrderEditor work={WORK} activeRevisionId={LIVE} />);
        await press(screen.getByRole('button', { name: 'Move up: 2. Coast' }));
        await press(screen.getByRole('button', { name: 'Move down: 1. Harbor' }));
        expect(sent.forms).toHaveLength(1);
        await act(async () => release());
        rerender(<WorkOrderEditor work={{ ...WORK, version: 4, order: [WORK.order[1], WORK.order[0]] }} activeRevisionId={LIVE} />);
        expect(screen.getByRole('button', { name: 'Move up: 1. Coast' })).toHaveFocus();
    });

    it('takes a series off Work, puts one on, last, and focuses the answer', async () => {
        render(<WorkOrderEditor work={WORK} activeRevisionId={null} />);
        await press(screen.getByRole('button', { name: 'Take off Work: 1. Harbor' }));
        expect(screen.getByRole('status')).toHaveFocus();
        const form = within(screen.getByRole('form', { name: 'Put on Work' }));
        expect(form.getByLabelText('Series')).toHaveTextContent('Salt roads, draft');
        await press(form.getByRole('button', { name: 'Put on Work, last' }));
        expect(sent.forms).toEqual([
            { action: 'work', fields: { version: '3', base: 'none', op: 'work-order', seriesId: 'ser_harbor', move: 'off' } },
            { action: 'work', fields: { seriesId: 'ser_roads', version: '3', base: 'none', op: 'work-order', move: 'on' } },
        ]);
    });

    it('offers each published series to feature, and one featured now whatever it is, and sends the ticked ones', async () => {
        render(<FeaturedForm work={{ ...WORK, featured: ['ser_harbor', 'ser_roads'] }} activeRevisionId={LIVE} />);
        const group = screen.getByRole('group', { name: 'Featured series' });
        const boxes = within(group).getAllByRole('checkbox');
        expect(boxes.map((box) => (box.closest('label') as HTMLElement).textContent)).toEqual(['Harbor', 'Coast', 'Salt roads, draft']);
        expect(boxes.map((box) => (box as HTMLInputElement).checked)).toEqual([true, false, true]);
        expect(group).toHaveAccessibleDescription(/Only a published series can be featured/);
        fireEvent.click(boxes[1]);
        fireEvent.click(boxes[2]);
        await press(screen.getByRole('button', { name: 'Save featured' }));
        expect(sent.forms).toEqual([{ action: 'work', fields: { featured: ['ser_harbor', 'ser_coast'], ...SITE, op: 'featured' } }]);
        expect(screen.getByRole('status')).toHaveFocus();
    });
});

describe("a series' text form beside its order", () => {
    it('keeps what was typed when an order change brings the next version, and saves with that version', async () => {
        const detail: SeriesDetail = { id: SERIES, version: 7, title: 'Harbor', slug: 'harbor', statement: 'The harbor.', shortStatement: 'The harbor.', visibility: 'published', photoCount: 3, carriedOver: false, inWorkOrder: true };
        const { rerender } = render(<SeriesEditForm detail={detail} activeRevisionId={LIVE} />);
        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Harbor at first light' } });
        rerender(<SeriesEditForm detail={{ ...detail, version: 8 }} activeRevisionId={LIVE} />);
        expect(screen.getByLabelText('Title')).toHaveValue('Harbor at first light');
        await press(screen.getByRole('button', { name: 'Save' }));
        expect(sent.forms[0].fields).toMatchObject({ version: '8', title: 'Harbor at first light' });
    });
});
