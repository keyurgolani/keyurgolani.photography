// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SOURCE_EXTENSIONS } from '../../identity/scan';
import { FAILURE_REASONS } from '../events';
import {
    arrivalMessage,
    BIND_WAITING_NEXT,
    bindWaitingText,
    failureNotice,
    hasPublishedStatement,
    humanDate,
    humanTime,
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
    resolvedResponse,
    settledMissingTitle,
    seriesCaption,
    seriesMembershipText,
    STATUS_LABELS,
    statusLabel,
    systemResponse,
    DEFER_LABEL,
    type ReplacementDraft,
    type ResolvedCause,
    type SeriesOption,
} from '../inbox-view';
import { CLOSE_REASONS, closeCauseOf } from '../events';

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
        // #17's resolved never claims nothing a visitor sees changed: an archive's publish takes the photo down.
        expect(statusLabel(item({ status: 'resolved', group: 'settled' }))).toEqual({ text: 'Resolved', tone: null });
        // With no close the page knows, it points at History, never at a bare "needs no judgment".
        expect(systemResponse(item({ status: 'resolved', group: 'settled' }), labelOf)).toBe('The watcher closed it. History says what it found.');
    });

    it("words a resolved item by what closed it (#17), with no IDs and never a bare 'needs no judgment'", () => {
        const resolved = (type: Item['type'], resolvedBy: ResolvedCause | null) => systemResponse(item({ type, status: 'resolved', group: 'settled', resolvedBy }), labelOf);
        expect(resolved('missing', { kind: 'same-file' })).toBe('The same file came back, so nothing a visitor sees changed.');
        expect(resolved('missing', { kind: 'other-bytes' })).toBe('The file came back with other bytes, so its replacement item reviews the new version. Visitors keep the current one until you confirm it and publish.');
        expect(resolved('missing', { kind: 'bound' })).toBe('Bound to the new file, so its replacement item reviews the new version. Visitors keep the current one until you confirm it and publish.');
        expect(resolved('new', { kind: 'merged', into: 'harbor/landscape.jpg' })).toBe("A bind made this file the new version of harbor/landscape.jpg, so that photograph's replacement item reviews it.");
        expect(resolved('new', { kind: 'merged', into: null })).toBe("A bind made this file the new version of another photograph, so that photograph's replacement item reviews it.");
        expect(resolved('new', { kind: 'archived' })).toBe('The photograph is archived, so this file needs no judgment.');
        expect(resolved('processing-failure', { kind: 'archived' })).toBe('The photograph is archived, so nothing needs retrying.');
        expect(resolved('processing-failure', { kind: 'built' })).toBe('Its derivatives built on a later try, so nothing needs retrying.');
        expect(resolved('processing-failure', { kind: 'gone' })).toBe('The registry no longer holds the photograph, so nothing needs retrying.');
        expect(resolved('processing-failure', { kind: 'moved' })).toBe("The file holds other bytes now, and the photograph's newer items cover them.");
        const kinds = ['same-file', 'other-bytes', 'bound', 'archived', 'built', 'gone', 'moved'] as const;
        for (const kind of kinds) {
            expect(resolvedResponse({ kind }, 'missing')).not.toBe('Resolved, so it needs no judgment.');
            expect(resolvedResponse({ kind }, 'missing')).not.toMatch(/\b(ph|evt|rev|p)_|sha256-/);
        }
    });

    it("reads every close reason the watcher writes back as its cause, and nothing else", () => {
        expect(closeCauseOf(CLOSE_REASONS.back('at its path', true))).toBe('same-file');
        expect(closeCauseOf(CLOSE_REASONS.back('at harbor/moved.jpg', false))).toBe('other-bytes');
        expect(closeCauseOf(CLOSE_REASONS.merged(P(1)))).toBe('merged');
        expect(closeCauseOf(CLOSE_REASONS.archived)).toBe('archived');
        expect(closeCauseOf(CLOSE_REASONS.built('p_1'))).toBe('built');
        expect(closeCauseOf(CLOSE_REASONS.gone)).toBe('gone');
        expect(closeCauseOf(CLOSE_REASONS.moved)).toBe('moved');
        expect(closeCauseOf('Closed by hand.')).toBeNull();
    });

    it("titles a settled missing item by how it settled, so the settled list never reads 'Source file missing'", () => {
        expect(settledMissingTitle('approved', null)).toBe('Photograph archived');
        expect(settledMissingTitle('resolved', { kind: 'same-file' })).toBe('Source file back');
        expect(settledMissingTitle('resolved', { kind: 'bound' })).toBe('Bound to a new file');
        expect(settledMissingTitle('open', null)).toBeNull();
        expect(settledMissingTitle('deferred', null)).toBeNull();
    });

    it("badges an open missing item by what shows its photograph, never a new photograph's 'Draft only' over a live one", () => {
        const open = (references: Item['references']) => statusLabel(item({ type: 'missing', references }));
        expect(open([{ kind: 'revision', id: REV }, { kind: 'series', id: 'ser_harbor' }])).toEqual({ text: 'Still live', tone: null });
        expect(open([{ kind: 'series', id: 'ser_draft' }])).toEqual({ text: 'Draft only', tone: null });
        expect(open([])).toEqual({ text: 'Not shown anywhere', tone: null });
        // When the holders can't be read, no badge claims anything.
        expect(open(null)).toEqual({ text: null, tone: null });
        expect(statusLabel(item({ type: 'missing', status: 'deferred', references: [{ kind: 'revision', id: REV }] }))).toEqual({ text: 'Left for later', tone: null });
    });

    it('says what a pending bind does before any click, ending as the approve refusal does', () => {
        expect(bindWaitingText({ kind: 'merge', into: 'harbor/landscape.jpg' })).toBe(`A bind waiting for the watcher's next pass makes this file the new version of harbor/landscape.jpg. ${BIND_WAITING_NEXT}`);
        expect(bindWaitingText({ kind: 'merge', into: null })).toContain('the new version of another photograph.');
        expect(bindWaitingText({ kind: 'bind', path: 'harbor/landscape.jpg' })).toBe("A bind waiting for the watcher's next pass gives this photograph the file at harbor/landscape.jpg. Refresh after the watcher runs: this item closes once the bind goes through.");
    });

    it("calls a missing item #17's archive approved archived, and says whether the live site still shows it", () => {
        const archived = (references: Item['references']) => item({ type: 'missing', status: 'approved', group: 'settled', references });
        expect(statusLabel(archived([]))).toEqual({ text: 'Archived', tone: null });
        expect(systemResponse(archived([{ kind: 'revision', id: REV }]), labelOf)).toBe('Archived and out of every series in the draft. The live site shows it until you publish.');
        expect(systemResponse(archived([]), labelOf)).toBe('Archived, and nothing shows it any more.');
        // When the holders can't be read, it doesn't claim the draft lists it nowhere.
        expect(systemResponse(archived(null), labelOf)).toBe("Archived. Can't tell what shows it now: a revision or working-layer file can't be read.");
        expect(systemResponse(item(), labelOf)).toBe('It has a stable ID and waits here as a draft suggestion. Nothing publishes.');
    });

    it('never says an archived photograph is out of every series while a draft series lists it again, as a rollback or sequence insert leaves it', () => {
        const archived = (references: Item['references']) => item({ type: 'missing', status: 'approved', group: 'settled', references });
        expect(systemResponse(archived([{ kind: 'series', id: 'ser_harbor' }]), labelOf)).toBe("Archived, but the draft lists it in Harbor again, so a publish refuses it until it's taken out.");
        expect(systemResponse(archived([{ kind: 'revision', id: REV }, { kind: 'series', id: 'ser_harbor' }, { kind: 'series', id: 'ser_draft' }]), labelOf)).toBe(
            "Archived, but the draft lists it in Harbor and Draft series again, so a publish refuses it until it's taken out. The live site still shows it.",
        );
    });

    it("says reopening an archived missing item doesn't undo the archive", () => {
        expect(reopenHint({ type: 'missing', replacement: null, references: [] })).toBe("Reopening doesn't undo the archive. The photograph stays archived and out of every series.");
        expect(reopenHint({ type: 'missing', replacement: null, references: [{ kind: 'series', id: 'ser_harbor' }] })).toBe("Reopening doesn't undo the archive. The photograph stays archived.");
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
        // Active revision, the row below it, has the revision's ID, so this doesn't repeat it.
        expect(referencedByText([{ kind: 'revision', id: REV }, { kind: 'series', id: 'ser_harbor' }, { kind: 'series', id: 'ser_draft' }], SERIES)).toBe('The live revision; series Harbor and Draft series (draft)');
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

describe('dates', () => {
    it('says a date and a stored time the way the Inbox does, and leaves anything else as it is', () => {
        expect(humanDate('2024-01-04')).toBe('4 January 2024');
        expect(humanDate('2024-13-04')).toBeNull();
        expect(humanDate('January 2024')).toBeNull();
        expect(humanTime('2026-02-01T00:03:00.000Z')).toBe('1 February 2026, 00:03 UTC');
        expect(humanTime('2026-02-01T23:59:00-08:00')).toBe('2 February 2026, 07:59 UTC');
        expect(humanTime('not a time')).toBe('not a time');
        // The browser's own zone, once the page runs, with its abbreviation.
        expect(humanTime('2026-02-01T00:03:00.000Z', 'America/Los_Angeles')).toBe('31 January 2026, 16:03 PST');
        expect(humanTime('2026-07-01T00:03:00.000Z', 'Asia/Kolkata')).toMatch(/^1 July 2026, 05:33 (GMT\+5:30|IST)$/);
        expect(humanTime('2026-02-01T00:03:00.000Z', 'Not/AZone')).toBe('2026-02-01T00:03:00.000Z');
        expect(identityLine('inbox/a.jpg', '2024-01-04')).toBe('In inbox, captured 4 January 2024');
    });
});

describe('a processing failure', () => {
    const failed = (code: (typeof FAILURE_REASONS)[number] | null, overrides: Partial<Parameters<typeof failureNotice>[0]> = {}) =>
        failureNotice({
            type: 'processing-failure',
            failure: code ? `Reason for ${code}.` : null,
            failureCode: code,
            status: 'failed',
            can: { approve: false, edit: true, defer: true, dismiss: true, retry: false, reopen: false },
            sourcePath: 'inbox/no-extension',
            ...overrides,
        });

    it('says why, and what the owner can do next, for every reason the watcher gives', () => {
        for (const code of FAILURE_REASONS) {
            const notice = failed(code)!;
            expect(notice.reason).toBe(`Reason for ${code}.`);
            expect(notice.next).toMatch(/dismiss this one with a reason/);
            expect(notice.next).toMatch(/Decide later keeps it here meanwhile\.$/);
        }
        // Retry or a good copy, never both: a copy is a new revision, which Retry would not read.
        expect(failed('undecodable', { can: { approve: false, edit: true, defer: true, dismiss: true, retry: true, reopen: false } })!.next).toBe(
            "If the file opens, choose Retry processing. If it doesn't, put a good copy in its place in the library, which the watcher picks up as a new revision, then dismiss this one with a reason. Decide later keeps it here meanwhile.",
        );
        expect(failed('undecodable')!.next).not.toMatch(/Retry/);
        // The failure names no other file, so neither does the step.
        expect(failed('digest-collision')!.next).toMatch(/^Find the other copy in the library and keep the one you mean/);
        expect(failed(null)!.reason).toBe("The watcher couldn't process the file.");
    });

    it('names the formats the watcher reads, as lib/identity/scan.ts lists them', () => {
        const next = failed('unsupported-format')!.next!;
        const named = { '.jpg': 'JPEG', '.jpeg': 'JPEG', '.png': 'PNG', '.webp': 'WebP' } as Record<string, string>;
        for (const extension of SOURCE_EXTENSIONS) expect(next).toContain(named[extension]);
        expect(next).toMatch(/^The watcher reads JPEG, PNG and WebP\. Export the photograph as one of those into the library/);
    });

    it("names a format it doesn't read by the file's own extension", () => {
        expect(failed('unsupported-format', { sourcePath: 'inbox/raw-frame.heic' })!.reason).toBe("This is a HEIC file, which the watcher doesn't read.");
        expect(failed('unsupported-format', { sourcePath: 'inbox/IMG_0001.CR3' })!.reason).toBe("This is a CR3 file, which the watcher doesn't read.");
        // No extension to name: the watcher's own words.
        expect(failed('unsupported-format')!.reason).toBe('Reason for unsupported-format.');
        expect(failed('undecodable', { sourcePath: 'inbox/a.jpg' })!.reason).toBe('Reason for undecodable.');
    });

    it('offers no next step once settled, and is nothing for any other item', () => {
        expect(failed('unsupported-format', { status: 'dismissed', can: { approve: false, edit: false, defer: false, dismiss: false, retry: false, reopen: true } })).toEqual({ reason: 'Reason for unsupported-format.', next: null });
        expect(failed('unsupported-format', { type: 'new' })).toBeNull();
    });
});

describe('the published statement note', () => {
    it('belongs to a photograph the active revision holds, or may, when the holders can\'t be read', () => {
        expect(hasPublishedStatement({ photoId: P(1), references: [{ kind: 'revision', id: REV }, { kind: 'series', id: 'ser_harbor' }] })).toBe(true);
        expect(hasPublishedStatement({ photoId: P(1), references: [{ kind: 'series', id: 'ser_harbor' }] })).toBe(false);
        expect(hasPublishedStatement({ photoId: P(1), references: [] })).toBe(false);
        expect(hasPublishedStatement({ photoId: P(1), references: null })).toBe(true);
        expect(hasPublishedStatement({ photoId: null, references: [] })).toBe(false);
    });
});
