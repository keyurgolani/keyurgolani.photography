import 'server-only';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { evaluateCuratorRequest } from './policy';

/** What a curator page, route handler or server action learns once requireCurator() lets it run. */
export interface CuratorAccess {
    /** The allowed `Host` the request came in on. */
    host: string;
}

/**
 * The one gate every curator page, route handler and server action calls
 * first, before it reads or writes anything. It runs the same checks as
 * proxy.ts (lib/curation/auth/policy.ts): the flag, the bind, the `Host`
 * allowlist, and for a mutation the `Origin`. A server action is always a
 * mutation, even one posted straight to `/` without the proxy's help.
 *
 * Mutation is the default, so a caller that forgets to say gets the
 * stricter check. A page or a GET handler passes `{ read: true }`; a request
 * carrying `Next-Action` is still checked as a mutation.
 *
 * On a refusal it calls notFound(), so nothing after it runs, and the caller
 * sees a 404 whatever the reason. proxy.ts has already answered with the
 * precise status for any request it saw.
 *
 * The passphrase and session layer is held for the owner (docs/curator.md).
 * When it lands, its check goes here, after the request checks, and nowhere
 * else.
 */
export async function requireCurator(options: { read?: boolean } = {}): Promise<CuratorAccess> {
    const request = await headers();
    const host = request.get('host');
    const denial = evaluateCuratorRequest(
        {
            host,
            origin: request.get('origin'),
            forwardedHost: request.get('x-forwarded-host'),
            mutation: options.read !== true || request.has('next-action'),
        },
        process.env,
        process.argv,
    );
    if (denial !== null || host === null) {
        notFound();
    }
    return { host: host.toLowerCase() };
}
