import { RefreshCw } from 'lucide-react';
import styles from '../curator.module.css';
import EventBadge from './EventBadge';
import { summaryText, type InboxItem, type InboxView, type ItemGroup } from '@/lib/curation/inbox-view';

type ReadyView = Extract<InboxView, { state: 'ready' }>;

const GROUP_HEADINGS: Record<Exclude<ItemGroup, 'judgment'>, string> = {
    waiting: 'Waiting',
    deferred: 'Left in draft',
    settled: 'Settled',
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function ItemLink({ item, selected }: { item: InboxItem; selected: boolean }) {
    return (
        <li>
            <a className={styles.item} href={`/curation/inbox?item=${item.id}`} aria-current={selected ? 'true' : undefined}>
                <EventBadge type={item.type} />
                <strong>{item.title}</strong>
                <small>{item.shortId}</small>
                {item.waiting ? <span className={styles.waitingNote}>Waiting: {item.waiting}</span> : null}
            </a>
        </li>
    );
}

/** The list side of the Inbox: the summary, Refresh, and every item by group, those that need judgment first. */
export default function InboxList({ view }: { view: ReadyView }) {
    const selectedId = view.selected?.id ?? null;
    const judgment = view.items.filter((item) => item.group === 'judgment');
    const others = (['waiting', 'deferred', 'settled'] as const).map((group) => ({ group, items: view.items.filter((item) => item.group === group) }));
    return (
        <section className={styles.list} aria-labelledby="inbox-heading">
            <header className={styles.listHeader}>
                <div>
                    <h1 id="inbox-heading">Curation inbox</h1>
                    <p>{summaryText(view)}</p>
                </div>
                {/* A plain GET of the page: it reads the inbox again and changes nothing. */}
                <form method="get" action="/curation/inbox">
                    {selectedId ? <input type="hidden" name="item" value={selectedId} /> : null}
                    <button type="submit" className={styles.refresh} aria-label="Refresh inbox">
                        <RefreshCw size={17} aria-hidden="true" />
                    </button>
                </form>
            </header>
            {view.items.length === 0 && view.problems.length === 0 ? (
                <div className={styles.empty}>
                    <h2>Nothing requires judgment</h2>
                    <p>New photographs the watcher finds show up here as draft suggestions. Nothing publishes from the inbox.</p>
                </div>
            ) : null}
            {judgment.length > 0 ? (
                <ul className={styles.items} aria-label="Requires judgment">
                    {judgment.map((item) => (
                        <ItemLink key={item.id} item={item} selected={item.id === selectedId} />
                    ))}
                </ul>
            ) : view.items.length > 0 ? (
                <p className={styles.empty}>Nothing requires judgment right now.</p>
            ) : null}
            {others
                .filter(({ items }) => items.length > 0)
                .map(({ group, items }) => (
                    <div key={group}>
                        <h2 className={styles.groupHeading} id={`group-${group}`}>
                            {GROUP_HEADINGS[group]}
                        </h2>
                        <ul className={styles.items} aria-labelledby={`group-${group}`}>
                            {items.map((item) => (
                                <ItemLink key={item.id} item={item} selected={item.id === selectedId} />
                            ))}
                        </ul>
                    </div>
                ))}
            {view.problems.length > 0 ? (
                <div className={styles.empty} role="status">
                    <h2>{plural(view.problems.length, "item can't", "items can't")} be read</h2>
                    <ul className={styles.history}>
                        {view.problems.map((problem) => (
                            <li key={problem.id}>
                                <span className={styles.mono}>{problem.id}</span>: {problem.message}
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </section>
    );
}
