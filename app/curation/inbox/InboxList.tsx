import { ImageOff, RefreshCw } from 'lucide-react';
import styles from '../curator.module.css';
import BulkActions, { type BulkRow } from './BulkActions';
import EmptyArrival from './EmptyArrival';
import EventBadge from './EventBadge';
import ReturnToRow from './ReturnToRow';
import { ageLabel, ANY_QUERY, bulkChoices, inboxQueryString, listPage, rowLabels, STATUS_FILTERS, TYPE_FILTERS, type InboxQuery } from '@/lib/curation/inbox-list';
import { BULK_FORM_ID, fileParts, itemName, summaryText, type InboxItem, type InboxView, type ItemGroup } from '@/lib/curation/inbox-view';

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

/**
 * A row leads with its file's name, which is what tells one photograph from
 * the next; the type's title is the small line under it, beside the folder
 * and the ID's head and tail.
 */
/** A row's link, which keeps the list's filters and page, so a wide screen's list stays as it was beside the item. */
const rowHref = (item: Pick<InboxItem, 'id'>, query: InboxQuery) => `/curation/inbox${inboxQueryString(query, { item: item.id })}#item`;

/**
 * #14 (A8): a row's checkbox for the bulk actions, beside its link, never in it. It sends the row's item and the
 * version the page showed, and it's keyed by both, so a row the refresh after an action moved on starts unchecked.
 * It belongs to the bulk form by its `form` attribute, so the rows stay in the list's own lists, where they were
 * before A8. A row no bulk action can take keeps the column, empty, so the rows stay aligned.
 */
function Pick({ item, label, pickable }: { item: InboxItem; label: string; pickable: boolean }) {
    if (!pickable) return <span className={styles.pickSpacer} aria-hidden="true" />;
    return (
        <label className={styles.pick}>
            <input key={`${item.id}:${item.version}`} className={styles.pickBox} type="checkbox" name="items" form={BULK_FORM_ID} id={`pick-${item.id}`} value={`${item.id}:${item.version}`} />
            <span className={styles.visuallyHidden}>Select {label}</span>
        </label>
    );
}

function ItemLink({ item, selected, query, readAt, pick }: { item: InboxItem; selected: boolean; query: InboxQuery; readAt: string; pick: { label: string; pickable: boolean } | null }) {
    const { folder } = fileParts(item.sourcePath);
    const age = ageLabel(readAt, item.observedAt);
    return (
        <li className={pick ? styles.pickRow : undefined}>
            {pick ? <Pick item={item} {...pick} /> : null}
            {/* `#item` lands on the item itself: on a phone it's all the page shows, and a keyboard starts in its form. */}
            <a className={styles.item} id={`row-${item.id}`} data-row={item.id} href={rowHref(item, query)} aria-current={selected ? 'true' : undefined}>
                <Thumbnail url={item.thumbnailUrl} />
                <span className={styles.itemText}>
                    <EventBadge type={item.type} settled={item.group === 'settled'} />
                    <strong className={styles.itemName}>{itemName(item)}</strong>
                    <span className={styles.itemTitle}>{item.title}</span>
                    <span className={styles.itemMeta}>
                        {folder === null || item.type === 'library-unavailable' ? null : <span className={styles.itemFile}>{folder}/</span>}
                        <small>{item.shortId}</small>
                    </span>
                    {age ? (
                        <span className={styles.itemAge}>
                            <time dateTime={item.observedAt}>{age}</time>
                        </span>
                    ) : null}
                    {item.waiting ? <span className={styles.waitingNote}>Waiting: {item.waiting}</span> : null}
                    {item.placedBy ? <span className={styles.waitingNote}>Already placed</span> : null}
                </span>
            </a>
        </li>
    );
}

