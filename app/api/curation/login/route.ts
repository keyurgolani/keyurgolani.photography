import { isPlainLanRequest, requireCuratorLogin } from '@/lib/curation/auth';
import { attemptLogin } from '@/lib/curation/auth/login';
import { readCuratorSecrets } from '@/lib/curation/auth/secrets';
import { curatorUnavailable } from '@/lib/curation/auth/unavailable';
import { deleteSession, sessionCookie, sessionFromCookies } from '@/lib/curation/auth/sessions';

/**
 * The login form's POST (#14's 14-2). requireCuratorLogin() runs first: the
 * flag, the bind and secrets, the `Host`, and the `Origin`, which a form
 * post from the login page always carries. Then the passphrase goes to
 * lib/curation/auth/login.ts, which counts failures and holds the lock.
 *
 * A match starts a new session, ends the one the request carried if any (so
 * the session ID changes at every login), and sends the curator to
 * `/curation` with the cookie, `Secure` but on a LAN-mode name over plain
 * http (isPlainLanRequest()). Anything else, a wrong passphrase or the
 * lock, gets the same answer: back to the login page with `failed=1`, no
 * cookie. The page itself says when the lock is on, and then says only that.
 */
export const dynamic = 'force-dynamic';

/** Far more than a 1024-byte passphrase needs, form-encoded. */
const MAX_BODY_BYTES = 16 * 1024;

const FAILED = '/curation/login?failed=1';

function seeOther(location: string, cookie?: string): Response {
    const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
    if (cookie) headers.set('Set-Cookie', cookie);
    return new Response(null, { status: 303, headers });
}

async function passphraseFrom(request: Request): Promise<string> {
    const length = Number(request.headers.get('content-length'));
    if (!Number.isFinite(length) || length <= 0 || length > MAX_BODY_BYTES) return '';
    try {
        const value = (await request.formData()).get('passphrase');
        return typeof value === 'string' ? value : '';
    } catch {
        return '';
    }
}

export async function POST(request: Request): Promise<Response> {
    await requireCuratorLogin();
    const secrets = readCuratorSecrets(process.env);
    if ('problem' in secrets) return curatorUnavailable();
    const { passphrase: hash, sessionKey } = secrets.secrets;
    const outcome = await attemptLogin(await passphraseFrom(request), hash);
    if (!outcome.ok) return seeOther(FAILED);
    const previous = sessionFromCookies(request.headers.get('cookie'), sessionKey);
    if (previous !== null) deleteSession(previous);
    return seeOther('/curation', sessionCookie(outcome.sessionId, sessionKey, { secure: !(await isPlainLanRequest()) }));
}
