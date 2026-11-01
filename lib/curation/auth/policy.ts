import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { foldName } from '../../foldName';
import { resolvedPathname } from '../../../utils/publicDerivatives';
import { readCuratorSecrets } from './secrets';
import { sessionCookieValues, sessionFromCookies } from './sessions';

/**
 * The curator access boundary (#14's 14-2), as pure checks on a request's
 * method and headers and the process's environment. proxy.ts, the startup
 * check in instrumentation.ts, and requireCurator() all decide through
 * evaluateCuratorRequest(), so there's one rule set and one place a session
 * check joins it.
 *
 * Who may reach the curator: whoever can open the loopback port on the host,
 * which from another machine means an SSH local port forward
 * (`ssh -L 3001:127.0.0.1:3001 <host>`), and then signs in with the
 * passphrase the owner set at deploy time. The tunnel is the way in; the
 * passphrase session is defense in depth on top of it, which the owner
 * approved on 2026-10-25 ("Allow user to define a login credential at
 * deployment time."). The flag keeps every curator path a 404 unless the
 * operator turned it on, the bind rule keeps the listener on loopback, the
 * Host allowlist turns away a DNS-rebound name, the Origin check turns away
 * a cross-site form or fetch from the owner's own browser, and the session
 * check turns away anyone who hasn't signed in. None of them may ever widen
 * the listener.
 *
 * LAN mode (2026-11-01, the owner's choice, opt-in): with `CURATOR_PUBLISH`
 * set to a private address of the host, compose publishes the curator on
 * that address, and every device on that network can open the login page.
 * The Host allowlist then also answers to `<that address>:<CURATOR_HOST_PORT>`
 * and to the names in `CURATOR_EXTRA_HOSTS`, and the session cookie drops
 * `Secure` for those names over plain http only (plainLanRequest()). The
 * passphrase and the cookie then cross that network unencrypted.
 *
 * There is no rule on the caller's address, in either mode. Next hands
 * proxy.ts and the route handlers no socket peer address, and
 * `X-Forwarded-For` is whatever the caller sent, so a "private peers only"
 * check here would only look like one. What keeps the internet out in LAN
 * mode is outside this code: the publish on the LAN address alone (anything
 * else in `CURATOR_PUBLISH` is a 503 on every path), and no port forward on
 * the router, which docs/curator.md asks of the owner.
 *
 * Every value is read on each call, never at build time, so one image serves
 * both states and the flag is a restart away.
 */

/** The environment the checks read. `process.env` in the server, a plain object in tests. */
export type CuratorEnv = Readonly<Record<string, string | undefined>>;

/** The host port the `curator` compose service publishes on unless `CURATOR_HOST_PORT` says otherwise, and the one its healthcheck names. */
export const CURATOR_PORT = 3001;

/** The setting that turns the curator on. Only the exact value `true` does. */
export const CURATION_FLAG = 'CURATION_ENABLED';

/** An optional local port for an SSH tunnel that doesn't use 3001 on the owner's machine. */
export const TUNNEL_PORT_SETTING = 'CURATOR_TUNNEL_PORT';

/** The host address compose publishes the curator on. Unset or loopback is loopback mode; a private address is LAN mode. */
export const PUBLISH_SETTING = 'CURATOR_PUBLISH';

/** The host port compose publishes the curator on. 3001 when unset. */
export const HOST_PORT_SETTING = 'CURATOR_HOST_PORT';

/** More `name:port` Hosts the curator answers to, comma-separated. Read in LAN mode only. */
export const EXTRA_HOSTS_SETTING = 'CURATOR_EXTRA_HOSTS';

/** Declares the in-container wildcard bind the compose `curator` service needs. Only the exact value `container` does. */
export const BIND_SCOPE_SETTING = 'CURATION_BIND_SCOPE';

/** The loopback names a curator may be told to listen on. */
const LOOPBACK_BINDS = new Set(['127.0.0.1', '::1', 'localhost']);

/** The addresses a listening loopback socket reports. */
const LOOPBACK_SOCKETS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** The wildcard addresses accepted only inside a container whose publish is the boundary. */
const WILDCARD_BINDS = new Set(['0.0.0.0', '::']);

/** Files a container runtime puts in every container: Docker's and Podman's. */
const CONTAINER_MARKERS = ['/.dockerenv', '/run/.containerenv'];

