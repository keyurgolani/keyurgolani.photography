import fs from 'node:fs';
import path from 'node:path';
import { foldName } from '../../foldName';
import { resolvedPathname } from '../../../utils/publicDerivatives';

/**
 * The curator access boundary (#14's 14-2), as pure checks on a request's
 * method and headers and the process's environment. proxy.ts, the startup
 * check in instrumentation.ts, and requireCurator() all decide through
 * evaluateCuratorRequest(), so there's one rule set and one place a session
 * check joins it.
 *
 * Who may reach the curator: whoever can open the loopback port on the host,
 * which from another machine means an SSH local port forward
 * (`ssh -L 3001:127.0.0.1:3001 <host>`). That tunnel is the authentication.
 * The checks here keep that true: the flag keeps every curator path a 404
 * unless the operator turned it on, the bind rule keeps the listener on
 * loopback, the Host allowlist turns away a DNS-rebound name, and the Origin
 * check turns away a cross-site form or fetch from the owner's own browser.
 * None of them proves who is calling, so none of them may ever widen the
 * listener. The passphrase and session layer is held for the owner
 * (docs/curator.md).
 *
 * Every value is read on each call, never at build time, so one image serves
 * both states and the flag is a restart away.
 */

/** The environment the checks read. `process.env` in the server, a plain object in tests. */
export type CuratorEnv = Readonly<Record<string, string | undefined>>;

/** The port the `curator` compose service publishes on the host's 127.0.0.1. */
export const CURATOR_PORT = 3001;

/** The setting that turns the curator on. Only the exact value `true` does. */
export const CURATION_FLAG = 'CURATION_ENABLED';

/** An optional local port for an SSH tunnel that doesn't use 3001 on the owner's machine. */
export const TUNNEL_PORT_SETTING = 'CURATOR_TUNNEL_PORT';

/** Declares the in-container wildcard bind the compose `curator` service needs. Only the exact value `container` does. */
export const BIND_SCOPE_SETTING = 'CURATION_BIND_SCOPE';

/** The loopback names a curator may be told to listen on. */
const LOOPBACK_BINDS = new Set(['127.0.0.1', '::1', 'localhost']);

/** The wildcard addresses accepted only inside a container whose publish is the boundary. */
const WILDCARD_BINDS = new Set(['0.0.0.0', '::']);

/** Files a container runtime puts in every container: Docker's and Podman's. */
const CONTAINER_MARKERS = ['/.dockerenv', '/run/.containerenv'];

/** Whether the curator is on: `CURATION_ENABLED` is exactly `true`. */
export function isCurationEnabled(env: CuratorEnv): boolean {
    return env[CURATION_FLAG] === 'true';
}

/**
 * The `Host` values a curator request may carry: `127.0.0.1:3001` and
 * `localhost:3001`, and the same two names on `CURATOR_TUNNEL_PORT` when it's
 * set. Returns why there are none when the setting isn't a port number.
 */
export function curatorHosts(env: CuratorEnv): { hosts: ReadonlySet<string> } | { problem: string } {
    const ports = [CURATOR_PORT];
    const setting = env[TUNNEL_PORT_SETTING];
    if (setting !== undefined && setting !== '') {
        if (!/^[1-9][0-9]{0,4}$/.test(setting) || Number(setting) > 65535) {
            return { problem: `${TUNNEL_PORT_SETTING} must be a port number from 1 to 65535` };
        }
        ports.push(Number(setting));
    }
    return { hosts: new Set(ports.flatMap((port) => [`127.0.0.1:${port}`, `localhost:${port}`])) };
}

/** Where the process was told to listen, and how the server reads it. */
export interface ListenTarget {
    /** The address, or null when none was given, which both servers read as every interface. */
    address: string | null;
    /** `--hostname` when the Next CLI runs the server, `HOSTNAME` for the standalone server.js. */
    source: '--hostname' | 'HOSTNAME';
}

/** Whether `argv` is the Next CLI's `next start` or `next dev`, which listen on `--hostname`, never on `HOSTNAME`. */
function isNextCli(argv: readonly string[]): boolean {
    const script = argv[1] ?? '';
    const normalized = script.split(path.sep).join('/');
    return (path.basename(script) === 'next' || normalized.endsWith('/next/dist/bin/next')) && (argv[2] === 'start' || argv[2] === 'dev');
}

/**
 * The address this server listens on: the `--hostname` (or `-H`) argument
 * under the Next CLI, and `HOSTNAME` otherwise, as the standalone server.js
 * reads it. `next dev` hands its argument to a child process this can't see,
 * so there the child reads `HOSTNAME` like server.js, and a curator under
 * `next dev` sets both.
 */
export function listenTarget(env: CuratorEnv, argv: readonly string[]): ListenTarget {
    if (isNextCli(argv)) {
        let address: string | null = null;
        for (let i = 3; i < argv.length; i++) {
            const arg = argv[i];
            if (arg === '--hostname' || arg === '-H') address = argv[i + 1] ?? '';
            else if (arg.startsWith('--hostname=')) address = arg.slice('--hostname='.length);
        }
        return { address: address === '' ? null : address, source: '--hostname' };
    }
    const value = env.HOSTNAME;
    return { address: value === undefined || value === '' ? null : value, source: 'HOSTNAME' };
}

/** Whether the process runs in a container, by the marker files Docker and Podman create. Never a grant by itself. */
export function inContainer(): boolean {
    return CONTAINER_MARKERS.some((marker) => fs.existsSync(/*turbopackIgnore: true*/ marker));
}

