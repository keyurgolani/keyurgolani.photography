import { CircleAlert } from 'lucide-react';
import styles from '../curator.module.css';
import LocalTime from './LocalTime';
import { ageText, type InboxWatcher } from '@/lib/curation/inbox-view';

/**
 * #14: the Inbox's warning when the watcher doesn't check in. Its heartbeat
 * is missing, over 5 minutes old, or stamped that far ahead of the server's
 * clock, so new photographs won't reach the Inbox until it runs. It sits
 * under the header, above the list and the item, so a phone sees it on
 * either side. It's in the page from the first byte, so it's no live
 * region; A8's poll can make it one. While the watcher checks in, it
 * renders nothing.
 */
export default function WatcherNotice({ watcher }: { watcher: InboxWatcher }) {
    if (watcher.state === 'running') return null;
    return (
        // A named region, so it's in a landmark like the rest of the page, and a screen reader's region list finds it.
        <section className={`${styles.notice} ${styles.watcherNotice}`} data-tone="alert" data-state={`watcher-${watcher.state}`} aria-label="Watcher">
            <CircleAlert size={18} aria-hidden="true" />
            <p>
                {watcher.state === 'missing' ? (
                    <>The watcher hasn&apos;t checked in, so it may not be running. New photographs won&apos;t appear here until it runs.</>
                ) : watcher.ageMs < 0 ? (
                    <>
                        The watcher&apos;s last check-in, <LocalTime at={watcher.heartbeatAt} />, is ahead of this server&apos;s clock, so the Inbox can&apos;t tell whether it runs. New photographs won&apos;t appear here until it does.
                    </>
                ) : (
                    <>
                        The watcher last checked in {ageText(watcher.ageMs)} ago, at <LocalTime at={watcher.heartbeatAt} />. New photographs won&apos;t appear here until it runs again.
                    </>
                )}
            </p>
        </section>
    );
}
