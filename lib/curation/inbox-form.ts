import { REVISION_ID_RE, SERIES_ID_RE } from '../catalog/schema';
import { readAuthoredRecord, readAuthoredSeries } from '../catalog/working-layer';
import { isLibraryPath, PHOTO_ID_RE } from '../identity/ids';
import { readRegistry } from '../identity/registry';
import { configuredLibraryRoot, dataRootStatus } from '../storage/config';
import { approveEvent, dismissEvent, editEvent, reopenEvent, retryEvent, type ActionInput, type ActionOutcome, type Choices } from './actions';
import { pendingArchiveOf } from './binds';
import { printable, scrub } from './commands';
import { EVENT_ID_RE, type CurationEvent, type CuratorDescription } from './events';
import { bindAnswer, BIND_WAITING_NEXT, BLOCKED_NEXT, BLOCKED_WHY, CONFIRM_UNAVAILABLE, DONE_ANSWER, MOVED_ANSWER, parsePlacementValue, type InboxActionKind, type InboxActionState } from './inbox-view';
import { readDraftPlan } from './pins';
import { readEvent } from './repository';
import { archiveMissing, bindReplacement, confirmReplacement, leaveInDraft, linkedNewItems } from './resolutions';
import { MAX_DESCRIPTION_LENGTH, MAX_REASON_LENGTH, ownerText } from './text';

/**
 * The inbox page's forms, read into 14-1's actions (lib/curation/actions.ts)
 * and their answers read back for the page. app/curation/inbox/actions.ts
 * calls runInboxAction() only after requireCurator() lets the request in.
 *
 * Every form carries the event version and the active revision the page
 * showed, and the action compares both under the curation lock, so an item
 * that moved since the page loaded is `stale` and nothing is written.
 *
 * Descriptions: only text the curator typed in the description field, or the
 * decorative flag, reaches an action, and 14-1 stores either as reviewed.
 * Nothing generated is ever read from the form, since no field carries it.
 *
 * #118 adds #17's resolutions: Confirm (confirmReplacement()), Bind
 * (bindReplacement()) and Archive (archiveMissing()). Each writer takes its
 * locks and checks the item version and the active revision itself, and
 * writes nothing when it refuses.
 */

/** Who the web curator acts as. There's no session, so there's no name: the SSH tunnel is the way in (docs/curator.md). */
export const WEB_ACTOR = 'curator:web';

type FormField = 'description' | 'reason' | 'path' | 'bindTo';

export class InboxFormError extends Error {
    /** The field the refusal is about, so the page shows it beside that field. */
    readonly field: FormField | undefined;

    constructor(message: string, field?: FormField) {
        super(message);
        this.field = field;
    }
}

const invalid = (message: string, field?: FormField): never => {
    throw new InboxFormError(message, field);
};

function field(form: FormData, name: string): string | null {
    const value = form.get(name);
    if (value === null) return null;
    if (typeof value !== 'string') return invalid(`${name} must be text.`);
    return value;
}

function text(value: string, label: string, max: number, field: 'description' | 'reason'): string {
    const checked = ownerText(value, { field: label, max });
    if (!checked.ok) invalid(checked.problem, field);
    return (checked as { text: string }).text;
}

/** The fields every item form carries: the event, its version, and the active revision, as the page showed them. */
function itemFields(form: FormData): Pick<ActionInput, 'eventId' | 'expectedVersion' | 'expectedBase'> {
    const eventId = field(form, 'eventId') ?? '';
    if (!EVENT_ID_RE.test(eventId)) invalid('The form names no inbox item. Refresh the inbox.');
    const version = field(form, 'version') ?? '';
    if (!/^[1-9]\d{0,9}$/.test(version)) invalid('The form carries no item version. Refresh the inbox.');
    const base = field(form, 'base') ?? '';
    if (base !== 'none' && !REVISION_ID_RE.test(base)) invalid('The form carries no active revision. Refresh the inbox.');
    return { eventId, expectedVersion: Number(version), expectedBase: base === 'none' ? null : base };
}

