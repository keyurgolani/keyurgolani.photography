// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
    arrivalMessage,
    descriptionHint,
    DONE_ANSWER,
    fileParts,
    formStart,
    headTail,
    identityLine,
    nextItemId,
    PRIMARY_ACTION,
    referencedByText,
    reopenHint,
    REPLACEMENT_HINT,
    replacementHint,
    seriesCaption,
    seriesMembershipText,
    STATUS_LABELS,
    statusLabel,
    systemResponse,
    DEFER_LABEL,
    type ReplacementDraft,
    type SeriesOption,
} from '../inbox-view';

// The words the Inbox page puts beside an item, from what the item holds:
// pure, so each case reads here without the page or a data root.

const P = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const REV = `rev_${'b'.repeat(60)}1234`;
const SERIES: SeriesOption[] = [
    { id: 'ser_harbor', label: 'Harbor', visibility: 'published', members: [{ photoId: P(1), shortId: headTail(P(1)) }, { photoId: P(9), shortId: headTail(P(9)) }] },
    { id: 'ser_draft', label: 'Draft series', visibility: 'draft', members: [] },
];
const labelOf = (id: string) => SERIES.find((option) => option.id === id)?.label ?? id;
const NO_RULES = { value: null, confidence: 'low' as const, producedBy: 'rules@none', producedAt: '2026-02-01T00:00:00.000Z', evidence: ['There is no curation/rules.json, so no series is suggested.'] };
const RULES = { value: 'ser_harbor', confidence: 'high' as const, producedBy: 'rules@abc', producedAt: '2026-02-01T00:00:00.000Z', evidence: ['folder trips'] };
const APPROVED_THEN_REOPENED = [
    { action: 'approve', at: '2026-02-01T00:00:00.000Z', by: 'curator:web', detail: '' },
    { action: 'reopen', at: '2026-02-01T00:01:00.000Z', by: 'curator:web', detail: '' },
];

type Start = Parameters<typeof formStart>[0];
const start = (overrides: Partial<Start> = {}): Start => ({ edits: null, suggestions: { series: RULES, placement: null }, placed: null, decisions: [], lastApprovedSeries: null, ...overrides });

describe('short IDs', () => {
    it('keep the head and the tail, as the mockup shows them', () => {
        expect(headTail(P(21))).toBe('ph_0000…0021');
        expect(headTail(`sha256-b6f8${'0'.repeat(56)}6cb7`)).toBe('sha256-b6f8…6cb7');
        expect(headTail(REV)).toBe('rev_bbbb…1234');
        expect(headTail('ser_harbor')).toBe('ser_harbor');
    });

    it('split a library path into the file name and its folder', () => {
        expect(fileParts('inbox/arrival-approve.jpg')).toEqual({ name: 'arrival-approve.jpg', folder: 'inbox' });
        expect(fileParts('trips/2024/harbor-1.jpg')).toEqual({ name: 'harbor-1.jpg', folder: 'trips/2024' });
        expect(fileParts('loose.jpg')).toEqual({ name: 'loose.jpg', folder: null });
    });

    it('say where the file is and when it was taken', () => {
        expect(identityLine('trips/harbor-1.jpg', '2024-06-01')).toBe('In trips, captured 1 June 2024');
        expect(identityLine('loose.jpg', null)).toBe('At the top of the library, no capture date read');
    });
});

