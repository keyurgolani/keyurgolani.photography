import type { Metadata } from 'next';
import Link from 'next/link';
import StatusPage from '@/components/site/StatusPage';

/**
 * A preview that isn't there (#16): a malformed draft ID, or one that isn't
 * the working catalog's current candidate, whether it never was or the
 * catalog changed since. The same page for each, linking only to the
 * current preview, never to the public site.
 */
export const metadata: Metadata = {
    title: 'Preview · Not found',
    robots: { index: false, follow: false },
    openGraph: null,
    twitter: null,
    alternates: null,
};

export default function PreviewNotFound() {
    return (
        <StatusPage heading="Preview not found" actions={<Link href="/curation/preview">Open the current preview</Link>}>
            This preview isn&apos;t the working catalog as it stands. It may have changed since the preview opened.
        </StatusPage>
    );
}