/**
 * The curator's choices, from the fields the form sends:
 * - `series`, the series the page shows, every time one is shown, so an
 *   approval stores what the curator saw. `seriesTouched` says they changed
 *   it, which is what Save edits counts.
 * - `placement` only once the curator picks a position, so a suggested
 *   position stays a suggestion as 14-1 resolves it.
 * - `decorative`, `on` or `off` every time, and `descriptionWas`, the kind
 *   of description already saved, so an unchecked box or an emptied field
 *   clears it.
 */
export function choicesFrom(form: FormData, kind: 'approve' | 'edit'): Choices {
    const choices: Choices = {};
    const series = field(form, 'series');
    const countsSeries = kind === 'approve' || field(form, 'seriesTouched') !== null;
    if (series !== null && series !== '' && countsSeries) {
        if (series === 'unassigned') choices.seriesId = null;
        else if (SERIES_ID_RE.test(series)) choices.seriesId = series;
        else invalid('That series is not one the working layer holds. Refresh the inbox.');
    }
    const placement = field(form, 'placement');
    if (placement !== null && placement !== '') {
        const parsed = parsePlacementValue(placement);
        if (parsed === null || (typeof parsed === 'object' && !PHOTO_ID_RE.test(parsed.after))) invalid('That position is not one the series offers. Refresh the inbox.');
        choices.placement = parsed as NonNullable<Choices['placement']>;
    }
    if (choices.seriesId === null && choices.placement !== undefined) delete choices.placement;
    const decorative = field(form, 'decorative') === 'on';
    const description = field(form, 'description') ?? '';
    const saved = field(form, 'descriptionWas') !== null;
    if (decorative) choices.description = { kind: 'decorative' };
    else {
        if (description.trim() === '') {
            // An unchecked box or an emptied field clears what was saved. An approval then places the photo with no description, and #13's gate holds it back.
            if (saved) choices.description = null;
        } else {
            const typed: CuratorDescription = { kind: 'described', text: text(description, 'The description', MAX_DESCRIPTION_LENGTH, 'description') };
            choices.description = typed;
        }
    }
    if (kind === 'edit' && choices.seriesId === undefined && choices.placement === undefined && choices.description === undefined) {
        invalid('Nothing changed, so there is nothing to save.');
    }
    return choices;
}

/** The reason field. `required` names the action that needs one, in the refusal's words. */
function reasonFrom(form: FormData, required?: 'Dismissing' | 'Archiving'): string | undefined {
    const reason = field(form, 'reason');
    if (reason === null || reason.trim() === '') {
        if (required) invalid(`${required} needs a reason.`, 'reason');
        return undefined;
    }
    return text(reason, 'The reason', MAX_REASON_LENGTH, 'reason');
}

const OUTSIDE_LIBRARY = "That isn't a path inside the library. Type it from the library's top folder, such as harbor/landscape.jpg. Nothing was written.";

const NOT_LINKED = "That file isn't linked to this photograph any more. Refresh the inbox. Nothing was written.";

/**
 * #118: the file Bind gives the missing photograph. `bindTo` names a linked file by its item's ID, whose path is read
 * here again, unescaped, from linkedNewItems(), since the page only shows an escaped copy; or it's `typed`, for the
 * library path in `path`, which is refused here when it isn't inside the library. With neither, the writer binds the
 * one linked file, or says none or several are.
 */
async function bindPathFrom(form: FormData, root: string, eventId: string): Promise<string | undefined> {
    const choice = field(form, 'bindTo');
    const typed = (field(form, 'path') ?? '').trim();
    if (choice === null || choice === 'typed') {
        if (choice === null && typed === '') return undefined;
        if (typed === '') invalid('Type the library path of the file that replaces it. Nothing was written.', 'path');
        if (!isLibraryPath(typed)) invalid(OUTSIDE_LIBRARY, 'path');
        return typed;
    }
    if (!EVENT_ID_RE.test(choice)) invalid(NOT_LINKED, 'bindTo');
    const event = await readEvent(root, eventId);
    if (event?.photoId === null || event?.photoId === undefined) return invalid(NOT_LINKED, 'bindTo');
    const linked = (await linkedNewItems(root, event.photoId, await readRegistry(root))).find((item) => item.id === choice);
    return linked?.derivedFacts.sourcePath ?? invalid(NOT_LINKED, 'bindTo');
}

