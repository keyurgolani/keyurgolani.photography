'use client';

import { useEffect, useRef, useState } from 'react';
import { WifiOff } from 'lucide-react';
import styles from '../curator.module.css';
import WatcherNotice from './WatcherNotice';
import type { InboxWatcher } from '@/lib/curation/inbox-view';
import { createInboxWatch, fetchInboxSummary, inboxNews, ITEM_CHANGED_EVENT, type InboxPageFacts, type InboxWatchAnswer } from '@/lib/curation/inbox-watch';

interface InboxWatchProps {
    /** The watcher as the page loaded it. */
    watcher: InboxWatcher;
    /** How many items needed judgment when the page loaded. */
    needsJudgment: number;
    /** The item the page has open, and the version its forms carry, or null. */
    item: { id: string; version: number } | null;
}

/**
 * #14 (A8): the top of the Inbox while the page is open. It holds A2's watcher strip, now kept current by the poll
 * (lib/curation/inbox-watch.ts) of /api/curation/inbox/summary every 60 s; the offline state, when the browser goes
 * offline or the server can't be reached; and the one polite region that says what changed since the page loaded,
 * each thing once, with a way to refresh. The strip and the offline state are named regions, not live ones, so
 * nothing is said twice. It never reloads the page, and a session that ended stops it without a word.
 */
export default function InboxWatch({ watcher, needsJudgment, item }: InboxWatchProps) {
    const [current, setCurrent] = useState<InboxWatcher>(watcher);
    const [offline, setOffline] = useState(false);
    const [line, setLine] = useState<{ text: string; refresh: boolean; serial: number } | null>(null);
    const page = useRef<InboxPageFacts>({ needsJudgment, watcher, item });
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
            if (answer.kind === 'summary') setOffline(false);
            else if (news.offline) setOffline(true);
            if (news.line) {
                serial += 1;
                setLine({ text: news.line, refresh: /Refresh the inbox/.test(news.line), serial });
            }
            if (news.itemChanged && page.current.item) window.dispatchEvent(new CustomEvent(ITEM_CHANGED_EVENT, { detail: { id: page.current.item.id } }));
        };
        const watch = createInboxWatch({
            check: () => fetchInboxSummary(page.current.item?.id ?? null),
            onAnswer: hear,
            now: () => Date.now(),
            setTimer: (run, ms) => globalThis.setTimeout(run, ms),
            clearTimer: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
            hidden: () => document.hidden,
            offline: () => browserOffline,
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
        <div className={styles.inboxTop}>
            <WatcherNotice watcher={current} />
            {offline ? (
                <section className={`${styles.notice} ${styles.watcherNotice}`} data-tone="change" data-state="offline" aria-label="Offline" id="inbox-offline">
                    <WifiOff size={18} aria-hidden="true" />
                    <p>You&apos;re offline, or the server can&apos;t be reached, so the inbox can&apos;t check for changes, and what it shows may be out of date. An action won&apos;t go through until you&apos;re back.</p>
                </section>
            ) : null}
            {/* The one live region for the poll, there from the start, so what's put in it is read out once. */}
            <div role="status" aria-label="Inbox updates" className={line ? `${styles.notice} ${styles.watcherNotice} ${styles.updates}` : styles.updatesEmpty}>
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
        </div>
    );
}
