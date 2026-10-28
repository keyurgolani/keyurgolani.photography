'use client';

import { Fragment, useActionState, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';
import { Check, CircleAlert, Clock, ExternalLink, FileCheck2, Link2, RefreshCw, Sparkles, Undo2, UploadCloud, type LucideIcon } from 'lucide-react';
import curator from '../curator.module.css';
import { itemUrl } from '../inbox/journey';
import PreviewFrame from '@/components/curation/PreviewFrame';
import {
    displayFacts,
    IDLE_STATE,
    orderRuns,
    resultCopy,
    type ActionState,
    type Answer,
    type Blocker,
    type Compare,
    type DisplayFacts,
    type Fix,
    type Intent,
    type LedgerRow,
    type OrderCompare,
    type PublishState,
    type ReviewLabel,
    type ScreenView,
} from '@/lib/curation/publish-facts';
import styles from './publish.module.css';

/**
 * The curator's Publish screen (#16's 16-3): the approved Gallery After
 * Hours mockup, on the page's view and the latest answer. One action takes
 * every form (Validate, Publish, and the two review fixes), so the page has
 * one answer at a time, in the one result slot above the sticky bar, and
 * its heading takes focus. Without JavaScript the screen reads in full and
 * a fix opens from its link (`?fix=`), but the curator boundary refuses the
 * post: these pages send no referrer, so a form navigation's Origin is
 * "null", and a mutation needs a same-origin one. A line under the bar says
 * so then.
 */

type Labels = DisplayFacts['compareLabels'];

// The browser's time zone, which is the owner's, for the times an answer names, as the Inbox's LocalTime reads it.
const never = () => () => undefined;
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const serverZone = () => 'UTC';

const REVIEW: Record<ReviewLabel, { text: string; icon: LucideIcon; tone: 'done' | 'alert' | 'change' | 'quiet' }> = {
    reviewed: { text: 'Reviewed', icon: Check, tone: 'done' },
    'not-reviewed': { text: 'Not reviewed', icon: CircleAlert, tone: 'alert' },
    stale: { text: 'Stale review', icon: Clock, tone: 'alert' },
    generated: { text: 'Generated · not reviewed', icon: Sparkles, tone: 'alert' },
    automatic: { text: 'Automatic', icon: RefreshCw, tone: 'quiet' },
    confirmed: { text: 'Confirmed in Inbox', icon: Link2, tone: 'quiet' },
    published: { text: 'Published', icon: Check, tone: 'done' },
};

/** Text with `backticks` around a command, as the rollback line carries it. */
function withCode(text: string): ReactNode {
    return text.split('`').map((part, index) =>
        index % 2 === 1 ? (
            <code key={index} className={styles.code}>
                {part}
            </code>
        ) : (
            part
        ),
    );
}

/** Spoken between the meta line's badges, so aria-describedby reads "Blocks publishing, Stale review, Moved". */
const Pause = () => <span className={curator.visuallyHidden}>, </span>;

function ReviewBadge({ review }: { review: ReviewLabel }) {
    const { text, icon: Icon, tone } = REVIEW[review];
    return (
        <span className={styles.review} data-tone={tone}>
            <Icon size={14} aria-hidden="true" />
            {text}
        </span>
    );
}

function OrderBlock({ compare, side }: { compare: OrderCompare; side: 'before' | 'after' }) {
    const entries = compare[side];
    const runs = orderRuns(compare);
    const movedAt = side === 'before' ? compare.from : compare.to;
    // An added entry (`from` 0) has no place before, so only the draft's side marks it.
    const note = side === 'before' ? `, moves to ${compare.to}` : compare.from === 0 ? ', new here' : `, moved from ${compare.from}`;
    return (
        <>
            {runs.map((run, index) => {
                const previous = runs[index - 1];
                const gap = previous ? run[0] - (previous.at(-1) ?? 0) - 1 : 0;
                return (
                    <Fragment key={run[0]}>
                        {gap > 0 ? (
                            <p className={styles.orderGap}>
                                <span aria-hidden="true">…</span>
                                <span className={curator.visuallyHidden}>{gap === 1 ? '1 position' : `${gap} positions`} not shown</span>
                            </p>
                        ) : null}
                        <ol className={styles.order} start={run[0]}>
                            {run
                                .filter((position) => position <= entries.length)
                                .map((position) =>
                                    position === movedAt ? (
                                        <li key={position} className={styles.moved}>
                                            {compare.moved}
                                            {note}
                                        </li>
                                    ) : (
                                        <li key={position}>{entries[position - 1]}</li>
                                    ),
                                )}
                        </ol>
                    </Fragment>
                );
            })}
        </>
    );
}

function Comparison({ compare, labels }: { compare: Compare; labels: Labels }) {
    if (compare.type === 'description') {
        return (
            <dl className={styles.compare} data-single="true">
                <div>
                    <dt>{compare.label}</dt>
                    <dd>{compare.text}</dd>
                </div>
            </dl>
        );
    }
    if (compare.type === 'text') {
        return (
            <dl className={styles.compare}>
                <div>
                    <dt>{labels.before}</dt>
                    <dd>{compare.before ?? <span className={styles.none}>None yet</span>}</dd>
                </div>
                <div>
                    <dt>{labels.after}</dt>
                    <dd>{compare.after ?? <span className={styles.none}>None</span>}</dd>
                </div>
            </dl>
        );
    }
    if (compare.type === 'images') {
        // Both images in one box, side by side, filling the column.
        return (
            <dl className={`${styles.compare} ${styles.compareImages}`}>
                {(['before', 'after'] as const).map((side) => {
                    const picture = compare[side];
                    return (
                        <div key={side}>
                            <dt>{labels[side]}</dt>
                            <dd>{picture ? <img className={styles.compareImage} src={picture.src} alt={picture.alt} width={480} height={320} /> : <span className={styles.none}>None</span>}</dd>
                        </div>
                    );
                })}
            </dl>
        );
    }
    return (
        <dl className={styles.compare}>
            <div>
                <dt>{labels.before}</dt>
                <dd>
                    <OrderBlock compare={compare} side="before" />
                </dd>
            </div>
            <div>
                <dt>{labels.after}</dt>
                <dd>
                    <OrderBlock compare={compare} side="after" />
                </dd>
            </div>
        </dl>
    );
}

interface FixContext {
    view: ScreenView;
    open: string | null;
    busy: boolean;
    refusal: { rowId: string; text: string } | null;
    dispatch: (form: FormData) => void;
    onOpen: (rowId: string, from: 'row' | 'list') => void;
    onClose: (rowId: string) => void;
    /** Ignores a press while one is pending, and otherwise notes which press is waiting. */
    guard: (event: MouseEvent<HTMLButtonElement>, intent?: Intent) => void;
}

/** A refused fix: inside the fix, under its action, with focus on it (spec, Fixes on a row). */
function RefusalStrip({ text }: { text: string }) {
    return (
        <div id="fix-refusal" tabIndex={-1} className={`${curator.notice} ${styles.refusal}`} data-tone="alert">
            <p>
                <CircleAlert size={16} aria-hidden="true" />
                {text}
            </p>
            <a className={`${curator.linkButton} ${styles.primaryLink}`} href="/curation/publish">
                Load the updated ledger
            </a>
        </div>
    );
}

/** A row's fix: a link that opens the description review, a stamp-only form, an Inbox link, or the CLI's hint. */
function FixAction({ row, fix, ctx }: { row: LedgerRow; fix: Fix; ctx: FixContext }) {
    const refused = ctx.refusal?.rowId === row.id ? ctx.refusal.text : null;
    if (fix.type === 'description') {
        if (ctx.open === row.id) {
            return (
                <section className={styles.fix} id="open-fix" aria-labelledby="fix-heading">
                    <h4 id="fix-heading" tabIndex={-1}>
                        Review the description of {fix.record}
                    </h4>
                    <div className={styles.fixBody}>
                        {fix.picture ? <img className={styles.fixImage} src={fix.picture.src} alt={fix.picture.alt} width={360} height={240} /> : null}
                        <div>
                            <p className={styles.fixLabel}>Generated description</p>
                            <p className={styles.fixText}>{fix.text}</p>
                            <p className={styles.fixNote}>{fix.suggested}</p>
                            <p className={styles.fixNote}>
                                Mark it ready only if it says what the photograph shows. To change the words,{' '}
                                {fix.inboxItem ? (
                                    <>
                                        <a className={styles.inlineLink} href={itemUrl(fix.inboxItem)}>
                                            edit it in the Inbox
                                        </a>
                                        , or run{' '}
                                    </>
                                ) : (
                                    'run '
                                )}
                                <code className={styles.code}>photos edit {fix.photoId}</code>.
                            </p>
                        </div>
                    </div>
                    <form action={ctx.dispatch} className={styles.fixActions}>
                        <input type="hidden" name="intent" value="mark-description" />
                        <input type="hidden" name="rowId" value={row.id} />
                        <input type="hidden" name="photoId" value={fix.photoId} />
                        <input type="hidden" name="version" value={fix.version} />
                        <input type="hidden" name="valueHash" value={fix.valueHash} />
                        <input type="hidden" name="active" value={ctx.view.active.revisionId} />
                        <a
                            className={curator.linkButton}
                            href={`/curation/publish#${row.id}-summary`}
                            onClick={(event) => {
                                event.preventDefault();
                                ctx.onClose(row.id);
                            }}
                        >
                            Cancel
                        </a>
                        {/* A refused review would only be refused again, so Load the updated ledger is the one primary then. */}
                        <button
                            type="submit"
                            className={`${curator.button} ${curator.primary}`}
                            aria-describedby={refused ? 'fix-refusal' : undefined}
                            aria-disabled={refused || ctx.busy ? true : undefined}
                            data-off={refused ? 'true' : undefined}
                            onClick={(event) => (refused ? event.preventDefault() : ctx.guard(event))}
                        >
                            <Check size={16} aria-hidden="true" />
                            Mark description ready
                            <span className={curator.visuallyHidden}>: {fix.record}</span>
                        </button>
                    </form>
                    {refused ? <RefusalStrip text={refused} /> : null}
                </section>
            );
        }
        return (
            <a
                className={curator.linkButton}
                id={`${row.id}-open`}
                href={`/curation/publish?fix=${row.id}#fix-heading`}
                aria-expanded={false}
                onClick={(event) => {
                    event.preventDefault();
                    ctx.onOpen(row.id, 'row');
                }}
            >
                Review and mark description ready
                <span className={curator.visuallyHidden}>: {fix.record}</span>
            </a>
        );
    }
    if (fix.type === 'restamp') {
        return (
            <div className={styles.restamp}>
                <form action={ctx.dispatch}>
                    <input type="hidden" name="intent" value="mark-reviewed" />
                    <input type="hidden" name="rowId" value={row.id} />
                    <input type="hidden" name="kind" value={fix.target.kind} />
                    <input type="hidden" name="id" value={fix.target.id} />
                    <input type="hidden" name="version" value={fix.target.version} />
                    <input type="hidden" name="hashes" value={JSON.stringify(fix.target.hashes)} />
                    <input type="hidden" name="field" value={fix.field} />
                    <input type="hidden" name="active" value={ctx.view.active.revisionId} />
                    <button
                        type="submit"
                        className={curator.button}
                        aria-describedby={refused ? 'fix-refusal' : undefined}
                        aria-disabled={refused || ctx.busy ? true : undefined}
                        data-off={refused ? 'true' : undefined}
                        onClick={(event) => (refused ? event.preventDefault() : ctx.guard(event))}
                    >
                        {fix.label}
                        <span className={curator.visuallyHidden}>: {fix.record}</span>
                    </button>
                </form>
                {refused ? <RefusalStrip text={refused} /> : null}
            </div>
        );
    }
    if (fix.type === 'inbox') {
        return (
            <span className={styles.inboxFix}>
                <a className={curator.linkButton} href={itemUrl(fix.eventId)}>
                    Decide it in the Inbox
                    <span className={curator.visuallyHidden}>: {fix.record}</span>
                </a>
                <code className={styles.code}>curation show {fix.eventId}</code>
            </span>
        );
    }
    return <p className={styles.fixHint}>{fix.text}</p>;
}

function Row({ row, facts, ctx }: { row: LedgerRow; facts: DisplayFacts; ctx: FixContext }) {
    const fixOpen = row.fix?.type === 'description' && ctx.open === row.id;
    const blocks = row.blocks && facts.mode === 'draft';
    const review: ReviewLabel = facts.publishedLabels && row.kind !== 'Source health' ? 'published' : row.review;
    return (
        <li className={styles.row} id={row.id} data-blocks={blocks ? 'true' : undefined}>
            <div className={styles.rowMeta} id={`${row.id}-state`}>
                {blocks ? (
                    <>
                        <span className={styles.blocks}>
                            <CircleAlert size={14} aria-hidden="true" />
                            Blocks publishing
                        </span>
                        <Pause />
                    </>
                ) : null}
                <ReviewBadge review={review} />
                <Pause />
                <span className={styles.kind}>{row.kind}</span>
            </div>
            {/* The row's focus target: a blocker link or a finished fix lands here and reads the change, then its state. */}
            <p className={styles.summary} id={`${row.id}-summary`} tabIndex={-1} aria-describedby={`${row.id}-state`}>
                {row.summary}
            </p>
            {row.detail && facts.mode !== 'live' ? <p className={styles.detail}>{row.detail}</p> : null}
            {/* While its fix is open, the fix shows the same values beside the photograph. */}
            {row.compare && !fixOpen ? <Comparison compare={row.compare} labels={facts.compareLabels} /> : null}
            {row.fix && facts.showFixes && blocks ? (
                <div className={styles.rowFix}>
                    <FixAction row={row} fix={row.fix} ctx={ctx} />
                </div>
            ) : null}
        </li>
    );
}

function Group({ heading, rows, tone, facts, ctx }: { heading: string; rows: LedgerRow[]; tone: 'authored' | 'derived' | 'health'; facts: DisplayFacts; ctx: FixContext }) {
    if (rows.length === 0) return null;
    return (
        <section className={styles.group} data-group={tone} aria-labelledby={`group-${tone}`}>
            <h3 id={`group-${tone}`} className={styles.groupHeading}>
                {heading} <span className={styles.count}>({rows.length})</span>
            </h3>
            <ul className={styles.rows}>
                {rows.map((row) => (
                    <Row key={row.id} row={row} facts={facts} ctx={ctx} />
                ))}
            </ul>
        </section>
    );
}

/** One link per blocker, named for its fix. Stamps are written only on the row, beside its compare. */
function BlockerLink({ blocker, ctx }: { blocker: Blocker; ctx: FixContext }) {
    const { link, rowId } = blocker;
    if (link.type === 'description' && rowId) {
        return (
            <a
                className={curator.linkButton}
                href={`/curation/publish?fix=${rowId}#fix-heading`}
                onClick={(event) => {
                    event.preventDefault();
                    ctx.onOpen(rowId, 'list');
                }}
            >
                Review the description: {link.name}
            </a>
        );
    }
    if (link.type === 'restamp' && rowId) {
        return (
            <a className={curator.linkButton} href={`#${rowId}-summary`} onClick={(event) => jumpTo(event, `${rowId}-summary`)}>
                Review it: {link.name}
            </a>
        );
    }
    if (link.type === 'inbox') {
        return (
            <>
                <a className={curator.linkButton} href={itemUrl(link.eventId)}>
                    Decide it in the Inbox: {link.record}
                </a>
                <code className={styles.code}>curation show {link.eventId}</code>
            </>
        );
    }
    if (link.type === 'row' && rowId) {
        return (
            <a className={curator.linkButton} href={`#${rowId}-summary`} onClick={(event) => jumpTo(event, `${rowId}-summary`)}>
                Go to the change: {link.record}
            </a>
        );
    }
    return null;
}

/** Scrolls `box` the least it takes to show it whole between the top of the window and the sticky bar, or to its top when it's taller. */
function bringClearOfBar(box: HTMLElement) {
    const gap = 16;
    const bar = document.querySelector('[data-sticky-bar]')?.getBoundingClientRect().height ?? 0;
    const room = window.innerHeight - bar - gap;
    const { top, bottom, height } = box.getBoundingClientRect();
    if (height > room - gap) window.scrollBy({ top: top - gap, behavior: 'instant' });
    else if (bottom > room) window.scrollBy({ top: bottom - room, behavior: 'instant' });
    else if (top < gap) window.scrollBy({ top: top - gap, behavior: 'instant' });
}

/** An instant jump that moves focus with it, so the next Tab starts from the row. */
function jumpTo(event: MouseEvent<HTMLAnchorElement>, id: string) {
    const target = document.getElementById(id);
    if (!target) return;
    event.preventDefault();
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start', behavior: 'instant' });
}

const ICON: Record<'done' | 'change' | 'alert', LucideIcon> = { done: Check, change: RefreshCw, alert: CircleAlert };

/** The one result slot, above the bar: every answer to Validate or Publish, its heading the focus target. */
function ResultSlot({ answer, view, facts, ctx, zone }: { answer: Answer | null; view: ScreenView; facts: DisplayFacts; ctx: FixContext; zone: string }) {
    if (!answer) return null;
    const copy = resultCopy(answer, view, zone);
    if (!copy) return null;
    // Busy waits on another process, so it shows a clock, not the reload icon.
    const Icon = answer.kind === 'busy' ? Clock : ICON[copy.tone];
    const listed = answer.kind === 'blocked' || answer.kind === 'blocked-at-publish' ? facts.blockers : [];
    return (
        <section className={`${curator.notice} ${styles.result}`} data-tone={copy.tone} aria-labelledby="result-heading">
            <h2 id="result-heading" tabIndex={-1} className={styles.resultHeading}>
                <Icon size={18} aria-hidden="true" />
                {copy.heading}
            </h2>
            {copy.body.map((line) => (
                <p key={line}>{line}</p>
            ))}
            {listed.length > 0 ? (
                <ol className={styles.errors}>
                    {listed.map((blocker) => (
                        <li key={blocker.key}>
                            <strong>
                                {blocker.record} · {blocker.field}
                            </strong>
                            <span>{blocker.message}</span>
                            <span className={styles.errorActions}>
                                <BlockerLink blocker={blocker} ctx={ctx} />
                            </span>
                        </li>
                    ))}
                </ol>
            ) : null}
            {answer.kind === 'published' || answer.kind === 'already-live' ? (
                <p className={styles.resultLinks}>
                    <a className={curator.linkButton} href="/" target="_blank" rel="noopener noreferrer">
                        Open the site
                        <span className={curator.visuallyHidden}> (opens in a new tab)</span>
                        <ExternalLink size={14} aria-hidden="true" />
                    </a>
                    {answer.kind === 'published' ? (
                        <a className={curator.linkButton} href="/curation/publish">
                            Load the working catalog again
                        </a>
                    ) : null}
                </p>
            ) : null}
        </section>
    );
}

/** The sticky bar: one form whose submits are Validate and Publish, or, out of date, Load the updated ledger alone. */
function ActionBar({ view, facts, pending, sent, ctx }: { view: ScreenView; facts: DisplayFacts; pending: boolean; sent: Intent | null; ctx: FixContext }) {
    const bar = facts.bar;
    if (!bar) return null;
    if (bar.loadUpdated) {
        return (
            <div className={styles.actions} data-sticky-bar="">
                <div className={styles.buttons}>
                    <a className={`${curator.linkButton} ${styles.primaryLink}`} href="/curation/publish">
                        <RefreshCw size={16} aria-hidden="true" />
                        Load the updated ledger
                    </a>
                </div>
            </div>
        );
    }
    const n = view.draftNumber;
    const validating = pending && sent === 'validate';
    const publishing = pending && sent === 'publish';
    const button = (intent: 'validate' | 'publish', state: ActionState, label: string, pendingLabel: string, Icon: LucideIcon, primary: boolean, waiting: boolean) =>
        state === 'hidden' ? null : (
            <button
                type="submit"
                name="intent"
                value={intent}
                className={primary ? `${curator.button} ${curator.primary}` : curator.button}
                aria-disabled={state !== 'available' || pending ? true : undefined}
                aria-describedby={intent === 'publish' && bar.reason && state !== 'available' ? 'publish-reason' : undefined}
                // While either press waits, the other button reads as unavailable too; the waiting one keeps its pending look.
                data-off={(state !== 'available' || pending) && !waiting ? 'true' : undefined}
                data-pending={waiting ? 'true' : undefined}
                data-primary={primary ? 'true' : undefined}
                onClick={(event) => (state !== 'available' ? event.preventDefault() : ctx.guard(event, intent))}
            >
                <Icon size={16} aria-hidden="true" />
                {waiting ? pendingLabel : label}
            </button>
        );
    return (
        <form action={ctx.dispatch} className={styles.actions} aria-busy={pending ? true : undefined} data-sticky-bar="">
            <input type="hidden" name="draftId" value={view.draftId} />
            <input type="hidden" name="active" value={view.active.revisionId} />
            {facts.validated ? <input type="hidden" name="validated" value={view.draftId} /> : null}
            <div className={styles.buttons}>
                {button('validate', bar.validate, 'Validate revision', 'Validating…', FileCheck2, false, validating)}
                {button('publish', bar.publish, `Publish revision ${n}`, `Publishing revision ${n}…`, UploadCloud, true, publishing)}
            </div>
            {bar.reason || publishing ? (
                <p id="publish-reason" className={styles.reason}>
                    {publishing ? `Revision ${view.active.number} stays live until the switch.` : bar.reason}
                </p>
            ) : null}
            <noscript>
                <p className={styles.reason}>Validate, Publish and the fixes need JavaScript. Nothing is written without it.</p>
            </noscript>
        </form>
    );
}

function PreviewPanel({ facts }: { facts: DisplayFacts }) {
    const { panel } = facts;
    return (
        <section className={styles.panel} aria-labelledby="preview-heading">
            <header className={styles.panelHeader}>
                <h2 id="preview-heading">{panel.title}</h2>
                {panel.link ? (
                    <a href={panel.link.href} className={styles.textLink} target="_blank" rel="noopener noreferrer">
                        {panel.link.label}
                        <span className={curator.visuallyHidden}> (opens in a new tab)</span>
                        <ExternalLink size={14} aria-hidden="true" />
                    </a>
                ) : null}
            </header>
            {panel.frameSrc ? (
                <PreviewFrame src={panel.frameSrc} height="22rem" focusable={false} marker={panel.marker} title={panel.frameTitle} embedded scrollToId={panel.scrollToId} />
            ) : (
                <p className={styles.frameNote}>{panel.frameNote}</p>
            )}
            {panel.count || panel.copyLine ? (
                <div className={styles.panelText}>
                    {panel.count ? <p className={styles.panelCount}>{panel.count}</p> : null}
                    {panel.copyLine ? <p className={styles.panelCopy}>{panel.copyLine}</p> : null}
                </div>
            ) : null}
            {panel.rollback ? (
                <footer className={styles.panelFooter}>
                    <Undo2 size={15} aria-hidden="true" />
                    <span>{withCode(panel.rollback)}</span>
                </footer>
            ) : null}
        </section>
    );
}

interface PublishScreenProps {
    view: ScreenView;
    /** The full preview's address, for Open full preview. */
    previewHref: string;
    /** A row whose description review the URL opens (`?fix=`), for a page loaded without JavaScript. */
    openFix: string | null;
    /**
     * The screen's one server action (./actions.ts), passed down by the page,
     * so this client module never imports server code, not even the action's.
     */
    action: (previous: PublishState, form: FormData) => Promise<PublishState>;
}

export default function PublishScreen({ view, previewHref, openFix, action }: PublishScreenProps) {
    const [state, dispatch, pending] = useActionState(action, IDLE_STATE);
    // The press that's waiting, for the live region and the pending label. Set on the click, before the post.
    const [sent, setSent] = useState<Intent | null>(null);
    const [open, setOpen] = useState<string | null>(openFix);
    // Where focus goes back to when a fix opened from the blocker list closes: the row's summary.
    const openedFrom = useRef<'row' | 'list'>('row');
    const [focusFix, setFocusFix] = useState(0);
    const facts = displayFacts(view, state.result, previewHref);
    const busy = pending;
    const zone = useSyncExternalStore(never, browserZone, serverZone);
    // Set on the click itself, so a second click before React renders the pending state is ignored too.
    const pressed = useRef(false);
    useEffect(() => {
        if (!pending) pressed.current = false;
    }, [pending]);
    const refusal = state.answer?.kind === 'fix-refused' ? { rowId: state.answer.rowId, text: state.answer.text } : null;

    const ctx: FixContext = {
        view,
        open,
        busy,
        refusal,
        dispatch,
        onOpen: (rowId, from) => {
            openedFrom.current = from;
            setOpen(rowId);
            setFocusFix((count) => count + 1);
        },
        // Escape or Cancel: back to what opened the fix, its row's opener, or the row's summary when the blocker list opened it.
        onClose: (rowId) => {
            setOpen(null);
            const back = openedFrom.current === 'row' ? `${rowId}-open` : `${rowId}-summary`;
            requestAnimationFrame(() => (document.getElementById(back) ?? document.getElementById(`${rowId}-summary`))?.focus());
        },
        // While Validate or Publish is pending, a second press is ignored, and so is every fix.
        guard: (event: MouseEvent<HTMLButtonElement>, intent?: Intent) => {
            if (busy || pressed.current) {
                event.preventDefault();
                return;
            }
            pressed.current = true;
            setSent(intent ?? null);
        },
    };

    // Escape closes an open fix while focus is inside it, and focus goes back to what opened it.
    const closeFix = useRef(ctx.onClose);
    closeFix.current = ctx.onClose;
    useEffect(() => {
        if (open === null) return;
        const onKey = (event: globalThis.KeyboardEvent) => {
            if (event.key !== 'Escape' || !document.getElementById('open-fix')?.contains(document.activeElement)) return;
            closeFix.current(open);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open]);

    // An opened fix moves focus to its heading.
    useEffect(() => {
        if (focusFix === 0) return;
        const heading = document.getElementById('fix-heading');
        heading?.focus({ preventScroll: true });
        heading?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }, [focusFix]);

    // After every answer: the result heading, the refusal strip, or, after a fix, the row's summary.
    const answered = useRef(0);
    useEffect(() => {
        if (state.serial === 0 || state.serial === answered.current) return;
        answered.current = state.serial;
        const answer = state.answer;
        if (!answer) return;
        if (answer.kind === 'fixed') setOpen(null);
        const id = answer.kind === 'fix-refused' ? 'fix-refusal' : answer.kind === 'fixed' ? `${answer.rowId}-summary` : 'result-heading';
        requestAnimationFrame(() => {
            const target = document.getElementById(id) ?? document.getElementById('ledger-heading');
            target?.focus({ preventScroll: true });
            if (answer.kind === 'fixed') {
                target?.scrollIntoView({ block: 'start', behavior: 'instant' });
                return;
            }
            // The whole answer, its blocker links included, comes into view clear of the sticky bar; one taller than the room starts at the top.
            const box = (answer.kind === 'fix-refused' ? target : target?.closest('section')) ?? target;
            if (box) bringClearOfBar(box);
        });
    }, [state]);

    const n = view.draftNumber;
    const live = pending && sent === 'validate' ? `Checking revision ${n}.` : pending && sent === 'publish' ? `Publishing revision ${n}. Revision ${view.active.number} stays live until the switch.` : '';
    const { ledger } = facts;
    const nothing = facts.mode === 'nothing';
    return (
        <main className={styles.body} data-layout={nothing ? 'column' : 'columns'}>
            {/* The screen's one live region: there from the first paint and empty, so the text a press puts in it is read. */}
            <p role="status" className={curator.visuallyHidden}>
                {live}
            </p>
            <header className={styles.heading}>
                <div>
                    <h1>{facts.heading}</h1>
                    {facts.lead ? <p className={styles.lead}>{facts.lead}</p> : null}
                    {facts.countLine ? (
                        <p className={styles.countLine} data-tone={facts.countAlert ? 'alert' : undefined}>
                            {facts.countAlert ? <CircleAlert size={16} aria-hidden="true" /> : null}
                            {facts.countLine}
                        </p>
                    ) : null}
                </div>
                <p className={styles.revisions}>
                    <span>{facts.revision.current}</span>
                    <span>{facts.revision.hashes}</span>
                </p>
                {nothing ? (
                    <p className={styles.inboxLink}>
                        <a className={curator.linkButton} href="/curation/inbox">
                            Open the Inbox
                        </a>
                    </p>
                ) : null}
            </header>
            <div className={styles.layout} data-ledger={nothing ? 'no' : 'yes'}>
                <PreviewPanel facts={facts} />
                {nothing ? null : (
                    <section className={styles.ledger} aria-labelledby="ledger-heading" data-out-of-date={facts.mode === 'out-of-date' ? 'true' : undefined}>
                        <h2 id="ledger-heading" tabIndex={-1}>
                            {facts.ledgerHeading}
                        </h2>
                        {facts.outOfDate ? <p className={styles.outOfDate}>{facts.outOfDate}</p> : null}
                        <Group heading={facts.groups.authored} rows={ledger.authored} tone="authored" facts={facts} ctx={ctx} />
                        <Group heading={facts.groups.derived} rows={ledger.derived} tone="derived" facts={facts} ctx={ctx} />
                        <Group heading="Source health" rows={ledger.health} tone="health" facts={facts} ctx={ctx} />
                        <ResultSlot answer={state.result} view={view} facts={facts} ctx={ctx} zone={zone} />
                        <ActionBar view={view} facts={facts} pending={pending} sent={sent} ctx={ctx} />
                    </section>
                )}
            </div>
        </main>
    );
}
