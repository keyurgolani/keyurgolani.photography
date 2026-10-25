import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireCurator } from '@/lib/curation/auth';
import { currentDraftId, previewFrameHref } from '@/lib/catalog/preview-reader';
import { PreviewUnavailableError, previewMetadata } from './preview';

/**
 * `/curation/preview`: on to the preview of the working catalog as it
 * compiles now (#16), the one a not-found preview links back to.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    await requireCurator({ read: true });
    return previewMetadata(null);
}

export default async function CurrentPreview() {
    await requireCurator({ read: true });
    const draftId = await currentDraftId();
    if (draftId === null) throw new PreviewUnavailableError('draft-unreadable');
    redirect(previewFrameHref(draftId));
}
