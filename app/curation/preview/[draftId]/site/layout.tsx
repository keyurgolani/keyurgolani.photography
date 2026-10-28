import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import SiteRoutesProvider from '@/components/site/SiteRoutes';
import { requireCurator } from '@/lib/curation/auth';
import { previewBasePath, previewDraftId } from '@/lib/catalog/preview-reader';

/**
 * The draft's visitor site (#16), the one subtree a frame may embed
 * (`frame-ancestors 'self'`). Every href a client component builds comes
 * from the preview's RouteBuilder, so it stays under the preview. It reads
 * nothing: each page checks the draft itself, so a stale draft gets the
 * site's not-found page, which a layout's notFound() would skip. A
 * malformed ID has no preview path to build, so it's the preview's own
 * not-found here.
 */
export const dynamic = 'force-dynamic';

interface PreviewSiteLayoutProps {
  children: ReactNode;
  params: Promise<{ draftId: string }>;
}

export default async function PreviewSiteLayout({ children, params }: PreviewSiteLayoutProps) {
  await requireCurator({ read: true });
  const draftId = previewDraftId((await params).draftId);
  if (draftId === null) notFound();
  return <SiteRoutesProvider basePath={previewBasePath(draftId)}>{children}</SiteRoutesProvider>;
}
