import type { ReactNode } from 'react';
import { ArrowLeft, Check } from 'lucide-react';
import styles from '../curator.module.css';
import ArrivalStrip from './ArrivalStrip';
import EventBadge from './EventBadge';
import ItemActions from './ItemActions';
import LandOnItem from './LandOnItem';
import {
    failureNotice,
    fileParts,
    hasPublishedStatement,
    humanTime,
    identityLine,
    referencedByText,
    seriesMembershipText,
    seriesName,
    statusLabel,
    systemResponse,
    type InboxDetail,
    type InboxView,
} from '@/lib/curation/inbox-view';

type ReadyView = Extract<InboxView, { state: 'ready' }>;

interface FactRow {
    label: string;
    value: ReactNode;
    /** An ID or a hash, set in the mono face and shortened in the middle to fit. */
    mono?: boolean;
    /** A date the value says in words, as `<time>` takes it. */
    dateTime?: string;
}

/**
 * An ID or a hash in full, shortened in the middle when the cell is too
 * narrow: the head gives way to an ellipsis and the last four characters
 * stay. The text is the whole value, so selecting and copying it takes all of
 * it, and its title shows it whole.
 */
function MiddleEllipsis({ value }: { value: string }) {
    const tail = value.length > 12 ? value.slice(-4) : '';
    return (
        <span className={styles.middle} title={value}>
            <span>{value.slice(0, value.length - tail.length)}</span>
            {tail ? <span>{tail}</span> : null}
        </span>
    );
}

/** A stored timestamp in the Inbox's words, with the stored value in `dateTime` and as its title. */
function When({ at }: { at: string }) {
    return (
        <time dateTime={at} title={at}>
            {humanTime(at)}
        </time>
    );
}

function Facts({ rows }: { rows: FactRow[] }) {
    return (
        <dl className={styles.facts}>
            {rows.map((row) => (
                <div key={row.label}>
                    <dt>{row.label}</dt>
                    <dd className={row.mono ? styles.mono : undefined}>
                        {row.mono && typeof row.value === 'string' ? <MiddleEllipsis value={row.value} /> : row.dateTime ? <time dateTime={row.dateTime}>{row.value}</time> : row.value}
                    </dd>
                </div>
            ))}
        </dl>
    );
}

/**
 * What the watcher saw, kept apart from anything the curator decides. The
 * photo ID and the asset revision show once, at the top of the item, and a
 * processing failure's reason in the strip there.
 */
function SourceFacts({ view, detail }: { view: ReadyView; detail: InboxDetail }) {
    const rows: FactRow[] = [
        { label: 'Source file', value: detail.sourcePath },
        ...(detail.fromPath ? [{ label: 'Moved from', value: detail.fromPath }] : []),
        { label: 'Identity status', value: detail.identity },
        { label: 'Derivatives', value: detail.derivatives },
        ...detail.facts,
        ...(detail.candidates.length > 0 ? [{ label: 'Candidates', value: detail.candidates.join(', ') }] : []),
        { label: 'Referenced by', value: referencedByText(detail.references, view.series) },
        { label: 'Active revision', value: view.activeRevisionId ?? 'None yet', mono: view.activeRevisionId !== null },
        {
            label: 'Observed',
            value:
                detail.lastObservedAt !== detail.observedAt ? (
                    <>
                        <When at={detail.observedAt} />, last <When at={detail.lastObservedAt} />
                    </>
                ) : (
                    <When at={detail.observedAt} />
                ),
        },
        ...(detail.reviewedAt
            ? [
                  {
                      label: 'Reviewed',
                      value: (
                          <>
                              <When at={detail.reviewedAt} /> by {detail.reviewedBy ?? 'unknown'}
                          </>
                      ),
                  },
              ]
            : []),
    ];
    return (
        <section className={styles.box} aria-labelledby="source-facts">
            <h3 className={styles.boxTitle} id="source-facts">
                Source facts
            </h3>
            <Facts rows={rows} />
        </section>
    );
}

