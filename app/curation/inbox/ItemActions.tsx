'use client';

import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { Check, Save } from 'lucide-react';
import styles from '../curator.module.css';
import { approveItem, archiveItem, bindItem, confirmItem, deferItem, dismissItem, editItem, reopenItem, retryItem } from './actions';
import { itemUrl, moveOn } from './journey';
import {
    ARCHIVE_TAKEDOWN,
    archiveQuestion,
    arrivalMessage,
    decideLaterRefuses,
    DEFER_LABEL,
    fileParts,
    defaultDescription,
    defaultPlacement,
    descriptionHint,
    formStart,
    IDLE,
    LIBRARY_PATH_HINT,
    nextItemId,
    parsePlacementValue,
    placementLabel,
    placementValue,
    PRIMARY_ACTION,
    reopenHint,
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
    confirm: confirmItem,
    bind: bindItem,
    archive: archiveItem,
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
    /** The "Published statement remains unchanged" note, between the suggestion and the actions, where the photograph has one. */
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
    // #118: a bind that went through only waits for the watcher, so it takes the waiting tone, not the done one.
    const tone = state.status === 'done' && state.action === 'bind' ? 'change' : TONE[state.status];
    return (
        <div className={styles.notice} data-tone={tone} data-state={state.status}>
            <p>{state.message}</p>
            {state.status === 'stale' ? (
                <a className={styles.linkButton} href={`/curation/inbox?item=${detail.id}#item`} onClick={reloadItem}>
                    Refresh and review again
                </a>
            ) : null}
        </div>
    );
}

/**
 * Where an answer shows: by the field it's about, inside Dismiss, Bind or Archive for an answer that form can still
 * take, or under the action buttons.
 */
type AnswerSlot = 'description' | 'dismiss' | 'bind' | 'archive' | 'actions';

function slotOf(state: InboxActionState, can: InboxDetail['can']): AnswerSlot | null {
    if (state.status === 'idle') return null;
    if (state.field === 'description') return 'description';
    // A dismissal that went through leaves no Dismiss to show it in, so its answer shows under the buttons, by Reopen.
    // So does a bind or an archive once the refresh after it takes its form away (#118).
    if (state.action === 'dismiss' && can.dismiss) return 'dismiss';
    if (state.action === 'bind' && can.bind) return 'bind';
    if (state.action === 'archive' && can.archive) return 'archive';
    return 'actions';
}

/**
 * A polite live region, there from the start, so an answer put in it is read
 * out. It holds the answers to actions taken on this page; what an approval
 * or Decide later did before this item opened is ArrivalStrip's, at the top.
 * The one under the buttons takes focus when the control that was pressed is
 * gone after the refresh, so focus never drops to the page's body.
 */
function AnswerRegion({ show, state, detail, regionRef, announce }: { show: boolean; state: InboxActionState; detail: InboxDetail; regionRef?: RefObject<HTMLDivElement | null>; announce?: { text: string; serial: number } | null }) {
    return (
        <div role="status" aria-live="polite" className={styles.answer} ref={regionRef} tabIndex={regionRef ? -1 : undefined}>
            {/* #118: a refusal the page makes itself, before any post, said here too, since the field it's by may already
                hold focus. A new node each time, so the same words are read again. The field shows it on screen. */}
            {announce ? (
                <p key={announce.serial} className={styles.visuallyHidden}>
                    {announce.text}
                </p>
            ) : show ? (
                <Notice state={state} detail={detail} />
            ) : null}
        </div>
    );
}

/** What every submit button says while an action is out: unavailable, but focusable still (#1's focus contract). */
const offWhile = (pending: boolean) => ({ 'aria-disabled': pending || undefined, 'data-off': pending ? 'true' : undefined });

interface ResolveProps {
    detail: InboxDetail;
    activeRevisionId: string | null;
    state: InboxActionState;
    pending: boolean;
    slot: AnswerSlot | null;
    submit: (event: FormEvent<HTMLFormElement>) => void;
}

/**
 * #118: Bind, for a missing source: #17's bindReplacement() gives the photograph the file at a library path. The file
 * #10 linked at its last path is chosen when there's one; several are offered with none chosen; and another file's
 * path can be typed, which the server checks is inside the library. The watcher applies the bind on its next pass,
 * so the item stays open until then, and the answer says it waits.
 */
