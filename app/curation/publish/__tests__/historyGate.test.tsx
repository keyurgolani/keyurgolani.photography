import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HISTORY_LEAD, RESTORE_IDLE, type EntryView, type HistoryView, type PlanView } from '@/lib/curation/publish-history';
import { disabledSet, gateMarks, serverHtml, watchGate } from '@/test/helpers/submitGateForms';
import { PublishAnswerContext } from '../HistoryContext';
import HistorySection from '../HistorySection';

// History's restore dialog at the submit gate (components/site/submitGateScript.ts): its form posts through the
// restore action, so the head's script drops a press on it until it has mounted. Opened by `?restore=N` in the server
// HTML it waits; once mounted it's ready; opened from its entry, on the client, it's ready from its first render; and
// nothing is disabled for the gate, so with no JavaScript, where nothing gates, the server's markup is all there is.
// Test values only.

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

const plan: PlanView = {
    revisionId: `rev_${'2'.repeat(64)}`,
    revision: 2,
    hash: '22222222',
    activeRevisionId: `rev_${'3'.repeat(64)}`,
    active: 3,
    activeHash: '33333333',
    impact: [{ text: 'Changes 1 series: Salt Roads' }],
};
const view: HistoryView = { lead: HISTORY_LEAD, entries: [entry(3, 3, true), entry(2, 2, false)], total: 2, more: null, count: null, plans: { 2: plan } };
const action = async () => RESTORE_IDLE;

const section = (openRestore: number | null) => (
    <PublishAnswerContext.Provider value={{ result: null, pending: false, sent: null, zone: 'UTC' }}>
        <HistorySection view={view} action={action} openRestore={openRestore} />
    </PublishAnswerContext.Provider>
);

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
});

afterEach(() => {
    vi.restoreAllMocks();
    const prototype = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
    delete prototype.showModal;
    delete prototype.close;
});

describe("History's restore form at the submit gate", () => {
    it('waits at the gate in the server HTML, opened by `?restore=`, with nothing disabled for it', () => {
        const html = serverHtml(section(2));
        expect(gateMarks(html)).toEqual([['the form of Restore revision 2', 'waiting']]);
        // Without JavaScript nothing gates, so nothing is disabled for want of it: the server's disabled set is the mounted page's.
        const { container, unmount } = render(section(2));
        expect(disabledSet(html)).toEqual(disabledSet(container));
        unmount();
    });

    it('says it is ready once mounted', () => {
        const { container } = render(section(2));
        expect(gateMarks(container)).toEqual([['the form of Restore revision 2', 'ready']]);
    });

    it('takes a press at once when opened from its entry, never waiting at the gate', () => {
        const { container } = render(section(null));
        expect(gateMarks(container)).toEqual([]);
        const watch = watchGate(container);
        fireEvent.click(screen.getByRole('button', { name: 'Restore revision 2' }));
        expect(gateMarks(container)).toEqual([['the form of Restore revision 2', 'ready']]);
        watch.stop();
        expect(watch.flips()).toEqual([]);
    });
});
