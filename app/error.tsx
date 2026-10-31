'use client';

import { useRouter } from 'next/navigation';
import { lazy, startTransition, Suspense } from 'react';
import StatusPage from '@/components/site/StatusPage';
import { ERROR_HEADING, errorCopy, useOnline } from '@/components/site/onlineStatus';
import { useStoredChoice } from '@/components/site/useStoredChoice';

// The nav loads when the page shows, not with every route: an error boundary's module is part of every page's first
// load, and SiteNav with its theme menu tripled the JS each route ships (perf5: Home, Work and About past the JS
// budget). The page renders on the client (Next's error shell), so nothing here is lost without JavaScript.
const SiteNav = lazy(() => import('@/components/site/SiteNav'));

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/** A route's read failed. It never shows the error's message, digest, or stack. */
export default function ErrorPage({ reset }: ErrorPageProps) {
  const router = useRouter();
  const online = useOnline();
  // A server render that throws sends Next's error shell, which React renders on the client, so the theme script in
  // the layout never runs (CI run 41145321923: Black, Light and Bright all painted System's Dark here).
  useStoredChoice();
  // reset() alone only clears client state, so refresh refetches the server part in the same transition.
  const tryAgain = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });
  return (
    <>
      <Suspense fallback={null}>
        <SiteNav />
      </Suspense>
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