/** Whether the curator is on: `CURATION_ENABLED` is exactly `true`. */
export function isCurationEnabled(env: CuratorEnv): boolean {
    return env[CURATION_FLAG] === 'true';
}

/** The values of CURATOR_PUBLISH that mean loopback mode, today's: the publish on the host's 127.0.0.1. */
const LOOPBACK_PUBLISH = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** The private IPv4 ranges LAN mode takes: RFC 1918, and link-local. */
const PRIVATE_IPV4 = new net.BlockList();
for (const [prefix, bits] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16]] as const) PRIVATE_IPV4.addSubnet(prefix, bits, 'ipv4');

/** The private IPv6 ranges LAN mode takes: unique local (fc00::/7) and link-local (fe80::/10). IPv4 rules stay out of it, so an IPv4-mapped address never matches. */
const PRIVATE_IPV6 = new net.BlockList();
PRIVATE_IPV6.addSubnet('fc00::', 7, 'ipv6');
PRIVATE_IPV6.addSubnet('fe80::', 10, 'ipv6');

/** Where compose publishes the curator, as the checks read it. `host` is the address as it appears in a `Host` header. */
export type CuratorPublish = { mode: 'loopback' } | { mode: 'lan'; host: string };

/** An IPv6 literal in the form a browser sends it in `Host`, brackets and all: lower case, zeros compressed. */
function ipv6Host(address: string): string {
    return new URL(`http://[${address}]`).hostname;
}

/**
 * Which mode `CURATOR_PUBLISH` puts the curator in. Unset, empty,
 * `127.0.0.1`, `localhost` or `::1` is loopback mode, today's. A private
 * address (RFC 1918, 169.254/16, fc00::/7, fe80::/10, IPv6 with or without
 * brackets) is LAN mode. Anything else, `0.0.0.0` and `::` among them, a
 * public address, any hostname, is a problem, so every path answers 503:
 * the curator never runs on a publish it can't vouch for.
 */
export function curatorPublish(env: CuratorEnv): CuratorPublish | { problem: string } {
    const value = env[PUBLISH_SETTING];
    if (value === undefined || value === '' || LOOPBACK_PUBLISH.has(value)) return { mode: 'loopback' };
    const address = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
    if (address === value && net.isIPv4(address) && PRIVATE_IPV4.check(address, 'ipv4')) return { mode: 'lan', host: address };
    if (net.isIPv6(address) && !address.includes('%') && PRIVATE_IPV6.check(address, 'ipv6')) return { mode: 'lan', host: ipv6Host(address) };
    return {
        problem: `${PUBLISH_SETTING} must be unset, 127.0.0.1, localhost or ::1, or a private address of this host on your home network (never 0.0.0.0, ::, a public address or a name)`,
    };
}

/** A port setting's number, the default when it's unset or empty, or null when it isn't a port from 1 to 65535. */
function portSetting(value: string | undefined, fallback: number | null): number | null | 'invalid' {
    if (value === undefined || value === '') return fallback;
    return /^[1-9][0-9]{0,4}$/.test(value) && Number(value) <= 65535 ? Number(value) : 'invalid';
}

/** One DNS label: letters, digits and inner hyphens, 1 to 63 of them. No wildcard. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A `CURATOR_EXTRA_HOSTS` entry as a `Host` value, lower case, or null when it isn't a hostname, an IPv4 address or a bracketed IPv6 address, then `:` and a port. */
function extraHost(entry: string): string | null {
    const match = /^(\[[0-9a-f:.]+\]|[^:[\]]+):([^:]+)$/.exec(entry.toLowerCase());
    if (!match) return null;
    const [, name, portText] = match;
    const port = portSetting(portText, null);
    if (port === null || port === 'invalid') return null;
    if (name.startsWith('[')) {
        const address = name.slice(1, -1);
        return net.isIPv6(address) ? `${ipv6Host(address)}:${port}` : null;
    }
    if (net.isIPv4(name)) return `${name}:${port}`;
    const labels = name.split('.');
    // All digits and dots, and no IPv4 address: a browser would read it as a number, never as this name.
    if (/^[0-9.]+$/.test(name) || name.length > 253 || !labels.every((label) => LABEL.test(label))) return null;
    return `${name}:${port}`;
}

