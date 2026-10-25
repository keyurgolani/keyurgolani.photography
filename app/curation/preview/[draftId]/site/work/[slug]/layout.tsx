import type { ReactNode } from 'react';
import ViewerHost from '@/components/viewer/ViewerHost';
import { requireCurator } from '@/lib/curation/auth';

/**
 * One series in the draft preview (#16), under #9's ViewerHost like the
 * public one. The preview has no `@modal` slot, so the Viewer always opens
 * as its own page. It reads nothing.
 */
export const dynamic = 'force-dynamic';

export default async function PreviewSeriesLayout({ children }: { children: ReactNode }) {
    await requireCurator({ read: true });
    return <ViewerHost modal={null}>{children}</ViewerHost>;
}
