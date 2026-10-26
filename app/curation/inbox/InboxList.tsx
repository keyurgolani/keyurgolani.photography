import { ImageOff, RefreshCw } from 'lucide-react';
import styles from '../curator.module.css';
import EmptyArrival from './EmptyArrival';
import EventBadge from './EventBadge';
import ReturnToRow from './ReturnToRow';
import { summaryText, type InboxItem, type InboxView, type ItemGroup } from '@/lib/curation/inbox-view';

type ReadyView = Extract<InboxView, { state: 'ready' }>;

const GROUP_HEADINGS: Record<Exclude<ItemGroup, 'judgment'>, string> = {
    unplaced: 'No longer placed',
    waiting: 'Waiting',
    deferred: 'Left for later',
    placed: 'Already placed',
    settled: 'Settled',
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** 56 CSS px square, so a row is the same height whether its thumbnail has loaded, is still loading, or has none. */
const THUMB = 56;

/**
 * The row's thumbnail: the ready set's w400 WebP from the curator-only
 * route, never the original, loaded only as the row nears the screen. Its
 * alt is empty, since the file name beside it names the photograph. With no
 * ready set, a neutral square holds its place.
 */
function Thumbnail({ url }: { url: string | null }) {
    if (url === null) {
        return (
            <span className={styles.thumb} data-thumb="none" aria-hidden="true">
                <ImageOff size={18} />
            </span>
        );
    }
    return <img className={styles.thumb} src={url} alt="" width={THUMB} height={THUMB} loading="lazy" decoding="async" />;
}

function ItemLink({ item, selected }: { item: InboxItem; selected: boolean }) {
    return (
        <li>
            {/* `#item` lands on the item itself: on a phone it's all the page shows, and a keyboard starts in its form. */}
            <a className={styles.item} id={`row-${item.id}`} data-row={item.id} href={`/curation/inbox?item=${item.id}#item`} aria-current={selected ? 'true' : undefined}>
                <Thumbnail url={item.thumbnailUrl} />
                <span className={styles.itemText}>
                    <EventBadge type={item.type} settled={item.group === 'settled'} />
                    <strong>{item.title}</strong>
                    <span className={styles.itemMeta}>
                        <span className={styles.itemFile}>{item.sourcePath}</span>
                        <small>{item.shortId}</small>
                    </span>
                    {item.waiting ? <span className={styles.waitingNote}>Waiting: {item.waiting}</span> : null}
                    {item.placedBy ? <span className={styles.waitingNote}>Already placed</span> : null}
                </span>
            </a>
        </li>
    );
}

/**
 * The list side of the Inbox: the summary, Refresh, and every item by group,
 * those that need judgment first. `listView` is a visit to the list itself
 * (no item in the URL), which is what a phone shows then.
 */
export default function InboxList({ view, listView = false }: { view: ReadyView; listView?: boolean }) {
    const selectedId = view.selected?.id ?? null;
    const judgment = view.items.filter((item) => item.group === 'judgment');
    const others = (['unplaced', 'waiting', 'deferred', 'placed', 'settled'] as const).map((group) => ({ group, items: view.items.filter((item) => item.group === group) }));
    return (
        <section className={styles.list} id="inbox-list" aria-labelledby="inbox-heading">
            <ReturnToRow listView={listView} />
            <header className={styles.listHeader}>
                <div>
                    <h1 id="inbox-heading">Curation inbox</h1>
                    <p>{summaryText(view)}</p>
                </div>
                {/* A plain GET of the page: it reads the inbox again and changes nothing. It keeps an open item open; the list view
                    opens none, so a phone stays on the list (a wide screen's plain URL selects the same first item again). */}
                <form method="get" action="/curation/inbox">
                    {selectedId && !listView ? <input type="hidden" name="item" value={selectedId} /> : null}
                    <button type="submit" className={styles.refresh} aria-label="Refresh inbox">
                        <RefreshCw size={17} aria-hidden="true" />
                    </button>
                </form>
            </header>
            {/* The last decision's answer, when it left nothing else to decide. It opens the list itself, so only the list view takes it. */}
            {listView ? <EmptyArrival empty={view.needsJudgment === 0} /> : null}
            {view.items.length === 0 && view.problems.length === 0 ? (
                <div className={styles.empty}>
                    <h2 id="inbox-empty" tabIndex={-1}>
                        Nothing requires judgment
                    </h2>
                    <p>Add photographs to the library folder. The watcher picks them up, and each one shows up here as a draft suggestion. Nothing publishes from the inbox.</p>
                </div>
            ) : null}
            {judgment.length > 0 ? (
                <ul className={styles.items} aria-label="Requires judgment">
                    {judgment.map((item) => (
                        <ItemLink key={item.id} item={item} selected={item.id === selectedId} />
                    ))}
                </ul>
            ) : view.items.length > 0 ? (
                <p className={styles.empty} id="inbox-empty" tabIndex={-1}>
                    Nothing requires judgment right now.
                </p>
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
            {view.placementUnknown ? (
                <p className={styles.empty} role="status">
                    The inbox can&apos;t tell which new photographs are placed, since a revision or series can&apos;t be read, so every item counts by its stored status.
                </p>
            ) : null}
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