/** #118: Archive's reason, and its second step, which the page's confirm button alone sends, so no stray post archives. */
function archiveFrom(form: FormData): string {
    const reason = reasonFrom(form, 'Archiving') as string;
    if (field(form, 'confirmed') !== 'yes') invalid('Confirm the archive at its second step first. Nothing was written.');
    return reason;
}

const STATUS_FOR: Record<Exclude<ActionOutcome, { ok: true }>['code'], Exclude<InboxActionState, { status: 'idle' }>['status']> = {
    stale: 'stale',
    locked: 'busy',
    'not-found': 'stale',
    refused: 'refused',
    'needs-choice': 'invalid',
    'not-ready': 'failed',
    damaged: 'failed',
};

const DONE: Record<InboxActionKind, string> = {
    approve: DONE_ANSWER.approve,
    edit: 'Saved your edits. Nothing in the draft changed.',
    defer: DONE_ANSWER.defer,
    dismiss: 'Dismissed.',
    retry: 'Asked the watcher to process it again on its next pass.',
    reopen: 'Reopened.',
    confirm: DONE_ANSWER.confirm,
    // bindDone() words a bind by its path; this is what it says when the event doesn't name one.
    bind: bindAnswer(null, null),
    archive: DONE_ANSWER.archive,
};

const LINK_PATH = 'Type the library path of the file that replaces it.';

