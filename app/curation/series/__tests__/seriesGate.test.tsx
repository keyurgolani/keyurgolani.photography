import { act, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUBMIT_GATE_SCRIPT, SUBMIT_GATE_STATUS_TEXT } from '@/components/site/submitGateScript';
import type { OrderActionState, SeriesActionState, SeriesDetail, SeriesOrderView, WorkOrderView } from '@/lib/curation/series-view';
import { disabledSet, gateMarks, serverHtml } from '@/test/helpers/submitGateForms';

// The Series screens' forms at the submit gate (components/site/submitGateScript.ts): New series, Put on Work and
// Featured on Home on the Series screen; Edit series, Add a photograph, Move to a position, Cover, Opening photograph,
// each chapter's Move the start and Add a chapter on a series' page. Each submits by hand, from its handler, so the
// head's script drops a press on it until it has mounted. In the server HTML each waits; once mounted each is ready;
// nothing is disabled for the gate, so with no JavaScript, where nothing gates, the server's markup is all there is;
// and with the head's script, a press before the page hydrates sends nothing, and one after it is sent.

const sent = vi.hoisted(() => ({ forms: [] as string[] }));

vi.mock('../actions', () => {
    const make = (action: string) => async (previous: OrderActionState | SeriesActionState, form: FormData) => {
        sent.forms.push(`${action}:${String(form.get('op') ?? '')}`);
        return previous;
    };
    return { createSeries: make('create'), saveSeries: make('edit'), orderSeries: make('series'), orderWork: make('work') };
});

const { default: NewSeriesForm } = await import('../NewSeriesForm');
const { default: SeriesEditForm } = await import('../SeriesEditForm');
const { default: SequenceEditor } = await import('../SequenceEditor');
const { default: CoverForm } = await import('../CoverForm');
const { default: ChapterEditor } = await import('../ChapterEditor');
const { WorkOrderEditor, FeaturedForm } = await import('../WorkOrder');

const LIVE = `rev_${'b'.repeat(64)}`;
const P = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SERIES = 'ser_harbor';

const ORDER: SeriesOrderView = {
    version: 7,
    published: true,
    photos: [
        { id: P(1), name: 'Ferry at dawn', thumbnailUrl: null },
        { id: P(2), name: 'harbor-2.jpg', thumbnailUrl: null },
        { id: P(3), name: 'harbor-3.jpg', thumbnailUrl: null },
    ],
    cover: { photoId: P(1), focalPoint: { x: 0.4, y: 0.255 } },
    openingPhotoId: P(2),
    chapters: [
        { id: 'ch_dawn', title: 'Dawn', startPhotoId: P(1) },
        { id: 'ch_dusk', title: 'Dusk', startPhotoId: P(3) },
    ],
    addable: [{ id: P(4), name: 'Night ferry', thumbnailUrl: null, heldBy: null }],
};

const DETAIL: SeriesDetail = { id: SERIES, version: 4, title: 'Harbor', slug: 'harbor', statement: 'The harbor before the ferries.\n\nA second paragraph.', shortStatement: 'The harbor before the ferries.', visibility: 'published', photoCount: 3, carriedOver: false, inWorkOrder: true };

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

/** Each form-owning component, as its page renders it, with the forms it holds, by name. */
const SCREENS: { name: string; element: () => ReactElement; forms: string[] }[] = [
    { name: 'New series', element: () => <NewSeriesForm activeRevisionId={LIVE} />, forms: ['New series'] },
    { name: 'Work order', element: () => <WorkOrderEditor work={WORK} activeRevisionId={LIVE} />, forms: ['Put on Work'] },
    { name: 'Featured on Home', element: () => <FeaturedForm work={WORK} activeRevisionId={LIVE} />, forms: ['Featured on Home'] },
    { name: 'Edit series', element: () => <SeriesEditForm detail={DETAIL} activeRevisionId={LIVE} />, forms: ['Edit series'] },
    { name: 'the sequence', element: () => <SequenceEditor seriesId={SERIES} order={ORDER} activeRevisionId={LIVE} />, forms: ['Add a photograph', 'Move to a position'] },
    { name: 'the cover', element: () => <CoverForm seriesId={SERIES} order={ORDER} activeRevisionId={LIVE} />, forms: ['Cover', 'Opening photograph'] },
    { name: 'the chapters', element: () => <ChapterEditor seriesId={SERIES} order={ORDER} activeRevisionId={LIVE} />, forms: ['Move the start of Dawn (at 1)', 'Move the start of Dusk (at 3)', 'Add a chapter'] },
];

beforeEach(() => {
    sent.forms = [];
});

describe("the Series screens' forms at the submit gate", () => {
    for (const { name, element, forms } of SCREENS) {
        it(`${name}: every form waits at the gate in the server HTML, with nothing disabled for it`, () => {
            const html = serverHtml(element());
            expect(gateMarks(html)).toEqual(forms.map((form) => [form, 'waiting']));
            // Without JavaScript nothing gates, so nothing is disabled for want of it: the server's disabled set is the mounted page's.
            const { container, unmount } = render(element());
            expect(disabledSet(html)).toEqual(disabledSet(container));
            unmount();
        });

        it(`${name}: every form says it is ready once mounted`, () => {
            const { container } = render(element());
            expect(gateMarks(container)).toEqual(forms.map((form) => [form, 'ready']));
        });
    }

    it('holds ten form sites in all, a chapter move counted once', () => {
        expect(new Set(SCREENS.flatMap(({ forms }) => forms.map((form) => form.replace(/^Move the start of .*/, 'Move the start')))).size).toBe(10);
    });
});

describe('with the head script, before and after the page hydrates', () => {
    let root: Root | null = null;
    let host: HTMLElement | null = null;
    // The head's script, as the page runs it, before any of the page's scripts: once for this file, as once for a page.
    beforeAll(() => {
        new Function(SUBMIT_GATE_SCRIPT)();
    });

    afterEach(() => {
        act(() => root?.unmount());
        root = null;
        host?.remove();
        host = null;
    });

    for (const { name, element, forms } of SCREENS) {
        it(`${name}: a press before hydration sends nothing and says the page is still loading, and once ready a press is sent`, async () => {
            host = document.body.appendChild(document.createElement('div'));
            host.innerHTML = serverHtml(element()).innerHTML;
            const all = () => [...(host as HTMLElement).querySelectorAll('form')];
            expect(all()).toHaveLength(forms.length);
            for (const form of all()) {
                const press = new Event('submit', { bubbles: true, cancelable: true });
                form.dispatchEvent(press);
                expect(press.defaultPrevented).toBe(true);
            }
            await new Promise((done) => setTimeout(done, 150));
            expect(document.querySelector('[data-submit-gate-status]')).toHaveTextContent(SUBMIT_GATE_STATUS_TEXT);
            await act(async () => {
                root = hydrateRoot(host as HTMLElement, element(), { onRecoverableError: () => undefined });
            });
            expect(sent.forms).toEqual([]);
            for (const form of all()) expect(form).toHaveAttribute('data-submit-gate', 'ready');
            // Once no form waits, the status goes.
            await act(async () => undefined);
            expect(document.querySelector('[data-submit-gate-status]')).toBeNull();
            const first = all()[0];
            await act(async () => {
                first.requestSubmit();
            });
            expect(sent.forms).toHaveLength(1);
        });
    }
});
