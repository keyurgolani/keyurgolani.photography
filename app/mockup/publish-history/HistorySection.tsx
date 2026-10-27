'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, CircleAlert, CircleDashed, Clock, ExternalLink, RefreshCw, Undo2, type LucideIcon } from 'lucide-react';
import curator from '@/app/curation/curator.module.css';
import publish from '@/app/curation/publish/publish.module.css';
import type { DialogState, Entry, HistoryModel, Plan, Result, ResultAction } from './model';
import styles from './history.module.css';

/**
 * 15-4's History section and restore dialog (spec, The list, The restore
 * flow), on fixture data. It reuses 16-3's badge, kind, result and button
 * styles and the curator tokens. The dialog is a native modal `<dialog>`:
 * focus goes to its heading on open, Tab stays inside it, Escape and Cancel
 * return focus to the Restore button that opened it, and while it's open its
 * own live region is the page's only one (the screen's is inert behind it).
 * The mockup's Restore goes to the pending state and stays there. Not for merge.
 */

const Pause = () => <span className={curator.visuallyHidden}>, </span>;

const TONE_ICON: Record<'done' | 'alert' | 'change', LucideIcon> = { done: Check, alert: CircleAlert, change: RefreshCw };

function EntryItem({ entry, onRestore }: { entry: Entry; onRestore: (sequence: number, revision: number) => void }) {
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
                <p className={styles.when}>{entry.when}</p>
                {entry.reason ? <p className={styles.reason}>{entry.reason.quoted ? `“${entry.reason.text}”` : `Note: ${entry.reason.text}`}</p> : null}
                <p className={styles.from}>
                    {entry.from}
                    {entry.held ? ` ${entry.held}` : ''}
                </p>
                {entry.extra ? <p className={styles.from}>{entry.extra}</p> : null}
                <p className={styles.facts}>{entry.facts}</p>
                {eligibility.type === 'text' ? (
                    <p className={styles.why} data-tone={eligibility.tone}>
                        {eligibility.tone === 'alert' ? <CircleAlert size={15} aria-hidden="true" /> : eligibility.tone === 'done' ? <Check size={15} aria-hidden="true" /> : null}
                        {eligibility.text}
                    </p>
                ) : null}
            </div>
            {eligibility.type === 'restore' ? (
                <div className={styles.action}>
                    <button type="button" id={`restore-${sequence}`} className={curator.button} onClick={() => onRestore(sequence, eligibility.revision)}>
                        <Undo2 size={16} aria-hidden="true" />
                        Restore revision {eligibility.revision}
                    </button>
                </div>
            ) : null}
        </li>
    );
}

function ResultBlock({ result }: { result: Result }) {
    const Icon = result.clock ? Clock : TONE_ICON[result.tone];
    return (
        <section className={`${curator.notice} ${publish.result} ${styles.dialogResult}`} data-tone={result.tone} aria-labelledby="restore-result-heading">
            <h3 id="restore-result-heading" tabIndex={-1} className={publish.resultHeading}>
                <Icon size={18} aria-hidden="true" />
                {result.heading}
            </h3>
            {result.body.map((line) => (
                <p key={line}>{line}</p>
            ))}
            {result.list ? (
                <ul className={styles.reasons}>
                    {result.list.map((line) => (
                        <li key={line}>{line}</li>
                    ))}
                </ul>
            ) : null}
        </section>
    );
}

