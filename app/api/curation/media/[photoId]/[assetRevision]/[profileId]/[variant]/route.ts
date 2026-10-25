import { requireCurator } from '@/lib/curation/auth';
import { createMediaHandler, type MediaRouteContext } from '@/lib/media/handler';

/**
 * The inbox's photograph previews: one file of a derivative set, the same
 * way `/media` serves it, but to the curator only and never cached
 * (`private, no-store`). The set needn't be published, which is the point: a
 * new photograph is reviewed before any revision holds it. requireCurator()
 * runs first, so on `web`, where the flag is never on, and for any request
 * the boundary refuses, this is a 404. No public page links here, and the
 * non-disclosure e2e (e2e/curation-inbox.spec.ts) checks that.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const serve = createMediaHandler({ access: () => 'private' });

export async function GET(request: Request, context: MediaRouteContext): Promise<Response> {
    await requireCurator({ read: true });
    return serve(request, context);
}
