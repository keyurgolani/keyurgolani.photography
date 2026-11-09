'use client';

import { Fragment, useActionState, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';
import { Check, ChevronDown, CircleAlert, Clock, ExternalLink, FileCheck2, Link2, RefreshCw, Sparkles, TriangleAlert, Undo2, UploadCloud, type LucideIcon } from 'lucide-react';
import curator from '../curator.module.css';
import { itemUrl } from '../inbox/journey';
import { submitGate, useHydrated } from '../inbox/useHydrated';
import PreviewFrame from '@/components/curation/PreviewFrame';
import { PublishAnswerContext } from './HistoryContext';
import { localize } from '@/lib/curation/publish-history';
import { jumpTo, openAncestors } from './jump';
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
    type PublishWarning,
    type ReviewLabel,
    type RevisionFacts,
    type ScreenView,
    type UsePublishedFix,
    type WatchAnswer,
} from '@/lib/curation/publish-facts';
import { createWatch, watchNews } from '@/lib/curation/publish-watch';
import { shownText, type TextPart } from '@/lib/curation/text-diff';
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
    // 15-4: a field a restore's rebase left in conflict (the working.conflicts rule).
    conflict: { text: 'Conflicts with the live revision', icon: CircleAlert, tone: 'alert' },
    automatic: { text: 'Automatic', icon: RefreshCw, tone: 'quiet' },
    confirmed: { text: 'Confirmed in Inbox', icon: Link2, tone: 'quiet' },
    published: { text: 'Published', icon: Check, tone: 'done' },
};

/** Text with `backticks` around a command, as the rollback line and its warning carry it, and the Validate stakes (#117). */
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

