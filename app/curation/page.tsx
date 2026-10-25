import type { Metadata } from 'next';
import StatusPage from '@/components/site/StatusPage';
import { requireCurator } from '@/lib/curation/auth';

/**
 * A placeholder for the curator, so the access boundary has a page to guard
 * and test. #14's 14-3 replaces it with the inbox. It reads nothing from the
 * data root.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Curation', robots: { index: false, follow: false } };

export default async function CurationPage() {
  await requireCurator({ read: true });
  return (
    <StatusPage
      heading="Curation"
      actions={
        <form method="post" action="/api/curation/logout">
          <button type="submit">Sign out</button>
        </form>
      }
    >
      The curator is on, and you&apos;re signed in. The inbox isn&apos;t built yet.
    </StatusPage>
  );
}