describe('where the form starts, and the caption under the series', () => {
    it('starts on the suggestion and names who made it', () => {
        expect(formStart(start(), ['ser_harbor'])).toEqual({ series: 'ser_harbor', from: 'suggestion' });
        expect(seriesCaption(start(), { series: 'ser_harbor', from: 'suggestion' }, labelOf)).toBe('Suggested Harbor, high confidence, by rules@abc.');
    });

    it('says once that no rule is set up, instead of a suggestion from rules@none', () => {
        const detail = start({ suggestions: { series: NO_RULES, placement: null } });
        const from = formStart(detail, []);
        expect(from).toEqual({ series: null, from: 'suggestion' });
        expect(seriesCaption(detail, from, labelOf)).toBe('No series rule is set up (curation/rules.json), so nothing is suggested.');
    });

    it('says a reopened item starts where it was approved, and what the rules suggested', () => {
        const detail = start({ suggestions: { series: NO_RULES, placement: null }, decisions: APPROVED_THEN_REOPENED, placed: { alt: null, seriesIds: [] }, lastApprovedSeries: 'ser_draft' });
        const from = formStart(detail, ['ser_harbor', 'ser_draft']);
        expect(from).toEqual({ series: 'ser_draft', from: 'approved' });
        expect(seriesCaption(detail, from, labelOf)).toBe('Starts on Draft series, where it was approved. No series rule is set up (curation/rules.json), so nothing is suggested.');
    });

    it('says a reopened item starts where a series holds it now', () => {
        const detail = start({ decisions: APPROVED_THEN_REOPENED, placed: { alt: null, seriesIds: ['ser_draft'] } });
        const from = formStart(detail, ['ser_harbor', 'ser_draft']);
        expect(from).toEqual({ series: 'ser_draft', from: 'placed' });
        expect(seriesCaption(detail, from, labelOf)).toBe('Starts on Draft series, where it is now. The rules suggested Harbor.');
        const unassigned = start({ decisions: APPROVED_THEN_REOPENED, placed: { alt: null, seriesIds: [] } });
        expect(seriesCaption(unassigned, formStart(unassigned, []), labelOf)).toBe('Starts unassigned, as it is now. The rules suggested Harbor.');
    });

    it('says a saved choice is the curator’s', () => {
        const detail = start({ edits: { seriesId: 'ser_draft', editedAt: '2026-02-01T00:00:00.000Z', editedBy: 'curator:web' } });
        const from = formStart(detail, ['ser_harbor', 'ser_draft']);
        expect(from).toEqual({ series: 'ser_draft', from: 'edit' });
        expect(seriesCaption(detail, from, labelOf)).toBe('Starts on your saved choice, Draft series. The rules suggested Harbor.');
    });
});

describe('the hint under the description', () => {
    it('says nothing is suggested when nothing is written', () => {
        expect(descriptionHint({ edits: null, placed: null })).toMatch(/^Nothing is suggested\./);
    });

    it('says what a saved edit or the photo record holds, and how to withdraw it', () => {
        const edits = { description: { kind: 'described' as const, text: 'Mine.' }, editedAt: '2026-02-01T00:00:00.000Z', editedBy: 'curator:web' };
        expect(descriptionHint({ edits, placed: null })).toBe('Your saved description. Clear it to withdraw it.');
        expect(descriptionHint({ edits: { ...edits, description: { kind: 'decorative' as const } }, placed: null })).toBe('Saved as decorative. Uncheck Decorative to withdraw it.');
        expect(descriptionHint({ edits: null, placed: { alt: { kind: 'described', text: 'At approval.' }, seriesIds: [] } })).toBe('The description it was approved with, stored as reviewed. Clear it to withdraw it.');
        expect(descriptionHint({ edits: null, placed: { alt: { kind: 'decorative' }, seriesIds: [] } })).toBe('Marked decorative when it was approved. Uncheck Decorative to withdraw it.');
    });
});

type Item = Parameters<typeof systemResponse>[0];
const item = (overrides: Partial<Item> = {}): Item => ({ type: 'new', status: 'open', group: 'judgment', unplacedSeries: null, placed: null, lastApprovedSeries: null, references: [], ...overrides });