/** 14-1's and #17's answers that speak to the CLI, with its flags and commands, in the page's words. */
const PAGE_WORDING: [RegExp, string][] = [
    [/^Nothing chooses a series/, 'Choose a series, or Leave unassigned, before approving. Nothing was written.'],
    [/^A position needs a series/, 'Choose a series before a position. Nothing was written.'],
    [/^A photograph left unassigned has no position/, 'A photograph left unassigned has no position. Nothing was written.'],
    [/^(approve|confirm|archive) needs --base/, "The page didn't carry the active revision. Refresh the inbox and review it again. Nothing was written."],
    [/^--version takes/, 'The form carries no item version. Refresh the inbox.'],
    [/^edit needs a series/, 'Nothing changed, so there is nothing to save.'],
    [/^dismiss needs a reason/, 'Dismissing needs a reason.'],
    // #17's bind, with nothing linked and no --path, or several linked files and no --path to pick one, or one waiting already.
    [/^A bind for \S+ already waits for the watcher's next pass/, "A bind waiting for the watcher's next pass already gives this photograph a file. Refresh after the watcher runs. Nothing was written."],
    // #118: a bind or a second archive while an archive waits, as after an archive and a reopen.
    [/^An archive of \S+ waits for the watcher's next pass/, "An archive waiting for the watcher's next pass takes this photograph down already, so it can't be bound or archived again. Refresh after the watcher runs. Nothing was written."],
    [/^No file is linked to /, `No file is linked to this photograph. ${LINK_PATH} Nothing was written.`],
    [/^\d+ files are linked to /, 'More than one file is linked to this photograph. Choose the one that replaces it. Nothing was written.'],
    [/ is not a path inside the library\./, OUTSIDE_LIBRARY],
    // #17's archive while a bind waits, which names the decision and `curation show`.
    [/^A bind for \S+ waits for the watcher's next pass/, "A bind waiting for the watcher's next pass gives this photograph a file, so it can't be archived yet. Refresh after the watcher runs, and archive it then if the bind didn't go through. Nothing was written."],
];

/** Refusals 14-1 words with IDs, in the page's words. The page already says which item. */
const REFUSAL_WORDING: [RegExp, (match: RegExpMatchArray) => string][] = [
    // A8 review S2: bulk Leave unassigned on an item with a series saved on it.
    [/has the series \S+ saved on it, so leaving it unassigned would drop that choice/, () => 'This item has a series saved on it, so Leave unassigned would drop that choice. Open it to approve it into that series, or change it there. Nothing was written.'],
    [/is already in .*an approval doesn't take a photograph out of a series/, () => "This photograph is already in a series, and approving doesn't take it out of one. Keep its series to approve it. Nothing was written."],
    [/can't be read, so nothing shows whether one holds/, () => "A series can't be read, so nothing shows whether one still holds this photograph. Nothing was written."],
    [/^There is no series /, () => "That series isn't in the working layer any more. Refresh the inbox. Nothing was written."],
    [/ is (open|deferred|dismissed|approved|failed|resolved), so it can't be ([a-z]+)\./, (match) => `This item is ${match[1]}, so it can't be ${match[2]}. Refresh the inbox.`],
    // #17's approve, while a bind that merges the photograph waits for the watcher.
    [/ is merged into .* by the bind decision /, () => `A bind waiting for the watcher's next pass makes this file the new version of another photograph, so it can't be approved. ${BIND_WAITING_NEXT} Nothing was written.`],
    // #17: the page doesn't offer Reopen on a missing item whose source came back, so only an old form reaches this.
    [/ is a missing item the watcher resolved once its source was present again/, () => "Its source is back, so this item stays resolved, and the inbox doesn't reopen it. Nothing was written."],
    [/ is a missing item the watcher dismissed once the same bytes came back at its path/, () => "The same file is back at its path, so this item stays closed, and the inbox doesn't reopen it. Nothing was written."],
    [/^Nothing failed for /, () => "Nothing failed for this photograph, so there's nothing to retry."],
    [/has no photo ID, so there is nothing to retry/, () => "This file has no photo ID, so there's nothing to retry."],
    [/can't be dismissed/, () => "Something still shows this photograph, so it can't be dismissed. Restore the source, or take it out of its series and publish first. Nothing was written."],
    // #17's Decide later on a confirmed replacement, when the earlier version it would put back has no set that checks out.
    [/, the revision to put back, has no ready derivative set/, () => `${BLOCKED_WHY} Nothing was written. ${BLOCKED_NEXT}`],
    [/doesn't check out .*so it can't be put back\./, () => "The earlier version of this photograph has derivatives that don't check out, so Decide later can't put it back. The draft keeps the new version. Nothing was written. The server log names the problem."],
    // 14-1's approve of a new item whose photograph's record pins other bytes: #118's Confirm, on its replacement item, is the way.
    [/photo record pins /, () => "Its photo record holds another version of this photograph, so approving can't place these bytes. Confirm the new version on its replacement item instead. Nothing was written."],
    // #17's confirm.
    [/^Only a replacement is confirmed/, () => "Only a replacement's new version is confirmed. Nothing was written."],
    [/derivative set failed: /, () => `${CONFIRM_UNAVAILABLE.failed} Nothing was written.`],
    [/doesn't check out .*so it can't be confirmed\./, () => "The new version's derivatives don't check out, so it can't be confirmed. Nothing was written. The server log names the problem."],
    [/has no photo record in the working layer/, () => `${CONFIRM_UNAVAILABLE.noRecord} Approve its new item first. Nothing was written.`],
    // #17's bind and archive.
    [/^Only a missing source is settled with /, () => 'Only a missing photograph is bound or archived. Nothing was written.'],
    [/ was merged into /, () => 'This photograph was merged into another one, so it has nothing to bind or archive. Nothing was written.'],
    [/ is archived, so nothing can be bound to it/, () => 'This photograph is archived, so nothing can be bound to it. Nothing was written.'],
    [/^The watcher hasn't seen a photograph at /, () => "The watcher hasn't seen a photograph at that path. Check it, or wait for the watcher's next pass after copying the file there. Nothing was written."],
    [/ which \S+ gave to \S+, so the watcher would refuse the bind/, () => 'That file holds bytes this photograph gave to another one, so the watcher would refuse the bind. Nothing was written.'],
    [/^#10 holds /, () => "The watcher isn't sure whose file that is. Settle that path's ambiguous item first, then bind again. Nothing was written."],
    [/which has more than the one revision first seen there/, () => 'The photograph at that path has versions of its own, so the watcher would refuse to merge it into this one. Keep it as its own photograph, or bind another file. Nothing was written.'],
    [/is already merged into .* by the pending bind decision/, () => "A bind waiting for the watcher's next pass already gives the file at that path to another photograph. Refresh after the watcher runs. Nothing was written."],
    [/A photograph visitors see can't be merged/, () => "The photograph at that path is on the site, and a photograph visitors see can't be merged into another. Keep it as its own photograph, or bind another file. Nothing was written."],
    [/ in the draft\. Take it out of /, () => 'The photograph at that path is in a series in the draft. Take it out of that series first, or keep it as its own photograph. Nothing was written.'],
    [/the retained catalog revisions? /, () => 'An earlier published revision shows the photograph at that path, and merging it would stop a rollback from bringing that revision back. Keep it as its own photograph, or bind another file. Nothing was written.'],
    [/has a photo record in the draft with the owner's /, () => "The photograph at that path has copy of yours in the draft, such as a title or description, which a merge would drop. Keep it as its own photograph, or bind another file. Nothing was written."],
    [/can't be read, so nothing shows whether they list /, () => "A series can't be read, so nothing shows whether it lists this photograph. Nothing was written. The server log names it."],
];

/** #118: the bind refusals about the path the curator chose, which the page shows by that field. */
const PATH_REFUSAL = /^No file is linked to | is not a path inside the library\.|^The watcher hasn't seen a photograph at |gave to \S+, so the watcher would refuse the bind|^#10 holds |more than the one revision first seen there|by the pending bind decision|A photograph visitors see can't be merged| in the draft\. Take it out of |the retained catalog revisions? |has a photo record in the draft with the owner's /;

/** What a refusal says when nothing more specific fits: no internal ID, no flag, no command. */
const FALLBACK: Record<'refused' | 'invalid' | 'failed', string> = {
    refused: "The inbox can't do that with this item as it stands. Nothing was written.",
    invalid: 'That needs another choice first. Nothing was written.',
    failed: "Something in the data root can't be read, so nothing was written. The server log names it.",
};

/** Internal IDs, CLI flags and commands, and the CLI's "show it again". */
const NOT_FOR_THE_PAGE = /\b(evt|ph|rev|ser|act|fp|p)_[0-9a-z]|sha256-|(^|\s)--[a-z]|\bphotos (identity|publish|curation)\b|Show it again/;

/** A refusal in the curator's words: never an internal ID, a CLI flag or command, or CLI phrasing. */
export function pageWording(message: string, status: 'refused' | 'invalid' | 'failed' = 'refused'): string {
    for (const [pattern, wording] of PAGE_WORDING) if (pattern.test(message)) return wording;
    for (const [pattern, wording] of REFUSAL_WORDING) {
        const match = message.match(pattern);
        if (match) return wording(match);
    }
    return NOT_FOR_THE_PAGE.test(message) ? FALLBACK[status] : message;
}

/** #17: leaveInDraft()'s refusal once the photo record moved off this item's confirm. Refreshing changes nothing, so it isn't stale. */
const MOVED_REFUSAL = /photo record pins \S+ now, not \S+ as this item's confirm left it/;

/**
 * #17: what the draft holds after a reopen or Decide later on a replacement, for the answers that say it. `putBack`
 * after a reopen whose Decide later would put the earlier version back; `keepsNew` after a Decide later that wrote
 * nothing while the photo record pins the item's new bytes. Null otherwise, and when the record can't be read.
 */
async function replacementAnswer(root: string, kind: InboxActionKind, event: CurationEvent): Promise<string | null> {
    if (event.type !== 'replacement' || event.photoId === null || event.assetRevision === null) return null;
    const photoId = event.photoId;
    try {
        // 16-1: readDraftPlan() reads the photo record itself, so it can see the record's confirm stamp.
        const readRecord = () => readAuthoredRecord(root, 'photo', photoId);
        // A `blocked` put back gets the plain answer: Decide later can't change the draft then.
        if (kind === 'reopen') return (await readDraftPlan(root, event, readRecord)).kind === 'put-back' ? DONE_ANSWER.reopenedPutBack : null;
        if (kind === 'defer') return (event.decisions.at(-1)?.writes?.length ?? 0) === 0 && ((await readRecord())?.assetRevision ?? null) === event.assetRevision ? DONE_ANSWER.keepsNew : null;
    } catch {
        // The plain answer is still true: it claims nothing about the draft.
    }
    return null;
}

/** A stale answer, by what moved. 14-1's own text names IDs and the CLI, so none of it shows. */
function staleWording(code: 'stale' | 'not-found', message: string): string {
    if (code === 'not-found') return "This item isn't in the inbox any more, so nothing was written. Refresh the inbox.";
    // #17's bind and archive, once the missing source came back: the watcher closes the item.
    if (/source is back at /.test(message)) return 'Its source is back in the library, so nothing was written, and the watcher closes this item on its next pass. Refresh after it runs.';
    if (/active revision/.test(message)) return 'A publish or rollback happened since the page loaded, so nothing was written. Refresh and review it again.';
    if (/source changed/.test(message)) return "The photograph's source changed since the page loaded, so nothing was written. Refresh and review the newer item.";
    if (/photo record moved while leaving it in draft waited/.test(message)) return "This photograph's draft changed while Decide later waited, so nothing was written. Refresh and review it again.";
    return 'This item changed since the page loaded, so nothing was written. Refresh and review it again.';
}

/**
 * #118: archive's notes about the series it left, in the page's words: each series by its title, never its ID, and
 * a chapter's new start as "the next photograph". Any note that would still name an ID is left out.
 */
async function archiveNotes(root: string, notes: readonly string[]): Promise<string[]> {
    let titles = new Map<string, string>();
    try {
        titles = new Map((await readAuthoredSeries(root)).series.map((series) => [series.id, series.title.trim() || 'A series']));
    } catch {
        // Without titles every note names an ID, so none shows. The series themselves say what changed.
    }
    const named = (id: string) => titles.get(id) ?? id;
    return notes
        .slice(1, -1)
        .map((note) => note
            .replace(/^(ser_\S+?)('s chapter \S+ starts at \S+ now\.)$/, (_, id: string) => `A chapter in ${named(id)} starts at the next photograph now.`)
            .replace(/^(ser_[^\s']+)/, (id) => named(id)))
        .filter((note) => !NOT_FOR_THE_PAGE.test(note));
}

/** #118: the field a bind's refusal is about: the files to choose from when several are linked, the path otherwise. */
function bindField(message: string): FormField | undefined {
    if (/^\d+ files are linked to /.test(message)) return 'bindTo';
    return PATH_REFUSAL.test(message) ? 'path' : undefined;
}

/** #118: what an archive has written of a photograph so far: the series that list it, and its pending archive decision. */
interface ArchiveFootprint {
    series: string[];
    decision: string | null;
}

/** Null when the item or the working layer can't be read, so nothing can be told. */
async function archiveFootprint(root: string, eventId: string): Promise<ArchiveFootprint | null> {
    try {
        const photoId = (await readEvent(root, eventId))?.photoId ?? null;
        if (photoId === null) return null;
        const { series } = await readAuthoredSeries(root);
        return { series: series.filter((entry) => entry.photoIds.includes(photoId)).map((entry) => entry.id), decision: (await pendingArchiveOf(root, photoId))?.decisionId ?? null };
    } catch {
        return null;
    }
}

/**
 * #118: an archive that failed after part of it landed, by what changed since it started: a series it left, or the
 * archive decision, written before the event was. Null when neither changed, so the plain answer, nothing written, is true.
 */
function partialArchive(before: ArchiveFootprint | null, after: ArchiveFootprint | null): string | null {
    if (before === null || after === null) return null;
    if (after.decision !== null && before.decision === null) {
        return "The archive stopped part way: it's written, but the item hasn't changed. The watcher applies it on its next pass. Refresh after it runs.";
    }
    if (before.series.some((id) => !after.series.includes(id))) {
        return "The archive stopped part way: this photograph is out of the draft's series, but it isn't archived, and the item hasn't changed. Refresh, then archive it again to finish it.";
    }
    return null;
}

/** #118: a bind's answer, by the path the event recorded and whether the file holds the photograph's own bytes. */
function bindDone(event: CurationEvent, notes: readonly string[]): string {
    const bound = event.decisions.at(-1);
    if (bound?.action !== 'bind' || bound.path === undefined) return DONE.bind;
    const ownBytes = notes.some((note) => / own bytes, so nothing new needs confirming/.test(note)) ? true : notes.some((note) => /^A replacement item opens for the new bytes/.test(note)) ? false : null;
    return bindAnswer(printable(bound.path), ownBytes);
}

let serial = 0;

/** Run one inbox action from its form. Never throws for anything the form or the data holds; every answer is a state the page shows, with no host path in it. */
export async function runInboxAction(
    kind: InboxActionKind,
    form: unknown,
    options: { actor?: string; clock?: () => number; waitMs?: number; /** A8 review S2: an approval refuses an item with a series saved on it. */ keepSavedSeries?: boolean } = {},
): Promise<InboxActionState> {
    serial += 1;
    const answer = (status: Exclude<InboxActionState, { status: 'idle' }>['status'], eventId: string | null, message: string, field?: FormField): InboxActionState => {
        return { status, action: kind, eventId, message: scrub(message, [dataRootStatus().root, configuredLibraryRoot()]), ...(field ? { field } : {}), serial };
    };
    if (!(form instanceof FormData)) return answer('invalid', null, 'The form was empty. Refresh the inbox.');
    let input: ActionInput;
    try {
        const item = itemFields(form);
        const status = dataRootStatus({ versioned: true });
        if (status.state !== 'ready' || status.root === null) return answer('failed', item.eventId, `The data root is ${status.state}. Nothing was written.`);
        input = { root: status.root, ...item, actor: options.actor ?? WEB_ACTOR, ...(options.clock ? { clock: options.clock } : {}), ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }) };
    } catch (error) {
        if (error instanceof InboxFormError) return answer('invalid', null, error.message);
        throw error;
    }
    let outcome: ActionOutcome;
    // #118: what an archive has written before it runs, so a failure part way never answers that nothing was.
    const footprint = kind === 'archive' ? await archiveFootprint(input.root, input.eventId) : null;
    const partWritten = async () => (kind === 'archive' ? partialArchive(footprint, await archiveFootprint(input.root, input.eventId)) : null);
    try {
        switch (kind) {
            case 'approve':
                outcome = await approveEvent({ ...input, choices: choicesFrom(form, 'approve'), keepPlaced: true, ...(options.keepSavedSeries ? { keepSavedSeries: true } : {}) });
                break;
            case 'edit':
                outcome = await editEvent({ ...input, choices: choicesFrom(form, 'edit') });
                break;
            case 'defer':
                // As the CLI's defer: #17's leaveInDraft(), which is 14-1's defer for every type but a replacement. On a
                // reopened replacement whose confirm landed, it puts back the revision that confirm replaced, as reopen's note says.
                outcome = await leaveInDraft({ ...input, reason: reasonFrom(form) });
                break;
            case 'dismiss':
                outcome = await dismissEvent({ ...input, reason: reasonFrom(form, 'Dismissing') as string });
                break;
            case 'retry':
                outcome = await retryEvent({ ...input, reason: reasonFrom(form) });
                break;
            case 'reopen':
                outcome = await reopenEvent({ ...input, reason: reasonFrom(form), keepResolvedMissing: true });
                break;
            // #118: #17's resolutions, as the CLI's confirm, bind and archive run them.
            case 'confirm':
                outcome = await confirmReplacement(input);
                break;
            case 'bind':
                outcome = await bindReplacement({ ...input, path: await bindPathFrom(form, input.root, input.eventId) });
                break;
            case 'archive':
                outcome = await archiveMissing({ ...input, reason: archiveFrom(form) });
                break;
        }
    } catch (error) {
        if (error instanceof InboxFormError) return answer('invalid', input.eventId, error.message, error.field);
        // Storage errors can name a host path, so only the kind of failure shows here. The server log keeps the rest.
        console.error(`[curation] The inbox ${kind} on ${input.eventId} failed:`, error);
        const partial = await partWritten();
        if (partial !== null) return answer('failed', input.eventId, partial);
        return answer('failed', input.eventId, `The inbox couldn't finish that (${error instanceof Error ? error.name : 'an error'}). Refresh and check the item before trying again.`);
    }
    if (outcome.ok) {
        // #118: a confirm says whether it wrote the draft; a bind that it waits for the watcher; an archive what it left.
        if (kind === 'confirm') return answer('done', outcome.event.id, (outcome.event.decisions.at(-1)?.writes?.length ?? 0) > 0 ? DONE.confirm : DONE_ANSWER.confirmedAlready);
        if (kind === 'bind') return answer('done', outcome.event.id, bindDone(outcome.event, outcome.notes));
        if (kind === 'archive') return answer('done', outcome.event.id, [DONE.archive, ...(await archiveNotes(input.root, outcome.notes))].join(' '));
        // An approval's later notes say what still holds publishing back, such as a missing or unreviewed description.
        const extra = kind === 'approve' ? outcome.notes.slice(1) : [];
        // Decide later that put an earlier revision back changed the draft, so it can't say nothing did. One that kept a
        // replacement's new version in the draft says the next publish uses it, as the CLI's defer does.
        const head = kind === 'defer' && (outcome.event.decisions.at(-1)?.writes?.length ?? 0) > 0 ? DONE_ANSWER.putBack : ((await replacementAnswer(input.root, kind, outcome.event)) ?? DONE[kind]);
        return answer('done', outcome.event.id, [head, ...extra].join(' '));
    }
    // Refreshing doesn't change what the draft holds, so this refusal names what changed and what to do, with no refresh to offer.
    if (kind === 'defer' && outcome.code === 'stale' && MOVED_REFUSAL.test(outcome.message)) return answer('refused', input.eventId, MOVED_ANSWER);
    // #118: an archive that stopped after a series or its decision landed wrote something, so none of the "nothing was
    // written" answers fits, whatever the writer or the event's write said.
    const partial = kind === 'archive' ? await partWritten() : null;
    if (partial !== null) {
        console.warn(`[curation] The inbox archive on ${input.eventId} stopped part way: ${scrub(outcome.message, [dataRootStatus().root, configuredLibraryRoot()])}`);
        return answer('failed', input.eventId, partial);
    }
    // A set still building is the item waiting, not the data root failing.
    if (kind === 'confirm' && outcome.code === 'not-ready' && /derivatives are still building/.test(outcome.message)) return answer('refused', input.eventId, `${CONFIRM_UNAVAILABLE.building} Nothing was written.`);
    if (outcome.code === 'stale' || outcome.code === 'not-found') return answer('stale', input.eventId, staleWording(outcome.code, outcome.message));
    if (outcome.code === 'locked') return answer('busy', input.eventId, 'Another change is being written right now, so nothing was written. Try again in a moment.');
    const status = STATUS_FOR[outcome.code] as 'refused' | 'invalid' | 'failed';
    // 14-1's own words, IDs and all, stay in the server log.
    if (status === 'failed') console.warn(`[curation] The inbox ${kind} on ${input.eventId} failed: ${scrub(outcome.message, [dataRootStatus().root, configuredLibraryRoot()])}`);
    return answer(status, input.eventId, pageWording(outcome.message, status), kind === 'bind' ? bindField(outcome.message) : undefined);
}
