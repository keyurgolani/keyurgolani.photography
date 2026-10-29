import type { Metadata } from 'next';
import AboutPage from '@/app/about/AboutPage';
import { requireCurator } from '@/lib/curation/auth';
import { previewBasePath, previewDraftId } from '@/lib/catalog/preview-reader';
import { notFound } from 'next/navigation';
import { previewMetadata } from '../../../preview';

/**
 * About inside the draft preview (#16), so the navigation's About link
 * stays under the preview path. About reads no catalog data, so it's the
 * public page's own content, rendered with the deployed copy. Its portrait
 * loads from the preview's own copy of the portrait route, under the same
 * path, so the curator serves it to a session only and never caches it.
 */
export const dynamic = 'force-dynamic';

interface PreviewPageProps {
    params: Promise<{ draftId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
    await requireCurator({ read: true });
    return previewMetadata('About');
}

export default async function PreviewAbout({ params }: PreviewPageProps) {
    await requireCurator({ read: true });
    const draftId = previewDraftId((await params).draftId);
    if (draftId === null) notFound();
    return <AboutPage portraitBasePath={previewBasePath(draftId)} />;
}
