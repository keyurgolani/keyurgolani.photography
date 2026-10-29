import { requireCurator } from '@/lib/curation/auth';
import { previewDraftId } from '@/lib/catalog/preview-reader';
import { createPortraitHandler, PRIVATE_NO_STORE } from '@/lib/siteConfig/portraitVariants';

/**
 * About's portrait inside the draft preview (#16), at
 * `<preview>/site/about/portrait/<token>/<variant>.<format>`, so the
 * preview's About loads it from the curator's own paths: behind a session,
 * and `private, no-store`, as every preview image is. It's the same file
 * and the same variants as the site's `/about/portrait` route.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Context {
    params: Promise<{ draftId: string; token: string; variant: string }>;
}

const handler = createPortraitHandler({ cacheControl: PRIVATE_NO_STORE });

export async function GET(request: Request, context: Context): Promise<Response> {
    await requireCurator({ read: true });
    if (previewDraftId((await context.params).draftId) === null) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    return handler(request, context);
}
