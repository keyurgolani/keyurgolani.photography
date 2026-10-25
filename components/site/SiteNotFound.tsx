'use client';

import Link from 'next/link';
import SiteNav from '@/components/site/SiteNav';
import StatusPage from '@/components/site/StatusPage';
import { useSiteRoutes } from '@/components/site/siteRoutesContext';

/**
 * #21's not-found content, with "Browse the work" from the site's
 * RouteBuilder, so inside #16's preview it stays under the preview path.
 */
export default function SiteNotFound() {
  const routes = useSiteRoutes();
  return (
    <>
      <SiteNav />
      <StatusPage heading="Page not found" actions={<Link href={routes.workHref()}>Browse the work</Link>}>
        This link may be out of date, or the work it pointed to is no longer published.
      </StatusPage>
    </>
  );
}
