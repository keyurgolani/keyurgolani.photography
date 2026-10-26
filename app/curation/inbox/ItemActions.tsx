'use client';

import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { Save } from 'lucide-react';
import styles from '../curator.module.css';
import { approveItem, deferItem, dismissItem, editItem, reopenItem, retryItem } from './actions';
import { itemUrl, moveOn } from './journey';
import {
    arrivalMessage,
    DEFER_LABEL,
    fileParts,
    defaultDescription,
    defaultPlacement,
    descriptionHint,
    formStart,
    IDLE,
    nextItemId,
    parsePlacementValue,
    placementLabel,
    placementValue,
    PRIMARY_ACTION,
    seriesCaption,
    seriesName,
    suggestionEvidence,
    type InboxActionKind,
    type InboxActionState,
    type InboxDetail,
    type SeriesOption,
} from '@/lib/curation/inbox-view';

const ACTIONS: Record<InboxActionKind, (previous: InboxActionState, form: FormData) => Promise<InboxActionState>> = {
    approve: approveItem,
    edit: editItem,
    defer: deferItem,
    dismiss: dismissItem,
    retry: retryItem,
    reopen: reopenItem,
};

/** Every form's submit button names its action as `intent`, and this sends the form to that action. */
async function dispatchByIntent(previous: InboxActionState, form: FormData): Promise<InboxActionState> {
    const intent = form.get('intent');
    const action = typeof intent === 'string' && Object.hasOwn(ACTIONS, intent) ? ACTIONS[intent as InboxActionKind] : null;
    return action ? action(previous, form) : previous;
}

interface ItemActionsProps {
    detail: InboxDetail;
    /** Every item's ID, in list order. The order the curator saw is what the next item follows. */
    order: string[];
    /** The items that need a decision now, in list order. A finished action's page refresh brings them up to date. */
    open: string[];
    activeRevisionId: string | null;
    series: SeriesOption[];
    seriesProblem: string | null;
    /** The "Published statement remains unchanged" note, between the suggestion and the actions. */
    note: ReactNode;
}

/** The fields every item form sends: the item, and the versions the page showed, which the action checks under the lock. */
function ItemFields({ detail, activeRevisionId }: Pick<ItemActionsProps, 'detail' | 'activeRevisionId'>) {
    return (
        <>
            <input type="hidden" name="eventId" value={detail.id} />
            <input type="hidden" name="version" value={detail.version} />
            <input type="hidden" name="base" value={activeRevisionId ?? 'none'} />
        </>
    );
}

const TONE: Record<Exclude<InboxActionState, { status: 'idle' }>['status'], 'done' | 'change' | 'alert'> = {
    done: 'done',
    stale: 'change',
    busy: 'change',
    refused: 'alert',
    invalid: 'alert',
    failed: 'alert',
};

/**
 * Reload the item. A link to the URL the page is already on, `#item` and all,
 * would only scroll to the fragment and read nothing again, so once the page
 * is hydrated this puts the item's URL in place and reloads it. Before that,
 * the plain link still works from any URL that differs in more than its fragment.
 */
function reloadItem(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    window.history.replaceState(window.history.state, '', event.currentTarget.href);
    window.location.reload();
}

function Notice({ state, detail }: { state: InboxActionState; detail: InboxDetail }) {
    if (state.status === 'idle') return null;
    return (
        <div className={styles.notice} data-tone={TONE[state.status]} data-state={state.status}>
            <p>{state.message}</p>
            {state.status === 'stale' ? (
                <a className={styles.linkButton} href={`/curation/inbox?item=${detail.id}#item`} onClick={reloadItem}>
                    Refresh and review again
                </a>
            ) : null}
        </div>
    );
}

/** Where an answer shows: by the field it's about, inside Dismiss for a dismissal Dismiss can still take, or under the action buttons. */
type AnswerSlot = 'description' | 'dismiss' | 'actions';

function slotOf(state: InboxActionState, canDismiss: boolean): AnswerSlot | null {
    if (state.status === 'idle') return null;
    if (state.field === 'description') return 'description';
    // A dismissal that went through leaves no Dismiss to show it in, so its answer shows under the buttons, by Reopen.
    if (state.action === 'dismiss' && canDismiss) return 'dismiss';
    return 'actions';
}

/**
 * A polite live region, there from the start, so an answer put in it is read
 * out. It holds the answers to actions taken on this page; what an approval
 * or Decide later did before this item opened is ArrivalStrip's, at the top.
 */
function AnswerRegion({ show, state, detail }: { show: boolean; state: InboxActionState; detail: InboxDetail }) {
    return (
        <div role="status" aria-live="polite" className={styles.answer}>
            {show ? <Notice state={state} detail={detail} /> : null}
        </div>
    );
}

