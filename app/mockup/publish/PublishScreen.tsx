import { Check, CircleAlert, Clock, ExternalLink, FileCheck2, Link2, RefreshCw, Sparkles, Undo2, UploadCloud, type LucideIcon } from 'lucide-react';
import CuratorHeader from '@/app/curation/CuratorHeader';
import curator from '@/app/curation/curator.module.css';
import PreviewFrame from '@/components/curation/PreviewFrame';
import type { Compare, Fix, LedgerRow, ReviewLabel, ScreenModel } from './model';
import styles from './publish.module.css';

/**
 * The 16-3 Publish screen as a static mockup: markup and styles as the real
 * screen would render them, from fixture models. Buttons do nothing here.
 * Not for merge.
 */

const REVIEW: Record<ReviewLabel, { text: string; icon: LucideIcon; tone: 'done' | 'alert' | 'change' | 'quiet' }> = {
    reviewed: { text: 'Reviewed', icon: Check, tone: 'done' },
    'not-reviewed': { text: 'Not reviewed', icon: CircleAlert, tone: 'alert' },
    stale: { text: 'Stale review', icon: Clock, tone: 'alert' },
    generated: { text: 'Generated · not reviewed', icon: Sparkles, tone: 'alert' },
    automatic: { text: 'Automatic', icon: RefreshCw, tone: 'quiet' },
    confirmed: { text: 'Confirmed in Inbox', icon: Link2, tone: 'quiet' },
    published: { text: 'Published', icon: Check, tone: 'done' },
};

function ReviewBadge({ review }: { review: ReviewLabel }) {
    const { text, icon: Icon, tone } = REVIEW[review];
    return (
        <span className={styles.review} data-tone={tone}>
            <Icon size={14} aria-hidden="true" />
            {text}
        </span>
    );
}

function Comparison({ compare }: { compare: Compare }) {
    if (compare.type === 'text') {
        return (
            <dl className={styles.compare}>
                <div>
                    <dt>Published</dt>
                    <dd>{compare.before ?? <span className={styles.none}>None yet</span>}</dd>
                </div>
                <div>
                    <dt>This draft</dt>
                    <dd>{compare.after ?? <span className={styles.none}>None</span>}</dd>
                </div>
            </dl>
        );
    }
    if (compare.type === 'images') {
        return (
            <dl className={styles.compare}>
                <div>
                    <dt>Published</dt>
                    <dd>
                        <img className={styles.compareImage} src={compare.before.src} alt={compare.before.alt} width={240} height={160} />
                    </dd>
                </div>
                <div>
                    <dt>This draft</dt>
                    <dd>
                        <img className={styles.compareImage} src={compare.after.src} alt={compare.after.alt} width={240} height={160} />
                    </dd>
                </div>
            </dl>
        );
    }
    return (
        <dl className={styles.compare}>
            <div>
                <dt>Published</dt>
                <dd>
                    <ol className={styles.order}>
                        {compare.before.map((entry) => (
                            <li key={entry}>{entry}</li>
                        ))}
                    </ol>
                </dd>
            </div>
            <div>
                <dt>This draft</dt>
                <dd>
                    <ol className={styles.order}>
                        {compare.after.map((entry) => (
                            <li key={entry}>{entry}</li>
                        ))}
                    </ol>
                </dd>
            </div>
        </dl>
    );
}

/** A fix's button, or for an open description review, the review itself. */
function FixAction({ fix, inSummary = false }: { fix: Fix; inSummary?: boolean }) {
    if (fix.type === 'description') {
        if (fix.open && !inSummary) {
            return (
                <section className={styles.fix} aria-labelledby="fix-heading">
                    <h4 id="fix-heading" tabIndex={-1}>
                        Review the description of {fix.record}
                    </h4>
                    <div className={styles.fixBody}>
                        <img className={styles.fixImage} src={fix.picture.src} alt={fix.picture.alt} width={360} height={240} />
                        <div>
                            <p className={styles.fixLabel}>Generated description</p>
                            <p className={styles.fixText}>{fix.text}</p>
                            <p className={styles.fixNote}>{fix.suggested}</p>
                            <p className={styles.fixNote}>
                                Mark it ready only if it says what the photograph shows. To change the words, edit it in the Inbox, or run <code className={curator.mono}>photos edit {fix.photoId}</code>.
                            </p>
                        </div>
                    </div>
                    <div className={styles.fixActions}>
                        <button type="button" className={curator.button}>
                            Cancel
                        </button>
                        <button type="button" className={`${curator.button} ${curator.primary}`}>
                            <Check size={16} aria-hidden="true" />
                            Mark description ready
                            <span className={curator.visuallyHidden}>: {fix.record}</span>
                        </button>
                    </div>
                </section>
            );
        }
        return (
            <button type="button" className={curator.button} aria-expanded={inSummary ? undefined : false}>
                Review and mark description ready
                <span className={curator.visuallyHidden}>: {fix.record}</span>
            </button>
        );
    }
    if (fix.type === 'restamp') {
        return (
            <button type="button" className={curator.button}>
                {fix.label}
                <span className={curator.visuallyHidden}>: {fix.record}</span>
            </button>
        );
    }
    return (
        <span className={styles.inboxFix}>
            <a className={curator.linkButton} href="/curation/inbox">
                Decide it in the Inbox
                <span className={curator.visuallyHidden}>: {fix.record}</span>
            </a>
            <code className={curator.mono}>curation show {fix.eventId}</code>
        </span>
    );
}

