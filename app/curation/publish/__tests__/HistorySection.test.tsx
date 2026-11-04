import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Answer } from '@/lib/curation/publish-facts';
import { HISTORY_LEAD, RESTORE_IDLE, type EntryView, type HistoryView, type PlanView, type RestoreState } from '@/lib/curation/publish-history';
import { PublishAnswerContext, type PublishAnswerState } from '../HistoryContext';
import HistorySection from '../HistorySection';

// #15's 15-4: the History section on 16-3's answers, without a server. An
// answer that moved the pointer brings History read again, and a later
// answer without one (busy, say) keeps it: never the page load's view
// (high review M1). Restore is a button to assistive tech, and Space presses
// it (build design review P2-1). Test values only.

const entry = (sequence: number, revision: number, live: boolean): EntryView => ({
    sequence,
    title: `Revision ${revision}`,
    ...(live ? { badge: { text: 'Live now', tone: 'done' as const } } : {}),
    kind: 'Publish',
    when: 'Published 27 October at 17:27 by you, from this screen.',
    from: 'The first revision.',
    facts: `Entry ${sequence}`,
    eligibility: live ? { type: 'text', text: 'Live', tone: 'quiet' } : { type: 'restore', revision },
});

const historyOf = (entries: EntryView[]): HistoryView => ({ lead: HISTORY_LEAD, entries, total: entries.length, more: null, count: null, plans: {} });

const loaded = historyOf([entry(2, 2, true), entry(1, 1, false)]);
const afterPublish = historyOf([entry(3, 3, true), entry(2, 2, false), entry(1, 1, false)]);
const facts = { revisionId: `rev_${'3'.repeat(64)}`, number: 3, hash: '33333333' };
const published: Answer = { kind: 'published', live: facts, previous: null, history: afterPublish };
const busy: Answer = { kind: 'busy', lock: 'catalog', since: null, retry: 'publish' };

const action = async () => RESTORE_IDLE;

function section(state: Partial<PublishAnswerState>) {
    return (
        <PublishAnswerContext.Provider value={{ result: null, pending: false, sent: null, zone: 'UTC', ...state }}>
            <HistorySection view={loaded} action={action} openRestore={null} />
        </PublishAnswerContext.Provider>
    );
}

const liveTitle = () => within(screen.getByText('Live now').closest('li') as HTMLElement).getByRole('heading').textContent;

describe('HistorySection', () => {
    it('keeps History read again with the last answer that carried it, when a later answer carries none', () => {
        const { rerender } = render(section({}));
        expect(liveTitle()).toBe('Revision 2');
        rerender(section({ result: published }));
        expect(liveTitle()).toBe('Revision 3');
        // Publish again, while another command holds the lock: busy carries no History, and the page load's view doesn't come back.
        rerender(section({ result: busy }));
        expect(liveTitle()).toBe('Revision 3');
        expect(screen.getAllByRole('button', { name: /^Restore revision/ }).map((button) => button.textContent)).toEqual(['Restore revision 2', 'Restore revision 1']);
    });

    it('gives Restore the button role and a dialog, and pauses it with a line that says why', () => {
        render(section({ pending: true, sent: 'publish' }));
        const restore = screen.getByRole('button', { name: 'Restore revision 1' });
        expect(restore).toHaveAttribute('aria-haspopup', 'dialog');
        expect(restore).toHaveAttribute('aria-disabled', 'true');
        expect(restore).toHaveAttribute('data-off', 'true');
        expect(screen.getByText('You can restore again once this publish finishes.')).toHaveAttribute('id', 'history-paused');
    });
});