describe('the status and the system response', () => {
    it('never calls an approval no longer placed approved, and says where it is', () => {
        const unplaced = item({ status: 'approved', group: 'unplaced', unplacedSeries: 'ser_draft', placed: { alt: null, seriesIds: [] }, lastApprovedSeries: 'ser_draft' });
        expect(statusLabel(unplaced)).toEqual({ text: 'Approved, no longer placed', tone: 'change' });
        expect(systemResponse(unplaced, labelOf)).toBe('It was approved into Draft series, but nothing holds its photo now, so it sits in the draft unassigned. Nothing publishes.');
    });

    it('says an approval is in the draft, in its series', () => {
        const approved = item({ status: 'approved', group: 'settled', placed: { alt: null, seriesIds: ['ser_draft'] }, lastApprovedSeries: 'ser_draft' });
        expect(statusLabel(approved)).toEqual({ text: 'Suggestion approved', tone: 'approved' });
        expect(systemResponse(approved, labelOf)).toBe('In the draft, in Draft series. Nothing publishes until you publish.');
        expect(systemResponse(item({ status: 'approved', group: 'settled', placed: { alt: null, seriesIds: [] } }), labelOf)).toBe('In the draft, unassigned. Nothing publishes until you publish.');
    });

    it('leads with live for an approval the active revision already shows, and never says nothing publishes', () => {
        const live = [{ kind: 'revision' as const, id: REV }, { kind: 'series' as const, id: 'ser_harbor' }];
        const placed = item({ status: 'approved', group: 'settled', placed: { alt: null, seriesIds: ['ser_harbor'] }, references: live });
        expect(systemResponse(placed, labelOf)).toBe('Live in the active revision, and in Harbor in the draft. Draft changes publish only when you publish.');
        const unassigned = item({ status: 'approved', group: 'settled', placed: { alt: null, seriesIds: [] }, references: [{ kind: 'revision', id: REV }] });
        expect(systemResponse(unassigned, labelOf)).toBe('Live in the active revision, and unassigned in the draft. Draft changes publish only when you publish.');
        for (const text of [systemResponse(placed, labelOf), systemResponse(unassigned, labelOf)]) expect(text).not.toContain('Nothing publishes');
        // A series that holds it in the draft alone is not live, and when the holders can't be read the line claims nothing about live.
        expect(systemResponse(item({ status: 'approved', group: 'settled', placed: { alt: null, seriesIds: ['ser_harbor'] }, references: [{ kind: 'series', id: 'ser_harbor' }] }), labelOf)).toBe('In the draft, in Harbor. Nothing publishes until you publish.');
        expect(systemResponse(item({ status: 'approved', group: 'settled', placed: { alt: null, seriesIds: ['ser_harbor'] }, references: null }), labelOf)).toBe('In the draft, in Harbor. Nothing publishes until you publish.');
    });

    it('names a file that produced nothing for what it is', () => {
        expect(statusLabel(item({ type: 'processing-failure', status: 'failed' }))).toEqual({ text: 'Not processed', tone: null });
        expect(statusLabel(item())).toEqual({ text: 'Draft only', tone: null });
        expect(systemResponse(item({ status: 'dismissed', group: 'settled' }), labelOf)).toBe('Dismissed, so it needs no judgment. Nothing a visitor sees changed.');
        expect(systemResponse(item(), labelOf)).toBe('It has a stable ID and waits here as a draft suggestion. Nothing publishes.');
    });
});

const draft = (overrides: Partial<ReplacementDraft> = {}): ReplacementDraft => ({ draft: 'new', live: false, decideLater: 'keeps', ...overrides });

