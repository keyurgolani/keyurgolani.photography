/**
 * A production server for the rows in test/prod that read pages: a copy of
 * .next/standalone, served on 127.0.0.1 with only the temp roots a test
 * names, plus the readers those rows check the HTML with. activation.test.ts
 * keeps its own copy of the start-up, since A11 edits that folder.
 *
 * Every fetch sets its user agent. In Next 16.4.2 only HTML_LIMITED_BOT_UA_RE
 * (Twitterbot here) gets blocking metadata; every other agent, Node's own
 * fetch included, gets it streamed, so a row that left the agent out would
 * test whichever one Node happens to send.
 *
 * Nothing here imports e2e/, which the image's .dockerignore leaves out.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { readAuthoredRecord } from '../../lib/catalog/working-layer';
import { writeAuthoredRecord } from '../../lib/catalog/working-layer-writer';
import { retryOnAddrInUse } from './ports';
import { REPO_ROOT } from './runTsx';

export const STANDALONE = path.join(REPO_ROOT, '.next/standalone');

/** A fixed desktop Chrome, which Next sends streaming metadata. */
export const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/** Twitterbot, the bot #173 names, which HTML_LIMITED_BOT_UA_RE sends blocking metadata. */
export const BOT_UA = 'Twitterbot/1.0';
export const USER_AGENTS = { browser: BROWSER_UA, bot: BOT_UA } as const;
export type Agent = keyof typeof USER_AGENTS;

/** What every dynamic page answers with, its 308s and 404s included. */
export const DYNAMIC_CACHE_CONTROL = 'private, no-cache, no-store, max-age=0, must-revalidate';

/** A served copy of the build, and an empty library beside it. */
export interface StandaloneCopy {
    /** The copy server.js runs from. */
    dir: string;
    /** An empty folder for PHOTOGRAPHY_LIBRARY_DIR. */
    library: string;
    /** Removes the temp folder this made, and nothing else. */
    cleanup(): void;
}

/**
 * A fresh copy of .next/standalone in a temp folder of its own, so a test can
 * serve it, and change it, without touching the build. Throws when there's
 * no build: `npm run test:prod` builds first.
 */
export function copyStandalone(name: string): StandaloneCopy {
    if (!fs.existsSync(path.join(STANDALONE, 'server.js'))) {
        throw new Error('There is no .next/standalone/server.js. Run npm run test:prod, which builds first.');
    }
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), `prod-test-${name}-`));
    const dir = path.join(parent, 'standalone');
    const library = path.join(parent, 'library');
    fs.cpSync(STANDALONE, dir, { recursive: true, verbatimSymlinks: true });
    fs.mkdirSync(library);
    return {
        dir,
        library,
        cleanup() {
            // Only the folder mkdtemp made for this copy.
            if (path.dirname(parent) !== path.resolve(os.tmpdir()) || !path.basename(parent).startsWith(`prod-test-${name}-`)) {
                throw new Error(`Refusing to remove ${parent}: copyStandalone() didn't make it.`);
            }
            fs.rmSync(parent, { recursive: true, force: true });
        },
    };
}

export interface StandaloneOptions {
    /** The copy to run, from copyStandalone(). */
    cwd: string;
    dataRoot: string;
    library: string;
    /** SITE_URL, or none. The shell's own is never passed through. */
    siteUrl?: string;
    /** Anything else the server should see. */
    env?: Record<string, string>;
}

export interface StandaloneServer {
    base: string;
    pid: number;
    process: ChildProcess;
    options: StandaloneOptions;
    /** Everything it wrote to stdout and stderr so far. */
    output(): string;
    stop(): Promise<void>;
}

/** How long a server has to answer /api/health. */
const START_MS = 60_000;