function Row({ row }: { row: LedgerRow }) {
    return (
        <li className={styles.row} id={row.id} data-blocks={row.blocks ? 'true' : undefined}>
            <div className={styles.rowMeta}>
                <ReviewBadge review={row.review} />
                <span className={styles.kind}>{row.kind}</span>
                {row.blocks ? <span className={styles.blocks}>Blocks publishing</span> : null}
            </div>
            <p className={styles.summary}>{row.summary}</p>
            {row.detail ? <p className={styles.detail}>{row.detail}</p> : null}
            {row.compare ? <Comparison compare={row.compare} /> : null}
            {row.fix ? (
                <div className={styles.rowFix}>
                    <FixAction fix={row.fix} />
                </div>
            ) : null}
        </li>
    );
}

function Group({ heading, rows, tone }: { heading: string; rows: LedgerRow[]; tone: 'authored' | 'derived' | 'health' }) {
    if (rows.length === 0) return null;
    return (
        <section className={styles.group} data-group={tone} aria-labelledby={`group-${tone}`}>
            <h3 id={`group-${tone}`} className={styles.groupHeading}>
                {heading} <span className={styles.count}>({rows.length})</span>
            </h3>
            <ul className={styles.rows}>
                {rows.map((row) => (
                    <Row key={row.id} row={row} />
                ))}
            </ul>
        </section>
    );
}

function ResultPanel({ model }: { model: ScreenModel }) {
    const { result } = model;
    if (!result) return null;
    if (result.type === 'blocked') {
        return (
            <section className={`${curator.notice} ${styles.result}`} data-tone="alert" aria-labelledby="result-heading">
                <h2 id="result-heading" tabIndex={-1} className={styles.resultHeading}>
                    <CircleAlert size={18} aria-hidden="true" />
                    Publication blocked
                </h2>
                <p>{result.lead}</p>
                <ol className={styles.errors}>
                    {result.errors.map((error) => (
                        <li key={error.rowId}>
                            <strong>
                                {error.record} · {error.field}
                            </strong>
                            <span>{error.message}</span>
                            <span className={styles.errorActions}>
                                <a href={`#${error.rowId}`} className={styles.textLink}>
                                    Go to the change<span className={curator.visuallyHidden}>: {error.record}</span>
                                </a>
                                {error.fix ? <FixAction fix={error.fix} inSummary /> : null}
                            </span>
                        </li>
                    ))}
                </ol>
            </section>
        );
    }
    if (result.type === 'valid') {
        return (
            <section className={`${curator.notice} ${styles.result}`} data-tone="done" aria-labelledby="result-heading">
                <h2 id="result-heading" tabIndex={-1} className={styles.resultHeading}>
                    <Check size={18} aria-hidden="true" />
                    Catalog revision is valid
                </h2>
                <p>All references resolve. The previous public revision remains live.</p>
            </section>
        );
    }
    return (
        <section className={`${curator.notice} ${styles.result}`} data-tone="done" aria-labelledby="result-heading">
            <h2 id="result-heading" tabIndex={-1} className={styles.resultHeading}>
                <Check size={18} aria-hidden="true" />
                Revision {result.number} published atomically
            </h2>
            <p>Visitor APIs now revalidate against the new catalog ETag.</p>
            <p className={styles.resultLinks}>
                <a className={curator.linkButton} href="/">
                    Open the site
                </a>
                <a className={curator.linkButton} href="/curation/publish">
                    Load the working catalog again
                </a>
            </p>
        </section>
    );
}

function Actions({ model }: { model: ScreenModel }) {
    if (model.validate === 'hidden' && model.publish === 'hidden') return null;
    const pending = model.publish === 'pending';
    const publishOff = model.publish !== 'available';
    return (
        <footer className={styles.actions} aria-busy={pending ? true : undefined}>
            {model.confirm ? (
                <div className={`${curator.notice} ${styles.confirm}`} data-tone="change" role="group" aria-labelledby="confirm-heading">
                    <p id="confirm-heading" className={styles.confirmHeading}>
                        Publish revision {model.draftNumber} now?
                    </p>
                    <p>Visitors get it at once, on every page. Revision {model.liveNumber} stays rollback-ready.</p>
                    <div className={styles.confirmActions}>
                        <button type="button" className={curator.button}>
                            Cancel
                        </button>
                        <button type="button" className={`${curator.button} ${curator.primary}`}>
                            <UploadCloud size={16} aria-hidden="true" />
                            Publish now
                        </button>
                    </div>
                </div>
            ) : null}
            <div className={styles.buttons}>
                {model.status ? (
                    <p className={styles.status} role="status">
                        {model.status}
                    </p>
                ) : (
                    <p className={styles.status} role="status" />
                )}
                {model.validate !== 'hidden' ? (
                    <button type="button" className={curator.button} aria-disabled={model.validate === 'unavailable' ? true : undefined} data-off={model.validate === 'unavailable' ? 'true' : undefined}>
                        <FileCheck2 size={16} aria-hidden="true" />
                        Validate revision
                    </button>
                ) : null}
                {model.publish !== 'hidden' ? (
                    <button
                        type="button"
                        className={`${curator.button} ${curator.primary}`}
                        aria-disabled={publishOff ? true : undefined}
                        aria-describedby={model.publishReason ? 'publish-reason' : undefined}
                        data-off={publishOff ? 'true' : undefined}
                    >
                        <UploadCloud size={16} aria-hidden="true" />
                        {pending ? `Publishing revision ${model.draftNumber}…` : `Publish revision ${model.draftNumber}`}
                    </button>
                ) : null}
            </div>
            {model.publishReason ? (
                <p id="publish-reason" className={styles.reason}>
                    {model.publishReason}
                </p>
            ) : null}
        </footer>
    );
}