function TypeBox({ view, detail }: { view: ReadyView; detail: InboxDetail }) {
    if (detail.type === 'replacement') {
        return (
            <section className={styles.box} aria-labelledby="type-box">
                <h3 className={styles.boxTitle} id="type-box">
                    Identity-preserving replacement
                </h3>
                <Facts
                    rows={[
                        { label: 'Series membership', value: seriesMembershipText(detail.photoId, detail.references, view.series) },
                        { label: 'Authored fields', value: `Title, description, and story stay attached to ${detail.shortId}` },
                        { label: 'Switch policy', value: 'Use the new bytes only after all derivatives succeed' },
                    ]}
                />
            </section>
        );
    }
    if (detail.type === 'missing') {
        return (
            <section className={styles.box} aria-labelledby="type-box">
                <h3 className={styles.boxTitle} id="type-box">
                    Published output protected
                </h3>
                <p>The source binding is unresolved. The current catalog and its derivatives keep serving while you choose how to recover it.</p>
                <ul className={styles.history}>
                    <li>Locate or restore source file</li>
                    <li>Bind an intentional replacement</li>
                    <li>Archive after removing series references</li>
                </ul>
            </section>
        );
    }
    if (detail.type === 'ambiguous') {
        return (
            <section className={styles.box} aria-labelledby="type-box">
                <h3 className={styles.boxTitle} id="type-box">
                    Identity question
                </h3>
                <p>
                    Bind it to one of the candidates with <code>photos identity bind</code>, or make it a new photograph with <code>photos identity new</code>. The next
                    watcher pass updates this item.
                </p>
            </section>
        );
    }
    return null;
}

const sentence = (text: string) => `${text[0].toUpperCase()}${text.slice(1)}`;

/**
 * A phone's way back from the one item it shows to the whole list, landing
 * on the row it came from (`#row-<id>`, which ReturnToRow takes). A wide
 * screen shows the list beside the item, so it hides this.
 */
function BackToInbox({ itemId }: { itemId: string | null }) {
    return (
        <a className={styles.backToList} href={itemId ? `/curation/inbox#row-${itemId}` : '/curation/inbox'}>
            <ArrowLeft size={16} aria-hidden="true" />
            Back to inbox
        </a>
    );
}

/**
 * The detail side of the Inbox: what identifies the photograph first (the
 * photograph, its file name, folder and capture date), then its short IDs,
 * what the system did, the suggestion, and the actions. Every full ID and
 * hash sits in Source facts below.
 */
