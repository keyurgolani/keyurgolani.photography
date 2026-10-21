import Link from 'next/link';
import SiteNav from '@/components/site/SiteNav';
import StatusPage from '@/components/site/StatusPage';
import { NAV_ITEMS } from '@/components/site/nav';

const work = NAV_ITEMS.find((item) => item.section === 'work');

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
