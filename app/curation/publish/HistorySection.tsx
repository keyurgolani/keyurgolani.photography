'use client';

import { useActionState, useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, CircleAlert, CircleDashed, Clock, ExternalLink, RefreshCw, Undo2, type LucideIcon } from 'lucide-react';
import curator from '../curator.module.css';
import { usePublishAnswer } from './HistoryContext';
import { jumpTo } from './jump';
import type { Answer } from '@/lib/curation/publish-facts';
import { localize, RESTORE_IDLE, type EntryView, type HistoryView, type PlanView, type RestoreResult, type RestoreState, type ResultAction } from '@/lib/curation/publish-history';
import styles from './history.module.css';
import publish from './publish.module.css';

/**
 * #15's 15-4: History and restore on the Publish screen (spec revision 2).
 * Every publish and restore, newest first, each saying whether it can come
 * back; a Restore opens a modal dialog that names the target, shows the
 * compare-and-swap facts and the impact list, and requires a reason. Focus
 * goes to the dialog's heading on open, Tab stays in it, Escape and Cancel
 * return focus to the opener, and while it's open its own live region is
 * the page's only one (the screen's is inert behind it). Every answer but
 * done appears in the dialog, its heading focused and its box in view; done
 * loads `?restored=<sequence>`, whose notice takes focus. Without JavaScript
 * the list reads in full and `?restore=N` opens the dialog in place, but the
 * curator boundary refuses the post, as 16-3's.
 */

const PUBLISH_PAGE = '/curation/publish';

const Pause = () => <span className={curator.visuallyHidden}>, </span>;

const TONE_ICON: Record<RestoreResult['tone'], LucideIcon> = { done: Check, alert: CircleAlert, change: RefreshCw };

/** 16-3's answers that move the pointer, or find it moved: History read again comes with them. */
function answeredHistory(answer: Answer | null): HistoryView | null {
    if (!answer) return null;
    if (answer.kind === 'published' || answer.kind === 'already-live' || answer.kind === 'someone-published' || answer.kind === 'failed') return answer.history ?? null;
    return null;
}

function EntryItem({ entry, paused, zone, onRestore }: { entry: EntryView; paused: boolean; zone: string; onRestore: (sequence: number, revision: number) => void }) {
    const { sequence, badge, eligibility } = entry;
    return (
        <li className={styles.entry} id={`entry-${sequence}`}>
            <div className={styles.text}>
                <div className={styles.meta} id={`entry-${sequence}-state`}>
                    {badge ? (
                        <>
                            <span className={publish.review} data-tone={badge.tone}>
                                {badge.tone === 'done' ? <Check size={14} aria-hidden="true" /> : <CircleDashed size={14} aria-hidden="true" />}
                                {badge.text}
                            </span>
                            <Pause />
                        </>
                    ) : null}
                    <span className={publish.kind}>{entry.kind}</span>
                </div>
                <h3 className={styles.title} id={`entry-${sequence}-title`} tabIndex={-1} aria-describedby={`entry-${sequence}-state`}>
                    {entry.title}
                </h3>
                <p className={styles.when}>{localize(entry.when, zone)}</p>
                {entry.reason ? (
                    <p className={styles.reason}>
                        {entry.reason.quoted ? (
                            `“${entry.reason.text}”`
                        ) : (
                            <>
                                <span className={styles.notePrefix}>Note: </span>
                                {entry.reason.text}
                            </>
                        )}
                    </p>
                ) : null}
                <p className={styles.from}>
                    {entry.from}
                    {entry.held ? ` ${entry.held}` : ''}
                </p>
                {entry.extra ? <p className={styles.from}>{entry.extra}</p> : null}
                <p className={styles.facts}>{entry.facts}</p>
                {eligibility.type === 'text' ? (
                    <p className={styles.why} data-tone={eligibility.tone}>
                        {eligibility.tone === 'alert' ? <CircleAlert size={15} aria-hidden="true" /> : null}
                        {localize(eligibility.text, zone)}
                    </p>
                ) : null}
            </div>
            {eligibility.type === 'restore' ? (
                <div className={styles.action}>
                    {/* A link, so the dialog opens from its URL without JavaScript; with it, the press opens the modal in place. */}
                    {/* role="button", and Space presses it as a button's would: it opens a dialog, which is what a button does. */}
                    <a
                        id={`restore-${sequence}`}
                        role="button"
                        className={curator.linkButton}
                        href={`${PUBLISH_PAGE}?restore=${eligibility.revision}#restore-heading`}
                        aria-haspopup="dialog"
                        aria-disabled={paused || undefined}
                        aria-describedby={paused ? 'history-paused' : undefined}
                        data-off={paused ? 'true' : undefined}
                        onClick={(event) => {
                            event.preventDefault();
                            if (!paused) onRestore(sequence, eligibility.revision);
                        }}
                        onKeyDown={(event) => {
                            if (event.key !== ' ') return;
                            event.preventDefault();
                            event.currentTarget.click();
                        }}
                    >
                        <Undo2 size={16} aria-hidden="true" />
                        Restore revision {eligibility.revision}
                    </a>
                </div>
            ) : eligibility.type === 'check' ? (
                <div className={styles.action}>
                    <a className={curator.linkButton} href={eligibility.href}>
                        Check revision {eligibility.revision}
                    </a>
                </div>
            ) : null}
        </li>
    );
}