/** #14 (A8): the Status and Type filters, a plain GET of the page, so they work before the page hydrates. */
function Filters({ query }: { query: InboxQuery }) {
    const filtered = query.status !== null || query.type !== null;
    return (
        <form className={styles.filters} method="get" action="/curation/inbox" role="search" aria-label="Filter the inbox">
            <div className={styles.filter}>
                <label htmlFor="inbox-filter-status">Status</label>
                <select className={styles.control} id="inbox-filter-status" name="status" defaultValue={query.status ?? ''}>
                    <option value="">Any status</option>
                    {STATUS_FILTERS.map((option) => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
            </div>
            <div className={styles.filter}>
                <label htmlFor="inbox-filter-type">Type</label>
                <select className={styles.control} id="inbox-filter-type" name="type" defaultValue={query.type ?? ''}>
                    <option value="">Any type</option>
                    {TYPE_FILTERS.map((option) => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
            </div>
            <div className={styles.filterActions}>
                <button type="submit" className={styles.button}>
                    Apply filters
                </button>
                {filtered ? (
                    <a className={styles.linkButton} href="/curation/inbox">
                        Clear filters
                    </a>
                ) : null}
            </div>
        </form>
    );
}

/** #14 (A8): Previous and Next page, which keep the filters, and where this page is. Only when there's more than one. */
function Pager({ query, page, pages }: { query: InboxQuery; page: number; pages: number }) {
    if (pages <= 1) return null;
    const at = (n: number) => `/curation/inbox${inboxQueryString({ ...query, page: n })}`;
    return (
        <nav className={styles.pager} aria-label="Inbox pages">
            {page > 1 ? (
                <a className={styles.linkButton} href={at(page - 1)} rel="prev">
                    Previous page
                </a>
            ) : null}
            <span className={styles.pagerAt}>
                Page {page} of {pages}
            </span>
            {page < pages ? (
                <a className={styles.linkButton} href={at(page + 1)} rel="next">
                    Next page
                </a>
            ) : null}
        </nav>
    );
}

/**
 * The list side of the Inbox: the summary, Refresh, and every item by group,
 * those that need judgment first. `listView` is a visit to the list itself
 * (no item in the URL), which is what a phone shows then.
 */
export default function InboxList({ view, listView = false, query = ANY_QUERY }: { view: ReadyView; listView?: boolean; query?: InboxQuery }) {
    const selectedId = view.selected?.id ?? null;
    // #14 (A8): the filters keep some items, 50 to a page, in the list's order, and the groups split what's shown.
    const shown = listPage(view.items, query);
    const listQuery: InboxQuery = { ...query, page: shown.page };
    const filtered = query.status !== null || query.type !== null;
    const labels = rowLabels(shown.items);
    const choices = new Map(shown.items.map((item) => [item.id, bulkChoices(item)]));
    const canDefer = [...choices.values()].some((choice) => choice.defer);
    const canUnassign = [...choices.values()].some((choice) => choice.unassigned);
    const bulk = canDefer || canUnassign;
    const pickOf = (item: InboxItem) => (bulk ? { label: labels.get(item.id) ?? itemName(item), pickable: (choices.get(item.id)?.defer ?? false) || (choices.get(item.id)?.unassigned ?? false) } : null);
    const judgment = shown.items.filter((item) => item.group === 'judgment');
    const others = (['unplaced', 'waiting', 'deferred', 'placed', 'settled'] as const).map((group) => ({ group, items: shown.items.filter((item) => item.group === group) }));
    const empty = view.items.length === 0 && view.problems.length === 0;
    const rows: Record<string, BulkRow> = Object.fromEntries(shown.items.map((item) => [item.id, { label: labels.get(item.id) ?? itemName(item), href: rowHref(item, listQuery) }]));
    const firstPick = shown.items.find((item) => pickOf(item)?.pickable)?.id ?? null;
    const range = shown.total === 0 ? null : shown.pages > 1 ? `Showing ${shown.from} to ${shown.to} of ${shown.total} items` : filtered ? `${shown.total} ${shown.total === 1 ? 'item matches' : 'items match'} these filters` : null;
    const link = (item: InboxItem) => <ItemLink key={item.id} item={item} selected={item.id === selectedId} query={listQuery} readAt={view.readAt} pick={pickOf(item)} />;
    const groups = (
        <>
            {judgment.length > 0 ? (
                <ul className={styles.items} aria-label="Requires judgment">
                    {judgment.map(link)}
                </ul>
            ) : view.items.length > 0 && !filtered ? (
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
                            {items.map(link)}
                        </ul>
                    </div>
                ))}
        </>
    );
    return (
        // tabIndex 0: on a wide screen the list scrolls on its own (#145), so a keyboard can reach it to scroll it.
        <section className={styles.list} id="inbox-list" aria-labelledby="inbox-heading" tabIndex={0}>
            <ReturnToRow listView={listView} />
            <header className={styles.listHeader}>
                <div>
                    <h1 id="inbox-heading">Curation inbox</h1>
                    {/* An empty inbox says it once, in the empty state below. */}
                    {empty ? null : <p>{summaryText(view)}</p>}
                </div>
                {/* A plain GET of the page: it reads the inbox again and changes nothing. It keeps an open item open; the list view
                    opens none, so a phone stays on the list (a wide screen's plain URL selects the same first item again). */}
                <form method="get" action="/curation/inbox">
                    {/* #14 (A8): the filters and the page stay as they are. */}
                    {listQuery.status ? <input type="hidden" name="status" value={listQuery.status} /> : null}
                    {listQuery.type ? <input type="hidden" name="type" value={listQuery.type} /> : null}
                    {listQuery.page > 1 ? <input type="hidden" name="page" value={listQuery.page} /> : null}
                    {selectedId && !listView ? <input type="hidden" name="item" value={selectedId} /> : null}
                    <button type="submit" className={styles.refresh} aria-label="Refresh inbox">
                        <RefreshCw size={17} aria-hidden="true" />
                    </button>
                </form>
            </header>
            {/* The last decision's answer, when it left nothing else to decide. It opens the list itself, so only the list view takes it. */}
            {listView ? <EmptyArrival empty={view.needsJudgment === 0} /> : null}
            {empty ? null : <Filters query={query} />}
            {range ? <p className={styles.range}>{range}</p> : null}
            {filtered && shown.total === 0 && view.items.length > 0 ? (
                <p className={styles.empty} id="inbox-empty" tabIndex={-1}>
                    No item matches these filters.
                </p>
            ) : null}
            {empty ? (
                <div className={styles.empty}>
                    <h2 id="inbox-empty" tabIndex={-1}>
                        Nothing requires judgment
                    </h2>
                    <p>Add photographs to the library folder. The watcher picks them up, and each one shows up here as a draft suggestion. Nothing publishes from the inbox.</p>
                </div>
            ) : null}
            {/* The bulk form above the rows, which stay where they were before A8: each checkbox names the form (A8's CI). */}
            {bulk ? <BulkActions base={view.activeRevisionId} rows={rows} canDefer={canDefer} canUnassign={canUnassign} firstPick={firstPick === null ? null : `pick-${firstPick}`} /> : null}
            {groups}
            <Pager query={listQuery} page={shown.page} pages={shown.pages} />
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
