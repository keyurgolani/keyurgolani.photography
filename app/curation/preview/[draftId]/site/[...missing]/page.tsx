import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireCurator } from '@/lib/curation/auth';
import { previewMetadata } from '../../../preview';

/**
 * Any path under a draft's site that no route matches (#16), such as
 * `.../site/gallery`. Without it Next renders the root not-found page, with
 * the public nav and share metadata, inside the curator frame. So the
 * session is checked first, as on every preview route, and then it's the
 * site's not-found page, with the preview's links and metadata. It reads
 * nothing, so it says nothing about the draft: the site layout has already
 * sent a malformed ID to the preview's own not-found page.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    await requireCurator({ read: true });
    return previewMetadata(null);
}

export default async function PreviewSiteMissing(): Promise<never> {
    await requireCurator({ read: true });
    notFound();
}
