import { endCuratorSession, requireCurator } from '@/lib/curation/auth';
import { clearedSessionCookie } from '@/lib/curation/auth/sessions';

/**
 * Logout (#14's 14-2): a POST with the `Origin` and a live session, like any
 * other curator mutation. It deletes the session from the store, so the
 * cookie it was in stops working at once, even replayed, and clears the
 * cookie in the browser.
 */
export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
    await requireCurator();
    await endCuratorSession();
    return new Response(null, {
        status: 303,
        headers: { Location: '/curation/login', 'Cache-Control': 'no-store', 'Set-Cookie': clearedSessionCookie() },
    });
}