function ResultBlock({ result, zone }: { result: RestoreResult; zone: string }) {
    const Icon = result.clock ? Clock : TONE_ICON[result.tone];
    return (
        <section id="restore-result" className={`${curator.notice} ${publish.result} ${styles.dialogResult}`} data-tone={result.tone} aria-labelledby="restore-result-heading">
            <h3 id="restore-result-heading" tabIndex={-1} className={publish.resultHeading}>
                <Icon size={18} aria-hidden="true" />
                {localize(result.heading, zone)}
            </h3>
            {result.body.map((line) => (
                <p key={line}>{localize(line, zone)}</p>
            ))}
            {result.list ? (
                <ul className={styles.reasons}>
                    {result.list.map((line) => (
                        <li key={line}>{localize(line, zone)}</li>
                    ))}
                </ul>
            ) : null}
        </section>
    );
}

interface DialogProps {
    plan: PlanView;
    zone: string;
    /** Rendered open on the server for `?restore=`, without JavaScript. */
    staticOpen: boolean;
    action: (previous: RestoreState, form: FormData) => Promise<RestoreState>;
    onClose: () => void;
}

/** The restore dialog: one mounted dialog across its phases, the typed reason kept in state. */
function RestoreDialog({ plan, zone, staticOpen, action, onClose }: DialogProps) {
    const ref = useRef<HTMLDialogElement>(null);
    const [state, dispatch, pending] = useActionState(action, RESTORE_IDLE);
    const [reason, setReason] = useState('');
    // An empty reason caught here, before any post; the server's own check answers `reason-missing` too.
    const [missing, setMissing] = useState(0);
    const answer = state.answer;
    const result = answer?.kind === 'result' ? answer.result : null;
    const reasonMissing = !/\S/.test(reason) && !pending && (missing > 0 || answer?.kind === 'reason-missing');
    const moved = result?.moved;
    const n = plan.revision;
    const phase = pending ? 'pending' : result ? 'result' : reasonMissing ? 'missing' : 'review';
    const opened = useRef(false);

    // Open as a modal: on mount, or after a `?restore=` page load opened it in place.
    useEffect(() => {
        const element = ref.current;
        if (!element) return;
        if (!element.matches(':modal')) {
            if (element.open) element.close();
            element.showModal();
        }
        if (!opened.current) {
            opened.current = true;
            document.getElementById('restore-heading')?.focus();
        }
    }, []);

    // A done restore loads the page that shows it.
    useEffect(() => {
        if (answer?.kind === 'restored') window.location.assign(`${PUBLISH_PAGE}?restored=${answer.sequence}${answer.rebased ? '' : '&rebased=0'}#history-result-heading`);
    }, [answer]);

    // Focus by phase: the empty reason, the pending button, or the answer's heading with its whole box in view.
    useEffect(() => {
        if (!opened.current || phase === 'review') return;
        requestAnimationFrame(() => {
            if (phase === 'missing') document.getElementById('restore-reason')?.focus();
            else if (phase === 'pending') document.getElementById('restore-submit')?.focus();
            else {
                document.getElementById('restore-result')?.scrollIntoView({ block: 'start', behavior: 'instant' });
                document.getElementById('restore-result-heading')?.focus({ preventScroll: true });
            }
        });
    }, [phase, state.serial, missing]);

    const submit = (event: FormEvent<HTMLFormElement>) => {
        if (pending) {
            event.preventDefault();
            return;
        }
        if (!/\S/.test(reason)) {
            event.preventDefault();
            setMissing((count) => count + 1);
        }
    };

    // An answer that leaves nothing to submit (no Restore again, no Finish restoring) keeps the reason read-only, unsaved.
    const actions: ResultAction[] = result ? result.actions : ['cancel', 'retry'];
    const settledReason = Boolean(result) && !actions.includes('retry') && !actions.includes('finish');
    const button = (action: ResultAction) => {
        if (action === 'close-reload') {
            return (
                <a key={action} className={curator.linkButton} href={PUBLISH_PAGE}>
                    Close and reload
                </a>
            );
        }
        if (action === 'cancel' || action === 'close') {
            return (
                <button key={action} type="button" className={curator.button} aria-disabled={pending || undefined} data-off={pending ? 'true' : undefined} onClick={() => (pending ? undefined : onClose())}>
                    {action === 'cancel' ? 'Cancel' : 'Close'}
                </button>
            );
        }
        if (action === 'reload') {
            return (
                <a key={action} className={`${curator.linkButton} ${publish.primaryLink}`} href={PUBLISH_PAGE}>
                    <RefreshCw size={16} aria-hidden="true" />
                    Load the updated page
                </a>
            );
        }
        const label = action === 'finish' ? `Finish restoring revision ${n}` : `Restore revision ${n}`;
        return (
            <button key={action} id="restore-submit" type="submit" className={`${curator.button} ${curator.primary}`} aria-disabled={pending || undefined} data-pending={pending ? 'true' : undefined} data-primary="true">
                <Undo2 size={16} aria-hidden="true" />
                {pending ? `Restoring revision ${n}…` : label}
            </button>
        );
    };

    return (
        <dialog
            ref={ref}
            id="restore-dialog"
            className={styles.dialog}
            open={staticOpen || undefined}
            aria-labelledby="restore-heading"
            aria-describedby="restore-stakes"
            onCancel={(event) => {
                // Escape: closes, except while a restore is in flight. After an answer that found the pointer moved, the
                // page behind is out of date, so Escape loads it again, as Close and reload would (spec: never a plain close).
                event.preventDefault();
                if (pending) return;
                if (moved) window.location.assign(PUBLISH_PAGE);
                else onClose();
            }}
        >
            {/* The dialog's own live region: the page's is inert while this is open. */}
            <p role="status" className={curator.visuallyHidden}>
                {pending ? `Restoring revision ${n}. Revision ${plan.active} stays live until the switch.` : ''}
            </p>
            <form className={styles.form} action={dispatch} onSubmit={submit} noValidate aria-busy={pending || undefined}>
                <input type="hidden" name="revisionId" value={plan.revisionId} />
                <input type="hidden" name="expectedActive" value={plan.activeRevisionId} />
                <div className={styles.dialogBody}>
                    <h2 id="restore-heading" tabIndex={-1}>
                        Restore revision {n}?
                    </h2>
                    <p id="restore-stakes" className={styles.stakes}>
                        {moved
                            ? `This page loaded while revision ${plan.active} was live.`
                            : `Visitors see revision ${plan.active} now. Restoring makes revision ${n} live again on every page. Revision ${plan.active} stays in History, so you can restore it later.`}
                    </p>
                    <dl className={styles.cas}>
                        <div>
                            <dt>{moved ? 'Live when you opened this' : 'Live now'}</dt>
                            <dd>
                                Revision {plan.active} · {plan.activeHash}
                            </dd>
                        </div>
                        <div>
                            <dt>Restoring</dt>
                            <dd>
                                Revision {n} · {plan.hash}
                            </dd>
                        </div>
                    </dl>
                    {moved ? null : <p className={styles.casNote}>If another revision goes live before you confirm, nothing is restored.</p>}
                    {moved?.impact === 'hide' ? null : (
                        <>
                            <h3 className={styles.impactHeading}>{moved ? `What it would have changed, against revision ${plan.active}` : 'What changes for visitors'}</h3>
                            {plan.impactNote ? <p className={styles.casNote}>{plan.impactNote}</p> : null}
                            <ul className={styles.impact}>
                                {plan.impact.map((line) => (
                                    <li key={line.text}>
                                        {line.text}
                                        {line.more ? (
                                            <details className={styles.moreNames}>
                                                <summary>and {line.more.length} more</summary>
                                                <p>{line.more.join(', ')}</p>
                                            </details>
                                        ) : null}
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                    {plan.draftNote ? (
                        <div className={`${curator.notice} ${styles.draftNote}`} data-tone="change">
                            <p>
                                <CircleAlert size={15} aria-hidden="true" />
                                {plan.draftNote}
                            </p>
                        </div>
                    ) : null}
                    {plan.editorial ? (
                        <div className={`${curator.notice} ${styles.editorial}`} data-tone="change">
                            <p>{plan.editorial}</p>
                            <p>Restoring brings it back as it was, and History records that you accepted it.</p>
                        </div>
                    ) : null}
                    <div className={styles.field}>
                        <label htmlFor="restore-reason">Why are you restoring it?</label>
                        <p id="restore-reason-hint" className={styles.hint}>
                            {settledReason ? 'Not saved: nothing was restored.' : 'Saved with this entry in History.'}
                        </p>
                        <textarea
                            id="restore-reason"
                            name="reason"
                            rows={3}
                            maxLength={500}
                            required
                            value={reason}
                            onChange={(event) => setReason(event.target.value)}
                            readOnly={pending || settledReason}
                            aria-invalid={reasonMissing || undefined}
                            aria-describedby={reasonMissing ? 'restore-reason-error restore-reason-hint' : 'restore-reason-hint'}
                        />
                        {reasonMissing ? (
                            <p id="restore-reason-error" className={styles.fieldError}>
                                <CircleAlert size={15} aria-hidden="true" />
                                Say why in a few words. It&apos;s saved with the entry.
                            </p>
                        ) : null}
                    </div>
                    {result ? <ResultBlock result={result} zone={zone} /> : null}
                </div>
                <div className={`${publish.buttons} ${styles.dialogActions}`}>{actions.map(button)}</div>
            </form>
        </dialog>
    );
}

interface HistorySectionProps {
    view: HistoryView;
    /** ./actions.ts's restoreAction, passed down by the page, so this client module imports no server code. */
    action: (previous: RestoreState, form: FormData) => Promise<RestoreState>;
    /** `?restore=N`: the revision whose dialog the page opens, for a load without JavaScript. */
    openRestore: number | null;
}

export default function HistorySection({ view: loaded, action, openRestore }: HistorySectionProps) {
    // 16-3's answer: one that moved the pointer carries History read again; a pending press pauses Restore.
    const { result: answer, pending: publishing, sent, zone } = usePublishAnswer();
    // A later answer that carries no History (busy, say) keeps the last one read, not the page load's (high review M1).
    const fresh = answeredHistory(answer);
    const [carried, setCarried] = useState<HistoryView | null>(null);
    if (fresh && fresh !== carried) setCarried(fresh);
    const view = fresh ?? carried ?? loaded;
    const fromUrl = openRestore !== null && view.plans[openRestore] ? openRestore : null;
    const [open, setOpen] = useState<{ revision: number; opener: number | null; staticOpen: boolean } | null>(fromUrl === null ? null : { revision: fromUrl, opener: null, staticOpen: true });

    // The page after a restore: its notice's heading takes focus. Show older: the first new entry's heading.
    useEffect(() => {
        const hash = window.location.hash;
        const target = view.done ? document.getElementById('history-result-heading') : /^#entry-\d+-title$/.test(hash) ? document.getElementById(hash.slice(1)) : null;
        if (!target) return;
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'start', behavior: 'instant' });
        // Run once, for the page load.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const close = () => {
        const opener = open?.opener ?? null;
        // Opened from `?restore=N`: closing drops it from the address, so a reload doesn't open it again.
        if (open?.staticOpen) window.history.replaceState(null, '', `${PUBLISH_PAGE}#history-heading`);
        setOpen(null);
        requestAnimationFrame(() => (document.getElementById(`restore-${opener}`) ?? document.getElementById('history-heading'))?.focus());
    };

    const plan = open ? view.plans[open.revision] : undefined;
    return (
        <section className={styles.history} id="history" aria-labelledby="history-heading">
            <h2 id="history-heading" tabIndex={-1}>
                History
            </h2>
            <p className={styles.lead}>{view.lead}</p>
            {publishing ? (
                <p id="history-paused" className={styles.paused}>
                    {sent === 'publish' ? 'You can restore again once this publish finishes.' : sent === 'validate' ? 'You can restore again once this check finishes.' : 'You can restore again once this review is saved.'}
                </p>
            ) : null}
            {view.done ? (
                <section className={`${curator.notice} ${publish.result} ${styles.done}`} data-tone="done" aria-labelledby="history-result-heading">
                    <h3 id="history-result-heading" tabIndex={-1} className={publish.resultHeading}>
                        <Check size={18} aria-hidden="true" />
                        {view.done.heading}
                    </h3>
                    {view.done.body.map((line) => (
                        <p key={line}>{line}</p>
                    ))}
                    <p className={publish.resultLinks}>
                        {view.done.jump ? (
                            <a className={curator.linkButton} href={`#${view.done.jump.target}`} onClick={(event) => jumpTo(event, view.done?.jump?.target ?? '')}>
                                {view.done.jump.label}
                            </a>
                        ) : null}
                        <a className={curator.linkButton} href="/" target="_blank" rel="noopener noreferrer">
                            Open the site
                            <span className={curator.visuallyHidden}> (opens in a new tab)</span>
                            <ExternalLink size={14} aria-hidden="true" />
                        </a>
                    </p>
                </section>
            ) : null}
            <ol className={styles.entries}>
                {view.entries.map((entry) => (
                    <EntryItem key={entry.sequence} entry={entry} paused={publishing} zone={zone} onRestore={(sequence, revision) => setOpen({ revision, opener: sequence, staticOpen: false })} />
                ))}
            </ol>
            {view.count ? (
                <div className={styles.more}>
                    <p>{view.count}</p>
                    {view.more ? (
                        <a className={curator.linkButton} href={view.more.href}>
                            {view.more.label}
                        </a>
                    ) : null}
                </div>
            ) : null}
            {open && plan ? <RestoreDialog key={`${open.revision}-${open.opener ?? 'url'}`} plan={plan} zone={zone} staticOpen={open.staticOpen} action={action} onClose={close} /> : null}
        </section>
    );
}