/** 15-4: "Restore it from History, below." as an in-page link that moves focus there. */
function withHistoryLink(text: string): ReactNode {
    const phrase = 'History, below';
    const at = text.indexOf(phrase);
    if (at < 0) return withCode(text);
    return (
        <>
            {withCode(text.slice(0, at))}
            <a className={styles.inlineLink} href="#history-heading" onClick={(event) => jumpTo(event, 'history-heading')}>
                {phrase}
            </a>
            {text.slice(at + phrase.length)}
        </>
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

/**
 * A9: one side of a text change, its words kept as they are and the rest in
 * `<del>` (the published side) or `<ins>` (the draft's), each with a hidden
 * word a screen reader says, since most don't announce the elements.
 */
function Words({ parts, side }: { parts: TextPart[]; side: 'before' | 'after' }) {
    return (
        <>
            {parts.map((part, index) => {
                if (part.type === 'same') return <Fragment key={index}>{part.text}</Fragment>;
                if (side === 'before' && part.type === 'removed') {
                    return (
                        <del key={index} className={styles.removed}>
                            <span className={curator.visuallyHidden}>removed: </span>
                            {shownText(part)}
                        </del>
                    );
                }
                if (side === 'after' && part.type === 'added') {
                    return (
                        <ins key={index} className={styles.added}>
                            <span className={curator.visuallyHidden}>added: </span>
                            {shownText(part)}
                        </ins>
                    );
                }
                return null;
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
                    <dd>{compare.before === null ? <span className={styles.none}>None yet</span> : compare.diff ? <Words parts={compare.diff} side="before" /> : compare.before}</dd>
                </div>
                <div>
                    <dt>{labels.after}</dt>
                    <dd>{compare.after === null ? <span className={styles.none}>None</span> : compare.diff ? <Words parts={compare.diff} side="after" /> : compare.after}</dd>
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
    /** The browser's time zone once the page runs, UTC before: the ledger's days read in it, as History's do. */
    zone: string;
    open: string | null;
    /** The fix the URL opened (`?fix=`), so a collapsed group holding it renders open without JavaScript (A9 review). */
    initialOpen: string | null;
    busy: boolean;
    /** `intent`: which fix was refused, so its own strip shows it (A9: a row can carry two). */
    refusal: { rowId: string; text: string; intent: Intent | null } | null;
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
    // Its forms post through the screen's action, so each waits at the submit gate until it has mounted.
    const ready = useHydrated();
    const refused = ctx.refusal?.rowId === row.id && ctx.refusal.intent !== 'use-published' ? ctx.refusal.text : null;
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
                            <p className={styles.fixNote}>{localize(fix.suggested, ctx.zone)}</p>
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
                    <form action={ctx.dispatch} className={styles.fixActions} {...submitGate(ready)}>
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
                <form action={ctx.dispatch} {...submitGate(ready)}>
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
    return (
        <p className={styles.fixHint}>
            {fix.text}
            {fix.command ? (
                <>
                    {' '}
                    <code className={styles.code}>{fix.command}</code>
                </>
            ) : null}
        </p>
    );
}

/** A9: Use the published value, a native submit in its own form, named for the record; the server action is the gate. */
function UsePublishedAction({ row, fix, ctx }: { row: LedgerRow; fix: UsePublishedFix; ctx: FixContext }) {
    const ready = useHydrated();
    const refused = ctx.refusal?.rowId === row.id && ctx.refusal.intent === 'use-published' ? ctx.refusal.text : null;
    return (
        <div className={styles.restamp}>
            <form action={ctx.dispatch} {...submitGate(ready)}>
                <input type="hidden" name="intent" value="use-published" />
                <input type="hidden" name="rowId" value={row.id} />
                <input type="hidden" name="kind" value={fix.kind} />
                <input type="hidden" name="id" value={fix.id} />
                <input type="hidden" name="field" value={fix.field} />
                <input type="hidden" name="version" value={fix.version} />
                <input type="hidden" name="valueHash" value={fix.valueHash} />
                <input type="hidden" name="active" value={ctx.view.active.revisionId} />
                <button
                    type="submit"
                    className={curator.button}
                    aria-describedby={[fix.note ? `${row.id}-published-note` : '', refused ? 'fix-refusal' : ''].filter(Boolean).join(' ') || undefined}
                    aria-disabled={refused || ctx.busy ? true : undefined}
                    data-off={refused ? 'true' : undefined}
                    onClick={(event) => (refused ? event.preventDefault() : ctx.guard(event, 'use-published'))}
                >
                    <Undo2 size={16} aria-hidden="true" />
                    Use the published value
                    <span className={curator.visuallyHidden}>: {fix.record}</span>
                </button>
            </form>
            {fix.note ? (
                <p id={`${row.id}-published-note`} className={styles.fixHint}>
                    {fix.note}
                </p>
            ) : null}
            {refused ? <RefusalStrip text={refused} /> : null}
        </div>
    );
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
            {row.detail && facts.mode !== 'live' ? <p className={styles.detail}>{localize(row.detail, ctx.zone)}</p> : null}
            {/* While its fix is open, the fix shows the same values beside the photograph. */}
            {row.compare && !fixOpen ? <Comparison compare={row.compare} labels={facts.compareLabels} /> : null}
            {(row.fix || row.usePublished) && facts.showFixes && blocks ? (
                <div className={styles.rowFix}>
                    {row.fix ? <FixAction row={row} fix={row.fix} ctx={ctx} /> : null}
                    {row.usePublished ? <UsePublishedAction row={row} fix={row.usePublished} ctx={ctx} /> : null}
                </div>
            ) : null}
        </li>
    );
}

/** A9: a group of more rows than this starts collapsed, in a native disclosure. */
export const GROUP_COLLAPSE_AFTER = 50;

function Group({ heading, rows, tone, facts, ctx }: { heading: string; rows: LedgerRow[]; tone: 'authored' | 'derived' | 'health'; facts: DisplayFacts; ctx: FixContext }) {
    const holds = ctx.initialOpen !== null && rows.some((row) => row.id === ctx.initialOpen);
    // Whether the disclosure is open, for its summary's words; the element itself holds the state.
    const [shown, setShown] = useState(holds);
    if (rows.length === 0) return null;
    const list = (
        <ul className={styles.rows}>
            {rows.map((row) => (
                <Row key={row.id} row={row} facts={facts} ctx={ctx} />
            ))}
        </ul>
    );
    return (
        <section className={styles.group} data-group={tone} aria-labelledby={`group-${tone}`}>
            <h3 id={`group-${tone}`} className={styles.groupHeading}>
                {heading} <span className={styles.count}>({rows.length})</span>
            </h3>
            {rows.length > GROUP_COLLAPSE_AFTER ? (
                // A link to a row inside opens it (jump.ts), and so does find in page.
                <details className={styles.collapse} open={holds || undefined} onToggle={(event) => setShown(event.currentTarget.open)}>
                    <summary className={styles.collapseSummary}>
                        <ChevronDown size={16} aria-hidden="true" className={styles.chevron} />
                        {shown ? `Hide the ${rows.length} changes in this group` : `Show all ${rows.length} changes in this group`}
                    </summary>
                    {list}
                </details>
            ) : (
                list
            )}
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

const ICON: Record<'done' | 'change' | 'alert', LucideIcon> = { done: Check, change: RefreshCw, alert: CircleAlert };

/**
 * What the last check of the draft found that never blocks a publish, in each rule's own words, as `photos validate`
 * prints them. A warning, not an error: the change tone and an icon beside the words, never the alert's red, and a
 * heading that says Publish isn't held. Nothing at all when there are none.
 */
function WarningList({ warnings, ctx }: { warnings: readonly PublishWarning[]; ctx: FixContext }) {
    if (warnings.length === 0) return null;
    const n = warnings.length;
    const heading = n === 1 ? "1 warning, which doesn't block publishing" : `${n} warnings, which don't block publishing`;
    return (
        <section className={`${curator.notice} ${styles.warnings}`} data-tone="change" aria-labelledby="warnings-heading">
            <h3 id="warnings-heading" className={styles.warningsHeading}>
                <TriangleAlert size={16} aria-hidden="true" />
                {heading}
            </h3>
            <ul className={styles.warningList}>
                {warnings.map((warning) => (
                    <li key={warning.key}>
                        <strong>
                            {warning.record} · {warning.field}
                        </strong>
                        <span>{warning.message}</span>
                        {warning.hint ? <span className={styles.warningHint}>{warning.hint}</span> : null}
                        {warning.link ? (
                            <span className={styles.errorActions}>
                                <WarningLinkTo warning={warning} ctx={ctx} />
                            </span>
                        ) : null}
                    </li>
                ))}
            </ul>
        </section>
    );
}

/** A warning's link: the series' own page, or the photograph's fix as its ledger row offers it, through BlockerLink. */
function WarningLinkTo({ warning, ctx }: { warning: PublishWarning; ctx: FixContext }) {
    const { link } = warning;
    if (!link) return null;
    if (link.type === 'series') {
        return (
            <a className={curator.linkButton} href={link.href}>
                Edit the series: {link.name}
            </a>
        );
    }
    const blocker: Blocker = {
        key: warning.key,
        rowId: link.type === 'description' ? link.rowId : null,
        record: warning.record,
        field: warning.field,
        message: warning.message,
        link: link.type === 'description' ? { type: 'description', name: link.name } : { type: 'inbox', record: link.name, eventId: link.eventId },
    };
    return <BlockerLink blocker={blocker} ctx={ctx} />;
}

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
                <p key={line}>{withCode(line)}</p>
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
function ActionBar({ view, facts, pending, sent, ctx, historyParams }: { view: ScreenView; facts: DisplayFacts; pending: boolean; sent: Intent | null; ctx: FixContext; historyParams?: PublishScreenProps['historyParams'] }) {
    const ready = useHydrated();
    const bar = facts.bar;
    if (!bar) return null;
    if (bar.loadUpdated) {
        return (
            <div className={styles.actions} data-sticky-bar="">
                <div className={styles.buttons}>
                    <a id="load-updated" className={`${curator.linkButton} ${styles.primaryLink}`} href="/curation/publish">
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
        <form action={ctx.dispatch} className={styles.actions} aria-busy={pending ? true : undefined} data-sticky-bar="" {...submitGate(ready)}>
            <input type="hidden" name="draftId" value={view.draftId} />
            <input type="hidden" name="active" value={view.active.revisionId} />
            {facts.validated ? <input type="hidden" name="validated" value={view.draftId} /> : null}
            {historyParams?.shown ? <input type="hidden" name="historyShown" value={historyParams.shown} /> : null}
            {historyParams?.check ? <input type="hidden" name="historyCheck" value={historyParams.check} /> : null}
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
                // #117: a warning that names the fix takes the rollback-ready line's place, in the alert tone.
                <footer className={styles.panelFooter} {...(panel.rollbackTone ? { 'data-tone': panel.rollbackTone } : {})}>
                    {panel.rollbackTone === 'alert' ? <CircleAlert size={15} aria-hidden="true" /> : <Undo2 size={15} aria-hidden="true" />}
                    <span>{withHistoryLink(panel.rollback)}</span>
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
    /** 15-4's History section: the layout's last area, under the ledger (or under the panel when nothing is pending). */
    history?: ReactNode;
    /** How many History entries the page shows and the revision it checked (`?history=`, `?check=`), which an answer keeps. */
    historyParams?: { shown: number | null; check: number | null };
    /** A9: the read-only server action the watch asks every 60 s (./actions.ts's watchPublish), passed down like `action`. */
    watch?: (input: { draftId: string; active: string }) => Promise<WatchAnswer>;
}

/** Answers that moved the live revision from this page or saw it move; the watch has nothing to add after one. */
const POINTER_MOVED: ReadonlySet<Answer['kind']> = new Set(['published', 'already-live', 'someone-published']);

export default function PublishScreen({ view, previewHref, openFix, action, history, historyParams, watch }: PublishScreenProps) {
    const [state, dispatch, pending] = useActionState(action, IDLE_STATE);
    // A9's watch: what it last announced, and the live revision once the base moved.
    const [watchLine, setWatchLine] = useState('');
    const [baseMoved, setBaseMoved] = useState<RevisionFacts | null>(null);
    const announced = useRef(new Set<string>());
    const viewNow = useRef(view);
    viewNow.current = view;
    const pendingNow = useRef(pending);
    pendingNow.current = pending;
    const answerKind = state.result?.kind;
    const pointerMoved = answerKind !== undefined && (POINTER_MOVED.has(answerKind) || (state.result?.kind === 'failed' && state.result.live !== null));
    // The press that's waiting, for the live region and the pending label. Set on the click, before the post.
    const [sent, setSent] = useState<Intent | null>(null);
    const [open, setOpen] = useState<string | null>(openFix);
    // Where focus goes back to when a fix opened from the blocker list closes: the row's summary.
    const openedFrom = useRef<'row' | 'list'>('row');
    const [focusFix, setFocusFix] = useState(0);
    const facts = displayFacts(view, state.result, previewHref, pointerMoved ? null : baseMoved);

    // A9 review: a press takes the region, and what the watch said before it isn't said again once the answer lands.
    useEffect(() => {
        if (pending) setWatchLine('');
    }, [pending]);

    // A9 review: Base moved takes Validate and Publish away; focus that was on one goes to Load the updated ledger.
    useEffect(() => {
        if (!baseMoved) return;
        const active = document.activeElement;
        if (active === null || active === document.body || !active.isConnected) document.getElementById('load-updated')?.focus();
    }, [baseMoved]);

    useEffect(() => {
        if (!watch || view.kind !== 'ledger' || pointerMoved) return;
        const watcher = createWatch({
            check: () => watch({ draftId: view.draftId, active: view.active.revisionId }),
            onAnswer: (answer) => {
                // The page's rows as they are now: a fix reloads them without a new draft, so the watch keeps running.
                const news = watchNews(viewNow.current, answer, announced.current);
                for (const key of news.stale) announced.current.add(key);
                if (news.baseMoved) setBaseMoved(news.baseMoved);
                // Only new news changes the line, so the region never says the same thing twice.
                if (news.line) setWatchLine(news.line);
            },
            now: () => Date.now(),
            setTimer: (run, ms) => window.setTimeout(run, ms),
            clearTimer: (timer) => window.clearTimeout(timer as number),
            hidden: () => document.visibilityState === 'hidden',
            busy: () => pendingNow.current,
        });
        const wake = () => {
            if (document.visibilityState === 'visible') watcher.wake();
        };
        watcher.start();
        document.addEventListener('visibilitychange', wake);
        window.addEventListener('focus', wake);
        return () => {
            watcher.stop();
            document.removeEventListener('visibilitychange', wake);
            window.removeEventListener('focus', wake);
        };
        // A new draft or live revision starts a new watch; the rows it judges against come from viewNow.
    }, [watch, view.draftId, view.active.revisionId, view.kind, pointerMoved]);
    const busy = pending;
    const zone = useSyncExternalStore(never, browserZone, serverZone);
    // Set on the click itself, so a second click before React renders the pending state is ignored too.
    const pressed = useRef(false);
    useEffect(() => {
        if (!pending) pressed.current = false;
    }, [pending]);
    const refusal = state.answer?.kind === 'fix-refused' ? { rowId: state.answer.rowId, text: state.answer.text, intent: state.intent } : null;

    const ctx: FixContext = {
        view,
        zone,
        open,
        initialOpen: openFix,
        busy,
        refusal,
        dispatch,
        onOpen: (rowId, from) => {
            openedFrom.current = from;
            // A9 review: a row in a collapsed group opens it, so the fix's heading can take focus.
            const row = document.getElementById(rowId);
            if (row) openAncestors(row);
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
        if (answer.kind === 'fixed' || answer.kind === 'reverted') setOpen(null);
        const id = answer.kind === 'fix-refused' ? 'fix-refusal' : answer.kind === 'fixed' ? `${answer.rowId}-summary` : answer.kind === 'reverted' ? 'reverted-notice' : 'result-heading';
        requestAnimationFrame(() => {
            const target = document.getElementById(id) ?? document.getElementById('ledger-heading');
            target?.focus({ preventScroll: true });
            if (answer.kind === 'fixed' || answer.kind === 'reverted') {
                target?.scrollIntoView({ block: 'start', behavior: 'instant' });
                return;
            }
            // The whole answer, its blocker links included, comes into view clear of the sticky bar; one taller than the room starts at the top.
            const box = (answer.kind === 'fix-refused' ? target : target?.closest('section')) ?? target;
            if (box) bringClearOfBar(box);
        });
    }, [state]);

    const n = view.draftNumber;
    const pressing = pending && sent === 'validate' ? `Checking revision ${n}.` : pending && sent === 'publish' ? `Publishing revision ${n}. Revision ${view.active.number} stays live until the switch.` : '';
    // The one live region: a waiting press first, else what the watch found since the page loaded (A9).
    const live = pressing || (pointerMoved ? '' : watchLine);
    const reverted = state.answer?.kind === 'reverted' ? state.answer.text : null;
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
                        {reverted ? (
                            <p id="reverted-notice" tabIndex={-1} className={`${curator.notice} ${styles.reverted}`} data-tone="done">
                                <Check size={16} aria-hidden="true" />
                                {reverted}
                            </p>
                        ) : null}
                        <Group heading={facts.groups.authored} rows={ledger.authored} tone="authored" facts={facts} ctx={ctx} />
                        <Group heading={facts.groups.derived} rows={ledger.derived} tone="derived" facts={facts} ctx={ctx} />
                        <Group heading="Source health" rows={ledger.health} tone="health" facts={facts} ctx={ctx} />
                        <WarningList warnings={facts.warnings} ctx={ctx} />
                        <ResultSlot answer={state.result} view={view} facts={facts} ctx={ctx} zone={zone} />
                        <ActionBar view={view} facts={facts} pending={pending} sent={sent} ctx={ctx} historyParams={historyParams} />
                    </section>
                )}
                <PublishAnswerContext.Provider value={{ result: state.result, pending, sent, zone }}>{history}</PublishAnswerContext.Provider>
            </div>
        </main>
    );
}