/** The suggestion a new photograph comes with, as fields the curator can change before approving. */
function SuggestionFields({ detail, series, seriesProblem, answer }: Pick<ItemActionsProps, 'detail' | 'series' | 'seriesProblem'> & { answer: InboxActionState }) {
    const start = formStart(detail, series.map((option) => option.id));
    const initialSeries = start.series;
    const known = (id: string) => series.some((option) => option.id === id);
    const initialValue = initialSeries === undefined ? '' : initialSeries === null ? 'unassigned' : known(initialSeries) ? initialSeries : '';
    const [seriesValue, setSeriesValue] = useState<string>(initialValue);
    const [seriesTouched, setSeriesTouched] = useState(false);
    const chosen = series.find((option) => option.id === seriesValue) ?? null;
    const initialPlacement = chosen ? placementValue(defaultPlacement(detail, chosen.id)) : 'end';
    const [placement, setPlacement] = useState<string | null>(null);
    const [editor, setEditor] = useState(false);
    const placementShown = placement ?? initialPlacement;
    // A saved edit, or for a reopened item what its photo record already holds, so a clear can withdraw either.
    const saved = defaultDescription(detail);
    const [description, setDescription] = useState(saved?.kind === 'described' ? saved.text : '');
    const [decorative, setDecorative] = useState(saved?.kind === 'decorative');

    const suggested = detail.suggestions.series;
    const suggestedPlacement = detail.suggestions.placement;
    const unknownSuggestion = suggested?.value && !known(suggested.value) ? suggested.value : null;
    const labelOf = (seriesId: string) => seriesName(series, seriesId);
    // While the select still shows where the form started, the caption says where that is; once the curator picks, it gives the suggestion.
    const caption =
        seriesValue === initialValue && initialValue !== ''
            ? seriesCaption(detail, start, labelOf)
            : seriesCaption(detail, suggested ? { series: suggested.value, from: 'suggestion' } : { series: undefined, from: 'none' }, labelOf);
    const evidence = suggestionEvidence(suggested);
    // A refused description shows by the field, and the field takes focus, so the curator is where the fix goes.
    const descriptionError = answer.status === 'invalid' && answer.field === 'description' ? answer.message : null;
    const descriptionRef = useRef<HTMLInputElement>(null);
    const answerSerial = answer.status === 'idle' ? 0 : answer.serial;
    useEffect(() => {
        if (descriptionError) descriptionRef.current?.focus();
    }, [answerSerial, descriptionError]);
    // A position chosen for one series means nothing in another, so a new series starts from its own default.
    const pickSeries = (value: string) => {
        setSeriesValue(value);
        setSeriesTouched(true);
        setPlacement(null);
        setEditor(false);
    };
    const members = chosen?.members.filter((member) => member.photoId !== detail.photoId) ?? [];
    const options = ['start', 'end', ...members.map((member) => `after:${member.photoId}`)];

    return (
        <section className={styles.box} aria-labelledby="suggestion-heading">
            <h3 className={styles.boxTitle} id="suggestion-heading">
                Reviewable suggestion
            </h3>
            {/* The shown series is always sent, so what the page shows is what an approval stores; Save edits counts it only once it's changed. */}
            {seriesValue !== '' ? <input type="hidden" name="series" value={seriesValue} /> : null}
            {seriesTouched ? <input type="hidden" name="seriesTouched" value="1" /> : null}
            {/* A position is sent only once the curator picks one, so a suggested position stays a suggestion and never reads as an authored move. */}
            {placement !== null && chosen ? <input type="hidden" name="placement" value={placement} /> : null}

            <label className={styles.label}>
                Suggested series
                <select className={styles.control} value={seriesValue} onChange={(event) => pickSeries(event.target.value)}>
                    {seriesValue === '' ? <option value="">Choose a series</option> : null}
                    {series.map((option) => (
                        <option key={option.id} value={option.id}>
                            {option.label}
                            {option.visibility === 'published' ? '' : ` (${option.visibility})`}
                        </option>
                    ))}
                    <option value="unassigned">Leave unassigned</option>
                </select>
            </label>
            <p className={styles.hint}>{caption}</p>
            {evidence.length > 0 ? (
                <ul className={styles.evidence}>
                    {evidence.map((line, index) => (
                        <li key={index}>{line}</li>
                    ))}
                </ul>
            ) : null}
            {unknownSuggestion ? <p className={styles.hint}>The suggested series {unknownSuggestion} isn&apos;t in the working layer any more.</p> : null}
            {seriesProblem ? <p className={styles.hint}>{seriesProblem}</p> : null}

            <label className={styles.label}>
                Draft description
                {/* One line, as the server stores it: a description can't hold a line break. */}
                <input
                    ref={descriptionRef}
                    type="text"
                    className={styles.control}
                    name="description"
                    value={description}
                    disabled={decorative}
                    autoComplete="off"
                    onChange={(event) => setDescription(event.target.value)}
                    aria-invalid={descriptionError ? true : undefined}
                    aria-describedby={descriptionError ? 'description-error description-hint' : 'description-hint'}
                />
            </label>
            {/* What was saved, so an emptied field or an unchecked box clears it. */}
            {saved ? <input type="hidden" name="descriptionWas" value={saved.kind} /> : null}
            {descriptionError ? (
                <p className={styles.fieldError} id="description-error" data-state="invalid">
                    {descriptionError}
                </p>
            ) : null}
            <p className={styles.hint} id="description-hint">
                {descriptionHint(detail)}
            </p>
            <label className={styles.check}>
                <input type="checkbox" checked={decorative} onChange={(event) => setDecorative(event.target.checked)} />
                Decorative: it needs no description
            </label>
            {/* The box's state, sent every time, so unchecked means not decorative. */}
            <input type="hidden" name="decorative" value={decorative ? 'on' : 'off'} />

            <label className={styles.label}>
                Proposed sequence position
                <select
                    className={styles.control}
                    value={editor ? 'editor' : placementShown}
                    disabled={!chosen}
                    onChange={(event) => {
                        if (event.target.value === 'editor') {
                            setEditor(true);
                            return;
                        }
                        setEditor(false);
                        setPlacement(event.target.value);
                    }}
                >
                    {!chosen ? <option value={placementShown}>{seriesValue === 'unassigned' ? 'No position: left unassigned' : 'Choose a series first'}</option> : null}
                    {chosen
                        ? options.map((value) => (
                              <option key={value} value={value}>
                                  {placementLabel(parsePlacementValue(value) ?? 'end', chosen.members)}
                              </option>
                          ))
                        : null}
                    {chosen ? <option value="editor">Choose in sequence editor</option> : null}
                </select>
            </label>
            {chosen && suggestedPlacement && suggested?.value === chosen.id ? (
                <p className={styles.hint}>
                    Suggested {placementLabel(suggestedPlacement.value, chosen.members).toLowerCase()}, {suggestedPlacement.confidence} confidence, by {suggestedPlacement.producedBy}.
                </p>
            ) : null}
            {chosen && editor ? (
                <fieldset className={styles.sequence}>
                    <legend>Place it in {chosen.label}</legend>
                    <label className={styles.slot}>
                        <input type="radio" name="sequenceSlot" value="start" checked={placementShown === 'start'} onChange={() => setPlacement('start')} />
                        At the start
                    </label>
                    {members.map((member, index) => (
                        <div key={member.photoId}>
                            <div className={styles.member}>
                                {String(chosen.members.findIndex((entry) => entry.photoId === member.photoId) + 1).padStart(2, '0')} {member.shortId}
                            </div>
                            <label className={styles.slot}>
                                <input
                                    type="radio"
                                    name="sequenceSlot"
                                    value={`after:${member.photoId}`}
                                    checked={placementShown === `after:${member.photoId}` || (index === members.length - 1 && placementShown === 'end')}
                                    onChange={() => setPlacement(index === members.length - 1 ? 'end' : `after:${member.photoId}`)}
                                />
                                {index === members.length - 1 ? 'At the end' : `After photograph ${String(chosen.members.findIndex((entry) => entry.photoId === member.photoId) + 1).padStart(2, '0')}`}
                            </label>
                        </div>
                    ))}
                </fieldset>
            ) : null}
        </section>
    );
}