describe('a replacement, by what its draft holds (#17)', () => {
    const confirmed = (replacement: ReplacementDraft | null) => item({ type: 'replacement', status: 'approved', group: 'settled', references: [{ kind: 'revision', id: REV }, { kind: 'series', id: 'ser_harbor' }], replacement });

    it('calls a confirmed replacement confirmed, never an approved suggestion', () => {
        expect(statusLabel(confirmed(draft()))).toEqual({ text: 'New version confirmed', tone: 'approved' });
        expect(statusLabel(item({ type: 'replacement' }))).toEqual({ text: 'Draft only', tone: null });
    });

    it('says the confirmed version is in the draft, not live, while the live revision serves the earlier one', () => {
        // The active revision holds the photo ID, but its earlier bytes.
        expect(systemResponse(confirmed(draft()), labelOf)).toBe('The draft uses the new version. Visitors keep the current one until you publish.');
        expect(systemResponse(confirmed(draft({ live: true })), labelOf)).toBe('The draft uses the new version, and so does the live revision.');
        expect(systemResponse(confirmed(draft({ draft: 'other', decideLater: 'refuses' })), labelOf)).toBe('Confirmed earlier, but the draft uses another version of this photograph now. Nothing publishes until you publish.');
        expect(systemResponse(confirmed(null), labelOf)).toBe('The new version was confirmed into the draft. Nothing publishes until you publish.');
        for (const replacement of [draft(), draft({ draft: 'other' }), null]) expect(systemResponse(confirmed(replacement), labelOf)).not.toMatch(/^Live/);
    });

    it("says what Reopen is for, with no series or description, which a replacement doesn't have", () => {
        expect(reopenHint({ type: 'replacement', replacement: draft({ decideLater: 'put-back' }) })).toBe('Reopen it to leave the new version out of the draft. Decide later then puts the earlier version back.');
        expect(reopenHint({ type: 'replacement', replacement: draft() })).toBe('Reopening it changes nothing in the draft, which keeps the new version.');
        expect(reopenHint({ type: 'replacement', replacement: draft({ draft: 'other', decideLater: 'refuses' }) })).toBe('Reopening it changes nothing in the draft.');
        expect(reopenHint({ type: 'new', replacement: null })).toBe('Reopen it to change its series or description.');
        for (const replacement of [draft(), draft({ decideLater: 'put-back' }), null]) expect(reopenHint({ type: 'replacement', replacement })).not.toMatch(/series|description/);
    });

    it('says before the click what Decide later does with the draft', () => {
        // Confirmed, then reopened: Decide later writes the draft, so it never reads like the never-confirmed hint.
        expect(replacementHint(draft({ decideLater: 'put-back' }))).toBe('The draft uses the new version, confirmed earlier. Decide later puts the earlier version back in the draft. Nothing is published until you publish.');
        expect(replacementHint(draft({ decideLater: 'put-back' }))).not.toBe(REPLACEMENT_HINT.keeps);
        // Never confirmed: the draft keeps the version it has.
        expect(replacementHint(draft({ draft: 'other' }))).toBe(REPLACEMENT_HINT.keeps);
        expect(replacementHint(null)).toBe(REPLACEMENT_HINT.keeps);
        // The draft on the new bytes already, by an edit, a rollback, or a lost confirm: Decide later keeps them.
        expect(replacementHint(draft())).toBe('The draft already uses the new version, so Decide later keeps it there, and the next publish uses it. Nothing is published until you publish.');
        // The draft moved after the confirm: Decide later refuses, and the hint says what to do instead.
        expect(replacementHint(draft({ draft: 'other', decideLater: 'refuses' }))).toBe("This photograph's draft moved to another version after the new one was confirmed, so Decide later can't tell which one to put back. Set its version with photos edit, or dismiss this item.");
    });
});

