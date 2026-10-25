import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireCurator } from '@/lib/curation/auth';
import { previewMetadata } from '../../preview';

/**
 * Any path beside a draft's frame and site that no route matches (#16),
 * such as `/curation/preview/<draftId>/anything`. Without it Next renders
 * the root not-found page, with the public nav and share metadata. So the
 * session is checked first, as on every preview route, and then it's the
 * preview's own not-found page. It reads nothing, so an existing, an
 * unknown and a malformed draft ID get the same answer.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    await requireCurator({ read: true });
    return previewMetadata(null);
}

export default async function PreviewMissing(): Promise<never> {
    await requireCurator({ read: true });
    notFound();
}