/**
 * Why a server with the curator on may not run where it was told to listen,
 * or null when it may. The rule, also in docs/curator.md:
 *
 * - The address must be `127.0.0.1`, `::1` or `localhost`. None at all counts
 *   as non-loopback, since server.js and `next start` then listen on every
 *   interface.
 * - The one exception is the compose `curator` service. Docker's port
 *   forward reaches a container on its network interface, so inside the
 *   container the server listens on `0.0.0.0`, and the publish to the host's
 *   127.0.0.1 is the boundary. That service sets
 *   `CURATION_BIND_SCOPE=container`, which accepts a wildcard address (`0.0.0.0`
 *   or `::`) and nothing else, and only where a container marker file exists.
 *   ci/check-compose.sh checks that the only service with it publishes on
 *   127.0.0.1 alone and shares no network with another service.
 */
export function bindProblem(env: CuratorEnv, argv: readonly string[], containerized: () => boolean = inContainer): string | null {
    const { address, source } = listenTarget(env, argv);
    const scope = env[BIND_SCOPE_SETTING];
    if (scope !== undefined && scope !== '' && scope !== 'container') {
        return `${BIND_SCOPE_SETTING} may only be "container"`;
    }
    if (address !== null && LOOPBACK_BINDS.has(address)) return null;
    if (address !== null && scope === 'container' && WILDCARD_BINDS.has(address)) {
        return containerized() ? null : `${BIND_SCOPE_SETTING}=container is set, but this process isn't in a container`;
    }
    if (address === null) return `${source} is unset, so the server listens on every interface`;
    return `${source} is not 127.0.0.1, ::1 or localhost`;
}

/** Why the curator can't start, or null when it's off or may run. The message names settings, never their values. */
export function curatorStartupProblem(env: CuratorEnv, argv: readonly string[], containerized?: () => boolean): string | null {
    if (!isCurationEnabled(env)) return null;
    const hosts = curatorHosts(env);
    if ('problem' in hosts) return hosts.problem;
    return bindProblem(env, argv, containerized);
}

/** What a curator request carries that the checks read. Header values as sent, or null when missing. */
export interface CuratorRequest {
    host: string | null;
    origin: string | null;
    forwardedHost: string | null;
    /** True for anything that can change state: every method but GET and HEAD, and any server action call. */
    mutation: boolean;
}

/**
 * A refused curator request.
 * - 404 `off`: the flag is off, so curator paths don't exist.
 * - 503 `misconfigured`: the flag is on, but the bind or the tunnel port setting is wrong.
 * - 421 `host`: the `Host` isn't one the curator answers to, as after a DNS rebinding.
 * - 403 `origin`: a mutation without an `Origin` naming the same allowed host, as from another site's form.
 */
export type CuratorDenial =
    | { status: 404; reason: 'off' }
    | { status: 503; reason: 'misconfigured' }
    | { status: 421; reason: 'host' }
    | { status: 403; reason: 'origin' };

/** The host and port of an `Origin` header naming an http origin, or null. `null` and anything with a path count as none. */
function originHost(origin: string): string | null {
    let url: URL;
    try {
        url = new URL(origin);
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' || url.origin !== origin) return null;
    return url.host;
}

/**
 * Whether a curator request may go on, or why not. Checked in this order:
 * the flag, the bind and tunnel settings, the `Host` (and an
 * `X-Forwarded-Host`, which must match it), and for a mutation an `Origin`
 * whose host and port equal `Host`. The session check, when the owner adds
 * one, goes after these, in requireCurator().
 */
export function evaluateCuratorRequest(
    request: CuratorRequest,
    env: CuratorEnv,
    argv: readonly string[],
    containerized?: () => boolean,
): CuratorDenial | null {
    if (!isCurationEnabled(env)) return { status: 404, reason: 'off' };
    const allowed = curatorHosts(env);
    if ('problem' in allowed || bindProblem(env, argv, containerized) !== null) return { status: 503, reason: 'misconfigured' };
    const host = request.host?.toLowerCase() ?? null;
    if (host === null || !allowed.hosts.has(host)) return { status: 421, reason: 'host' };
    if (request.forwardedHost !== null && request.forwardedHost.toLowerCase() !== host) return { status: 421, reason: 'host' };
    if (request.mutation) {
        const fromOrigin = request.origin === null ? null : originHost(request.origin);
        if (fromOrigin === null || fromOrigin !== host) return { status: 403, reason: 'origin' };
    }
    return null;
}

/**
 * Whether a request pathname, as sent, reaches a curator path once decoded
 * and resolved the way utils/publicDerivatives.ts resolves it: `/curation` or
 * `/api/curation`, and anything below either. The first segments are folded
 * and compared by their letters and digits only, and a longer name that
 * starts the same way counts too (`/curation.rsc`, `/Curation`), which
 * denies a few paths no route has, the safe side.
 */
export function isCuratorPath(pathname: string): boolean {
    const [first = '', second = ''] = resolvedPathname(pathname)
        .split('/')
        .slice(1)
        .map((segment) => foldName(segment).replace(/[^a-z0-9]/g, ''));
    if (first.startsWith('curation')) return true;
    return first === 'api' && second.startsWith('curation');
}

/** The headers every curator response sends. `Content-Security-Policy` is its own entry in next.config.mjs, so #16's preview can override it. */
export const CURATOR_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
};

/** The curator's framing policy, sent apart from the other headers. */
export const CURATOR_FRAME_POLICY: Readonly<Record<string, string>> = {
    'Content-Security-Policy': "frame-ancestors 'none'",
};
