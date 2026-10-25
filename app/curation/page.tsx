import type { Metadata } from 'next';
import Link from 'next/link';
import SameOriginPostForm from '@/components/site/SameOriginPostForm';
import StatusPage from '@/components/site/StatusPage';
import { requireCurator } from '@/lib/curation/auth';

/**
 * Where the login sends a signed-in curator: a way into the Inbox, and Sign
 * out. It reads nothing from the data root.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Curation', robots: { index: false, follow: false } };

export default async function CurationPage() {
  await requireCurator({ read: true });
  return (
    <StatusPage
      heading="Curation"
      actions={
        <>
          <Link href="/curation/inbox">Open the inbox</Link>
          <SameOriginPostForm action="/api/curation/logout" submitLabel="Sign out" />
        </>
      }
    >
      The curator is on, and you&apos;re signed in.
    </StatusPage>
  );
}