async function startOn(port: number, options: StandaloneOptions): Promise<StandaloneServer> {
    const base = `http://127.0.0.1:${port}`;
    // Only the roots and origin this test names, whatever this shell points PHOTOGRAPHY_* and SITE_URL at.
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PHOTOGRAPHY_') && name !== 'SITE_URL'));
    const child = spawn(process.execPath, ['server.js'], {
        cwd: options.cwd,
        env: {
            ...inherited,
            ...options.env,
            NODE_ENV: 'production',
            PORT: String(port),
            HOSTNAME: '127.0.0.1',
            PHOTOGRAPHY_DATA_DIR: options.dataRoot,
            PHOTOGRAPHY_LIBRARY_DIR: options.library,
            ...(options.siteUrl !== undefined && { SITE_URL: options.siteUrl }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => (output += chunk));
    child.stderr?.on('data', (chunk) => (output += chunk));
    const stop = async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit');
        child.kill();
        await exited;
    };
    const deadline = Date.now() + START_MS;
    for (;;) {
        // The output carries EADDRINUSE when the port went meanwhile, so retryOnAddrInUse() tries another.
        if (child.exitCode !== null) throw new Error(`The server exited with ${child.exitCode}:\n${output}`);
        try {
            // /api/health reads no catalog, so no route has loaded one when this returns.
            await (await fetch(`${base}/api/health`, { headers: { 'User-Agent': BROWSER_UA } })).arrayBuffer();
            break;
        } catch {
            // Not listening yet.
        }
        if (Date.now() > deadline) {
            await stop();
            throw new Error(`The server did not answer within ${START_MS / 1000} s:\n${output}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { base, pid: child.pid!, process: child, options, output: () => output, stop };
}

/** Serve `options.cwd` on a free port below the ephemeral range, and wait until it answers. */
export function startStandalone(options: StandaloneOptions): Promise<StandaloneServer> {
    return retryOnAddrInUse((port) => startOn(port, options));
}

/** Stop `server` and start the same copy on the same roots again: a new process, on a new port. */
export async function restart(server: StandaloneServer): Promise<StandaloneServer> {
    await server.stop();
    return startStandalone(server.options);
}

/** One GET's answer, with when it was sent and when its body was in, on performance.now()'s clock. */
export interface Fetched {
    status: number;
    headers: Headers;
    html: string;
    t0: number;
    t1: number;
}

/** GET `pathname` as `agent`, never following a redirect, within `timeoutMs`. */
export async function get(base: string, pathname: string, agent: Agent, { timeoutMs = 15_000 }: { timeoutMs?: number } = {}): Promise<Fetched> {
    const t0 = performance.now();
    const response = await fetch(`${base}${pathname}`, { headers: { 'User-Agent': USER_AGENTS[agent] }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const html = await response.text();
    return { status: response.status, headers: response.headers, html, t0, t1: performance.now() };
}

// ---- The HTML readers. React writes every attribute quoted; these read any quoting, and decode entities. ----

/** Everything from `<head` to `</head>`, or '' when there's no head. */
export function headOf(html: string): string {
    const start = html.search(/<head[\s>]/i);
    const end = html.search(/<\/head>/i);
    return start === -1 || end === -1 ? '' : html.slice(start, end);
}

/** Everything after `</head>`, or the whole document when there's no head. */
export function bodyOf(html: string): string {
    const end = html.search(/<\/head>/i);
    return end === -1 ? html : html.slice(end + '</head>'.length);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(value: string): string {
    return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, code: string) => {
        if (code[0] === '#') return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10));
        return ENTITIES[code.toLowerCase()] ?? entity;
    });
}

interface Tag {
    name: string;
    attributes: Record<string, string>;
}

/** `html` with every script's and style's contents taken out, so only markup is left to search. */
export function withoutScripts(html: string): string {
    return html.replace(/<(script|style)\b([^>]*)>[\s\S]*?<\/\1>/gi, '<$1$2></$1>');
}

/** Every opening tag, in order, with script and style contents skipped, so a `<` in a script opens nothing. */
function tags(html: string): Tag[] {
    const markup = withoutScripts(html);
    const found: Tag[] = [];
    for (const [, name, rest] of markup.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/g)) {
        const attributes: Record<string, string> = {};
        for (const [, key, double, single, bare] of rest.matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
            attributes[key.toLowerCase()] = decode(double ?? single ?? bare ?? '');
        }
        found.push({ name: name.toLowerCase(), attributes });
    }
    return found;
}

/** The content of every `<meta>` in `html` whose name or property is `key`, in order. */
export function meta(html: string, key: string): string[] {
    return tags(html)
        .filter((tag) => tag.name === 'meta' && (tag.attributes.name === key || tag.attributes.property === key))
        .map((tag) => tag.attributes.content ?? '');
}

/** Every `<link rel=…>` href in `html` with that rel. */
export function links(html: string, rel: string): string[] {
    return tags(html).filter((tag) => tag.name === 'link' && tag.attributes.rel === rel).map((tag) => tag.attributes.href ?? '');
}

/** The revision markers a page carries, each as often as it's there, from tags only. */
export interface Markers {
    /** `<meta name="catalog-revision">`: the series page (on next) and the Viewer (B8). */
    meta: string[];
    /** `main[data-catalog-revision]`: the series page, and Home (B6). */
    main: string[];
    /** `ul[data-catalog-revision]`: Work's list (B3). */
    list: string[];
    /** `main[data-home-state]`: Home's state (B6). */
    homeState: string[];
    /** Every distinct `rev_<64 hex>` anywhere in the text, scripts included, sorted. */
    revisions: string[];
}

export const REVISION_RE = /rev_[0-9a-f]{64}/g;

export function markers(html: string): Markers {
    const all = tags(html);
    const revisionOf = (name: string) => all.filter((tag) => tag.name === name && 'data-catalog-revision' in tag.attributes).map((tag) => tag.attributes['data-catalog-revision']);
    return {
        meta: meta(html, 'catalog-revision'),
        main: revisionOf('main'),
        list: revisionOf('ul'),
        homeState: all.filter((tag) => tag.name === 'main' && 'data-home-state' in tag.attributes).map((tag) => tag.attributes['data-home-state']),
        revisions: [...new Set(html.match(REVISION_RE) ?? [])].sort(),
    };
}

/**
 * The document's opening tags by name, leaving out `script` and `link`, whose
 * count follows the route's chunks. Two error shells match when nothing but
 * their chunks differ; a `<title>` or a hidden segment streamed into the body
 * shows.
 */
export function skeleton(html: string): string[] {
    return tags(html).map((tag) => tag.name).filter((name) => name !== 'script' && name !== 'link');
}

/**
 * Change a series' statement or short statement the way the curator does:
 * read the record, change only those fields, and write it at the version
 * read. A3's slug and accent rules never see a change.
 */
export async function editSeries(root: string, seriesId: string, change: { statement?: string; shortStatement?: string }): Promise<void> {
    const record = await readAuthoredRecord(root, 'series', seriesId);
    if (record === null) throw new Error(`There is no series ${seriesId} to edit.`);
    await writeAuthoredRecord({ ...structuredClone(record), ...change }, { expectedVersion: record.version, root });
}

// ---- C1's window rule. ----

/** When one publish wrote its pending activation (step 10) and had written its pointer (step 11). */
export interface PublishTimes {
    afterStep10: number;
    afterStep11: number;
}

/**
 * Which revisions a fetch sent at `t0` and read by `t1` may show, as indices:
 * 0 for R0, active before the burst, and k for the revision publish k
 * activated (`publishes[k - 1]`). R_k may show once its pointer write can
 * have started, after publish k's step 10 (afterStep10_k ≤ t1), until publish
 * k + 1's pointer replaced it, by its step 11 (afterStep11_{k+1} ≥ t0). R0
 * has no start and the last revision no end.
 */
export function servableRevisions(publishes: readonly PublishTimes[], t0: number, t1: number): number[] {
    const allowed: number[] = [];
    for (let k = 0; k <= publishes.length; k++) {
        const started = k === 0 || publishes[k - 1].afterStep10 <= t1;
        const notYetReplaced = k === publishes.length || publishes[k].afterStep11 >= t0;
        if (started && notYetReplaced) allowed.push(k);
    }
    return allowed;
}
