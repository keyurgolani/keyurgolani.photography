import { requireCurator } from '@/lib/curation/auth';
import { previewDraftId, previewMediaAccess } from '@/lib/catalog/preview-reader';
import { createMediaHandler } from '@/lib/media/handler';

/**
 * #10's `/media` handler, mirrored inside the draft preview (#16), so every
 * image the preview shows, draft-only or not, loads here and never through
 * the public `/media` route or `/_next/image`. A set the draft holds is
 * served `private, no-store`, to this request only; anything else (a set
 * the draft doesn't hold, an unknown or changed draft) is the handler's 404.
 * The public route stays as it was: no session check and no draft lookup.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Context {
    params: Promise<{ draftId: string; photoId: string; assetRevision: string; profileId: string; variant: string }>;
}

/** The draft each request asked for, so the one handler (and its manifest cache) serves every draft. */
const drafts = new WeakMap<Request, string>();

const handler = createMediaHandler({
    access: (ref, request) => {
        const draftId = drafts.get(request);
        return draftId === undefined ? 'deny' : previewMediaAccess(draftId)(ref, request);
    },
});

export async function GET(request: Request, context: Context): Promise<Response> {
    await requireCurator({ read: true });
    const draftId = previewDraftId((await context.params).draftId);
    if (draftId === null) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    drafts.set(request, draftId);
    return handler(request, context);
}
