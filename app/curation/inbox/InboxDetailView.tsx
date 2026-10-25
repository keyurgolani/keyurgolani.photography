import { Check } from 'lucide-react';
import styles from '../curator.module.css';
import EventBadge from './EventBadge';
import ItemActions from './ItemActions';
import { STATUS_LABELS, SYSTEM_RESPONSE, type InboxDetail, type InboxView } from '@/lib/curation/inbox-view';

type ReadyView = Extract<InboxView, { state: 'ready' }>;

function Facts({ rows }: { rows: { label: string; value: string }[] }) {
    return (
        <dl className={styles.facts}>
            {rows.map((row) => (
                <div key={row.label}>
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                </div>
            ))}
        </dl>
    );
}

function referencesText(references: string[] | null): string {
    if (references === null) return "Can't tell: a revision or working-layer file can't be read.";
    return references.length === 0 ? 'None' : references.join(', ');
}

/** What the watcher saw, kept apart from anything the curator decides. */
function SourceFacts({ detail, activeRevisionId }: { detail: InboxDetail; activeRevisionId: string | null }) {
    const rows = [
        { label: 'Source file', value: detail.sourcePath },
        ...(detail.fromPath ? [{ label: 'Moved from', value: detail.fromPath }] : []),
        { label: 'Identity status', value: detail.identity },
        { label: 'Derivatives', value: detail.derivatives },
        ...detail.facts,
        ...(detail.failure ? [{ label: 'Failure', value: detail.failure }] : []),
        ...(detail.candidates.length > 0 ? [{ label: 'Candidates', value: detail.candidates.join(', ') }] : []),
        { label: 'Published references', value: referencesText(detail.references) },
        { label: 'Active revision', value: activeRevisionId ?? 'None yet' },
        { label: 'Observed', value: detail.lastObservedAt !== detail.observedAt ? `${detail.observedAt}, last ${detail.lastObservedAt}` : detail.observedAt },
        ...(detail.reviewedAt ? [{ label: 'Reviewed', value: `${detail.reviewedAt} by ${detail.reviewedBy ?? 'unknown'}` }] : []),
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

function TypeBox({ detail }: { detail: InboxDetail }) {
    if (detail.type === 'replacement') {
        return (
            <section className={styles.box} aria-labelledby="type-box">
                <h3 className={styles.boxTitle} id="type-box">
                    Identity-preserving replacement
                </h3>
                <Facts
                    rows={[
                        { label: 'Series membership', value: referencesText(detail.references) },
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

/** The detail side of the Inbox: the photograph, its identity, what the system did, the suggestion, and the actions. */
export default function InboxDetailView({ view }: { view: ReadyView }) {
    const detail = view.selected;
    if (detail === null) {
        return (
            <section className={styles.state} aria-label="Item">
                {view.missingSelection ? (
                    <p role="status">That item isn&apos;t in the inbox any more. Pick another from the list.</p>
                ) : (
                    <p>{view.items.length === 0 ? 'When the watcher finds a new photograph, its suggestion shows here.' : 'Pick an item from the list to review it.'}</p>
                )}
            </section>
        );
    }
    return (
        <section className={styles.detail} aria-labelledby="item-heading">
            <div className={styles.photo}>
                {detail.previewUrl ? (
                    // A private, uncached preview of one derivative, so next/image's optimizer and its cache stay out of it.
                    <img src={detail.previewUrl} alt={`Candidate photograph ${detail.shortId}`} width={800} decoding="async" />
                ) : (
                    <p className={styles.noPreview}>{detail.photoId === null ? 'No photograph: nothing was made from this file.' : 'No preview yet: no derivative set is ready.'}</p>
                )}
                <EventBadge type={detail.type} />
            </div>
            <div className={styles.fields}>
                <header className={styles.fieldsHeader}>
                    <div>
                        <span>Stable photo identity</span>
                        <h2 id="item-heading">{detail.photoId ?? 'No photo ID yet'}</h2>
                    </div>
                    <span className={styles.status} data-approved={detail.status === 'approved' ? 'true' : undefined}>
                        {STATUS_LABELS[detail.status]}
                    </span>
                </header>
                <Facts
                    rows={[
                        { label: 'Asset revision', value: detail.assetRevision ?? 'None' },
                        { label: 'System response', value: SYSTEM_RESPONSE[detail.type] },
                        ...(detail.waiting ? [{ label: 'Waiting', value: `${detail.waiting[0].toUpperCase()}${detail.waiting.slice(1)}. Act on it once the set is ready.` }] : []),
                    ]}
                />
                <TypeBox detail={detail} />
                <ItemActions
                    key={detail.id}
                    detail={detail}
                    activeRevisionId={view.activeRevisionId}
                    series={view.series}
                    seriesProblem={view.seriesProblem}
                    note={
                        <div className={styles.lock}>
                            <Check size={17} aria-hidden="true" />
                            <p>
                                <strong>Published statement remains unchanged.</strong>
                                Automatic analysis can draft a revision, but it cannot edit the public series or its order.
                            </p>
                        </div>
                    }
                />
                <SourceFacts detail={detail} activeRevisionId={view.activeRevisionId} />
                {detail.decisions.length > 0 ? (
                    <details className={styles.more}>
                        <summary>History ({detail.decisions.length})</summary>
                        <ol className={styles.history}>
                            {detail.decisions.map((decision, index) => (
                                <li key={index}>
                                    {decision.at} {decision.action} by {decision.by}
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
