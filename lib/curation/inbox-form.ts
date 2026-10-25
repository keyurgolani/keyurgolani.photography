import { REVISION_ID_RE, SERIES_ID_RE } from '../catalog/schema';
import { PHOTO_ID_RE } from '../identity/ids';
import { dataRootStatus, libraryRoot } from '../storage/config';
import { approveEvent, deferEvent, dismissEvent, editEvent, reopenEvent, retryEvent, type ActionInput, type ActionOutcome, type Choices } from './actions';
import { scrub } from './commands';
import { EVENT_ID_RE, type CuratorDescription } from './events';
import { parsePlacementValue, type InboxActionKind, type InboxActionState } from './inbox-view';
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
 */

/** Who the web curator acts as. There's no session, so there's no name: the SSH tunnel is the way in (docs/curator.md). */
export const WEB_ACTOR = 'curator:web';

export class InboxFormError extends Error {}

const invalid = (message: string): never => {
    throw new InboxFormError(message);
};

function field(form: FormData, name: string): string | null {
    const value = form.get(name);
    if (value === null) return null;
    if (typeof value !== 'string') return invalid(`${name} must be text.`);
    return value;
}

function text(value: string, label: string, max: number): string {
    const checked = ownerText(value, { field: label, max });
    if (!checked.ok) invalid(checked.problem);
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
 * The curator's choices: only the fields the form sends. The page leaves a
 * series or position field out until the curator changes it, so an untouched
 * suggestion stays a suggestion, as 14-1 resolves it.
 */
export function choicesFrom(form: FormData, kind: 'approve' | 'edit'): Choices {
    const choices: Choices = {};
    const series = field(form, 'series');
    if (series !== null && series !== '') {
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
    // The description field is sent only when the curator changed it or it holds their saved text.
    const decorative = field(form, 'decorative') === 'on';
    const description = field(form, 'description');
    if (decorative) choices.description = { kind: 'decorative' };
    else if (description !== null) {
        if (description.trim() === '') {
            // An emptied field clears the curator's own text. An approval then places the photo with no description.
            if (field(form, 'descriptionWas') !== null) choices.description = null;
        } else {
            const typed: CuratorDescription = { kind: 'described', text: text(description, 'The description', MAX_DESCRIPTION_LENGTH) };
            choices.description = typed;
        }
    }
    if (kind === 'edit' && choices.seriesId === undefined && choices.placement === undefined && choices.description === undefined) {
        invalid('Nothing changed, so there is nothing to save.');
    }
    return choices;
}

function reasonFrom(form: FormData, required: boolean): string | undefined {
    const reason = field(form, 'reason');
    if (reason === null || reason.trim() === '') {
        if (required) invalid('Dismissing needs a reason.');
        return undefined;
    }
    return text(reason, 'The reason', MAX_REASON_LENGTH);
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
    approve: 'Approved into the draft. Nothing is published until you publish.',
    edit: 'Saved your edits. Nothing in the draft changed.',
    defer: 'Left in draft.',
    dismiss: 'Dismissed.',
    retry: 'Asked the watcher to process it again on its next pass.',
    reopen: 'Reopened.',
};

let serial = 0;

/** Run one inbox action from its form. Never throws for anything the form or the data holds; every answer is a state the page shows, with no host path in it. */
export async function runInboxAction(kind: InboxActionKind, form: unknown, options: { actor?: string; clock?: () => number; waitMs?: number } = {}): Promise<InboxActionState> {
    serial += 1;
    const answer = (status: Exclude<InboxActionState, { status: 'idle' }>['status'], eventId: string | null, message: string): InboxActionState => {
        return { status, action: kind, eventId, message: scrub(message, [dataRootStatus().root, libraryRoot()]), serial };
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
    try {
        switch (kind) {
            case 'approve':
                outcome = await approveEvent({ ...input, choices: choicesFrom(form, 'approve') });
                break;
            case 'edit':
                outcome = await editEvent({ ...input, choices: choicesFrom(form, 'edit') });
                break;
            case 'defer':
                outcome = await deferEvent({ ...input, reason: reasonFrom(form, false) });
                break;
            case 'dismiss':
                outcome = await dismissEvent({ ...input, reason: reasonFrom(form, true) as string });
                break;
            case 'retry':
                outcome = await retryEvent({ ...input, reason: reasonFrom(form, false) });
                break;
            case 'reopen':
                outcome = await reopenEvent({ ...input, reason: reasonFrom(form, false) });
                break;
        }
    } catch (error) {
        if (error instanceof InboxFormError) return answer('invalid', input.eventId, error.message);
        // Storage errors can name a host path, so only the kind of failure shows here. The server log keeps the rest.
        console.error(`[curation] The inbox ${kind} on ${input.eventId} failed:`, error);
        return answer('failed', input.eventId, `The inbox couldn't finish that (${error instanceof Error ? error.name : 'an error'}). Refresh and check the item before trying again.`);
    }
    if (outcome.ok) {
        // An approval's later notes say what still holds publishing back, such as a missing or unreviewed description.
        const extra = kind === 'approve' ? outcome.notes.slice(1) : [];
        return answer('done', outcome.event.id, [DONE[kind], ...extra].join(' '));
    }
    if (outcome.code === 'stale' || outcome.code === 'not-found') {
        return answer('stale', input.eventId, `This item changed since the page loaded, so nothing was written. Refresh and review it again. (${outcome.message})`);
    }
    if (outcome.code === 'locked') return answer('busy', input.eventId, 'Another change is being written right now, so nothing was written. Try again in a moment.');
    return answer(STATUS_FOR[outcome.code], input.eventId, outcome.message);
}