function BindForm({ detail, activeRevisionId, state, pending, slot, submit }: ResolveProps) {
    const linked = detail.linkedFiles;
    // A linked file goes by its item's ID, never its path, which the page shows escaped: the server reads the path again.
    const [choice, setChoice] = useState<string | null>(linked.length === 1 ? linked[0].id : linked.length === 0 ? 'typed' : null);
    const [path, setPath] = useState('');
    const pathRef = useRef<HTMLInputElement>(null);
    const firstFileRef = useRef<HTMLInputElement>(null);
    const refusedBind = state.status !== 'idle' && state.status !== 'done' && state.action === 'bind' ? state : null;
    const pathError = refusedBind?.field === 'path' ? refusedBind.message : null;
    // A refusal about which linked file shows by the files, while there are files to show it by.
    const filesError = refusedBind?.field === 'bindTo' && linked.length > 0 ? refusedBind.message : null;
    const answerSerial = state.status === 'idle' ? 0 : state.serial;
    useEffect(() => {
        if (pathError) pathRef.current?.focus();
        else if (filesError) firstFileRef.current?.focus();
    }, [answerSerial, pathError, filesError]);
    return (
        <details className={styles.more}>
            <summary>Bind to the file that replaces it</summary>
            <form method="post" onSubmit={submit} aria-label="Bind">
                <ItemFields detail={detail} activeRevisionId={activeRevisionId} />
                {linked.length > 0 ? (
                    <fieldset className={styles.sequence} aria-describedby={filesError ? 'bind-to-error' : undefined}>
                        <legend>File to bind</legend>
                        {linked.map((file, index) => (
                            <label key={file.id} className={styles.slot}>
                                <input ref={index === 0 ? firstFileRef : undefined} type="radio" name="bindTo" value={file.id} checked={choice === file.id} onChange={() => setChoice(file.id)} />
                                {linked.length === 1 ? `${file.path}, the new file at its last path` : file.path}
                            </label>
                        ))}
                        <label className={styles.slot}>
                            <input type="radio" name="bindTo" value="typed" checked={choice === 'typed'} onChange={() => setChoice('typed')} />
                            Another file in the library
                        </label>
                    </fieldset>
                ) : (
                    <input type="hidden" name="bindTo" value="typed" />
                )}
                {filesError ? (
                    <p className={styles.fieldError} id="bind-to-error" data-state="invalid">
                        {filesError}
                    </p>
                ) : null}
                <label className={styles.label}>
                    Library path
                    <input
                        ref={pathRef}
                        className={styles.control}
                        name="path"
                        value={path}
                        required={linked.length === 0}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => {
                            setPath(event.target.value);
                            // Typing a path chooses it, so the file sent is the one in the field.
                            if (linked.length > 0) setChoice('typed');
                        }}
                        aria-invalid={pathError ? true : undefined}
                        aria-describedby={pathError ? 'bind-path-error bind-path-hint' : 'bind-path-hint'}
                    />
                </label>
                {pathError ? (
                    <p className={styles.fieldError} id="bind-path-error" data-state="invalid">
                        {pathError}
                    </p>
                ) : null}
                <p className={styles.hint} id="bind-path-hint">
                    {LIBRARY_PATH_HINT}
                </p>
                <p className={styles.hint}>The watcher applies a bind on its next pass, so this item stays open until then. Nothing a visitor sees changes.</p>
                <div className={styles.actions}>
                    <button type="submit" name="intent" value="bind" className={styles.button} {...offWhile(pending)}>
                        Bind
                    </button>
                </div>
            </form>
            {/* A refused path or file shows by its field; every other answer to Bind shows here, while Bind is still offered. */}
            <AnswerRegion show={slot === 'bind' && pathError === null && filesError === null} state={state} detail={detail} />
        </details>
    );
}

/**
 * #118: Archive, for a missing source: #17's archiveMissing() takes the photograph out of every series in the draft
 * and archives it, which the next publish makes public. That is a takedown, so it needs a reason and a second,
 * explicit step that names the file, and only that step's button sends the form.
 */
