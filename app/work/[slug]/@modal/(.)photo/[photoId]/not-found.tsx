import type { Metadata } from 'next';
import ViewerUnavailable from '@/components/viewer/ViewerUnavailable';
import { UNAVAILABLE_HEADING } from '@/components/viewer/viewerLabels';
import { SITE_NAME } from '@/lib/site/metadata';

// Only a soft navigation reaches the intercepted route (#9), so only a visitor already in the Viewer sees this: a move,
// or the revision check's refresh, onto a photograph a publish unpublished or moved (#178). A direct load of the same
// URL is the photo page's, whose not-found stays the site's own page, with no Viewer surface (viewer.spec.ts).
export const metadata: Metadata = { title: { absolute: `${UNAVAILABLE_HEADING} · ${SITE_NAME}` } };

/** The Viewer's unavailable state, in the shell that outlives every move. The status is still 404. */
export default function ViewerPhotoNotFound() {
    return <ViewerUnavailable />;
}
