import { render, screen, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PublishState, ScreenView } from '@/lib/curation/publish-facts';
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
});
