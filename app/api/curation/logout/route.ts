import { endCuratorSession, requireCurator } from '@/lib/curation/auth';
import { SIGNED_OUT_PAGE } from '@/lib/curation/auth/policy';
import { clearedSessionCookie } from '@/lib/curation/auth/sessions';

/**
 * Logout (#14's 14-2): a POST with the `Origin` and a live session, like any
 * other curator mutation. It deletes the session from the store, so the
 * cookie it was in stops working at once, even replayed, clears the cookie
 * in the browser, and sends it to the login page with `?signed-out=1`, which
 * says so.
 */
export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
    await requireCurator();
    await endCuratorSession();
    return new Response(null, {
        status: 303,
        headers: { Location: SIGNED_OUT_PAGE, 'Cache-Control': 'no-store', 'Set-Cookie': clearedSessionCookie() },
    });
}