export default function InboxDetailView({ view }: { view: ReadyView }) {
    const detail = view.selected;
    if (detail === null) {
        // Nothing needs judgment, so nothing is selected: the list says so once. Once items are listed, a wide screen's detail side keeps one quiet line pointing at them; a phone shows the list alone then.
        if (view.needsJudgment === 0 && !view.missingSelection) {
            // An empty inbox: the list says so, once, and this side stays empty (walkthrough, 018ec79a).
            if (view.items.length === 0) return null;
            return (
                <section className={`${styles.state} ${styles.emptyPane}`} aria-label="Item">
                    <p>Nothing left to decide. Pick an item from the list to look at it again.</p>
                </section>
            );
        }
        return (
            <section className={styles.state} aria-label="Item">
                {view.missingSelection ? <BackToInbox itemId={null} /> : null}
                {view.missingSelection ? <p role="status">That item isn&apos;t in the inbox any more. Pick another from the list.</p> : <p>Pick an item from the list to review it.</p>}
            </section>
        );
    }
    const labelOf = (seriesId: string) => seriesName(view.series, seriesId);
    const file = fileParts(detail.sourcePath);
    const status = statusLabel(detail);
    const failure = failureNotice(detail);
    return (
        // `id="item"` is where every row's link lands; a phone shows only this then.
        <section className={styles.detail} id="item" aria-labelledby="item-heading">
            <LandOnItem targetId="item" focusId="item-heading" />
            <BackToInbox itemId={detail.id} />
            {/* What the last approval or Decide later did, above the photograph and the form, when it opened this item. */}
            <ArrivalStrip key={detail.id} itemId={detail.id} />
            <div className={styles.photo}>
                {/* Sticky on a wide screen, so the photograph stays in view while the curator describes it. */}
                <div className={styles.photoFrame}>
                    <EventBadge type={detail.type} />
                    {detail.previewUrl ? (
                        // A private, uncached preview of one derivative, so next/image's optimizer and its cache stay out of it.
                        <img src={detail.previewUrl} alt={`Candidate photograph ${file.name}`} width={800} decoding="async" />
                    ) : (
                        <p className={styles.noPreview}>{detail.photoId === null ? 'No photograph: nothing was made from this file.' : 'No preview yet: no derivative set is ready.'}</p>
                    )}
                </div>
            </div>
            <div className={styles.fields}>
                <header className={styles.fieldsHeader}>
                    <div>
                        {/* tabIndex -1: LandOnItem focuses it when a row or the next item opens, and it stays out of the tab order. */}
                        <h2 id="item-heading" tabIndex={-1}>
                            {file.name}
                        </h2>
                        <p className={styles.identityLine}>{identityLine(detail.sourcePath, detail.capturedDate)}</p>
                    </div>
                    <span className={styles.status} data-tone={status.tone ?? undefined}>
                        {status.text}
                    </span>
                </header>
                {/* A processing failure says why, and what to do, on the first screen, in the refusal tone. */}
                {failure ? (
                    <div className={`${styles.notice} ${styles.failure}`} data-tone="alert" data-state="failure">
                        <p>
                            <strong>{failure.reason}</strong>
                        </p>
                        {failure.next ? <p>{failure.next}</p> : null}
                    </div>
                ) : null}
                <Facts
                    rows={[
                        // Each in full, once, shortened in the middle to fit.
                        { label: 'Stable photo identity', value: detail.photoId ?? detail.shortId, mono: detail.photoId !== null },
                        { label: 'Asset revision', value: detail.assetRevision ?? 'None', mono: detail.assetRevision !== null },
                        { label: 'System response', value: systemResponse(detail, labelOf) },
                        ...(detail.waiting ? [{ label: 'Waiting', value: `${sentence(detail.waiting)}. Act on it once the set is ready.` }] : []),
                        // As `curation show` says it, from the same placement lookup.
                        ...(detail.placedBy ? [{ label: 'Already placed', value: `${sentence(detail.placedBy)}, so it needs no judgment while it stays there.` }] : []),
                        ...(detail.unplacedSeries ? [{ label: 'No longer placed', value: `To put it back, reopen it and approve it into ${labelOf(detail.unplacedSeries)}.` }] : []),
                    ]}
                />
                <TypeBox view={view} detail={detail} />
                <ItemActions
                    key={detail.id}
                    detail={detail}
                    order={view.items.map((item) => item.id)}
                    open={view.items.filter((item) => item.group === 'judgment').map((item) => item.id)}
                    activeRevisionId={view.activeRevisionId}
                    series={view.series}
                    seriesProblem={view.seriesProblem}
                    // Only where the photograph has a published statement to keep: the active revision holds it.
                    note={
                        hasPublishedStatement(detail) ? (
                            <div className={styles.lock}>
                                <Check size={17} aria-hidden="true" />
                                <p>
                                    <strong>Published statement remains unchanged.</strong>
                                    Automatic analysis can draft a revision, but it cannot edit the public series or its order.
                                </p>
                            </div>
                        ) : null
                    }
                />
                <SourceFacts view={view} detail={detail} />
                {detail.decisions.length > 0 ? (
                    <details className={styles.more}>
                        <summary>History ({detail.decisions.length})</summary>
                        <ol className={styles.history}>
                            {detail.decisions.map((decision, index) => (
                                <li key={index}>
                                    <When at={decision.at} /> {decision.action} by {decision.by}
                                    {decision.detail ? `: ${decision.detail}` : ''}
                                </li>
                            ))}
                        </ol>
                    </details>
                ) : null}
            </div>
        </section>
    );
}