/**
 * The `Host` values a curator request may carry, and which of them are LAN
 * names (`lanHosts`), or why there are none.
 *
 * - Always `127.0.0.1` and `localhost`, on 3001, on `CURATOR_HOST_PORT`, and
 *   on `CURATOR_TUNNEL_PORT` when it's set. With nothing set, that's
 *   `127.0.0.1:3001` and `localhost:3001`, as before LAN mode. The
 *   healthcheck and an SSH tunnel use these in either mode.
 * - In LAN mode, also `<CURATOR_PUBLISH>:<CURATOR_HOST_PORT>` and each
 *   `name:port` in `CURATOR_EXTRA_HOSTS`. Those are the LAN names. The
 *   Origin check compares against `Host`, so it takes the same set.
 *
 * A setting that doesn't parse is a problem, so every path answers 503.
 * Problems name the setting, never its value.
 */
export function curatorHosts(env: CuratorEnv): { hosts: ReadonlySet<string>; lanHosts: ReadonlySet<string> } | { problem: string } {
    const publish = curatorPublish(env);
    if ('problem' in publish) return publish;
    const hostPort = portSetting(env[HOST_PORT_SETTING], CURATOR_PORT);
    if (hostPort === 'invalid' || hostPort === null) return { problem: `${HOST_PORT_SETTING} must be a port number from 1 to 65535` };
    const tunnelPort = portSetting(env[TUNNEL_PORT_SETTING], null);
    if (tunnelPort === 'invalid') return { problem: `${TUNNEL_PORT_SETTING} must be a port number from 1 to 65535` };
    const ports = new Set([CURATOR_PORT, hostPort, ...(tunnelPort === null ? [] : [tunnelPort])]);
    const hosts = new Set([...ports].flatMap((port) => [`127.0.0.1:${port}`, `localhost:${port}`]));
    const lanHosts = new Set<string>();
    if (publish.mode === 'lan') {
        lanHosts.add(`${publish.host}:${hostPort}`);
        const extras = env[EXTRA_HOSTS_SETTING];
        if (extras !== undefined && extras !== '') {
            for (const entry of extras.split(',')) {
                const host = extraHost(entry.trim());
                if (host === null) return { problem: `${EXTRA_HOSTS_SETTING} must be a comma-separated list of name:port entries, such as homelab.local:3001, with no wildcards` };
                lanHosts.add(host);
            }
        }
        for (const host of lanHosts) hosts.add(host);
    }
    return { hosts, lanHosts };
}

/** The first value of an `X-Forwarded-Proto` header, trimmed and in lower case, or '' when there's none. */
function firstForwardedProto(value: string | null | undefined): string {
    return (value ?? '').split(',')[0].trim().toLowerCase();
}

/**
 * A `Host` as the allowlist reads it: in lower case, and, when it carries no
 * port, with the scheme's default port added (443 when the first
 * `X-Forwarded-Proto` is `https`, 80 otherwise) if that makes it a LAN-mode
 * name. A browser leaves the port out on 443, and a TLS proxy there passes
 * that on. Anything else is read as sent, so a loopback name and loopback
 * mode answer exactly as before. Null for a missing `Host`.
 */
function allowlistHost(host: string | null, forwardedProto: string | null | undefined, lanHosts: ReadonlySet<string>): string | null {
    if (host === null) return null;
    const lower = host.toLowerCase();
    const hasPort = lower.startsWith('[') ? lower.includes(']:') : lower.includes(':');
    if (lower === '' || hasPort) return lower;
    const withPort = `${lower}:${firstForwardedProto(forwardedProto) === 'https' ? 443 : 80}`;
    return lanHosts.has(withPort) ? withPort : lower;
}

/** What the scheme checks read of a request: its `Host` and `X-Forwarded-Proto`, as sent, or null when missing. */
export interface CuratorTransport {
    host: string | null;
    forwardedProto: string | null;
}

/**
 * The scheme a request reached the curator on, as far as the curator can
 * tell: `https` only on a LAN-mode name whose first `X-Forwarded-Proto` is
 * `https`, as a TLS proxy in front sends it; `http` for any other first value
 * or none. Null on a loopback name, an unlisted or missing `Host`, and while
 * the settings are wrong, where the curator keeps today's rules. The header
 * is the caller's to set, and either way it only decides what that caller
 * gets back: its own cookie's `Secure`, and its own redirect's scheme.
 */
