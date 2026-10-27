import { Fragment, type ReactNode } from 'react';
import { Check, CircleAlert, Clock, ExternalLink, FileCheck2, Link2, RefreshCw, Sparkles, Undo2, UploadCloud, type LucideIcon } from 'lucide-react';
import CuratorHeader from '@/app/curation/CuratorHeader';
import curator from '@/app/curation/curator.module.css';
import PreviewFrame from '@/components/curation/PreviewFrame';
import { itemUrl } from './fixtures';
import type { ActionState, BlockingError, Compare, Fix, LedgerRow, OrderCompare, Refusal, Result, ReviewLabel, ScreenModel } from './model';
import styles from './publish.module.css';

/**
 * The 16-3 Publish screen as a static mockup: markup and styles as the real
 * screen would render them, from fixture models. Buttons do nothing here.
 * Not for merge.
 *
 * Revision 2 (spec, "Revision 2"): every answer lands in the one result slot
 * above the sticky bar; the screen's fixed facts come from the model; one
 * always-present live region; the blocker list is links only.
 */

type Labels = ScreenModel['compareLabels'];

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

/** The positions an order compare shows: one either side of both ends of the move, runs that touch merged. */
function orderRuns({ before, from, to }: OrderCompare): number[][] {
    const keep = new Set<number>();
    for (const end of [from, to]) {
        for (let position = end - 1; position <= end + 1; position++) {
            if (position >= 1 && position <= before.length) keep.add(position);
        }
    }
    const runs: number[][] = [];
    for (const position of [...keep].sort((a, b) => a - b)) {
        const run = runs.at(-1);
        if (run && run.at(-1) === position - 1) run.push(position);
        else runs.push([position]);
    }
    return runs;
}

