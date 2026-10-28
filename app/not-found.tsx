import type { Metadata } from 'next';
import Link from 'next/link';
import SiteNav from '@/components/site/SiteNav';
import StatusPage from '@/components/site/StatusPage';
import { NAV_ITEMS } from '@/components/site/nav';
import { SITE_NAME } from '@/lib/site/metadata';

const work = NAV_ITEMS.find((item) => item.section === 'work');

// Absolute, not through the root template: under a layout with a parallel slot (the Viewer's @modal, #9),
// Next resolves the not-found metadata once per slot, and the second pass drops the template.
export const metadata: Metadata = { title: { absolute: `Page not found · ${SITE_NAME}` } };

export default function NotFound() {
  return (
    <>
      <SiteNav />
      <StatusPage heading="Page not found" actions={<Link href={work?.href ?? '/'}>Browse the work</Link>}>
        This link may be out of date, or the work it pointed to is no longer published.
      </StatusPage>
    </>
  );
}
