import type { Metadata } from 'next';
import About from '@/app/about/page';
import { requireCurator } from '@/lib/curation/auth';
import { previewDraftId } from '@/lib/catalog/preview-reader';
import { notFound } from 'next/navigation';
import { previewMetadata } from '../../../preview';

/**
 * About inside the draft preview (#16), so the navigation's About link
 * stays under the preview path. About reads no catalog data, so it's the
 * public page's own content, rendered with the deployed copy.
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
    if (previewDraftId((await params).draftId) === null) notFound();
    return <About />;
}