function ArchiveForm({ detail, activeRevisionId, state, pending, slot, submit }: ResolveProps) {
    const [reason, setReason] = useState('');
    const [confirming, setConfirming] = useState(false);
    const [missingReason, setMissingReason] = useState(false);
    // Counts each time the page asks for a reason, so the live region says it every time, and the field takes focus
    // once the error is there to describe it.
    const [asked, setAsked] = useState(0);
    const reasonRef = useRef<HTMLInputElement>(null);
    const archiveRef = useRef<HTMLButtonElement>(null);
    const questionRef = useRef<HTMLParagraphElement>(null);
    const refused = state.status === 'invalid' && state.action === 'archive' && state.field === 'reason' ? state.message : null;
    const reasonError = missingReason ? 'Archiving needs a reason.' : refused;
    const answerSerial = state.status === 'idle' ? 0 : state.serial;
    useEffect(() => {
        if (refused) reasonRef.current?.focus();
    }, [answerSerial, refused]);
    useEffect(() => {
        if (confirming) questionRef.current?.focus();
    }, [confirming]);
    useEffect(() => {
        if (asked > 0) reasonRef.current?.focus();
    }, [asked]);
    const toggle = () => {
        if (confirming) {
            setConfirming(false);
            return;
        }
        if (reason.trim() === '') {
            setMissingReason(true);
            setAsked((count) => count + 1);
            return;
        }
        setMissingReason(false);
        setConfirming(true);
    };
    const cancel = () => {
        setConfirming(false);
        archiveRef.current?.focus();
    };
    const question = archiveQuestion(fileParts(detail.sourcePath).name);
    return (
        <details className={styles.more}>
            <summary>Archive and take it down</summary>
            <form method="post" onSubmit={submit} aria-label="Archive">
                <ItemFields detail={detail} activeRevisionId={activeRevisionId} />
                <p className={styles.hint} id="archive-takedown">
                    {ARCHIVE_TAKEDOWN}
                </p>
                <label className={styles.label}>
                    Reason for archiving
                    <input
                        ref={reasonRef}
                        className={styles.control}
                        name="reason"
                        value={reason}
                        required
                        maxLength={500}
                        autoComplete="off"
                        onChange={(event) => {
                            setReason(event.target.value);
                            if (event.target.value.trim() !== '') setMissingReason(false);
                        }}
                        onKeyDown={(event) => {
                            // Enter in the field opens the second step, as Archive does; it never sends the form by itself.
                            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                                event.preventDefault();
                                if (!confirming) toggle();
                            }
                        }}
                        aria-invalid={reasonError ? true : undefined}
                        aria-describedby={reasonError ? 'archive-reason-error' : undefined}
                    />
                </label>
                {reasonError ? (
                    <p className={styles.fieldError} id="archive-reason-error" data-state="invalid">
                        {reasonError}
                    </p>
                ) : null}
                <div className={styles.actions}>
                    <button ref={archiveRef} type="button" className={styles.button} aria-expanded={confirming} aria-controls="archive-confirm" aria-describedby="archive-takedown" onClick={toggle}>
                        Archive
                    </button>
                </div>
                <div id="archive-confirm" role={confirming ? 'group' : undefined} aria-labelledby={confirming ? 'archive-question' : undefined}>
                    {confirming ? (
                        <>
                            {/* tabIndex -1: the second step takes focus when it opens, so the question is read first. */}
                            <p id="archive-question" tabIndex={-1} ref={questionRef}>
                                {question}
                            </p>
                            {/* Sent only from this step, and the server refuses an archive without it. */}
                            <input type="hidden" name="confirmed" value="yes" />
                            <div className={styles.actions}>
                                <button type="button" className={styles.button} onClick={cancel}>
                                    Cancel
                                </button>
                                <button type="submit" name="intent" value="archive" className={styles.button} {...offWhile(pending)}>
                                    Yes, archive it
                                </button>
                            </div>
                        </>
                    ) : null}
                </div>
            </form>
            {/* A refused reason shows by its field; every other answer to Archive shows here, while Archive is still offered. */}
            <AnswerRegion show={slot === 'archive' && refused === null} state={state} detail={detail} announce={missingReason ? { text: 'Archiving needs a reason.', serial: asked } : null} />
        </details>
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
    const descriptionRef = useRef<HTMLTextAreaElement>(null);
    const answerSerial = answer.status === 'idle' ? 0 : answer.serial;
    useEffect(() => {
        if (descriptionError) descriptionRef.current?.focus();
    }, [answerSerial, descriptionError]);
    // The box grows with what's typed: CSS does it where field-sizing works, and this elsewhere, again whenever the
    // box's width changes or the fonts arrive, since either rewraps the text.
    useEffect(() => {
        const box = descriptionRef.current;
        if (box === null || (typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content'))) return;
        let width = -1;
        const fit = () => {
            box.style.height = 'auto';
            box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
        };
        fit();
        void document.fonts?.ready.then(fit);
        if (typeof ResizeObserver !== 'function') return;
        const observer = new ResizeObserver(([entry]) => {
            if (entry.contentRect.width === width) return;
            width = entry.contentRect.width;
            fit();
        });
        observer.observe(box);
        return () => observer.disconnect();
    }, [description]);
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
                {/* Three lines at least, so it reads as a sentence to write, and it grows. A description can't hold a line
                    break, as the server stores it, so Enter adds none and a pasted run of them, with the spaces around it, becomes one space. */}
                <textarea
                    ref={descriptionRef}
                    rows={3}
                    className={`${styles.control} ${styles.description}`}
                    name="description"
                    value={description}
                    disabled={decorative}
                    autoComplete="off"
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault();
                    }}
                    onChange={(event) => setDescription(event.target.value.replace(/[^\S\r\n]*(?:\r\n|[\r\n])+\s*/g, ' '))}
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
    // Where the page was when a submit named this item in the URL, and what the page showed then. See the effect below.
    const pinned = useRef<{ scrollY: number; panelTop: number; state: InboxActionState; detail: InboxDetail } | null>(null);
    // Submitting by hand, not through <form action>, so React never resets the form after an answer: a reset would put
    // each select back to its page-load option while the curator's choice is still what the form sends.
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        // While an action is out, its buttons say they're unavailable with aria-disabled, not `disabled`: a focused
        // button that turns disabled drops keyboard focus to the page's body (#1's focus contract). So this is the guard.
        if (pending) return;
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        const form = new FormData(event.currentTarget);
        if (submitter instanceof HTMLButtonElement && submitter.name) form.set(submitter.name, submitter.value);
        const intent = form.get('intent');
        sentVersion.current = intent === 'approve' || intent === 'defer' ? detail.version : null;
        // On the plain inbox URL a wide screen shows the first item that needs judgment, and the refresh after an action
        // would show the next one in its place, with no answer. Naming this item in the URL before the action is sent
        // keeps it on the page, so its answer shows and moving on runs. The data must not be Next's own history state, or
        // its router skips the new URL, which the action posts to. It's the URL this item's row links to.
        pinned.current = null;
        if (new URLSearchParams(window.location.search).get('item') !== detail.id) {
            pinned.current = { scrollY: window.scrollY, panelTop: document.getElementById('item-details')?.scrollTop ?? 0, state, detail };
            window.history.replaceState(null, '', itemUrl(detail.id));
        }
        startTransition(() => dispatch(form));
    };
    // The refresh after a finished action renders the URL's new search, so Next's router scrolls the page to the top,
    // away from the curator's place and the answer under the buttons. Once both the answer and the refreshed item are
    // in, in one commit or two, this puts the scroll back. An answer that wrote nothing refreshes nothing, so nothing moved.
    useEffect(() => {
        const pin = pinned.current;
        if (pin === null || state === pin.state || state.status !== 'done' || detail === pin.detail) return;
        pinned.current = null;
        window.scrollTo({ top: pin.scrollY, behavior: 'instant' });
        const panel = document.getElementById('item-details');
        if (panel) panel.scrollTop = pin.panelTop;
    }, [state, detail]);
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
    // A new photograph's approve is unavailable only while a pending bind merges it (#17); its hint says why. A
    // replacement's Confirm is unavailable while its new set builds or can't be used (#118), with its own short reason,
    // since the hint beside it is about Decide later.
    const confirmReason = detail.type === 'replacement' && !can.confirm ? detail.confirmUnavailable : null;
    const unavailable = primary !== undefined && ((detail.type === 'new' && detail.primaryUnavailable !== null && !can.approve) || confirmReason !== null);
    // A replacement whose Decide later the page already knows would refuse shows it disabled, with the hint as its reason.
    const deferRefuses = can.defer && detail.type === 'replacement' && decideLaterRefuses(detail.replacement);
    const anyButton = unavailable || (detail.type === 'new' && (can.edit || can.approve)) || can.defer || can.confirm;
    const slot = slotOf(state, can);
    // #118: a confirm, bind or archive that went through takes its control away once the page refreshes. Then the
    // answer under the buttons takes the focus, which would otherwise drop to the page's body.
    const answerRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (state.status !== 'done' || (state.action !== 'confirm' && state.action !== 'bind' && state.action !== 'archive') || slot !== 'actions') return;
        if (document.activeElement === null || document.activeElement === document.body) answerRef.current?.focus();
    }, [state, slot, detail]);
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
                            <button type="button" className={`${styles.button} ${styles.unavailable}`} disabled aria-describedby={confirmReason !== null ? 'confirm-unavailable' : 'primary-unavailable'}>
                                {primary}
                            </button>
                        ) : null}
                        {confirmReason !== null ? (
                            <span className={styles.visuallyHidden} id="confirm-unavailable">
                                {confirmReason}
                            </span>
                        ) : null}
                        {detail.type === 'new' && can.edit ? (
                            <button type="submit" name="intent" value="edit" className={styles.button} {...offWhile(pending)}>
                                Save edits
                            </button>
                        ) : null}
                        {can.defer && deferRefuses ? (
                            <button type="button" className={`${styles.button} ${styles.unavailable}`} disabled aria-describedby="primary-unavailable">
                                {DEFER_LABEL}
                            </button>
                        ) : can.defer ? (
                            // On a replacement the hint says what Decide later does to the draft, and on a missing source what it keeps
                            // (#118), so it describes the button.
                            <button type="submit" name="intent" value="defer" className={styles.button} {...offWhile(pending)} aria-describedby={(detail.type === 'replacement' || detail.type === 'missing') && detail.primaryUnavailable ? 'primary-unavailable' : undefined}>
                                {DEFER_LABEL}
                            </button>
                        ) : null}
                        {primary && detail.type === 'new' && can.approve ? (
                            <button type="submit" name="intent" value="approve" className={`${styles.button} ${styles.primary}`} {...offWhile(pending)}>
                                <Save size={16} aria-hidden="true" />
                                {primary}
                            </button>
                        ) : null}
                        {/* #118: Confirm takes the primary place, as Approve does. It writes the draft only; a publish makes it public. */}
                        {primary && detail.type === 'replacement' && can.confirm ? (
                            <button type="submit" name="intent" value="confirm" className={`${styles.button} ${styles.primary}`} {...offWhile(pending)}>
                                <Check size={16} aria-hidden="true" />
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
                {detail.status === 'approved' ? <p className={styles.hint}>{reopenHint(detail)}</p> : null}
            </form>

            {can.retry ? (
                <form method="post" onSubmit={submit} className={styles.actions}>
                    <ItemFields detail={detail} activeRevisionId={activeRevisionId} />
                    <button type="submit" name="intent" value="retry" className={styles.button} {...offWhile(pending)}>
                        Retry processing
                    </button>
                </form>
            ) : null}

            {can.reopen ? (
                <form method="post" onSubmit={submit} className={styles.actions}>
                    <ItemFields detail={detail} activeRevisionId={activeRevisionId} />
                    <button type="submit" name="intent" value="reopen" className={styles.button} {...offWhile(pending)}>
                        Reopen
                    </button>
                </form>
            ) : null}

            {/* Every answer but a dismissal, a bind, an archive or a refused description lands here, right under the buttons that produced it. */}
            <AnswerRegion show={slot === 'actions'} state={state} detail={detail} regionRef={answerRef} />

            {/* Keyed by the version the page showed, as the suggestion is, so a form left open across a refresh never reads as another state's. */}
            {can.bind ? <BindForm key={`bind-${detail.version}`} detail={detail} activeRevisionId={activeRevisionId} state={state} pending={pending} slot={slot} submit={submit} /> : null}
            {can.archive ? <ArchiveForm key={`archive-${detail.version}`} detail={detail} activeRevisionId={activeRevisionId} state={state} pending={pending} slot={slot} submit={submit} /> : null}

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
                            <button type="submit" name="intent" value="dismiss" className={styles.button} {...offWhile(pending)}>
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