describe('what refers to a photograph', () => {
    it('names series by title and keeps the live revision apart from draft series', () => {
        expect(referencedByText([{ kind: 'revision', id: REV }, { kind: 'series', id: 'ser_harbor' }, { kind: 'series', id: 'ser_draft' }], SERIES)).toBe('The live revision (rev_bbbb…1234); series Harbor and Draft series (draft)');
        expect(referencedByText([{ kind: 'series', id: 'ser_draft' }], SERIES)).toBe('Series Draft series (draft), not published');
        expect(referencedByText([], SERIES)).toBe('Nothing');
        expect(referencedByText(null, SERIES)).toMatch(/^Can't tell/);
    });

    it('gives a series membership by title and position', () => {
        expect(seriesMembershipText(P(9), [{ kind: 'revision', id: REV }, { kind: 'series', id: 'ser_harbor' }], SERIES)).toBe('Harbor, position 02');
        expect(seriesMembershipText(P(9), [], SERIES)).toBe('In no series');
    });
});

describe('the answer an approval or Decide later carries to the page it opens', () => {
    it('names the file it decided, since that page shows another', () => {
        expect(arrivalMessage('approve', 'harbor-1.jpg', DONE_ANSWER.approve)).toBe('Approved harbor-1.jpg into the draft. Nothing is published until you publish.');
        expect(arrivalMessage('defer', 'harbor-1.jpg', DONE_ANSWER.defer)).toBe('Left harbor-1.jpg for later. Nothing in the draft changed.');
    });

    it('says the draft changed when Decide later put an earlier version back, in the words the answer under the button used', () => {
        expect(DONE_ANSWER.putBack).toBe('Left for later. The draft is back on the earlier version of this photograph, and the next publish uses that one.');
        expect(arrivalMessage('defer', 'harbor-1.jpg', DONE_ANSWER.putBack)).toBe('Left harbor-1.jpg for later. The draft is back on the earlier version of this photograph, and the next publish uses that one.');
    });

    it('says the next publish uses the new version when Decide later kept it in the draft', () => {
        expect(DONE_ANSWER.keepsNew).toBe('Left for later. The draft already uses the new version of this photograph, so the next publish uses it too.');
        expect(arrivalMessage('defer', 'harbor-1.jpg', DONE_ANSWER.keepsNew)).toBe('Left harbor-1.jpg for later. The draft already uses the new version of this photograph, so the next publish uses it too.');
    });

    it('says publish, never ships, and names no version by a pronoun the draft could own', () => {
        for (const text of [DONE_ANSWER.putBack, DONE_ANSWER.keepsNew, arrivalMessage('defer', 'a.jpg', DONE_ANSWER.putBack), arrivalMessage('defer', 'a.jpg', DONE_ANSWER.keepsNew)]) {
            expect(text).not.toMatch(/\bships?\b|\bits (earlier|new)\b/);
        }
    });

    it("keeps the action's later notes, such as what still holds publishing back", () => {
        const notes = 'It has no description yet, so publish holds it back.';
        expect(arrivalMessage('approve', 'harbor-1.jpg', `${DONE_ANSWER.approve} ${notes}`)).toBe(`Approved harbor-1.jpg into the draft. Nothing is published until you publish. ${notes}`);
    });

    it('says only its own sentence for an answer it does not recognize', () => {
        expect(arrivalMessage('approve', 'harbor-1.jpg', 'Done.')).toBe('Approved harbor-1.jpg into the draft. Nothing is published until you publish.');
    });
});

describe('the next item after an approval or Decide later', () => {
    // The list as the curator saw it: four items that needed a decision, then one already settled.
    const seen = ['evt_a', 'evt_b', 'evt_c', 'evt_d', 'evt_settled'];

    it('is the next one in list order that still needs a decision', () => {
        expect(nextItemId(seen, 'evt_a', ['evt_b', 'evt_c', 'evt_d'])).toBe('evt_b');
        expect(nextItemId(seen, 'evt_b', ['evt_a', 'evt_c', 'evt_d'])).toBe('evt_c');
    });

    it('wraps to the top of the list from the last item', () => {
        expect(nextItemId(seen, 'evt_d', ['evt_a', 'evt_b', 'evt_c'])).toBe('evt_a');
        // Past the settled rows at the end, too.
        expect(nextItemId(seen, 'evt_settled', ['evt_b'])).toBe('evt_b');
    });

    it('is none when nothing else needs a decision, so the page shows the empty state', () => {
        expect(nextItemId(seen, 'evt_a', [])).toBeNull();
        // The refresh can still list the decided item, if it was read before the write; it never opens itself again.
        expect(nextItemId(seen, 'evt_a', ['evt_a'])).toBeNull();
    });

    it('skips an item someone else decided while this one was open', () => {
        // The CLI approved evt_b behind the page: the fresh list no longer has it.
        expect(nextItemId(seen, 'evt_a', ['evt_c', 'evt_d'])).toBe('evt_c');
        // Every later one went too, so it wraps to the one before.
        expect(nextItemId(seen, 'evt_c', ['evt_a'])).toBe('evt_a');
    });

    it('still finds the next one when the open item itself left the list the page shows', () => {
        // Opened from "Left for later", which the page lists after the items needing a decision.
        expect(nextItemId(seen, 'evt_later', ['evt_b', 'evt_c'])).toBe('evt_b');
    });

    it('goes to an item that arrived since the page loaded once none it showed is left', () => {
        expect(nextItemId(seen, 'evt_d', ['evt_new'])).toBe('evt_new');
        // Ones it showed come first.
        expect(nextItemId(seen, 'evt_a', ['evt_new', 'evt_c'])).toBe('evt_c');
    });
});

describe('the action names', () => {
    it('are the owner\'s: Approve into draft, and Decide later, which leaves it for later', () => {
        expect(PRIMARY_ACTION.new).toBe('Approve into draft');
        expect(DEFER_LABEL).toBe('Decide later');
        expect(STATUS_LABELS.deferred).toBe('Left for later');
    });
});
