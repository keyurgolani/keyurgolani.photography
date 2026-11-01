'use client';

import { useRouter } from 'next/navigation';
import { lazy, startTransition, Suspense, useRef, useState } from 'react';
import QuietBoundary from '@/components/QuietBoundary';
import StaticSiteNav from '@/components/site/StaticSiteNav';
import StatusPage from '@/components/site/StatusPage';
import { ERROR_HEADING, errorCopy, useOnline } from '@/components/site/onlineStatus';
import { useStoredChoice } from '@/components/site/useStoredChoice';

// The full nav loads when the page shows, not with every route: an error boundary's module is in every route's first
// load, and with SiteNav and its theme menu in it, each route shipped another copy of them (perf5: Home, Work and
// About past the JS budget). Until it lands, and for good if its chunk can't load (offline, a redeploy), the page
// shows StaticSiteNav: the same links at the same height, with no theme menu, so nothing jumps and Home is a link
// away. The page renders on the client (Next's error shell), so nothing here is lost without JavaScript.
/** React's lazy keeps a rejection for good, so each attempt at the nav gets a lazy, and an import(), of its own. */
const navAttempt = (attempt: number) => ({ attempt, Nav: lazy(() => import('@/components/site/SiteNav')) });

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
  const [nav, setNav] = useState(() => navAttempt(0));
  const navFailed = useRef(false);
  // reset() alone only clears client state, so refresh refetches the server part in the same transition. A nav that
  // failed to load is tried again too.
  const tryAgain = () => {
    if (navFailed.current) {
      navFailed.current = false;
      setNav((current) => navAttempt(current.attempt + 1));
    }
    startTransition(() => {
      router.refresh();
      reset();
    });
  };
  return (
    <>
      <QuietBoundary key={nav.attempt} fallback={<StaticSiteNav />} onFailed={() => (navFailed.current = true)}>
        <Suspense fallback={<StaticSiteNav />}>
          <nav.Nav />
        </Suspense>
      </QuietBoundary>
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
