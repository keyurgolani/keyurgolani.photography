'use client';

import { useEffect, useRef, useState } from 'react';
import { WifiOff } from 'lucide-react';
import styles from '../curator.module.css';
import WatcherNotice from './WatcherNotice';
import type { InboxWatcher } from '@/lib/curation/inbox-view';
import { createInboxWatch, fetchInboxSummary, inboxNews, ITEM_CHANGED_EVENT, OFFLINE_TEXT, type InboxPageFacts, type InboxWatchAnswer, type InboxWatchState } from '@/lib/curation/inbox-watch';

interface InboxWatchProps {
    /** The watcher as the page loaded it. */
    watcher: InboxWatcher;
    /** How many items needed judgment when the page loaded. */
    needsJudgment: number;
    /** The arrival sequence the page loaded at, which every check sends back as `since` (A8 review, 4a). */
    cursor: number;
    /** The item the page has open, and the version its forms carry, or null. */
    item: { id: string; version: number } | null;
}

/**
 * #14 (A8): the top of the Inbox while the page is open. It holds A2's watcher strip, now kept current by the poll
 * (lib/curation/inbox-watch.ts) of /api/curation/inbox/summary every 60 s; the offline state, when the browser goes
 * offline or the server can't be reached; and the one polite region that says what changed since the page loaded,
 * each thing once, with a way to refresh. The strip and the offline state are named regions, not live ones, so
 * nothing is said twice. It never reloads the page, and a session that ended stops it without a word. Its pieces go
 * straight into the page, with no wrapper, so the watcher strip is where it was before A8 (A8's CI, Dark parity).
 */
export default function InboxWatch({ watcher, needsJudgment, cursor, item }: InboxWatchProps) {
    const [current, setCurrent] = useState<InboxWatcher>(watcher);
    const [offline, setOffline] = useState(false);
    const [watchState, setWatchState] = useState<InboxWatchState | null>(null);
    const [line, setLine] = useState<{ text: string; refresh: boolean; serial: number } | null>(null);
    const page = useRef<InboxPageFacts>({ needsJudgment, watcher, item });
    // Arrivals count from the page's own cursor, until the server refuses it and answers its own (4a).
    const since = useRef(cursor);
    // The page's facts as it loaded; a later render with new props is a new load, which keys this component anew.
    useEffect(() => {
        page.current = { needsJudgment, watcher, item };
    }, [needsJudgment, watcher, item]);

    useEffect(() => {
        const announced = new Set<string>();
        let browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
        let serial = 0;
        const hear = (answer: InboxWatchAnswer) => {
            const news = inboxNews(page.current, answer, announced);
            for (const key of news.keys) announced.add(key);
            for (const key of news.forget) announced.delete(key);
            if (news.watcher) {
                page.current = { ...page.current, watcher: news.watcher };
                setCurrent(news.watcher);
            }
            if (answer.kind === 'summary') {
                // A check got through, so whatever said offline was wrong or is over (A8 review S5).
                browserOffline = false;
                setOffline(false);
                if (answer.rebased) since.current = answer.summary.cursor;
            } else if (news.offline) setOffline(true);
            if (news.line) {
                serial += 1;
                setLine({ text: news.line, refresh: news.refresh, serial });
            }
            // With the version the page showed, so the item raises its alert only while it still shows that one (S4).
            if (news.itemChanged && page.current.item) window.dispatchEvent(new CustomEvent(ITEM_CHANGED_EVENT, { detail: { id: page.current.item.id, version: news.changedFrom } }));
        };
        const watch = createInboxWatch({
            check: () => fetchInboxSummary(page.current.item?.id ?? null, since.current),
            onAnswer: hear,
            now: () => Date.now(),
            setTimer: (run, ms) => globalThis.setTimeout(run, ms),
            clearTimer: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
            hidden: () => document.hidden,
            offline: () => browserOffline,
            onState: setWatchState,
        });
        const wake = () => watch.wake();
        const goOffline = () => {
            browserOffline = true;
            hear({ kind: 'offline' });
        };
        const goOnline = () => {
            browserOffline = false;
            watch.resume();
        };
        document.addEventListener('visibilitychange', wake);
        window.addEventListener('focus', wake);
        window.addEventListener('offline', goOffline);
        window.addEventListener('online', goOnline);
        if (browserOffline) hear({ kind: 'offline' });
        watch.start();
        return () => {
            watch.stop();
            document.removeEventListener('visibilitychange', wake);
            window.removeEventListener('focus', wake);
            window.removeEventListener('offline', goOffline);
            window.removeEventListener('online', goOnline);
        };
    }, []);

    return (
        <>
            <WatcherNotice watcher={current} />
            {offline ? (
                <section className={`${styles.notice} ${styles.watcherNotice}`} data-tone="change" data-state="offline" aria-label="Offline" id="inbox-offline">
                    <WifiOff size={18} aria-hidden="true" />
                    <p>{OFFLINE_TEXT}</p>
                </section>
            ) : null}
            {/* The one live region for the poll, there from the start, so what's put in it is read out once. data-watch says
                where the watch is (InboxWatchState), for nothing but tests that run the page's clock. */}
            <div role="status" aria-label="Inbox updates" data-watch={watchState ?? undefined} className={line ? `${styles.notice} ${styles.watcherNotice} ${styles.updates}` : styles.updatesEmpty}>
                {line ? (
                    <p key={line.serial}>
                        {line.text}{' '}
                        {line.refresh ? (
                            <a href={`${window.location.pathname}${window.location.search}`} className={styles.updatesLink}>
                                Refresh the inbox
                            </a>
                        ) : null}
                    </p>
                ) : null}
            </div>
        </>
    );
}
