import type { Metadata } from 'next';
import SiteNotFound from '@/components/site/SiteNotFound';

/**
 * A page the draft doesn't hold (#16): a malformed, unknown, draft or
 * hidden series, a photo outside it, or a draft that's no longer current.
 * #21's not-found content, linking inside the preview only.
 */
export const metadata: Metadata = {
  title: { absolute: 'Preview · Page not found' },
  robots: { index: false, follow: false },
  openGraph: null,
  twitter: null,
  alternates: null,
};

export default function PreviewSiteNotFound() {
  return <SiteNotFound />;
}