function OrderBlock({ compare, side }: { compare: OrderCompare; side: 'before' | 'after' }) {
    const entries = compare[side];
    const runs = orderRuns(compare);
    const movedAt = side === 'before' ? compare.from : compare.to;
    const note = side === 'before' ? `, moves to ${compare.to}` : `, moved from ${compare.from}`;
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
                                <span className={curator.visuallyHidden}>
                                    {gap === 1 ? '1 position' : `${gap} positions`} not shown
                                </span>
                            </p>
                        ) : null}
                        <ol className={styles.order} start={run[0]}>
                            {run.map((position) =>
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
                <div>
                    <dt>{labels.before}</dt>
                    <dd>
                        <img className={styles.compareImage} src={compare.before.src} alt={compare.before.alt} width={480} height={320} />
                    </dd>
                </div>
                <div>
                    <dt>{labels.after}</dt>
                    <dd>
                        <img className={styles.compareImage} src={compare.after.src} alt={compare.after.alt} width={480} height={320} />
                    </dd>
                </div>
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

/** A refused fix: inside the fix, under its action, with focus on it (spec, Fixes on a row). */
function RefusalStrip({ refusal }: { refusal: Refusal }) {
    return (
        <div id="fix-refusal" tabIndex={-1} className={`${curator.notice} ${styles.refusal}`} data-tone="alert">
            <p>
                <CircleAlert size={16} aria-hidden="true" />
                {refusal.text}
            </p>
            <a className={`${curator.linkButton} ${styles.primaryLink}`} href="/mockup/publish">
                {refusal.action}
            </a>
        </div>
    );
}

/** A row's fix: a button, an Inbox link, or for an open description review, the review itself. */
function FixAction({ fix }: { fix: Fix }) {
    if (fix.type === 'description') {
        if (fix.open) {
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
                    <div className={styles.fixActions}>
                        <button type="button" className={curator.button}>
                            Cancel
                        </button>
                        <button type="button" className={`${curator.button} ${curator.primary}`} aria-describedby={fix.refusal ? 'fix-refusal' : undefined}>
                            <Check size={16} aria-hidden="true" />
                            Mark description ready
                            <span className={curator.visuallyHidden}>: {fix.record}</span>
                        </button>
                    </div>
                    {fix.refusal ? <RefusalStrip refusal={fix.refusal} /> : null}
                </section>
            );
        }
        return (
            <button type="button" className={curator.button} aria-expanded={false}>
                Review and mark description ready
                <span className={curator.visuallyHidden}>: {fix.record}</span>
            </button>
        );
    }
    if (fix.type === 'restamp') {
        return (
            <div className={styles.restamp}>
                <button type="button" className={curator.button} aria-describedby={fix.refusal ? 'fix-refusal' : undefined}>
                    {fix.label}
                    <span className={curator.visuallyHidden}>: {fix.record}</span>
                </button>
                {fix.refusal ? <RefusalStrip refusal={fix.refusal} /> : null}
            </div>
        );
    }
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

function Row({ row, labels }: { row: LedgerRow; labels: Labels }) {
    const fixOpen = row.fix?.type === 'description' && row.fix.open;
    return (
        <li className={styles.row} id={row.id} data-blocks={row.blocks ? 'true' : undefined}>
            <div className={styles.rowMeta} id={`${row.id}-state`}>
                {row.blocks ? (
                    <>
                        <span className={styles.blocks}>
                            <CircleAlert size={14} aria-hidden="true" />
                            Blocks publishing
                        </span>
                        <Pause />
                    </>
                ) : null}
                <ReviewBadge review={row.review} />
                <Pause />
                <span className={styles.kind}>{row.kind}</span>
            </div>
            {/* The row's focus target: a blocker link or a finished fix lands here and reads the change, then its state. */}
            <p className={styles.summary} id={`${row.id}-summary`} tabIndex={-1} aria-describedby={`${row.id}-state`}>
                {row.summary}
            </p>
            {row.detail ? <p className={styles.detail}>{row.detail}</p> : null}
            {/* While its fix is open, the fix shows the same values beside the photograph. */}
            {row.compare && !fixOpen ? <Comparison compare={row.compare} labels={labels} /> : null}
            {row.fix ? (
                <div className={styles.rowFix}>
                    <FixAction fix={row.fix} />
                </div>
            ) : null}
        </li>
    );
}

function Group({ heading, rows, tone, labels }: { heading: string; rows: LedgerRow[]; tone: 'authored' | 'derived' | 'health'; labels: Labels }) {
    if (rows.length === 0) return null;
    return (
        <section className={styles.group} data-group={tone} aria-labelledby={`group-${tone}`}>
            <h3 id={`group-${tone}`} className={styles.groupHeading}>
                {heading} <span className={styles.count}>({rows.length})</span>
            </h3>
            <ul className={styles.rows}>
                {rows.map((row) => (
                    <Row key={row.id} row={row} labels={labels} />
                ))}
            </ul>
        </section>
    );
}

/** One link per blocker, named for its fix. Stamps are written only on the row, beside its compare. */
function BlockerLinks({ error }: { error: BlockingError }) {
    const { link } = error;
    if (link.type === 'description') {
        return (
            <a className={curator.linkButton} href="/mockup/publish?state=fixing#fix-heading">
                Review the description: {link.name}
            </a>
        );
    }
    if (link.type === 'restamp') {
        return (
            <a className={curator.linkButton} href={`#${error.rowId}-summary`}>
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
    return (
        <a className={curator.linkButton} href={`#${error.rowId}-summary`}>
            Go to the change: {link.record}
        </a>
    );
}

const TONE: Record<Result['type'], 'done' | 'change' | 'alert'> = {
    blocked: 'alert',
    'blocked-at-publish': 'alert',
    failed: 'alert',
    changed: 'change',
    'someone-published': 'change',
    busy: 'change',
    valid: 'done',
    published: 'done',
    'already-live': 'done',
};

const ICON: Record<'done' | 'change' | 'alert', LucideIcon> = { done: Check, change: RefreshCw, alert: CircleAlert };

const LoadUpdated = () => (
    <p className={styles.resultLinks}>
        <a className={`${curator.linkButton} ${styles.primaryLink}`} href="/mockup/publish">
            Load the updated ledger
        </a>
    </p>
);

const OpenSite = ({ again }: { again?: boolean }) => (
    <p className={styles.resultLinks}>
        <a className={curator.linkButton} href="/mockup/publish/site" target="_blank" rel="noopener noreferrer">
            Open the site
            <span className={curator.visuallyHidden}> (opens in a new tab)</span>
            <ExternalLink size={14} aria-hidden="true" />
        </a>
        {again ? (
            <a className={curator.linkButton} href="/mockup/publish?state=nothing-to-publish">
                Load the working catalog again
            </a>
        ) : null}
    </p>
);

function resultBody(result: Result): { heading: string; body: ReactNode } {
    switch (result.type) {
        case 'blocked':
        case 'blocked-at-publish':
            return {
                heading: result.type === 'blocked' ? 'Publication blocked' : 'Nothing was published',
                body: (
                    <>
                        <p>{result.lead}</p>
                        <ol className={styles.errors}>
                            {result.errors.map((error) => (
                                <li key={error.rowId}>
                                    <strong>
                                        {error.record} · {error.field}
                                    </strong>
                                    <span>{error.message}</span>
                                    <span className={styles.errorActions}>
                                        <BlockerLinks error={error} />
                                    </span>
                                </li>
                            ))}
                        </ol>
                    </>
                ),
            };
        case 'valid':
            return {
                heading: 'Catalog revision is valid',
                body: (
                    <>
                        <p>All references resolve. The previous public revision remains live.</p>
                        <p>{result.stakes}</p>
                    </>
                ),
            };
        case 'published':
            return {
                heading: `Revision ${result.number} published atomically`,
                body: (
                    <>
                        <p>Visitor APIs now revalidate against the new catalog ETag.</p>
                        <OpenSite again />
                    </>
                ),
            };
        case 'already-live':
            return {
                heading: `Revision ${result.number} is already live`,
                body: (
                    <>
                        <p>{result.by} Nothing more to publish, and nothing new was written.</p>
                        <OpenSite />
                    </>
                ),
            };
        case 'changed':
            return {
                heading: 'The working catalog changed',
                body: (
                    <>
                        <p>{result.body}</p>
                        <LoadUpdated />
                    </>
                ),
            };
        case 'someone-published':
            return {
                heading: `Revision ${result.number} went live from the command line`,
                body: (
                    <>
                        <p>{result.by} Nothing was published from here.</p>
                        <LoadUpdated />
                    </>
                ),
            };
        case 'busy':
            return { heading: 'Another publish or rollback is running', body: <p>{result.body}</p> };
        case 'failed':
            return { heading: result.heading, body: <p>{result.body}</p> };
    }
}

/** The one result slot, above the bar: every answer to Validate or Publish, its heading the focus target. */
function ResultSlot({ result }: { result?: Result }) {
    if (!result) return null;
    const tone = TONE[result.type];
    const Icon = ICON[tone];
    const { heading, body } = resultBody(result);
    return (
        <section className={`${curator.notice} ${styles.result}`} data-tone={tone} aria-labelledby="result-heading">
            <h2 id="result-heading" tabIndex={-1} className={styles.resultHeading}>
                <Icon size={18} aria-hidden="true" />
                {heading}
            </h2>
            {body}
        </section>
    );
}

function ActionButton({ state, label, pendingLabel, icon: Icon, primary = false, describedBy }: { state: ActionState; label: string; pendingLabel: string; icon: LucideIcon; primary?: boolean; describedBy?: string }) {
    if (state === 'hidden') return null;
    const pending = state === 'pending';
    return (
        <button
            type="button"
            className={primary ? `${curator.button} ${curator.primary}` : curator.button}
            aria-disabled={state === 'available' ? undefined : true}
            aria-describedby={describedBy}
            data-off={state === 'unavailable' ? 'true' : undefined}
            data-pending={pending ? 'true' : undefined}
        >
            <Icon size={16} aria-hidden="true" />
            {pending ? pendingLabel : label}
        </button>
    );
}

/** The sticky bar: one form whose submits are Validate and Publish (formAction in the build; inert here). */
function ActionBar({ model }: { model: ScreenModel }) {
    if (model.validate === 'hidden' && model.publish === 'hidden') return null;
    const busy = model.validate === 'pending' || model.publish === 'pending';
    const n = model.draftNumber;
    return (
        <form className={styles.actions} aria-busy={busy ? true : undefined}>
            {model.confirm ? (
                <div className={`${curator.notice} ${styles.confirm}`} data-tone="change" role="group" aria-labelledby="confirm-heading">
                    <p id="confirm-heading" className={styles.confirmHeading}>
                        Publish revision {n} now?
                    </p>
                    <p>Visitors get it at once, on every page. Revision 18 stays rollback-ready.</p>
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
                <ActionButton state={model.validate} label="Validate revision" pendingLabel="Validating…" icon={FileCheck2} />
                <ActionButton
                    state={model.publish}
                    label={`Publish revision ${n}`}
                    pendingLabel={`Publishing revision ${n}…`}
                    icon={UploadCloud}
                    primary
                    describedBy={model.publishReason && model.publish !== 'available' ? 'publish-reason' : undefined}
                />
            </div>
            {model.publishReason ? (
                <p id="publish-reason" className={styles.reason}>
                    {model.publishReason}
                </p>
            ) : null}
        </form>
    );
}

function PreviewPanel({ model }: { model: ScreenModel }) {
    const { panel } = model;
    if (!panel) return null;
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
            {panel.frameNote ? (
                <p className={styles.frameNote}>{panel.frameNote}</p>
            ) : (
                <PreviewFrame src={panel.src} height="22rem" focusable={false} marker={panel.marker} title={panel.frameTitle} embedded />
            )}
            <div className={styles.panelText}>
                <p className={styles.panelCount}>{panel.count}</p>
                <p className={styles.panelCopy}>{panel.copyLine}</p>
            </div>
            {panel.rollback ? (
                <footer className={styles.panelFooter}>
                    <Undo2 size={15} aria-hidden="true" />
                    <span>{withCode(panel.rollback)}</span>
                </footer>
            ) : null}
        </section>
    );
}

/** The screen's one live region: always rendered, visually hidden, a direct child of main. */
const LiveRegion = ({ text }: { text?: string }) => (
    <p role="status" className={curator.visuallyHidden}>
        {text ?? ''}
    </p>
);

export default function PublishScreen({ model }: { model: ScreenModel }) {
    if (model.page) {
        return (
            <div className={curator.page}>
                <CuratorHeader active="publish" publishHref="/curation/publish" />
                <main className={curator.state}>
                    <LiveRegion text={model.status} />
                    <h1>{model.page.heading}</h1>
                    <p>{model.page.body}</p>
                    {model.page.code ? (
                        <p>
                            <code className={styles.command}>{model.page.code}</code>
                        </p>
                    ) : null}
                    <p>
                        <a className={curator.linkButton} href="/curation/publish">
                            {model.page.action}
                        </a>
                    </p>
                </main>
            </div>
        );
    }
    const { ledger } = model;
    const labels = model.compareLabels;
    const live = model.groups === 'live';
    return (
        <div className={curator.page}>
            <CuratorHeader active="publish" publishHref="/curation/publish" />
            <main className={styles.body} data-layout={ledger ? 'columns' : 'column'}>
                <LiveRegion text={model.status} />
                <header className={styles.heading}>
                    <div>
                        <h1>{model.heading}</h1>
                        {model.lead ? <p className={styles.lead}>{model.lead}</p> : null}
                        {model.countLine ? <p className={styles.countLine}>{model.countLine}</p> : null}
                        {model.inboxLink ? (
                            <p className={styles.inboxLink}>
                                <a className={curator.linkButton} href="/curation/inbox">
                                    Open the Inbox
                                </a>
                            </p>
                        ) : null}
                    </div>
                    {model.revision ? (
                        <p className={styles.revisions}>
                            <span>{model.revision.current}</span>
                            <span>{model.revision.hashes}</span>
                        </p>
                    ) : null}
                </header>
                <div className={styles.layout} data-ledger={ledger ? 'yes' : 'no'}>
                    <PreviewPanel model={model} />
                    {ledger ? (
                        <section className={styles.ledger} aria-labelledby="ledger-heading" data-out-of-date={model.outOfDate ? 'true' : undefined}>
                            <h2 id="ledger-heading">{model.ledgerHeading}</h2>
                            {model.outOfDate ? <p className={styles.outOfDate}>{model.outOfDate}</p> : null}
                            <Group heading={live ? 'Authored' : 'Authored · requires judgment'} rows={ledger.authored} tone="authored" labels={labels} />
                            <Group heading={live ? 'Derived' : 'Derived · recalculated automatically'} rows={ledger.derived} tone="derived" labels={labels} />
                            <Group heading="Source health" rows={ledger.health} tone="health" labels={labels} />
                            <ResultSlot result={model.result} />
                            <ActionBar model={model} />
                        </section>
                    ) : null}
                </div>
            </main>
        </div>
    );
}
