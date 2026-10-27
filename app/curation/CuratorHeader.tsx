import Link from 'next/link';
import { FileCheck2, Inbox } from 'lucide-react';
import SameOriginPostForm from '@/components/site/SameOriginPostForm';
import styles from './curator.module.css';

export type CuratorScreen = 'inbox' | 'publish';

interface CuratorHeaderProps {
    active: CuratorScreen;
    /** Where "Preview & publish" leads. #16 sets it once its screen exists; until then the item shows but leads nowhere. */
    publishHref?: string;
}

/**
 * The curator's header, from the approved Gallery After Hours mockup
 * (`CuratorHeader`): "Portfolio curation" back to the site, the Inbox and
 * "Preview & publish" screens, and where the data lives, plus 14-2b's Sign
 * out. #14's Inbox renders
 * it first, and #16's Publish screen reuses it with `active="publish"`.
 */
export default function CuratorHeader({ active, publishHref }: CuratorHeaderProps) {
    return (
        <header className={styles.header}>
            <Link href="/" className={styles.wordmark}>
                <span className={styles.monogram} aria-hidden="true">
                    KG
                </span>
                Portfolio curation
            </Link>
            <nav aria-label="Curation" className={styles.screens}>
                <Link href="/curation/inbox" className={styles.screen} aria-current={active === 'inbox' ? 'page' : undefined}>
                    <Inbox size={16} aria-hidden="true" />
                    Inbox
                </Link>
                {publishHref ? (
                    <Link href={publishHref} className={styles.screen} aria-current={active === 'publish' ? 'page' : undefined}>
                        <FileCheck2 size={16} aria-hidden="true" />
                        Preview &amp; publish
                    </Link>
                ) : (
                    <span className={`${styles.screen} ${styles.screenPending}`} aria-disabled="true" title="Comes with the publish screen">
                        <FileCheck2 size={16} aria-hidden="true" />
                        Preview &amp; publish
                    </span>
                )}
            </nav>
            <div className={styles.headerEnd}>
                <span className={styles.volume}>Local self-hosted volume</span>
                <SameOriginPostForm action="/api/curation/logout" submitLabel="Sign out" buttonClassName={styles.signOut} />
            </div>
        </header>
    );
}