function PreviewPanel({ model }: { model: ScreenModel }) {
    const { panel } = model;
    if (!panel) return null;
    return (
        <section className={styles.panel} aria-labelledby="preview-heading">
            <header className={styles.panelHeader}>
                <h2 id="preview-heading">Visitor preview</h2>
                <a href="/mockup/publish/site" className={styles.textLink} target="_blank" rel="noopener noreferrer">
                    Open full preview
                    <span className={curator.visuallyHidden}> (opens in a new tab)</span>
                    <ExternalLink size={14} aria-hidden="true" />
                </a>
            </header>
            <PreviewFrame src={panel.src} height="22rem" focusable={false} />
            <div className={styles.panelText}>
                <p className={styles.panelSeries}>{panel.series}</p>
                <p className={styles.panelCount}>{panel.count}</p>
                <p className={styles.panelCopy}>{panel.copyLine}</p>
            </div>
            {panel.rollback ? (
                <footer className={styles.panelFooter}>
                    <Undo2 size={15} aria-hidden="true" />
                    {panel.rollback}
                </footer>
            ) : null}
        </section>
    );
}

export default function PublishScreen({ model }: { model: ScreenModel }) {
    if (model.page) {
        return (
            <div className={curator.page}>
                <CuratorHeader active="publish" publishHref="/curation/publish" />
                <main className={curator.state}>
                    <h1>{model.page.heading}</h1>
                    <p>{model.page.body}</p>
                    {model.page.code ? (
                        <p>
                            <code className={styles.command}>{model.page.code}</code>
                        </p>
                    ) : null}
                    <a className={curator.linkButton} href="/curation/publish">
                        {model.page.action}
                    </a>
                </main>
            </div>
        );
    }
    const { ledger } = model;
    return (
        <div className={curator.page}>
            <CuratorHeader active="publish" publishHref="/curation/publish" />
            <main className={styles.body}>
                <header className={styles.heading}>
                    <div>
                        <h1>{model.heading ?? `Preview catalog revision ${model.draftNumber}`}</h1>
                        <p>{model.lead ?? 'Authored changes require approval. Derived facts refresh from the validated catalog.'}</p>
                    </div>
                    <p className={styles.revisions}>
                        <span>Current public revision {model.liveNumber}</span>
                        <span>
                            {model.draftHash !== model.liveHash ? `Draft ${model.draftHash} · ` : ''}Live {model.liveHash}
                        </span>
                    </p>
                </header>
                {model.notice ? (
                    <div className={`${curator.notice} ${styles.topNotice}`} data-tone={model.notice.tone} role={model.notice.tone === 'done' ? 'status' : undefined}>
                        <p className={styles.noticeHeading}>{model.notice.heading}</p>
                        <p>{model.notice.body}</p>
                        {model.notice.action ? (
                            <a className={curator.linkButton} href="/curation/publish">
                                {model.notice.action}
                            </a>
                        ) : null}
                    </div>
                ) : null}
                <div className={styles.layout} data-ledger={ledger ? 'yes' : 'no'}>
                    <PreviewPanel model={model} />
                    {ledger ? (
                        <section className={styles.ledger} aria-labelledby="ledger-heading">
                            <h2 id="ledger-heading">{model.ledgerHeading ?? 'Change ledger'}</h2>
                            <Group heading="Authored · requires judgment" rows={ledger.authored} tone="authored" />
                            <Group heading="Derived · recalculated automatically" rows={ledger.derived} tone="derived" />
                            <Group heading="Source health" rows={ledger.health} tone="health" />
                            <ResultPanel model={model} />
                            <Actions model={model} />
                        </section>
                    ) : (
                        <section className={styles.ledger} aria-labelledby="ledger-heading">
                            <h2 id="ledger-heading">Change ledger</h2>
                            <p className={styles.emptyLedger}>No changes to review.</p>
                            <p>
                                <a className={curator.linkButton} href="/curation/inbox">
                                    Open the Inbox
                                </a>
                            </p>
                        </section>
                    )}
                </div>
            </main>
        </div>
    );
}