function lanScheme(request: CuratorTransport, env: CuratorEnv): 'http' | 'https' | 'other' | null {
    const allowed = curatorHosts(env);
    if ('problem' in allowed) return null;
    const host = allowlistHost(request.host, request.forwardedProto, allowed.lanHosts);
    if (host === null || !allowed.lanHosts.has(host)) return null;
    const scheme = firstForwardedProto(request.forwardedProto);
    if (scheme === '' || scheme === 'http') return 'http';
    return scheme === 'https' ? 'https' : 'other';
}

/**
 * Whether a request reached the curator on a LAN name over plain http: the
 * one case where the session cookie goes without `Secure` and the login page
 * says the page isn't encrypted. False in loopback mode, on a loopback name
 * (a tunnel), on an unlisted or missing `Host`, while the settings are
 * wrong, and for any first `X-Forwarded-Proto` but `http` (`https` from a TLS
 * proxy in front, say), all of which keep `Secure`.
 */
export function plainLanRequest(request: CuratorTransport, env: CuratorEnv): boolean {
    return lanScheme(request, env) === 'http';
}

/** The scheme the proxy's redirect to the login page uses: `https` only behind a TLS proxy on a LAN name, `http` everywhere else, as before LAN mode. */
export function redirectScheme(request: CuratorTransport, env: CuratorEnv): 'http' | 'https' {
    return lanScheme(request, env) === 'https' ? 'https' : 'http';
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
 * reads it. `next dev` hands its argument to a child process over IPC, so
 * bindProblem() checks that child by its listening socket instead.
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
 * The addresses of the TCP servers this process listens on, from Node's
 * active handles, or null when Node doesn't offer them. That's the socket
 * itself, so it holds however the address was chosen, including under
 * `next dev`, whose `--hostname` reaches its server over IPC.
 */
export function listeningAddresses(): string[] | null {
    const active = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
    if (typeof active !== 'function') return null;
    const addresses: string[] = [];
    for (const handle of active.call(process)) {
        if (!(handle instanceof net.Server) || !handle.listening) continue;
        const address = handle.address();
        if (address !== null && typeof address === 'object') addresses.push(address.address);
    }
    return addresses;
}

/** How many network interfaces have an address beyond loopback. A container on its own network has one. */
export function externalInterfaceCount(): number {
    return Object.values(os.networkInterfaces()).filter((addresses) => (addresses ?? []).some((address) => !address.internal)).length;
}

/** What the bind checks read of the process. Tests pass their own. */
export interface BindProbe {
    containerized?: () => boolean;
    sockets?: () => string[] | null;
    interfaces?: () => number;
}

/** Whether this is the child process `next dev` forks to run the server. */
const isNextDevChild = (env: CuratorEnv) => env.__NEXT_DEV_SERVER === '1' && env.NEXT_PRIVATE_WORKER === '1';

/**
 * Why a server with the curator on may not run where it listens, or null
 * when it may. The rule, also in docs/curator.md:
 *
 * - The address must be `127.0.0.1`, `::1` or `localhost`: the
 *   `--hostname` (or `-H`) argument under `next start`, `HOSTNAME` under the
 *   standalone server.js. None at all counts as non-loopback, since both
 *   then listen on every interface.
 * - Once the server listens, its sockets must be on loopback too, whatever
 *   the settings said. Under `next dev`, whose child process gets
 *   `--hostname` over IPC, the sockets are the only check, and a dev server
 *   whose sockets can't be read is refused.
 * - The one exception is the compose `curator` service. Docker's port
 *   forward reaches a container on its network interface, so inside the
 *   container the server listens on `0.0.0.0`, and the publish to the host's
 *   127.0.0.1 is the boundary. That service sets
 *   `CURATION_BIND_SCOPE=container`, which accepts a wildcard address (`0.0.0.0`
 *   or `::`) and nothing else, only where a container marker file exists, and
 *   only while the process sees a single network interface beyond loopback,
 *   as on its own Compose network. Host networking on a host with more than
 *   one active interface fails it; on a host with one, it can't tell.
 *   ci/check-compose.sh checks that the only service with it publishes on
 *   127.0.0.1 alone and shares no network with another service.
 */
export function bindProblem(env: CuratorEnv, argv: readonly string[], probe: BindProbe = {}): string | null {
    const containerized = probe.containerized ?? inContainer;
    const sockets = probe.sockets ?? listeningAddresses;
    const interfaces = probe.interfaces ?? externalInterfaceCount;
    const scope = env[BIND_SCOPE_SETTING];
    if (scope !== undefined && scope !== '' && scope !== 'container') {
        return `${BIND_SCOPE_SETTING} may only be "container"`;
    }
    const wildcardAllowed = (): string | null => {
        if (!containerized()) return `${BIND_SCOPE_SETTING}=container is set, but this process isn't in a container`;
        if (interfaces() > 1) return `${BIND_SCOPE_SETTING}=container is set, but this process sees more than one network interface, as under host networking`;
        return null;
    };
    const dev = isNextDevChild(env);
    if (!dev) {
        const { address, source } = listenTarget(env, argv);
        if (address === null) return `${source} is unset, so the server listens on every interface`;
        if (!LOOPBACK_BINDS.has(address)) {
            if (scope !== 'container' || !WILDCARD_BINDS.has(address)) return `${source} is not 127.0.0.1, ::1 or localhost`;
            const problem = wildcardAllowed();
            if (problem) return problem;
        }
    }
    const addresses = sockets();
    if (addresses === null || addresses.length === 0) {
        return dev ? "the dev server's listening address can't be read" : null;
    }
    for (const address of addresses) {
        if (LOOPBACK_SOCKETS.has(address)) continue;
        if (scope === 'container' && WILDCARD_BINDS.has(address) && wildcardAllowed() === null) continue;
        return 'the server listens on an address other than 127.0.0.1, ::1 or localhost';
    }
    return null;
}

/** Why the curator can't start, or null when it's off or may run. The message names settings, never their values. */
export function curatorStartupProblem(env: CuratorEnv, argv: readonly string[], probe?: BindProbe): string | null {
    if (!isCurationEnabled(env)) return null;
    const hosts = curatorHosts(env);
    if ('problem' in hosts) return hosts.problem;
    return bindProblem(env, argv, probe);
}

/**
 * Why the curator's secret files can't be used, or null when they can or
 * the curator is off. The server keeps running and answers 503 on every
 * path until they're fixed and it restarts; it never runs without them.
 */
export function curatorSecretsProblem(env: CuratorEnv): string | null {
    if (!isCurationEnabled(env)) return null;
    const secrets = readCuratorSecrets(env);
    return 'problem' in secrets ? secrets.problem : null;
}

/** What a curator request carries that the checks read. Header values as sent, or null when missing. */
export interface CuratorRequest {
    host: string | null;
    origin: string | null;
    forwardedHost: string | null;
    /** `X-Forwarded-Proto`, which only places a LAN Host sent with no port on 443 or 80. Missing reads as http. */
    forwardedProto?: string | null;
    /** True for anything that can change state: every method but GET and HEAD, and any server action call. */
    mutation: boolean;
    /**
     * The request's `Cookie` header, for the session check, or
     * `'not-checked'` where no session is asked: the login page and its
     * form's POST, and the public paths on the curator process. Every caller
     * has to say which.
     */
    session: { cookie: string | null } | 'not-checked';
}

/**
 * A refused curator request.
 * - 404 `off`: the flag is off, so curator paths don't exist.
 * - 503 `misconfigured`: the flag is on, but the bind, a publish or port setting (`CURATOR_PUBLISH`, `CURATOR_HOST_PORT`, `CURATOR_EXTRA_HOSTS`, `CURATOR_TUNNEL_PORT`), or a secret file is wrong.
 * - 421 `host`: the `Host` isn't one the curator answers to, as after a DNS rebinding.
 * - 403 `origin`: a mutation without an `Origin` naming the same allowed host and port, as from another site's form.
 * - 401 `session`: no live curator session: no `curator_session` cookie, one whose tag doesn't match, or one for a session that ended.
 */
export type CuratorDenial =
    | { status: 404; reason: 'off' }
    | { status: 503; reason: 'misconfigured' }
    | { status: 421; reason: 'host' }
    | { status: 403; reason: 'origin' }
    | { status: 401; reason: 'session' };

/** The schemes an `Origin` may name: `http` on every allowed Host, and `https` too on a LAN-mode name, behind a TLS proxy. */
const HTTP_ONLY: ReadonlySet<string> = new Set(['http:']);
const HTTP_OR_HTTPS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * The `host:port` of an `Origin` header naming an origin in one of
 * `schemes`, with the port always spelled out (80 for http, 443 for https
 * when the Origin has none, as a browser sends it), or null. `null`, a path,
 * credentials and any other scheme count as none. An allowed `Host` always
 * carries its port, so the two compare exactly.
 */
function originHost(origin: string, schemes: ReadonlySet<string>): string | null {
    let url: URL;
    try {
        url = new URL(origin);
    } catch {
        return null;
    }
    if (!schemes.has(url.protocol) || url.origin !== origin) return null;
    return `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
}

/**
 * Whether a curator request may go on, or why not. Checked in this order:
 * the flag; the bind, the tunnel port setting and the secret files; the
 * `Host` (and an `X-Forwarded-Host`, which must match it), a LAN one sent
 * with no port read on its scheme's default port (allowlistHost()); for a mutation,
 * an `Origin` whose host and port equal `Host`, over http, or over https too
 * on a LAN-mode name; and last, unless the caller
 * says `'not-checked'`, a live session from the `curator_session` cookie.
 * `now` is for tests.
 */
export function evaluateCuratorRequest(
    request: CuratorRequest,
    env: CuratorEnv,
    argv: readonly string[],
    probe?: BindProbe,
    now: number = Date.now(),
): CuratorDenial | null {
    if (!isCurationEnabled(env)) return { status: 404, reason: 'off' };
    const allowed = curatorHosts(env);
    if ('problem' in allowed || bindProblem(env, argv, probe) !== null) return { status: 503, reason: 'misconfigured' };
    const secrets = readCuratorSecrets(env);
    if ('problem' in secrets) return { status: 503, reason: 'misconfigured' };
    const host = allowlistHost(request.host, request.forwardedProto, allowed.lanHosts);
    if (host === null || !allowed.hosts.has(host)) return { status: 421, reason: 'host' };
    if (request.forwardedHost !== null && allowlistHost(request.forwardedHost, request.forwardedProto, allowed.lanHosts) !== host) {
        return { status: 421, reason: 'host' };
    }
    if (request.mutation) {
        // https only on a LAN name: the loopback names keep today's http-only rule in either mode.
        const schemes = allowed.lanHosts.has(host) ? HTTP_OR_HTTPS : HTTP_ONLY;
        const fromOrigin = request.origin === null ? null : originHost(request.origin, schemes);
        if (fromOrigin === null || fromOrigin !== host) return { status: 403, reason: 'origin' };
    }
    if (request.session !== 'not-checked' && sessionFromCookies(request.session.cookie, secrets.secrets.sessionKey, now) === null) {
        return { status: 401, reason: 'session' };
    }
    return null;
}

/** The login page, the one curator page that asks for no session. */
export const LOGIN_PAGE = '/curation/login';

/**
 * Where a page read without a live session goes: the login page, with
 * `?ended=1` when the request did send a `curator_session` cookie, so the
 * page can say the session ended. That tells the browser only that it sent
 * a cookie, which it already knows: not why the cookie stopped counting.
 */
export function loginRedirectPath(cookieHeader: string | null): string {
    return sessionCookieValues(cookieHeader).some((value) => value !== '') ? `${LOGIN_PAGE}?ended=1` : LOGIN_PAGE;
}

/** Where logout sends the browser, so the login page can say it worked. */
export const SIGNED_OUT_PAGE = `${LOGIN_PAGE}?signed-out=1`;
/** Where the login page's form posts. It asks for no session either, and still needs the Origin. */
export const LOGIN_HANDLER = '/api/curation/login';

/**
 * Whether a request is one of the two that skip the session check: a read
 * of the login page, or a POST of its form. Exact paths, as sent, and never
 * a server action call, so no other curator code runs without a session.
 * Any other spelling of these paths needs a session like the rest.
 */
export function isLoginRequest(pathname: string, method: string, isAction: boolean): boolean {
    if (isAction) return false;
    const upper = method.toUpperCase();
    if (pathname === LOGIN_PAGE) return upper === 'GET' || upper === 'HEAD';
    if (pathname === LOGIN_HANDLER) return upper === 'POST';
    return false;
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
