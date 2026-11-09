import { CircleAlert } from 'lucide-react';
import styles from '../curator.module.css';
import { LIBRARY_BANNER, type InboxLibrary } from '@/lib/curation/inbox-view';

/**
 * #17: the Inbox's banner while the library item is open: the watcher can't reach the library, so it changes
 * nothing, and the missing items it found since the outage began are held. Built as WatcherNotice is: under the
 * header, above the list and the item, a named region and no live one, in the alert tone, and nothing at all while
 * the library is available. Its lead links to the library item, whose Dismiss releases every held item at once.
 */
export default function LibraryNotice({ library }: { library: InboxLibrary | null }) {
    if (library === null) return null;
    return (
        <section className={`${styles.notice} ${styles.watcherNotice}`} data-tone="alert" data-state="library-unavailable" aria-label="Library" id="library">
            <CircleAlert size={18} aria-hidden="true" />
            <p>
                <a className={styles.updatesLink} href={`/curation/inbox?item=${library.itemId}#item`}>
                    {LIBRARY_BANNER.lead}
                </a>
                {LIBRARY_BANNER.rest(library.cause, library.held)}
            </p>
        </section>
    );
}
