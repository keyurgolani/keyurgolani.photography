import type { Metadata } from 'next';
import PreviewFrame from '@/components/curation/PreviewFrame';
import { requireCurator } from '@/lib/curation/auth';
import { previewBasePath } from '@/lib/catalog/preview-reader';
import { openPreview, previewMetadata } from '../preview';

/**
 * The curator frame for one draft (#16): the preview marker outside the
 * visitor viewport, and the draft's visitor site in a same-origin iframe.
 * Only the site subtree relaxes `frame-ancestors`, so this page can't be
 * framed itself.
 */
export const dynamic = 'force-dynamic';

interface FrameProps {
    params: Promise<{ draftId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
    await requireCurator({ read: true });
    return previewMetadata(null);
}

export default async function PreviewFramePage({ params }: FrameProps) {
    await requireCurator({ read: true });
    const { draftId } = await openPreview((await params).draftId);
    return (
        <main>
            <PreviewFrame src={previewBasePath(draftId)} />
        </main>
    );
}
