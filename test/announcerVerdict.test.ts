import { describe, expect, it } from 'vitest';
import { LATE_TITLE_NOTE, nextChangeVerdict, type AnnouncerStep } from './helpers/announcerLog';

// The verdict on a page change from the announcer log (#257, #258), on synthetic logs that start just before the click:
// title W, Work's title landing; read W, Next's announcer reading the title; text W, its write.

const W = 'Work · Site';
const S = 'Fixture swell · Site';
const WORK = /^Work\b/;
const title = (text: string): AnnouncerStep => ({ kind: 'title', text, hidden: false });
const read = (value: string | null, of: 'title' | 'h1' = 'title'): AnnouncerStep => ({ kind: 'read', focus: `${of} ${JSON.stringify(value)}`, text: '', hidden: false });
const text = (value: string, hidden = false): AnnouncerStep => ({ kind: 'text', text: value, hidden });
const hidden = (value: boolean, text = ''): AnnouncerStep => ({ kind: 'hidden', text, hidden: value });
const focus: AnnouncerStep = { kind: 'focus', focus: 'a', text: '', hidden: false };

describe('nextChangeVerdict', () => {
    it('passes Next reading Work\'s title and writing it: title W; read W; read W; text W', () => {
        expect(nextChangeVerdict([focus, title(W), read(W), read(W), text(W)], { name: WORK })).toEqual({ branch: 'strict', problems: [], wrote: 'title' });
    });

    it('records Next reading the old title, with the late title recorded: read S; read S; title W', () => {
        expect(nextChangeVerdict([focus, read(S), read(S), title(W)], { name: WORK, lateTitle: 'record' })).toEqual({ branch: 'late-title', problems: [], note: LATE_TITLE_NOTE });
    });

    it('fails that late title without lateTitle: \'record\'', () => {
        const verdict = nextChangeVerdict([focus, read(S), read(S), title(W)], { name: WORK });
        expect(verdict.branch).toBe('late-title');
        expect(verdict.problems).toEqual([`${LATE_TITLE_NOTE}: it read ${JSON.stringify(S)}`]);
    });

    it('fails a late title recorded when the title never became Work\'s', () => {
        expect(nextChangeVerdict([focus, read(S), read(S)], { name: WORK, lateTitle: 'record' }).problems).toEqual(["the title never became the new page's"]);
    });

    it('fails a read of Work\'s title with no write', () => {
        const verdict = nextChangeVerdict([focus, title(W), read(W), read(W)], { name: WORK, lateTitle: 'record' });
        expect(verdict.branch).toBe('strict');
        expect(verdict.problems).toEqual([`Next read ${JSON.stringify(W)} and wrote neither the new page's title nor its h1`]);
    });

    it('fails a write of Work\'s name made while the host was hidden', () => {
        const verdict = nextChangeVerdict([focus, title(W), read(W), text(W, true)], { name: WORK });
        expect(verdict.problems).toContain('the host was hidden after the click');
        expect(verdict.problems).toContain(`Next read ${JSON.stringify(W)} and wrote neither the new page's title nor its h1`);
    });

    it('fails any hidden step after the click, whatever the branch', () => {
        expect(nextChangeVerdict([focus, hidden(true), title(W), read(W), text(W, true), hidden(false, W)], { name: WORK }).problems).toContain('the host was hidden after the click');
        expect(nextChangeVerdict([focus, hidden(true), read(S), title(W), hidden(false)], { name: WORK, lateTitle: 'record' }).problems).toEqual(['the host was hidden after the click']);
    });

    it('takes a title step\'s text as the document\'s title, never as the host\'s', () => {
        expect(nextChangeVerdict([focus, title(S), title(W), read(W), text(W)], { name: WORK })).toEqual({ branch: 'strict', problems: [], wrote: 'title' });
    });

    it('fails a log with no read step at all', () => {
        expect(nextChangeVerdict([focus, title(W), text(W)], { name: WORK, lateTitle: 'record' }).problems).toEqual(['no read of the title after the click']);
    });

    it('fails a read of an empty title, then the h1, with no h1 given: only the title is the new page\'s then', () => {
        const verdict = nextChangeVerdict([focus, read(''), read('Bodies of work', 'h1'), text('Bodies of work'), title(W)], { name: WORK, lateTitle: 'record' });
        expect(verdict.branch).toBe('strict');
        expect(verdict.problems).toEqual(['the host was shown holding ["Bodies of work"]', 'Next read "" and wrote neither the new page\'s title nor its h1']);
    });

    it('fails visible "Fixture swell" text after the click, whatever the branch', () => {
        expect(nextChangeVerdict([focus, text(S), title(W), read(W), text(W)], { name: WORK }).problems).toEqual([`the host was shown holding ${JSON.stringify([S])}`]);
        expect(nextChangeVerdict([focus, read(S), text(S), title(W)], { name: WORK, lateTitle: 'record' }).problems).toEqual([`the host was shown holding ${JSON.stringify([S])}`]);
    });
    describe('with the new page\'s h1, as it rendered after the change (#258)', () => {
        const H = 'Bodies of work';

        it('passes the title written, and says so', () => {
            expect(nextChangeVerdict([focus, title(W), read(W), read(W), text(W)], { name: WORK, h1: H })).toEqual({ branch: 'strict', problems: [], wrote: 'title' });
        });

        it('passes the h1 written after an empty title, and records it as the h1', () => {
            expect(nextChangeVerdict([focus, read(''), read(H, 'h1'), text(H), title(W)], { name: WORK, h1: H })).toEqual({ branch: 'strict', problems: [], wrote: 'h1' });
        });

        it('fails the old page\'s title written', () => {
            const verdict = nextChangeVerdict([focus, title(W), read(W), read(W), text(S)], { name: WORK, h1: H });
            expect(verdict.wrote).toBeUndefined();
            expect(verdict.problems).toEqual([`the host was shown holding ${JSON.stringify([S])}`, `Next read ${JSON.stringify(W)} and wrote neither the new page's title nor its h1 ${JSON.stringify(H)}`]);
        });

        it('fails the old page\'s title written after an empty read', () => {
            const verdict = nextChangeVerdict([focus, read(''), read(H, 'h1'), text(S), title(W)], { name: WORK, h1: H });
            expect(verdict.problems).toEqual([`the host was shown holding ${JSON.stringify([S])}`, `Next read "" and wrote neither the new page's title nor its h1 ${JSON.stringify(H)}`]);
        });

        it('fails a write that is neither the title nor the h1', () => {
            const verdict = nextChangeVerdict([focus, read(''), read(H, 'h1'), text('Bodies'), title(W)], { name: WORK, h1: H });
            expect(verdict.wrote).toBeUndefined();
            expect(verdict.problems).toEqual(['the host was shown holding ["Bodies"]', `Next read "" and wrote neither the new page's title nor its h1 ${JSON.stringify(H)}`]);
        });

        it('fails no write at all', () => {
            expect(nextChangeVerdict([focus, read(''), read(H, 'h1'), title(W)], { name: WORK, h1: H }).problems).toEqual([`Next read "" and wrote neither the new page's title nor its h1 ${JSON.stringify(H)}`]);
        });

        it('fails the h1 written while the host was hidden', () => {
            expect(nextChangeVerdict([focus, read(''), read(H, 'h1'), text(H, true), title(W)], { name: WORK, h1: H }).problems).toEqual(['the host was hidden after the click', `Next read "" and wrote neither the new page's title nor its h1 ${JSON.stringify(H)}`]);
        });

        it('still records Next reading the old title, with the late title recorded', () => {
            expect(nextChangeVerdict([focus, read(S), read(S), title(W)], { name: WORK, h1: H, lateTitle: 'record' })).toEqual({ branch: 'late-title', problems: [], note: LATE_TITLE_NOTE });
        });
    });
});
