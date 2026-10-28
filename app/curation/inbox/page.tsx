import type { Metadata } from 'next';
import CuratorHeader from '../CuratorHeader';
import styles from '../curator.module.css';
import InboxDetailView from './InboxDetailView';
import InboxList from './InboxList';
import { requireCurator } from '@/lib/curation/auth';
import { loadInbox } from '@/lib/curation/inbox';
import type { InboxView } from '@/lib/curation/inbox-view';

/**
 * `/curation/inbox` (#14's 14-3), the approved Gallery After Hours Inbox:
 * the items that need judgment, the ones waiting on the watcher, and the
 * selected item in full, with its suggestion, its source facts, and 14-1's
 * actions. It reads per request, behind requireCurator(), and writes nothing;
 * the forms post to ./actions.ts.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Curation inbox', robots: { index: false, follow: false } };

interface InboxPageProps {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InboxPage({ searchParams }: InboxPageProps) {
    await requireCurator({ read: true });
    const params = await searchParams;
    const item = typeof params.item === 'string' ? params.item : null;
    let view: InboxView | 'failed';
    try {
        view = await loadInbox(item);
    } catch (error) {
        // A read error can name a host path, so the page says only that it failed. The server log keeps the rest.
        console.error('[curation] The inbox could not be read:', error);
        view = 'failed';
    }
    return (
        <div className={styles.page}>
            <CuratorHeader active="inbox" />
            {view === 'failed' ? (
                <main className={styles.state}>
                    <h1>The inbox can&apos;t be read right now</h1>
                    <p>Something in the data root couldn&apos;t be read, so nothing is shown and nothing was written. The server log names what failed.</p>
                    <a className={styles.linkButton} href="/curation/inbox">
                        Try again
                    </a>
                </main>
            ) : view.state === 'not-ready' ? (
                <main className={styles.state}>
                    <h1>The inbox isn&apos;t available</h1>
                    <p>{view.message}</p>
                    <a className={styles.linkButton} href="/curation/inbox">
                        Try again
                    </a>
                </main>
            ) : (
                // A phone shows one side at a time (owner, 2026-10-25): the list, or the item the URL names. A wide screen shows both.
                <main className={styles.body} data-view={item === null ? 'list' : 'item'}>
                    <InboxList view={view} listView={item === null} />
                    <InboxDetailView view={view} />
                </main>
            )}
        </div>
    );
}
