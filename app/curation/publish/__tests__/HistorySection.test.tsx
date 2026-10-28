import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Answer } from '@/lib/curation/publish-facts';
import { HISTORY_LEAD, RESTORE_IDLE, type EntryView, type HistoryView } from '@/lib/curation/publish-history';
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
    when: 'Published 27 October at 17:27, from this screen.',
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
