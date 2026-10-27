import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import CuratorHeader from '@/app/curation/CuratorHeader';
import styles from '@/app/curation/curator.module.css';
import PublishScreen from '@/app/curation/publish/PublishScreen';
import publish from '@/app/curation/publish/publish.module.css';
import { mockPublishAction } from './actions';
import { STATES, STATE_ORDER } from './fixtures';
import HistorySection from './HistorySection';

/**
 * `/mockup/publish-history?state=<name>`: the 15-4 design-gate mockup. It
 * renders 16-3's real PublishScreen on a fixture view, with the History
 * section in its new slot, and the real page's two whole-page states. Lives
 * on `wip/lead/15-4-mockup` only, outside the curator paths so it needs no
 * session, and is never merged.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Publish history mockup', robots: { index: false, follow: false } };

interface MockupProps {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PublishHistoryMockup({ searchParams }: MockupProps) {
    const params = await searchParams;
    const name = typeof params.state === 'string' ? params.state : STATE_ORDER[0];
    const state = STATES[name];
    if (!state) notFound();
    return (
        <div className={styles.page}>
            <CuratorHeader active="publish" publishHref="/curation/publish" />
            {state.screen === 'ready' && state.view && state.history ? (
                <PublishScreen view={state.view} previewHref="/mockup/publish-history/site" openFix={null} action={mockPublishAction} history={<HistorySection model={state.history} />} />
            ) : state.screen === 'not-launched' ? (
                <main className={styles.state}>
                    <p role="status" className={styles.visuallyHidden} />
                    <h1>Nothing is live yet</h1>
                    <p>The first publish replaces the legacy Home and Gallery, and it runs from the command line, where it prints what changes and asks you to confirm the launch. History starts with that first publish.</p>
                    <p>
                        <code className={publish.command}>photos publish --confirm-launch</code>
                    </p>
                    <p>
                        <a className={styles.linkButton} href="/mockup/publish-history?state=empty">
                            Check again
                        </a>
                    </p>
                </main>
            ) : (
                <main className={styles.state}>
                    <p role="status" className={styles.visuallyHidden} />
                    <h1>The catalog can&apos;t be read right now</h1>
                    <p>Something in the data root couldn&apos;t be read, so nothing is shown and nothing was written. The server log names what failed.</p>
                    <p>
                        <a className={styles.linkButton} href="/mockup/publish-history?state=unreadable">
                            Try again
                        </a>
                    </p>
                </main>
            )}
        </div>
    );
}
