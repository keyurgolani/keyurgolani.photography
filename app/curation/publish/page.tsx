import type { Metadata } from 'next';
import CuratorHeader from '../CuratorHeader';
import styles from '../curator.module.css';
import { requireCurator } from '@/lib/curation/auth';
import { publishAction } from './actions';
import { loadPublishPage } from './load';
import PublishScreen from './PublishScreen';
import publish from './publish.module.css';

/**
 * `/curation/publish` (#16's 16-3), the approved Gallery After Hours Publish
 * screen: what the next publish changes for visitors, checked by Validate
 * and published by the same publish() the CLI runs. It reads per request,
 * behind requireCurator(), and writes nothing; its forms post to
 * ./actions.ts. Curator responses are never stored (next.config.mjs).
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Preview & publish', robots: { index: false, follow: false } };

interface PublishPageProps {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const ROW_ID_RE = /^chg-[0-9a-f]{16}$/;

export default async function PublishPage({ searchParams }: PublishPageProps) {
    await requireCurator({ read: true });
    const params = await searchParams;
    const fix = typeof params.fix === 'string' && ROW_ID_RE.test(params.fix) ? params.fix : null;
    const page = await loadPublishPage();
    return (
        <div className={styles.page}>
            <CuratorHeader active="publish" publishHref="/curation/publish" />
            {page.state === 'ready' ? (
                <PublishScreen view={page.view} previewHref={page.previewHref} openFix={fix} action={publishAction} />
            ) : page.state === 'not-launched' ? (
                <main className={styles.state}>
                    <p role="status" className={styles.visuallyHidden} />
                    <h1>Nothing is live yet</h1>
                    <p>The first publish replaces the legacy Home and Gallery, and it runs from the command line, where it prints what changes and asks you to confirm the launch.</p>
                    <p>
                        <code className={publish.command}>photos publish --confirm-launch</code>
                    </p>
                    <p>
                        <a className={styles.linkButton} href="/curation/publish">
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
                        <a className={styles.linkButton} href="/curation/publish">
                            Try again
                        </a>
                    </p>
                </main>
            )}
        </div>
    );
}
