'use client';

import { useRouter } from 'next/navigation';
import { startTransition } from 'react';
import SiteNav from '@/components/site/SiteNav';
import StatusPage from '@/components/site/StatusPage';
import { ERROR_HEADING, errorCopy, useOnline } from '@/components/site/onlineStatus';

/**
 * #21's error page content, for an error boundary to render: the site
 * navigation, the heading, one sentence, and Try again. It never shows the
 * error's message, digest, or stack. #16's preview renders it inside its
 * visitor site.
 */
export default function SiteError({ reset }: { reset: () => void }) {
  const router = useRouter();
  const online = useOnline();
  // reset() alone only clears client state, so refresh refetches the server part in the same transition.
  const tryAgain = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });
  return (
    <>
      <SiteNav />
      <StatusPage
        heading={ERROR_HEADING}
        actions={
          <button type="button" onClick={tryAgain}>
            Try again
          </button>
        }
      >
        {errorCopy(online)}
      </StatusPage>
    </>
  );
}
