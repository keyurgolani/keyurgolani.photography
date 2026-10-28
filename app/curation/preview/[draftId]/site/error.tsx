'use client';

import SiteError from '@/components/site/SiteError';

/** A preview page couldn't read the draft (#16): #21's error page, inside the preview's visitor site. */
export default function PreviewSiteError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <SiteError reset={reset} />;
}
