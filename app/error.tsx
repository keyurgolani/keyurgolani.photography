'use client';

import { useRouter } from 'next/navigation';
import { startTransition } from 'react';
import SiteNav from '@/components/site/SiteNav';
import StatusPage from '@/components/site/StatusPage';
import { ERROR_HEADING, errorCopy, useOnline } from '@/components/site/onlineStatus';

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/** A route's read failed. It never shows the error's message, digest, or stack. */
export default function ErrorPage({ reset }: ErrorPageProps) {
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
