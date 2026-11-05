import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LedgerRow, PublishState, ScreenView, WatchAnswer } from '@/lib/curation/publish-facts';
import { setDataDir } from '@/test/helpers/tempDataRoot';
import { BREAKWATER_TITLE, createPublishFixture, type PublishFixture } from '@/test/helpers/publishFixture';

// #16's Publish screen (16-3): the client screen rendered from a real page
// read, for the markup the browser tests and shots can't see. One live region,
// present and empty; the bar's form; the badge before the review state; the
// summary as the row's focus target; and the frame out of the Tab order with
// no second "Visitor preview" region. Test values only.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

let fixture: PublishFixture;
let restore: () => void;
let view: ScreenView;

beforeAll(async () => {
    fixture = await createPublishFixture();
    restore = setDataDir(fixture.root);
    const { loadPublishPage } = await import('../load');
    const page = await loadPublishPage();
    if (page.state !== 'ready') throw new Error(`The page is ${page.state}`);
    view = page.view;
}, 60_000);

afterAll(async () => {
    restore();
    await fixture.cleanup();
});

const action = async (previous: PublishState) => previous;

describe('PublishScreen', () => {
    it('renders the draft with one empty live region, the bar in a form, and the frame out of the Tab order', async () => {
        const { default: PublishScreen } = await import('../PublishScreen');
        const { container } = render(<PublishScreen view={view} previewHref="/curation/preview/x" openFix={null} action={action} />);
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Preview catalog revision 3');
        const regions = container.querySelectorAll('[role="status"]');
        expect(regions).toHaveLength(1);
        expect(regions[0].parentElement?.tagName).toBe('MAIN');
        expect(regions[0]).toHaveTextContent('');
        const form = container.querySelector('form[data-sticky-bar]');
        expect(form).not.toBeNull();
        expect(within(form as HTMLElement).getByRole('button', { name: 'Validate revision' })).toBeInTheDocument();
        expect(within(form as HTMLElement).getByRole('button', { name: 'Publish revision 3' })).toHaveAttribute('aria-disabled', 'true');
        expect(within(form as HTMLElement).getByRole('button', { name: 'Publish revision 3' })).toHaveAttribute('aria-describedby', 'publish-reason');
        expect(container.querySelector('iframe')).toHaveAttribute('inert');
        expect(screen.queryAllByRole('region', { name: 'Visitor preview' })).toHaveLength(1);
    });

    it('puts Blocks publishing first in a blocking row, and makes the summary its focus target described by that line', async () => {
        const { default: PublishScreen } = await import('../PublishScreen');
        const { container } = render(<PublishScreen view={view} previewHref="/curation/preview/x" openFix={null} action={action} />);
        const summary = screen.getByText(`Add ${BREAKWATER_TITLE} to Low Tide Hours after photograph 04`);
        expect(summary).toHaveAttribute('tabindex', '-1');
        const meta = container.querySelector(`#${summary.getAttribute('aria-describedby')}`);
        expect(meta?.textContent?.replace(/\s+/g, ' ').trim()).toMatch(/^Blocks publishing, Generated · not reviewed, New$/);
        expect(container.querySelectorAll('li[data-blocks="true"]')).toHaveLength(2);
    });

    it('opens the description review from the URL without JavaScript, with the row compare hidden and the Inbox link', async () => {
        const { default: PublishScreen } = await import('../PublishScreen');
        const row = [...view.ledger.authored, ...view.ledger.derived].find((entry) => entry.fix?.type === 'description');
        if (!row) throw new Error('No description row');
        const { container } = render(<PublishScreen view={view} previewHref="/curation/preview/x" openFix={row.id} action={action} />);
        expect(screen.getByRole('heading', { level: 4, name: `Review the description of ${BREAKWATER_TITLE}` })).toBeInTheDocument();
        expect(within(container.querySelector(`#${row.id}`) as HTMLElement).queryByText('This draft')).toBeNull();
        expect(screen.getByRole('link', { name: 'edit it in the Inbox' })).toHaveAttribute('href', `/curation/inbox?item=${fixture.breakwaterEvent}#item`);
        expect(screen.getByText(/^photos edit ph_[0-9a-f-]{36}$/)).toBeInTheDocument();
        expect(screen.getByText(/^Suggested by the Inbox on 25 October\. Nobody has reviewed it\.$/)).toBeInTheDocument();
    });

    // A9 (#182).
    it('shows a text change with <del> and <ins>, each with a hidden word a screen reader says', async () => {
        const { default: PublishScreen } = await import('../PublishScreen');
        const { container } = render(<PublishScreen view={view} previewHref="/curation/preview/x" openFix={null} action={action} />);
        const row = [...view.ledger.authored].find((entry) => entry.summary === 'Low Tide Hours: the short statement changes') as LedgerRow;
        const item = container.querySelector(`#${row.id}`) as HTMLElement;
        const removed = item.querySelector('del');
        const added = item.querySelector('ins');
        expect(removed?.textContent).toBe('removed: Five');
        expect(added?.textContent).toBe('added: Six');
        expect(removed?.querySelector('span')?.className).toMatch(/visuallyHidden/);
    });

    it('offers Use the published value as a native button named for the record, in a form the action reads', async () => {
        const { default: PublishScreen } = await import('../PublishScreen');
        render(<PublishScreen view={view} previewHref="/curation/preview/x" openFix={null} action={action} />);
        const button = screen.getByRole('button', { name: /^Use the published value\s*: the order of Salt Roads, from Pier lamps' move$/ });
        expect(button).toHaveAttribute('type', 'submit');
        const formElement = button.closest('form') as HTMLFormElement;
        expect(new FormData(formElement).get('intent')).toBe('use-published');
        expect(new FormData(formElement).get('field')).toBe('photoIds');
        expect(screen.getByText('This puts back the whole published order of Salt Roads.')).toBeInTheDocument();
    });

    it('collapses a group of more than 50 rows into a native disclosure, and leaves 50 open', async () => {
        const { default: PublishScreen } = await import('../PublishScreen');
        const many = (n: number): ScreenView => {
            const base = view.ledger.derived[0];
            const rows = Array.from({ length: n }, (_, index) => ({ ...base, id: `chg-${index.toString(16).padStart(16, '0')}`, summary: `Recalculated row ${index}` }));
            return { ...view, ledger: { ...view.ledger, derived: rows } };
        };
        const { container, unmount } = render(<PublishScreen view={many(51)} previewHref="/curation/preview/x" openFix={null} action={action} />);
        const group = container.querySelector('section[data-group="derived"]') as HTMLElement;
        const details = group.querySelector('details');
        expect(details).not.toBeNull();
        expect(details?.open).toBe(false);
        expect(within(group).getByText('Show all 51 changes in this group')).toBeInTheDocument();
        unmount();
        const fifty = render(<PublishScreen view={many(50)} previewHref="/curation/preview/x" openFix={null} action={action} />);
        expect(fifty.container.querySelector('section[data-group="derived"] details')).toBeNull();
    });

    it('opens a collapsed group when a link jumps to a row inside it', async () => {
        const { jumpTo } = await import('../jump');
        document.body.innerHTML = '<details><summary>Show</summary><p id="chg-target-summary" tabindex="-1">Row</p></details>';
        const details = document.querySelector('details') as HTMLDetailsElement;
        // jsdom lays nothing out, so it has no scrollIntoView.
        (document.getElementById('chg-target-summary') as HTMLElement).scrollIntoView = () => undefined;
        jumpTo({ preventDefault: () => undefined } as never, 'chg-target-summary');
        expect(details.open).toBe(true);
        expect(document.activeElement?.id).toBe('chg-target-summary');
    });

    it('says Base moved when the watch finds another revision live, in the one live region and on the ledger', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const { default: PublishScreen } = await import('../PublishScreen');
            const live = { revisionId: `rev_${'c'.repeat(64)}`, number: 3, hash: 'cccccccc' };
            const watch = vi.fn(async (): Promise<WatchAnswer> => ({ kind: 'base-moved', live }));
            const { container } = render(<PublishScreen view={view} previewHref="/curation/preview/x" openFix={null} action={action} watch={watch} />);
            expect(watch).not.toHaveBeenCalled();
            await act(async () => {
                await vi.advanceTimersByTimeAsync(60_000);
            });
            expect(watch).toHaveBeenCalledTimes(1);
            expect(watch).toHaveBeenCalledWith({ draftId: view.draftId, active: view.active.revisionId });
            const regions = container.querySelectorAll('[role="status"]');
            expect(regions).toHaveLength(1);
            expect(regions[0]).toHaveTextContent('Base moved. Revision 3 went live after this page loaded. Load the updated ledger.');
            expect(screen.getByText(/^Base moved\. Revision 3 went live after this page loaded, so this compares/)).toBeInTheDocument();
            expect(screen.getByRole('link', { name: 'Load the updated ledger' })).toHaveAttribute('href', '/curation/publish');
            expect(container.querySelector('button[value="validate"]')).toBeNull();
            void fireEvent;
        } finally {
            vi.useRealTimers();
        }
    });
});