// #117: a restore that brings back editorial errors asks for each one. One
// native checkbox per flagged rule, in a fieldset, labelled in plain words;
// Restore stays aria-disabled until every box is checked, and a press before
// then shows why, focuses the first unchecked box, and posts nothing.
describe('the restore dialog with editorial errors', () => {
    const plan: PlanView = {
        revisionId: `rev_${'4'.repeat(64)}`,
        revision: 4,
        hash: '44444444',
        activeRevisionId: `rev_${'3'.repeat(64)}`,
        active: 3,
        activeHash: '33333333',
        impact: [{ text: 'Changes 1 series: Salt Roads' }],
        editorial: {
            lead: "Today's checks flag 2 styles on revision 4.",
            rules: [
                { id: 'accent.contrast', label: "Accept Salt Roads' accent color: it's hard to read on the Viewer's dark bands" },
                { id: 'accent.format', label: "Accept Low Tide Hours' accent color: it isn't a color the site can show" },
            ],
            note: 'Restoring brings them back as they were, and History records that you accepted them.',
        },
    };
    const withPlan: HistoryView = { ...historyOf([entry(5, 3, true), entry(4, 4, false)]), plans: { 4: plan } };

    beforeEach(() => {
        // jsdom has HTMLDialogElement but no showModal(), close() or :modal, so these stand in.
        Object.assign(HTMLDialogElement.prototype, {
            showModal(this: HTMLDialogElement) {
                this.setAttribute('open', '');
                this.dataset.modal = 'true';
            },
            close(this: HTMLDialogElement) {
                this.removeAttribute('open');
                delete this.dataset.modal;
            },
        });
        const matches = Element.prototype.matches;
        vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
            return selector === ':modal' ? (this as HTMLElement).dataset.modal === 'true' : matches.call(this, selector);
        });
        vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
            run(0);
            return 0;
        });
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        const prototype = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
        delete prototype.showModal;
        delete prototype.close;
    });

    function openDialog(post: (previous: RestoreState, form: FormData) => Promise<RestoreState>) {
        render(
            <PublishAnswerContext.Provider value={{ result: null, pending: false, sent: null, zone: 'UTC' }}>
                <HistorySection view={withPlan} action={post} openRestore={null} />
            </PublishAnswerContext.Provider>,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Restore revision 4' }));
        return screen.getByRole('dialog', { hidden: true });
    }

    it('shows one native checkbox per rule inside a fieldset, with plain-word labels and no rule IDs', () => {
        const dialog = openDialog(vi.fn(async (previous: RestoreState) => previous));
        const group = within(dialog).getByRole('group', { name: "Today's checks flag 2 styles on revision 4." });
        const boxes = within(group).getAllByRole('checkbox');
        expect(boxes.map((box) => [box.tagName, box.getAttribute('name'), box.getAttribute('value')])).toEqual([
            ['INPUT', 'accept', 'accent.contrast'],
            ['INPUT', 'accept', 'accent.format'],
        ]);
        expect(within(group).getByRole('checkbox', { name: "Accept Salt Roads' accent color: it's hard to read on the Viewer's dark bands" })).not.toBeChecked();
        expect(group.textContent).not.toMatch(/accent\.(contrast|format)/);
        expect(within(group).getByText('Restoring brings them back as they were, and History records that you accepted them.')).toBeInTheDocument();
    });

    it('keeps Restore aria-disabled until every box is checked, and a press before then focuses the first unchecked box and posts nothing', async () => {
        const post = vi.fn(async (previous: RestoreState, form: FormData) => (form ? previous : previous));
        const dialog = openDialog(post);
        fireEvent.change(within(dialog).getByLabelText('Why are you restoring it?'), { target: { value: 'Bring the accents back.' } });
        const submit = within(dialog).getByRole('button', { name: 'Restore revision 4' });
        const [contrast, format] = within(dialog).getAllByRole('checkbox');
        expect(submit).toHaveAttribute('aria-disabled', 'true');
        fireEvent.click(contrast);
        expect(contrast).toBeChecked();
        expect(submit).toHaveAttribute('aria-disabled', 'true');

        fireEvent.click(submit);
        expect(within(dialog).getByText('Accept each one to restore it, or cancel.')).toBeInTheDocument();
        await waitFor(() => expect(format).toHaveFocus());
        expect(format).toHaveAttribute('aria-describedby', expect.stringContaining('restore-accept-error'));
        expect(post).not.toHaveBeenCalled();

        fireEvent.click(format);
        expect(submit).not.toHaveAttribute('aria-disabled');
        expect(within(dialog).queryByText('Accept each one to restore it, or cancel.')).toBeNull();
        fireEvent.click(submit);
        await waitFor(() => expect(post).toHaveBeenCalledOnce());
        const sent = post.mock.calls[0][1];
        expect(sent.getAll('accept')).toEqual(['accent.contrast', 'accent.format']);
        expect(sent.get('reason')).toBe('Bring the accents back.');
    });
});
