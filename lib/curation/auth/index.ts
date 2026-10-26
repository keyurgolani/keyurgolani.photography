import 'server-only';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { evaluateCuratorRequest, loginRedirectPath, type CuratorDenial } from './policy';
import { readCuratorSecrets } from './secrets';
import { deleteSession, sessionFromCookies } from './sessions';

/** What a curator page, route handler or server action learns once requireCurator() lets it run. */
export interface CuratorAccess {
    /** The allowed `Host` the request came in on. */
    host: string;
}

async function check(options: { read?: boolean }, session: 'required' | 'not-checked'): Promise<{ access: CuratorAccess } | { denial: CuratorDenial; mutation: boolean }> {
    const request = await headers();
    const host = request.get('host');
    const mutation = options.read !== true || request.has('next-action');
    const denial = evaluateCuratorRequest(
        {
            host,
            origin: request.get('origin'),
            forwardedHost: request.get('x-forwarded-host'),
            mutation,
            session: session === 'required' ? { cookie: request.get('cookie') } : 'not-checked',
        },
        process.env,
        process.argv,
    );
    if (denial !== null || host === null) return { denial: denial ?? { status: 421, reason: 'host' }, mutation };
    return { access: { host: host.toLowerCase() } };
}

/**
 * The one gate every curator page, route handler and server action calls
 * first, before it reads or writes anything. It runs the same checks as
 * proxy.ts (lib/curation/auth/policy.ts), in this order: the flag; the bind,
 * the tunnel port setting and the secret files; the `Host` allowlist; for a
 * mutation, the `Origin`; and then a live curator session from the
 * `curator_session` cookie. A server action is always a mutation, even one
 * posted straight to `/` without the proxy's help.
 *
 * Mutation is the default, so a caller that forgets to say gets the
 * stricter check. A page or a GET handler passes `{ read: true }`; a request
 * carrying `Next-Action` is still checked as a mutation.
 *
 * A read without a session redirects to the login page (with `?ended=1` if
 * it sent a session cookie that no longer counts). Every other refusal
 * calls notFound(), so nothing after it runs. proxy.ts has already answered
 * any request it saw with the precise status: 404, 503, 421, 403, or 401 for
 * a handler, an action or an RSC request without a session.
 */
export async function requireCurator(options: { read?: boolean } = {}): Promise<CuratorAccess> {
    const result = await check(options, 'required');
    if ('access' in result) return result.access;
    if (result.denial.reason === 'session' && !result.mutation) redirect(loginRedirectPath((await headers()).get('cookie')));
    notFound();
}

/**
 * The login page's and its form's gate, and nothing else's: every check
 * requireCurator() makes but the session. The route inventory allows it
 * only in `app/curation/login/page.tsx` and `app/api/curation/login/route.ts`.
 */
export async function requireCuratorLogin(options: { read?: boolean } = {}): Promise<CuratorAccess> {
    const result = await check(options, 'not-checked');
    if ('access' in result) return result.access;
    notFound();
}

/** Whether this request carries a live curator session. For the login page, which sends a signed-in curator on. */
export async function hasCuratorSession(): Promise<boolean> {
    const secrets = readCuratorSecrets(process.env);
    if ('problem' in secrets) return false;
    return sessionFromCookies((await headers()).get('cookie'), secrets.secrets.sessionKey) !== null;
}

/** Ends the session this request carries, if it's live. For logout, after requireCurator(). */
export async function endCuratorSession(): Promise<void> {
    const secrets = readCuratorSecrets(process.env);
    if ('problem' in secrets) return;
    const id = sessionFromCookies((await headers()).get('cookie'), secrets.secrets.sessionKey);
    if (id !== null) deleteSession(id);
}