function RestoreDialog({ state, onClose, onSubmit }: { state: DialogState; onClose: () => void; onSubmit: (reason: string) => void }) {
    const ref = useRef<HTMLDialogElement>(null);
    const { plan, phase, result } = state;
    const pending = phase === 'pending';
    const missing = phase === 'reason-missing';
    const n = plan.revision;

    // Open as a modal, then focus by phase: the heading, the empty reason, the pending button, or the answer's heading.
    useEffect(() => {
        const element = ref.current;
        if (!element) return;
        if (!element.open) element.showModal();
        const id = missing ? 'restore-reason' : pending ? 'restore-submit' : phase === 'result' ? 'restore-result-heading' : 'restore-heading';
        requestAnimationFrame(() => document.getElementById(id)?.focus());
    }, [phase, missing, pending]);

    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (pending) return;
        const reason = new FormData(event.currentTarget).get('reason');
        onSubmit(typeof reason === 'string' ? reason : '');
    };

    const actions: ResultAction[] = phase === 'result' && result ? result.actions : ['cancel', 'retry'];
    const button = (action: ResultAction) => {
        if (action === 'cancel' || action === 'close') {
            return (
                <button key={action} type="button" className={curator.button} aria-disabled={pending || undefined} data-off={pending ? 'true' : undefined} onClick={() => (pending ? undefined : onClose())}>
                    {action === 'cancel' ? 'Cancel' : 'Close'}
                </button>
            );
        }
        if (action === 'reload') {
            return (
                <a key={action} className={`${curator.linkButton} ${publish.primaryLink}`} href="/mockup/publish-history?state=list">
                    <RefreshCw size={16} aria-hidden="true" />
                    Load the updated page
                </a>
            );
        }
        const label = action === 'finish' ? `Finish restoring revision ${n}` : `Restore revision ${n}`;
        return (
            <button
                key={action}
                id="restore-submit"
                type="submit"
                className={`${curator.button} ${curator.primary}`}
                aria-disabled={pending || undefined}
                data-pending={pending ? 'true' : undefined}
                data-primary="true"
            >
                <Undo2 size={16} aria-hidden="true" />
                {pending ? `Restoring revision ${n}…` : label}
            </button>
        );
    };

    return (
        <dialog
            ref={ref}
            className={styles.dialog}
            aria-labelledby="restore-heading"
            aria-describedby="restore-stakes"
            onCancel={(event) => {
                // Escape: closes, except while a restore is in flight.
                event.preventDefault();
                if (!pending) onClose();
            }}
        >
            {/* The dialog's own live region: the page's is inert while this is open. */}
            <p role="status" className={curator.visuallyHidden}>
                {pending ? `Restoring revision ${n}. Revision ${plan.active} stays live until the switch.` : ''}
            </p>
            <form className={styles.form} onSubmit={submit} noValidate aria-busy={pending || undefined}>
                <input type="hidden" name="revisionId" value={`rev_${plan.hash}`} />
                <input type="hidden" name="expectedActive" value={`rev_${plan.activeHash}`} />
                <div className={styles.dialogBody}>
                    <h2 id="restore-heading" tabIndex={-1}>
                        Restore revision {n}?
                    </h2>
                    <p id="restore-stakes" className={styles.stakes}>
                        Visitors see revision {plan.active} now. Restoring makes revision {n} live again on every page. Revision {plan.active} stays in History, so you can restore it later.
                    </p>
                    <dl className={styles.cas}>
                        <div>
                            <dt>Live now</dt>
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
                    <p className={styles.casNote}>If another revision goes live before you confirm, nothing is restored.</p>
                    <h3 className={styles.impactHeading}>What changes for visitors</h3>
                    <ul className={styles.impact}>
                        {plan.impact.map((line) => (
                            <li key={line}>{line}</li>
                        ))}
                    </ul>
                    {plan.draftNote ? <p className={styles.draftNote}>{plan.draftNote}</p> : null}
                    {plan.editorial ? <Editorial text={plan.editorial} /> : null}
                    <div className={styles.field}>
                        <label htmlFor="restore-reason">Why are you restoring it?</label>
                        <p id="restore-reason-hint" className={styles.hint}>
                            Saved with this entry in History.
                        </p>
                        <textarea
                            id="restore-reason"
                            name="reason"
                            rows={3}
                            maxLength={500}
                            required
                            defaultValue={state.reason}
                            readOnly={pending}
                            aria-invalid={missing || undefined}
                            aria-describedby={missing ? 'restore-reason-error restore-reason-hint' : 'restore-reason-hint'}
                        />
                        {missing ? (
                            <p id="restore-reason-error" className={styles.fieldError}>
                                <CircleAlert size={15} aria-hidden="true" />
                                Say why in a few words. It&apos;s saved with the entry.
                            </p>
                        ) : null}
                    </div>
                    {phase === 'result' && result ? <ResultBlock result={result} /> : null}
                </div>
                <div className={`${publish.buttons} ${styles.dialogActions}`}>{actions.map(button)}</div>
            </form>
        </dialog>
    );
}

function Editorial({ text }: { text: string }) {
    return (
        <div className={`${curator.notice} ${styles.editorial}`} data-tone="change">
            <p>{text}</p>
            <p>Restoring brings it back as it was, and History records that you accepted it.</p>
        </div>
    );
}

export default function HistorySection({ model }: { model: HistoryModel }) {
    const [dialog, setDialog] = useState<DialogState | null>(model.dialog ?? null);
    const opener = useRef<number | null>(model.dialog?.opener ?? null);

    // The page after a restore: its notice's heading takes focus, as an answer's does.
    useEffect(() => {
        if (!model.done) return;
        const heading = document.getElementById('history-result-heading');
        heading?.focus({ preventScroll: true });
        heading?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }, [model.done]);

    const open = (sequence: number, revision: number) => {
        const plan: Plan | undefined = model.plans[revision];
        if (!plan) return;
        opener.current = sequence;
        setDialog({ plan, opener: sequence, phase: 'review', reason: '' });
    };

    const close = () => {
        setDialog(null);
        const back = opener.current;
        requestAnimationFrame(() => (document.getElementById(`restore-${back}`) ?? document.getElementById('history-heading'))?.focus());
    };

    const shown = model.entries.length;
    return (
        <section className={styles.history} id="history" aria-labelledby="history-heading">
            <h2 id="history-heading" tabIndex={-1}>
                History
            </h2>
            <p className={styles.lead}>{model.lead}</p>
            {model.done ? (
                <section className={`${curator.notice} ${publish.result} ${styles.done}`} data-tone="done" aria-labelledby="history-result-heading">
                    <h3 id="history-result-heading" tabIndex={-1} className={publish.resultHeading}>
                        <Check size={18} aria-hidden="true" />
                        {model.done.heading}
                    </h3>
                    {model.done.body.map((line) => (
                        <p key={line}>{line}</p>
                    ))}
                    <p className={publish.resultLinks}>
                        <a className={curator.linkButton} href="/mockup/publish-history/site" target="_blank" rel="noopener noreferrer">
                            Open the site
                            <span className={curator.visuallyHidden}> (opens in a new tab)</span>
                            <ExternalLink size={14} aria-hidden="true" />
                        </a>
                    </p>
                </section>
            ) : null}
            <ol className={styles.entries}>
                {model.entries.map((entry) => (
                    <EntryItem key={entry.sequence} entry={entry} onRestore={open} />
                ))}
            </ol>
            {model.total && model.more ? (
                <div className={styles.more}>
                    <p>
                        Showing the newest {shown} of {model.total} entries.
                    </p>
                    <a className={curator.linkButton} href={model.more.href}>
                        {model.more.label}
                    </a>
                </div>
            ) : null}
            {dialog ? (
                <RestoreDialog
                    key={`${dialog.plan.revision}-${dialog.phase}`}
                    state={dialog}
                    onClose={close}
                    onSubmit={(reason) => setDialog({ ...dialog, reason, phase: /\S/.test(reason) ? 'pending' : 'reason-missing' })}
                />
            ) : null}
        </section>
    );
}