/** 14-1's actions on the selected item, each a form the page's server actions take. */
export default function ItemActions({ detail, order, open, activeRevisionId, series, seriesProblem, note }: ItemActionsProps) {
    const [state, dispatch, pending] = useActionState(dispatchByIntent, IDLE);
    // The list order as the page first showed it, so the next item is the one after this in the list the curator saw.
    const [seen] = useState(order);
    // The version an approval or Decide later was sent for. Once the page shows a newer one, the refresh after it has landed, and `open` is current.
    const sentVersion = useRef<number | null>(null);
    // Submitting by hand, not through <form action>, so React never resets the form after an answer: a reset would put
    // each select back to its page-load option while the curator's choice is still what the form sends.
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        const form = new FormData(event.currentTarget);
        if (submitter instanceof HTMLButtonElement && submitter.name) form.set(submitter.name, submitter.value);
        const intent = form.get('intent');
        sentVersion.current = intent === 'approve' || intent === 'defer' ? detail.version : null;
        // On the plain inbox URL a wide screen shows the first item that needs judgment, and the refresh after an action
        // would show the next one in its place, with no answer. Naming this item in the URL first keeps it on the page,
        // so its answer shows and moving on runs. The data must not be Next's own history state, or its router skips the
        // new URL, which the action posts to. Nothing else changes: it's the URL this item's row links to.
        if (new URLSearchParams(window.location.search).get('item') !== detail.id) window.history.replaceState(null, '', itemUrl(detail.id));
        startTransition(() => dispatch(form));
    };
    // After an approval or Decide later, open the next item that needs a decision (owner, 2026-10-25). Reopen and the rest stay on the item.
    useEffect(() => {
        if (state.status !== 'done' || (state.action !== 'approve' && state.action !== 'defer') || state.eventId !== detail.id) return;
        if (sentVersion.current === null || detail.version === sentVersion.current) return;
        sentVersion.current = null;
        const fromName = fileParts(detail.sourcePath).name;
        moveOn({ to: nextItemId(seen, detail.id, open), from: detail.id, fromName, message: arrivalMessage(state.action, fromName, state.message) });
    }, [state, detail.id, detail.version, detail.sourcePath, seen, open]);
    const primary = PRIMARY_ACTION[detail.type];
    const { can } = detail;
    const unavailable = primary !== undefined && detail.type !== 'new' && detail.primaryUnavailable !== null;
    const anyButton = unavailable || (detail.type === 'new' && (can.edit || can.approve)) || can.defer;
    const slot = slotOf(state, can.dismiss);
    return (
        <>
            <form method="post" onSubmit={submit} aria-label="Review">
                <ItemFields detail={detail} activeRevisionId={activeRevisionId} />
                {/* The form version the page showed, so a form left open across a refresh never reads as another item's. */}
                {detail.type === 'new' && can.edit ? <SuggestionFields key={detail.version} detail={detail} series={series} seriesProblem={seriesProblem} answer={state} /> : null}
                {note}
                {anyButton ? (
                    <div className={styles.actions}>
                        {/* An action the inbox can't take yet stays visible with its reason, before the live ones and quieter than them. */}
                        {unavailable ? (
                            <button type="button" className={`${styles.button} ${styles.unavailable}`} disabled aria-describedby="primary-unavailable">
                                {primary}
                            </button>
                        ) : null}
                        {detail.type === 'new' && can.edit ? (
                            <button type="submit" name="intent" value="edit" className={styles.button} disabled={pending}>
                                Save edits
                            </button>
                        ) : null}
                        {can.defer ? (
                            <button type="submit" name="intent" value="defer" className={styles.button} disabled={pending}>
                                {DEFER_LABEL}
                            </button>
                        ) : null}
                        {primary && detail.type === 'new' && can.approve ? (
                            <button type="submit" name="intent" value="approve" className={`${styles.button} ${styles.primary}`} disabled={pending}>
                                <Save size={16} aria-hidden="true" />
                                {primary}
                            </button>
                        ) : null}
                    </div>
                ) : null}
                {detail.primaryUnavailable ? (
                    <p className={styles.hint} id="primary-unavailable">
                        {detail.primaryUnavailable}
                    </p>
                ) : null}
                {detail.status === 'approved' ? <p className={styles.hint}>Reopen it to change its series or description.</p> : null}
            </form>

            {can.retry ? (
                <form method="post" onSubmit={submit} className={styles.actions}>
                    <ItemFields detail={detail} activeRevisionId={activeRevisionId} />
                    <button type="submit" name="intent" value="retry" className={styles.button} disabled={pending}>
                        Retry processing
                    </button>
                </form>
            ) : null}

            {can.reopen ? (
                <form method="post" onSubmit={submit} className={styles.actions}>
                    <ItemFields detail={detail} activeRevisionId={activeRevisionId} />
                    <button type="submit" name="intent" value="reopen" className={styles.button} disabled={pending}>
                        Reopen
                    </button>
                </form>
            ) : null}

            {/* Every answer but a dismissal or a refused description lands here, right under the buttons that produced it. */}
            <AnswerRegion show={slot === 'actions'} state={state} detail={detail} />

            {can.dismiss ? (
                <details className={styles.more}>
                    <summary>Dismiss with a reason</summary>
                    <form method="post" onSubmit={submit}>
                        <ItemFields detail={detail} activeRevisionId={activeRevisionId} />
                        <label className={styles.label}>
                            Reason
                            <input className={styles.control} name="reason" required maxLength={500} autoComplete="off" />
                        </label>
                        <div className={styles.actions}>
                            <button type="submit" name="intent" value="dismiss" className={styles.button} disabled={pending}>
                                Dismiss
                            </button>
                        </div>
                    </form>
                    <AnswerRegion show={slot === 'dismiss'} state={state} detail={detail} />
                </details>
            ) : null}
        </>
    );
}
